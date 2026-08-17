import test from "node:test";
import assert from "node:assert/strict";
import { mockAnalysis, mockBrief, mockReconstruction } from "../src/mock.js";
import { ensureCreativeBriefMatchesProfile, OutputContractError } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

const upstream = Object.freeze({
  referenceAnalysis: mockAnalysis({ metadata: { duration: 60 } }),
  sourceScriptReconstruction: mockReconstruction({ metadata: { duration: 60 } })
});

function briefWithAssessment(assessment) {
  const brief = mockBrief({ creatorProfile, ...upstream });
  brief.allowedNarrativeComponents[0].howToReuseSafely = assessment;
  return brief;
}

test("mock 简报的【原片有】引用真的能在上游逐字找到", () => {
  const brief = mockBrief({ creatorProfile, ...upstream });
  assert.ok(
    brief.allowedNarrativeComponents.every((item) => item.howToReuseSafely.includes("「")),
    "mock 七项都应带逐字引用"
  );
  assert.doesNotThrow(() => ensureCreativeBriefMatchesProfile(brief, creatorProfile, upstream));
});

test("【原片有】引用上游确实存在的原文时通过", () => {
  assert.doesNotThrow(() => ensureCreativeBriefMatchesProfile(
    briefWithAssessment("【原片有】「完成送达或照料」。保留目标压力，改写物品与接收者。"),
    creatorProfile,
    upstream
  ));
});

test("【原片有】编造上游并不存在的原文必须失败", () => {
  assert.throws(
    () => ensureCreativeBriefMatchesProfile(
      briefWithAssessment("【原片有】「S3 中主角把包裹送到邻居家门口」。保留送达压力。"),
      creatorProfile,
      upstream
    ),
    (error) => error instanceof OutputContractError
      && /引用的原文在上游并不存在/u.test(error.message)
  );
});

test("【原片有】完全不给引用也必须失败", () => {
  assert.throws(
    () => ensureCreativeBriefMatchesProfile(
      briefWithAssessment("【原片有】原片主线就是把东西送到某人手里，保留该压力。"),
      creatorProfile,
      upstream
    ),
    (error) => error instanceof OutputContractError
      && /必须用「」引出一段/u.test(error.message)
  );
});

test("【原片没有】不需要引用", () => {
  assert.doesNotThrow(() => ensureCreativeBriefMatchesProfile(
    briefWithAssessment("【原片没有】原片只是陪伴，没有送交任务；本次不采用。"),
    creatorProfile,
    upstream
  ));
});

test("未提供上游时跳过逐字核对，不误伤既有调用", () => {
  assert.doesNotThrow(() => ensureCreativeBriefMatchesProfile(
    briefWithAssessment("【原片有】「原片里根本没有这句话」。"),
    creatorProfile
  ));
});
