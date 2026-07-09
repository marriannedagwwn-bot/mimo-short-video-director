import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowService } from "../src/workflow.js";
import { getConfig } from "../src/config.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { collectForbiddenVisualTerms, ensureFullStoryMatchesProfile, ensureOutputContract, ensureVisualGuardrailsMatchesProfile } from "../src/validation.js";
import { buildRequestBody, MimoClient, parseModelJson } from "../src/mimo-client.js";
import { buildQwenRequestBody, QwenClient } from "../src/qwen-client.js";
import { JimengImageClient, buildCharacterReferenceImagePrompt, buildJimengImageRequestBody, buildShotFrameImagePrompt } from "../src/jimeng-client.js";
import { animationPlanPrompt, briefPrompt, fullStoryPrompt, variantsPrompt, visualGuardrailsPrompt } from "../src/prompts.js";
import { parseRunVideoArgs } from "../src/run-video-command.js";
import { generateShotVideo, ShotVideoConfigError, ShotVideoProviderError } from "../src/shot-video-generator.js";
import { mimeTypeFor, selectSampleTimestamps } from "../src/video-file.js";
import { collectFixedCharacterVisualPolicy, extractFixedCharacterName, fixedCharacterVisualPolicyText } from "../src/validation.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockVisualGuardrails } from "../src/mock.js";
import { executeProductionWorkspace } from "../src/video-production-executor.js";
import { formatMakeVideoMarkdown, makeProductionVideo } from "../src/video-production-maker.js";
import { buildProductionReport, formatProductionReportMarkdown, loadProductionReport } from "../src/video-production-report.js";
import { formatProductionPreflightMarkdown, loadProductionPreflight } from "../src/video-production-preflight.js";
import { buildArtifactsFromExistingOutputs, buildProductionRun, buildProductionWorkspaceFiles, parseQueueJsonl } from "../src/video-production-run.js";
import { buildVideoGenerationQueue, formatQueueJsonl } from "../public/animation-queue.js";
import { syncShotCharacterReference } from "../public/character-reference-sync.js";
import { shotRelatedCharacterReferences, uploadedReferenceImages } from "../public/shot-reference-images.js";

const frames = Array.from({ length: 8 }, (_, index) => ({
  timestamp: index * 5,
  dataUrl: "data:image/jpeg;base64,AA=="
}));
const execFileAsync = promisify(execFile);
const input = {
  frames,
  metadata: { name: "reference.mp4", duration: 40, width: 1080, height: 1920 },
  transcript: "",
  creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "家电维修", constraints: "60 秒内" },
  count: 3
};

function buildQueueFixture() {
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
  const animationPlan = mockAnimationPlan({ ...input, creativeBrief, variant, fullStory });
  return buildVideoGenerationQueue({
    exportedAt: "2026-06-25T00:00:00.000Z",
    selectedVariant: variant,
    fullStory,
    animationPlan
  });
}

test("演示模式跑通完整工作流并生成视觉负面提示词", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  assert.equal(workflow.mode, "demo");
  assert.ok(result.referenceAnalysis.whyWatchToEnd);
  assert.ok(result.sourceScriptReconstruction.scenes.length >= 4);
  assert.ok(result.creativeBrief.reusableHighValueBeats.length >= 4);
  assert.equal(result.creativeBrief.allowedNarrativeComponents.length, 7);
  assert.ok(result.visualGuardrails.commonNegativePrompt.length);
  assert.match(JSON.stringify(result.visualGuardrails.stageInstructions), /主题变体/);
  assert.equal(result.themeVariants.variants.length, 3);
});

test("视觉负面提示词 AI 阶段区分用户显式狼尾巴和模型误推导猫尾爪子", async () => {
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
  const forbidden = collectForbiddenVisualTerms(creativeBrief, creatorProfile.fixedCharacter, guardrails);

  assert.deepEqual(guardrails.fixedCharacterBoundary.allowedBodyFeatures.filter((term) => term === "狼尾巴"), ["狼尾巴"]);
  assert.ok(forbidden.includes("猫尾"));
  assert.ok(forbidden.includes("爪子"));
  assert.ok(!forbidden.includes("狼尾巴"));
  assert.doesNotMatch(guardrails.commonNegativePrompt.join("；"), /不要狼尾巴/);
});

test("视觉负面提示词 prompt 只要求输出主题变体和完整剧情通用规则", () => {
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
  assert.match(prompt, /角色外观与负面提示词审查 AI/);
  assert.match(prompt, /主题变体”和“完整剧情”/);
  assert.match(prompt, /首尾帧动画生产包阶段不使用这套 AI 检测/);
  assert.match(prompt, /形象类似猫娘，有狼尾巴/);
  assert.match(prompt, /不能自动新增猫尾、猫爪、兽爪、肉垫/);
  assert.match(prompt, /commonNegativePrompt/);
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
  const result = await workflow.createFullStory({ ...input, creativeBrief, variant });
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
      return mockAnimationPlan({ ...input, creativeBrief, variant, fullStory: mockFullStory({ ...input, creativeBrief, variant }) });
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

  const fullStory = await workflow.createFullStory({ ...input, creativeBrief, variant });
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
        return mockAnimationPlan({ ...input, creativeBrief, variant, fullStory });
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

test("动画生产包可转换为视频生成任务队列", () => {
  const queue = buildQueueFixture();
  assert.equal(queue.providerMode, "provider_agnostic");
  assert.equal(queue.selectedVariantId, "V1");
  assert.ok(queue.jobs.some((job) => job.type === "reference_image"));
  assert.ok(queue.jobs.some((job) => job.type === "start_frame_image"));
  assert.ok(queue.jobs.some((job) => job.type === "end_frame_image"));
  assert.ok(queue.jobs.some((job) => job.type === "first_last_frame_video"));
  assert.ok(queue.jobs.some((job) => job.type === "quality_check"));
  assert.ok(queue.jobs.some((job) => job.type === "final_edit"));
  const videoJob = queue.jobs.find((job) => job.type === "first_last_frame_video");
  assert.deepEqual(videoJob.requiredInputs, [`frames.${videoJob.shotId}.start`, `frames.${videoJob.shotId}.end`]);
  assert.match(videoJob.negativePrompt, /不要动物化主角/);
  assert.match(queue.jobs.find((job) => job.type === "start_frame_image").negativePrompt, /不要动物化主角/);
  const videoOutputs = queue.jobs.filter((job) => job.type === "first_last_frame_video").map((job) => job.outputKey);
  const reviewOutputs = queue.jobs.filter((job) => job.type === "quality_check").map((job) => job.outputKey);
  const finalEditJob = queue.jobs.find((job) => job.type === "final_edit");
  assert.deepEqual(finalEditJob.requiredInputs, [...videoOutputs, ...reviewOutputs]);
  assert.match(finalEditJob.prompt, /竖屏短片|字幕|音乐音效/);
  const jsonl = formatQueueJsonl(queue);
  assert.equal(jsonl.split("\n").length, queue.jobs.length);
  assert.equal(JSON.parse(jsonl.split("\n")[0]).taskId, queue.jobs[0].taskId);
});

test("视频任务队列不再合并 visualGuardrails 通用负面 prompt", () => {
  const creatorProfile = { fixedCharacter: "小白子，q版狼耳少女，有狼尾巴", vertical: "治愈日常", constraints: "" };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "风车",
    characterSetup: { protagonist: creatorProfile.fixedCharacter, careRecipient: "奶奶", helper: "叔叔" },
    newTask: "送风车",
    emotionalMedium: "手工风车",
    environmentPressure: "阵雨",
    endingRitual: "插好风车"
  };
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.commonNegativePrompt.push("不要彩虹披风");
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant, visualGuardrails });
  const animationPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory, visualGuardrails });
  const queue = buildVideoGenerationQueue({
    exportedAt: "2026-06-25T00:00:00.000Z",
    selectedVariant: variant,
    fullStory,
    animationPlan,
    visualGuardrails
  });

  const sceneJob = queue.jobs.find((job) => job.type === "scene_reference_image");
  assert.ok(sceneJob);
  assert.equal(sceneJob.capability || "image_generation", "image_generation");
  const firstFrameJob = queue.jobs.find((job) => job.type === "start_frame_image");
  assert.ok(firstFrameJob.requiredInputs.includes(sceneJob.outputKey));
  assert.ok(!queue.common.negativeVisualRules.includes("不要彩虹披风"));
  for (const job of queue.jobs.filter((item) => ["reference_image", "start_frame_image", "end_frame_image", "first_last_frame_video"].includes(item.type))) {
    assert.doesNotMatch(job.negativePrompt, /不要彩虹披风/);
  }
});

