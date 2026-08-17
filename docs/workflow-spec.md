# AI 短视频导演工作流规范

## 1. 产品判断

本工作流不以“和原片越不一样越好”为目标。质量标准由两组同时成立的约束构成：

- 体验保真：同定位、同受众、同核心情绪、同类剧情驱动力、同款高价值桥段。
- 表达原创：具体人物、任务、道具、对白、场面调度和镜头表达重新设计。

抽象母题与具体表达必须分开处理。送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾属于通用叙事构件，可以继续使用；独特台词、专有名称、罕见动作组合、独特道具组合和逐镜对应才进入禁止复制项。

## 2. 处理流程

```mermaid
flowchart LR
    A[上传参考视频] --> B[浏览器抽取带时间戳关键帧]
    B --> C[referenceAnalysis]
    C --> D[sourceScriptReconstruction]
    D --> E[creativeBrief]
    E --> V[visualGuardrails]
    V --> F[themeVariants]
    F --> H[选择主题变体]
    H --> I[fullStory]
    I --> J1[direct_shot animationFoundation]
    J1 --> J2[direct shotPlan batches]
    J2 --> J[merge animationPlan 3.0]
    G[固定角色与垂直赛道] --> E
    G --> V
    G --> I
    G --> J
```

### 阶段一：referenceAnalysis

必须回答：

- 内容定位、目标受众、故事梗概。
- 主角、配角、人物关系、主角职业或社会身份。
- 被关爱对象的身份、显性需求和隐性需求。
- 对白风格、镜头节奏、情绪曲线。
- 观众为什么愿意看完。

所有关键判断需要引用采样画面编号（F1、F2……）或用户补充文本。无法确认的内容进入 `uncertainties`，不得伪装为事实。

`referenceAnalysis.observedFacts[]` 是结构化视觉证据层。每项只保存一个直接可见 observation、受控 `factType`、`core/supporting` 重要度，以及结构化的 frame 或 video `evidenceRefs`。原生视频证据只使用整数 `startSecond/endSecond`，最大整数结束秒必须严格小于输入视频时长加 1 秒；模型不得输出毫秒字段。完整 `referenceAnalysis` 会作为下一阶段的分析上下文，但人物动机、隐性需求、叙事意义等判断不能冒充画面直接证据。分析结果由服务端签名并绑定当前 transcript、关键帧与原生视频；客户端改写或跨素材复用后必须重新分析。原生视频模式的首次候选若仅以 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧，系统丢弃该候选，不回传其 Artifact 或错误子树，改用同一模型和既有关键帧重新执行一次 frames-only 取证；该调用是媒体证据重新获取，不是内容 repair，frames-only 结果仍失败时立即终止。签名前只接受本次实际媒体模式对应的 evidence，不能引用模型本次没有实际收到的视频时间段。

### 阶段二：sourceScriptReconstruction

本阶段恢复为完整可读脚本还原。模型同时接收参考视频或采样画面、`referenceAnalysis`、视频元数据和用户补充字幕，按场输出：

- `timeRange`、`location`、`characters`、`visibleActions`；
- `dialogueGist`、`shotDesign`、`emotionNode`、`dramaticFunction`；
- `turningPoint`、`keyProps`、`sourceEvidence` 与 `confidence`；
- 全片 `coreEventSequence`、`relationshipPattern`、`endingAction`、`turningPoints` 和 `uncertainties`。

“完整还原”指在现有证据范围内覆盖开场、发展、转折和结尾，不等于填满采样间隙。未提供音频转写时，只能概括可确认的对白功能。`sourceEvidence` 继续使用 Reference Analysis 中已有的画面编号、时间码或用户补充文本；无法确认的身份、对白、动作和因果关系必须进入 `uncertainties`。

服务端仍会为 Analysis 和 Reconstruction 附加完整性签名，并将 Reconstruction 与当前素材上下文绑定，防止客户端篡改或跨素材误配。签名只保护通过契约校验的完整脚本，不再把脚本降级为 `sourceFacts`/`factRefs` 引用图；下游 Creative Brief、视觉规则和完整剧情会消费验签后的完整可读字段。

### 阶段三：creativeBrief

`creativeBrief` 是后续创作的唯一结构依据，必须包含：

- `storyEngine`：欲望、阻碍、升级、转折机制、回报。
- `emotionStructure`：每一阶段的剧作功能与目标情绪。
- `roleAndOccupationMapping`：原片角色功能如何映射到固定角色和赛道身份。
- `reusableHighValueBeats`：桥段价值、必须保留内容和可改变表面。
- `controlledRewriteVariables`：需要受控改写的变量。
- `protectedExpressions`：记录原片具体表达及其来源；字段名保留兼容，但不作为下游正文禁词。
- `minimumTransformationRules`：最低变换规则及验收检查。
- `allowedNarrativeComponents`：七类通用构件的安全复用方式。`component` 由服务端固定为送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾；Prompt 展开完整七项，模型只填写非空的 `howToReuseSafely`。即使不采用也必须保留分类并说明限制，禁止改名、合并、省略、重复或增加分类。
- `nonNegotiableExperience`：五项体验保真要求。

`controlledRewriteVariables.sourceValue` 和 `protectedExpressions.sourceExpression` 若列举同类具体物品，每个名称必须重复完整中心名词，例如“绿色邮箱、红色邮箱、蓝色邮箱”，不得缩写为“绿色、红色、蓝色邮箱（组合）”。这项约束只负责完整表达上游已有事实，不得新增物品，也不得由本地语法规则反向猜测旧缩写。`visualGuardrails.sourceSimilarityRules[].sourceExpression` 另有确定性校验：每个并列项必须逐字出现在同一条规则的 `triggerEvidence[].evidence` 中，补全或拼接即 fail closed；保留上游原文是合法退路。

这两类来源字段不会自动禁止下游复用对应表达。原片道具、拟声词和角色组合可以按当前选定剧情出现在 Variant、Legacy Full Story 与 Animation Plan 的任意正向业务字段，包括 `visibleAction`、对白、声音与 `videoPrompt`；但来源上下文本身不是使用指令，不得据此机械注入正向内容。该放行不授权修改固定主角，固定主角的签发身份与外观仍由 `fixedCharacterBoundary` 唯一约束。

