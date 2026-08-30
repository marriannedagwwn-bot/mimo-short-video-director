## 项目身份

项目名称：

mimo-short-video-director

项目定位：

AI 短视频生产工作流系统。

目标：

将输入视频/创意素材转换为：

视频分析
→ 剧情理解
→ 创意重构
→ Visual Guardrails
→ Story
→ Animation Plan（direct_shot）
→ 视频生成
→ 导出生产数据

当前系统重点是保证：

- 剧情一致性
- 角色一致性
- 镜头连续性
- AI 输出可验证性
- 生产流程可恢复性


---

# 1. 当前架构事实（必须遵守）

## 当前主流程

当前运行流程：

Analyze
 ↓
Reconstruct
 ↓
Brief
 ↓
Visual Guardrails
 ↓
Story Candidates（`themeVariants` wire name）
 ↓
Legacy Full Story
 ↓
Animation Plan direct_shot（promptSchemaVersion 3.0）
 ↓
Video Generation

上述业务 JSON 之外，Production Lineage v1 作为服务端 sidecar 运行：每次浏览器主流程创建独立 project/run；各成功阶段提交 Artifact revision、content digest、实际上游 dependencies、Stage 状态与 Checkpoint。它不改变模型字段含义，也不是第二份角色或剧情事实来源。

Variant 内容变化必须递归使旧 Full Story、Animation Plan 和媒体 Artifact stale。模型请求开始时冻结依赖 revision，返回时同时经过浏览器 request token 与服务端 `expectedCurrentRevision`/dependency 校验。Animation Plan 每个 revision 签发独立 media namespace。

`themeVariants` 保留原 wire shape 和 Artifact 名称，但 `variants[]` 已升级为递归 `additionalProperties:false` 的严格 Story Candidates。原有字段保留，只新增五个必填非空候选级字段：`keyChoice`、`climax`、`emotionalPayoff`、`novelty`、`visualPotential`；禁止在此阶段增加 Full Story、`characterBible`、`sceneScript`、`shotPlan` 或镜头级数据。确定性校验只负责严格字段、非空数组、唯一 id、Beat 连续编号与必填内容、固定主角，以及**任意两个**候选的 `dramaticFunction` 序列 + `keyChoice` + `climax` + `emotionalPayoff` 签名都不同。禁止用老人、下雨、礼物等题材关键词判断分化，禁止本地代码裁决选择是否有意义或情绪是否成立。

**可选叙事构件（2026-08-28）**：`characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 是**可选键**，不是必填位。此前它们全部 required，等于强制每个候选长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」，与本阶段要求的候选间根本差异直接矛盾——模板由容器签发，模型无法绕开。现在：写了就仍必须是非空字符串，不需要就整个键省略，**禁止输出空字符串或占位文本**。`characterSetup.protagonist` 仍必填，固定角色锁定语义逐字不变。Prompt 另加一条批次约束：`count` 个候选里最多 2 个可以同时写出 `careRecipient` 与 `helper`；该约束只在 Prompt 层，没有确定性校验。

**结构自由度（2026-08-28）**：`storyOutline` 由「恰好 6 拍 + 固定相位词表『钩子、障碍、关键选择、后果、高潮、兑现』+ `keyChoice`/`climax`/`emotionalPayoff` 钉死在 Beat 3/5/6」改为 5–7 拍、`phase` 由候选自己命名（**禁止**套用那套固定词表，也不得全组共用同一串 `phase`）。关键选择拍与高潮拍落在第几拍由候选自己的因果结构决定，只保留因果序约束：关键选择拍 < 高潮拍 < 最后一拍。Prompt 另要求两拍之间隔一拍写该选择的直接后果、且高潮拍不得首次引入决定性人物、物品、地点、线索或能力，这两条只作生成约束，不由校验器硬裁。拍数本身即为一种合法的结构分化。**关键拍号与服务端派生投影（2026-08-28，取代逐字投影校验）**：`keyChoice` / `climax` / `emotionalPayoff` **由服务端从 `storyOutline` 确定性派生**，模型只输出两个整数拍号 `keyChoiceBeat` / `climaxBeat`；`emotionalPayoff` 恒取最后一拍，不需要拍号。模型回显这三个字符串时**一律无条件覆盖**，与 direct_shot 的「回显不构成新事实」同规格。

此前要求模型自己在一份两万字符的 JSON 的两个远距离位置逐字重复同一个长句，实测不可靠：debug 侧车记录的真实调用中合规率两极分布（多次 0/12），加强措辞后仍出现 2/12 与 9/12 两次硬失败。失败模式是模型在**改写**而非复制——砍掉前置准备再把主语补回句首，让顶层成为能独立成句的摘要；而「顶层不得含准备」恰恰是 Prompt 自己的要求，两条规则互相冲突，调措辞救不了。派生把这类失败整类消除，同时让前置准备、时间标记可以自然留在拍内。

校验只裁决可唯一推导的部分：拍号必须是整数且在 `storyOutline` 范围内，且「关键选择拍 < 高潮拍」（**「高潮拍必须早于最后一拍」已移除**——它规定的是故事形状不是一致性，两者相同只让两个字段取到同一句话，是冗余不是矛盾）。「两拍之间隔一拍写后果」仍只留在 Prompt。签发时派生，入站复核只核对字符串与拍号一致（**不重新派生**——那会改变 content digest，破坏 `variant:<id>` 的 lineage 绑定）。诊断码：`STORY_CANDIDATE_BEAT_INDEX_INVALID` / `..._OUT_OF_RANGE` / `STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER` / `STORY_CANDIDATE_PROJECTION_NOT_DERIVED`。

这条约束 Prompt 一直就写着，但此前**没有校验器**。放开固定拍号（原 Beat 3/5/6）后实测合规率从 60/60 掉到 31/48，某些上游甚至 0/12——顶层写压缩摘要、`storyOutline` 写另一件事，同一个候选出现两版剧情，下游 Full Story 无从判断哪个是事实。它是阻止候选内部多版本事实的唯一机制，因此补成确定性硬失败。

每个 Candidate 必须有一个主要承担角色性格或人物关系质感的 Beat，但它仍必须改变关系、情绪、信息或后续选择条件；删除后必须损失角色弧、关系推进、情绪积累或后续因果之一。禁止恢复「完全不推进主线、删除后故事仍完整」的旧 Prompt 规则。

用户明确选择后，完整 Candidate 作为 `variant:<id>` Artifact 签发。`POST /api/full-story` 必须同时绑定该 Artifact 的精确 `artifactId/revision/contentDigest`；服务端在调用 Full Story 模型前后都必须复验 current Candidate、请求副本 digest、running target/request 和 target revision，并用落盘 Candidate 替换客户端副本。`candidateBinding` 只是请求 sidecar，不进入 Prompt、Legacy Full Story wire shape 或 Artifact。同 id 任意内容变化都必须换 digest/revision 并使旧下游 stale。

状态恢复时，current Full Story 或 Animation Plan 可恢复其 `selectedVariantId`；没有下游时，只有 current `variant:<id>` 明确选择记录才能恢复。仅有 `themeVariants` 时 `selectedVariantId` 必须保持 `null`，禁止默认回退到 V1。离线质量基线只记录固定 fixture、九项人工评测维度、真实 token usage 和确定性 validation failure；不调用外部模型，不伪造主观分数。当前没有 Story Selection/Blueprint/Script Doctor/Targeted Rewrite/Production Package 4.0；Phase 2 只预留「已签发 Candidate 内容 + 精确 lineage reference」输入接缝。

当前 `direct_shot` 必须由请求显式传入 `animationPlanMode: "direct_shot"`，且 `productionStrategy.format` 为 `direct_shot_video`。每个 shot 保留 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes` 以及镜头标识、时长、剧情目的、负面词和验收标准；禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段。

