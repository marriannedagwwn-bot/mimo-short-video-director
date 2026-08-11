import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowService } from "../src/workflow.js";
import { getConfig } from "../src/config.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { ensureCharacterPromptMatchesBoundary, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureVisualGuardrailsMatchesProfile, extractFixedCharacterName, materializeGlobalCharacterBoundaryViews, normalizeGlobalCharacterBoundaryTerms } from "../src/validation.js";
import { buildRequestBody, MimoClient, parseModelJson } from "../src/mimo-client.js";
import { buildQwenRequestBody, QwenClient } from "../src/qwen-client.js";
import { JimengImageClient, buildCharacterReferenceImagePrompt, buildJimengImageRequestBody, buildShotFrameImagePrompt } from "../src/jimeng-client.js";
import { RECONSTRUCTION_SYSTEM_PROMPT, SYSTEM_PROMPT, animationPlanPrompt, briefPrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "../src/prompts.js";
import { parseRunVideoArgs } from "../src/run-video-command.js";
import { generateShotVideo, shotVideoGenerationPromptText, ShotVideoConfigError, ShotVideoProviderError } from "../src/shot-video-generator.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { mimeTypeFor, selectSampleTimestamps } from "../src/video-file.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "../src/mock.js";
import { syncShotCharacterReference } from "../public/character-reference-sync.js";
import { buildFrameReferenceManifest, shotRelatedCharacterReferences, uploadedReferenceImages } from "../public/shot-reference-images.js";
import { groundingContextDigest, sealReconstruction } from "../src/reconstruction-grounding.js";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";

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

const TEST_STATIC_FRAME_COMPILER_MODEL = "static-frame-compiler-test";

function animationWorkflow(options = {}) {
  const provider = String(options.animationProvider || "MiMo");
  return new WorkflowService({
    ...options,
    staticFrameCompilerProvider: provider,
    staticFrameCompilerModel: TEST_STATIC_FRAME_COMPILER_MODEL
  });
}

function stagedStaticFrameResponse(prompt = "") {
  const marker = [
    "不可变 Source Catalog（displayText 只读，不得回传）：\n",
    "首次调用前签发的不可变 Source Catalog：\n",
    "原始不可变 Source Catalog：\n"
  ].find((candidate) => prompt.includes(candidate));
  if (!marker) return null;
  const catalog = JSON.parse(prompt.split(marker)[1]);
  const response = {
    targets: catalog.map((target) => ({
      targetId: target.targetId,
      evidenceSelections: (() => {
        const segment = target.segments.find((item) => item.sourceField === target.fieldLabel)
          || target.segments[0];
        const span = segment?.spans.find((item) => item.unit === "source")
          || segment?.spans.find((item) => item.unit === "clause")
          || segment?.spans[0];
        if (!segment || !span) return [];
        return [{
          segmentId: segment.segmentId,
          spanIds: [span.spanId],
          category: target.fieldLabel === "handPropState" ? "hand_prop_state" : "pose_body",
          featureId: null
        }];
      })()
    }))
  };
  if (prompt.includes("STATIC_FRAME_ORGANIZER_ENVELOPE_REPAIR_V3")) response.repairMode = "envelope_repair";
  if (prompt.includes("STATIC_FRAME_FIELD_REORGANIZATION_V3")) response.repairMode = "evidence_reselection";
  return response;
}

function stagedAnimationResponse(plan, prompt = "") {
  if (prompt.includes("CHARACTER_FEATURE_COMPILER_V1")) {
    const marker = "服务端签发输入：\n";
    const payload = JSON.parse(String(prompt).split(marker)[1].split("\n\nCHARACTER_FEATURE_COMPILER_PROTOCOL_RETRY_V1")[0]);
    const lockedByTarget = new Map(
      (payload.lockedCharacterBoundaries || []).map((entry) => [entry.characterTargetId, entry.requiredAppearanceTraits || []])
    );
    const spansByTarget = new Map();
    for (const segment of payload.sourceCatalog) {
      spansByTarget.set(segment.characterTargetId, [
        ...(spansByTarget.get(segment.characterTargetId) || []),
        ...(segment.spans || [])
      ]);
    }
    return {
      characters: payload.characterTargets.map(({ characterTargetId }) => ({
        characterTargetId,
        features: (lockedByTarget.get(characterTargetId) || []).map((trait, index) => {
          const spans = spansByTarget.get(characterTargetId) || [];
          const evidenceSpan = spans.find((span) => [trait.canonicalName, ...(trait.terms || [])]
            .some((term) => term && String(span.displayText || "").includes(term))) || spans[0];
          return {
            suggestedFeatureKey: `locked_feature_${index + 1}`,
            canonicalName: trait.canonicalName,
            terms: trait.terms,
            featureKind: /尾/u.test(trait.canonicalName) ? "special_appendage" : "face_part",
            semanticSubtype: /尾/u.test(trait.canonicalName) ? "tail" : "locked_appearance",
            evidenceLevel: trait.evidenceLevel,
            evidenceSpanIds: trait.evidenceLevel === "explicit" && evidenceSpan ? [evidenceSpan.spanId] : [],
            inferenceSpanIds: trait.evidenceLevel === "inferred" && evidenceSpan ? [evidenceSpan.spanId] : []
          };
        })
      }))
    };
  }
  const staticFrameResponse = stagedStaticFrameResponse(prompt);
  if (staticFrameResponse) return staticFrameResponse;
  if (prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
    const marker = "待审核条目（每项严格只有 id、actionState、frameKind）：\n";
    const items = JSON.parse(String(prompt).split(marker)[1].split("\n")[0]);
    return {
      results: items.map((item) => ({
        id: item.id,
        verdict: "pass",
        reasonCode: "visible_state"
      }))
    };
  }
  if (prompt.includes("本阶段只生成可供所有镜头批次复用")) return animationFoundationFixture(plan);
  const match = prompt.match(/本批允许的 sourceSceneId：([^\n]+)/u);
  const sourceSceneIds = String(match?.[1] || "").split("、").map((item) => item.trim()).filter(Boolean);
  const shotPlan = structuredClone(
    plan.shotPlan.filter((shot) => sourceSceneIds.includes(String(shot.sourceSceneId)))
  );
  const mockNarrativeActionStates = new Set([
    "关键肢体停在动作起始位置，与目标道具之间留有清晰距离",
    "关键肢体停在动作终点位置，动作结果在画面中清晰可见"
  ]);
  shotPlan.forEach((shot) => {
    for (const frameKind of ["startFrame", "endFrame"]) {
      (shot[frameKind]?.characters || []).forEach((character) => {
        if (mockNarrativeActionStates.has(character.actionState)) character.actionState = "";
      });
    }
  });
  return {
    shotPlan
  };
}

function animationFoundationFixture(plan) {
  const copy = structuredClone(plan);
  const { shotPlan, ...foundation } = copy;
  foundation.sceneReferencePrompts.forEach((scene) => {
    scene.relatedShotIds = [];
    scene.sourceSceneIds = [...new Set(shotPlan.filter((shot) => shot.sceneId === scene.sceneId).map((shot) => shot.sourceSceneId))];
  });
  return foundation;
}

function creativeBriefFixture(creatorProfile, mapping = {}) {
  const brief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  Object.assign(brief.roleAndOccupationMapping[0], {
    newRole: creatorProfile.fixedCharacter,
    newOccupationOrIdentity: "村里的热心帮手",
    mappingLogic: "只保留主动帮助他人的剧作功能",
    ...mapping
  });
  return brief;
}

function validateCreativeBrief(brief, creatorProfile) {
  return ensureCreativeBriefMatchesProfile(ensureOutputContract(brief, "creativeBrief"), creatorProfile);
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
  assert.ok(result.creativeBrief.reusableHighValueBeats.length >= 4);
  assert.equal(result.creativeBrief.allowedNarrativeComponents.length, 7);
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
  assert.equal(variantCalls, 1);

  await assert.rejects(
    () => workflow.createVariants({
      ...stageContext,
      creatorProfile: { ...creatorProfile, fixedCharacter: `${creatorProfile.fixedCharacter}，明确没有尾巴` },
      visualGuardrails,
      count: 1
    }),
    /全局角色边界与当前用户设定.*不匹配/u
  );
  assert.equal(variantCalls, 1);
});

test("Visual Guardrails 拒绝模型伪造服务端签发字段", async () => {
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
  assert.equal(modelCalls, 2);
});

test("creativeBrief 将通用叙事构件列为允许复用而非禁止项", async () => {
  const workflow = new WorkflowService();
  const referenceAnalysis = await workflow.analyze(input);
  const sourceScriptReconstruction = await workflow.reconstruct({ ...input, referenceAnalysis });
  const creativeBrief = await workflow.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
  const allowed = creativeBrief.allowedNarrativeComponents.map((item) => item.component);
  const protectedText = JSON.stringify(creativeBrief.protectedExpressions);
  for (const component of ["送达任务", "旅途结构", "情感媒介", "获得帮助", "被关爱对象", "天气或空间推动情绪", "生活化或仪式化结尾"]) {
    assert.ok(allowed.includes(component));
    assert.equal(protectedText.includes(component), false);
  }
});

