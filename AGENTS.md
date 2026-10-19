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
→ Animation Plan 4.0（自主分镜）
→ 角色参考图与单镜提示词
→ 视频生成（全能参考）
→ 导出生产数据

当前系统重点是保证：

- 剧情一致性
- 角色一致性
- 镜头连续性
- AI 输出可验证性
- 生产流程可恢复性


---

# 1. 当前架构事实（必须遵守）

**从剧情开始（2026-10-09，第一期）**：首页新增第二个入口，Run 元数据 `entryMode: "story"`（缺省即参考视频 Run，旧 Run 不回填）。用户粘贴完整故事（`storyMode: "fullStoryText"`，严格按原文）或只给固定角色设定（`"characterOnly"`，原创一个）。`POST /api/production/run/story/start` 按 v3 导入的顺序建 Run（校验 → 清空本页视频与旧 Run → createRun → 服务端提交 `storySource` → 绑定工作区），`storySource` 是用户原文唯一的存放处：浏览器通用提交口拒收（`STORY_SOURCE_SERVER_ONLY`），服务端只在开 Run 与导入 3.1 测试包时写它（2026-10-10，见 §9），Run 元数据一次写定 `storySourceDigest`，各任务读取时核对（`STORY_SOURCE_TAMPERED`）；原文不进 Task Store、浏览器存储或 `creatorProfile`。`storyPipeline` 父任务（与 `directorPipeline` 并列、互不复用，无暂停/终止）按 Run 元数据里的 `storyMode` 跑两步，第一步都是只看文字的角色边界（复用 `visualGuardrails` 阶段设置，`sourceSimilarityRules` 必须为空）。只给角色设定时第二步是单个故事候选（复用 `variants` 阶段设置），之后由服务端签发 `variant:V1`。**粘贴完整故事不生成候选**（2026-10-09 补充，起因是用户反馈「给了剧情就不要再改一遍」）：第二步直接按原文拆出可翻拍镜头 `fullStory:V1`（子任务 `storySceneScript`，复用 `fullStory` 阶段设置，与分场页「重新拆分」的独立 `fullStory` 任务调同一个函数）；这类 Run 里 `V1` 是「故事位」而不是候选编号，`fullStory.selectedVariantId` 由服务端写成 `V1`（与 `targetDurationSeconds` 由时间轴派生同规格），完整剧情、分镜、角色图与人物精修的请求体出现 `variant` / `themeVariants` / `candidateBinding` / `selectedVariant` 任一副本一律 400 `STORY_ENTRY_INPUT_INVALID`。角色边界 `sourceDigest` 剧情 Run 用第 2 版（固定角色设定三项 + `storySource`，版本号写进哈希输入），参考视频那一版逐字节不变；候选（只给角色设定）用从视频版严格 Schema 派生的一份（去掉四个对照原片的字段、恰好一个、id 由服务端签发）。完整剧情、4.0 分镜、人物精修、角色参考图与镜头视频按 Run 元数据分支依赖与边界校验，视频 Run 行为不变；剧情 Run 上的参考视频专用任务一律 409 `TASK_ENTRY_MODE_MISMATCH`，只支持 4.0 分镜，不支持展开前体检、候选评审/修订与按问题修改；测试包签 3.1（2026-10-10 起，见 §9）。粘贴原文模式用新的按原文拆场提示词（`storySceneScriptPrompt`）：原文是唯一依据、提示词里没有候选，主角改名（原文称呼与固定角色名不同时改成固定角色名，唯一允许改的字）与台词只能逐字取自原文的规则都在其中；与完整剧情共用的规则（场次合同、输出结构、角色与道具之分、外观不等于能力、时间轴写法）在运行时从视频版 `fullStoryPrompt` 按锚点逐字截取，锚点对不上直接抛错，视频版提示词由 golden 测试锁定逐字不变；4.0 分镜锁定台词；粘贴原文的 Run 不提供「检查剧情硬伤」（它拿候选核对承诺）；另有只读的台词核对（`/api/production/story-entry/dialogue-check`，只提示不拦截）。完整契约与已知缺口见 `docs/story-entry-phase1-2026-10-09.md`。

**导演助手对话栏（2026-10-09，导演 Agent 第二期）**：页面右侧的对话栏按进度提议下一步，用户点卡片上的「确认执行」才执行，执行的是页面原有按钮背后的同一段代码；每步做完给一段只报计数的总结，失败写出原因（审核拦截说明不会自动重试）。分两半：「能做哪几步、下一步、花多少」**只由** `public/director-agent-progress.js` 从页面状态算（固定规则）；`POST /api/director-agent/turn` 只把用户打的字对到这份清单里的一个编号（或 `none`）再写一句回复——只出建议，不签发、不建任务、不执行（`docs/GitHub-Benchmark-后续改造待办.md:283/:467` 排除了把对话当事实来源和让模型编排业务流程）。挑故事候选**只做成按钮**、不进模型能选的清单（:477 禁止默认选第一个候选），请求里出现即 400。卡片带 `guard`（Run、epoch、故事/分镜版本、卡片上显示的画幅/画风/配乐/模型），点之前对不上就作废；弹窗开着或有步骤在跑时不提任何可执行动作；「设为人物参考图」会作废已有镜头视频，所以角色参考图排在镜头视频之前。对话只在页面内存里，不进 Task Store、Artifact、localStorage 或 sessionStorage，刷新即清空。发给模型的进度说明只有状态、计数、固定标签和规则写出的补充说明，**不含**故事原文、候选标题、模型写的文字或供应商报错原文；请求不走 `api()`，免得对话用量混进正在进行的那一步。新阶段 `directorAgent`（可选、默认文本模型、上限 8192、每次关闭思考），最多 2 次调用、禁止第三次。花费：文本步骤写调用次数**下限**与本 Run 上次同类实际用量（¥ 只在单价已知时显示），出图/视频只报数量。模型回复的文字没有确定性兜底（待解决项第 21 条）。导入测试包（2026-10-10）：剧情包读回 Run 之前对话栏不观察，免得把半截状态报成「原文改过了」「刚拆好」；读回之后原来有 Run 说「已经换成新的 Run。」，原来没有 Run 而导入的 Run 已有结果说「已经打开新的 Run。」，都按新进度提议。详见 `docs/director-agent-chat-2026-10-09.md`。

**一句话修改（2026-10-11，导演 Agent 第三期）**：在导演助手里说一句话（「第 3 场改成雨停了」「A04 别让她回头」），对剧情、4.0 分镜或某一镜的视频提示词写局部修改。导演助手的模型只把这句话对到三个修改动作之一（`editStory` / `editStoryboard` / `editShotPrompt`：模型能选，但从不作为下一步、不做成按钮；至少一镜有视频之后，点名某一镜只改它的提示词，免得别的镜头视频作废），卡片带用户这一句原话。`POST /api/one-sentence-edit/draft` 另起一次调用按原话写修改稿，**只出修改稿、不签发**：被改的那一份与它的上游由服务端从 Run 读当前版本，请求里出现任何副本 400、基准版本变了 409、相关任务在跑 409；当前版本自己过不了签发校验就在调模型之前拒绝。模型只写「在某个字段里找到唯一一段原文 → 换成什么」（`{decision: edit|decline, patches(≤6), note}`），原文由服务端逐字替换：剧情复用「按问题修改」的执行器（可选参数放宽为还能改情绪节点、剧情功能与两份梗概，不传时行为逐字不变）并走 `validateFullStoryForSigning`；分镜复用 `applyEditorial` 的可改清单再去掉角色外观；提示词不许整段替换，改完必须仍逐字含这一镜的台词、出镜角色名、画风与无配乐收尾句，且不含素材编号（`shotVideoPromptViolations`，与写提示词共用一份判据；角色名与素材编号两条 2026-10-12 加入，旧规则写的提示词过不了时请先重新生成这一镜的提示词）。做不到的（加场、加人、改时长、新增台词、话没说清楚）写 decline。结构错或执行不了带诊断重试一次、禁止第三次，审核拦截不重试。采纳走 `POST /api/production/one-sentence-edit/adopt`：服务端拿当前版本重新应用同一组修改，结果摘要必须等于修改稿上的（否则 409），再以**与上一版完全相同的依赖**签发（分镜另签媒体命名空间），剧情 Run 因此仍能导出 3.1 包；原文永远不动。作废：改剧情→分镜及其下游；改分镜→单镜提示词、镜头视频与角色候选图（已设为人物参考图的图在分镜里，保留）；改提示词→什么都不作废。新阶段 `oneSentenceEdit`（可选、默认文本模型、上限 ≥32768、不改思考设置）。修改稿与原话只在页面内存里，不进 Task Store、Artifact 或浏览器存储。「粘贴完整故事」的 Run 也能改情节和台词，改过的台词会出现在台词核对的「在原文里找不到」里。改得对不对没有确定性兜底（待解决项第 22 条）。详见 `docs/one-sentence-edit-2026-10-11.md`。

**Animation Plan 自主分镜 4.0（2026-09-21，工作区接入，真实验收尚未闭环）**：请求必须带 `animationPlanVersion: "4.0"`，缺省或其他版本一律 400（2026-10-11 起旧 2.0/3.0 已删除，见「已删除的功能（2026-10-11）」）。新版以完整原 Full Story、角色事实、画幅/时长/风格/表情/音乐参数生成完整 beats，AI 自定片段与时间、可合并相邻场次；每段整数 4–15 秒、总长沿用共享时长窗口。旧 Full Story 不要求重新生成，不修改正文或重签，只由模型抽取缺失配角事实进入 Plan 的 `characterRegistry`。新生成 Full Story 的浏览器请求为 `full_story/1.2`，正文生成后只整理角色表，未知外观仍交给分镜；旧 1.1/无版本数据不迁移。完整上游冻结和验签仍在，创作 Prompt 不送 Brief/候选/原片叙事。

新版先生成设计，再由 AI 审阅并至多一轮按问题修订，保留修订/引导说明；合理简写不改，模型语义意见不阻断继续，字段/时间/引用/签名仍严格。Plan 没有 `videoPrompt`，点击单镜按钮才创建 `shotVideoPrompt` Durable Task，独立 Artifact `shotVideoPrompt:<variantId>:<shotId>` 依赖 current Plan，绑定 digest 与视频/写稿模型配置。Task Store 仍不保存 Prompt；窗口支持缓存、编辑与重新生成，用户确认前不调视频。单镜提示词按「开场 → 逐个 beat 写镜头、分镜写明的站位与朝向、动作、台词与声音 → 结束状态」组织，出镜角色名与素材编号各有一条确定性判据（2026-10-12，见下文「单镜视频提示词写法」）。只有 continuous 默认请求上一镜抽帧；旧媒体接口需要的字符串只读投影，不回写为第二份分镜。4.0 没有批量视频与手动终审界面。每步被校验拦下时带诊断重试一次（2026-09-22 起，每步最多 2 次 provider 调用），不能自行缩短时间或改写分镜。详见 `docs/animation-storyboard-implementation-2026-09-21.md`。

**本机出网代理（2026-09-10）**：macOS 服务、`bin/run-video.js` 和 `workers/generic-http-worker.mjs` 在实际请求前统一初始化 `src/system-proxy.js`。以 `scutil --proxy` 当前有效配置为权威，每 2 秒刷新；不固化地址/端口，也不让继承的大小写 HTTP(S)/ALL/NO_PROXY 覆盖系统状态。全局 fetch dispatcher 保持稳定，后续 dispatch 根据 HTTP/HTTPS 独立开关、系统例外和回环绕过选择连接器；更新不重启 Node、不重复提交、不主动中止在途请求。需要 SOCKS 的路由、PAC/自动发现、读取失败和非法启用配置明确阻断相应外部请求，禁止静默猜测或降级。非 macOS 保留环境代理。该层只改变传输路径，不改变 provider/model、Prompt、任务状态或计费语义。说明与证据见 `docs/system-proxy-follow-2026-09-10.md`。`/api/health` 的 `networkProxy` 在环境代理模式（非 macOS）下按初始化时的环境变量报告 `http/https` 为 `proxy` 或 `direct`（https 没配时回退 http，与 undici `EnvHttpProxyAgent` 一致）；2026-10-05 之前这里恒报 `direct`，与实际走代理相反。

**任务进度与失败原因（2026-09-25）**：4.0 自主分镜每个阶段开始前把 `step`/`stepIndex`/`stepMax` 写进 Durable Task progress（经既有心跳在 Run 锁内合并），MiMo/Qwen 心跳另报 `reasoningChars`（只存推理字数、不存推理文字），页面显示「第 n/m 步 阶段名 · 推理中（已推理 N 字）| 已接收 N 字」；无 step 的任务文案不变。任务错误新增可选 `providerError`，由 HTTP 出口与 Task Store 共用的 `describeServerProviderError()` 识别（同一份码表），经既有脱敏限长落盘、识别不出就省略，`code/category/message/retryable` 不变；浏览器各任务失败文字用 `taskErrorMessage()` 拼上 `providerErrorText()`。欠费千问真实请求核对为「阿里云账户欠费」并带原文。人物参考精修与镜头视频弹窗不再写死供应商名，精修按 `characterReference` 阶段实际设置显示。

**浏览器工作区生命周期（2026-09-09）**：新的浏览器 Run 必须绑定服务端 `metadata.browserWorkspaceId`。原视频副本在私有 BrowserWorkspaceStore 持久化，Run metadata 记录其 URL 和 SHA-256；Task Store 仍不保存视频、Prompt 或完整请求体。同一标签页刷新/服务重启恢复副本并重新抽帧，不自动重调 provider；更换视频必须先清旧 Run/媒体/应用源副本。pagehide 或页面生命周期连接断开有 60 秒刷新宽限期，5 秒 sweep 清理；后台页连接仍在时不因心跳节流过期，无连接也无关闭通知时最后心跳起 2 分钟兜底，停服期间下次启动补清。sessionStorage 保存 workspace ID，每文档 pageId 与 source generation 分别阻止旧关闭通知和旧输入回写；不再恢复旧 localStorage Run 指针。长期保存仅创作宇宙七项设置（角色、赛道、限制、画风、候选数量、画幅、时长；2026-10-09 起画风接替原来的表情规则），模型覆盖只存 sessionStorage。画风和三个生成偏好不得并入 creatorProfile。清理须核对页面归属，scheduler → Run 锁撤销任务后删源副本、Run、其命名空间媒体及 Run 内 Debug；迟到 Runner/worker 不得重建已清数据。已有无页面归属历史 Run、用户原文件、主动导出文件、签名密钥不能由此清理。详见 `docs/production-lineage-state.md` 的浏览器工作区生命周期。

**Full Story 单一正文格式（2026-09-14）**：当前生成默认要求显式 `schemaVersion: "full_story/1.1"`，独立严格 Schema 只保留 `selectedVariantId/title/oneLinePremise/targetDurationSeconds/shootingSynopsis/characterBible/sceneScript/keyProps/dialogueStyleGuide/uncertainties` 与版本键。`sceneScript` 是唯一完整动作稿；删除 `beatSheet/retentionPlan/experienceFidelity/transformationProof/continuityAndSafetyCheck/shootingPlan`，`keyProps` 不再写 `avoidSimilarityNote`，不得自动删旧输出字段来过新版校验。至少一场；`shootingNotes` 必填字符串、允许空，其余场次字段、出镜/对白/角色注册合同保持严格。生成 Prompt 取消六场、身体大动作与无关生活细节配额，按已选候选动作与共同体验收尾，外观不授予新能力。镜头指导不属于本阶段职责，但模型是否遵守须看真实原文，不能靠字段声明认定合格。

输入仍通过完整上游冻结与验签，再由 `fullStoryCandidateFacts()` / `fullStoryCharacterFacts()` 只读投影选中故事事实与完整角色 traits（含 scope）/对白规则。原片具体场次、Brief 的改编要求、候选来源证明和自评不再进入 FullStory Prompt；完整 Artifact 不变，不生成 Kernel 或第二份事实源，`narrativeMode` 现在作为候选已声明的展开路径进入该阶段。新版只运行 primary 与实际必要的已有有界修复，不调用没有 beatSheet 目标的 postpass，不伪造语义审查通过；时间线在 commit 前复用 `deriveDirectShotSkeleton()` 检查下游可消费。旧无版本数据继续原严格 Schema、六场/六拍和原 postpass；未知版本拒绝，不自动升级、迁移或改 digest。Full Story control 对新版继续同一 taskId 重跑整个 operation，旧格式仍包括 postpass；候选冻结、claims、usage 累计、迟到回写和媒体 stale 语义不变。后文涉及整份 Brief/原片注入、六场、第二份 beatSheet 与默认 postpass 的旧记录仅描述旧格式和历史实验，以此段为当前生成规则。证据见 `docs/full-story-narrative-ab-2026-09-14.md`。

**Full Story 对白规则来源隔离（2026-09-14）**：`fullStoryCharacterFacts()` 的只读投影仅沿用 `text` 非空、存在非空 `triggerEvidence`，且每条证据的 `sourcePath` 都是 `creatorProfile.fixedCharacter` 或 `creatorProfile.constraints` 的规则。原片/Brief、混合来源与未知来源的规则不得整体提升为用户说话命令；不按“温暖”“太阳味”等词过滤，也不拆句猜测哪部分属于用户。合法用户规则、固定角色 traits 与用户原始 constraints 保持原样；完整上游 Artifact、签名、digest 和既有结构校验不变。此检查只证明来源路径属于用户字段，不证明模型对用户原话的语义解释正确。此次两候选配对回放证实实际请求只改变四条来源规则的有无，但 V2 仍点题、V4 仍未呈现品尝就评价味道；来源边界修复不能等同于对白质量达标。见 `docs/full-story-dialogue-rules-ab-2026-09-14.md`。

**展开前体检（2026-09-16，路由验收通过后于 09-17 接入浏览器）**：`POST /api/full-story-precheck` 在
完整剧情展开之前跑一次体检——**原样调用**现有候选对照评审（只送选中的这一个候选，评审的提示词与
校验逐字未改），再加一档承诺核对（标题与一句话钩子许诺的东西，动作链有没有演出来），
两份结果**确定性**合成路由：评审派生的降级理由 ∪ 没兑现的承诺，非空就先修订候选、空就直接展开。
承诺核对是**两次顺序调用**：第一次看不到动作链、只凭标题与钩子写出观众必须看到什么；第二次拿这份
冻结的清单去动作链里逐条找，判 found 必须逐字引用该拍原文；verdict 由服务端按找到几条派生，
模型不写。命题定向修订新增可选的 `scope: "root"`（只送因果断裂、未兑现承诺、换皮环节与 BLOCKER 硬伤，
**不送未迁移机制**）与单候选评审报告入口；手动修订按钮的提示词与行为逐字不变，由测试锁定。
它只出报告：不签发 Artifact、不进 lineage、不 stale，与候选对照评审同规格。

**浏览器入口只有一个 `startFullStory`**：点「生成完整剧情」与选中命题后的自动生成都走它，
`generateFullStory` 保持**纯展开**——采纳之后的续跑、durable task 恢复都直接走它，
所以**改完不会再体检一次**。判直接展开就原样继续；判需修订就立刻出一份 `scope: "root"` 修订稿
**并排展示、什么都不签发**，用户点「采纳修订并展开」才签发新的 themeVariants 版本再展开，
也可以「按原候选展开」。**体检失败不静默跳过**：如实显示原因，给「重试体检」与「按原候选展开」。
采纳的语义（过期复核、下游征求同意、递归 stale、作废旧报告）与评审面板**共用**
`adoptThemeVariantsRevision` 一份，测试锁住两个入口都不许自己写 commit。
**已判直接展开、命题又一字未变时不重复体检**（`precheckPassStillValid`）：展开失败后再点生成直接展开，
候选一变（采纳修订、换一批）或页面刷新才重新体检——再跑一次没有新信息，只是重掷骰子、白付一次钱。

**体检面板只属于一个命题（2026-10-05 修复）**：此前切换命题时面板原样留着，修订返回时也不核对当前命题；在 V2 拿到修订稿后切到已有剧情的 V1，点「采纳修订并展开」会签发 V2 的修订、再为 V1 付费展开。现在面板渲染时记下所属命题，`renderStoryPage` 只在那个命题页上显示它（切走只隐藏、不丢状态，回来仍能看到已付费的修订稿）；三个按钮先核对面板归属（按面板而非体检状态判断——体检失败时状态已清空，失败面板上的「重试」「按原候选展开」仍只属于原命题），不符即作废、不签发也不展开；签发期间切走则修订照常生效、但不替用户展开另一个命题。导演助手读的体检状态（`fullStoryPrecheckState` / `fullStoryPrecheckFailure`）按命题 id 取，不受面板显隐影响。另：换工作区时 `clearVideoWorkspaceUi` 此前不复位 `storyPrecheckRunning`，而体检流程看到 epoch 已变会直接返回，「生成完整剧情」从此静默失效；现在一并复位并清掉旧面板。

**三版的实测轨迹，三条都不要重做**：①单次调用的承诺核对被证伪——同一个标题在两个候选上写出
**相反**的期待（一边「多次往返」一边「同时携带」），因为期待是照着动作链倒推的；
②拆成两次调用后旧版运书 0/2 → 2/2，但合格基线 r2 误报一次（盲写从「滑稽的方式」派生出
「面部夸张用力的表情」这类只有表演才能决定的细节）；③只把盲写那一步的尺度从「观众必须看到什么」
收紧为「这条承诺不落空的最低要求」，三个样本各 2/2 达到事前登记的通过线。

**它不保证判得对。** 承诺清单写得准不准、定位读得对不对都需要语义判断，闸门只查摘句是不是真的
来自标题或钩子、每一项有没有逐条回答、判 found 有没有逐字引用。**尺度这件事只是在三个样本上
校准过**，随时可能在别的标题上复现。

**评审那一路的可靠性是体检可用率的上限**：2026-09-17 的六次里有两次整次失败，两次都失败在
**未改动的现有评审**上（`evidenceRefs` 超过 2 条 / 元素不是字符串），失败时没有任何路由判定。
同一天《追风》的换皮分在 65 与 85 之间跳（阈值 70），直接决定换皮信号会不会被送进修订——
**不得为此调阈值**（§2.12b ⑨）。
完整数据、逐条判定与已排除的做法见 `docs/full-story-precheck-ab-2026-09-16.md` 与
`docs/待解决项.md` 第 1b 条。

对白范围补充：`keyDialogueDirections` 是候选期台词草案，不再进入 FullStory 输入；候选 `storyOutline` 的全部动作与原 Artifact 保持不变。FullStory 按动作、人物已知信息与用户明确对白限制生成交流，已签发 FullStory 台词仍由 Animation Plan 逐字承接。检查说话动机和信息前提，不禁止所有自然亲密反应，也不靠关键词判断自然度。实际 B4 仍出现结尾点题与未尝先评价味道，属于未通过的质量验收；不能因签发成功称为合格产品。


## 已删除的功能（2026-10-11）

用户 2026-10-11 决定：**不再支持旧 2.0（v2 首尾帧，`startFrame`/`endFrame`）与 3.0（`direct_shot`，`promptSchemaVersion: "3.0"`）Animation Plan**，只保留 4.0 自主分镜。**下列功能都已删除，不得重新引入**；真有需要，先拿出新的失败数据并取得明确的架构决定。

**遇到旧 Plan 时**（判定只有一份：`public/storyboard-plan.js` 的 `legacyAnimationPlanVersion()` / `legacyAnimationPlanMessage()` / `ANIMATION_PLAN_VERSION_UNSUPPORTED`，不得另写判定）：

| 位置 | 行为 |
| --- | --- |
| 生成（`createAnimationPlanWithMetadata`） | 只接受 `animationPlanVersion: "4.0"`，缺省或其他值 `InputError`（HTTP 400） |
| 契约（`ensureOutputContract(_, "animationPlan")`） | 非 4.0 抛 `OutputContractError`。这是函数级契约，目前没有生产调用者（4.0 生成直接用 `ensureStoryboardPlan`），线上生效的拦截是本表的生成、服务端消费与提交口 |
| 服务端消费（镜头视频、单镜提示词、角色参考精修与出图、一句话修改的改分镜与改单镜提示词等读 Plan 的任务与路由） | HTTP 409 |
| 通用提交口 `/api/production/artifact/commit` | 拒收非 4.0 的 `animationPlan`，也拒收新的 `shotFrame:*` 产物 |
| 测试包 | `sealPackage` 拒绝封装；`validatePackage` 在建 Run 之前拒绝导入（`ProductionStateError` 400） |
| 页面 | 显示「这是旧版 X 分镜，已不再支持（只支持 4.0 自主分镜）。请重新生成分镜。」与「重新生成分镜」按钮；旧 Run 的 `shotFrame:*` 留在磁盘、不再读取 |

错误码：参考视频 Run 的生成、契约、服务端消费、提交口拒收旧 `animationPlan`、3.0 测试包的封装与导入，都是 `ANIMATION_PLAN_VERSION_UNSUPPORTED`。三处例外：剧情 Run 生成分镜时版本不是 4.0，先被剧情入口拦下（400 `STORY_ENTRY_PLAN_VERSION_UNSUPPORTED`）；剧情 Run 的 3.1 测试包里分镜不是 4.0（400 `PRODUCTION_PACKAGE_PLAN_VARIANT_MISMATCH`）；提交新的 `shotFrame:*` 产物（400 `SHOT_FRAME_ARTIFACT_UNSUPPORTED`）。不迁移、不自动升级，也不当成 4.0 读取。旧任务记录照常读出；创建已删除类型的任务得到 `TASK_KIND_UNSUPPORTED`，请求已删除的路由得到未知路由的 404。

**删除的模块与能力**：

- 三个弃置编译器：Character Feature Compiler、Static Frame Compiler（含 Grounding）、本地 Prompt Compiler，以及它们的配置（`STATIC_FRAME_COMPILER_*`）、模型阶段 `staticFrameCompiler` 与页面。
- 首尾帧：`first_last_frame` 视频模式、首尾帧出图（`/api/generate-shot-frame-image`、任务 `shotFrameImage`）。
- 只支持首尾帧的可灵（Kling v3、v2.1）与自定义 VideoHTTP 视频供应商；镜头视频只剩 Seedance 2.0 与 MiniMax H3。
- 3.0 生成链：Foundation 与镜头批次生成、逐镜语义审计与修复、台词补写、Foundation 局部纠错（`artifact_partial_repair/1.0`）。
- 3.0 终审与定向修订（`/api/animation-plan-review`、`/api/animation-plan-revision`）、批量视频（任务 `shotVideoBatch`）、方言改写（`/api/animation-plan/video-prompts/rewrite`、任务 `animationPromptRewrite`，含 `minimax_h3` 退役 Profile 与 Plan 级 `videoPromptProfile`）。
- 负面词体系（逐镜 `negativePrompts`）与 `character-reference-sync`（设为人物参考图后改写镜头提示词）。

**升级注意**：`.env` 里 `SHOT_VIDEO_PROVIDER` 还写着 `Kling` / `VideoHTTP`，或者还配着 `VIDEO_HTTP_CONFIG` 时，服务启动明确失败（与 `DEFAULT_LLM_PROVIDER` 指定的那家没配置时同规格，不悄悄改用 Seedance），报错写明「可灵（Kling）与自定义 VideoHTTP 已于 2026-10-11 删除，请把 .env 里的 SHOT_VIDEO_PROVIDER 改成 Seedance 或 MiniMax」；`VIDEO_HTTP_CONFIG` 原来会被 worker 合并进 Seedance / MiniMax 的请求体，所以同样不得悄悄忽略（`src/shot-video-providers.js` 的 `assertNoRemovedVideoHttpConfig`，启动与 worker 各查一次）。

历史设计与实测记录在带「历史文档」横幅的 `docs/animation-plan-source-of-truth.md`、`docs/animation-plan-review-落地方案.md`、`docs/animation-plan-revision-实施计划.md`、`docs/Character-Feature-Static-Frame-Compiler-改造说明-2026-07-29.md`、`docs/negative-prompt-refactor-examples.md` 等文件里，只作历史参考。

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
Full Story（浏览器请求 full_story/1.2；1.1 与无版本旧格式照常读取）
 ↓
Animation Plan 4.0 自主分镜
 ↓
角色参考图 → 单镜提示词 → Video Generation（全能参考）

「从剧情开始」的 Run（2026-10-09）走另一条前段，后段复用上面的 4.0 分镜、角色参考图、单镜提示词与视频生成：

storySource（用户原文或只有角色设定）
 ↓
Visual Guardrails（只看固定角色设定，sourceDigest 第 2 版）
 ↓
粘贴完整故事：按原文拆出可翻拍镜头 fullStory:V1（full_story/1.2，没有候选，V1 是故事位）
只给角色设定：单个故事候选（themeVariants，恰好一个，id = V1）→ 服务端签发 variant:V1 → Full Story full_story/1.2
 ↓