test("视频生产运行状态按任务依赖释放下一步", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { createdAt: "2026-06-25T00:00:00.000Z", outputRoot: "production/V1" });
  assert.equal(initialRun.counts.done, 0);
	  assert.ok(initialRun.nextTaskIds.includes("REF-01"));
	  assert.ok(initialRun.nextTaskIds.includes("ASSET-01"));
	  assert.ok(initialRun.nextTaskIds.includes("SCENE-01"));
	  assert.equal(initialRun.jobs.find((job) => job.type === "start_frame_image").status, "blocked");
  assert.equal(initialRun.jobs.find((job) => job.type === "final_edit").status, "blocked");

	  const referenceOutputs = queue.jobs
	    .filter((job) => job.type === "reference_image" || job.type === "asset_image" || job.type === "scene_reference_image")
	    .map((job) => job.outputKey);
  const frameRun = buildProductionRun(queue, { completedOutputs: referenceOutputs });
  assert.ok(frameRun.jobs.filter((job) => job.type === "start_frame_image").every((job) => job.status === "ready"));
  assert.ok(frameRun.jobs.filter((job) => job.type === "end_frame_image").every((job) => job.status === "ready"));
  assert.ok(frameRun.jobs.filter((job) => job.type === "first_last_frame_video").every((job) => job.status === "blocked"));

	  const videoReadyOutputs = queue.jobs
	    .filter((job) => ["reference_image", "asset_image", "scene_reference_image", "start_frame_image", "end_frame_image"].includes(job.type))
	    .map((job) => job.outputKey);
  const videoRun = buildProductionRun(queue, { completedOutputs: videoReadyOutputs });
  assert.ok(videoRun.jobs.filter((job) => job.type === "first_last_frame_video").every((job) => job.status === "ready"));

  const videoAndReviewOutputs = queue.jobs
    .filter((job) => job.type === "first_last_frame_video" || job.type === "quality_check")
    .map((job) => job.outputKey);
  const finalRun = buildProductionRun(queue, { completedOutputs: [...videoReadyOutputs, ...videoAndReviewOutputs] });
  assert.equal(finalRun.jobs.find((job) => job.type === "final_edit").status, "ready");

  const parsed = parseQueueJsonl(formatQueueJsonl(queue));
  assert.equal(parsed.jobs.length, queue.jobs.length);
});

test("视频生产运行状态可从已存在输出路径自动识别完成产物", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: "production/V1" });
	  const existingOutputPaths = initialRun.jobs
	    .filter((job) => job.type === "reference_image" || job.type === "asset_image" || job.type === "scene_reference_image")
	    .map((job) => job.outputPath);
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: "production/V1",
    existingOutputPaths
  });
  assert.equal(Object.keys(artifacts).length, existingOutputPaths.length);
  const scannedRun = buildProductionRun(queue, { outputRoot: "production/V1", artifacts });
	  assert.ok(scannedRun.jobs.filter((job) => job.type === "reference_image" || job.type === "asset_image" || job.type === "scene_reference_image").every((job) => job.status === "done"));
  assert.ok(scannedRun.jobs.filter((job) => job.type === "start_frame_image").every((job) => job.status === "ready"));
});

test("视频生产运行状态可从失败回执识别 failed 任务", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: "production/V1" });
  const failedJob = initialRun.jobs.find((job) => job.type === "reference_image");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: "production/V1",
    existingFailurePaths: [failedJob.failurePath]
  });
  const scannedRun = buildProductionRun(queue, { outputRoot: "production/V1", artifacts });
  assert.equal(scannedRun.jobs.find((job) => job.taskId === failedJob.taskId).status, "failed");
  assert.ok(scannedRun.jobs.filter((job) => job.type === "start_frame_image").some((job) => job.status === "blocked"));
});

