import { ModelResponseError } from "./mimo-client.js";
import {
  STATIC_FRAME_CANDIDATE_ERROR_CODES,
  STATIC_FRAME_META_DIMENSIONS,
  applyGroundedStaticFramePatches,
  auditStaticFrameSourceCatalog,
  buildStaticFrameCompileTargets,
  buildStaticFrameSourceCatalog,
  createStaticFrameRunId,
  enumerateGroundedPatchCombinations,
  publicStaticFrameCatalogView,
  reviewSelectedStaticFrameEvidence,
  staticFrameTargetPromptView,
  summarizeReviewForMetadata,
  validateStaticFrameEvidenceEnvelope
} from "./static-frame-grounding.js";

export {
  STATIC_FRAME_CANDIDATE_ERROR_CODES,
  STATIC_FRAME_META_DIMENSIONS,
  auditStaticFrameSourceCatalog,
  buildStaticFrameCompileTargets,
  buildStaticFrameSourceCatalog,
  enumerateGroundedPatchCombinations,
  reviewSelectedStaticFrameEvidence,
  validateStaticFrameEvidenceEnvelope
} from "./static-frame-grounding.js";

export const STATIC_FRAME_COMPILER_VERSION = "2.0";
export const STATIC_FRAME_COMPILER_REASON_CODES = Object.freeze([
  "static_frame_required",
  "narrative_cognition",
  "psychological_activity",
  "future_intent",
  "goal_stage",
  "ambiguous_nonvisual",
  "temporal_process"
]);

const SYSTEM_PROMPT = `你是 Static Frame Evidence Selector。

你只能从服务端签发的不可变 Source Catalog 中选择 targetId、segmentId 和 spanId。
你不能返回、改写或创造状态文本，也不能返回 path、offset、角色 ID、字段、维度、value、visibleFacts 或 delete。
服务端将独立审核所选 evidence、生成 state slots、编译 canonical patch 并执行最终校验。
只输出一个严格 JSON 对象，不要 Markdown，不要解释。`;

