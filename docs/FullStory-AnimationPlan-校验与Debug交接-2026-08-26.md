# Full Story / Animation Plan 校验与 Debug 交接

收件人：后续维护与排障人员  
日期：2026-08-26（Asia/Taipei）  
主题：Legacy Full Story 与 `direct_shot` Animation Plan 校验现状、历史故障和待处理问题

## 一、交接结论

当前系统不是“没有校验”，而是已经建立了较完整的结构、角色边界、镜头骨架和局部纠错门禁。真正需要优先处理的是三类问题：

1. **运行版本发生回退。** 当前服务器对应 detached HEAD `7d83dc2`，而 `dev` 已到 `649c1d1`。Full Story 场次 4–15 秒前置校验、单镜主体锁定和景别单向校验只在后续提交中存在，当前重启后的服务并未加载。
2. **首次 Animation Plan 语义审计已断开。** 审计实现仍在，但当前 `createAnimationPlanWithMetadata()` 合并并校验 Plan 后直接返回，没有调用 `auditInitialAnimationVideoPromptSemantics()`。Debug 中 47 次首次审计均发生在旧 MiniMax H3 方言退役之前，不能证明当前主流程仍有这道门。
3. **部分确定性规则过度依赖词面。** 2026-08-26 的 A02 把“表演节奏轻快舒缓交替”中的“交替”误判为拍摄主体切换；但切回当前 HEAD 后，这道门整体消失，又让真正的“硬切”和多主体切换重新通过。现状不是简单的“规则太严”或“规则太松”，而是两种问题同时存在。

建议接手者先固定预期部署版本，再修规则；不要直接根据某一条历史 Debug 修改 Prompt 或删除校验词。

## 二、审计基线与版本边界

### 2.1 当前实际基线

| 项目 | 当前状态 |
|---|---|
| 工作区 | `/Users/qinfen/Downloads/mimo-short-video-director-master` |
| 当前 HEAD | `7d83dc2cd6e72ed5082ded6d56645aacb55ef4e0` |
| HEAD 状态 | detached HEAD |
| 当前提交 | `fix: keep required character facts through reference-image refinement` |
| `dev` | `649c1d1adc3b864a4d7dfe0b88e5a4f00dd55f30` |
| 审计时工作区 | 仅有用户原先的未跟踪文件 `会话总结-2026-08-20.md`；本次未修改 |
| 校验测试 | 8 个目标测试文件，共 105 项，全部通过 |

当前服务器在切回 `7d83dc2` 后重新启动，因此“当前生效”以该 HEAD 的调用链为准，不以 `AGENTS.md`、设计文档或旧 Debug 的描述为准。

### 2.2 当前 HEAD 之后的关键提交

| 提交 | 内容 | 当前服务器是否生效 |
|---|---|---|
| `9c0f29d` | Prompt 要求单镜锁定拍摄主体 | 否 |
| `dcc5673` | 增加主体切换词与景别单向的确定性校验 | 否 |
| `68a2137` | Full Story 自己校验单场 4–15 秒 | 否 |
| `d68b1b6` | 放行“无硬切”“不得切换到”等否定语境，并把“硬切”纳入禁用词 | 否 |
| `649c1d1` | 调整上一镜连续性参考默认行为 | 否 |

这一区分非常重要：

- 2026-08-26 15:40 左右的“交替”错误，是较新代码在旧进程中的行为。
- 15:51 切回 `7d83dc2` 并重启后，当前代码里连 `src/direct-shot-camera-continuity.js` 都不存在，Prompt 还明确允许“特写插入、硬切”。
- 因此，历史上“成功拦截过”不能视为当前能力；历史上“误杀过”也不能通过简单删除“交替”来处理。

## 三、Full Story 校验规则

Full Story 的主要入口是 [`src/workflow.js`](../src/workflow.js) 中的 `createFullStory()`；基础合同与跨字段校验在 [`src/validation.js`](../src/validation.js)，严格 Schema 在 [`src/contracts/schemas/legacy-full-story-strict.schema.json`](../src/contracts/schemas/legacy-full-story-strict.schema.json)。

状态含义：

- **生效**：当前 HEAD 的实际调用链会执行。
- **部分生效**：规则存在，但只能覆盖确定性子集或有已知盲区。
- **dev 已实现**：后续提交中存在，当前服务器未加载。
- **缺口**：当前没有可靠闭环。

### 3.1 输入、结构与必填字段

| 校验 | 当前状态 | 实现目的 | 失败行为 |
|---|---|---|---|
| 请求必须携带 `creativeBrief`、`variant`、`creatorProfile.fixedCharacter`、`creatorProfile.vertical` | 生效 | 阻止无创意上下文、无固定角色边界的 Story 生成 | 模型调用前 `InputError` |
| `fixedCharacterBoundary` 必须来自服务端签发并通过当前权威校验 | 生效 | 固定角色事实只保留一份可信来源 | 模型调用前失败 |
| 顶层及嵌套对象按 exact JSON Schema 校验 | 生效 | 拒绝缺字段、类型错误、空字符串、未知字段和深层 `null` | `OutputContractError`，带稳定 JSON Pointer diagnostics |
| 顶层字段必须包含 Story 当前规范中的标题、时长、角色 Bible、节拍、分场、道具、拍摄计划、留存计划、结尾和不确定项 | 生效 | 保证下游拿到完整可消费对象 | `FULL_STORY_SCHEMA_*` |
| `beatSheet.length >= 6` | 生效 | 防止剧情节拍过少，保证基本叙事密度 | 明确失败 |
| `sceneScript.length >= 6` | 生效 | 防止输出摘要而不是可拍分场 | 明确失败 |

