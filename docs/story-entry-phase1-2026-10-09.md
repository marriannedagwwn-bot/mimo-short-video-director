# 从剧情开始 · 第一期（2026-10-09）

> 状态：代码、自动化测试与本机真实模型运行见文末「验收证据」。导演 Agent 对话、一句话修改、4.0 批量出视频不在本期。
>
> **同日补充**：「粘贴完整故事」不再生成故事候选，原文直接拆成可翻拍镜头（见第 6 节）。第 2–4 节已按补充后的做法改写；第 5 节是补充之前那一版（粘贴原文也有候选）的验收记录。

## 1. 为什么要有这条入口

此前每次生产都必须从参考视频开始：Analyze → Reconstruct → Brief → Visual Guardrails → 候选 → 完整剧情 → 分镜 → 视频。用户要的是「给它一段完整剧情，或者只给角色设定，它把后面的分镜和视频做完」。

调研结论（逐阶段核对代码，不是推断）：参考视频的**内容**只在候选剧情之前被用到。完整剧情 1.1/1.2、4.0 自主分镜、角色参考图和镜头视频读的都是剧情本身和角色设定；参考视频在下游只剩三种「门槛」作用：

1. 任务依赖清单（fullStory / animationPlan 依赖原片分析、脚本还原、创意简报）；
2. `groundedStageInput` 要求签名的脚本还原（完整剧情、按问题修改）；
3. 全局角色边界的 `sourceDigest` 把原片分析、脚本还原和创意简报算进哈希。

所以第一期不伪造任何原片上游，而是给没有视频的 Run 换一套门槛：用户原文成为权威上游，角色边界换一版摘要，候选换一份没有对照原片字段的严格 Schema。

## 2. 用户可见的流程

1. 首页切到「从剧情开始」，选「粘贴完整故事」（≤5000 字）或「只给角色设定，让它写一个」，照常填「设定创作宇宙」。
2. 粘贴完整故事：点「开始拆镜头」。服务端建剧情 Run（`entryMode: "story"`）并写入 `storySource`，后台任务 `storyPipeline` 跑两步——角色与表达边界 → 按原文拆出可翻拍镜头（`fullStory:V1`）——没有候选这一步。拆好后页面直接进分场页：左边是原文，右边是分场（时间、地点、画面动作、声音、原台词）和台词核对（只提示）。
3. 只给角色设定：点「开始剧情准备」，两步是角色与表达边界 → 单个故事候选，由服务端签发选中记录 `variant:V1`；首页显示这张候选卡，点进去生成完整剧情（不做展开前体检，它要对照原片）。
4. 点「生成分镜」（4.0 自主分镜）→ 角色参考图 → 在镜头弹窗里逐镜生成视频，沿用原有流程。

## 3. 契约（五个面）

