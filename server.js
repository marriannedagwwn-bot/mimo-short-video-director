import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "./src/config.js";
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
import { ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION, characterPromptBoundaryMismatch, characterReferenceBoundaryMismatch, ensureCharacterPromptMatchesBoundary, ensureCharacterReferenceMatchesBoundary, ensureFrameReferenceModeCompatibility, ensureStoryCandidateContract, ensureThemeVariantsMatchProfile, InputError, requireAnimationPlanAspectRatio } from "./src/validation.js";
import { generateShotVideo, shotVideoGenerationPromptText, ShotVideoConfigError, ShotVideoProviderError } from "./src/shot-video-generator.js";
import { resolveAuthoritativeShotVideoInput, resolveAuthoritativeShotVideoReferenceAssets, resolvePreviousShotFrameReference } from "./src/shot-video-continuity.js";
import {
  inferShotVideoProvider,
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  normalizeShotVideoProvider,
  resolveShotVideoSetting,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "./src/shot-video-providers.js";
import {
  buildShotVideoBatchReferenceAssets,
  createShotVideoBatchItems,
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
import { ProductionStateStore } from "./src/production-state-store.js";
import { ProductionStateError, contentDigest, lineageRef, normalizeArtifactId, safeIdentifier } from "./src/production-lineage.js";
import { ProductionRunCoordinator } from "./src/production-run-coordinator.js";
import { DurableTaskStore, DURABLE_TASK_TERMINAL_STATUSES } from "./src/durable-task-store.js";
import { DurableTaskManager } from "./src/durable-task-manager.js";
import { runWithDurableTaskContext } from "./src/durable-task-context.js";
import { readModelUsageFromError, runWithUsageAccounting } from "./src/token-usage.js";
import { resolveBuildIdentity } from "./src/build-identity.js";
import {
  PRODUCTION_REQUEST_HEADER_NAMES,
  productionRequestHeaders
} from "./public/production-lineage-client.js";
import {
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
  shotVideoArtifactIdFor
} from "./public/shot-video-continuity.js";
import { syncShotCharacterReference } from "./public/character-reference-sync.js";

loadEnv();
const root = path.dirname(fileURLToPath(import.meta.url));
const config = getConfig();
const buildIdentity = resolveBuildIdentity({ workspaceRoot: root });
const partialRepairDebugWriter = new PartialRepairDebugWriter({
  outputRoot: process.env.PARTIAL_REPAIR_DEBUG_DIR
    || path.join(root, "debug", "partial-repairs")
});
const fullModelOutputLogWriter = new FullModelOutputLogWriter({
  ...buildIdentity,
  outputRoot: await resolvePrivateModelOutputLogRoot({
    workspaceRoot: root,
    configuredValue: process.env.FULL_STORY_MODEL_OUTPUT_LOG_DIR,
    servedRoot: path.join(root, "public")
  })
});
const animationModelOutputLogWriter = new FullModelOutputLogWriter({
  ...buildIdentity,
  scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN,
  outputRoot: await resolvePrivateModelOutputLogRoot({
    workspaceRoot: root,
    configuredValue: process.env.ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR,
    servedRoot: path.join(root, "public"),
    environmentVariableName: "ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR",
    logLabel: "Animation Plan 模型全量输出"
  })
});
// 走 generateValidatedJson 的六个阶段共用一个 root，按 stage 各建一个 writer；
// 不配置 STAGE_MODEL_OUTPUT_LOG_DIR 就完全不写。
const STAGE_MODEL_OUTPUT_LOG_SCOPES = [
  MODEL_OUTPUT_LOG_SCOPES.ANALYSIS,
  MODEL_OUTPUT_LOG_SCOPES.RECONSTRUCTION,
  MODEL_OUTPUT_LOG_SCOPES.BRIEF,
  MODEL_OUTPUT_LOG_SCOPES.VARIANTS,
  MODEL_OUTPUT_LOG_SCOPES.VISUAL_GUARDRAILS,
  MODEL_OUTPUT_LOG_SCOPES.CHARACTER_REFERENCE
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
  new FullModelOutputLogWriter({
    ...buildIdentity,
    scope,
    outputRoot: stageModelOutputLogRoot
  })
]));
const animationPromptCapture = new AnimationPromptCapture({
  outputRoot: process.env.ANIMATION_PROMPT_CAPTURE_DIR || "",
  modelOutputLogWriter: animationModelOutputLogWriter
});
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

