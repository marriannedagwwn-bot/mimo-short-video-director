import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sseChunks, sseResponse } from "./helpers/sse-response.js";
import { variantSourceResponse } from "./helpers/variant-source-response.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowService } from "../src/workflow.js";
import { getConfig } from "../src/config.js";
import { ANALYSIS_OUTPUT_TOKEN_DEFAULT } from "../src/output-token-ceilings.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { CREATIVE_BRIEF_SCHEMA_VERSION, characterPromptBoundaryMismatch, ensureCharacterPromptMatchesBoundary, ensureCharacterReferenceMatchesBoundary, ensureFullStoryMatchesProfile, ensureOutputContract, ensureVisualGuardrailsMatchesProfile, extractFixedCharacterName, materializeGlobalCharacterBoundaryViews, normalizeGlobalCharacterBoundaryTerms } from "../src/validation.js";
import { buildRequestBody, MimoClient, ModelResponseError, parseModelJson } from "../src/mimo-client.js";
import { buildQwenRequestBody, isZhipuGlm53Model, modelAcceptsTemperature, qwenCompatibleProviderName, QwenClient } from "../src/qwen-client.js";
import { JimengImageClient, buildCharacterReferenceImagePrompt, buildJimengImageRequestBody } from "../src/jimeng-client.js";
import { RECONSTRUCTION_SYSTEM_PROMPT, SYSTEM_PROMPT, briefPrompt, characterReferenceRefinePrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "../src/prompts.js";
import { parseRunVideoArgs } from "../src/run-video-command.js";
import { generateShotVideo, shotVideoGenerationPromptText, ShotVideoConfigError, ShotVideoProviderError } from "../src/shot-video-generator.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { mimeTypeFor, selectSampleTimestamps } from "../src/video-file.js";
import { mockAnalysis, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "../src/mock.js";
import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";
import { groundingContextDigest, sealReconstruction } from "../src/reconstruction-grounding.js";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import { FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION } from "../src/full-story-beat-scene-postpass.js";
import { FullModelOutputLogWriter, MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { storyboardDesignFromPlan } from "../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";

const frames = Array.from({ length: 8 }, (_, index) => ({
  timestamp: index * 5,
  dataUrl: "data:image/jpeg;base64,AA=="
}));
const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});
const input = {
  frames,
  metadata: { name: "reference.mp4", duration: 40, width: 1080, height: 1920 },
  transcript: "",
  creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "家电维修", constraints: "60 秒内" },
  count: 3
};

function isFullStoryBeatScenePostpassPrompt(prompt = "") {
  return String(prompt).includes(FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION);
}

function fullStoryBeatScenePassResponse(story) {
  return {
    schemaVersion: FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION,
    status: "pass",
    reviews: story.beatSheet.map((beat, beatIndex) => ({
      beatIndex,
      beat: beat.beat,
      sceneIds: [story.sceneScript[Math.min(beatIndex, story.sceneScript.length - 1)].sceneId],
      verdict: "pass",
      issueCode: "none",
      beatEvidence: "",
      sceneEvidence: "",
      nextStateEvidence: "",
      reason: "",
      completionId: ""
    })),
    completions: []
  };
}

// creative_brief/2.0 下最常见的契约失败形状：模型把旧简报字段写回顶层。
function invalidBriefFixture(sentinel = "旧简报字段") {
  return { ...mockBrief(), contentType: sentinel };
}

function groundedUpstreamFixture(workflow) {
  const transcript = "00:00-00:01 输入素材中的可确认动作";
  const metadata = { duration: 1, width: 1080, height: 1920 };
  const reconstruction = mockReconstruction({ metadata, transcript, frames: [] });
  return {
    referenceAnalysis: {},
    sourceScriptReconstruction: sealReconstruction(
      reconstruction,
      workflow.groundingKey,
      groundingContextDigest({ transcript, metadata, frames: [], video: null })
    )
  };
}

function globalBoundaryContext(workflow, overrides = {}, boundary = null) {
  const grounded = overrides.referenceAnalysis && overrides.sourceScriptReconstruction
    ? {}
    : groundedUpstreamFixture(workflow);
  const context = { ...input, ...grounded, ...overrides };
  const rawGuardrails = mockVisualGuardrails(context);
  if (boundary) rawGuardrails.fixedCharacterBoundary = structuredClone(boundary);
  return sealBoundaryContext(workflow, context, rawGuardrails);
}

function sealBoundaryContext(workflow, context, rawGuardrails) {
  const materialized = materializeGlobalCharacterBoundaryViews(rawGuardrails, context.creatorProfile);
  return {
    ...context,
    visualGuardrails: sealGlobalCharacterBoundary(materialized, context, workflow.characterBoundaryKey)
  };
}

function boundaryTrait(canonicalName, terms, scope, evidenceLevel = "explicit") {
  return {
    canonicalName,
    terms: [...new Set([canonicalName, ...terms])],
    scope,
    evidenceLevel,
    triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: canonicalName }],
    reason: evidenceLevel === "inferred" ? "由视觉模型基于角色语义与常识推导。" : "用户设定明确要求。"
  };
}

function xiaobaiziBoundary({ tail = "required", forbidClaws = true } = {}) {
  const requiredTraits = [
    boundaryTrait("小白子", [], "identity"),
    boundaryTrait("狼耳", ["狼耳朵"], "appearance")
  ];
  const forbiddenTraits = [];
  const tailTrait = boundaryTrait("狼尾", ["狼尾巴", "尾巴"], "appearance", "inferred");
  if (tail === "required") requiredTraits.push(tailTrait);
  if (tail === "forbidden") forbiddenTraits.push({ ...tailTrait, reason: "用户明确否定尾巴，覆盖常识推导。" });
  if (forbidClaws) {
    forbiddenTraits.push(
      boundaryTrait("兽爪", ["狼爪", "猫爪", "肉垫"], "appearance", "inferred"),
      boundaryTrait("动物足", ["兽足", "四足"], "appearance", "inferred")
    );
  }
  forbiddenTraits.push(boundaryTrait("翅膀", ["羽翼"], "appearance", "inferred"));
  return {
    schemaVersion: "2.0",
    characterName: "小白子",
    canonicalDescription: "Q版狼耳少女，保持人形角色结构。",
    bodyForm: "人形少女，狼耳与狼尾为稳定外观特征。",
    requiredTraits,
    allowedTraits: [
      boundaryTrait("活泼可爱", [], "personality"),
      boundaryTrait("村里的热心帮手", [], "storyFunction")
    ],
    forbiddenTraits,
    unresolvedConflicts: []
  };
}

test("演示模式跑通完整工作流并分离角色边界与逐镜渲染负面提示词", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  assert.equal(workflow.mode, "demo");
  assert.ok(result.referenceAnalysis.whyWatchToEnd);
  assert.ok(result.sourceScriptReconstruction.scenes.length >= 4);
  assert.equal(result.creativeBrief.schemaVersion, CREATIVE_BRIEF_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(result.creativeBrief).sort(), ["recastTest", "schemaVersion", "storyEngine"]);
  assert.ok(result.visualGuardrails.positivePromptBoundary.length);
  assert.equal(Object.hasOwn(result.visualGuardrails, "commonNegativePrompt"), false);
  assert.match(JSON.stringify(result.visualGuardrails.stageInstructions), /themeVariants|positivePromptBoundary/);
  assert.equal(result.themeVariants.variants.length, 3);
});

test("演示角色边界不做本地关键词推断，只签发可确定的角色名", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，有狼尾巴，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子只用嗷呜表达"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const guardrails = ensureVisualGuardrailsMatchesProfile(ensureOutputContract(
    materializeGlobalCharacterBoundaryViews(
      mockVisualGuardrails({ ...input, creatorProfile, creativeBrief }),
      creatorProfile
    ),
    "visualGuardrails"
  ), creatorProfile);
  assert.deepEqual(guardrails.fixedCharacterBoundary.requiredTraits.map((trait) => trait.canonicalName), ["小白子"]);
  assert.match(guardrails.positivePromptBoundary[0].rule, /必须沿用：小白子/);
  assert.deepEqual(guardrails.positivePromptBoundary[0].triggerEvidence, [{
    sourcePath: "creatorProfile.fixedCharacter",
    evidence: creatorProfile.fixedCharacter
  }]);
  assert.equal(Object.hasOwn(guardrails, "forbiddenPositiveTraits"), false);
  assert.equal(Object.hasOwn(guardrails, "commonNegativePrompt"), false);
  assert.deepEqual(guardrails.fixedCharacterBoundary.allowedTraits, []);
  assert.deepEqual(guardrails.fixedCharacterBoundary.forbiddenTraits, []);
});

test("角色边界 prompt 明确分类规则且禁止生成全局渲染负面词", () => {
  const prompt = visualGuardrailsPrompt({
    referenceAnalysis: { storySynopsis: "企鹅服女孩执行送达任务" },
    sourceScriptReconstruction: { relationshipPattern: "信使连接被关爱对象" },
    creativeBrief: {
      protectedExpressions: [{ sourceExpression: "企鹅服", prohibition: "禁止企鹅形象", expressionType: "视觉元素", safeAlternativePrinciple: "只保留信使功能" }],
      controlledRewriteVariables: []
    },
    creatorProfile: {
      fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，有狼尾巴",
      vertical: "治愈日常",
      constraints: ""
    }
  });
  assert.match(prompt, /角色边界与创作规则审查 AI/);
  assert.match(prompt, /positivePromptBoundary/);
  assert.match(prompt, /sourceSimilarityRules/);
  assert.match(prompt, /dialogueRules/);
  assert.match(prompt, /对白词汇、发声内容和说话方式只能进入 dialogueRules/);
  assert.match(prompt, /不得同时进入 requiredTraits、allowedTraits 或 forbiddenTraits/);
  assert.match(prompt, /形象类似猫娘，有狼尾巴/);
  assert.match(prompt, /本阶段不生成图片或视频模型的最终负面提示词/);
  assert.match(prompt, /未声明只表示后续正向提示词不得擅自添加/);
  assert.match(prompt, /不得额外输出旧版字段/);
});

// 校验器要求 characterName 逐字等于 extractFixedCharacterName 的结果，提示词此前却从没说过这个名字，
// 也没说创作限制里的其它角色不属于这份边界。实测参考片是两个人并排、创作限制里又写着固定搭档时，
// 模型连续把名字写成「主角与搭档」，并把搭档的外观签成主角的必需特征。
const colonProfileWithPartner = {
  fixedCharacter: "小白子：浅灰蓝色长发，头顶有一个光环，性格：活泼可爱，懂事。",
  vertical: "日系/软萌/日常",
  constraints: "固定搭档「芙芙猫」：白色与浅蓝色相间的蓬松卷发，猫耳，浅蓝色尾巴的猫尾的小猫。"
};

function guardrailsRuleSection(prompt) {
  return prompt.slice(prompt.indexOf("判断规则："), prompt.indexOf("输出 visualGuardrails"));
}

test("角色边界 prompt 逐字给出校验器要核对的角色名，并把其它角色排除在边界之外", () => {
  const name = extractFixedCharacterName(colonProfileWithPartner.fixedCharacter);
  assert.equal(name, "小白子");
  const rules = guardrailsRuleSection(visualGuardrailsPrompt({ creativeBrief: {}, creatorProfile: colonProfileWithPartner }));
  assert.ok(rules.includes(`characterName 必须逐字写「${name}」`), "名字必须与校验器取名结果逐字相同");
  assert.match(rules, /只围绕「固定角色」这一栏里的这一个角色/u);
  assert.match(rules, /被称为固定搭档、宠物、家人或路人的角色）不属于这个边界/u);
  assert.match(rules, /不得写进 characterName、canonicalDescription 或 bodyForm/u);
  assert.match(rules, /外观与身体特征也不得写进 requiredTraits、allowedTraits、forbiddenTraits/u);
  assert.match(rules, /evidence 必须出自「固定角色」那一栏；出自创作限制的写 creatorProfile\.constraints/u);
  // 规则本身只写抽象形状：创作限制里的角色名只能出现在「创作限制：」那一行用户原文里。
  assert.equal(rules.includes("芙芙猫"), false);
});

test("固定角色文本取不出名字时，角色边界 prompt 不编一个名字让模型照写", () => {
  const creatorProfile = { ...colonProfileWithPartner, fixedCharacter: "（Q版）浅灰蓝色长发少女" };
  assert.equal(extractFixedCharacterName(creatorProfile.fixedCharacter), "");
  const rules = guardrailsRuleSection(visualGuardrailsPrompt({ creativeBrief: {}, creatorProfile }));
  assert.equal(rules.includes("characterName 必须逐字写"), false);
  assert.match(rules, /不属于这个边界/u);
});

test("Visual Guardrails 把搭档并进角色名时照旧拒绝签发，报错里带上模型实际写的名字", async () => {
  const creatorProfile = {
    ...colonProfileWithPartner,
    fixedCharacter: "小白子：q版狼耳少女，有狼尾巴，活泼可爱，村里的热心帮手"
  };
  const referenceAnalysis = {};
  let modelCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        modelCalls += 1;
        const result = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
        result.fixedCharacterBoundary = { ...xiaobaiziBoundary(), characterName: "小白子与芙芙猫" };
        return result;
      }
    }
  });
  const sourceScriptReconstruction = sealReconstruction(
    mockReconstruction(input),
    workflow.groundingKey,
    groundingContextDigest({
      transcript: input.transcript,
      metadata: input.metadata,
      frames: input.frames,
      video: null
    })
  );
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis, sourceScriptReconstruction });

  await assert.rejects(
    () => workflow.createVisualGuardrails({
      ...input,
      creatorProfile,
      referenceAnalysis,
      sourceScriptReconstruction,
      creativeBrief
    }),
    (error) => {
      assert.ok(error instanceof OutputContractError);
      assert.match(error.message, /未围绕固定角色「小白子」生成外观规则（characterName 写的是「小白子与芙芙猫」）/u);
      return true;
    }
  );
  assert.equal(modelCalls, 1);
});

// 演示数据此前有三份各自按逗号切名字、不认冒号的取名规则（角色边界、完整剧情、镜头计划），
// 「名字：描述」写法会一路签出「名字：描述前半句」这种角色名。整条链跑一遍，任何一份再分叉都会在这里失败。
test("演示模式按校验器同一规则取固定角色名，「名字：描述」写法能走完角色边界、完整剧情与镜头计划", async () => {
  const workflow = new WorkflowService();
  const context = { ...input, creatorProfile: colonProfileWithPartner };
  const upstream = await workflow.run(context);
  assert.equal(workflow.mode, "demo");
  const boundary = upstream.visualGuardrails.fixedCharacterBoundary;
  assert.equal(boundary.characterName, "小白子");
  assert.deepEqual(boundary.requiredTraits.map((trait) => trait.canonicalName), ["小白子"]);

  const variant = upstream.themeVariants.variants[0];
  const fullStory = await workflow.createFullStory({ ...context, ...upstream, variant });
  assert.equal(fullStory.characterBible.protagonist.name, "小白子");

  const animationPlan = await workflow.createAnimationPlan({
    ...context,
    ...upstream,
    variant,
    fullStory,
    animationPlanVersion: "4.0"
  });
  assert.equal(animationPlan.promptSchemaVersion, "4.0");
  assert.ok(animationPlan.characterReferencePrompts.some((reference) => reference.characterName === "小白子"));
});

test("Visual Guardrails 只推断一次并签发全局边界，用户改设定后旧边界失效", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子只用嗷呜表达"
  };
  const referenceAnalysis = {};
  const reconstruction = mockReconstruction(input);
  let variantCalls = 0;
  let guardrailCalls = 0;
  let capturedVariantPrompt = "";
  const rawGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  rawGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  rawGuardrails.fixedCharacterBoundary.requiredTraits[2].terms = ["狼尾巴", "尾巴"];
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        guardrailCalls += 1;
        return structuredClone(rawGuardrails);
      },
      async generateJson(args) {
        variantCalls += 1;
        const sourceResponse = variantSourceResponse(args.prompt);
        if (sourceResponse) return sourceResponse;
        capturedVariantPrompt = args.prompt;
        return mockVariants({ ...input, creatorProfile, count: 1 });
      }
    }
  });
  const sourceScriptReconstruction = sealReconstruction(
    reconstruction,
    workflow.groundingKey,
    groundingContextDigest({
      transcript: input.transcript,
      metadata: input.metadata,
      frames: input.frames,
      video: null
    })
  );
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis, sourceScriptReconstruction });
  const stageContext = {
    ...input,
    creatorProfile,
    referenceAnalysis,
    sourceScriptReconstruction,
    creativeBrief
  };

  const visualGuardrails = await workflow.createVisualGuardrails(stageContext);
  assert.equal(visualGuardrails.fixedCharacterBoundary.requiredTraits[2].canonicalName, "狼尾");
  assert.deepEqual(visualGuardrails.fixedCharacterBoundary.requiredTraits[2].terms, ["狼尾", "狼尾巴", "尾巴"]);
  assert.equal(visualGuardrails.fixedCharacterBoundary.requiredTraits[2].evidenceLevel, "inferred");
  assert.match(visualGuardrails.fixedCharacterBoundary.sourceDigest, /^sha256:/u);
  assert.ok(visualGuardrails.fixedCharacterBoundary.boundarySignature);
  assert.equal(guardrailCalls, 1);

  const variants = await workflow.createVariants({ ...stageContext, visualGuardrails, count: 1 });
  assert.equal(variants.variants.length, 1);
  assert.match(capturedVariantPrompt, /"canonicalName":"狼尾"/u);
  assert.equal(variantCalls, 2);

  await assert.rejects(
    () => workflow.createVariants({
      ...stageContext,
      creatorProfile: { ...creatorProfile, fixedCharacter: `${creatorProfile.fixedCharacter}，明确没有尾巴` },
      visualGuardrails,
      count: 1
    }),
    /全局角色边界与当前用户设定.*不匹配/u
  );
  assert.equal(variantCalls, 2);
});

test("Visual Guardrails 拒绝模型伪造服务端签发字段且不整包重生", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const referenceAnalysis = {};
  let modelCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        modelCalls += 1;
        const result = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
        result.fixedCharacterBoundary = {
          ...xiaobaiziBoundary(),
          sourceDigest: "sha256:forged-source",
          boundaryDigest: "sha256:forged-boundary",
          boundarySignature: "forged-signature"
        };
        return result;
      }
    }
  });
  const sourceScriptReconstruction = sealReconstruction(
    mockReconstruction(input),
    workflow.groundingKey,
    groundingContextDigest({
      transcript: input.transcript,
      metadata: input.metadata,
      frames: input.frames,
      video: null
    })
  );
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis, sourceScriptReconstruction });

  await assert.rejects(
    () => workflow.createVisualGuardrails({
      ...input,
      creatorProfile,
      referenceAnalysis,
      sourceScriptReconstruction,
      creativeBrief
    }),
    /签发字段只能由服务端生成/u
  );
  assert.equal(modelCalls, 1);
});

test("creativeBrief 2.0 只产出 storyEngine 与 recastTest，由服务端盖版本号", async () => {
  const workflow = new WorkflowService();
  const referenceAnalysis = await workflow.analyze(input);
  const sourceScriptReconstruction = await workflow.reconstruct({ ...input, referenceAnalysis });
  const creativeBrief = await workflow.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
  assert.equal(creativeBrief.schemaVersion, CREATIVE_BRIEF_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(creativeBrief).sort(), ["recastTest", "schemaVersion", "storyEngine"]);
});