test("视频生产工作区导出 README、运行状态和逐任务 prompt 卡", () => {
  const queue = buildQueueFixture();
  const run = buildProductionRun(queue, {
    createdAt: "2026-06-25T00:00:00.000Z",
    outputRoot: "production/V1"
  });
  const files = buildProductionWorkspaceFiles(queue, run);
  assert.ok(files.some((file) => file.path === "production/V1/README.md" && file.content.includes("执行顺序")));
  assert.ok(files.some((file) => file.path === "production/V1/production-run.json" && file.content.includes('"nextTaskIds"')));
  const promptCards = files.filter((file) => file.path.includes("/prompts/") && file.path.endsWith(".md"));
  const requestFiles = files.filter((file) => file.path.includes("/requests/") && file.path.endsWith(".json"));
  assert.equal(promptCards.length, queue.jobs.length);
  assert.equal(requestFiles.length, queue.jobs.length);
  const videoCard = promptCards.find((file) => file.path.includes("first_last_frame_video"));
  assert.match(videoCard.content, /正向 Prompt/);
  assert.match(videoCard.content, /依赖输入/);
  assert.match(videoCard.content, /验收标准/);
  const videoRequest = JSON.parse(requestFiles.find((file) => file.path.includes("first_last_frame_video")).content);
  assert.equal(videoRequest.capability, "first_last_frame_video_generation");
  assert.equal(videoRequest.inputArtifacts.length, 2);
  assert.ok(videoRequest.inputArtifacts.every((item) => item.path.includes("/outputs/")));
  const finalCard = promptCards.find((file) => file.path.includes("final_edit"));
  assert.match(finalCard.content, /最终剪辑/);
  assert.match(finalCard.content, /quality_check|reviews\./);
  const finalRequest = JSON.parse(requestFiles.find((file) => file.path.includes("final_edit")).content);
  assert.equal(finalRequest.capability, "video_assembly");
  assert.ok(finalRequest.inputArtifacts.some((item) => item.outputKey.startsWith("reviews.")));
});

test("mock 视频生产执行器可按依赖链跑完整个工作区", async () => {
  const queue = buildQueueFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-exec-"));
  const run = buildProductionRun(queue, {
    createdAt: "2026-06-26T00:00:00.000Z",
    outputRoot: root
  });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({ root, provider: "mock", all: true });
  assert.equal(result.executed.length, queue.jobs.length);
  assert.equal(result.run.counts.done, queue.jobs.length);
  assert.equal(result.run.counts.ready, 0);
  assert.equal(result.run.counts.blocked, 0);
  const finalJob = result.run.jobs.find((job) => job.type === "final_edit");
  const finalBody = await fs.readFile(finalJob.outputPath, "utf8");
  assert.match(finalBody, /MOCK ARTIFACT/);
  const finalReceipt = JSON.parse(await fs.readFile(`${finalJob.outputPath}.mock.json`, "utf8"));
  assert.equal(finalReceipt.capability, "video_assembly");
});

test("command 视频生产执行器可调用外部 worker 生成产物", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-"));
  const workerPath = path.join(root, "worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(workerPath, `
import fs from "node:fs/promises";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const requestPath = value("--request");
const outputPath = value("--output");
const receiptPath = value("--receipt");
const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
await fs.writeFile(outputPath, "worker output:" + request.taskId + ":" + process.env.VIDEO_TASK_CAPABILITY);
await fs.writeFile(receiptPath, JSON.stringify({ provider: "command-test", taskId: request.taskId, capability: request.capability }) + "\\n");
`);

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [workerPath],
    all: true
  });
  assert.equal(result.executed.length, 2);
  assert.equal(result.run.counts.done, 2);
  const startJob = result.run.jobs.find((job) => job.taskId === "S01-START");
  assert.match(await fs.readFile(startJob.outputPath, "utf8"), /worker output:S01-START:image_generation/);
  const receipt = JSON.parse(await fs.readFile(`${startJob.outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "command-test");
});

