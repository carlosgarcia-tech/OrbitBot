# AUDIO_STICKERS_REPORT.md

Implementación de `!saudio` (stickers con audio) — 2026-11-24.

## 1. Formato real y por qué Baileys no lo manda

| Dato | Fuente | Estado |
|---|---|---|
| `Message.audioStickerMessage` = campo **134**, tipo `FutureProofMessage` | RE de WhatsApp Android 2.26.41.6 (`7ucg/whatsapp-docs`, `WA_STICKERS.md`) + PR de zapota probado en teléfono | confirmado |
| `StickerMessage.audioMessage` = campo **26** (nuevo `oneof audio`) | mismo RE + proto de `baron-baileys-v2` | confirmado |
| Envoltura: `audioStickerMessage.message.stickerMessage.audioMessage` | `idlanyor/zapota` PR #10 (`src/lib/audioSticker.js`) | probado en teléfono |
| `messageContextInfo.messageSecret` de 32 bytes | mismo PR | requerido por su implementación |
| Atributo de stanza `type="text"` | mismo PR | con `media` el teléfono descarta el mensaje |
| Opus: `-vbr on -compression_level 10 -frame_duration 20 -application voip -avoid_negative_ts make_zero` | mismo PR | probado en teléfono |
| `ptt: true`, `seconds`, `waveform` de 64 barras | mismo PR | probado en teléfono |

**Baileys instalado: 7.0.0-rc13** (y la última publicada, **7.0.0-rc14**) no generan los campos 134/26. `proto.Message.encode()` los descarta, así que el teléfono recibiría un mensaje vacío.

**Solución implementada (sin tocar `node_modules`):** `AudioStickerSender.ts` extiende en runtime los encoders generados de `proto.Message` y `proto.Message.StickerMessage` para escribir esos dos campos conocidos. Si una versión futura de Baileys los define de forma nativa, la extensión se omite y se usa la nativa. El resto del mensaje (subida de media, cifrado Signal, nodo `<message>`) lo sigue haciendo `sock.relayMessage`.

Referencia del byte layout: tests de `AudioStickerSender` decodifican los bytes y verifican `134 → 1 → 26 → 26`.

## 2. ffmpeg / Dockerfile

| Comprobación | Resultado |
|---|---|
| `ffmpeg` / `ffprobe` | 7.1.5 |
| `libopus` | presente |
| `libwebp` / `libwebp_anim` | presentes |
| Dockerfile | instala `ffmpeg` completo (incluye `ffprobe` y `libopus`) |

El audio se genera con entrada resampleada a 16 kHz (como la implementación probada en teléfono); el stream Opus siempre reporta 48 kHz al decodificar, que es lo esperado. Se calculan `seconds` y un `waveform` de 64 barras desde PCM 8 kHz.

## 3. Archivos

### Creados
- `src/services/media/AudioStickerSender.ts` — extensión runtime del proto + envío nativo + fallback.
- `src/commands/media/AudioStickerCommand.ts` — `!saudio` (auto-registrado por `PluginLoader`).
- `tests/services/media/StickerService.audio.test.ts`
- `tests/services/media/AudioStickerSender.test.ts`
- `tests/commands/media/AudioStickerCommand.test.ts`
- `AUDIO_STICKERS_REPORT.md`

### Modificados
- `src/services/media/StickerService.ts`: `createAudioSticker` (+ `seconds`, `waveform`, dimensiones, `isAnimated`), ffmpeg Opus compatible con el formato probado.
- `src/services/media/MediaMessageCache.ts`: cachea `audioMessage` (necesario para citar una nota de voz).
- `src/commands/media/StickerCommand.ts`: solo `export const STICKER_BRANDING`.
- `tests/services/media/MediaMessageCache.test.ts`: caso de audio.

`!sticker` no cambió de comportamiento.

## 4. Pruebas

Runner: **vitest**.

| Suite | Resultado |
|---|---|
| `StickerService.audio.test.ts` (ffmpeg real) | **11/11** |
| `AudioStickerSender.test.ts` (incluye bytes 134/26) | **6/6** |
| `AudioStickerCommand.test.ts` | **8/8** |
| `MediaMessageCache.test.ts` | **4/4** |
| `tsc --noEmit` | sin errores |
| ESLint/Prettier de los archivos tocados | limpios |

