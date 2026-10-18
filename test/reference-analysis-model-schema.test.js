import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import {
  REFERENCE_ANALYSIS_MODEL_SCHEMA_NAME,
  referenceAnalysisModelSchema
} from "../src/contracts/reference-analysis-model-schema.js";
import {
  FRAME_EVIDENCE_KEYS,
  OBSERVATION_FACT_KINDS,
  OBSERVATION_IMPORTANCE,
  OBSERVED_FACT_KEYS,
  VIDEO_EVIDENCE_KEYS
} from "../src/reconstruction-grounding.js";
import { REFERENCE_ANALYSIS_ARRAY_FIELDS, REFERENCE_ANALYSIS_FIELDS } from "../src/validation.js";
import { analysisEvidenceShape, analysisPrompt } from "../src/prompts.js";
import { mockAnalysis } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";

// 2026-10-18：参考片分析对 MiMo 发 json_schema 约束解码。没有严格 Schema 可派生：
// 服务端查的部分直接引用服务端常量，其余嵌套字段按提示词输出模板写，键集合与顺序由这里锁住。
// 见 docs/analysis-mimo-json-schema-2026-10-18.md。

const frames = [
  { timestamp: 0, dataUrl: "data:image/jpeg;base64,AA==" },
  { timestamp: 12, dataUrl: "data:image/jpeg;base64,AA==" },
  { timestamp: 24, dataUrl: "data:image/jpeg;base64,AA==" }
];
const video = { dataUrl: "data:video/mp4;base64,AAAA", mimeType: "video/mp4", size: 4 };
const videoInput = { frames, metadata: { name: "reference.mp4", duration: 96.269932, width: 1080, height: 1920 }, transcript: "字幕", video };
const frameInput = { frames, metadata: { name: "reference.mp4", duration: 24, width: 1080, height: 1920 }, transcript: "字幕" };

const sha = (text) => createHash("sha256").update(text).digest("hex");
const compile = (input) => new Ajv2020({ strict: false, allErrors: true }).compile(referenceAnalysisModelSchema(input));

// 提示词里「严格使用以下顶层结构：」之后那段 JSON 示例。
function promptTemplate(input) {
  const prompt = analysisPrompt(input);
  const start = prompt.indexOf("{", prompt.indexOf("严格使用以下顶层结构："));
  let depth = 0;
  for (let index = start; index < prompt.length; index += 1) {
    if (prompt[index] === "{") depth += 1;
    if (prompt[index] === "}") depth -= 1;
    if (depth === 0) return JSON.parse(prompt.slice(start, index + 1));
  }
  throw new Error("提示词里没有找到输出模板");
}

function walk(node, visit, path = "$") {
  visit(node, path);
  for (const [field, child] of Object.entries(node.properties || {})) walk(child, visit, `${path}.${field}`);
  if (node.items) walk(node.items, visit, `${path}[]`);
}

// 模板里写了示例项的数组逐项比键；写成 [] 的只要求 Schema 也是数组。
function assertMatchesTemplate(templateValue, schema, path) {
  if (Array.isArray(templateValue)) {
    assert.equal(schema.type, "array", `${path} 应为数组`);
    if (templateValue.length) assertMatchesTemplate(templateValue[0], schema.items, `${path}[]`);
    return;
  }
  if (templateValue && typeof templateValue === "object") {
    assert.equal(schema.type, "object", `${path} 应为对象`);
    assert.deepEqual(Object.keys(schema.properties), Object.keys(templateValue), `${path} 的键与模板不一致`);
    assert.deepEqual(schema.required, Object.keys(templateValue), `${path} 的 required 与模板不一致`);
    assert.equal(schema.additionalProperties, false, `${path} 必须禁止多余键`);
    for (const [key, value] of Object.entries(templateValue)) assertMatchesTemplate(value, schema.properties[key], `${path}.${key}`);
    return;
  }
  const expected = typeof templateValue === "number" ? ["number", "integer"] : ["string"];
  assert.ok(expected.includes(schema.type), `${path} 类型 ${schema.type} 与模板示例不符`);
}