Animation Plan 4.0 → Video Generation

上述业务 JSON 之外，Production Lineage v1 作为服务端 sidecar 运行：每次浏览器主流程创建独立 project/run；各成功阶段提交 Artifact revision、content digest、实际上游 dependencies、Stage 状态与 Checkpoint。它不改变模型字段含义，也不是第二份角色或剧情事实来源。

**Durable Task v1（2026-09-01）**：浏览器主流程不再持有长 provider workflow 或提交模型 Artifact。服务端把 AI 导演表示为一个 `directorPipeline` 父任务和 Analyze、Reconstruct、Brief、Visual Guardrails、Variants 五个顺序子任务；Full Story、Animation Plan、人物精修、角色图片、单镜提示词 shotVideoPrompt 和 shotVideo 也由同一 Task Manager 执行、校验并 commit。Task Store 位于每个 Run 的私有 `tasks/index.json`，只保存执行状态、冻结 lineage refs、创建时的 provider/model（镜头视频另记这次用的分辨率，2026-10-10）、progress、usage、结果 Artifact refs 和脱敏错误；禁止保存 Prompt、Data URL、Base64、完整请求体或第二份业务内容。ProductionStateStore 的 current Artifact 仍是唯一业务权威。

Task 状态只有 `queued | running | completed | failed | conflicted | interrupted | abandoned | cancelled`。`conflicted` 只由 provider 前/后或 commit 前冻结 revision/digest 变化以及 `ARTIFACT_REVISION_CONFLICT` / `ARTIFACT_DEPENDENCY_STALE` 产生；冻结后绝不自动刷新成新 current 内容。**目标的期望版本是 `latest` 指向的那一版、不论是否已 stale**——与状态库提交门 `commitArtifactUnlocked`、完整剧情展开前复核和浏览器同一口径，Task Manager 的创建冻结、调用前复检与锁内提交前复检三处共用 `targetLatestRevision()`；运行中目标被上游弄 stale 由冻结依赖复检拦截。2026-09-18 之前 stale 目标被冻结成 `null`，任何已失效目标经 Durable Task 重新生成都必然冲突（完整剧情在调模型前被拒，其余阶段在调用做完、提交时被拒），实际路径是采纳展开前体检的候选修订后再展开，详见 `docs/production-lineage-state.md` §4。所有写目标在创建时原子 claim，`directorPipeline` 一次 claim 五个目标；未 claim 的既有浏览器快速提交和 import 保持可用，有 claim 时只允许 active owner/child commit。相同 operation 复用 taskId，同目标不同 operation 返回 `TASK_TARGET_BUSY`；release/watchdog/restart 后迟到 Runner 不能回写。`abandoned` 和 `cancelled` 都不是远端取消，远端调用仍可能计费。

Durable Task 没有总墙钟 deadline。provider 调用的无进展 watchdog 使用该 provider 自身 request/poll timeout + 120 秒（流式的 Qwen/MiMo 没有总时长，这里的 timeout 是空闲超时，默认 120 秒），本地校验/合并/commit 使用 300 秒，并在 provider 返回、图片流事件、候选和阶段进展时续期。workflow/text 池为 2 running / 8 queued，media 池为 4 running / 8 queued，全局 queued 请求体预算默认 140MB；超过容量返回 `TASK_CAPACITY_EXCEEDED`，不伪造失败 Task。

**状态文件原子写入在 Windows 上要重试（2026-10-05）**：`tasks/index.json` 与 `manifest.json` 都是写临时文件再 `rename` 覆盖。Windows 上覆盖一个正被并发读取（不加锁的 Task GET、lineage 读取）或被杀毒扫描的文件会偶发 `EPERM`，此前直接失败且留下孤儿 `.tmp`。现在两处都走 `src/atomic-file.js` 的 `replaceFile`：只在 win32 对 `EPERM/EACCES/EBUSY` 退避重试（合计约 2.3 秒），最终仍失败时删掉临时文件、原样抛出原错误——仍是 fail closed。证据：当时那台 Windows 机器的 runtime 下 8 个孤儿 `.tmp`（09-05～09-06），其中 2 次是「强制释放」的 manifest 写入，释放没生效、任务照跑照计费。浏览器工作区 `session.json` 是同一写法，但目录随清理删除、无从取证，未改。

**AI 导演 Run 控制（2026-09-10）**：`directorPipeline` 根任务支持既有 `/api/tasks/:id/control` 的 `pause | resume | terminate`。暂停先写 `progress.controlState=pausing` 阻止新调用与提交，再在 Run 锁外 abort 当前 Qwen/MiMo/DeepSeek HTTP/SSE 连接；当前子任务以 `interrupted/DIRECTOR_STAGE_PAUSED` 收尾后父任务进入 `paused`，不释放五个 claims、不自动重调、不新增 Task status。未派发的 queued 父任务可直接 paused；已运行的暂停父任务保留当前进程输入和 workflow 槽位，暂停期间不计 watchdog。继续复用父 taskId 与创建时输入/模型，新子 taskId/requestId 重新执行首个未完成阶段，已签发 current 阶段保持 revision/digest。中断前那次请求可能已经计费，继续可能再次计费，禁止称为供应商原请求续传。终止写 `terminating`、断开当前连接，父子 active 任务最终 `cancelled` 并释放 claims，保留 Run 和已完成 Artifact；不得宣称远端计算或计费已确认停止。control 的 controller/gate 必须在锁内捕获后锁外操作，防止连续 pause/resume 误伤新请求或遗失唤醒。页面清理撤销任务后也须在锁外唤醒暂停 Runner，不能遗留池槽位。刷新恢复 paused；Node 重启仍按 v1 变 interrupted，不自动调模型。用量只计供应商实际返回的结构化 usage，`calls` 在 fetch 派发点计数，`reportedCalls/unreportedCalls/usageComplete` 明确标识未知；父任务按所有子尝试汇总，不能覆盖成最后一次继续的用量或重复累加。

**完整剧情任务控制（2026-09-10）**：`fullStory` 根任务通过同一 control 接口支持暂停、继续和终止，页面沿用 AI 导演的左终止、右暂停/继续按钮与 44px 点击区、32px 悬停背景。暂停中断当前 HTTP/SSE，保留创建时输入、模型、全部冻结依赖、目标 expected revision 和 claim；继续保持同一 taskId，以新的 requestId 重新执行整个 Full Story operation（新版包含初轮与实际必要的有界修复；旧格式还包含 Beat–Scene postpass），不是续传或只重做 postpass。各次尝试的已知 usage 和未返回用量的实际调用累计保留；旧尝试的迟到回调不得写入新尝试。终止保留此前已签发 Story、Plan、媒体和 Run。commit 与 control 由同一 Run 锁裁决：本次 request 已提交成功时，控制不再改变执行状态，也不重调模型。刷新重新 attach paused，不自动继续；Node 重启仍按 v1 interrupted/reconciliation 规则。页面控制必须绑定当前候选的 root Full Story task，切换候选不能控制另一个候选或被其迟到响应切回。

per-Run Coordinator 是显式不可重入 FIFO 锁。持锁代码只能调用 `commitArtifactUnlocked`、`recordStageUnlocked`、`loadRunUnlocked` 和 Task Store unlocked 方法，禁止从锁内调用公开的 `commitArtifact()` / `recordStage()` / `loadRun()`；临界区内禁止 provider、网络、FFmpeg 或模型校验。`readCurrentLineageSnapshot`、Task GET 和 atomic manifest snapshot 的 `loadRun` 必须锁外读取；provider 返回后仍保留复检与锁内 commit guard。

刷新/HTTP 断线只移除等待者，Runner 在同一 Node 进程继续。Node 重启时，大型请求体和 provider 执行上下文没有持久化：已由同 requestId 成功提交的任务可 reconciliation 为 completed，其余 queued/running 必须标 `interrupted` 并释放 claim，绝不自动重调 provider。继续 Analyze/Reconstruct/Visual Guardrails 时必须重新上传 SHA-256 与 Run metadata 中 `sourceVideoDigest` 相同的原文件；Brief/Variants 可直接复用 current 上游。T04 quarantine、T05 provider task-id 接管/重启恢复、lease 和正式跨进程 batch queue 仍未实现，禁止把 Durable Task v1 描述成完成了它们。

Variant 内容变化必须递归使旧 Full Story、Animation Plan 和媒体 Artifact stale。模型请求开始时冻结依赖 revision，返回时同时经过浏览器 request token 与服务端 `expectedCurrentRevision`/dependency 校验。Animation Plan 每个 revision 签发独立 media namespace。

`themeVariants` 保留原 wire shape 和 Artifact 名称，但 `variants[]` 已升级为递归 `additionalProperties:false` 的严格 Story Candidates。原有字段保留，只新增五个必填非空候选级字段：`keyChoice`、`climax`、`emotionalPayoff`、`novelty`、`visualPotential`；禁止在此阶段增加 Full Story、`characterBible`、`sceneScript`、`shotPlan` 或镜头级数据。确定性校验只负责严格字段、非空数组、唯一 id、Beat 连续编号与必填内容、固定主角，以及**任意两个**候选的 `dramaticFunction` 序列 + `keyChoice` + `climax` + `emotionalPayoff` 签名都不同。禁止用老人、下雨、礼物等题材关键词判断分化，禁止本地代码裁决选择是否有意义或情绪是否成立。

**可选叙事构件（2026-08-28）**：`characterSetup.careRecipient`、`characterSetup.helper`、`emotionalMedium`、`endingRitual` 是**可选键**，不是必填位。此前它们全部 required，等于强制每个候选长成「主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾」，与本阶段要求的候选间根本差异直接矛盾——模板由容器签发，模型无法绕开。现在：写了就仍必须是非空字符串，不需要就整个键省略，**禁止输出空字符串或占位文本**。`characterSetup.protagonist` 仍必填，固定角色锁定语义逐字不变。Prompt 另加一条批次约束：`count` 个候选里最多 2 个可以同时写出 `careRecipient` 与 `helper`；该约束只在 Prompt 层，没有确定性校验。

**`newTask` / `environmentPressure` 一直是必填（2026-09-23）**：与上面四个可选构件不同，这两个字段在 schema 里始终是 `nonEmptyString`。但 `variantsPrompt` 曾把「任务」「天气/空间」也列进「可以更换，也可以整个不设」，slice_of_life 那条又写「没有非做不可的任务」，而全文没有一句定义这两个字段——提示词与契约自相矛盾。实测 MiMo（`mimo-v2.6-pro` 开思考）照字面执行，4 个候选里 3 个 `newTask:""` 被 `STORY_CANDIDATES_SCHEMA_EMPTY_STRING` 拦下；千问一直能过，是因为它自己写成「参与……」「无明确任务，参与……」绕开了矛盾。现已把这两项移出可选清单，并在字段说明里给出定义：`newTask` 写主角做的或参与的那件事（生活型写她参与了什么，不需要是非完成不可的任务），`environmentPressure` 写推动或限制这件事的环境条件（没有外部压力时写当时的时间、天气或空间状态）；命题定向修订提示词同一口径。**契约、schema、消费者均未改**；这是提示词约束，没有新增确定性兜底，空字符串仍由既有 schema 拦截。

**角色与道具边界（2026-09-09）**：候选 `characterSetup.careRecipient/helper` 与 Full Story `characterBible` 只登记人物、动物或候选正文已经明确设定的拟人角色，不要求会说话或主动发起行动。普通植物、物件被照料、保护或承载情感不构成角色身份；候选保留其动作与用途，Full Story 保留到 `keyProps`、`visibleAction` 与必要摄影说明，不填入角色表或 `characters`。旧候选的功能标签不能把普通物件升级成角色，也不得为满足登记新增拟人行为或删掉照料动作。起因是《迷路的蒲公英》候选没有 `careRecipient`，Full Story 却把蒲公英同时写成道具和被照料角色，连续触发角色出镜名单冲突。候选未登记 `careRecipient` 时，本次 Full Story 提示词不再展示其五字段模板，并在开头明确角色表只输出 `protagonist/helpers`；正文已有的其他跨场角色仍须登记到 `helpers`。这是生成说明，不是对输出的自动删字段。分类通过提示词约束，不新增物种词表、自动删字段或失败重写；既有 Scene Contract、Schema、签发与旧 Artifact 均保持原语义。

**两条叙事路径（2026-09-02）**：候选新增必填枚举 `narrativeMode`，取值 `dramatic` | `slice_of_life`。契约此前把戏剧结构写成无条件硬要求（施动性至少 3 拍是发起者、末拍必须有可引用的承诺、必须设计被拖住的问句、质感 Beat 仍须改变状态），而**参考片基本不靠戏剧结构留人**：逐支拆解 debug 里留存的四支重构记录，《打枣》的转折是「戴锅防砸」这种解决眼前小麻烦，《帮奶奶捐旧衣服》的转折是别人给的小红花，《晨练》是别人来救，《好朋友为你遮风挡雨》的主角**从第 3 场起一直睡到片尾**——几乎没有一个转折来自主角的主动决定。第一条约束就把后者判成不合格。我们建了一台制造戏剧结构的机器，而用户参考的片子不靠戏剧结构；观众感到的「刻意」正是这套约束在起作用。一个反证支持该判断：用户两次独立选片都选了结尾「生活多了一点东西」的候选（村民挂起秋千、奶奶把画贴冰箱上），而不是任务完成型的。

那四条硬约束因此加上「**仅 dramatic 适用**」限定，并为 `slice_of_life` 写对应三条：①主角不必是发起者，可以在反应、参与甚至旁观，但每一拍仍要有可见身体动作；②高潮拍写一个**具体的小办法或小意外**，量级参照戴锅防砸，不需要艰难抉择；③最后一拍写**一起完成之后的日常时刻**，不需要承诺、不需要总结。`keyChoiceBeat`/`climaxBeat` 语义随路径调整（生活型指向「决定参与或想到那个小办法」与「小办法起作用」），但派生机制逐字不变。两条路径**同样遵守**拍号绑定与派生、结构分化、可见事实字段规则、对白质量、生活质感与萌点约束、固定角色边界——放开的只有「必须有戏」这一层。

分布要求有确定性校验（数枚举值是纯算术，不含语义判断）：`validateVariantNarrativeModeMix()` 与 `validateVariantStructuralDivergence` 并列在 `ensureThemeVariantsMatchProfile` 里，`count >= 4` 时至少 2 个 `slice_of_life`，`count < 4` 时至少 1 个，诊断码 `STORY_CANDIDATE_NARRATIVE_MODE_MIX`。**校验只能数自报标签的个数，无法核实一个候选真的是生活片段**——那需要语义判断，是本方案已知的最大弱点，只能靠真实回放与人工评分观察，**不得靠加词表补救**。`narrativeMode` **不进入 Full Story 提示词**：它是候选期的创作路径声明，展开阶段只承接选中候选实际写出的内容。候选卡在「相似风险」旁展示**剧情型 / 生活型**徽章供用户按口味挑选。

**结构自由度（2026-08-28）**：`storyOutline` 由「恰好 6 拍 + 固定相位词表『钩子、障碍、关键选择、后果、高潮、兑现』+ `keyChoice`/`climax`/`emotionalPayoff` 钉死在 Beat 3/5/6」改为 5–7 拍、`phase` 由候选自己命名（**禁止**套用那套固定词表，也不得全组共用同一串 `phase`）。关键选择拍与高潮拍落在第几拍由候选自己的因果结构决定，只保留因果序约束：关键选择拍 < 高潮拍 < 最后一拍。Prompt 另要求两拍之间隔一拍写该选择的直接后果、且高潮拍不得首次引入决定性人物、物品、地点、线索或能力，这两条只作生成约束，不由校验器硬裁。拍数本身即为一种合法的结构分化。**关键拍号与服务端派生投影（2026-08-28，取代逐字投影校验）**：`keyChoice` / `climax` / `emotionalPayoff` **由服务端从 `storyOutline` 确定性派生**，模型只输出两个整数拍号 `keyChoiceBeat` / `climaxBeat`；`emotionalPayoff` 恒取最后一拍，不需要拍号。模型回显这三个字符串时**一律无条件覆盖**——能从上游唯一推导的值，回显不构成新事实。

此前要求模型自己在一份两万字符的 JSON 的两个远距离位置逐字重复同一个长句，实测不可靠：debug 侧车记录的真实调用中合规率两极分布（多次 0/12），加强措辞后仍出现 2/12 与 9/12 两次硬失败。失败模式是模型在**改写**而非复制——砍掉前置准备再把主语补回句首，让顶层成为能独立成句的摘要；而「顶层不得含准备」恰恰是 Prompt 自己的要求，两条规则互相冲突，调措辞救不了。派生把这类失败整类消除，同时让前置准备、时间标记可以自然留在拍内。

校验只裁决可唯一推导的部分：拍号必须是整数且在 `storyOutline` 范围内，且「关键选择拍 < 高潮拍」（**「高潮拍必须早于最后一拍」已移除**——它规定的是故事形状不是一致性，两者相同只让两个字段取到同一句话，是冗余不是矛盾）。「两拍之间隔一拍写后果」仍只留在 Prompt。签发时派生，入站复核只核对字符串与拍号一致（**不重新派生**——那会改变 content digest，破坏 `variant:<id>` 的 lineage 绑定）。诊断码：`STORY_CANDIDATE_BEAT_INDEX_INVALID` / `..._OUT_OF_RANGE` / `STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER` / `STORY_CANDIDATE_PROJECTION_NOT_DERIVED`。

这条约束 Prompt 一直就写着，但此前**没有校验器**。放开固定拍号（原 Beat 3/5/6）后实测合规率从 60/60 掉到 31/48，某些上游甚至 0/12——顶层写压缩摘要、`storyOutline` 写另一件事，同一个候选出现两版剧情，下游 Full Story 无从判断哪个是事实。它是阻止候选内部多版本事实的唯一机制，因此补成确定性硬失败。

**剧情时长目标进入候选阶段（2026-09-05）**：`storyOutline[].estimatedSeconds` 的合计**事实上决定成片长度**——Full Story 照它排 `sceneScript` 时间轴，当时的 3.0 分镜再按时间轴派生镜头。该字段本身没有代码消费者、没有校验器（strict schema 只有 `{ "type": "number" }`），唯一影响路径是随 `JSON.stringify(variant)` 整体注入 Full Story 提示词。此前候选阶段完全收不到用户选的时长目标（浏览器请求体、Durable `buildInput` 白名单、`variantsPrompt` 三处都没有），模型只能凭空估。实测代价：目标 65 秒，候选估成 12/15/18/15/20/15 = 95 秒，Full Story 六场 `timeRange` 跨度逐位照抄，成片 95 秒、镜头数翻倍——当时 `fullStoryPrompt` 同时写着「忠实承接 Variant 实际写出的内容」与「合计必须落在 55-75 秒内」，两条都是硬约束且未定义优先级，模型选了承接上游。这是提示词自相矛盾，不是模型没打准。

修复三处缺一不可：`targetDurationSeconds` 传进 `/api/variants`（含 `server.js` 入口的 20–180 整数校验与 Durable `buildInput` 白名单——白名单是显式构造，漏掉会让任务队列路径静默丢字段）；`variantsPrompt` 要求合计落在窗口内并说明它决定成片长度；`fullStoryPrompt` 声明冲突优先级：**`estimatedSeconds` 不属于必须逐字承接的剧情内容**，`timeRange` 服从时长目标，允许按比例调整每拍长度但不得增删、合并、拆分或改写剧情动作。窗口比例（±15%）与取整方向只有一份，在 `public/story-duration.js` 的 `storyDurationWindow()`，两处提示词与变体卡片判色共用，禁止各自再写 `0.85` / `1.15`。**不加校验器**（与 Full Story 同规格：模型不听提示词是生成质量问题）；变体卡片的合计时长徽章是纯展示，不进 Artifact、不参与派生、不 stale 任何东西；不传目标时 `variantsPrompt` 与 `mockVariants` 逐字保持历史行为。已签发的旧候选 `estimatedSeconds` 不变，只能靠优先级声明兜底，同样没有确定性兜底。

**那三处实际只做了两处，2026-09-09 修好（证据来自六份真实导出包）**：白名单读的是 `raw.targetDurationSeconds`，而浏览器送进 `directorPipeline` 的 `shared` 输入里**从来没有这个键**——一键 AI 导演的候选阶段因此从未收到过时长目标，只有手动点「换一批」那条路送到了，现象是「换一批有效、一键跑无效」。`variantsPrompt` 取不到目标时 `durationRule` 整段省略，**静默降级、没有任何报错**。实测：五个带 lineage 的 run 全部生成于 09-05 之后，候选 `estimatedSeconds` 合计 **20/20 落在窗口外**（原片 33 秒的写成 56-60 秒、原片 122 秒的写成 60-90 秒）；唯一 4/4 落在窗口内的那份没有 lineage、导出形状也不同，四个候选精确等于窗口下界——像是拿到指令后贴着下界写（路径不同是推断，未核实）。修复是 `public/app.js` 的 `runWorkflow()` 补上这个键，`test/story-duration.test.js` 用源码断言锁住三处调用点，撤掉修复即失败。三处都是对象字面量，漏掉任何一处都不会有运行时错误，只能靠测试守着。

**同一批数据修正了上一段的一处措辞**：那句「候选 `estimatedSeconds` 的合计**事实上决定成片长度**」描述的是 ③ 落地**之前**的行为。③ 生效后 Full Story 服从时长目标——六份包里成片跨度 **6/6 精确等于 `Math.round(原片时长)`**（65/122/44/44/65/33），候选估的 46–90 秒被整体忽略。所以合计不再决定成片长度，但它**决定同一批动作要被塞进多长的时间**：60 秒大纲压进 33 秒、或摊到 122 秒，都是同一份动作链换了密度。压缩那一侧正是 `docs/待解决项.md` 第 1 条「单场动作过载」的上游（旧 3.0 时镜头时长由场次 `timeRange` 锁死、定向修订救不了它；4.0 下是否仍存在见该条）。**这仍然不构成加校验器的理由**，与下一段一致：模型不听提示词是生成质量问题。

每个 Candidate 必须有一个主要承担角色性格或人物关系质感的 Beat，但它仍必须改变关系、情绪、信息或后续选择条件；删除后必须损失角色弧、关系推进、情绪积累或后续因果之一。禁止恢复「完全不推进主线、删除后故事仍完整」的旧 Prompt 规则。

用户明确选择后，完整 Candidate 作为 `variant:<id>` Artifact 签发。`POST /api/full-story` 必须同时绑定该 Artifact 的精确 `artifactId/revision/contentDigest`；服务端在调用 Full Story 模型前后都必须复验 current Candidate、请求副本 digest、running target/request 和 target revision，并用落盘 Candidate 替换客户端副本。`candidateBinding` 只是请求 sidecar，不进入 Prompt、Legacy Full Story wire shape 或 Artifact。同 id 任意内容变化都必须换 digest/revision 并使旧下游 stale。

状态恢复时，current Full Story 或 Animation Plan 可恢复其 `selectedVariantId`；没有下游时，只有 current `variant:<id>` 明确选择记录才能恢复。仅有 `themeVariants` 时 `selectedVariantId` 必须保持 `null`，禁止默认回退到 V1。离线质量基线只记录固定 fixture、九项人工评测维度、真实 token usage 和确定性 validation failure；不调用外部模型，不伪造主观分数。当前没有 Story Selection/Blueprint/Script Doctor/Production Package 4.0，也没有自动的 Targeted Rewrite——一句话修改（2026-10-11）是用户在导演助手里提出、看过修改稿点「采纳」才签发的局部修改，不是自动改写；Phase 2 只预留「已签发 Candidate 内容 + 精确 lineage reference」输入接缝。

**Animation Plan 只支持 4.0 自主分镜**（`STORYBOARD_PLAN_VERSION = "4.0"`，`src/storyboard-*.js`；旧 2.0/3.0 见「已删除的功能（2026-10-11）」）。请求必须带 `animationPlanVersion: "4.0"`，缺省或其他值在调用模型前 `InputError`（400，`code: ANIMATION_PLAN_VERSION_UNSUPPORTED`；剧情 Run 先被剧情入口拦下，400 `STORY_ENTRY_PLAN_VERSION_UNSUPPORTED`），`animationPlanMode` 不再读取；输出 `promptSchemaVersion: "4.0"`、`productionStrategy.format: "storyboard_video"`。输入是完整 Full Story、角色事实、画幅、时长窗口、赛道风格与画风/配乐/表情参数，完整上游照常冻结与验签，但不进分镜创作提示词；旧剧情缺配角事实时只为本次 Plan 整理一次（`storyboardCharacterFacts`），不改写、不重签 Full Story。模型自定片段与时间，可合并相邻场次；每段整数 4–15 秒（数字只有一份，在 `src/shot-duration-limits.js`，提示词与校验共用），总长落在共享时长窗口内。步骤是设计分镜 → 审阅分镜 → 按问题修订（审阅报出问题时）→ 终审复查（修订实际改动时），每步走 coordinator、最多 2 次 provider 调用（带诊断重试一次，不发回失败输出），禁止第三次；两次都被拦时两次诊断都在（`storyboardPipelineFailure`），`metadata.storyboard` 如实上报调用次数与被拦诊断。审阅的语义意见不阻断；字段、时间、引用、角色与签名仍严格。服务端签发 `shotId`（`A01`…连续编号）、`productionStrategy` 的全部字段（模型写不到）与 `characterReferencePrompts`，签发前由 `ensureStoryboardPlan` 全量校验。Plan 不含 `videoPrompt`：点某一镜的生成按钮才创建 `shotVideoPrompt` Durable Task，签发 `shotVideoPrompt:<variantId>:<shotId>`（依赖 current Plan，绑定 Plan digest 与视频/写稿模型配置，Task Store 不保存提示词正文）；单镜提示词的确定性校验在 `shotVideoPromptViolations` 一份——结构只能是非空 `videoPrompt`、每句对白逐字出现（`SHOT_PROMPT_DIALOGUE_MISSING`）、关闭配乐时逐字收尾、签发了画风时逐字写出（`SHOT_PROMPT_ART_STYLE_MISSING`）、出镜角色登记名原样写出（`SHOT_PROMPT_CHARACTER_NAME_MISSING`）、不写素材编号（`SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN`），后两条见下文「单镜视频提示词写法」。旧媒体接口需要的字符串（`characterAction` / `cameraMotion` / `dialogueOrSubtitle` 等）由 `storyboardShotForVideo()` 只读投影，不回写成第二份分镜。粘贴完整故事的 Run 锁定台词，分镜设计与修订都不得改动原文台词；用户在导演助手里的一句话修改除外：它可以改剧情与分镜里的台词，`storySource` 原文不动，改过的台词会出现在台词核对的「在原文里找不到」里（见上文「一句话修改」）。

镜头与场次标识不得混淆：`shotId`（常见 `A01`）是当前 Plan revision 内的业务镜头顺序，不能脱离 project/run/plan revision/digest 单独标识媒体；`shotPlan[].sourceSceneIds` 是本片段承接的 Full Story 剧情场次（可以是相邻的多场），不是场地；`beats[].sourceSceneIds` 必须包含在所属片段的 `sourceSceneIds` 里（`STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT`）；地点设计在 `visualDesign.locations[]`，4.0 没有 3.0 的 `sceneId`（`LOC01`）场景视觉参考组。每个剧情场次要么被某个片段承接，要么在 `adaptations` 里说明省略（`STORYBOARD_SCENE_NOT_CARRIED`）。

**Full Story 时间轴检查**：镜头骨架只作为 Full Story 签发前的时间轴检查保留——`validateFullStoryForSigning` 对新版 Full Story（1.1/1.2）调用 `deriveDirectShotSkeleton()`（`src/direct-shot-timeline.js`），只检查、不生成镜头，结果也不进 4.0 分镜。全部明确失败、禁止退回默认值、猜测或钳制：`timeRange` 不可解析、跨度非正、起点早于上一场终点、单场跨度低于供应商 4 秒下限时抛 `OutputContractError`，诊断码分别是 `DIRECT_SHOT_SCENE_TIME_RANGE_INVALID`、`..._OUT_OF_ORDER`、`..._DURATION_BELOW_PROVIDER_MINIMUM`；场次之间允许留白，只禁重叠与回退。`parseSceneTimeRangeSeconds` 与 `parseSceneTimeRangeBounds` 共用唯一一份正则，秒位接受 `0–99`——`00:60` 在 mm:ss 下只可能是 60 秒，与 `01:00` 完全等价，按 `m*60+s` 折算是确定性算术而非推断。项目层面没有 4–6 秒限制；4–15 秒是 Seedance 2.0 与 MiniMax H3 的能力交集，已有值不合法必须拒绝，不能钳制、补长或缩短。单场动作塞得太满的问题见 `docs/待解决项.md` 第 1 条。

