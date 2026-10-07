# Model Bridge — Let your other dev tools use DSH's models

> 中文: [README.md](README.md)

Expose **every model your DeepSeek Harness (DSH) can already call** through one
loopback gateway, so any tool that speaks the OpenAI or Anthropic API can use
them — Claude Code, Cline, Roo Code, Continue, Cherry Studio, ChatBox, ZCode, or
your own scripts.

**No second API key to fill in.** The gateway calls `ctx.llm.stream()` inside the
DSH process, so credentials are resolved by whichever adapter already owns the
route. The plugin never reads and never stores an upstream credential.

```
┌──────────────┐   OpenAI / Anthropic    ┌───────────────────┐  ctx.llm.stream()  ┌─────────────┐
│ your dev tool│ ──────────────────────▶ │  dsh-model-bridge │ ─────────────────▶ │ DSH adapter │
│  (ZCode etc) │ ◀────────────────────── │   127.0.0.1:8791  │ ◀───────────────── │ (credentials│
└──────────────┘         SSE             └───────────────────┘   in-process call  │  live here) │
                                                                                 └─────────────┘
```

---

## 1. The three things you fill in

| Setting | Value |
|---|---|
| **OpenAI-compatible Base URL** | `http://127.0.0.1:8791/v1` |
| **Anthropic Base URL** | `http://127.0.0.1:8791` |
| **API Key** | see `~/.dsh/model-bridge/key` (copyable from the DSH settings page) |

Model names are **qualified**, e.g. `workbuddy/deepseek-v4.1-flash`.
The full list is at `http://127.0.0.1:8791/v1/models`, or in the DSH settings page.

---

## 2. Install

The plugin is a standard DSH bundle. Add it to your profile's dependencies and
bundles list, then **restart DSH**:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-model-bridge": "file:F:/KF/dsh api/dsh-model-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        // …
        "dsh-model-bridge"
      ]
    }
  }
}
```

The mount itself is done by the plugin's own `cordis.patch.yml` — one row, and
that row is the entire host-side wiring:

```yaml
- insert:
    - id: model-bridge
      name: 'dsh-model-bridge'
```

Then run the pre-flight check to confirm the profile can compose this bundle:

```powershell
node "F:\KF\dsh api\dsh-model-bridge\tools\verify-mount.mjs"
```

> **Installing a new bundle requires a DSH restart.** Port 8791 starts listening
> only after that restart.

---

## 3. Toggle and pick models inside DSH

**Settings → Plugins → Model Bridge**:

- **Enable local gateway** — a switch. Turning it off stops 8791 immediately; the
  choice is remembered and honoured on the next start.
- **Connection info** — the three values above, each with a copy button. The key
  is masked by default; "Show" reveals it.
- **Exposed models** — grouped by provider, individually checkable, with a search
  box. An unchecked model does **not** appear in `/v1/models` and **cannot** be
  called — it is not merely hidden. "Select all / none" handles bulk changes.
- **Copying model names** — a per-row copy button (on hover), and a toolbar
  "Copy all" that copies every checked model, one per line.

The gateway starts with DSH and stops with DSH. The settings switch is an
additional runtime control that does not need a restart.

---

## 4. Configuring common tools

### Anthropic-native tools (Claude Code and clones)

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8791"
$env:ANTHROPIC_API_KEY  = "<your key>"
```

Use `workbuddy/deepseek-v4.1-flash` as the model name.

### OpenAI-compatible clients (Cline, Roo Code, Continue, Cherry Studio, ChatBox, …)

- Provider: **OpenAI Compatible** (or "Custom OpenAI")
- Base URL: `http://127.0.0.1:8791/v1`
- API Key: `<your key>`
- Model: `workbuddy/deepseek-v4.1-flash`

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8791/v1",
    api_key="<your key>",
)
reply = client.chat.completions.create(
    model="workbuddy/deepseek-v4.1-flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user",   "content": "Hello"},
    ],
)
print(reply.choices[0].message.content)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8791/v1",
  apiKey: "<your key>",
});
const reply = await client.chat.completions.create({
  model: "workbuddy/deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
  ],
});
console.log(reply.choices[0].message.content);
```

### curl

```powershell
curl.exe -H "Authorization: Bearer <your key>" http://127.0.0.1:8791/v1/models
```

---

## 5. Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healthz` | Liveness probe. The **only** unauthenticated route, because it only answers "is the process listening" |
| `GET` | `/v1/models` | Model catalog (OpenAI shape). `?refresh=1` re-enumerates |
| `POST` | `/v1/chat/completions` | OpenAI chat completions, with `stream: true` and `tools` |
| `POST` | `/v1/messages` | Anthropic Messages, with `stream: true` and `tools` |
| `GET` | `/v1/bridge/info` | Gateway info (both base URLs, provider list) |

