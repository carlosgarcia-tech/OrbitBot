/**
 * AudioStickerSender.ts
 *
 * Sends a WhatsApp audio sticker: a future-proof wrapper (Message field 134)
 * whose StickerMessage carries an `audioMessage` (StickerMessage field 26).
 *
 * Baileys 7.0.0-rc13/rc14 does not generate either field. Instead of patching
 * node_modules, this module extends the generated encoders at runtime: the
 * fields are known wire numbers (verified against WhatsApp 2.26.41.6 and the
 * zapota implementation tested on a phone), so appending them after the known
 * fields produces the same bytes. If a future Baileys defines the fields
 * natively, the extension is skipped and the same object is encoded by it.
 *
 * @author **Carlos G**
 * @created 2026-11-24
 */

import { randomBytes } from 'crypto';
import {
  generateMessageIDV2,
  prepareWAMessageMedia,
  proto,
  type WAMessage,
  type WASocket,
} from 'baileys';
import { logError } from '@/utils/logger.js';
import { getContextInfo } from '@/utils/getContextInfo.js';
import type { AudioStickerParts } from '@/services/media/StickerService.js';

const AUDIO_STICKER_FIELD = 134;
const STICKER_AUDIO_FIELD = 26;
/** `Message.stickerMessage` uses field 26 too; nested levels keep them apart. */
const STICKER_MESSAGE_FIELD = 26;

interface ProtoWriter {
  uint32(value: number): ProtoWriter;
  fork(): ProtoWriter;
  ldelim(): ProtoWriter;
}

type Encoder = (message: Record<string, unknown>, writer?: ProtoWriter) => ProtoWriter;
type PatchableEncoder = Encoder & { __orbitAudioStickerPatched?: boolean };
type ProtoType = { encode: (message: unknown, writer: ProtoWriter) => ProtoWriter };

type Decoder = (input: unknown, length?: number, end?: number) => proto.IMessage;
type PatchableDecoder = Decoder & { __orbitAudioStickerPatched?: boolean };

interface StickerWithAudio extends proto.Message.IStickerMessage {
  audioMessage?: proto.Message.IAudioMessage | null;
}

interface MessageWithAudioSticker extends proto.IMessage {
  audioStickerMessage?: { message?: proto.IMessage | null } | null;
}

/**
 * Real WhatsApp messages exceed this Baileys' generated protos: the fields
 * below are skipped by the generated decoders, so an inbound audio sticker
 * (or a quote of one) loses its track before any command sees it.
 */
