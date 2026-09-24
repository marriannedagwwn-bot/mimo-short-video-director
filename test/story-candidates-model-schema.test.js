import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  STORY_CANDIDATE_MODEL_FIELD_ORDER,
  STORY_CANDIDATES_MODEL_SCHEMA_NAME,
  storyCandidatesModelSchema
} from "../src/contracts/story-candidates-model-schema.js";
import { storyCandidatesStrictSchema, validateStoryCandidatesStrict } from "../src/contracts/contract-validator.js";
import { VARIANT_SOURCE_FIELDS } from "../src/variant-source-baseline.js";
import { mockAnalysis, mockBrief, mockReconstruction, mockVariants } from "../src/mock.js";
import { variantsCount, variantsPrompt } from "../src/prompts.js";

// 2026-09-24：候选阶段对 MiMo 发 json_schema 约束解码。给模型的 Schema 从严格 Schema 派生，
// 只做模型那一侧必需的变换；严格 Schema 与全部校验不变。见 docs/variants-mimo-format-2026-09-24.md。

const DERIVED = ["keyChoice", "climax", "emotionalPayoff"];

function walk(value, visit, path = "") {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, visit, `${path}/${index}`));
  if (!value || typeof value !== "object") return;
  visit(value, path);
  for (const [key, item] of Object.entries(value)) walk(item, visit, `${path}/${key}`);
}

function compile(count) {
  return new Ajv2020({ strict: false, allErrors: true }).compile(storyCandidatesModelSchema(count));
}

// 模型在 deriveSource 路径上应当交回的样子：没有 source，没有服务端派生字段。
function modelOutput(count) {
  const input = { creatorProfile: { fixedCharacter: "小白子，猫耳少女", vertical: "治愈日常" }, count };
  const upstream = { referenceAnalysis: mockAnalysis(input), sourceScriptReconstruction: mockReconstruction(input) };
  const raw = mockVariants({ ...input, ...upstream, creativeBrief: mockBrief({ ...input, ...upstream }) });
  for (const variant of raw.variants) {
    for (const field of DERIVED) delete variant[field];
    for (const field of VARIANT_SOURCE_FIELDS) delete variant.transformationProof[field].source;
  }
  return raw;
}

test("给模型的 Schema 没有 pattern：MiMo 把 pattern 当全串匹配，会把字符串截成一个字符", () => {
  const schema = storyCandidatesModelSchema(4);
  walk(schema, (node, path) => assert.equal(Object.hasOwn(node, "pattern"), false, `${path} 还有 pattern`));
  assert.deepEqual(schema.$defs.nonEmptyString, { type: "string", minLength: 1 });
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$id, undefined);
  // 严格 Schema 本身不受影响，仍用 pattern 拦全空白字符串。
  assert.equal(storyCandidatesStrictSchema().$defs.nonEmptyString.pattern, "\\S");
});

test("transformationProof 五项只要 replacement，不允许 source；三个派生字段不存在", () => {
  const schema = storyCandidatesModelSchema(4);
  const candidate = schema.$defs.storyCandidate;
  for (const field of VARIANT_SOURCE_FIELDS) {
    assert.deepEqual(candidate.properties.transformationProof.properties[field], { $ref: "#/$defs/replacementOnly" });
  }
  assert.deepEqual(schema.$defs.replacementOnly.required, ["replacement"]);
  assert.deepEqual(Object.keys(schema.$defs.replacementOnly.properties), ["replacement"]);
  assert.equal(schema.$defs.sourceReplacementPair, undefined);
  for (const field of DERIVED) {
    assert.equal(Object.hasOwn(candidate.properties, field), false, field);
    assert.equal(candidate.required.includes(field), false, field);
  }
});

test("候选个数锁死为 count，且与提示词用同一个取值规则", () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    const variants = storyCandidatesModelSchema(count).properties.variants;
    assert.equal(variants.minItems, count);
    assert.equal(variants.maxItems, count);
  }
  assert.equal(variantsCount({ count: 99 }), 6);
  assert.equal(variantsCount({}), 3);
  assert.throws(() => storyCandidatesModelSchema(0), TypeError);
  assert.throws(() => storyCandidatesModelSchema(2.5), TypeError);
});

