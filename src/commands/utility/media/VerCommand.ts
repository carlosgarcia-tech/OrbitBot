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

/** Text of a plain or view-once wrapper (already normalised). */
function textOf(content?: proto.IMessage | null): string | undefined {
  return content?.extendedTextMessage?.text || content?.conversation || undefined;
}

/** True when the normalised content has something worth re-sending. */
function hasContent(content?: proto.IMessage | null): boolean {
  return Boolean(
    content?.imageMessage || content?.videoMessage || content?.audioMessage || textOf(content),
  );
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

  /** Downloads the given message; Baileys unwraps view-once on its own. */
  private async download(
    ctx: MessageContext,
    quotedMsgId: string,
    message: proto.IMessage,
  ): Promise<Buffer> {
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

    // Unwraps view-once/ephemeral wrappers; the cached original keeps the
    // media url/directPath, which the quote stub may have stripped.
    const quotedContent = normalizeMessageContent(quotedMsg);
    const cachedMessage = mediaMessageCache.get(ctx.chat.jid, quotedMsgId);
    const cachedContent = normalizeMessageContent(cachedMessage?.message);
    const useCached = hasContent(cachedContent);
    const content = useCached ? cachedContent : quotedContent;

    const image = content?.imageMessage ?? undefined;
    const video = content?.videoMessage ?? undefined;
    const audio = content?.audioMessage ?? undefined;
    const text = textOf(content);

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
      logger.warn('[VerCommand] contenido no reenviable', {
        keys: Object.keys(content ?? {}),
        cached: Boolean(cachedMessage),
      });
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

      if (!content) throw new Error('NO_CONTENT');
      const mediaBuffer = await this.download(
        ctx,
        quotedMsgId,
        useCached ? (cachedMessage?.message ?? quotedMsg) : quotedMsg,
      );

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
