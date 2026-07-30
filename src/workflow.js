import { ANALYSIS_SYSTEM_PROMPT, RECONSTRUCTION_SYSTEM_PROMPT, analysisPrompt, animationActionStateAuditPrompt, animationFoundationPrompt, animationShotBatchPatchPrompt, animationShotBatchPrompt, briefPrompt, characterReferenceRefinePrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "./prompts.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "./mock.js";
import { AnimationPromptCompilerError, COMPILED_ANIMATION_SHOT_ALIAS_FIELDS, compileAnimationShotPrompts, normalizeAnimationShotPrompts, rebuildAnimationShotPrompts } from "./animation-prompt-compiler.js";
import { compileCharacterFeatures } from "./character-feature-compiler.js";
import { AttemptStore } from "./attempt-store.js";
import { ModelCallCoordinator } from "./model-call-coordinator.js";
import { ModelResponseError } from "./mimo-client.js";
import { STATIC_FRAME_COMPILER_VERSION, StaticFrameCompilerCandidateError, compileStaticFrames } from "./static-frame-compiler.js";
import { InputError, OutputContractError, animationFrameCameraFields, ensureAnimationFoundationContract, ensureAnimationPlanMatchesProfile, ensureAnimationPlanV2Contract, ensureAnimationShotBatchContract, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, ensureVisualGuardrailsMatchesProfile, getFixedCharacterIdentityAuthorizations, hasExplicitStandardNameSuffix, pruneAnimationPlanNegativePrompts, requireFrames, requireObject, requireText } from "./validation.js";
import {
  ReconstructionGroundingError,
  createGroundingKey,
  groundingContextDigest,
  sealReconstruction,
  sealReferenceAnalysis,
  verifyReconstructionSeal,
  verifyReferenceAnalysis
} from "./reconstruction-grounding.js";

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
    attemptStore = null,
    modelCallCoordinator = null
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
    this.attemptStore = attemptStore instanceof AttemptStore
      ? attemptStore
      : new AttemptStore();
    this.modelCallCoordinator = modelCallCoordinator instanceof ModelCallCoordinator
      ? modelCallCoordinator
      : new ModelCallCoordinator({ attemptStore: this.attemptStore });
  }

  get mode() {
    return this.hasLiveClient ? "live" : "demo";
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
      videoDurationMs: Math.max(0, Math.round(Number(input.metadata?.duration) * 1000) || 0),
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
        if (error instanceof ReconstructionGroundingError) throw new OutputContractError(error.message);
        throw error;
      }
    };
    if (!this.hasLiveClient) return validate(mockAnalysis(input));
    return this.generateStageJson("analysis", input, {
        prompt: analysisPrompt(input),
        systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        frames: input.frames,
        video: input.video,
        onResolvedMediaMode: (mode) => {
          resolvedMediaMode = mode;
          retryContext.mediaMode = mode;
        },
        retryContext,
        validate
      });
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
    if (!this.hasLiveClient) return ensureCreativeBriefMatchesProfile(ensureOutputContract(mockBrief(groundedInput), "creativeBrief"), input.creatorProfile);
    const prompt = briefPrompt(groundedInput);
    return this.generateStageJson("brief", groundedInput, {
      prompt,
      retryContext: { stage: "creativeBrief", fixedCharacter: input.creatorProfile?.fixedCharacter || "" },
      validate: (result) => ensureCreativeBriefMatchesProfile(ensureOutputContract(result, "creativeBrief"), input.creatorProfile)
    });
  }

  async createVariants(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    if (!this.hasLiveClient) return ensureThemeVariantsMatchProfile(ensureOutputContract(mockVariants(input), "themeVariants"), profile, input.creativeBrief, input.visualGuardrails);
    const prompt = variantsPrompt(input);
    return this.generateStageJson("variants", input, {
      prompt,
      validate: (result) => ensureThemeVariantsMatchProfile(ensureOutputContract(result, "themeVariants"), profile, input.creativeBrief, input.visualGuardrails)
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
    if (!this.hasLiveClient) return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(mockVisualGuardrails(groundedInput), "visualGuardrails"), profile);
    const prompt = visualGuardrailsPrompt(groundedInput);
    return this.generateStageJson("visualGuardrails", groundedInput, {
      prompt,
      frames: input.frames || [],
      video: input.video || null,
      validate: (result) => ensureVisualGuardrailsMatchesProfile(ensureOutputContract(result, "visualGuardrails"), profile)
    });
  }

  async createFullStory(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const groundedInput = groundedStageInput(input, this.groundingKey);
    const settings = this.resolveStage("fullStory", groundedInput);
    if (!this.hasLiveClient) return ensureFullStoryMatchesProfile(ensureOutputContract(mockFullStory(groundedInput), "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails);
    this.assertStageClient(settings, "完整剧情");
    const prompt = fullStoryPrompt({ ...groundedInput, targetProvider: settings.provider, targetModel: settings.model });
    return this.generateValidatedJson({
      client: settings.client,
      prompt,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      validate: (result) => ensureFullStoryMatchesProfile(ensureOutputContract(result, "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails),
      retryContext: { stage: "fullStory", provider: settings.provider }
    });
  }

  async generateStageJson(stage, input, options) {
    const settings = this.resolveStage(stage, input);
    this.assertStageClient(settings, stageLabel(stage));
    return this.generateValidatedJson({
      ...options,
      client: settings.client,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens
    });
  }

  async generateValidatedJson({ client = this.client, prompt, systemPrompt = null, model = null, maxCompletionTokens = null, frames = [], video = null, validate, retryContext = null, onResolvedMediaMode = null }) {
    const request = { prompt, systemPrompt, model, maxCompletionTokens, onResolvedMediaMode };
    if (retryContext?.stage === "fullStory") {
      return this.modelCallCoordinator.runJson({
        client,
        request,
        provider: retryContext.provider || "",
        stage: "fullStory",
        validate,
        retryTokenLimit,
        retryPrompt: ({ error, issue, candidate }) => (
          issue.category === "schema" || issue.category === "output-contract"
            ? validationRetryPrompt(
              prompt,
              error.message,
              retryContext,
              candidate,
              error.details
            )
            : fullStoryCompletionRetryPrompt(prompt, issue)
        )
      });
    }
    const first = frames.length || video
      ? await client.generateJsonWithMedia({ ...request, frames, video })
      : await client.generateJson(request);
    try {
      return validate(first);
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      const retryRequest = {
        prompt: validationRetryPrompt(prompt, error.message, retryContext, first, error.details),
        systemPrompt,
        model,
        maxCompletionTokens: retryTokenLimit(maxCompletionTokens),
        onResolvedMediaMode
      };
      const second = frames.length || video
        ? await client.generateJsonWithMedia({ ...retryRequest, frames, video })
        : await client.generateJson(retryRequest);
      return validate(second);
    }
  }

  async generateAnimationShotBatch({
    client,
    prompt,
    model = null,
    maxCompletionTokens = null,
    compilerSettings,
    characterFeatureProfile,
    batchIndex = 0,
    repairContext,
    validate
  }) {
    const firstPolicy = ANIMATION_BATCH_ATTEMPT_POLICIES.first;
    const retryPolicy = ANIMATION_BATCH_ATTEMPT_POLICIES.retry;
    assertAnimationBatchAttemptPolicy(firstPolicy);
    assertAnimationBatchAttemptPolicy(retryPolicy);

    let firstOutcome;
    try {
      const firstResponse = await client.generateJson({ prompt, model, maxCompletionTokens });
      const rawModelOutput = structuredClone(firstResponse);
      firstOutcome = await this.runAnimationShotBatchAttempt({
        client,
        model,
        maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        batchIndex,
        compilerPhase: "post-generate",
        rawModelOutput,
        repairContext,
        validate,
        policy: firstPolicy
      });
    } catch (error) {
      if (!isRecoverableAnimationModelOutputError(error)) throw error;
      firstOutcome = animationBatchAttemptFailure({
        error,
        candidate: null,
        phase: "generate"
      });
    }

    if (firstOutcome.status === "success") {
      return {
        batch: firstOutcome.batch,
        compilerRuns: finalizeStaticFrameCompilerRuns(firstOutcome.compilerRuns, firstOutcome.batch, true)
      };
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
        maxCompletionTokens: retryTokenLimit(maxCompletionTokens)
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
        model,
        maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        batchIndex,
        compilerPhase: "second-pass",
        rawModelOutput: retryRawModelOutput,
        repairContext,
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
    model,
    maxCompletionTokens,
    compilerSettings,
    characterFeatureProfile,
    batchIndex,
    compilerPhase,
    rawModelOutput,
    repairContext,
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
    if (initialOutcome.status === "success" || !policy.allowPatch) return initialOutcome;
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
    batchIndex,
    phase
  }) {
    const repairedStructure = repairAnimationShotBatchStructure(rawModelOutput, repairContext);
    if (!isPlainObject(repairedStructure) || !Array.isArray(repairedStructure.shotPlan)) {
      throw new OutputContractError("animationShotBatch structural repair 后必须包含 shotPlan 数组");
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
    const fullStory = ensureFullStoryMatchesProfile(
      ensureOutputContract(input.fullStory, "fullStory"),
      profile,
      input.creativeBrief,
      input.variant,
      input.visualGuardrails
    );
    const validatedInput = { ...input, fullStory };
    const settings = this.resolveStage("animationPlan", validatedInput);
    const compilerSettings = this.resolveStage("staticFrameCompiler", validatedInput);
    if (!this.hasLiveClient) {
      return {
        animationPlan: validateAnimationPlanOutput(mockAnimationPlan(validatedInput), validatedInput),
        metadata: {
          staticFrameCompiler: {
            version: STATIC_FRAME_COMPILER_VERSION,
            provider: compilerSettings.provider || "",
            model: compilerSettings.model || "",
            runs: []
          }
        }
      };
    }
    this.assertStageClient(settings, "首尾帧动画生产包");
    assertStaticFrameCompilerSettings(compilerSettings);
    const promptInput = { ...validatedInput, targetProvider: settings.provider, targetModel: settings.model };
    const [foundationResult, characterFeatureResult] = await Promise.allSettled([
      this.generateValidatedJson({
        client: settings.client,
        prompt: animationFoundationPrompt(promptInput),
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        validate: (result) => validateAnimationFoundationOutput(result, validatedInput)
      }),
      compileCharacterFeatures({
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
      })
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
    const characterFeatureProfile = freezeClone(characterFeatureCompilation.profile);

    const sourceScenes = Array.isArray(validatedInput.fullStory.sceneScript) ? validatedInput.fullStory.sceneScript : [];
    const sceneBatches = chunkItems(sourceScenes, this.animationShotBatchSceneCount);
    const shotPlan = [];
    const compilerRuns = [];
    for (let batchIndex = 0; batchIndex < sceneBatches.length; batchIndex += 1) {
      const batchScenes = sceneBatches[batchIndex];
      const shotIdStartIndex = shotPlan.length + 1;
      const prompt = animationShotBatchPrompt({
        ...promptInput,
        animationFoundation: foundation,
        sourceScenes: batchScenes,
        batchIndex,
        shotIdStartIndex,
        previousShotContext: animationContinuityContext(shotPlan.at(-1))
      });
      const batchContext = {
        input: validatedInput,
        foundation,
        sourceScenes: batchScenes,
        batchIndex,
        shotIdStartIndex,
        previousShots: shotPlan
      };
      const batchResult = await this.generateAnimationShotBatch({
        client: settings.client,
        prompt,
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        compilerSettings,
        characterFeatureProfile,
        batchIndex,
        repairContext: createAnimationShotBatchRepairContext(batchContext),
        validate: (result) => validateAnimationShotBatchOutput(result, batchContext)
      });
      shotPlan.push(...batchResult.batch.shotPlan);
      compilerRuns.push(...batchResult.compilerRuns);
    }

    const animationPlan = validateAnimationPlanOutput(
      mergeAnimationPlan(foundation, shotPlan, validatedInput),
      validatedInput
    );
    return {
      animationPlan,
      metadata: {
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

  async refineCharacterReference(input) {
    requireObject(input, "请求");
    const characterReference = requireObject(input.characterReference, "characterReference");
    const imageDataUrl = requireText(input.imageDataUrl, "人物参考图", { max: 16 * 1024 * 1024 });
    if (!imageDataUrl.startsWith("data:image/")) throw new InputError("人物参考图必须是图片 data URL");
    const prompt = characterReferenceRefinePrompt(input);
    if (!this.hasLiveClient) {
      return normalizeCharacterReference({
        ...characterReference,
        appearancePrompt: `${characterReference.appearancePrompt || ""} 参考用户上传的人物图，保持人物外观、服装和色彩一致。`,
        referenceImageNotes: "演示模式：已标记为使用人物参考图。"
      }, characterReference, input);
    }
    return this.generateStageJson("characterReference", input, {
      prompt,
      frames: [{ timestamp: 0, dataUrl: imageDataUrl }],
      validate: (result) => normalizeCharacterReference(result, characterReference, input)
    });
  }

  async run(input) {
    const referenceAnalysis = await this.analyze(input);
    const sourceScriptReconstruction = await this.reconstruct({ ...input, referenceAnalysis });
    const creativeBrief = await this.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
    const visualGuardrails = await this.createVisualGuardrails({ ...input, referenceAnalysis, sourceScriptReconstruction, creativeBrief });
    const themeVariants = await this.createVariants({ ...input, creativeBrief, visualGuardrails });
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

function normalizeCharacterReference(result = {}, fallback = {}, input = {}) {
  const value = result.characterReference || result;
  const characterName = String(value.characterName || fallback.characterName || "").trim();
  const appearancePrompt = String(value.appearancePrompt || fallback.appearancePrompt || "").trim();
  if (!characterName) throw new OutputContractError("characterReference 缺少 characterName");
  if (!appearancePrompt) throw new OutputContractError("characterReference 缺少 appearancePrompt");
  return {
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
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return Array.isArray(source) ? source.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function validateAnimationPlanOutput(result, input = {}) {
  const primaryCharacterName = resolveExplicitAnimationPrimaryCharacterName(input, result);
  ensureOutputContract(
    createAnimationEmotionValidationProjection(result, primaryCharacterName),
    "animationPlan"
  );
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
  const sourceSceneIds = (input.fullStory?.sceneScript || []).map((scene) => scene?.sceneId);
  const foundation = ensureAnimationFoundationContract(result, { sourceSceneIds });
  const checked = ensureAnimationPlanMatchesProfile(
    { ...foundation, shotPlan: [] },
    input.creatorProfile,
    input.creativeBrief,
    input.variant,
    input.visualGuardrails,
    input
  );
  const { shotPlan: ignoredShotPlan, ...validatedFoundation } = checked;
  return validatedFoundation;
}

function validateAnimationShotBatchOutput(result, {
  input,
  foundation,
  sourceScenes,
  batchIndex = null,
  shotIdStartIndex,
  previousShots = []
}) {
  const sourceSceneIds = sourceScenes.map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean);
  const primaryCharacterName = resolveExplicitAnimationPrimaryCharacterName(input, foundation);
  ensureAnimationShotBatchContract(
    createAnimationEmotionValidationProjection(result, primaryCharacterName, {
      path: "animationShotBatch",
      batchIndex,
      sourceSceneIds
    })
  );
  const batch = structuredClone(result);
  if (foundation?.promptSchemaVersion === "2.0") {
    batch.shotPlan.forEach((shot, index) => {
      if (hasStructuredAnimationPromptSource(shot)) return;
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}] 必须输出 v2 结构化字段：startFrame、endFrame、motion`);
    });
  }
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
    ensureShotDurationWithinFoundation(shot, index, foundation);
  });

  const covered = new Set(batch.shotPlan.map((shot) => shot.sourceSceneId));
  const missingScenes = sourceSceneIds.filter((sceneId) => !covered.has(sceneId));
  if (missingScenes.length) {
    throw new OutputContractError(`animationShotBatch 未覆盖当前批次剧情场次：${missingScenes.join("、")}`);
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
  return { shotPlan: checked.shotPlan.slice(previousCount) };
}

function resolveExplicitAnimationPrimaryCharacterName(input = {}, foundation = {}) {
  const primaryCharacterName = String(input?.fullStory?.characterBible?.protagonist?.name || "").trim();
  if (!primaryCharacterName) return "";
  const matchingReferences = (foundation?.characterReferencePrompts || []).filter(
    (reference) => String(reference?.characterName || "").trim() === primaryCharacterName
  );
  return matchingReferences.length === 1 ? primaryCharacterName : "";
}

function createAnimationEmotionValidationProjection(value, primaryCharacterName, {
  compileAliases = false,
  path = "animationPlan",
  batchIndex = null,
  sourceSceneIds = []
} = {}) {
  const projected = structuredClone(value);
  if (!primaryCharacterName || !isPlainObject(projected) || !Array.isArray(projected.shotPlan)) {
    return projected;
  }

  projected.shotPlan.forEach((shot, shotIndex) => {
    if (!isPlainObject(shot?.motion?.emotionArc)) return;
    const startCharacters = Array.isArray(shot?.startFrame?.characters) ? shot.startFrame.characters : null;
    const endCharacters = Array.isArray(shot?.endFrame?.characters) ? shot.endFrame.characters : null;
    if (!startCharacters || !endCharacters) return;
    const startDiagnostic = animationPrimaryCharacterFrameDiagnostic({
      characters: startCharacters,
      frameKind: "startFrame",
      path,
      shotIndex,
      primaryCharacterName
    });
    const endDiagnostic = animationPrimaryCharacterFrameDiagnostic({
      characters: endCharacters,
      frameKind: "endFrame",
      path,
      shotIndex,
      primaryCharacterName
    });
    const startMatches = startDiagnostic.matches;
    const endMatches = endDiagnostic.matches;
    const motionPath = `${path}.shotPlan[${shotIndex}].motion`;
    if (startMatches.length !== 1 || endMatches.length !== 1) {
      const shotId = String(shot?.shotId || "").trim();
      const sourceSceneId = String(shot?.sourceSceneId || "").trim();
      const batchNumber = Number.isInteger(batchIndex) ? batchIndex + 1 : null;
      const normalizedSourceSceneIds = (Array.isArray(sourceSceneIds) ? sourceSceneIds : [])
        .map((sceneId) => String(sceneId || "").trim())
        .filter(Boolean);
      const invalidDiagnostics = [startDiagnostic, endDiagnostic].filter(
        (diagnostic) => diagnostic.exactMatchCount !== 1
      );
      const frameSummary = [startDiagnostic, endDiagnostic].map((diagnostic) => (
        `${diagnostic.path} 实际角色：${JSON.stringify(diagnostic.actualCharacterNames)}，`
        + `精确匹配数量：${diagnostic.exactMatchCount}，原因：${diagnostic.reason}`
      )).join("；");
      throw new OutputContractError(
        `${path}.shotPlan[${shotIndex}] 主角唯一匹配失败；`
        + `批次：${batchNumber || "未提供"}；shotId：${shotId || "未提供"}；`
        + `sourceSceneId：${sourceSceneId || "未提供"}；`
        + `sourceSceneIds：${JSON.stringify(normalizedSourceSceneIds)}；`
        + `预期唯一主角：${primaryCharacterName}；${frameSummary}`,
        invalidDiagnostics.map((diagnostic) => ({
          code: "ANIMATION_PRIMARY_CHARACTER_MATCH_FAILURE",
          path: diagnostic.path,
          reason: diagnostic.reason,
          batch: batchNumber,
          shotIndex,
          shotId,
          sourceSceneId,
          sourceSceneIds: normalizedSourceSceneIds,
          expectedPrimaryCharacterName: primaryCharacterName,
          actualCharacterNames: diagnostic.actualCharacterNames,
          exactMatchCount: diagnostic.exactMatchCount,
          category: diagnostic.category
        }))
      );
    }
    if (shot.motion.emotionArc.from !== startMatches[0].emotionState) {
      throw new OutputContractError(
        `${motionPath}.emotionArc.from 必须等于明确主角「${primaryCharacterName}」的 startFrame emotionState`
      );
    }
    if (shot.motion.emotionArc.to !== endMatches[0].emotionState) {
      throw new OutputContractError(
        `${motionPath}.emotionArc.to 必须等于明确主角「${primaryCharacterName}」的 endFrame emotionState`
      );
    }

    // validation.js still checks characters[0]. This private projection keeps
    // the real candidate/order untouched while adapting only that legacy check.
    const legacyStartCharacter = startCharacters[0];
    let legacyEndCharacter = endCharacters.find(
      (character) => character?.name === legacyStartCharacter?.name
    );
    if (
      shot.motion.mode !== "loop"
      && isPlainObject(legacyStartCharacter)
      && !legacyEndCharacter
    ) {
      legacyEndCharacter = structuredClone(legacyStartCharacter);
      endCharacters.push(legacyEndCharacter);
    }
    if (legacyStartCharacter && legacyEndCharacter) {
      shot.motion.emotionArc.from = legacyStartCharacter.emotionState;
      shot.motion.emotionArc.to = legacyEndCharacter.emotionState;
      if (compileAliases && hasCompilableStructuredAnimationPromptSource(shot)) {
        try {
          Object.assign(shot, compileAnimationShotPrompts(shot));
        } catch (error) {
          if (!(error instanceof AnimationPromptCompilerError)) throw error;
          throw new OutputContractError(error.message);
        }
      }
    }
  });
  return projected;
}

function animationPrimaryCharacterFrameDiagnostic({
  characters,
  frameKind,
  path,
  shotIndex,
  primaryCharacterName
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
    reason = "明确主角重复";
  } else if (matches.length === 0 && inexactNames.length) {
    category = "inexact";
    reason = `主角名称不精确：${JSON.stringify(inexactNames)}`;
  } else if (matches.length === 0) {
    category = "missing";
    reason = "明确主角缺失";
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

function createAnimationShotBatchRepairContext({ input, foundation, shotIdStartIndex }) {
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
    primaryCharacterName: resolveExplicitAnimationPrimaryCharacterName(input, foundation)
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
  const primaryCharacterName = String(immutableContext.primaryCharacterName || "");
  return {
    ...repaired,
    shotPlan: repaired.shotPlan.map((shot, index) => {
      if (!isPlainObject(shot)) return shot;
      const nextShot = structuredClone(shot);
      const shotNumber = (Number.isFinite(shotIdStartIndex) ? shotIdStartIndex : 1) + index;
      const shotId = `A${String(shotNumber).padStart(2, "0")}`;
      nextShot.shotId = shotId;

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
        repairAnimationEmotionArc(nextShot, primaryCharacterName);
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

function repairAnimationEmotionArc(shot, primaryCharacterName) {
  if (!primaryCharacterName || !isPlainObject(shot?.motion?.emotionArc)) return;
  const startCharacters = Array.isArray(shot?.startFrame?.characters) ? shot.startFrame.characters : [];
  const endCharacters = Array.isArray(shot?.endFrame?.characters) ? shot.endFrame.characters : [];
  const matchesPrimary = (character) => (
    isPlainObject(character)
    && String(character.name || "").trim() === primaryCharacterName
  );
  const startMatches = startCharacters.filter(matchesPrimary);
  const endMatches = endCharacters.filter(matchesPrimary);
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

function ensureShotDurationWithinFoundation(shot, index, foundation) {
  const recommendation = foundation.productionStrategy?.recommendedShotDurationSeconds || {};
  const minimum = Number(recommendation.min);
  const maximum = Number(recommendation.max);
  const duration = Number(shot.durationSeconds);
  if (Number.isFinite(minimum) && duration < minimum) {
    throw new OutputContractError(`animationShotBatch.shotPlan[${index}].durationSeconds 不得小于 ${minimum}`);
  }
  if (Number.isFinite(maximum) && duration > maximum) {
    throw new OutputContractError(`animationShotBatch.shotPlan[${index}].durationSeconds 不得大于 ${maximum}`);
  }
}

function mergeAnimationPlan(foundation, shotPlan, input = {}) {
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
      firstLastFrameContinuity: `已合并 ${shotPlan.length} 个镜头，每镜均已通过首帧、尾帧、场景引用和连续性字段校验。`,
      shotDurationControlled: `${shotPlan.length} 个镜头的时长均已通过 ${durationRange} 约束校验。`,
      readyForVideoGeneration: "全部逐镜 shotPlan 已在服务端合并并通过最终契约校验，可进入图片与视频生成。"
    }
  };
}

function animationContinuityContext(shot) {
  if (!shot) return null;
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
    animationPlan: "首尾帧动画生产包",
    staticFrameCompiler: "Static Frame Compiler",
    characterReference: "人物参考修正"
  })[stage] || stage;
}

function assertStaticFrameCompilerSettings(settings = {}) {
  if (!settings.provider) {
    throw new InputError("Static Frame Compiler 未配置 provider；请设置 STATIC_FRAME_COMPILER_PROVIDER");
  }
  if (!["Qwen", "MiMo"].includes(settings.provider)) {
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
  compilerRuns = []
}) {
  return {
    status: "recoverable_failure",
    error,
    candidate: cloneAnimationBatchDebugValue(candidate),
    phase,
    kind,
    compilerRuns,
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
  if (details.some((detail) => detail?.code === "ANIMATION_PRIMARY_CHARACTER_MATCH_FAILURE")) {
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

function validationRetryPrompt(
  originalPrompt,
  validationError,
  retryContext = null,
  failedOutput = null,
  validationDetails = []
) {
  if (retryContext?.stage === "referenceAnalysis") {
    return analysisValidationRetryPrompt(originalPrompt, validationError, failedOutput, retryContext);
  }
  if (retryContext?.stage === "sourceScriptReconstruction") {
    return reconstructionValidationRetryPrompt(originalPrompt, validationError, retryContext, failedOutput);
  }
  if (retryContext?.stage === "fullStory") {
    return fullStoryValidationRetryPrompt(
      originalPrompt,
      validationError,
      validationDetails,
      failedOutput
    );
  }
  const animationCorrection = originalPrompt.includes('"negativePrompts"')
    ? `
- 每个 shot 必须输出 negativePrompts.image 和 negativePrompts.video 数组，数组允许为空。
- 每个保留条目必须有当前镜头的具体 triggerEvidence、受支持的 reasonCode、正确的 appliesTo 和 priority；不要复制通用负面词，不要用“未声明/未提及”作为唯一理由。
- dialogueRules 不进入图片/视频负面提示词；sourceSimilarityRules 只有在当前生成确实传入视觉参考时才可按 reference_leak 使用。`
    : "";
  const creativeBriefCorrection = retryContext?.stage === "creativeBrief"
    ? creativeBriefValidationCorrection(retryContext.fixedCharacter)
    : "";
  const transformationCorrection = retryContext?.stage === "creativeBrief"
    ? "- 返回完整 JSON 对象，但内容上只修正越界字段；其余已经合格的 Creative Brief 字段保持不变。"
    : "- 可以保留送达任务、旅途结构、帮助、天气阻力和仪式化结尾，但必须换成新人物、新任务、新道具、新对白和新画面表达。";
  const failedOutputReference = retryContext?.stage === "creativeBrief" && failedOutput
    ? `\n上一次待修 JSON（只改校验命中的字段，其他字段保持不变）：\n${JSON.stringify(failedOutput)}`
    : "";
  return `${originalPrompt}

上一次输出已经是 JSON，但没有通过系统校验：
${validationError}
${failedOutputReference}

请基于同一个任务重新输出一份完整合法 JSON，并修复上述问题。
关键要求：
- 不要更换用户固定角色，不要改名，不要降级为配角。
- 不要复用有明确证据的原片表面表达。
- 正向提示词只能使用固定角色文本已经明确授权的身份与外观；未授权信息保持不写，且不得把“未声明”转换成渲染负面提示词。
${transformationCorrection}
- 规则必须保持分类：角色正向边界、原片规避、台词规则和逐镜渲染负面提示词不得混写。${animationCorrection}
${creativeBriefCorrection}
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function fullStoryValidationRetryPrompt(
  originalPrompt,
  validationError,
  validationDetails,
  failedOutput
) {
  return `${originalPrompt}

FULL_STORY_SCENE_CONTRACT_RETRY_V1

上一次 fullStory 已经是 JSON，但没有通过系统校验（完整剧情与 Scene Contract）：
${validationError}

结构化错误详情：
${JSON.stringify(Array.isArray(validationDetails) ? validationDetails : [])}

上一次待修完整 JSON：
${JSON.stringify(failedOutput || {})}

请基于同一个主题和角色设定重新输出一份完整 fullStory JSON，并完整修复 sceneScript：
- 返回全部 fullStory 顶层字段和完整 sceneScript，不得只返回 patch、单个场次或解释文字。
- 每场 sceneId、location 和 visibleAction 必须是非空字符串；sceneId 在 sceneScript 中唯一。
- 每场 characters 必须是非空角色名称字符串数组，角色名不能为空或重复。
- 已锁定角色只能使用 characterBible 中的标准名称，不得追加括号、身份、外观说明、空格后缀、别名或昵称；场次型临时配角使用独立明确名称。
- visibleAction 或 shotAndSound 明确写到已锁定标准角色时，该精确名称必须存在于同场 characters。
- dialogue 只使用结构化数组，每条非空 speaker 必须逐字存在于同场 characters；不要根据台词正文猜测在场角色。
- 当前 fullStory schema 没有画外音、旁白或 offscreen speaker 标记，不得要求系统从 dialogue 或 shotAndSound 猜测画外身份。
- dialogue、shotAndSound、shootingNotes、emotionNode 和 dramaticFunction 只能补充场次结构，不能替代 location、characters 或 visibleAction。
- Validation 只会重新校验，不会自动补写、改名、归一化或接受别名。
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function analysisValidationRetryPrompt(originalPrompt, validationError, failedOutput, retryContext = {}) {
  const videoDurationMs = Math.max(0, Math.round(Number(retryContext.videoDurationMs)) || 0);
  const frameCount = Math.max(0, Math.round(Number(retryContext.frameCount)) || 0);
  const evidenceModeCorrection = retryContext.mediaMode === "video"
    ? `- 本次成功媒体请求使用原生视频：所有 observedFacts.evidenceRefs 只能写 {"source":"video","startMs":整数,"endMs":整数}，必须满足 0 <= startMs < endMs${videoDurationMs ? ` <= ${videoDurationMs}` : ""}；endMs 不得超过输入视频时长。不得保留任何 frame 或 frameNumber。`
    : retryContext.mediaMode === "frames"
      ? `- 本次成功媒体请求使用采样画面：所有 observedFacts.evidenceRefs 只能写 {"source":"frame","frameNumber":实际提供的正整数}，frameNumber 必须落在 1${frameCount ? `-${frameCount}` : " 到实际提供帧数"}；不得保留任何 video、startMs 或 endMs。`
      : "- evidenceRefs 必须严格服从上方校验错误指出的本次媒体证据来源。";
  return `${originalPrompt}

上一次 referenceAnalysis 已经是 JSON，但没有通过证据契约校验：
${validationError}

上一次待修 JSON：
${JSON.stringify(failedOutput || {})}

请返回完整 referenceAnalysis JSON，但只修正校验消息指出的 schema 或 evidence 字段：
- observedFacts.observation 只能记录本次画面或原生视频中直接可见的单一事实。
- 不得改名，不得替换人物、地点、道具、动作、对白或结尾，也不得把不确定内容补成事实。
${evidenceModeCorrection}
- 不要为了避开校验而改写素材事实；无法确认的内容移入 uncertainties。
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function reconstructionValidationRetryPrompt(originalPrompt, validationError, retryContext, failedOutput) {
  return `${originalPrompt}

上一次 sourceScriptReconstruction 已经是 JSON，但没有通过完整脚本契约校验：
${validationError}

上一次待修 JSON：
${JSON.stringify(failedOutput || {})}

请返回完整 sourceScriptReconstruction JSON，并只修正校验消息指出的字段：
- scenes 必须是非空数组，每个 scene 保留 sceneId、timeRange、location、characters、visibleActions、dialogueGist、shotDesign、emotionNode、dramaticFunction、turningPoint、keyProps、sourceEvidence 和 confidence。
- coreEventSequence、turningPoints 和 uncertainties 必须是数组；relationshipPattern 必须是字符串；endingAction 必须包含 action、emotionalMeaning 和 evidence。
- 只能依据原视频、采样画面、referenceAnalysis 和用户补充还原原片；不得改编人物、道具、对白、动作或结尾。
- 无法确认的对白和采样间隙进入 uncertainties，不要为了字段完整而虚构事实。
- 不要输出 schemaVersion、sourceFacts、globalFactRefs、factRefs 或 groundingSeal。
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function creativeBriefValidationCorrection(fixedCharacter = "") {
  const authorizations = getFixedCharacterIdentityAuthorizations(fixedCharacter);
  const authorizedExpressions = authorizations.originalIdentityExpressions.length
    ? authorizations.originalIdentityExpressions.join("；")
    : "未识别到可泛化的动物身份；只能逐字使用 fixedCharacter 已声明内容";
  return `
Creative Brief 专用纠偏：
- 校验消息已经给出精确字段路径和具体命中词，只修正越界字段，不要重写整个 Creative Brief。
- fixedCharacter 原文：${fixedCharacter || "未指定"}
- fixedCharacter 中已授权的原始身份表达：${authorizedExpressions}
- 保留用户的姓名与全部固定角色设定；尤其不得把用户声明的猫耳少女、猫娘或猫尾设定删掉、降级或换成别的身份。
- newRole 和 newOccupationOrIdentity 只写目标角色最终身份；mappingLogic 只解释剧作功能迁移。
- mappingLogic 中“不继承原片动物形象”等否定来源说明不等于给目标角色指定动物身份；不要为了消除否定来源词而改动 fixedCharacter，只需用清楚的剧作功能语言修正真正越界的字段。`;
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 12288;
  const grownWithinDefaultCap = Math.min(32768, Math.max(12288, Math.ceil(current * 1.25)));
  return Math.max(current, grownWithinDefaultCap);
}
