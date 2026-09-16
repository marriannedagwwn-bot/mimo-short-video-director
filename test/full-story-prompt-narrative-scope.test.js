import test from "node:test";
import assert from "node:assert/strict";
import { analysisPrompt, fullStoryPrompt, reconstructionPrompt } from "../src/prompts.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

// 一个真的没有被照料对象、没有帮助者、没有信物、没有仪式收尾的候选。
// Full Story 阶段不得把这四样补回来——否则候选阶段的放开只是把模板推迟一个阶段。
const leanVariant = Object.freeze({
  id: "V2",
  title: "自己修好的那盏灯",
  characterSetup: { protagonist: "小白子，q版狼耳少女，村里的热心帮手" },
  newTask: "在天黑前弄清楚灯为什么一直跳闸",
  environmentPressure: "山雾上来，备用灯芯已经用完"
});

function prompt(variant = leanVariant) {
  return fullStoryPrompt({
    creatorProfile,
    creativeBrief: {},
    visualGuardrails: {},
    referenceAnalysis: {},
    sourceScriptReconstruction: {},
    variant
  });
}

test("承接范围只认候选正文，投影和摘要不能另造动作", () => {
  const text = prompt();
  assert.match(text, /当前候选 storyOutline\[\]\.action 是已选剧情的权威/u);
  assert.match(text, /必须保留原动作、参与者、物件用途、关键办法和结果承诺/u);
  assert.match(text, /不得只写在梗概或 dramaticFunction 里/u);
});

test("缺失的可选构件不在 FullStory 补齐", () => {
  const text = prompt();
  assert.match(text, /候选缺少的 careRecipient、helper、emotionalMedium、endingRitual 不得为了填表补回来/u);
  assert.match(text, /不能用额外打招呼、帮忙或受夸奖挤掉原有互动/u);
  assert.doesNotMatch(text, /送达任务、旅途结构.*必须忠实承接/u);
});

