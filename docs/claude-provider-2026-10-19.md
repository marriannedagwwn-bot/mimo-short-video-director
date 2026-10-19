# 接入 Claude（Anthropic）纯文本模型（2026-10-19）

第四家文本模型供应商。用户确认的四个前提：

- 从本地 master（4b9bc03）切 `feat/claude-provider`。
- 用官方 SDK `@anthropic-ai/sdk`，锁死 `0.131.0`。这一版 9 月 30 日发布，超过两周。
- 只用纯文本阶段，与 DeepSeek 同一档。
- 默认型号用「白米饭」剧本（《鲸鱼风筝》）对比完再定。对比后用户定为 `claude-sonnet-5-5`（见下面「白米饭对比结果」）。

代码在 `src/claude-client.js`，对外接口与 DeepSeek / MiMo / 千问客户端相同，返回同样的 7 个字段（另加一个只给展示用的 `finishDetail`）。coordinator、截断与审核判定、记账、Durable 心跳都不用为 Claude 加分支。

## 能用在哪些阶段

只用纯文本阶段：简报、候选、候选评审与修订、完整剧情、剧情体检与按问题修改、一句话修改、导演助手、4.0 分镜与单镜提示词。

参考片分析、脚本还原、角色边界、人物参考修正这四个阶段要看图或视频，三道关都会拒绝 Claude：

- 服务端阶段检查：`generateStageJson` 报「需要图片或视频输入，Claude 在本工作流只允许用于纯文本阶段」。
- 客户端：`generateJsonWithMedia` 直接抛 `MODEL_MEDIA_UNSUPPORTED`。
- 页面：`providerAllowedForStage` 按「纯文本供应商」集合 {DeepSeek, Claude} 判断，这些阶段的 provider 下拉里不列 Claude。

Claude 本身能看图片，但不能看视频。要接看图的阶段，就得固定走抽帧，参考片分析的证据也要固定写帧号，范围明显变大，所以留到第二期。

Claude 不能设成 `DEFAULT_LLM_PROVIDER`，因为默认路由覆盖看图的阶段。配了 Claude 也不改变「配了 Qwen 就用 Qwen」的默认路由。

## 模型 ID

页面只登记四个型号，第一个是选 Claude 时的默认型号：

- `claude-sonnet-5-5`（默认）
- `claude-opus-5-5`
- `claude-haiku-5-5`
- `claude-fable-5-1`

出处：https://platform.claude.com/docs/en/about-claude/models/overview （2026-10-19 核对）。四个型号的同步接口最大输出都是 128K，思考都可以是自适应的。

健康检查用 `GET /v1/models/{id}` 只核对所选型号在不在，不把 `/v1/models` 的全部型号交给页面。旧型号的参数规则不一样（有的接受 temperature，有的要 `budget_tokens`），选到会直接 400。

## 请求怎么发

请求体只有这几项：`model`、`max_tokens`、`system`、`messages`（一条 user 消息）、`stream: true`、`thinking`，设了 effort 时再加 `output_config.effort`。

以下几项都不发：

- `temperature` / `top_p`：Opus 5.5、Fable 5.1 会 400，Sonnet 5.5、Haiku 5.5 只接受默认值。
- `output_config.format`：原因见下面「JSON 怎么保证」。
- server-side `fallbacks`：原因见「内容审核」。
- assistant 预填：这几个型号会 400。

SDK 客户端的构造方式：

- 每次请求新建一个 SDK 客户端，传入的参数都显式给出：`apiKey`、`baseURL`、`authToken: null`、`maxRetries: 0`、`timeout: 1 小时`、`logLevel: "warn"`，以及 `fetch: 调用时才取 globalThis.fetch`。
- 每次新建，是因为读流期间要按收到的字节刷新这一次请求自己的空闲计时，而 SDK 不把 `ping` 交给调用方，只能在 fetch 这一层看字节。构造只是组装对象，不发网络请求。
- `fetch` 在调用时才取，所以 `--use-env-proxy`、`src/system-proxy.js` 的全局 dispatcher、测试里 mock 的 fetch 都会生效。SDK 默认本来就走全局 fetch。
- `apiKey` 一律给字符串：给 undefined 时 SDK 会去读 `ANTHROPIC_API_KEY`，给 null 时会去找本机的凭据配置。
- `logLevel` 固定为 warn，不跟随 `ANTHROPIC_LOG`：debug 级会把请求体（提示词）打进控制台。

