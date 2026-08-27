import { ANALYSIS_SYSTEM_PROMPT, ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SYSTEM_PROMPT, RECONSTRUCTION_SYSTEM_PROMPT, analysisPrompt, animationActionStateAuditPrompt, animationFoundationPrompt, animationShotBatchPatchPrompt, animationShotBatchPrompt, animationVideoPromptRewritePrompt, animationVideoPromptRewriteSemanticAuditPrompt, briefPrompt, characterReferenceRefinePrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "./prompts.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "./mock.js";
import { AnimationPromptCompilerError, COMPILED_ANIMATION_SHOT_ALIAS_FIELDS, compileAnimationShotPrompts, normalizeAnimationShotPrompts, rebuildAnimationShotPrompts } from "./animation-prompt-compiler.js";
import { compileCharacterFeatures } from "./character-feature-compiler.js";
import { AttemptStore } from "./attempt-store.js";
import {
  fullStoryPartialRepairPrompt,
  mergeFullStoryPartialRepair,
  planFullStoryPartialRepair
} from "./full-story-partial-repair.js";
import {
  FULL_STORY_BEAT_SCENE_POSTPASS_STAGE,
  createFullStoryBeatScenePostpassPlan,
  fullStoryBeatScenePostpassPrompt,
  mergeFullStoryBeatScenePostpass
} from "./full-story-beat-scene-postpass.js";
import {
  animationFoundationPartialRepairPrompt,
  mergeAnimationFoundationPartialRepair,
  planAnimationFoundationPartialRepair
} from "./animation-foundation-partial-repair.js";
import {
  animationVideoPromptSemanticAuditDiagnostics,
  animationVideoPromptSemanticAuditCatalogPayload,
  createAnimationVideoPromptSemanticAuditCatalog,
  deriveAnimationVideoPromptSemanticAuditOverall,
  validateAnimationVideoPromptSemanticAuditResponse
} from "./animation-video-prompt-semantic-audit.js";
import {
  animationVideoPromptSemanticRepairPrompt,
  mergeAnimationVideoPromptSemanticRepair,
  planAnimationVideoPromptSemanticRepair
} from "./animation-video-prompt-semantic-repair.js";
import { randomUUID } from "node:crypto";
import { ModelCallCoordinator, classifyAttemptError } from "./model-call-coordinator.js";
import { ModelResponseError } from "./mimo-client.js";
import { STATIC_FRAME_COMPILER_VERSION, StaticFrameCompilerCandidateError, compileStaticFrames } from "./static-frame-compiler.js";
import { ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION, ANIMATION_DIRECT_SHOT_MODE, InputError, OutputContractError, BACKGROUND_MUSIC_NONE, NO_BACKGROUND_MUSIC_SENTENCE, animationFrameCameraFields, characterReferenceBoundaryMismatch, characterReferenceRestorableMissingTraits, ensureAnimationFoundationContract, ensureAnimationPlanMatchesProfile, ensureAnimationPlanV2Contract, ensureAnimationPlanVideoPromptProfile, ensureAnimationShotBatchContract, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, ensureVisualGuardrailsMatchesProfile, hasExplicitStandardNameSuffix, materializeGlobalCharacterBoundaryViews, normalizeGlobalCharacterBoundaryTerms, normalizeBackgroundMusicMode, pruneAnimationPlanNegativePrompts, requireAnimationPlanAspectRatio, requireFrames, requireObject, requireText } from "./validation.js";
import {
  deriveDirectShotSkeleton,
  directShotSkeletonForScenes,
  directShotSkeletonRuntimeSeconds,
  formatDirectShotSkeleton
} from "./direct-shot-timeline.js";
import { resolveVideoPromptProfile } from "../public/video-prompt-profiles.js";
import { CharacterBoundaryError, createCharacterBoundaryKey, sealGlobalCharacterBoundary, verifyGlobalCharacterBoundary } from "./character-boundary.js";
import {
  ReconstructionGroundingError,
  createGroundingKey,
  groundingContextDigest,
  sealReconstruction,
  sealReferenceAnalysis,
  verifyReconstructionSeal,
  verifyReferenceAnalysis
} from "./reconstruction-grounding.js";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_ANIMATION_BATCH_SCENE_COUNT = 2;

export class WorkflowService {
  constructor({
    client = null,
    clients = null,
    stageDefaults = null,
    storyClient = null,
    storyModel = "mimo-v2.5-pro",
    storyMaxCompletionTokens = 12288,
    storyProvider = "MiMo",
    animationClient = null,
    animationModel = "mimo-v2.5-pro",
    animationMaxCompletionTokens = 12288,
    animationProvider = "MiMo",
    staticFrameCompilerModel = "",
    staticFrameCompilerMaxCompletionTokens = 4096,
    staticFrameCompilerTimeoutMs = 300000,
    staticFrameCompilerProvider = "",
    animationShotBatchSceneCount = DEFAULT_ANIMATION_BATCH_SCENE_COUNT,
    groundingKey = null,
    characterBoundaryKey = null,
    characterBoundarySignatureRequired = true,
    attemptStore = null,
    modelCallCoordinator = null,
    partialRepairDebugWriter = null,
    fullModelOutputLogWriter = null,
    stageModelOutputLogWriters = null
  } = {}) {
    this.clients = normalizeClients(clients);
    if (client && !Object.keys(this.clients).length) this.clients.MiMo = client;
    if (storyClient) this.clients[canonicalProvider(storyProvider)] = storyClient;
    if (animationClient) this.clients[canonicalProvider(animationProvider)] = animationClient;
    this.stageDefaults = normalizeStageDefaults(stageDefaults, {
      provider: client ? "MiMo" : firstClientProvider(this.clients),
      storyProvider,
      storyModel,
      storyMaxCompletionTokens,
      animationProvider,
      animationModel,
      animationMaxCompletionTokens,
      staticFrameCompilerProvider,
      staticFrameCompilerModel,
      staticFrameCompilerMaxCompletionTokens,
      staticFrameCompilerTimeoutMs
    });
    this.client = this.resolveStage("analysis").client;
    const storyStage = this.resolveStage("fullStory");
    this.storyClient = storyStage.client;
    this.storyModel = storyStage.model;
    this.storyMaxCompletionTokens = storyStage.maxCompletionTokens;
    this.storyProvider = storyStage.provider;
    const animationStage = this.resolveStage("animationPlan");
    this.animationClient = animationStage.client;
    this.animationModel = animationStage.model;
    this.animationMaxCompletionTokens = animationStage.maxCompletionTokens;
    this.animationProvider = animationStage.provider;
    const staticFrameCompilerStage = this.resolveStage("staticFrameCompiler");
    this.staticFrameCompilerClient = staticFrameCompilerStage.client;
    this.staticFrameCompilerModel = staticFrameCompilerStage.model;
    this.staticFrameCompilerMaxCompletionTokens = staticFrameCompilerStage.maxCompletionTokens;
    this.staticFrameCompilerTimeoutMs = staticFrameCompilerStage.requestTimeoutMs;
    this.staticFrameCompilerProvider = staticFrameCompilerStage.provider;
    this.animationShotBatchSceneCount = normalizeBatchSize(animationShotBatchSceneCount);
    this.groundingKey = groundingKey || createGroundingKey();
    this.characterBoundaryKey = characterBoundaryKey || createCharacterBoundaryKey();
    this.characterBoundarySignatureRequired = characterBoundarySignatureRequired !== false;
    this.attemptStore = attemptStore instanceof AttemptStore
      ? attemptStore
      : new AttemptStore();
    this.modelCallCoordinator = modelCallCoordinator instanceof ModelCallCoordinator
      ? modelCallCoordinator
      : new ModelCallCoordinator({ attemptStore: this.attemptStore });
    this.partialRepairDebugWriter = partialRepairDebugWriter;
    this.fullModelOutputLogWriter = fullModelOutputLogWriter
      && typeof fullModelOutputLogWriter.recordAttempt === "function"
      ? fullModelOutputLogWriter
      : null;
    // 走 generateValidatedJson 的阶段各自一个 writer，键就是 stage id；没有配置就是 null。
    this.stageModelOutputLogWriters = stageModelOutputLogWriters instanceof Map
      ? stageModelOutputLogWriters
      : null;
  }

  get mode() {
    return this.hasLiveClient ? "live" : "demo";
  }

  async beginPartialRepairDebug(payload) {
    return safePartialRepairDebugCall(
      this.partialRepairDebugWriter,
      "begin",
      payload
    );
  }

  async recordPartialRepairDebugResponse(session, response) {
    if (!session) return null;
    return safePartialRepairDebugCall(
      this.partialRepairDebugWriter,
      "recordResponse",
      session,
      response
    );
  }

  async recordPartialRepairDebugResult(session, result) {
    if (!session) return null;
    return safePartialRepairDebugCall(
      this.partialRepairDebugWriter,
      "recordResult",
      session,
      result
    );
  }

  async preparePartialRepairDebug({ promptFactory, ...debugPayload }) {
    let repairPrompt = "";
    let promptError = null;
    try {
      repairPrompt = promptFactory();
    } catch (error) {
      promptError = error;
    }
    const debugSession = await this.beginPartialRepairDebug({
      ...debugPayload,
      repairPrompt
    });
    if (promptError) {
      await this.recordPartialRepairDebugResult(debugSession, {
        status: "rejected",
        error: promptError
      });
      throw promptError;
    }
    return { repairPrompt, debugSession };
  }

  get hasLiveClient() {
    return Object.values(this.clients).some(Boolean);
  }

  resolveStage(stage, input = {}) {
    const defaults = this.stageDefaults[stage] || {};
    const override = stageOverride(input, stage);
    const provider = canonicalProvider(override.provider || defaults.provider);
    let model = String(override.model || defaults.model || "").trim();
    if (requiresMediaModel(stage) && provider === "Qwen" && isKnownQwenTextOnlyModel(model)) {
      const fallbackModel = String(defaults.model || "").trim();
      if (fallbackModel && !isKnownQwenTextOnlyModel(fallbackModel)) model = fallbackModel;
    }
    const maxCompletionTokens = finiteNumber(override.maxCompletionTokens, defaults.maxCompletionTokens);
    return {
      provider,
      model,
      maxCompletionTokens,
      requestTimeoutMs: finiteNumber(override.requestTimeoutMs, defaults.requestTimeoutMs),
      client: provider ? this.clients[provider] || null : null
    };
  }

  async analyze(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    let resolvedMediaMode = this.hasLiveClient ? null : "frames";
    const retryContext = {
      stage: "referenceAnalysis",
      mediaMode: resolvedMediaMode,
      videoDurationSeconds: Math.max(0, Number(input.metadata?.duration) || 0),
      frameCount: input.frames.length
    };
    const validate = (value) => {
      if (Object.prototype.hasOwnProperty.call(value || {}, "groundingSeal")) {
        throw new OutputContractError("referenceAnalysis.groundingSeal 由服务端附加，模型不得输出");
      }
      const analysis = ensureOutputContract(value, "referenceAnalysis");
      try {
        return sealReferenceAnalysis(analysis, input, this.groundingKey, {
          allowedEvidenceSources: evidenceSourcesForMediaMode(resolvedMediaMode)
        });
      } catch (error) {
        if (error instanceof ReconstructionGroundingError) {
          const contractError = new OutputContractError(error.message);
          contractError.code = error.code;
          throw contractError;
        }
        throw error;
      }
    };
    if (!this.hasLiveClient) return validate(mockAnalysis(input));
    const runAnalysis = ({ promptInput, video }) => this.generateStageJson("analysis", input, {
        prompt: analysisPrompt(promptInput),
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        frames: input.frames,
        video,
        onResolvedMediaMode: (mode) => {
          resolvedMediaMode = mode;
          retryContext.mediaMode = mode;
        },
        retryContext,
        validate
      });
    try {
      return await runAnalysis({ promptInput: input, video: input.video });
    } catch (error) {
      const canFallbackToFrames = error instanceof OutputContractError
        && error.code === "VIDEO_EVIDENCE_TIME_INVALID"
        && resolvedMediaMode === "video"
        && input.frames.length > 0;
      if (!canFallbackToFrames) throw error;
      resolvedMediaMode = "frames";
      retryContext.mediaMode = "frames";
      return runAnalysis({ promptInput: { ...input, video: null }, video: null });
    }
  }

  async reconstruct(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    const groundingContext = {
      transcript: input.transcript || "",
      frames: input.frames,
      video: input.video,
      metadata: input.metadata || {}
    };
    let contextDigest = groundingContextDigest(groundingContext);
    let trustedReferenceAnalysis = input.referenceAnalysis;
    try {
      if (input.referenceAnalysis.groundingSeal) {
        const verified = verifyReferenceAnalysis(input.referenceAnalysis, this.groundingKey, groundingContext);
        trustedReferenceAnalysis = verified.referenceAnalysis;
        contextDigest = verified.contextDigest;
      } else if (Array.isArray(input.referenceAnalysis.observedFacts) && input.referenceAnalysis.observedFacts.length) {
        throw new ReconstructionGroundingError("referenceAnalysis.observedFacts 未经服务端签名；请重新运行参考片分析");
      }
    } catch (error) {
      if (error instanceof ReconstructionGroundingError) throw new InputError(error.message);
      throw error;
    }
    const validate = (value) => {
      if (Object.prototype.hasOwnProperty.call(value || {}, "groundingSeal")) {
        throw new OutputContractError("sourceScriptReconstruction.groundingSeal 由服务端附加，模型不得输出");
      }
      try {
        const validated = ensureOutputContract(value, "sourceScriptReconstruction");
        return sealReconstruction(validated, this.groundingKey, contextDigest);
      } catch (error) {
        if (error instanceof ReconstructionGroundingError) throw new OutputContractError(error.message);
        throw error;
      }
    };
    const reconstructionInput = { ...input, referenceAnalysis: trustedReferenceAnalysis };
    if (!this.hasLiveClient) return validate(mockReconstruction(reconstructionInput));
    return this.generateStageJson("reconstruction", input, {
      prompt: reconstructionPrompt(reconstructionInput),
      systemPrompt: RECONSTRUCTION_SYSTEM_PROMPT,
      frames: input.frames,
      video: input.video,
      retryContext: { stage: "sourceScriptReconstruction" },
      validate
    });
  }

  async createBrief(input) {
    requireObject(input, "请求");
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    requireObject(input.sourceScriptReconstruction, "sourceScriptReconstruction");
    requireObject(input.creatorProfile || {}, "creatorProfile");
    const groundedInput = groundedStageInput(input, this.groundingKey);
    // allowedNarrativeComponents 的【原片有】判定要回到上游逐字核对，因此把这两份上游一并交给校验器。
    const briefUpstream = {
      referenceAnalysis: input.referenceAnalysis,
      sourceScriptReconstruction: input.sourceScriptReconstruction
    };
    if (!this.hasLiveClient) {
      return ensureCreativeBriefMatchesProfile(
        ensureOutputContract(mockBrief(groundedInput), "creativeBrief"),
        input.creatorProfile,
        briefUpstream
      );
    }
    const prompt = briefPrompt(groundedInput);
    return this.generateStageJson("brief", groundedInput, {
      prompt,
      retryContext: { stage: "creativeBrief", fixedCharacter: input.creatorProfile?.fixedCharacter || "" },
      validate: (result) => ensureCreativeBriefMatchesProfile(
        ensureOutputContract(result, "creativeBrief"),
        input.creatorProfile,
        briefUpstream
      )
    });
  }

  async createVariants(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const visualGuardrails = this.assertGlobalCharacterBoundary(input);
    const validatedInput = { ...input, visualGuardrails };
    if (!this.hasLiveClient) return ensureThemeVariantsMatchProfile(ensureOutputContract(mockVariants(validatedInput), "themeVariants"), profile, input.creativeBrief, visualGuardrails);
    const prompt = variantsPrompt(validatedInput);
    return this.generateStageJson("variants", validatedInput, {
      prompt,
      validate: (result) => ensureThemeVariantsMatchProfile(ensureOutputContract(result, "themeVariants"), profile, input.creativeBrief, visualGuardrails)
    });
  }

  async createVisualGuardrails(input) {
    requireObject(input, "请求");
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    requireObject(input.sourceScriptReconstruction, "sourceScriptReconstruction");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const groundedInput = groundedStageInput(input, this.groundingKey);
    const finalize = (result) => {
      const raw = ensureOutputContract(normalizeGlobalCharacterBoundaryTerms(result), "visualGuardrails");
      const modelSealFields = ["sourceDigest", "boundaryDigest", "boundarySignature"]
        .filter((field) => Object.prototype.hasOwnProperty.call(raw.fixedCharacterBoundary || {}, field));
      if (modelSealFields.length) {
        throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary 的签发字段只能由服务端生成：${modelSealFields.join("、")}`);
      }
      if (raw.allowedPositiveTraits.length || raw.positivePromptBoundary.length) {
        throw new OutputContractError("visualGuardrails.allowedPositiveTraits 与 positivePromptBoundary 必须由服务端从全局角色边界派生，模型必须返回空数组");
      }
      const sealed = sealGlobalCharacterBoundary(
        materializeGlobalCharacterBoundaryViews(raw, profile),
        groundedInput,
        this.characterBoundaryKey
      );
      return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(sealed, "visualGuardrails"), profile);
    };
    if (!this.hasLiveClient) return finalize(mockVisualGuardrails(groundedInput));
    const prompt = visualGuardrailsPrompt(groundedInput);
    return this.generateStageJson("visualGuardrails", groundedInput, {
      prompt,
      frames: input.frames || [],
      video: input.video || null,
      validate: finalize
    });
  }

  async createFullStory(input, { traceContext = null } = {}) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const groundedInput = groundedStageInput(input, this.groundingKey);
    const visualGuardrails = this.assertGlobalCharacterBoundary(groundedInput);
    const validatedInput = { ...groundedInput, visualGuardrails };
    const settings = this.resolveStage("fullStory", validatedInput);
    if (!this.hasLiveClient) return ensureFullStoryMatchesProfile(ensureOutputContract(mockFullStory(validatedInput), "fullStory"), profile, input.creativeBrief, input.variant, visualGuardrails);
    this.assertStageClient(settings, "完整剧情");
    const prompt = fullStoryPrompt({ ...validatedInput, targetProvider: settings.provider, targetModel: settings.model });
    const validateFullStory = (result) => ensureFullStoryMatchesProfile(
      ensureOutputContract(result, "fullStory"),
      profile,
      input.creativeBrief,
      input.variant,
      visualGuardrails
    );
    const observeFullStoryAttempt = this.fullModelOutputLogWriter?.enabled
      ? (attempt) => this.fullModelOutputLogWriter.recordAttempt({
        ...attempt,
        context: {
          ...(traceContext && typeof traceContext === "object" ? traceContext : {}),
          variantId: String(validatedInput.variant?.id || "")
        }
      })
      : null;
    let partialRepairState = null;
    let fullStory;
    try {
      fullStory = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request: {
          prompt,
          model: settings.model,
          maxCompletionTokens: settings.maxCompletionTokens
        },
        provider: settings.provider || "",
        stage: "fullStory",
        attemptObserver: observeFullStoryAttempt,
        retryTokenLimit,
        maxProviderCalls: 2,
        shouldRetry: ({ candidate }) => (
          partialRepairState !== null
          || !candidate
          || typeof candidate !== "object"
          || Array.isArray(candidate)
        ),
        validate: async (result) => {
          if (partialRepairState) {
            await this.recordPartialRepairDebugResponse(partialRepairState.debugSession, result);
            try {
              const repaired = validateFullStory(mergeFullStoryPartialRepair(
                partialRepairState.candidate,
                result,
                partialRepairState.plan,
                validatedInput
              ));
              await this.recordPartialRepairDebugResult(partialRepairState.debugSession, {
                status: "repaired"
              });
              partialRepairState.debugResultRecorded = true;
              return repaired;
            } catch (error) {
              await this.recordPartialRepairDebugResult(partialRepairState.debugSession, {
                status: "rejected",
                error
              });
              partialRepairState.debugResultRecorded = true;
              throw error;
            }
          }
          try {
            return validateFullStory(result);
          } catch (error) {
            const repairPlan = planFullStoryPartialRepair(result, error, validatedInput);
            if (repairPlan) {
              const { repairPrompt, debugSession } = await this.preparePartialRepairDebug({
                promptFactory: () => fullStoryPartialRepairPrompt(repairPlan),
                stage: "fullStory",
                provider: settings.provider,
                model: settings.model,
                variantId: validatedInput.variant?.id,
                originalError: error,
                repairPlan
              });
              partialRepairState = {
                candidate: structuredClone(result),
                plan: repairPlan,
                repairPrompt,
                debugResultRecorded: false,
                debugSession
              };
            }
            throw error;
          }
        },
        retryPrompt: ({ issue }) => {
          if (partialRepairState) return partialRepairState.repairPrompt;
          return fullStoryCompletionRetryPrompt(prompt, issue);
        }
      });
    } catch (error) {
      if (!partialRepairState?.debugResultRecorded) {
        await this.recordPartialRepairDebugResult(partialRepairState?.debugSession, {
          status: "rejected",
          error
        });
        if (partialRepairState) partialRepairState.debugResultRecorded = true;
      }
      throw error;
    }

    const beatScenePostpassPlan = createFullStoryBeatScenePostpassPlan(fullStory);
    return this.modelCallCoordinator.runJson({
      client: settings.client,
      request: {
        prompt: fullStoryBeatScenePostpassPrompt(beatScenePostpassPlan),
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens
      },
      provider: settings.provider || "",
      stage: FULL_STORY_BEAT_SCENE_POSTPASS_STAGE,
      attemptObserver: observeFullStoryAttempt,
      maxProviderCalls: 1,
      shouldRetry: () => false,
      validate: (response) => mergeFullStoryBeatScenePostpass(
        fullStory,
        response,
        beatScenePostpassPlan,
        { validateMerged: validateFullStory }
      )
    });
  }

  async generateStageJson(stage, input, options) {
    const settings = this.resolveStage(stage, input);
    if (requiresMediaModel(stage) && settings.provider === "DeepSeek") {
      throw new InputError(`${stageLabel(stage)}需要图片或视频输入，DeepSeek-V4 仅允许用于纯文本阶段`);
    }
    this.assertStageClient(settings, stageLabel(stage));
    return this.generateValidatedJson({
      ...options,
      client: settings.client,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      stage,
      provider: settings.provider || "",
      modelOutputLogWriter: this.stageModelOutputLogWriters?.get(stage) || null
    });
  }

  async generateValidatedJson({ client = this.client, prompt, systemPrompt = null, model = null, maxCompletionTokens = null, frames = [], video = null, validate, retryContext = null, onResolvedMediaMode = null, stage = "", provider = "", modelOutputLogWriter = null }) {
    // 纯观测 sidecar：只收集本次的模型原文，不改重试预算、控制流与任何错误语义。
    const recorder = stageModelOutputRecorder(modelOutputLogWriter, { stage, provider, model });
    const request = {
      prompt,
      systemPrompt,
      model,
      maxCompletionTokens,
      onResolvedMediaMode,
      jsonRetryAttempts: 0,
      strictJson: true,
      ...(recorder ? { onCompletion: (completion) => recorder.observe(completion) } : {})
    };
    try {
      const first = frames.length || video
        ? await client.generateJsonWithMedia({ ...request, frames, video })
        : await client.generateJson(request);
      // A parsed candidate may only receive another content-model call through
      // a stage adapter that signs exact targets and performs an atomic merge.
      // Generic whole-artifact regeneration would grant the model unrelated
      // write access and can leak the complete failed Artifact back into the
      // correction prompt, so unsupported stages fail closed here.
      const value = await validate(first);
      await recorder?.flush({ status: "succeeded" });
      return value;
    } catch (error) {
      await recorder?.flush({ status: "failed", error });
      throw error;
    }
  }

  async generateAnimationFoundationWithPartialRepair({
    client,
    provider = "",
    prompt,
    model = null,
    maxCompletionTokens = null,
    validate,
    repairContext
  }) {
    let partialRepairState = null;
    try {
      return await this.modelCallCoordinator.runJson({
      client,
      request: { prompt, model, maxCompletionTokens },
      provider,
      stage: "animationFoundation",
      maxProviderCalls: 2,
      retryTokenLimit,
      shouldRetry: () => partialRepairState !== null,
      validate: async (result) => {
        if (partialRepairState) {
          await this.recordPartialRepairDebugResponse(partialRepairState.debugSession, result);
          try {
            const merged = mergeAnimationFoundationPartialRepair(
              partialRepairState.candidate,
              result,
              partialRepairState.plan,
              {
                context: repairContext,
                validateMerged: (candidate) => {
                  validate(candidate);
                  return true;
                }
              }
            );
            const repaired = validate(merged);
            await this.recordPartialRepairDebugResult(partialRepairState.debugSession, {
              status: "repaired"
            });
            partialRepairState.debugResultRecorded = true;
            return repaired;
          } catch (error) {
            await this.recordPartialRepairDebugResult(partialRepairState.debugSession, {
              status: "rejected",
              error
            });
            partialRepairState.debugResultRecorded = true;
            if (!(error instanceof OutputContractError)) throw error;
            throw new OutputContractError(
              `Animation Foundation 有界局部纠错失败；原始诊断：${partialRepairState.error.message}；repair 响应：${error.message}`,
              [
                ...(Array.isArray(partialRepairState.error.details)
                  ? partialRepairState.error.details
                  : []),
                ...(Array.isArray(error.details) ? error.details : [])
              ]
            );
          }
        }
        try {
          return validate(result);
        } catch (error) {
          if (error instanceof OutputContractError) {
            const repairPlan = planAnimationFoundationPartialRepair(
              result,
              error,
              repairContext
            );
            if (repairPlan) {
              const { repairPrompt, debugSession } = await this.preparePartialRepairDebug({
                promptFactory: () => animationFoundationPartialRepairPrompt(repairPlan),
                stage: "animationFoundation",
                provider,
                model,
                variantId: repairContext?.variant?.id,
                originalError: error,
                repairPlan
              });
              partialRepairState = {
                candidate: structuredClone(result),
                plan: repairPlan,
                error,
                repairPrompt,
                debugResultRecorded: false,
                debugSession
              };
            }
          }
          throw error;
        }
      },
      retryPrompt: () => partialRepairState.repairPrompt
      });
    } catch (error) {
      if (!partialRepairState?.debugResultRecorded) {
        await this.recordPartialRepairDebugResult(partialRepairState?.debugSession, {
          status: "rejected",
          error
        });
        if (partialRepairState) partialRepairState.debugResultRecorded = true;
      }
      throw error;
    }
  }

  async generateAnimationShotBatch({
    client,
    provider = "",
    prompt,
    model = null,
    maxCompletionTokens = null,
    compilerSettings,
    characterFeatureProfile,
    directShotMode = false,
    batchIndex = 0,
    repairContext,
    partialRepairContext = null,
    validate
  }) {
    const firstPolicy = ANIMATION_BATCH_ATTEMPT_POLICIES.first;
    const retryPolicy = ANIMATION_BATCH_ATTEMPT_POLICIES.retry;
    assertAnimationBatchAttemptPolicy(firstPolicy);
    assertAnimationBatchAttemptPolicy(retryPolicy);

    let firstOutcome;
    let firstResponseReceived = false;
    try {
      const firstResponse = await client.generateJson({
        prompt,
        model,
        maxCompletionTokens,
        jsonRetryAttempts: 0,
        strictJson: true
      });
      firstResponseReceived = true;
      const rawModelOutput = structuredClone(firstResponse);
      firstOutcome = await this.runAnimationShotBatchAttempt({
        client,
        provider,
        model,
        maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        directShotMode,
        batchIndex,
        compilerPhase: "post-generate",
        rawModelOutput,
        repairContext,
        partialRepairContext,
        validate,
        policy: firstPolicy
      });
    } catch (error) {
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      firstOutcome = animationBatchAttemptFailure({
        error,
        candidate: null,
        phase: "generate",
        hadParsedCandidate: firstResponseReceived
      });
    }

    if (firstOutcome.status === "success") {
      return {
        batch: firstOutcome.batch,
        compilerRuns: finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, firstOutcome.batch, true)
      };
    }
    if (directShotMode && firstOutcome.hadParsedCandidate) {
      throw attachStaticFrameCompilerRuns(
        finalDirectAnimationBatchAttemptError(firstOutcome),
        finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, null, false)
      );
    }
    if (!firstPolicy.allowBatchRetry) throw finalAnimationBatchAttemptError(firstOutcome.error);

    const retryPrompt = animationShotBatchRetryPrompt(prompt, {
      failedCandidate: firstOutcome.candidate,
      diagnostics: firstOutcome.diagnostics
    });
    let retryRawModelOutput;
    try {
      const retryResponse = await client.generateJson({
        prompt: retryPrompt,
        model,
        maxCompletionTokens: retryTokenLimit(maxCompletionTokens),
        jsonRetryAttempts: 0,
        strictJson: true
      });
      retryRawModelOutput = structuredClone(retryResponse);
    } catch (error) {
      const finalError = isRecoverableAnimationModelOutputError(error)
        ? finalAnimationBatchAttemptError(error)
        : error;
      throw attachStaticFrameCompilerRuns(
        finalError,
        finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, null, false)
      );
    }

    let retryOutcome;
    try {
      retryOutcome = await this.runAnimationShotBatchAttempt({
        client,
        provider,
        model,
        maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        directShotMode,
        batchIndex,
        compilerPhase: "second-pass",
        rawModelOutput: retryRawModelOutput,
        repairContext,
        partialRepairContext,
        validate,
        policy: retryPolicy
      });
    } catch (error) {
      throw attachStaticFrameCompilerRuns(error, [
        ...finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, null, false),
        ...finalizeStaticFrameCompilerRuns(staticFrameCompilerRunsFromError(error), null, false)
      ]);
    }
    if (retryOutcome.status === "success") {
      return {
        batch: retryOutcome.batch,
        compilerRuns: [
          ...finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, null, false),
          ...finalizeStaticFrameCompilerRuns(retryOutcome.compilerRuns, retryOutcome.batch, true)
        ]
      };
    }
    throw attachStaticFrameCompilerRuns(
      finalAnimationBatchAttemptError(retryOutcome.error),
      [
        ...finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, null, false),
        ...finalizeStaticFrameCompilerRuns(retryOutcome.compilerRuns, null, false)
      ]
    );
  }

  async runAnimationShotBatchAttempt({
    client,
    provider = "",
    model,
    maxCompletionTokens,
    compilerSettings,
    characterFeatureProfile,
    directShotMode = false,
    batchIndex,
    compilerPhase,
    rawModelOutput,
    repairContext,
    partialRepairContext = null,
    validate,
    policy
  }) {
    assertAnimationBatchAttemptPolicy(policy);
    let candidate;
    let compilerRuns = [];
    try {
      const prepared = await this.prepareAnimationShotBatchCandidate({
        rawModelOutput,
        repairContext,
        compilerSettings,
        characterFeatureProfile,
        directShotMode,
        batchIndex,
        phase: compilerPhase
      });
      candidate = prepared.candidate;
      compilerRuns = prepared.compilerRuns;
    } catch (error) {
      annotateStaticFrameBatchRetry(error, {
        phase: compilerPhase,
        retryEligible: policy.allowBatchRetry
      });
      compilerRuns = [...compilerRuns, ...staticFrameCompilerRunsFromError(error)];
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      return animationBatchAttemptFailure({
        error,
        candidate: null,
        phase: "structural_repair_or_alias",
        hadParsedCandidate: true,
        compilerRuns
      });
    }

    const initialOutcome = await this.evaluateAnimationShotBatchCandidate({
      client,
      model,
      maxCompletionTokens,
      candidate,
      validate,
      policy
    });
    initialOutcome.compilerRuns = compilerRuns;
    initialOutcome.hadParsedCandidate = true;
    if (initialOutcome.status === "success") return initialOutcome;

    // direct_shot may only use the bounded videoPrompt adapter above. The
    // legacy v2 patch path serializes a whole failed batch and must remain
    // structurally unreachable even if a future direct schema adds a field
    // that resembles a legacy patch target.
    if (directShotMode) return initialOutcome;
    if (!policy.allowPatch) return initialOutcome;
    if (initialOutcome.kind === "audit_protocol") return initialOutcome;

    let trustedDetail;
    try {
      trustedDetail = trustedAnimationPatchDetail(initialOutcome.error, candidate);
    } catch (error) {
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      return animationBatchAttemptFailure({
        error,
        candidate,
        phase: "patch_target",
        diagnostics: initialOutcome.diagnostics,
        compilerRuns
      });
    }
    if (!trustedDetail) return initialOutcome;

    let appliedCandidate;
    let patchedCandidate;
    try {
      const patchResponse = await client.generateJson({
        prompt: animationShotBatchPatchPrompt({
          failedBatch: candidate,
          path: trustedDetail.path,
          reason: trustedDetail.reason
        }),
        model,
        maxCompletionTokens: animationAuditTokenLimit(maxCompletionTokens)
      });
      const patch = validateAnimationShotBatchPatchResponse(patchResponse, trustedDetail.path);
      appliedCandidate = applyAnimationShotBatchPatch(candidate, patch);
      const preparedPatch = await this.prepareAnimationShotBatchCandidate({
        rawModelOutput: appliedCandidate,
        repairContext,
        compilerSettings,
        characterFeatureProfile,
        directShotMode,
        batchIndex,
        phase: "post-patch"
      });
      patchedCandidate = preparedPatch.candidate;
      compilerRuns = [...compilerRuns, ...preparedPatch.compilerRuns];
    } catch (error) {
      annotateStaticFrameBatchRetry(error, {
        phase: compilerPhase,
        retryEligible: policy.allowBatchRetry
      });
      compilerRuns = [...compilerRuns, ...staticFrameCompilerRunsFromError(error)];
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      return animationBatchAttemptFailure({
        error,
        candidate: patchedCandidate || appliedCandidate || candidate,
        phase: "patch",
        diagnostics: initialOutcome.diagnostics,
        compilerRuns
      });
    }

    const patchedOutcome = await this.evaluateAnimationShotBatchCandidate({
      client,
      model,
      maxCompletionTokens,
      candidate: patchedCandidate,
      validate,
      policy
    });
    patchedOutcome.compilerRuns = compilerRuns;
    if (patchedOutcome.status === "success") return patchedOutcome;
    return animationBatchAttemptFailure({
      error: patchedOutcome.error,
      candidate: patchedOutcome.candidate,
      phase: patchedOutcome.phase,
      kind: patchedOutcome.kind,
      diagnostics: initialOutcome.diagnostics,
      compilerRuns
    });
  }

  async prepareAnimationShotBatchCandidate({
    rawModelOutput,
    repairContext,
    compilerSettings,
    characterFeatureProfile,
    directShotMode = false,
    batchIndex,
    phase
  }) {
    const repairedStructure = repairAnimationShotBatchStructure(rawModelOutput, repairContext);
    if (!isPlainObject(repairedStructure) || !Array.isArray(repairedStructure.shotPlan)) {
      throw new OutputContractError("animationShotBatch structural repair 后必须包含 shotPlan 数组");
    }
    if (directShotMode) {
      // 暂时弃置，后续优化或删除：direct_shot 绕过 Static Frame Compiler 与本地 Prompt Compiler；旧实现保留在下方兼容 v2。
      return {
        candidate: repairedStructure,
        compilerRuns: []
      };
    }
    const structurallyRepaired = stripAnimationShotBatchAliases(repairedStructure);
    const compiled = await compileStaticFrames({
      candidate: structurallyRepaired,
      client: compilerSettings.client,
      provider: compilerSettings.provider,
      model: compilerSettings.model,
      maxCompletionTokens: compilerSettings.maxCompletionTokens,
      timeoutMs: compilerSettings.requestTimeoutMs,
      characterFeatureProfile,
      batchIndex,
      phase
    });
    try {
      return {
        candidate: rebuildAnimationShotBatchAliases(compiled.compiledCandidate),
        compilerRuns: [compiled.metadata]
      };
    } catch (error) {
      if (error && typeof error === "object") {
        error.staticFrameCompilerRuns = [compiled.metadata];
      }
      throw error;
    }
  }

  async evaluateAnimationShotBatchCandidate({
    client,
    model,
    maxCompletionTokens,
    candidate,
    validate,
    policy
  }) {
    let validatedBatch;
    try {
      validatedBatch = validate(structuredClone(candidate));
    } catch (error) {
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      return animationBatchAttemptFailure({
        error,
        candidate,
        phase: "validation"
      });
    }

    const review = await this.reviewAnimationShotBatch({
      client,
      model,
      maxCompletionTokens,
      validatedBatch
    });
    if (review.status === "pass") return animationBatchAttemptSuccess(validatedBatch);
    return animationBatchAttemptFailure({
      error: review.error,
      candidate,
      phase: review.status === "protocol_failure" ? "action_state_review_protocol" : "action_state_review",
      kind: review.status === "protocol_failure" ? "audit_protocol" : "semantic"
    });
  }

  async reviewAnimationShotBatch({ client, model, maxCompletionTokens, validatedBatch }) {
    const auditEntries = collectAnimationActionStateAuditEntries(validatedBatch);
    if (!auditEntries.length) return { status: "pass" };

    const auditItems = auditEntries.map(({ id, actionState, frameKind }) => ({ id, actionState, frameKind }));
    let auditResult;
    try {
      auditResult = await client.generateJson({
        prompt: animationActionStateAuditPrompt(auditItems),
        model,
        maxCompletionTokens: animationAuditTokenLimit(maxCompletionTokens)
      });
    } catch (error) {
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      return {
        status: "protocol_failure",
        error: actionStateAuditProtocolError(error)
      };
    }

    let failures;
    try {
      failures = validateAnimationActionStateAuditResult(auditResult, auditEntries);
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      const semanticFailures = collectTrustedAnimationActionStateAuditFailures(auditResult, auditEntries);
      if (semanticFailures.length) return animationActionStateSemanticFailure(semanticFailures);
      return {
        status: "protocol_failure",
        error: actionStateAuditProtocolError(error)
      };
    }
    if (!failures.length) return { status: "pass" };
    return animationActionStateSemanticFailure(failures);
  }

  async createAnimationPlan(input) {
    const result = await this.createAnimationPlanWithMetadata(input);
    return result.animationPlan;
  }

  async createAnimationPlanWithMetadata(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    requireObject(input.fullStory, "fullStory");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const animationPlanMode = String(input.animationPlanMode || "").trim();
    if (animationPlanMode && animationPlanMode !== ANIMATION_DIRECT_SHOT_MODE) {
      throw new InputError(`animationPlanMode 只允许 ${ANIMATION_DIRECT_SHOT_MODE}`);
    }
    const directShotMode = animationPlanMode === ANIMATION_DIRECT_SHOT_MODE;
    const targetAspectRatio = requireAnimationPlanAspectRatio(input.targetAspectRatio || "16:9");
    // 背景音乐开关缺省关闭，与主题变体卡上的默认状态一致。
    const backgroundMusicMode = normalizeBackgroundMusicMode(input.backgroundMusicEnabled);
    const videoPromptProfile = directShotMode
      ? resolveDirectShotVideoPromptProfile(input.videoPromptTarget)
      : null;
    const visualGuardrails = this.assertGlobalCharacterBoundary(input);
    const fullStory = ensureFullStoryMatchesProfile(
      ensureOutputContract(input.fullStory, "fullStory"),
      profile,
      input.creativeBrief,
      input.variant,
      visualGuardrails
    );
    // direct_shot 3.1：镜头骨架在任何模型调用之前从 Full Story 确定性派生。
    // timeRange 不可解析、跨度非正、跨场次逆序或短于供应商下限时在这里 fail fast，
    // 不签发 Plan，也不浪费一次 Foundation 调用。
    const directShotSkeleton = directShotMode ? deriveDirectShotSkeleton(fullStory) : null;
    const validatedInput = {
      ...input,
      fullStory,
      visualGuardrails,
      targetAspectRatio,
      backgroundMusicMode,
      ...(videoPromptProfile ? { videoPromptProfile } : {}),
      ...(directShotSkeleton ? { directShotSkeleton } : {})
    };
    const settings = this.resolveStage("animationPlan", validatedInput);
    const compilerSettings = this.resolveStage("staticFrameCompiler", validatedInput);
    if (!this.hasLiveClient) {
      return {
        animationPlan: validateAnimationPlanOutput(mockAnimationPlan(validatedInput), validatedInput),
        metadata: directShotMode ? disabledDirectShotCompilerMetadata(compilerSettings) : {
          staticFrameCompiler: {
            version: STATIC_FRAME_COMPILER_VERSION,
            provider: compilerSettings.provider || "",
            model: compilerSettings.model || "",
            runs: []
          }
        }
      };
    }
    this.assertStageClient(settings, directShotMode ? "直接视频镜头生产包" : "首尾帧动画生产包");
    if (!directShotMode) assertStaticFrameCompilerSettings(compilerSettings);
    const promptInput = { ...validatedInput, targetProvider: settings.provider, targetModel: settings.model };
    // 暂时弃置，后续优化或删除：direct_shot 当前不调用 Character Feature Compiler。
    const createCharacterFeatureTask = () => directShotMode
      ? Promise.resolve(disabledCompilerResult("Character Feature Compiler"))
      : compileCharacterFeatures({
        creatorProfile: structuredClone(profile),
        visualGuardrails: structuredClone(validatedInput.visualGuardrails || {}),
        fullStory: structuredClone(fullStory),
        temporaryCharacters: Array.isArray(validatedInput.temporaryCharacters)
          ? structuredClone(validatedInput.temporaryCharacters)
          : [],
        client: compilerSettings.client,
        provider: compilerSettings.provider,
        model: compilerSettings.model,
        maxCompletionTokens: compilerSettings.maxCompletionTokens,
        timeoutMs: compilerSettings.requestTimeoutMs,
        cachedProfile: input.privateSidecars?.characterFeatureProfile || null
      });
    const [foundationResult, characterFeatureResult] = await Promise.allSettled([
      this.generateAnimationFoundationWithPartialRepair({
        client: settings.client,
        provider: settings.provider,
        prompt: animationFoundationPrompt(promptInput),
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        validate: (result) => validateAnimationFoundationOutput(result, validatedInput),
        repairContext: validatedInput
      }),
      createCharacterFeatureTask()
    ]);
    const foundation = settledParallelValue(
      foundationResult,
      characterFeatureResult,
      "Animation Foundation",
      "Character Feature Compiler"
    );
    const characterFeatureCompilation = settledParallelValue(
      characterFeatureResult,
      foundationResult,
      "Character Feature Compiler",
      "Animation Foundation"
    );
    const characterFeatureProfile = directShotMode
      ? null
      : freezeClone(characterFeatureCompilation.profile);

    const sourceScenes = Array.isArray(validatedInput.fullStory.sceneScript) ? validatedInput.fullStory.sceneScript : [];
    const sceneBatches = chunkItems(sourceScenes, this.animationShotBatchSceneCount);
    const shotPlan = [];
    const compilerRuns = [];
    for (let batchIndex = 0; batchIndex < sceneBatches.length; batchIndex += 1) {
      const batchScenes = sceneBatches[batchIndex];
      const shotIdStartIndex = shotPlan.length + 1;
      // 3.1 下本批要产出哪几个镜头是确定的，模型没有数量自由度，
      // 因此不再喂"已用秒数/脚本预算"这类追赶进度的提示信息。
      const batchSkeleton = directShotSkeleton
        ? directShotSkeletonForScenes(directShotSkeleton, batchScenes)
        : null;
      const prompt = animationShotBatchPrompt({
        ...promptInput,
        animationFoundation: foundation,
        sourceScenes: batchScenes,
        batchIndex,
        shotIdStartIndex,
        previousShotContext: animationContinuityContext(shotPlan.at(-1)),
        ...(batchSkeleton ? { directShotSkeleton: batchSkeleton } : {})
      });
      const batchContext = {
        input: validatedInput,
        foundation,
        sourceScenes: batchScenes,
        batchIndex,
        shotIdStartIndex,
        skeleton: batchSkeleton,
        previousShots: shotPlan
      };
      const batchResult = await this.generateAnimationShotBatch({
        client: settings.client,
        provider: settings.provider,
        prompt,
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        directShotMode,
        batchIndex,
        repairContext: createAnimationShotBatchRepairContext(batchContext),
        partialRepairContext: batchContext,
        validate: (result) => validateAnimationShotBatchOutput(result, batchContext)
      });
      shotPlan.push(...batchResult.batch.shotPlan);
      compilerRuns.push(...batchResult.compilerRuns);
    }

    let animationPlan = validateAnimationPlanOutput(
      mergeAnimationPlan(foundation, shotPlan, validatedInput, directShotSkeleton),
      validatedInput
    );
    let initialVideoPromptSemanticAudit = null;
    if (directShotMode) {
      const semanticOutcome = await this.auditInitialAnimationVideoPromptSemantics({
        ...validatedInput,
        sourcePlan: animationPlan,
        rewrittenPlan: animationPlan,
        targetProfile: videoPromptProfile
      });
      animationPlan = semanticOutcome.animationPlan;
      initialVideoPromptSemanticAudit = semanticOutcome.semanticAudit;
    }
    const directShotMetadata = directShotMode
      ? {
        ...disabledDirectShotCompilerMetadata(compilerSettings),
        ...(initialVideoPromptSemanticAudit
          ? { videoPromptSemanticAudit: initialVideoPromptSemanticAudit }
          : {})
      }
      : null;
    return {
      animationPlan,
      metadata: directShotMode ? directShotMetadata : {
        characterFeatureCompiler: structuredClone(characterFeatureCompilation.metadata || {}),
        privateSidecars: {
          characterFeatureProfile: structuredClone(characterFeatureProfile)
        },
        staticFrameCompiler: {
          version: STATIC_FRAME_COMPILER_VERSION,
          provider: compilerSettings.provider,
          model: compilerSettings.model,
          runs: compilerRuns
        }
      }
    };
  }

  async auditInitialAnimationVideoPromptSemantics(input) {
    return this.auditAnimationVideoPromptSemanticsWithBoundedRepair(input, {
      auditMode: "initial",
      stageLabel: "首次 Animation Plan 视频提示词语义审计",
      failurePrefix: "首次视频提示词与镜头事实不一致"
    });
  }

  async generateAnimationVideoPromptSemanticAudit(input, {
    auditMode,
    stageLabel,
    reviewShotIds = null
  } = {}) {
    const settings = this.resolveStage("animationPlan", input);
    this.assertStageClient(settings, stageLabel);
    const catalog = createAnimationVideoPromptSemanticAuditCatalog(
      animationVideoPromptSemanticAuditCatalogInput(input, { reviewShotIds }),
      { candidate: input.rewrittenPlan }
    );
    const audit = await this.generateValidatedJson({
      client: settings.client,
      systemPrompt: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SYSTEM_PROMPT,
      prompt: animationVideoPromptRewriteSemanticAuditPrompt({
        ...input,
        auditMode,
        semanticAuditPayload: animationVideoPromptSemanticAuditCatalogPayload(catalog)
      }),
      model: settings.model,
      maxCompletionTokens: Math.min(Number(settings.maxCompletionTokens) || 2048, 8192),
      validate: (value) => validateAnimationVideoPromptSemanticAuditResponse(value, catalog)
    });
    return {
      settings,
      audit,
      overall: deriveAnimationVideoPromptSemanticAuditOverall(audit)
    };
  }

  async auditAnimationVideoPromptSemanticsWithBoundedRepair(input, {
    auditMode,
    stageLabel,
    failurePrefix
  } = {}) {
    const candidate = structuredClone(requireObject(input.rewrittenPlan, "rewrittenPlan"));
    const firstAudit = await this.generateAnimationVideoPromptSemanticAudit(input, {
      auditMode,
      stageLabel
    });
    if (firstAudit.overall.verdict === "pass") {
      return {
        animationPlan: candidate,
        semanticAudit: animationVideoPromptSemanticAuditReceipt({
          settings: firstAudit.settings,
          auditMode,
          rounds: 1,
          initialReviewedShotIds: candidate.shotPlan.map((shot) => shot.shotId),
          reReviewedShotIds: [],
          repairedShotIds: []
        })
      };
    }

    let repairPlan;
    try {
      repairPlan = planAnimationVideoPromptSemanticRepair(candidate, firstAudit.audit, {
        repairAttemptCount: 0,
        fullStory: input.fullStory,
        visualGuardrails: input.visualGuardrails,
        planIdentity: animationVideoPromptSemanticRepairIdentity(input, auditMode)
      });
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      throw new InputError(
        `${failurePrefix}：${formatAnimationVideoPromptSemanticAuditFailure(firstAudit.audit)}；${error.message}`,
        animationVideoPromptSemanticAuditDiagnostics(firstAudit.audit)
      );
    }
    if (!repairPlan) {
      throw new InputError(
        `${failurePrefix}：${formatAnimationVideoPromptSemanticAuditFailure(firstAudit.audit)}。`
        + "审计发现结构化 shot 事实冲突，或未能签发唯一安全的 videoPrompt 修复目标；本次明确终止。",
        animationVideoPromptSemanticAuditDiagnostics(firstAudit.audit)
      );
    }

    const repairedShotIds = repairPlan.targets.map((target) => String(target.adapterState?.shotId || ""));
    const { repairPrompt, debugSession } = await this.preparePartialRepairDebug({
      promptFactory: () => animationVideoPromptSemanticRepairPrompt(repairPlan),
      stage: "animationVideoPromptSemanticRepair",
      provider: firstAudit.settings.provider,
      model: firstAudit.settings.model,
      variantId: input.variant?.id,
      originalError: new OutputContractError(
        formatAnimationVideoPromptSemanticAuditFailure(firstAudit.audit)
      ),
      repairPlan
    });
    try {
      const envelope = await firstAudit.settings.client.generateJson({
        prompt: repairPrompt,
        model: firstAudit.settings.model,
        maxCompletionTokens: retryTokenLimit(firstAudit.settings.maxCompletionTokens),
        jsonRetryAttempts: 0,
        strictJson: true
      });
      await this.recordPartialRepairDebugResponse(debugSession, envelope);
      const merged = mergeAnimationVideoPromptSemanticRepair(
        candidate,
        envelope,
        repairPlan,
        {
          audit: firstAudit.audit,
          fullStory: input.fullStory,
          visualGuardrails: input.visualGuardrails,
          planIdentity: animationVideoPromptSemanticRepairIdentity(input, auditMode),
          validateMerged: ({ candidate: value }) => {
            validateAnimationPlanOutput(value, input);
            return true;
          }
        }
      );
      const repairedPlan = validateAnimationPlanOutput(merged, input);
      assertOnlySelectedAnimationVideoPromptsChanged(candidate, repairedPlan, repairedShotIds);

      const reviewedShotIds = animationSemanticRepairReviewShotIds(repairedPlan, repairedShotIds);
      const finalAudit = await this.generateAnimationVideoPromptSemanticAudit({
        ...input,
        rewrittenPlan: repairedPlan
      }, {
        auditMode,
        stageLabel: `${stageLabel}（有界修复复审）`,
        reviewShotIds: reviewedShotIds
      });
      if (finalAudit.overall.verdict !== "pass") {
        throw new InputError(
          `${failurePrefix}：唯一一次有界 videoPrompt 修复复审仍未通过：`
          + formatAnimationVideoPromptSemanticAuditFailure(finalAudit.audit),
          animationVideoPromptSemanticAuditDiagnostics(finalAudit.audit)
        );
      }
      await this.recordPartialRepairDebugResult(debugSession, { status: "repaired" });
      return {
        animationPlan: repairedPlan,
        semanticAudit: animationVideoPromptSemanticAuditReceipt({
          settings: finalAudit.settings,
          auditMode,
          rounds: 2,
          initialReviewedShotIds: candidate.shotPlan.map((shot) => shot.shotId),
          reReviewedShotIds: reviewedShotIds,
          repairedShotIds
        })
      };
    } catch (error) {
      await this.recordPartialRepairDebugResult(debugSession, {
        status: "rejected",
        error
      });
      if (error instanceof InputError) throw error;
      throw new InputError(`${failurePrefix}：有界 videoPrompt 修复失败；${error.message}`);
    }
  }

  async rewriteAnimationPlanVideoPrompts(input) {
    requireObject(input, "请求");
    const sourcePlan = structuredClone(requireObject(input.animationPlan, "animationPlan"));
    if (sourcePlan.promptSchemaVersion !== ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
      throw new InputError("只有 direct_shot 3.0 Animation Plan 可以改写视频提示词");
    }
    ensureAnimationPlanVideoPromptProfile(sourcePlan, { optional: true });
    const videoPromptProfile = resolveDirectShotVideoPromptProfile(input.videoPromptTarget);
    const visualGuardrails = this.assertGlobalCharacterBoundary(input);
    const fullStory = ensureFullStoryMatchesProfile(
      ensureOutputContract(input.fullStory, "fullStory"),
      input.creatorProfile,
      input.creativeBrief,
      input.variant,
      visualGuardrails
    );
    const validatedInput = {
      ...input,
      animationPlan: sourcePlan,
      animationPlanMode: ANIMATION_DIRECT_SHOT_MODE,
      targetAspectRatio: requireAnimationPlanAspectRatio(sourcePlan.productionStrategy?.targetAspectRatio),
      videoPromptProfile,
      visualGuardrails,
      fullStory
    };
    validateAnimationPlanOutput(sourcePlan, {
      ...validatedInput,
      // Legacy signed Plans may not yet carry a profile; source validation must not
      // inject or infer one before the user explicitly confirms this rewrite.
      videoPromptProfile: sourcePlan.productionStrategy?.videoPromptProfile || null
    });

    const settings = this.resolveStage("animationPlan", validatedInput);
    if (!this.hasLiveClient) {
      throw new InputError("Animation Plan 视频提示词改写需要已配置的文本模型执行改写与独立语义审计；demo mock 不得签发生产 Profile。");
    }
    this.assertStageClient(settings, "Animation Plan 视频提示词目标改写");
    const candidate = await this.generateValidatedJson({
      client: settings.client,
      prompt: animationVideoPromptRewritePrompt({
        ...validatedInput,
        targetProvider: settings.provider,
        targetModel: settings.model
      }),
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      validate: (value) => validateAnimationVideoPromptRewrite(value, sourcePlan, videoPromptProfile)
    });
    const validatedRewrite = validateAnimationVideoPromptRewrite(candidate, sourcePlan, videoPromptProfile);
    const promptsByShotId = new Map(validatedRewrite.videoPrompts.map((item) => [item.shotId, item.videoPrompt]));
    const rewrittenPlan = {
      ...structuredClone(sourcePlan),
      productionStrategy: {
        ...structuredClone(sourcePlan.productionStrategy),
        videoPromptProfile: structuredClone(videoPromptProfile)
      },
      shotPlan: sourcePlan.shotPlan.map((shot) => ({
        ...structuredClone(shot),
        videoPrompt: promptsByShotId.get(shot.shotId)
      }))
    };
    assertOnlyAnimationVideoPromptsChanged(sourcePlan, rewrittenPlan, videoPromptProfile);
    // 方言改写不授权顺手改变有无配乐：新提示词必须继续遵守当前 Plan 已签发的
    // backgroundMusicMode，且各按目标 Profile 的合法写法表达。放在语义审计之前失败。
    validateSeedanceBackgroundMusicSentence(rewrittenPlan, rewrittenPlan, 0);
    let animationPlan = validateAnimationPlanOutput(rewrittenPlan, validatedInput);
    // Validation may prune evidence that no longer matches a rewritten prompt.
    // Prompt-only retargeting is not authorized to silently mutate that evidence
    // (or any other Plan field), so prove the invariant again after validation.
    assertOnlyAnimationVideoPromptsChanged(sourcePlan, animationPlan, videoPromptProfile);
    const semanticOutcome = await this.auditAnimationVideoPromptRewriteSemantics({
      ...validatedInput,
      sourcePlan,
      rewrittenPlan: animationPlan,
      targetProfile: videoPromptProfile
    });
    animationPlan = semanticOutcome.animationPlan;
    assertOnlyAnimationVideoPromptsChanged(sourcePlan, animationPlan, videoPromptProfile);
    const semanticAudit = semanticOutcome.semanticAudit;
    return {
      animationPlan,
      metadata: {
        videoPromptRewrite: {
          provider: settings.provider || "demo",
          model: settings.model || "demo",
          sourceProfile: structuredClone(sourcePlan.productionStrategy?.videoPromptProfile || null),
          targetProfile: structuredClone(videoPromptProfile),
          rewrittenShotIds: sourcePlan.shotPlan.map((shot) => shot.shotId),
          semanticAudit
        }
      }
    };
  }

  async auditAnimationVideoPromptRewriteSemantics(input) {
    return this.auditAnimationVideoPromptSemanticsWithBoundedRepair(input, {
      auditMode: "rewrite",
      stageLabel: "Animation Plan 视频提示词改写语义审计",
      failurePrefix: "视频提示词改写改变了已签发镜头事实"
    });
  }

  async refineCharacterReference(input) {
    requireObject(input, "请求");
    const characterReference = requireObject(input.characterReference, "characterReference");
    const visualGuardrails = this.assertGlobalCharacterBoundary(input);
    const imageDataUrl = requireText(input.imageDataUrl, "人物参考图", { max: 16 * 1024 * 1024 });
    if (!imageDataUrl.startsWith("data:image/")) throw new InputError("人物参考图必须是图片 data URL");
    const validatedInput = { ...input, visualGuardrails };
    const prompt = characterReferenceRefinePrompt(validatedInput);
    if (!this.hasLiveClient) {
      return normalizeCharacterReference({
        ...characterReference,
        appearancePrompt: `${characterReference.appearancePrompt || ""} 参考用户上传的人物图，保持人物外观、服装和色彩一致。`,
        referenceImageNotes: "演示模式：已标记为使用人物参考图。"
      }, characterReference, { ...input, visualGuardrails });
    }
    return this.generateStageJson("characterReference", validatedInput, {
      prompt,
      frames: [{ timestamp: 0, dataUrl: imageDataUrl }],
      validate: (result) => normalizeCharacterReference(result, characterReference, validatedInput)
    });
  }

  assertGlobalCharacterBoundary(input = {}) {
    requireObject(input.visualGuardrails, "visualGuardrails");
    try {
      const verified = verifyGlobalCharacterBoundary(
        input.visualGuardrails,
        input,
        this.characterBoundaryKey,
        { requireSignature: this.characterBoundarySignatureRequired }
      );
      const materialized = materializeGlobalCharacterBoundaryViews(verified, input.creatorProfile || {});
      return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(materialized, "visualGuardrails"), input.creatorProfile || {});
    } catch (error) {
      if (error instanceof CharacterBoundaryError) throw new InputError(error.message);
      throw error;
    }
  }

  async run(input) {
    const referenceAnalysis = await this.analyze(input);
    const sourceScriptReconstruction = await this.reconstruct({ ...input, referenceAnalysis });
    const creativeBrief = await this.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
    const visualGuardrails = await this.createVisualGuardrails({ ...input, referenceAnalysis, sourceScriptReconstruction, creativeBrief });
    const themeVariants = await this.createVariants({ ...input, referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails });
    return { referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails, themeVariants };
  }

  assertStageClient(settings, label) {
    if (settings.client) return;
    throw new InputError(`${label} 选择了 ${settings.provider || "未知 provider"}，但该 provider 未配置或不可用。`);
  }
}

function fullStoryCompletionRetryPrompt(originalPrompt, issue = {}) {
  return `${originalPrompt}

FULL_STORY_COMPLETION_RETRY_V1

上一次 Full Story completion 没有形成可校验的完整 JSON 对象。
错误类别：${String(issue.category || "unknown")}
错误代码：${String(issue.code || "MODEL_COMPLETION_INVALID")}

请重新输出一份完整 fullStory：
- 只输出一个 JSON object；对象前后不得有 Markdown、解释、前缀、后缀或额外 JSON。
- 不得使用 <think> 包裹正文。
- 必须输出原任务要求的全部顶层和嵌套字段。
- 内容可以精炼，但不得省略结构字段或以 null 占位。
- 只输出 JSON。`;
}

function groundedStageInput(input, groundingKey) {
  const reconstruction = input.sourceScriptReconstruction;
  if (!reconstruction || typeof reconstruction !== "object" || Array.isArray(reconstruction) || !Object.keys(reconstruction).length) {
    throw new InputError("下游 AI 导演阶段必须使用已签名的 sourceScriptReconstruction；请先重新运行脚本还原");
  }
  try {
    let projectedAnalysis = {};
    let expectedContextDigest = null;
    const referenceAnalysis = input.referenceAnalysis;
    if (referenceAnalysis && typeof referenceAnalysis === "object" && !Array.isArray(referenceAnalysis) && Object.keys(referenceAnalysis).length) {
      if (referenceAnalysis.groundingSeal) {
        const verified = verifyReferenceAnalysis(referenceAnalysis, groundingKey);
        expectedContextDigest = verified.contextDigest;
        projectedAnalysis = verified.referenceAnalysis;
      } else {
        projectedAnalysis = referenceAnalysis;
      }
    }
    const projectedReconstruction = verifyReconstructionSeal(reconstruction, groundingKey, { expectedContextDigest });
    return {
      ...input,
      referenceAnalysis: projectedAnalysis,
      sourceScriptReconstruction: projectedReconstruction
    };
  } catch (error) {
    if (error instanceof ReconstructionGroundingError) throw new InputError(error.message);
    throw error;
  }
}

// 阶段模型输出观测：先把本次调用拿到的每条 completion 收下来，等阶段判定出来再一次性落盘。
// 失败判定复用 classifyAttemptError，错误码不另建第二份映射。纯 sidecar：不改重试预算、
// 不改控制流、不改错误语义，写盘异常一律吞掉（fail-open）。
function stageModelOutputRecorder(writer, { stage = "", provider = "", model = null } = {}) {
  if (!writer || typeof writer.recordAttempt !== "function" || !writer.enabled) return null;
  const completions = [];
  const operationId = `operation:${randomUUID()}`;
  let previousAtMs = Date.now();
  return {
    observe(completion) {
      const finishedAtMs = Date.now();
      completions.push({ completion: completion || {}, startedAtMs: previousAtMs, finishedAtMs });
      previousAtMs = finishedAtMs;
    },
    async flush({ status = "succeeded", error = null } = {}) {
      if (!completions.length) return;
      const issue = status === "failed" ? classifyAttemptError(error) : null;
      for (let callIndex = 0; callIndex < completions.length; callIndex += 1) {
        const { completion, startedAtMs, finishedAtMs } = completions[callIndex];
        // 只有最后一条对应本次阶段判定；更早的 completion 已被 client 内部丢弃，不臆造结论。
        const final = callIndex === completions.length - 1;
        try {
          await writer.recordAttempt({
            operationId,
            callIndex,
            stage,
            provider,
            model: model || "",
            reason: callIndex === 0 ? "primary" : "client-retry",
            status: final ? status : "superseded",
            category: final && issue ? issue.category : "",
            code: final ? (issue ? issue.code : "MODEL_COMPLETION_ACCEPTED") : "",
            retryable: Boolean(final && issue?.retryable),
            finishReason: String(completion.finishReason || ""),
            providerRequestId: String(completion.requestId || ""),
            usage: completion.usage || null,
            content: typeof completion.content === "string" ? completion.content : "",
            contentPresent: typeof completion.content === "string",
            startedAt: new Date(startedAtMs).toISOString(),
            finishedAt: new Date(finishedAtMs).toISOString(),
            durationMs: Math.max(0, finishedAtMs - startedAtMs)
          });
        } catch {
          // writer 自身已经吞掉写入异常，这里只兜住意外抛出。
        }
      }
    }
  };
}

function normalizeCharacterReference(result = {}, fallback = {}, input = {}) {
  const value = result.characterReference || result;
  const characterName = String(value.characterName || fallback.characterName || "").trim();
  const appearancePrompt = String(value.appearancePrompt || fallback.appearancePrompt || "").trim();
  if (!characterName) throw new OutputContractError("characterReference 缺少 characterName");
  if (!appearancePrompt) throw new OutputContractError("characterReference 缺少 appearancePrompt");
  const normalized = {
    ...fallback,
    characterName,
    storyRole: String(value.storyRole || fallback.storyRole || "").trim(),
    identity: String(value.identity || fallback.identity || "").trim(),
    appearancePrompt,
    consistencyTags: normalizeStringArray(value.consistencyTags, fallback.consistencyTags),
    forbiddenChanges: normalizeStringArray(value.forbiddenChanges, fallback.forbiddenChanges),
    referenceImageAdded: true,
    referenceImageName: String(input.imageName || fallback.referenceImageName || "").trim(),
    referenceImageNotes: String(value.referenceImageNotes || value.imageAnalysis || fallback.referenceImageNotes || "").trim()
  };
  // 人物参考精修是用户上传环节：边界偏差只随结果回传提醒，不阻断用户继续下一步。
  // boundaryWarning 与 referenceImageOverrideNotice 都只用于展示，浏览器写回 Plan 前必须剥离，不进入 Artifact。
  // 配角以用户上传的参考图为准，覆盖了什么由模型如实回报；固定角色没有覆盖权，
  // 那条路的唯一提醒通道仍是 boundaryWarning，模型即使写了覆盖说明也丢弃。
  const fixedCharacterName = String(input.visualGuardrails?.fixedCharacterBoundary?.characterName || "").trim();
  const referenceImageOverrideNotice = characterName === fixedCharacterName
    ? ""
    : String(value.referenceImageOverrideNotice || "").trim();
  // 提醒只描述本次这一步，绝不从上一版角色参考沿用。
  delete normalized.referenceImageOverrideNotice;
  delete normalized.boundaryRestoreNotice;
  // 精修可以按参考图改写外观，但不得因此丢掉全局必需角色事实——「穿着适合户外写生的村民
  // 服装」被换成具体衣物时，identity 类的「村民」就没了，而判定是字面比对。缺哪条就在
  // consistencyTags 尾部按签发顺序补它的 exact canonicalName：冻结 appearancePrompt，
  // 不用同义词、不重排、不改写外观，与 Foundation 局部纠错同一条最小补写语义。
  // 缺失清单来自与判定共用的扫描口径，不另建。只补非 appearance 事实：外观写错了
  // 必须继续提醒并在渲染前硬失败，补标签不能顶替把长相写对。
  const restoredRequiredTraits = characterReferenceRestorableMissingTraits(normalized, input.visualGuardrails);
  if (restoredRequiredTraits.length) {
    normalized.consistencyTags = [...normalized.consistencyTags, ...restoredRequiredTraits];
  }
  const boundaryWarning = characterReferenceBoundaryMismatch(normalized, input.visualGuardrails);
  if (boundaryWarning) normalized.boundaryWarning = `模型输出未通过校验：${boundaryWarning}`;
  if (referenceImageOverrideNotice) normalized.referenceImageOverrideNotice = referenceImageOverrideNotice;
  // 服务端改了模型输出就必须说出来，不做静默修补。
  if (restoredRequiredTraits.length) {
    normalized.boundaryRestoreNotice = `模型改写外观时丢了全局必需角色事实，已按签发顺序补进一致性标签：${restoredRequiredTraits.join("、")}`;
  }
  return normalized;
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return Array.isArray(source) ? source.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function validateAnimationPlanOutput(result, input = {}) {
  const primaryCharacterName = resolveExplicitAnimationPrimaryCharacterName(input, result, {
    path: "animationPlan"
  });
  ensureOutputContract(
    createAnimationEmotionValidationProjection(result, primaryCharacterName),
    "animationPlan"
  );
  if (result?.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    // 暂时弃置，后续优化或删除：direct_shot 不运行本地 Prompt Compiler；v2 兼容实现保留在下方。
    const pruned = pruneAnimationPlanNegativePrompts(structuredClone(result), input);
    return ensureAnimationPlanMatchesProfile(
      pruned,
      input.creatorProfile,
      input.creativeBrief,
      input.variant,
      input.visualGuardrails,
      input
    );
  }
  const structured = structuredClone(result);
  const normalized = normalizeAnimationPlanPromptAliases(structured);
  ensureAnimationPlanV2Contract(
    createAnimationEmotionValidationProjection(normalized, primaryCharacterName, { compileAliases: true }),
    { compileShotPrompts: compileAnimationShotPrompts }
  );
  const pruned = pruneAnimationPlanNegativePrompts(normalized, input);
  return ensureAnimationPlanMatchesProfile(
    pruned,
    input.creatorProfile,
    input.creativeBrief,
    input.variant,
    input.visualGuardrails,
    input
  );
}

function validateAnimationFoundationOutput(result, input = {}) {
  if (Object.prototype.hasOwnProperty.call(result?.productionStrategy || {}, "videoPromptProfile")) {
    throw new OutputContractError("animationFoundation.productionStrategy.videoPromptProfile 由服务端签发，模型不得输出");
  }
  if (Object.prototype.hasOwnProperty.call(result?.productionStrategy || {}, "backgroundMusicMode")) {
    throw new OutputContractError("animationFoundation.productionStrategy.backgroundMusicMode 由服务端签发，模型不得输出");
  }
  const sourceSceneIds = (input.fullStory?.sceneScript || []).map((scene) => scene?.sceneId);
  const foundation = ensureAnimationFoundationContract(result, { sourceSceneIds });
  const expectedSchemaVersion = input.animationPlanMode === ANIMATION_DIRECT_SHOT_MODE
    ? ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    : "2.0";
  if (foundation.promptSchemaVersion !== expectedSchemaVersion) {
    throw new OutputContractError(
      `animationFoundation.promptSchemaVersion 与 animationPlanMode 不匹配，必须为 ${expectedSchemaVersion}`
    );
  }
  if (
    expectedSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    && foundation.productionStrategy?.format !== "direct_shot_video"
  ) {
    throw new OutputContractError(
      "animationFoundation.productionStrategy.format 在 direct_shot 模式必须为 direct_shot_video"
    );
  }
  if (foundation.productionStrategy?.targetAspectRatio !== input.targetAspectRatio) {
    throw new OutputContractError(
      `animationFoundation.productionStrategy.targetAspectRatio 必须等于用户选择的 ${input.targetAspectRatio}`
    );
  }
  resolveExplicitAnimationPrimaryCharacterName(input, foundation, {
    path: "animationFoundation"
  });
  const checked = ensureAnimationPlanMatchesProfile(
    { ...foundation, shotPlan: [] },
    input.creatorProfile,
    input.creativeBrief,
    input.variant,
    input.visualGuardrails,
    input
  );
  const { shotPlan: ignoredShotPlan, ...validatedFoundation } = checked;
  if (expectedSchemaVersion !== ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) return validatedFoundation;
  // 3.1 的镜头时长全部由 Full Story timeRange 派生，"建议单镜时长"这个字段
  // 已经没有对应的事实，模型即使仍旧输出也一律剥掉，不留一个无人负责的旧字段。
  const {
    recommendedShotDurationSeconds: droppedShotDurationRecommendation,
    ...validatedProductionStrategy
  } = validatedFoundation.productionStrategy || {};
  return {
    ...validatedFoundation,
    productionStrategy: {
      ...validatedProductionStrategy,
      // 全片目标时长 = 骨架各镜时长之和 = 各场 timeRange 跨度之和。
      targetRuntimeSeconds: directShotSkeletonRuntimeSeconds(input.directShotSkeleton),
      videoPromptProfile: structuredClone(input.videoPromptProfile),
      backgroundMusicMode: input.backgroundMusicMode || BACKGROUND_MUSIC_NONE
    }
  };
}

function resolveDirectShotVideoPromptProfile(target) {
  try {
    return resolveVideoPromptProfile(target);
  } catch (error) {
    throw new InputError(`direct_shot 必须显式选择受支持的视频提示词目标：${error.message}`);
  }
}

function animationVideoPromptSemanticAuditCatalogInput(input = {}, {
  reviewShotIds = null
} = {}) {
  const sourcePlan = requireObject(input.sourcePlan, "sourcePlan");
  const rewrittenPlan = requireObject(input.rewrittenPlan, "rewrittenPlan");
  const sourceShots = Array.isArray(sourcePlan.shotPlan) ? sourcePlan.shotPlan : [];
  const candidateShots = Array.isArray(rewrittenPlan.shotPlan) ? rewrittenPlan.shotPlan : [];
  if (!sourceShots.length || sourceShots.length !== candidateShots.length) {
    throw new OutputContractError("Animation videoPrompt 语义审计要求 source/candidate shotPlan 等长且非空");
  }

  const requestedIds = reviewShotIds === null
    ? null
    : new Set(Array.isArray(reviewShotIds) ? reviewShotIds.map(String) : []);
  if (requestedIds && !requestedIds.size) {
    throw new OutputContractError("Animation videoPrompt 复审至少需要一个 shotId");
  }
  const knownShotIds = new Set(candidateShots.map((shot) => String(shot?.shotId || "")));
  if (requestedIds && [...requestedIds].some((shotId) => !knownShotIds.has(shotId))) {
    throw new OutputContractError("Animation videoPrompt 复审 shotId 不属于当前候选 Plan");
  }

  const fixedCharacterBoundary = projectAnimationSemanticAuditBoundary(
    input.visualGuardrails?.fixedCharacterBoundary
  );
  const keyProps = structuredClone(input.fullStory?.keyProps || []);
  const fullStoryScenes = Array.isArray(input.fullStory?.sceneScript)
    ? input.fullStory.sceneScript
    : [];
  const sceneReferences = Array.isArray(rewrittenPlan.sceneReferencePrompts)
    ? rewrittenPlan.sceneReferencePrompts
    : [];
  const rewriteAudit = input.auditMode === "rewrite";
  const shots = candidateShots.flatMap((candidateShot, shotIndex) => {
    const shotId = String(candidateShot?.shotId || "");
    if (requestedIds && !requestedIds.has(shotId)) return [];
    const sourceShot = sourceShots[shotIndex];
    if (!isPlainObject(sourceShot) || String(sourceShot.shotId || "") !== shotId) {
      throw new OutputContractError(`Animation videoPrompt 语义审计 ${shotId || shotIndex} 与 source Plan 镜头顺序不一致`);
    }
    const sourceSceneMatches = fullStoryScenes.filter(
      (scene) => String(scene?.sceneId || "") === String(candidateShot.sourceSceneId || "")
    );
    if (sourceSceneMatches.length !== 1) {
      throw new OutputContractError(`Animation videoPrompt 语义审计 ${shotId} 必须定位唯一 Full Story source scene`);
    }
    const sceneReferenceMatches = sceneReferences.filter(
      (scene) => String(scene?.sceneId || "") === String(candidateShot.sceneId || "")
    );
    if (sceneReferenceMatches.length !== 1) {
      throw new OutputContractError(`Animation videoPrompt 语义审计 ${shotId} 必须定位唯一 Foundation scene lock`);
    }
    const sourceScene = sourceSceneMatches[0];
    const authorityFacts = [
      semanticAuditAuthorityFact(shotId, "fixedCharacterBoundary", "fixed_character", fixedCharacterBoundary),
      semanticAuditAuthorityFact(shotId, "fullStory.scene.characters", "full_story", sourceScene.characters || []),
      semanticAuditAuthorityFact(shotId, "fullStory.scene.location", "full_story", sourceScene.location || ""),
      semanticAuditAuthorityFact(shotId, "fullStory.scene.visibleAction", "full_story", sourceScene.visibleAction || ""),
      semanticAuditAuthorityFact(shotId, "fullStory.scene.dialogue", "full_story", sourceScene.dialogue ?? ""),
      semanticAuditAuthorityFact(shotId, "fullStory.scene.shotAndSound", "full_story", sourceScene.shotAndSound ?? ""),
      semanticAuditAuthorityFact(shotId, "fullStory.keyProps", "full_story", keyProps),
      semanticAuditAuthorityFact(shotId, "foundation.visualBible", "foundation", rewrittenPlan.visualBible || {}),
      semanticAuditAuthorityFact(shotId, "foundation.characterReferencePrompts", "foundation", rewrittenPlan.characterReferencePrompts || []),
      semanticAuditAuthorityFact(shotId, "foundation.sceneReferencePrompt", "foundation", sceneReferenceMatches[0]),
      // Deliberately send the complete signed asset lock. Selecting a subset
      // with local keyword heuristics would recreate the omission that caused
      // the real A03 wildflower false positive.
      semanticAuditAuthorityFact(shotId, "foundation.assetPrompts", "foundation", rewrittenPlan.assetPrompts || []),
      semanticAuditAuthorityFact(shotId, "foundation.visualProductionStrategy", "foundation", {
        targetAspectRatio: rewrittenPlan.productionStrategy?.targetAspectRatio,
        videoPromptProfile: rewrittenPlan.productionStrategy?.videoPromptProfile
      }),
      ...(candidateShots[shotIndex - 1]
        ? [semanticAuditAuthorityFact(
          shotId,
          "adjacent.previousShot",
          "adjacent_shot",
          projectAnimationSemanticAdjacentShot(candidateShots[shotIndex - 1])
        )]
        : []),
      ...(candidateShots[shotIndex + 1]
        ? [semanticAuditAuthorityFact(
          shotId,
          "adjacent.nextShot",
          "adjacent_shot",
          projectAnimationSemanticAdjacentShot(candidateShots[shotIndex + 1])
        )]
        : []),
      ...animationSemanticExactShotAuthorityFacts(shotId, candidateShot),
      ...(rewriteAudit
        ? [semanticAuditAuthorityFact(shotId, "sourcePlan.videoPrompt", "exact_shot", sourceShot.videoPrompt || "")]
        : [])
    ];
    const candidateFields = [
      "sourceSceneId",
      "sceneId",
      "durationSeconds",
      "storyPurpose",
      "emotionalTarget",
      "cameraMotion",
      "characterAction",
      "dialogueOrSubtitle",
      "soundDesign",
      "continuityNotes",
      "acceptanceCriteria"
    ].map((field) => ({
      candidateFieldId: `${shotId}:candidate:${field}`,
      layer: "shot_facts",
      field,
      value: structuredClone(candidateShot[field])
    }));
    candidateFields.push({
      candidateFieldId: `${shotId}:candidate:videoPrompt`,
      layer: "video_prompt",
      field: "videoPrompt",
      value: String(candidateShot.videoPrompt || "")
    });
    return [{ shotId, authorityFacts, candidateFields }];
  });
  return { shots };
}

function semanticAuditAuthorityFact(shotId, field, tier, value) {
  return {
    authorityFactId: `${shotId}:authority:${field}`,
    tier,
    field,
    value: structuredClone(value ?? null)
  };
}

function animationSemanticExactShotAuthorityFacts(shotId, shot) {
  return [
    "sourceSceneId",
    "sceneId",
    "durationSeconds",
    "storyPurpose",
    "emotionalTarget",
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "soundDesign",
    "continuityNotes",
    "acceptanceCriteria"
  ].map((field) => semanticAuditAuthorityFact(
    shotId,
    `exactShot.${field}`,
    "exact_shot",
    shot[field]
  ));
}

function projectAnimationSemanticAdjacentShot(shot) {
  return {
    shotId: String(shot?.shotId || ""),
    sourceSceneId: String(shot?.sourceSceneId || ""),
    sceneId: String(shot?.sceneId || ""),
    characterAction: String(shot?.characterAction || ""),
    continuityNotes: String(shot?.continuityNotes || ""),
    acceptanceCriteria: structuredClone(shot?.acceptanceCriteria || [])
  };
}

function projectAnimationSemanticAuditBoundary(boundary) {
  if (!isPlainObject(boundary)) {
    throw new OutputContractError("Animation videoPrompt 语义审计缺少验签 fixedCharacterBoundary");
  }
  return {
    schemaVersion: String(boundary.schemaVersion || ""),
    characterName: String(boundary.characterName || ""),
    canonicalDescription: String(boundary.canonicalDescription || ""),
    bodyForm: String(boundary.bodyForm || ""),
    requiredTraits: structuredClone(boundary.requiredTraits || []),
    allowedTraits: structuredClone(boundary.allowedTraits || []),
    forbiddenTraits: structuredClone(boundary.forbiddenTraits || []),
    unresolvedConflicts: structuredClone(boundary.unresolvedConflicts || [])
  };
}

function animationVideoPromptSemanticRepairIdentity(input, auditMode) {
  return {
    auditMode,
    selectedVariantId: String(input.fullStory?.selectedVariantId || input.variant?.id || ""),
    sourceProfile: structuredClone(input.sourcePlan?.productionStrategy?.videoPromptProfile || null),
    targetProfile: structuredClone(input.targetProfile || null),
    targetAspectRatio: String(input.rewrittenPlan?.productionStrategy?.targetAspectRatio || "")
  };
}

function assertOnlySelectedAnimationVideoPromptsChanged(before, after, repairedShotIds) {
  const mutableShotIds = new Set(repairedShotIds.map(String));
  const beforePlan = structuredClone(before);
  const afterPlan = structuredClone(after);
  const beforeShots = beforePlan.shotPlan;
  const afterShots = afterPlan.shotPlan;
  delete beforePlan.shotPlan;
  delete afterPlan.shotPlan;
  if (!isDeepStrictEqual(beforePlan, afterPlan) || beforeShots.length !== afterShots.length) {
    throw new OutputContractError("Animation videoPrompt 语义修复不得改变 Plan 顶层事实或镜头数量");
  }
  beforeShots.forEach((beforeShot, index) => {
    const afterShot = afterShots[index];
    if (beforeShot.shotId !== afterShot?.shotId) {
      throw new OutputContractError("Animation videoPrompt 语义修复不得重排镜头");
    }
    if (!mutableShotIds.has(String(beforeShot.shotId))) {
      if (!isDeepStrictEqual(beforeShot, afterShot)) {
        throw new OutputContractError(`Animation videoPrompt 语义修复越权修改 ${beforeShot.shotId}`);
      }
      return;
    }
    const beforeFacts = structuredClone(beforeShot);
    const afterFacts = structuredClone(afterShot);
    delete beforeFacts.videoPrompt;
    delete afterFacts.videoPrompt;
    if (!isDeepStrictEqual(beforeFacts, afterFacts)) {
      throw new OutputContractError(`Animation videoPrompt 语义修复不得改动 ${beforeShot.shotId} 的结构化事实`);
    }
  });
}

function animationSemanticRepairReviewShotIds(plan, repairedShotIds) {
  const targetIds = new Set(repairedShotIds.map(String));
  const selected = new Set();
  plan.shotPlan.forEach((shot, index) => {
    if (!targetIds.has(String(shot.shotId))) return;
    [index - 1, index, index + 1].forEach((candidateIndex) => {
      const neighbor = plan.shotPlan[candidateIndex];
      if (neighbor) selected.add(String(neighbor.shotId));
    });
  });
  return plan.shotPlan.map((shot) => String(shot.shotId)).filter((shotId) => selected.has(shotId));
}

function formatAnimationVideoPromptSemanticAuditFailure(audit) {
  const messages = audit.shots.flatMap((shot) => shot.issues.map((issue) => (
    `${shot.shotId} ${issue.layer}/${issue.relation}: ${issue.productionImpact}`
  )));
  return messages.join("；") || "审计返回 fail，但没有可用的实质冲突证据";
}

function animationVideoPromptSemanticAuditReceipt({
  settings,
  auditMode,
  rounds,
  initialReviewedShotIds,
  reReviewedShotIds,
  repairedShotIds
}) {
  return freezeClone({
    schemaVersion: "animation_video_prompt_semantic_audit_receipt/2.0",
    provider: String(settings.provider || ""),
    model: String(settings.model || ""),
    auditMode,
    verdict: "pass",
    issues: [],
    rounds,
    reviewedShotIds: initialReviewedShotIds,
    reReviewedShotIds,
    repairedShotIds
  });
}

function validateAnimationVideoPromptRewrite(value, sourcePlan, videoPromptProfile) {
  if (!isPlainObject(value)) {
    throw new OutputContractError("animationVideoPromptRewrite 必须是对象");
  }
  const keys = Object.keys(value).sort();
  if (!isDeepStrictEqual(keys, ["videoPrompts"])) {
    throw new OutputContractError("animationVideoPromptRewrite 只允许顶层字段 videoPrompts");
  }
  if (!Array.isArray(value.videoPrompts)) {
    throw new OutputContractError("animationVideoPromptRewrite.videoPrompts 必须是数组");
  }
  const sourceShots = Array.isArray(sourcePlan?.shotPlan) ? sourcePlan.shotPlan : [];
  if (value.videoPrompts.length !== sourceShots.length) {
    throw new OutputContractError(
      `animationVideoPromptRewrite.videoPrompts 数量必须严格等于当前 Plan 的 ${sourceShots.length}`
    );
  }
  const normalized = value.videoPrompts.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new OutputContractError(`animationVideoPromptRewrite.videoPrompts[${index}] 必须是对象`);
    }
    if (!isDeepStrictEqual(Object.keys(item).sort(), ["shotId", "videoPrompt"])) {
      throw new OutputContractError(
        `animationVideoPromptRewrite.videoPrompts[${index}] 只允许 shotId、videoPrompt`
      );
    }
    const expectedShot = sourceShots[index];
    const shotId = String(item.shotId || "").trim();
    const videoPrompt = String(item.videoPrompt || "").trim();
    if (shotId !== expectedShot.shotId) {
      throw new OutputContractError(
        `animationVideoPromptRewrite.videoPrompts[${index}].shotId 必须按原顺序等于 ${expectedShot.shotId}`
      );
    }
    if (!videoPrompt) {
      throw new OutputContractError(`animationVideoPromptRewrite.videoPrompts[${index}].videoPrompt 不能为空`);
    }
    return { shotId, videoPrompt };
  });
  return { videoPrompts: normalized };
}

function assertOnlyAnimationVideoPromptsChanged(sourcePlan, rewrittenPlan, targetProfile) {
  const stripMutablePromptFields = (plan) => {
    const comparable = structuredClone(plan);
    if (isPlainObject(comparable.productionStrategy)) {
      delete comparable.productionStrategy.videoPromptProfile;
    }
    if (Array.isArray(comparable.shotPlan)) {
      comparable.shotPlan.forEach((shot) => {
        if (isPlainObject(shot)) delete shot.videoPrompt;
      });
    }
    return comparable;
  };
  if (!isDeepStrictEqual(stripMutablePromptFields(sourcePlan), stripMutablePromptFields(rewrittenPlan))) {
    throw new OutputContractError("视频提示词目标改写不得改变 videoPrompt 与签发 Profile 之外的 Plan 字段");
  }
  try {
    const actualProfile = ensureAnimationPlanVideoPromptProfile(rewrittenPlan);
    if (!isDeepStrictEqual(actualProfile, targetProfile)) {
      throw new OutputContractError("视频提示词目标改写后的签发 Profile 与用户目标不一致");
    }
  } catch (error) {
    if (error instanceof OutputContractError) throw error;
    throw new OutputContractError(error.message);
  }
}

// direct_shot 3.1 的镜头骨架是服务端从 Full Story 派生的唯一权威。
// shotId / durationSeconds / storyPurpose / emotionalTarget / sceneId 由服务端
// 确定性注入，这里只复核数量、顺序与 sourceSceneId 归属：
// 它们一旦对不上，说明模型写错了镜头内容的归属，注入只会把错误藏起来。
function assertDirectShotBatchMatchesSkeleton(shots, skeleton, { path = "animationShotBatch" } = {}) {
  if (!Array.isArray(skeleton)) {
    throw new OutputContractError(`${path} 缺少服务端签发的镜头骨架，无法校验一对一映射`);
  }
  const expectation = formatDirectShotSkeleton(skeleton);
  if (shots.length !== skeleton.length) {
    throw new OutputContractError(
      `${path}.shotPlan 必须恰好输出 ${skeleton.length} 个镜头，实际 ${shots.length} 个。`
      + `镜头数量由 Full Story 的 timeRange 确定性派生，不得拆分、合并、新增或遗漏。`
      + `本批骨架：${expectation}`
    );
  }
  shots.forEach((shot, index) => {
    const expected = skeleton[index];
    if (String(shot?.sourceSceneId || "").trim() !== expected.sourceSceneId) {
      throw new OutputContractError(
        `${path}.shotPlan[${index}].sourceSceneId 必须是 ${expected.sourceSceneId}，实际 ${shot?.sourceSceneId || "缺失"}。`
        + `镜头顺序必须逐位对应骨架：${expectation}`
      );
    }
  });
  return shots;
}

function validateAnimationShotBatchOutput(result, {
  input,
  foundation,
  sourceScenes,
  batchIndex = null,
  shotIdStartIndex,
  skeleton = null,
  previousShots = []
}) {
  const sourceSceneIds = sourceScenes.map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean);
  const primaryCharacterName = resolveExplicitAnimationPrimaryCharacterName(input, foundation);
  ensureAnimationShotBatchContract(
    createAnimationEmotionValidationProjection(result, primaryCharacterName, {
      path: "animationShotBatch",
      batchIndex,
      sourceSceneIds
    }),
    { promptSchemaVersion: foundation?.promptSchemaVersion || "" }
  );
  const batch = structuredClone(result);
  if (foundation?.promptSchemaVersion === "2.0") {
    batch.shotPlan.forEach((shot, index) => {
      if (hasStructuredAnimationPromptSource(shot)) return;
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}] 必须输出 v2 结构化字段：startFrame、endFrame、motion`);
    });
  }
  if (foundation?.promptSchemaVersion !== ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    ensureAnimationPlanV2Contract(
      createAnimationEmotionValidationProjection(batch, primaryCharacterName, {
        compileAliases: true,
        path: "animationShotBatch",
        batchIndex,
        sourceSceneIds
      }),
      {
        path: "animationShotBatch",
        allowVersionlessStructured: true,
        compileShotPrompts: compileAnimationShotPrompts
      }
    );
  }
  const allowedSourceScenes = new Set(sourceSceneIds);
  const knownSceneIds = new Set((foundation.sceneReferencePrompts || []).map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean));
  const sceneIdBySourceScene = new Map((foundation.sceneReferencePrompts || []).flatMap((scene) => (
    (scene.sourceSceneIds || []).map((sourceSceneId) => [String(sourceSceneId || "").trim(), String(scene.sceneId || "").trim()])
  )));
  const sourceOrder = new Map(sourceSceneIds.map((sceneId, index) => [sceneId, index]));
  let previousSourceIndex = -1;

  batch.shotPlan.forEach((shot, index) => {
    if (!allowedSourceScenes.has(shot.sourceSceneId)) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}].sourceSceneId 不属于当前批次：${shot.sourceSceneId}`);
    }
    const currentSourceIndex = sourceOrder.get(shot.sourceSceneId);
    if (currentSourceIndex < previousSourceIndex) {
      throw new OutputContractError("animationShotBatch.shotPlan 必须按当前批次的剧情场次顺序输出");
    }
    previousSourceIndex = currentSourceIndex;
    if (!knownSceneIds.has(shot.sceneId)) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}].sceneId 未引用已生成的场景参考：${shot.sceneId}`);
    }
    const expectedSceneId = sceneIdBySourceScene.get(shot.sourceSceneId);
    if (shot.sceneId !== expectedSceneId) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}].sceneId 必须使用 ${shot.sourceSceneId} 映射的场景参考 ${expectedSceneId || "未映射"}`);
    }
  });

  const covered = new Set(batch.shotPlan.map((shot) => shot.sourceSceneId));
  const missingScenes = sourceSceneIds.filter((sceneId) => !covered.has(sceneId));
  if (missingScenes.length) {
    throw new OutputContractError(`animationShotBatch 未覆盖当前批次剧情场次：${missingScenes.join("、")}`);
  }

  // 3.1：本批镜头由服务端骨架完全确定，模型没有数量、顺序或时长的自由度。
  // 数量或场次归属对不上说明模型自行拆镜、合并或漏写，必须明确失败——
  // 服务端只对可从 Full Story 唯一推导的字段做确定性注入，不掩盖内容错位。
  if (foundation?.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    assertDirectShotBatchMatchesSkeleton(batch.shotPlan, skeleton);
  }

  const previousCount = previousShots.length;
  const pruned = pruneAnimationPlanNegativePrompts({ ...foundation, shotPlan: [...previousShots, ...batch.shotPlan] }, input);
  const checked = ensureAnimationPlanMatchesProfile(
    pruned,
    input.creatorProfile,
    input.creativeBrief,
    input.variant,
    input.visualGuardrails,
    input
  );
  const checkedBatch = { shotPlan: checked.shotPlan.slice(previousCount) };
  // Sign a prompt-only repair only after every non-prompt validation above
  // has passed. Otherwise a candidate with a missing scene or invalid
  // duration could consume the sole correction call before its real blocker
  // is discovered.
  validateSeedanceBackgroundMusicSentence(
    checkedBatch,
    foundation,
    previousShots.length
  );
  return checkedBatch;
}

// 用户关闭背景音乐时，videoPrompt 必须以签发的那句中文逐字收尾。
// 方言只有一种，两个视频供应商共用这条约束。
function validateSeedanceBackgroundMusicSentence(batch, foundation, shotIndexOffset = 0) {
  if (foundation?.productionStrategy?.backgroundMusicMode !== BACKGROUND_MUSIC_NONE) return;
  batch.shotPlan.forEach((shot, index) => {
    if (String(shot?.videoPrompt || "").trim().endsWith(NO_BACKGROUND_MUSIC_SENTENCE)) return;
    throw new OutputContractError(
      `animationPlan.shotPlan[${shotIndexOffset + index}].videoPrompt 必须以「${NO_BACKGROUND_MUSIC_SENTENCE}」`
      + "逐字收尾（用户已关闭背景音乐）。"
    );
  });
}

function resolveExplicitAnimationPrimaryCharacterName(input = {}, foundation = {}, {
  path = "animationFoundation"
} = {}) {
  const primaryCharacterName = String(input?.fullStory?.characterBible?.protagonist?.name || "").trim();
  if (!primaryCharacterName) return "";
  const characterReferences = Array.isArray(foundation?.characterReferencePrompts)
    ? foundation.characterReferencePrompts
    : [];
  const matchingReferences = characterReferences.filter(
    (reference) => String(reference?.characterName || "").trim() === primaryCharacterName
  );
  if (matchingReferences.length !== 1) {
    const referencePath = `${path}.characterReferencePrompts`;
    const actualCharacterNames = characterReferences.map(
      (reference) => String(reference?.characterName || "").trim()
    );
    throw new OutputContractError(
      `${referencePath} 中全剧主角「${primaryCharacterName}」必须以 characterName 精确出现一次，实际 ${matchingReferences.length} 次`,
      [{
        code: "ANIMATION_PRIMARY_CHARACTER_REFERENCE_MATCH_FAILURE",
        path: referencePath,
        reason: `全剧主角「${primaryCharacterName}」的角色参考必须唯一且使用标准姓名`,
        expectedPrimaryCharacterName: primaryCharacterName,
        exactMatchCount: matchingReferences.length,
        actualCharacterNames
      }]
    );
  }
  return primaryCharacterName;
}

function createAnimationEmotionValidationProjection(value, primaryCharacterName, {
  compileAliases = false,
  path = "animationPlan",
  batchIndex = null,
  sourceSceneIds = []
} = {}) {
  const projected = structuredClone(value);
  if (!isPlainObject(projected) || !Array.isArray(projected.shotPlan)) {
    return projected;
  }

  if (projected.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    const appearanceFields = [
      "videoPrompt",
      "characterAction",
      "dialogueOrSubtitle",
      "continuityNotes"
    ];
    const canonicalProtagonistAppearanceCount = primaryCharacterName
      ? projected.shotPlan.reduce((count, shot) => count + (
        appearanceFields.some((field) => String(shot?.[field] || "").includes(primaryCharacterName)) ? 1 : 0
      ), 0)
      : 0;
    if (
      primaryCharacterName
      && path === "animationPlan"
      && projected.shotPlan.length > 0
      && canonicalProtagonistAppearanceCount === 0
    ) {
      throw new OutputContractError(
        `${path}.shotPlan 必须至少有一个直接视频镜头让全剧主角「${primaryCharacterName}」实际出镜`,
        [{
          code: "ANIMATION_PRIMARY_CHARACTER_MISSING_FROM_SHOT_PLAN",
          path: `${path}.shotPlan`,
          reason: `全剧主角「${primaryCharacterName}」必须出现在 videoPrompt、characterAction、dialogueOrSubtitle 或 continuityNotes 的真实镜头描述中`
        }]
      );
    }
    return projected;
  }

  let canonicalProtagonistAppearanceCount = 0;
  projected.shotPlan.forEach((shot, shotIndex) => {
    if (!isPlainObject(shot?.motion?.emotionArc)) return;
    const startCharacters = Array.isArray(shot?.startFrame?.characters) ? shot.startFrame.characters : null;
    const endCharacters = Array.isArray(shot?.endFrame?.characters) ? shot.endFrame.characters : null;
    if (!startCharacters || !endCharacters) return;

    if (primaryCharacterName) {
      const canonicalDiagnostics = ["startFrame", "endFrame"].map((frameKind) => (
        animationPrimaryCharacterFrameDiagnostic({
          characters: frameKind === "startFrame" ? startCharacters : endCharacters,
          frameKind,
          path,
          shotIndex,
          primaryCharacterName,
          roleLabel: "全剧主角"
        })
      ));
      const invalidCanonicalDiagnostics = canonicalDiagnostics.filter((diagnostic) => (
        diagnostic.category === "duplicate" || diagnostic.category === "inexact"
      ));
      canonicalProtagonistAppearanceCount += canonicalDiagnostics.reduce(
        (count, diagnostic) => count + diagnostic.exactMatchCount,
        0
      );
      if (invalidCanonicalDiagnostics.length > 0) {
        throw animationCharacterMatchError({
          shot,
          shotIndex,
          path,
          batchIndex,
          sourceSceneIds,
          expectedName: primaryCharacterName,
          expectationLabel: "标准主角",
          failureLabel: "主角身份精确匹配失败",
          code: "ANIMATION_PRIMARY_CHARACTER_MATCH_FAILURE",
          diagnostics: invalidCanonicalDiagnostics
        });
      }
    }

    const shotPrimaryCharacterName = String(startCharacters[0]?.name || "").trim();
    if (!shotPrimaryCharacterName) return;
    const startDiagnostic = animationPrimaryCharacterFrameDiagnostic({
      characters: startCharacters,
      frameKind: "startFrame",
      path,
      shotIndex,
      primaryCharacterName: shotPrimaryCharacterName,
      roleLabel: "镜头主角色"
    });
    const endDiagnostic = animationPrimaryCharacterFrameDiagnostic({
      characters: endCharacters,
      frameKind: "endFrame",
      path,
      shotIndex,
      primaryCharacterName: shotPrimaryCharacterName,
      roleLabel: "镜头主角色"
    });
    const startMatches = startDiagnostic.matches;
    const endMatches = endDiagnostic.matches;
    const motionPath = `${path}.shotPlan[${shotIndex}].motion`;
    if (startMatches.length !== 1 || endMatches.length !== 1) {
      const invalidDiagnostics = [startDiagnostic, endDiagnostic].filter(
        (diagnostic) => diagnostic.exactMatchCount !== 1
      );
      throw animationCharacterMatchError({
        shot,
        shotIndex,
        path,
        batchIndex,
        sourceSceneIds,
        expectedName: shotPrimaryCharacterName,
        expectationLabel: "镜头主角色",
        failureLabel: "镜头主角色唯一匹配失败",
        code: "ANIMATION_SHOT_PRIMARY_CHARACTER_MATCH_FAILURE",
        diagnostics: invalidDiagnostics
      });
    }
    if (shot.motion.emotionArc.from !== startMatches[0].emotionState) {
      throw new OutputContractError(
        `${motionPath}.emotionArc.from 必须等于镜头主角色「${shotPrimaryCharacterName}」的 startFrame emotionState`
      );
    }
    if (shot.motion.emotionArc.to !== endMatches[0].emotionState) {
      throw new OutputContractError(
        `${motionPath}.emotionArc.to 必须等于镜头主角色「${shotPrimaryCharacterName}」的 endFrame emotionState`
      );
    }

    if (compileAliases && hasCompilableStructuredAnimationPromptSource(shot)) {
      try {
        Object.assign(shot, compileAnimationShotPrompts(shot));
      } catch (error) {
        if (!(error instanceof AnimationPromptCompilerError)) throw error;
        throw new OutputContractError(error.message);
      }
    }
  });
  if (
    primaryCharacterName
    && path === "animationPlan"
    && projected.shotPlan.length > 0
    && canonicalProtagonistAppearanceCount === 0
  ) {
    throw new OutputContractError(
      `${path}.shotPlan 必须至少有一个镜头让全剧主角「${primaryCharacterName}」实际出镜`,
      [{
        code: "ANIMATION_PRIMARY_CHARACTER_MISSING_FROM_SHOT_PLAN",
        path: `${path}.shotPlan`,
        reason: `全剧主角「${primaryCharacterName}」不能只存在于 characterReferencePrompts，必须至少在一个真实镜头首帧或尾帧中出现`
      }]
    );
  }
  return projected;
}

function animationCharacterMatchError({
  shot,
  shotIndex,
  path,
  batchIndex,
  sourceSceneIds,
  expectedName,
  expectationLabel,
  failureLabel,
  code,
  diagnostics
}) {
  const shotId = String(shot?.shotId || "").trim();
  const sourceSceneId = String(shot?.sourceSceneId || "").trim();
  const batchNumber = Number.isInteger(batchIndex) ? batchIndex + 1 : null;
  const normalizedSourceSceneIds = (Array.isArray(sourceSceneIds) ? sourceSceneIds : [])
    .map((sceneId) => String(sceneId || "").trim())
    .filter(Boolean);
  const frameSummary = diagnostics.map((diagnostic) => (
    `${diagnostic.path} 实际角色：${JSON.stringify(diagnostic.actualCharacterNames)}，`
    + `精确匹配数量：${diagnostic.exactMatchCount}，原因：${diagnostic.reason}`
  )).join("；");
  return new OutputContractError(
    `${path}.shotPlan[${shotIndex}] ${failureLabel}；`
    + `批次：${batchNumber || "未提供"}；shotId：${shotId || "未提供"}；`
    + `sourceSceneId：${sourceSceneId || "未提供"}；`
    + `sourceSceneIds：${JSON.stringify(normalizedSourceSceneIds)}；`
    + `预期${expectationLabel}：${expectedName}；${frameSummary}`,
    diagnostics.map((diagnostic) => ({
      code,
      path: diagnostic.path,
      reason: diagnostic.reason,
      batch: batchNumber,
      shotIndex,
      shotId,
      sourceSceneId,
      sourceSceneIds: normalizedSourceSceneIds,
      expectedPrimaryCharacterName: expectedName,
      actualCharacterNames: diagnostic.actualCharacterNames,
      exactMatchCount: diagnostic.exactMatchCount,
      category: diagnostic.category
    }))
  );
}

function animationPrimaryCharacterFrameDiagnostic({
  characters,
  frameKind,
  path,
  shotIndex,
  primaryCharacterName,
  roleLabel = "主角"
}) {
  const matches = characters.filter((character) => (
    isPlainObject(character)
    && String(character.name || "").trim() === primaryCharacterName
  ));
  const actualCharacterNames = characters.map((character) => (
    typeof character?.name === "string" ? character.name : ""
  ));
  const inexactNames = actualCharacterNames.filter((name) => (
    hasExplicitStandardNameSuffix(name, primaryCharacterName)
  ));
  let category = "matched";
  let reason = "精确匹配";
  if (matches.length > 1) {
    category = "duplicate";
    reason = `${roleLabel}重复`;
  } else if (inexactNames.length) {
    category = "inexact";
    reason = `${roleLabel}名称不精确：${JSON.stringify(inexactNames)}`;
  } else if (matches.length === 0) {
    category = "missing";
    reason = `${roleLabel}缺失`;
  }
  return {
    path: `${path}.shotPlan[${shotIndex}].${frameKind}.characters`,
    matches,
    actualCharacterNames,
    exactMatchCount: matches.length,
    category,
    reason
  };
}

function createAnimationShotBatchRepairContext({ foundation, shotIdStartIndex, skeleton = null }) {
  const mappedSceneIds = new Map();
  for (const scene of foundation?.sceneReferencePrompts || []) {
    const sceneId = String(scene?.sceneId || "").trim();
    for (const sourceSceneIdValue of scene?.sourceSceneIds || []) {
      const sourceSceneId = String(sourceSceneIdValue || "").trim();
      if (!sourceSceneId || !sceneId) continue;
      if (!mappedSceneIds.has(sourceSceneId)) mappedSceneIds.set(sourceSceneId, []);
      mappedSceneIds.get(sourceSceneId).push(sceneId);
    }
  }
  const sceneIdBySourceScene = [...mappedSceneIds.entries()]
    .filter(([, sceneIds]) => sceneIds.length === 1)
    .map(([sourceSceneId, sceneIds]) => Object.freeze([sourceSceneId, sceneIds[0]]));

  return Object.freeze({
    shotIdStartIndex: Number(shotIdStartIndex),
    sceneIdBySourceScene: Object.freeze(sceneIdBySourceScene),
    skeleton: Array.isArray(skeleton) ? Object.freeze([...skeleton]) : null
  });
}

export function repairAnimationShotBatchCandidate(candidate, immutableContext = {}) {
  return rebuildAnimationShotBatchAliases(
    repairAnimationShotBatchStructure(candidate, immutableContext)
  );
}

export function repairAnimationShotBatchStructure(candidate, immutableContext = {}) {
  const repaired = structuredClone(candidate);
  if (!isPlainObject(repaired) || !Array.isArray(repaired.shotPlan)) return repaired;

  const sceneIdBySourceScene = new Map(immutableContext.sceneIdBySourceScene || []);
  const shotIdStartIndex = Number(immutableContext.shotIdStartIndex);
  // 骨架长度对得上时，服务端独占的派生字段按位置确定性写回：
  // 它们全部可以从 Full Story 唯一推导，模型回显错了不构成新事实。
  // 长度对不上时一律不动，交给 validator 明确报错，避免把错位的内容重新贴标签。
  const skeleton = Array.isArray(immutableContext.skeleton)
    && immutableContext.skeleton.length === repaired.shotPlan.length
    ? immutableContext.skeleton
    : null;
  return {
    ...repaired,
    shotPlan: repaired.shotPlan.map((shot, index) => {
      if (!isPlainObject(shot)) return shot;
      const nextShot = structuredClone(shot);
      const skeletonShot = skeleton ? skeleton[index] : null;
      const shotNumber = (Number.isFinite(shotIdStartIndex) ? shotIdStartIndex : 1) + index;
      const shotId = skeletonShot ? skeletonShot.shotId : `A${String(shotNumber).padStart(2, "0")}`;
      nextShot.shotId = shotId;
      if (skeletonShot) {
        nextShot.durationSeconds = skeletonShot.durationSeconds;
        nextShot.storyPurpose = skeletonShot.storyPurpose;
        nextShot.emotionalTarget = skeletonShot.emotionalTarget;
      }

      const mappedSceneId = sceneIdBySourceScene.get(nextShot.sourceSceneId);
      if (mappedSceneId) {
        nextShot.sceneId = mappedSceneId;
        for (const frameKind of ["startFrame", "endFrame"]) {
          if (isPlainObject(nextShot[frameKind]?.environment)) {
            nextShot[frameKind].environment.sceneId = mappedSceneId;
          }
        }
      }

      if (isPlainObject(nextShot.motion)) {
        nextShot.motion.endStateRef = "endFrame";
        repairLockedAnimationCamera(nextShot);
        repairAnimationEmotionArc(nextShot);
      }

      if (isPlainObject(nextShot.negativePrompts)) {
        nextShot.negativePrompts = rewriteShotNegativePromptEvidence(nextShot.negativePrompts, shotId);
      }
      return nextShot;
    })
  };
}

export function rebuildAnimationShotBatchAliases(candidate) {
  const rebuilt = structuredClone(candidate);
  if (!isPlainObject(rebuilt) || !Array.isArray(rebuilt.shotPlan)) return rebuilt;
  return {
    ...rebuilt,
    shotPlan: rebuilt.shotPlan.map((shot) => {
      if (!hasCompilableStructuredAnimationPromptSource(shot)) return shot;
      try {
        return rebuildAnimationShotPrompts(shot);
      } catch (error) {
        if (!(error instanceof AnimationPromptCompilerError)) throw error;
        throw new OutputContractError(error.message);
      }
    })
  };
}

function stripAnimationShotBatchAliases(candidate) {
  const stripped = structuredClone(candidate);
  if (!isPlainObject(stripped) || !Array.isArray(stripped.shotPlan)) return stripped;
  stripped.shotPlan.forEach((shot) => {
    if (!isPlainObject(shot)) return;
    for (const field of COMPILED_ANIMATION_SHOT_ALIAS_FIELDS) delete shot[field];
  });
  return stripped;
}

function repairLockedAnimationCamera(shot) {
  if (shot?.motion?.cameraMove?.mode !== "locked") return;
  const startCamera = shot?.startFrame?.camera;
  const endFrame = shot?.endFrame;
  if (!hasExactCompleteAnimationCamera(startCamera) || !isPlainObject(endFrame)) return;
  const existingEndCamera = isPlainObject(endFrame.camera) ? structuredClone(endFrame.camera) : {};
  endFrame.camera = {
    ...existingEndCamera,
    ...structuredClone(startCamera)
  };
}

function hasExactCompleteAnimationCamera(camera) {
  if (!isPlainObject(camera)) return false;
  const fields = ["shotSize", "height", "angle", "viewDirection", "lensFeel", "depthOfField", "composition"];
  const keys = Object.keys(camera).sort();
  return JSON.stringify(keys) === JSON.stringify([...fields].sort())
    && fields.every((field) => typeof camera[field] === "string" && camera[field].trim());
}

function repairAnimationEmotionArc(shot) {
  if (!isPlainObject(shot?.motion?.emotionArc)) return;
  const startCharacters = Array.isArray(shot?.startFrame?.characters) ? shot.startFrame.characters : [];
  const endCharacters = Array.isArray(shot?.endFrame?.characters) ? shot.endFrame.characters : [];
  const shotPrimaryCharacterName = String(startCharacters[0]?.name || "").trim();
  if (!shotPrimaryCharacterName) return;
  const matchesShotPrimary = (character) => (
    isPlainObject(character)
    && String(character.name || "").trim() === shotPrimaryCharacterName
  );
  const startMatches = startCharacters.filter(matchesShotPrimary);
  const endMatches = endCharacters.filter(matchesShotPrimary);
  if (startMatches.length !== 1 || endMatches.length !== 1) return;
  const from = startMatches[0].emotionState;
  const to = endMatches[0].emotionState;
  if (typeof from !== "string" || !from.trim() || typeof to !== "string" || !to.trim()) return;
  shot.motion.emotionArc.from = from;
  shot.motion.emotionArc.to = to;
}

function hasCompilableStructuredAnimationPromptSource(shot) {
  return isPlainObject(shot?.startFrame)
    && isPlainObject(shot?.endFrame)
    && isPlainObject(shot?.motion);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAnimationPlanPromptAliases(plan) {
  if (plan?.promptSchemaVersion !== "2.0" || !Array.isArray(plan.shotPlan)) return plan;
  return {
    ...plan,
    shotPlan: plan.shotPlan.map((shot) => normalizeAnimationShotPromptAliases(shot, plan))
  };
}

function normalizeAnimationShotPromptAliases(shot, versionOrPlan) {
  try {
    return normalizeAnimationShotPrompts(shot, versionOrPlan);
  } catch (error) {
    if (!(error instanceof AnimationPromptCompilerError)) throw error;
    throw new OutputContractError(error.message);
  }
}

function hasStructuredAnimationPromptSource(shot) {
  return Boolean(shot?.startFrame && shot?.endFrame && shot?.motion);
}

function rewriteShotNegativePromptEvidence(negativePrompts = {}, shotId) {
  const rewriteItems = (items) => Array.isArray(items) ? items.map((item) => {
    if (!isPlainObject(item) || !Array.isArray(item.triggerEvidence)) return item;
    return {
      ...item,
      triggerEvidence: item.triggerEvidence.map((entry) => {
        if (!isPlainObject(entry) || typeof entry.sourcePath !== "string") return entry;
        return {
          ...entry,
          sourcePath: entry.sourcePath.replace(
            /^animationPlan\.(?:shotPlan|shots)\[[^\]]+\](?=\.)/u,
            `animationPlan.shotPlan[${shotId}]`
          )
        };
      })
    };
  }) : items;
  const rewritten = structuredClone(negativePrompts);
  for (const media of ["image", "video"]) {
    if (Array.isArray(rewritten[media])) rewritten[media] = rewriteItems(rewritten[media]);
  }
  return rewritten;
}

function mergeAnimationPlan(foundation, shotPlan, input = {}, skeleton = null) {
  const knownSceneIds = new Set((foundation.sceneReferencePrompts || []).map((scene) => String(scene?.sceneId || "").trim()));
  const knownSourceSceneIds = new Set((input.fullStory?.sceneScript || []).map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean));
  const shotIds = new Set();
  const coveredSourceSceneIds = new Set();
  shotPlan.forEach((shot, index) => {
    if (shotIds.has(shot.shotId)) throw new OutputContractError(`animationPlan.shotPlan 镜头编号重复：${shot.shotId}`);
    shotIds.add(shot.shotId);
    if (!knownSceneIds.has(shot.sceneId)) {
      throw new OutputContractError(`animationPlan.shotPlan[${index}].sceneId 未引用有效场景：${shot.sceneId}`);
    }
    if (!knownSourceSceneIds.has(shot.sourceSceneId)) {
      throw new OutputContractError(`animationPlan.shotPlan[${index}].sourceSceneId 未引用有效剧情场次：${shot.sourceSceneId}`);
    }
    coveredSourceSceneIds.add(shot.sourceSceneId);
  });
  const missingSourceScenes = [...knownSourceSceneIds].filter((sceneId) => !coveredSourceSceneIds.has(sceneId));
  if (missingSourceScenes.length) throw new OutputContractError(`animationPlan 未覆盖剧情场次：${missingSourceScenes.join("、")}`);

  const relatedByScene = new Map();
  shotPlan.forEach((shot) => {
    if (!relatedByScene.has(shot.sceneId)) relatedByScene.set(shot.sceneId, []);
    relatedByScene.get(shot.sceneId).push(shot.shotId);
  });
  const directShotMode = foundation.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION;
  const plannedSeconds = sumShotDurationSeconds(shotPlan);
  if (directShotMode) {
    // 合并后再对整份 shotPlan 与完整骨架做一次逐位复核：分批生成时每批
    // 只看得到自己那一段，全片的数量、顺序和总时长必须在这里最终确认。
    assertDirectShotBatchMatchesSkeleton(shotPlan, skeleton, { path: "animationPlan" });
    shotPlan.forEach((shot, index) => {
      const expected = skeleton[index];
      if (shot.shotId !== expected.shotId) {
        throw new OutputContractError(
          `animationPlan.shotPlan[${index}].shotId 必须是 ${expected.shotId}，实际 ${shot.shotId}`
        );
      }
      if (Number(shot.durationSeconds) !== expected.durationSeconds) {
        throw new OutputContractError(
          `animationPlan.shotPlan[${index}].durationSeconds 必须是 ${expected.durationSeconds} 秒`
          + `（由 ${expected.sourceSceneId} 的 timeRange ${expected.sceneTimeRange} 确定性派生），`
          + `实际 ${shot.durationSeconds}`
        );
      }
    });
    const targetRuntimeSeconds = Number(foundation.productionStrategy?.targetRuntimeSeconds);
    if (plannedSeconds !== targetRuntimeSeconds) {
      throw new OutputContractError(
        `animationPlan 镜头时长合计 ${plannedSeconds} 秒与 productionStrategy.targetRuntimeSeconds `
        + `${targetRuntimeSeconds} 秒不一致`
      );
    }
  }
  const recommendedDuration = foundation.productionStrategy?.recommendedShotDurationSeconds || {};
  const durationRange = Number.isFinite(Number(recommendedDuration.min)) && Number.isFinite(Number(recommendedDuration.max))
    ? `${recommendedDuration.min}–${recommendedDuration.max} 秒`
    : "建议时长范围";
  return {
    ...foundation,
    sceneReferencePrompts: foundation.sceneReferencePrompts.map((scene) => {
      const { sourceSceneIds: ignoredSourceSceneIds, ...publicScene } = scene;
      return {
        ...publicScene,
        relatedShotIds: relatedByScene.get(String(scene.sceneId || "")) || []
      };
    }),
    shotPlan,
    continuityAndSafetyCheck: {
      ...foundation.continuityAndSafetyCheck,
      firstLastFrameContinuity: directShotMode
        ? `当前直接视频模式不生产首尾帧；已合并 ${shotPlan.length} 个镜头并通过场景引用与连续性字段校验。`
        : `已合并 ${shotPlan.length} 个镜头，每镜均已通过首帧、尾帧、场景引用和连续性字段校验。`,
      shotDurationControlled: directShotMode
        ? `${shotPlan.length} 个镜头的时长均由 Full Story 场次 timeRange 确定性派生，合计 ${plannedSeconds} 秒。`
        : `${shotPlan.length} 个镜头的时长均已通过 ${durationRange} 约束校验。`,
      readyForVideoGeneration: directShotMode
        ? "全部直接视频 shotPlan 已在服务端合并并通过最终契约校验，可进入视频生成。"
        : "全部逐镜 shotPlan 已在服务端合并并通过最终契约校验，可进入图片与视频生成。"
    }
  };
}

function sumShotDurationSeconds(shots) {
  return (Array.isArray(shots) ? shots : []).reduce((total, shot) => {
    const duration = Number(shot?.durationSeconds);
    return Number.isFinite(duration) ? total + duration : total;
  }, 0);
}

function animationContinuityContext(shot) {
  if (!shot) return null;
  if (!hasStructuredAnimationPromptSource(shot)) {
    return {
      shotId: shot.shotId,
      sourceSceneId: shot.sourceSceneId,
      sceneId: shot.sceneId,
      videoPrompt: shot.videoPrompt,
      cameraMotion: shot.cameraMotion,
      characterAction: shot.characterAction,
      dialogueOrSubtitle: shot.dialogueOrSubtitle,
      soundDesign: shot.soundDesign,
      continuityNotes: shot.continuityNotes
    };
  }
  const finalBeat = Array.isArray(shot.motion?.timingBeats) ? shot.motion.timingBeats.at(-1) : null;
  return {
    shotId: shot.shotId,
    sourceSceneId: shot.sourceSceneId,
    sceneId: shot.sceneId,
    endFrame: shot.endFrame,
    motionEndState: shot.motion ? {
      completedAction: shot.motion.primaryAction,
      finalBeat,
      cameraMove: shot.motion.cameraMove,
      emotion: shot.motion.emotionArc?.to,
      stopCondition: shot.motion.stopCondition
    } : null,
    endFramePrompt: shot.endFramePrompt,
    characterAction: shot.characterAction,
    continuityNotes: shot.continuityNotes
  };
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function settledParallelValue(result, companionResult, label, companionLabel) {
  if (result?.status === "fulfilled") return result.value;
  const error = result?.reason instanceof Error
    ? result.reason
    : new Error(`${label} 失败：${String(result?.reason || "未知错误")}`);
  if (companionResult?.status !== "rejected") throw error;
  const companionError = companionResult.reason instanceof Error
    ? companionResult.reason
    : new Error(`${companionLabel} 失败：${String(companionResult.reason || "未知错误")}`);
  const characterFeatureError = [error, companionError].find((failure) => (
    String(failure?.stage || failure?.details?.stage || "")
      .replace(/[\s_-]+/gu, "")
      .toLowerCase() === "characterfeaturecompiler"
  ));
  if (characterFeatureError) throw characterFeatureError;
  throw new AggregateError(
    [error, companionError],
    `${label} 与 ${companionLabel} 并行阶段均失败`
  );
}

function freezeClone(value) {
  return freezeRecursively(structuredClone(value));
}

function disabledCompilerResult(stage) {
  return {
    profile: null,
    metadata: {
      stage,
      disabled: true,
      note: "暂时弃置，后续优化或删除"
    }
  };
}

function disabledDirectShotCompilerMetadata(settings = {}) {
  return {
    characterFeatureCompiler: disabledCompilerResult("Character Feature Compiler").metadata,
    staticFrameCompiler: {
      version: STATIC_FRAME_COMPILER_VERSION,
      provider: settings.provider || "",
      model: settings.model || "",
      runs: [],
      disabled: true,
      note: "暂时弃置，后续优化或删除"
    },
    localPromptCompiler: {
      disabled: true,
      note: "暂时弃置，后续优化或删除"
    }
  };
}

function freezeRecursively(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeRecursively(item);
  return Object.freeze(value);
}

function normalizeBatchSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ANIMATION_BATCH_SCENE_COUNT;
  return Math.min(6, Math.max(1, Math.round(number)));
}

function normalizeClients(clients = null) {
  if (!clients || typeof clients !== "object") return {};
  return Object.fromEntries(
    Object.entries(clients)
      .map(([provider, client]) => [canonicalProvider(provider), client])
      .filter(([provider, client]) => provider && client)
  );
}

function normalizeStageDefaults(stageDefaults = null, fallback = {}) {
  const provider = fallback.provider || "MiMo";
  const defaults = {
    analysis: { provider, model: "", maxCompletionTokens: null },
    reconstruction: { provider, model: "", maxCompletionTokens: null },
    brief: { provider, model: "", maxCompletionTokens: null },
    visualGuardrails: { provider, model: "", maxCompletionTokens: null },
    variants: { provider, model: "", maxCompletionTokens: null },
    fullStory: { provider: fallback.storyProvider || provider, model: fallback.storyModel || "", maxCompletionTokens: fallback.storyMaxCompletionTokens || null },
    animationPlan: { provider: fallback.animationProvider || fallback.storyProvider || provider, model: fallback.animationModel || fallback.storyModel || "", maxCompletionTokens: fallback.animationMaxCompletionTokens || null },
    staticFrameCompiler: {
      provider: fallback.staticFrameCompilerProvider || "",
      model: fallback.staticFrameCompilerModel || "",
      maxCompletionTokens: fallback.staticFrameCompilerMaxCompletionTokens || 4096,
      requestTimeoutMs: fallback.staticFrameCompilerTimeoutMs || 300000
    },
    characterReference: { provider, model: "", maxCompletionTokens: null }
  };
  const merged = { ...defaults, ...(stageDefaults || {}) };
  return Object.fromEntries(Object.entries(merged).map(([stage, value]) => [stage, normalizeStageSetting(value, defaults[stage] || defaults.analysis)]));
}

function normalizeStageSetting(value = {}, fallback = {}) {
  return {
    provider: canonicalProvider(value.provider || fallback.provider),
    model: String(value.model || fallback.model || "").trim(),
    maxCompletionTokens: finiteNumber(value.maxCompletionTokens, fallback.maxCompletionTokens),
    requestTimeoutMs: finiteNumber(value.requestTimeoutMs, fallback.requestTimeoutMs)
  };
}

function stageOverride(input = {}, stage) {
  const overrides = input.modelOverrides || input.modelSelection || {};
  const value = overrides[stage] || {};
  return value && typeof value === "object" ? value : {};
}

function requiresMediaModel(stage) {
  return ["analysis", "reconstruction", "visualGuardrails", "characterReference"].includes(stage);
}

function isKnownQwenTextOnlyModel(model = "") {
  return /^qwen(?:\d+(?:\.\d+)?)?-max(?:-|$)/iu.test(String(model).trim());
}

function canonicalProvider(provider = "") {
  const value = String(provider || "").trim();
  if (!value) return "";
  if (/qwen|千问|通义/iu.test(value)) return "Qwen";
  if (/mimo|小米/iu.test(value)) return "MiMo";
  if (/deepseek|深度求索/iu.test(value)) return "DeepSeek";
  return value;
}

function firstClientProvider(clients = {}) {
  return Object.entries(clients).find(([, client]) => Boolean(client))?.[0] || "MiMo";
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.round(number);
  return fallback ?? null;
}

function evidenceSourcesForMediaMode(mode) {
  if (mode === "video") return ["video"];
  if (mode === "frames") return ["frame"];
  return null;
}

function stageLabel(stage) {
  return ({
    analysis: "参考片分析",
    reconstruction: "原片脚本还原",
    brief: "创意简报",
    visualGuardrails: "角色与表达边界",
    variants: "主题变体",
    fullStory: "完整剧情",
    animationPlan: "动画镜头生产包",
    staticFrameCompiler: "Static Frame Compiler",
    characterReference: "人物参考修正"
  })[stage] || stage;
}

function assertStaticFrameCompilerSettings(settings = {}) {
  if (!settings.provider) {
    throw new InputError("Static Frame Compiler 未配置 provider；请设置 STATIC_FRAME_COMPILER_PROVIDER");
  }
  if (!["Qwen", "MiMo", "DeepSeek"].includes(settings.provider)) {
    throw new InputError(`Static Frame Compiler provider 无效：${settings.provider}`);
  }
  if (!settings.model) {
    throw new InputError("Static Frame Compiler 未配置 model；请设置 STATIC_FRAME_COMPILER_MODEL");
  }
  if (!settings.client) {
    throw new InputError(`Static Frame Compiler 选择了 ${settings.provider} ${settings.model}，但该 provider 客户端未配置或不可用`);
  }
}

const ANIMATION_BATCH_ATTEMPT_POLICIES = Object.freeze({
  first: Object.freeze({
    name: "first",
    attempt: 1,
    allowPatch: true,
    allowBatchRetry: true
  }),
  retry: Object.freeze({
    name: "retry",
    attempt: 2,
    allowPatch: false,
    allowBatchRetry: false
  })
});

function assertAnimationBatchAttemptPolicy(policy) {
  const valid = policy === ANIMATION_BATCH_ATTEMPT_POLICIES.first
    || policy === ANIMATION_BATCH_ATTEMPT_POLICIES.retry;
  if (!valid) throw new Error("animationShotBatch attempt policy 无效");
  if (policy.attempt === 1 && (!policy.allowPatch || !policy.allowBatchRetry)) {
    throw new Error("animationShotBatch first-pass policy 配置无效");
  }
  if (policy.attempt === 2 && (policy.allowPatch || policy.allowBatchRetry)) {
    throw new Error("animationShotBatch second-pass policy 配置无效");
  }
}

function animationBatchAttemptSuccess(batch, compilerRuns = []) {
  return {
    status: "success",
    batch,
    compilerRuns
  };
}

function animationBatchAttemptFailure({
  error,
  candidate,
  phase,
  kind = "contract",
  diagnostics = [],
  compilerRuns = [],
  hadParsedCandidate = candidate !== null && candidate !== undefined,
  boundedRepairAttempted = false
}) {
  return {
    status: "recoverable_failure",
    error,
    candidate: cloneAnimationBatchDebugValue(candidate),
    phase,
    kind,
    compilerRuns,
    hadParsedCandidate: Boolean(hadParsedCandidate),
    boundedRepairAttempted: Boolean(boundedRepairAttempted),
    diagnostics: [
      ...diagnostics,
      animationBatchErrorDiagnostic(error, phase, candidate)
    ]
  };
}

function finalizeStaticFrameCompilerRuns(runs = [], finalBatch = null, runAccepted = false) {
  return (Array.isArray(runs) ? runs : []).map((run) => ({
    ...structuredClone(run),
    runAccepted: Boolean(runAccepted),
    modifications: (Array.isArray(run?.modifications) ? run.modifications : []).map((change) => ({
      ...structuredClone(change),
      finalAccepted: Boolean(
        runAccepted
        && change?.applied
        && typeof change?.path === "string"
        && animationBatchValueAtPath(finalBatch, change.path) === change.after
      )
    }))
  }));
}

function staticFrameCompilerRunsFromError(error) {
  if (Array.isArray(error?.staticFrameCompilerRuns)) {
    return error.staticFrameCompilerRuns.map((run) => structuredClone(run));
  }
  if (
    error instanceof StaticFrameCompilerCandidateError
    && error.metadata
    && typeof error.metadata === "object"
    && !Array.isArray(error.metadata)
  ) {
    return [structuredClone(error.metadata)];
  }
  return [];
}

function attachStaticFrameCompilerRuns(error, runs = []) {
  if (!error || typeof error !== "object" || !Array.isArray(runs) || runs.length === 0) {
    return error;
  }
  const clonedRuns = runs.map((run) => structuredClone(run));
  error.staticFrameCompilerRuns = clonedRuns;
  if (error.metadata && typeof error.metadata === "object" && !Array.isArray(error.metadata)) {
    error.metadata.batchCompilerRuns = clonedRuns.map((run) => structuredClone(run));
  }
  return error;
}

function annotateStaticFrameBatchRetry(error, { phase, retryEligible }) {
  if (!(error instanceof StaticFrameCompilerCandidateError)) return;
  const errorCode = String(error.errorCode || error.code || "");
  if (!RECOVERABLE_STATIC_FRAME_CANDIDATE_CODES.has(errorCode)) return;
  const retryWasTriggered = phase === "second-pass" || Boolean(retryEligible);
  const annotation = {
    batchRetryEligible: Boolean(retryEligible),
    batchRetryTriggered: retryWasTriggered,
    batchRetryPass: phase === "second-pass" ? "second-pass" : "first-pass",
    batchRetryBudgetRemaining: retryEligible ? 1 : 0,
    batchRetryPropagationResult: retryEligible
      ? "ANIMATION_BATCH_RETRY"
      : "FINAL_FAILURE_NO_RETRY_BUDGET"
  };
  if (error.metadata && typeof error.metadata === "object" && !Array.isArray(error.metadata)) {
    error.metadata.candidateLevelBatchRetry = annotation;
  }
  if (Array.isArray(error.staticFrameCompilerRuns)) {
    error.staticFrameCompilerRuns = error.staticFrameCompilerRuns.map((run) => ({
      ...structuredClone(run),
      candidateLevelBatchRetry: structuredClone(annotation)
    }));
  }
}

function animationBatchErrorDiagnostic(error, phase, candidate) {
  const details = Array.isArray(error?.details)
    ? error.details.map((detail) => ({
        ...detail,
        actual: detail?.path ? animationBatchValueAtPath(candidate, detail.path) : undefined
      }))
    : [];
  return {
    phase,
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "未知错误"),
    ...(details.length ? { details } : {})
  };
}

function animationBatchValueAtPath(candidate, path) {
  if (!candidate || typeof path !== "string") return undefined;
  const relative = path.replace(/^animationShotBatch\./u, "");
  const segments = [...relative.matchAll(/(?:^|\.)([^.[\]]+)|\[(\d+)\]/gu)]
    .map((match) => match[1] ?? Number(match[2]));
  let current = candidate;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return cloneAnimationBatchDebugValue(current);
}

function cloneAnimationBatchDebugValue(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

const RECOVERABLE_STATIC_FRAME_CANDIDATE_CODES = new Set([
  "NO_STATIC_EVIDENCE_IN_SOURCE",
  "NO_VALID_GROUNDED_COMBINATION",
  "EVIDENCE_RESELECTION_EXHAUSTED"
]);

function isRecoverableAnimationModelOutputError(error) {
  return error instanceof OutputContractError
    || (error instanceof ModelResponseError && Number(error.status) === 0)
    || (
      error instanceof StaticFrameCompilerCandidateError
      && RECOVERABLE_STATIC_FRAME_CANDIDATE_CODES.has(String(error.errorCode || error.code || ""))
    );
}

function finalAnimationBatchAttemptError(error) {
  if (error instanceof OutputContractError) {
    return new OutputContractError(
      `animationShotBatch second-pass 失败：${error.message}`,
      Array.isArray(error.details) ? error.details : []
    );
  }
  if (error instanceof ModelResponseError && Number(error.status) === 0) {
    return new OutputContractError(`animationShotBatch second-pass 失败：${error.message}`);
  }
  return error;
}

function finalDirectAnimationBatchAttemptError(outcome) {
  const error = outcome?.error;
  if (outcome?.boundedRepairAttempted && error instanceof OutputContractError) {
    return new OutputContractError(
      `animationShotBatch 有界局部纠错失败：${error.message}`,
      Array.isArray(error.details) ? error.details : []
    );
  }
  if (outcome?.boundedRepairAttempted && error instanceof ModelResponseError) {
    return new OutputContractError(`animationShotBatch 有界局部纠错失败：${error.message}`);
  }
  return error;
}

function animationShotBatchRetryPrompt(originalPrompt, { failedCandidate, diagnostics } = {}) {
  return `${originalPrompt}