test("creativeBrief 2.0 拒绝任何多余顶层键，包括模型自己写的 schemaVersion", () => {
  assert.doesNotThrow(() => ensureOutputContract(mockBrief(), "creativeBrief"));
  for (const key of ["contentType", "allowedNarrativeComponents", "uncertainties", "schemaVersion"]) {
    assert.throws(
      () => ensureOutputContract({ ...mockBrief(), [key]: "x" }, "creativeBrief"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => detail.code === "CREATIVE_BRIEF_UNEXPECTED_FIELD" && detail.path === `/${key}`)
    );
  }
  const { recastTest, ...missingRecast } = mockBrief();
  assert.throws(() => ensureOutputContract(missingRecast, "creativeBrief"), /缺少必要字段：recastTest/u);
});

test("主题变体同时提供结构保真与表达变换证明", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  for (const variant of result.themeVariants.variants) {
    assert.deepEqual(Object.keys(variant.experienceFidelity), ["positioning", "audience", "emotion", "plotDriver", "highValueBeats"]);
    assert.deepEqual(Object.keys(variant.transformationProof), ["changedCharacters", "changedTask", "changedDetailsAndProps", "changedDialogue", "changedVisualExpression"]);
    // 每个 changed* 都是 {source, replacement} 结构对：source 只写原片是什么，
    // 会被服务端回上游核对；replacement 只写本片改成什么。
    for (const field of Object.keys(variant.transformationProof)) {
      assert.deepEqual(Object.keys(variant.transformationProof[field]), ["source", "replacement"]);
      assert.ok(String(variant.transformationProof[field].source).trim());
      assert.ok(String(variant.transformationProof[field].replacement).trim());
    }
    for (const field of ["keyChoice", "climax", "emotionalPayoff", "novelty", "visualPotential"]) {
      assert.equal(typeof variant[field], "string");
      assert.ok(variant[field].trim());
    }
  }
});

test("选择主题变体后可用 mimo-v2.5-pro 生成完整剧情", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    oneLineHook: "阿岚必须在闭店前修好旧设备。",
    logline: "阿岚在暴雨停电中修复一段旧录音。",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  variant.oneLineHook = "VARIANT_ONLY_POSTPASS_SENTINEL";
  const story = mockFullStory({ ...input, creativeBrief, variant });
  const captured = [];
  const workflow = new WorkflowService({
    storyModel: "mimo-v2.5-pro",
    storyMaxCompletionTokens: 12345,
    client: {
      async generateJson(args) {
        captured.push(args);
        return isFullStoryBeatScenePostpassPrompt(args.prompt)
          ? fullStoryBeatScenePassResponse(story)
          : structuredClone(story);
      }
    }
  });
  const result = await workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, variant }));
  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.equal(request.model, "mimo-v2.5-pro");
    assert.equal(request.maxCompletionTokens, 12345);
    assert.equal(request.jsonRetryAttempts, 0);
    assert.equal(request.strictJson, true);
  }
  assert.match(captured[0].prompt, /VARIANT_ONLY_POSTPASS_SENTINEL/u);
  assert.doesNotMatch(captured[1].prompt, /VARIANT_ONLY_POSTPASS_SENTINEL/u);
  assert.match(captured[1].prompt, new RegExp(JSON.stringify(story.title), "u"));
  assert.equal(result.selectedVariantId, "V1");
  assert.ok(result.sceneScript.length >= 6);
  assert.match(result.characterBible.protagonist.identity, /阿岚/);
});

test("Full Story 后置审校只追加可唯一补全的 visibleAction 状态桥", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "灯笼归途",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "逐户送完六盏灯笼",
    emotionalMedium: "纸灯笼",
    environmentPressure: "天色渐暗",
    endingRitual: "回家放下空竹篓"
  };
  const story = mockFullStory({ ...input, creativeBrief, variant });
  story.beatSheet[0].storyAction =
    "阿岚背着装有六盏灯笼的竹篓逐户送灯笼。随后连续完成其余住户的灯笼交付，最后一盏交出后空竹篓清晰可见，她转身返家。";
  story.sceneScript[0].visibleAction = "阿岚背着装有六盏灯笼的竹篓沿石阶前行。";
  story.sceneScript[1].visibleAction = "阿岚取出一盏灯笼交给住户，随后继续前行。";
  story.sceneScript[2].visibleAction = "阿岚回到院子，把空竹篓放在门边。";
  const original = structuredClone(story);
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (!isFullStoryBeatScenePostpassPrompt(args.prompt)) return structuredClone(story);
        const response = fullStoryBeatScenePassResponse(story);
        response.status = "completed";
        response.reviews[0] = {
          beatIndex: 0,
          beat: story.beatSheet[0].beat,
          sceneIds: [story.sceneScript[0].sceneId, story.sceneScript[1].sceneId],
          verdict: "completed",
          issueCode: "unexplained_state_jump",
          beatEvidence: "最后一盏交出后空竹篓清晰可见",
          sceneEvidence: "取出一盏灯笼",
          nextStateEvidence: "空竹篓",
          reason: "分场只展示一盏交付，下一场却已经是空竹篓，缺少可见的任务完成桥。",
          completionId: "C1"
        };
        response.completions = [{
          completionId: "C1",
          targetSceneId: story.sceneScript[1].sceneId,
          field: "visibleAction",
          mode: "append",
          currentVisibleAction: story.sceneScript[1].visibleAction,
          addition: "随后连续完成其余住户的灯笼交付，最后一盏交出后空竹篓清晰可见，她转身返家。"
        }];
        return response;
      }
    }
  });

  const result = await workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, variant }));
  assert.equal(prompts.length, 2);
  assert.match(result.sceneScript[1].visibleAction, /最后一盏交出后空竹篓/u);
  const projected = structuredClone(result);
  projected.sceneScript[1].visibleAction = original.sceneScript[1].visibleAction;
  assert.deepEqual(projected, original);
});

test("Full Story 后置审校 blocked 时整次失败且不重试或回退首稿", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = mockVariants({ ...input, creativeBrief }).variants[0];
  const story = mockFullStory({ ...input, creativeBrief, variant });
  let calls = 0;
  const workflow = new WorkflowService({
    modelCallCoordinator: new ModelCallCoordinator({ maxProviderCalls: 4 }),
    client: {
      async generateJson(args) {
        calls += 1;
        if (!isFullStoryBeatScenePostpassPrompt(args.prompt)) return structuredClone(story);
        const response = fullStoryBeatScenePassResponse(story);
        response.status = "blocked";
        response.reviews[0] = {
          beatIndex: 0,
          beat: story.beatSheet[0].beat,
          sceneIds: [story.sceneScript[0].sceneId],
          verdict: "blocked",
          issueCode: "insufficient_internal_evidence",
          beatEvidence: story.beatSheet[0].storyAction.slice(0, 40),
          sceneEvidence: story.sceneScript[0].visibleAction.slice(0, 40),
          nextStateEvidence: "",
          reason: "仅靠当前 Full Story 无法唯一确定应追加的动作，不能猜测补全。",
          completionId: ""
        };
        return response;
      }
    }
  });

  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, variant })),
    /无法安全补全/u
  );
  assert.equal(calls, 2);
});

test("Full Story 初轮 completion retry 成功后只执行一次 postpass，总调用严格为三次", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = mockVariants({ ...input, creativeBrief }).variants[0];
  const story = mockFullStory({ ...input, creativeBrief, variant });
  const prompts = [];
  const workflow = new WorkflowService({
    modelCallCoordinator: new ModelCallCoordinator({ maxProviderCalls: 4 }),
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (prompts.length === 1) {
          throw new ModelResponseError(
            "模型必须返回严格 JSON，首次响应未闭合",
            "{\"selectedVariantId\":",
            0,
            { code: "MODEL_JSON_OBJECT_REQUIRED" }
          );
        }
        if (isFullStoryBeatScenePostpassPrompt(args.prompt)) {
          return fullStoryBeatScenePassResponse(story);
        }
        return structuredClone(story);
      }
    }
  });

  const result = await workflow.createFullStory(
    globalBoundaryContext(workflow, { creativeBrief, variant })
  );
  assert.deepEqual(result, story);
  assert.equal(prompts.length, 3);
  assert.equal(isFullStoryBeatScenePostpassPrompt(prompts[0]), false);
  assert.equal(isFullStoryBeatScenePostpassPrompt(prompts[1]), false);
  assert.equal(isFullStoryBeatScenePostpassPrompt(prompts[2]), true);
});

test("Full Story 全量输出 observer 使用旁路 Production trace，且 trace 不进入 Prompt 或 Artifact", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const story = mockFullStory({ ...input, creativeBrief, variant });
  const content = JSON.stringify(story);
  const reviewContent = JSON.stringify(fullStoryBeatScenePassResponse(story));
  const observed = [];
  const providerPrompts = [];
  let providerCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async requestCompletion(request) {
        providerCalls += 1;
        providerPrompts.push(request.prompt);
        const responseContent = providerCalls === 1 ? content : reviewContent;
        return {
          content: responseContent,
          raw: JSON.stringify({ choices: [{ message: { content: responseContent } }] }),
          requestId: `provider-request-${providerCalls}`,
          finishReason: "stop",
          usage: { total_tokens: 42 }
        };
      }
    },
    fullModelOutputLogWriter: {
      enabled: true,
      async recordAttempt(value) {
        observed.push(value);
      }
    }
  });
  const traceContext = {
    verified: true,
    projectId: "project-a",
    runId: "run-a",
    artifactId: "fullStory:V1",
    productionRequestId: "production-request-1"
  };
  const result = await workflow.createFullStory(
    globalBoundaryContext(workflow, { creativeBrief, variant }),
    { traceContext }
  );

  assert.equal(observed.length, 2);
  assert.equal(observed[0].content, content);
  assert.equal(observed[0].providerRequestId, "provider-request-1");
  assert.equal(observed[1].content, reviewContent);
  assert.equal(observed[1].providerRequestId, "provider-request-2");
  assert.deepEqual(observed.map((attempt) => attempt.stage), [
    "fullStory",
    "fullStoryBeatScenePostpass"
  ]);
  for (const attempt of observed) {
    assert.equal(attempt.context.productionRequestId, "production-request-1");
    assert.equal(attempt.context.variantId, "V1");
  }
  for (const providerPrompt of providerPrompts) {
    assert.doesNotMatch(providerPrompt, /production-request-1|project-a|run-a/u);
  }
  assert.equal(Object.hasOwn(result, "traceContext"), false);
  assert.deepEqual(result, story);
});

test("完整剧情和动画生产包可切换到 Qwen，同时保留 MiMo 基础客户端", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const story = mockFullStory({ ...input, creativeBrief, variant });
  const calls = [];
  // 4.0 自主分镜各步的预置响应，在下面用同一把签名密钥的演示模式算出来。
  let storyboardResponses = null;
  const mimoClient = {
    async generateJson() {
      throw new Error("fullStory/animationPlan 不应调用 MiMo 基础客户端");
    },
    async generateJsonWithMedia() {
      return {};
    }
  };
  const qwenClient = {
    async generateJson(args) {
      calls.push(args);
      if (args.model === "qwen3.7-max-story") {
        return isFullStoryBeatScenePostpassPrompt(args.prompt)
          ? fullStoryBeatScenePassResponse(story)
          : structuredClone(story);
      }
      if (args.prompt.includes("任务：整理本次 Full Story")) return structuredClone(storyboardResponses.registry);
      if (args.prompt.includes("任务：将完整 Full Story")) return structuredClone(storyboardResponses.design);
      if (args.prompt.includes("你是分镜修稿编辑")) return { strengths: ["保留已有动作"], guidance: [], items: [] };
      throw new Error("未预置的分镜提示词");
    }
  };
  const workflow = new WorkflowService({
    client: mimoClient,
    storyClient: qwenClient,
    storyProvider: "Qwen",
    storyModel: "qwen3.7-max-story",
    storyMaxCompletionTokens: 16000,
    animationClient: qwenClient,
    animationProvider: "Qwen",
    animationModel: "qwen3.7-max-animation",
    animationMaxCompletionTokens: 17000
  });

  const stageContext = globalBoundaryContext(workflow, { creativeBrief, variant });
  const fullStory = await workflow.createFullStory(stageContext);
  const planInput = { ...stageContext, fullStory, animationPlanVersion: "4.0" };
  const demo = new WorkflowService({ groundingKey: workflow.groundingKey, characterBoundaryKey: workflow.characterBoundaryKey });
  const demoPlan = await demo.createAnimationPlan(planInput);
  storyboardResponses = {
    registry: mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(fullStory, stageContext.creatorProfile)),
    design: storyboardDesignFromPlan(demoPlan)
  };
  const animationPlan = await workflow.createAnimationPlan(planInput);

  assert.equal(workflow.mode, "live");
  assert.equal(calls[0].model, "qwen3.7-max-story");
  assert.equal(calls[0].maxCompletionTokens, 16000);
  assert.equal(calls[1].model, "qwen3.7-max-story");
  assert.equal(calls[1].maxCompletionTokens, 16000);
  assert.ok(calls.length > 2);
  for (const call of calls.slice(2)) {
    assert.equal(call.model, "qwen3.7-max-animation");
    assert.equal(call.maxCompletionTokens, 17000);
  }
  assert.equal(animationPlan.promptSchemaVersion, "4.0");
  assert.equal(fullStory.selectedVariantId, "V1");
  assert.equal(animationPlan.selectedVariantId, "V1");
});

test("工作流阶段可通过 modelOverrides 灵活切换 provider 和模型", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const story = mockFullStory({ ...input, creativeBrief, variant });
  const calls = [];
  const qwenClient = {
    async generateJson(args) {
      calls.push(args);
      return isFullStoryBeatScenePostpassPrompt(args.prompt)
        ? fullStoryBeatScenePassResponse(story)
        : structuredClone(story);
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: qwenClient },
    stageDefaults: {
      fullStory: { provider: "Qwen", model: "qwen-default", maxCompletionTokens: 16000 }
    }
  });
  const result = await workflow.createFullStory(globalBoundaryContext(workflow, {
    creativeBrief,
    variant,
    modelOverrides: {
      fullStory: { provider: "Qwen", model: "qwen-custom-story", maxCompletionTokens: 22000 }
    }
  }));
  assert.equal(result.selectedVariantId, "V1");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.model, "qwen-custom-story");
    assert.equal(call.maxCompletionTokens, 22000);
  }
});

test("测试包签名策略允许跨进程角色边界，但仍拒绝摘要不一致", () => {
  const signingWorkflow = new WorkflowService();
  const signedContext = globalBoundaryContext(signingWorkflow, { count: 1 });
  const testPackageWorkflow = new WorkflowService({
    characterBoundarySignatureRequired: false
  });

  assert.doesNotThrow(() => testPackageWorkflow.assertGlobalCharacterBoundary(signedContext));

  const changedContext = structuredClone(signedContext);
  changedContext.visualGuardrails.fixedCharacterBoundary.canonicalDescription += "，内容已被修改";
  assert.throws(
    () => testPackageWorkflow.assertGlobalCharacterBoundary(changedContext),
    /全局角色边界内容已变化/u
  );
});

