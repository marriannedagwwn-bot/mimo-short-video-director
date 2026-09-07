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

// 2026-09-06 实测：mappingLogic 的举例正文里写死了「不继承原片企鹅服、快递员身份和视觉外壳」，
// 而当天的简报输出是「不继承原片企鹅连体衣、快递员身份和视觉外壳」——**只换了两个词**。
// 上游 referenceAnalysis 与 sourceScriptReconstruction 里「快递」出现 0 次：
// 企鹅装是真的，快递员是从举例里抄来的。这个虚构随后被四个候选全部继承，
// V1 还照着它把整条结构建成「主动承担送达任务」，而同一份简报明写着送达任务【原片没有】。
//
// 举例的措辞可以被抄，具体名词不行——所以举例里不再放任何参考片的具体名词。
// 这一条**没有确定性兜底**（判断模型有没有在抄举例需要语义判断），
// 它的兜底在下一个阶段：候选的 transformationProof.source 会被回上游硬核对。
test("mappingLogic 举例不含参考片具体名词，避免被逐字抄成原片事实", () => {
  const prompt = briefPrompt(input);
  assert.match(prompt, /不继承原片主角的服装、职业外壳与视觉标签/u);
  assert.doesNotMatch(prompt, /不继承原片企鹅服、快递员身份和视觉外壳/u);
  assert.match(prompt, /\*\*举例里的措辞可以照搬，具体名词不行\*\*/u);
  assert.match(prompt, /每一个描述原片的具体名词都必须是你在 referenceAnalysis 或 sourceScriptReconstruction 里真的读到的/u);
});

// 357 行那句仍然保留「企鹅快递员」——它说明的是「外壳职业不得覆盖固定主角」这条判据，
// 删掉会丢掉一个真实存在的危险形状。按 §2.10 已有的做法给它加标注即可。
test("仍需保留的举例带上「来自另一部参考片」标注", () => {
  const prompt = briefPrompt(input);
  assert.match(prompt, /这一句里的企鹅、企鹅快递员来自另一部参考片，只示范判据，不要照抄内容/u);
});
