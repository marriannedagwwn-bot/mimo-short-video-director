import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowService } from "../src/workflow.js";
import { mockAnalysis, mockBrief, mockReconstruction, mockVariants, mockVisualGuardrails } from "../src/mock.js";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { deriveStoryCandidateProjections, ensureOutputContract, materializeGlobalCharacterBoundaryViews, OutputContractError } from "../src/validation.js";
import { variantsPrompt, fullStoryPrompt } from "../src/prompts.js";
import { createVariantSourceBaseline, VARIANT_SOURCE_FIELDS } from "../src/variant-source-baseline.js";
import { variantSourceResponse } from "./helpers/variant-source-response.js";

function fixture(workflow, { fixedCharacter = "阿岚，社区修理师", legacy = false } = {}) {
  const input = {
    metadata: { duration: 45 },
    creatorProfile: { fixedCharacter, vertical: "治愈日常", constraints: "仅新角色可见的约束标记" },
    count: 2,
    targetDurationSeconds: 60,
    modelOverrides: { variants: { provider: "Qwen", model: "source-test-model", maxCompletionTokens: 4321, requestTimeoutMs: 543210 } }
  };
  if (!legacy) {
    input.referenceAnalysis = mockAnalysis(input);
    input.sourceScriptReconstruction = mockReconstruction(input);
  }
  input.creativeBrief = mockBrief(input);
  input.visualGuardrails = sealGlobalCharacterBoundary(
    materializeGlobalCharacterBoundaryViews(mockVisualGuardrails(input), input.creatorProfile),
    input, workflow.characterBoundaryKey
  );
  return input;
}

function withoutSources(batch) {
  const value = structuredClone(batch);
  for (const candidate of value.variants) for (const field of VARIANT_SOURCE_FIELDS) {
    delete candidate.transformationProof[field].source;
  }
  return value;
}

test("variants uses two calls with frozen settings and fills shared source without changing candidate content", async () => {
  const calls = [];
  const logged = [];
  let input;
  let raw;
  const writer = (scope) => ({ enabled: true, recordAttempt: async (value) => { logged.push({ scope, value }); } });
  const workflow = new WorkflowService({
    clients: { Qwen: { generateJson: async (request) => {
      calls.push(request);
      const selection = variantSourceResponse(request.prompt);
      const response = selection || raw;
      request.onCompletion?.({ content: JSON.stringify(response), providerName: "Qwen", model: request.model, usage: { total_tokens: 10 }, finishReason: "stop" });
      return structuredClone(response);
    } } },
    stageModelOutputLogWriters: new Map([
      ["variantSourceBaseline", writer("variantSourceBaseline")], ["variants", writer("variants")]
    ])
  });
  input = fixture(workflow);
  raw = mockVariants(input);
  for (const candidate of raw.variants) for (const field of VARIANT_SOURCE_FIELDS) {
    candidate.transformationProof[field].source = "不寻找旧照片中的大树，候选不得决定原片事实";
  }
  const frozenRaw = structuredClone(raw);
  const output = await workflow.createVariants(input);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.model, "source-test-model");
    assert.equal(call.maxCompletionTokens, 4321);
    assert.equal(call.requestTimeoutMs, 543210);
    assert.equal(call.strictJson, true);
    assert.equal(call.jsonRetryAttempts, 0);
  }
  assert.doesNotMatch(calls[0].prompt, /阿岚|仅新角色可见的约束标记/u);
  assert.match(calls[1].prompt, /不要输出 source/u);
  assert.match(calls[1].prompt, /51-69 秒/u);
  assert.deepEqual(raw, frozenRaw, "provider response remains unchanged");
  assert.deepEqual(withoutSources(output), withoutSources(deriveStoryCandidateProjections(raw)));
  const expected = createVariantSourceBaseline(input);
  expected.acceptSelections(variantSourceResponse(expected.prompt()));
  assert.deepEqual(output, deriveStoryCandidateProjections(expected.apply(raw)));
  for (const field of VARIANT_SOURCE_FIELDS) {
    assert.equal(output.variants[0].transformationProof[field].source, output.variants[1].transformationProof[field].source);
    assert.doesNotMatch(output.variants[0].transformationProof[field].source, /候选不得决定/u);
  }
  assert.deepEqual(logged.map((entry) => entry.scope), ["variantSourceBaseline", "variants"]);
  assert.ok(logged.every((entry) => entry.value.status === "succeeded"));
});

