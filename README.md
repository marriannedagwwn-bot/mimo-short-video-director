# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 导演助手（2026-10-09）

页面右侧的对话栏（顶栏「导演助手」按钮，宽屏默认展开）。它按你现在的进度提议下一步，卡片上写明用哪个模型、至少调用几次、这个 Run 上次同类步骤实际用了多少；你点「确认执行」才执行，执行的就是页面上那个按钮背后的同一段代码。每步做完给一段只报计数的总结。参考视频和剧情两个入口都能用。

- 「下一步」「现在到哪了」两个按钮不调用模型。打字（比如「先出主角的参考图」「做第二镜」）每发一条调用一次文本模型（模型设置里的「导演助手」，思考关闭），它只能从当前能做的几步里挑一个给你卡片，或者只回答。
- 挑故事候选只做成按钮，由你自己点；出图和视频只打开原来的弹窗，花钱的那一下仍在弹窗里确认。镜头视频只支持 Seedance 2.0 与 MiniMax H3（默认 Seedance），生成模式只有「全能参考」。
- 对话只在页面内存里，刷新就清空。模型的回复可能说错，以卡片为准。4.0 批量出视频是第四期的内容。

详见 `docs/director-agent-chat-2026-10-09.md`。

## 一句话修改（2026-10-11）

在导演助手里直接说要怎么改，比如「第 3 场改成雨停了」「A04 别让她回头」「把结尾那句台词删掉」。它出一张「按你的话修改……」的卡片，写明改哪一份、采纳后会作废什么；点「确认执行」后另调用一次文本模型（模型设置里的「一句话修改」）按你的原话写修改稿，修改稿逐处列出「原来 → 改成」，显示在被改的东西旁边：剧情和分镜在分场页上，某一镜的提示词在它的视频弹窗里。你点「采纳」才生效，点「放弃」什么都不变。

- 已经有镜头视频时，点名某一镜默认只改这一镜的提示词，别的镜头的视频不受影响；改分镜会让已生成的视频全部作废，卡片上会写明。
- 加一场、加新角色、改时长、新加一句台词这类修改做不到，它会说明原因，不硬改。
- 「粘贴完整故事」的 Run 也能改情节和台词，你的原文不会变；改过的台词会出现在台词核对里。
- 改得对不对要你自己在修改稿里看；修改稿只在页面内存里，刷新就没了。

详见 `docs/one-sentence-edit-2026-10-11.md`。

## 参考片仿写（2026-10-24）

参考视频入口多一个按钮「参考片仿写：写四篇类似剧本」。上传参考视频、填好固定角色和赛道后点它，服务端在本机抽帧、去掉配乐（Bandit v2 Multi）、转写台词（whisper），再让 Claude Opus 5.5 写「原片拆解＋四篇类似的剧本」。一次约 12 分钟、约 1 美元。

- 结果面板列出原片概要、台词表、原片好看在哪，和四张稿件卡；「下载四稿」导出 Markdown。
- 某一稿点「用这一稿开拍」，页面切到「从剧情开始 · 粘贴完整故事」并把这一稿填进输入框，你看过、改好再点「开始拆镜头」，后面照常拆镜头、分镜、出图、出视频。切过去会清掉参考视频 Run，四稿只在这个页面里留到刷新，要留着请先下载。
- 模型设置里的「参考片仿写」只能选 Claude 或 MiMo，默认 Claude Opus 5.5（effort xhigh）。

要在本机配好两样工具，缺了按钮不能点，并会写明缺什么：

```bash
REFERENCE_REWRITE_BANDIT_DIR=/Volumes/MacOS/AI/Bandit-v2-Multi
REFERENCE_REWRITE_WHISPER_BIN=~/.local/bin/whisper
# 可选，写出来的是默认值；模型文件不在时直接报错，不会自动下载
# REFERENCE_REWRITE_WHISPER_MODEL=small
# REFERENCE_REWRITE_WHISPER_MODEL_DIR=~/.cache/whisper
```

ffmpeg 要在命令行里能找到。详见 `docs/reference-rewrite-2026-10-24.md`。

## 角色画风（2026-10-09）

「设定创作宇宙」里原来的「角色表情规则」换成了「角色画风」，默认「二维日系动画」，可以从下拉预设里选，也可以自己写，清空就是不指定。它写进下一次生成的 4.0 分镜，之后每条单镜提示词和角色参考图都按这个画风来；已生成的分镜保持生成时的画风。起因是 4.0 分镜此前没有画风，角色参考图容易出写实照片，被 Seedance 当成真人拒收。

## 从剧情开始（2026-10-09）

首页可以切到「从剧情开始」，不用参考视频：

- **粘贴完整故事**（最多 5000 字）：情节、人物、结局和台词严格按原文，系统只补分场时间、画面动作和声音；原文没写台词的地方不新增台词。点「开始拆镜头」后跑两步：角色与表达边界 → 按原文拆出可翻拍镜头，**不再先整理成故事候选**。拆好就进分场页给你看，左边是你的原文；确认后点「生成分镜」（4.0 逐镜头分镜），再做角色参考图和逐镜视频。分场页会显示台词核对：分场和分镜里哪些台词在原文里找不到（只提示，不拦截）。
- **只给角色设定，让它写一个**：点「开始剧情准备」，跑两步：角色与表达边界 → 系统原创一个故事候选，先给你看；之后进入完整剧情、4.0 分镜、角色参考图和逐镜视频。

这类 Run 暂不支持：展开前体检、候选对照评审、按问题修改；粘贴原文的 Run 也不提供「检查剧情硬伤」。有了可翻拍镜头（或完整剧情）之后可以导出测试包（2026-10-10 起，版本 `3.1`）：文件里有你的故事原文，导入时要靠它重建剧情 Run；在本机导入后页面自动切到「从剧情开始」、进分场页、原文填回，接着生成分镜、出图、出视频，图片和视频要重新生成。故事主角就是「固定角色」，角色的名字和长相请写在固定角色里；原文里找不到这个名字时，开始前会先问你。设计与契约见 [docs/story-entry-phase1-2026-10-09.md](docs/story-entry-phase1-2026-10-09.md)。

## 新版自主分镜（2026-09-21）

浏览器现请求 Animation Plan `4.0`：直接读取现有 Full Story，由 AI 组织完整镜头、表演、对白与声音；旧剧情无需重新展开，缺少的配角事实只为本次分镜整理。每个生成片段为 4–15 秒，允许合并相邻场次。分镜中不提前写视频提示词，点击单镜生成按钮后才单独编写，查看和编辑后再确认生成视频。单镜提示词按「开场 → 逐个 beat 写镜头、分镜写明的站位与朝向、动作、台词与声音 → 结束状态」组织，换机位处写「在第N秒的地方，切镜头」、同一机位延续写「第N秒起，镜头不切换」，分镜没写的位置和行进方向不补；出镜角色名必须原样写出、不写 @图片 这类素材编号（2026-10-12）。分镜要写清人物从画面哪一侧进出、相邻片段的运动方向接得上，单镜提示词的站位写每一拍开始时的样子（2026-10-13）。提示词缓存绑定当前 Plan 和模型配置；4.0 没有批量视频与手动终审。2026-10-11 起旧 2.0/3.0 分镜不再支持，详见下文「Animation Plan 4.0 自主分镜」。

新的 Full Story 浏览器请求采用 `full_story/1.2` 保存完整角色事实表，未知配角外观由分镜设计。未显式请求新版本的 API 保持原行为。实现、兼容边界和真实回放结果见 [接入记录](docs/animation-storyboard-implementation-2026-09-21.md)。当前真实回放曾出现末段 20 秒而被拒绝签发，不能将协议测试通过当作生成质量已达标。

## 启动

要求 Node.js 24，`package.json` 明确限制为 `>=24 <25`。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，演示流程仍可运行，但结果不是对视频的真实判断。

macOS 上，服务、`run:video` 和独立视频 worker 自动读取当前系统代理，每 2 秒检查一次变化。HTTP、HTTPS 代理的地址和端口来自系统设置，无需在启动命令中固定；系统关闭代理时恢复直连，TUN/VPN 则继续由操作系统路由。启动时会清除本项目进程继承的代理环境变量，避免旧端口覆盖当前系统设置。其他操作系统继续使用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境配置。

切换只影响后续请求，不重启服务、不重试模型提交，也不主动中断已建立的流。系统绕过列表和本机回环地址保持直连。仅 SOCKS 的路由、PAC/自动发现暂不支持；需要这些路由或无法读取系统代理时，会明确报告原因并阻止相应外部请求，不会猜测代理地址或自动退回直连。详见 [系统代理说明与验收](docs/system-proxy-follow-2026-09-10.md)。

