/**
 * Self-test for dsh-model-bridge against a fake host `llm` service.
 *
 * The fake emits the chunk vocabulary read out of the real host bundle
 * (block-start | text-delta | reasoning-delta | tool-call-delta | block-end |
 * usage | finish), so a passing run proves the translation, not a guess about
 * it. No network, no credentials, no harness required.
 *
 * Run: node test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PORT,
  anthropicToHostMessages,
  anthropicToHostTools,
  assembleBlocks,
  authorize,
  collectModels,
  hostIsLoopback,
  loadOrCreateKey,
  originIsLoopback,
  resolveRoute,
  startBridge,
  toHostMessages,
  toHostTools,
} from "../index.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error("use testAsync for promise cases");
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed += 1;
    failures.push({ label, error });
    console.log(`FAIL  ${label}\n      ${error.message}`);
  }
}

async function testAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed += 1;
    failures.push({ label, error });
    console.log(`FAIL  ${label}\n      ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// A fake host LLM service with two providers, one of them dormant.
// ---------------------------------------------------------------------------

function makeFakeLlm({ failWith, toolCall = false } = {}) {
  const calls = [];
  const llm = {
    calls,
    listProviders: () => [
      { id: "fake-pool", name: "Fake Pool" },
      { id: "fake-alt", name: "Fake Alt" },
    ],
    listModels: async (provider) => {
      if (provider === "fake-pool") {
        return [
          { provider, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", inputModalities: ["text"] },
          { provider, id: "shared-model", name: "Shared", inputModalities: ["text", "image"] },
        ];
      }
      return [{ provider, id: "shared-model", name: "Shared (alt)", inputModalities: ["text"] }];
    },
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128000 },
      defaultMaxTokens: 8192,
    }),
    stream: (options) => {
      calls.push(options);
      return (async function* () {
        if (failWith !== undefined) {
          yield { type: "finish", reason: { kind: "error", failure: failWith } };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "Hello" };
        yield { type: "text-delta", index: 0, text: " world" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Hello world" } };
        if (toolCall) {
          yield { type: "tool-call-delta", index: 1, id: "call_1", name: "lookup", argumentsDelta: '{"q":' };
          yield { type: "tool-call-delta", index: 1, argumentsDelta: '"x"}' };
        }
        yield { type: "usage", usage: { inputTokens: 11, outputTokens: 4 } };
        yield {
          type: "finish",
          reason: { kind: toolCall ? "tool-calls" : "stop" },
        };
      })();
    },
  };
  return llm;
}

const KEY = "test-key-0123456789abcdefghijklmnop";
const tmp = mkdtempSync(join(tmpdir(), "bridge-test-"));

async function withBridge(fakeLlm, fn, options = {}) {
  const bridge = startBridge({ llm: fakeLlm, port: 0, host: "127.0.0.1", key: KEY, logger: undefined, ...options });
  await bridge.ready;
  const address = bridge.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn(base);
  } finally {
    await bridge.close();
  }
}

const auth = { Authorization: `Bearer ${KEY}` };

console.log("\n== key handling ==");

test("mints a key when none exists", () => {
  const key = loadOrCreateKey(join(tmp, "fresh", "key"));
  assert.equal(typeof key, "string");
  assert.ok(key.length >= 32);
});

test("reuses an existing key across calls", () => {
  const path = join(tmp, "reuse", "key");
  const first = loadOrCreateKey(path);
  const second = loadOrCreateKey(path);
  assert.equal(first, second);
});

test("re-mints when the stored key is unusable", () => {
  const path = join(tmp, "truncated", "key");
  loadOrCreateKey(path);
  // Simulate a hand-edited file with a too-short value.
  writeFileSync(path, "short\n");
  const key = loadOrCreateKey(path);
  assert.notEqual(key, "short");
  assert.ok(key.length >= 32);
});

console.log("\n== authorization ==");

test("accepts a correct bearer", () => {
  assert.equal(authorize({ authorization: `Bearer ${KEY}` }, KEY), true);
});

test("accepts x-api-key (Anthropic clients)", () => {
  assert.equal(authorize({ "x-api-key": KEY }, KEY), true);
});

test("rejects a wrong bearer and a missing one", () => {
  assert.equal(authorize({ authorization: "Bearer nope-nope-nope-nope-nope" }, KEY), false);
  assert.equal(authorize({}, KEY), false);
});

test("rejects a same-length but different key", () => {
  const sameLength = `${KEY.slice(0, -1)}X`;
  assert.equal(sameLength.length, KEY.length);
  assert.equal(authorize({ authorization: `Bearer ${sameLength}` }, KEY), false);
});

console.log("\n== loopback policy ==");

test("accepts loopback Host values", () => {
  assert.equal(hostIsLoopback("127.0.0.1:8791"), true);
  assert.equal(hostIsLoopback("localhost:8791"), true);
  assert.equal(hostIsLoopback("[::1]:8791"), true);
});

test("rejects a non-loopback Host and an absent one", () => {
  assert.equal(hostIsLoopback("evil.example.com"), false);
  assert.equal(hostIsLoopback("192.168.1.5:8791"), false);
  assert.equal(hostIsLoopback(undefined), false);
});

test("absent Origin passes, non-loopback Origin fails", () => {
  assert.equal(originIsLoopback(undefined), true);
  assert.equal(originIsLoopback("http://127.0.0.1:3000"), true);
  assert.equal(originIsLoopback("http://evil.example.com"), false);
});

console.log("\n== wire translation ==");

test("maps OpenAI roles onto host messages", () => {
  const messages = toHostMessages([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: { a: 1 } } }] },
    { role: "tool", tool_call_id: "c1", content: "42" },
  ]);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].source.kind, "system-prompt");
  assert.equal(messages[1].content[0].text, "hi");
  assert.equal(messages[2].content[0].type, "tool-call");
  assert.equal(messages[2].content[0].arguments, '{"a":1}');
  assert.equal(messages[3].role, "tool");
  assert.equal(messages[3].toolCallId, "c1");
});

test("maps OpenAI tools onto host tool schemas", () => {
  const tools = toHostTools([{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "f");
});

test("maps Anthropic system + tool_result onto host messages", () => {
  const messages = anthropicToHostMessages({
    system: "top level",
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "res" }] },
    ],
  });
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content[0].text, "top level");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].toolCallId, "tu1");
});

test("maps Anthropic tools via input_schema", () => {
  const tools = anthropicToHostTools([{ name: "t", description: "d", input_schema: { type: "object" } }]);
  assert.equal(tools[0].parameters.type, "object");
});

console.log("\n== catalog and routing ==");

await testAsync("collects models and marks routes as live", async () => {
  const entries = await collectModels(makeFakeLlm());
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.adapter === true));
  assert.equal(entries[0].contextWindow, 128000);
});

await testAsync("routes a qualified id", async () => {
  const entries = await collectModels(makeFakeLlm());
  const resolved = resolveRoute("fake-pool/deepseek-v4.1-flash", entries);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.entry.provider, "fake-pool");
});

await testAsync("refuses an ambiguous bare id instead of guessing", async () => {
  const entries = await collectModels(makeFakeLlm());
  const resolved = resolveRoute("shared-model", entries);
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /served by 2 providers/);
});

await testAsync("reports an unknown model clearly", async () => {
  const entries = await collectModels(makeFakeLlm());
  const resolved = resolveRoute("no-such-model", entries);
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /no provider serves/);
});

console.log("\n== assembling host chunks ==");

test("assembles text and interleaved tool call", () => {
  const assembled = assembleBlocks([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "a" },
    { type: "text-delta", index: 0, text: "b" },
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id: "c", name: "f", argumentsDelta: "{" },
    { type: "tool-call-delta", index: 1, argumentsDelta: "}" },
  ]);
  assert.equal(assembled.text, "ab");
  assert.equal(assembled.toolCalls.length, 1);
  assert.equal(assembled.toolCalls[0].function.name, "f");
  assert.equal(assembled.toolCalls[0].function.arguments, "{}");
});

test("tolerates a delta-only stream with no block-start", () => {
  const assembled = assembleBlocks([{ type: "text-delta", index: 0, text: "bare" }]);
  assert.equal(assembled.text, "bare");
});

console.log("\n== HTTP, OpenAI protocol ==");

await testAsync("GET /v1/models lists qualified ids", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/models`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "list");
    assert.ok(body.data.some((model) => model.id === "fake-pool/deepseek-v4.1-flash"));
    assert.equal(body.data[0].context_length, 128000);
  });
});

await testAsync("rejects a missing credential with 401", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/models`);
    assert.equal(response.status, 401);
  });
});

await testAsync("answers /healthz without a credential", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });
});

await testAsync("non-streaming chat completion returns assembled text", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-pool/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "Hello world");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.usage.prompt_tokens, 11);
    assert.equal(body.usage.total_tokens, 15);
  });
});

await testAsync("streaming chat completion emits deltas then [DONE]", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-pool/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"content":"Hello"/);
    assert.match(text, /"content":" world"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  });
});

await testAsync("streams tool calls as OpenAI tool_call deltas", async () => {
  await withBridge(makeFakeLlm({ toolCall: true }), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-pool/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const text = await response.text();
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"lookup"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  });
});

await testAsync("an upstream failure becomes a 502 with the real cause", async () => {
  const failure = { code: "NO_ADAPTER", message: "no adapter registered for provider \"x\"" };
  await withBridge(makeFakeLlm({ failWith: failure }), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-pool/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /no active adapter/);
  });
});

await testAsync("a non-JSON content type is refused with 415", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "text/plain" },
      body: "not json",
    });
    assert.equal(response.status, 415);
  });
});

await testAsync("a bad Origin is refused even with a good key", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/models`, { headers: { ...auth, Origin: "http://evil.example.com" } });
    assert.equal(response.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Anthropic protocol
// ---------------------------------------------------------------------------

console.log("\n== HTTP, Anthropic protocol ==");

await testAsync("non-streaming /v1/messages returns a message envelope", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-pool/deepseek-v4.1-flash",
        max_tokens: 256,
        system: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.equal(body.content[0].text, "Hello world");
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.input_tokens, 11);
  });
});

await testAsync("streaming /v1/messages emits the full event sequence", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-pool/deepseek-v4.1-flash",
        max_tokens: 256,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const event of [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]) {
      assert.ok(text.includes(`event: ${event}`), `missing ${event} (got: ${text.slice(0, 400)})`);
    }
    assert.match(text, /"type":"text_delta","text":"Hello"/);
    assert.match(text, /"stop_reason":"end_turn"/);
  });
});

await testAsync("streaming tool use emits input_json_delta", async () => {
  await withBridge(makeFakeLlm({ toolCall: true }), async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-pool/deepseek-v4.1-flash",
        max_tokens: 256,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
      }),
    });
    const text = await response.text();
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"type":"input_json_delta"/);
    assert.match(text, /"stop_reason":"tool_use"/);
  });
});

await testAsync("an upstream failure surfaces as an Anthropic error event", async () => {
  const failure = { code: "QUOTA", message: "quota exhausted" };
  await withBridge(makeFakeLlm({ failWith: failure }), async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-pool/deepseek-v4.1-flash",
        max_tokens: 256,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
      }),
    });
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.match(text, /out of quota/);
  });
});

await testAsync("an unknown model is a 400 that names the known providers", async () => {
  await withBridge(makeFakeLlm(), async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nope/nope", max_tokens: 16, messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.type, "error");
    assert.match(body.error.message, /fake-pool/);
  });
});

console.log("\n== config surface ==");

test("default port is 8791 as designed", () => {
  assert.equal(DEFAULT_PORT, 8791);
});

console.log(`\n${"=".repeat(60)}`);
console.log(`passed ${passed}, failed ${failed}`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const { label, error } of failures) console.log(`  - ${label}: ${error.message}`);
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
