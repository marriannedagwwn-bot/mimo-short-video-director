# 落地第 2 步：定向修订阶段

**状态：已实施（2026-09-06）。** 第 1 步（评审阶段）已提交（`17d6a9c`），本步已按本文件落地，完成记录见文末。

本文件是自包含的——执行时不需要参考任何会话记录，所有实测依据、提示词正文与陷阱都写在里面。

---

## Context

评审阶段已经能产出结构化报告（`dominantDefect` / `issues` / `upgradePath` / `revisionBrief`）。
现在要做的是：**让模型按报告只改被点名的那几个镜头**，改完先给用户看，确认后才签发。

### 已经在仓库里的资产

| 东西 | 位置 | 状态 |
|---|---|---|
| 修订结果校验器 `ensureRevisionContract` | `src/animation-plan-review-validation.js` | ✅ 已写好并测过 |
| 评审阶段（产出报告） | `src/workflow.js` `createAnimationPlanReview` | ✅ 已完成 |
| 评审报告 schema | `src/contracts/schemas/animation-plan-review-strict.schema.json` | ✅ |
| 修订相关测试 | `test/animation-plan-review.test.js` | ✅ 已有 12 个，含修订校验 3 个 |

`ensureRevisionContract(revision, animationPlan, report)` 已经管住三件事：

1. **净预算**：被终审判为 `pacing` / `ai_risk` 的镜头，`removedActions.length >= addedActions.length`
2. **签发字段不可动**：修订输出里出现 `shotId` / `sourceSceneId` / `sceneId` /
   `durationSeconds` / `storyPurpose` / `emotionalTarget` 即拒绝
3. **六个可写字段齐全**（原镜头无台词时不强制 `dialogueOrSubtitle`）

抛 `ReviewContractError`，带 `details`（`{code, path, reason}`），**这正是重试要用的结构化诊断**。

---

## 最重要的一条实测结论：修订必须允许第一次做错

这是整个第 2 步的设计前提，不理解它就会把流程做错。

**事前用提示词约束「不许往挤的镜头加动作」，三次加码全部无效：**

| 加码 | 结果 |
|---|---|
| 写「注意不要太满」 | 模型照加 |
| 改成「不允许净增加」 | 照加，还在摘要里写「本镜只替换未净增」 |
| 补一句「不要自称只替换而实际增加」 | 换个说法：「这四个是细节，均并入原有动作链，不增加独立动作段」 |

根本原因：**「一个动作」没有客观定义**，判定权在模型手里就永远有解释空间。

**解法是把判定权拿走**——要求输出显式台账 `removedActions[]` / `addedActions[]`，
服务端只数数组长度。效果立竿见影：同一份输入，两个模型都如实报了数
（qwen3.8 写「删 2 加 7」，kimi-k3 写「删 2 加 4」），全被拦下。

**然后带着诊断让它重改一次，两个模型都一次就过：**

```
第一次：删 2 加 7  ✗ 被拦
诊断：「你新增 7 个动作但只删除 2 个，受约束镜头必须删≥加」
重试：删 1 加 1  ✓ 通过
```

重试后的结果**反而更好**：第一次它加 7 个动作把镜头塞满，重试后只留下终审真正要求的
那一个，其余为了丰富细节而加的全放弃了。

**结论**：
- 事前的抽象规矩，模型能解释绕过
- 事后的算术诊断，模型无从辩解
- 所以**第一次被拦是常规路径，不是异常路径**，重试要按主流程设计，不能当边缘情况

---

## 实施

### 1. 修订提示词 —— 存成资源文件

与评审同一模式：`src/animation-plan-revision-prompt.md`，由 `src/prompts.js` 读取
（`fs.readFileSync(new URL(...), "utf8")`，剥掉开头的 HTML 注释头）。

**不要硬写进模板字面量**——评审那次因为正文含大量反引号和双引号，硬写导致 `prompts.js`
损坏过一次，最后是 `git checkout` 恢复的。

正文（已在 scratchpad 验证有效，逐字保留）：

