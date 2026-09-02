import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mockVariants } from "../src/mock.js";
import { deriveStoryCandidateProjections } from "../src/validation.js";
import {
  STORY_QUALITY_CASE_DIMENSIONS,
  STORY_QUALITY_RESULT_SCHEMA_VERSION,
  STORY_QUALITY_SUBJECTIVE_DIMENSIONS,
  buildStoryQualityEvaluation,
  saveStoryQualityEvaluation
} from "../scripts/story-quality-evaluation.mjs";

const fixtureUrl = new URL(
  "./fixtures/story-quality/story-candidates-phase1-baseline.json",
  import.meta.url
);

async function fixture() {
  return JSON.parse(await fs.readFile(fixtureUrl, "utf8"));
}

test("离线基线记录全部维度，但不给主观质量伪造分数", async () => {
  const input = await fixture();
  const result = buildStoryQualityEvaluation(input, {
    generatedAt: "2026-08-27T12:00:00.000Z"
  });

  assert.equal(result.schemaVersion, STORY_QUALITY_RESULT_SCHEMA_VERSION);
  assert.equal(result.methodology.externalModelCalls, 0);
  assert.equal(result.methodology.subjectiveScoring, "manual");
  assert.match(result.inputDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    Object.keys(result.rubric).sort(),
    [...STORY_QUALITY_SUBJECTIVE_DIMENSIONS, ...STORY_QUALITY_CASE_DIMENSIONS].sort()
  );

  const evaluationCase = result.cases[0];
  // 这份 fixture 是**冻结的 phase-1 基线**，冻结正是它作为人工评分对照的价值所在；
  // 改它的内容就毁掉了 before/after 比较。契约往前走之后它不再符合当前 contract，
  // 而 validationFailure 这个维度存在的意义就是如实记录这件事
  // （「用当前 contract 与结构校验器实际复验得到的失败记录」）。
  // 这里断言的是**记录得对不对**，不是这份样本合不合规。
  // 当前失败原因：phase-1 样本没有 narrativeMode——它是候选叙事路径声明，
  // 在这份基线录下来之后才加进契约。
  const failure = evaluationCase.caseDimensions.validationFailure;
  assert.equal(failure.occurred, true);
  assert.equal(failure.code, "STORY_CANDIDATES_SCHEMA_REQUIRED");
  assert.deepEqual(
    failure.diagnostics.map((diagnostic) => diagnostic.path),
    input.cases[0].storyCandidates.variants.map((_, index) => `/variants/${index}/narrativeMode`)
  );
  assert.deepEqual(evaluationCase.caseDimensions.tokenUsage, {
    available: false,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null
  });
  assert.equal(evaluationCase.candidateAssessments.length, input.cases[0].storyCandidates.variants.length);
  for (const candidate of evaluationCase.candidateAssessments) {
    assert.match(candidate.candidateDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(candidate.dimensions), STORY_QUALITY_SUBJECTIVE_DIMENSIONS);
    for (const dimension of Object.values(candidate.dimensions)) {
      assert.deepEqual(dimension, { status: "unscored", score: null, notes: "" });
    }
  }
});

test("符合当前契约的候选集在 harness 里复验干净", async () => {
  // 冻结基线已经不符合当前 contract，清洁路径的覆盖必须由一份当前样本承担，
  // 否则契约再变时这个 harness 的成功分支就没有测试盯着了。
  const input = await fixture();
  const creatorProfile = input.cases[0].creatorProfile;
  input.cases[0].storyCandidates = deriveStoryCandidateProjections(
    mockVariants({ creatorProfile, count: 4 })
  );
  const result = buildStoryQualityEvaluation(input, {
    generatedAt: "2026-08-27T12:00:00.000Z"
  });
  const failure = result.cases[0].caseDimensions.validationFailure;

  assert.equal(failure.occurred, false, failure.message || "");
  assert.equal(failure.code, null);
  assert.deepEqual(failure.diagnostics, []);
  assert.equal(result.cases[0].candidateAssessments.length, 4);
});

test("validationFailure 来自当前确定性 validator 的实际结果", async () => {
  const input = await fixture();
  input.cases[0].storyCandidates.variants = [];
  const result = buildStoryQualityEvaluation(input, {
    generatedAt: "2026-08-27T12:00:00.000Z"
  });
  const failure = result.cases[0].caseDimensions.validationFailure;

  assert.equal(failure.occurred, true);
  assert.equal(failure.code, "STORY_CANDIDATES_SCHEMA_MIN_ITEMS");
  assert.equal(failure.diagnostics[0]?.path, "/variants");
  assert.equal(result.cases[0].candidateAssessments.length, 0);
});

test("只记录 fixture 中真实存在的 token usage，缺失值不按零消耗处理", async () => {
  const input = await fixture();
  input.cases[0].generation.tokenUsage = {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150
  };
  const result = buildStoryQualityEvaluation(input, {
    generatedAt: "2026-08-27T12:00:00.000Z"
  });

  assert.deepEqual(result.cases[0].caseDimensions.tokenUsage, {
    available: true,
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150
  });
});

test("固定输入和固定时间产生可重复的摘要与结果", async () => {
  const input = await fixture();
  const options = { generatedAt: "2026-08-27T12:00:00.000Z" };
  assert.deepEqual(
    buildStoryQualityEvaluation(input, options),
    buildStoryQualityEvaluation(structuredClone(input), options)
  );
});

test("结果保存默认拒绝覆盖，显式 overwrite 才允许替换", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "story-quality-evaluation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "nested", "result.json");
  const result = buildStoryQualityEvaluation(await fixture(), {
    generatedAt: "2026-08-27T12:00:00.000Z"
  });

  assert.equal(await saveStoryQualityEvaluation(result, output), path.resolve(output));
  assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), result);
  await assert.rejects(
    () => saveStoryQualityEvaluation(result, output),
    (error) => error?.code === "EEXIST"
  );
  await assert.doesNotReject(
    saveStoryQualityEvaluation(result, output, { overwrite: true })
  );
});