### 阶段四：visualGuardrails

`visualGuardrails` 是固定角色语义唯一生成阶段，只负责一次性确定并签发全局角色边界，不负责生成最终图片或视频负面提示词。它同时读取用户角色描述、参考分析、脚本还原和创意简报，并允许视觉模型用通用常识补全用户采用的角色原型；不使用本地物种关键词字典。用户明确肯定或否定的描述优先于模型常识，无法消解的冲突必须进入 `unresolvedConflicts` 并阻断下游。输出必须拆成：

生产环境必须校验 `fixedCharacterBoundary` 的 HMAC 签名。本地 `test`/`development` 只有在服务端同时配置 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时才跳过签名比较，以便服务重启后继续回放测试包；`sourceDigest` 与 `boundaryDigest` 仍然强制校验，不能复用其他素材、用户设定或被改写过的边界。

- `fixedCharacterBoundary.requiredTraits`：后续角色参考、剧情扩写、动画规划和生成请求必须沿用的身份、外观、性格、职业或剧情功能事实；每项带 `explicit | inferred` 证据等级和模型生成的同义词。
- `fixedCharacterBoundary.allowedTraits`：允许按剧情选择使用、但不要求每个角色参考都出现的事实。
- `fixedCharacterBoundary.forbiddenTraits`：与已确定角色形象冲突、后续正向字段不得出现的事实。
- `allowedPositiveTraits` 与 `positivePromptBoundary`：由服务端从上述全局边界确定性派生，模型不得另写第二份角色事实。
- `sourceSimilarityRules`：记录原片表面表达的 provenance，不是下游正文禁词；只有生成请求实际传入原片视觉参考时，相关 evidence 才能在该次请求中为 `reference_leak` 提供依据。
- `dialogueRules`：只记录用户明确提出的角色口癖、可用拟声词或禁用对白；不得从原片对白、拟声词、Creative Brief 来源字段或 `sourceSimilarityRules` 自动生成。台词规则不得进入图片负面提示词。

服务端将边界与当前 `creatorProfile`、`referenceAnalysis`、`sourceScriptReconstruction` 和 `creativeBrief` 的摘要绑定并签名。Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图、旧 v2 首尾帧和视频生成只消费验签后的边界，不再解析 `fixedCharacter` 或调用模型常识重算。旧 v2 兼容路径中的 Character Feature Compiler 也只能编译已签发 `requiredTraits(scope=appearance)`，不能重新推断固定主角。用户修改角色设定、字幕、参考视频或上游创意数据后，旧边界立即失效并要求重新生成。

`sourceSimilarityRules.sourceExpression` 与相关 evidence 沿用同一完整名称规则。若旧 Brief 或 Visual Guardrails 已签发“绿色、红色、蓝色邮箱组合”这类歧义缩写，系统不得把“红色”自动扩写为“红色邮箱”；必须重新生成对应上游 Artifact 后再进入下游。下游不得把这些来源表达编译成正文黑名单，也不得仅因词面命中而拒绝 Variant、Full Story 或 Animation 正向字段；只有实际传入原片参考时，才能把受信 evidence 用于 `reference_leak` 判断。

该阶段没有 `commonNegativePrompt`，也不维护“未声明身体部件”的完整枚举。未声明不等于禁止；只有全局边界明确写入 `forbiddenTraits` 或存在当前镜头的有效失败证据时，相关概念才可参与后续拦截或逐镜负面词判断。

### 阶段五：themeVariants

每个主题变体必须可独立拍摄，并提供两组验收证据：

- `experienceFidelity`：逐项说明定位、受众、情绪、驱动力和高价值桥段如何保留。
- `transformationProof`：逐项说明人物、任务、细节/道具、对白和视听表达实际发生的改编；不要求每个原片表面表达都必须替换。

只替换姓名或职业不算主题变体。变体必须产生新的具体任务、环境压力、情感媒介、帮助方式和结尾仪式。

### 阶段六：fullStory

用户选择一个 `themeVariants.variants[]` 后，进入独立完整剧情页。该阶段不重新发散主题，只围绕被选中的主题变体扩写，输出：

- `characterBible`：锁定固定角色、被关爱对象、帮助者与对白规则。
- `beatSheet`：45–90 秒短视频的完整剧情节拍。
- `sceneScript`：可拍摄分场，包含地点、人物、可见动作、对白、镜头/声音、情绪节点和剧作功能。
- `keyProps`、`shootingPlan`、`retentionPlan`：进入拍摄筹备需要的道具、场景和完播设计。
- `experienceFidelity` 与 `transformationProof`：继续证明同定位、同受众、同情绪、同类驱动力、同款高价值桥段，并记录实际发生的具体改编；复用某个来源表达本身不构成失败。
- `continuityAndSafetyCheck`：确认固定主角服从签发边界且剧情连续；不得把 `protectedExpressions` 的词面复用本身判为失败。

完整剧情阶段可单独切换文本模型：默认路由由现有 Qwen/MiMo 配置决定；配置 `DEEPSEEK_API_KEY` 后，页面可以显式选择 `deepseek-v4-flash` 或 `deepseek-v4-pro`。DeepSeek 不自动接管默认路由，不允许用于任何带图片或视频输入的阶段。

#### Legacy Full Story 有界子树纠错

首次模型 completion 已解析为完整 JSON 对象，且全部结构化 diagnostics 都精确指向 `/characterBible/protagonist/name` 的 required/type/empty-string 错误、当前验签固定角色边界提供唯一姓名时，唯一一次 retry 使用内部 `full_story_partial_repair/1.0` 协议。服务端只发送 protagonist 的 `currentValue`、diagnostics、`mutableFields:["name"]`、`expectedFields.name`，以及最小只读的固定角色名、标准角色名、Variant ID 和 sceneId 列表；不发送完整失败 Story，也不重复原始完整生成 Prompt。任何未知正文或其他字段错误都不得签发 Full Story 计划。

服务端为目标签发固定 `repairId`、原候选 `baseDigest`、authorityDigest 和仅当前进程持有的私有计划身份；计划的序列化副本不能用于合并。模型只能返回一个 `{repairId,replacement}`；不能选择 path、返回 patch、删除其他字段或增加 operation。replacement 是 protagonist 对象的完整值，但 `name` 必须逐字等于 `expectedFields.name`，对象内其余已有合法字段和所有目标外数据必须保持不变。

