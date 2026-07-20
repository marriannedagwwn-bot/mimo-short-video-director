export class InputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "InputError";
    this.details = details;
  }
}

export class OutputContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputContractError";
  }
}

export function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`${name} 必须是对象`);
  }
  return value;
}

export function requireFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 3) {
    throw new InputError("至少需要 3 张采样画面才能分析参考视频");
  }
  if (frames.length > 16) throw new InputError("采样画面不能超过 16 张");
  frames.forEach((frame, index) => {
    if (!frame || typeof frame.dataUrl !== "string" || !frame.dataUrl.startsWith("data:image/")) {
      throw new InputError(`第 ${index + 1} 张采样画面格式无效`);
    }
    if (!Number.isFinite(frame.timestamp)) throw new InputError(`第 ${index + 1} 张采样画面缺少时间戳`);
  });
  return frames;
}

export function requireText(value, name, { optional = false, max = 12000 } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${name} 不能为空`);
  if (value.length > max) throw new InputError(`${name} 不能超过 ${max} 字符`);
  return value.trim();
}

const outputContracts = {
  referenceAnalysis: ["contentPositioning", "targetAudience", "storySynopsis", "characters", "protagonistIdentity", "careRecipient", "dialogueStyle", "shotRhythm", "emotionCurve", "retentionDrivers", "whyWatchToEnd", "analysisConfidence", "uncertainties"],
  sourceScriptReconstruction: ["scenes", "coreEventSequence", "relationshipPattern", "endingAction", "turningPoints", "uncertainties"],
  creativeBrief: ["contentType", "targetAudience", "coreEmotion", "storyEngine", "emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents", "nonNegotiableExperience", "creativeDistancePolicy"],
  visualGuardrails: ["fixedCharacterBoundary", "allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "stageInstructions", "rationale", "uncertainties"],
  themeVariants: ["variants"],
  fullStory: ["selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis", "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide", "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"],
  animationPlan: ["selectedVariantId", "title", "productionStrategy", "visualBible", "characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "shotPlan", "editPlan", "generationChecklist", "modelAgnosticNotes", "continuityAndSafetyCheck", "uncertainties"]
};

const visualGuardrailTopLevelFields = new Set(outputContracts.visualGuardrails);
const negativePromptReasonCodes = new Set([
  "explicit_identity_conflict",
  "shot_object_confusion",
  "shot_interaction_failure",
  "temporal_consistency_failure",
  "reference_leak",
  "proven_provider_failure"
]);
const negativePromptPriorities = new Set(["high", "medium", "low"]);
const negativePromptMedia = new Set(["image", "video", "both"]);

export function ensureOutputContract(value, contract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${contract} 必须是对象`);
  const missing = (outputContracts[contract] || []).filter((key) => !(key in value));
  if (missing.length) throw new OutputContractError(`${contract} 缺少必要字段：${missing.join("、")}`);
  const arrayFields = {
    referenceAnalysis: ["characters", "emotionCurve", "retentionDrivers", "uncertainties"],
    sourceScriptReconstruction: ["scenes", "coreEventSequence", "turningPoints", "uncertainties"],
    creativeBrief: ["emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents"],
    visualGuardrails: ["allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "uncertainties"],
    themeVariants: ["variants"],
    fullStory: ["beatSheet", "sceneScript", "keyProps", "shootingPlan", "retentionPlan", "uncertainties"],
    animationPlan: ["characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "shotPlan", "generationChecklist", "modelAgnosticNotes", "uncertainties"]
  }[contract] || [];
  const wrongArrays = arrayFields.filter((key) => !Array.isArray(value[key]));
  if (wrongArrays.length) throw new OutputContractError(`${contract} 字段类型无效：${wrongArrays.join("、")} 必须是数组`);
  if (contract === "sourceScriptReconstruction" && value.scenes.length < 1) throw new OutputContractError("sourceScriptReconstruction 至少需要一个分场");
  if (contract === "creativeBrief") {
    validateNarrativeComponents(value.allowedNarrativeComponents);
    validateProtectedExpressions(value.protectedExpressions);
  }
  if (contract === "visualGuardrails") {
    validateVisualGuardrailsContract(value);
  }
  if (contract === "themeVariants" && value.variants.length < 1) throw new OutputContractError("themeVariants 至少需要一个主题方案");
  if (contract === "fullStory") {
    if (value.beatSheet.length < 6) throw new OutputContractError("fullStory 至少需要 6 个剧情节拍");
    if (value.sceneScript.length < 6) throw new OutputContractError("fullStory 至少需要 6 个可拍摄分场");
  }
  if (contract === "animationPlan") {
    if (value.characterReferencePrompts.length < 1) throw new OutputContractError("animationPlan 至少需要一个角色参考提示词");
    if (value.sceneReferencePrompts.length < 1) throw new OutputContractError("animationPlan 至少需要一个场景参考提示词");
    if (value.shotPlan.length < 1) throw new OutputContractError("animationPlan 至少需要一个镜头生产任务");
    validateAnimationPlanNegativePromptContract(value);
  }
  return value;
}

function validateVisualGuardrailsContract(value) {
  const unexpected = Object.keys(value).filter((key) => !visualGuardrailTopLevelFields.has(key));
  if (unexpected.length) {
    throw new OutputContractError(`visualGuardrails 包含未允许的顶层字段：${unexpected.join("、")}`);
  }
  if (!value.fixedCharacterBoundary || typeof value.fixedCharacterBoundary !== "object" || Array.isArray(value.fixedCharacterBoundary)) {
    throw new OutputContractError("visualGuardrails.fixedCharacterBoundary 必须是对象");
  }
  if (!value.stageInstructions || typeof value.stageInstructions !== "object" || Array.isArray(value.stageInstructions)) {
    throw new OutputContractError("visualGuardrails.stageInstructions 必须是对象");
  }
  value.allowedPositiveTraits.forEach((item, index) => {
    requireRuleObject(item, `visualGuardrails.allowedPositiveTraits[${index}]`, ["term", "scope", "reason"]);
  });
  value.positivePromptBoundary.forEach((item, index) => {
    const path = `visualGuardrails.positivePromptBoundary[${index}]`;
    requireRuleObject(item, path, ["rule", "triggerEvidence", "severity"]);
    if (!String(item.rule || "").trim()) throw new OutputContractError(`${path}.rule 不能为空`);
    if (!["block", "warn"].includes(item.severity)) throw new OutputContractError(`${path}.severity 只允许 block 或 warn`);
    validateTriggerEvidenceShape(item.triggerEvidence, `${path}.triggerEvidence`, { requireNonEmpty: true });
  });
  value.sourceSimilarityRules.forEach((item, index) => {
    const path = `visualGuardrails.sourceSimilarityRules[${index}]`;
    requireRuleObject(item, path, ["text", "sourceExpression", "triggerEvidence", "appliesWhenReferenceUsed"]);
    if (!String(item.text || "").trim() || !String(item.sourceExpression || "").trim()) {
      throw new OutputContractError(`${path}.text 和 sourceExpression 不能为空`);
    }
    if (item.appliesWhenReferenceUsed !== true) {
      throw new OutputContractError(`${path}.appliesWhenReferenceUsed 必须为 true`);
    }
    validateTriggerEvidenceShape(item.triggerEvidence, `${path}.triggerEvidence`, { requireNonEmpty: true });
  });
  value.dialogueRules.forEach((item, index) => {
    const path = `visualGuardrails.dialogueRules[${index}]`;
    requireRuleObject(item, path, ["text", "triggerEvidence"]);
    if (!String(item.text || "").trim()) throw new OutputContractError(`${path}.text 不能为空`);
    validateTriggerEvidenceShape(item.triggerEvidence, `${path}.triggerEvidence`, { requireNonEmpty: true });
  });
}

function validateAnimationPlanNegativePromptContract(value) {
  if (!value.visualBible || typeof value.visualBible !== "object" || Array.isArray(value.visualBible)) {
    throw new OutputContractError("animationPlan.visualBible 必须是对象");
  }
  if (Object.prototype.hasOwnProperty.call(value.visualBible, "negativeVisualRules")) {
    throw new OutputContractError("animationPlan.visualBible 不再允许 negativeVisualRules；负面提示词必须逐镜输出");
  }
  value.sceneReferencePrompts.forEach((scene, index) => {
    if (scene && Object.prototype.hasOwnProperty.call(scene, "negativeSceneRules")) {
      throw new OutputContractError(`animationPlan.sceneReferencePrompts[${index}] 不再允许 negativeSceneRules`);
    }
  });
  value.shotPlan.forEach((shot, shotIndex) => {
    const path = `animationPlan.shotPlan[${shotIndex}]`;
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) throw new OutputContractError(`${path} 必须是对象`);
    if (Object.prototype.hasOwnProperty.call(shot, "negativePrompt")) {
      throw new OutputContractError(`${path} 不再允许 negativePrompt 字符串`);
    }
    const negativePrompts = shot.negativePrompts;
    if (!negativePrompts || typeof negativePrompts !== "object" || Array.isArray(negativePrompts)) {
      throw new OutputContractError(`${path}.negativePrompts 必须是对象`);
    }
    const unexpected = Object.keys(negativePrompts).filter((key) => !["image", "video"].includes(key));
    if (unexpected.length) throw new OutputContractError(`${path}.negativePrompts 包含未知字段：${unexpected.join("、")}`);
    for (const media of ["image", "video"]) {
      const items = negativePrompts[media];
      if (!Array.isArray(items)) throw new OutputContractError(`${path}.negativePrompts.${media} 必须是数组`);
      items.forEach((item, itemIndex) => validateNegativePromptItemShape(item, `${path}.negativePrompts.${media}[${itemIndex}]`));
    }
  });
}