test("字段顺序与提示词输出模板一致（约束解码会按 Schema 顺序出字段）", () => {
  const schema = storyCandidatesModelSchema(4);
  assert.deepEqual(Object.keys(schema.$defs.storyCandidate.properties), [...STORY_CANDIDATE_MODEL_FIELD_ORDER]);
  const prompt = variantsPrompt({ count: 4, creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" }, creativeBrief: {} },
    { deriveSource: true });
  const template = prompt.slice(prompt.indexOf("输出结构："));
  const inTemplate = STORY_CANDIDATE_MODEL_FIELD_ORDER.filter((field) => template.includes(`"${field}":`));
  // 可选的 emotionalMedium / endingRitual 不在模板里，其余全部都在。
  assert.deepEqual(STORY_CANDIDATE_MODEL_FIELD_ORDER.filter((field) => !inTemplate.includes(field)), ["emotionalMedium", "endingRitual"]);
  const positions = inTemplate.map((field) => template.indexOf(`"${field}":`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("合法的模型输出能通过；今天观察到的几种结构失败都被挡住", () => {
  const validate = compile(2);
  const ok = modelOutput(2);
  assert.equal(validate(ok), true, JSON.stringify(validate.errors));

  const cases = {
    多出空键: (value) => { value.variants[0].storyOutline[0].emotionalNote = ""; },
    数组里的孤立字符串: (value) => { value.variants.splice(1, 0, "originalityRiskCheck"); },
    多写一个候选: (value) => { value.variants.push(structuredClone(value.variants[0])); },
    压成字符串: (value) => { value.variants[0].transformationProof.changedCharacters = "主角换成小白子"; },
    带source: (value) => { value.variants[0].transformationProof.changedTask.source = "原片"; },
    输出派生字段: (value) => { value.variants[0].keyChoice = "关键选择"; },
    空字符串: (value) => { value.variants[0].title = ""; }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const value = structuredClone(ok);
    mutate(value);
    assert.equal(validate(value), false, label);
  }
});

test("可选键仍然是可选的：省略或写上都合法", () => {
  const validate = compile(2);
  const value = modelOutput(2);
  delete value.variants[0].characterSetup.careRecipient;
  delete value.variants[0].characterSetup.helper;
  delete value.variants[0].emotionalMedium;
  delete value.variants[0].endingRitual;
  value.variants[1].characterSetup.careRecipient = "邻居阿婆";
  value.variants[1].endingRitual = "一起吃刚洗好的果子";
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
});

test("约束解码只是减少结构失败：全空白字符串能过解码 Schema，但仍被严格 Schema 拦下", () => {
  const value = modelOutput(2);
  value.variants[0].title = "  ";
  assert.equal(compile(2)(value), true);
  const withServerFields = structuredClone(value);
  for (const variant of withServerFields.variants) {
    for (const field of DERIVED) variant[field] = "派生";
    for (const field of VARIANT_SOURCE_FIELDS) variant.transformationProof[field].source = "原片";
  }
  const result = validateStoryCandidatesStrict(withServerFields);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.path === "/variants/0/title"));
});

test("严格 Schema 结构变了时派生直接报错，不静默跳过", () => {
  const withoutPair = storyCandidatesStrictSchema();
  delete withoutPair.$defs.sourceReplacementPair;
  assert.throws(() => storyCandidatesModelSchema(4, withoutPair), /sourceReplacementPair/u);

  const newField = storyCandidatesStrictSchema();
  newField.$defs.storyCandidate.properties.brandNewField = { $ref: "#/$defs/nonEmptyString" };
  assert.throws(() => storyCandidatesModelSchema(4, newField), /brandNewField/u);

  const noDerived = storyCandidatesStrictSchema();
  delete noDerived.$defs.storyCandidate.properties.climax;
  assert.throws(() => storyCandidatesModelSchema(4, noDerived), /climax/u);
  assert.equal(STORY_CANDIDATES_MODEL_SCHEMA_NAME, "story_candidates");
});
