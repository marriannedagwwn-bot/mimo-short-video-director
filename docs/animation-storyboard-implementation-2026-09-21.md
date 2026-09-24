# Animation Plan 自主分镜接入计划与证据

## 已确认范围

用户已完成原型回放并明确要求落地到当前工作区。开始时工作区干净，分支 `codex/story-quality-phase1`，HEAD `eefbca1e272c87a84a97c922b5e120d1cc861cd3`，无需先提交。保持已有提交，不 reset/stash/checkout。

- 新生成的 Full Story 保存所有实际出镜或发声角色的完整已有事实；未知配角外观交给 Animation Plan。原始正文和主角条目不能被角色整理调用改写。
- Animation Plan 只接收完整剧情、角色事实、画幅、目标时长和风格/表情/声音参数；完整上游仍参与冻结与验签，不注入分镜创作提示词。
- AI 自定生成片段和时间分配，可合并相邻剧情，保留核心因果、身份关系和结局。每个生成片段 4–15 秒，可有多个内部摄影/表演段。
- 完整初稿后执行一次有界修订流程，使用 Full Story 的修订与引导方式；已有合理解释只作提示，语义意见不阻断继续。结构、来源和角色签名照常严格检查。
- 点击单镜视频按钮才生成该镜头提示词，允许查看、编辑、重生成，确认才调用视频。提示词只翻译已定分镜，不看实际参考图，不重做导演安排。
- 不增加新版批量视频、手动终审/定向修订界面或跨独立视频的连续音轨。
- 用户纠正：保留现有 Full Story，根据它重新生成包含镜头的完整 Animation Plan，不要求先重生成 Full Story。旧剧情缺配角事实时只为本次 Plan 整理角色资料，不重新展开正文、不改写或重签原 Full Story。已签发旧 Plan 继续原有阅读和视频路径。

## 版本与实施顺序

1. 增加显式 `full_story/1.2` 完整角色表与严格校验。复用既有剧情展开，随后单次整理配角事实并验证原文证据；原正文/主角保持原样。浏览器明确请求新版，旧 API 未请求版本时保留历史行为。
2. 增加显式 `promptSchemaVersion: 4.0` 自主分镜合同，移植已回放通用提示词，移除新版对旧场次均分骨架的依赖。旧 2.0/3.0 不迁移。分镜、修订意见和参考资料进入同一 Plan revision。
3. 增加按镜生成提示词的独立任务/缓存，与当前 Plan revision/digest 和目标视频配置绑定。重复点击复用 current 缓存，重生成明确创建新版本，Plan 改动令旧缓存失效。复用既有视频确认窗和媒体生产入口。
4. 展示完整 beats、改编与引导说明；保留旧版显示。按 transitionIn 选择上一片段参考，首段、切换及时间省略不默认继承。
5. 单元/路由/恢复回归、真实模型回放与浏览器验收，保存 Markdown 与原始 completion。同步 README、AGENTS 与本文证据。

## 事实来源和实施假设

Full Story 是剧情唯一来源；签发角色边界约束固定角色；Full Story 完整角色表保存配角已知事实；Animation Plan 只为未指定的外观作设计。新版 beats 是单镜视频提示词的动作/摄影/对白权威，运行时衍生旧媒体接口所需字段不另存成第二份模型事实。

当前失败不是单句提示词就能修好：旧实现先按 Full Story 时间轴确定镜头骨架，并在生成分镜时产出视频提示词；这与已确认的自主分镜及延后提示词流程冲突。新版本隔离旧合同，能在不篡改历史数据的前提下落实新流程。若实际请求仍包含候选/Brief/原片叙事，或生成分镜已经调用视频提示词/视频，则本轮实施失败。

合法反例：安静停留不必增加新动作；局部特写与画外对白可以成立；空镜可以没有出镜角色；相邻场次可共用一个生成片段。模型语义意见只提醒，不以关键词或打分强制修稿。

## 事前验收