function validateNegativePromptItemShape(item, path) {
  requireRuleObject(item, path, ["text", "appliesTo", "triggerEvidence", "reasonCode", "priority"]);
  if (!String(item.text || "").trim()) throw new OutputContractError(`${path}.text 不能为空`);
  if (!negativePromptMedia.has(item.appliesTo)) throw new OutputContractError(`${path}.appliesTo 只允许 image、video 或 both`);
  if (!negativePromptReasonCodes.has(item.reasonCode)) throw new OutputContractError(`${path}.reasonCode 不受支持`);
  if (!negativePromptPriorities.has(item.priority)) throw new OutputContractError(`${path}.priority 只允许 high、medium 或 low`);
  if (Object.prototype.hasOwnProperty.call(item, "enabled") && typeof item.enabled !== "boolean") {
    throw new OutputContractError(`${path}.enabled 必须是布尔值`);
  }
  validateTriggerEvidenceShape(item.triggerEvidence, `${path}.triggerEvidence`, { requireNonEmpty: true });
}

function requireRuleObject(item, path, requiredFields) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new OutputContractError(`${path} 必须是对象`);
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(item, field));
  if (missing.length) throw new OutputContractError(`${path} 缺少字段：${missing.join("、")}`);
}

function validateTriggerEvidenceShape(triggerEvidence, path, { requireNonEmpty = false } = {}) {
  if (!Array.isArray(triggerEvidence)) throw new OutputContractError(`${path} 必须是数组`);
  if (requireNonEmpty && !triggerEvidence.length) throw new OutputContractError(`${path} 至少需要一条明确证据`);
  triggerEvidence.forEach((entry, index) => {
    requireRuleObject(entry, `${path}[${index}]`, ["sourcePath", "evidence"]);
    if (typeof entry.sourcePath !== "string" || typeof entry.evidence !== "string") {
      throw new OutputContractError(`${path}[${index}] 的 sourcePath 和 evidence 必须是字符串`);
    }
    if (!entry.sourcePath.trim() || !entry.evidence.trim()) {
      throw new OutputContractError(`${path}[${index}] 的 sourcePath 和 evidence 不能为空`);
    }
  });
}

export function ensureVisualGuardrailsMatchesProfile(value, creatorProfile = {}) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  if (!fixedName) return value;

  const boundaryText = JSON.stringify(value.fixedCharacterBoundary || {});
  const allText = JSON.stringify(value);
  const conflictTerms = collectVisualGuardrailRawForbiddenTerms(value)
    .filter((term) => isAllowedByFixedProfile(term, fixedProfile, value));

  const mismatches = [];
  if (!allText.includes(fixedName) && !boundaryText.includes(fixedName)) {
    mismatches.push(`未围绕固定角色「${fixedName}」生成外观规则`);
  }
  if (!value.positivePromptBoundary.length) {
    mismatches.push("缺少用于后续正向提示词审查的 positivePromptBoundary");
  }
  if (conflictTerms.length) {
    mismatches.push(`sourceSimilarityRules 与固定角色已明确允许的特征冲突：${[...new Set(conflictTerms)].join("、")}`);
  }
  if (mismatches.length) throw new OutputContractError(`visualGuardrails 未锁定固定角色：${mismatches.join("；")}`);
  return value;
}

export function ensureCreativeBriefMatchesProfile(value, creatorProfile = {}) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  if (!fixedName) return value;

  const mappingText = JSON.stringify(value.roleAndOccupationMapping || []);
  if (!mappingText.includes(fixedName)) {
    throw new OutputContractError(`creativeBrief 未将固定角色「${fixedName}」写入角色映射`);
  }

  const protectedTerms = collectProtectedTermsFromBrief(value, fixedProfile);
  const identityLeakTerms = incompatibleProtagonistSurfaceTerms(fixedProfile);
  const protagonistMappings = (value.roleAndOccupationMapping || []).filter((mapping) => {
    const text = JSON.stringify(mapping || {});
    return text.includes(fixedName) || /主角|信使|任务执行|行动承担|固定角色/u.test(text);
  });
  for (const mapping of protagonistMappings) {
    assertNoTerms(
      JSON.stringify({
        newRole: mapping?.newRole,
        newOccupationOrIdentity: mapping?.newOccupationOrIdentity,
        mappingLogic: mapping?.mappingLogic
      }),
      [...protectedTerms, ...identityLeakTerms],
      `creativeBrief.roleAndOccupationMapping 中固定角色「${fixedName}」的身份映射`
    );
  }

  return value;
}

