import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnv, getConfig, resolveDefaultLlmProvider } from "./src/config.js";
import { initializeSystemProxy } from "./src/system-proxy.js";
import { MimoClient } from "./src/mimo-client.js";
import { QwenClient } from "./src/qwen-client.js";
import { DeepSeekClient } from "./src/deepseek-client.js";
import { JimengImageClient, JimengImageConfigError, JimengImageProviderError, buildCharacterReferenceImagePrompt, buildShotFrameImagePrompt } from "./src/jimeng-client.js";
import { buildFrameReferenceModeText, compileShotFrameNegativePrompt } from "./public/shot-frame-prompt.js";
import { buildFrameReferenceManifest } from "./public/shot-reference-images.js";
import { buildShotFrameMultiImagePrompt } from "./public/shot-frame-multi-image-prompt.js";
import { computeDependencyHash, computePromptHash } from "./src/frame-dependency.js";
import { assertFrameDependencyHash, normalizeEndpointReferenceImages } from "./src/frame-reference-request.js";
import { WorkflowService } from "./src/workflow.js";
import { STORYBOARD_PLAN_VERSION, isStoryboardPlan, storyboardPromptArtifactId } from "./public/storyboard-plan.js";
import { ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION, characterPromptBoundaryMismatch, characterReferenceBoundaryMismatch, ensureCharacterPromptMatchesBoundary, ensureCharacterReferenceMatchesBoundary, ensureFrameReferenceModeCompatibility, ensureStoryCandidateContract, ensureStoryEntryCandidateContract, ensureThemeVariantsMatchProfile, extractFixedCharacterName, InputError, requireAnimationPlanAspectRatio } from "./src/validation.js";
import { generateShotVideo, shotVideoGenerationPromptText, ShotVideoConfigError, ShotVideoProviderError } from "./src/shot-video-generator.js";
import { resolveAuthoritativeShotVideoInput, resolveAuthoritativeShotVideoReferenceAssets, resolvePreviousShotFrameReference } from "./src/shot-video-continuity.js";
import {
  inferShotVideoProvider,
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  normalizeShotVideoProvider,
  resolveShotVideoRequestResolution,
  resolveShotVideoSetting,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "./src/shot-video-providers.js";
import {
  buildShotVideoBatchReferenceAssets,
  createShotVideoBatchItems,
  requireShotVideoBatchAspectRatio,
  shotVideoBatchReferenceIssues,
  updateShotVideoBatchItem,
  waitForShotVideoBatchControl
} from "./src/shot-video-batch.js";
import { AttemptStore } from "./src/attempt-store.js";
import {
  CAST_CONFIRMATION_API_PATH,
  CAST_PROPOSAL_API_PATH,
  handleCastApiRequest
} from "./src/cast-api.js";
import { CastOrchestrationService } from "./src/cast-orchestration.js";
import {
  compilerErrorMetadata,
  compilerErrorStatus,
  inferCompilerErrorStage,
  serializeServerError
} from "./src/server-error.js";
import { AnimationPromptCapture } from "./src/animation-prompt-capture.js";
import { PartialRepairDebugWriter } from "./src/partial-repair-debug.js";
import {
  FullModelOutputLogWriter,
  MODEL_OUTPUT_LOG_SCOPES,
  resolvePrivateModelOutputLogRoot
} from "./src/full-model-output-log.js";
import {
  resolveAnimationPlanModelOutputTrace,
  resolveFullStoryModelOutputTrace
} from "./src/full-model-output-trace.js";
import {
  assertFullStoryCandidateBindingCurrent,
  resolveFullStoryCandidateBinding
} from "./src/full-story-candidate-binding.js";
import { loadOrCreatePersistentKey } from "./src/persistent-key.js";
import { STORY_DURATION_MAX_SECONDS, STORY_DURATION_MIN_SECONDS, isValidStoryDurationSeconds } from "./public/story-duration.js";
import { CHARACTER_EXPRESSION_RULES_MAX_CHARS, isValidCharacterExpressionRules } from "./public/character-expression-rules.js";
import { CHARACTER_ART_STYLE_MAX_CHARS, isValidCharacterArtStyle } from "./public/character-art-style.js";
import { FULL_STORY_CAST_SCHEMA_VERSION } from "./public/full-story-format.js";
import {
  STORY_ENTRY_MODE,
  STORY_ENTRY_VARIANT_ID,
  STORY_MODE_CHARACTER_ONLY,
  STORY_MODE_FULL_TEXT,
  STORY_SOURCE_ARTIFACT_ID,
  STORY_SOURCE_ARTIFACT_TYPE,
  StoryEntryInputError,
  isStoryEntryMetadata,
  normalizeStoryEntryCreatorProfile,
  normalizeStorySource
} from "./public/story-entry.js";
import { storyEntryDialogueFaithfulness } from "./src/story-entry-dialogue-check.js";
import { ProductionStateStore } from "./src/production-state-store.js";
import { createProductionPackageDownloadHandler } from "./src/production-package-download.js";
import { BrowserWorkspaceStore, BrowserWorkspaceError } from "./src/browser-workspace-store.js";
import { createBrowserWorkspaceHandler, requiredWorkspaceGeneration, requiredWorkspacePageId } from "./src/browser-workspace-http.js";
import { BrowserWorkspaceCleanup } from "./src/browser-workspace-cleanup.js";
import { scopeBrowserWorkspaceDebugWriter, scopeBrowserWorkspacePromptCapture } from "./src/browser-workspace-debug.js";
import { ProductionStateError, contentDigest, lineageRef, normalizeArtifactId, safeIdentifier } from "./src/production-lineage.js";
import { ProductionRunCoordinator } from "./src/production-run-coordinator.js";
import { DurableTaskStore, DURABLE_TASK_TERMINAL_STATUSES } from "./src/durable-task-store.js";
import { DurableTaskManager } from "./src/durable-task-manager.js";
import { currentDurableTaskContext, runWithDurableTaskContext } from "./src/durable-task-context.js";
import { readModelUsageFromError, runWithUsageAccounting } from "./src/token-usage.js";
import { resolveBuildIdentity } from "./src/build-identity.js";
import {
  PRODUCTION_REQUEST_HEADER_NAMES,
  productionRequestHeaders
} from "./public/production-lineage-client.js";
import {
  PREVIOUS_SHOT_REFERENCE_FRAME_COUNT,
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
  shouldIncludePreviousShotFrames,
  shotVideoArtifactIdFor
} from "./public/shot-video-continuity.js";
import { syncShotCharacterReference } from "./public/character-reference-sync.js";

loadEnv();
const systemProxy = await initializeSystemProxy();
const root = path.dirname(fileURLToPath(import.meta.url));
const config = getConfig();
const buildIdentity = resolveBuildIdentity({ workspaceRoot: root });
const partialRepairDebugWriter = scopeBrowserWorkspaceDebugWriter(new PartialRepairDebugWriter({
  outputRoot: process.env.PARTIAL_REPAIR_DEBUG_DIR
    || path.join(root, "debug", "partial-repairs")
}), (fallback) => browserWorkspaceDebugRoot("partial-repairs", fallback));
const fullModelOutputLogWriter = scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({
  ...buildIdentity,
  outputRoot: await resolvePrivateModelOutputLogRoot({
    workspaceRoot: root,
    configuredValue: process.env.FULL_STORY_MODEL_OUTPUT_LOG_DIR,
    servedRoot: path.join(root, "public")
  })
}), (fallback) => browserWorkspaceDebugRoot("full-story", fallback));
const animationModelOutputLogWriter = scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({
  ...buildIdentity,
  scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN,
  outputRoot: await resolvePrivateModelOutputLogRoot({
    workspaceRoot: root,
    configuredValue: process.env.ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR,
    servedRoot: path.join(root, "public"),
    environmentVariableName: "ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR",
    logLabel: "Animation Plan 模型全量输出"
  })
}), (fallback) => browserWorkspaceDebugRoot("animation-plan", fallback));
// 这些阶段共用一个 root，按 stage 各建一个 writer；
// 不配置 STAGE_MODEL_OUTPUT_LOG_DIR 就完全不写。
// 普通阶段走 generateStageJson；原片来源提取复用 variants 配置但单独记日志；
// animationPlanRevision 走 modelCallCoordinator，由 workflow 接 attemptObserver。
const STAGE_MODEL_OUTPUT_LOG_SCOPES = [
  MODEL_OUTPUT_LOG_SCOPES.ANALYSIS,
  MODEL_OUTPUT_LOG_SCOPES.RECONSTRUCTION,
  MODEL_OUTPUT_LOG_SCOPES.BRIEF,
  MODEL_OUTPUT_LOG_SCOPES.VARIANTS,
  MODEL_OUTPUT_LOG_SCOPES.VARIANT_SOURCE_BASELINE,
  MODEL_OUTPUT_LOG_SCOPES.VISUAL_GUARDRAILS,
  MODEL_OUTPUT_LOG_SCOPES.CHARACTER_REFERENCE,
  MODEL_OUTPUT_LOG_SCOPES.STORY_CANDIDATE_REVIEW,
  MODEL_OUTPUT_LOG_SCOPES.STORY_CANDIDATE_REVISION,
  MODEL_OUTPUT_LOG_SCOPES.STORY_QUALITY_REVIEW,
  MODEL_OUTPUT_LOG_SCOPES.STORY_QUALITY_REPAIR,
  MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVIEW,
  MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVISION,
  MODEL_OUTPUT_LOG_SCOPES.FULL_STORY_PROMISE_CHECK,
  // 自主分镜 4.0 的六个阶段同样走 coordinator，由 storyboard-workflow.js 接 attemptObserver。
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_CHARACTER_FACTS,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_DESIGN,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVIEW,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVISION,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVIEW_FINAL,
  MODEL_OUTPUT_LOG_SCOPES.SHOT_VIDEO_PROMPT,
  // 导演助手（2026-10-09）同样走 coordinator，由 workflow 接 attemptObserver。
  MODEL_OUTPUT_LOG_SCOPES.DIRECTOR_AGENT
];
const stageModelOutputLogRoot = await resolvePrivateModelOutputLogRoot({
  workspaceRoot: root,
  configuredValue: process.env.STAGE_MODEL_OUTPUT_LOG_DIR,
  servedRoot: path.join(root, "public"),
  environmentVariableName: "STAGE_MODEL_OUTPUT_LOG_DIR",
  logLabel: "工作流阶段模型全量输出"
});
const stageModelOutputLogWriters = new Map(STAGE_MODEL_OUTPUT_LOG_SCOPES.map((scope) => [
  scope,
  scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({
    ...buildIdentity,
    scope,
    outputRoot: stageModelOutputLogRoot
  }), (fallback) => browserWorkspaceDebugRoot(`stage-${scope}`, fallback))
]));
const animationPromptCapture = scopeBrowserWorkspacePromptCapture(new AnimationPromptCapture({
  outputRoot: process.env.ANIMATION_PROMPT_CAPTURE_DIR || "",
  modelOutputLogWriter: animationModelOutputLogWriter
}), (fallback) => browserWorkspaceDebugRoot("animation-prompts", fallback));
if (animationPromptCapture.active) {
  globalThis.fetch = animationPromptCapture.wrapFetch(globalThis.fetch);
}
const mimoClient = config.mimo.enabled ? new MimoClient(config.mimo) : null;
const qwenClient = config.qwen.enabled ? new QwenClient(config.qwen) : null;
const deepseekClient = config.deepseek.enabled ? new DeepSeekClient(config.deepseek) : null;
const jimengClient = config.jimeng.enabled ? new JimengImageClient(config.jimeng) : null;
const stageDefaults = buildStageDefaults(config, { mimoClient, qwenClient });
const modelStages = buildModelStages(stageDefaults, config);
const clients = { MiMo: mimoClient, Qwen: qwenClient, DeepSeek: deepseekClient };
const attemptStore = new AttemptStore();
const productionRunCoordinator = new ProductionRunCoordinator();
const productionStateStore = new ProductionStateStore({
  ...buildIdentity,
  rootDir: config.workflowRuntime.productionStateDirectory,
  coordinator: productionRunCoordinator
});
const handleProductionPackageDownload = createProductionPackageDownloadHandler({ productionStore: productionStateStore });
const durableTaskStore = new DurableTaskStore({
  rootDir: config.workflowRuntime.productionStateDirectory
});
// 这两把密钥必须跨重启保持不变：落盘 Artifact 上的 groundingSeal 与 boundarySignature
// 都是用它们签的，换钥等于让用户恢复的 Run 在下一次点击时全部作废。
// 密钥材料只留在这里，不进 config 对象——/api/health 现在是逐字段挑选，
// 但把密钥放进那个对象，离一次随手的展开就只有一步。
const groundingKeyEntry = await loadOrCreatePersistentKey({
  directory: config.workflowRuntime.productionStateDirectory,
  fileName: ".grounding-key",
  byteLength: 32,
  label: "Grounding 密钥",
  envValue: process.env.WORKFLOW_GROUNDING_KEY
});
const characterBoundaryKeyEntry = await loadOrCreatePersistentKey({
  directory: config.workflowRuntime.productionStateDirectory,
  fileName: ".character-boundary-key",
  byteLength: 32,
  label: "全局角色边界密钥",
  envValue: process.env.WORKFLOW_CHARACTER_BOUNDARY_KEY
});
const workflow = new WorkflowService({
  clients,
  stageDefaults,
  characterBoundarySignatureRequired: config.workflowRuntime.characterBoundarySignatureRequired,
  groundingKey: groundingKeyEntry.key,
  characterBoundaryKey: characterBoundaryKeyEntry.key,
  attemptStore,
  partialRepairDebugWriter,
  fullModelOutputLogWriter,
  stageModelOutputLogWriters
});
const durableTaskManager = new DurableTaskManager({
  productionStore: productionStateStore,
  taskStore: durableTaskStore,
  coordinator: productionRunCoordinator,
  localStallMs: config.durableTasks.localStallMs,
  providerGraceMs: config.durableTasks.providerGraceMs,
  maxQueuedBytes: config.durableTasks.maxQueuedBytes,
  pools: config.durableTasks.pools
});
const castOrchestration = new CastOrchestrationService({
  environment: config.fullStoryV2Pipeline.environment,
  audience: config.fullStoryV2Pipeline.audience,
  confirmationTtlMs: config.fullStoryV2Pipeline.castConfirmationTtlMs,
  storyProvider: workflow.storyClient
});
const publicDir = path.join(root, "public");
const browserWorkspaceRoot = `${config.workflowRuntime.productionStateDirectory}-browser-workspaces`;
const browserWorkspaceCleanup = new BrowserWorkspaceCleanup({
  productionStore: productionStateStore,
  taskManager: durableTaskManager,
  coordinator: productionRunCoordinator,
  publicDir,
  cleanupRoot: `${browserWorkspaceRoot}-cleanup`,
  outputLogRoots: [fullModelOutputLogWriter.outputRoot, animationModelOutputLogWriter.outputRoot,
    ...[...stageModelOutputLogWriters.values()].map((writer) => writer.outputRoot)].filter(Boolean)
});
const browserWorkspaceStore = new BrowserWorkspaceStore({
  rootDir: browserWorkspaceRoot,
  cleanupRun: (run) => browserWorkspaceCleanup.cleanup(run)
});
const handleBrowserWorkspace = createBrowserWorkspaceHandler({ store: browserWorkspaceStore });

async function browserWorkspaceDebugRoot(kind, fallback) {
  const context = currentDurableTaskContext();
  if (!context) return fallback;
  try {
    const task = await context.getTask();
    const run = await productionStateStore.loadRun({ projectId: task.projectId, runId: task.runId, includeContent: false });
    return run.metadata?.browserWorkspaceId
      ? path.join(productionStateStore.runDirectory(run.projectId, run.runId), "debug", kind)
      : fallback;
  } catch {
    // A late observer after deletion must never fall back to an unowned log.
    return null;
  }
}

// variantId 默认取请求里的候选 id；「从剧情开始」的 Run 由调用方传故事位 V1。
async function fullStoryModelOutputTrace(request, body = {}, variantId = body?.variant?.id) {
  if (!fullModelOutputLogWriter.enabled) return null;
  const result = await resolveFullStoryModelOutputTrace({
    headers: request?.headers || {},
    variantId,
    loadRun: (input) => productionStateStore.loadRun(input)
  });
  if (result.warning) console.warn(result.warning);
  return result.context;
}

async function animationPlanModelOutputTrace(request, body = {}, variantId = body?.variant?.id) {
  if (!animationModelOutputLogWriter.enabled) return null;
  const result = await resolveAnimationPlanModelOutputTrace({
    headers: request?.headers || {},
    variantId,
    loadRun: (input) => productionStateStore.loadRun(input)
  });
  if (result.warning) console.warn(result.warning);
  return result.context;
}

