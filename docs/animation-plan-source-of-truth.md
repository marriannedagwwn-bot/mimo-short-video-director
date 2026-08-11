# Animation Plan Source-of-Truth Contract

## 0. 当前 `direct_shot` 临时主流程（已确认）

- 当前主流程只在请求显式传入 `animationPlanMode: "direct_shot"` 时启用；输出必须携带 `promptSchemaVersion: "3.0"`，且 `productionStrategy.format` 为 `direct_shot_video`。
- `shotPlan[]` 保留 `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 与 `acceptanceCriteria`。其中 `videoPrompt` 是完整视频渲染指令，其他字段保留各自职责且必须与它一致；冲突时拒绝或重试，不能静默覆盖。
- `shotPlan[]` 禁止五个端点字段：`startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt`；也不得新增 `endStateRef` 等替代端点字段绕过契约。`negativePrompts.image` 必须为 `[]`。
- Full Story 提供叙事事实，已签发的 `fixedCharacterBoundary` 提供固定角色事实，foundation 中的视觉、角色、场景与资产引用提供全局视觉锁；后续镜头不得另造冲突事实。
- `direct_shot` 在每个 source scene 内只按 `sceneScript[].location` 与 `visibleAction` 中的人物主要动作目标确定拆镜边界。地点或主要人物动作目标变化时拆镜；景别、机位、构图、焦段、运镜和转场建议不得新增镜头。`shotAndSound`、`shootingNotes`、`visualBible.cameraLanguage`、`editPlan` 与上一批 `cameraMotion` 只能在镜头边界确定后提供摄影/声音参考。每个 source scene 仍至少对应一个 shot，3–6 秒单镜时长约束保持不变。
- `direct_shot` Foundation 发给模型的输入使用 Full Story 基础事实投影：保留标题、时长、角色 Bible、关键道具、对白规则，以及每场的 `sceneId/timeRange/location/characters/visibleAction/emotionNode/dramaticFunction`；不发送完整 `variant`、完整 `creativeBrief`、`shootingPlan`、`sceneScript[].shotAndSound`、`sceneScript[].shootingNotes` 或场内对白。`variant` 与 `creativeBrief` 仍保留在服务端请求和确定性校验中，不因 Prompt 精简而取消版本绑定或边界摘要校验。
- 已签发的 `fixedCharacterBoundary` 在 Foundation Prompt 中只发送一次；`visualGuardrails` 附加规则不得再次嵌套同一边界对象。
- Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 实现仅保留兼容，不参与当前 `direct_shot` 主流程。
- 视频生成的模式权威字段仍是请求中的 `generationMode`，不得根据端点字段缺失、provider、模型名或素材存在性推断或降级。无端点的 `direct_shot` 不可使用 `first_last_frame`；`all_reference` 仍必须显式选择并提供合法图片或视频，不能只提供音频。

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