test("未登记 careRecipient 时省略该键，helpers 允许为空", () => {
  const text = prompt();
  assert.match(text, /本次 characterBible 只输出 protagonist 和 helpers/u);
  assert.match(text, /不存在时整个键省略，不要输出空对象或占位文本/u);
  assert.match(text, /没有帮助者时 helpers 为 \[\]/u);
  assert.doesNotMatch(text, /^\s*\/\//mu);
});

test("对白允许交流，禁止复述画面与播报内心", () => {
  const text = prompt();
  assert.match(text, /可以提问、邀请、打趣、抗议、回应和安慰/u);
  assert.match(text, /避免把同场看得见的动作逐句再念一遍/u);
  assert.match(text, /不靠旁白直接播报内心/u);
  assert.match(text, /约束必须在实际对白中遵守/u);
});

test("放开可选构件不影响固定角色锁定与既有场次契约", () => {
  const text = prompt();
  assert.match(text, /固定角色的姓名、身份、性格和外观只沿用已签发的全局角色边界/u);
  assert.match(text, /characters 只写本场实际出镜的角色/u);
  assert.match(text, /但整片至少要有一个场次的 characters 非空/u);
  assert.match(text, /location 只写这一场实际发生的可拍摄物理地点/u);
});

test("候选写了这些构件时，承接要求照常生效", () => {
  const text = prompt({
    ...leanVariant,
    characterSetup: { protagonist: leanVariant.characterSetup.protagonist, careRecipient: "铃木奶奶" },
    emotionalMedium: "一张褪色便签",
    endingRitual: "把灯放回原位再关掉手电"
  });
  assert.match(text, /铃木奶奶/u);
  assert.match(text, /一张褪色便签/u);
  assert.match(text, /必须保留原动作、参与者、物件用途、关键办法和结果承诺/u);
});

// targetDurationSeconds 由服务端从 sceneScript 时间轴派生。
// 实测 65 份历史 Full Story 中 24 份（37%）自相矛盾，最大偏差 +50 秒：
// 声明 60 秒却排出 106 秒的场次，页面照声明值显示「60 秒」，
// 而下游按时间轴派生出 10 个镜头的 106 秒成片，按镜头计费。
test("Full Story 提示词写明时长由时间轴决定且会被服务端覆盖", () => {
  const text = prompt();
  assert.match(text, /总时长由 sceneScript 各场 timeRange 的跨度之和决定/u);
  assert.match(text, /合计必须落在 45-90 秒内/u);
  assert.match(text, /服务端会据此覆盖 targetDurationSeconds/u);
});

// full_story/1.1：生成责任以当前选中候选为界，旧合同由兼容测试保留。
test("场数服从动作链，取消强制六场与第二份 beatSheet", () => {
  const text = prompt();
  assert.match(text, /sceneScript 是唯一完整动作稿/u);
  assert.match(text, /至少一场，不设六场或其它固定下限/u);
  assert.match(text, /不要求与候选拍数或 estimatedSeconds 逐位一致/u);
  assert.doesNotMatch(text, /必须把它展开到至少 6 拍/u);
  const template = text.slice(text.indexOf('输出 fullStory，严格使用以下结构'));
  assert.doesNotMatch(template, /"beatSheet"\s*:/u);
});

// 实测成片的三个对白缺陷，全部来自同一份 Full Story：
//   1. S4 的 visibleAction 已写「从衣柜里拿出厚外套和手电筒」，台词又念一遍
//      「穿上厚外套，带上手电筒」——而它自己声明的第一条禁忌就是「复述画面已有信息」
//   2. S6 用「下次流星雨，我们还一起来」把主题念给观众
//   3. 参考片 dialogueStyle.informationDensity 是「低」（对白只承担关系，末场无台词），
//      成片却让配角用三句台词分别扛起冲突、转折与主题
test("对白由动作或前一句触发，不设统一配额且禁止主题总结", () => {
  const text = prompt();
  assert.match(text, /对话由前一个动作或对方的话触发，要有反应和回应/u);
  assert.match(text, /不以统一句数或字数决定是否自然/u);
  assert.match(text, /不得让角色说出故事主题、意义或总结/u);
  assert.match(text, /不要把动作叙事误写成全片沉默/u);
});

test("原片对白与候选台词草案不进入展开，用户对白规则仍在", () => {
  const text = fullStoryPrompt({
    creatorProfile: { ...creatorProfile, constraints: "USER_DIALOGUE_RULE" },
    creativeBrief: {}, visualGuardrails: { dialogueRules: [{ text: "USER_DIALOGUE_RULE", triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "USER_DIALOGUE_RULE" }] }] },
    referenceAnalysis: { dialogueStyle: { tone: "SOURCE_DIALOGUE_TONE", informationDensity: "SOURCE_DENSITY" } },
    sourceScriptReconstruction: { scenes: [{ dialogueGist: "SOURCE_DIALOGUE_LINE" }] },
    variant: { ...leanVariant, keyDialogueDirections: ["CANDIDATE_DIALOGUE_DIRECTION"] }
  });
  assert.doesNotMatch(text, /SOURCE_DIALOGUE_TONE|SOURCE_DENSITY|SOURCE_DIALOGUE_LINE|CANDIDATE_DIALOGUE_DIRECTION/u);
  assert.match(text, /USER_DIALOGUE_RULE/u);
});

test("参考片没有 dialogueStyle 时不注入空投影", () => {
  const text = prompt();
  assert.doesNotMatch(text, /原片对白风格（必须对齐/u);
});

// 时长目标只进提示词；Artifact 里的 targetDurationSeconds 仍由服务端从
// sceneScript 时间轴派生（deriveFullStoryTargetDuration），模型没打准时
// 页面显示的也是派生出的真实值。
test("传入目标时长时生成对应的目标句与窗口句", () => {
  const at79 = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    referenceAnalysis: {}, sourceScriptReconstruction: {}, variant: leanVariant,
    targetDurationSeconds: 79
  });
  assert.match(at79, /剧情应适合约 79 秒的短视频/u);
  assert.match(at79, /合计必须落在 67-91 秒内，尽量贴近 79 秒/u);

  const at45 = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    referenceAnalysis: {}, sourceScriptReconstruction: {}, variant: leanVariant,
    targetDurationSeconds: 45
  });
  assert.match(at45, /合计必须落在 38-52 秒内/u);
});

