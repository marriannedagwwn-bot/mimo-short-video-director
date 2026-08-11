# GitHub Benchmark 后续改造待办

> 建立日期：2026-08-12
>
> 基线提交：`6bb65dc feat: add recoverable production lineage`
>
> 适用主流程：Legacy Full Story → Animation Plan `direct_shot`（`promptSchemaVersion: "3.0"`）→ 视频生成

本文档只记录 GitHub 同类项目 Benchmark 后仍值得实施或验证的工作。已经完成的 Production Lineage 基础只作为前置事实列出，不得重复实现。

本文档不是“看到待办即可直接改代码”的授权。每个任务仍必须遵守 `AGENTS.md` 的证据优先、事实来源、合法反例、最小修改和测试要求。

## 1. 后续执行者必须遵守的自动勾选规则

以下规则对人工开发者和后续 AI 助手都生效：

1. 开始任务前，先确认当前 HEAD、真实调用链、失败样本和现有测试；不得仅依据本文档判断代码现状。
2. 一个父任务只有在其“验收标准”全部满足后，才允许把 `- [ ]` 改成 `- [x]`。
3. 每完成一个实施步骤，必须在同一次工作中自动把对应子项改成 `- [x]`，不等待用户再次提醒。
4. 只完成部分步骤时，父任务保持 `- [ ]`；在“完成记录”中写清剩余工作，不得为了显示进度提前勾选。
5. 被新证据否定的方案不得勾选。应保持未完成，并记录“阻塞原因 / 被否定假设 / 需要的架构决定”。
6. 完成任务后必须填写：完成日期、commit、实际修改文件、测试命令、失败样本回放结果、合法反例结果、与原计划的偏差。
7. 若改动影响 Schema、字段语义、Prompt、Validation、Retry、Recovery 或 Source of Truth，必须同步相关 `docs/`、`README.md` 和 `AGENTS.md` 后才能勾选父任务。
8. `npm test` 通过只是必要条件。涉及模型语义时，还必须回放真实失败数据并验证至少一个合法反例。
9. 不得把“Prompt 中写了要求”“README 声称支持”或“测试使用 mock 通过”当作功能已完成的证据。

完成记录模板：

```md
完成日期：
完成 commit：
修改文件：
测试命令与结果：
失败样本回放：
合法反例：
实际行为：
与原计划偏差：
遗留风险：
```

## 2. 优先级与依赖关系

```text
已完成 T00 Production Lineage
              │
              ├── T01 Full Story 角色与 Variant 契约闭环
              │        └── T02 Animation Plan 角色边界语义门
              │                  └── T07 连续性桥接 Prototype
              │
              ├── T03 Stage-owned Context Projection
              │
              └── T04 Generation Attempt / Asset Catalog
                       ├── T05 Provider 任务恢复与队列
                       └── T06 技术 QA / 视觉 QA / 候选选择

T08 跨环境 Production Package 仅在部署需求成立后启动
```

优先级：

| 优先级 | 任务 | 判断 |
|---|---|---|
| 已完成 | T00 | 不重复实现，只维护回归测试 |
| P1 | T01、T02 | 直接影响剧情、角色和镜头正确性 |
| P1 | T03 | 降低上下文重复与模型职责过载，需要 A/B 数据 |
| P2 | T04、T05 | 提高付费媒体生成的可追踪性与恢复能力 |
| P2 | T06 | 先做技术 QA，再 Prototype 视觉 QA 和候选排序 |
| P2 Prototype | T07 | 有潜在连续性收益，但不得破坏 direct_shot 边界 |
| P3 条件项 | T08 | 多机器、多人或正式交付出现后再做 |

## 3. 已完成基础

- [x] **T00：Production Lineage、持久 Run 和媒体隔离**

  已完成内容：

  - `variant digest → story revision → plan revision → media namespace`；
  - 上游变化递归标记下游 `stale`；
  - request token 与 `expectedCurrentRevision` 拒绝旧异步回写；
  - Run / Stage / Artifact / Checkpoint 持久化；
  - v3 本地测试包的 schema、version、digest、HMAC 和 parent lineage 校验；
  - 导入建立隔离 Run，禁止与现态静默 merge；
  - 媒体目录和文件名绑定 project / run / plan revision / digest。

  完成证据：

  - Commit：`6bb65dc`
  - 设计文档：`docs/production-lineage-state.md`
  - 核心实现：`src/production-lineage.js`、`src/production-state-store.js`、`public/production-lineage-client.js`
  - 实测：真实 01:14 视频完成 Full Story、12 镜 direct_shot Animation Plan，并在刷新后恢复。

  明确不包含：判断当前版 Animation Plan 的角色语义是否正确、远端 provider 任务接管、完整视觉 QA、跨机器可信 Production Package。