const routes = {
  "/api/analyze": (body) => workflow.analyze(body),
  "/api/reconstruct": (body) => workflow.reconstruct(body),
  "/api/brief": (body) => workflow.createBrief(body),
  "/api/visual-guardrails": (body) => workflow.createVisualGuardrails(body),
  "/api/variants": (body) => {
    // 与 /api/full-story 同规格：候选的 estimatedSeconds 合计决定下游成片长度，
    // 所以目标时长必须在这一阶段就能送到。只进提示词，不写入 Artifact、不参与
    // 派生。这里只拦明显非法的值，不裁决「这个时长合不合适」。
    if (body?.targetDurationSeconds !== undefined && !isValidStoryDurationSeconds(body.targetDurationSeconds)) {
      throw new InputError(
        `targetDurationSeconds 必须是 ${STORY_DURATION_MIN_SECONDS}-${STORY_DURATION_MAX_SECONDS} 之间的整数秒`
      );
    }
    return workflow.createVariants(body);
  },
  "/api/full-story": async (body, { request } = {}) => {
    // 用户在「设定创作宇宙」选的目标时长。只进提示词，不写入 Artifact、不参与派生——
    // Artifact 里的 targetDurationSeconds 仍由 deriveFullStoryTargetDuration 从时间轴签发。
    // 这里只拦明显非法的值，不裁决「这个时长合不合适」。
    if (body?.targetDurationSeconds !== undefined && !isValidStoryDurationSeconds(body.targetDurationSeconds)) {
      throw new InputError(
        `targetDurationSeconds 必须是 ${STORY_DURATION_MIN_SECONDS}-${STORY_DURATION_MAX_SECONDS} 之间的整数秒`
      );
    }
    const validateBoundCandidate = (candidate) => {
      ensureStoryCandidateContract(candidate, { path: "selectedCandidate" });
      ensureThemeVariantsMatchProfile(
        { variants: [candidate] },
        body?.creatorProfile,
        body?.creativeBrief,
        body?.visualGuardrails
      );
      return candidate;
    };
    const candidateBinding = await resolveFullStoryCandidateBinding({
      headers: request?.headers || {},
      body,
      loadRun: (input) => productionStateStore.loadRun(input),
      validateCandidate: validateBoundCandidate
    });
    const result = await workflow.createFullStory(candidateBinding.input, {
      traceContext: await fullStoryModelOutputTrace(request, candidateBinding.input)
    });
    await assertFullStoryCandidateBindingCurrent(candidateBinding, {
      loadRun: (input) => productionStateStore.loadRun(input),
      validateCandidate: validateBoundCandidate
    });
    return result;
  },
  "/api/animation-plan": async (body, { request } = {}) => {
    // 用户在「设定创作宇宙」写的角色表情规则。与 targetDurationSeconds 同规格：
    // 只进 Foundation 与逐镜提示词，不写入 Artifact、不参与派生、不进 digest。
    // 这里只拦明显非法的值，不裁决「这条规则写得好不好」。
    if (body?.characterExpressionRules !== undefined && !isValidCharacterExpressionRules(body.characterExpressionRules)) {
      throw new InputError(`characterExpressionRules 必须是不超过 ${CHARACTER_EXPRESSION_RULES_MAX_CHARS} 字符的字符串`);
    }
    assertCharacterArtStyleInput(body);
    return animationPromptCapture.run({
    route: "/api/animation-plan",
    variantId: body?.variant?.id,
    animationPlanMode: body?.animationPlanMode,
    provider: String(body?.modelOverrides?.animationPlan?.provider || stageDefaults.animationPlan.provider || ""),
    traceContext: await animationPlanModelOutputTrace(request, body)
  }, () => body?.includeCompilerMetadata
      ? workflow.createAnimationPlanWithMetadata(body)
      : workflow.createAnimationPlan(body));
  },
  "/api/animation-plan/video-prompts/rewrite": async (body, { request } = {}) => {
    const productionMedia = await resolveProductionMediaContext(body, { required: true });
    return animationPromptCapture.run({
      route: "/api/animation-plan/video-prompts/rewrite",
      variantId: body?.variant?.id,
      animationPlanMode: "direct_shot",
      provider: String(body?.modelOverrides?.animationPlan?.provider || stageDefaults.animationPlan.provider || ""),
      traceContext: await animationPlanModelOutputTrace(request, body)
    }, () => workflow.rewriteAnimationPlanVideoPrompts({
      ...body,
      // The browser may display an older copy while this request is in flight.
      // Only the current signed Artifact is authorized as rewrite source.
      animationPlan: productionMedia.planEntry.content
    }));
  },
  // 剧情体检：只出报告。不签发 Artifact、不进 lineage、不 stale 任何东西、不阻断后续阶段。
  "/api/story-quality-review": (body) => workflow.createStoryQualityReview(body),
  // 按体检意见修改：只出修订稿。**不签发任何东西**——返回合并后的剧情供页面预览，
  // 用户点「采纳」时才由浏览器走既有的 fullStory 签发流程。
  "/api/story-quality-repair": (body) => workflow.createStoryQualityRepair(body),
  // 候选对照评审：同样只出报告。送审投影里剥掉候选的自我评价字段，让动作链自己说话；
  // verdict 里的 drop 只是一句话，不删候选、不改数量、不触发任何 stale。
  "/api/story-candidate-review": (body) => workflow.createStoryCandidateReview(body),
  // 命题定向修订：按对照评审报出的因果断裂只改被点名的那一个命题。**不签发任何东西**——
  // 返回合并后的整批供页面预览，用户点「采纳」时才由浏览器走既有的 themeVariants 签发流程。
  "/api/story-candidate-revision": (body) => workflow.createStoryCandidateRevision(body),
  // 完整剧情的展开前体检：原样调用候选对照评审（只送选中的这一个候选）并加一次承诺核对，
  // 确定性地给出「先修订候选」还是「直接展开」。与评审同规格，只出报告、不签发任何东西；
  // 候选要改，只能由用户在页面上采纳修订、签发新版本之后再展开。
  "/api/full-story-precheck": (body) => workflow.createFullStoryPrecheck(body),
  "/api/animation-plan-review": (body) => workflow.createAnimationPlanReview(body),
  // 导演助手（2026-10-09）：理解对话栏里打的字。只出建议——模型从页面送来的动作清单里选一个编号，
  // 不签发任何东西、不执行任何东西；执行只在用户点卡片上的「确认执行」之后，由页面调原有按钮。
  "/api/director-agent/turn": (body) => workflow.createDirectorAgentTurn(body),
  // 定向修订：按终审报告只改被点名的镜头。**不签发任何东西**——返回合并后的候选 Plan
  // 供页面预览，用户点「采纳」时才由浏览器走既有的 Plan revision 签发流程。
  "/api/animation-plan-revision": (body) => workflow.createAnimationPlanRevision(body),
  "/api/refine-character-reference": (body) => workflow.refineCharacterReference(body),
  "/api/generate-shot-video": async (body) => {
    const productionMedia = await resolveProductionMediaContext(body, { required: true });
    const authoritativeInput = resolveAuthoritativeShotVideoInput({
      planArtifactId: productionMedia.planArtifactId,
      planEntry: productionMedia.planEntry,
      currentShotId: body.shotId || body.shot?.shotId,
      promptOverride: body.promptOverride,
      requestedSchemaVersion: body.animationPromptSchemaVersion,
      selectedVariantId: body.selectedVariantId
    });
    const request = {
      ...body,
      shot: authoritativeInput.shot,
      characterReferences: authoritativeInput.characterReferences,
      referenceAssets: resolveAuthoritativeShotVideoReferenceAssets(
        body.referenceAssets,
        productionMedia.planEntry.content,
        authoritativeInput.shot
      ),
      animationPromptSchemaVersion: authoritativeInput.promptSchemaVersion,
      videoPromptSource: authoritativeInput.promptSource,
      videoPromptProfile: structuredClone(
        productionMedia.planEntry.content?.productionStrategy?.videoPromptProfile || null
      )
    };
    const visualGuardrails = verifyBoundaryForMedia(productionMedia, body);
    ensureCharacterReferencesMatchBoundary(request.characterReferences, visualGuardrails, request.shot);
    const setting = shotVideoRequestSetting(body);
    ensureCharacterPromptMatchesBoundary(shotVideoGenerationPromptText(request), visualGuardrails, {
      requireRequiredTraits: false,
      promptScope: "multi_character"
    });
    if (
      String(body.aspectRatio || "").trim()
      && body.aspectRatio !== productionMedia.planAspectRatio
    ) {
      throw new ProductionStateError("视频请求画幅与当前 Animation Plan 不一致", {
        code: "MEDIA_PLAN_ASPECT_RATIO_MISMATCH",
        httpStatus: 409,
        details: [{ requested: body.aspectRatio, currentPlan: productionMedia.planAspectRatio }]
      });
    }
    const trustedPreviousShotReference = productionMedia
      ? await resolvePreviousShotFrameReference({
        continuityReferenceMode: request.continuityReferenceMode,
        generationMode: request.generationMode,
        currentShotId: request.shot.shotId,
        planArtifactId: productionMedia.planArtifactId,
        planEntry: productionMedia.planEntry,
        latestArtifacts: productionMedia.latestArtifacts,
        videoOutputRoot: productionMedia.videoOutputRoot,
        videoPublicBasePath: productionMedia.videoPublicBasePath,
        filenamePrefix: productionMedia.filenamePrefix
      })
      : null;
    return generateShotVideo({
      ...request,
      visualGuardrails,
      aspectRatio: productionMedia?.planAspectRatio || requireAnimationPlanAspectRatio(body.aspectRatio || "9:16", "aspectRatio"),
      videoProvider: setting.provider,
      videoModel: setting.model,
      ...(productionMedia ? {
        outputRoot: productionMedia.videoOutputRoot,
        publicBasePath: productionMedia.videoPublicBasePath,
        filenamePrefix: productionMedia.filenamePrefix,
        ...(productionMedia.workspaceMediaLifetime || {})
      } : {}),
      trustedPreviousShotReference,
      assertProductionContextCurrent: async () => {
        const currentMedia = await resolveProductionMediaContext(body, { required: true });
        if (!trustedPreviousShotReference) return;
        const currentPrevious = await resolvePreviousShotFrameReference({
          continuityReferenceMode: request.continuityReferenceMode,
          generationMode: request.generationMode,
          currentShotId: request.shot.shotId,
          planArtifactId: currentMedia.planArtifactId,
          planEntry: currentMedia.planEntry,
          latestArtifacts: currentMedia.latestArtifacts,
          videoOutputRoot: currentMedia.videoOutputRoot,
          videoPublicBasePath: currentMedia.videoPublicBasePath,
          filenamePrefix: currentMedia.filenamePrefix
        });
        if (
          currentPrevious?.sourceArtifact?.artifactId !== trustedPreviousShotReference.sourceArtifact?.artifactId
          || currentPrevious?.sourceArtifact?.revision !== trustedPreviousShotReference.sourceArtifact?.revision
          || currentPrevious?.sourceArtifact?.contentDigest !== trustedPreviousShotReference.sourceArtifact?.contentDigest
          || currentPrevious?.selectedIndex !== trustedPreviousShotReference.selectedIndex
          || currentPrevious?.sourceOutputUrl !== trustedPreviousShotReference.sourceOutputUrl
        ) {
          throw new ProductionStateError("上一镜当前候选已更新，拒绝继续使用旧的抽帧结果。", {
            code: "SHOT_VIDEO_PREVIOUS_REFERENCE_STALE",
            httpStatus: 409
          });
        }
      }
    });
  },
  "/api/run": (body) => workflow.run(body)
};

const DIRECTOR_PIPELINE_STAGES = Object.freeze([
  {
    key: "analysis",
    taskKind: "analyze",
    artifactId: "referenceAnalysis",
    artifactType: "referenceAnalysis",
    dependencyIds: [],
    route: "/api/analyze",
    buildInput: (raw) => ({ ...pipelineMediaInput(raw) })
  },
  {
    key: "reconstruction",
    taskKind: "reconstruct",
    artifactId: "sourceScriptReconstruction",
    artifactType: "sourceScriptReconstruction",
    dependencyIds: ["referenceAnalysis"],
    route: "/api/reconstruct",
    buildInput: (raw, artifacts) => ({
      ...pipelineMediaInput(raw),
      referenceAnalysis: artifacts.referenceAnalysis
    })
  },
  {
    key: "brief",
    taskKind: "brief",
    artifactId: "creativeBrief",
    artifactType: "creativeBrief",
    dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction"],
    route: "/api/brief",
    buildInput: (raw, artifacts) => ({
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creatorProfile: raw.creatorProfile,
      modelOverrides: raw.modelOverrides
    })
  },
  {
    key: "visualGuardrails",
    taskKind: "visualGuardrails",
    artifactId: "visualGuardrails",
    artifactType: "visualGuardrails",
    dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"],
    route: "/api/visual-guardrails",
    buildInput: (raw, artifacts) => ({
      ...pipelineMediaInput(raw),
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief
    })
  },
  {
    key: "variants",
    taskKind: "variants",
    artifactId: "themeVariants",
    artifactType: "themeVariants",
    dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails"],
    route: "/api/variants",
    buildInput: (raw, artifacts) => ({
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief,
      visualGuardrails: artifacts.visualGuardrails,
      creatorProfile: raw.creatorProfile,
      count: raw.count,
      // 白名单是显式构造：漏掉这个键会让 Durable 路径静默丢弃目标时长，
      // 表现为「浏览器直调有效、走任务队列无效」。
      targetDurationSeconds: raw.targetDurationSeconds,
      modelOverrides: raw.modelOverrides
    })
  }
]);

function taskDefinitionForRequest(body = {}) {
  const projectId = safeIdentifier(body.projectId, "projectId");
  const runId = safeIdentifier(body.runId, "runId");
  const kind = String(body.kind || "").trim();
  const input = plainObject(body.input);
  if (kind === "directorPipeline") {
    const forbiddenResumeKeys = ["resumeFromStage", "startStage", "stageIndex", "resumeStage"]
      .filter((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (forbiddenResumeKeys.length) {
      throw new ProductionStateError("Pipeline 续跑阶段只能由服务端根据 current Artifact 链决定。", {
        code: "TASK_RESUME_HINT_FORBIDDEN",
        httpStatus: 400,
        details: forbiddenResumeKeys.map((key) => ({ key }))
      });
    }
    return directorPipelineTaskDefinition({ projectId, runId, input });
  }
  if (kind === "storyPipeline") return storyPipelineTaskDefinition({ projectId, runId, input });
  if (["analyze", "reconstruct", "brief", "visualGuardrails"].includes(kind)) {
    const stage = DIRECTOR_PIPELINE_STAGES.find((item) => item.taskKind === kind);
    return pipelineStageTaskDefinition({ projectId, runId, raw: input, stage });
  }
  if (kind === "variants") return standaloneVariantsTaskDefinition({ projectId, runId, input });
  if (kind === "fullStory") return fullStoryTaskDefinition({ projectId, runId, input });
  if (kind === "animationPlan") return animationPlanTaskDefinition({ projectId, runId, input });
  if (kind === "shotVideoPrompt") return shotVideoPromptTaskDefinition({ projectId, runId, input });
  if (kind === "animationPromptRewrite") return animationPromptRewriteTaskDefinition({ projectId, runId, input });
  if (kind === "characterReferenceRefine") return characterReferenceRefineTaskDefinition({ projectId, runId, input });
  if (kind === "characterReferenceImages") return characterReferenceImagesTaskDefinition({ projectId, runId, input });
  if (kind === "shotVideoBatch") return shotVideoBatchTaskDefinition({ projectId, runId, input });
  if (kind === "shotVideo") return shotVideoTaskDefinition({ projectId, runId, input });
  if (kind === "shotFrameImage") return shotFrameTaskDefinition({ projectId, runId, input });
  throw new ProductionStateError(`不支持 Durable Task kind：${kind || "(空)"}`, {
    code: "TASK_KIND_UNSUPPORTED",
    httpStatus: 400
  });
}

function directorPipelineTaskDefinition({ projectId, runId, input }) {
  const inputDigest = contentDigest(nonArtifactInputDigestSource(input));
  return {
    projectId,
    runId,
    kind: "directorPipeline",
    pool: "workflow",
    targetArtifactIds: DIRECTOR_PIPELINE_STAGES.map((stage) => stage.artifactId),
    modelSnapshot: modelSnapshotFor(input, DIRECTOR_PIPELINE_STAGES.map((stage) => stage.key)),
    prepare: async ({ run }) => {
      assertRunEntryMode(run, "video");
      const expectedSourceDigest = String(run.metadata?.sourceVideoDigest || "").trim().toLowerCase();
      const actualSourceDigest = String(input.sourceVideoDigest || "").trim().toLowerCase();
      const requiresSourceMedia = ["referenceAnalysis", "sourceScriptReconstruction", "visualGuardrails"]
        .some((artifactId) => run.latestArtifacts?.[artifactId]?.lineage?.status !== "current");
      if (requiresSourceMedia && expectedSourceDigest && actualSourceDigest !== expectedSourceDigest) {
        throw new ProductionStateError("重新上传的视频与当前 Run 的原始文件 SHA-256 不一致。", {
          code: "TASK_SOURCE_VIDEO_DIGEST_MISMATCH",
          httpStatus: 409,
          details: [{ expectedSourceDigest, actualSourceDigest: actualSourceDigest || null }]
        });
      }
      return {
        input: structuredClone(input),
        inputDigest,
        targetArtifactIds: DIRECTOR_PIPELINE_STAGES.map((stage) => stage.artifactId),
        modelSnapshot: modelSnapshotFor(input, DIRECTOR_PIPELINE_STAGES.map((stage) => stage.key)),
        progress: { completedStages: 0, totalStages: DIRECTOR_PIPELINE_STAGES.length, controlState: "running" }
      };
    },
    execute: async (raw, context) => {
      const completed = [];
      const usages = [];
      let reusedStages = 0;
      for (const stage of DIRECTOR_PIPELINE_STAGES) {
        const snapshot = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
        const existing = snapshot.latestArtifacts?.[stage.artifactId];
        if (existing?.lineage?.status === "current") {
          completed.push(lineageRef(existing.lineage));
          reusedStages += 1;
          await context.heartbeat({
            reusedStages,
            completedStages: completed.length,
            totalStages: DIRECTOR_PIPELINE_STAGES.length,
            currentStage: stage.artifactId,
            reusedCurrentArtifact: true
          });
          continue;
        }
        assertPipelineMediaAvailable(stage, raw);
        await context.heartbeat({
          completedStages: completed.length,
          totalStages: DIRECTOR_PIPELINE_STAGES.length,
          currentStage: stage.artifactId
        });
        const child = await context.runChild(pipelineStageTaskDefinition({ projectId, runId, raw, stage }));
        completed.push(...(child.resultArtifactRefs || []));
        if (child.usage) usages.push(child.usage);
        await context.heartbeat({
          completedStages: completed.length,
          totalStages: DIRECTOR_PIPELINE_STAGES.length,
          currentStage: stage.artifactId
        });
      }
      const run = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
      return {
        resultArtifactRefs: completed,
        usage: mergeTaskUsages(usages),
        progress: { completedStages: DIRECTOR_PIPELINE_STAGES.length, totalStages: DIRECTOR_PIPELINE_STAGES.length, reusedStages },
        compatibilityResult: Object.fromEntries(DIRECTOR_PIPELINE_STAGES.map((stage) => [
          stage.artifactId,
          run.latestArtifacts?.[stage.artifactId]?.content
        ]))
      };
    }
  };
}

function pipelineStageTaskDefinition({ projectId, runId, raw, stage }) {
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: stage.taskKind,
    pool: "workflow",
    artifactId: stage.artifactId,
    artifactType: stage.artifactType,
    dependencyIds: stage.dependencyIds,
    modelStages: [stage.key],
    rawInput: raw,
    prepareInput: (run) => {
      assertRunEntryMode(run, "video");
      assertCompatibleArtifactCopies(run, raw, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"]
      ]);
      return stage.buildInput(raw, currentArtifactContents(run));
    },
    invoke: (trustedInput, request) => routes[stage.route](trustedInput, { request })
  });
}

// 「从剧情开始」的两步，按 Run 元数据里的 storyMode 选：
// - 只给角色设定：角色边界 → 单个故事候选，之后由父任务签发选中记录 variant:V1；
// - 粘贴完整故事：角色边界 → 可翻拍镜头（原文直接拆场，写 fullStory:V1），没有候选这一步。
// 与 DIRECTOR_PIPELINE_STAGES 并列、互不复用：AI 导演那条链的五个目标、「n/5」进度、
// 需要源视频的判断和 standaloneVariantsTaskDefinition 取最后一项的写法都保持原样。
// 子任务只能经由父任务创建，taskDefinitionForRequest 不接受它们的 kind。
const STORY_PIPELINE_GUARDRAILS_STAGE = Object.freeze({
  key: "visualGuardrails",
  taskKind: "storyVisualGuardrails",
  artifactId: "visualGuardrails",
  artifactType: "visualGuardrails",
  dependencyIds: [STORY_SOURCE_ARTIFACT_ID],
  buildInput: (raw, entry) => ({
    creatorProfile: entry.creatorProfile,
    modelOverrides: raw.modelOverrides
  }),
  invoke: (input, storyEntry) => workflow.createStoryEntryVisualGuardrails(input, { storyEntry })
});
const STORY_PIPELINE_CANDIDATE_STAGE = Object.freeze({
  key: "variants",
  taskKind: "storyCandidate",
  artifactId: "themeVariants",
  artifactType: "themeVariants",
  dependencyIds: [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails"],
  buildInput: (raw, entry, artifacts) => ({
    creatorProfile: entry.creatorProfile,
    visualGuardrails: artifacts.visualGuardrails,
    targetDurationSeconds: raw.targetDurationSeconds,
    modelOverrides: raw.modelOverrides
  }),
  invoke: (input, storyEntry) => workflow.createStoryEntryCandidate(input, { storyEntry })
});
// 与分场页「重新拆分」（独立的 fullStory 任务）调同一个函数，只有一份实现。
const STORY_PIPELINE_SCENE_SCRIPT_STAGE = Object.freeze({
  key: "fullStory",
  taskKind: "storySceneScript",
  artifactId: `fullStory:${STORY_ENTRY_VARIANT_ID}`,
  artifactType: "fullStory",
  dependencyIds: [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails"],
  buildInput: (raw, entry, artifacts) => ({
    creatorProfile: entry.creatorProfile,
    visualGuardrails: artifacts.visualGuardrails,
    targetDurationSeconds: raw.targetDurationSeconds,
    // 与页面「生成完整剧情」请求同一个版本：带完整角色表。
    fullStorySchemaVersion: FULL_STORY_CAST_SCHEMA_VERSION,
    modelOverrides: raw.modelOverrides
  }),
  invoke: (input, storyEntry, request) => storyEntrySourceFullStory(input, { request, storyEntry })
});
const STORY_PIPELINE_SELECTION_ARTIFACT_ID = `variant:${STORY_ENTRY_VARIANT_ID}`;

function storyPipelinePlan(storyMode) {
  const fromStorySource = storyMode === STORY_MODE_FULL_TEXT;
  const stages = fromStorySource
    ? [STORY_PIPELINE_GUARDRAILS_STAGE, STORY_PIPELINE_SCENE_SCRIPT_STAGE]
    : [STORY_PIPELINE_GUARDRAILS_STAGE, STORY_PIPELINE_CANDIDATE_STAGE];
  return {
    stages,
    // 只有「只给角色设定」有候选，才需要签发选中记录。
    signsSelection: !fromStorySource,
    targetArtifactIds: [
      ...stages.map((stage) => stage.artifactId),
      ...(fromStorySource ? [] : [STORY_PIPELINE_SELECTION_ARTIFACT_ID])
    ],
    modelStages: stages.map((stage) => stage.key)
  };
}

function storyPipelineTaskDefinition({ projectId, runId, input }) {
  const inputDigest = contentDigest(nonArtifactInputDigestSource(input));
  // 建任务时还没读 Run；真正的步骤、目标与模型快照在 prepare 里按 Run 元数据决定，
  // 任务管理器以 prepare 返回的为准。这里先按「只给角色设定」填一份占位。
  const placeholder = storyPipelinePlan(STORY_MODE_CHARACTER_ONLY);
  return {
    projectId,
    runId,
    kind: "storyPipeline",
    pool: "workflow",
    targetArtifactIds: [...placeholder.targetArtifactIds],
    dependencyIds: [STORY_SOURCE_ARTIFACT_ID],
    modelSnapshot: modelSnapshotFor(input, placeholder.modelStages),
    prepare: async ({ run }) => {
      const entry = trustedStoryEntryContext(run);
      assertStoryEntryProfileCopy(input, entry);
      if (input.targetDurationSeconds !== undefined && !isValidStoryDurationSeconds(input.targetDurationSeconds)) {
        throw new InputError(`targetDurationSeconds 必须是 ${STORY_DURATION_MIN_SECONDS}-${STORY_DURATION_MAX_SECONDS} 之间的整数秒`);
      }
      const plan = storyPipelinePlan(entry.storyMode);
      return {
        input: structuredClone(input),
        inputDigest,
        targetArtifactIds: [...plan.targetArtifactIds],
        dependencyIds: [STORY_SOURCE_ARTIFACT_ID],
        modelSnapshot: modelSnapshotFor(input, plan.modelStages),
        progress: { completedStages: 0, totalStages: plan.stages.length }
      };
    },
    execute: async (raw, context) => {
      const initialRun = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
      const plan = storyPipelinePlan(trustedStoryEntryContext(initialRun).storyMode);
      const totalStages = plan.stages.length;
      const completed = [];
      const usages = [];
      let reusedStages = 0;
      for (const stage of plan.stages) {
        const snapshot = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
        const existing = snapshot.latestArtifacts?.[stage.artifactId];
        if (existing?.lineage?.status === "current") {
          completed.push(lineageRef(existing.lineage));
          reusedStages += 1;
          await context.heartbeat({
            reusedStages,
            completedStages: completed.length,
            totalStages,
            currentStage: stage.artifactId,
            reusedCurrentArtifact: true
          });
          continue;
        }
        await context.heartbeat({ completedStages: completed.length, totalStages, currentStage: stage.artifactId });
        const child = await context.runChild(storyPipelineStageTaskDefinition({ projectId, runId, raw, stage }));
        completed.push(...(child.resultArtifactRefs || []));
        if (child.usage) usages.push(child.usage);
        await context.heartbeat({ completedStages: completed.length, totalStages, currentStage: stage.artifactId });
      }
      if (plan.signsSelection) {
        // 「只给角色设定」只有一个候选：由服务端直接签发选中记录，浏览器不再提交 variant:V1。
        // 已经是同一份内容、同一个上游时不重复提交，免得把已经展开的完整剧情无故标成过期。
        const run = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
        const variants = requireCurrentArtifact(run, "themeVariants");
        const candidates = variants.content?.variants;
        const candidate = Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
        if (!candidate || candidate.id !== STORY_ENTRY_VARIANT_ID) {
          throw new ProductionStateError(`剧情入口的故事候选必须恰好一个、id 为 ${STORY_ENTRY_VARIANT_ID}。`, {
            code: "STORY_ENTRY_CANDIDATE_INVALID",
            httpStatus: 409
          });
        }
        const variantsRef = lineageRef(variants.lineage);
        const selection = run.latestArtifacts?.[STORY_PIPELINE_SELECTION_ARTIFACT_ID];
        const selectionCurrent = selection?.lineage?.status === "current"
          && selection.lineage.contentDigest === contentDigest(candidate)
          && sameLineageRefs(selection.lineage.dependencies, [variantsRef]);
        if (selectionCurrent) {
          completed.push(lineageRef(selection.lineage));
        } else {
          // 不调 assertFrozenContextCurrent：它会核对父任务的全部目标，而 visualGuardrails 与
          // themeVariants 刚被本任务自己的子步骤提交过。提交口在 Run 锁内只核对 variant:V1 这一个
          // 目标与冻结依赖（storySource），并要求 themeVariants 仍是上面读到的这一版。
          const committed = await context.commitArtifact({
            artifactId: STORY_PIPELINE_SELECTION_ARTIFACT_ID,
            artifactType: "selectedVariant",
            content: candidate,
            dependencies: [variantsRef]
          });
          completed.push(lineageRef(committed.lineage));
        }
      }
      const finalRun = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
      return {
        resultArtifactRefs: completed,
        usage: mergeTaskUsages(usages),
        progress: { completedStages: totalStages, totalStages, reusedStages },
        compatibilityResult: Object.fromEntries(plan.targetArtifactIds.map((artifactId) => [
          artifactId,
          finalRun.latestArtifacts?.[artifactId]?.content
        ]))
      };
    }
  };
}

function storyPipelineStageTaskDefinition({ projectId, runId, raw, stage }) {
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: stage.taskKind,
    pool: "workflow",
    artifactId: stage.artifactId,
    artifactType: stage.artifactType,
    dependencyIds: stage.dependencyIds,
    modelStages: [stage.key],
    rawInput: raw,
    prepareInput: (run) => {
      const entry = trustedStoryEntryContext(run);
      const artifacts = currentArtifactContents(run, stage.dependencyIds);
      return {
        ...stage.buildInput(raw, entry, artifacts),
        __storyEntry: { storyMode: entry.storyMode, storySource: entry.storySource }
      };
    },
    invoke: (trustedInput, request) => {
      const { __storyEntry, ...input } = trustedInput;
      return stage.invoke(input, __storyEntry, request);
    }
  });
}

