import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowService } from "../src/workflow.js";
import { getConfig } from "../src/config.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureVisualGuardrailsMatchesProfile } from "../src/validation.js";
import { buildRequestBody, MimoClient, parseModelJson } from "../src/mimo-client.js";
import { buildQwenRequestBody, QwenClient } from "../src/qwen-client.js";
import { JimengImageClient, buildCharacterReferenceImagePrompt, buildJimengImageRequestBody, buildShotFrameImagePrompt } from "../src/jimeng-client.js";
import { RECONSTRUCTION_SYSTEM_PROMPT, SYSTEM_PROMPT, animationPlanPrompt, briefPrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "../src/prompts.js";
import { parseRunVideoArgs } from "../src/run-video-command.js";
import { generateShotVideo, ShotVideoConfigError, ShotVideoProviderError } from "../src/shot-video-generator.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { mimeTypeFor, selectSampleTimestamps } from "../src/video-file.js";
import { collectFixedCharacterVisualPolicy, extractFixedCharacterName, fixedCharacterVisualPolicyText } from "../src/validation.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVisualGuardrails } from "../src/mock.js";
import { syncShotCharacterReference } from "../public/character-reference-sync.js";
import { shotRelatedCharacterReferences, uploadedReferenceImages } from "../public/shot-reference-images.js";
import { groundingContextDigest, sealReconstruction } from "../src/reconstruction-grounding.js";

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

function stagedAnimationResponse(plan, prompt = "") {
  if (prompt.includes("本阶段只生成可供所有镜头批次复用")) return animationFoundationFixture(plan);
  const match = prompt.match(/本批允许的 sourceSceneId：([^\n]+)/u);
  const sourceSceneIds = String(match?.[1] || "").split("、").map((item) => item.trim()).filter(Boolean);
  return {
    shotPlan: structuredClone(plan.shotPlan.filter((shot) => sourceSceneIds.includes(String(shot.sourceSceneId))))
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

test("角色边界阶段保留用户显式狼尾巴且不生成未声明特征负面词库", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，有狼尾巴，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子只用嗷呜表达"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const guardrails = ensureVisualGuardrailsMatchesProfile(
    ensureOutputContract(mockVisualGuardrails({ ...input, creatorProfile, creativeBrief }), "visualGuardrails"),
    creatorProfile
  );
  assert.deepEqual(guardrails.fixedCharacterBoundary.allowedBodyFeatures.filter((term) => term === "狼尾巴"), ["狼尾巴"]);
  assert.match(guardrails.positivePromptBoundary[0].rule, /不得擅自添加/);
  assert.deepEqual(guardrails.positivePromptBoundary[0].triggerEvidence, [{
    sourcePath: "creatorProfile.fixedCharacter",
    evidence: creatorProfile.fixedCharacter
  }]);
  assert.equal(Object.hasOwn(guardrails, "forbiddenPositiveTraits"), false);
  assert.equal(Object.hasOwn(guardrails, "commonNegativePrompt"), false);
  assert.doesNotMatch(JSON.stringify(guardrails), /鸟喙|脚蹼|鳍|羽毛|狐尾|兔尾|龙尾/);
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
  assert.match(prompt, /形象类似猫娘，有狼尾巴/);
  assert.match(prompt, /本阶段不生成图片或视频模型的最终负面提示词/);
  assert.match(prompt, /未声明只表示后续正向提示词不得擅自添加/);
  assert.match(prompt, /不得额外输出旧版字段/);
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
  const workflow = new WorkflowService({
    storyModel: "mimo-v2.5-pro",
    storyMaxCompletionTokens: 12345,
    client: {
      async generateJson(args) {
        captured = args;
        return mockFullStory({ ...input, creativeBrief, variant });
      }
    }
  });
  const result = await workflow.createFullStory({ ...input, ...groundedUpstreamFixture(workflow), creativeBrief, variant });
  assert.equal(captured.model, "mimo-v2.5-pro");
  assert.equal(captured.maxCompletionTokens, 12345);
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

  const fullStory = await workflow.createFullStory({ ...input, ...groundedUpstreamFixture(workflow), creativeBrief, variant });
  const animationPlan = await workflow.createAnimationPlan({ ...input, creativeBrief, variant, fullStory });

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
  const result = await workflow.createFullStory({
    ...input,
    ...groundedUpstreamFixture(workflow),
    creativeBrief,
    variant,
    modelOverrides: {
      fullStory: { provider: "Qwen", model: "qwen-custom-story", maxCompletionTokens: 22000 }
    }
  });
  assert.equal(result.selectedVariantId, "V1");
  assert.equal(calls[0].model, "qwen-custom-story");
  assert.equal(calls[0].maxCompletionTokens, 22000);
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
  const workflow = new WorkflowService({
    animationModel: "mimo-v2.5-pro",
    animationMaxCompletionTokens: 13000,
    client: {
      async generateJson(args) {
        captured = args;
        return stagedAnimationResponse(mockAnimationPlan({ ...input, creativeBrief, variant, fullStory }), args.prompt);
      }
    }
  });
  const result = await workflow.createAnimationPlan({ ...input, creativeBrief, variant, fullStory });
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

  const result = await workflow.refineCharacterReference({
    imageName: "xiaobaizi.png",
    imageDataUrl: "data:image/png;base64,AA==",
    creatorProfile,
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
  });

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

test("即梦首尾帧镜头图 prompt 合并视觉圣经、角色参考和帧提示词", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    visualBible: {
      overallStyle: "Q版定格动画",
      animationStyle: "柔和乡村童话",
      colorPalette: ["米白", "浅蓝"],
      lighting: "清晨柔光",
      cameraLanguage: "低机位近景"
    },
	    characterReferences: [{
      characterName: "小白子",
      appearancePrompt: "q版狼耳少女，蓝色眼睛",
      consistencyTags: ["狼耳", "浅蓝服装"],
	      referenceImageDataUrl: "data:image/png;base64,AA=="
	    }],
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
  assert.match(prompt, /小白子：@图一/);
  assert.match(prompt, /@图一=第1张输入图片/);
  assert.match(prompt, /第1张输入参考图/);
  assert.doesNotMatch(prompt, /q版狼耳少女/);
  assert.doesNotMatch(prompt, /一致性标签：狼耳/);
  assert.match(prompt, /首帧画面提示词（人物外观、服装、发型、年龄感和身份特征以 @图 为准/);
  assert.match(prompt, /小白子（@图一）站在村口/);
  assert.match(prompt, /首帧是静态关键帧/);
  assert.match(prompt, /严格锁定画幅、景别、机位、主体位置/);
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

test("尾帧镜头图会继承首帧场景锚点并禁止室内外跳变", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "end",
    characterReferences: [{
      characterName: "外婆",
      appearancePrompt: "和蔼老人，穿围裙",
      referenceImageDataUrl: "data:image/png;base64,AA=="
    }, {
      characterName: "小白子",
      appearancePrompt: "Q版白发猫耳少女，蓝色眼睛",
      referenceImageDataUrl: "data:image/png;base64,BB=="
    }],
    shot: {
      startFramePrompt: "阳光明媚的外婆（和蔼的老年女性，头发灰白盘起，穿着围裙）院子，中景平视。外婆微笑着递出一个复古旧铁盒。小白子站在对面，双手微抬准备接物。背景是温馨的农家院落与茂密绿植，光线柔和。",
      endFramePrompt: "小白子双手稳稳抱住旧铁盒，身体微微前倾。外婆的手已收回。小白子面带笑容。"
    }
  });
  assert.match(prompt, /同镜头连续性锁定/);
  assert.match(prompt, /首帧场景锚点/);
  assert.match(prompt, /外婆院子/);
  assert.match(prompt, /中景平视/);
  assert.match(prompt, /背景是温馨的农家院落与茂密绿植/);
  assert.match(prompt, /光线柔和/);
  assert.match(prompt, /禁止切换到室内/);
  assert.match(prompt, /保持同一地点、同一室内\/户外属性/);
  assert.doesNotMatch(prompt, /外婆（@图一）院子/);
});

test("连续运镜的尾帧允许采用声明后的新机位而不强制复用首帧机位", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "end",
    sceneReference: {
      sceneId: "LOC01",
      sceneName: "夕阳下的木屋院子",
      continuityAnchors: ["户外", "木屋院子", "夕阳"]
    },
    shot: {
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

  assert.match(prompt, /只沿 motion\.cameraMove 声明的连续路径/);
  assert.match(prompt, /严格采用尾帧指定的景别、角度和构图/);
  assert.doesNotMatch(prompt, /同一景别、同一机位方向/);
});

test("有参考图角色会清理首尾帧画面提示词里的外观文字", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    characterReferences: [{
      characterName: "小白子",
      appearancePrompt: "Q版狼耳少女，灰白色狼耳朵和狼尾巴，黑色校园风外套。",
      referenceImageDataUrl: "data:image/png;base64,AA=="
    }],
    shot: {
      startFramePrompt: "日系2.5D治愈动画风格，Q版狼耳少女小白子（日系2.5D治愈动画风格，Q版二头身比例，狼耳少女，有毛茸茸的灰白色狼耳朵和蓬松的灰白色狼尾巴）坐在木质书桌前，穿着浅黄色背带裙，头顶灰白色狼耳朵，身后有灰白色狼尾巴。她双手拿着一条织了一半的彩虹手链，眼神专注。",
      endFramePrompt: "小白子抬头。"
    }
  });
  assert.match(prompt, /小白子：@图一/);
  assert.match(prompt, /小白子（@图一）坐在木质书桌前/);
  assert.match(prompt, /彩虹手链/);
  assert.doesNotMatch(prompt, /Q版狼耳少女小白子/);
  assert.doesNotMatch(prompt, /浅黄色背带裙|灰白色狼耳朵|灰白色狼尾巴|黑色校园风外套/);
});