test("workflow runtime 仅在显式测试包策略下跳过角色边界签名", () => {
  const keys = ["WORKFLOW_RUNTIME_ENVIRONMENT", "WORKFLOW_SIGNATURE_POLICY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.WORKFLOW_RUNTIME_ENVIRONMENT = "test";
    process.env.WORKFLOW_SIGNATURE_POLICY = "test_package_unverified";
    assert.equal(getConfig().workflowRuntime.characterBoundarySignatureRequired, false);

    process.env.WORKFLOW_RUNTIME_ENVIRONMENT = "production";
    assert.equal(getConfig().workflowRuntime.characterBoundarySignatureRequired, true);

    process.env.WORKFLOW_RUNTIME_ENVIRONMENT = "test";
    process.env.WORKFLOW_SIGNATURE_POLICY = "signed";
    assert.equal(getConfig().workflowRuntime.characterBoundarySignatureRequired, true);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("Qwen 媒体阶段默认避开 qwen3.7-max 文本模型", () => {
  const keys = [
    "QWEN_MODEL",
    "QWEN_VIDEO_MODEL",
    "QWEN_ANALYSIS_MODEL",
    "QWEN_RECONSTRUCTION_MODEL",
    "QWEN_VISUAL_MODEL",
    "QWEN_CHARACTER_REFERENCE_MODEL"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.QWEN_MODEL = "qwen3.7-max";
    const config = getConfig();
    assert.equal(config.qwen.model, "qwen3.7-max");
    assert.equal(config.qwen.videoModel, "qwen3.7-plus");
    assert.equal(config.qwen.analysisModel, "qwen3.7-plus");
    assert.equal(config.qwen.reconstructionModel, "qwen3.7-plus");
    assert.equal(config.qwen.visualModel, "qwen3.7-plus");
    assert.equal(config.qwen.characterReferenceModel, "qwen3.7-plus");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("模型生成请求默认允许等待 15 分钟且支持环境变量覆盖", () => {
  const keys = ["MIMO_REQUEST_TIMEOUT_MS", "QWEN_REQUEST_TIMEOUT_MS", "SERVER_REQUEST_TIMEOUT_MS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const defaults = getConfig();
    assert.equal(defaults.mimo.requestTimeoutMs, 900_000);
    assert.equal(defaults.qwen.requestTimeoutMs, 900_000);
    assert.equal(defaults.serverRequestTimeoutMs, 900_000);

    process.env.MIMO_REQUEST_TIMEOUT_MS = "120000";
    process.env.QWEN_REQUEST_TIMEOUT_MS = "180000";
    process.env.SERVER_REQUEST_TIMEOUT_MS = "240000";
    const overridden = getConfig();
    assert.equal(overridden.mimo.requestTimeoutMs, 120_000);
    assert.equal(overridden.qwen.requestTimeoutMs, 180_000);
    assert.equal(overridden.serverRequestTimeoutMs, 240_000);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("流式的 MiMo 与 Qwen 输出上限默认放到实测最大值，DeepSeek 仍是 32768", () => {
  // 2026-09-24：死循环改由 src/output-degeneration.js 边收边查截停，上限不再是唯一的刹车，
  // 所以 MiMo 放到 131072（页面提供的 5 个型号实测接受）、Qwen 放到 65536（09-23 实测接受）。
  // DeepSeek 非流式、中途看不到内容，仍靠 32768 兜底。
  const keys = [
    "MIMO_MAX_COMPLETION_TOKENS", "MIMO_STORY_MAX_COMPLETION_TOKENS", "MIMO_ANIMATION_MAX_COMPLETION_TOKENS",
    "QWEN_MAX_COMPLETION_TOKENS", "QWEN_ANALYSIS_MAX_COMPLETION_TOKENS", "QWEN_RECONSTRUCTION_MAX_COMPLETION_TOKENS",
    "QWEN_BRIEF_MAX_COMPLETION_TOKENS", "QWEN_VISUAL_MAX_COMPLETION_TOKENS", "QWEN_VARIANTS_MAX_COMPLETION_TOKENS",
    "QWEN_STORY_MAX_COMPLETION_TOKENS", "QWEN_ANIMATION_MAX_COMPLETION_TOKENS", "QWEN_CHARACTER_REFERENCE_MAX_COMPLETION_TOKENS",
    "DEEPSEEK_MAX_COMPLETION_TOKENS", "MIMO_ANALYSIS_MAX_COMPLETION_TOKENS"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const { mimo, qwen, deepseek } = getConfig();
    for (const [label, value, expected] of [
      ["mimo", mimo.maxCompletionTokens, 131_072], ["mimo.story", mimo.storyMaxCompletionTokens, 131_072],
      ["mimo.animation", mimo.animationMaxCompletionTokens, 131_072],
      ["qwen", qwen.maxCompletionTokens, 65_536], ["qwen.variants", qwen.variantsMaxCompletionTokens, 65_536],
      ["qwen.story", qwen.storyMaxCompletionTokens, 65_536], ["qwen.animation", qwen.animationMaxCompletionTokens, 65_536],
      ["qwen.visual", qwen.visualMaxCompletionTokens, 65_536],
      ["deepseek", deepseek.maxCompletionTokens, 32_768]
    ]) assert.equal(value, expected, label);
    // 环境变量仍可以往下调，但不能超过各家的实测上限。
    process.env.MIMO_MAX_COMPLETION_TOKENS = "999999";
    process.env.QWEN_MAX_COMPLETION_TOKENS = "16384";
    assert.equal(getConfig().mimo.maxCompletionTokens, 131_072);
    assert.equal(getConfig().qwen.maxCompletionTokens, 16_384);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("参考片分析的输出上限单独默认 16384，不跟随全局上限，仍可用环境变量调整", () => {
  // 2026-10-05：本机 20 次真实分析调用 completion 最多 6929 token；一次 mimo-v2.6-pro 在 65536 上限下
  // 写了 18.3 万字、742 秒才因截断失败。依据见 src/output-token-ceilings.js。
  const keys = [
    "MIMO_MAX_COMPLETION_TOKENS", "MIMO_ANALYSIS_MAX_COMPLETION_TOKENS",
    "QWEN_MAX_COMPLETION_TOKENS", "QWEN_ANALYSIS_MAX_COMPLETION_TOKENS"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const defaults = getConfig();
    assert.equal(ANALYSIS_OUTPUT_TOKEN_DEFAULT, 16_384);
    assert.equal(defaults.qwen.analysisMaxCompletionTokens, 16_384);
    assert.equal(defaults.mimo.analysisMaxCompletionTokens, 16_384);
    // 其它阶段仍跟随各家全局上限，没有被一起收紧。
    assert.equal(defaults.qwen.reconstructionMaxCompletionTokens, 65_536);
    assert.equal(defaults.mimo.maxCompletionTokens, 131_072);

    // 全局上限变化不再带动分析阶段。
    process.env.QWEN_MAX_COMPLETION_TOKENS = "8192";
    process.env.MIMO_MAX_COMPLETION_TOKENS = "8192";
    assert.equal(getConfig().qwen.analysisMaxCompletionTokens, 16_384);
    assert.equal(getConfig().mimo.analysisMaxCompletionTokens, 16_384);

    // 显式的阶段变量仍然生效，并受各家实测上限约束。
    process.env.QWEN_ANALYSIS_MAX_COMPLETION_TOKENS = "32768";
    process.env.MIMO_ANALYSIS_MAX_COMPLETION_TOKENS = "999999";
    assert.equal(getConfig().qwen.analysisMaxCompletionTokens, 32_768);
    assert.equal(getConfig().mimo.analysisMaxCompletionTokens, 131_072);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("Qwen 与 MiMo 流式空闲超时默认 120 秒且支持环境变量覆盖", () => {
  const keys = ["MIMO_STREAM_IDLE_TIMEOUT_MS", "QWEN_STREAM_IDLE_TIMEOUT_MS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const defaults = getConfig();
    assert.equal(defaults.mimo.streamIdleTimeoutMs, 120_000);
    assert.equal(defaults.qwen.streamIdleTimeoutMs, 120_000);
    process.env.MIMO_STREAM_IDLE_TIMEOUT_MS = "90000";
    process.env.QWEN_STREAM_IDLE_TIMEOUT_MS = "150000";
    const overridden = getConfig();
    assert.equal(overridden.mimo.streamIdleTimeoutMs, 90_000);
    assert.equal(overridden.qwen.streamIdleTimeoutMs, 150_000);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("Qwen 和 MiMo 流式生成请求不设总时长上限，健康检查仍为 5 秒", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const observedTimeouts = [];
  try {
    AbortSignal.timeout = (milliseconds) => {
      observedTimeouts.push(milliseconds);
      return originalTimeout(1_000);
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "configured-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      // 这个 mock 由 Qwen / MiMo / DeepSeek 共用同一个 baseUrl，无法按 URL 区分。
      // 按请求自己声明的 stream 决定响应格式，与真实服务器的行为一致：
      // qwen-client 走流式，另外两个仍是完整 JSON 响应体。
      const requested = JSON.parse(String(init?.body || "{}"));
      if (requested.stream) return sseResponse({ content: "{}" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const sharedConfig = {
      baseUrl: "https://provider.invalid/v1",
      apiKey: "",
      model: "configured-model",
      requestTimeoutMs: 900_000,
      jsonRetryAttempts: 0
    };
    const qwen = new QwenClient(sharedConfig);
    const mimo = new MimoClient(sharedConfig);
    await qwen.checkHealth();
    await qwen.generateJson({ prompt: "返回 JSON" });
    await mimo.checkHealth();
    await mimo.generateJson({ prompt: "返回 JSON" });

    // 生成请求只判空闲（连续 streamIdleTimeoutMs 没收到数据才中断），不再调用
    // AbortSignal.timeout 设总时长；requestTimeoutMs 对流式客户端不生效。
    assert.deepEqual(observedTimeouts, [5_000, 5_000]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("Qwen 媒体阶段覆盖为 qwen3.7-max 时回退默认视觉模型", async () => {
  const calls = [];
  const qwenClient = {
    async generateJsonWithMedia(args) {
      calls.push(args);
      return mockAnalysis(input);
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: qwenClient },
    stageDefaults: {
      analysis: { provider: "Qwen", model: "qwen3.7-plus", maxCompletionTokens: 16000 }
    }
  });
  const result = await workflow.analyze({
    ...input,
    modelOverrides: {
      analysis: { provider: "Qwen", model: "qwen3.7-max" }
    }
  });
  assert.equal(result.summary, mockAnalysis(input).summary);
  assert.equal(calls[0].model, "qwen3.7-plus");
});

test("referenceAnalysis 完整候选的 evidence 来源错误时 fail closed，不整包纠偏", async () => {
  const calls = [];
  const unrelatedSentinel = "UNRELATED_ANALYSIS_SENTINEL";
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia(args) {
        calls.push(args);
        args.onResolvedMediaMode?.("video");
        const analysis = mockAnalysis(input);
        analysis.summary = unrelatedSentinel;
        return analysis;
      }
    }
  });

  await assert.rejects(
    () => workflow.analyze({
      ...input,
      video: {
        dataUrl: "data:video/mp4;base64,AAAA",
        mimeType: "video/mp4",
        size: 4
      }
    }),
    /source 本次成功媒体请求只允许 video evidence/u
  );

  assert.equal(calls.length, 1);
  const secondCalls = calls.slice(1);
  assert.equal(secondCalls.length, 0);
  assert.equal(
    secondCalls.some((call) => String(call.prompt || "").includes(unrelatedSentinel)),
    false
  );
});

test("referenceAnalysis 视频时间连续越界时改用关键帧重新取证", async () => {
  const calls = [];
  const videoInput = {
    ...input,
    metadata: { ...input.metadata, duration: 96.269932 },
    video: {
      dataUrl: "data:video/mp4;base64,AAAA",
      mimeType: "video/mp4",
      size: 4
    }
  };
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
        assert.match(args.prompt, /本次只提供采样画面/u);
        assert.match(args.prompt, /不得输出 video 时间字段/u);
        return analysis;
      }
    }
  });

  const result = await workflow.analyze(videoInput);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].video, videoInput.video);
  assert.equal(calls[1].video, null);
  assert.ok(result.observedFacts.every((fact) => (
    fact.evidenceRefs.every((reference) => reference.source === "frame")
  )));
});

test("人物参考图可用 MiMo 修正角色参考提示词", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "温馨/日常/治愈"
  };
  let captured;
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia(args) {
        captured = args;
        return {
          characterName: "小白子",
          storyRole: "主角",
          identity: "狼耳少女，村里的热心帮手",
          appearancePrompt: "参考图中的小白子，短发，狼耳发饰，粉色上衣和蓝色背带裙，儿童比例，温暖治愈动画风格。",
          consistencyTags: ["短发", "狼耳发饰", "粉色上衣", "蓝色背带裙"],
          forbiddenChanges: ["不要改变参考图中的发型和服装", "不要添加尾巴或爪子"],
          referenceImageNotes: "吸收参考图中的发型、服装配色和年龄感。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });

  const result = await workflow.refineCharacterReference(globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，儿童，村民装扮。",
      consistencyTags: ["儿童"],
      forbiddenChanges: ["不要变成成人"]
    }
  }));

  assert.equal(captured.frames.length, 1);
  assert.equal(captured.frames[0].dataUrl, "data:image/png;base64,AA==");
  assert.match(captured.prompt, /人物参考图/);
  assert.equal(result.referenceImageAdded, true);
  assert.equal(result.referenceImageName, "xiaobaizi.png");
  assert.match(result.appearancePrompt, /参考图中的小白子/);
  assert.ok(result.consistencyTags.includes("狼耳发饰"));
});

test("人物参考精修的边界偏差只回传提醒，参考图照常挂上，成片链路仍硬失败", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "小白子",
          storyRole: "主角",
          identity: "村里的热心帮手",
          appearancePrompt: "参考图中的小白子，短发，粉色上衣和蓝色背带裙，儿童比例。",
          consistencyTags: ["短发", "粉色上衣", "蓝色背带裙"],
          forbiddenChanges: ["不要变成成人"],
          referenceImageNotes: "吸收参考图中的服装配色和年龄感。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const context = globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，儿童，村民装扮。",
      consistencyTags: ["儿童"],
      forbiddenChanges: ["不要变成成人"]
    }
  }, xiaobaiziBoundary());

  const result = await workflow.refineCharacterReference(context);

  // 不再抛错：参考图照常挂上，用户不必重新上传。
  assert.equal(result.referenceImageAdded, true);
  assert.equal(result.referenceImageName, "xiaobaizi.png");
  assert.match(result.appearancePrompt, /参考图中的小白子/u);
  assert.match(result.boundaryWarning, /^模型输出未通过校验：characterReference 未沿用全局角色边界：缺少全局必需角色事实：/u);
  assert.match(result.boundaryWarning, /狼耳/u);

  // 同一份内容进入成片渲染链路时仍然硬失败，提醒不等于放行。
  const { boundaryWarning, ...persisted } = result;
  assert.equal(Object.hasOwn(persisted, "boundaryWarning"), false);
  assert.throws(
    () => ensureCharacterReferenceMatchesBoundary(persisted, context.visualGuardrails),
    OutputContractError
  );
});

test("边界合规的人物参考精修不带任何提醒字段", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "小白子",
          storyRole: "主角",
          identity: "狼耳少女，村里的热心帮手",
          appearancePrompt: "参考图中的小白子，狼耳与狼尾保持灰白色，粉色上衣和蓝色背带裙，儿童比例。",
          consistencyTags: ["狼耳", "狼尾", "粉色上衣"],
          forbiddenChanges: ["不要变成成人"],
          referenceImageNotes: "吸收参考图中的服装配色。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const result = await workflow.refineCharacterReference(globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，狼耳少女，带狼尾。",
      consistencyTags: ["狼耳", "狼尾"],
      forbiddenChanges: ["不要变成成人"]
    }
  }, xiaobaiziBoundary()));

  assert.equal(Object.hasOwn(result, "boundaryWarning"), false);
  assert.equal(result.referenceImageAdded, true);
});

test("人物参考精修的冲突优先级按是否固定角色分档", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({ client: {} });
  const context = globalBoundaryContext(workflow, { creatorProfile }, xiaobaiziBoundary());
  const fixedPrompt = characterReferenceRefinePrompt({
    ...context,
    characterReference: { characterName: "小白子", appearancePrompt: "小白子，狼耳少女，带狼尾。" }
  });
  const supportingPrompt = characterReferenceRefinePrompt({
    ...context,
    characterReference: { characterName: "橘色小猫", appearancePrompt: "瘦小的橘色小猫，毛发被雨水打湿。" }
  });

  // 固定角色：以已签发边界为准，逐字保持原语义。
  assert.match(fixedPrompt, /以文字设定和用户固定角色为准/u);
  assert.doesNotMatch(fixedPrompt, /以参考图为准/u);
  assert.match(fixedPrompt, /referenceImageOverrideNotice 必须是空字符串/u);

  // 配角：用户上传的图是明确动作，冲突时以图为准，且不得因“不是同一个角色”放弃采用。
  assert.match(supportingPrompt, /以参考图为准/u);
  assert.match(supportingPrompt, /不得以“与当前角色不符”为由放弃采用这张图/u);
  assert.doesNotMatch(supportingPrompt, /以文字设定和用户固定角色为准/u);
});

test("配角人物参考精修以参考图为准，覆盖提醒只用于展示", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "橘色小猫",
          storyRole: "被关爱对象",
          identity: "被小白子照顾的小动物",
          appearancePrompt: "q版狼耳少女形象，银白色长直发，蓝色大眼睛，猫一样的耳朵。",
          consistencyTags: ["银白色长直发", "蓝色大眼睛"],
          forbiddenChanges: ["不要偏离参考图中的人物外观"],
          referenceImageNotes: "吸收参考图中的发色、瞳色与服装配色。",
          referenceImageOverrideNotice: "已按参考图把外观改写为 q版狼耳少女；原文字设定是瘦小的橘色小猫、湿润毛发。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const result = await workflow.refineCharacterReference(globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "橘色小猫",
      storyRole: "被关爱对象",
      identity: "被小白子照顾的小动物",
      appearancePrompt: "瘦小的橘色小猫，毛发被雨水打湿。",
      consistencyTags: ["橘色毛发", "瘦小体型"],
      forbiddenChanges: ["不要添加非猫类特征"]
    }
  }, xiaobaiziBoundary()));

  // 即使图里是另一种角色，也照图改写，不再保留原设定。
  assert.match(result.appearancePrompt, /q版狼耳少女/u);
  assert.deepEqual(result.consistencyTags, ["银白色长直发", "蓝色大眼睛"]);
  assert.match(result.referenceImageOverrideNotice, /原文字设定是瘦小的橘色小猫/u);
  // 配角不进入全局角色边界判定，不得借这条路冒出边界提醒。
  assert.equal(Object.hasOwn(result, "boundaryWarning"), false);
  // 提醒只用于展示：剥离后不进 Artifact。
  const { referenceImageOverrideNotice, ...persisted } = result;
  assert.equal(Object.hasOwn(persisted, "referenceImageOverrideNotice"), false);
  assert.equal(persisted.characterName, "橘色小猫");
});

test("精修丢掉身份类必需事实时，服务端按签发顺序补回一致性标签并如实提醒", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，学生/村民，村里的热心帮手",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  // 真实场景：参考图精修把「穿着适合户外写生的村民服装」换成照片里的具体衣物，
  // identity 类的「村民」两个字就没了，而判定是字面比对。
  const rewrittenAppearance = "参考图中的小白子，狼耳与狼尾保持灰白色，白色衬衫、蓝色领带、黑色百褶短裙、黑色过膝袜。";
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "小白子",
          storyRole: "主角",
          identity: "狼耳少女",
          appearancePrompt: rewrittenAppearance,
          consistencyTags: ["狼耳", "狼尾", "白色衬衫"],
          forbiddenChanges: ["不要变成成人"],
          referenceImageNotes: "吸收参考图中的服装配色。"
        };
      }
    }
  });
  const boundary = xiaobaiziBoundary();
  boundary.requiredTraits.push(boundaryTrait("学生或村民身份", ["学生", "村民"], "identity"));
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const context = globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，狼耳少女，带狼尾，穿着适合户外写生的村民服装。",
      consistencyTags: ["狼耳", "狼尾"],
      forbiddenChanges: ["不要变成成人"]
    }
  }, boundary);

  const result = await workflow.refineCharacterReference(context);

  // 外观逐字冻结，只在标签尾部追加 exact canonicalName。
  assert.equal(result.appearancePrompt, rewrittenAppearance);
  assert.deepEqual(result.consistencyTags, ["狼耳", "狼尾", "白色衬衫", "学生或村民身份"]);
  // 补回之后不再报缺失，成片渲染链路也不会再被这条拦下。
  assert.equal(Object.hasOwn(result, "boundaryWarning"), false);
  assert.doesNotThrow(() => ensureCharacterReferenceMatchesBoundary(
    (({ boundaryRestoreNotice, ...rest }) => rest)(result),
    context.visualGuardrails
  ));
  // 服务端改了模型输出就必须说出来，而且只用于展示。
  assert.match(result.boundaryRestoreNotice, /学生或村民身份/u);
  const { boundaryRestoreNotice, ...persisted } = result;
  assert.equal(Object.hasOwn(persisted, "boundaryRestoreNotice"), false);
});

test("外观类必需事实缺失不会被补标签顶替，仍然提醒并在渲染前硬失败", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "小白子",
          storyRole: "主角",
          // 把狼耳少女写成了短发儿童：这是真的把长相写错了，补标签不会让图里长出狼耳。
          appearancePrompt: "参考图中的小白子，短发，粉色上衣和蓝色背带裙，儿童比例。",
          consistencyTags: ["短发", "粉色上衣"],
          forbiddenChanges: ["不要变成成人"],
          referenceImageNotes: "吸收参考图中的服装配色。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const context = globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，狼耳少女，带狼尾。",
      consistencyTags: ["狼耳", "狼尾"],
      forbiddenChanges: ["不要变成成人"]
    }
  }, xiaobaiziBoundary());

  const result = await workflow.refineCharacterReference(context);

  assert.equal(Object.hasOwn(result, "boundaryRestoreNotice"), false);
  assert.deepEqual(result.consistencyTags, ["短发", "粉色上衣"]);
  // 缺的是 appearance scope 的狼尾（狼耳由沿用下来的 identity「狼耳少女」满足），不补标签。
  assert.match(result.boundaryWarning, /缺少全局必需角色事实：狼尾/u);
  // 同一份内容进入成片渲染链路仍然硬失败。
  assert.throws(
    () => ensureCharacterReferenceMatchesBoundary(
      (({ boundaryWarning, ...rest }) => rest)(result),
      context.visualGuardrails
    ),
    OutputContractError
  );
});

test("固定角色的精修提示词逐条列出必需事实的可接受写法，配角不列", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，学生/村民",
    constraints: "",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({ client: {} });
  const boundary = xiaobaiziBoundary();
  boundary.requiredTraits.push(boundaryTrait("学生或村民身份", ["学生", "村民"], "identity"));
  const context = globalBoundaryContext(workflow, { creatorProfile }, boundary);

  const fixedPrompt = characterReferenceRefinePrompt({
    ...context,
    characterReference: { characterName: "小白子", appearancePrompt: "小白子，狼耳少女。" }
  });
  assert.match(fixedPrompt, /校验是字面比对，换成同义表达会被判定为缺失/u);
  assert.match(fixedPrompt, /学生或村民身份（可接受写法：学生或村民身份 \/ 学生 \/ 村民）/u);
  assert.match(fixedPrompt, /写进 identity 或 consistencyTags 同样算数/u);

  // 配角不参与全局角色边界判定，不该收到这份词表。
  const supportingPrompt = characterReferenceRefinePrompt({
    ...context,
    characterReference: { characterName: "橘色小猫", appearancePrompt: "瘦小的橘色小猫。" }
  });
  assert.doesNotMatch(supportingPrompt, /校验是字面比对/u);
});

