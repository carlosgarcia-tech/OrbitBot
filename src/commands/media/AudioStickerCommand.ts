/**
 * AudioStickerCommand.ts
 *
 * media command `saudio` — sticker with sound.
 *
 * Two flows:
 *  - reply to a video with sound          -> audio comes from that video
 *  - image/video with `!saudio` caption
 *    replying to an audio / voice note    -> the two are combined
 *
 * The same pair also works one level deeper: replying to an image/video that
 * itself quotes an audio, or to an audio that quotes an image/video.
 *
 * Baileys 7.0.0-rc13/rc14 does not generate the audio-sticker fields, so
 * AudioStickerSender extends the proto encoders at runtime. If that extension
 * cannot be installed, the command falls back to a sticker plus a voice note.
 *
 * @author **Carlos G**
 * @created 2026-11-24
 */

import { Command } from '../Command.js';
import { CommandCategory, CommandContext, type MessageContext } from '@/types/index.js';
import { logError, logger } from '@/utils/logger.js';
import { downloadMediaMessage, type proto, type WAMessage } from 'baileys';
import { getContextInfo } from '@/utils/getContextInfo.js';
import { StickerService } from '@/services/media/StickerService.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import {
  sendAudioSticker,
  sendAudioStickerFallback,
  supportsAudioSticker,
} from '@/services/media/AudioStickerSender.js';
import { STICKER_BRANDING } from './StickerCommand.js';

/** How to obtain one of the two media pieces: real message, cache id or quoted stub. */
interface MediaSource {
  /** The original message, when it is the one being handled. */
  message?: WAMessage;
  /** Message id used to find the cached original. */
  id?: string;
  /** Quoted content, used to build a download request when cache misses. */
  content?: proto.IMessage;
}

/** What the command will download: a visual and, optionally, separate audio. */
interface MediaPlan {
  visual: MediaSource;
  visualKind: 'image' | 'video';
  audio?: MediaSource;
}

/** Kind of media inside a message body (audio first: it may embed a quoted image). */
function mediaKind(content?: proto.IMessage | null): 'image' | 'video' | 'audio' | null {
  if (content?.audioMessage) return 'audio';
  if (content?.videoMessage) return 'video';
  if (content?.imageMessage) return 'image';
  return null;
}

/** Command handler for `!saudio`: sticker with sound. */
export class AudioStickerCommand extends Command {
  name = 'saudio';
  description = 'Crea un sticker con audio';
  category = CommandCategory.MEDIA;
  heavy = true;
  aliases = ['sa', 'stickeraudio'];
  usage =
    '!saudio <responde a un video con audio> | foto/video con !saudio respondiendo a un audio';
  timeout = 120_000;
  examples = ['!saudio'];
  contexts = [CommandContext.BOTH];

  private stickerService = new StickerService();

  async execute(ctx: MessageContext): Promise<void> {
    const plan = this.buildPlan(ctx);

    if (!plan) {
      await ctx.reply(
        `˚₊· *sticker con audio* ˚₊·\n\n` +
          `✦ responde a un *video con sonido* con *!saudio*\n` +
          `✦ o manda una foto/video con *!saudio* de texto, respondiendo a un *audio*\n` +
          `✦ también sirve responder a una foto/video que cite un audio (o al revés)`,
      );
      return;
    }

    if (!plan.audio && plan.visualKind === 'image') {
      await ctx.reply(
        '❌ Esa imagen no trae audio. Responde con *!saudio* al audio que quieres usar, ' +
          'o mándala con *!saudio* de texto respondiendo a ese audio.',
      );
      return;
    }

    await ctx.react('⏳');

    try {
      const visual = await this.download(ctx, plan.visual);
      const audio = plan.audio ? await this.download(ctx, plan.audio) : undefined;

      const parts = await this.stickerService.createAudioSticker({ visual, audio });
      parts.sticker = await this.stickerService.addExif(
        parts.sticker,
        STICKER_BRANDING.packname,
        STICKER_BRANDING.author,
      );

      if (supportsAudioSticker()) {
        try {
          await sendAudioSticker(ctx.sock, ctx.chat.jid, parts, ctx.message);
        } catch (error) {
          // A failed relay leaves the chat empty; deliver the two normal
          // messages instead of making the user retry.
          logError('[AudioStickerCommand] envío nativo falló, usando fallback', error);
          await sendAudioStickerFallback(ctx.sock, ctx.chat.jid, parts);
        }
      } else {
        logger.warn('[AudioStickerCommand] Baileys sin audioStickerMessage, usando fallback');
        await sendAudioStickerFallback(ctx.sock, ctx.chat.jid, parts);
      }
      await ctx.react('✅');
    } catch (error) {
      logError('[AudioStickerCommand] Error', error);
      await ctx.react('❌');
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(
        message === 'NO_AUDIO'
          ? '❌ Ese video no tiene audio. Responde a un audio o usa un video con sonido.'
          : message === 'AUDIO_STICKER_TOO_BIG'
            ? '❌ Quedó muy pesado. Prueba con algo más corto.'
            : `❌ No pude crear el sticker con audio: ${message.slice(0, 140)}`,
      );
    }
  }

  /**
   * Decides where the visual and the audio come from. Supports the two
   * direct flows and the same pair nested one level: an image/video whose
   * own quote points at an audio, and the reverse. Quoted media can only be
   * downloaded from the cache, so the cached original is preferred over the
   * stripped quoted stub.
   */
  private buildPlan(ctx: MessageContext): MediaPlan | null {
    const direct = ctx.message.message;
    const quoted = this.quotedContent(ctx);
    const context = getContextInfo(quoted);
    const nested = context?.quotedMessage;

    const directKind = mediaKind(direct);
    const quotedKind = mediaKind(quoted);
    const nestedKind = mediaKind(nested);

    const directSource: MediaSource = { message: ctx.message };
    const quotedSource: MediaSource = { id: ctx.quotedMessageId, content: quoted };
    const nestedSource: MediaSource = {
      id: context?.stanzaId ?? undefined,
      content: nested ?? undefined,
    };

    if (directKind && directKind !== 'audio' && quotedKind === 'audio') {
      return { visual: directSource, visualKind: directKind, audio: quotedSource };
    }
    if (quotedKind === 'image' || quotedKind === 'video') {
      return {
        visual: quotedSource,
        visualKind: quotedKind,
        audio: nestedKind === 'audio' ? nestedSource : undefined,
      };
    }
    if (quotedKind === 'audio' && (nestedKind === 'image' || nestedKind === 'video')) {
      return { visual: nestedSource, visualKind: nestedKind, audio: quotedSource };
    }
    return null;
  }

  /** Full quoted message when cached; the stripped stub as last resort. */
  private quotedContent(ctx: MessageContext): proto.IMessage | undefined {
    const msgId = ctx.quotedMessageId;
    const cached = msgId ? mediaMessageCache.get(ctx.chat.jid, msgId) : undefined;
    return cached?.message ?? ctx.quoted;
  }

  /** Downloads one planned piece, preferring the cached original (url intact). */
  private async download(ctx: MessageContext, source: MediaSource): Promise<Buffer> {
    const cached = source.id ? mediaMessageCache.get(ctx.chat.jid, source.id) : undefined;
    const message: WAMessage = source.message ??
      cached ?? {
        key: {
          id: source.id || '',
          remoteJid: ctx.chat.jid,
          fromMe: false,
        },
        message: source.content,
        messageTimestamp: Date.now(),
        pushName: '',
        status: 0,
      };

    return (await downloadMediaMessage(message, 'buffer', {})) as Buffer;
  }
}
