import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import {
  OutputContractError,
  ensureOutputContract,
  ensureStoryCandidateContract,
  deriveStoryCandidateProjections,
  deriveFullStoryTargetDuration
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

// keyChoice/climax/emotionalPayoff 由服务端从 storyOutline 按拍号派生，模型只标拍号。
// 此前要求模型逐字重复同一个长句，实测两极分布（多次 0/12，加强措辞后仍有 2/12 与 9/12），
// 失败模式是模型改写而非复制。派生消除整类失败，与 direct_shot 的处理一致。
function candidateWithOutline(actions, { keyChoiceBeat = 2, climaxBeat = 4 } = {}) {
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
  candidate.keyChoiceBeat = keyChoiceBeat;
  candidate.climaxBeat = climaxBeat;
  return { value, candidate };
}

const FIVE = ["开场", "作出选择", "选择的后果", "亲手解决", "关系兑现"];

test("服务端按拍号派生三个字段，模型不需要输出它们", () => {
  const { value, candidate } = candidateWithOutline(FIVE);
  delete candidate.keyChoice;
  delete candidate.climax;
  delete candidate.emotionalPayoff;
  const derived = deriveStoryCandidateProjections(value);
  assert.equal(ensureOutputContract(derived, "themeVariants"), derived);
  const out = derived.variants[0];
  assert.equal(out.keyChoice, "作出选择");
  assert.equal(out.climax, "亲手解决");
  assert.equal(out.emotionalPayoff, "关系兑现");
  // 派生不得原地修改输入
  assert.equal(candidate.keyChoice, undefined);
});

test("模型回显了错误字符串时被无条件覆盖，不报错", () => {
  const { value, candidate } = candidateWithOutline(FIVE);
  candidate.keyChoice = "模型自己改写的压缩摘要";
  candidate.climax = "另一版剧情";
  candidate.emotionalPayoff = "第三版剧情";
  const derived = deriveStoryCandidateProjections(value);
  assert.doesNotThrow(() => ensureOutputContract(derived, "themeVariants"));
  assert.equal(derived.variants[0].keyChoice, "作出选择");
  assert.equal(derived.variants[0].climax, "亲手解决");
  assert.equal(derived.variants[0].emotionalPayoff, "关系兑现");
});

test("emotionalPayoff 恒取最后一拍，不需要拍号", () => {
  const { value } = candidateWithOutline(["开场", "作出选择", "后果", "亲手解决", "最后一拍"]);
  assert.equal(deriveStoryCandidateProjections(value).variants[0].emotionalPayoff, "最后一拍");
});

test("拍号缺失、非整数或越界都明确失败", () => {
  for (const [bad, code] of [
    [undefined, "STORY_CANDIDATE_BEAT_INDEX_INVALID"],
    ["2", "STORY_CANDIDATE_BEAT_INDEX_INVALID"],
    [2.5, "STORY_CANDIDATE_BEAT_INDEX_INVALID"],
    [0, "STORY_CANDIDATE_BEAT_INDEX_OUT_OF_RANGE"],
    [99, "STORY_CANDIDATE_BEAT_INDEX_OUT_OF_RANGE"]
  ]) {
    const { value, candidate } = candidateWithOutline(FIVE);
    candidate.keyChoiceBeat = bad;
    assert.throws(
      () => deriveStoryCandidateProjections(value),
      (error) => hasDiagnostic(error, code, "/variants/0/keyChoiceBeat"),
      `keyChoiceBeat=${JSON.stringify(bad)} 应报 ${code}`
    );
  }
});

test("因果序：高潮拍必须晚于关键选择拍", () => {
  const early = candidateWithOutline(FIVE, { keyChoiceBeat: 4, climaxBeat: 2 });
  assert.throws(
    () => deriveStoryCandidateProjections(early.value),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER", "/variants/0/climaxBeat")
  );
});

// 「高潮必须早于最后一拍」规定的是故事形状而不是一致性：两者相同只会让
// climax 与 emotionalPayoff 取到同一个字符串，那是冗余不是矛盾。
// 实测模型两轮独立采样各产出 2 个「五拍、高潮收尾」候选，是成立的写法。
test("高潮拍落在最后一拍是合法结构，此时两个字段取到同一句话", () => {
  const { value } = candidateWithOutline(FIVE, { keyChoiceBeat: 2, climaxBeat: 5 });
  const derived = deriveStoryCandidateProjections(value);
  assert.doesNotThrow(() => ensureOutputContract(derived, "themeVariants"));
  assert.equal(derived.variants[0].climax, "关系兑现");
  assert.equal(derived.variants[0].emotionalPayoff, "关系兑现");
});

test("关键选择拍紧接高潮拍是合法结构，不用位置代理裁决剧作观点", () => {
  const { value } = candidateWithOutline(FIVE, { keyChoiceBeat: 2, climaxBeat: 3 });
  assert.doesNotThrow(() => ensureOutputContract(deriveStoryCandidateProjections(value), "themeVariants"));
});

test("入站复核发现字符串与拍号不符时失败（防篡改，签发路径必然通过）", () => {
  const { value } = candidateWithOutline(FIVE);
  const derived = deriveStoryCandidateProjections(value);
  derived.variants[0].climax = "被改过的高潮";
  assert.throws(
    () => ensureOutputContract(derived, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_PROJECTION_NOT_DERIVED", "/variants/0/climax")
  );
});

// targetDurationSeconds 与拍号同规格：可从同一 Artifact 内的其他内容唯一推导，
// 因此由服务端签发而不是模型独立编写。
test("Full Story 时长按场次跨度之和派生，覆盖模型声明值", () => {
  const story = {
    targetDurationSeconds: 60,
    sceneScript: [
      { timeRange: "00:00-00:15" },
      { timeRange: "00:15-00:35" },
      { timeRange: "00:35-00:53" }
    ]
  };
  const derived = deriveFullStoryTargetDuration(story);
  assert.equal(derived.targetDurationSeconds, 53);
  assert.equal(story.targetDurationSeconds, 60, "不得原地修改输入");
});

test("场次之间留白不计入时长：取跨度之和而不是首尾之差", () => {
  const withGap = {
    targetDurationSeconds: 60,
    sceneScript: [{ timeRange: "00:00-00:10" }, { timeRange: "00:20-00:30" }]
  };
  // 首尾之差是 30 秒，但留白不产生镜头，成片只有 20 秒。
  assert.equal(deriveFullStoryTargetDuration(withGap).targetDurationSeconds, 20);
});

test("时间轴不可解析时静默让出，由 direct_shot 骨架统一裁决", () => {
  const broken = { targetDurationSeconds: 60, sceneScript: [{ timeRange: "不是时间" }] };
  assert.equal(deriveFullStoryTargetDuration(broken).targetDurationSeconds, 60);
});