test("changing the new character cannot change the source prompt or derived source", async () => {
  let current;
  const sourcePrompts = [];
  const workflow = new WorkflowService({ clients: { Qwen: { generateJson: async ({ prompt }) => {
    const source = variantSourceResponse(prompt);
    if (source) { sourcePrompts.push(prompt); return source; }
    return mockVariants(current);
  } } } });
  current = fixture(workflow);
  const first = await workflow.createVariants(current);
  current = fixture(workflow, { fixedCharacter: "陆远，成年男性修表师" });
  const second = await workflow.createVariants(current);
  assert.equal(sourcePrompts[0], sourcePrompts[1]);
  for (const field of VARIANT_SOURCE_FIELDS) {
    assert.equal(first.variants[0].transformationProof[field].source, second.variants[0].transformationProof[field].source);
  }
  assert.notEqual(first.variants[0].characterSetup.protagonist, second.variants[0].characterSetup.protagonist);
});

for (const phase of ["source", "candidate", "missing-proof-dimension"]) {
  test(`variants ${phase} failure stops without retry or a partial result`, async () => {
    let calls = 0;
    let input;
    const workflow = new WorkflowService({ clients: { Qwen: { generateJson: async ({ prompt }) => {
      calls += 1;
      const source = variantSourceResponse(prompt);
      if (source) {
        if (phase === "source") source.selections[0].evidenceIds = ["unknown"];
        return source;
      }
      const candidate = mockVariants(input);
      if (phase === "candidate") candidate.extra = "must be rejected";
      else delete candidate.variants[0].transformationProof.changedTask;
      return candidate;
    } } } });
    input = fixture(workflow);
    await assert.rejects(() => workflow.createVariants(input), OutputContractError);
    assert.equal(calls, phase === "source" ? 1 : 2);
  });
}

test("legacy callers keep one call and the original prompt; demo uses no provider", async () => {
  let calls = 0;
  let captured;
  let legacy;
  const workflow = new WorkflowService({ clients: { Qwen: { generateJson: async ({ prompt }) => {
    calls += 1; captured = prompt; return mockVariants(legacy);
  } } } });
  legacy = fixture(workflow, { legacy: true });
  const result = await workflow.createVariants(legacy);
  assert.equal(calls, 1);
  assert.equal(captured, variantsPrompt(legacy));
  ensureOutputContract(result, "themeVariants");
  const demo = new WorkflowService();
  const demoInput = fixture(demo);
  const demoResult = await demo.createVariants(demoInput);
  ensureOutputContract(demoResult, "themeVariants");
  assert.equal(calls, 1);
});

test("Full Story excludes source comparisons and retains selected story facts", () => {
  const workflow = new WorkflowService();
  const input = fixture(workflow);
  const variant = mockVariants(input).variants[0];
  const prompt = fullStoryPrompt({ ...input, variant });
  assert.match(prompt, /来源证明、自评分与原片具体场次不作为本片剧情依据/u);
  assert.match(prompt, /当前候选 storyOutline\[\]\.action 是已选剧情的权威/u);
  assert.match(prompt, /必须保留原动作、参与者、物件用途、关键办法和结果承诺/u);
});

test("只有候选调用带约束解码 Schema；选源调用与旧调用点不带", async () => {
  // 2026-09-24：候选调用对 MiMo 发 json_schema。Schema 作为请求参数交给客户端，提示词文本不变。
  const calls = [];
  let input;
  const workflow = new WorkflowService({ clients: { Qwen: { generateJson: async (request) => {
    calls.push(request);
    return variantSourceResponse(request.prompt) || mockVariants(input);
  } } } });
  input = fixture(workflow);
  await workflow.createVariants(input);
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[0], "responseSchema"), false);
  assert.equal(calls[1].responseSchema.name, "story_candidates");
  assert.equal(calls[1].responseSchema.schema.properties.variants.minItems, input.count);
  assert.equal(calls[1].responseSchema.schema.properties.variants.maxItems, input.count);
  assert.equal(calls[1].prompt, variantsPrompt(input, { deriveSource: true }));

  const legacyCalls = [];
  let legacy;
  const legacyWorkflow = new WorkflowService({ clients: { Qwen: { generateJson: async (request) => {
    legacyCalls.push(request);
    return mockVariants(legacy);
  } } } });
  legacy = fixture(legacyWorkflow, { legacy: true });
  await legacyWorkflow.createVariants(legacy);
  assert.equal(legacyCalls.length, 1);
  assert.equal(Object.hasOwn(legacyCalls[0], "responseSchema"), false);
});