`productionStrategy.backgroundMusicMode` 取值只有 `none` / `allowed`，默认 `none`，由服务端根据请求 `backgroundMusicEnabled` 签发，模型写不到。`none` 时每条单镜提示词必须以「全片无背景音乐，只保留现场环境声与动作声。」逐字收尾（`SHOT_PROMPT_BACKGROUND_MUSIC_SENTENCE`），两个视频供应商共用这条约束；`allowed` 时不施加。关闭的只是背景音乐而不是现场声，beats 的 `soundDesign` 照常写环境声、物理动作声与对白，且不做关键词禁用。运行时参考素材清单拼在提示词之前，所以禁配乐句仍是整条提示词的最后一句。已有 Plan 时拨动开关必须重新生成整个 Animation Plan，签发新 Plan revision 与 media namespace 并递归 stale 该变体全部媒体，页面必须先明确征求同意，拒绝时开关回弹且不改 Plan、不 stale 媒体。演示模式的单镜提示词按同一 `backgroundMusicMode` 逐字收尾，不得出现 mock 通过而 live 失败的偏差。

Animation Plan 的 `targetAspectRatio` 只允许 `9:16` 或 `16:9`，生成时锁入 `productionStrategy.targetAspectRatio`；不得给镜头增加逐镜 `aspectRatio`。浏览器把画幅控件放在「设定创作宇宙」面板（#animationAspectRatio），它只是新 Plan 的默认值（全局默认为 16:9）：写进 state.animationAspectRatioDefault，取值优先级为「该变体草稿 → 该变体已签发 Plan → 全局默认」；拨动它不触碰任何已签发 Plan，不签发 revision、不 stale 媒体。已生成的 Plan 卡片里画幅是纯展示，要换画幅只能重新生成 Plan。withAnimationPlanAspectRatio()（public/animation-plan-settings.js）与其单元测试有意保留，随时可重新接回 UI；一旦接回，「已有 Plan 就地切换画幅」必须不调用模型、不重写 shot，但签发新 Plan revision/media namespace 并使旧画幅媒体 stale。

### 角色画风（2026-10-09）

「设定创作宇宙」面板的 `#characterArtStyle`，接替原来「角色表情规则」那一栏。它是全片统一的画面风格，默认「二维日系动画」，下拉里有几个预设，也可以自己写，清空就是不指定。起因是 4.0 分镜此前没有任何画风：分镜里唯一的「风格」字段 `productionStrategy.visualStyle` 照抄垂直赛道，角色参考图提示词只认已删除的 3.0 才有的 `visualBible`，于是 4.0 出图完全不写画风，固定角色写「八岁女孩……」时出了写实照片，被 Seedance 2.0 当真人拒收（`docs/待解决项.md` 第 17 条）。

- **来源与签发**：页面在生成 4.0 分镜时把它作为请求字段 `artStyle` 发出；两条分镜输入链（视频 Run、剧情 Run）都透传，两个分镜路由都校验（只拦类型与 200 字上限）。服务端把它写进 `productionStrategy.artStyle`，模型写不到；空串表示这一份分镜没有指定画风。判定与默认值、预设、上限在 `public/character-art-style.js`，浏览器与服务端共用一份。
- **三个使用方，只在画风非空时出现**：分镜设计、审阅、修订（画风进入制作参数，设计提示词多一句「visualDesign 按这个画风写，不写成真人照片」）；单镜视频提示词（必须逐字写出画风，`SHOT_PROMPT_ART_STYLE_MISSING` 确定性校验，写漏触发既有的一次带诊断重试，演示模式同样遵守）；角色参考图提示词（「风格与色调」那一格写「画风：……」）。画风为空时三处提示词与之前逐字相同。
- **已签发的分镜保持签发时的画风**：改这一栏只影响下一次生成的分镜，不触碰已签发 Plan、不 stale 任何东西。画风之前签发的分镜没有 `artStyle` 键，照常通过 `ensureStoryboardPlan`、照常写单镜提示词。
- **不得并入 `creatorProfile`**（与原来的表情规则同一理由）：它不是角色身份事实，改它不该作废全局角色边界。浏览器使用独立的 localStorage key `directorCharacterArtStyle`。
- **分镜卡**：「画风」一格显示 `artStyle`；原来写着「风格」、其实显示垂直赛道的那一格改叫「赛道」。

### 单镜视频提示词写法（2026-10-12）

用户把影视飓风 AI 影像课第三、四节整理成了 ai-video-prompt skill，要求 4.0 单镜视频提示词按那套写法组织。当时唯一的真实 4.0 单镜提示词（run-60d27213 的 A04）已经写了画风、场景、分时段与无配乐收尾，差在三处：时段写成「【0秒—3秒】」，不区分切镜头与镜头不切换；没有逐个角色写画面位置与朝向（分镜的 `framing` 里其实写了站位）；多角色同框时用「她」「其」代称。

- **写法**（`shotPrompt`，`src/storyboard-prompts.js`）：开场写时段与光线、地点与环境、画面风格与色调 → 逐个 beat：第一个 beat 以「第0秒，」开头，不写切镜头或镜头不切换；之后分镜在这里换了机位或地点、景别或角度直接跳变，写「在第N秒的地方，切镜头，」；同一机位继续，或 `camera` 写的是从上一拍的构图直接开始的连续运镜（摇、移、推、拉、跟拍、拉开），写「第N秒起，镜头不切换，」（beat 是表演段落，不一定是剪辑点）；每个 beat 依次写镜头、站位（写这一 beat 开始时的样子，这一 beat 里才进画面或移动到位的角色先写从哪来、停在哪里留到动作里写；分镜写了位置的角色写画面位置；没写的只写名字和在做什么，不补位置、不补行进方向；「在前」「在后」「队尾」是先后，不是前景、后景；朝向只在分镜指明时写）、按 `visibleAction` 顺序的动作（每个动作点名是谁，多角色时不用代词，没动作的角色写明保持原位）、台词（中文双引号“”，画内/画外两种句式）、声音与声源位置 → 结束状态（`continuityOut`）→ 关闭配乐时的固定收尾句。
- **站位只照分镜写（同日回放后改过一次）**：第一版要求每个出镜角色都写画面位置与朝向，真实回放（run-60d27213，8 镜 × 2 次）里 16 份有 4 处站位与分镜矛盾——绕杆追逐中孩子朝右跑、鹅朝左「追」；同一镜两次写出相反的行进方向；横移跟拍里写「背对镜头」。旧写法只照抄分镜原话，没有这类问题。改成只写分镜写了的位置、不补位置和行进方向、「在前」「在后」照原话写先后之后，与分镜矛盾的为 0，分镜写了的位置照样写出；16 份里仍有 1 份补了分镜没写的左右方向。**不要为了让每个角色都有位置把这条改回去。**代价：写稿的输出 token 约为旧写法的 2.6 倍、耗时约 2.5 倍（中位数 25 秒 → 63 秒）。
- **与 skill 不同的三处是有意的**：①角色与参考图靠登记名对上——生成视频时页面按 beats 里的角色名挑角色参考图（`shotRelatedCharacterReferences`），服务端核对每张都是已签发 Plan 里的那张、按 Plan 写上角色名，并在提示词前面拼素材清单（`buildReferenceManifestText`）写明「参考图N 是「名字」的角色参考图」；写稿时不知道附几张、编号是几，所以不写 @图片N。服务端不核对这个角色在不在本镜 beats 里（这一行为早于本次改动）：绕过页面直接调接口，可以附上本镜没出场的角色的图，而判据不要求提示词写出这个名字；要不要在服务端加这道检查待定。②收尾沿用固定的无配乐句，不写 skill 的「不要生成音乐」。③镜头、效果与时长归分镜阶段管，写稿只翻译，不补新站位、新运镜、新效果。
- **两条新的确定性判据**（`shotVideoPromptViolations`，排在原有四条之后，已经不合格的提示词报出的第一条诊断不变）：`SHOT_PROMPT_CHARACTER_NAME_MISSING`——本片段全部 beat 的 `characters` 并集（`storyboardShotCharacterNames`，`public/storyboard-plan.js`；挑角色参考图的 `shotRelatedCharacterReferences` 直接调用它，测试锁住两边选出同一批人）每个名字都要原样写出，画外说话者不要求。已知缺口：画外说话者上传过参考声音时，页面与服务端照样附上（`shotRelatedCharacterAudioClips` 按 dialogue 的 speaker 判定），素材清单写明「「名字」在本镜确实会发声」，而提示词里不一定写出这个名字，这段声音靠视频模型自己对上台词，没有判据兜底；要不要把说话人也纳入必须写出的名字待定。`SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN`——写了 `@图片/@视频/@音频`、`参考图N`、`图片N`、`<Subject N>` 这类素材编号即拒，普通的「图片」「视频」不拒；台词原话、画风、出镜角色名本身含这种写法时（用户台词「快看图片 3！」），扫之前先把这些必须逐字写出的片段遮掉、只查其余文字，否则写进去被判素材编号、不写被判漏写，永远过不了（只遮本身含编号写法的片段，不含时扫描的文字不变）。「不生成尚未绑定的 @图片」原来只写在单镜提示词里（旧 3.0 合同里的同一条已随 3.0 删除），没有代码检查。
- **明确不做的确定性检查**：禁代词（会误伤「其他」「她们」，等于关键词表）、每个 beat 都点名、方位词和朝向词、切镜头的次数与位置、每拍都要写「第N秒」、长度上限。它们要么需要语义判断，要么只是表面代理，只留在提示词里（`docs/待解决项.md` 第 23 条）。
- **重试**：生成时一次报出全部问题；单镜写稿用自己的重试提示词 `shotPromptRetryPrompt`。原来共用的那份叫模型「调整片段怎么分、beat 怎么切」，与写稿不许改分镜正好冲突。预算仍是 2 次，禁止第三次。
- **一句话修改**：共用判据，所以改完同样不能让出镜角色从提示词里消失、不能写素材编号；它的提示词同步加了「角色名」保留项与两条「不能做」。旧规则写的提示词若没写出角色名，改之前那道检查会拒，并提示先重新生成这一镜的提示词。
- **缓存**：没有升 `SHOT_VIDEO_PROMPT_VERSION`（升了一句话修改会拒收全部旧提示词）。分镜和模型都没变时旧提示词照常复用，点「重新生成本镜提示词」才会按新写法重写。
- **演示模式**：演示写稿也过同一份判据（每个 beat 补一句「画面里：……」），测试替身把它当模型回复送回，演示与真实不会是两套标准。
- **没有确定性兜底**：站位和朝向写得对不对、切点写在哪（第三版回放 14 次明确切点全对，第二版错 1 次）、外观要点挑得对不对。「在第N秒的地方，切镜头」的写法来自课程在 TapNow + Seedance 2.0 Fast 上的演示；2026-10-12 在 Ark Seedance 2.0 上做过一次成片验证（A04、A05 新旧写法各 2 条，`reports/shot-prompt-film-check-2026-10-12/`）：切点 8/8 照做，但新旧写法成片差不多，人物从哪边出场、往哪边跑两边都乱——根因在分镜本身不写方向，见下一节。MiniMax H3 没有成片验证。新旧写法的文字回放见 `docs/animation-storyboard-implementation-2026-09-21.md` 的「后续：单镜提示词按 ai-video-prompt 的写法组织」。

### 分镜写清进出画面方向（2026-10-13）

起因是 2026-10-12 的成片验证：不论单镜提示词用新写法还是旧写法，成片里人物出场方向和跑动路线都乱——A05 两个一起被追的孩子从相反两侧跑进来，追兵从另一头冒出；A04 「4 秒绕晾衣杆一圈又一圈」没有一条成形。分镜本身从不写人从画面哪一侧进来、往哪一侧去，相邻片段的方向也不接，单镜提示词又不许自编方向，视频模型只能随机定。

- **分镜设计提示词**（`baseStoryboardPrompt`，锁台词版同样生效）：第 6 条补「角色进出画面或在画面里移动时，写清从画面哪一侧进来、朝哪一侧或哪个位置去、停在哪里；一起跑或追赶写清谁在前、谁在后、朝哪一侧跑；来回追、绕圈这类反复走位按 beat 秒数压缩成一眼看得清的一段路线」；第 8 条补「片段结束时还在移动的人写明在画面哪一侧、朝哪个方向；相邻片段方向接得上：朝右跑出 → 下一片段从左进来继续朝右，朝左跑出 → 从右进来继续朝左；一起逃的人从同一侧进来，追赶的一方跟在后面、不会出现在前方；上一片段结束时还在移动，下一片段的 transitionIn 写明从哪一侧进来；换对面机位导致反向时在 camera 写明」。golden 哈希按注释重算。
- **单镜提示词第三版**：站位写这一 beat 开始时的样子——A05 新写法第 1 份把「从椅背后抱住椅腿」写在动作前面，成片第 0 秒人已躲好、进场没了。
- **回放**（测试包冻结输入，MiMo 单次调用，`scripts/storyboard-design-ab.mjs`、`reports/storyboard-design-ab-2026-10-13/`）：有人进出画面或移动的 beat 写明方向，旧写法 9/18，新写法 20/20；旧写法两份都有几秒内「绕杆一圈又一圈」，新写法压缩成一段弧线或一圈。第 8 条第一版只写了「朝右跑出 → 从左进来（反过来同理）」，两份里有一份在追逐转躲藏处写成「向左下跑出 → 从左下冲进来」、鹅反而在另一侧；把两个方向都写明并补上追赶一方的位置后重跑，相邻片段无说明的反向为 0。单镜第三版 16 份：判据 16/16、明确切点 14/14、与分镜矛盾的站位 0、A05 两份都先写跑进来；新分镜的追逐片段写成单镜提示词后，「朝画面左侧跑」「横摇向左跟拍」都传下来了，躲藏片段没写孩子从哪一侧进来（方向只在 transitionIn 的「朝画面左侧奔跑」里）。
- **不做的事**：不加确定性判据（方向写得对不对要语义判断，不建方向词表）、不加 Schema 字段、不改审阅与修订提示词。成片验证（同日，Ark Seedance 2.0，测试服务里按新代码重新生成的分镜，追逐的 A04 与追逐转躲藏的 A05 各 2 条，`reports/shot-prompt-film-check-2026-10-13/`）：两段之间方向接上 4/4（上一轮旧分镜 0）、A04 绕杆追逐成形 2/2（一整圈、半圈；上一轮 0/4）、追的一方在被追者身后 3/4、两人同向逃且鹅在身后 4/4、最后躲到画面左侧竹椅后且鹅在右 2/2、多出或丢掉角色 0（上一轮 2 处）。仍有：A05「绕晾衣杆一圈」演成直线跑过，一条的全景里鹅跑到两个孩子中间，A05 8 秒 4 拍 3 刀的切点都早约 1 秒。样本小：每段 2 条、一份分镜。

### 分镜写法（2026-10-19）

用户让 Claude 拆了《天使降临到我身边》第 1 集的分镜与人声写法，又按这套写法手写了《鲸鱼风筝》分镜，看过说符合要求，要求替换现在的规则。用户定了三件事：只换创作写法，有校验器或实测依据的硬规则原样保留；人声写进现有的 `soundDesign` 并点名谁发出，不加字段、不写成台词；验证做文本回放加 2–3 段成片。详情与数据见 `docs/storyboard-style-2026-10-19.md`。

- **分镜设计提示词**：`directorGuidance` 整段换成「分镜写法」——一镜一 beat、每个 beat 至少 1 秒且用整数秒、不写 1 秒以下的快切；节奏参考（动作和笑点 1–2 秒，一般 3–4 秒，对话可 6–12 秒一镜到底，一个片段一般 1–4 个镜头）；空镜头（开场由远到近、换天换地点先给外观或钟、来人前先拍空门口，空镜 beat 的 characters 为空）；先局部后脸；大动作拆起中落三镜、切点在动作中间、三镜放同一片段；撞倒不拍过程；「期待的脸 → 揭底特写 → 反应的脸」；出画留空约 1 秒、先空后入；反应镜头多给听的人；首尾可同机位。声音：喘气、闷哼、闭嘴的低闷声、鼻音、哈欠、哼歌、倒吸气、叹气、哭腔写进 soundDesign 并点名，主角开场几秒内出声；人声不是台词，锁台词时也能加；声音先于画面只在同一片段内部。原导演方法里关于正确性的四条压缩保留（剧情气质与不新增力量危险、接触支点接得上、对白动机与信息前提、visualDesign 覆盖全部出镜或发声角色），自检段保留。
- `baseStoryboardPrompt` 只改三处措辞：第 3 条「没有镜头、运镜或大动作配额」→「前面的分镜写法是工具，不是配额」；第 6 条第一句允许局部先于脸出现（要让观众很快认出是谁的）；第 7 条与输出协议里 soundDesign 的说明加上「角色不说词的人声（点名谁发出）」。第 1、2（含锁台词锚点句）、4、5、8、9、10 条、方向句、画风行、输出协议字段顺序逐字不动。golden 哈希按注释重算。
- **单镜写稿**（`shotPrompt`）加三句：soundDesign 里点名的人声写成「[登记名]发出……」，具体叫声原样放进中文双引号用「叫」；空镜 beat 不补人物；无配乐收尾说明改为「（对白和角色人声照常保留）」，固定收尾句本身不动。**审阅**不当错误的清单补上空镜、出画留空、先局部后脸与人声；修订提示词不动。
- **不做的事**：不加 Schema 字段、不加确定性判据（人声、空镜、局部写没写、写得对不对都要语义判断）、不改校验器、不改固定无配乐句。那句「只保留现场环境声与动作声」可能让视频模型连人声一起去掉，成片验证专门看了人声（结果见 docs）。
- **回放**（`scripts/storyboard-design-ab.mjs`，旧写法改为 `--old-rev` 指定提交里的提示词；`reports/storyboard-style-ab-2026-10-19/`）：《小白子与大白鹅》测试包与《鲸鱼风筝》两份锁台词输入，MiMo 单次调用，新旧各 2 次。8/8 一次过判据，没有不到 1 秒或非整数的 beat，锁台词时改动台词 0 条。空镜 beat 旧写法 4 份都是 0，新写法 5、2、4、2，开场是空镜新 3/4；soundDesign 点到角色名的 beat（只是代理）旧 1/28、4/20、5/21、4/20，新 14/26、14/28、11/24、18/23。逐份读：新写法有由远到近的开场空镜、门先空着再进人、门外脚步与喘气先于画面、先给脚和书包再给脸、逃跑写喘气、被摇时闭着嘴的低闷声、日落用空镜跳时间；加的叫声都在 soundDesign 里注明非台词；方向句照常写出。
- **成片**（film-check 测试服务，生产路径的设计→审阅→修订→终审，Ark Seedance 2.0 720p，每段 1 条，`runtime/demo-runs/storyboard-style-film-check-2026-10-19/`）：《鲸鱼风筝》A02、A03、A05。分镜写进 soundDesign 的人声，单镜提示词 3/3 点名写出、成片 3/3 出了对应的声音（犯困的闭口「嗯」、门外脚步与气声、冲进来的一呼一吸、被摇时跟着节拍的闭口闷声、倒退时的气声），时间偏 1–2.6 秒；固定无配乐句没有让人声被去掉。A05 两刀各早约 1.5–2 秒（待解决项第 23 条第 9 点），且摇得轻、电饭锅变成灶上的锅、最后一镜小鲸鱼站了起来——视频模型没照提示词做。样本小。

- **第二轮（同日）**：用户对比手写的《鲸鱼风筝》分镜与 MiMo 的，觉得手写版更灵动。差距出在设计一步（审阅只报了 1 条）：MiMo 一个 beat 连做几件事再加缓慢推近、平均每镜 3.8–4 秒、特写少、没有视角镜头、主角只用原台词出声。`directorGuidance` 因此改为：一般 2–3 秒一镜；一个片段一般 2–4 个镜头、最多 4 个，并写明理由（一个片段是一次视频生成，切得越多切点越容易放错，多了就分成两个片段），1 秒只给冲击、揭底；一个镜头只做一件关键的事，顺手的小动作合进相邻镜头；镜头大多固定、推近只给揭底或心动；关键接触单独给特写、机位跟着高度；视角镜头；赶来的人可先插门外奔跑的脚；主角用过的拟声叫声（剧情台词里的也算）在她出镜的其他时刻变着用、写进 soundDesign，每段除喘气外至少一声；加一段「角色甲乙」写法示范，注明不照抄。调了四次（`reports/storyboard-style-ab-2026-10-19/round2-*`…`round5-*`，过度切分、主角不出声、15 秒塞 7 镜各修一次）。定稿回放 4/4 过判据、锁台词改动 0 条、每段最多 4 镜、平均 2.3–2.7 秒、开场都是空镜、主角出声的片段 8/10 到 11/11；鲸鱼风筝特写 31–32%、视角镜头各 2 个，有一份让小白子以贴地的鞋和围巾尾端冲进门登场；示范内容没被照抄。大白鹅特写 15–23%、视角 0，没到线。MiMo 内容审核拦过 2 次（不稳定，不自动重试）。用户看过文本回放后，用 MiniMax H3 按生产路径重新出的分镜（9 段 31 镜 96 秒）生成了 A01、A02、A05（768P，每段 1 条，`.claude/launch.json` 新增保留 MiniMax 密钥的 `film-check-h3`）：7 个切点都在写的秒数 0.25 秒以内、「镜头不切换」照做，镜头变密没有让切点变乱（第一轮 Seedance 早 1.5–2 秒）；人声都出来了；空镜、俯拍特写、只拍局部的登场、手部特写、贴地拍门槛都拍出来了。H3 自己的偏差：风筝画成立体鲸鱼、抱锅倒退走成朝镜头走、结尾补了一个没写的镜头，成片长 0.25–0.67 秒。同一份分镜再用 Seedance 2.0 出 480p（换模型后单镜提示词重写了一遍，A05 第 8 秒从「不切换」变成「切镜头」）：8 个切点 4 个在 0.5 秒以内、4 个早 0.6–1.4 秒，仍是越往后越早；人声 3 段都出来了；风筝是平的、抱锅往左边门口退照做了，但进门拍成带脸的全身、小白子站到桌面上。样本小，每段 1 条。

### 角色表情规则（2026-10-09 起退出页面）

2026-10-09 起页面上这一栏由「角色画风」接替：页面不再发 `characterExpressionRules`，浏览器启动时删掉旧存档 `directorCharacterExpressionRules`。**服务端继续接受这个请求字段**：两个分镜路由只拒绝类型错误与超长（判定与 1000 字符上限在 `public/character-expression-rules.js`，浏览器与服务端共用一份），不裁决内容。4.0 把它原样写进 `productionStrategy.characterExpressionRules`（页面不发时是空串），并随冻结输入 JSON 进分镜设计/审阅/修订与单镜提示词，没有专门的注入句；原来 3.0 的两个专门注入面已随 3.0 删除。

**不得并入 `creatorProfile`。** 那三个字段整体进 `src/character-boundary.js` 的 `sourceDigest`，任何变动都会作废全局角色边界并要求重跑整条工作流。表情是表演表现，不该承受该代价；发色一类身份事实则相反，应写进 `creatorProfile.fixedCharacter` 并承受重跑。浏览器侧同理使用独立的 localStorage key，不并入 `directorProfile`。

该字段只约束表情与表演，**不得改变角色身份、外观或物种**，`fixedCharacterBoundary` 始终优先。此约束有确定性兜底：模型若据此写出命中禁止特征的外观事实，`ensureCharacterReferenceMatchesBoundary` 仍在成片渲染前硬失败。「模型有没有照着写表情」本身没有兜底，属于生成质量。

### 镜头视频（全能参考）

视频生成只有一种模式 `all_reference`：图片/视频/音频仅作为多模态参考，必须至少包含合法图片或视频，不能只输入音频，不得混用 `first_frame` / `last_frame`；视频弹窗默认就是它。模式只由请求 `generationMode` 决定，只接受 `all_reference`，其他值（包括已删除的 `first_last_frame`）明确失败，不静默改写，不得根据 provider、模型名或素材存在性推断。供应商只有 Seedance 2.0（标准、fast、mini）与 MiniMax H3，两者消费同一条单镜提示词，默认 Seedance；4.0 分镜没有负面词，视频请求不带负面提示词。H3 Context-IR 已随提示词方言一并下线且没有公开 API（官方仓库说明 H3-Context-IR 未开源），此前 worker 中的 `POST /v2/h3_context_ir` 打的是不存在的端点，相关能力、端点派生与请求体已全部删除，不得重新接入。镜头视频分辨率可按次选择（2026-10-10，请求字段 `resolution`，不是 Plan 字段、不进提示词与 `modelOverrides`）：清单只在 `public/shot-video-resolutions.js` 一份（Seedance 标准版 480p/720p/1080p、fast/mini 480p/720p、MiniMax H3 768P/2K；按用户决定不放 4k），优先级为这次请求选的 > 供应商配置文件 > `*_VIDEO_RESOLUTION` > 代码默认值；不合法在建任务前 400（`SHOT_VIDEO_RESOLUTION_INVALID` / `_UNSUPPORTED` / `_DEFAULT_INVALID`），生成器调供应商前再核对一次，配置值一律不得静默回退（原来 Seedance 配错会悄悄改成 720p，MiniMax 的 `1080K` 曾被悄悄改成 2K）；没选时发给 worker 与供应商的请求逐字节不变（golden 测试）；每条候选记 `resolution`（取自 worker 回执）与 ffprobe 实测 `measuredWidth`/`measuredHeight`，并列显示不判失败；默认值经 `/api/health` 的 `resolutionDefaults` 给页面，配错照实带 `error`；页面选择只存 sessionStorage（`directorShotVideoResolutions`）。MiniMax H3 的 `ratio` 只在未配置时走缺省 `adaptive`；显式配置了官方取值以外的值必须明确失败，不得静默回退成默认值。供应商轮询失败必须带回它自己给出的原因，并在人类可读摘要之后附结构化 `{"error":{...}}`，否则 `describeProviderError` 查不到官方码表、用户拿不到可执行提示；内容审核 `1027`（输出涉敏）是非确定性的，但**不得擅自加入自动重试**——那是在第三方安全闸门上循环重试，代码无法区分误判与真违规，是否重试由用户显式决定。成片实际时长与 Plan 要求时长并列记录在每条候选的 `plannedDurationSeconds` / `measuredDurationSeconds`（`0` 表示未测得），偏差既不静默也不硬失败：实测 H3 请求 5 秒稳定产出 5.167 秒，硬失败会让该供应商 100% 不可用；是否对齐成片总长仍是未决的契约问题。

`all_reference` 可另行显式传入运行时 `continuityReferenceMode: "none" | "previous_shot_frames"`；它不得改变或推断 `generationMode`，也不是 Plan 字段。4.0 只有 `transitionIn.type` 为 `continuous` 的片段默认请求上一镜抽帧（`storyboardUsesPreviousFrames()`），首段、硬切与时间省略不默认继承。启用 `previous_shot_frames` 时，上一镜只由当前 Plan `shotPlan[]` 的紧邻前项确定；服务端必须读取上一镜 current `shotVideo` Artifact 的已选候选，只接受当前 media namespace 内的受信 mp4，并用 FFmpeg 按 `t = 时长×i/4` 均匀截取 **5 张** JPEG（首帧、末帧和中间三等分点；末帧回退 0.1 秒以保证可解码）作为普通 `reference_image`。张数固定为 5，不随镜头时长变化：单镜可长达 15 秒，每秒一帧会让超过 9 秒的镜头直接撞上 9 图上限，也会把角色参考图挤出共用额度。时间戳由 `previousShotFrameTimestamps()` 确定性计算并逐帧写进回执。实际抽帧与其他图片共同受 9 图上限约束，超限明确失败；上限数字只有一份，在 `public/all-reference-limits.js`。该参考只增强一致性，不能覆盖当前 Full Story/Plan 或 `fixedCharacterBoundary`；跨地点、跨时段或上一镜漂移是关闭该开关的合法反例。


