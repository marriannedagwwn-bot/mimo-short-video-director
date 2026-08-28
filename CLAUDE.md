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

Story Candidates 仍使用 `themeVariants.variants[]` wire shape，但必须通过递归 strict Schema，且只新增 `keyChoice/climax/emotionalPayoff/novelty/visualPotential` 五个候选级字段。本地校验不使用题材关键词或主观语义打分。选中候选以 current `variant:<id>` Artifact 的精确 revision/digest 绑定 Full Story，服务端在模型调用前后复验；`candidateBinding` 不进入 Prompt 或 Legacy Full Story wire shape。状态恢复只认 current Story/Plan 或明确 `variant:<id>` 记录，仅有 Theme Variants 时必须保持未选中，禁止默认 V1。当前没有 Story Selection/Blueprint/Script Doctor/Targeted Rewrite/Production Package 4.0；Phase 2 只预留「已签发 Candidate 内容 + 精确 lineage reference」接缝。

**可选叙事构件（2026-08-28）**：`characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 以及 Full Story 的 `characterBible.careRecipient` 全部从 required 降级为**可选键**。它们曾强制每个候选长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」，与 Prompt 要求的候选间根本差异直接矛盾。写了就仍必须合规（非空字符串；`careRecipient` 对象五个子字段齐全），不需要就整个键省略，**禁止输出空字符串或占位文本**。`characterSetup.protagonist`、`characterBible.protagonist` 与 `characterBible.helpers`（可为 `[]`）仍必填，固定角色锁定不受影响。

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

### 2.6 视频生成模式

| 模式 | 语义 | 可用供应商 |
| --- | --- | --- |
| `first_last_frame` | 首尾帧是精确端点 | Kling / Seedance / MiniMax H3 |
| `all_reference` | 图片/视频/音频仅作多模态参考，须至少含合法图片或视频（不能只有音频） | Seedance 2.0 与 MiniMax H3（两者消费同一条 Seedance 方言提示词） |

- 模式**只**由请求 `generationMode` 决定。**不得**根据端点字段缺失、provider、模型名或素材存在性自动推断或降级。
- 无端点的 `direct_shot` 不可用 `first_last_frame`，必须明确失败。
- `all_reference` 不得混用 `first_frame` / `last_frame`，不得把可灵 image-to-video 静默当作 Omni API。
- `continuityReferenceMode: "none" | "previous_shot_frames"` 是独立的运行时开关，**不改变也不推断 `generationMode`**，也不是 `direct_shot` Schema 字段。启用时：上一镜只由当前 Plan `shotPlan[]` 紧邻前项确定；服务端读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，用 FFmpeg 按 `t = 时长×i/4` 均匀截取 **5 张** JPEG（首帧、末帧和中间三等分点；末帧回退 0.1 秒以保证可解码）作为普通 `reference_image`，与其他图片共同受 9 图上限约束，超限明确失败。张数固定，不随镜头时长变化——3.1 把单镜放宽到 4–15 秒后，每秒一帧会让超过 9 秒的镜头直接撞上限，也会把锁角色长相的角色参考图挤出这 9 个位置。5 张同时落在 MiniMax 的免费额度内。它只增强一致性，**不能覆盖**当前 Full Story/Plan、`fixedCharacterBoundary` 或 Foundation 场景事实。
- `POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不得依据客户端自报 `animationPromptSchemaVersion` 降级为无 lineage 请求。服务端从 Plan 唯一解析 exact shot；只允许 `promptOverride` 覆盖本次媒体提示词，动作/时长/场景/声音/负面词/验收条件仍来自 Plan。输出文件名必须含不可碰撞的请求 nonce，返回前须过 ffprobe 视频流/时长校验。
- **运行时参考素材清单**：`all_reference` 模式下服务端在 `shot.videoPrompt` **之前**确定性拼一段清单，说明每张素材是什么（`buildReferenceManifestText()`，`src/shot-video-continuity.js`）。参考图以 `reference_image` 发送时不带任何文字身份，模型无从分辨哪张是角色、哪张是上一镜抽帧。**前置而非后置**，以保证 `backgroundMusicMode: none` 的禁配乐句仍是整条提示词的最后一句。
  - 清单**只能**使用受控来源枚举、Plan 权威的 `sourceCharacterName`（由 `resolveAuthoritativeShotVideoReferenceAssets` 按已签发 `characterReferencePrompts[].referenceImageDataUrl` 唯一匹配后覆写）、lineage 解析出的 `sourceShotId` 与帧数。**禁止写入 `upload` 素材的 `name`/`logicalName`**——那是原始用户文件名，是这条链路唯一的注入面，上传素材一律只写「用户上传的参考素材」。安全性来自构造，不是事后校验。
  - 它不是 Plan 字段、不改 Schema、不签发 revision、不 stale 媒体、不调模型；`sourceVideoPrompt` 保留 Plan 原值，`effectiveVideoPrompt` 与新增回执字段 `referenceManifest` 记录本次实际发送内容。`first_last_frame` 路径逐字不变。
  - 不要在这里补 `ensureCharacterPromptMatchesBoundary`：视频提示词天然多角色，走 `promptScope: "multi_character"`，而该分支在 `src/validation.js` 里**无条件短路返回空串**，加上去只是一个看起来像闸门的空操作。`server.js` 现有那道检查同理，它对视频提示词也不生效。
