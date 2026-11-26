/**
 * VerCommand.test.ts
 *
 * `!ver` used to always download quoted content as an `imageMessage` (so
 * videos failed) and knew nothing about view-once wrappers. These tests pin
 * the re-send of video, view-once image/audio (from the cached original),
 * view-once text and the placeholder-resend recovery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { downloadMediaMessage } from 'baileys';
import { VerCommand } from '@/commands/utility/media/VerCommand.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import { logger } from '@/utils/logger.js';
import type { MessageContext } from '@/types/index.js';

vi.mock('baileys', async importOriginal => {
  const actual = await importOriginal<typeof import('baileys')>();
  return { ...actual, downloadMediaMessage: vi.fn() };
});

vi.mock('@/services/media/MediaMessageCache.js', () => ({
  mediaMessageCache: {
    get: vi.fn(),
    ids: vi.fn().mockReturnValue([]),
    recent: vi.fn().mockReturnValue([]),
    size: 0,
  },
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockedDownload = downloadMediaMessage as ReturnType<typeof vi.fn>;
const mockedCache = mediaMessageCache.get as ReturnType<typeof vi.fn>;

const createCtx = (quoted: unknown, quotedMessageId = 'quoted1'): MessageContext =>
  ({
    message: { key: { id: 'reply1', remoteJid: 'chat@g.us', fromMe: false } },
    quoted,
    quotedMessageId,
    quotedParticipant: 'sender@s.whatsapp.net',
    chat: { jid: 'chat@g.us', isGroup: true },
    sock: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      requestPlaceholderResend: vi.fn().mockResolvedValue(undefined),
      user: { id: '5219514639799:51@s.whatsapp.net', lid: '59666323251336:51@lid' },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MessageContext;

const sent = (ctx: MessageContext) =>
  (ctx.sock.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];

const resendRequested = (ctx: MessageContext) =>
  (ctx.sock.requestPlaceholderResend as ReturnType<typeof vi.fn>).mock.calls;

describe('VerCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    VerCommand.resendTimeoutMs = 0;
    VerCommand.resendPollMs = 1;
    mockedCache.mockReturnValue(undefined);
    (mediaMessageCache.recent as ReturnType<typeof vi.fn>).mockReturnValue([]);
    mockedDownload.mockResolvedValue(Buffer.from('media'));
  });

  it('re-sends a quoted video as a video', async () => {
    const ctx = createCtx({ videoMessage: { url: 'video-url', caption: 'clip' } });

    await new VerCommand().execute(ctx);

    expect(sent(ctx)).toEqual(['chat@g.us', { video: Buffer.from('media'), caption: 'clip' }]);
  });

  it('re-sends a view-once image from the cached original', async () => {
    mockedCache.mockReturnValue({
      key: { id: 'quoted1', remoteJid: 'chat@g.us' },
      message: { viewOnceMessageV2: { message: { imageMessage: { url: 'image-url' } } } },
    });
    const ctx = createCtx({ viewOnceMessageV2: { message: { imageMessage: {} } } });

    await new VerCommand().execute(ctx);

    expect(sent(ctx)).toEqual(['chat@g.us', { image: Buffer.from('media') }]);
  });

  it('re-sends a view-once video cached with only a directPath', async () => {
    mockedCache.mockReturnValue({
      key: { id: 'quoted1', remoteJid: 'chat@g.us' },
      message: {
        viewOnceMessageV2: {
          message: { videoMessage: { directPath: '/v/t62.7118-24', mediaKey: Buffer.from('k') } },
        },
      },
    });
    const ctx = createCtx({ viewOnceMessageV2: { message: { videoMessage: {} } } });

    await new VerCommand().execute(ctx);

    expect(sent(ctx)).toEqual(['chat@g.us', { video: Buffer.from('media') }]);
  });

  it('re-sends a view-once voice note', async () => {
    mockedCache.mockReturnValue({
      key: { id: 'quoted1', remoteJid: 'chat@g.us' },
      message: {
        viewOnceMessageV2: {
          message: {
            audioMessage: { url: 'audio-url', mimetype: 'audio/ogg; codecs=opus', ptt: true },
          },
        },
      },
    });
    const ctx = createCtx({ viewOnceMessageV2: { message: { audioMessage: {} } } });

    await new VerCommand().execute(ctx);

    expect(sent(ctx)).toEqual([
      'chat@g.us',
      { audio: Buffer.from('media'), mimetype: 'audio/ogg; codecs=opus', ptt: true },
    ]);
  });

  it('re-sends view-once text without downloading anything', async () => {
    const ctx = createCtx({
      viewOnceMessageV2Extension: { message: { extendedTextMessage: { text: 'secreto' } } },
    });

    await new VerCommand().execute(ctx);

    expect(sent(ctx)).toEqual(['chat@g.us', { text: 'secreto' }]);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('asks the phone to resend an empty stub and re-sends the recovered video', async () => {
    const cached = {
      key: { id: 'quoted1', remoteJid: 'chat@g.us' },
      message: { videoMessage: { url: 'video-url' } },
    };
    const ctx = createCtx({ videoMessage: {} });
    (ctx.sock.requestPlaceholderResend as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      mockedCache.mockReturnValue(cached);
      return 'req1';
    });

    await new VerCommand().execute(ctx);

    expect(resendRequested(ctx)).toEqual([
      [
        {
          remoteJid: 'chat@g.us',
          id: 'quoted1',
          fromMe: false,
          participant: 'sender@s.whatsapp.net',
        },
      ],
    ]);
    expect(sent(ctx)).toEqual(['chat@g.us', { video: Buffer.from('media') }]);
  });

  it('replies that the content is unavailable when the phone does not resend', async () => {
    const ctx = createCtx({ videoMessage: {} });

    await new VerCommand().execute(ctx);

    expect(resendRequested(ctx)).toHaveLength(1);
    expect(sent(ctx)).toBeUndefined();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('caché');
  });

  it('does not ask for a resend when the stub was sent by this same account', async () => {
    const ctx = createCtx({ videoMessage: {} });
    (ctx as unknown as { quotedParticipant: string }).quotedParticipant = '59666323251336@lid';

    await new VerCommand().execute(ctx);

    expect(resendRequested(ctx)).toHaveLength(0);
    expect(sent(ctx)).toBeUndefined();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('mismo número');
  });

  it('does not ask for a resend when WhatsApp marks the message as view-once', async () => {
    (mediaMessageCache.recent as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'quoted1', isViewOnce: true },
    ]);
    const ctx = createCtx({ videoMessage: {} });

    await new VerCommand().execute(ctx);

    expect(resendRequested(ctx)).toHaveLength(0);
    expect(sent(ctx)).toBeUndefined();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'dispositivos vinculados',
    );
  });

  it('logs the full failure detail when the download throws', async () => {
    mockedDownload.mockRejectedValue(
      Object.assign(new Error('No valid media URL or directPath present in message'), {
        statusCode: 400,
      }),
    );
    const ctx = createCtx({ videoMessage: { url: 'video-url', mediaKey: Buffer.from('k') } });

    await new VerCommand().execute(ctx);

    expect(resendRequested(ctx)).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      '[VerCommand] fallo al reenviar',
      expect.objectContaining({
        id: 'quoted1',
        kind: 'video',
        source: 'quote',
        cached: undefined,
        error: expect.objectContaining({
          message: 'No valid media URL or directPath present in message',
          status: 400,
        }),
      }),
    );
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'No se pudo reenviar',
    );
  });

  it('asks for a quoted message when there is none', async () => {
    const ctx = createCtx(undefined, undefined);

    await new VerCommand().execute(ctx);

    expect(ctx.sock.sendMessage).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('responder');
  });
});
