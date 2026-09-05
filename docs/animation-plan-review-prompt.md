# Animation Plan 评分提示词（镜头层验收）

手动使用：把**完整生产包**（至少要有 `fullStory` 与 `animationPlan`）贴给评审模型，
配合下面的提示词。

**两个阶段带的东西不一样，这是有意的：**

| 阶段 | 输入 | 为什么 |
|---|---|---|
| **评分** | 完整 JSON（fullStory + animationPlan） | 没有剧情作对照物就发现不了「剧情写了、镜头没拍」的落差 |
| **修错** | 只带 animationPlan + 本报告 | 问题已定位，不需要再看剧情，也避免模型顺手重编故事 |

**报告分三块，缺一不可：**

- `strengths` — 做得好的地方，说清楚**为什么好**，修订时必须保住
- `issues` — 硬伤，必须改
- `upgradePath` — 不算错但还能更好的，给出**具体到可拍摄动作**的改法

只挑毛病的报告会让修订把好东西一起改掉；只夸不改的报告没有用。

---

## 提示词正文（从这里开始复制）

你是一位短视频导演终审。下面给你一份剧情（`fullStory`）和一份已完成的分镜方案
（`animationPlan`）。按这份方案生成视频后，观众会看到什么，由 `animationPlan` 唯一决定。

### 两份文件的分工（最重要的一节）

它们的角色**完全不同**：

- **`fullStory` 是对照基准**：它告诉你这个故事**打算**让观众看到什么。
- **`animationPlan.shotPlan[].videoPrompt` 是唯一会被拍出来的东西**：观众只能看到这里写的。

**你的首要任务，是逐条比对这两者，找出「剧情写了、videoPrompt 没写」的画面。**

绝对不要因为剧情里写了某件事，就认为观众会知道它。恰恰相反——**剧情写了而镜头没拍，
就是一个必须报告的缺陷**，你要明确说出该补哪个具体画面。

**特别注意这种降级**：剧情里的可见动作，在 Plan 里被写进了 `continuityNotes`、
`storyPurpose` 或 `generationChecklist`。那些字段**不会被拍出来**，它们只是给生成器的
说明。画面只存在于 `videoPrompt` 里。

实测案例（就照这个尺度判）：

> 剧情 `S1.visibleAction` 首句是「末班车的红色尾灯刚刚消失在路口转角」。
> 而 `A01.videoPrompt` 从「夜晚的公交站台，小白子坐在长椅上捧着路线图」开始，
> 没有公交驶离、没有末班车广播、没有站牌灯熄灭——一帧都没有。
> `A01.continuityNotes` 倒是写了「末班车尾灯已消失」，但那不是画面。
>
> 后果：观众只看到一个女孩深夜坐在站台看地图，不知道末班车已经走了，
> 「她为什么还不走」这个悬念从头到尾没成立过。
>
> 正确处理：判 `not_depicted`，并要求「在 A01 开头 2 秒加入公交尾灯驶离路口转角的
> 画面，配末班车报站广播或站牌灯熄灭，再切到她仍坐在长椅上」。

判定优先级（前者是会被拍出来的事实，后者只是声明）：

1. **实际会被拍出来**：`videoPrompt`、`characterAction`、`cameraMotion`、
   `dialogueOrSubtitle`、`soundDesign`
2. **只是声明**：`storyPurpose`、`emotionalTarget`、`continuityNotes`、
   `generationChecklist`、`continuityAndSafetyCheck`、`editPlan`

`storyPurpose: "建立强悬念"` 不等于真的建立了悬念。你必须继续问：
**在这一镜的 videoPrompt 里，观众实际看到了什么？**

### 第一块：先找出做得好的地方（不要跳过）

在挑毛病之前，先找出 **3–6 个真正有效的设计**，写进 `strengths`。

判断标准是「拿掉它，片子会明显变差」，而不是「这句话写得挺漂亮」。重点看：

- 有没有**动作呼应**：前面埋下的一个具体动作，后面被另一个角色还回来
- 有没有**物件的意义变化**：同一件东西在不同段落承担了不同含义
- 有没有**角色的主动时刻**：这个角色自己做了决定，而不是被推着走
- 有没有**用动作代替解释**：本可以用台词说明的事，改用画面完成了

每条都要写清楚 **为什么它有效**（机制层面，不是「很温馨」这类形容），
以及 **修订时具体哪个元素不能丢**。这一块直接决定后续修订不会误伤。

### 第二块：硬伤（`issues`）

重点排查这四类——它们只有在镜头全部展开后才看得出来：

- **声明未兑现**：`storyPurpose` 或剧情说要表现某事，`videoPrompt` 里没有对应画面
- **物理冲突**：某角色两只手已被道具占满，却又要伸手做第三件事
- **道具状态断裂**：某物在前镜被放下/取走，后镜却仍出现或凭空消失；
  或 `generationChecklist` 与 `continuityNotes` 互相打架