test("首尾帧镜头图不会把地点所有者映射成参考图角色", () => {
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    characterReferences: [{
      characterName: "外婆",
      appearancePrompt: "和蔼老人，穿围裙",
      referenceImageDataUrl: "data:image/png;base64,AA=="
    }, {
      characterName: "小白子",
      appearancePrompt: "Q版白发猫耳少女，蓝色眼睛",
      referenceImageDataUrl: "data:image/png;base64,BB=="
    }],
    shot: {
      startFramePrompt: "阳光明媚的外婆（和蔼的老年女性，头发灰白盘起，穿着围裙）院子，近景平视。小白子（Q版少女，白色长发及腰，头顶猫耳）双手抱着旧铁盒在胸前，眼睛弯成月牙。",
      endFramePrompt: "小白子身体转向画面右侧。"
    }
  });
  assert.match(prompt, /外婆院子，近景平视/);
  assert.match(prompt, /小白子（@图二）双手抱着旧铁盒/);
  assert.doesNotMatch(prompt, /外婆（@图一）院子/);
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

test("creativeBrief 接受 fixedCharacter 明确授权的猫娘身份", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const brief = creativeBriefFixture(creatorProfile, {
    newRole: "小白子，Q版猫耳少女，形象类似猫娘",
    newOccupationOrIdentity: "猫娘，村里的热心帮手"
  });

  assert.doesNotThrow(() => validateCreativeBrief(brief, creatorProfile));
});

