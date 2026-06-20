/**
 * voice — local, simplified fork of @s1m0n38/pi-voice's extension.
 *
 * Ported from @mariozechner/* to @earendil-works/* (this harness's runtime) and
 * stripped to what we want:
 *   - NO summarization. Speaks the assistant's OUTPUT verbatim, not an LLM
 *     rephrase. (Upstream's only auto-TTS modes were summarize-via-LLM or a
 *     fixed string; both are gone, along with the createAgentSession machinery.)
 *   - Streaming: speaks sentence-by-sentence as the model generates, chunked on
 *     sentence/clause boundaries so Kokoro gets whole clauses (natural prosody).
 *   - Reasoning/thinking content is never voiced.
 *   - Interrupts cleanly on a new user turn (kills in-flight audio). It does NOT
 *     stop on agent_end — that was the upstream "cuts off mid-sentence" bug.
 *   - Manages a local Kokoro server (spawned under bun, self-exits when idle).
 *     Shared across pis; one model in memory at a time; re-spawned on demand.
 *   - Keeps the /voice TUI (enable / voice / speed / model dtype / sample).
 *   - No agent-facing tool: speech is driven by the assistant's output, not a
 *     tool the model can call (by design).
 *
 * The server is server.ts, a sibling of this file (our fork). Config lives at
 * ~/.pi/voice/config.json (shared with the server's cache dir).
 */