test("主题变体同时提供结构保真与表达变换证明", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  for (const variant of result.themeVariants.variants) {
    assert.deepEqual(Object.keys(variant.experienceFidelity), ["positioning", "audience", "emotion", "plotDriver", "highValueBeats"]);
    assert.deepEqual(Object.keys(variant.transformationProof), ["changedCharacters", "changedTask", "changedDetailsAndProps", "changedDialogue", "changedVisualExpression"]);
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
  let captured;
  let providerCalls = 0;
  const workflow = new WorkflowService({
    storyModel: "mimo-v2.5-pro",
    storyMaxCompletionTokens: 12345,
    client: {
      async generateJson(args) {
        providerCalls += 1;
        captured = args;
        return mockFullStory({ ...input, creativeBrief, variant });
      }
    }
  });
  const result = await workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, variant }));
  assert.equal(captured.model, "mimo-v2.5-pro");
  assert.equal(captured.maxCompletionTokens, 12345);
  assert.equal(captured.jsonRetryAttempts, 0);
  assert.equal(captured.strictJson, true);
  assert.equal(providerCalls, 1);
  assert.equal(result.selectedVariantId, "V1");
  assert.ok(result.sceneScript.length >= 6);
  assert.match(result.characterBible.protagonist.identity, /阿岚/);
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
  const calls = [];
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
      if (args.model === "qwen3.7-max-story") return mockFullStory({ ...input, creativeBrief, variant });
      const plan = mockAnimationPlan({ ...input, creativeBrief, variant, fullStory: mockFullStory({ ...input, creativeBrief, variant }) });
      return stagedAnimationResponse(plan, args.prompt);
    }
  };
  const workflow = animationWorkflow({
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
  const animationPlan = await workflow.createAnimationPlan({ ...stageContext, fullStory });

  assert.equal(workflow.mode, "live");
  assert.equal(calls[0].model, "qwen3.7-max-story");
  assert.equal(calls[0].maxCompletionTokens, 16000);
  assert.equal(calls[1].model, "qwen3.7-max-animation");
  assert.equal(calls[1].maxCompletionTokens, 17000);
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
  const calls = [];
  const qwenClient = {
    async generateJson(args) {
      calls.push(args);
      return mockFullStory({ ...input, creativeBrief, variant });
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
  assert.equal(calls[0].model, "qwen-custom-story");
  assert.equal(calls[0].maxCompletionTokens, 22000);
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

test("Qwen 和 MiMo 生成请求使用 15 分钟配置但健康检查仍为 5 秒", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const observedTimeouts = [];
  try {
    AbortSignal.timeout = (milliseconds) => {
      observedTimeouts.push(milliseconds);
      return originalTimeout(1_000);
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "configured-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
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

    assert.deepEqual(observedTimeouts, [5_000, 900_000, 5_000, 900_000]);
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

test("referenceAnalysis 原生视频证据失败后只按 video evidence 纠偏", async () => {
  const calls = [];
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia(args) {
        calls.push(args);
        args.onResolvedMediaMode?.("video");
        const analysis = mockAnalysis(input);
        if (calls.length === 1) return analysis;
        assert.match(args.prompt, /本次成功媒体请求使用原生视频/u);
        assert.match(args.prompt, /不得保留任何 frame 或 frameNumber/u);
        assert.match(args.prompt, /不得输出 startMs\/endMs/u);
        assert.match(args.prompt, /endSecond <= 40/u);
        analysis.observedFacts.forEach((fact, index) => {
          fact.evidenceRefs = [{
            source: "video",
            startSecond: index,
            endSecond: index + 1
          }];
        });
        return analysis;
      }
    }
  });

  const result = await workflow.analyze({
    ...input,
    video: {
      dataUrl: "data:video/mp4;base64,AAAA",
      mimeType: "video/mp4",
      size: 4
    }
  });

  assert.equal(calls.length, 2);
  assert.ok(result.observedFacts.every((fact) => (
    fact.evidenceRefs.every((reference) => reference.source === "video")
  )));
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

  assert.equal(calls.length, 3);
  assert.equal(calls[0].video, videoInput.video);
  assert.equal(calls[1].video, videoInput.video);
  assert.equal(calls[2].video, null);
  assert.ok(result.observedFacts.every((fact) => (
    fact.evidenceRefs.every((reference) => reference.source === "frame")
  )));
});

test("完整剧情后可生成首尾帧动画生产包", async () => {
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
  const fullStory = mockFullStory({ ...input, creativeBrief, variant });
  let captured;
  const workflow = animationWorkflow({
    animationModel: "mimo-v2.5-pro",
    animationMaxCompletionTokens: 13000,
    client: {
      async generateJson(args) {
        if (
          !args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")
          && !/STATIC_FRAME_(?:FIELD_ORGANIZATION|FIELD_REORGANIZATION|ORGANIZER_ENVELOPE_REPAIR)_V3/u.test(args.prompt)
          && !args.prompt.includes("CHARACTER_FEATURE_COMPILER_V1")
        ) captured = args;
        return stagedAnimationResponse(mockAnimationPlan({ ...input, creativeBrief, variant, fullStory }), args.prompt);
      }
    }
  });
  const result = await workflow.createAnimationPlan(globalBoundaryContext(workflow, { creativeBrief, variant, fullStory }));
  assert.equal(captured.model, "mimo-v2.5-pro");
  assert.equal(captured.maxCompletionTokens, 13000);
  assert.equal(result.productionStrategy.format, "first_last_frame_video");
  assert.ok(result.sceneReferencePrompts.length >= 1);
  assert.ok(result.sceneReferencePrompts[0].environmentPrompt);
  assert.ok(result.shotPlan.length >= 6);
  assert.ok(result.shotPlan[0].sceneId);
  assert.ok(result.shotPlan[0].startFramePrompt);
  assert.ok(result.shotPlan[0].endFramePrompt);
  assert.ok(result.shotPlan[0].videoPrompt);
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

test("人物参考图更新后同步镜头里的角色外观描述", () => {
  const plan = {
    characterReferencePrompts: [{
      characterName: "小白子",
      appearancePrompt: "狼耳少女小白子，双马尾，浅蓝背带裤。",
      consistencyTags: ["狼耳少女", "双马尾"]
    }],
    shotPlan: [
      {
        shotId: "A01",
        startFramePrompt: "清晨，村口小路起点。狼耳少女小白子（双马尾，浅蓝背带裤）正从一位村民叔叔手中接过一本画册。她双手捧着画册，眼睛发亮，表情郑重。特写，柔和的晨光。",
        endFramePrompt: "小白子（双马尾，浅蓝背带裤）把画册抱在胸前，准备出发。",
        videoPrompt: "小白子从首帧到尾帧只完成接过画册并抱稳的动作。",
        characterAction: "小白子双手捧住画册。",
        continuityNotes: "保持小白子旧服装不变。"
      },
      {
        shotId: "A02",
        startFramePrompt: "村民叔叔站在路边看着画册。",
        endFramePrompt: "村民叔叔转身离开。",
        videoPrompt: "镜头缓慢推进。",
        characterAction: "村民叔叔挥手。",
        continuityNotes: "无主角外观变化。"
      }
    ]
  };
  const updated = {
    characterName: "小白子",
    appearancePrompt: "参考图中的小白子，银灰色长发，灰白色狼耳，蓝色大眼睛，深色水手服外套，白色衬衫，蓝色领结，儿童比例，Q版动漫风格。",
    consistencyTags: ["银灰色长发", "灰白色狼耳", "蓝色大眼睛", "深色水手服外套"]
  };

  const changed = syncShotCharacterReference(plan, plan.characterReferencePrompts[0], updated);

  assert.equal(changed, 1);
  assert.match(plan.shotPlan[0].startFramePrompt, /小白子（银灰色长发/);
  assert.doesNotMatch(plan.shotPlan[0].startFramePrompt, /双马尾，浅蓝背带裤/);
  assert.match(plan.shotPlan[0].endFramePrompt, /深色水手服外套/);
  assert.match(plan.shotPlan[0].videoPrompt, /小白子（银灰色长发/);
  assert.equal(plan.shotPlan[1].startFramePrompt, "村民叔叔站在路边看着画册。");
});

test("人物参考图同步不会把地点所有者写成出场角色", () => {
  const plan = {
    characterReferencePrompts: [{
      characterName: "外婆",
      appearancePrompt: "灰白头发，围裙，慈祥老人。"
    }],
    shotPlan: [
      {
        shotId: "A02",
        startFramePrompt: "阳光明媚的外婆院子，近景平视。小白子双手抱着旧铁盒。",
        endFramePrompt: "小白子身体转向画面右侧。",
        videoPrompt: "小白子抱盒转身。"
      },
      {
        shotId: "A03",
        startFramePrompt: "外婆院子门口，外婆微笑着向小白子挥手。",
        endFramePrompt: "外婆站在院门旁目送小白子。"
      }
    ]
  };
  const updated = {
    characterName: "外婆",
    appearancePrompt: "和蔼的老年女性，灰白头发盘起，穿着围裙。",
    consistencyTags: ["灰白头发", "围裙"]
  };

  const changed = syncShotCharacterReference(plan, plan.characterReferencePrompts[0], updated);

  assert.equal(changed, 1);
  assert.equal(plan.shotPlan[0].startFramePrompt, "阳光明媚的外婆院子，近景平视。小白子双手抱着旧铁盒。");
  assert.match(plan.shotPlan[1].startFramePrompt, /外婆院子门口，外婆（和蔼的老年女性/);
  assert.doesNotMatch(plan.shotPlan[1].startFramePrompt, /外婆（和蔼的老年女性[^）]+）院子/);
});

test("v2 结构化镜头更新角色参考图时不会改写编译后的兼容 prompt", () => {
  const plan = {
    shotPlan: [{
      shotId: "A01",
      startFrame: { characters: [{ name: "小白子" }] },
      endFrame: { characters: [{ name: "小白子" }] },
      motion: { primaryAction: "小白子拿起玻璃片" },
      startFramePrompt: "小白子站在木箱旁。",
      endFramePrompt: "小白子举起玻璃片。",
      videoPrompt: "小白子拿起玻璃片。",
      characterAction: "小白子拿起玻璃片。",
      continuityNotes: "保持角色一致。"
    }]
  };
  const before = structuredClone(plan.shotPlan[0]);

  const changed = syncShotCharacterReference(
    plan,
    { characterName: "小白子", appearancePrompt: "旧外观" },
    { characterName: "小白子", appearancePrompt: "参考图中的新外观" }
  );

  assert.equal(changed, 0);
  assert.deepEqual(plan.shotPlan[0], before);
});

test("单镜头首尾帧视频可通过通用 HTTP worker 传递逐镜负面词", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-http-"));
  let receivedBody = null;
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { videoBase64: Buffer.from("shot video bytes").toString("base64") } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const address = provider.address();
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${address.port}/videos`,
    videoModel: "provider-video-model",
    apiKey: "test-key"
  }));
  const frameDataUrl = `data:image/png;base64,${Buffer.from("frame image bytes").toString("base64")}`;

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    startFrameDataUrl: frameDataUrl,
    endFrameDataUrl: frameDataUrl,
    shot: {
      shotId: "S01",
      durationSeconds: 4,
      startFramePrompt: "小白子抱着包裹准备出发",
      endFramePrompt: "小白子把包裹交到老人手里",
      videoPrompt: "小白子从首帧动作平稳过渡到尾帧",
      negativePrompts: {
        image: [],
        video: [{
          text: "交接过程中包裹变形",
          appliesTo: "video",
          triggerEvidence: [{ sourcePath: "animationPlan.shotPlan[S01].videoPrompt", evidence: "小白子完成包裹交接" }],
          reasonCode: "temporal_consistency_failure",
          priority: "medium",
          enabled: true
        }]
      },
      cameraMotion: "缓慢推进"
    }
  });

  assert.equal(result.shotId, "S01");
  assert.match(result.startFrameUrl, /^\/generated-videos\/S01-start-/u);
  assert.match(result.endFrameUrl, /^\/generated-videos\/S01-end-/u);
  assert.match(result.outputUrl, /^\/generated-videos\/S01-/u);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "shot video bytes");
  assert.equal(receivedBody.capability, "first_last_frame_video_generation");
  assert.equal(receivedBody.model, "provider-video-model");
  assert.equal(receivedBody.prompt, "小白子从首帧动作平稳过渡到尾帧");
  assert.equal(receivedBody.negativePrompt, "交接过程中包裹变形");
  assert.equal(receivedBody.parameters.cameraMotion, "缓慢推进");
  assert.equal(receivedBody.inputArtifacts.length, 2);
  assert.match(receivedBody.inputArtifacts[0].dataUrl, /^data:image\/png;base64,/u);
  assert.deepEqual(result.receipt.negativePromptDelivery, {
    supported: true,
    appliedMode: "native_negative",
    providerField: "negativePrompt",
    compiledNegativePrompt: "交接过程中包裹变形",
    appliedText: "交接过程中包裹变形",
    providerIgnored: false,
    ignored: []
  });
  assert.equal(result.receipt.requestPreview.body.negativePrompt, "交接过程中包裹变形");
  assert.equal(result.receipt.requestPreview.headers.Authorization, "[REDACTED]");
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
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key"
  }));

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    videoProvider: "MiniMax",
    videoModel: "MiniMax-H3",
    generationMode: "all_reference",
    referenceAssets: [{
      mediaType: "image",
      name: "小白子角色参考.png",
      dataUrl: `data:image/png;base64,${Buffer.from("character reference bytes").toString("base64")}`,
      source: "character_reference"
    }],
    shot: {
      shotId: "S01-R2V",
      durationSeconds: 5,
      startFramePrompt: "不应生成这个首帧",
      endFramePrompt: "不应生成这个尾帧",
      videoPrompt: "参考角色身份生成挥手动作"
    }
  });

  assert.equal(result.generationMode, "all_reference");
  assert.equal(result.startFrameUrl, "");
  assert.equal(result.endFrameUrl, "");
  assert.deepEqual(result.referenceSummary, { image: 1, video: 0, audio: 0 });
  assert.deepEqual(receivedBody.content.map((item) => item.role || "text"), ["text", "reference_image"]);
  assert.equal(receivedBody.content.some((item) => ["first_frame", "last_frame"].includes(item.role)), false);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "r2v shot video bytes");
});

test("可灵全能参考模式明确失败，不静默降级为首尾帧", async () => {
  await assert.rejects(() => generateShotVideo({
    videoProvider: "Kling",
    videoModel: "kling-v3",
    generationMode: "all_reference",
    referenceAssets: [{
      mediaType: "image",
      name: "reference.png",
      dataUrl: "data:image/png;base64,AA=="
    }],
    shot: { shotId: "S-KLING-R2V", videoPrompt: "参考人物生成动作" }
  }), /尚未取得可验证的 Omni API 协议/u);
});

test("单镜头首尾帧视频支持可灵 preset、轮询与 negative_prompt 真实传递", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-kling-"));
  let postBody = null;
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/videos/image2video") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: { task_id: "kling-task-1", task_status: "submitted" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/videos/image2video/kling-task-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 0,
        data: {
          task_id: "kling-task-1",
          task_status: "succeed",
          task_result: { videos: [{ url: `http://127.0.0.1:${provider.address().port}/media/kling.mp4` }] }
        }
      }));
      return;
    }
    if (request.url === "/media/kling.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("kling video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const address = provider.address();
  const configPath = path.join(root, "kling.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${address.port}/v1`,
    providerPreset: "kling_image_to_video",
    videoModel: "kling-v2-1",
    apiKey: "test-key",
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));
  const startFrameDataUrl = `data:image/png;base64,${Buffer.from("start frame bytes").toString("base64")}`;
  const endFrameDataUrl = `data:image/png;base64,${Buffer.from("end frame bytes").toString("base64")}`;

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    startFrameDataUrl,
    endFrameDataUrl,
    shot: {
      shotId: "S02",
      durationSeconds: 4,
      videoPrompt: "小白子平稳拿起玻璃幻灯片并举到夕阳前",
      negativePrompts: {
        image: [],
        video: [{
          text: "拿起过程中手指与透明玻璃片融合",
          appliesTo: "video",
          triggerEvidence: [{ sourcePath: "animationPlan.shotPlan[S02].videoPrompt", evidence: "小白子拿起透明玻璃片" }],
          reasonCode: "shot_interaction_failure",
          priority: "high",
          enabled: true
        }]
      }
    }
  });

  assert.equal(postBody.model_name, "kling-v2-1");
  assert.equal(postBody.image, Buffer.from("start frame bytes").toString("base64"));
  assert.equal(postBody.image_tail, Buffer.from("end frame bytes").toString("base64"));
  assert.equal(postBody.prompt, "小白子平稳拿起玻璃幻灯片并举到夕阳前");
  assert.equal(postBody.negative_prompt, "拿起过程中手指与透明玻璃片融合");
  assert.equal(postBody.mode, "pro");
  assert.equal(postBody.duration, "5");
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "kling video bytes");
  assert.equal(result.receipt.providerTaskId, "kling-task-1");
  assert.equal(result.receipt.resultKind, "url");
  assert.equal(result.receipt.negativePromptDelivery.appliedMode, "native_negative");
  assert.equal(result.receipt.negativePromptDelivery.providerField, "negative_prompt");
  assert.equal(result.receipt.negativePromptDelivery.compiledNegativePrompt, "拿起过程中手指与透明玻璃片融合");
  assert.equal(result.receipt.requestPreview.body.negative_prompt, "拿起过程中手指与透明玻璃片融合");
});