严格 Schema 当前使用的主要诊断码包括：

- `FULL_STORY_SCHEMA_REQUIRED`
- `FULL_STORY_SCHEMA_UNKNOWN_FIELD`
- `FULL_STORY_SCHEMA_TYPE`
- `FULL_STORY_SCHEMA_MIN_ITEMS`
- `FULL_STORY_SCHEMA_EMPTY_STRING`
- `FULL_STORY_SCHEMA_RANGE`

### 3.2 分场、角色与对白一致性

| 校验 | 当前状态 | 实现目的 | 已知边界 |
|---|---|---|---|
| 每场必须是对象，`sceneId/location/visibleAction` 必须是非空字符串 | 生效 | 保证每场有稳定标识、地点和可见动作 | 只校验结构，不判断动作是否忠实于 Variant |
| `sceneId` 全 Story 唯一 | 生效 | 防止 Animation Plan 映射歧义 | 无自动改名，直接失败 |
| `characters` 必须是字符串数组；单场允许 `[]` | 生效 | 准确表达空镜、道具特写、人物离场后的环境镜头 | 整片仍必须至少有一场可见角色 |
| 标准角色名不得带括号身份、外观或别名后缀 | 生效 | 让角色引用保持 canonical name，避免同一角色生成多个伪身份 | 依赖标准名集合 |
| 同场角色名非空且不能重复 | 生效 | 保证人物清单可作为精确事实源 | 不识别别名语义 |
| `offscreenSoundSources` 可登记画外声音来源 | 生效 | 允许录音、电话声、场外声音，而不污染实际出镜人物 | 只豁免 `shotAndSound`，不能豁免 `visibleAction` |
| 画外声音来源不能同时出现在 `characters` | 生效 | 区分“实际出镜”和“只发声” | 同一场若既出镜又发声，应只列在 `characters` |
| `visibleAction` 精确命中的标准角色必须出现在该场 `characters` | 部分生效 | 防止画面动作出现未登记的稳定角色 | 精确词面无法区分“阿岚维修铺”“看阿岚照片”等非出镜提及，存在 `FS-01` 误杀 |
| `shotAndSound` 精确命中的标准角色必须在 `characters` 或 `offscreenSoundSources` | 生效 | 防止声音/摄影描述绕过场次人物事实 | 仍是精确字符串规则 |
| `dialogue[].speaker` 必须精确存在于同场 `characters` | 生效 | 结构化对白说话人与画面人物一致 | 画外对白应走 `offscreenSoundSources`/声音描述，而不是伪装成出镜对白 |
| 整个 Story 至少一场存在可见角色 | 生效 | 允许局部空镜，同时防止整片人物缺失 | 诊断码 `FULL_STORY_NO_VISIBLE_CHARACTER_SCENE` |

主要 Scene Contract 诊断码：

- `FULL_STORY_SCENE_OBJECT_REQUIRED`
- `FULL_STORY_SCENE_ID_DUPLICATE`
- `FULL_STORY_SCENE_STRING_REQUIRED`
- `FULL_STORY_SCENE_CHARACTERS_REQUIRED`
- `FULL_STORY_SCENE_CHARACTER_NAME_INEXACT`
- `FULL_STORY_SCENE_SOUND_SOURCE_TYPE_INVALID`
- `FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE`
- `FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING`
- `FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING`
- `FULL_STORY_NO_VISIBLE_CHARACTER_SCENE`

### 3.3 Story 与固定角色、Variant 的绑定

| 校验 | 当前状态 | 实现目的 | 仍有问题 |
|---|---|---|---|
| `selectedVariantId` 必须等于当前选中的 Variant ID | 生效 | 阻止直接串错 Variant | 只证明 ID 相同，不证明正文忠实 |
| 固定角色必须出现在 `characterBible.protagonist`，且在 Story 中实际出现 | 生效 | 防止模型替换主角 | 主要依赖名称与签发边界词面 |
| 固定主角正向字段不得命中验签边界中的 forbidden traits | 生效 | 防止身份、物种或外观漂移 | 否定约束可按既有口径放行 |
| careRecipient、任务、情绪媒介、环境压力、结尾仪式与完整 Variant 内容绑定 | 缺口 | 证明 Story 真正遵守选题 | `FS-04`、`DS-05` characterization 当前明确仍可通过 |
| 可见临时角色必须有可信登记 | 缺口 | 防止模型无登记新增主要角色 | `FS-03` 当前明确仍可通过 |

这些缺口已记录在 [`docs/GitHub-Benchmark-后续改造待办.md`](./GitHub-Benchmark-后续改造待办.md) 的 `T01`，对应测试是 [`test/full-story-defect-characterization.test.js`](../test/full-story-defect-characterization.test.js)。它们不是推测，而是当前测试刻意固定的现状。

### 3.4 `timeRange` 与 direct_shot 时长

