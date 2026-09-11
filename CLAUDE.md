# CLAUDE.md

Claude Code 在本仓库的工作规则。

**`AGENTS.md` 是完整契约正文与唯一事实来源。** 本文件是它的操作性精修：保留会改变行为的硬约束，删去重复叙述。两者冲突时以 `AGENTS.md` 为准；任何一方变更必须同步另一方。涉及具体字段语义时，先回到 `AGENTS.md` 对应章节读原文，不要只凭本文件的摘要下判断。

---

## 项目速览

`mimo-short-video-director` — AI 短视频生产工作流系统。

当前主流程（唯一在跑的链路）：

```
Analyze → Reconstruct → Brief → Visual Guardrails → Story Candidates (`themeVariants`)
       → Legacy Full Story → Animation Plan direct_shot (promptSchemaVersion 3.0)
       → Video Generation
```

Production Lineage v1 作为服务端 sidecar 并行运行：每次浏览器主流程创建独立 project/run，各成功阶段提交 Artifact revision、content digest、上游 dependencies、Stage 状态与 Checkpoint。**它不改变模型字段含义，不是第二份剧情或角色事实来源。**

**Durable Task v1（2026-09-01）**：浏览器只创建、轮询和重新 attach；服务端 Runner 执行 provider 调用、校验与 Artifact commit。AI 导演是一个 `directorPipeline` 父任务和 Analyze、Reconstruct、Brief、Visual Guardrails、Variants 五个顺序子任务，父任务创建时原子 claim 五个目标。Task Store 是每个 Run 私有的 `tasks/index.json`，只保存执行状态、冻结 lineage、创建时 provider/model、progress、usage、结果 refs 与脱敏错误；Prompt、Data URL、Base64 和完整请求体禁止落盘，ProductionStateStore 的 current Artifact 仍是唯一业务事实。

**浏览器工作区生命周期（2026-09-09）**：新的浏览器 Run 必须绑定服务端 `metadata.browserWorkspaceId`。源视频副本存在私有 BrowserWorkspaceStore，Run metadata 只记 URL 与 SHA-256；**Task Store 仍不保存视频、Prompt 或完整请求体**，这条与 Durable Task v1 逐字同规格。同一标签页刷新或服务重启会恢复副本并重新抽帧，**不自动重调 provider**；换视频前必须先清旧 Run、媒体与源副本。

过期判定分三档，不要合并：连接断开有 60 秒宽限（5 秒 sweep）；后台页只要连接还在就**不因心跳节流判过期**；既无连接又无关闭通知时从最后一次心跳起 2 分钟兜底，停服期间的漏清在下次启动补。

存储位置是硬约束：workspace ID 与模型覆盖只进 `sessionStorage`；**长期只存创作宇宙七项设置**（角色、赛道、限制、表情、候选数量、画幅、时长）；旧的 `localStorage` Run 指针不再恢复。**表情与三个生成偏好不得并入 `creatorProfile`**——理由见 §2.5：`creatorProfile` 恰好三个字段且整体进 `sourceDigest`，并进去会让改一个下拉就作废全局角色边界。

清理必须核对页面归属，顺序是 scheduler → Run 锁撤销任务 → 删源副本、Run、其命名空间媒体与 Run 内 Debug；迟到的 Runner/worker **不得重建已清数据**。**四类东西永远不由它清**：无页面归属的历史 Run、用户原文件、主动导出文件、签名密钥。详见 `docs/production-lineage-state.md`。

状态固定为 `queued | running | completed | failed | conflicted | interrupted | abandoned`。冻结后绝不自动换成新 current；每次 provider 调用前后及锁内 commit 都复验 revision/digest。相同 active operation 复用 taskId，同目标不同 operation 返回 `TASK_TARGET_BUSY`；只有相同 requestId、digest 与 dependencies 的重复 finalize 可复用 revision。任务没有总墙钟 deadline：provider watchdog 使用自身 timeout 加 120 秒，本地阶段使用 300 秒无进展窗口并随进度续期，超时为 `failed/TASK_STALLED`。`abandoned` 与 `interrupted` 都不表示远端取消，供应商调用可能已经计费。

per-Run Coordinator 是不可重入 FIFO 锁。持锁路径只能调用 `commitArtifactUnlocked`、`recordStageUnlocked`、`loadRunUnlocked` 和 Task Store unlocked 方法；禁止从锁内调用对应公开方法，也禁止在临界区执行 provider、网络、FFmpeg 或模型校验。lineage snapshot、Task GET 与 atomic manifest load 均为锁外读。

刷新或 HTTP 断线不停止同一 Node 进程内 Runner。Node 重启后，同 requestId 已完成 commit 的任务可 reconciliation 为 completed，其余 active 任务标 `interrupted`、释放 claim 且绝不自动重调 provider。继续需要媒体的阶段必须重新上传 SHA-256 与 Run metadata 中 `sourceVideoDigest` 一致的源文件。T04 quarantine、T05 provider task-id 接管/重启恢复、lease、多 worker 与正式 batch queue 仍未实现。

Story Candidates 仍使用 `themeVariants.variants[]` wire shape，但必须通过递归 strict Schema，且只新增 `keyChoice/climax/emotionalPayoff/novelty/visualPotential` 五个候选级字段。本地校验不使用题材关键词或主观语义打分。选中候选以 current `variant:<id>` Artifact 的精确 revision/digest 绑定 Full Story，服务端在模型调用前后复验；`candidateBinding` 不进入 Prompt 或 Legacy Full Story wire shape。状态恢复只认 current Story/Plan 或明确 `variant:<id>` 记录，仅有 Theme Variants 时必须保持未选中，禁止默认 V1。当前没有 Story Selection/Blueprint/Script Doctor/Targeted Rewrite/Production Package 4.0；Phase 2 只预留「已签发 Candidate 内容 + 精确 lineage reference」接缝。

**可选叙事构件（2026-08-28）**：`characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 以及 Full Story 的 `characterBible.careRecipient` 全部从 required 降级为**可选键**。它们曾强制每个候选长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」，与 Prompt 要求的候选间根本差异直接矛盾。写了就仍必须合规（非空字符串；`careRecipient` 对象五个子字段齐全），不需要就整个键省略，**禁止输出空字符串或占位文本**。`characterSetup.protagonist`、`characterBible.protagonist` 与 `characterBible.helpers`（可为 `[]`）仍必填，固定角色锁定不受影响。

**角色与道具边界（2026-09-09）**：`characterSetup.careRecipient/helper` 与 Full Story `characterBible` **只登记角色**——人物、动物，或候选正文已明确设定的拟人角色；不要求它会说话或主动发起行动。**普通植物、物件被照料、保护或承载情感不构成角色身份**：候选照常写它的动作与用途，Full Story 把它放进 `keyProps`、`visibleAction` 与必要摄影说明，**不进角色表、不进 `characters`**。

起因是《迷路的蒲公英》：候选没写 `careRecipient`，Full Story 却把蒲公英同时当道具和被照料角色，连续触发角色出镜名单冲突。因此候选未登记 `careRecipient` 时，本次 `fullStoryPrompt` **不再展示那五字段模板**，并在开头写明角色表只输出 `protagonist/helpers`（`src/prompts.js` 的 `hasCareRecipient` 分支）；正文里其它跨场角色仍须登记进 `helpers`。

两个方向都禁止：不得为了填满角色字段**新增拟人行为**，也不得因为没有 `careRecipient` 就**删掉照料植物或物件的剧情**。旧候选的功能标签不能把普通物件升级成角色。**分类只靠提示词约束**——不新增物种词表、不自动删字段、不失败重写；既有 Scene Contract、Schema、签发语义与旧 Artifact 逐字不变。

**两条叙事路径（2026-09-02）**：候选新增必填枚举 `narrativeMode`，取值 `dramatic` | `slice_of_life`。契约此前把戏剧结构写成无条件硬要求（施动性至少 3 拍是发起者、末拍必须有可引用的承诺、必须设计被拖住的问句、质感 Beat 仍须改变状态），而**参考片基本不靠戏剧结构留人**：逐支拆解 debug 里留存的四支重构记录，《打枣》的转折是「戴锅防砸」这种解决眼前小麻烦，《帮奶奶捐旧衣服》的转折是别人给的小红花，《晨练》是别人来救，《好朋友为你遮风挡雨》的主角**从第 3 场起一直睡到片尾**——几乎没有一个转折来自主角的主动决定。第一条约束就把后者判成不合格。我们建了一台制造戏剧结构的机器，而用户参考的片子不靠戏剧结构；观众感到的「刻意」正是这套约束在起作用。一个反证支持该判断：用户两次独立选片都选了结尾「生活多了一点东西」的候选（村民挂起秋千、奶奶把画贴冰箱上），而不是任务完成型的。

那四条硬约束因此加上「**仅 dramatic 适用**」限定，并为 `slice_of_life` 写对应三条：①主角不必是发起者，可以在反应、参与甚至旁观，但每一拍仍要有可见身体动作；②高潮拍写一个**具体的小办法或小意外**，量级参照戴锅防砸，不需要艰难抉择；③最后一拍写**一起完成之后的日常时刻**，不需要承诺、不需要总结。`keyChoiceBeat`/`climaxBeat` 语义随路径调整（生活型指向「决定参与或想到那个小办法」与「小办法起作用」），但派生机制逐字不变。两条路径**同样遵守**拍号绑定与派生、结构分化、可见事实字段规则、对白质量、生活质感与萌点约束、固定角色边界——放开的只有「必须有戏」这一层。

分布要求有确定性校验（数枚举值是纯算术，不含语义判断）：`validateVariantNarrativeModeMix()` 与 `validateVariantStructuralDivergence` 并列在 `ensureThemeVariantsMatchProfile` 里，`count >= 4` 时至少 2 个 `slice_of_life`，`count < 4` 时至少 1 个，诊断码 `STORY_CANDIDATE_NARRATIVE_MODE_MIX`。**校验只能数自报标签的个数，无法核实一个候选真的是生活片段**——那需要语义判断，是本方案已知的最大弱点，只能靠真实回放与人工评分观察，**不得靠加词表补救**。`narrativeMode` **不进入 Full Story 提示词**：它是候选期的创作路径声明，展开阶段只承接选中候选实际写出的内容。候选卡在「相似风险」旁展示**剧情型 / 生活型**徽章供用户按口味挑选。

**关键拍号与服务端派生投影（2026-08-28，取代逐字投影校验）**：`keyChoice` / `climax` / `emotionalPayoff` **由服务端从 `storyOutline` 确定性派生**，模型只输出两个整数拍号 `keyChoiceBeat` / `climaxBeat`；`emotionalPayoff` 恒取最后一拍，不需要拍号。模型回显这三个字符串时**一律无条件覆盖**，与 direct_shot 的「回显不构成新事实」同规格。

此前要求模型自己在一份两万字符的 JSON 的两个远距离位置逐字重复同一个长句，实测不可靠：debug 侧车记录的真实调用中合规率两极分布（多次 0/12），加强措辞后仍出现 2/12 与 9/12 两次硬失败。失败模式是模型在**改写**而非复制——砍掉前置准备再把主语补回句首，让顶层成为能独立成句的摘要；而「顶层不得含准备」恰恰是 Prompt 自己的要求，两条规则互相冲突，调措辞救不了。派生把这类失败整类消除，同时让前置准备、时间标记可以自然留在拍内。

校验只裁决可唯一推导的部分：拍号必须是整数且在 `storyOutline` 范围内，且「关键选择拍 < 高潮拍」（**「高潮拍必须早于最后一拍」已移除**——它规定的是故事形状不是一致性，两者相同只让两个字段取到同一句话，是冗余不是矛盾）。「两拍之间隔一拍写后果」仍只留在 Prompt。签发时派生，入站复核只核对字符串与拍号一致（**不重新派生**——那会改变 content digest，破坏 `variant:<id>` 的 lineage 绑定）。诊断码：`STORY_CANDIDATE_BEAT_INDEX_INVALID` / `..._OUT_OF_RANGE` / `STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER` / `STORY_CANDIDATE_PROJECTION_NOT_DERIVED`。

这条约束 Prompt 一直就写着，但此前**没有校验器**。放开固定拍号（原 Beat 3/5/6）后实测合规率从 60/60 掉到 31/48，某些上游甚至 0/12——顶层写压缩摘要、`storyOutline` 写另一件事，同一个候选出现两版剧情，下游 Full Story 无从判断哪个是事实。它是阻止候选内部多版本事实的唯一机制，因此补成确定性硬失败。

系统的核心目标是：剧情一致性、角色一致性、镜头连续性、AI 输出可验证性、生产流程可恢复性。任何修改都以这五项为验收方向，而不是代码量或实现速度。

---

## 运行与命令

| 用途 | 命令 |
| --- | --- |
| 启动服务 | `npm start` |
| 开发模式（watch） | `npm run dev` |
| 全量测试 | `npm test` |
| CLI 生成 | `npm run run:video` |

- **必须使用 Node 24**（`.nvmrc` = `24`，`engines: ">=24 <25"`）。禁止直接用 25+ 运行。
- **`npm start` / `npm run dev` 带 `--use-env-proxy`，不要删。** Node 的内置 `fetch` **默认不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量**，而在需要代理才能出网的环境里，服务进程会直连各家 API 并超时——表现是所有阶段一起报「服务器内部错误」或 `TypeError: fetch failed`，而同一台机器上 `curl` 却完全正常（curl 自己读代理）。2026-09-04 实测：直连 `dashscope.aliyuncs.com` 超时 12 秒，加上该 flag 后立刻拿到正常响应。没有代理的环境上这个 flag 无害。
  排查口诀：**`curl` 通而服务不通，先查代理**，别去翻供应商余额或改代码。
- 服务运行期间修改了服务端相关文件，需要自动重启服务器。
- `npm test` 通过是**必要条件，不是充分条件**：它不能证明新引入的业务契约正确。

---

## 改动前必须先读的文件

| 改动类型 | 先读 |
| --- | --- |
| 任何字段语义 / 契约 | `AGENTS.md` 对应章节 |
| 旧 v2 首尾帧字段（startFrame / endFrame / environment / motion / environmentChange / inherit / transition） | `docs/animation-plan-source-of-truth.md`；文档未写明事实来源与冲突优先级时，**不得自行补充解释或实施确定性修复** |
| 工作流阶段契约 | `docs/workflow-spec.md` |
| Lineage / Run / Stage / Artifact 状态 | `docs/production-lineage-state.md` |
| Benchmark 后续改造 | `docs/GitHub-Benchmark-后续改造待办.md`（见下方"待办勾选"） |
| Debug 落盘语义 | `debug/README.md` |
| **终审 / 修订 / 镜头过载相关的任何改动** | `docs/待解决项.md`——里面登记了已确认存在但尚未决定怎么改的问题，**尤其是每条下面「已经排除的做法」**。那些是实测走死过的路，重走一遍会重复付出真实调用的代价 |

---

## 一、Claude Code 补充规则

1. **复杂修改必须先进入 Plan 模式**，产出计划并获得确认后再动生产代码。
2. **未经明确批准不得执行架构重构。** 顺手重构、顺手优化、"统一架构"一律禁止。
3. **修改数据契约时，必须同步检查五个面：生产者、消费者、校验器、Prompt、测试。** 少查任何一个都视为未完成。

判断"是否算复杂修改"的门槛：只要触及字段语义，或改变 Prompt / Schema / Validation / Compiler / Retry / Recovery / Fallback / Source of Truth 的业务行为，就按复杂修改处理。

---

## 二、当前架构事实（不可假设、不可绕过）

### 2.1 Animation Plan `direct_shot`

- 必须由请求**显式**传入 `animationPlanMode: "direct_shot"`，且 `productionStrategy.format` 为 `direct_shot_video`，输出 `promptSchemaVersion: "3.0"`。
- 每个 shot 保留：`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`，以及镜头标识、时长、剧情目的、负面词、验收标准。
- **禁止五个端点字段**：`startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt`。`negativePrompts.image` 必须为 `[]`。

### 2.2 三个镜头标识不得混淆

| 字段 | 典型值 | 含义 |
| --- | --- | --- |
| `sourceSceneId` | `S1` | 当前 Full Story 的**剧情场次**归属。不是场地。 |
| `sceneId` | `LOC01` | Foundation **场景视觉参考组**。不保证精确物理地点或无缝连续。 |
| `shotId` | `A01` | 当前 Plan revision 内的**业务镜头顺序**。脱离 project/run/plan revision/digest 不能单独标识媒体。 |

### 2.3 镜头映射规则（3.1 一对一映射）

**`fullStory.sceneScript[]` 的每一项就是最终可翻拍业务镜头。Animation Plan 不再拆镜，只填内容。**

- 镜头骨架由 `deriveDirectShotSkeleton()`（`src/direct-shot-timeline.js`）从 Full Story **确定性派生**，是唯一权威。派生发生在**任何模型调用之前**。
- 服务端独占并确定性签发 6 个字段：`shotId`（全局 `A01`、`A02`……）、`sourceSceneId`（= `sceneScript[i].sceneId`）、`sceneId`（Foundation `sourceSceneIds → LOC` 映射，规则不变）、`durationSeconds`、`storyPurpose`（= `dramaticFunction`）、`emotionalTarget`（= `emotionNode`）。模型回显错了按骨架**确定性覆盖**——这些值全部可从 Full Story 唯一推导，回显不构成新事实。
- 模型只生成 8 个字段：`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts`、`acceptanceCriteria`。
- **唯一的拆镜条件**：单场跨度 > 15 秒时按 `ceil(跨度 / 15)` 均分，余数逐秒给靠前的镜头（20 秒 → 10+10；17 秒 → 9+8；34 秒 → 12+11+11）。除此之外**禁止拆分、合并、新增、遗漏、重排或改写时长**。因此 `shotPlan.length === Σ ceil(span_i / 15)`；`span_i ≤ 15` 时该场严格 1:1。
- 一条业务镜头内部允许多个动作阶段、景别变化、特写、硬切和结尾宽景，全部写进同一条 `videoPrompt`/`cameraMotion`，**不得增加 `shotPlan[]`**。动作目标变化**不再**是拆镜理由。
- 长场次被均分时，该场 `visibleAction` 的动作链必须按时间先后完整分配到相邻镜头：不省略、不重复，段间靠 `continuityNotes` 承接。
- `shotAndSound` 与 `shootingNotes` **不是**镜头数量的事实源。
- **时间线校验（全部明确失败，禁止退回默认值、猜测或钳制）**：`timeRange` 不可解析、跨度非正、跨场次起点早于上一场终点、任一段低于供应商 4 秒下限 → `OutputContractError` 带 `DIRECT_SHOT_SCENE_TIME_RANGE_INVALID` / `..._OUT_OF_ORDER` / `..._DURATION_BELOW_PROVIDER_MINIMUM`。场次之间允许留白，只禁重叠与回退。
- `parseSceneTimeRangeSeconds` / `parseSceneTimeRangeBounds`（`src/validation.js`）共用**唯一一份**正则，秒位接受 `0–99`：`00:60` 在 mm:ss 下只可能是 60 秒，与 `01:00` 完全等价，按 `m*60+s` 折算是确定性算术而非推断。
- 校验点：批次由 `assertDirectShotBatchMatchesSkeleton()` 复核数量与逐位 `sourceSceneId`；`mergeAnimationPlan` 对整份 `shotPlan` 再做一次逐位复核（含 `shotId`、`durationSeconds`）并断言 `Σ durationSeconds === productionStrategy.targetRuntimeSeconds`。direct_shot 对已解析候选**一律 fail closed，不整批重试**。
- `productionStrategy.targetRuntimeSeconds` 由服务端注入为骨架各镜时长之和（= 各场 `timeRange` 跨度之和），模型输出的值一律被覆盖。`productionStrategy.recommendedShotDurationSeconds` 在 direct_shot 已**删除**——时长是派生事实，不存在"建议"；旧 v2 兼容路径保留该字段。
- 时长：**没有项目级 4–6 秒限制**。合法值就是 timeRange 派生结果，落在 Seedance 2.0 与 MiniMax H3 的能力交集 4–15 秒整数内（`ensureAnimationDirectShotContract` 校验）。已有值不合法必须拒绝，不得钳制、补长或缩短。
- 内部摄影变化允许但不强制。**不得为了堆机位压缩、跳过或改写 `visibleAction`。**
- 以上只作用于 direct_shot 主流程，**旧 v2 兼容路径的镜头数与时长语义不变**。

### 2.4 `productionStrategy.videoPromptProfile`

服务端根据用户首次生成 Plan 时明确选择的镜头视频模型签发的 **Plan 级提示词方言/来源记录**，严格包含 `schemaVersion` / `profileId` / `provider` / `model` / `guideVersion`。

- 它**不是**运行时 provider/model 锁。**模型不得输出、推断或修改它。** `profileId` 恒为 `seedance_2_0`；`provider`/`model` 只如实记录用户首次生成时选的运行时视频模型，**不参与 mismatch 判定**。
- **已下线方言的兼容**：旧 Plan 带 `profileId: "minimax_h3"` 时，`getVideoPromptProfileMismatch` 返回 `unsupported_current_profile`——Plan 仍可加载查看，但生成视频前必须重新生成 Plan。该降级只认这一对精确的 `profileId + guideVersion` 白名单；**损坏或被篡改的 Profile 仍然硬失败**，`assertVideoPromptProfile` 本身始终严格。
- **只有一种方言**：`videoPrompt` 是一条自包含、可直接交给视频模型的中文自然语言完整提示词，**同一条提示词同时提交给 Seedance 2.0 与 MiniMax H3**，运行时视频模型不再决定提示词写法，按「Foundation 风格与物理光线 → 地点环境 → 出镜主体与已锁定外观 → `visibleAction` 顺序动作链与可见结果 → 内部摄影/剪辑顺序 → 节奏、对白和声音 → 稳定约束与停止条件」组织。
- **第 ⑤ 项必须逐拍写明该拍画面里出现的角色**，写到的角色必须完整入画（含面部），不得只给手部、局部肢体或无头躯干；多角色同场时至少有一拍让他们同时完整同框。依据是 2026-08-30 双人对话镜头（A02）的三臂实测：原写法只说「内部摄影/剪辑顺序」、没有主体槽位，配角被埋进长句后频繁退化成无头躯干加一只写实比例的大手，双人同框仅 4/9；补上逐拍主体后升到 9/9，追平 H3 原生六段方言。**这也是不恢复原生方言的依据**——原生方言的优势来自 `subject_definitions` 与逐拍 `[Shot N]` 强制声明主体，而那个槽位在中文模板里同样能加。该实验保留了原提示词里那段截断的外观散文仍然有效，说明散文轰炸不是病因。**这是 Prompt 生成约束，没有确定性校验兜底**——判断一条提示词有没有写全主体需要语义判断。
- **第 ⑥ 项的台词必须把原话逐字写进 `videoPrompt`，这一条有确定性校验兜底。** 视频模型直接生成人声，只写「某人在说话」「传出说话声」而不写说了什么，那句台词就不会被说出来。`shotDialogueMissingFromVideoPrompt()`（`src/validation.js`）在 `ensureAnimationDirectShotContract` 里硬失败，诊断码 `DIRECT_SHOT_DIALOGUE_MISSING_FROM_VIDEO_PROMPT`。
  判据是**最长连续逐字命中 ≥ 6 字**，不是覆盖率——长文本里任意两个中文串都会偶然共享少量字符，覆盖率量的是巧合。阈值来自实测：187 条实词对白的分布是双峰的，run≤4 占 57%（偶然重合），run≥9 占 35%（确实引用了原话），中间 5–8 只有 8.6%，6 落在谷底。**不切句**：501 条真实对白里 494 条没有 `「」`，说话人分隔混用换行、句号和裸文本，切句只能靠猜。话语正文短于 10 字整条豁免——那多是拟声词与非语言发声（嗷呜、喵），按描述写合法，也短到无法区分引用与巧合。
  依据是一份已签发 Plan 的 A05 整句丢了奶奶的台词而当时无人拦得住；按同一判据回扫历史语料，实词对白有 61% 不合规——那衡量的是旧提示词从没要求写原话，不是新阈值太严。
  **它有一次有界补写兜底，不是直接 fail closed。** `direct_shot` 对已解析候选不整批重试（`workflow.js` 的 `if (directShotMode && firstOutcome.hadParsedCandidate) throw`），所以模型从来不知道自己错了、也没有矫正机会——实测同一句台词连续两次被漏写，每次烧掉约 6.8 万 token。因此新增第四个局部纠错协议 `animation_shot_dialogue_repair/1.0`（`src/animation-shot-dialogue-repair.js`），在 `evaluateAnimationShotBatchCandidate` 的校验失败分支上**只触发一次**。
  协议约束与既有三个同规格：服务端私有签发计划身份（`WeakSet`，序列化副本不可合并）、`baseDigest` 冻结候选、模型只返回等量同序 `{repairId, replacement}`、不得返回 path/op/完整对象。**目标不从错误消息里解析路径**——改为用与校验器同一个函数重新扫描候选，保证要修的与会被拒的是同一批。**模型只返回要插入的那一两句（`insertion`），不返回改写后的完整 `videoPrompt`**——原文由服务端按构造拼回，模型根本碰不到。第一版让模型返回整条 `replacement`，实测它把 400 多字原文整体重写（措辞全换），于是「原文必须逐字保留」把每一次补写都拦死；要求模型逐字复述长文本本仓库已有 0/12 的先例，Beat–Scene postpass 只收 `addition` 才是正确形状。插入内容受三重约束：必须含缺失台词原话、长度不超过「台词长度 + 120 字」、不得复述原提示词开头。合并在克隆上原子进行，并证明目标之外逐字节不变。合并后**从头重跑完整批次校验**，不是只复查被改的那条。任何环节失败都退回原始错误 fail closed，**禁止第二次补写**。
- Plan 阶段两种 Profile 都不得生成尚未绑定的 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>`。