test("单镜头视频生成可返回多个候选", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-count-"));
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
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({ videoEndpoint: `http://127.0.0.1:${provider.address().port}/videos` }));
  const frameDataUrl = `data:image/png;base64,${Buffer.from("frame image bytes").toString("base64")}`;

  const result = await generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    count: 2,
    startFrameDataUrl: frameDataUrl,
    endFrameDataUrl: frameDataUrl,
    shot: { shotId: "S03", durationSeconds: 4, videoPrompt: "从首帧过渡到尾帧" }
  });

  assert.equal(result.count, 2);
  assert.equal(result.actualCount, 2);
  assert.equal(result.videos.length, 2);
  assert.match(result.videos[0].outputUrl, /-1\.mp4$/u);
  assert.match(result.videos[1].outputUrl, /-2\.mp4$/u);
  assert.equal(await fs.readFile(result.videos[0].outputPath, "utf8"), "shot video bytes 1");
  assert.equal(await fs.readFile(result.videos[1].outputPath, "utf8"), "shot video bytes 2");
  assert.equal(videoBodies[0].parameters.candidateIndex, 0);
  assert.equal(videoBodies[0].parameters.candidateCount, 2);
  assert.equal(videoBodies[1].parameters.candidateIndex, 1);
});

test("单镜头视频生成不会把供应商纯文本确认当成 mp4", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-text-"));
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // drain request body
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({ videoEndpoint: `http://127.0.0.1:${provider.address().port}/videos` }));
  const frameDataUrl = `data:image/png;base64,${Buffer.from("frame image bytes").toString("base64")}`;

  await assert.rejects(() => generateShotVideo({
    workerRunner: executeGenericHttpWorker,
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    startFrameDataUrl: frameDataUrl,
    endFrameDataUrl: frameDataUrl,
    shot: { shotId: "S04", videoPrompt: "测试视频" }
  }), ShotVideoProviderError);
});