function standaloneVariantsTaskDefinition({ projectId, runId, input }) {
  const stage = DIRECTOR_PIPELINE_STAGES.at(-1);
  return pipelineStageTaskDefinition({ projectId, runId, raw: input, stage });
}

function fullStoryTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.variant?.id, "variantId");
  const artifactId = `fullStory:${variantId}`;
  const dependencyIds = [
    "referenceAnalysis",
    "sourceScriptReconstruction",
    "creativeBrief",
    "visualGuardrails",
    "themeVariants",
    `variant:${variantId}`
  ];
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "fullStory",
    pool: "workflow",
    artifactId,
    artifactType: "fullStory",
    dependencyIds,
    modelStages: ["fullStory"],
    rawInput: input,
    prepareInput: (run) => {
      if (isStoryEntryRun(run)) return storyEntryFullStoryInput(run, input, variantId);
      assertCompatibleArtifactCopies(run, input, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"],
        ["themeVariants", "themeVariants"],
        ["variant", `variant:${variantId}`]
      ]);
      assertCompatibleLineageCopy(run, `variant:${variantId}`, input.candidateBinding, "candidateBinding");
      const artifacts = currentArtifactContents(run, dependencyIds);
      const candidateLineage = requireCurrentArtifact(run, `variant:${variantId}`).lineage;
      return {
        referenceAnalysis: artifacts.referenceAnalysis,
        sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
        creativeBrief: artifacts.creativeBrief,
        visualGuardrails: artifacts.visualGuardrails,
        themeVariants: artifacts.themeVariants,
        variant: artifacts[`variant:${variantId}`],
        candidateBinding: lineageRef(candidateLineage),
        creatorProfile: input.creatorProfile,
        targetDurationSeconds: input.targetDurationSeconds,
        fullStorySchemaVersion: input.fullStorySchemaVersion,
        modelOverrides: input.modelOverrides
      };
    },
    // 剧情 Run 的依赖由 prepare 从 Run 元数据决定（storySource 链）；视频 Run 返回 null，
    // 仍按上面的 dependencyIds 冻结，行为不变。
    resolveDependencies: (trustedInput) => trustedInput.__storyEntry ? trustedInput.__dependencies : null,
    invoke: (trustedInput, request) => {
      if (trustedInput.__storyEntry) {
        const { __storyEntry, __dependencies: _dependencies, ...routeInput } = trustedInput;
        return __storyEntry.storyMode === STORY_MODE_FULL_TEXT
          ? storyEntrySourceFullStory(routeInput, { request, storyEntry: __storyEntry })
          : storyEntryFullStory(routeInput, { request, storyEntry: __storyEntry });
      }
      return routes["/api/full-story"](trustedInput, { request });
    }
  });
}

function animationPlanTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.variant?.id, "variantId");
  const artifactId = `animationPlan:${variantId}`;
  const dependencyIds = [
    "referenceAnalysis",
    "sourceScriptReconstruction",
    "creativeBrief",
    "visualGuardrails",
    `variant:${variantId}`,
    `fullStory:${variantId}`
  ];
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "animationPlan",
    pool: "workflow",
    artifactId,
    artifactType: "animationPlan",
    dependencyIds,
    modelStages: ["animationPlan", "staticFrameCompiler"],
    rawInput: input,
    createMediaNamespace: true,
    contentForArtifact: (value) => normalizeAnimationPlanTaskResponse(value).animationPlan,
    prepareInput: (run) => {
      if (isStoryEntryRun(run)) return storyEntryAnimationPlanInput(run, input, variantId);
      assertCompatibleArtifactCopies(run, input, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"],
        ["variant", `variant:${variantId}`],
        ["fullStory", `fullStory:${variantId}`]
      ]);
      const artifacts = currentArtifactContents(run, dependencyIds);
      return {
        referenceAnalysis: artifacts.referenceAnalysis,
        sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
        creativeBrief: artifacts.creativeBrief,
        visualGuardrails: artifacts.visualGuardrails,
        variant: artifacts[`variant:${variantId}`],
        fullStory: artifacts[`fullStory:${variantId}`],
        creatorProfile: input.creatorProfile,
        characterExpressionRules: input.characterExpressionRules,
        artStyle: input.artStyle,
        animationPlanMode: input.animationPlanMode || "direct_shot",
        animationPlanVersion: input.animationPlanVersion,
        targetAspectRatio: input.targetAspectRatio,
        backgroundMusicEnabled: input.backgroundMusicEnabled,
        videoPromptTarget: input.videoPromptTarget,
        includeCompilerMetadata: input.includeCompilerMetadata !== false,
        modelOverrides: input.modelOverrides
      };
    },
    resolveDependencies: (trustedInput) => trustedInput.__storyEntry ? trustedInput.__dependencies : null,
    invoke: (trustedInput, request) => {
      if (trustedInput.__storyEntry) {
        const { __storyEntry, __dependencies: _dependencies, ...routeInput } = trustedInput;
        return storyEntryAnimationPlan(routeInput, { request, storyEntry: __storyEntry });
      }
      return routes["/api/animation-plan"](trustedInput, { request });
    }
  });
}

function animationPromptRewriteTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.variant?.id, "variantId");
  const artifactId = `animationPlan:${variantId}`;
  const currentPlan = input.productionContext?.planArtifactId || artifactId;
  if (normalizeArtifactId(currentPlan) !== artifactId) {
    throw new ProductionStateError("提示词重写目标与 Variant 不一致", { code: "TASK_TARGET_MISMATCH", httpStatus: 409 });
  }
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "animationPromptRewrite",
    pool: "workflow",
    artifactId,
    artifactType: "animationPlan",
    dependencyIds: [],
    preserveTargetDependencies: true,
    modelStages: ["animationPlan"],
    rawInput: input,
    createMediaNamespace: true,
    contentForArtifact: (value) => normalizeAnimationPlanTaskResponse(value).animationPlan,
    prepareInput: (run) => {
      assertRunEntryMode(run, "video");
      const plan = requireCurrentArtifact(run, artifactId);
      assertCompatibleArtifactCopies(run, input, [
        ["creativeBrief", "creativeBrief"],
        ["variant", `variant:${variantId}`],
        ["fullStory", `fullStory:${variantId}`],
        ["visualGuardrails", "visualGuardrails"]
      ]);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: plan });
      const dependencies = plan.lineage.dependencies || [];
      const artifacts = currentArtifactContents(run);
      return {
        creatorProfile: input.creatorProfile,
        creativeBrief: artifacts.creativeBrief,
        variant: artifacts[`variant:${variantId}`],
        fullStory: artifacts[`fullStory:${variantId}`],
        visualGuardrails: artifacts.visualGuardrails,
        fixedCharacterBoundary: artifacts.visualGuardrails?.fixedCharacterBoundary,
        animationPlanMode: "direct_shot",
        videoPromptTarget: input.videoPromptTarget,
        productionContext: productionContextForLineage(projectId, runId, plan.lineage),
        modelOverrides: input.modelOverrides,
        __dependencies: dependencies
      };
    },
    resolveDependencies: (trustedInput) => trustedInput.__dependencies,
    invoke: (trustedInput, request) => {
      const { __dependencies, ...routeInput } = trustedInput;
      return routes["/api/animation-plan/video-prompts/rewrite"](routeInput, { request });
    }
  });
}

function characterReferenceRefineTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const roleIndex = requireNonNegativeInteger(input.roleIndex, "roleIndex");
  const artifactId = `animationPlan:${variantId}`;
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "characterReferenceRefine",
    pool: "media",
    artifactId,
    artifactType: "animationPlan",
    dependencyIds: [],
    modelStages: ["characterReference"],
    rawInput: input,
    createMediaNamespace: true,
    prepareInput: (run) => {
      // 剧情 Run 没有原片分析、脚本还原和创意简报；角色边界按剧情入口的摘要验，固定角色设定取 Run 元数据。
      // 粘贴完整故事的 Run 也没有候选，下面的 selectedVariant 取不到，精修提示词里那一行是 {}。
      const entry = isStoryEntryRun(run) ? trustedStoryEntryContext(run) : null;
      if (entry) assertNoVideoUpstreamCopies(input);
      if (isStorySourceDirectEntry(entry)) assertNoCandidateCopies(input);
      const planEntry = requireCurrentArtifact(run, artifactId);
      const plan = structuredClone(planEntry.content);
      const characterReference = plan.characterReferencePrompts?.[roleIndex];
      if (!characterReference) {
        throw new ProductionStateError("Animation Plan 中没有对应角色参考项", {
          code: "TASK_CHARACTER_REFERENCE_MISSING",
          httpStatus: 409
        });
      }
      assertCompatibleArtifactCopies(run, input, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"],
        ["selectedVariant", `variant:${variantId}`],
        ["fullStory", `fullStory:${variantId}`]
      ]);
      if (Object.prototype.hasOwnProperty.call(input, "characterReference")) {
        assertCompatibleValueCopy(
          stripReferenceImageData(characterReference),
          input.characterReference,
          "characterReference"
        );
      }
      if (Object.prototype.hasOwnProperty.call(input, "animationPlan")) {
        assertCompatibleValueCopy({
          title: plan.title,
          productionStrategy: plan.productionStrategy,
          visualBible: plan.visualBible
        }, input.animationPlan, "animationPlan partial copy");
      }
      const artifacts = currentArtifactContents(run);
      const { referenceImageDataUrl: _oldImage, ...safeCharacterReference } = characterReference;
      return {
        imageName: String(input.imageName || "reference.png"),
        imageDataUrl: input.imageDataUrl,
        characterReference: safeCharacterReference,
        creatorProfile: entry ? entry.creatorProfile : input.creatorProfile,
        referenceAnalysis: artifacts.referenceAnalysis,
        sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
        creativeBrief: artifacts.creativeBrief,
        visualGuardrails: artifacts.visualGuardrails,
        selectedVariant: artifacts[`variant:${variantId}`],
        fullStory: artifacts[`fullStory:${variantId}`],
        animationPlan: {
          title: plan.title,
          productionStrategy: plan.productionStrategy,
          visualBible: plan.visualBible
        },
        modelOverrides: input.modelOverrides,
        ...(entry ? { __storyEntry: { storyMode: entry.storyMode, storySource: entry.storySource } } : {}),
        __plan: plan,
        __roleIndex: roleIndex,
        __dependencies: planEntry.lineage.dependencies || []
      };
    },
    resolveDependencies: (trustedInput) => trustedInput.__dependencies,
    noticesForResult: (refined) => [
      refined?.referenceImageOverrideNotice,
      refined?.boundaryRestoreNotice,
      refined?.boundaryWarning
    ].filter(Boolean),
    contentForArtifact: (refined, trustedInput) => {
      const {
        boundaryWarning: _boundaryWarning,
        boundaryRestoreNotice: _boundaryRestoreNotice,
        referenceImageOverrideNotice: _referenceImageOverrideNotice,
        ...refinedFields
      } = refined || {};
      const updatedPlan = structuredClone(trustedInput.__plan);
      const previous = updatedPlan.characterReferencePrompts[trustedInput.__roleIndex];
      const updated = {
        ...previous,
        ...refinedFields,
        referenceImageAdded: true,
        referenceImageName: trustedInput.imageName,
        referenceImageDataUrl: trustedInput.imageDataUrl
      };
      updatedPlan.characterReferencePrompts[trustedInput.__roleIndex] = updated;
      syncShotCharacterReference(updatedPlan, previous, updated);
      return updatedPlan;
    },
    invoke: (trustedInput) => {
      const { __plan, __roleIndex, __dependencies, __storyEntry, ...routeInput } = trustedInput;
      if (__storyEntry) return workflow.refineCharacterReference(routeInput, { storyEntry: __storyEntry });
      return routes["/api/refine-character-reference"](routeInput);
    }
  });
}

function characterReferenceImagesTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const roleIndex = requireNonNegativeInteger(input.roleIndex, "roleIndex");
  const artifactId = `characterImages:${variantId}:${roleIndex}`;
  const planArtifactId = `animationPlan:${variantId}`;
  const imageModel = modelOverrideFor(input, "imageGeneration") || config.jimeng.model;
  return {
    projectId,
    runId,
    kind: "characterReferenceImages",
    pool: "media",
    targetArtifactIds: [artifactId],
    dependencyIds: [planArtifactId],
    modelSnapshot: { imageGeneration: { provider: "Jimeng", model: imageModel } },
    prepare: async ({ run }) => {
      const entry = isStoryEntryRun(run) ? trustedStoryEntryContext(run) : null;
      if (entry) assertNoVideoUpstreamCopies(input);
      if (isStorySourceDirectEntry(entry)) assertNoCandidateCopies(input);
      const planEntry = requireCurrentArtifact(run, planArtifactId);
      const characterReference = planEntry.content?.characterReferencePrompts?.[roleIndex];
      if (!characterReference) {
        throw new ProductionStateError("Animation Plan 中没有对应角色参考项", {
          code: "TASK_CHARACTER_REFERENCE_MISSING",
          httpStatus: 409
        });
      }
      assertCompatibleArtifactCopies(run, input, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"],
        ["selectedVariant", `variant:${variantId}`]
      ]);
      if (Object.prototype.hasOwnProperty.call(input, "characterReference")) {
        assertCompatibleValueCopy(
          stripReferenceImageData(characterReference),
          input.characterReference,
          "characterReference"
        );
      }
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: planEntry });
      const count = Math.max(1, Math.min(config.jimeng.maxImages, Math.round(Number(input.count) || 1)));
      const prompt = String(input.prompt || "").trim()
        || buildCharacterReferenceImagePrompt(characterReference, count, planEntry.content?.visualBible || null, {
          withReferenceImage: Boolean(input.referenceImageDataUrl),
          artStyle: planEntry.content?.productionStrategy?.artStyle
        });
      return {
        input: {
          count,
          prompt,
          promptDigest: contentDigest(prompt),
          referenceImageDataUrl: input.referenceImageDataUrl,
          characterReference: stripReferenceImageData(characterReference),
          creatorProfile: entry ? entry.creatorProfile : input.creatorProfile,
          ...(entry ? {} : {
            referenceAnalysis: requireCurrentArtifact(run, "referenceAnalysis").content,
            sourceScriptReconstruction: requireCurrentArtifact(run, "sourceScriptReconstruction").content,
            creativeBrief: requireCurrentArtifact(run, "creativeBrief").content
          }),
          visualGuardrails: requireCurrentArtifact(run, "visualGuardrails").content,
          // 出图时用不到候选内容；粘贴完整故事的 Run 没有候选，其余 Run 照旧要求它存在。
          ...(isStorySourceDirectEntry(entry) ? {} : {
            selectedVariant: requireCurrentArtifact(run, `variant:${variantId}`).content
          }),
          productionContext: productionContextForLineage(projectId, runId, planEntry.lineage),
          imageModel,
          artifactId,
          roleIndex
        },
        idempotencyInput: {
          count,
          promptDigest: contentDigest(prompt),
          referenceImageDigest: contentDigest(String(input.referenceImageDataUrl || "")),
          model: imageModel
        },
        targetArtifactIds: [artifactId],
        dependencyIds: [planArtifactId],
        modelSnapshot: { imageGeneration: { provider: "Jimeng", model: imageModel } },
        progress: { expectedCount: count, readyCount: 0, results: [], promptDigest: contentDigest(prompt) }
      };
    },
    execute: (trustedInput, context) => executeCharacterReferenceImagesTask(trustedInput, context)
  };
}

async function executeCharacterReferenceImagesTask(input, context) {
  if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
  const productionMedia = await resolveProductionMediaContext({ productionContext: input.productionContext }, { required: true });
  const visualGuardrails = verifyBoundaryForMedia(productionMedia, input);
  const boundaryWarnings = [
    characterReferenceBoundaryMismatch(input.characterReference, visualGuardrails),
    characterPromptBoundaryMismatch(input.prompt, visualGuardrails, {
      characterName: input.characterReference?.characterName || ""
    })
  ].filter(Boolean);
  const ready = [];
  const failed = [];
  const { usage } = await runWithUsageAccounting(
    () => runWithDurableTaskContext(context, () => jimengClient.generateImagesStream({
      referenceImageDataUrl: input.referenceImageDataUrl,
      characterReference: input.characterReference,
      count: input.count,
      prompt: input.prompt,
      model: input.imageModel
    }, async (event) => {
      if (event.type === "image_generation.partial_succeeded") {
        const image = await persistGeneratedImage(event, input.characterReference, productionMedia);
        const result = {
          type: "image",
          status: "ready",
          imageIndex: Number(event.image_index) || 0,
          characterName: input.characterReference?.characterName || "",
          model: event.model || input.imageModel,
          created: event.created || Math.round(Date.now() / 1000),
          size: event.size || image.size || "",
          url: image.url,
          filename: image.filename,
          prompt: input.prompt
        };
        ready.push(result);
        await context.heartbeat({
          expectedCount: input.count,
          readyCount: ready.length,
          failedCount: failed.length,
          results: [...ready, ...failed]
        });
        return;
      }
      if (event.type === "image_generation.partial_failed") {
        failed.push({
          type: "image-error",
          status: "error",
          imageIndex: Number(event.image_index) || 0,
          code: String(event.error?.code || ""),
          error: String(event.error?.message || "单张图片生成失败")
        });
        await context.heartbeat({
          expectedCount: input.count,
          readyCount: ready.length,
          failedCount: failed.length,
          results: [...ready, ...failed]
        });
        return;
      }
      if (event.error) {
        throw new ProductionStateError(String(event.error.message || "即梦图片生成失败"), {
          code: String(event.error.code || "CHARACTER_IMAGE_STREAM_FAILED"),
          category: "provider"
        });
      }
    })),
    { prices: config.modelPrices }
  );
  if (usage) await context.updateUsage(usage);
  if (!ready.length) {
    throw new ProductionStateError("生成结束，但没有返回可用图片。", {
      code: "CHARACTER_IMAGES_EMPTY",
      category: "provider"
    });
  }
  await context.assertFrozenContextCurrent();
  const content = {
    characterName: input.characterReference?.characterName || "",
    // Artifact 保持旧浏览器提交的精确业务形状；status 只属于 Task progress。
    results: ready.map(({ status: _status, ...result }) => result)
  };
  const committed = await context.commitArtifact({
    artifactId: input.artifactId,
    artifactType: "characterImages",
    content
  });
  return {
    compatibilityResult: {
      ...content,
      partialSuccess: ready.length < input.count,
      failedCount: failed.length,
      boundaryWarnings
    },
    usage,
    notices: boundaryWarnings,
    progress: {
      expectedCount: input.count,
      readyCount: ready.length,
      failedCount: failed.length,
      partialSuccess: ready.length < input.count,
      results: [...ready, ...failed]
    },
    resultArtifactRefs: [lineageRef(committed.lineage)]
  };
}

function shotVideoPromptTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId, "variantId");
  const shotId = safeIdentifier(input.shotId, "shotId");
  const planArtifactId = `animationPlan:${variantId}`;
  const target = shotVideoRequestSetting(input);
  if (!isShotVideoGenerationModeSupported(target.provider, "all_reference")) throw new InputError("新版单镜提示词需要受支持的全能参考视频模型");
  return artifactRouteTaskDefinition({
    projectId, runId, kind: "shotVideoPrompt", pool: "workflow",
    artifactId: storyboardPromptArtifactId(variantId, shotId), artifactType: "shotVideoPrompt",
    dependencyIds: [planArtifactId], modelStages: ["animationPlan"], rawInput: input,
    prepareInput: (run) => {
      const entry = requireCurrentArtifact(run, planArtifactId);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry });
      if (!isStoryboardPlan(entry.content)) throw new InputError("只有新版自主分镜需要单独生成镜头提示词");
      return { plan: structuredClone(entry.content), shotId, planDigest: entry.lineage.contentDigest,
        target: { provider: target.provider, model: target.model }, modelOverrides: input.modelOverrides };
    },
    invoke: (trustedInput) => animationPromptCapture.run({ route: "shotVideoPrompt", variantId, provider: "" }, () => workflow.createShotVideoPrompt(trustedInput))
  });
}

function shotVideoTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const shotId = safeIdentifier(input.shotId || input.shot?.shotId, "shotId");
  const artifactId = shotVideoArtifactIdFor(variantId, shotId);
  const planArtifactId = `animationPlan:${variantId}`;
  const setting = shotVideoRequestSetting(input);
  const resolution = shotVideoRequestResolution(input, setting);
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "shotVideo",
    pool: "media",
    artifactId,
    artifactType: "shotVideo",
    dependencyIds: [],
    modelStages: [],
    modelSnapshot: shotVideoModelSnapshot(setting, resolution),
    rawInput: input,
    prepareInput: (run) => {
      const planEntry = requireCurrentArtifact(run, planArtifactId);
      assertCompatibleArtifactCopies(run, input, [
        ["referenceAnalysis", "referenceAnalysis"],
        ["sourceScriptReconstruction", "sourceScriptReconstruction"],
        ["creativeBrief", "creativeBrief"],
        ["visualGuardrails", "visualGuardrails"]
      ]);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: planEntry });
      const dependencies = [lineageRef(planEntry.lineage)];
      if (input.continuityReferenceMode === "previous_shot_frames") {
        const planShots = planEntry.content?.shotPlan || [];
        const index = planShots.findIndex((shot) => String(shot.shotId) === shotId);
        if (index > 0) {
          const previousId = shotVideoArtifactIdFor(variantId, planShots[index - 1].shotId);
          dependencies.push(lineageRef(requireCurrentArtifact(run, previousId).lineage));
        }
      }
      return {
        ...input,
        selectedVariantId: variantId,
        shotId,
        productionContext: productionContextForLineage(projectId, runId, planEntry.lineage),
        __dependencies: dependencies
      };
    },
    resolveDependencies: (trustedInput) => trustedInput.__dependencies,
    contentForArtifact: (result) => {
      const videos = Array.isArray(result?.videos) && result.videos.length
        ? result.videos
        : result?.outputUrl ? [result] : [];
      const expected = Math.max(1, Math.min(4, Number(input.count) || 1));
      if (videos.length !== expected) {
        throw new ProductionStateError(`视频数量不足：请求 ${expected} 条，实际返回 ${videos.length} 条。`, {
          code: "SHOT_VIDEO_COUNT_MISMATCH"
        });
      }
      const selectedIndex = 0;
      return {
        status: "ready",
        result: {
          ...result,
          videos,
          selectedIndex,
          outputUrl: videos[selectedIndex]?.outputUrl || result.outputUrl || ""
        },
        selectedIndex
      };
    },
    invoke: (trustedInput) => {
      const { __dependencies, ...routeInput } = trustedInput;
      return routes["/api/generate-shot-video"](routeInput);
    }
  });
}

function shotVideoBatchTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const planArtifactId = `animationPlan:${variantId}`;
  const setting = shotVideoRequestSetting(input);
  if (!isShotVideoGenerationModeSupported(setting.provider, "all_reference")) {
    throw new ProductionStateError(
      `${setting.provider} 不支持全能参考批量生成；请将镜头视频供应商切换为 Seedance 或 MiniMax。`,
      { code: "SHOT_VIDEO_BATCH_PROVIDER_UNSUPPORTED" }
    );
  }
  const resolution = shotVideoRequestResolution(input, setting);
  return {
    projectId,
    runId,
    kind: "shotVideoBatch",
    pool: "media",
    modelSnapshot: shotVideoModelSnapshot(setting, resolution),
    prepare: async ({ run }) => {
      const planEntry = requireCurrentArtifact(run, planArtifactId);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: planEntry });
      const plan = planEntry.content || {};
      if (isStoryboardPlan(plan)) throw new InputError("新版分镜请逐镜生成并确认视频提示词，暂不支持批量生成视频");
      const shots = Array.isArray(plan.shotPlan) ? plan.shotPlan.filter(Boolean) : [];
      if (!shots.length) {
        throw new ProductionStateError("当前 Animation Plan 没有可批量生成的视频镜头", {
          code: "SHOT_VIDEO_BATCH_EMPTY"
        });
      }
      const shotIds = shots.map((shot) => safeIdentifier(shot.shotId, "shotId"));
      if (new Set(shotIds).size !== shotIds.length) {
        throw new ProductionStateError("Animation Plan 中存在重复 shotId，不能批量生成", {
          code: "SHOT_VIDEO_BATCH_DUPLICATE_SHOT"
        });
      }
      const targetArtifactIds = shotIds.map((shotId) => shotVideoArtifactIdFor(variantId, shotId));
      const isReady = (shot) => run.latestArtifacts?.[shotVideoArtifactIdFor(variantId, shot.shotId)]?.lineage?.status === "current";
      const items = createShotVideoBatchItems(shots, isReady);
      // 批前预检：逐个待办镜头核对参考素材会不会超出供应商上限，命中就一次列全并拒绝开工。
      //
      // 此前这里只检查首个待办镜头「至少有一项视觉参考」，于是第 7 镜的音频超限要等到
      // 前 6 镜都付过费之后才暴露——而且那种失败还会把整批带走（见 execute 里的隔离注释）。
      //
      // 抽帧张数按 happy path 投影：includePreviousShotFrames 打开时，除首镜外每一镜都会
      // 拿到上一镜的抽帧。**已知的保守性**：如果实际运行时上一镜失败了，那一镜不会有抽帧、
      // 图片数更少、本来可能通过，这里仍然会拦住它。这是「拒绝开工」这个选择自带的代价，
      // 不是缺陷——不接受这个代价就得改成「预标记 failed 后照常开工」。
      const includePreviousShotFrames = input.includePreviousShotFrames !== false;
      const referenceIssues = [];
      for (const [index, shot] of shots.entries()) {
        if (items[index]?.status === "completed") continue;
        referenceIssues.push(...shotVideoBatchReferenceIssues(shot, plan.characterReferencePrompts || [], {
          continuityFrameCount: includePreviousShotFrames && index > 0
            ? PREVIOUS_SHOT_REFERENCE_FRAME_COUNT
            : 0
        }));
      }
      if (referenceIssues.length) {
        throw new ProductionStateError(
          `以下镜头的参考素材超出全能参考上限，批量生成不会开始：\n${referenceIssues.map((issue) => `· ${issue.message}`).join("\n")}`,
          { code: referenceIssues[0].code }
        );
      }
      const artifacts = currentArtifactContents(run, [
        "referenceAnalysis",
        "sourceScriptReconstruction",
        "creativeBrief",
        "visualGuardrails"
      ]);
      return {
        input: {
          variantId,
          selectedVariantId: variantId,
          count: Math.max(1, Math.min(4, Number(input.count) || 1)),
          includePreviousShotFrames,
          // 用户这次选的分辨率（2026-10-10），只在选了时才有这个键；每一镜原样带下去。
          ...(Object.hasOwn(input, "resolution") ? { resolution: input.resolution } : {}),
          modelOverrides: plainObject(input.modelOverrides),
          productionContext: productionContextForLineage(projectId, runId, planEntry.lineage),
          plan: structuredClone(plan),
          shots: structuredClone(shots),
          creatorProfile: plainObject(run.metadata?.creatorProfile),
          referenceAnalysis: artifacts.referenceAnalysis,
          sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
          creativeBrief: artifacts.creativeBrief,
          visualGuardrails: artifacts.visualGuardrails
        },
        targetArtifactIds,
        frozenDependencies: [lineageRef(planEntry.lineage)],
        modelSnapshot: shotVideoModelSnapshot(setting, resolution),
        progress: {
          controlState: "running",
          totalShots: shots.length,
          completedShots: items.filter((item) => item.status === "completed").length,
          generatedShots: 0,
          failedShots: 0,
          currentShotId: "",
          items
        }
      };
    },
    execute: async (trusted, context) => {
      let task = await context.getTask();
      let items = Array.isArray(task.progress?.items)
        ? task.progress.items
        : createShotVideoBatchItems(trusted.shots);
      const resultArtifactRefs = [];
      let generatedShots = Number(task.progress?.generatedShots) || 0;
      let failedShots = Number(task.progress?.failedShots) || 0;
      let completedShots = items.filter((item) => item.status === "completed").length;
      for (let index = 0; index < trusted.shots.length; index += 1) {
        await waitForShotVideoBatchControl(context);
        const shot = trusted.shots[index];
        const shotId = String(shot.shotId);
        const artifactId = shotVideoArtifactIdFor(trusted.variantId, shotId);
        const snapshot = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
        const existing = snapshot.latestArtifacts?.[artifactId];
        if (existing?.lineage?.status === "current") {
          if (!resultArtifactRefs.some((item) => item.artifactId === artifactId)) {
            resultArtifactRefs.push(lineageRef(existing.lineage));
          }
          items = updateShotVideoBatchItem(items, shotId, {
            status: "completed",
            message: items[index]?.status === "completed" ? "已存在当前视频结果" : "视频已生成"
          });
          completedShots = items.filter((item) => item.status === "completed").length;
          await context.heartbeat({ completedShots, generatedShots, failedShots, currentShotId: "", items });
          continue;
        }
        const previousArtifactId = index > 0
          ? shotVideoArtifactIdFor(trusted.variantId, trusted.shots[index - 1].shotId)
          : "";
        const previousReady = previousArtifactId
          && snapshot.latestArtifacts?.[previousArtifactId]?.lineage?.status === "current";
        // 单镜参考素材问题必须只失败这一镜。这行原本在下面那个 try 之外，抛出的
        // ProductionStateError 会直接冒出 execute，把整批判 failed——而同一类问题发生在
        // runChild 里只会标记该镜 failed 然后继续。同一种故障两种后果，这里补齐。
        // 批前预检正常情况下已经拦住了这些，剩下的是冻结输入与预检投影不一致的兜底。
        let referenceAssets;
        try {
          referenceAssets = buildShotVideoBatchReferenceAssets(
            shot,
            trusted.plan.characterReferencePrompts || []
          );
        } catch (error) {
          if (isFatalShotVideoBatchError(error)) throw error;
          failedShots += 1;
          items = updateShotVideoBatchItem(items, shotId, {
            status: "failed",
            message: error.message || "参考素材不符合全能参考上限"
          });
          await context.heartbeat({ completedShots, generatedShots, failedShots, currentShotId: "", items });
          continue;
        }
        const hasVisualReference = referenceAssets.some((asset) => ["image", "video"].includes(asset.mediaType));
        if (!hasVisualReference && !(trusted.includePreviousShotFrames && previousReady)) {
          failedShots += 1;
          items = updateShotVideoBatchItem(items, shotId, {
            status: "failed",
            message: "缺少角色参考图或可复用的上一镜视频"
          });
          await context.heartbeat({ completedShots, generatedShots, failedShots, currentShotId: "", items });
          continue;
        }
        items = updateShotVideoBatchItem(items, shotId, {
          status: "running",
          message: `正在用 ${setting.provider} ${setting.model} 生成`
        });
        await context.heartbeat({
          completedShots,
          generatedShots,
          failedShots,
          currentShotId: shotId,
          currentShotIndex: index,
          items
        });
        try {
          const child = await context.runChild(shotVideoTaskDefinition({
            projectId,
            runId,
            input: {
              creatorProfile: trusted.creatorProfile,
              referenceAnalysis: trusted.referenceAnalysis,
              sourceScriptReconstruction: trusted.sourceScriptReconstruction,
              creativeBrief: trusted.creativeBrief,
              visualGuardrails: trusted.visualGuardrails,
              variantId: trusted.variantId,
              selectedVariantId: trusted.variantId,
              count: trusted.count,
              generationMode: "all_reference",
              continuityReferenceMode: shouldIncludePreviousShotFrames({
                requested: trusted.includePreviousShotFrames,
                available: previousReady
              })
                ? SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
                : SHOT_VIDEO_CONTINUITY_NONE,
              aspectRatio: requireShotVideoBatchAspectRatio(trusted.plan),
              animationPromptSchemaVersion: trusted.plan.promptSchemaVersion || "",
              shotId,
              referenceAssets,
              productionContext: trusted.productionContext,
              ...(Object.hasOwn(trusted, "resolution") ? { resolution: trusted.resolution } : {}),
              modelOverrides: trusted.modelOverrides
            }
          }));
          resultArtifactRefs.push(...(child.resultArtifactRefs || []));
          generatedShots += 1;
          completedShots += 1;
          items = updateShotVideoBatchItem(items, shotId, {
            status: "completed",
            message: `已生成 ${trusted.count} 条视频候选`,
            taskId: child.taskId
          });
        } catch (error) {
          if (isFatalShotVideoBatchError(error)) throw error;
          failedShots += 1;
          items = updateShotVideoBatchItem(items, shotId, {
            status: "failed",
            message: error.message || "视频生成失败"
          });
        }
        await context.heartbeat({
          completedShots,
          generatedShots,
          failedShots,
          currentShotId: "",
          currentShotIndex: index,
          items
        });
      }
      task = await context.getTask();
      return {
        resultArtifactRefs,
        usage: task.usage || null,
        progress: {
          controlState: "running",
          batchStatus: failedShots ? "partial" : "completed",
          totalShots: trusted.shots.length,
          completedShots,
          generatedShots,
          failedShots,
          currentShotId: "",
          items
        }
      };
    }
  };
}

function isFatalShotVideoBatchError(error) {
  return [
    "SHOT_VIDEO_BATCH_TERMINATED",
    "TASK_OWNERSHIP_LOST",
    "TASK_FROZEN_CONTEXT_CONFLICT",
    "ARTIFACT_REVISION_CONFLICT",
    "ARTIFACT_DEPENDENCY_STALE",
    "MEDIA_PLAN_ASPECT_RATIO_MISMATCH",
    "SHOT_VIDEO_CURRENT_SHOT_NOT_IN_PLAN",
    "SHOT_VIDEO_PLAN_SCHEMA_MISMATCH",
    "SHOT_VIDEO_PLAN_VARIANT_MISMATCH"
  ].includes(error?.code);
}

function shotFrameTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const shotId = safeIdentifier(input.shotId || input.shot?.shotId, "shotId");
  const frameKind = input.frameKind === "end" ? "end" : "start";
  const artifactId = `shotFrame:${variantId}:${shotId}:${frameKind}`;
  const planArtifactId = `animationPlan:${variantId}`;
  const imageModel = modelOverrideFor(input, "imageGeneration") || config.jimeng.model;
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "shotFrameImage",
    pool: "media",
    artifactId,
    artifactType: "shotFrame",
    dependencyIds: [planArtifactId],
    modelStages: [],
    rawInput: input,
    prepareInput: (run) => {
      assertRunEntryMode(run, "video");
      const planEntry = requireCurrentArtifact(run, planArtifactId);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: planEntry });
      const authoritativeShot = (planEntry.content?.shotPlan || [])
        .find((shot) => String(shot.shotId || "") === shotId);
      if (!authoritativeShot) {
        throw new ProductionStateError("当前 Animation Plan 中没有目标 shot", {
          code: "MEDIA_PLAN_SHOT_MISSING",
          httpStatus: 409
        });
      }
      return {
        ...input,
        selectedVariantId: variantId,
        frameKind,
        shot: structuredClone(authoritativeShot),
        visualBible: structuredClone(planEntry.content?.visualBible || {}),
        animationPromptSchemaVersion: String(planEntry.content?.promptSchemaVersion || ""),
        productionContext: productionContextForLineage(projectId, runId, planEntry.lineage)
      };
    },
    contentForArtifact: async (result) => {
      const images = Array.isArray(result.images) && result.images.length ? result.images : [result];
      const persisted = await Promise.all(images.map(async (image) => ({
        ...image,
        dataUrl: await generatedPublicUrlToDataUrl(image.url)
      })));
      const normalized = {
        ...result,
        images: persisted,
        selectedIndex: -1,
        url: "",
        dataUrl: ""
      };
      return {
        status: input.autoSelectFirst ? "ready" : "pending",
        frameKind,
        result: normalized,
        selectedIndex: input.autoSelectFirst ? 0 : -1,
        message: `已生成 ${persisted.length} 张候选图，请选择一张添加到镜头。`
      };
    },
    invoke: (trustedInput) => generateShotFrameImage(trustedInput),
    modelSnapshot: { imageGeneration: { provider: "Jimeng", model: imageModel } }
  });
}

function artifactRouteTaskDefinition({
  projectId,
  runId,
  kind,
  pool,
  artifactId,
  artifactType,
  dependencyIds,
  modelStages,
  rawInput,
  prepareInput,
  invoke,
  contentForArtifact = (value) => value,
  createMediaNamespace = false,
  resolveDependencies = null,
  modelSnapshot = null,
  noticesForResult = null
}) {
  const frozenModelSnapshot = modelSnapshot || modelSnapshotFor(rawInput, modelStages);
  const frozenInputDigest = contentDigest(nonArtifactInputDigestSource(rawInput));
  return {
    projectId,
    runId,
    kind,
    pool,
    targetArtifactIds: [artifactId],
    dependencyIds,
    modelSnapshot: frozenModelSnapshot,
    prepare: async ({ run }) => {
      const trustedInput = await prepareInput(run);
      const resolvedDependencies = resolveDependencies ? resolveDependencies(trustedInput, run) : null;
      return {
        input: trustedInput,
        inputDigest: frozenInputDigest,
        targetArtifactIds: [artifactId],
        ...(resolvedDependencies ? { frozenDependencies: resolvedDependencies } : { dependencyIds }),
        modelSnapshot: frozenModelSnapshot
      };
    },
    execute: (trustedInput, context) => executeArtifactRouteTask({
      trustedInput,
      context,
      artifactId,
      artifactType,
      invoke,
      contentForArtifact,
      createMediaNamespace,
      dependencies: resolveDependencies ? resolveDependencies(trustedInput) : null,
      noticesForResult
    })
  };
}

async function executeArtifactRouteTask({
  trustedInput,
  context,
  artifactId,
  artifactType,
  invoke,
  contentForArtifact,
  createMediaNamespace,
  dependencies,
  noticesForResult
}) {
  await context.assertFrozenContextCurrent();
  const task = await context.getTask();
  const headers = productionRequestHeaders({
    projectId: task.projectId,
    runId: task.runId,
    artifactId,
    requestId: task.requestId,
    expectedCurrentRevision: task.targetExpectedRevisions?.[artifactId] || null
  });
  const { result, usage } = await runWithUsageAccounting(
    () => runWithDurableTaskContext(context, () => invoke(trustedInput, { headers })),
    { prices: config.modelPrices, onUsage: context.captureUsage }
  );
  if (usage) await context.updateUsage(usage);
  await context.assertFrozenContextCurrent();
  const committed = await context.commitArtifact({
    artifactId,
    artifactType,
    content: await contentForArtifact(result, trustedInput),
    ...(dependencies ? { dependencies } : {}),
    createMediaNamespace
  });
  return {
    compatibilityResult: result,
    usage,
    notices: noticesForResult ? noticesForResult(result, trustedInput) : [],
    resultArtifactRefs: [lineageRef(committed.lineage)],
    progress: { committedArtifactId: artifactId }
  };
}

function pipelineMediaInput(raw = {}) {
  return {
    frames: raw.frames,
    ...(raw.video ? { video: raw.video } : {}),
    metadata: raw.metadata,
    transcript: raw.transcript,
    creatorProfile: raw.creatorProfile,
    modelOverrides: raw.modelOverrides
  };
}

