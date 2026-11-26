/**
 * VerCommand.ts
 *
 * utility command `ver` — Re-sends a chat image/video/audio/text as a normal
 * message, including view-once content.
 * Usage: !ver (reply to the message)
 *
 * Quotes arrive without the CDN url, and view-once content now arrives as an
 * empty "unavailable fanout" stub. The original message cached at reception is
 * preferred, and when it is missing the bot asks the phone to resend it.
 *
 * @author **Carlos G**
 */

import { Command } from '../../Command.js';
import { CommandCategory, CommandContext, type MessageContext } from '@/types/index.js';
import {
  areJidsSameUser,
  downloadMediaMessage,
  normalizeMessageContent,
  type proto,
  type WAMessage,
} from 'baileys';
import { logger } from '@/utils/logger.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';

type MediaKind = 'image' | 'video' | 'audio';
type AnyKind = MediaKind | 'text';

interface Classification {
  kind?: AnyKind;
  image?: proto.Message.IImageMessage;
  video?: proto.Message.IVideoMessage;
  audio?: proto.Message.IAudioMessage;
  text?: string;
}

const UNAVAILABLE_REPLY =
  '❌ Ese contenido ya no se puede descargar: no está en la caché del bot.\n\n' +
  'Deja el teléfono conectado y usa `!ver` respondiendo al mensaje.';

const OWN_STUB_REPLY =
  '❌ Ese contenido no llegó al bot y tu teléfono no puede reenviarlo: lo enviaste tú desde el mismo número.\n\n' +
  'WhatsApp no entrega a los dispositivos vinculados el contenido de una sola vez que envía la cuenta principal. ' +
  'Prueba con uno que te envíe otra persona.';

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

function classify(content?: proto.IMessage | null): Classification {
  const image = content?.imageMessage ?? undefined;
  const video = content?.videoMessage ?? undefined;
  const audio = content?.audioMessage ?? undefined;
  const text = textOf(content);
  const kind: AnyKind | undefined = image
    ? 'image'
    : video
      ? 'video'
      : audio
        ? 'audio'
        : text
          ? 'text'
          : undefined;
  return { kind, image, video, audio, text };
}