export class StaticFrameCompilerError extends Error {
  constructor(message, { category = "compiler", metadata = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "StaticFrameCompilerError";
    this.stage = "staticFrameCompiler";
    this.category = category;
    this.metadata = metadata;
    this.details = { stage: this.stage, category, metadata };
  }
}

export class StaticFrameCompilerProtocolError extends StaticFrameCompilerError {
  constructor(message, options = {}) {
    super(message, { ...options, category: "protocol" });
    this.name = "StaticFrameCompilerProtocolError";
  }
}

export class StaticFrameCompilerTransportError extends StaticFrameCompilerError {
  constructor(message, { classification = "transport", ...options } = {}) {
    super(message, { ...options, category: classification });
    this.name = "StaticFrameCompilerTransportError";
    this.classification = classification;
  }
}

export class StaticFrameCompilerConfigError extends StaticFrameCompilerError {
  constructor(message, options = {}) {
    super(message, { ...options, category: "config" });
    this.name = "StaticFrameCompilerConfigError";
  }
}

export class StaticFrameCompilerCandidateError extends StaticFrameCompilerError {
  constructor(message, { errorCode, metadata = null, ...options } = {}) {
    super(message, { ...options, category: "candidate", metadata });
    this.name = "StaticFrameCompilerCandidateError";
    this.errorCode = errorCode;
    this.code = errorCode;
    this.status = 422;
    this.candidateLevel = true;
    this.staticFrameCompilerRuns = metadata ? [metadata] : [];
    this.details = {
      stage: this.stage,
      category: this.category,
      errorCode,
      metadata
    };
  }
}

/**
 * Compile only service-grounded, model-selected evidence into static frame
 * fields. The model never returns a patch or any free state text.
 */
export async function compileStaticFrames({
  candidate,
  client,
  provider = null,
  model,
  maxCompletionTokens = 4096,
  timeoutMs = 300_000,
  batchIndex = 0,
  phase = "post-generate",
  characterFeatureProfile = null,
  runId: suppliedRunId = null
} = {}) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new StaticFrameCompilerConfigError("Static Frame Compiler 缺少有效 animationShotBatch");
  }
  const sourceCandidate = structuredClone(candidate);
  const runId = suppliedRunId || createStaticFrameRunId();
  let targets;
  try {
    targets = buildStaticFrameCompileTargets(sourceCandidate, { runId });
  } catch (error) {
    throw new StaticFrameCompilerConfigError(String(error?.message || error), { cause: error });
  }
  const metadata = createRunMetadata({
    provider: provider || inferProvider(client),
    model,
    batchIndex,
    phase,
    runId
  });
  metadata.targetCount = targets.size;
  metadata.targets = [...targets.values()].map((target) => ({
    targetId: target.targetId,
    path: target.path,
    characterLabel: target.characterLabel,
    frameKind: target.frameKind,
    field: target.field
  }));

  if (targets.size === 0) {
    metadata.noOp = true;
    metadata.finalResult = "accepted";
    metadata.skipReason = "NO_VIOLATING_TARGET";
    return { compiledCandidate: sourceCandidate, metadata };
  }

  try {
    validateCompilerConfiguration({ candidate, client, model, maxCompletionTokens, timeoutMs });
  } catch (error) {
    attachRunMetadata(error, metadata);
    throw error;
  }
  const catalog = buildStaticFrameSourceCatalog(sourceCandidate, targets, {
    runId,
    characterFeatureProfile
  });
  const audit = auditStaticFrameSourceCatalog(catalog, targets, {
    characterFeatureProfile
  });
  metadata.catalogCandidateEvidenceCount = audit.totalCount;
  metadata.catalogCandidateEvidenceByTarget = [...targets.keys()].map((targetId) => ({
    targetId,
    count: audit.countForTarget(targetId)
  }));

  const targetWithoutCandidates = [...targets.keys()]
    .find((targetId) => audit.countForTarget(targetId) === 0);
  if (targetWithoutCandidates) {
    throwCandidateError(
      "NO_STATIC_EVIDENCE_IN_SOURCE",
      "Source Catalog 中没有可授权给 Evidence Selector 的静态证据候选",
      metadata,
      { targetId: targetWithoutCandidates, skipReason: "CATALOG_HAS_NO_AUTHORIZED_CANDIDATE" }
    );
  }

  const initialPrompt = buildEvidenceSelectionPrompt({
    targets,
    audit,
    characterFeatureProfile
  });
  let initialResponse;
  let initialEnvelope;
  try {
    initialResponse = await runStaticFrameProtocolAttempt({
      client,
      prompt: initialPrompt,
      model,
      maxCompletionTokens,
      timeoutMs,
      metadata,
      protocolAttempt: 1,
      repairMode: null
    });
    initialEnvelope = validateStaticFrameEvidenceEnvelope(initialResponse, {
      expectedTargetIds: [...targets.keys()],
      audit
    });
  } catch (error) {
    if (!(error instanceof StaticFrameCompilerProtocolError) && error?.category !== "protocol") {
      attachRunMetadata(error, metadata);
      throw error;
    }
    markLastProtocolFailure(metadata, error, "envelope_repair");
    const envelopePrompt = buildEnvelopeRepairPrompt({
      targets,
      audit,
      characterFeatureProfile,
      diagnostic: error.message
    });
    let repairedResponse;
    try {
      repairedResponse = await runStaticFrameProtocolAttempt({
        client,
        prompt: envelopePrompt,
        model,
        maxCompletionTokens,
        timeoutMs,
        metadata,
        protocolAttempt: 2,
        repairMode: "envelope_repair"
      });
      const repairedEnvelope = validateStaticFrameEvidenceEnvelope(repairedResponse, {
        expectedTargetIds: [...targets.keys()],
        audit,
        repairMode: "envelope_repair",
        requireRepairMode: true
      });
      const repairedEvaluation = evaluateGroundedAttempt({
        sourceCandidate,
        normalizedTargets: repairedEnvelope,
        targets,
        audit,
        characterFeatureProfile,
        attempt: 2,
        metadata,
        repairMode: "envelope_repair"
      });
      if (repairedEvaluation.failedTargetIds.length > 0) {
        const failedReview = repairedEvaluation.reviews.get(
          repairedEvaluation.failedTargetIds[0]
        );
        const code = failedReview?.slots.length === 0
          ? failedReview.unselectedCandidateSpanIds.length === 0
            ? "NO_STATIC_EVIDENCE_IN_SOURCE"
            : "EVIDENCE_RESELECTION_EXHAUSTED"
          : "NO_VALID_GROUNDED_COMBINATION";
        throwCandidateError(
          code,
          "Envelope 修复成功，但授权证据仍无法安全编译为 canonical patch",
          metadata,
          {
            targetId: repairedEvaluation.failedTargetIds[0],
            skipReason: "ENVELOPE_REPAIR_CONSUMED_SECOND_PROTOCOL_CALL"
          }
        );
      }
      return acceptGroundedEvaluation(sourceCandidate, targets, repairedEvaluation, metadata);
    } catch (repairError) {
      if (repairError instanceof StaticFrameCompilerCandidateError) throw repairError;
      if (!(repairError instanceof StaticFrameCompilerProtocolError) && repairError?.category !== "protocol") {
        attachRunMetadata(repairError, metadata);
        throw repairError;
      }
      markLastProtocolFailure(metadata, repairError, "fail");
      metadata.errorCode = "PROTOCOL_ENVELOPE_INVALID";
      metadata.finalResult = "failed";
      metadata.requestCount = countTransportAttempts(metadata);
      throw new StaticFrameCompilerProtocolError(
        `Static Frame Compiler 两次 protocol attempt 均失败：${repairError.message}`,
        { metadata, cause: repairError }
      );
    }
  }

  const initialEvaluation = evaluateGroundedAttempt({
    sourceCandidate,
    normalizedTargets: initialEnvelope,
    targets,
    audit,
    characterFeatureProfile,
    attempt: 1,
    metadata,
    repairMode: null
  });
  if (initialEvaluation.failedTargetIds.length === 0) {
    return acceptGroundedEvaluation(sourceCandidate, targets, initialEvaluation, metadata);
  }

  const terminalNoEvidenceTarget = initialEvaluation.failedTargetIds.find((targetId) => {
    const review = initialEvaluation.reviews.get(targetId);
    return review.slots.length === 0 && review.unselectedCandidateSpanIds.length === 0;
  });
  if (terminalNoEvidenceTarget) {
    throwCandidateError(
      "NO_STATIC_EVIDENCE_IN_SOURCE",
      "所选证据完整审核后没有安全单帧状态，且 Source Catalog 候选已耗尽",
      metadata,
      { targetId: terminalNoEvidenceTarget, skipReason: "ALL_CANDIDATES_AUDITED_WITHOUT_SAFE_SLOT" }
    );
  }

  const reselectableTargetIds = initialEvaluation.failedTargetIds.filter((targetId) => (
    initialEvaluation.reviews.get(targetId)?.unselectedCandidateSpanIds.length > 0
  ));
  if (reselectableTargetIds.length !== initialEvaluation.failedTargetIds.length) {
    throwCandidateError(
      "NO_VALID_GROUNDED_COMBINATION",
      "已验证 state slot 的全部合法组合均未通过完整校验",
      metadata,
      {
        targetId: initialEvaluation.failedTargetIds[0],
        skipReason: "NO_UNSELECTED_CANDIDATE_FOR_RESELECTION"
      }
    );
  }

  metadata.errorCode = "EVIDENCE_SELECTION_INCOMPLETE";
  metadata.intermediateErrorCodes.push("EVIDENCE_SELECTION_INCOMPLETE");
  const initialAttemptMetadata = metadata.attempts.at(-1);
  if (initialAttemptMetadata) {
    initialAttemptMetadata.errorCode = "EVIDENCE_SELECTION_INCOMPLETE";
  }
  metadata.repairMode = "evidence_reselection";
  metadata.skipReason = null;
  const reselectionPrompt = buildEvidenceReselectionPrompt({
    targets,
    audit,
    targetIds: reselectableTargetIds,
    characterFeatureProfile,
    diagnostics: summarizeReviewForMetadata(initialEvaluation.reviews)
      .filter((review) => reselectableTargetIds.includes(review.targetId))
  });
  let reselectionResponse;
  let reselectionEnvelope;
  try {
    reselectionResponse = await runStaticFrameProtocolAttempt({
      client,
      prompt: reselectionPrompt,
      model,
      maxCompletionTokens,
      timeoutMs,
      metadata,
      protocolAttempt: 2,
      repairMode: "evidence_reselection"
    });
    reselectionEnvelope = validateStaticFrameEvidenceEnvelope(reselectionResponse, {
      expectedTargetIds: reselectableTargetIds,
      audit,
      repairMode: "evidence_reselection",
      requireRepairMode: true
    });
  } catch (error) {
    if (!(error instanceof StaticFrameCompilerProtocolError) && error?.category !== "protocol") {
      attachRunMetadata(error, metadata);
      throw error;
    }
    markLastProtocolFailure(metadata, error, "fail");
    metadata.errorCode = "PROTOCOL_ENVELOPE_INVALID";
    metadata.finalResult = "failed";
    metadata.requestCount = countTransportAttempts(metadata);
    throw new StaticFrameCompilerProtocolError(
      `Static Frame Compiler evidence_reselection 协议失败且不允许第三次调用：${error.message}`,
      { metadata, cause: error }
    );
  }

  const reselectionEvaluation = evaluateGroundedAttempt({
    sourceCandidate,
    normalizedTargets: reselectionEnvelope,
    targets,
    audit,
    characterFeatureProfile,
    attempt: 2,
    metadata,
    repairMode: "evidence_reselection"
  });
  if (reselectionEvaluation.failedTargetIds.length > 0) {
    throwCandidateError(
      "EVIDENCE_RESELECTION_EXHAUSTED",
      "evidence_reselection 后仍无通过完整校验的 grounded combination",
      metadata,
      {
        targetId: reselectionEvaluation.failedTargetIds[0],
        skipReason: "SECOND_PROTOCOL_CALL_EXHAUSTED"
      }
    );
  }

  const retainedPatches = initialEvaluation.patches
    .filter((patch) => !reselectableTargetIds.includes(patch.targetId));
  const mergedEvaluation = {
    ...reselectionEvaluation,
    patches: [...retainedPatches, ...reselectionEvaluation.patches]
  };
  return acceptGroundedEvaluation(sourceCandidate, targets, mergedEvaluation, metadata);
}