test("creativeBrief 猫娘语义授权只放行同物种身份别名，不放行泛动物身份", () => {
  const identityProfiles = [
    "小白子，猫尾少女，村里的热心帮手",
    "小白子，猫耳和猫尾作为角色固定身体特征，普通少女，村里的热心帮手"
  ];
  for (const fixedCharacter of identityProfiles) {
    const creatorProfile = { fixedCharacter, vertical: "治愈日常", constraints: "" };
    const brief = creativeBriefFixture(creatorProfile, {
      newRole: "小白子，猫娘，保留用户明确声明的猫耳与猫尾",
      newOccupationOrIdentity: "猫系少女，村里的热心帮手"
    });
    assert.doesNotThrow(() => validateCreativeBrief(brief, creatorProfile));
  }

  const creatorProfile = {
    fixedCharacter: "小白子，猫耳少女，村里的热心帮手",
    vertical: "治愈日常",
    constraints: ""
  };
  const generalized = creativeBriefFixture(creatorProfile, {
    newRole: "小白子，猫娘，拟人动物角色"
  });
  assert.throws(
    () => validateCreativeBrief(generalized, creatorProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newRole")
      && /拟人动物|动物角色/u.test(error.message)
  );

  for (const generalizedIdentity of ["动物战士", "动物女孩", "动物精灵", "动物护送者", "动物脸"]) {
    const generalizedBrief = creativeBriefFixture(creatorProfile, {
      newRole: `小白子，猫娘，${generalizedIdentity}`
    });
    assert.throws(
      () => validateCreativeBrief(generalizedBrief, creatorProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newRole")
        && error.message.includes("动物")
    );
  }
});

test("creativeBrief.mappingLogic 允许明确否定原片动物与玩偶外壳", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const mappingLogicCases = [
    "不继承原片拟人化动物身份，只保留主动帮助他人的剧作功能",
    "不使用原片企鹅服、玩偶服或动物外壳，只保留善意连接者的剧作功能"
  ];

  for (const mappingLogic of mappingLogicCases) {
    const brief = creativeBriefFixture(creatorProfile, { mappingLogic });
    brief.protectedExpressions.push({
      expressionType: "视觉元素",
      sourceExpression: "企鹅服、玩偶服或动物外壳",
      prohibition: "不得继承这些原片外壳。",
      safeAlternativePrinciple: "只保留剧作功能。"
    });
    assert.doesNotThrow(() => validateCreativeBrief(brief, creatorProfile), mappingLogic);
  }
});

test("creativeBrief.mappingLogic 的正向来源身份声明仍被拦截并报告字段路径", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const brief = creativeBriefFixture(creatorProfile, {
    mappingLogic: "主角继续作为企鹅快递员和拟人动物身份执行送货任务"
  });

  assert.throws(
    () => validateCreativeBrief(brief, creatorProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].mappingLogic")
      && error.message.includes("企鹅")
  );

  const contrastBrief = creativeBriefFixture(creatorProfile, {
    mappingLogic: "不继承原片企鹅服，而是改成动物快递员继续送货"
  });
  assert.throws(
    () => validateCreativeBrief(contrastBrief, creatorProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].mappingLogic")
      && error.message.includes("动物")
  );

  for (const leakedMappingLogic of [
    "不继承原片企鹅服，小白子用玩偶服送货",
    "不继承原片动物身份，小白子随后担任动物快递员",
    "不继承企鹅服，动物勇士承担帮助功能",
    "不使用企鹅外壳，动物邮差负责送货",
    "不保留玩偶服，动物艺人负责表演",
    "不继承原片企鹅服同时小白子用玩偶服送货",
    "不继承原片动物身份并让小白子担任动物快递员",
    "不使用企鹅服之后小白子穿玩偶服行动"
  ]) {
    const leakedBrief = creativeBriefFixture(creatorProfile, { mappingLogic: leakedMappingLogic });
    assert.throws(
      () => validateCreativeBrief(leakedBrief, creatorProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].mappingLogic")
    );
  }
});

