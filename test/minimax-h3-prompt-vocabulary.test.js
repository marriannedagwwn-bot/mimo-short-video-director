import test from "node:test";
import assert from "node:assert/strict";
import { animationShotBatchPrompt } from "../src/prompts.js";

// 实测依据：一次真实 H3 Plan 的六个镜头，官方运镜词 0/6、幅度速度 0/6、风格词 0/6，
// non_diegetic_music 六镜全部出现抽象情绪词，A01 还写进了四个十六进制色号。
// 根因是 Prompt 只说了"摄影运动的类型、必要幅度与速度"，从未把官方受控词表列给模型。
function h3Prompt() {
  return animationShotBatchPrompt({
    creatorProfile: { fixedCharacter: "小白子，q版狼耳少女", vertical: "治愈日常", constraints: "" },
    variant: { id: "V1", title: "t", characterSetup: { protagonist: "小白子" } },
    fullStory: { selectedVariantId: "V1", sceneScript: [] },
    animationPlanMode: "direct_shot",
    videoPromptProfile: {
      schemaVersion: "1.0",
      profileId: "minimax_h3",
      provider: "MiniMax",
      model: "MiniMax-H3",
      guideVersion: "80365054c7fbaace01ed417076fecd532c1ae0e0"
    }
  });
}

test("H3 提示词内嵌官方 12 个运镜类型", () => {
  const prompt = h3Prompt();
  for (const motion of [
    "Zoom In", "Zoom Out", "Push In", "Pull Out", "Pan Left", "Pan Right",
    "Truck Left", "Truck Right", "Tilt Up", "Tilt Down", "Pedestal Up", "Pedestal Down",
    "Arc Shot", "Tracking Shot", "Static Shot", "Shake Slightly", "Shake Strongly",
    "POV", "Roll Clockwise", "Roll Counterclockwise"
  ]) {
    assert.ok(prompt.includes(motion), `缺少官方运镜词：${motion}`);
  }
});

test("H3 提示词内嵌幅度与速度的精确短语", () => {
  const prompt = h3Prompt();
  for (const phrase of ["with small amplitude", "with large amplitude", "at slow speed", "at fast speed"]) {
    assert.ok(prompt.includes(phrase), `缺少：${phrase}`);
  }
});

test("H3 提示词内嵌官方 7 个风格词与 5 个切点动词", () => {
  const prompt = h3Prompt();
  for (const style of ["Cinematic", "live-action", "2D-animated", "3D CG", "claymation", "watercolor", "vintage film"]) {
    assert.ok(prompt.includes(style), `缺少风格词：${style}`);
  }
  for (const cut of [
    "the camera cuts to", "the shot cuts to", "the shot transitions to",
    "the shot changes to", "the shot switches to"
  ]) {
    assert.ok(prompt.includes(cut), `缺少切点动词：${cut}`);
  }
});

test("H3 提示词禁止色号与内联时间戳", () => {
  const prompt = h3Prompt();
  assert.match(prompt, /十六进制色号/u);
  assert.match(prompt, /#FF8C42/u, "应给出实测出现过的反例");
  assert.match(prompt, /时间戳只属于分镜切点标记/u);
});

test("H3 提示词要求说话人 ID、旁白短语与跨切标记", () => {
  const prompt = h3Prompt();
  assert.match(prompt, /\(S1,S2\)/u);
  assert.ok(prompt.includes("says in an off-screen voiceover"));
  assert.ok(prompt.includes("<scenetrans>"));
  assert.ok(prompt.includes("<cutoff>"));
});

// 说话人 ID 是补词表之后最大的失败源：61 镜里 17 次因缺 ID 失败，占全部失败的 59%。
// 原提示词只说"必须带稳定 ID"却不给位置，模型的自然写法 She says <d>…</d> 无处安放它。
// 官方句式是 ID 跟在身份短语之后、动词之前，因此改为给出可照抄的模板与两条官方范例。
test("说话人 ID 给出官方位置模板而不只是要求带 ID", () => {
  const prompt = h3Prompt();
  assert.match(prompt, /<身份短语> \(S1\) says: <d>/u, "应给出可照抄的位置模板");
  assert.ok(
    prompt.includes("The young woman with a quiet, breathy voice (S1) says:"),
    "应附官方单人范例"
  );
  assert.ok(
    prompt.includes("The two children (S1,S2) shout together,"),
    "应附官方同时发声范例"
  );
  assert.match(prompt, /不要写成 She says \(S1\)/u, "应点名模型实际写错的形式");
});

// 原本这条断言 Prompt 里逐字列出 healing/atmosphere/emotional 等禁词。
// 实测该写法无效且可能有害：把禁词写出来反而提高它们的出现概率（否定式指令天生弱）。
// 已改为正向模板——只允许四类可听要素，并给出可直接执行的范例。
test("non_diegetic_music 采用正向模板而不是禁词黑名单", () => {
  const prompt = h3Prompt();
  assert.match(prompt, /乐器与音色、速度、节奏型、音量或织体的动态变化/u);
  assert.ok(prompt.includes("A single nylon-string guitar figure at a moderate tempo"), "应给出可执行范例");
  for (const word of ["healing", "atmosphere", "tender", "conveying"]) {
    assert.ok(!prompt.includes(word), `不应再把禁词 ${word} 写进提示词`);
  }
});