**`productionStrategy.backgroundMusicMode`** — 主题变体卡上的背景音乐开关，取值只有 `"none"` / `"allowed"`，**默认 `none`**。与 `videoPromptProfile` 同级：由服务端根据请求 `backgroundMusicEnabled` 签发，**模型不得输出、推断或修改**，回显即拒绝。

- `none` 时 `videoPrompt` 必须以 `全片无背景音乐，只保留现场环境声与动作声。` **逐字收尾**。方言只有一种，两个视频供应商共用这条约束。
- 关闭的**只是背景音乐**，不是现场声：`overall_soundscape` 与 `soundDesign` 照常写环境声、物理动作声与对白。`soundDesign` 不做关键词禁用——那需要语义判断，会误伤「他哼起了歌」这类剧情内声音。
- 校验点：批次与 Profile 改写路径都走 `validateSeedanceBackgroundMusicSentence`（收尾句），改写路径在语义审计**之前**执行——改写只动措辞，**不授权顺手改变有无配乐**。`allowed` 时不施加该校验。
- 已有 Plan 时拨动开关**必须重新生成整个 Animation Plan**（与切换画幅不同，画幅不调用模型）：签发新 Plan revision 与 media namespace，递归 stale 该变体已生成的全部媒体。页面必须先明确征求同意，拒绝时开关回弹到 Plan 当前值，不改 Plan、不 stale 媒体。
- Demo mock 与真实契约保持一致：`mockAnimationPlan` 按同一 `backgroundMusicMode` 产出合规提示词，不得出现 mock 通过而 live 失败的偏差。

### 2.5 切换镜头视频模型 / 切换画幅

**切换模型**：方言只有一种，所以**切换运行时视频模型（Seedance 2.0 ↔ MiniMax H3，或 Seedance 各型号之间）不再产生 mismatch，也不再询问是否重写**——同一条提示词两边都能直接跑。

改写流程本身保留，只在 Plan 的**方言**与当前契约不一致时触发，即两种旧 Plan：完全缺 Profile，或带已下线的 `minimax_h3` Profile。**禁止从 Prompt 文本、provider 或模型名反推方言。**

- 拒绝：不改 Plan、不签发 revision、不 stale 媒体、不回滚新模型设置。
- 确认：**只能**重写全部 `shotPlan[].videoPrompt` 并更新 Profile，其他字段逐字保留；改写结果须通过完整契约校验 + 证据绑定语义审计后才签发新 Plan revision/media namespace 并 stale 旧媒体。任何失败都保留旧 Plan current。

**切换画幅**：`targetAspectRatio` 只允许 `9:16` 或 `16:9`，首次生成锁入 `productionStrategy.targetAspectRatio` 并与 Foundation 一致。已有 Plan 切换画幅时**不调用模型、不重写 shot**，但必须签发新 Plan revision/media namespace 并 stale 旧画幅媒体。不得向 direct-shot 的 exact shot 增加 `aspectRatio`。页面计划总长由 `shotPlan[].durationSeconds` 合计派生，`targetRuntimeSeconds` 仍是上游目标，两者不得互相覆盖。

- **画幅只在生成前选择。** 浏览器把画幅控件放在「设定创作宇宙」面板（`#animationAspectRatio`），它只是**新 Plan 的默认值**（全局默认 `16:9`）：写进 `state.animationAspectRatioDefault`，取值优先级为「该变体草稿 → 该变体已签发 Plan → 全局默认」。拨动它**不触碰任何已签发 Plan**——不签发 revision、不 stale 媒体。已生成的 Plan 卡片里画幅是**纯展示**（`data-cell`），不再提供就地切换的下拉框。
- 因此当前浏览器**不暴露**「已有 Plan 就地切换画幅」这条路径；要换画幅只能重新生成 Plan。上面那条契约描述的仍是该操作一旦发生时必须满足的语义，`withAnimationPlanAspectRatio()`（`public/animation-plan-settings.js`）与其单元测试保留，随时可重新接回 UI。

**角色表情规则（2026-08-31）**：「设定创作宇宙」面板的 `#characterExpressionRules`，用户手写的「情绪 = 可见特征」映射。与 `targetDurationSeconds` 同规格：**只进提示词，不写入任何 Artifact、不参与派生、不进 digest、不 stale 任何东西**；改它不触碰已签发 Plan，也不弹窗征求同意，下次生成 Plan 时才生效。判定与上限在 `public/character-expression-rules.js`（1000 字符），浏览器与服务端共用一份；请求侧只拦类型错误与超长，不裁决内容。

**禁止把它并进 `creatorProfile`。** `creatorProfile` 恰好三个字段且整体进 `character-boundary.js` 的 `sourceDigest`，`handleProfileInput` 在它变动时作废全局角色边界并要求重跑整条工作流。表情是**表演表现**，不该承受那个代价；发色那类**身份事实**则相反，就该写进 `fixedCharacter` 并承受重跑。浏览器侧同理：它存在独立的 `directorCharacterExpressionRules` key，不进 `directorProfile`。

**注入面刻意只有两个**：`animationDirectFoundationPrompt`（模型在那里写 `consistencyTags`）与 `animationDirectShotBatchPrompt`（写 `videoPrompt` / `characterAction`）。**旧 v2 兼容路径逐字不注入。** 明确排除三处：Full Story 写的是 `emotionNode` 情绪节点、不是表情渲染；`/api/refine-character-reference` 会改 `appearancePrompt`，而 `buildCharacterVisualAnchor` 只取它第一句、上限 180 字，塞表情散文会顶掉外观事实；角色参考图的 `REFERENCE_SHEET_POSE` 写死「表情中性平和」，那是身份锚点，有意为之。

它**只管表情与表演，不得改变角色身份、外观或物种**，`fixedCharacterBoundary` 始终优先。这条**有确定性兜底**：模型若把它写成外观事实并命中禁止特征，`ensureCharacterReferenceMatchesBoundary` 仍在成片渲染前硬失败（实测夹带「翅膀」→ `混入全局边界禁止特征：翅膀`）。但「模型有没有照着写表情」没有兜底——那需要语义判断。

依据：用户想锁固定搭档的表情，实测三条现有路径都不通——上传表情图后 refine 能读懂，却把结果写进 `referenceImageNotes`，而该字段全项目没有任何代码读进提示词；写进 `constraints` 会进 10 个阶段且改一字就作废边界；让 refine 写进 `consistencyTags` 则会被下一次重新生成 Plan 抹掉。

### 2.6 视频生成模式

| 模式 | 语义 | 可用供应商 |
| --- | --- | --- |
| `first_last_frame` | 首尾帧是精确端点 | Kling / Seedance / MiniMax H3 |
| `all_reference` | 图片/视频/音频仅作多模态参考，须至少含合法图片或视频（不能只有音频） | Seedance 2.0 与 MiniMax H3（两者消费同一条 Seedance 方言提示词） |

