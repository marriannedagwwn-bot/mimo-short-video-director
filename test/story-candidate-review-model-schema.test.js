import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  STORY_CANDIDATE_REVIEW_CHECK_MODEL_FIELD_ORDER,
  STORY_CANDIDATE_REVIEW_MODEL_FIELD_ORDER,
  STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME,
  storyCandidateReviewModelSchema
} from "../src/contracts/story-candidate-review-model-schema.js";
import { storyCandidateReviewStrictSchema, validateStoryCandidateReviewStrict } from "../src/contracts/contract-validator.js";
import { deriveStoryCandidateProjections, ensureOutputContract, ensureStoryCandidateReviewCoversCandidates } from "../src/validation.js";
import { mockStoryCandidateReview, mockVariants } from "../src/mock.js";
import { storyCandidateReviewPrompt } from "../src/prompts.js";
import { WorkflowService } from "../src/workflow.js";

// 2026-09-24：候选对照评审（展开前体检复用它）对 MiMo 发 json_schema 约束解码，与候选阶段同一个做法。
// 起因是 MiMo 开思考两次都在 candidateChecks 数组里写出孤立字符串 "holisticPreferenceOrder:["，
// 第一次还把 dominantDefect.type 写成枚举外的 contradiction。见 docs/variants-mimo-format-2026-09-24.md。

const REPORT_DERIVED = ["scoreOrder", "recommendedWinner", "runnerUp", "rejectOrRegenerate"];
const CHECK_DERIVED = ["overallScore", "tier", "scoreBasedVerdict", "effectiveVerdict", "verdictOverrideReasons"];

function walk(value, visit, path = "") {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, visit, `${path}/${index}`));
  if (!value || typeof value !== "object") return;
  visit(value, path);
  for (const [key, item] of Object.entries(value)) walk(item, visit, `${path}/${key}`);
}

function compile(count) {
  return new Ajv2020({ strict: false, allErrors: true }).compile(storyCandidateReviewModelSchema(count));
}

function candidates(count) {
  const input = { creatorProfile: { fixedCharacter: "小白子，猫耳少女", vertical: "治愈日常" }, count };
  return mockVariants(input).variants;
}

// 模型应当交回的样子：mock 报告就是按提示词模板写的，不含服务端派生字段。
function modelOutput(count) {
  return mockStoryCandidateReview(candidates(count));
}

test("给模型的 Schema 没有 pattern 与 const：pattern 在 MiMo 上会截断字符串，const 没实测过", () => {
  const schema = storyCandidateReviewModelSchema(4);
  walk(schema, (node, path) => {
    assert.equal(Object.hasOwn(node, "pattern"), false, `${path} 还有 pattern`);
    assert.equal(Object.hasOwn(node, "const"), false, `${path} 还有 const`);
  });
  assert.deepEqual(schema.$defs.nonEmptyString, { type: "string", minLength: 1 });
  assert.deepEqual(schema.properties.schemaVersion, { type: "string", enum: ["story-candidate-review/1.0"] });
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$id, undefined);
  // 严格 Schema 本身不受影响。
  const strict = storyCandidateReviewStrictSchema();
  assert.equal(strict.$defs.nonEmptyString.pattern, "\\S");
  assert.equal(strict.properties.schemaVersion.const, "story-candidate-review/1.0");
  assert.equal(STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME, "story_candidate_review");
});

test("服务端派生的字段不在模型 Schema 里", () => {
  const schema = storyCandidateReviewModelSchema(4);
  for (const field of REPORT_DERIVED) assert.equal(Object.hasOwn(schema.properties, field), false, field);
  for (const field of CHECK_DERIVED) {
    assert.equal(Object.hasOwn(schema.$defs.candidateCheck.properties, field), false, field);
  }
  assert.deepEqual(schema.required, storyCandidateReviewStrictSchema().required);
  assert.deepEqual(schema.$defs.candidateCheck.required, storyCandidateReviewStrictSchema().$defs.candidateCheck.required);
});

test("逐个评的条数与整体偏好序长度锁死为候选数", () => {
  for (const count of [1, 2, 4, 6]) {
    const { properties } = storyCandidateReviewModelSchema(count);
    for (const field of ["candidateChecks", "holisticPreferenceOrder"]) {
      assert.equal(properties[field].minItems, count, field);
      assert.equal(properties[field].maxItems, count, field);
    }
  }
  assert.throws(() => storyCandidateReviewModelSchema(0), TypeError);
  assert.throws(() => storyCandidateReviewModelSchema(1.5), TypeError);
});

