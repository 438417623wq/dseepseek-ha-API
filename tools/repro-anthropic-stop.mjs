/**
 * Reproduce the mid-run stop through the ANTHROPIC path, which is what ZCode
 * actually uses (`providerKind: "anthropic"`, baseURL http://127.0.0.1:8791/v1).
 *
 * Evidence from ZCode's own log drove the shape of this fake:
 *   - turns end with finishReason "length" while the client asked for more;
 *   - turns report finish=tool-calls but toolCallCount 0, i.e. tool calls are
 *     announced but never parsed into a usable call.
 *
 * So this fake emits the three things a real reasoning model emits 鈥?a
 * reasoning block, text, and a tool call 鈥?slowly enough that any premature
 * teardown lands mid-flight, and it checks the Anthropic event grammar the SDK
 * depends on.
 *
 * Run: node repro-anthropic-stop.mjs
 */

import { startBridge } from "../index.js";

const KEY = "repro-anthropic-0123456789abcdef";
const STEP_MS = 90;

function makeReasoningToolLlm() {
  return {
    listProviders: () => [{ id: "wb", name: "WB" }],
    listModels: async (provider) => [{ provider, id: "reasoner", name: "Reasoner" }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream: (options) =>
      (async function* () {
        const stop = () => options.signal?.aborted === true;
        const pace = () => new Promise((r) => setTimeout(r, STEP_MS));

        // 1. a reasoning block, as a thinking-capable model emits
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        for (let i = 0; i < 4; i += 1) {
          await pace();
          if (stop()) return void console.log("  [fake] aborted during reasoning");
          yield { type: "reasoning-delta", index: 0, text: `think${i} ` };
        }
        yield { type: "block-end", index: 0, block: { type: "reasoning", text: "think0 think1 think2 think3 " } };

        // 2. visible text
        yield { type: "block-start", index: 1, blockType: "text" };
        for (let i = 0; i < 5; i += 1) {
          await pace();
          if (stop()) return void console.log("  [fake] aborted during text");
          yield { type: "text-delta", index: 1, text: `word${i} ` };
        }
        yield { type: "block-end", index: 1, block: { type: "text", text: "word0 word1 word2 word3 word4 " } };

        // 3. a tool call, streamed exactly as the real pi-ai adapter does:
        //    a bare `block-start` (no id/name yet), then argument fragments,
        //    then a `block-end` carrying the authoritative call.
        yield { type: "block-start", index: 2, blockType: "tool-call" };
        await pace();
        if (stop()) return void console.log("  [fake] aborted before tool args");
        yield { type: "tool-call-delta", index: 2, id: "toolu_1", name: "read_file", argumentsDelta: '{"path":' };
        await pace();
        if (stop()) return void console.log("  [fake] aborted during tool args");
        yield { type: "tool-call-delta", index: 2, argumentsDelta: '"/tmp/x"}' };
        yield {
          type: "block-end",
          index: 2,
          block: { type: "tool-call", id: "toolu_1", name: "read_file", arguments: '{"path":"/tmp/x"}' },
        };

        await pace();
        if (stop()) return void console.log("  [fake] aborted before finish");
        yield { type: "usage", usage: { inputTokens: 20, outputTokens: 30 } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      })(),
  };
}

const bridge = startBridge({ llm: makeReasoningToolLlm(), port: 0, host: "127.0.0.1", key: KEY });
await bridge.ready;
const port = bridge.server.address().port;

const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "wb/reasoner",
    max_tokens: 4096,
    stream: true,
    system: "You are a coding agent.",
    messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    tools: [{ name: "read_file", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  }),
});

const raw = await response.text();
await bridge.close();

// Parse the SSE grammar the way an Anthropic SDK does.
const events = [];
for (const block of raw.split("\n\n")) {
  const lines = block.split("\n").filter(Boolean);
  const eventLine = lines.find((l) => l.startsWith("event:"));
  const dataLine = lines.find((l) => l.startsWith("data:"));
  if (eventLine === undefined || dataLine === undefined) continue;
  events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
}

console.log(`\nevents: ${events.length}`);
const byType = {};
for (const e of events) byType[e.event] = (byType[e.event] ?? 0) + 1;
console.log("counts:", JSON.stringify(byType));

const text = events.filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
const thinking = events.filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "thinking_delta").map((e) => e.data.delta.thinking).join("");
const jsonDeltas = events.filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
const starts = events.filter((e) => e.event === "content_block_start").map((e) => `${e.data.index}:${e.data.content_block.type}`);
const stops = events.filter((e) => e.event === "content_block_stop").map((e) => e.data.index);

console.log(`\nthinking text : ${JSON.stringify(thinking)}`);
console.log(`visible text  : ${JSON.stringify(text)}`);
console.log(`tool json     : ${JSON.stringify(jsonDeltas)}`);
console.log(`block starts  : ${JSON.stringify(starts)}`);
console.log(`block stops   : ${JSON.stringify(stops)}`);
const stopReason = events.filter((e) => e.event === "message_delta").map((e) => e.data.delta?.stop_reason);
console.log(`stop_reason   : ${JSON.stringify(stopReason)}`);

// The checks an Anthropic client actually enforces.
const problems = [];
if (!thinking.includes("think3")) problems.push("thinking truncated");
if (!text.includes("word4")) problems.push("text truncated");
if (jsonDeltas !== '{"path":"/tmp/x"}') problems.push(`tool args malformed: ${JSON.stringify(jsonDeltas)}`);
if (stopReason[0] !== "tool_use") problems.push(`wrong stop_reason: ${JSON.stringify(stopReason)}`);
for (const index of starts.map((s) => Number(s.split(":")[0]))) {
  if (!stops.includes(index)) problems.push(`block ${index} started but never stopped`);
}
if (events.filter((e) => e.event === "message_start").length !== 1) problems.push("message_start count wrong");
if (events.filter((e) => e.event === "message_stop").length !== 1) problems.push("message_stop count wrong");
const lastEvent = events[events.length - 1]?.event;
if (lastEvent !== "message_stop") problems.push(`stream ends with ${lastEvent}, not message_stop`);

// A tool call must be announced BEFORE any of its argument deltas, and must be
// announced at all 鈥?the exact defect that made ZCode log toolCallCount 0.
const toolStartIndex = events.findIndex((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use");
const firstJsonDeltaIndex = events.findIndex((e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta");
if (toolStartIndex === -1) problems.push("no content_block_start(tool_use) was emitted");
else if (firstJsonDeltaIndex !== -1 && toolStartIndex > firstJsonDeltaIndex) {
  problems.push("input_json_delta arrived before its content_block_start(tool_use)");
} else {
  const startData = events[toolStartIndex].data;
  if (typeof startData.content_block?.id !== "string" || startData.content_block.id.length === 0) {
    problems.push("tool_use start carried no id");
  }
  if (typeof startData.content_block?.name !== "string" || startData.content_block.name.length === 0) {
    problems.push("tool_use start carried no name");
  }
}

console.log("");
if (problems.length > 0) {
  console.log("PROBLEMS FOUND:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("OK: the Anthropic stream is complete and well-formed.");
process.exit(0);
