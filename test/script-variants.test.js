import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WorkflowService } from "../src/workflow.js";
import { InputError } from "../src/validation.js";
import { analysisPrompt, reconstructionPrompt } from "../src/prompts.js";
import { groundingContextDigest } from "../src/reconstruction-grounding.js";
import { mockReferenceRewrite } from "../src/mock.js";
import { ensureReferenceRewriteContract, sealScriptThemeVariants } from "../src/reference-rewrite.js";
import {
  SCRIPT_VARIANT_SYSTEM_PROMPT,
  STORY_SCENE_SCRIPT_MARKER,
  storySceneScriptPrompt,
  variantScriptSceneScriptPrompt
} from "../src/story-entry-prompts.js";
import { storyboardDesignFromPlan } from "../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import { scriptVariantStoryText } from "../public/reference-rewrite.js";
import { frameStripMoreHtml, scriptVariantCardsHtml, scriptVariantOriginalHtml } from "../public/reference-rewrite-ui.js";
import { loadAppUi } from "./helpers/app-ui-harness.js";

const uiResponse = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });

// 参考片仿写接进 AI 导演（2026-10-24）：第一步的转写进分析与还原（并进封印），主题变体是 N 篇剧本，
// 选中一篇后按剧本拆场、4.0 分镜锁台词；旧格式候选才有的体检、评审与修订对剧本格式明确拒绝。

const sha = (text) => createHash("sha256").update(text).digest("hex");
const escape = (value) => String(value ?? "").replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
const creatorProfile = { fixedCharacter: "咕嘎：企鹅连体衣小女孩", vertical: "治愈", constraints: "" };
const media = {
  frames: Array.from({ length: 3 }, (_, timestamp) => ({ timestamp, dataUrl: "data:image/jpeg;base64,AA==" })),
  metadata: { duration: 45, width: 320, height: 180, name: "撑伞" }
};
const demo = new WorkflowService({ clients: {}, stageDefaults: {} });
const upstream = await demo.run({ ...media, count: 3, creatorProfile });
const keys = { groundingKey: demo.groundingKey, characterBoundaryKey: demo.characterBoundaryKey };
const themeVariants = sealScriptThemeVariants(
  ensureReferenceRewriteContract(mockReferenceRewrite({ characterName: "咕嘎", count: 3 }), { count: 3, characterName: "咕嘎" }),
  { materials: { fps: 2, frameCount: 90, sheetCount: 4, durationSeconds: 45, targetDurationSeconds: 45 }, model: { provider: "demo" } }
);
const scriptVariant = themeVariants.variants[1];
const storyInput = () => ({
  ...media, creatorProfile, ...upstream, themeVariants, variant: scriptVariant,
  fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 45
});

function liveWorkflow(reply) {
  const calls = [];
  const client = { requestCompletion: async (request) => {
    calls.push(request);
    const value = reply(request.prompt, request);
    return { content: JSON.stringify(value), finishReason: "stop", usage: null };
  } };
  const workflow = new WorkflowService({
    ...keys, clients: { Qwen: client },
    stageDefaults: { fullStory: { provider: "Qwen", model: "story-fixture" }, animationPlan: { provider: "Qwen", model: "plan-fixture" } }
  });
  return { workflow, calls };
}

test("自动转写只在有的时候进分析与还原的提示词；没有时两份提示词与封印摘要逐字不变", () => {
  const base = { ...media, transcript: "用户写的补充", referenceAnalysis: upstream.referenceAnalysis };
  const text = "# 音频转写资料\n\n```\n00:01.0–00:02.5  快进来\n```";
  assert.equal(analysisPrompt({ ...base, sourceTranscriptText: "" }), analysisPrompt(base));
  assert.equal(reconstructionPrompt({ ...base, sourceTranscriptText: "" }), reconstructionPrompt(base));
  const withTranscript = analysisPrompt({ ...base, sourceTranscriptText: text });
  assert.match(withTranscript, /- 用户补充的字幕\/对白\/背景：用户写的补充\n- 自动转写（去掉配乐后用 whisper 机器转写，不标说话人/u);
  assert.ok(withTranscript.includes(text));
  assert.ok(reconstructionPrompt({ ...base, sourceTranscriptText: text }).includes(`自动转写（去掉配乐后用 whisper 机器转写`));
  assert.equal(groundingContextDigest({ ...media, transcript: "", sourceTranscriptText: "" }), groundingContextDigest({ ...media, transcript: "" }));
  assert.notEqual(groundingContextDigest({ ...media, sourceTranscriptText: text }), groundingContextDigest(media));
});

