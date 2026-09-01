# Production Lineage 与持久状态契约

## 1. 解决的问题

该机制解决的是“哪个结果属于哪一版输入”，不是判断模型写出的角色、动作或镜头语义是否正确。

- 角色是否越过 `fixedCharacterBoundary`，仍由现有 Guardrails、Schema 和语义 validation 负责。
- Production Lineage 负责阻止“新 Story + 旧 Animation Plan”“新 Plan + 旧视频”“旧异步响应覆盖新结果”和“不可信导入包与当前状态混合”。

lineage 是服务端确定性签发的 sidecar。任何 LLM 都不能生成、补写或修改 revision、digest、dependency 或 media namespace。

Task sidecar 同样不是业务事实源。它只记录 `taskId`、父子关系、状态、冻结引用、模型快照、进度、usage、结果 Artifact refs 和脱敏错误；不保存 Prompt、Data URL、Base64、完整请求体或 Artifact 内容。ProductionStateStore 中的 current Artifact 仍是唯一业务权威。

## 2. 身份与冻结点

浏览器每次从视频输入运行主流程时创建一个 Run：

```text
projectId
└── runId
    ├── Stage 状态
    ├── Artifact revisions
    ├── Checkpoint
    └── tasks/index.json（Durable Task 执行 sidecar）
```

每个 Artifact 成功提交就是一个数据冻结点。服务端对 canonical JSON 计算 SHA-256；对象键顺序不影响摘要，数组顺序和真实值变化会影响摘要。同一 artifact 的不同内容使用单调 revision，例如 `fullStory-V1-r2`。

公开 lineage 最小结构：

```json
{
  "schemaVersion": "1.0",
  "artifactId": "animationPlan:V1",
  "artifactType": "animationPlan",
  "revision": "animationPlan-V1-r2",
  "contentDigest": "<sha256>",
  "dependencies": [
    {
      "artifactId": "fullStory:V1",
      "revision": "fullStory-V1-r3",
      "contentDigest": "<sha256>"
    }
  ],
  "status": "current",
  "mediaNamespace": "<project>/<run>/<plan-revision>-<digest-prefix>"
}
```

## 3. 当前依赖图

```text
referenceAnalysis
  └─ sourceScriptReconstruction
      └─ creativeBrief
          └─ visualGuardrails
              └─ themeVariants
                  └─ variant:<variantId>

referenceAnalysis + reconstruction + brief + guardrails
  + themeVariants + selected variant
      └─ fullStory:<variantId>

referenceAnalysis + reconstruction + brief + guardrails
  + selected variant + full story
      └─ animationPlan:<variantId>
          ├─ characterImages:<variantId>:<roleIndex>
          ├─ shotFrame:<variantId>:<shotId>:<kind>（旧 v2）
          └─ shotVideo:<variantId>:<shotId>
              └─ shotVideo:<variantId>:<nextShotId>（仅显式使用上一镜抽帧时）
```

依赖记录的是实际 revision/digest，不只是 `variant.id` 或 `shotId`。上游提交新 revision 后，仍引用旧 revision 的所有下游 Artifact 会递归变为 `stale`。

Legacy Full Story 子树纠错和 Animation 的 `artifact_partial_repair/1.0` 有界纠错都发生在目标 Artifact 提交之前。repair plan 的 `baseDigest` 只绑定本次 operation 的首次候选，`authorityDigest` 只证明本次局部调用使用的最小权威投影未变化；当前进程还以不可由模型序列化返回的私有身份绑定实际签发计划。三者都不是 Production Lineage revision、持久化签名、Artifact 内容 digest 或第二份剧情/角色事实。Full Story 当前只签发 protagonist `name` 可由验签固定角色边界唯一恢复的安全子集；未知正文、配角身份错误、场次人物与动作/对白冲突、没有签发值来源的必填剧情字段在提交前直接失败。首次失败候选、repair plan、模型 replacement 与失败的合并结果都不签发 revision，也不应使既有下游 stale。