角色参考声音（`characterReferencePrompts[].referenceAudioClips`）**只发给本镜的明确说话人**，不随出镜发送：判据是 `shot.dialogueOrSubtitle` 中 exact 角色名后紧跟冒号（允许一个表演括注），判定只有一份 `shotRelatedCharacterAudioClips()`，单镜与服务端权威解析共用；服务端对非说话人的音频硬拒，诊断码 `SHOT_VIDEO_CHARACTER_AUDIO_REFERENCE_NOT_SPEAKER`（409）。角色参考图不受此约束。判定刻意偏向漏判——判不出说话人就不发。依据是 2026-09-03 A01 实测：芙芙猫在该镜无对白只出镜，样音仍被附带，成片整段背景持续喵叫，供应商把样音直接混进了成片而非提取音色。**MiniMax 侧没有把音色定向到某个主体的机制**（官方文档：`audio_url` 仅为多模态参考场景的参考音频），所以该角色确实说话的镜头里原音直接播放仍可能重演；参考素材清单的文案显式排除「当背景音铺满」「在不发声时重复」两种误用，但那是 Prompt 约束，没有确定性校验兜底。要「加工后的叫声」必须在本链路之外做独立的声音生成或替换步骤。格式上 MiniMax 只接受 WAV 与 MP3，单段 2–15 秒、每镜 ≤3 段、合计 ≤15 秒；MP3 的 `audio/mpeg` 会被它按 MIME 子类型读成 `.mpeg` 并以 2013 拒绝，因此只在 MiniMax 传输边界改写成 `audio/mp3`，Artifact 保留 IANA 正确的 `audio/mpeg`，字节不变。

`POST /api/generate-shot-video` 必须始终绑定当前签发 Animation Plan，不接受无 lineage 的请求；Plan 不是 4.0 时 409（`ANIMATION_PLAN_VERSION_UNSUPPORTED`）。服务端从 Plan 唯一解析 exact shot；只允许独立 `promptOverride` 覆盖本次媒体提示词，动作、时长、场景、声音和验收条件仍来自 Plan。输出文件名必须包含不可碰撞的请求 nonce，并在返回前通过 ffprobe 视频流/时长校验。生成期间还必须无条件复验生产上下文是否仍为 current——在任何供应商调用与文件写入之前、每条候选提交供应商之前、每条候选落盘并通过 ffprobe 之后、组装返回值之前各一次，覆盖全部视频供应商，不得按 provider 或模型设门。任一次复验失败即 fail closed：删除本次请求已写入的全部候选 mp4，并把 `ProductionStateError`（409）原样上抛，不得包装成配置或供应商错误、不得保留产物、不得降级为成功返回。清理只针对本次调用自己算出的含 nonce 路径；只有过期触发清理，供应商错误与 ffprobe 失败维持既有语义。

`all_reference` 模式下，服务端在本次视频提示词之前确定性拼接一段**运行时参考素材清单**（`buildReferenceManifestText()`，`src/shot-video-continuity.js`），说明每张素材各是什么：参考图以 `reference_image` 发送时不携带任何文字身份，模型无从分辨哪张是角色参考、哪张是上一镜抽帧。清单前置而不是后置，以保证 `backgroundMusicMode: none` 的禁配乐句仍然是整条提示词的最后一句。抽帧成组时清单必须点名末帧：五张按 `t = 时长×i/4` 均匀采样，只有最后一张是上一镜结束时的状态，清单确定性写明「其中参考图N 是上一镜的最后一帧，本镜必须从它的状态与位置继续，其余几张只说明这一镜经过了什么，不代表本镜的起始位置」（末帧编号取自分组区间末位，不需要推断）；不点名的实测代价是下一镜复用了上一镜**起点**的构图，角色在空间上倒退整整一镜。抽帧**不承接角色外观与服装，也不整批承接位置关系**（位置只由末帧那一张给出）：它只承接「场景、道具与光线」，并在本次确实带了角色参考图时追加「角色的长相与服装一律以角色参考图为准，不要沿用抽帧里的角色外观」（没带角色参考图则不追加，避免指向不存在的素材）。原措辞让抽帧与角色参考图两句都声称管服装，等于把冲突写进规则——实测上一镜把服装画错后，该错误被抽帧当成事实传给下一镜，模型在同一镜内两次换装。上一镜是待核实的产出，角色参考图是签发权威，冲突时以后者为准。这只消除清单自相矛盾一项；抽帧同时携带外观与构图且通道上无法分离，「不要复制构图与动作」只是文本约束，抽帧数量的取舍仍未决。清单只允许使用受控来源枚举、Plan 权威的 `sourceCharacterName`（由 `resolveAuthoritativeShotVideoReferenceAssets` 按已签发 `characterReferencePrompts[].referenceImageDataUrl` 唯一匹配后覆写）、lineage 解析出的 `sourceShotId` 与帧数；**禁止写入 `upload` 素材的 `name`/`logicalName`**，那是原始用户文件名，是这条链路上唯一的注入面，上传素材一律只写「用户上传的参考素材」——安全性来自构造而不是事后校验。它不是 Plan 字段、不改 Schema、不签发 revision、不 stale 媒体、不调用模型：`effectiveVideoPrompt` 与回执字段 `referenceManifest` 记录本次实际发送内容。这里不得补 `ensureCharacterPromptMatchesBoundary`——视频提示词天然多角色，走 `promptScope: "multi_character"`，而该分支在 `src/validation.js` 中无条件短路返回空串，加上去只是一个看起来像闸门的空操作。

`/api/generate-character-reference-images` 送给图像模型的提示词由 `public/character-reference-prompt.js` 单份构建，浏览器预览框与服务端回退共用同一份——用户看到并可编辑的必须逐字等于实际发送的。字段顺序按 `docs/video-prompt-guide.md` 模板 1：首行 → 角色外观 → 姿态表情 → 干净背景 → 画风（「风格与色调」那一格）→ 景别/取景/机位；4.0 分镜没有光线来源，不写光线行。画风取 4.0 分镜签发的 `productionStrategy.artStyle`，写在「风格与色调」那一格（「画风：……」），为空就省略、不编造；起因见 `docs/待解决项.md` 第 17 条（角色图不知道全片画风，写实图会被 Seedance 当成真人拒收）。2026-10-09 起上传参考图是可选的（两个入口都是）：第一行随有没有上传变化，没上传时是「生成一张角色参考图。」，不能说「参考我上传的这张图片」；没上传时请求不带图片字段，即梦请求不带 `image`，按文字设定出图。「设为人物参考图」写进 Plan 的 `referenceImageNotes` 只写确定的事（由哪个模型生成），不再一律写「根据上传参考图生成」。

使用上一镜抽帧生成的后镜 `shotVideo` Artifact 必须同时依赖当前 Animation Plan 与上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选必须递归使下游视频 stale。切换后镜自身候选时必须保留既有媒体依赖。浏览器中的 `shotVideoResults` 必须按 variant + shotId 隔离，禁止只用 `A01` 作为状态键；单个媒体 stale 只能移除对应结果，不能清空其他 current 媒体。

---

**creative_brief/2.0：简报只做原片解读（2026-09-23）**。简报现在只产出两项：`storyEngine`（原片的驱动结构，含观众对人物关系理解的 before/after）与 `recastTest`（换一个性格完全不同的角色，逐场问还成立吗）。它们是原片分析与脚本还原都没有直接给出的东西；其余十二个旧字段全部停产，服务端在校验通过后盖 `schemaVersion: "creative_brief/2.0"`（模型不输出）。

依据是 09-23 的全局审查（`docs/creative-brief-slim-2026-09-23.md`）：
- 下发给候选的「定位」字段是逐字抄原片分析：5 个导出包里 `targetAudience` 4/5 与 `referenceAnalysis.targetAudience.primary` 逐字相同，`emotionStructure` 的情绪加强度 5/5 与 `emotionCurve` 相同。
- `allowedNarrativeComponents` / `roleAndOccupationMapping` / `minimumTransformationRules` / `creativeDistancePolicy` 没有任何阶段按字段读取，`mustRetain` / `samePlotDriver` 只进了已降级的 `briefAlignment`。
- 82 次简报调用失败 16 次；可归因的 13 次契约失败里 12 次在七项构件引文核对上，其中 4 次是原片确有其事的转述被 0.75 阈值误伤。
- 按字段名投影挡不住原片情节：`emotionStructure.stage` 把「高潮：获得奖励与反哺」这类原片事件名当正向要求送进了候选阶段。

契约五个面：
- **生产者**：`briefPrompt` 只收原片分析与脚本还原，不再收固定角色、赛道与创作限制——两项讲的都是原片，转述用户设定只会造出第二份事实（09-23 那份把搭档写进了「固定角色」，而简报会被送进角色边界阶段）。`storyEngine` 与 `recastTest` 的定义、反例逐字保留。
- **校验器**：`ensureOutputContract(_, "creativeBrief")` 顶层只允许这两个键，多一个就 `CREATIVE_BRIEF_UNEXPECTED_FIELD`（与 `recastTest`「恰好三个键」同规格，模型写了 `schemaVersion` 同样算多余）。七项构件、受保护表达、角色映射的校验器与 `ensureCreativeBriefMatchesProfile` 已删除；引文覆盖率算法仍由候选溯源使用。
- **消费者 · 候选**：定位、受众、情绪曲线与观看动力改由 `variantsSourcePositioningProjection` 直接从 `referenceAnalysis` 取——`format` / `genre` / `targetAudience.primary` / `psychologicalNeeds` / `emotionCurve[].{emotion,intensity}` / `retentionDrivers[].driver`。白名单按「内容是否天然带原片情节」取舍：`emotionCurve.phase` 与 `trigger`、`contentPromise`、`whyWatchToEnd`、`retentionDrivers.payoff` 一律不取（问句形态仍由 `sourceViewerQuestionForms` 单独给出）。`recastTest.collapses` 照旧从简报读。旧简报的 Run 走同一条路径，不做版本分支。`highValueBeatMapping.briefBeat` 写迁移的是哪一种原片机制（观看动力名称或 `collapses` 的一条），候选 schema 不变。
- **消费者 · 角色边界**：`visualGuardrailsPrompt` 不再放简报，原片表面表达直接取原片分析与脚本还原。**同时由服务端给出一份确定性的候选短词表**（`sourceSurfaceCatalogText`：各场 `keyProps` 逐字原文、按原文去重、带第一次出现的 sourcePath），要求从候选里选时一条规则只写一个、原样抄。这是回放打回来的：09-19 那批 10/10 通过的输出里，`sourceSimilarityRules` 的证据 82%（47/57）引用的是简报 `protectedExpressions`——那份能原样抄的短词表才是这一阶段过「逐字绑定」闸门的主要来源；直接去掉后 5 次有效调用里 2 次写出原文没有的简称（证据写「企鹅连体衣」它写「企鹅装」）被拦下。补的是一份不经过模型的摘录，不回到简报；与候选溯源直接取 `keyProps` 同一个做法。人物 `traits` 不进这份表：真实数据里全是「可爱 / 活泼」这类性格词。**签名摘要 `computeCharacterBoundarySourceDigest` 仍包含整份简报**——拿掉它会让所有已有 Run 的边界当场失效，需要单独设计带版本的摘要，本次不做。
- **消费者 · 其它**：候选评审只按旧有允许清单投影（新简报只有 `storyEngine` / `recastTest`，其余两项为 null / []），schema 不变；Full Story 1.1/1.2 与自主分镜 4.0 本来就不读简报。
- **浏览器**：简报卡改为「创意简报 · 原片解读」，只显示这两项并标明写的是原片；旧简报多出的字段只显示一行说明。旧卡片把 `mustRetain` 标成「必须保留」、把 `protectedExpressions` 标成「禁止直接复制」、给七项构件一律打 ✓，三处都与契约相反。

旧简报只在生成路径被校验，下游只做 `requireObject`，所以照常加载、导入导出，不迁移、不重签。真实回放数据见 `docs/creative-brief-slim-2026-09-23.md`。

**`storyEngine` 五个子字段的定义与 `turningMechanism` 两槽位（2026-09-10）**：`briefPrompt` 此前对
`storyEngine` 与它的 `desire` / `obstacle` / `escalation` / `turningMechanism` / `payoff` **一条说明都没有**——
六个词各出现恰好 1 次，就是输出模板里那个空槽位。它是整份简报里**唯一**一个子字段全无定义的子对象
（`nonNegotiableExperience.samePlotDriver` / `sameBeatValue`、`reusableHighValueBeats[].beat` /
`dramaticValue` / `mustRetain` 都有定义），而且零校验器、改动前**零消费者**
（`src/validation.js` 只在 required 键名里出现，浏览器只展示 desire/obstacle/payoff 三格）。

实测后果：三个真实导出包里 `turningMechanism` 一份是真机制、一份可用、一份写成剧情概括
（「主角主动采取防护措施继续参与活动，展现机灵与懂事」）。**那不是模型写错**——「转折机制」
最自然的读法就是剧情转折点，没人告诉过它这个字段要写的是关系/理解的改变。质量随包而异
不是模型不稳定，是**一个未定义字段上的猜测**。

现在五个键各写定义，`turningMechanism` 改成 **`{before, after}` 两个槽位**：
`before` 写前半段观众以为这是一段什么关系，`after` 写看完之后重新理解成什么。
提示词**明写它不是剧情转折点**、不是「主角做了什么」——那是最自然的误读，不点破它，
写再多正面定义都会被它盖过。两端必须是**对同一组人物关系的两种理解**，不能写成
「任务没完成 → 任务完成了」或「情绪低落 → 情绪变好」；转变不必是反转，小幅度的重新理解也算数。

`validateStoryEngine`（`src/validation.js`）挂在 `ensureOutputContract` 的 `creativeBrief` 分支，
与 `validateNarrativeComponents` / `validateProtectedExpressions` 并列。判定**全是类型、非空与字符串
比较，零语义**：四个文本键非空；`turningMechanism` 必须是**恰好含 before/after 两个键**的对象
（多一个键就会把定义稀释掉）；两端非空；归一化后 `before !== after`，复用现成的
`normalizeStoryReviewEcho`（去空白与中英文标点），**不另写第二份**。

**闸门只抓退化，不保证判对。** 它能抓住「两边写同一句话」这种同义重复，**无法**判断写出来的转变
是不是真的发生在关系上——那需要语义判断，没有确定性兜底。

**只在生成路径生效。** `ensureOutputContract(_, "creativeBrief")` 全项目只在 `createBrief` 里调用两次；
下游 variants / visualGuardrails / fullStory 都是裸 `requireObject`。所以 `turningMechanism` 仍是字符串的
旧简报**不会被拒绝**，照常加载（所有调用点都是生成路径）；
简报卡的「理解转变」格因此写了两个分支，旧简报不会显示成空白。

**真实回放（2026-09-10，从源视频重跑 analyze → reconstruct → brief）**：导出包**不能**直接回放
`/api/brief`——`groundedStageInput` 对 `sourceScriptReconstruction` 无条件验签且没有出口
（`WORKFLOW_SIGNATURE_POLICY` 只覆盖角色边界签名），外来包的 seal 一律 400。因此改从源视频重跑整条链
（`打枣.mp4` 的 SHA-256 与包内 `sourceVideo.digest` 逐字节一致，确认是同一个文件）。
三个包的结果**有好有坏**：

- **反面样本修好了**：那份剧情概括变成「观众以为这是一段长辈照顾晚辈、晚辈被动接受关爱的关系」→
  「观众重新理解为晚辈也在用自己的方式主动参与劳动、回应长辈的爱」，方向与一份外部评审对同一部
  参考片的独立读解一致。
- **旧值可用的那个没变差**，两端比旧值更明确。
- **旧值最好的那个反而退了一步**：旧值精确点名了两人各自的角色（「从打扰者与被干扰者转变为模特与
  创作者」），新值写成「单方面照顾 → 双向陪伴」，更笼统，而且补了一句「两人共同完成了一幅作品」——
  按还原稿那个角色是**被画的对象**，画由另一人独自完成。**闸门抓不到这个**：`before !== after` 照常通过。

**这批数据能支持的结论很窄**：三个包里只有一个原本是反面样本，所以它证明的是「已知的那个反面样本
被修好了」，**不是**「定义写清楚就一定能拿到好机制」；而第三个包说明**它也可能把已经写对的换成更差的**。

两条没有确定性兜底的观察：①两端都以「观众以为…／观众重新理解为…」开头，**3/3 全中**——模型在照抄
提示词的措辞框架，内容随包不同、是真实读解，但这个开头已经成了公式；②新值可能引入与原片不符的
断言（上面那句「共同完成」），闸门只查两端不相同，判不出哪一端说错了原片。

**`recastTest`：换个角色来演，什么会塌掉（2026-09-11）**。`creativeBrief` 顶层新增必填字段，
与 `storyEngine` 平级（不放进 `storyEngine`——那会污染它的事件结构模型）。

起因：我们提炼的是「参考视频叙事的过程」，不是观众实际看到的东西。「一个小辈帮助长辈」是事件；
观众看到的是「一个可爱的孩子发挥自己的天性、用自己的方式帮身边的人」。量化证据：候选提示词
26,873 字里 108 条否定式约束、55 次「必须」、**0 次邀请模型用自己的判断、1 次提到「好看」**；
两轮真实回放的 `turningMechanism`（3.7-max 与 3.8-max-0902）质感不同但**都停在事件层与关系层**。
`storyEngine` 五个键本身就是完整的事件结构模型，在里面加力度只会拿到更精确的事件描述，换模型也不解决。

**它是一个操作，不是一句定义**：`{recastAs, collapses, survives}`——先把主角换成一个性格完全不同的
角色（`recastAs` 必须写具体性格），再逐场问「换了这个角色还成立吗」，不成立的进 `collapses`
（只有这个角色才给得了的东西），照样成立的进 `survives`（谁来做都一样）。依据是
`turningMechanism` 加定义后实测 3/3 照抄措辞框架；本仓库成功的改动全是结构性的，失败的全是措辞性的。
举例**一律用反例**（品质词、谁都能做、含糊其辞），不给正例——反例不会被抄成内容。

**两侧同时必填是全部要点**：只填 `collapses` 模型可以把所有东西塞进去，要求同时列 `survives`
它就必须做区分。与 `transformationProof` 拆两个槽位同一个招式。

`validateRecastTest` 挂在 `ensureOutputContract` 的 `creativeBrief` 分支。五条闸门全是类型、非空与
集合比较、零语义：恰好三个键、`recastAs` 非空、两侧各至少 1 条非空、**两侧归一化后不得有交集**
（核心闸门）、同侧不得重复。归一化复用 `normalizeStoryReviewEcho`。
**闸门抓不到 `collapses` 里写品质词而不是具体动作**——没有确定性兜底。

**只在生成路径生效**（与 `storyEngine` 同型，旧简报照常加载）。**候选阶段只拿到 `collapses`**：
送它是要候选迁移同一性质的东西，不是复现原片那些动作；`survives` 留在简报侧，送下去只会变成
又一份可照抄的事件清单。

## 候选阶段的原片事实溯源与对照评审（2026-09-06）

**原片来源独立选取与服务端派生（2026-09-09，替代新候选路径中让模型自由写 source 的规则）**：两份原片上游齐全时，`createVariants` 先建立私有冻结目录，使用创建时的 variants provider/model 独立选择人物、事件、对白、画面四维的 evidenceId，再调用同一模型创作候选。选源输入不含 creatorProfile、Brief、Guardrails、候选、replacement 或旧 source；目录仅投影原片事实白名单，不带签章或媒体。所有 ID 必须已知、非空且不重复，不设置固定 4 条上限。对白引用附带同场 visibleActions 与 shotDesign 的画面原文；不同场次的同文不能按文本去重，必须按 evidenceId 保留。道具不由模型选择，直接取全部冻结 `scenes[].keyProps` 精确文本去重；合法空数组签发「原片没有可引用的场次道具清单记录」，仅声明清单空，禁止扩大成原片没有物件；缺键、非法类型与空白条目仍失败。

候选模型只输出五个 `replacement`，服务端从选择结果复制完整原文，覆盖已有五对字段的 `source` 后再跑完整 schema、派生与 profile 校验。不能补齐缺维度、修改 replacement 或掩盖额外字段。所有候选共享本次原片基线；不得从新角色或新剧情反推原片问题。私有目录及选源结果不进入 Task Store 或新 Artifact，只在本次调用内使用；一个 variants Task 两次顺序调用、一次提交，直接冻结 Analysis、Reconstruction、Brief、Guardrails 四份依赖，现有用量与 watchdog 覆盖两次调用，不自动重试。选源单独记录 `variantSourceBaseline` 模型输出日志。Demo 从真实 mock 上游确定性选取，不调用模型；缺两份上游的旧调用点及已签发候选保持旧来源兼容校验。Full Story 的新片事实只承接候选正文与 replacement，source 不构成新增人物、事件、道具、对白或字幕卡的要求。选源不能解决原片上游转写含混、外观缺失或事实冲突，不能把引用合法宣称为原片逐动作/逐字音频验证通过。

**replacement 只写本片、必须是对象；apply 报 Schema 码（2026-09-24）**：deriveSource 分支由是否具备两份原片上游决定，与模型无关，所有模型收到同一份候选提示词。该分支现明确要求每个 changed* 是 `{"replacement":"…"}` 对象、不得写成字符串，replacement 只写本片、不写「原片的 X 换成 Y」式对照句，并删去与「不要输出 source」矛盾的「供 transformationProof.source 引用」；缺上游的旧调用点逐字不变。依据：MiMo mimo-v2.6-pro 开思考 45/45 个 replacement 为对照句、一次压成字符串，千问 180 个为 0。同上游回放 MiMo 字符串 0/3、对照句 0/65，但 4 次仍全部因范围外原因失败（空垃圾键、数组孤立字符串、照抄空模板多写候选、内容审核），这些结构类失败随后由候选调用的 json_schema 约束解码消除（见 §2.7，接入后同上游回放 4/4 通过）。`apply()` 的候选形状错误不再沿用 `SOURCE_BASELINE_SELECTION_INVALID`，改报严格 Schema 同位置的 `STORY_CANDIDATES_SCHEMA_TYPE/_REQUIRED/_EMPTY_STRING/_MIN_ITEMS` 并带 JSON Pointer path，码名与 Schema 共用 `schemaErrorCode`；判定不变。见 `docs/variants-mimo-format-2026-09-24.md`。

`variantsPrompt` 现在按允许清单投影原片人物名称/特征、观察事实、场次动作/对白/道具，供机制对照和 `transformationProof.source` 引用；不带签章、摄影说明或媒体。此前上游已进入 workflow 与 validator，却没有进入实际候选提示词。Brief 正向投影去掉可能携带获奖/转赠链的 `emotionStructure.function`，`dramaticValue` 单列为来源价值解释，不是每个新片的必备事件；情绪曲线也不作为逐拍模板。候选阶段的角色规则投影将 `stageInstructions` 输出为空对象，隔离上游模型在阶段建议里写入的帮助、奖励、转赠模板；其余阶段仍消费原值，签发的角色事实及原 Artifact 均不改变。不对值做关键词分类。

同一天落地的四件事，起因是一次实测：19:04 那一轮**四个候选全部**把原片写成「企鹅快递员 / 快递送达」，而上游 `referenceAnalysis` 与 `sourceScriptReconstruction` 里「快递」出现 **0 次**（「穿着企鹅连体衣、背着绿色小包的小角色」是真的，快递员是补出来的职业）。同一份 `creativeBrief` 的 `allowedNarrativeComponents[0]` 还明写着「原片中咕嘎只是偶遇并递出棒棒糖，没有明确的送达任务或目的地」——**存在性判定写对了，别的字段照样编**。V1 更照着这个虚构把整条结构建成「主动承担送达任务」，一个不存在的原片结构成了改写基线。

污染链三段，全部实测复现：①`briefPrompt` 教 `mappingLogic` 怎么写时，举例正文里写死了「不继承原片企鹅服、**快递员身份**和视觉外壳」，当天简报输出「不继承原片企鹅连体衣、快递员身份和视觉外壳」——只换了两个词，是在抄举例；②防这件事的规则**已经存在**且反面例子一模一样，但它写在 `fullStoryPrompt` 里，而 `transformationProof` 是候选阶段先产出的，`variantsPrompt` 收不到；③`transformationProof` 与 `mappingLogic` 全项目零校验器。规则、依据、测试都有，只是装错了阶段。

**一、简报举例去污染。** `briefPrompt` 的 `mappingLogic` 举例改成不含任何参考片具体名词的写法，并明确「举例里的措辞可以照搬，具体名词不行」；仍需保留「企鹅快递员」的那句加上与 §Full Story 同款标注「来自另一部参考片，只示范判据，不要照抄内容」。**这一项没有确定性兜底**——判断模型有没有在抄举例需要语义判断；它的兜底是下一条。

**二、候选 `transformationProof` 改结构对 + 确定性溯源校验。** 五个 `changed*` 从自由字符串改成 `{source, replacement}`：`source` 只写原片是什么，`replacement` 只写本片改成什么。分开两个槽位是全部要点——混在一个字符串里时，程序无法知道哪一半在描述原片。`source` 只有两种合法取值：能在上游找到依据的原片事实（复用简报那套 `citationCoverage`，LCS 字符覆盖率、阈值 0.75、**允许转述**），或精确等于 sentinel `原片没有`（**完全相等**判定，`VARIANT_SOURCE_ABSENT_SENTINEL`）。

留这个出口是闸门能成立的前提：schema 要求 `source` 非空，若唯一合法写法是「一段真实原片事实」，那么原片确实没有送达任务时模型只有编一个或整批失败两条路，**逼出来的编造正是这条闸门要拦的东西**。

**判定是前缀，不是完全相等。** 第一版要求精确等于四个字，同日 21:10 那一轮实测 **20/20 全部失败**：四个候选五个字段无一例外把它当成句子开头补完（「原片没有明确任务」「原片没有人类角色对白」）。这不是模型不听话——`原片没有` 天然读作一句话的开头，要求它在这里戛然而止，是让措辞去对抗书写本能，本仓库已有多次同类失败记录。放宽到前缀会让「原片没有把糖递给女孩」这类带内容的否定句免检，第一版正是为此才要求完全相等；重新权衡后认为代价搞反了：**否定句不制造改写基线**——它没有声称原片有过任何可供承接的东西，最坏只是这一格信息量为零，而正向声称仍然逐条回上游核对，闸门的实际拦截能力没有变化。用整条流水线硬失败换这点收益不划算。

**同一次实测暴露的第二个问题没有确定性兜底：模型把 `source` 的提问方向写反了。** 它给 `changedDialogue.source` 写「原片没有人类角色对白」，而那部参考片有一句「再见啦~」；`changedDetailsAndProps.source` 写「原片没有美术教室与画具相关道具」，而原片有简历、棒棒糖、绿色挎包。它在回答「原片有没有我打算加的东西」，而这个字段问的是「原片这一维度**有什么**」。第一版提示词把缺席出口写成整段最显眼的一条，直接把模型推上了这条路。现已改为：正向引用是默认路径并给出**填好的样例**（举例是最强信号——本仓库刚因简报提示词里一句写死的举例被逐字抄走而付出代价），缺席出口降级为一行并注明「确实没有，而不是和本片不一样」。方向写反但格式合法的 `source` 无法用字符串判定识别，只能靠人工与后续回放观察。

**核对基准只有 `referenceAnalysis` 与 `sourceScriptReconstruction`，绝不含 `creativeBrief`**——当天正是简报自己先错，拿它当基准等于给虚构盖章。校验器 `validateVariantSourceFactCitations` 由 `ensureThemeVariantsMatchProfile` 的第 5 个参数 `upstream` 驱动，`if (upstream)` 才执行，与 `ensureCreativeBriefMatchesProfile` 同规格，旧调用点行为逐字不变。诊断码 `STORY_CANDIDATE_SOURCE_FACT_UNVERIFIED`。浏览器请求体与 Durable `buildInput` 白名单**本来就携带**这两份上游，无需管线改动。

实测判别力（同一份真实上游）：`企鹅连体衣` `绿色挎包` `咕嘎递出棒棒糖` `女孩坐在公交站的长椅上` 全部通过，`快递送达` 0.25、`企鹅快递员` 0.60 全部拦下。真的过、编的拦，阈值不动。**Full Story 的 `transformationProof` 本轮不动**（改它要连带动 `full-story-partial-repair` 白名单与 legacy schema），因此那条提示词规则**逐字保留、没有合并**：两处判据严格程度本就不同（那边写「逐字找到依据」，这边校验器允许转述），揉成一句要么悄悄放松那一侧、要么让这一侧的提示词比校验器更严。

**三、`highValueBeatMapping` 补 `failureSignal`。** 每条保留机制必须写出**证伪条件**：这条机制没迁移成功时会长成什么样（例：「结尾只靠夕阳、拥抱或台词宣布温暖」）。「温暖」「治愈」「关系改变」「重获希望」这类词单独出现不构成判据——它们描述结果，不描述观众看到什么。**只有 schema 形状校验，没有语义兜底。**

**四、候选对照评审（`storyCandidateReview`）。** 与剧情体检同规格：**只出报告**，不修改候选、不签发 Artifact、不进 lineage、不参与派生、不 stale 任何东西、**不改变候选数量**、不阻断后续 Full Story；手动触发 `POST /api/story-candidate-review`，刷新页面即失。