test("creativeBrief 猫娘授权仍拒绝企鹅服、玩偶服和来源职业泄漏并报告字段路径", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };

  for (const leakedIdentity of ["快递员", "送货员", "猫娘快递员", "企鹅快递员", "企鹅服角色", "玩偶服送货员"]) {
    const brief = creativeBriefFixture(creatorProfile, { newOccupationOrIdentity: leakedIdentity });
    assert.throws(
      () => validateCreativeBrief(brief, creatorProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
    );
  }

  const authorizedCourierProfile = {
    fixedCharacter: "小白子，猫娘，村里的快递员",
    vertical: "治愈日常",
    constraints: ""
  };
  const authorizedCourierBrief = creativeBriefFixture(authorizedCourierProfile, {
    newOccupationOrIdentity: "猫娘快递员"
  });
  assert.doesNotThrow(() => validateCreativeBrief(authorizedCourierBrief, authorizedCourierProfile));
});

test("creativeBrief 不为普通人类或猫耳配饰角色开放泛动物身份", () => {
  const cases = [
    {
      fixedCharacter: "小明，普通中学生",
      leakedIdentity: "动物快递员"
    },
    {
      fixedCharacter: "小雨，戴着猫耳发箍的普通女孩",
      leakedIdentity: "拟人动物角色"
    }
  ];

  for (const { fixedCharacter, leakedIdentity } of cases) {
    const creatorProfile = { fixedCharacter, vertical: "校园日常", constraints: "" };
    const brief = creativeBriefFixture(creatorProfile, { newOccupationOrIdentity: leakedIdentity });
    assert.throws(
      () => validateCreativeBrief(brief, creatorProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
        && error.message.includes("动物")
    );
  }

  const accessoryProfile = { fixedCharacter: "小雨，戴着猫耳发箍的普通女孩", vertical: "校园日常", constraints: "" };
  const catgirlLeak = creativeBriefFixture(accessoryProfile, { newOccupationOrIdentity: "猫娘" });
  assert.throws(
    () => validateCreativeBrief(catgirlLeak, accessoryProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
      && error.message.includes("猫娘")
  );

  for (const fixedCharacter of [
    "小雨，穿着猫娘服装的普通女孩",
    "小雨，印有猫耳少女图案的T恤，普通女孩",
    "小雨，临时扮演猫娘的普通女孩",
    "小雨，有猫耳发箍和猫尾挂件的普通女孩",
    "小雨，喜欢猫娘文化的普通女孩",
    "小雨，研究猫娘题材的普通女孩",
    "小雨，网名叫猫娘的普通女孩",
    "小雨，画过猫耳少女的普通女孩"
  ]) {
    const removableProfile = { fixedCharacter, vertical: "校园日常", constraints: "" };
    const identityLeak = creativeBriefFixture(removableProfile, { newOccupationOrIdentity: "猫娘" });
    assert.throws(
      () => validateCreativeBrief(identityLeak, removableProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
        && error.message.includes("猫娘")
    );
  }

  const animalHobbyProfile = { fixedCharacter: "小明，喜欢动物的普通中学生", vertical: "校园日常", constraints: "" };
  assert.doesNotThrow(() => validateCreativeBrief(creativeBriefFixture(animalHobbyProfile), animalHobbyProfile));
  const animalHobbyLeak = creativeBriefFixture(animalHobbyProfile, { newOccupationOrIdentity: "动物快递员" });
  assert.throws(
    () => validateCreativeBrief(animalHobbyLeak, animalHobbyProfile),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
      && error.message.includes("动物")
  );
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

test("creativeBrief 猫耳猫尾授权不扩展为其他动物身体结构", () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };

  for (const unauthorizedFeature of ["猫爪", "肉垫", "兽爪", "翅膀", "鸟喙", "狼尾巴"]) {
    const brief = creativeBriefFixture(creatorProfile, {
      newRole: `小白子，猫娘，长着${unauthorizedFeature}`
    });
    assert.throws(
      () => validateCreativeBrief(brief, creatorProfile),
      (error) => error instanceof OutputContractError
        && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newRole")
        && error.message.includes(unauthorizedFeature)
    );
  }
});

test("creativeBrief 校验失败后只纠偏一次并保留猫娘固定身份", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const leakedBrief = creativeBriefFixture(creatorProfile, { newOccupationOrIdentity: "企鹅快递员" });
  const correctedBrief = creativeBriefFixture(creatorProfile, {
    newOccupationOrIdentity: "村里的热心帮手",
    mappingLogic: "不继承原片拟人化动物身份，只保留主动帮助他人的剧作功能"
  });
  const prompts = [];
  const workflow = new WorkflowService({
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        return prompts.length === 1 ? leakedBrief : correctedBrief;
      }
    }
  });

  const result = await workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile });

  assert.equal(prompts.length, 2);
  assert.equal(result.roleAndOccupationMapping[0].newOccupationOrIdentity, "村里的热心帮手");
  assert.match(prompts[1], /creativeBrief\.roleAndOccupationMapping\[0\]\.newOccupationOrIdentity/u);
  assert.match(prompts[1], /企鹅/u);
  assert.match(prompts[1], /猫耳少女/u);
  assert.match(prompts[1], /猫娘/u);
  assert.match(prompts[1], /只修正越界字段/u);
  assert.match(prompts[1], /否定来源/u);
});

