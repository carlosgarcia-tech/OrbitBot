# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [8.2.10] - 2026-11-25

### Changed

- `!ver` now states the real limitation for incoming view-once content: WhatsApp does not deliver it to linked devices (the bot only gets an `<unavailable type="view_once">` marker), and WA Web skips the resend for those by design. The reply no longer blames opening it on the phone, and the description no longer promises view-once support.

## [8.2.9] - 2026-11-25

### Changed

- Clarified the `!ver` reply for an already-unavailable view-once: it asks to use the command without opening the content on the phone next time.

## [8.2.8] - 2026-11-25

### Fixed

- `!ver` no longer waits ten seconds for a resend when WhatsApp already marked the quoted view-once as unavailable (`<unavailable type="view_once">`, recorded as `isViewOnce`). It now replies immediately saying the content never reached the bot.

### Added

- Recent inbound messages in the media-cache diagnostics also include `isViewOnce` and the sender `participant`.

## [8.2.7] - 2026-11-25

### Fixed

- `!ver` no longer waits ten seconds for a resend when the quoted stub was sent by the bot's own account. WhatsApp never delivers view-once content to other linked devices of the sender and their phone does not answer the request, so it fails immediately with an explanation.

## [8.2.6] - 2026-11-25

### Fixed

- `!ver` now requests a placeholder resend from the phone when the quoted message only arrived as an empty stub (`view_once_unavailable_fanout`) and polls the media cache for up to 10 seconds before reporting it as unavailable. Baileys deliberately skips its automatic resend request for that placeholder type, so view-once content never reached the cache.

### Added

- Recent inbound messages in the media-cache diagnostics also include `fromMe`, the stub type and its parameters.

## [8.2.5] - 2026-11-25

### Fixed

- `!ver` and media-cache diagnostics used `info`, but Docker starts the bot child with `LOG_LEVEL=warn`, so none of them reached `docker logs`. They are now warnings.

### Added

- The media cache remembers the last 20 inbound messages per process (id, keys, view-once flag). A `!ver` failure includes the recent ids for the chat, so it is visible whether the quoted message ever reached the bot at all.

## [8.2.4] - 2026-11-25

### Changed

- `!ver` failure logs now include `cacheSize` and `uptimeSeconds`, so an empty `cachedIds` can be traced to a bot restart instead of a lookup bug.
- The "original not in cache" reply now says exactly that and asks for a fresh view-once with the bot already running, instead of implying a download error.

## [8.2.3] - 2026-11-25

### Fixed

- The buffered logger passed `(message, meta)` straight to pino, which only reads fields from its first argument: every `logger.info/warn/error('text', { ... })` call was silently dropping its metadata. This is why `!ver` kept logging only `[VerCommand] fallo al reenviar` with no detail. Meta is now merged into one object and a bare `Error` is flattened (`name`, `message`, `stack`).

### Added

- `!ver` failures now include the ids of the messages cached for the chat (`cachedIds`), so a cache miss caused by an id/JID mismatch is visible.
- The media cache logs each view-once message it stores, with the inner keys and whether it carries `url`/`directPath`, to confirm the original ever reached the cache.

## [8.2.2] - 2026-11-25

### Added

- `!ver` now logs a structured diagnostic when it fails: cache hit/miss, which wrapper and inner keys arrived, whether the media carries `url`/`directPath`/`mediaKey`/`fileLength`, and the error's message, status and stack. Pino dropped the previous bare `Error` argument, which is why production only showed `[VerCommand] Error:`.

### Changed

- When the quoted stub has no `url`/`directPath` and the original is no longer cached, `!ver` explains that instead of a generic failure.

## [8.2.1] - 2026-11-25

### Fixed

- `!ver` rejected view-once videos whose cached copy had no CDN `url` (only `directPath`, which Baileys can still download). It now classifies by the media field itself and hands the whole original message — wrapper included — to `downloadMediaMessage`.
- The quoted-media cache also resolves by message id when the chat is addressed with another JID form (PN ↔ LID), which made view-once lookups miss.

## [8.2.0] - 2026-11-25

### Added

- `!ver` (`!img`, `!reenviar`) re-sends images, videos, voice notes/audio and text, including view-once content (`viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`).
- The quoted-media cache now stores view-once and disappearing-message envelopes, so their CDN url survives and the content can be re-sent.

### Fixed

- `!ver` always downloaded quoted content as an `imageMessage`, so quoted videos failed with a download error. It now picks the real media type and the original cached message instead of the url-less quote stub.

## [8.1.0] - 2026-11-25

### Added

- `!wm` / `!take` keeps audio stickers' sound: the renamed sticker is re-sent as an audio sticker with its original track, duration, waveform and dimensions (with the two-message fallback when the native relay fails).

### Fixed

- Baileys' generated protos drop the audio-sticker fields (26 inside `StickerMessage`, 134 wrapping it), so inbound audio stickers and replies quoting them lost their track before any command ran. The decoders now restore both fields, and the quoted-media cache recognises the wrapper.

## [8.0.1] - 2026-11-25

### Changed

- Sticker pack metadata is now minimal: title `ᴏʀʙɪᴛʙᴏᴛ` and publisher line `ʙʏ ᴄᴀʀʟᴏꜱ ɢ`, replacing the long multi-line branding.

## [8.0.0] - 2026-11-25

### Changed

