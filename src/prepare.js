#!/usr/bin/env node

/**
 * pi-simple-voice prepare script
 *
 * Runs on install (npm "prepare" lifecycle). Writes a default config if one
 * doesn't already exist. The extension also self-heals a missing config at
 * runtime, so this is just a convenience for first-run discoverability.
 *
 * This fork speaks the assistant's output verbatim and streaming — there is
 * no summarization model and no agent_end event prompt.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  voice: "af_heart",
  speed: 1.0,
  host: "127.0.0.1",
  port: 8181,
  dtype: "q4",
  idleMs: 900000,
};

function setupDefaultConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      console.log("pi-simple-voice: Configuration file already exists at", CONFIG_FILE);
      return;
    }

    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    console.log("pi-simple-voice: Writing default configuration to", CONFIG_FILE);
    writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    console.log("pi-simple-voice: Default configuration setup complete!");
    console.log("pi-simple-voice: Edit", CONFIG_FILE, "to customize voice, speed, and model.");
  } catch (error) {
    console.error("pi-simple-voice: Error setting up default configuration:", error.message);
    process.exit(1);
  }
}

setupDefaultConfig();