export function ensureThemeVariantsMatchProfile(value, creatorProfile = {}, creativeBrief = null, visualGuardrails = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (!fixedName) return value;
  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const sourceLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const positiveBoundaryTerms = collectPositivePromptBoundaryTerms(fixedProfile);
  const protagonistLeakTerms = [...new Set([...sourceLeakTerms, ...positiveBoundaryTerms])];
  const visibleLeakTerms = protagonistLeakTerms;
  const mismatches = [];
  value.variants.forEach((variant, index) => {
    const label = variant?.id || `V${index + 1}`;
    const protagonist = variant?.characterSetup?.protagonist || "";
    const visibleStoryText = [
      variant?.oneLineHook,
      variant?.logline,
      variant?.newTask,
      variant?.emotionalMedium,
      variant?.environmentPressure,
      ...(Array.isArray(variant?.storyOutline) ? variant.storyOutline.map((beat) => beat?.action) : []),
      variant?.endingRitual
    ].filter(Boolean).join("\n");
    if (!String(protagonist).includes(fixedName)) {
      mismatches.push(`${label} 的 protagonist 未包含「${fixedName}」`);
    } else if (!visibleStoryText.includes(fixedName)) {
      mismatches.push(`${label} 的可见故事文本未使用固定角色「${fixedName}」`);
    }
    const protagonistHits = findTerms(protagonist, protagonistLeakTerms);
    if (protagonistHits.length) {
      mismatches.push(`${label} 的 protagonist 混入原片表面身份或非用户设定身份：${protagonistHits.join("、")}`);
    }
    const visibleHits = findTerms(visibleStoryText, visibleLeakTerms);
    if (visibleHits.length) {
      mismatches.push(`${label} 的故事文本复用了禁止表面表达：${visibleHits.join("、")}`);
    }
  });
  if (mismatches.length) {
    throw new OutputContractError(`themeVariants 未锁定固定角色：${mismatches.join("；")}`);
  }
  return value;
}

export function ensureFullStoryMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null, visualGuardrails = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`fullStory.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  if (!fixedName) return value;

  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const sourceLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const positiveBoundaryTerms = collectPositivePromptBoundaryTerms(fixedProfile);
  const protagonistLeakTerms = [...new Set([...sourceLeakTerms, ...positiveBoundaryTerms])];
  const visibleLeakTerms = protagonistLeakTerms;
  const protagonist = value.characterBible?.protagonist || {};
  const protagonistText = JSON.stringify(protagonist);
  const fullText = JSON.stringify(value);
  const sceneText = JSON.stringify({
    title: value.title,
    oneLinePremise: value.oneLinePremise,
    shootingSynopsis: value.shootingSynopsis,
    beatSheet: value.beatSheet,
    sceneScript: value.sceneScript,
    keyProps: (value.keyProps || []).map((item) => ({
      prop: item?.prop,
      storyFunction: item?.storyFunction,
      visualUse: item?.visualUse
    }))
  });

  const mismatches = [];
  if (!protagonistText.includes(fixedName)) {
    mismatches.push(`characterBible.protagonist 未包含固定角色「${fixedName}」`);
  }
  if (!fullText.includes(fixedName)) {
    mismatches.push(`fullStory 未使用固定角色「${fixedName}」`);
  }
  const protagonistHits = findTerms(protagonistText, protagonistLeakTerms);
  if (protagonistHits.length) {
    mismatches.push(`主角设定混入原片表面身份或非用户设定身份：${protagonistHits.join("、")}`);
  }
  const visibleHits = findTerms(sceneText, visibleLeakTerms);
  if (visibleHits.length) {
    mismatches.push(`剧情文本复用了禁止表面表达：${visibleHits.join("、")}`);
  }
  if (mismatches.length) throw new OutputContractError(`fullStory 未锁定固定角色：${mismatches.join("；")}`);
  return value;
}

export function ensureAnimationPlanMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null, visualGuardrails = null, context = {}) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`animationPlan.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  const semanticContext = { ...context, creatorProfile, creativeBrief, variant, visualGuardrails };
  if (!fixedName) return ensureAnimationPlanNegativePrompts(value, semanticContext);

  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const sourceLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const positiveBoundaryTerms = collectPositivePromptBoundaryTerms(fixedProfile);
  const protagonistLeakTerms = [...new Set([...sourceLeakTerms, ...positiveBoundaryTerms])];
  const visibleLeakTerms = protagonistLeakTerms;
  const referenceFields = collectAnimationReferenceFields(value);
  const strictPositiveFields = collectAnimationStrictPositiveFields(value);
  const rulePositiveFields = collectAnimationRuleFields(value);
  const referenceText = referenceFields.map((field) => field.value).join("\n");
  const fullText = JSON.stringify(value);

  const mismatches = [];
  if (!referenceText.includes(fixedName)) {
    mismatches.push(`characterReferencePrompts 未包含固定角色「${fixedName}」`);
  }
  if (!fullText.includes(fixedName)) {
    mismatches.push(`animationPlan 未使用固定角色「${fixedName}」`);
  }
  const referenceHits = findFieldTermHits(referenceFields, protagonistLeakTerms);
  if (referenceHits.length) {
    mismatches.push(`角色参考提示词混入原片表面身份或非用户设定身份：${formatFieldTermHits(referenceHits)}`);
  }
  const positiveHits = [
    ...findFieldTermHits(strictPositiveFields, visibleLeakTerms),
    ...findFieldTermHits(rulePositiveFields, visibleLeakTerms, { allowNegativeContext: true })
  ];
  if (positiveHits.length) {
    mismatches.push(`正向画面提示词复用了禁止表面表达：${formatFieldTermHits(positiveHits)}`);
  }
  if (mismatches.length) throw new OutputContractError(`animationPlan 未锁定固定角色：${mismatches.join("；")}`);
  return ensureAnimationPlanNegativePrompts(value, semanticContext);
}

export function pruneAnimationPlanNegativePrompts(value, context = {}) {
  const plan = value && typeof value === "object" ? value : {};
  const sourceTerms = collectRenderSourceOnlyTerms(context);
  return {
    ...plan,
    shotPlan: (plan.shotPlan || []).map((shot, shotIndex) => {
      const negativePrompts = shot?.negativePrompts || {};
      const pruneMedia = (media) => (Array.isArray(negativePrompts[media]) ? negativePrompts[media] : [])
        .map((item) => normalizeNegativePromptItem(item))
        .map((item) => {
          if (!item) return null;
          const triggerEvidence = item.triggerEvidence.filter((entry) => isUsableNegativePromptEvidence(entry, {
            context,
            plan,
            shot,
            shotIndex,
            media,
            reasonCode: item.reasonCode
          }));
          const candidate = { ...item, triggerEvidence };
          return isNegativePromptCandidateRelevant(candidate, {
            context,
            plan,
            shot,
            shotIndex,
            media,
            sourceTerms
          }) ? candidate : null;
        })
        .filter(Boolean);
      return {
        ...shot,
        negativePrompts: {
          image: pruneMedia("image"),
          video: pruneMedia("video")
        }
      };
    })
  };
}