export function buildStaticFrameCompilerPrompt(
  candidate,
  suppliedTargets = null,
  { characterFeatureProfile = null, runId = createStaticFrameRunId() } = {}
) {
  const targets = suppliedTargets instanceof Map
    && [...suppliedTargets.values()].every((target) => typeof target.targetId === "string")
    ? suppliedTargets
    : buildStaticFrameCompileTargets(candidate, { runId });
  const catalog = buildStaticFrameSourceCatalog(candidate, targets, {
    runId,
    characterFeatureProfile
  });
  const audit = auditStaticFrameSourceCatalog(catalog, targets, {
    characterFeatureProfile
  });
  return buildEvidenceSelectionPrompt({
    targets,
    audit,
    characterFeatureProfile
  });
}

function buildEvidenceSelectionPrompt({ targets, audit, characterFeatureProfile = null }) {
  return `STATIC_FRAME_EVIDENCE_SELECTION_V2

任务：
- 为每个服务端签发的 targetId，从它自己的不可变 Source Catalog 中选择可能独立表达单帧状态的 evidence。
- 应尽量完整选择所有安全候选；允许少选，但绝对禁止创造输入中不存在的事实。
- 只能引用下方展示的 targetId、segmentId、spanId。

输出协议（所有层级禁止额外字段）：
{"targets":[{"targetId":"compile-target-...","evidenceSelections":[{"segmentId":"seg-...","spanIds":["span-..."]}]}]}

强约束：
- 每个必需 targetId 恰好出现一次；不得遗漏、重复、新增或跨 target 引用。
- 每个 target 最多 12 个 evidenceSelections；每项最多 4 个 spanId。
- 同一 selection 的 spanId 必须属于同一 segmentId。
- 不得返回文本、path、offset、角色、字段、dimension、stateSlotId、value、visibleFacts、reasonCode、trigger 或 delete。
- 叙事认知、心理、意图、未来、目标、过程、对白、音效不是单帧状态。
- handPropState 的手—道具关系不能作为 bodyContact。
- 你只负责选择；服务端负责完整语义审核、维度、组合、最终文本与 patch。

服务端固定审核规则：
${staticEvidencePolicyText()}

冻结 Character Feature 词库（只读，不得回传或据此注入当前镜头）：
${JSON.stringify(publicCharacterFeatureDictionary(characterFeatureProfile, targets))}

服务端签发的 compile targets：
${JSON.stringify(staticFrameTargetPromptView(targets))}

不可变 Source Catalog（displayText 只读，不得回传）：
${JSON.stringify(publicStaticFrameCatalogView(audit, targets))}`;
}