## 流式、超时与重试

- **流式，只判空闲、不设总时长**：复用 `src/stream-idle-timeout.js`，`CLAUDE_API_STREAM_IDLE_TIMEOUT_MS` 默认 120 秒。
  - 任何字节都算「有数据」，包括 SDK 不交给调用方的 `ping`，测试锁住「只有 ping 也不会被掐断」。
  - 读过源码确认，SDK 的 `timeout` 只覆盖「发出请求到收到响应头」（`fetchWithTimeout`），读流期间不计。所以把它放到 1 小时，空闲判定（上限 15 分钟）始终先触发。
- **重试只归 coordinator 与各阶段的预算管**：SDK 自带的重试关掉（`maxRetries: 0`），测试锁住 529 只发一次请求。
- **流的完整性只看有没有 `message_stop`**：
  - SDK 在连接被中止时会静默结束迭代，所以没收到 `message_stop` 时报 `MODEL_STREAM_INCOMPLETE`。
  - 收到过事件之后断线报 `MODEL_STREAM_ABORTED`。
  - 空闲超时报 `MODEL_STREAM_IDLE_TIMEOUT`。
  - 正文或推理陷入逐字重复时，先关掉连接再报 `MODEL_OUTPUT_DEGENERATE`（复用 `src/output-degeneration.js`，消息与截断规则从 `src/sse-stream.js` 共用）。
  - 半截内容绝不当成结果返回。
- **收到响应头之前就失败的，还原成与另外三家同形的错误**：网络失败交回 fetch 的 `TypeError`，空闲超时交回 `TimeoutError`，`classifyAttemptError` 照旧分类。
- **Durable**：取消、暂停、冻结复检、用量记账与另外三家同序，`text-client-cancellation` / `text-client-durable-usage` 两个矩阵各加了一行 Claude。
  - 心跳在解析出第一个事件之后才开始报，每 10 秒最多一次，只有 ping 的时段也照样续报。
  - 用量把 `message_start` 的输入 token 与 `message_delta` 的累计输出 token 合起来记账。

## stop_reason 映射

只统一两个值，让既有判定直接生效；其余照抄 Anthropic 的原值（`end_turn` 等）：

| Anthropic `stop_reason` | `finishReason` | 走哪条既有判定 |
|---|---|---|
| `max_tokens`、`model_context_window_exceeded` | `length` | `MODEL_OUTPUT_TRUNCATED`（可重试，在已有预算内） |
| `refusal` | `content_filter` | `MODEL_CONTENT_FILTERED`（不可重试） |

出处：https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons （2026-10-19 核对）。

截断消息里的 token 数在没有 `completion_tokens` 时读 `output_tokens`。这只影响文案。

## 内容审核

`refusal` 以 HTTP 200 返回。错误消息会带上 `stop_details` 的拒绝类别与说明，例如「拒绝类别 cyber，说明：…」；这个 `finishDetail` 只有 Claude 客户端给，另外三家的审核消息逐字不变。

不自动重试，与 §2.6 视频审核、MiMo 审核同一原则。

**不开 server-side `fallbacks`**：它会在被拒时自动换成另一个模型继续跑，等于静默换模型，与 §2.7「不得静默切换 provider/model」冲突。Anthropic 的 SDK 指南默认建议开启，这里刻意不开。

## 思考开关

默认发 `thinking: {type: "adaptive", display: "summarized"}`。四个型号默认都开着自适应思考，推理写多少由型号自己决定。

- summarized 让页面能显示「已推理 N 字」。推理文字单独收集，绝不混进正文；推理的计费与 display 无关。
- 深浅用 `CLAUDE_API_EFFORT` 调（low / medium / high / xhigh / max，写错时启动就报错）。不设就不发，用型号自己的默认值：Opus 5.5 与 Haiku 5.5 是 medium，Sonnet 5.5 与 Fable 5.1 是 high。

单次请求的 `thinking` 覆盖（只有导演助手会传）这样映射。出处：https://platform.claude.com/docs/en/api/errors 的「Thinking cannot be disabled」一节，2026-10-19 核对。

