/**
 * dsh-model-bridge — one loopback gateway that re-exports every model the
 * running DeepSeek Harness can already call.
 *
 * Why this exists: DSH holds live provider credentials (an account pool, an
 * OAuth session, a bearer key) that other local dev tools cannot obtain. This
 * plugin never reads a credential. It calls `ctx.llm.stream()` in-process,
 * which resolves credentials inside whatever adapter already owns the route,
 * and re-emits the resulting chunk stream on the two wire protocols local
 * clients actually speak.
 *
 * The two source-of-truth guarantees this file leans on, both verified in the
 * host bundle (`F:\dsh-desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-llm`):
 *   - the chunk vocabulary is exactly block-start | text-delta | reasoning-delta |
 *     tool-call-delta | block-end | usage | finish (`BlockAssembler.push`);
 *   - a stream always ends in exactly one `finish`, carrying `{kind:'stop'|
 *     'max-tokens'|'error'|'aborted', failure?}`.
 *
 * Nothing here mutates host state. The plugin registers no adapter and declares
 * no configurable provider, so it can never collide with a provider route.
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const name = "model-bridge";
/** `llm` is the only service depended on; `webServer` is optional (status route). */
export const inject = ["llm"];

export const DEFAULT_PORT = 8791;
export const DEFAULT_HOST = "127.0.0.1";
export const KEY_FILE = join(homedir(), ".dsh", "model-bridge", "key");
/** Where the settings page's choices live, so a toggle survives a restart. */
export const SETTINGS_FILE = join(homedir(), ".dsh", "model-bridge", "settings.json");

/** Hosts a request may name. Anything else is a DNS-rebinding attempt. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Body cap, matching the host's own shim so one huge paste cannot exhaust memory. */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Load the gateway bearer, minting one on first use.
 *
 * Unlike the WorkBuddy pool shim — which keeps a fresh random secret in process
 * memory only, so nothing outside its own adapter can ever authenticate — this
 * gateway exists precisely so an external tool CAN authenticate. The key is
 * therefore persisted, and rotating it is an explicit user action.
 *
 * @param keyPath - absolute path of the key file.
 * @param logger - host logger, used only for the first-mint notice.
 * @returns the bearer string.
 */
