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

// 真实回放：模型引用了原片确实发生过的事，但混合了上游两种措辞
// （取了 A 的"骑着"，丢了 A 的"一个"），整串比对会误判为编造并阻断整个阶段。
const realUpstream = Object.freeze({
  referenceAnalysis: {
    storySynopsis: "咕嘎收到一封信后，骑着自行车去给一位独居老奶奶送快递。",
    observedFacts: [
      "咕嘎骑着自行车，车把上有一个企鹅玩偶。",
      "画面F2：咕嘎骑自行车，车把上有企鹅玩偶。"
    ]
  },
  sourceScriptReconstruction: {
    scenes: [{ visibleActions: ["咕嘎骑着自行车，车把上有一个企鹅玩偶"] }]
  }
});

// 其余六项改为【原片没有】：本组只针对第 0 项做判定，避免 mock 自带的引用
// 去比对这份与它无关的 realUpstream。
function realBrief(assessment) {
  const brief = mockBrief({ creatorProfile, ...upstream });
  brief.allowedNarrativeComponents.forEach((item, index) => {
    item.howToReuseSafely = index === 0 ? assessment : "【原片没有】本组用例不评估该构件。";
  });
  return brief;
}

test("回放：混合上游两种措辞的近似引用不应阻断阶段", () => {
  assert.doesNotThrow(() => ensureCreativeBriefMatchesProfile(
    realBrief("【原片有】「咕嘎骑着自行车，车把上有企鹅玩偶」。保留送达目标压力，改写物品与接收者。"),
    creatorProfile,
    realUpstream
  ));
});

test("分句放宽后，编造的场景仍然拒绝", () => {
  assert.throws(
    () => ensureCreativeBriefMatchesProfile(
      realBrief("【原片有】「咕嘎把包裹交给邻居家的小孩，对方回赠一朵花」。"),
      creatorProfile,
      realUpstream
    ),
    (error) => error instanceof OutputContractError && /引用的原文在上游并不存在/u.test(error.message)
  );
});

test("真句混编造句时，只报编造的那一句", () => {
  assert.throws(
    () => ensureCreativeBriefMatchesProfile(
      realBrief("【原片有】「咕嘎骑着自行车，然后把包裹丢进了河里」。"),
      creatorProfile,
      realUpstream
    ),
    (error) => error instanceof OutputContractError
      && error.message.includes("然后把包裹丢进了河里")
      && !error.message.includes("「咕嘎骑着自行车」")
  );
});

test("跨字段粘连不构成命中", () => {
  const split = { referenceAnalysis: { observedFacts: ["咕嘎骑着自行车", "车把上有企鹅玩偶"] } };
  assert.throws(
    () => ensureCreativeBriefMatchesProfile(
      realBrief("【原片有】「咕嘎骑着自行车车把上有企鹅玩偶」。"),
      creatorProfile,
      split
    ),
    OutputContractError
  );
});
