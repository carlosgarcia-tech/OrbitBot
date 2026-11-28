/**
 * TakeCommand.ts
 *
 * media command `take` — Change sticker pack name and author
 * Usage: !take <text>  |  !take <packname>|<author>
 *
 * Behavior:
 *  - `!wm Carlos`          → pack = "Carlos", author = "" (vacío, aparece una sola vez)
 *  - `!wm Carlos|Garcia`   → pack = "Carlos", author = "Garcia"
 *  - `!wm`                 → pack = "OrbitBot", author = "OrbitBot"
 *
 * Audio stickers keep their track: the command re-sends them with the new
 * metadata instead of degrading them to a plain sticker.
 *
 * The text is used EXACTLY as provided (any Unicode: emojis, math alphanumerics,
 * combining marks, RTL scripts, decorative symbols). No normalization, no
 * length-based slicing, no stripping of special characters.
 *
 * Banned terms (see `@/utils/bannedWords.js`) are rejected before anything is
 * downloaded or modified. Normalization is used only for detection.
 *
 * @author **Carlos G**
 */

import { Command } from '../../Command.js';
import { CommandCategory, type MessageContext } from '@/types/index.js';
import { logError, logger } from '@/utils/logger.js';
import { containsBannedWord } from '@/utils/bannedWords.js';
import { downloadMediaMessage, type proto, type WAMessage } from 'baileys';
import { StickerService, type AudioStickerParts } from '@/services/media/StickerService.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import {
  sendAudioSticker,
  sendAudioStickerFallback,
  supportsAudioSticker,
} from '@/services/media/AudioStickerSender.js';

const DEFAULT_PACK = 'OrbitBot';
const DEFAULT_AUTHOR = 'OrbitBot';
const SEPARATOR = '|';
const STICKER_SIZE = 512;

/** Command handler for `!take`: Change sticker pack name and author. */
export class TakeCommand extends Command {
  name = 'take';
  description = 'Change sticker pack name and author';
  category = CommandCategory.MEDIA;
  heavy = true;
  aliases = ['wm', 'robarsticker', 'tomar'];
  usage = '!take <text> | !take <packname>|<author>';
  examples = ['!wm Carlos', '!wm ٠࣪⭑ 𝓒𝓪𝓻𝓵𝓸𝓼 𝓖 ˖᯽', '!take OrbitBot|Carlos', '!wm Carlos|Garcia'];
  cooldown = 3000;

  private stickerService: StickerService;

  constructor() {
    super();
    this.stickerService = new StickerService();
  }

  /**
   * Parses the user text into pack name and author.
   * - empty text            → defaults
   * - text without `|`      → text goes only to pack, author stays empty
   * - text with `|`         → before = pack, after (rest) = author
   * Only leading/trailing whitespace is trimmed; inner content is untouched.
   */
  private parseText(raw: string): { packname: string; author: string } {
    const text = raw.trim();

    if (!text) {
      return { packname: DEFAULT_PACK, author: DEFAULT_AUTHOR };
    }

    // Sin "|": el texto va SOLO al packname, el autor queda vacío
    if (!text.includes(SEPARATOR)) {
      return { packname: text, author: '' };
    }

    const [packPart = '', ...authorParts] = text.split(SEPARATOR);
    const packname = packPart.trim();
    const author = authorParts.join(SEPARATOR).trim();

    // "!wm |" or "!wm  | " → nothing useful provided, use defaults
    if (!packname && !author) {
      return { packname: DEFAULT_PACK, author: DEFAULT_AUTHOR };
    }

    return { packname, author };
  }

  /** Sticker content, either direct or inside the audio-sticker wrapper. */
  private getSticker(message?: proto.IMessage | null): proto.Message.IStickerMessage | undefined {
    if (!message) return undefined;
    const wrapper = (message as { audioStickerMessage?: { message?: proto.IMessage | null } })
      .audioStickerMessage;
    return message.stickerMessage ?? wrapper?.message?.stickerMessage ?? undefined;
  }

  /** Audio track attached to an audio sticker (field 26). */
  private getAudio(
    sticker: proto.Message.IStickerMessage,
  ): proto.Message.IAudioMessage | undefined {
    return (sticker as { audioMessage?: proto.Message.IAudioMessage }).audioMessage ?? undefined;
  }