它要暴露的是「候选声称保留了原片精华，而动作链并不支持那个说法」。所以送审投影**按允许清单构造**（`buildStoryCandidateReviewProjection`，安全性来自构造而非事后过滤）：只送 id、title、hook、logline、`narrativeMode`、`characterSetup`、`storyOutline` 的动作链、`keyDialogueDirections` 与 `failureSignal`；**刻意剥掉** `novelty`、`visualPotential`、`experienceFidelity`、`transformationProof`、`originalityRiskCheck`、`highValueBeatMapping[].retainedValue` 以及每拍的 `dramaticFunction`。送进去就等于让解释替故事过关。`failureSignal` 反而要送——它是证伪条件不是成功声明，**把「陷阱」给评审看、把「答案」藏起来**是有意的不对称。浏览器再把评审结论与候选自己的说辞并排显示：模型看不到那一栏，用户看得到。

覆盖率由服务端确定性核验（`ensureStoryCandidateReviewCoversCandidates`）：候选数量相等且 `candidateId` 逐位相同、回显 `title` 必须**包含**原文（复用 `storyReviewEchoCoversSource`，不建第二套）、`beatIndexes` 必须在该候选 `storyOutline` 范围内、`recommendedOrder` 必须是全部候选 id 的一个排列；核验通过后服务端用原文无条件覆盖 `title`。**「判得对不对」是语义的，没有兜底**——只保证模型逐个候选看过。

**⑤ 因果自洽检查 `coherenceChecks`（2026-09-09，来自第一次真实回放）**：`candidateCheck` 新增必填数组（空数组合法），每条写 `kind` / `beatIndexes` / `problem`。
`kind` 五个取值都来自实际观察到的失败形状：`contradiction`（同一候选两处描述互相否定）、`tool_misuse`（角色手上已有能解决问题的东西却用更差的替代物）、
`purpose_nullified`（任务目的被链条里另一件事当场抵消）、`space_or_time`（前面说够不到或来不及，后面用更弱的办法却成了）、`other`。
**提示词里的举例一律是抽象形状，不含任何参考片或候选的具体名词**——§2.12b 的「企鹅快递员」事故正是举例被逐字照抄造成的。

闸门只有一条，**纯算术加枚举比较**：`coherenceChecks` 非空就不能判 `pass`，诊断码 `STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK`。
它不裁决那条自洽问题成不成立。拍号合法性判定与 `mechanismChecks` **共用一份** `checkBeats`。

起因是 2026-09-09 用一份真实导出包做的首次回放（该阶段此前**从未真实调用过**，`docs/待解决项.md` 第 7 条）。
评审把一个候选判成 `pass` 并排在第 2，而它的动作链有三处矛盾：对白说「顺路」而同一拍写「反方向」；
角色怀里已抱着能解决问题的道具，却另找更差的替代物去保护它；任务目的在最后一拍被另一条线抵消。
评审的 `coreInteraction` 还把其中一条**原样抄下来**当成功案例。根因不是模型不行，是 **`verdict` 声称的比评审实际检查的多**：
`pass` 的定义是「可以直接展开」，而评审只审「机制有没有迁移过来」。这与 §2.13 查的不是同一件事——那边是「声明 vs 呈现」，这边是「呈现 vs 呈现」。

**三条必须如实记着的局限：**

1. **命中率 38%，但绝不是完备闸门。** 四个包 16 个候选里有 6 个被报出自洽问题。抓到的内容具体且锚到拍号——
   例如「第 2 拍写够不到、第 3 拍搬木箱、第 4 拍站上去还是够不到」，以及「长辈手里已经有旧星图并能指出位置，
   那件道具要解决的问题在第 1 拍就不成立了」。但**已知有 3 处矛盾的那个候选只被抓到 1 处**，另两处始终没抓到。
   **不得据此宣称「自洽问题会被拦住」。**
2. **`pass` 闸门在 live 至今没被触发过**：报出自洽问题的候选，模型本来就判了 `revise` 或 `drop`。闸门只有单元测试证明有效。
3. **判定质量在包与包之间很不齐，目前不能当挑选依据。** 与一份外部评审对同一批候选的评分比对：一个包完全吻合
   （`pass` 的两个正是外部评分最高的两个，`revise` 的两个正是最低的两个），一个包部分吻合，一个包**方向相反**
   （我们唯一判 `revise` 的那个是外部评分并列最高的），还有一个包全部判 `drop`。`recommendedOrder` 同样不稳：
   同一份输入两次回放的排序不同。**不得把 `verdict` 或 `recommendedOrder` 当成自动选择依据。**
4. **不得为了提高命中率去加词表或反复改提示词**（§5 第 2 条与「看到错误日志就直接改提示词」）。
   最初只跑了一个包就得出「召回率很低」的结论，而那个包恰好被判全 `drop`、模型不再继续找——
   **单包结论在这个阶段是不可靠的**，任何比例都要跨包统计。

**同一次回放还暴露了旧契约的一个更根本的问题（当时没有确定性修复，现由下面 ⑥ 结构性解决）**：回放 1（旧契约）给四个候选提炼出 **8 条各不相同**的「原片机制」，
每条都是照着**那个候选本身**写的，于是 6/8 判 `depicted`——**从候选反推原片机制，再判定它已兑现，是循环论证**。
改动后两次回放收敛到**同一条**具体机制并 8/8 判 `not_depicted`，与一份外部评审对同一批候选的结论一致。
但**无法证明是这次改动修好了循环论证**，只能记录：改后 2/2 一致且与外部结论吻合。这条没有确定性兜底，判断「机制提炼得对不对」需要语义判断。

**⑥ 原片机制清单改为全批共享、候选按 id 引用（2026-09-09）**：`storyCandidateReview` 新增**顶层**
`sourceMechanisms: [{id, mechanism, whereInSource}]`（schema 限定 **2–4 条**），`mechanismCheck` 的
`sourceMechanism` / `whereInSource` 换成 `sourceMechanismId`。闸门两条，**都是纯集合成员比较、零语义**：
id 必须唯一（`CANDIDATE_REVIEW_DUPLICATE_MECHANISM`），每个引用必须在清单里
（`CANDIDATE_REVIEW_UNKNOWN_MECHANISM`）。拍号合法性与 `coherenceChecks` 共用同一份 `checkBeats`。

它修的是上一条末尾记的那个循环论证，而且**是结构性修复不是措辞修复**：四个包的实测里，
只有一个包把原片机制收敛成 3 条，另外三个各提炼出 **8–9 条**、每条都照着那个候选本身写，
于是 6/8 判 `depicted`。清单上限 4 条之后，「4 个候选写出 8 条互不相同的原片机制」在**构造上**不再可能。
提示词同步改口径：先只读原片写出清单（「在看任何候选之前先做这一步」），再逐个候选核对它命中哪一条；
自检方法写成「把全部候选删掉，你写的这几条应该一字不变」。旧口径「先从原片动作稿里挑出
**这个候选试图迁移的**机制」正是诱因，已删除并由测试锁定不得回来。

招式与 `variant-source-baseline` 的冻结证据目录同规格：共享权威清单 + 按 id 引用。
评审只出报告、不进 lineage、不落盘，所以改它的契约代价极低。
**「机制提炼得对不对」仍然没有确定性兜底**——闸门只保证全批共用一份清单，不保证那份清单读对了原片。

**⑤⑥ 落地当天漏掉了「五个面」里的消费者面，而且是静默漏（2026-09-10 补）。** 生产者、校验器、
Prompt、测试当天都动了，`public/app.js` 的 `renderStoryCandidateReview` 没动：它还在读改名前的
`entry.sourceMechanism` 与已移到顶层的 `entry.whereInSource`，而 `escape(undefined)` 返回空串——
**页面上是两处空白，不是报错**；`coherenceChecks` 与顶层 `sourceMechanisms` 更是压根没有渲染代码。
一个只在页面上显示的阶段，消费者漏了就等于这两档整个没做。

现在浏览器：顶层清单置顶显示（每条 id + 机制 + 原片在哪兑现），逐条 `mechanismCheck` 旁显示它引用的
那条机制正文，`coherenceChecks` 单独成块、`kind` 五个枚举各有中文标签（枚举值本身是英文标识，直接
显示等于让人对着 `purpose_nullified` 猜）。`candidateReviewMetrics` 同步**数出**因果断裂条数与涉及
候选数，与剧情体检同规格、不问模型要总分；旧报告没有这个键时数出来是 0，但那是「这一档还不存在」
不是「查过了没问题」，所以摘要里那一段整段不显示。`test/story-candidate-review.test.js` 用源码断言
锁住这四处，撤掉渲染即失败（已实测）。

**首次真实调用（2026-09-10，两个包）**：新契约此前 **0 次真实调用**，只有 mock 单元测试证明过——
与 `docs/待解决项.md` 第 7 条是同一个形状，同一个阶段上踩了两次。补跑《打枣》与《捐旧衣服》：
两个包**都把清单收敛到 4 条**（上限）、逐条锚到原片场次，全部引用命中清单内的 id，新加的两条闸门
一条都没触发；因果自洽两个包都是 **2/4 个候选**，四条都锚到拍号且具体。旧契约那种「4 个候选写出
8–9 条各不相同的原片机制」两个包都没有再出现。

**同一批数据里的两条限制**：①两个包都有**没被任何候选引用**的机制（打枣的 M4 零引用），清单写满
4 条不等于 4 条都用得上；②判 `pass` 的三个候选都没有报出自洽问题，所以
`STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK` **至今仍未在 live 触发过**。
**《捐旧衣服》第一次还撞了一次 502**——`recommendedOrder` 只写了 1 个 id，被既有闸门判失败、
整份报告丢弃、¥0.27 白烧；那条闸门与本次改动无关，但它促成了下面 ⑦。

**⑦ 允许第一次做错：带诊断重试一次（2026-09-10）**。`createStoryCandidateReview` 从
`generateStageJson` 改走 `modelCallCoordinator.runJson`，`maxProviderCalls: 2`，**禁止第三次**，
形状照搬已删除的分镜定向修订的结论（历史文档 `docs/animation-plan-review-落地方案.md`）：「事前在提示词里定规矩→没用（三次加码都没用）；
事后拿数字打回去重做→有用」，以及「**修订必须设计成「允许第一次做错」**」。候选这一档此前
只搬了前两部分（提示词定规矩、确定性闸门）。

- **校验逐字不变**：改的是「错了之后怎么办」，不是「什么算错」。五条闸门一个字没动。
- **不需要错误类型转换**：`ensureStoryCandidateReviewCoversCandidates` 抛的 `OutputContractError`
  本来就被 `classifyAttemptError` 判为可重试，`details` 原样进 `issue.diagnostics`。
- **重试只发诊断，不把失败的报告发回去**（`storyCandidateReviewRetryPrompt`）：原提示词逐字保留，
  末尾追加校验器数出来的 `path / reason / code`，不另写一套人话翻译。没有结构化诊断时退回原提示词。
- **拦过一次必须说出来**：返回值多一个 `metadata.storyCandidateReview`（`provider` / `model` /
  `providerCalls` / `rejections`），浏览器在报告顶部以 warn 色显示。`providerCalls` 由
  `attemptObserver` 计数，不能从「有没有被拦」反推——传输失败时供应商确实被调用了两次而没有诊断。
- **两次都被拦时两次诊断都在响应里**（每条带 `attempt` 序号）：coordinator 抛的
  `ModelPipelineError` 只带最后一次的 diagnostics，所以这条路径自己重建错误、合并两次，其余字段
  逐字照抄。已删除的分镜定向修订当年没做到这一点，评审这一档一开始就做对。
- **走 coordinator 就拿不到 `generateValidatedJson` 自带的 recorder**，必须自己接 `attemptObserver`，
  否则静默不写、两次原文全部丢失。
- 传输失败同样吃这 2 次预算；`requestTimeoutMs` 不动。**其余八个走 `generateValidatedJson` 的阶段
  逐字不受影响**——不能给那个函数加重试，它是共用的单次调用路径。

**它救不了什么**：诊断只有那五条闸门那么宽。机制清单读错原片、自洽问题判错这类**语义**错误不产生
任何诊断，也就不会触发重试。这条路只把「模型漏抄了几个 id、整份报告被丢弃」从 502 变成重做一次，
**不提高报告的判断质量，更不改变候选本身**——评审始终只出报告。

**重试路径在 live 至今没有真实触发过**：接上之后跑的两次都一次就成，只证明改动没有破坏正常路径，
**不证明重试能救回来**。同一个包三次回放的结论还明显不同（`verdict` 从「2 pass / 2 revise」到
「2 revise / 2 drop」，因果断裂 2→3 处，`recommendedOrder` 三次都不一样）——「包与包之间很不齐」
现在还要加上**同一个包内部也不稳**。

**⑧ 命题定向修订 `storyCandidateRevision`（2026-09-10）**（`POST /api/story-candidate-revision`）。
评审只出报告、不改命题，这一档才是唯一会改动命题正文的地方——但它同样**只出候选、不签发任何东西**：
不写回 `themeVariants`、不进 lineage、不 stale。签发只发生在用户点「采纳」的那一刻。

**驱动信号是逐条锚定的那两类，不是 `verdict`**：上一段那组数字就是依据——`verdict` 与
`recommendedOrder` 在同一份输入上三次三样，而两个信号都逐条锚定（断裂锚到拍号，机制锚到清单 id）。
**一次只修一个命题。**

**两个信号，两套修法，不能混（第二个是 2026-09-11 补的）。** `coherenceChecks` 是「因果说不通」，
**必须修**，基本都能靠改写解掉；`mechanismChecks` 里判 `not_depicted` / `partially_depicted` 的是
「原片有、这个命题没接住的机制」，**由修订模型判断该不该接**。补第二个信号的依据是实测：
V4 被判 drop 的主因是三条机制全部 `not_depicted`，评审 summary 也写着「最该先改的是补充转赠动作」，
而修订当时只收到那条最轻的空间断裂，于是只把「小木箱」换成了「高脚木凳」——四条问题里最轻的
那条被修了，最重的三条根本没送到。`candidateUnmigratedMechanisms` 把机制正文按 id 从顶层
`sourceMechanisms` 查回来一并送出（`mechanismCheck` 自己只有一个 id，光送 id 模型做不了事），
查不到就整条丢弃、不编造。

**接机制必须有拒绝出口。** 原片那条机制没被接住不等于这个命题必须去接——一个刻意写成
「不靠外部奖励、自己满足」的故事，硬塞「获得表扬再转赠」不是修订是换故事。模型逐条判断，
拒绝时必须在 `changeSummary` 写明理由，不许假装接了或沉默跳过。与「`verdict: drop` 只是一句话」
同规格：**评审的判断不是命令。**

**与「不要靠加戏」的冲突靠提优先级解决，不是二选一。** 两条硬约束互相矛盾时模型只会随机选一条。
现在「不要往上堆」升为**铁律 4**、两类共用，只是宽严不同：第一类连换都不用换，第二类允许换但
**必须一换一**，拿不掉就回到拒绝。同批还补了一条：「换一个更好用的道具往往只是绕过问题」——
09-10 那次把小木箱换成高脚木凳，链条表面通了、故事一个字没变。

**修法小节跟着问题走**，没有那一类问题就整段不出现（有修法没问题会让模型去找活干）。这条是
单元测试抓出来的。

可写范围分三档（`src/story-candidate-revision.js` 各有一份常量）：**可写**是
`storyOutline[].action` / `emotion` / `estimatedSeconds`、`keyDialogueDirections`、`newTask`、
`environmentPressure`、`logline`；**派生或签发、出现即拒**是 `keyChoice` / `climax` /
`emotionalPayoff` 与 `transformationProof`；**冻结**是 `id` / `title` / `oneLineHook` /
`verticalFit` / `narrativeMode` / `characterSetup` / 两个拍号、每拍的 `beat` / `phase` /
`dramaticFunction`，以及全部自我评价字段。

`newTask` / `environmentPressure` 可写的依据是实测：一轮评审报出的三条断裂里**两条的根在任务设定**，
只改动作链改不掉。`dramaticFunction` 冻结的理由不同——它是 `storyCandidateStructureSignature`
的输入，让模型改它等于让它动 `validateVariantStructuralDivergence`。`title` 冻结是刻意的：
让人始终能在卡片上认出是同一个命题，也守住「修订」与「换一批」的界限。

**只覆盖、不增删**：模型按 `beat` 号定位、只列真正改了的拍，拍集合因此由构造保持不变。
闸门全是形状与字符串比较，另加一条 `CANDIDATE_REVISION_NO_CHANGE`——交回一份与原文逐字相同的
修订不是格式错误，是没干活。

**服务端独占合并，并从头复验。** `assertOnlyCandidateRevisionFieldsChanged` 跑在重新派生**之前**
（那一刻三个投影还是原值，正好证明模型没绕过「派生字段不可写」），之后
`deriveStoryCandidateProjections` 才按新 action 重新派生，再走完整校验链。**不传 upstream**
（`source` 逐字未变），**固定角色边界照常验签并复验**。提示词只带目标命题这一个，不带同批其余
命题、不带原片、不带 verdict；唯一与评审投影相反的是 **`dramaticFunction` 要送**——不能改但必须
看得到。走 coordinator、`maxProviderCalls: 2`、禁止第三次。

**采纳的代价是整批的**：`themeVariants` 是一份 Artifact，签发新版本会递归 stale 这一批全部命题的
下游，哪怕别的命题一个字没改。浏览器采纳前照「换一批」的规格征求同意，文案写明这一点。
**修订最省的用法是在选中命题之前**，那时代价为零。

**三条没有确定性兜底的**：执行者反转；一换一但复杂度暴涨（**本版刻意不设动作数量台账**，
命题阶段没有对应实测，凭推断加闸门违反「不得顺手扩大范围」，改为并排展示并数出动作链字数）；
以及 `dramaticFunction` 名义还在、实际已不成立（它是冻结字段、逐字未变，闸门查不出功能还在不在）。


**⑨ 双证据、原片骨架对照与换皮闸门（2026-09-12）。** 三处判定修正，全部在评审阶段。

**先记被证伪的四个想法（五组真实实验、约 60 次调用），不要重做**：①用 `citationCoverage`（LCS）确定性算表面相似度——六组 24 个候选跨度只有 0.049，已知是「四个同一个故事」的那组只比最低的高 0.05；LCS 量字面重合，而换皮恰好换掉全部字面只留结构，**这条路走死了**。②把 `storyEngine` 抽象成机制层——它根本不进候选提示词，观测到的差异实为改简报导致角色边界重签，**归因错误已撤回**。③Transfer Kernel（先规划机制再生成）——兑现率 80% vs 54%、与原片事件链重合 52.5 vs 40.0，而**盲评剧情质量 73.8 vs 85.6（六项全输）**：顺序反了，模型面对明确清单会找最容易证明自己做到的写法，那就是原片那个桥段。**机制迁移不得做成生成侧硬约束。**④拿掉候选提示词那 111 条否定式约束——四个候选当场塌成同一个故事，**不能删**。

**A. 双证据，只对真正需要前因的机制。** `mechanismCheck` 的 `whereInCandidate` 拆成 `causeEvidence` 与 `actionEvidence`；判据挂在**共享清单**上——`sourceMechanism` 新增必填 `requiresCause`（boolean），闸门只对 `true` 的机制生效：`verdict === "depicted"` 时 `causeEvidence` 必须非空，诊断码 `CANDIDATE_REVIEW_EVIDENCE_INCOMPLETE`。依据是三条实测的「已兑现」证据全是「第 5 拍把某物别到某人身上」，只有转移动作、没有前因；按双证据重评，整组兑现率从 70.8% 掉到 54.2%。**标记不放在逐候选的 check 里**：放在那儿，模型想让哪个候选过就对它写 `false`；放在清单上，改一次等于对全批放水——与 ⑥ 同一个招式。**接收方合不合格只看故事前面写没写出相应贡献，不看角色身份名称**：搭档、同伴、宠物一样可以是默默付出的那一方，反过来写成长辈也不因身份就算数；起因是一条证据被「接收方是并肩搭档」否掉，那是按身份名称直接判错。**这一条没有兜底。**

**B. `sourceScaffoldOverlap`：逐个候选与原片比，不是候选之间比。** 现有评审只比候选之间的差异，从来没比过候选与原片——四个候选彼此完全不同仍可能各自复刻原片，是两个独立问题（实测一组 12 个候选里 9 个任务性质与原片同类，候选间的重复检查一条都没报出来）。**判据是事件链**：`eventChain`（1–6 条）逐条写 `sourceEvent` → `candidateEvent` → `beatIndexes` → `linkage`（`same` / `reordered` / `different` / `absent`），问的是**因果接法与先后顺序是否相同**；`taskType` / `midSection` / `rewardSource` / `rewardHandling` / `endingShape` 降为辅助观察，**每项都允许 `not_applicable`**——那五项是照着「做任务—获奖—处理奖励」的参考片写的，无任务无奖励的生活片会被逼着乱填。任务同类、都在傍晚收尾、都有双人协作**本身都不足以判换皮**。`score` 是 0–100 整数，只看那条链。拍号与另外两个数组共用 `checkBeats`。

**C. 换皮闸门只有分数一个条件，刻意没有机制兑现率前置。** `score >= 70` 且 `verdict === "pass"` 即失败，诊断码 `STORY_CANDIDATE_REVIEW_PASS_WITH_SCAFFOLD_COPY`，纯整数比较零语义。原方案的「兑现率 ≥ 2/3 且分数 ≥ 70」有个明确漏洞：候选照搬事件链但情感前因没写好、兑现率反而低，就从闸门底下走掉——**换皮越彻底越安全，方向反了**；而 A 让这个漏洞必然发生（双证据把实测兑现率压到 54.2%，已低于 2/3，两条一起落地闸门永不触发）。阈值来自单次盲测（换皮组 95、正常组 10–50，**8/8 准确分类**，三轮重复性远好于 `verdict`），**但只验证过差距极大的两组之间**，中间地带样本三次跳了 25 分——**只能当分类器，不参与 `recommendedOrder`**；**不是最优值，不得为放行某个候选而下调**。判定只有一份：`SOURCE_SCAFFOLD_COPY_SCORE` 在 `public/story-review-metrics.js`，提示词、校验器与浏览器摘要共用。纯 shape 的检查只留在 schema，校验器里不重写第二份。

**事件链下界是 1，不是 2**：初版写 `minItems: 2`，落地当天用一份只有一个动作的原片打了两次真实调用，两次的第一次尝试都老实写了一条、被 schema 拒掉，重试时模型**编了一件原片没有的事**并把分数从 20 抬到 85。**要求填满而不留出口就是在逼模型编造**（与 `原片没有` sentinel 同理），原片有几件关键事件不可从我们这边唯一推导，「挑 3–5 件」只留在提示词里。那次输入是占位候选，只证明失败形状存在，不构成判定质量的结论。

**已知缺口**：`requiresCause` 与骨架分都是模型自报，全写 `false` 或压分都能绕过（与 `narrativeMode` 同型）；「前因对不对」「事件链读得对不对」需要语义判断，无兜底；**换皮闸门在 live 至今未触发过**，与 `STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK` 同处境，**触发之前不得声称它有效**。消费者面这次一并改了（浏览器两格证据、需要前因标记、骨架对照整块、`scaffoldCopies / scaffoldScored`；旧报告整段不显示），定向修订的 `candidateUnmigratedMechanisms` 改读 `actionEvidence` 并把 `causeEvidence` 一并送进提示词，旧键留一个回退——评审报告只活在页面上，而页面不会因服务端重启而刷新。

**⑩ 升级为「选题终审编辑」（2026-09-12）。** 评审此前只回答机制迁移、动作链自洽、骨架换皮三件事，现在同时回答「一个不了解创作背景的普通观众看完会不会继续看、能不能看懂、记不记得住角色、结尾的回报值不值得等」。仍然只出报告。

**A. 四个概念分开，候选级 `verdict` 不再由模型自报**：`11 维分数 → overallScore（加权）→ tier（五档）→ scoreBasedVerdict → 取最严 → effectiveVerdict + verdictOverrideReasons[]`，全部服务端派生。硬闸门三条：`coherenceChecks` 非空、`sourceScaffoldOverlap.score >= SOURCE_SCAFFOLD_COPY_SCORE`、`dominantDefect.severity === BLOCKER`（给模型一个显式一票否决口，不必靠压分）。**降级只改 `effectiveVerdict`，绝不改 `overallScore` 或 `tier`**——压分实现降级会把「故事很好但有一处硬问题」压成「故事不好」。报告因此能如实写成「9.2 分 / 最高档，但因果断裂未清 → 不放行」。**这条取代了 ⑤ 与 ⑨ 的两条 verdict 闸门**：它们从「拒收报告」变成降级理由，该类失败由构造消除（模型没有 verdict 可写错），代价是两个诊断码不再出现在 live——而它们本来就从未在 live 触发过。`recommendedWinner` / `runnerUp` / `rejectOrRegenerate` 同理改为派生，杜绝「判了淘汰却不在名单里」。

**B. 十一维权重（合计 1.00）在 `public/story-review-metrics.js` 一份**，提示词、校验器、浏览器共用：openingHook .10 / causalLogic .10 / protagonistAgency .08 / characterSpecificity .12 / storySpecificity .10 / originality .10 / progression .10 / emotionalPayoff .10 / visualMemorability .10 / productionFeasibility .05 / dialogueAndNaturalness .05。闸门只查齐全、无未知、无重复、0–10。**这条与剧情体检（以及已删除的分镜终审）写进契约的「不打总分、不设门槛」正面冲突，是用户看到数据后仍明确选择的路线**：那两处的依据是 13 份综合分全部挤在 7.8–8.3（中位 8.2，参考片 8.4）、两个模型评同一份 Plan 总分只差 0.06 而单维差 ±1.0。候选阶段没有自己的数据，所以先落地再用真实回放判断；要量的清单见 `docs/候选评审判定修正-落地方案-2026-09-12.md`，攒够 10–20 个批次前**不要凭感觉调权重**。

**C–F**：`dominantDefect` 定死枚举（type = 十一个维度 id ∪ brief_overconstraint / template_convergence / none，severity = BLOCKER/MAJOR/MINOR/NONE，带 `none` 出口，不逼模型硬找毛病）；顶层 `batchTemplateConvergence` 检查整批是不是共用同一套深层机制（**集合属性**，逐个看每个都能声称原创，横着看才发现是同一个故事换四套布景；与生成阶段 `validateVariantStructuralDivergence` 的字面签名比对是两件事）；`briefAlignment` 单独输出**不进质量分**（算进去评审就会学成「谁最像简报谁分高」），冲突判 C 类时在 `suggestBriefChange` 里**建议改简报**而不是逼候选改回模板；`top3RevisionSuggestions` 遵循 REPLACE BEFORE ADD，**除 `remove` 外四种 kind 都必须写 `whyOnlyHere`**（模板化不只发生在新增：「把结尾替换成摸摸头」是 replace，照样是模板）。

**G. 输入新增三份，按允许清单投影**：`creatorProfile`（硬事实）、`creativeBrief`（四项，**可以质疑的创作假设**）、`referenceAnalysis`（只送 retentionDrivers 与 dialogueStyle）。**简报不是原片事实**——机制清单与骨架对照的基准仍然只有 `sourceScriptReconstruction`。候选投影补送 `keyChoice` / `climax` / `emotionalPayoff`：它们由服务端从 `storyOutline` 按拍号确定性派生，保证与动作链逐字一致，**但拍号是模型选的，「这一拍真的是关键选择」仍要评审自己判断**。`creatorTasteProfile` 全项目零命中，本版不做（并进 `creatorProfile` 会作废全局角色边界）。

**H. 输出体积**：4 候选 × 11 维 = 44 条证据，`storyCandidateReview` 因此在 `buildStageDefaults` 单独把 `maxCompletionTokens` 抬到 32768（只改这一档，不碰全局默认）；提示词给长度预算但**不做 schema maxLength**（超一字 fail closed 会白烧一次调用）；**截断走单独重试分支**（`MODEL_OUTPUT_TRUNCATED` 已由 coordinator 抛出，原来的 retryPrompt 只认校验诊断，截断时原样重发只会再写超）。预算仍是 2 次。

**I. 首次真实回放当日补的三类漏判（2026-09-12，报告见 `docs/实验数据-2026-09-12/`）**：`ownership_or_authority`（`causalLogic` 另查一条世界规则——角色修改、拿走、赠送、销毁或长期占有一件物品时有没有处置权或谁许可过；**至今没有被清晰正面案例检验过**）；`setting_assumption`（候选偷偷引入上游从没建立过的背景事实，**确定性封顶 MAJOR**，`CANDIDATE_REVIEW_DEFECT_SEVERITY_CAP`——它是候选自己加的设定，不是对已签发角色事实的违反，而 BLOCKER 在这里有机械后果；封顶是政策决定不是推导）；`physicalAssumptions`（物理机制**不许二选一**，三档 established/conditional/unlikely，后两档必须写出依赖条件与失败风险，`CANDIDATE_REVIEW_ASSUMPTION_INCOMPLETE`）。第三条**明确有效**——实测把「下雨天用胶带贴湿落叶防水」从「物理上可行」翻转为 unlikely 并顺带报出一处因果断裂。**代价**：同一个包第二次回放总分极差从 2.72 缩到 1.33、九维极差变小、首选从 pass 掉到 revise，且能看出具体路径（V2 的 productionFeasibility 9→7 恰对应它被判 conditional 的那条机制）；**但单次对单次分不清是改动效果还是回放噪声，要分开需同一契约下重复回放取分布，不要因此回头调权重或删掉物理审视**。

