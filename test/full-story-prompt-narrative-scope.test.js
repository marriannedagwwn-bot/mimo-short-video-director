import test from "node:test";
import assert from "node:assert/strict";
import { fullStoryPrompt } from "../src/prompts.js";

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