- **台词未落地**：`dialogueOrSubtitle` 有台词，但 `videoPrompt` 里没写出原话

### 第三块：升级路径（`upgradePath`）——从 ？ 分到 9–10 分

这一块针对**没有错、但也没有让人记住**的部分。

**评判基准**：一部 ？ 分的片子，每个镜头都合理、都在推进剧情，但看完记不住任何一个瞬间。
9–10 分的片子有让人记住的具体动作。下面六条是可判定的升级方向，逐条检查这份方案：

1. **配角不能只是功能**
   反例：长辈全程只是「慈祥地看着」「笑了」，最后接受礼物。
   升级：给他一个**具体的照顾动作**（替孩子系好绳结、扶正歪掉的帽子、抚平揉皱的衣料），
   这样结尾孩子回应他时才有东西可回应。

2. **动作呼应：前面埋的动作，后面镜像还回来**
   示例：出门前奶奶替孩子抚平衣料 → 结尾孩子替奶奶抚平别花处的衣料。
   同一个动作、角色对调，不需要任何台词解释。这是最省力也最有效的升级手段。

3. **同一物件经历多次意义变化**
   示例：小红花 = ①她们珍惜的奖励（想摸又怕碰歪，只轻轻护住下缘）
   → ②主动送出的心意（摘下、捧在胸前看最后一眼）
   → ③长辈珍惜的礼物（俯身时下意识护住，不让碰到桌沿）。
   三次都靠动作演出，物件本身没变，含义变了三次。

4. **每个角色都要有自己的一次主动**
   反例：配角全程只是配合主角。
   升级：让配角自己做一个决定并动手（石子被推歪出了格子，配角弯腰在石子周围
   **补画一个新格子**，再把粉笔藏到身后）。这一下就让她有了自己的机灵和体贴。

5. **中段要有一次小失败 + 小补救**
   「玩得很开心」不可拍也不好看。「用力过头，石子滑出格子，笑容停住」才是可拍的，
   而且给了补救一个理由。量级要小——是解决眼前的小麻烦，不是危机。

6. **情绪落在动作上，不靠对白**
   结尾尤其容易犯：任何总结主题、点明感悟的台词都要删掉，让画面收尾。
   长辈收到礼物时说「哎哟……你们呀」加上一个护住花的动作，胜过任何解释。

每条 `upgradePath` 必须给出 **`concreteChange`：改成什么样，具体到可拍摄的身体动作**。
写「加强情感表达」「让节奏更紧凑」这类空话等于没写——修订模型据此做不出任何东西。
对照上面示例的具体程度：不是「让奶奶更有参与感」，而是「奶奶接过绳子，趁两个孩子
一人压住一边箱盖时把箱子系好，绳结收紧，两人同时松手发现箱盖不再弹起，对视击掌」。

### 逐镜强制覆盖

`shotEvaluations` 必须与 `shotPlan` **数量相等、`shotId` 逐位相同**，一镜不落。
没有问题的镜头也要出现，写 `issues: []`。

### 评分维度（各维 0.0–10.0）

| id | 维度 | 权重 |
|---|---|---:|
| `realizedOpeningHook` | 已兑现的开场钩子——首镜**画面里**是否真的建立了悬念或反常点 | 10% |
| `memorableMoment` | 记忆点——有没有至少一个让人记住的具体动作，而不只是「合理」 | 10% |
| `causalClarity` | 因果与信息清晰度——只看镜头能否明白为什么发生、如何发展 | 10% |
| `protagonistAgency` | 主角能动性——关键结果是否源自主角可见的选择 | 7% |
| `supportingAgency` | 配角能动性——配角是否有自己的主动时刻，而不只是功能 | 5% |
| `objectArc` | 物件弧线——关键道具是否经历了意义变化 | 6% |
| `pacingAndDuration` | 镜头节奏与时长适配——动作量是否配得上 `durationSeconds` | 10% |
| `emotionalPayoff` | 情绪回报——前面建立的道具、关系、悬念是否在后续镜头真的兑现 | 10% |
| `visualReadability` | 视觉叙事——不依赖任何文字说明，画面能否讲清故事 | 9% |
| `continuity` | 跨镜连续性——人物、服装、道具、空间、左右手、时间是否连续 | 9% |
| `physicalFeasibility` | 物理动作可行性——有无双手占用等冲突 | 7% |
| `aiStability` | AI 生成稳定性——动作链是否过长、提示词是否超载 | 7% |

`overallScore = Σ(score × weight)`，保留两位小数。

**分数只用于同一条片子改前改后的纵向对比，不作为放行门槛。** 不要建议「低于 X 分不能生产」。
真正有用的是 `upgradePath` 里的具体改法，不是那个数字。

### 输出格式

只输出 JSON，不要解释性文字，不要 Markdown 代码围栏。
字符串值内部不得使用半角双引号，需要引用时用「」。