- 模式**只**由请求 `generationMode` 决定。**不得**根据端点字段缺失、provider、模型名或素材存在性自动推断或降级。
- 无端点的 `direct_shot` 不可用 `first_last_frame`，必须明确失败。
- `all_reference` 不得混用 `first_frame` / `last_frame`，不得把可灵 image-to-video 静默当作 Omni API。
- **H3 Context-IR 已随提示词方言一并下线，且没有公开 API。** 官方仓库明确说明 H3-Context-IR 未开源；此前 worker 里那条 `POST /v2/h3_context_ir` 打的是不存在的端点，是当初「接口一直出错」的根因之一，方言删除后也再无生产者。相关能力、端点派生与请求体已全部删除，**不要重新接它**。
- **MiniMax H3 的 `resolution` 与 `ratio` 未配置时才走缺省（`2K` / `adaptive`）；显式配置了非法值必须明确失败**，不得静默回退。合法取值只有官方的 `768P` / `2K` 与六种画幅加 `adaptive`。`.env` 里曾长期写着非法的 `MINIMAX_VIDEO_RESOLUTION=1080K` 并被悄悄改写成 2K，计费与产出都与配置不符——这正是「失败时返回默认值」的典型代价。
- **供应商轮询失败必须把它自己给出的原因带回来**，包括可查码表的结构化错误对象。worker 是独立进程，错误只能以 stderr 文本回到服务端，所以 `describeProviderTaskFailure()` 在人类可读摘要之后再附一段 `{"error":{...}}`——`splitTransportPrefix` 从第一个 `{` 起解析，没有它则 `describeProviderError` 一律返回 `null`，用户只看到原文、拿不到下一步动作。典型场景是内容审核 `1027`（输出涉敏），它是**非确定性**的：同一条提示词重试常能通过。**当前没有、也不得擅自加入对内容审核的自动重试**——那等于在第三方安全闸门上套「问到放行为止」的循环，且代码无法区分误判与真违规；是否重试由用户显式决定。
- **成片实际时长与 Plan 要求时长并列上报，偏差既不静默也不硬失败。** `assertUsableVideoOutput()` 返回实测时长，每条候选记录 `plannedDurationSeconds` 与 `measuredDurationSeconds`（`0` 表示该链路未测得，不表示时长为零）。实测 H3 请求 5 秒稳定产出 5.167 秒（9/9 完全一致）、请求 4 秒得 4.458 秒——这是供应商的确定性行为，**硬失败会让该供应商 100% 不可用，重生成也拿不到不同结果**。是否以及如何对齐成片总长（容差、失败还是告警、以谁为准）仍是未决的契约问题，不得在此擅自选边。
- `continuityReferenceMode: "none" | "previous_shot_frames"` 是独立的运行时开关，**不改变也不推断 `generationMode`**，也不是 `direct_shot` Schema 字段。启用时：上一镜只由当前 Plan `shotPlan[]` 紧邻前项确定；服务端读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，用 FFmpeg 按 `t = 时长×i/4` 均匀截取 **5 张** JPEG（首帧、末帧和中间三等分点；末帧回退 0.1 秒以保证可解码）作为普通 `reference_image`，与其他图片共同受 9 图上限约束，超限明确失败。**批量路径在创建任务时就按 happy path 投影抽帧张数逐镜预检这条上限**（首镜投影为 0），超限一次列全并拒绝开工，不产生任何供应商调用；上限数字只有一份，在 `public/all-reference-limits.js`，禁止在校验器、浏览器预检或批量路径各自再写一遍字面量。张数固定，不随镜头时长变化——3.1 把单镜放宽到 4–15 秒后，每秒一帧会让超过 9 秒的镜头直接撞上限，也会把锁角色长相的角色参考图挤出这 9 个位置。5 张同时落在 MiniMax 的免费额度内。它只增强一致性，**不能覆盖**当前 Full Story/Plan、`fixedCharacterBoundary` 或 Foundation 场景事实。
- `POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不得依据客户端自报 `animationPromptSchemaVersion` 降级为无 lineage 请求。服务端从 Plan 唯一解析 exact shot；只允许 `promptOverride` 覆盖本次媒体提示词，动作/时长/场景/声音/负面词/验收条件仍来自 Plan。输出文件名必须含不可碰撞的请求 nonce，返回前须过 ffprobe 视频流/时长校验。
- **运行时参考素材清单**：`all_reference` 模式下服务端在 `shot.videoPrompt` **之前**确定性拼一段清单，说明每张素材是什么（`buildReferenceManifestText()`，`src/shot-video-continuity.js`）。参考图以 `reference_image` 发送时不带任何文字身份，模型无从分辨哪张是角色、哪张是上一镜抽帧。**前置而非后置**，以保证 `backgroundMusicMode: none` 的禁配乐句仍是整条提示词的最后一句。
  - **抽帧不承接角色外观与服装，冲突时让位给角色参考图。** 原措辞让抽帧「承接角色外观、服装、道具与场景状态」，而角色参考图那句同时写着「锁定该角色的长相与服装」——两句都声称管服装，清单自己把冲突制度化了。实测代价：A01 把校服画成米色无袖（本身就违背角色参考图），抽帧把这个错误当成事实传给 A02，模型拿到互相矛盾的视觉证据，在 8 秒内两次换装。**上一镜是待核实的产出，角色参考图才是签发权威**，冲突时没有理由让前者赢。现在抽帧只承接「场景、道具、光线与位置关系」，并在**本次确实带了角色参考图时**才追加「角色的长相与服装一律以角色参考图为准」——没带就不追加，否则等于指向一个不存在的素材。
  - **抽帧成组时必须点名末帧。** 五张按 `t = 时长×i/4` 均匀采样，只有最后一张是「上一镜结束时的状态」，另外四张是过程。清单原来把它们当成一个整体介绍，模型没有理由认为第五张比第一张更重要——实测 A02 的奔跑段直接复用了参考图3（A01 的**起点**构图），角色在空间上倒退了整整一镜：A01 结束时她已贴到房子边，A02 却把她送回大树下重跑一遍。现在清单确定性点名「其中参考图N 是上一镜的最后一帧，本镜必须从它的状态与位置继续，其余几张只说明这一镜经过了什么，不代表本镜的起始位置」；末帧编号由 `buildReferenceManifestText` 从分组区间末位直接得出，不需要推断。同时抽帧那句**不再声称承接「位置关系」**——位置只由末帧那一张给出，说成整批承接正是让模型可以挑任意一张的原因。
  - 这只消除**清单自相矛盾**这一个成因。抽帧同时携带外观与构图，而我们只想要场景侧信息，通道上无法分离；「不要复制它的构图与动作」是一行文本，对面是 5 张同构图的图像，实测结尾仍会复制上一镜构图（芙芙猫回到怀里、奶奶退回背景挂被子）。要不要减少抽帧数量是**未决的取舍**，不得在此擅自选边。
  - 清单**只能**使用受控来源枚举、Plan 权威的 `sourceCharacterName`（由 `resolveAuthoritativeShotVideoReferenceAssets` 按已签发 `characterReferencePrompts[].referenceImageDataUrl` 唯一匹配后覆写）、lineage 解析出的 `sourceShotId` 与帧数。**禁止写入 `upload` 素材的 `name`/`logicalName`**——那是原始用户文件名，是这条链路唯一的注入面，上传素材一律只写「用户上传的参考素材」。安全性来自构造，不是事后校验。
  - 它不是 Plan 字段、不改 Schema、不签发 revision、不 stale 媒体、不调模型；`sourceVideoPrompt` 保留 Plan 原值，`effectiveVideoPrompt` 与新增回执字段 `referenceManifest` 记录本次实际发送内容。`first_last_frame` 路径逐字不变。
  - 不要在这里补 `ensureCharacterPromptMatchesBoundary`：视频提示词天然多角色，走 `promptScope: "multi_character"`，而该分支在 `src/validation.js` 里**无条件短路返回空串**，加上去只是一个看起来像闸门的空操作。`server.js` 现有那道检查同理，它对视频提示词也不生效。
- **角色参考声音只发给本镜的明确说话人（2026-09-03）。** 用户可以给每个角色上传参考语音（`characterReferencePrompts[].referenceAudioClips`），但**发不发送由该角色是不是本镜说话人决定，不是由它出不出镜决定**。判据是 `shot.dialogueOrSubtitle` 里出现 exact 角色名后紧跟冒号（允许一个表演括注），判定只有一份 `shotRelatedCharacterAudioClips()`（`public/character-reference-audio.js`），批量、单镜与服务端权威解析共用；服务端 `resolveAuthoritativeShotVideoReferenceAssets` 对非说话人的音频硬拒，诊断码 `SHOT_VIDEO_CHARACTER_AUDIO_REFERENCE_NOT_SPEAKER`（409）。角色参考**图**不受此约束，仍按出镜发送。
  依据是 2026-09-03 的 A01 实测：芙芙猫在该镜没有任何对白，只是出镜，系统仍附带了它 4.73 秒的样音，成片里整段背景持续喵叫，与原样音在相同时间位置高度相关——**供应商把样音直接混进了成片，不是提取音色再合成**。判定刻意偏向漏判：判不出说话人就不发。回扫历史 574 条有对白的镜头，53% 根本没写说话人标注，这些镜头一律不发音频——漏发只是少一个音色参考，误发会让整段样音铺满全片。
  **供应商侧没有 per-character 绑定，这条闸门治标不治因。** MiniMax 官方文档写明 `audio_url` 只是「参考音频（仅多模态参考场景）」，**没有任何把音色定向到画面中某个主体的机制**；我们唯一的绑定是参考素材清单里那句中文，模型可以无视。所以在该角色确实说话的镜头里，原音被直接播放仍可能重演。清单文案因此显式排除观察到的两种误用（当背景音铺满、在不发声的时间重复），但那是 Prompt 约束，**没有确定性校验兜底**。要「加工后的叫声」必须在本链路之外做独立的声音生成或替换步骤，**不得把 raw 样音当成音色合成器**。
  格式：MiniMax 只接受 **WAV 与 MP3**，单段 2–15 秒、每镜 ≤3 段、合计 ≤15 秒。MP3 的 IANA MIME 是 `audio/mpeg`，而 MiniMax 从 MIME 子类型反推扩展名会读成 `.mpeg` 并以 2013 拒绝，因此**只在 MiniMax 传输边界**把标签改写成 `audio/mp3`（`MINIMAX_AUDIO_MIME_ALIASES`，必须声明在 worker 顶层 `await main()` 之前，否则子进程路径会落进暂时性死区）；Artifact 里仍保留 IANA 正确的 `audio/mpeg`，字节一个不改。`.m4a` MiniMax 不收，会在提交前明确失败。
- **生成期间的过期复验是硬约束**：服务端把复验回调交给 `generateShotVideo`，生成器必须在①任何供应商调用与文件写入之前、②每条候选提交供应商之前、③每条候选落盘并通过 ffprobe 之后、④组装返回值之前各执行一次，**覆盖全部供应商**，禁止按 provider、模型或提示词方言设门（历史上只有已下线的 H3 路径复验，那是缺陷不是设计）。任一次失败即 fail closed：删除本次已写入的全部候选 mp4，`ProductionStateError`（409）原样上抛，禁止包装、禁止保留产物、禁止降级为成功。清理只删本次调用自己算出的含 nonce 路径，禁止扫描目录；旧 v2 首尾帧 PNG 文件名不含 nonce，不在覆盖内。只有过期触发清理——供应商错误与 ffprobe 失败维持既有语义。浏览器的事后关卡与它是叠加关系，不能用来解释复验缺失。

**`storyEngine` 五个子字段的定义与 `turningMechanism` 两槽位（2026-09-10）**：`briefPrompt` 此前对
`storyEngine` 与它的 `desire` / `obstacle` / `escalation` / `turningMechanism` / `payoff` **一条说明都没有**——
六个词各出现恰好 1 次，就是输出模板里那个空槽位。它是整份简报里**唯一**一个子字段全无定义的子对象
（`nonNegotiableExperience.samePlotDriver` / `sameBeatValue`、`reusableHighValueBeats[].beat` /
`dramaticValue` / `mustRetain` 都有定义），而且零校验器、改动前**零消费者**
（`src/validation.js` 只在 required 键名里出现，浏览器只展示 desire/obstacle/payoff 三格）。

实测后果：三个真实导出包里 `turningMechanism` 一份是真机制、一份可用、一份写成剧情概括
（「主角主动采取防护措施继续参与活动，展现机灵与懂事」）。**那不是模型写错**——「转折机制」
最自然的读法就是剧情转折点，没人告诉过它这个字段要写的是关系/理解的改变。质量随包而异
不是模型不稳定，是**一个未定义字段上的猜测**。

现在五个键各写定义，`turningMechanism` 改成 **`{before, after}` 两个槽位**：
`before` 写前半段观众以为这是一段什么关系，`after` 写看完之后重新理解成什么。
提示词**明写它不是剧情转折点**、不是「主角做了什么」——那是最自然的误读，不点破它，
写再多正面定义都会被它盖过。两端必须是**对同一组人物关系的两种理解**，不能写成
「任务没完成 → 任务完成了」或「情绪低落 → 情绪变好」；转变不必是反转，小幅度的重新理解也算数。

`validateStoryEngine`（`src/validation.js`）挂在 `ensureOutputContract` 的 `creativeBrief` 分支，
与 `validateNarrativeComponents` / `validateProtectedExpressions` 并列。判定**全是类型、非空与字符串
比较，零语义**：四个文本键非空；`turningMechanism` 必须是**恰好含 before/after 两个键**的对象
（多一个键就会把定义稀释掉）；两端非空；归一化后 `before !== after`，复用现成的
`normalizeStoryReviewEcho`（去空白与中英文标点），**不另写第二份**。

**闸门只抓退化，不保证判对。** 它能抓住「两边写同一句话」这种同义重复，**无法**判断写出来的转变
是不是真的发生在关系上——那需要语义判断，没有确定性兜底。

**只在生成路径生效。** `ensureOutputContract(_, "creativeBrief")` 全项目只在 `createBrief` 里调用两次；
下游 variants / visualGuardrails / fullStory 都是裸 `requireObject`。所以 `turningMechanism` 仍是字符串的
旧简报**不会被拒绝**，照常加载——与 §2.4 已下线方言「所有调用点都是生成路径」同型；
简报卡的「理解转变」格因此写了两个分支，旧简报不会显示成空白。

**真实回放（2026-09-10，从源视频重跑 analyze → reconstruct → brief）**：导出包**不能**直接回放
`/api/brief`——`groundedStageInput` 对 `sourceScriptReconstruction` 无条件验签且没有出口
（`WORKFLOW_SIGNATURE_POLICY` 只覆盖角色边界签名），外来包的 seal 一律 400。因此改从源视频重跑整条链
（`打枣.mp4` 的 SHA-256 与包内 `sourceVideo.digest` 逐字节一致，确认是同一个文件）。
三个包的结果**有好有坏**：

- **反面样本修好了**：那份剧情概括变成「观众以为这是一段长辈照顾晚辈、晚辈被动接受关爱的关系」→
  「观众重新理解为晚辈也在用自己的方式主动参与劳动、回应长辈的爱」，方向与一份外部评审对同一部
  参考片的独立读解一致。
- **旧值可用的那个没变差**，两端比旧值更明确。
- **旧值最好的那个反而退了一步**：旧值精确点名了两人各自的角色（「从打扰者与被干扰者转变为模特与
  创作者」），新值写成「单方面照顾 → 双向陪伴」，更笼统，而且补了一句「两人共同完成了一幅作品」——
  按还原稿那个角色是**被画的对象**，画由另一人独自完成。**闸门抓不到这个**：`before !== after` 照常通过。

**这批数据能支持的结论很窄**：三个包里只有一个原本是反面样本，所以它证明的是「已知的那个反面样本
被修好了」，**不是**「定义写清楚就一定能拿到好机制」；而第三个包说明**它也可能把已经写对的换成更差的**。

两条没有确定性兜底的观察：①两端都以「观众以为…／观众重新理解为…」开头，**3/3 全中**——模型在照抄
提示词的措辞框架，内容随包不同、是真实读解，但这个开头已经成了公式；②新值可能引入与原片不符的
断言（上面那句「共同完成」），闸门只查两端不相同，判不出哪一端说错了原片。

**`recastTest`：换个角色来演，什么会塌掉（2026-09-11）**。`creativeBrief` 顶层新增必填字段，
与 `storyEngine` **平级**（**不放进 `storyEngine`**——那会污染它的事件结构模型）。

起因是用户的一个判断：**我们提炼的是「参考视频叙事的过程」，不是观众实际看到的东西。**
「一个小辈帮助长辈」是事件；观众看到的是「一个可爱的孩子发挥自己的天性、用自己的方式帮身边的人」。

量化证据支持这个判断：候选提示词 **26,873 字里有 108 条否定式约束、55 次「必须」、
0 次邀请模型用自己的判断、1 次提到「好看」**。而两轮真实回放写出的 `turningMechanism`：
3.7-max 写「双向情感反哺的深厚羁绊」、3.8-max-0902 写「家庭间互相照料的亲情循环」——
质感不同，**两个都停在事件层与关系层**。`storyEngine` 的五个键（欲望／阻碍／升级／转折／回报）
**本身就是一个完整的事件结构模型**，问 `desire` 必然答「她想要什么」；在那个框架里加定义、
加力度只会拿到更精确的事件描述，**换模型也不解决**。

**它刻意是一个操作，不是一句定义。** 形状 `{recastAs, collapses, survives}`：先把主角换成一个
性格完全不同的角色（`recastAs` 必须写出具体性格），再逐场问「这一场换了这个角色还成立吗」，
不成立的进 `collapses`（= **只有这个角色才给得了的东西**），照样成立的进 `survives`（= 谁来做都一样）。

写成操作而不是定义是有依据的：`turningMechanism` 加定义之后实测 **3/3 全部照抄提示词的措辞框架**。
这仓库里成功的改动全是**结构性**的（拆槽位、清单收敛到 4 条、拍号派生），失败的全是**措辞性**的
（三次加码「不许净增动作」三次被绕过）。所以举例**一律用反例**（品质词、谁都能做、含糊其辞），
**不给正例**——§2.12b 的「企鹅快递员」事故正是举例被逐字照抄造成的，而反例不会被抄成内容。

**两侧同时必填是全部要点。** 只要 `collapses` 的话模型可以把所有东西都塞进去；要求同时列出
`survives`，它就**必须做区分**——与 `transformationProof` 拆成 `{source, replacement}` 同一个招式：
分开放，程序才知道哪边是哪边。

`validateRecastTest`（`src/validation.js`）挂在 `ensureOutputContract` 的 `creativeBrief` 分支，
与 `validateStoryEngine` 并列。五条闸门**全是类型、非空与集合比较，零语义**：恰好三个键
（`..._INVALID`）；`recastAs` 非空（`..._FIELD_EMPTY`）；两侧各至少 1 条非空（`..._SIDE_EMPTY`）；
**两侧归一化后不得有交集**（`..._OVERLAP`，核心闸门——换了角色它要么成立要么不成立，
同一条两边都写说明根本没做区分）；同侧不得重复（`..._DUPLICATE`）。归一化复用
`normalizeStoryReviewEcho`，**不另写第二份**。

**闸门抓不到**：`collapses` 里写的是品质词（「她很活泼」）而不是具体动作。那需要语义判断，
**没有确定性兜底**，只能靠提示词的三条反例加人工看。

**只在生成路径生效**，与 `storyEngine` 同型：`ensureOutputContract(_, "creativeBrief")` 只在
`createBrief` 里调用，下游全是裸 `requireObject`，所以旧简报照常加载；简报卡整块不显示，不留空白。

**候选阶段只拿到 `collapses`，拿不到 `survives`**（`variantsCreativeBriefProjection`）。
送 `collapses` 是要候选迁移**同一性质**的东西——换个性格的角色就想不到的具体动作，
**不是复现原片那些动作**（照搬就是换皮）；`survives` 留在简报侧，它的作用是逼简报做区分，
送到候选阶段只会变成又一份可以照抄的事件清单。

### 2.12b 候选阶段的原片事实溯源与对照评审（2026-09-06）

起因是实测：一轮**四个候选全部**把原片写成「企鹅快递员 / 快递送达」，而上游 `referenceAnalysis` 与 `sourceScriptReconstruction` 里「快递」出现 **0 次**（「穿着企鹅连体衣」是真的，快递员是补的）。同一份简报的 `allowedNarrativeComponents[0]` 还写对了「原片没有明确的送达任务」——**存在性判定写对了，别的字段照样编**，V1 还照着虚构把整条结构建成「主动承担送达任务」。

污染链三段：①`briefPrompt` 的 `mappingLogic` 举例正文写死了「不继承原片企鹅服、**快递员身份**和视觉外壳」，当天输出只换了两个词，是在抄举例；②防这件事的规则**已存在**且反面例子一模一样，却写在 `fullStoryPrompt` 里，而 `transformationProof` 是候选阶段先产出的；③两个字段全项目零校验器。

**① 简报举例去污染**：`mappingLogic` 举例不再含任何参考片具体名词，仍需保留的「企鹅快递员」加上 §2.10 同款标注「来自另一部参考片，只示范判据，不要照抄内容」。**没有确定性兜底**，兜底在 ②。

**原片来源独立选取与服务端派生（2026-09-09，取代下面 ② 里「模型自由写 `source`」那半条）**：两份原片上游齐全时，`createVariants`（`src/workflow.js:664`）先用 `createVariantSourceBaseline` 建一份**本次调用私有的冻结证据目录**，用创建时的 variants provider/model 独立选出人物、事件、对白、画面四维的 evidenceId，再用同一模型创作候选。**一个 variants Task 因此是两次顺序调用、一次提交**，四份依赖在开头一起冻结，现有用量与 watchdog 覆盖两次调用，**不自动重试**。

隔离是这套机制的全部要点：选源输入**不含** `creatorProfile`、Brief、Guardrails、候选、`replacement` 或旧 `source`——**不得从新角色或新剧情反推原片有什么**。目录只投影原片事实白名单，不带签章与媒体。ID 必须已知、非空、不重复，**没有固定 4 条上限**；对白引用附带同场 `visibleActions` 与 `shotDesign` 原文，**不同场次的同一句话不能按文本去重**（同样的词在不同场次说话人可能不同），只按 evidenceId 去重。

道具**不由模型选**：直接取全部冻结 `scenes[].keyProps` 精确文本去重；合法空数组签发「原片没有可引用的场次道具清单记录」，**只声明清单为空，禁止扩大成「原片没有物件」**；缺键、类型非法与空白条目仍然硬失败。

候选模型只输出五个 `replacement`，服务端 `apply()` 从选择结果**复制完整原文覆盖五对字段的 `source`**，然后才跑 schema、派生与 profile 校验。它不补齐缺失维度、不修改 `replacement`、不掩盖多余字段。**全批候选共用同一份原片基线。**私有目录与选源结果**不进 Task Store、不进 Artifact**，只在本次调用内存在；选源单独记 `variantSourceBaseline` 模型输出日志。Demo 从真实 mock 上游确定性选取，不调模型；缺两份上游的旧调用点与已签发候选走旧来源兼容校验。

**它解决不了的事要说清楚**：选源不能修复原片上游转写含混、外观缺失或事实冲突，也**不能把「引用合法」宣称成「原片逐动作 / 逐字音频已验证」**。Full Story 的新片事实只承接候选正文与 `replacement`，`source` 不构成新增人物、事件、道具、对白或字幕卡的要求。

**`variantsPrompt` 的上游投影（2026-09-09）**：候选提示词现在按允许清单投影原片人物名称/特征、观察事实、场次动作/对白/道具，供机制对照与 `source` 引用，不带签章、摄影说明或媒体。**此前这些上游已经进了 workflow 与 validator，却从没进过实际候选提示词**——校验器在核对模型根本没看过的东西。

同时收紧三处投影：Brief 正向投影去掉可能携带「获奖 → 转赠」链的 `emotionStructure.function`；`dramaticValue` 单列为来源价值解释，**不是每个新片的必备事件**，情绪曲线也不作逐拍模板；角色规则投影把 `stageInstructions` 输出为**空对象**，隔离上游模型写在阶段建议里的帮助/奖励/转赠模板。其余阶段仍消费原值，签发的角色事实与旧 Artifact 不变。**不对值做关键词分类。**

**② 候选 `transformationProof` 改 `{source, replacement}` 结构对 + 确定性溯源校验**（**`source` 的写法已被上面 2026-09-09 那条取代：它现在由服务端从冻结目录签发，模型只写 `replacement`，缺席 sentinel 在主路径上已不可达；两个槽位分开的理由与校验器本身仍然成立**）。分开两个槽位是全部要点——混在一个字符串里时程序无法知道哪一半在描述原片。`source` 只有两种合法取值：能在上游找到依据的原片事实（复用简报那套 `citationCoverage`，LCS 覆盖率 0.75，**允许转述**），或精确等于 sentinel `原片没有`（`VARIANT_SOURCE_ABSENT_SENTINEL`，**完全相等**判定）。

留这个出口是闸门能成立的前提：schema 要求非空，没有出口就是在逼模型编造。**判定是前缀，不是完全相等**——第一版要求精确四个字，当天实测 **20/20 全部失败**：四个候选五个字段无一例外把它当成句子开头补完（「原片没有明确任务」「原片没有人类角色对白」）。`原片没有` 天然读作一句话的开头，要求它戛然而止是让措辞对抗书写本能。放宽的代价是带内容的否定句免检，但**否定句不制造改写基线**——它没有声称原片有过任何可供承接的东西，最坏只是这一格信息量为零；正向声称仍逐条核对，拦截能力不变。

同一次实测还暴露第二个问题：模型把 `source` 的**提问方向写反了**——`changedDialogue.source` 写成「原片没有人类角色对白」，而那部参考片有一句「再见啦~」，还有女孩、咕嘎、简历、棒棒糖、绿色挎包。它在回答「原片有没有我要加的东西」，而这个字段问的是「原片这一维度**有什么**」。第一版提示词把缺席出口写成最显眼的一条，直接导致 20/20 全走这条路。现已改为：正向引用是默认路径并给出**填好的样例**，缺席出口降级为一行并注明「确实没有，而不是和本片不一样」。**这一条没有确定性兜底**——方向写反但格式合法的 source 无法用字符串判定识别。

**核对基准只有 `referenceAnalysis` 与 `sourceScriptReconstruction`，绝不含 `creativeBrief`**——当天正是简报先错，拿它当基准等于给虚构盖章。`validateVariantSourceFactCitations` 由 `ensureThemeVariantsMatchProfile` 第 5 参数 `upstream` 驱动，`if (upstream)` 才执行，旧调用点逐字不变；诊断码 `STORY_CANDIDATE_SOURCE_FACT_UNVERIFIED`。浏览器请求体与 Durable `buildInput` 白名单本来就带这两份上游，无需管线改动。实测判别力：`企鹅连体衣`/`绿色挎包`/`咕嘎递出棒棒糖` 通过，`快递送达` 0.25、`企鹅快递员` 0.60 拦下，阈值不动。

**Full Story 的 `transformationProof` 本轮不动**，那条提示词规则**逐字保留、没有合并**：两边判据严格程度本就不同（那边写「逐字找到依据」，这边校验器允许转述），揉成一句要么悄悄放松那一侧、要么让这一侧提示词比校验器更严。

**③ `highValueBeatMapping` 补 `failureSignal`**：每条保留机制必须写证伪条件（这条机制没迁移成功时会长成什么样）。「温暖/治愈/关系改变/重获希望」单独出现不构成判据。**只有 schema 形状校验，没有语义兜底。**

**④ 候选对照评审 `storyCandidateReview`**（`POST /api/story-candidate-review`）：与 §2.13、§2.14 同规格，**只出报告**——不改候选、不签发 Artifact、不进 lineage、不 stale、**不改变候选数量**、不阻断后续；刷新即失。

送审投影**按允许清单构造**（`buildStoryCandidateReviewProjection`，安全性来自构造）：只送 id/title/hook/logline/`narrativeMode`/`characterSetup`/`storyOutline` 动作链/`keyDialogueDirections`/`failureSignal`；**刻意剥掉** `novelty`、`visualPotential`、`experienceFidelity`、`transformationProof`、`originalityRiskCheck`、`retainedValue` 与每拍 `dramaticFunction`。`failureSignal` 反而要送——**把「陷阱」给评审看、把「答案」藏起来**是有意的不对称。浏览器把评审结论与候选自述并排显示。

覆盖率由 `ensureStoryCandidateReviewCoversCandidates` 确定性核验：数量相等且 `candidateId` 逐位相同、`title` 回显必须包含原文（复用 `storyReviewEchoCoversSource`）、`beatIndexes` 必须在该候选拍数范围内、`recommendedOrder` 是候选 id 的排列；通过后用原文覆盖 `title`。**「判得对不对」没有兜底。不打总分**（§2.13 已实测总分没有分辨力）。`verdict: drop` **只是一句话**，不删候选、不触发 stale，`STORY_CANDIDATE_NARRATIVE_MODE_MIX` 不受影响。评审默认沿用 `variants` 的 provider，**自己批自己偏松是已知偏差**，如实记录不静默换家。

**⑤ 因果自洽检查 `coherenceChecks`（2026-09-09，来自第一次真实回放）**：`candidateCheck` 新增必填数组（空数组合法），每条写 `kind` / `beatIndexes` / `problem`。
`kind` 五个取值都来自实际观察到的失败形状：`contradiction`（同一候选两处描述互相否定）、`tool_misuse`（角色手上已有能解决问题的东西却用更差的替代物）、
`purpose_nullified`（任务目的被链条里另一件事当场抵消）、`space_or_time`（前面说够不到或来不及，后面用更弱的办法却成了）、`other`。
**提示词里的举例一律是抽象形状，不含任何参考片或候选的具体名词**——§2.12b 的「企鹅快递员」事故正是举例被逐字照抄造成的。

闸门只有一条，**纯算术加枚举比较**：`coherenceChecks` 非空就不能判 `pass`，诊断码 `STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK`。
它不裁决那条自洽问题成不成立。拍号合法性判定与 `mechanismChecks` **共用一份** `checkBeats`。

起因是 2026-09-09 用一份真实导出包做的首次回放（该阶段此前**从未真实调用过**，`docs/待解决项.md` 第 7 条）。
评审把一个候选判成 `pass` 并排在第 2，而它的动作链有三处矛盾：对白说「顺路」而同一拍写「反方向」；
角色怀里已抱着能解决问题的道具，却另找更差的替代物去保护它；任务目的在最后一拍被另一条线抵消。
评审的 `coreInteraction` 还把其中一条**原样抄下来**当成功案例。根因不是模型不行，是 **`verdict` 声称的比评审实际检查的多**：
`pass` 的定义是「可以直接展开」，而评审只审「机制有没有迁移过来」。这与 §2.13 查的不是同一件事——那边是「声明 vs 呈现」，这边是「呈现 vs 呈现」。

**三条必须如实记着的局限：**

1. **命中率 38%，但绝不是完备闸门。** 四个包 16 个候选里有 6 个被报出自洽问题。抓到的内容具体且锚到拍号——
   例如「第 2 拍写够不到、第 3 拍搬木箱、第 4 拍站上去还是够不到」，以及「长辈手里已经有旧星图并能指出位置，
   那件道具要解决的问题在第 1 拍就不成立了」。但**已知有 3 处矛盾的那个候选只被抓到 1 处**，另两处始终没抓到。
   **不得据此宣称「自洽问题会被拦住」。**
2. **`pass` 闸门在 live 至今没被触发过**：报出自洽问题的候选，模型本来就判了 `revise` 或 `drop`。闸门只有单元测试证明有效。
3. **判定质量在包与包之间很不齐，目前不能当挑选依据。** 与一份外部评审对同一批候选的评分比对：一个包完全吻合
   （`pass` 的两个正是外部评分最高的两个，`revise` 的两个正是最低的两个），一个包部分吻合，一个包**方向相反**
   （我们唯一判 `revise` 的那个是外部评分并列最高的），还有一个包全部判 `drop`。`recommendedOrder` 同样不稳：
   同一份输入两次回放的排序不同。**不得把 `verdict` 或 `recommendedOrder` 当成自动选择依据。**
4. **不得为了提高命中率去加词表或反复改提示词**（§5 第 2 条与「看到错误日志就直接改提示词」）。
   最初只跑了一个包就得出「召回率很低」的结论，而那个包恰好被判全 `drop`、模型不再继续找——
   **单包结论在这个阶段是不可靠的**，任何比例都要跨包统计。

**同一次回放还暴露了旧契约的一个更根本的问题（当时没有确定性修复，现由下面 ⑥ 结构性解决）**：回放 1（旧契约）给四个候选提炼出 **8 条各不相同**的「原片机制」，
每条都是照着**那个候选本身**写的，于是 6/8 判 `depicted`——**从候选反推原片机制，再判定它已兑现，是循环论证**。
改动后两次回放收敛到**同一条**具体机制并 8/8 判 `not_depicted`，与一份外部评审对同一批候选的结论一致。
但**无法证明是这次改动修好了循环论证**，只能记录：改后 2/2 一致且与外部结论吻合。这条没有确定性兜底，判断「机制提炼得对不对」需要语义判断。

**⑥ 原片机制清单改为全批共享、候选按 id 引用（2026-09-09）**：`storyCandidateReview` 新增**顶层**
`sourceMechanisms: [{id, mechanism, whereInSource}]`（schema 限定 **2–4 条**），`mechanismCheck` 的
`sourceMechanism` / `whereInSource` 换成 `sourceMechanismId`。闸门两条，**都是纯集合成员比较、零语义**：
id 必须唯一（`CANDIDATE_REVIEW_DUPLICATE_MECHANISM`），每个引用必须在清单里
（`CANDIDATE_REVIEW_UNKNOWN_MECHANISM`）。拍号合法性与 `coherenceChecks` 共用同一份 `checkBeats`。

它修的是上一条末尾记的那个循环论证，而且**是结构性修复不是措辞修复**：四个包的实测里，
只有一个包把原片机制收敛成 3 条，另外三个各提炼出 **8–9 条**、每条都照着那个候选本身写，
于是 6/8 判 `depicted`。清单上限 4 条之后，「4 个候选写出 8 条互不相同的原片机制」在**构造上**不再可能。
提示词同步改口径：先只读原片写出清单（「在看任何候选之前先做这一步」），再逐个候选核对它命中哪一条；
自检方法写成「把全部候选删掉，你写的这几条应该一字不变」。旧口径「先从原片动作稿里挑出
**这个候选试图迁移的**机制」正是诱因，已删除并由测试锁定不得回来。

招式与 `variant-source-baseline` 的冻结证据目录同规格：共享权威清单 + 按 id 引用。
评审只出报告、不进 lineage、不落盘，所以改它的契约代价极低。
**「机制提炼得对不对」仍然没有确定性兜底**——闸门只保证全批共用一份清单，不保证那份清单读对了原片。

**⑤⑥ 落地当天漏掉了「五个面」里的消费者面，而且是静默漏（2026-09-10 补）。** 生产者、校验器、
Prompt、测试当天都动了，`public/app.js` 的 `renderStoryCandidateReview` 没动：它还在读改名前的
`entry.sourceMechanism` 与移到顶层的 `entry.whereInSource`，而 `escape(undefined)` 返回空串——
**页面上是两处空白，不是报错**；`coherenceChecks` 与顶层 `sourceMechanisms` 更是压根没有渲染代码。
一个只在页面上显示的阶段，消费者漏了就等于这两档整个没做。

现在浏览器：顶层清单置顶显示（每条 id + 机制 + 原片在哪兑现），逐条 `mechanismCheck` 旁显示它
引用的那条机制正文，`coherenceChecks` 单独成块、`kind` 五个枚举各有中文标签（枚举值本身是英文
标识，直接显示等于让人对着 `purpose_nullified` 猜）。`candidateReviewMetrics` 同步**数出**因果
断裂条数与涉及候选数，与 §2.13 同规格不问模型要总分；旧报告没有这个键时数出来是 0，但那是
「这一档还不存在」不是「查过了没问题」，所以摘要里那一段整段不显示。
`test/story-candidate-review.test.js` 用源码断言锁住这四处，撤掉渲染即失败（已实测）。

**首次真实调用（2026-09-10，两个包）**：新契约此前 **0 次真实调用**，只有 mock 单元测试证明过——
与 `docs/待解决项.md` 第 7 条是同一个形状，同一个阶段上踩了两次。补跑《打枣》与《捐旧衣服》：
两个包**都把清单收敛到 4 条**（上限）、逐条锚到原片场次，全部引用命中清单内的 id，
新加的两条闸门一条都没触发；因果自洽两个包都是 **2/4 个候选**，四条都锚到拍号且具体
（「寻找主人的任务目的在下一拍被消解——灯笼本就不需要归还」）。
旧契约那种「4 个候选写出 8–9 条各不相同的原片机制」两个包都没有再出现。

**同一批数据里的两条限制**：①两个包都有**没被任何候选引用**的机制（打枣的 M4 零引用），
清单写满 4 条不等于 4 条都用得上，合法但说明上限是够用的；
②判 `pass` 的三个候选都没有报出自洽问题，所以
`STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK` **至今仍未在 live 触发过**，与 ⑤ 里记的一致。
**《捐旧衣服》第一次还撞了一次 502**——`recommendedOrder` 只写了 1 个 id，被既有闸门判失败、
整份报告丢弃、¥0.27 白烧。那条闸门与本次改动无关，但它是这一档没有重试路径的第一份真实代价，
促成了下面 ⑦。

**⑦ 允许第一次做错：带诊断重试一次（2026-09-10）**。`createStoryCandidateReview` 从
`generateStageJson` 改走 `modelCallCoordinator.runJson`，`maxProviderCalls: 2`，**禁止第三次**。
形状与 §2.14 的定向修订逐条对齐，因为搬的就是那套结论：
`docs/animation-plan-review-落地方案.md` §4 写着「事前在提示词里定规矩→没用（三次加码都没用）；
事后拿数字打回去重做→有用（两个模型都一次过）」，以及「**修订必须设计成「允许第一次做错」**」。
候选这一档此前只搬了前两部分（提示词定规矩、确定性闸门），第三部分没搬。

- **校验逐字不变**——改的是「错了之后怎么办」，不是「什么算错」。五条闸门（覆盖率、拍号、
  排列、机制 id 唯一与成员）一个字没动。
- **不需要错误类型转换**：`ensureStoryCandidateReviewCoversCandidates` 抛的
  `OutputContractError` 本来就被 `classifyAttemptError` 判为可重试，`details` 原样进
  `issue.diagnostics`。比修订那边简单——那边得先把 `ReviewContractError` 转过来。
- **重试只发诊断，不把失败的报告发回去**（`storyCandidateReviewRetryPrompt`）：原提示词逐字
  保留在前面，末尾追加校验器数出来的那几条 `path / reason / code`，**不另写一套人话翻译**
  （翻译一次就多一个会和校验器漂移的地方）。提示词本身已含全部候选投影与原片动作稿，
  把两千字报告再塞回去是纯浪费。没有结构化诊断时退回原提示词——只说「你错了」不说错在哪，
  第二次只会重复第一次。
- **拦过一次必须说出来**：返回值多一个 `metadata.storyCandidateReview`
  （`provider` / `model` / `providerCalls` / `rejections`），浏览器在报告顶部以 warn 色显示
  「第 N 次调用的结果，第一次被什么拦下」。`providerCalls` 由 `attemptObserver` 计数，
  **不能从「有没有被拦」反推**——传输失败时供应商确实被调用了两次而没有诊断，少报就等于
  把花掉的钱藏起来。旧报告没有这个键，整段不显示。
- **两次都被拦时两次诊断都在响应里**（每条带 `attempt` 序号）。coordinator 抛的
  `ModelPipelineError` 只带最后一次的 diagnostics，所以这条路径自己重建错误、合并两次的诊断，
  其余字段（category / code / origin / httpStatus / retryable / attempts / cause）逐字照抄。
  这正是 `docs/待解决项.md` 第 3 条记的、定向修订那边没做到的事。
- **走 coordinator 就拿不到 `generateValidatedJson` 那条路自带的 recorder**（它挂在
  `client.generateJson` 的 `onCompletion` 上，coordinator 走 `requestCompletion`），
  必须自己接 `attemptObserver`，否则**静默不写**、两次原文全部丢失。
- 传输失败同样吃这 2 次预算。`requestTimeoutMs` 不动（全局 900000；实测该阶段 117–130 秒出字，
  两次调用各自计时）。**其余八个走 `generateValidatedJson` 的阶段逐字不受影响**——
  不能给那个函数加重试，它是共用的单次调用路径（`docs/待解决项.md` 第 4 条）。

**它救不了什么**：诊断只有那五条闸门那么宽。机制清单读错原片、自洽问题判错这类**语义**错误
不产生任何诊断，也就不会触发重试。这条路只把「模型漏抄了几个 id、整份报告被丢弃」这类
失败从 502 变成重做一次，**不提高报告的判断质量，更不改变候选本身**——评审始终只出报告。

**重试路径在 live 至今没有真实触发过**：接上之后跑的两次都一次就成。那两次证明的是改动没有
破坏正常路径（报告形状正常、`metadata` 如实上报），**不证明重试能救回来**——与
`STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK` 的处境一样，只有单元测试证明有效。

**同一个包三次回放的结论明显不同**（`verdict` 从「2 pass / 2 revise」到「2 revise / 2 drop」，
因果断裂 2→3 处，`recommendedOrder` 三次都不一样）。⑤ 里记的「包与包之间很不齐」现在还要加上
**同一个包内部也不稳**，更强化那条结论：`verdict` 与 `recommendedOrder` 不得当成自动选择依据。

**⑧ 命题定向修订 `storyCandidateRevision`（2026-09-10）**（`POST /api/story-candidate-revision`）。
评审只出报告、不改命题，这一档才是唯一会改动命题正文的地方——但它同样**只出候选，不签发任何
东西**：不写回 `themeVariants`、不进 lineage、不 stale。签发只发生在用户点「采纳」的那一刻。

**驱动信号是逐条锚定的那两类，不是 `verdict`。** 依据就是上一段那组数字：`verdict` 与
`recommendedOrder` 在同一份输入上三次三样，而两个驱动信号都逐条锚定——因果断裂锚到拍号，
机制未迁移锚到清单 id。拿不稳的信号当修订入口只会让人白花钱。
**一次只修一个命题**：最终只有一个会被展开成 Full Story，一次一个的输出短、失败率低、对照也清楚。

**两个信号，两套修法，不能混（第二个是 2026-09-11 补的）：**

| 信号 | 来自 | 修法 |
| --- | --- | --- |
| 因果说不通 | `coherenceChecks` | **必须修**，基本都能靠改写解掉，不许添东西 |
| 原片有、这个命题没接住的机制 | `mechanismChecks` 里 `not_depicted` / `partially_depicted` | **由修订模型判断该不该接**；接就得先腾位置 |

补第二个信号的依据是实测：V4 被判 `drop` 的主因是三条机制**全部** `not_depicted`，评审自己的
summary 也写着「最该先改的是补充将画作转赠长辈的具体动作」，而修订当时只收到那条最轻的空间
断裂，于是只把「小木箱」换成了「高脚木凳」——**四条问题里最轻的那条被修了，最重的三条
根本没送到模型面前**。`candidateUnmigratedMechanisms` 因此把机制正文按 id 从顶层
`sourceMechanisms` 查回来一并送出：`mechanismCheck` 自己只有一个 id，光送 id 模型什么也做不了。

**接机制必须有拒绝出口，这是这一档能成立的前提。** 原片那条机制没被接住，**不等于这个命题
必须去接它**——一个刻意写成「不靠外部奖励、自己满足」的故事（V4 的 `emotionalPayoff` 原文就
明写「无外部奖励介入」），硬塞一个「获得表扬再转赠」的机制不是修订，是换了个故事。
所以提示词要求模型逐条判断，拒绝时**必须在 `changeSummary` 里写明理由**，不许假装接了、
也不许沉默跳过。这与「`verdict: drop` 只是一句话，不删候选」同规格：**评审的判断不是命令。**

**与「不要靠加戏」的冲突已解决，办法是提优先级而不是二选一。** 这两条一度会打架
（接机制通常要加动作），而两条硬约束互相矛盾时模型只会随机选一条——那是提示词自相矛盾，
不是模型的错。现在「不要往上堆」升为**铁律 4**，两类共用，只是宽严不同：第一类连换都不用换，
第二类允许换但**必须一换一**（先拿掉一个分量相当的），拿不掉就说明这个命题装不下，回到拒绝。

**同一次实测还补了一条提示词约束**：「换一个更好用的道具往往只是绕过问题」。09-10 那次修订
把小木箱换成高脚木凳，链条表面通了、故事一个字没变。提示词现在要求先问一句：这条链讲不通，
是因为工具不趁手，还是因为**这件事本来就不该这么办**。

**修法小节跟着问题走**：没有那一类问题就整段不出现。有修法没问题只会让模型去找活干——
这条是单元测试抓出来的，不是设计时想到的。

可写范围分三档，`src/story-candidate-revision.js` 里各有一份常量：

| | 字段 |
| --- | --- |
| **可写** | `storyOutline[].action` / `emotion` / `estimatedSeconds`、`keyDialogueDirections`、`newTask`、`environmentPressure`、`logline` |
| **派生或签发，出现即拒** | `keyChoice` / `climax` / `emotionalPayoff`、`transformationProof` |
| **冻结，逐字保留** | `id` / `title` / `oneLineHook` / `verticalFit` / `narrativeMode` / `characterSetup` / `keyChoiceBeat` / `climaxBeat`、每拍的 `beat` / `phase` / `dramaticFunction`、全部自我评价字段 |

`newTask` / `environmentPressure` 可写的依据是实测：一轮评审报出的三条断裂里**两条的根在任务设定**
（「寻找主人的目的被当场抵消」「任务目标是修好秋千而非做新秋千」），只改动作链改不掉。
`dramaticFunction` 冻结的理由不同——它是 `storyCandidateStructureSignature` 的输入，
让模型改它等于让它动 `validateVariantStructuralDivergence` 这个现有闸门。
`title` 冻结是刻意的：让人始终能在卡片上认出是同一个命题，也守住「修订」与「换一批」的界限。

**只覆盖、不增删**：模型按 `beat` 号定位，**只列真正改了的拍**（抄原文既没意义，也容易在抄的
过程中把措辞改掉——那正是 §2.4 记过的失败形状）。拍集合因此由构造保持不变，
`keyChoiceBeat` / `climaxBeat` 永远指得对。

四条闸门全是形状与字符串比较：`CANDIDATE_REVISION_SEALED_FIELD_PRESENT` /
`..._FROZEN_FIELD_PRESENT` / `..._OUT_OF_SCOPE` / `..._UNKNOWN_BEAT` / `..._DUPLICATE_BEAT` /
`..._BEAT_EMPTY` / `..._SUMMARY_MISSING`，外加一条 `CANDIDATE_REVISION_NO_CHANGE`——模型可以
合规地交回一份与原文逐字相同的修订，那不是格式错误，是没干活。

**服务端独占合并，并从头复验。** 顺序不能换：`assertOnlyCandidateRevisionFieldsChanged` 跑在
重新派生**之前**（那一刻三个投影还是原值，正好证明模型没绕过「派生字段不可写」），之后
`deriveStoryCandidateProjections` 才按新 action 重新派生，再走
`ensureOutputContract` + `ensureThemeVariantsMatchProfile`。**不传 upstream**——`source` 逐字未变，
重跑溯源核对是浪费；**固定角色边界照常验签并复验**，改动作链正是可能混进禁止特征的地方。
提示词只带**目标命题这一个**，不带同批其余命题、不带原片、不带评审的 verdict
（与「修订只带分镜、不带 fullStory」同源）。唯一与评审投影相反的一处：**`dramaticFunction` 要送**
——不能改但必须看得到，否则无从判断改完还成不成立。

**允许第一次做错**：走 coordinator，`maxProviderCalls: 2`，禁止第三次；两次都被拦时两次诊断都在。

**采纳的代价是整批的。** `themeVariants` 是**一份** Artifact，`variant:<id>` 依赖它，Full Story
再依赖 `variant:<id>`。所以签发新版本会**递归 stale 这一批全部命题的下游**，哪怕别的命题一个字
没改——digest 级联的必然结果，本版不改这个架构。浏览器采纳前照「换一批」的规格列出全部会失效的
下游并明确征求同意，文案写明「包括没有被修订的那些命题」。**推论：修订最省的用法是在选中命题
之前**，那时没有下游，代价为零。

**四条没有确定性兜底的，都要靠人在预览时看：**
0. **接机制那两个判断全在模型手里**：拒绝得对不对（是真的立意冲突，还是懒得改），
   以及声称「腾了位置」是不是真腾了。闸门只查形状，两条都判不了。本版**刻意不加台账**
   （理由见下面第 2 条），所以这两件事目前只有 `changeSummary` 的自述加人工核对。
1. **执行者反转**（§2.14 记过的形状：「甲替乙做某事」被写成乙替甲）。
2. **一换一但复杂度暴涨**：本版**刻意不设动作数量台账**——§2.14 那套净预算是三次提示词加码失败
   之后才引入的，命题阶段没有对应实测，凭推断加闸门违反「不得顺手扩大范围」。改为并排展示
   原文与修订稿并数出动作链字数，先积累数据。**这是已知缺口**，因为 `docs/待解决项.md` 第 1 条
   （单场动作过载）的上游正是命题的动作密度。
3. **`dramaticFunction` 名义还在、实际已不成立**：提示词写了「保持每一拍的 dramaticFunction 真的
   成立」，但它是冻结字段、逐字未变，闸门查不出改完之后那个功能还在不在。


### 2.13 剧情体检（storyQualityReview v1，2026-09-04）

Full Story 生成之后的**独立验收，只出报告**：不修改剧情、不签发 Artifact、不进 lineage、不参与派生、不 stale 任何东西、**不阻断后续 Animation Plan**。与 `boundaryWarning` 同规格，纯展示；刷新页面即失（v1 有意不持久化）。手动触发，`POST /api/story-quality-review`。

它检查的是现有校验器全都查不到的一类问题：**字段声称的事，画面里到底有没有。** `dramaticFunction: "建立悬念"` 只是标签不是证据；`retentionPlan[].viewerQuestion` 写着一个问题，不能证明观众看得到引发那个问题的画面。依据是一份已签发 Plan 的实测：剧情与 Plan 都把「末班车已经开走」当作开场核心信息，而首镜画面里没有公交车驶离、没有末班车广播，观众实际只看到一个女孩晚上坐在站台看地图。判定依据**只认 `visibleAction` 与 `dialogue`**——`shotAndSound`、`shootingNotes`、`beatSheet` 是拍摄说明与叙事目标，不是画面本身。

输出三块：`sceneFunctionChecks`（逐场核对 `dramaticFunction`）、`retentionChecks`（逐条核对 `retentionPlan`）、`issues`（`BLOCKER`/`MAJOR`/`MINOR` 三档硬伤）。三档判定 `depicted` / `partially_depicted` / `not_depicted`。

**覆盖率由服务端确定性核验**（`ensureStoryQualityReviewCoversStory`）——模型完全可以只报它碰巧注意到的两三条，交回一份看起来很专业、实际漏检大半的报告：
- `sceneFunctionChecks` 与 `sceneScript` **数量相等且 `sceneId` 逐位相同**
- `retentionChecks` 与 `retentionPlan` **数量相等且 `index` 逐位递增**
- 回显的 `declaredFunction` / `viewerQuestion` 必须**包含**剧情原文（归一化掉空白与标点）
- `issues[].sceneIds` 与 `shownInScenes` 引用的场次必须真实存在

**真正的覆盖率保证是前两条（数量 + 逐位 id），不是回显。** 回显只多提供「你有没有真看这一条的内容」这个较弱信号，所以判据从「逐字相等」放宽到「包含且归一化标点」：实测严格相等挡下的全是模型在原文后追加注解（千问 10 份里 3 份）和标点替换（MiMo 把「关键选择，打破…」写成「关键选择：打破…」），都不构成歧义；复述与截断仍然被拒。核验通过后**服务端用剧情原文无条件覆盖这两个字段**——它们可从剧情唯一推导，**回显不构成新事实**，与 direct_shot 骨架同规格。

「有没有兑现」本身是语义判断，**没有确定性兜底**：覆盖率只保证模型逐条看过，不保证它看得对。

**明确不做，三条都有实测依据**：①**不打总分、不设门槛**——实测 13 份的模型综合分挤在 7.8–8.3、中位 8.2，ChatGPT 给参考片也才 8.4，此刻画任何线都是拍脑袋；可比对的数字改由 `public/story-review-metrics.js` 从逐条判定里**数出来**（未兑现数、三档硬伤数），跨故事直接可比、不随措辞漂。②**不自动改剧情**——实测「评审→重写」单轮平均只涨 +0.17（6 组对照，落在评分者噪声 MAD 0.45 内），且 40% 撞契约硬失败。③**不阻断生产**——现有闸门全是确定性的，模型意见当硬闸门是另一回事，§2.8 明写「用户明确肯定/否定 > 已签发模型推断」。

**评审模型的已知偏差**：默认沿用剧情阶段的 provider，也就是写这份剧情的那个模型，自己批自己会偏松（实测同一份剧情自评「AI 可执行性 8.0 / 物理可信度 8.0」，外部模型给 6.8 / 6.8）。本来要默认换一家，但同一批 10 份实测下来现有备选都不胜任：`mimo-v2.5-pro` 7/10 成功且太松（2/62 处 vs 千问 13/91 处），`deepseek-v4-flash` 5/10、反复产不出严格 JSON，`deepseek-v4-pro` 连接中断。一个查不出问题的评审比偏松的评审更没用，稳定性也是硬要求。**先用能干活的那个并如实记下偏差，不靠静默降级掩盖**；它是纯文本阶段（不在 `requiresMediaModel` 里），可按阶段 override 换任意一家。

### 2.14 分镜终审与定向修订（animationPlanReview / animationPlanRevision，2026-09-06）

Animation Plan 生成之后的两段式验收。与剧情体检同规格：**只出报告、只出候选，不签发任何 Artifact**，
不进 lineage、不参与派生、不阻断后续生产；报告与修订结果都不落盘，刷新页面即失。

它查的是现有校验器全都查不到的一类问题：**剧情声称的事，镜头里到底拍没拍。** 实测案例：
剧情首句写「末班车的红色尾灯刚刚消失在路口转角」，而首镜 videoPrompt 从人物坐在长椅上开始、
一帧车都没有——「末班车已走」只写进了 `continuityNotes`，那是给生成器的备注，不会被拍出来，
全片赖以成立的悬念从未建立。评审必须**同时**收到 `fullStory` 与 `animationPlan`：没有对照物就发现不了这一类落差。

**修订反过来只带分镜，不带 `fullStory`。** 问题已由终审定位，再给剧情只会让模型顺手重编故事。

**评分不作放行门槛**：实测两个模型评同一份 Plan 总分只差 0.06，而单个维度能差 ±1.0，这个数字没有分辨力；
有用的是 `dominantDefect`、`issues` 与 `upgradePath` 的具体内容。

**`issues` 在报告里出现两次且形状不同（2026-09-07）。** 顶层 `issues` 是结构化对象数组
（`issueId` / `severity` / `category` / `evidencePaths` / `problem` / `revisionIntent`…），
而 `shotEvaluations[].issues` 是**纯字符串数组**，每项一句话。实测代价：提示词的输出模板里
镜头级只给了 `[]`、元素类型全文无任何示例，而 18 行之下就是同名的对象数组，模型于是按对象填，
`/shotEvaluations/{0,2,4,5}/issues/0 类型必须为 string` 硬失败——失败模式印证这是一贯误读
而非抖动：它判定有问题的镜头全部在 `issues/0` 失败，写 `[]` 的镜头全过。
提示词现在既给非空示例也点名这处同名碰撞；`mockAnimationPlanReview` 给第一个镜头一条非空
`issues`，两个分支都走到——此前全写 `[]`，正是 mock 通过而 live 失败的原因。
**不重命名该字段**：镜头级 `issues` 没有任何消费者（`ensureReviewReportContract` 只核对
`shotEvaluations` 的数量与 `shotId` 逐位一致，浏览器的 `renderAnimationPlanReview` 也不渲染它），
重命名要动契约五个面，收益不抵代价。schema 是唯一且足够的闸门，**不给它挂自动纠错**——
模型写的是自然语言判断，服务端无法把一个对象唯一地压成一句话。

#### 净预算：把「算不算净增」的判定权从模型手里拿走

**事前用提示词约束无效，三次加码全部失败**：写「注意不要太满」它照加；改成「不允许净增加」它照加，
还在摘要里写「本镜只替换未净增」；补一句「不要自称只替换而实际增加」，它换个说法
「这四个是细节，均并入原有动作链，不增加独立动作段」。根因是**「一个动作」没有客观定义**，
判定权在模型手里就永远有解释空间。

解法是要求模型显式列出 `removedActions[]` / `addedActions[]` 台账，**服务端只数数组长度**。
**每一个被修订的镜头**都必须 `removed >= added`，诊断码 `REVISION_NET_ACTION_BUDGET_EXCEEDED`。

**这条曾经只约束被判过 `pacing` / `ai_risk` 的镜头，2026-09-06 收紧为无例外的全局默认。**
依据是真实数据回放：一份手工跑出的真实修订输出里 A03 删 0 加 1、A07 删 3 加 4、A08 删 0 加 1
全部净增而畅通无阻，旧规则一条都没拦住。**而且「只在没被要求加内容时才约束」这种折中同样无效**——
这三镜的报告条目恰恰全是「要求加内容」（`increase`），按那种写法仍然一个都拦不住。
A07 正是外部评审指出手部逻辑仍然错误的那一镜（`characterAction` 写着老奶奶单臂抱猫却又双手递猫粮）。
代价是终审要求往某镜加内容时，模型必须先从该镜腾出位置；提示词与重试提示词都已改成这个口径，
且提示词本来就写着「优先保留终审明确要求的那个新增动作，其余为了丰富细节而加的一律放弃」。
同一份输入两个模型都如实报了数（删 2 加 7 / 删 2 加 4）并被拦下；带算术诊断重试一次后两个都一次通过，
而且结果更好——第一次加 7 个动作把镜头塞满，重试后只留下终审真正要求的那一个。

**因此第一次被拦是常规路径，不是异常路径。** 预算固定 2 次 provider 调用，第二次仍被拦即 fail closed
（保留原 Plan、把两次诊断如实报出），与第三节局部纠错的纪律一致。**禁止第三次重试。**

判定只有一份：`revisionShotLoad()`（`src/animation-plan-review-validation.js`）同时供**提示词的每镜预算行**与
**校验器的硬闸门**使用。两边各算一次必然漂移，结果就是模型被要求做 A、却按 B 被拒。
同一镜同时被要求减负与加内容时它判为**冲突镜头（只准替换）**——上一轮事故正是这个形状：
模型只执行了「加」，`pacing` 6.2、`aiStability` 5.8、`physicalFeasibility` 6.9 三项同时退化。
条目的镜头归属只认结构化的 `affectedPaths` / `evidencePaths`；**仅当这两个数组一个镜头都解析不出来**
（schema 允许它们为空、此时条目彻底无法归属）才回退到 `problem` 正文里的镜头号，
不会把正文顺带提到的对照镜头误判成受影响镜头。

#### 服务端独占合并，并从头复验

模型只返回七个可写字段（`videoPrompt` / `cameraMotion` / `characterAction` / `dialogueOrSubtitle` /
`soundDesign` / `continuityNotes` / `acceptanceCriteria`）。六个签发字段（`shotId`、`sourceSceneId`、
`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`）出现即拒绝；合并按可写字段逐个覆盖，
所以签发字段**由构造保证**不可能被改动，并另有 `assertOnlyRevisionFieldsChanged` 证明可写字段之外逐字节不变。
模型返回本次未授权的镜头即 `REVISION_SHOT_OUT_OF_SCOPE`——那不是「顺手多改了一点」，是越权写入未经评审的镜头。

合并结果必须**在这里**就通过 `ensureAnimationPlanDirectShotContract` 与背景音乐收尾句校验，
而不是等用户点了采纳、媒体已经作废之后才失败：采纳时签发的就是这份合并结果，
台词必须逐字出现在 `videoPrompt` 那道闸门同样适用。

只支持 direct_shot Plan。旧 v2 首尾帧 Plan 的字段完全不同，走这条路径明确失败，不得静默按 direct_shot 处理。

**终审的 `ReviewContractError` 必须转成 `OutputContractError`（2026-09-07）。** 它不在
`classifyAttemptError` 的分支表里，原样上抛会落进「internal / retryable: false」兜底——
三张覆盖表数量对不上、引用了不存在的镜头号这类**模型内容错误**会变成一句 HTTP 500
「服务器内部错误」，用户完全看不出模型错在哪。修订路径早有同款转换器
（`reviewContractAsOutputContract`，现由两条路共用），终审此前没接上。
**注意终审这条路没有重试**：它走 `generateValidatedJson`，只发一次、对已解析候选 fail closed，
所以转换买到的是正确归属与能送到用户手里的结构化诊断，**不是多一次机会**。

#### 先预览，确认后才签发（已定的范围决定）

修订返回后**不自动写回 Plan**：先并排展示原文与修订版、台账与 `changeSummary`，用户点「采纳」才签发新
Plan revision 与新 media namespace 并递归 stale 该变体已生成的全部媒体。这把重代价推迟到确认那一刻——
实测修订第一次输出常常要被打回，自动签发会造成大量无谓的 revision 与媒体作废。
浏览器在采纳前复核 `sourcePlan` 与当前 Plan 是否仍逐字相同，不同就作废本次修订，绝不把基于旧内容的改写盖到新 Plan 上。

#### 两条没有确定性兜底的约束

**执行者反转**：建议写「甲替乙做某事」，模型会为了句子连贯调换主语写成「乙替甲」，方向一反建议就作废
（实测发生过：升级建议要求长辈替主角别碎发，模型写成主角替长辈）。铁律第 3 条为此而设，
但判断执行者对不对需要语义判断，**只能靠人工在预览时看**，界面上明确写了这一句。
**一换一但复杂度暴涨**：净预算数的是条目数，不是复杂度。实测一份真实修订在 A02 上删 1 加 1 合规通过，
而删的是「路人撑伞走过的第二次强调」（一条很轻的背景），加的是「外套滑落→小猫露头→发抖→用围巾压住→重新裹紧」
（执行复杂度明显更高的动作链）——而 A02 的 `pacingAndDuration` 只有 6.5、终审自己已判它过载。
**开这个方子的是终审**：UP-04 的 `netActionBudget` 原文就写着用这个链条去「替换」路人强调、「不净增动作」，
修订模型只是照做且如实报了数。要不要再数一层总字数、或约束终审不得开出「新增动作链」的方子，是**未决的取舍**，
不得在此擅自选边。
**不得改成让模型自报 `actionComplexity`，也不得拿维度分数当门槛**——前者把判定权还给模型（净预算的全部出发点
就是把它拿走），后者用的恰恰是本节开头说的、分辨力最差的那个数字（同一份 Plan 两个模型单维能差 ±1.0，
门槛会随机开关）。

#### 两个提示词正文存为资源文件

`src/animation-plan-review-prompt.md`（`docs/` 下有供人类阅读的同一份，测试锁定两者逐字相等）、
`src/animation-plan-revision-prompt.md`、`src/animation-plan-revision-repair-prompt.md`，
由 `src/prompts.js` 读取并剥掉开头的 HTML 注释头。**不要硬写进模板字面量**——终审那次因正文含大量反引号
与半角双引号，硬写导致 `prompts.js` 损坏过一次。重试正文中间留了一行标记，服务端把结构化诊断替换进去；
该标记的完整形态不得在头注释里重复写出，它自带的结束符会提前截断头注释、让说明文字混进真正发给模型的正文。

#### 按阶段放宽的 timeout 现在才真正生效

两个阶段都配 `requestTimeoutMs: 1800000`（终审实测正常出字最长 941 秒，修订实测 233–775 秒）。
在此之前 `resolveStage` 解析出的这个值**没有任何阶段传下去**——`generateValidatedJson` 根本不接收它，
于是终审配的 1800000 完全没生效、仍按全局 900000 被掐，而 941 秒正落在被掐的区间里。
现已在 `generateStageJson` → `generateValidatedJson` → client 之间接通；其余阶段该值为 `null`，
传 `null` 与不传逐字等价，行为不变。**不动全局默认值。**

#### 传输不稳定与尚未做的兜底

实测失败率约三分之一，两种形态：`fetch failed`（3–5 秒，没烧 token）与 `terminated`（几百秒才断，token 已烧）。
换模型兜底实测有效（一份输入 qwen3.8 三次全败、kimi-k3 一次通过），`docs/animation-plan-review-落地方案.md`
已决定「评审允许换模型但必须在报告里写明」，**但两个阶段目前都还没有实现换模型兜底**，不要按已实现来推断。
修订的 metadata 会如实记录 provider、model、实际调用次数与第一次被拦的诊断——服务端拦过一次就必须说出来。

### 2.7 模型 provider 边界

工作流 LLM provider：**Qwen / MiMo / DeepSeek**。

**qwen-client 全模型流式传输（2026-09-05）**：`buildQwenRequestBody` 对**全部模型**发送 `stream: true` 与 `stream_options: { include_usage: true }`，响应由 `src/sse-stream.js` 唯一一份 SSE 解析读取。`deepseek-client.js` 与 `mimo-client.js` 传输层与它同构，但本次**未改**，仍是非流式。

依据是 debug 侧车的实测：非流式长请求会在约 306 秒被上游掐断。kimi-k3 与 qwen3.8-max-0902 各两次，耗时 306503 / 306696 / 306704 / 306861 ms，浮动仅 358ms、**跨两个不同模型**——是确定性的固定超时，不是网络抖动；四次全部 `usage: null`、`finishReason: ""`、零字节输出。而全部成功调用 ≤ **234 秒**（最慢是 qwen3.7-max 的 variants，14321 completion tokens），余量只剩 72 秒。**悬崖在传输层不在模型**，所以不维护按模型的清单——那是治标，换个更长的 prompt 就会再撞上。

**根因只定位到一半，如实记录**：已排除我们自己的 fetch timeout（`QWEN_REQUEST_TIMEOUT_MS=900000`）；也已排除本地代理（`127.0.0.1:7892`）的隧道空闲超时——实测纯 CONNECT 与 CONNECT+TLS 两条隧道静默 **600 秒以上仍然存活**。dashscope 固有往返开销实测 1.9–4.2 秒，与「上游约 300 秒响应超时 + 建连开销」一致，但**具体是哪一层未能确定**（区分需要向 dashscope 发真实长请求，会计费）。这不影响结论：只要超时判据是「长时间没有数据」，流式就是对症的。

约束：

- **流不完整必须失败，绝不返回半截内容。** 读到流结束但既没有 `[DONE]` 也没有任何 `finish_reason` 时抛 `MODEL_STREAM_INCOMPLETE`。返回半截内容会让残缺 JSON 被下游报成「JSON 格式错误」，把传输问题伪装成模型输出问题。
- 该错误码在 `classifyAttemptError` 里**必须单独分类**为 `category: "transport"` + `retryable: true`。不单独分类会落到 `ModelResponseError` 的兜底分支（`status=0` → `protocol` 且 `retryable: false`），把可重试的网络中断变成不可重试的协议错误。
- **禁止非流式自动回退。** 流式失败就如实报错——自动降级是第五节第 4 条的「失败时返回默认值」。
- **`terminated` 的包装判据是「收到过任何数据块」，不是「收到过正文」（2026-09-07）。** 连接中途被切断时 `qwen-client` 把它包装成可重试的 `MODEL_STREAM_ABORTED`，判据原为 `partialContentLength > 0`。但下一条明写 `reasoning_content` 单独收集、不算正文，而 qwen3.8-max 实测 **82% 的 completion token 是推理**（`reasoning_tokens` 23449 / `completion_tokens` 28466）——推理期断线时正文长度仍是 0，裸 `TypeError` 漏出包装、一路冒到 HTTP 层变成**不可重试的 500**。实测两次分镜终审失败（158 秒、649 秒）都是这个形状：流一直活着、模型一直在推理，只是还没吐正文。判据改为 `partialChunks > 0`，`classifyAttemptError` 逐字未改。**只改包装条件，不改「流不完整必须失败」的结论。** 只覆盖 `qwen-client`，另外两家仍是非流式。
- `delta.reasoning_content` 单独收集，**绝不混进正文**；`usage` 只在最后一个数据块里返回，缺 `stream_options` 就拿不到 token 记账。
- 解码必须用 `TextDecoder` 的 `{ stream: true }`：一个汉字的 UTF-8 字节可能被拆到两个数据块，对每块单独解码会产生乱码。
- 返回形状与非流式**逐字一致**的 7 个字段：`content` / `finishReason` / `requestId` / `usage` / `providerName` / `model` / `raw`。`providerName` 被 `model-call-coordinator` 与 `workflow` 用于错误归属，`model` 用于用量记账，漏掉会静默降级到回退值。
- 测试 mock 必须发 SSE，判定只有一份在 `test/helpers/sse-response.js`。三个 client 共用同一个 baseUrl 的 mock 按请求自报的 `stream` 决定响应格式，与真实服务器一致。

**尚未实测**：`.env` 的 `QWEN_JSON_MODE=true` 会让非 Zhipu 模型同时带 `stream: true` 与 `response_format`。这个组合是否被 dashscope 兼容模式支持没有核实过；若不支持，应改为流式时按模型跳过 `response_format`——本地严格 JSON 校验本来就在，不依赖 provider 的 JSON mode。


DeepSeek **只允许**用于纯文本阶段：Brief、Variants、Legacy Full Story、Animation Plan、Static Frame Compiler（仅旧 v2 兼容路径）。

**禁止** DeepSeek 用于需要图片或视频输入的阶段：Analyze、Reconstruct、Visual Guardrails、Character Reference。

DeepSeek 模型 ID 只登记 `deepseek-v4-flash`（页面首选）与 `deepseek-v4-pro`（只能显式选择）。不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。

确认 Profile 改写**必须使用已配置的实时文本模型**；demo mock 不得伪造语义审计结果或生产 Profile。

### 2.8 全局角色边界

- `Visual Guardrails` 是固定角色语义的**唯一生成阶段**。允许视觉模型结合用户设定、参考分析、脚本还原、创意简报与模型常识生成开放语义边界；**不得新增本地物种关键词字典替代模型判断**。
- 服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、视频生成，以及旧 v2 兼容路径的**唯一**固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份边界。
- **边界不得同时要求与禁止同一特征，判定是单向子串包含（2026-09-06）。** `validateGlobalCharacterBoundary`（`src/validation.js`）对每个 required term `R` 与 forbidden term `F`，`R.includes(F)` 即硬失败，消息同时点名两端（`required「无头饰」包含 forbidden「头饰」`）。这条不变量本来就在，只是此前写成 `Set.has()` 的**精确相等**，而下游每一个扫描器（`hasForbiddenOccurrence` / `findMissingGlobalCharacterTraits`）用的都是 `text.indexOf` **子串**——守卫用相等、扫描器用子串，中间那条缝就是全部原因。
  依据是 2026-09-05 实测：用户 `fixedCharacter` 写「无头饰，但头顶有一个光环」，Guardrails 把「无头饰」签成 requiredTrait、又把「头饰」签成 forbiddenTrait，Full Story 模型把那份 requiredTraits 清单几乎逐字抄进 `characterBible.protagonist.traits`（上游叫 requiredTraits，Story 字段就叫 traits，它是在**服从**边界），于是连续三次 `OUTPUT_CONTRACT_INVALID`、约 7.6 万 token、6.2 分钟，而错误消息指向 `traits[4]`、完全没提边界矛盾。改后同一份数据在 `assertGlobalCharacterBoundary` 就失败：**0 次 provider 调用、2 毫秒**。
  **方向必须单向，反方向是合法的。** required 文本里必然出现 `R`，若 `F ⊆ R` 则服从 required 就自动违反 forbidden，无解；反过来 `R ⊆ F` 完全成立——「猫耳少女」含 required「猫耳」而不含 forbidden「非猫耳动物器官」。回扫 95 份已签发边界：正方向碰撞 3 份（`无头饰⊃头饰`、`无兽尾⊃兽尾`、`浅灰蓝色长发⊃蓝色长发`），**反方向碰撞 14 份且全部合法**（`去除猫耳特征⊃猫耳`、`非嗷呜拟声词⊃嗷`），做成双向会误杀 15%。`allowedTraits` 方向碰撞为 0，本次不扩大范围。
  **否定型不是唯一形状，正向型没有兜底。** 否定型（`无头饰⊃头饰`）在角色参考链路被 `allowNegativeContext: true` 救下，只在 strict 扫描致命；而 `浅灰蓝色长发⊃蓝色长发` 是边界把某个必需事实的**可接受写法之一**与禁止写法重叠，已实测按边界自己认可的拼法写就在成片渲染前硬失败（`混入全局边界禁止特征：蓝色长发`），它此前静默通过，只因模型碰巧写了「浅灰蓝色长直发」。
  配套在 `visualGuardrailsPrompt` 加了两条生成约束（必需写法不得包含禁止写法；否定短语只进 `forbiddenTraits`）。守卫是 fail closed，没有配套指引会变成反复拒绝而模型不知道怎么改。**这不是降低校验标准**，是让一条已被接受的契约按它自己的语义生效，判定为纯字符串包含，不含语义判断。已签发的旧边界仍可加载查看，只在生成新的下游阶段时被拒——所有调用点都是生成路径，与 §2.4 已下线方言同型。
- **角色参考图提示词接入 `visualBible`。** `/api/generate-character-reference-images` 送给图像模型的提示词由 `public/character-reference-prompt.js` **单份**构建，浏览器预览框与服务端回退共用它——用户看到并可编辑的必须逐字等于实际发送的。字段顺序按 `docs/video-prompt-guide.md` 模板 1：光线 → 角色外观 → 姿态表情 → 干净背景 → 风格色调 → 景别/取景/机位。风格与光线取自当前 Plan 的 `visualBible`（`overallStyle`/`animationStyle`/`colorPalette`/`lighting`），**缺失时整行省略，不编造**。`cameraLanguage` 是镜头语言，不属于角色参考图的取景说明，不得搬入。
  依据：`videoPrompt` 197/197 写了全片风格色调、188/197 写了光线，而给它当视觉锚点的角色图此前完全不知道全片调子，直接冲突「角色一致性」这个验收方向。
- **执行力度分两档，事实来源不变。** 角色参考阶段——`/api/refine-character-reference` 的精修结果、`/api/generate-character-reference-images` 的 `characterReference` 与用户可编辑 prompt——遇到边界偏差**只提醒不阻断**：服务端仍按边界完整判定，把偏差原文放进响应 `boundaryWarning` 或 `boundary-warning` 流事件，浏览器以 `warn` 色展示并照常完成本次操作，用户不必重新上传。依据是本节已有的「用户明确肯定/否定 > 已签发模型推断」。`boundaryWarning` **只用于展示**，浏览器写回 Plan 前必须剥离，不进入 Artifact。成片渲染链路（`/api/generate-shot-video`、`shot-video-generator` 的 `effectiveVideoPrompt`、旧 v2 首尾帧 `/api/generate-shot-frame-image`）**仍然硬失败**：`ensureCharacterReferenceMatchesBoundary` / `ensureCharacterPromptMatchesBoundary` 逐字保留抛错语义，只提醒的那三处改调同一判定的收集器 `characterReferenceBoundaryMismatch` / `characterPromptBoundaryMismatch`（返回空串即合规）。判定规则只有一份，禁止另建第二套词表。
- **已核实的实现细节，别按字面理解上一条**：`characterPromptBoundaryMismatch`（`src/validation.js`）在 `promptScope === "multi_character"` 时**无条件短路返回空串**，不做任何词条匹配。而两条成片渲染链路——`/api/generate-shot-video`（`server.js`）与旧 v2 `/api/generate-shot-frame-image`——传的**都是** `multi_character`。因此这两处对**提示词正文**的扫描实际不生效；真正在渲染前硬失败的是 `ensureCharacterReferenceMatchesBoundary` 对结构化角色参考的判定（那是另一个函数，没有该短路）。
  这个短路本身是有意的：视频/多图提示词天然含多个角色，程序无法把某个禁止特征归属到具体角色，硬扫会误伤合法配角。**要不要给多角色提示词补一套可归属的判定，是架构决定，不得在实施顺手改 `promptScope` 或放宽该函数。** 在此之前，任何声称「渲染前提示词正文已被边界拦截」的推断都是错的。
- **精修不得因改写外观而丢掉必需事实。** `/api/refine-character-reference` 允许按参考图改写 `appearancePrompt`，但判定是**字面比对**：把「穿着适合户外写生的村民服装」换成具体衣物，identity 类的「村民」就没了。所以提示词必须逐条列出每条 `requiredTraits` 的可接受写法，并说明身份、性格、职业、剧情功能类事实写进 `identity` 或 `consistencyTags` 同样算数；服务端在返回前用与判定**共用**的扫描口径（`characterReferenceRestorableMissingTraits`）补回缺失事实：只能在 `consistencyTags` 尾部按签发顺序追加 exact `canonicalName`，**冻结 `appearancePrompt`**，不用同义词、不重排。**补写只覆盖非 `appearance` scope**——外观必需事实缺失意味着模型真把长相写错了，补个标签不会让图里长出狼耳，那种情况必须继续走 `boundaryWarning` 并在成片渲染前硬失败。服务端改了模型输出就必须说出来：`boundaryRestoreNotice` 与 `boundaryWarning` 同规格，只用于展示，浏览器写回 Plan 前必须剥离。
- **人物参考精修的冲突优先级分两档。** `/api/refine-character-reference` 遇到参考图与文字设定冲突时：**配角（非固定角色）以用户上传的参考图为准**——按图改写 `appearancePrompt` / `consistencyTags` / `forbiddenChanges`，即使图里明显是另一种角色也照图改写，不得以「与当前角色不符」为由放弃采用；`characterName` 与 `storyRole` 承担的剧情功能不变，变的只是外观。依据同样是本节的「用户明确肯定/否定 > 已签发模型推断」：配角的文字设定本身是模型推断产物，而上传图片是用户的明确动作。**固定角色仍以已签发 `fixedCharacterBoundary` 为准**，参考图只能补充不冲突的细节——让图片覆盖边界只会把失败推迟到成片渲染的 `ensureCharacterReferenceMatchesBoundary`。覆盖结果由模型写进 `referenceImageOverrideNotice`，与 `boundaryWarning` 同规格：**只用于展示**，浏览器写回 Plan 前必须剥离，不进入 Artifact；固定角色路径一律丢弃该字段，那条路的唯一提醒通道仍是 `boundaryWarning`。分档判定只用 `characterName` 与边界名的身份比较，不新建第二套词表。
- **签名密钥必须持久化**：`groundingKey` 与 `characterBoundaryKey` 保存在状态根目录的 `.grounding-key` / `.character-boundary-key`（可由 `WORKFLOW_GROUNDING_KEY` / `WORKFLOW_CHARACTER_BOUNDARY_KEY` 覆盖，环境变量优先），与 `.package-signing-key` 共用`src/persistent-key.js` 的读取或创建逻辑。**跨进程重启不得改变**——换钥会让全部已落盘 Artifact 的 `groundingSeal` 与`boundarySignature` 作废。缺失即生成；环境变量非法、文件损坏或长度不足一律硬失败，**禁止静默回退为随机生成**，也禁止覆盖长度不足的文件。密钥材料不得进入 config 对象、响应或日志。已落盘 Artifact 不得用新密钥重新签发。
- 生产环境必须校验 `boundarySignature`。**仅当**服务端显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test|development` 且 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时可跳过 HMAC 比较（`sourceDigest` 与 `boundaryDigest` 仍必须匹配）。该策略**只能来自服务端环境，禁止由请求体控制**。
- 冲突优先级：**用户明确肯定/否定 > 已签发模型推断**。无法消解的冲突必须阻断，不能静默选边。用户或权威上游数据改变后，旧边界必须失效并重新生成。