test("单镜头视频生成未配置供应商时给出明确错误", async () => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_VIDEO_ENDPOINT", "VIDEO_HTTP_CONFIG"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_VIDEO_ENDPOINT;
  delete process.env.VIDEO_HTTP_CONFIG;
  try {
    await assert.rejects(
      () => generateShotVideo({ shot: { shotId: "S05", videoPrompt: "测试" } }),
      ShotVideoConfigError
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
  assert.equal(body.stream, false);
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
  assert.equal(body.stream, false);
  assert.equal(body.enable_thinking, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content, "生成完整剧情");
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
        return creativeBriefFixture(creatorProfile);
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}');
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
  assert.match(prompt, /参考我上传的这张图片，不要水果摊，生成一张小白子/);
  assert.match(prompt, /人物必须是站立姿态的全身图/);
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
  const multiReferenceBody = buildJimengImageRequestBody(
    { model: "doubao-seedream-5-0-260128", size: "1728x2304", outputFormat: "png", imageField: "image", maxImages: 6, watermark: false },
    { referenceImageDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="], characterReference, count: 1, prompt: "多角色参考图" }
  );
  assert.deepEqual(multiReferenceBody.image, ["data:image/png;base64,AA==", "data:image/png;base64,BB=="]);
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

test("即梦首尾帧镜头图 prompt 合并视觉圣经、manifest 角色绑定和帧提示词", async () => {
  const characterReferences = [{
    characterName: "小白子",
    appearancePrompt: "q版狼耳少女，蓝色眼睛",
    consistencyTags: ["狼耳", "浅蓝服装"],
    referenceImageDataUrl: "data:image/png;base64,AA=="
  }];
  const referenceManifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences
  });
  const characterToken = referenceManifest.providerImages.find((item) => item.characterName === "小白子").token;
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    visualBible: {
      overallStyle: "Q版定格动画",
      animationStyle: "柔和乡村童话",
      colorPalette: ["米白", "浅蓝"],
      lighting: "清晨柔光",
      cameraLanguage: "低机位近景"
    },
    characterReferences,
    referenceManifest,
	    sceneReference: {
	      sceneId: "LOC01",
	      sceneName: "村口药铺门前",
	      environmentPrompt: "户外村口药铺门前，木质门脸，青石路，清晨柔光。",
	      continuityAnchors: ["户外", "村口药铺", "木质门脸", "青石路"],
	      sceneContinuityRules: ["地点与室内外属性保持一致"]
	    },
	    shot: {
      shotId: "S01",
      startFramePrompt: "小白子站在村口，手里拿着草药包。",
	      endFramePrompt: "小白子把草药包递给爷爷。",
	      cameraMotion: "轻微推近",
	      characterAction: "抱紧草药包",
	      negativePrompts: {
	        image: [{
	          text: "手指与草药包融合",
	          appliesTo: "image",
	          triggerEvidence: [{ sourcePath: "animationPlan.shotPlan[S01].startFramePrompt", evidence: "手里拿着草药包" }],
	          reasonCode: "shot_interaction_failure",
	          priority: "high"
	        }],
	        video: []
	      }
    }
  });
  assert.match(prompt, /生成竖屏 9:16 动画短视频分镜首帧图/);
	  assert.match(prompt, /整体风格：Q版定格动画/);
	  assert.match(prompt, /场景参考（必须继承/);
	  assert.match(prompt, /村口药铺门前/);
	  assert.doesNotMatch(prompt, /地点与室内外属性保持一致/);
  assert.ok(prompt.includes(`小白子：${characterToken}`));
  assert.ok(prompt.includes(`${characterToken}：角色“小白子”的外观与身份参考`));
  assert.doesNotMatch(prompt, /q版狼耳少女/);
  assert.doesNotMatch(prompt, /一致性标签：狼耳/);
  assert.match(prompt, /首帧画面提示词（人物身份和外观以参考图绑定为准/);
  assert.ok(prompt.includes(`小白子（${characterToken}）站在村口`));
  assert.match(prompt, /首帧是静态关键帧/);
  assert.match(prompt, /只描述 StartState 的可见起点/);
  assert.doesNotMatch(prompt, /视频镜头运动上下文/);
  assert.doesNotMatch(prompt, /当前镜头单一动作目标/);
  assert.doesNotMatch(prompt, /手指与草药包融合/);
});

test("即梦首尾帧镜头图无参考图时才保留角色文字描述", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "end",
    characterReferences: [{
      characterName: "爷爷",
      appearancePrompt: "穿深色棉袄的慈祥老人",
      consistencyTags: ["灰白头发"]
    }],
    shot: {
      startFramePrompt: "小白子站在门口。",
      endFramePrompt: "爷爷接过草药包。"
    }
  });
  assert.match(prompt, /未提供角色参考图/);
  assert.match(prompt, /角色：爷爷/);
  assert.match(prompt, /穿深色棉袄的慈祥老人/);
});

test("inherit 尾帧使用 manifest 首帧视觉基底且图片 Prompt 不包含动作过程", async () => {
  const characterReferences = [{
    characterName: "外婆",
    appearancePrompt: "和蔼老人，穿围裙",
    referenceImageDataUrl: "data:image/png;base64,AA=="
  }, {
    characterName: "小白子",
    appearancePrompt: "Q版白发猫耳少女，蓝色眼睛",
    referenceImageDataUrl: "data:image/png;base64,BB=="
  }];
  const referenceManifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "inherit",
    endpointReference: {
      dataUrl: "data:image/png;base64,CC==",
      sourceShotId: "S01"
    },
    characterReferences
  });
  const startFrameToken = referenceManifest.providerImages.find((item) => item.role === "start_frame").token;
  const grandmotherToken = referenceManifest.providerImages.find((item) => item.characterName === "外婆").token;
  const prompt = buildShotFrameImagePrompt({
    frameKind: "end",
    frameReferenceMode: "inherit",
    referenceManifest,
    characterReferences,
    sceneReference: {
      sceneId: "LOC01",
      sceneName: "外婆院子",
      continuityAnchors: ["户外", "农家院落", "中景平视", "柔和光线"]
    },
    shot: {
      shotId: "S01",
      sceneId: "LOC01",
      startFramePrompt: "阳光明媚的外婆（和蔼的老年女性，头发灰白盘起，穿着围裙）院子，中景平视。外婆微笑着递出一个复古旧铁盒。小白子站在对面，双手微抬准备接物。背景是温馨的农家院落与茂密绿植，光线柔和。",
      endFramePrompt: "小白子双手稳稳抱住旧铁盒，身体微微前倾。外婆的手已收回。小白子面带笑容。"
    }
  });
  assert.ok(prompt.includes(`${startFrameToken} 是当前镜头首帧视觉基底`));
  assert.match(prompt, /保持首帧的场景结构、机位、景别、构图和光线/);
  assert.match(prompt, /sceneId=LOC01/);
  assert.doesNotMatch(prompt, /外婆微笑着递出|双手微抬准备接物|motion\.cameraMove/);
  assert.ok(!prompt.includes(`外婆（${grandmotherToken}）院子`));
});

