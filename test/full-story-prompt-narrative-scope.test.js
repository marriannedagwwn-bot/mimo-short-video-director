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
  assert.match(text, /画面已经说完的事，台词再说一遍就等于浪费这一句/u);
  assert.match(text, /人物性格、情绪、潜台词、关系变化、误会、选择/u);
  assert.match(text, /宁可让一场戏没有对白，也不要用台词解说画面/u);
  assert.match(text, /不得用旁白式台词直接播报人物内心/u);
  assert.match(text, /forbiddenDialoguePatterns 必须至少列出“复述画面已有信息”和“台词直接播报内心”两条/u);
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