| 校验 | 当前状态 | 实现目的 | 说明 |
|---|---|---|---|
| Full Story Schema 要求 `timeRange` 是非空字符串 | 生效 | 至少保证字段存在 | 不校验格式、跨度和顺序 |
| `mm:ss-mm:ss` 可解析、跨度为正、场次不回退或重叠 | 当前在 Animation 入口生效 | 确定性派生镜头骨架 | 坏 Full Story 可能先成功提交，等生成 Animation Plan 时才失败 |
| 单镜不得低于供应商 4 秒 | 当前在 Animation 入口生效 | 避免提交供应商不能生成的镜头 | 失败码 `DIRECT_SHOT_SCENE_DURATION_BELOW_PROVIDER_MINIMUM` |
| 超过 15 秒按确定性规则均分 | 当前在 Animation 入口生效 | 保留历史纵深防御 | 当前 HEAD 仍允许 Full Story 出现长场次 |
| Full Story 自身限制每场 4–15 秒 | dev 已实现 | 让分场事实在 Story 提交前闭环，Animation 严格 1:1 | `68a2137` 中加入，当前服务器未加载 |

`dev` 中新增的 Full Story 诊断是：

- `FULL_STORY_SCENE_SPAN_ABOVE_SHOT_MAXIMUM`
- `FULL_STORY_SCENE_SPAN_BELOW_SHOT_MINIMUM`

当前 HEAD 的骨架实现位于 [`src/direct-shot-timeline.js`](../src/direct-shot-timeline.js)。它仍会拒绝无法解析、非正跨度、顺序回退和不足 4 秒，但调用点在 Animation Plan 入口，而不是 Full Story commit 门。

### 3.5 Full Story 的重试、局部纠错与提交前复核

| 机制 | 当前状态 | 允许做什么 | 禁止做什么 |
|---|---|---|---|
| Completion retry | 生效 | 仅在未得到完整对象、JSON 截断/语法或供应商协议问题时，最多再请求一次 | 已解析内容错误不得整包发回模型重写 |
| `full_story_partial_repair/1.0` | 生效 | 仅当可信 diagnostics 精确指向 `/characterBible/protagonist/name`，且签发边界能唯一给出姓名时，替换该字段 | 不修配角、对白、动作、缺失剧情、整项数组或模糊错误 |
| Beat–Scene postpass | 生效 | 初稿完整通过后，再独立检查节拍动作是否遗漏；最多向 3 个既有 `visibleAction` 追加对应 `beatSheet.storyAction` 的连续逐字片段 | 不改 beat、角色、场次、其他字段；blocked 或复验失败不保留未复核初稿 |
| Production Lineage commit 门 | 生效 | 只有最终完整校验成功才签发 Artifact revision | 失败候选、repair 中间态和 postpass 中间态不能成为 current Story |

Beat–Scene 实现在 [`src/full-story-beat-scene-postpass.js`](../src/full-story-beat-scene-postpass.js)，局部姓名修复在 [`src/full-story-partial-repair.js`](../src/full-story-partial-repair.js)。

## 四、Animation Plan 校验规则

当前主流程是 `animationPlanMode: "direct_shot"`、`promptSchemaVersion: "3.0"`。入口、批次和最终合并位于 [`src/workflow.js`](../src/workflow.js)，合同主体位于 [`src/validation.js`](../src/validation.js)。

### 4.1 进入模型前的校验

| 校验 | 当前状态 | 实现目的 |
|---|---|---|
| 请求必须有 `creativeBrief`、`variant`、`fullStory`、固定角色和垂直赛道 | 生效 | 防止无权威上下文生成 Plan |
| `animationPlanMode` 只能为空或 `direct_shot`；浏览器主流程显式传 `direct_shot` | 生效 | 禁止根据字段缺失自动猜模式 |
| `targetAspectRatio` 只允许 `9:16` / `16:9` | 生效 | 锁定计划级画幅事实 |
| 背景音乐输入只接受布尔值或 `none` / `allowed` | 生效 | 由服务端签发音乐策略 |
| 签名 `fixedCharacterBoundary` 必须有效 | 生效 | 固定角色事实不可由 Plan 模型重算 |
| 重新执行完整 Full Story Schema、Scene Contract、Profile/Variant 校验 | 生效 | 坏 Story 在任何 Animation 模型调用前失败 |
| 从 Full Story 确定性派生镜头骨架 | 生效 | 服务端先决定数量、顺序、ID、时长和剧情归属 |

### 4.2 Animation Foundation

| 校验 | 当前状态 | 实现目的 |
|---|---|---|
| Foundation 顶层字段 exact match，未知字段拒绝 | 生效 | 防止模型夹带私有或未授权事实 |
| `promptSchemaVersion` 必须匹配 direct_shot 3.0 | 生效 | 防止旧 v2 端点语义混入 |
| `characterReferencePrompts`、`sceneReferencePrompts`、`assetPrompts`、checklist、notes、uncertainties 必须是数组 | 生效 | 保证后续阶段稳定消费 |
| 至少一个角色参考、一个场景参考 | 生效 | 保证视觉 Foundation 非空 |
| Foundation `sceneId` 唯一 | 生效 | 保证每个视觉场景组可精确引用 |
| 生成镜头前 `relatedShotIds` 必须为空 | 生效 | 防止模型提前伪造镜头归属 |
| 每个 `sourceSceneId` 必须且只能映射到一个 Foundation 场景，覆盖全部 Full Story 场次 | 生效 | 建立 `Sx → LOCxx` 唯一映射 |
| `productionStrategy.format` 必须为 `direct_shot_video` | 生效 | 防止混入首尾帧计划 |
| Foundation 的画幅必须等于用户选择 | 生效 | 防止模型私自改画幅 |
| 模型不得输出 `videoPromptProfile`、`backgroundMusicMode` | 生效 | 两项都由服务端签发，不接受模型回显 |
| direct_shot 删除 `recommendedShotDurationSeconds`，总长由骨架注入 | 生效 | 时长不再是模型建议 |

