# Model Bridge — 把 DSH 的模型给你的其他开发工具用

> English: [README.en.md](README.en.md)

把 **DeepSeek Harness（DSH）里已经能调用的所有模型**，通过一个本机网关开放给任何支持
OpenAI 或 Anthropic 接口的软件使用 —— Claude Code、Cline、Roo Code、Continue、
Cherry Studio、ChatBox、ZCode，或你自己的脚本。

**不需要再填一次 API Key。** 网关直接调用 DSH 进程内的 `ctx.llm.stream()`，凭据由
DSH 里已有的适配器自己解析。插件从不读取、也不存储任何上游凭据。

```
┌─────────────┐   OpenAI / Anthropic    ┌──────────────────┐   ctx.llm.stream()   ┌────────────┐
│ 你的开发工具 │ ──────────────────────▶ │  dsh-model-bridge │ ──────────────────▶ │ DSH 的适配器 │
│ (ZCode 等)  │ ◀────────────────────── │  127.0.0.1:8791  │ ◀────────────────── │ (凭据在此)  │
└─────────────┘        SSE 流           └──────────────────┘      进程内调用      └────────────┘
```

---

## 一、你要填的三样东西

| 项目 | 值 |
|---|---|
| **OpenAI 兼容 Base URL** | `http://127.0.0.1:8791/v1` |
| **Anthropic Base URL** | `http://127.0.0.1:8791` |
| **API Key** | 见 `~/.dsh/model-bridge/key`（DSH 设置页里可直接复制） |

模型名填**限定名**，例如 `workbuddy/deepseek-v4.1-flash`。
完整清单见 `http://127.0.0.1:8791/v1/models`，或在 DSH 设置页里看。

---

## 二、安装

插件是标准的 DSH bundle。把它放进 profile 的依赖与 bundles 列表，然后**重启 DSH**：

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

挂载由插件自带的 `cordis.patch.yml` 完成，只有一行 —— 这一行就是全部的宿主接线：

```yaml
- insert:
    - id: model-bridge
      name: 'dsh-model-bridge'
```

装好后跑一次体检，确认 profile 能组装出这个 bundle：

```powershell
node "F:\KF\dsh api\dsh-model-bridge\tools\verify-mount.mjs"
```

> **安装新 bundle 需要重启 DSH。** 重启后 8791 才会开始监听。

---

## 三、在 DSH 里开关与选择模型

**设置 → 插件 → Model Bridge**：

- **启用本地网关** —— 开关。关掉后 8791 立刻停止服务；选择会被记住，下次启动按记忆执行。
- **接入信息** —— 上面三项，每项都有复制按钮；Key 默认打码，点「显示」可看全。
- **暴露的模型** —— 按 provider 分组，逐项勾选，带搜索框。
  取消勾选的模型**不会**出现在 `/v1/models`，**也无法**被调用（不是只藏起来）。
  「全选 / 全不选」用来批量操作。
- **复制模型名** —— 每行右侧有复制按钮（悬停出现），工具栏有「复制全部」一次复制所有已勾选项。

这个网关随 DSH 启动而启动、随 DSH 关闭而关闭。设置页的开关是额外的运行时控制，
不需要重启 DSH。

---

## 四、常见工具的填法

