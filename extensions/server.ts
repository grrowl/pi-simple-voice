/**
 * Kokoro TTS Server — local fork of @s1m0n38/pi-voice's server.
 *
 * Forked into the secretary repo so we own it (no @mariozechner/* coupling —
 * this file imports zero pi APIs, only node builtins + kokoro-js). Run as a
 * standalone bun subprocess spawned by the `voice` extension.
 *
 * Changes vs upstream:
 *   - Idle-unload: the model is disposed after IDLE_MS of no /tts, freeing
 *     ~88–300 MB while the (tiny) HTTP server stays up. The model transparently
 *     reloads on the next /tts (reload-on-demand), so one model lives in RAM at
 *     most and multiple pis share this single server.
 *
 * Endpoints:
 *   GET  /health             → { status, activeDtype, lastDtype, modelLoaded, loading }
 *   GET  /voices             → { voices: string[] }
 *   GET  /models             → { models: { [dtype]: { downloaded } } }
 *   POST /models/download    → { dtype, activate? } → downloads model
 *   POST /models/delete      → { dtype } → removes cached model files
 *   POST /models/activate    → { dtype } → loads model into memory
 *   POST /models/unload      → unloads active model, frees memory
 *   POST /tts                → { text, voice?, speed? } → WAV audio (binary)
 *   POST /shutdown           → { status: "shutting down" }
 *
 * Usage:
 *   bun server.ts [--port 8181] [--host 127.0.0.1] [--idle-ms 300000]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Configuration ──────────────────────────────────────────────────
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPES = ["q4", "q4f16", "q8", "fp16", "fp32"] as const;
type DType = (typeof DTYPES)[number];

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HOST = getArg("host", "127.0.0.1");
const PORT = Number.parseInt(getArg("port", "8181"), 10);
// Unload the model after this many ms of no /tts. <= 0 disables idle-unload.
const IDLE_MS = Number.parseInt(getArg("idle-ms", "300000"), 10);
const VOICE_DIR = resolve(homedir(), ".pi", "voice");
const MANIFEST_PATH = join(VOICE_DIR, "manifest.json");

// ── Cache ──────────────────────────────────────────────────────────
// Persistent cache outside node_modules — survives npm install cycles.
// Reuses the existing ~/.pi/voice/cache so already-downloaded models are kept.
const CACHE_DIR = join(VOICE_DIR, "cache");

function getOnnxPath(dtype: DType): string {
  // transformers.js stores: cache/<org>/<repo>/onnx/model_<dtype>.onnx
  const parts = MODEL_ID.split("/");
  const org = parts[0] ?? "";
  const repo = parts[1] ?? "";
  return resolve(CACHE_DIR, org, repo, "onnx", `model_${dtype}.onnx`);
}

function isDtypeDownloaded(dtype: DType): boolean {
  return existsSync(getOnnxPath(dtype));
}

// ── Manifest (tracks downloads across server restarts) ─────────────
interface Manifest {
  downloaded: DType[];
}

function loadManifest(): Manifest {
  try {
    if (existsSync(MANIFEST_PATH)) {
      const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
      return { downloaded: raw.downloaded ?? [] };
    }
  } catch {
    /* use defaults */
  }
  return { downloaded: [] };
}