import { type ChildProcess, exec as execCb, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { cleanTextForSpeech, drainBoundaries, getContent, trimChunk } from "./chunking.ts";

// ── Types ──────────────────────────────────────────────────────────

interface FullVoiceConfig {
  enabled: boolean;
  voice: string;
  speed: number;
  host: string;
  port: number;
  dtype: string;
  idleMs: number;
}

interface VoiceSessionState {
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

export type VoiceSpeakSource = "auto" | "sample";

export interface VoiceConfigEvent {
  enabled: boolean;
  voice: string;
  speed: number;
}

export interface VoiceEventMap {
  "voice:config": VoiceConfigEvent;
}

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
const DTYPES = ["q4", "q4f16", "q8", "fp16", "fp32"];
const SPEED_VALUES = [
  "0.5",
  "0.75",
  "1.0",
  "1.25",
  "1.5",
  "1.75",
  "2.0",
  "2.25",
  "2.5",
  "2.75",
  "3.0",
];

const DEFAULT_CONFIG: FullVoiceConfig = {
  enabled: true,
  voice: "af_heart",
  speed: 1.0,
  host: "127.0.0.1",
  port: 8181,
  dtype: "q4",
  idleMs: 900_000, // 15 min idle → server self-exits; re-spawned on demand
};

function speedToIndex(speed: number): number {
  const idx = SPEED_VALUES.findIndex((s) => Number.parseFloat(s) === speed);
  return idx >= 0 ? idx : 0;
}

function voiceHint(name: string): string {
  const langMap: Record<string, string> = {
    a: "American",
    b: "British",
    j: "Japanese",
    z: "Mandarin",
    e: "Spanish",
    f: "French",
    h: "Hindi",
    i: "Italian",
    p: "Brazilian",
  };
  const genderMap: Record<string, string> = { f: "female", m: "male" };
  const lang = langMap[name[0]] ?? "";
  const gender = genderMap[name[1]] ?? "";
  if (lang && gender) return `${lang} ${gender}`;
  if (gender) return gender;
  return lang;
}

// ── Config persistence (~/.pi/voice/config.json) ───────────────────

function loadConfig(): FullVoiceConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return {
        enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
        voice: raw.voice ?? DEFAULT_CONFIG.voice,
        speed: raw.speed ?? DEFAULT_CONFIG.speed,
        host: raw.host ?? DEFAULT_CONFIG.host,
        port: raw.port ?? DEFAULT_CONFIG.port,
        dtype: raw.dtype ?? DEFAULT_CONFIG.dtype,
        idleMs: raw.idleMs ?? DEFAULT_CONFIG.idleMs,
      };
    }
  } catch {
    /* use defaults */
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: FullVoiceConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

// ── Text → speech chunking (verbatim, reasoning-filtered, streaming) ──

// Pull the visible assistant text out of a message, dropping thinking/reasoning.
// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let defaults = loadConfig();
  let session: VoiceSessionState = {};
  let currentCtx: ExtensionContext | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;

  interface Health {
    modelLoaded: boolean;
    activeDtype: string | null;
    loading: boolean;
    progress: { dtype: string; phase: "download" | "load"; percent: number } | null;
  }

  function getEffective(): FullVoiceConfig {
    return {
      enabled: session.enabled ?? defaults.enabled,
      voice: session.voice ?? defaults.voice,
      speed: session.speed ?? defaults.speed,
      host: defaults.host,
      port: defaults.port,
      dtype: defaults.dtype,
      idleMs: defaults.idleMs,
    };
  }

  const serverUrl = () => `http://${defaults.host}:${defaults.port}`;

  function persistSession() {
    pi.appendEntry<VoiceSessionState>("voice-session", { ...session });
  }

  function restoreSession(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "voice-session") {
        const data = entry.data as VoiceSessionState | undefined;
        if (data) session = { ...data };
      }
    }
    defaults = loadConfig();
  }

  // ── Serial speech queue (fetch /tts → afplay), interruptible ──────

  const queue: string[] = [];
  let running = false;
  let controller: AbortController | undefined;
  let currentChild: ChildProcess | undefined;
  let tmpSeq = 0;

  function stopSpeech() {
    queue.length = 0;
    controller?.abort();
    controller = undefined;
    currentChild?.kill("SIGTERM");
    currentChild = undefined;
    // reset streaming state too
    buffer = "";
    processedLen = 0;
    firstFlushDone = false;
  }

  function enqueueChunk(text: string) {
    const cleaned = trimChunk(text);
    if (!cleaned) return;
    queue.push(cleaned);
    void drainQueue();
  }

  async function drainQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const text = queue.shift();
        if (!text) continue;
        const ac = new AbortController();
        controller = ac;
        try {
          await synthAndPlay(text, getEffective(), ac.signal);
        } catch (err) {
          if (!ac.signal.aborted) console.error("[voice] speak failed:", err);
        } finally {
          if (controller === ac) controller = undefined;
        }
      }
    } finally {
      running = false;
      if (queue.length > 0) void drainQueue();
    }
  }

  async function synthAndPlay(
    text: string,
    config: FullVoiceConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const spoken = cleanTextForSpeech(text);
    if (!spoken) return;

    const url = `http://${config.host}:${config.port}/tts`;
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, voice: config.voice, speed: config.speed }),
      signal,
    };
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      // Server likely self-exited after idle — re-spawn it and retry once.
      if (signal.aborted) throw err;
      await ensureServer();
      res = await fetch(url, opts);
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }

    const wav = Buffer.from(await res.arrayBuffer());
    const dir = join(tmpdir(), "pi-simple-voice");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `chunk-${process.pid}-${Date.now()}-${tmpSeq++}.wav`);
    writeFileSync(file, wav);

    await new Promise<void>((resolvePlay, rejectPlay) => {
      const cmd = process.platform === "darwin" ? "afplay" : "aplay";
      const child = spawn(cmd, [file]);
      currentChild = child;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (currentChild === child) currentChild = undefined;
        try {
          unlinkSync(file);
        } catch {
          /* ignore */
        }
      };
      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (err) => {
        cleanup();
        rejectPlay(err);
      });
      child.once("exit", (code, sig) => {
        cleanup();
        if (signal.aborted || code === 0 || sig) resolvePlay();
        else rejectPlay(new Error(`${cmd} exited ${code}`));
      });
    });
  }

  // Direct (non-queued) play used by the /voice sample preview.
  async function playSample(text: string, config: FullVoiceConfig): Promise<void> {
    const res = await fetch(`${serverUrl()}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: config.voice, speed: config.speed }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `Server error ${res.status}`);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    const file = join(CONFIG_DIR, "voice-sample.wav");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, wav);
    await new Promise<void>((resolvePlay, rejectPlay) => {
      const cmd = process.platform === "darwin" ? "afplay" : "aplay";
      execCb(`${cmd} "${file}"`, { timeout: 30_000 }, (err) =>
        err ? rejectPlay(err) : resolvePlay(),
      );
    });
  }

  // ── Streaming auto-TTS state ──────────────────────────────────────

  let buffer = "";
  let processedLen = 0;
  let firstFlushDone = false;

  // Depth of in-flight tool executions. fork/advisor subagents run *inside* the
  // main agent's tool call, so their assistant messages stream on this same bus
  // while a tool is executing. The main agent never narrates during a tool call,
  // so we only voice messages at depth 0 — i.e. the top-level agent's output.
  let toolDepth = 0;
  pi.on("tool_execution_start", () => {
    toolDepth++;
  });
  pi.on("tool_execution_end", () => {
    if (toolDepth > 0) toolDepth--;
  });

  // biome-ignore lint/suspicious/noExplicitAny: event shape varies by runtime
  function isAssistant(message: any): boolean {
    return message?.role === "assistant";
  }

  pi.on("message_start", (event: any) => {
    if (toolDepth > 0 || !isAssistant(event.message)) return;
    // New assistant message: reset chunking state. Do NOT clear the audio
    // queue — consecutive messages in one turn should speak continuously.
    buffer = "";
    processedLen = 0;
    firstFlushDone = false;
  });

  pi.on("message_update", (event: any) => {
    const effective = getEffective();
    if (toolDepth > 0 || !effective.enabled || !isAssistant(event.message)) return;

    const text = getContent(event.message);
    if (text.length < processedLen) {
      // stream restarted / content shrank — resync
      buffer = "";
      processedLen = 0;
      firstFlushDone = false;
    }
    const next = text.slice(processedLen);
    processedLen = text.length;
    if (!next) return;

    buffer += next;
    const drained = drainBoundaries(buffer, firstFlushDone);
    buffer = drained.remainder;
    firstFlushDone = firstFlushDone || drained.chunks.length > 0;
    for (const chunk of drained.chunks) enqueueChunk(chunk);
  });

  pi.on("message_end", (event: any) => {
    if (toolDepth > 0 || !isAssistant(event.message)) return;
    const effective = getEffective();
    const tail = trimChunk(buffer);
    if (effective.enabled && tail) enqueueChunk(tail);
    buffer = "";
    processedLen = 0;
    firstFlushDone = false;
  });

  // Interrupt on a new user turn. (NOT agent_end — that fires right after
  // message_end and would cut off the final sentence.) There is no `abort`
  // extension event in the pi SDK, so a new turn is the interrupt signal.
  pi.on("turn_start", () => stopSpeech());

  // ── Server lifecycle (persistent + idle-unload) ───────────────────

  function serverScriptPath(): string {
    // Resolve the server as a sibling of this extension file, so it works
    // wherever the package is installed (not tied to a $PI_CODING_AGENT_DIR layout).
    return resolve(dirname(fileURLToPath(import.meta.url)), "server.ts");
  }

  async function fetchHealth(): Promise<Health | null> {
    try {
      const res = await fetch(`${serverUrl()}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return (await res.json()) as Health;
    } catch {
      return null;
    }
  }

  async function fetchVoices(): Promise<string[]> {
    try {
      const res = await fetch(`${serverUrl()}/voices`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      return ((await res.json()) as { voices: string[] }).voices;
    } catch {
      return [];
    }
  }

  // Which dtypes are actually downloaded on disk.
  async function fetchDownloaded(): Promise<Set<string>> {
    try {
      const res = await fetch(`${serverUrl()}/models`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return new Set();
      const data = (await res.json()) as { models: Record<string, { downloaded: boolean }> };
      return new Set(
        Object.entries(data.models)
          .filter(([, v]) => v.downloaded)
          .map(([k]) => k),
      );
    } catch {
      return new Set();
    }
  }

  // Spawn the server if it isn't already up, then ensure the configured model
  // is downloaded + activated. Fire-and-forget; never blocks session start.
  async function ensureServer(): Promise<void> {
    const cfg = getEffective();
    let health = await fetchHealth();
    if (!health) {
      const script = serverScriptPath();
      if (!existsSync(script)) {
        console.warn(`[voice] server script not found: ${script}`);
        return;
      }
      try {
        const child = spawn("bun", [script, "--idle-ms", String(cfg.idleMs)], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (err) {
        console.warn("[voice] failed to spawn server (is bun on PATH?):", err);
        return;
      }
      for (let i = 0; i < 50 && !health; i++) {
        await new Promise((r) => setTimeout(r, 200));
        health = await fetchHealth();
      }
      if (!health) {
        console.warn("[voice] server did not come up");
        return;
      }
    }
    // Ensure the model is downloaded + active (idempotent on the server).
    if (!health.modelLoaded && !health.loading) {
      startProgressPolling();
      try {
        await fetch(`${serverUrl()}/models/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dtype: cfg.dtype, activate: true }),
        });
      } catch (err) {
        console.warn("[voice] model activate failed:", err);
      }
    }
  }

  // ── /voice command ────────────────────────────────────────────────

  pi.registerCommand("voice", {
    description: "Configure TTS: enable, voice, speed, model",
    handler: async (_args, ctx) => {
      const effective = getEffective();
      const health = await fetchHealth();
      const voices = health?.modelLoaded ? await fetchVoices() : [];

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let enabled = effective.enabled;
        let voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(effective.voice)) : -1;
        let speedIdx = speedToIndex(effective.speed);
        let dtypeIdx = Math.max(0, DTYPES.indexOf(defaults.dtype));
        // Live server state — refreshed by a poller while the modal is open so
        // downloads/activations are reflected (active vs downloaded vs not).
        let liveActive = health?.activeDtype ?? null;
        let liveLoaded = health?.modelLoaded ?? false;
        let downloaded = new Set<string>();
        let selectedRow = 0;
        let playing = false;
        let playError: string | null = null;
        let feedback: string | null = null;

        const refresh = async () => {
          const [h, d] = await Promise.all([fetchHealth(), fetchDownloaded()]);
          liveActive = h?.activeDtype ?? null;
          liveLoaded = h?.modelLoaded ?? false;
          downloaded = d;
          tui.requestRender();
        };
        void refresh();
        const pollTimer = setInterval(() => void refresh(), 1500);

        const rowDefs: Array<{ id: string }> = [
          { id: "enabled" },
          ...(voices.length > 0 ? [{ id: "voice" }] : []),
          { id: "speed" },
          { id: "model" },
        ];

        const sampleText = "The quick brown fox jumps over the lazy dog.";

        function emitConfig() {
          pi.events.emit("voice:config", {
            enabled,
            voice: voices.length > 0 ? voices[voiceIdx] : defaults.voice,
            speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
          });
        }

        return {
          render(_width: number) {
            const lines: string[] = [];
            lines.push(theme.fg("accent", theme.bold("Voice")));

            const statusText = liveLoaded
              ? `● Server running (${liveActive})`
              : "○ Server up (model idle/unloaded)";
            const statusColor = liveLoaded ? "success" : "warning";
            lines.push(`  ${theme.fg(statusColor, statusText)}`);

            for (let i = 0; i < rowDefs.length; i++) {
              const row = rowDefs[i];
              const selected = i === selectedRow;
              const cursor = selected ? "→" : " ";
              const left = selected ? "◂ " : "  ";
              const right = selected ? " ▸" : "";
              if (row.id === "enabled") {
                lines.push(`${cursor} TTS    ${left}${enabled ? "on" : "off"}${right}`);
              } else if (row.id === "voice") {
                const val = voices[voiceIdx] ?? "";
                lines.push(
                  `${cursor} Voice  ${left}${val}${right} ${theme.fg("dim", `(${voiceHint(val)})`)}`,
                );
              } else if (row.id === "speed") {
                lines.push(`${cursor} Speed  ${left}${SPEED_VALUES[speedIdx]}${right}`);
              } else if (row.id === "model") {
                const d = DTYPES[dtypeIdx];
                const tag =
                  d === liveActive ? "active" : downloaded.has(d) ? "downloaded" : "not downloaded";
                lines.push(`${cursor} Model  ${left}${d}${right} ${theme.fg("dim", `(${tag})`)}`);
              }
            }

            lines.push("");
            if (playing) lines.push(`  ${theme.fg("warning", "▶ Playing sample…")}`);
            else if (playError) lines.push(`  ${theme.fg("error", `✗ ${playError}`)}`);
            else if (feedback) lines.push(`  ${theme.fg("success", feedback)}`);

            lines.push(
              theme.fg(
                "dim",
                " ↑↓ navigate • ←→ change • enter sample • s save default • r reset • esc close",
              ),
            );
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              clearInterval(pollTimer);
              persistSession();
              // Apply the model choice on close — one load, only if it changed.
              const chosen = DTYPES[dtypeIdx];
              if (chosen !== liveActive) {
                startProgressPolling();
                void fetch(`${serverUrl()}/models/download`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ dtype: chosen, activate: true }),
                }).catch(() => {});
              }
              done(undefined);
              return;
            }
            if (playError) playError = null;
            if (feedback) feedback = null;
            if (playing) return;

            if (matchesKey(data, "s")) {
              const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
              defaults = {
                ...defaults,
                enabled,
                voice,
                speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
                dtype: DTYPES[dtypeIdx],
              };
              saveConfig(defaults);
              feedback = "✓ Saved as default";
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "r")) {
              session = {};
              saveConfig({ ...DEFAULT_CONFIG });
              defaults = loadConfig();
              persistSession();
              enabled = defaults.enabled;
              voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(defaults.voice)) : -1;
              speedIdx = speedToIndex(defaults.speed);
              dtypeIdx = Math.max(0, DTYPES.indexOf(defaults.dtype));
              emitConfig();
              feedback = "✓ Reset to defaults";
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "up")) {
              selectedRow = (selectedRow - 1 + rowDefs.length) % rowDefs.length;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "down")) {
              selectedRow = (selectedRow + 1) % rowDefs.length;
              tui.requestRender();
              return;
            }

            const rowId = rowDefs[selectedRow]?.id;
            if (matchesKey(data, "left") || matchesKey(data, "right")) {
              const dir = matchesKey(data, "right") ? 1 : -1;
              if (rowId === "enabled") {
                enabled = !enabled;
                session.enabled = enabled;
                if (enabled) void ensureServer().catch(() => {});
                else stopSpeech();
              } else if (rowId === "voice" && voices.length > 0) {
                voiceIdx = (voiceIdx + dir + voices.length) % voices.length;
                session.voice = voices[voiceIdx];
              } else if (rowId === "speed") {
                speedIdx = (speedIdx + dir + SPEED_VALUES.length) % SPEED_VALUES.length;
                session.speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
              } else if (rowId === "model") {
                // Selection only — do NOT load/download here. Applied on close.
                dtypeIdx = (dtypeIdx + dir + DTYPES.length) % DTYPES.length;
                const d = DTYPES[dtypeIdx];
                defaults = { ...defaults, dtype: d };
                feedback =
                  d === liveActive
                    ? `Model ${d} (active)`
                    : downloaded.has(d)
                      ? `Model ${d} — loads on close`
                      : `Model ${d} — downloads on close`;
              }
              persistSession();
              emitConfig();
              tui.requestRender();
              return;
            }

            if (matchesKey(data, "enter")) {
              playing = true;
              playError = null;
              tui.requestRender();
              const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
              playSample(sampleText, {
                ...getEffective(),
                voice,
                speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
              })
                .then(() => {
                  playing = false;
                  tui.requestRender();
                })
                .catch((err: unknown) => {
                  playing = false;
                  playError = err instanceof Error ? err.message : String(err);
                  tui.requestRender();
                });
              return;
            }
          },
        };
      });
    },
  });

  // ── Status bar ──────────────────────────────────────────────────

  function updateStatusBar() {
    if (!currentCtx) return;
    if (progressTimer) return; // poller owns the status bar during a download/load
    const effective = getEffective();
    const theme = currentCtx.ui.theme;
    const icon = effective.enabled ? theme.fg("success", "♪") : theme.fg("dim", "♪");
    currentCtx.ui.setStatus("voice", icon);
  }

  // While the server is downloading/loading a model, show progress on the
  // status bar (e.g. "♪ ↓ fp32 25%"). Self-stops when the op finishes.
  function startProgressPolling() {
    if (progressTimer) return;
    progressTimer = setInterval(async () => {
      const h = await fetchHealth();
      if (!currentCtx) return;
      const theme = currentCtx.ui.theme;
      if (h?.progress) {
        const { phase, dtype, percent } = h.progress;
        const label = phase === "download" ? `↓ ${dtype} ${percent}%` : `loading ${dtype}…`;
        currentCtx.ui.setStatus("voice", theme.fg("warning", `♪ ${label}`));
      } else if (h?.loading) {
        currentCtx.ui.setStatus("voice", theme.fg("warning", "♪ loading…"));
      } else {
        stopProgressPolling();
      }
    }, 600);
  }

  function stopProgressPolling() {
    if (!progressTimer) return;
    clearInterval(progressTimer);
    progressTimer = undefined;
    updateStatusBar();
  }

  // ── Session lifecycle ───────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    restoreSession(ctx);
    updateStatusBar();
    // Only spin up the (heavy) Kokoro server if TTS is actually enabled.
    if (getEffective().enabled)
      void ensureServer().catch((err) => console.warn("[voice] ensureServer:", err));
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    restoreSession(ctx);
    updateStatusBar();
  });

  pi.events.on("voice:config", () => updateStatusBar());

  // ── Toggle shortcut (alt+v) ──────────────────────────────────────

  pi.registerShortcut("alt+v", {
    description: "Toggle TTS on/off",
    handler: async (ctx) => {
      const effective = getEffective();
      const next = !effective.enabled;
      session.enabled = next;
      if (next) void ensureServer().catch((err) => console.warn("[voice] ensureServer:", err));
      else stopSpeech();
      persistSession();
      ctx.ui.notify(`TTS ${next ? "enabled" : "disabled"}`, "info");
      pi.events.emit("voice:config", {
        enabled: next,
        voice: effective.voice,
        speed: effective.speed,
      });
    },
  });
}
