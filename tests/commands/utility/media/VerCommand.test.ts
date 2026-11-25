/**
 * VerCommand.test.ts
 *
 * `!ver` used to always download quoted content as an `imageMessage` (so
 * videos failed) and knew nothing about view-once wrappers. These tests pin
 * the re-send of video, view-once image/audio (from the cached original) and
 * view-once text.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { downloadMediaMessage } from 'baileys';
import { VerCommand } from '@/commands/utility/media/VerCommand.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import type { MessageContext } from '@/types/index.js';

vi.mock('baileys', async importOriginal => {
  const actual = await importOriginal<typeof import('baileys')>();
  return { ...actual, downloadMediaMessage: vi.fn() };
});

vi.mock('@/services/media/MediaMessageCache.js', () => ({
  mediaMessageCache: { get: vi.fn() },
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
    sock: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MessageContext;

const sent = (ctx: MessageContext) =>
  (ctx.sock.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];

describe('VerCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCache.mockReturnValue(undefined);
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

  it('asks for a quoted message when there is none', async () => {
    const ctx = createCtx(undefined, undefined);

    await new VerCommand().execute(ctx);

    expect(ctx.sock.sendMessage).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('responder');
  });
});
