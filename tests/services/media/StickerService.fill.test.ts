/**
 * StickerService.fill.test.ts
 *
 * Stickers must fill their square without losing almost half of a wide
 * source: the long side is cropped by at most 15% and the rest is padded with
 * a blurred copy. Small sources are not upscaled.
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

/** RGB of one pixel of the first frame. */
async function pixel(webp: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return [data[index], data[index + 1], data[index + 2]];
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

  it('keeps content near both edges of a wide image', async () => {
    // Blue at x100-200 and red at x800-900: a cover crop removed both, the
    // limited crop must keep them visible.
    const source = await sharp({
      create: { width: 1000, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: {
            create: { width: 100, height: 300, channels: 3, background: { r: 0, g: 0, b: 255 } },
          },
          left: 100,
          top: 0,
        },
        {
          input: {
            create: { width: 100, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } },
          },
          left: 800,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    const sticker = await service.imageToSticker(source);

    const [leftR, , leftB] = await pixel(sticker, 30, 256);
    expect(leftB).toBeGreaterThan(150);
    expect(leftR).toBeLessThan(100);

    const [rightR, , rightB] = await pixel(sticker, 480, 256);
    expect(rightR).toBeGreaterThan(150);
    expect(rightB).toBeLessThan(100);
  }, 30_000);

  it('fills a wide video with an opaque 320x320 sticker', async () => {
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