test("字段顺序与提示词输出模板一致（约束解码会按 Schema 顺序出字段）", () => {
  const schema = storyCandidateReviewModelSchema(2);
  assert.deepEqual(Object.keys(schema.properties), [...STORY_CANDIDATE_REVIEW_MODEL_FIELD_ORDER]);
  assert.deepEqual(Object.keys(schema.$defs.candidateCheck.properties), [...STORY_CANDIDATE_REVIEW_CHECK_MODEL_FIELD_ORDER]);
  const prompt = storyCandidateReviewPrompt(candidates(2), { scenes: [] });
  const template = prompt.slice(prompt.lastIndexOf("## 输出"));
  // 逐个向后找：sourceScaffoldOverlap 里也有一个 "why"，从头找会先撞上它。
  for (const order of [STORY_CANDIDATE_REVIEW_MODEL_FIELD_ORDER, STORY_CANDIDATE_REVIEW_CHECK_MODEL_FIELD_ORDER]) {
    let cursor = 0;
    for (const field of order) {
      const position = template.indexOf(`"${field}":`, cursor);
      assert.ok(position >= cursor, `模板里 ${field} 不在前一个字段之后`);
      cursor = position;
    }
  }
});

test("合法的模型输出能通过；今天观察到的结构失败都被挡住", () => {
  const validate = compile(2);
  const ok = modelOutput(2);
  assert.equal(validate(ok), true, JSON.stringify(validate.errors));

  const cases = {
    // 09-24 展开前体检两次都是这个形状。
    数组里的孤立字符串: (value) => { value.candidateChecks.splice(1, 0, "holisticPreferenceOrder:["); },
    枚举外的缺陷类型: (value) => { value.candidateChecks[0].dominantDefect.type = "contradiction"; },
    漏写顶层字段: (value) => { delete value.summary; },
    多评一个候选: (value) => { value.candidateChecks.push(structuredClone(value.candidateChecks[0])); },
    偏好序漏一个: (value) => { value.holisticPreferenceOrder.pop(); },
    多出空键: (value) => { value.candidateChecks[0].coreInteraction.note = ""; },
    输出派生字段: (value) => { value.candidateChecks[0].overallScore = 8; },
    空字符串: (value) => { value.summary = ""; },
    证据引用超过两条: (value) => { value.candidateChecks[0].dimensions[0].evidenceRefs = ["a", "b", "c"]; }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const value = structuredClone(ok);
    mutate(value);
    assert.equal(validate(value), false, label);
  }
});

test("约束解码只是减少结构失败：全空白字符串能过解码 Schema，但仍被严格 Schema 拦下", () => {
  const value = modelOutput(2);
  value.summary = "  ";
  assert.equal(compile(2)(value), true);
  const result = validateStoryCandidateReviewStrict(value);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.path === "/summary"));
});

test("严格 Schema 结构变了时派生直接报错，不静默跳过", () => {
  const newTopField = storyCandidateReviewStrictSchema();
  newTopField.properties.brandNewField = { type: "string" };
  assert.throws(() => storyCandidateReviewModelSchema(2, newTopField), /brandNewField/u);

  const newCheckField = storyCandidateReviewStrictSchema();
  newCheckField.$defs.candidateCheck.properties.brandNewCheck = { type: "string" };
  assert.throws(() => storyCandidateReviewModelSchema(2, newCheckField), /brandNewCheck/u);

  const noDerived = storyCandidateReviewStrictSchema();
  delete noDerived.$defs.candidateCheck.properties.tier;
  assert.throws(() => storyCandidateReviewModelSchema(2, noDerived), /tier/u);

  const requiredDerived = storyCandidateReviewStrictSchema();
  requiredDerived.required.push("scoreOrder");
  assert.throws(() => storyCandidateReviewModelSchema(2, requiredDerived), /scoreOrder/u);

  const noConst = storyCandidateReviewStrictSchema();
  noConst.properties.schemaVersion = { type: "string" };
  assert.throws(() => storyCandidateReviewModelSchema(2, noConst), /schemaVersion/u);
});

test("评审调用把 Schema 交给客户端，重试也带着；提示词不变", async () => {
  const themeVariants = deriveStoryCandidateProjections({ variants: candidates(2) });
  const input = { themeVariants, sourceScriptReconstruction: { scenes: [] } };
  const good = mockStoryCandidateReview(themeVariants.variants);
  const broken = structuredClone(good);
  broken.holisticPreferenceOrder = [broken.holisticPreferenceOrder[0]];
  const calls = [];
  const client = {
    async generateJson(request) {
      calls.push(request);
      return calls.length === 1 ? broken : good;
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    stageDefaults: {
      storyCandidateReview: { provider: "MiMo", model: "test-model", maxCompletionTokens: 8192, requestTimeoutMs: null }
    }
  });
  const result = await workflow.createStoryCandidateReview(input);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.responseSchema.name, STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME);
    assert.deepEqual(call.responseSchema.schema, storyCandidateReviewModelSchema(2));
  }
  assert.equal(calls[0].prompt, storyCandidateReviewPrompt(themeVariants.variants, { scenes: [] }));
  // 服务端派生照常发生，与没有 Schema 时一样。
  assert.ok(Array.isArray(result.review.scoreOrder));
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(structuredClone(good), "storyCandidateReview"),
    themeVariants.variants
  ));
});