function readVarint(buf: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = start;
  let byte: number;
  do {
    byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

/** Raw values of every length-delimited `field` in an encoded message. */
function lengthDelimited(buf: Uint8Array, field: number): Uint8Array[] {
  const found: Uint8Array[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    const wire = tag & 7;
    pos = afterTag;
    if (wire === 0) {
      pos = readVarint(buf, pos)[1];
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buf, pos);
      pos = afterLength;
      if (tag >>> 3 === field) found.push(buf.subarray(pos, pos + length));
      pos += length;
    } else if (wire === 5) {
      pos += 4;
    } else {
      break; // groups do not appear in WhatsApp messages
    }
  }
  return found;
}

function decodeStickerAudio(stickerBytes: Uint8Array): proto.Message.IAudioMessage | undefined {
  const bytes = lengthDelimited(stickerBytes, STICKER_AUDIO_FIELD)[0];
  return bytes ? proto.Message.AudioMessage.decode(bytes) : undefined;
}

/** Restores field 26/134 into an already-decoded message. */
function restoreAudioSticker(message: proto.IMessage, raw: Uint8Array): void {
  const wrapped = message as MessageWithAudioSticker;
  const wrapper = lengthDelimited(raw, AUDIO_STICKER_FIELD)[0];

  if (wrapper) {
    if (wrapped.audioStickerMessage) return;
    const inner = lengthDelimited(wrapper, 1)[0];
    const stickerBytes = inner && lengthDelimited(inner, STICKER_MESSAGE_FIELD)[0];
    if (!stickerBytes) return;

    const sticker = proto.Message.StickerMessage.decode(stickerBytes) as StickerWithAudio;
    const audio = decodeStickerAudio(stickerBytes);
    if (audio) sticker.audioMessage = audio;
    wrapped.audioStickerMessage = { message: { stickerMessage: sticker } };
    return;
  }

  if (!message.stickerMessage) return;
  const stickerBytes = lengthDelimited(raw, STICKER_MESSAGE_FIELD)[0];
  const audio = stickerBytes ? decodeStickerAudio(stickerBytes) : undefined;
  if (audio) (message.stickerMessage as StickerWithAudio).audioMessage = audio;
}

/** Wraps a generated decoder, attaching what its switch skipped. */
function patchDecode(target: { decode: Decoder }): void {
  const original = target.decode as PatchableDecoder;
  if (original.__orbitAudioStickerPatched) return;

  const patched: PatchableDecoder = (input, length, end) => {
    let raw: Uint8Array | undefined;
    try {
      if (
        input &&
        typeof input === 'object' &&
        typeof (input as { pos?: unknown }).pos === 'number'
      ) {
        const reader = input as { pos: number; len: number; buf: Uint8Array };
        const stop = length === undefined ? reader.len : Math.min(reader.len, reader.pos + length);
        raw = reader.buf.subarray(reader.pos, stop);
      } else if (input instanceof Uint8Array) {
        raw = input;
      }
    } catch {
      raw = undefined;
    }

    const message = original.call(target, input, length, end);
    if (raw) {
      try {
        restoreAudioSticker(message, raw);
      } catch (error) {
        logError('[AudioStickerSender] No pude recuperar el audio del sticker', error);
      }
    }
    return message;
  };
  patched.__orbitAudioStickerPatched = true;
  target.decode = patched;
}

/** Appends a length-delimited field the generated encoder does not know. */
function patchField(
  target: { encode: Encoder },
  field: string,
  fieldNumber: number,
  type: ProtoType,
): void {
  const original = target.encode as PatchableEncoder;
  if (original.__orbitAudioStickerPatched) return;

  const patched: PatchableEncoder = (message, writer) => {
    const out = original.call(target, message, writer);
    const value = message?.[field];
    if (value) type.encode(value, out.uint32((fieldNumber << 3) | 2).fork()).ldelim();
    return out;
  };
  patched.__orbitAudioStickerPatched = true;
  target.encode = patched;
}

let patchReady = false;
let patchOk = false;

/** Extends Message and StickerMessage encoders once; idempotent. */
function installProtoPatch(): boolean {
  if (patchReady) return patchOk;
  patchReady = true;

  try {
    const messageType = proto.Message as unknown as { encode: Encoder };
    const stickerType = proto.Message.StickerMessage as unknown as { encode: Encoder };

    if (!('audioStickerMessage' in proto.Message.prototype)) {
      patchField(
        messageType,
        'audioStickerMessage',
        AUDIO_STICKER_FIELD,
        proto.Message.FutureProofMessage as unknown as ProtoType,
      );
    }
    if (!('audioMessage' in proto.Message.StickerMessage.prototype)) {
      patchField(
        stickerType,
        'audioMessage',
        STICKER_AUDIO_FIELD,
        proto.Message.AudioMessage as unknown as ProtoType,
      );
    }
    patchDecode(messageType as unknown as { decode: Decoder });
    patchOk = true;
  } catch (error) {
    logError('[AudioStickerSender] No pude extender el proto de Baileys', error);
    patchOk = false;
  }
  return patchOk;
}

/** True when the audio-sticker wire format can be encoded (native or patched). */
export function supportsAudioSticker(): boolean {
  return installProtoPatch();
}

function quotedContext(quoted?: WAMessage): proto.IContextInfo | undefined {
  if (!quoted?.key?.id) return undefined;
  const expiration = Number(getContextInfo(quoted.message)?.expiration) || 0;

  return {
    stanzaId: quoted.key.id,
    participant: quoted.key.participant ?? quoted.key.remoteJid ?? undefined,
    quotedMessage: quoted.message,
    ...(expiration > 0 && { expiration }),
  };
}

/** Uploads both media parts and relays them as one audio sticker. */
export async function sendAudioSticker(
  sock: WASocket,
  jid: string,
  parts: AudioStickerParts,
  quoted?: WAMessage,
): Promise<void> {
  if (!supportsAudioSticker()) throw new Error('AUDIO_STICKER_UNSUPPORTED');

  const [stickerMedia, audioMedia] = await Promise.all([
    prepareWAMessageMedia({ sticker: parts.sticker }, { upload: sock.waUploadToServer }),
    prepareWAMessageMedia(
      { audio: parts.audio, mimetype: 'audio/ogg; codecs=opus', ptt: false },
      { upload: sock.waUploadToServer },
    ),
  ]);

  const stickerMessage = {
    ...(stickerMedia.stickerMessage ?? {}),
    width: parts.width,
    height: parts.height,
    isAnimated: parts.isAnimated,
    isLottie: false,
    audioMessage: {
      ...(audioMedia.audioMessage ?? {}),
      ptt: true,
      seconds: parts.seconds,
      waveform: parts.waveform,
    },
    ...(quoted && { contextInfo: quotedContext(quoted) }),
  };

  const content = {
    messageContextInfo: { messageSecret: randomBytes(32) },
    audioStickerMessage: { message: { stickerMessage } },
  } as unknown as proto.IMessage;

  await sock.relayMessage(jid, content, {
    messageId: generateMessageIDV2(sock.user?.id),
    // Baileys derives "text" for this unknown top-level field; be explicit,
    // since "media" makes the phone drop the message silently.
    additionalAttributes: { type: 'text' },
  });
}

/** Plan B if the encoder extension cannot be installed: two messages. */
export async function sendAudioStickerFallback(
  sock: WASocket,
  jid: string,
  parts: AudioStickerParts,
): Promise<void> {
  await sock.sendMessage(jid, { sticker: parts.sticker });
  await sock.sendMessage(jid, {
    audio: parts.audio,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
}

// Decoding must be patched at boot: `!wm` and the media cache rely on inbound
// audio stickers carrying their track, not only when `!saudio` runs.
installProtoPatch();
