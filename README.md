# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 启动

要求 Node.js 24，`package.json` 明确限制为 `>=24 <25`。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，演示流程仍可运行，但结果不是对视频的真实判断。在已有 Plan 上确认改写视频提示词方言必须配置可用的文本模型；demo mock 不会伪造语义审计结果或生产 Profile。

## 全局角色边界

`Visual Guardrails` 是固定角色语义唯一生成阶段。视觉模型会结合用户角色描述、参考分析、脚本还原和创意简报，一次性输出 `requiredTraits`、`allowedTraits` 与 `forbiddenTraits`；可以使用模型常识理解“狼娘”等开放概念，但不依赖本地写死的物种关键词字典，且用户明确肯定或否定的设定优先。

创意简报和视觉规则列举同类具体物品时，会要求模型逐项写出完整名称，例如“绿色邮箱、红色邮箱、蓝色邮箱”，不允许用“绿色、红色、蓝色邮箱组合”共享末项名词。旧的歧义缩写不会由本地规则猜测补全，需要重新生成对应的 Brief 与 Visual Guardrails。Visual Guardrails 侧已有确定性校验兜住这条：`sourceSimilarityRules[].sourceExpression` 的每一项都必须逐字出自本规则引用的证据，模型自行补全中心名词会直接失败。

Creative Brief 中的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression` 和 Visual Guardrails 中的 `sourceSimilarityRules` 只记录原片表面表达的来源，不再作为下游正文禁词。原片道具、拟声词或角色组合可以随所选剧情进入 Variant、Legacy Full Story 与 Animation Plan 的正向业务字段，包括 `visibleAction`、对白、声音和 `videoPrompt`；系统不会仅因为某个表达出现在来源上下文中就把它机械写入正向内容。`sourceSimilarityRules` 只在生成请求实际携带原片参考时，为 `reference_leak` 提供证据；`dialogueRules` 也只能来自用户明确约束，不会由原片对白或拟声词自动生成。固定主角仍须服从已签发的 `fixedCharacterBoundary`，上述放行不授权修改其身份或外观。

Creative Brief 的 `allowedNarrativeComponents` 使用服务端固定的七项通用叙事分类。实时模型不会自行决定分类名，只为每一项填写非空的安全复用说明；即使本次不采用某类构件，也必须保留该项并说明限制，避免同义改名或漏项导致契约失败。每条说明还必须以 `【原片有】` 或 `【原片没有】` 开头先判定原片是否真的存在该构件，避免模型替原片补出它并不存在的叙事构件（例如原片只是陪伴，却被写成送货任务）。判定为「原片有」时还必须引用上游依据，服务端会按字符覆盖率回查核对；允许转述措辞，但编造的情节会被拒绝。

服务端会将该边界与当前上游数据摘要绑定并签名。主题变体、Legacy Full Story、Animation Plan、人物参考精修、角色图、旧 v2 首尾帧和视频生成只消费同一份已签发边界，不会在每个阶段重新识别关键词或重新推断角色特征。修改固定角色、赛道、限制、字幕或参考视频会使旧边界失效，页面要求重新运行工作流。

## Story Candidates Phase 1

`themeVariants` 保留原有 wire shape 和 Artifact 名称，但 `variants[]` 已按递归 `additionalProperties: false` 的严格 Story Candidate Schema 校验。原有候选字段全部保留，只新增五个候选级非空字符串：`keyChoice`、`climax`、`emotionalPayoff`、`novelty`、`visualPotential`。本地代码只检查契约、唯一 id、Beat 顺序、固定主角，以及**任意两个**候选在 `dramaticFunction` 序列 + `keyChoice` + `climax` + `emotionalPayoff` 投影上都不同；不用题材关键词或本地语义评分判断故事质量。

其中 `characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 是**可选键**：写了必须非空，不需要就整个省略。它们此前是必填位，等于强制每个候选都长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」。`storyOutline` 同时从「恰好 6 拍 + 固定相位词表」放开为 5–7 拍、相位由候选自行命名，`keyChoice`/`climax`/`emotionalPayoff` 仍逐字绑定到某一拍，但不再钉死在固定拍号，只保留「关键选择拍 < 高潮拍 < 最后一拍且中间隔一拍」的因果序约束。Full Story 侧对应放开 `characterBible.careRecipient`，并禁止把候选阶段省略的叙事构件补回来。

放开拍号的同时把这三个字段改为**服务端派生**：模型只输出 `keyChoiceBeat`/`climaxBeat` 两个整数拍号，服务端从 `storyOutline` 取出 `keyChoice`/`climax`/`emotionalPayoff`（后者恒取最后一拍），模型回显一律覆盖。此前要求模型逐字重复长句，实测合规率两极分布并多次硬失败——这三个值可从 `storyOutline` 唯一推导，不应由模型回显，与 direct_shot 的处理一致。

用户点选 Candidate 后，完整内容以 `variant:<id>` Artifact 签发。Full Story 请求同时绑定它的 `artifactId/revision/contentDigest`；服务端在模型调用前后各复验一次 current Candidate，用落盘内容替换请求副本，且不把 binding sidecar 传入 Prompt 或 Legacy Full Story。因此同一 id 下修改标题、任务、关键选择或高潮都会换 digest/revision，旧请求与旧下游不能继续被视为 current。

恢复时只认 current Full Story/Animation Plan 的 `selectedVariantId` 或 current `variant:<id>` 明确选择记录；只有 Theme Variants 时 `selectedVariantId` 保持 `null`，不再默认选中 V1。离线质量基线用法见 [docs/story-quality-evaluation.md](docs/story-quality-evaluation.md)；该入口不调用外部模型，九项主观维度默认都是未评分。

本轮没有 Story Selection/Blueprint/Script Doctor/Rewrite/Production Package 4.0。Phase 2 唯一预留接缝是已签发 Candidate 的完整内容与精确 lineage reference；未来 Blueprint 必须消费这对受信输入，不能只凭 id 识别候选。

