# CLAUDE.md

Claude Code 在本仓库的工作规则。

**`AGENTS.md` 是完整契约正文与唯一事实来源。** 本文件是它的操作性精修：保留会改变行为的硬约束，删去重复叙述。两者冲突时以 `AGENTS.md` 为准；任何一方变更必须同步另一方。涉及具体字段语义时，先回到 `AGENTS.md` 对应章节读原文，不要只凭本文件的摘要下判断。

---

## 项目速览

`mimo-short-video-director` — AI 短视频生产工作流系统。

当前主流程（唯一在跑的链路）：

```
Analyze → Reconstruct → Brief → Visual Guardrails → Variants
       → Legacy Full Story → Animation Plan direct_shot (promptSchemaVersion 3.0)
       → Video Generation
```

Production Lineage v1 作为服务端 sidecar 并行运行：每次浏览器主流程创建独立 project/run，各成功阶段提交 Artifact revision、content digest、上游 dependencies、Stage 状态与 Checkpoint。**它不改变模型字段含义，不是第二份剧情或角色事实来源。**

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

### 2.3 拆镜规则

- 场内拆镜**只依据** Full Story 的 `location` 与 `visibleAction` 中的人物主要动作目标。地点或主要动作目标变化时拆镜。
- 同一地点、围绕同一主要动作目标构成完整叙事动作的连续阶段，保留为**一条**业务 shot；不得按动作动词机械拆分。
- 景别、机位、构图、焦段、运镜、转场只决定已划定 shot **内部**的摄影/剪辑表达，**不得增加 `shotPlan[]`**。同一 `videoPrompt` 可按顺序描述中景跟随 → 关键动作特写 → 硬切 → 结尾宽景。
- `shotAndSound` 与 `shootingNotes` **不是**镜头数量的事实源。每个 source scene 至少一镜。
- 时长：Seedance Profile 单镜 3–6 秒；MiniMax H3 Profile 单镜 4–6 秒整数（H3 运行时协议本身接受 4–15 秒整数，已有值不合法必须拒绝，不得钳制、补长或缩短）。
- 内部摄影变化允许但不强制。**不得为了堆机位压缩、跳过或改写 `visibleAction`。**

### 2.4 `productionStrategy.videoPromptProfile`

服务端根据用户首次生成 Plan 时明确选择的镜头视频模型签发的 **Plan 级提示词方言/来源记录**，严格包含 `schemaVersion` / `profileId` / `provider` / `model` / `guideVersion`。

