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
import { ClaudeClient } from "./src/claude-client.js";
import { JimengImageClient, JimengImageConfigError, JimengImageProviderError, buildCharacterReferenceImagePrompt } from "./src/jimeng-client.js";
import { WorkflowService } from "./src/workflow.js";
import {
  ANIMATION_PLAN_VERSION_UNSUPPORTED,
  STORYBOARD_PLAN_VERSION,
  isStoryboardPlan,
  legacyAnimationPlanMessage,
  legacyAnimationPlanVersion,
  storyboardPromptArtifactId
} from "./public/storyboard-plan.js";
import { characterPromptBoundaryMismatch, characterReferenceBoundaryMismatch, ensureCharacterPromptMatchesBoundary, ensureCharacterReferenceMatchesBoundary, ensureStoryCandidateContract, ensureStoryEntryCandidateContract, ensureThemeVariantsMatchProfile, extractFixedCharacterName, InputError, OutputContractError, requireAnimationPlanAspectRatio } from "./src/validation.js";
import { ONE_SENTENCE_EDIT_TARGETS, chosenRoleImageCount, oneSentenceEditDependents, oneSentenceEditInvalidation } from "./src/one-sentence-edit.js";
import { generateShotVideo, shotVideoGenerationPromptText, ShotVideoConfigError } from "./src/shot-video-generator.js";
import { resolveAuthoritativeShotVideoInput, resolveAuthoritativeShotVideoReferenceAssets, resolvePreviousShotFrameReference } from "./src/shot-video-continuity.js";
import {
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  normalizeShotVideoProvider,
  resolveShotVideoRequestResolution,
  resolveShotVideoSetting,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "./src/shot-video-providers.js";
import { AttemptStore } from "./src/attempt-store.js";
import {
  CAST_CONFIRMATION_API_PATH,
  CAST_PROPOSAL_API_PATH,
  handleCastApiRequest
} from "./src/cast-api.js";
import { CastOrchestrationService } from "./src/cast-orchestration.js";
import { serializeServerError } from "./src/server-error.js";
import { sanitizePublicMetadata } from "./src/model-errors.js";
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
import { currentDurableTaskContext, durableTaskHeartbeat, runWithDurableTaskContext } from "./src/durable-task-context.js";
import {
  REFERENCE_REWRITE_ARTIFACT_ID,
  REFERENCE_REWRITE_ARTIFACT_TYPE,
  REFERENCE_REWRITE_DEFAULT_SETTING,
  REFERENCE_REWRITE_SCHEMA_VERSION,
  REFERENCE_REWRITE_STAGE,
  REFERENCE_REWRITE_STEPS,
  REFERENCE_REWRITE_TASK_KIND
} from "./public/reference-rewrite.js";
import {
  REFERENCE_REWRITE_STEP_STALL_MS,
  buildReferenceRewriteMaterials,
  demoReferenceRewriteMaterials,
  referenceRewriteToolStatus
} from "./src/reference-rewrite-materials.js";
import { readModelUsageFromError, runWithUsageAccounting } from "./src/token-usage.js";
import { resolveBuildIdentity } from "./src/build-identity.js";
import { withProviderTokenCaps } from "./src/stage-token-caps.js";
import {
  PRODUCTION_REQUEST_HEADER_NAMES,
  productionRequestHeaders
} from "./public/production-lineage-client.js";
import { shotVideoArtifactIdFor } from "./public/shot-video-continuity.js";

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
// 普通阶段走 generateStageJson；原片来源提取复用 variants 配置但单独记日志。
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
  MODEL_OUTPUT_LOG_SCOPES.FULL_STORY_PROMISE_CHECK,
  // 自主分镜 4.0 的六个阶段同样走 coordinator，由 storyboard-workflow.js 接 attemptObserver。
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_CHARACTER_FACTS,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_DESIGN,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVIEW,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVISION,
  MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_REVIEW_FINAL,
  MODEL_OUTPUT_LOG_SCOPES.SHOT_VIDEO_PROMPT,
  // 参考片仿写（2026-10-24）同样走 coordinator，由 workflow 接 attemptObserver。
  MODEL_OUTPUT_LOG_SCOPES.REFERENCE_REWRITE,
  // 一句话修改（2026-10-11）同样走 coordinator，由 workflow 接 attemptObserver。
  MODEL_OUTPUT_LOG_SCOPES.ONE_SENTENCE_EDIT,
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
// 构造时校验 CLAUDE_API_EFFORT，写错就在这里启动失败，不回退。
const claudeClient = config.claude.enabled ? new ClaudeClient(config.claude) : null;
const jimengClient = config.jimeng.enabled ? new JimengImageClient(config.jimeng) : null;
const stageDefaults = buildStageDefaults(config, { mimoClient, qwenClient });
const modelStages = buildModelStages(stageDefaults, config);
const clients = { MiMo: mimoClient, Qwen: qwenClient, DeepSeek: deepseekClient, Claude: claudeClient };
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
    // 角色表情规则：页面 2026-10-09 起不再发送（由角色画风接替），服务端照旧接受；
    // 4.0 分镜把它原样记进 productionStrategy.characterExpressionRules。
    // 这里只拦明显非法的值，不裁决「这条规则写得好不好」。
    if (body?.characterExpressionRules !== undefined && !isValidCharacterExpressionRules(body.characterExpressionRules)) {
      throw new InputError(`characterExpressionRules 必须是不超过 ${CHARACTER_EXPRESSION_RULES_MAX_CHARS} 字符的字符串`);
    }
    assertCharacterArtStyleInput(body);
    return animationPromptCapture.run({
    route: "/api/animation-plan",
    variantId: body?.variant?.id,
    provider: String(body?.modelOverrides?.animationPlan?.provider || stageDefaults.animationPlan.provider || ""),
    traceContext: await animationPlanModelOutputTrace(request, body)
  }, () => body?.includeCompilerMetadata
      ? workflow.createAnimationPlanWithMetadata(body)
      : workflow.createAnimationPlan(body));
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
  // 导演助手（2026-10-09）：理解对话栏里打的字。只出建议——模型从页面送来的动作清单里选一个编号，
  // 不签发任何东西、不执行任何东西；执行只在用户点卡片上的「确认执行」之后，由页面调原有按钮。
  "/api/director-agent/turn": (body) => workflow.createDirectorAgentTurn(body),
  // 一句话修改（2026-10-11）：按用户在导演助手里说的原话写修改稿。**只出修改稿，不签发任何东西**；
  // 被改的那一份与它的上游由服务端从 Run 里读当前版本，请求里不收任何副本。采纳走
  // /api/production/one-sentence-edit/adopt，由服务端重新应用、核对摘要后签发。
  "/api/one-sentence-edit/draft": (body) => oneSentenceEditDraft(body),
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
      videoPromptSource: authoritativeInput.promptSource
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
  if (kind === REFERENCE_REWRITE_TASK_KIND) return referenceRewriteTaskDefinition({ projectId, runId, input });
  if (kind === "characterReferenceRefine") return characterReferenceRefineTaskDefinition({ projectId, runId, input });
  if (kind === "characterReferenceImages") return characterReferenceImagesTaskDefinition({ projectId, runId, input });
  if (kind === "shotVideo") return shotVideoTaskDefinition({ projectId, runId, input });
  // 旧的 shotVideoBatch / shotFrameImage / animationPromptRewrite 已于 2026-10-11 随旧 2.0/3.0 分镜删除：
  // 建新任务一律落到下面的 TASK_KIND_UNSUPPORTED；Task Store 不校验 kind，旧任务记录照常读出。
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
    modelStages: ["animationPlan"],
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
        animationPlanVersion: input.animationPlanVersion,
        targetAspectRatio: input.targetAspectRatio,
        backgroundMusicEnabled: input.backgroundMusicEnabled,
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
      assertSupportedAnimationPlan(planEntry.content);
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
          productionStrategy: plan.productionStrategy
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
          productionStrategy: plan.productionStrategy
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
      // 原来这里还把新外观同步进各镜的 startFramePrompt/endFramePrompt/videoPrompt/characterAction/
      // continuityNotes（syncShotCharacterReference，模块已删）。4.0 分镜的镜头行受严格 Schema 约束，
      // 没有这五个键，那次同步对 4.0 一直是空操作；旧 Plan 在上面 prepareInput 就已 409。
      updatedPlan.characterReferencePrompts[trustedInput.__roleIndex] = {
        ...previous,
        ...refinedFields,
        referenceImageAdded: true,
        referenceImageName: trustedInput.imageName,
        referenceImageDataUrl: trustedInput.imageDataUrl
      };
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
      assertSupportedAnimationPlan(planEntry.content);
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
        || buildCharacterReferenceImagePrompt(characterReference, count, {
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
      assertSupportedAnimationPlan(entry.content);
      if (!isStoryboardPlan(entry.content)) throw new InputError("只有新版自主分镜需要单独生成镜头提示词");
      return { plan: structuredClone(entry.content), shotId, planDigest: entry.lineage.contentDigest,
        target: { provider: target.provider, model: target.model }, modelOverrides: input.modelOverrides };
    },
    invoke: (trustedInput) => animationPromptCapture.run({ route: "shotVideoPrompt", variantId, provider: "" }, () => workflow.createShotVideoPrompt(trustedInput))
  });
}