### 4.3 固定角色与角色参考

| 校验 | 当前状态 | 实现目的 | 边界 |
|---|---|---|---|
| Plan `selectedVariantId` 必须匹配当前 Variant | 生效 | 防止版本串线 | 仍不等于完整语义绑定 |
| 固定角色参考按 `characterName` 精确出现且只能一份 | 生效 | 保证主角参考唯一 | 别名和隐式称呼仍可能绕过 |
| 固定角色 required traits 必须进入角色参考 | 生效 | 保持身份、外观、性格和剧情职责 | Foundation 模型仍高频遗漏，靠 repair 恢复 |
| 正向字段不得命中固定角色 forbidden traits | 生效 | 防止企鹅外壳、错误发色等角色漂移 | 否定语境放行 |
| 结构化 shot 字段中的固定角色禁用特征扫描 | 生效 | 防止 Foundation 正确、逐镜又漂移 | 不是完整的角色身份语义审计 |
| Foundation 有界 repair | 生效 | 必需事实缺失时冻结 `appearancePrompt`，只在 `consistencyTags` 尾部追加签发 canonical name；禁词只做最小删除 | 只覆盖唯一固定角色的安全子集 |
| 当前场人物与 shot 实际人物、角色职责、别名、物种语义完全绑定 | 缺口 | 防止同名换身份、角色职责交换、跨场串角色 | 仍是 `T02` 待办 |

Foundation repair 在 [`src/animation-foundation-partial-repair.js`](../src/animation-foundation-partial-repair.js)。

### 4.4 镜头骨架与 Shot Batch

服务端派生并独占六个结构字段：

- `shotId`
- `sourceSceneId`
- `sceneId`
- `durationSeconds`
- `storyPurpose`（来自 Full Story `dramaticFunction`）
- `emotionalTarget`（来自 Full Story `emotionNode`）

模型只负责八个创作字段：

- `videoPrompt`
- `cameraMotion`
- `characterAction`
- `dialogueOrSubtitle`
- `soundDesign`
- `continuityNotes`
- `negativePrompts`
- `acceptanceCriteria`

| 校验 | 当前状态 | 实现目的 |
|---|---|---|
| Batch 顶层只能有 `shotPlan`，且不能为空 | 生效 | 防止模型返回 Foundation 或额外控制字段 |
| `shotId` 非空且唯一 | 生效 | 保证批内镜头引用稳定 |
| 每镜只允许 direct_shot exact fields | 生效 | 拒绝未知字段和旧结构 |
| 禁止 `startFrame/endFrame/motion/startFramePrompt/endFramePrompt` | 生效 | 保持无端点 direct_shot 语义 |
| 除 `dialogueOrSubtitle` 可为空字符串外，核心文本字段必须非空 | 生效 | 避免无法生成的空镜头指令 |
| 时长必须是 4–15 秒整数 | 生效 | 对齐 Seedance 2.0 与 MiniMax H3 交集 |
| `acceptanceCriteria` 必须有 1–3 条非空标准 | 生效 | 为生成结果提供有限、可观察验收点 |
| `negativePrompts.image` 必须为空数组 | 生效 | direct_shot 不再输出端点图像负面词 |
| `sourceSceneId` 必须属于当前批并按原 Story 顺序 | 生效 | 禁止漏场、跨批、重排或串场 |
| `sceneId` 必须存在且等于 Foundation 的唯一映射 | 生效 | 防止模型自己重解释地点组 |
| 当前批全部 source scenes 必须覆盖 | 生效 | 防止漏镜 |
| 模型回显错的 server-derived 字段按骨架覆盖 | 部分生效 | 只修可唯一推导的 `shotId/duration/storyPurpose/emotionalTarget/sceneId` | 不修 `sourceSceneId` 和创作内容；数量不等时直接失败 |
| direct_shot 已解析内容错误不走整批重试 | 生效 | 避免完整失败 Artifact 二次重写 | 未解析/供应商错误仍可走通用 JSON retry |

### 4.5 Video Prompt 方言、背景音乐和负面词

