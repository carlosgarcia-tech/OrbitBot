/**
 * MediaFileCache.ts
 *
 * Disk cache for downloaded media, keyed by a caller-defined id (a video id,
 * usually). Entries expire by TTL from the moment they were stored, and the
 * oldest files are evicted when the directory outgrows its size budget.
 *
 * The bytes live on disk, never in the in-memory SQLite: a single cached video
 * would otherwise be exported and written on every autosave.
 *
 * @author **Carlos G**
 * @created 2026-11-27
 */

import fs from 'fs';
import path from 'path';
import { logError } from '@/utils/logger.js';

/** Keys become filenames; anything else could escape the cache directory. */
const SAFE_KEY = /^[\w.-]{1,120}$/;

/** Options accepted by {@link MediaFileCache}. */
export interface MediaFileCacheOptions {
  /** Directory the cache stores into; created on first store. */
  dir: string;
  /** How long an entry stays valid, in ms. */
  ttlMs?: number;
  /** Total size budget; oldest entries are evicted beyond it. */
  maxTotalBytes?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export class MediaFileCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;

  /**
   * @param options Directory, TTL, size budget and clock.
   */
  constructor(options: MediaFileCacheOptions) {
    this.dir = options.dir;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.maxTotalBytes = options.maxTotalBytes ?? 500 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  /** Directory the cache stores into (also used to identify cached files). */
  get directory(): string {
    return this.dir;
  }

  /**
   * Cached file path for `key`, or null on a miss, an expired entry or an
   * invalid key.
   */
  get(key: string): string | null {
    try {
      const file = this.pathFor(key);
      const stats = fs.statSync(file);
      if (this.now() - stats.mtimeMs > this.ttlMs) return null;
      return file;
    } catch {
      return null;
    }
  }

  /**
   * Moves a freshly downloaded file into the cache. The source path stops
   * existing; use {@link storeCopy} when the caller still needs it.
   *
   * Best-effort: a failed store is logged and leaves the download usable.
   */
  store(key: string, sourcePath: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = this.pathFor(key);
      this.moveInto(sourcePath, target);
      this.finish(target);
    } catch (error) {
      logError('MediaFileCache.store', error);
    }
  }

  /**
   * Copies a file into the cache, leaving the source untouched.
   *
   * Used when the caller must keep serving the original path (the download
   * commands delete their temp file after sending).
   */
  storeCopy(key: string, sourcePath: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = this.pathFor(key);
      fs.copyFileSync(sourcePath, target);
      this.finish(target);
    } catch (error) {
      logError('MediaFileCache.storeCopy', error);
    }
  }

  /**
   * Absolute path for a key.
   *
   * @throws When the key is not a plain filename, so no caller can write
   * outside the cache directory.
   */
  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) {
      throw new Error(`Invalid cache key: ${key}`);
    }
    return path.join(this.dir, key);
  }

  /** Renames into place, falling back to copy+unlink across filesystems. */
  private moveInto(sourcePath: string, target: string): void {
    try {
      fs.renameSync(sourcePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      fs.copyFileSync(sourcePath, target);
      fs.unlinkSync(sourcePath);
    }
  }

  /** Stamps the entry with the current time and enforces the size budget. */
  private finish(target: string): void {
    // Touch mtime to now: the TTL counts from the moment it was cached.
    const nowMs = this.now();
    fs.utimesSync(target, nowMs / 1000, nowMs / 1000);
    this.evictIfNeeded(target);
  }

  /** Deletes the oldest entries until the directory fits its budget. */
  private evictIfNeeded(protectedPath: string): void {
    const files = this.listFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxTotalBytes) return;

    const deletable = files
      .filter(file => file.path !== protectedPath)
      .sort((a, b) => a.mtime - b.mtime);

    for (const entry of deletable) {
      if (total <= this.maxTotalBytes) break;
      try {
        fs.unlinkSync(entry.path);
        total -= entry.size;
      } catch {
        // Already gone: keep evicting.
      }
    }
  }

  /** Cache entries with size and mtime; unreadable entries are skipped. */
  private listFiles(): Array<{ path: string; size: number; mtime: number }> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: Array<{ path: string; size: number; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(this.dir, entry.name);
      try {
        const stats = fs.statSync(file);
        files.push({ path: file, size: stats.size, mtime: stats.mtimeMs });
      } catch {
        // Deleted between readdir and stat.
      }
    }
    return files;
  }
}
