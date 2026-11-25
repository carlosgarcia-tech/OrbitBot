/**
 * VerCommand.ts
 *
 * utility command `ver` — Re-sends a chat image/video/audio/text as a normal
 * message, including view-once content.
 * Usage: !ver (reply to the message)
 *
 * Quotes arrive without the CDN url (and view-once content arrives wrapped),
 * so the original message cached at reception is preferred for media.
 *
 * @author **Carlos G**
 */

import { Command } from '../../Command.js';
import { CommandCategory, CommandContext, type MessageContext } from '@/types/index.js';
import { downloadMediaMessage, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import { logger } from '@/utils/logger.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';

type MediaKind = 'image' | 'video' | 'audio';

interface MediaStub {
  url?: string | null;
}

/** Text of a plain or view-once wrapper (already normalised). */
function viewOnceText(content?: proto.IMessage | null): string | undefined {
  return content?.extendedTextMessage?.text || content?.conversation || undefined;
}

/** Cached media wins when it still carries the CDN url. */
function pickMedia<T extends MediaStub>(
  cached: T | null | undefined,
  quoted: T | null | undefined,
): T | undefined {
  const original = cached ?? undefined;
  const stub = quoted ?? undefined;
  if (original?.url) return original;
  if (stub?.url) return stub;
  return undefined;
}

/** Command handler for `!ver`: re-sends the quoted message as a normal one. */
export class VerCommand extends Command {
  name = 'ver';
  description = 'Reenvía una imagen, video, audio o texto (también de una sola vez)';
  category = CommandCategory.UTILITY;
  aliases = ['img', 'verimagen', 'image', 'reenviar'];
  usage = '!ver (responder al mensaje)';
  examples = ['!ver (responder a una foto, video, audio o texto de una sola vez)'];
  cooldown = 5000;
  contexts = [CommandContext.BOTH];

  private async download(
    ctx: MessageContext,
    quotedMsgId: string,
    kind: MediaKind,
    media: proto.Message.IImageMessage | proto.Message.IVideoMessage | proto.Message.IAudioMessage,
  ): Promise<Buffer> {
    const message: proto.IMessage =
      kind === 'image'
        ? { imageMessage: media as proto.Message.IImageMessage }
        : kind === 'video'
          ? { videoMessage: media as proto.Message.IVideoMessage }
          : { audioMessage: media as proto.Message.IAudioMessage };

    const messageToDownload: WAMessage = {
      key: { id: quotedMsgId, remoteJid: ctx.chat.jid, fromMe: false },
      message,
      messageTimestamp: Date.now(),
      pushName: '',
      status: 0,
    };

    return (await downloadMediaMessage(messageToDownload, 'buffer', {})) as Buffer;
  }

  async execute(ctx: MessageContext): Promise<void> {
    const quotedMsg = ctx.quoted;
    const quotedMsgId = ctx.quotedMessageId;

    if (!quotedMsg || !quotedMsgId) {
      await ctx.reply(
        `❌ Debes *responder* a un mensaje para reenviarlo.\n\n` +
          `Funciona con imágenes, videos, audios y textos, incluso de una sola vez.`,
      );
      return;
    }

    // Unwraps view-once/ephemeral wrappers; the cached original keeps the url.
    const quotedContent = normalizeMessageContent(quotedMsg);
    const cachedMessage = mediaMessageCache.get(ctx.chat.jid, quotedMsgId);
    const cachedContent = normalizeMessageContent(cachedMessage?.message);

    /** Cached media wins when it still has the CDN url. */
    const image = pickMedia(cachedContent?.imageMessage, quotedContent?.imageMessage);
    const video = pickMedia(cachedContent?.videoMessage, quotedContent?.videoMessage);
    const audio = pickMedia(cachedContent?.audioMessage, quotedContent?.audioMessage);
    const text = viewOnceText(cachedContent) ?? viewOnceText(quotedContent);

    const kind: MediaKind | 'text' | undefined = image
      ? 'image'
      : video
        ? 'video'
        : audio
          ? 'audio'
          : text
            ? 'text'
            : undefined;
    if (!kind) {
      await ctx.reply('❌ El mensaje citado no es una imagen, video, audio o texto.');
      return;
    }

    await ctx.react('⏳');

    try {
      if (kind === 'text') {
        if (!text) throw new Error('NO_TEXT');
        await ctx.sock.sendMessage(ctx.chat.jid, { text });
        await ctx.react('✅');
        return;
      }

      const media = kind === 'image' ? image : kind === 'video' ? video : audio;
      if (!media) throw new Error('NO_MEDIA');

      const mediaBuffer = await this.download(ctx, quotedMsgId, kind, media);

      if (kind === 'image') {
        const caption = image?.caption ?? undefined;
        await ctx.sock.sendMessage(ctx.chat.jid, {
          image: mediaBuffer,
          ...(caption && { caption }),
        });
      } else if (kind === 'video') {
        const caption = video?.caption ?? undefined;
        await ctx.sock.sendMessage(ctx.chat.jid, {
          video: mediaBuffer,
          ...(caption && { caption }),
        });
      } else {
        await ctx.sock.sendMessage(ctx.chat.jid, {
          audio: mediaBuffer,
          mimetype: audio?.mimetype ?? 'audio/ogg; codecs=opus',
          ptt: Boolean(audio?.ptt),
        });
      }

      await ctx.react('✅');
    } catch (error) {
      logger.error('[VerCommand] Error:', error);
      await ctx.react('❌');
      await ctx.reply('❌ No se pudo reenviar el contenido.');
    }
  }
}
