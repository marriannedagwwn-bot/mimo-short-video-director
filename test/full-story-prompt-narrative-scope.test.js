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

test("承接范围只认当前 Variant 实际写出的内容", () => {
  const text = prompt();
  assert.match(text, /承接范围只有一个来源：当前选中 Variant 实际写出的内容/u);
  // 旧文案把七项 taxonomy 与 Variant 内容并列写成“都必须忠实承接”，
  // 与 Creative Brief 阶段“不会把该构件变成每个新方案的必选项”直接冲突。
  assert.doesNotMatch(
    text,
    /送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾，以及当前 Variant 已选用的人物、任务细节、道具和对白都必须忠实承接/u
  );
});

test("七项 taxonomy 被明确降级为原片分类，而不是本片必备构件", () => {
  const text = prompt();
  assert.match(text, /是 creativeBrief 用来记录“原片有没有某类通用构件”的分类，不是本片的必备构件，也不是承接清单/u);
  assert.match(text, /Variant 没写 careRecipient 就不得新增一个被照料对象/u);
  assert.match(text, /没写 helper 就不得新增一个提供帮助的外部角色/u);
  assert.match(text, /没写 emotionalMedium 就不得为故事发明一件信物/u);
  assert.match(text, /没写 endingRitual 就不得给它加一场仪式化收尾/u);
});

test("characterBible.careRecipient 被声明为可选键，且形状说明留在 JSON 结构之外", () => {
  const text = prompt();
  assert.match(text, /characterBible\.careRecipient 是可选键/u);
  assert.match(text, /不存在时整个键省略，不要输出空对象或占位文本/u);
  assert.match(text, /characterBible\.helpers 没有帮助者时输出空数组 \[\]/u);
  // JSON 结构样例里不得出现 // 注释：模型会照抄，产出非法 JSON。
  assert.doesNotMatch(text, /^\s*\/\//mu);
});

test("对白质量约束禁止复述画面与播报内心", () => {
  const text = prompt();
  assert.match(text, /对白不得复述同场 visibleAction 里观众已经能直接看见的信息/u);
  assert.match(text, /画面演完的事被念了第二遍/u);
  assert.match(text, /人物性格、情绪、潜台词、关系变化、误会、选择/u);
  assert.match(text, /宁可让一场戏没有对白，也不要用台词解说画面/u);
  assert.match(text, /不得用旁白式台词直接播报人物内心/u);
  assert.match(text, /forbiddenDialoguePatterns 必须至少列出“复述画面已有信息”“台词直接播报内心”“角色说出本片主题或感悟”三条/u);
});

test("放开可选构件不影响固定角色锁定与既有场次契约", () => {
  const text = prompt();
  assert.match(text, /主角必须锁定为上方固定角色/u);
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
  assert.match(text, /Variant 已选用的人物、任务细节、道具、媒介、结尾方式和对白方向必须忠实承接/u);
});

// targetDurationSeconds 由服务端从 sceneScript 时间轴派生。
// 实测 65 份历史 Full Story 中 24 份（37%）自相矛盾，最大偏差 +50 秒：
// 声明 60 秒却排出 106 秒的场次，页面照声明值显示「60 秒」，
// 而下游按时间轴派生出 10 个镜头的 106 秒成片，按镜头计费。
test("Full Story 提示词写明时长由时间轴决定且会被服务端覆盖", () => {
  const text = prompt();
  assert.match(text, /由 sceneScript 各场 timeRange 的跨度之和决定，不是由 targetDurationSeconds 这个数字决定/u);
  assert.match(text, /合计必须落在 45-90 秒内/u);
  assert.match(text, /服务端会按时间轴重新计算 targetDurationSeconds 并覆盖你写的值/u);
});

// 候选 storyOutline 放开为 5–7 拍后，5 拍候选进 Full Story 会被模型按 1:1 映射成
// 5 个 beatSheet，撞上 beatSheet >= 6。实测同一个 5 拍候选六次尝试四次失败。
// 根因是提示词从未提到 storyOutline，模型无从知道两者不是一一对应。
test("提示词说明 storyOutline 是候选摘要，beatSheet 必须展开而不是照抄拍数", () => {
  const text = prompt();
  assert.match(text, /storyOutline 是 5–7 拍的\*\*候选级摘要\*\*，不是本阶段的节拍表/u);
  assert.match(text, /\*\*不要与 storyOutline 一一对应\*\*/u);
  assert.match(text, /把 5 拍摘要原样抄成 5 个 beatSheet 是错的/u);
  assert.match(text, /候选摘要只有 5 拍时，必须把它展开到至少 6 拍/u);
});

// 实测成片的三个对白缺陷，全部来自同一份 Full Story：
//   1. S4 的 visibleAction 已写「从衣柜里拿出厚外套和手电筒」，台词又念一遍
//      「穿上厚外套，带上手电筒」——而它自己声明的第一条禁忌就是「复述画面已有信息」
//   2. S6 用「下次流星雨，我们还一起来」把主题念给观众
//   3. 参考片 dialogueStyle.informationDensity 是「低」（对白只承担关系，末场无台词），
//      成片却让配角用三句台词分别扛起冲突、转折与主题
test("对白约束给出可执行自查，并禁止角色说出主题", () => {
  const text = prompt();
  assert.match(text, /把这句话遮住，只看同场 visibleAction，观众会不会漏掉任何信息/u);
  assert.match(text, /不会漏，就说明这句在复述画面/u);
  assert.match(text, /你呀你，真拿你没办法/u);
  assert.match(text, /\*\*不得让任何角色把本片的主题、意义或感悟说出来。\*\*/u);
  assert.match(text, /结尾尤其容易犯这个错/u);
  assert.match(text, /角色说出本片主题或感悟/u);
});

test("原片对白风格提成具名投影并要求对齐信息密度", () => {
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    referenceAnalysis: {
      dialogueStyle: {
        tone: "亲切、童真", sentencePattern: "短句为主，口语化",
        informationDensity: "低", subtext: "通过简单互动传递温情"
      }
    },
    sourceScriptReconstruction: { scenes: [{ dialogueGist: "奶奶叮嘱慢点啊" }, { dialogueGist: "好啦" }] },
    variant: leanVariant
  });
  assert.match(text, /原片对白风格（必须对齐，见下方硬约束）/u);
  assert.match(text, /信息密度「低」/u);
  assert.match(text, /原片各场对白大意（只看它们承担了什么，不要复用内容）/u);
  assert.match(text, /奶奶叮嘱慢点啊/u);
  assert.match(text, /对白的信息密度必须对齐上方「原片对白风格」/u);
  assert.match(text, /原片某场没有对白时，本片对应功能的场次也应当敢于不写对白/u);
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

test("原片生活质感提成具名投影，只取环境道具不取动作事实", () => {
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {},
    sourceScriptReconstruction: {}, variant: leanVariant,
    referenceAnalysis: TEXTURE_ANALYSIS
  });
  assert.match(text, /原片的生活质感来源（只看它靠什么\*\*类型\*\*的东西留住观众，不要复用具体内容）/u);
  assert.match(text, /萌系角色吸引力（靠「看到她戴锅防砸的可爱举动」兑现）/u);
  assert.match(text, /环境道具（注意其中与主线任务无关的那些）：桌上放着一台老式收音机/u);
  assert.match(text, /景别构成：特写（人物表情）、中景（互动场景）、全景（院落环境）/u);
  // visible_action 是主线动作，不属于「环境道具」，不该混进投影。
  // 断言只能限定在投影段内——整份 referenceAnalysis JSON 本来就会原样出现在
  // 提示词的另一处（既有行为），在全文里找这句话必然命中。
  const start = text.indexOf("原片的生活质感来源");
  const projection = text.slice(start, text.indexOf("\n\n", start));
  assert.doesNotMatch(projection, /小女孩把红枣递给爷爷/u);
  assert.match(projection, /老式收音机/u);
});

