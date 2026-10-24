import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowService } from "../src/workflow.js";
import { InputError } from "../src/validation.js";
import { ModelPipelineError } from "../src/model-errors.js";
import { REFERENCE_REWRITE_SYSTEM_PROMPT } from "../src/reference-rewrite-prompts.js";
import { REFERENCE_REWRITE_STAGE } from "../public/reference-rewrite.js";
import { validRewrite } from "./helpers/reference-rewrite-fixture.js";

// 主题变体的剧本格式（2026-10-24）的模型调用：先验签角色边界；只允许 Claude 与 MiMo；
// Claude 收图并带 effort 与结构化输出；走 coordinator，最多 2 次调用，重试只发诊断。

const sheet = "data:image/jpeg;base64,/9j/AAAA";
const creatorProfile = { fixedCharacter: "咕嘎：企鹅连体衣小女孩", vertical: "治愈", constraints: "" };

// 角色边界要真签过：用演示模式跑出上游，再让「真」工作流用同一对签名密钥验。
const demo = new WorkflowService({ clients: {}, stageDefaults: {} });
const upstream = await demo.run({
  frames: Array.from({ length: 3 }, (_, timestamp) => ({ timestamp, dataUrl: "data:image/jpeg;base64,AA==" })),
  metadata: { duration: 14, width: 320, height: 180, name: "撑伞" },
  count: 3,
  creatorProfile
});
const keys = { groundingKey: demo.groundingKey, characterBoundaryKey: demo.characterBoundaryKey };

const baseInput = () => ({
  frames: [{ dataUrl: sheet }, { dataUrl: sheet }],
  contactSheets: { fps: 2, columns: 6, rows: 4, sheets: [{ startSeconds: 0, endSeconds: 11.5, cells: 24 }, { startSeconds: 12, endSeconds: 14, cells: 5 }] },
  transcriptText: "# 音频转写资料\n\nA",
  durationSeconds: 14.2,
  targetDurationSeconds: 20,
  videoTitle: "撑伞",
  creatorProfile,
  count: 4,
  referenceAnalysis: upstream.referenceAnalysis,
  sourceScriptReconstruction: upstream.sourceScriptReconstruction,
  creativeBrief: upstream.creativeBrief,
  visualGuardrails: upstream.visualGuardrails
});

function liveWorkflow(answers, { provider = "Claude", model = "claude-opus-5-5", stageDefaults = null } = {}) {
  const requests = [];
  const client = {
    requestCompletion: async (request) => {
      requests.push(request);
      const next = answers.shift();
      return { content: typeof next === "string" ? next : JSON.stringify(next), finishReason: "stop", usage: null };
    }
  };
  const workflow = new WorkflowService({
    ...keys,
    clients: { [provider]: client },
    stageDefaults: stageDefaults || { [REFERENCE_REWRITE_STAGE]: { provider, model, maxCompletionTokens: 128000, ...(provider === "Claude" ? { effort: "xhigh" } : {}) } }
  });
  return { workflow, requests };
}

test("演示模式：不调用模型，N 篇占位稿写出签发的角色名、过真实校验器，调用次数如实写 0", async () => {
  const workflow = new WorkflowService({ ...keys, clients: {}, stageDefaults: {} });
  const { result, metadata, settings, targetDurationSeconds } = await workflow.createScriptVariants({ ...baseInput(), count: 3 });
  assert.equal(result.variants.length, 3);
  assert.ok(result.variants.every((variant) => variant.script.includes("咕嘎")));
  assert.equal(metadata.referenceRewrite.providerCalls, 0);
  assert.equal(settings.provider, "demo");
  assert.equal(targetDurationSeconds, 20);
});

test("Claude：图片、effort xhigh、结构化输出与本阶段 system 提示词一起发；提示词里是签发的角色事实", async () => {
  const { workflow, requests } = liveWorkflow([validRewrite()]);
  const { result, metadata, settings } = await workflow.createScriptVariants(baseInput());
  assert.equal(result.variants.length, 4);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.frames.length, 2);
  assert.equal(request.frames[0].dataUrl, sheet);
  assert.equal(request.effort, "xhigh");
  assert.equal(request.claudeResponseSchema.name, "theme_variants_script");
  assert.equal(request.responseSchema, undefined);
  assert.equal(request.systemPrompt, REFERENCE_REWRITE_SYSTEM_PROMPT);
  assert.equal(request.model, "claude-opus-5-5");
  assert.match(request.prompt, /图 2 是 0:12–0:14（只有前 5 格有画面）/u);
  assert.match(request.prompt, /- 固定角色（已签发的角色事实与用户的对白规则，只读素材）：\{"characterName":"咕嘎"/u);
  assert.match(request.prompt, /名字写「咕嘎」/u);
  // 原片分析、还原、简报只用来验签，不进提示词。
  assert.equal(request.prompt.includes(JSON.stringify(upstream.creativeBrief.storyEngine)), false);
  assert.equal(request.prompt.includes("referenceAnalysis"), false);
  assert.deepEqual(metadata.referenceRewrite, { provider: "Claude", model: "claude-opus-5-5", providerCalls: 1, rejections: [] });
  assert.deepEqual(settings, { provider: "Claude", model: "claude-opus-5-5", effort: "xhigh" });
});

