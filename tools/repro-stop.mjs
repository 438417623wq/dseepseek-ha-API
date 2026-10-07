/**
 * Reproduce "streams text fine, then stops on its own".
 *
 * The suspicion: the streaming handlers abort the host stream on `req`'s
 * `close` event. Since Node 16, an IncomingMessage emits `close` as soon as the
 * *request* has been completed 鈥?i.e. right after the body is read 鈥?not when
 * the client disconnects. A stream that finishes faster than that read (the
 * existing tests' fake) never notices; a real model that takes seconds to
 * generate does, and gets cut mid-flight.
 *
 * This fake honors `signal` the way a real adapter does, and paces its deltas
 * so the abort has time to land. If the bug is real, fewer deltas arrive than
 * were sent.
 *
 * Run: node repro-stop.mjs
 */

import { startBridge } from "../index.js";

const KEY = "repro-key-0123456789abcdefghijklmn";
const TOTAL = 12;
const DELAY_MS = 120;

function makeSlowLlm() {
  return {
    listProviders: () => [{ id: "slow-pool", name: "Slow Pool" }],
    listModels: async (provider) => [{ provider, id: "slow-model", name: "Slow Model" }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream: (options) =>
      (async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        for (let i = 0; i < TOTAL; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          // A real adapter stops yielding once its signal aborts; without this
          // the fake would mask the bug by outrunning the abort.
          if (options.signal?.aborted === true) {
            console.log(`  [fake-llm] signal aborted after ${i} deltas 鈥?the host would stop here`);
            return;
          }
          yield { type: "text-delta", index: 0, text: `t${i} ` };
        }
        yield { type: "block-end", index: 0, block: { type: "text", text: "done" } };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: TOTAL } };
        yield { type: "finish", reason: { kind: "stop" } };
      })(),
  };
}

const bridge = startBridge({ llm: makeSlowLlm(), port: 0, host: "127.0.0.1", key: KEY });
await bridge.ready;
const port = bridge.server.address().port;

console.log(`sending a ${TOTAL}-delta stream (~${(TOTAL * DELAY_MS) / 1000}s)...\n`);

const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "slow-pool/slow-model",
    messages: [{ role: "user", content: "go" }],
    stream: true,
  }),
});

const text = await response.text();
const received = [...text.matchAll(/"content":"(t\d+) "/g)].map((m) => m[1]);
const sawFinish = text.includes('"finish_reason":"stop"');
const sawDone = text.includes("[DONE]");

console.log(`\nreceived ${received.length}/${TOTAL} deltas: ${received.join(" ")}`);
console.log(`finish_reason present: ${sawFinish}`);
console.log(`[DONE] present: ${sawDone}`);

await bridge.close();

if (received.length < TOTAL) {
  console.log(`\nREPRODUCED: the stream stopped after ${received.length} of ${TOTAL} deltas.`);
  process.exit(1);
}
console.log("\nOK: every delta arrived; the stream was not cut short.");
process.exit(0);