- 它**不是**运行时 provider/model 锁。**模型不得输出、推断或修改它。**
- **Seedance**：`videoPrompt` 是一条自包含、可直接交给视频模型的中文自然语言完整提示词，按「Foundation 风格与物理光线 → 地点环境 → 出镜主体与已锁定外观 → `visibleAction` 顺序动作链与可见结果 → 内部摄影/剪辑顺序 → 节奏、对白和声音 → 稳定约束与停止条件」组织。
- **MiniMax H3**：必须使用三个官方英文段名 `integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`；每段名从**独立新行行首**开始，JSON 原文用 `\n` 转义分隔，禁止多个段名同行。叙述使用英文，仅 `<d>` 内逐字保留的原语言对白/歌词与英文双引号内的画面可见文字可用原语言。`dialogueOrSubtitle` 保持跨供应商共享的上游纯剧情对白，**不得**写 `<d>`、翻译或拉丁转写；去除说话人前缀后的中文原文只在 `integrated_multimodal_description` 中包装为 `<d>[Chinese] ...</d>`。`[Shot 1]` 不带时间戳，后续 `[Shot N] At MM:SS.mmm` 严格递增且小于 `durationSeconds`；`[Shot N]` 是同一 `A0x` 内部剪辑段，**不是新的业务 shot**。
- Plan 阶段两种 Profile 都不得生成尚未绑定的 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>`。
- H3 Prompt 契约固定到官方 `MiniMax-AI/MiniMax-H3` 仓库 commit `80365054c7fbaace01ed417076fecd532c1ae0e0` 的 `skills/h3-prompt-writing`。**不得自动跟随 HEAD**；升级必须同步改 `guideVersion`、文档、校验和测试。

### 2.5 切换镜头视频模型 / 切换画幅

**切换模型**：页面先保留新的运行时选择，再比较目标 Profile 与已签发 `videoPromptProfile` 并询问是否重写。缺失 Profile 的旧 Plan 同样视为 mismatch，**禁止从 Prompt 文本、provider 或模型名反推**。

- 拒绝：不改 Plan、不签发 revision、不 stale 媒体、不回滚新模型设置。
- 确认：**只能**重写全部 `shotPlan[].videoPrompt` 并更新 Profile，其他字段逐字保留；改写结果须通过完整契约校验 + 证据绑定语义审计后才签发新 Plan revision/media namespace 并 stale 旧媒体。任何失败都保留旧 Plan current。
- 合法反例：Seedance Plan 含 3 秒镜头时，切到 H3 **不能**靠改写 Prompt 把 `durationSeconds` 静默改成 4 秒；确认改写必须失败并要求完整重生 H3 Plan，而该 3 秒镜头也不得提交给 H3。
- 拒绝重写**不授权运行时方言降级**：`all_reference + MiniMax H3` 只允许消费 exact H3 Profile；Profile 缺失或仍为 Seedance 时，必须在 Context-IR 与视频供应商调用前明确失败。

**切换画幅**：`targetAspectRatio` 只允许 `9:16` 或 `16:9`，首次生成锁入 `productionStrategy.targetAspectRatio` 并与 Foundation 一致。已有 Plan 切换画幅时**不调用模型、不重写 shot**，但必须签发新 Plan revision/media namespace 并 stale 旧画幅媒体。不得向 direct-shot 的 exact shot 增加 `aspectRatio`。页面计划总长由 `shotPlan[].durationSeconds` 合计派生，`targetRuntimeSeconds` 仍是上游目标，两者不得互相覆盖。

### 2.6 视频生成模式

| 模式 | 语义 | 可用供应商 |
| --- | --- | --- |
| `first_last_frame` | 首尾帧是精确端点 | Kling / Seedance / MiniMax H3 |
| `all_reference` | 图片/视频/音频仅作多模态参考，须至少含合法图片或视频（不能只有音频） | 仅 Seedance 2.0 与 MiniMax H3 |

- 模式**只**由请求 `generationMode` 决定。**不得**根据端点字段缺失、provider、模型名或素材存在性自动推断或降级。
- 无端点的 `direct_shot` 不可用 `first_last_frame`，必须明确失败。
- `all_reference` 不得混用 `first_frame` / `last_frame`，不得把可灵 image-to-video 静默当作 Omni API。
- `continuityReferenceMode: "none" | "previous_shot_frames"` 是独立的运行时开关，**不改变也不推断 `generationMode`**，也不是 `direct_shot` Schema 字段。启用时：上一镜只由当前 Plan `shotPlan[]` 紧邻前项确定；服务端读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，用 FFmpeg 每秒抽 1 张 JPEG 作为普通 `reference_image`，与其他图片共同受 9 图上限约束，超限明确失败。它只增强一致性，**不能覆盖**当前 Full Story/Plan、`fixedCharacterBoundary` 或 Foundation 场景事实。
- `POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不得依据客户端自报 `animationPromptSchemaVersion` 降级为无 lineage 请求。服务端从 Plan 唯一解析 exact shot；只允许 `promptOverride` 覆盖本次媒体提示词，动作/时长/场景/声音/负面词/验收条件仍来自 Plan。输出文件名必须含不可碰撞的请求 nonce，返回前须过 ffprobe 视频流/时长校验。

### 2.7 MiniMax H3 Context-IR

必须在实际引用冻结后**显式**调用 `POST /v2/h3_context_ir`，**不得在 Plan 阶段预编译**。这是用户点击生成后才发生的供应商计费异步步骤——保存/切换模型、取消 Profile 改写、仅打开生成弹窗都不得调用。