## 全局角色边界

`Visual Guardrails` 是固定角色语义唯一生成阶段。视觉模型会结合用户角色描述、参考分析和脚本还原（2026-09-23 起不再读创意简报；原片道具这类表面表达由服务端从脚本还原里逐字摘出给它），一次性输出 `requiredTraits`、`allowedTraits` 与 `forbiddenTraits`；可以使用模型常识理解“狼娘”等开放概念，但不依赖本地写死的物种关键词字典，且用户明确肯定或否定的设定优先。边界只围绕「固定角色」一栏里的一个角色：`characterName` 必须逐字等于服务端从这一栏取出的名字，提示词会直接给出这个名字；创作限制里的固定搭档、宠物、家人等其它角色不进这份边界，它们的外观由后续阶段按创作限制原文处理。「固定角色」一栏目前只能登记一个角色。

创意简报现在只写原片解读两项（驱动结构 `storyEngine` 与换角测试 `recastTest`），定位、受众与情绪曲线由候选阶段直接读原片分析，详见 [简报瘦身记录](docs/creative-brief-slim-2026-09-23.md)。旧简报和视觉规则列举同类具体物品时，会要求模型逐项写出完整名称，例如“绿色邮箱、红色邮箱、蓝色邮箱”，不允许用“绿色、红色、蓝色邮箱组合”共享末项名词。旧的歧义缩写不会由本地规则猜测补全，需要重新生成对应的 Brief 与 Visual Guardrails。Visual Guardrails 侧已有确定性校验兜住这条：`sourceSimilarityRules[].sourceExpression` 的每一项都必须逐字出自本规则引用的证据，模型自行补全中心名词会直接失败。

Creative Brief 中的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression` 和 Visual Guardrails 中的 `sourceSimilarityRules` 只记录原片表面表达的来源，不再作为下游正文禁词。原片道具、拟声词或角色组合可以随所选剧情进入 Variant、Legacy Full Story 与 Animation Plan 的正向业务字段，包括 `visibleAction`、对白、声音和 `videoPrompt`；系统不会仅因为某个表达出现在来源上下文中就把它机械写入正向内容。`sourceSimilarityRules` 只在生成请求实际携带原片参考时，为 `reference_leak` 提供证据；`dialogueRules` 也只能来自用户明确约束，不会由原片对白或拟声词自动生成。固定主角仍须服从已签发的 `fixedCharacterBoundary`，上述放行不授权修改其身份或外观。

Creative Brief 的 `allowedNarrativeComponents` 使用服务端固定的七项通用叙事分类。实时模型不会自行决定分类名，只为每一项填写非空的安全复用说明；即使本次不采用某类构件，也必须保留该项并说明限制，避免同义改名或漏项导致契约失败。每条说明还必须以 `【原片有】` 或 `【原片没有】` 开头先判定原片是否真的存在该构件，避免模型替原片补出它并不存在的叙事构件（例如原片只是陪伴，却被写成送货任务）。判定为「原片有」时还必须引用上游依据，服务端会按字符覆盖率回查核对；允许转述措辞，但编造的情节会被拒绝。

服务端会将该边界与当前上游数据摘要绑定并签名。主题变体、Legacy Full Story、Animation Plan、人物参考精修、角色图和视频生成只消费同一份已签发边界，不会在每个阶段重新识别关键词或重新推断角色特征。修改固定角色、赛道、限制、字幕或参考视频会使旧边界失效，页面要求重新运行工作流。

## Story Candidates Phase 1

`themeVariants` 保留原有 wire shape 和 Artifact 名称，但 `variants[]` 已按递归 `additionalProperties: false` 的严格 Story Candidate Schema 校验。原有候选字段全部保留，只新增五个候选级非空字符串：`keyChoice`、`climax`、`emotionalPayoff`、`novelty`、`visualPotential`。本地代码只检查契约、唯一 id、Beat 顺序、固定主角，以及**任意两个**候选在 `dramaticFunction` 序列 + `keyChoice` + `climax` + `emotionalPayoff` 投影上都不同；不用题材关键词或本地语义评分判断故事质量。

其中 `characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 是**可选键**：写了必须非空，不需要就整个省略。它们此前是必填位，等于强制每个候选都长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」。`storyOutline` 同时从「恰好 6 拍 + 固定相位词表」放开为 5–7 拍、相位由候选自行命名，`keyChoice`/`climax`/`emotionalPayoff` 仍逐字绑定到某一拍，但不再钉死在固定拍号，只保留「关键选择拍 < 高潮拍 < 最后一拍且中间隔一拍」的因果序约束。Full Story 侧对应放开 `characterBible.careRecipient`，并禁止把候选阶段省略的叙事构件补回来。

放开拍号的同时把这三个字段改为**服务端派生**：模型只输出 `keyChoiceBeat`/`climaxBeat` 两个整数拍号，服务端从 `storyOutline` 取出 `keyChoice`/`climax`/`emotionalPayoff`（后者恒取最后一拍），模型回显一律覆盖。此前要求模型逐字重复长句，实测合规率两极分布并多次硬失败——这三个值可从 `storyOutline` 唯一推导，不应由模型回显。

用户点选 Candidate 后，完整内容以 `variant:<id>` Artifact 签发。Full Story 请求同时绑定它的 `artifactId/revision/contentDigest`；服务端在模型调用前后各复验一次 current Candidate，用落盘内容替换请求副本，且不把 binding sidecar 传入 Prompt 或 Legacy Full Story。因此同一 id 下修改标题、任务、关键选择或高潮都会换 digest/revision，旧请求与旧下游不能继续被视为 current。

恢复时只认 current Full Story/Animation Plan 的 `selectedVariantId` 或 current `variant:<id>` 明确选择记录；只有 Theme Variants 时 `selectedVariantId` 保持 `null`，不再默认选中 V1。离线质量基线用法见 [docs/story-quality-evaluation.md](docs/story-quality-evaluation.md)；该入口不调用外部模型，九项主观维度默认都是未评分。

本轮没有 Story Selection/Blueprint/Script Doctor/Rewrite/Production Package 4.0。Phase 2 唯一预留接缝是已签发 Candidate 的完整内容与精确 lineage reference；未来 Blueprint 必须消费这对受信输入，不能只凭 id 识别候选。