function assertPipelineMediaAvailable(stage, raw) {
  if (!["analysis", "reconstruction", "visualGuardrails"].includes(stage.key)) return;
  if (Array.isArray(raw.frames) && raw.frames.length >= 3) return;
  throw new ProductionStateError("继续该阶段需要当前参考视频素材，请刷新页面恢复视频，或重新上传同一原文件。", {
    code: "TASK_SOURCE_MEDIA_REQUIRED",
    httpStatus: 409,
    details: [{ sourceVideoDigest: String(raw.sourceVideoDigest || "") }]
  });
}

function currentArtifactContents(run, requiredIds = []) {
  for (const artifactId of requiredIds) requireCurrentArtifact(run, artifactId);
  return Object.fromEntries(Object.entries(run.latestArtifacts || {})
    .filter(([, entry]) => entry?.lineage?.status === "current")
    .map(([artifactId, entry]) => [artifactId, structuredClone(entry.content)]));
}

function requireCurrentArtifact(run, artifactId) {
  const safeArtifactId = normalizeArtifactId(artifactId);
  const entry = run.latestArtifacts?.[safeArtifactId];
  if (!entry?.lineage || entry.lineage.status !== "current") {
    throw new ProductionStateError(`缺少 current Artifact：${safeArtifactId}`, {
      code: "TASK_DEPENDENCY_MISSING",
      httpStatus: 409
    });
  }
  return entry;
}

function assertCompatibleArtifactCopies(run, input, mappings = []) {
  for (const [inputKey, artifactId] of mappings) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, inputKey)) continue;
    const entry = requireCurrentArtifact(run, artifactId);
    assertCompatibleValueCopy(entry.content, input[inputKey], inputKey, {
      artifactId: entry.lineage.artifactId,
      expectedDigest: entry.lineage.contentDigest
    });
  }
}

function assertCompatibleValueCopy(expected, actual, label, details = {}) {
  const expectedDigest = details.expectedDigest || contentDigest(expected);
  const actualDigest = contentDigest(actual);
  if (actualDigest === expectedDigest) return true;
  throw new ProductionStateError(`浏览器携带的 ${label} 与服务端 current Artifact 不一致。`, {
    code: "TASK_BROWSER_ARTIFACT_MISMATCH",
    httpStatus: 409,
    details: [{
      ...(details.artifactId ? { artifactId: details.artifactId } : {}),
      expectedDigest,
      actualDigest
    }]
  });
}

function assertCompatibleLineageCopy(run, artifactId, copy, label) {
  if (copy === undefined || copy === null) return true;
  const entry = requireCurrentArtifact(run, artifactId);
  const expected = lineageRef(entry.lineage);
  const actual = {
    artifactId: String(copy.artifactId || ""),
    revision: String(copy.revision || ""),
    contentDigest: String(copy.contentDigest || "").trim().toLowerCase()
  };
  if (
    actual.artifactId === expected.artifactId
    && actual.revision === expected.revision
    && actual.contentDigest === expected.contentDigest
  ) return true;
  throw new ProductionStateError(`浏览器携带的 ${label} 与服务端 current lineage 不一致。`, {
    code: "TASK_BROWSER_ARTIFACT_MISMATCH",
    httpStatus: 409,
    details: [{ artifactId: expected.artifactId, expectedRevision: expected.revision, actualRevision: actual.revision || null }]
  });
}

function assertCompatibleProductionContext(context, { projectId, runId, entry }) {
  if (context === undefined || context === null) return true;
  const expected = productionContextForLineage(projectId, runId, entry.lineage);
  const actual = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  if (
    String(actual.projectId || "") === expected.projectId
    && String(actual.runId || "") === expected.runId
    && String(actual.planArtifactId || "") === expected.planArtifactId
    && String(actual.planRevision || "") === expected.planRevision
    && String(actual.planDigest || "").trim().toLowerCase() === expected.planDigest
    && String(actual.mediaNamespace || "") === String(expected.mediaNamespace || "")
  ) return true;
  throw new ProductionStateError("浏览器携带的 Animation Plan productionContext 已不是服务端 current lineage。", {
    code: "TASK_BROWSER_ARTIFACT_MISMATCH",
    httpStatus: 409,
    details: [{
      artifactId: expected.planArtifactId,
      expectedRevision: expected.planRevision,
      actualRevision: String(actual.planRevision || "") || null
    }]
  });
}

function modelSnapshotFor(input, stages = []) {
  return Object.fromEntries(stages.map((stage) => {
    const settings = workflow.resolveStage(stage, input);
    return [stage, {
      provider: settings.provider,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      requestTimeoutMs: settings.requestTimeoutMs
    }];
  }));
}

function nonArtifactInputDigestSource(input = {}) {
  const copy = structuredClone(input);
  for (const key of [
    "referenceAnalysis",
    "sourceScriptReconstruction",
    "creativeBrief",
    "visualGuardrails",
    "themeVariants",
    "variant",
    "fullStory",
    "animationPlan",
    "candidateBinding",
    "productionContext"
  ]) delete copy[key];
  return copy;
}

function normalizeAnimationPlanTaskResponse(value) {
  if (value?.animationPlan && typeof value.animationPlan === "object") {
    return { animationPlan: value.animationPlan, metadata: value.metadata || null };
  }
  return { animationPlan: value, metadata: null };
}

function productionContextForLineage(projectId, runId, lineage) {
  return {
    projectId,
    runId,
    planArtifactId: lineage.artifactId,
    planRevision: lineage.revision,
    planDigest: lineage.contentDigest,
    mediaNamespace: lineage.mediaNamespace
  };
}

function mergeTaskUsages(usages = []) {
  const list = usages.filter(Boolean);
  if (!list.length) return null;
  const byModel = new Map();
  const result = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costCny: 0,
    costKnown: true,
    byModel: []
  };
  for (const usage of list) {
    result.calls += Number(usage.calls) || 0;
    result.promptTokens += Number(usage.promptTokens) || 0;
    result.completionTokens += Number(usage.completionTokens) || 0;
    result.totalTokens += Number(usage.totalTokens) || 0;
    if (usage.costCny === null || usage.costCny === undefined) result.costKnown = false;
    else result.costCny += Number(usage.costCny) || 0;
    for (const item of usage.byModel || []) {
      const key = `${item.provider || ""}\u0000${item.model || ""}`;
      const entry = byModel.get(key) || { ...item, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costCny: 0 };
      entry.calls += Number(item.calls) || 0;
      entry.promptTokens += Number(item.promptTokens) || 0;
      entry.completionTokens += Number(item.completionTokens) || 0;
      entry.totalTokens += Number(item.totalTokens) || 0;
      if (item.costCny === null || item.costCny === undefined) entry.costCny = null;
      else if (entry.costCny !== null) entry.costCny += Number(item.costCny) || 0;
      byModel.set(key, entry);
    }
  }
  result.costCny = result.costKnown ? Math.round(result.costCny * 100) / 100 : null;
  result.byModel = [...byModel.values()].map((item) => ({
    ...item,
    costCny: item.costCny === null ? null : Math.round(item.costCny * 100) / 100
  }));
  return result;
}

function legacyTaskRequest(pathname, body, request) {
  const coordinates = productionCoordinates(request, body);
  if (!coordinates) return null;
  const kindByPath = {
    "/api/analyze": "analyze",
    "/api/reconstruct": "reconstruct",
    "/api/brief": "brief",
    "/api/visual-guardrails": "visualGuardrails",
    "/api/variants": "variants",
    "/api/full-story": "fullStory",
    "/api/animation-plan": "animationPlan",
    "/api/animation-plan/video-prompts/rewrite": "animationPromptRewrite",
    "/api/refine-character-reference": "characterReferenceRefine",
    "/api/generate-shot-video": "shotVideo",
    "/api/generate-shot-frame-image": "shotFrameImage"
  };
  const kind = kindByPath[pathname];
  if (!kind) return null;
  return {
    ...coordinates,
    kind,
    input: {
      ...body,
      ...(body.variant?.id ? { variantId: body.variant.id } : {}),
      ...(body.selectedVariantId ? { variantId: body.selectedVariantId } : {})
    }
  };
}

function productionCoordinates(request, body = {}) {
  const projectId = String(request?.headers?.["x-mimo-project-id"] || body.productionContext?.projectId || "").trim();
  const runId = String(request?.headers?.["x-mimo-run-id"] || body.productionContext?.runId || "").trim();
  if (!projectId || !runId) return null;
  return { projectId, runId };
}

function compatibilityProductionRequestToken(request) {
  const artifactId = String(request?.headers?.[PRODUCTION_REQUEST_HEADER_NAMES.artifactId] || "").trim();
  const requestId = String(request?.headers?.[PRODUCTION_REQUEST_HEADER_NAMES.requestId] || "").trim();
  if (!artifactId || !requestId) return null;
  return {
    artifactId,
    requestId,
    expectedCurrentRevision: String(
      request?.headers?.[PRODUCTION_REQUEST_HEADER_NAMES.expectedCurrentRevision] || ""
    ).trim() || null
  };
}

async function runLegacyDurableTask(pathname, body, request) {
  const taskRequest = legacyTaskRequest(pathname, body, request);
  if (!taskRequest) return null;
  const productionRequestToken = compatibilityProductionRequestToken(request);
  const created = await durableTaskManager.createTask({
    ...taskDefinitionForRequest(taskRequest),
    ...(productionRequestToken ? { productionRequestToken } : {}),
    requestBytes: Buffer.byteLength(JSON.stringify(body || {}), "utf8")
  });
  const outcome = await durableTaskManager.waitForTask({
    projectId: created.task.projectId,
    runId: created.task.runId,
    taskId: created.task.taskId
  });
  if (outcome.task.status !== "completed") throw taskTerminalError(outcome.task);
  let result = outcome.compatibilityResult;
  if (result === undefined && outcome.task.resultArtifactRefs?.length === 1) {
    const run = await productionStateStore.loadRun({
      projectId: outcome.task.projectId,
      runId: outcome.task.runId,
      includeContent: true
    });
    result = run.latestArtifacts?.[outcome.task.resultArtifactRefs[0].artifactId]?.content;
  }
  return { result, usage: outcome.task.usage || null, task: outcome.task };
}

