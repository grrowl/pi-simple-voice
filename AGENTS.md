# pi-simple-voice — Agent Context

Streaming, verbatim Kokoro TTS for the Pi agent. A fork of
[s1m0n38/pi-voice](https://github.com/s1m0n38/pi-voice) that speaks the
assistant's output as it streams — no summarization, no agent-facing tool.

## Quick Reference

| What | Command |
|------|---------|
| Unit tests | `bun test extensions/` |
| Lint | `npm run lint` (biome) |
| Type check | `npm run typecheck` |
| Run server standalone | `npm run server` (or `bun extensions/server.ts`) |
| Run CLI | `bun src/cli.ts` |

## Constraints

- **No build step** — pi loads `.ts` directly (bun/jiti). Never add a compile step.
- **2-space indent** — enforced by biome.
- **Single model in memory** — every model-swap path unloads/disposes the
  previous ONNX session first. Model ops are serialized in the server.
- **Runtime is `@earendil-works/*`** — the extension imports `@earendil-works/pi-coding-agent`
  and `@earendil-works/pi-tui`; these are `peerDependencies`.
- **The server spawns under `bun`** — `bun` must be on `PATH` at runtime.

## Project Layout

```
extensions/
  index.ts             # Extension: streaming verbatim speech, /voice TUI, server lifecycle
  chunking.ts          # Pure helpers: reasoning filter, markdown clean, sentence chunking
  chunking.test.ts     # Unit tests for the above (node:test, run via `bun test`)
  server.ts            # HTTP server: Kokoro ONNX model lifecycle + REST API
src/
  cli.ts               # CLI: pi-simple-voice server/model management
  prepare.js           # npm prepare hook (writes default ~/.pi/voice/config.json)
.agents/skills/        # pi-init, pi-package authoring skills
```

## Architecture

### Extension (`extensions/index.ts`)

- Speaks the assistant's output **verbatim and streaming**: accumulates
  `message_update` text, drains complete clauses/sentences (`drainBoundaries`),
  and enqueues them for synthesis. The first chunk flushes fast (low
  time-to-first-audio); later chunks wait for sentence ends.
- **Never voices reasoning** — `getContent` drops thinking/reasoning parts.
- Interrupts on `turn_start` / `abort` (NOT `agent_end` — that cut off the final
  sentence in upstream).
- `/voice` TUI: enable, voice, speed, model dtype (loads lazily on close). The
  `♪` status bar shows live download/load progress. Toggle with `alt+v`.
- **No agent-facing tool** — speech is a side-effect of output, not callable.
- Spawns the server on demand and points it at `~/.pi/voice`.

### Server (`extensions/server.ts`)

Standalone HTTP server (node:http, zero pi APIs) managing the Kokoro model.
Binds `127.0.0.1:8181` by default. **Self-exits after `--idle-ms` (default 15
min)** of no `/tts`; the extension re-spawns it on demand.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | status, activeDtype, lastDtype, modelLoaded, loading, progress |
| GET | `/voices` | available voice names |
| GET | `/models` | all dtypes with download status |
| POST | `/models/download` | download (+ optionally activate) a dtype |
| POST | `/models/delete` | delete cached files (unloads if active) |
| POST | `/models/activate` | load a downloaded model |
| POST | `/models/unload` | unload, free memory |
| POST | `/tts` | synthesize text → WAV |
| POST | `/shutdown` | graceful shutdown |

Config + cache live under `~/.pi/voice/` (`config.json`, `cache/`).

## Testing

`extensions/chunking.test.ts` unit-tests the pure streaming logic (the heart of
the fork) with no runtime deps. Run with `bun test extensions/`. The helpers are
isolated in `chunking.ts` precisely so they're testable without the pi stack.

A server/e2e harness against real kokoro-js is not yet ported from upstream.

## Git Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- This is a fork: keep attribution to upstream intact in README/CHANGELOG.
