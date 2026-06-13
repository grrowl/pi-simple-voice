# pi-simple-voice

Give your Pi agent a voice — **streaming** and **verbatim**.

pi-simple-voice is a text-to-speech package for the [Pi coding agent](https://github.com/earendil-works/pi). It speaks the assistant's output **as it streams**, sentence by sentence, with **no summarization** — you hear exactly what the agent writes. It runs a local HTTP server powered by [Kokoro ONNX](https://github.com/hexgrad/kokoro) and exposes a `/voice` settings UI.

> **This is a fork of [s1m0n38/pi-voice](https://github.com/s1m0n38/pi-voice)** (MIT). See [What's different](#whats-different-from-upstream) below. Huge thanks to the upstream author — the Kokoro server, `/voice` TUI, and model management started there.

**How it works:** A small local server loads a single Kokoro ONNX model into memory and exposes a REST API for synthesis. The pi extension talks to it over HTTP — it never loads the model itself. The extension spawns the server on demand; the server self-exits after an idle timeout (default 15 min) and is re-spawned when next needed, so one model lives in RAM and is shared across all your pi sessions.

## What's different from upstream

| | upstream `pi-voice` | this fork |
|---|---|---|
| Speech text | LLM **summarizes** each response | **verbatim** — speaks what the agent writes |
| Timing | one utterance at `agent_end` | **streaming**, on sentence boundaries as tokens arrive |
| Reasoning | — | thinking/reasoning content is never voiced |
| Interrupt | `agent_end` (could cut the final sentence) | `turn_start` / `abort` (clean) |
| `tts` tool | agent can call it | **removed** — speech is a side-effect of output, not a tool |
| Server lifetime | started/stopped via CLI | extension-managed; **self-exits when idle**, re-spawned on demand |
| Runtime | `@mariozechner/*` | `@earendil-works/*` |

## Installation

```bash
pi install npm:pi-simple-voice
```

The extension auto-spawns the server and downloads the default `q4` model (~291 MB) the first time speech is enabled. The `pi-simple-voice` CLI is also available for manual control.

> Requires [`bun`](https://bun.sh) on `PATH` — the extension spawns the server under bun.

## Usage

### `/voice` command

Open the interactive settings UI inside Pi:

| Setting | Controls | Keys |
|---------|----------|------|
| TTS | Enable/disable speech | ← → |
| Voice | Speaker voice (with language/gender hints) | ← → |
| Speed | Speech rate (0.5×–3.0×) | ← → |
| Model | Quantization dtype | ← → (loads on close) |

Navigate with ↑ ↓, **Enter** to play a sample, **r** to reset, **Esc** to close. Toggle speech quickly with **alt+v**. The `♪` status bar shows live download/load progress (e.g. `♪ ↓ q4 25%`).

Settings persist in `~/.pi/voice/config.json`.

### Configuration

```json
{
  "enabled": true,
  "voice": "af_heart",
  "speed": 1.0,
  "host": "127.0.0.1",
  "port": 8181,
  "dtype": "q4",
  "idleMs": 900000
}
```

`idleMs` is how long the server sits idle before self-exiting (default 15 min). There is no summarization model and no per-event prompt config — speech is always the assistant's verbatim output.

## CLI Reference

```bash
pi-simple-voice server status                # show server status
pi-simple-voice server start                 # start server, load default model
pi-simple-voice server stop                  # stop server
pi-simple-voice server restart               # restart
pi-simple-voice model list                   # list dtypes + download status
pi-simple-voice model load <dtype>           # load (downloads if needed)
pi-simple-voice model download <dtype>       # download without loading
pi-simple-voice model remove <dtype>         # delete cached files
```

Options: `--host <host>` `--port <port>` (defaults `127.0.0.1:8181`).

### Model dtypes

| Dtype | Size | Quality | Notes |
|-------|------|---------|-------|
| `q4` | ~291 MB | Good | 4-bit matmul — recommended default |
| `q4f16` | ~147 MB | Good | 4-bit matmul + fp16 weights |
| `q8` | ~88 MB | Great | 8-bit quantized — best quality/size ratio |
| `fp16` | ~156 MB | Excellent | Half-precision floats |
| `fp32` | ~310 MB | Best | Full-precision floats |

Only one model is loaded at a time. Files are cached at `~/.pi/voice/cache/`.

## API

The server exposes HTTP endpoints at `http://127.0.0.1:8181`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Status, active dtype, model loaded, download/load progress |
| GET | `/voices` | Available voice names |
| GET | `/models` | All dtypes with download status |
| POST | `/models/download` | Download (+ optionally activate) a dtype |
| POST | `/models/delete` | Delete cached model files |
| POST | `/models/activate` | Load a downloaded model |
| POST | `/models/unload` | Unload model, free memory |
| POST | `/tts` | Synthesize text → WAV audio |
| POST | `/shutdown` | Graceful shutdown |

## Events

The extension emits `voice:config` on the pi event bus (`pi.events`) whenever a setting changes via `/voice`:

```typescript
pi.events.on("voice:config", ({ enabled, voice, speed }) => {
  // update status bar, toggle features, etc.
});
```

## License

MIT — same as upstream. Forked from [s1m0n38/pi-voice](https://github.com/s1m0n38/pi-voice).
