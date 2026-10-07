/**
 * Regression tests for the tool-call streaming defect.
 *
 * The bug: the host opens a tool call with a bare `block-start` (index only, no
 * id or name) and only later supplies those on the deltas. The gateway used to
 * allocate an Anthropic content-block index at that start but emit no
 * `content_block_start`, so every `input_json_delta` referenced a block the
 * client had never been told about. Anthropic clients drop such deltas, the
 * turn reports `finish=tool-calls` with zero usable calls, and the agent stops.
 *
 * These cases pin the contract: a tool call must be announced with id and name
 * BEFORE its argument deltas, and a call whose arguments never stream must
 * still materialize.
 *
 * Run: node test-toolcalls.mjs
 */

import assert from "node:assert/strict";
import { startBridge } from "../index.js";

const KEY = "toolcall-test-0123456789abcdefg";
let passed = 0;
let failed = 0;

/** Drive one Anthropic streaming request and return the parsed SSE events. */
async function runAnthropic(chunks) {
  const llm = {
    listProviders: () => [{ id: "p", name: "P" }],
    listModels: async (provider) => [{ provider, id: "m", name: "M" }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream: () => (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
  const bridge = startBridge({ llm, port: 0, host: "127.0.0.1", key: KEY });
  await bridge.ready;
  const port = bridge.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "p/m",
      max_tokens: 512,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }),
  });
  const raw = await response.text();
  await bridge.close();
  const events = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
  }
  return events;
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}\n      ${error.message}`);
  }
}

/** The invariant every case must satisfy. */
function assertOrdered(events) {
  const startIndex = events.findIndex((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use");
  assert.notEqual(startIndex, -1, "no tool_use content_block_start was emitted");
  const start = events[startIndex].data;
  assert.ok(typeof start.content_block.id === "string" && start.content_block.id.length > 0, "tool_use start had no id");
  assert.ok(typeof start.content_block.name === "string" && start.content_block.name.length > 0, "tool_use start had no name");
  const firstDelta = events.findIndex((e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta");
  if (firstDelta !== -1) {
    assert.ok(startIndex < firstDelta, "input_json_delta preceded its content_block_start");
  }
  // Every started block must be stopped.
  const started = events.filter((e) => e.event === "content_block_start").map((e) => e.data.index);
  const stopped = events.filter((e) => e.event === "content_block_stop").map((e) => e.data.index);
  for (const index of started) assert.ok(stopped.includes(index), `block ${index} never stopped`);
}

console.log("\n== tool-call streaming contract ==");

{
  const events = await runAnthropic([
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "t1", name: "read", argumentsDelta: '{"a":' },
    { type: "tool-call-delta", index: 0, argumentsDelta: "1}" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "t1", name: "read", arguments: '{"a":1}' } },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
  check("bare block-start then deltas: tool_use announced before its arguments", () => assertOrdered(events));
  check("arguments arrive intact", () => {
    const json = events.filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
    assert.equal(json, '{"a":1}');
  });
  check("stop_reason is tool_use", () => {
    const stop = events.find((e) => e.event === "message_delta").data.delta.stop_reason;
    assert.equal(stop, "tool_use");
  });
}

{
  // A zero-argument call: block-start + block-end, no deltas at all.
  const events = await runAnthropic([
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "t2", name: "list", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
  check("zero-argument tool call still materializes", () => assertOrdered(events));
}

{
  // Arguments only on block-end (a provider that does not stream them).
  const events = await runAnthropic([
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "t3", name: "write", arguments: '{"p":"x"}' } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
  check("arguments reported only on block-end are delivered", () => {
    assertOrdered(events);
    const json = events.filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
    assert.equal(json, '{"p":"x"}');
  });
}

{
  // Text, reasoning and a tool call together: indexes must not collide.
  const events = await runAnthropic([
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "r" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "r" } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "t" },
    { type: "block-end", index: 1, block: { type: "text", text: "t" } },
    { type: "block-start", index: 2, blockType: "tool-call" },
    { type: "tool-call-delta", index: 2, id: "t4", name: "f", argumentsDelta: "{}" },
    { type: "block-end", index: 2, block: { type: "tool-call", id: "t4", name: "f", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
  check("mixed reasoning/text/tool blocks get distinct indexes", () => {
    assertOrdered(events);
    const starts = events.filter((e) => e.event === "content_block_start").map((e) => e.data.index);
    assert.deepEqual(starts, [...new Set(starts)], "duplicate content-block indexes");
    assert.equal(starts.length, 3);
  });
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