Legacy Full Story Beat–Scene postpass 同样位于 commit 门之前，但不属于失败候选 repair。初轮候选必须先通过完整阶段校验，postpass 才在同一个浏览器 request token、冻结的 `expectedCurrentRevision` 与同一组实际上游 dependencies 下独立调用一次 AI；其业务输入只有完整 Full Story JSON 和专用提示。`beatSheet` 保持只读，唯一合法结果是 unchanged，或把对应 `beatSheet[beatIndex].storyAction` 的连续逐字原文作为 `addition` append 到已有 `sceneScript[].visibleAction`。`addition` 必须包含该 review 的 `beatEvidence`，且全部证据只能来自该 `storyAction` 与相关现有 `visibleAction`；AI 不得自由生成 suffix，无法逐字投影时必须返回 `blocked`。一次最多命中 3 个已有场次，每条 addition 最多 600 字，合计最多 1200 字，其他字段和原动作前缀全部冻结。正常路径的 2 次 provider call、初轮实际 retry/repair 后最多 3 次 provider call 都属于同一个 Full Story operation，不对应多个 Artifact。初轮候选、postpass completion、addition 与合并中间态均不创建 revision、Checkpoint、dependency 或 stale 事件。

postpass 返回 `blocked`、协议/供应商错误、越界或非追加式变化，或者最终完整复验失败时，当前 operation fail closed：不得把初轮候选作为 fallback 提交，不得再次 postpass，也不得改变既有 current Story 或下游 stale 状态。只有 unchanged 或 append-only 合并后重新通过全部校验的最终 Story 才穿过既有 `expectedCurrentRevision`/dependency 门，并提交一次 `fullStory:<variantId>` Artifact。若最终内容 digest 与 current revision 相同，仍沿用既有同内容幂等规则；postpass 本身不能制造 revision。

只有原子合并后重新通过完整阶段校验的最终 Full Story/Animation Plan 才进入既有 commit、`expectedCurrentRevision` 与 dependency 门。H3 最终证据审计若只发现纯 `videoPrompt` 实质冲突，可在同一 operation 内签发唯一一次语义 Prompt repair；修复候选必须重新通过完整 Plan 校验，并复审目标与相邻镜头。初审、repair plan、replacement、复审失败结果都不创建 revision/media namespace；只有最终通过版本提交一次。当前 attempt store 可记录 primary/局部调用的协议结果，但它不是 Artifact 内容来源，也不能被恢复成新的 current revision。

`debug/partial-repairs/` 是上述有界纠错的本地观测 sidecar：它只在 repair plan 已签发后记录目标投影、局部 Prompt、replacement 投影与最终结果。Debug session UUID、目录名和文件摘要都不参与 Artifact digest、dependency、revision、media namespace、stale 传播或 `expectedCurrentRevision` 判断；文件缺失、写入失败或手工清理也不能改变 current 状态。这些记录不得随规划包导入导出、不得恢复成候选或 replacement，也不得作为第二份剧情、角色或 Prompt 事实源。

显式开启的 Full Story 全量模型输出日志同样只是提交前的本地观测 sidecar。浏览器已有 production token 通过非业务 Header 旁路传递，服务端只用 current running stage 校验 project/run/artifact/production requestId 的日志归属；该关联不是 Artifact dependency，也不能替代 commit 的 `expectedCurrentRevision` 门。日志 metadata 保存明确的 `stage`，但 primary、实际 retry/repair 与 Beat–Scene postpass 的完整 completion、供应商 requestId、文件路径及摘要都不得进入 Full Story content、manifest、Checkpoint、revision、digest、导出包或恢复流程。未绑定 direct API 日志必须标记为 unbound，禁止按 Variant 或时间搜索 Run 后猜测关联。

Animation Plan 全量模型输出日志遵循同一 lineage 隔离，但使用独立配置与固定 `animationPlan` scope。只有旁路 Header 精确命中 current `animationPlan:<variantId>` running request 及其 expected current revision 时，日志才可标记 verified；Foundation、shot batch、实际 repair 和语义审计的 completion 仍只是该请求的敏感观测文本。响应内容、调用顺序、provider requestId、摘要和日志路径均不得进入 Plan JSON、metadata receipt、manifest、revision/digest、media namespace、dependency 或 stale 传播；日志缺失、写入失败或被清理也不能改变 Plan 是否签发。

`productionStrategy.videoPromptProfile` 和各镜 `videoPrompt` 属于 Animation Plan 内容，因此 Profile 改写不是运行时模型设置变化，也不能就地覆盖当前 Plan。用户拒绝“重新生成提示词”时不提交 Artifact，Plan revision/media namespace 与媒体状态均不变；用户确认后，服务端先证明只改变 `videoPrompt` 和 Profile，再执行逐镜证据绑定语义审计。纯 Prompt fail 可在提交前经过一次有界修复与相邻复审，但结构化 shot facts fail 不得修 Prompt。只有最终完整校验和审计 verdict=`pass` 都成功，才提交同一 `animationPlan:<variantId>` 的新 revision；协议错误、语义失败或其他改写错误均不得先提交或 stale 旧媒体，旧 Plan 继续 current。即使 Full Story 依赖未变，成功改写后的新 Plan digest/media namespace 也必须使依赖旧 Plan revision 的角色图、旧 v2 帧和视频递归 stale。

