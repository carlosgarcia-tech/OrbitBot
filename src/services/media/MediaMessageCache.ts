/**
 * MediaMessageCache.ts
 *
 * Keeps the most recent inbound media messages (full WAMessage objects, with
 * the CDN url intact) so commands can download media the user QUOTED.
 *
 * Why: WhatsApp strips the CDN url (and the thumbnailDirectPath) from quoted
 * media stubs in contextInfo, so rebuilding a synthetic message from
 * `ctx.quoted` and calling `downloadMediaMessage` fails with
 * '"imageMessage" message is not a media message'. The original message —
 * captured at reception — still has the url.
 *
 * Bounded (LRU-ish via Map insertion order) and best-effort: lookups miss
 * silently after eviction, restarts, or for media older than the cap.
 *
 * @author **Carlos G**
 * @created 2026-11-17
 */

import type { proto, WAMessage } from 'baileys';
import { logError, logger } from '@/utils/logger.js';

/** One day of a busy group is hundreds of messages; 300 covers plenty of history. */
const MAX_ENTRIES = 300;

/** Unwraps ephemeral/view-once envelopes (they can nest). */
function unwrapMessage(message?: proto.IMessage | null): proto.IMessage | undefined {
  let content = message ?? undefined;
  for (let depth = 0; depth < 3; depth++) {
    const inner =
      content?.ephemeralMessage?.message ??
      content?.viewOnceMessage?.message ??
      content?.viewOnceMessageV2?.message ??
      content?.viewOnceMessageV2Extension?.message;
    if (!inner) break;
    content = inner;
  }
  return content;
}

export class MediaMessageCache {
  readonly maxSize = MAX_ENTRIES;
  private readonly store = new Map<string, WAMessage>();

  /**
   * Caches media and view-once messages (text included). Best-effort.
   * View-once content is wrapped, so the type is checked after normalising.
   */
  put(message: WAMessage): void {
    try {
      const id = message.key?.id;
      const remoteJid = message.key?.remoteJid;
      if (!id || !remoteJid) return;

      const raw = message.message;
      const content = unwrapMessage(raw);
      const isWrapped = content !== raw;
      const hasMedia =
        Boolean(
          content?.imageMessage ||
          content?.videoMessage ||
          content?.stickerMessage ||
          content?.audioMessage ||
          (message.message as { audioStickerMessage?: { message?: { stickerMessage?: unknown } } })
            ?.audioStickerMessage?.message?.stickerMessage,
        ) || isWrapped;
      if (!hasMedia) return;

      const key = `${remoteJid}:${id}`;
      this.store.delete(key); // refresh insertion order
      this.store.set(key, message);

      // View-once is the fragile case: confirm it reached the cache and with
      // which media fields, so a later `!ver` miss can be explained.
      const viewOnce = Boolean(
        raw?.viewOnceMessage || raw?.viewOnceMessageV2 || raw?.viewOnceMessageV2Extension,
      );
      if (viewOnce) {
        const media =
          content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? undefined;
        logger.info('[MediaMessageCache] view-once guardado', {
          id,
          chat: remoteJid,
          keys: content ? Object.keys(content) : [],
          url: Boolean(media?.url),
          directPath: Boolean(media?.directPath),
        });
      }

      while (this.store.size > MAX_ENTRIES) {
        const oldest = this.store.keys().next().value;
        if (oldest === undefined) break;
        this.store.delete(oldest);
      }
    } catch (error) {
      logError('[MediaMessageCache]', error);
    }
  }

  /** Original message for a quoted reference, or undefined when unknown. */
  get(remoteJid: string, messageId: string): WAMessage | undefined {
    if (!messageId) return undefined;
    if (remoteJid) {
      const exact = this.store.get(`${remoteJid}:${messageId}`);
      if (exact) return exact;
    }
    // The same chat can be addressed as PN, LID or group JID; ids are unique.
    for (const message of this.store.values()) {
      if (message.key?.id === messageId) return message;
    }
    return undefined;
  }

  clear(): void {
    this.store.clear();
  }

  /** Number of cached entries. Diagnostics only. */
  get size(): number {
    return this.store.size;
  }

  /** Cached message ids for a chat, oldest first. Diagnostics only. */
  ids(remoteJid: string): string[] {
    const prefix = `${remoteJid}:`;
    return [...this.store.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length));
  }
}

export const mediaMessageCache = new MediaMessageCache();