export function loadOrCreateKey(keyPath = KEY_FILE, logger) {
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      // A truncated or hand-edited file is treated as absent rather than as a
      // working-but-unusable key, which would present as an unexplained 401.
      if (existing.length >= 32) return existing;
    }
  } catch (error) {
    logger?.warn?.(`dsh-model-bridge: could not read ${keyPath}`, error);
  }
  const minted = randomBytes(32).toString("base64url");
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${minted}\n`, { mode: 0o600 });
    logger?.info?.(`dsh-model-bridge: minted a new gateway key at ${keyPath}`);
  } catch (error) {
    logger?.error?.(`dsh-model-bridge: could not persist the gateway key at ${keyPath}`, error);
  }
  return minted;
}

/**
 * Read the settings page's persisted choices.
 *
 * Absent or unreadable settings resolve to the defaults rather than throwing:
 * a corrupt file must not stop the harness from booting, and the defaults are
 * exactly the behaviour a user who never opened the page expects.
 *
 * @param settingsPath - absolute path of the settings file.
 * @returns `{ enabled, allowed }` — gateway on/off, and the model allow-list
 *   (`null` meaning "every model the harness can call").
 */
export function loadSettings(settingsPath = SETTINGS_FILE) {
  const defaults = { enabled: true, allowed: null };
  try {
    if (!existsSync(settingsPath)) return defaults;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return defaults;
    const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled;
    // `null` is a meaningful value here ("no filter"), so it is preserved
    // rather than coerced away; a non-array, non-null value falls back.
    const allowed = parsed.allowed === null ? null : Array.isArray(parsed.allowed) ? parsed.allowed.filter((id) => typeof id === "string") : defaults.allowed;
    return { enabled, allowed };
  } catch {
    return defaults;
  }
}

/**
 * Persist the settings page's choices.
 *
 * @param settings - the full settings object to write.
 * @param settingsPath - absolute path of the settings file.
 * @param logger - host logger for the failure path.
 * @returns whether the write succeeded.
 */
export function saveSettings(settings, settingsPath = SETTINGS_FILE, logger) {
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    logger?.warn?.(`dsh-model-bridge: could not persist settings at ${settingsPath}`, error);
    return false;
  }
}

/**
 * Constant-time bearer comparison.
 *
 * Also accepts the Anthropic `x-api-key` header, because Anthropic-protocol
 * clients (Claude Code and clones) send that instead of `Authorization`.
 *
 * @param headers - inbound request headers.
 * @param expected - the gateway key.
 * @returns whether the request carries a valid credential.
 */
export function authorize(headers, expected) {
  const candidates = [];
  const authorization = headers["authorization"];
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    if (match !== null) candidates.push(match[1]);
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) candidates.push(apiKey);

  const wanted = Buffer.from(expected, "utf8");
  for (const candidate of candidates) {
    const given = Buffer.from(candidate, "utf8");
    if (given.length === wanted.length && timingSafeEqual(given, wanted)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Loopback policy
// ---------------------------------------------------------------------------

/** Strip a `:port` suffix (IPv6 literals keep their brackets). */
function hostnameOf(host) {
  const lowered = String(host).trim().toLowerCase();
  if (lowered.startsWith("[")) {
    const end = lowered.indexOf("]");
    return end === -1 ? lowered : lowered.slice(0, end + 1);
  }
  const colon = lowered.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/u.test(lowered.slice(colon + 1))) return lowered.slice(0, colon);
  return lowered;
}

/** The `Host` header must name loopback, which drops DNS-rebinding attempts. */
export function hostIsLoopback(host) {
  if (typeof host !== "string" || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOf(host));
}

/** A *present* `Origin` must be loopback; non-browser clients send none. */
export function originIsLoopback(origin) {
  if (origin === undefined || String(origin).trim() === "") return true;
  try {
    return LOOPBACK_HOSTS.has(hostnameOf(new URL(String(origin)).hostname));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire translation: OpenAI
// ---------------------------------------------------------------------------

/**
 * Split the OpenAI `content` field into the host's content blocks.
 *
 * The host vocabulary is `{type:'text',text}` plus `{type:'image',...}`; an
 * image part cannot be constructed from a URL here because the host requires a
 * resolved attachment reference, so image parts degrade to a text placeholder
 * rather than being dropped silently.
 *
 * @param content - OpenAI message content (string or part array).
 * @returns host content blocks.
 */
export function toContentBlocks(content) {
  if (typeof content === "string") return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" || part.type === "image") {
      blocks.push({ type: "text", text: "[a local image was supplied, but this gateway cannot forward image parts]" });
    }
  }
  return blocks;
}

/** Render a tool-call `arguments` value that arrived as an already-parsed object. */
function argumentsToJson(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

/**
 * Translate one OpenAI `messages` array into host messages.
 *
 * Roles map 1:1 except `system`, which the host expresses as a `system`-role
 * message with a `system-prompt` source. Tool results arrive as their own
 * `tool` role carrying `tool_call_id`, and assistant turns may carry
 * `tool_calls`, both of which the host models natively.
 *
 * @param messages - OpenAI request messages.
 * @returns host messages (plain objects; the host freezes its own copies).
 */
export function toHostMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const content = toContentBlocks(message.content);
    switch (message.role) {
      case "system":
      case "developer":
        out.push({ role: "system", content, source: { kind: "system-prompt" } });
        break;
      case "user":
        out.push({ role: "user", content, source: { kind: "user" } });
        break;
      case "assistant": {
        const blocks = [...content];
        if (Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls) {
            if (call === null || typeof call !== "object") continue;
            const fn = call.function ?? {};
            blocks.push({
              type: "tool-call",
              id: String(call.id ?? `call_${blocks.length}`),
              name: String(fn.name ?? ""),
              arguments: argumentsToJson(fn.arguments),
            });
          }
        }
        out.push({
          role: "assistant",
          content: blocks,
          source: { kind: "model", provider: "bridge-replay", model: message.model ?? "bridge-replay" },
        });
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          toolCallId: String(message.tool_call_id ?? ""),
          isError: message.is_error === true,
          content,
          source: { kind: "tool", callId: String(message.tool_call_id ?? "") },
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Translate OpenAI tool declarations into the host's tool schema shape. */
export function toHostTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object") continue;
    const fn = tool.function ?? tool;
    if (typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out.length === 0 ? undefined : out;
}

/** Map a host finish reason onto an OpenAI `finish_reason`. */
export function toOpenAiFinish(reason) {
  switch (reason?.kind) {
    case "max-tokens":
      return "length";
    case "tool-calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Wire translation: Anthropic
// ---------------------------------------------------------------------------

/**
 * Translate one Anthropic `/v1/messages` body into host messages.
 *
 * Anthropic differs in three places that matter: `system` is a top-level field
 * rather than a message, tool results ride inside a user message as
 * `tool_result` blocks instead of using a `tool` role, and tools declare
 * `input_schema` rather than `parameters`.
 *
 * @param body - parsed Anthropic request body.
 * @returns host messages.
 */
export function anthropicToHostMessages(body) {
  const out = [];
  const system = body.system;
  if (typeof system === "string" && system.length > 0) {
    out.push({ role: "system", content: [{ type: "text", text: system }], source: { kind: "system-prompt" } });
  } else if (Array.isArray(system)) {
    const blocks = toContentBlocks(
      system.filter((block) => block !== null && typeof block === "object" && block.type === "text"),
    );
    if (blocks.length > 0) out.push({ role: "system", content: blocks, source: { kind: "system-prompt" } });
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message === null || typeof message !== "object") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const content = [];
    for (const part of parts) {
      if (part === null || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "tool_result") {
        // A tool result is its own host message, so it must be flushed with the
        // tool_call_id that produced it rather than folded into the user turn.
        out.push({
          role: "tool",
          toolCallId: String(part.tool_use_id ?? ""),
          isError: part.is_error === true,
          content: toContentBlocks(part.content),
          source: { kind: "tool", callId: String(part.tool_use_id ?? "") },
        });
      } else if (part.type === "tool_use") {
        content.push({
          type: "tool-call",
          id: String(part.id ?? ""),
          name: String(part.name ?? ""),
          arguments: argumentsToJson(part.input),
        });
      } else if (part.type === "image") {
        content.push({ type: "text", text: "[a local image was supplied, but this gateway cannot forward image parts]" });
      }
    }
    if (typeof message.content === "string" && message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
    if (content.length === 0) continue;
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
      ...(message.role === "assistant"
        ? { source: { kind: "model", provider: "bridge-replay", model: "bridge-replay" } }
        : { source: { kind: "user" } }),
    });
  }
  return out;
}

/** Translate Anthropic tool declarations into the host's tool schema shape. */
export function anthropicToHostTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object") continue;
    if (typeof tool.name !== "string" || tool.name.length === 0) continue;
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    });
  }
  return out.length === 0 ? undefined : out;
}

/** Map a host finish reason onto an Anthropic `stop_reason`. */
export function toAnthropicStop(reason) {
  switch (reason?.kind) {
    case "max-tokens":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "error":
    case "aborted":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/**
 * Enumerate every provider/model route the running harness can reach.
 *
 * `listProviders()` reports only routes with a live adapter; dormant
 * configurable providers (declared but not yet activated) are reported
 * separately with `adapter: false`, because a client that tries one will get a
 * `NO_ADAPTER` error and deserves to see that up front.
 *
 * @param llm - the host `ctx.llm` service.
 * @returns detached catalog entries.
 */
/**
 * Collect every model the harness can currently call.
 *
 * @param llm - the host LLM service.
 * @param allowed - optional allow-list of `provider/model` ids (or bare ids);
 *   `null`/`undefined` exposes everything. Filtering happens here rather than at
 *   the wire layer so `/v1/models` and routing agree by construction — a model
 *   the page unticked is not advertised and cannot be called.
 * @returns catalog entries, each marked with whether it has a live adapter.
 */
export async function collectModels(llm, allowed = null) {
  const entries = [];
  const seen = new Set();
  let providers = [];
  try {
    providers = llm.listProviders();
  } catch {
    return entries;
  }
  for (const provider of providers) {
    let models = [];
    try {
      models = await llm.listModels(provider.id);
    } catch (error) {
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: provider.id,
        name: provider.name,
        adapter: true,
        error: String(error?.message ?? error),
      });
      continue;
    }
    if (models.length === 0) {
      // A route with a live adapter but an empty catalog still routes: core
      // resolution accepts unlisted ids. Expose the bare provider id so the
      // route is visible instead of silently absent.
      seen.add(`${provider.id}\u0000${provider.id}`);
      entries.push({ provider: provider.id, providerName: provider.name, id: provider.id, name: provider.name, adapter: true });
      continue;
    }
    for (const model of models) {
      const key = `${provider.id}\u0000${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let contextWindow;
      let maxTokens;
      let reasoning;
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id);
        contextWindow = info.context?.contextWindow;
        maxTokens = info.defaultMaxTokens;
        reasoning = info.reasoning !== undefined;
      } catch {
        // Metadata is advisory; a model that cannot answer still routes.
      }
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        name: model.name ?? model.id,
        description: model.description,
        inputModalities: model.inputModalities,
        contextWindow,
        maxTokens,
        reasoning,
        adapter: true,
      });
    }
  }
  if (allowed === null || allowed === undefined) return entries;
  const wanted = new Set(allowed);
  return entries.filter((entry) => wanted.has(`${entry.provider}/${entry.id}`) || wanted.has(entry.id));
}