Animation Plan 同样只有在 Foundation/shot 合并、完整契约校验、逐镜证据审计以及必要的有界修复全部通过后，才作为一次 Artifact revision 提交；中间候选、修复中间态都不是 Artifact，也不是恢复数据。

默认每个 `shotVideo` 只依赖当前 Animation Plan。若某镜请求显式使用 `continuityReferenceMode=previous_shot_frames`，它还必须依赖 Plan 顺序中紧邻上一镜的 current `shotVideo` 精确 revision/digest；Task 创建时由服务端冻结该 source lineage，并由 Runner 按精确媒体形状提交 Artifact。上一镜重生成或切换候选会签发新 revision，并递归使所有引用旧 revision 的后镜视频 stale。切换后镜自己的候选只是更新同一媒体 Artifact，必须原样保留已有依赖，不能退回为只依赖 Plan。

浏览器恢复和运行时缓存必须按 `variantId + shotId`（旧 v2 帧再加 `frameKind`）区分媒体结果。服务端只将具体下游 Artifact 标为 stale 时，前端只移除对应缓存项；不得清空其他 Variant、上一镜或同 Plan 内仍为 current 的媒体结果。

## 4. 异步请求规则

Durable Task 创建时，服务端在共享的 per-Run Coordinator 临界区内读取 current Artifact、冻结依赖并一次占用全部写目标。浏览器若携带 Artifact 副本，只用于 digest 复核；Runner 使用服务端冻结内容，冻结后不得在调用前偷偷换成更新后的 current 内容。

冻结集合包括：

- `projectId` / `runId`
- 目标 `artifactId`
- Task 独立签发的 `requestId`
- `expectedCurrentRevision`
- 完整上游 dependency revisions
- dependency content digests
- 创建时的 provider/model 快照与非 Artifact 输入摘要

每次实际 provider 调用前只比较 current revision/digest 与冻结值，不重新取内容。调用前已变化时，Task 在付费调用前变为 `conflicted`；调用期间变化时，provider 返回后的复检或锁内 commit guard 使其变为 `conflicted`，不提交结果。`ARTIFACT_REVISION_CONFLICT` 与 `ARTIFACT_DEPENDENCY_STALE` 也归入同一终态。

每个目标最多有一个 active owner。`directorPipeline` 创建时一次占用 `referenceAnalysis`、`sourceScriptReconstruction`、`creativeBrief`、`visualGuardrails`、`themeVariants` 五个目标；五个子任务顺序调用现有 WorkflowService 并逐阶段独立提交。目标没有 claim 时，既有浏览器快速提交和 package import 保持可用；有 claim 时，只有 owner Task/child Task 能在 Coordinator lock 内调用 `commitArtifactUnlocked`。release、watchdog 或重启后 owner 失效，迟到结果不能回写。

相同 active operation 的幂等键由 kind、全部目标、目标 expected revisions、冻结 dependencies、模型快照和非 Artifact 输入摘要组成；完全相同则复用 taskId，同目标不同 operation 返回 `TASK_TARGET_BUSY`。同一 Task 重复 finalize 时，服务端先识别相同 requestId、digest 与 dependencies，再比较 expected revision，因此只复用原 revision；不同 requestId 没有该豁免。

Run Coordinator 是显式不可重入的 FIFO 锁。持锁代码只能使用 `commitArtifactUnlocked`、`recordStageUnlocked`、`loadRunUnlocked` 和 Task Store 的 unlocked 方法，禁止从锁内调用公开 `commitArtifact()`、`recordStage()` 或 `loadRun()`。临界区只做本地状态操作，不含 provider、网络、FFmpeg 或模型校验。`readCurrentLineageSnapshot`、`GET /api/tasks` 与原子 manifest snapshot 的 `loadRun` 均为锁外读取；provider 返回后仍执行复检和锁内 commit 校验覆盖竞态。

任务状态固定为 `queued | running | completed | failed | conflicted | interrupted | abandoned`。所有带原因的终态共用脱敏规则；终态 Stage 更新必须匹配 `expectedRequestId`，旧请求不能覆盖新 Stage。