function taskTerminalError(task) {
  const error = new ProductionStateError(task.error?.message || `任务以 ${task.status} 结束`, {
    code: task.error?.code || `TASK_${String(task.status || "failed").toUpperCase()}`,
    httpStatus: task.status === "conflicted" ? 409 : 500,
    details: task.error?.details || []
  });
  error.category = task.error?.category || "task";
  return error;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (await handleBrowserWorkspace(request, response, url)) return;
    if (await handleProductionPackageDownload(request, response, url)) return;
    if (request.method === "GET" && url.pathname === "/api/health") {
      const [providerHealth, stageHealth, imageProvider] = await Promise.all([
        healthByProvider(clients, config),
        healthByStage(clients, stageDefaults),
        jimengClient ? jimengClient.checkHealth() : { reachable: false, modelAvailable: false, status: 0 }
      ]);
      const analysisStage = stageDefaults.analysis || {};
      const storyStage = stageDefaults.fullStory || {};
      const animationStage = stageDefaults.animationPlan || {};
      const analysisHealth = stageHealth.analysis || { reachable: false, modelAvailable: false, status: 0 };
      const storyHealth = stageHealth.fullStory || { reachable: false, modelAvailable: false, status: 0 };
      const animationHealth = stageHealth.animationPlan || { reachable: false, modelAvailable: false, status: 0 };
      const analysisMedia = mediaSettingsForProvider(analysisStage.provider, config);
      const shotVideoStage = modelStages.shotVideo || {};
      const shotVideoHealth = providerHealth[shotVideoStage.provider] || {};
      const fullStageHealth = {
        ...stageHealth,
        imageGeneration: compactHealth(imageProvider),
        shotVideo: {
          reachable: Boolean(shotVideoHealth.reachable),
          modelAvailable: Boolean(
            shotVideoHealth.modelAvailable
            && isShotVideoModelAllowed(shotVideoStage.provider, shotVideoStage.model)
          ),
          status: Number(shotVideoHealth.status) || 0
        }
      };
      return json(response, 200, {
        ok: true,
        mode: workflow.mode,
        networkProxy: systemProxy.status(),
        model: analysisStage.model,
        analysisModel: analysisStage.model,
        storyModel: storyStage.model,
        animationModel: animationStage.model,
        baseProvider: analysisStage.provider,
        analysisProvider: analysisStage.provider,
        storyProvider: storyStage.provider,
        animationProvider: animationStage.provider,
        providerConfigured: Boolean(clients[analysisStage.provider]),
        providerReachable: analysisHealth.reachable,
        modelAvailable: analysisHealth.modelAvailable,
        analysisModelAvailable: analysisHealth.modelAvailable,
        storyModelAvailable: storyHealth.modelAvailable,
        animationModelAvailable: animationHealth.modelAvailable,
        analysisProviderReachable: analysisHealth.reachable,
        storyProviderReachable: storyHealth.reachable,
        animationProviderReachable: animationHealth.reachable,
        providers: providerHealth,
        modelStages,
        stageHealth: fullStageHealth,
        imageProvider: "Jimeng",
        imageModel: config.jimeng.model,
        imageProviderConfigured: config.jimeng.enabled,
        imageProviderReachable: imageProvider.reachable,
        imageModelAvailable: imageProvider.modelAvailable,
        mediaMode: analysisMedia.mediaMode,
        nativeVideoMaxBytes: analysisMedia.nativeVideoMaxBytes,
        productionState: {
          schemaVersion: "1.0",
          persistent: true
        },
        timeouts: {
          serverRequestMs: config.serverRequestTimeoutMs,
          qwenGenerationMs: config.qwen.requestTimeoutMs,
          mimoGenerationMs: config.mimo.requestTimeoutMs,
          deepseekGenerationMs: config.deepseek.requestTimeoutMs,
          staticFrameCompilerMs: config.staticFrameCompiler.requestTimeoutMs
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const tasks = await durableTaskStore.listTasks({
        projectId: url.searchParams.get("projectId"),
        runId: url.searchParams.get("runId"),
        activeOnly: url.searchParams.get("active") === "1"
      });
      return json(response, 200, { ok: true, mode: workflow.mode, tasks, result: tasks });
    }
    const taskPath = /^\/api\/tasks\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && taskPath) {
      const task = await durableTaskStore.getTask({
        projectId: url.searchParams.get("projectId"),
        runId: url.searchParams.get("runId"),
        taskId: decodeURIComponent(taskPath[1])
      });
      return json(response, 200, { ok: true, mode: workflow.mode, task, result: task });
    }
    if (request.method === "POST" && url.pathname === "/api/tasks/create") {
      const body = await readJson(request, { limit: 70 * 1024 * 1024 });
      const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
      const limit = taskRequestBodyLimit(body.kind);
      if (requestBytes > limit) throw new InputError("任务请求过大，请减少参考素材数量或尺寸");
      const created = await durableTaskManager.createTask({
        ...taskDefinitionForRequest(body),
        requestBytes
      });
      return json(response, 202, {
        ok: true,
        mode: workflow.mode,
        task: created.task,
        reused: created.reused,
        result: created
      });
    }
    const releasePath = /^\/api\/tasks\/([^/]+)\/release$/u.exec(url.pathname);
    if (request.method === "POST" && releasePath) {
      const body = await readJson(request);
      const task = await durableTaskManager.releaseTask({
        projectId: body.projectId,
        runId: body.runId,
        taskId: decodeURIComponent(releasePath[1])
      });
      return json(response, 200, { ok: true, mode: workflow.mode, task, result: task });
    }
    const controlPath = /^\/api\/tasks\/([^/]+)\/control$/u.exec(url.pathname);
    if (request.method === "POST" && controlPath) {
      const body = await readJson(request);
      const task = await durableTaskManager.controlTask({
        projectId: body.projectId,
        runId: body.runId,
        taskId: decodeURIComponent(controlPath[1]),
        action: body.action
      });
      return json(response, 200, { ok: true, mode: workflow.mode, task, result: task });
    }
    if (request.method === "POST" && url.pathname === "/api/generate-character-reference-images") {
      return streamCharacterReferenceImages(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/generate-shot-frame-image") {
      const body = await readJson(request);
      const durable = await runLegacyDurableTask(url.pathname, body, request);
      if (durable) {
        return json(response, 200, { ok: true, mode: workflow.mode, result: durable.result, usage: durable.usage });
      }
      const result = await generateShotFrameImage(body);
      return json(response, 200, { ok: true, mode: workflow.mode, result });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/production/")) {
      const body = await readJson(request, { limit: 70 * 1024 * 1024 });
      const result = await handleProductionStateRequest(url.pathname, body);
      return json(response, 200, { ok: true, mode: workflow.mode, result });
    }
    if (request.method === "POST"
      && [CAST_PROPOSAL_API_PATH, CAST_CONFIRMATION_API_PATH].includes(url.pathname)) {
      const body = await readJson(request);
      const outcome = handleCastApiRequest({
        enabled: config.fullStoryV2Pipeline.enabled,
        path: url.pathname,
        body,
        service: castOrchestration
      });
      return json(response, outcome.httpStatus, {
        ok: true,
        mode: workflow.mode,
        result: outcome.result
      });
    }
    if (request.method === "POST" && routes[url.pathname]) {
      const body = await readJson(request, {
        limit: url.pathname === "/api/generate-shot-video" ? 70 * 1024 * 1024 : undefined
      });
      const durable = await runLegacyDurableTask(url.pathname, body, request);
      if (durable) {
        return json(response, 200, {
          ok: true,
          mode: workflow.mode,
          result: durable.result,
          usage: durable.usage
        });
      }
      // 没有 Production Run 的旧测试/诊断调用保持原同步执行；浏览器主路径均由 Durable Task 接管。
      const { result, usage } = await runWithUsageAccounting(
        () => routes[url.pathname](body, { request }),
        { prices: config.modelPrices }
      );
      return json(response, 200, { ok: true, mode: workflow.mode, result, usage });
    }
    if (request.method === "GET" || request.method === "HEAD") return serveStatic(url.pathname, response, request.method === "HEAD");
    return json(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    const publicError = error instanceof BrowserWorkspaceError
      ? new ProductionStateError(error.message, { code: error.code, httpStatus: error.httpStatus })
      : error;
    const serialized = serializeServerError(publicError, { attemptStore });
    if (serialized.log) console.error(serialized.log);
    // 失败前已经花掉的 token 照样如实回报，挂在信封上不进 body 的任何业务字段。
    const usage = readModelUsageFromError(error);
    return json(response, serialized.status, usage ? { ...serialized.body, usage } : serialized.body);
  }
});

server.requestTimeout = config.serverRequestTimeoutMs;

await durableTaskManager.reconcileInterruptedTasks();
// Startup only: requests cannot be between create/import and attach while we
// remove owned Runs orphaned by a previous process exit at that boundary.
try {
  await browserWorkspaceCleanup.reconcileOrphanedRuns({
    hasWorkspaceRunReference: async ({ projectId, runId, workspaceId }) => {
      let session;
      try { session = await browserWorkspaceStore.read(workspaceId); }
      catch (error) {
        if (error.code === "BROWSER_WORKSPACE_NOT_FOUND") return false;
        throw error;
      }
      return [session.run, ...session.pendingCleanup.map((item) => item.run)]
        .some((run) => run?.projectId === projectId && run?.runId === runId);
    }
  });
} catch {
  console.warn("部分页面孤立数据暂未清理完成，下次启动将重试。");
}
async function sweepBrowserWorkspaces() {
  for (const sweep of [() => browserWorkspaceStore.sweepExpired(), () => browserWorkspaceCleanup.sweepPending()]) {
    try { await sweep(); }
    catch { console.warn("页面工作数据暂未清理完成，将自动重试。"); }
  }
}
await sweepBrowserWorkspaces();
let browserWorkspaceSweepRunning = false;
const browserWorkspaceSweep = setInterval(async () => {
  if (browserWorkspaceSweepRunning) return;
  browserWorkspaceSweepRunning = true;
  try { await sweepBrowserWorkspaces(); }
  finally { browserWorkspaceSweepRunning = false; }
}, 5_000);
browserWorkspaceSweep.unref();
server.on("close", () => clearInterval(browserWorkspaceSweep));
server.on("close", () => { void systemProxy.close(); });

server.listen(config.port, () => {
  console.log(`AI 短视频导演：http://localhost:${config.port}`);
  console.log(`Build identity：gitCommit=${buildIdentity.gitCommit} buildId=${buildIdentity.buildId}`);
  console.log(`Production Lineage 状态目录：${config.workflowRuntime.productionStateDirectory}`);
  // 只报来源，永远不打印密钥本身。
  console.log(`签名密钥来源：Grounding ${groundingKeyEntry.source} / 全局角色边界 ${characterBoundaryKeyEntry.source}`);
    console.log(`局部纠错 Debug 目录：${partialRepairDebugWriter.outputRoot}`);
    if (fullModelOutputLogWriter.enabled) {
      console.log(`Full Story 全量模型输出日志已开启：${fullModelOutputLogWriter.outputRoot}`);
    }
    if (animationModelOutputLogWriter.enabled) {
      console.log(`Animation Plan 全量模型输出日志已开启：${animationModelOutputLogWriter.outputRoot}`);
    }
    if (stageModelOutputLogRoot) {
      console.log(`工作流阶段全量模型输出日志已开启：${stageModelOutputLogRoot}`);
    }
  if (animationPromptCapture.enabled) {
    console.log(`动画 AI Prompt 抓取已开启：${animationPromptCapture.outputRoot}`);
  }
  if (!config.workflowRuntime.characterBoundarySignatureRequired) {
    console.log("全局角色边界签名：测试包模式（保留 sourceDigest / boundaryDigest 校验）");
  }
  console.log(`运行模式：${workflow.mode === "live" ? `${stageDefaults.analysis.provider} (${stageDefaults.analysis.model}) / 剧情 ${stageDefaults.fullStory.provider} ${stageDefaults.fullStory.model} / 动画 ${stageDefaults.animationPlan.provider} ${stageDefaults.animationPlan.model} / 静态帧编译 ${stageDefaults.staticFrameCompiler.provider || "未配置"} ${stageDefaults.staticFrameCompiler.model || ""}` : "演示数据（配置 .env 后接入模型服务）"}`);
  // Qwen 与 MiMo 是流式，只判空闲、不设总时长；只有非流式的 DeepSeek 有总超时。
  console.log(`生成请求超时：连续 ${Math.round(config.qwen.streamIdleTimeoutMs / 1000)} 秒无数据（Qwen）/ 连续 ${Math.round(config.mimo.streamIdleTimeoutMs / 1000)} 秒无数据（MiMo）/ 总时长 ${Math.round(config.deepseek.requestTimeoutMs / 60000)} 分钟（DeepSeek）`);
});

function buildStageDefaults(config, { mimoClient = null, qwenClient = null } = {}) {
  const provider = resolveDefaultLlmProvider(config);
  const source = provider === "Qwen" ? config.qwen : config.mimo;
  return {
    analysis: stageSetting(provider, source.analysisModel || source.videoModel || source.model, source.analysisMaxCompletionTokens || source.maxCompletionTokens),
    reconstruction: stageSetting(provider, source.reconstructionModel || source.videoModel || source.model, source.reconstructionMaxCompletionTokens || source.maxCompletionTokens),
    brief: stageSetting(provider, source.briefModel || source.model, source.briefMaxCompletionTokens || source.maxCompletionTokens),
    visualGuardrails: stageSetting(provider, source.visualModel || source.videoModel || source.model, source.visualMaxCompletionTokens || source.maxCompletionTokens),
    variants: stageSetting(provider, source.variantsModel || source.model, source.variantsMaxCompletionTokens || source.maxCompletionTokens),
    // 候选对照评审沿用候选阶段的 provider/model，也就是**写这些候选的那个模型**。
    // 自己批自己会偏松——§2.13 在剧情体检上实测过同一现象（同一份剧情自评
    // 「AI 可执行性 8.0 / 物理可信度 8.0」，外部模型读同一份给 6.8 / 6.8）。
    // 这里如实记下这个已知偏差，不靠静默换一家掩盖：它是纯文本阶段，
    // 需要外部视角时按阶段 override 换 provider 即可。
    // **必须单独放宽 token 预算**（2026-09-12）：这一档现在是 4 个候选 × 11 个维度
    // 加逐候选的建议与批次块，输出体量远超其它文本阶段。全局默认 16384 实测
    // 在只有 2 个占位候选时就烧掉 3.4k–4.0k，真候选很容易撞上限——表现是
    // finish=length、JSON 不完整、整份报告作废（与 §2.10 记过的截断同型代价）。
    // 与分镜终审单独放宽 requestTimeoutMs 同规格：只动这一个阶段，不碰全局默认。
    storyCandidateReview: stageSetting(
      provider,
      source.variantsModel || source.model,
      Math.max(Number(source.variantsMaxCompletionTokens || source.maxCompletionTokens) || 0, 32768)
    ),
    // 命题定向修订沿用候选阶段的 provider/model，与对照评审同规格。
    storyCandidateRevision: stageSetting(provider, source.variantsModel || source.model, source.variantsMaxCompletionTokens || source.maxCompletionTokens),
    fullStory: stageSetting(provider, source.storyModel || source.model, source.storyMaxCompletionTokens || source.maxCompletionTokens),
    animationPlan: stageSetting(provider, source.animationModel || source.storyModel || source.model, source.animationMaxCompletionTokens || source.maxCompletionTokens),
    staticFrameCompiler: stageSetting(
      config.staticFrameCompiler.provider,
      config.staticFrameCompiler.model,
      config.staticFrameCompiler.maxCompletionTokens,
      config.staticFrameCompiler.requestTimeoutMs
    ),
    characterReference: stageSetting(provider, source.characterReferenceModel || source.videoModel || source.model, source.characterReferenceMaxCompletionTokens || source.maxCompletionTokens),
    // 剧情体检沿用剧情阶段的 provider。它是纯文本阶段（不在 requiresMediaModel 里），
    // 用户随时可以按阶段 override 换成别家。
    //
    // 本来想默认换一个模型——写剧情的模型给自己批改作业会偏松（实测同一份剧情，
    // 作者模型自评「AI 可执行性 8.0 / 物理可信度 8.0」，外部模型读同一份给 6.8 / 6.8）。
    // 但把三家放在同一批 10 份剧情上实测之后，现有备选没有一个能胜任：
    //   Qwen  qwen3.7-max   10/10 成功，标出 13/91 处声明未兑现、26 条硬伤
    //   MiMo  mimo-v2.5-pro  7/10 成功，只标出 2/62 处、4 条硬伤——太松，且有一次输出本身不合 schema
    //   DeepSeek v4-flash    5/10 成功，反复产不出严格 JSON；v4-pro 连接中断
    // 一个查不出问题的评审比偏松的评审更没用，稳定性也是硬要求（输出必须过递归 strict schema）。
    // 所以先用能干活的那个，**并如实记下它自评偏松这个已知偏差**——
    // 换更合适的评审模型是后续的事，不靠静默降级掩盖。
    // 剧情体检是两次调用（编辑诊断 + 承诺核对），实测各 12k–23k token，
    // 所以与候选对照评审同规格把上限抬到 ≥32768，只动这一个阶段、不碰全局默认。
    // **不动 requestTimeoutMs**：实测单次 70–139 秒，全局 900000 有足够余量。
    storyQualityReview: stageSetting(
      provider,
      source.storyModel || source.model,
      Math.max(Number(source.storyMaxCompletionTokens || source.maxCompletionTokens) || 0, 32768)
    ),
    // 按问题修改沿用剧情 provider，token 上限与体检同规格：输出本身不长（实测单次 20–70 秒），
    // 但思考段可能很长，截断会让整份修改作废。
    storyQualityRepair: stageSetting(
      provider,
      source.storyModel || source.model,
      Math.max(Number(source.storyMaxCompletionTokens || source.maxCompletionTokens) || 0, 32768)
    ),
    // 分镜终审同样沿用剧情 provider，但 **必须单独放宽 timeout**：
    // 实测这个阶段正常出字最长 941 秒，而全局默认 900000 会在它成功前 41 秒把它掐死
    // ——那次失败完全是我们自己造成的，与上游无关。
    // 不动全局默认值：现有阶段实测最长 234 秒，900 秒有 3.8 倍余量。
    animationPlanReview: stageSetting(
      provider,
      source.storyModel || source.model,
      source.storyMaxCompletionTokens || source.maxCompletionTokens,
      1800000
    ),
    // 定向修订与终审同规格：沿用剧情 provider，timeout 同样放宽到 1800000
    // （实测修订耗时 233–775 秒，且与终审一样存在几百秒才断的传输失败）。
    animationPlanRevision: stageSetting(
      provider,
      source.storyModel || source.model,
      source.storyMaxCompletionTokens || source.maxCompletionTokens,
      1800000
    ),
    // 导演助手（2026-10-09）：沿用默认文本模型。输出只有一个动作编号加一两句话，
    // 调用时一律关闭思考（src/thinking-override.js），8192 足够。
    directorAgent: stageSetting(provider, source.model, 8192)
  };
}

function buildModelStages(stageDefaults, config) {
  const shotVideo = shotVideoDefaultSetting();
  return {
    ...stageDefaults,
    imageGeneration: stageSetting("Jimeng", config.jimeng.model, null),
    shotVideo: stageSetting(shotVideo.provider, shotVideo.model, null)
  };
}

function modelOverrideFor(body = {}, stage) {
  const value = body.modelOverrides?.[stage] || {};
  return typeof value === "object" ? String(value.model || "").trim() : "";
}

// 镜头视频的分辨率（2026-10-10）：在建任务之前校验，不合法就 400、不建任务、不调供应商。
// 只知道供应商配置文件路径时默认值要等生成时读到文件才知道，由生成器再核对一次。
function shotVideoRequestResolution(input = {}, setting = {}) {
  const configPath = String(input.configPath || "").trim()
    || (setting.provider ? shotVideoRuntimeConfig(setting.provider, process.env, setting.model).configPath : "");
  return resolveShotVideoRequestResolution({
    provider: setting.provider,
    model: setting.model,
    input,
    configPath,
    createError: (message, details) => new ProductionStateError(message, details)
  });
}

// 任务的模型快照：创建时的供应商、模型，以及这次会用的分辨率（选了的，或已知的默认值）。
function shotVideoModelSnapshot(setting, resolution) {
  return {
    shotVideo: {
      provider: setting.provider,
      model: setting.model,
      ...(resolution?.value ? { resolution: resolution.value } : {})
    }
  };
}

function shotVideoRequestSetting(body = {}) {
  const rawOverride = body.modelOverrides?.shotVideo;
  if (rawOverride !== undefined && (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride))) {
    throw new ShotVideoConfigError("首尾帧视频模型覆盖必须同时包含 provider 和 model。");
  }
  const overrideProvider = String(rawOverride?.provider || "").trim();
  const overrideModel = String(rawOverride?.model || "").trim();
  if (rawOverride !== undefined && (!overrideProvider || !overrideModel)) {
    throw new ShotVideoConfigError("首尾帧视频模型覆盖必须同时包含 provider 和 model。");
  }

  const requestedProvider = overrideProvider || String(body.videoProvider || "").trim();
  const requestedModel = overrideModel || String(body.videoModel || "").trim();
  const normalizedProvider = normalizeShotVideoProvider(requestedProvider);
  if (requestedProvider && !normalizedProvider) {
    throw new ShotVideoConfigError(`不支持首尾帧视频提供商“${requestedProvider}”。`);
  }

  // Keep an explicitly configured legacy generic worker route intact. Named
  // providers still go through the strict provider/model compatibility check.
  if (body.configPath && !requestedProvider) {
    return { provider: "", model: requestedModel };
  }
  if (normalizedProvider === "VideoHTTP") {
    const inferredProvider = inferShotVideoProvider({ model: requestedModel });
    if (inferredProvider) {
      if (!isShotVideoModelAllowed(inferredProvider, requestedModel)) {
        throw new ShotVideoConfigError(`${inferredProvider} 不支持首尾帧视频模型“${requestedModel}”。`);
      }
      return { provider: inferredProvider, model: requestedModel };
    }
    return { provider: "VideoHTTP", model: requestedModel };
  }

  const setting = resolveShotVideoSetting({
    provider: requestedProvider,
    model: requestedModel
  });
  if (setting.provider === "VideoHTTP") return setting;
  if (!["Kling", "Seedance", "MiniMax"].includes(setting.provider)) {
    throw new ShotVideoConfigError(`不支持首尾帧视频提供商“${setting.provider || requestedProvider}”。`);
  }
  if (!isShotVideoModelAllowed(setting.provider, setting.model)) {
    throw new ShotVideoConfigError(`${setting.provider} 不支持首尾帧视频模型“${setting.model}”。`);
  }
  return setting;
}

function videoHttpModel() {
  return process.env.VIDEO_HTTP_VIDEO_MODEL?.trim() || process.env.VIDEO_HTTP_MODEL?.trim() || "";
}

function stageSetting(provider, model, maxCompletionTokens, requestTimeoutMs = null) {
  const tokenNumber = maxCompletionTokens === null || maxCompletionTokens === undefined || maxCompletionTokens === ""
    ? null
    : Number(maxCompletionTokens);
  const timeoutNumber = requestTimeoutMs === null || requestTimeoutMs === undefined || requestTimeoutMs === ""
    ? null
    : Number(requestTimeoutMs);
  return {
    provider,
    model,
    maxCompletionTokens: Number.isFinite(tokenNumber) ? Math.round(tokenNumber) : null,
    requestTimeoutMs: Number.isFinite(timeoutNumber) ? Math.round(timeoutNumber) : null
  };
}

async function healthByProvider(clients, config) {
  const entries = await Promise.all(Object.entries({
    MiMo: { client: clients.MiMo, model: config.mimo.model, media: mediaSettingsForProvider("MiMo", config) },
    Qwen: { client: clients.Qwen, model: config.qwen.model, media: mediaSettingsForProvider("Qwen", config) },
    DeepSeek: { client: clients.DeepSeek, model: config.deepseek.model, media: mediaSettingsForProvider("DeepSeek", config) }
  }).map(async ([provider, value]) => {
    const health = value.client
      ? await value.client.checkHealth(value.model)
      : { reachable: false, modelAvailable: false, status: 0 };
    return [provider, {
      configured: Boolean(value.client),
      defaultModel: value.model,
      ...value.media,
      reachable: health.reachable,
      modelAvailable: health.modelAvailable,
      status: health.status,
      modelIds: Array.isArray(health.modelIds) ? health.modelIds : []
    }];
  }));
  const shotVideoProviders = shotVideoProviderCatalog();
  const defaultShotVideo = shotVideoDefaultSetting();
  const genericVideoRuntime = shotVideoRuntimeConfig("VideoHTTP");
  const genericVideoConfigured = Boolean(genericVideoRuntime.configPath || genericVideoRuntime.endpoint);
  const genericVideoHealth = {
    configured: genericVideoConfigured,
    defaultModel: genericVideoRuntime.model,
    reachable: Boolean(genericVideoRuntime.endpoint),
    modelAvailable: Boolean(genericVideoRuntime.model),
    status: genericVideoRuntime.endpoint ? 200 : 0
  };
  return {
    ...Object.fromEntries(entries),
    Jimeng: {
      configured: config.jimeng.enabled,
      defaultModel: config.jimeng.model,
      reachable: false,
      modelAvailable: config.jimeng.enabled,
      status: 0
    },
    ...shotVideoProviders,
    VideoHTTP: {
      ...genericVideoHealth,
      defaultModel: defaultShotVideo.provider === "VideoHTTP"
        ? defaultShotVideo.model || genericVideoRuntime.model
        : videoHttpModel()
    }
  };
}

async function healthByStage(clients, stageDefaults) {
  const cache = new Map();
  const entries = await Promise.all(Object.entries(stageDefaults).map(async ([stage, setting]) => {
    const key = `${setting.provider}:${setting.model}`;
    if (!cache.has(key)) {
      const client = clients[setting.provider];
      cache.set(key, client
        ? client.checkHealth(setting.model)
        : Promise.resolve({ reachable: false, modelAvailable: false, status: 0 }));
    }
    return [stage, compactHealth(await cache.get(key))];
  }));
  return Object.fromEntries(entries);
}

function compactHealth(health = {}) {
  return {
    reachable: Boolean(health.reachable),
    modelAvailable: Boolean(health.modelAvailable),
    status: Number(health.status) || 0
  };
}

function mediaSettingsForProvider(provider, config) {
  if (provider === "DeepSeek") {
    return {
      mediaMode: "text-only",
      nativeVideoMaxBytes: 0,
      videoFps: 0
    };
  }
  if (provider === "Qwen") {
    return {
      mediaMode: config.qwen.mediaMode,
      nativeVideoMaxBytes: config.qwen.nativeVideoMaxBytes,
      videoFps: config.qwen.videoFps
    };
  }
  return {
    mediaMode: config.mimo.mediaMode,
    nativeVideoMaxBytes: config.mimo.nativeVideoMaxBytes,
    videoFps: config.mimo.videoFps
  };
}

async function readJson(request, options = {}) {
  const chunks = [];
  let size = 0;
  const limit = Number(options.limit) || 32 * 1024 * 1024;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new InputError("请求过大，请减少参考素材数量或尺寸");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InputError("请求 JSON 格式无效");
  }
}

function taskRequestBodyLimit(kind) {
  return [
    "directorPipeline",
    "characterReferenceImages",
    "characterReferenceRefine",
    "shotVideo",
    "shotFrameImage"
  ].includes(String(kind || "").trim())
    ? 70 * 1024 * 1024
    : 32 * 1024 * 1024;
}

async function handleProductionStateRequest(pathname, body = {}) {
  if (pathname === "/api/production/run/start") {
    const workspace = body.workspaceId
      ? await browserWorkspaceStore.inspect(body.workspaceId, {
        expectedGeneration: requiredWorkspaceGeneration(body.workspaceGeneration),
        pageId: requiredWorkspacePageId(body.workspacePageId)
      })
      : null;
    if (workspace && (!workspace.source || workspace.source.digest !== body.metadata?.sourceVideoDigest)) {
      throw new ProductionStateError("当前参考视频尚未保存或已经更换，请重新选择视频。", {
        code: "BROWSER_WORKSPACE_SOURCE_MISMATCH", httpStatus: 409
      });
    }
    const run = await productionStateStore.createRun({
      projectId: body.projectId,
      metadata: {
        sourceVideo: {
          ...plainObject(body.metadata?.sourceVideo),
          ...(workspace?.source || {})
        },
        sourceVideoDigest: workspace?.source?.digest || String(body.metadata?.sourceVideoDigest || "").trim().toLowerCase(),
        creatorProfile: plainObject(body.metadata?.creatorProfile),
        transcript: String(body.metadata?.transcript || ""),
        ...(workspace ? { browserWorkspaceId: workspace.id } : {}),
        startedBy: "browser-workflow"
      }
    });
    if (workspace) await attachBrowserWorkspaceRun(workspace, run, body.workspacePageId);
    return run;
  }
  if (pathname === "/api/production/run/story/start") {
    return startStoryEntryRun(body);
  }
  if (pathname === "/api/production/story-entry/dialogue-check") {
    return storyEntryDialogueCheck(body);
  }
  if (pathname === "/api/production/run/load") {
    return productionStateStore.loadRun({
      projectId: body.projectId,
      runId: body.runId,
      includeContent: body.includeContent !== false
    });
  }
  if (pathname === "/api/production/stage/update") {
    return productionStateStore.recordStage(body);
  }
  if (pathname === "/api/production/artifact/commit") {
    // 用户故事原文只能由服务端在开 Run 时写入；浏览器的通用提交口不能改它，否则
    // 签发过的角色边界和整条剧情链会被一份没校验过的文本顶掉。
    if (normalizeArtifactId(body.artifactId) === STORY_SOURCE_ARTIFACT_ID) {
      throw new ProductionStateError("storySource 只能由服务端在开始剧情入口时写入。", {
        code: "STORY_SOURCE_SERVER_ONLY",
        httpStatus: 403
      });
    }
    return productionStateStore.commitArtifact(body);
  }
  if (pathname === "/api/production/package/seal") {
    return productionStateStore.sealPackage({
      projectId: body.projectId,
      runId: body.runId,
      payload: body.payload
    });
  }
  if (pathname === "/api/production/package/import") {
    let workspace = body.workspaceId
      ? await browserWorkspaceStore.inspect(body.workspaceId, {
        expectedGeneration: requiredWorkspaceGeneration(body.workspaceGeneration),
        pageId: requiredWorkspacePageId(body.workspacePageId)
      })
      : null;
    if (workspace) {
      // Reject invalid packages before clearing any existing work. A package
      // does not contain the source bytes, so never pair it with another video.
      await productionStateStore.validatePackage(body.package);
      workspace = await browserWorkspaceStore.resetSource(workspace.id, {
        expectedGeneration: workspace.generation, pageId: body.workspacePageId
      });
    }
    let createdImportRun = null;
    let imported;
    try {
      imported = await productionStateStore.importPackage(body.package, {
        browserWorkspaceId: workspace?.id,
        onRunCreated: (run) => { createdImportRun = run; }
      });
    } catch (error) {
      if (workspace && createdImportRun) {
        await browserWorkspaceCleanup.cleanup({
          projectId: createdImportRun.projectId, runId: createdImportRun.runId, workspaceId: workspace.id
        });
      }
      throw error;
    }
    if (workspace) {
      const run = imported.production;
      await attachBrowserWorkspaceRun(workspace, run, body.workspacePageId);
      imported.workspace = await browserWorkspaceStore.inspect(workspace.id, {
        expectedGeneration: workspace.generation, pageId: body.workspacePageId
      });
    }
    return imported;
  }
  throw new ProductionStateError("生产状态接口不存在", {
    code: "PRODUCTION_ROUTE_NOT_FOUND",
    httpStatus: 404
  });
}

