/**
 * Load dsh-model-bridge against a real-ish harness context to prove it mounts.
 *
 * This does not start the harness: it builds the minimal context surface the
 * plugin actually touches (`inject`, `effect`, `logger`, and a `ctx.llm` stand-in
 * that mimics the verified host contract) and calls `apply()`. That isolates
 * "does the plugin's own wiring work" from "did the desktop app reload its
 * profile", which are different failures with different fixes.
 *
 * Runs on its own port with its own key and settings files, so it is safe to
 * run while a real gateway is already listening on the default port.
 *
 * Run: node smoke-mount.mjs
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../index.js";

/** A port the default gateway does not use, so this never disturbs a live one. */
const PORT = 8799;
const scratch = mkdtempSync(join(tmpdir(), "dsh-model-bridge-smoke-"));
const KEY_PATH = join(scratch, "key");
const SETTINGS_PATH = join(scratch, "settings.json");
const BASE = `http://127.0.0.1:${PORT}`;
const effects = [];
const logs = [];

const logger = {
  info: (...args) => logs.push(["info", args.map(String).join(" ")]),
  warn: (...args) => logs.push(["warn", args.map(String).join(" ")]),
  error: (...args) => logs.push(["error", args.map(String).join(" ")]),
};

// Mimic the verified host shape: a live adapter on one provider, one dormant
// provider with no adapter, and a stream that ends in a terminal finish.
function makeLlm() {
  const providers = [
    { id: "workbuddy-xdpool", name: "WorkBuddy XD Pool" },
    { id: "workbuddy-xdpool-global", name: "WorkBuddy XD Pool (Global)" },
  ];
  return {
    listProviders: () => providers.map((p) => ({ ...p })),
    listModels: async (provider) => [
      { provider, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", inputModalities: ["text"] },
      { provider, id: "glm-5.3", name: "GLM 5.3", inputModalities: ["text", "image"] },
    ],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200000 },
      defaultMaxTokens: 32768,
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    }),
    stream: (options) =>
      (async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: `echo:${options.model}` };
        yield { type: "block-end", index: 0, block: { type: "text", text: `echo:${options.model}` } };
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
        yield { type: "finish", reason: { kind: "stop" } };
      })(),
  };
}

const ctx = {
  logger,
  llm: makeLlm(),
  effect(fn) {
    const disposer = fn();
    effects.push(disposer);
    return disposer;
  },
  inject(names, callback) {
    // The host resolves `llm` before calling back; mirror that by handing the
    // same context back with the service attached under its real key.
    if (names.includes("llm")) callback(ctx);
  },
};

console.log("before apply:");
console.log("  key file exists:", existsSync(KEY_PATH));

apply(ctx, { port: PORT, keyFile: KEY_PATH, settingsFile: SETTINGS_PATH });

// `apply` injects asynchronously in the real host; give the microtask queue a
// turn so the listen callback has run.
await new Promise((resolve) => setTimeout(resolve, 250));

console.log("\nlog lines:");
for (const [level, line] of logs) console.log(`  [${level}] ${line}`);

const listening = logs.some(([, line]) => line.includes(`listening on http://127.0.0.1:${PORT}`));
console.log("\nkey file exists now:", existsSync(KEY_PATH));
console.log("listening log present:", listening);
console.log("effects registered:", effects.length);

// Exercise the live gateway on the port it just bound.
const key = (await import("node:fs")).readFileSync(KEY_PATH, "utf8").trim();
const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
console.log("\n/healthz:", JSON.stringify(health));

const models = await fetch(`${BASE}/v1/models`, {
  headers: { Authorization: `Bearer ${key}` },
}).then((r) => r.json());
console.log("models:", models.data.map((m) => m.id).join(", "));

const chat = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "workbuddy-xdpool/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "ping" }],
  }),
}).then((r) => r.json());
console.log("chat content:", JSON.stringify(chat.choices?.[0]?.message?.content));

const anthropic = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "workbuddy-xdpool/deepseek-v4.1-flash",
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  }),
}).then((r) => r.json());
console.log("anthropic content:", JSON.stringify(anthropic.content?.[0]?.text));

// Tear down through the plugin's own disposer, proving cleanup is wired.
for (const dispose of effects) if (typeof dispose === "function") dispose();
await new Promise((resolve) => setTimeout(resolve, 300));
const stillUp = await fetch(`${BASE}/healthz`).then(
  () => true,
  () => false,
);
console.log("\nafter dispose, port still answering:", stillUp);

const pass =
  listening &&
  health.ok === true &&
  models.data.length === 4 &&
  chat.choices?.[0]?.message?.content === "echo:deepseek-v4.1-flash" &&
  anthropic.content?.[0]?.text === "echo:deepseek-v4.1-flash" &&
  stillUp === false;

rmSync(scratch, { recursive: true, force: true });
console.log(pass ? "\nSMOKE MOUNT: PASS" : "\nSMOKE MOUNT: FAIL");
process.exit(pass ? 0 : 1);
