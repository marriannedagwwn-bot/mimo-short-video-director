# Animation Plan Source-of-Truth Contract

## 0. 当前 `direct_shot` 临时主流程（已确认）

- 当前主流程只在请求显式传入 `animationPlanMode: "direct_shot"` 时启用；输出必须携带 `promptSchemaVersion: "3.0"`，且 `productionStrategy.format` 为 `direct_shot_video`。
- 当前 `direct_shot` 的模型内容纠错不得重发完整失败 Foundation、batch 或 Plan。Animation Foundation 只允许对唯一固定角色参考的结构化角色边界错误签发一次 `artifact_partial_repair/1.0` target；H3 批次只允许对结构化 diagnostics 精确定位的一个或多个 `shotPlan[i].videoPrompt` 签发 string targets，而且每个 target 的现有 `integrated_multimodal_description` 必须唯一存在、可独立通过确定性校验并被冻结。“合法 integrated 已存在但缺少 `overall_soundscape` 与 `non_diegetic_music`”可以局修；integrated 缺失、重复或自身不合法时直接失败。服务端独占 path、repairId、mutablePointers、base/authority digest，模型只返回 replacement；合并后必须重跑完整 Foundation/批次/Plan 校验，H3 还要继续执行独立语义审计。没有可信 target 时直接失败，不能从错误消息猜路径或回退整包重生。
- `productionStrategy.videoPromptProfile` 的事实来源是首次生成 Plan 时用户明确选择的 Seedance 2.0 或 MiniMax H3 镜头视频设置；服务端从登记表解析并注入严格的 `{schemaVersion, profileId, provider, model, guideVersion}`，Foundation/shot 模型都不得输出或改写。它由 Plan Prompt 构建器、输出校验、模型切换比较和页面显示消费，表示这一 Plan revision 的 `videoPrompt` 方言与规则来源，不表示运行时 provider/model 锁。浏览器当前镜头视频设置与已签发 Profile 不同时不能自动把任一方当成另一方：保留用户的新设置，同时询问是否改写 Plan；旧 Plan 缺失 Profile 也按 mismatch 处理，禁止从散文、provider 或模型名反推。
- `shotPlan[]` 保留 `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 与 `acceptanceCriteria`。Seedance Profile 的 `videoPrompt` 是模型直接签发的一条自包含中文自然语言完整渲染指令，按“Foundation 风格与物理光线 → 地点环境 → 实际出镜主体与锁定外观 → `visibleAction` 顺序动作链和可见结果 → 内部摄影/剪辑顺序 → 节奏、对白与声音 → 本镜头相关稳定约束和停止条件”组织。MiniMax H3 Profile 的 Plan Prompt 使用 Base/T2VA 三段 `integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`；三个段名必须各自从新行行首开始，并在 JSON 字符串中以 `\n` 转义分隔。三个 section 的叙述必须使用英文；`dialogueOrSubtitle` 保持纯剧情对白且不得含 `<d>`、翻译或拉丁转写，去除说话人前缀后的原文只在 integrated 中逐字包装为 `<d>[Chinese] ...</d>`；英文双引号中逐字保留的画面可见文字也可以使用原语言。`[Shot 1]` 无时间戳，后续 `[Shot N] At MM:SS.mmm` 严格递增且小于当前镜头时长。H3 的内部 `[Shot N]` 只是同一 `A0x` 的摄影/剪辑段，不产生新的 `shotPlan[]`。其他字段保留各自职责且必须与 `videoPrompt` 一致；确定性校验不从散文反推语义，也不选择冲突字段中的任一方，发现冲突必须拒绝或重新生成。
- H3 契约固定依据 MiniMax 官方仓库 [`skills/h3-prompt-writing`](https://github.com/MiniMax-AI/MiniMax-H3/tree/80365054c7fbaace01ed417076fecd532c1ae0e0/skills/h3-prompt-writing) commit `80365054c7fbaace01ed417076fecd532c1ae0e0` 的 `SKILL.md`、`references/base-en.txt` 与 `references/ref-en.txt`；升级时必须显式更新 `guideVersion`、校验、测试和本文，不能自动跟随仓库 HEAD。
- 标识语义必须分开：`sourceSceneId`（页面常见 `S1`）逐字引用当前 Full Story 的剧情场次；`sceneId`（页面常见 `LOC01`）引用 Animation Foundation 的可复用场景视觉参考组；`shotId`（页面常见 `A01`）是当前 Plan revision 内按 `shotPlan[]` 顺序确定的业务生成单元。`S1` 不是场地 ID，`LOC01` 也不保证精确物理坐标或无缝连续；相同 `A01` 在不同 Plan revision/run 中也不是同一个媒体身份。
- `shotPlan[]` 禁止五个端点字段：`startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt`；也不得新增 `endStateRef` 等替代端点字段绕过契约。`negativePrompts.image` 必须为 `[]`。
- Full Story 提供叙事事实，已签发的 `fixedCharacterBoundary` 提供固定角色事实，foundation 中的视觉、角色、场景与资产引用提供全局视觉锁；后续镜头不得另造冲突事实。
- `direct_shot` 在每个 source scene 内只按 `sceneScript[].location` 与 `visibleAction` 中的人物主要动作目标确定业务拆镜边界。地点或主要人物动作目标变化时拆镜；同一地点、围绕同一主要目标组成完整叙事动作的连续阶段必须保留在一条业务 shot 中，不得按动作动词机械拆分。景别、机位、构图、焦段、运镜和转场建议不得新增 `shotPlan[]`。`shotAndSound`、`shootingNotes`、`visualBible.cameraLanguage`、`editPlan` 与上一批 `cameraMotion` 只能在业务边界确定后提供内部摄影/剪辑和声音参考；一条 `videoPrompt` 可按顺序包含连续运镜、景别变化、特写插入或硬切，`cameraMotion` 同步记录完整内部摄影/剪辑顺序。
- 每个 source scene 仍至少对应一个 shot；Seedance Profile 的业务 shot 为 3–6 秒，首次生成 MiniMax H3 Plan 使用项目生产子集 4–6 秒整数。MiniMax V2 运行时协议总体只接受 4–15 秒整数；无论改写还是视频生成，已有不合法时长都必须拒绝，不能静默钳制、补长或缩短。内部摄影变化允许但不强制；必须优先完整呈现权威 `visibleAction`，不能为了兑现所有机位而压缩、跳过或改写动作。使用内部切换时，1–3 条 `acceptanceCriteria` 必须覆盖主要动作链的完整顺序与可见终点，并覆盖关键摄影切换是否命中；失败不能通过静默增加 shot、删除动作或覆盖事实来修复。
- 首次 H3 Foundation 与全部 shot 合并并通过完整契约校验后，服务端必须另行执行逐镜、证据绑定的两层语义审计。服务端目录的权威顺序是验签固定角色 > Full Story 场次/道具用途 > Foundation 视觉锁（包括完整 `assetPrompts`）> 同镜结构化字段 > `videoPrompt`；`shotAndSound`/`shootingNotes` 只提供摄影与声音建议，不要求额外业务镜头或冗余段落结束时间。审计先检查 shot facts，再检查 Prompt；每条 blocker 必须引用同镜受信 ID 与逐字 excerpt，且只能使用会改变实际成片的关系，不能以同义翻译、语法位置、未重复动作或已授权视觉细化为由失败。shot facts fail 时 Prompt 必须 `not_evaluated`；只有所有 shot facts pass 且失败项都属于 `videoPrompt` 时，才可签发一次完整 Prompt string 的有界修复，原子合并后复审目标与相邻镜头，失败不得循环。通过结果只记录为 `metadata.videoPromptSemanticAudit` 校验回执，不改变 Plan JSON，也不是新的事实来源。
- Animation Plan 生成时尚未绑定视频弹窗中的运行时参考素材，因此 `videoPrompt` 不得生成 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>`。素材角色仍由后续显式 `generationMode=all_reference` 请求决定：用户/角色/旧端点素材来自 `referenceAssets[]`；只有用户另行启用 `continuityReferenceMode=previous_shot_frames` 时，服务端才从当前 Plan 的紧邻上一业务镜头 current 视频中以 1 fps 抽帧，并追加为普通 `reference_image`。
- 已有 Plan 切换镜头视频模型时，用户拒绝重写就不修改 Plan、不产生 revision、也不 stale 媒体；新的运行时模型设置仍保留。用户确认后，改写模型只允许返回与现有 shotId 一一对应的 `videoPrompt`，服务端保留所有其他字段并更新 `videoPromptProfile`。完整契约校验之后还必须执行一次独立、只读的事实保真语义审计；协议错误或 verdict 非 `pass` 都阻断提交。只有改写与审计全部成功，才提交新 Plan revision/media namespace 并使旧媒体 stale，任何失败都让旧 Plan 继续 current。首次生成 H3 Plan 和确认 Profile 改写都要求已配置的实时文本模型，demo mock 不得伪造英文翻译、语义审计结果或生产 Profile。合法反例：Seedance Plan 中存在 3 秒镜头时，H3 Prompt-only rewrite 不得改动权威 `durationSeconds`，因此必须失败并要求完整重生 H3 Plan；若拒绝重写则原 Plan 可以保留，但运行时 H3 仍必须拒绝该 3 秒镜头，不能自动拉长。
- 拒绝重写只保留旧事实，不授权运行时把错方言直接发送给新模型。`all_reference + MiniMax H3` 必须匹配当前 Plan 的 exact H3 Profile；Profile 缺失或仍为 Seedance 时，在 Context-IR/视频供应商调用前明确阻断，不自动改 Plan、不 fallback，也不产生付费调用。
- `direct_shot` Foundation 发给模型的输入使用 Full Story 基础事实投影：保留标题、时长、角色 Bible、关键道具、对白规则，以及每场的 `sceneId/timeRange/location/characters/visibleAction/emotionNode/dramaticFunction`；不发送完整 `variant`、完整 `creativeBrief`、`shootingPlan`、`sceneScript[].shotAndSound`、`sceneScript[].shootingNotes` 或场内对白。`variant` 与 `creativeBrief` 仍保留在服务端请求和确定性校验中，不因 Prompt 精简而取消版本绑定或边界摘要校验。
- 已签发的 `fixedCharacterBoundary` 在 Foundation Prompt 中只发送一次；`visualGuardrails` 附加规则不得再次嵌套同一边界对象。
- Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 实现仅保留兼容，不参与当前 `direct_shot` 主流程。
- 视频生成的模式权威字段仍是请求中的 `generationMode`，不得根据端点字段缺失、provider、模型名或素材存在性推断或降级。请求必须绑定当前签发 Plan，服务端以其中的 exact shot 决定时长、动作、场景、声音、负面词和验收条件；弹窗可编辑文本只能作为显式 `promptOverride` 覆盖本次媒体的 `videoPrompt`，不能用客户端 shot 对象改写其他权威字段。无端点的 `direct_shot` 不可使用 `first_last_frame`；`all_reference` 仍必须显式选择并提供合法图片或视频，不能只提供音频。上一镜抽帧属于运行时弱参考，不是 Story、场景、角色或已完成动作的事实源；当前镜头的 Full Story/Plan、`fixedCharacterBoundary` 与 Foundation 场景锁发生冲突时，它们优先，用户应取消该参考或重新锚定，不能让上一镜画面反向覆盖当前镜头。
- MiniMax H3 `all_reference` 的 Ref2VA Prompt 只在用户点击生成、且本次请求的实际引用、顺序、角色和内容摘要被冻结后，经供应商计费的异步步骤 `POST /v2/h3_context_ir` 编译；模型切换、取消 Profile 改写或仅打开弹窗不能触发它。返回值必须严格包含 `subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music` 六个英文 section，原语言例外与 Base 相同；`<Picture/Video/Audio N>` 必须与同类实际素材顺序逐项绑定，`<Subject N>` 必须在 `subject_definitions` 中由当前签发主体或实际引用明确定义，任何标签不得悬空。图片只定义角色、场景、服装或风格时，`<Picture N>` 只能作为来源内嵌在对应 Subject definition；当前普通 `all_reference` 不授权独立 Picture keyframe/storyboard definition 或 retention。普通参考的 `summary` 只允许 `[reference generation]` 或实际有音频时的 `[reference generation + audio reference]`。上一镜帧必须描述为一致性 weak reference/reference-generation，禁止被归类成 editing、continuation、关键帧或 fully-preserved 内容。本地先确定性校验格式、时间线、标签、retention 与角色边界，并以字符脚本屏障拒绝非 Latin script 的正文；该屏障不能证明正文确为英文。服务端随后必须执行只读的 Context-IR 语义一致性审计并明确检查 `language_format`；非英文、无法确认、审计协议错误或 verdict 非 `pass` 时不得调用最终视频生成。Context-IR 可补足未指定细节，因此它不是 Story、Plan 或第二份角色事实源；请求失败、六段契约不合法、引用错绑或扩写与权威事实冲突时必须中止生成，不能 fallback 到 Base 三段、Seedance Prompt 或通用散文。权威顺序为：用户对“是否重写”的明确选择只控制 Plan revision；当前签发 Full Story/exact shot、`fixedCharacterBoundary` 与 Foundation 锁控制内容事实；冻结参考 manifest 控制引用编号和角色；`videoPromptProfile` 控制方言；Context-IR 输出最低且不得反向覆盖上游。