test("内置 command worker 模板可作为 command provider 执行任务", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-template-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "template worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/command-worker-template.mjs"],
    all: true
  });
  assert.equal(result.run.counts.done, 1);
  const output = await fs.readFile(result.run.jobs[0].outputPath, "utf8");
  assert.match(output, /PLACEHOLDER ARTIFACT/);
  const receipt = JSON.parse(await fs.readFile(`${result.run.jobs[0].outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "command-worker-template");
});

test("通用 HTTP worker 可调用供应商接口生成图片产物", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-http-image-"));
  let receivedBody = null;
  let receivedAuth = "";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedAuth = request.headers.authorization || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { b64_json: Buffer.from("http image bytes").toString("base64") } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: { image_generation: `http://127.0.0.1:${address.port}/images` },
    apiKey: "test-key",
    model: "test-image-model"
  }));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "generic http image worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图", negativePrompt: "不要变形" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  assert.equal(result.run.counts.done, 1);
  assert.equal(receivedAuth, "Bearer test-key");
  assert.equal(receivedBody.prompt, "角色参考图");
  assert.equal(receivedBody.negativePrompt, "不要变形");
  assert.equal(receivedBody.model, "test-image-model");
  assert.match(await fs.readFile(result.run.jobs[0].outputPath, "utf8"), /http image bytes/);
  const receipt = JSON.parse(await fs.readFile(`${result.run.jobs[0].outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "generic-http-worker");
  assert.equal(receipt.resultKind, "base64");
});

test("通用 HTTP worker 支持首尾帧视频提交、轮询和下载", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-http-video-"));
  let postBody = null;
  let pollCount = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/videos") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "provider-task-1", status: "queued" }));
      return;
    }
    if (request.url === "/tasks/provider-task-1") {
      pollCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pollCount < 2
        ? { task_id: "provider-task-1", status: "processing" }
        : { task_id: "provider-task-1", status: "succeeded", video_url: `http://127.0.0.1:${server.address().port}/media/clip.mp4` }));
      return;
    }
    if (request.url === "/media/clip.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "generic http video worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], model: "override-video-model", prompt: "让人物从首帧走到尾帧", durationSeconds: 4, aspectRatio: "9:16" }
    ]
  };
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const startJob = initialRun.jobs.find((job) => job.taskId === "S01-START");
  const endJob = initialRun.jobs.find((job) => job.taskId === "S01-END");
  await fs.mkdir(path.dirname(startJob.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(endJob.outputPath), { recursive: true });
  await fs.writeFile(startJob.outputPath, "start frame bytes");
  await fs.writeFile(endJob.outputPath, "end frame bytes");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [startJob.outputPath, endJob.outputPath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: { first_last_frame_video_generation: `http://127.0.0.1:${address.port}/videos` },
    models: { first_last_frame_video_generation: "test-video-model" },
    pollEndpointTemplate: `http://127.0.0.1:${address.port}/tasks/{taskId}`,
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  const videoJob = result.run.jobs.find((job) => job.taskId === "S01-VIDEO");
  assert.equal(result.executed.length, 1);
  assert.equal(videoJob.status, "done");
  assert.equal(postBody.model, "override-video-model");
  assert.equal(postBody.parameters.durationSeconds, 4);
  assert.equal(postBody.inputArtifacts.length, 2);
  assert.match(postBody.inputArtifacts[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(await fs.readFile(videoJob.outputPath, "utf8"), "video bytes");
  const receipt = JSON.parse(await fs.readFile(`${videoJob.outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.providerTaskId, "provider-task-1");
  assert.equal(receipt.resultKind, "url");
});

test("通用 HTTP worker 支持 ModelArk/Dreamina 首尾帧视频任务 preset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-modelark-"));
  let postBody = null;
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v3/contents/generations/tasks") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "cgt-test-1", status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v3/contents/generations/tasks/cgt-test-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "cgt-test-1", status: "succeeded", content: { video_url: `http://127.0.0.1:${server.address().port}/media/modelark.mp4` } }));
      return;
    }
    if (request.url === "/media/modelark.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("modelark video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "modelark video worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], prompt: "让人物从首帧走到尾帧", negativePrompt: "不要字幕", durationSeconds: 4, aspectRatio: "9:16" }
    ]
  };
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const startJob = initialRun.jobs.find((job) => job.taskId === "S01-START");
  const endJob = initialRun.jobs.find((job) => job.taskId === "S01-END");
  await fs.mkdir(path.dirname(startJob.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(endJob.outputPath), { recursive: true });
  await fs.writeFile(startJob.outputPath, "start frame bytes");
  await fs.writeFile(endJob.outputPath, "end frame bytes");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [startJob.outputPath, endJob.outputPath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${address.port}/api/v3`,
    providerPreset: "modelark_content_generation",
    videoModel: "dreamina-seedance-2-0-260128",
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  const videoJob = result.run.jobs.find((job) => job.taskId === "S01-VIDEO");
  assert.equal(videoJob.status, "done");
  assert.equal(postBody.model, "dreamina-seedance-2-0-260128");
  assert.equal(postBody.ratio, "9:16");
  assert.equal(postBody.duration, 4);
  assert.equal(postBody.generate_audio, false);
  assert.deepEqual(postBody.content.map((item) => item.type), ["text", "image_url", "image_url"]);
  assert.deepEqual(postBody.content.map((item) => item.role || ""), ["", "first_frame", "last_frame"]);
  assert.match(postBody.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(postBody.content[2].image_url.url, /^data:image\/png;base64,/);
  assert.match(postBody.content[0].text, /不要字幕/);
  assert.equal(await fs.readFile(videoJob.outputPath, "utf8"), "modelark video bytes");
});

test("通用 HTTP worker 支持 Kling 首尾帧视频任务 preset", async (t) => {
  const savedEnv = pickEnv([
    "VIDEO_HTTP_ENDPOINT",
    "VIDEO_HTTP_IMAGE_ENDPOINT",
    "VIDEO_HTTP_VIDEO_ENDPOINT",
    "VIDEO_HTTP_VIDEO_MODEL",
    "VIDEO_HTTP_PRESET",
    "VIDEO_HTTP_API_KEY",
    "VIDEO_HTTP_CONFIG",
    "VIDEO_HTTP_VIDEO_DURATION",
    "VIDEO_HTTP_VIDEO_MODE",
    "VIDEO_HTTP_GENERATE_AUDIO",
    "VIDEO_HTTP_VIDEO_ASPECT_RATIO",
    "VIDEO_HTTP_CFG_SCALE"
  ]);
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  t.after(() => restoreEnv(savedEnv));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-kling-"));
  let postBody = null;
  const server = http.createServer(async (request, response) => {
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
          task_result: { videos: [{ url: `http://127.0.0.1:${server.address().port}/media/kling.mp4` }] }
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "kling video worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], prompt: "让人物从首帧走到尾帧", negativePrompt: "不要字幕", durationSeconds: 4, aspectRatio: "9:16" }
    ]
  };
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const startJob = initialRun.jobs.find((job) => job.taskId === "S01-START");
  const endJob = initialRun.jobs.find((job) => job.taskId === "S01-END");
  await fs.mkdir(path.dirname(startJob.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(endJob.outputPath), { recursive: true });
  await fs.writeFile(startJob.outputPath, "start frame bytes");
  await fs.writeFile(endJob.outputPath, "end frame bytes");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [startJob.outputPath, endJob.outputPath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${address.port}/v1`,
    providerPreset: "kling_image_to_video",
    videoModel: "kling-v2-1",
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  const videoJob = result.run.jobs.find((job) => job.taskId === "S01-VIDEO");
  assert.equal(videoJob.status, "done");
  assert.equal(postBody.model_name, "kling-v2-1");
  assert.equal(postBody.image, Buffer.from("start frame bytes").toString("base64"));
  assert.equal(postBody.image_tail, Buffer.from("end frame bytes").toString("base64"));
  assert.equal(postBody.prompt, "让人物从首帧走到尾帧");
  assert.equal(postBody.negative_prompt, "不要字幕");
  assert.equal(postBody.mode, "pro");
  assert.equal(postBody.duration, "5");
  assert.equal(await fs.readFile(videoJob.outputPath, "utf8"), "kling video bytes");
  const receipt = JSON.parse(await fs.readFile(`${videoJob.outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.providerTaskId, "kling-task-1");
  assert.equal(receipt.resultKind, "url");
});

test("单镜头首尾帧视频接口可调用供应商并返回播放地址", async (t) => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_VIDEO_ENDPOINT", "VIDEO_HTTP_API_KEY", "VIDEO_HTTP_CONFIG"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_VIDEO_ENDPOINT;
  delete process.env.VIDEO_HTTP_API_KEY;
  delete process.env.VIDEO_HTTP_CONFIG;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-"));
  const imageBodies = [];
  let videoBody = null;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/images") {
      imageBodies.push(body);
      response.end(JSON.stringify({ data: { imageBase64: Buffer.from(`shot image ${imageBodies.length}`).toString("base64") } }));
      return;
    }
    videoBody = body;
    response.end(JSON.stringify({ data: { videoBase64: Buffer.from("shot video bytes").toString("base64") } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => restoreEnv(savedEnv));
  const address = server.address();
  process.env.VIDEO_HTTP_IMAGE_ENDPOINT = `http://127.0.0.1:${address.port}/images`;
  process.env.VIDEO_HTTP_VIDEO_ENDPOINT = `http://127.0.0.1:${address.port}/videos`;
  process.env.VIDEO_HTTP_API_KEY = "test-key";

  const result = await generateShotVideo({
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    shot: {
      shotId: "S01",
      durationSeconds: 4,
      startFramePrompt: "小白子站在村口，抱着包裹准备出发",
      endFramePrompt: "小白子把包裹交到老人手里，老人露出笑容",
      videoPrompt: "从首帧走到尾帧",
      negativePrompt: "不要变形",
      cameraMotion: "缓慢推进"
    }
  });

  assert.equal(result.shotId, "S01");
  assert.match(result.startFrameUrl, /^\/generated-videos\/S01-start-/);
  assert.match(result.endFrameUrl, /^\/generated-videos\/S01-end-/);
  assert.match(result.outputUrl, /^\/generated-videos\/S01-/);
  assert.equal(await fs.readFile(result.startFramePath, "utf8"), "shot image 1");
  assert.equal(await fs.readFile(result.endFramePath, "utf8"), "shot image 2");
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "shot video bytes");
  assert.equal(imageBodies.length, 2);
  assert.equal(imageBodies[0].capability, "image_generation");
  assert.equal(imageBodies[0].prompt, "小白子站在村口，抱着包裹准备出发");
  assert.equal(imageBodies[1].prompt, "小白子把包裹交到老人手里，老人露出笑容");
  assert.equal(videoBody.capability, "first_last_frame_video_generation");
  assert.equal(videoBody.prompt, "从首帧走到尾帧");
  assert.equal(videoBody.parameters.cameraMotion, "缓慢推进");
  assert.equal(videoBody.inputArtifacts.length, 2);
  assert.match(videoBody.inputArtifacts[0].dataUrl, /^data:image\/png;base64,/);
  assert.match(videoBody.inputArtifacts[1].dataUrl, /^data:image\/png;base64,/);
});

test("单镜头首尾帧视频接口按请求数量返回多个候选视频", async (t) => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_VIDEO_ENDPOINT", "VIDEO_HTTP_API_KEY", "VIDEO_HTTP_CONFIG"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_VIDEO_ENDPOINT;
  delete process.env.VIDEO_HTTP_API_KEY;
  delete process.env.VIDEO_HTTP_CONFIG;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-count-"));
  const videoBodies = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    videoBodies.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { videoBase64: Buffer.from(`shot video bytes ${videoBodies.length}`).toString("base64") } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => restoreEnv(savedEnv));
  const address = server.address();
  process.env.VIDEO_HTTP_VIDEO_ENDPOINT = `http://127.0.0.1:${address.port}/videos`;
  process.env.VIDEO_HTTP_API_KEY = "test-key";

  const imageDataUrl = `data:image/png;base64,${Buffer.from("frame image bytes").toString("base64")}`;
  const result = await generateShotVideo({
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos",
    count: 2,
    startFrameDataUrl: imageDataUrl,
    endFrameDataUrl: imageDataUrl,
    shot: {
      shotId: "S01",
      durationSeconds: 4,
      videoPrompt: "从首帧走到尾帧"
    }
  });

  assert.equal(result.count, 2);
  assert.equal(result.actualCount, 2);
  assert.equal(result.videos.length, 2);
  assert.match(result.outputUrl, /^\/generated-videos\/S01-/);
  assert.match(result.videos[0].outputUrl, /-1\.mp4$/);
  assert.match(result.videos[1].outputUrl, /-2\.mp4$/);
  assert.equal(await fs.readFile(result.videos[0].outputPath, "utf8"), "shot video bytes 1");
  assert.equal(await fs.readFile(result.videos[1].outputPath, "utf8"), "shot video bytes 2");
  assert.equal(videoBodies.length, 2);
  assert.equal(videoBodies[0].parameters.candidateIndex, 0);
  assert.equal(videoBodies[0].parameters.candidateCount, 2);
  assert.equal(videoBodies[1].parameters.candidateIndex, 1);
});

test("单镜头视频生成不会把供应商纯文本确认当成 mp4", async (t) => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_VIDEO_ENDPOINT", "VIDEO_HTTP_API_KEY", "VIDEO_HTTP_CONFIG"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_VIDEO_ENDPOINT;
  delete process.env.VIDEO_HTTP_API_KEY;
  delete process.env.VIDEO_HTTP_CONFIG;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-text-"));
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // drain body
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => restoreEnv(savedEnv));
  const address = server.address();
  process.env.VIDEO_HTTP_VIDEO_ENDPOINT = `http://127.0.0.1:${address.port}/videos`;
  process.env.VIDEO_HTTP_API_KEY = "test-key";

  const imageDataUrl = `data:image/png;base64,${Buffer.from("frame image bytes").toString("base64")}`;
  await assert.rejects(
    () => generateShotVideo({
      outputRoot: path.join(root, "generated-videos"),
      publicBasePath: "/generated-videos",
      startFrameDataUrl: imageDataUrl,
      endFrameDataUrl: imageDataUrl,
      shot: { shotId: "S01", videoPrompt: "测试视频" }
    }),
    ShotVideoProviderError
  );
});