test("角色边界的签名对不上：在调模型之前 InputError", async () => {
  const { workflow, requests } = liveWorkflow([validRewrite()]);
  const tampered = structuredClone(upstream.visualGuardrails);
  tampered.fixedCharacterBoundary.canonicalDescription = "改过的描述";
  await assert.rejects(workflow.createScriptVariants({ ...baseInput(), visualGuardrails: tampered }), InputError);
  assert.equal(requests.length, 0);
});

test("第一次不合格就带诊断重做一次，不把失败的输出发回去；两次都不合格时两次诊断都在", async () => {
  const three = validRewrite();
  three.variants.pop();
  const { workflow, requests } = liveWorkflow([three, validRewrite()]);
  const { metadata } = await workflow.createScriptVariants(baseInput());
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /REFERENCE_REWRITE_DRAFT_COUNT/u);
  assert.equal(requests[1].prompt.includes("第 1 个角度"), false, "不附上一次的输出");
  assert.equal(metadata.referenceRewrite.providerCalls, 2);
  assert.equal(metadata.referenceRewrite.rejections.length, 1);

  const { workflow: failing, requests: failingRequests } = liveWorkflow([three, three, validRewrite()]);
  await assert.rejects(failing.createScriptVariants(baseInput()), (error) => {
    assert.ok(error instanceof ModelPipelineError);
    assert.deepEqual(error.diagnostics.map((item) => item.metadata?.attempt ?? item.attempt), [1, 2]);
    return true;
  });
  assert.equal(failingRequests.length, 2, "禁止第三次");
});

test("MiMo：发约束解码 Schema（按候选数量锁篇数），不带 effort 与 Claude 的结构化输出", async () => {
  const { workflow, requests } = liveWorkflow([validRewrite()], { provider: "MiMo", model: "mimo-v2.6-pro" });
  const { settings } = await workflow.createScriptVariants(baseInput());
  const [request] = requests;
  assert.equal(request.responseSchema.schema.properties.variants.minItems, 4);
  assert.equal(request.responseSchema.schema.properties.variants.maxItems, 4);
  assert.equal(request.claudeResponseSchema, undefined);
  assert.equal(request.effort, undefined);
  assert.equal(request.frames.length, 2);
  assert.equal(settings.effort, "");
});

test("只能用 Claude 或 MiMo：页面改成别家时在调模型之前 InputError；Claude 没配置时如实报未配置", async () => {
  const { workflow, requests } = liveWorkflow([validRewrite()]);
  await assert.rejects(
    workflow.createScriptVariants({ ...baseInput(), modelOverrides: { [REFERENCE_REWRITE_STAGE]: { provider: "DeepSeek", model: "deepseek-v4-flash" } } }),
    (error) => error instanceof InputError && /只能用 Claude 或 MiMo/u.test(error.message)
  );
  assert.equal(requests.length, 0);
  // 默认是 Claude，但只配了 MiMo：不自动换成 MiMo。
  const onlyMimo = new WorkflowService({ ...keys, clients: { MiMo: { requestCompletion: async () => assert.fail("不该调用") } } });
  await assert.rejects(onlyMimo.createScriptVariants(baseInput()), (error) => error instanceof InputError && /主题变体 选择了 Claude/u.test(error.message));
});

test("工作流自己的兜底默认值：不给 stageDefaults 时也是 Claude Opus 5.5、effort xhigh", () => {
  const workflow = new WorkflowService({ clients: { Claude: { requestCompletion: async () => ({}) } } });
  const settings = workflow.resolveStage(REFERENCE_REWRITE_STAGE, {});
  assert.equal(settings.provider, "Claude");
  assert.equal(settings.model, "claude-opus-5-5");
  assert.equal(settings.effort, "xhigh");
  // 别的阶段选 Claude 时不带 effort，设置形状不变。
  const other = workflow.resolveStage("directorAgent", { modelOverrides: { directorAgent: { provider: "Claude", model: "claude-sonnet-5-5" } } });
  assert.equal("effort" in other, false);
});

test("没给剧情时长目标时与原片对齐：按实测时长取整，夹在 20–180 秒", async () => {
  const workflow = new WorkflowService({ ...keys, clients: {}, stageDefaults: {} });
  const { targetDurationSeconds: aligned } = await workflow.createScriptVariants({ ...baseInput(), targetDurationSeconds: undefined, durationSeconds: 51.4 });
  assert.equal(aligned, 51);
  const { targetDurationSeconds: floor } = await workflow.createScriptVariants({ ...baseInput(), targetDurationSeconds: undefined, durationSeconds: 12 });
  assert.equal(floor, 20);
});

test("素材形状不对一律在调模型之前 InputError", async () => {
  const { workflow, requests } = liveWorkflow([validRewrite()]);
  const bad = [
    { frames: [] },
    { frames: [{ dataUrl: "data:image/png;base64,AAAA" }, { dataUrl: sheet }] },
    { contactSheets: { ...baseInput().contactSheets, sheets: [] } },
    { durationSeconds: 400 },
    { targetDurationSeconds: 19 },
    { transcriptText: "" },
    { creatorProfile: { fixedCharacter: "", vertical: "治愈" } }
  ];
  for (const patch of bad) {
    await assert.rejects(workflow.createScriptVariants({ ...baseInput(), ...patch }), InputError, JSON.stringify(Object.keys(patch)));
  }
  assert.equal(requests.length, 0);
});