Cubierto:
- video con audio → webp animado + opus + `seconds`/`waveform`; video mudo → `NO_AUDIO`.
- un clip de 25 s conserva >20 s de animación (no se corta a 10 s) si cabe en el presupuesto.
- imagen sola → `NO_AUDIO`; imagen + audio → sticker estático.
- video mudo + mp3 → OK; audio de 65 s recortado a ≤60 s; `maxSeconds: 5`.
- audio basura → error sin temporales; sticker+audio < 1 MB.
- sin archivos `as-*` huérfanos tras éxito o error.
- envío: una sola llamada a `relayMessage`, `messageSecret` de 32 bytes, `type="text"`, contexto citado y `expiration` de chats temporales.
- fallback: sticker y luego nota de voz; propaga errores.

Pendiente de verificación en teléfono (no lo puede hacer el agente): que WhatsApp renderice y reproduzca el mensaje nativo. La estructura y los flags vienen de una implementación probada en dispositivo, pero este bot no se conectó a WhatsApp.

Suite completa: **1297 pasan, 1 falla**. El fallo es ajeno a este cambio (`TTSService.test.ts`, por el WIP sin commitear de `TTSCommand.ts`); `tsc`, ESLint y Prettier de los archivos tocados están limpios.

## 5. Desviaciones del documento original

1. **Envío nativo implementado**: el documento preveía solo fallback si Baileys no soportaba el formato. El humano pidió buscar alternativas y crear una instancia propia; se hizo extendiendo el proto en runtime, sin parchear `node_modules` ni cambiar la dependencia.
2. **Formato**: se usó el layout real verificado (134/26, `messageSecret`, `type="text"`, `ptt`, `seconds`, `waveform`, 16 kHz + `voip`) en vez de la hipótesis inicial.
3. **`MediaMessageCache`** se amplió a audio, imprescindible para el flujo B.
4. **Sin worktree ni commits**: el repo está en `main` con WIP sin commitear (`StickerService.ts`, `TTSCommand.ts`, `deploy.sh`); se trabajó en sitio para no perderlo.
5. **`.wasticker`**: no se implementó. El envío nativo ya no lo necesita; empaquetar WebP+AAC en ZIP no era el mecanismo real (el formato real usa el proto, no un ZIP).

## 6. Riesgos y pruebas en teléfono

1. **Render/reproducción nativa:** probar `!saudio` respondiendo a un video con audio; si se ve pero no suena, revisar flags Opus y `type="text"`.
2. **Flujo B:** foto/video con caption `!saudio` respondiendo a una nota de voz.
3. **Chats temporales:** confirmar que el `expiration` copiado al `contextInfo` del sticker es suficiente (Baileys no inyecta ephemeral en `relayMessage`).
4. **Grupo y privado.**
5. **Duración del audio y del visual:** el límite es 60 s (`AUDIO_STICKER_MAX_SECONDS`). El editor nativo corta a 10 s (5 s en animados), pero el formato acepta más: la implementación de referencia reprodujo 24 s completos en un teléfono. El sticker animado intenta durar lo mismo que el audio; si no cabe en el 1 MB total, baja la calidad (nunca por debajo de 12 fps para que no se vea entrecortado) y, como último recurso, acorta el clip a ~10 s y WhatsApp lo repite en bucle.
6. **Respuesta a un audio sticker ya enviado:** el proto de Baileys no decodifica el campo 134, así que el mensaje entrante se ve vacío. El bot no crashea (no usa `getContentType`), pero no podrá citarlo como sticker. Si se quiere soportar, hay que extender también `decode` y `getContextInfo`.
7. **Cache de audio:** responder a una nota de voz de más de 300 mensajes de antigüedad fallará al descargar (límite de `MediaMessageCache`).

## 7. Rulings

- **Extender el proto en runtime, no parchear `node_modules`** — mismo resultado de bytes, sin `patch-package` ni fork; se desactiva solo si Baileys ya trae los campos. Coste si falla: el comando cae al fallback de dos mensajes.
- **Añadir audio a `MediaMessageCache`** — sin ello el flujo B no descarga. Coste: algo más de memoria (máx. 300 entradas).
- **Trabajar en `main` en sitio, sin commits** — había WIP sin commitear. Coste: cambios sin rama ni historial propio.
- **No implementar `.wasticker`** — el formato real es el proto, no un ZIP. Coste: ninguna función perdida.
