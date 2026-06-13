# Contributing to pi-simple-voice

A fork of [s1m0n38/pi-voice](https://github.com/s1m0n38/pi-voice). Please keep
the upstream attribution in `README.md` and `CHANGELOG.md` intact.

## Development Setup

```bash
git clone git@github.com:grrowl/pi-simple-voice.git
cd pi-simple-voice
bun install        # or: npm install
```

Verify everything works:

```bash
bun test extensions/   # unit tests for the streaming/chunking logic
npm run lint           # biome check
npm run typecheck      # tsc --noEmit
```

`bun` is required at runtime (the extension spawns the server under bun) and is
the simplest way to run the tests and the CLI locally.

## Commands

| Command | Purpose |
|---------|---------|
| `bun test extensions/` | Unit tests (`extensions/*.test.ts`) |
| `npm run lint` / `lint:fix` | Check / auto-fix lint + formatting (biome) |
| `npm run format` | Format only |
| `npm run typecheck` | TypeScript type checking (no emit) |
| `npm run server` | Start the TTS server locally |
| `bun src/cli.ts` | Run the CLI directly |

## Project Structure

```
extensions/
  index.ts             # extension: streaming verbatim speech, /voice TUI, server lifecycle
  chunking.ts          # pure streaming helpers (reasoning filter, clean, chunk)
  chunking.test.ts     # unit tests for chunking.ts
  server.ts            # HTTP server: Kokoro ONNX model lifecycle + REST API
src/
  cli.ts               # CLI: server/model management
  prepare.js           # npm prepare hook (writes default config)
.agents/skills/
  pi-init/             # environment health check
  pi-package/          # extension development patterns
```

## Conventions

- **No build step** — pi loads `.ts` directly. Never add a compile/bundle step.
- **2-space indentation** — enforced by biome (`biome.json`).
- **Runtime deps in `dependencies`** — `kokoro-js` and `jiti`. `biome` and
  `typescript` are dev. Pi packages (`@earendil-works/pi-*`) are
  `peerDependencies: "*"`.
- **Single model in memory** — the server enforces one active model; every
  model-swap path disposes the previous ONNX session first.
- **Conventional commits** — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

## What this fork changes

Speech is **verbatim and streaming** with **no summarization**, the agent-facing
`tts` tool is **removed**, interrupts fire on `turn_start`/`abort`, and the
server **self-exits when idle**. Keep these properties when contributing — the
point of the fork is to hear exactly what the agent writes, as it writes it.

## PR Checklist

- [ ] `bun test extensions/` passes (add tests for chunking/behavior changes)
- [ ] `npm run lint` passes
- [ ] Conventional commit messages
- [ ] No secrets or `.env` files committed
- [ ] Single-model invariant preserved if server code changed