test("单镜头视频生成未配置供应商时给出明确错误", async () => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_VIDEO_ENDPOINT", "VIDEO_HTTP_CONFIG"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_VIDEO_ENDPOINT;
  delete process.env.VIDEO_HTTP_CONFIG;
  try {
    await assert.rejects(
      () => generateShotVideo({ shot: { shotId: "S01", videoPrompt: "测试" } }),
      ShotVideoConfigError
    );
  } finally {
    restoreEnv(savedEnv);
  }
});

test("本地后处理 worker 可完成质检并合成最终视频", async () => {
  const savedEnv = pickEnv(["LOCAL_POSTPROCESS_FFMPEG", "LOCAL_POSTPROCESS_REENCODE"]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-local-post-"));
  const fakeFfmpegPath = path.join(root, "fake-ffmpeg.mjs");
  await fs.writeFile(fakeFfmpegPath, `#!/usr/bin/env node
import fs from "node:fs/promises";
const output = process.argv.at(-1);
await fs.writeFile(output, "assembled video bytes");
`);
  await fs.chmod(fakeFfmpegPath, 0o755);
  process.env.LOCAL_POSTPROCESS_FFMPEG = fakeFfmpegPath;
  delete process.env.LOCAL_POSTPROCESS_REENCODE;
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "local postprocess test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", prompt: "视频片段" },
      { taskId: "S01-QA", type: "quality_check", inputType: "video_review", outputKey: "reviews.S01", requiredInputs: ["videos.S01"], prompt: "检查视频" },
      { taskId: "FINAL-EDIT", type: "final_edit", inputType: "video_assembly", outputKey: "exports.final_cut", requiredInputs: ["videos.S01", "reviews.S01"], prompt: "合成最终视频" }
    ]
  };
  try {
    const initialRun = buildProductionRun(queue, { outputRoot: root });
    const videoJob = initialRun.jobs.find((job) => job.taskId === "S01-VIDEO");
    await fs.mkdir(path.dirname(videoJob.outputPath), { recursive: true });
    await fs.writeFile(videoJob.outputPath, "real video bytes");
    const artifacts = buildArtifactsFromExistingOutputs(queue, {
      outputRoot: root,
      existingOutputPaths: [videoJob.outputPath]
    });
    const run = buildProductionRun(queue, { outputRoot: root, artifacts });
    await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

    const result = await executeProductionWorkspace({
      root,
      provider: "command",
      command: process.execPath,
      commandArgs: ["workers/local-postprocess-worker.mjs"],
      all: true,
      capabilities: ["video_quality_review", "video_assembly"]
    });
    assert.equal(result.executed.length, 2);
    assert.equal(result.run.jobs.find((job) => job.taskId === "REF-01").status, "ready");
    assert.equal(result.run.jobs.find((job) => job.taskId === "S01-QA").status, "done");
    const finalJob = result.run.jobs.find((job) => job.taskId === "FINAL-EDIT");
    assert.equal(finalJob.status, "done");
    assert.equal(await fs.readFile(finalJob.outputPath, "utf8"), "assembled video bytes");
    const finalReceipt = JSON.parse(await fs.readFile(`${finalJob.outputPath}.provider.json`, "utf8"));
    assert.equal(finalReceipt.provider, "local-postprocess-worker");
    assert.equal(finalReceipt.inputCount, 1);
  } finally {
    restoreEnv(savedEnv);
  }
});

