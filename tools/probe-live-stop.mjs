/**
 * Watch a long, real generation through the live gateway on 8791 and record
 * exactly how it ends.
 *
 * "Streams text, then stops by itself" has three distinguishable causes and
 * they need different fixes:
 *   1. this gateway cuts the stream (a timer, an abort, a double end);
 *   2. the upstream adapter emits a terminal failure finish (quota, rate limit,
 *      context overrun, dead session);
 *   3. the upstream simply stops sending and the stream idles out.
 *
 * Recording the inter-frame gaps plus the final frame tells them apart, so the
 * fix targets the real one.
 *
 * Run: node probe-live-stop.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const key = readFileSync(join(homedir(), ".dsh", "model-bridge", "key"), "utf8").trim();
const BASE = "http://127.0.0.1:8791";

const models = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
console.log(`models advertised: ${models.data.length}`);
for (const model of models.data.slice(0, 12)) console.log(`  ${model.id}  ctx=${model.context_length ?? "?"}`);

const target = process.argv[2] ?? models.data[0]?.id;
console.log(`\nstreaming from ${target} ...\n`);

const started = Date.now();
const response = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: target,
    messages: [
      {
        role: "user",
        content:
          "Write a long detailed essay about the history of computing. Keep writing for many paragraphs; do not stop early and do not summarise.",
      },
    ],
    stream: true,
    max_tokens: 4000,
  }),
});

console.log(`HTTP ${response.status} ${response.headers.get("content-type")}`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let frames = 0;
let chars = 0;
let lastFrameAt = Date.now();
const gaps = [];
const finishReasons = [];
const errors = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) {
    console.log(`\n[stream closed by server at t=${((Date.now() - started) / 1000).toFixed(1)}s]`);
    break;
  }
  const now = Date.now();
  gaps.push(now - lastFrameAt);
  lastFrameAt = now;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      console.log(`[DONE] at t=${((Date.now() - started) / 1000).toFixed(1)}s`);
      continue;
    }
    frames += 1;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.error) errors.push(parsed.error);
      const choice = parsed.choices?.[0];
      if (choice?.delta?.content) chars += choice.delta.content.length;
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
    } catch {
      errors.push({ message: `unparseable frame: ${payload.slice(0, 120)}` });
    }
  }
}

const elapsed = (Date.now() - started) / 1000;
const maxGap = gaps.length === 0 ? 0 : Math.max(...gaps);
const lastGap = gaps.length === 0 ? 0 : gaps[gaps.length - 1];

console.log("\n=== summary ===");
console.log(`elapsed            : ${elapsed.toFixed(1)}s`);
console.log(`content chars      : ${chars}`);
console.log(`data frames        : ${frames}`);
console.log(`finish_reasons     : ${JSON.stringify(finishReasons)}`);
console.log(`errors             : ${errors.length}`);
for (const error of errors) console.log(`   ${JSON.stringify(error).slice(0, 300)}`);
console.log(`max inter-frame gap: ${(maxGap / 1000).toFixed(2)}s`);
console.log(`last inter-frame gap: ${(lastGap / 1000).toFixed(2)}s`);