| 契约 | 生产者 | 消费者 | 校验器 | 提示词 | 测试 |
| --- | --- | --- | --- | --- | --- |
| `storySource` Artifact（`story_source/1.0`：`storyMode` + 可选 `storyText`） | 服务端 `startStoryEntryRun`（`POST /api/production/run/story/start`），浏览器通用提交口拒收（`STORY_SOURCE_SERVER_ONLY`） | `trustedStoryEntryContext`（核对 Run 元数据里一次写定的 `storySourceDigest`，不符 `STORY_SOURCE_TAMPERED`）→ 两步流水线、完整剧情、分镜、人物精修、角色图、镜头视频的边界校验 | `public/story-entry.js` `normalizeStorySource`（浏览器与服务端同一份） | 候选与完整剧情提示词按 `JSON.stringify` 嵌入原文 | `test/story-entry-contract.test.js`、`test/story-entry-server.test.js` |
| Run 元数据 `entryMode` / `storyMode` / `storySourceDigest` / `creatorProfile` | 同上，建 Run 时一次写定 | 服务端各任务 `prepare` 按它分支依赖与校验；浏览器 `restoreRunMetadata` | `assertRunEntryMode`：视频专用任务在剧情 Run 上、`storyPipeline` 在视频 Run 上一律 409 `TASK_ENTRY_MODE_MISMATCH` | — | 同上 |
| 角色边界 `sourceDigest` 第 2 版（`story_source/2`） | `src/character-boundary.js` `computeCharacterBoundarySourceDigest(input, { source })`；参考视频那一版函数体逐字不变 | `workflow.assertGlobalCharacterBoundary(input, { storyEntry })`、`verifyBoundaryForMedia` | 版本号写进哈希输入；两版键集合不相交，互相验证必失败 | `storyEntryVisualGuardrailsPrompt`（共用判断规则逐字复用，`sourceSimilarityRules` 必须为空） | golden 摘要 + 跨版本拒绝 |
| 单个原创候选（只给角色设定） | `workflow.createStoryEntryCandidate`：id 由服务端签发 `V1`，三个投影按拍号派生；粘贴原文的 Run 调用它直接 InputError | 完整剧情候选绑定（`storyEntryFullStory` 用剧情入口 Schema 复核） | `src/contracts/contract-validator.js` 从视频版严格 Schema 派生：去掉 `transformationProof`、`experienceFidelity`、`originalityRiskCheck`、`highValueBeatMapping`，`maxItems: 1`；两份 Schema 互相拒收 | `storyEntryCandidatePrompt`（只给角色设定时原创一个；遇到粘贴原文直接抛错）；MiMo 约束解码 Schema 同样派生 | 同上 |
| 完整剧情（只给角色设定） | `workflow.createFullStory(input, { storyEntry })` | 4.0 分镜 | 与视频入口同一套 `validateFullStoryForSigning`；不要求创意简报与签名的脚本还原（由服务端给的 `storyEntry` 决定，不看请求体缺了什么） | `storyEntryFullStoryPrompt`：在 `fullStoryPrompt` 上做逐字锚点替换（`src/prompt-anchors.js`，锚点对不上直接抛错）；视频版提示词一个字不改 | 同上 |
| 可翻拍镜头（粘贴完整故事，`fullStory:V1`） | `storyPipeline` 第二步（子任务 `storySceneScript`）与分场页「重新拆分」（独立 `fullStory` 任务）都调 `storyEntrySourceFullStory` → `workflow.createFullStory(input, { storyEntry })` 的按原文拆场分支 | 4.0 分镜、台词核对 | 同一套 `validateFullStoryForSigning`；`selectedVariantId` 由服务端覆盖成故事位 `V1`；请求体带候选副本 400 `STORY_ENTRY_INPUT_INVALID`；没有候选绑定的前后复核，靠冻结依赖（`storySource`、`visualGuardrails`）复检 | `storySceneScriptPrompt`：原文是唯一依据、没有候选；主角改名与台词逐字的规则；共用规则在运行时从 `fullStoryPrompt` 逐字截取（`extractSectionExactlyOnce` / `extractLineContainingExactlyOnce`） | 同上 |
| 4.0 分镜台词锁（粘贴原文） | `createStoryboardPlan(..., { storyEntry })` | — | 无新增硬校验 | `storyboardPromptWithLockedDialogue` 只替换第 2 条「调整非核心对白」；修订环节保留内容加一句「对白逐字保留」 | 同上 |
| 台词核对报告 | `POST /api/production/story-entry/dialogue-check`（现算现给） | 完整剧情页提示区 | 只读：去掉标点后在原文里逐字找得到才算（`normalizeDialogueChars`） | — | `test/story-entry-contract.test.js`、`test/story-entry-ui.test.js` |

剧情 Run 的依赖图：

```
只给角色设定：
storySource → visualGuardrails → themeVariants → variant:V1
{storySource, visualGuardrails, themeVariants, variant:V1} → fullStory:V1
{storySource, visualGuardrails, variant:V1, fullStory:V1} → animationPlan:V1 → characterImages / shotVideoPrompt / shotVideo（不变）

粘贴完整故事（没有候选，V1 是故事位）：
storySource → visualGuardrails
{storySource, visualGuardrails} → fullStory:V1（可翻拍镜头）
{storySource, visualGuardrails, fullStory:V1} → animationPlan:V1 → characterImages / shotVideoPrompt / shotVideo（不变）
```

## 4. 刻意没做 / 已知缺口