**J. 跨包回放命中了 `batchTemplateConvergence` 的一个带标准答案的已知正例（2026-09-12）**：「身体拟物」那一批（泥坑企鹅滑行／人形晾衣杆／飞机翅膀／螺旋桨），外部评审当时写出过期望输出「角色通过把身体想象成工具或交通工具来解决日常问题，V1–V4」，本阶段独立写出同一条机制、四个候选全中，并多找到一条对方没提的（四个都用同一个拟声词）。**目前最强的一次验证。** 同一次里四个全 `drop`，`recommendedWinner` 派生为空——「全批淘汰」分支第一次在 live 走到。**但同一次也暴露两个不得当成已解决的问题**：①简报判断方向在两个包之间**完全相反**（一个说放宽「外部奖励转赠长辈」，另一个说强制保留），后者还与它自己抓到的收敛结论有张力——**`briefAlignment` / `briefProblemsDetected` 目前不稳，不得当成改简报的依据**；②`recommendedOrder` 与派生总分**不一致**（推荐先做 6.83 分的 V1，而 V4 是 6.89），说明加权分与模型整体排名不是同一件事，**本版刻意不为此加闸门**，但要进统计。

**K. 抖动测量（2026-09-12，两个包各 3 次，同契约同输入，约 ¥4.6，数据在 `docs/实验数据-2026-09-12/抖动回放/`）**：①**「分数收窄是改动造成的」不成立，已撤回**——同契约三次的批内极差本身在 1.33/2.06/1.72 浮动，旧契约那次 2.72 落在噪声内，不要为此调权重或删物理审视；②**加权分能可靠分出最好与最差，分不出中间次序**——有真实差异的包里最佳候选 3/3 排第一、sd 仅 0.09，中间两个 sd 0.45–0.46 且排序三次三样，**`recommendedOrder` 的第一名可用、中段不可用**；③**`briefAlignment` 明确不可用**——同一输入同一候选三次给出互相矛盾的合规判定（PASS/WARN 直接对调过），只能当线索给人看。同一轮里**重试路径第一次在 live 触发并成功**（`briefProblemsDetected[0]` 被写成对象 → schema 拦下 → 带诊断重做通过），根因是输出模板给的是空数组、没有元素示例，与已删除的分镜终审 `shotEvaluations[].issues` 同型，已补非空示例并加测试锁住。

**L. 抖动数据到手后的三处定型（2026-09-12）**：①**两个「谁更好」的系统拆开命名，都不删也不强制对齐**——`recommendedOrder` 改名 `holisticPreferenceOrder`（模型的整体判断，仍走排列校验），另加服务端派生的 `scoreOrder`（加权分从高到低，同分按原顺序），**winner / runnerUp / rejectOrRegenerate 改从 `scoreOrder` 派生**；依据是加权分能可靠分出最好与最差（最佳 3/3 排第一、sd 0.09）而分不出中段（sd 0.45–0.46），winner 只取第一名正好落在可靠段。两份不一致**是有价值的观察不是错误**，提示词明说不必一致、不得为此回头改分数，页面在不一致时点出来；**不必去修中段不稳**——水平接近的创意本来就有审美随机性。②**`briefAlignment` 正式降级为编辑参考信息并完全隔离**：继续输出，但不参与分数/tier/verdict、不自动改简报、不作为定向修订的强制任务，有测试锁住「改它不改变任何派生结果」。③**`physicalAssumptions` 新增 `literalDependency`（required / optional / make_believe）**，与 `confidence` 是两个正交轴（前者问「故事需不需要它真成立」，后者问「现实里成不成立」）；**扣分只针对 `required` 且 confidence 不好的**，`make_believe` 不得因现实做不到而扣 `productionFeasibility` / `causalLogic`，只提醒镜头别拍成实的。起因是《罐装阳光》被判 conditional 后 productionFeasibility 9→7，说明模型把「不是现实物理」当成了质量问题，会误杀童真想象。**③ 没有新增闸门**——是否照此扣分需要语义判断。

**M. 回应型台词：先问它在回应什么（2026-09-18，数据见 `docs/story-review-dialogue-response-ab-2026-09-18.md`）。** 起因是《蒲扇下的毛豆游戏》第 5 拍「剥了一个最大的喂进奶奶嘴里，清晰地说了一句「谢谢」」——付出的一方自己道谢。五次模型输出对白维度全部 9–9.5，其中两次的理由直接就是「符合简单人话设定」「符合角色限制」，展开前体检的 `keepThis` 还要求保留它：creatorProfile 作为硬事实送进来，「会说谢谢」被读成合规加分，而第 11 维原来只问「对白像不像这个角色会说的话」。现在第 11 维先问「它回应的是观众刚看见的哪个动作、刚听见的哪句话」「观众能不能不靠猜就说出他在谢什么」，写明「合乎说话限制只是底线，不是加分理由」；`contradiction` 补上「台词与同一拍动作方向相反」这一形状（抽象写法，不含具体名词，同 ⑤ 的举例纪律）。报进 `coherenceChecks` 即派生 `coherence_break`，展开前体检沿用现有路由送进 root 修订，**路由与闸门代码逐字未改**。**只做到了一半，落地时用户看过数据明确接受**：事前登记要求毛豆 2/2 进因果断裂，实测 1/2（另一次看出来了——「观众需猜测是谢烹饪还是谢陪伴」——却只扣分没升级）；新正例信箱、风铃各 2/2，理由只写在候选括号里的录音笔 0/2（评审读得到括号，观众读不到）；有效反例 0 误报。漏掉的由剧情体检 `dialogue_logic` 兜住（毛豆 3/3）。端到端：生产 root 修订收到这条断裂后把「谢谢」改成「奶奶吃」，只动这一处。第一版只问「方向对不对」，模型会替它找理由（「回应了奶奶煮豆子的**隐性付出**」），**不要退回那个问法**。判得对不对没有确定性兜底。

**已知缺口**：分数准不准、收敛判得对不对、简报冲突成不成立、`whyOnlyHere` 答得成不成立全是语义判断，**没有兜底**；十一维评分本身是最大的未验证假设；拆成「盲评 + 简报对齐」两次调用是明确不做的后续选项；修订路径按严格 schema 校验传入报告，**旧形状报告会被 400 拒掉**（重新体检即可）。

**不打总分**（§剧情体检已实测总分没有分辨力；**候选对照评审自 2026-09-12 起是明确的例外，理由与代价见上面 ⑩B**）。`verdict` 的 `drop` **只是报告里的一句话**：不删候选、不重新生成、不触发任何 stale，分布校验（`STORY_CANDIDATE_NARRATIVE_MODE_MIX`）不受影响，淘汰与否由用户决定。评审默认沿用 `variants` 阶段的 provider，也就是写这些候选的那个模型，**自己批自己会偏松是已知偏差**，如实记录、不靠静默换家掩盖；它是纯文本阶段，可按阶段 override 换任意一家。

---

## 剧情体检 = FullStory 终审编辑（`story-quality-review/2.0`，2026-09-18）

Full Story 生成之后的**独立验收，只出报告**：不修改剧情、不签发 Artifact、不进 lineage、不参与派生、不 stale 任何东西、**不阻断后续 Animation Plan**。与 `boundaryWarning` 同规格，纯展示；刷新页面即失。手动触发，`POST /api/story-quality-review`。三层评审里它回答**「选中的故事有没有被展开坏」**——候选对照评审选哪个故事，4.0 自主分镜自带的审阅查镜头有没有实现坏。

**两次顺序调用，第一次看不到候选**：① 编辑诊断（只有 fullStory 与固定角色设定，输出十类 `issues`）；② 承诺核对（候选 + fullStory，只输出 `checks`）。依据是 2026-09-18 五轮离线 A/B（约 60 次真实调用）：两件事放进同一次调用时，被漏判的那句话每次都被同一次调用引用成「承诺已兑现」的证据；拆开后手段-目的冲突 1/2 → 2/2，`missing_reference_state` 0/36 → 2/2 且对已修好的版本 0/2。

**1.0 的两张覆盖表已删除**：`sceneFunctionChecks` 被实测为重言式（六场全判 depicted，同时漏掉四个真问题）；`retentionChecks` 的对象 `retentionPlan` 在 `full_story/1.1` 里已不存在。**代价：2.0 没有「模型逐场看过」这个确定性覆盖属性。**

**服务端派生、模型不写**：`promisePreservation.status` 由逐条 status 算出（任一 MISSING/CONTRADICTED → FAIL，任一 WEAKENED → WARN，否则 PASS）。**`checks[].source` 是枚举数组**（`PROMISE_SOURCE_FIELDS` 只有一份），只能指向候选字段或固定角色设定，剧情自己的 `characterBible` 结构上写不进来——实测模型写出过自证式来源。

**台词分三档**：措辞不是承诺；台词交代的**事实**是（对白、动作或画面成立都算）；**表演形式约定本身就是承诺**。依据是 `fullStoryPrompt` 自己写的「不能因少写台词丢失剧情前提」。**编辑诊断先分三档再报**：明确矛盾 / 信息不足 / 可选优化，只有第一档能判 MAJOR/BLOCKER。

**第十类 `dialogue_logic`（2026-09-18，数据见 `docs/story-review-dialogue-response-ab-2026-09-18.md`）**：逐句问台词回应的是观众刚看见的哪个动作、刚听见的哪句话，说话人凭什么知道话里的事；回应型台词（道谢、道歉、夸奖、答应）再问「**观众能不能不靠猜就说出他在谢什么**」——要猜就是接不上，没演出来的「隐性付出」「平时照顾」不能替它圆，**台词符合语言限制、或是角色表里登记的招牌动作，只说明能说、不说明该说**。它与 `fullStoryPrompt` 早就有的两问（「此刻为什么对这个对象说」「凭什么已经知道」）一一对应——此前生成侧有、评审侧没有。起因同候选评审 ⑩M：毛豆结尾那句「谢谢」，旧编辑诊断 0/1，第一版（只问方向）0/2——剧情自己的角色表把「双手捧脸颊表达感谢」登记成了招牌动作，评审读成「严格符合设定」。第二版毛豆 2/2（落地后开发服务器上再跑 1/1）、新正例 8/8（旧提示词 2/4 且都只判 MINOR），12 次反例里方向正确的道谢 0 次被报；另报出一条「画面是竹匾、台词说篮子」，确有其事但判成 MAJOR 偏重。**第二版比第一版严**：边界样本「递画谢刚当过模特的对方」也被判接不上。端到端：体检报出后交给「按问题修改」，它在喂完之后补半句「奶奶笑着也剥了一颗喂进小白子嘴里」再道谢，两条候选承诺都保住、签发校验通过。**判得对不对、判多重都没有确定性兜底**；5 份正例里毛豆是设计样本，过线只说明在这批样本上不再漏。

**允许第一次做错**：两次调用各 `maxProviderCalls: 2`、禁止第三次，`metadata.storyQualityReview` 如实上报调用次数与每次被拦的诊断。`evidenceInCandidate` 只展示、**绝不当闸门**（阈值已被实测证伪，且它分不开真假阳性）。

**已知缺口**：失去逐场覆盖保证；三档严重度、「事实有没有被别的方式承载」、`type` 归属都没有确定性兜底且会朝过严方向抖；`type` 归属不稳，**不得按它做统计或闸门**；五轮全部跑在同一批开发回归集上，**至今无任何全新盲样本**。

「有没有兑现」本身是语义判断，**没有确定性兜底**：校验只保证形状与引用真实，不保证它看得对。

**明确不做，三条都有实测依据**：①**不打总分、不设门槛**——实测 13 份的模型综合分挤在 7.8–8.3、中位 8.2，ChatGPT 给参考片也才 8.4，此刻画任何线都是拍脑袋；可比对的数字改由 `public/story-review-metrics.js` 从逐条判定里**数出来**（未兑现数、三档硬伤数），跨故事直接可比、不随措辞漂。②**不自动改剧情**——实测「评审→重写」单轮平均只涨 +0.17（6 组对照，落在评分者噪声 MAD 0.45 内），且 40% 撞契约硬失败。2026-09-18 起有用户逐条勾选、看过逐字对照才签发的「按问题修改」（见下一节），它是局部替换不是整篇重写，**服务端仍然不会自动写回**。③**不阻断生产**——现有闸门全是确定性的，模型意见当硬闸门是另一回事，「当前全局角色边界」一节明写「用户明确肯定/否定 > 已签发模型推断」。

**评审模型的已知偏差**：默认沿用剧情阶段的 provider，也就是写这份剧情的那个模型，自己批自己会偏松（实测同一份剧情自评「AI 可执行性 8.0 / 物理可信度 8.0」，外部模型给 6.8 / 6.8）。本来要默认换一家，但同一批 10 份实测下来现有备选都不胜任：`mimo-v2.5-pro` 7/10 成功且太松（2/62 处 vs 千问 13/91 处），`deepseek-v4-flash` 5/10、反复产不出严格 JSON，`deepseek-v4-pro` 连接中断。一个查不出问题的评审比偏松的评审更没用，稳定性也是硬要求。**先用能干活的那个并如实记下偏差，不靠静默降级掩盖**；它是纯文本阶段（不在 `requiresMediaModel` 里），可按阶段 override 换任意一家。

## 剧情按问题修改（`story-quality-repair/1.0`，2026-09-18）

剧情体检之后的**修订稿**：用户在体检报告里勾选要修的条目（编辑诊断与没守住的承诺；引用号 `I1…` / `P1…` 由 `storyQualityRepairableItems` 按位置编，浏览器勾选框与服务端选择校验共用一份），`POST /api/story-quality-repair` 另起**一次**调用写局部修改。**只出修订稿，不签发任何东西**——与命题定向修订同规格：用户看过逐字对照、点「采纳」时才由浏览器走既有 fullStory 签发（依赖清单与生成剧情共用 `fullStoryDependencyIds`），新版本递归 stale 该变体的镜头计划与媒体。只支持 `full_story/1.1`（旧格式还有 beatSheet 这第二份动作稿）。

**体检本身不动；修改另起一次调用，而且看得见候选——与编辑诊断刻意相反。** 依据是 2026-09-18 两轮真实测试（5 份样本 × 2，记录见 `docs/story-quality-repair-ab-2026-09-18.md`）：第六轮让编辑诊断顺手附带修改，逐字执行与签发校验 30/30 通过、复检修好率 81%，但**打上的 32 条里 4 条把候选承诺改弱或改坏**（「双手扶着」→「双手松开」判 CONTRADICTED 等），另 1 条删光路人少女的出场、她却还登记在 `characters` 里——根因是编辑诊断刻意看不到候选（那是它诊断准的原因）。第七轮用同一批问题改成独立调用，输入候选与「现在守住的承诺」清单：承诺退化 4 → 1，修好率 85%，执行与校验 26/26，19% 的条目模型选择不改。

**模型只写 `{sceneId, field, find, replace}`，原文由服务端逐字替换**（`applyStoryRepairPatches`，`src/story-quality-repair.js`），判定全是字符串比较、零语义：

- `field` 只能是 `visibleAction` / `shotAndSound` / `dialogue`（`STORY_REPAIR_PATCH_FIELDS` 一份）；一条问题最多 3 处，**原子执行**；
- `find` 必须在该场该字段**逐字出现恰好一次**，0 次或多次都拒、不猜；台词里「整句原文 + 空替换」= 删这一句，只删半句导致台词变空则拒；
- **不得让一个出镜角色从本场的动作和对白里消失**（`STORY_REPAIR_REMOVES_ON_SCREEN_CHARACTER`）：增删出镜角色要改 `characters`，不是文字替换能做的事；
- 逐条合并，**每一条采用前整份剧情重跑与 `createFullStory` 同一条签发校验链**（`validateFullStoryForSigning`，一份定义、两处调用）；过不了只拒这一条（`STORY_REPAIR_RESULT_INVALID`），原文已被前一条改掉的如实标 `STORY_REPAIR_CONFLICTS_WITH_EARLIER`；`assertOnlyStoryRepairFieldsChanged` 自证可写字段之外逐字节不变。

**出错分两种**：模型输出结构不对（条数、引用号顺序、字段类型、`note` 缺失）整份都用不上，带诊断重试一次、禁止第三次；单条执行不了只拒那一条，**不为它整份重做**——重做会让已经写对的那些条跟着抖。「不改」是合法出口，必须写 `note`。`metadata.storyQualityRepair` 如实上报调用次数与被拦诊断；它走 `modelCallCoordinator`，自己接 `attemptObserver` 写侧车 scope `storyQualityRepair`。

**没有确定性兜底、页面必须摆在采纳按钮前面的**：①删掉的是不是候选承诺过的细节——第七轮唯一那次退化是**明知故犯**（承诺就在清单里，为解决一条 MAJOR 的节奏问题删了「均匀」「石头」，`note` 如实写了删了什么）；②动作的执行者有没有被调换；③同一条问题两次决定会抖（同一处「完好的干花」一次拒改一次改）。按字面比对「删掉的字在不在候选原文里」会被常用词淹没，与已证伪的 `evidenceInCandidate` 阈值同类，**不做**。

**毛病出在候选本身时它会拒改**（候选高潮原文就是「戳破并卷起」），那类问题要回到候选层（展开前体检 / 命题定向修订）解决；本版**不提供**「接受偏离候选、强制改」的出口。样本只有 5 份（4 份开发回归集 + 1 份盲样本），全过也是偏乐观的上界。首次生产路径真实调用（《糖浆泡泡糖葫芦》，36 秒、3419 completion tokens）：5 条里 3 条因候选冲突拒改、1 条把本场没登记的「路人小孩」写进可见动作被签发校验拦下、1 条（「透明」承诺）改成并采纳签发为 `fullStory-V2-r2`。

---

## 当前模型 provider 边界

工作流 LLM provider 包括：

**文本客户端流式传输（Qwen 2026-09-05；MiMo 2026-09-22）**：Qwen 与 MiMo 对全部模型发送 `stream: true`，响应共用 `src/sse-stream.js`。Qwen 额外发送 `stream_options: { include_usage: true }`；MiMo 官方接口直接在 SSE 尾块返回 usage，实测无需该未文档化参数。MiMo 的模型、thinking、JSON 模式、媒体内容和原有输出/媒体修复预算不变；成功与断流均先记实际收到的结构化用量，再做取消/冻结检查；推理与正文分离，每 10 秒最多一次 Durable 心跳，不完整流绝不作为结果提交，也不降级非流式。HTTP 错误仍读取普通错误体。DeepSeek 本次未改，仍为非流式。页面仍只展示已完成并校验的业务结果。Animation Plan 输出日志并行读取响应 clone，结束前不阻塞客户端接收 SSE；日志只投影正文与 usage，断流不标通过。验收见 `docs/mimo-streaming-2026-09-22.md`。

**单次请求的思考开关（2026-10-09）**：三家文本客户端的 `requestCompletion` 新增可选 `thinking: "enabled" | "disabled"`（`src/thinking-override.js`），只有导演助手会传，用来在全局开着思考时让一条对话几秒出结果。**不传时请求体逐字不变**（`test/text-client-thinking-override.test.js` 用改动前算出的金标准锁住，含键顺序）。千问的 GLM-5.3 关不掉思考，要求关闭时客户端抛带码的 `ModelResponseError`（`MODEL_THINKING_UNSUPPORTED`；不用 TypeError，协调器会把它当成网络故障重试），导演助手在调用之前先给出 400，不静默照开。

依据是 debug 侧车的实测：非流式长请求会在约 306 秒被上游掐断。kimi-k3 与 qwen3.8-max-0902 各两次，耗时 306503 / 306696 / 306704 / 306861 ms，浮动仅 358ms、**跨两个不同模型**——是确定性的固定超时，不是网络抖动；四次全部 `usage: null`、`finishReason: ""`、零字节输出。而全部成功调用 ≤ **234 秒**（最慢是 qwen3.7-max 的 variants，14321 completion tokens），余量只剩 72 秒。**悬崖在传输层不在模型**，所以不维护按模型的清单——那是治标，换个更长的 prompt 就会再撞上。

**根因只定位到一半，如实记录**：已排除我们自己的 fetch timeout（`QWEN_REQUEST_TIMEOUT_MS=900000`）；也已排除本地代理（`127.0.0.1:7892`）的隧道空闲超时——实测纯 CONNECT 与 CONNECT+TLS 两条隧道静默 **600 秒以上仍然存活**。dashscope 固有往返开销实测 1.9–4.2 秒，与「上游约 300 秒响应超时 + 建连开销」一致，但**具体是哪一层未能确定**（区分需要向 dashscope 发真实长请求，会计费）。这不影响结论：只要超时判据是「长时间没有数据」，流式就是对症的。

约束：

- **流不完整必须失败，绝不返回半截内容。** 读到流结束但既没有 `[DONE]` 也没有任何 `finish_reason` 时抛 `MODEL_STREAM_INCOMPLETE`。返回半截内容会让残缺 JSON 被下游报成「JSON 格式错误」，把传输问题伪装成模型输出问题。
- 该错误码在 `classifyAttemptError` 里**必须单独分类**为 `category: "transport"` + `retryable: true`。不单独分类会落到 `ModelResponseError` 的兜底分支（`status=0` → `protocol` 且 `retryable: false`），把可重试的网络中断变成不可重试的协议错误。
- **禁止非流式自动回退。** 流式失败就如实报错——自动降级是第五节第 4 条的「失败时返回默认值」。
- **流式请求只判空闲，不设总时长（2026-09-23）。** Qwen 与 MiMo 从发出请求起，**连续** `streamIdleTimeoutMs`（`QWEN_STREAM_IDLE_TIMEOUT_MS` / `MIMO_STREAM_IDLE_TIMEOUT_MS`，默认 120 秒）没有收到任何东西才中断；等响应头也按这个判，响应头、正文、`reasoning_content`、SSE 心跳注释都算「有数据」。`requestTimeoutMs`（全局与按阶段覆盖）对这两家**不再生效**，只约束非流式的 DeepSeek——它等待期间本来就没有数据，区分不了「在算」与「挂了」。依据是 2026-09-22 MiMo 候选阶段：流一直活着、已收到 6929 个推理数据块，仍在 900 秒整被 `AbortSignal.timeout` 切断。生成总长度已由 max tokens 封顶，不需要墙钟再兜一次。等响应头超时仍是 `TimeoutError`（`MODEL_TIMEOUT`）；读流途中超时报 `MODEL_STREAM_IDLE_TIMEOUT`，与 `MODEL_STREAM_ABORTED` 同为可重试的 transport。计时器只有一份，在 `src/stream-idle-timeout.js`。Durable watchdog 在调用前按「空闲超时 + 120 秒宽限」排期（不少于 300 秒无进展窗口），读流期间每 10 秒心跳续期。
- **输出上限放到实测最大值，死循环改由边收边查截停（2026-09-24，取代 09-23 的「统一默认 32768、调大而不取消」）。** MiMo 全局、剧情、动画默认 131072（页面提供的 5 个型号 v2.5、v2.5-pro、v2.6-flash、v2.6-pro、v2.6-pro-ultraspeed 用极小请求实测全部接受，v2.6-pro 不带该参数时默认也是它），Qwen 全局与各阶段默认 65536（09-23 实测接受）；DeepSeek 非流式、中途看不到内容，仍是 32768。数值与依据只有一份，在 `src/output-token-ceilings.js`。09-23 那条的理由是「上限是模型陷入重复输出时唯一的刹车」，现在刹车换成了下一条的逐字重复检测，上限只剩「不重复但极长」这一种情况的兜底。起因：09-23 回放里 MiMo 开思考跑候选推理了 2.9 万 token 被 32768 截断、整次作废，那不是死循环，是本来就长。MiMo 的上限包含推理 token，千问看起来不含（未对照官方文档）。**重试抬额度一律「只抬不降、不超上限」**（`growOutputTokenLimit`）：此前 MiMo 客户端与 coordinator 的重试把结果夹在 32768，默认一抬高，重试反而会把上限压回去；请求里本来没写上限时重试也保持不写，让客户端默认生效（旧逻辑会把它变成 12288）。coordinator 不知道供应商是谁，只抬到三家都实测接受的 65536。
  **例外：参考片分析单独默认 16384（2026-10-05）**，Qwen 与 MiMo 共用 `ANALYSIS_OUTPUT_TOKEN_DEFAULT`（同在 `src/output-token-ceilings.js`），**不再跟随全局上限**，仍可用 `QWEN_ANALYSIS_MAX_COMPLETION_TOKENS` / 新增的 `MIMO_ANALYSIS_MAX_COMPLETION_TOKENS` 调整。依据是本机 Run 记录：09-01～09-07 的 20 次真实分析调用（qwen3.7-plus，另有 3 条 0 秒、无用量的 MiMo 记录不是真实调用，不计）completion 只有 2854–6929 token、60–138 秒；10-05 一次 `mimo-v2.6-pro` 在 65536 上限下写了 18.3 万字正文、742 秒后才以 `MODEL_OUTPUT_TRUNCATED` 失败——不是重复短句，复读检测抓不到，又没有总时长限制，能停下它的只剩上限。MiMo 的额度含推理 token，余量比千问小。**截断不重试，这就是硬上限**：分析走 `generateValidatedJson`，它给客户端显式传 `jsonRetryAttempts: 0`，视频直传与抽帧两条路径撞上限都直接以 `MODEL_OUTPUT_TRUNCATED` 失败；视频改抽帧的回退只在供应商拒收视频或返回非法 JSON 时发生，截断不触发。那次 v2.6-pro 到底在写什么**没有查清**——它的原文因全量模型输出日志一节的 `mkdtemp` 问题没能落盘。
  **按阶段换供应商时，上限取那一家自己的阶段配置（2026-10-05，用户选「全部按各家自己的上限」）。** 阶段默认值此前只按默认供应商（`resolveDefaultLlmProvider`：`DEFAULT_LLM_PROVIDER`，未设置时有千问就是千问）算一份，浏览器按阶段覆盖只发 `{provider, model}`，`resolveStage` 于是一律沿用默认供应商那一档：换成 DeepSeek 实际发 65536/131072（与上文「DeepSeek 仍是 32768」相反，它没有复读检测，上限是唯一刹车），换成 MiMo 被压到 65536。现在 `server.js` 的 `buildStageDefaults` 用同一张阶段表（`stageDefaultsFor`）给 Qwen/MiMo/DeepSeek 各算一次，由 `src/stage-token-caps.js` 的 `withProviderTokenCaps` 挂成 `maxCompletionTokensByProvider`；模型名等其余字段仍只取默认供应商那份。`resolveStage` 取值顺序为「显式覆盖 > 实际供应商自己的阶段上限 > 默认值」，任务快照 `modelSnapshotFor` 走同一函数。代价如实记着：按阶段换成 MiMo 的文本与媒体阶段上限从 65536 抬到 131072（参考片分析仍是 16384），失控输出最坏要多跑一倍时间。不带该映射的调用方（CLI、测试）行为与设置形状逐字不变；CLI 不支持按阶段换供应商。
