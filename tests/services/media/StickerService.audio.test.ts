/**
 * StickerService.audio.test.ts
 *
 * Real ffmpeg round-trips for `createAudioSticker`: the parts must be a valid
 * webp sticker plus ogg/opus mono 48 kHz audio, cut to the configured limit,
 * under WhatsApp's 1 MB ceiling, and never leave `as-*` temp files behind.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { StickerService } from '@/services/media/StickerService.js';

const TEMP_DIR = './data/temp';

let dir: string;
let withAudio: Buffer;
let longVideo: Buffer;
let heavyVideo: Buffer;
let silent: Buffer;
let image: Buffer;
let shortAudio: Buffer;
let longAudio: Buffer;
let mp3Audio: Buffer;

/** Runs ffmpeg and throws with stderr when it fails. */
function ff(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

/** Duration in seconds as reported by ffprobe. */
function duration(file: string): number {
  const result = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(result.stdout.toString().trim());
}

/** Total animation duration in seconds, from the webp frame delays. */
async function stickerSeconds(webp: Buffer): Promise<number> {
  const { delay = [] } = await sharp(webp).metadata();
  return delay.reduce((total, ms) => total + ms, 0) / 1000;
}

function audioStream(file: string): string {
  const result = spawnSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,channels,sample_rate',
    '-of',
    'csv=p=0',
    file,
  ]);
  return result.stdout.toString().trim();
}

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  );
}

function audioTempFiles(): string[] {
  return readdirSync(TEMP_DIR).filter(
    name => name.startsWith('as-src-') || name.startsWith('as-out-'),
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'audio-sticker-'));
  const withAudioPath = join(dir, 'with-audio.mp4');
  const longVideoPath = join(dir, 'long-video.mp4');
  const heavyVideoPath = join(dir, 'heavy-video.mp4');
  const silentPath = join(dir, 'silent.mp4');
  const imagePath = join(dir, 'image.png');
  const shortPath = join(dir, 'short.ogg');
  const longPath = join(dir, 'long.ogg');
  const mp3Path = join(dir, 'audio.mp3');

  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=160x160:rate=12',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    withAudioPath,
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=25:size=160x160:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=25',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    longVideoPath,
  ]);
  // Heavy short clip: strong detail over the whole frame, so even the lowest
  // quality pass is over budget and the clip must be shortened.
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=9:size=640x360:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=9',
    '-vf',
    'noise=alls=80:allf=t',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-shortest',
    heavyVideoPath,
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=160x160:rate=12',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    silentPath,
  ]);
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=256x256', '-frames:v', '1', imagePath]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libopus', shortPath]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=65', '-c:a', 'libopus', longPath]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'libmp3lame', mp3Path]);

  withAudio = readFileSync(withAudioPath);
  longVideo = readFileSync(longVideoPath);
  heavyVideo = readFileSync(heavyVideoPath);
  silent = readFileSync(silentPath);
  image = readFileSync(imagePath);
  shortAudio = readFileSync(shortPath);
  longAudio = readFileSync(longPath);
  mp3Audio = readFileSync(mp3Path);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StickerService.createAudioSticker', () => {
  const service = new StickerService();

  it('builds an animated webp and ogg/opus audio from a video with sound', async () => {
    const parts = await service.createAudioSticker({ visual: withAudio });

    expect(isWebp(parts.sticker)).toBe(true);
    expect(parts.sticker.includes('ANIM')).toBe(true);
    expect(parts.audio.subarray(0, 4).toString()).toBe('OggS');
    expect(parts.isAnimated).toBe(true);
    expect(parts.width).toBe(320);
    expect(parts.height).toBe(320);

    const audioPath = join(dir, 'probe-1.ogg');
    writeFileSync(audioPath, parts.audio);
    // Opus always decodes at 48 kHz even when the input is resampled to 16 kHz.
    expect(audioStream(audioPath)).toBe('opus,48000,1');
    expect(duration(audioPath)).toBeGreaterThan(1.5);
    expect(parts.seconds).toBeGreaterThanOrEqual(1);
    expect(parts.waveform).toHaveLength(64);
  }, 30_000);

  it('keeps more than 15s of visual for a long clip', async () => {
    const parts = await service.createAudioSticker({ visual: longVideo });

    expect(parts.isAnimated).toBe(true);
    expect(await stickerSeconds(parts.sticker)).toBeGreaterThan(15);
  }, 60_000);

  it('fits a heavy 9s video instead of failing', async () => {
    const parts = await service.createAudioSticker({ visual: heavyVideo });

    expect(parts.isAnimated).toBe(true);
    expect(parts.sticker.length + parts.audio.length).toBeLessThanOrEqual(1024 * 1024);
    expect(parts.seconds).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('rejects a video without an audio track', async () => {
    await expect(service.createAudioSticker({ visual: silent })).rejects.toThrow('NO_AUDIO');
  }, 30_000);

  it('rejects an image when no audio is supplied', async () => {
    await expect(service.createAudioSticker({ visual: image })).rejects.toThrow('NO_AUDIO');
  }, 30_000);

  it('combines a still image with supplied audio', async () => {
    const parts = await service.createAudioSticker({ visual: image, audio: shortAudio });

    expect(isWebp(parts.sticker)).toBe(true);
    expect(parts.audio.subarray(0, 4).toString()).toBe('OggS');
    expect(parts.isAnimated).toBe(false);
    expect(parts.width).toBe(512);
    expect(parts.height).toBe(512);
  }, 30_000);

  it('uses supplied audio even when the video has none', async () => {
    const parts = await service.createAudioSticker({ visual: silent, audio: mp3Audio });

    expect(isWebp(parts.sticker)).toBe(true);
    expect(parts.audio.length).toBeGreaterThan(0);
  }, 30_000);

  it('caps audio at 30 seconds by default', async () => {
    const parts = await service.createAudioSticker({ visual: image, audio: longAudio });

    const audioPath = join(dir, 'probe-long.ogg');
    writeFileSync(audioPath, parts.audio);
    expect(duration(audioPath)).toBeLessThanOrEqual(30.2);
  }, 30_000);

  it('honours a custom maxSeconds', async () => {
    const parts = await service.createAudioSticker({
      visual: image,
      audio: longAudio,
      maxSeconds: 5,
    });

    const audioPath = join(dir, 'probe-5s.ogg');
    writeFileSync(audioPath, parts.audio);
    expect(duration(audioPath)).toBeLessThanOrEqual(5.2);
  }, 30_000);

  it('rejects garbage audio and leaves no temp files', async () => {
    const before = audioTempFiles();

    await expect(
      service.createAudioSticker({ visual: image, audio: Buffer.from('definitely not audio') }),
    ).rejects.toThrow();

    expect(audioTempFiles()).toEqual(before);
  }, 30_000);

  it('keeps sticker plus audio under 1 MB', async () => {
    for (const opts of [
      { visual: withAudio },
      { visual: image, audio: shortAudio },
      { visual: silent, audio: mp3Audio },
    ]) {
      const parts = await service.createAudioSticker(opts);
      expect(parts.sticker.length + parts.audio.length).toBeLessThan(1024 * 1024);
    }
  }, 60_000);

  it('cleans its temp files after success', async () => {
    const before = audioTempFiles();

    await service.createAudioSticker({ visual: withAudio });

    expect(audioTempFiles()).toEqual(before);
  }, 30_000);
});