test("make:video 可编排预检、HTTP 生成、本地质检和最终剪辑", async (t) => {
  const savedEnv = pickEnv(["VIDEO_HTTP_API_KEY", "LOCAL_POSTPROCESS_FFMPEG", "LOCAL_POSTPROCESS_REENCODE"]);
  delete process.env.VIDEO_HTTP_API_KEY;
  delete process.env.LOCAL_POSTPROCESS_REENCODE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-make-"));
  const fakeFfmpegPath = path.join(root, "fake-ffmpeg.mjs");
  await fs.writeFile(fakeFfmpegPath, `#!/usr/bin/env node
import fs from "node:fs/promises";
const output = process.argv.at(-1);
await fs.writeFile(output, "final cut bytes");
`);
  await fs.chmod(fakeFfmpegPath, 0o755);
  process.env.LOCAL_POSTPROCESS_FFMPEG = fakeFfmpegPath;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/images") {
      response.end(JSON.stringify({ data: { b64_json: Buffer.from(`image:${body.taskId}`).toString("base64") } }));
      return;
    }
    if (request.url === "/videos") {
      response.end(JSON.stringify({ data: { videoBase64: Buffer.from(`video:${body.taskId}`).toString("base64") } }));
      return;
    }
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => restoreEnv(savedEnv));
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "make video test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", requiredInputs: ["references.hero"], prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], prompt: "视频片段" },
      { taskId: "S01-QA", type: "quality_check", inputType: "video_review", outputKey: "reviews.S01", requiredInputs: ["videos.S01"], prompt: "检查视频" },
      { taskId: "FINAL-EDIT", type: "final_edit", inputType: "video_assembly", outputKey: "exports.final_cut", requiredInputs: ["videos.S01", "reviews.S01"], prompt: "合成最终视频" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: {
      image_generation: `http://127.0.0.1:${address.port}/images`,
      first_last_frame_video_generation: `http://127.0.0.1:${address.port}/videos`
    },
    apiKey: "test-key"
  }));

  const result = await makeProductionVideo({ root, configPath, command: process.execPath });
  assert.equal(result.preflight.passed, true);
  assert.equal(result.stages.media.executed, 4);
  assert.equal(result.stages.postprocess.executed, 2);
  assert.equal(result.report.progress.done, 6);
  assert.equal(result.report.progress.percent, 100);
  const finalJob = result.report.finalOutputs.find((item) => item.taskId === "FINAL-EDIT");
  assert.equal(finalJob.status, "done");
  assert.equal(await fs.readFile(finalJob.outputPath, "utf8"), "final cut bytes");
  assert.match(formatMakeVideoMarkdown(result), /最终成片/);
});

test("command 视频生产执行失败会写入失败回执并刷新 failed 状态", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-fail-"));
  const workerPath = path.join(root, "failing-worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker failure test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(workerPath, "console.error('provider down'); process.exit(7);");

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [workerPath],
    all: true,
    continueOnError: true
  });
  assert.equal(result.failed.length, 1);
  assert.equal(result.run.counts.failed, 1);
  assert.equal(result.run.jobs.find((job) => job.taskId === "REF-01").status, "failed");
  assert.equal(result.run.jobs.find((job) => job.taskId === "S01-START").status, "blocked");
  const failure = JSON.parse(await fs.readFile(result.failed[0].failurePath, "utf8"));
  assert.equal(failure.taskId, "REF-01");
  assert.match(failure.error.stderr, /provider down/);
});

test("command 视频生产执行器可重试 failed 任务并释放下游", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-retry-"));
  const failingWorkerPath = path.join(root, "failing-worker.mjs");
  const successWorkerPath = path.join(root, "success-worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker retry test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(failingWorkerPath, "console.error('temporary outage'); process.exit(8);");
  await fs.writeFile(successWorkerPath, `
import fs from "node:fs/promises";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const request = JSON.parse(await fs.readFile(value("--request"), "utf8"));
await fs.writeFile(value("--output"), "retry ok:" + request.taskId);
await fs.writeFile(value("--receipt"), JSON.stringify({ provider: "retry-worker", taskId: request.taskId }) + "\\n");
`);

  const failedRun = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [failingWorkerPath],
    all: true,
    continueOnError: true
  });
  assert.equal(failedRun.run.counts.failed, 1);

  const retriedRun = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [successWorkerPath],
    all: true,
    retryFailed: true
  });
  assert.equal(retriedRun.retried.length, 1);
  assert.equal(retriedRun.run.counts.done, 2);
  assert.equal(retriedRun.run.counts.failed, 0);
  const startJob = retriedRun.run.jobs.find((job) => job.taskId === "S01-START");
  assert.match(await fs.readFile(startJob.outputPath, "utf8"), /retry ok:S01-START/);
});