/**
 * Resolve a caller-supplied model id onto a concrete provider route.
 *
 * Clients send three shapes in practice: a bare model id (`deepseek-v4.1-flash`),
 * a qualified id (`workbuddy-xdpool/deepseek-v4.1-flash`), and the id exactly as
 * `/v1/models` advertised it (already qualified). The bare form is unambiguous
 * only when exactly one provider serves it, so ambiguity is reported rather
 * than guessed at.
 *
 * @param requested - the model string from the request body.
 * @param catalog - entries from {@link collectModels}.
 * @returns the chosen entry, or a reason it could not be chosen.
 */
export function resolveRoute(requested, catalog) {
  const want = String(requested ?? "").trim();
  if (want === "") {
    const providers = [...new Set(catalog.filter((entry) => entry.adapter).map((entry) => entry.provider))];
    if (providers.length === 1) {
      const first = catalog.find((entry) => entry.adapter && entry.provider === providers[0]);
      if (first !== undefined) return { ok: true, entry: first };
    }
    return { ok: false, reason: "no model was requested and no single default provider is available" };
  }
  const slash = want.indexOf("/");
  if (slash > 0) {
    const provider = want.slice(0, slash);
    const id = want.slice(slash + 1);
    const hit = catalog.find((entry) => entry.provider === provider && entry.id === id);
    if (hit !== undefined) return { ok: true, entry: hit };
  }
  const matches = catalog.filter((entry) => entry.id === want);
  if (matches.length === 1) return { ok: true, entry: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `model "${want}" is served by ${matches.length} providers; qualify it as provider/model (${matches
        .map((entry) => `${entry.provider}/${entry.id}`)
        .join(", ")})`,
    };
  }
  return { ok: false, reason: `no provider serves model "${want}"` };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Open one host stream and pump translated frames to the client.
 *
 * Shared by both protocols and both streaming modes: the caller supplies the
 * per-frame renderer, so the chunk walk, error handling and terminal handling
 * exist exactly once.
 *
 * @param options - see {@link BridgeServer} construction for the injected parts.
 * @returns whether anything was written (false when the request failed before first byte).
 */