test("分析提示词逐字未变（golden，抽出 analysisEvidenceShape 之前算出）", () => {
  assert.equal(sha(analysisPrompt(videoInput)), "ed000638a2deecb6760bfe155d74ec07a5dcac3c06f9be675a2543ad1634dce7");
  assert.equal(sha(analysisPrompt({ frames, metadata: { name: "reference.mp4" }, transcript: "", video })), "608663a32fa41f774067bab9a4e898c86a29247f0aca4baa94e2c04d885aee72");
  assert.equal(sha(analysisPrompt(frameInput)), "5e74e8c63d43bf05bd4ec671b92ba208a36aa0df452b120d1a45d19e9cffc4f4");
  assert.equal(sha(analysisPrompt({ frames: [], metadata: {} })), "8ad52831d121d50744638896c7d277f3a05510bd49ae06389eb6a6a08b586bdf");
});

test("evidence 写法提示词与 Schema 共用一份：有原生视频写秒，没有写帧号", () => {
  assert.deepEqual(analysisEvidenceShape(videoInput), { source: "video", maxEndSecond: 97 });
  assert.deepEqual(analysisEvidenceShape(frameInput), { source: "frame", frameCount: 3 });
  assert.match(analysisPrompt(videoInput), /最大整数结束秒为 97/u);
});

test("顶层键、数组字段与服务端契约是同一份", () => {
  const schema = referenceAnalysisModelSchema(videoInput);
  assert.deepEqual(Object.keys(schema.properties), [...REFERENCE_ANALYSIS_FIELDS]);
  assert.deepEqual(schema.required, [...REFERENCE_ANALYSIS_FIELDS]);
  assert.equal(schema.additionalProperties, false);
  for (const field of REFERENCE_ANALYSIS_ARRAY_FIELDS) assert.equal(schema.properties[field].type, "array", field);
});

test("嵌套键集合与顺序逐个对上提示词模板（两种 evidence 写法都对）", () => {
  for (const input of [videoInput, frameInput]) {
    const template = promptTemplate(input);
    const schema = referenceAnalysisModelSchema(input);
    assert.deepEqual(Object.keys(template), Object.keys(schema.properties));
    for (const [key, value] of Object.entries(template)) assertMatchesTemplate(value, schema.properties[key], key);
  }
});

test("observedFacts 与 evidence 的键和枚举直接取服务端判据", () => {
  const facts = referenceAnalysisModelSchema(videoInput).properties.observedFacts.items;
  assert.deepEqual(facts.required, [...OBSERVED_FACT_KEYS]);
  assert.deepEqual(facts.properties.factType.enum, [...OBSERVATION_FACT_KINDS]);
  assert.deepEqual(facts.properties.importance.enum, [...OBSERVATION_IMPORTANCE]);
  assert.equal(facts.properties.observation.minLength, 1);
  assert.equal(facts.properties.evidenceRefs.minItems, 1);
  assert.deepEqual(facts.properties.evidenceRefs.items.required, [...VIDEO_EVIDENCE_KEYS]);
  const frameFacts = referenceAnalysisModelSchema(frameInput).properties.observedFacts.items;
  assert.deepEqual(frameFacts.properties.evidenceRefs.items.required, [...FRAME_EVIDENCE_KEYS]);
});

test("五处 evidence 与 observedFacts 用同一种证据对象", () => {
  const schema = referenceAnalysisModelSchema(videoInput);
  const reference = schema.properties.observedFacts.items.properties.evidenceRefs.items;
  const lists = [
    schema.properties.characters.items.properties.evidence,
    schema.properties.protagonistIdentity.properties.evidence,
    schema.properties.careRecipient.properties.evidence,
    schema.properties.emotionCurve.items.properties.evidence,
    schema.properties.retentionDrivers.items.properties.evidence
  ];
  for (const list of lists) assert.deepEqual(list, { type: "array", items: reference });
});

