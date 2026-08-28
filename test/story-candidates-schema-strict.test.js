import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import {
  OutputContractError,
  ensureOutputContract,
  ensureStoryCandidateContract
} from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

function validCandidates(count = 2) {
  return mockVariants({ creatorProfile, count });
}

function hasDiagnostic(error, code, path) {
  return error instanceof OutputContractError
    && error.details.some((detail) => detail.code === code && detail.path === path);
}

test("strict Story Candidates schema accepts the canonical Mock contract", () => {
  const value = validCandidates(3);
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
  for (const candidate of value.variants) {
    assert.equal(ensureStoryCandidateContract(candidate), candidate);
    for (const field of ["keyChoice", "climax", "emotionalPayoff", "novelty", "visualPotential"]) {
      assert.equal(typeof candidate[field], "string");
      assert.ok(candidate[field].trim());
    }
  }
});

test("strict Story Candidates schema rejects missing, null, wrong-type and unknown fields recursively", () => {
  const cases = [
    {
      mutate(value) { delete value.variants[0].keyChoice; },
      code: "STORY_CANDIDATES_SCHEMA_REQUIRED",
      path: "/variants/0/keyChoice"
    },
    {
      mutate(value) { value.variants[0].climax = null; },
      code: "STORY_CANDIDATES_SCHEMA_TYPE",
      path: "/variants/0/climax"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].estimatedSeconds = "4"; },
      code: "STORY_CANDIDATES_SCHEMA_TYPE",
      path: "/variants/0/storyOutline/0/estimatedSeconds"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].camera = "禁止进入候选契约"; },
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      path: "/variants/0/storyOutline/0/camera"
    },
    {
      mutate(value) { value.variants[0].characterBible = {}; },
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      path: "/variants/0/characterBible"
    }
  ];

  for (const fixture of cases) {
    const value = validCandidates();
    fixture.mutate(value);
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => hasDiagnostic(error, fixture.code, fixture.path)
    );
  }
});

test("strict Story Candidates schema rejects empty arrays and required narrative text", () => {
  const cases = [
    {
      mutate(value) { value.variants = []; },
      code: "STORY_CANDIDATES_SCHEMA_MIN_ITEMS",
      path: "/variants"
    },
    {
      mutate(value) { value.variants[0].storyOutline = []; },
      code: "STORY_CANDIDATES_SCHEMA_MIN_ITEMS",
      path: "/variants/0/storyOutline"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].action = "   "; },
      code: "STORY_CANDIDATES_SCHEMA_EMPTY_STRING",
      path: "/variants/0/storyOutline/0/action"
    },
    {
      mutate(value) { value.variants[0].emotionalPayoff = "\n\t"; },
      code: "STORY_CANDIDATES_SCHEMA_EMPTY_STRING",
      path: "/variants/0/emotionalPayoff"
    }
  ];

  for (const fixture of cases) {
    const value = validCandidates();
    fixture.mutate(value);
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => hasDiagnostic(error, fixture.code, fixture.path)
    );
  }
});

test("Story Candidates require unique ids and strictly ordered 1..N beats", () => {
  const duplicate = validCandidates();
  duplicate.variants[1].id = duplicate.variants[0].id;
  assert.throws(
    () => ensureOutputContract(duplicate, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_ID_DUPLICATE", "/variants/1/id")
  );

  for (const invalidBeat of [0, 2, 9]) {
    const value = validCandidates();
    value.variants[0].storyOutline[0].beat = invalidBeat;
    const expectedCode = invalidBeat === 0
      ? "STORY_CANDIDATES_SCHEMA_RANGE"
      : "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID";
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => detail.code === expectedCode)
    );
  }

  const skipped = validCandidates();
  skipped.variants[0].storyOutline[1].beat = 3;
  assert.throws(
    () => ensureOutputContract(skipped, "themeVariants"),
    (error) => hasDiagnostic(
      error,
      "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID",
      "/variants/0/storyOutline/1/beat"
    )
  );
});

test("single-candidate helper validates strict shape and beat order without multi-candidate diversity", () => {
  const candidate = validCandidates(1).variants[0];
  assert.equal(ensureStoryCandidateContract(candidate, { path: "variant:V1" }), candidate);

  const unknownField = structuredClone(candidate);
  unknownField.shotPlan = [];
  assert.throws(
    () => ensureStoryCandidateContract(unknownField, { path: "variant:V1" }),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_SCHEMA_UNKNOWN_FIELD", "/shotPlan")
  );

  const invalidSequence = structuredClone(candidate);
  invalidSequence.storyOutline[2].beat = 9;
  assert.throws(
    () => ensureStoryCandidateContract(invalidSequence, { path: "variant:V1" }),
    (error) => hasDiagnostic(
      error,
      "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID",
      "/storyOutline/2/beat"
    ) && /variant:V1/u.test(error.message)
  );
});

// 这四个字段曾经是 required，等于强制每个候选都长成
// “主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾”。Prompt 一边要求候选之间根本不同，
// Schema 一边强制它们共用同一套人物功能配置，是候选彼此雷同的结构性原因。
// 现在改为可选：不需要就整个键省略；写了就仍必须是非空字符串。
const OPTIONAL_NARRATIVE_COMPONENTS = Object.freeze([
  "emotionalMedium",
  "endingRitual"
]);