镜头标识不得混淆：`sourceSceneId`（常见 `S1`）是当前 Full Story 的剧情场次归属；`sceneId`（常见 `LOC01`）是 Foundation 场景视觉参考组；`shotId`（常见 `A01`）是当前 Plan revision 内的业务镜头顺序标识。`S1` 不是场地，`LOC01` 不保证精确物理地点或无缝连续，`A01` 也不能脱离 project/run/plan revision/digest 单独标识媒体。

当前 `direct_shot` 3.1 把 `fullStory.sceneScript[]` 的每一项直接定义为最终可翻拍业务镜头：Animation Plan 不再拆镜，只填内容。镜头骨架由 `deriveDirectShotSkeleton()`（`src/direct-shot-timeline.js`）从 Full Story 确定性派生，且发生在任何模型调用之前，是唯一权威。服务端独占并确定性签发 `shotId`（全局 `A01`、`A02`……）、`sourceSceneId`（= `sceneScript[i].sceneId`）、`sceneId`（Foundation `sourceSceneIds → LOC` 映射）、`durationSeconds`、`storyPurpose`（= `dramaticFunction`）、`emotionalTarget`（= `emotionNode`）六个字段；模型回显错了按骨架确定性覆盖，因为这些值全部可从 Full Story 唯一推导。模型只生成 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts`、`acceptanceCriteria` 八个字段。唯一的拆镜条件是单场跨度超过 15 秒：按 `ceil(跨度 / 15)` 均分，余数逐秒给靠前的镜头（20 秒 → 10+10；17 秒 → 9+8；34 秒 → 12+11+11）。除此之外禁止拆分、合并、新增、遗漏、重排或改写时长，因此 `shotPlan.length === Σ ceil(span_i / 15)`，`span_i ≤ 15` 时严格 1:1。一条业务镜头内部允许多个动作阶段、景别变化、特写、硬切和结尾宽景，全部写进同一条 `videoPrompt`/`cameraMotion`，不得增加 `shotPlan[]`；动作目标变化不再是拆镜理由。长场次被均分时，该场 `visibleAction` 的动作链必须按时间先后完整分配到相邻镜头，不省略、不重复，段间靠 `continuityNotes` 承接。`shotAndSound` 与 `shootingNotes` 不是镜头数量的事实源。时间线校验全部明确失败、禁止退回默认值或猜测：`timeRange` 不可解析、跨度非正、跨场次起点早于上一场终点、任一段低于供应商 4 秒下限时抛 `OutputContractError`，诊断码分别是 `DIRECT_SHOT_SCENE_TIME_RANGE_INVALID`、`..._OUT_OF_ORDER`、`..._DURATION_BELOW_PROVIDER_MINIMUM`；场次之间允许留白，只禁重叠与回退。`parseSceneTimeRangeSeconds` 与 `parseSceneTimeRangeBounds` 共用唯一一份正则，秒位接受 `0–99`——`00:60` 在 mm:ss 下只可能是 60 秒，与 `01:00` 完全等价，按 `m*60+s` 折算是确定性算术而非推断。批次由 `assertDirectShotBatchMatchesSkeleton()` 复核数量与逐位 `sourceSceneId`，`mergeAnimationPlan` 对整份 `shotPlan` 再逐位复核（含 `shotId`、`durationSeconds`）并断言 `Σ durationSeconds === productionStrategy.targetRuntimeSeconds`；direct_shot 对已解析候选一律 fail closed，不整批重试。`targetRuntimeSeconds` 由服务端注入为骨架各镜时长之和，模型输出一律被覆盖；`recommendedShotDurationSeconds` 在 direct_shot 已删除（时长是派生事实，不存在「建议」），旧 v2 兼容路径保留。项目层面不再有 4–6 秒限制：合法时长就是 timeRange 派生结果，落在 Seedance 2.0 与 MiniMax H3 的能力交集 4–15 秒整数内。内部摄影变化允许但不强制，不能为了堆机位而压缩、跳过或改写 `visibleAction`。以上只作用于 direct_shot 主流程，旧 v2 兼容路径的镜头数与时长语义不变。

`productionStrategy.videoPromptProfile` 是服务端签发的 Plan 级提示词方言/来源记录，严格包含 `schemaVersion/profileId/provider/model/guideVersion`；它不是运行时 provider/model 锁，模型不得输出、推断或修改。`direct_shot.videoPrompt` 必须是一条自包含、可直接交给视频模型的中文自然语言完整提示词，按“Foundation 风格与物理光线 → 地点环境 → 实际出镜主体与已锁定外观 → `visibleAction` 顺序动作链与可见结果 → 内部摄影/剪辑顺序 → 节奏、对白和声音 → 本镜头相关稳定约束与停止条件”组织。第 ⑤ 项必须逐拍写明该拍画面里出现的角色，写到的角色必须完整入画（含面部），不得只给手部、局部肢体或无头躯干；多角色同场时至少有一拍让他们同时完整同框。依据是 2026-08-30 双人对话镜头三臂实测：缺主体槽位时配角频繁退化成无头躯干加写实大手，双人同框仅 4/9，补上逐拍主体后升到 9/9 并追平 H3 原生六段方言——这也是不恢复原生方言的依据。该约束是 Prompt 生成约束，没有确定性校验兜底。提示词方言只有一种：同一条 Seedance 中文自然语言提示词同时提交给 Seedance 2.0 与 MiniMax H3，运行时视频模型不再决定提示词写法。`profileId` 恒为 `seedance_2_0`，`provider`/`model` 只如实记录用户首次生成时选择的运行时视频模型，且不参与 mismatch 判定——因此切换视频模型不再触发「是否重写提示词」。旧 Plan 带已下线的 `profileId: "minimax_h3"` 时，`getVideoPromptProfileMismatch` 返回 `unsupported_current_profile`：Plan 仍可加载查看，但生成视频前必须重新生成 Plan；该降级只认这一对精确的 `profileId + guideVersion` 白名单，损坏或被篡改的 Profile 仍然硬失败，`assertVideoPromptProfile` 本身始终严格。Plan 阶段不得生成尚未绑定的 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>`。`cameraMotion` 应同步记录业务 shot 内完整的摄影与剪辑顺序；使用内部切换时，1–3 条 `acceptanceCriteria` 必须覆盖主要动作链顺序、可见终点和关键摄影切换，失败不得静默增加 shot 或删除动作。productionStrategy.backgroundMusicMode 是主题变体卡上背景音乐开关的签发结果，取值只有 none / allowed，默认 none；与 videoPromptProfile 同级，由服务端根据请求 backgroundMusicEnabled 签发，模型不得输出、推断或修改，回显即拒绝。none 时 videoPrompt 必须以「全片无背景音乐，只保留现场环境声与动作声。」逐字收尾；方言只有一种，两个视频供应商共用这条约束。关闭的只是背景音乐而不是现场声，soundDesign 照常写环境声、物理动作声与对白，且不对 soundDesign 做关键词禁用。批次与 Profile 改写路径都由 validateSeedanceBackgroundMusicSentence 校验，改写路径在语义审计之前执行——方言改写不授权顺手改变有无配乐；allowed 时两个校验都不施加。已有 Plan 时拨动开关必须重新生成整个 Animation Plan（与切换画幅不同，画幅不调用模型），签发新 Plan revision 与 media namespace 并递归 stale 该变体全部媒体，页面必须先明确征求同意，拒绝时开关回弹且不改 Plan、不 stale 媒体。Demo mock 按同一 backgroundMusicMode 产出合规提示词，不得出现 mock 通过而 live 失败的偏差。