test("evidence 上限与服务端同一界限；取不到时长时不写不可满足的范围", () => {
  const videoRef = referenceAnalysisModelSchema(videoInput).properties.observedFacts.items.properties.evidenceRefs.items;
  assert.deepEqual(videoRef.properties.source, { type: "string", enum: ["video"] });
  assert.deepEqual(videoRef.properties.startSecond, { type: "integer", minimum: 0, maximum: 96 });
  assert.deepEqual(videoRef.properties.endSecond, { type: "integer", minimum: 1, maximum: 97 });

  const noDuration = referenceAnalysisModelSchema({ frames, metadata: {}, video });
  const unbounded = noDuration.properties.observedFacts.items.properties.evidenceRefs.items;
  assert.equal(Object.hasOwn(unbounded.properties.endSecond, "maximum"), false);
  assert.equal(Object.hasOwn(unbounded.properties.startSecond, "maximum"), false);

  const frameRef = referenceAnalysisModelSchema(frameInput).properties.observedFacts.items.properties.evidenceRefs.items;
  assert.deepEqual(frameRef.properties.source, { type: "string", enum: ["frame"] });
  assert.deepEqual(frameRef.properties.frameNumber, { type: "integer", minimum: 1, maximum: 3 });
});

test("只用 MiMo 上实测过的关键字，不写 pattern，不收紧内容", () => {
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "enum", "minimum", "maximum", "minLength"]);
  for (const input of [videoInput, frameInput]) {
    walk(referenceAnalysisModelSchema(input), (node, path) => {
      for (const keyword of Object.keys(node)) assert.ok(allowed.has(keyword), `${path} 出现 ${keyword}`);
      if (node.minLength !== undefined) assert.equal(path, "$.observedFacts[].observation", `${path} 不该加 minLength`);
    });
  }
});

test("演示数据的 observedFacts 过得了 frame 写法；10-18 那种数组里混进字符串被拒", () => {
  const analysis = mockAnalysis(frameInput);
  // 演示数据五处 evidence 写的是 "F1" 这类字符串（不走约束解码），这里换成证据对象再验结构其余部分。
  for (const item of [...analysis.characters, ...analysis.emotionCurve, ...analysis.retentionDrivers]) {
    item.evidence = [{ source: "frame", frameNumber: 1 }];
  }
  analysis.protagonistIdentity.evidence = [{ source: "frame", frameNumber: 2 }];
  analysis.careRecipient.evidence = [{ source: "frame", frameNumber: 3 }];
  const validate = compile(frameInput);
  assert.equal(validate(analysis), true, JSON.stringify(validate.errors));

  const broken = structuredClone(analysis);
  broken.retentionDrivers.push("whyWatchToEnd", "analysisConfidence：72,");
  assert.equal(validate(broken), false);

  const beyond = structuredClone(analysis);
  beyond.observedFacts[0].evidenceRefs = [{ source: "frame", frameNumber: 4 }];
  assert.equal(validate(beyond), false);
});

test("analyze 把 Schema 交给客户端；视频时间越界改用抽帧重取时换成 frame 写法", async () => {
  const calls = [];
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia(args) {
        calls.push(args);
        const analysis = mockAnalysis(videoInput);
        if (args.video) {
          args.onResolvedMediaMode?.("video");
          analysis.observedFacts.forEach((fact) => {
            fact.evidenceRefs = [{ source: "video", startSecond: 96, endSecond: 125 }];
          });
          return analysis;
        }
        args.onResolvedMediaMode?.("frames");
        return analysis;
      }
    }
  });

  await workflow.analyze(videoInput);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].responseSchema, {
    name: REFERENCE_ANALYSIS_MODEL_SCHEMA_NAME,
    schema: referenceAnalysisModelSchema(videoInput)
  });
  assert.deepEqual(calls[1].responseSchema, {
    name: REFERENCE_ANALYSIS_MODEL_SCHEMA_NAME,
    schema: referenceAnalysisModelSchema({ ...videoInput, video: null })
  });
  assert.deepEqual(calls[1].responseSchema.schema.properties.observedFacts.items.properties.evidenceRefs.items.required, [...FRAME_EVIDENCE_KEYS]);
});