test("还原核对分析的封印：自动转写换了就拒绝，同一份就通过", async () => {
  const text = "# 音频转写资料\n\nA";
  const workflow = new WorkflowService({ ...keys, clients: {}, stageDefaults: {} });
  const analysis = await workflow.analyze({ ...media, sourceTranscriptText: text });
  await assert.rejects(workflow.reconstruct({ ...media, referenceAnalysis: analysis, sourceTranscriptText: "# 别的转写" }), InputError);
  const reconstruction = await workflow.reconstruct({ ...media, referenceAnalysis: analysis, sourceTranscriptText: text });
  assert.ok(reconstruction.groundingSeal);
});

test("按剧本拆场的提示词：在粘贴故事那份上逐字替换，原文是这篇的标题加剧本，故事位写成这篇的编号", () => {
  const vg = upstream.visualGuardrails;
  const prompt = variantScriptSceneScriptPrompt({ creatorProfile, visualGuardrails: vg, variant: scriptVariant, targetDurationSeconds: 45 });
  assert.ok(prompt.startsWith(SCRIPT_VARIANT_SYSTEM_PROMPT));
  assert.ok(prompt.includes(STORY_SCENE_SCRIPT_MARKER));
  assert.ok(prompt.includes(`选中的剧本原文（本片唯一的剧情依据）：${JSON.stringify(scriptVariantStoryText(scriptVariant))}`));
  assert.ok(prompt.includes("**台词只能逐字取自剧本原文。**"));
  assert.ok(prompt.includes(`selectedVariantId 固定写 "V2"（选中的这一篇，服务端也会写成它）`));
  assert.equal(prompt.includes("用户故事原文"), false);
  assert.equal(prompt.includes("本次没有参考视频"), false);
  // 原片分析、还原与简报不进这一步：与粘贴故事同一份输入。
  const withUpstream = variantScriptSceneScriptPrompt({ ...upstream, creatorProfile, variant: scriptVariant, targetDurationSeconds: 45 });
  assert.equal(withUpstream, prompt);
  assert.equal(sha(prompt), "693719e473b2b1669576e626ba4d37409d81b823856b61e4ad366ff4021c157f");
  // 粘贴故事那份不受影响。
  const story = storySceneScriptPrompt({ creatorProfile, visualGuardrails: vg, storySource: { storyMode: "fullStoryText", storyText: "小满跑来。" }, targetDurationSeconds: 45 });
  assert.equal(story.includes("选中的剧本"), false);
  assert.throws(() => variantScriptSceneScriptPrompt({ creatorProfile, visualGuardrails: vg, variant: upstream.themeVariants.variants[0] }), /只用于剧本格式/u);
});

test("完整剧情（剧本变体）：按参考视频那一版验角色边界，selectedVariantId 是这篇的编号，模型回显不作数", async () => {
  const story = await new WorkflowService({ ...keys, clients: {}, stageDefaults: {} }).createFullStory(storyInput());
  assert.equal(story.selectedVariantId, "V2");
  const { workflow, calls } = liveWorkflow((prompt) => (prompt.includes("任务：整理本次 Full Story")
    ? mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(story, creatorProfile))
    : { ...story, selectedVariantId: "V7" }));
  const live = await workflow.createFullStory(storyInput());
  assert.equal(live.selectedVariantId, "V2");
  assert.ok(calls[0].prompt.includes(STORY_SCENE_SCRIPT_MARKER));
  assert.ok(calls[0].prompt.includes(JSON.stringify(scriptVariantStoryText(scriptVariant))));
  assert.equal(calls[0].systemPrompt, SCRIPT_VARIANT_SYSTEM_PROMPT);
  // 角色边界照旧按参考视频那一版验：没有签名的还原就拒绝。
  await assert.rejects(workflow.createFullStory({ ...storyInput(), sourceScriptReconstruction: {} }), InputError);
});

test("4.0 分镜：选中剧本变体时锁台词（与粘贴完整故事同一份提示词）", async () => {
  const offline = new WorkflowService({ ...keys, clients: {}, stageDefaults: {} });
  const fullStory = await offline.createFullStory(storyInput());
  const planInput = { ...storyInput(), fullStory, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false };
  const plan = await offline.createAnimationPlan(planInput);
  const { workflow, calls } = liveWorkflow((prompt) => {
    if (prompt.includes("任务：将完整 Full Story")) return storyboardDesignFromPlan(plan);
    if (prompt.includes("你是分镜修稿编辑")) return { strengths: [], guidance: ["合成意见"], items: [] };
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  });
  await workflow.createAnimationPlanWithMetadata(planInput);
  const design = calls.find((call) => call.prompt.includes("任务：将完整 Full Story")).prompt;
  assert.equal(design.includes("调整非核心对白"), false);
  assert.ok(design.includes("对白不可改"));
});

