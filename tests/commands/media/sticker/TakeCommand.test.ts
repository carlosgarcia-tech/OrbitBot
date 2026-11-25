/**
 * TakeCommand.test.ts
 *
 * `!wm` must keep an audio sticker's track instead of degrading it to a plain
 * sticker. The quoted stub has no CDN url, so the original message cached at
 * reception is the source of the sticker and its audio.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { downloadMediaMessage } from 'baileys';
import { TakeCommand } from '@/commands/media/sticker/TakeCommand.js';
import { mediaMessageCache } from '@/services/media/MediaMessageCache.js';
import {
  sendAudioSticker,
  sendAudioStickerFallback,
  supportsAudioSticker,
} from '@/services/media/AudioStickerSender.js';
import type { MessageContext } from '@/types/index.js';

vi.mock('baileys', () => ({ downloadMediaMessage: vi.fn() }));

vi.mock('@/services/media/StickerService.js', () => ({
  StickerService: class {
    async addExif(buffer: Buffer) {
      return Buffer.concat([buffer, Buffer.from('-exif')]);
    }
  },
}));

vi.mock('@/services/media/MediaMessageCache.js', () => ({
  mediaMessageCache: { get: vi.fn() },
}));

vi.mock('@/services/media/AudioStickerSender.js', () => ({
  supportsAudioSticker: vi.fn(() => true),
  sendAudioSticker: vi.fn().mockResolvedValue(undefined),
  sendAudioStickerFallback: vi.fn().mockResolvedValue(undefined),
}));

const mockedDownload = downloadMediaMessage as ReturnType<typeof vi.fn>;
const mockedCache = mediaMessageCache.get as ReturnType<typeof vi.fn>;
const mockedSendAudio = sendAudioSticker as ReturnType<typeof vi.fn>;

const WAVEFORM = Buffer.alloc(64, 7);

const createCtx = (quoted: unknown): MessageContext =>
  ({
    message: { key: { id: 'reply1', remoteJid: 'chat@g.us', fromMe: false } },
    quoted,
    quotedMessageId: 'sticker1',
    quotedParticipant: 'sender@s.whatsapp.net',
    args: ['Nuevo', 'pack'],
    chat: { jid: 'chat@g.us', isGroup: true },
    sock: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MessageContext;

const cachedAudioSticker = (audio = true) => ({
  key: { id: 'sticker1', remoteJid: 'chat@g.us' },
  message: {
    audioStickerMessage: {
      message: {
        stickerMessage: {
          url: 'https://sticker',
          width: 512,
          height: 512,
          isAnimated: false,
          ...(audio && {
            audioMessage: {
              url: 'https://audio',
              seconds: 5,
              waveform: WAVEFORM,
              mimetype: 'audio/ogg; codecs=opus',
            },
          }),
        },
      },
    },
  },
});

describe('TakeCommand audio stickers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCache.mockReturnValue(cachedAudioSticker());
    mockedDownload.mockImplementation(async (message: { message: Record<string, unknown> }) =>
      message.message.stickerMessage ? Buffer.from('webp') : Buffer.from('ogg'),
    );
  });

  it('re-sends an audio sticker with its track and metadata', async () => {
    const ctx = createCtx({ stickerMessage: { width: 512, height: 512 } });

    await new TakeCommand().execute(ctx);

    expect(supportsAudioSticker).toHaveBeenCalled();
    expect(mockedSendAudio).toHaveBeenCalledTimes(1);
    const [, jid, parts] = mockedSendAudio.mock.calls[0];
    expect(jid).toBe('chat@g.us');
    expect(parts).toMatchObject({
      sticker: Buffer.concat([Buffer.from('webp'), Buffer.from('-exif')]),
      audio: Buffer.from('ogg'),
      seconds: 5,
      width: 512,
      height: 512,
      isAnimated: false,
    });
    expect(parts.waveform).toEqual(WAVEFORM);
    expect(sendAudioStickerFallback).not.toHaveBeenCalled();
  });

  it('still sends a plain sticker when the original has no audio', async () => {
    mockedCache.mockReturnValue(cachedAudioSticker(false));
    const ctx = createCtx({ stickerMessage: { width: 512, height: 512 } });

    await new TakeCommand().execute(ctx);

    expect(mockedSendAudio).not.toHaveBeenCalled();
    expect(ctx.sock.sendMessage).toHaveBeenCalledWith('chat@g.us', {
      sticker: Buffer.concat([Buffer.from('webp'), Buffer.from('-exif')]),
    });
  });
});
