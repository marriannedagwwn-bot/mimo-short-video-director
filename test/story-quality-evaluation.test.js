import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  assert.equal(evaluationCase.caseDimensions.validationFailure.occurred, false);
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