服务端在原候选 clone 上原子合并，验证私有计划身份、候选摘要、当前权威摘要、协议、目标内变更边界与目标外摘要，再从头执行 Legacy exact JSON Schema、Scene Contract、固定角色/Profile 和 Variant 全链校验。初轮生成阶段固定为 primary + 最多一次 retry/repair；第二次仍失败时不得进入后述 Beat–Scene postpass。除上述 protagonist `name` 安全子集外，其他角色姓名或身份字段缺失/错误、`characters` 与 `visibleAction`/`dialogue` 的跨字段冲突，以及没有签发值来源的必填剧情字段都直接失败；不得让 replacement 通过角色改名、删除动作/对白或另编剧情来消除错误。截断、JSON 语法或供应商协议错误因为没有可合并 candidate，仍使用既有 completion retry；已解析但路径不可信、details 为空、目标不存在或整项内容丢失时明确失败，不能静默发送完整 Story 重写。该机制是模型局部重生成，不是本地确定性搬字段、独立语义审计或 Full Story v2。

#### Legacy Full Story Beat–Scene 提交前复核

初轮候选（包括实际发生的唯一允许 retry 或 protagonist `name` 局部纠错）只有在通过 Legacy exact JSON Schema、Scene Contract、固定角色/Profile、Variant 与既有语义边界的完整校验后，才能在 Artifact commit 前进入一次独立的 Beat–Scene AI postpass。它沿用本次 Full Story 明确选择的文本 provider/model；请求的业务内容严格只有完整、已合法的 Full Story JSON 和专用复核提示，不再发送 `creatorProfile`、Theme Variant、Creative Brief、Visual Guardrails、`referenceAnalysis`、Reconstruction、原片边界或其他上游数据。该调用不是失败候选 recovery，也不能作为第二份权威来源。

postpass 把 `beatSheet` 当作只读叙事目标，仅检查现有 `sceneScript` 是否遗漏会造成可拍叙事明显断裂的重要节拍、可见结果、状态变化或因果过渡。没有明显遗漏时返回 unchanged；存在遗漏时，模型不得自由生成 append suffix。每条提议必须绑定已有 scene 和唯一 `beatIndex`，其 `addition` 必须是对应 `beatSheet[beatIndex].storyAction` 的一段连续、逐字相同原文，并且包含该 review 逐字返回的 `beatEvidence`。全部证据只能使用该 `storyAction` 与目标/相关场次当前 `visibleAction` 的逐字 excerpt；不得引用其他 Story 字段、上游数据或模型常识。无法从 `storyAction` 连续逐字投影所需内容时必须返回 `blocked`，不能释义、改写或拼接多个不连续片段。

服务端最多接受 3 个已有目标场次；每条 `addition` 最多 600 字，全部 additions 合计最多 1200 字。合并时只把受信 `addition` append 到对应 `sceneScript[i].visibleAction`，原字符串必须仍是逐字前缀。场次数量与顺序、`sceneId`、`timeRange`、`location`、`characters`、`dialogue`、`shotAndSound`、`emotionNode`、`dramaticFunction`、`shootingNotes` 以及 `sceneScript` 外的所有字段逐字冻结。合法省略、蒙太奇概括、末项代表整组或既有终态已经提供证据时不得重复投影；超限、`beatIndex`/`beatEvidence` 错绑、addition 未包含 `beatEvidence` 或非对应连续原文，以及新增场次、改角色、改对白、改地点或重写原动作都属于协议错误。

正常路径是 primary + postpass，共 2 次 provider call；初轮消耗唯一允许的 retry/repair 后才成功时，再执行 postpass，整个 Full Story operation 最多 3 次，禁止第四次调用。postpass 返回 `blocked`、协议错误、供应商错误、额外字段、越界 diff、非追加式变化或最终完整复验失败时一律 fail closed：不把初轮候选保存为 fallback，不追加另一轮 postpass，也不回退整包重写。服务端只在 clone 上合并已验证为对应 `storyAction` 连续逐字原文的 `addition`，并从头执行 Full Story 全部校验；最终 unchanged 或合法 append 的 Story 只提交一次 Artifact。初轮候选、postpass 响应和合并中间态均不创建 Artifact revision、Checkpoint 或第二份 Story。

#### 当前主流程的通用有界纠错协议

除 Full Story 的专用子树协议外，当前主流程使用 `artifact_partial_repair/1.0` 统一编排 Animation 内容纠错。validator 必须先返回服务端生成的稳定 `code/jsonPointer/reason`；stage adapter 再决定 target、允许变化的绝对 Pointer、最小 authority 与完整只读 validator。通用内核不解析错误 message，也不允许模型选择 path。

当前接入点只有两类：

