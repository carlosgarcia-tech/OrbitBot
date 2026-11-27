/**
 * StickerService.concurrent.test.ts
 *
 * Parallel stickers must not share temp files. Before the fix, two conversions
 * starting in the same millisecond used `Date.now()` in their filenames, so one
 * overwrote the other's source and cleanup deleted files still in use.
 *
 * The test freezes `Date.now()` and converts several solid images at once: each
 * sticker must keep its own colour.
 */

import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { StickerService } from '@/services/media/StickerService.js';

const COLORS = [
  { r: 200, g: 20, b: 20 },
  { r: 20, g: 200, b: 20 },
  { r: 20, g: 20, b: 200 },
  { r: 200, g: 200, b: 20 },
  { r: 200, g: 20, b: 200 },
  { r: 20, g: 200, b: 200 },
];

async function solidPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** RGB of the centre pixel of a sticker. */
async function centrePixel(webp: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(webp).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const x = Math.floor(info.width / 2);
  const y = Math.floor(info.height / 2);
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('StickerService concurrency', () => {
  it('keeps concurrent conversions independent when time is frozen', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const service = new StickerService();

    try {
      const sources = await Promise.all(COLORS.map(solidPng));
      const stickers = await Promise.all(sources.map(source => service.imageToSticker(source)));

      for (const [index, sticker] of stickers.entries()) {
        const expected = COLORS[index];
        const actual = await centrePixel(sticker);
        expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(12);
        expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(12);
        expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(12);
      }
    } finally {
      clock.mockRestore();
    }
  }, 60_000);
});
