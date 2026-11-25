/**
 * StickerService.fill.test.ts
 *
 * Stickers must fill their square: a wide source used to be shrunk into
 * transparent bars, which made the sticker look small in the chat. Both the
 * image and the video path now crop to cover instead of padding.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import sharp from 'sharp';
import { StickerService } from '@/services/media/StickerService.js';

const service = new StickerService();

/** Dimensions of the first frame. */
async function dimensions(webp: Buffer): Promise<{ width?: number; height?: number }> {
  const { width, height } = await sharp(webp).metadata();
  return { width, height };
}

/** Alpha of the top-left pixel: 0 means the corner is transparent padding. */
async function cornerAlpha(webp: Buffer): Promise<number> {
  const { data } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[3];
}

describe('StickerService fill', () => {
  it('crops a wide image to an opaque 512x512 sticker', async () => {
    const source = await sharp({
      create: { width: 800, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();

    const sticker = await service.imageToSticker(source);

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    expect(await cornerAlpha(sticker)).toBeGreaterThan(250);
  }, 30_000);

  it('crops a wide video to an opaque 320x320 sticker', async () => {
    const source = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:d=1',
      '-c:v',
      'libvpx',
      '-b:v',
      '200k',
      '-f',
      'webm',
      'pipe:1',
    ]);
    if (source.error) throw source.error;
    expect(source.status).toBe(0);

    const sticker = await service.videoToSticker(source.stdout);

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect(await cornerAlpha(sticker)).toBeGreaterThan(250);
  }, 60_000);
});