// 参考片仿写（2026-10-24）：在参考视频的 Run 上，本机抽帧、去配乐、转写，再让模型写「原片拆解＋四篇剧本」，
// 提交 Artifact referenceRewrite。设计见 docs/reference-rewrite-2026-10-24.md。
// 创建前就把能确定的条件查完（视频 Run、绑着页面工作区、副本在、固定角色在、本机工具齐全），不满足 4xx、不建任务。
// 只出四稿：选中的一稿由用户填进「从剧情开始 · 粘贴完整故事」，这里不碰 storySource。
function referenceRewriteTaskDefinition({ projectId, runId, input }) {
  const targetDurationSeconds = Number(input.targetDurationSeconds);
  if (!isValidStoryDurationSeconds(targetDurationSeconds)) throw new InputError("targetDurationSeconds 必须是 20–180 的整数秒");
  return artifactRouteTaskDefinition({
    projectId, runId, kind: REFERENCE_REWRITE_TASK_KIND, pool: "workflow",
    artifactId: REFERENCE_REWRITE_ARTIFACT_ID, artifactType: REFERENCE_REWRITE_ARTIFACT_TYPE,
    dependencyIds: [], modelStages: [REFERENCE_REWRITE_STAGE], rawInput: input,
    prepareInput: async (run) => {
      assertRunEntryMode(run, "video");
      const workspaceId = String(run.metadata?.browserWorkspaceId || "");
      const sourceVideoDigest = String(run.metadata?.sourceVideoDigest || "").toLowerCase();
      if (!workspaceId || !sourceVideoDigest) {
        throw new ProductionStateError("参考片仿写要用页面上传的参考视频；这个 Run 没有绑定页面工作区或参考视频。", {
          code: "TASK_SOURCE_MEDIA_REQUIRED", httpStatus: 409
        });
      }
      const profile = plainObject(run.metadata?.creatorProfile);
      const creatorProfile = {
        fixedCharacter: String(profile.fixedCharacter || "").trim(),
        vertical: String(profile.vertical || "").trim(),
        constraints: String(profile.constraints || "").trim()
      };
      if (!creatorProfile.fixedCharacter || !creatorProfile.vertical) throw new InputError("参考片仿写需要固定角色与赛道，请先在「设定创作宇宙」里填好。");
      if (workflow.mode === "live") {
        await browserWorkspaceStore.getSource(workspaceId).catch((error) => {
          throw new ProductionStateError("参考视频副本不在了，请重新上传同一支视频。", {
            code: "TASK_SOURCE_MEDIA_REQUIRED", httpStatus: 409, cause: error
          });
        });
        const tools = await referenceRewriteHealth();
        if (!tools.available) {
          throw new ProductionStateError(tools.reason, { code: "REFERENCE_REWRITE_TOOLS_UNAVAILABLE", httpStatus: 409 });
        }
      }
      const videoName = String(run.metadata?.sourceVideo?.name || "");
      return {
        projectId,
        runId,
        workspaceId,
        sourceVideoDigest,
        creatorProfile,
        targetDurationSeconds,
        videoTitle: videoName.replace(/\.[A-Za-z0-9]{1,5}$/u, ""),
        demoDurationSeconds: Number(run.metadata?.sourceVideo?.duration) || targetDurationSeconds,
        modelOverrides: input.modelOverrides
      };
    },
    invoke: (trustedInput) => runReferenceRewrite(trustedInput)
  });
}