test("固定角色人物参考精修不接受参考图覆盖，也不沿用上一版提醒", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童体型",
    constraints: "保持治愈风格",
    vertical: "温馨/日常/治愈"
  };
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        return {
          characterName: "小白子",
          storyRole: "主角",
          identity: "狼耳少女，村里的热心帮手",
          appearancePrompt: "参考图中的小白子，狼耳与狼尾保持灰白色，粉色上衣和蓝色背带裙，儿童比例。",
          consistencyTags: ["狼耳", "狼尾", "粉色上衣"],
          forbiddenChanges: ["不要变成成人"],
          referenceImageNotes: "吸收参考图中的服装配色。",
          referenceImageOverrideNotice: "已按参考图去掉狼耳。"
        };
      }
    }
  });
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const result = await workflow.refineCharacterReference(globalBoundaryContext(workflow, {
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
    creativeBrief,
    selectedVariant: { id: "V1", title: "风车与彩虹" },
    fullStory: { title: "风车与彩虹" },
    characterReference: {
      characterName: "小白子",
      storyRole: "主角",
      identity: "狼耳少女",
      appearancePrompt: "小白子，狼耳少女，带狼尾。",
      consistencyTags: ["狼耳", "狼尾"],
      forbiddenChanges: ["不要变成成人"],
      referenceImageOverrideNotice: "上一版遗留的旧提醒"
    }
  }, xiaobaiziBoundary()));

  // 固定角色没有覆盖权：模型写了覆盖说明也丢弃，上一版遗留的提醒同样不得沿用。
  assert.equal(Object.hasOwn(result, "referenceImageOverrideNotice"), false);
  assert.equal(Object.hasOwn(result, "boundaryWarning"), false);
  assert.match(result.appearancePrompt, /狼耳与狼尾/u);
});

test("单镜头全能参考模式不生成首尾帧，并把参考图作为 R2V 权威输入", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-r2v-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let receivedBody = null;
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { videoBase64: Buffer.from("r2v shot video bytes").toString("base64") } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${provider.address().port}/v2/video_generation`,
    providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-260128",
    apiKey: "test-key"
  }));

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    aspectRatio: "16:9",
    referenceAssets: [{
      mediaType: "image",
      name: "小白子角色参考.png",
      dataUrl: `data:image/png;base64,${Buffer.from("character reference bytes").toString("base64")}`,
      source: "character_reference"
    }],
    shot: {
      shotId: "S01-R2V",
      durationSeconds: 5,
      videoPrompt: "参考角色身份生成挥手动作"
    }
  });

  assert.equal(result.generationMode, "all_reference");
  assert.deepEqual(result.referenceSummary, { image: 1, video: 0, audio: 0 });
  assert.deepEqual(receivedBody.content.map((item) => item.role || "text"), ["text", "reference_image"]);
  assert.equal(receivedBody.content.some((item) => ["first_frame", "last_frame"].includes(item.role)), false);
  assert.equal(receivedBody.ratio, "16:9");
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "r2v shot video bytes");
});

// 镜头视频只剩 Seedance 与 MiniMax 的全能参考（2026-10-11 删除自定义 VideoHTTP 与首尾帧）。
// 下面三条原来走自定义 VideoHTTP，现在改用 Seedance 的供应商配置文件与一张角色参考图。
async function seedanceShotVideoConfig(root, port) {
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${port}/api/v3/contents/generations/tasks`,
    providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-260128",
    apiKey: "test-key"
  }));
  return configPath;
}

const seedanceReferenceAssets = () => [{
  mediaType: "image",
  name: "角色参考.png",
  dataUrl: `data:image/png;base64,${Buffer.from("character reference bytes").toString("base64")}`,
  source: "character_reference"
}];

test("单镜头视频生成可返回多个候选", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-count-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videoBodies = [];
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    videoBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { videoBase64: Buffer.from(`shot video bytes ${videoBodies.length}`).toString("base64") } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const configPath = await seedanceShotVideoConfig(root, provider.address().port);

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    videoProvider: "Seedance",
    generationMode: "all_reference",
    count: 2,
    referenceAssets: seedanceReferenceAssets(),
    shot: { shotId: "S03", durationSeconds: 4, videoPrompt: "阿岚拧紧收音机背板的螺丝" }
  });

  assert.equal(result.count, 2);
  assert.equal(result.actualCount, 2);
  assert.equal(result.videos.length, 2);
  assert.match(result.videos[0].outputUrl, /-1\.mp4$/u);
  assert.match(result.videos[1].outputUrl, /-2\.mp4$/u);
  assert.equal(await fs.readFile(result.videos[0].outputPath, "utf8"), "shot video bytes 1");
  assert.equal(await fs.readFile(result.videos[1].outputPath, "utf8"), "shot video bytes 2");
  assert.deepEqual(result.videos.map((video) => video.candidateIndex), [0, 1]);
  // 每条候选各自一次供应商调用，请求体相同（同一条提示词与同一张参考图）。
  assert.equal(videoBodies.length, 2);
  assert.deepEqual(videoBodies[1], videoBodies[0]);
  assert.deepEqual(videoBodies[0].content.map((item) => item.role || "text"), ["text", "reference_image"]);
});

test("单镜头视频生成不会把供应商纯文本确认当成 mp4", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-text-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // drain request body
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const configPath = await seedanceShotVideoConfig(root, provider.address().port);

  await assert.rejects(() => generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    videoProvider: "Seedance",
    generationMode: "all_reference",
    referenceAssets: seedanceReferenceAssets(),
    shot: { shotId: "S04", videoPrompt: "测试视频", durationSeconds: 5 }
  }), ShotVideoProviderError);
});

test("单镜头视频生成未配置供应商时给出明确错误", async () => {
  const keys = [
    "SHOT_VIDEO_PROVIDER", "SEEDANCE_VIDEO_CONFIG", "SEEDANCE_VIDEO_ENDPOINT", "SEEDANCE_BASE_URL",
    "JIMENG_BASE_URL", "SEEDANCE_API_KEY", "JIMENG_API_KEY"
  ];
  const savedEnv = pickEnv(keys);
  for (const key of keys) delete process.env[key];
  try {
    await assert.rejects(
      () => generateShotVideo({
        videoProvider: "Seedance",
        generationMode: "all_reference",
        referenceAssets: seedanceReferenceAssets(),
        shot: { shotId: "S05", videoPrompt: "测试", durationSeconds: 5 }
      }),
      (error) => error instanceof ShotVideoConfigError && /未配置 Seedance/u.test(error.message)
    );
  } finally {
    restoreEnv(savedEnv);
  }
});

test("少于三张画面时拒绝分析", async () => {
  const workflow = new WorkflowService();
  await assert.rejects(() => workflow.analyze({ ...input, frames: frames.slice(0, 2) }), InputError);
});

test("模型 JSON 解析兼容 think 标签和代码块", () => {
  assert.deepEqual(parseModelJson('<think>internal</think>\n```json\n{"ok":true}\n```'), { ok: true });
});

test("MiMo thinking disabled 时将视觉内容放在文本前并把 no_think 放在末尾", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, videoFps: 2, videoMediaResolution: "default", maxCompletionTokens: 8192, thinking: "disabled" },
    { prompt: "分析视频", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }, useVideo: true }
  );
  const content = body.messages[1].content;
  assert.equal(body.model, "mimo-v2.5");
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(content[0].type, "video_url");
  assert.equal(content[0].video_url.url, "data:video/mp4;base64,AAAA");
  assert.equal(content[0].fps, 2);
  assert.equal(content[0].media_resolution, "default");
  assert.equal(content.at(-1).type, "text");
  assert.match(content.at(-1).text, /\/no_think$/);
});

test("MiMo thinking enabled 时不追加 no_think", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, maxCompletionTokens: 8192, thinking: "enabled" },
    { prompt: "分析视频", frames: [], useVideo: false }
  );
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.messages[1].content.at(-1).text, "分析视频");
  assert.doesNotMatch(body.messages[1].content.at(-1).text, /\/no_think/);
});

test("完整剧情请求可覆盖为 pro 模型和更长 token 上限", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, maxCompletionTokens: 8192, thinking: "disabled" },
    { prompt: "生成完整剧情", frames: [], useVideo: false },
    { model: "mimo-v2.5-pro", maxCompletionTokens: 12288 }
  );
  assert.equal(body.model, "mimo-v2.5-pro");
  assert.equal(body.max_completion_tokens, 12288);
  assert.equal(body.messages[1].content.at(-1).type, "text");
});

test("Qwen 请求使用 OpenAI 兼容文本格式和 qwen3.7-max", () => {
  const body = buildQwenRequestBody(
    { model: "qwen3.7-max", jsonMode: true, maxCompletionTokens: 16384, enableThinking: false },
    { prompt: "生成完整剧情" }
  );
  assert.equal(body.model, "qwen3.7-max");
  assert.equal(body.max_tokens, 16384);
  // 流式对 qwen-client 的全部模型开启：非流式长请求会在约 306 秒被上游掐断，
  // 而成功调用最慢 234 秒，余量只剩 72 秒（依据见 src/sse-stream.js 头部注释）。
  // usage 只在最后一个数据块里返回，不带 stream_options 就拿不到 token 记账。
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content, "生成完整剧情");
});

test("智谱 GLM 5.3 JSON 请求保留思考、降低推理深度且不发送不支持的结构化输出参数", () => {
  const body = buildQwenRequestBody(
    { model: "qwen3.7-max", jsonMode: true, maxCompletionTokens: 16384, enableThinking: false },
    { prompt: "生成创作简报" },
    { model: "ZHIPU/GLM-5.3-Flash" }
  );

  assert.equal(body.model, "ZHIPU/GLM-5.3-Flash");
  assert.equal(body.enable_thinking, true);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "response_format"), false);
  assert.equal(qwenCompatibleProviderName(body.model), "Zhipu");
  assert.equal(isZhipuGlm53Model(body.model), true);
  assert.equal(isZhipuGlm53Model("ZHIPU/GLM-5.2"), false);
});

test("Qwen 兼容客户端使用实际智谱名称报告 token 截断", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => sseResponse({
      content: "",
      finishReason: "length",
      usage: { prompt_tokens: 10, completion_tokens: 16384, total_tokens: 16394 }
    });

    const client = new QwenClient({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "",
      model: "qwen3.7-max",
      maxCompletionTokens: 16384,
      enableThinking: true,
      jsonMode: true,
      jsonRetryAttempts: 0
    });

    await assert.rejects(
      client.generateJson({
        prompt: "只返回 JSON",
        model: "ZHIPU/GLM-5.3-Flash",
        strictJson: true,
        jsonRetryAttempts: 0
      }),
      (error) => error instanceof ModelResponseError
        && error.code === "MODEL_OUTPUT_TRUNCATED"
        && /Zhipu 输出因 token 上限被截断/u.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("智谱未截断但正文不是 JSON 时不再误报为 Qwen", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => sseResponse({ content: "not json", finishReason: "stop" });

    const client = new QwenClient({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "",
      model: "qwen3.7-max",
      maxCompletionTokens: 16384,
      enableThinking: true,
      jsonMode: true,
      jsonRetryAttempts: 0
    });

    await assert.rejects(
      client.generateJson({
        prompt: "只返回 JSON",
        model: "ZHIPU/GLM-5.3-Flash",
        strictJson: true,
        jsonRetryAttempts: 0
      }),
      (error) => error instanceof ModelResponseError && /Zhipu 未返回严格 JSON/u.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-08-30 实测：网关对 kimi-k3 返回
// HTTP 400 "Parameter 'temperature'=0.3 is not supported for kimi-k3 model."
// 而 temperature 此前是写死的，任何阶段选中 kimi-k3 都会在 1 秒内必挂。
// 只有 temperature 被拒，同一模型的 top_p / response_format / max_tokens 都正常。
test("已知拒绝 temperature 的模型不发送该参数，其余参数与其它模型一致", () => {
  const config = { model: "qwen3.7-max", jsonMode: true, maxCompletionTokens: 16384 };
  const kimi = buildQwenRequestBody(config, { prompt: "p" }, { model: "kimi-k3" });
  assert.equal(Object.prototype.hasOwnProperty.call(kimi, "temperature"), false);
  // 只摘掉 temperature，其余一个都不能少——否则就是借着修一个参数改变了采样行为。
  assert.equal(kimi.top_p, 0.95);
  assert.equal(kimi.max_tokens, 16384);
  assert.deepEqual(kimi.response_format, { type: "json_object" });
  assert.equal(kimi.model, "kimi-k3");
});

// 清单只登记实测事实，不按模型名前缀推断：kimi-k2.7-code 实测接受 temperature，
// 因此「kimi 开头都不支持」是错的，写成前缀匹配会静默改变一批模型的采样行为。
test("未登记的模型照常发送 temperature，包括同系列的其它模型", () => {
  const config = { model: "qwen3.7-max", jsonMode: true, maxCompletionTokens: 16384 };
  assert.equal(buildQwenRequestBody(config, { prompt: "p" }, { model: "qwen3.7-max" }).temperature, 0.3);
  assert.equal(buildQwenRequestBody(config, { prompt: "p" }, { model: "kimi-k2.7-code" }).temperature, 0.3);
  assert.equal(modelAcceptsTemperature("kimi-k3"), false);
  assert.equal(modelAcceptsTemperature("kimi-k2.7-code"), true);
  assert.equal(modelAcceptsTemperature(""), true);
});

test("MiMo 与 Qwen 请求允许 reconstruction 覆盖为证据还原 system prompt", () => {
  const systemPrompt = "你只负责忠实还原证据，不得改编人物、道具或结尾。";
  const mimoBody = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, maxCompletionTokens: 8192, thinking: "disabled" },
    { prompt: "还原脚本", frames: [], useVideo: false },
    { systemPrompt }
  );
  const qwenBody = buildQwenRequestBody(
    { model: "qwen3.7-plus", jsonMode: true, maxCompletionTokens: 16384, enableThinking: false },
    { prompt: "还原脚本" },
    { systemPrompt }
  );
  assert.equal(mimoBody.messages[0].content, systemPrompt);
  assert.equal(qwenBody.messages[0].content, systemPrompt);
});

test("MiMo 与 Qwen 的 systemPrompt 覆盖保留默认回退和 JSON 输出约束", () => {
  const mimoConfig = { model: "mimo-v2.5", jsonMode: true, maxCompletionTokens: 8192, thinking: "disabled" };
  const qwenConfig = { model: "qwen3.7-plus", jsonMode: true, maxCompletionTokens: 16384, enableThinking: false };
  const request = { prompt: "输出 JSON", frames: [], useVideo: false };
  const builders = [
    (overrides) => buildRequestBody(mimoConfig, request, overrides),
    (overrides) => buildQwenRequestBody(qwenConfig, request, overrides)
  ];

  for (const build of builders) {
    for (const systemPrompt of [undefined, null, "", "   "]) {
      const body = build({ systemPrompt });
      assert.equal(body.messages[0].content, SYSTEM_PROMPT);
      assert.deepEqual(body.response_format, { type: "json_object" });
    }
    const overridden = build({ systemPrompt: RECONSTRUCTION_SYSTEM_PROMPT });
    assert.equal(overridden.messages[0].content, RECONSTRUCTION_SYSTEM_PROMPT);
    assert.notEqual(overridden.messages[0].content, `${SYSTEM_PROMPT}\n${RECONSTRUCTION_SYSTEM_PROMPT}`);
    assert.deepEqual(overridden.response_format, { type: "json_object" });
  }

  const ordinaryStage = buildQwenRequestBody(qwenConfig, { prompt: "生成完整剧情" });
  assert.equal(ordinaryStage.messages[0].content, SYSTEM_PROMPT);
  assert.doesNotMatch(ordinaryStage.messages[0].content, /视频事实还原/u);
  assert.match(reconstructionPrompt({ referenceAnalysis: {}, metadata: {}, transcript: "" }), /只输出.*JSON/su);
});

test("非 reconstruction 工作流不会继承证据还原 systemPrompt", async () => {
  const creatorProfile = input.creatorProfile;
  let captured;
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        captured = args;
        return mockBrief();
      }
    }
  });

  await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });

  assert.equal(captured.systemPrompt, null);
  assert.doesNotMatch(captured.prompt, /视频事实还原与证据整理助手/u);
});

test("Qwen 视频解析请求使用 video_url 或图片列表 video 格式", () => {
  const direct = buildQwenRequestBody(
    { model: "qwen3.7-max", maxCompletionTokens: 16384, videoFps: 1.5, maxPixels: 655360 },
    { prompt: "分析视频", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }, useVideo: true }
  );
  assert.equal(direct.messages[1].content[0].type, "video_url");
  assert.equal(direct.messages[1].content[0].video_url.url, "data:video/mp4;base64,AAAA");
  assert.equal(direct.messages[1].content[0].fps, 1.5);
  assert.equal(direct.messages[1].content[0].max_pixels, 655360);
  assert.equal(direct.messages[1].content.at(-1).text, "分析视频");

  const sampled = buildQwenRequestBody(
    { model: "qwen3.7-max", maxCompletionTokens: 16384, videoFps: 2 },
    { prompt: "分析关键帧", frames, useVideo: false }
  );
  assert.equal(sampled.messages[1].content[0].type, "video");
  assert.deepEqual(sampled.messages[1].content[0].video, frames.map((frame) => frame.dataUrl));
  assert.equal(sampled.messages[1].content[0].fps, 2);
});

test("auto 模式下 Qwen video_url 失败时回退为关键帧列表", async (t) => {
  const requests = [];
  const resolvedModes = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const content = body.messages[1].content;
    if (content.some((item) => item.type === "video_url")) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end('{"error":"unsupported video"}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseChunks({ content: '{"ok":true}' }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  const client = new QwenClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "qwen3.7-max",
    mediaMode: "auto",
    videoFps: 2,
    maxCompletionTokens: 16384,
    enableThinking: false,
    jsonRetryAttempts: 2
  });
  const result = await client.generateJsonWithMedia({
    prompt: "分析",
    frames,
    video: { dataUrl: "data:video/mp4;base64,AAAA" },
    onResolvedMediaMode: (mode) => resolvedModes.push(mode)
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "video");
  assert.deepEqual(resolvedModes, ["frames"]);
});

test("即梦角色参考图请求使用 5.0 Lite 流式图片生成参数", () => {
  const characterReference = {
    characterName: "小白子",
    appearancePrompt: "小白子，q版狼耳少女，蓝色眼睛，站在村口，学生/村民。"
  };
  const prompt = buildCharacterReferenceImagePrompt(characterReference, 3);
  const body = buildJimengImageRequestBody(
    { model: "doubao-seedream-5-0-260128", size: "1728x2304", outputFormat: "png", imageField: "image", maxImages: 6, watermark: false },
    { referenceImageDataUrl: "data:image/png;base64,AA==", characterReference, count: 3 }
  );
  assert.match(prompt, /参考我上传的这张图片，生成一张角色参考图。/);
  assert.match(prompt, /角色外观：小白子，q版狼耳少女/);
  assert.match(prompt, /人物站立，全身入镜/);
  // 项目残留的水果摊硬编码已删除，不得再出现在任何角色图提示词里。
  assert.doesNotMatch(prompt, /水果/);
  assert.equal(body.model, "doubao-seedream-5-0-260128");
  assert.equal(body.stream, true);
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.watermark, false);
  assert.equal(body.size, "1728x2304");
  assert.equal(body.output_format, "png");
  assert.equal(body.image, "data:image/png;base64,AA==");
  assert.equal(body.sequential_image_generation, "auto");
  assert.deepEqual(body.sequential_image_generation_options, { max_images: 3 });
  const customBody = buildJimengImageRequestBody(
    { model: "doubao-seedream-5-0-260128", size: "1728x2304", outputFormat: "png", imageField: "image", maxImages: 6, watermark: false },
    { referenceImageDataUrl: "data:image/png;base64,AA==", characterReference, count: 1, prompt: "用户编辑后的提示词", model: "custom-image-model" }
  );
  assert.equal(customBody.model, "custom-image-model");
  assert.equal(customBody.prompt, "用户编辑后的提示词");
  assert.equal(customBody.image, "data:image/png;base64,AA==");
});

