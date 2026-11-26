import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TikTokApi } from '../../../src/services/download/TikTokApi.js';

describe('TikTokApi', () => {
  it('maps the tikwm payload and caches it per URL', async () => {
    let calls = 0;
    const api = new TikTokApi(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            id: '1',
            title: 'Hi',
            duration: 24,
            play: '/video/sd.mp4',
            hdplay: '/video/hd.mp4',
          },
        }),
        { status: 200 },
      );
    });

    const data = await api.info('https://www.tiktok.com/@u/video/1');
    await api.info('https://www.tiktok.com/@u/video/1');

    expect(calls).toBe(1);
    expect(data.title).toBe('Hi');
    expect(api.mediaUrl(data, '720')).toBe('https://www.tikwm.com/video/hd.mp4');
    expect(api.mediaUrl(data, '480')).toBe('https://www.tikwm.com/video/sd.mp4');
  });

  it('rejects tikwm error payloads and missing media links', async () => {
    const api = new TikTokApi(
      async () =>
        new Response(JSON.stringify({ code: -1, msg: 'Url parsing is failed' }), { status: 200 }),
    );
    await expect(api.info('https://www.tiktok.com/@u/video/1')).rejects.toThrow(/Url parsing/);
    expect(() => api.mediaUrl({}, '720')).toThrow(/enlace de video/);
  });

  it('streams the CDN body to disk and rejects non-2xx responses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-api-'));
    const file = path.join(dir, 'media.mp4');
    try {
      await new TikTokApi(async () => new Response('bytes', { status: 200 })).downloadToFile(
        'https://cdn.test/v.mp4',
        file,
      );
      expect(fs.readFileSync(file, 'utf8')).toBe('bytes');

      await expect(
        new TikTokApi(async () => new Response('nope', { status: 403 })).downloadToFile(
          'https://cdn.test/v.mp4',
          path.join(dir, 'bad.mp4'),
        ),
      ).rejects.toThrow(/CDN HTTP 403/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
