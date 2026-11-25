/**
 * StickerService.ts
 *
 * OrbitBot services module exposing `StickerService`, `StickerOptions`.
 *
 * `createSticker` / `imageToSticker` / `videoToSticker` produce the plain
 * webp: static images are scaled to 512px, videos to 320px through a
 * palette. Pack metadata is added afterwards by `addExif`.
 *
 * @author **Carlos G**
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { logError, logger } from '@/utils/logger.js';

export interface AudioStickerOptions {
  /** Image or video that will be the sticker. */
  visual: Buffer;
  /** Optional audio; when missing the video's own track is used. */
  audio?: Buffer;
  maxSeconds?: number;
}

export interface AudioStickerParts {
  /** Animated or static webp sticker. */
  sticker: Buffer;
  /** Mono 16 kHz ogg/opus track. */
  audio: Buffer;
  /** Rounded-up audio duration, shown by WhatsApp. */
  seconds: number;
  /** 64-bar waveform for the audio message. */
  waveform: Buffer;
  width: number;
  height: number;
  isAnimated: boolean;
}

interface FileTypeResult {
  ext: string;
  mime: string;
}
interface FileTypeModule {
  fileTypeFromBuffer?: (buffer: Buffer) => Promise<FileTypeResult | undefined>;
  fromBuffer?: (buffer: Buffer) => Promise<FileTypeResult | undefined>;
  default?: {
    fromBuffer?: (buffer: Buffer) => Promise<FileTypeResult | undefined>;
    fileTypeFromBuffer?: (buffer: Buffer) => Promise<FileTypeResult | undefined>;
  };
}

export class StickerService {
  private static readonly TEMP_DIR = './data/temp';
  private static readonly STICKER_SIZE = 512;
  /** WhatsApp rejects animated stickers above ~500KB. */
  private static readonly MAX_VIDEO_STICKER_BYTES = 450 * 1024;
  /**
   * The native editor caps sound at 10s (5s for animated), but the wire
   * format accepts longer: the reference implementation played 24s on a
   * phone. Visuals are capped lower than audio: encoding a full minute two
   * or three times made the command slow enough to miss sends.
   */
  private static readonly AUDIO_STICKER_MAX_SECONDS = 30;
  /** Longest visual attempted; WhatsApp loops it while the audio keeps playing. */
  private static readonly AUDIO_STICKER_VISUAL_MAX_SECONDS = 20;
  private static readonly AUDIO_STICKER_MAX_BYTES = 1024 * 1024;

  constructor() {
    if (!existsSync(StickerService.TEMP_DIR)) {
      mkdirSync(StickerService.TEMP_DIR, { recursive: true });
    }
  }

  private async getFileType(buffer: Buffer): Promise<{ mime: string; ext: string } | null> {
    try {
      const fileType = (await import('file-type')) as FileTypeModule;
      let result: FileTypeResult | undefined;
      if (fileType.fileTypeFromBuffer) result = await fileType.fileTypeFromBuffer(buffer);
      else if (fileType.fromBuffer) result = await fileType.fromBuffer(buffer);
      else if (fileType.default?.fromBuffer) result = await fileType.default.fromBuffer(buffer);
      else if (fileType.default?.fileTypeFromBuffer)
        result = await fileType.default.fileTypeFromBuffer(buffer);
      else return { mime: 'image/jpeg', ext: 'jpg' };
      return result || { mime: 'image/jpeg', ext: 'jpg' };
    } catch {
      return { mime: 'image/jpeg', ext: 'jpg' };
    }
  }

  async createSticker(buffer: Buffer): Promise<Buffer> {
    const type = await this.getFileType(buffer);
    const isVideo = type?.mime.includes('video') || type?.ext === 'gif';
    if (isVideo) return await this.videoToSticker(buffer);
    return await this.imageToSticker(buffer);
  }

