import test from "node:test";
import assert from "node:assert/strict";
import { mockBrief } from "../src/mock.js";
import {
  CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS,
  ensureOutputContract,
  OutputContractError
} from "../src/validation.js";
import { briefPrompt } from "../src/prompts.js";

const input = Object.freeze({
  creatorProfile: {
    fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  },
  referenceAnalysis: {},
  sourceScriptReconstruction: {}
});

function briefWithComponentAssessment(assessment, componentIndex = 0) {
  const brief = mockBrief(input);
  brief.allowedNarrativeComponents[componentIndex].howToReuseSafely = assessment;
  return brief;
}

test("mock 简报自身满足存在性判定，七项齐全", () => {
  const brief = mockBrief(input);
  assert.equal(
    brief.allowedNarrativeComponents.length,
    CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS.length
  );
  assert.doesNotThrow(() => ensureOutputContract(brief, "creativeBrief"));
});

test("【原片有】与【原片没有】两个分支都合法", () => {
  assert.doesNotThrow(() => ensureOutputContract(
    briefWithComponentAssessment("【原片有】S1 中主角把信交到收件人手中。保留目标压力，改写物品与阻碍。"),
    "creativeBrief"
  ));
  assert.doesNotThrow(() => ensureOutputContract(
    briefWithComponentAssessment("【原片没有】原片只是陪伴亲近的人经历人生节点，没有送交任务；本次不采用。"),
    "creativeBrief"
  ));
});

test("缺少存在性判定时必须失败，并指名是哪一项构件", () => {
  assert.throws(
    () => ensureOutputContract(
      briefWithComponentAssessment("保留“必须把某物送到某人手中”的目标压力，改写物品、接收者和阻碍。"),
      "creativeBrief"
    ),
    (error) => error instanceof OutputContractError
      && /必须以 【原片有】 或 【原片没有】 开头/u.test(error.message)
      && error.message.includes("送达任务")
  );
});

test("真实漂移样本：为原片没有的构件直接写新片复用指令必须失败", () => {
  // 实际运行中出现过的输出：原片并无送达任务，模型却把它写成了对新片的正向复用指令。
  assert.throws(
    () => ensureOutputContract(
      briefWithComponentAssessment("小白子携带许愿灯或类似情感媒介前往某户人家，任务动机隐含在动作中，无需台词说明"),
      "creativeBrief"
    ),
    (error) => error instanceof OutputContractError && error.message.includes("送达任务")
  );
});

test("判定标记必须在开头，混在句中不算", () => {
  assert.throws(
    () => ensureOutputContract(
      briefWithComponentAssessment("保留该构件，理由是【原片有】类似段落。"),
      "creativeBrief"
    ),
    OutputContractError
  );
});

test("每一项构件都被独立校验，不只查第一项", () => {
  assert.throws(
    () => ensureOutputContract(
      briefWithComponentAssessment("继续让环境形成外部阻力和氛围，但采用新的场景调度。", 5),
      "creativeBrief"
    ),
    (error) => error instanceof OutputContractError && error.message.includes("天气或空间推动情绪")
  );
});

test("简报提示词要求存在性判定并给出反例", () => {
  const prompt = briefPrompt(input);
  assert.match(prompt, /必须以「【原片有】」或「【原片没有】」开头/u);
  assert.match(prompt, /不得写成「主角携带某物前往某户人家」/u);
});