// 窗口跟随目标而不是固定 45-90：原片 96 秒时若仍写「必须落在 45-90 秒内」，
// 就与「与原片对齐」自相矛盾。
test("原片超过 90 秒时窗口跟随目标上移，不与对齐设定打架", () => {
  const at96 = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    referenceAnalysis: {}, sourceScriptReconstruction: {}, variant: leanVariant,
    targetDurationSeconds: 96
  });
  assert.match(at96, /合计必须落在 81-111 秒内/u);
  assert.doesNotMatch(at96, /45-90 秒/u);
});

test("不传目标时文案与历史逐字一致，旧调用方行为不变", () => {
  const text = prompt();
  assert.match(text, /剧情应适合 45-90 秒短视频，默认以 60 秒为目标/u);
  assert.match(text, /合计必须落在 45-90 秒内，默认贴近 60 秒/u);
});

// 《画不圆的太阳》与原片《打枣》逐场对照：差距不在写没写氛围
// （shotAndSound 与 retentionPlan 都填得实），而在 visibleAction 的动作类型——
// 原片是「把铁锅扣头上当头盔」「爬着追滚远的枣子」这类大幅度动作，
// 且有一半与主线任务无关（趴桌听收音机、爷爷摇蒲扇）；
// 生成的那份六场全是桌前微表情（皱眉、擦、歪头），视频模型拍不出信息量。
const TEXTURE_ANALYSIS = Object.freeze({
  retentionDrivers: [
    { driver: "萌系角色吸引力", payoff: "看到她戴锅防砸的可爱举动" },
    { driver: "怀旧与治愈氛围", payoff: "打枣、洗枣、听收音机等细节" }
  ],
  observedFacts: [
    { factType: "visible_object", observation: "桌上放着一台老式收音机" },
    { factType: "visible_action", observation: "小女孩把红枣递给爷爷" }
  ],
  shotRhythm: { shotPatterns: ["特写（人物表情）", "中景（互动场景）", "全景（院落环境）"] }
});

test("原片质感素材不覆盖选中候选的道具与动作", () => {
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    sourceScriptReconstruction: {}, variant: leanVariant,
    referenceAnalysis: TEXTURE_ANALYSIS
  });
  assert.equal(text, prompt());
  assert.doesNotMatch(text, /看到她戴锅防砸的可爱举动|桌上放着一台老式收音机|小女孩把红枣递给爷爷/u);
});

test("生活质感来自本片做法，不按幅度或无关细节配额裁决", () => {
  const text = prompt();
  assert.match(text, /萌点和性格来自当前角色在这件事里的做法/u);
  assert.match(text, /允许细小但能看懂的动作/u);
  assert.match(text, /不设置大动作、帮人、生活细节、对白或结尾仪式的配额/u);
  assert.doesNotMatch(text, /微表情不算萌点|至少 2 场的 visibleAction|身体轮廓/u);
});

test("参考片没有质感素材时不注入空投影", () => {
  assert.doesNotMatch(prompt(), /原片的生活质感来源/u);
  const empty = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    sourceScriptReconstruction: {}, variant: leanVariant,
    referenceAnalysis: { retentionDrivers: [], observedFacts: [], shotRhythm: {} }
  });
  assert.doesNotMatch(empty, /原片的生活质感来源/u);
});

// 实测 74 份 Full Story 中有 2 份在 transformationProof 里虚构原片事实，
// 两次是同一个幻觉：上游只写「穿着企鹅装的短发女孩」，它补成「企鹅快递员」
// 并顺带编出「送货任务」——而同一份 creativeBrief 明写着「送达任务【原片没有】」。
test("FullStory 不再生成来源证明，旧字段不进入新输出模板", () => {
  const text = prompt();
  assert.match(text, /来源证明、自评分与原片具体场次不作为本片剧情依据/u);
  const template = text.slice(text.indexOf('输出 fullStory，严格使用以下结构'));
  assert.doesNotMatch(template, /"(?:transformationProof|experienceFidelity|selfCheck)"\s*:/u);
  assert.match(text, /keyProps 只写实际出现的物件、叙事用途与必要状态/u);
});