function buildEvidenceReselectionPrompt({
  targets,
  audit,
  targetIds,
  characterFeatureProfile = null,
  diagnostics = []
}) {
  return `STATIC_FRAME_EVIDENCE_RESELECTION_V2

首次 envelope 合法，但首次 Evidence Selection 未形成可通过的 grounded combination。
这是唯一一次 evidence_reselection，也是最后一次 protocol 调用。

输出协议（所有层级禁止额外字段）：
{"repairMode":"evidence_reselection","targets":[{"targetId":"compile-target-...","evidenceSelections":[{"segmentId":"seg-...","spanIds":["span-..."]}]}]}

强约束：
- 只覆盖下方列出的 targetId，且每个恰好一次。
- attempt-2 完整替代这些 target 的 attempt-1 selection，不隐式合并。
- 只能从首次调用前已签发的不可变 Catalog ID 中重选。
- 不得新增 Catalog、文本、角色、字段、offset、dimension、stateSlot、value 或 visibleFacts。
- 不得修改已通过 target；不得请求第三次调用。

首次选择的结构化审核结果：
${JSON.stringify(diagnostics)}

服务端固定审核规则：
${staticEvidencePolicyText()}

冻结 Character Feature 词库（只读）：
${JSON.stringify(publicCharacterFeatureDictionary(characterFeatureProfile, targets, targetIds))}

需要重新选择的 targets：
${JSON.stringify(staticFrameTargetPromptView(new Map(
    targetIds.map((targetId) => [targetId, targets.get(targetId)])
  )))}

原始不可变 Source Catalog：
${JSON.stringify(publicStaticFrameCatalogView(audit, targets, { targetIds }))}`;
}