```
你是分镜修订员。对下面这些镜头做**最小范围的定向修改**，解决终审报告点名的问题。

# 铁律

1. **不重编故事**：主题、角色身份、地点、镜头数量、每镜 durationSeconds 一律不变。
2. **先替换，再新增——用显式台账，不用文字描述。**
   每一镜都必须列出两个数组：
   - removedActions：你从这一镜删掉或合并掉的旧动作，一个动作一条
   - addedActions：你新加进这一镜的动作，一个动作一条
   没有改动就写空数组。**服务端只数这两个数组的长度**：被净预算标为受限的镜头，
   removedActions 的长度必须大于或等于 addedActions 的长度，不满足直接打回。
   所以不要在 changeSummary 里辩解「这些新动作并入了原有动作链所以不算净增」——
   判定不看那句话，只看数组长度。把并入现有动作的新细节也如实计入 addedActions。
3. **动作的执行者不得改变**。建议里写「甲替乙做某事」，你就必须写成甲替乙，
   不能因为上下文里乙的动作更连贯就调换主语。这是最容易出错的地方。
4. **同步四个字段**：改 videoPrompt 就必须同步改 characterAction、continuityNotes、
   acceptanceCriteria、以及 cameraMotion 里对应的分段描述，否则方案内部会自相矛盾。
5. **台词可以改写和缩短**（若建议里要求），但改写后的新台词必须**逐字**出现在 videoPrompt
   里——视频模型直接生成人声，只写「她说话」而不写说了什么，那句台词就不会被说出来。
6. videoPrompt 是自包含的中文完整提示词，逐拍写明该拍出现的角色，角色须完整入画。
   保持原有的风格描述与角色外观锁定逐字不变。
```

正文之后由代码拼接四段动态内容：**本次各镜的净预算** → **必须保住的**（来自
`report.revisionBrief.mustPreserve`）→ **要解决的问题**（选中的 issues）→
**要落实的升级建议**（选中的 upgrades）→ **当前镜头**（只发被点名的那几条）。

结尾固定：`只输出 JSON，不要解释、不要 Markdown 围栏。字符串内部不得出现半角双引号，引用用「」。`
以及输出格式：

```
{"revisedShots":[{"shotId":"","videoPrompt":"","cameraMotion":"","characterAction":"",
"dialogueOrSubtitle":"","soundDesign":"","continuityNotes":"","acceptanceCriteria":[],
"removedActions":[],"addedActions":[],"changeSummary":""}]}
```

### 2. 净预算的计算（服务端做，不能让模型自己判断）

按 `shotId` 把 issues 与 upgrades 分组，判断每一镜是「只准减」「可加」还是「⚠只准替换」：

```js
const load = {};
for (const i of issues) for (const id of idsFrom(i)) {
  (load[id] ??= { dec: [], inc: [] })[/pacing|ai_risk/.test(i.category) ? "dec" : "inc"].push(i.issueId);
}
for (const u of upgrades) for (const id of idsFrom(u)) (load[id] ??= { dec: [], inc: [] }).inc.push(u.upgradeId);
```

每镜输出一行，形如：

```
- A05（15秒，当前 5 个动作段，提示词 737 字）：⚠ 本镜同时被要求减负(ISSUE-004)与加内容(UPG-005)——只准替换，不准净增
- A01（12秒，当前 5 个动作段，提示词 538 字）：只准减，不准加
- A04（9秒，当前 3 个动作段，提示词 577 字）：可加，但先确认没有 pacing 问题
```

**这个冲突检测必须有。** 上一轮事故就是：同一镜同时收到「这镜太挤」与三条「往这镜加动作」，
模型只执行了「加」，结果 `pacing` 6.2、`aiStability` 5.8、`physicalFeasibility` 6.9 三项同时退化。

`idsFrom` 要兼容两种路径写法——新报告用 `shotPlan[A03]`，但已签发的旧报告用 0-based
下标 `shotPlan[2]`：

```js
const byId = /shotPlan\[(A\d+)\]/.exec(p);       // 优先
const byIdx = /shotPlan\[(\d+)\]/.exec(p);        // 回退：shotPlan[Number(...)].shotId
// 另外 problem 正文里点名的 A\d{2} 也要计入
```

### 3. 重试流程 —— 主流程的一部分

```
第一次修订 → ensureRevisionContract
   ├─ 通过 → 进入预览
   └─ 被拦 → 带诊断重试一次（只重做被点名的镜头，其余沿用上次输出）
              ├─ 通过 → 进入预览
              └─ 再被拦 → fail closed，保留原 Plan 不动，把两次诊断都如实报出
```

