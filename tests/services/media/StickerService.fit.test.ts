/**
 * StickerService.fit.test.ts
 *
 * Stickers keep the whole image: normal photos are letterboxed with
 * transparency instead of being cropped (cropping ate the top of tall
 * photos). Only full vertical sources (height / width > 1.6) are cropped to
 * fill the square, because padding would shrink them to a sliver.
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

/** Alpha of one pixel; 0 means transparent padding. */
async function alphaAt(webp: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
}

/** Solid-colour PNG of the given size. */
function solidImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** Solid-colour webm clip of the given size. */
function solidVideo(width: number, height: number): Buffer {
  const source = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${width}x${height}:d=1`,
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
  return source.stdout;
}

describe('StickerService fit', () => {
  it('keeps a normal portrait photo uncropped inside transparent bands', async () => {
    const sticker = await service.imageToSticker(await solidImage(600, 900));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    expect(await alphaAt(sticker, 256, 0)).toBeGreaterThan(250); // top survived
    expect(await alphaAt(sticker, 0, 256)).toBe(0); // side padding
  }, 30_000);

  it('keeps a wide image uncropped inside transparent bands', async () => {
    const sticker = await service.imageToSticker(await solidImage(800, 300));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    expect(await alphaAt(sticker, 256, 0)).toBe(0); // top padding
    expect(await alphaAt(sticker, 256, 256)).toBeGreaterThan(250);
  }, 30_000);

  it('crops a full vertical image to fill the square', async () => {
    const sticker = await service.imageToSticker(await solidImage(300, 800));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    expect(await alphaAt(sticker, 0, 0)).toBeGreaterThan(250); // no padding
  }, 30_000);

  it('keeps a wide video uncropped inside transparent bands', async () => {
    const sticker = await service.videoToSticker(solidVideo(640, 360));

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect(await alphaAt(sticker, 160, 0)).toBe(0); // top padding
  }, 60_000);

  it('crops a full vertical video to fill the square', async () => {
    const sticker = await service.videoToSticker(solidVideo(180, 480));

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect(await alphaAt(sticker, 0, 0)).toBeGreaterThan(250); // no padding
  }, 60_000);
});