- **生成期间的过期复验是硬约束**：服务端把复验回调交给 `generateShotVideo`，生成器必须在①任何供应商调用与文件写入之前、②每条候选提交供应商之前、③每条候选落盘并通过 ffprobe 之后、④组装返回值之前各执行一次，**覆盖全部供应商**，禁止按 provider、模型或提示词方言设门（历史上只有已下线的 H3 路径复验，那是缺陷不是设计）。任一次失败即 fail closed：删除本次已写入的全部候选 mp4，`ProductionStateError`（409）原样上抛，禁止包装、禁止保留产物、禁止降级为成功。清理只删本次调用自己算出的含 nonce 路径，禁止扫描目录；旧 v2 首尾帧 PNG 文件名不含 nonce，不在覆盖内。只有过期触发清理——供应商错误与 ffprobe 失败维持既有语义。浏览器的事后关卡与它是叠加关系，不能用来解释复验缺失。

### 2.7 模型 provider 边界

工作流 LLM provider：**Qwen / MiMo / DeepSeek**。

DeepSeek **只允许**用于纯文本阶段：Brief、Variants、Legacy Full Story、Animation Plan、Static Frame Compiler（仅旧 v2 兼容路径）。

**禁止** DeepSeek 用于需要图片或视频输入的阶段：Analyze、Reconstruct、Visual Guardrails、Character Reference。

DeepSeek 模型 ID 只登记 `deepseek-v4-flash`（页面首选）与 `deepseek-v4-pro`（只能显式选择）。不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。

确认 Profile 改写**必须使用已配置的实时文本模型**；demo mock 不得伪造语义审计结果或生产 Profile。

### 2.8 全局角色边界

- `Visual Guardrails` 是固定角色语义的**唯一生成阶段**。允许视觉模型结合用户设定、参考分析、脚本还原、创意简报与模型常识生成开放语义边界；**不得新增本地物种关键词字典替代模型判断**。
- 服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、视频生成，以及旧 v2 兼容路径的**唯一**固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份边界。
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

对白质量硬约束：**禁止复述同场 `visibleAction` 里观众已经能直接看见的信息**，禁止用旁白式台词直接播报人物内心。能靠表情、动作、停顿、眼神和道具互动表达的内容优先不写成台词；宁可一场戏没有对白，也不要用台词解说画面。`dialogueStyleGuide.forbiddenDialoguePatterns` 必须至少列出「复述画面已有信息」和「台词直接播报内心」两条。这些是 Prompt 生成约束，**没有确定性校验兜底**——判断一句台词是否在复述画面需要语义判断，写死词表会误伤合法的反应性台词。

`characters` = **本场实际出镜角色**，不是被提及的人、地点名称、道具归属或回忆对象。

```
"铃木奶奶站在院子里浇花"  → characters: ["铃木奶奶"]   ✅
"铃木奶奶家的门口"        → 不能认为铃木奶奶出镜        ❌
"空院子里的雨水落进水缸"  → characters: []             ✅
```

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
| `STAGE_MODEL_OUTPUT_LOG_DIR` | 共用 `generateValidatedJson` 的六个阶段（Analyze / Reconstruct / 创意简报 / 主题变体 / 角色与表达边界 / 人物参考精修）的原始 completion，按 stage 分 scope；成功与失败都记，失败判定复用 `classifyAttemptError` |

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
