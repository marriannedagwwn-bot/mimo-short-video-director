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
Variants
 ↓
Legacy Full Story
 ↓
Animation Plan direct_shot（promptSchemaVersion 3.0）
 ↓
Video Generation

上述业务 JSON 之外，Production Lineage v1 作为服务端 sidecar 运行：每次浏览器主流程创建独立 project/run；各成功阶段提交 Artifact revision、content digest、实际上游 dependencies、Stage 状态与 Checkpoint。它不改变模型字段含义，也不是第二份角色或剧情事实来源。

Variant 内容变化必须递归使旧 Full Story、Animation Plan 和媒体 Artifact stale。模型请求开始时冻结依赖 revision，返回时同时经过浏览器 request token 与服务端 `expectedCurrentRevision`/dependency 校验。Animation Plan 每个 revision 签发独立 media namespace。

当前 `direct_shot` 必须由请求显式传入 `animationPlanMode: "direct_shot"`，且 `productionStrategy.format` 为 `direct_shot_video`。每个 shot 保留 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes` 以及镜头标识、时长、剧情目的、负面词和验收标准；禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段。

镜头标识不得混淆：`sourceSceneId`（常见 `S1`）是当前 Full Story 的剧情场次归属；`sceneId`（常见 `LOC01`）是 Foundation 场景视觉参考组；`shotId`（常见 `A01`）是当前 Plan revision 内的业务镜头顺序标识。`S1` 不是场地，`LOC01` 不保证精确物理地点或无缝连续，`A01` 也不能脱离 project/run/plan revision/digest 单独标识媒体。

当前 `direct_shot` 的场内拆镜只依据 Full Story 的 `location` 与 `visibleAction` 中的人物主要动作目标。地点或主要动作目标变化时拆镜；同一地点、围绕同一主要动作目标组成完整叙事动作的连续阶段保留为一条业务 shot，不得按动作动词机械拆分。景别、机位、构图、焦段、运镜和转场建议只能决定已划定业务 shot 内部的摄影/剪辑表达，不得增加 `shotPlan[]`；同一 `videoPrompt` 可以按顺序描述中景跟随、关键动作特写、硬切或结尾宽景。`shotAndSound` 与 `shootingNotes` 不是镜头数量的事实源。每个 source scene 至少一镜及 3–6 秒单镜时长约束保持不变；内部摄影变化允许但不强制，不能为了堆机位而压缩、跳过或改写 `visibleAction`。

`direct_shot.videoPrompt` 必须是一条自包含、可直接交给视频模型的中文自然语言完整提示词，按“Foundation 风格与物理光线 → 地点环境 → 实际出镜主体与已锁定外观 → `visibleAction` 顺序动作链与可见结果 → 内部摄影/剪辑顺序 → 节奏、对白和声音 → 本镜头相关稳定约束与停止条件”组织。它不得生成尚未与当前视频请求绑定的 `@图片/@视频/@音频` 编号。`cameraMotion` 应同步记录业务 shot 内完整的摄影与剪辑顺序，不再限定为单一连续运镜。使用内部切换时，1–3 条 `acceptanceCriteria` 必须覆盖主要动作链顺序、可见终点和关键摄影切换；失败不得静默增加 shot 或删除动作。

Animation Plan 的 `targetAspectRatio` 当前只允许 `9:16` 或 `16:9`。首次生成时必须锁入 `productionStrategy.targetAspectRatio` 并与 Foundation 输出一致；已有 Plan 切换画幅时以用户选择更新计划级输出事实，不调用模型、不重写 shot，但必须签发新 Plan revision/media namespace，使旧画幅媒体 stale。后续视频生成从当前签发 Plan 读取；不得向 direct-shot 的 exact shot 字段增加 `aspectRatio`。页面的计划总长由 `shotPlan[].durationSeconds` 合计派生，`targetRuntimeSeconds` 仍是上游目标，不得互相覆盖。

Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 代码保留兼容，但不参与当前 `direct_shot` 主流程。

视频生成存在两个显式模式：

- `first_last_frame`：首尾帧是精确端点，Kling、Seedance、MiniMax H3 可用；无端点的 `direct_shot` 不可使用，必须明确失败。
- `all_reference`：图片/视频/音频仅作为多模态参考，必须至少包含合法图片或视频，不能只输入音频；当前只允许 Seedance 2.0 与 MiniMax H3，不得混用 `first_frame` / `last_frame`，不得把可灵 image-to-video 静默当作 Omni API。

模式由请求 `generationMode` 决定，不得根据端点字段缺失、provider、模型名或素材存在性自动推断或降级。

`all_reference` 可另行显式传入运行时 `continuityReferenceMode: "none" | "previous_shot_frames"`；它不得改变或推断 `generationMode`，也不是 `direct_shot` Schema 字段。启用 `previous_shot_frames` 时，上一镜只由当前 Plan `shotPlan[]` 的紧邻前项确定；服务端必须读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，并用 FFmpeg 每秒抽取一张 JPEG 作为普通 `reference_image`。实际抽帧与其他图片共同受 9 图上限约束，超限明确失败。该参考只增强一致性，不能覆盖当前 Full Story/Plan、`fixedCharacterBoundary` 或 Foundation 场景事实；跨地点、跨时段或上一镜漂移是关闭该开关的合法反例。

`POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不能依据客户端自报 `animationPromptSchemaVersion` 降级为无 lineage 请求。服务端从 Plan 唯一解析 exact shot；只允许独立 `promptOverride` 覆盖本次媒体提示词，动作、时长、场景、声音、负面词和验收条件仍来自 Plan。输出文件名必须包含不可碰撞的请求 nonce，并在返回前通过 ffprobe 视频流/时长校验。

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

服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、视频生成，以及旧 v2 兼容路径中 Character Feature Compiler 和首尾帧生成的唯一固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份角色边界。

生产环境必须校验 `fixedCharacterBoundary.boundarySignature`。仅当服务端显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test|development` 且 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时，为支持重启后继续回放本地测试包，可以跳过 HMAC 签名比较；`sourceDigest` 与 `boundaryDigest` 仍必须匹配。该策略只能来自服务端环境，禁止由请求体控制。

冲突优先级：用户明确肯定/否定 > 已签发模型推断。无法消解的冲突必须阻断，不能选择任一方静默覆盖。用户或权威上游数据改变后，旧边界必须失效并重新生成。

---

# 2. Full Story 架构说明

## 当前存在

当前项目使用：

Legacy Full Story

负责：

- 生成完整剧情
- 输出 sceneScript
- 提供 Animation Plan 输入


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

---

## Animation Plan

当前主流程为显式 `animationPlanMode: "direct_shot"`，输出 `promptSchemaVersion: "3.0"`。shot 保留 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes` 等直接视频字段，禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段；`negativePrompts.image` 必须为 `[]`。

只有维护旧 v2 兼容路径、涉及 startFrame、endFrame、environment、motion、environmentChange、inherit 或 transition 的语义修改前，必须先阅读：

`docs/animation-plan-source-of-truth.md`

如果文档没有明确旧 v2 字段的事实来源和冲突优先级，
不得自行补充解释或实施确定性修复。
负责：

镜头拆分
直接视频渲染提示词
角色动作、内部摄影/剪辑和声音设计
镜头连续性与动画约束

不负责：

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