function saveManifest(manifest: Manifest) {
  mkdirSync(VOICE_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

function markDownloaded(dtype: DType) {
  const manifest = loadManifest();
  if (!manifest.downloaded.includes(dtype)) {
    manifest.downloaded.push(dtype);
    saveManifest(manifest);
  }
}

function markDeleted(dtype: DType) {
  const manifest = loadManifest();
  manifest.downloaded = manifest.downloaded.filter((d) => d !== dtype);
  saveManifest(manifest);
}

// Sync manifest with actual files on disk.
// Handles both: files deleted externally, and files that exist but aren't tracked.
function syncManifest(): Manifest {
  const manifest = loadManifest();
  const stillExist = manifest.downloaded.filter((d) => isDtypeDownloaded(d));
  const tracked = new Set(stillExist);
  for (const dtype of DTYPES) {
    if (!tracked.has(dtype) && isDtypeDownloaded(dtype)) {
      stillExist.push(dtype);
    }
  }
  if (
    stillExist.length !== manifest.downloaded.length ||
    stillExist.some((d, i) => d !== manifest.downloaded[i])
  ) {
    saveManifest({ downloaded: stillExist });
  }
  return { downloaded: stillExist };
}

// ── State ──────────────────────────────────────────────────────────
let KokoroTTS: typeof import("kokoro-js").KokoroTTS = null as never;
let tts: import("kokoro-js").KokoroTTS | null = null;
let activeDtype: DType | null = null;
// Last dtype that was loaded/activated. Survives idle-unload so /tts can
// transparently reload after the model has been freed.
let lastDtype: DType | null = null;
let loading = false;

async function importKokoro() {
  if (KokoroTTS) return;
  const mod = await import("kokoro-js");
  KokoroTTS = mod.KokoroTTS;
}

// ── Idle-unload ────────────────────────────────────────────────────
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

function armIdleTimer() {
  if (IDLE_MS <= 0) return;
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (loading || !tts) return;
    console.log(`[voice-server] Idle ${IDLE_MS}ms — unloading model.`);
    void unloadModel();
  }, IDLE_MS);
  // Don't let the idle timer keep the process alive on its own.
  idleTimer.unref?.();
}

// ── Model lifecycle ────────────────────────────────────────────────
// Ensures only one model is ever in memory at a time.

async function unloadModel(): Promise<void> {
  if (!tts) return;
  const oldDtype = activeDtype;
  try {
    console.log(`[voice-server] Disposing model (${oldDtype}) ...`);
    await tts.model.dispose();
  } catch (err) {
    console.warn(
      `[voice-server] Error disposing model: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  tts = null;
  activeDtype = null;
  if (typeof global.gc === "function") {
    global.gc();
  }
  console.log(`[voice-server] Model unloaded (${oldDtype}).`);
}

async function loadModel(dtype: DType): Promise<import("kokoro-js").KokoroTTS> {
  await importKokoro();

  if (tts && activeDtype === dtype) return tts;
  if (loading) throw new Error("Model is currently loading, please retry");

  if (!isDtypeDownloaded(dtype)) {
    throw new Error(
      `Model dtype "${dtype}" is not downloaded. Download it first via /models/download.`,
    );
  }

  loading = true;
  try {
    await unloadModel();

    console.log(`[voice-server] Loading model: ${MODEL_ID} (dtype=${dtype}) ...`);
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = CACHE_DIR;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device: "cpu",
    });
    activeDtype = dtype;
    lastDtype = dtype;
    const voiceCount = Object.keys(tts.voices).length;
    console.log(`[voice-server] Model loaded (${dtype}). ${voiceCount} voices available.`);
    return tts;
  } finally {
    loading = false;
  }
}

async function downloadModel(dtype: DType): Promise<void> {
  await importKokoro();

  console.log(`[voice-server] Downloading model: ${MODEL_ID} (dtype=${dtype}) ...`);
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device: "cpu",
  });
  console.log(`[voice-server] Download complete (${dtype}).`);
  markDownloaded(dtype);

  await unloadModel();
  tts = instance;
  activeDtype = dtype;
  lastDtype = dtype;
  console.log(`[voice-server] Auto-activated ${dtype}.`);
}

async function downloadOnlyModel(dtype: DType): Promise<void> {
  await importKokoro();

  console.log(`[voice-server] Downloading model (no activate): ${MODEL_ID} (dtype=${dtype}) ...`);
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device: "cpu",
  });
  console.log(`[voice-server] Download complete (${dtype}). Disposing temporary instance...`);
  markDownloaded(dtype);

  try {
    await instance.model.dispose();
  } catch (err) {
    console.warn(
      `[voice-server] Error disposing download instance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof global.gc === "function") {
    global.gc();
  }
  console.log(`[voice-server] Model ${dtype} saved to disk (not activated).`);
}

// ── Helpers ────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isValidDtype(value: string): value is DType {
  return DTYPES.includes(value as DType);
}

