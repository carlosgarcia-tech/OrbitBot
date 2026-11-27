/**
 * DownloadService.ts
 *
 * OrbitBot services module exposing `DownloadService`.
 *
 * @author **Carlos G**
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Either } from '@/utils/either.js';
import { left, right } from '@/utils/either.js';
import {
  VBotError,
  ErrorCode,
  ValidationError,
  NetworkError,
  InvalidURLError,
} from '@/utils/errors.js';
import { logError, logger } from '@/utils/logger.js';
import { Semaphore } from '@/utils/Semaphore.js';

/** A download attempt must not keep more than this much stderr in memory. */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * At most two external processes run at once across every downloader. More
 * saturates a basic VPS or a phone running Termux, and the queue is FIFO so
 * no request is starved.
 */
const processSlots = new Semaphore(2);

/** Keeps only the tail of a log: yt-dlp writes the real error last. */
function keepTail(value: string, maxBytes: number): string {
  return value.length > maxBytes ? value.slice(-maxBytes) : value;
}

export type DownloadSuccess = {
  filePath: string;
  size: string;
  source: string;
};

export type DownloadError = ValidationError | NetworkError | VBotError;

export type DownloadResult = Either<DownloadError, DownloadSuccess>;

const BLOCKED_URL_PATTERNS = [
  // `&` is left out: it is the normal query separator in share links (TikTok,
  // YouTube) and every downloader spawns yt-dlp without a shell.
  /[;|`$<>{}]/,
  /localhost/i,
  /127\.\d+\.\d+\.\d+/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /192\.168\.\d+\.\d+/,
  /0\.0\.0\.0/,
  /::1/,
  /fc00:/i,
  /fe80:/i,
];

export class DownloadService {
  private static readonly TEMP_DIR = './data/temp/downloads';
  private static readonly MAX_AUDIO_SIZE_MB = 50;
  private static readonly MAX_VIDEO_SIZE_MB = 100;

  constructor() {
    if (!fs.existsSync(DownloadService.TEMP_DIR)) {
      fs.mkdirSync(DownloadService.TEMP_DIR, { recursive: true });
    }
  }

  protected getDownloadPrefix(): string {
    return '';
  }

  protected resolveOutputPath?(expectedPath: string): string | null;

  protected DOWNLOAD_PREVIEW_ENABLED = true;
  protected DEFAULT_QUALITY = '720';

  getQualityFromArgs(args: string[]): { quality: string; remainingArgs: string[] } {
    const validQualities: string[] = ['360', '480', '720', '1080'];
    const remainingArgs = [...args];
    let quality = this.DEFAULT_QUALITY;

    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      if (arg && validQualities.includes(arg)) {
        quality = arg;
        remainingArgs.splice(i, 1);
        break;
      }
    }

    return { quality, remainingArgs };
  }

  protected validateUrl(url: string): Either<ValidationError, string> {
    if (!url || url.trim().length === 0) {
      return left(new ValidationError('URL está vacía'));
    }

    if (url.length > 2048) {
      return left(new ValidationError('URL muy larga (máx 2048 caracteres)'));
    }

    // yt-dlp search queries (ytsearch1:…) are not parseable URLs but are
    // legitimate media args; everything else must still be a real URL.
    const isYtDlpQuery = /^ytsearch\d*:/.test(url);
    let hostname = '';
    if (!isYtDlpQuery) {
      try {
        const parsed = new URL(url);

        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return left(new ValidationError('Solo URLs HTTP/HTTPS permitidas'));
        }
        hostname = parsed.hostname.toLowerCase();
      } catch {
        return left(new InvalidURLError(url, 'formato inválido'));
      }
    }

    // Option-like strings would be forwarded to yt-dlp as CLI flags.
    if (url.trim().startsWith('-')) {
      return left(new ValidationError('URL inválida'));
    }

    for (const pattern of BLOCKED_URL_PATTERNS) {
      if (pattern.test(url)) {
        return left(new ValidationError('URL contiene patrones bloqueados'));
      }
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return left(new ValidationError('URLs localhost no permitidas'));
    }

    return right(url);
  }

  /**
   * Runs an external command with a timeout, at most two at a time globally.
   *
   * The slot is acquired before spawning, so a queued command's timeout only
   * starts counting once its process exists.
   *
   * @param cmd Executable to run (never through a shell).
   * @param args Arguments, passed as-is.
   * @param timeout Kill the process after this many ms.
   * @returns The process' stdout, which callers may parse as JSON.
   */
  protected runCommand(cmd: string, args: string[], timeout: number = 90000): Promise<string> {
    return processSlots.run(() => this.spawnCommand(cmd, args, timeout));
  }

  /**
   * Spawns and collects one process.
   *
   * stdout is kept whole because metadata calls parse it as JSON; stderr is
   * capped at its tail, which is all an error message needs.
   */
  private spawnCommand(cmd: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args);
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Command timeout'));
      }, timeout);

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr = keepTail(stderr + data.toString(), MAX_STDERR_BYTES);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Exit code: ${code}`));
        }
      });

      child.on('error', reject);
    });
  }

  protected checkFileSize(
    filePath: string,
    type: 'audio' | 'video',
  ): Either<ValidationError, { sizeMB: number }> {
    const stats = fs.statSync(filePath);
    const sizeMB = stats.size / (1024 * 1024);
    const maxSize =
      type === 'audio' ? DownloadService.MAX_AUDIO_SIZE_MB : DownloadService.MAX_VIDEO_SIZE_MB;

    if (sizeMB > maxSize) {
      return left(
        new ValidationError(`Archivo muy grande: ${sizeMB.toFixed(1)}MB (máx: ${maxSize}MB)`),
      );
    }

    return right({ sizeMB: parseFloat(sizeMB.toFixed(2)) });
  }

  protected sanitizeFilename(filename: string, maxLength: number = 60): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, maxLength);
  }

  /**
   * Schedules deletion of a temp file. Public: download commands call this
   * after sending the file to the chat.
   */
  async cleanup(filePath: string, delay: number = 30000): Promise<void> {
    setTimeout(() => {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          logger.debug(`🗑️ Cleaned up: ${path.basename(filePath)}`);
        } catch (error) {
          logError('DownloadService cleanup', error);
        }
      }
    }, delay);
  }

  protected getTempDir(): string {
    return DownloadService.TEMP_DIR;
  }

  protected generateOutputPath(filename: string, extension: string): string {
    const sanitized = this.sanitizeFilename(filename);
    return path.join(this.getTempDir(), `${sanitized}_${Date.now()}.${extension}`);
  }

  protected async tryDownloadMethods(
    methods: Array<{ name: string; cmd: string; args: string[] }>,
    outputPath: string,
    type: 'audio' | 'video',
  ): Promise<DownloadResult> {
    const prefix = this.getDownloadPrefix();
    const tag = prefix ? `[${prefix}]` : '';
    let lastError: VBotError | undefined;

    for (const method of methods) {
      try {
        logger.debug(`${tag} Trying ${method.name}...`);

        // 10 min: a slow home uplink can legitimately need >3 min for a
        // single audio/video file. The pipeline soft deadline already frees
        // the command queue, so waiting costs nothing.
        await this.runCommand(method.cmd, method.args, 600000);

        let resolvedPath = outputPath;
        if (this.resolveOutputPath) {
          resolvedPath = this.resolveOutputPath(outputPath) ?? outputPath;
        }

        if (fs.existsSync(resolvedPath)) {
          const sizeCheck = this.checkFileSize(resolvedPath, type);

          if (sizeCheck._tag === 'Left') {
            fs.unlinkSync(resolvedPath);
            return left(sizeCheck.left);
          }

          logger.debug(`${tag} ${method.name} succeeded: ${sizeCheck.right.sizeMB}MB`);

          return right({
            filePath: resolvedPath,
            size: sizeCheck.right.sizeMB.toString(),
            source: method.name,
          });
        }
      } catch (error) {
        const err = error as Error;
        lastError = new NetworkError(err.message, { method: method.name });
        logger.debug(`${tag} ${method.name} failed: ${err.message}`);
        continue;
      }
    }

    return left(
      lastError ||
        new VBotError(
          'Descarga fallida. Verifica que yt-dlp y ffmpeg estén instalados.',
          ErrorCode.NETWORK_ERROR,
          true,
          { methods: methods.map(m => m.name) },
        ),
    );
  }
}