- Animation Foundation：只有已签发边界中唯一固定角色参考，且全部错误都是缺失 `requiredTraits` 或该参考叶子命中禁止特征时，才把这一个角色参考对象交给模型。纯缺失错误只授权 `consistencyTags`，要求保留原数组顺序并在尾部按边界顺序追加缺失 trait 的 exact `canonicalName`，`appearancePrompt` 逐字冻结；同义 term、重排、重复或额外事实均拒绝。禁止表达只授权 diagnostics 实际命中的字段做受限删除；混合错误取命中字段与 `consistencyTags` 的并集，但缺失事实仍不得写入外观、身份或剧情职责。配角、重复/缺失主角引用、正向场景 Prompt 命中或边界不可信都直接失败。
- MiniMax H3 shot batch：H3 Base 确定性校验在最终 Plan 合并前逐批执行。一个批次最多可把 12 个受信 `shotPlan[i].videoPrompt` 作为独立 string target 一次修复，但每个 target 都要求现有 `integrated_multimodal_description` 能被唯一提取、独立验证并冻结，adapter 无权重新创作该视觉/动作正文；“合法 integrated 单段缺少后两个 section”是正例，integrated 自身损坏，或正文包含任一保留 section label token 的同行污染，是 fail-closed 反例。每个 target 只携带权威 Full Story source scene、同镜非 Prompt 事实和相关 Foundation/Profile 锁。replacement 的三个段名必须各自从新行行首开始，并在 JSON 字符串中以 `\n` 分隔；仍须通过三段结构、时间线、纯文本 `dialogueOrSubtitle` 到 integrated `<d>` 的逐字映射、禁用引用标签与字符脚本屏障。本地脚本屏障不能证明正文确为英文，最终 Plan 的独立语义审计必须明确检查 `language_format`。合并后重新执行整批校验，最终 Plan 再做完整校验和独立语义审计。
- MiniMax H3 最终语义 Prompt：完整 Plan 确定性校验后，服务端签发逐镜证据目录并要求审计先判 shot facts、后判 `videoPrompt`。目录包括验签固定角色、Full Story 场次与 key props、完整 Foundation `visualBible/characterReferencePrompts/sceneReferencePrompts/assetPrompts`、同镜结构化字段和待审 Prompt。返回必须按镜头顺序逐项提供双层 verdict；每个 blocker 只可使用受控实质关系，并引用同镜受信 ID 与逐字 evidence。任一 shot facts fail 都使整次 Prompt repair 不可签发；只有全部结构化事实 pass 且失败项均属于 `videoPrompt` 时，最多把 12 个 Prompt string 作为一次有界 repair。模型不能返回 path/op/shot/Plan；合并后全部非 Prompt 字段及未命中镜头必须逐字不变，并重新执行完整 Plan 校验。随后只复审修复镜头及其前后相邻镜头，复审失败即终止，不得第二次修复。

任何已经解析但没有 adapter/可信 target 的内容错误都 fail closed，不发起第二次整包生成；repair 协议、authority、replacement 或完整复验失败同样终止。内容 repair 最多 primary + 一次局部调用。上述 `referenceAnalysis` frames-only 再取证是丢弃失败候选后的媒体证据重取，不是 repair。供应商/网络错误、签名或 lineage 冲突不是内容纠错，不能走该协议。旧 v2 首尾帧兼容路径仍是历史实现，不属于本节的当前 `direct_shot` 行为。

#### 有界局部纠错 Debug sidecar

只有 stage adapter 已成功签发 repair plan 时，服务端与 `run:video` 才在 `debug/partial-repairs/<UTC>-<stage>-<UUID>/` 建立一次观测 session，并在第二次 provider call 之前完成前两项写入：

1. `01-trigger.json`：原始错误、结构化 diagnostics、签发 target 的 currentValue、最小 authority 和摘要；
2. `02-repair-prompt.txt`：实际发送的局部 repair Prompt；
3. `03-model-response.json`：收到的 replacement 最小投影，额外字段只记录字段名而不记录值；
4. `04-result.json`：当前 repair adapter 完成合并/阶段复验后的 `repaired | rejected` 结论和脱敏拒绝原因；H3 的 `repaired` 不代表后续最终 Plan 语义审计或 Artifact 提交已经完成。

Plan 为 `null`、错误不可定位、候选不完整或属于 transport/lineage 问题时不创建该目录。记录器不得接收完整 Story/Foundation/Animation Plan 或原始 HTTP 响应，并递归脱敏 Header、密钥、Cookie、签名、Data URL 与 Base64 媒体。目录和文件使用私有权限与原子写入；单次写入失败只产生脱敏告警，不能覆盖业务错误、改变调用预算、补发模型请求或 fallback 保存 raw。`PARTIAL_REPAIR_DEBUG_DIR` 只能改变本地落盘目录，不能改变 repair 策略。

#### Full Story 全量模型输出 sidecar

Full Story 的完整 completion 观测与上述 repair Debug 是两套互斥职责的记录器。只有服务端环境显式配置 `FULL_STORY_MODEL_OUTPUT_LOG_DIR` 时，`ModelCallCoordinator` 才为 Full Story 的每个 primary、实际 retry/repair 与 Beat–Scene postpass attempt 按阶段原样保存 `completion.content`，不复用会按 256 KiB 截断且 30 分钟过期的 AttemptStore。日志不保存输入 Prompt、供应商 HTTP envelope、Header、密钥、Cookie 或任何媒体。浏览器把已有 Production request token 放在旁路 Header；服务端按 `projectId/runId/fullStory:<variantId>/requestId/expectedCurrentRevision` 核对 current running stage 后才标记为 verified，并明确区分 production requestId 与 provider requestId。无 Header 的直接 API 调用可记录为 unbound，但不得搜索其他 Run 猜归属。

每个 attempt 使用私有目录与文件权限、临时文件加原子 rename，日志 metadata 以明确的 `stage` 保存 primary、retry/repair 或 Beat–Scene postpass 阶段，并记录模型、状态、时间、字节数与 SHA-256；模型正文不截断。配置路径位于 `public/` 时禁用。任何验证上下文或写盘错误都只能产生脱敏告警，不得影响 Story Prompt、输出校验、重试/repair/postpass 次数、HTTP 结果或 Artifact commit。全量日志不会写入 manifest、Artifact、Checkpoint、包或导出 JSON，也不能用于恢复/合并失败 Story；它只证明某次模型 completion 实际包含什么文本，不能单凭词命中判定该文本是正向剧情还是负向规避说明。

#### Animation Plan 全量模型输出 sidecar