test("生活细节与萌点约束到位，且把微表情明确排除在萌点之外", () => {
  const text = prompt();
  assert.match(text, /至少 2 场的 visibleAction 要包含一个\*\*与主线任务无关或只有半相关\*\*的生活动作或环境道具/u);
  assert.match(text, /趴在木桌旁听收音机、老人摇着蒲扇站在门口目送/u);
  assert.match(text, /这些细节只占一两句，不得挤掉主线动作/u);
  assert.match(text, /萌点必须是\*\*动作\*\*，不是形容/u);
  assert.match(text, /环境——乡村院落本来就有小铁锅/u);
  assert.match(text, /\*\*皱眉、歪头、眨眼、抿嘴这类微表情不算萌点\*\*/u);
  assert.match(text, /不看脸、只看身体轮廓，观众能认出她在做什么吗/u);
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
test("transformationProof 里描述原片的部分必须能回上游找到依据", () => {
  const text = prompt();
  assert.match(text, /关于原片的那一半必须能在 sourceScriptReconstruction 或 referenceAnalysis 里逐字找到依据/u);
  assert.match(text, /把其中描述原片的词单独拎出来，回上游搜一遍/u);
  assert.match(text, /快递员和送货任务是凭空补的职业与任务/u);
  assert.match(text, /会污染改编距离判断与原创性检查/u);
});

// 上一轮只要求「萌点是大动作」，实测模型用「芙芙猫舔爪子」「打起了呼噜」交差——
// 幅度不够，而且是配角的动作、与剧情无关。打枣的标准是萌点必须同时是剧情的一环：
// 戴铁锅同时满足前因、环境、人物、声音、视觉、后续六条。
test("萌点必须由主角完成且承担剧情功能，宠物小动作不算", () => {
  const text = prompt();
  assert.match(text, /必须\*\*由固定主角本人完成\*\*——把萌点安排给配角或宠物不算数/u);
  assert.match(text, /\*\*宠物舔爪子、打呼噜同样不算\*\*/u);
  assert.match(text, /萌点还必须\*\*同时承担剧情功能\*\*，不能是贴上去的可爱装饰/u);
  assert.match(text, /前因——爷爷刚提醒过会被枣砸到/u);
  assert.match(text, /后续——戴着锅继续把枣捡完/u);
  assert.match(text, /把这个萌点删掉，剧情会不会缺一块/u);
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
  // 三种改写范式各要给出可照抄的写法，只讲禁令模型不知道该怎么落笔。
  assert.match(text, /不写「屋外传来李奶奶喊白子回家的声音」，写「屋外传来喊白子回家的声音」/u);
  assert.match(text, /不写「贴着「李奶奶」标签的快递盒」，写「贴着手写标签的快递盒」/u);
  assert.match(text, /location 照写「奶奶家的客厅」「李奶奶家门口」/u);
  // 2026-09-02 实测卡住的写法：location 带归属没问题（它不在扫描范围内），
  // 是 visibleAction 把那个短语原样抄了一遍。诱因写在这里，别写成「location 也不许写归属」。
  assert.match(text, /不要再抄进 visibleAction/u);
  assert.match(text, /奶奶正在卧室睡觉、根本没出镜，抄进来就等于声称她在画面里/u);
  assert.doesNotMatch(text, /地点的归属称呼\*\*也不得放进 location\*\*/u);
});

// 去名字不能滑成去细节，否则会直接伤到 videoPrompt 的可渲染信息与生活质感约束。
test("只去名字不去可见细节，且说明名字在其它字段照常保留", () => {
  const text = prompt();
  assert.match(text, /\*\*去掉的只有名字，不是可见细节。\*\*/u);
  assert.match(text, /「一个快递盒」不合格/u);
  assert.match(text, /名字在 location、dialogue 的台词正文、beatSheet、characterBible、shootingNotes 里都可以自由出现/u);
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

test("空间与对白密度从参考片现算，不写死数值", () => {
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {}, referenceAnalysis: {},
    sourceScriptReconstruction: DENSE_SOURCE, variant: leanVariant
  });
  assert.match(text, /原片 44 秒里只用了 2 个地点：农村院落门口、农村院落内/u);
  assert.match(text, /平均每 10 秒 0\.45 个地点/u);
  assert.match(text, /\*\*换的是动作和机位，不是地点\*\*/u);
  assert.match(text, /不要为了写出一个大动作就新开一个场景/u);
  assert.match(text, /原片 4 场里有 4 场带对白/u);
  assert.match(text, /不要靠减少对白来显得克制/u);
});

test("换一支参考片，投影数值随之改变", () => {
  const roadTrip = {
    scenes: [
      { timeRange: "00:00-00:15", location: "车站", dialogueGist: "买票" },
      { timeRange: "00:15-00:30", location: "山路", dialogueGist: "" },
      { timeRange: "00:30-00:45", location: "海边", dialogueGist: "到了" },
      { timeRange: "00:45-01:00", location: "旅馆", dialogueGist: "" }
    ]
  };
  const text = fullStoryPrompt({
    creatorProfile, creativeBrief: {}, visualGuardrails: {}, referenceAnalysis: {},
    sourceScriptReconstruction: roadTrip, variant: leanVariant
  });
  assert.match(text, /原片 60 秒里只用了 4 个地点：车站、山路、海边、旅馆/u);
  assert.match(text, /平均每 10 秒 0\.67 个地点/u);
  assert.match(text, /原片 4 场里有 2 场带对白/u);
  assert.doesNotMatch(text, /农村院落/u);
});

test("没有参考片时不注入空间投影", () => {
  assert.doesNotMatch(prompt(), /原片的空间与对白密度/u);
});

// 写死的举例必须标明来自另一部片子，否则模型会把它们当成本片素材照抄
test("提示词里的固定举例标注了来源，不会被当成本片内容", () => {
  const text = prompt();
  assert.match(text, /下面这个例子来自另一部参考片，只用来说明什么叫「与主线无关」，不要照抄它的内容/u);
  assert.match(text, /同样来自另一部参考片，只示范判据，不要照抄内容/u);
});