Authenticate with `Authorization: Bearer <key>` **or** `x-api-key: <key>` (the
latter is what Anthropic-native clients send). Both are compared in constant time.

**An ambiguous bare name is an explicit error, never a guess.** `deepseek-v4.1-flash`,
for instance, is served by more than one provider, so it must be written
`workbuddy/deepseek-v4.1-flash`; the error lists every candidate.

---

## 6. Four things you must know

1. **It only works while DSH is running.** This is an in-process DSH plugin, not a
   standalone daemon — close DSH and 8791 is gone. A 24/7 service is a different
   design.

2. **The key is a local file that any local program can read.** That is
   deliberate: for an external tool to authenticate, the key must be readable by
   it. The gateway binds `127.0.0.1` only and validates `Host` / `Origin` on every
   request to defeat DNS rebinding, so **LAN and internet clients cannot reach it**.

3. **The WorkBuddy pool requires the first message to be `system`.** That is an
   upstream policy the gateway simply forwards:

   ```jsonc
   // ❌ rejected upstream: 502 "first message is not system prompt"
   {"messages": [{"role": "user", "content": "Hello"}]}

   // ✅ correct
   {"messages": [
     {"role": "system", "content": "You are a helpful assistant."},
     {"role": "user",   "content": "Hello"}
   ]}
   ```

   Most clients send a system prompt automatically, so this rarely needs action.

4. **These models spend reasoning tokens — do not set `max_tokens` too low**
   (≥512 is advisable), or reasoning consumes the whole budget and the visible
   text comes back empty.

---

## 7. Design notes

- **Zero credentials.** The plugin registers no adapter and declares no
  configurable provider, so it can never collide with an existing provider route.
  It only *consumes* `ctx.llm`.
- **In-process call.** It goes through `ctx.llm.stream()` rather than HTTP, which
  sidesteps credential transport entirely.
- **Two protocols, one core.** The chunk walk, error handling and terminal
  handling exist once; each protocol supplies its own renderer.
- **Tool calls are complete.** A `tool-call` opens with a bare `block-start` that
  carries no id or name (that is what the real adapter emits), so
  `content_block_start` is deferred until id/name are known. A call that only
  ever reports `block-end` is materialized from there, so the client always
  receives a runnable call.

---

## 8. Tests

```powershell
cd "F:\KF\dsh api\dsh-model-bridge"

node test\test.mjs           # 35 checks: keys, auth, loopback policy, translation, routing, assembly
node test\test-toolcalls.mjs #  6 checks: the tool-call streaming contract (incl. zero-argument calls)
node test\test-settings.mjs  # 41 checks: settings page and the on/off switch
node test\test-client.mjs    # 61 checks: the client bundle

node tools\verify-mount.mjs      # pre-flight: can the profile compose this bundle?
node tools\verify-fix-proves.mjs # control: proves the regression test catches the real bug
node tools\smoke-mount.mjs       # end-to-end: a fake host on 8799, both protocols exercised
node tools\check-live.mjs        # live check: is the gateway really up after a DSH restart?
```

`verify-fix-proves.mjs` is a deliberate **control experiment**: it reconstructs the
pre-fix output and asserts that the tests reject it. A test that passes both before
and after a fix proves nothing.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Cannot reach 8791 | DSH is not running, the plugin is not mounted, or the settings switch is off |
| 401 | Wrong key. Read `~/.dsh/model-bridge/key` and copy it again |
| 403 `host_not_allowed` | You used an address other than `127.0.0.1`, or went through a proxy |
| 400 saying the model is ambiguous | Write it as `provider/model`, as the error suggests |
| 503 `no_adapter` | That provider has no active adapter in the current DSH |
| A model is missing from the list | It is unchecked in the settings page |
| 502 `no API key for provider route` | That provider (e.g. `deepseek-official`) needs a sign-in on the DSH models page |

---

## 10. License

MIT — see [LICENSE](LICENSE).