async function runReferenceRewrite(trusted) {
  const stepMax = REFERENCE_REWRITE_STEPS.length;
  const onStep = async (step) => {
    const stepIndex = REFERENCE_REWRITE_STEPS.findIndex((item) => item.key === step) + 1;
    await durableTaskHeartbeat({ step, stepIndex, stepMax }, { stallMs: REFERENCE_REWRITE_STEP_STALL_MS });
  };
  const materials = workflow.mode === "live"
    ? await buildReferenceRewriteMaterials({
      sourcePath: (await browserWorkspaceStore.getSource(trusted.workspaceId)).path,
      expectedDigest: trusted.sourceVideoDigest,
      workRoot: path.join(productionStateStore.runDirectory(trusted.projectId, trusted.runId), "media-work"),
      lifetimeFile: productionStateStore.manifestPath(trusted.projectId, trusted.runId),
      tools: config.referenceRewrite,
      onStep,
      heartbeat: () => durableTaskHeartbeat({}, { stallMs: REFERENCE_REWRITE_STEP_STALL_MS })
    })
    : demoReferenceRewriteMaterials(trusted.demoDurationSeconds);
  await onStep("write");
  const { result, metadata, settings } = await workflow.createReferenceRewrite({
    frames: materials.frames,
    contactSheets: materials.contactSheets,
    transcriptText: materials.transcriptText,
    durationSeconds: materials.durationSeconds,
    targetDurationSeconds: trusted.targetDurationSeconds,
    videoTitle: trusted.videoTitle,
    creatorProfile: trusted.creatorProfile,
    modelOverrides: trusted.modelOverrides
  });
  const call = metadata?.[REFERENCE_REWRITE_STAGE] || {};
  return {
    schemaVersion: REFERENCE_REWRITE_SCHEMA_VERSION,
    original: result.original,
    drafts: result.drafts,
    transcript: materials.transcriptText,
    materials: { ...materials.materials, durationSeconds: materials.durationSeconds, targetDurationSeconds: trusted.targetDurationSeconds },
    model: {
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort,
      providerCalls: Number(call.providerCalls) || 0,
      rejectedAttempts: Array.isArray(call.rejections) ? call.rejections.length : 0
    }
  };
}

// 本机工具状态缓存 30 秒：健康检查轮询时不必每次都跑 ffmpeg -version。
let referenceRewriteHealthCache = null;
async function referenceRewriteHealth() {
  if (workflow.mode !== "live") return { available: true, demo: true, reason: "", missing: [] };
  const now = Date.now();
  if (referenceRewriteHealthCache && now - referenceRewriteHealthCache.at < 30_000) return referenceRewriteHealthCache.value;
  const value = await referenceRewriteToolStatus(config.referenceRewrite);
  referenceRewriteHealthCache = { at: now, value };
  return value;
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
      assertSupportedAnimationPlan(planEntry.content);
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
    "/api/refine-character-reference": "characterReferenceRefine",
    "/api/generate-shot-video": "shotVideo"
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
        // 参考片仿写的本机工具（Bandit、whisper、ffmpeg）是否齐全；缺什么写在 reason 里，页面照抄。
        referenceRewrite: await referenceRewriteHealth(),
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
          // Claude 流式、不设总时长，这里报的是空闲超时。
          claudeStreamIdleMs: config.claude.streamIdleTimeoutMs
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
  console.log(`运行模式：${workflow.mode === "live" ? `${stageDefaults.analysis.provider} (${stageDefaults.analysis.model}) / 剧情 ${stageDefaults.fullStory.provider} ${stageDefaults.fullStory.model} / 动画 ${stageDefaults.animationPlan.provider} ${stageDefaults.animationPlan.model}` : "演示数据（配置 .env 后接入模型服务）"}`);
  // Qwen、MiMo 与 Claude 是流式，只判空闲、不设总时长；只有非流式的 DeepSeek 有总超时。
  console.log(`生成请求超时：连续 ${Math.round(config.qwen.streamIdleTimeoutMs / 1000)} 秒无数据（Qwen）/ 连续 ${Math.round(config.mimo.streamIdleTimeoutMs / 1000)} 秒无数据（MiMo）/ 总时长 ${Math.round(config.deepseek.requestTimeoutMs / 60000)} 分钟（DeepSeek）/ 连续 ${Math.round(config.claude.streamIdleTimeoutMs / 1000)} 秒无数据（Claude）`);
});

