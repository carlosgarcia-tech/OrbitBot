/**
 * MediaFileCache.test.ts
 *
 * Disk cache contract: miss/hit, TTL, external deletion, cross-device move,
 * oldest-first eviction, copy-in that keeps the source, and keys that cannot
 * escape the cache directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MediaFileCache } from '@/services/download/MediaFileCache.js';

describe('MediaFileCache', () => {
  let tmpDir: string;
  let cacheDir: string;
  let sourceDir: string;
  let clock: number;

  const writeSource = (name: string, content = 'x'.repeat(100)): string => {
    const p = path.join(sourceDir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-'));
    cacheDir = path.join(tmpDir, 'cache');
    sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    clock = Date.now();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('misses when empty', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    expect(cache.get('111')).toBeNull();
  });

  it('hits after storing, returning an existing file path', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    const source = writeSource('video.mp4');
    cache.store('111', source);
    const cached = cache.get('111');
    expect(cached).not.toBeNull();
    expect(fs.existsSync(cached as string)).toBe(true);
    expect(fs.statSync(cached as string).size).toBe(100);
  });

  it('misses once the TTL elapses (injectable clock)', () => {
    let now = Date.now();
    const cache = new MediaFileCache({ dir: cacheDir, ttlMs: 60000, now: () => now });
    cache.store('111', writeSource('video.mp4'));
    now += 61000;
    expect(cache.get('111')).toBeNull();
  });

  it('misses when the cached file was deleted externally', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    cache.store('111', writeSource('video.mp4'));
    fs.rmSync(cacheDir, { recursive: true, force: true });
    expect(cache.get('111')).toBeNull();
  });

  it('falls back to copy+unlink when rename fails across devices (EXDEV)', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    const source = writeSource('cross-device.mp4', 'payload');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });
    cache.store('444', source);
    const cached = cache.get('444');
    expect(cached).not.toBeNull();
    expect(fs.readFileSync(cached as string, 'utf-8')).toBe('payload');
    expect(fs.existsSync(source)).toBe(false); // original cleaned up
  });

  it('evicts the oldest entries when the total size limit is exceeded', () => {
    const cache = new MediaFileCache({ dir: cacheDir, maxTotalBytes: 250, now: () => clock });
    cache.store('111', writeSource('a.mp4', 'a'.repeat(100)));
    cache.store('222', writeSource('b.mp4', 'b'.repeat(100)));
    cache.store('333', writeSource('c.mp4', 'c'.repeat(100)));
    expect(cache.get('111')).toBeNull(); // oldest, evicted
    expect(cache.get('222')).not.toBeNull();
    expect(cache.get('333')).not.toBeNull();
  });

  it('storeCopy leaves the source file in place', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    const source = writeSource('download.mp3', 'audio-bytes');
    cache.storeCopy('abc.audio.mp3', source);

    const cached = cache.get('abc.audio.mp3');
    expect(cached).not.toBeNull();
    expect(fs.readFileSync(cached as string, 'utf-8')).toBe('audio-bytes');
    expect(fs.existsSync(source)).toBe(true);
  });

  it('refuses keys that could escape the cache directory', () => {
    const cache = new MediaFileCache({ dir: cacheDir, now: () => clock });
    const source = writeSource('evil.mp4');

    expect(cache.get('../escape')).toBeNull();
    cache.store('../escape', source);

    expect(fs.existsSync(path.join(tmpDir, 'escape'))).toBe(false);
  });
});