test("creativeBrief 第二次输出仍越界时抛出 OutputContractError", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，Q版猫耳少女，形象类似猫娘，有猫耳和蓬松猫尾，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const leakedBrief = creativeBriefFixture(creatorProfile, { newOccupationOrIdentity: "玩偶服送货员" });
  let calls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        calls += 1;
        return leakedBrief;
      }
    }
  });

  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    (error) => error instanceof OutputContractError
      && error.message.includes("creativeBrief.roleAndOccupationMapping[0].newOccupationOrIdentity")
  );
  assert.equal(calls, 2);
});

test("creativeBrief 禁止把原片表面形象映射成固定角色身份", async () => {
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

  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedBrief; } }
  });

  await assert.rejects(
    () => workflow.createBrief({ ...groundedUpstreamFixture(workflow), creatorProfile }),
    /企鹅/
  );
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
    () => workflow.createVariants({
      creativeBrief: {},
      creatorProfile: { fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事", vertical: "温情/日常" },
      count: 1
    }),
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
    () => workflow.createVariants({ creativeBrief, creatorProfile, count: 1 }),
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
    () => workflow.createVariants({ creativeBrief, creatorProfile, count: 1 }),
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
    () => workflow.createFullStory({ ...groundedUpstreamFixture(workflow), creativeBrief, creatorProfile, variant }),
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
    () => leakedWorkflow.createFullStory({ ...groundedUpstreamFixture(leakedWorkflow), creativeBrief, creatorProfile, variant }),
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
  leakedStory.characterBible.protagonist.signatureBehaviors = ["尾巴轻轻摇动表示开心"];
  leakedStory.sceneScript[0].visibleAction = "小白子尾巴轻摇，抱着风车出发。";
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

  const result = await workflow.createFullStory({ ...groundedUpstreamFixture(workflow), creativeBrief, creatorProfile, variant });

  assert.equal(result.selectedVariantId, "V1");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /没有通过系统校验/);
  assert.doesNotMatch(JSON.stringify(result), /尾巴/);
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
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  leakedPlan.shotPlan[0].startFrame.characters[0].actionState = "企鹅快递员小白子站在村口，翅膀微拍，准备送画。";
  const workflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
    /企鹅|翅膀|正向画面提示词/
  );
});