| 型号 | `disabled` 发什么 |
|---|---|
| `claude-sonnet-5-5` | `{type: "between_tools"}`（不在回答前思考） |
| `claude-haiku-5-5` | `{type: "disabled"}` |
| `claude-opus-5-5`、`claude-fable-5-1` | 关不掉：发请求前抛 `MODEL_THINKING_UNSUPPORTED` |
| 没登记的型号 | 不猜：同样在发请求前报错 |

关思考时 effort 不能是 xhigh / max，同样在发请求前报错。

导演助手每次都要关思考，所以选了 Opus 5.5 / Fable 5.1 时，在调用前就给出 400（与 GLM-5.3 同规格），一次请求都不发。能力表只有一份：`CLAUDE_THINKING_OFF` 与 `claudeThinkingOffProblem`（`src/claude-client.js`），客户端与工作流共用。

## JSON 怎么保证

Claude 没有 `json_object` 模式。第一期靠四样：

- 共用的 `JSON_ONLY` 与系统提示词；
- 去掉整段包裹的代码块（2026-10-19，用户确认）：整段正文恰好被一对 Markdown 代码块包着（开头一行 ``` 或 ```json、结尾一行 ```、中间再没有以 ``` 开头的行）时，客户端先去掉这层包裹再交给严格解析（`unwrapWholeCodeFence`，返回值带 `contentUnwrappedFromCodeFence: true`，raw 保留原样）；代码块前后多了说明文字、两个代码块、没有收尾的，一律原样交回、照旧判失败。起因是白米饭对比里 Haiku 把整份合法 JSON 包在代码块里；包裹不是内容，去掉它是唯一、不丢信息的变换；
- 本地严格解析与全部校验，逐字不变；
- 已有的重试预算。客户端内 JSON 重试沿用 MiMo 的纠偏提示词，输出上限只抬不降、封顶 128000。

`responseSchema` 参数由 Claude 客户端忽略，与千问、DeepSeek 一样。原因有两个：

- Claude 结构化输出支持的 Schema 子集不含 `minLength`、`maxLength`、`maximum`、`minimum`，`minItems` 只能是 0 或 1，`additionalProperties` 只能是 false。我们从严格 Schema 派生的那几份都用到了，直接发会 400。出处：https://platform.claude.com/docs/en/build-with-claude/structured-outputs （2026-10-19 核对）。
- 它还有复杂度上限（可选参数合计最多 24 个，含联合类型的参数最多 16 个，以及语法编译大小）。

要不要给 Claude 另派生一份 Schema，等实测看结构失败多不多再定。

## 错误码

码表出处：https://platform.claude.com/docs/en/api/errors （2026-10-19 核对「HTTP errors」一节），在 `src/provider-error-codes.js`。按 `error.type` 查，响应体不是 JSON 时按状态码兜底（官方说 413 可能由 Cloudflare 在请求到达 API 之前返回）。

| 状态 | `error.type` | 可重试 |
|---|---|---|
| 400 | `invalid_request_error`（也包括达到自设的花费上限） | 否 |
| 401 | `authentication_error` | 否 |
| 402 | `billing_error` | 否 |
| 403 | `permission_error` | 否 |
| 404 | `not_found_error` | 否 |
| 409 | `conflict_error` | 否（先解决冲突） |
| 413 | `request_too_large` | 否 |
| 429 | `rate_limit_error`（没有 retry-after 的是月度花费封顶，会一直失败） | 是 |
| 500 | `api_error` | 是 |
| 504 | `timeout_error` | 是 |
| 529 | `overloaded_error` | 是 |

流式途中的 `event: error` 没有 HTTP 状态：客户端按类型还原状态码（overloaded→529 等），报 `MODEL_PROVIDER_STREAM_ERROR`，沿用「429 / 5xx 可重试」的既有规则。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDE_API_KEY` | 空 | 填了才启用 |
| `CLAUDE_API_BASE_URL` | `https://api.anthropic.com` | |
| `CLAUDE_API_MODEL` | `claude-sonnet-5-5` | 按白米饭对比定的 |
| `CLAUDE_API_MAX_COMPLETION_TOKENS` | 128000 | 范围 1024–128000，思考 token 计入 |
| `CLAUDE_API_EFFORT` | 空（用型号默认值） | low / medium / high / xhigh / max |
| `CLAUDE_API_STREAM_IDLE_TIMEOUT_MS` | 120000 | 范围 10000–900000 |
| `CLAUDE_API_JSON_RETRY_ATTEMPTS` | 2 | 范围 0–3 |