// full_story/1.1：生成责任以当前选中候选为界，旧合同由兼容测试保留。
test("固定主角仍是中心，生活型允许观察反应与陪伴", () => {
  const text = prompt({ ...leanVariant, narrativeMode: "slice_of_life" });
  assert.match(text, /固定主角仍是叙事关注中心/u);
  assert.match(text, /允许在观察、反应、参与和陪伴中体现性格/u);
  assert.match(text, /本候选为生活型/u);
  assert.match(text, /不要求艰难选择、额外阻碍、受奖励或表态承诺/u);
  assert.doesNotMatch(text, /宠物舔爪子、打呼噜同样不算|由固定主角本人完成/u);
});

// 2026-08-30 实测：12 次 Full Story 截断的退化段起点全部落在同一偏移（约 490），
// 都是模型把 creatorProfile.constraints 里的全角引号“谢谢、再见”抄成未转义的
// 半角双引号，当场闭合 JSON 字符串，然后在 `:"",  ":"` 上重复到 16384 token 上限，
// 每次烧掉 214–284 秒。历史 99 份可解析输出里 41 份自发用单引号、2 份用全角引号，
// 零份用裸半角引号——这条规则只是把已被验证有效的写法显式化。
// 无确定性兜底：无法在生成前预判模型会吐哪种引号。
test("JSON 输出契约禁止字符串值内出现裸半角双引号", () => {
  const text = prompt();
  assert.match(text, /字符串值内部不得出现半角双引号/u);
  assert.match(text, /需要引用词句时用「」或单引号/u);
  // 不能退化成「要求模型自己写 \\" 转义」——转义正是它当前失败的动作。
  assert.match(text, /上游文本里的全角引号“”必须原样保留，不得改写成半角双引号/u);
  assert.match(text, /未转义的半角双引号会当场闭合字符串，让整份输出作废/u);
});

// 这条规则讲的是 JSON 序列化本身，属于 JSON_ONLY 共享输出契约，不是 Full Story 的
// 局部补丁：Analyze / Reconstruct 同样要把带引号的原片字幕转抄进字符串值。
// 若有人把它挪进 fullStoryPrompt 正文，这个断言会失败。
test("引号规则来自共享 JSON 输出契约，覆盖其它转抄原文的阶段", () => {
  const shared = /字符串值内部不得出现半角双引号/u;
  assert.match(analysisPrompt({ metadata: {}, frames: [] }), shared);
  assert.match(reconstructionPrompt({ referenceAnalysis: {}, metadata: {}, frames: [] }), shared);
});

// 2026-08-30：同一轮里连续三次 FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING，都是同一个误解——
// visibleAction 写了「远处，奶奶正弯腰用木耙翻晒金黄的谷子」，characters 却只有主角和宠物。
// 模型把「远景里的背景人物」当成了不出镜。提示词此前只反复讲画外音那一种情况，
// 从没说过「站得远也算出镜」。这条有确定性校验兜底（校验器已经在拦），补的是可执行判据。
test("远景与背景里看得见的人也必须写进 characters", () => {
  const text = prompt();
  assert.match(text, /「出镜」只看这一场的画面里能不能看见这个人，与他站得多远、是不是本场主体无关/u);
  assert.match(text, /远处，奶奶正弯腰用木耙翻晒金黄的谷子/u);
  // 2026-08-31 契约变更：这条原本还列着「不算出镜的只有三种」豁免（地点归属称呼、
  // 只被提到、回忆转述）。豁免已被删除——不是放松而是收紧：那三种情况现在一律要求
  // 改写成不带名字的写法，可见事实字段里出现名字就等于声称这个人在画面里，没有例外。
  // 改写范式由下面「visibleAction 与 shotAndSound 不得出现不在画面里的角色名」覆盖。
  assert.doesNotMatch(text, /仍然不算出镜的只有三种/u);
});