- A：新旧 Schema 正负例、语法、版本路由、原文证据与时间连续校验；提交前 `git diff --check`。
- B：角色全集/单场/仅声音/未知外观；跨场合并与局部特写；逐条修订原子性；提示词按需生成、缓存、再生和 stale；旧版媒体和任务路径回归。全量 `npm test` 在修改前已启动建立基线，修改后比较失败集合。
- C：Node 24 新进程、真实项目 WorkflowService/任务路由；模型实际请求和 usage；必要时按仓库规则重启当前服务器，不影响其他进程。
- D：浏览器检查新旧展示、现有 Full Story 直接生成新版分镜、生成按钮到可编辑提示词窗口的实际流程；真实《阵雨下的小蘑菇》回放保存 Markdown、原始响应及残余语义问题，不生成视频来替代本轮文本验收。

## 执行记录

### A 静态验证

新版 Schema、版本路由与语法检查通过。`git diff --check` 通过。正文没有人工替换；单镜媒体适配只读派生旧接口字段。

### B 自动化行为验证

`node --test test/storyboard-workflow.test.js test/storyboard-server.test.js`：9/9 通过。覆盖旧剧情不重新生成、角色登记/引文、严格时间/角色/字段校验、语义提示保留、问题原子修订、单镜提示词、出镜与画外音参考分离。

真实 HTTP 测试启动独立 Node 24 服务，文本模型由本地 SSE 协议夹具代替：旧 Full Story 的 revision/digest 保持不变，Plan 与单镜提示词各自签发，Task Store 不保存提示词正文，错误 Plan digest 在派发前拒绝；运行中更换 Plan 后迟到结果记 `conflicted`，旧提示词 stale。该测试不证明 AI 质量。

修改前 `npm test` 为 1891 tests / 1867 pass / 18 fail / 6 skipped；首次修改后为 1899 / 1875 / 18 / 6。失败项全部与基线一致，位于历史 `exports/` 快照与编辑实验。最终 `npm test` 为 1901 tests / 1877 pass / 18 fail / 6 skipped，9.42 秒；新增与消失失败集合均为空。

### C 真实运行

本机 4173 的 Node 24 服务已重启加载工作区修改。用用户原始 `/Users/qinfen/Downloads/阵雨下的小蘑菇.json` 直接调用当前 WorkflowService：首次请求连接失败；第二次角色整理成功，但分镜调用流中断；第三次回放复用第二次的真实角色响应（不是新增事实、不重跑 Full Story），收到完整分镜。片段时长为 10/10/12/12/15/20 秒，合计 79 秒，末段超上限而拒绝签发，未进入后续审阅/修订/单镜写稿。没有修改验证器放行，也没有人工把 20 改成 15。

所有输入与逐次原始响应保存到 `/Users/qinfen/Downloads/AnimationPlan-回放-2026-09-21/production-workflow/`。完整新分镜：`resume-design/2-模型原始输出.md`；阅读版：`resume-design/完整分镜-未签发.md`。失败记录也保留。是否允许一次同模型结构修复正在等用户选择；在确认前不增加该分支、不继续依赖它的真实回放。

### D 用户可见结果

浏览器在 4173 成功导入用户原文件，直接显示生成 Animation Plan 按钮，没有要求重生成 Full Story。另以独立端口及合成剧情完成交互验证：旧剧情→新版完整分镜展示→单镜提示词任务→可编辑窗口。切换全能参考不覆盖手工编辑，关闭重开仍只有一个提示词任务，明确点击重新生成后为两个任务；没有创建任何视频任务。新版不显示批量视频与手动终审按钮。首页补上复用已有导入功能的入口。

### 修改范围与完成边界

工作区起始干净，没有需要先提交的旧改动；当前实现保留在 `codex/story-quality-phase1` 的未提交修改中，HEAD 仍为 `eefbca1e272c87a84a97c922b5e120d1cc861cd3`。没有推送、重置或暂存。候选、展开前体检、旧 direct_shot 提示词、视频供应商协议与代理配置未改。

