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

interface ProtoWriter {
  uint32(value: number): ProtoWriter;
  fork(): ProtoWriter;
  ldelim(): ProtoWriter;
}

type Encoder = (message: Record<string, unknown>, writer?: ProtoWriter) => ProtoWriter;
type PatchableEncoder = Encoder & { __orbitAudioStickerPatched?: boolean };
type ProtoType = { encode: (message: unknown, writer: ProtoWriter) => ProtoWriter };

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