### 2.9 来源字段表达规则

- Creative Brief 的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression`，以及 Visual Guardrails 的 `sourceSimilarityRules.sourceExpression`，在列举同类多个具体物品时**每一项都必须重复完整中心名词**（"绿色邮箱、红色邮箱、蓝色邮箱"），禁止"绿色、红色、蓝色邮箱（组合）"式缩写。该规则只规范已有来源事实，**不授权补充新物品**；下游也不得靠颜色词或中文语法猜被省略的名词。旧 Artifact 含歧义缩写时必须**重新生成对应上游阶段**，不能原地推断或改写已签发内容。
- `allowedNarrativeComponents[].component` 是服务端固定的**七项 taxonomy**：送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾。Prompt 必须展开完整七项；模型只能填每项非空的 `howToReuseSafely`，**不得改名、合并、省略、重复或增加**。不适用时也必须保留该项并说明不采用或限制条件。**每条 `howToReuseSafely` 必须以 `【原片有】` 或 `【原片没有】` 开头**作出存在性判定（只陈述上游已发生的事实，不描述新片打算怎么拍），缺前缀即确定性失败——防止模型把"新片可以怎么用"写成复用授权，替原片补出它没有的构件。`【原片有】` 还必须用「」引出上游依据，服务端按字符覆盖率（LCS，阈值 0.75）回到 `sourceScriptReconstruction`/`referenceAnalysis` 核对；**允许转述，不要求逐字**，覆盖率不足即失败（仅在校验器收到上游时执行）。Story Candidates 的分化规则在后续严格契约中独立执行，不属于 Creative Brief taxonomy。数组顺序不承载业务语义。七项名称由服务端常量与 validator **共用**，禁止在 Prompt、Mock 或校验器中各自维护第二份列表。
- 上述来源字段与 `sourceSimilarityRules` 只是原片表面表达的 provenance，**不是下游正文禁词**。原片道具、拟声词、角色组合允许按当前选定剧情出现在任意正向业务字段（含 `visibleAction`、对白、声音、`videoPrompt`）；但不得仅因它们存在于来源上下文就机械注入下游。`sourceSimilarityRules` 只在实际生成请求确实携带原片参考时为 `reference_leak` 提供证据。`dialogueRules` 只能来自用户明确约束，不得把原片对白或拟声词自动升级为对白规则。该放行不改变 `fixedCharacterBoundary` 的优先级。

### 2.10 Story Contract

每个 scene 必须有：`sceneId`、`location`、`characters`、`visibleAction`、`shotAndSound`。

`characterBible.careRecipient` 是可选键：当前 Variant 没有被照料对象时整个省略，`helpers` 无帮助者时输出 `[]`。**Full Story 不得把候选阶段省略的叙事构件补回来**——七项 taxonomy 是 Creative Brief 记录「原片有没有某类构件」的分类，不是本片必备构件，也不是承接清单。承接范围只有一个来源：当前选中 Variant 实际写出的内容。

**剧情时长目标（2026-08-29）**：浏览器「设定创作宇宙」面板的「剧情时长」下拉（`#storyDurationTarget`）提供「与原片对齐」与 45/60/75/90 四档，默认对齐原片。原片时长两级回退：上传时读出的 `metadata.duration`（精确）→ `sourceScriptReconstruction` 末场时间轴终点（恢复旧 run 时用，与真实时长差 0–5 秒）→ 60 秒。**该值只作为目标进入 Full Story 提示词，不写入任何 Artifact、不参与派生**——`targetDurationSeconds` 仍由 `deriveFullStoryTargetDuration()` 从 `sceneScript` 时间轴确定性派生并覆盖模型输出，模型没打准时 Artifact 与页面显示的都是时间轴的真实合计。提示词窗口跟随目标（±15%）而非固定 45-90——原片 96 秒时仍写「必须落在 45-90 秒内」会与「与原片对齐」自相矛盾。请求侧只校验 20–180 的整数秒，**不新增校验拦截「模型没达到目标」**：那是生成质量不是数据一致性。不传该字段时提示词文案与历史逐字一致。