- **流式输出陷入逐字重复时主动中断（2026-09-24）。** 共用的 `readSseCompletion` 对正文与推理各自每新增 1000 字检查一次最后 2000 字：末尾一段不超过 80 字符的单元首尾相接重复、连续覆盖不少于 60%，就关掉连接（`reader.cancel`，别让供应商继续吐、继续计费），抛 `MODEL_OUTPUT_DEGENERATE`，消息写明是正文还是推理、重复单元与次数；**绝不返回半截内容**。判定只有一份，在 `src/output-degeneration.js`，只看形状、不看内容好坏，不引入第二个模型。两个客户端都必须在「中途断开 → `MODEL_STREAM_ABORTED`」分支**之前**识别它，否则主动叫停的死循环会被当成网络中断。`classifyAttemptError` 归为 `category: "degeneration"`、`retryable: true`，与截断同口径：只在各阶段已有的重试预算内再试，不新增重试路径，截断专用的「要求压缩、抬额度」不对它生效。离线验证（`scripts/output-degeneration-replay.mjs`，扫 debug 全部 model-output）：08-30 那 12 份陷入重复的完整剧情 12/12 命中，而且都在读到第 2000 字时就判出（那批在约 490 字处就开始打转）；2184 份正常结束的输出误报 0。**它抓不到**：不逐字重复的「越想越长」、换着措辞兜圈子；推理流从来没有落盘，手里没有推理陷入循环的样本，对推理流是否有效没有验证过，那一侧仍靠上限兜底。死循环没法在真实模型上故意触发，这一路只有单元测试与离线回放证明有效。依据与回放见 `docs/output-degeneration-2026-09-24.md`。
- **截断必须在解析 JSON 之前判定（2026-09-23）。** `finish_reason === "length"` 时三家 client 的 `generateJson` 一律抛 `MODEL_OUTPUT_TRUNCATED`（`assertCompletionNotTruncated`，`src/mimo-client.js` 一份），消息写出截断前的正文字数与 completion token 数。此前只有 Qwen 判了，MiMo 与 DeepSeek 把截断报成「未返回严格 JSON」：实测 MiMo 候选阶段 16384 额度全部用在推理上、正文 0 字，用户看到的却是 JSON 格式错误。
- **内容审核拦截同样在解析 JSON 之前判定，且不自动重试（2026-09-23）。** `finish_reason === "content_filter"` 时三家 client 的 `generateJson` 与 `ModelCallCoordinator` 一律抛 `MODEL_CONTENT_FILTERED`（`assertCompletionNotContentFiltered`，`src/mimo-client.js` 一份），`classifyAttemptError` 归为 `category: "content-filter"`、`retryable: false`；client 内的 JSON 内容重试循环也不会碰它（判定放在 try 之外）。消息写明被审核拦截、已输出多少 token、供应商原文，并说明「审核结果不稳定，同一提示词重试常能通过；系统不会自动重试」。实测 MiMo 候选阶段推理 10534 token 后被拦，正文只有「The request was rejected because it was considered high risk」，此前被报成「未返回严格 JSON」并按可重试处理——那等于在第三方安全闸门上「问到放行为止」，与 §2.6 视频审核 `1027` 同一原则：是否再跑由用户显式决定。
- `delta.reasoning_content` 单独收集，**绝不混进正文**；`usage` 只在最后一个数据块里返回，缺 `stream_options` 就拿不到 token 记账。
- **`terminated` 的包装判据是「收到过任何数据块」，不是「收到过正文」（2026-09-07）。** 连接中途被对端切断时 qwen-client 把它包装成 `MODEL_STREAM_ABORTED`；判据原为 `partialContentLength > 0`，而上一条明写 `reasoning_content` 不算正文——qwen3.8-max 实测 **82% 的 completion token 是推理**（`reasoning_tokens` 23449 / `completion_tokens` 28466），于是推理期断线时正文长度仍是 0，裸 `TypeError` 漏出包装、一路冒到 HTTP 层变成不可重试的 500。实测两次（已删除的）分镜终审失败（158 秒、649 秒）都是这个形状：流一直活着、模型一直在推理。判据改为 `partialChunks > 0`；分类器逐字未改。**只改包装条件，不改「流不完整必须失败」的结论**，半截内容仍绝不当结果返回。
- 解码必须用 `TextDecoder` 的 `{ stream: true }`：一个汉字的 UTF-8 字节可能被拆到两个数据块，对每块单独解码会产生乱码。
- 返回形状与非流式**逐字一致**的 7 个字段：`content` / `finishReason` / `requestId` / `usage` / `providerName` / `model` / `raw`。`providerName` 被 `model-call-coordinator` 与 `workflow` 用于错误归属，`model` 用于用量记账，漏掉会静默降级到回退值。
- 测试 mock 必须发 SSE，判定只有一份在 `test/helpers/sse-response.js`。三个 client 共用同一个 baseUrl 的 mock 按请求自报的 `stream` 决定响应格式，与真实服务器一致。

**尚未实测**：`.env` 的 `QWEN_JSON_MODE=true` 会让非 Zhipu 模型同时带 `stream: true` 与 `response_format`。这个组合是否被 dashscope 兼容模式支持没有核实过；若不支持，应改为流式时按模型跳过 `response_format`——本地严格 JSON 校验本来就在，不依赖 provider 的 JSON mode。

**候选调用的 MiMo JSON Schema 约束解码（2026-09-24）**：MiMo 文档只写了 `json_object`，但实测接受 `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}` 并真的约束解码（嵌套 additionalProperties、数组元素类型、maxItems、enum、minimum、$ref/$defs、required 生效；流式与开思考可用；字段顺序按 Schema 强制）。只接候选调用（deriveSource 那一支）：`storyCandidatesModelSchema(count)`（`src/contracts/story-candidates-model-schema.js`）从服务端候选严格 Schema 派生，去掉 `pattern` 改用 `minLength: 1`（MiMo 把 pattern 当全串匹配，会截断字符串、开思考时吐非法 JSON），transformationProof 各项只留 replacement，去掉派生的 keyChoice/climax/emotionalPayoff，variants 锁成 `minItems = maxItems = count`（与提示词共用 `variantsCount`），字段按提示词模板排序；严格 Schema 结构变了时派生直接抛错。提示词文本不变、所有模型共用；`responseSchema` 是请求参数，MiMo 发 json_schema，千问与 DeepSeek 客户端忽略它、照旧发 json_object；选源调用、旧调用点与其他阶段不带（候选对照评审除外，见下）。候选对照评审（含展开前体检）同日按同一做法接入：MiMo 开思考两次都在 `candidateChecks` 里写出孤立字符串 `"holisticPreferenceOrder:["`、一次写出枚举外的 `dominantDefect.type`，带诊断重试也没救回来；`storyCandidateReviewModelSchema(count)`（`src/contracts/story-candidate-review-model-schema.js`）从评审严格 Schema 派生，`pattern` 改 `minLength: 1`、`schemaVersion` 的 `const` 改单值 `enum`、去掉服务端派生的报告级四项与候选级五项、`candidateChecks` 与 `holisticPreferenceOrder` 锁成候选数、字段按模板排序，coordinator 重试同样带着；提示词、校验与重试预算不变；回扫 96 份留存输出，严格 Schema 与模型 Schema 判定完全一致（59 过、37 拒）；同输入回放 2 次，评审 2/2 合法、结构失败 0/3 次调用（一次先因引用清单外机制 id 被覆盖率核验拦下，重试通过）。同次回放暴露、已处理：承诺核对第一步 `not_a_promise` 时 `promise` 写成空串被校验器拒，提示词未定义该写什么、拒绝理由进重试提示词又自相矛盾，千问 09-18 也失败过 2 次；现 `fullStoryPromiseListPrompt` 第 4 条写明这时 `promise` 写一句话说明标题为什么没有许诺看得见的东西，校验器理由按 kind 写，判定/码/路径不变；MiMo 同候选回放 4/4 通过，其中 2 次判 `not_a_promise` 都写了说明。自主分镜 4.0 的 `storyboardDesign` 同日按同一做法接入：MiMo 开思考一次把 `locations`/`props` 写到顶层、重试后又撞 `STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT`，整份 Plan 失败；`storyboardDesignModelSchema()`（`src/contracts/storyboard-design-model-schema.js`）从 `storyboardDesignSchema` 派生，`pattern` 改 `minLength: 1`、去掉未实测的 `uniqueItems`/`exclusiveMinimum`、只允许已实测关键字、其他关键字直接抛错、不锁片段数；`call()` 只在 `storyboardDesign` 及其重试带 `responseSchema`；提示词、严格校验与预算不变；同输入真实回放 2/2 通过、结构错 0/3 次调用。同日已处理：片段末尾过渡拍标「本场+下一场」而片段只写本场（结构合格的 4 份里 2 份），根因是校验器要求 beat 来源包含在片段来源里而提示词第 9 条从没说过；现第 9 条补上「演到下一场就补进片段」，拒绝理由改为点名越界与现有场次并给出两种改法，判定/码/路径不变；回放 3/3 首次调用通过、该错 0/3；但这 3 份的跨场过渡拍与多场次片段都是 0（改动前 5 份里 2 份、1 份），是否压掉了相邻场次合并待观察。参考片分析 2026-10-18 接入：MiMo 开思考两次都在 `retentionDrivers` 最后一项后漏了 `]`，`json_object` 下冒号写不出来，一路往数组里写字符串直到 16384 上限截断，复读检测抓不到；分析没有严格 Schema 可派生，`referenceAnalysisModelSchema(input)`（`src/contracts/reference-analysis-model-schema.js`）直接引用服务端判据（`src/validation.js` 的 `REFERENCE_ANALYSIS_FIELDS` / `REFERENCE_ANALYSIS_ARRAY_FIELDS`、`src/reconstruction-grounding.js` 导出的 observedFacts 与证据常量、`src/prompts.js` 与提示词共用的 `analysisEvidenceShape`），服务端不查的嵌套字段按提示词模板写死、测试锁住键集合与顺序；模型一侧比服务端严（用户确认，只收紧结构不收紧内容），五处 `evidence` 统一成与 observedFacts 相同的证据对象（《简历》那种描述字符串以后不会再有）；提示词逐字未变，校验、签发、上限、截断不重试都不变；回测 10-05 的 7 份 MiMo 结果 6/7 通过（《简历》只因那五处字符串）；同输入真实回放视频 3/3、抽帧 1/1 签发，截断与结构失败 0/5，输出 3.2k–4.8k token（改前写满 16384），其中一次因 `startSecond == endSecond` 按既有设计改用抽帧重取才签发；只有一个参考片，样本小。 见 `docs/analysis-mimo-json-schema-2026-10-18.md`。`MIMO_JSON_SCHEMA=false` 退回 json_object；接口拒绝时如实报错，不自动退回。服务端严格 Schema 与全部校验不变，仍是唯一裁决方。同上游回放：接入前 MiMo 0/7（结构失败 5 次），接入后 4/4 通过、结构失败 0；careRecipient/helper 使用率变高（helper 多为固定搭档），careRecipient 多为「独居老人」，样本小，未归因。见 `docs/variants-mimo-format-2026-09-24.md`。


- Qwen
- MiMo
- DeepSeek

DeepSeek 当前只允许用于纯文本阶段：

- Brief
- Variants
- Legacy Full Story
- Animation Plan

禁止将 DeepSeek 用于需要图片或视频输入的阶段：

- Analyze
- Reconstruct
- Visual Guardrails
- Character Reference

当前 DeepSeek 模型 ID 只登记 `deepseek-v4-flash` 和 `deepseek-v4-pro`。Flash 是页面首选项，Pro 只能显式选择；不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。`DEFAULT_LLM_PROVIDER`（只接受 `Qwen` / `MiMo`）可显式指定默认路由，未设置时保持「配了 Qwen 就用 Qwen」；指定的那家未配置时启动失败，不静默换家（`resolveDefaultLlmProvider`，`src/config.js`）。

---

## 当前全局角色边界

`Visual Guardrails` 是固定角色语义的唯一生成阶段。它允许视觉模型结合用户设定、参考分析、脚本还原和模型常识（creative_brief/2.0 起不再读简报）生成开放语义边界，不得新增本地物种关键词字典替代模型判断。

**（仅旧简报，creative_brief/2.0 已停产这些字段）**Creative Brief 的 `controlledRewriteVariables.sourceValue`、`protectedExpressions.sourceExpression` 以及 Visual Guardrails 的 `sourceSimilarityRules.sourceExpression` 在列举同一类别的多个具体物品时，每一项都必须重复完整中心名词，例如“绿色邮箱、红色邮箱、蓝色邮箱”；禁止输出“绿色、红色、蓝色邮箱（组合）”这类共享末项名词的缩写。该规则只能规范已有来源事实，不授权模型补充新物品；下游也不得通过颜色词、后缀或本地中文语法规则猜测被省略的中心名词。旧 Artifact 含歧义缩写时必须重新生成对应上游阶段，不能原地推断或改写已签发内容。其中「下游不得补全被省略的中心名词」这一半现已由确定性校验强制：`visualGuardrails.sourceSimilarityRules[].sourceExpression` 的每一并列项都必须逐字出现在本条规则自己的 `triggerEvidence[].evidence` 中，否则 fail closed（只归一化引号、空白与句末标点，不做任何中文语法推断）。上游 Creative Brief 是否写出了缩写本身仍只由 Prompt 约束——判定它需要的正是本规则禁止的中心名词推断，因此不做本地实现。

**（仅旧简报，creative_brief/2.0 已停产这些字段）**Creative Brief 的 `allowedNarrativeComponents[].component` 是服务端固定的七项 taxonomy：送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾。生成 Prompt 必须展开完整七项；模型只能填写每项非空的 `howToReuseSafely`，不得改名、合并、省略、重复或增加分类。不适合当前素材时也必须保留该项，并在说明中记录不采用或限制条件。每条 `howToReuseSafely` 必须以 `【原片有】` 或 `【原片没有】` 开头，先对原片是否真的存在该构件作出显式判定，再谈复用；该判定只描述上游 `referenceAnalysis`/`sourceScriptReconstruction` 已发生的事实，不描述新片打算怎么拍。缺少判定前缀时确定性校验直接失败，防止模型把"新片可以怎么用"写成复用授权，替原片补出它没有的叙事构件。写 `【原片有】` 时还必须用「」引出上游依据，服务端回到 `sourceScriptReconstruction`/`referenceAnalysis` 核对。判据是字符覆盖率（最长公共子序列，阈值 0.75）而非逐字子串——Brief 阶段的模型在做归纳，引用必然转述，逐字比对会把忠实转述判成编造并阻断整个阶段。引用缺失或覆盖率不足即失败。该核对只在校验器实际收到上游时执行。标记常量与七项名称同样由服务端与 validator 共用。数组顺序不承载业务语义。七项名称由服务端常量与 validator 共用，不得在 Prompt、Mock 或校验器中各自维护第二份列表。

上述 Creative Brief 来源字段与 `sourceSimilarityRules` 都只是原片表面表达的 provenance，不是 Variants、Legacy Full Story 或 Animation Plan 的正文禁词。原片道具、拟声词和角色组合允许按当前选定剧情出现在任意正向业务字段，包括 `visibleAction`、对白、声音以及 `videoPrompt`；但不得仅因它们存在于来源上下文就机械注入下游内容。`sourceSimilarityRules` 只在实际生成请求确实携带原片参考时，为 `reference_leak` 提供证据；不得据此扫描或拒绝无原片参考的正文。`dialogueRules` 只能来自用户明确约束，不得把原片对白或拟声词自动提升为对白规则。该放行不改变 `fixedCharacterBoundary` 的优先级：固定主角的签发身份与外观仍是硬边界，复用原片角色组合不授权改写固定主角。

服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、人物参考精修、角色图与视频生成的唯一固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份角色边界。角色边界的**事实来源唯一，但执行力度分两档**：角色参考阶段（`/api/refine-character-reference` 的精修结果、`/api/generate-character-reference-images` 的 `characterReference` 与用户可编辑 prompt）遇到偏差只回传提醒不阻断，服务端仍完整判定并把偏差原文放进 `boundaryWarning` 或 `boundary-warning` 流事件，浏览器以警告色展示、照常完成本次操作，用户不必重新上传；依据是本节的「用户明确肯定/否定 > 已签发模型推断」。`boundaryWarning` 只用于展示，写回 Plan 前必须剥离，不进入 Artifact。人物参考精修允许按参考图改写 `appearancePrompt`，但不得因此丢掉全局必需角色事实——判定是字面比对，「穿着适合户外写生的村民服装」换成具体衣物后 identity 类的「村民」就没了。精修提示词必须逐条列出每条 `requiredTraits` 的可接受写法，并说明身份、性格、职业、剧情功能类事实写进 `identity` 或 `consistencyTags` 同样算数；服务端返回前用与判定共用的扫描口径补回缺失事实，只能在 `consistencyTags` 尾部按签发顺序追加 exact `canonicalName`，冻结 `appearancePrompt`，且**只覆盖非 `appearance` scope**：外观必需事实缺失是模型真把长相写错了，必须继续提醒并在成片渲染前硬失败。补写结果经展示用 `boundaryRestoreNotice` 如实回报，写回 Plan 前剥离。人物参考精修的**冲突优先级同样分两档**：`/api/refine-character-reference` 遇到参考图与文字设定冲突时，配角（非固定角色）以用户上传的参考图为准，按图改写 `appearancePrompt` / `consistencyTags` / `forbiddenChanges`，即使图中明显是另一种角色也照图改写，不得以「与当前角色不符」为由放弃采用；`characterName` 与 `storyRole` 承担的剧情功能不变，变的只是外观——依据是本节的「用户明确肯定/否定 > 已签发模型推断」，配角的文字设定本身是模型推断产物，上传图片则是用户的明确动作。固定角色仍以已签发 `fixedCharacterBoundary` 为准，参考图只能补充不冲突的细节，否则失败只会被推迟到成片渲染的 `ensureCharacterReferenceMatchesBoundary`。覆盖结果由模型写进 `referenceImageOverrideNotice`，与 `boundaryWarning` 同规格：只用于展示，写回 Plan 前必须剥离，不进入 Artifact；固定角色路径一律丢弃该字段。分档判定只用 `characterName` 与边界名的身份比较，不新建第二套词表。成片渲染链路（`/api/generate-shot-video`、`shot-video-generator` 的 `effectiveVideoPrompt`）仍然硬失败，`ensureCharacterReferenceMatchesBoundary` / `ensureCharacterPromptMatchesBoundary` 的抛错语义逐字不变；只提醒的三处改调同一判定的收集器 `characterReferenceBoundaryMismatch` / `characterPromptBoundaryMismatch`，判定规则只有一份，禁止另建第二套词表。

**边界不得同时要求与禁止同一特征，判定是单向子串包含（2026-09-06）。** `validateGlobalCharacterBoundary`（`src/validation.js`）对每个 required term `R` 与 forbidden term `F`，`R.includes(F)` 即硬失败，错误消息同时点名两端（`required「无头饰」包含 forbidden「头饰」`），只列一端时用户无法判断该改哪边。这条不变量此前就存在，但写成 `Set.has()` 的精确相等，而下游全部扫描器（`hasForbiddenOccurrence`、`findMissingGlobalCharacterTraits`）用的是 `text.indexOf` 子串——守卫与扫描器口径不一致，是 2026-09-05 Full Story 连续三次失败（约 7.6 万 token、6.2 分钟）的唯一共因：用户写「无头饰，但头顶有一个光环」，Guardrails 同时签出 requiredTrait「无头饰」与 forbiddenTrait「头饰」，Full Story 模型把那份 requiredTraits 清单几乎逐字抄进 `characterBible.protagonist.traits`（上游叫 requiredTraits，Story 字段就叫 traits），它是在服从边界。改后同一份数据在 `assertGlobalCharacterBoundary` 就失败，0 次 provider 调用、2 毫秒。

判定**必须单向**：required 文本里必然出现 `R`，若 `F ⊆ R`，服从 required 就自动违反 forbidden，无解；反过来 `R ⊆ F` 完全合法——「猫耳少女」含 required「猫耳」而不含 forbidden「非猫耳动物器官」。回扫 95 份已签发边界，正方向碰撞 3 份（`无头饰⊃头饰`、`无兽尾⊃兽尾`、`浅灰蓝色长发⊃蓝色长发`），反方向碰撞 14 份且全部合法（`去除猫耳特征⊃猫耳`、`非嗷呜拟声词⊃嗷`），双向判定会误杀 15%。`allowedTraits` 方向碰撞为 0，不扩大范围。否定型（`无头饰⊃头饰`）在角色参考链路被 `allowNegativeContext: true` 救下、只在 strict 扫描致命，而正向型（`浅灰蓝色长发⊃蓝色长发`）没有任何兜底：边界把某个必需事实的可接受写法之一与禁止写法重叠，按边界自己认可的拼法写就在成片渲染前硬失败，此前静默通过只因模型碰巧选了另一个拼法。

`visualGuardrailsPrompt` 配套加了两条生成约束：任何 requiredTrait 的 canonicalName 与 terms 都不得包含任一 forbiddenTrait 的写法；否定短语（「无 X」「没有 X」）只写进 `forbiddenTraits`，不写进 `requiredTraits`——禁止清单本身就表达「不得出现 X」。守卫是 fail closed，没有配套指引会变成反复拒绝而模型不知道怎么改。这不是降低校验标准，是让一条已被接受的契约按自己的语义生效，判定为纯字符串包含、不含语义判断。已签发的旧边界仍可加载查看，只在生成新的下游阶段被拒（所有调用点都是生成路径）。

**`characterName` 能从用户输入唯一推导，提示词必须把它说出来（2026-09-19）。** `ensureVisualGuardrailsMatchesProfile` 要求 `fixedCharacterBoundary.characterName` 逐字等于 `extractFixedCharacterName(creatorProfile.fixedCharacter)`，而 `visualGuardrailsPrompt` 此前从没给出这个名字，也没说创作限制里的其它角色不属于这份边界，模型只能猜。实测《累了就歇会》（参考片是两个女孩并排躺着分橘子，创作限制里写着固定搭档「芙芙猫」）批量回放 5 次卡在这一步，5/5 把名字写成「小白子与芙芙猫」、`bodyForm` 写成「人类少女与小猫」，并把芙芙猫的卷发、猫耳、猫尾签成小白子的 requiredTraits，来源还标成 `creatorProfile.fixedCharacter`；同一批另外 3 次通过的边界也 3/3 把「芙芙猫搭档」标成出自固定角色一栏。这条检查拦得对，不得放宽成子集或包含匹配：放宽后那份边界会签发出去，下游角色参考与成片渲染会要求小白子长猫耳猫尾。

现在提示词用同一个函数取名并逐字给出（取不出名字时不给——那时校验器也不核对名字）；写明创作限制、`creativeBrief` 与原片里的其它角色（固定搭档、宠物、家人、路人）不进 `characterName` / `canonicalDescription` / `bodyForm`，它们的外观与身体特征不进三份 traits；证据出自创作限制时 `sourcePath` 写 `creatorProfile.constraints`。规则只写抽象形状、不含任何具体角色名，名字是运行时插值。判定逐字不变，报错补上模型实际写的名字。演示数据的 `mockVisualGuardrails` / `mockFullStory` / 当时的 `mockAnimationPlan`（已随 3.0 删除）此前各自按逗号切名字、不认冒号，「名字：描述」写法在演示模式第一步就被拦，现在都改调 `extractFixedCharacterName`，并由一条跑通整条演示链的测试锁住。已知局限：「固定角色」一栏只登记一个角色，写两个名字时边界只围绕取出的那一个，多固定角色属于 Character Registry / Cast，未实现；模型照不照做没有新增的确定性兜底，这一阶段仍是单次调用、被拦不重试。真实回放过了事先登记的线：同一份上游、同一个模型，《累了就歇会》改前 4/4 失败、改后 6/6 通过（线是 ≥5/6），回归《打枣》《一份长途》4/4；芙芙猫外观被签成小白子特征 0/10，搭档条目来源标成固定角色一栏 0/10。只有 3 个参考片、1 份创作设定，且《累了就歇会》本身是设计样本；数据与局限见 `docs/待解决项.md` 第 15 条。

**取名本身曾会取错，而这条提示词会让模型照写错名（2026-10-05 修复）**：`extractFixedCharacterName` 的取名标签（含单字「叫」）此前在全文任何位置都算——「…开心时会发出嗷呜的叫声」取成「声」、「喜欢叫奶奶陪她玩」取成「奶奶陪她玩」、「大家都叫她小白」取成「她小白」；本条提示词让模型逐字照写，错名于是通过逐字比较并被签发（改前这类输入会在这一步报错停下）。现在标签的起点必须落在第一段（第一个分隔符之前）才算取名，否则按「第一段即名字」的既有规则；标签词表不增不减。当时本机 5 份历史设定按新规则取名逐字不变，所以已签发边界不受影响；「她叫小白」「名叫小白子」「角色名：小白子」照旧按标签取名。


`groundingSeal` 与 `fixedCharacterBoundary.boundarySignature` 所用的两把密钥必须持久化在状态根目录（`.grounding-key` / `.character-boundary-key`，可由 `WORKFLOW_GROUNDING_KEY` / `WORKFLOW_CHARACTER_BOUNDARY_KEY` 覆盖），跨进程重启保持不变。缺失即生成，损坏、长度不足或环境变量非法一律硬失败，**禁止静默回退为随机生成**——换钥会让全部已落盘 Artifact 的签名作废。已落盘 Artifact 不得用新密钥重新签发。

生产环境必须校验 `fixedCharacterBoundary.boundarySignature`。仅当服务端显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test|development` 且 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified` 时，为支持重启后继续回放本地测试包，可以跳过 HMAC 签名比较；`sourceDigest` 与 `boundaryDigest` 仍必须匹配。该策略只能来自服务端环境，禁止由请求体控制。

冲突优先级：用户明确肯定/否定 > 已签发模型推断。无法消解的冲突必须阻断，不能选择任一方静默覆盖。用户或权威上游数据改变后，旧边界必须失效并重新生成。

**`sourceDigest` 有两版（2026-10-09）。** 参考视频 Run 沿用最初那一版：哈希输入是固定角色设定三项 + 原片分析 + 脚本还原 + 创意简报，函数体逐字不变，由 golden 测试锁定。「从剧情开始」的 Run 用 `story_source/2`：固定角色设定三项 + `storySource`，并把版本号写进哈希输入——两版键集合不相交，互相验证必失败。用哪一版只由服务端按 Run 元数据决定（`workflow.assertGlobalCharacterBoundary(input, { storyEntry })`，`storyEntry` 从不取自请求体）；媒体阶段在剧情 Run 上一律取 Run 里的固定角色设定与 current `visualGuardrails` 校验（`verifyBoundaryForMedia`）。

## 当前模型内容纠错边界

当前主流程中，任何已经解析为候选对象的模型内容错误都不得通过“把完整失败 Artifact 发回模型并要求整包重写”恢复。只有 validator 输出稳定 `code + RFC 6901 JSON Pointer + reason`，候选完整、目标已存在、事实来源唯一且对应 stage adapter 明确授权时，才允许签发一次有界局部纠错。没有可信 diagnostics、没有唯一权威、整个对象/数组项丢失、候选非对象或 adapter 不支持时必须 fail closed；不得解析人类错误消息猜 path，也不得自动扩大可写范围。

当前生产纠错只有一个 Full Story 专用协议：Legacy Full Story 仅支持由签发固定角色边界唯一恢复 protagonist `name` 的安全子集，使用 `full_story_partial_repair/1.0`（protagonist `name` 缺失/类型错误/空字符串且验签边界提供唯一姓名）。Animation Foundation 的 `artifact_partial_repair/1.0`、语义 Prompt 修复 `animation_video_prompt_semantic_repair/1.0` 与镜头台词补写 `animation_shot_dialogue_repair/1.0` 已随旧 3.0 分镜删除，不得重新引入；4.0 自主分镜不做局部纠错，只带诊断整体重做一次。服务端独占私有签发身份、`baseDigest`、authorityDigest、repairId、目标 path、mutablePointers 与 authority；模型取得的序列化计划不能作为可合并计划。第二次模型请求只发送目标 currentValue、diagnostics、修复说明和最小权威投影。模型只能返回等量、同序 `{repairId,replacement}`，不能返回 path、op、完整 Artifact 或额外字段。服务端必须在 clone 上原子合并，证明目标内未授权事实与全部目标外数据不变，重新投影并验证当前 authority，并从头执行该阶段完整 Schema、角色、剧情与跨字段校验。

Full Story 的未知正文错位、配角姓名或身份错误、`characters` 与 `visibleAction`/`dialogue` 的跨字段冲突，以及没有签发值来源的必填剧情字段必须 fail closed，不能让模型通过猜字段、改名、删对白、删动作或另编剧情消除校验错误。其他已解析内容错误当前直接失败，不能宣称已被自动纠正；唯一的再取证例外是 `referenceAnalysis` 原生视频候选仅因 `VIDEO_EVIDENCE_TIME_INVALID` 失败且已有关键帧时，系统丢弃该候选并用既有 frames 重取一次，不发送失败 Artifact，也不属于 repair。网络、鉴权、429、timeout、lineage stale、签名失效同样不是内容 repair。

### Legacy Full Story Beat–Scene 提交前复核

Legacy Full Story 另有一次与失败候选 repair 严格分离的 Beat–Scene 提交前复核。它只能在初轮候选（包括已经完成唯一允许的 retry 或 protagonist `name` 局部纠错）通过 exact Schema、Scene Contract、固定角色/Profile、Variant 与既有语义边界的完整校验后执行；失败候选不得借此补写正文。复核使用当前 Full Story 已明确选择的同一文本 provider/model，第二次请求的业务内容只能包含这份完整、已合法的 Full Story JSON 与专用复核提示，不得再次上传或展开 `creatorProfile`、Theme Variant、Creative Brief、Visual Guardrails、`referenceAnalysis`、Reconstruction 或其他边界/变体数据。

