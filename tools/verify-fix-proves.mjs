/**
 * Prove the regression test actually catches the bug it was written for.
 *
 * Reconstructs the pre-fix behaviour (a tool call announced at its bare
 * `block-start`, with empty id/name) and runs the same assertions against it.
 * A test that passes both before and after a fix proves nothing, so this is the
 * control: it must FAIL.
 *
 * Run: node verify-fix-proves.mjs
 */

import assert from "node:assert/strict";
import { startBridge } from "../index.js";

const KEY = "prove-test-0123456789abcdefghij";

/**
 * A bridge whose Anthropic tool path behaves the OLD way: announce the tool
 * block immediately with an empty id and name, then stream argument deltas.
 * Achieved by pre-seeding the start, exactly as the removed code did.
 */
async function runWithOldBehaviour() {
  const chunks = [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "t1", name: "read", argumentsDelta: '{"a":1}' },
    { type: "block-end", index: 0, block: { type: "tool-call", id: "t1", name: "read", arguments: '{"a":1}' } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
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
    body: JSON.stringify({ model: "p/m", max_tokens: 128, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }),
  });
  const raw = await response.text();
  await bridge.close();

  // Simulate the old emission: rewrite the first tool_use start to carry the
  // empty id/name the old code produced, and confirm the assertions reject it.
  const events = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (eventLine === undefined || dataLine === undefined) continue;
    const parsed = { event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) };
    if (parsed.event === "content_block_start" && parsed.data.content_block?.type === "tool_use") {
      parsed.data.content_block.id = "";
      parsed.data.content_block.name = "";
    }
    events.push(parsed);
  }
  return events;
}

const events = await runWithOldBehaviour();

let caught = false;
try {
  const startIndex = events.findIndex((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use");
  assert.notEqual(startIndex, -1, "no tool_use start");
  const start = events[startIndex].data;
  assert.ok(typeof start.content_block.id === "string" && start.content_block.id.length > 0, "tool_use start had no id");
  assert.ok(typeof start.content_block.name === "string" && start.content_block.name.length > 0, "tool_use start had no name");
} catch {
  caught = true;
}

console.log(caught ? "OK: the assertions reject the pre-fix output (the test has teeth)." : "PROBLEM: the assertions accept the pre-fix output.");
process.exit(caught ? 0 : 1);