function buildEnvelopeRepairPrompt({
  targets,
  audit,
  characterFeatureProfile = null,
  diagnostic
}) {
  return `STATIC_FRAME_ENVELOPE_REPAIR_V2

第一次输出无法形成可信 Evidence Selection envelope：
${JSON.stringify(String(diagnostic || "未知协议错误"))}

这是唯一一次 envelope_repair，也是最后一次 protocol 调用。
只能修复 JSON、Schema、必需 target 覆盖和已签发 ID 引用；不得改变任务、Catalog 或证据边界。

输出协议（所有层级禁止额外字段）：
{"repairMode":"envelope_repair","targets":[{"targetId":"compile-target-...","evidenceSelections":[{"segmentId":"seg-...","spanIds":["span-..."]}]}]}

服务端固定审核规则：
${staticEvidencePolicyText()}

冻结 Character Feature 词库（只读）：
${JSON.stringify(publicCharacterFeatureDictionary(characterFeatureProfile, targets))}

服务端签发的 compile targets：
${JSON.stringify(staticFrameTargetPromptView(targets))}

首次调用前签发的不可变 Source Catalog：
${JSON.stringify(publicStaticFrameCatalogView(audit, targets))}`;
}

function staticEvidencePolicyText() {
  return `- 禁止叙事认知：发现、意识到、知道、明白、认出、想起、回忆、察觉、理解、确认、判断。
- 禁止心理/意图/未来/目标：决定、希望、担心、害怕、期待、犹豫、想要、试图、打算、计划、准备、即将、将要、为了、以便、下一步。
- 禁止过程/非视觉：逐渐、随后、然后、正在、开始、继续、慢慢、逐步、过程中、对白、音效、运镜。
- 同一 segment 可用多个不重叠 span 做删除式整理，但 span 间隔必须只含上述禁止词、语法连接词或标点；不得跨主体、跨事实拼接新状态。
- 每个安全 slot 只会得到一个 primaryDimensionKey；优先级为当前角色精确 feature → orientation → bodyContact → limbs → body。
- bodyContact 只接受身体或肢体与地面、墙面、座椅等环境支撑关系；手—道具接触、handPropState、握持、托举、按压道具、悬停和道具距离均排除。
- inferred feature 只有当本次局部原文字面出现冻结 term 时才可选择；词库不是当前镜头事实。`;
}