| 校验 | 当前状态 | 实现目的 |
|---|---|---|
| `videoPromptProfile` 由服务端签发并严格校验 schema/profile/provider/model/guideVersion | 生效 | 记录提示词方言与生成时选择，不让模型篡改 |
| 当前 profile 统一为 `seedance_2_0` | 生效 | Seedance 2.0 与 MiniMax H3 共用同一条中文自然语言提示词 |
| `backgroundMusicMode: none` 时每条 Prompt 必须逐字以“全片无背景音乐，只保留现场环境声与动作声。”收尾 | 生效 | 禁止背景音乐，同时保留现场声和动作声 |
| `backgroundMusicMode: allowed` 时不施加该收尾句 | 生效 | 尊重主题变体卡开关 |
| Plan 阶段不得生成 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>` | Prompt 约束 | 运行时素材尚未绑定，避免伪造引用编号 |
| 负面词只允许受控 `reasonCode`、合法 `appliesTo`、受信 trigger evidence | 生效 | 防止无证据复制黑名单或来源泄漏规则 |
| source-only 词只能在真实携带原片参考时以 `reference_leak` 使用 | 生效 | 防止把原片道具/角色组合机械编译成正文禁词 |
| 不同镜头不得复制完全相同的非空负面词数组 | 生效 | 保持逐镜相关性 |
| 无关负面词在最终计划前裁剪 | 生效 | 避免供应商收到泛化、无证据限制 |

### 4.6 单镜主体锁定和景别单向

| 能力 | 当前 HEAD | `dev` | 结论 |
|---|---|---|---|
| Prompt 要求全程锁定同一拍摄主体 | 不存在；当前 Prompt 仍允许硬切、特写插入 | 存在 | 当前服务器会放过真实主体切换 |
| 从 `cameraMotion` 抽景别并校验单调 | 不存在 | 存在 | `远→近→远` 当前不会被确定性拦截 |
| 扫描 `cameraMotion/videoPrompt/acceptanceCriteria` 的切换词 | 不存在 | 存在 | 当前不会触发 `DIRECT_SHOT_CAMERA_SUBJECT_SWITCH_TERM` |
| 放行否定语境 | 不适用 | `d68b1b6` 已实现 | “无硬切”“不得切换到”不再被误杀 |
| 区分“表演节奏交替”和“拍摄主体交替” | 不适用 | 尚未实现 | 2026-08-26 的真实误杀仍会发生 |

`dev` 的实现路径是 `src/direct-shot-camera-continuity.js`，可用 `git show dev:src/direct-shot-camera-continuity.js` 查看；该文件在当前 HEAD 不存在。其两个诊断码是：

- `DIRECT_SHOT_CAMERA_SHOT_SIZE_NOT_MONOTONIC`
- `DIRECT_SHOT_CAMERA_SUBJECT_SWITCH_TERM`

其中“交替”作为无上下文禁词过宽。合理规则应区分：

- 应失败：`中景交替呈现小白子和老爷爷`。
- 应通过：`表演节奏在轻快与舒缓之间交替`，且镜头固定、主体没有变化。
- 应失败：`中景人物 → 特写道具 → 中景人物`，即使完全没写“交替”。

因此不能只删掉“交替”一词；应优先依赖结构化拍摄主体/景别路径或更窄的摄影语境判断，并保留真实反例测试。

### 4.7 最终合并与语义审计

| 校验 | 当前状态 | 实现目的 | 问题 |
|---|---|---|---|
| 最终 `shotPlan` 镜头 ID 唯一、场景引用合法、覆盖全部 Story 场次 | 生效 | 防止批次分别合法但合并后漏场/串场 | 无 |
| 按位置复核 skeleton 的 `shotId/sourceSceneId/durationSeconds` | 生效 | 防止合并阶段被重排或改时长 | 当前 HEAD 不复核主体/景别连续性 |
| `Σ durationSeconds === targetRuntimeSeconds` | 生效 | 保证计划总长唯一且可解释 | 无 |
| 逐镜两层语义审计：先结构化事实，再 `videoPrompt` | **首次生成不生效** | 检查角色、地点、道具用途、动作/对白顺序和 Foundation 锁 | 方法存在但无调用 |
| 纯 `videoPrompt` 冲突的一次有界 repair 与相邻镜头复审 | Profile 改写路径生效；首次生成路径未接入 | 只修 Prompt，不掩盖结构化事实错误 | Debug 中只有 1 次 repair 记录 |

当前 `createAnimationPlanWithMetadata()` 在 Foundation 和所有 batch 合并后只执行 `validateAnimationPlanOutput()`，随后直接返回。`auditInitialAnimationVideoPromptSemantics()` 定义在同一文件中，但全仓当前调用搜索只有定义本身。

历史原因可定位到 `e1d2d63`：退役 MiniMax H3 专属提示词方言时，首次审计调用一起被删除，但通用化后的方法和“所有方言都应审计”的设计说明仍保留。现在的 Profile 改写路径仍会独立审计，首次新建 Plan 不会。

## 五、Debug 历史复核

### 5.1 数据源与限制

本次交叉检查了：

- `debug/full-story-model-outputs/`
- `debug/animation-plan-model-outputs/`
- `debug/partial-repairs/`
- `runtime/production-runs/*/*/manifest.json`

使用这些数据时必须注意：

1. Full Story sidecar 会记录 attempt 的成功/失败分类，但业务错误多被汇总为 `OUTPUT_CONTRACT_INVALID`，具体规则需重新解析输出或结合 UI 错误。
2. Animation sidecar 的大多数 completion 只标记为 `received/unvalidated`；它在 validator 之前落盘，不能仅凭 metadata 判断最终是否通过。
3. Production manifest 能区分 `stage.failed` 和 `artifact.committed`，但 `stage.failed` 没保存错误码、JSON Pointer 或 message。
4. Debug metadata 没保存运行时 git commit。当前目录跨多个版本，统计只能说明历史现象，不能直接当作当前版本故障率。
5. `partial-repairs` 的 `repaired` 表示局部合并被接受，不等于整个 Animation Plan 最终一定 committed。

### 5.2 Full Story 历史数据

| 指标 | 数值 |
|---|---:|
| 全量模型输出 metadata | 103 |
| 关联 Production request | 64 |
| Production request committed / failed / unknown | 40 / 23 / 1 |
| attempt succeeded / failed | 76 / 27 |
| `OUTPUT_CONTRACT_INVALID` | 22 |
| `MODEL_TRANSPORT_ERROR` | 5 |
| primary `fullStory` attempts | 57 |
| Beat–Scene postpass attempts | 36 |
| 旧格式、stage 为空的 attempts | 10 |

对 21 个 `stage=fullStory` 且 metadata 为 failed 的调用重新读取当前仍在的输出：

- 3 个缺少 `model-output.txt`，无法重放。
- 其余失败候选全部命中 `FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING`，共 18 个 candidate hit。
- 其中 3 个同时命中 `FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING`。

这说明最近 Full Story 的主要阻断点不是 JSON 顶层结构，而是 Scene Contract 的角色登记一致性。该规则本身有价值，但其中混有 `FS-01` 的词面误杀风险，因此不能把 18 次都简单归因于“模型忘记列角色”。

Beat–Scene postpass 的 36 次记录全部成功解析：

- 35 次 `status: pass`，Story 不变。
- 1 次 `status: completed`，合法追加一处 `missing_beat_action`。
- 220 个 review verdict 中，219 个 pass、1 个 completed。
- 未观察到 blocked 样本。

结论：提交前 postpass 已经实际运行并能完成窄范围追加，但真实历史样本中绝大多数没有发现节拍缺漏。

### 5.3 Animation Plan 历史数据

| 指标 | 数值 |
|---|---:|
| Animation 全量模型输出 metadata | 994 |
| 关联 Production request | 91 |
| Production request committed / failed / unknown | 34 / 53 / 4 |
| metadata `received` / `failed` | 980 / 14 |
| Foundation completions | 249 |
| Foundation partial-repair completions | 129 |
| shot batch completions | 242 |
| 旧 shot prompt completions | 196 |
| 旧 shot prompt partial-repair completions | 83 |
| 首次 videoPrompt semantic audit completions | 47 |
| semantic repair completions | 1 |

`received=980` 不能解释为 980 次校验成功，只表示模型完成内容已收到并先写入 sidecar。

### 5.4 局部纠错历史

`debug/partial-repairs` 共 216 个 session：

| 阶段 | session 数 | 状态说明 |
|---|---:|---|
| `animationFoundation` | 132 | 当前仍相关 |
| `animationShotPrompt` | 83 | 属于已退役的 MiniMax H3 专属方言路径 |
| `animationVideoPromptSemanticRepair` | 1 | 语义 Prompt repair 极少 |
| repaired / rejected / missing result | 176 / 39 / 1 | repaired 不等于最终 Artifact committed |

诊断 hit 次数：

| 诊断码 | 次数 | 当前判断 |
|---|---:|---|
| `ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING` | 132 | 仍反复发生；repair 能处理，但模型源头遗漏未解决 |
| `ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM` | 13 | 当前仍相关；与缺失 trait 可在同一 session 重叠 |
| `MINIMAX_H3_BASE_SPEAKER_ID_MISSING` | 38 | 旧方言问题，当前统一 Seedance 方言后不再属于主流程 |
| `MINIMAX_H3_BASE_DIALOGUE_COUNT_MISMATCH` | 32 | 同上 |
| `MINIMAX_H3_BASE_DIALOGUE_ORDER_MISMATCH` | 21 | 同上 |
| `MINIMAX_H3_BASE_MUSIC_ABSTRACT_MOOD` | 20 | 同上 |
| `MINIMAX_H3_BASE_LANGUAGE_INVALID` | 1 | 同上 |

最新 Foundation 示例位于 [`debug/partial-repairs/20260825T101744369Z-animationFoundation-99bca302-0082-4091-9753-5ff6dea44962/01-trigger.json`](../debug/partial-repairs/20260825T101744369Z-animationFoundation-99bca302-0082-4091-9753-5ff6dea44962/01-trigger.json)：模型已有“Q 版狼耳少女”等相近表达，但仍缺验签 canonical fact `q 版狼耳少女形象`。Repair 冻结 `appearancePrompt`，仅把 canonical name 追加到 `consistencyTags`，结果为 repaired。

结论：Foundation 有界 repair 的安全边界和执行效果已解决；但它仍被高频调用，说明“模型稳定一次输出合规角色参考”没有解决，且带来额外调用成本。

### 5.5 2026-08-26 的“交替”事件

对应 Production Run：

- Project：`project-cb666554-04fa-430b-af10-a44bddd6888c`
- Run：`run-36f85134-2df0-4b5c-8f24-9351d5002fca`

时间线：

1. request `2085640e-1022-4b9c-82b4-2c725a203c39` 于 15:33 开始，15:36 `stage.failed`。
2. request `b5955d95-a7d1-4d6d-a0c1-aad16cdb56a6` 于 15:37 开始，15:40 `stage.failed`。
3. 第二次请求的 A02 `videoPrompt` 写了“表演节奏轻快舒缓交替，动作舒展自然”，同时 `cameraMotion` 明确写“中景固定机位，无推拉运动”。较新 validator 只按“交替”词面命中，误判为拍摄主体切换。
4. 15:51 工作区切回 `7d83dc2`，服务器随后重启。
5. request `25888180-d0c1-441a-a884-65df0b9cc557` 于 15:52 开始，15:56 成功提交 `animationPlan-V1-r1`。
6. 这份成功 Plan 的模型输出中又出现了真正的“硬切至中景”，由于当前 HEAD 没有主体/景别 validator，最终被放行。

原始证据：

- 误杀输出：[`attempt-02-QoAYS0/model-output.txt`](../debug/animation-plan-model-outputs/project-cb666554-04fa-430b-af10-a44bddd6888c/run-36f85134-2df0-4b5c-8f24-9351d5002fca/animationPlan_V1/b5955d95-a7d1-4d6d-a0c1-aad16cdb56a6/animation-plan_20260826T073727519Z-23981bf6-f4cd-46b8-b16b-264478c62ec0/attempt-02-QoAYS0/model-output.txt)
- 运行状态：[`manifest.json`](../runtime/production-runs/project-cb666554-04fa-430b-af10-a44bddd6888c/run-36f85134-2df0-4b5c-8f24-9351d5002fca/manifest.json)
- 回退后成功但含硬切的输出：[`attempt-03-2qbE1h/model-output.txt`](../debug/animation-plan-model-outputs/project-cb666554-04fa-430b-af10-a44bddd6888c/run-36f85134-2df0-4b5c-8f24-9351d5002fca/animationPlan_V1/25888180-d0c1-441a-a884-65df0b9cc557/animation-plan_20260826T075226248Z-b151889c-55e7-4a08-a82e-9f53295ca9e8/attempt-03-2qbE1h/model-output.txt)

跨全部 shot batch 历史输出扫描当前 dev 禁词，共找到 14 个 completion 命中：

- `插入` 17 个字段 hit
- `交替` 7 个字段 hit
- `切换到` 4 个字段 hit
- 对应请求最终 11 committed、2 failed、1 unknown

这些数据跨多个版本。11 个 committed 大多发生在确定性校验接入之前，不能证明 dev validator 无效；但它证明模型长期、稳定地产生内部切换表达，单靠 Prompt 不足以闭环。

## 六、已经解决、部分解决与仍未解决

### 6.1 当前 HEAD 已经解决并实际生效

1. Full Story exact Schema：递归拒绝缺字段、错类型、深层 `null` 和未知字段。
2. Scene Contract：场次 ID、人物清单、画外声音和对白 speaker 有确定性一致性门。
3. 空场合法化：单场可 `characters: []`，同时以故事级规则防止整片无人。
4. Full Story 整包纠错被禁止，只保留 fixed protagonist name 的唯一安全局部修复。
5. Beat–Scene postpass 已实际运行，且只允许证据绑定的追加式补全。
6. Animation Plan 在任何模型调用前重验 Full Story，并确定性派生镜头骨架。
7. direct_shot exact fields、端点字段禁用、镜头数/顺序/时长/总长和场景映射均已有 fail-closed 校验。
8. `videoPromptProfile`、背景音乐模式和画幅均由服务端签发，模型不能输出或篡改。
9. 负面词要求逐镜证据，避免全局黑名单复制和来源文本机械禁用。
10. Foundation 固定角色安全子集 repair 已有完整保护和测试。
11. MiniMax H3 专属 speaker/dialogue/music 英文方言校验类问题已随方言退役退出当前主流程。

### 6.2 机制已存在，但根因未完全解决

1. **Foundation required traits**：132 次 Debug 证明 repair 能恢复，但模型遗漏仍高频发生。
2. **Full Story 角色登记**：能拦截真实漏登记，也会把地点所有关系、照片或提及误判为出镜。
3. **Full Story 时间线**：当前最终能在 Animation 入口拦截，但坏 Story 仍可能先提交，失败阶段过晚。
4. **语义 Prompt repair**：实现和 Profile 改写路径都在，但首次 Plan 生成没有接入；历史只有 1 次 repair session。
5. **Debug sidecar**：原始 completion 能留存，但 validator verdict 与稳定 diagnostics 没有完整串到 metadata/manifest。

### 6.3 当前仍存在的问题

| 优先级 | 问题 | 影响 |
|---|---|---|
| P0 | detached HEAD 比 `dev` 落后，服务器实际能力与文档/AGENTS 声明不一致 | 同一份输出重启前后会得到相反结论；排障不可复现 |
| P0 | 当前 HEAD 没有单镜主体锁定与景别单向确定性校验 | 真实硬切、主体切换和景别反向可以进入 current Plan |
| P0 | 首次 Animation Plan 语义审计调用已断开 | 结构合法但角色、地点、道具用途、动作顺序或 Prompt 语义漂移可能通过 |
| P1 | dev 对“交替”等词做无上下文扫描 | 表演节奏、昼夜变化等非摄影含义会被误杀 |
| P1 | 当前 HEAD 的 Full Story 不拥有 4–15 秒分场规则 | Story 可成功提交，Animation 才因时长失败；错误归属和用户体验不正确 |
| P1 | `FS-01/FS-03/FS-04/DS-05` 仍是明确的 characterization 缺口 | 非出镜提及误杀、临时角色漏管、careRecipient/Variant 语义漂移 |
| P1 | Animation 角色绑定仍不完整 | Foundation 正确时，逐镜仍可能同名换身份、交换职责、串入当前场不存在的人物 |
| P1 | Animation debug 大多只有 `received/unvalidated`，manifest 失败无 code/message | 无法从日志直接回答“哪条规则失败”，必须手工重放或依赖 UI 截图 |
| P2 | Debug metadata 不记录运行 git SHA | 多版本日志混在同一目录，历史统计容易误导 |
| P2 | Foundation 局部 repair 调用频率高 | 额外延迟和成本，且 repaired 不保证最终 Plan commit |

## 七、建议的接手顺序

### P0：先恢复可复现基线

1. 明确部署目标究竟是 `7d83dc2`、`dcc5673` 还是当前 `dev=649c1d1`。
2. 不要只 cherry-pick 词表；`9c0f29d`、`dcc5673`、`68a2137`、`d68b1b6` 是相互依赖的一组行为变化。
3. 在服务器启动日志、Full Story/Animation metadata 和 Production manifest 中写入 `gitCommit`/build ID。
4. 新增“当前调用图”测试，直接证明首次 Plan 生成是否执行语义审计、主体连续性校验和 Full Story span 校验，而不是只测试孤立函数。

### P0：补回首次 Animation 语义审计

1. 在 Foundation 与全部 shot 合并、完整 deterministic validation 之后调用一次 initial semantic audit。
2. 统一作用于当前 Seedance 中文方言，不再以运行时视频 provider 或旧 `minimax_h3` profile 为开关。
3. 结构化事实 fail 时停止检查/修复 Prompt；只有纯 `videoPrompt` fail 才允许一次有界 replacement 和相邻镜头复审。
4. 在 Artifact commit 前证明审计 receipt 存在且 verdict 为 pass。

### P1：重做主体切换判定的合法反例

至少固定以下测试：

- 固定机位 + “表演节奏轻快舒缓交替”必须通过。
- “中景交替呈现 A 与 B”必须失败。
- “无硬切”“不得切换到其他主体”必须通过。
- 真正的“硬切至另一个对象”必须失败。
- 没有禁词但路径为“人物中景 → 道具特写 → 人物中景”仍必须失败。
- 同一角色整体 → 手部特写的单向推近必须通过。

长期方案应让服务端校验一个确定性的 filmed-subject / shot-size path，而不是继续扩充中文禁词表。若仍保留文本规则，应限制在摄影语境，并为每个词提供正反样本。

### P1：把 Story 事实闭环放回 Story 阶段

1. 恢复 `68a2137` 的每场 4–15 秒校验，让坏分场不能成为 current Full Story。
2. 保留 `deriveDirectShotSkeleton()` 的深层防御，但在正常主流程中不再依赖长场拆分。
3. 继续推进 `T01`：先解决临时角色登记和 Variant 最小权威投影，再做窄语义审计；不要用更多中文正则猜出镜事实。

### P1：补齐可观测性

建议 Animation attempt metadata 在模型 completion 落盘后追加或关联一份 validator result：

```json
{
  "validationStatus": "passed | failed",
  "errorName": "OutputContractError",
  "diagnostics": [
    {
      "code": "...",
      "jsonPointer": "/shotPlan/1/videoPrompt",
      "reason": "脱敏后的稳定原因"
    }
  ],
  "gitCommit": "..."
}
```

Production manifest 的 `stage.failed` 至少保存稳定、脱敏的 failure code；原始 Prompt、密钥、签名和媒体 Data URL 仍不得进入 manifest。

## 八、验证结果与交接检查表

本次只做只读审计与文档整理，没有修改业务代码、没有调用外部模型、没有下载 vendor 文件。

已运行：

```text
node --test \
  test/full-story-defect-characterization.test.js \
  test/full-story-schema-strict.test.js \
  test/full-story-partial-repair.test.js \
  test/full-story-beat-scene-postpass.test.js \
  test/animation-plan-v3-direct-shot.test.js \
  test/animation-plan-v3-workflow.test.js \
  test/animation-foundation-partial-repair.test.js \
  test/animation-video-prompt-semantic-repair.test.js