已有 Plan 后切换镜头视频模型时，页面先保留新的运行时选择，再比较目标 Profile 与已签发 `videoPromptProfile` 并询问是否重写；缺失 Profile 的旧 Plan 同样视为 mismatch，禁止从 Prompt 文本、provider 或模型名反推。拒绝时不修改 Plan、不签发 revision、不 stale 媒体，也不回滚新模型设置；确认时只能重写全部 `shotPlan[].videoPrompt` 并更新 Profile，其他字段必须逐字保留。改写结果通过完整契约校验后还必须经过下述证据绑定语义审计；若只发现 `video_prompt` 层实质冲突，可在提交前执行唯一一次有界 Prompt 修复和复审，其他字段仍逐字冻结。只有最终完整校验和审计都成功后才签发新 Plan revision/media namespace 并使旧媒体 stale，任何失败都保留旧 Plan current。合法反例：旧 Plan 含 3 秒镜头时，不能通过提示词改写把 `durationSeconds` 静默改成 4 秒；确认改写必须失败并要求完整重生 Plan，拒绝改写则 Plan 保持不变，但该 3 秒镜头也不得提交给任何供应商。3.1 起这类镜头在骨架派生阶段就已经被拦下。

确认 Profile 改写必须使用已配置的实时文本模型；demo mock 不得伪造语义审计结果或生产 Profile。Foundation 与全部 shot 合并并通过完整契约校验后，必须另行执行逐镜、证据绑定的两层语义审计：先检查同镜结构化字段是否服从验签固定角色、Full Story 场次/道具用途和 Foundation 视觉锁，再在结构化事实通过时检查 videoPrompt。审计必须包含完整 `assetPrompts`；它只能以受信 ID 和逐字 excerpt 报告会改变实际成片的关系，不能因同义表述、没有重复已表达动作、缺少多余的段落结束时间或 Foundation 已授权的视觉细化而失败。结构化字段 fail 时 `videoPrompt` 必须停止评估且不得修 Prompt；只有全部结构化字段 pass、失败项都精确属于 `videoPrompt` 时，才可签发一次有界 Prompt 修复，原子合并后复审受影响镜头与相邻镜头，复审失败不得循环。通过回执只记录在 `metadata.videoPromptSemanticAudit`，不是第二份事实源。每镜时长由 Full Story 的 `timeRange` 确定性派生，取值落在 Seedance 2.0 与 MiniMax H3 的能力交集 4–15 秒整数内；已有值不合法时必须拒绝，不能钳制、补长或缩短。


Animation Plan 的 `targetAspectRatio` 当前只允许 `9:16` 或 `16:9`。首次生成时必须锁入 `productionStrategy.targetAspectRatio` 并与 Foundation 输出一致；已有 Plan 切换画幅时以用户选择更新计划级输出事实，不调用模型、不重写 shot，但必须签发新 Plan revision/media namespace，使旧画幅媒体 stale。后续视频生成从当前签发 Plan 读取；不得向 direct-shot 的 exact shot 字段增加 `aspectRatio`。页面的计划总长由 `shotPlan[].durationSeconds` 合计派生；3.1 起 `targetRuntimeSeconds` 由服务端注入为同一个合计值，两者定义上相等，偏差恒为 0。浏览器把画幅控件放在「设定创作宇宙」面板（#animationAspectRatio），它只是新 Plan 的默认值（全局默认为 16:9）：写进 state.animationAspectRatioDefault，取值优先级为「该变体草稿 → 该变体已签发 Plan → 全局默认」；拨动它不触碰任何已签发 Plan，不签发 revision、不 stale 媒体。已生成的 Plan 卡片里画幅是纯展示 data-cell，不再提供就地切换的下拉框，因此当前浏览器不暴露「已有 Plan 就地切换画幅」这条路径，要换画幅只能重新生成 Plan；上述切换画幅契约描述的仍是该操作一旦发生时必须满足的语义，withAnimationPlanAspectRatio()（public/animation-plan-settings.js）与其单元测试保留，随时可重新接回 UI。

Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 代码保留兼容，但不参与当前 `direct_shot` 主流程。

视频生成存在两个显式模式：

- `first_last_frame`：首尾帧是精确端点，Kling、Seedance、MiniMax H3 可用；无端点的 `direct_shot` 不可使用，必须明确失败。
- `all_reference`：图片/视频/音频仅作为多模态参考，必须至少包含合法图片或视频，不能只输入音频；当前只允许 Seedance 2.0 与 MiniMax H3（两者消费同一条 Seedance 方言提示词），不得混用 `first_frame` / `last_frame`，不得把可灵 image-to-video 静默当作 Omni API。H3 Context-IR 已随提示词方言一并下线且没有公开 API（官方仓库说明 H3-Context-IR 未开源），此前 worker 中的 `POST /v2/h3_context_ir` 打的是不存在的端点，相关能力、端点派生与请求体已全部删除，不得重新接入。MiniMax H3 的 `resolution` 与 `ratio` 只在未配置时走缺省（`2K` / `adaptive`）；显式配置了官方取值以外的值必须明确失败，不得静默回退成默认值。供应商轮询失败必须带回它自己给出的原因，并在人类可读摘要之后附结构化 `{"error":{...}}`，否则 `describeProviderError` 查不到官方码表、用户拿不到可执行提示；内容审核 `1027`（输出涉敏）是非确定性的，但**不得擅自加入自动重试**——那是在第三方安全闸门上循环重试，代码无法区分误判与真违规，是否重试由用户显式决定。成片实际时长与 Plan 要求时长并列记录在每条候选的 `plannedDurationSeconds` / `measuredDurationSeconds`（`0` 表示未测得），偏差既不静默也不硬失败：实测 H3 请求 5 秒稳定产出 5.167 秒，硬失败会让该供应商 100% 不可用；是否对齐成片总长仍是未决的契约问题。

模式由请求 `generationMode` 决定，不得根据端点字段缺失、provider、模型名或素材存在性自动推断或降级。

`all_reference` 可另行显式传入运行时 `continuityReferenceMode: "none" | "previous_shot_frames"`；它不得改变或推断 `generationMode`，也不是 `direct_shot` Schema 字段。启用 `previous_shot_frames` 时，上一镜只由当前 Plan `shotPlan[]` 的紧邻前项确定；服务端必须读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，并用 FFmpeg 按 `t = 时长×i/4` 均匀截取 **5 张** JPEG（首帧、末帧和中间三等分点；末帧回退 0.1 秒以保证可解码）作为普通 `reference_image`。张数固定为 5，不随镜头时长变化：3.1 把单镜时长放宽到 4–15 秒后，每秒一帧会让超过 9 秒的镜头直接撞上 9 图上限，也会把角色参考图挤出共用额度。时间戳由 `previousShotFrameTimestamps()` 确定性计算并逐帧写进回执。实际抽帧与其他图片共同受 9 图上限约束，超限明确失败。该参考只增强一致性，不能覆盖当前 Full Story/Plan、`fixedCharacterBoundary` 或 Foundation 场景事实；跨地点、跨时段或上一镜漂移是关闭该开关的合法反例。


`POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不能依据客户端自报 `animationPromptSchemaVersion` 降级为无 lineage 请求。服务端从 Plan 唯一解析 exact shot；只允许独立 `promptOverride` 覆盖本次媒体提示词，动作、时长、场景、声音、负面词和验收条件仍来自 Plan。输出文件名必须包含不可碰撞的请求 nonce，并在返回前通过 ffprobe 视频流/时长校验。生成期间还必须无条件复验生产上下文是否仍为 current——在任何供应商调用与文件写入之前、每条候选提交供应商之前、每条候选落盘并通过 ffprobe 之后、组装返回值之前各一次，覆盖全部视频供应商，不得按 provider、模型或提示词方言设门。任一次复验失败即 fail closed：删除本次请求已写入的全部候选 mp4，并把 `ProductionStateError`（409）原样上抛，不得包装成配置或供应商错误、不得保留产物、不得降级为成功返回。清理只针对本次调用自己算出的含 nonce 路径，旧 v2 首尾帧 PNG 不在覆盖内；只有过期触发清理，供应商错误与 ffprobe 失败维持既有语义。

`all_reference` 模式下，服务端在 `shot.videoPrompt` 之前确定性拼接一段**运行时参考素材清单**（`buildReferenceManifestText()`，`src/shot-video-continuity.js`），说明每张素材各是什么：参考图以 `reference_image` 发送时不携带任何文字身份，模型无从分辨哪张是角色参考、哪张是上一镜抽帧。清单前置而不是后置，以保证 `backgroundMusicMode: none` 的禁配乐句仍然是整条提示词的最后一句。清单只允许使用受控来源枚举、Plan 权威的 `sourceCharacterName`（由 `resolveAuthoritativeShotVideoReferenceAssets` 按已签发 `characterReferencePrompts[].referenceImageDataUrl` 唯一匹配后覆写）、lineage 解析出的 `sourceShotId` 与帧数；**禁止写入 `upload` 素材的 `name`/`logicalName`**，那是原始用户文件名，是这条链路上唯一的注入面，上传素材一律只写「用户上传的参考素材」——安全性来自构造而不是事后校验。它不是 Plan 字段、不改 Schema、不签发 revision、不 stale 媒体、不调用模型：`sourceVideoPrompt` 保留 Plan 原值，`effectiveVideoPrompt` 与新增回执字段 `referenceManifest` 记录本次实际发送内容，`first_last_frame` 路径逐字不变。这里不得补 `ensureCharacterPromptMatchesBoundary`——视频提示词天然多角色，走 `promptScope: "multi_character"`，而该分支在 `src/validation.js` 中无条件短路返回空串，加上去只是一个看起来像闸门的空操作。

`/api/generate-character-reference-images` 送给图像模型的提示词由 `public/character-reference-prompt.js` 单份构建，浏览器预览框与服务端回退共用同一份——用户看到并可编辑的必须逐字等于实际发送的。字段顺序按 `docs/video-prompt-guide.md` 模板 1：光线 → 角色外观 → 姿态表情 → 干净背景 → 风格色调 → 景别/取景/机位；风格与光线取自当前 Plan 的 `visualBible`，缺失时整行省略且不编造，`cameraLanguage` 属于镜头语言不得搬入。此前该端点完全拿不到 `visualBible`，角色图在不知道全片风格的情况下生成，却又要作为视频的视觉锚点。

使用上一镜抽帧生成的后镜 `shotVideo` Artifact 必须同时依赖当前 Animation Plan 与上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选必须递归使下游视频 stale。切换后镜自身候选时必须保留既有媒体依赖。浏览器中的 `shotVideoResults` 与旧 v2 `shotFrameResults` 都必须按 variant + shotId 隔离，禁止只用 `A01` 作为状态键；单个媒体 stale 只能移除对应结果，不能清空其他 current 媒体。

---

## 当前模型 provider 边界

工作流 LLM provider 包括：

- Qwen
- MiMo
- DeepSeek

DeepSeek 当前只允许用于纯文本阶段：

- Brief
- Variants
- Legacy Full Story
- Animation Plan
- Static Frame Compiler（仅旧 v2 兼容路径）

禁止将 DeepSeek 用于需要图片或视频输入的阶段：

- Analyze
- Reconstruct
- Visual Guardrails
- Character Reference

当前 DeepSeek 模型 ID 只登记 `deepseek-v4-flash` 和 `deepseek-v4-pro`。Flash 是页面首选项，Pro 只能显式选择；不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。

---

## 当前全局角色边界

`Visual Guardrails` 是固定角色语义的唯一生成阶段。它允许视觉模型结合用户设定、参考分析、脚本还原、创意简报和模型常识生成开放语义边界，不得新增本地物种关键词字典替代模型判断。

Creative Brief 的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression` 以及 Visual Guardrails 的 `sourceSimilarityRules.sourceExpression` 在列举同一类别的多个具体物品时，每一项都必须重复完整中心名词，例如“绿色邮箱、红色邮箱、蓝色邮箱”；禁止输出“绿色、红色、蓝色邮箱（组合）”这类共享末项名词的缩写。该规则只能规范已有来源事实，不授权模型补充新物品；下游也不得通过颜色词、后缀或本地中文语法规则猜测被省略的中心名词。旧 Artifact 含歧义缩写时必须重新生成对应上游阶段，不能原地推断或改写已签发内容。其中「下游不得补全被省略的中心名词」这一半现已由确定性校验强制：`visualGuardrails.sourceSimilarityRules[].sourceExpression` 的每一并列项都必须逐字出现在本条规则自己的 `triggerEvidence[].evidence` 中，否则 fail closed（只归一化引号、空白与句末标点，不做任何中文语法推断）。上游 Creative Brief 是否写出了缩写本身仍只由 Prompt 约束——判定它需要的正是本规则禁止的中心名词推断，因此不做本地实现。

Creative Brief 的 `allowedNarrativeComponents[].component` 是服务端固定的七项 taxonomy：送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾。生成 Prompt 必须展开完整七项；模型只能填写每项非空的 `howToReuseSafely`，不得改名、合并、省略、重复或增加分类。不适合当前素材时也必须保留该项，并在说明中记录不采用或限制条件。每条 `howToReuseSafely` 必须以 `【原片有】` 或 `【原片没有】` 开头，先对原片是否真的存在该构件作出显式判定，再谈复用；该判定只描述上游 `referenceAnalysis`/`sourceScriptReconstruction` 已发生的事实，不描述新片打算怎么拍。缺少判定前缀时确定性校验直接失败，防止模型把"新片可以怎么用"写成复用授权，替原片补出它没有的叙事构件。写 `【原片有】` 时还必须用「」引出上游依据，服务端回到 `sourceScriptReconstruction`/`referenceAnalysis` 核对。判据是字符覆盖率（最长公共子序列，阈值 0.75）而非逐字子串——Brief 阶段的模型在做归纳，引用必然转述，逐字比对会把忠实转述判成编造并阻断整个阶段。引用缺失或覆盖率不足即失败。该核对只在校验器实际收到上游时执行。标记常量与七项名称同样由服务端与 validator 共用。数组顺序不承载业务语义。七项名称由服务端常量与 validator 共用，不得在 Prompt、Mock 或校验器中各自维护第二份列表。

上述 Creative Brief 来源字段与 `sourceSimilarityRules` 都只是原片表面表达的 provenance，不是 Variants、Legacy Full Story 或 Animation Plan 的正文禁词。原片道具、拟声词和角色组合允许按当前选定剧情出现在任意正向业务字段，包括 `visibleAction`、对白、声音以及 `videoPrompt`；但不得仅因它们存在于来源上下文就机械注入下游内容。`sourceSimilarityRules` 只在实际生成请求确实携带原片参考时，为 `reference_leak` 提供证据；不得据此扫描或拒绝无原片参考的正文。`dialogueRules` 只能来自用户明确约束，不得把原片对白或拟声词自动提升为对白规则。该放行不改变 `fixedCharacterBoundary` 的优先级：固定主角的签发身份与外观仍是硬边界，复用原片角色组合不授权改写固定主角。