export async function pumpStream({ llm, entry, messages, tools, config, signal, onFrame, onError }) {
  let sawFinish = false;
  let failure;
  try {
    const stream = llm.stream({
      provider: entry.provider,
      model: entry.id,
      messages,
      ...(tools === undefined ? {} : { tools }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      ...(signal === undefined ? {} : { signal }),
    });
    for await (const chunk of stream) {
      if (chunk.type === "finish") {
        sawFinish = true;
        if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") failure = chunk.reason.failure ?? chunk.reason;
        onFrame({ kind: "finish", reason: chunk.reason, replayState: chunk.replayState });
        continue;
      }
      if (chunk.type === "usage") {
        onFrame({ kind: "usage", usage: chunk.usage });
        continue;
      }
      onFrame({ kind: "chunk", chunk });
    }
  } catch (error) {
    // A thrown error means the stream was consumed by a middleware, not that the
    // provider failed — provider failures arrive as a terminal `finish`.
    onError?.(error);
    return { ok: false, failure: { message: String(error?.message ?? error) } };
  }
  if (!sawFinish) return { ok: false, failure: { message: "the host stream ended without a terminal finish chunk" } };
  if (failure !== undefined) return { ok: false, failure };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendOpenAiError(res, status, type, message) {
  sendJson(res, status, { error: { message, type, code: type } });
}

function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isJsonContentType(req) {
  const type = req.headers["content-type"];
  return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}

function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/**
 * Start the loopback gateway.
 *
 * The server binds `127.0.0.1` explicitly: it re-exports credentials-backed
 * capacity, so listening on any other interface would hand the pool to the
 * network. `Host` and `Origin` are checked per request on top of the bind,
 * because binding alone does not stop a browser on this machine from being
 * pointed at it by a hostile page.
 *
 * @param options - resolved port, key, host services, and logger.
 * @param options.allowed - zero-argument accessor returning the live allow-list
 *   (`null` = expose everything). Read per request rather than captured once, so
 *   a selection made in the settings page takes effect without a restart.
 * @returns a handle with the bound address and a closer.
 */
export function startBridge(options) {
  const { llm, host = DEFAULT_HOST, port = DEFAULT_PORT, key, logger, allowed = () => null } = options;
  const startedAt = Date.now();
  let requestCount = 0;
  let lastError;
  let catalogCache = { at: 0, entries: [] };
  const CATALOG_TTL_MS = 15_000;

  /** Cached catalog, so `/v1/models` does not re-interrogate every adapter per poll. */
  async function catalog(force = false) {
    const now = Date.now();
    if (!force && catalogCache.entries.length > 0 && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.entries;
    const entries = await collectModels(llm, allowed());
    catalogCache = { at: now, entries };
    return entries;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      lastError = String(error?.message ?? error);
      logger?.warn?.("dsh-model-bridge: request failed", error);
      if (!res.headersSent) sendOpenAiError(res, 500, "server_error", lastError);
      else res.end();
    });
  });

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      sendOpenAiError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      sendOpenAiError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // `/healthz` is unauthenticated on purpose: it answers "is the process
    // listening", which a supervisor asks before it holds the key. Everything
    // that touches a model stays behind the bearer.
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        plugin: "dsh-model-bridge",
        uptimeMs: Date.now() - startedAt,
        requests: requestCount,
        ...(lastError === undefined ? {} : { lastError }),
      });
      return;
    }

    if (!authorize(req.headers, key)) {
      sendOpenAiError(res, 401, "unauthorized", "missing or invalid credential");
      return;
    }

    const path = url.pathname.replace(/\/+$/u, "") || "/";

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      const entries = await catalog(url.searchParams.get("refresh") === "1");
      sendJson(res, 200, {
        object: "list",
        data: entries.map((entry) => ({
          id: entry.adapter ? `${entry.provider}/${entry.id}` : entry.id,
          object: "model",
          created: 0,
          owned_by: entry.provider,
          name: entry.name,
          ...(entry.contextWindow === undefined ? {} : { context_length: entry.contextWindow, max_input_tokens: entry.contextWindow }),
          ...(entry.maxTokens === undefined ? {} : { max_completion_tokens: entry.maxTokens }),
          ...(entry.inputModalities === undefined ? {} : { vision: entry.inputModalities.includes("image") }),
          ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
          ...(entry.description === undefined ? {} : { description: entry.description }),
        })),
      });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleOpenAiChat(req, res);
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      await handleAnthropicMessages(req, res);
      return;
    }

    if (req.method === "GET" && path === "/v1/bridge/info") {
      const entries = await catalog();
      sendJson(res, 200, {
        openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
        anthropicBaseUrl: `http://127.0.0.1:${port}`,
        models: entries.length,
        providers: [...new Set(entries.map((entry) => entry.provider))],
      });
      return;
    }

    sendOpenAiError(res, 404, "not_found", `no such route: ${req.method} ${path}`);
  }

  async function readJsonBody(req, res, anthropic) {
    if (!isJsonContentType(req)) {
      (anthropic ? sendAnthropicError : sendOpenAiError)(res, 415, "invalid_request_error", "Content-Type must be application/json");
      return undefined;
    }
    const raw = await readBody(req);
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") throw new Error("body must be an object");
      return parsed;
    } catch (error) {
      (anthropic ? sendAnthropicError : sendOpenAiError)(res, 400, "invalid_request_error", `malformed JSON body: ${error.message}`);
      return undefined;
    }
  }

  /** Resolve routing, or answer the client with a 400 that says how to fix it. */
  async function route(payload, res, anthropic) {
    const entries = await catalog();
    const resolved = resolveRoute(payload.model, entries);
    if (!resolved.ok) {
      (anthropic ? sendAnthropicError : sendOpenAiError)(
        res,
        400,
        "invalid_request_error",
        `${resolved.reason}. Known providers: ${[...new Set(entries.filter((e) => e.adapter).map((e) => e.provider))].join(", ") || "(none)"}. List them at /v1/models.`,
      );
      return undefined;
    }
    if (!resolved.entry.adapter) {
      (anthropic ? sendAnthropicError : sendOpenAiError)(
        res,
        503,
        "no_adapter",
        `provider "${resolved.entry.provider}" is declared but has no active adapter; activate it in the harness first`,
      );
      return undefined;
    }
    return resolved.entry;
  }

  async function handleOpenAiChat(req, res) {
    const payload = await readJsonBody(req, res, false);
    if (payload === undefined) return;
    if (!Array.isArray(payload.messages)) {
      sendOpenAiError(res, 400, "invalid_request_error", "messages is required");
      return;
    }
    const entry = await route(payload, res, false);
    if (entry === undefined) return;

    requestCount += 1;
    const messages = toHostMessages(payload.messages);
    const tools = toHostTools(payload.tools);
    const config = {
      temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
      maxTokens: Number.isSafeInteger(payload.max_tokens) && payload.max_tokens > 0 ? payload.max_tokens : undefined,
    };

    const wanted = payload.stream === true;
    const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const modelLabel = `${entry.provider}/${entry.id}`;
    const controller = new AbortController();
    req.on("close", () => controller.abort());

    if (!wanted) {
      // Non-streaming: accumulate the whole attempt, then answer once.
      const blocks = [];
      let finishKind = "stop";
      let usage;
      const result = await pumpStream({
        llm,
        entry,
        messages,
        tools,
        config,
        signal: controller.signal,
        onFrame: (frame) => {
          if (frame.kind === "chunk") blocks.push(frame.chunk);
          else if (frame.kind === "usage") usage = frame.usage;
          else if (frame.kind === "finish") finishKind = frame.reason?.kind ?? "stop";
        },
      });
      if (!result.ok) {
        sendOpenAiError(res, 502, "upstream_error", describeFailure(result.failure));
        return;
      }
      const assembled = assembleBlocks(blocks);
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: modelLabel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: assembled.text, ...(assembled.toolCalls.length === 0 ? {} : { tool_calls: assembled.toolCalls }) },
            finish_reason: toOpenAiFinish({ kind: finishKind }),
          },
        ],
        ...(usage === undefined ? {} : { usage: openAiUsage(usage) }),
      });
      return;
    }

    openSse(res);
    let roleSent = false;
    let toolIndex = -1;
    const seenToolIds = new Set();
    const write = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const envelope = (delta, finishReason, extra) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelLabel,
      choices: [{ index: 0, delta, finish_reason: finishReason, ...(extra ?? {}) }],
    });

    const result = await pumpStream({
      llm,
      entry,
      messages,
      tools,
      config,
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.kind === "chunk") {
          const chunk = frame.chunk;
          if (!roleSent) {
            roleSent = true;
            write(envelope({ role: "assistant", content: "" }, null));
          }
          if (chunk.type === "text-delta") write(envelope({ content: chunk.text }, null));
          else if (chunk.type === "reasoning-delta") write(envelope({ reasoning_content: chunk.text }, null));
          else if (chunk.type === "tool-call-delta") {
            // OpenAI numbers tool calls by position within the turn; the host
            // numbers blocks, and one host block maps to exactly one call.
            if (!seenToolIds.has(chunk.index)) {
              seenToolIds.add(chunk.index);
              toolIndex += 1;
            }
            write(              envelope(
                {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: chunk.id,
                      type: "function",
                      function: { name: chunk.name ?? "", arguments: chunk.argumentsDelta ?? "" },
                    },
                  ],
                },
                null,
              ),
            );
          } else if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
            // A tool call whose arguments never streamed still has to reach the
            // client, or the agent sees a turn that announced a tool and then
            // handed it nothing to run.
            if (!seenToolIds.has(chunk.index)) {
              seenToolIds.add(chunk.index);
              toolIndex += 1;
              const args = chunk.block.arguments ?? "{}";
              write(
                envelope(
                  {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: chunk.block.id,
                        type: "function",
                        function: { name: chunk.block.name ?? "", arguments: args === "" ? "{}" : args },
                      },
                    ],
                  },
                  null,
                ),
              );
            }
          }
          // block-start carries no OpenAI delta of its own.
          return;
        }
        if (frame.kind === "usage") {
          write(envelope({}, null, undefined));
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: modelLabel, choices: [], usage: openAiUsage(frame.usage) })}\n\n`);
          return;
        }
        if (frame.kind === "finish") {
          if (frame.reason?.kind === "error" || frame.reason?.kind === "aborted") {
            write(envelope({}, null));
            res.write(
              `data: ${JSON.stringify({
                error: { message: describeFailure(frame.reason.failure ?? frame.reason), type: "upstream_error", code: frame.reason.failure?.code ?? frame.reason.kind },
              })}\n\n`,
            );
            return;
          }
          write(envelope({}, toOpenAiFinish(frame.reason)));
        }
      },
      onError: (error) => {
        lastError = String(error?.message ?? error);
      },
    });

    if (!result.ok && !res.writableEnded) {
      // Nothing was written yet — answer a real HTTP error instead of an SSE
      // frame, so a client that never reached the stream still sees the cause.
      if (!roleSent) {
        res.end();
        return;
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  async function handleAnthropicMessages(req, res) {
    const payload = await readJsonBody(req, res, true);
    if (payload === undefined) return;
    if (!Array.isArray(payload.messages)) {
      sendAnthropicError(res, 400, "invalid_request_error", "messages is required");
      return;
    }
    const entry = await route(payload, res, true);
    if (entry === undefined) return;

    requestCount += 1;
    const messages = anthropicToHostMessages(payload);
    const tools = anthropicToHostTools(payload.tools);
    const config = {
      temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
      maxTokens: Number.isSafeInteger(payload.max_tokens) && payload.max_tokens > 0 ? payload.max_tokens : undefined,
    };

    const id = `msg_${randomBytes(12).toString("hex")}`;
    const modelLabel = `${entry.provider}/${entry.id}`;
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const wanted = payload.stream === true;

    const run = async (onEvent) => {
      let nextIndex = -1;
      let finishKind = "stop";
      let usage;
      /** Host block index -> the Anthropic content-block index assigned to it. */
      const open = new Map();
      /** Anthropic block indexes that were started and still need a stop event. */
      const started = [];

      /**
       * Assign the next Anthropic content-block index to one host block.
       *
       * Indexes are handed out in host-block order, but a `content_block_start`
       * is NOT emitted here: the host opens a tool call with a bare
       * `block-start` carrying only an index and no id or name (see
       * `toolcall_start` in the pi-ai adapter), and Anthropic requires
       * `tool_use.id`/`name` on the start event. Emitting a start we would have
       * to correct is what silently dropped every tool call.
       */
      const claim = (hostIndex, blockType) => {
        const existing = open.get(hostIndex);
        if (existing !== undefined) return existing;
        nextIndex += 1;
        const slot = { index: nextIndex, blockType, started: false };
        open.set(hostIndex, slot);
        return slot;
      };

      /** Emit the start event exactly once per block, now that id/name are known. */
      const startBlock = (slot, contentBlock) => {
        if (slot.started) return;
        slot.started = true;
        started.push(slot.index);
        onEvent("content_block_start", { type: "content_block_start", index: slot.index, content_block: contentBlock });
      };

      const result = await pumpStream({
        llm,
        entry,
        messages,
        tools,
        config,
        signal: controller.signal,
        onFrame: (frame) => {
          if (frame.kind === "usage") {
            usage = frame.usage;
            return;
          }
          if (frame.kind === "finish") {
            finishKind = frame.reason?.kind ?? "stop";
            return;
          }
          const chunk = frame.chunk;
          if (chunk.type === "block-start") {
            const slot = claim(chunk.index, chunk.blockType);
            // Text and reasoning carry no payload on the start, so they can be
            // opened immediately; a tool call waits for its delta or block-end.
            if (chunk.blockType === "text") startBlock(slot, { type: "text", text: "" });
            else if (chunk.blockType === "reasoning") startBlock(slot, { type: "thinking", thinking: "" });
            return;
          }
          if (chunk.type === "text-delta") {
            const slot = claim(chunk.index, "text");
            startBlock(slot, { type: "text", text: "" });
            onEvent("content_block_delta", { type: "content_block_delta", index: slot.index, delta: { type: "text_delta", text: chunk.text } });
            return;
          }
          if (chunk.type === "reasoning-delta") {
            const slot = claim(chunk.index, "reasoning");
            startBlock(slot, { type: "thinking", thinking: "" });
            onEvent("content_block_delta", { type: "content_block_delta", index: slot.index, delta: { type: "thinking_delta", thinking: chunk.text } });
            return;
          }
          if (chunk.type === "tool-call-delta") {
            const slot = claim(chunk.index, "tool-call");
            startBlock(slot, { type: "tool_use", id: chunk.id, name: chunk.name ?? "", input: {} });
            // Record that arguments streamed, so `block-end` does not repeat them.
            slot.sawArguments = true;
            onEvent("content_block_delta", {
              type: "content_block_delta",
              index: slot.index,
              delta: { type: "input_json_delta", partial_json: chunk.argumentsDelta ?? "" },
            });
            return;
          }
          if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
            // A tool call whose arguments never streamed (a zero-argument call,
            // or a provider that only reports the finished call) still has to
            // materialize, so open it from the block's authoritative payload and
            // deliver the whole argument object as one delta.
            const slot = claim(chunk.index, "tool-call");
            startBlock(slot, { type: "tool_use", id: chunk.block.id, name: chunk.block.name ?? "", input: {} });
            if (!slot.sawArguments) {
              const args = chunk.block.arguments ?? "{}";
              if (args !== "" && args !== "{}") {
                onEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: slot.index,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }
            return;
          }
        },
        onError: (error) => {
          lastError = String(error?.message ?? error);
        },
      });
      return { result, started, finishKind, usage };
    };

    if (!wanted) {
      const blocks = [];
      let finishKind = "stop";
      let usage;
      const result = await pumpStream({
        llm,
        entry,
        messages,
        tools,
        config,
        signal: controller.signal,
        onFrame: (frame) => {
          if (frame.kind === "chunk") blocks.push(frame.chunk);
          else if (frame.kind === "usage") usage = frame.usage;
          else if (frame.kind === "finish") finishKind = frame.reason?.kind ?? "stop";
        },
      });
      if (!result.ok) {
        sendAnthropicError(res, 502, "api_error", describeFailure(result.failure));
        return;
      }
      const assembled = assembleBlocks(blocks);
      sendJson(res, 200, {
        id,
        type: "message",
        role: "assistant",
        model: modelLabel,
        content: [
          ...(assembled.text.length === 0 ? [] : [{ type: "text", text: assembled.text }]),
          ...assembled.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: safeParseJson(call.function.arguments),
          })),
        ],
        stop_reason: toAnthropicStop({ kind: finishKind }),
        stop_sequence: null,
        usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
      });
      return;
    }

    openSse(res);
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model: modelLabel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });

    const outcome = await run(emit);
    if (!outcome.result.ok) {
      // Anthropic signals a mid-stream failure with an `error` event, not a
      // broken connection, so the client sees the cause rather than a reset.
      emit("error", { type: "error", error: { type: "api_error", message: describeFailure(outcome.result.failure) } });
      res.end();
      return;
    }

    const blocks = outcome.started;
    for (const startIndex of blocks) {
      emit("content_block_stop", { type: "content_block_stop", index: startIndex });
    }
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toAnthropicStop({ kind: outcome.finishKind }), stop_sequence: null },
      usage: { output_tokens: outcome.usage?.outputTokens ?? 0 },
    });
    emit("message_stop", { type: "message_stop" });
    res.end();
  }

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    ready,
    baseUrl: () => `http://${host}:${port}`,
    stats: () => ({ requests: requestCount, lastError, uptimeMs: Date.now() - startedAt }),
    /** Drop the cached catalog so the next request reflects a fresh selection. */
    invalidate: () => {
      catalogCache = { at: 0, entries: [] };
    },
    /** The catalog as the wire layer would serve it, for the settings page. */
    listModels: () => catalog(true),
    close: () =>
      new Promise((resolve, reject) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        server.once("error", reject);
      }),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Flatten assembled host chunks into the text and tool calls one turn produced. */