test("即梦图片客户端可解析流式 partial_succeeded 和 completed 事件", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write(`data: ${JSON.stringify({
      type: "image_generation.partial_succeeded",
      model: "doubao-seedream-5-0-260128",
      image_index: 0,
      b64_json: "AA==",
      size: "1728x2304"
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "image_generation.completed",
      model: "doubao-seedream-5-0-260128",
      usage: { generated_images: 1 }
    })}\n\n`);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => closeServer(server));
  const client = new JimengImageClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "test-key",
    model: "doubao-seedream-5-0-260128",
    size: "1728x2304",
    outputFormat: "png",
    imageField: "image",
    maxImages: 6,
    watermark: false
  });
  const events = [];
  await client.generateImagesStream({
    referenceImageDataUrl: "data:image/png;base64,AA==",
    characterReference: { characterName: "小白子", appearancePrompt: "小白子，站立全身图" },
    count: 1
  }, (event) => events.push(event));
  assert.equal(requests[0].model, "doubao-seedream-5-0-260128");
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].response_format, "b64_json");
  assert.equal(requests[0].image, "data:image/png;base64,AA==");
  assert.equal(events[0].type, "image_generation.partial_succeeded");
  assert.equal(events[0].image_index, 0);
  assert.equal(events[1].type, "image_generation.completed");
  assert.equal(events[1].usage.generated_images, 1);
});

// 原来这两条测的是首尾帧出图请求的参考图选择（已随首尾帧删除）。选择函数本身仍给 4.0 镜头视频用：
// 只按 beats 里的 characters 精确取，不从文字里猜。
function storyboardBeat(characters, visibleAction, location = "院子") {
  return { startSeconds: 0, endSeconds: 4, sourceSceneIds: ["S1"], location, characters, framing: "中景", camera: "固定机位", visibleAction, dialogue: [], soundDesign: "" };
}

test("镜头视频只取本镜 beats 里实际出镜角色的参考图", () => {
  const references = [
    { characterName: "小白子", storyRole: "主角", referenceImageDataUrl: "data:image/png;base64,AA==", appearancePrompt: "狼耳少女" },
    { characterName: "爷爷", storyRole: "被关爱对象", referenceImageDataUrl: "data:image/png;base64,BB==", appearancePrompt: "老人" },
    { characterName: "张老师", storyRole: "路人", referenceImageDataUrl: "data:image/png;base64,CC==", appearancePrompt: "老师" }
  ];
  const shot = {
    beats: [
      storyboardBeat(["小白子"], "小白子抱着草药包走到爷爷家门口。"),
      storyboardBeat(["小白子", "爷爷"], "爷爷接过草药包，向小白子点头。")
    ]
  };
  const related = shotRelatedCharacterReferences(shot, references);
  assert.deepEqual(related.map((item) => item.characterName), ["小白子", "爷爷"]);
});

test("镜头视频不会因地点词带上地点所有者的参考图", () => {
  const references = [
    { characterName: "外婆", storyRole: "委托者", referenceImageDataUrl: "data:image/png;base64,AA==", appearancePrompt: "老人" },
    { characterName: "小白子", storyRole: "主角", referenceImageDataUrl: "data:image/png;base64,BB==", appearancePrompt: "白发猫耳少女" }
  ];
  const shot = {
    storyPurpose: "强化主角接到任务后的开心情绪。",
    beats: [storyboardBeat(["小白子"], "阳光明媚的外婆院子里，小白子双手抱着旧铁盒在胸前。", "外婆院子")]
  };
  const related = shotRelatedCharacterReferences(shot, references);
  assert.deepEqual(related.map((item) => item.characterName), ["小白子"]);
});

test("不是 4.0 的镜头（没有 beats）明确报错，不从首尾帧文字里猜角色", () => {
  const references = [{ characterName: "小白子", referenceImageDataUrl: "data:image/png;base64,AA==" }];
  assert.throws(
    () => shotRelatedCharacterReferences({ startFramePrompt: "小白子站在门口。", endFramePrompt: "小白子转身。" }, references),
    TypeError
  );
});

test("关键帧请求保持全部图像在文本之前", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: true },
    { prompt: "分析画面", frames, useVideo: false }
  );
  const content = body.messages[1].content;
  assert.equal(content.filter((item) => item.type === "image_url").length, frames.length);
  assert.equal(content.at(-1).type, "text");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("auto 模式在服务拒绝 video_url 时回退关键帧", async (t) => {
  const requests = [];
  const resolvedModes = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const content = body.messages[1].content;
    if (content.some((item) => item.type === "video_url")) {
      response.writeHead(415, { "content-type": "application/json" });
      response.end('{"error":"unsupported video"}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseChunks({ content: '{"ok":true}' }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "mimo-v2.5", jsonMode: false, mediaMode: "auto", videoFps: 2, videoMediaResolution: "default", maxCompletionTokens: 8192, thinking: "disabled"
  });
  const result = await client.generateJsonWithMedia({
    prompt: "分析",
    frames,
    video: { dataUrl: "data:video/mp4;base64,AAAA" },
    onResolvedMediaMode: (mode) => resolvedModes.push(mode)
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "image_url");
  assert.deepEqual(resolvedModes, ["frames"]);
});

test("auto 模式在原生视频返回坏 JSON 时回退关键帧", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const content = body.messages[1].content;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (content.some((item) => item.type === "video_url")) {
      response.end(sseChunks({ content: '{"ok":' }));
      return;
    }
    response.end(sseChunks({ content: '{"ok":true}' }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "mimo-v2.5",
    jsonMode: false,
    mediaMode: "auto",
    videoFps: 2,
    videoMediaResolution: "default",
    maxCompletionTokens: 8192,
    jsonRetryAttempts: 2,
    thinking: "disabled"
  });

  const result = await client.generateJsonWithMedia({
    prompt: "分析", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "image_url");
});

test("MiMo JSON 截断时自动用精简 JSON 提示重试", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end(sseChunks({ content: '{"variants":[{"id":"V1","title":"截断', finishReason: "length" }));
      return;
    }
    response.end(sseChunks({ content: '{"variants":[{"id":"V1","title":"修复成功"}]}' }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "mimo-v2.5",
    jsonMode: false,
    mediaMode: "frames",
    maxCompletionTokens: 8192,
    jsonRetryAttempts: 1,
    thinking: "disabled"
  });

  const result = await client.generateJson({ prompt: "生成主题变体" });

  assert.deepEqual(result, { variants: [{ id: "V1", title: "修复成功" }] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_completion_tokens, 8192);
  assert.equal(requests[1].max_completion_tokens, 12288);
  assert.match(requests[1].messages[1].content.at(-1).text, /上一次模型输出不是完整合法 JSON/);
});

test("MiMo 健康检查同时验证服务可达和指定模型已加载", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"mimo-v2.5"}]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "mimo-v2.5"
  });
  assert.deepEqual(await client.checkHealth(), {
    reachable: true,
    modelAvailable: true,
    status: 200,
    modelIds: ["mimo-v2.5"]
  });
});

test("brief 提示词只做原片解读：不收用户设定，只要 storyEngine 与 recastTest", () => {
  const prompt = briefPrompt({
    referenceAnalysis: { storySynopsis: "ANALYSIS_SENTINEL" },
    sourceScriptReconstruction: { relationshipPattern: "RECONSTRUCTION_SENTINEL" },
    creatorProfile: {
      fixedCharacter: "FIXED_CHARACTER_SENTINEL，Q版猫耳少女",
      vertical: "VERTICAL_SENTINEL",
      constraints: "CONSTRAINTS_SENTINEL"
    }
  });
  const body = prompt.slice(prompt.indexOf("你现在做的是「原片解读」"));
  assert.match(body, /ANALYSIS_SENTINEL/u);
  assert.match(body, /RECONSTRUCTION_SENTINEL/u);
  // 两项讲的都是原片：转述用户设定只会造出第二份事实（09-23 那份简报把搭档并进了「固定角色」）。
  for (const sentinel of ["FIXED_CHARACTER_SENTINEL", "VERTICAL_SENTINEL", "CONSTRAINTS_SENTINEL"]) {
    assert.equal(prompt.includes(sentinel), false, sentinel);
  }
  assert.match(body, /顶层只允许这两个键/u);
  assert.match(body, /"storyEngine":\{"desire":""/u);
  assert.match(body, /"recastTest":\{"recastAs":"", "collapses":\[\], "survives":\[\]\}/u);
  assert.match(body, /本阶段没有 uncertainties 字段/u);
  // 已删字段不得在正文里出现，否则就是提示词与校验器打架（多写一个键就被拒）。
  for (const removed of ["allowedNarrativeComponents", "protectedExpressions", "controlledRewriteVariables",
    "roleAndOccupationMapping", "minimumTransformationRules", "reusableHighValueBeats", "mustRetain",
    "nonNegotiableExperience", "creativeDistancePolicy", "emotionStructure", "coreEmotion", "contentType"]) {
    assert.equal(body.includes(removed), false, removed);
  }
});

test("模型漏掉必要字段时拒绝把结果标记为成功", () => {
  assert.throws(() => ensureOutputContract({ storySynopsis: "只有一个字段" }, "referenceAnalysis"), /缺少必要字段/);
  assert.throws(
    () => ensureOutputContract({ variants: [] }, "themeVariants"),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.code === "STORY_CANDIDATES_SCHEMA_MIN_ITEMS")
  );
  assert.throws(() => ensureOutputContract({ selectedVariantId: "V1" }, "fullStory"), /缺少必要字段/);
  // 没有 4.0 版本号的 Plan 在契约层就按旧版分镜拒绝（2026-10-11 起只支持 4.0）。
  assert.throws(
    () => ensureOutputContract({ selectedVariantId: "V1" }, "animationPlan"),
    (error) => error instanceof OutputContractError && error.code === "ANIMATION_PLAN_VERSION_UNSUPPORTED"
  );
});

test("fullStory 不完整时拒绝通过校验", () => {
  const story = mockFullStory({
    ...input,
    variant: { id: "V1", characterSetup: { protagonist: "小白子，小女孩" } },
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童", vertical: "治愈日常" }
  });
  const shortBeats = { ...story, beatSheet: story.beatSheet.slice(0, 5) };
  const shortScenes = { ...story, sceneScript: story.sceneScript.slice(0, 5) };
  assert.throws(() => ensureOutputContract(shortBeats, "fullStory"), /至少需要 6 个剧情节拍/);
  assert.throws(() => ensureOutputContract(shortScenes, "fullStory"), /至少需要 6 个可拍摄分场/);
});

test("fullStory Scene Contract 聚合校验逐场必填字段与唯一性", async (t) => {
  const storyFixture = () => mockFullStory({
    ...input,
    variant: {
      id: "V1",
      characterSetup: {
        protagonist: "阿岚，社区修理师",
        careRecipient: "独居老人",
        helper: "夜班便利店员"
      }
    }
  });
  const cases = [
    {
      name: "location 为空",
      mutate(story) {
        story.sceneScript[3].location = "";
      },
      path: "fullStory.sceneScript[3].location"
    },
    {
      name: "visibleAction 为空",
      mutate(story) {
        story.sceneScript[3].visibleAction = "";
      },
      path: "fullStory.sceneScript[3].visibleAction"
    },
    {
      name: "sceneId 重复",
      mutate(story) {
        story.sceneScript[3].sceneId = story.sceneScript[2].sceneId;
      },
      path: "fullStory.sceneScript[3].sceneId"
    },
    {
      name: "角色名为空",
      mutate(story) {
        story.sceneScript[3].characters.push("   ");
      },
      path: "fullStory.sceneScript[3].characters[2]"
    },
    {
      name: "角色名重复",
      mutate(story) {
        story.sceneScript[3].characters.push(story.sceneScript[3].characters[0]);
      },
      path: "fullStory.sceneScript[3].characters[2]"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const story = storyFixture();
      scenario.mutate(story);
      assert.throws(
        () => ensureOutputContract(story, "fullStory"),
        (error) => error instanceof OutputContractError
          && error.message.includes("Scene Contract")
          && error.details.some((detail) => detail.path === scenario.path)
      );
    });
  }

  await t.test("同一场次的多个缺陷一次完整报告", () => {
    const story = storyFixture();
    story.sceneScript[3].location = "";
    // 空数组现在是合法空镜；仍然非法的是空白角色名。
    story.sceneScript[3].characters = ["   "];
    story.sceneScript[3].visibleAction = "";
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      (error) => error instanceof OutputContractError
        && error.message.includes("fullStory.sceneScript[3].location")
        && error.message.includes("fullStory.sceneScript[3].characters")
        && error.message.includes("fullStory.sceneScript[3].visibleAction")
    );
  });
});

test("fullStory Scene Contract 只校验可确定的视觉角色和结构化说话人", async (t) => {
  const storyFixture = () => mockFullStory({
    ...input,
    variant: {
      id: "V1",
      characterSetup: {
        protagonist: "阿岚，社区修理师",
        careRecipient: "独居老人",
        helper: "夜班便利店员"
      }
    }
  });

  await t.test("visibleAction 提到锁定角色但 characters 缺失时失败", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "阿岚观察窗边的灯光。",
      dialogue: [],
      shotAndSound: "固定机位记录室内环境。"
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      /visibleAction.*标准角色「阿岚」.*characters/u
    );
  });

  await t.test("shotAndSound 提到锁定角色但 characters 缺失时失败", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶抚摸墙上的光斑。",
      dialogue: [],
      shotAndSound: "特写阿岚靠在老人膝边的侧脸。"
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      /shotAndSound.*标准角色「阿岚」.*characters/u
    );
  });

  await t.test("对白正文和非视觉字段谈论不在场角色时不误报", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶独自望向门外，手指轻触墙上的光斑。",
      dialogue: [{
        speaker: "吴奶奶",
        line: "阿岚已经回家了吗？",
        deliveryOrSubtext: "谈论不在场的人。"
      }],
      shotAndSound: "单人近景，保留室内环境声。",
      dramaticFunction: "表现阿岚不在场时留下的情绪回响。",
      emotionNode: "想起阿岚后的安心",
      shootingNotes: "不要让阿岚在画面中出现。"
    });
    assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  });

  await t.test("结构化说话人必须存在于 characters", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶望向门外。",
      dialogue: [{
        speaker: "张姨",
        line: "门外已经安静了。",
        deliveryOrSubtext: "平静"
      }],
      shotAndSound: "单人固定近景。"
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      /dialogue\[0\]\.speaker.*张姨.*characters/u
    );
  });

  await t.test("未登记场次型配角允许使用", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["张姨", "放学孩童们"],
      visibleAction: "张姨带着放学孩童们从巷口经过。",
      dialogue: [{
        speaker: "张姨",
        line: "慢一点走。",
        deliveryOrSubtext: "提醒孩子"
      }],
      shotAndSound: "中景记录两类临时配角经过。"
    });
    assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  });

  await t.test("shotAndSound 里的画外声音登记后通过，不登记仍失败", () => {
    const offscreenScene = {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶把凉透的汤端回灶台。",
      dialogue: [],
      shotAndSound: "屋外传来阿岚喊吴奶奶来吃饭的声音，画面始终停在灶台。"
    };

    const registered = storyFixture();
    Object.assign(registered.sceneScript[0], {
      ...offscreenScene,
      offscreenSoundSources: ["阿岚"]
    });
    assert.doesNotThrow(() => ensureOutputContract(registered, "fullStory"));

    // 不登记时语义仍然无法确定，必须保持失败——放行的是显式声明，不是这句话的写法。
    const unregistered = storyFixture();
    Object.assign(unregistered.sceneScript[0], offscreenScene);
    assert.throws(
      () => ensureOutputContract(unregistered, "fullStory"),
      /shotAndSound.*标准角色「阿岚」.*offscreenSoundSources/u
    );
  });

  await t.test("登记为画外声源不能豁免 visibleAction，出镜仍必须写进 characters", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      // 登记成声源，却又写进 visibleAction：这是把登记当免检后门，必须失败。
      visibleAction: "阿岚推门进来接过吴奶奶手里的汤碗。",
      dialogue: [],
      shotAndSound: "中景记录交接动作。",
      offscreenSoundSources: ["阿岚"]
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      /visibleAction.*标准角色「阿岚」.*characters 未包含该精确名称/u
    );
  });

  await t.test("同一角色不得同时出现在 characters 与 offscreenSoundSources", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶", "阿岚"],
      visibleAction: "阿岚陪吴奶奶收拾灶台。",
      dialogue: [],
      shotAndSound: "双人中景。",
      offscreenSoundSources: ["阿岚"]
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => detail.code === "FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE")
    );
  });

  await t.test("画外声源同样必须使用精确标准名", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶望向门外。",
      dialogue: [],
      shotAndSound: "屋外传来阿岚（社区修理师）的招呼声。",
      offscreenSoundSources: ["阿岚（社区修理师）"]
    });
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => (
          detail.code === "FULL_STORY_SCENE_CHARACTER_NAME_INEXACT"
          && detail.path.includes("offscreenSoundSources")
        ))
    );
  });

  await t.test("登记了但 shotAndSound 没提到该角色仍然合法", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: ["吴奶奶"],
      visibleAction: "吴奶奶擦拭窗台。",
      dialogue: [],
      shotAndSound: "单人近景，保留环境声。",
      offscreenSoundSources: ["阿岚"]
    });
    // 登记本身不产生视觉事实；强制它必须被引用会让一次措辞改动变成契约失败。
    assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  });

  await t.test("不带 offscreenSoundSources 的旧 Story 行为不变", () => {
    const story = storyFixture();
    assert.equal(Object.prototype.hasOwnProperty.call(story.sceneScript[0], "offscreenSoundSources"), false);
    assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  });

  await t.test("无人出镜的空镜使用空数组是合法的", () => {
    const emptyScenes = [
      { visibleAction: "雨水顺着空院子的屋檐落进水缸，地面积起一圈涟漪。", shotAndSound: "固定远景，只有雨声。" },
      { visibleAction: "桌面上的旧收音机指示灯缓慢闪烁。", shotAndSound: "微距特写，电流底噪。" },
      { visibleAction: "门轻轻合上，屋里只剩下还在晃动的门帘。", shotAndSound: "固定中景，脚步声渐远。" }
    ];
    for (const scene of emptyScenes) {
      const story = storyFixture();
      Object.assign(story.sceneScript[0], { ...scene, characters: [], dialogue: [] });
      assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
    }
  });

  await t.test("空镜场次仍可登记画外声源", () => {
    const story = storyFixture();
    Object.assign(story.sceneScript[0], {
      characters: [],
      visibleAction: "空院子里的水缸接住屋檐落下的雨。",
      dialogue: [],
      shotAndSound: "屋内传来阿岚收拾工具的声响，画面始终停在院子里。",
      offscreenSoundSources: ["阿岚"]
    });
    assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  });

  await t.test("空数组不会放过真正出镜的角色", () => {
    const withVisibleCharacter = storyFixture();
    Object.assign(withVisibleCharacter.sceneScript[0], {
      characters: [],
      visibleAction: "阿岚推门进来收起院子里的工具。",
      dialogue: [],
      shotAndSound: "中景跟随。"
    });
    assert.throws(
      () => ensureOutputContract(withVisibleCharacter, "fullStory"),
      /visibleAction.*标准角色「阿岚」/u
    );

    const withDialogue = storyFixture();
    Object.assign(withDialogue.sceneScript[0], {
      characters: [],
      visibleAction: "雨水落进院子里的水缸。",
      dialogue: [{ speaker: "阿岚", line: "又下雨了。", deliveryOrSubtext: "自言自语" }],
      shotAndSound: "固定远景。"
    });
    assert.throws(
      () => ensureOutputContract(withDialogue, "fullStory"),
      /dialogue\[0\]\.speaker.*阿岚.*characters/u
    );
  });

  await t.test("整片一个角色都不出镜时失败", () => {
    const story = storyFixture();
    story.sceneScript.forEach((scene) => Object.assign(scene, {
      characters: [],
      visibleAction: "雨水落进院子里的水缸。",
      dialogue: [],
      shotAndSound: "固定远景。"
    }));
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => (
          detail.code === "FULL_STORY_NO_VISIBLE_CHARACTER_SCENE"
          && detail.path === "fullStory.sceneScript"
        ))
    );
  });
});