调度器分为 workflow/text（2 running、8 queued）和 media（4 running、8 queued），queued 请求体总预算默认 140MB。超出限制返回 `TASK_CAPACITY_EXCEEDED`，不创建失败 Task。任务没有总墙钟 deadline：provider 调用前把 watchdog 设置为 provider 自身 timeout/poll timeout 加 120 秒，本地校验、合并和 commit 使用 300 秒无进展窗口；每次 provider 返回、流事件和阶段进展都会续期。watchdog 触发后 Task 变为 `failed/TASK_STALLED` 并释放目标，错误明确提示远端调用可能已经提交并计费。


合法反例：JSON 对象只调整键顺序时 digest 不变，应复用当前 revision。非法串线：Variant 仍叫 `V1`，但标题、角色或剧情内容已变化时 digest 必须变化，旧 Story/Plan 不能继续使用。

## 5. 媒体隔离

Animation Plan 每个 revision 都获得唯一 `mediaNamespace`：

```text
<projectId>/<runId>/<planRevision>-<planDigestPrefix>
```

角色图片、旧 v2 镜头帧和视频请求必须携带当前 Plan lineage。服务端在调用 provider 前核对它仍为 current，并将产物写到：

```text
public/generated-images/<mediaNamespace>/
public/generated-videos/<mediaNamespace>/
```

文件名也带 Plan revision、digest 前缀和不可碰撞的请求 nonce。

远端生成往往要跑几分钟，这期间 Plan 可能被重新生成、上一镜候选可能被切换。因此 `/api/generate-shot-video` 在生成期间必须自己复验，而不是只依赖事后关卡：服务端把一个复验回调交给生成器，生成器在**任何供应商调用与文件写入之前**、**每条候选提交供应商之前**、**每条候选落盘并通过 ffprobe 之后**、**组装返回值之前**各执行一次。回调重新从状态库读取 run，比对 Plan 的 revision/digest/mediaNamespace 是否仍为 current；请求使用 `continuityReferenceMode=previous_shot_frames` 时还比对上一镜 current `shotVideo` 的精确 revision/digest 与选中候选。

任一复验失败即 fail closed：删除本次请求已经写入的全部候选 mp4，并把 `ProductionStateError`（`MEDIA_PLAN_LINEAGE_STALE` / `SHOT_VIDEO_PREVIOUS_REFERENCE_STALE`，HTTP 409）原样上抛，不得包装成配置或供应商错误。清理只删除本次调用自己算出的、含该请求 nonce 的路径，绝不扫描目录；清理本身失败只被吞掉，不改变 fail closed 的结论。只有过期触发删除——供应商错误与 ffprobe 失败维持既有语义，产物留在原地便于排查。

两处已知边界：单条候选一旦提交给供应商，主进程无法中断它（worker 在同一个子进程里完成提交、轮询与下载），那条的花费无法收回，复验阻止的是后续候选的付费、文件留存与结果回写；旧 v2 `first_last_frame` 路径写出的首尾帧 PNG 文件名不含请求 nonce，不在清理覆盖内。

复验之外，前端仍会拒绝把过期结果挂到新 Plan——两层是叠加关系，不是替代关系。


上一镜抽帧不信任浏览器提交的绝对路径或任意 URL。服务端根据当前 Plan 的 `shotPlan[]` 顺序导出 source shot，读取同一 Run 中 current `shotVideo` Artifact 的选中候选，只把当前 `public/generated-videos/<mediaNamespace>/` 单层目录内、文件名前缀同时绑定当前 Plan 和 source shotId 的普通 mp4 映射回本地文件。旧 namespace、远程 URL、路径穿越、子目录、符号链接和缺失文件必须明确拒绝。通过路径校验后仍须以 `O_NOFOLLOW` 文件句柄读取并冻结到任务私有目录，抽帧回执记录实际读取源字节及各 JPEG 的 SHA-256，避免路径校验与 FFmpeg 打开之间的文件替换使 lineage 与实际输入脱钩。

## 6. Run、Stage、Artifact 与 Checkpoint

默认状态根目录为 `runtime/production-runs/`，可通过服务端环境变量 `WORKFLOW_PRODUCTION_STATE_DIR` 修改。每个 Run 的 manifest 记录：

- Run 元数据和状态；
- Stage 的 `running` / `completed` / `failed` / `stale`，以及 `interrupted` / `conflicted` / `abandoned`；
- Artifact revision、digest、dependencies 和状态；
- 单调 Checkpoint sequence；
- 有界事件记录。