- **台词核对只提示不拦截。** 没有真实命中率数据之前，在最贵的一次调用之后加硬闸门违反仓库经验规则；也没有安全的自动修补（转述被写成台词、长句被拆开）。有了回放数据再评估。
- **只核对一个方向**：剧情与分镜里的每句台词能否在原文找到；原文里的每句台词是否都被用上，需要从自由文本里猜哪些字是台词，不做。
- **角色边界阶段不看故事原文**，只看固定角色设定。故事里对主角外观的描写不会进入签发边界；请把长相写进「固定角色」。
- **主角名**：原文里找不到固定角色名时，开 Run 前先问用户；确认后拆场时把主角改用固定角色的名字——这是严格按原文唯一允许的改动（规则在 `storySceneScriptPrompt` 里，签发时由固定角色校验兜底）。
- **不支持**：展开前体检、候选对照评审、命题定向修订、剧情「按问题修改」（都要对照原片）；v3 测试/规划包导出（`PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED`）；`storyPipeline` 的暂停与终止；粘贴原文的 Run 不提供「检查剧情硬伤」（它要拿候选核对承诺，登记在 `docs/待解决项.md` 第 18 条）。
- **人物精修提示词**仍是视频入口那一份（含一句与原片相似的说明、受控改编系统提示），第一期未改。
- **「生成角色参考图」弹窗必须先上传一张图**：只有文字设定的剧情入口用户没法在页面里直接按文字出图（服务端任务本身允许不带参考图）。真实运行时用服务端同一任务、不带参考图出图来验证这一段。
- **4.0 Plan 没有画风**，参考图容易出写实照片而被 Seedance 当成真人拒收；参考视频入口同样存在，登记在 `docs/待解决项.md` 第 17 条。
- **任务管理器核心未改**：`storyPipeline` 没有暂停/终止所需的 controller；子任务用量随父任务结果汇总，关闭页面时的清理按通用路径处理（已核对 `runChildTask` / 清理逻辑不依赖 controller）。
- 父任务签发 `variant:V1` 时不调用 `assertFrozenContextCurrent`（它会核对父任务全部目标，而其中两个刚被自己的子步骤提交）；提交口在 Run 锁内只核对 `variant:V1` 这一个目标、冻结依赖 `storySource`，并要求 `themeVariants` 仍是刚读到的那一版。

## 5. 验收证据（2026-10-09，第一版：粘贴原文也有候选）

基线：开工前把原有未提交改动单独提交为 `7265af9`；本期改动在分支 `story-entry-phase1` 上，第一版提交为 `0dc3f5b`。这一节记录的是第 6 节补充之前的做法；里面粘贴原文那个 Run 仍带候选（`themeVariants` / `variant:V1`），补充后照常能打开，之后重新生成的走新依赖图。

### A 静态检查

`git diff --check` 无输出，新文件没有行尾空白，逐个文件审过 diff。视频版提示词所在的两个文件只多了 `export` 和一个新函数 `storyboardPromptWithLockedDialogue`，原有提示词文本没有改动（见 B 的第二条 golden）。

### B 自动化测试

`npm test`（Node 24.21.0）共 1857 项：1851 通过，0 失败，6 跳过。跳过的 6 项是分镜终审和定向修订的测试，因为本机没有真实夹具，原本就跳过，与本期无关。本期新增 28 项，全部通过：

- `test/story-entry-contract.test.js`（18 项）：
  - 两条 golden：参考视频 Run 的角色边界摘要，以及视频版完整剧情（带/不带时长目标两种输入）、角色边界、4.0 分镜提示词，都与 `7265af9` 对同一输入算出的值逐字节相同；
  - v2 摘要签发与校验；两个版本互相验证都失败；改故事或设定后验证失败；
  - `storySource` 与 `creatorProfile` 的输入校验；两份候选 Schema 互相拒收、恰好 1 个候选；约束解码 Schema 不含服务端签发的字段；
  - 剧情入口的提示词不出现「原片」、不用受控改编的系统提示；锚点缺失或重复时直接报错；4.0 分镜锁台词；台词核对；
  - 模型写了 `sourceSimilarityRules` 就拒收；候选 id 一律覆盖成 `V1`，多给一个候选直接失败；剧情 Run 不要求创意简报与签名的脚本还原，视频 Run 仍然要求。
- `test/story-entry-server.test.js`（2 项）：起真实 `server.js`，模型服务用假的，从开 Run 一路跑到 4.0 分镜、单镜提示词、角色参考图和人物精修。
  - 正向检查：依赖链；`variant:V1` 的签发，以及重跑时三步全部复用、不重复签发；发给模型的请求里没有图片或视频；Run 元数据和 Task Store 都不含原文。
  - 反例：主角名在原文里找不到（409）；输入不合法（400）；带着参考视频上游的副本请求（400）；剧情 Run 上调用视频专用任务（409）；浏览器提交 `storySource`（403）；摘要被篡改（409 `STORY_SOURCE_TAMPERED`）；导出生产包（`PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED`）；旧版分镜（`STORY_ENTRY_PLAN_VERSION_UNSUPPORTED`）；视频 Run 上跑剧情流水线（409）；页面带来的 `creatorProfile` 与开 Run 时不一致（409）。