**目标必须同时进入主题变体阶段（2026-09-05）**：候选 `storyOutline[].estimatedSeconds` 的合计**事实上决定成片长度**——Full Story 照它排 `sceneScript` 时间轴，Animation Plan 再按时间轴派生镜头。而该字段没有代码消费者、没有校验器（schema 只有 `{ "type": "number" }`）、`src/validation.js` 零引用，它对下游的唯一影响路径是随 `JSON.stringify(variant)` 整体注入 Full Story 提示词。此前变体阶段**完全收不到时长目标**（浏览器请求体、Durable `buildInput` 白名单、`variantsPrompt` 三处都没有），模型只能凭空估。

实测代价：用户选「与原片对齐 · 65 秒」，候选六拍估成 12/15/18/15/20/15 = 95 秒，Full Story 的六场 `timeRange` 跨度**逐位照抄**这六个数字，成片 95 秒、镜头数按 15 秒上限翻倍。当时 Full Story 提示词同时写着「忠实承接 Variant 实际写出的内容」和「合计必须落在 55-75 秒内」，**两条都是硬约束且没有定义优先级**，模型选了承接上游——这是提示词自相矛盾，不是模型没打准。

因此：①`targetDurationSeconds` 与 Full Story 同规格地传进 `/api/variants`（浏览器请求体、`server.js` 入口校验、Durable `buildInput` 白名单三处缺一不可，白名单是显式构造，漏掉会让任务队列路径静默丢字段）；②`variantsPrompt` 要求 `estimatedSeconds` 合计落在窗口内，并说明这个合计会直接决定成片长度；③`fullStoryPrompt` 明确冲突优先级——**`estimatedSeconds` 不属于必须逐字承接的剧情内容**，`timeRange` 服从时长目标，允许按比例调整每拍长度但不得增删或改写剧情动作。