// ── Route handlers ─────────────────────────────────────────────────
function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  json(res, {
    status: "ok",
    activeDtype,
    lastDtype,
    modelLoaded: tts !== null,
    loading,
  });
}

async function handleVoices(_req: IncomingMessage, res: ServerResponse) {
  // Reload the last model on demand so /voices works after an idle-unload.
  if (!tts && lastDtype && isDtypeDownloaded(lastDtype)) {
    try {
      await loadModel(lastDtype);
    } catch {
      /* fall through to the not-loaded response */
    }
  }
  if (!tts) {
    json(res, { error: "Model not loaded" }, 503);
    return;
  }
  json(res, { voices: Object.keys(tts.voices) });
}

function handleModels(_req: IncomingMessage, res: ServerResponse) {
  syncManifest();
  const models: Record<string, { downloaded: boolean }> = {};
  for (const dtype of DTYPES) {
    models[dtype] = { downloaded: isDtypeDownloaded(dtype) };
  }
  json(res, { models });
}

async function handleModelsDownload(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = JSON.parse(await readBody(req));
    const dtype = body.dtype as string;
    const activate = body.activate !== false; // default: true

    if (!dtype || !isValidDtype(dtype)) {
      json(res, { error: `Invalid dtype. Must be one of: ${DTYPES.join(", ")}` }, 400);
      return;
    }

    if (isDtypeDownloaded(dtype)) {
      markDownloaded(dtype);
      if (activate) {
        try {
          await loadModel(dtype);
        } catch (err) {
          console.warn(
            `[voice-server] Activate failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      json(res, { message: `Model ${dtype} already downloaded`, dtype });
      return;
    }

    if (activate) {
      await downloadModel(dtype);
    } else {
      await downloadOnlyModel(dtype);
    }
    json(res, { message: `Model ${dtype} downloaded successfully`, dtype });
  } catch (err) {
    console.error("[voice-server] Download error:", err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleModelsDelete(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = JSON.parse(await readBody(req));
    const dtype = body.dtype as string;

    if (!dtype || !isValidDtype(dtype)) {
      json(res, { error: `Invalid dtype. Must be one of: ${DTYPES.join(", ")}` }, 400);
      return;
    }

    if (!isDtypeDownloaded(dtype)) {
      json(res, { error: `Model ${dtype} is not downloaded` }, 404);
      return;
    }

    if (activeDtype === dtype) {
      await unloadModel();
    }
    if (lastDtype === dtype) lastDtype = null;

    const onnxPath = getOnnxPath(dtype);
    if (existsSync(onnxPath)) {
      rmSync(onnxPath, { force: true });
    }
    markDeleted(dtype);
    console.log(`[voice-server] Deleted model: ${dtype}`);
    json(res, { message: `Model ${dtype} deleted`, dtype });
  } catch (err) {
    console.error("[voice-server] Delete error:", err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleModelsActivate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = JSON.parse(await readBody(req));
    const dtype = body.dtype as string;

    if (!dtype || !isValidDtype(dtype)) {
      json(res, { error: `Invalid dtype. Must be one of: ${DTYPES.join(", ")}` }, 400);
      return;
    }

    if (!isDtypeDownloaded(dtype)) {
      json(res, { error: `Model ${dtype} is not downloaded. Download it first.` }, 404);
      return;
    }

    await loadModel(dtype);
    armIdleTimer();
    json(res, { message: `Model ${dtype} activated`, dtype });
  } catch (err) {
    console.error("[voice-server] Activate error:", err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleModelsUnload(_req: IncomingMessage, res: ServerResponse) {
  try {
    clearIdleTimer();
    if (!tts) {
      json(res, { message: "No model loaded" });
      return;
    }
    await unloadModel();
    json(res, { message: "Model unloaded" });
  } catch (err) {
    console.error("[voice-server] Unload error:", err);
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// ── TTS request queue (serializes /tts calls — one synthesis at a time) ────
let ttsQueueTail: Promise<void> = Promise.resolve();
let ttsQueueDepth = 0;

function enqueueTTS<T>(
  label: string,
  _req: IncomingMessage,
  res: ServerResponse,
  fn: () => Promise<T>,
): Promise<T> {
  ttsQueueDepth++;
  const depth = ttsQueueDepth;
  console.log(`[voice-server] Queue: enqueued "${label}" (depth=${depth})`);

  let disconnected = false;
  const onClose = () => {
    disconnected = true;
  };
  res.on("close", onClose);

  return new Promise<T>((resolve, reject) => {
    ttsQueueTail = ttsQueueTail.then(async () => {
      ttsQueueDepth--;
      res.removeListener("close", onClose);

      if (disconnected) {
        console.log(`[voice-server] Queue: skipping "${label}" (client disconnected)`);
        reject(new Error("Client disconnected"));
        return;
      }

      console.log(`[voice-server] Queue: processing "${label}"`);
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function handleTTS(req: IncomingMessage, res: ServerResponse) {
  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody);
    const text = (body.text as string | undefined)?.trim();
    const label = text ? `"${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"` : "(empty)";

    const result = await enqueueTTS(label, req, res, async () => {
      // Hold off idle-unload while we're actively synthesizing.
      clearIdleTimer();

      // Reload-on-demand: if the model was idle-unloaded, bring it back.
      if (!tts && lastDtype && isDtypeDownloaded(lastDtype)) {
        await loadModel(lastDtype);
      }

      if (!tts || !activeDtype) {
        return {
          error: "No model loaded. Download and activate a model first.",
          status: 503,
        } as const;
      }

      if (!text) {
        return { error: "Missing or empty 'text' field", status: 400 } as const;
      }

      const voice = (body.voice as string) || "af_heart";
      const speed = Number(body.speed ?? 1.0);

      console.log(
        `[voice-server] Synthesizing: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}" (voice=${voice}, speed=${speed}, dtype=${activeDtype})`,
      );

      const audio = await tts.generate(text, {
        voice: voice as keyof typeof tts.voices,
        speed,
      });
      const samples = audio.audio as Float32Array;
      const sampleRate = audio.sampling_rate;
      return { wav: float32ToWav(samples, sampleRate) } as const;
    });

    // Restart the idle countdown after each synthesis.
    armIdleTimer();

    if ("error" in result) {
      json(res, { error: result.error }, result.status);
    } else {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": result.wav.length,
      });
      res.end(result.wav);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "Client disconnected") {
      return;
    }
    console.error("[voice-server] TTS error:", err);
    if (!res.headersSent) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
}