function publicCharacterFeatureDictionary(profile, targets, targetIds = [...targets.keys()]) {
  if (!profile || !Array.isArray(profile.characters)) return [];
  return targetIds.flatMap((targetId) => {
    const target = targets.get(targetId);
    const character = resolveProfileCharacterForTarget(profile, target);
    if (!target || !character || !Array.isArray(character.features)) return [];
    return [{
      targetId,
      characterLabel: target.characterLabel,
      features: character.features.map((feature) => ({
        suggestedFeatureKey: feature.suggestedFeatureKey,
        canonicalName: feature.canonicalName,
        terms: Array.isArray(feature.matcherTerms)
          ? [...feature.matcherTerms]
          : Array.isArray(feature.terms) ? [...feature.terms] : [],
        featureKind: feature.featureKind,
        semanticSubtype: feature.semanticSubtype,
        evidenceLevel: feature.evidenceLevel
      }))
    }];
  });
}

function resolveProfileCharacterForTarget(profile, target) {
  if (!target) return null;
  const idMatches = profile.characters.filter((character) => (
    character?.characterId === target.characterId
  ));
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1 || target.characterLabelUniqueInFrame === false) return null;
  const nameMatches = profile.characters.filter((character) => (
    character?.name === target.characterLabel
    || character?.characterLabel === target.characterLabel
    || character?.characterName === target.characterLabel
    || character?.canonicalName === target.characterLabel
  ));
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function runStaticFrameProtocolAttempt({
  client,
  prompt,
  model,
  maxCompletionTokens,
  timeoutMs,
  metadata,
  protocolAttempt,
  repairMode
}) {
  const protocolLog = {
    protocolAttempt,
    repairMode,
    transportAttempts: [],
    errorClassification: null,
    retryDecision: "none",
    finalResult: "pending"
  };
  metadata.protocolAttempts.push(protocolLog);
  metadata.protocolCallCount = metadata.protocolAttempts.length;
  try {
    const response = await requestWithTransportRetry({
      client,
      prompt,
      model,
      maxCompletionTokens,
      timeoutMs,
      protocolLog
    });
    protocolLog.finalResult = "response";
    return response;
  } catch (error) {
    if (error instanceof StaticFrameCompilerProtocolError) {
      protocolLog.errorClassification = "protocol";
      protocolLog.finalResult = "protocol-error";
      protocolLog.protocolError = error.message;
    }
    throw error;
  }
}

function evaluateGroundedAttempt({
  sourceCandidate,
  normalizedTargets,
  targets,
  audit,
  characterFeatureProfile,
  attempt,
  metadata,
  repairMode
}) {
  const reviews = reviewSelectedStaticFrameEvidence({
    normalizedTargets,
    targets,
    audit,
    characterFeatureProfile,
    attempt
  });
  const patches = [];
  const failedTargetIds = [];
  const searches = [];
  for (const entry of normalizedTargets) {
    const target = targets.get(entry.targetId);
    const review = reviews.get(entry.targetId);
    const result = enumerateGroundedPatchCombinations(target, review, {
      candidate: sourceCandidate
    });
    searches.push({
      targetId: entry.targetId,
      combinations: result.search,
      combinationTriedCount: result.search.length,
      combinationAccepted: Boolean(result.patch),
      acceptedStateSlotIds: result.combination
        ? result.combination.map((slot) => slot.stateSlotId)
        : []
    });
    if (result.patch) patches.push(result.patch);
    else failedTargetIds.push(entry.targetId);
  }

  const reviewSummary = summarizeReviewForMetadata(reviews);
  metadata.attempts.push({
    attempt,
    repairMode,
    targets: reviewSummary,
    combinationSearch: searches
  });
  metadata.selectedValidatedEvidenceCount = reviewSummary
    .reduce((total, item) => total + item.selectedValidatedEvidenceCount, 0);
  metadata.unselectedCandidateEvidenceCount = reviewSummary
    .reduce((total, item) => total + item.unselectedCandidateEvidenceCount, 0);
  metadata.currentAttemptRequiredDimensionCount = reviewSummary.map((item) => ({
    targetId: item.targetId,
    requiredDimensionCount: item.requiredDimensionCount,
    safeDimensions: [...item.safeDimensions]
  }));
  metadata.combinationSearch = searches;
  const protocolLog = metadata.protocolAttempts.at(-1);
  if (protocolLog) {
    protocolLog.finalResult = failedTargetIds.length === 0 ? "grounded-accepted" : "grounded-rejected";
    protocolLog.errorClassification = failedTargetIds.length === 0 ? null : "candidate";
    protocolLog.retryDecision = failedTargetIds.length > 0 && attempt === 1
      ? "evidence_reselection-or-fail"
      : "none";
  }
  return { patches, failedTargetIds, reviews, searches };
}