**预算：最多两次 provider 调用**，与 CLAUDE.md 第三节局部纠错的纪律一致（有界、失败即
fail closed、不整包重写）。

重试提示词正文（同样已验证有效）：

```
你上一次的分镜修订被服务端的确定性校验拦下了。本次只修正被点名的镜头。

# 拦截原因（服务端数出来的，不是主观判断）
（此处拼接 error.details 里每条的 reason）

# 规则

受终审判为节奏或稳定性有风险的镜头，必须满足：
**removedActions 的条目数 >= addedActions 的条目数。**

这是纯算术，服务端只数长度。你有两条路：
1. 再从该镜的原有动作里删掉足够多的低价值动作，把 removedActions 补齐；
2. 或者放弃部分新增动作，把 addedActions 减到不超过 removedActions。

**优先保留终审明确要求的那个新增动作，其余为了丰富细节而加的一律放弃。**
不要把新增动作改写成更长的句子来掩盖数量——服务端数的是数组条目数，不是字数。

removedActions 只能列**原镜头里真实存在**的动作，不能编造一个不存在的动作来凑数。
```

之后拼接：**被拦镜头的原始 characterAction**（删除动作必须从这里选）+ **你上一次的输出**。

**只重做被点名的镜头**：从 `details[].path`（形如 `/revisedShots/1`）和 `reason` 里的
`A\d{2}` 解析出 shotId，其余镜头沿用第一次的输出直接合并。省 token，也避免动到已通过的部分。

### 4. Stage 与端点

- `src/workflow.js` 新增 `createAnimationPlanRevision(input)`，输入 `{ animationPlan, report }`
  ——**不要传 fullStory**。评审需要剧情作对照，修订不需要：问题已经定位，再给剧情只会
  让模型顺手重编故事。
- `server.js` 加 `"/api/animation-plan-revision"` 路由 + `buildStageDefaults` 里登记
  `animationPlanRevision`，**timeout 同样设 1800000**（实测修订耗时 233–775 秒）。
- `stageLabel` 加 `animationPlanRevision: "分镜修订"`。
- mock：`mockAnimationPlanRevision`，按传入 Plan 与报告生成合法的 `revisedShots`，
  必须能通过与 live 相同的 `ensureRevisionContract`。

### 5. 前端：先预览，确认后才签发

**这是已定的范围决定，不要改成自动写回。**

修订返回后**不自动写进 Plan**，先并排展示原文与修订版（每镜的 `videoPrompt` /
`characterAction` 前后对照 + `removedActions` / `addedActions` 台账 + `changeSummary`），
下面两个按钮：

- **采纳并签发** → 走现有的 Plan revision 签发流程，签发新 revision 与新 media namespace，
  递归 stale 该变体已生成的全部媒体
- **放弃** → 什么都不做

这样把「作废全部已生成媒体」这个重代价推迟到用户确认那一刻。实测修订第一次输出常常要被
打回，自动签发会造成大量无谓的 revision 与媒体作废。

---

## 已知陷阱（都是实测踩过的）

**① 执行者反转。** 建议写「甲替乙做某事」，模型可能写成「乙替甲」——因为插入位置紧邻另一个
主语的动作链，它会为了句子连贯而调换主语。实测发生过一次：升级建议要求「长辈替主角别碎发」
（让配角主动照顾主角一次），模型写成「主角替长辈别碎发」，方向一反这条建议就作废了。
铁律第 3 条就是为此加的，但**没有确定性兜底**——要靠人工在预览时看。

**② 改了 videoPrompt 却漏改 cameraMotion。** 我自己修正执行者时就漏过这个字段，
导致运镜描述里还留着旧的执行者。铁律第 4 条明确列了四个字段，实施时校验器可以考虑
加一条：`videoPrompt` 变了而 `cameraMotion` 逐字未变时给出警告（不是硬失败——
有些改动确实不影响运镜）。

**③ 未受约束的镜头仍可能净增。** `ensureRevisionContract` 只约束被判过 `pacing`/`ai_risk`
的镜头。实测一次修订里 A03/A07/A08 各净增 1 个动作段而校验通过——按现有规则是正确行为，
但要知道这个口子存在。是否收紧为全局默认「先替换后新增」是一个未决的取舍。