test("视频生产报告输出进度、失败、阻塞和建议命令", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-report-"));
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const readyReference = initialRun.jobs.find((job) => job.type === "reference_image");
  const failedAsset = initialRun.jobs.find((job) => job.type === "asset_image");
  await fs.mkdir(path.dirname(readyReference.outputPath), { recursive: true });
  await fs.writeFile(readyReference.outputPath, "done reference");
  await fs.mkdir(path.dirname(failedAsset.failurePath), { recursive: true });
  await fs.writeFile(failedAsset.failurePath, JSON.stringify({
    taskId: failedAsset.taskId,
    error: { message: "asset provider failed" }
  }));
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [readyReference.outputPath],
    existingFailurePaths: [failedAsset.failurePath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const report = await loadProductionReport(root);
  assert.equal(report.progress.done, 1);
  assert.equal(report.progress.failed, 1);
  assert.ok(report.failedTasks.some((task) => task.error.message === "asset provider failed"));
  assert.ok(report.blockedTasks.length > 0);
  assert.match(report.recommendedCommands[1], /--retry-failed/);
  const markdown = formatProductionReportMarkdown(report);
  assert.match(markdown, /失败任务/);
  assert.match(markdown, /asset provider failed/);

  const directReport = buildProductionReport(run);
  assert.equal(directReport.progress.total, run.jobs.length);
  assert.match(report.recommendedCommands[0], /preflight:video/);
});

test("视频生产预检会阻止 mock 产物进入真实执行", async () => {
  const queue = buildQueueFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-mock-"));
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await executeProductionWorkspace({ root, provider: "mock", all: false, limit: 1 });

  const report = await loadProductionPreflight(root, {
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs"]
  });
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.code === "mock_artifact_marked_done"));
  assert.match(formatProductionPreflightMarkdown(report), /mock\/占位产物/);
});

test("视频生产预检会检查 generic HTTP worker endpoint 配置", async () => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_API_KEY"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_API_KEY;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-config-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "preflight config test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  try {
    const missing = await loadProductionPreflight(root, {
      command: process.execPath,
      commandArgs: ["workers/generic-http-worker.mjs"]
    });
    assert.equal(missing.passed, false);
    assert.ok(missing.issues.some((issue) => issue.code === "missing_http_endpoint" && /image_generation/.test(issue.message)));

    const configPath = path.join(root, "provider.json");
    await fs.writeFile(configPath, JSON.stringify({
      endpoints: { image_generation: "http://127.0.0.1:9/images" },
      apiKey: "test-key"
    }));
    const configured = await loadProductionPreflight(root, {
      command: process.execPath,
      commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath]
    });
    assert.equal(configured.passed, true);
    assert.equal(configured.command.configLoaded, true);
    assert.ok(configured.recommendedCommands.some((command) => command.includes("exec:video")));
  } finally {
    restoreEnv(savedEnv);
  }
});

test("preflight CLI strict 模式在错误时返回非零状态", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-cli-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "preflight cli test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  await assert.rejects(
    () => execFileAsync(process.execPath, ["bin/preflight-video-production.js", root, "--strict"], {
      cwd: process.cwd(),
      env: withoutEnv(process.env, ["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_API_KEY"])
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /missing_http_endpoint/);
      return true;
    }
  );
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
  t.after(() => server.close());
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
    prompt: "分析", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "video");
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
  t.after(() => server.close());
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
      cameraLanguage: "低机位近景",
      negativeVisualRules: ["不要水果摊"]
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
	      negativeSceneRules: ["不要室内药房", "不要现代城市街道"]
	    },
	    shot: {
      shotId: "S01",
      startFramePrompt: "小白子站在村口，手里拿着草药包。",
      endFramePrompt: "小白子把草药包递给爷爷。",
      cameraMotion: "轻微推近",
      characterAction: "抱紧草药包",
      negativePrompt: "不要现代城市"
    }
  });
  assert.match(prompt, /生成竖屏 9:16 动画短视频分镜首帧图/);
	  assert.match(prompt, /整体风格：Q版定格动画/);
	  assert.match(prompt, /场景参考（必须继承/);
	  assert.match(prompt, /村口药铺门前/);
	  assert.match(prompt, /不要室内药房/);
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
  assert.match(prompt, /不要水果摊/);
  assert.match(prompt, /不要现代城市/);
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
  assert.match(prompt, /换场景、室内外切换/);
  assert.doesNotMatch(prompt, /外婆（@图一）院子/);
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
  t.after(() => server.close());
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "mimo-v2.5", jsonMode: false, mediaMode: "auto", videoFps: 2, videoMediaResolution: "default", maxCompletionTokens: 8192, thinking: "disabled"
  });
  const result = await client.generateJsonWithMedia({
    prompt: "分析", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "image_url");
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
  t.after(() => server.close());
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
  t.after(() => server.close());
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
  t.after(() => server.close());
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
  const prompt = briefPrompt({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile: input.creatorProfile });
  assert.match(prompt, /不能因为原片使用过就一刀切禁止/);
  assert.match(prompt, /protectedExpressions 只允许放具体且可识别的表达/);
  assert.match(prompt, /送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾/);
  assert.match(prompt, /企鹅服女孩/);
  assert.match(prompt, /不能把“企鹅”“企鹅快递员”“翅膀\/尾巴动作”等表面元素写进固定角色映射或新故事/);
  assert.match(prompt, /roleAndOccupationMapping 的第一项必须映射原片主角的剧作功能/);
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
    () => workflow.createBrief({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile }),
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

  const result = await workflow.createBrief({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile });
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
    () => workflow.createFullStory({ creativeBrief, creatorProfile, variant }),
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
    () => leakedWorkflow.createFullStory({ creativeBrief, creatorProfile, variant }),
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

  const result = await workflow.createFullStory({ creativeBrief, creatorProfile, variant });

  assert.equal(result.selectedVariantId, "V1");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /没有通过系统校验/);
  assert.doesNotMatch(JSON.stringify(result), /尾巴/);
});

test("动画生产包阶段不再因原片表面形象触发 AI 检测拦截", async () => {
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
  leakedPlan.shotPlan[0].startFramePrompt = "企鹅快递员小白子站在村口，翅膀微拍，准备送画。";
  leakedPlan.shotPlan[0].negativePrompt = "不要出现企鹅服、翅膀、尾巴。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedPlan; } },
    animationModel: "mimo-v2.5-pro"
  });
  await assert.doesNotReject(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
  );
});