新 Full Story 1.2 的真实整段生成、真实分镜成功签发及后续自动修订、真实单镜写稿、角色图片生成与视频成片尚未完成本轮验证。当前缓存属于 Run 内业务 Artifact，生产包不携带单镜提示词缓存；导入后点击镜头时重新编写。字段通过不能证明表演、因果与画面质量成立。本轮实现及协议交互已验证，真实样本仍因时长不合格待下一步决定。

---

# 后续：允许第一次做错（带诊断重试一次，2026-09-22）

## 起因

上面 C 段记的那次真实回放是这一档**唯一一次**真实调用，它没签发成功：模型把末段写成 20 秒，
失败诊断只有一条算术级的 `/shotPlan/5/durationSeconds must be <= 15`，整份 79 秒、6 段 13 拍的
完整分镜连同 ¥0.35、106 秒一起丢弃，**而模型自己不知道错在哪**。

根因不是提示词没写清楚——`storyboard-prompts.js` 第 4 条明写「时长必须是 4–15 秒整数」。
这属于「模型不听提示词」，`AGENTS.md` §2.12b ⑦ 与 `docs/animation-plan-review-落地方案.md` §4
对这一类已有实测定论：**事前在提示词里定规矩没用（三次加码都没用），事后拿诊断打回去重做有用。**
候选评审、剧情体检、定向修订三档都搬了这个结论，只有本档没搬：共用的 `call()` 写死
`maxProviderCalls: 1, shouldRetry: () => false`，而它被 6 个阶段共用——任何一环失败都让整份 Plan 报废。

**校验逐字未改。改的是「错了之后怎么办」，不是「什么算错」。**

## 改动

1. **时长边界收敛成一份。** 原来有三份字面量（`validation.js` 的常量、`storyboard-contract.js`
   的 `minimum:4,maximum:15`、提示词正文的「4–15 秒」）。常量移到**零依赖**的
   `src/shot-duration-limits.js`，schema 与提示词都引用它，`validation.js` 原样 re-export
   所以既有消费者一个没改。
   **必须是独立模块**：`validation.js` 与 `storyboard-contract.js` 相互导入，而 ajv schema 在
   模块求值期就要读这两个数，从 `validation.js` 取会落进暂时性死区（实测
   `Cannot access 'DIRECT_SHOT_MIN_DURATION_SECONDS' before initialization`）。

2. **校验器输出结构化诊断。** `storyboardValidationErrors` 从 `string[]` 改为
   `{code, path, reason}[]`（ajv 分支直接用 `instancePath`，手写检查各给稳定 code 与指针），
   `ensureStoryboardDesign` 把它们传进 `OutputContractError` 的**第二参数**。这是支点：
   `classifyAttemptError` 本来就把 `OutputContractError` 判为 `retryable` 并把 `details` 原样
   放进 `issue.diagnostics`，所以这条路**不需要任何错误类型转换**。
   `storyboard-review.js`、修订合并与单镜写稿的校验同步带上 code + 指针——没有结构化诊断的重试
   只能原样重发，等于白给。

3. **`call()` 允许第一次做错。** 预算固定 2 次，**禁止第三次**；去掉 `shouldRetry: () => false`
   让 `classifyAttemptError` 的默认判定生效（传输中断同样吃这 2 次预算）。
   新增 `storyboardRetryPrompt`：原提示词逐字保留在前面，末尾只追加校验器数出来的
   `path / reason / code`，**不另写一套人话翻译**；没有结构化诊断时退回原提示词。
   **截断走单独分支**——`MODEL_OUTPUT_TRUNCATED` 那一刻没有任何校验诊断，只认「有没有诊断」
   会原样重发、第二次照样写超。

4. **两次都被拦时两次诊断都在。** `ModelPipelineError` 只带最后一次，所以本档自己合并并给每条
   打 `attempt` 序号（形状照 `workflow.js` 的 `candidateReviewPipelineFailure`）。
   注意 `ModelPipelineError` 会归一化诊断：自定义的 `attempt` 落到 `metadata.attempt`，
   `reason` 变成 `message`。