export function ensureAnimationPlanNegativePrompts(value, context = {}) {
  const sourceTerms = collectRenderSourceOnlyTerms(context);
  const duplicateSignatures = new Map();
  (value.shotPlan || []).forEach((shot, shotIndex) => {
    for (const media of ["image", "video"]) {
      const items = shot?.negativePrompts?.[media] || [];
      items.forEach((item, itemIndex) => {
        if (!isNegativePromptCandidateRelevant(item, {
          context,
          plan: value,
          shot,
          shotIndex,
          media,
          sourceTerms
        })) {
          throw new OutputContractError(`animationPlan.shotPlan[${shotIndex}].negativePrompts.${media}[${itemIndex}] 缺少与当前镜头直接相关的有效证据`);
        }
      });
    }
    const signature = negativePromptSignature(shot?.negativePrompts);
    if (!signature) return;
    const previous = duplicateSignatures.get(signature);
    if (previous) {
      throw new OutputContractError(`animationPlan 的 ${previous} 与 ${shot?.shotId || `shotPlan[${shotIndex}]`} 使用了完全相同的非空逐镜负面提示词数组`);
    }
    duplicateSignatures.set(signature, shot?.shotId || `shotPlan[${shotIndex}]`);
  });
  return value;
}

function normalizeNegativePromptItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return {
    ...item,
    text: String(item.text || "").trim(),
    triggerEvidence: Array.isArray(item.triggerEvidence)
      ? item.triggerEvidence
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          sourcePath: String(entry.sourcePath || "").trim(),
          evidence: String(entry.evidence || "").trim()
        }))
      : []
  };
}

function isNegativePromptCandidateRelevant(item, { context, plan, shot, shotIndex, media, sourceTerms }) {
  if (!item || !String(item.text || "").trim()) return false;
  if (!negativePromptMedia.has(item.appliesTo) || !negativePromptReasonCodes.has(item.reasonCode) || !negativePromptPriorities.has(item.priority)) return false;
  if (media === "image" && !["image", "both"].includes(item.appliesTo)) return false;
  if (media === "video" && !["video", "both"].includes(item.appliesTo)) return false;
  if (/咕嘎/u.test(item.text)) return false;

  const evidence = (item.triggerEvidence || []).filter((entry) => isUsableNegativePromptEvidence(entry, {
    context,
    plan,
    shot,
    shotIndex,
    media,
    reasonCode: item.reasonCode
  }));
  if (!evidence.length || isUnspecifiedFeatureEvidenceOnly(evidence, item.text)) return false;

  const actualReferenceUsed = hasActualVisualReference(context, shot, media);
  const sourceHits = findTerms(item.text, sourceTerms);
  if (item.reasonCode === "reference_leak" && !actualReferenceUsed) return false;
  if (sourceHits.length && (!actualReferenceUsed || item.reasonCode !== "reference_leak")) return false;

  const bodyHits = findTerms(item.text, bodySurfaceTerms);
  if (bodyHits.length && !bodyTermsHaveConcreteEvidence(bodyHits, evidence)) return false;
  if (bodyHits.some((term) => /爪|肉垫/u.test(term)) && !limbAnimalizationRiskIsProven(evidence, shot, context, media)) return false;

  return true;
}

function isUsableNegativePromptEvidence(entry, { context, plan, shot, shotIndex, media, reasonCode }) {
  const sourcePath = String(entry?.sourcePath || "").trim();
  const evidence = String(entry?.evidence || "").trim();
  if (!sourcePath || !evidence) return false;

  const shotMatch = sourcePath.match(/^animationPlan\.(?:shotPlan|shots)\[([^\]]+)\]\.(startFramePrompt|endFramePrompt|videoPrompt|characterAction)$/u);
  if (shotMatch) {
    const token = normalizeEvidencePathToken(shotMatch[1]);
    if (!evidenceShotTokenMatches(token, shot, shotIndex)) return false;
    return evidenceMatchesSourceValue(shot?.[shotMatch[2]], evidence);
  }

  const sceneMatch = sourcePath.match(/^fullStory\.sceneScript\[([^\]]+)\]\.(visibleAction|dialogue|shotAndSound|shootingNotes|location|characters)$/u);
  if (sceneMatch) {
    const token = normalizeEvidencePathToken(sceneMatch[1]);
    const scenes = Array.isArray(context.fullStory?.sceneScript) ? context.fullStory.sceneScript : [];
    const sceneIndex = /^\d+$/u.test(token) ? Number(token) : -1;
    const scene = sceneIndex >= 0
      ? scenes[sceneIndex]
      : scenes.find((item) => String(item?.sceneId || "") === token);
    if (!scene || !scene[sceneMatch[2]]) return false;
    if (shot?.sourceSceneId && String(shot.sourceSceneId) !== String(scene.sceneId || token)) return false;
    return evidenceMatchesSourceValue(scene[sceneMatch[2]], evidence);
  }

  if (sourcePath === "creatorProfile.fixedCharacter") {
    return evidenceMatchesSourceValue(context.creatorProfile?.fixedCharacter, evidence);
  }
  if (sourcePath === "creatorProfile.constraints") {
    return false;
  }
  const propMatch = sourcePath.match(/^fullStory\.keyProps\[([^\]]+)\]\.(prop|storyFunction|visualUse)$/u);
  if (propMatch) {
    const token = normalizeEvidencePathToken(propMatch[1]);
    const props = Array.isArray(context.fullStory?.keyProps) ? context.fullStory.keyProps : [];
    const prop = /^\d+$/u.test(token)
      ? props[Number(token)]
      : props.find((item) => String(item?.prop || "") === token);
    return evidenceMatchesSourceValue(prop?.[propMatch[2]], evidence) && shotContainsEvidenceSubject(shot, evidence);
  }
  const similarityMatch = sourcePath.match(/^visualGuardrails\.sourceSimilarityRules\[([^\]]+)\]\.(text|sourceExpression)$/u);
  if (similarityMatch) {
    const rules = Array.isArray(context.visualGuardrails?.sourceSimilarityRules) ? context.visualGuardrails.sourceSimilarityRules : [];
    const token = normalizeEvidencePathToken(similarityMatch[1]);
    const rule = /^\d+$/u.test(token) ? rules[Number(token)] : null;
    return reasonCode === "reference_leak"
      && hasActualVisualReference(context, shot, media)
      && evidenceMatchesSourceValue(rule?.[similarityMatch[2]], evidence);
  }
  if (isProviderFailureEvidencePath(sourcePath)) {
    return providerFailureValues(context).some((value) => evidenceMatchesSourceValue(value, evidence));
  }
  if (isActualReferenceEvidencePath(sourcePath)) {
    return hasActualVisualReference(context, shot, media)
      && actualReferenceValues(context, shot, media).some((value) => evidenceMatchesSourceValue(value, evidence));
  }
  return false;
}