服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、视频生成，以及旧 v2 兼容路径中 Character Feature Compiler 和首尾帧生成的唯一固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份角色边界。角色边界的**事实来源唯一，但执行力度分两档**：角色参考阶段（`/api/refine-character-reference` 的精修结果、`/api/generate-character-reference-images` 的 `characterReference` 与用户可编辑 prompt）遇到偏差只回传提醒不阻断，服务端仍完整判定并把偏差原文放进 `boundaryWarning` 或 `boundary-warning` 流事件，浏览器以警告色展示、照常完成本次操作，用户不必重新上传；依据是本节的「用户明确肯定/否定 > 已签发模型推断」。`boundaryWarning` 只用于展示，写回 Plan 前必须剥离，不进入 Artifact。人物参考精修允许按参考图改写 `appearancePrompt`，但不得因此丢掉全局必需角色事实——判定是字面比对，「穿着适合户外写生的村民服装」换成具体衣物后 identity 类的「村民」就没了。精修提示词必须逐条列出每条 `requiredTraits` 的可接受写法，并说明身份、性格、职业、剧情功能类事实写进 `identity` 或 `consistencyTags` 同样算数；服务端返回前用与判定共用的扫描口径补回缺失事实，只能在 `consistencyTags` 尾部按签发顺序追加 exact `canonicalName`，冻结 `appearancePrompt`，且**只覆盖非 `appearance` scope**：外观必需事实缺失是模型真把长相写错了，必须继续提醒并在成片渲染前硬失败。补写结果经展示用 `boundaryRestoreNotice` 如实回报，写回 Plan 前剥离。人物参考精修的**冲突优先级同样分两档**：`/api/refine-character-reference` 遇到参考图与文字设定冲突时，配角（非固定角色）以用户上传的参考图为准，按图改写 `appearancePrompt` / `consistencyTags` / `forbiddenChanges`，即使图中明显是另一种角色也照图改写，不得以「与当前角色不符」为由放弃采用；`characterName` 与 `storyRole` 承担的剧情功能不变，变的只是外观——依据是本节的「用户明确肯定/否定 > 已签发模型推断」，配角的文字设定本身是模型推断产物，上传图片则是用户的明确动作。固定角色仍以已签发 `fixedCharacterBoundary` 为准，参考图只能补充不冲突的细节，否则失败只会被推迟到成片渲染的 `ensureCharacterReferenceMatchesBoundary`。覆盖结果由模型写进 `referenceImageOverrideNotice`，与 `boundaryWarning` 同规格：只用于展示，写回 Plan 前必须剥离，不进入 Artifact；固定角色路径一律丢弃该字段。分档判定只用 `characterName` 与边界名的身份比较，不新建第二套词表。成片渲染链路（`/api/generate-shot-video`、`shot-video-generator` 的 `effectiveVideoPrompt`、旧 v2 首尾帧 `/api/generate-shot-frame-image`）仍然硬失败，`ensureCharacterReferenceMatchesBoundary` / `ensureCharacterPromptMatchesBoundary` 的抛错语义逐字不变；只提醒的三处改调同一判定的收集器 `characterReferenceBoundaryMismatch` / `characterPromptBoundaryMismatch`，判定规则只有一份，禁止另建第二套词表。

`groundingSeal` 与 `fixedCharacterBoundary.boundarySignature` 所用的两把密钥必须持久化在状态根目录（`.grounding-key` / `.character-boundary-key`，可由 `WORKFLOW_GROUNDING_KEY` / `WORKFLOW_CHARACTER_BOUNDARY_KEY` 覆盖），跨进程重启保持不变。缺失即生成，损坏、长度不足或环境变量非法一律硬失败，**禁止静默回退为随机生成**——换钥会让全部已落盘 Artifact 的签名作废。已落盘 Artifact 不得用新密钥重新签发。

