# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [8.2.18] - 2026-11-27

### Added

- YouTube downloads are cached on disk (`data/youtube_cache`): audio and video keyed by `videoId` (plus quality for video), 24 h TTL and a 1 GB budget (250 MB on Termux) with oldest-first eviction. Asking for the same video twice serves a local copy instead of running `yt-dlp` again. Every request gets its own temp copy, so the download commands can keep deleting what they send without emptying the cache.

### Changed

- All downloaders share a global limit of two external processes. A third `yt-dlp`/`ffmpeg` waits in FIFO order instead of competing for CPU, which is what a basic VPS and a phone running Termux can sustain, and the limit is honest because the slot is taken before the process is spawned.
- `!sticker` / `!s` refuses a video longer than 10 s before downloading it, using the duration WhatsApp already reports. Before, it downloaded the whole file, trimmed it to 10 s and often timed out on the way.
- Download errors keep only the last 8 KB of `yt-dlp` stderr, so a noisy run can no longer grow that string without bound. stdout is still returned whole because metadata calls parse it as JSON.
- The TikTok disk cache moved into a shared `MediaFileCache` (same TTL/eviction behaviour) so YouTube reuses it instead of duplicating the logic; cache keys that could escape the cache directory are rejected.

## [8.2.17] - 2026-11-26

### Changed

- Slow commands no longer hold up the fast ones. The message processor now keeps three lanes: sequential for state-changing commands, parallel (5 at a time) for read-only ones, and a new heavy lane (2 at a time) for downloads and ffmpeg. All 21 download commands and `!sticker` run in the heavy lane, so a running download can no longer fill the parallel lane and leave `!ping` waiting. The periodic queue log and the panel metrics report each lane separately.
- AI mention replies no longer block the bot: `handleMention` runs detached with at most two Groq requests in flight, so answering a mention in one group does not delay commands anywhere else.

### Fixed

- `!blackjack`, `!coinflip`, `!dice` and `!roulette` are sequential again. They updated the player's balance through `addMoney`/`removeMoney` (a read-modify-write) while marked parallelizable, so two simultaneous bets from the same user could lose a balance update.
- Concurrent sticker conversions no longer share temp files. Their filenames used `Date.now()`, so two conversions starting in the same millisecond overwrote each other's source and one deleted files still in use.

## [8.2.16] - 2026-11-26

### Fixed

- `!saudio` no longer stretches short clips: the animated visual now lasts exactly as long as the audio instead of being cut to the whole second reported by WhatsApp, and the reported duration rounds to the nearest second instead of always up. Sub-second audio stays untouched (the wire `seconds` field is an integer, so it can only report 1); a 1.2s clip is no longer shown and animated as 2s.

## [8.2.15] - 2026-11-26

### Fixed

- `!saudio` now combines media that cites another one: replying to an image/video that quotes an audio, or to an audio that quotes an image/video, reuses both pieces. It only looked at the directly quoted message, so it answered `NO_AUDIO`. Cached originals are preferred so the quoted media keeps its CDN url, and a quoted image with no audio now gets a clear instruction instead of the "ese video no tiene audio" message.

## [8.2.14] - 2026-11-26

### Changed

- Sticker framing always fills the square now, with no transparent bands. Landscape sources are scaled to full height and lose side strips; normal portrait photos keep their full height and fill the side gaps with a blurred copy of themselves; only full vertical sources (height / width > 1.6) are cropped top/bottom. Static and animated stickers, including the Jimp fallback.

## [8.2.13] - 2026-11-26

### Fixed

- `!sticker` (and the other sticker commands) no longer crops the top of normal photos: content is scaled to fit and padded with transparent bands, so the whole image survives. Only full vertical sources taller than 1.6:1 (16:9 vertical videos and the like) are still cropped to fill the square, since padding would shrink them to a sliver. Applies to static images and animated video stickers.

## [8.2.12] - 2026-11-25

### Fixed

- `!tiktok` accepts the URLs TikTok shares from the web app (`?is_from_webapp=1&sender_device=pc`). The shared URL validator rejected every `&` as a shell metacharacter, so direct `/video/<id>` links failed with "URL contiene patrones bloqueados" while `vt.tiktok.com` short links worked. Query separators are now allowed (yt-dlp is always spawned without a shell); the rest of the injection patterns stay blocked.

## [8.2.11] - 2026-11-25

### Fixed

- `!tiktok` no longer fails with `HTTP Error 403: Forbidden`: metadata and the no-watermark MP4 now come from tikwm.com first, which works from the server IP, and yt-dlp remains as fallback. A blocked metadata probe no longer opens the circuit breaker and blocks the download.
- `/etc/yt-dlp.conf` no longer forces a global `--cookies` file, so other sites (YouTube, Facebook) stop writing their cookies into TikTok's jar. TikTokGuard still passes its own jar per call.
- Impersonation-target rotation works with the real `yt-dlp --list-impersonate-targets` output (`Chrome-133`, not only lowercase names).

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