只有服务端显式配置 `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 时，`/api/animation-plan` 才在当前异步请求上下文内观测真实 `/chat/completions` 响应。响应克隆只在内存中解析，落盘内容严格限于 `choices[0].message.content`、finish reason、数值 usage、provider requestId、模型名和调用顺序/阶段标签；原 HTTP envelope、请求体、Prompt、Header、密钥和媒体不得落盘。output-only 模式不会创建现有 Animation Prompt 抓取文件。

浏览器沿用 Production request Header；服务端只有在 `projectId/runId/animationPlan:<variantId>/requestId/expectedCurrentRevision` 与 current running stage 完全一致时才标记 verified。缺失或不匹配时可写 unbound 日志，但不得猜测归属或影响生成。当前 direct-shot 首次 Plan 可观测 Foundation primary/局部 repair、各镜头批次 primary、实际发生的 H3 shot prompt 局部 repair、无 parsed candidate 时的批次 second-pass，以及最终合法 H3 Plan 的首次语义审计；未进入的阶段没有日志。每条 `model-output.txt` 是 provider 原始 completion 文本，不是 parsed candidate、Artifact 或事实源；观测、克隆、解析或写盘失败均 fail-open，validator、调用预算、repair 决策、错误文字和 Plan commit 必须保持不变。

### 阶段七：animationPlan

完整剧情生成后，可以继续生成用于 AI 视频制作的 `animationPlan`。当前临时主流程必须由请求显式传入 `animationPlanMode: "direct_shot"`，输出携带 `promptSchemaVersion: "3.0"`，且 `productionStrategy.format` 为 `direct_shot_video`；不得因镜头缺少端点字段而自动进入此模式。

首次生成 direct-shot Plan 时，浏览器还必须传入当前用户明确选择的 Seedance 2.0 或 MiniMax H3 镜头视频目标；服务端从登记表解析并把严格的 `productionStrategy.videoPromptProfile={schemaVersion,profileId,provider,model,guideVersion}` 注入 Foundation。该字段只记录本 Plan revision 的 `videoPrompt` 方言和规则来源，供 Prompt 构建、验证、切换比较与显示消费；不是运行时 provider/model 锁，LLM 不得输出、猜测或改写。H3 `guideVersion` 固定到 MiniMax 官方 [`skills/h3-prompt-writing`](https://github.com/MiniMax-AI/MiniMax-H3/tree/80365054c7fbaace01ed417076fecd532c1ae0e0/skills/h3-prompt-writing) commit `80365054c7fbaace01ed417076fecd532c1ae0e0`，不能自动跟随 HEAD。

浏览器还必须显式传入 `targetAspectRatio`，当前只允许 `9:16` 或 `16:9`。首次生成时，Foundation 的 `productionStrategy.targetAspectRatio` 必须与用户选择逐字一致；已有计划切换画幅时，用户选择作为新的计划级输出事实，不调用模型、不重写 shot，并提交同一 Animation Plan artifact 的新 revision/media namespace。该计划级字段是后续视频请求的画幅事实源；不得向 exact direct-shot 字段集合增加逐镜 `aspectRatio`。需要重新设计镜头构图时，用户再显式触发完整 Plan 重生成。

页面和 Markdown 的“镜头计划合计时长”由全部 `shotPlan[].durationSeconds` 求和派生；`productionStrategy.targetRuntimeSeconds` 保留为上游目标并用于显示偏差，两者不得自动互相覆盖。该合计是计划时长，不等同于供应商生成媒体经探测后的实际文件时长。

当前 `direct_shot` 仍先生成不含 `shotPlan` 的 foundation，再按 `fullStory.sceneScript` 分批生成镜头并按剧情顺序合并。`visualBible`、`characterReferencePrompts`、`sceneReferencePrompts`、`assetPrompts`、`editPlan` 与 `generationChecklist` 继续承担全局视觉锁、引用、剪辑和质检职责。每个 shot 保留：

- `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`；
- `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`；
- `negativePrompts` 与 `acceptanceCriteria`。

Seedance Profile 的 `videoPrompt` 是模型直接签发的一条自包含中文自然语言完整视频渲染指令，按“Foundation 风格与物理光线 → 地点环境 → 实际出镜主体与锁定外观 → `visibleAction` 顺序动作链和可见结果 → 内部摄影/剪辑顺序 → 节奏、对白与声音 → 本镜头相关稳定约束和停止条件”组织。MiniMax H3 Profile 在 Plan 阶段使用官方 Base/T2VA 三段：`integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`；三个段名必须各自从新行行首开始，并在 JSON 字符串中以 `\n` 分隔。三个 section 的叙述必须使用英文；`dialogueOrSubtitle` 保持上游纯剧情对白，不得含 `<d>`、翻译或拉丁转写，去除说话人前缀后的原文只在 integrated 中逐字包装为 `<d>[Chinese] ...</d>`；英文双引号中逐字保留的画面可见文字也可以使用原语言。`[Shot 1]` 不带时间戳，后续 `[Shot N] At MM:SS.mmm` 严格递增且必须小于 `durationSeconds`。H3 中的 `[Shot N]` 只是当前 `A0x` 业务 shot 内的摄影/剪辑段，不得据此增加 `shotPlan[]`。`cameraMotion` 同步记录同一业务 shot 内完整的摄影/剪辑顺序，其他逐镜字段保留各自职责并必须与 `videoPrompt` 一致。Animation Plan 阶段未绑定实际参考素材，不得生成 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>`。shot 禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段，也不得增加 `endStateRef` 等替代端点字段；`negativePrompts.image` 必须为 `[]`。Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 代码仍保留兼容，但这三个编译阶段不参与当前 `direct_shot` 主流程。

首次 MiniMax H3 Foundation 与全部 shot 合并并通过完整契约校验后，服务端还要单独调用文本模型执行上述逐镜证据审计。权威顺序固定为验签角色 > Full Story 实际出镜/地点/动作/对白/道具用途 > Foundation 外观锁（含完整 `assetPrompts`）> 同镜结构化实现 > Prompt。只有 `required_visible_cast_missing` / `extra_visible_cast_added`、动作/道具/身份/地点/终点/摄影/对白/声音/连续性/时长/语言等受控关系可阻断；同义翻译、未重复已表达内容、下一段时间戳自然界定上一段结束和 Foundation 已授权的视觉细化均不得阻断。只有明确的 `required_*_missing` 关系允许候选证据为空，新增、改写、重排或矛盾必须引用待审字段中的逐字证据。纯 Prompt fail 可走唯一一次有界修复与相邻复审；结构化字段 fail 或审计协议错误直接终止。最终通过回执以 `metadata.videoPromptSemanticAudit` 返回，但不进入 Plan JSON，也不成为第二份事实来源。