**④ 传输不稳定。** 修订调用实测 233–775 秒，失败率与评审相当（约三分之一）。
失败形态：`fetch failed`（3–5 秒，没烧 token）、`terminated`（几百秒才断，token 已烧）。
`MODEL_STREAM_ABORTED` 已经会带出残片规模，日志能区分「刚开始就断」与「快写完才断」。
**换模型兜底实测有效**：一份输入 qwen3.8 三次全败、kimi-k3 一次通过。

---

## 验证

1. `npm test`（Node 24）。已知失败与本项无关：3 个 Windows 权限位断言、
   1 个 `build identity` 读 HEAD、1–2 个 durable-task 时序 flaky。
2. 新增测试：mock 修订能过 `ensureRevisionContract`；受约束镜头净增被拦；
   重试合并逻辑（被拦镜头替换、其余沿用）；两次都被拦时 fail closed 且不改动原 Plan。
3. `npm run dev`（带 `--use-env-proxy`，不要删）端到端跑一次：
   先评审拿到报告，再修订，**故意构造一个净增的输入**验证拦截与重试真的会发生。
4. 预览界面：确认「采纳」之前 Plan 与媒体**完全没有变化**——这是本步最重要的一条，
   可以用 `git status` 之外的方式验证：签发前后对比 `runtime/production-runs` 下的
   manifest 与 media namespace。

## 明确不做

- 不自动写回 Plan（必须先预览）
- 不让修订看到 `fullStory`
- 不做第三次重试（两次 provider 调用是上限）
- 不动全局 timeout 默认值
- 不给评分设放行门槛

---

## 完成记录（2026-09-06）

按本文件实施完毕。计划与落地的差异、以及实施中发现的既有缺陷都记在这里。

### 落地清单

| 计划条目 | 落点 |
|---|---|
| 修订提示词存成资源文件 | `src/animation-plan-revision-prompt.md`、`src/animation-plan-revision-repair-prompt.md` |
| 净预算计算 | `revisionShotLoad()` / `revisionTargetShotIds()`（`src/animation-plan-review-validation.js`） |
| 重试流程（2 次预算） | `WorkflowService.createAnimationPlanRevision`，走 `modelCallCoordinator.runJson` |
| Stage 与端点 | `POST /api/animation-plan-revision`、`buildStageDefaults.animationPlanRevision`（timeout 1800000）、`stageLabel` |
| mock | `mockAnimationPlanRevision`（逐字回显，不伪造改动） |
| 先预览后签发 | `runAnimationPlanRevision` / `adoptAnimationPlanRevision`（`public/app.js`） |
| 测试 | `test/animation-plan-revision.test.js`，20 条 |

### 与计划不同的四处（都有理由）

**① 净预算判定做成两个消费者共用的一份函数。** 计划里提示词那段 `load` 与校验器里的 `constrained`
是两处独立代码。两边各算一次必然漂移，结果就是模型被要求做 A、却按 B 被拒。
现在 `ensureRevisionContract` 的硬闸门与提示词的每镜预算行都读 `revisionShotLoad()` 的同一个结果。

**② `problem` 正文里的镜头号只作回退，不无条件计入。** 计划写「另外 problem 正文里点名的 A\d{2}
也要计入」，但那会把「A05 相比之下节奏正常」这种对照提及误判成受影响镜头。
schema 允许 `affectedPaths` / `evidencePaths` 为空，此时条目**彻底无法归属**——
回退只在这种否则就完全丢失的情况下生效。

**③ 服务端返回合并后的整份 Plan，不只是 `revisedShots`。** 否则「采纳」时要么在浏览器里重写一遍合并与
校验（第二份判定），要么签发一份从未通过 `ensureAnimationPlanDirectShotContract` 的 Plan。
现在合并与复验都在服务端做完，浏览器拿到的候选 Plan 已经通过成片渲染前的确定性闸门
（尤其是台词必须逐字出现在 `videoPrompt`、关闭背景音乐时的收尾句）。

**④ 多加了一条越界闸门。** 模型返回本次未授权的镜头时抛 `REVISION_SHOT_OUT_OF_SCOPE`。
计划没写这条，但「只改被点名的镜头」是这个阶段的定义，多改就是越权写入未经评审的镜头。

### 实施中发现的既有缺陷（本次一并修掉）