// 「从剧情开始」：没有参考视频。顺序照 v3 导入——先把输入校验完，再清空当前页面的视频
// 和旧 Run，然后建 Run、由服务端提交 storySource、绑定工作区；建好 Run 之后任何一步
// 失败都清掉它，不留半个剧情 Run。Run 元数据只写一次，之后所有任务都从这里判断入口。
async function startStoryEntryRun(body = {}) {
  let creatorProfile;
  let storySource;
  try {
    creatorProfile = normalizeStoryEntryCreatorProfile(body.metadata?.creatorProfile);
    storySource = normalizeStorySource(body.storySource);
  } catch (error) {
    if (error instanceof StoryEntryInputError) {
      throw new ProductionStateError(error.message, { code: error.code, httpStatus: 400, details: error.details });
    }
    throw error;
  }
  // 粘贴完整故事时，原文里应能找到固定角色的名字。找不到就先问用户：确认后系统把故事主角
  // 当作固定角色（候选会改用固定角色的名字），这是「严格按原文」唯一允许的改动。
  if (storySource.storyMode === STORY_MODE_FULL_TEXT && body.acknowledgeProtagonistName !== true) {
    const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
    if (fixedName && !storySource.storyText.includes(fixedName)) {
      throw new ProductionStateError(
        `故事原文里没有出现固定角色「${fixedName}」。继续的话，系统会把故事主角当作${fixedName}，主角在原文里的其他称呼会改成「${fixedName}」。`,
        { code: "STORY_ENTRY_PROTAGONIST_NAME_MISSING", httpStatus: 409, details: [{ characterName: fixedName }] }
      );
    }
  }
  let workspace = body.workspaceId
    ? await browserWorkspaceStore.inspect(body.workspaceId, {
      expectedGeneration: requiredWorkspaceGeneration(body.workspaceGeneration),
      pageId: requiredWorkspacePageId(body.workspacePageId)
    })
    : null;
  if (workspace) {
    workspace = await browserWorkspaceStore.resetSource(workspace.id, {
      expectedGeneration: workspace.generation, pageId: body.workspacePageId
    });
  }
  let createdRun = null;
  let committed;
  try {
    createdRun = await productionStateStore.createRun({
      projectId: body.projectId,
      metadata: {
        entryMode: STORY_ENTRY_MODE,
        storyMode: storySource.storyMode,
        storySourceDigest: contentDigest(storySource),
        creatorProfile,
        ...(workspace ? { browserWorkspaceId: workspace.id } : {}),
        startedBy: "browser-story-entry"
      }
    });
    committed = await productionStateStore.commitArtifact({
      projectId: createdRun.projectId,
      runId: createdRun.runId,
      artifactId: STORY_SOURCE_ARTIFACT_ID,
      artifactType: STORY_SOURCE_ARTIFACT_TYPE,
      content: storySource,
      dependencies: [],
      requestId: `story-start-${randomUUID()}`,
      expectedCurrentRevision: null
    });
  } catch (error) {
    if (workspace && createdRun) {
      await browserWorkspaceCleanup.cleanup({ projectId: createdRun.projectId, runId: createdRun.runId, workspaceId: workspace.id });
    }
    throw error;
  }
  const run = await productionStateStore.loadRun({ projectId: createdRun.projectId, runId: createdRun.runId, includeContent: false });
  const result = {
    production: {
      ...run,
      latestArtifacts: undefined,
      artifacts: { [STORY_SOURCE_ARTIFACT_ID]: committed.lineage }
    },
    storySource
  };
  if (!workspace) return result;
  await attachBrowserWorkspaceRun(workspace, createdRun, body.workspacePageId);
  result.workspace = await browserWorkspaceStore.inspect(workspace.id, {
    expectedGeneration: workspace.generation, pageId: body.workspacePageId
  });
  return result;
}

// 只读的台词核对：现算现给，不写 Artifact、不进 Task Store、不落盘。
async function storyEntryDialogueCheck(body = {}) {
  const run = await productionStateStore.loadRun({ projectId: body.projectId, runId: body.runId, includeContent: true });
  const entry = trustedStoryEntryContext(run);
  const variantId = safeIdentifier(body.variantId || STORY_ENTRY_VARIANT_ID, "variantId");
  const currentContent = (artifactId) => {
    const item = run.latestArtifacts?.[artifactId];
    return item?.lineage?.status === "current" ? item.content : null;
  };
  return storyEntryDialogueFaithfulness({
    storySource: entry.storySource,
    fullStory: currentContent(`fullStory:${variantId}`),
    animationPlan: currentContent(`animationPlan:${variantId}`)
  });
}

function isStoryEntryRun(run) {
  return isStoryEntryMetadata(run?.metadata);
}

// 视频入口的任务在剧情 Run 上调用（或反过来）一律明确拒绝，不让它们拿着缺失的上游去碰运气。
function assertRunEntryMode(run, expected) {
  const actual = isStoryEntryRun(run) ? STORY_ENTRY_MODE : "video";
  if (actual === expected) return true;
  throw new ProductionStateError(actual === STORY_ENTRY_MODE
    ? "这是「从剧情开始」的 Run，没有参考视频，不能运行参考视频专用的步骤。"
    : "这个 Run 是从参考视频开始的，不能运行「从剧情开始」的步骤。", {
    code: "TASK_ENTRY_MODE_MISMATCH",
    httpStatus: 409,
    details: [{ expected, actual }]
  });
}

// 剧情入口的可信上下文：故事原文只取服务端在开 Run 时提交的 storySource，并核对它与
// Run 元数据里一次写定的摘要一致；固定角色设定也取元数据里那一份，不取请求体。
function trustedStoryEntryContext(run) {
  assertRunEntryMode(run, STORY_ENTRY_MODE);
  const entry = run.latestArtifacts?.[STORY_SOURCE_ARTIFACT_ID];
  if (!entry?.lineage || entry.lineage.status !== "current") {
    throw new ProductionStateError("剧情入口缺少 current storySource。", { code: "TASK_DEPENDENCY_MISSING", httpStatus: 409 });
  }
  let storySource;
  try {
    storySource = normalizeStorySource(entry.content);
  } catch (error) {
    throw new ProductionStateError(`storySource 内容无效：${error.message}`, { code: "STORY_SOURCE_INVALID", httpStatus: 409 });
  }
  if (entry.lineage.contentDigest !== String(run.metadata?.storySourceDigest || "")) {
    throw new ProductionStateError("storySource 与 Run 创建时记录的摘要不一致。", { code: "STORY_SOURCE_TAMPERED", httpStatus: 409 });
  }
  return {
    storyMode: storySource.storyMode,
    storySource,
    creatorProfile: normalizeStoryEntryCreatorProfile(run.metadata?.creatorProfile)
  };
}

// 剧情 Run 的请求体不该带参考视频那三份上游；页面给了非空副本说明它拿错了 Run，直接拒绝。
// null 视为没给（旧页面状态里缺失的上游就是 null）。
function assertNoVideoUpstreamCopies(input = {}) {
  const present = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]
    .filter((key) => input?.[key] !== undefined && input?.[key] !== null);
  if (!present.length) return true;
  throw new ProductionStateError(`「从剧情开始」的 Run 没有参考视频上游，请求不应携带：${present.join("、")}`, {
    code: "STORY_ENTRY_INPUT_INVALID",
    httpStatus: 400,
    details: present.map((key) => ({ key }))
  });
}

// 「粘贴完整故事」的 Run 没有故事候选，原文直接拆成可翻拍镜头。只认可信的 Run 元数据。
function isStorySourceDirectEntry(entry) {
  return entry?.storyMode === STORY_MODE_FULL_TEXT;
}

// 这类 Run 的请求里出现任何候选副本，说明页面拿错了 Run；直接拒绝，也不让页面伪造一个候选来凑依赖。
function assertNoCandidateCopies(input = {}) {
  const present = ["variant", "themeVariants", "candidateBinding", "selectedVariant"]
    .filter((key) => input?.[key] !== undefined && input?.[key] !== null);
  if (!present.length) return true;
  throw new ProductionStateError(`「粘贴完整故事」的 Run 没有故事候选，请求不应携带：${present.join("、")}`, {
    code: "STORY_ENTRY_INPUT_INVALID",
    httpStatus: 400,
    details: present.map((key) => ({ key }))
  });
}

// 角色画风（2026-10-09）：分镜请求里的 artStyle。只拦类型错误与超长，不裁决画风写得好不好；
// 空串表示不指定。视频入口与剧情入口的分镜路由共用这一处。
function assertCharacterArtStyleInput(body) {
  if (body?.artStyle !== undefined && !isValidCharacterArtStyle(body.artStyle)) {
    throw new InputError(`artStyle 必须是不超过 ${CHARACTER_ART_STYLE_MAX_CHARS} 字符的字符串`);
  }
  return true;
}

// 剧情 Run 只有 V1 这一个故事位，fullStory / animationPlan 都挂在它上面。
function assertStoryEntrySlot(variantId) {
  if (variantId === STORY_ENTRY_VARIANT_ID) return true;
  throw new ProductionStateError(`「从剧情开始」的 Run 只有故事位 ${STORY_ENTRY_VARIANT_ID}，收到 ${variantId}。`, {
    code: "STORY_ENTRY_INPUT_INVALID",
    httpStatus: 400,
    details: [{ key: "variantId", value: variantId }]
  });
}

// 页面带了 creatorProfile 时，它必须就是开 Run 时写进元数据的那一份；剧情 Run 的
// 下游一律用元数据里的设定，不用请求体。
function assertStoryEntryProfileCopy(input = {}, entry) {
  if (!Object.prototype.hasOwnProperty.call(input || {}, "creatorProfile")) return true;
  let copy;
  try {
    copy = normalizeStoryEntryCreatorProfile(input.creatorProfile);
  } catch (error) {
    throw new ProductionStateError(`creatorProfile 无效：${error.message}`, { code: "STORY_ENTRY_INPUT_INVALID", httpStatus: 400 });
  }
  return assertCompatibleValueCopy(entry.creatorProfile, copy, "creatorProfile");
}

function storyEntryDependencyRefs(run, artifactIds) {
  return artifactIds.map((artifactId) => lineageRef(requireCurrentArtifact(run, artifactId).lineage));
}

function storyEntryContextPayload(entry) {
  return { storyMode: entry.storyMode, storySource: entry.storySource };
}

