/**
 * AudioStickerSender.test.ts
 *
 * Baileys 7.0.0-rc13/rc14 has no `audioStickerMessage` field and no
 * `StickerMessage.audioMessage`, so this sender extends the generated
 * encoders at runtime. These tests pin the resulting wire bytes (field 134 →
 * FutureProof → field 26 sticker → field 26 audio) against the layout that
 * was verified on a phone, plus the fallback path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { proto, type WAMessage } from 'baileys';
import {
  sendAudioSticker,
  sendAudioStickerFallback,
  supportsAudioSticker,
} from '@/services/media/AudioStickerSender.js';

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock('baileys', async importOriginal => {
  const actual = await importOriginal<typeof import('baileys')>();
  return { ...actual, prepareWAMessageMedia: mocks.prepare };
});

const parts = {
  sticker: Buffer.from('webp'),
  audio: Buffer.from('ogg'),
  seconds: 3,
  waveform: Buffer.alloc(64, 10),
  width: 512,
  height: 512,
  isAnimated: false,
};

function fakeSock() {
  return {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    relayMessage: vi.fn().mockResolvedValue(undefined),
    waUploadToServer: vi.fn(),
  } as never;
}

/** Reads one varint, returning the value and the next offset. */
function readVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buffer[offset++];
    value |= (byte & 127) << shift;
    shift += 7;
  } while (byte & 128);
  return [value >>> 0, offset];
}

/** First length-delimited field with the given number, or undefined. */
function findField(buffer: Buffer, fieldNumber: number): Buffer | undefined {
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset);
    offset = afterTag;
    const wire = tag & 7;

    if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      const value = buffer.subarray(afterLength, afterLength + length);
      if (tag >>> 3 === fieldNumber) return value;
      offset = afterLength + length;
    } else if (wire === 0) {
      offset = readVarint(buffer, offset)[1];
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return undefined;
}

