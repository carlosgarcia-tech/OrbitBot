/**
 * AudioStickerCommand.test.ts
 *
 * Pins the two supported flows (`!saudio` on a quoted video, and a direct
 * image/video replying to a voice note), the instruction reply for everything
 * else, and the fallback path used while Baileys lacks the native format.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAudioSticker: vi.fn(),
  addExif: vi.fn(),
  supports: vi.fn(),
  sendNative: vi.fn(),
  sendFallback: vi.fn(),
  download: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('baileys', () => ({ downloadMediaMessage: mocks.download }));

vi.mock('@/utils/logger.js', () => ({
  logError: vi.fn(),
  logger: { warn: mocks.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/services/media/StickerService.js', () => ({
  StickerService: class {
    createAudioSticker = mocks.createAudioSticker;
    addExif = mocks.addExif;
  },
}));

vi.mock('@/services/media/AudioStickerSender.js', () => ({
  supportsAudioSticker: mocks.supports,
  sendAudioSticker: mocks.sendNative,
  sendAudioStickerFallback: mocks.sendFallback,
}));

import { AudioStickerCommand } from '@/commands/media/AudioStickerCommand.js';
import { STICKER_BRANDING } from '@/commands/media/StickerCommand.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import type { MessageContext } from '@/types/index.js';

const VISUAL = Buffer.from('visual');
const AUDIO = Buffer.from('audio');
const EXIF_STICKER = Buffer.from('exif-sticker');

const createCtx = (overrides: Partial<Record<string, unknown>> = {}): MessageContext =>
  ({
    message: {
      key: { id: 'm1', remoteJid: 'chat@g.us', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    },
    quoted: undefined,
    quotedMessageId: undefined,
    quotedParticipant: undefined,
    chat: { jid: 'chat@g.us', isGroup: true },
    sock: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as MessageContext;

/** Flow A: `!saudio` replying to a video (audio comes from the video). */
const quotedVideoCtx = (overrides: Partial<Record<string, unknown>> = {}): MessageContext =>
  createCtx({
    message: {
      key: { id: 'm1', remoteJid: 'chat@g.us', fromMe: false },
      message: { extendedTextMessage: { text: '!saudio' } },
    },
    quoted: { videoMessage: { mimetype: 'video/mp4' } },
    quotedMessageId: 'Q1',
    quotedParticipant: 'x@s.whatsapp.net',
    ...overrides,
  });

describe('AudioStickerCommand', () => {
  let command: AudioStickerCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    mediaMessageCache.clear();
    command = new AudioStickerCommand();

    mocks.createAudioSticker.mockResolvedValue({ sticker: Buffer.from('raw'), audio: AUDIO });
    mocks.addExif.mockResolvedValue(EXIF_STICKER);
    mocks.supports.mockReturnValue(true);
    mocks.download.mockImplementation(async (msg: { message?: Record<string, unknown> }) =>
      msg.message?.audioMessage ? AUDIO : VISUAL,
    );
  });

  it('explains the two flows when there is no visual media', async () => {
    const ctx = createCtx({
      message: {
        key: { id: 'm1', remoteJid: 'chat@g.us' },
        message: { extendedTextMessage: { text: '!saudio' } },
      },
    });

    await command.execute(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('responde a un *video'));
    expect(ctx.react).not.toHaveBeenCalled();
    expect(mocks.createAudioSticker).not.toHaveBeenCalled();
  });

  it('takes both visual and audio from a quoted video', async () => {
    const ctx = createCtx({
      message: {
        key: { id: 'm1', remoteJid: 'chat@g.us' },
        message: { extendedTextMessage: { text: '!saudio' } },
      },
      quoted: { videoMessage: { mimetype: 'video/mp4' } },
      quotedMessageId: 'Q1',
      quotedParticipant: 'x@s.whatsapp.net',
    });

    await command.execute(ctx);

    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.createAudioSticker).toHaveBeenCalledWith(
      expect.objectContaining({ visual: VISUAL, audio: undefined }),
    );
  });

  it('combines a direct image with a quoted voice note', async () => {
    const audioOriginal = {
      key: { id: 'Q-AUD', remoteJid: 'chat@g.us', fromMe: false },
      message: { audioMessage: { url: 'https://mmg.whatsapp.net/a', mediaKey: Buffer.from('k') } },
    };
    mediaMessageCache.put(audioOriginal as never);

    const ctx = createCtx({
      quoted: { audioMessage: { mimetype: 'audio/ogg' } },
      quotedMessageId: 'Q-AUD',
      quotedParticipant: 'x@s.whatsapp.net',
    });

    await command.execute(ctx);

    expect(mocks.download.mock.calls[0]?.[0]).toBe(ctx.message);
    expect(mocks.download.mock.calls[1]?.[0]).toBe(audioOriginal);
    expect(mocks.createAudioSticker).toHaveBeenCalledWith({ visual: VISUAL, audio: AUDIO });
  });

  it('asks for instructions when the quoted message is not audio', async () => {
    const ctx = createCtx({
      quoted: { extendedTextMessage: { text: 'hola' } },
      quotedMessageId: 'Q2',
    });

    await command.execute(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('responde a un *video'));
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('tells the user when the source has no audio', async () => {
    mocks.createAudioSticker.mockRejectedValue(new Error('NO_AUDIO'));
    const ctx = quotedVideoCtx();

    await command.execute(ctx);

    expect(ctx.react).toHaveBeenCalledWith('❌');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('no tiene audio'));
  });

  it('tells the user when the result is too heavy', async () => {
    mocks.createAudioSticker.mockRejectedValue(new Error('AUDIO_STICKER_TOO_BIG'));
    const ctx = quotedVideoCtx();

    await command.execute(ctx);

    expect(ctx.react).toHaveBeenCalledWith('❌');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('muy pesado'));
  });

  it('falls back and warns when Baileys lacks native support', async () => {
    mocks.supports.mockReturnValue(false);
    const ctx = quotedVideoCtx();

    await command.execute(ctx);

    expect(mocks.sendFallback).toHaveBeenCalledTimes(1);
    expect(mocks.sendNative).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('reacts pending then success and brands only the sticker', async () => {
    const ctx = quotedVideoCtx();

    await command.execute(ctx);

    expect(ctx.react).toHaveBeenNthCalledWith(1, '⏳');
    expect(ctx.react).toHaveBeenNthCalledWith(2, '✅');
    expect(mocks.addExif).toHaveBeenCalledWith(
      Buffer.from('raw'),
      STICKER_BRANDING.packname,
      STICKER_BRANDING.author,
    );

    const parts = mocks.sendNative.mock.calls[0]?.[2] as { sticker: Buffer; audio: Buffer };
    expect(parts.sticker).toBe(EXIF_STICKER);
    expect(parts.audio).toBe(AUDIO);
  });
});