- `test/story-entry-ui.test.js`（8 项）：
  - 恢复后入口与原文回填正确；请求体不带三份原片上游；不请求展开前体检，也不由页面提交选中记录；
  - 导出禁用；时长标签；两步进度与按钮文字；台词核对；
  - 改故事原文、切换剧情模式或改固定角色设定时作废当前剧情 Run，只差首尾空白不算修改。这条在临时副本里去掉作废逻辑后会失败，恢复后通过。

### C 真实运行（本机，MiMo `mimo-v2.6-pro` 开思考，Seedream 5.0，Seedance 2.0）

| | 粘贴完整故事（198 字原文） | 只给角色设定 |
| --- | --- | --- |
| Run | `project-4eb53a46-…/run-4c7b233c-a316-48ac-93cc-079461fb8239` | `project-5df34f7e-…/run-63373433-0689-4747-b3ec-d5e816460f01` |
| 剧情准备（两步） | 2 次调用，14,822 token，190 秒（边界 155 秒 + 候选 35 秒） | 2 次，17,182 token，178 秒 |
| 候选 | 1 个，`V1`《雨天的小橘猫》，6 拍 | 1 个，`V1`《小满挖了一条河》，6 拍 |
| 完整剧情 | 2 次，20,551 token，114 秒；`full_story/1.2`，5 场，60 秒，3 句台词 | 2 次，22,333 token，135 秒；6 场，62 秒，13 句台词 |
| 4.0 分镜 | 4 次，66,483 token，330 秒；6 镜共 62 秒 | 4 次，78,211 token，367 秒；6 镜共 62 秒 |
| 台词核对 | `checked: 6, missing: []`，原文 3 句台词逐字保留 | 不适用（`applicable: false`） |

- **依赖链与 manifest 一致**：`storySource → visualGuardrails → themeVariants → variant:V1`；`fullStory:V1` 依赖 `storySource`、`visualGuardrails`、`themeVariants`、`variant:V1`；`animationPlan:V1` 依赖 `storySource`、`visualGuardrails`、`variant:V1`、`fullStory:V1`。两个 Run 都没有原片分析、脚本还原和创意简报。
- **原文只在 `storySource`**：Run 元数据只记 `storySourceDigest`；`tasks/index.json` 搜不到原文；浏览器 `localStorage` 只有 `directorProfile`，`sessionStorage` 只有工作区 ID 和模型覆盖，都不含原文。拿原文里的一段去搜调试目录，只在候选阶段的模型输出（`model-output.txt`）里搜到，那是模型按原文整理出的候选；调试侧车只记模型输出，不记提示词。
- **刷新后能恢复**：刷新页面并等几秒异步恢复后，入口、原文、候选卡、完整剧情、台词核对和 6 个镜头都在。任务记录没有新增，说明没有重新调用模型。
- **逐镜视频（粘贴完整故事的 Run，镜头 A01）**：
  - 第一张角色参考图是写实风格（Seedream，49 秒）。Seedance 以 `InputImageSensitiveContentDetected.PrivacyInformation`（HTTP 400）拒收，任务如实失败，没有产出。
  - 按用户选择改成二维动画风格重出参考图（38 秒），A01 用全能参考模式重新生成，144 秒成功。
  - 成片 `shotVideo:V1:A01` r1：9.088 秒，1280×720，带音轨。抽帧看是动画风格的小满在雨里跑向花坛，和参考图一致。
  - 每次设参考图都会签发新的 Plan revision（r1 → r2 → r3），旧的角色图与单镜提示词随之失效。这是视频入口原有的行为。
- **两个 Run 的文本调用次数**：从开始到分镜都是 8 次。粘贴故事的 Run 另有 2 次单镜提示词（各约 3,500 token）、2 次出图和 2 次视频提交。

### D 页面上能看到的

首页的入口切换和故事面板、两步进度、候选卡（没有「换一批」「对照原片体检」和相似风险）、完整剧情页的台词核对提示、4.0 分镜，以及镜头弹窗里的视频候选（「已生成 1 条视频候选，可选择一条设为当前镜头视频。」）。

### 真实运行发现、本期没有修的

- 「生成角色参考图」弹窗必须先上传图片，只有文字设定的用户没法在页面里按文字出图。这次是在页面里直接调用服务端同一个任务、不带参考图出的图（见第 4 节）。
- 4.0 分镜的 Plan 没有画风，写实参考图会被 Seedance 拒收（`docs/待解决项.md` 第 17 条）。
- 台词核对只提示，不拦截（`docs/待解决项.md` 第 16 条）。