5. **六个阶段注册进 debug 侧车。** 此前**一个都没注册**、`call()` 也没接 `attemptObserver`，
   按 `AGENTS.md` §三 的既有结论这会**静默不写**。`providerCalls` 由 observer 计数，
   **不能从「有没有被拦」反推**——传输失败时供应商确实被调用了两次而没有诊断，
   少报就等于把花掉的钱藏起来。观测本身 fail-open，写入抛异常不改变成败。

6. **消费者面一起改了。** `metadata.storyboard` 增加 `providerCalls` 与逐阶段 `calls`；
   `renderStoryboard` 在报告顶部以 warn 色显示「某阶段是第 N 次调用的结果，第一次被什么拦下」。
   旧 Plan 没有 `calls` 这个键时**整段不显示**——显示一个「1 次」会被读成「查过了没被拦」。
   （`AGENTS.md` §2.12b ⑤⑥ 记过：落地当天漏掉消费者面是静默漏，页面上只是空白不是报错。）

## 验证

`node --test test/storyboard-workflow.test.js test/storyboard-server.test.js`：19/19 通过。
新增 10 条：第一次被拦后带诊断重做、metadata 如实记账、两次都被拦 fail closed 且两次诊断都在、
截断走单独分支、空诊断退回原文、观测 fail-open、演示模式零调用、时长边界同源（源码断言）、
六个 scope 逐字注册（源码断言）、浏览器必须显示「拦过一次」。
「禁止第三次」是**被证明**的而不是被声明的：预置响应只给到第 3 次，真发起第 4 次会撞「预算被超用了」。

全量 `npm test`：改前 **1916 / 1892 pass / 18 fail / 6 skipped**，改后
**1926 / 1902 pass / 18 fail / 6 skipped**，**新增与消失的失败集合均为空**（18 个历史失败在
`exports/` 快照与编辑实验里，与基线逐条一致）。

浏览器：4199 demo 实例加载零控制台错误、零服务端错误；4173 按 `npm start` 原命令重启加载新代码。

### 真实回放：重试在 live 触发并救回了这一份（2026-09-22）

同一份冻结输入（`阵雨下的小蘑菇.json`）重跑，输出在 `retry-with-diagnostics/`。
**同一个失败精确复现，且第二次修好了**：

| | 片段时长 | 结果 |
| --- | --- | --- |
| 第 2 次调用（设计初稿，116 秒） | `10 / 12 / 10 / 14 / 13 / **20**` | 末段超上限，被拒 |
| 第 3 次调用（带诊断重试，81 秒） | `12 / 10 / 12 / 15 / 15 / 15` | **通过并签发** |

打回去的诊断只有一行，就是校验器数出来的那条：
`/shotPlan/5/durationSeconds must be <= 15（STORYBOARD_SCHEMA_INVALID）`。

**它不是把 20 砍成 15 了事**：合计仍是 79 秒，模型把超出的部分重新分配到了前面几段——
正是重试提示词要求的「优先调整安排本身（片段怎么分、各段多长、beat 怎么切），
不要为了绕过这几条就删掉已经想好的表演、对白或声音」。

整条链第一次真实跑完：7 次调用（第 1 次复用已录制的角色响应、6 次真实网络）、393 秒、
**¥1.63**、75983 tokens。签发 6 段 12 拍 79 秒，`fullStoryUnchanged: true`，
并继续走完审查 → 修订 → 终审 → 第一镜提示词。按旧代码，这一份在第 2 次调用就整份丢弃了。

**这次回放没有覆盖到的**：侧车。回放脚本直接 `new WorkflowService({clients, stageDefaults, keys})`，
不带 `stageModelOutputLogWriters`，所以 `debug/stage-model-outputs/` 下没有出现 storyboard 目录。
六个 scope 的注册由单元测试（源码断言 scope 与 stage 名逐字对应）与 `server.js` 的构造链保证，
**但没有经过一次真实的服务端落盘**，不得声称它已在 live 验证过。