test("动画生产包不得把狼耳少女正向扩展成狼尾、狼爪和肉垫", async () => {
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
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  leakedPlan.characterReferencePrompts[0].appearancePrompt = "小白子，狼耳少女，带狼尾和肉垫，狼爪轻轻扒着风车。";
  leakedPlan.shotPlan[0].startFramePrompt = "小白子带着狼尾站在村口，狼爪扶住风车。";
  const workflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.rejects(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
    /狼尾|狼爪|肉垫|非用户设定身份/
  );
});

test("固定角色显式写狼尾巴时允许尾巴动作但不自动允许爪子肉垫", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，形象类似猫娘，有狼尾巴，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const policy = collectFixedCharacterVisualPolicy(creatorProfile.fixedCharacter);
  assert.ok(policy.allowedBodyTerms.includes("尾巴"));
  assert.ok(policy.allowedBodyTerms.includes("狼尾巴"));

  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "风车的约定",
    characterSetup: { protagonist: "小白子，q版狼耳少女，有狼尾巴", careRecipient: "邻居奶奶", helper: "拖拉机叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "一起把风车插在窗边"
  };
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  const tailPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  tailPlan.characterReferencePrompts[0].appearancePrompt = "小白子，q版狼耳少女，有狼尾巴，穿浅蓝背带裙，尾巴轻轻摇动。";
  tailPlan.shotPlan[0].startFrame.characters[0].actionState = "小白子站在村口，狼耳竖起，狼尾巴轻轻摇动，双手扶住手工风车。";
  const workflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(tailPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory })
  );

  const clawPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  clawPlan.characterReferencePrompts[0].appearancePrompt = "小白子，q版狼耳少女，有狼尾巴，狼爪和肉垫清晰可见。";
  clawPlan.shotPlan[0].startFrame.characters[0].handPropState = "小白子以狼爪扶住风车，肉垫贴着木柄。";
  const rejectingWorkflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(clawPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  await assert.rejects(
    () => rejectingWorkflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
    /狼爪|肉垫|非用户设定身份/
  );
});