## 6. 补充：粘贴完整故事直接拆镜头（2026-10-09）

### 为什么改

用户测试时指出：给了完整剧情，就不该先「整理成故事候选」再「展开成完整剧情」，只要按这个剧情生成可翻拍镜头和分镜。第一版真实运行（第 5 节）的数据也说明候选这一步多余：

- 候选把 198 字原文逐句抄进 6 拍，只多了标题、简介和「剧情型 / 配乐 / 约 61 秒」几个标签；
- 它多花一次调用（35 秒、6,719 token），还要多点一次「进入完整剧情」；
- 「按原文整理的故事」「把你的故事展开成可拍完整剧情」这些说法，让人以为故事被改写了。

用户选的流程：点「开始拆镜头」→ ① 角色边界 ② 可翻拍镜头（停下给用户看）→ 点「生成分镜」→ 角色参考图 → 逐镜视频。「只给角色设定」不变。

### 改了什么

1. **依赖图**见第 3 节。粘贴原文的 Run 不再有 `themeVariants` / `variant:V1`。`V1` 是故事位，`fullStory.selectedVariantId` 由服务端写定。完整剧情、分镜、角色图与人物精修的请求体出现候选副本，一律 400 `STORY_ENTRY_INPUT_INVALID`；剧情 Run 只接受故事位 `V1`。
2. **`storyPipeline`**：
   - 步骤、目标与模型快照在 `prepare` 里按可信的 Run 元数据决定（`storyPipelinePlan`）；任务管理器以 `prepare` 返回的为准，核心没改。
   - 第二步子任务 `storySceneScript` 与分场页「重新拆分」用的独立 `fullStory` 任务调同一个函数 `storyEntrySourceFullStory`。
   - 它没有候选绑定的前后复核，靠冻结依赖（`storySource`、`visualGuardrails`）在调用前后复检。
3. **新提示词 `storySceneScriptPrompt`**：
   - 新写的只有和原文有关的规则：原文是唯一依据、主角改名（唯一允许改的字）、台词逐字、只补时间 / 地点 / 画面动作 / 声音、收尾停在原文结尾。
   - 共用规则在运行时从视频版 `fullStoryPrompt` 逐字截取（`extractSectionExactlyOnce` / `extractLineContainingExactlyOnce`）：场次合同整段、输出结构、字段职责、外观不等于能力、道具承接、角色与道具之分、跨场登记、时间轴写法。截出来提到候选的 5 处，按锚点换成「原文」。
   - 视频版提示词由 golden 测试锁定逐字不变；「只给角色设定」的三份提示词（角色边界、候选、完整剧情）改前改后哈希逐字节一致。
4. **删掉用不到的分支**：候选和「只给角色设定」完整剧情两份提示词里原来的粘贴原文分支删掉了，遇到粘贴原文直接抛错；`createStoryEntryCandidate` 在这类 Run 上返回 InputError。
5. **页面**：
   - 按钮依次是「开始拆镜头 / 拆镜头中… / 继续拆镜头 / 重新开始拆镜头」；第二步叫「可翻拍镜头」；拆好后自动进分场页。
   - 首页的候选卡换成入口卡（N 场 · 约 M 秒 · 查看可翻拍镜头）；首页大标题在剧情入口不再说「改编」。
   - 分场页：
     - 标题是「把你的故事拆成可翻拍的镜头」，左侧是原文卡；
     - 「重新拆分镜头」在已有分镜时先确认；
     - 配乐开关挪到「生成分镜」旁，生成期间禁用；
     - 不显示「检查剧情硬伤」。
   - 剧情入口两种模式的分镜按钮与状态都叫「分镜」。粘贴原文时 fullStory 的状态文字叫「可翻拍镜头」：`task-status-ui.js` 与 `full-story-control-ui.js` 加了可选的叫法参数，默认文字不变。
6. **顺带修了一个旧 bug**：配乐开关在已有分镜时调用 `generateAnimationPlan(true)`，函数签名却是 `{ force }`，结果只重画、不重新生成，与确认框的说法不符。现在传 `{ force: true }`，参考视频入口同样受益。

### 没做 / 已知