`beatSheet` 在该复核中是只读的叙事目标，模型只判断它与 `sceneScript` 是否存在会造成可拍叙事断裂的明显遗漏。若不存在明显遗漏，必须返回 unchanged；若存在，模型也不得自由创作 suffix。每条提议必须指向已有 scene 和唯一 `beatSheet[beatIndex]`，其 `addition` 必须是对应 `beatSheet[beatIndex].storyAction` 中一段连续、逐字相同的原文，并且必须包含该 review 逐字返回的 `beatEvidence`；全部证据只能使用该 `storyAction` 与目标/相关场次现有 `visibleAction` 的逐字 excerpt，不能引用其他 Story 字段或上游数据。无法把所需内容逐字投影为该连续原文时必须返回 `blocked`，不得概括、改写、拼接不连续片段或自行补写。

唯一可写范围仍是把受信 `addition` append 到已有 `sceneScript[i].visibleAction` 末尾，原值必须保持为逐字前缀。一次 postpass 最多补 3 个已有场次，每条 `addition` 最多 600 字，全部 additions 合计最多 1200 字；超限、`beatIndex`/证据错绑、addition 未包含 `beatEvidence` 或原文不连续均按协议错误 fail closed。场次数量与顺序、`sceneId`、`timeRange`、`location`、`characters`、对白、`shotAndSound`、`emotionNode`、`dramaticFunction`、`shootingNotes` 以及 `sceneScript` 外全部字段必须逐字冻结。明显遗漏仅指重要剧情节拍、可见结果、状态变化或因果过渡没有任何可拍证据；合法省略、蒙太奇概括、末项代表整组、或现有终态已经覆盖节拍时不得重复投影。

复核返回 `blocked`、协议错误、供应商错误、越界 diff、非追加式改写或最终完整复验失败时必须 fail closed：不得保存原候选作为 fallback，不得发起第二轮复核，也不得扩大到整包重写。正常路径为 Full Story 初轮生成加一次复核，共 2 次 provider call；初轮若消耗唯一允许的 retry 或局部纠错调用，成功后再复核时整个 operation 最多 3 次，禁止第四次调用。append 合并在 clone 上完成，并从头重新执行 Full Story 全部校验；只有最终 unchanged 或合法追加后的 Story 提交一次 Artifact。初轮候选、复核响应和合并中间态都不是 Artifact、revision、Checkpoint 或第二份 Story 事实源。该 postpass 不扩展上述 partial-repair adapter，也不是 Full Story v2、Canonical Story 或通用 Auditor。

每次服务端或 `run:video` 已成功签发 repair plan 后，必须在第二次 provider call 之前启动 `debug/partial-repairs/` 本地观测记录，并按触发、局部 Prompt、模型 replacement 投影、最终结果四阶段落盘。只允许写入命中 target 的 currentValue、结构化 diagnostics、最小 authority 与拒绝原因；禁止写入完整 Story/Animation Plan、原始 HTTP 响应、Header、密钥、Cookie、Data URL 或 Base64 媒体。没有签发 plan 时不得创建记录。Debug 写入必须 fail-open 并只输出脱敏告警，不得改变 repair 的成功/失败、增加模型调用或回退保存 raw；这些文件不是 Artifact、Production Lineage、业务事实来源、恢复数据或导出包内容。

Full Story 另有一条与 partial-repair Debug 严格隔离的、服务端环境显式开启的全量模型输出日志。只有 `FULL_STORY_MODEL_OUTPUT_LOG_DIR` 为非空私有路径时，才允许把每次实时 Full Story primary、retry/repair 与 Beat–Scene postpass completion 的完整 `content` 按阶段原样落盘，并在日志 metadata 中保存明确的 `stage`；不得把请求 Prompt、HTTP 请求/响应包、Header、API Key、Cookie、Data URL 或 Base64 媒体一并保存。浏览器 Production token 只能通过旁路 Header 传递，服务端必须核对 current running stage 后分别记录 `productionRequestId` 与 `providerRequestId`，不得把 trace context 混入 Workflow input、Prompt、Full Story、Artifact 或导出包。目录位于 `public/` 时必须禁用。日志不截断模型 content，文件权限必须私有并原子写入；写入失败 fail-open，不得改变校验、repair、postpass、重试预算、lineage 或业务错误。为避开 Windows 长路径，目录可以使用 project/run、production request 与 operation 的稳定短摘要，但 `metadata.json` 必须保留完整标识；摘要不构成 lineage。该日志只是本机敏感观测 sidecar，不是第二份 Story、Production Lineage、恢复数据或事实来源。attempt 目录不得用 `fs.mkdtemp` 创建，必须用 `createUniqueDirectory`（`src/unique-directory.js`，2026-10-05）：在没开长路径支持的 Windows 上，实测 `mkdir`/写文件/`rename`/`chmod`/`realpath`/删除在 300+ 字符路径上全部正常，唯独 `mkdtemp` 在结果路径到 ~248 字符时报 `ENAMETOOLONG`、再长报 `ENOENT`；浏览器 Run 内 unbound 日志的 op 目录本身就有 252 字符，每次都是上层目录建好、attempt 目录建不出来、按 fail-open 静默放弃（10-05 一次 742 秒分析的原文因此没留下）。替代函数语义与 `mkdtemp` 一致：随机 6 位后缀 + 非递归 `mkdir`（父目录不存在报 `ENOENT`、绝不重建已清理的 Run 祖先），`EEXIST` 换后缀重试；目录布局与 `metadata.json` 逐字不变。Run 内镜头视频的 `media-work/shot-video-*` 同样改用它；`os.tmpdir()` 下的短路径未改。

Animation Plan 原始 completion 使用独立的 `ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR` 与固定 `scope=animationPlan`。服务端必须在真实 `/chat/completions` 响应交给 JSON parser 前，从克隆响应中只提取 `choices[0].message.content`、finish reason、usage 数值和 provider requestId；不得保存或传递原始 HTTP envelope、请求 Prompt、Header、密钥或媒体。它由 prompt capture 抓取分镜路由与单镜提示词路由里的每次调用（4.0 分镜各步与单镜提示词），按调用顺序记录；未发生的调用不得伪造记录。Production Header 只可在服务端核对 `animationPlan:<variantId>` current running stage、requestId 与 expected revision 后标记 verified；不匹配只能记为 unbound，不能搜索 Run 猜归属或阻断业务。输出观测失败必须 fail-open，不能改变 Response、provider 调用次数、validator、repair、Plan commit 或错误文字；日志仍不是 Artifact、事实源或恢复数据。观测器读响应副本时的失败分类与 `classifyAttemptError` 同口径：复读叫停（`SseStreamDegenerateError`）记为 `MODEL_OUTPUT_DEGENERATE / degeneration`（2026-10-05 之前被记成 `MODEL_STREAM_ABORTED / transport`，跨包统计时复读与断网分不开），其余分支不变。

工作流各阶段由第四套 sidecar `STAGE_MODEL_OUTPUT_LOG_DIR` 覆盖，按 stage 分 scope，成功与失败都记；完整清单是 `server.js` 的 `STAGE_MODEL_OUTPUT_LOG_SCOPES`（参考视频链路各阶段、候选对照评审与命题修订、剧情体检与按问题修改、承诺核对、4.0 自主分镜六步 `storyboardCharacterFacts` / `storyboardDesign` / `storyboardReview` / `storyboardRevision` / `storyboardReviewFinal` / `shotVideoPrompt`、导演助手、一句话修改）。走 `generateValidatedJson` 的阶段在那里注册即生效；走 `modelCallCoordinator` 的阶段由调用方自己接 `attemptObserver`（自主分镜由 `storyboard-workflow.js` 的共用 `call()` 接，剧情按问题修改由 `createStoryQualityRepair` 接，导演助手由 `createDirectorAgentTurn` 接，一句话修改由 `createOneSentenceEdit` 接），每次 provider 调用各留一条记录。**scope 取值必须逐字等于 stage 名**：writer map 按 scope 建、按 stage 查，对不上就静默不写；2026-09-07 之前曾有阶段没注册，失败时模型原文永久丢失，只能靠反推根因。原始 completion 由三个 client 的`requestJson` 通过可选 `onCompletion` 回调交出——回调只观测，抛错或 reject 一律吞掉，不得改变模型调用的成败；阶段判定复用已导出的 `classifyAttemptError`，错误 category/code 只保留一份来源，禁止另建映射。一次调用内 client 内部的 JSON 重试或视频退回逐帧各留一条记录，只有最后一条带本次阶段判定，更早的标记 `superseded`。这些阶段在该层没有 lineage 上下文，记录一律落在 unbound 路径；`logContext` 的 verified 判定不得为此改动。其余约束（不写 Prompt/Header/密钥/媒体、私有权限、原子写、fail-open、不是 Artifact 或恢复数据）与前三套逐字一致。

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

- Any task that modifies or debugs production code, tests, prompts, schemas, workflows, providers, workers, services, or user-visible behavior must invoke `$verified-engineering-loop` before editing and follow its A/B/C/D evidence closeout. Read-only analysis and purely editorial changes are exempt.

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

### JSON 引号契约

`JSON_ONLY`（`src/prompts.js`）是 **10 个阶段提示词共用**的输出格式契约，其中一条规定：

- 字符串值内部不得出现半角双引号 `"`。
- 需要引用词句时用 `「」` 或单引号 `'…'`。
- 上游文本里的全角引号 `“”` 必须原样保留，不得改写成半角双引号。

这条规则讲的是 JSON 序列化本身，**不是 Full Story 的局部补丁**——Analyze 与 Reconstruct 同样要把带引号的原片字幕转抄进字符串值。禁止把它挪进任何单个阶段的正文。**不要求模型写 `\"` 转义**：转义正是它失败的那个动作，换一个没有 ASCII 同形字的字形才能从源头消除危险。

依据（2026-08-30 字节级取证）：当天 20 次 Full Story 调用只有 8 次产出可解析 JSON，12 次以 `finish=length` 截断，每次烧满 16384 输出 token、耗时 214–284 秒。12 次退化段的起点全部落在同一字段同一偏移（约 490）——模型把 `creatorProfile.constraints` 里的全角 `“谢谢、再见”` 抄进 `characterBible.protagonist.speechRules` 时吐成未转义的半角 `"`，当场闭合字符串，随后在 `:"",  ":"` 上重复到上限。对照 08-14→08-29 留存的 99 份输出：全部可解析，41 份自发用单引号、2 份用全角引号、**0 份用裸半角**。该规则只是把已被验证有效的写法显式化。

**「为什么偏偏是当天」没有查出来。** 危险字符（`constraints` 开头一个孤立半角 `"`、两对全角 `“”`）自 08-25 起逐字不变，而此后 99/99 成功；当天唯一的 `constraints` 改动与断裂点无关。最可能是上游模型服务行为漂移，本地不可控，因此修复针对机制而非触发源。

**没有确定性校验兜底**：无法在生成前预判模型会吐哪种引号。断裂的输出本来就解析失败、fail closed，没有错误数据能流到下游，代价只是时间与 token。

---

## Animation Plan

只支持 4.0 自主分镜（契约见上文「当前主流程」与 `docs/animation-storyboard-implementation-2026-09-21.md`）；旧 2.0/3.0 不再支持，见「已删除的功能（2026-10-11）」。

负责：

片段划分与时长
beats 里的景别、机位、可见动作、对白与声音
未指定的角色与地点外观设计
镜头连续性

不负责：

重新创作剧情
修改核心因果与角色身份关系
改变结局与故事主题
写视频提示词（单镜提示词由 `shotVideoPrompt` 按需另写）

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

「出镜」的判据只有一条：**这一场的画面里能不能看见这个人**，与他站得多远、是不是本场主体无关。远景里弯腰翻晒谷子的奶奶、背景中路过的行人、屋檐下不说话的老人都必须写进 `characters`。**反过来，`visibleAction` 与 `shotAndSound` 里不得出现任何不在本场画面里的角色名（2026-08-31）。** 这两个字段是可见事实字段，名字写进去就等于声称这个人在画面里，没有例外。原先契约列的三种情况（地点归属称呼、只被提到、回忆或转述）**不再是豁免**，而是必须改写成不带名字的写法：

- 画外声音不带主体：「屋外传来喊白子回家的声音」「屋外传来一个苍老女声的呼喊」。
- 道具上的名字只写可见特征：「贴着手写标签的快递盒」。
- 地点的归属称呼也不得进入 `location`：不写「李奶奶家门口」或「奶奶家的客厅」，只写通用空间名称「门口」或「客厅」；归属关系确有剧情意义时放进 `beatSheet`、`characterBible` 或 `shootingNotes`。
- **用来说明道具来历或经手人的名字同样要去掉（2026-09-12）**：不写「奶奶刚叠好的被子」，写「刚叠好的蓬松被子」。它与上面「道具上的名字」是两个形状——名字并不写在道具上，而是在交代这件东西是谁弄的——但扫描是裸子串匹配，两者没有区别。可见特征（刚叠好、蓬松、晒过的暖意）全部保留，经手人写进 `shootingNotes` 或让 `dialogue[].line` 自己说。
- **屏幕上出现的文字里的角色名同样要去掉（2026-09-06）**：片尾卡、字幕、招牌、门牌、快递单都算。不写「黑屏浮现白色文字『继续加油~ 小白子！』」，写「黑屏浮现一行白色发光文字」；卡面原话按上一条的既有路由写进 `shootingNotes`。**两个可见事实字段都适用**——把引文从 `visibleAction` 挪到 `shotAndSound` 不会通过，实测模型连续两次就是这样撞上同一条规则（2026-09-06 22:21 命中 `visibleAction`，22:26 挪走后命中 `shotAndSound`，其间它已把 `visibleAction` 改干净，说明它读懂了规则、只是没有第三个地方可去）。

**去掉的只有名字，不是可见细节**——「一个快递盒」不合格，标签是视频模型该渲染的东西。名字在 `location`、`dialogue[].line`、`beatSheet`、`characterBible`、`shootingNotes` 里都可以自由出现；扫描只覆盖 `visibleAction` 与 `shotAndSound` 两个字段，`shotAndSound` 甚至不进 Animation 阶段的场次投影，因此这条规则实际不造成信息损失。

**归属称呼放进 `location` 之后，不要再抄进 `visibleAction`。** 这是这条规则实测最常见的失败写法：`location` 写「奶奶家的客厅」，`visibleAction` 跟着写「小白子和芙芙猫在奶奶的客厅里玩」，而奶奶正在卧室睡觉、根本没出镜——抄过去就等于声称她在画面里，硬失败。正确写法是 `visibleAction` 只写「在客厅地毯上玩毛线球」。

**候选正文的措辞不属于必须逐字承接的内容，字句服从可见事实字段规则（2026-09-12）。** `fullStoryPrompt` 原先同时写着「Variant 已选用的人物、任务细节、道具、媒介、结尾方式和对白方向必须忠实承接」和「可见事实字段不得出现不在画面里的角色名」，而**对同一句话没有定义优先级**——候选的 `storyOutline[].action` 对角色名没有任何约束（校验器只在 fullStory 这一侧），所以候选完全可以合法地写出一句照抄就会硬失败的话。现在明确：承接的是候选写出的**剧情事实**，不是它的**字句**；冲突时以可见事实字段规则为准，按上面五条范式改写。**反方向同样禁止**：不得借「措辞可以改」删掉可见细节，也不得改变候选已经确定的动作、道具、地点或结果。

依据是 2026-09-12 用一份真实导出包（候选 V2《罐装阳光与太阳味》，包内 `fullStories: []`、从未展开过）做的两次基线回放：候选拍 3 原文写「把罐子放在**奶奶**刚叠好的、带着阳光味道的被子上」，两次独立调用都把它原样抄进 `sceneScript[2].visibleAction`，**都在同一场同一个名字上硬失败**（`FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING`，112 秒 / 108 秒，提示词 44,680 字符，输出 `finish=stop` 未截断——模型写完了一份完整的故事，只因为一个定语里的名字被整份丢弃）。而这一类失败**不会重试**：`createFullStory` 的 `shouldRetry` 只覆盖「没解析出对象」与 protagonist 姓名局部纠错，已解析但违反契约的候选一律 fail closed。

规模已测量：`debug/full-story-model-outputs` 里 25 份有原文的 primary 尝试中，**9 次因契约失败，全部集中在角色登记这一对**（`FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING` 6、`FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED` 3）；该阶段整体 20/53 = 37.7% 失败，契约与传输大致各半。另外用今天的校验器回放当时**成功**的 17 条，有 4 条会被拒（全是 `NOT_REGISTERED`）——那是 08-31 规则变严的结果，不是回归；当时失败的 8 条今天 8/8 完整复现。**校验器逐字未改**，这次改的只是「提示词有没有自相矛盾」。`test/full-story-prompt-narrative-scope.test.js` 用源码断言锁住优先级声明与第五条范式，撤掉即失败。

**修复后同一份固定输入回放两次，2/2 通过**（104.5 / 104.7 秒，提示词 45,201 字符，各 2 次 provider 调用 = 初轮 + Beat–Scene 复核），**两次都逐字写出范式给的「刚叠好的蓬松被子」**，可见特征保留、道具与动作未变，六场可见字段零违规；对照基线 0/2。**边界要说清楚：它只消除这一个失败形状。** 同一批数据里 `beatSheet[].retainedValueFromBrief` 两次都仍把原片奖励机制写进来（「善举获得外部认可」／「善举或探索获得正向反馈」），第二次回放的 S6 还从原片重构稿逐字抄了 **9 字**「奶奶露出欣慰的笑容」（第一次最长 4 字，所以那次的干净是抖动）。原片机制经 `reusableHighValueBeats[].beat` / `mustRetain` / `samePlotDriver` / `sameBeatValue` / `creativeDistancePolicy` 漏进展开阶段这条缝**仍然开着**——候选提示词刻意屏蔽这五个字段并配了「原片实例不是本片命令」整段，而 `fullStoryPrompt` 整份下发、正文 0 次提及；那是独立改动，本次未做。

**参考片的片尾署名字幕卡是来源表达，不是必须复用的构件（2026-09-06）。** `fullStoryPrompt` 把**整份** `referenceAnalysis` 与 `sourceScriptReconstruction` `JSON.stringify` 进提示词，所以参考片《明天》的片尾卡（analysis 的 `observation`「黑屏显示文字「⋯⋯继续加油~ 咕嘎！」」、reconstruction 的 `dialogueGist`）会被模型逐字读到并照抄进本片，只换掉名字。它撞的正是同一段已有的「允许不等于必须使用」——因此本次修复是把那条抽象规则对这个具体形状写成可照抄的落笔指引，**不是新增禁令**：不要为本片补一张「黑屏白字 + 主角名」的收尾卡，用最后一场的画面收尾；`sceneScript` 凑不满 6 场时把某一拍展开成两场戏，**加一张文字卡不算一场戏**（选中候选只有 5 拍正是本次的助因）。

规模已测量：`debug/full-story-model-outputs` 现存 25 份可解析候选中，《明天》两个 run **5/5** 末场带文字卡，其余 8 个 run **0/20**——这个形状完全由「参考片有片尾卡」驱动，不是模型通病。五份带卡的故事全部 6 场、末场 `characters: []`；四份写了角色名判失败，第五份写「明天也要加油哦～」不带名字则通过扫描，即**名字是唯一触发点**。这张卡也不承接自候选：选中候选的末拍本来就是画面结尾。**这条没有确定性校验兜底**——判断一段文字属于「屏幕文字」还是「画面里的人」需要语义判断，写死词表会误伤合法写法。校验器行为逐字不变，只降低生成该形状的概率，不保证消除。

这条的价值在于**让现有校验器变正确，而不是让它变聪明**：裸子串匹配恰好就是它的判据，永远不需要语义判断。依据是 2026-08-31 取证——那三条豁免写在契约和提示词里，扫描却一条都没实现，回扫 180 份可解析历史输出，`FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING` 命中 45 条，约三分之二是模型照提示词写了合法文本反被判失败。

期间曾短暂引入过 `nonVisualMentions` 登记字段，**已删除，不得重新引入**：它连 `visibleAction` 一起豁免，破坏了「登记只豁免 `shotAndSound`」这条不对称，上线后三次真实调用全部拿它登记离场动作。`offscreenSoundSources` 保留，降级为「名字实在无法从 `shotAndSound` 去掉」时的兜底，它只豁免 `shotAndSound` 的不对称不变。

**离场不单独做机制。** `characters` 是本场的选角声明，`visibleAction` 不能演一个没选的角色，三条出路：确实露了脸就写进 `characters`；想让他不在这一场就**写离场的结果而不是离场的动作**（「木门在身后合上，晾衣绳边只剩下小白子」）；动作属于上一场就挪回上一场结尾。七次调用、三个提示词版本都没能说服模型把离场角色写进 `characters`（加「离场也算出镜」后 `prompt_tokens` 14096→14243 证明文本确实送达，同一句照样失败，模型还在 `shotAndSound` 写了「中景展示奶奶离开的背影」）。当前这一版改成承认模型意图并给出替代写法，没有把握；失败仍是响亮硬失败，**不得挂自动纠错**——校验器只证明名字出现了，正解有两个，推导不唯一。依据是 2026-08-30 的实测——同一轮连续三次 `FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING`，都是模型把远景背景人物当成不出镜（`visibleAction` 写「远处，奶奶正弯腰用木耙翻晒金黄的谷子」，`characters` 只有主角和宠物）。校验器一直拦得住，补的是提示词里缺的可执行判据。

登记只豁免 `shotAndSound`，绝不豁免 `visibleAction`：实际参与本场的人物必须写进 `visibleAction`，所以无法靠登记声源隐藏一个出镜角色。同名同时出现在两个字段时抛 `FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE`，不自动选边；登记了却未被 `shotAndSound` 引用是合法的；名称精确性与 `characters` 共用同一份判定。该字段不在局部纠错可写范围内，postpass 必须逐字冻结；`dialogue[].speaker` 仍必须逐字存在于同场 `characters`。旧 Story 缺该字段时行为不变。

`location` 只写本场实际发生的**可拍摄物理地点**，不是画风、光线或色调。`creatorProfile.vertical` 里的风格词不得流进 `location`：正确写法是「草地」，错误写法是「日系2.5D新海诚光景风格的草地」。视觉风格由下游 Animation Plan 统一设计（4.0 的 `visualDesign` 与签发的画风），在 Full Story 重复它会让每场地点看起来一模一样，反而丢掉地点本身的信息。

**同类空间必须靠归属或方位区分开**，`location` 是唯一能承载这个信息的字段。下游分镜按它设计地点（4.0 的 `visualDesign.locations[]`），判断「是不是同一个地点」的信号只有 `location` 与 `visibleAction`——后者按上面的规则不许写归属。两个不同的院子都写成「院子」，就会被当成同一个地点、共用一套地点设计，渲染成同一个地方，**且没有任何校验器会报错**。回扫 124 份历史故事，62% 的 `location` 带归属称呼，剥掉后有 2.4% 出现真实碰撞（「院子」← 小白子家院子 / 小禾家院子；「门口」← 爷爷家门口 / 奶奶家门口）。

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

v3 包导入时必须验证上述字段和 parent lineage，并建立隔离的新 Run；禁止与现态静默混合。包内旧媒体结果不得直接恢复。包里的 `animationPlan` 必须是 4.0：封装与导入都拒绝旧分镜（参考视频的 3.0 包 `ANIMATION_PLAN_VERSION_UNSUPPORTED`，剧情的 3.1 包 `PRODUCTION_PACKAGE_PLAN_VARIANT_MISMATCH`，见「已删除的功能（2026-10-11）」）。它仍不是包含批量执行、供应商状态和完整 canonical provenance 的 Production Package。

「从剧情开始」的 Run 签 `3.1` 包（2026-10-10；第一期曾明确返回 `PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED`）：同一个包类型，必带 `entryMode: "story"` 与 `storyMode`；参考视频的包仍是 `3.0`，签名字节不变（golden 测试锁定）。版本号不能省——沿用 3.0 时旧程序会把「只给角色设定」的包当成参考视频的包导入、得到坏掉的 Run 且不报错。包里的原文、角色边界、候选、选中记录与固定角色设定一律由服务端从 Run 读出，页面只发 `exportedAt` / `mode` / `modelInfo` 与剧情、分镜两份副本（副本只用来核对是当前版本），多发任何字段 400 `PRODUCTION_PACKAGE_STORY_INPUT_INVALID`。每份产物的上游必须与唯一一份依赖图 `STORY_PACKAGE_GRAPH` 逐项完全相等，第一期第一版的「粘贴完整故事」Run（带候选）导出时 409 `PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED`；签名前与导入时共用 `validateStoryPackageBody`，「只给角色设定」必须恰好一个候选 V1 且与选中记录相同。导入先写 Run 元数据（入口、剧情模式、原文摘要、规整后的 `creatorProfile`、来源包摘要、`startedBy: "package-import"`），再由服务端按依赖图顺序提交原文与各份产物，分镜签发新的媒体命名空间，角色边界不重签；**这是除开 Run 以外唯一写 `storySource` 的地方**。页面导入剧情包后从服务端读回 Run（同刷新恢复），不从包内容拼状态。导出的文件里有故事原文。详见 `docs/production-lineage-state.md` §7。「导出完整 JSON」仍是普通创意 JSON。


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

尚未实现远端任务接管、批量视频（4.0 没有；旧 3.0 的 Run 内顺序批量 `shotVideoBatch` 已于 2026-10-11 删除）、跨进程批量队列、完整视觉 QA 和成片恢复。

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

供应商错误码提示（`src/provider-error-codes.js`）是纯展示层：把 MiniMax、火山方舟 Ark（Seedance 视频与即梦图片共用）、阿里云百炼 DashScope（Qwen）、DeepSeek 与小米 MiMo 的官方错误码翻译成可执行中文提示，不影响是否抛错、抛什么错、重试预算或 HTTP 状态码，也不参与任何业务校验。硬规则三条：供应商原文逐字保留在既有 `detail` 字段，解释只放进新增的 `providerError`，不得用友好文案顶替原文；匹配不到一律返回 `null` 让调用方回退原文，禁止编造安慰性描述；码表只抄官方文档，文件头标注出处 URL 与核对日期，不得靠猜测补条目。接入点只有 `src/server-error.js` 的三处错误出口（视频 / 图片 / 文本）。命中依据分供应商业务码与 HTTP 状态兜底两种，展示标签必须如实标明是哪一种；按状态命中时不得把响应体里无关的 `code` 显示成来源。这三处的 `retryable` 跟随官方文档判定。 按 HTTP 状态兜底命中时 `guidance` 只能给通用建议，供应商原文是唯一可执行的信息，`providerErrorText`（`public/compiler-observability.js`）必须一并渲染 `providerError.providerMessage`：`ModelResponseError` 分支（`src/server-error.js`）的响应体没有 `detail` 字段可回退，只渲染 `title`/`guidance` 会让唯一有用的那句消失（实测 kimi-k3 的「Parameter 'temperature'=0.3 is not supported」就是这样被吞掉的）。

火山方舟内容审核码（2026-10-14）：`ARK_CODES`（Seedance 与即梦共用）补上官方「推理错误码」表里 HTTP 400 的全部 24 个审核码（`*SensitiveContentDetected*` 与 `*RiskDetection*` 两组），出处改为 `https://www.volcengine.com/docs/82379/1299023`（原来写的 82379/1359411 是方舟「常见问题」页，没有错误码表）。起因是 A04 连续三次 `InputTextSensitiveContentDetected`，表里没有审核码，按 HTTP 400 兜底成「请求不合法 / 检查请求参数」；现在显示「内容审核判定输入文本可能包含敏感信息」并带供应商原文。官方含义一律是「请您更换（输入内容）后重试」，`retryable` 全为 `false`；指引只建议改提示词或参考素材，写明改完是否重新生成由用户决定、系统不会自动重试。同表的 `ContentSecurityDetectionError`（风险识别服务自身失败，不是内容被拦，文档没给处理建议）未收录，仍按 HTTP 400 兜底。同日删掉了这页上已经没有的 `InvalidEndpoint.NotFound`（现在叫 `InvalidEndpointOrModel.NotFound`，未补）与 `ModelLoadingError`，它们改按 HTTP 状态兜底。

同一规格适用于 `src/qwen-client.js` 的 `MODELS_REJECTING_TEMPERATURE`：只登记供应商实测返回的事实并标注来源与核对日期，**禁止按模型名前缀推断**（`kimi-k2.7-code` 实测接受 `temperature`）；命中时只摘掉 `temperature`，`top_p`/`response_format`/`max_tokens` 逐字保留；不在清单里的模型照常发送，供应商拒绝就如实抛错，不静默重试、不降级。