test("体检、评审、修订、剧情体检与按问题修改：遇到剧本格式的主题变体明确拒绝，不调模型", async () => {
  const workflow = new WorkflowService({ ...keys, clients: {}, stageDefaults: {} });
  const cases = [
    () => workflow.createStoryCandidateReview({ themeVariants }),
    () => workflow.createStoryCandidateRevision({ themeVariants, candidateId: "V2" }),
    () => workflow.createFullStoryPrecheck({ themeVariants, candidateId: "V2" }),
    () => workflow.createStoryQualityReview({ themeVariants, variant: scriptVariant }),
    () => workflow.createStoryQualityRepair({ themeVariants, variant: scriptVariant })
  ];
  for (const run of cases) {
    await assert.rejects(run(), (error) => error instanceof InputError && error.details[0]?.code === "SCRIPT_VARIANT_NOT_SUPPORTED");
  }
});

test("页面：剧本卡写方向、概要与可展开的剧本，按钮是「拆成完整剧情」；原片拆解在上；「+N」只在多出来时显示", () => {
  const cards = scriptVariantCardsHtml(themeVariants, { escape });
  assert.equal((cards.match(/data-story-variant=/gu) || []).length, 3);
  assert.match(cards, /拆成完整剧情 →/u);
  assert.match(cards, /<summary>看剧本<\/summary>/u);
  assert.match(cards, /data-script-variants-download/u);
  assert.equal(cards.includes("相似风险"), false);
  assert.match(scriptVariantOriginalHtml(themeVariants, { escape }), /原片拆解[\s\S]*原片好看在哪/u);
  assert.equal(frameStripMoreHtml({ total: 102, shown: 10, fps: 2, escape }), '<span class="frame-more" title="主题变体这一步会看 102 帧（每秒 2 帧）">+92</span>');
  assert.equal(frameStripMoreHtml({ total: 8, shown: 8, fps: 2, escape }), "");
});

test("页面：AI 导演六步，第一步是去配乐与转写；独立的参考片仿写按钮与四稿列表都去掉了", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const stages = [...html.matchAll(/<li data-stage="([a-z]+)">/gu)].map((match) => match[1]);
  assert.deepEqual(stages, ["transcript", "analysis", "script", "brief", "guardrails", "variants"]);
  assert.match(html, /<article class="result-card" id="transcriptResult"><\/article>\s*<article class="result-card" id="analysisResult">/u);
  assert.doesNotMatch(html, /runReferenceRewrite|referenceRewriteSection|referenceRewritePicker/u);
  // 分场页：剧本变体写「拆成」，旧格式候选照旧写「扩写成」，由 body.script-variant-mode 切换。
  assert.match(html, /<span class="video-only not-script-variant">把主题变体扩写成<\/span><span class="video-only script-variant-only">把选中的剧本拆成<\/span>/u);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.story-entry-mode \.pipeline li\[data-stage="transcript"\],/u);
  assert.match(css, /body:not\(\.script-variant-mode\) \.script-variant-only \{ display: none !important; \}/u);
});

test("页面：剧本变体点「生成完整剧情」直接签发选中记录再拆场，不做展开前体检；首页渲染剧本卡", async () => {
  const calls = [];
  const app = await loadAppUi({
    fetch: async (url, options) => {
      calls.push(url);
      if (url === "/api/production/artifact/commit") {
        return uiResponse({ lineage: { artifactId: "variant:V2", status: "current", revision: "r1", contentDigest: "variant:V2-digest" }, staleArtifactIds: [] });
      }
      if (url === "/api/tasks/create") throw new Error("停在建任务这一步");
      throw new Error(`unexpected ${url}`);
    }
  });
  for (const artifactId of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails", "themeVariants"]) {
    app.state.production.artifacts[artifactId] = { artifactId, status: "current", revision: "r1", contentDigest: `${artifactId}-digest` };
  }
  app.state.output = { ...app.state.output, themeVariants };
  app.state.selectedVariantId = "V2";
  app.state.fullStories = {};
  await app.startFullStory({ force: true });
  assert.equal(calls.includes("/api/full-story-precheck"), false);
  assert.ok(calls.includes("/api/production/artifact/commit"));
  app.renderVariants(themeVariants);
  assert.match(app.elements.variants.innerHTML, /THEME VARIANTS[\s\S]*原片拆解[\s\S]*拆成完整剧情/u);
  assert.equal(app.elements.variants.innerHTML.includes("对照原片体检候选"), false);
  app.renderStoryPage();
  assert.ok(app.document.body.classList.contains("script-variant-mode"));
  app.renderSelectedVariantSummary(scriptVariant);
  assert.match(app.elements.selectedVariantSummary.innerHTML, /V2 · SCRIPT[\s\S]*看剧本/u);
});
