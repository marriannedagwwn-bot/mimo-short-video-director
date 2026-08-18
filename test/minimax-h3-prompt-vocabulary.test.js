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

test("H3 提示词逐字列出被禁的抽象情绪词", () => {
  const prompt = h3Prompt();
  for (const word of ["healing", "atmosphere", "emotional", "tender", "conveying"]) {
    assert.ok(prompt.includes(word), `缺少被禁情绪词示例：${word}`);
  }
});