**同一份数据再次确认上面两个缺口都还在**：8 句对白全是 `onscreen`、**画外音 0 次**；
6 场仍然 1:1 映射成 6 段，「合并相邻剧情」的授权第二次也没有动用。两次回放同向，
但仍然只有两个样本，按 §2.12b ⑤ 第 4 条不足以据此动手。

## 这个改动救不了什么

诊断只有校验器那么宽。**分镜设计得好不好、画外音该不该用、能不能合并相邻剧情，全是语义判断，
不产生任何诊断，也就不会触发重试。** 这条路只把「模型写超一秒、整份分镜被丢弃」这类失败从
fail closed 变成重做一次，**不提高分镜质量**。

上面 C 段观察到的另外两个缺口本轮**没有动**，且都只有一次回放的样本：
①画外音有 `source: "offscreen"` 枚举，但如果模型把画外台词留在 `soundDesign` 文本里而没有
写成 `dialogue` 条目，单镜写稿的逐字校验只遍历 `beat.dialogue`，那句台词就失去逐字进
`videoPrompt` 的保障；②「合并相邻剧情」的授权实测 0 次动用，6 场仍然 1:1 映射成 6 段。
按 `AGENTS.md` §2.12b ⑤ 第 4 条「单包结论在这个阶段是不可靠的」，这两条都不足以据此动手。


---

# 后续：把全局必需角色事实补写接进角色参考（2026-09-22）

## 起因

用《迷路的蒲公英》（188 份历史 Full Story 里**唯一**一份上游确有画外人声的 legacy 剧情）
做真实回放，本意是检验画外音链路。结果 5 次模型调用**全部一次通过**——角色整理、分镜设计、
审查、修订、终审都做完了，画外音也正确产出——却在**最后组装角色参考**那一步硬失败，
¥1.37 全部作废：

```
characterReference 未沿用全局角色边界：缺少全局必需角色事实：学生或村民身份
```

根因：`createStoryboardPlan` 直接拿剧情的 `characterBible.protagonist.traits` 当
`consistencyTags`，而那份 legacy 剧情只写了 `["活泼可爱","懂事","善解人意"]`，
边界要求的 6 条里缺了 identity 类的「学生或村民身份」（terms 是
`学生或村民身份 / 学生 / 村民`，小白子自己的扫描字段里一个都没有）。

**`characterBible.protagonist.traits` 从来没有「必须逐条镜像边界」的契约**，
所以这不是那份剧情有毛病——**任何 traits 没覆盖全部非 appearance 必需事实的旧剧情，
都签发不了新版分镜**。

## 改动

**这是把 `AGENTS.md` §2.8 给 `/api/refine-character-reference` 定的同一条既有策略接到
分镜路径上，不新建第二套规则、不改任何判定。** 判定函数
`characterReferenceRestorableMissingTraits`（`src/validation.js`）已经做了 scope 过滤，
实现范例在 `src/workflow.js` 的精修分支。

1. **在组装角色参考之后、边界检查之前补写**：缺哪条就在 `consistencyTags` **尾部按签发
   顺序**追加它的 exact `canonicalName`，`appearancePrompt` 与其余字段逐字冻结。
   对每一行都调用即可——helper 在 `characterName !== boundary.characterName` 时恒返回 `[]`，
   对配角是 no-op。
2. **补写只覆盖非 appearance scope**（由 helper 过滤）：外观必需事实缺失意味着模型真把长相
   写错了，补个标签不会让图里长出猫耳，那一档**仍然硬失败**。这条不对称是整个机制不沦为
   免检后门的唯一原因，由构造保证，并有专门的测试锁住。
3. **服务端改了模型输出就必须说出来 → 进 `metadata.storyboard.boundaryRestores`，
   不进 Artifact**。§2.8 要求这类提示只用于展示；精修那条路是浏览器写回 Plan 前剥离，
   而**分镜这条路没有写回步骤**（Plan 由服务端一次构造并签发），所以放 metadata 才是由
   构造保证干净。另有两条独立理由：`ensureStoryboardPlan` 对顶层键是严格集合比较，加键会被
   自己拒掉；而逐条 reference 的 shape 检查**不拒额外键**——写进去不会报错，但会进签发内容。