function normalizeEvidencePathToken(value) {
  return String(value || "").trim().replace(/^["']|["']$/gu, "");
}

function evidenceShotTokenMatches(token, shot, shotIndex) {
  if (token === String(shotIndex)) return true;
  return token === String(shot?.shotId || "");
}

function evidenceMatchesSourceValue(sourceValue, evidence) {
  if (sourceValue === undefined || sourceValue === null) return false;
  const sourceText = typeof sourceValue === "string" ? sourceValue : JSON.stringify(sourceValue);
  const normalize = (text) => String(text || "")
    .toLocaleLowerCase()
    .replace(/[\s，,。；;：:！!？?、（）()【】\[\]「」『』“”"']/gu, "");
  const source = normalize(sourceText);
  const excerpt = normalize(evidence);
  return excerpt.length >= 2 && (source.includes(excerpt) || excerpt.includes(source));
}

function isUnspecifiedFeatureEvidenceOnly(evidence, text) {
  const hasUnspecifiedWording = /未声明|未提及|没有声明|没有提及|未设定|没有设定/u.test(String(text || ""))
    || evidence.some((entry) => /未声明|未提及|没有声明|没有提及|未设定|没有设定/u.test(entry.evidence));
  if (!hasUnspecifiedWording) return false;
  const hasConcreteIndependentEvidence = evidence.some((entry) => {
    const usesUnspecifiedWording = /未声明|未提及|没有声明|没有提及|未设定|没有设定/u.test(entry.evidence);
    if (!usesUnspecifiedWording) return true;
    if (entry.sourcePath === "creatorProfile.fixedCharacter") return false;
    const remainder = entry.evidence
      .replace(/用户|固定角色|角色|该特征|此特征|身体特征|外观特征/gu, "")
      .replace(/未声明|未提及|没有声明|没有提及|未设定|没有设定/gu, "")
      .replace(/[\s，,。；;：:！!？?、]/gu, "");
    return remainder.length >= 4 && /镜头|画面|动作|道具|接触|融合|混淆|漂移|变化|增殖|参考|失败|生成/u.test(remainder);
  });
  return !hasConcreteIndependentEvidence;
}

function collectRenderSourceOnlyTerms(context = {}) {
  const fixedProfile = String(context.creatorProfile?.fixedCharacter || "");
  const terms = new Set(["企鹅", "企鹅服"]);
  for (const term of collectProtectedTermsFromBrief(context.creativeBrief, fixedProfile)) terms.add(term);
  for (const rule of context.visualGuardrails?.sourceSimilarityRules || []) {
    const term = normalizeProtectedTerm(rule?.sourceExpression);
    if (term) terms.add(term);
  }
  return [...terms].filter((term) => term && !fixedProfile.includes(term));
}

function bodyTermsHaveConcreteEvidence(bodyHits, evidence) {
  const evidenceText = evidence.map((entry) => entry.evidence).join("\n");
  return bodyHits.every((term) => evidenceSupportsBodyTerm(term, evidenceText));
}

function evidenceSupportsBodyTerm(term, evidenceText) {
  if (String(evidenceText).includes(term)) return true;
  if (/爪|肉垫/u.test(term)) return /爪|肉垫/u.test(evidenceText);
  if (/尾/u.test(term)) return /尾/u.test(evidenceText);
  if (/鸟喙|鸟嘴/u.test(term)) return /鸟喙|鸟嘴/u.test(evidenceText);
  if (/脚蹼|蹼/u.test(term)) return /脚蹼|蹼/u.test(evidenceText);
  return false;
}

function limbAnimalizationRiskIsProven(evidence, shot, context, media) {
  const shotText = [shot?.startFramePrompt, shot?.endFramePrompt, shot?.videoPrompt, shot?.characterAction].filter(Boolean).join("\n");
  const explicitlyShowsLimbs = /手|手指|指尖|脚|足/u.test(shotText);
  const requestsHumanLimbs = /正常.{0,4}(?:人类)?(?:手|手指|脚|足)|人类(?:手|手指|脚|足)|五指/u.test(shotText);
  const provenFailure = evidence.some((entry) => isProviderFailureEvidencePath(entry.sourcePath)) && hasProviderFailureRecords(context);
  const referencePollution = evidence.some((entry) => isActualReferenceEvidencePath(entry.sourcePath) || /reference|参考|sourceSimilarityRules/u.test(entry.sourcePath))
    && hasActualVisualReference(context, shot, media);
  return explicitlyShowsLimbs && requestsHumanLimbs && (provenFailure || referencePollution);
}

function shotContainsEvidenceSubject(shot, evidence) {
  const shotText = [shot?.startFramePrompt, shot?.endFramePrompt, shot?.videoPrompt, shot?.characterAction].filter(Boolean).join("\n");
  if (!shotText) return false;
  const subjects = String(evidence || "").split(/[，,。；;：:\s、]/u).filter((part) => part.length >= 2);
  return subjects.some((part) => shotText.includes(part));
}

function isProviderFailureEvidencePath(sourcePath) {
  return /(?:provider|供应商).*(?:failure|失败)|(?:failure|失败).*(?:provider|供应商)|provenProviderFailure|generationFailures?/iu.test(sourcePath);
}

function hasProviderFailureRecords(context = {}) {
  return providerFailureValues(context).some(hasMeaningfulSignal);
}

function providerFailureValues(context = {}) {
  return [
    context.providerFailures,
    context.providerFailureRecords,
    context.generationFailures,
    context.provenProviderFailures
  ].filter(hasMeaningfulSignal);
}

function isActualReferenceEvidencePath(sourcePath) {
  return /actualReferenceInputs?|renderReferenceInputs?|referenceInputsUsed|providerRequest\.(?:images?|videos?|reference)/iu.test(sourcePath);
}

function hasActualVisualReference(context = {}, shot = {}, media = "") {
  const mediaReferences = context.actualReferenceInputs?.[media]
    || context.renderReferenceInputs?.[media]
    || context.referenceInputsUsed?.[media];
  return [
    context.actualReferenceUsed,
    context.referenceInputUsed,
    mediaReferences,
    context.actualReferenceInputs,
    context.renderReferenceInputs,
    context.referenceInputsUsed,
    context.referenceUsage,
    context.generationRequest?.referenceInputs,
    context.providerRequest?.referenceInputs,
    context.providerRequest?.images,
    context.providerRequest?.videos,
    shot?.actualReferenceInputs,
    shot?.renderReferenceInputs,
    shot?.referenceInputsUsed
  ].some(hasMeaningfulSignal);
}

function actualReferenceValues(context = {}, shot = {}, media = "") {
  const mediaReferences = context.actualReferenceInputs?.[media]
    || context.renderReferenceInputs?.[media]
    || context.referenceInputsUsed?.[media];
  return [
    mediaReferences,
    context.actualReferenceInputs,
    context.renderReferenceInputs,
    context.referenceInputsUsed,
    context.referenceUsage,
    context.generationRequest?.referenceInputs,
    context.providerRequest?.referenceInputs,
    context.providerRequest?.images,
    context.providerRequest?.videos,
    shot?.actualReferenceInputs,
    shot?.renderReferenceInputs,
    shot?.referenceInputsUsed
  ].filter(hasMeaningfulSignal);
}

function hasMeaningfulSignal(value) {
  if (value === true) return true;
  if (!value) return false;
  if (typeof value === "string") return Boolean(value.trim()) && !/^(?:false|none|null|not[_ -]?used|not[_ -]?supported|未使用|不支持|无)$/iu.test(value.trim());
  if (Array.isArray(value)) return value.some(hasMeaningfulSignal);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulSignal);
  return false;
}

function negativePromptSignature(negativePrompts = {}) {
  const normalize = (items) => (items || [])
    .map((item) => JSON.stringify({
      text: String(item?.text || "").trim(),
      appliesTo: item?.appliesTo,
      reasonCode: item?.reasonCode,
      priority: item?.priority,
      enabled: item?.enabled !== false,
      triggerEvidence: (item?.triggerEvidence || [])
        .map((entry) => ({ sourcePath: entry?.sourcePath || "", evidence: entry?.evidence || "" }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }))
    .sort();
  const image = normalize(negativePrompts.image);
  const video = normalize(negativePrompts.video);
  if (!image.length && !video.length) return "";
  return JSON.stringify({ image, video });
}

export function extractFixedCharacterName(fixedCharacter) {
  if (typeof fixedCharacter !== "string") return "";
  const text = fixedCharacter.trim();
  if (!text) return "";
  const explicit = text.match(/(?:角色名|姓名|名字|名叫|叫|昵称)[:：为是叫\s]*([一-龥A-Za-z0-9_-]{1,16})/u);
  if (explicit?.[1]) return stripNameWrapper(explicit[1]);
  const firstSegment = text.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || "";
  const spaceMatch = firstSegment.match(/^([一-龥A-Za-z0-9_-]{1,16})(?:\s|$)/u);
  return stripNameWrapper(spaceMatch?.[1] || firstSegment);
}

const sourceSurfaceIdentityTerms = [
  "一只", "企鹅", "企鹅服", "企鹅形象", "动物", "动物形象", "动物服", "玩偶", "玩偶服",
  "人偶", "人偶服", "兽装", "头套"
];

const bodyFeatureRules = [
  { label: "尾巴", terms: ["尾巴"], allowSignals: [/尾巴|有尾|带尾|尾部/u] },
  { label: "狼尾", terms: ["狼尾", "狼尾巴"], allowSignals: [/狼尾|狼尾巴|狼[^，,。；;\n]{0,6}尾巴/u] },
  { label: "猫尾", terms: ["猫尾", "猫尾巴"], allowSignals: [/猫尾|猫尾巴|猫[^，,。；;\n]{0,6}尾巴/u] },
  { label: "狐尾", terms: ["狐尾", "狐尾巴"], allowSignals: [/狐尾|狐尾巴|狐狸尾|狐狸尾巴|狐[^，,。；;\n]{0,6}尾巴/u] },
  { label: "兔尾", terms: ["兔尾", "兔尾巴"], allowSignals: [/兔尾|兔尾巴|兔[^，,。；;\n]{0,6}尾巴/u] },
  { label: "龙尾", terms: ["龙尾", "龙尾巴"], allowSignals: [/龙尾|龙尾巴|龙[^，,。；;\n]{0,6}尾巴/u] },
  { label: "翅膀", terms: ["翅膀"], allowSignals: [/翅膀|有翼|双翼|羽翼/u] },
  { label: "羽毛", terms: ["羽毛"], allowSignals: [/羽毛|羽饰/u] },
  { label: "爪子", terms: ["爪子"], allowSignals: [/爪子|小爪|爪部/u] },
  { label: "狼爪", terms: ["狼爪"], allowSignals: [/狼爪|狼[^，,。；;\n]{0,6}爪/u] },
  { label: "猫爪", terms: ["猫爪"], allowSignals: [/猫爪|猫[^，,。；;\n]{0,6}爪/u] },
  { label: "兽爪", terms: ["兽爪"], allowSignals: [/兽爪/u] },
  { label: "肉垫", terms: ["肉垫"], allowSignals: [/肉垫/u] },
  { label: "鸟喙", terms: ["鸟喙", "鸟嘴"], allowSignals: [/鸟喙|鸟嘴/u] },
  { label: "脚蹼", terms: ["脚蹼", "蹼"], allowSignals: [/脚蹼|蹼/u] },
  { label: "鳍", terms: ["鳍"], allowSignals: [/鳍/u] }
];

const bodySurfaceTerms = [...new Set(bodyFeatureRules.flatMap((rule) => rule.terms))];
const protagonistSurfaceTerms = [...sourceSurfaceIdentityTerms, ...bodySurfaceTerms];

const protectedTermStopWords = new Set([
  "台词", "视觉元素", "特定动作", "禁止", "直接使用", "高度相似", "表述", "形象", "服装", "动作", "约定", "一只", "动物"
]);

function validateNarrativeComponents(components) {
  const required = ["送达任务", "旅途结构", "情感媒介", "获得帮助", "被关爱对象", "天气或空间推动情绪", "生活化或仪式化结尾"];
  const present = new Set(components.map((item) => item?.component));
  const missing = required.filter((name) => !present.has(name));
  if (missing.length) throw new OutputContractError(`creativeBrief 未逐项评估可复用叙事构件：${missing.join("、")}`);
}

function validateProtectedExpressions(items) {
  items.forEach((item, index) => {
    const missing = ["expressionType", "sourceExpression", "prohibition", "safeAlternativePrinciple"].filter((key) => !(key in (item || {})));
    if (missing.length) {
      throw new OutputContractError(`creativeBrief.protectedExpressions 第 ${index + 1} 项缺少字段：${missing.join("、")}`);
    }
  });
}

export function collectProtectedTermsFromBrief(brief, fixedProfile = "") {
  if (!brief || typeof brief !== "object") return [];
  const terms = new Set();
  for (const item of brief.protectedExpressions || []) {
    const text = [item?.sourceExpression, item?.prohibition].filter(Boolean).join(" ");
    addProtectedTermVariants(terms, item?.sourceExpression, fixedProfile);
    for (const quoted of text.matchAll(/[“"「『']([^”"」』']{1,30})[”"」』']/gu)) {
      addProtectedTerm(terms, quoted[1], fixedProfile);
    }
    for (const surface of protagonistSurfaceTerms) {
      if (surface.length >= 2 && text.includes(surface)) addProtectedTerm(terms, surface, fixedProfile);
    }
  }
  for (const item of brief.controlledRewriteVariables || []) {
    if (!item?.mustChange) continue;
    addProtectedTermVariants(terms, item?.sourceValue, fixedProfile);
  }
  return [...terms];
}

export function collectForbiddenVisualTerms(brief, fixedProfile = "", visualGuardrails = null) {
  const terms = new Set(collectProtectedTermsFromBrief(brief, fixedProfile));
  for (const term of collectVisualGuardrailForbiddenTerms(visualGuardrails, fixedProfile)) terms.add(term);
  return [...terms].filter((term) => term && !isAllowedByFixedProfile(term, fixedProfile, visualGuardrails));
}

function collectPositivePromptBoundaryTerms(fixedProfile = "") {
  return incompatibleBodySurfaceTerms(fixedProfile);
}

export function collectVisualGuardrailForbiddenTerms(visualGuardrails, fixedProfile = "") {
  if (!visualGuardrails || typeof visualGuardrails !== "object") return [];
  const terms = new Set();
  for (const term of collectVisualGuardrailRawForbiddenTerms(visualGuardrails)) {
    if (!isAllowedByFixedProfile(term, fixedProfile, visualGuardrails)) terms.add(term);
  }
  return [...terms];
}

export function collectVisualGuardrailAllowedTerms(visualGuardrails, fixedProfile = "") {
  const terms = new Set(collectFixedCharacterVisualPolicy(fixedProfile).allowedBodyTerms);
  for (const item of visualGuardrails?.allowedPositiveTraits || []) {
    for (const term of extractGuardrailTerms(item)) terms.add(term);
  }
  return [...terms].filter(Boolean);
}

function collectVisualGuardrailRawForbiddenTerms(visualGuardrails) {
  const terms = new Set();
  for (const item of visualGuardrails?.sourceSimilarityRules || []) {
    for (const term of extractGuardrailTerms({ sourceExpression: item?.sourceExpression })) terms.add(term);
  }
  return [...terms];
}

function extractGuardrailTerms(item) {
  const values = typeof item === "string"
    ? [item]
    : [item?.term, item?.expression, item?.sourceExpression, item?.label].filter(Boolean);
  const terms = new Set();
  for (const value of values) addGuardrailTermVariants(terms, value);
  return [...terms];
}

function addGuardrailTermVariants(terms, raw) {
  const text = String(raw || "");
  addGuardrailTerm(terms, text);
  for (const quoted of text.matchAll(/[“"「『']([^”"」』']{1,30})[”"」』']/gu)) {
    addGuardrailTerm(terms, quoted[1]);
  }
  const expanded = text
    .replace(/(?:不要|禁止|避免|不得|不能|不可|勿|严禁)(?:出现|使用|写入|新增|自动新增|复用|继承)?/gu, "、")
    .replace(/[（）()【】\[\]《》<>]/gu, "、");
  for (const part of expanded.split(/[、，,；;／/|｜\s]+/u)) {
    addGuardrailTerm(terms, part);
  }
}

function addGuardrailTerm(terms, raw) {
  const normalized = normalizeProtectedTerm(raw)
    .replace(/^(?:不要|禁止|避免|不得|不能|不可|勿|严禁)(?:出现|使用|写入|新增|自动新增|复用|继承)?/u, "")
    .trim();
  if (!normalized || normalized.length < 2 || protectedTermStopWords.has(normalized)) return;
  terms.add(normalized);
}

function isAllowedByFixedProfile(term, fixedProfile = "", visualGuardrails = null) {
  const value = String(term || "");
  if (!value) return false;
  if (String(fixedProfile || "").includes(value)) return true;
  const allowed = new Set(collectVisualGuardrailAllowedTerms(visualGuardrails, fixedProfile));
  return allowed.has(value);
}

function collectAnimationReferenceFields(value = {}) {
  const fields = [];
  (value.characterReferencePrompts || []).forEach((item, index) => {
    pushField(fields, `characterReferencePrompts[${index}].characterName`, item?.characterName);
    pushField(fields, `characterReferencePrompts[${index}].storyRole`, item?.storyRole);
    pushField(fields, `characterReferencePrompts[${index}].identity`, item?.identity);
    pushField(fields, `characterReferencePrompts[${index}].appearancePrompt`, item?.appearancePrompt);
    pushArrayFields(fields, `characterReferencePrompts[${index}].consistencyTags`, item?.consistencyTags);
  });
  return fields;
}

function collectAnimationStrictPositiveFields(value = {}) {
  const fields = [];
  pushField(fields, "title", value.title);
  pushField(fields, "visualBible.overallStyle", value.visualBible?.overallStyle);
  pushField(fields, "visualBible.animationStyle", value.visualBible?.animationStyle);
  pushArrayFields(fields, "visualBible.colorPalette", value.visualBible?.colorPalette);
  pushField(fields, "visualBible.lighting", value.visualBible?.lighting);
  pushField(fields, "visualBible.cameraLanguage", value.visualBible?.cameraLanguage);
  (value.assetPrompts || []).forEach((item, index) => {
    pushField(fields, `assetPrompts[${index}].assetName`, item?.assetName);
    pushField(fields, `assetPrompts[${index}].storyFunction`, item?.storyFunction);
    pushField(fields, `assetPrompts[${index}].imagePrompt`, item?.imagePrompt);
    pushArrayFields(fields, `assetPrompts[${index}].consistencyTags`, item?.consistencyTags);
  });
  (value.sceneReferencePrompts || []).forEach((item, index) => {
    pushField(fields, `sceneReferencePrompts[${index}].sceneName`, item?.sceneName);
    pushField(fields, `sceneReferencePrompts[${index}].storyFunction`, item?.storyFunction);
    pushField(fields, `sceneReferencePrompts[${index}].environmentPrompt`, item?.environmentPrompt);
    pushArrayFields(fields, `sceneReferencePrompts[${index}].continuityAnchors`, item?.continuityAnchors);
  });
  (value.shotPlan || []).forEach((shot, index) => {
    pushField(fields, `shotPlan[${index}].startFramePrompt`, shot?.startFramePrompt);
    pushField(fields, `shotPlan[${index}].endFramePrompt`, shot?.endFramePrompt);
    pushField(fields, `shotPlan[${index}].videoPrompt`, shot?.videoPrompt);
    pushField(fields, `shotPlan[${index}].cameraMotion`, shot?.cameraMotion);
    pushField(fields, `shotPlan[${index}].characterAction`, shot?.characterAction);
  });
  return fields;
}

function collectAnimationRuleFields(value = {}) {
  const fields = [];
  pushArrayFields(fields, "visualBible.worldRules", value.visualBible?.worldRules);
  pushArrayFields(fields, "visualBible.characterConsistencyRules", value.visualBible?.characterConsistencyRules);
  (value.shotPlan || []).forEach((shot, index) => {
    pushField(fields, `shotPlan[${index}].storyPurpose`, shot?.storyPurpose);
    pushField(fields, `shotPlan[${index}].emotionalTarget`, shot?.emotionalTarget);
    pushField(fields, `shotPlan[${index}].continuityNotes`, shot?.continuityNotes);
  });
  return fields;
}

function pushArrayFields(fields, basePath, value) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => pushField(fields, `${basePath}[${index}]`, item));
  } else {
    pushField(fields, basePath, value);
  }
}

function pushField(fields, path, value) {
  if (value === undefined || value === null || value === "") return;
  fields.push({ path, value: String(value) });
}

function findFieldTermHits(fields, terms, { allowNegativeContext = false } = {}) {
  const hits = [];
  for (const field of fields || []) {
    for (const term of terms || []) {
      if (!term || !hasForbiddenOccurrence(field.value, term, { allowNegativeContext })) continue;
      hits.push({ term, path: field.path });
    }
  }
  return dedupeFieldTermHits(hits);
}

function hasForbiddenOccurrence(value, term, { allowNegativeContext = false } = {}) {
  const text = String(value || "");
  const needle = String(term || "");
  if (!needle) return false;
  let index = text.indexOf(needle);
  while (index !== -1) {
    if (!allowNegativeContext || !isNegatedTermOccurrence(text, index)) return true;
    index = text.indexOf(needle, index + needle.length);
  }
  return false;
}

function isNegatedTermOccurrence(text, index) {
  const before = text.slice(0, index);
  const segment = before.slice(Math.max(
    before.lastIndexOf("。"),
    before.lastIndexOf("！"),
    before.lastIndexOf("？"),
    before.lastIndexOf("；"),
    before.lastIndexOf(";"),
    before.lastIndexOf("，"),
    before.lastIndexOf(","),
    before.lastIndexOf("\n")
  ) + 1);
  return /(不要|禁止|避免|不得|不能|不可|勿|严禁|不应|不可以|不允许|切勿|杜绝|无|没有|不带|未出现|不出现)(?:出现|使用|写入|新增|自动新增|复用|继承|加入|添加|变成|带有|拥有|呈现|包含|有)?[^。！？；;，,\n]{0,24}$/u.test(segment);
}

function dedupeFieldTermHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.term}\u0000${hit.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatFieldTermHits(hits) {
  return hits.map((hit) => `${hit.term}（${hit.path}）`).join("、");
}

function addProtectedTermVariants(terms, raw, fixedProfile) {
  addProtectedTerm(terms, raw, fixedProfile);
  const text = String(raw || "");
  for (const quoted of text.matchAll(/[“"「『']([^”"」』']{1,30})[”"」』']/gu)) {
    addProtectedTerm(terms, quoted[1], fixedProfile);
  }
  const expanded = text.replace(/[（）()【】\[\]《》<>]/gu, "、");
  for (const part of expanded.split(/[、，,；;／/|｜\s]+/u)) {
    addProtectedTerm(terms, part, fixedProfile);
  }
}

function addProtectedTerm(terms, raw, fixedProfile) {
  const normalized = normalizeProtectedTerm(raw);
  if (!normalized || normalized.length < 2 || protectedTermStopWords.has(normalized) || fixedProfile.includes(normalized)) return;
  terms.add(normalized);
  for (const suffix of ["服", "服装", "形象", "外观"]) {
    if (normalized.endsWith(suffix)) {
      const base = normalized.slice(0, -suffix.length);
      if (base.length >= 2 && !fixedProfile.includes(base) && !protectedTermStopWords.has(base)) terms.add(base);
    }
  }
}

function incompatibleProtagonistSurfaceTerms(fixedProfile) {
  const incompatibleBodyTerms = new Set(incompatibleBodySurfaceTerms(fixedProfile));
  return [
    ...sourceSurfaceIdentityTerms.filter((term) => term.length >= 2 && !fixedProfile.includes(term)),
    ...bodySurfaceTerms.filter((term) => term.length >= 2 && incompatibleBodyTerms.has(term))
  ];
}

function incompatibleBodySurfaceTerms(fixedProfile) {
  return collectFixedCharacterVisualPolicy(fixedProfile).forbiddenBodyTerms;
}

export function collectFixedCharacterVisualPolicy(fixedCharacter = "") {
  const fixedProfile = String(fixedCharacter || "");
  const allowedBodyTerms = new Set();
  const forbiddenBodyTerms = new Set();
  for (const rule of bodyFeatureRules) {
    const allowed = rule.allowSignals.some((signal) => signal.test(fixedProfile));
    for (const term of rule.terms) {
      if (allowed || fixedProfile.includes(term)) {
        allowedBodyTerms.add(term);
      } else {
        forbiddenBodyTerms.add(term);
      }
    }
  }
  for (const term of allowedBodyTerms) forbiddenBodyTerms.delete(term);
  return {
    allowedBodyTerms: [...allowedBodyTerms],
    forbiddenBodyTerms: [...forbiddenBodyTerms]
  };
}

export function fixedCharacterVisualPolicyText(fixedCharacter = "") {
  const fixedProfile = String(fixedCharacter || "");
  const { allowedBodyTerms } = collectFixedCharacterVisualPolicy(fixedProfile);
  const hasEarOnlySignal = /[狼猫狐兔]耳|兽耳/u.test(fixedProfile);
  const allowedText = allowedBodyTerms.length ? allowedBodyTerms.join("、") : "无额外动物化身体特征";
  const earNote = hasEarOnlySignal
    ? "耳朵类设定只授权用户写明的耳朵表现，不代表可以扩展其他身体结构。"
    : "任何额外身体特征都必须由固定角色文本明确授权后才可写入正向提示词。";
  return `允许正向使用的身体特征：${allowedText}。未授权信息保持不写，不得据此生成渲染负面提示词。${earNote}`;
}

function assertNoTerms(text, terms, label) {
  const hits = findTerms(text, terms);
  if (hits.length) throw new OutputContractError(`${label} 复用了禁止表面表达或非用户设定身份：${hits.join("、")}`);
}

function findTerms(text, terms) {
  const value = String(text || "");
  return [...new Set((terms || []).filter((term) => term && value.includes(term)))];
}

function normalizeProtectedTerm(value) {
  return String(value || "")
    .trim()
    .replace(/^[「『“”"'《<【\[\s]+/u, "")
    .replace(/[」』“”"'》>】\]\s]+$/u, "")
    .replace(/[~～。.!！?？、，,；;：:\s]+$/u, "")
    .trim();
}

function stripNameWrapper(value) {
  return String(value || "")
    .trim()
    .replace(/^[「『“”"'\s]+/u, "")
    .replace(/[」』“”"'\s]+$/u, "");
}