// 2026-08-31：契约原先承诺三种「提到了但不算出镜」的豁免，扫描却是裸子串匹配、一条
// 都没实现——回扫 180 份可解析历史输出，45 条命中里约三分之二是模型照提示词写了合法
// 文本反被判失败。修法不是让校验器变聪明（补词表＝关键词白名单，或让模型登记豁免＝
// 给 visibleAction 开后门，实测模型三次全在拿它登记离场），而是让规则和这个裸匹配对齐：
// 可见事实字段里出现名字，就等于声称这个人在画面里。
test("visibleAction 与 shotAndSound 不得出现不在画面里的角色名", () => {
  const text = prompt();
  assert.match(text, /visibleAction 和 shotAndSound 里不得出现任何不在本场画面里的角色名/u);
  // 四种改写范式各要给出可照抄的写法，只讲禁令模型不知道该怎么落笔。
  assert.match(text, /不写「屋外传来李奶奶喊白子回家的声音」，写「屋外传来喊白子回家的声音」/u);
  assert.match(text, /不写「贴着「李奶奶」标签的快递盒」，写「贴着手写标签的快递盒」/u);
  assert.match(text, /location 照写「奶奶家的客厅」「李奶奶家门口」/u);
  // 2026-09-02 实测卡住的写法：location 带归属没问题（它不在扫描范围内），
  // 是 visibleAction 把那个短语原样抄了一遍。诱因写在这里，别写成「location 也不许写归属」。
  assert.match(text, /不要再抄进 visibleAction/u);
  assert.match(text, /奶奶正在卧室睡觉、根本没出镜，抄进来就等于声称她在画面里/u);
  assert.doesNotMatch(text, /地点的归属称呼\*\*也不得放进 location\*\*/u);
});

// 2026-09-06：屏幕上的文字是这条规则的第四种形状，此前三条范式一条都不覆盖。
// 实测证据链：模型先把「黑屏浮现白色发光文字：「⋯⋯继续加油~ 小白子！」」写进 visibleAction
// 被拦，下一次请求主动把引文挪到 shotAndSound、visibleAction 改干净，又被同一条规则拦住——
// 它读懂了规则并照做，只是两个字段都在扫描范围内。所以范式必须点明两个字段都适用，
// 否则模型只会在两个字段之间来回搬。名字去掉后原话按既有路由进 shootingNotes，信息不丢。
test("屏幕文字里的角色名同样要去掉，两个可见事实字段都适用", () => {
  const text = prompt();
  assert.match(text, /屏幕上出现的文字里的角色名同样要去掉/u);
  assert.match(text, /片尾卡、字幕、招牌、门牌、快递单都算/u);
  assert.match(
    text,
    /不写「黑屏浮现白色文字『继续加油~ 小白子！』」，写「黑屏浮现一行白色发光文字」/u
  );
  // 去名字不能滑成去细节：原话仍要有落点，否则模型会连「这里有一行字」都不敢写。
  assert.match(text, /确实要指定卡面原话时把它写进 shootingNotes/u);
  // 裸子串匹配分不出「人」和「字形」——把判据说清，模型才知道这不是可以商量的语义题。
  assert.match(text, /分不出这三个字是「画面里站着一个人」还是「屏幕上要渲染的字形」/u);
  assert.match(text, /\*\*visibleAction 和 shotAndSound 都适用\*\*/u);
  assert.match(text, /把引文从一个字段挪到另一个字段不会通过/u);
});

// 2026-09-06：片尾署名卡不是模型通病，是「参考片有这张卡」直接驱动的——
// debug 现存 25 份可解析候选里，《明天》两个 run 5/5 带卡，其余 8 个 run 0/20。
// 成因是 fullStoryPrompt 把整份 referenceAnalysis / sourceScriptReconstruction 塞进提示词，
// 模型逐字读到原片那张卡就照抄。这条规则本质是 §「允许不等于必须使用」的具体化，
// 所以写在承接/来源块里，而不是当成又一条可见事实字段禁令。
test("结尾保留候选体验，不从原片补卡或奖励", () => {
  const text = prompt();
  assert.match(text, /收尾在候选承诺的实际体验与人物回应完成时结束/u);
  assert.match(text, /原片的片尾卡和署名也不是本片素材/u);
  assert.match(text, /不另加奖励、仪式、时间跳转或主题总结/u);
  assert.match(text, /是不是对眼前具体行为的自然反应/u);
  assert.match(text, /不能拿通用亲密动作替代候选原有的共同体验/u);
});

// 去名字不能滑成去细节，否则会直接伤到 videoPrompt 的可渲染信息与生活质感约束。
test("只去名字不去可见细节，且说明名字在其它字段照常保留", () => {
  const text = prompt();
  assert.match(text, /\*\*去掉的只有名字，不是可见细节。\*\*/u);
  assert.match(text, /「一个快递盒」不合格/u);
  assert.match(text, /名字在 location、dialogue 的台词正文、characterBible、shootingNotes 里都可以自由出现/u);
  assert.match(text, /只有 visibleAction 和 shotAndSound 这两个可见事实字段要干净/u);
});

