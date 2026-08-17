# 局部纠错 Debug

当前服务会在 `debug/partial-repairs/` 下，为每次**已经成功签发 repair plan** 的有界局部纠错创建独立目录：

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

这些文件只用于本机排查，不是 Production Lineage Artifact、业务事实来源、恢复数据或导出包内容。H3 局部 repair 之后仍需通过最终 Plan 校验和独立语义审计；应以正常工作流结果判断是否签发 Artifact。运行记录被 `.gitignore` 排除，禁止提交到 Git。记录不会保存完整 Story/Foundation/Animation Plan、API Key、HTTP Header、Cookie、Data URL 或 Base64 媒体。

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

`ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 使用同样的私有目录结构，当前建议为 `debug/animation-plan-model-outputs`。每次真实模型响应按调用顺序保存，并在 `metadata.json` 中标记 Foundation、shot batch、实际 H3 repair 或首次语义审计等阶段；output-only 模式不会创建 Animation Prompt 抓取文件。

`model-output.txt` 是模型实际 completion content 的完整 UTF-8 文本；`metadata.json` 保存字节数、SHA-256、attempt 状态，以及彼此分离的 production/provider requestId。它不保存输入 Prompt、HTTP envelope、Header、密钥或媒体。正文可能包含完整失败剧情或镜头提示词，应视为敏感本机数据；不得提交、导出、恢复为 Story/Plan 或放进 `public/`。无模型正文的 timeout/transport attempt 只会有 metadata，不会伪造空输出文件。