ANIMATION_SHOT_BATCH_RETRY_V1

当前失败 batch：
${JSON.stringify(failedCandidate ?? null)}

错误诊断：
${JSON.stringify(Array.isArray(diagnostics) ? diagnostics : [])}

second-pass retry 约束：
- 这是当前 animationShotBatch 唯一一次完整重试；只返回完整的当前 batch JSON，不得返回 patch。
- 必须修复上述诊断指出的全部问题，并重新输出当前批次的全部 shotPlan。
- 不得修改动画基础对象、已完成的前序 batch、当前 sourceSceneId 集合、批次边界或连续性上下文。
- 不得输出当前 batch 之外的镜头，不得解释，不得输出 Markdown。`;
}

const ACTION_STATE_AUDIT_REASON_CODES = new Set([
  "visible_state",
  "narrative_cognition",
  "psychological_activity",
  "future_intent",
  "goal_stage",
  "ambiguous_nonvisual"
]);
const TRUSTED_ANIMATION_PATCH_CODES = new Set([
  "STATIC_FRAME_REQUIRED",
  "STATIC_FRAME_PROCESS_OR_AUDIO",
  "STATIC_FRAME_INVISIBLE_INTENT",
  "ACTION_STATE_NOT_VISIBLE",
  "CONTINUOUS_CAMERA_ENDPOINT_MISSING"
]);
const ACTION_STATE_AUDIT_REASON_TEXT = Object.freeze({
  narrative_cognition: "该句描述剧情认知，不能由单张静态画面直接确认",
  psychological_activity: "该句描述心理活动或决定，不能由单张静态画面直接确认",
  future_intent: "该句描述未来意图，不能由当前单张静态画面直接确认",
  goal_stage: "该句描述目标或阶段推进，不属于当前静态端点",
  ambiguous_nonvisual: "该句无法明确对应单张静态画面可直接观察的信息"
});

function collectAnimationActionStateAuditEntries(batch = {}) {
  const entries = [];
  const shots = Array.isArray(batch?.shotPlan) ? batch.shotPlan : [];
  shots.forEach((shot, shotIndex) => {
    for (const frameKind of ["startFrame", "endFrame"]) {
      const characters = Array.isArray(shot?.[frameKind]?.characters) ? shot[frameKind].characters : [];
      characters.forEach((character, characterIndex) => {
        const actionState = typeof character?.actionState === "string" ? character.actionState.trim() : "";
        if (!actionState) return;
        entries.push({
          id: `AS-${String(entries.length + 1).padStart(4, "0")}`,
          actionState,
          frameKind,
          path: `animationShotBatch.shotPlan[${shotIndex}].${frameKind}.characters[${characterIndex}].actionState`
        });
      });
    }
  });
  return entries;
}

function validateAnimationActionStateAuditResult(result, entries) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new OutputContractError("actionState 语义审核结果必须是对象");
  }
  const topLevelKeys = Object.keys(result);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "results") {
    throw new OutputContractError("actionState 语义审核结果顶层只能包含 results");
  }
  if (!Array.isArray(result.results)) {
    throw new OutputContractError("actionState 语义审核 results 必须是数组");
  }
  if (result.results.length !== entries.length) {
    throw new OutputContractError(`actionState 语义审核结果数量必须为 ${entries.length}`);
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const resultById = new Map();
  result.results.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new OutputContractError(`actionState 语义审核 results[${index}] 必须是对象`);
    }
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["id", "reasonCode", "verdict"])) {
      throw new OutputContractError(`actionState 语义审核 results[${index}] 只能包含 id、verdict、reasonCode`);
    }
    const id = typeof item.id === "string" ? item.id : "";
    if (!entryById.has(id)) throw new OutputContractError(`actionState 语义审核返回未知 id：${id || "空"}`);
    if (resultById.has(id)) throw new OutputContractError(`actionState 语义审核 id 不能重复：${id}`);
    if (!["pass", "fail"].includes(item.verdict)) {
      throw new OutputContractError(`actionState 语义审核 ${id}.verdict 只允许 pass 或 fail`);
    }
    if (!ACTION_STATE_AUDIT_REASON_CODES.has(item.reasonCode)) {
      throw new OutputContractError(`actionState 语义审核 ${id}.reasonCode 无效`);
    }
    if (item.verdict === "pass" && item.reasonCode !== "visible_state") {
      throw new OutputContractError(`actionState 语义审核 ${id} 通过时 reasonCode 必须为 visible_state`);
    }
    if (item.verdict === "fail" && item.reasonCode === "visible_state") {
      throw new OutputContractError(`actionState 语义审核 ${id} 失败时 reasonCode 不得为 visible_state`);
    }
    resultById.set(id, item);
  });

  return entries.flatMap((entry) => {
    const item = resultById.get(entry.id);
    if (!item) throw new OutputContractError(`actionState 语义审核缺少 id：${entry.id}`);
    if (item.verdict === "pass") return [];
    return [{
      ...entry,
      reasonCode: item.reasonCode
    }];
  });
}

function collectTrustedAnimationActionStateAuditFailures(result, entries) {
  if (!isPlainObject(result) || !Array.isArray(result.results)) return [];
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set();
  const failures = [];
  for (const item of result.results) {
    if (!isPlainObject(item)) continue;
    const entry = entryById.get(item.id);
    if (!entry || seen.has(item.id)) continue;
    if (item.verdict !== "fail") continue;
    if (!ACTION_STATE_AUDIT_REASON_CODES.has(item.reasonCode) || item.reasonCode === "visible_state") continue;
    seen.add(item.id);
    failures.push({
      ...entry,
      reasonCode: item.reasonCode
    });
  }
  return failures;
}

function animationActionStateSemanticFailure(failures) {
  const details = failures.map((failure) => ({
    code: "ACTION_STATE_NOT_VISIBLE",
    path: failure.path,
    reason: actionStateAuditReason(failure.reasonCode)
  }));
  return {
    status: "semantic_failure",
    error: new OutputContractError(
      failures.length === 1
        ? `${failures[0].path} 不属于单张静态画面可直接观察的信息`
        : `animationShotBatch 中有 ${failures.length} 个 actionState 不属于单张静态画面可直接观察的信息`,
      details
    )
  };
}

function actionStateAuditReason(reasonCode) {
  return ACTION_STATE_AUDIT_REASON_TEXT[reasonCode]
    || ACTION_STATE_AUDIT_REASON_TEXT.ambiguous_nonvisual;
}

function actionStateAuditProtocolError(error) {
  return new OutputContractError(`actionState 语义审核协议失败：${String(error?.message || error || "未知错误")}`);
}

function trustedAnimationPatchDetail(error, rawBatch) {
  const details = Array.isArray(error?.details) ? error.details : [];
  if (details.some((detail) => [
    "ANIMATION_PRIMARY_CHARACTER_MATCH_FAILURE",
    "ANIMATION_SHOT_PRIMARY_CHARACTER_MATCH_FAILURE"
  ].includes(detail?.code))) {
    return null;
  }
  if (details.length !== 1) return null;
  return validateTrustedAnimationPatchDetail(details[0], rawBatch);
}

function validateTrustedAnimationPatchDetail(detail, rawBatch) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new OutputContractError("animationShotBatch 校验返回的单字段错误元数据无效");
  }
  const keys = Object.keys(detail).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["code", "path", "reason"])) {
    throw new OutputContractError("animationShotBatch 校验返回的单字段错误元数据只能包含 code、path、reason");
  }
  if (!TRUSTED_ANIMATION_PATCH_CODES.has(detail.code)) {
    throw new OutputContractError(`animationShotBatch 校验错误代码不允许执行单字段 patch：${String(detail.code || "空代码")}`);
  }
  if (typeof detail.path !== "string" || !detail.path) {
    throw new OutputContractError("animationShotBatch 校验返回的单字段错误路径无效");
  }
  if (typeof detail.reason !== "string" || !detail.reason) {
    throw new OutputContractError("animationShotBatch 校验返回的单字段错误原因无效");
  }
  if (detail.code === "ACTION_STATE_NOT_VISIBLE" && !detail.path.endsWith(".actionState")) {
    throw new OutputContractError("ACTION_STATE_NOT_VISIBLE 只能定位 actionState 字段");
  }
  const parsed = parseAnimationShotBatchPatchPath(detail.path);
  if (!parsed) {
    throw new OutputContractError(`animationShotBatch 单字段 patch 路径不允许修改：${detail.path}`);
  }
  if (detail.code === "CONTINUOUS_CAMERA_ENDPOINT_MISSING" && parsed.valueKind !== "camera") {
    throw new OutputContractError("CONTINUOUS_CAMERA_ENDPOINT_MISSING 只能定位完整 endFrame.camera");
  }
  if (parsed.valueKind === "camera" && detail.code !== "CONTINUOUS_CAMERA_ENDPOINT_MISSING") {
    throw new OutputContractError("完整 endFrame.camera 只允许用于修复连续运镜终点");
  }
  resolveAnimationShotBatchPatchTarget(rawBatch, parsed, detail.path);
  return {
    code: detail.code,
    path: detail.path,
    reason: detail.reason
  };
}

function parseAnimationShotBatchPatchPath(path) {
  const cameraMatch = String(path || "").match(
    /^animationShotBatch\.shotPlan\[(\d+)\]\.endFrame\.camera$/u
  );
  if (cameraMatch) {
    return {
      shotIndex: Number(cameraMatch[1]),
      frameKind: "endFrame",
      section: "frame",
      field: "camera",
      valueKind: "camera"
    };
  }

  const characterMatch = String(path || "").match(
    /^animationShotBatch\.shotPlan\[(\d+)\]\.(startFrame|endFrame)\.characters\[(\d+)\]\.(screenPosition|bodyOrientation|pose|actionState|handPropState|gaze|emotionState|expression)$/u
  );
  if (characterMatch) {
    return {
      shotIndex: Number(characterMatch[1]),
      frameKind: characterMatch[2],
      characterIndex: Number(characterMatch[3]),
      section: "characters",
      field: characterMatch[4],
      valueKind: "string"
    };
  }

  const frameMatch = String(path || "").match(
    /^animationShotBatch\.shotPlan\[(\d+)\]\.(startFrame|endFrame)\.(timeAndWeather)$/u
  );
  if (frameMatch) {
    return {
      shotIndex: Number(frameMatch[1]),
      frameKind: frameMatch[2],
      section: "frame",
      field: frameMatch[3],
      valueKind: "string"
    };
  }

  const sectionMatch = String(path || "").match(
    /^animationShotBatch\.shotPlan\[(\d+)\]\.(startFrame|endFrame)\.(environment|lighting)\.(foreground|midground|background|atmosphere|source|direction|colorAndContrast)$/u
  );
  if (!sectionMatch) return null;
  const section = sectionMatch[3];
  const field = sectionMatch[4];
  if (section === "environment" && !["foreground", "midground", "background", "atmosphere"].includes(field)) return null;
  if (section === "lighting" && !["source", "direction", "colorAndContrast"].includes(field)) return null;
  return {
    shotIndex: Number(sectionMatch[1]),
    frameKind: sectionMatch[2],
    section,
    field,
    valueKind: "string"
  };
}

function validateAnimationShotBatchPatchResponse(response, trustedPath) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new OutputContractError("animationShotBatch 单字段 patch 必须是对象");
  }
  const keys = Object.keys(response).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["path", "value"])) {
    throw new OutputContractError("animationShotBatch 单字段 patch 只能包含 path、value");
  }
  if (typeof response.path !== "string" || response.path !== trustedPath) {
    throw new OutputContractError("animationShotBatch 单字段 patch path 与服务端可信路径不一致");
  }
  const parsed = parseAnimationShotBatchPatchPath(trustedPath);
  if (parsed?.valueKind === "camera") {
    if (!response.value || typeof response.value !== "object" || Array.isArray(response.value)) {
      throw new OutputContractError("animationShotBatch camera patch value 必须是 camera 对象");
    }
    const actualKeys = Object.keys(response.value).sort();
    const expectedKeys = [...animationFrameCameraFields].sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new OutputContractError(`animationShotBatch camera patch value 必须且只能包含：${animationFrameCameraFields.join("、")}`);
    }
    for (const field of animationFrameCameraFields) {
      if (typeof response.value[field] !== "string" || !response.value[field].trim()) {
        throw new OutputContractError(`animationShotBatch camera patch value.${field} 必须是非空字符串`);
      }
    }
    return { path: response.path, value: structuredClone(response.value) };
  }
  if (typeof response.value !== "string") {
    throw new OutputContractError("animationShotBatch 单字段 patch value 必须是字符串");
  }
  return { path: response.path, value: response.value };
}

function applyAnimationShotBatchPatch(rawBatch, patch) {
  const parsed = parseAnimationShotBatchPatchPath(patch.path);
  if (!parsed) throw new OutputContractError(`animationShotBatch 单字段 patch 路径不允许修改：${patch.path}`);
  const next = structuredClone(rawBatch);
  const target = resolveAnimationShotBatchPatchTarget(next, parsed, patch.path);
  target[parsed.field] = parsed.valueKind === "camera"
    ? structuredClone(patch.value)
    : patch.value;
  return next;
}

function resolveAnimationShotBatchPatchTarget(batch, parsed, path) {
  const shot = batch?.shotPlan?.[parsed.shotIndex];
  const frame = shot?.[parsed.frameKind];
  let target;
  if (parsed.section === "characters") target = frame?.characters?.[parsed.characterIndex];
  else if (parsed.section === "frame") target = frame;
  else target = frame?.[parsed.section];
  const currentValue = target?.[parsed.field];
  const validTarget = parsed.valueKind === "camera"
    ? currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)
    : typeof currentValue === "string";
  if (!target || typeof target !== "object" || Array.isArray(target)
    || !Object.prototype.hasOwnProperty.call(target, parsed.field)
    || !validTarget) {
    throw new OutputContractError(`animationShotBatch 单字段 patch 无法定位允许的叶子：${path}`);
  }
  return target;
}

function animationAuditTokenLimit() {
  return 2048;
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 12288;
  const grownWithinDefaultCap = Math.min(32768, Math.max(12288, Math.ceil(current * 1.25)));
  return Math.max(current, grownWithinDefaultCap);
}

async function safePartialRepairDebugCall(writer, method, ...args) {
  if (!writer || typeof writer[method] !== "function") return null;
  try {
    return await writer[method](...args);
  } catch (error) {
    const reason = String(error?.message || error || "未知错误")
      .replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=_-]+/gu, "[REDACTED_DATA_URL]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
      .slice(0, 500);
    console.warn(`[partial-repair-debug] ${method} 失败，业务流程继续：${reason}`);
    return null;
  }
}