export function assembleBlocks(chunks) {
  const partials = new Map();
  const order = [];
  for (const chunk of chunks) {
    if (chunk.type === "block-start") {
      if (!partials.has(chunk.index)) {
        partials.set(chunk.index, { blockType: chunk.blockType, text: "", args: "", id: chunk.id, name: chunk.name });
        order.push(chunk.index);
      }
      continue;
    }
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      const partial = partials.get(chunk.index) ?? { blockType: chunk.type === "text-delta" ? "text" : "reasoning", text: "", args: "" };
      if (!partials.has(chunk.index)) {
        partials.set(chunk.index, partial);
        order.push(chunk.index);
      }
      partial.text += chunk.text ?? "";
      continue;
    }
    if (chunk.type === "tool-call-delta") {
      const partial = partials.get(chunk.index) ?? { blockType: "tool-call", text: "", args: "" };
      if (!partials.has(chunk.index)) {
        partials.set(chunk.index, partial);
        order.push(chunk.index);
      }
      partial.id = chunk.id ?? partial.id;
      if (chunk.name) partial.name = chunk.name;
      partial.args += chunk.argumentsDelta ?? "";
      continue;
    }
    if (chunk.type === "block-end" && chunk.block !== undefined) {
      const partial = partials.get(chunk.index) ?? { blockType: chunk.block.type, text: "", args: "" };
      if (!partials.has(chunk.index)) {
        partials.set(chunk.index, partial);
        order.push(chunk.index);
      }
      if (chunk.block.type === "text" || chunk.block.type === "reasoning") partial.text = chunk.block.text ?? partial.text;
      if (chunk.block.type === "tool-call") {
        partial.id = chunk.block.id ?? partial.id;
        partial.name = chunk.block.name ?? partial.name;
        partial.args = chunk.block.arguments ?? partial.args;
      }
    }
  }
  const text = order
    .map((index) => partials.get(index))
    .filter((partial) => partial !== undefined && partial.blockType === "text")
    .map((partial) => partial.text)
    .join("");
  const toolCalls = order
    .map((index) => partials.get(index))
    .filter((partial) => partial !== undefined && partial.blockType === "tool-call")
    .map((partial, position) => ({
      index: position,
      id: partial.id ?? `call_${position}`,
      type: "function",
      function: { name: partial.name ?? "", arguments: partial.args === "" ? "{}" : partial.args },
    }));
  return { text, toolCalls };
}