4. **浏览器显示出来**，与重试提示同规格；旧 Plan 没有这个键时整段不显示。

## 验证

`node --test test/storyboard-workflow.test.js test/storyboard-server.test.js`：25/25 通过。
新增 6 条：补写后正常签发且 `appearancePrompt` 逐字未变、**缺 appearance 类仍然硬失败**、
`boundaryRestores` 如实记账（无补写时为空数组）、补写说明不进 Artifact（顶层键集合逐字相同）、
配角逐字不变、浏览器必须显示。
演示夹具的边界只有一条 identity「阿岚」而 `characterName` 本身就在扫描字段里、恒满足，
所以测试按仓库既有写法用 `sealGlobalCharacterBoundary` 重签了一份带额外必需事实的边界。

全量 `npm test`：**1932 / 1908 pass / 18 fail / 6 skipped**，对比上一轮基线
1926 / 1902 / 18 / 6，**新增与消失的失败集合均为空**。

**零成本真实回放（关键验证）**：那次失败的 5 份模型响应全部留在
`~/Downloads/分镜画外音回放-2026-09-22/`，`verify-restore.mjs` 按序喂回、**不发任何网络请求**。
当时失败的那份输入现在签发成功：

- 5 段 / 12 拍 / 44 秒
- `boundaryRestores = [{characterName:"小白子", restoredTraits:["学生或村民身份"]}]`
- `consistencyTags` = `["活泼可爱","懂事","善解人意","学生或村民身份"]`（前三条逐字未变）
- `appearancePrompt` 逐字冻结，`boundaryRestore` 没有出现在 Artifact 里
- 画外对白 `村民：小白子，回家吃饭啦` 完整保留在签发内容中
- 用掉的录制响应正好 5 份——没有比当时多调一次模型

## 同一次回放顺带确认的两件事（与本改动无关，但要记着）

1. **画外音链路是通的，之前的 0 次是「没素材」不是「不会用」。** 上游给了素材，分镜模型
   第一次就写对了：`{speaker:"村民", text:"小白子，回家吃饭啦", source:"offscreen"}`，
   该 beat 的出镜名单只有小白子——镜头留在听者身上、声音从画外来。
   扫描 188 份历史 Full Story：`offscreenSoundSources` 非空的只有 **2 份**，
   带真正画外人声台词的只有 **1 份**。
2. **「AI 自定时长分配」也是真的会用，之前的 1:1 是输入决定的。** 这次它把 S1+S2 合并成
   一段（6 场 → 5 段），时长 `[8,10,10,10,6]` 与原跨度 `[6,6,10,8,8,6]` 不同，
   beat 数 `[2,3,3,2,2]` 也不再全是 2。
   而上一份《阵雨下的小蘑菇》场次跨度是 `[12,10,12,15,15,15]`，**任意相邻两场相加都超过
   供应商 15 秒上限**（22/22/27/30/30），合法的合并**一个都不存在**——
   那次的 1:1 不是模型不用自由度，是那份输入里没有自由度。

## 这个改动救不了什么

它只保证**边界要求的非外观事实不会在组装角色参考时丢失**。模型把长相写错、
或者把必需事实写成了另一个意思，都不在覆盖范围内——前者仍然硬失败，
后者需要语义判断，**没有确定性兜底**。

# 后续：设计分镜接入 MiMo JSON Schema 约束解码（2026-09-24）

## 起因

run-7336db89（《奶奶的录音》，V4，`full_story/1.2`）生成 Animation Plan 4.0，`storyboardDesign` 用 MiMo `mimo-v2.6-pro`（开思考、上限 65536）：