生产环境必须校验 `fixedCharacterBoundary.boundarySignature`。仅当服务端显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test|development` 且 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时，为支持重启后继续回放本地测试包，可以跳过 HMAC 签名比较；`sourceDigest` 与 `boundaryDigest` 仍必须匹配。该策略只能来自服务端环境，禁止由请求体控制。

冲突优先级：用户明确肯定/否定 > 已签发模型推断。无法消解的冲突必须阻断，不能选择任一方静默覆盖。用户或权威上游数据改变后，旧边界必须失效并重新生成。

## 当前模型内容纠错边界

当前主流程中，任何已经解析为候选对象的模型内容错误都不得通过“把完整失败 Artifact 发回模型并要求整包重写”恢复。只有 validator 输出稳定 `code + RFC 6901 JSON Pointer + reason`，候选完整、目标已存在、事实来源唯一且对应 stage adapter 明确授权时，才允许签发一次有界局部纠错。没有可信 diagnostics、没有唯一权威、整个对象/数组项丢失、候选非对象或 adapter 不支持时必须 fail closed；不得解析人类错误消息猜 path，也不得自动扩大可写范围。

当前生产纠错由一个 Full Story 专用协议、两个确定性 Animation adapter 和一个语义 Prompt adapter 组成：Legacy Full Story 仅支持由签发固定角色边界唯一恢复 protagonist `name` 的安全子集，使用 `full_story_partial_repair/1.0`；Animation Foundation 固定角色安全子集使用 `artifact_partial_repair/1.0`；证据绑定审计确认全部结构化 shot facts 通过后，纯 `videoPrompt` 实质冲突可使用 `animation_video_prompt_semantic_repair/1.0`。服务端独占私有签发身份、`baseDigest`、authorityDigest、repairId、目标 path、mutablePointers 与 authority；模型取得的序列化计划不能作为可合并计划。第二次模型请求只发送目标 currentValue、diagnostics、修复说明和最小权威投影。模型只能返回等量、同序 `{repairId,replacement}`，不能返回 path、op、完整 Artifact 或额外字段。服务端必须在 clone 上原子合并，证明目标内未授权事实与全部目标外数据不变，重新投影并验证当前 authority，并从头执行该阶段完整 Schema、角色、剧情与跨字段校验。语义 Prompt 修复另允许且只允许一次相邻镜头复审；复审失败即终止，不得再次修复或整包 fallback。

当前覆盖只包括：Legacy Full Story 中 protagonist `name` 缺失/类型错误/空字符串且验签边界提供唯一姓名；Animation Foundation 中唯一固定角色参考的 `requiredTraits` 缺失/禁止特征命中；以及审计 V2 证明结构化事实全部通过后的纯 `videoPrompt` 实质冲突。

Foundation 仅缺必需事实时必须冻结 `appearancePrompt` 和已有 `consistencyTags`，只允许在标签尾部按签发顺序追加缺失 trait 的 exact `canonicalName`，不能用同义 term、重排或改写外观代替；禁止词诊断只授权实际命中的字段做最小删除，混合错误的缺失事实仍只能进入标签。判定禁止特征时必须放行否定语境：角色参考写「无翅膀、无企鹅服装」是给图像模型的否定约束，不构成使用该特征；执行删除时必须连同紧邻否定词一并剥离，否则正文会留下「无、无」这类孤儿否定，合法的最小删除将永远无法通过守卫。Full Story 的未知正文错位、配角姓名或身份错误、`characters` 与 `visibleAction`/`dialogue` 的跨字段冲突，以及没有签发值来源的必填剧情字段必须 fail closed，不能让模型通过猜字段、改名、删对白、删动作或另编剧情消除校验错误。语义 target 只允许完整替换已签发镜头的 `videoPrompt`，全部非 Prompt 字段及未命中镜头逐字冻结。结构化 `characterAction`、`cameraMotion`、`continuityNotes` 或其他 shot fact 本身与高层权威冲突时，不得借修 Prompt 掩盖，必须明确失败。其他已解析内容错误当前直接失败，不能宣称已被自动纠正；唯一的再取证例外是 `referenceAnalysis` 原生视频候选仅因 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧时，系统丢弃该候选并用既有 frames 重取一次，不发送失败 Artifact，也不属于 repair。网络、鉴权、429、timeout、lineage stale、签名失效同样不是内容 repair。旧 v2 首尾帧兼容路径不是当前 `direct_shot` 主流程，不能用其历史整批 retry 解释当前行为。

### Legacy Full Story Beat–Scene 提交前复核

Legacy Full Story 另有一次与失败候选 repair 严格分离的 Beat–Scene 提交前复核。它只能在初轮候选（包括已经完成唯一允许的 retry 或 protagonist `name` 局部纠错）通过 exact Schema、Scene Contract、固定角色/Profile、Variant 与既有语义边界的完整校验后执行；失败候选不得借此补写正文。复核使用当前 Full Story 已明确选择的同一文本 provider/model，第二次请求的业务内容只能包含这份完整、已合法的 Full Story JSON 与专用复核提示，不得再次上传或展开 `creatorProfile`、Theme Variant、Creative Brief、Visual Guardrails、`referenceAnalysis`、Reconstruction 或其他边界/变体数据。

`beatSheet` 在该复核中是只读的叙事目标，模型只判断它与 `sceneScript` 是否存在会造成可拍叙事断裂的明显遗漏。若不存在明显遗漏，必须返回 unchanged；若存在，模型也不得自由创作 suffix。每条提议必须指向已有 scene 和唯一 `beatSheet[beatIndex]`，其 `addition` 必须是对应 `beatSheet[beatIndex].storyAction` 中一段连续、逐字相同的原文，并且必须包含该 review 逐字返回的 `beatEvidence`；全部证据只能使用该 `storyAction` 与目标/相关场次现有 `visibleAction` 的逐字 excerpt，不能引用其他 Story 字段或上游数据。无法把所需内容逐字投影为该连续原文时必须返回 `blocked`，不得概括、改写、拼接不连续片段或自行补写。

唯一可写范围仍是把受信 `addition` append 到已有 `sceneScript[i].visibleAction` 末尾，原值必须保持为逐字前缀。一次 postpass 最多补 3 个已有场次，每条 `addition` 最多 600 字，全部 additions 合计最多 1200 字；超限、`beatIndex`/证据错绑、addition 未包含 `beatEvidence` 或原文不连续均按协议错误 fail closed。场次数量与顺序、`sceneId`、`timeRange`、`location`、`characters`、对白、`shotAndSound`、`emotionNode`、`dramaticFunction`、`shootingNotes` 以及 `sceneScript` 外全部字段必须逐字冻结。明显遗漏仅指重要剧情节拍、可见结果、状态变化或因果过渡没有任何可拍证据；合法省略、蒙太奇概括、末项代表整组、或现有终态已经覆盖节拍时不得重复投影。

复核返回 `blocked`、协议错误、供应商错误、越界 diff、非追加式改写或最终完整复验失败时必须 fail closed：不得保存原候选作为 fallback，不得发起第二轮复核，也不得扩大到整包重写。正常路径为 Full Story 初轮生成加一次复核，共 2 次 provider call；初轮若消耗唯一允许的 retry 或局部纠错调用，成功后再复核时整个 operation 最多 3 次，禁止第四次调用。append 合并在 clone 上完成，并从头重新执行 Full Story 全部校验；只有最终 unchanged 或合法追加后的 Story 提交一次 Artifact。初轮候选、复核响应和合并中间态都不是 Artifact、revision、Checkpoint 或第二份 Story 事实源。该 postpass 不扩展上述 partial-repair adapter，也不是 Full Story v2、Canonical Story 或通用 Auditor。

每次服务端或 `run:video` 已成功签发 repair plan 后，必须在第二次 provider call 之前启动 `debug/partial-repairs/` 本地观测记录，并按触发、局部 Prompt、模型 replacement 投影、最终结果四阶段落盘。只允许写入命中 target 的 currentValue、结构化 diagnostics、最小 authority 与拒绝原因；禁止写入完整 Story/Foundation/Animation Plan、原始 HTTP 响应、Header、密钥、Cookie、Data URL 或 Base64 媒体。没有签发 plan 时不得创建记录。Debug 写入必须 fail-open 并只输出脱敏告警，不得改变 repair 的成功/失败、增加模型调用或回退保存 raw；这些文件不是 Artifact、Production Lineage、业务事实来源、恢复数据或导出包内容。

Full Story 另有一条与 partial-repair Debug 严格隔离的、服务端环境显式开启的全量模型输出日志。只有 `FULL_STORY_MODEL_OUTPUT_LOG_DIR` 为非空私有路径时，才允许把每次实时 Full Story primary、retry/repair 与 Beat–Scene postpass completion 的完整 `content` 按阶段原样落盘，并在日志 metadata 中保存明确的 `stage`；不得把请求 Prompt、HTTP 请求/响应包、Header、API Key、Cookie、Data URL 或 Base64 媒体一并保存。浏览器 Production token 只能通过旁路 Header 传递，服务端必须核对 current running stage 后分别记录 `productionRequestId` 与 `providerRequestId`，不得把 trace context 混入 Workflow input、Prompt、Full Story、Artifact 或导出包。目录位于 `public/` 时必须禁用。日志不截断模型 content，文件权限必须私有并原子写入；写入失败 fail-open，不得改变校验、repair、postpass、重试预算、lineage 或业务错误。该日志只是本机敏感观测 sidecar，不是第二份 Story、Production Lineage、恢复数据或事实来源。

Animation Plan 原始 completion 使用独立的 `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 与固定 `scope=animationPlan`。服务端必须在真实 `/chat/completions` 响应交给 JSON parser 前，从克隆响应中只提取 `choices[0].message.content`、finish reason、usage 数值和 provider requestId；不得保存或传递原始 HTTP envelope、请求 Prompt、Header、密钥或媒体。它必须覆盖首次 direct-shot Plan 的 Foundation、每批 shot、已实际调用的 H3 段落纠错、H3 语义 `videoPrompt` 修复、首次审计与复审，并以调用顺序/阶段标签区分；未发生的 repair 不得伪造记录。Production Header 只可在服务端核对 `animationPlan:<variantId>` current running stage、requestId 与 expected revision 后标记 verified；不匹配只能记为 unbound，不能搜索 Run 猜归属或阻断业务。输出观测失败必须 fail-open，不能改变 Response、provider 调用次数、validator、repair、Plan commit 或错误文字；日志仍不是 Artifact、事实源或恢复数据。

共用 `generateValidatedJson` 的六个阶段（Analyze、Reconstruct、创意简报、主题变体、角色与表达边界、人物参考精修）由第四套 sidecar `STAGE_MODEL_OUTPUT_LOG_DIR` 覆盖，按 stage 分 scope，成功与失败都记。原始 completion 由三个 client 的`requestJson` 通过可选 `onCompletion` 回调交出——回调只观测，抛错或 reject 一律吞掉，不得改变模型调用的成败；阶段判定复用已导出的 `classifyAttemptError`，错误 category/code 只保留一份来源，禁止另建映射。一次调用内 client 内部的 JSON 重试或视频退回逐帧各留一条记录，只有最后一条带本次阶段判定，更早的标记 `superseded`。这六个阶段在该层没有 lineage 上下文，记录一律落在 unbound 路径；`logContext` 的 verified 判定不得为此改动。其余约束（不写 Prompt/Header/密钥/媒体、私有权限、原子写、fail-open、不是 Artifact 或恢复数据）与前三套逐字一致。

---

# 2. Full Story 架构说明

## 当前存在

当前项目使用：

Legacy Full Story

负责：

- 生成完整剧情
- 输出 sceneScript
- 提供 Animation Plan 输入

## Legacy Full Story 有界子树纠错

Legacy Full Story 的唯一一次模型纠错只在首次 completion 已解析为完整 JSON 对象、全部结构化 diagnostics 都精确指向 `/characterBible/protagonist/name` 的 required/type/empty-string 错误，并且当前验签 `fixedCharacterBoundary.characterName` 提供唯一正确值时启用。服务端以当前进程内私有签发身份独占 path、repairId、mutableFields、expectedFields、原候选 baseDigest 与 authorityDigest；模型只看 protagonist 当前子树、诊断、签发姓名和最小权威上下文，只返回 replacement，不得自报 path、JSON Patch 或重写整份 Story。

replacement 只能把 protagonist `name` 设为 expectedFields 中逐字签发的固定角色姓名；identity、traits、speechRules、signatureBehaviors 与所有目标外数据必须保持不变。未知正文、配角姓名/身份错误、`characters` 与 `visibleAction`/`dialogue` 冲突、没有签发值来源的必填剧情字段都不得进入计划。服务端合并前必须确认收到的是原始私有签发计划并重新核验当前 authority；在 clone 上原子合并后，必须从头重新执行 exact schema、Scene Contract 和 `ensureFullStoryMatchesProfile`。任何协议、签发、权威、合并或完整复验失败都不得提交 Artifact，也不得产生第三次 provider call。