以下章节只记录旧 v2 首尾帧兼容路径尚未解决的语义问题，不得据此反推或补齐 `direct_shot` 字段。

## 1. 旧 v2 兼容字段语义

### startFrame.environment
待确认：
- 是稳定场景状态，还是当前首帧可见的环境层？
- 是否允许活动环境元素？
- 是否允许剧情道具？
- 是否允许角色或角色身体部分？

### endFrame.environment
待确认：
- 是对 startFrame.environment 的完整快照，还是只描述终点差异？
- 无真实变化时是否要求逐字复制？
- 逐字复制是数据契约还是 Prompt 优化策略？

### motion.environmentChange
待确认：
- 是权威变化声明？
- 是从首尾状态派生的摘要？
- 还是仅用于生视频的自然语言指令？

## 2. Source-of-truth hierarchy

必须明确：

1. Full Story 的哪些字段表示叙事事实。
2. `visibleAction`、`primaryAction`、`timingBeats` 的优先关系。
3. startFrame/endFrame 是事实源还是派生投影。
4. motion 是事实源还是连接描述。
5. 冲突时谁可以覆盖谁。
6. 哪些冲突只能 retry，不能 deterministic repair。

## 3. Environment change taxonomy

分别定义：

- 场景结构变化；
- 天气变化；
- 光线变化；
- 大气和粒子变化；
- 门窗、灯具、炊烟等环境对象变化；
- 可移动剧情道具变化；
- 角色动作；
- 镜头和构图变化；
- 仅文字改写、语义不变。

## 4. Transition strategy

明确 `inherit / transition / independent` 分别依据什么选择：

- camera；
- environment；
- lighting；
- time/weather；
- narrative action；
- manual override。

## 5. Conflict policy

为每一种冲突明确：

- reject；
- retry；
- deterministic repair；
- require explicit product decision。

## 6. Allowed repairs

逐项列出能唯一推导、无信息损失的修复。

## 7. Forbidden repairs

至少包括：

- 根据冲突字段单方面覆盖另一字段；
- 根据自由文本字符串不同直接断言真实环境变化；
- 在来源优先级未确定时静默删除尾帧状态。