function handleShutdown(req: IncomingMessage, res: ServerResponse) {
  json(res, { status: "shutting down" });
  console.log("[voice-server] Shutdown requested");
  req.socket.destroy();
  process.exit(0);
}

// ── WAV encoder (Float32 → 16-bit PCM) ────────────────────────────
function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 0x7fff), offset);
    offset += 2;
  }

  return buffer;
}

// ── Server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return handleHealth(req, res);
    }
    if (path === "/voices" && req.method === "GET") {
      return await handleVoices(req, res);
    }
    if (path === "/models" && req.method === "GET") {
      return handleModels(req, res);
    }
    if (path === "/models/download" && req.method === "POST") {
      return await handleModelsDownload(req, res);
    }
    if (path === "/models/delete" && req.method === "POST") {
      return await handleModelsDelete(req, res);
    }
    if (path === "/models/activate" && req.method === "POST") {
      return await handleModelsActivate(req, res);
    }
    if (path === "/models/unload" && req.method === "POST") {
      return await handleModelsUnload(req, res);
    }
    if (path === "/tts" && req.method === "POST") {
      return await handleTTS(req, res);
    }
    if (path === "/shutdown" && req.method === "POST") {
      return handleShutdown(req, res);
    }

    json(res, { error: "Not found" }, 404);
  } catch (err) {
    console.error("[voice-server] Unhandled error:", err);
    if (!res.headersSent) {
      json(res, { error: "Internal server error" }, 500);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[voice-server] Server listening on http://${HOST}:${PORT}`);
  console.log(`[voice-server] Cache dir: ${CACHE_DIR}`);
  console.log(`[voice-server] Idle-unload: ${IDLE_MS > 0 ? `${IDLE_MS}ms` : "disabled"}`);
});
