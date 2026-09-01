# Durable Task v1 验收记录

日期：2026-09-01
验收标准：[Claude Artifact e5bf3b6b-2ced-45a8-a6c5-e8d4ee1e2b3a](https://claude.ai/code/artifact/e5bf3b6b-2ced-45a8-a6c5-e8d4ee1e2b3a)

## 构建身份

- 当前仓库实际基线 HEAD：`6024af5b0a1bc1c137d531d1f9304afba9e5cbd2`
- tracked diff SHA-256：`c3aaff8176a8ae2fc73aaad8726947f16ac551eb5c2296f36bcc6ff4cde1ca3b`
- tracked diff + 新增实现/测试脚本 SHA-256：`6580786635452b7c78ada890f02374f1eefcc710dd8c4d7580119fb9d01ec6a1`
- 验收标准页标题中的旧 commit 不是本次开始时的实际 HEAD；本记录全部锚定上述实际 HEAD。

## 总结结论

实现计划本身已完成，零成本功能验收与全量回归通过。严格按外部验收页逐字判定时，结论为 **有条件通过，未进入付费 live C 组**，原因是验收页有两处与用户确认的实施计划或既有媒体 Schema 冲突：

1. 验收页 G1-3 要求 `TASK_DEADLINE_EXCEEDED`，确认后的实施计划明确要求 `failed/TASK_STALLED`。实现与文档使用后者。
2. 跨两个 Run 的 10 个 Artifact 中，8 个非媒体 Artifact 原始 digest 完全一致；角色图和 shotVideo 的既有业务 Schema 本来就包含 Run 绑定 URL/文件名、provider task ID、elapsed/time 字段，因此原始 digest 必然不同。去除这些动态字段后 10/10 一致。为追求原始 digest 相等而删除或伪造字段会违反“不改变媒体 Artifact 业务 Schema”。

验收页要求零成本 gate 未全绿时不得触发 live 付费调用，因此未调用真实 Qwen/MiMo/DeepSeek/Jimeng/Seedance/Kling/MiniMax。

## Gate 结果

| Gate | 结果 | 证据 |
| --- | --- | --- |
| G0 基线归档 | PASS | 从实际基线 HEAD 独立启动旧代码，完成 12 revisions / 10 current Artifact 全链；见 `reports/durable-task-baseline/6024af5-fixed-keys/` |
| G1 锁、watchdog、锁外读 | PASS（实施计划）/ literal mismatch | 29 个 Durable 专项测试覆盖不可重入 unlocked 路径、多调用续期、真实 stalled、<200ms 锁外读；错误码按确认计划为 `TASK_STALLED` |
| G2 Task Store/claim/queue | PASS | safe path、原子五目标 claim、幂等/busy、分池容量、140MB 预算、release、迟到 Runner、不同 requestId 不复用、unclaimed import/browser commit 均有回归测试 |
| G3 冻结与 conflict | PASS | provider 前变化 call=0；provider 中变化 call=1 且不 commit；仅三类 producer；浏览器副本 digest 不匹配 409 且不创建 Task；见 `evidence/g3-freeze/` |
| G4 reconciliation/续跑 | PASS | 第三阶段中断、首个缺失阶段续跑、五子任务/父任务补记 completed、usage 保存、源 SHA-256、禁止客户端指定阶段；见 `evidence/g4-resume/` |
| G5 浏览器/HTTP attach | PASS | 双标签页 attach 同一 taskId、active pipeline 不建新 Run、健康检查不阻塞恢复、旧同步 analyze 契约、SSE 断线后继续；见 `evidence/g5-browser/` |
| G6 Adapter 与 digest | CONDITIONAL | 8/10 raw exact，10/10 normalized exact；Animation/Story/Plan/人物精修/角色图部分成功/shotVideo 形状均通过；见 `evidence/g6-final/comparison.json` 与 `evidence/g6-adapters/` |
| G7 trace/usage/回归 | PASS | 精确 Task requestId/target expected revision 合成既有 production headers；父子 usage 持久聚合；`npm test` 922/922 |
| G8 文档与边界 | PASS | README、AGENTS.md、CLAUDE.md、Production Lineage、Benchmark 同步；T04/T05 未冒充完成 |
| C 真实付费 provider | SKIPPED BY GATE | 外部标准要求零成本 gate 全绿后才能付费；G1 literal code 与 G6 raw media digest 两项未逐字满足 |

## 关键数字

- Durable Task 专项：29/29
- 全量测试：922/922，0 fail / 0 skipped / 0 todo
- `git diff --check`：通过
- `node --check`：server、browser app、Task Manager/Store、Coordinator 与三个验收脚本全部通过
- Task sidecar 扫描：5 个 index、47 个 Task；Prompt/Data URL/Base64/密钥类泄漏 0
- 基线对比：8/10 原始 digest 一致；10/10 动态媒体字段归一后内容一致
- 角色图部分成功：4 请求、2 ready、2 failed，Task `completed/partialSuccess=true`，Artifact 仅 2 个 ready 项且不含 progress `status`

## 基线与内容对比

- 旧代码归档：`reports/durable-task-baseline/6024af5-fixed-keys/`
- 旧代码完整链输出：`evidence/g0-baseline-fixed2/chain.json`
- 最终代码完整链输出：`evidence/g6-final/current-chain.json`
- 逐 Artifact diff：`evidence/g6-final/comparison.json`

原始不一致路径仅有：

- `characterImages:*`：`results[].url`、`results[].filename`
- `shotVideo:*`：`outputUrl/outputPath`、候选与 receipt 的 `providerTaskId/elapsedMs/generatedAt`

这些字段在改造前的 Artifact 中已经存在，且定义上绑定 project/run/nonce/实际 provider receipt；它们不是 Durable Task 引入的 Schema 漂移。

## 明确未完成项

- T04 orphan/quarantine 与正式 Generation Attempt Catalog
- T05 provider task ID 查询、重启后 provider resume/cancel、lease、多 worker、正式 batch queue
- Node 重启后的大型请求体恢复
- `abandoned` 对远端 provider 的真实取消

以上继续保持未勾选，也没有在文档或 UI 中宣称已完成。