| 次 | 耗时 | completion token | 结果 |
|---|---|---|---|
| 1 | 357 秒 | 13803 | 结构错：`locations` / `props` 写到顶层而不是 `visualDesign` 里 |
| 2（带诊断重试） | 456 秒 | 17860 | 结构对了，但 `/shotPlan/2/beats/1/sourceSceneIds` 引用了片段之外的 S3（`STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT`） |

2 次预算用完，整份 Plan 失败。第一次那种错是 MiMo 开思考时的结构失败，与同日候选阶段、候选对照评审同一类；第二次是跨字段引用，约束解码管不到。第一次把唯一一次重试机会耗掉了。

## 改动（代码由 Codex 按任务说明编写，审查、测试与回放由 Claude 完成）

- `src/contracts/storyboard-design-model-schema.js`：`storyboardDesignModelSchema()` 从 `storyboardDesignSchema` 派生，`pattern:"\\S"` 改 `minLength: 1`；去掉未在 MiMo 上实测的 `uniqueItems` 与 `exclusiveMinimum`（只放宽模型那侧，服务端严格校验照样拦）；遍历整棵 Schema，出现已实测清单（type / properties / required / additionalProperties / items / minItems / maxItems / enum / minimum / maximum / minLength）之外的关键字、或别的 pattern 直接抛错；片段数由模型定，不锁。
- `src/storyboard-workflow.js`：`call()` 增加可选 `responseSchema`，只有 `storyboardDesign` 及其重试带；角色事实、审阅、修订、终审、单镜写稿都不带。
- 提示词、`storyboard-contract.js` 的校验与 `storyboardDesignSchema`、`STORYBOARD_PROVIDER_CALL_BUDGET`、客户端与 coordinator 均未改。
- 新增 `test/storyboard-design-model-schema.test.js` 9 条，覆盖派生规则、未知关键字报错、各层字段顺序与提示词模板一致、真实失败形状被拒、放宽的约束仍由服务端拦、全流程六个阶段只有设计分镜及其重试带 Schema 且提示词逐字不变。本机 `node --test test/*.test.js`：1784 tests / 1778 pass / 0 fail / 6 skipped。（Codex 沙箱不允许监听端口，它那边有 82 个与本改动无关的 `listen EPERM` 失败，改动前后失败清单一致。）

## 验证

- 离线：失败那次第一份输出被派生 Schema 拒绝（顶层多出 `locations`/`props`、`visualDesign` 缺这两项），第二份通过派生 Schema（它只有跨字段错）。
- 真实回放（同一份冻结输入：`fullStory-V4-r2`、`variant-V4-r1`、`visualGuardrails-r1`，16:9、无背景音乐；只调用设计分镜一步，请求与生产 `call()` 一致）×2 并发：

| 次 | 结果 | 调用 | 耗时 | completion token | 片段 / 总长 |
|---|---|---|---|---|---|
| 1 | **通过** | 2：第一次被 `STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT` 拦下（`/shotPlan/6/beats/1`），带诊断重试通过 | 945 秒 | 20496 + 12477 | 9 段 / 96 秒 |
| 2 | **通过** | 1 | 590 秒 | 20587 | 11 段 / 111 秒 |

MiMo 接受这份 Schema（没有 400）；结构错 0/3 次调用（改动前 1/2）。样本只有一份剧情、两次回放。

## 反复出现、未处理：过渡拍的来源场次

当天 MiMo 的 4 份设计里 2 份是同一形状：片段末尾的过渡拍已经开始演下一场（生产那次是 S3 第一句「抬眼望向门缝漏下的那道斜斜光柱」，回放那次是 S5 开头「把钉好扣子的旧蓝布衫递给老人」），beat 如实标了「本场 + 下一场」，片段自身的 `sourceSceneIds` 却只写本场。校验拦得对，不是误判。正解不唯一——给片段补上下一场，或把下一场从 beat 去掉——所以不能自动修。目前只靠带诊断重试救回；若它继续高频出现，要考虑在提示词里写明「beat 跨场时片段的 sourceSceneIds 也要包含那一场」，那是提示词改动，需要另行决定。
