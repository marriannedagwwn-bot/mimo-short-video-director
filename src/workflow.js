import { ANALYSIS_SYSTEM_PROMPT, RECONSTRUCTION_SYSTEM_PROMPT, analysisPrompt, briefPrompt, characterReferenceRefinePrompt, fullStoryPromiseCheckRetryPrompt, fullStoryPromiseFindingsPrompt, fullStoryPromiseListPrompt, fullStoryPrompt, reconstructionPrompt, storyCandidateReviewPrompt, storyCandidateReviewRetryPrompt, storyCandidateRevisionPrompt, storyCandidateRevisionRetryPrompt, storyQualityEditorialPrompt, storyQualityPromisePrompt, storyQualityRepairPrompt, storyQualityRepairRetryPrompt, storyQualityReviewRetryPrompt, variantsCount, variantsPrompt, visualGuardrailsPrompt } from "./prompts.js";
import { STORY_CANDIDATES_MODEL_SCHEMA_NAME, STORY_ENTRY_CANDIDATES_MODEL_SCHEMA_NAME, storyCandidatesModelSchema, storyEntryCandidatesModelSchema } from "./contracts/story-candidates-model-schema.js";
import { STORY_ENTRY_SYSTEM_PROMPT, storyEntryCandidatePrompt, storyEntryFullStoryPrompt, storySceneScriptPrompt, storyEntryVisualGuardrailsPrompt } from "./story-entry-prompts.js";
import { STORY_ENTRY_VARIANT_ID, STORY_MODE_FULL_TEXT, normalizeStorySource } from "../public/story-entry.js";
import { STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME, storyCandidateReviewModelSchema } from "./contracts/story-candidate-review-model-schema.js";
import { mockAnalysis, mockBrief, mockFullStoryPromiseCheck, mockNarrativeFullStory, mockReconstruction, mockStoryCandidateReview, mockStoryCandidateRevision, mockStoryEntryCandidates, mockStoryQualityRepair, mockStoryQualityReview, mockVariants, mockVisualGuardrails, mockDirectorAgentTurn, mockOneSentenceEdit } from "./mock.js";
import { fullStoryCharacterFacts, isNarrativeFullStory } from "./full-story-contract.js";
import { FULL_STORY_CAST_SCHEMA_VERSION } from "../public/full-story-format.js";
import { ANIMATION_PLAN_VERSION_UNSUPPORTED, SHOT_VIDEO_PROMPT_VERSION, STORYBOARD_PLAN_VERSION, isStoryboardPlan } from "../public/storyboard-plan.js";
import { createStoryboardPlan, createSingleShotPrompt, shotVideoPromptViolations, singleShotPromptInput } from "./storyboard-workflow.js";
import {
  ONE_SENTENCE_EDIT_INSTRUCTION_MAX_CHARS,
  ONE_SENTENCE_EDIT_SCHEMA_VERSION,
  ONE_SENTENCE_EDIT_STAGE,
  ONE_SENTENCE_EDIT_TARGETS,
  applyOneSentenceEdit,
  ensureOneSentenceEditContract,
  oneSentenceEditMetadata
} from "./one-sentence-edit.js";
import {
  ONE_SENTENCE_EDIT_SYSTEM_PROMPT,
  oneSentenceEditRetryPrompt,
  oneSentenceShotPromptEditPrompt,
  oneSentenceStoryEditPrompt,
  oneSentenceStoryboardEditPrompt
} from "./one-sentence-edit-prompts.js";
import { fullStoryCharacterRegistryInput, mergeFullStoryCharacterRegistry, mockFullStoryCharacterRegistry } from "./full-story-character-registry.js";
import { fullStoryCharacterRegistryPrompt, fullStoryRegisteredVoicesPrompt } from "./full-story-character-registry-prompt.js";
import {
  FULL_STORY_PRECHECK_SCHEMA_VERSION,
  FULL_STORY_PROMISE_CHECK_STAGE,
  assembleFullStoryPromiseCheck,
  deriveFullStoryPrecheckRoute,
  promiseCheckGaps,
  singleCandidateThemeVariants
} from "./full-story-precheck.js";
import {
  STORY_QUALITY_REVIEW_STAGE,
  assembleStoryQualityReview,
  buildStoryQualityCandidateProjection
} from "./story-quality-review.js";
import {
  STORY_QUALITY_REPAIR_SCHEMA_VERSION,
  STORY_QUALITY_REPAIR_STAGE,
  assertOnlyStoryRepairFieldsChanged,
  ensureStoryQualityRepairContract,
  mergeStoryQualityRepairs,
  selectStoryQualityRepairItems,
  storyQualityKeptPromises,
  storyQualityRepairMetadata
} from "./story-quality-repair.js";
import { ReviewContractError } from "./review-contract-error.js";
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
import { randomUUID } from "node:crypto";
import { ModelCallCoordinator, classifyAttemptError } from "./model-call-coordinator.js";
import { ModelPipelineError } from "./model-errors.js";
import { DIRECTOR_AGENT_STAGE, ensureDirectorAgentTurnContract, normalizeDirectorAgentTurnInput } from "./director-agent.js";
import { DIRECTOR_AGENT_SYSTEM_PROMPT, directorAgentRetryPrompt, directorAgentTurnPrompt } from "./director-agent-prompts.js";
import { DIRECTOR_AGENT_TURN_MODEL_SCHEMA_NAME, directorAgentTurnModelSchema } from "./contracts/director-agent-turn-model-schema.js";
import { isZhipuGlm53Model } from "./qwen-client.js";
import {
  assertOnlyCandidateRevisionFieldsChanged,
  candidateBlockerDefect,
  candidateCoherenceBreaks,
  candidateScaffoldCopy,
  candidateUnmigratedMechanisms,
  ensureStoryCandidateRevisionContract,
  findCandidate,
  mergeStoryCandidateRevision
} from "./story-candidate-revision.js";
import { InputError, OutputContractError, characterReferenceBoundaryMismatch, characterReferenceRestorableMissingTraits, CREATIVE_BRIEF_SCHEMA_VERSION, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, ensureVisualGuardrailsMatchesProfile, materializeGlobalCharacterBoundaryViews, normalizeGlobalCharacterBoundaryTerms, requireFrames, requireObject, requireText,
  deriveStoryCandidateProjections,
  ensureAnimationPlanMatchesProfile,
  ensureStoryEntryCandidatesContract,
  deriveFullStoryTargetDuration,
  ensureFullStoryPromiseCheckCoversCandidate,
  ensureFullStoryPromiseFindingsContract,
  ensureFullStoryPromiseListContract,
  ensureStoryCandidateReviewCoversCandidates,
  ensureStoryQualityEditorialContract,
  ensureStoryQualityPromiseContract,
  ensureStoryQualityReviewCoversStory
} from "./validation.js";
import { deriveDirectShotSkeleton } from "./direct-shot-timeline.js";
import { CHARACTER_BOUNDARY_SOURCE_STORY, CharacterBoundaryError, createCharacterBoundaryKey, sealGlobalCharacterBoundary, verifyGlobalCharacterBoundary } from "./character-boundary.js";
import {
  ReconstructionGroundingError,
  createGroundingKey,
  groundingContextDigest,
  sealReconstruction,
  sealReferenceAnalysis,
  verifyReconstructionSeal,
  verifyReferenceAnalysis
} from "./reconstruction-grounding.js";
import {
  createVariantSourceBaseline,
  VARIANT_SOURCE_BASELINE_STAGE,
  VARIANT_SOURCE_BASELINE_SYSTEM_PROMPT
} from "./variant-source-baseline.js";

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
      animationMaxCompletionTokens
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
    // creative_brief/2.0：只校验 storyEngine 与 recastTest 两项、拒绝多余顶层键，通过后由服务端盖版本号。
    // 盖章放在校验之后，模型写了 schemaVersion 会被当成多余键拒绝，而不是被静默覆盖。
    const signBrief = (value) => ({
      schemaVersion: CREATIVE_BRIEF_SCHEMA_VERSION,
      ...ensureOutputContract(value, "creativeBrief")
    });
    if (!this.hasLiveClient) return signBrief(mockBrief(groundedInput));
    const prompt = briefPrompt(groundedInput);
    return this.generateStageJson("brief", groundedInput, {
      prompt,
      retryContext: { stage: "creativeBrief", fixedCharacter: input.creatorProfile?.fixedCharacter || "" },
      validate: signBrief
    });
  }

  /**
   * 剧情体检：对已生成的 Full Story 做独立验收。
   *
   * **只出报告**——不修改剧情、不签发 Artifact、不进 lineage、不 stale 任何东西、
   * 不阻断后续 Animation Plan。与 boundaryWarning 同规格，纯展示。
   *
   * **已知偏差**：默认沿用剧情阶段的 provider，也就是写这份剧情的那个模型——
   * 自己批改自己会偏松（实测同一份剧情，作者模型自评 AI 可执行性 8.0、物理可信度 8.0，
   * 外部模型读同一份给 6.8、6.8）。本来要默认换一家，但 10 份实测下来 MiMo 太松
   * （2/62 处 vs 13/91 处）、DeepSeek 产不出严格 JSON（5/10 失败），都不胜任。
   * 它是纯文本阶段（不在 requiresMediaModel 里），可按阶段 override 换任意一家。
   */
  async createStoryQualityReview(input) {
    requireObject(input, "请求");
    const fullStory = requireObject(input.fullStory, "fullStory");
    // 体检的对象必须先是一份合法剧情，否则报告没有意义。
    ensureOutputContract(fullStory, "fullStory");
    const themeVariants = requireObject(input.themeVariants, "themeVariants");
    const candidateId = requireText(input.candidateId || fullStory.selectedVariantId, "candidateId");
    const candidate = buildStoryQualityCandidateProjection(
      singleCandidateThemeVariants(themeVariants, candidateId).variants[0]
    );
    const fixedCharacter = String(input.creatorProfile?.fixedCharacter || "");

    const assemble = (editorial, promise) => ensureStoryQualityReviewCoversStory(
      ensureOutputContract(
        assembleStoryQualityReview({ fullStory, editorial, promise, candidate }),
        "storyQualityReview"
      ),
      fullStory
    );
    if (!this.hasLiveClient) {
      const mock = mockStoryQualityReview(fullStory, candidate);
      return { review: assemble(mock.editorial, mock.promise), metadata: promiseCheckMetadata({
        provider: "demo", model: "demo", stageKey: STORY_QUALITY_REVIEW_STAGE
      }) };
    }
    const settings = this.resolveStage(STORY_QUALITY_REVIEW_STAGE, input);
    this.assertStageClient(settings, "剧情体检");

    // 实数调用次数，不能从 rejections 反推：传输失败时它是空数组，供应商却确实被调用过。
    let providerCalls = 0;
    const rejections = [];
    // 走 coordinator 拿不到 generateValidatedJson 自带的 recorder，必须自己接，
    // 不接就**静默不写**侧车——两次调用的原文会永久丢失。
    const outputLogWriter = this.stageModelOutputLogWriters?.get(STORY_QUALITY_REVIEW_STAGE) || null;
    const recordAttempt = outputLogWriter?.enabled
      ? (attempt) => outputLogWriter.recordAttempt(attempt)
      : null;
    const runStep = (prompt, validate) => this.modelCallCoordinator.runJson({
      client: settings.client,
      request: {
        prompt,
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        requestTimeoutMs: settings.requestTimeoutMs
      },
      provider: settings.provider || "",
      stage: STORY_QUALITY_REVIEW_STAGE,
      maxProviderCalls: 2,
      attemptObserver: async (attempt) => {
        providerCalls += 1;
        if (!recordAttempt) return;
        try {
          await recordAttempt(attempt);
        } catch {
          // 观测失败不改变结论。
        }
      },
      retryTokenLimit,
      retryPrompt: ({ originalPrompt }) => {
        const last = rejections[rejections.length - 1];
        return last?.details?.length
          ? storyQualityReviewRetryPrompt({ originalPrompt, details: last.details })
          : originalPrompt;
      },
      validate: (result) => {
        try {
          return validate(result);
        } catch (error) {
          if (error instanceof OutputContractError) {
            rejections.push({
              message: error.message,
              details: Array.isArray(error.details) ? error.details : []
            });
          }
          throw error;
        }
      }
    });

    let review;
    try {
      // 顺序不能换，而且第一步**看不到候选**——见 src/story-quality-review.js 顶部的实测依据。
      const editorial = await runStep(
        storyQualityEditorialPrompt({ fullStory, fixedCharacter }),
        (result) => ensureStoryQualityEditorialContract(result, fullStory)
      );
      const promise = await runStep(
        storyQualityPromisePrompt({ candidate, fullStory }),
        (result) => ensureStoryQualityPromiseContract(result)
      );
      review = assemble(editorial, promise);
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }

    return {
      review,
      metadata: promiseCheckMetadata({
        provider: settings.provider || "",
        model: settings.model || "",
        providerCalls,
        rejections,
        stageKey: STORY_QUALITY_REVIEW_STAGE
      })
    };
  }

  /**
   * 导演助手的一轮回复（2026-10-09，设计见 docs/director-agent-chat-2026-10-09.md）。
   * 只出建议：模型从页面送来的动作清单里选一个编号（或 none）再写一句回复，不签发任何东西、
   * 不执行任何东西——执行只在用户点卡片上的「确认执行」之后，由页面调原有按钮的同一段代码。
   *
   * 每次都关闭思考（src/thinking-override.js）：全局开着思考时一条对话要推理很久。
   * 走 coordinator，最多 2 次调用、禁止第三次；第二次仍不对就如实报错。审核拦截不重试。
   */
  async createDirectorAgentTurn(input) {
    const turn = normalizeDirectorAgentTurnInput(input);
    const offeredKeys = turn.progress.actions.map((action) => action.key);
    const validate = (result) => ensureDirectorAgentTurnContract(result, offeredKeys);
    if (!this.hasLiveClient) {
      // 演示模式没有调用模型，调用次数如实写 0。
      return { turn: validate(mockDirectorAgentTurn(turn.progress, turn.message)), metadata: promiseCheckMetadata({
        provider: "demo", model: "demo", providerCalls: 0, stageKey: DIRECTOR_AGENT_STAGE
      }) };
    }
    const settings = this.resolveStage(DIRECTOR_AGENT_STAGE, input);
    this.assertStageClient(settings, "导演助手");
    // GLM-5.3 关不掉思考：在调用之前就说清楚，不让客户端在协调器里报一个看不懂的错。
    if (settings.provider === "Qwen" && isZhipuGlm53Model(settings.model)) {
      throw new InputError(`导演助手每次都要关闭思考，${settings.model} 不能关闭思考；请在模型设置里给「导演助手」换一个模型。`);
    }

    // 实数调用次数，不能从 rejections 反推：传输失败时它是空数组，供应商却确实被调用过。
    let providerCalls = 0;
    const rejections = [];
    // 走 coordinator 拿不到 generateValidatedJson 自带的 recorder，必须自己接，不接就静默不写侧车。
    const outputLogWriter = this.stageModelOutputLogWriters?.get(DIRECTOR_AGENT_STAGE) || null;
    const recordAttempt = outputLogWriter?.enabled ? (attempt) => outputLogWriter.recordAttempt(attempt) : null;
    let result;
    try {
      result = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request: {
          prompt: directorAgentTurnPrompt(turn),
          systemPrompt: DIRECTOR_AGENT_SYSTEM_PROMPT,
          model: settings.model,
          maxCompletionTokens: settings.maxCompletionTokens,
          requestTimeoutMs: settings.requestTimeoutMs,
          thinking: "disabled",
          // 只有 MiMo 用它做约束解码；千问与 DeepSeek 忽略。枚举就是这一轮的动作清单加 none。
          responseSchema: { name: DIRECTOR_AGENT_TURN_MODEL_SCHEMA_NAME, schema: directorAgentTurnModelSchema(offeredKeys) }
        },
        provider: settings.provider || "",
        stage: DIRECTOR_AGENT_STAGE,
        maxProviderCalls: 2,
        attemptObserver: async (attempt) => {
          providerCalls += 1;
          if (!recordAttempt) return;
          try {
            await recordAttempt(attempt);
          } catch {
            // 观测失败不改变结论。
          }
        },
        retryTokenLimit,
        retryPrompt: ({ originalPrompt }) => {
          const last = rejections[rejections.length - 1];
          return last?.details?.length ? directorAgentRetryPrompt({ originalPrompt, details: last.details }) : originalPrompt;
        },
        validate: (candidate) => {
          try {
            return validate(candidate);
          } catch (error) {
            if (error instanceof OutputContractError) {
              rejections.push({ message: error.message, details: Array.isArray(error.details) ? error.details : [] });
            }
            throw error;
          }
        }
      });
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }
    return {
      turn: result,
      metadata: promiseCheckMetadata({
        provider: settings.provider || "",
        model: settings.model || "",
        providerCalls,
        rejections,
        stageKey: DIRECTOR_AGENT_STAGE
      })
    };
  }

  /**
   * 剧情体检之后的「按问题修改」：用户在体检报告里勾选要修的条目，这里另起一次调用
   * 写局部修改，服务端逐字执行、逐条过签发校验链。**只出修订稿，不签发任何东西**——
   * 与命题定向修订同规格，签发只发生在用户点「采纳」的那一刻，由浏览器走既有的
   * fullStory 签发流程（新版本会递归 stale 这个变体的镜头计划与媒体）。
   *
   * 为什么是单独一次调用、而且看得见候选，实测依据见 src/story-quality-repair.js 顶部。
   *
   * 出错分两种，处理不同：
   *   - 模型输出结构不对（条数、引用号、字段类型）——整份都用不上，带诊断重试一次，禁止第三次；
   *   - 某一条执行不了（原文找不到、改完不合法、会删掉出镜角色）——**只拒那一条**、如实写明原因，
   *     其余照常采用。不为单条失败整份重做：重做会让已经写对的那些条也跟着抖。
   */
  async createStoryQualityRepair(input) {
    requireObject(input, "请求");
    // fullStory 与 review 都是**请求输入**，不是本阶段的模型输出。原样上抛 OutputContractError
    // 会变成 502「模型输出未通过校验」，让用户去查供应商——与命题修订那处同规格转成 400。
    const asInputError = (error, label) => {
      if (!(error instanceof OutputContractError)) throw error;
      const inputError = new InputError(`${label}：${error.message}`);
      inputError.details = error.details;
      throw inputError;
    };
    const fullStory = requireObject(input.fullStory, "fullStory");
    try {
      ensureOutputContract(fullStory, "fullStory");
    } catch (error) {
      asInputError(error, "fullStory 不是一份合法剧情");
    }
    // 旧格式剧情还带 beatSheet 这第二份动作稿，只改 sceneScript 会让两份对不上；
    // 那一路另有 Beat–Scene 复核的约束，不在这里顺手处理。
    if (!isNarrativeFullStory(fullStory)) {
      throw new InputError("按问题修改只支持 full_story/1.1 的剧情；旧格式请先重新生成完整剧情");
    }
    const review = requireObject(input.review, "review");
    try {
      ensureStoryQualityReviewCoversStory(ensureOutputContract(review, "storyQualityReview"), fullStory);
    } catch (error) {
      asInputError(error, "review 不是这份剧情的合法体检报告");
    }
    const items = selectStoryQualityRepairItems(review, input.selectedRefs);
    const keptPromises = storyQualityKeptPromises(review);
    const themeVariants = requireObject(input.themeVariants, "themeVariants");
    const variant = singleCandidateThemeVariants(themeVariants, fullStory.selectedVariantId).variants[0];
    const candidate = buildStoryQualityCandidateProjection(variant);

    // 与 createFullStory 同一套验签、同一条校验链：修改后的剧情就是要被签发的那一份。
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    const groundedInput = groundedStageInput(input, this.groundingKey);
    const visualGuardrails = this.assertGlobalCharacterBoundary(groundedInput);
    const validateStory = (story) => validateFullStoryForSigning(story, {
      profile, creativeBrief: input.creativeBrief, variant, visualGuardrails
    });
    // 原稿自己必须先过，否则「改完不合法」无法归因到修改上。
    let baseline;
    try {
      baseline = validateStory(structuredClone(fullStory));
    } catch (error) {
      asInputError(error, "这份剧情本身没有通过签发校验，无法在它上面修改");
    }

    const finalize = (repair) => {
      ensureStoryQualityRepairContract(repair, items);
      const merged = mergeStoryQualityRepairs({ fullStory: baseline, items, repair, validateStory });
      assertOnlyStoryRepairFieldsChanged(baseline, merged.fullStory);
      return merged;
    };
    const respond = (merged, metadata) => ({
      schemaVersion: STORY_QUALITY_REPAIR_SCHEMA_VERSION,
      selectedVariantId: String(fullStory.selectedVariantId || ""),
      changed: merged.results.some((entry) => entry.status === "applied"),
      results: merged.results,
      fullStory: merged.fullStory,
      metadata
    });

    if (!this.hasLiveClient) {
      return respond(
        finalize(mockStoryQualityRepair(baseline, items)),
        storyQualityRepairMetadata({ provider: "demo", model: "demo" })
      );
    }
    const settings = this.resolveStage(STORY_QUALITY_REPAIR_STAGE, input);
    this.assertStageClient(settings, "剧情按问题修改");

    // 实数调用次数，不能从 rejections 反推：传输失败时它是空数组，供应商却确实被调用过。
    let providerCalls = 0;
    const rejections = [];
    // 走 coordinator 拿不到 generateValidatedJson 自带的 recorder，必须自己接，
    // 不接就**静默不写**侧车。
    const outputLogWriter = this.stageModelOutputLogWriters?.get(STORY_QUALITY_REPAIR_STAGE) || null;
    const recordAttempt = outputLogWriter?.enabled
      ? (attempt) => outputLogWriter.recordAttempt(attempt)
      : null;
    let merged;
    try {
      merged = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request: {
          prompt: storyQualityRepairPrompt({ fullStory: baseline, candidate, items, keptPromises }),
          model: settings.model,
          maxCompletionTokens: settings.maxCompletionTokens,
          requestTimeoutMs: settings.requestTimeoutMs
        },
        provider: settings.provider || "",
        stage: STORY_QUALITY_REPAIR_STAGE,
        maxProviderCalls: 2,
        attemptObserver: async (attempt) => {
          providerCalls += 1;
          if (!recordAttempt) return;
          try {
            await recordAttempt(attempt);
          } catch {
            // 观测失败不改变结论。
          }
        },
        retryTokenLimit,
        retryPrompt: ({ originalPrompt }) => {
          const last = rejections[rejections.length - 1];
          return last?.details?.length
            ? storyQualityRepairRetryPrompt({ originalPrompt, details: last.details })
            : originalPrompt;
        },
        validate: (result) => {
          try {
            return finalize(result);
          } catch (error) {
            if (error instanceof OutputContractError) {
              rejections.push({
                message: error.message,
                details: Array.isArray(error.details) ? error.details : []
              });
            }
            throw error;
          }
        }
      });
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }
    return respond(merged, storyQualityRepairMetadata({
      provider: settings.provider || "",
      model: settings.model || "",
      providerCalls,
      rejections
    }));
  }

  /**
   * 一句话修改（2026-10-11）的校验上下文。被改的那一份与它的上游都由服务端从 Run 里读出、
   * 原样交进来；这里重新验签角色边界，并先让当前版本自己过一遍签发校验——
   * 原稿过不了，「改完不合法」就无法归因到修改上，所以在调模型之前就拒绝。
   *
   * 三类修改各自的签发校验与生成时同一套：剧情走 validateFullStoryForSigning，
   * 4.0 分镜走 ensureAnimationPlanMatchesProfile（分镜校验 + 候选一致 + 人物参考的角色边界），
   * 单镜提示词走 shotVideoPromptViolations。
   */
  oneSentenceEditContext(input, { storyEntry = null } = {}) {
    requireObject(input, "请求");
    const target = input.target;
    if (!ONE_SENTENCE_EDIT_TARGETS.includes(target)) {
      throw new InputError(`一句话修改的对象只能是 ${ONE_SENTENCE_EDIT_TARGETS.join("、")}`);
    }
    const asBaselineError = (error, label) => {
      if (!(error instanceof OutputContractError)) throw error;
      const inputError = new InputError(`${label}，一句话修改不能在它上面改：${error.message}`);
      inputError.details = error.details;
      throw inputError;
    };
    if (target === "shotPrompt") {
      const plan = requireObject(input.animationPlan, "animationPlan");
      if (!isStoryboardPlan(plan)) throw new InputError("只有 4.0 自主分镜的单镜提示词能用一句话修改");
      const shotPrompt = requireObject(input.shotPrompt, "shotPrompt");
      const shotId = requireText(input.shotId, "shotId");
      if (shotPrompt.schemaVersion !== SHOT_VIDEO_PROMPT_VERSION || shotPrompt.shotId !== shotId
        || typeof shotPrompt.videoPrompt !== "string") {
        throw new InputError(`${shotId} 的单镜提示词结构无效`);
      }
      let projected;
      try {
        projected = singleShotPromptInput(plan, shotId, shotPrompt.target);
      } catch (error) {
        asBaselineError(error, "当前分镜没有通过校验");
      }
      const [baselineIssue] = shotVideoPromptViolations({ videoPrompt: shotPrompt.videoPrompt }, projected);
      if (baselineIssue) {
        // 2026-10-12 判据多了出镜角色名与素材编号两条，旧规则写的提示词可能过不了；
        // 重新生成这一镜的提示词就是按新规则写，所以把这条路说出来。
        asBaselineError(new OutputContractError(`${baselineIssue.reason}。可以先重新生成这一镜的提示词，再用一句话修改`, [baselineIssue]),
          `${shotId} 现在的提示词本身没有通过校验`);
      }
      return {
        target,
        shotId,
        base: structuredClone(shotPrompt),
        projected,
        characterNames: [...(plan.productionStrategy?.characterNames || [])]
      };
    }

    const entry = storyEntry ? requireStoryEntry(storyEntry) : null;
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    // 与生成同一套验签：剧情 Run 用原文核对角色边界，参考视频 Run 先验脚本还原的签名。
    const groundedInput = entry
      ? { ...input, storySource: entry.storySource }
      : groundedStageInput(input, this.groundingKey);
    const visualGuardrails = this.assertGlobalCharacterBoundary(groundedInput, { storyEntry: entry });
    // 「粘贴完整故事」没有候选：故事位由服务端写定，与 createFullStory 同规格。
    const fromStorySource = entry?.storyMode === STORY_MODE_FULL_TEXT;
    const variant = fromStorySource ? null : requireObject(input.variant, "variant");
    const fullStory = requireObject(input.fullStory, "fullStory");
    if (!isNarrativeFullStory(fullStory)) {
      throw new InputError("一句话修改只支持 full_story/1.1 的剧情；旧格式请先重新生成完整剧情");
    }
    const validateStory = (story) => validateFullStoryForSigning(
      fromStorySource ? { ...story, selectedVariantId: STORY_ENTRY_VARIANT_ID } : story,
      { profile, creativeBrief: input.creativeBrief, variant: variant || undefined, visualGuardrails }
    );
    if (target === "story") {
      let base;
      try {
        base = validateStory(structuredClone(fullStory));
      } catch (error) {
        asBaselineError(error, "当前剧情本身没有通过签发校验");
      }
      return { target, base, validateStory, characterFacts: fullStoryCharacterFacts(visualGuardrails) };
    }
    const plan = requireObject(input.animationPlan, "animationPlan");
    if (!isStoryboardPlan(plan)) throw new InputError("一句话修改只支持 4.0 自主分镜");
    const validatePlan = (value) => ensureAnimationPlanMatchesProfile(
      value, profile, input.creativeBrief, variant, visualGuardrails, { fullStory }
    );
    let base;
    try {
      base = validatePlan(structuredClone(plan));
    } catch (error) {
      asBaselineError(error, "当前分镜本身没有通过签发校验");
    }
    return {
      target,
      base,
      validatePlan,
      validationInput: { fullStory, targetDurationSeconds: fullStory.targetDurationSeconds }
    };
  }

  /**
   * 一句话修改：按用户在导演助手里说的原话，对剧情、4.0 分镜或某一镜的视频提示词写局部修改。
   * **只出修改稿，不签发任何东西**——签发只在用户点「采纳」时由服务端重新应用同一组修改、
   * 核对结果摘要之后进行（server.js 的 /api/production/one-sentence-edit/adopt）。
   *
   * 模型只写「在某个字段里找到唯一一段原文 → 换成什么」，原文由服务端逐字替换；做不到的写 decline。
   * 结构错或执行不了（原文找不到、改完不合法）都带诊断重试一次，禁止第三次；审核拦截不重试。
   * 用户的原话只进这一次的提示词，不进任务记录、产物或日志以外的任何地方。
   */
  async createOneSentenceEdit(input, { storyEntry = null } = {}) {
    requireObject(input, "请求");
    const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
    if (!instruction) throw new InputError("instruction 不能为空：要说清楚想怎么改");
    if (instruction.length > ONE_SENTENCE_EDIT_INSTRUCTION_MAX_CHARS) {
      throw new InputError(`instruction 不能超过 ${ONE_SENTENCE_EDIT_INSTRUCTION_MAX_CHARS} 字`);
    }
    const context = this.oneSentenceEditContext(input, { storyEntry });
    const finalize = (output) => {
      const contract = ensureOneSentenceEditContract(output, context.target);
      if (contract.decision === "decline") {
        return { decision: "decline", patches: [], note: contract.note, changes: [], resultDigest: "" };
      }
      const applied = applyOneSentenceEdit(context, contract.patches);
      return {
        decision: "edit",
        patches: contract.patches,
        note: contract.note,
        changes: applied.changes,
        resultDigest: applied.resultDigest,
        // 提示词不长，整段给用户看；剧情与分镜只列改动，页面上本来就有原文。
        ...(context.target === "shotPrompt" ? { afterText: applied.afterText } : {})
      };
    };
    const respond = (draft, metadata) => ({
      schemaVersion: ONE_SENTENCE_EDIT_SCHEMA_VERSION,
      target: context.target,
      ...(context.shotId ? { shotId: context.shotId } : {}),
      ...draft,
      metadata
    });

    if (!this.hasLiveClient) {
      // 演示模式没有调用模型，调用次数如实写 0。
      return respond(
        finalize(mockOneSentenceEdit({ ...context, instruction })),
        oneSentenceEditMetadata({ provider: "demo", model: "demo", providerCalls: 0 })
      );
    }
    const settings = this.resolveStage(ONE_SENTENCE_EDIT_STAGE, input);
    this.assertStageClient(settings, stageLabel(ONE_SENTENCE_EDIT_STAGE));
    const prompt = context.target === "story"
      ? oneSentenceStoryEditPrompt({ instruction, fullStory: context.base, characterFacts: context.characterFacts })
      : context.target === "storyboard"
        ? oneSentenceStoryboardEditPrompt({ instruction, plan: context.base })
        : oneSentenceShotPromptEditPrompt({
          instruction,
          shotId: context.shotId,
          videoPrompt: context.base.videoPrompt,
          projected: context.projected,
          characterNames: context.characterNames
        });

    // 实数调用次数，不能从 rejections 反推：传输失败时它是空数组，供应商却确实被调用过。
    let providerCalls = 0;
    const rejections = [];
    // 走 coordinator 拿不到 generateValidatedJson 自带的 recorder，必须自己接，不接就静默不写侧车。
    const outputLogWriter = this.stageModelOutputLogWriters?.get(ONE_SENTENCE_EDIT_STAGE) || null;
    const recordAttempt = outputLogWriter?.enabled ? (attempt) => outputLogWriter.recordAttempt(attempt) : null;
    let draft;
    try {
      draft = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request: {
          prompt,
          // 显式换掉客户端默认的「受控改编」系统消息：这里不是改编原片，是按用户的话修稿。
          systemPrompt: ONE_SENTENCE_EDIT_SYSTEM_PROMPT,
          model: settings.model,
          maxCompletionTokens: settings.maxCompletionTokens,
          requestTimeoutMs: settings.requestTimeoutMs
        },
        provider: settings.provider || "",
        stage: ONE_SENTENCE_EDIT_STAGE,
        maxProviderCalls: 2,
        attemptObserver: async (attempt) => {
          providerCalls += 1;
          if (!recordAttempt) return;
          try {
            await recordAttempt(attempt);
          } catch {
            // 观测失败不改变结论。
          }
        },
        retryTokenLimit,
        retryPrompt: ({ originalPrompt }) => {
          const last = rejections[rejections.length - 1];
          return last?.details?.length ? oneSentenceEditRetryPrompt({ originalPrompt, details: last.details }) : originalPrompt;
        },
        validate: (candidate) => {
          try {
            return finalize(candidate);
          } catch (error) {
            if (error instanceof OutputContractError) {
              rejections.push({ message: error.message, details: Array.isArray(error.details) ? error.details : [] });
            }
            throw error;
          }
        }
      });
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }
    return respond(draft, oneSentenceEditMetadata({
      provider: settings.provider || "",
      model: settings.model || "",
      providerCalls,
      rejections
    }));
  }

  /**
   * 采纳一句话修改：不调用模型。拿当前版本把同一组修改重新应用一遍、重新校验，
   * 返回要签发的内容与它的摘要；服务端核对摘要等于修改稿上的那个才签发。
   */
  applyOneSentenceEditPatches(input, { storyEntry = null } = {}) {
    requireObject(input, "请求");
    const context = this.oneSentenceEditContext(input, { storyEntry });
    const contract = ensureOneSentenceEditContract(
      { decision: "edit", patches: input.patches, note: "采纳修改稿" },
      context.target
    );
    const applied = applyOneSentenceEdit(context, contract.patches);
    return { content: applied.content, resultDigest: applied.resultDigest, changes: applied.changes };
  }

  /**
   * 候选对照评审：主题变体生成之后的独立验收，**只出报告**——
   * 不修改候选、不签发 Artifact、不进 lineage、不参与派生、不 stale 任何东西、
   * 不改变候选数量、不阻断后续 Full Story。与剧情体检同规格，纯展示，刷新页面即失。
   *
   * 它要暴露的是一类现有校验器全都查不到的问题：**候选声称保留了原片精华，
   * 而动作链并不支持那个说法。** 所以送审投影里**刻意剥掉**了候选的自我评价字段
   * （novelty / retainedValue / experienceFidelity / transformationProof /
   * originalityRiskCheck），只留动作链——让故事自己证明自己，而不是让解释替它过关。
   * 剥离由 buildStoryCandidateReviewProjection **按允许清单构造**，不是事后过滤。
   *
   * `verdict: "drop"` 只是报告里的一句话：**不删候选、不重新生成、不触发任何 stale**，
   * 淘汰与否由用户看完报告自己决定。分布校验（narrativeMode 混合比例）因此不受影响。
   *
   * **已知偏差**：默认沿用候选阶段的 provider，也就是写这些候选的那个模型，
   * 自己批自己会偏松（§2.13 在剧情体检上实测过同一现象：自评 8.0、外部模型 6.8）。
   * 它是纯文本阶段（不在 requiresMediaModel 里），可按阶段 override 换任意一家。
   */
  async createStoryCandidateReview(input) {
    requireObject(input, "请求");
    const themeVariants = requireObject(input.themeVariants, "themeVariants");
    // 评审对象必须先是一批合法候选，否则报告没有意义。**这个校验本身是对的**，
    // 错的是它抛出的类型：themeVariants 是**请求输入**，不是本阶段的模型输出，而
    // OutputContractError 的语义就是「模型输出不合契约」——原样上抛会变成 HTTP 502
    // 加一句「模型输出未通过校验」，让用户去查模型、查供应商，而实际错在自己传的包。
    //
    // 实测：拿一份 2026-09-06 之前导出的生产包来评审，返回 502
    // 「模型输出未通过校验：…/highValueBeatMapping/0/failureSignal 缺少必要字段」——
    // failureSignal 与 transformationProof 的 {source, replacement} 都是那之后才加的必填字段。
    // 代价是**在那之前导出的候选一律评审不了**，而评审恰恰是只出报告、不进 lineage、
    // 不改任何东西的阶段，它最应该能读历史数据。
    //
    // 转成 InputError 才是如实的归属：错在客户端，400，并带上校验器给出的逐条诊断。
    // 与 createAnimationPlanRevision 的 report 分支同规格（那里的 report 同样是请求输入）。
    // **只改归属与状态码，不放宽校验**：缺新字段的旧候选仍然被拒，只是拒得诚实。
    try {
      ensureOutputContract(themeVariants, "themeVariants");
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      const inputError = new InputError(`themeVariants 不是一批合法候选：${error.message}`);
      inputError.details = error.details;
      throw inputError;
    }
    const sourceScriptReconstruction = requireObject(
      input.sourceScriptReconstruction,
      "sourceScriptReconstruction"
    );
    const candidates = Array.isArray(themeVariants.variants) ? themeVariants.variants : [];
    const validate = (result) => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(result, "storyCandidateReview"),
      candidates
    );
    // metadata 是**外挂的一层**，不混进 review 对象本身。
    // 第一版曾写成 { ...review, metadata }，理由是浏览器几乎不用改——而 storyCandidateReview
    // 的 schema 是 additionalProperties: false，于是这份报告不再满足它自己的契约：
    // 任何把它送回服务端的路径都会被拒，而命题定向修订正是第一条这样的路径
    // （它要拿评审报告当输入）。调用元数据不属于模型输出契约，分开放才是对的。
    if (!this.hasLiveClient) {
      return {
        review: validate(mockStoryCandidateReview(candidates)),
        metadata: candidateReviewMetadata({ provider: "demo", model: "demo" })
      };
    }
    const settings = this.resolveStage("storyCandidateReview", input);
    this.assertStageClient(settings, "候选对照评审");

    // 这一档此前走 generateStageJson → generateValidatedJson：**只发一次、fail closed**。
    // 2026-09-10 的真实回放量出了代价——同一个模型、两份合法候选，一份一次写全
    // recommendedOrder，另一份只写了 1 个 id，被既有闸门判失败，整份两千字报告
    // （机制清单、逐候选核对、因果自洽全在里面）连同 ¥0.27 一起丢弃，而模型自己
    // 不知道漏了什么。animation-plan-review 落地方案早就写过同一句：事前定规矩没用，
    // 事后拿数字打回去重做有用，**修订必须设计成「允许第一次做错」**。
    //
    // 不能给 generateValidatedJson 加重试——它是九个阶段共用的单次调用路径。
    // 所以这一档自己走 coordinator，形状与 createAnimationPlanRevision 逐条对齐。
    let rejections = [];
    // 实数调用次数。不能用 rejections 推断——传输失败时它仍是空数组，
    // 但供应商确实被调用了两次，少报就等于把花掉的钱藏起来。
    let providerCalls = 0;
    // 走 coordinator 就拿不到 generateValidatedJson 那条路自带的 recorder：它挂在
    // client.generateJson 的 onCompletion 上，而 coordinator 走 requestCompletion。
    // 漏接的后果是**静默不写**，两次调用的原文全部丢失，所以按定向修订的既有写法
    // 自己接 attemptObserver。
    const reviewOutputLogWriter = this.stageModelOutputLogWriters?.get("storyCandidateReview") || null;
    const recordReviewAttempt = reviewOutputLogWriter?.enabled
      ? (attempt) => reviewOutputLogWriter.recordAttempt(attempt)
      : null;

    const request = {
      // 三份上游都是**可选**的：缺哪一份就少一节判断依据，不阻断评审。
      // 它们按允许清单投影（buildStoryCandidateReviewUpstream），
      // 且**不改变原片事实基准**——机制清单与骨架对照仍然只认 sourceScriptReconstruction。
      prompt: storyCandidateReviewPrompt(
        candidates,
        sourceScriptReconstruction,
        input.visualGuardrails?.fixedCharacterBoundary || null,
        {
          creatorProfile: input.creatorProfile || null,
          creativeBrief: input.creativeBrief || null,
          referenceAnalysis: input.referenceAnalysis || null
        }
      ),
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      requestTimeoutMs: settings.requestTimeoutMs,
      // 与候选阶段同一个做法：约束解码 Schema 从严格 Schema 派生，提示词文本不变、所有模型共用。
      // 只有 MiMo 客户端会用它发 json_schema，千问与 DeepSeek 按参数名解构、照旧发 json_object。
      // coordinator 重试沿用同一个 request，所以第二次调用同样带着它。
      // 起因是 2026-09-24 展开前体检里 MiMo 开思考两次都在 candidateChecks 数组里写出孤立字符串
      // "holisticPreferenceOrder:["——与候选阶段当天的结构失败同形，重试打回诊断也没用。
      responseSchema: {
        name: STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME,
        schema: storyCandidateReviewModelSchema(candidates.length)
      }
    };

    let review;
    try {
      review = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request,
        provider: settings.provider || "",
        stage: "storyCandidateReview",
        maxProviderCalls: 2,
        // 计数与落盘组合在一起。落盘是 fail-open 的：writer 自己吞写入异常，
        // 这里再兜一层意外抛出，绝不让观测改变本次评审的成败或调用预算。
        attemptObserver: async (attempt) => {
          providerCalls += 1;
          if (!recordReviewAttempt) return;
          try {
            await recordReviewAttempt(attempt);
          } catch {
            // 观测失败不改变结论。
          }
        },
        retryTokenLimit,
        // 传输中断也吃这 2 次预算（实测失败率约三分之一，其中一类是几秒就断、
        // 一个 token 都没烧）。没有诊断可打回时重发原提示词——只说「你错了」
        // 而不说错在哪，第二次只会重复第一次。
        // 截断与「被校验拦下」是两种完全不同的失败，重试话术也必须不同。
        // 报告有 4 个候选 × 11 维，写超导致 finish=length 是本阶段最可能的运行时失败；
        // 而原来的分支只认「有没有校验诊断」，截断时没有诊断 → 原样重发 → 第二次照样写超。
        // coordinator 已经把它归成 MODEL_OUTPUT_TRUNCATED（model-call-coordinator.js:58），
        // 这里只需要认出来并要求压缩；token 上限由 retryTokenLimit 自动抬 1.5 倍，两者叠加。
        retryPrompt: ({ originalPrompt, issue, error }) => {
          const code = String(issue?.code || error?.code || "");
          if (code === "MODEL_OUTPUT_TRUNCATED") {
            return storyCandidateReviewRetryPrompt({ originalPrompt, truncated: true });
          }
          const last = rejections[rejections.length - 1];
          return last?.details?.length
            ? storyCandidateReviewRetryPrompt({ originalPrompt, details: last.details })
            : originalPrompt;
        },
        // **校验逐字不变**：这次改的是「错了之后怎么办」，不是「什么算错」。
        // OutputContractError 本来就被 classifyAttemptError 判为可重试，
        // 且 details 原样进 issue.diagnostics，所以这里不需要任何错误类型转换。
        validate: (candidate) => {
          try {
            return validate(candidate);
          } catch (error) {
            if (error instanceof OutputContractError) {
              rejections.push({
                message: error.message,
                details: Array.isArray(error.details) ? error.details : []
              });
            }
            throw error;
          }
        }
      });
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }

    return {
      review,
      metadata: candidateReviewMetadata({
        provider: settings.provider || "",
        model: settings.model || "",
        providerCalls,
        rejections
      })
    };
  }

  /**
   * 命题定向修订。对照评审只出报告、不改命题，这一档才是唯一会改动命题正文的地方——
   * 但它同样**只出候选，不签发任何东西**：不写回 themeVariants、不进 lineage、不 stale。
   * 签发只发生在用户在浏览器点「采纳」的那一刻。
   *
   * **驱动信号是 `coherenceChecks`，不是 `verdict`。** 依据是 2026-09-10 的实测：同一份命题
   * 三次回放，`verdict` 与 `recommendedOrder` 每次都不同（2 pass/2 revise → 2 revise/2 drop
   * → 2 revise/2 drop），而因果断裂稳定复现、锚到拍号、具体可执行。
   *
   * **一次只修一个命题**：最终只有一个会被展开成 Full Story，一次一个的输出短、失败率低、
   * 对照预览也清楚。越权写入未授权的命题即 `CANDIDATE_REVISION_OUT_OF_SCOPE`。
   */
  async createStoryCandidateRevision(input) {
    requireObject(input, "请求");
    const themeVariants = requireObject(input.themeVariants, "themeVariants");
    const review = requireObject(input.review, "review");
    const candidateId = requireText(input.candidateId, "candidateId");
    // scope: "root" = 由完整剧情的展开前体检触发，只修会被带进完整剧情的根问题。
    // 不传 = 手动修订按钮，行为与提示词逐字不变。其它取值一律拒绝，不猜。
    const scope = input.scope === undefined || input.scope === null || input.scope === ""
      ? ""
      : String(input.scope);
    if (scope && scope !== "root") {
      throw new InputError(`scope 只接受 root（展开前体检），收到的是「${scope}」`);
    }
    const root = scope === "root";
    if (!root && input.promiseCheck !== undefined && input.promiseCheck !== null) {
      throw new InputError("promiseCheck 只用于展开前体检触发的修订，必须同时传 scope: root");
    }

    // themeVariants 与 review 都是**请求输入**，不是本阶段的模型输出。
    // 原样上抛 OutputContractError 会变成 502 加一句「模型输出未通过校验」，
    // 让用户去查模型、查供应商，而实际错在自己传的包——与评审那处同规格转成 400。
    const asInputError = (error, label) => {
      const contractFailure = error instanceof OutputContractError || error instanceof ReviewContractError;
      if (!contractFailure) throw error;
      const inputError = new InputError(`${label}：${error.message}`);
      inputError.details = error.details;
      throw inputError;
    };
    try {
      ensureOutputContract(themeVariants, "themeVariants");
    } catch (error) {
      asInputError(error, "themeVariants 不是一批合法命题");
    }
    // 评审报告必须是**这一批命题**的报告：拿另一批的报告来修订会当场失败，
    // 不会静默按 candidateId 对齐。
    //
    // 唯一的例外来自展开前体检：它的评审只送了这一个候选，报告因此恰好一条。
    // 只在 scope: root、且那一条正是目标命题时，才按这一个候选核对覆盖率；
    // 合并与复验仍然用整批，narrativeMode 配比等整批闸门不受影响。
    const allCandidates = Array.isArray(themeVariants.variants) ? themeVariants.variants : [];
    const reviewChecks = Array.isArray(review.candidateChecks) ? review.candidateChecks : [];
    const singleCandidateReview = root
      && reviewChecks.length === 1
      && String(reviewChecks[0]?.candidateId || "") === String(candidateId);
    const reviewedCandidates = singleCandidateReview
      ? allCandidates.filter((entry) => String(entry?.id || "") === String(candidateId))
      : allCandidates;
    try {
      ensureStoryCandidateReviewCoversCandidates(
        ensureOutputContract(review, "storyCandidateReview"),
        reviewedCandidates
      );
    } catch (error) {
      asInputError(error, "review 不是这一批命题的合法评审报告");
    }

    const candidate = findCandidate(themeVariants, candidateId);
    if (!candidate) throw new InputError(`themeVariants 里没有命题 ${candidateId}`);
    const coherenceBreaks = candidateCoherenceBreaks(review, candidateId);
    // 第二个驱动信号：原片有、这个命题没接住的机制。与因果断裂并列，但修法不同——
    // 接一条机制通常要加动作，而因果断裂明确不许加戏，两者混成一个列表模型就分不清了。
    // 展开前体检不送它：那一类是创作取舍，而且会把故事往原片方向推，与换皮信号打架。
    const unmigratedMechanisms = root ? [] : candidateUnmigratedMechanisms(review, candidateId);

    // 展开前体检的三类根问题。每一类都与体检路由的一条理由一一对应：
    // coherence_break → 因果断裂、promise_unrealized → 没演出来的承诺、
    // scaffold_copy → 换皮环节、blocker_defect → 硬伤。路由说有、修订却收不到信号的
    // 情况因此不会出现（提取器与派生降级理由共用同一个判定条件）。
    let promiseGaps = [];
    if (root) {
      const promiseCheck = requireObject(input.promiseCheck, "promiseCheck");
      try {
        ensureFullStoryPromiseCheckCoversCandidate(
          ensureOutputContract(promiseCheck, "fullStoryPromiseCheck"),
          candidate
        );
      } catch (error) {
        asInputError(error, "promiseCheck 不是这个命题的合法承诺核对");
      }
      promiseGaps = promiseCheckGaps(promiseCheck);
    }
    const scaffoldCopy = root ? candidateScaffoldCopy(review, candidateId) : null;
    const blockerDefect = root ? candidateBlockerDefect(review, candidateId) : null;
    if (root && !coherenceBreaks.length && !promiseGaps.length && !scaffoldCopy && !blockerDefect) {
      throw new InputError("展开前体检没有报出任何根问题，不需要修订；请直接展开完整剧情");
    }

    // 固定角色边界照常验签并参与复验：修订改的是动作链，那正是可能混进禁止特征的地方。
    const visualGuardrails = input.visualGuardrails ? this.assertGlobalCharacterBoundary(input) : null;
    const finalize = (revision) => this.finalizeStoryCandidateRevision({
      revision, themeVariants, candidateId, creatorProfile: input.creatorProfile, visualGuardrails
    });

    if (!this.hasLiveClient) {
      return {
        ...finalize(mockStoryCandidateRevision(candidate, coherenceBreaks, unmigratedMechanisms, {
          promiseGaps, scaffoldCopy, blockerDefect
        })),
        metadata: candidateRevisionMetadata({ provider: "demo", model: "demo" })
      };
    }

    const settings = this.resolveStage("storyCandidateRevision", input);
    this.assertStageClient(settings, "命题定向修订");

    const rejections = [];
    // 实数调用次数。不能从 rejections 反推——传输失败时它仍是空数组，
    // 但供应商确实被调用了两次，少报就等于把花掉的钱藏起来。
    let providerCalls = 0;
    const revisionOutputLogWriter = this.stageModelOutputLogWriters?.get("storyCandidateRevision") || null;
    const recordRevisionAttempt = revisionOutputLogWriter?.enabled
      ? (attempt) => revisionOutputLogWriter.recordAttempt(attempt)
      : null;

    let outcome;
    try {
      outcome = await this.modelCallCoordinator.runJson({
        client: settings.client,
        request: {
          prompt: storyCandidateRevisionPrompt({
            candidate,
            coherenceBreaks,
            unmigratedMechanisms,
            promiseGaps,
            scaffoldCopy,
            blockerDefect,
            scope,
            targetDurationSeconds: input.targetDurationSeconds
          }),
          model: settings.model,
          maxCompletionTokens: settings.maxCompletionTokens,
          requestTimeoutMs: settings.requestTimeoutMs
        },
        provider: settings.provider || "",
        stage: "storyCandidateRevision",
        maxProviderCalls: 2,
        attemptObserver: async (attempt) => {
          providerCalls += 1;
          if (!recordRevisionAttempt) return;
          try {
            await recordRevisionAttempt(attempt);
          } catch {
            // 观测失败不改变结论。
          }
        },
        retryTokenLimit,
        retryPrompt: ({ originalPrompt }) => {
          const last = rejections[rejections.length - 1];
          return last?.details?.length
            ? storyCandidateRevisionRetryPrompt({ originalPrompt, details: last.details })
            : originalPrompt;
        },
        validate: (result) => {
          try {
            return finalize(result);
          } catch (error) {
            const contractFailure = error instanceof ReviewContractError || error instanceof OutputContractError;
            if (contractFailure) {
              rejections.push({
                message: error.message,
                details: Array.isArray(error.details) ? error.details : []
              });
            }
            // ReviewContractError 不在 classifyAttemptError 的分支里，会落到
            // 「internal / retryable: false」的兜底，让本该重试的内容错误无法重试。
            if (error instanceof ReviewContractError) throw reviewContractAsOutputContract(error);
            throw error;
          }
        }
      });
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }

    return {
      ...outcome,
      metadata: candidateRevisionMetadata({
        provider: settings.provider || "",
        model: settings.model || "",
        providerCalls,
        rejections
      })
    };
  }

  /**
   * 合并并从头复验。**采纳时签发的就是这份合并结果**，所以它必须在这里就通过整条生成侧
   * 校验链，而不是等用户点了采纳、下游媒体已经作废之后才失败。
   *
   * 顺序不能换：`assertOnlyCandidateRevisionFieldsChanged` 必须跑在重新派生**之前**——
   * 那一刻三个投影字段还是原值，正好可以证明模型没有绕过「派生字段不可写」。
   * 之后 `deriveStoryCandidateProjections` 才按新的 action 重新派生它们。
   */
  finalizeStoryCandidateRevision({ revision, themeVariants, candidateId, creatorProfile, visualGuardrails }) {
    ensureStoryCandidateRevisionContract(revision, themeVariants, candidateId);
    const merged = mergeStoryCandidateRevision(themeVariants, revision);
    assertOnlyCandidateRevisionFieldsChanged(themeVariants, merged, candidateId);
    // 与 createVariants 的 finalize 同一条链，**只少一个 sourceBaseline.apply**：
    // transformationProof 整个冻结、模型碰不到，所以没有 source 需要重新签发。
    // 也不传 upstream——source 逐字未变，重跑一遍溯源核对是浪费，而且给模型看原片
    // 会诱导它顺手重编故事去迁移机制（与「修订只带分镜、不带 fullStory」同源）。
    const validated = ensureThemeVariantsMatchProfile(
      ensureOutputContract(deriveStoryCandidateProjections(merged), "themeVariants"),
      creatorProfile || {},
      null,
      visualGuardrails
    );
    return { candidateId, revision, themeVariants: validated };
  }

  /**
   * 完整剧情的展开前体检（2026-09-16）。点「生成完整剧情」时先跑这一步。
   *
   * 两路并行：**原样**调用现有候选对照评审（只送这一个候选），再加一次承诺核对。
   * 路由由两份结果确定性合成（见 deriveFullStoryPrecheckRoute）：有根问题就先修订候选、
   * 由用户采纳后再展开；没有就直接展开。
   *
   * 只出报告，与评审同规格：不签发 Artifact、不进 lineage、不 stale、不阻断后续。
   * 候选的修改只能由用户采纳后签发新版本，**绝不在已冻结的展开任务里偷换候选**。
   *
   * 任一路失败都整体报错，不拿半份结果路由——只看评审会漏掉「承诺没演出来」，
   * 只看承诺核对会漏掉因果断裂与换皮，两种半截结论都会让人误以为候选没问题。
   */
  async createFullStoryPrecheck(input) {
    requireObject(input, "请求");
    const themeVariants = requireObject(input.themeVariants, "themeVariants");
    const candidateId = requireText(input.candidateId, "candidateId");
    const reviewThemeVariants = singleCandidateThemeVariants(themeVariants, candidateId);
    const candidate = reviewThemeVariants.variants[0];

    // 必须等两路都结束再决定成败：一路先失败就立即上抛，另一路还在后台计费，
    // 它的用量会落到这次请求之外——等于把花掉的钱藏起来。
    const [reviewOutcome, promiseOutcome] = await Promise.allSettled([
      this.createStoryCandidateReview({ ...input, themeVariants: reviewThemeVariants }),
      this.createFullStoryPromiseCheck({ ...input, candidate })
    ]);
    const failures = [
      reviewOutcome.status === "rejected" ? { label: "候选评审", reason: reviewOutcome.reason } : null,
      promiseOutcome.status === "rejected" ? { label: "承诺核对", reason: promiseOutcome.reason } : null
    ].filter(Boolean);
    if (failures.length) {
      const [first, second] = failures;
      // 两路都失败时两个原因都要说出来，只报一个会让人以为修好它就能过。
      if (second && first.reason instanceof Error) {
        try {
          first.reason.message = `${first.reason.message}；另外${second.label}也失败了：${
            second.reason instanceof Error ? second.reason.message : String(second.reason)
          }`;
        } catch {
          // message 不可写时保持原样上抛，不因补充说明失败而改变错误本身。
        }
      }
      throw first.reason;
    }

    const review = reviewOutcome.value.review;
    const promiseCheck = promiseOutcome.value.promiseCheck;
    const reviewCheck = Array.isArray(review?.candidateChecks) ? review.candidateChecks[0] || null : null;
    const { route, reasons } = deriveFullStoryPrecheckRoute({ reviewCheck, promiseCheck });
    return {
      schemaVersion: FULL_STORY_PRECHECK_SCHEMA_VERSION,
      candidateId,
      route,
      reasons,
      review,
      promiseCheck,
      metadata: {
        ...reviewOutcome.value.metadata,
        ...promiseOutcome.value.metadata
      }
    };
  }

  /**
   * 展开前承诺核对：标题和钩子许诺的东西，动作链有没有演出来。
   *
   * **两次顺序调用，第一次看不到动作链。** 这是 2026-09-16 第一版 A/B 实测出来的：
   * 单次调用里动作链一直在上下文中，模型会照着动作链倒推期待，于是无论候选写成什么样
   * 都判「已兑现」（同一个标题在两个候选上写出相反的 mustSee）。所以：
   *   1. 盲写承诺清单：输入只有标题、钩子、叙事模式与主角名。
   *   2. 逐条定位：拿冻结的清单去动作链里找，每一项给出拍号与逐字引用。
   *   3. 判定由服务端从逐条结果派生，模型不写 verdict。
   *
   * 两次调用各自允许「第一次做错」：被确定性闸门拦下时只带诊断重做一次，禁止第三次，
   * 与候选对照评审同规格。原文按本阶段 scope 自己接 attemptObserver 落盘。
   * **沿用候选评审的模型设置**——两者同属「审这个候选」，不另起一个模型选项。
   */
  async createFullStoryPromiseCheck(input) {
    requireObject(input, "请求");
    const candidate = requireObject(input.candidate, "candidate");
    if (!this.hasLiveClient) {
      const mock = mockFullStoryPromiseCheck(candidate);
      return {
        promiseCheck: ensureFullStoryPromiseCheckCoversCandidate(
          ensureOutputContract(mock, "fullStoryPromiseCheck"),
          candidate
        ),
        metadata: promiseCheckMetadata({ provider: "demo", model: "demo" })
      };
    }
    const settings = this.resolveStage("storyCandidateReview", input);
    this.assertStageClient(settings, "展开前承诺核对");

    // 实数调用次数，不能从 rejections 反推：传输失败时它是空数组，供应商却确实被调用过。
    let providerCalls = 0;
    const rejections = [];
    const outputLogWriter = this.stageModelOutputLogWriters?.get(FULL_STORY_PROMISE_CHECK_STAGE) || null;
    const recordAttempt = outputLogWriter?.enabled
      ? (attempt) => outputLogWriter.recordAttempt(attempt)
      : null;
    const runStep = (prompt, validate) => this.modelCallCoordinator.runJson({
      client: settings.client,
      request: {
        prompt,
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        requestTimeoutMs: settings.requestTimeoutMs
      },
      provider: settings.provider || "",
      stage: FULL_STORY_PROMISE_CHECK_STAGE,
      maxProviderCalls: 2,
      attemptObserver: async (attempt) => {
        providerCalls += 1;
        if (!recordAttempt) return;
        try {
          await recordAttempt(attempt);
        } catch {
          // 观测失败不改变结论。
        }
      },
      retryTokenLimit,
      retryPrompt: ({ originalPrompt }) => {
        const last = rejections[rejections.length - 1];
        return last?.details?.length
          ? fullStoryPromiseCheckRetryPrompt({ originalPrompt, details: last.details })
          : originalPrompt;
      },
      validate: (result) => {
        try {
          return validate(result);
        } catch (error) {
          if (error instanceof OutputContractError) {
            rejections.push({
              message: error.message,
              details: Array.isArray(error.details) ? error.details : []
            });
          }
          throw error;
        }
      }
    });

    let promiseCheck;
    try {
      const promiseList = await runStep(
        fullStoryPromiseListPrompt(candidate),
        (result) => ensureFullStoryPromiseListContract(result, candidate)
      );
      const promiseFindings = await runStep(
        fullStoryPromiseFindingsPrompt(candidate, promiseList),
        (result) => ensureFullStoryPromiseFindingsContract(result, promiseList, candidate)
      );
      promiseCheck = ensureFullStoryPromiseCheckCoversCandidate(
        ensureOutputContract(assembleFullStoryPromiseCheck(promiseList, promiseFindings), "fullStoryPromiseCheck"),
        candidate
      );
    } catch (error) {
      throw candidateReviewPipelineFailure(error, rejections);
    }

    return {
      promiseCheck,
      metadata: promiseCheckMetadata({
        provider: settings.provider || "",
        model: settings.model || "",
        providerCalls,
        rejections
      })
    };
  }

  async createVariants(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const visualGuardrails = this.assertGlobalCharacterBoundary(input);
    const validatedInput = structuredClone({ ...input, visualGuardrails });
    // transformationProof.changed*.source 声称的原片事实要回上游核对，因此把这两份
    // 一并交给校验器。**刻意不含 creativeBrief**：2026-09-06 实测正是简报自己先写错
    // （它的 mappingLogic 抄了提示词举例里的「快递员身份」），拿它当核对基准
    // 等于给虚构盖章。上游只有这两份是原片事实的权威来源。
    const variantsUpstream = (input.referenceAnalysis && input.sourceScriptReconstruction)
      ? {
        referenceAnalysis: validatedInput.referenceAnalysis,
        sourceScriptReconstruction: validatedInput.sourceScriptReconstruction
      }
      : null;
    // 原片提问与新角色/新剧情隔离。source 由私有冻结目录里的完整原文签发，
    // 候选模型只写 replacement；仍只返回并提交一份 themeVariants。
    const sourceBaseline = variantsUpstream ? createVariantSourceBaseline(variantsUpstream) : null;
    const finalize = (result) => ensureThemeVariantsMatchProfile(
      ensureOutputContract(deriveStoryCandidateProjections(
        sourceBaseline ? sourceBaseline.apply(result) : result
      ), "themeVariants"),
      validatedInput.creatorProfile, validatedInput.creativeBrief, visualGuardrails, variantsUpstream
    );
    if (!this.hasLiveClient) {
      sourceBaseline?.selectDemo();
      return finalize(mockVariants(validatedInput));
    }
    if (!sourceBaseline) {
      // 缺少两份原片上游的旧调用点保持原有单次生成契约。
      return this.generateStageJson("variants", validatedInput, {
        prompt: variantsPrompt(validatedInput), validate: finalize
      });
    }
    // 两次调用共享创建时的 variants provider/model；不新建模型设置、Task 或重试。
    const settings = this.resolveStage("variants", validatedInput);
    this.assertStageClient(settings, stageLabel("variants"));
    const requestSettings = {
      client: settings.client,
      model: settings.model,
      provider: settings.provider || "",
      maxCompletionTokens: settings.maxCompletionTokens,
      requestTimeoutMs: settings.requestTimeoutMs
    };
    await this.generateValidatedJson({
      ...requestSettings,
      stage: VARIANT_SOURCE_BASELINE_STAGE,
      systemPrompt: VARIANT_SOURCE_BASELINE_SYSTEM_PROMPT,
      prompt: sourceBaseline.prompt(),
      modelOutputLogWriter: this.stageModelOutputLogWriters?.get(VARIANT_SOURCE_BASELINE_STAGE) || null,
      validate: (response) => sourceBaseline.acceptSelections(response)
    });
    return this.generateValidatedJson({
      ...requestSettings,
      stage: "variants",
      prompt: variantsPrompt(validatedInput, { deriveSource: true }),
      // 约束解码 Schema 从严格 Schema 派生；提示词文本不变、所有模型共用。只有 MiMo 客户端
      // 会用它发 json_schema：千问（欠费无法验证）与 DeepSeek（官方只支持 json_object）
      // 按参数名解构，会忽略这个参数、照旧发 json_object。解码约束只减少结构类失败，
      // finalize 里的严格 Schema 与全部校验不变，仍是唯一裁决方。
      responseSchema: {
        name: STORY_CANDIDATES_MODEL_SCHEMA_NAME,
        schema: storyCandidatesModelSchema(variantsCount(validatedInput))
      },
      modelOutputLogWriter: this.stageModelOutputLogWriters?.get("variants") || null,
      validate: finalize
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
    const finalize = (result) => finalizeVisualGuardrails(result, {
      profile,
      sealInput: groundedInput,
      key: this.characterBoundaryKey
    });
    if (!this.hasLiveClient) return finalize(mockVisualGuardrails(groundedInput));
    const prompt = visualGuardrailsPrompt(groundedInput);
    return this.generateStageJson("visualGuardrails", groundedInput, {
      prompt,
      frames: input.frames || [],
      video: input.video || null,
      validate: finalize
    });
  }

  // 「从剧情开始」的角色边界：没有参考视频，只看固定角色设定。与视频入口共用同一个阶段
  // 设置（visualGuardrails，仍禁 DeepSeek）、同一套落定校验；只多一条 sourceSimilarityRules
  // 必须为空，签发时用剧情入口的 v2 摘要。只在服务端内部调用，不注册 HTTP 路由。
  async createStoryEntryVisualGuardrails(input, { storyEntry } = {}) {
    requireObject(input, "请求");
    const entry = requireStoryEntry(storyEntry);
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const finalize = (result) => finalizeVisualGuardrails(result, {
      profile,
      sealInput: { creatorProfile: profile, storySource: entry.storySource },
      key: this.characterBoundaryKey,
      sealOptions: { source: CHARACTER_BOUNDARY_SOURCE_STORY },
      rejectSourceSimilarityRules: true
    });
    if (!this.hasLiveClient) return finalize(mockVisualGuardrails({ creatorProfile: profile }));
    return this.generateStageJson("visualGuardrails", { ...input, creatorProfile: profile }, {
      prompt: storyEntryVisualGuardrailsPrompt({ creatorProfile: profile }),
      systemPrompt: STORY_ENTRY_SYSTEM_PROMPT,
      validate: finalize
    });
  }

  // 「只给角色设定」的单个故事候选：系统原创一个，先给用户看。「粘贴完整故事」没有候选，
  // 原文直接拆成可翻拍镜头（createFullStory 的按原文拆场分支）。
  // id 由服务端签发 V1，三个投影由拍号派生，严格 Schema 换成没有对照原片字段的那份；
  // 只有一个候选，所以视频入口的叙事路径配比与结构分化检查本来就不会触发。
  async createStoryEntryCandidate(input, { storyEntry } = {}) {
    requireObject(input, "请求");
    const entry = requireStoryEntry(storyEntry);
    if (entry.storyMode === STORY_MODE_FULL_TEXT) {
      throw new InputError("「粘贴完整故事」的 Run 不生成故事候选，原文直接拆成可翻拍镜头");
    }
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const visualGuardrails = this.assertGlobalCharacterBoundary(input, { storyEntry: entry });
    const validatedInput = structuredClone({ ...input, visualGuardrails, storySource: entry.storySource });
    const finalize = (result) => {
      const variants = result && typeof result === "object" && !Array.isArray(result) ? result.variants : null;
      if (!Array.isArray(variants) || variants.length !== 1 || !variants[0] || typeof variants[0] !== "object" || Array.isArray(variants[0])) {
        throw new OutputContractError("剧情入口必须恰好输出一个故事候选对象", [{
          code: "STORY_ENTRY_CANDIDATE_COUNT",
          path: "/variants",
          reason: `需要恰好 1 个候选对象，收到 ${Array.isArray(variants) ? variants.length : "非数组"}`
        }]);
      }
      // 模型写了 id 也一律覆盖：剧情入口只有一个候选，id 是服务端常量。
      const { id: _modelId, ...candidate } = variants[0];
      const signed = deriveStoryCandidateProjections({ ...result, variants: [{ id: STORY_ENTRY_VARIANT_ID, ...candidate }] });
      return ensureThemeVariantsMatchProfile(
        ensureStoryEntryCandidatesContract(signed),
        profile,
        null,
        visualGuardrails
      );
    };
    if (!this.hasLiveClient) return finalize(mockStoryEntryCandidates(validatedInput));
    return this.generateStageJson("variants", validatedInput, {
      prompt: storyEntryCandidatePrompt(validatedInput),
      systemPrompt: STORY_ENTRY_SYSTEM_PROMPT,
      responseSchema: {
        name: STORY_ENTRY_CANDIDATES_MODEL_SCHEMA_NAME,
        schema: storyEntryCandidatesModelSchema()
      },
      validate: finalize
    });
  }

  async createFullStory(input, { traceContext = null, storyEntry = null } = {}) {
    requireObject(input, "请求");
    const completeCast = input.fullStorySchemaVersion === FULL_STORY_CAST_SCHEMA_VERSION;
    if (input.fullStorySchemaVersion !== undefined && !completeCast && input.fullStorySchemaVersion !== "full_story/1.1") throw new InputError("不支持的 Full Story 生成版本");
    // 剧情入口没有原片分析、脚本还原和创意简报，所以不要求简报、不走签名的脚本还原；
    // 是不是剧情入口只看服务端传进来的 storyEntry，不看请求体里少了哪几份上游。
    const entry = storyEntry ? requireStoryEntry(storyEntry) : null;
    if (!entry) requireObject(input.creativeBrief, "creativeBrief");
    // 「粘贴完整故事」没有故事候选：原文直接拆成可翻拍镜头。V1 是故事位，不是候选编号。
    const fromStorySource = entry?.storyMode === STORY_MODE_FULL_TEXT;
    if (fromStorySource) {
      const candidateKeys = ["variant", "themeVariants", "candidateBinding"].filter((key) => input[key] !== undefined);
      if (candidateKeys.length) {
        throw new InputError(`「粘贴完整故事」的 Run 没有故事候选，请求里不能带 ${candidateKeys.join("、")}`);
      }
    } else {
      requireObject(input.variant, "variant");
    }
    const storySlotId = fromStorySource ? STORY_ENTRY_VARIANT_ID : String(input.variant?.id || "");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const groundedInput = entry
      ? { ...input, storySource: entry.storySource }
      : groundedStageInput(input, this.groundingKey);
    const visualGuardrails = this.assertGlobalCharacterBoundary(groundedInput, { storyEntry: entry });
    // 剧情入口的每次调用都显式换掉客户端默认的「受控改编」系统消息。
    const systemPromptOverride = entry ? { systemPrompt: STORY_ENTRY_SYSTEM_PROMPT } : {};
    const validatedInput = { ...groundedInput, visualGuardrails };
    const settings = this.resolveStage("fullStory", validatedInput);
    // 故事位的 selectedVariantId 由服务端写定，与 targetDurationSeconds 由时间轴派生同规格：模型回显不作数。
    const withStorySlot = (result) => (
      fromStorySource && result && typeof result === "object" && !Array.isArray(result)
        ? { ...result, selectedVariantId: STORY_ENTRY_VARIANT_ID }
        : result
    );
    const validateFullStory = (result) => validateFullStoryForSigning(withStorySlot(result), {
      profile, creativeBrief: input.creativeBrief, variant: input.variant, visualGuardrails
    });
    if (!this.hasLiveClient) {
      const story = validateFullStory(mockNarrativeFullStory(validatedInput));
      if (!completeCast) return story;
      const registryInput = fullStoryCharacterRegistryInput(story, profile);
      return validateFullStory(mergeFullStoryCharacterRegistry(story, mockFullStoryCharacterRegistry(registryInput), registryInput));
    }
    this.assertStageClient(settings, "完整剧情");
    const promptFor = fromStorySource ? storySceneScriptPrompt : entry ? storyEntryFullStoryPrompt : fullStoryPrompt;
    const basePrompt = promptFor({ ...validatedInput, targetProvider: settings.provider, targetModel: settings.model });
    const prompt = completeCast ? fullStoryRegisteredVoicesPrompt(basePrompt) : basePrompt;
    const observeFullStoryAttempt = this.fullModelOutputLogWriter?.enabled
      ? (attempt) => this.fullModelOutputLogWriter.recordAttempt({
        ...attempt,
        context: {
          ...(traceContext && typeof traceContext === "object" ? traceContext : {}),
          variantId: storySlotId
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
          maxCompletionTokens: settings.maxCompletionTokens,
          ...systemPromptOverride
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
                variantId: storySlotId || undefined,
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

    // full_story/1.1 has no second model-written beatSheet to reconcile.
    // This is not a semantic review pass. Legacy replies still use the exact
    // existing postpass and are never silently converted into the new shape.
    if (completeCast) {
      if (!isNarrativeFullStory(fullStory)) throw new OutputContractError("完整角色表只能承接本次生成的新版完整剧情，不能自动迁移旧剧情");
      const registryInput = fullStoryCharacterRegistryInput(fullStory, profile);
      return this.modelCallCoordinator.runJson({
        client: settings.client,
        request: { prompt: fullStoryCharacterRegistryPrompt(registryInput), model: settings.model, maxCompletionTokens: settings.maxCompletionTokens, ...systemPromptOverride },
        provider: settings.provider || "", stage: "fullStoryCharacterRegistry",
        attemptObserver: observeFullStoryAttempt,
        maxProviderCalls: 1, shouldRetry: () => false,
        validate: response => validateFullStory(mergeFullStoryCharacterRegistry(fullStory, response, registryInput))
      });
    }
    if (isNarrativeFullStory(fullStory)) return fullStory;
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
      requestTimeoutMs: settings.requestTimeoutMs,
      stage,
      provider: settings.provider || "",
      modelOutputLogWriter: this.stageModelOutputLogWriters?.get(stage) || null
    });
  }

  async generateValidatedJson({ client = this.client, prompt, systemPrompt = null, model = null, maxCompletionTokens = null, requestTimeoutMs = null, frames = [], video = null, validate, retryContext = null, onResolvedMediaMode = null, stage = "", provider = "", modelOutputLogWriter = null, responseSchema = null }) {
    // 纯观测 sidecar：只收集本次的模型原文，不改重试预算、控制流与任何错误语义。
    const recorder = stageModelOutputRecorder(modelOutputLogWriter, { stage, provider, model });
    const request = {
      prompt,
      systemPrompt,
      model,
      maxCompletionTokens,
      // 按阶段放宽的 timeout 必须真的送到 client。三家 client 的 generateJson 都收这个
      // 参数，但在此之前没有任何阶段把 resolveStage 解析出来的值传下来，于是
      // 当时 animationPlanReview（原分镜终审，已删除）配的 1800000 完全没有生效，仍按全局 900000 被掐——
      // 实测该阶段正常出字最长 941 秒，正落在被掐的区间里。
      // 现在服务端给各阶段的默认值都是 null，传 null 与不传逐字等价，行为不变。
      requestTimeoutMs,
      onResolvedMediaMode,
      jsonRetryAttempts: 0,
      strictJson: true,
      ...(responseSchema ? { responseSchema } : {}),
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

  async createAnimationPlan(input) {
    const result = await this.createAnimationPlanWithMetadata(input);
    return result.animationPlan;
  }

  async createShotVideoPrompt(input) {
    return createSingleShotPrompt(this, input);
  }

  async createAnimationPlanWithMetadata(input, { storyEntry = null } = {}) {
    requireObject(input, "请求");
    // 2026-10-11 起只支持 4.0 自主分镜。缺省或其他版本一律明确拒绝，不回退到旧 2.0/3.0 生成。
    if (input.animationPlanVersion !== STORYBOARD_PLAN_VERSION) {
      const received = input.animationPlanVersion === undefined ? "未提供" : JSON.stringify(input.animationPlanVersion);
      const error = new InputError(
        `只支持生成 ${STORYBOARD_PLAN_VERSION} 自主分镜（animationPlanVersion 必须是 "${STORYBOARD_PLAN_VERSION}"，收到：${received}）`,
        [{
          code: ANIMATION_PLAN_VERSION_UNSUPPORTED,
          path: "animationPlanVersion",
          reason: `只支持 ${STORYBOARD_PLAN_VERSION}，收到：${received}`
        }]
      );
      error.code = ANIMATION_PLAN_VERSION_UNSUPPORTED;
      throw error;
    }
    return createStoryboardPlan(this, input, { storyEntry });
  }

  async refineCharacterReference(input, { storyEntry = null } = {}) {
    requireObject(input, "请求");
    const characterReference = requireObject(input.characterReference, "characterReference");
    const visualGuardrails = this.assertGlobalCharacterBoundary(input, { storyEntry });
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

  // storyEntry 只由服务端从 Run 元数据与 storySource Artifact 构造，从不取自请求体。
  // 给了它就按剧情入口的 v2 摘要验（固定角色设定 + storySource），否则走参考视频那一版。
  assertGlobalCharacterBoundary(input = {}, { storyEntry = null } = {}) {
    requireObject(input.visualGuardrails, "visualGuardrails");
    const entry = storyEntry ? requireStoryEntry(storyEntry) : null;
    try {
      const verified = entry
        ? verifyGlobalCharacterBoundary(
          input.visualGuardrails,
          { creatorProfile: input.creatorProfile, storySource: entry.storySource },
          this.characterBoundaryKey,
          { requireSignature: this.characterBoundarySignatureRequired, source: CHARACTER_BOUNDARY_SOURCE_STORY }
        )
        : verifyGlobalCharacterBoundary(
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

/**
 * 完整剧情签发前的校验链。**生成（createFullStory）与按问题修改（createStoryQualityRepair）
 * 共用这一条**——修改后的剧情就是要被签发的那一份，两边各写一遍迟早出现
 * 「生成时会拒、修改后却放行」的漂移。
 *
 * targetDurationSeconds 由服务端从 sceneScript 时间轴派生：先派生再校验，
 * 模型声明的值一律被覆盖（可唯一推导，回显不构成新事实）。
 */
// 剧情入口的上下文只由服务端构造（Run 元数据 + storySource Artifact），workflow 只复核形状。
function requireStoryEntry(storyEntry) {
  if (!storyEntry || typeof storyEntry !== "object" || Array.isArray(storyEntry)) {
    throw new InputError("剧情入口缺少服务端构造的 storyEntry");
  }
  let storySource;
  try {
    storySource = normalizeStorySource(storyEntry.storySource);
  } catch (error) {
    throw new InputError(error.message);
  }
  return { storyMode: storySource.storyMode, storySource };
}

// 角色边界阶段的落定校验。参考视频入口与剧情入口共用这一份：模型不得自己写签发字段、
// 两个派生数组必须为空，签发后再按固定角色设定复核。剧情入口另外要求 sourceSimilarityRules 为空。
function finalizeVisualGuardrails(result, { profile, sealInput, key, sealOptions = undefined, rejectSourceSimilarityRules = false }) {
  const raw = ensureOutputContract(normalizeGlobalCharacterBoundaryTerms(result), "visualGuardrails");
  const modelSealFields = ["sourceDigest", "boundaryDigest", "boundarySignature"]
    .filter((field) => Object.prototype.hasOwnProperty.call(raw.fixedCharacterBoundary || {}, field));
  if (modelSealFields.length) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary 的签发字段只能由服务端生成：${modelSealFields.join("、")}`);
  }
  if (raw.allowedPositiveTraits.length || raw.positivePromptBoundary.length) {
    throw new OutputContractError("visualGuardrails.allowedPositiveTraits 与 positivePromptBoundary 必须由服务端从全局角色边界派生，模型必须返回空数组");
  }
  if (rejectSourceSimilarityRules && raw.sourceSimilarityRules.length) {
    throw new OutputContractError("「从剧情开始」没有参考视频，visualGuardrails.sourceSimilarityRules 必须是空数组", [{
      code: "STORY_ENTRY_SOURCE_SIMILARITY_RULES_FORBIDDEN",
      path: "/sourceSimilarityRules",
      reason: `没有参考视频可对照，收到 ${raw.sourceSimilarityRules.length} 条`
    }]);
  }
  const sealed = sealGlobalCharacterBoundary(
    materializeGlobalCharacterBoundaryViews(raw, profile),
    sealInput,
    key,
    sealOptions
  );
  return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(sealed, "visualGuardrails"), profile);
}

function validateFullStoryForSigning(result, { profile, creativeBrief, variant, visualGuardrails }) {
  const story = ensureFullStoryMatchesProfile(
    ensureOutputContract(deriveFullStoryTargetDuration(result), "fullStory"),
    profile, creativeBrief, variant, visualGuardrails
  );
  // New stories have one action timeline. Confirm that the existing
  // downstream can consume it before committing, without generating shots.
  if (isNarrativeFullStory(story)) deriveDirectShotSkeleton(story);
  return story;
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
            provider: completion.providerName || provider,
            model: completion.model || model || "",
            reason: callIndex === 0 ? "primary" : "client-retry",
            status: final ? status : "superseded",
            category: final && issue ? issue.category : "",
            code: final ? (issue ? issue.code : "MODEL_COMPLETION_ACCEPTED") : "",
            // 校验器的结构化 details 由 classifyAttemptError 原样带出；writer 只留
            // code / jsonPointer / reason 并脱敏。漏传时 metadata 恒为空数组，失败定位只剩错误文案。
            diagnostics: final && issue ? issue.diagnostics : [],
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
  // 不用同义词、不重排、不改写外观，与原 Foundation 局部纠错（已删除）同一条最小补写语义。
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

// ReviewContractError 不在 classifyAttemptError 的分支表里，会落到
// 「internal / retryable: false」的兜底，把本该重试一次的内容错误变成不可重试。
// 转成 OutputContractError 后被判为 output-contract、retryable，details 进 diagnostics。
//
// 命题定向修订在 validate 里合并后复验时用它（走 coordinator，转换同时恢复了重试能力）。
function reviewContractAsOutputContract(error) {
  const wrapped = new OutputContractError(error.message, error.details);
  wrapped.code = error.code;
  return wrapped;
}

/** 命题定向修订的调用元数据。与下面的评审那份同形，只是换一个 scope 键。 */
function candidateRevisionMetadata({
  provider = "",
  model = "",
  providerCalls = 1,
  rejections = []
} = {}) {
  const list = Array.isArray(rejections) ? rejections : [];
  return {
    storyCandidateRevision: {
      provider,
      model,
      providerCalls,
      rejections: list.map((rejection, index) => ({
        attempt: index + 1,
        message: String(rejection?.message || ""),
        details: Array.isArray(rejection?.details) ? rejection.details : []
      }))
    }
  };
}

/**
 * 候选对照评审的调用元数据。与原分镜定向修订的 revisionMetadata（已删除）同规格：
 * **服务端拦过一次就必须说出来**，不能让用户以为模型一次就写对了。
 *
 * 与那边的一处不同：这里记的是 rejections **数组**而不是单个
 * firstAttemptRejection。两次都被内容闸门拦下时两条都要在，否则就重演了
 * 「契约写着把两次诊断如实报出、实现只报第二次」那个已登记的不符。
 */
function candidateReviewMetadata({
  provider = "",
  model = "",
  providerCalls = 1,
  rejections = []
} = {}) {
  const list = Array.isArray(rejections) ? rejections : [];
  return {
    storyCandidateReview: {
      provider,
      model,
      providerCalls,
      rejections: list.map((rejection, index) => ({
        attempt: index + 1,
        message: String(rejection?.message || ""),
        details: Array.isArray(rejection?.details) ? rejection.details : []
      }))
    }
  };
}

/** 承诺核对的调用元数据，与评审同形状：拦过一次就必须说出来。 */
// stageKey 让剧情体检复用同一个工厂——两档都是「两次调用 + 允许第一次做错」，
// 上报的四个字段完全一样，各写一份只会漂。浏览器按 metadata[stageKey] 取。
function promiseCheckMetadata({
  provider = "",
  model = "",
  providerCalls = 1,
  rejections = [],
  stageKey = "fullStoryPromiseCheck"
} = {}) {
  const list = Array.isArray(rejections) ? rejections : [];
  return {
    [stageKey]: {
      provider,
      model,
      providerCalls,
      rejections: list.map((rejection, index) => ({
        attempt: index + 1,
        message: String(rejection?.message || ""),
        details: Array.isArray(rejection?.details) ? rejection.details : []
      }))
    }
  };
}

/**
 * 两次都失败时，把**每一次**的诊断都带进最终错误。
 *
 * coordinator 抛出的 ModelPipelineError 只带最后一次的 issue.diagnostics，
 * attempts[] 虽有两条却不带各自的 diagnostics——用户看到的就只有第二次那几条，
 * 完全不知道第一次错在哪、重试有没有改善。每条诊断加一个 attempt 序号
 * （额外字段会进 ValidationDiagnostic.metadata 并被 toJSON 带出去）。
 *
 * 只在这一条路径上重建错误：其余字段（category / code / origin / httpStatus /
 * retryable / attempts / cause）逐字照抄，不改变归属与状态码。
 *
 * 合并结果一定是 coordinator 那份的超集，所以只要记下过任何内容诊断就用合并版。
 * 一次内容失败 + 一次传输失败也走这条路——否则那一次的内容诊断会被最后那次
 * 没有诊断的传输失败盖掉。完全没有内容诊断（两次都是传输失败）时原样上抛。
 */
function candidateReviewPipelineFailure(error, rejections = []) {
  const list = Array.isArray(rejections) ? rejections : [];
  const diagnostics = list.flatMap((rejection, index) => (
    (Array.isArray(rejection?.details) ? rejection.details : [])
      .map((detail) => ({ ...detail, attempt: index + 1 }))
  ));
  if (!(error instanceof ModelPipelineError) || !diagnostics.length) return error;
  return new ModelPipelineError(error.message, {
    category: error.category,
    code: error.code,
    origin: error.origin,
    httpStatus: error.httpStatus,
    retryable: error.retryable,
    diagnostics,
    attempts: error.attempts,
    cause: error.cause
  });
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
    characterReference: { provider, model: "", maxCompletionTokens: null },
    // 剧情体检此前不在这张表里，于是任何不经服务端的调用都解析出 provider: ""，
    // 在调模型**之前**就 InputError——这正是它长期没被真实调用过的一部分原因。
    // 沿用剧情阶段的设置（写这份剧情的那个模型自己批自己会偏松，见方法头注释）。
    // 只补这一项：storyCandidateReview / storyCandidateRevision 同样缺，但那是独立改动，不顺手做。
    storyQualityReview: {
      provider: fallback.storyProvider || provider,
      model: fallback.storyModel || "",
      maxCompletionTokens: fallback.storyMaxCompletionTokens || null
    },
    // 按问题修改与剧情体检同规格：沿用剧情阶段的设置。新阶段一上线就登记，
    // 不重演体检「漏在表外、调模型之前就 InputError」那一次。
    storyQualityRepair: {
      provider: fallback.storyProvider || provider,
      model: fallback.storyModel || "",
      maxCompletionTokens: fallback.storyMaxCompletionTokens || null
    },
    // 一句话修改（2026-10-11）：沿用默认文本模型，不改思考设置；上限与按问题修改同规格。
    oneSentenceEdit: { provider, model: "", maxCompletionTokens: 32768 },
    // 导演助手（2026-10-09）：沿用默认文本模型。输出只有一个动作编号加一两句话，
    // 调用时一律关闭思考，8192 足够。新阶段一上线就登记，不重演体检「漏在表外」那一次。
    directorAgent: { provider, model: "", maxCompletionTokens: 8192 }
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
    characterReference: "人物参考修正",
    storyCandidateReview: "候选对照评审",
    storyCandidateRevision: "命题定向修订",
    storyQualityReview: "剧情体检",
    storyQualityRepair: "剧情按问题修改",
    oneSentenceEdit: "一句话修改",
    directorAgent: "导演助手"
  })[stage] || stage;
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