describe('AudioStickerSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockImplementation(async (content: { sticker?: Buffer }) =>
      content.sticker
        ? { stickerMessage: { mimetype: 'image/webp', url: 'sticker-url' } }
        : { audioMessage: { mimetype: 'audio/ogg; codecs=opus', url: 'audio-url' } },
    );
  });

  it('extends the encoders once and reports native-capable support', () => {
    expect(supportsAudioSticker()).toBe(true);
    expect(supportsAudioSticker()).toBe(true);
  });

  it('relays one message with the sticker audio and a message secret', async () => {
    const sock = fakeSock();

    await sendAudioSticker(sock, 'chat@g.us', parts);

    const relay = (sock as never as { relayMessage: ReturnType<typeof vi.fn> }).relayMessage;
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(relay).toHaveBeenCalledTimes(1);

    const [jid, content, options] = relay.mock.calls[0];
    expect(jid).toBe('chat@g.us');
    expect(options).toMatchObject({
      messageId: expect.any(String),
      additionalAttributes: { type: 'text' },
    });
    expect(
      (content as { messageContextInfo: { messageSecret: Buffer } }).messageContextInfo
        .messageSecret,
    ).toHaveLength(32);

    const sticker = (
      content as {
        audioStickerMessage: {
          message: { stickerMessage: Record<string, unknown> };
        };
      }
    ).audioStickerMessage.message.stickerMessage;
    expect(sticker).toMatchObject({
      url: 'sticker-url',
      width: 512,
      height: 512,
      isAnimated: false,
      isLottie: false,
      audioMessage: {
        url: 'audio-url',
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: 3,
        waveform: parts.waveform,
      },
    });
  });

  it('encodes field 134 → field 26 sticker → field 26 audio on the wire', async () => {
    const sock = fakeSock();
    await sendAudioSticker(sock, 'chat@g.us', parts);

    const content = (sock as never as { relayMessage: ReturnType<typeof vi.fn> }).relayMessage.mock
      .calls[0][1] as proto.IMessage;
    const bytes = proto.Message.encode(content).finish();

    const futureProof = findField(bytes, 134);
    expect(futureProof).toBeDefined();

    const innerMessage = findField(futureProof as Buffer, 1);
    expect(innerMessage).toBeDefined();

    const stickerBytes = findField(innerMessage as Buffer, 26);
    expect(stickerBytes).toBeDefined();

    const audioBytes = findField(stickerBytes as Buffer, 26);
    expect(audioBytes).toBeDefined();

    const audio = proto.Message.AudioMessage.decode(audioBytes as Buffer);
    expect(audio.url).toBe('audio-url');
    expect(audio.mimetype).toBe('audio/ogg; codecs=opus');
    expect(audio.ptt).toBe(true);
    expect(audio.seconds).toBe(3);
  });

  it('quotes the triggering message and copies its disappearing timer', async () => {
    const quoted = {
      key: { id: 'Q1', remoteJid: 'chat@g.us', participant: 'x@s.whatsapp.net' },
      message: { imageMessage: { contextInfo: { expiration: 86400 } } },
    } as WAMessage;
    const sock = fakeSock();

    await sendAudioSticker(sock, 'chat@g.us', parts, quoted);

    const content = (sock as never as { relayMessage: ReturnType<typeof vi.fn> }).relayMessage.mock
      .calls[0][1] as {
      audioStickerMessage: { message: { stickerMessage: { contextInfo: unknown } } };
    };
    expect(content.audioStickerMessage.message.stickerMessage.contextInfo).toEqual({
      stanzaId: 'Q1',
      participant: 'x@s.whatsapp.net',
      quotedMessage: quoted.message,
      expiration: 86400,
    });
  });

  it('fallback sends the sticker first and then the voice note', async () => {
    const sock = fakeSock();

    await sendAudioStickerFallback(sock, 'chat@g.us', parts);

    const sendMessage = (sock as never as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage;
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]).toEqual(['chat@g.us', { sticker: parts.sticker }]);
    expect(sendMessage.mock.calls[1]).toEqual([
      'chat@g.us',
      { audio: parts.audio, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    ]);
  });

  it('fallback propagates send failures so the command can react', async () => {
    const sock = fakeSock();
    (sock as never as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mockRejectedValueOnce(
      new Error('upload failed'),
    );

    await expect(sendAudioStickerFallback(sock, 'chat@g.us', parts)).rejects.toThrow(
      'upload failed',
    );
  });

  it('decodes the audio track back out of the wire format', async () => {
    const sock = fakeSock();
    await sendAudioSticker(sock, 'chat@g.us', parts);
    const content = (sock as never as { relayMessage: ReturnType<typeof vi.fn> }).relayMessage.mock
      .calls[0][1] as proto.IMessage;

    const decoded = proto.Message.decode(proto.Message.encode(content).finish()) as {
      audioStickerMessage?: {
        message?: { stickerMessage?: { audioMessage?: { url?: string; seconds?: number } } };
      };
    };

    const sticker = decoded.audioStickerMessage?.message?.stickerMessage;
    expect(sticker?.audioMessage?.url).toBe('audio-url');
    expect(sticker?.audioMessage?.seconds).toBe(3);
  });

  it('decodes the audio track of a direct sticker message', () => {
    const content = {
      stickerMessage: {
        url: 'sticker-url',
        width: 512,
        height: 512,
        audioMessage: {
          url: 'audio-url',
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          seconds: 4,
        },
      },
    } as unknown as proto.IMessage;

    const decoded = proto.Message.decode(proto.Message.encode(content).finish()) as {
      stickerMessage?: { audioMessage?: { url?: string; seconds?: number } };
    };

    expect(decoded.stickerMessage?.audioMessage?.url).toBe('audio-url');
    expect(decoded.stickerMessage?.audioMessage?.seconds).toBe(4);
  });
});