function mediaOf(
  info: Classification,
): { url?: string | null; directPath?: string | null } | undefined {
  return info.kind === 'image'
    ? info.image
    : info.kind === 'video'
      ? info.video
      : info.kind === 'audio'
        ? info.audio
        : undefined;
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

  /** How long to wait for the phone to resend an unavailable message. */
  static resendTimeoutMs = 10_000;
  static resendPollMs = 500;

  /** True when the quoted message came from this same WhatsApp account. */
  private isOwnQuote(ctx: MessageContext): boolean {
    const participant = ctx.quotedParticipant;
    const me = ctx.sock.user;
    if (!participant || !me) return false;
    return (
      areJidsSameUser(participant, me.id) ||
      (Boolean(me.lid) && areJidsSameUser(participant, me.lid as string))
    );
  }

  /**
   * Asks the primary phone to resend a message this device only got as an
   * empty stub and waits for it to land in the media cache.
   */
  private async requestResend(ctx: MessageContext, id: string): Promise<void> {
    if (typeof ctx.sock.requestPlaceholderResend !== 'function') return;

    logger.warn('[VerCommand] mensaje no disponible, pidiendo reenvío al teléfono', {
      id,
      chat: ctx.chat.jid,
    });

    try {
      const requestId = await ctx.sock.requestPlaceholderResend({
        remoteJid: ctx.chat.jid,
        id,
        fromMe: false,
        participant: ctx.quotedParticipant,
      });
      logger.warn('[VerCommand] reenvío solicitado', { id, requestId });
    } catch (error) {
      logger.warn('[VerCommand] no se pudo solicitar el reenvío', {
        id,
        error: describeError(error),
      });
      return;
    }

    const deadline = Date.now() + VerCommand.resendTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, VerCommand.resendPollMs));
      if (hasContent(normalizeMessageContent(mediaMessageCache.get(ctx.chat.jid, id)?.message))) {
        logger.warn('[VerCommand] mensaje recuperado del teléfono', { id });
        return;
      }
    }
    logger.warn('[VerCommand] el teléfono no reenvió el mensaje', { id });
  }

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

    const quotedInfo = describeContent(quotedMsg);
    const quotedContent = normalizeMessageContent(quotedMsg);
    /** Cached content wins; the quote stub may have no media at all. */
    const lookup = () => {
      const cached = mediaMessageCache.get(ctx.chat.jid, quotedMsgId);
      const content = normalizeMessageContent(cached?.message);
      return content && hasContent(content)
        ? { content, message: cached?.message ?? quotedMsg, source: 'cache' as const }
        : { content: quotedContent, message: quotedMsg, source: 'quote' as const };
    };
    const cacheInfo = () => {
      const scoped = mediaMessageCache.recent(ctx.chat.jid);
      return {
        cachedIds: mediaMessageCache.ids(ctx.chat.jid).slice(-10),
        cacheSize: mediaMessageCache.size,
        uptimeSeconds: Math.round(process.uptime()),
        recent: scoped,
        recentAny: scoped.length > 0 ? undefined : mediaMessageCache.recent(''),
      };
    };

    await ctx.react('⏳');

    let resolved = lookup();
    let info = classify(resolved.content);

    const needsResend = () => {
      const media = mediaOf(info);
      return !info.kind || (info.kind !== 'text' && !media?.url && !media?.directPath);
    };

    // Content sent from this same account never reaches the bot, and the phone
    // does not answer the resend request for it: skip the 10 second wait.
    if (needsResend() && this.isOwnQuote(ctx)) {
      logger.warn('[VerCommand] contenido propio no disponible', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        quoted: quotedInfo,
        ...cacheInfo(),
      });
      await ctx.react('❌');
      await ctx.reply(OWN_STUB_REPLY);
      return;
    }

    // View-once may arrive as an empty "unavailable fanout" stub and Baileys
    // does not ask the phone for those, so request it here before giving up.
    if (needsResend()) {
      await this.requestResend(ctx, quotedMsgId);
      resolved = lookup();
      info = classify(resolved.content);
    }

    const cachedInfo = resolved.source === 'cache' ? describeContent(resolved.message) : undefined;

    if (!info.kind) {
      logger.warn('[VerCommand] contenido no reenviable', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        source: resolved.source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
      });
      await ctx.react('❌');
      await ctx.reply('❌ El mensaje citado no es una imagen, video, audio o texto.');
      return;
    }

    const { kind } = info;

    try {
      if (kind === 'text') {
        if (!info.text) throw new Error('NO_TEXT');
        await ctx.sock.sendMessage(ctx.chat.jid, { text: info.text });
        await ctx.react('✅');
        return;
      }

      const finalMedia = mediaOf(info);
      if (!finalMedia?.url && !finalMedia?.directPath) {
        logger.warn('[VerCommand] sin url/directPath tras el reenvío', {
          id: quotedMsgId,
          chat: ctx.chat.jid,
          kind,
          source: resolved.source,
          quoted: quotedInfo,
          cached: cachedInfo,
          ...cacheInfo(),
        });
        await ctx.react('❌');
        await ctx.reply(UNAVAILABLE_REPLY);
        return;
      }

      // Warn level: Docker runs the bot with LOG_LEVEL=warn by default.
      logger.warn('[VerCommand] reenviando', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        kind,
        source: resolved.source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
      });
      const mediaBuffer = await this.download(ctx, quotedMsgId, resolved.message);

      if (kind === 'image') {
        const caption = info.image?.caption ?? undefined;
        await ctx.sock.sendMessage(ctx.chat.jid, {
          image: mediaBuffer,
          ...(caption && { caption }),
        });
      } else if (kind === 'video') {
        const caption = info.video?.caption ?? undefined;
        await ctx.sock.sendMessage(ctx.chat.jid, {
          video: mediaBuffer,
          ...(caption && { caption }),
        });
      } else {
        await ctx.sock.sendMessage(ctx.chat.jid, {
          audio: mediaBuffer,
          mimetype: info.audio?.mimetype ?? 'audio/ogg; codecs=opus',
          ptt: Boolean(info.audio?.ptt),
        });
      }

      await ctx.react('✅');
    } catch (error) {
      logger.error('[VerCommand] fallo al reenviar', {
        id: quotedMsgId,
        chat: ctx.chat.jid,
        kind,
        source: resolved.source,
        quoted: quotedInfo,
        cached: cachedInfo,
        ...cacheInfo(),
        error: describeError(error),
      });
      await ctx.react('❌');

      const unavailable = !quotedInfo.url && !quotedInfo.directPath;
      await ctx.reply(unavailable ? UNAVAILABLE_REPLY : '❌ No se pudo reenviar el contenido.');
    }
  }
}