function buildStageDefaults(config, { mimoClient = null, qwenClient = null } = {}) {
  const provider = resolveDefaultLlmProvider(config);
  // 按阶段换成别家时，上限取那一家自己的阶段配置，不沿用默认供应商这一档（src/stage-token-caps.js）。
  // 同一张阶段表给每家各算一次，只取上限；模型名等其余字段仍只用默认供应商那份。
  return withReferenceRewriteDefault(withProviderTokenCaps(stageDefaultsFor(provider, config), {
    Qwen: stageDefaultsFor("Qwen", config),
    MiMo: stageDefaultsFor("MiMo", config),
    DeepSeek: stageDefaultsFor("DeepSeek", config),
    Claude: stageDefaultsFor("Claude", config)
  }));
}

function stageDefaultsFor(provider, config) {
  const source = provider === "Qwen"
    ? config.qwen
    : provider === "DeepSeek"
      ? config.deepseek
      : provider === "Claude"
        ? config.claude
        : config.mimo;
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
    // 只动这一个阶段，不碰全局默认（原分镜终审单独放宽 requestTimeoutMs 也是这个做法，该阶段已删除）。
    storyCandidateReview: stageSetting(
      provider,
      source.variantsModel || source.model,
      Math.max(Number(source.variantsMaxCompletionTokens || source.maxCompletionTokens) || 0, 32768)
    ),
    // 命题定向修订沿用候选阶段的 provider/model，与对照评审同规格。
    storyCandidateRevision: stageSetting(provider, source.variantsModel || source.model, source.variantsMaxCompletionTokens || source.maxCompletionTokens),
    fullStory: stageSetting(provider, source.storyModel || source.model, source.storyMaxCompletionTokens || source.maxCompletionTokens),
    animationPlan: stageSetting(provider, source.animationModel || source.storyModel || source.model, source.animationMaxCompletionTokens || source.maxCompletionTokens),
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
    // 一句话修改（2026-10-11）：沿用默认文本模型，不改思考设置。输出只有几处替换，
    // 但开思考的模型推理段可能很长，与按问题修改同规格把上限抬到 ≥32768，截断会让整份修改稿作废。
    oneSentenceEdit: stageSetting(
      provider,
      source.model,
      Math.max(Number(source.maxCompletionTokens) || 0, 32768)
    ),
    // 导演助手（2026-10-09）：沿用默认文本模型。输出只有一个动作编号加一两句话，
    // 调用时一律关闭思考（src/thinking-override.js），8192 足够。
    directorAgent: stageSetting(provider, source.model, 8192),
    // 参考片仿写（2026-10-24）：这里只为了让每家各算一份上限（Claude 128000、MiMo 131072）；
    // 供应商、型号与 effort 在 buildStageDefaults 里固定成 Claude Opus 5.5 xhigh，不跟随默认供应商。
    referenceRewrite: stageSetting(provider, source.model, source.maxCompletionTokens)
  };
}

// 参考片仿写的默认设置不跟随 DEFAULT_LLM_PROVIDER（10-23 对照实验只有 Claude Opus 5.5 xhigh 复现了效果）。
// Claude 没配置时页面显示这一步不可用、调用前 InputError，不自动换 MiMo；用户可在模型设置里显式改成 MiMo。
function withReferenceRewriteDefault(defaults) {
  const current = defaults[REFERENCE_REWRITE_STAGE] || {};
  const capByProvider = current.maxCompletionTokensByProvider || {};
  return {
    ...defaults,
    [REFERENCE_REWRITE_STAGE]: {
      ...current,
      provider: REFERENCE_REWRITE_DEFAULT_SETTING.provider,
      model: REFERENCE_REWRITE_DEFAULT_SETTING.model,
      effort: REFERENCE_REWRITE_DEFAULT_SETTING.effort,
      maxCompletionTokens: capByProvider[REFERENCE_REWRITE_DEFAULT_SETTING.provider] ?? current.maxCompletionTokens
    }
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
    throw new ShotVideoConfigError("镜头视频模型覆盖必须同时包含 provider 和 model。");
  }
  const overrideProvider = String(rawOverride?.provider || "").trim();
  const overrideModel = String(rawOverride?.model || "").trim();
  if (rawOverride !== undefined && (!overrideProvider || !overrideModel)) {
    throw new ShotVideoConfigError("镜头视频模型覆盖必须同时包含 provider 和 model。");
  }

  const requestedProvider = overrideProvider || String(body.videoProvider || "").trim();
  const requestedModel = overrideModel || String(body.videoModel || "").trim();
  const normalizedProvider = normalizeShotVideoProvider(requestedProvider);
  if (requestedProvider && !normalizedProvider) {
    throw new ShotVideoConfigError(`不支持镜头视频供应商“${requestedProvider}”：只支持 Seedance 或 MiniMax（可灵与自定义 VideoHTTP 已于 2026-10-11 删除）。`);
  }
  // 原来「只给 configPath、不给供应商」会走按配置文件推断的通用 worker 路由（只服务自定义 VideoHTTP），
  // 已随 VideoHTTP 删除。这里明确拒绝，不悄悄改用默认供应商去读那份配置文件。
  if (String(body.configPath || "").trim() && !requestedProvider) {
    throw new ShotVideoConfigError("指定供应商配置文件（configPath）时必须同时指定镜头视频供应商（Seedance 或 MiniMax）。");
  }

  const setting = resolveShotVideoSetting({
    provider: requestedProvider,
    model: requestedModel
  });
  if (!["Seedance", "MiniMax"].includes(setting.provider)) {
    throw new ShotVideoConfigError(`不支持镜头视频供应商“${setting.provider || requestedProvider}”：只支持 Seedance 或 MiniMax。`);
  }
  if (!isShotVideoModelAllowed(setting.provider, setting.model)) {
    throw new ShotVideoConfigError(`${setting.provider} 不支持镜头视频模型“${setting.model}”。`);
  }
  return setting;
}