- 剧情体检改拿原文核对：这次只隐藏按钮（`docs/待解决项.md` 第 18 条）。
- 第 5 节那个旧的粘贴原文 Run 不迁移：照常能打开，重新生成的部分走新依赖图。
- 角色边界提示词里「后续故事候选、完整剧情和动画生产包共用」这句是两种模式共用的，没改。它不影响判断，改了会让「只给角色设定」的提示词也跟着变。
- 完整角色表那一步只调一次、不重试，真实运行里撞上了一次（`docs/待解决项.md` 第 19 条）。

### 验收证据

**A 静态**：`git diff --check` 无输出，逐文件审过 diff。视频版提示词的 golden，以及「只给角色设定」三份提示词的哈希，都与改动前一致。

**B 自动化**：`npm test` 共 1862 项：1856 通过、0 失败、6 跳过（同第 5 节，缺本机夹具）。剧情入口的测试共 33 项：契约 19、服务端 2、页面 12。

- 服务端：
  - 粘贴原文从开 Run 一路跑到单镜提示词、角色图和人物精修。流水线 3 次调用，全部计入它的用量；Run 里只有 `storySource` / `visualGuardrails` / `fullStory:V1`；重跑时全部复用。
  - 「重新拆分」走独立任务；分镜依赖正确；角色图不需要 `variant:V1`。带候选副本或别的故事位的请求返回 400。
  - 「只给角色设定」补测到完整剧情与分镜，候选路径照旧。
- 契约：
  - 拆场提示词带原文、不提候选和原片，包含改名与台词规则；共用段落逐字等于视频版；careRecipient 的形状等于严格 Schema。
  - 锚点截取的正反例都覆盖。
  - 没有候选也能签发，`selectedVariantId` 是 `V1`；模型回显的 `V7` 会被覆盖。
  - 在粘贴原文的 Run 上调用候选提示词或旧完整剧情提示词，直接报错。
- 页面：两种模式的恢复、分场页的文字与按钮、请求体不带候选、进度与按钮文字、台词核对、配乐开关重新生成以及生成期间禁用。
- 反向验证：把配乐 bug 改回去，或者让故事位被当成候选发出去，对应的测试都会失败。

**C 真实运行**：MiMo `mimo-v2.6-pro`，同一段 198 字故事，Run `project-fc5d7406-…/run-63bced2b-d135-4ca2-885e-c249f0cdb80e`。

| 步骤 | 结果 |
| --- | --- |
| 第一次「开始拆镜头」 | 角色边界 108 秒（1 次、7,106 token）；拆场那次调用成功，但紧接着的完整角色表被拦：`小橘猫.storyRole 缺少来源证据`。本次共 3 次调用、25,713 token。页面把第二步标为「失败」，按钮变成「继续拆镜头」 |
| 「继续拆镜头」 | 第一步复用，第二步 2 次调用、18,011 token、189 秒，成功 |
| 依赖图 | `storySource → visualGuardrails → fullStory:V1`，没有候选和选中记录 |
| 可翻拍镜头 | `full_story/1.2`《雨天的纸箱》，4 场、60 秒，事件顺序与原文一致；原文 3 句台词逐字保留（台词核对 3/3）；补的只是画面与声音细节（例如王爷爷从门卫室递出纸箱、雨停后天光变亮） |
| 生成分镜 | 第 1/4 步「设计分镜」进行 135 秒后，被 MiMo 内容审核拦截：`MODEL_CONTENT_FILTERED`，已输出 5,094 token，1 次调用、11,499 token。按仓库规则不自动重试；页面显示审核原因，按钮恢复可点 |
| 用户随后的测试（自己的一段 604 字故事，新建 Run） | 「开始拆镜头」一次跑完：3 次调用、31,275 token、332 秒。「生成分镜」成功：4.0，4 次调用、86,080 token、785 秒，6 镜共 60 秒。依赖链为 `storySource → visualGuardrails → fullStory:V1 → animationPlan:V1`，分镜依赖 `fullStory:V1`、`storySource`、`visualGuardrails`，没有候选；台词核对 8/8 |

对比第一版：从开始到拿到分场，成功那条路径少 1 次调用、少约 1 万 token，也少点一次。我这次的分镜被第三方审核拦截，与本次改动无关；同一流程下，用户随后在自己的故事上一次跑通了拆镜头和分镜。

**D 页面**：
- 首页：剧情入口的大标题、「从你的故事到可翻拍镜头」两步进度、入口卡。
- 分场页：原文卡、「用 mimo-v2.6-pro 重新拆分镜头」、配乐开关、「生成分镜 · 16:9」、台词核对。
- 从入口卡进分场页不会触发任何生成。
