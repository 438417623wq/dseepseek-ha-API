/**
 * Probe the live gateway the way a real coding client (ZCode) drives it:
 * a system prompt first, then a long generation.
 *
 * The previous probe failed instantly with "first message is not system
 * prompt", which is the WorkBuddy upstream rejecting a conversation that does
 * not open with a system turn. A real client always sends one, so the
 * interesting failure — text flowing and then stopping — needs this shape.
 *
 * Run: node probe-zcode-shape.mjs [model] [chars]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const key = readFileSync(join(homedir(), ".dsh", "model-bridge", "key"), "utf8").trim();
const BASE = "http://127.0.0.1:8791";
const model = process.argv[2] ?? "workbuddy/deepseek-v4.1-flash";
const askFor = Number(process.argv[3] ?? 3000);

const body = {
  model,
  stream: true,
  max_tokens: 8000,
  messages: [
    { role: "system", content: "You are a helpful coding assistant. Answer thoroughly and at length." },
    {
      role: "user",
      content: `Write a very long, detailed technical document of at least ${askFor} words about distributed systems. Do not stop early, do not summarise, keep writing.`,
    },
  ],
};

console.log(`model=${model} asking for ~${askFor} words\n`);

const started = Date.now();
const response = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log(`HTTP ${response.status} ${response.headers.get("content-type")}\n`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let chars = 0;
let frames = 0;
let lastAt = Date.now();
let maxGap = 0;
const finishReasons = [];
const errors = [];
let lastText = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const now = Date.now();
  maxGap = Math.max(maxGap, now - lastAt);
  lastAt = now;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    frames += 1;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.error) errors.push(parsed.error);
      const choice = parsed.choices?.[0];
      if (choice?.delta?.content) {
        chars += choice.delta.content.length;
        lastText = choice.delta.content;
      }
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
    } catch {
      errors.push({ message: `unparseable: ${payload.slice(0, 100)}` });
    }
  }
}

const elapsed = (Date.now() - started) / 1000;
console.log("=== summary ===");
console.log(`elapsed        : ${elapsed.toFixed(1)}s`);
console.log(`content chars  : ${chars}`);
console.log(`data frames    : ${frames}`);
console.log(`finish_reasons : ${JSON.stringify(finishReasons)}`);
console.log(`max gap        : ${(maxGap / 1000).toFixed(2)}s`);
console.log(`last delta     : ${JSON.stringify(lastText)}`);
console.log(`errors (${errors.length}):`);
for (const error of errors) console.log(`   ${JSON.stringify(error).slice(0, 400)}`);