Phase 1.1 的真实包回放进一步明确：当前结构签名保证的是字段文本投影不同，不是整批候选的语义因果链一定不同。Creative Brief Prompt 现在只允许强保真字段记录抽象剧作价值；Theme Variants Prompt 只展开定位、受众、核心情绪、情绪结构与 `dramaticValue` 投影，不再把历史 Brief 中可能具体化的 `storyEngine`、`mustRetain`、`samePlotDriver`、`sameBeatValue` 或 `creativeDistancePolicy` 值当作正向候选命令。旧 Brief Artifact 本身不会被改写。Prompt 中的因果、Beat 必要性和连贯性要求仍不是确定性验证；真实 5×4 回放中的 Schema 与精确字段投影可以全部通过，人工仍可能发现物品状态或动作顺序矛盾。Brief 抽象层风险和三条已知下游失败样本已登记到 [`T09 Phase 2 Story Blueprint 与候选语义质量闭环`](docs/GitHub-Benchmark-%E5%90%8E%E7%BB%AD%E6%94%B9%E9%80%A0%E5%BE%85%E5%8A%9E.md#t09phase-2-story-blueprint-%E4%B8%8E%E5%80%99%E9%80%89%E8%AF%AD%E4%B9%89%E8%B4%A8%E9%87%8F%E9%97%AD%E7%8E%AF)；本轮未修改 Story Candidate Schema、Full Story 或 Animation Plan 行为。

## 候选阶段的原片事实溯源与对照评审

原片场次动作与对白现在以只读投影进入候选提示词，供机制对照和来源引用；Brief 中的具体情节解释不再与定位、受众、情绪曲线一起成为新片正向要求，角色规则投影也不再夹带 `stageInstructions` 的帮助、获奖、转赠模板。JSON 契约、拍号派生、已有 Artifact 与下游流程不变，这些调整不构成故事质量的确定性保证。

`transformationProof` 的五个 `changed*` 保持 `{source, replacement}`。有完整原片上游时，先用当前候选模型独立选择原片证据 ID，再生成候选：选源输入只有冻结的 `referenceAnalysis` 与 `sourceScriptReconstruction`，不含新角色、简报或新剧情。服务端复制所选完整原文为所有候选共享的 `source`，候选模型只写 `replacement`；道具直接取全部场次 `keyProps` 并精确去重，场次对白引用同步保留画面上下文。一个 variants Task 顺序调用两次模型、只提交一次 Artifact，两次用量合计，不自动重试。来源选择另记 `variantSourceBaseline` 日志。未提供两份上游的旧调用点保持既有单次生成和来源校验行为。

旧来源校验保留 `原片没有` 前缀兼容。新生成路径不再让候选模型书写缺席声明，也不让它根据新角色反推原片事实。引用选择仍可能遗漏相关证据，上游转写中的含混或缺失也不会被自动修好，需结合原视频与字幕复核。

起因是一次实测：一轮四个候选全部把原片写成「企鹅快递员 / 快递送达」，而两份上游文件里「快递」出现 0 次——「穿着企鹅连体衣」是真的，快递员是补出来的职业，而且同一份简报明写着原片没有送达任务。污染源是简报提示词里那句写死的举例（模型只换两个词就照抄了），防这件事的规则当时只写在 Full Story 提示词里、候选阶段收不到，两个字段又都没有校验器。现在举例不再含参考片具体名词，规则补进候选阶段，并加上这道确定性闸门。`highValueBeatMapping[]` 同时新增必填 `failureSignal`（这条保留机制没迁移成功时会长成什么样）。

`POST /api/story-candidate-review` 是候选生成后的独立对照评审，与剧情体检同规格：**只出报告**，不改候选、不签发 Artifact、不进 lineage、不改变候选数量、不阻断后续，刷新页面即失。送审投影按允许清单构造，剥掉候选的全部自我评价字段（`novelty`、`retainedValue`、`experienceFidelity`、`transformationProof`、`originalityRiskCheck` 与每拍 `dramaticFunction`），只留动作链——让故事自己证明自己，而不是让解释替它过关；`failureSignal` 反而保留，它是证伪条件不是成功声明。报告不打总分，`verdict: drop` 只是结论，淘汰与否由用户决定。覆盖率由服务端确定性核验（候选数量与 id 逐位对齐、标题回显包含原文、拍号真实存在、推荐顺序是候选 id 的排列）；「判得对不对」是语义判断，没有确定性兜底。

2026-09-12 起它同时是**选题终审编辑**：逐个候选按十一个维度打分（开场钩子、因果逻辑、主角施动性、角色专属性、故事专属性、原创性、推进、情绪兑现、视觉记忆点、制作可行性、对白与自然度），**总分与五档等级由服务端按唯一权重表确定性派生，模型不自报**；因果断裂、骨架换皮与 BLOCKER 级硬伤是三条硬闸门，**只降低放行决定，不改质量分与等级**——一个 9.2 分的候选可以「最高档但现在不放行」。另有顶层批次模板收敛检查（题材各不相同但深层机制一致同样要报），以及与质量分**分离**的简报合规：一个不听简报却更好看的候选，该改的是简报。**十一维加权总分与阈值是本阶段明确要试的路线，而它与剧情体检（以及已删除的分镜终审）实测到的「总分没有分辨力」冲突**，依据与待量的数据写在 `AGENTS.md`。六次真实回放的结论是：**加权分能可靠分出最好与最差（最佳候选三次全排第一、sd 0.09），分不出中间次序**，所以报告同时给两份顺序——服务端按分数派生的 `scoreOrder`（首选与次选从它来）与模型自己的 `holisticPreferenceOrder`，**两者不一致时页面直接点出来，不强制对齐**。简报合规这一档已正式降级为**编辑参考信息**：继续输出，但不参与分数、等级与放行决定（实测同一候选三次回放判定会互相翻转）。物理机制另分两个正交的轴——现实里成不成立（`confidence`）与故事需不需要它真成立（`literalDependency`），**想象类机制不因现实做不到而扣分**。

报告仍然查三件事：原片机制有没有迁移过来（机制清单全批共享、候选按 id 引用）、候选自己的动作链合不合得上（`coherenceChecks`），以及**这个候选和原片的故事链重合多少**（`sourceScaffoldOverlap`）。第三项逐个候选与原片比，判据是事件链——原片的关键事件、候选里对应的事件、两者的因果接法与先后顺序是否相同；任务性质、中段、奖励来源与处置、结尾形状只是辅助观察，每项都允许 `not_applicable`（生活片常常既没有任务也没有奖励）。任务同类、都在傍晚收尾、都有双人协作，本身都不足以判换皮。确定性闸门两条：报出因果断裂不得判 `pass`，骨架重合分到线（`SOURCE_SCAFFOLD_COPY_SCORE`）同样不得判 `pass`。机制兑现的证据拆成前因与动作两格，前因只对清单标了 `requiresCause` 的机制强制——不需要前因的机制也要两条证据，只会逼模型编一段。

`POST /api/story-quality-review`（剧情体检，`story-quality-review/2.0`）在完整剧情生成之后核对两件事：候选承诺有没有被演出来，以及剧情自身有没有编辑级硬伤。两次顺序调用，**第一次编辑诊断刻意看不到候选**；只出报告，不签发、不进 lineage、不阻断后续。编辑诊断的十类问题里有一类专查**台词接不上**（`dialogue_logic`：付出的一方自己道谢、观众要猜他在谢什么），候选对照评审与展开前体检的对白维度也补了同一问，数据与已知缺口见 [docs/story-review-dialogue-response-ab-2026-09-18.md](docs/story-review-dialogue-response-ab-2026-09-18.md)。报告里每条没守住的承诺与每条编辑诊断都可以勾选，交给 `POST /api/story-quality-repair`（按问题修改，`story-quality-repair/1.0`）另起一次**看得见候选**的调用写局部修改：模型只写「哪一场哪个字段、原文、换成什么」，服务端逐字替换（原文必须恰好出现一次）、逐条重跑与生成剧情同一条签发校验链，执行不了的只拒那一条，也不许把出镜角色删得只剩角色表里一个名字。它同样**只出修订稿**，用户看过逐字对照、点「采纳」才签发新的 fullStory 版本（该变体的镜头计划与媒体随之失效）。两轮真实测试与已知缺口见 [docs/story-quality-repair-ab-2026-09-18.md](docs/story-quality-repair-ab-2026-09-18.md)。

## 模型输出有界纠错

当前主流程不再把一份已经解析、但校验失败的完整 Artifact 直接交给模型整包重写。服务端只接受稳定的结构化 diagnostics（`code + RFC 6901 JSON Pointer + reason`）；当候选完整、路径可信、目标已存在且权威事实唯一时，才签发一次局部计划。当前只有一套协议：Legacy Full Story 专用的 `full_story_partial_repair/1.0`（Animation Foundation 与语义 Prompt 的局部纠错已于 2026-10-11 随旧 3.0 分镜删除）。第二次请求只包含错误目标的当前值、修复说明和最小权威投影，模型只能按服务端 `repairId` 返回 replacement，不能自报 path、JSON Patch 或额外操作。

服务端在 clone 上核对私有签发的计划、`baseDigest`、可变路径、目标内既有事实、目标外摘要和当前权威，再原子合并并从头执行该阶段完整校验。局部响应仍错误、路径不可信、候选不完整、权威冲突或错误没有专用 adapter 时都会明确失败，不会退回整包重生。当前生产覆盖仅包括 Full Story 中可由签发 `fixedCharacterBoundary.characterName` 唯一恢复的 protagonist `name`。Full Story 的未知正文错位、配角身份字段缺失或错误、`characters` 与 `visibleAction`/`dialogue` 冲突，以及没有签发值来源的必填剧情字段都直接失败。repair 成功后仍必须通过 Full Story 的完整校验。4.0 自主分镜不做局部纠错：每步被校验拦下时带诊断整体重做一次，第二次仍失败即明确报错。

唯一的已解析候选再取证例外是 `referenceAnalysis`：原生视频模式候选仅因 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧时，服务端丢弃该候选，不把失败 Artifact 或 diagnostics 发回模型，只用 `video=null` 和既有 frames 重新取证一次。这是媒体证据重新获取，不是局部 repair；第二次仍失败就终止。

## 局部纠错 Debug

服务端和 `run:video` 命令会在 `debug/partial-repairs/` 中，为每次**已经成功签发 repair plan** 的 Full Story 局部纠错创建独立目录。目录依次记录触发错误与结构化 diagnostics、实际发送的局部修复 Prompt、模型返回的 replacement 投影，以及最终接受/拒绝结果；如果错误不能安全定位、没有签发 repair plan，则不会伪造一条 debug 记录。

Debug 只保存命中目标的当前值和最小权威投影，不保存整份 Story/Animation Plan、HTTP Header、API Key、Cookie、Data URL 或 Base64 媒体。它是写失败不影响业务结论的本地观测 sidecar，不是 Artifact、Production Lineage、恢复数据或导出包内容。默认目录可通过 `PARTIAL_REPAIR_DEBUG_DIR` 覆盖；文件格式与排查方法见 [`debug/README.md`](debug/README.md)。

## Full Story 与 Animation Plan 全量模型输出日志

当需要排查“模型究竟把某段正文写进了哪里”时，可由服务端环境显式设置 `FULL_STORY_MODEL_OUTPUT_LOG_DIR`。开启后，每次实时 Full Story primary、实际发生的 retry/repair 与 Beat–Scene postpass completion 都会按阶段分别保存模型返回的完整 `content`，不采用 AttemptStore 的 256 KiB 截断；metadata 明确保存 `stage`，并同时记录字节数、SHA-256、provider/model、供应商 requestId，以及经服务端核对的 project/run/variant/production requestId。浏览器通过 HTTP Header 旁路传递 Production token，日志上下文不会进入 Full Story Prompt、业务 JSON 或 Artifact。

Animation Plan 使用独立的 `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR`。它在真实 `/chat/completions` 响应交给 JSON parser 前，只提取并保存 `choices[0].message.content`，因此能够保留 4.0 分镜各步与单镜提示词的原始文本、空白和段名格式；每条记录带安全的调用顺序与阶段标签。它不会因为开启输出日志而顺带开启现有 Animation Prompt 抓取，也不会把 Production trace 混入 Animation Plan 请求体、Prompt 或业务 JSON。

两类日志都不保存输入 Prompt、HTTP 请求/响应包、Header、API Key、Cookie、Data URL 或 Base64 媒体。目录必须位于非 `public/` 的本机私有路径，文件内容可能包含完整未通过校验的剧情或镜头提示词，应按敏感调试数据管理。未配置对应环境变量时完全禁用；读取、解析或写入日志失败只产生脱敏告警，不改变校验、重试次数、Artifact 提交或错误结论。日志不是 Production Lineage、事实来源、恢复数据或导出包内容，只能从启用后的下一次请求开始记录，不能追溯此前已丢失的响应。当前本机建议配置为：

为兼容 Windows 路径长度限制，已绑定 Production 的目录名只保留可读 Artifact 名称，并把 project/run、production request 和 operation 标识写成短 SHA-256 摘要；完整标识仍逐字保存在同目录的 `metadata.json`，摘要只负责文件系统隔离，不参与业务 lineage。每次调用的 `attempt-*` 目录由 `src/unique-directory.js` 创建而不是 `fs.mkdtemp`：在未开启长路径支持的 Windows 上，`mkdtemp` 在路径约 248 字符时就会失败，而浏览器 Run 内的日志目录本身已有 250 字符左右，旧实现会因此静默丢掉整条日志。

```dotenv
FULL_STORY_MODEL_OUTPUT_LOG_DIR=debug/full-story-model-outputs
ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR=debug/animation-plan-model-outputs
```

## Full Story 单一正文格式（2026-09-14）

当前生成默认要求 `schemaVersion: "full_story/1.1"`。只读输入投影保留已选 Candidate 的故事事实、已验签固定角色的全部 required/allowed/forbidden traits（含 scope）和对白规则；不再把原片具体场次、Brief 的改编要求、候选来源证明、自评与候选台词草案 `keyDialogueDirections` 注入展开。对白按动作、人物已知信息和用户明确语言限制生成，候选原文不变。 对白规则投影只保留证据全部来自用户固定角色或创作限制的规则，隔离原片风格、混合或未知来源；合法用户原话保持原样。两候选配对实测仍出现点题和未获知先评价的问题，来源隔离本身不代表质量已达标，详见 [对白规则来源 A/B](docs/full-story-dialogue-rules-ab-2026-09-14.md)。服务端仍冻结、验签并复核完整上游 Artifact；投影不创建新 Artifact，也不改写 Candidate 或边界摘要。

《蚂蚁搬家式运书》的后续实验中，两版 FullStory Prompt 调整未通过内容验收并已撤回；该样本最终通过现有候选修订机制明确分量、拿放和往返后真实展开，再人工校订两处表述。当前样本修复不能等同于全自动生成质量已合格，完整证据见 [蚂蚁搬家式运书修复与 A/B](docs/full-story-ant-books-ab-2026-09-14.md)。

新版由 `sceneScript` 独占完整剧情动作，删除第二份 `beatSheet`、`retentionPlan`、改编证明、体验保真、自检和拍摄计划。场数跟随已选动作链，至少一场；保留出镜角色、可见事实与对白的严格 Scene Contract。`shootingNotes` 仍是必填字符串，但没有叙事补充时允许为空；`shotAndSound` 与 `shootingNotes` 的生成职责限于声音和剧情补充，摄影由 Animation Plan 决定。新版提交前复用既有时间线派生函数确认下游可消费，时长目标仍只是 Prompt 目标，实际时长按 `timeRange` 派生。

无版本的旧数据继续走原严格 Schema、六场/六拍规则和 Beat–Scene postpass，不自动补版本、删字段或重算已签发摘要。新版没有第二份节拍表，因此正常生成只有一次 provider call；跳过 postpass 不代表通过叙事质量审查。原有解析重试、唯一姓名局部纠错、候选绑定、任务暂停/继续/终止与迟到回写保护保留。页面按明确版本展示，新版不显示已删除的模板或“连续性检查通过”。

固定输入 A/B、失败记录、兼容验证与剩余质量问题见 [Full Story 改造与验收记录](docs/full-story-narrative-ab-2026-09-14.md)。此版本是一次已实施的迭代，不代表不同题材或成片质量已全面合格。

## 展开前体检（2026-09-17）

点「生成完整剧情」时先跑一次体检，**在签发 `variant:<id>` 之前**：原样调用现有候选对照评审（只送选中的这一个候选，评审的提示词与校验逐字未改），再加一档「承诺核对」——标题与一句话钩子许诺的东西，动作链有没有演出来。两份结果确定性合成路由：评审派生的降级理由 ∪ 没兑现的承诺，非空就先出一份修订稿，空就直接展开。

承诺核对是**两次顺序调用**：第一次**看不到动作链**，只凭标题、钩子、叙事路径与主角写出「这条承诺不落空的最低要求」；第二次拿这份冻结的清单去动作链里逐条找，判「演了」必须逐字引用该拍原文。结论由服务端按找到几条派生，模型不写。判需修订时只**并排展示**修订稿，什么都不签发；点「采纳修订并展开」才签发新的 themeVariants 版本，也可以「按原候选展开」。体检失败会如实显示原因并给出「重试体检」与「按原候选展开」，不静默跳过。

它只出报告与候选，不进 lineage、不 stale、刷新即失。**判得对不对没有确定性兜底**，而且现有评审自身会整次失败——它的可靠性就是体检可用率的上限。三轮真实 A/B、两个被证伪的做法与剩余缺口见 [展开前体检 A/B 报告](docs/full-story-precheck-ab-2026-09-16.md)。

## Full Story 局部纠错

Full Story 两种格式当前只对一种可证明的内容错误启用唯一一次局部纠错：首次输出已是完整 JSON，结构化诊断精确指向 `/characterBible/protagonist/name` 的缺失、类型或空字符串错误，并且当前验签 `fixedCharacterBoundary.characterName` 提供唯一正确值。第二次请求只发送 protagonist 子树、诊断、签发姓名与最小角色/Variant 约束；不会再发送整份失败 Story 或原始完整生成提示。服务端以当前进程内的私有签发身份冻结原候选摘要、权威摘要、目标和修复编号；模型返回的 plan 副本或自造 path 无效。合并时重新投影当前权威，要求 `name` 逐字等于签发值，并证明目标外以及目标内其他字段保持不变。

合并结果仍须重新通过 exact JSON Schema、Scene Contract、固定角色、Variant 与既有语义边界。未知正文即使看似行为、外观或情绪，也没有服务端可验证的字段级目的地，因此当前一律不自动搬运。配角姓名/身份字段错误、`characters` 与可见动作/对白的冲突、没有签发值来源的必填剧情字段、截断、非法 JSON、无可信路径、整项内容丢失或其他不能安全局部化的错误不会被猜测修复，也不会静默发送整份 Story 重写；局部响应仍失败时终止，只有最终完整合法的 Story 才会保存。

## 旧格式 Full Story Beat–Scene 提交前复核

以下只适用于无版本的旧 Full Story。初轮（包含实际发生的唯一允许 retry 或 protagonist 姓名局部纠错）通过全部既有校验后，服务端会在提交 Artifact 前独立请求一次同一文本 provider/model，对照只读的 `beatSheet` 与可拍的 `sceneScript` 查找会造成明显叙事断裂的遗漏。这次请求的业务内容只有完整、已合法的 Full Story JSON 和专用复核提示；不会再次上传 Theme Variant、Brief、Visual Guardrails、原片边界、分析或重构数据。

复核只能保持 Story 不变，或把某个对应 `beatSheet[beatIndex].storyAction` 中连续、逐字相同的原文作为 `addition`，追加到已有 `sceneScript[].visibleAction` 末尾；模型不能自由生成 suffix、释义或拼接多个不连续片段。每条提议还必须返回 `beatEvidence`，`addition` 必须包含这段逐字证据；全部证据只能是该 `storyAction` 与目标/相关场次现有 `visibleAction` 的逐字 excerpt。无法从 `storyAction` 逐字投影所需内容时必须返回 `blocked`，不能另写一个“更顺”的动作。

一次 postpass 最多处理 3 个已有场次，每条 `addition` 最多 600 字，全部 additions 合计最多 1200 字。原 `visibleAction` 必须逐字保留为前缀；场次数量、顺序、人物、地点、对白、镜头/声音和其他全部字段都被冻结。合法省略、蒙太奇概括、末项代表整组或已有终态证据不会被机械投影；超限、证据错绑或 addition 不是对应 `storyAction` 的连续原文都会按协议错误拒绝。

正常路径为初轮生成加 postpass，共 2 次 provider call；初轮消耗一次允许的 retry/repair 后成功时，整个 operation 最多 3 次，不存在第四次调用。postpass 返回 `blocked`、协议或供应商错误、越界/非追加改写，或者合并后完整复验失败时，整次请求 fail closed：不保存初轮候选、不回退原 Story，也不再次复核。只有最终 unchanged 或合法追加并通过全部校验的 Full Story 会提交一次 Artifact；初轮候选和复核响应都不会形成额外 revision。

## 接入 Xiaomi MiMo V2.5 / V2.6

页面「模型设置」中选择 MiMo 后，可在文本、图像理解和视频理解阶段选择 `mimo-v2.6-flash`、`mimo-v2.6-pro` 或 `mimo-v2.6-pro-ultraspeed`。V2.6 复用现有 `MIMO_API_KEY`、`MIMO_BASE_URL` 和 `/chat/completions` 适配器，无需增加独立接口或 Key；模型列表暂时请求失败时，三个模型仍可从内置选项中选择。UltraSpeed 的实际调用权限以账号为准，服务端报错原样保留，不会自动换模型。

本次仅增加可选模型，已有默认模型与页面会话覆盖保持原值。要修改服务端 MiMo 默认值，可将下面示例中的 `MIMO_MODEL` 设为 `mimo-v2.6-flash`，`MIMO_STORY_MODEL` / `MIMO_ANIMATION_MODEL` 设为 `mimo-v2.6-pro`；已有阶段专属环境变量仍优先。Qwen 已配置时仍保持现有默认路由，页面按阶段选择 MiMo 才会覆盖它；也可以在 `.env` 设 `DEFAULT_LLM_PROVIDER=MiMo`，让 MiMo 成为全部阶段的默认 provider（见下文）。`MIMO_THINKING`、JSON 模式、输出预算、用量记账和失败处理沿用现有行为；费用估算仍须在 `MODEL_PRICE_CNY_PER_MILLION` 中按确切新模型 ID 配置价格。

接口与模态依据（2026-09-22 核对）：[官方 Chat Completions 文档](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[Flash 模型规格](https://mimo.mi.com/models/zh-CN/mimo-v2.6-flash)、[Pro 模型规格](https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro)、[UltraSpeed 模型规格](https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro-ultraspeed)。

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
MIMO_STREAM_IDLE_TIMEOUT_MS=120000
MIMO_MEDIA_MODE=auto
```

连接成功后，页面右上角会显示当前解析、剧情和动画阶段使用的模型。

`MIMO_MEDIA_MODE=auto` 会优先通过 `video_url` 发送原生视频；请求中会按 MiMo V2.5 文档携带 `fps` 与 `media_resolution`，默认 `MIMO_VIDEO_FPS=2`、`MIMO_VIDEO_MEDIA_RESOLUTION=default`。若服务返回不支持媒体类型的 400/415/422，再自动回退为带时间戳关键帧。超过 `MIMO_NATIVE_VIDEO_MAX_MB` 的视频直接使用关键帧，避免 base64 请求占用过多内存。

MiMo 请求参数默认为 `temperature=0.3`、`top_p=0.95`、`max_completion_tokens=131072`、`thinking=disabled`、`stream=true`。输出上限放到各家实测接受的最大值（MiMo 131072、Qwen 65536；非流式的 DeepSeek 仍是 32768），参考片分析例外，单独默认 16384（`QWEN_ANALYSIS_MAX_COMPLETION_TOKENS` / `MIMO_ANALYSIS_MAX_COMPLETION_TOKENS` 可调，本机正常分析只输出 3–7 千 token）；在「模型设置」里按阶段换成别家时，上限取那一家自己的阶段配置，不沿用默认供应商那一档，模型陷入逐字重复时由读取流程边收边查、当场中断，详见 [输出死循环检测](docs/output-degeneration-2026-09-24.md)。V2.5 / V2.6 的文本、图片、视频理解均通过共享 SSE 解析器接收，推理内容与正文分开，收到完整结束标志后才解析并校验业务 JSON；页面仍在阶段完成后显示结果，不逐字显示未校验正文。每 10 秒最多更新一次任务流进度；实际收到的结构化 token 用量在成功、断流、暂停或终止时均保留，未知用量不估算。流不完整或途中断开明确失败，不回退非流式。HTTP 错误原文及原有媒体兼容回退保持原行为。分镜输出日志通过并行读取响应副本观测 SSE，不阻塞客户端收流；日志只保存正文与供应商用量。[实现与验收记录](docs/mimo-streaming-2026-09-22.md)。如果没有配置 Qwen，参考片分析、脚本还原、creativeBrief、主题变体、完整剧情和动画生产包都会回退到 MiMo 的对应模型。

`MIMO_THINKING=disabled` 时，MiMo 用户消息末尾会追加 `/no_think`；改成 `MIMO_THINKING=enabled` 后，请求体会发送 `thinking={"type":"enabled"}`，并且不会再追加 `/no_think`。

候选阶段的候选调用会给 MiMo 发 `response_format: {type: "json_schema", strict: true}`，由接口按 Schema 约束输出结构（多出的键、数组里的非对象、多写的候选都会在生成时被挡住）。这个 Schema 从服务端候选严格 Schema 派生，服务端校验不变。这是 MiMo 文档外、经实测可用的行为；如果供应商改了，设 `MIMO_JSON_SCHEMA=false` 即可退回 `json_object`。候选对照评审（含「生成完整剧情」前自动跑的展开前体检）与自主分镜 4.0 的「设计分镜」一步用同一个做法，Schema 分别从各自的严格 Schema 派生。其余阶段、千问与 DeepSeek 不受影响。详见 [docs/variants-mimo-format-2026-09-24.md](docs/variants-mimo-format-2026-09-24.md)。

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
QWEN_STREAM_IDLE_TIMEOUT_MS=120000
QWEN_MEDIA_MODE=auto
QWEN_NATIVE_VIDEO_MAX_MB=7
QWEN_VIDEO_FPS=2
QWEN_ENABLE_THINKING=false
```

### 阶段 token 消耗与费用估算

每个阶段结束时，页面会在该阶段原有的状态文案后面追加本阶段消耗的 token 与预估金额，例如「完整剧情已生成 · qwen3.7-max · 本次消耗 12,345 tokens · 约 ¥0.12」。
这里的「阶段」是用户点一次按钮触发的整个操作：**启动 AI 导演** 会累加解析、还原、简报、护栏、变体五个请求；**完整剧情** 与 **分镜** 各是一个请求，但内部的重试、局部修复与审阅修订调用都已计入。

阶段失败时同样报账，措辞换成「失败前已消耗」，例如「模型输出未通过校验：… · 失败前已消耗 48,120 tokens · 约 ¥0.58」；启动 AI 导演在第几步失败，就把失败之前已经成功的那几步一并计入。失败前调用过的模型照样计费，把它藏起来会让人以为一次失败的生成是免费的。只有一种情况显示不出来：请求根本没打到模型（鉴权失败、连接超时、供应商直接返回 HTTP 错误），此时确实没有产生 token。

token 数直接来自各家响应的 `usage`，不产生额外调用。金额需要你自己配置单价，本项目不内置任何价格表：

```dotenv
# 模型ID=输入单价/输出单价，逗号分隔，单位「元 / 百万 token」
# 需要覆盖各家文本模型实际用到的全部型号，缺一个那个模型就只报 token 不报金额
MODEL_PRICE_CNY_PER_MILLION=qwen3.7-max=12/36,qwen3.7-plus=2/8,mimo-v2.5=1/2,mimo-v2.5-pro=3/6,deepseek-v4-flash=0.5/1.5
```

模型 ID 必须与实际使用的 `*_MODEL` 完全一致：Qwen 是 `qwen3.7-max`/`qwen3.7-plus`，MiMo 是 `mimo-v2.5`/`mimo-v2.5-pro`，DeepSeek 是 `deepseek-v4-flash`/`deepseek-v4-pro`。分隔符半角 `,` 与全角 `，`、`、` 都接受，价格分隔 `/` 与全角 `／` 都接受。未配置单价的模型只显示 token 数、不显示金额——宁可不报，也不报一个可能过期的错数字。单条格式错误只会被跳过并告警，不影响启动。
该统计只覆盖文本模型（Qwen / MiMo / DeepSeek / Claude）；即梦图片与镜头视频按张、按秒计费，暂不纳入。

配置 `QWEN_API_KEY` 后，只要 Qwen 可用，参考片分析、脚本还原、创意简报、视觉规则、主题变体、完整剧情、分镜和人物参考修正默认都会调用 Qwen 对应阶段模型；未配置 Qwen 时自动回退为 MiMo。要在两家都配置时默认用 MiMo，设 `DEFAULT_LLM_PROVIDER=MiMo`（只接受 `Qwen` / `MiMo`，DeepSeek 与 Claude 在本工作流只接纯文本，不能做默认）；指定的那家没配置时服务直接启动失败、不静默换成另一家，两家都没配置的演示模式不受影响。`qwen3.7-max` 是纯文本阶段的默认选择；会传入视频或图片的参考片分析、脚本还原、视觉规则和人物参考修正默认使用 `qwen3.7-plus`，也可以改成账号可用的 Qwen-VL / Qwen-Omni 模型。页面顶部“模型设置”按钮可以按阶段临时切换 provider 和模型名（模型是级联菜单：先选系列，例如 MiMo V2.5 / MiMo V2.6，悬停或点击后在右侧展开该系列的型号；只有一个系列的 provider 直接平铺），覆盖值会随之后所有生成请求发送给后端，也会写入导出的生产包。角色图片仍由已配置的即梦图片服务生成。

## Animation Plan 4.0 自主分镜

页面请求 `animationPlanVersion: "4.0"`，服务端返回 `promptSchemaVersion: "4.0"`、`productionStrategy.format: "storyboard_video"`。2026-10-11 起这是唯一支持的版本：旧 2.0（首尾帧）与 3.0（direct_shot）分镜不再打开——生成请求缺版本或带其他版本直接 400；打开旧 Run 时页面提示「这是旧版 X 分镜，已不再支持（只支持 4.0 自主分镜）。请重新生成分镜。」并给出「重新生成分镜」按钮；带旧分镜的测试包不能导入。三个弃置编译器、首尾帧、可灵与自定义 VideoHTTP、3.0 终审与定向修订、批量视频、提示词方言改写和负面词体系也一并删除。

分镜读完整剧情、角色事实、画幅、时长目标、赛道风格、画风与配乐开关，由模型自定片段：每段 4–15 秒整数、可以合并相邻场次、总长落在时长窗口内，每段写成时间连续的 beats（景别、机位、可见动作、对白、声音）。生成依次是设计、审阅、按问题修订（审阅报出问题时）、终审复查（修订改了内容时）；每步被校验拦下时带诊断重做一次，第二次仍失败就明确报错。分镜里没有视频提示词：点某一镜的生成按钮才单独写这一镜的提示词，可以查看、编辑、重新生成，确认后才调用视频。

页面允许选 `9:16` 或 `16:9`，生成时锁进 `productionStrategy.targetAspectRatio`；要换画幅就重新生成分镜。背景音乐默认关闭，关闭时每条单镜提示词以「全片无背景音乐，只保留现场环境声与动作声。」逐字收尾；已有分镜时拨动开关会重新生成整个分镜（先征求同意，已生成的镜头视频随之失效）。

Full Story 的时间轴在签发前仍会检查：`timeRange` 不可解析、跨度非正、场次逆序或单场短于 4 秒时明确失败，不退回默认值也不钳制。

## 接入 DeepSeek-V4 纯文本模型

DeepSeek 只作为显式可选的纯文本 provider，不会因为配置了 API Key 就自动接管 Qwen/MiMo 的默认阶段路由。页面“模型设置”只会在创意简报、主题变体、Legacy Full Story 与 Animation Plan 中提供 DeepSeek；参考片分析、脚本还原、视觉规则和人物图修正仍必须使用支持图片或视频输入的 Qwen/MiMo。前端隐藏不兼容选项，服务端也会在调用 provider 前明确拒绝媒体阶段绕过请求。

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MAX_COMPLETION_TOKENS=32768
DEEPSEEK_REQUEST_TIMEOUT_MS=900000
DEEPSEEK_JSON_RETRY_ATTEMPTS=2
DEEPSEEK_THINKING=disabled
DEEPSEEK_TEMPERATURE=1
DEEPSEEK_TOP_P=1
DEEPSEEK_JSON_MODE=true
```

可选模型为 `deepseek-v4-flash` 和 `deepseek-v4-pro`，页面默认把 Flash 放在首位，Pro 保留为显式对照选择，不做静默回退。客户端使用官方 OpenAI 兼容 `/chat/completions` 与 JSON Output；空内容、非法 JSON、鉴权失败和媒体输入都会明确失败或按既有受控次数重试，不会返回默认值掩盖错误。接口依据：[DeepSeek V4 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。模型设置中的阶段标题会显示“视觉模型”或“文本模型”标签，图片和视频生成阶段保留独立标签。

Qwen、MiMo 与 Claude 走流式传输，只判空闲、不设总时长：连续 `QWEN_STREAM_IDLE_TIMEOUT_MS` / `MIMO_STREAM_IDLE_TIMEOUT_MS` / `CLAUDE_API_STREAM_IDLE_TIMEOUT_MS`（默认 120000）没有收到任何数据（含推理内容）才中断，数据一直在来就不会被掐；`QWEN_REQUEST_TIMEOUT_MS` / `MIMO_REQUEST_TIMEOUT_MS` 对它们不再生效。非流式的 DeepSeek 仍按 `DEEPSEEK_REQUEST_TIMEOUT_MS=900000` 设单次请求总超时。`SERVER_REQUEST_TIMEOUT_MS=900000` 同步限制服务端接收请求体的时间；它不替代模型请求超时设置。

Qwen 视频解析遵循阿里云百炼 OpenAI 兼容 Chat Completions 的多模态格式：小视频优先以 `video_url` 发送 Base64 Data URL，大于 `QWEN_NATIVE_VIDEO_MAX_MB` 或 `QWEN_MEDIA_MODE=frames` 时改用关键帧图片列表 `video`。阿里云文档说明 `video_url` 支持公网 URL 或 Base64 Data URL，`fps` 可控制抽帧频率；同时 Base64 视频编码后需小于 10MB，所以默认把原始视频上限设为 7MB。Qwen-VL 只能理解视频视觉信息；如果需要理解视频里的音频，需要选择支持音频的 Qwen-Omni 模型。接口依据：[MiMo V2.5 模型说明](https://mimo.mi.com/docs/en-US/product/introduction/models#MiMo-V25)、[MiMo OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[MiMo 视频理解文档](https://mimo.mi.com/docs/en-US/use-cases/video-understanding)、[阿里云百炼 OpenAI Chat 兼容文档](https://www.alibabacloud.com/help/zh/model-studio/qwen-api-via-openai-chat-completions) 和 [阿里云图像与视频理解文档](https://help.aliyun.com/zh/model-studio/vision)。

## 接入 Claude 纯文本模型（2026-10-19）

Claude（Anthropic）与 DeepSeek 同一档：只作为显式可选的纯文本 provider，配了密钥也不接管 Qwen/MiMo 的默认阶段路由，也不能设成 `DEFAULT_LLM_PROVIDER`。页面「模型设置」只在纯文本阶段列出 Claude；参考片分析、脚本还原、视觉规则和人物图修正要看图或视频，前端不列、服务端在调用前拒绝、客户端也拒绝媒体输入。客户端走官方 SDK `@anthropic-ai/sdk`（版本锁死），不用 Anthropic 的 OpenAI 兼容端点。

```dotenv
CLAUDE_API_KEY=你的 Anthropic API key
# 以下都是可选项，写出来的是默认值
CLAUDE_API_BASE_URL=https://api.anthropic.com
CLAUDE_API_MODEL=claude-sonnet-5-5
CLAUDE_API_MAX_COMPLETION_TOKENS=128000
CLAUDE_API_STREAM_IDLE_TIMEOUT_MS=120000
CLAUDE_API_JSON_RETRY_ATTEMPTS=2
# 不写就用型号自己的默认值；可选 low / medium / high / xhigh / max，写错时启动直接报错
# CLAUDE_API_EFFORT=high
```

环境变量一律用 `CLAUDE_API_` 前缀，**不读 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `CLAUDE_EFFORT`**：Claude Code 会给它启动的进程导出后两个（也可能有第一个），从 Claude 会话里启动的服务会继承它们，读了就会把 Claude Code 自己的设置甚至密钥当成本工作流的配置。

可选型号是 `claude-sonnet-5-5`（默认，按《鲸鱼风筝》剧本的分镜对比定的）、`claude-opus-5-5`、`claude-haiku-5-5` 和 `claude-fable-5-1`。几项行为：

- 流式传输，只判空闲、不设总时长，ping 也算有数据。SDK 自带的重试关掉，重试只由各阶段已有的预算决定。
- 默认开着自适应思考，推理字数会显示在进度里，深浅用 `CLAUDE_API_EFFORT` 调。导演助手每次都要关思考：Opus 5.5 与 Fable 5.1 关不掉，选了它们时导演助手在调用前就报错；Sonnet 5.5 与 Haiku 5.5 可以。
- 输出被上限截断报截断；被 Anthropic 的安全分类器拒绝（`stop_reason: refusal`）报内容审核拦截，带上拒绝类别，**不会自动重试，也不会自动换别的模型**（Anthropic 的 server-side fallback 没有开）。
- Claude 没有 `json_object` 模式；JSON 靠提示词与本地严格校验，第一期不发结构化输出 Schema。整段正文恰好被一对 ```json 代码块包着时，客户端先去掉这层包裹（Haiku 常这样写）；前后多了说明文字之类的仍然判失败。

费用：Claude 按美元计价，要显示 ¥ 就在 `MODEL_PRICE_CNY_PER_MILLION` 里按型号自己换算后填写。Fable 5.1 要求组织开着 30 天数据保留，零数据保留（ZDR）的组织调用会 400。决定、映射与验证记录见 [docs/claude-provider-2026-10-19.md](docs/claude-provider-2026-10-19.md)。

## 接入即梦 5.0 Lite 角色参考图生成

分镜生成后，“角色参考提示词”标题右侧会出现 `+` 号。点击后选择角色和生成数量，可以直接按文字设定生成，也可以先上传一张参考图片（可选），系统会用即梦 5.0 Lite 流式生成站立全身角色参考图，并把生成图保存到 `public/generated-images/`。分镜签发了「角色画风」时，提示词里会多一行「画风：……」。选择某张图“设为人物参考图”后，会写回分镜里的角色参考提示词并签发新的分镜版本，已生成的镜头视频随之失效。

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

分镜生成后，剧情页提供导出：

- 导出当前生产包 JSON：当前测试/规划包版本为 `3.0`。服务端校验当前 Variant → Full Story → Animation Plan revision 后写入 `productionLineage`、内容摘要和本机持久 HMAC 签名；被修改的文件、旧版文件或血缘不一致的文件不能导入。「从剧情开始」的 Run 签 `3.1`：原文、角色边界、候选与固定角色设定由服务端从 Run 读出，依赖图必须与这种剧情模式的唯一定义逐项相等，详见 [v3 测试/规划包](docs/production-lineage-state.md#7-v3-测试规划包)。包里的分镜必须是 4.0，带旧 2.0/3.0 分镜的包不能封装也不能导入。

浏览器启动一次工作流时，服务端会在 `runtime/production-runs/` 建立 Run，并在每个阶段成功后持久化 Artifact、revision、依赖摘要、Stage 状态和 Checkpoint。同一 Task 使用相同 requestId 重复 finalize 时，相同 JSON（包括仅键顺序变化）复用原 revision；不同 requestId 不获得该豁免。同一 Variant ID 的实际内容变化会确定性标记旧 Story、Plan 和媒体为 stale。

浏览器工作数据现在随标签页存活：原视频副本保存在私有工作区，Run 元数据同时记录可恢复的视频 URL 和 SHA-256；有效期内刷新或服务器重启后，同一标签页可恢复原视频、抽帧和已完成结果。更换视频立即清除该页旧 Run、媒体及应用保存的视频副本；关闭页面后有 60 秒刷新宽限期，随后服务端删除该页的全部工作数据。页面生命周期连接断开也会触发关闭清理；后台页面连接仍在时保持数据，无连接也未收到关闭通知时，以最后一次心跳起 2 分钟过期兜底；服务器关闭期间无法执行删除，下次启动补清。仅“设定创作宇宙”中的七项设置长期保存，模型覆盖设置只在标签页会话内保存。不会删除用户最初选择的文件或主动导出的文件，也不会自动认领或批量删除升级前没有页面归属的历史 Run。详见 [浏览器工作区生命周期](docs/production-lineage-state.md#浏览器工作区生命周期2026-09-09)。

Durable Task v1 另在每个 Run 的私有 `tasks/index.json` 保存执行 sidecar。AI 导演是一个 `directorPipeline` 父任务和五个顺序子任务；Full Story、Animation Plan、角色参考图和镜头媒体也由服务端 Runner 执行、校验并提交，浏览器只创建、轮询和重新 attach。刷新或 HTTP 断线不会中止同一 Node 进程内仍在运行的任务；重复创建相同 active operation 会返回同一 `taskId`，同一目标的不同 operation 会返回 `TASK_TARGET_BUSY`。任务没有总墙钟 deadline，watchdog 只检测“当前 provider/local operation 长时间没有进展”，并在每次 provider 返回或流事件后续期。

Node 重启仍是明确边界：Prompt、Data URL、Base64 和完整请求体不落 Task Store，所以未完成任务会变为 `interrupted`，不会自动重新调用 provider；远端任务可能已经提交并计费。Brief/Variants 可以直接从 current Artifact 链继续，需要媒体的 Analyze/Reconstruct/Visual Guardrails 使用浏览器从已保存副本恢复并重新采样的原视频；没有副本的历史 Run 仍须重新上传 SHA-256 与原 Run 一致的源文件。`abandoned` 只是释放本地提交权，不等于远端取消。T04 媒体 quarantine、T05 provider task-id 查询/接管和正式跨进程 batch queue 尚未实现。详见 [Production Lineage 与持久状态](docs/production-lineage-state.md)。

任务控制面：

- `POST /api/tasks/create`：创建或复用任务，返回 `202`；
- `GET /api/tasks?projectId=&runId=`：锁外读取该 Run 的任务 sidecar；
- `GET /api/tasks/:taskId?projectId=&runId=`：读取单个任务；
- `POST /api/tasks/:taskId/control`：对 `directorPipeline` 与 `fullStory` 执行 `pause | resume | terminate`；
- `POST /api/tasks/:taskId/release`：强制释放目标并标记 `abandoned`，不承诺取消远端调用。

“生成完整剧情”与“启动 AI 导演”在执行时显示相同的控制组：左侧终止，右侧暂停/继续。完整剧情暂停会断开当前模型请求；继续重新执行本次完整剧情生成，初轮和分场复核都可能再次计费。已收到的用量会跨尝试累计，未收到的明确标为未知。暂停或终止保留此前已签发结果；刷新恢复暂停状态，不自动继续。两个图标的悬停背景为 32×32px，点击区域为 44×44px。

## 镜头视频：全能参考

分镜里的每个镜头可以生成 1–4 个候选视频。页面“模型设置”中的“镜头视频”阶段可在 Seedance 2.0 与 MiniMax H3 之间切换，默认 Seedance。生成模式只有 `all_reference`（全能参考）：图片、视频和音频只是人物、场景、动作、运镜、节奏或声音参考，不被解释为精确首尾帧；Seedance 2.0 与 MiniMax H3 使用官方 R2V 角色 `reference_image`、`reference_video`、`reference_audio`，不得与 `first_frame` / `last_frame` 混用。请求中的 `generationMode` 是模式权威字段，只接受 `all_reference`，其他值明确失败，不会根据缺失字段、provider、模型名或素材存在性推断或改写。分镜是旧 2.0/3.0 时视频请求以 409 拒绝。

**升级注意**：可灵（Kling）与自定义 VideoHTTP 已于 2026-10-11 删除，`.env` 里 `SHOT_VIDEO_PROVIDER` 还写着 `Kling` / `VideoHTTP`、或者还配着 `VIDEO_HTTP_CONFIG` 时服务启动会明确失败（不会悄悄改用 Seedance），请把 `SHOT_VIDEO_PROVIDER` 改成 `Seedance` 或 `MiniMax`，并删掉 `VIDEO_HTTP_CONFIG`（Seedance / MiniMax 的配置文件写在 `SEEDANCE_VIDEO_CONFIG` / `MINIMAX_VIDEO_CONFIG`）。

权威边界是：当前签发的 Full Story、exact shot 与 `fixedCharacterBoundary` 决定剧情、身份、动作、时长、场景与声音事实；冻结后的参考 manifest 决定素材编号和角色。弹窗 `promptOverride` 也只覆盖本次请求文本，不能取得其他 exact-shot 字段的权威。

全能参考模式有“把上个镜头内容作为普通参考图”开关；4.0 只有衔接方式为 `continuous` 的镜头默认勾选，首镜、硬切与时间省略默认不勾选。勾选后，系统按当前分镜的 `shotPlan[]` 顺序找到紧邻上一业务镜头，从当前 Run/Plan namespace 中读取它已选中的 current 视频候选，再由服务端 FFmpeg 均匀截取 5 张 JPEG（首帧、末帧和中间三等分点），作为 `reference_image` 与本镜头角色图和用户上传媒体一起发送。张数固定为 5：9 图上限是和角色参考图共用的，抽帧占满会把锁角色长相的图挤出去，5 张也正好落在 MiniMax 的免费额度内。第一镜、上一镜未生成/已 stale、旧 Plan URL、非当前 namespace 文件都会明确失败；来源场次相同也不承诺物理地点无缝连续。该开关只加强身份、画风和短时表演连续性，当前镜头的剧情动作、固定角色边界与目标场景仍优先；跨地点、跨时段或上一镜本身有漂移时应保持关闭。视频请求始终由服务端从当前 Plan 解析 exact shot；弹窗中的文本编辑只形成有回执的本次 `promptOverride`，不能伪造镜头动作、时长或场景。

全能参考必须至少包含合法图片或视频；共同限制为最多 9 张图片、3 段视频、3 段音频，单段视频或音频 2–15 秒，视频总时长与音频总时长分别不超过 15 秒，且不能只上传音频。上一镜实际抽帧也计入 9 图上限，超限不会静默丢图。服务端提交异步任务、轮询终态，并把 mp4 下载到 `public/generated-videos/<project>/<run>/<plan-revision>-<digest>/`。使用上一镜抽帧的后镜媒体还依赖上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选后，依赖它的后镜视频会递归 stale。文件名同时带 Plan revision/digest 前缀和随机请求 nonce；返回文件还会经过 ffprobe 可播放性验证。上一镜源视频与逐秒 JPEG 的 SHA-256 写入连续性回执。生成期间服务端会反复复验 Plan 与上一镜候选是否仍为 current（任何供应商调用前、每条候选提交前、每条候选落盘后、返回前各一次）：一旦发现你已经重新生成 Plan 或切换了上一镜候选，剩余候选不再提交供应商，本次已经下载的 mp4 会被删除，请求以 409 失败，不会留下孤儿文件，旧 Plan 的异步结果也不会挂到新 Plan。已经提交给供应商的那一条无法中途撤回，它的花费收不回来。

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

`SEEDANCE_API_KEY` 留空时会复用同一火山方舟账号的 `JIMENG_API_KEY`。可选模型包括 Standard `doubao-seedance-2-0-260128`、Fast `doubao-seedance-2-0-fast-260128` 和 Mini `doubao-seedance-2-0-mini-260615`。全能参考使用 `reference_image` / `reference_video` / `reference_audio`。默认 `generate_audio=true`；轮询把 `succeeded`、`failed`、`expired`、`cancelled` 全部视为终态，避免过期或取消后永久卡住。能力依据：[Seedance 2.0 官方发布](https://seed.bytedance.com/blog/seedance-2-0-official-launch)、[BytePlus ModelArk 视频生成 API](https://docs.byteplus.com/en/docs/modelark/1520757)。

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

**生成分辨率（2026-10-10）**：镜头视频弹窗里可以按次选分辨率，只列当前视频模型支持的值（Seedance 2.0 标准版 480p / 720p / 1080p，fast、mini 480p / 720p，MiniMax H3 768P / 2K；先不放 4k）。上面两个 `*_VIDEO_RESOLUTION` 是没选时的默认值，页面会标出「（默认）」；选择只记在这个标签页里。配了所选模型不支持的值会明确报错，不再悄悄改成 720p 或 2K。每条候选视频下面写出请求的分辨率与实测宽高，例如「1080p（实测 1920×1080）」。分辨率越高，供应商收费越高、生成越慢；页面不显示价格。

全能参考模式把这一镜确认过的中文提示词与已冻结的 `reference_image`、`reference_video`、`reference_audio` 一并发送，不混入端点角色。MiniMax V2 API 只接受 4–15 秒整数，Seedance 2.0 同为 4–15 秒整数；项目不再另设 4–6 秒子集，4.0 分镜每段时长本来就是 4–15 秒整数。不合法时明确拒绝，不能自动钳制、补长或缩短——Seedance 侧过去的静默 clamp 已改为明确失败。全能参考模式按当前分镜显式发送 `9:16` 或 `16:9`。服务端通过 `GET /v2/query/video_generation/{task_id}` 轮询 `queued/running → succeeded/failed/cancelled`，成功后下载 `task.content.url`。4.0 分镜没有负面词，视频请求不带负面提示词。接口依据：[创建视频生成任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)、[查询任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-query)。

### 供应商错误提示

调用失败时，服务端会按各家官方错误码表把响应翻译成可执行的中文提示，而不是把原始 JSON 甩给用户。例如 MiniMax 的 `insufficient_balance_error (1008)` 会显示成「账户余额不足（MiniMax insufficient_balance_error）。前往 MiniMax 控制台充值后重试。」

覆盖 MiniMax（v2 的 `error.type`、消息尾部括号数字码与旧接口 `base_resp.status_code`）、火山方舟 Ark（Seedance 视频与即梦图片共用公共错误码）、阿里云百炼 DashScope（Qwen）、DeepSeek、小米 MiMo 与 Claude（按 `error.type`）六家，码表出处与核对日期写在 `src/provider-error-codes.js` 文件头。

供应商原文逐字保留在响应的 `detail` 字段，解释放在新增的 `providerError` 里——排查时随时可取。匹配不到官方码时不做任何解释，直接回退原文展示。

该内置链路支持页面内逐镜生成（全能参考），没有批量视频。它仍不提供跨进程 JSONL/lease 队列、远端任务接管、本地视觉质检或 ffmpeg 成片合成；Node 重启后的续跑和最终后期仍由后续 Production Workspace 负责。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：各导演阶段的提示词和结构化输出契约。
- `src/provider-error-codes.js`：各供应商官方错误码 → 可执行中文提示（纯展示层）。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/qwen-client.js`：Qwen OpenAI 兼容多模态适配器。
- `src/deepseek-client.js`：DeepSeek-V4 OpenAI 兼容纯文本适配器。
- `src/claude-client.js`：Claude（Anthropic 官方 SDK）纯文本适配器。
- `src/character-boundary.js`：全局角色边界的上游摘要、签发和验签。
- `src/production-lineage.js`、`src/production-state-store.js`：确定性内容摘要、revision 依赖图、stale 传播、Run/Stage/Artifact/Checkpoint 持久化和 v3 测试包签发/导入。
- `src/workflow.js`：完整创意工作流编排。
- `src/storyboard-*.js`：Animation Plan 4.0 自主分镜（设计、审阅、修订、终审复查）与单镜提示词。
- `src/shot-video-generator.js`：把单镜提示词与全能参考素材路由到所选视频 provider；启用上一镜参考时，在临时目录用 FFmpeg 按确定性时间戳均匀截取 5 张图并作为普通 `reference_image` 合并校验。
- `src/shot-video-continuity.js`：从当前 Plan/Run/media namespace 安全解析紧邻上一镜的 current 视频候选，并签发后镜媒体所需的 source lineage 回执。
- `src/shot-video-providers.js`：Seedance / MiniMax 模型白名单、默认选择及互相隔离的运行配置。
- `workers/generic-http-worker.mjs`：Seedance 与 MiniMax 的全能参考（R2V）请求体、异步轮询、产物下载和脱敏回执。
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

密钥跨重启保持不变，所以重启服务后可以继续用之前的 Run 生成剧情、分镜和视频。环境变量填错、密钥文件损坏或长度不足时服务会**直接启动失败**，不会悄悄换一把新钥匙——那会让全部已落盘 Artifact 的签名瞬间作废。

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