```

结果：105 passed，0 failed。

需要注意：这些测试证明当前已实现函数符合当前测试预期，也明确固定了 `FS-01/FS-03/FS-04/DS-05` 缺口；它们没有证明 `dev` 的主体连续性校验在当前服务器生效，也没有证明 initial semantic audit 已接回首次 Plan 生成调用链。

接手前检查表：

- [ ] 确认并记录目标部署 commit，退出 detached HEAD。
- [ ] 确认启动日志中的 commit 与浏览器当前服务器一致。
- [ ] 决定是否整体恢复 `9c0f29d..d68b1b6` 行为组。
- [ ] 为“表演节奏交替”加入合法反例测试。
- [ ] 为“真实硬切/主体切换”加入失败测试。
- [ ] 重新接通首次 Animation Plan 语义审计并测试调用次数。
- [ ] 恢复 Full Story 4–15 秒前置校验。
- [ ] 给 Debug/manifest 增加 validator diagnostics 与 git SHA。
- [ ] 继续按 `T01/T02` 处理角色与 Variant 语义缺口。

## 九、关键文件索引

- Full Story / Animation 入口：[`src/workflow.js`](../src/workflow.js)
- 主要合同校验：[`src/validation.js`](../src/validation.js)
- Full Story exact Schema：[`src/contracts/schemas/legacy-full-story-strict.schema.json`](../src/contracts/schemas/legacy-full-story-strict.schema.json)
- direct_shot 时间线：[`src/direct-shot-timeline.js`](../src/direct-shot-timeline.js)
- Full Story 姓名局部修复：[`src/full-story-partial-repair.js`](../src/full-story-partial-repair.js)
- Full Story Beat–Scene postpass：[`src/full-story-beat-scene-postpass.js`](../src/full-story-beat-scene-postpass.js)
- Foundation 局部修复：[`src/animation-foundation-partial-repair.js`](../src/animation-foundation-partial-repair.js)
- videoPrompt 语义修复：[`src/animation-video-prompt-semantic-repair.js`](../src/animation-video-prompt-semantic-repair.js)
- 当前明确待办：[`docs/GitHub-Benchmark-后续改造待办.md`](./GitHub-Benchmark-后续改造待办.md)
- Animation 事实源说明：[`docs/animation-plan-source-of-truth.md`](./animation-plan-source-of-truth.md)
- 主流程规范：[`docs/workflow-spec.md`](./workflow-spec.md)