- 输入引用的角色、顺序、内容摘要必须与随后的视频请求完全相同。
- 返回 Prompt 必须严格校验六个英文 section：`subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music`。
- 标签绑定：`<Picture/Video/Audio N>` 与同类实际素材顺序逐项绑定；`<Subject N>` 必须在 `subject_definitions` 中由签发主体或实际引用明确定义；**任何标签不得悬空**。
- 签发角色图只能作为来源**内嵌**在对应 `<Subject N>` definition，不得建立独立 Picture definition 或 retention；来源全部为签发 `character_reference` 的角色-only Subject 在 `retention_analysis` 使用精确 marker `fully_preserved`。该 marker **只锁定身份与外观**，不锁定姿势、动作、构图、背景——角色执行当前镜头新动作不构成保留降级。
- 某签发角色图实际进入本次冻结 manifest 时，它就是该角色的静态外观来源：不得再把静态发色、五官、体型、常规服饰、画风重复写进最终六段 Prompt（这些文字仅在角色图未实际发送时作为 fallback）。此例外**不删除**当前镜头的动作、姿势、表情、道具、场景、摄影、声音，或剧情要求的动态外观变化（如穿上雨衣、被雨淋湿）；角色图也**绝不能覆盖** `fixedCharacterBoundary` 的身份、物种或必需特征，冲突必须失败。
- 普通上传与上一镜素材绑定到独立弱参考 Subject，marker 为 `weak_reference`，**不得**与签发角色图混绑到同一 Subject。普通参考的 `summary` 只允许 `[reference generation]` 或实际有音频时的 `[reference generation + audio reference]`。上一镜抽帧只能是一致性 weak reference，禁止解释成 editing / continuation / 关键帧 / fully-preserved。
- 本地确定性检查负责六段结构、标签、retention、边界、时间线、对白，并在排除允许的原语言内容后拒绝非 Latin script；**该字符屏障不能证明其余散文是英文**，随后必须由已配置文本模型执行只读语义一致性审计并明确检查 `language_format`。非英文、无法确认、审计协议错误或 verdict 非 `pass` 时**不得**调用最终视频生成。
- Context-IR 失败、结构不合法、引用错绑或扩写冲突必须中止本次生成，**不得**回退到 Base 三段、Seedance Prompt 或通用散文。
- 权威优先级：用户"是否重写"的明确决定 控制 Plan revision > 当前签发 Full Story/exact shot、`fixedCharacterBoundary`、Foundation 锁 控制内容事实 > 冻结参考 manifest 控制引用编号/角色 > Plan Profile 控制方言 > **Context-IR 扩写最低，不能反向覆盖上游**。

### 2.8 模型 provider 边界

工作流 LLM provider：**Qwen / MiMo / DeepSeek**。

DeepSeek **只允许**用于纯文本阶段：Brief、Variants、Legacy Full Story、Animation Plan、Static Frame Compiler（仅旧 v2 兼容路径）。

**禁止** DeepSeek 用于需要图片或视频输入的阶段：Analyze、Reconstruct、Visual Guardrails、Character Reference。

DeepSeek 模型 ID 只登记 `deepseek-v4-flash`（页面首选）与 `deepseek-v4-pro`（只能显式选择）。不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。

首次生成 MiniMax H3 Plan 与确认 Profile 改写**必须使用已配置的实时文本模型**；demo mock 不得伪造英文翻译、语义审计结果或生产 Profile。

### 2.9 全局角色边界