无法安全局部化的已解析候选必须明确失败，不能静默回退为“把完整失败 Story 发给模型重写”；无完整候选的截断/JSON 语法或供应商协议错误仍可使用既有 completion retry。内部 `full_story_partial_repair/1.0` 只是同一次 Legacy operation 的临时响应协议，不是 Full Story v2、Canonical Story、新事实源或 Production Lineage revision。合法反例：少于 6 个节拍、整个场次丢失、配角角色名缺失、没有验签边界的 protagonist 姓名错误、场次人物名单与动作/对白冲突、独立缺少 `storyAction`、无结构化路径的 Profile 错误，都不能伪造成局部修复。

## Legacy Full Story Beat–Scene 提交前复核

完整合法的初轮 Full Story 在 Artifact 提交前还必须独立调用一次 AI，对照其只读 `beatSheet` 与可拍 `sceneScript`。该调用只接收完整 Full Story JSON 和专用提示；它没有边界、变体或其他上游上下文的独立输入，也无权改写剧情或自由生成 suffix。唯一合法变化，是把对应 `beatSheet[beatIndex].storyAction` 中连续、逐字相同的 `addition` 投影到已有场次的 `visibleAction` 末尾；`addition` 必须包含该 review 的 `beatEvidence`，且全部证据只可引用该 `storyAction` 和相关 `visibleAction`。一次最多 3 个场次、每条 addition 最多 600 字、合计最多 1200 字；无法逐字投影必须返回 `blocked`。其他字段全部冻结。unchanged 可直接进入最终复验；`blocked`、协议/供应商错误、证据错绑、越界或非追加变化、最终复验失败均终止，不得 fallback 或重试 postpass。正常 operation 共 2 次 provider call，初轮消耗一次允许的 retry/repair 时最多 3 次；最终仍只提交一次 Full Story Artifact。


## 当前不存在

禁止认为以下功能已经存在：

Full Story v2
Canonical Story
Canonical Pipeline
完整批量 Production Package / production workspace
Receipt
Canonical Provenance

当前 HEAD 已包含独立的 Production Lineage v1、本地 Run/Stage/Artifact/Checkpoint 状态库和签名的 v3 测试/规划包；它们不是 Canonical Story、完整批量 Production Package、供应商 Receipt 或 Canonical Provenance。


---

# 3. fullStoryV2 命名说明

代码中可能存在：

fullStoryV2
cast
registry
confirmation

这些属于：

Phase 2 Cast / Character Governance

或者未来规划。

不能解释为：

Full Story v2 已实现

修改代码时必须区分：

正确：

Character Registry
Cast Proposal

错误：

Canonical Story 已接入

---

# 4. 修改代码前必须执行

## 证据优先与实施门槛

涉及字段语义，或会改变业务行为的 Prompt、Schema、Validation、
Compiler、Retry、Recovery、Fallback、Source of Truth 修改时：

1. 先检查当前 HEAD、实际调用链、原始失败数据和现有测试。
2. 明确区分：
   - 已确认事实
   - 当前既有契约
   - 推断
   - 尚未确认的问题
   - 新提出的架构决定
3. 在修改前明确：
   - 相关字段由谁生成
   - 由谁消费
   - 哪个字段是权威事实来源
   - 字段冲突时的优先级
   - 至少一个合法反例

如果事实来源、字段语义或冲突优先级尚未明确：

- 不得修改生产代码；
- 不得新增自动覆盖、自动同步或默认值恢复；
- 不得选择冲突中的任一字段作为真相；
- 应继续只读调查，或明确请求架构决定。

两个模型输出字段发生冲突，只能证明数据不一致，
不能证明其中某一方正确。

自动修复只有在正确值能从权威上游唯一推导、
且不会删除合法信息时才允许实施。

实施过程中出现新证据推翻原假设时，立即停止叠加补丁，
返回根因调查，不得继续用第二个修复掩盖第一个修复。

任何功能修改必须：

## 第一步：确认现状

必须检查：

- 当前 git HEAD
- 当前文件是否存在
- 当前调用链
- 当前测试覆盖

禁止：

- 根据旧聊天记录判断代码状态
- 根据文件名推断功能存在
- 根据 TODO 推断已经实现


---

## 第二步：明确修改范围

修改计划必须说明：

1. 修改哪些文件
2. 为什么修改
3. 是否改变数据结构
4. 是否影响已有流程
5. 如何验证


禁止：

顺手重构
顺手优化
统一架构

除非明确授权。


---

# 5. 架构修改原则

## 小步修改

优先：

增加校验
增加隔离
增加测试
增加边界

避免：

大规模重写
替换整个流程
重新设计全部模型

---

## 保持职责隔离

必须保持：

## Full Story

负责：

叙事结构
角色
场景
对白
剧情逻辑

不负责：

镜头动画实现
动作生成
视频生成

### 承接范围与可选构件（2026-08-28）

承接范围只有一个来源：**当前选中 Variant 实际写出的内容**。此前该阶段把七项 taxonomy（送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾）与 Variant 内容并列写成「都必须忠实承接」，与 Creative Brief 阶段「`allowedNarrativeComponents` 只记录原片是否存在某类构件，不会把该构件变成每个新方案的必选项」直接冲突——效果是候选阶段省略掉的构件会在下一阶段被原样补回来，模板只是推迟一个阶段重新长出。

现在明确：七项 taxonomy 是 Creative Brief 记录「原片有没有某类通用构件」的分类，**不是本片必备构件，也不是承接清单**。Variant 没写 `careRecipient` 就不得新增被照料对象，没写 `helper` 就不得新增提供帮助的外部角色，没写 `emotionalMedium` 就不得发明信物，没写 `endingRitual` 就不得加仪式化收尾。

对应地 `characterBible.careRecipient` 是**可选键**：不存在时整个省略，不输出空对象或占位文本；输出时 `nameOrLabel`/`identity`/`explicitNeed`/`implicitNeed`/`relationshipToProtagonist` 五个子字段必须齐全。`characterBible.protagonist` 与 `characterBible.helpers` 仍必填，`helpers` 无帮助者时输出 `[]`。旧 Story 带着 `careRecipient` 仍然合法，本次不重新签发任何已落盘 Artifact。

### 对白质量（2026-08-28）

Prompt 级硬约束，**没有确定性校验兜底**——判断一句台词是否在复述画面需要语义判断，写死词表会误伤合法的反应性台词，而 Full Story 失败代价很高：

- 对白不得复述同场 `visibleAction` 里观众已经能直接看见的信息。
- 不得用旁白式台词直接播报人物内心。
- 能靠表情、动作、停顿、眼神和道具互动表达的内容优先写进 `visibleAction` 或 `shotAndSound`，不写成台词；宁可一场戏没有对白，也不要用台词解说画面。
- `dialogueStyleGuide.forbiddenDialoguePatterns` 必须至少列出「复述画面已有信息」和「台词直接播报内心」两条。

---

## Animation Plan