// requestTimeoutMs 恒为 null：原来只有已删除的静态帧编译器、分镜终审与定向修订三个阶段单独放宽过它。
// 字段保留，workflow 读 override.requestTimeoutMs 的通路不变。
function stageSetting(provider, model, maxCompletionTokens) {
  const tokenNumber = maxCompletionTokens === null || maxCompletionTokens === undefined || maxCompletionTokens === ""
    ? null
    : Number(maxCompletionTokens);
  return {
    provider,
    model,
    maxCompletionTokens: Number.isFinite(tokenNumber) ? Math.round(tokenNumber) : null,
    requestTimeoutMs: null
  };
}

async function healthByProvider(clients, config) {
  const entries = await Promise.all(Object.entries({
    MiMo: { client: clients.MiMo, model: config.mimo.model, media: mediaSettingsForProvider("MiMo", config) },
    Qwen: { client: clients.Qwen, model: config.qwen.model, media: mediaSettingsForProvider("Qwen", config) },
    DeepSeek: { client: clients.DeepSeek, model: config.deepseek.model, media: mediaSettingsForProvider("DeepSeek", config) },
    Claude: { client: clients.Claude, model: config.claude.model, media: mediaSettingsForProvider("Claude", config) }
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
  return {
    ...Object.fromEntries(entries),
    Jimeng: {
      configured: config.jimeng.enabled,
      defaultModel: config.jimeng.model,
      reachable: false,
      modelAvailable: config.jimeng.enabled,
      status: 0
    },
    // 镜头视频只剩 Seedance 与 MiniMax（2026-10-11 删除可灵与自定义 VideoHTTP）。
    ...shotVideoProviderCatalog()
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
  if (provider === "DeepSeek" || provider === "Claude") {
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
    "shotVideo"
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
  if (pathname === "/api/production/one-sentence-edit/adopt") {
    return adoptOneSentenceEdit(body);
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
    assertBrowserCommittableArtifact(body);
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

// 2026-10-11 起只支持 4.0 自主分镜。读 Plan 的任务与路由遇到旧 2.0（首尾帧）/3.0（direct_shot）
// Plan 一律 409，照实报出版本，不当成 4.0 读取、不静默降级；重新生成 4.0 分镜（animationPlan 任务）
// 不读当前 Plan，不受这道守卫影响。判定只有一份，在 public/storyboard-plan.js。
function assertSupportedAnimationPlan(plan) {
  const version = legacyAnimationPlanVersion(plan);
  if (!version) return plan;
  throw new ProductionStateError(legacyAnimationPlanMessage(version), {
    code: ANIMATION_PLAN_VERSION_UNSUPPORTED,
    httpStatus: 409,
    details: [{ promptSchemaVersion: version }]
  });
}

// 浏览器通用提交口：拒收旧版 Animation Plan（与上面的消费守卫同一口径），也拒收新的首尾帧
// 出图产物 shotFrame:*（首尾帧出图已删除；磁盘上已有的旧产物不动、不读）。
function assertBrowserCommittableArtifact(body = {}) {
  const artifactId = normalizeArtifactId(body.artifactId);
  const artifactType = String(body.artifactType || "").trim();
  if (artifactId.startsWith("shotFrame:") || artifactType === "shotFrame") {
    throw new ProductionStateError("首尾帧出图已于 2026-10-11 删除，不再接受 shotFrame 产物。", {
      code: "SHOT_FRAME_ARTIFACT_UNSUPPORTED",
      httpStatus: 400,
      details: [{ artifactId, artifactType }]
    });
  }
  if (artifactType !== "animationPlan" && !artifactId.startsWith("animationPlan:")) return true;
  const content = body.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new ProductionStateError(`Animation Plan 内容必须是 ${STORYBOARD_PLAN_VERSION} 自主分镜对象。`, {
      code: ANIMATION_PLAN_VERSION_UNSUPPORTED,
      httpStatus: 400,
      details: [{ artifactId }]
    });
  }
  assertSupportedAnimationPlan(content);
  return true;
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
    animationPlanVersion: input.animationPlanVersion,
    targetAspectRatio: input.targetAspectRatio,
    backgroundMusicEnabled: input.backgroundMusicEnabled,
    includeCompilerMetadata: input.includeCompilerMetadata !== false,
    modelOverrides: input.modelOverrides,
    __storyEntry: storyEntryContextPayload(entry),
    __dependencies: storyEntryDependencyRefs(run, dependencyIds)
  };
}

// ---- 一句话修改（2026-10-11，导演 Agent 第三期）----
// 修改稿（/api/one-sentence-edit/draft）与采纳（/api/production/one-sentence-edit/adopt）共用一份上下文：
// 被改的那一份与它的上游一律由服务端从 Run 里读当前版本。请求里只收坐标、修改对象、基准版本，
// 以及参考视频 Run 的固定角色设定（核对角色边界签名要用）；出现剧情、分镜、提示词或任何上游副本就 400，
// 不让借修改把一份没签过的内容带进来。
const ONE_SENTENCE_EDIT_REQUEST_KEYS = Object.freeze({
  draft: ["projectId", "runId", "target", "variantId", "shotId", "baseRevision", "instruction", "creatorProfile", "modelOverrides"],
  adopt: ["projectId", "runId", "target", "variantId", "shotId", "baseRevision", "patches", "resultDigest", "creatorProfile"]
});
const ONE_SENTENCE_EDIT_LABELS = Object.freeze({ story: "剧情", storyboard: "分镜" });
// 改剧情或分镜时，这些下游正在生成也算「正忙」：它们还没有当前版本，不在作废清单里，
// 但写出来就是基于旧版本的，采纳会让它们白跑。
const ONE_SENTENCE_EDIT_DOWNSTREAM_KINDS = Object.freeze(["animationPlan", "shotVideoPrompt", "shotVideo", "characterImages"]);

function oneSentenceEditInputError(message, details = []) {
  return new ProductionStateError(message, { code: "ONE_SENTENCE_EDIT_INPUT_INVALID", httpStatus: 400, details });
}

function oneSentenceEditBaseChanged(message, details = []) {
  return new ProductionStateError(message, { code: "ONE_SENTENCE_EDIT_BASE_CHANGED", httpStatus: 409, details });
}

function oneSentenceEditArtifactId(target, variantId, shotId) {
  if (target === "story") return `fullStory:${variantId}`;
  if (target === "storyboard") return `animationPlan:${variantId}`;
  return storyboardPromptArtifactId(variantId, shotId);
}

async function assertNoActiveOneSentenceEditTasks({ projectId, runId, run, target, artifactId, variantId, shotId }) {
  const related = new Set([artifactId, ...oneSentenceEditDependents(run.latestArtifacts, artifactId)]);
  if (target === "shotPrompt") {
    related.add(shotVideoArtifactIdFor(variantId, shotId));
    related.add(`animationPlan:${variantId}`);
  }
  const downstream = (id) => {
    if (target === "shotPrompt") return false;
    const [kind, owner] = String(id).split(":");
    return ONE_SENTENCE_EDIT_DOWNSTREAM_KINDS.includes(kind) && owner === variantId;
  };
  const tasks = await durableTaskStore.listTasks({ projectId, runId, activeOnly: true });
  const busy = tasks.find((task) => (task.targetArtifactIds || []).some((id) => related.has(id) || downstream(id)));
  if (busy) {
    throw new ProductionStateError(`有相关的步骤正在进行（${busy.kind}），等它结束再改`, {
      code: "ONE_SENTENCE_EDIT_TASK_ACTIVE",
      httpStatus: 409,
      details: [{ taskId: busy.taskId, kind: busy.kind }]
    });
  }
}

async function prepareOneSentenceEdit(body, mode) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw oneSentenceEditInputError("请求必须是对象");
  const allowed = ONE_SENTENCE_EDIT_REQUEST_KEYS[mode];
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw oneSentenceEditInputError(
      `一句话修改的请求不能带 ${unexpected.join("、")}：剧情、分镜与提示词都由服务端从 Run 里读当前版本`,
      unexpected.map((key) => ({ key }))
    );
  }
  const target = body.target;
  if (!ONE_SENTENCE_EDIT_TARGETS.includes(target)) {
    throw oneSentenceEditInputError(`target 只能是 ${ONE_SENTENCE_EDIT_TARGETS.join("、")}`);
  }
  if (target !== "shotPrompt" && body.shotId !== undefined) throw oneSentenceEditInputError("只有改单镜提示词时才带 shotId");
  const projectId = safeIdentifier(body.projectId, "projectId");
  const runId = safeIdentifier(body.runId, "runId");
  const variantId = safeIdentifier(body.variantId, "variantId");
  const shotId = target === "shotPrompt" ? safeIdentifier(body.shotId, "shotId") : "";
  const baseRevision = safeIdentifier(body.baseRevision, "baseRevision");
  const artifactId = oneSentenceEditArtifactId(target, variantId, shotId);
  const label = target === "shotPrompt" ? `${shotId} 的提示词` : ONE_SENTENCE_EDIT_LABELS[target];
  const run = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
  const current = run.latestArtifacts?.[artifactId];
  if (!current?.lineage || current.lineage.status !== "current") {
    throw oneSentenceEditBaseChanged(`${label}没有当前版本，不能修改`, [{ artifactId }]);
  }
  if (current.lineage.revision !== baseRevision) {
    throw oneSentenceEditBaseChanged(`${label}已经更新（${baseRevision} → ${current.lineage.revision}），这份修改稿作废，请重新说一次`, [{
      artifactId, expectedRevision: baseRevision, actualRevision: current.lineage.revision
    }]);
  }
  // 改分镜读的就是当前 Plan：与其它读 Plan 的路由同一道版本守卫，旧 2.0/3.0 Plan 在这里 409。
  // 改剧情不读 Plan（只会让它过期），与重新生成分镜一样不受这道守卫影响。
  if (target === "storyboard") assertSupportedAnimationPlan(current.content);
  await assertNoActiveOneSentenceEditTasks({ projectId, runId, run, target, artifactId, variantId, shotId });

  const planId = `animationPlan:${variantId}`;
  const storyId = `fullStory:${variantId}`;
  let workflowInput;
  let storyEntry = null;
  if (target === "shotPrompt") {
    // 提示词的校验只看分镜与这一镜（与写提示词时同一套），不涉及剧情和角色边界。
    const plan = requireCurrentArtifact(run, planId);
    assertSupportedAnimationPlan(plan.content);
    if (current.content?.planDigest !== plan.lineage.contentDigest) {
      throw oneSentenceEditBaseChanged(`${label}对应的不是当前分镜，请先在镜头视频弹窗里重新写提示词`, [{ artifactId }]);
    }
    workflowInput = { target, shotId, animationPlan: plan.content, shotPrompt: current.content };
  } else if (isStoryEntryRun(run)) {
    const entry = trustedStoryEntryContext(run);
    assertStoryEntrySlot(variantId);
    assertStoryEntryProfileCopy(body, entry);
    const fromStorySource = isStorySourceDirectEntry(entry);
    const ids = ["visualGuardrails", storyId, ...(fromStorySource ? [] : [`variant:${variantId}`]), ...(target === "storyboard" ? [planId] : [])];
    const artifacts = currentArtifactContents(run, ids);
    workflowInput = {
      target,
      creatorProfile: entry.creatorProfile,
      visualGuardrails: artifacts.visualGuardrails,
      fullStory: artifacts[storyId],
      ...(fromStorySource ? {} : { variant: artifacts[`variant:${variantId}`] }),
      ...(target === "storyboard" ? { animationPlan: artifacts[planId] } : {})
    };
    storyEntry = storyEntryContextPayload(entry);
  } else {
    assertRunEntryMode(run, "video");
    if (!body.creatorProfile || typeof body.creatorProfile !== "object" || Array.isArray(body.creatorProfile)) {
      throw oneSentenceEditInputError("参考视频的 Run 改剧情或分镜时要带 creatorProfile，用来核对角色边界的签名");
    }
    const ids = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails", `variant:${variantId}`, storyId,
      ...(target === "storyboard" ? [planId] : [])];
    const artifacts = currentArtifactContents(run, ids);
    workflowInput = {
      target,
      creatorProfile: body.creatorProfile,
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief,
      visualGuardrails: artifacts.visualGuardrails,
      variant: artifacts[`variant:${variantId}`],
      fullStory: artifacts[storyId],
      ...(target === "storyboard" ? { animationPlan: artifacts[planId] } : {})
    };
  }
  if (target === "storyboard") {
    // 分镜是当前版本时它依赖的剧情必然也是当前版本（新剧情会把分镜标成过期），这里再核对一次精确版本。
    const storyRevision = requireCurrentArtifact(run, storyId).lineage.revision;
    const dependency = (current.lineage.dependencies || []).find((ref) => ref?.artifactId === storyId);
    if (dependency?.revision !== storyRevision) {
      throw oneSentenceEditBaseChanged("分镜对应的不是当前剧情，请先重新生成分镜", [{ artifactId, storyRevision }]);
    }
  }
  return { projectId, runId, target, variantId, shotId, artifactId, label, current, run, workflowInput, storyEntry };
}

function oneSentenceEditInvalidationFor({ run, target, variantId, artifactId }) {
  const plan = run.latestArtifacts?.[`animationPlan:${variantId}`];
  const roleImages = plan?.lineage?.status === "current" ? chosenRoleImageCount(plan.content) : 0;
  return oneSentenceEditInvalidation(run.latestArtifacts, artifactId, {
    roleImagesLost: target === "story" ? roleImages : 0,
    roleImagesKept: target === "storyboard" ? roleImages : 0
  });
}

// 只出修改稿，不签发任何东西。用户的原话只进这一次模型调用的提示词，不写进 Run、任务记录或日志以外的地方。
async function oneSentenceEditDraft(body) {
  const prepared = await prepareOneSentenceEdit(body, "draft");
  const draft = await workflow.createOneSentenceEdit({
    ...prepared.workflowInput,
    instruction: body.instruction,
    modelOverrides: body.modelOverrides
  }, { storyEntry: prepared.storyEntry });
  // 写稿可能要一两分钟：写完再核对一次基准版本，免得交出一份已经过期的修改稿。
  const latest = await productionStateStore.loadRun({ projectId: prepared.projectId, runId: prepared.runId, includeContent: false });
  const now = latest.latestArtifacts?.[prepared.artifactId]?.lineage;
  if (now?.revision !== prepared.current.lineage.revision || now?.status !== "current") {
    throw oneSentenceEditBaseChanged(`写修改稿期间${prepared.label}已经更新，这份修改稿作废，请重新说一次`, [{ artifactId: prepared.artifactId }]);
  }
  return {
    ...draft,
    artifactId: prepared.artifactId,
    variantId: prepared.variantId,
    baseRevision: prepared.current.lineage.revision,
    invalidation: draft.decision === "edit" ? oneSentenceEditInvalidationFor(prepared) : null
  };
}

// 采纳：服务端拿当前版本把同一组修改重新应用一遍、重新走签发校验，结果摘要必须等于修改稿上的那个，
// 才以与上一版完全相同的依赖签发新版本（剧情 Run 因此仍能导出 3.1 测试包）。分镜签发新的媒体命名空间。
async function adoptOneSentenceEdit(body) {
  const prepared = await prepareOneSentenceEdit(body, "adopt");
  const resultDigest = String(body.resultDigest || "");
  if (!/^[0-9a-f]{64}$/u.test(resultDigest)) throw oneSentenceEditInputError("resultDigest 必须是修改稿上的 64 位摘要");
  let applied;
  try {
    applied = workflow.applyOneSentenceEditPatches({ ...prepared.workflowInput, patches: body.patches }, { storyEntry: prepared.storyEntry });
  } catch (error) {
    if (!(error instanceof OutputContractError)) throw error;
    throw new ProductionStateError(`这份修改稿在当前版本上执行不了：${error.message}`, {
      code: "ONE_SENTENCE_EDIT_RESULT_MISMATCH", httpStatus: 409, details: error.details
    });
  }
  if (applied.resultDigest !== resultDigest) {
    throw new ProductionStateError("重新应用修改得到的结果与修改稿不一致，这份修改稿作废，请重新说一次", {
      code: "ONE_SENTENCE_EDIT_RESULT_MISMATCH", httpStatus: 409,
      details: [{ artifactId: prepared.artifactId, expectedDigest: resultDigest, actualDigest: applied.resultDigest }]
    });
  }
  const committed = await productionStateStore.commitArtifact({
    projectId: prepared.projectId,
    runId: prepared.runId,
    artifactId: prepared.artifactId,
    artifactType: prepared.current.lineage.artifactType,
    requestId: `one-sentence-edit-${randomUUID()}`,
    content: applied.content,
    dependencies: prepared.current.lineage.dependencies || [],
    expectedCurrentRevision: prepared.current.lineage.revision,
    ...(prepared.target === "storyboard" ? { createMediaNamespace: true } : {})
  });
  return {
    target: prepared.target,
    artifactId: prepared.artifactId,
    lineage: committed.lineage,
    staleArtifactIds: committed.staleArtifactIds || []
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
  // 镜头视频与角色参考图都从这里取 Plan：旧 2.0/3.0 Plan 在动任何媒体之前就 409。
  assertSupportedAnimationPlan(currentEntry.content);
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
    // 浏览器正常总会送 prompt（用户可编辑）；这里是它为空时的回退，画风取 4.0 分镜签发的
    // productionStrategy.artStyle（与浏览器预览同一份模板）。
    const prompt = String(body.prompt || "").trim()
      || buildCharacterReferenceImagePrompt(
        body.characterReference,
        count,
        {
          withReferenceImage: Boolean(body.referenceImageDataUrl),
          artStyle: body.animationPlan?.productionStrategy?.artStyle
        }
      );
    // 角色参考图是用户可改写提示词的环节：边界偏差只提醒，不阻断本次生成。
    // 成片渲染链路（/api/generate-shot-video）仍然硬失败。
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
  // 读任何 Plan 字段（角色参考项、画风）之前先拦旧版分镜：旧 Plan 一律 409，不因角色对不上先报 400。
  const plan = assertSupportedAnimationPlan(requireCurrentArtifact(run, planArtifactId).content);
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
      || buildCharacterReferenceImagePrompt(characterReference, count, {
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

// 原来还先看 v2 的 startFrame/endFrame 结构化角色与首尾帧提示词。4.0 镜头行受严格 Schema 约束，
// 没有这四个键（投影出的视频镜头同样没有），所以对 4.0 只剩下面两项，结果不变。
function shotShowsCharacter(shot, characterName) {
  return [shot?.videoPrompt, shot?.characterAction]
    .some((value) => String(value || "").includes(characterName));
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
  // 原来先用 inferCompilerErrorStage 识别编译器错误；三个编译器已删除，能走到这里的错误都只剩
  // 自带的 stage。状态码与 metadata 的判定照搬原来 server-error.js 里那两个函数，逐字不变。
  const stage = String(source.stage || "");
  const status = streamErrorStatus(source, stage);
  const metadata = streamErrorMetadata(source);
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

function streamErrorStatus(error = {}, stage = "") {
  const explicitStatus = Number(error.status || error.statusCode);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) return explicitStatus;
  if (error instanceof ProductionStateError) return error.httpStatus;
  if (stage) {
    const category = String(error.category || error.details?.category || error.metadata?.category || "protocol").toLowerCase();
    if (category === "config" || category === "input") return 400;
    if (category === "timeout") return 504;
    return 502;
  }
  if (
    error instanceof InputError
    || error instanceof JimengImageConfigError
    || error instanceof ShotVideoConfigError
  ) return 400;
  if (error.name === "AbortError" || error.name === "TimeoutError") return 504;
  return 502;
}

function streamErrorMetadata(error = {}) {
  if (error.metadata && typeof error.metadata === "object" && !Array.isArray(error.metadata)) {
    return sanitizePublicMetadata(error.metadata);
  }
  if (error.details?.metadata && typeof error.details.metadata === "object" && !Array.isArray(error.details.metadata)) {
    return sanitizePublicMetadata(error.details.metadata);
  }
  return null;
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