  /**
   * Builds the two halves of an audio sticker: webp visual + ogg/opus audio.
   *
   * The track comes from `opts.audio` when supplied, otherwise from the
   * video itself. A silent source throws `NO_AUDIO` so the command can tell
   * the user what is missing instead of sending a sticker with no sound.
   */
  async createAudioSticker(opts: AudioStickerOptions): Promise<AudioStickerParts> {
    const maxSeconds = opts.maxSeconds ?? StickerService.AUDIO_STICKER_MAX_SECONDS;
    const type = await this.getFileType(opts.visual);
    const isVideo = type?.mime.includes('video') || type?.ext === 'gif';

    const id = randomUUID();
    const src = join(StickerService.TEMP_DIR, `as-src-${id}.bin`);
    const out = join(StickerService.TEMP_DIR, `as-out-${id}.ogg`);

    try {
      if (opts.audio) writeFileSync(src, opts.audio);
      else if (isVideo) writeFileSync(src, opts.visual);
      else throw new Error('NO_AUDIO');

      if (!(await this.hasAudioTrack(src))) throw new Error('NO_AUDIO');
      await this.ffmpegOpusProcess(src, out, maxSeconds);
      const audio = readFileSync(out);
      const { seconds, waveform } = await this.readAudioExtras(out, maxSeconds);

      const sticker = isVideo
        ? await this.videoToSticker(
            opts.visual,
            Math.min(seconds, StickerService.AUDIO_STICKER_VISUAL_MAX_SECONDS),
            StickerService.AUDIO_STICKER_MAX_BYTES - audio.length,
          )
        : await this.imageToSticker(opts.visual);
      const isAnimated = sticker.includes('ANIM');

      if (sticker.length + audio.length > StickerService.AUDIO_STICKER_MAX_BYTES) {
        throw new Error('AUDIO_STICKER_TOO_BIG');
      }
      return {
        sticker,
        audio,
        seconds,
        waveform,
        width: isAnimated ? 320 : 512,
        height: isAnimated ? 320 : 512,
        isAnimated,
      };
    } finally {
      this.cleanup(src, out);
    }
  }

  /** Duration + 64-bar waveform WhatsApp draws for the attached clip. */
  private async readAudioExtras(
    path: string,
    maxSeconds: number,
  ): Promise<{ seconds: number; waveform: Buffer }> {
    const [duration, pcm] = await Promise.all([this.probeDuration(path), this.readPcm(path)]);
    const seconds = duration > 0 ? Math.min(Math.ceil(duration), Math.ceil(maxSeconds)) : 5;
    return { seconds, waveform: StickerService.waveformFromPcm(pcm) };
  }