test("transition 尾帧采用 EndState 新机位且不把 motion 路径写进图片 Prompt", async () => {
  const referenceManifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "transition",
    endpointReference: {
      dataUrl: "data:image/png;base64,AA==",
      sourceShotId: "S01"
    },
    characterReferences: []
  });
  const prompt = buildShotFrameImagePrompt({
    frameKind: "end",
    frameReferenceMode: "transition",
    referenceManifest,
    sceneReference: {
      sceneId: "LOC01",
      sceneName: "夕阳下的木屋院子",
      continuityAnchors: ["户外", "木屋院子", "夕阳"]
    },
    shot: {
      shotId: "S01",
      sceneId: "LOC01",
      startFramePrompt: "夕阳下的木屋院子，中景平视，小白子站在木箱左侧。",
      endFramePrompt: "夕阳下的木屋院子，右侧三分之二侧面近景，小白子举起玻璃片。",
      motion: {
        cameraMove: {
          mode: "continuous",
          technique: "缓慢环绕",
          path: "从正面向右环绕至三分之二侧面",
          speed: "slow",
          motivation: "显出玻璃片透光"
        }
      }
    }
  });

  assert.match(prompt, /采用 EndState 指定的新机位、构图、光线或同场景物体状态/);
  assert.match(prompt, /不要求与首帧像素级一致/);
  assert.doesNotMatch(prompt, /缓慢环绕|从正面向右环绕|motion\.cameraMove/);
});

test("有 manifest 角色绑定时会清理首尾帧画面提示词里的重复外观文字", async () => {
  const characterReferences = [{
    characterName: "小白子",
    appearancePrompt: "Q版狼耳少女，灰白色狼耳朵和狼尾巴，黑色校园风外套。",
    referenceImageDataUrl: "data:image/png;base64,AA=="
  }];
  const referenceManifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences
  });
  const characterToken = referenceManifest.providerImages.find((item) => item.characterName === "小白子").token;
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    referenceManifest,
    characterReferences,
    shot: {
      startFramePrompt: "日系2.5D治愈动画风格，Q版狼耳少女小白子（日系2.5D治愈动画风格，Q版二头身比例，狼耳少女，有毛茸茸的灰白色狼耳朵和蓬松的灰白色狼尾巴）坐在木质书桌前，穿着浅黄色背带裙，头顶灰白色狼耳朵，身后有灰白色狼尾巴。她双手拿着一条织了一半的彩虹手链，眼神专注。",
      endFramePrompt: "小白子抬头。"
    }
  });
  assert.ok(prompt.includes(`小白子：${characterToken}`));
  assert.ok(prompt.includes(`小白子（${characterToken}）坐在木质书桌前`));
  assert.match(prompt, /彩虹手链/);
  assert.doesNotMatch(prompt, /Q版狼耳少女小白子/);
  assert.doesNotMatch(prompt, /浅黄色背带裙|灰白色狼耳朵|灰白色狼尾巴|黑色校园风外套/);
});

test("首尾帧镜头图不会把地点所有者映射成 manifest 角色", async () => {
  const characterReferences = [{
    characterName: "外婆",
    appearancePrompt: "和蔼老人，穿围裙",
    referenceImageDataUrl: "data:image/png;base64,AA=="
  }, {
    characterName: "小白子",
    appearancePrompt: "Q版白发猫耳少女，蓝色眼睛",
    referenceImageDataUrl: "data:image/png;base64,BB=="
  }];
  const referenceManifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences
  });
  const grandmotherToken = referenceManifest.providerImages.find((item) => item.characterName === "外婆").token;
  const protagonistToken = referenceManifest.providerImages.find((item) => item.characterName === "小白子").token;
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    referenceManifest,
    characterReferences,
    shot: {
      startFramePrompt: "阳光明媚的外婆（和蔼的老年女性，头发灰白盘起，穿着围裙）院子，近景平视。小白子（Q版少女，白色长发及腰，头顶猫耳）双手抱着旧铁盒在胸前，眼睛弯成月牙。",
      endFramePrompt: "小白子身体转向画面右侧。"
    }
  });
  assert.match(prompt, /外婆院子，近景平视/);
  assert.ok(prompt.includes(`小白子（${protagonistToken}）双手抱着旧铁盒`));
  assert.ok(!prompt.includes(`外婆（${grandmotherToken}）院子`));
  assert.doesNotMatch(prompt, /头发灰白盘起|穿着围裙|头顶猫耳/);
});

test("首尾帧镜头图禁止把字幕或对白文字画进图片", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    shot: {
      startFramePrompt: "小白子站在村口，手里拿着草药包。",
      endFramePrompt: "小白子走进院子。",
      dialogueOrSubtitle: "字幕：小白子说“嗷呜，谢谢你”。",
      negativePrompt: "不要现代城市"
    }
  });
  assert.doesNotMatch(prompt, /情绪\/动作理解参考/);
  assert.match(prompt, /画面禁止出现任何字幕、对白文字、旁白文字、中文、英文、标题、说明字、对白气泡/);
  assert.match(prompt, /Logo、水印、UI 文本或边框/);
  assert.doesNotMatch(prompt, /对白\/字幕信息：/);
});

test("首尾帧图片请求只上传当前镜头相关角色参考图", () => {
  const references = [
    { characterName: "小白子", storyRole: "主角", referenceImageDataUrl: "data:image/png;base64,AA==", appearancePrompt: "狼耳少女" },
    { characterName: "爷爷", storyRole: "被关爱对象", referenceImageDataUrl: "data:image/png;base64,BB==", appearancePrompt: "老人" },
    { characterName: "张老师", storyRole: "路人", referenceImageDataUrl: "data:image/png;base64,CC==", appearancePrompt: "老师" }
  ];
  const shot = {
    startFramePrompt: "小白子抱着草药包走到爷爷家门口。",
    endFramePrompt: "爷爷接过草药包，向小白子点头。"
  };
  const related = shotRelatedCharacterReferences(shot, references);
  const images = uploadedReferenceImages(related);
  const body = buildJimengImageRequestBody(
    { model: "doubao-seedream-5-0-260128", size: "1728x2304", outputFormat: "png", imageField: "image", maxImages: 6, watermark: false },
    { referenceImageDataUrls: images.map((item) => item.referenceImageDataUrl), count: 4, prompt: "首帧图" }
  );
  assert.deepEqual(related.map((item) => item.characterName), ["小白子", "爷爷"]);
  assert.deepEqual(body.image, ["data:image/png;base64,AA==", "data:image/png;base64,BB=="]);
  assert.equal(body.sequential_image_generation, "auto");
  assert.deepEqual(body.sequential_image_generation_options, { max_images: 4 });
});

test("首尾帧图片请求不会因地点词上传地点所有者参考图", () => {
  const references = [
    { characterName: "外婆", storyRole: "委托者", referenceImageDataUrl: "data:image/png;base64,AA==", appearancePrompt: "老人" },
    { characterName: "小白子", storyRole: "主角", referenceImageDataUrl: "data:image/png;base64,BB==", appearancePrompt: "白发猫耳少女" }
  ];
  const shot = {
    storyPurpose: "强化主角接到任务后的开心情绪。",
    startFramePrompt: "阳光明媚的外婆院子，近景平视。小白子双手抱着旧铁盒在胸前。",
    endFramePrompt: "小白子身体转向画面右侧，准备出发。"
  };
  const related = shotRelatedCharacterReferences(shot, references);
  assert.deepEqual(related.map((item) => item.characterName), ["小白子"]);
});

