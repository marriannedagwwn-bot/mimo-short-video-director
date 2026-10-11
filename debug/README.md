# 局部纠错 Debug

当前服务会在 `debug/partial-repairs/` 下，为每次**已经成功签发 repair plan** 的有界局部纠错创建独立目录。现在只有一种局部纠错：Full Story 主角姓名的 `full_story_partial_repair/1.0`（Animation Foundation 与 H3 提示词的局部纠错已于 2026-10-11 随旧 3.0 分镜删除）。

```text
<UTC 时间>-<stage>-<UUID>/
  01-trigger.json
  02-repair-prompt.txt
  03-model-response.json
  04-result.json
```

- `01-trigger.json`：原始错误、结构化 diagnostics、签发目标和目标当前值。
- `02-repair-prompt.txt`：实际发送给纠错模型的局部 Prompt（敏感字段已脱敏）。
- `03-model-response.json`：模型返回的局部 replacement 投影。
- `04-result.json`：这一次有界局部纠错在当前阶段的接受或拒绝结果及原因；`repaired` 不等于后续 Artifact 已提交。

这些文件只用于本机排查，不是 Production Lineage Artifact、业务事实来源、恢复数据或导出包内容；应以正常工作流结果判断是否签发 Artifact。运行记录被 `.gitignore` 排除，禁止提交到 Git。记录不会保存完整 Story/Animation Plan、API Key、HTTP Header、Cookie、Data URL 或 Base64 媒体。

默认目录可通过服务端环境变量 `PARTIAL_REPAIR_DEBUG_DIR` 覆盖。Debug 写入失败只会输出脱敏警告，不会改变原本的纠错成功或失败结论。

每个文件默认最多 256 KiB；超限 JSON 只保留原始字节数和 SHA-256，超限 Prompt 会按 UTF-8 边界截断并附摘要。当前不会自动删除历史 session，需要释放空间时可以手工删除 `partial-repairs/` 下已完成的时间戳目录。

## Full Story 与 Animation Plan 全量模型输出

`FULL_STORY_MODEL_OUTPUT_LOG_DIR` 启用的是另一套独立 sidecar，不受本页 partial-repair 的 256 KiB 上限影响。当前配置 `debug/full-story-model-outputs` 时，路径结构为：

```text
<projectId>/<runId>/<artifactId>/<productionRequestId>/<operationId>/
  attempt-01-<unique>/
    model-output.txt
    metadata.json
  attempt-02-<unique>/
    model-output.txt
    metadata.json
```

`ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 使用同样的私有目录结构，当前建议为 `debug/animation-plan-model-outputs`。分镜路由与单镜提示词路由里的每次真实模型响应按调用顺序保存；output-only 模式不会创建 Animation Prompt 抓取文件。4.0 自主分镜各步另按步骤名记在下一节的 `STAGE_MODEL_OUTPUT_LOG_DIR`。

`model-output.txt` 是模型实际 completion content 的完整 UTF-8 文本；`metadata.json` 保存字节数、SHA-256、attempt 状态，以及彼此分离的 production/provider requestId。它不保存输入 Prompt、HTTP envelope、Header、密钥或媒体。正文可能包含完整失败剧情或镜头提示词，应视为敏感本机数据；不得提交、导出、恢复为 Story/Plan 或放进 `public/`。无模型正文的 timeout/transport attempt 只会有 metadata，不会伪造空输出文件。
## 工作流阶段全量模型输出

`STAGE_MODEL_OUTPUT_LOG_DIR` 是第四套独立 sidecar，覆盖参考视频链路各阶段、候选对照评审与命题修订、剧情体检与按问题修改、承诺核对、4.0 自主分镜各步、单镜提示词与导演助手，完整清单是 `server.js` 的 `STAGE_MODEL_OUTPUT_LOG_SCOPES`。走 `generateValidatedJson` 的阶段在那里注册即生效；走 `modelCallCoordinator` 的阶段由调用方自己接 `attemptObserver`，每次 provider 调用各留一条记录。目录结构、权限与原子写与上一节完全一致，只是这些阶段在该层没有 Production Lineage 上下文，所以路径固定落在：

```text
unbound/unknown-variant/<stage>/unbound-request/<operationId>/
  attempt-01-<unique>/
    model-output.txt
    metadata.json
```

`<stage>` 就是阶段 id（例如 `analysis` / `variants` / `storyCandidateReview` / `storyQualityReview` / `storyboardDesign` / `shotVideoPrompt`）。**scope 取值必须逐字等于 stage 名**：writer map 按 scope 建、按 stage 查，对不上就静默不写——2026-09-07 之前曾有阶段压根没注册，失败时模型原文永久丢失、只能靠反推根因。**成功与失败都记**：`metadata.json` 的 `attempt.status` 为 `succeeded` 时 `code` 是 `MODEL_COMPLETION_ACCEPTED`，失败时 `category` / `code` 来自 `classifyAttemptError`（例如 `output-contract` / `OUTPUT_CONTRACT_INVALID`），复用与 Full Story 同一份分类，不另建映射；`attempt.diagnostics` 保留校验器 `OutputContractError.details` 的 `code` / `jsonPointer` / `reason`（脱敏、最多 100 条，不含其他字段），非内容失败为空数组——2026-09-24 之前这里漏传，失败记录的 diagnostics 恒为 `[]`。走 `modelCallCoordinator` 自己接 `attemptObserver` 的阶段（候选对照评审、承诺核对、命题修订、剧情体检与按问题修改、自主分镜各阶段）同日一并补上，写法与脱敏规则相同。一次调用内如果 client 内部发生了 JSON 重试或视频退回逐帧，每条 completion 各留一条记录，只有最后一条带本次阶段判定，更早的标记为 `superseded`。

它填的是这两类失败此前完全没有本地痕迹的空白：`OutputContractError` 只返回 502 而不落盘，`ModelResponseError` 的原文只在内存 `AttemptStore` 里存 30 分钟且没有接口能取。

不设该环境变量时完全不写。写入失败只输出脱敏告警，不改变阶段成败、不增加模型调用、不改错误文案。同样不保存输入 Prompt、HTTP envelope、Header、密钥、Cookie、Data URL 或 Base64 媒体；正文可能包含完整创意简报或角色边界，按敏感本机数据对待，不得提交、导出或放进 `public/`。