**按阶段配置的 `requestTimeoutMs` 从来没有生效过。** `resolveStage` 一直解析它，三家 client 的
`generateJson` 也一直接收它，但 `generateStageJson` → `generateValidatedJson` 之间**没有传**。
于是第 1 步给终审配的 `1800000` 完全是死配置，该阶段仍按全局 900000 被掐——
而终审实测正常出字最长 941 秒，正落在被掐的区间里，`17d6a9c` 提交信息里描述的那次失败其实没有被修复。
现已接通。其余阶段该值为 `null`，传 `null` 与不传逐字等价，行为不变；全局默认值未动。

**入站 `report` 校验失败原本会变成 500。** `ReviewContractError` 不在 `serializeServerError` 的分支表里。
终审阶段的 report 是模型输出（502 合理），但修订阶段的 report 是**请求输入**——
原样上抛会让用户看到「服务器内部错误」，完全不知道是自己传了不匹配的报告。
现转成 `InputError`（400）并带上校验器数出来的具体不一致。
`animationPlan` 入参仍与终审端点保持一致的 502 行为，不在本步改。

### 验证结果

1. `npm test`（`--test-concurrency=1` 串行）：**1051 → 1071 条，新增 20 条全部通过**
   （改动前基线用 `git stash` 在同一台机器上实测：1051 / pass 1047 / fail 4；改动后 pass 1067 / fail 4，
   失败的是**完全相同的那 4 条**）。
   **既有失败与本项无关，改动前后是同一批**：3 条 Windows 文件权限位断言
   （实测 438 = `0o666`，断言期望 `0o600` / `0o700`）、1 条 `build identity` 读 HEAD。
   另有 durable-task 时序 flaky（`waitUntil timeout`）：并发跑出现 2 条，串行跑降到 1 条。
2. **真实生产包 demo 端到端**：8 镜的《雨天的流浪猫窝》+ 真实终审报告（6 issues / 5 upgrades），
   端点正确解析出 7 个目标镜头并返回合并 Plan。
3. **端点错误语义**：旧 v2 Plan → 400；空报告 → 400；真实报告配少一镜的 Plan → 400
   并逐条列出「shotEvaluations 条数 8 与 shotPlan 的 7 不一致」「引用了不存在的镜头 A08」。
4. **本步最重要的一条**（计划第 4 条验证）：对 `runtime/production-runs` 做全目录 SHA-256 快照，
   **调用修订端点前后 192 个文件的哈希一个都没变**；随后在浏览器里点「采纳」，
   才出现且**只**出现 2 处变化——新签发的 `animationPlan-V1-r2.json` 与更新后的 `manifest.json`。
5. **浏览器端到端**：demo 实例导入生产包 → 终审（打桩为真实报告，因为 demo mock 报告没有任何 issue）
   → 修订 → 预览显示前后对照、删/加台账与「第一次被拦，已按诊断重做一次」的提示 → 采纳 → Plan 卡片更新。
   「放弃」不改任何东西。
6. 「不自动写回」这条范围决定已由两条源码不变量测试锁住：`runAnimationPlanRevision` 内不得出现
   `commitProductionArtifact` / `requestProductionArtifact`；修订路由不得触碰 `resolveProductionMediaContext`。

### 仍然没做（与计划的「明确不做」一致）

- **换模型兜底两个阶段都还没有实现**。落地方案第 6 节已决定「评审允许换模型但必须在报告里写明」，
  但第 1 步没做，本步也没做。不要按已实现推断。
- 不自动写回 Plan、不让修订看到 `fullStory`、不做第三次重试、不动全局 timeout 默认值、不给评分设放行门槛。
- 未受约束镜头仍可净增（已知口子，是否收紧为全局默认仍是未决的取舍）。
- 执行者反转没有确定性兜底，只能靠人工在预览时看；界面上已明确写出这一句。

---

## 追加：净预算收紧为全局默认（2026-09-06，落地当天）

### 起因

外部评审读完手工那版 r2 后提出三条。逐条用真实数据核实：