function acceptGroundedEvaluation(sourceCandidate, targets, evaluation, metadata) {
  const compiledCandidate = applyGroundedStaticFramePatches(
    sourceCandidate,
    evaluation.patches,
    targets
  );
  metadata.noOp = evaluation.patches.length === 0;
  metadata.modifications.push(...evaluation.patches.map((patch) => {
    const target = targets.get(patch.targetId);
    return {
      targetId: patch.targetId,
      path: patch.path,
      before: target.before,
      after: patch.value,
      reasonCode: patch.reasonCode,
      triggerSpans: [...patch.triggerSpans],
      visibleFacts: [...patch.visibleFacts],
      stateSlotIds: [...patch.stateSlotIds],
      applied: true,
      finalAccepted: false
    };
  }));
  metadata.errorCode = null;
  metadata.requestCount = countTransportAttempts(metadata);
  metadata.finalResult = "accepted";
  return { compiledCandidate, metadata };
}

function throwCandidateError(errorCode, message, metadata, extras = {}) {
  if (!STATIC_FRAME_CANDIDATE_ERROR_CODES.includes(errorCode)) {
    throw new StaticFrameCompilerConfigError(`未知 candidate-level errorCode：${errorCode}`);
  }
  metadata.errorCode = errorCode;
  metadata.finalResult = "failed";
  metadata.requestCount = countTransportAttempts(metadata);
  Object.assign(metadata, extras);
  throw new StaticFrameCompilerCandidateError(
    `Static Frame Compiler ${errorCode}：${message}`,
    { errorCode, metadata }
  );
}

function markLastProtocolFailure(metadata, error, retryDecision) {
  const protocolLog = metadata.protocolAttempts.at(-1);
  if (!protocolLog) return;
  protocolLog.errorClassification = "protocol";
  protocolLog.retryDecision = retryDecision;
  protocolLog.finalResult = "protocol-error";
  protocolLog.protocolError = String(error?.message || error);
  metadata.repairMode = retryDecision === "envelope_repair" ? "envelope_repair" : metadata.repairMode;
}

function attachRunMetadata(error, metadata) {
  metadata.requestCount = countTransportAttempts(metadata);
  metadata.finalResult = "failed";
  if (error && typeof error === "object") {
    error.metadata = metadata;
    error.details = {
      ...(isRecord(error.details) ? error.details : {}),
      stage: "staticFrameCompiler",
      category: error.category || "transport",
      metadata
    };
  }
}

function validateCompilerConfiguration({ candidate, client, model, maxCompletionTokens, timeoutMs }) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new StaticFrameCompilerConfigError("Static Frame Compiler 缺少有效 animationShotBatch");
  }
  if (!client || typeof client.generateJson !== "function") {
    throw new StaticFrameCompilerConfigError("Static Frame Compiler client 必须实现 generateJson");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_MODEL 必须显式配置");
  }
  if (!Number.isFinite(Number(maxCompletionTokens)) || Number(maxCompletionTokens) <= 0) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS 必须为正数");
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_TIMEOUT_MS 必须为正数");
  }
}

