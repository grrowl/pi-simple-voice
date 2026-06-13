# Changelog

All notable changes to **pi-simple-voice** are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are managed
by [release-please](https://github.com/googleapis/release-please).

## [2.0.0](https://github.com/grrowl/pi-simple-voice/compare/v1.0.0...v2.0.0) (2026-06-13)


### ⚠ BREAKING CHANGES

* Config moved from ~/.pi/voice.json to ~/.pi/voice/config.json. The summaryModel field is removed; use per-event model in events config instead. EventConfig now accepts { prompt, model? } or { text } (mutually exclusive).

### Features

* add event bus and status bar indicator ([dd8aeeb](https://github.com/grrowl/pi-simple-voice/commit/dd8aeeb9327d6ef33c517b63ea0d9539176fe16f))
* overhaul event config and migrate state to ~/.pi/voice/ ([3242af6](https://github.com/grrowl/pi-simple-voice/commit/3242af6f51d5ed3f50467777f6be9d09bfca7630))
* serialize audio playback to prevent overlapping speech ([946f533](https://github.com/grrowl/pi-simple-voice/commit/946f53364ec243a54c671193e781e46911e62dbd))
* **server:** add FIFO queue to serialize /tts requests ([82caeb8](https://github.com/grrowl/pi-simple-voice/commit/82caeb8bf53e5a4063e933735250a1d750f8dc21))


### Bug Fixes

* **ci:** resolve platform-specific deps by regenerating lockfile on runner ([1d9fb93](https://github.com/grrowl/pi-simple-voice/commit/1d9fb93547335f9c9acdb05d151544e92651debe))
* **cli:** read `dtype` from config (was `defaultModel`), matching the extension ([6d2a7e5](https://github.com/grrowl/pi-simple-voice/commit/6d2a7e53dc600c2791a03db5c760fac71294dbf6))
* move model cache to ~/.pi/voice/cache/ ([2ed7462](https://github.com/grrowl/pi-simple-voice/commit/2ed74626d4f7904e67e58f0b469a29335d3c1715))
* preserve user events config and persist reset to defaults ([d4e4ad1](https://github.com/grrowl/pi-simple-voice/commit/d4e4ad11de3b029e536b972ce9d728c477b9c6f0))
* resolve biome lint errors blocking CI ([0d764c0](https://github.com/grrowl/pi-simple-voice/commit/0d764c018305cccdcfe6be9a3f42cba7e66345e9))
* **test:** use real default summary prompt in queue test config ([4ad65d4](https://github.com/grrowl/pi-simple-voice/commit/4ad65d4bc71eebffc974eb22c75c05ab4111102e))
* **types:** typecheck cleanly — allow .ts imports; drop dead `abort` listener ([8b0994e](https://github.com/grrowl/pi-simple-voice/commit/8b0994e9d4747b9525dc8179cd8988731728f2f2))

## 1.0.0

First release of **pi-simple-voice** — a streaming, verbatim text-to-speech
extension for the [Pi coding agent](https://github.com/earendil-works/pi),
forked from [s1m0n38/pi-voice](https://github.com/s1m0n38/pi-voice) `v2.0.1`.

What's different from upstream:

- Speaks the assistant's output **verbatim and streaming** (sentence-boundary
  chunking) — no LLM summarization.
- **No agent-facing `tts` tool** — speech is a side-effect of the assistant's
  output, not something the model can call.
- Interrupts on a new user turn (not `agent_end`, which cut off the final
  sentence upstream); reasoning/thinking is never voiced.
- The local Kokoro server **self-exits when idle** and is re-spawned on demand,
  so one model is shared across pi sessions and an idle session costs nothing.
- Runtime ported from `@mariozechner/*` to `@earendil-works/*`.

For pre-fork history, see the
[upstream changelog](https://github.com/s1m0n38/pi-voice/blob/main/CHANGELOG.md).