test("标准角色说明后缀使用锚定分隔符诊断且不误伤独立前缀名称", () => {
  const story = mockFullStory({
    ...input,
    variant: {
      id: "V1",
      characterSetup: {
        protagonist: "阿岚，社区修理师",
        careRecipient: "独居老人",
        helper: "夜班便利店员"
      }
    }
  });
  Object.assign(story.sceneScript[0], {
    characters: ["阿岚（社区修理师）"],
    visibleAction: "阿岚（社区修理师）整理工具。",
    dialogue: [],
    shotAndSound: "阿岚（社区修理师）的手部特写。"
  });
  assert.throws(
    () => ensureOutputContract(story, "fullStory"),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.code === "FULL_STORY_SCENE_CHARACTER_NAME_INEXACT")
  );

  const independentName = mockFullStory({
    ...input,
    variant: {
      id: "V1",
      characterSetup: {
        protagonist: "阿岚，社区修理师",
        careRecipient: "独居老人",
        helper: "夜班便利店员"
      }
    }
  });
  Object.assign(independentName.sceneScript[0], {
    characters: ["阿岚莎"],
    visibleAction: "阿岚莎独自整理桌上的物品。",
    dialogue: [],
    shotAndSound: "阿岚莎的手部固定特写。"
  });
  assert.doesNotThrow(() => ensureOutputContract(independentName, "fullStory"));
});

test("角色边界提示词不再读简报，原片表面表达直接取自原片分析与脚本还原", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q 版狼耳少女，形象类似于猫娘，猫一样的耳朵，整体性格活泼可爱，懂事，学生/村民 · 村里的热心帮手",
    vertical: "治愈/温情/日常/日系 2.5D 新海诚光景风格",
    constraints: "小白子基本只用嗷或嗷呜表达情绪"
  };
  // 简报里放一个旧形状的 protectedExpressions 与新形状的 recastTest，两者都不得进入边界提示词：
  // recastTest.collapses 写的是原片主角的动作，放进来有被签成固定角色性格的风险。
  const creativeBrief = {
    ...mockBrief(),
    recastTest: { recastAs: "怕出洋相的孩子", collapses: ["RECAST_COLLAPSE_SENTINEL"], survives: ["送到东西"] },
    protectedExpressions: [{ expressionType: "身份外壳", sourceExpression: "BRIEF_SURFACE_SENTINEL", prohibition: "", safeAlternativePrinciple: "" }]
  };
  const guardrailsPrompt = visualGuardrailsPrompt({
    creatorProfile,
    referenceAnalysis: { storySynopsis: "原片主角承担快递任务" },
    sourceScriptReconstruction: { relationshipPattern: "任务执行者连接村民" },
    creativeBrief
  });
  assert.equal(guardrailsPrompt.includes("RECAST_COLLAPSE_SENTINEL"), false);
  assert.equal(guardrailsPrompt.includes("BRIEF_SURFACE_SENTINEL"), false);
  assert.equal(guardrailsPrompt.includes("creativeBrief"), false);
  assert.match(guardrailsPrompt, /原片主角承担快递任务/u);
  assert.match(guardrailsPrompt, /sourceSimilarityRules 只收录 referenceAnalysis、sourceScriptReconstruction 中真实出现的/u);
  assert.match(guardrailsPrompt, /"sourcePath":"sourceScriptReconstruction\.scenes\[0\]\.keyProps\[0\]"/u);
  assert.match(guardrailsPrompt, /每一项都必须重复完整中心名词/u);
  // 去掉简报后，原片表面表达的短词表改由服务端从 keyProps 逐字摘录：回放里模型从长句自己摘，
  // 2/5 次写出原文没有的简称被逐字绑定闸门拦下；09-19 那批 82% 的证据引用的是简报的那份短词表。
  const catalogPrompt = visualGuardrailsPrompt({
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: { scenes: [{ keyProps: ["企鹅装", "橘子"] }, { keyProps: ["橘子", "", "绿色挎包"] }] },
    creativeBrief
  });
  const catalog = catalogPrompt.slice(catalogPrompt.indexOf("原片表面表达候选"), catalogPrompt.indexOf("判断规则："));
  assert.deepEqual(catalog.split("\n").filter((line) => line.startsWith("- ")), [
    "- sourceScriptReconstruction.scenes[0].keyProps[0]：企鹅装",
    "- sourceScriptReconstruction.scenes[0].keyProps[1]：橘子",
    "- sourceScriptReconstruction.scenes[1].keyProps[2]：绿色挎包"
  ]);
  assert.match(catalogPrompt, /sourceExpression 原样抄冒号右边的原文/u);
  assert.match(visualGuardrailsPrompt({ creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} }), /（脚本还原没有记录场次道具）/u);

  // 演示模式与 live 同口径：规则逐字来自还原稿的 keyProps，能过同类物品逐字绑定校验。
  const sourceScriptReconstruction = {
    scenes: [{ keyProps: ["任务物", "雨伞"] }, { keyProps: ["任务物", "风车"] }]
  };
  const guardrails = ensureVisualGuardrailsMatchesProfile(
    ensureOutputContract(mockVisualGuardrails({ ...input, creatorProfile, creativeBrief, sourceScriptReconstruction }), "visualGuardrails"),
    creatorProfile
  );
  assert.deepEqual(guardrails.sourceSimilarityRules.map((rule) => rule.sourceExpression), ["任务物", "雨伞", "风车"]);
  assert.deepEqual(guardrails.sourceSimilarityRules.map((rule) => rule.triggerEvidence[0].sourcePath), [
    "sourceScriptReconstruction.scenes[0].keyProps[0]",
    "sourceScriptReconstruction.scenes[0].keyProps[1]",
    "sourceScriptReconstruction.scenes[1].keyProps[1]"
  ]);
});

test("creativeBrief 契约失败时 fail closed：只调用一次，不把失败候选发回模型", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return invalidBriefFixture("UNRELATED_CREATIVE_BRIEF_SENTINEL");
      }
    }
  });

  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.code === "CREATIVE_BRIEF_UNEXPECTED_FIELD")
  );
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].includes("UNRELATED_CREATIVE_BRIEF_SENTINEL"), false);
});

test("主题变体必须锁定用户指定固定角色，不能另起主角名", async () => {
  const workflow = new WorkflowService({
    client: {
      async generateJson({ prompt }) {
        const sourceResponse = variantSourceResponse(prompt);
        if (sourceResponse) return sourceResponse;
        return { variants: [{
          id: "V1",
          title: "磁带里的歌声",
          oneLineHook: "小雨送音乐盒给退休老师。",
          logline: "小雨受父母委托，将音乐盒送给独居老人。",
          verticalFit: "温情日常",
          characterSetup: { protagonist: "小雨，小学生", careRecipient: "退休老师", helper: "邻居" },
          newTask: "送音乐盒",
          emotionalMedium: "磁带",
          environmentPressure: "黄昏",
          narrativeMode: "dramatic",
          keyChoiceBeat: 2,
          climaxBeat: 4,
          keyChoice: "小雨选择独自把音乐盒送到退休老师家。",
          climax: "小雨在天黑前按响退休老师家的门铃。",
          emotionalPayoff: "老师收到音乐盒后确认自己仍被学生记得。",
          novelty: "用音乐盒送达任务连接师生关系。",
          visualPotential: "黄昏街道、音乐盒与烤红薯形成可见对照。",
          storyOutline: [
            { beat: 1, phase: "任务", action: "小雨接过音乐盒出发", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 },
            { beat: 2, phase: "抉择", action: "小雨选择独自把音乐盒送到退休老师家。", emotion: "犹豫", dramaticFunction: "主角亲自作出关键选择", estimatedSeconds: 8 },
            { beat: 3, phase: "后果", action: "小雨记下老师家的门牌号，独自穿过黄昏的街道。", emotion: "紧张", dramaticFunction: "选择造成的直接后果，使高潮成为可能", estimatedSeconds: 8 },
            { beat: 4, phase: "高潮", action: "小雨在天黑前按响退休老师家的门铃。", emotion: "紧张", dramaticFunction: "主角亲手完成决定性动作并产生可见结果", estimatedSeconds: 8 },
            { beat: 5, phase: "兑现", action: "老师收到音乐盒后确认自己仍被学生记得。", emotion: "释然", dramaticFunction: "把积累的关系与情绪转化为可见状态变化", estimatedSeconds: 6 }
          ],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "老师请小雨吃红薯",
          transformationProof: {
            changedCharacters: { source: "帮助者", replacement: "改为学生与退休老师" },
            changedTask: { source: "完成送达或照料", replacement: "改为送音乐盒" },
            changedDetailsAndProps: { source: "任务物", replacement: "使用磁带与红薯" },
            changedDialogue: { source: "对白稀少，以动作体现坚持", replacement: "使用师生口吻" },
            changedVisualExpression: { source: "近景与物件特写", replacement: "使用黄昏街道" }
          },
          experienceFidelity: { positioning: "温情日常", audience: "关系共鸣受众", emotion: "期待到温暖", plotDriver: "限时送达", highValueBeats: "任务、送达、回应" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "保留通用送达结构", mitigation: "更换人物关系与任务媒介" }
        }] };
      }
    }
  });
  await assert.rejects(
    () => workflow.createVariants(globalBoundaryContext(workflow, {
      creativeBrief: {},
      creatorProfile: { fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事", vertical: "温情/日常" },
      count: 1
    })),
    OutputContractError
  );
});

test("主题变体允许按剧情复用原片角色组合，但不覆盖固定主角", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  (creativeBrief.protectedExpressions ??= []).push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const workflow = new WorkflowService({
    client: {
      async generateJson({ prompt }) {
        const sourceResponse = variantSourceResponse(prompt);
        if (sourceResponse) return sourceResponse;
        return { variants: [{
          id: "V1",
          title: "雾中画境",
          oneLineHook: "小白子冒雾送画，企鹅服志愿者在村口引路。",
          logline: "小白子被委托将画作送到山村女孩手中，途中获得企鹅服志愿者的帮助。",
          verticalFit: "治愈/温情/日常",
          characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "企鹅服志愿者老张" },
          newTask: "送画作",
          emotionalMedium: "儿童画",
          environmentPressure: "大雾",
          narrativeMode: "dramatic",
          keyChoiceBeat: 2,
          climaxBeat: 4,
          keyChoice: "小白子选择接受志愿者指路，但坚持亲自把画送到小月手中。",
          climax: "小白子穿过最后一段浓雾，把完好的画亲手交给小月。",
          emotionalPayoff: "小月确认自己的画被认真对待，小白子也接受同行者的善意。",
          novelty: "让来源角色组合成为不替主角完成任务的独立帮助者。",
          visualPotential: "大雾、背包中的画与抵达后摆正画作形成清晰状态变化。",
          storyOutline: [
            { beat: 1, phase: "任务", action: "小白子整理背包，跟着企鹅服志愿者老张出发。", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 },
            { beat: 2, phase: "抉择", action: "小白子选择接受志愿者指路，但坚持亲自把画送到小月手中。", emotion: "犹豫", dramaticFunction: "主角亲自作出关键选择", estimatedSeconds: 8 },
            { beat: 3, phase: "后果", action: "小白子把画收进背包内层，按老张指的近路继续走。", emotion: "紧张", dramaticFunction: "选择造成的直接后果，使高潮成为可能", estimatedSeconds: 8 },
            { beat: 4, phase: "高潮", action: "小白子穿过最后一段浓雾，把完好的画亲手交给小月。", emotion: "紧张", dramaticFunction: "主角亲手完成决定性动作并产生可见结果", estimatedSeconds: 8 },
            { beat: 5, phase: "兑现", action: "小月确认自己的画被认真对待，小白子也接受同行者的善意。", emotion: "释然", dramaticFunction: "把积累的关系与情绪转化为可见状态变化", estimatedSeconds: 6 }
          ],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "小白子与小月一起把画作摆正。",
          transformationProof: {
            changedCharacters: { source: "帮助者", replacement: "固定主角保持小白子" },
            changedTask: { source: "完成送达或照料", replacement: "改为送画作" },
            changedDetailsAndProps: { source: "任务物", replacement: "使用儿童画与背包" },
            changedDialogue: { source: "对白稀少，以动作体现坚持", replacement: "使用新关系对白" },
            changedVisualExpression: { source: "近景与物件特写", replacement: "使用雾中山村" }
          },
          experienceFidelity: { positioning: "治愈日常", audience: "关系共鸣受众", emotion: "期待到温暖", plotDriver: "雾中送达", highValueBeats: "任务、帮助、兑现" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "保留通用帮助结构", mitigation: "任务与关系表达重新设计" }
        }] };
      }
    }
  });

  const result = await workflow.createVariants(
    globalBoundaryContext(workflow, { creativeBrief, creatorProfile, count: 1 })
  );
  assert.equal(result.variants[0].characterSetup.protagonist, "小白子，小女孩");
  assert.match(JSON.stringify(result.variants[0]), /企鹅服志愿者/u);
});

test("主题变体允许按剧情复用 mustChange 来源道具", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  (creativeBrief.controlledRewriteVariables ??= []).push(
    {
      variable: "送达物品",
      sourceValue: "录取通知书",
      allowedDirections: ["改成儿童画、风车或手写卡片"],
      mustChange: true,
      reason: "原片具体道具必须替换。"
    },
    {
      variable: "结尾仪式",
      sourceValue: "孔明灯（许愿灯）",
      allowedDirections: ["改成风筝、风车或手绘明信片"],
      mustChange: true,
      reason: "原片结尾道具必须替换。"
    }
  );
  const workflow = new WorkflowService({
    client: {
      async generateJson({ prompt }) {
        const sourceResponse = variantSourceResponse(prompt);
        if (sourceResponse) return sourceResponse;
        return { variants: [{
          id: "V1",
          title: "灯下通知",
          oneLineHook: "小白子送来录取通知书。",
          logline: "小白子赶在天黑前把录取通知书送到邻居家。",
          verticalFit: "治愈/温情/日常",
          characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "老张" },
          newTask: "送录取通知书",
          emotionalMedium: "录取通知书",
          environmentPressure: "大雾",
          narrativeMode: "dramatic",
          keyChoiceBeat: 2,
          climaxBeat: 4,
          keyChoice: "小白子选择在大雾中继续亲自送达录取通知书。",
          climax: "小白子赶在天黑前把录取通知书交到邻居手中。",
          emotionalPayoff: "邻居收到通知书后与小白子确认共同庆祝的约定。",
          novelty: "在当前剧情需要下直接复用来源道具，但重新设计因果与关系。",
          visualPotential: "大雾、通知书封套与孔明灯升起形成连续可见动作。",
          storyOutline: [
            { beat: 1, phase: "任务", action: "小白子抱着录取通知书出发。", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 },
            { beat: 2, phase: "抉择", action: "小白子选择在大雾中继续亲自送达录取通知书。", emotion: "犹豫", dramaticFunction: "主角亲自作出关键选择", estimatedSeconds: 8 },
            { beat: 3, phase: "后果", action: "小白子把通知书塞进外套护住，凭记忆认路前行。", emotion: "紧张", dramaticFunction: "选择造成的直接后果，使高潮成为可能", estimatedSeconds: 8 },
            { beat: 4, phase: "高潮", action: "小白子赶在天黑前把录取通知书交到邻居手中。", emotion: "紧张", dramaticFunction: "主角亲手完成决定性动作并产生可见结果", estimatedSeconds: 8 },
            { beat: 5, phase: "兑现", action: "邻居收到通知书后与小白子确认共同庆祝的约定。", emotion: "释然", dramaticFunction: "把积累的关系与情绪转化为可见状态变化", estimatedSeconds: 6 }
          ],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "两人一起放孔明灯。",
          transformationProof: {
            changedCharacters: { source: "帮助者", replacement: "固定主角保持小白子" },
            changedTask: { source: "完成送达或照料", replacement: "当前剧情使用录取通知书送达" },
            changedDetailsAndProps: { source: "任务物", replacement: "使用通知书与孔明灯" },
            changedDialogue: { source: "对白稀少，以动作体现坚持", replacement: "使用邻里口吻" },
            changedVisualExpression: { source: "近景与物件特写", replacement: "使用雾中村路" }
          },
          experienceFidelity: { positioning: "治愈日常", audience: "关系共鸣受众", emotion: "期待到庆祝", plotDriver: "限时送达", highValueBeats: "任务、抵达、庆祝" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "可能复用来源道具", mitigation: "因果、人物关系与动作重新设计" }
        }] };
      }
    }
  });

  const result = await workflow.createVariants(
    globalBoundaryContext(workflow, { creativeBrief, creatorProfile, count: 1 })
  );
  assert.match(result.variants[0].newTask, /录取通知书/u);
  assert.match(result.variants[0].endingRitual, /孔明灯/u);
});

test("完整剧情允许配角与 visibleAction 复用原片角色组合", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  (creativeBrief.protectedExpressions ??= []).push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const variant = {
    id: "V1",
    title: "雾中画境",
    characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "老张" },
    newTask: "送画作",
    emotionalMedium: "儿童画",
    environmentPressure: "大雾",
    endingRitual: "把儿童画摆正"
  };
  const leakedStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  leakedStory.characterBible.helpers[0].functionInStory = "穿企鹅服帮小白子在雾中引路";
  leakedStory.sceneScript[0].characters.push("老张");
  leakedStory.sceneScript[0].visibleAction = "老张穿着企鹅服在雾中引路，小白子跟着他准备出发。";
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        return isFullStoryBeatScenePostpassPrompt(args.prompt)
          ? fullStoryBeatScenePassResponse(leakedStory)
          : structuredClone(leakedStory);
      }
    },
    storyModel: "mimo-v2.5-pro"
  });
  const result = await workflow.createFullStory(
    globalBoundaryContext(workflow, { creativeBrief, creatorProfile, variant })
  );
  assert.match(result.characterBible.helpers[0].functionInStory, /企鹅服/u);
  assert.match(result.sceneScript[0].visibleAction, /企鹅服/u);
});