test("动画生产包阶段不再因狼耳少女外观扩展触发 AI 检测拦截", async () => {
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
    client: { async generateJson() { return leakedPlan; } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
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
  assert.ok(!policy.forbiddenBodyTerms.includes("尾巴"));
  assert.ok(policy.forbiddenBodyTerms.includes("狼爪"));
  assert.ok(policy.forbiddenBodyTerms.includes("肉垫"));

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
  tailPlan.shotPlan[0].startFramePrompt = "小白子站在村口，狼耳竖起，狼尾巴轻轻摇动，双手扶住手工风车。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return tailPlan; } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory })
  );

  const clawPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  clawPlan.characterReferencePrompts[0].appearancePrompt = "小白子，q版狼耳少女，有狼尾巴，狼爪和肉垫清晰可见。";
  clawPlan.shotPlan[0].startFramePrompt = "小白子站在村口，狼尾巴轻摇，狼爪扶住风车，肉垫贴着木柄。";
  const formerlyRejectingWorkflow = new WorkflowService({
    client: { async generateJson() { return clawPlan; } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => formerlyRejectingWorkflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory })
  );
});

test("AI 视觉负面提示词只进入主题变体和完整剧情 prompt，不进入动画 prompt", () => {
  const creatorProfile = { fixedCharacter: "小白子，q版狼耳少女，有狼尾巴", vertical: "治愈日常", constraints: "" };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.forbiddenPositiveTraits.push({ term: "彩虹披风", reason: "用户未声明该服装符号。", severity: "block" });
  visualGuardrails.commonNegativePrompt.push("不要彩虹披风");
  const variant = { id: "V1", title: "风车", characterSetup: { protagonist: creatorProfile.fixedCharacter }, newTask: "送风车" };
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });

  const variantPrompt = variantsPrompt({ creativeBrief, visualGuardrails, creatorProfile, count: 2 });
  const storyPrompt = fullStoryPrompt({ creativeBrief, visualGuardrails, referenceAnalysis: {}, sourceScriptReconstruction: {}, variant, creatorProfile });
  const animationPrompt = animationPlanPrompt({ creativeBrief, visualGuardrails, variant, fullStory, creatorProfile });

  for (const prompt of [variantPrompt, storyPrompt]) {
    assert.match(prompt, /AI 视觉负面提示词通用规则/);
    assert.match(prompt, /彩虹披风/);
    assert.match(prompt, /不要彩虹披风/);
  }
  assert.doesNotMatch(animationPrompt, /AI 视觉负面提示词通用规则/);
  assert.doesNotMatch(animationPrompt, /彩虹披风/);
  assert.doesNotMatch(animationPrompt, /visualGuardrails\.commonNegativePrompt/);
});

test("动画生产包不再按 AI 视觉负面提示词拦截正向画面越界", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，有狼尾巴，儿童",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.forbiddenPositiveTraits.push({ term: "彩虹披风", reason: "用户未声明该服装符号。", severity: "block" });
  visualGuardrails.commonNegativePrompt.push("不要彩虹披风");
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
  leakedPlan.shotPlan[0].startFramePrompt += " 小白子穿着彩虹披风。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedPlan; } },
    animationModel: "qwen3.7-max"
  });

  await assert.doesNotReject(
    () => workflow.createAnimationPlan({ creativeBrief, visualGuardrails, creatorProfile, variant, fullStory }),
  );
});

test("动画生产包正向和规则字段都不再触发 AI 视觉检测", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，q版狼耳少女，有狼尾巴，儿童",
    vertical: "治愈/温情/日常",
    constraints: ""
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const visualGuardrails = mockVisualGuardrails({ ...input, creatorProfile, creativeBrief });
  visualGuardrails.forbiddenPositiveTraits.push({ term: "翅膀", reason: "固定角色未声明翅膀。", severity: "block" });
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
  const safePlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory, visualGuardrails });
  safePlan.visualBible.characterConsistencyRules.push("不要出现翅膀、爪子、肉垫，保持儿童角色外观。");
  safePlan.shotPlan[0].continuityNotes += " 不要新增翅膀、爪子、肉垫。";
  safePlan.shotPlan[0].negativePrompt += "；不要翅膀、爪子、肉垫";
  const safeWorkflow = new WorkflowService({
    client: { async generateJson() { return safePlan; } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => safeWorkflow.createAnimationPlan({ creativeBrief, visualGuardrails, creatorProfile, variant, fullStory })
  );

  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory, visualGuardrails });
  leakedPlan.characterReferencePrompts[0].appearancePrompt += " 不要画爪子和肉垫。";
  leakedPlan.shotPlan[0].startFramePrompt += " 不要出现翅膀。";
  const noDetectionWorkflow = new WorkflowService({
    client: { async generateJson() { return leakedPlan; } },
    animationModel: "qwen3.7-max"
  });
  await assert.doesNotReject(
    () => noDetectionWorkflow.createAnimationPlan({ creativeBrief, visualGuardrails, creatorProfile, variant, fullStory })
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
  assert.match(prompt, /startFramePrompt/);
  assert.match(prompt, /endFramePrompt/);
  assert.match(prompt, /videoPrompt/);
  assert.match(prompt, /默认 8–12 个镜头/);
  assert.match(prompt, /三层简化结构/);
	  assert.match(prompt, /identity \/ scene lock/);
	  assert.match(prompt, /sceneReferencePrompts/);
  assert.match(prompt, /全局负面提示词，只写一次/);
  assert.match(prompt, /拆镜头方案 B/);
  assert.match(prompt, /中景互动镜头/);
  assert.match(prompt, /表情强化镜头/);
  assert.match(prompt, /静态关键帧规格/);
  assert.match(prompt, /同一地点、同一镜头景别、同一机位高度/);
	  assert.match(prompt, /必须用一句短锚点复述同一个 sceneId 的地点\/室内外属性\/背景\/景别\/机位/);
  assert.match(prompt, /仍在同一户外农家院落/);
  assert.match(prompt, /shot 内不要重复堆叠/);
  assert.match(prompt, /固定角色外观边界/);
  assert.match(prompt, /耳朵类设定只代表用户写明的耳朵/);
  assert.match(prompt, /禁止自动新增未声明的身体特征：尾巴/);
});

test("固定角色外观边界提示词不会把显式狼尾巴写成禁止项", () => {
  const policyText = fixedCharacterVisualPolicyText("小白子，q版狼耳少女，形象类似猫娘，有狼尾巴，儿童");
  assert.match(policyText, /允许正向使用的身体特征：尾巴、狼尾、狼尾巴/);
  assert.doesNotMatch(policyText, /禁止自动新增未声明的身体特征：[^。]*狼尾巴/);
  assert.match(policyText, /狼爪/);
  assert.match(policyText, /肉垫/);
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

async function writeTestWorkspace(files) {
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content);
  }
}

function pickEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withoutEnv(env, keys) {
  const copy = { ...env };
  for (const key of keys) delete copy[key];
  return copy;
}
