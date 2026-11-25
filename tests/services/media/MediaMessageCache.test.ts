/**
 * MediaMessageCache.test.ts
 *
 * Quoted media stubs from contextInfo no longer carry the CDN url, so
 * sticker/IA commands can't download by rebuilding a synthetic message —
 * the cache keeps the ORIGINAL messages and resolves them by id.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';

const makeMsg = (id: string, remoteJid: string) => ({
  key: { id, remoteJid, fromMe: false },
  message: { imageMessage: { url: 'https://mmg.whatsapp.net/x', mediaKey: Buffer.from('k') } },
});

describe('MediaMessageCache', () => {
  beforeEach(() => {
    mediaMessageCache.clear();
  });

  it('returns the original message by remoteJid + id', () => {
    const msg = makeMsg('ABC', 'group@g.us');
    mediaMessageCache.put(msg);

    expect(mediaMessageCache.get('group@g.us', 'ABC')).toBe(msg);
  });

  it('misses for unknown ids and drops non-media messages', () => {
    expect(mediaMessageCache.get('group@g.us', 'ABC')).toBeUndefined();

    mediaMessageCache.put({ key: { id: 'TXT', remoteJid: 'group@g.us' }, message: {} } as never);
    expect(mediaMessageCache.get('group@g.us', 'TXT')).toBeUndefined();
  });

  it('caches audio messages so a quoted voice note can be downloaded', () => {
    const audio = {
      key: { id: 'AUD', remoteJid: 'group@g.us', fromMe: false },
      message: { audioMessage: { url: 'https://mmg.whatsapp.net/a', mediaKey: Buffer.from('k') } },
    };
    mediaMessageCache.put(audio as never);

    expect(mediaMessageCache.get('group@g.us', 'AUD')).toBe(audio);
  });

  it('resolves by id when the chat is addressed with another JID form', () => {
    const msg = makeMsg('LID1', '123@lid');
    mediaMessageCache.put(msg as never);

    expect(mediaMessageCache.get('123@s.whatsapp.net', 'LID1')).toBe(msg);
  });

  it('reports the cached ids and size for a chat', () => {
    mediaMessageCache.put(makeMsg('A1', 'group@g.us') as never);
    mediaMessageCache.put(makeMsg('A2', 'group@g.us') as never);

    expect(mediaMessageCache.ids('group@g.us')).toEqual(['A1', 'A2']);
    expect(mediaMessageCache.size).toBe(2);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const cap = mediaMessageCache.maxSize;
    for (let i = 0; i <= cap; i++) {
      mediaMessageCache.put(makeMsg(`id-${i}`, 'group@g.us'));
    }
    expect(mediaMessageCache.get('group@g.us', 'id-0')).toBeUndefined();
    expect(mediaMessageCache.get('group@g.us', `id-${cap}`)).toBeDefined();
  });
});
