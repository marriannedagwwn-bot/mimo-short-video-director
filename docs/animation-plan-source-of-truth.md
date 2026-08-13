# Animation Plan Source-of-Truth Contract

## 0. 当前 `direct_shot` 临时主流程（已确认）

- 当前主流程只在请求显式传入 `animationPlanMode: "direct_shot"` 时启用；输出必须携带 `promptSchemaVersion: "3.0"`，且 `productionStrategy.format` 为 `direct_shot_video`。
- `shotPlan[]` 保留 `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 与 `acceptanceCriteria`。其中 `videoPrompt` 是模型直接签发的一条自包含自然语言完整视频渲染指令，按“Foundation 风格与物理光线 → 地点环境 → 实际出镜主体与锁定外观 → `visibleAction` 顺序动作链和可见结果 → 内部摄影/剪辑顺序 → 节奏、对白与声音 → 本镜头相关稳定约束和停止条件”组织。其他字段保留各自职责且必须与它一致；现有确定性校验不从散文反推语义，也不选择冲突字段中的任一方，发现冲突时必须拒绝结果或重新生成，不能静默覆盖。
- 标识语义必须分开：`sourceSceneId`（页面常见 `S1`）逐字引用当前 Full Story 的剧情场次；`sceneId`（页面常见 `LOC01`）引用 Animation Foundation 的可复用场景视觉参考组；`shotId`（页面常见 `A01`）是当前 Plan revision 内按 `shotPlan[]` 顺序确定的业务生成单元。`S1` 不是场地 ID，`LOC01` 也不保证精确物理坐标或无缝连续；相同 `A01` 在不同 Plan revision/run 中也不是同一个媒体身份。
- `shotPlan[]` 禁止五个端点字段：`startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt`；也不得新增 `endStateRef` 等替代端点字段绕过契约。`negativePrompts.image` 必须为 `[]`。
- Full Story 提供叙事事实，已签发的 `fixedCharacterBoundary` 提供固定角色事实，foundation 中的视觉、角色、场景与资产引用提供全局视觉锁；后续镜头不得另造冲突事实。
- `direct_shot` 在每个 source scene 内只按 `sceneScript[].location` 与 `visibleAction` 中的人物主要动作目标确定业务拆镜边界。地点或主要人物动作目标变化时拆镜；同一地点、围绕同一主要目标组成完整叙事动作的连续阶段必须保留在一条业务 shot 中，不得按动作动词机械拆分。景别、机位、构图、焦段、运镜和转场建议不得新增 `shotPlan[]`。`shotAndSound`、`shootingNotes`、`visualBible.cameraLanguage`、`editPlan` 与上一批 `cameraMotion` 只能在业务边界确定后提供内部摄影/剪辑和声音参考；一条 `videoPrompt` 可按顺序包含连续运镜、景别变化、特写插入或硬切，`cameraMotion` 同步记录完整内部摄影/剪辑顺序。
- 每个 source scene 仍至少对应一个 shot，3–6 秒业务 shot 时长约束保持不变。内部摄影变化允许但不强制；必须优先完整呈现权威 `visibleAction`，不能为了兑现所有机位而压缩、跳过或改写动作。使用内部切换时，1–3 条 `acceptanceCriteria` 必须覆盖主要动作链的完整顺序与可见终点，并覆盖关键摄影切换是否命中；失败不能通过静默增加 shot、删除动作或覆盖事实来修复。
- Animation Plan 生成时尚未绑定视频弹窗中的运行时参考素材，因此 `videoPrompt` 不得生成 `@图片/@视频/@音频` 编号。素材角色仍由后续显式 `generationMode=all_reference` 请求决定：用户/角色/旧端点素材来自 `referenceAssets[]`；只有用户另行启用 `continuityReferenceMode=previous_shot_frames` 时，服务端才从当前 Plan 的紧邻上一业务镜头 current 视频中以 1 fps 抽帧，并追加为普通 `reference_image`。
- `direct_shot` Foundation 发给模型的输入使用 Full Story 基础事实投影：保留标题、时长、角色 Bible、关键道具、对白规则，以及每场的 `sceneId/timeRange/location/characters/visibleAction/emotionNode/dramaticFunction`；不发送完整 `variant`、完整 `creativeBrief`、`shootingPlan`、`sceneScript[].shotAndSound`、`sceneScript[].shootingNotes` 或场内对白。`variant` 与 `creativeBrief` 仍保留在服务端请求和确定性校验中，不因 Prompt 精简而取消版本绑定或边界摘要校验。
- 已签发的 `fixedCharacterBoundary` 在 Foundation Prompt 中只发送一次；`visualGuardrails` 附加规则不得再次嵌套同一边界对象。
- Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 实现仅保留兼容，不参与当前 `direct_shot` 主流程。
- 视频生成的模式权威字段仍是请求中的 `generationMode`，不得根据端点字段缺失、provider、模型名或素材存在性推断或降级。请求必须绑定当前签发 Plan，服务端以其中的 exact shot 决定时长、动作、场景、声音、负面词和验收条件；弹窗可编辑文本只能作为显式 `promptOverride` 覆盖本次媒体的 `videoPrompt`，不能用客户端 shot 对象改写其他权威字段。无端点的 `direct_shot` 不可使用 `first_last_frame`；`all_reference` 仍必须显式选择并提供合法图片或视频，不能只提供音频。上一镜抽帧属于运行时弱参考，不是 Story、场景、角色或已完成动作的事实源；当前镜头的 Full Story/Plan、`fixedCharacterBoundary` 与 Foundation 场景锁发生冲突时，它们优先，用户应取消该参考或重新锚定，不能让上一镜画面反向覆盖当前镜头。

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