**① A07 手部逻辑仍然错误——属实，且比外部评审说的更乱一层。** r2 的 `characterAction` 原文是
「老奶奶单臂把裹着小猫的外套拢稳……随后用空出的手把深蓝外套抽出披回小白子肩上→……双手递给小白子」，
结尾又是「老奶奶抱猫目送」。不只是「一只手抱猫怎么双手递」：外套裹着猫却被抽出来披给别人，
而猫又回到怀里，中间那个过渡根本没写。**这类问题任何确定性校验器都抓不到**，需要语义判断。

**② 「小失败+小补救」有成为模板的风险——属实，但归因要往上挪一层。**
A02 的 `pacingAndDuration` 是 6.5、ISSUE-05 明确说它过载，修订却又往里加了
「外套滑落→露头→发抖→压住→重新裹紧」。但**开这个方子的是终审自己**：
UP-04 的 `netActionBudget` 原文就写着「A02已过载；用『外套角滑落并用围巾压住重新裹紧』替换
『路人撑伞快步走过画面』的重复强调，不净增动作」。修订模型如实报了数、照做而已。

**③ 建议加 `actionComplexity` 并用维度分数当门槛——不采纳，两个具体理由。**
`pacingAndDuration < 8.0` 用的恰恰是分辨力最差的那个数字（实测两个模型评同一份 Plan 总分只差 0.06，
而**单维能差 ±1.0**），门槛会随模型随机开关，且与 §2.14 已写死的「评分不作放行门槛」冲突。
`actionComplexity` 则把判定权还给模型——净预算的全部出发点就是把它拿走（事前三次加码全失败，
因为「一个动作」没有客观定义）；加一个模型自评的复杂度字段，它会说「这是一个连贯动作，复杂度 1」，
和当初「均并入原有动作链，不增加独立动作段」是同一句话换个壳。

### 实测：旧规则在真实数据上等于没有闸门

拿那份真实修订输出回放刚落地的 `ensureRevisionContract`：

```
A02: 受约束=true  删1 加1 → 1>=1 通过
A03: 受约束=false 删0 加1 → 净增，不检查
A07: 受约束=false 删3 加4 → 净增，不检查
A08: 受约束=false 删0 加1 → 净增，不检查
结果：整份通过，一条都没拦
```

**「只在没被要求加内容时才约束」这个折中同样无效**：A03/A07/A08 的报告条目恰恰**全是** `increase`
（终审要求往里加内容），按那种写法仍然一个都拦不住。所以只有无例外的全局默认才有作用。

### 改动

`ensureRevisionContract` 的净预算判定去掉 `constrained.has(id) &&`，对**每一个被修订的镜头**
要求 `removed >= added`。`constrained` 保留，但只用于提示词的措辞分档与错误消息归因，不再是闸门开关。

判定只有一份，所以三处表述同步改成同一口径：`revisionShotBudgetLine()` 里「可加，但先确认没有 pacing 问题」
改成「要落实新增，但仍须先替换后新增」；`animation-plan-revision-prompt.md` 铁律第 2 条与
`animation-plan-revision-repair-prompt.md` 的规则段都改成「每一镜」。

回放验证：同一份真实输出现在被拦，诊断精确指向 A03、A07、A08 三处，A02 仍按 1:1 通过。
测试 `真实修订输出回放：三处净增全部被拦` 把这个结论钉住（夹具不在时跳过）。

### 代价与仍未解决的

**代价**：终审要求往某镜加内容时，模型必须先从该镜腾出位置。提示词本来就写着
「优先保留终审明确要求的那个新增动作，其余为了丰富细节而加的一律放弃」，而且第一次被拦是常规路径、
有一次带诊断的重试——实测重试后的结果反而更好。但这条**没有实测样本**，是本次改动最大的未知。

**仍未解决**：A02 那类「删一条轻的、加一条重的」仍然通过。数条目数管不了复杂度。
可选方向（都未实施）：再数一层 `addedActions` / `removedActions` 的总字数（纯算术，但提示词里
「数的是条目数不是字数」那句要反过来写，且只是抬高门槛不是堵死）；或在终审端约束 `netActionBudget`
不得开出「新增动作链」的方子（仍是提示词约束，没有兜底）。

**A07 那类语义矛盾仍然无解**：确定性校验器抓不到「单臂抱猫却双手递」。外部评审建议的
「修订后二次验收」（采纳前把合并结果重新送一次终审）是对的方向，但那是计划之外的新功能，
每次修订要多一次 900+ 秒的模型调用，本次未做。