async function requestWithTransportRetry({
  client,
  prompt,
  model,
  maxCompletionTokens,
  timeoutMs,
  protocolLog
}) {
  for (let transportAttempt = 1; transportAttempt <= 2; transportAttempt += 1) {
    const transportLog = {
      transportAttempt,
      errorClassification: null,
      retryDecision: "none",
      finalResult: "pending"
    };
    protocolLog.transportAttempts.push(transportLog);
    try {
      const response = await client.generateJson({
        prompt,
        model,
        maxCompletionTokens,
        systemPrompt: SYSTEM_PROMPT,
        requestTimeoutMs: timeoutMs,
        jsonRetryAttempts: 0,
        strictJson: true
      });
      transportLog.finalResult = "response";
      return response;
    } catch (error) {
      if (isModelJsonProtocolError(error)) {
        transportLog.errorClassification = "protocol";
        transportLog.retryDecision = "none";
        transportLog.finalResult = "error";
        throw new StaticFrameCompilerProtocolError(
          `模型返回 JSON 无法解析：${String(error?.message || error)}`,
          { cause: error }
        );
      }

      const classification = classifyTransportError(error);
      const transient = isTransientTransportError(error, classification);
      transportLog.errorClassification = classification;
      transportLog.retryDecision = transient && transportAttempt === 1 ? "retry" : "fail";
      transportLog.finalResult = "error";
      if (transient && transportAttempt === 1) continue;
      protocolLog.finalResult = "transport-error";
      protocolLog.errorClassification = classification;
      protocolLog.retryDecision = "fail";
      throw new StaticFrameCompilerTransportError(
        `Static Frame Compiler ${classification} 失败：${String(error?.message || error)}`,
        { classification, cause: error }
      );
    }
  }
  throw new StaticFrameCompilerTransportError(
    "Static Frame Compiler 超过单次 protocol attempt 的 transport retry 预算"
  );
}

function createRunMetadata({ provider, model, batchIndex, phase, runId = null }) {
  return {
    version: STATIC_FRAME_COMPILER_VERSION,
    runId,
    provider,
    model,
    batchIndex,
    phase,
    noOp: false,
    runAccepted: false,
    requestCount: 0,
    protocolCallCount: 0,
    finalResult: "pending",
    errorCode: null,
    intermediateErrorCodes: [],
    repairMode: null,
    skipReason: null,
    targetCount: 0,
    catalogCandidateEvidenceCount: 0,
    selectedValidatedEvidenceCount: 0,
    unselectedCandidateEvidenceCount: 0,
    protocolAttempts: [],
    attempts: [],
    combinationSearch: [],
    modifications: []
  };
}

function countTransportAttempts(metadata) {
  return metadata.protocolAttempts.reduce(
    (total, protocolAttempt) => total + protocolAttempt.transportAttempts.length,
    0
  );
}

function inferProvider(client) {
  const name = String(client?.constructor?.name || "").replace(/Client$/u, "");
  return name || "unknown";
}

function isModelJsonProtocolError(error) {
  if (error instanceof StaticFrameCompilerProtocolError || error instanceof SyntaxError) return true;
  if (!(error instanceof ModelResponseError) && error?.name !== "ModelResponseError") return false;
  const message = String(error?.message || "");
  return Number(error?.status || 0) === 0
    && /未返回合法 JSON|无法解析的响应包|响应缺少 .*content|JSON/u.test(message);
}

function classifyTransportError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  const upperMessage = message.toUpperCase();
  if (status === 401 || status === 403 || /API.?KEY|AUTH|鉴权|认证|未授权/u.test(upperMessage)) {
    return "auth";
  }
  if (
    ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"].includes(code)
    || /INVALID CONFIG|MISSING CONFIG|CONFIGURATION|配置错误|缺少配置/u.test(upperMessage)
  ) {
    return "config";
  }
  if (
    /INVALID MODEL|UNKNOWN MODEL|MODEL .*(?:NOT FOUND|UNAVAILABLE)|无效模型|未知模型|模型.*(?:不存在|不可用)/u.test(upperMessage)
    || /UNKNOWN PROVIDER|UNSUPPORTED PROVIDER|INVALID PROVIDER|未知.*(?:PROVIDER|供应商)|不支持.*(?:PROVIDER|供应商)/u.test(upperMessage)
  ) {
    return "provider";
  }
  if (
    status === 408
    || name === "AbortError"
    || name === "TimeoutError"
    || ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)
    || /TIMEOUT|TIMED OUT|超时/u.test(upperMessage)
  ) {
    return "timeout";
  }
  if (status > 0) return "provider";
  return "transport";
}

function isTransientTransportError(error, classification) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = String(error?.message || error?.cause?.message || "").toUpperCase();
  if (classification === "auth") return false;
  if (status === 408 || status === 429 || status >= 500) return true;
  if (classification === "timeout") return true;
  if (status >= 400) return false;
  if ([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)) {
    return true;
  }
  return classification === "transport"
    && /FETCH FAILED|NETWORK (?:UNAVAILABLE|ERROR)|SOCKET|CONNECTION (?:RESET|REFUSED)|DNS/u.test(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
