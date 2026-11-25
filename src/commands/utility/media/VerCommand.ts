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

/**
 * Compact, serialisable view of a message for production logs: which wrapper
 * it uses, which inner keys it carries and whether the media is downloadable
 * (url/directPath/mediaKey). Base64 fields are never included.
 */
function describeContent(message?: proto.IMessage | null): Record<string, unknown> {
  const content = normalizeMessageContent(message);
  const media =
    content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? undefined;
  const fileLength = media?.fileLength;
  return {
    wrappers: message ? Object.keys(message) : [],
    keys: content ? Object.keys(content) : [],
    url: Boolean(media?.url),
    directPath: Boolean(media?.directPath),
    mediaKey: Boolean(media?.mediaKey),
    fileLength: fileLength === null || fileLength === undefined ? undefined : String(fileLength),
    mimetype: media?.mimetype ?? undefined,
  };
}

/** pino drops a bare Error passed as the second argument, so flatten it. */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const boom = error as Error & {
    status?: number;
    statusCode?: number;
    output?: { payload?: unknown };
  };
  return {
    name: error.name,
    message: error.message,
    status: boom.status ?? boom.statusCode,
    data: boom.output?.payload,
    stack: error.stack,
  };
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
    const source = useCached ? 'cache' : 'quote';
    const quotedInfo = describeContent(quotedMsg);
    const cachedInfo = cachedMessage ? describeContent(cachedMessage.message) : null;
    const cachedIds = () => mediaMessageCache.ids(ctx.chat.jid).slice(-10);
    const cacheInfo = () => {
      const scoped = mediaMessageCache.recent(ctx.chat.jid);
      return {
        cachedIds: cachedIds(),
        cacheSize: mediaMessageCache.size,
        uptimeSeconds: Math.round(process.uptime()),
        recent: scoped,
        recentAny: scoped.length > 0 ? undefined : mediaMessageCache.recent(''),
      };
    };

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
        id: quotedMsgId,
        chat: ctx.chat.jid,
        source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
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
      // Warn level: Docker runs the bot with LOG_LEVEL=warn by default.
      logger.warn('[VerCommand] reenviando', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        kind,
        source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
      });
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
      logger.error('[VerCommand] fallo al reenviar', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        kind,
        source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
        error: describeError(error),
      });
      await ctx.react('❌');

      // A quote without url/directPath can only be downloaded from the cache.
      const unavailable = source === 'quote' && !quotedInfo.url && !quotedInfo.directPath;
      await ctx.reply(
        unavailable
          ? '❌ Ese contenido ya no se puede descargar: no está en la caché del bot.\n\n' +
              'Envía el contenido de una sola vez con el bot encendido y usa `!ver` sin reiniciarlo.'
          : '❌ No se pudo reenviar el contenido.',
      );
    }
  }
}
