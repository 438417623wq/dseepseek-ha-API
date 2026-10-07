/**
 * Tests for the settings surface: the model allow-list, its persistence, and the
 * runtime start/stop switch.
 *
 * These exercise the host half through the same `apply()` entry the harness
 * calls, with a `webServer` stand-in that captures registered routes so they can
 * be driven directly. That is the only way to cover the page's API without a
 * browser: the routes ARE the contract between the two halves.
 *
 * Run: node test-settings.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, collectModels, loadSettings, saveSettings, DEFAULT_PORT } from "../index.js";

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` 鈥?${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// Harness stand-ins
// ---------------------------------------------------------------------------

/** A temp settings path per test, so cases cannot leak into each other. */
const scratch = mkdtempSync(join(tmpdir(), "dsh-model-bridge-test-"));

function makeLlm() {
  const providers = [
    { id: "workbuddy-xdpool", name: "WorkBuddy XD Pool" },
    { id: "our-free-model", name: "Our Free Model" },
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
        yield { type: "finish", reason: { kind: "stop" } };
      })(),
  };
}

/** Boot `apply()` with a captured webServer, returning the routes it registered. */
async function mount({ settingsPath, port }) {
  // Guard: a wrong config key here once wrote the developer's real settings
  // file. The scratch dir is per-run, so this cannot fire in normal use.
  if (!settingsPath.startsWith(scratch)) throw new Error(`test refused: ${settingsPath} is outside the scratch dir`);
  const routes = new Map();
  const effects = [];
  const logs = [];
  const logger = {
    info: (...args) => logs.push(["info", args.map(String).join(" ")]),
    warn: (...args) => logs.push(["warn", args.map(String).join(" ")]),
    error: (...args) => logs.push(["error", args.map(String).join(" ")]),
  };
  const webServer = {
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route);
      return () => routes.delete(`${route.kind}:${route.path}`);
    },
  };
  const ctx = {
    logger,
    llm: makeLlm(),
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
    inject(names, callback) {
      if (names.includes("llm")) callback(ctx);
      if (names.includes("webServer")) callback({ ...ctx, webServer });
    },
  };

  apply(ctx, { settingsFile: settingsPath, port });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { routes, effects, logs };
}

/** Call a captured route the way the harness would, over a fake req/res pair. */
async function call(route, { method = "GET", url = route.path, body, origin } = {}) {
  const headers = { origin };
  const req = {
    method,
    url,
    headers,
    on(event, handler) {
      if (event === "data" && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
      if (event === "end") handler();
      return req;
    },
  };
  let status;
  let payload;
  const res = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      payload = text === undefined ? undefined : JSON.parse(text);
    },
  };
  await route.handler(req, res);
  return { status, body: payload };
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

console.log("\n== settings persistence ==");

{
  const path = join(scratch, "absent.json");
  const settings = loadSettings(path);
  check("absent file yields defaults", settings.enabled === true && settings.allowed === null, JSON.stringify(settings));
}

{
  const path = join(scratch, "roundtrip.json");
  const ok = saveSettings({ enabled: false, allowed: ["workbuddy-xdpool/glm-5.3"] }, path);
  const back = loadSettings(path);
  check("save then load round-trips", ok && back.enabled === false && back.allowed.length === 1, JSON.stringify(back));
}

{
  const path = join(scratch, "corrupt.json");
  writeFileSync(path, "{ not json");
  const settings = loadSettings(path);
  check("corrupt file falls back to defaults", settings.enabled === true && settings.allowed === null, JSON.stringify(settings));
}

{
  const path = join(scratch, "partial.json");
  writeFileSync(path, JSON.stringify({ enabled: false }));
  const settings = loadSettings(path);
  check("a missing allowed key defaults to null (expose all)", settings.enabled === false && settings.allowed === null, JSON.stringify(settings));
}

{
  const path = join(scratch, "badallowed.json");
  writeFileSync(path, JSON.stringify({ allowed: "everything" }));
  const settings = loadSettings(path);
  check("a non-array allowed falls back to null", settings.allowed === null, JSON.stringify(settings));
}

