/**
 * Ask the running harness whether it loaded dsh-model-bridge, and whether the
 * gateway actually serves the models.
 *
 * Run this AFTER restarting DSH: it is the live counterpart to verify-mount.mjs,
 * which only proves the profile can compose the bundle.
 *
 * Run: node check-live.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = join(homedir(), ".dsh");
const KEY_FILE = join(DSH_HOME, "model-bridge", "key");
const SETTINGS_FILE = join(DSH_HOME, "model-bridge", "settings.json");
/**
 * Candidate ports for the host's own web UI. The port is not written to any
 * state file, so the only reliable source is the listening socket itself; these
 * are probed in order and 19387 is the desktop default.
 */
const HOST_PORT_CANDIDATES = [19387, 19388, 19389, 8080];

/** The first candidate port that answers as this harness. */
async function findHostPort() {
  for (const port of HOST_PORT_CANDIDATES) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dsh-model-bridge/state`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 200) return port;
    } catch { /* not this one */ }
  }
  return undefined;
}

async function probe(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, error: String(error?.cause?.code ?? error?.message ?? error) };
  }
}

console.log("== local state ==");
console.log(`  key file:      ${KEY_FILE} ${existsSync(KEY_FILE) ? "(present)" : "(MISSING)"}`);
console.log(`  settings file: ${SETTINGS_FILE} ${existsSync(SETTINGS_FILE) ? "(present)" : "(absent — defaults apply)"}`);

if (existsSync(SETTINGS_FILE)) {
  try { console.log(`  settings:      ${readFileSync(SETTINGS_FILE, "utf8").trim()}`); } catch { /* unreadable */ }
}

const key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : undefined;

// ── the gateway itself ──────────────────────────────────────────────────────
console.log("\n== gateway on 127.0.0.1:8791 ==");

const health = await probe("http://127.0.0.1:8791/healthz");
if (health.status === 0) {
  console.log(`  FAIL /healthz unreachable (${health.error})`);
  console.log("       the plugin is not mounted, is switched off, or DSH was not restarted.");
} else {
  console.log(`  ok   /healthz -> ${JSON.stringify(health.body)}`);

  if (key === undefined) {
    console.log("  FAIL cannot authenticate: no key file");
  } else {
    const models = await probe("http://127.0.0.1:8791/v1/models", { Authorization: `Bearer ${key}` });
    if (models.status !== 200) {
      console.log(`  FAIL /v1/models -> ${models.status} ${JSON.stringify(models.body)}`);
    } else {
      const ids = models.body?.data?.map(m => m.id) ?? [];
      console.log(`  ok   /v1/models -> ${ids.length} model(s)`);
      for (const id of ids) console.log(`         ${id}`);

      // A real round trip through the harness's own credentials. This is the
      // only check that proves the gateway is not merely listening.
      //
      // Several models are tried in turn, because an exposed model can still be
      // unusable for reasons outside the gateway (no stored credential, an
      // upstream policy refusal). Reporting those as a gateway failure would be
      // misleading, so the run only fails when NO exposed model answers.
      console.log("\n== live calls ==");
      let anyAnswered = false;
      for (const target of ids.slice(0, 5)) {
        const started = Date.now();
        try {
          const response = await fetch("http://127.0.0.1:8791/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            // A system message first: the WorkBuddy pool rejects a request whose
            // first message is not a system prompt. max_tokens is generous
            // because these models spend tokens on reasoning before any text.
            body: JSON.stringify({
              model: target,
              messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "Reply with exactly: bridge works" },
              ],
              max_tokens: 512,
            }),
            signal: AbortSignal.timeout(120000),
          });
          const payload = await response.json().catch(() => ({}));
          const text = payload?.choices?.[0]?.message?.content;
          if (response.ok && typeof text === "string" && text.length > 0) {
            anyAnswered = true;
            console.log(`  ok   ${target} -> ${Date.now() - started}ms ${JSON.stringify(text.slice(0, 80))}`);
          } else {
            const why = payload?.error?.message ?? JSON.stringify(payload).slice(0, 200);
            console.log(`  --   ${target} -> status ${response.status}: ${String(why).slice(0, 200)}`);
          }
        } catch (error) {
          console.log(`  --   ${target} -> ${String(error?.cause?.code ?? error?.message ?? error)}`);
        }
      }
      console.log(anyAnswered
        ? "  ok   at least one exposed model answered end to end"
        : "  FAIL no exposed model answered; see the per-model reasons above");
    }
  }
}

// ── the host's settings API ─────────────────────────────────────────────────
console.log("\n== settings API ==");

const hostPort = await findHostPort();
if (hostPort === undefined) {
  console.log("  note: the host's web port did not answer; skipping the page API probe.");
  console.log("        (open Settings -> Plugins -> Model Bridge in the GUI to confirm it renders)");
} else {
  const state = await probe(`http://127.0.0.1:${hostPort}/api/dsh-model-bridge/state`, { Origin: `http://127.0.0.1:${hostPort}` });
  if (state.status === 200) {
    console.log(`  ok   /api/dsh-model-bridge/state -> running=${state.body?.running} enabled=${state.body?.enabled} available=${state.body?.models?.length}`);
    console.log(`         OpenAI base URL:    ${state.body?.openaiBaseUrl}`);
    console.log(`         Anthropic base URL: ${state.body?.anthropicBaseUrl}`);
    const exposed = state.body?.models?.length ?? 0;
    const allowed = state.body?.allowed;
    console.log(`         exposed selection:  ${allowed === null ? "all" : `${allowed.length} of ${exposed}`}`);
  } else {
    console.log(`  FAIL /api/dsh-model-bridge/state -> ${state.status} ${JSON.stringify(state.body ?? state.error)}`);
  }
}

console.log("\n== done ==");