// 离场不单独做机制：它是同一条纪律的另一个触发点。前三版提示词都在跟模型争
// 「她算不算出镜」，七次没让步；这一版改成承认它的意图并直接给替代写法。
test("离场给出三条出路，并把选角声明的语义说清楚", () => {
  const text = prompt();
  assert.match(text, /characters 是你对这一场的选角声明，visibleAction 不能演一个你没选的角色/u);
  assert.match(text, /\*\*写离场的结果，不写离场的动作\*\*/u);
  assert.match(text, /写「木门在身后合上，晾衣绳边只剩下小白子」/u);
  assert.match(text, /挪到上一场结尾，本场从他走后开始/u);
});

// offscreenSoundSources 保留为兜底，但必须退到「名字实在去不掉」之后，
// 且那条不对称（只豁免 shotAndSound）不能松。
test("offscreenSoundSources 降为兜底，仍绝不豁免 visibleAction", () => {
  const text = prompt();
  assert.match(text, /名字实在无法从 shotAndSound 里去掉时/u);
  assert.match(text, /只豁免 shotAndSound，\*\*绝不豁免 visibleAction\*\*/u);
  assert.match(text, /同一个名字不得同时出现在 characters 和 offscreenSoundSources/u);
  // 已删除的机制不得残留在提示词里。
  assert.doesNotMatch(text, /nonVisualMentions/u);
});

// 2026-08-31 live 探针：模型把画外的「谁呀？」编码成了 dialogue 条目，撞上
// FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING。规则一直只说「不许写进 dialogue」，
// 从没说原话该放哪；而 shotAndSound 是完整传给镜头阶段的（resolveAnimationBatchScenes
// 返回的是整个场次对象），写在那里才有机会被视频模型说出来。
test("画外台词有明确去处：原话写进 shotAndSound，且仍不写说话人名字", () => {
  const text = prompt();
  assert.match(text, /\*\*画外说话人的台词不写进 dialogue，把原话连「」一起写进同场 shotAndSound。\*\*/u);
  assert.match(text, /门内传出一个苍老女声「谁呀？」/u);
  assert.match(text, /只写「传出说话声」而不写说了什么，那句台词就不会被说出来/u);
  // 给了去处不等于放开点名。
  assert.match(text, /说话人的名字仍然不写/u);
});

// 空间密度全部从 sourceScriptReconstruction 现算，不写死任何数值——
// 换一支参考片，目标就自动变成新片的密度。
//
// 起因：要求 visualPotential 写主角身体动作后，模型给每个动作配了一个新地点，
// 44 秒六场六个地点（1.36/10 秒）。而原片 44 秒只用两个地点（0.45），
// 六场大动作全在同一个院子里完成——大动作不需要换景。
const DENSE_SOURCE = Object.freeze({
  scenes: [
    { timeRange: "00:00-00:04", location: "农村院落门口", dialogueGist: "木门吱呀声" },
    { timeRange: "00:04-00:13", location: "农村院落内", dialogueGist: "爷爷说枣熟了" },
    { timeRange: "00:13-00:24", location: "农村院落内", dialogueGist: "提醒慢点捡" },
    { timeRange: "00:24-00:44", location: "农村院落门口", dialogueGist: "道别" }
  ]
});

test("原片空间密度不再给本片预设地点数量", () => {
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {}, referenceAnalysis: {},
    sourceScriptReconstruction: DENSE_SOURCE, variant: leanVariant
  });
  assert.equal(text, prompt());
  assert.doesNotMatch(text, /农村院落门口|平均每 10 秒|原片 4 场里有/u);
  assert.match(text, /场数由当前动作链、地点与节奏决定/u);
});

test("更换原片不能改变同一已选候选的 FullStory 提示词", () => {
  const base = { creatorProfile, creativeBrief: {}, visualGuardrails: {}, variant: leanVariant };
  const other = { scenes: [{ timeRange: "00:00-01:00", location: "旅馆", dialogueGist: "到了" }] };
  assert.equal(
    fullStoryPrompt({ ...base, sourceScriptReconstruction: DENSE_SOURCE }),
    fullStoryPrompt({ ...base, sourceScriptReconstruction: other })
  );
});