test("完整剧情允许在 visibleAction 或避相似说明中使用 mustChange 来源道具", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  (creativeBrief.controlledRewriteVariables ??= []).push(
    {
      variable: "送达物品",
      sourceValue: "录取通知书",
      allowedDirections: ["改成儿童画、风车或手写卡片"],
      mustChange: true,
      reason: "原片具体道具必须替换。"
    },
    {
      variable: "结尾仪式",
      sourceValue: "孔明灯（许愿灯）",
      allowedDirections: ["改成风筝、风车或手绘明信片"],
      mustChange: true,
      reason: "原片结尾道具必须替换。"
    }
  );
  const variant = {
    id: "V1",
    title: "雾中画境",
    characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "老张" },
    newTask: "送儿童画",
    emotionalMedium: "儿童画",
    environmentPressure: "大雾",
    endingRitual: "一起把风筝线系好"
  };
  const leakedStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  leakedStory.sceneScript[0].visibleAction = "小白子抱着录取通知书出发，约好晚上放孔明灯。";
  const safeStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  safeStory.keyProps[0].avoidSimilarityNote = "避免录取通知书和孔明灯，改用儿童画与风筝完成同类情绪功能。";

  const leakedWorkflow = new WorkflowService({
    client: {
      async generateJson(args) {
        return isFullStoryBeatScenePostpassPrompt(args.prompt)
          ? fullStoryBeatScenePassResponse(leakedStory)
          : structuredClone(leakedStory);
      }
    },
    storyModel: "mimo-v2.5-pro"
  });
  const leakedResult = await leakedWorkflow.createFullStory(
    globalBoundaryContext(leakedWorkflow, { creativeBrief, creatorProfile, variant })
  );
  assert.match(leakedResult.sceneScript[0].visibleAction, /录取通知书/u);
  assert.match(leakedResult.sceneScript[0].visibleAction, /孔明灯/u);

  assert.doesNotThrow(() => ensureOutputContract(safeStory, "fullStory"));
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(safeStory, creatorProfile, creativeBrief, variant));
});

test("完整剧情无可信局部路径的语义失败不会自动发送完整 Story 重写", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  (creativeBrief.protectedExpressions ??= []).push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，狼耳少女", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const leakedStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  leakedStory.characterBible.protagonist.signatureBehaviors = ["狼爪肉垫轻拍表示开心"];
  leakedStory.sceneScript[0].visibleAction = "小白子用狼爪扶住风车，肉垫清晰可见。";
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return leakedStory;
      }
    }
  });

  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(
      workflow,
      { creativeBrief, creatorProfile, variant },
      xiaobaiziBoundary()
    )),
    /狼爪|肉垫/u
  );
  assert.equal(prompts.length, 1);
});

test("Scene Contract 跨字段失败没有唯一事实来源时只调用一次并 fail closed", async () => {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const creativeBrief = mockBrief({
    ...input,
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "独居老人",
      helper: "夜班便利店员"
    },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const invalidStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  invalidStory.sceneScript[3].location = "";
  invalidStory.sceneScript[3].characters = [];
  invalidStory.sceneScript[3].visibleAction = "";
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return structuredClone(invalidStory);
      }
    }
  });

  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, {
      creativeBrief,
      creatorProfile,
      variant
    })),
    /fullStory Scene Contract 校验失败/u
  );
  assert.equal(prompts.length, 1);
});

test("真实三子树混合结构错误因语义目的地不唯一而 fail closed", async () => {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile });
  const variant = {
    id: "V1",
    title: "雨棚下的收音机",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "铃木奶奶", helper: "夜班便利店员" },
    newTask: "修好旧收音机",
    emotionalMedium: "一台旧收音机",
    environmentPressure: "暴雨停电",
    endingRitual: "铃木奶奶按下播放键"
  };
  const malformed = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  malformed.title = "UNRELATED_FULL_STORY_SENTINEL";
  malformed.characterBible.protagonist["困倦时狼耳微微耷拉"] = "";
  malformed.characterBible.protagonist["感激时用力抱紧物品并发出长长的"] = "";
  delete malformed.beatSheet[4].emotion;
  delete malformed.beatSheet[4].dramaticFunction;
  delete malformed.beatSheet[4].retainedValueFromBrief;
  malformed.beatSheet[4]["村民们迅速从四面八方赶来并搭起油布棚"] = "";
  malformed.beatSheet[4]["感动、温暖、强烈的归属感与安全感"] = "";
  malformed.beatSheet[4]["天气突变催化全村集体行动"] = "";
  malformed.sceneScript[2]["脱背心和盖背心的动作要格外轻柔"] = "";
  const frozen = structuredClone(malformed);
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return structuredClone(malformed);
      }
    }
  });
  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, {
      creativeBrief,
      creatorProfile,
      variant
    })),
    /fullStory 结构校验失败/u
  );
  assert.equal(prompts.length, 1);
  assert.deepEqual(malformed, frozen);
});

test("签发固定角色姓名缺失时只发送 protagonist 子树并完成合并", async () => {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile });
  const variant = {
    id: "V1",
    title: "雨棚下的收音机",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "铃木奶奶",
      helper: "夜班便利店员"
    },
    newTask: "修好旧收音机",
    emotionalMedium: "一台旧收音机",
    environmentPressure: "暴雨停电",
    endingRitual: "铃木奶奶按下播放键"
  };
  const malformed = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  malformed.title = "WORKFLOW_OUTSIDE_TARGET_SENTINEL";
  delete malformed.characterBible.protagonist.name;
  const frozen = structuredClone(malformed);
  const repairedStory = structuredClone(malformed);
  repairedStory.characterBible.protagonist.name = "阿岚";
  const prompts = [];
  const debugEvents = [];
  const partialRepairDebugWriter = {
    async begin(payload) {
      debugEvents.push({ phase: "begin", payload });
      return { repairSessionId: "full-story-debug" };
    },
    async recordResponse(session, response) {
      debugEvents.push({ phase: "response", session, response });
    },
    async recordResult(session, result) {
      debugEvents.push({ phase: "result", session, result });
    }
  };
  const workflow = new WorkflowService({
    partialRepairDebugWriter,
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (prompts.length === 1) return structuredClone(malformed);
        if (isFullStoryBeatScenePostpassPrompt(args.prompt)) {
          assert.match(args.prompt, /WORKFLOW_OUTSIDE_TARGET_SENTINEL/u);
          return fullStoryBeatScenePassResponse(repairedStory);
        }
        assert.doesNotMatch(args.prompt, /WORKFLOW_OUTSIDE_TARGET_SENTINEL/u);
        const targets = JSON.parse(
          args.prompt.match(/待修子树：\n(\[[\s\S]*?\])\n\n只返回以下精确 JSON 协议/u)[1]
        );
        assert.deepEqual(targets.map((target) => target.path), ["/characterBible/protagonist"]);
        const protagonist = structuredClone(malformed.characterBible.protagonist);
        protagonist.name = targets[0].expectedFields.name;
        return {
          schemaVersion: "full_story_partial_repair/1.0",
          baseDigest: args.prompt.match(/"baseDigest":"([a-f0-9]{64})"/u)?.[1],
          repairs: [{ repairId: targets[0].repairId, replacement: protagonist }]
        };
      }
    }
  });

  const result = await workflow.createFullStory(globalBoundaryContext(workflow, {
    creativeBrief,
    creatorProfile,
    variant
  }));
  assert.equal(prompts.length, 3);
  assert.equal(result.title, "WORKFLOW_OUTSIDE_TARGET_SENTINEL");
  assert.equal(result.characterBible.protagonist.name, "阿岚");
  assert.deepEqual(malformed, frozen);
  assert.deepEqual(debugEvents.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debugEvents[0].payload.stage, "fullStory");
  assert.match(debugEvents[0].payload.originalError.message, /结构校验失败/u);
  assert.equal(debugEvents[0].payload.repairPlan.targets[0].currentValue.name, undefined);
  assert.equal(debugEvents[2].result.status, "repaired");
});

test("Full Story 局部修复即使协调器预算更高也严格禁止第三次调用", async () => {
  const creatorProfile = input.creatorProfile;
  const creativeBrief = mockBrief({ ...input, creatorProfile });
  const variant = mockVariants({ ...input, creatorProfile, creativeBrief }).variants[0];
  const invalid = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  delete invalid.characterBible.protagonist.name;
  let calls = 0;
  const workflow = new WorkflowService({
    modelCallCoordinator: new ModelCallCoordinator({ maxProviderCalls: 4 }),
    client: {
      async generateJson() {
        calls += 1;
        return structuredClone(invalid);
      }
    }
  });
  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, creatorProfile, variant })),
    /fullStory|局部修复/u
  );
  assert.equal(calls, 2);
});

test("Full Story 局部修复第二次仍失败时终止且不产生第三次请求", async () => {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const creativeBrief = mockBrief({
    ...input,
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "独居老人",
      helper: "夜班便利店员"
    },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const invalidStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  delete invalidStory.characterBible.protagonist.name;
  let calls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        calls += 1;
        if (calls > 2) throw new Error("禁止第三次完整剧情请求");
        if (calls === 1) return structuredClone(invalidStory);
        const targets = JSON.parse(args.prompt.match(/待修子树：\n(\[[\s\S]*?\])\n\n只返回以下精确 JSON 协议/u)[1]);
        const replacement = structuredClone(invalidStory.characterBible.protagonist);
        return {
          schemaVersion: "full_story_partial_repair/1.0",
          baseDigest: args.prompt.match(/"baseDigest":"([a-f0-9]{64})"/u)?.[1],
          repairs: targets.map((target) => ({
            repairId: target.repairId,
            replacement
          }))
        };
      }
    }
  });

  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, {
      creativeBrief,
      creatorProfile,
      variant
    })),
    /局部修复/u
  );
  assert.equal(calls, 2);
});

test("4.0 分镜入口在任何模型调用前拒绝残缺 Full Story", async () => {
  const context = {
    creatorProfile: {
      fixedCharacter: "阿岚，社区修理师",
      vertical: "家电维修",
      constraints: "60 秒内"
    }
  };
  const creativeBrief = mockBrief({
    ...context,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "独居老人",
      helper: "夜班便利店员"
    },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = mockFullStory({ ...context, creativeBrief, variant });
  fullStory.sceneScript[3].location = "";
  fullStory.sceneScript[3].characters = [];
  fullStory.sceneScript[3].visibleAction = "";
  let modelCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        modelCalls += 1;
        throw new Error("残缺 Full Story 不得调用任何模型");
      }
    }
  });

  await assert.rejects(
    () => workflow.createAnimationPlan(globalBoundaryContext(workflow, {
      ...context,
      creativeBrief,
      variant,
      fullStory,
      animationPlanVersion: "4.0"
    })),
    /fullStory Scene Contract 校验失败/u
  );
  assert.equal(modelCalls, 0);
});

test("全局边界接受模型生成的新概念与同义词，不依赖本地物种词典", () => {
  const creatorProfile = { fixedCharacter: "澄星，星海信使", vertical: "幻想日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = {
    schemaVersion: "2.0",
    characterName: "澄星",
    canonicalDescription: "具备水晶触角的星海信使。",
    bodyForm: "人形角色。",
    requiredTraits: [
      boundaryTrait("澄星", [], "identity"),
      boundaryTrait("水晶触角", ["晶体感应须", "星光触须"], "appearance", "inferred")
    ],
    allowedTraits: [],
    forbiddenTraits: [],
    unresolvedConflicts: []
  };
  raw.fixedCharacterBoundary.requiredTraits[1].terms = ["晶体感应须", "星光触须"];
  const guardrails = ensureVisualGuardrailsMatchesProfile(
    ensureOutputContract(materializeGlobalCharacterBoundaryViews(
      normalizeGlobalCharacterBoundaryTerms(raw),
      creatorProfile
    ), "visualGuardrails"),
    creatorProfile
  );
  assert.deepEqual(guardrails.fixedCharacterBoundary.requiredTraits[1].terms, ["水晶触角", "晶体感应须", "星光触须"]);
});

test("角色边界术语归一化不会掩盖要求与禁止冲突", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = xiaobaiziBoundary({ forbidClaws: false });
  raw.fixedCharacterBoundary.requiredTraits[2].terms = ["狼尾巴"];
  raw.fixedCharacterBoundary.forbiddenTraits.push({
    ...boundaryTrait("狼尾", ["尾巴"], "appearance", "explicit"),
    terms: ["尾巴"]
  });
  assert.throws(
    () => ensureOutputContract(
      materializeGlobalCharacterBoundaryViews(normalizeGlobalCharacterBoundaryTerms(raw), creatorProfile),
      "visualGuardrails"
    ),
    /同时要求并禁止：required「狼尾」包含 forbidden「狼尾」/u
  );
});

// 判定必须与下游扫描器同口径（子串），否则模型服从 required 就自动违反 forbidden。
// 2026-09-05 实测：「无头饰」required 与「头饰」forbidden 被精确相等判为不冲突，
// 矛盾一路流到 Full Story 才炸，连续三次、约 7.6 万 token。
test("必需写法包含禁止写法的边界必须在签发时就失败（否定型）", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = xiaobaiziBoundary({ tail: "none", forbidClaws: false });
  raw.fixedCharacterBoundary.requiredTraits.push(boundaryTrait("无头饰", ["没有头饰"], "appearance"));
  raw.fixedCharacterBoundary.forbiddenTraits.push(
    boundaryTrait("头饰", ["发饰", "发夹"], "appearance", "inferred")
  );
  assert.throws(
    () => ensureOutputContract(
      materializeGlobalCharacterBoundaryViews(normalizeGlobalCharacterBoundaryTerms(raw), creatorProfile),
      "visualGuardrails"
    ),
    /同时要求并禁止：required「无头饰」包含 forbidden「头饰」/u
  );
});

// 正向型没有 allowNegativeContext 兜底：边界把「浅灰蓝色长发」列为该必需事实的可接受
// 写法之一，同时禁止「蓝色长发」，模型按边界自己认可的拼法写就会在成片渲染前硬失败。
test("必需写法包含禁止写法的边界必须在签发时就失败（正向型）", () => {
  const creatorProfile = { fixedCharacter: "小白子，浅灰蓝色长发少女", vertical: "治愈日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = xiaobaiziBoundary({ tail: "none", forbidClaws: false });
  raw.fixedCharacterBoundary.requiredTraits.push(
    boundaryTrait("浅灰蓝色长直发", ["浅灰蓝色长发", "长直发"], "appearance")
  );
  raw.fixedCharacterBoundary.forbiddenTraits.push(
    boundaryTrait("原片蓝发女孩外观", ["蓝色长发", "红色连衣裙"], "appearance", "inferred")
  );
  assert.throws(
    () => ensureOutputContract(
      materializeGlobalCharacterBoundaryViews(normalizeGlobalCharacterBoundaryTerms(raw), creatorProfile),
      "visualGuardrails"
    ),
    /同时要求并禁止：required「浅灰蓝色长发」包含 forbidden「蓝色长发」/u
  );
});

// 合法反例：反方向（forbidden ⊃ required）必须放行。文本「猫耳少女」含 required 而不含
// forbidden，两者可同时满足。回扫 95 份已签发边界，反方向碰撞 14 份且全部合法——
// 做成双向判定会误杀 15%。
test("禁止写法包含必需写法是合法边界，不得误判为冲突", () => {
  const creatorProfile = { fixedCharacter: "小白子，猫耳少女", vertical: "治愈日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = xiaobaiziBoundary({ tail: "none", forbidClaws: false });
  raw.fixedCharacterBoundary.requiredTraits.push(boundaryTrait("猫耳", [], "appearance"));
  raw.fixedCharacterBoundary.forbiddenTraits.push(
    boundaryTrait("非猫耳动物器官", ["其他兽耳"], "appearance", "inferred")
  );
  const verified = ensureOutputContract(
    materializeGlobalCharacterBoundaryViews(normalizeGlobalCharacterBoundaryTerms(raw), creatorProfile),
    "visualGuardrails"
  );
  const forbiddenNames = verified.fixedCharacterBoundary.forbiddenTraits.map((trait) => trait.canonicalName);
  assert.ok(forbiddenNames.includes("非猫耳动物器官"));
});

// allowedTraits 是可选事实，本次刻意不扩大判定范围（磁盘上 95 份边界该方向碰撞为 0）。
test("allowedTraits 包含禁止写法本次不拦截", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const raw = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  raw.fixedCharacterBoundary = xiaobaiziBoundary({ tail: "none", forbidClaws: false });
  raw.fixedCharacterBoundary.allowedTraits.push(boundaryTrait("无头饰", [], "appearance"));
  raw.fixedCharacterBoundary.forbiddenTraits.push(
    boundaryTrait("头饰", ["发饰"], "appearance", "inferred")
  );
  const verified = ensureOutputContract(
    materializeGlobalCharacterBoundaryViews(normalizeGlobalCharacterBoundaryTerms(raw), creatorProfile),
    "visualGuardrails"
  );
  assert.ok(verified.fixedCharacterBoundary.allowedTraits.some((trait) => trait.canonicalName === "无头饰"));
});

test("固定角色生成必须沿用全局事实，配角不继承主角边界，逐镜仍禁止冲突特征", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    "小白子，狼耳少女，带狼尾的全身角色参考图。",
    visualGuardrails,
    { characterName: "小白子" }
  ));
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    "邻居奶奶，灰白短发，穿棉布外套。",
    visualGuardrails,
    { characterName: "邻居奶奶" }
  ));
  assert.throws(() => ensureCharacterPromptMatchesBoundary(
    "小白子在当前镜头用狼爪抓住风车。",
    visualGuardrails,
    { requireRequiredTraits: false }
  ), /兽爪|狼爪|全局边界禁止特征/u);
});

test("角色提示词边界偏差可以只收集不抛错，短路分支与硬失败语义不变", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  const compliant = "小白子，狼耳少女，带狼尾的全身角色参考图。";
  const missing = "小白子，短发少女的全身角色参考图。";

  assert.equal(characterPromptBoundaryMismatch(compliant, visualGuardrails, { characterName: "小白子" }), "");
  const mismatch = characterPromptBoundaryMismatch(missing, visualGuardrails, { characterName: "小白子" });
  assert.match(mismatch, /^角色生成提示词未沿用全局角色边界：缺少全局必需角色事实：/u);
  assert.match(mismatch, /狼尾/u);

  // 收集器只是把同一条判定摊开，ensure 包装器对同一段文本仍然抛错。
  assert.throws(
    () => ensureCharacterPromptMatchesBoundary(missing, visualGuardrails, { characterName: "小白子" }),
    InputError
  );

  // 三个短路分支逐字保留：无边界、多角色提示词、非固定角色。
  assert.equal(characterPromptBoundaryMismatch(missing, {}, { characterName: "小白子" }), "");
  assert.equal(characterPromptBoundaryMismatch(missing, visualGuardrails, { promptScope: "multi_character" }), "");
  assert.equal(characterPromptBoundaryMismatch(missing, visualGuardrails, { characterName: "邻居奶奶" }), "");
});