Phase 1.1 的真实包回放进一步明确：当前结构签名保证的是字段文本投影不同，不是整批候选的语义因果链一定不同。Creative Brief Prompt 现在只允许强保真字段记录抽象剧作价值；Theme Variants Prompt 只展开定位、受众、核心情绪、情绪结构与 `dramaticValue` 投影，不再把历史 Brief 中可能具体化的 `storyEngine`、`mustRetain`、`samePlotDriver`、`sameBeatValue` 或 `creativeDistancePolicy` 值当作正向候选命令。旧 Brief Artifact 本身不会被改写。Prompt 中的因果、Beat 必要性和连贯性要求仍不是确定性验证；真实 5×4 回放中的 Schema 与精确字段投影可以全部通过，人工仍可能发现物品状态或动作顺序矛盾。Brief 抽象层风险和三条已知下游失败样本已登记到 [`T09 Phase 2 Story Blueprint 与候选语义质量闭环`](docs/GitHub-Benchmark-%E5%90%8E%E7%BB%AD%E6%94%B9%E9%80%A0%E5%BE%85%E5%8A%9E.md#t09phase-2-story-blueprint-%E4%B8%8E%E5%80%99%E9%80%89%E8%AF%AD%E4%B9%89%E8%B4%A8%E9%87%8F%E9%97%AD%E7%8E%AF)；本轮未修改 Story Candidate Schema、Full Story 或 Animation Plan 行为。

## 模型输出有界纠错

当前主流程不再把一份已经解析、但校验失败的完整 Artifact 直接交给模型整包重写。服务端只接受稳定的结构化 diagnostics（`code + RFC 6901 JSON Pointer + reason`）；当候选完整、路径可信、目标已存在且权威事实唯一时，才签发一次局部计划。当前有两套互不混用的协议：Legacy Full Story 使用专用 `full_story_partial_repair/1.0`；`artifact_partial_repair/1.0` 编排 Animation Foundation 固定角色安全子集。第二次请求只包含错误目标的当前值、修复说明和最小权威投影，模型只能按服务端 `repairId` 返回 replacement，不能自报 path、JSON Patch 或额外操作。

服务端在 clone 上核对私有签发的计划、`baseDigest`、可变路径、目标内既有事实、目标外摘要和当前权威，再原子合并并从头执行该阶段完整校验。局部响应仍错误、路径不可信、候选不完整、权威冲突或错误没有专用 adapter 时都会明确失败，不会退回整包重生。当前生产覆盖仅包括 Full Story 中可由签发 `fixedCharacterBoundary.characterName` 唯一恢复的 protagonist `name`、Foundation 唯一固定角色参考的安全错误子集，以及证据绑定审计确认全部结构化事实通过后的纯 `videoPrompt` 冲突。Foundation 只缺 `requiredTraits` 时，`appearancePrompt` 与原标签逐字冻结，模型只能在 `consistencyTags` 尾部按签发顺序追加缺失事实的 `canonicalName`；禁止表达命中时只开放实际命中的字段做受限删除，混合错误中的缺失事实仍只能追加标签。Full Story 的未知正文错位、配角身份字段缺失或错误、`characters` 与 `visibleAction`/`dialogue` 冲突，以及没有签发值来源的必填剧情字段都直接失败。repair 成功后仍必须通过整批校验、最终 Plan 校验和独立语义审计。旧 v2 首尾帧兼容代码不属于当前 `direct_shot` 主流程。

唯一的已解析候选再取证例外是 `referenceAnalysis`：原生视频模式候选仅因 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧时，服务端丢弃该候选，不把失败 Artifact 或 diagnostics 发回模型，只用 `video=null` 和既有 frames 重新取证一次。这是媒体证据重新获取，不是局部 repair；第二次仍失败就终止。

## 局部纠错 Debug

服务端和 `run:video` 命令会在 `debug/partial-repairs/` 中，为每次**已经成功签发 repair plan** 的 Full Story、Animation Foundation 或 H3 `videoPrompt` 局部纠错创建独立目录。目录依次记录触发错误与结构化 diagnostics、实际发送的局部修复 Prompt、模型返回的 replacement 投影，以及最终接受/拒绝结果；如果错误不能安全定位、没有签发 repair plan，则不会伪造一条 debug 记录。

Debug 只保存命中目标的当前值和最小权威投影，不保存整份 Story/Foundation/Animation Plan、HTTP Header、API Key、Cookie、Data URL 或 Base64 媒体。它是写失败不影响业务结论的本地观测 sidecar，不是 Artifact、Production Lineage、恢复数据或导出包内容。默认目录可通过 `PARTIAL_REPAIR_DEBUG_DIR` 覆盖；文件格式与排查方法见 [`debug/README.md`](debug/README.md)。

## Full Story 与 Animation Plan 全量模型输出日志

当需要排查“模型究竟把某段正文写进了哪里”时，可由服务端环境显式设置 `FULL_STORY_MODEL_OUTPUT_LOG_DIR`。开启后，每次实时 Full Story primary、实际发生的 retry/repair 与 Beat–Scene postpass completion 都会按阶段分别保存模型返回的完整 `content`，不采用 AttemptStore 的 256 KiB 截断；metadata 明确保存 `stage`，并同时记录字节数、SHA-256、provider/model、供应商 requestId，以及经服务端核对的 project/run/variant/production requestId。浏览器通过 HTTP Header 旁路传递 Production token，日志上下文不会进入 Full Story Prompt、业务 JSON 或 Artifact。

Animation Plan 使用独立的 `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR`。它在真实 `/chat/completions` 响应交给 JSON parser 前，只提取并保存 `choices[0].message.content`，因此能够保留 Foundation、镜头批次、H3 有界局部纠错与首次语义审计的原始文本、空白和段名格式；每条记录带安全的调用顺序与阶段标签。它不会因为开启输出日志而顺带开启现有 Animation Prompt 抓取，也不会把 Production trace 混入 Animation Plan 请求体、Prompt 或业务 JSON。

两类日志都不保存输入 Prompt、HTTP 请求/响应包、Header、API Key、Cookie、Data URL 或 Base64 媒体。目录必须位于非 `public/` 的本机私有路径，文件内容可能包含完整未通过校验的剧情或镜头提示词，应按敏感调试数据管理。未配置对应环境变量时完全禁用；读取、解析或写入日志失败只产生脱敏告警，不改变校验、重试次数、Artifact 提交或错误结论。日志不是 Production Lineage、事实来源、恢复数据或导出包内容，只能从启用后的下一次请求开始记录，不能追溯此前已丢失的响应。当前本机建议配置为：

为兼容 Windows 路径长度限制，已绑定 Production 的目录名只保留可读 Artifact 名称，并把 project/run、production request 和 operation 标识写成短 SHA-256 摘要；完整标识仍逐字保存在同目录的 `metadata.json`，摘要只负责文件系统隔离，不参与业务 lineage。

```dotenv
FULL_STORY_MODEL_OUTPUT_LOG_DIR=debug/full-story-model-outputs
ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR=debug/animation-plan-model-outputs
```

## Full Story 局部纠错

Legacy Full Story 当前只对一种可证明的内容错误启用唯一一次局部纠错：首次输出已是完整 JSON，结构化诊断精确指向 `/characterBible/protagonist/name` 的缺失、类型或空字符串错误，并且当前验签 `fixedCharacterBoundary.characterName` 提供唯一正确值。第二次请求只发送 protagonist 子树、诊断、签发姓名与最小角色/Variant 约束；不会再发送整份失败 Story 或原始完整生成提示。服务端以当前进程内的私有签发身份冻结原候选摘要、权威摘要、目标和修复编号；模型返回的 plan 副本或自造 path 无效。合并时重新投影当前权威，要求 `name` 逐字等于签发值，并证明目标外以及目标内其他字段保持不变。

合并结果仍须重新通过 exact JSON Schema、Scene Contract、固定角色、Variant 与既有语义边界。未知正文即使看似行为、外观或情绪，也没有服务端可验证的字段级目的地，因此当前一律不自动搬运。配角姓名/身份字段错误、`characters` 与可见动作/对白的冲突、没有签发值来源的必填剧情字段、截断、非法 JSON、无可信路径、整项内容丢失或其他不能安全局部化的错误不会被猜测修复，也不会静默发送整份 Story 重写；局部响应仍失败时终止，只有最终完整合法的 Story 才会保存。

## Full Story Beat–Scene 提交前复核

初轮 Full Story（包含实际发生的唯一允许 retry 或 protagonist 姓名局部纠错）通过全部既有校验后，服务端会在提交 Artifact 前独立请求一次同一文本 provider/model，对照只读的 `beatSheet` 与可拍的 `sceneScript` 查找会造成明显叙事断裂的遗漏。这次请求的业务内容只有完整、已合法的 Full Story JSON 和专用复核提示；不会再次上传 Theme Variant、Brief、Visual Guardrails、原片边界、分析或重构数据。

复核只能保持 Story 不变，或把某个对应 `beatSheet[beatIndex].storyAction` 中连续、逐字相同的原文作为 `addition`，追加到已有 `sceneScript[].visibleAction` 末尾；模型不能自由生成 suffix、释义或拼接多个不连续片段。每条提议还必须返回 `beatEvidence`，`addition` 必须包含这段逐字证据；全部证据只能是该 `storyAction` 与目标/相关场次现有 `visibleAction` 的逐字 excerpt。无法从 `storyAction` 逐字投影所需内容时必须返回 `blocked`，不能另写一个“更顺”的动作。

一次 postpass 最多处理 3 个已有场次，每条 `addition` 最多 600 字，全部 additions 合计最多 1200 字。原 `visibleAction` 必须逐字保留为前缀；场次数量、顺序、人物、地点、对白、镜头/声音和其他全部字段都被冻结。合法省略、蒙太奇概括、末项代表整组或已有终态证据不会被机械投影；超限、证据错绑或 addition 不是对应 `storyAction` 的连续原文都会按协议错误拒绝。

正常路径为初轮生成加 postpass，共 2 次 provider call；初轮消耗一次允许的 retry/repair 后成功时，整个 operation 最多 3 次，不存在第四次调用。postpass 返回 `blocked`、协议或供应商错误、越界/非追加改写，或者合并后完整复验失败时，整次请求 fail closed：不保存初轮候选、不回退原 Story，也不再次复核。只有最终 unchanged 或合法追加并通过全部校验的 Full Story 会提交一次 Artifact；初轮候选和复核响应都不会形成额外 revision。

## 接入 Xiaomi MiMo V2.5

项目默认使用小米官方 OpenAI 兼容接口和 `mimo-v2.5` 模型。先确认模型服务可访问：

```bash
curl https://api.xiaomimimo.com/v1/models \
  -H "Authorization: Bearer $MIMO_API_KEY"
```

然后在本项目中复制环境变量文件：

```bash
cp .env.example .env
```

至少配置：

```dotenv
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_API_KEY=你的 key
MIMO_MODEL=mimo-v2.5
MIMO_STORY_MODEL=mimo-v2.5-pro
MIMO_ANIMATION_MODEL=mimo-v2.5-pro
MIMO_REQUEST_TIMEOUT_MS=900000
MIMO_MEDIA_MODE=auto
```

连接成功后，页面右上角会显示当前解析、剧情和动画阶段使用的模型。

`MIMO_MEDIA_MODE=auto` 会优先通过 `video_url` 发送原生视频；请求中会按 MiMo V2.5 文档携带 `fps` 与 `media_resolution`，默认 `MIMO_VIDEO_FPS=2`、`MIMO_VIDEO_MEDIA_RESOLUTION=default`。若服务返回不支持媒体类型的 400/415/422，再自动回退为带时间戳关键帧。超过 `MIMO_NATIVE_VIDEO_MAX_MB` 的视频直接使用关键帧，避免 base64 请求占用过多内存。

MiMo 请求参数默认为 `temperature=0.3`、`top_p=0.95`、`max_completion_tokens=8192`、`thinking=disabled`、`stream=false`。如果没有配置 Qwen，参考片分析、脚本还原、creativeBrief、主题变体、完整剧情和动画生产包都会回退到 MiMo 的对应模型。

`MIMO_THINKING=disabled` 时，MiMo 用户消息末尾会追加 `/no_think`；改成 `MIMO_THINKING=enabled` 后，请求体会发送 `thinking={"type":"enabled"}`，并且不会再追加 `/no_think`。

如果希望参考视频解析和后续文本阶段默认改用千问，继续增加：

```dotenv
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=你的 DashScope 或 Model Studio key
QWEN_MODEL=qwen3.7-max
QWEN_VIDEO_MODEL=qwen3.7-plus
QWEN_ANALYSIS_MODEL=qwen3.7-plus
QWEN_RECONSTRUCTION_MODEL=qwen3.7-plus
QWEN_BRIEF_MODEL=qwen3.7-max
QWEN_VISUAL_MODEL=qwen3.7-plus
QWEN_VARIANTS_MODEL=qwen3.7-max
QWEN_STORY_MODEL=qwen3.7-max
QWEN_ANIMATION_MODEL=qwen3.7-max
QWEN_CHARACTER_REFERENCE_MODEL=qwen3.7-plus
QWEN_REQUEST_TIMEOUT_MS=900000
QWEN_MEDIA_MODE=auto
QWEN_NATIVE_VIDEO_MAX_MB=7
QWEN_VIDEO_FPS=2
QWEN_ENABLE_THINKING=false
```

### 阶段 token 消耗与费用估算

每个阶段结束时，页面会在该阶段原有的状态文案后面追加本阶段消耗的 token 与预估金额，例如「完整剧情已生成 · qwen3.7-max · 本次消耗 12,345 tokens · 约 ¥0.12」。
这里的「阶段」是用户点一次按钮触发的整个操作：**启动 AI 导演** 会累加解析、还原、简报、护栏、变体五个请求；**完整剧情** 与 **动画镜头生产包** 各是一个请求，但内部的重试、局部修复与语义审计调用都已计入。

阶段失败时同样报账，措辞换成「失败前已消耗」，例如「模型输出未通过校验：… · 失败前已消耗 48,120 tokens · 约 ¥0.58」；启动 AI 导演在第几步失败，就把失败之前已经成功的那几步一并计入。失败前调用过的模型照样计费，把它藏起来会让人以为一次失败的生成是免费的。只有一种情况显示不出来：请求根本没打到模型（鉴权失败、连接超时、供应商直接返回 HTTP 错误），此时确实没有产生 token。

token 数直接来自各家响应的 `usage`，不产生额外调用。金额需要你自己配置单价，本项目不内置任何价格表：

```dotenv
# 模型ID=输入单价/输出单价，逗号分隔，单位「元 / 百万 token」
# 需要覆盖三家文本模型实际用到的全部型号，缺一个那个模型就只报 token 不报金额
MODEL_PRICE_CNY_PER_MILLION=qwen3.7-max=12/36,qwen3.7-plus=2/8,mimo-v2.5=1/2,mimo-v2.5-pro=3/6,deepseek-v4-flash=0.5/1.5
```

模型 ID 必须与实际使用的 `*_MODEL` 完全一致：Qwen 是 `qwen3.7-max`/`qwen3.7-plus`，MiMo 是 `mimo-v2.5`/`mimo-v2.5-pro`，DeepSeek 是 `deepseek-v4-flash`/`deepseek-v4-pro`。分隔符半角 `,` 与全角 `，`、`、` 都接受，价格分隔 `/` 与全角 `／` 都接受。未配置单价的模型只显示 token 数、不显示金额——宁可不报，也不报一个可能过期的错数字。单条格式错误只会被跳过并告警，不影响启动。
该统计只覆盖文本模型（Qwen / MiMo / DeepSeek）；即梦图片与镜头视频按张、按秒计费，暂不纳入。

配置 `QWEN_API_KEY` 后，只要 Qwen 可用，参考片分析、脚本还原、创意简报、视觉规则、主题变体、完整剧情、动画生产包和人物参考修正默认都会调用 Qwen 对应阶段模型；未配置 Qwen 时自动回退为 MiMo。`qwen3.7-max` 是纯文本阶段的默认选择；会传入视频或图片的参考片分析、脚本还原、视觉规则和人物参考修正默认使用 `qwen3.7-plus`，也可以改成账号可用的 Qwen-VL / Qwen-Omni 模型。页面顶部“模型设置”按钮可以按阶段临时切换 provider 和模型名，覆盖值会随之后所有生成请求发送给后端，也会写入导出的生产包。角色图片仍由已配置的即梦图片服务生成；当前 `direct_shot` 不生成首尾帧图片，旧 v2 兼容路径才保留首尾帧能力。

## 当前 Animation Plan 临时主流程

页面请求显式发送 `animationPlanMode: "direct_shot"`，服务端返回 `promptSchemaVersion: "3.0"` 与 `productionStrategy.format: "direct_shot_video"`。每个 shot 保留 `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 和 `acceptanceCriteria`；`negativePrompts.image` 必须为 `[]`。`productionStrategy.videoPromptProfile` 由服务端签发，固定记录 `{schemaVersion, profileId, provider, model, guideVersion}`。提示词方言只有一种（`profileId` 恒为 `seedance_2_0`）：同一条中文自然语言提示词同时提交给 Seedance 2.0 与 MiniMax H3。`provider`/`model` 只如实记录首次生成时选择的运行时视频模型，不锁定之后实际发起视频请求时的 provider/model，也不参与方言比较，更不得由模型自行输出或改写。

页面允许显式选择 `9:16` 或 `16:9`。首次生成时，该值会锁入 `productionStrategy.targetAspectRatio`、Foundation Prompt 和后续视频请求；模型返回其他比例或与用户选择不一致会明确失败。已有 Plan 切换画幅时不调用模型、不重写 shot，只更新计划级输出画幅并签发新 revision/media namespace，使旧画幅镜头媒体失效。若要让模型连镜头构图一起重新设计，再单独点击重新生成 Animation Plan。

Animation Plan 顶部的时长使用全部 `shotPlan[].durationSeconds` 的合计；3.1 起 `productionStrategy.targetRuntimeSeconds` 由服务端注入为同一个合计值（= 各场 `timeRange` 跨度之和），两者定义上相等，偏差恒为 0。「单镜头」一栏也改为从实际 `shotPlan` 汇总区间——`recommendedShotDurationSeconds` 在 direct_shot 已经删除，时长是派生事实，不存在「建议」；旧的首尾帧 Plan 仍旧读它自己签发的该字段。

direct_shot 3.1 把 `fullStory.sceneScript[]` 的每一项直接当成最终可翻拍业务镜头：Animation Plan 不再拆镜，只填内容。镜头骨架由服务端在任何模型调用之前从 Full Story 确定性派生——`shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`（取自 `dramaticFunction`）和 `emotionalTarget`（取自 `emotionNode`）全部由服务端签发，模型只写 `videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 和 `acceptanceCriteria`。唯一的拆镜条件是单场跨度超过 15 秒：按 `ceil(跨度 / 15)` 均分，余数逐秒给靠前的镜头（20 秒 → 10+10，17 秒 → 9+8）；其余情况严格一对一，禁止拆分、合并、新增、遗漏、重排或改写时长。一条业务镜头内部可以按顺序包含多个动作阶段、景别变化、关键动作特写、硬切和结尾宽景，全部写进同一条 `videoPrompt`/`cameraMotion`，不得因此增加 `shotPlan[]`。`shotAndSound` 与 `shootingNotes` 不是镜头数量的事实源。镜头时长就是 `timeRange` 的派生结果，落在 Seedance 2.0 与 MiniMax H3 的能力交集 4–15 秒整数内；`timeRange` 不可解析、跨度非正、跨场次逆序或短于 4 秒时明确失败，不退回默认值也不钳制。

每条 `direct_shot.videoPrompt` 由 Animation Plan 模型直接写成一条自包含中文自然语言提示词，依次组织 Foundation 已锁定的风格与物理光线、地点环境、实际出镜主体及外观、`visibleAction` 顺序动作链、内部摄影/剪辑顺序、节奏与声音、稳定约束和停止条件。方言只有这一种，Seedance 2.0 与 MiniMax H3 消费同一条提示词。`cameraMotion` 同步记录同一业务 shot 内的完整摄影/剪辑顺序；若使用内部切换，验收标准同时检查动作链与关键切换。Animation Plan 阶段尚未绑定运行时素材，不得凭空生成 `@图片/@视频/@音频` 或 `<Subject/Picture/Video/Audio N>` 引用。

首次 H3 Plan 在 Foundation 与全部 shot 合并并通过完整契约校验后，还会单独调用文本模型执行逐镜、证据绑定的两层语义审计。第一层先检查结构化 shot facts 是否服从固定角色、Full Story 场次与 Foundation 锁；第二层只在第一层通过后检查 Base Prompt。审计上下文包含完整 `assetPrompts`，每条 blocker 必须引用服务端签发的同镜事实 ID、字段 ID 和逐字 evidence，只允许会改变实际成片的角色、身份、地点、道具、动作、终点、摄影、对白、声音、连续性、时长或语言关系；同义表达、未重复已经表达的动作、下一段时间戳自然界定上一段结束、以及 Foundation 已授权的资产外观细化不会单独导致失败。

如果审计只发现 `videoPrompt` 层问题，服务端最多调用模型一次，仅替换命中的完整 H3 `videoPrompt`；所有结构化字段与其他镜头逐字冻结。合并后从头校验 Plan，并只复审受影响镜头及其相邻镜头；复审失败不再循环。若 `characterAction`、`cameraMotion`、`continuityNotes` 等结构化事实本身与高层权威冲突，则明确失败，不能靠改 Prompt 掩盖。最终通过结果以 `metadata.videoPromptSemanticAudit` 返回；整个过程发生在 Artifact 提交前，不会产生中间 revision 或 media namespace。

H3 写法固定依据 MiniMax 官方仓库 [`h3-prompt-writing`](https://github.com/MiniMax-AI/MiniMax-H3/tree/80365054c7fbaace01ed417076fecd532c1ae0e0/skills/h3-prompt-writing) 的 commit `80365054c7fbaace01ed417076fecd532c1ae0e0`；升级规则必须显式更新 `guideVersion`、验证和测试，不能自动跟随仓库 HEAD。

已有 Plan 后再改变“镜头视频”模型时，页面先保留新的模型设置，再比较目标 Profile 与 Plan 中已签发的 `videoPromptProfile` 并询问是否重写提示词；旧 Plan 缺失 Profile 也视为需要确认，禁止从现有散文或模型名反推。用户拒绝时，Plan 内容、revision、media namespace 和已有媒体状态全部不变；新的运行时模型设置也不会被 Profile 强行回滚。用户确认时，只允许重写每条 `shotPlan[].videoPrompt` 并更新 `videoPromptProfile`，其他 Plan 级与逐镜字段逐字保留；服务端在完整契约校验后执行同一套证据绑定审计，并只在纯 Prompt 问题时允许上述唯一一次有界修复。只有最终改写、完整校验和审计都成功后才签发新的 Plan revision/media namespace 并递归 stale 旧媒体；任何失败都保留原 Plan 为 current。合法反例：包含 3 秒 shot 的旧 Plan 即使用户确认改写，单纯改写提示词也不能把权威 `durationSeconds` 拉到 4 秒，系统必须拒绝这次改写并要求完整重生 Plan；用户拒绝重写时原 Plan 可以保留，但用任何供应商生成该 3 秒镜头仍须明确失败，不能钳制时长或静默降级模型。3.1 起这类镜头在骨架派生阶段就已经被拦下。

提示词方言只有一种，因此切换运行时视频模型（Seedance 2.0 ↔ MiniMax H3，或 Seedance 各型号之间）不再产生方言不一致，也不再询问是否重写——同一条提示词两边都能直接跑。改写流程仅在 Plan 的方言与当前契约不一致时触发，即两种旧 Plan：完全缺 Profile，或带已下线的 `minimax_h3` Profile。这类 Plan 仍可加载查看，但生成视频前必须先重新生成 Plan。拒绝重写只表示“保留旧 Plan”，不会调用文本模型，也不会用错误方言继续生成。

当前 shot 禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段，也不得用别名补回端点。Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 代码保留兼容，但不参与当前 `direct_shot` 主流程。

视频请求仍必须显式选择 `generationMode`，不能根据端点字段缺失、provider、模型名或素材存在性推断。无端点的 `direct_shot` 不能使用 `first_last_frame`；选择 `all_reference` 时仍需提供合法图片或视频，不能只提供音频。

## 接入 DeepSeek-V4 纯文本模型

DeepSeek 只作为显式可选的纯文本 provider，不会因为配置了 API Key 就自动接管 Qwen/MiMo 的默认阶段路由。页面“模型设置”只会在创意简报、主题变体、Legacy Full Story、Animation Plan 和旧 v2 兼容路径的 Static Frame Compiler 中提供 DeepSeek；参考片分析、脚本还原、视觉规则和人物图修正仍必须使用支持图片或视频输入的 Qwen/MiMo。前端隐藏不兼容选项，服务端也会在调用 provider 前明确拒绝媒体阶段绕过请求。

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MAX_COMPLETION_TOKENS=16384
DEEPSEEK_REQUEST_TIMEOUT_MS=900000
DEEPSEEK_JSON_RETRY_ATTEMPTS=2
DEEPSEEK_THINKING=disabled
DEEPSEEK_TEMPERATURE=1
DEEPSEEK_TOP_P=1
DEEPSEEK_JSON_MODE=true
```

可选模型为 `deepseek-v4-flash` 和 `deepseek-v4-pro`，页面默认把 Flash 放在首位，Pro 保留为显式对照选择，不做静默回退。客户端使用官方 OpenAI 兼容 `/chat/completions` 与 JSON Output；空内容、非法 JSON、鉴权失败和媒体输入都会明确失败或按既有受控次数重试，不会返回默认值掩盖错误。接口依据：[DeepSeek V4 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。模型设置中的阶段标题会显示“视觉模型”或“文本模型”标签，图片和视频生成阶段保留独立标签。

以下 Static Frame Compiler 配置仅供旧 v2 首尾帧兼容路径。当前 `direct_shot` 中 Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除；旧实现与配置保留，供兼容路径把剧情叙事语言转换为可直接观察的单帧状态。旧 v2 的 Static Frame Compiler 复用已配置的 Qwen、MiMo 或 DeepSeek 客户端与凭据，但 provider/model 不继承动画规划阶段，也不会静默回退：

```dotenv
STATIC_FRAME_COMPILER_PROVIDER=Qwen
STATIC_FRAME_COMPILER_MODEL=qwen3.7-max
STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS=4096
STATIC_FRAME_COMPILER_TIMEOUT_MS=300000
```

`STATIC_FRAME_COMPILER_PROVIDER` 仅支持 `Qwen`、`MiMo` 或 `DeepSeek`，对应 provider 必须已经配置可用。配置缺失或模型不可用时，显式运行旧 v2 兼容路径会明确报告 Static Frame Compiler 不可用；当前 `direct_shot` 不以该配置作为运行前提。

Qwen、MiMo 和 DeepSeek 的单次生成请求默认都允许等待 15 分钟，分别由 `QWEN_REQUEST_TIMEOUT_MS=900000`、`MIMO_REQUEST_TIMEOUT_MS=900000` 和 `DEEPSEEK_REQUEST_TIMEOUT_MS=900000` 控制。`SERVER_REQUEST_TIMEOUT_MS=900000` 同步限制服务端接收请求体的时间；它不替代模型请求超时设置。

Qwen 视频解析遵循阿里云百炼 OpenAI 兼容 Chat Completions 的多模态格式：小视频优先以 `video_url` 发送 Base64 Data URL，大于 `QWEN_NATIVE_VIDEO_MAX_MB` 或 `QWEN_MEDIA_MODE=frames` 时改用关键帧图片列表 `video`。阿里云文档说明 `video_url` 支持公网 URL 或 Base64 Data URL，`fps` 可控制抽帧频率；同时 Base64 视频编码后需小于 10MB，所以默认把原始视频上限设为 7MB。Qwen-VL 只能理解视频视觉信息；如果需要理解视频里的音频，需要选择支持音频的 Qwen-Omni 模型。接口依据：[MiMo V2.5 模型说明](https://mimo.mi.com/docs/en-US/product/introduction/models#MiMo-V25)、[MiMo OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[MiMo 视频理解文档](https://mimo.mi.com/docs/en-US/use-cases/video-understanding)、[阿里云百炼 OpenAI Chat 兼容文档](https://www.alibabacloud.com/help/zh/model-studio/qwen-api-via-openai-chat-completions) 和 [阿里云图像与视频理解文档](https://help.aliyun.com/zh/model-studio/vision)。

## 接入即梦 5.0 Lite 角色参考图生成

动画生产包生成后，“角色参考提示词”标题右侧会出现 `+` 号。点击后可上传一张参考图片，选择角色和生成数量，系统会用即梦 5.0 Lite 流式生成站立全身角色参考图，并把生成图保存到 `public/generated-images/`。选择某张图“设为人物参考图”后，会写回当前角色参考提示词并同步镜头提示词。

至少配置：

```dotenv
JIMENG_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
JIMENG_API_KEY=你的火山方舟 Ark key
JIMENG_IMAGE_MODEL=doubao-seedream-5-0-260128
JIMENG_IMAGE_SIZE=1728x2304
JIMENG_IMAGE_OUTPUT_FORMAT=png
JIMENG_IMAGE_FIELD=image
JIMENG_WATERMARK=false
JIMENG_MAX_IMAGES=6
```

如果使用 BytePlus 国际站 key，则把 `JIMENG_BASE_URL` 改成 `https://ark.ap-southeast.bytepluses.com/api/v3`，把模型名改成国际站返回的 `seedream-5-0-lite-260128` 或账号实际可用的模型 ID。参考图字段保持 `JIMENG_IMAGE_FIELD=image`，多张参考图会作为数组放进同一个 `image` 字段。国内火山 key 和国际 BytePlus key 不能混用，否则会返回 401。

当前请求使用 `POST /images/generations`，发送 `stream=true`、`response_format=b64_json`、`sequential_image_generation=auto/disabled`。提示词固定为“参考我上传的这张图片，不要水果摊，生成一张 + 角色提示词”，并强制补充“人物必须是站立姿态的全身图”。接口依据：[BytePlus ModelArk Image generation API](https://docs.byteplus.com/en/docs/ModelArk/1541523)、[Streaming Response](https://docs.byteplus.com/en/docs/ModelArk/1824137)、[Model list](https://docs.byteplus.com/en/docs/ModelArk/1330310)。

动画生产包生成后，剧情页保留两个供应商交付出口：

- 导出当前生产包 JSON：当前测试/规划包版本为 `3.0`。服务端校验当前 Variant → Full Story → Animation Plan revision 后写入 `productionLineage`、内容摘要和本机持久 HMAC 签名；被修改的文件、旧版文件或血缘不一致的文件不能导入。
- 批量生成全部镜头视频：当前 `direct_shot` 的逐镜 `videoPrompt` 由服务端按 Animation Plan 顺序提交，固定使用 `all_reference`；角色参考图来自已签发的 Plan，已存在的 current 镜头视频会直接复用。

浏览器启动一次工作流时，服务端会在 `runtime/production-runs/` 建立 Run，并在每个阶段成功后持久化 Artifact、revision、依赖摘要、Stage 状态和 Checkpoint。同一 Task 使用相同 requestId 重复 finalize 时，相同 JSON（包括仅键顺序变化）复用原 revision；不同 requestId 不获得该豁免。同一 Variant ID 的实际内容变化会确定性标记旧 Story、Plan 和媒体为 stale。

Durable Task v1 另在每个 Run 的私有 `tasks/index.json` 保存执行 sidecar。AI 导演是一个 `directorPipeline` 父任务和五个顺序子任务；Full Story、Animation Plan、角色参考图和镜头媒体也由服务端 Runner 执行、校验并提交，浏览器只创建、轮询和重新 attach。刷新或 HTTP 断线不会中止同一 Node 进程内仍在运行的任务；重复创建相同 active operation 会返回同一 `taskId`，同一目标的不同 operation 会返回 `TASK_TARGET_BUSY`。任务没有总墙钟 deadline，watchdog 只检测“当前 provider/local operation 长时间没有进展”，并在每次 provider 返回或流事件后续期。

Node 重启仍是明确边界：Prompt、Data URL、Base64 和完整请求体不落 Task Store，所以未完成任务会变为 `interrupted`，不会自动重新调用 provider；远端任务可能已经提交并计费。Brief/Variants 可以直接从 current Artifact 链继续，需要媒体的 Analyze/Reconstruct/Visual Guardrails 则要求重新上传 SHA-256 与原 Run 一致的源文件。`abandoned` 只是释放本地提交权，不等于远端取消。T04 媒体 quarantine、T05 provider task-id 查询/接管和正式跨进程 batch queue 尚未实现。详见 [Production Lineage 与持久状态](docs/production-lineage-state.md)。

任务控制面：

- `POST /api/tasks/create`：创建或复用任务，返回 `202`；
- `GET /api/tasks?projectId=&runId=`：锁外读取该 Run 的任务 sidecar；
- `GET /api/tasks/:taskId?projectId=&runId=`：读取单个任务；
- `POST /api/tasks/:taskId/control`：对 `shotVideoBatch` 执行 `pause | resume | terminate`；
- `POST /api/tasks/:taskId/release`：强制释放目标并标记 `abandoned`，不承诺取消远端调用。

## 单镜头视频：首尾帧 / 全能参考

动画生产包的每个 shot 可以生成 1–4 个候选视频。页面“模型设置”中的“镜头视频”阶段可在 Kling、Seedance 和 MiniMax H3 之间切换；请求中的 `generationMode` 是模式权威字段，生成弹窗必须显式选择，不能根据缺失字段、provider、模型名或素材存在性自动推断或降级：

- `first_last_frame`：已选首帧和尾帧是精确端点，Kling、Seedance 与 MiniMax H3 均支持；无端点的 `direct_shot` 不可使用该模式，必须明确失败。
- `all_reference`：图片、视频和音频只是人物、场景、动作、运镜、节奏或声音参考，不被解释为精确首尾帧。Seedance 2.0 与 MiniMax H3 使用官方 R2V 角色 `reference_image`、`reference_video`、`reference_audio`；不得与 `first_frame` / `last_frame` 混用。


切换与运行时编译的权威边界是：用户是否确认重写只决定是否产生新的 Plan；当前签发的 Full Story、exact shot、`fixedCharacterBoundary` 和 Foundation 锁继续决定剧情、身份、动作、时长、场景与声音事实；冻结后的参考 manifest 决定素材编号和角色。弹窗 `promptOverride` 也只覆盖本次请求文本，不能取得其他 exact-shot 字段的权威。

全能参考模式新增“把上个镜头内容作为普通参考图”开关，默认不勾选。勾选后，系统按当前 Animation Plan 的 `shotPlan[]` 顺序找到紧邻上一业务镜头，从当前 Run/Plan namespace 中读取它已选中的 current 视频候选，再由服务端 FFmpeg 均匀截取 5 张 JPEG（首帧、末帧和中间三等分点），作为 `reference_image` 与本镜头角色图、旧 v2 已选首尾帧和用户上传媒体一起发送。张数固定为 5：9 图上限是和角色参考图共用的，抽帧占满会把锁角色长相的图挤出去，5 张也正好落在 MiniMax 的免费额度内。第一镜、上一镜未生成/已 stale、旧 Plan URL、非当前 namespace 文件都会明确失败；`S1` 是剧情场次而不是场地，`LOC01` 只是场景视觉参考组，即使两者相同也不承诺物理地点无缝连续。该开关只加强身份、画风和短时表演连续性，当前镜头的剧情动作、固定角色边界与目标场景仍优先；跨地点、跨时段或上一镜本身有漂移时应保持关闭。视频请求始终由服务端从当前 Plan 解析 exact shot；弹窗中的文本编辑只形成有回执的本次 `promptOverride`，不能伪造镜头动作、时长或场景。

全能参考必须至少包含合法图片或视频；共同限制为最多 9 张图片、3 段视频、3 段音频，单段视频或音频 2–15 秒，视频总时长与音频总时长分别不超过 15 秒，且不能只上传音频。上一镜实际抽帧也计入 9 图上限，超限不会静默丢图。服务端提交异步任务、轮询终态，并把 mp4 下载到 `public/generated-videos/<project>/<run>/<plan-revision>-<digest>/`。使用上一镜抽帧的后镜媒体还依赖上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选后，依赖它的后镜视频会递归 stale。文件名同时带 Plan revision/digest 前缀和随机请求 nonce；返回文件还会经过 ffprobe 可播放性验证。上一镜源视频与逐秒 JPEG 的 SHA-256 写入连续性回执。生成期间服务端会反复复验 Plan 与上一镜候选是否仍为 current（任何供应商调用前、每条候选提交前、每条候选落盘后、返回前各一次）：一旦发现你已经重新生成 Plan 或切换了上一镜候选，剩余候选不再提交供应商，本次已经下载的 mp4 会被删除，请求以 409 失败，不会留下孤儿文件，旧 Plan 的异步结果也不会挂到新 Plan。已经提交给供应商的那一条无法中途撤回，它的花费收不回来。

“批量生成全部镜头视频”创建一个持久化的 `shotVideoBatch` 父任务，并顺序运行每镜已有的 `shotVideo` Runner。任务进度、每镜状态、usage 和已提交 Artifact 都写入该 Run 的 `tasks/index.json` / Production State；刷新页面会重新 attach，单镜提交成功后 UI 立即恢复该视频。批量只支持 Seedance 2.0 与 MiniMax H3 的 `all_reference`，不会调用或回退到尚未优化的首尾帧模式；当前模型为 Kling 时会明确要求先切换供应商。暂停只阻止下一镜提交，当前供应商调用会继续至终态；终止会释放尚未提交的镜头与本地回写权，已经提交的远端请求仍可能完成并计费。Node 重启仍会把未完成批量任务标为 `interrupted`，不会自动重调供应商。

可灵 3.0 使用新版独立协议和 API Key：

```dotenv
KLING_V3_ENDPOINT=https://api-beijing.klingai.com/image-to-video/kling-3.0
KLING_V3_API_KEY=你的可灵新版 API Key
KLING_V3_AUDIO=native
KLING_VIDEO_RESOLUTION=720p
KLING_VIDEO_MULTI_SHOT=false
KLING_VIDEO_POLL_INTERVAL_MS=3000
KLING_VIDEO_POLL_TIMEOUT_MS=900000
```

应用把首帧和尾帧分别写入 `contents` 的 `first_frame` / `last_frame`，显式请求 `audio=native`，并通过 `GET /tasks?task_ids=...` 轮询 `submitted → processing → succeeded/failed`。3.0 的模型版本编码在 endpoint 中，请求不会发送 Legacy 的 `model_name`、`negative_prompt` 或 `aspect_ratio`。当前仓库只接入已验证的官方 image-to-video 协议；虽然 Kling VIDEO 3.0 Omni 产品支持多模态参考，但没有可验证的开发者 Omni endpoint/schema，因此页面会明确拒绝可灵的全能参考模式，不会静默退化为首尾帧。产品能力参考：[Kling VIDEO 3.0 Omni 用户指南](https://home.kling.ai/quickstart/klingai-video-3-omni-model-user-guide)。

Seedance 2.0 使用火山方舟内容生成任务：

```dotenv
SEEDANCE_VIDEO_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3
SEEDANCE_API_KEY=你的火山方舟 Ark API Key
SEEDANCE_VIDEO_MODEL=doubao-seedance-2-0-260128
SEEDANCE_VIDEO_RESOLUTION=720p
SEEDANCE_GENERATE_AUDIO=true
SEEDANCE_WATERMARK=false
SEEDANCE_VIDEO_POLL_INTERVAL_MS=3000
SEEDANCE_VIDEO_POLL_TIMEOUT_MS=900000
```

`SEEDANCE_API_KEY` 留空时会复用同一火山方舟账号的 `JIMENG_API_KEY`。可选模型包括 Standard `doubao-seedance-2-0-260128`、Fast `doubao-seedance-2-0-fast-260128` 和 Mini `doubao-seedance-2-0-mini-260615`。首尾帧模式使用 `first_frame` / `last_frame`；全能参考模式使用 `reference_image` / `reference_video` / `reference_audio`，二者不混用。默认 `generate_audio=true`；轮询把 `succeeded`、`failed`、`expired`、`cancelled` 全部视为终态，避免过期或取消后永久卡住。能力依据：[Seedance 2.0 官方发布](https://seed.bytedance.com/blog/seedance-2-0-official-launch)、[BytePlus ModelArk 视频生成 API](https://docs.byteplus.com/en/docs/modelark/1520757)。

MiniMax H3 使用官方 V2 多模态视频生成接口：

```dotenv
MINIMAX_VIDEO_ENDPOINT=https://api.minimaxi.com/v2/video_generation
MINIMAX_API_KEY=你的 MiniMax API Key
MINIMAX_VIDEO_MODEL=MiniMax-H3
MINIMAX_VIDEO_RESOLUTION=2K
MINIMAX_WATERMARK=false
MINIMAX_VIDEO_POLL_INTERVAL_MS=3000
MINIMAX_VIDEO_POLL_TIMEOUT_MS=900000
```

首尾帧模式把镜头提示词、首帧和尾帧分别写入 `content` 的 `text`、`first_frame`、`last_frame`；全能参考模式把 Plan 中已签发的中文提示词与已冻结的 `reference_image`、`reference_video`、`reference_audio` 一并发送，固定不混入端点角色。MiniMax V2 API 只接受 4–15 秒整数，Seedance 2.0 同为 4–15 秒整数；项目不再另设 4–6 秒子集，Plan 的时长直接来自 Full Story `timeRange` 的派生结果。不合法时明确拒绝，不能自动钳制、补长或缩短——Seedance 侧过去的静默 clamp 已改为明确失败。首尾帧保持 `ratio=adaptive`，全能参考模式按当前 Animation Plan 显式发送 `9:16` 或 `16:9`。服务端通过 `GET /v2/query/video_generation/{task_id}` 轮询 `queued/running → succeeded/failed/cancelled`，成功后下载 `task.content.url`。H3 不提供独立负面提示词字段；系统只会把高优先级角色身份冲突转换成正向身份锁定，其余负面条目在回执中明确标记为未下发。接口依据：[创建视频生成任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)、[查询任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-query)。

旧可灵 2.1 仍保持兼容：

```dotenv
VIDEO_HTTP_VIDEO_ENDPOINT=https://api-beijing.klingai.com
VIDEO_HTTP_VIDEO_MODEL=kling-v2-1
VIDEO_HTTP_PRESET=kling_image_to_video
VIDEO_HTTP_API_KEY=你的可灵 Legacy token
VIDEO_HTTP_POLL_INTERVAL_MS=3000
VIDEO_HTTP_POLL_TIMEOUT_MS=600000
```

旧 preset 会把首帧写入 `image`、尾帧写入 `image_tail`、动画镜头提示词写入 `prompt`，并将当前 shot 中已启用的 `negativePrompts.video` 编译到 `negative_prompt`。时长按 5 或 10 秒归一，使用首尾帧时默认 `mode=pro`。服务端回执为所有 provider 保留脱敏 `requestPreview`、实际 provider/model、是否请求音频和 `negativePromptDelivery`。

### 供应商错误提示

调用失败时，服务端会按各家官方错误码表把响应翻译成可执行的中文提示，而不是把原始 JSON 甩给用户。例如 MiniMax 的 `insufficient_balance_error (1008)` 会显示成「账户余额不足（MiniMax insufficient_balance_error）。前往 MiniMax 控制台充值后重试。」

覆盖 MiniMax（v2 的 `error.type`、消息尾部括号数字码与旧接口 `base_resp.status_code`）、火山方舟 Ark（Seedance 视频与即梦图片共用公共错误码）、可灵、阿里云百炼 DashScope（Qwen）、DeepSeek 与小米 MiMo 六家，码表出处与核对日期写在 `src/provider-error-codes.js` 文件头。

供应商原文逐字保留在响应的 `detail` 字段，解释放在新增的 `providerError` 里——排查时随时可取。匹配不到官方码时不做任何解释，直接回退原文展示。

该内置链路支持页面内单镜头试片和当前 Run 的顺序全能参考批量生成。它仍不提供跨进程 JSONL/lease 队列、远端任务接管、本地视觉质检或 ffmpeg 成片合成；Node 重启后的续跑和最终后期仍由后续 Production Workspace 负责。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：各导演阶段的提示词和结构化输出契约。
- `src/provider-error-codes.js`：各供应商官方错误码 → 可执行中文提示（纯展示层）。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/qwen-client.js`：Qwen OpenAI 兼容多模态适配器。
- `src/deepseek-client.js`：DeepSeek-V4 OpenAI 兼容纯文本适配器。
- `src/character-boundary.js`：全局角色边界的上游摘要、签发和验签。
- `src/production-lineage.js`、`src/production-state-store.js`：确定性内容摘要、revision 依赖图、stale 传播、Run/Stage/Artifact/Checkpoint 持久化和 v3 测试包签发/导入。
- `src/character-feature-compiler.js`：把已签发的固定角色外观事实编译为动画静态帧侧车，不重新推断主角。
- `src/workflow.js`：完整创意工作流编排，以及“动画基础锁定 → 逐场次分批 shotPlan → 服务端合并”的动画生产包生成与验证。
- `src/shot-video-generator.js`：按显式模式将首尾帧或多模态参考、`videoPrompt` 和逐镜视频负面词路由到所选视频 provider；启用上一镜参考时，在临时目录用 FFmpeg 按确定性时间戳均匀截取 5 张图并作为普通 `reference_image` 合并校验。
- `src/shot-video-continuity.js`：从当前 Plan/Run/media namespace 安全解析紧邻上一镜的 current 视频候选，并签发后镜媒体所需的 source lineage 回执。
- `src/shot-video-providers.js`：Kling / Seedance / MiniMax 模型白名单、模式能力、默认选择及互相隔离的运行配置。
- `workers/generic-http-worker.mjs`：Kling、Seedance 与 MiniMax 的首尾帧/R2V 请求体、异步轮询、产物下载和脱敏回执。
- `src/mock.js`：未配置模型时的演示结果。
- `docs/workflow-spec.md`：产品原则、字段要求和验收标准。
- `docs/production-lineage-state.md`：生产状态的事实来源、依赖、媒体命名空间、恢复与导入边界。
- `test/`：工作流和核心叙事约束测试。

### 服务端签名密钥

服务端有三把本地签名密钥，全部保存在状态根目录（默认 `runtime/production-runs/`，已在 `.gitignore` 内），首次启动自动以 `0600` 生成：

| 文件 | 用途 | 环境变量覆盖 |
| --- | --- | --- |
| `.package-signing-key` | v3 测试/规划包签名 | 无 |
| `.grounding-key` | 参考片分析与脚本还原的证据封印 | `WORKFLOW_GROUNDING_KEY` |
| `.character-boundary-key` | 全局角色边界签名 | `WORKFLOW_CHARACTER_BOUNDARY_KEY` |

```dotenv
# 可选：多实例部署共享密钥时使用，hex 编码、至少 32 字节；不配置就用状态目录下的文件
WORKFLOW_GROUNDING_KEY=
WORKFLOW_CHARACTER_BOUNDARY_KEY=
```

密钥跨重启保持不变，所以重启服务后可以继续用之前的 Run 生成剧情、动画包和视频。环境变量填错、密钥文件损坏或长度不足时服务会**直接启动失败**，不会悄悄换一把新钥匙——那会让全部已落盘 Artifact 的签名瞬间作废。

密钥持久化之前创建的历史 Run 无法挽救（签它们的随机密钥已经消失），必须重新运行工作流；已落盘 Artifact 不会被重新签发。

本地测试包回放可显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test` 与 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified`，跳过角色边界的 HMAC 比较，但仍严格校验 `sourceDigest` 和 `boundaryDigest`；生产及其他环境始终强制校验签名。密钥持久化后，「重启后继续回放测试包」已不再需要这个开关。

## 验证

```bash
npm test
```

## 用本地视频跑完整链路

安装 `ffmpeg` 后，可以不经过浏览器上传，直接用本地参考视频跑完整创意链路并导出 JSON：

```bash
npm run run:video -- ./reference.mp4 \
  --character "阿岚，社区修理师" \
  --vertical "家电维修" \
  --constraints "60 秒内，中文短剧节奏" \
  --count 3 \
  --require-mimo
```

`--require-mimo` 会强制确认 `MIMO_BASE_URL` 可达且指定模型已加载；不加该参数时，未配置 MiMo 会走演示模式。命令会优先按 `.env` 的 `MIMO_MEDIA_MODE` 携带原生视频，超过 `MIMO_NATIVE_VIDEO_MAX_MB` 或配置为 `frames` 时只发送关键帧。

产品约束和当前技术边界见 [工作流规范](docs/workflow-spec.md)。