async function fullStoryModelOutputTrace(request, body = {}) {
  if (!fullModelOutputLogWriter.enabled) return null;
  const result = await resolveFullStoryModelOutputTrace({
    headers: request?.headers || {},
    variantId: body?.variant?.id,
    loadRun: (input) => productionStateStore.loadRun(input)
  });
  if (result.warning) console.warn(result.warning);
  return result.context;
}

async function animationPlanModelOutputTrace(request, body = {}) {
  if (!animationModelOutputLogWriter.enabled) return null;
  const result = await resolveAnimationPlanModelOutputTrace({
    headers: request?.headers || {},
    variantId: body?.variant?.id,
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
  "/api/variants": (body) => workflow.createVariants(body),
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
        productionMedia.planEntry.content
      ),
      animationPromptSchemaVersion: authoritativeInput.promptSchemaVersion,
      videoPromptSource: authoritativeInput.promptSource,
      videoPromptProfile: structuredClone(
        productionMedia.planEntry.content?.productionStrategy?.videoPromptProfile || null
      )
    };
    const visualGuardrails = workflow.assertGlobalCharacterBoundary(body);
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
        filenamePrefix: productionMedia.filenamePrefix
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
    dependencyIds: ["creativeBrief", "visualGuardrails"],
    route: "/api/variants",
    buildInput: (raw, artifacts) => ({
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief,
      visualGuardrails: artifacts.visualGuardrails,
      creatorProfile: raw.creatorProfile,
      count: raw.count,
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
  if (["analyze", "reconstruct", "brief", "visualGuardrails"].includes(kind)) {
    const stage = DIRECTOR_PIPELINE_STAGES.find((item) => item.taskKind === kind);
    return pipelineStageTaskDefinition({ projectId, runId, raw: input, stage });
  }
  if (kind === "variants") return standaloneVariantsTaskDefinition({ projectId, runId, input });
  if (kind === "fullStory") return fullStoryTaskDefinition({ projectId, runId, input });
  if (kind === "animationPlan") return animationPlanTaskDefinition({ projectId, runId, input });
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
        progress: { completedStages: 0, totalStages: DIRECTOR_PIPELINE_STAGES.length }
      };
    },
    execute: async (raw, context) => {
      const completed = [];
      const usages = [];
      for (const stage of DIRECTOR_PIPELINE_STAGES) {
        const snapshot = await productionStateStore.loadRun({ projectId, runId, includeContent: true });
        const existing = snapshot.latestArtifacts?.[stage.artifactId];
        if (existing?.lineage?.status === "current") {
          completed.push(lineageRef(existing.lineage));
          await context.heartbeat({
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
        progress: { completedStages: DIRECTOR_PIPELINE_STAGES.length, totalStages: DIRECTOR_PIPELINE_STAGES.length },
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
        modelOverrides: input.modelOverrides
      };
    },
    invoke: (trustedInput, request) => routes["/api/full-story"](trustedInput, { request })
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
        animationPlanMode: input.animationPlanMode || "direct_shot",
        targetAspectRatio: input.targetAspectRatio,
        backgroundMusicEnabled: input.backgroundMusicEnabled,
        videoPromptTarget: input.videoPromptTarget,
        includeCompilerMetadata: input.includeCompilerMetadata !== false,
        modelOverrides: input.modelOverrides
      };
    },
    invoke: (trustedInput, request) => routes["/api/animation-plan"](trustedInput, { request })
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
        creatorProfile: input.creatorProfile,
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
      const { __plan, __roleIndex, __dependencies, ...routeInput } = trustedInput;
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
        || buildCharacterReferenceImagePrompt(characterReference, count, planEntry.content?.visualBible || null);
      return {
        input: {
          count,
          prompt,
          promptDigest: contentDigest(prompt),
          referenceImageDataUrl: input.referenceImageDataUrl,
          characterReference: stripReferenceImageData(characterReference),
          creatorProfile: input.creatorProfile,
          referenceAnalysis: requireCurrentArtifact(run, "referenceAnalysis").content,
          sourceScriptReconstruction: requireCurrentArtifact(run, "sourceScriptReconstruction").content,
          creativeBrief: requireCurrentArtifact(run, "creativeBrief").content,
          visualGuardrails: requireCurrentArtifact(run, "visualGuardrails").content,
          selectedVariant: requireCurrentArtifact(run, `variant:${variantId}`).content,
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
  const visualGuardrails = workflow.assertGlobalCharacterBoundary(input);
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

function shotVideoTaskDefinition({ projectId, runId, input }) {
  const variantId = safeIdentifier(input.variantId || input.selectedVariantId, "variantId");
  const shotId = safeIdentifier(input.shotId || input.shot?.shotId, "shotId");
  const artifactId = shotVideoArtifactIdFor(variantId, shotId);
  const planArtifactId = `animationPlan:${variantId}`;
  const setting = shotVideoRequestSetting(input);
  return artifactRouteTaskDefinition({
    projectId,
    runId,
    kind: "shotVideo",
    pool: "media",
    artifactId,
    artifactType: "shotVideo",
    dependencyIds: [],
    modelStages: [],
    modelSnapshot: { shotVideo: { provider: setting.provider, model: setting.model } },
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
  return {
    projectId,
    runId,
    kind: "shotVideoBatch",
    pool: "media",
    modelSnapshot: { shotVideo: { provider: setting.provider, model: setting.model } },
    prepare: async ({ run }) => {
      const planEntry = requireCurrentArtifact(run, planArtifactId);
      assertCompatibleProductionContext(input.productionContext, { projectId, runId, entry: planEntry });
      const plan = planEntry.content || {};
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
      const firstPendingIndex = items.findIndex((item) => item.status !== "completed");
      if (firstPendingIndex >= 0) {
        const firstPendingShot = shots[firstPendingIndex];
        const hasCharacterReference = buildShotVideoBatchReferenceAssets(
          firstPendingShot,
          plan.characterReferencePrompts || []
        ).length > 0;
        const previousArtifactReady = firstPendingIndex > 0
          && run.latestArtifacts?.[targetArtifactIds[firstPendingIndex - 1]]?.lineage?.status === "current";
        if (!hasCharacterReference && !previousArtifactReady) {
          throw new ProductionStateError(
            `镜头 ${firstPendingShot.shotId} 没有角色参考图，也没有可复用的上一镜视频；全能参考模式至少需要一项视觉参考。`,
            { code: "SHOT_VIDEO_BATCH_REFERENCE_REQUIRED" }
          );
        }
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
          includePreviousShotFrames: input.includePreviousShotFrames !== false,
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
        modelSnapshot: { shotVideo: { provider: setting.provider, model: setting.model } },
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
        const referenceAssets = buildShotVideoBatchReferenceAssets(
          shot,
          trusted.plan.characterReferencePrompts || []
        );
        if (!referenceAssets.length && !(trusted.includePreviousShotFrames && previousReady)) {
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
              continuityReferenceMode: trusted.includePreviousShotFrames && previousReady
                ? SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
                : SHOT_VIDEO_CONTINUITY_NONE,
              aspectRatio: requireAnimationPlanAspectRatio(trusted.plan),
              animationPromptSchemaVersion: trusted.plan.promptSchemaVersion || "",
              shotId,
              referenceAssets,
              productionContext: trusted.productionContext,
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
    { prices: config.modelPrices }
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
  throw new ProductionStateError("继续该阶段需要重新上传同一源视频（服务重启后大型媒体不会持久化）。", {
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
    const serialized = serializeServerError(error, { attemptStore });
    if (serialized.log) console.error(serialized.log);
    // 失败前已经花掉的 token 照样如实回报，挂在信封上不进 body 的任何业务字段。
    const usage = readModelUsageFromError(error);
    return json(response, serialized.status, usage ? { ...serialized.body, usage } : serialized.body);
  }
});

server.requestTimeout = config.serverRequestTimeoutMs;

await durableTaskManager.reconcileInterruptedTasks();

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
  console.log(`生成请求超时：${Math.round(config.qwen.requestTimeoutMs / 60000)} 分钟（Qwen）/ ${Math.round(config.mimo.requestTimeoutMs / 60000)} 分钟（MiMo）/ ${Math.round(config.deepseek.requestTimeoutMs / 60000)} 分钟（DeepSeek）`);
});

function buildStageDefaults(config, { mimoClient = null, qwenClient = null } = {}) {
  const provider = qwenClient ? "Qwen" : "MiMo";
  const source = provider === "Qwen" ? config.qwen : config.mimo;
  return {
    analysis: stageSetting(provider, source.analysisModel || source.videoModel || source.model, source.analysisMaxCompletionTokens || source.maxCompletionTokens),
    reconstruction: stageSetting(provider, source.reconstructionModel || source.videoModel || source.model, source.reconstructionMaxCompletionTokens || source.maxCompletionTokens),
    brief: stageSetting(provider, source.briefModel || source.model, source.briefMaxCompletionTokens || source.maxCompletionTokens),
    visualGuardrails: stageSetting(provider, source.visualModel || source.videoModel || source.model, source.visualMaxCompletionTokens || source.maxCompletionTokens),
    variants: stageSetting(provider, source.variantsModel || source.model, source.variantsMaxCompletionTokens || source.maxCompletionTokens),
    fullStory: stageSetting(provider, source.storyModel || source.model, source.storyMaxCompletionTokens || source.maxCompletionTokens),
    animationPlan: stageSetting(provider, source.animationModel || source.storyModel || source.model, source.animationMaxCompletionTokens || source.maxCompletionTokens),
    staticFrameCompiler: stageSetting(
      config.staticFrameCompiler.provider,
      config.staticFrameCompiler.model,
      config.staticFrameCompiler.maxCompletionTokens,
      config.staticFrameCompiler.requestTimeoutMs
    ),
    characterReference: stageSetting(provider, source.characterReferenceModel || source.videoModel || source.model, source.characterReferenceMaxCompletionTokens || source.maxCompletionTokens)
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
    return productionStateStore.createRun({
      projectId: body.projectId,
      metadata: {
        sourceVideo: plainObject(body.metadata?.sourceVideo),
        sourceVideoDigest: String(body.metadata?.sourceVideoDigest || "").trim().toLowerCase(),
        creatorProfile: plainObject(body.metadata?.creatorProfile),
        transcript: String(body.metadata?.transcript || ""),
        startedBy: "browser-workflow"
      }
    });
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
    return productionStateStore.importPackage(body.package);
  }
  throw new ProductionStateError("生产状态接口不存在", {
    code: "PRODUCTION_ROUTE_NOT_FOUND",
    httpStatus: 404
  });
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
  return {
    planArtifactId,
    planEntry: currentEntry,
    latestArtifacts: run.latestArtifacts || {},
    imageOutputRoot: path.join(publicDir, "generated-images", ...namespaceSegments),
    imagePublicBasePath: `/generated-images/${publicNamespace}`,
    videoOutputRoot: path.join(publicDir, "generated-videos", ...namespaceSegments),
    videoPublicBasePath: `/generated-videos/${publicNamespace}`,
    filenamePrefix: `${safeIdentifier(planRevision, "planRevision")}-${planDigest.slice(0, 12)}`,
    planAspectRatio
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
        body.animationPlan?.visualBible || body.visualBible || null
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
      || buildCharacterReferenceImagePrompt(characterReference, count, plan.visualBible || null)
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
  await fs.mkdir(outputRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const name = safeSegment(characterReference.characterName || "character");
  const index = Number(event.image_index) || 0;
  const extension = extensionForImage(config.jimeng.outputFormat || "png");
  const prefix = productionMedia?.filenamePrefix ? `${productionMedia.filenamePrefix}-` : "";
  const filename = `${prefix}${name}-reference-${stamp}-${index + 1}${extension}`;
  const file = path.join(outputRoot, filename);
  if (event.b64_json) {
    await fs.writeFile(file, Buffer.from(stripDataUrlPrefix(event.b64_json), "base64"));
  } else if (event.url) {
    const imageResponse = await fetch(event.url, { signal: AbortSignal.timeout(60_000) });
    if (!imageResponse.ok) throw new JimengImageProviderError(`下载即梦图片失败（${imageResponse.status}）`);
    await fs.writeFile(file, Buffer.from(await imageResponse.arrayBuffer()));
  } else {
    throw new JimengImageProviderError("即梦流式事件没有返回图片数据");
  }
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