**那三处实际只做了两处，2026-09-09 修好（证据来自六份真实导出包）**：白名单读的是 `raw.targetDurationSeconds`，而浏览器送进 `directorPipeline` 的 `shared` 输入里**从来没有这个键**——一键 AI 导演的候选阶段因此从未收到过时长目标，只有手动点「换一批」那条路送到了，现象是「换一批有效、一键跑无效」。`variantsPrompt` 取不到目标时 `durationRule` 整段省略，**静默降级、没有任何报错**。实测：五个带 lineage 的 run 全部生成于 09-05 之后，候选 `estimatedSeconds` 合计 **20/20 落在窗口外**（原片 33 秒的写成 56-60 秒、原片 122 秒的写成 60-90 秒）；唯一 4/4 落在窗口内的那份没有 lineage、导出形状也不同，四个候选精确等于窗口下界——像是拿到指令后贴着下界写（路径不同是推断，未核实）。修复是 `public/app.js` 的 `runWorkflow()` 补上这个键，`test/story-duration.test.js` 用源码断言锁住三处调用点，撤掉修复即失败。三处都是对象字面量，漏掉任何一处都不会有运行时错误，只能靠测试守着。

**同一批数据修正了上一段的一处措辞**：那句「候选 `estimatedSeconds` 的合计**事实上决定成片长度**」描述的是 ③ 落地**之前**的行为。③ 生效后 Full Story 服从时长目标——六份包里成片跨度 **6/6 精确等于 `Math.round(原片时长)`**（65/122/44/44/65/33），候选估的 46–90 秒被整体忽略。所以合计不再决定成片长度，但它**决定同一批动作要被塞进多长的时间**：60 秒大纲压进 33 秒、或摊到 122 秒，都是同一份动作链换了密度。压缩那一侧正是 `docs/待解决项.md` 第 1 条「单场动作过载」的上游——镜头骨架由场次 `timeRange` 确定性派生，定向修订在架构上救不了它。**这仍然不构成加校验器的理由**，与下一段一致：模型不听提示词是生成质量问题。