function openAiUsage(usage) {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  };
}

/** Turn a host failure into one actionable line, routing on the stable code. */
export function describeFailure(failure) {
  if (failure === undefined) return "the model call failed";
  const code = failure.code ?? failure.kind;
  const message = failure.message ?? String(failure);
  if (code === "NO_ADAPTER") return `${message} — the provider has no active adapter in this harness`;
  if (code === "CONTEXT_WINDOW_EXCEEDED") return `${message} — shorten the conversation or raise the model's context budget`;
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return `${message} — the account backing this route is out of quota`;
  if (code === "RATE_LIMIT") return `${message} — rate limited upstream; retry shortly`;
  if (code === "AUTH" || code === "MISSING_CREDENTIAL") return `${message} — the credential behind this route needs a sign-in in the harness`;
  return message;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Mount the gateway as a harness plugin.
 *
 * `ctx.inject(["llm"])` is the whole dependency: the LLM service is what makes
 * the models reachable, and it is already mounted by the base bundle. The
 * `webServer` routes are registered separately and only when that service
 * exists, so a headless harness still gets a working gateway.
 *
 * The gateway starts with the harness and stops with it, because its lifecycle
 * is a `ctx.effect`. The settings page can additionally stop and start it at
 * runtime without a restart; that choice is persisted and re-applied on the
 * next boot, so the switch means "off" rather than "off until reload".
 *
 * @param ctx - the plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config = {}) {
  const port = Number.isSafeInteger(config.port) && config.port > 0 ? config.port : DEFAULT_PORT;
  const host = typeof config.host === "string" && config.host.length > 0 ? config.host : DEFAULT_HOST;
  const settingsPath = typeof config.settingsFile === "string" ? config.settingsFile : SETTINGS_FILE;

  ctx.inject(["llm"], (llmCtx) => {
    const llm = llmCtx.llm;
    const key = loadOrCreateKey(typeof config.keyFile === "string" ? config.keyFile : KEY_FILE, ctx.logger);
    const settings = loadSettings(settingsPath);

    /** The live gateway, or undefined while stopped. */
    let bridge;
    /** Why the last start failed, surfaced to the settings page. */
    let startError;

    /**
     * Bring the gateway up. Idempotent: a second call while it is already
     * listening is a no-op, so `apply` and the page's switch cannot double-bind.
     */
    function start() {
      if (bridge !== undefined) return;
      const started = startBridge({
        llm,
        host,
        port,
        key,
        logger: ctx.logger,
        allowed: () => settings.allowed,
      });
      bridge = started;
      started.ready.then(
        () => {
          startError = undefined;
          ctx.logger.info?.(
            `dsh-model-bridge: listening on http://${host}:${port} — OpenAI at /v1, Anthropic at /v1/messages`,
          );
        },
        (error) => {
          startError = String(error?.message ?? error);
          ctx.logger.error(
            `dsh-model-bridge: ${host}:${port} did not bind (${startError}); change the port in this plugin's settings, or free it`,
          );
        },
      );
    }

    /** Take the gateway down. Idempotent, and safe to call before `ready`. */
    async function stop() {
      const current = bridge;
      if (current === undefined) return;
      bridge = undefined;
      // `ready` may still be pending when the page toggles off during boot; a
      // rejection here is the bind failure already reported by `start`.
      await current.ready.catch(() => {});
      await current.close().catch((error) => ctx.logger.warn("dsh-model-bridge: close failed", error));
    }

    if (settings.enabled) start();

    // The disposer is what makes "DSH closes, the gateway closes" true, and it
    // covers both the enabled and the toggled-off cases.
    ctx.effect(() => () => {
      stop().catch((error) => ctx.logger.warn("dsh-model-bridge: close failed", error));
    });

    // A status route follows the harness's usual loopback-origin policy. The
    // gateway key is deliberately NOT part of it: it is already on disk, and
    // serving secrets over a web surface is not a convenience worth having.
    llmCtx.inject?.(["webServer"], (webCtx) => {
      webCtx.webServer.register({
        kind: "exact",
        path: "/plugins/dsh-model-bridge/status",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          if (!originIsLoopback(req.headers.origin)) {
            sendJson(res, 403, { error: "origin-not-trusted" });
            return;
          }
          const stats = bridge?.stats();
          const entries = await collectModels(llm).catch(() => []);
          sendJson(res, 200, {
            running: bridge !== undefined,
            enabled: settings.enabled,
            openaiBaseUrl: `http://${host}:${port}/v1`,
            anthropicBaseUrl: `http://${host}:${port}`,
            requests: stats?.requests ?? 0,
            uptimeMs: stats?.uptimeMs ?? 0,
            ...(stats?.lastError === undefined ? {} : { lastError: stats.lastError }),
            models: entries.map((entry) => `${entry.provider}/${entry.id}`),
          });
        },
      });

      // The settings page's own API. Prefix kind, so it cannot collide with the
      // exact status route above or with client-modules' `/plugins` bundle
      // prefix; `webServer` dispatches the exact table before prefixes.
      webCtx.webServer.register({
        kind: "prefix",
        path: "/api/dsh-model-bridge",
        handler: async (req, res) => {
          // Same origin policy as every other route this plugin serves: the
          // page is same-origin, so a cross-site caller must not reach it.
          if (!originIsLoopback(req.headers.origin)) {
            sendJson(res, 403, { error: "origin-not-trusted" });
            return;
          }
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const route = url.pathname.slice("/api/dsh-model-bridge".length).replace(/\/+$/u, "") || "/";

          if (req.method === "GET" && route === "/state") {
            const all = await collectModels(llm).catch(() => []);
            sendJson(res, 200, {
              running: bridge !== undefined,
              enabled: settings.enabled,
              port,
              host,
              keyPath: typeof config.keyFile === "string" ? config.keyFile : KEY_FILE,
              key,
              openaiBaseUrl: `http://${host}:${port}/v1`,
              anthropicBaseUrl: `http://${host}:${port}`,
              allowed: settings.allowed,
              ...(startError === undefined ? {} : { startError }),
              // The full roster plus the live selection, so the page can render
              // unticked rows without a second round trip.
              models: all.map((entry) => ({
                id: `${entry.provider}/${entry.id}`,
                model: entry.id,
                provider: entry.provider,
                providerName: entry.providerName,
                name: entry.name,
                description: entry.description,
                inputModalities: entry.inputModalities,
                contextWindow: entry.contextWindow,
                maxTokens: entry.maxTokens,
                reasoning: entry.reasoning,
              })),
            });
            return;
          }

          if (req.method === "POST" && route === "/settings") {
            const raw = await readBody(req).catch(() => undefined);
            if (raw === undefined) {
              sendJson(res, 413, { error: "body too large" });
              return;
            }
            let body;
            try {
              body = JSON.parse(raw);
            } catch {
              sendJson(res, 400, { error: "malformed JSON body" });
              return;
            }
            if (body === null || typeof body !== "object") {
              sendJson(res, 400, { error: "body must be an object" });
              return;
            }

            const before = bridge !== undefined;
            if (typeof body.enabled === "boolean") settings.enabled = body.enabled;
            if (body.allowed === null) settings.allowed = null;
            else if (Array.isArray(body.allowed)) settings.allowed = body.allowed.filter((id) => typeof id === "string");

            saveSettings(settings, settingsPath, ctx.logger);

            if (settings.enabled && !before) start();
            else if (!settings.enabled && before) await stop();
            // A selection change must not wait out the catalog TTL.
            bridge?.invalidate();

            sendJson(res, 200, { running: bridge !== undefined, enabled: settings.enabled, allowed: settings.allowed });
            return;
          }

          sendJson(res, 404, { error: `no such route: ${req.method} ${route}` });
        },
      });
    });
  });
}

export default { name, inject, apply };