test("没有参考片时不注入空间投影", () => {
  assert.doesNotMatch(prompt(), /原片的空间与对白密度/u);
});

// 写死的举例必须标明来自另一部片子，否则模型会把它们当成本片素材照抄
test("不再用另一支片子的动作示例要求本片补戏", () => {
  const text = prompt();
  assert.doesNotMatch(text, /趴在木桌旁听收音机|戴着锅继续把枣捡完|爷爷刚提醒过会被枣砸到/u);
  assert.match(text, /只补足让观众看懂候选所需的动作与过渡/u);
  assert.match(text, /不另开支线来表现/u);
});

// 候选的 storyOutline[].action 对角色名没有任何约束，而本阶段的 visibleAction
// 有裸子串扫描。两次真实回放（2026-09-12，候选 V2《罐装阳光与太阳味》）都死在
// 同一个地方：候选拍 3 原文是「把罐子放在奶奶刚叠好的、带着阳光味道的被子上」，
// 模型照抄进 visibleAction，撞 FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING。
// 根因是提示词自相矛盾——「必须忠实承接 Variant」与「可见字段不得出现角色名」
// 对同一句话给出相反指令，而当时没有优先级。这里锁住那条优先级声明。
test("承接候选正文时，字句服从可见事实字段规则", () => {
  const text = prompt();
  assert.match(text, /承接的是候选写出的剧情事实，不是它的字句/u);
  assert.match(text, /storyOutline\[\]\.action 对角色名没有任何约束/u);
  assert.match(text, /两者冲突时以可见事实字段规则为准/u);
  assert.match(text, /把候选正文原样抄进可见事实字段会直接判失败/u);
  // 反方向同样要挡住：不能借「措辞可以改」去删可见细节或改动候选已定的事实
  assert.match(text, /改写只去掉名字，不得连可见细节一起删掉/u);
  assert.match(text, /不得借「措辞可以改」去改变候选已经确定的动作、道具、地点或结果/u);
});

// 原有四条范式里没有这个形状：名字不是写在道具上（那是「贴着标签的快递盒」那条），
// 而是用来交代这件道具是谁经手的。裸子串匹配分不出两者。
test("可见事实字段列出第五种写法：道具的来历或经手人", () => {
  const text = prompt();
  assert.match(text, /不在画面里的人有五种常见写法/u);
  assert.match(text, /用来说明道具\*\*来历或经手人\*\*的名字同样要去掉/u);
  assert.match(text, /不写「奶奶刚叠好的被子」，写「刚叠好的蓬松被子」/u);
  // 去掉的只有名字，可见特征必须留着——与既有「贴着手写标签的快递盒」同规格
  assert.match(text, /刚叠好、蓬松、带着晒过的暖意这些可见特征全部保留/u);
  assert.match(text, /写进 shootingNotes 或让 dialogue 的台词正文自己说/u);
});

// full_story/1.1：生成责任以当前选中候选为界，旧合同由兼容测试保留。
test("Brief 的来源与改编距离字段不再进入选中候选展开", () => {
  const brief = {
    nonNegotiableExperience: { samePlotDriver: "BRIEF_PLOT_DRIVER_SENTINEL", sameBeatValue: "BRIEF_BEAT_VALUE_SENTINEL" },
    reusableHighValueBeats: [{ beat: "BRIEF_BEAT_SENTINEL", dramaticValue: "价值", mustRetain: "BRIEF_MUST_RETAIN_SENTINEL" }],
    creativeDistancePolicy: "BRIEF_DISTANCE_SENTINEL"
  };
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: brief, visualGuardrails: {},
    referenceAnalysis: {}, sourceScriptReconstruction: {}, variant: leanVariant
  });
  for (const sentinel of [
    "BRIEF_PLOT_DRIVER_SENTINEL", "BRIEF_BEAT_VALUE_SENTINEL",
    "BRIEF_BEAT_SENTINEL", "BRIEF_MUST_RETAIN_SENTINEL", "BRIEF_DISTANCE_SENTINEL"
  ]) {
    assert.doesNotMatch(text, new RegExp(sentinel, "u"));
  }
});