test("可选叙事构件全部省略时，候选仍然通过 strict Schema", () => {
  const value = validCandidates(2);
  for (const candidate of value.variants) {
    for (const field of OPTIONAL_NARRATIVE_COMPONENTS) delete candidate[field];
    delete candidate.characterSetup.careRecipient;
    delete candidate.characterSetup.helper;
  }
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
  for (const candidate of value.variants) {
    assert.equal(ensureStoryCandidateContract(candidate), candidate);
    assert.deepEqual(Object.keys(candidate.characterSetup), ["protagonist"]);
  }
});

test("只省略其中一部分同样合法，各候选可以有不同的人物功能配置", () => {
  const value = validCandidates(3);
  // V1 保留完整配置；V2 没有被照料对象；V3 独自解决且没有信物与仪式。
  delete value.variants[1].characterSetup.careRecipient;
  delete value.variants[2].characterSetup.helper;
  delete value.variants[2].emotionalMedium;
  delete value.variants[2].endingRitual;
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
});

test("protagonist 仍然必填，放开可选构件不得波及固定角色锁定", () => {
  const value = validCandidates(2);
  delete value.variants[0].characterSetup.protagonist;
  assert.throws(
    () => ensureOutputContract(value, "themeVariants"),
    (error) => hasDiagnostic(error, "OUTPUT_SCHEMA_REQUIRED", "/variants/0/characterSetup/protagonist")
      || error instanceof OutputContractError
  );
});

test("可选构件写了就必须非空：空字符串仍然拒绝", () => {
  for (const field of OPTIONAL_NARRATIVE_COMPONENTS) {
    const value = validCandidates(2);
    value.variants[0][field] = "";
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      OutputContractError,
      `${field} 为空字符串时必须失败`
    );
  }
  for (const field of ["careRecipient", "helper"]) {
    const value = validCandidates(2);
    value.variants[0].characterSetup[field] = "   ";
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      OutputContractError,
      `characterSetup.${field} 为空白时必须失败`
    );
  }
});

test("可选构件仍受 additionalProperties 约束，不能借省略夹带新键", () => {
  const value = validCandidates(2);
  delete value.variants[0].endingRitual;
  value.variants[0].characterSetup.mentor = "新造的角色位";
  assert.throws(() => ensureOutputContract(value, "themeVariants"), OutputContractError);
});

// keyChoice/climax/emotionalPayoff 必须逐字等于 storyOutline 中某一拍的 action。
// 丢了这条，同一个候选就有两版剧情：顶层写压缩摘要、outline 写另一件事，
// 下游 Full Story 无从判断哪个是事实。旧 Prompt 用固定拍号（Beat 3/5/6）
// 让这件事是机械的，实测 60/60 合规；放开拍号后只靠措辞，实测掉到 31/48 甚至 0/12。
function candidateWithOutline(actions) {
  const value = validCandidates(1);
  const candidate = value.variants[0];
  candidate.storyOutline = actions.map((action, index) => ({
    beat: index + 1,
    phase: `第${index + 1}拍`,
    action,
    emotion: "平静",
    dramaticFunction: `功能${index + 1}`,
    estimatedSeconds: 8
  }));
  return { value, candidate };
}

test("顶层三字段逐字等于对应拍 action 时通过", () => {
  const { value, candidate } = candidateWithOutline(["开场", "作出选择", "选择的后果", "亲手解决", "关系兑现"]);
  candidate.keyChoice = "作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
});

test("顶层字段只是 action 的压缩摘要时必须失败", () => {
  const { value, candidate } = candidateWithOutline(["开场", "天色渐暗，她作出选择", "选择的后果", "亲手解决", "关系兑现"]);
  candidate.keyChoice = "她作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.throws(
    () => ensureOutputContract(value, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_NOT_VERBATIM", "/variants/0/keyChoice")
      && /只是它的一部分或它的超集/u.test(error.message)
  );
});

test("emotionalPayoff 必须是最后一拍，落在中间拍也失败", () => {
  const { value, candidate } = candidateWithOutline(["开场", "作出选择", "关系兑现", "亲手解决", "收尾空镜"]);
  candidate.keyChoice = "作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.throws(
    () => ensureOutputContract(value, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_NOT_VERBATIM", "/variants/0/emotionalPayoff")
  );
});

test("高潮拍不得早于或等于关键选择拍", () => {
  const { value, candidate } = candidateWithOutline(["亲手解决", "填充", "作出选择", "填充二", "关系兑现"]);
  candidate.keyChoice = "作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.throws(
    () => ensureOutputContract(value, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER", "/variants/0/climax")
  );
});

test("关键选择拍紧接高潮拍是合法结构，校验器不得用位置代理裁决剧作观点", () => {
  const { value, candidate } = candidateWithOutline(["开场", "作出选择", "亲手解决", "填充", "关系兑现"]);
  candidate.keyChoice = "作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
});

test("同一句话出现在多拍时无法唯一定位，明确失败而不是任选一拍", () => {
  const { value, candidate } = candidateWithOutline(["作出选择", "填充", "作出选择", "亲手解决", "关系兑现"]);
  candidate.keyChoice = "作出选择";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.throws(
    () => ensureOutputContract(value, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_AMBIGUOUS", "/variants/0/keyChoice")
  );
});

test("投影判定只比较字符串，不做语义判断", () => {
  // 语义上明显是同一个选择，但字面不同 —— 仍然必须失败。
  // 这条锁住“不得引入近义词表或语义相似度”这个边界。
  const { value, candidate } = candidateWithOutline(["开场", "她决定留下来帮忙", "后果", "亲手解决", "关系兑现"]);
  candidate.keyChoice = "她选择留下来帮忙";
  candidate.climax = "亲手解决";
  candidate.emotionalPayoff = "关系兑现";
  assert.throws(() => ensureOutputContract(value, "themeVariants"), OutputContractError);
});