- `Visual Guardrails` 是固定角色语义的**唯一生成阶段**。允许视觉模型结合用户设定、参考分析、脚本还原、创意简报与模型常识生成开放语义边界；**不得新增本地物种关键词字典替代模型判断**。
- 服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、视频生成，以及旧 v2 兼容路径的**唯一**固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份边界。
- 生产环境必须校验 `boundarySignature`。**仅当**服务端显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test|development` 且 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时可跳过 HMAC 比较（`sourceDigest` 与 `boundaryDigest` 仍必须匹配）。该策略**只能来自服务端环境，禁止由请求体控制**。
- 冲突优先级：**用户明确肯定/否定 > 已签发模型推断**。无法消解的冲突必须阻断，不能静默选边。用户或权威上游数据改变后，旧边界必须失效并重新生成。

### 2.10 来源字段表达规则

- Creative Brief 的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression`，以及 Visual Guardrails 的 `sourceSimilarityRules.sourceExpression`，在列举同类多个具体物品时**每一项都必须重复完整中心名词**（"绿色邮箱、红色邮箱、蓝色邮箱"），禁止"绿色、红色、蓝色邮箱（组合）"式缩写。该规则只规范已有来源事实，**不授权补充新物品**；下游也不得靠颜色词或中文语法猜被省略的名词。旧 Artifact 含歧义缩写时必须**重新生成对应上游阶段**，不能原地推断或改写已签发内容。
- `allowedNarrativeComponents[].component` 是服务端固定的**七项 taxonomy**：送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾。Prompt 必须展开完整七项；模型只能填每项非空的 `howToReuseSafely`，**不得改名、合并、省略、重复或增加**。不适用时也必须保留该项并说明不采用或限制条件。**每条 `howToReuseSafely` 必须以 `【原片有】` 或 `【原片没有】` 开头**作出存在性判定（只陈述上游已发生的事实，不描述新片打算怎么拍），缺前缀即确定性失败——防止模型把"新片可以怎么用"写成复用授权，替原片补出它没有的构件。数组顺序不承载业务语义。七项名称由服务端常量与 validator **共用**，禁止在 Prompt、Mock 或校验器中各自维护第二份列表。
- 上述来源字段与 `sourceSimilarityRules` 只是原片表面表达的 provenance，**不是下游正文禁词**。原片道具、拟声词、角色组合允许按当前选定剧情出现在任意正向业务字段（含 `visibleAction`、对白、声音、`videoPrompt`）；但不得仅因它们存在于来源上下文就机械注入下游。`sourceSimilarityRules` 只在实际生成请求确实携带原片参考时为 `reference_leak` 提供证据。`dialogueRules` 只能来自用户明确约束，不得把原片对白或拟声词自动升级为对白规则。该放行不改变 `fixedCharacterBoundary` 的优先级。

### 2.11 Story Contract

每个 scene 必须有：`sceneId`、`location`、`characters`、`visibleAction`、`shotAndSound`。

`characters` = **本场实际出镜角色**，不是被提及的人、地点名称、道具归属或回忆对象。

```
"铃木奶奶站在院子里浇花"  → characters: ["铃木奶奶"]   ✅
"铃木奶奶家的门口"        → 不能认为铃木奶奶出镜        ❌
```

角色一致性禁止项：自动新增未登记主要角色、修改 variant 中已有角色身份、修改 `careRecipient`、修改 `protagonist`。任何角色变化必须明确登记、明确理由、明确影响范围。

### 2.12 职责隔离

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Full Story | 叙事结构、角色、场景、对白、剧情逻辑 | 镜头动画实现、动作生成、视频生成 |
| Animation Plan | 镜头拆分、直接视频渲染提示词、角色动作与内部摄影/剪辑与声音设计、镜头连续性与动画约束 | 重新创作剧情、修改角色身份、改变故事主题 |

Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：**暂时弃置**，旧 v2 代码保留兼容但不参与当前 `direct_shot` 主流程。

### 2.13 状态隔离

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
| `artifact_partial_repair/1.0` | Animation Foundation 唯一固定角色参考的 `requiredTraits` 缺失/禁止特征命中；MiniMax H3 生成批次中的受信段落错误 |
| `animation_video_prompt_semantic_repair/1.0` | 证据绑定审计确认**全部结构化 shot facts 通过后**的纯 `videoPrompt` 实质冲突 |

### 通用协议约束

- 服务端**独占**私有签发身份、`baseDigest`、authorityDigest、repairId、目标 path、mutablePointers 与 authority。模型取得的序列化计划不能作为可合并计划。
- 第二次模型请求只发送：目标 currentValue、diagnostics、修复说明、最小权威投影。
- 模型只能返回等量、同序 `{repairId, replacement}`。**不得返回 path、op、完整 Artifact 或额外字段。**
- 服务端必须在 clone 上原子合并，证明目标内未授权事实与全部目标外数据不变，重新投影并验证当前 authority，然后**从头执行该阶段完整 Schema、角色、剧情与跨字段校验**。
- 语义 Prompt 修复另允许且**只允许一次**相邻镜头复审；复审失败即终止，不得再次修复或整包 fallback。
- Foundation 仅缺必需事实时必须冻结 `appearancePrompt` 和已有 `consistencyTags`，只能在标签尾部按签发顺序追加缺失 trait 的 exact `canonicalName`，不能用同义词、重排或改写外观代替。禁止词诊断只授权实际命中的字段做最小删除。
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
| `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` | Animation Plan 原始 completion，固定 `scope=animationPlan`，覆盖 Foundation、每批 shot、实际发生的 H3 段落纠错与语义修复、首次审计与复审 |

统一约束：

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