窗口比例（±15%）与取整方向（下界 `floor`、上界 `ceil`）只有一份，在 `public/story-duration.js` 的 `storyDurationWindow()`，两处提示词与变体卡片判色共用；`storyOutlineTotalSeconds()` 同理。**禁止在提示词、浏览器或校验器里各自再写 `0.85` / `1.15`。**

**仍然不加校验器**，与本节上一条一致：模型不听提示词是生成质量问题。变体卡片新增的合计时长徽章（绿色=在窗口内、橙色=超窗）是**纯展示**，不进 Artifact、不参与派生、不进 digest、不 stale 任何东西。不传目标时 `variantsPrompt` 与 `mockVariants` 都逐字保持历史行为（mock 合计仍为 44 秒）。已签发的旧变体 `estimatedSeconds` 不会改变，只能靠 ③ 的优先级声明兜底，而那同样没有确定性兜底。

**原片空间与对白密度投影（2026-09-01）**：`fullStoryPrompt` 从 `sourceScriptReconstruction` **现算**原片的地点数、时长、每 10 秒地点密度与带对白场次比例，作为本片的靠拢目标，**不写死任何数值**——换参考片自动跟着变。起因是实测过冲：要求 `visualPotential` 写主角身体动作后，模型给每个动作配了一个新地点，44 秒六场六个地点（1.36/10 秒），而原片《打枣》44 秒只用两个地点（0.45），六场大动作全在同一个院子里完成。提示词明确「换的是动作和机位，不是地点」。对白同理：原片 6/6 场带对白，密度不低，短在**每句都不承担剧情推进**——因此不要靠减少对白显得克制。提示词里写死的举例（铁锅头盔、听收音机）已标注「来自另一部参考片，只示范判据，不要照抄内容」。

**生活质感硬约束（2026-08-29）**：至少 2 场的 `visibleAction` 要包含一个**与主线任务无关或只有半相关**的生活动作或环境道具；至少一处萌点必须是**幅度大到一眼能看见的身体动作**，且**必须由固定主角本人完成**并**同时承担剧情功能**。**皱眉、歪头、眨眼这类微表情不算，宠物舔爪子、打呼噜同样不算**——前者幅度太小，后者是环境细节不是主角萌点。功能性判据看原片的铁锅头盔：前因（刚被提醒会被砸）、环境（院子里本来就有锅）、人物（她会用笨办法）、声音（枣砸锅上）、视觉（轮廓变滑稽）、后续（戴着继续捡枣）六条同时成立。自查：删掉这个萌点剧情会不会缺一块。候选阶段同步收紧 `visualPotential`——**至少一条必须是固定主角本人的身体动作**，三条全写质感、痕迹、光影、并置这类画面状态即不合格。依据是实测：一份 `visualPotential` 全是静物的候选，展开后六场全是桌前微表情，Full Story 再加约束也救不回来；模型还会把萌点要求满足在宠物身上绕开。自查方法：这个动作放进四秒镜头、不看脸只看身体轮廓，观众能否认出在做什么。原片质感来源（`retentionDrivers` 的观看动力与兑现、`observedFacts` 里 `visible_object` 的环境道具、`shotRhythm.shotPatterns` 的景别构成）提成具名投影，与对白风格投影同规格——数据一直在 `referenceAnalysis` 里，此前只埋在整份 JSON 中、无任何指令让模型对齐。依据是实测对照：原片萌点是「把铁锅扣头上当头盔」这类大动作、氛围来自「趴桌听收音机」这类与主线无关的细节，而生成的一份六场全是桌前微表情。**这些是 Prompt 生成约束，没有确定性校验兜底**——判断动作够不够萌、细节算不算生活化需要语义判断。

**注意这一节只约束动作的「类型」，不约束单场动作的「数量」，而后者已被实测证明是个真问题。** 镜头骨架由 `deriveDirectShotSkeleton()` 从场次 `timeRange` 确定性派生，所以**一场戏写多满，下游镜头就有多挤，而定向修订在架构上救不了它**——它只能改 7 个可写字段，动不了时长、也不能拆场。实测：某片 S3（12 秒）的 `visibleAction` 塞了约 14 个动作，终审判它「动作链过长」却又给它派了 7 个新增，修订两次都腾不出位置，fail closed。详见 `docs/待解决项.md` 第 1 条，**那里也记着已经走死的几条路**。

对白质量硬约束：**禁止复述同场 `visibleAction` 里观众已经能直接看见的信息**（自查方法：遮住这句台词只看 `visibleAction`，观众不会漏掉任何信息就说明它在复述），禁止用旁白式台词直接播报人物内心，**禁止任何角色把本片主题、意义或感悟说出来**（结尾最易犯，总结型台词一律删掉让画面收尾）。**对白信息密度必须对齐 `referenceAnalysis.dialogueStyle`**——该字段过去只埋在整份 JSON 里、提示词从未提及，实测后果是原片密度为「低」（台词只承担关系、末场无对白）而成片让配角用三句台词分别扛起冲突、转折与主题；现已提成具名投影并要求对齐。能靠表情、动作、停顿、眼神和道具互动表达的内容优先不写成台词；宁可一场戏没有对白，也不要用台词解说画面。`dialogueStyleGuide.forbiddenDialoguePatterns` 必须至少列出「复述画面已有信息」「台词直接播报内心」「角色说出本片主题或感悟」三条。这些是 Prompt 生成约束，**没有确定性校验兜底**——判断一句台词是否在复述画面需要语义判断，写死词表会误伤合法的反应性台词。

**JSON 引号契约（2026-08-30）**：`JSON_ONLY`（`src/prompts.js`）被 **10 个阶段提示词共用**，其中一条是「字符串值内部不得出现半角双引号；引用词句用「」或单引号；上游文本里的全角引号“”必须原样保留，不得改写成半角」。它讲的是 JSON 序列化本身，**不是 Full Story 的局部补丁**，Analyze / Reconstruct 同样要把带引号的原片字幕转抄进字符串值，禁止把它挪进某个阶段正文。

依据是 2026-08-30 的字节级取证：当天 20 次 Full Story 调用只有 8 次产出可解析 JSON，12 次以 `finish=length` 截断，每次烧满 16384 输出 token、耗时 214–284 秒。12 次的退化段起点全部落在同一字段同一偏移（约 490）——模型把 `creatorProfile.constraints` 里的全角 `“谢谢、再见”` 抄进 `characterBible.protagonist.speechRules` 时吐成了未转义的半角 `"`，当场闭合字符串，随后在 `:"",  ":"` 上重复到上限。08-14→08-29 留存的 99 份输出全部可解析，其中 41 份自发用单引号、2 份用全角引号、**0 份用裸半角**；这条规则只是把已被验证有效的写法显式化。**不要求模型写 `\"` 转义**——转义正是它失败的那个动作，换一个没有 ASCII 同形字的字形才能从源头消除危险。

**「为什么偏偏是当天」没有查出来**：危险字符（`constraints` 开头一个孤立半角 `"`、两对全角 `“”`）自 08-25 起逐字不变而此后 99/99 成功，当天唯一的 `constraints` 改动与断裂点无关；最可能是上游模型服务行为漂移，本地不可控。因此修复针对机制而非触发源。同样**没有确定性校验兜底**——无法在生成前预判模型会吐哪种引号；断裂的输出本来就解析失败、fail closed，没有错误数据能流到下游。

`characters` = **本场实际出镜角色**，不是被提及的人、地点名称、道具归属或回忆对象。

```
"铃木奶奶站在院子里浇花"  → characters: ["铃木奶奶"]   ✅
"铃木奶奶家的门口"        → 不能认为铃木奶奶出镜        ❌
"空院子里的雨水落进水缸"  → characters: []             ✅
```

**「出镜」只看画面里能不能看见，与远近和主次无关（2026-08-30）。** 远景里弯腰翻晒谷子的奶奶、背景中路过的行人、屋檐下不说话的老人，都必须写进 `characters`。实测反面例子：`visibleAction` 写「远处，奶奶正弯腰用木耙翻晒金黄的谷子」，`characters` 却只有主角和宠物——同一轮连续三次 `FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING` 都是这一个误解，模型把远景背景人物当成了不出镜。此前提示词只反复讲画外音那一种情况，从没说过「站得远也算出镜」。

**反过来：可见事实字段里不得出现不在画面里的角色名（2026-08-31，取代原「三种豁免」）。** `visibleAction` 与 `shotAndSound` 写进一个名字，就等于声称这个人在画面里，**没有例外**。原先列的三种豁免（地点归属称呼、只被提到、回忆转述）不再是豁免，而是必须改写成不带名字的写法：画外声音不带主体（「屋外传来喊白子回家的声音」/「一个苍老女声的呼喊」）、道具只写可见特征（「贴着手写标签的快递盒」）、地点归属称呼放进 `location`（`location` 照写「李奶奶家门口」，`visibleAction` 只写「小白子站在木门前」）。**去掉的只有名字，不是可见细节**——「一个快递盒」不合格。名字在 `location`、`dialogue[].line`、`beatSheet`、`characterBible`、`shootingNotes` 里都可以自由出现，扫描只覆盖那两个可见事实字段，所以信息实际上不丢；`shotAndSound` 更是压根不进 Animation 阶段的场次投影。

**第四种写法：屏幕上的文字（2026-09-06）。** 片尾卡、字幕、招牌、门牌、快递单里的角色名同样要去掉——不写「黑屏浮现白色文字『继续加油~ 小白子！』」，写「黑屏浮现一行白色发光文字」，卡面原话按上面的既有路由进 `shootingNotes`。裸子串匹配分不出这三个字是「画面里站着一个人」还是「屏幕上要渲染的字形」。**两个字段都适用**：实测模型 22:21 在 `visibleAction` 被拦，22:26 把引文挪进 `shotAndSound`、`visibleAction` 改干净，又被同一条规则拦住——它读懂了规则并照做，只是没有第三个地方可去。前三条范式一条都不覆盖这个形状，所以补第四条。

**参考片的片尾署名字幕卡是来源表达，不是必须复用的构件。** 成因在提示词构造：`fullStoryPrompt` 把**整份** `referenceAnalysis` 与 `sourceScriptReconstruction` `JSON.stringify` 进提示词，模型因此逐字读到《明天》的片尾卡（analysis `observation`「黑屏显示文字「⋯⋯继续加油~ 咕嘎！」」）并照抄，只换名字。它撞的正是同段已有的「允许不等于必须使用：不得因为来源上下文列出了这些表达，就机械把它们补进 `visibleAction`/`shotAndSound`」——**这是把已有抽象规则具体化，不是新增禁令**：用最后一场的画面收尾；`sceneScript` 凑不满 6 场时把某一拍展开成两场戏，**加一张文字卡不算一场戏**（选中候选只有 5 拍是本次助因）。规模已测量：现存 25 份可解析候选中，《明天》两个 run **5/5** 带卡，其余 8 个 run **0/20**；五份带卡的全部 6 场、末场 `characters: []`，四份写了名字判失败，第五份写「明天也要加油哦～」不带名字则通过——**名字是唯一触发点**，且这张卡并不承接自候选（候选末拍本来就是画面结尾）。**没有确定性校验兜底**：判断一段文字属于「屏幕文字」还是「画面里的人」需要语义判断，写死词表会误伤合法写法（§5 第 2 条）。校验器逐字未改，已失败的候选重放后仍然失败。

**归属称呼放进 `location` 之后不要再抄进 `visibleAction`，而 `location` 本身必须保留归属（2026-09-02）。** 实测卡住的写法是：`location` 写「奶奶的客厅」，`visibleAction` 跟着抄成「小白子和芙芙猫在奶奶的客厅里玩」，而奶奶在卧室睡觉、根本没出镜——抄过去就等于声称她在画面里。**`location` 不在扫描范围内，它从来不是失败原因**：实测 `location`「奶奶的客厅」+ 干净 `visibleAction` 直接通过。

因此不要靠「`location` 也不许写归属」来消除这个诱因。`location` 是唯一能区分同类空间的字段：Animation Foundation 被要求「相同地点应复用同一个 `sceneId`……不同地点不得错误合并」，判断依据只有 `location` 与 `visibleAction`，后者按上面的规则不许写归属。两个不同的院子都写成「院子」会被合并成同一个 LOC、共用一套场景参考，**且没有任何校验器会报错**——那是拿一个响亮的硬失败换一个静默的错误合并，与第五节第 4 条「隐藏错误」的方向相反。回扫 124 份历史故事：62% 的 `location` 带归属，剥掉后 2.4% 出现真实碰撞（「院子」← 小白子家院子 / 小禾家院子；「门口」← 爷爷家门口 / 奶奶家门口）。另有 2 次 live 探针显示模型本来就写对了（`location`「李奶奶家门口」+ `visibleAction`「小白子站在木门前」），所以这是个别失败，不是规则失效。

这条**让现有校验器变正确，而不是让它变聪明**——裸子串匹配（`literalContractTextIncludes`）恰好就是这条规则的判据，永远不需要语义判断。依据是 2026-08-31 取证：契约从 08-30 起承诺那三条豁免，扫描却一条都没实现，回扫 180 份可解析历史输出，`FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING` 命中 45 条，**约三分之二是模型照提示词写了合法文本反被判失败**（17 条写在物件上的名字、5 条地点归属称呼、1 条画外声音、1 条他人转述，另约 6 条散在「其它」里）。

**曾短暂存在过一个 `nonVisualMentions` 登记字段，已删除，不要重新引入。** 它让模型逐字摘出非视觉提及来换豁免，问题是它连 `visibleAction` 一起豁免——而本节自己写着「登记只豁免 `shotAndSound`」是这套机制不沦为免检后门的唯一原因。上线后三次真实调用**全部**拿它登记离场动作（`mentionExcerpt: "奶奶回屋拿更多被子"`），只因为模型是从 `beatSheet` 抄的摘录、比 `visibleAction` 少一个「转身」，才被逐字核对拦下；照 `visibleAction` 抄就会全部放行。`offscreenSoundSources` 保留——它只豁免 `shotAndSound`，是安全的那个不对称，降级为「名字实在去不掉」时的兜底。

**离场不单独做机制，它是同一条纪律的另一个触发点。** `characters` 是本场的**选角声明**，`visibleAction` 不能演一个没选的角色。三条出路：①确实露了脸（哪怕只是转身走开的背影）→ 写进 `characters`；②想让他不在这一场 → **写离场的结果，不写离场的动作**（不写「奶奶转身回屋拿更多被子」，写「木门在身后合上，晾衣绳边只剩下小白子」）；③这个动作属于上一场 → 挪到上一场结尾。

前三版提示词都在跟模型争「她算不算出镜」，**七次调用、三个提示词版本，一次都没让步**：加「离场也算出镜」后 `prompt_tokens` 14096→14243 证明新文本确实送达，同一句照样失败，其中一次模型还在 `shotAndSound` 写了「中景展示奶奶离开的背影」——它知道她在画面里。第四版改成承认模型意图并直接给替代写法，**但没有把握**，失败仍是响亮硬失败。**不得给它挂自动纠错**：校验器只证明「名字出现了」，正解有两个（她真在画面里 → 补进 `characters`；她不在但文本写错了 → 改文本），推导不唯一，猜错就是凭空签发一条视觉事实、让下游把人渲染进画面。

**空数组是无人场次的正确值，不是错误。** 空院子雨水、屋外烟囱远景、桌面道具特写、城市建立镜头、角色离开后的空镜、纯转场环境镜头都合法；禁止空数组只会逼模型硬塞一个没出镜的角色，反而污染这个字段。放开不打开缺口——真正出镜的标准角色仍被 `visibleAction` 扫描抓住，有对白的场次仍被说话人校验抓住，两者都不猜「这句话里有没有人」。空镜场次照样可以有 `visibleAction`、`shotAndSound` 和 `offscreenSoundSources`。