- Project renamed to **OrbitBot**. Repository links, CI badge, package metadata, install scripts and the published Docker image (`ghcr.io/carlosgarcia-tech/orbitbot`) now point to [carlosgarcia-tech/OrbitBot](https://github.com/carlosgarcia-tech/OrbitBot). No references to the previous name remain.
- Group toggle commands are now `orbit-on`, `orbit-off` and `orbit-status` (hyphenated). The old spellings (`orbiton`, `orbitoff`, `orbitstatus`, `boton`, `botoff`, `encender`, `apagar`) keep working as aliases, and the off-state router accepts all of them.

### Added

- README and `.env.example` make the owner number requirement explicit: the bot only turns on for numbers listed in `OWNERS` / `OWNER_JIDS`.
- First activation in a group is documented and covered by an e2e test: the bot stays silent until its owner sends `.orbit-on` in that group.
- Native audio stickers (`!saudio`) with a fallback when the relay fails.

## [7.1.3] - 2026-10-01

### Changed

- Unified Docker image tag convention without the `v` prefix across both pipelines: `ci.yml` (push to main) and `release.yml` (Git tags) now publish the same `X.Y.Z`, `X.Y`, `X` and `latest` formats, following common Docker registry conventions.

### Fixed

- The `{{minor}}` pattern of `metadata-action` produced only the minor digit (junk tags `1`, `6`, `12`... on ghcr.io) instead of the floating minor; it now uses `{{major}}.{{minor}}` and each release publishes the `X.Y` tag.

### Removed

- The raw Git tag (`vX.Y.Z`) is no longer published on the release Docker image: the semver patterns cover the full version and the raw tag only duplicated the release under a different convention.

## [7.1.2] - 2026-10-01

### Added

- Quick install script `OrbitBot.sh` versioned in the repository, replacing the external gist from the quick start: resolves the version to install from the argument (with or without `v`), the local `package.json`, or the latest GitHub release; detects apt/dnf/pacman, requires Node.js 20+, applies the `whatsapp-rust-bridge` patch and creates an initial `.env` with pairing-code authentication.
- `OrbitBot.sh` included in the CI `shellcheck` job.

### Changed

- `install-termux.sh` now shows the project version read dynamically from `package.json` (header, help, log and banner) instead of a fixed version that went stale on every release, using the same dependency-free mechanism (`sed`) with a fallback when the file is missing.

### Fixed

- The README quick start URL pointed to a nonexistent gist (404); it now serves the script from `raw.githubusercontent.com` and the example is pinned to the release version.

## [7.1.1] - 2026-10-01

### Added

- `shellcheck` job in the CI pipeline validating the repository `.sh` scripts (`deploy.sh`, `entrypoint.sh`, `install-termux.sh`, `stop.sh`) on every push and PR, blocking the Docker image publication on failure.
- "Termux (Android)" section in the README with the one-command install and a troubleshooting section for typical Termux errors (bot stopped when the phone sleeps, `npm install` OOM, startup after install, Node version, storage permissions and conversions without LibreOffice).

### Changed

- `install-termux.sh` adapted to the 7.x series: Node.js 20+ requirement with explicit verification, installation of PyMuPDF, pdf2docx and python-pptx for the document conversion bridge, `python3` symlink for `PythonBridge`, initial `.env` with `PHONE_NUMBER` and `USE_PAIRING_CODE` (pairing instead of QR), creation of `data/assets` and `data/backups` directories, and a warning about the LibreOffice limitation on Android.
- Format cleanup in LICENSE (no decorative lines) and aligned README tables.

### Fixed

- `install-termux.sh`: `--minimal` mode did not apply the `whatsapp-rust-bridge` patch because `--ignore-scripts` skips the `postinstall` and the bot would not start; the patch is now always applied. `A && B || C` patterns replaced with explicit `if/else` (ShellCheck SC2015).
- `entrypoint.sh`: the shebang was on the second line, so running the Docker entrypoint directly failed because it could not find the interpreter (ShellCheck SC1128).
- `deploy.sh`: unused variables removed (`STEEL`, `DB_AFTER`, `mnt`) and `local` declarations separated from their assignments to avoid masking exit codes (ShellCheck SC2034/SC2155).

## [7.1.0] - 2026-10-01

### Added

- Owner command `!lottery reset` (alias `--reset`) that allows restarting the lottery from the chat, with state persistence across bot restarts.
- Lottery tickets with unique codes generated via `crypto.randomBytes`.
- End-to-end suite for the main pipeline (full `!ping`, prefixless commands, message deduplication, offline echo) built on a harness with a `FakeWASocket` injected through `WASocketFactory`.
- Dedicated `e2e` job in the CI pipeline that blocks Docker image publication until the end-to-end tests pass.
- Coverage report to Codecov plus CI and coverage badges in the README.

### Fixed

- The `ping` alias was shadowed by `HealthCommand`; it now resolves to `PingCommand`. A cross-collision test (command name vs alias) was added to the command uniqueness test.
- Fixed 14 alias collisions between commands (`kick` → moderation, `top` → leaderboards, `truth` → game, `search` → web search with `SearchCommand` renamed to `find`, `quote`, `backup`/`restore` split, subbots, `health`, `vote`, `translate`, `poetry`, `flirt`, `love`, `kickout`).

### Changed

- README rewritten to reflect the real state of the project (install, commands, architecture, deployment).
- Test coverage is reported in `lcov` format for Codecov submission.

## [7.0.1] - 2026-06-26

### Fixed

- `parseCommand` only accepted `config.prefix`, while the pipeline detected commands with `config.prefix`, `.` and `!`. If the used prefix did not match exactly, the command was silently dropped. `parseCommand` now looks for the first matching prefix among `[config.prefix, '.', '!']`.
- Null-safety in `loadReminders`, `loadPolls` and `loadLists` of `PersistenceService`: null or corrupted data in Redis caused exceptions of the type `Cannot read properties of null`. Property access is now pre-checked.
- Errors when instantiating commands in `PluginLoader` were logged without identifying the offending file; the error context now includes the file.

## [7.0.0] - 2026-06-23

- Launch of the 7.x series. Previous versions have no detailed changelog.