## 4. P1：剧情和角色事实闭环

### T01：补齐 Legacy Full Story 的角色、出镜和 Variant 契约

- [ ] **T01 父任务：Legacy Full Story 角色、出镜和 Variant 契约全部通过验收**

来源项目与启发：

- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：先冻结内容层，再让视觉层机械继承稳定字段。重点对照 [Step1 fingerprint 与确认状态](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/script_review.py#L320-L369) 和 [Step2 只生成视觉层、内容字段机械继承](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/script_generator.py#L253-L397)；
- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：模型给出语义边界后，程序用 source anchor 对照权威原文。重点对照 [clip 拆分、原文匹配和 source slicing](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/novel-promotion/story-to-script/orchestrator.ts#L355-L540)；
- 当前项目：严格 Schema 和 Scene Contract 已明显更强，但现有 characterization tests 仍固定了四个真实缺口。

当前已确认事实：

- `test/full-story-defect-characterization.test.js` 中：
  - `FS-01`：非出镜的标准角色仅被文字提及时，当前可能误判为实际出镜；
  - `FS-03`：未登记、但在画面中出现的临时角色当前可能通过；
  - `FS-04`：careRecipient 与上游 Variant 漂移，只要候选内部自洽仍可能通过；
  - `DS-05`：只校验相同 Variant ID，不能证明 Story 忠实于完整 Variant 内容。
- Production Lineage 已证明 Story 属于哪个 Variant revision，但不能证明模型生成的 Story 语义遵守该 Variant。
- `sceneScript[].characters` 的语义是“本场实际出镜角色”，不是被提及对象、地点所有者、照片人物或回忆对象。
- 当前主流程仍是 Legacy Full Story；不得把 Character Registry / Cast Proposal 描述成 Full Story v2 已接入。

权威事实源必须先确定：

| 事实 | 权威来源 |
|---|---|
| 固定角色语义 | 服务端签发的 `fixedCharacterBoundary` |
| 当前选题上下文 | 当前 `selectedVariant` Artifact 的完整 revision / digest / content |
| Full Story 内稳定角色职责 | `characterBible`，但必须先通过上游绑定校验 |
| 单场实际出镜角色 | `sceneScript[].characters` |
| 结构化说话人 | `sceneScript[].dialogue[].speaker`，且必须在当前场 `characters` 中 |
| 场次型临时角色 | 尚缺少已确认的登记契约；实现前必须作出架构决定 |

实施步骤：

- [ ] 用现有 `FS-01 / FS-03 / FS-04 / DS-05` fixtures 在当前 HEAD 上复现，并保存错误分类、字段路径和 provider call 数量。
- [ ] 为“场次型临时角色如何登记”作出明确架构决定；至少比较以下方案：扩展 Legacy Full Story Schema、服务端 sidecar registry、仅允许 `characterBible.helpers`。不得靠名称关键词猜测角色是否合法。
- [ ] 为 Variant 绑定定义最小可验证投影，例如主角、careRecipient、任务、情绪媒介、环境压力和结尾仪式；区分可以逐字比较的事实与只能语义审计的事实。
- [ ] 修复 `FS-01`：不得因为地点名、所属关系、照片、回忆或被提及姓名就确定角色出镜。若仅靠现有字符串无法唯一判断，应进入窄语义审计或阻断，不能用正则强行定真相。
- [ ] 修复 `FS-03`：可见临时角色必须有明确登记和影响范围；不得静默升级为主要角色，也不得改变 protagonist / careRecipient。
- [ ] 修复 `FS-04`：careRecipient 必须绑定权威上游角色；两个模型字段冲突时只报错，不自动选择任一方覆盖。
- [ ] 修复 `DS-05`：除 Variant ID 外，验证 Story 对当前 Variant 核心事实的忠实度；Lineage 只负责版本归属，语义验证负责内容一致性。
- [ ] 将 deterministic validation、可选 semantic audit、repair 和 full retry 的边界写入文档。只有正确值可由权威上游唯一推导时才允许 deterministic repair。
- [ ] 保持单次有界 retry；不得叠加内层、外层和队列多重 retry 预算。
- [ ] 增加通过样本：地点中包含角色名但角色不出镜、查看某人照片、提及未到场人物、合法的一次性路人、同一 Variant 仅 JSON 键顺序变化。
- [ ] 增加失败样本：未登记主要角色、careRecipient 替换、Variant 核心任务漂移、对白说话人未出镜、临时角色跨多场升级但未登记。
- [ ] 更新 `src/contracts/schemas/legacy-full-story-strict.schema.json`、`src/validation.js`、`src/prompts.js`、`src/workflow.js` 及相关文档；具体文件以调查后的最小范围为准。

验收标准：

- [ ] `FS-01 / FS-03 / FS-04 / DS-05` 从 characterization 变为明确的通过/失败契约测试。
- [ ] 所有错误都包含稳定 code、精确 path、reason 和可公开 diagnostics。
- [ ] 合法反例不会因为关键词命中被误杀。
- [ ] Animation Plan 入口继续在调用模型前校验 Full Story，不允许坏 Story 进入下游。
- [ ] 完整 Node 24 测试、真实失败包回放和至少一个合法反例全部通过。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

完成记录：待填写。

### T02：建立 Animation Plan 对固定角色边界的语义门

- [ ] **T02 父任务：Animation Plan 角色边界语义门全部通过验收**

来源项目与启发：

- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：稳定 ID、内容 fingerprint、人工确认和坏产物 quarantine。重点对照 [单一写入口、乐观并发和下游失效](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/script_review.py#L224-L299)；
- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：角色/地点资产 lock 和 reference image 注入。重点对照 [锁定后的资产 Registry](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/agent-pipeline/asset-layer/registry.ts#L44-L83) 和 [按 exact name / alias 匹配参考图](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/workers/handlers/image-task-handler-shared.ts#L141-L253)；
- 当前项目：签名 `fixedCharacterBoundary` 是本轮对比中更严谨的角色事实源，应在其上补验证，而不是引入第二份 Character Bible。

当前已确认事实：

- `ensureAnimationPlanMatchesProfile()` 已检查：`selectedVariantId`、固定角色名称是否出现、角色参考提示词是否包含 required traits、正向字段是否命中 forbidden terms。
- 当前缺口不是“完全没有校验”，而是缺少完整的角色绑定和职责校验，例如：
  - 同名角色在不同字段中身份、物种、年龄或职责发生漂移；
  - 新增未登记主要角色；
  - protagonist / careRecipient / helper 角色职责被交换；
  - `characterReferencePrompts` 正确，但逐镜 `videoPrompt` / `characterAction` 写成另一角色；
  - 当前 Scene 的出镜角色与 Shot 中实际角色不一致；
  - 模型用别名或描述性称呼绕过 exact name 检查。

权威事实源：

| 事实 | 权威来源 |
|---|---|
| 固定角色身份与禁止变化 | `fixedCharacterBoundary` |
| 故事角色职责 | 已通过 T01 的 `fullStory.characterBible` |
| 每场实际出镜角色 | 已通过 T01 的 `sceneScript[].characters` |
| Shot 所属剧情场次 | `shot.sourceSceneId` |
| Shot 边界 | 当前 direct_shot 的 location + visibleAction 主要动作目标规则 |
| 版本归属 | Production Lineage dependency revisions |

实施步骤：

- [ ] 从真实失败数据建立 Animation Plan 角色漂移 fixture catalog；不得先修改 Prompt 再寻找理由。
- [ ] 定义服务端生成的只读角色绑定投影，至少包含 canonical name / role / boundary digest / source scene presence。该投影不能由 Animation Plan 模型生成或修改。
- [ ] 对 Animation Foundation、每批 Shot 和最终合并 Plan 分层校验；错误必须定位到具体 `shotId` 和字段路径。
- [ ] deterministic checks 至少覆盖：未登记主要角色、标准名称/别名冲突、角色职责交换、当前场不存在的角色被写成实际出镜、required/forbidden 边界在角色参考层的冲突。
- [ ] 对自由文本中的身份等价、否定语境和隐式描述，仅在 deterministic 结果无法定案时运行窄 semantic auditor。Auditor 只输出 verdict、field path、evidence 和 reason，不得重写 Plan。
- [ ] 定义三种结果：`pass`、`retryable_model_violation`、`blocked_ambiguous_conflict`。不得把无法判断的冲突自动当成 pass。
- [ ] repair 只允许修复可由权威上游唯一推导的 ID、标准名称或引用；身份、物种、角色职责冲突必须 retry 或阻断。
- [ ] 保持现有 direct_shot 字段职责；不得重新加入 `startFrame`、`endFrame`、`motion` 或本地 Prompt Compiler。
- [ ] 增加合法反例：negative prompt 中出现 forbidden term、短镜头不重复全部外观描述、地点所有者未出镜、对白提及场外人物、合法临时路人。
- [ ] 增加失败样本：同名换物种、careRecipient 变 helper、主角被替换、新增主要角色、Reference 正确但 Shot 行为主体错误、跨 Scene 串角色。
- [ ] 记录 validator/auditor/retry 的调用次数、token、错误类别和最终结果，为后续 A/B 提供数据。

验收标准：

- [ ] 能稳定拦截“Animation Plan 本身违反当前 fixedCharacterBoundary”，而不仅是拦截旧 Plan 串到新 Story。
- [ ] 同一个错误不会在 Foundation、Shot batch、最终 Plan 三层重复触发多次付费 retry。
- [ ] Auditor 失败时不会删除 deterministic 错误，也不会自动放行。
- [ ] 角色边界仍只有一份服务端事实源，不新增本地物种关键词字典或第二套边界。
- [ ] 完整 Node 24 测试、真实失败包和合法反例通过。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

完成记录：待填写。

## 5. P1：Prompt 与 Context 所有权

### T03：为每个 Stage 建立最小 Context Projection 和信息所有权表

- [ ] **T03 父任务：Stage-owned Context Projection 全部通过验收**

来源项目与启发：

- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：Step1 内容字段冻结，Step2 只生成视觉层，再按稳定 ID 机械合并。重点对照 [Agent runtime 只注入不可变身份、可变状态随用随读](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/server/agent_runtime/options_assembler.py#L122-L169)；
- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：长原文使用 source anchor 和精确 slice，不让后续阶段反复消费整段文本。重点对照 [story-to-script 分层编排](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/novel-promotion/story-to-script/orchestrator.ts#L232-L540)；
- [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app/tree/bc61ec7a1b5df31293b286981a5f4ad4635464ee)：recent messages + summary + retrieval 展示了上下文压缩方向。重点对照 [memory 分层组合与检索](https://github.com/HBAI-Ltd/Toonflow-app/blob/bc61ec7a1b5df31293b286981a5f4ad4635464ee/src/utils/agent/memory.ts#L45-L198)，但其通用 Memory 不应直接照搬。

目标不是单纯缩短 Prompt，而是让每个 Stage 只看到其有权消费和修改的信息。

实施步骤：

- [ ] 生成当前 Prompt 输入审计表：每个 Stage 实际读取哪些字段、字段 owner、是否重复、token 占比、是否存在同一事实的多份副本。
- [ ] 明确 ownership：Brief 管保留价值；Full Story 管叙事和角色职责；Animation Foundation 管全局视觉/生产约束；Shot batch 只管已划定镜头的摄影、动作、声音和连续性表达。
- [ ] 设计服务端 deterministic context projection，而不是先引入 RAG。Projection 必须带 source artifact ID/revision/digest 和可追踪 evidence path。
- [ ] Animation Foundation 只接收全局角色、场景、风格、生产限制和必要剧情摘要。
- [ ] Shot batch 只接收当前 source scenes、冻结 Foundation、当前批次角色投影、前一镜 continuity context；不得重复传完整故事和所有无关角色。
- [ ] 保持 `sourceSceneId`、Scene 顺序、Shot 数量事实源和完整证据路径可校验。
- [ ] 对缺失 owner 字段 fail closed；不得用模型常识或旧 JSON 副本补默认值。
- [ ] 为旧 Prompt 与新 Projection 做 A/B：输入 token、响应 token、契约通过率、retry 次数、角色错误率、镜头覆盖率、主观质量。
- [ ] 只有数据证明无质量回退后才切主路径；否则保持 Prototype 或撤回。

验收标准：

- [ ] 输出一份可执行的 Stage × Field ownership matrix。
- [ ] 每个模型请求可追踪到使用了哪些 Artifact revision 和字段投影。
- [ ] 无关全文和重复 JSON 显著减少，且 Story/Shot 契约通过率不下降。
- [ ] 不引入跨项目通用 Memory、任意向量召回或可变 Agent chat 作为 canonical source。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

预计涉及：`src/prompts.js`、`src/workflow.js`、新增的纯 projection 模块及 Prompt snapshot/contract tests。最终以只读调查确定的最小范围为准。

完成记录：待填写。

## 6. P2：媒体任务、Catalog 和恢复

### T04：建立 Generation Attempt / Media Asset Catalog 与 quarantine

- [ ] **T04 父任务：Generation Attempt / Media Asset Catalog 全部通过验收**

来源项目与启发：

- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：付费坏输出 quarantine、source revision 原子提交、model pinning。重点对照 [source revision 的 raw-byte digest](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/source_revision.py#L192-L234) 和 [expected revision 下的原子资产提交](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/asset_inventory.py#L52-L128)；
- [OpenMontage](https://github.com/calesthio/OpenMontage/tree/4eab34c5cfcccaa4f1970554928feccce73ee930)：Asset Manifest 保存 prompt、seed、model、provider、cost、scene、license、URL 和 quality score。重点对照 [Asset Manifest Schema](https://github.com/calesthio/OpenMontage/blob/4eab34c5cfcccaa4f1970554928feccce73ee930/schemas/artifacts/asset_manifest.schema.json#L1-L62)；
- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo/tree/cb3f1a2a7847798fe0479a1a277ba411fa28bfc4)：素材来源与 attribution 小型 manifest。重点对照 [素材 provider、asset ID、作者和公开页面记录](https://github.com/harry0703/MoneyPrinterTurbo/blob/cb3f1a2a7847798fe0479a1a277ba411fa28bfc4/app/services/material.py#L69-L138)；
- 当前项目：已有 Artifact lineage 和 media namespace，可作为该 Catalog 的父级事实源。

实施步骤：

- [ ] 先盘点每个图片/视频 provider 的请求、同步/异步模式、task ID、seed、usage/cost、回调和可恢复能力。
- [ ] 定义 Generation Attempt 状态机：`prepared → submitted → running → succeeded → validated → selected`，失败分为 `failed`、`rejected`、`quarantined`、`stale`。
- [ ] Attempt 至少记录：project/run/plan lineage、shotId、generationMode、provider、精确 model ID、request digest、Prompt digest、reference asset IDs/digests、provider task ID、时间、输出位置/digest、错误、usage/cost。
- [ ] 模型和 mode 必须显式 pin；禁止按素材、字段缺失或 provider 自动切换模型/mode。
- [ ] provider 返回成功不等于生产可用。产物必须先进入 Catalog，经验证后才能成为 selected media。
- [ ] 旧 Plan、旧请求或不完整 provenance 的输出进入原 namespace 的 quarantine，不得挂载到当前 Plan。
- [ ] 区分 provider transport receipt 与可信生产 provenance；Receipt 不能被描述成内容正确性证明。
- [ ] 为 prompt/model/reference 相同的安全幂等场景定义 dedupe key；不得对可能重复计费的调用盲目重试。
- [ ] UI 展示候选状态、失败原因、来源 model、创建时间和当前选择，不默认把第一项当作最终真相。

验收标准：

- [ ] 任一媒体文件都能回答“由哪个 Plan、哪个请求、哪个模型、哪些参考素材生成”。
- [ ] stale/failed/rejected 产物不会进入 current selection，但仍保留可审计记录。
- [ ] 日志和导出不泄露 API key、原始敏感响应或签名密钥。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

预计涉及：`src/production-state-store.js`、`src/shot-video-generator.js`、图片 provider、`server.js`、`public/app.js`、Catalog Schema 和测试。

完成记录：待填写。

### T05：接管异步 Provider 任务并实现可恢复队列

- [ ] **T05 父任务：异步 Provider 任务恢复与队列全部通过验收**

依赖：T04。

来源项目与启发：

- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：task/run/attempt 持久化和任务队列。重点对照 [GraphRun / GraphStep / Attempt / Checkpoint / Artifact 数据模型](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/prisma/schema.prisma#L651-L791) 和 [节点 retry 分类及退避](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/run-runtime/graph-executor.ts#L123-L208)。不得照搬其多层 retry 叠乘或 [未完整水合业务状态的 resume 路径](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/agent-pipeline/index.ts#L140-L265)；
- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：阶段由持久数据重新派生。重点对照 [WorkflowStateService 的阶段判断](https://github.com/ArcReel/ArcReel/blob/52db2b33baef3ec4bd50600bfa87e1b3b0718812/lib/workflow_state.py#L742-L1025)。

实施步骤：

- [ ] 按 provider 确认哪些任务支持 query/resume/cancel，哪些只有同步响应；不支持恢复的 provider 必须明确标记。
- [ ] provider 调用前持久化 prepared/submitted Attempt；拿到 task ID 后原子提交，不得只存在浏览器内存。
- [ ] 实现 lease / heartbeat / idempotency，防止两个 worker 同时轮询或重复提交同一付费任务。
- [ ] 服务器重启后扫描 `submitted/running`，先查询 provider 真实状态，再决定恢复、失败或人工处理；不得自动重新生成。
- [ ] 处理“provider 已成功、本地提交前崩溃”和“本地标 running、provider 不存在”两个 orphan 场景。
- [ ] 单任务恢复稳定后再增加 batch queue；不得先上复杂队列掩盖单任务幂等问题。
- [ ] 定义每层唯一 retry budget：transport retry、semantic retry、人工重新生成不可互相叠乘。
- [ ] 故障注入测试覆盖：进程退出、网络超时、重复 callback、乱序 callback、Plan 更新、worker lease 过期。

验收标准：

- [ ] 重启后不会把仍在 provider 运行的任务误标失败或重复计费提交。
- [ ] 旧任务完成时仍受 Plan lineage 和 media namespace 隔离。
- [ ] UI 能展示恢复中、需人工处理和不可恢复，而不是统一显示“服务器内部错误”。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

完成记录：待填写。

## 7. P2：生成后 QA 和候选选择

### T06：先建立技术 QA，再 Prototype 视觉 QA 与候选排序

- [ ] **T06 父任务：技术 QA、视觉 QA 与候选选择全部通过验收**

来源项目与启发：

- [OpenMontage](https://github.com/calesthio/OpenMontage/tree/4eab34c5cfcccaa4f1970554928feccce73ee930)：真实使用 ffprobe、时长/分辨率/音轨检查和多时间点抽帧。重点对照 [技术探测与时间点抽帧](https://github.com/calesthio/OpenMontage/blob/4eab34c5cfcccaa4f1970554928feccce73ee930/tools/video/video_compose.py#L2208-L2336) 和 [最终状态判定](https://github.com/calesthio/OpenMontage/blob/4eab34c5cfcccaa4f1970554928feccce73ee930/tools/video/video_compose.py#L2548-L2570)；
- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：坏的付费输出 quarantine，并通过持久状态决定是否进入下一阶段；
- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875) 反例：README 声称 VLM QA，但 [生产 Producer 固定写入 `AUTO_PASSED / score=1.0`](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/agent-pipeline/graph/nodes/producer.ts#L14-L131)，不得复制这种假门禁。

实施步骤：

- [ ] 定义 shot-video 技术验收契约：容器可解码、视频流存在、时长容差、分辨率/方向、帧率、音轨预期、文件大小、非全黑/冻结。
- [ ] provider 成功后先运行确定性技术 QA；失败即 quarantine，不进入视觉评分。
- [ ] 在 10% / 35% / 65% / 90% 等稳定时间点抽帧，并保存抽帧位置和技术报告。
- [ ] 定义窄视觉 QA 维度：角色身份/外观、应出镜角色、地点、主要动作目标、明显道具、相邻镜头连续性。每个 verdict 必须有 shotId、frame/time、evidence 和置信度。
- [ ] 视觉 QA 不能修改 Story、Plan 或角色边界；只能 pass、reject、建议重新生成或进入人工确认。
- [ ] 候选排序先淘汰技术不合格项，再比较视觉分数、成本和人工选择；不得默认第一条即最佳。
- [ ] 建立 golden set 和人工双评基线，测量误杀率/漏检率后再决定是否自动阻断。
- [ ] QA provider 失败时不得把候选自动判为通过；可以保留为 `review_required`。
- [ ] 若未来存在最终合成，再单独增加成片级 ffprobe、音画、黑帧和 render report；不得把“镜头生成完成”表述为“最终 MP4 完成”。

验收标准：

- [ ] 技术 QA 可确定性复现，并有损坏、过短、错误分辨率、无视频流、黑帧等 fixtures。
- [ ] 视觉 QA 在 golden set 达到事先约定阈值后才允许进入自动门禁。
- [ ] 每次选择或拒绝候选都写入 T04 Catalog 和 append-only decision record。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

完成记录：待填写。

## 8. P2 Prototype：连续性与稳定视觉状态

### T07：Prototype 稳定 Derived Asset State 与相邻 Shot Continuity Bridge

- [ ] **T07 父任务：Prototype 证明有效并满足上线验收**

来源项目与启发：

- [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app/tree/bc61ec7a1b5df31293b286981a5f4ad4635464ee)：区分可复用的稳定派生状态与一次性动作/表情，重点对照 [Base / Derived Asset 的边界](https://github.com/HBAI-Ltd/Toonflow-app/blob/bc61ec7a1b5df31293b286981a5f4ad4635464ee/data/skills/production_execution_derive_assets.md#L71-L100)；并提出动作、情绪、空间/视线和声音 bridge，重点对照 [Storyboard Continuity Bridge](https://github.com/HBAI-Ltd/Toonflow-app/blob/bc61ec7a1b5df31293b286981a5f4ad4635464ee/data/skills/production_execution_storyboard_table.md#L42-L71)；
- [AgentCine](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：摄影设计与表演设计按 panel ID 合并。重点对照 [Storyboard 分层编排和 deterministic merge](https://github.com/pengchengneo/AgentCine/blob/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875/src/lib/novel-promotion/script-to-storyboard/orchestrator.ts#L264-L496)；
- 当前项目：`direct_shot` 已有 `continuityNotes` 和 previous-shot context，但没有强类型的相邻镜头连续性 sidecar。

该任务只能做 Prototype。它不得重新引入 v2 的 `startFrame`、`endFrame`、`motion` 或把新 sidecar 变成第二份 Story。

实施步骤：

- [ ] 用真实失败样本分类哪些变化是稳定状态：服装、持久道具状态、时间段、受伤/污渍、场景布置；哪些只是 shot-local 动作、姿势、表情和运镜。
- [ ] 设计独立 sidecar 草案，至少包含 `fromShotId`、`toShotId`、persistent facts、prop handoff、spatial/gaze relation、action handoff、audio bridge 和 source evidence。
- [ ] sidecar 只能引用已存在 Shot/Scene/Character/Asset ID，不得新增剧情、角色或镜头。
- [ ] 明确哪些字段由程序从 Full Story/Plan 唯一推导，哪些字段允许模型建议，哪些冲突必须人工确认。
- [ ] 对相邻 Shot 做确定性 ID、顺序、场景映射和持久状态冲突检查；自由文本语义只作为辅助。
- [ ] 在 feature flag 下对一组多镜头样本 A/B，比较角色/道具/空间/动作连续性、Prompt token 和 retry 次数。
- [ ] 若收益不显著或增加第二套真相，停止 Prototype 并记录“不引入”；不要为了完成待办强行上线。

验收标准：

- [ ] 不改变 direct_shot 拆镜规则、Shot 数量或 generationMode。
- [ ] 不复制完整 Story/Plan，不成为另一份可漂移 canonical state。
- [ ] 有量化或人工双评证据证明连续性收益后才允许进入主路径。
- [ ] 完成或明确否决后，自动更新本任务状态与完成/否决记录；只有实际上线并满足验收时才勾选 `[x]`。

完成记录：待填写。

## 9. P3 条件项：跨环境可信交付

### T08：在正式多用户/多机器需求成立后升级 Production Package

- [ ] **T08 父任务：跨环境 Production Package 全部通过验收**

当前 v3 文件是单实例 HMAC 校验的本地测试/规划包，不是跨环境可信 Production Package。只有出现以下明确需求时才启动：

- 多用户权限和租户隔离；
- 多台服务器共享 Run；
- 对象存储和长期归档；
- 跨环境验签、密钥轮换和撤销；
- provider provenance、费用审计和正式交付清单；
- 成片及依赖媒体的完整导出/导入。

来源项目与启发：

- [ArcReel](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812) 的 source revision、原子提交和项目持久状态可作为局部参考；
- [OpenMontage](https://github.com/calesthio/OpenMontage/tree/4eab34c5cfcccaa4f1970554928feccce73ee930) 的 [checkpoint/history 原子写入](https://github.com/calesthio/OpenMontage/blob/4eab34c5cfcccaa4f1970554928feccce73ee930/lib/checkpoint.py#L349-L633) 和 Asset Manifest 可作为交付清单参考；
- 没有任何入选仓库实现了当前项目所需的完整跨环境信任链，因此这些链接只能用于局部对照，不能被当作可直接照搬的生产方案。

实施步骤：

- [ ] 先取得部署、权限、合规、存储和恢复目标；没有这些决定不得设计“通用 Production Package”。
- [ ] 选择服务端数据库/对象存储和租户模型，定义 artifact immutable URI 与 digest。
- [ ] 将本地 HMAC 升级为可轮换 key ID、受控签名服务和验签策略；禁止把密钥随包导出。
- [ ] 包含 Schema 版本迁移、完整 lineage、Catalog、Attempt、decision log、媒体 digest 和 provenance。
- [ ] 设计部分缺失、过期签名、跨租户、重复导入、撤销 key 和离线验证测试。

验收标准：

- [ ] 产品需求和威胁模型已批准。
- [ ] 跨环境导入不会信任未知签名，不会与现有 Run 静默 merge。
- [ ] 文档准确区分测试包、规划包和正式 Production Package。
- [ ] 完成后自动勾选本任务全部子项和父项，并填写完成记录。

完成记录：待填写。

## 10. 明确不列入待办、不得顺手引入

以下方案在 Benchmark 中看起来先进，但当前不适合直接引入：

- 多 Agent 自由编排作为业务状态机；
- 用 Markdown 指令代替服务端 Schema 和 deterministic validation；
- 通用 RAG / 长期 Memory 成为角色或剧情事实源；
- 重新启用 Character Feature Compiler、Static Frame Compiler 或本地 Prompt Compiler 来补偿 direct_shot 上游表示；
- 重新加入 `startFrame`、`endFrame`、`motion` 等 v2 端点字段；
- 根据模型名、素材是否存在或字段缺失自动推断 generationMode；
- permissive `jsonrepair`、删除未知字段、补默认摄影值后静默通过；
- 新增本地物种/角色关键词白名单作为角色边界；
- 多层 retry 叠乘、无限 self-correction 或全量 JSON 反复重写；
- 固定 `score=1`、`AUTO_PASSED`、QA 失败时默认通过；
- 默认选择第一个图片/视频候选；
- 只有 projectId / variant.id / shotId 而没有 revision/digest 的新状态；
- 把 provider Receipt 当作内容正确性或完整 provenance 证明。

若未来要重新评估其中任何一项，必须先提供新的失败数据、目标指标、合法反例和退出条件。

## 11. Benchmark 来源定位

- [ArcReel @ `52db2b3`](https://github.com/ArcReel/ArcReel/tree/52db2b33baef3ec4bd50600bfa87e1b3b0718812)：内容 fingerprint、revision 原子提交、ID merge、human gate、quarantine、model pinning。
- [AgentCine @ `2bb30b6`](https://github.com/pengchengneo/AgentCine/tree/2bb30b6ade98d90324ca5a0c6f0ea860f6a22875)：source anchor、分层 storyboard、资产 lock、任务运行模型；其假 QA、宽松 repair 和多层 retry 作为反例。
- [OpenMontage @ `4eab34c`](https://github.com/calesthio/OpenMontage/tree/4eab34c5cfcccaa4f1970554928feccce73ee930)：checkpoint/history、asset manifest、人工门和 post-render technical QA。
- [Toonflow @ `bc61ec7`](https://github.com/HBAI-Ltd/Toonflow-app/tree/bc61ec7a1b5df31293b286981a5f4ad4635464ee)：derived asset state、四类 continuity bridge、context compression 和 provider-specific prompt；其弱 Schema/状态隔离不作为可靠性标杆。
- [MoneyPrinterTurbo @ `cb3f1a2`](https://github.com/harry0703/MoneyPrinterTurbo/tree/cb3f1a2a7847798fe0479a1a277ba411fa28bfc4)：小型原子 manifest、素材 attribution；其产品目标不涉及角色生成连续性，只作为相邻基线。