当前主流程为显式 `animationPlanMode: "direct_shot"`，输出 `promptSchemaVersion: "3.0"`。shot 保留 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes` 等直接视频字段，禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段；`negativePrompts.image` 必须为 `[]`。

只有维护旧 v2 兼容路径、涉及 startFrame、endFrame、environment、motion、environmentChange、inherit 或 transition 的语义修改前，必须先阅读：

`docs/animation-plan-source-of-truth.md`

如果文档没有明确旧 v2 字段的事实来源和冲突优先级，
不得自行补充解释或实施确定性修复。
负责：

直接视频渲染提示词
角色动作、内部摄影/剪辑和声音设计
镜头连续性与动画约束

不负责：

拆镜（3.1 起镜头由 Full Story 场次确定性映射，Animation Plan 不再决定镜头数量）
重新创作剧情
修改角色身份
改变故事主题

---

# 6. Story Contract 原则

Full Story 输出必须满足：

## Scene Contract

每个 scene 必须：

- sceneId
- location
- characters
- visibleAction
- shotAndSound

`characters` 是数组必填、但**允许空数组**：无人出镜的场次（空院子雨水、屋外烟囱远景、桌面道具特写、城市建立镜头、角色离开后的空镜、纯转场环境镜头）正确值就是 `[]`，不得为了通过校验硬塞没出镜的角色。放开不打开缺口——真正出镜的标准角色仍被 `visibleAction` 扫描抓住，有对白的场次仍被说话人校验抓住。唯一新增的兜底在故事级：所有场次 `characters` 全为空时抛`FULL_STORY_NO_VISIBLE_CHARACTER_SCENE`（path `fullStory.sceneScript`），单场空镜合法、整片无人不成立。

可选：`offscreenSoundSources`（字符串数组）——本场只以声音出现、明确不出镜的角色名。

`shotAndSound` 一条自由文本同时承载画面描述（可能出镜）与声音来源（不代表出镜），程序不得靠正则或关键词区分两者，因此由模型显式登记。扫描口径按字段职责分档：`visibleAction` 只认 `characters`；`shotAndSound` 认 `characters` 与 `offscreenSoundSources` 的并集。

登记只豁免 `shotAndSound`，绝不豁免 `visibleAction`：实际参与本场的人物必须写进 `visibleAction`，所以无法靠登记声源隐藏一个出镜角色。同名同时出现在两个字段时抛 `FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE`，不自动选边；登记了却未被 `shotAndSound` 引用是合法的；名称精确性与 `characters` 共用同一份判定。该字段不在局部纠错可写范围内，postpass 必须逐字冻结；`dialogue[].speaker` 仍必须逐字存在于同场 `characters`。旧 Story 缺该字段时行为不变。

`location` 只写本场实际发生的**可拍摄物理地点**，不是画风、光线或色调。`creatorProfile.vertical` 里的风格词不得流进 `location`：正确写法是「集市旁草地」，错误写法是「日系2.5D新海诚光景风格的集市旁草地」。视觉风格由下游 Animation Plan 的 `visualBible` 统一签发，在 Full Story 重复它会让每场地点看起来一模一样，反而丢掉地点本身的信息。

该约束写在 `fullStoryPrompt` 硬约束里，**没有确定性校验兜底**——判断一个词属于地点还是画风需要语义判断，写死词表会误伤「日系村落」这类合法地名，而 Full Story 失败的代价很高。上游 `sourceScriptReconstruction.scenes[].location` 不受此约束影响，它本来就只写原片观察到的地点。


---

## characters 是事实来源

characters 表示：

本场实际出镜角色

不是：

- 被提及的人
- 地点名称
- 道具归属
- 回忆对象


例如：

正确：

铃木奶奶站在院子里浇花

characters:

["铃木奶奶"]


错误：

铃木奶奶家的门口

不能认为：

铃木奶奶出镜


---

# 7. 角色一致性规则

禁止：

- 自动新增未登记主要角色
- 修改 variant 中已有角色身份
- 修改 careRecipient
- 修改 protagonist


任何角色变化必须：

明确登记
明确理由
明确影响范围

---

# 8. 状态隔离要求

当前 Production Lineage v1 已实现并要求所有新功能继续考虑：

variant
story revision
plan revision
request id
media namespace
digest

禁止：

只依赖：

variant.id
shotId
timestamp

作为唯一身份。


原因：

避免：

- 旧 Story 污染新 Story
- 旧视频覆盖新视频
- 异步请求回写错误版本


---

# 9. 导入导出规则

当前浏览器可导出的 JSON 分为普通创意 JSON，以及服务端签发的 v3 测试/规划包。后者必须包含：

- schema version
- digest
- signature
- production lineage
- validation

v3 包导入时必须验证上述字段和 parent lineage，并建立隔离的新 Run；禁止与现态静默混合。包内旧媒体结果不得直接恢复。它仍不是包含批量执行、供应商状态和完整 canonical provenance 的 Production Package。


禁止：

将普通 JSON 描述为：

可信生产包

---

# 10. AI 修改代码行为要求

AI 不允许：

## 1.

为了通过测试降低校验标准。


## 2.

增加关键词白名单绕过真实问题。


## 3.

改变字段含义。


## 4.

把错误隐藏。

例如：

错误：

失败时返回默认值

正确：

明确报错

---

# 11. Bug 修复流程

发现 bug：

必须：

复现
↓
确认调用链、字段职责与事实来源
↓
定位能够解释全部现象的根因
↓
检查合法反例
↓
设计最小修复
↓
增加测试
↓
回放原始失败数据
↓
验证完整流程

`npm test` 通过是必要条件，不代表新引入的业务契约正确。
涉及模型输出时，还必须回放原始失败数据，并验证至少一个合法反例。
禁止：

看到错误日志
直接修改提示词

---

# 12. 测试要求

修改后必须运行：

npm test

如果测试失败：

必须说明：

- 业务失败
- 环境失败
- 测试本身问题


不能简单忽略。


---

# 13. 文档要求

新增架构：

必须同步：

docs/
README.md
AGENTS.md

避免：

代码与文档长期偏离。


---

# 14. 当前最高优先级事项

修改优先级：

## P0

已实现并必须保持：

variant digest
story revision
plan revision
media namespace

- 上游 revision 变化递归标记下游 stale
- request token + expectedCurrentRevision 双层拒绝旧异步回写
- 媒体目录和文件名绑定 project/run/plan revision/digest

---

## P1

Full Story Contract：

修复：

- 角色提及误判
- 临时角色漏检
- careRecipient 漂移
- variant context 绑定


---

## P2

已实现基础能力：

- 导入验证
- 签名机制
- 持久化状态
- 媒体生命周期

尚未实现远端任务接管、批量队列、完整视觉 QA 和成片恢复。

GitHub Benchmark 后续改造必须以 `docs/GitHub-Benchmark-后续改造待办.md` 为执行清单。
每完成一个实施步骤，执行者必须在同一次工作中自动勾选对应子项；只有验收标准全部满足时才能勾选父任务，并填写完成记录。


---

# 15. 最重要原则

修改任何代码之前：

先理解系统。

不要假设。

不要扩大范围。

不要为了让测试通过破坏业务约束。

优先保证：

正确性
一致性
可追踪性
可恢复性

而不是：

代码数量减少
实现速度
表面通过

本项目必须使用 node24 启动，禁止直接使用 25+版本直接运行，在项目运行时，如果修改了服务器相关的文件，自动重启服务器。

供应商错误码提示（`src/provider-error-codes.js`）是纯展示层：把 MiniMax、火山方舟 Ark（Seedance 视频与即梦图片共用）、可灵、阿里云百炼 DashScope（Qwen）、DeepSeek 与小米 MiMo 的官方错误码翻译成可执行中文提示，不影响是否抛错、抛什么错、重试预算或 HTTP 状态码，也不参与任何业务校验。硬规则三条：供应商原文逐字保留在既有 `detail` 字段，解释只放进新增的 `providerError`，不得用友好文案顶替原文；匹配不到一律返回 `null` 让调用方回退原文，禁止编造安慰性描述；码表只抄官方文档，文件头标注出处 URL 与核对日期，不得靠猜测补条目。接入点只有 `src/server-error.js` 的三处错误出口（视频 / 图片 / 文本）。命中依据分供应商业务码与 HTTP 状态兜底两种，展示标签必须如实标明是哪一种；按状态命中时不得把响应体里无关的 `code` 显示成来源。这三处的 `retryable` 跟随官方文档判定。
