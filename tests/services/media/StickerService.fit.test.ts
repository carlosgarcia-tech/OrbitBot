/**
 * StickerService.fit.test.ts
 *
 * The sticker square is always filled, without cropping height on normal
 * photos:
 * - landscape crops side strips (the top must survive),
 * - normal portrait keeps its full height over a blurred copy of itself,
 * - only full vertical sources (height / width > 1.6) are cropped top/bottom.
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

/** RGBA of one pixel of the first frame. */
async function pixel(
  webp: Buffer,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number; a: number }> {
  const { data, info } = await sharp(webp)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

/** Image with a green strip at the top, red below: lets a test detect top cropping. */
async function topStripedImage(width: number, height: number): Promise<Buffer> {
  const strip = await sharp({
    create: {
      width,
      height: Math.round(height * 0.15),
      channels: 3,
      background: { r: 0, g: 220, b: 0 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .composite([{ input: strip, top: 0, left: 0 }])
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
  it('fills a wide image by cropping the sides and keeps its top', async () => {
    const sticker = await service.imageToSticker(await topStripedImage(800, 300));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    const top = await pixel(sticker, 256, 5);
    expect(top.a).toBeGreaterThan(250); // no blank band
    expect(top.g).toBeGreaterThan(top.r); // top strip survived
  }, 30_000);

  it('keeps a normal portrait at full height over a blurred fill', async () => {
    const sticker = await service.imageToSticker(await topStripedImage(600, 900));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    const top = await pixel(sticker, 256, 2);
    expect(top.g).toBeGreaterThan(top.r); // top strip survived: height not cropped
    const side = await pixel(sticker, 2, 256);
    expect(side.a).toBeGreaterThan(250); // sides filled, not blank
  }, 30_000);

  it('crops a full vertical image to fill the square', async () => {
    const sticker = await service.imageToSticker(await topStripedImage(300, 800));

    expect(await dimensions(sticker)).toEqual({ width: 512, height: 512 });
    expect((await pixel(sticker, 0, 0)).a).toBeGreaterThan(250); // no padding
  }, 30_000);

  it('fills a wide video by cropping the sides without blank bands', async () => {
    const sticker = await service.videoToSticker(solidVideo(640, 360));

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect((await pixel(sticker, 0, 0)).a).toBeGreaterThan(250);
  }, 60_000);

  it('keeps a normal portrait video full-height over a blurred fill', async () => {
    const sticker = await service.videoToSticker(solidVideo(400, 600));

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect((await pixel(sticker, 2, 160)).a).toBeGreaterThan(250); // sides filled
  }, 60_000);

  it('crops a full vertical video to fill the square', async () => {
    const sticker = await service.videoToSticker(solidVideo(180, 480));

    expect(await dimensions(sticker)).toEqual({ width: 320, height: 320 });
    expect((await pixel(sticker, 0, 0)).a).toBeGreaterThan(250); // no padding
  }, 60_000);
});