**为什么是 `CLAUDE_API_` 前缀**：计划里写的是 `CLAUDE_EFFORT`、`CLAUDE_BASE_URL`，并且退回读 `ANTHROPIC_API_KEY`。实现时发现，Claude Code 会给它启动的进程导出 `CLAUDE_EFFORT`（本机实测值是 xhigh）和 `ANTHROPIC_BASE_URL`，也可能有 `ANTHROPIC_API_KEY`。从 Claude 会话里启动的服务（`.claude/launch.json` 的预览服务）会继承它们，于是会把 Claude Code 自己的设置甚至密钥当成本工作流的配置。所以改成一律只读 `CLAUDE_API_*`，测试锁住这几个变量一个都不会被读到。

SDK 还会读 `ANTHROPIC_CUSTOM_HEADERS`（往请求里加头），这个关不掉；我们显式传入的参数优先。

## 不配置时

没有 key 就不建客户端。`resolveDefaultLlmProvider` 的裁决逐字不变；现有三家的请求体逐字不变，由三份 golden 测试锁住。只有两处可见变化：

- 页面的 provider 下拉多一项 Claude。DeepSeek 没配置时也是这样列着；选了未配置的 Claude，由 `assertStageClient` 报「未配置」。
- `/api/health` 的 `maxCompletionTokensByProvider` 多一个 Claude 键，`providers.Claude` 报 `configured: false`、`mediaMode: "text-only"`。

## 明确不做