已有 Plan 后切换镜头视频模型的状态转移必须明确：先保留用户的新运行时模型设置，再比较目标 Profile 与 Plan Profile，并询问是否重新生成提示词；旧 Plan 缺失 Profile 同样视为 mismatch，禁止从现有 Prompt、provider 或模型名反推。拒绝时 Plan JSON、revision、media namespace 与媒体 current/stale 状态均不变化，新模型设置也不回滚；确认时只调用“视频提示词目标改写”，输入当前签发 Plan，输出与现有 shotId 顺序一一对应的 `videoPrompt`，服务端更新 Profile 并逐字保留全部其他 Plan 字段。完整契约校验后执行同一套证据审计；只有纯 Prompt 实质冲突可在提交前进行唯一一次有界修复与复审。只有最终改写、完整校验和审计都成功后才提交新的 Plan revision/media namespace，并递归 stale 旧媒体；任何失败都让旧 Plan 继续 current。首次 H3 Plan 与确认 Profile 改写都要求已配置的实时文本模型；demo mock 不得伪造英文翻译、语义审计结果或生产 Profile。合法反例：3 秒 Seedance shot 不满足 H3 最低 4 秒，Prompt-only rewrite 无权改变 `durationSeconds`，因此确认改写必须失败并要求完整重生 H3 Plan；拒绝重写虽然保留 Plan，但运行时 H3 也必须拒绝该镜头，不能钳制为 4 秒或 fallback。

Profile mismatch 的拒绝分支不允许继续用错方言生成：运行时 `MiniMax H3 + all_reference` 必须读取当前签发 Plan 的 exact H3 Profile，否则在 Context-IR 之前明确失败。模型设置保存/弹框本身不得调用 Context-IR；用户拒绝后可以继续使用原 Plan 或再作选择，但不能把其 Seedance/未知 Prompt 直接发送给 H3。

`direct_shot` 的场内业务拆镜边界只来自 `fullStory.sceneScript[].location` 与 `visibleAction` 中的人物主要动作目标。地点或主要人物动作目标变化时拆镜；同一地点、围绕同一主要目标形成完整叙事动作的连续阶段保留为一条业务 shot。任何输入中的景别、机位、构图、焦段、运镜或转场建议都只能决定已划定业务 shot 内部的摄影/剪辑表达，不得生成额外 `shotPlan[]`；同一 `videoPrompt` 可以按顺序描述中景跟随、关键动作特写、硬切或结尾宽景。`shotAndSound` 与 `shootingNotes` 继续提供摄影和声音参考，但不是镜头数量的事实源。每个 source scene 至少一镜；Seedance Profile 为 3–6 秒单镜，首次 MiniMax H3 Plan 使用项目生产子集 4–6 秒整数单镜。MiniMax V2 运行时协议总体只接受 4–15 秒整数，已有时长不合法时拒绝，不能钳制、补长或缩短。内部摄影变化允许但不强制，必须优先保证完整动作链。使用内部切换时，1–3 条验收标准必须覆盖动作顺序、可见终点和关键摄影切换，失败不得静默加镜或删动作。

#### 旧 v2 首尾帧兼容路径

旧 v2 计划携带 `promptSchemaVersion: "2.0"`。其逐镜结构如下：

- `startFrame` / `endFrame`：`timeAndWeather`、逐角色位置/朝向/姿态/手持物/视线/表情、前中后景、摄影机规格、物理光源、风格修饰和连续性锁；两端都必须是可独立生成的完整静态规格。
- `motion`：一个 `primaryAction`，`locked` 或 `continuous` 摄影机，起止情绪与可见表演，环境/光线变化，1–4 个连续覆盖 0–100% 的 `timingBeats`，对白/环境声/音效，以及到达尾帧后的停止条件。
- 固定摄影机要求两端核心机位一致；连续摄影机允许机位变化，但必须声明技术、路径、速度和动机。普通 shot 不允许切镜或更换地点；循环镜头必须回到兼容首帧的状态。
- `postRetime` 只记录后期变速建议，不发送给生成模型。项目配乐仍在后期统一，逐镜音频只负责对白、环境声和同步音效意图。