function storyEntryFullStoryInput(run, input, variantId) {
  const entry = trustedStoryEntryContext(run);
  assertNoVideoUpstreamCopies(input);
  assertStoryEntryProfileCopy(input, entry);
  assertStoryEntrySlot(variantId);
  if (isStorySourceDirectEntry(entry)) {
    // 粘贴完整故事：没有候选，原文直接拆成可翻拍镜头，只依赖原文与角色边界。
    assertNoCandidateCopies(input);
    const sourceDependencyIds = [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails"];
    assertCompatibleArtifactCopies(run, input, [["visualGuardrails", "visualGuardrails"]]);
    return {
      visualGuardrails: currentArtifactContents(run, sourceDependencyIds).visualGuardrails,
      creatorProfile: entry.creatorProfile,
      targetDurationSeconds: input.targetDurationSeconds,
      fullStorySchemaVersion: input.fullStorySchemaVersion,
      modelOverrides: input.modelOverrides,
      __storyEntry: storyEntryContextPayload(entry),
      __dependencies: storyEntryDependencyRefs(run, sourceDependencyIds)
    };
  }
  const dependencyIds = [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails", "themeVariants", `variant:${variantId}`];
  assertCompatibleArtifactCopies(run, input, [
    ["visualGuardrails", "visualGuardrails"],
    ["themeVariants", "themeVariants"],
    ["variant", `variant:${variantId}`]
  ]);
  assertCompatibleLineageCopy(run, `variant:${variantId}`, input.candidateBinding, "candidateBinding");
  const artifacts = currentArtifactContents(run, dependencyIds);
  return {
    visualGuardrails: artifacts.visualGuardrails,
    themeVariants: artifacts.themeVariants,
    variant: artifacts[`variant:${variantId}`],
    candidateBinding: lineageRef(requireCurrentArtifact(run, `variant:${variantId}`).lineage),
    creatorProfile: entry.creatorProfile,
    targetDurationSeconds: input.targetDurationSeconds,
    fullStorySchemaVersion: input.fullStorySchemaVersion,
    modelOverrides: input.modelOverrides,
    __storyEntry: storyEntryContextPayload(entry),
    __dependencies: storyEntryDependencyRefs(run, dependencyIds)
  };
}

function storyEntryAnimationPlanInput(run, input, variantId) {
  const entry = trustedStoryEntryContext(run);
  assertNoVideoUpstreamCopies(input);
  assertStoryEntryProfileCopy(input, entry);
  if (input.animationPlanVersion !== STORYBOARD_PLAN_VERSION) {
    throw new ProductionStateError("「从剧情开始」的 Run 只支持 4.0 自主分镜。", {
      code: "STORY_ENTRY_PLAN_VERSION_UNSUPPORTED",
      httpStatus: 400
    });
  }
  assertStoryEntrySlot(variantId);
  // 粘贴完整故事没有候选：分镜只依赖原文、角色边界和可翻拍镜头。
  const fromStorySource = isStorySourceDirectEntry(entry);
  if (fromStorySource) assertNoCandidateCopies(input);
  const dependencyIds = fromStorySource
    ? [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails", `fullStory:${variantId}`]
    : [STORY_SOURCE_ARTIFACT_ID, "visualGuardrails", `variant:${variantId}`, `fullStory:${variantId}`];
  assertCompatibleArtifactCopies(run, input, [
    ["visualGuardrails", "visualGuardrails"],
    ...(fromStorySource ? [] : [["variant", `variant:${variantId}`]]),
    ["fullStory", `fullStory:${variantId}`]
  ]);
  const artifacts = currentArtifactContents(run, dependencyIds);
  return {
    visualGuardrails: artifacts.visualGuardrails,
    ...(fromStorySource ? {} : { variant: artifacts[`variant:${variantId}`] }),
    fullStory: artifacts[`fullStory:${variantId}`],
    creatorProfile: entry.creatorProfile,
    characterExpressionRules: input.characterExpressionRules,
    artStyle: input.artStyle,
    animationPlanMode: input.animationPlanMode || "direct_shot",
    animationPlanVersion: input.animationPlanVersion,
    targetAspectRatio: input.targetAspectRatio,
    backgroundMusicEnabled: input.backgroundMusicEnabled,
    videoPromptTarget: input.videoPromptTarget,
    includeCompilerMetadata: input.includeCompilerMetadata !== false,
    modelOverrides: input.modelOverrides,
    __storyEntry: storyEntryContextPayload(entry),
    __dependencies: storyEntryDependencyRefs(run, dependencyIds)
  };
}

// 剧情入口的完整剧情。与 /api/full-story 路由同一套候选绑定与前后复核，只是候选按剧情入口
// 的严格 Schema 校验，并把 storyEntry 交给 workflow（它决定提示词与角色边界摘要）。
// 不注册成 HTTP 路由：只能经由 fullStory 任务、在服务端确认是剧情 Run 之后调用。
async function storyEntryFullStory(body, { request, storyEntry }) {
  if (body?.targetDurationSeconds !== undefined && !isValidStoryDurationSeconds(body.targetDurationSeconds)) {
    throw new InputError(
      `targetDurationSeconds 必须是 ${STORY_DURATION_MIN_SECONDS}-${STORY_DURATION_MAX_SECONDS} 之间的整数秒`
    );
  }
  const validateBoundCandidate = (candidate) => {
    ensureStoryEntryCandidateContract(candidate, { path: "selectedCandidate" });
    ensureThemeVariantsMatchProfile({ variants: [candidate] }, body?.creatorProfile, null, body?.visualGuardrails);
    return candidate;
  };
  const candidateBinding = await resolveFullStoryCandidateBinding({
    headers: request?.headers || {},
    body,
    loadRun: (input) => productionStateStore.loadRun(input),
    validateCandidate: validateBoundCandidate
  });
  const result = await workflow.createFullStory(candidateBinding.input, {
    traceContext: await fullStoryModelOutputTrace(request, candidateBinding.input),
    storyEntry
  });
  await assertFullStoryCandidateBindingCurrent(candidateBinding, {
    loadRun: (input) => productionStateStore.loadRun(input),
    validateCandidate: validateBoundCandidate
  });
  return result;
}

// 「粘贴完整故事」的可翻拍镜头（fullStory:V1）：原文直接拆场。没有候选，所以没有候选绑定的
// 前后复核；storySource 与 visualGuardrails 由任务管理器按冻结依赖在调用前后复检。
// 剧情准备的第 ② 步与分场页「重新拆分」用的独立 fullStory 任务都走这一个函数。
async function storyEntrySourceFullStory(body, { request, storyEntry }) {
  if (body?.targetDurationSeconds !== undefined && !isValidStoryDurationSeconds(body.targetDurationSeconds)) {
    throw new InputError(
      `targetDurationSeconds 必须是 ${STORY_DURATION_MIN_SECONDS}-${STORY_DURATION_MAX_SECONDS} 之间的整数秒`
    );
  }
  return workflow.createFullStory(body, {
    traceContext: await fullStoryModelOutputTrace(request, body, STORY_ENTRY_VARIANT_ID),
    storyEntry
  });
}

// 剧情入口的 4.0 分镜。与 /api/animation-plan 路由同一份输入检查与提示词采集外壳。
// 剧情 Run 只有 V1 这一个故事位，采集与调试侧车的标签都用它（粘贴原文的 Run 没有候选可取 id）。
async function storyEntryAnimationPlan(body, { request, storyEntry }) {
  if (body?.characterExpressionRules !== undefined && !isValidCharacterExpressionRules(body.characterExpressionRules)) {
    throw new InputError(`characterExpressionRules 必须是不超过 ${CHARACTER_EXPRESSION_RULES_MAX_CHARS} 字符的字符串`);
  }
  assertCharacterArtStyleInput(body);
  return animationPromptCapture.run({
    route: "/api/animation-plan",
    variantId: STORY_ENTRY_VARIANT_ID,
    animationPlanMode: body?.animationPlanMode,
    provider: String(body?.modelOverrides?.animationPlan?.provider || stageDefaults.animationPlan.provider || ""),
    traceContext: await animationPlanModelOutputTrace(request, body, STORY_ENTRY_VARIANT_ID)
  }, () => workflow.createAnimationPlanWithMetadata(body, { storyEntry }));
}

// 媒体阶段的角色边界校验。参考视频 Run 逐字沿用原来的调用（请求体里经过 digest 复核的副本）；
// 剧情 Run 一律取服务端 Run 里的固定角色设定与 current visualGuardrails，按剧情入口的摘要验。
function verifyBoundaryForMedia(productionMedia, body) {
  if (!productionMedia?.storyEntry) return workflow.assertGlobalCharacterBoundary(body);
  const guardrails = productionMedia.latestArtifacts?.visualGuardrails;
  if (guardrails?.lineage?.status !== "current") {
    throw new ProductionStateError("缺少 current Artifact：visualGuardrails", { code: "TASK_DEPENDENCY_MISSING", httpStatus: 409 });
  }
  return workflow.assertGlobalCharacterBoundary(
    { creatorProfile: productionMedia.storyEntry.creatorProfile, visualGuardrails: guardrails.content },
    { storyEntry: storyEntryContextPayload(productionMedia.storyEntry) }
  );
}

function sameLineageRefs(left, right) {
  const normalize = (items) => (Array.isArray(items) ? items : [])
    .map((item) => ({
      artifactId: String(item?.artifactId || ""),
      revision: String(item?.revision || ""),
      contentDigest: String(item?.contentDigest || "")
    }))
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  return contentDigest(normalize(left)) === contentDigest(normalize(right));
}

async function attachBrowserWorkspaceRun(workspace, run, pageId) {
  try {
    await browserWorkspaceStore.attachRun(workspace.id, {
      projectId: run.projectId,
      runId: run.runId,
      expectedGeneration: workspace.generation,
      pageId,
      replaceExisting: true
    });
  } catch (error) {
    // A file switch while create/import was pending must not leave an orphan
    // Run or let its response attach to the new video's page.
    await browserWorkspaceCleanup.cleanup({ projectId: run.projectId, runId: run.runId, workspaceId: workspace.id });
    throw error;
  }
}

async function resolveProductionMediaContext(body = {}, { required = false } = {}) {
  const context = body.productionContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    if (!required) return null;
    throw new ProductionStateError("当前媒体生成请求缺少 Animation Plan lineage", {
      code: "MEDIA_LINEAGE_REQUIRED",
      httpStatus: 409
    });
  }
  const projectId = safeIdentifier(context.projectId, "productionContext.projectId");
  const runId = safeIdentifier(context.runId, "productionContext.runId");
  const planArtifactId = normalizeArtifactId(context.planArtifactId);
  const planRevision = safeIdentifier(context.planRevision, "productionContext.planRevision");
  const planDigest = String(context.planDigest || "").trim().toLowerCase();
  const mediaNamespace = String(context.mediaNamespace || "").trim();
  const run = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
  const currentEntry = run.latestArtifacts?.[planArtifactId];
  const current = currentEntry?.lineage;
  if (
    !current
    || current.artifactType !== "animationPlan"
    || !planArtifactId.startsWith("animationPlan:")
    || current.status !== "current"
    || current.revision !== planRevision
    || current.contentDigest !== planDigest
    || current.mediaNamespace !== mediaNamespace
  ) {
    throw new ProductionStateError("Animation Plan 已更新，拒绝把媒体写入旧版本", {
      code: "MEDIA_PLAN_LINEAGE_STALE",
      httpStatus: 409,
      details: [{
        artifactId: planArtifactId,
        expectedRevision: planRevision,
        actualRevision: current?.revision || null
      }]
    });
  }
  const namespaceSegments = mediaNamespace.split("/").map((segment) => safeIdentifier(segment, "mediaNamespace"));
  if (namespaceSegments.length !== 3) {
    throw new ProductionStateError("mediaNamespace 格式无效", {
      code: "MEDIA_NAMESPACE_INVALID"
    });
  }
  const publicNamespace = namespaceSegments.join("/");
  const planAspectRatio = requireAnimationPlanAspectRatio(
    currentEntry?.content?.productionStrategy?.targetAspectRatio,
    "当前 Animation Plan productionStrategy.targetAspectRatio"
  );
  const videoOutputRoot = path.join(publicDir, "generated-videos", ...namespaceSegments);
  let workspaceMediaLifetime = null;
  if (run.metadata?.browserWorkspaceId) {
    // The worker may outlive this Node process. Its local lifetime file guards
    // final writes; create the output directory while the Run is still locked.
    await productionRunCoordinator.withRunLock(projectId, runId, async () => {
      await productionStateStore.readManifest(projectId, runId);
      await fs.mkdir(videoOutputRoot, { recursive: true });
    });
    workspaceMediaLifetime = {
      workRoot: path.join(productionStateStore.runDirectory(projectId, runId), "media-work"),
      lifetimeFile: productionStateStore.manifestPath(projectId, runId)
    };
  }
  return {
    projectId,
    runId,
    planArtifactId,
    planEntry: currentEntry,
    latestArtifacts: run.latestArtifacts || {},
    imageOutputRoot: path.join(publicDir, "generated-images", ...namespaceSegments),
    imagePublicBasePath: `/generated-images/${publicNamespace}`,
    videoOutputRoot,
    workspaceMediaLifetime,
    videoPublicBasePath: `/generated-videos/${publicNamespace}`,
    filenamePrefix: `${safeIdentifier(planRevision, "planRevision")}-${planDigest.slice(0, 12)}`,
    planAspectRatio,
    // 剧情 Run 才有；媒体阶段据此按剧情入口的摘要验角色边界（verifyBoundaryForMedia）。
    storyEntry: isStoryEntryRun(run) ? trustedStoryEntryContext(run) : null
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ProductionStateError(`${label} 必须是非负整数`, {
      code: "TASK_INPUT_INVALID",
      httpStatus: 400
    });
  }
  return number;
}

function stripReferenceImageData(value = {}) {
  const copy = structuredClone(value && typeof value === "object" ? value : {});
  delete copy.referenceImageDataUrl;
  delete copy.referenceAudioClips;
  return copy;
}

async function generatedPublicUrlToDataUrl(urlValue) {
  const url = new URL(String(urlValue || ""), "http://localhost");
  if (!url.pathname.startsWith("/generated-images/")) {
    throw new ProductionStateError("生成图片 URL 不属于受信输出目录", {
      code: "GENERATED_IMAGE_PATH_INVALID",
      httpStatus: 500
    });
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  const allowedRoot = path.resolve(publicDir, "generated-images");
  if (file !== allowedRoot && !file.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new ProductionStateError("生成图片路径越界", {
      code: "GENERATED_IMAGE_PATH_INVALID",
      httpStatus: 500
    });
  }
  const data = await fs.readFile(file);
  const extension = path.extname(file).toLowerCase();
  const mimeType = extension === ".png" ? "image/png"
    : extension === ".webp" ? "image/webp"
      : "image/jpeg";
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

async function streamCharacterReferenceImages(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const send = (event, data) => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const body = await readJson(request);
    if (body.productionContext?.projectId && body.productionContext?.runId) {
      const durableInput = await legacyCharacterImageTaskInput(body);
      const created = await durableTaskManager.createTask({
        ...taskDefinitionForRequest({
          projectId: body.productionContext.projectId,
          runId: body.productionContext.runId,
          kind: "characterReferenceImages",
          input: durableInput
        }),
        requestBytes: Buffer.byteLength(JSON.stringify(body || {}), "utf8")
      });
      send("progress", {
        type: "start",
        message: `角色参考图任务${created.reused ? "已重新接管" : "已创建"}…`,
        model: created.task.modelSnapshot?.imageGeneration?.model || config.jimeng.model,
        count: durableInput.count,
        prompt: durableInput.prompt
      });
      await streamDurableCharacterImageTask(created.task, send, response, durableInput.prompt);
      return;
    }
    const productionMedia = await resolveProductionMediaContext(body, { required: true });
    const visualGuardrails = workflow.assertGlobalCharacterBoundary(body);
    if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
    const count = Math.max(1, Math.min(config.jimeng.maxImages, Math.round(Number(body.count) || 1)));
    const imageModel = modelOverrideFor(body, "imageGeneration") || config.jimeng.model;
    // 浏览器正常总会送 prompt（用户可编辑）；这里是它为空时的回退，同样要带上
    // 全片视觉锁定，否则角色图会在不知道全片风格的情况下生成。
    const prompt = String(body.prompt || "").trim()
      || buildCharacterReferenceImagePrompt(
        body.characterReference,
        count,
        body.animationPlan?.visualBible || body.visualBible || null,
        {
          withReferenceImage: Boolean(body.referenceImageDataUrl),
          artStyle: body.animationPlan?.productionStrategy?.artStyle
        }
      );
    // 角色参考图是用户可改写提示词的环节：边界偏差只提醒，不阻断本次生成。
    // 成片渲染链路（/api/generate-shot-video、旧 v2 首尾帧）仍然硬失败。
    const boundaryWarnings = [
      characterReferenceBoundaryMismatch(body.characterReference, visualGuardrails),
      characterPromptBoundaryMismatch(prompt, visualGuardrails, {
        characterName: body.characterReference?.characterName || ""
      })
    ].filter(Boolean);
    send("progress", {
      type: "start",
      message: `正在调用即梦 ${imageModel} 生成 ${count} 张角色参考图…`,
      model: imageModel,
      count,
      prompt
    });
    if (boundaryWarnings.length) {
      send("progress", {
        type: "boundary-warning",
        characterName: body.characterReference?.characterName || "",
        message: `模型输出未通过校验：${boundaryWarnings.join("；")}`
      });
    }
    await jimengClient.generateImagesStream({
      referenceImageDataUrl: body.referenceImageDataUrl,
      characterReference: body.characterReference,
      count,
      prompt,
      model: imageModel
    }, async (event) => {
      if (event.type === "image_generation.partial_succeeded") {
        const image = await persistGeneratedImage(event, body.characterReference, productionMedia);
        send("image", {
          type: "image",
          imageIndex: Number(event.image_index) || 0,
          characterName: body.characterReference?.characterName || "",
          model: event.model || imageModel,
          created: event.created || Math.round(Date.now() / 1000),
          size: event.size || image.size || "",
          url: image.url,
          filename: image.filename,
          prompt
        });
        return;
      }
      if (event.type === "image_generation.partial_failed") {
        send("image-error", streamErrorPayload(event.error, "单张图片生成失败", {
          type: "image-error",
          imageIndex: Number(event.image_index) || 0,
          code: event.error?.code || ""
        }));
        return;
      }
      if (event.type === "image_generation.completed") {
        send("completed", { type: "completed", usage: event.usage || {}, model: event.model || imageModel });
        return;
      }
      if (event.error) {
        send("error", streamErrorPayload(event.error, "即梦图片生成失败"));
      }
    });
    send("done", { type: "done" });
  } catch (error) {
    send("error", streamErrorPayload(error, "角色参考图生成失败"));
  } finally {
    response.end();
  }
}

async function legacyCharacterImageTaskInput(body) {
  const projectId = safeIdentifier(body.productionContext.projectId, "projectId");
  const runId = safeIdentifier(body.productionContext.runId, "runId");
  const planArtifactId = normalizeArtifactId(body.productionContext.planArtifactId);
  const variantId = safeIdentifier(
    body.selectedVariant?.id || planArtifactId.slice("animationPlan:".length),
    "variantId"
  );
  const run = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
  const plan = requireCurrentArtifact(run, planArtifactId).content;
  let roleIndex = Number(body.roleIndex);
  if (!Number.isInteger(roleIndex) || roleIndex < 0) {
    const characterName = String(body.characterReference?.characterName || "").trim();
    roleIndex = (plan.characterReferencePrompts || []).findIndex((item) => (
      String(item.characterName || "").trim() === characterName
    ));
  }
  roleIndex = requireNonNegativeInteger(roleIndex, "roleIndex");
  const count = Math.max(1, Math.min(config.jimeng.maxImages, Math.round(Number(body.count) || 1)));
  const characterReference = plan.characterReferencePrompts?.[roleIndex] || body.characterReference;
  return {
    ...body,
    variantId,
    roleIndex,
    count,
    prompt: String(body.prompt || "").trim()
      || buildCharacterReferenceImagePrompt(characterReference, count, plan.visualBible || null, {
        withReferenceImage: Boolean(body.referenceImageDataUrl),
        artStyle: plan.productionStrategy?.artStyle
      })
  };
}

async function streamDurableCharacterImageTask(initialTask, send, response, prompt) {
  let task = initialTask;
  const delivered = new Set();
  while (["queued", "running"].includes(task.status)) {
    for (const result of task.progress?.results || []) {
      const key = `${result.status}:${result.imageIndex}`;
      if (delivered.has(key)) continue;
      delivered.add(key);
      if (result.status === "ready") send("image", { ...result, type: "image", prompt });
      else if (result.status === "error") send("image-error", { ...result, type: "image-error" });
    }
    if (response.destroyed || response.writableEnded) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
    task = await durableTaskStore.getTask({
      projectId: task.projectId,
      runId: task.runId,
      taskId: task.taskId
    });
  }
  for (const result of task.progress?.results || []) {
    const key = `${result.status}:${result.imageIndex}`;
    if (delivered.has(key)) continue;
    delivered.add(key);
    if (result.status === "ready") send("image", { ...result, type: "image", prompt });
    else if (result.status === "error") send("image-error", { ...result, type: "image-error" });
  }
  if (task.status === "completed") {
    for (const notice of task.notices || []) send("progress", { type: "boundary-warning", message: notice });
    send("completed", {
      type: "completed",
      usage: task.usage || {},
      model: task.modelSnapshot?.imageGeneration?.model || config.jimeng.model,
      partialSuccess: Boolean(task.progress?.partialSuccess)
    });
    send("done", { type: "done" });
    return;
  }
  send("error", {
    type: "error",
    code: task.error?.code || "TASK_FAILED",
    error: task.error?.message || `任务以 ${task.status} 结束`
  });
}

async function generateShotFrameImage(body = {}) {
  const visualGuardrails = workflow.assertGlobalCharacterBoundary(body);
  if (String(body.animationPromptSchemaVersion || "").trim() === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    // 暂时弃置，后续优化或删除：direct_shot 禁止进入旧首尾帧图片生成路径，旧 v2 实现保留在下方。
    throw new InputError("promptSchemaVersion=3.0 的 direct_shot 镜头不生成首尾帧");
  }
  if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
  const frameKind = body.frameKind === "end" ? "end" : "start";
  const shot = body.shot || {};
  ensureCharacterReferencesMatchBoundary(body.characterReferences, visualGuardrails, shot);
  const frameReferenceMode = String(body.frameReferenceMode || "").trim();
  if (frameReferenceMode && frameKind !== "end") {
    throw new InputError("frameReferenceMode 只允许用于尾帧生成");
  }
  const endpointReferences = normalizeEndpointReferenceImages(body.referenceImages, {
    frameKind,
    frameReferenceMode,
    shotId: shot.shotId
  });
  if (frameReferenceMode) {
    ensureFrameReferenceModeCompatibility(shot, frameReferenceMode, {
      hasStartFrame: endpointReferences.length === 1,
      hasStartFrameReference: endpointReferences.length === 1
    });
  }
  let manifest;
  try {
    manifest = await buildFrameReferenceManifest({
      frameKind: frameReferenceMode ? frameKind : "start",
      frameReferenceMode: frameReferenceMode || undefined,
      endpointReference: endpointReferences[0] || null,
      characterReferences: body.characterReferences,
      maxProviderImages: 6
    });
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(error.message || "参考图清单无效");
  }
  const negativePromptDelivery = compileShotFrameNegativePrompt(shot);
  const basePrompt = String(body.prompt || "").trim() || buildShotFrameImagePrompt({
    frameKind,
    shot,
    visualBible: body.visualBible,
    characterReferences: body.characterReferences,
    sceneReference: body.sceneReference,
    referenceManifest: manifest,
    frameReferenceMode
  });
  const prompt = appendMissingLines(basePrompt, [
    ...frameReferenceManifestPromptLines(manifest, frameReferenceMode, {
      shot,
      frameKind,
      sceneReference: body.sceneReference
    }),
    ...negativePromptDelivery.positiveConstraints
  ]);
  let authoritativeDependencyHash = "";
  try {
    authoritativeDependencyHash = frameReferenceMode
      ? await computeDependencyHash({
        startImageDataUrl: manifest.endpointReference?.dataUrl || "",
        endState: shot.endFrame,
        referenceImages: manifest.additionalReferences,
        frameReferenceMode
      })
      : "";
  } catch (error) {
    throw new InputError(error.message || "尾帧依赖哈希无法计算");
  }
  if (frameReferenceMode) assertFrameDependencyHash(body.dependencyHash, authoritativeDependencyHash);
  const count = clampFrameImageCount(body.count);
  const providerPrompt = buildShotFrameMultiImagePrompt(prompt, count);
  ensureCharacterPromptMatchesBoundary(providerPrompt, visualGuardrails, {
    requireRequiredTraits: false,
    promptScope: "multi_character"
  });
  const authoritativePromptHash = frameReferenceMode ? await computePromptHash(providerPrompt) : "";
  const imageModel = modelOverrideFor(body, "imageGeneration") || config.jimeng.model;
  const productionMedia = await resolveProductionMediaContext(body, { required: false });
  const uploadedReferences = manifest.providerImages.map((item) => item.dataUrl);
  const images = [];
  const requestReceipt = await jimengClient.generateImagesStream({
    count,
    prompt: providerPrompt,
    referenceImageDataUrls: uploadedReferences,
    model: imageModel,
    negativePromptDelivery
  }, async (event) => {
    if (event.type === "image_generation.partial_succeeded") {
      images.push(await persistGeneratedImage(event, {
        characterName: `${shot.shotId || "shot"}-${frameKind}-frame`
      }, productionMedia));
    }
    if (event.type === "image_generation.partial_failed") {
      throw new JimengImageProviderError(event.error?.message || event.error?.code || "镜头帧图片生成失败", JSON.stringify(event.error || {}));
    }
    if (event.error) throw new JimengImageProviderError(event.error?.message || "镜头帧图片生成失败", JSON.stringify(event.error || {}));
  });
  const image = images[0];
  if (!image) throw new JimengImageProviderError("即梦没有返回可用的镜头帧图片");
  if (images.length !== count) {
    throw new JimengImageProviderError(
      `镜头帧图片数量不足：请求 ${count} 张，实际返回 ${images.length} 张`,
      JSON.stringify({ requested: count, actual: images.length })
    );
  }
  return {
    frameKind,
    shotId: shot.shotId || "",
    prompt,
    providerPrompt,
    model: imageModel,
    url: image.url,
    filename: image.filename,
    size: image.size || "",
    count,
    actualCount: images.length,
    images: images.map((item) => ({
      url: item.url,
      filename: item.filename,
      size: item.size || "",
      model: imageModel,
      referenceImageCount: uploadedReferences.length,
      ...(frameReferenceMode ? {
        frameReferenceMode,
        dependencyHash: authoritativeDependencyHash,
        promptHash: authoritativePromptHash,
        usedStartFrameReference: Boolean(manifest.endpointReference?.usedByProvider)
      } : {})
    })),
    referenceImageCount: uploadedReferences.length,
    referenceImageManifest: manifest.providerImages.map(({ index, token, role, contentHash, characterName = "", sourceShotId = "" }) => ({
      index,
      token,
      role,
      contentHash,
      characterName,
      sourceShotId
    })),
    ...(frameReferenceMode ? {
      frameReferenceMode,
      dependencyHash: authoritativeDependencyHash,
      promptHash: authoritativePromptHash,
      usedStartFrameReference: Boolean(manifest.endpointReference?.usedByProvider),
      clientPromptHashMatched: !body.promptHash || body.promptHash === authoritativePromptHash
    } : {}),
    negativePromptDelivery: requestReceipt?.negativePromptDelivery || {},
    requestPreview: requestReceipt?.requestPreview || {},
    generatedAt: new Date().toISOString()
  };
}


function ensureCharacterReferencesMatchBoundary(characterReferences, visualGuardrails, shot = {}) {
  const references = Array.isArray(characterReferences) ? characterReferences : [];
  const boundaryName = String(visualGuardrails?.fixedCharacterBoundary?.characterName || "").trim();
  if (boundaryName && shotShowsCharacter(shot, boundaryName) && !references.some((reference) => (
    String(reference?.characterName || "").trim() === boundaryName
  ))) {
    throw new InputError(`当前镜头包含固定角色「${boundaryName}」，但请求未携带其全局角色参考边界`);
  }
  references.forEach((reference) => ensureCharacterReferenceMatchesBoundary(reference, visualGuardrails));
}

function shotShowsCharacter(shot, characterName) {
  const structuredNames = [
    ...(shot?.startFrame?.characters || []),
    ...(shot?.endFrame?.characters || [])
  ].map((character) => String(character?.name || "").trim());
  if (structuredNames.length) return structuredNames.includes(characterName);
  return [shot?.startFramePrompt, shot?.endFramePrompt, shot?.videoPrompt, shot?.characterAction]
    .some((value) => String(value || "").includes(characterName));
}

function frameReferenceManifestPromptLines(manifest = {}, frameReferenceMode = "", context = {}) {
  const bindings = Array.isArray(manifest.promptBindings) ? manifest.promptBindings : [];
  const lines = bindings.map((binding) => `${binding.token}：${binding.description}`);
  const modeText = buildFrameReferenceModeText({
    shot: context.shot,
    frameKind: context.frameKind,
    frameReferenceMode,
    referenceManifest: manifest,
    sceneReference: context.sceneReference
  });
  return [...lines, ...String(modeText || "").split("\n").map((line) => line.trim()).filter(Boolean)];
}

function appendMissingLines(prompt, lines = []) {
  const additions = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter((line) => line && !String(prompt || "").includes(line));
  return additions.length ? [String(prompt || "").trim(), ...additions].filter(Boolean).join("\n") : String(prompt || "").trim();
}

function clampFrameImageCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(6, Math.max(1, number));
}

async function persistGeneratedImage(event, characterReference = {}, productionMedia = null) {
  const outputRoot = productionMedia?.imageOutputRoot || path.join(publicDir, "generated-images");
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const name = safeSegment(characterReference.characterName || "character");
  const index = Number(event.image_index) || 0;
  const extension = extensionForImage(config.jimeng.outputFormat || "png");
  const prefix = productionMedia?.filenamePrefix ? `${productionMedia.filenamePrefix}-` : "";
  const filename = `${prefix}${name}-reference-${stamp}-${index + 1}${extension}`;
  const file = path.join(outputRoot, filename);
  let bytes;
  if (event.b64_json) {
    bytes = Buffer.from(stripDataUrlPrefix(event.b64_json), "base64");
  } else if (event.url) {
    const imageResponse = await fetch(event.url, { signal: AbortSignal.timeout(60_000) });
    if (!imageResponse.ok) throw new JimengImageProviderError(`下载即梦图片失败（${imageResponse.status}）`);
    bytes = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new JimengImageProviderError("即梦流式事件没有返回图片数据");
  }
  const write = async () => {
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(file, bytes);
  };
  if (productionMedia) {
    // Downloading is outside the lock. A page close may remove the Run while
    // the provider is returning an image; it must not recreate deleted files.
    await productionRunCoordinator.withRunLock(productionMedia.projectId, productionMedia.runId, async () => {
      await productionStateStore.readManifest(productionMedia.projectId, productionMedia.runId);
      await write();
    });
  } else await write();
  return {
    filename,
    url: `${productionMedia?.imagePublicBasePath || "/generated-images"}/${filename}`,
    path: file,
    size: event.size || ""
  };
}

async function serveStatic(pathname, response, headOnly) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, "index.html")) return json(response, 403, { ok: false, error: "禁止访问" });
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, { "content-type": mime(path.extname(file)), "cache-control": "no-cache" });
    response.end(headOnly ? undefined : body);
  } catch {
    try {
      const body = await fs.readFile(path.join(publicDir, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(headOnly ? undefined : body);
    } catch {
      json(response, 404, { ok: false, error: "页面不存在" });
    }
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function streamErrorPayload(error = {}, fallbackMessage, extra = {}) {
  const source = error && typeof error === "object" ? error : {};
  const stage = inferCompilerErrorStage(source) || String(source.stage || "");
  const status = streamErrorStatus(source, stage);
  const metadata = compilerErrorMetadata(source);
  return {
    type: "error",
    ...extra,
    error: source.message || source.code || fallbackMessage,
    ...(status ? { status } : {}),
    ...(stage ? { stage } : {}),
    ...(source.category ? { category: String(source.category) } : {}),
    ...(metadata ? { metadata } : {}),
    ...(source.code ? { code: String(source.code) } : {})
  };
}

function streamErrorStatus(error = {}, compilerStage = "") {
  const explicitStatus = Number(error.status || error.statusCode);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) return explicitStatus;
  if (error instanceof ProductionStateError) return error.httpStatus;
  if (compilerStage) return compilerErrorStatus(error);
  if (
    error instanceof InputError
    || error instanceof JimengImageConfigError
    || error instanceof ShotVideoConfigError
  ) return 400;
  if (error.name === "AbortError" || error.name === "TimeoutError") return 504;
  return 502;
}

function mime(extension) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm"
  })[extension] || "application/octet-stream";
}

function safeSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "item";
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:[^;,]+;base64,/u, "");
}

function extensionForImage(format) {
  const normalized = String(format || "png").toLowerCase().replace(/^\./u, "");
  if (normalized === "jpg" || normalized === "jpeg") return ".jpg";
  if (normalized === "webp") return ".webp";
  return ".png";
}