  /** Downloads media from a synthetic message built out of the sticker's parts. */
  private async download(
    ctx: MessageContext,
    quotedMsgId: string | undefined,
    quotedParticipant: string | undefined,
    media: {
      stickerMessage?: proto.Message.IStickerMessage;
      audioMessage?: proto.Message.IAudioMessage;
    },
  ): Promise<Buffer> {
    const messageToDownload: WAMessage = {
      key: {
        id: quotedMsgId || '',
        remoteJid: quotedParticipant || ctx.chat.jid,
        fromMe: false,
      },
      message: media,
      messageTimestamp: Date.now(),
      pushName: '',
      status: 0,
    };
    return (await downloadMediaMessage(messageToDownload, 'buffer', {})) as Buffer;
  }

  /** Sends the renamed sticker, keeping the sound when it had one. */
  private async send(
    ctx: MessageContext,
    sticker: Buffer,
    stickerMeta: proto.Message.IStickerMessage,
    audio?: proto.Message.IAudioMessage,
    audioBuffer?: Buffer,
  ): Promise<void> {
    if (!audio || !audioBuffer) {
      await ctx.sock.sendMessage(ctx.chat.jid, { sticker });
      return;
    }

    const parts: AudioStickerParts = {
      sticker,
      audio: audioBuffer,
      seconds: Number(audio.seconds) || 1,
      waveform: Buffer.from(audio.waveform ?? new Uint8Array(64)),
      width: Number(stickerMeta.width) || STICKER_SIZE,
      height: Number(stickerMeta.height) || STICKER_SIZE,
      isAnimated: Boolean(stickerMeta.isAnimated),
    };

    if (supportsAudioSticker()) {
      try {
        await sendAudioSticker(ctx.sock, ctx.chat.jid, parts, ctx.message);
        return;
      } catch (error) {
        logError('[TakeCommand] envío nativo falló, usando fallback', error);
      }
    } else {
      logger.warn('[TakeCommand] Baileys sin audioStickerMessage, usando fallback');
    }
    await sendAudioStickerFallback(ctx.sock, ctx.chat.jid, parts);
  }

  async execute(ctx: MessageContext): Promise<void> {
    const quotedMsg = ctx.quoted;
    const quotedMsgId = ctx.quotedMessageId;
    const quotedParticipant = ctx.quotedParticipant;

    const quotedSticker = this.getSticker(quotedMsg);
    if (!quotedSticker) {
      await ctx.reply('⚠️ *Reply to a sticker!*');
      return;
    }

    const rawText = ctx.args.join(' ');
    const { packname, author } = this.parseText(rawText);

    // Banned words filter: checks the raw input, pack and author separately,
    // so splitting across the `|` separator ("p|io") is also caught.
    if (containsBannedWord(rawText, packname, author)) {
      await ctx.react('🚫');
      await ctx.reply('🚫 *That text is not allowed.*');
      return;
    }

    await ctx.react('⏳');

    try {
      // Quotes arrive without the CDN url, so prefer the original message
      // cached at reception; fall back to the quote when it still has one.
      const cachedMessage = mediaMessageCache.get(ctx.chat.jid, quotedMsgId || '');

      const cachedSticker = this.getSticker(cachedMessage?.message);
      const cachedAudio = cachedSticker ? this.getAudio(cachedSticker) : undefined;
      const quotedAudio = this.getAudio(quotedSticker);

      const stickerMeta = cachedSticker?.url ? cachedSticker : quotedSticker;
      const audioMeta = cachedAudio?.url ? cachedAudio : quotedAudio;

      const buffer = await this.download(ctx, quotedMsgId, quotedParticipant, {
        stickerMessage: stickerMeta,
      });
      const sticker = await this.stickerService.addExif(buffer, packname, author);

      const audioBuffer = audioMeta
        ? await this.download(ctx, quotedMsgId, quotedParticipant, {
            audioMessage: audioMeta,
          }).catch((error: unknown) => {
            // Expired audio url: still deliver the renamed sticker.
            logError('[TakeCommand] audio download failed', error);
            return undefined;
          })
        : undefined;

      await this.send(ctx, sticker, stickerMeta, audioMeta, audioBuffer);
      await ctx.react('✅');
    } catch (error) {
      logError('[TakeCommand] Error', error);
      await ctx.reply('❌ Could not modify sticker');
      await ctx.react('❌');
    }
  }
}