test("v2 结构化镜头只选择 characters 中实际出镜的角色参考图", () => {
  const references = [
    { characterName: "小白子", referenceImageDataUrl: "data:image/png;base64,AA==" },
    { characterName: "爷爷", referenceImageDataUrl: "data:image/png;base64,BB==" },
    { characterName: "张老师", referenceImageDataUrl: "data:image/png;base64,CC==" }
  ];
  const shot = {
    startFrame: { characters: [{ name: "小白子" }], environment: { sceneId: "LOC01" } },
    endFrame: { characters: [{ name: "小白子" }], environment: { sceneId: "LOC01" } },
    motion: { primaryAction: "她拿起玻璃幻灯片" }
  };

  assert.deepEqual(
    shotRelatedCharacterReferences(shot, references).map((item) => item.characterName),
    ["小白子"]
  );
  assert.deepEqual(
    shotRelatedCharacterReferences({ ...shot, startFrame: { characters: [] }, endFrame: { characters: [] } }, references),
    []
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}');
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
    response.writeHead(200, { "content-type": "application/json" });
    if (content.some((item) => item.type === "video_url")) {
      response.end('{"choices":[{"message":{"content":"{\\"ok\\":"}}]}');
      return;
    }
    response.end('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}');
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
    response.writeHead(200, { "content-type": "application/json" });
    if (requests.length === 1) {
      response.end('{"choices":[{"message":{"content":"{\\"variants\\":[{\\"id\\":\\"V1\\",\\"title\\":\\"截断"}}]}');
      return;
    }
    response.end('{"choices":[{"message":{"content":"{\\"variants\\":[{\\"id\\":\\"V1\\",\\"title\\":\\"修复成功\\"}]}"}}]}');
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

test("brief 提示词明确区分可复用结构与禁止表达", () => {
  const prompt = briefPrompt({
    referenceAnalysis: {},
    sourceScriptReconstruction: {},
    creatorProfile: {
      fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾",
      vertical: "治愈日常",
      constraints: ""
    }
  });
  assert.match(prompt, /不能因为原片使用过就一刀切禁止/);
  assert.match(prompt, /protectedExpressions 只允许放具体且可识别的表达/);
  assert.match(prompt, /送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾/);
  assert.match(prompt, /企鹅服女孩/);
  assert.match(prompt, /不能把“企鹅”“企鹅快递员”“翅膀\/尾巴动作”等表面元素写进固定角色映射或新故事/);
  assert.match(prompt, /roleAndOccupationMapping 的第一项必须映射原片主角的剧作功能/);
  assert.match(prompt, /fixedCharacter 是最高优先级/u);
  assert.match(prompt, /猫娘.*猫耳少女.*猫尾/u);
  assert.match(prompt, /优先复述用户原词/u);
  assert.match(prompt, /动物角色.*拟人动物.*兽类角色.*动物形象少女/u);
  assert.match(prompt, /猫耳发箍.*不能.*猫娘身份/u);
  assert.match(prompt, /newRole.*newOccupationOrIdentity.*最终身份/u);
  assert.match(prompt, /mappingLogic.*剧作功能迁移/u);
  assert.match(prompt, /sourceFunction.*protectedExpressions/u);
});

test("模型漏掉必要字段时拒绝把结果标记为成功", () => {
  assert.throws(() => ensureOutputContract({ storySynopsis: "只有一个字段" }, "referenceAnalysis"), /缺少必要字段/);
  assert.throws(() => ensureOutputContract({ variants: [] }, "themeVariants"), /至少需要一个主题方案/);
  assert.throws(() => ensureOutputContract({ selectedVariantId: "V1" }, "fullStory"), /缺少必要字段/);
  assert.throws(() => ensureOutputContract({ selectedVariantId: "V1" }, "animationPlan"), /缺少必要字段/);
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
      name: "characters 为空",
      mutate(story) {
        story.sceneScript[3].characters = [];
      },
      path: "fullStory.sceneScript[3].characters"
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
    story.sceneScript[3].characters = [];
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

test("creativeBrief 将动态身份和来源表面词交给 Visual Guardrails", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q 版狼耳少女，形象类似于猫娘，猫一样的耳朵，整体性格活泼可爱，懂事，学生/村民 · 村里的热心帮手",
    vertical: "治愈/温情/日常/日系 2.5D 新海诚光景风格",
    constraints: "小白子基本只用嗷或嗷呜表达情绪"
  };
  const brief = creativeBriefFixture(creatorProfile, {
    newRole: "小白子，猫娘、狼耳少女，村里的热心帮手",
    newOccupationOrIdentity: "学生/村民",
    mappingLogic: "保留原片快递员承担送达任务和连接人物的剧作功能"
  });
  brief.protectedExpressions.push({
    expressionType: "身份外壳",
    sourceExpression: "快递员",
    prohibition: "不得直接复制原片职业外壳",
    safeAlternativePrinciple: "只保留任务执行功能"
  });

  assert.doesNotThrow(() => validateCreativeBrief(brief, creatorProfile));

  const guardrailsPrompt = visualGuardrailsPrompt({
    creatorProfile,
    referenceAnalysis: { storySynopsis: "原片主角承担快递任务" },
    sourceScriptReconstruction: { relationshipPattern: "任务执行者连接村民" },
    creativeBrief: brief
  });
  assert.match(guardrailsPrompt, /角色边界与创作规则审查 AI/u);
  assert.match(guardrailsPrompt, /q 版狼耳少女/u);
  assert.match(guardrailsPrompt, /形象类似于猫娘/u);
  assert.match(guardrailsPrompt, /快递员/u);

  const guardrails = ensureVisualGuardrailsMatchesProfile(
    ensureOutputContract(mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: brief }), "visualGuardrails"),
    creatorProfile
  );
  assert.ok(guardrails.sourceSimilarityRules.some((rule) => rule.sourceExpression === "快递员"));
});

test("creativeBrief 第一项 newRole 必须保留固定角色姓名", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，猫耳少女，村里的热心帮手",
    vertical: "治愈日常",
    constraints: ""
  };
  const brief = creativeBriefFixture(creatorProfile, {
    newRole: "神秘少女阿花",
    mappingLogic: "小白子原本的剧作功能由阿花承担"
  });
  assert.throws(
    () => validateCreativeBrief(brief, creatorProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newRole")
      && error.message.includes("小白子")
  );
});

test("creativeBrief 固定姓名校验失败后只纠偏一次", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const invalidBrief = creativeBriefFixture(creatorProfile, {
    newRole: "神秘少女阿花",
    mappingLogic: "小白子的剧作功能错误地交给了阿花"
  });
  const correctedBrief = creativeBriefFixture(creatorProfile);
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return prompts.length === 1 ? invalidBrief : correctedBrief;
      }
    }
  });

  const result = await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });

  assert.equal(prompts.length, 2);
  assert.match(result.roleAndOccupationMapping[0].newRole, /小白子/u);
  assert.match(prompts[1], /creativeBrief\.roleAndOccupationMapping\[0\]\.newRole/u);
  assert.match(prompts[1], /不得更换或重命名主角/u);
});

test("creativeBrief 第二次输出仍丢失固定姓名时抛出 OutputContractError", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const invalidBrief = creativeBriefFixture(creatorProfile, {
    newRole: "神秘少女阿花",
    mappingLogic: "小白子的剧作功能错误地交给了阿花"
  });
  let calls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        calls += 1;
        return invalidBrief;
      }
    }
  });

  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newRole")
  );
  assert.equal(calls, 2);
});

test("creativeBrief 动态表面词不会在 Visual Guardrails 前触发自动纠偏", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const leakedBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  leakedBrief.roleAndOccupationMapping[0].newRole = "小白子";
  leakedBrief.roleAndOccupationMapping[0].newOccupationOrIdentity = "一只呆萌但尽责的“企鹅快递员”，是村里孩子们都喜欢的可爱帮手。";
  leakedBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });

  let calls = 0;
  const workflow = new WorkflowService({
    client: { async generateJson() { calls += 1; return leakedBrief; } }
  });

  const result = await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });
  assert.equal(calls, 1);
  assert.match(result.roleAndOccupationMapping[0].newOccupationOrIdentity, /企鹅快递员/u);
});

test("creativeBrief 的安全改写方向允许提及被替换的原片表达", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "温馨/日常/治愈",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const brief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  brief.protectedExpressions.push({
    expressionType: "关键道具",
    sourceExpression: "录取通知书",
    prohibition: "禁止直接复用录取通知书作为情感媒介。",
    safeAlternativePrinciple: "更换为适合新赛道的新情感媒介。"
  });
  brief.controlledRewriteVariables.push({
    variable: "情感媒介",
    sourceValue: "录取通知书",
    allowedDirections: ["不要继续使用录取通知书，改成小白子在村里能自然接触到的新情感媒介", "保留传递希望的剧作功能"],
    mustChange: true,
    reason: "允许在安全改写说明中点名被替换对象，但后续故事不能直接复用。"
  });

  const workflow = new WorkflowService({
    client: { async generateJson() { return brief; } }
  });

  const result = await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });
  assert.ok(result.controlledRewriteVariables.some((item) => JSON.stringify(item).includes("录取通知书")));
});

test("creativeBrief 拒绝 protectedExpressions 的错误字段名", () => {
  const brief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  brief.protectedExpressions = [{
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    "safeAlternative Principle": "错误 key，应该是 safeAlternativePrinciple。"
  }];
  assert.throws(() => ensureOutputContract(brief, "creativeBrief"), /safeAlternativePrinciple/);
});