test("角色边界、原片规避与逐镜渲染负面提示词在 prompt 中保持分类", () => {
  const creatorProfile = { fixedCharacter: "小白子，q版狼耳少女，有狼尾巴", vertical: "治愈日常", constraints: "" };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
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
  leakedPlan.shotPlan[0].startFrame.characters[0].actionState += " 小白子突然长出翅膀。";
  const workflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });

  await assert.rejects(
    () => workflow.createAnimationPlan({ creativeBrief, visualGuardrails, creatorProfile, variant, fullStory }),
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
  const pruningWorkflow = new WorkflowService({
    client: { async generateJson(args) { return stagedAnimationResponse(leakedPlan, args.prompt); } },
    animationModel: "qwen3.7-max"
  });
  const result = await pruningWorkflow.createAnimationPlan({ creativeBrief, visualGuardrails, creatorProfile, variant, fullStory });
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
  assert.match(prompt, /不得继承原片表面形象/);
  assert.match(prompt, /禁止复用原片具体表达黑名单/);
  assert.match(prompt, /录取通知书/);
  assert.match(prompt, /孔明灯/);
  assert.match(prompt, /sceneScript 至少 6 场/);
});

test("动画提示词要求输出首尾帧视频生产包", () => {
  const prompt = animationPlanPrompt({
    creativeBrief: {},
    variant: { id: "V2", title: "雨停之前" },
    fullStory: { selectedVariantId: "V2", title: "雨停之前", sceneScript: [] },
    creatorProfile: { fixedCharacter: "小白子，狼耳少女，小女孩，儿童", vertical: "治愈日常", constraints: "只用嗷呜表达" }
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
  assert.match(prompt, /耳朵类设定只授权用户写明的耳朵表现/);
  assert.match(prompt, /未授权信息保持不写，不得据此生成渲染负面提示词/);
});

test("固定角色外观边界提示词不会把显式狼尾巴写成禁止项", () => {
  const policyText = fixedCharacterVisualPolicyText("小白子，q版狼耳少女，形象类似猫娘，有狼尾巴，儿童");
  assert.match(policyText, /允许正向使用的身体特征：尾巴、狼尾、狼尾巴/);
  assert.match(policyText, /未授权信息保持不写/);
  assert.doesNotMatch(policyText, /狼爪|肉垫|鸟喙|脚蹼|鳍|羽毛|狐尾|兔尾|龙尾/);
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