### Claude Code 等 Anthropic 原生工具

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8791"
$env:ANTHROPIC_API_KEY  = "<你的 key>"
```

模型名填 `workbuddy/deepseek-v4.1-flash`。

### OpenAI 兼容的客户端（Cline、Roo Code、Continue、Cherry Studio、ChatBox 等）

- Provider：**OpenAI Compatible**（或「自定义 OpenAI」）
- Base URL：`http://127.0.0.1:8791/v1`
- API Key：`<你的 key>`
- Model：`workbuddy/deepseek-v4.1-flash`

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8791/v1",
    api_key="<你的 key>",
)
reply = client.chat.completions.create(
    model="workbuddy/deepseek-v4.1-flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user",   "content": "你好"},
    ],
)
print(reply.choices[0].message.content)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8791/v1",
  apiKey: "<你的 key>",
});
const reply = await client.chat.completions.create({
  model: "workbuddy/deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "你好" },
  ],
});
console.log(reply.choices[0].message.content);
```

### curl

```powershell
curl.exe -H "Authorization: Bearer <你的 key>" http://127.0.0.1:8791/v1/models
```

---

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 存活探针。**唯一不需要鉴权的路由**，因为它只回答「进程在不在听」 |
| `GET` | `/v1/models` | 模型清单（OpenAI 格式）。`?refresh=1` 强制重新枚举 |
| `POST` | `/v1/chat/completions` | OpenAI 对话补全，支持 `stream: true` 与 `tools` |
| `POST` | `/v1/messages` | Anthropic Messages，支持 `stream: true` 与 `tools` |
| `GET` | `/v1/bridge/info` | 网关自身信息（两个 Base URL、provider 列表） |

鉴权用 `Authorization: Bearer <key>` **或** `x-api-key: <key>`（后者是 Anthropic 原生客户端
的习惯）。两者都是常量时间比较。

**裸名有歧义时会明确报错**，不会瞎猜。比如 `deepseek-v4.1-flash` 同时被多个 provider 提供，
就必须写成 `workbuddy/deepseek-v4.1-flash`，报错信息里会列出所有候选。

---

## 六、必须知道的四点

1. **只在 DSH 运行时可用。** 它是 DSH 进程内的插件，不是独立常驻服务 —— DSH 一关，
   8791 就没了。需要 7×24 常驻是另一件事。

2. **Key 是本机文件，本机任何程序都能读。** 这是设计使然：外部工具要能认证，密钥就
   必须能被它们读到。网关只绑 `127.0.0.1`，并逐请求校验 `Host` / `Origin` 以防 DNS
   重绑定，所以**局域网和公网访问不到**。

3. **WorkBuddy 池要求第一条消息必须是 `system`。** 这是上游的安全策略，网关只是如实
   转发：

   ```jsonc
   // ❌ 会被上游拒绝：502 "first message is not system prompt"
   {"messages": [{"role": "user", "content": "你好"}]}

   // ✅ 正确
   {"messages": [
     {"role": "system", "content": "You are a helpful assistant."},
     {"role": "user",   "content": "你好"}
   ]}
   ```

   多数客户端本来就会自动带 system 提示，通常无需理会。

4. **这些模型会消耗推理 token，`max_tokens` 别设太小**（建议 ≥512），否则推理占满配额、
   正文会是空的。

---

## 七、设计要点

- **零凭据**：插件不注册 adapter、不声明 configurable provider，因此永远不会与既有
  provider 路由冲突。它只**消费** `ctx.llm`。
- **进程内调用**：走 `ctx.llm.stream()` 而非 HTTP，所以完全绕开凭据搬运问题。
- **两个协议、一套内核**：chunk 遍历、错误处理、收尾逻辑只写一次，两种协议各自提供
  渲染器。
- **工具调用是完整的**：`tool-call` 的 `block-start` 不带 id/name（真实适配器的行为），
  所以 `content_block_start` 被推迟到 id/name 已知才发；若某个工具调用只有 `block-end`
  没有增量，也会从 `block-end` 补齐，保证客户端一定拿得到可执行的调用。

---

## 八、测试

```powershell
cd "F:\KF\dsh api\dsh-model-bridge"

node test\test.mjs           # 35 项：密钥、鉴权、回环策略、协议转换、路由、组装
node test\test-toolcalls.mjs #  6 项：工具调用流式契约（含零参数调用）
node test\test-settings.mjs  # 41 项：设置页与开关
node test\test-client.mjs    # 61 项：客户端 bundle

node tools\verify-mount.mjs     # 挂载体检：profile 能否组装出这个 bundle
node tools\verify-fix-proves.mjs # 对照实验：证明回归测试真的能抓住那个 bug
node tools\smoke-mount.mjs      # 端到端：8799 端口起一个假宿主，两种协议各打一遍
node tools\check-live.mjs       # 线上检查：重启 DSH 后网关是否真活着
```

`verify-fix-proves.mjs` 是刻意的**对照实验**：它复现修复前的输出，断言测试必须拒绝它。
一个修复前后都通过的测试什么也证明不了。

---

## 九、出问题时

| 现象 | 原因与处理 |
|---|---|
| 连不上 8791 | DSH 没运行、插件没挂载、或设置页里被关了 |
| 401 | Key 不对。读 `~/.dsh/model-bridge/key` 重新复制 |
| 403 `host_not_allowed` | 用了 `127.0.0.1` 之外的地址，或经过了代理 |
| 400 说模型有歧义 | 按提示写成 `provider/model` 形式 |
| 503 `no_adapter` | 该 provider 在当前 DSH 里没有活动适配器 |
| 模型列表里没有某个模型 | 设置页里没勾选它 |
| 502 `no API key for provider route` | 该 provider（如 `deepseek-official`）需要在 DSH 模型设置页登录 |

---

## 十、许可

MIT，见 [LICENSE](LICENSE)。