test("角色生成边界允许否定提及但仍拒绝正向或转折后的禁止特征", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  visualGuardrails.fixedCharacterBoundary.forbiddenTraits.push(
    boundaryTrait("猫耳", ["猫耳朵"], "appearance", "inferred")
  );

  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    "小白子保持灰白色狼耳与狼尾，无猫耳变异。",
    visualGuardrails,
    { requireRequiredTraits: false }
  ));
  assert.throws(() => ensureCharacterPromptMatchesBoundary(
    "小白子变成猫耳少女。",
    visualGuardrails,
    { requireRequiredTraits: false }
  ), /猫耳|全局边界禁止特征/u);
  assert.throws(() => ensureCharacterPromptMatchesBoundary(
    "不得出现猫耳，但小白子实际是猫耳少女。",
    visualGuardrails,
    { requireRequiredTraits: false }
  ), /猫耳|全局边界禁止特征/u);

  const allReferenceVideoPrompt = shotVideoGenerationPromptText({
    generationMode: "all_reference",
    shot: {
      videoPrompt: "小白子保持狼耳与狼尾，抬手贴好信纸。",
      startFramePrompt: "旧首帧误写为猫耳少女。",
      endFramePrompt: "旧尾帧误写为猫尾。"
    }
  });
  assert.doesNotMatch(allReferenceVideoPrompt, /猫耳|猫尾/u);
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    allReferenceVideoPrompt,
    visualGuardrails,
    { requireRequiredTraits: false }
  ));
});

test("Variants 与 Full Story Prompt 都不机械注入来源规则", () => {
  const creatorProfile = { fixedCharacter: "小白子，q版狼耳少女，有狼尾巴", vertical: "治愈日常", constraints: "" };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  visualGuardrails.sourceSimilarityRules.push({
    text: "不得复用原片彩虹披风。",
    sourceExpression: "彩虹披风",
    triggerEvidence: [{ sourcePath: "creativeBrief.protectedExpressions[0].sourceExpression", evidence: "彩虹披风" }],
    appliesWhenReferenceUsed: true
  });
  const variant = { id: "V1", title: "风车", characterSetup: { protagonist: creatorProfile.fixedCharacter }, newTask: "送风车" };

  const variantPrompt = variantsPrompt({ creativeBrief, visualGuardrails, creatorProfile, count: 2 });
  const storyPrompt = fullStoryPrompt({ creativeBrief, visualGuardrails, referenceAnalysis: {}, sourceScriptReconstruction: {}, variant, creatorProfile });

  assert.match(variantPrompt, /positivePromptBoundary/);
  assert.match(storyPrompt, /requiredTraits/);
  assert.match(storyPrompt, /forbiddenTraits/);
  for (const prompt of [variantPrompt, storyPrompt]) {
    assert.doesNotMatch(prompt, /"sourceSimilarityRules"\s*:/u);
    assert.doesNotMatch(prompt, /彩虹披风/u);
  }
});

test("固定角色名提取把冒号当分隔符，「名字：描述」不会连描述一起当成角色名", () => {
  // 回放实际失败输入：两个角色、每个都写成「名字：描述」。
  const twoCharacters = "小白子：q 版狼耳少女，形象类似狼娘，有狐狸一样蓬松的尾巴，猫一样的耳朵；\n"
    + "芙芙猫：白色与浅蓝色相间的蓬松卷发 / 头顶卷曲呆毛 / 猫耳";
  assert.equal(extractFixedCharacterName(twoCharacters), "小白子");
  // 单个角色写成冒号一样会坏——这从来不是「一个 vs 两个」的问题。
  assert.equal(extractFixedCharacterName("小白子：q 版狼耳少女"), "小白子");
  assert.equal(extractFixedCharacterName("小白子: q 版狼耳少女"), "小白子");
  assert.equal(extractFixedCharacterName("Xiaobaizi: a wolf-eared girl"), "Xiaobaizi");

  // 合法反例：原本就能正确提取的写法逐字不变。
  assert.equal(extractFixedCharacterName("小白子，q 版狼耳少女，形象类似狼娘"), "小白子");
  assert.equal(extractFixedCharacterName("小白子 q 版狼耳少女"), "小白子");
  assert.equal(extractFixedCharacterName("小白子（q 版狼耳少女）"), "小白子");
  // 显式角色名分支在切分之前返回，不受本次改动影响。
  assert.equal(extractFixedCharacterName("角色名：小白子，q 版狼耳少女"), "小白子");
});

test("取名标签只认第一段：描述里的「叫声」「叫奶奶」「大家都叫她」不是取名", () => {
  // 2026-10-05 回归：标签词出现在描述后文时曾被当成取名标签，而 09-19 起提示词会让模型照写这个错名。
  assert.equal(extractFixedCharacterName("小白子：q版狼耳少女，银白色长发，开心时会发出嗷呜的叫声"), "小白子");
  assert.equal(extractFixedCharacterName("小白子：q版狼耳少女，喜欢叫奶奶陪她玩"), "小白子");
  assert.equal(extractFixedCharacterName("小白子，狼耳少女，大家都叫她小白"), "小白子");
  assert.equal(extractFixedCharacterName("小白子：名字是奶奶取的"), "小白子");
  // 合法反例：标签写在第一段里的照旧按标签取名。
  assert.equal(extractFixedCharacterName("她叫小白，狼耳少女"), "小白");
  assert.equal(extractFixedCharacterName("名叫小白子，狼耳少女"), "小白子");
  assert.equal(extractFixedCharacterName("姓名：小白子；狼耳少女"), "小白子");
  // 提示词下发给模型的必须是这个正确的名字。
  const creatorProfile = { ...colonProfileWithPartner, fixedCharacter: "小白子：q版狼耳少女，开心时会发出嗷呜的叫声" };
  const rules = guardrailsRuleSection(visualGuardrailsPrompt({ creativeBrief: {}, creatorProfile }));
  assert.ok(rules.includes("characterName 必须逐字写「小白子」"));
  assert.equal(rules.includes("characterName 必须逐字写「声」"), false);
});

test("冒号写法的固定角色能通过 visualGuardrails 与 creativeBrief 的固定角色校验", () => {
  const creatorProfile = {
    fixedCharacter: "小白子：q 版狼耳少女，形象类似狼娘，有狐狸一样蓬松的尾巴；\n芙芙猫：浅蓝色蓬松卷发",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const workflow = new WorkflowService({ client: {} });
  const context = globalBoundaryContext(workflow, { creatorProfile }, xiaobaiziBoundary());

  // 边界的 characterName 是「小白子」，修复前会因为固定角色名被解析成整段描述而失败。
  assert.equal(
    ensureVisualGuardrailsMatchesProfile(context.visualGuardrails, creatorProfile).fixedCharacterBoundary.characterName,
    "小白子"
  );
});

test("固定角色名提取支持中文逗号设定，variants 提示词声明不可改名", () => {
  assert.equal(extractFixedCharacterName("小白子，小女孩，儿童，活泼可爱"), "小白子");
  assert.equal(extractFixedCharacterName("阿岚，28 岁社区修理师"), "阿岚");
  const prompt = variantsPrompt({
    creativeBrief: {},
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童，活泼可爱", vertical: "温情/日常", constraints: "可以出现儿童" },
    count: 3
  });
  assert.match(prompt, /固定角色硬约束/);
  assert.match(prompt, /不得改名、换昵称、另起主角名/);
  assert.match(prompt, /小白子/);
});

test("完整剧情提示词要求围绕选中变体并锁定固定角色", () => {
  const prompt = fullStoryPrompt({
    creativeBrief: {
      controlledRewriteVariables: [
        { variable: "送达物品", sourceValue: "录取通知书", mustChange: true },
        { variable: "结尾仪式", sourceValue: "孔明灯（许愿灯）", mustChange: true }
      ],
      protectedExpressions: []
    },
    referenceAnalysis: {},
    sourceScriptReconstruction: {},
    variant: { id: "V2", title: "雨停之前" },
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童", vertical: "治愈日常", constraints: "只用嗷呜表达" }
  });
  assert.match(prompt, /mimo-v2\.5-pro/);
  assert.match(prompt, /selectedVariantId 必须等于选中的候选 id：V2/);
  assert.match(prompt, /固定角色的姓名、身份、性格和外观只沿用已签发的全局角色边界/u);
  assert.match(prompt, /不再次解析、猜测或扩展身份/u);
  assert.doesNotMatch(prompt, /录取通知书|孔明灯/u);
  assert.match(prompt, /至少一场，不设六场或其它固定下限/u);
  assert.match(prompt, /location、characters 和 visibleAction 都必须完整填写/u);
  assert.match(prompt, /speaker 必须逐字存在于同场 characters/u);
  assert.match(prompt, /不支持 offscreen、voiceOver、narrator 或 isVisible/u);
  assert.match(prompt, /只能补充，不能替代这些结构字段/u);
  assert.match(prompt, /"characters":\["标准角色名"\]/u);
});

test("本地视频命令解析角色、赛道、抽帧和变体数量", () => {
  const options = parseRunVideoArgs([
    "reference.mp4",
    "--character", "阿岚，社区修理师",
    "--vertical=家电维修",
    "--frames", "12",
    "--count", "4",
    "--require-mimo"
  ]);
  assert.equal(options.videoPath, "reference.mp4");
  assert.equal(options.character, "阿岚，社区修理师");
  assert.equal(options.vertical, "家电维修");
  assert.equal(options.frameCount, 12);
  assert.equal(options.count, 4);
  assert.equal(options.requireMimo, true);
});

test("视频工具选择稳定采样时间点并识别常见 MIME 类型", () => {
  assert.deepEqual(selectSampleTimestamps(40, 4), [5, 15, 25, 35]);
  assert.deepEqual(selectSampleTimestamps(0, 3), [0, 3, 6]);
  assert.equal(mimeTypeFor("/tmp/a.mp4"), "video/mp4");
  assert.equal(mimeTypeFor("/tmp/a.mov"), "video/quicktime");
  assert.equal(mimeTypeFor("/tmp/a.unknown"), "application/octet-stream");
});

function pickEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}


test("完整剧情提示词禁止把垂直赛道的画风词写进 location", () => {
  const prompt = fullStoryPrompt({
    creativeBrief: { controlledRewriteVariables: [], protectedExpressions: [] },
    referenceAnalysis: {},
    sourceScriptReconstruction: {},
    variant: { id: "V1", title: "晨露与蒲公英" },
    creatorProfile: {
      fixedCharacter: "小白子，q 版狼耳少女",
      // 用户把画风写进了赛道；模型据此把风格词粘进每一场的 location。
      vertical: "治愈/温情/日常生活/日系 2.5D 新海诚光景",
      constraints: ""
    }
  });

  assert.match(prompt, /location 只写这一场实际发生的可拍摄物理地点/u);
  // location 必须保留归属：它是 Foundation 判断「哪几场是同一个地点」的唯一信号。
  // 两个不同的院子都写成「院子」会被合并成同一个 LOC 并共用场景参考，且无人报错。
  assert.match(prompt, /写「奶奶家的客厅」和「小白子家的客厅」，不要都写成「客厅」/u);
  assert.match(prompt, /两个「客厅」会被合并成同一个房间/u);
  assert.match(prompt, /不得把垂直赛道、画风、渲染风格、光线、色调或画质词写进 location/u);
  // 反例与正例都要在提示词里出现，模型才知道边界在哪。
  assert.match(prompt, /「日系2\.5D新海诚光景风格的草地」是错误输出/u);
  assert.match(prompt, /正确写法是「草地」/u);
  // 说明风格的归属，避免模型以为这是在删信息。
  assert.match(prompt, /视觉风格由下游 Animation Plan 的 visualBible 统一签发/u);
  // 赛道本身仍要照常传给模型，约束的是它不能流进 location。
  assert.match(prompt, /垂直赛道：治愈\/温情\/日常生活\/日系 2\.5D 新海诚光景/u);
});


async function readStageModelOutputRecords(root) {
  const records = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "metadata.json") {
        const metadata = JSON.parse(await fs.readFile(full, "utf8"));
        const content = metadata.output.present
          ? await fs.readFile(path.join(path.dirname(full), "model-output.txt"), "utf8")
          : "";
        records.push({ metadata, content });
      }
    }
  };
  await walk(root);
  return records;
}

test("client 的 onCompletion 观察每次模型原文，回调抛错也不影响调用结果", async (t) => {
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseChunks({ content: '{"ok":true}' }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const client = new QwenClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "",
    model: "qwen3.7-max",
    maxCompletionTokens: 16384,
    enableThinking: false,
    jsonRetryAttempts: 0
  });

  const observed = [];
  const result = await client.generateJson({
    prompt: "返回 JSON",
    onCompletion: (completion) => {
      observed.push(completion.content);
      // 观测必须 fail-open：sidecar 抛错不得让模型调用失败。
      throw new Error("sidecar 挂了");
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, ['{"ok":true}']);
});

test("阶段模型输出日志记录创意简报的成功调用与完整原文", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-model-output-ok-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const validBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const rawContent = JSON.stringify(validBrief);
  const workflow = new WorkflowService({
    client: {
      async generateJson({ onCompletion }) {
        await onCompletion({
          content: rawContent,
          raw: rawContent,
          finishReason: "stop",
          requestId: "provider-req-1",
          usage: null
        });
        return validBrief;
      }
    },
    stageModelOutputLogWriters: new Map([[
      MODEL_OUTPUT_LOG_SCOPES.BRIEF,
      new FullModelOutputLogWriter({ scope: MODEL_OUTPUT_LOG_SCOPES.BRIEF, outputRoot: root })
    ]])
  });

  await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });

  const records = await readStageModelOutputRecords(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.scope, "brief");
  assert.equal(records[0].metadata.attempt.stage, "brief");
  assert.equal(records[0].metadata.attempt.status, "succeeded");
  assert.equal(records[0].metadata.attempt.code, "MODEL_COMPLETION_ACCEPTED");
  assert.equal(records[0].metadata.provider.providerRequestId, "provider-req-1");
  assert.equal(records[0].content, rawContent);
});

test("创意简报校验失败时把模型原文与错误码写进阶段日志", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-model-output-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const invalidBrief = invalidBriefFixture();
  const rawContent = JSON.stringify(invalidBrief);
  const workflow = new WorkflowService({
    client: {
      async generateJson({ onCompletion }) {
        await onCompletion({ content: rawContent, raw: rawContent, finishReason: "stop", requestId: "", usage: null });
        return invalidBrief;
      }
    },
    stageModelOutputLogWriters: new Map([[
      MODEL_OUTPUT_LOG_SCOPES.BRIEF,
      new FullModelOutputLogWriter({ scope: MODEL_OUTPUT_LOG_SCOPES.BRIEF, outputRoot: root })
    ]])
  });

  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    OutputContractError
  );

  const records = await readStageModelOutputRecords(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.attempt.status, "failed");
  assert.equal(records[0].metadata.attempt.category, "output-contract");
  assert.equal(records[0].metadata.attempt.code, "OUTPUT_CONTRACT_INVALID");
  // 失败那次的完整原文必须原样留下，这正是本地排查唯一能看的东西。
  assert.equal(records[0].content, rawContent);
});

test("阶段校验失败时把校验器的结构化 diagnostics 写进阶段日志", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-model-output-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const invalidBrief = invalidBriefFixture();
  const rawContent = JSON.stringify(invalidBrief);
  const workflow = new WorkflowService({
    client: {
      async generateJson({ onCompletion }) {
        await onCompletion({ content: rawContent, raw: rawContent, finishReason: "stop", requestId: "", usage: null });
        return invalidBrief;
      }
    },
    stageModelOutputLogWriters: new Map([[
      MODEL_OUTPUT_LOG_SCOPES.BRIEF,
      new FullModelOutputLogWriter({ scope: MODEL_OUTPUT_LOG_SCOPES.BRIEF, outputRoot: root })
    ]])
  });

  let thrown = null;
  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    (error) => {
      thrown = error;
      return error instanceof OutputContractError;
    }
  );
  // 前提：真实校验器确实给出了带 JSON Pointer 的结构化 details，否则下面的断言证明不了什么。
  assert.ok(thrown.details.length > 0);
  assert.ok(thrown.details.every((detail) => String(detail.path || "").startsWith("/")));

  const records = await readStageModelOutputRecords(root);
  assert.equal(records.length, 1);
  const { attempt } = records[0].metadata;
  assert.equal(attempt.status, "failed");
  // 顶层 code 仍是 classifyAttemptError 的分类，不被首条 diagnostic 顶替。
  assert.equal(attempt.code, "OUTPUT_CONTRACT_INVALID");
  assert.deepEqual(attempt.diagnostics, thrown.details.map((detail) => ({
    code: detail.code,
    jsonPointer: detail.path,
    reason: detail.reason
  })));
});

test("generateValidatedJson 失败时只有最后一条 completion 带 diagnostics，且只留 code/jsonPointer/reason", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-model-output-diagnostics-shape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({ scope: MODEL_OUTPUT_LOG_SCOPES.VARIANTS, outputRoot: root });
  const workflow = new WorkflowService({ client: {} });
  const client = {
    async generateJson({ onCompletion }) {
      // client 内部的 JSON 重试：第一条已被丢弃，只有第二条交给阶段校验。
      await onCompletion({ content: "{\"variants\":", raw: "", finishReason: "length", requestId: "provider-req-1", usage: null });
      await onCompletion({ content: "{\"variants\":[]}", raw: "", finishReason: "stop", requestId: "provider-req-2", usage: null });
      return { variants: [] };
    }
  };
  const validationError = new OutputContractError("themeVariants Story Candidates 结构校验失败", [
    {
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      path: "/variants/0/storyOutline/5/emotionalNote",
      reason: "不允许出现字段 emotionalNote",
      keyword: "additionalProperties"
    },
    {
      code: "STORY_CANDIDATES_SCHEMA_REQUIRED",
      path: "/variants/1",
      reason: "缺少 storyOutline，参考图 data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== 不应落盘",
      prompt: "不应落盘的阶段提示词"
    }
  ]);

  await assert.rejects(
    () => workflow.generateValidatedJson({
      client,
      prompt: "不应落盘的阶段提示词",
      stage: "variants",
      modelOutputLogWriter: writer,
      validate() {
        throw validationError;
      }
    }),
    // 观测不改变阶段结论：抛出的仍是校验器那个错误对象本身。
    (error) => error === validationError
  );

  const records = (await readStageModelOutputRecords(root))
    .sort((left, right) => left.metadata.attempt.callIndex - right.metadata.attempt.callIndex);
  assert.equal(records.length, 2);
  assert.equal(records[0].metadata.attempt.status, "superseded");
  assert.deepEqual(records[0].metadata.attempt.diagnostics, []);
  assert.equal(records[1].metadata.attempt.status, "failed");
  assert.deepEqual(records[1].metadata.attempt.diagnostics, [
    {
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      jsonPointer: "/variants/0/storyOutline/5/emotionalNote",
      reason: "不允许出现字段 emotionalNote"
    },
    {
      code: "STORY_CANDIDATES_SCHEMA_REQUIRED",
      jsonPointer: "/variants/1",
      reason: "缺少 storyOutline，参考图 [data-url-redacted] 不应落盘"
    }
  ]);
  for (const record of records) {
    const serialized = JSON.stringify(record.metadata);
    assert.doesNotMatch(serialized, /不应落盘的阶段提示词|additionalProperties|base64/u);
  }
});

test("阶段日志写入失败只告警，不改变阶段成败", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const validBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const workflow = new WorkflowService({
    client: {
      async generateJson({ onCompletion }) {
        await onCompletion({ content: JSON.stringify(validBrief), raw: "", finishReason: "stop", requestId: "", usage: null });
        return validBrief;
      }
    },
    stageModelOutputLogWriters: new Map([[
      MODEL_OUTPUT_LOG_SCOPES.BRIEF,
      { enabled: true, recordAttempt() { throw new Error("磁盘满了"); } }
    ]])
  });

  // 关键是它没有抛错：sidecar 写盘失败不得让创意简报阶段失败。
  const result = await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });
  assert.equal(result.schemaVersion, CREATIVE_BRIEF_SCHEMA_VERSION);
  assert.ok(result.recastTest.collapses.length > 0);
});
