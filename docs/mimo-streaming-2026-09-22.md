# MiMo SSE 传输接入与验收（2026-09-22）

MiMo 的统一请求体改为 `stream: true`，V2.5 / V2.6 文本、图片、原生视频理解复用现有 `src/sse-stream.js`。只改变传输，不改变模型路由、Prompt、thinking、JSON 模式、token 预算、媒体回退与业务校验。页面仍在完整结果通过校验后展示，未增加逐字输出。

接口依据：[MiMo 官方 Chat Completions 文档](https://mimo.mi.com/docs/en-US/api/chat/openai-api)。实际接口返回 `text/event-stream`、`delta.content` / `delta.reasoning_content`、结束标志和结构化 usage；没有发送未文档化的 `stream_options`。

## 调用与消费边界

`WorkflowService / ModelCallCoordinator → MimoClient.requestCompletion → readSseCompletion → 原有 JSON 解析与合同校验 → commit`。推理内容不混入正文；SSE 进度最多每 10 秒续一次 Durable 心跳。保留 request ID、finish reason 和供应商实际返回的 usage，先记账再检查取消与冻结依赖。

不完整 EOF 报 `MODEL_STREAM_INCOMPLETE`，已收到数据后的连接异常报 `MODEL_STREAM_ABORTED`。取消保留用户控制原因，不能把半截 JSON 签发为成功，也不降级成非流式；现有 Coordinator 的重试预算仍有效。HTTP 非 2xx 仍读取原始错误体。

检查消费链发现 `AnimationPromptCapture` 原本会等待响应 clone 完整读完才返回 fetch，还把 SSE 当 JSON envelope。它现改为并行观测流，客户端及时收到响应；操作结束前收齐观测记录，并按调用序号完成日志。日志仍仅保存正文、用量与元数据，断流记失败。共享日志层的此项修复也适用于既有 Qwen SSE；未修改 Qwen 客户端。

## 自动化证据

- 新增流式回归在旧 MiMo 客户端上 6 项失败，修改后通过；新增日志非阻塞与断流用量回归在旧日志实现上 2 项失败，修改后通过。
- 针对测试：264/264 通过。覆盖拆开的中文 UTF-8 字节、推理与正文分离、尾块用量、无用量、请求 ID、心跳节流、断流、超时、暂停/终止、冻结冲突后保留用量、原有媒体回退与 JSON 修复。
- 本地真实 HTTP 夹具证明开启分镜日志后仍能收到心跳，并立即按原暂停原因断开连接；没有增加重试或伪造日志成功。
- `node --check src/mimo-client.js`、`node --check src/animation-prompt-capture.js`、`git diff --check` 通过。
- `npm test`：1916 项，1892 通过、18 失败、6 跳过。18 项均为修改前已有的 `exports/` 历史快照/实验测试问题（3 项缺失模块、15 项旧 Prompt 锚点），没有新增失败。
- 全量日志：`/tmp/mimo-stream-full-final.log`；针对日志：`/tmp/mimo-stream-targeted-final.log`。

针对命令：

```sh
node --test test/mimo-stream.test.js test/model-completion.test.js test/text-client-durable-usage.test.js test/text-client-cancellation.test.js test/workflow.test.js test/animation-prompt-capture.test.js test/browser-workspace-debug.test.js test/full-story-defect-characterization.test.js test/token-usage.test.js
```

## 真实接口证据

使用本机实际配置、系统代理、新版 MimoClient 和启用的分镜日志包装器，发送合成短 JSON / 红色图片 / 红色视频，不使用用户故事，不创建或修改 Run。表中成功样本均 HTTP 200、`text/event-stream`、正文严格 JSON 通过、日志正文一致、用量已记录。响应交付时间是 fetch 返回给客户端的时间，不等同首个正文 token 时间。

| 模型 | 输入 | 响应交付 / 完成（毫秒） | SSE 事件数 | total tokens |
| --- | --- | --- | --- | --- |
| mimo-v2.5 | 文本，诊断预算 1024 | 5692 / 12015 | 112 | 328 |
| mimo-v2.5-pro | 文本 | 4780 / 6626 | 10 | 59 |
| mimo-v2.6-flash | 文本 | 2444 / 3359 | 10 | 60 |
| mimo-v2.6-pro | 文本 | 885 / 2043 | 11 | 69 |
| mimo-v2.6-pro-ultraspeed | 文本 | 727 / 1239 | 6 | 56 |
| mimo-v2.6-flash | 图片 | 2618 / 3898 | 23 | 132 |
| mimo-v2.6-flash | 视频 | 5835 / 7846 | 37 | 191 |

首次 V2.5 文本测试的测试预算只有 256 tokens：SSE 正常，收到 102 个事件，但 `finish_reason=length`，严格 JSON 失败（总耗时 10132 ms）。为检验预算截断原因，仅把该测试预算改为 1024 后得到上表成功样本；没有改应用配置、Prompt 或默认预算。这次失败保留在原始记录中，没有当成通过。

记录：`/tmp/mimo-stream-live.json`、`/tmp/mimo-stream-live-v25-budget.json`；测试脚本分别为同名 `.mjs`（后一脚本是 `/tmp/mimo-stream-live-v25-budget.mjs`）。这些是短输入协议验收，不证明长期稳定性或剧情生成质量。

## 服务生效与完成边界

重启前检查 35 份 Task Store，运行/排队任务为 0。只停止确认属于本项目的旧 PID 77992；用 Node 24.19.0 `npm start` 启动 PID 66847，开始时间 2026-09-22 21:25:26（Asia/Taipei）。该进程加载此次修改后的代码，端口 4173 首页 HTTP 200，`/api/health` 为 live，MiMo reachable/modelAvailable 均为 true；分镜日志开启。

当前分支 `codex/story-quality-phase1`，HEAD `eefbca1e272c87a84a97c922b5e120d1cc861cd3`。修改未提交、未推送，既有脏工作区保留。此次核心生产修改只有 MiMo 客户端与分镜响应观测层，另同步测试和说明。

已完成 MiMo SSE 接入、短输入真实模型与媒体验收、运行服务更新。未跑用户完整故事/分镜生成、超过 306 秒的长请求或所有模型的图片/视频组合；不宣称改变模型生成速度、语义质量或远端取消计费结果。
