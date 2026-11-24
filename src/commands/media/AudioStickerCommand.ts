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
import { downloadMediaMessage, type WAMessage } from 'baileys';
import { StickerService } from '@/services/media/StickerService.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import {
  sendAudioSticker,
  sendAudioStickerFallback,
  supportsAudioSticker,
} from '@/services/media/AudioStickerSender.js';
import { STICKER_BRANDING } from './StickerCommand.js';

/** Command handler for `!saudio`: sticker with sound. */
export class AudioStickerCommand extends Command {
  name = 'saudio';
  description = 'Crea un sticker con audio';
  category = CommandCategory.MEDIA;
  aliases = ['sa', 'stickeraudio'];
  usage =
    '!saudio <responde a un video con audio> | foto/video con !saudio respondiendo a un audio';
  timeout = 90_000;
  examples = ['!saudio'];
  contexts = [CommandContext.BOTH];

  private stickerService = new StickerService();

  async execute(ctx: MessageContext): Promise<void> {
    const direct = ctx.message.message;
    const quoted = ctx.quoted;

    const directVisual = !!(direct?.imageMessage || direct?.videoMessage);
    const quotedVisual = !!(quoted?.imageMessage || quoted?.videoMessage);
    const quotedAudio = !!quoted?.audioMessage;

    let visualFrom: 'direct' | 'quoted';
    let audioFrom: 'quoted' | null;

    if (directVisual && quotedAudio) {
      visualFrom = 'direct';
      audioFrom = 'quoted';
    } else if (quotedVisual) {
      visualFrom = 'quoted';
      audioFrom = null;
    } else {
      await ctx.reply(
        `˚₊· *sticker con audio* ˚₊·\n\n` +
          `✦ responde a un *video con sonido* con *!saudio*\n` +
          `✦ o manda una foto/video con *!saudio* de texto, respondiendo a un *audio*`,
      );
      return;
    }

    await ctx.react('⏳');

    try {
      const visual = await this.download(ctx, visualFrom);
      const audio = audioFrom ? await this.download(ctx, audioFrom) : undefined;

      const parts = await this.stickerService.createAudioSticker({ visual, audio });
      parts.sticker = await this.stickerService.addExif(
        parts.sticker,
        STICKER_BRANDING.packname,
        STICKER_BRANDING.author,
      );

      if (supportsAudioSticker()) {
        await sendAudioSticker(ctx.sock, ctx.chat.jid, parts, ctx.message);
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

  /** Downloads the direct message (real urls) or the cached quoted original. */
  private async download(ctx: MessageContext, from: 'direct' | 'quoted'): Promise<Buffer> {
    if (from === 'direct') {
      return (await downloadMediaMessage(ctx.message, 'buffer', {})) as Buffer;
    }

    const content = ctx.quoted;
    const msgId = ctx.quotedMessageId;
    const cached = msgId ? mediaMessageCache.get(ctx.chat.jid, msgId) : undefined;

    const messageToDownload: WAMessage = cached ?? {
      key: {
        id: msgId || '',
        remoteJid: ctx.quotedParticipant || ctx.chat.jid,
        fromMe: false,
      },
      message: {
        imageMessage: content?.imageMessage || undefined,
        videoMessage: content?.videoMessage || undefined,
        audioMessage: content?.audioMessage || undefined,
      },
      messageTimestamp: Date.now(),
      pushName: '',
      status: 0,
    };

    return (await downloadMediaMessage(messageToDownload, 'buffer', {})) as Buffer;
  }
}