{
  const path = join(scratch, "nullelem.json");
  writeFileSync(path, JSON.stringify({ allowed: ["a", 42, null, "b"] }));
  const settings = loadSettings(path);
  check("non-string allow-list members are dropped", settings.allowed.length === 2, JSON.stringify(settings.allowed));
}

// ---------------------------------------------------------------------------
// Allow-list filtering
// ---------------------------------------------------------------------------

console.log("\n== allow-list filtering ==");

{
  const llm = makeLlm();
  const all = await collectModels(llm);
  check("no filter exposes every model", all.length === 4, `got ${all.length}`);
}

{
  const llm = makeLlm();
  const filtered = await collectModels(llm, ["workbuddy-xdpool/glm-5.3"]);
  check(
    "qualified id selects exactly one model",
    filtered.length === 1 && filtered[0].provider === "workbuddy-xdpool" && filtered[0].id === "glm-5.3",
    JSON.stringify(filtered.map((e) => `${e.provider}/${e.id}`)),
  );
}

{
  const llm = makeLlm();
  const filtered = await collectModels(llm, ["deepseek-v4.1-flash"]);
  check(
    "a bare id matches every provider serving it",
    filtered.length === 2,
    JSON.stringify(filtered.map((e) => `${e.provider}/${e.id}`)),
  );
}

{
  const llm = makeLlm();
  const filtered = await collectModels(llm, []);
  check("an empty allow-list exposes nothing", filtered.length === 0, `got ${filtered.length}`);
}

{
  const llm = makeLlm();
  const filtered = await collectModels(llm, ["nope/not-a-model"]);
  check("an unknown id selects nothing", filtered.length === 0, `got ${filtered.length}`);
}

// ---------------------------------------------------------------------------
// Runtime switch + page API
// ---------------------------------------------------------------------------

console.log("\n== runtime switch and settings API ==");

const port = 8793;
const settingsPath = join(scratch, "live.json");