- 不开 server-side fallbacks（会静默换模型）。
- 第一期不发 `output_config.format`。
- 不做提示词缓存。
- 不接看图的阶段。
- 不用 Anthropic 的 OpenAI 兼容端点。
- `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 的抓取器只认 `/chat/completions`，抓不到 Claude 的请求。分镜与单镜提示词在 `STAGE_MODEL_OUTPUT_LOG_DIR` 里照常有每次调用的原文，所以这是已知缺口，不是丢日志。
- `modelSnapshotFor` 不检查纯文本限制。这个缺口 DeepSeek 原来就有，不在这次修。

## 验证

- `npm test` 全部通过。新增 `test/claude-client.test.js`（17 项）；`text-client-cancellation`、`text-client-durable-usage`、`text-client-json-retry`、`text-client-thinking-override` 四个矩阵各加了 Claude。另外补了 Claude 用例的测试：
  - `provider-error-codes`
  - `model-picker-cascade`
  - `director-agent-server`
  - `stage-token-caps`
- **真实请求（2026-10-19，用户在 .env 里加了 `CLAUDE_API_KEY` 之后）**，全部走 `ClaudeClient`、系统代理与 `--use-env-proxy`，合计费用远不到 $0.01：
  - 健康检查：四个型号 `GET /v1/models/{id}` 都是 200。
  - 四个型号各一个极小请求，带 `max_tokens: 128000` 与 `thinking: {type: "adaptive", display: "summarized"}`：4/4 返回 `{"ok":true}`，`end_turn`，1.1–2.0 秒。
  - 关思考：Sonnet 5.5 发 `between_tools`（另加 effort high 一次）、Haiku 5.5 发 `disabled`，都被接受；Opus 5.5 / Fable 5.1 在客户端就报 `MODEL_THINKING_UNSUPPORTED`，没有发请求。
  - 反例，被拒的请求不计费：`max_tokens: 128001` 被拒，原文「128001 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5」，确认上限就是 128000；Opus、Fable 发 `{type: "disabled"}` 被拒；Sonnet 发 `{type: "disabled"}` 被拒，原文要求改发 `between_tools`。三条都与能力表一致。
  - 推理单独流回：那几个极小请求模型都没思考（`thinking_tokens: 0`），所以另让 Haiku、Opus 各算一道小题。两者都流回了英文的推理摘要（124 / 141 字、`thinking_tokens` 152 / 88），正文是干净的 `{"r": 1}`，推理没有混进正文。
  - 用量字段里有 `output_tokens_details.thinking_tokens`，`output_tokens` 已经包含思考 token。
- **白米饭对比**（花钱前先问用户）：脚本 `scripts/claude-storyboard-compare.mjs`。
  - 做法与 `storyboard-design-ab.mjs` 相同：冻结输入按生产同一口径投影，锁台词版提示词，只调设计分镜一步，不重试，判据用生产的 `ensureStoryboardDesign`，表面计数照抄那个脚本。唯一的差别是 Claude 不带 responseSchema，和生产一致。
  - 新分镜写法还没合进本分支，用 `--prompt-rev 58b927d` 取那一版提示词：16334 字，含「分镜写法」；master 那版是 15344 字。58b927d 与 master 之间分镜相关只改了提示词、审阅、修订三个文件，投影与判据代码一样，所以不需要先合分支。
  - `--dry-run` 用免费的 count_tokens 数出输入是 14588 token（四个型号相同）。按 MiMo 同一输入的输出量（2.0–2.3 万 token，其中推理 1.2–1.3 万），假设输出 1.2–2.5 万 token，每次约 Opus $0.30–0.56、Sonnet $0.15–0.28、Haiku $0.007–0.014、Fable $0.75–1.40，四个型号各 2 次合计约 $2.4–4.5。

## 白米饭对比结果（2026-10-19 第一轮）

用户确认后跑：四个型号各 2 次，提示词取 58b927d，输入是 `kite-input/run-artifacts.json`，并发 4，思考与 effort 都用各型号默认值。
原始记录在 `reports/claude-storyboard-compare-2026-10-19/`（calls.jsonl 里有通过那几次的完整分镜），还没入库。MiMo 两行取自 58b927d 的 `round5-kite`，那次带 responseSchema。

| 模型 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 空镜 beat / 开场空镜 | 特写 / 视角 / 特殊机位 / 运镜 | 主角出声 beat | soundDesign 点名 | 对不上剧情的台词 | 方向词 beat | 文字量 | 输入 / 输出（思考） | 费用 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mimo-v2.6-pro | 1 | 通过 | 12 / 36 | 94 秒 | 2.6 秒 | 3 / 是 | 11 / 2 / 6 / 0 | 10/36 | 15/36 | 0/4 | 9/36 | 3909 | 8581 / 22613（11925） | — | 476 秒 |
| mimo-v2.6-pro | 2 | 通过 | 11 / 34 | 93 秒 | 2.7 秒 | 4 / 是 | 11 / 2 / 3 / 1 | 9/34 | 14/34 | 0/4 | 0/34 | 2961 | 8581 / 20219（12640） | — | 399 秒 |
| opus-5-5 | 1 | 未返回严格 JSON | — | — | — | — | — | — | — | — | — | — | 14588 / 34469（15155） | $0.748 | 330 秒 |
| opus-5-5 | 2 | 未返回严格 JSON | — | — | — | — | — | — | — | — | — | — | 14588 / 40353（22571） | $0.865 | 392 秒 |
| sonnet-5-5 | 1 | 通过 | 8 / 31 | 88 秒 | 2.8 秒 | 6 / 是 | 9 / 1 / 5 / 0 | 11/31 | 20/31 | 0/4 | 10/31 | 3143 | 14588 / 20181（7636） | $0.231 | 154 秒 |
| sonnet-5-5 | 2 | 通过 | 9 / 31 | 90 秒 | 2.9 秒 | 5 / 是 | 7 / 0 / 4 / 0 | 11/31 | 21/31 | 0/4 | 13/31 | 3338 | 14588 / 21317（7987） | $0.242 | 166 秒 |
| haiku-5-5 | 1 | 未返回严格 JSON | — | — | — | — | — | — | — | — | — | — | 14588 / 40119（23811） | $0.022 | 181 秒 |
| haiku-5-5 | 2 | 通过 | 9 / 35 | 90 秒 | 2.6 秒 | 7 / 是 | 7 / 0 / 8 / 0 | 5/35 | 16/35 | 0/4 | 9/35 | 3292 | 14588 / 38254（24345） | $0.021 | 175 秒 |
| fable-5-1 | 1 | 通过 | 12 / 37 | 95 秒 | 2.6 秒 | 5 / 是 | 9 / 2 / 7 / 0 | 15/37 | 22/37 | 0/4 | 23/37 | 4983 | 14588 / 24425（6227） | $1.367 | 334 秒 |
| fable-5-1 | 2 | 通过 | 12 / 42 | 97 秒 | 2.3 秒 | 7 / 是 | 12 / 4 / 12 / 0 | 16/42 | 27/42 | 0/4 | 13/42 | 3856 | 14588 / 33332（16984） | $1.812 | 435 秒 |

带「代理」性质的列（特写、视角、出声、点名、方向词）只是表面计数，写得对不对要逐份读。

- **结构**：8 次里 3 次「未返回严格 JSON」——Opus 0/2、Haiku 1/2。三次都是 `end_turn` 正常结束、输出完整（正文约 1.6–1.9 万 token），不是截断。
  - **失败原文没有存下来**：这一轮脚本只记了用量与结束原因，查不出是代码块包裹、JSON 前后多了说明文字，还是字符串里有没转义的引号。脚本已改成失败时保存原文，下一轮可查。
  - 生产里设计分镜一步有 2 次调用预算，被拒会带诊断再试一次；这一轮刻意只调一次，所以不等于生产上的成功率。
  - 这正是计划里写的「第一期没有 Schema 约束解码」的风险，现在有了第一份数据。
- **写法**：通过的 5 份都按新写法开场（门口空镜 → 电饭锅冒白气），锁台词 0 处改动，时长都在 76–104 秒窗口内。
  - Fable 最细：片段 12、beat 37–42，与 MiMo 的密度相近，视角与特殊机位最多。
  - Sonnet 片段最少（8–9 段），每镜略长（2.8–2.9 秒）。
  - Haiku 能过判据，但主角出声的 beat 最少（5/35）。
- **耗时**：Sonnet 与 Haiku 约 2.5–3 分钟，Opus 5.5–6.5 分钟，Fable 5.5–7 分钟；MiMo 是 6.5–8 分钟。
- **费用**：合计 $5.31，超出事先估算的 $2.4–4.5。原因是 Fable 输出 2.4–3.3 万 token、Opus 3.4–4.0 万 token，超过了按 MiMo 设的 2.5 万上限；Opus 的输出比 Sonnet 多将近一倍，主要多在思考。

### 查 JSON 失败的原因（同日，Haiku 再跑 4 次，$0.085）

脚本改成失败时保存原文后，用同一输入让 Haiku 再跑 4 次，记录在 `reports/claude-storyboard-compare-2026-10-19/haiku-round2/`。

- **3 次失败的形状完全一样**：整段正文被 Markdown 代码块包着，`` ```json `` 开头、`` ``` `` 结尾，中间是完整合法的 JSON。不是 JSON 前后多了说明文字，也不是字符串里有没转义的引号。
- **原因**：设计分镜的系统提示只写了「只输出严格 JSON」，没写「不要 Markdown 代码块」。其他阶段共用的 `JSON_ONLY` 里有这句，设计分镜没有用它。MiMo 与千问有 `json_object` / `json_schema`，所以从没遇到过；Claude 没有 JSON 模式，Haiku 会顺手加代码块，Sonnet 与 Fable 4 次都没有加。
- **去掉代码块之后**（离线核对，没有调用模型）：3 份里 2 份直接通过生产的分镜判据，1 份是时间轴问题（`STORYBOARD_BEAT_TIME_DISCONTINUOUS` / `..._NOT_COVERING_SHOT`），生产里会带诊断重试一次。
- **第 4 次 JSON 合法，但同样是时间轴问题**。
- **Opus 那 2 次很可能也是代码块**：输出量与正常结束都和 Haiku 的失败一样，但原文没存，不能确认。

### 定下来的处理（同日，用户确认）

- **去掉整段包裹的代码块**：只在 Claude 客户端里做，规则见上面「JSON 怎么保证」。另三家逐字不变；前后有说明文字等其余形状照旧严格。
  - 用 `unwrapWholeCodeFence` 离线回放 Haiku 第二轮那 3 份失败原文：3/3 去掉包裹后能严格解析。
  - 按前面的离线判据，其中 2 份直接通过分镜判据，1 份是时间轴问题，生产里会带诊断重试一次。
- **默认型号改成 `claude-sonnet-5-5`**：2/2 通过、没加代码块、每次约 $0.24、2.5 分钟左右，页面型号列表也把它排第一。
  - Fable 写得最细，但每次 $1.4–1.8、5.5–7 分钟。
  - Opus 的写稿质量还没看到，要不要在去掉包裹之后重测，由用户决定。

## 已知风险

- 第一期没有 Schema 约束解码，候选、评审、分镜这几步的结构失败率要靠对比和回放观察。
- 默认开着思考，比另外三家默认关思考慢、也更贵。
- Fable 5.1 要求组织开着 30 天数据保留，零数据保留（ZDR）的组织调用会 400。