  private probeDuration(path: string): Promise<number> {
    return new Promise(resolve => {
      const probe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        path,
      ]);
      let output = '';
      probe.stdout.on('data', data => {
        output += data.toString();
      });
      probe.on('close', () => resolve(Number.parseFloat(output.trim()) || 0));
      probe.on('error', () => resolve(0));
    });
  }

  /** Raw 8 kHz mono PCM, used only to build the waveform bars. */
  private readPcm(path: string): Promise<Buffer> {
    return new Promise(resolve => {
      const ffmpeg = spawn('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ]);
      const chunks: Buffer[] = [];
      ffmpeg.stdout.on('data', data => chunks.push(data as Buffer));
      ffmpeg.on('close', code => resolve(code === 0 ? Buffer.concat(chunks) : Buffer.alloc(0)));
      ffmpeg.on('error', () => resolve(Buffer.alloc(0)));
    });
  }

  /** Normalises PCM samples to the 0–100 bars WhatsApp expects. */
  private static waveformFromPcm(pcm: Buffer, bars = 64): Buffer {
    const samples = Math.floor(pcm.length / 2);
    if (samples < bars) return Buffer.alloc(bars, 10);

    const block = Math.floor(samples / bars);
    const raw: number[] = [];
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < block; j++) sum += Math.abs(pcm.readInt16LE((i * block + j) * 2));
      raw.push(sum / block);
    }

    const scale = Math.max(...raw) > 0 ? 100 / Math.max(...raw) : 1;
    return Buffer.from(raw.map(value => Math.min(100, Math.floor(value * scale))));
  }

  /** True when the file has at least one audio stream. */
  private hasAudioTrack(path: string): Promise<boolean> {
    return new Promise(resolve => {
      const probe = spawn('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'csv=p=0',
        path,
      ]);
      let output = '';
      probe.stdout.on('data', data => {
        output += data.toString();
      });
      probe.on('close', code => resolve(code === 0 && output.trim() === 'audio'));
      probe.on('error', () => resolve(false));
    });
  }

  /** Re-encodes any audio input to mono 48 kHz opus in an ogg container. */
  private ffmpegOpusProcess(input: string, output: string, seconds: number): Promise<void> {
    const args = [
      '-y',
      '-i',
      input,
      '-vn',
      '-t',
      String(seconds),
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-compression_level',
      '10',
      '-frame_duration',
      '20',
      '-application',
      'voip',
      '-avoid_negative_ts',
      'make_zero',
      '-map_metadata',
      '-1',
      '-f',
      'ogg',
      output,
    ];
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      ffmpeg.stderr.on('data', data => {
        stderr += data.toString();
      });
      ffmpeg.on('close', code => {
        code === 0 ? resolve() : reject(new Error(`FFmpeg audio failed: ${stderr}`));
      });
      ffmpeg.on('error', reject);
    });
  }

  async addExif(buffer: Buffer, pack: string, author: string): Promise<Buffer> {
    return await this.addExifManual(buffer, pack, author);
  }

  private async addExifManual(buffer: Buffer, pack: string, author: string): Promise<Buffer> {
    try {
      const webp = await import('node-webpmux');
      const Image = webp.default?.Image ?? webp.Image;
      const img = new Image();

      const packJson = JSON.stringify({
        'sticker-pack-name': pack,
        'sticker-pack-publisher': author,
        emojis: [''],
      });

      const jsonBuffer = Buffer.from(packJson, 'utf8');

      const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
      ]);

      const exif = Buffer.concat([exifAttr, jsonBuffer]);
      exif.writeUIntLE(jsonBuffer.length, 14, 4);

      await img.load(buffer);
      img.exif = exif;
      return await img.save(null);
    } catch (e) {
      logError('[StickerService] addExifManual error', e);
      return buffer;
    }
  }

  async imageToSticker(buffer: Buffer): Promise<Buffer> {
    const tempInput = join(StickerService.TEMP_DIR, `input-${Date.now()}.png`);
    const tempOutput = join(StickerService.TEMP_DIR, `output-${Date.now()}.webp`);
    try {
      writeFileSync(tempInput, buffer);
      await this.ffmpegImageProcess(tempInput, tempOutput);
      const resultBuffer = readFileSync(tempOutput);
      this.cleanup(tempInput, tempOutput);
      return resultBuffer;
    } catch {
      this.cleanup(tempInput, tempOutput);
      logger.warn('[StickerService] FFmpeg falló, usando jimp fallback');
      return await this.imageToStickerJimp(buffer);
    }
  }

  private ffmpegImageProcess(input: string, output: string): Promise<void> {
    // Cover, not contain: fill the square and crop the overflow, so the
    // subject is not shrunk into transparent side/top padding.
    const filter =
      'scale=512:512:flags=lanczos:force_original_aspect_ratio=increase,' +
      'crop=512:512,format=rgba,setsar=1';

    const args = ['-y', '-i', input, '-vf', filter, '-f', 'webp', '-quality', '100', output];

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      ffmpeg.stderr.on('data', data => {
        stderr += data.toString();
      });
      ffmpeg.on('close', code => {
        code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${stderr}`));
      });
      ffmpeg.on('error', reject);
    });
  }

  private async imageToStickerJimp(buffer: Buffer): Promise<Buffer> {
    const { Jimp } = await import('jimp');
    const image = await Jimp.read(buffer);
    image.cover({ w: StickerService.STICKER_SIZE, h: StickerService.STICKER_SIZE });

    const tempInput = join(StickerService.TEMP_DIR, `jimp-${Date.now()}.png`);
    const tempOutput = join(StickerService.TEMP_DIR, `jimp-${Date.now()}.webp`);

    try {
      const pngBuffer = await image.getBuffer('image/png');
      writeFileSync(tempInput, pngBuffer);
      await this.ffmpegImageProcess(tempInput, tempOutput);
      const result = readFileSync(tempOutput);
      this.cleanup(tempInput, tempOutput);
      return result;
    } catch {
      this.cleanup(tempInput, tempOutput);
      return await image.getBuffer('image/png');
    }
  }

  /**
   * Encodes a video sticker. `seconds` is the most it may run; `maxBytes` the
   * size budget. A short probe estimates the size, so the clip gets encoded
   * once or twice instead of at every quality rung, and only gets shortened
   * when even the lowest quality does not fit.
   */
  async videoToSticker(
    buffer: Buffer,
    seconds = 10,
    maxBytes = StickerService.MAX_VIDEO_STICKER_BYTES,
  ): Promise<Buffer> {
    const type = await this.getFileType(buffer);
    const tempInput = join(StickerService.TEMP_DIR, `video-${Date.now()}.${type?.ext || 'mp4'}`);
    const outputs: string[] = [];
    const encode = async (fps: number, quality: number, length: number): Promise<Buffer> => {
      const output = join(StickerService.TEMP_DIR, `sticker-${Date.now()}-${outputs.length}.webp`);
      outputs.push(output);
      await this.ffmpegVideoProcess(tempInput, output, fps, quality, length);
      return readFileSync(output);
    };

    try {
      writeFileSync(tempInput, buffer);

      // Encoding the whole clip at each rung made detailed videos take over a
      // minute. A 2s probe predicts the full size close enough to pick one.
      const probeSeconds = Math.min(2, seconds);
      const probe = await encode(15, 70, probeSeconds);
      const rate = probe.length / probeSeconds;

      // q45 is ~0.65 of q70 and q20 ~0.38 on detailed footage; when even that
      // does not fit, shorten the clip instead of spending another pass.
      let fps = 15;
      let quality = 70;
      let length = seconds;
      if (rate * seconds > maxBytes) {
        if (rate * 0.65 * seconds <= maxBytes) {
          quality = 45;
        } else if (rate * 0.38 * seconds <= maxBytes) {
          fps = 12;
          quality = 25;
        } else {
          fps = 12;
          quality = 20;
          length = Math.min(seconds, Math.max(2, Math.floor((maxBytes / (rate * 0.38)) * 0.9)));
        }
      }

      let result =
        length === probeSeconds && fps === 15 && quality === 70
          ? probe
          : await encode(fps, quality, length);

      // Still over budget: shorten at the cheapest setting and re-measure,
      // because encoded size does not scale linearly with duration.
      for (let attempt = 0; attempt < 2 && result.length > maxBytes; attempt++) {
        const ratio = Math.min(0.85, (maxBytes / result.length) * 0.9);
        const fitted = Math.max(2, Math.floor(length * ratio));
        if (fitted >= length) break;
        length = fitted;
        result = await encode(12, 20, length);
      }
      return result;
    } finally {
      this.cleanup(tempInput, ...outputs);
    }
  }

  private ffmpegVideoProcess(
    input: string,
    output: string,
    fps = 15,
    qscale = 75,
    seconds = 10,
  ): Promise<void> {
    // Cover the whole square; a contain fit used to leave transparent bars.
    const filter =
      `scale=320:320:force_original_aspect_ratio=increase,crop=320:320,fps=${fps}` +
      ',split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse';

    // Input-side cut: palettegen otherwise swallows the WHOLE video
    // building its palette, so long videos blew the command timeout.
    const inputs = ['-t', String(seconds), '-i', input];

    const args = [
      '-y',
      ...inputs,
      '-vf',
      filter,
      '-vcodec',
      'libwebp',
      '-lossless',
      '0',
      '-qscale',
      String(qscale),
      '-preset',
      'default',
      '-loop',
      '0',
      '-an',
      '-vsync',
      '0',
      '-t',
      String(seconds),
      output,
    ];

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      ffmpeg.stderr.on('data', data => {
        stderr += data.toString();
      });
      ffmpeg.on('close', code => {
        code === 0 ? resolve() : reject(new Error(`FFmpeg video failed: ${stderr}`));
      });
      ffmpeg.on('error', reject);
    });
  }

  private cleanup(...files: string[]): void {
    files.forEach(file => {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch (error) {
        logger.debug(`[StickerService] No se pudo eliminar el temporal ${file}:`, error);
      }
    });
  }

  async checkFFmpeg(): Promise<boolean> {
    return new Promise(resolve => {
      const ffmpeg = spawn('ffmpeg', ['-version']);
      ffmpeg.on('close', code => resolve(code === 0));
      ffmpeg.on('error', error => {
        // checkFFmpeg returns false by design, but the reason (missing binary,
        // lack of permissions) used to be completely invisible.
        logger.debug(`[StickerService] ffmpeg probe failed: ${error.message}`);
        resolve(false);
      });
    });
  }
}