唯一新增的兜底是故事级的：**所有场次的 `characters` 全为空时抛 `FULL_STORY_NO_VISIBLE_CHARACTER_SCENE`**（path `fullStory.sceneScript`）。单场空镜合法，整片没有任何角色出镜则不成立；`ensureFullStoryMatchesProfile` 只查整个 JSON 含不含固定角色名，`characterBible` 里有名字就能通过，兜不住这一条。

**`offscreenSoundSources`（可选数组）= 本场只以声音出现、明确不出镜的角色名。** `shotAndSound` 一条自由文本里同时承载画面描述（可能出镜）与声音来源（不代表出镜），程序无法也不得靠正则或词表区分，因此改为要模型**显式登记**。语义边界：

| 字段 | 含义 | 扫描口径 |
| --- | --- | --- |
| `visibleAction` | 可见主体事实的唯一字段 | 只认 `characters` |
| `shotAndSound` | 画面 + 声音混合描述 | 认 `characters` ∪ `offscreenSoundSources` |

- **登记只豁免 `shotAndSound`，绝不豁免 `visibleAction`**——这条不对称是整个机制不沦为免检后门的唯一原因：实际参与本场的人物必须写进 `visibleAction`，藏了会在那一档被抓，不写就等于承认没出镜。
- 同一名字同时出现在 `characters` 与 `offscreenSoundSources` → `FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE`，明确失败不选边。
- 登记了但 `shotAndSound` 没提到该名字是**合法的**：登记本身不产生视觉事实。
- 名称精确性与 `characters` 共用一份判定（`FULL_STORY_SCENE_CHARACTER_NAME_INEXACT`），禁止另建第二套词表。
- 该字段**不在**局部纠错可写范围内，Beat–Scene postpass 也必须逐字冻结它。`dialogue[].speaker` 语义不变，仍必须逐字存在于同场 `characters`；画外声音只描述在 `shotAndSound`，不编码成 `dialogue` 条目。
- 旧 Story 不带该字段时行为逐字不变（strict schema 里它不是 required）。

`location` = **本场实际发生的可拍摄物理地点**，不是画风、光线或色调。垂直赛道里出现的风格词不得流进 `location`——视觉风格由下游 Animation Plan 的 `visualBible` 统一签发，在 Full Story 重复它会让每场地点看起来一模一样，反而丢掉地点信息。

```
vertical: "治愈/日常/日系 2.5D 新海诚光景"
→ location: "集市旁草地"                          ✅
→ location: "日系2.5D新海诚光景风格的集市旁草地"   ❌
```

该约束写在 `fullStoryPrompt` 硬约束里，**没有确定性校验兜底**：判断一个词属于地点还是画风需要语义判断，写死词表会误伤「日系村落」这类合法地名，而 Full Story 失败的代价很高。上游 `sourceScriptReconstruction.scenes[].location` 不受此约束影响，它本来就只写原片观察到的地点。

角色一致性禁止项：自动新增未登记主要角色、修改 variant 中已有角色身份、修改 `careRecipient`、修改 `protagonist`。任何角色变化必须明确登记、明确理由、明确影响范围。

### 2.11 职责隔离

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Full Story | 叙事结构、角色、场景、对白、剧情逻辑 | 镜头动画实现、动作生成、视频生成 |
| Animation Plan | 直接视频渲染提示词、角色动作与内部摄影/剪辑与声音设计、镜头连续性与动画约束 | 拆镜（3.1 起镜头由 Full Story 场次确定性映射）、重新创作剧情、修改角色身份、改变故事主题 |

Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：**暂时弃置**，旧 v2 代码保留兼容但不参与当前 `direct_shot` 主流程。

### 2.12 状态隔离

所有新功能必须继续考虑：`variant`、`story revision`、`plan revision`、`request id`、`media namespace`、`digest`。

**禁止**只用 `variant.id`、`shotId`、`timestamp` 作为唯一身份——这会导致旧 Story 污染新 Story、旧视频覆盖新视频、异步请求回写错误版本。

- Variant 内容变化必须**递归**使旧 Full Story、Animation Plan 和媒体 Artifact stale。
- 模型请求开始时冻结依赖 revision，返回时同时经过浏览器 request token 与服务端 `expectedCurrentRevision`/dependency 校验。
- Animation Plan 每个 revision 签发独立 media namespace。
- 用上一镜抽帧生成的后镜 `shotVideo` Artifact 必须**同时**依赖当前 Animation Plan 与上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选必须递归 stale 下游视频。切换后镜自身候选时保留既有媒体依赖。
- 浏览器中的 `shotVideoResults` 与旧 v2 `shotFrameResults` 都必须按 **variant + shotId** 隔离，禁止只用 `A01` 作状态键；单个媒体 stale 只移除对应结果，不清空其他 current 媒体。

---

## 三、模型内容纠错边界（fail closed 优先）

**已经解析为候选对象的模型内容错误，绝不允许通过"把完整失败 Artifact 发回模型要求整包重写"来恢复。**

只有同时满足以下条件，才允许签发**一次**有界局部纠错：validator 输出稳定 `code + RFC 6901 JSON Pointer + reason`、候选完整、目标已存在、事实来源唯一、对应 stage adapter 明确授权。

没有可信 diagnostics、没有唯一权威、整个对象/数组项丢失、候选非对象、adapter 不支持时 → **必须 fail closed**。不得解析人类错误消息猜 path，不得自动扩大可写范围。

### 当前四个 adapter 与覆盖范围

| 协议 | 覆盖 |
| --- | --- |
| `full_story_partial_repair/1.0` | 仅 protagonist `name` 缺失/类型错误/空字符串，且验签边界提供唯一姓名 |
| `artifact_partial_repair/1.0` | Animation Foundation 唯一固定角色参考的 `requiredTraits` 缺失/禁止特征命中 |
| `animation_video_prompt_semantic_repair/1.0` | 证据绑定审计确认**全部结构化 shot facts 通过后**的纯 `videoPrompt` 实质冲突 |

### 通用协议约束

- 服务端**独占**私有签发身份、`baseDigest`、authorityDigest、repairId、目标 path、mutablePointers 与 authority。模型取得的序列化计划不能作为可合并计划。
- 第二次模型请求只发送：目标 currentValue、diagnostics、修复说明、最小权威投影。
- 模型只能返回等量、同序 `{repairId, replacement}`。**不得返回 path、op、完整 Artifact 或额外字段。**
- 服务端必须在 clone 上原子合并，证明目标内未授权事实与全部目标外数据不变，重新投影并验证当前 authority，然后**从头执行该阶段完整 Schema、角色、剧情与跨字段校验**。
- 语义 Prompt 修复另允许且**只允许一次**相邻镜头复审；复审失败即终止，不得再次修复或整包 fallback。
- Foundation 仅缺必需事实时必须冻结 `appearancePrompt` 和已有 `consistencyTags`，只能在标签尾部按签发顺序追加缺失 trait 的 exact `canonicalName`，不能用同义词、重排或改写外观代替。禁止词诊断只授权实际命中的字段做最小删除；**否定语境放行**（「无翅膀、无企鹅服装」是否定约束，不算使用），删除时须连同紧邻否定词一并剥离，否则会留下「无、无」孤儿否定，使合法的最小删除无法通过守卫。
- 结构化 `characterAction`、`cameraMotion`、`continuityNotes` 或其他 shot fact 与高层权威冲突时，**不得借修 Prompt 掩盖，必须明确失败**。
- 唯一的再取证例外：`referenceAnalysis` 原生视频候选仅因 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧时，丢弃该候选并用既有 frames 重取一次——不发送失败 Artifact，不属于 repair。
- 网络、鉴权、429、timeout、lineage stale、签名失效**都不是内容 repair**。旧 v2 首尾帧兼容路径的历史整批 retry **不能**用来解释当前行为。

### Legacy Full Story Beat–Scene 提交前复核

与失败候选 repair **严格分离**。只能在初轮候选（含已用掉的唯一 retry 或 protagonist `name` 局部纠错）通过 exact Schema、Scene Contract、固定角色/Profile、Variant 与既有语义边界的完整校验**之后**执行；失败候选不得借此补写正文。

- 使用同一已选文本 provider/model；第二次请求只包含这份完整合法的 Full Story JSON 与专用复核提示，**不得**再次上传 `creatorProfile`、Theme Variant、Creative Brief、Visual Guardrails、`referenceAnalysis`、Reconstruction 或其他边界/变体数据。
- `beatSheet` 在复核中是**只读**叙事目标。无明显遗漏必须返回 unchanged。
- 唯一可写范围：把受信 `addition` **append** 到已有 `sceneScript[i].visibleAction` 末尾，原值必须保持为逐字前缀。`addition` 必须是对应 `beatSheet[beatIndex].storyAction` 中一段**连续、逐字相同**的原文，且必须包含该 review 逐字返回的 `beatEvidence`；证据只能引用该 `storyAction` 与目标/相关场次现有 `visibleAction`。
- 配额：一次最多补 **3** 个已有场次，每条 addition ≤ **600** 字，合计 ≤ **1200** 字。
- 其余全部冻结：场次数量与顺序、`sceneId`、`timeRange`、`location`、`characters`、对白、`shotAndSound`、`emotionNode`、`dramaticFunction`、`shootingNotes` 及 `sceneScript` 外全部字段。
- 无法逐字投影必须返回 `blocked`，禁止概括、改写、拼接不连续片段或自行补写。
- `blocked`、协议错误、供应商错误、越界 diff、非追加式改写、最终完整复验失败 → **fail closed**：不保存原候选作为 fallback，不发起第二轮复核，不扩大为整包重写。
- Provider call 预算：正常 **2** 次（初轮 + 复核）；初轮消耗 retry 或局部纠错时最多 **3** 次，**禁止第四次**。
- 初轮候选、复核响应、合并中间态都不是 Artifact / revision / Checkpoint / 第二份 Story 事实源。该 postpass **不扩展** partial-repair adapter，也不是 Full Story v2 / Canonical Story / 通用 Auditor。

### Debug 观测 sidecar（三套，互相隔离）

| 环境变量 | 内容 |
| --- | --- |
| `PARTIAL_REPAIR_DEBUG_DIR` | 已成功签发 repair plan 后的四阶段记录（trigger / prompt / response / result），单文件默认 ≤ 256 KiB |
| `FULL_STORY_MODEL_OUTPUT_LOG_DIR` | Full Story primary / retry-repair / Beat–Scene postpass 的完整 completion `content`，metadata 含 `stage` |
| `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` | Animation Plan 原始 completion，固定 `scope=animationPlan`，覆盖 Foundation、每批 shot、实际发生的语义修复与复审 |
| `STAGE_MODEL_OUTPUT_LOG_DIR` | 十个阶段（Analyze / Reconstruct / 创意简报 / 主题变体 / 候选对照评审 / 角色与表达边界 / 人物参考精修 / 剧情体检 / 分镜终审 / 定向修订）的原始 completion，按 stage 分 scope；成功与失败都记，失败判定复用 `classifyAttemptError`。前九个共用 `generateValidatedJson`，注册 scope 即生效；**定向修订走 `modelCallCoordinator`，由 `createAnimationPlanRevision` 自己接 `attemptObserver`**，两次 provider 调用各留一条。**scope 取值必须逐字等于 stage 名**——writer map 按 scope 建、按 stage 查，对不上就静默不写（2026-09-07 之前后三个阶段根本没注册，终审失败时原文永久丢失） |

统一约束（第四套与前三套逐字同规格）：

- **只写**目标 currentValue、结构化 diagnostics、最小 authority、拒绝原因、模型 completion content。**禁止写入**完整 Story/Foundation/Animation Plan（partial-repair 记录）、请求 Prompt、原始 HTTP envelope、Header、API Key、Cookie、Data URL、Base64 媒体。
- 没有签发 plan 时不得创建 repair 记录；未发生的 repair 不得伪造记录。
- 目录位于 `public/` 时必须禁用；文件权限必须私有并原子写入。
- **必须 fail-open**：写入失败只输出脱敏告警，不得改变 repair/postpass 的成功失败结论、不得增加模型调用、不得回退保存 raw、不得改变 validator/Plan commit/错误文案/重试预算/lineage。
- 这些文件**不是** Artifact、Production Lineage、业务事实来源、恢复数据或导出包内容。

---

## 四、修改流程

### 第一步：确认现状

必须实际检查：当前 git HEAD、文件是否存在、当前调用链、当前测试覆盖。

**禁止**：根据旧聊天记录判断代码状态；根据文件名推断功能存在；根据 TODO 推断已实现。

### 第二步：证据分层

明确区分并写出来：已确认事实 / 当前既有契约 / 推断 / 尚未确认的问题 / 新提出的架构决定。

同时明确：相关字段**由谁生成**、**由谁消费**、**哪个字段是权威事实来源**、**冲突时的优先级**、**至少一个合法反例**。

若事实来源、字段语义或冲突优先级尚未明确：

- 不得修改生产代码；
- 不得新增自动覆盖、自动同步或默认值恢复；
- 不得在冲突中选择任一字段作为真相；
- 应继续只读调查，或明确请求架构决定。

> 两个模型输出字段发生冲突，只能证明数据不一致，**不能证明其中某一方正确**。
> 自动修复只有在正确值能从权威上游**唯一推导**、且不会删除合法信息时才允许实施。

### 第三步：明确修改范围

计划必须说明：① 改哪些文件 ② 为什么改 ③ 是否改变数据结构 ④ 是否影响已有流程 ⑤ 如何验证。

优先小步：**增加校验、增加隔离、增加测试、增加边界**。避免大规模重写、替换整个流程、重新设计全部模型。

### 第四步：实施中的止损

出现新证据推翻原假设时**立即停止叠加补丁**，返回根因调查。**不得用第二个修复掩盖第一个修复。**

### Bug 修复流程

```
复现 → 确认调用链、字段职责与事实来源 → 定位能解释全部现象的根因
     → 检查合法反例 → 设计最小修复 → 增加测试
     → 回放原始失败数据 → 验证完整流程
```

涉及模型输出时，还必须回放原始失败数据并验证至少一个合法反例。

**禁止**：看到错误日志就直接改提示词。

---

## 五、绝对禁止

1. 为了通过测试**降低校验标准**。
2. 增加**关键词白名单**绕过真实问题。
3. **改变字段含义**。
4. **隐藏错误**——失败时返回默认值是错的，明确报错才是对的。
5. 顺手重构 / 顺手优化 / "统一架构"（未获明确授权时）。

### 5.1 供应商错误码提示（`src/provider-error-codes.js`）

把供应商返回的错误码翻译成可执行中文提示，是**纯展示层**：不影响是否抛错、抛什么错、重试预算或 HTTP 状态码，也不参与任何业务校验。三条硬规则：

- **只增不减**：供应商原文逐字保留在既有 `detail` 字段，解释放在新增的 `providerError` 里。用友好文案顶替原文就是上面第 4 条说的隐藏错误。
- **匹配不到就返回 `null`**，调用方回退原文。编一句「可能是网络问题」比不解释更糟。
- **码表只抄官方文档**，文件头标注每张表的出处 URL 与核对日期；供应商改表就更新这里，不得靠猜测补条目。

接入点只有三处错误出口（视频 / 图片 / 文本），全部在 `src/server-error.js`。命中依据分 `code`（供应商业务码）与 `httpStatus`（按状态兜底）两种，展示标签必须如实标明是哪一种——按状态命中时不得把响应体里那个无关的 `code` 显示成来源。这三处的 `retryable` 跟随官方文档判定。

**原文必须真的显示出来（2026-08-30）。** 按 `httpStatus` 兜底命中时，`guidance` 只能给通用建议（「检查请求参数是否符合该供应商的接口要求」），此时供应商原文是唯一可执行的信息，`providerErrorText`（`public/compiler-observability.js`）必须把 `providerError.providerMessage` 一并渲染。注意 `ModelResponseError` 分支（`src/server-error.js`）的响应体**没有 `detail` 字段**，原文只存在于 `providerMessage`——只渲染 `title`/`guidance` 会让唯一有用的那句消失。实测代价：kimi-k3 的「Parameter 'temperature'=0.3 is not supported」被吞掉，用户屏幕上只剩三句同义的「请求不合法」，只能靠翻 debug 目录才查得出来。

**按模型拒绝 `temperature` 的清单（`src/qwen-client.js`）与错误码表同规格。** `MODELS_REJECTING_TEMPERATURE` 只登记供应商实测返回的事实，标注来源与核对日期；**禁止按模型名前缀推断**——`kimi-k2.7-code` 实测接受 `temperature`，写成前缀匹配会静默改变一批模型的采样行为。命中时**只摘掉 `temperature`**，`top_p`/`response_format`/`max_tokens` 一个都不能少，否则就是借着修一个参数改变采样行为。不在清单里的模型照常发送，供应商拒绝就如实抛错，**不静默重试、不降级**。来源：2026-08-30 实测 `kimi-k3` → HTTP 400 `Parameter 'temperature'=0.3 is not supported for kimi-k3 model.`

---

## 六、当前不存在的功能

**禁止**在代码、文档或回复中认为以下功能已经存在：

- Full Story v2
- Canonical Story
- Canonical Pipeline
- 完整批量 Production Package / production workspace
- Receipt
- Canonical Provenance

当前 HEAD 确实包含独立的 Production Lineage v1、本地 Run/Stage/Artifact/Checkpoint 状态库和签名的 v3 测试/规划包——**它们不是**上述任何一项。

### `fullStoryV2` 命名说明

代码中的 `fullStoryV2`、`cast`、`registry`、`confirmation` 属于 **Phase 2 Cast / Character Governance** 或未来规划。

正确表述：Character Registry、Cast Proposal。
错误表述：Canonical Story 已接入 / Full Story v2 已实现。

---

## 七、导入导出

浏览器可导出的 JSON 分两类：普通创意 JSON，以及服务端签发的 **v3 测试/规划包**。

v3 包必须包含：schema version、digest、signature、production lineage、validation。导入时必须验证上述字段与 parent lineage 并建立**隔离的新 Run**；禁止与现态静默混合，包内旧媒体结果不得直接恢复。

它仍**不是**包含批量执行、供应商状态和完整 canonical provenance 的 Production Package。**禁止把普通 JSON 描述为"可信生产包"。**

---

## 八、测试与文档

- 修改后必须运行 `npm test`。
- 测试失败时必须说明属于哪一类：**业务失败 / 环境失败 / 测试本身问题**。不能简单忽略。
- 新增架构必须同步更新：`docs/`、`README.md`、`AGENTS.md`、本文件。避免代码与文档长期偏离。
- **待办勾选**：GitHub Benchmark 后续改造以 `docs/GitHub-Benchmark-后续改造待办.md` 为执行清单。每完成一个实施步骤，必须在同一次工作中勾选对应子项；只有验收标准全部满足才能勾选父任务，并填写完成记录。

---

## 九、优先级

| 级别 | 内容 |
| --- | --- |
| **P0**（已实现，必须保持） | variant digest、story revision、plan revision、media namespace；上游 revision 变化递归 stale 下游；request token + `expectedCurrentRevision` 双层拒绝旧异步回写；媒体目录与文件名绑定 project/run/plan revision/digest |
| **P1** | Full Story Contract：角色提及误判、临时角色漏检、`careRecipient` 漂移、variant context 绑定 |
| **P2** | 已实现导入验证、签名机制、持久化状态、媒体生命周期；**尚未实现**远端任务接管、批量队列、完整视觉 QA、成片恢复 |

---

## 最重要的原则

修改任何代码之前：**先理解系统。**

不要假设。不要扩大范围。不要为了让测试通过破坏业务约束。
优先保证 **正确性、一致性、可追踪性、可恢复性**，而不是代码数量减少、实现速度或表面通过。