{
  const { routes, effects, logs } = await mount({ settingsPath, port });
  const stateRoute = routes.get("prefix:/api/dsh-model-bridge");
  check("the settings API route is registered", stateRoute !== undefined);
  check("the status route is registered", routes.get("exact:/plugins/dsh-model-bridge/status") !== undefined);
  check("the gateway started with the plugin", logs.some(([, line]) => line.includes("listening on")));

  // --- state ---
  const state = await call(stateRoute, { url: "/api/dsh-model-bridge/state" });
  check("GET /state answers 200", state.status === 200, JSON.stringify(state.body));
  check("GET /state reports running", state.body?.running === true && state.body?.enabled === true);
  check("GET /state returns the base URL", state.body?.openaiBaseUrl === `http://127.0.0.1:${port}/v1`, state.body?.openaiBaseUrl);
  check("GET /state returns the key", typeof state.body?.key === "string" && state.body.key.length >= 32);
  check("GET /state lists every model", Array.isArray(state.body?.models) && state.body.models.length === 4, `${state.body?.models?.length}`);
  check("GET /state carries a stable id per model", state.body?.models?.[0]?.id === "workbuddy-xdpool/deepseek-v4.1-flash", state.body?.models?.[0]?.id);
  check("GET /state carries model metadata for the picker", state.body?.models?.[0]?.contextWindow === 200000 && state.body?.models?.[0]?.reasoning === true);

  // --- live gateway really is listening ---
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  check("the gateway answers /healthz", health.ok === true);

  const key = state.body.key;
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
  check("the gateway advertises all four models", models.data.length === 4, `${models.data.length}`);

  // --- narrow the selection ---
  const narrowed = await call(stateRoute, {
    method: "POST",
    url: "/api/dsh-model-bridge/settings",
    body: { allowed: ["workbuddy-xdpool/glm-5.3"] },
  });
  check("POST /settings accepts a selection", narrowed.status === 200, JSON.stringify(narrowed.body));
  check("POST /settings echoes the selection", narrowed.body?.allowed?.length === 1);

  const afterNarrow = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
  check(
    "a narrowed selection takes effect without a restart",
    afterNarrow.data.length === 1 && afterNarrow.data[0].id === "workbuddy-xdpool/glm-5.3",
    JSON.stringify(afterNarrow.data.map((m) => m.id)),
  );

  const persisted = JSON.parse(readFileSync(settingsPath, "utf8"));
  check("the selection is persisted", persisted.allowed.length === 1 && persisted.allowed[0] === "workbuddy-xdpool/glm-5.3", JSON.stringify(persisted));

  // A model that was unticked must not be callable either.
  const refused = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "workbuddy-xdpool/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  });
  check("an unticked model is refused", refused.status === 400, `status ${refused.status}`);

  const allowed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "workbuddy-xdpool/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  }).then((r) => r.json());
  check("a ticked model still answers", allowed.choices?.[0]?.message?.content === "echo:glm-5.3", JSON.stringify(allowed.choices?.[0]?.message?.content));

  // --- stop ---
  const stopped = await call(stateRoute, {
    method: "POST",
    url: "/api/dsh-model-bridge/settings",
    body: { enabled: false },
  });
  check("POST /settings can stop the gateway", stopped.status === 200 && stopped.body?.running === false, JSON.stringify(stopped.body));

  const dead = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false);
  check("a stopped gateway stops answering", dead === false);

  // --- start again ---
  const restarted = await call(stateRoute, {
    method: "POST",
    url: "/api/dsh-model-bridge/settings",
    body: { enabled: true },
  });
  check("POST /settings can start it again", restarted.status === 200 && restarted.body?.running === true, JSON.stringify(restarted.body));

  const alive = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json()).catch(() => undefined);
  check("a restarted gateway answers again", alive?.ok === true, JSON.stringify(alive));

  // --- origin policy on the page API ---
  const crossSite = await call(stateRoute, { url: "/api/dsh-model-bridge/state", origin: "https://evil.example" });
  check("a non-loopback Origin is refused", crossSite.status === 403, `status ${crossSite.status}`);

  const unknown = await call(stateRoute, { url: "/api/dsh-model-bridge/nope" });
  check("an unknown sub-route is a 404", unknown.status === 404, `status ${unknown.status}`);

  const malformed = await call(stateRoute, { method: "POST", url: "/api/dsh-model-bridge/settings", body: undefined });
  check("a malformed body is a 400", malformed.status === 400, `status ${malformed.status}`);

  // --- dispose closes the port ---
  for (const dispose of effects) if (typeof dispose === "function") dispose();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterDispose = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false);
  check("disposing the plugin closes the gateway", afterDispose === false);
}

// ---------------------------------------------------------------------------
// Disabled-at-boot behaviour
// ---------------------------------------------------------------------------

console.log("\n== disabled at boot ==");

{
  const path = join(scratch, "off-at-boot.json");
  saveSettings({ enabled: false, allowed: null }, path);
  const portOff = 8794;
  const { routes, effects, logs } = await mount({ settingsPath: path, port: portOff });

  check("a persisted off means the gateway does not bind", !logs.some(([, line]) => line.includes("listening on")));
  const listening = await fetch(`http://127.0.0.1:${portOff}/healthz`).then(() => true, () => false);
  check("nothing answers on the port", listening === false);

  const stateRoute = routes.get("prefix:/api/dsh-model-bridge");
  const state = await call(stateRoute, { url: "/api/dsh-model-bridge/state" });
  check("the page still loads while stopped", state.status === 200 && state.body?.running === false, JSON.stringify(state.body?.running));

  const on = await call(stateRoute, { method: "POST", url: "/api/dsh-model-bridge/settings", body: { enabled: true } });
  check("the switch can start it from off", on.body?.running === true, JSON.stringify(on.body));

  for (const dispose of effects) if (typeof dispose === "function") dispose();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${"=".repeat(60)}`);
console.log(`passed ${passed}, failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
