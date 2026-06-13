# Changelog

All notable changes to **pi-simple-voice** are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are managed
by [release-please](https://github.com/googleapis/release-please).

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