test("主题变体必须锁定用户指定固定角色，不能另起主角名", async () => {
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
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
          storyOutline: [{ beat: 1, phase: "任务", action: "小雨接过音乐盒出发", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 }],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "老师请小雨吃红薯",
          transformationProof: { changedCharacters: "", changedTask: "", changedDetailsAndProps: "", changedDialogue: "", changedVisualExpression: "" },
          experienceFidelity: { positioning: "", audience: "", emotion: "", plotDriver: "", highValueBeats: "" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "", mitigation: "" }
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

test("主题变体禁止继承 creativeBrief 中已保护的表面形象", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        return { variants: [{
          id: "V1",
          title: "雾中画境",
          oneLineHook: "小白子冒雾送画。",
          logline: "企鹅快递员小白子被委托将画作送到山村女孩手中。",
          verticalFit: "治愈/温情/日常",
          characterSetup: { protagonist: "小白子，一只呆萌但尽责的企鹅快递员", careRecipient: "小月", helper: "老张" },
          newTask: "送画作",
          emotionalMedium: "儿童画",
          environmentPressure: "大雾",
          storyOutline: [{ beat: 1, phase: "任务", action: "小白子翅膀微拍，整理背包出发。", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 }],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "小白子尾巴轻摇，与小月一起放风筝。",
          transformationProof: { changedCharacters: "", changedTask: "", changedDetailsAndProps: "", changedDialogue: "", changedVisualExpression: "" },
          experienceFidelity: { positioning: "", audience: "", emotion: "", plotDriver: "", highValueBeats: "" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "", mitigation: "" }
        }] };
      }
    }
  });

  await assert.rejects(
    () => workflow.createVariants(globalBoundaryContext(workflow, { creativeBrief, creatorProfile, count: 1 })),
    /企鹅|翅膀|尾巴/
  );
});

test("主题变体禁止复用 mustChange 受控改写变量", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.controlledRewriteVariables.push(
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
      async generateJson() {
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
          storyOutline: [{ beat: 1, phase: "任务", action: "小白子抱着录取通知书出发。", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 }],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "两人一起放孔明灯。",
          transformationProof: { changedCharacters: "", changedTask: "", changedDetailsAndProps: "", changedDialogue: "", changedVisualExpression: "" },
          experienceFidelity: { positioning: "", audience: "", emotion: "", plotDriver: "", highValueBeats: "" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "", mitigation: "" }
        }] };
      }
    }
  });

  await assert.rejects(
    () => workflow.createVariants(globalBoundaryContext(workflow, { creativeBrief, creatorProfile, count: 1 })),
    /录取通知书|孔明灯/
  );
});

test("完整剧情禁止继承 creativeBrief 中已保护的表面形象", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
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
  leakedStory.characterBible.protagonist.identity = "小白子，一只呆萌但尽责的企鹅快递员";
  leakedStory.sceneScript[0].visibleAction = "小白子翅膀微拍，准备出发。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedStory; } },
    storyModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => workflow.createFullStory(globalBoundaryContext(workflow, { creativeBrief, creatorProfile, variant })),
    /企鹅|翅膀/
  );
});

test("完整剧情禁止复用 mustChange 受控改写变量，但允许在避相似说明里负向提及", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.controlledRewriteVariables.push(
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
    client: { async generateJson() { return leakedStory; } },
    storyModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => leakedWorkflow.createFullStory(globalBoundaryContext(leakedWorkflow, { creativeBrief, creatorProfile, variant })),
    /录取通知书|孔明灯/
  );

  assert.doesNotThrow(() => ensureOutputContract(safeStory, "fullStory"));
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(safeStory, creatorProfile, creativeBrief, variant));
});

test("完整剧情校验失败时会自动要求模型纠偏一次", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
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
  const fixedStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  fixedStory.characterBible.protagonist.signatureBehaviors = ["狼耳轻轻抖动表示开心", "抱紧风车表示认真"];
  fixedStory.sceneScript[0].visibleAction = "小白子抱紧风车，狼耳轻轻抖动，认真出发。";
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return prompts.length === 1 ? leakedStory : fixedStory;
      }
    }
  });

  const result = await workflow.createFullStory(globalBoundaryContext(
    workflow,
    { creativeBrief, creatorProfile, variant },
    xiaobaiziBoundary()
  ));

  assert.equal(result.selectedVariantId, "V1");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /没有通过系统校验/);
  assert.doesNotMatch(JSON.stringify(result), /狼爪|肉垫/);
});

test("Scene Contract 失败会携带全部路径重试完整 fullStory 一次", async () => {
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
  const validStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return prompts.length === 1 ? structuredClone(invalidStory) : structuredClone(validStory);
      }
    }
  });

  const result = await workflow.createFullStory(globalBoundaryContext(workflow, {
    creativeBrief,
    creatorProfile,
    variant
  }));

  assert.equal(prompts.length, 2);
  assert.equal(result.selectedVariantId, variant.id);
  assert.match(prompts[1], /FULL_STORY_SCENE_CONTRACT_RETRY_V1/u);
  assert.match(prompts[1], /fullStory\.sceneScript\[3\]\.location/u);
  assert.match(prompts[1], /fullStory\.sceneScript\[3\]\.characters/u);
  assert.match(prompts[1], /fullStory\.sceneScript\[3\]\.visibleAction/u);
  assert.match(prompts[1], /上一次待修完整 JSON/u);
});

test("Full Story 第二次 Scene Contract 仍失败时终止且不产生第三次请求", async () => {
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
  let calls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        calls += 1;
        if (calls > 2) throw new Error("禁止第三次完整剧情请求");
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
  assert.equal(calls, 2);
});

test("动画入口在任何模型与 Compiler 调用前拒绝残缺 Full Story", async () => {
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
        throw new Error("残缺 Full Story 不得调用任何模型或 Compiler");
      }
    },
    staticFrameCompilerProvider: "MiMo",
    staticFrameCompilerModel: TEST_STATIC_FRAME_COMPILER_MODEL
  });

  await assert.rejects(
    () => workflow.createAnimationPlan(globalBoundaryContext(workflow, {
      ...context,
      creativeBrief,
      variant,
      fullStory
    })),
    /fullStory Scene Contract 校验失败/u
  );
  assert.equal(modelCalls, 0);
});

test("动画生产包正向提示词复用原片表面形象时会被边界校验拦截", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
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
  const fullStory = mockFullStory({
    ...input,
    creatorProfile: { ...creatorProfile, fixedCharacter: "小白子，q版狼耳少女，活泼可爱，懂事，学生/村民" },
    creativeBrief,
    variant
  });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  leakedPlan.shotPlan[0].startFrame.characters[0].actionState = "企鹅快递员小白子站在村口，翅膀抬至胸前，手里拿着画。";
  const workflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => workflow.createAnimationPlan(globalBoundaryContext(workflow, { creativeBrief, creatorProfile, variant, fullStory })),
    /企鹅|翅膀|正向画面提示词/
  );
});

test("Visual Guardrails 推断狼尾后下游直接沿用，并继续禁止兽爪肉垫", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，狼耳少女，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，狼耳少女", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const fullStory = mockFullStory({
    ...input,
    creatorProfile: { ...creatorProfile, fixedCharacter: "小白子，q版狼耳少女，活泼可爱，懂事，学生/村民" },
    creativeBrief,
    variant
  });
  const tailPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  tailPlan.characterReferencePrompts[0].appearancePrompt = "小白子，狼耳少女，带狼尾站在村口，保持人形双手。";
  tailPlan.shotPlan[0].startFrame.characters[0].actionState = "小白子狼尾轻轻摇动，双手扶住风车。";
  const workflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(tailPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => workflow.createAnimationPlan(globalBoundaryContext(
      workflow,
      { creativeBrief, creatorProfile, variant, fullStory },
      xiaobaiziBoundary()
    ))
  );

  const clawPlan = structuredClone(tailPlan);
  clawPlan.characterReferencePrompts[0].appearancePrompt = "小白子，狼耳少女，带狼尾和肉垫，狼爪轻轻扒着风车。";
  const rejectingWorkflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(clawPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.rejects(
    () => rejectingWorkflow.createAnimationPlan(globalBoundaryContext(
      rejectingWorkflow,
      { creativeBrief, creatorProfile, variant, fullStory },
      xiaobaiziBoundary()
    )),
    /兽爪|狼爪|肉垫|全局边界禁止特征/
  );
});

