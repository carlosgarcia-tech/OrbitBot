/**
 * TikTokApi.ts
 *
 * Minimal client for tikwm.com: resolves TikTok metadata and a no-watermark
 * video URL from tikwm's own IPs. TikTok answers yt-dlp's webpage request with
 * HTTP 403 from this server; tikwm is the route most downloader bots use.
 *
 * @author **Carlos G**
 * @created 2026-11-25
 */

import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const BASE_URL = 'https://www.tikwm.com';
const INFO_TTL_MS = 5 * 60 * 1000;

export interface TikTokApiData {
  id?: string;
  title?: string;
  duration?: number;
  play?: string;
  hdplay?: string;
  music?: string;
  cover?: string;
  images?: string[] | null;
  author?: { unique_id?: string; nickname?: string };
}

interface TikTokApiResponse {
  code?: number;
  msg?: string;
  data?: TikTokApiData;
}

type WebReadable = Parameters<typeof Readable.fromWeb>[0];

/** Thin tikwm client with a short info cache (info + download share one call). */
export class TikTokApi {
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { data: TikTokApiData; at: number }>();

  constructor(fetchImpl: typeof fetch = fetch, ttlMs: number = INFO_TTL_MS) {
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
  }

  /** Prefixes tikwm's relative media paths (some responses return `/video/...`). */
  absolute(url?: string): string | undefined {
    if (!url) return undefined;
    return /^https?:\/\//i.test(url) ? url : `${BASE_URL}${url}`;
  }

  async info(url: string): Promise<TikTokApiData> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.data;

    const endpoint = `${BASE_URL}/api/?url=${encodeURIComponent(url)}&hd=1`;
    const response = await this.fetchImpl(endpoint, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!response.ok) throw new Error(`tikwm HTTP ${response.status}`);

    const body = (await response.json()) as TikTokApiResponse;
    if (body.code !== 0 || !body.data) throw new Error(`tikwm: ${body.msg ?? 'sin datos'}`);

    this.cache.set(url, { data: body.data, at: Date.now() });
    if (this.cache.size > 100) this.cache.clear();
    return body.data;
  }

  /** No-watermark media URL: HD for 720p+, standard otherwise. */
  mediaUrl(data: TikTokApiData, quality: string): string {
    const hd = Number.parseInt(quality, 10) >= 720;
    const url = (hd ? data.hdplay : undefined) ?? data.play;
    const absolute = this.absolute(url);
    if (!absolute) throw new Error('tikwm no devolvió un enlace de video');
    return absolute;
  }

  /** Streams the CDN URL to disk (TikTok videos can be large for a buffer). */
  async downloadToFile(mediaUrl: string, filePath: string): Promise<void> {
    const response = await this.fetchImpl(mediaUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`CDN HTTP ${response.status}`);

    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadable),
      fs.createWriteStream(filePath),
    );
  }
}