Artifact 内容独立写入原子替换的 JSON 文件。浏览器只在服务端提交成功后更新页面主状态。刷新页面时通过 localStorage 中的 project/run 指针读取最近 checkpoint，只恢复 `current` Artifact。

`tasks/index.json` 同样原子写入，路径中的 project/run/task ID 都经过 `safeIdentifier` 与根目录包含校验。公开 Task 包含冻结 provider/model 和持久 usage；恢复 UI 不得拿刷新后的下拉框设置冒充原任务模型。角色参考图的逐张结果进入脱敏 progress，断线后可以恢复计数与预览；Prompt 只记录 digest，不进入 Task sidecar。

同一 Node 进程内，Runner 独立于 HTTP response。刷新或 HTTP 断线后，第二个页面查询同一 Run 即可 attach；旧同步 HTTP 入口只等待同一 Task 终态，断线只结束等待者。角色图片旧 SSE wire 订阅 Task progress，SSE 断线只移除订阅者。

Node 启动 reconciliation 会检查 active Task：current Artifact 已由同一 requestId 成功提交时补记 completed；五个 pipeline 目标均已 current 时父任务补记 completed；其余 queued/running 变为 `interrupted` 并释放 claims，绝不自动重调 provider。浏览器可在同一 Run 从首个未完成阶段继续；需要媒体的阶段必须重新上传 `sourceVideoDigest` 相同的原始文件。

当前恢复边界：

- 不持久化原始上传视频、浏览器 Object URL 或抽帧源文件；
- 不持久化大型请求体，所以 Node 重启后不能恢复内存 Runner；
- 不保存或查询远端 provider task ID，不具备 provider restart resume/cancel；
- 不提供跨机器共享存储、多 Node worker、lease 或正式 batch queue；
- 失败/中断时已经落盘但未提交的角色图仍是孤儿文件，等待 T04 quarantine；
- 已完成的 Story、Plan 和已登记媒体可以恢复并继续下游操作。

## 7. v3 测试/规划包

导出流程由服务端确认选中 Variant、Full Story 和可选 Animation Plan 都是当前 Artifact，且 parent lineage 一致，然后添加：

- `packageType: story-production-test-package`
- `packageVersion: 3.0`
- `productionLineage`
- `packageDigest`
- `packageSignature`

服务端有三把本地签名密钥，**全部保存在状态根目录**（默认 `runtime/production-runs/`，随 `WORKFLOW_PRODUCTION_STATE_DIR` 移动），只代表当前安装实例的本地信任：

| 文件 | 用途 | 长度 | 环境变量覆盖 |
| --- | --- | --- | --- |
| `.package-signing-key` | v3 测试/规划包 `packageSignature` | 48 字节 | 无 |
| `.grounding-key` | `referenceAnalysis` / `sourceScriptReconstruction` 的 `groundingSeal` | 32 字节 | `WORKFLOW_GROUNDING_KEY` |
| `.character-boundary-key` | `fixedCharacterBoundary.boundarySignature` | 32 字节 | `WORKFLOW_CHARACTER_BOUNDARY_KEY` |

三把密钥共用同一套「读取或创建」（`src/persistent-key.js`）：环境变量优先于文件；文件缺失时以 `wx` + `0o600` 生成，目录以 `0o700` 创建；并发首启撞上 `EEXIST` 时回读对方写入的那份。**密钥必须跨进程重启保持不变**——落盘 Artifact 上的签名就是用它签的，换钥等于让已恢复的 Run 在下一次点击时全部作废。因此环境变量非法、密钥文件损坏或长度不足时一律硬失败：**禁止静默回退到随机生成**，也禁止覆盖长度不足的文件（它可能是正确密钥被截断的残骸）。密钥材料不进 config 对象、不进任何响应、不写日志，启动日志只报来源。

历史遗留：在密钥持久化之前签发的 Run，其 `groundingSeal` 与 `boundarySignature` 由已消失的随机密钥所签，无法恢复，必须重新运行工作流。已落盘 Artifact **不会**被重新签发——那等于用当前密钥给一批无法验证来源的内容背书。

导入沿用包签名密钥。导入必须依次验证 type、version、digest、HMAC、各 Artifact digest、Variant ID 和 parent lineage。验证成功后建立新的 project/run，重新签发本地 revisions；禁止与浏览器现态 merge，并清空包内媒体选择。

因此 v3 文件是可验证的本地测试/规划包，但不是包含供应商任务状态、跨环境证书链、批量调度和完整 canonical provenance 的最终 Production Package。