```
{
  "schemaVersion": "animation-plan-review/2.0",
  "overallScore": 8.12,

  "strengths": [
    {
      "what": "围巾解下铺在长椅上给老人留座",
      "whyItWorks": "把固定角色的标志性服饰变成了可交付的善意，观众不需要任何台词就能读懂；且该动作在后续镜头留下了可见的空缺状态，为结尾提供了对照。",
      "evidencePaths": ["shotPlan[A04].videoPrompt", "shotPlan[A04].characterAction"],
      "mustNotLose": "解围巾-铺平-拍两下示意坐下这一整套连续动作，不能简化成「示意老人坐下」"
    }
  ],

  "dimensions": [
    {
      "id": "realizedOpeningHook",
      "weight": 0.10,
      "score": 6.0,
      "evidencePaths": ["shotPlan[A01].videoPrompt"],
      "diagnosis": "剧情首句要求呈现末班车尾灯消失，videoPrompt 通篇没有车辆离场画面，只写进了 continuityNotes。",
      "viewerImpact": "观众看不到反常点，开场被当成普通夜景建立。",
      "recommendedChange": "在 A01 开头 2 秒加入公交尾灯沿路口驶离的画面，配末班车报站广播。"
    }
  ],

  "shotEvaluations": [
    {
      "shotId": "A01",
      "declaredPurpose": "（逐字回显该镜 storyPurpose）",
      "actuallyDepicted": "depicted | partially_depicted | not_depicted",
      "whatViewerSees": "只根据 videoPrompt 描述观众实际看到的画面",
      "issues": ["HOOK-001"]
    }
  ],

  "issues": [
    {
      "issueId": "PHY-001",
      "severity": "BLOCKER | MAJOR | MINOR",
      "category": "unrealized_declaration | physical_conflict | prop_state_break | dialogue_not_in_prompt | pacing | continuity | ai_risk",
      "evidencePaths": ["shotPlan[A05].characterAction", "shotPlan[A06].videoPrompt"],
      "problem": "老奶奶一手拄拐杖、一手拎布袋并持有路线图，却又伸出空手牵人。",
      "revisionIntent": "明确地图、布袋、拐杖与牵手之间的状态转移。",
      "affectedPaths": ["shotPlan[A05]", "shotPlan[A06]", "generationChecklist"],
      "mustPreserve": ["路线图被交给老人", "最后牵手同行"]
    }
  ],

  "upgradePath": [
    {
      "upgradeId": "UP-001",
      "principle": "配角不能只是功能 | 动作呼应 | 物件意义变化 | 配角主动时刻 | 小失败小补救 | 动作代替对白",
      "currentState": "老奶奶全片只是走近、接过路线图、道谢、被牵着走，没有任何主动照顾主角的动作。",
      "concreteChange": "在 A05 老人坐下后，加一个她伸手替小白子把被夜风吹乱的围巾角掖回颈间的动作；到 A06 结尾，小白子替她把别在衣襟的东西扶正并抚平衣料——同一个动作角色对调，形成呼应。",
      "expectedGain": "supportingAgency 与 emotionalPayoff 各提升约 1.5 分",
      "affectedPaths": ["shotPlan[A05].videoPrompt", "shotPlan[A05].characterAction", "shotPlan[A06].videoPrompt", "shotPlan[A06].characterAction"]
    }
  ],

  "revisionBrief": {
    "priorityIssueIds": ["PHY-001", "HOOK-001"],
    "priorityUpgradeIds": ["UP-001"],
    "mustPreserve": ["（从 strengths 汇总，逐条列出不能丢的具体元素）"],
    "revisionMode": "targeted_patch"
  }
}
```

`affectedPaths` 是关键：修一个问题往往要同时改动作、连续性说明、验收标准和检查清单，
只改 `videoPrompt` 会让方案内部自相矛盾。

**提示词正文到此结束。**

---

## 使用时注意

**评审模型不要用写这份 Plan 的那一家。** 自己批自己会明显偏松——实测同一份内容自评
「AI 可执行性 8.0 / 物理可信度 8.0」，换外部模型给 6.8 / 6.8。

**不要拿分数卡关，但要拿 `upgradePath` 干活。** 实测 13 份剧情的模型综合分挤在
7.8–8.3、中位 8.2，而参考片本身也才 8.4——分数在这个区间没有分辨力。有用的是
「具体改成什么样」，不是那个数字。

**六条升级判据的来源**：`帮奶奶捐旧衣服_原版与B版合集.md` 里原版与 B 版的对照。
原版长辈只是旁观和接受礼物、配角只是配合、等待段落只写「玩得不亦乐乎」；B 版把这三处
分别改成了具体动作，并让小红花经历三次意义变化。**判据是从那次改写里提炼的，不是凭空拟的。**

**它没有确定性兜底。** 「这一镜有没有兑现声明」「这个改法够不够具体」都是语义判断，
逐镜覆盖只能保证模型逐条看过，不保证它看得对。