兼容字段 `startFramePrompt`、`endFramePrompt`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes` 全部由共享编译器确定性生成。模型不得同时撰写第二套字符串；若导入的 v2 数据同时带结构和不一致的兼容字段，契约校验直接失败。

旧 v2 服务端兼容路径仍拆成三步，但 `POST /api/animation-plan` 的请求和最终响应保持不变：

1. 生成 `animationFoundation`：只生成 `visualBible`、角色/场景/资产参考和其他全局字段，不生成、占位或推测 `shotPlan`。场景参考使用服务端私有 `sourceSceneIds` 锁定剧情场次与 `sceneId` 的唯一映射；共享地点可将多个场次映射到同一场景。
2. 按 `fullStory.sceneScript` 每 2 场分批生成仅含 `{ "shotPlan": [...] }` 的结构化镜头结果。每批只能覆盖指定 `sourceSceneId`，且 shot 必须使用基础阶段锁定的对应 `sceneId`。当前批会与前面已通过的镜头一起校验；包括跨批重复负面词在内的错误，都只使用现有纠偏机制重试当前批。
3. 服务端按剧情顺序合并，统一编号 `A01...`，保留三类结构化对象，编译兼容字符串，同步重写逐镜负面词的 shot 证据路径，重算 `sceneReferencePrompts.relatedShotIds`，然后再执行一次完整 `animationPlan` 契约、正向边界和负面词相关性校验。下一批会收到上一镜完整 `endFrame` 与运动终态，而不是只收到一段尾帧散文。

分阶段结果是服务端私有结构，不写入前端状态或导出文件。旧 v2 合并结果同时包含结构和兼容字符串；无 `promptSchemaVersion` 的更早计划继续按 legacy 字符串读取，不尝试从散文反推结构。这些兼容规则不得为 `direct_shot` 补写端点字段。

#### 两种契约共用的逐镜负面提示词

每条逐镜渲染负面词必须包含：

- `text`：最终负面描述；
- `appliesTo`：`image`、`video` 或 `both`；
- `triggerEvidence`：一个或多个 `{ sourcePath, evidence }`，指向固定角色、当前分场动作、当前 shot prompt、真实参考输入或真实供应商失败记录；
- `reasonCode`：仅允许 `explicit_identity_conflict`、`shot_object_confusion`、`shot_interaction_failure`、`temporal_consistency_failure`、`reference_leak`、`proven_provider_failure`；
- `priority`：`high`、`medium` 或 `low`；
- 可选 `enabled`：设为 `false` 时表示停用，内置单镜头生成和外部供应商程序都不应将它编译进请求。

图片和视频数组都允许为 `[]`，不设最少条目数；其中 `direct_shot` 的图片数组必须严格为 `[]`，只交付视频负面词。没有可解析证据、仅以“用户未声明/未提及”为理由、媒介不匹配、把台词规则混入画面、或在没有实际原片参考输入时使用 `reference_leak` 的候选项，会在工作流相关性裁剪中删除；保留下来的非法结构会触发现有模型纠偏重试。不同 shot 不得无差别复制同一组负面词。

剧情页必须提供两个供应商交付出口：

- JSON 导出：当前测试/规划包版本为 `3.0`。服务端只对当前 Variant、Full Story 和可选 Animation Plan 的一致 lineage 签发摘要与本机 HMAC；导入先验证 package type/version/digest/signature/parent lineage，再建立隔离的新 Run，禁止与当前浏览器状态合并，且不信任包内旧媒体选择。
- Markdown 复制：当前 `direct_shot` 按逐镜 `videoPrompt`、运镜、角色动作、对白/字幕、声音、连续性、视频负面词和验收标准交付；旧 v2 才整理首帧、尾帧及其兼容字段。

页面内保留单镜头试片链路。`POST /api/generate-shot-video` 一律要求当前 Animation Plan 的 production context；服务端从该 Plan 的 `shotPlan[]` 唯一解析 `shotId`，忽略客户端自报的动作、时长、场景和负面词，不能由客户端省略 Schema 标记降级到无 lineage 的全局目录。弹窗允许编辑的视频提示词通过独立 `promptOverride` 传入，属于当前媒体请求的显式运行时覆盖，回执记录 `videoPromptSource` 与实际提示词；它不反向修改 Plan 的其他镜头事实。`generationMode` 是模式权威字段，不从端点字段缺失、provider、模型名或素材数量推断：

- `first_last_frame`：首帧和尾帧是精确端点，仍执行现有尾帧硬依赖校验；Kling、Seedance 与 MiniMax H3 均可使用。无端点的 `direct_shot` 不可使用该模式，必须明确失败，不能据此自动改选 `all_reference`。
- `all_reference`：请求中的 `referenceAssets[]` 是用户/角色/旧端点参考素材权威来源；可选的 `continuityReferenceMode` 只允许 `none | previous_shot_frames`，并且不能反向推断或改变 `generationMode`。当用户逐镜显式选择 `previous_shot_frames` 时，“上一镜”只能由当前签发 Plan 的 `shotPlan[]` 紧邻前项确定，服务端再从其 current `shotVideo:<variantId>:<shotId>` Artifact 读取当前选中候选，拒绝客户端自报的绝对路径、远程 URL、旧 namespace 或非相邻 shot。服务端用 FFmpeg 每秒抽取一张 JPEG，作为普通 `reference_image` 追加；首尾帧和角色图也只有在用户显式勾选后才作为普通参考图加入。该模式不生成或校验精确端点，不得混入 `first_frame` / `last_frame`。当前仅 Seedance 2.0 与 MiniMax H3 有已验证的 R2V API 协议；可灵当前 image-to-video 接入必须明确失败，不能静默降级。

当运行时模型是 MiniMax H3 且 `generationMode=all_reference` 时，只有用户点击生成后，服务端才冻结本次真正会发送的有序参考 manifest（角色、顺序、来源、内容摘要以及上一镜 source lineage），再用完全相同的引用发起供应商计费的异步步骤 `POST /v2/h3_context_ir`；保存/切换模型、取消 Profile 改写或仅打开弹窗都不能触发它。返回的 Ref2VA Prompt 必须严格包含 `subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music` 六个英文 section，原语言例外与 Base 相同；`<Picture/Video/Audio N>` 必须与同类实际 `content` 顺序逐项绑定，`<Subject N>` 必须在 `subject_definitions` 中由当前签发主体或实际引用明确定义，任何标签不得悬空。图片只定义主体、场景、服装或风格时，`<Picture N>` 只能作为来源内嵌在对应 Subject definition；普通 `all_reference` 不授权独立 Picture keyframe/storyboard definition 或 retention。签发角色图必须只作为来源内嵌到对应 `<Subject N>` definition；不得为其 `<Picture N>` 单独生成 definition 或 retention。若某个角色-only Subject 的全部来源均为签发 `character_reference`，其 `retention_analysis` marker 必须精确为 `fully_preserved`；该 marker 仅锁定身份与外观，不要求复制参考图的姿势、动作、构图或背景，当前 exact shot 要求的新动作、新姿势和目标场景不属于身份或外观降级。只要签发角色图实际进入该次冻结 manifest，它就是这个角色在 H3 运行时的静态外观来源：最终 Ref2VA Prompt 应通过内嵌 `<Picture N>` 的 `<Subject N>` 表达静态身份与外观，不能重复 Base Prompt 或遗留外观锚点中的静态发色、五官、体型、常规服饰或画风描述；只有该角色图未实际传入时，Base/外观文字才作为 fallback。此规则不授权丢弃当前 exact shot 的动作、姿势、表情、道具、场景、摄影、声音或剧情明确要求的动态外观变化，也不允许图片覆盖 `fixedCharacterBoundary` 的身份、物种或签发必需特征；任何冲突必须失败。它是 MiniMax H3 Context-IR 的运行时规则，不修改 Seedance Profile。普通上传或上一镜来源必须另建独立的弱参考 Subject，marker 精确为 `weak_reference`，且不得与签发角色图混合绑定在同一 Subject。普通参考的 `summary` 只允许 `[reference generation]` 或实际有音频时的 `[reference generation + audio reference]`。上一镜 JPEG 只能声明为一致性 weak reference/reference-generation，不得被 Context-IR 解释成 editing、continuation、关键帧或 fully-preserved 内容。本地确定性检查负责六段结构、时间线、标签、retention 与边界，并以字符脚本屏障拒绝非 Latin script 的正文；该屏障不能证明正文确为英文。服务端随后必须通过已配置文本模型执行只读语义一致性审计并明确检查 `language_format`；非英文、无法确认、审计协议错误或 verdict 非 `pass` 时不得调用最终视频生成。Context-IR 请求失败、返回不满足六段契约、引用错绑或供应商扩写与权威事实冲突时，本次视频生成明确失败，不得退回 Plan Base 三段、Seedance 写法或通用散文；该阶段也不得改变 `generationMode`。

这里的权威优先级按职责而不是按“文字更长”决定：用户对是否改写的明确确认只控制是否产生新 Plan；当前签发的 Full Story、exact shot、`fixedCharacterBoundary` 与 Foundation 锁控制剧情、身份、动作、时长、场景和声音；冻结参考 manifest 控制素材编号与角色；Plan `videoPromptProfile` 控制方言；Context-IR 供应商扩写处于最末层。`promptOverride` 只覆盖本次媒体文本，也不能越过 exact-shot 权威字段。

全能参考共同限制为图片最多 9 张、视频最多 3 段、音频最多 3 段，单段视频或音频 2–15 秒，视频与音频各自总时长不超过 15 秒，不能只输入音频，请求体不超过 64MB。上一镜实际抽帧与已有图片合并后共同计算 9 图上限；抽帧前先按实测时长预拒绝超过 9 张的输入，超限必须明确失败，不能丢弃角色图或静默减少抽帧。服务端以无符号链接文件句柄把上一镜冻结到当前任务私有临时目录，再按实际字节、ffprobe 时长和带超时的 FFmpeg 输出验证媒体；回执记录源视频 SHA-256 和每张抽帧的时间点/SHA-256。上一镜抽帧默认只表示 `intentional_next_shot` 的一致性弱参考：即使 `sourceSceneId/sceneId` 相同，也不能推断同一物理地点或无缝续拍；当前镜头的剧情动作、固定角色边界和目标场景优先，跨地点、跨时段、上一镜漂移或已完成动作可能被重演时应不勾选。两种模式均支持异步轮询、下载 mp4、1–4 个候选结果，以及回执中的 `negativePromptDelivery` 和脱敏 `requestPreview`；输出文件名包含每请求随机 nonce，写入后必须通过 ffprobe 验证存在可解码视频流和有效时长。

#### Production Lineage 与状态恢复

浏览器每次从视频输入重新运行主流程都会创建一个隔离 Run。每个成功阶段由服务端根据 canonical JSON 计算 SHA-256，签发单调 revision，并记录它实际消费的上游 `{ artifactId, revision, contentDigest }`。Variant 内容变化会使旧 Full Story 以及依赖它的 Animation Plan/媒体递归 stale；只改变对象键顺序不算内容变化。模型输出本身不得生成或修改 lineage。

前端在模型调用开始时冻结依赖 revision 与 `expectedCurrentRevision`。返回时同时检查本地 request token，提交时再由服务端检查 optimistic concurrency 和上游仍为 current；任一条件失败都拒绝回写。媒体还必须携带当前 Plan 的 `mediaNamespace`，目录与文件名同时绑定 project/run/plan revision/digest。使用上一镜抽帧的后镜 `shotVideo` Artifact 同时依赖当前 Plan 和上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选会递归使所有依赖它的后镜视频 stale，切换后镜自身候选时不得丢掉这条依赖。

服务端在 `runtime/production-runs/` 持久化 Run、Stage、Artifact、Checkpoint。页面刷新后可以恢复已完成 JSON artifact，并从最后 checkpoint 继续下游操作；原始上传视频和仍在执行中的远端模型调用不属于 checkpoint，刷新后不能自动续传或接管。完整契约见 `docs/production-lineage-state.md`。

仓库不提供 JSONL 任务队列、完整 production workspace、批量执行器、本地视觉质检、失败队列自动重试或 ffmpeg 成片合成。整片批量生成时，外部供应商程序负责把当前 `direct_shot` 的 `videoPrompt`、逐镜职责字段、`negativePrompts.video` 和验收标准映射到自身协议；只有旧 v2 兼容计划才映射首尾帧。

## 3. 模型与媒体策略

- 浏览器从本地视频均匀采样 6–10 张关键帧，最长边压缩到 720px；在 MiMo `auto/video` 模式且文件大小允许时，同时用 base64 `video_url` 发送原生视频。应用不持久化视频。
- `auto` 模式下，推理服务不接受原生视频时自动回退关键帧；超出大小限制时直接走关键帧。
- MiMo 多模态视觉输入必须在文本指令之前；用户消息末尾保留 `/no_think`，请求体同时设置 `thinking={"type":"disabled"}`。
- 默认阶段路由保持 Qwen 优先、MiMo 回退。DeepSeek 只在页面按阶段显式选择后参与创意简报、主题变体、Legacy Full Story、Animation Plan，或旧 v2 兼容路径的 Static Frame Compiler；默认模型为 `deepseek-v4-flash`，`deepseek-v4-pro` 为显式可选项，不静默回退。
- DeepSeek 请求只发送字符串文本，使用官方 OpenAI 兼容 `/chat/completions`、`max_tokens`、`thinking` 和 JSON Output。参考片分析、脚本还原、视觉规则、人物图修正属于媒体输入阶段，前端不提供 DeepSeek，服务端也会在 provider 调用前拒绝绕过请求。
- 当前实现通过小米 OpenAI 兼容 `/chat/completions` 接口连接 MiMo V2.5；原生视频使用 `video_url`，并携带 `fps=2`、`media_resolution=default`。Qwen 通过阿里云 Model Studio OpenAI 兼容 `/chat/completions` 接收文本、图片或视频。未配置服务时使用明确标注的演示模式。

## 4. 当前边界

- 项目固定使用 Node.js 24 LTS（见 `.nvmrc`，`package.json` 限定 `>=24 <25`）；验收测试应在该版本执行，避免把非支持版本或受限沙箱禁止监听本地回环端口造成的 native assertion 误判为业务失败。
- 原生视频过大或推理服务不支持 `video_url` 时会回退浏览器抽帧；快速剪辑、声音设计和未出现在采样帧中的动作可能遗漏。
- 音频尚未自动转写。需要准确对白时，应粘贴字幕/转写，或后续增加 ASR 阶段。
- 模型输出经过 JSON 解析、阶段契约校验和至多一次受控纠偏；Legacy Full Story 另经过内部 exact JSON Schema 与 Scene Contract。