test("用户明确否定尾巴时覆盖模型常识并阻止下游重新加入", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，但明确没有尾巴，活泼可爱，懂事，学生/村民",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，q版狼耳少女，无尾巴", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const fullStory = mockFullStory({
    ...input,
    creatorProfile: { ...creatorProfile, fixedCharacter: "小白子，q版狼耳少女，活泼可爱，懂事，学生/村民" },
    creativeBrief,
    variant
  });
  const tailPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  tailPlan.characterReferencePrompts[0].appearancePrompt = "小白子，q版狼耳少女，出现狼尾巴，穿浅蓝背带裙。";
  const workflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(tailPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.rejects(
    () => workflow.createAnimationPlan(globalBoundaryContext(
      workflow,
      { creativeBrief, creatorProfile, variant, fullStory },
      xiaobaiziBoundary({ tail: "forbidden" })
    )),
    /狼尾|狼尾巴|尾巴|全局边界禁止特征/
  );
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
    /同时要求并禁止：狼尾/u
  );
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

  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    shot: {
      shotId: "A01",
      startFramePrompt: "小白子保持灰白色狼耳与狼尾，站在墙边。",
      acceptanceCriteria: ["小白子狼耳保持灰白色毛茸茸形态，无猫耳变异"]
    }
  });
  assert.doesNotMatch(prompt, /猫耳/u);
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    prompt,
    visualGuardrails,
    { requireRequiredTraits: false }
  ));

  const videoPrompt = shotVideoGenerationPromptText({
    shot: {
      videoPrompt: "小白子保持狼耳与狼尾，抬手贴好信纸。",
      acceptanceCriteria: ["无猫耳变异"],
      negativePrompts: { video: [{ text: "猫耳" }] }
    },
    startFrameDataUrl: "data:image/png;base64,AA==",
    endFrameDataUrl: "data:image/png;base64,AA=="
  });
  assert.doesNotMatch(videoPrompt, /猫耳/u);
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    videoPrompt,
    visualGuardrails,
    { requireRequiredTraits: false }
  ));
  const videoPromptWithGeneratedFrames = shotVideoGenerationPromptText({
    shot: {
      videoPrompt: "小白子抬手贴好信纸。",
      startFramePrompt: "小白子是猫耳少女，站在墙边。",
      endFramePrompt: "小白子放下双手。"
    }
  });
  assert.throws(() => ensureCharacterPromptMatchesBoundary(
    videoPromptWithGeneratedFrames,
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

test("角色边界、原片规避与逐镜渲染负面提示词在 prompt 中保持分类", () => {
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
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });

  const variantPrompt = variantsPrompt({ creativeBrief, visualGuardrails, creatorProfile, count: 2 });
  const storyPrompt = fullStoryPrompt({ creativeBrief, visualGuardrails, referenceAnalysis: {}, sourceScriptReconstruction: {}, variant, creatorProfile });
  const animationPrompt = animationPlanPrompt({ creativeBrief, visualGuardrails, variant, fullStory, creatorProfile });

  for (const prompt of [variantPrompt, storyPrompt]) {
    assert.match(prompt, /positivePromptBoundary/);
    assert.match(prompt, /sourceSimilarityRules/);
    assert.match(prompt, /彩虹披风/);
  }
  assert.match(animationPrompt, /positivePromptBoundary/);
  assert.match(animationPrompt, /sourceSimilarityRules/);
  assert.match(animationPrompt, /彩虹披风/);
  assert.match(animationPrompt, /negativePrompts\.image/);
  assert.match(animationPrompt, /triggerEvidence/);
  assert.doesNotMatch(animationPrompt, /commonNegativePrompt/);
});

test("动画生产包会按 positivePromptBoundary 拦截正向画面越界", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，有狼尾巴，儿童",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，q版狼耳少女，有狼尾巴", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant, visualGuardrails });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory, visualGuardrails });
  leakedPlan.shotPlan[0].startFrame.characters[0].actionState = "小白子站在村口，翅膀从肩后伸出。";
  const workflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  const stageContext = {
    ...input,
    ...groundedUpstreamFixture(workflow),
    creativeBrief,
    creatorProfile,
    variant,
    fullStory
  };

  await assert.rejects(
    () => workflow.createAnimationPlan(sealBoundaryContext(workflow, stageContext, visualGuardrails)),
    /翅膀|正向画面提示词/
  );
});

test("台词规则不会进入逐镜渲染负面提示词，混入时会被相关性裁剪", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，有狼尾巴，儿童",
    vertical: "治愈/温情/日常",
    constraints: "主角只用嗷或嗷呜表达"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.dialogueRules.push({
    text: "主角不得使用“咕嘎”。",
    triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "主角只用嗷或嗷呜表达" }]
  });
  visualGuardrails.dialogueRules.push({
    text: "主角不得使用“阿巴”。",
    triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "主角只用嗷或嗷呜表达" }]
  });
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，q版狼耳少女，有狼尾巴", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant, visualGuardrails });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory, visualGuardrails });
  leakedPlan.shotPlan[0].negativePrompts.image.push({
    text: "咕嘎",
    appliesTo: "image",
    triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "主角只用嗷或嗷呜表达" }],
    reasonCode: "explicit_identity_conflict",
    priority: "high"
  });
  leakedPlan.shotPlan[0].negativePrompts.image.push({
    text: "阿巴",
    appliesTo: "image",
    triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "主角只用嗷或嗷呜表达" }],
    reasonCode: "explicit_identity_conflict",
    priority: "high"
  });
  const pruningWorkflow = animationWorkflow({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  const stageContext = {
    ...input,
    ...groundedUpstreamFixture(pruningWorkflow),
    creativeBrief,
    creatorProfile,
    variant,
    fullStory
  };
  const result = await pruningWorkflow.createAnimationPlan(
    sealBoundaryContext(pruningWorkflow, stageContext, visualGuardrails)
  );
  assert.deepEqual(result.shotPlan[0].negativePrompts.image, []);
  assert.doesNotMatch(JSON.stringify(result.shotPlan.flatMap((shot) => Object.values(shot.negativePrompts))), /咕嘎|阿巴/u);
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
  assert.match(prompt, /selectedVariantId 必须等于选中主题变体 id：V2/);
  assert.match(prompt, /不能改名/);
  assert.match(prompt, /不得再次解析 fixedCharacter 或重新推断角色特征/);
  assert.match(prompt, /禁止复用原片具体表达黑名单/);
  assert.match(prompt, /录取通知书/);
  assert.match(prompt, /孔明灯/);
  assert.match(prompt, /sceneScript 至少 6 场/);
  assert.match(prompt, /location、characters 和 visibleAction 都必须完整填写/u);
  assert.match(prompt, /speaker 必须逐字存在于同场 characters/u);
  assert.match(prompt, /不支持 offscreen、voiceOver、narrator 或 isVisible/u);
  assert.match(prompt, /只能补充，不能替代这些结构字段/u);
  assert.match(prompt, /"characters":\["标准角色名"\]/u);
});

test("动画提示词要求输出首尾帧视频生产包", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女，小女孩，儿童", vertical: "治愈日常", constraints: "只用嗷呜表达" };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  const prompt = animationPlanPrompt({
    creativeBrief: {},
    visualGuardrails,
    variant: { id: "V2", title: "雨停之前" },
    fullStory: { selectedVariantId: "V2", title: "雨停之前", sceneScript: [] },
    creatorProfile
  });
  assert.match(prompt, /首尾帧 AI 视频生产包/);
  assert.match(prompt, /"promptSchemaVersion":"2\.0"/);
  assert.match(prompt, /"startFrame":\{/);
  assert.match(prompt, /"endFrame":\{/);
  assert.match(prompt, /"motion":\{/);
  assert.doesNotMatch(prompt, /"startFramePrompt"\s*:/);
  assert.doesNotMatch(prompt, /"endFramePrompt"\s*:/);
  assert.doesNotMatch(prompt, /"videoPrompt"\s*:/);
  assert.match(prompt, /默认 8–12 个镜头/);
  assert.match(prompt, /三层简化结构/);
  assert.match(prompt, /identity \/ scene lock/);
  assert.match(prompt, /sceneReferencePrompts/);
  assert.match(prompt, /negativePrompts\.image/);
  assert.match(prompt, /negativePrompts\.video/);
  assert.match(prompt, /两个负面数组都允许为空，不设置最少条目数/);
  assert.match(prompt, /triggerEvidence/);
  assert.match(prompt, /reasonCode/);
  assert.doesNotMatch(prompt, /全局负面提示词，只写一次/);
  assert.match(prompt, /拆镜头方案 B/);
  assert.match(prompt, /中景互动镜头/);
  assert.match(prompt, /表情强化镜头/);
  assert.match(prompt, /静态冻结关键帧/);
  assert.match(prompt, /startFrame\.environment\.sceneId 和 endFrame\.environment\.sceneId/);
  assert.match(prompt, /timingBeats 必须有 1–4 条/);
  assert.match(prompt, /cameraMove\.mode=locked/);
  assert.match(prompt, /cameraMove\.mode=continuous/);
  assert.match(prompt, /shot\.startFrame\/endFrame 只用角色名和 sceneId 承接全局锁定/);
  assert.match(prompt, /固定角色外观边界/);
  assert.match(prompt, /不得重新推断、删除、替换或新增固定角色事实/);
  assert.match(prompt, /"canonicalName":"狼尾"/);
});

test("下游提示词同时携带全局必需与禁止事实，不再解析原始角色词", () => {
  const creatorProfile = { fixedCharacter: "小白子，狼耳少女", vertical: "治愈日常", constraints: "" };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief: {} });
  visualGuardrails.fixedCharacterBoundary = xiaobaiziBoundary();
  const prompt = animationPlanPrompt({
    creativeBrief: {},
    visualGuardrails,
    variant: { id: "V1", title: "风车" },
    fullStory: { selectedVariantId: "V1", title: "风车", sceneScript: [] },
    creatorProfile
  });
  assert.match(prompt, /"canonicalName":"狼尾"/);
  assert.match(prompt, /"canonicalName":"兽爪"/);
  assert.match(prompt, /不得重新推断|不得再次生成或修改固定角色特征/);
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
