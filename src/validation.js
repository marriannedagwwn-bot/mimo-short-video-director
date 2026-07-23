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
  referenceAnalysis: ["contentPositioning", "targetAudience", "storySynopsis", "characters", "protagonistIdentity", "careRecipient", "dialogueStyle", "shotRhythm", "emotionCurve", "retentionDrivers", "whyWatchToEnd", "analysisConfidence", "observedFacts", "uncertainties"],
  sourceScriptReconstruction: ["scenes", "coreEventSequence", "relationshipPattern", "endingAction", "turningPoints", "uncertainties"],
  creativeBrief: ["contentType", "targetAudience", "coreEmotion", "storyEngine", "emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents", "nonNegotiableExperience", "creativeDistancePolicy"],
  visualGuardrails: ["fixedCharacterBoundary", "allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "stageInstructions", "rationale", "uncertainties"],
  themeVariants: ["variants"],
  fullStory: ["selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis", "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide", "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"],
  animationPlan: ["selectedVariantId", "title", "productionStrategy", "visualBible", "characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "shotPlan", "editPlan", "generationChecklist", "modelAgnosticNotes", "continuityAndSafetyCheck", "uncertainties"]
};

const animationFoundationFields = outputContracts.animationPlan.filter((field) => field !== "shotPlan");
const animationShotFields = [
  "shotId",
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "startFramePrompt",
  "endFramePrompt",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes",
  "negativePrompts",
  "acceptanceCriteria"
];

const animationPromptSchemaVersion = "2.0";
const animationV2ShotFields = [
  "shotId",
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "startFrame",
  "endFrame",
  "motion",
  "negativePrompts",
  "acceptanceCriteria"
];
const animationFrameFields = [
  "timeAndWeather",
  "characters",
  "environment",
  "camera",
  "lighting",
  "styleModifiers",
  "continuityLocks"
];
const animationFrameCharacterFields = [
  "name",
  "screenPosition",
  "bodyOrientation",
  "pose",
  "actionState",
  "handPropState",
  "gaze",
  "emotionState",
  "expression"
];
const animationFrameEnvironmentFields = ["sceneId", "foreground", "midground", "background", "atmosphere"];
const animationFrameCameraFields = ["shotSize", "height", "angle", "viewDirection", "lensFeel", "depthOfField", "composition"];
const animationFrameLightingFields = ["source", "direction", "colorAndContrast"];
const animationMotionFields = [
  "mode",
  "primaryAction",
  "cameraMove",
  "emotionArc",
  "environmentChange",
  "lightingChange",
  "timingBeats",
  "audio",
  "preserve",
  "endStateRef",
  "stopCondition",
  "postRetime"
];
const animationMotionModes = new Set(["continuous_action", "camera_move", "object_transform", "loop"]);
const animationCameraMoveModes = new Set(["locked", "continuous"]);
const animationCameraMoveSpeeds = new Set(["slow", "medium", "fast"]);
const animationAliasFields = [
  "startFramePrompt",
  "endFramePrompt",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes"
];

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
    referenceAnalysis: ["characters", "emotionCurve", "retentionDrivers", "observedFacts", "uncertainties"],
    sourceScriptReconstruction: ["scenes", "coreEventSequence", "turningPoints", "uncertainties"],
    creativeBrief: ["emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents"],
    visualGuardrails: ["allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "uncertainties"],
    themeVariants: ["variants"],
    fullStory: ["beatSheet", "sceneScript", "keyProps", "shootingPlan", "retentionPlan", "uncertainties"],
    animationPlan: ["characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "shotPlan", "generationChecklist", "modelAgnosticNotes", "uncertainties"]
  }[contract] || [];
  const wrongArrays = arrayFields.filter((key) => !Array.isArray(value[key]));
  if (wrongArrays.length) throw new OutputContractError(`${contract} 字段类型无效：${wrongArrays.join("、")} 必须是数组`);
  if (contract === "sourceScriptReconstruction") validateSourceScriptReconstructionContract(value);
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
    ensureAnimationPlanV2Contract(value);
    validateAnimationPlanNegativePromptContract(value);
  }
  return value;
}

function validateSourceScriptReconstructionContract(value) {
  if (value.scenes.length < 1) throw new OutputContractError("sourceScriptReconstruction 至少需要一个分场");
  if (typeof value.relationshipPattern !== "string") {
    throw new OutputContractError("sourceScriptReconstruction.relationshipPattern 必须是字符串");
  }
  if (!value.endingAction || typeof value.endingAction !== "object" || Array.isArray(value.endingAction)) {
    throw new OutputContractError("sourceScriptReconstruction.endingAction 必须是对象");
  }
  requireContractFields(value.endingAction, ["action", "emotionalMeaning", "evidence"], "sourceScriptReconstruction.endingAction");
  if (!Array.isArray(value.endingAction.evidence)) {
    throw new OutputContractError("sourceScriptReconstruction.endingAction.evidence 必须是数组");
  }

  value.scenes.forEach((scene, index) => {
    const path = `sourceScriptReconstruction.scenes[${index}]`;
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new OutputContractError(`${path} 必须是对象`);
    }
    requireContractFields(scene, [
      "sceneId",
      "timeRange",
      "location",
      "characters",
      "visibleActions",
      "dialogueGist",
      "shotDesign",
      "emotionNode",
      "dramaticFunction",
      "turningPoint",
      "keyProps",
      "sourceEvidence",
      "confidence"
    ], path);
    const arrays = ["characters", "visibleActions", "shotDesign", "keyProps", "sourceEvidence"];
    const wrong = arrays.filter((field) => !Array.isArray(scene[field]));
    if (wrong.length) throw new OutputContractError(`${path} 字段类型无效：${wrong.join("、")} 必须是数组`);
    const confidence = Number(scene.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new OutputContractError(`${path}.confidence 必须是 0-100`);
    }
  });
}

function requireContractFields(value, fields, path) {
  const missing = fields.filter((field) => !(field in value));
  if (missing.length) throw new OutputContractError(`${path} 缺少必要字段：${missing.join("、")}`);
}

/**
 * Validate the private first phase of animation generation. The public
 * animationPlan contract stays unchanged; this object is only merged on the
 * server with validated shot batches.
 */
export function ensureAnimationFoundationContract(value, { sourceSceneIds = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError("animationFoundation 必须是对象");
  }
  const missing = [...animationFoundationFields, "promptSchemaVersion"].filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new OutputContractError(`animationFoundation 缺少必要字段：${missing.join("、")}`);
  const unexpected = Object.keys(value).filter((key) => ![...animationFoundationFields, "promptSchemaVersion"].includes(key));
  if (unexpected.length) throw new OutputContractError(`animationFoundation 包含未允许的顶层字段：${unexpected.join("、")}`);
  ensureAnimationPromptSchemaVersion(value.promptSchemaVersion, "animationFoundation.promptSchemaVersion");

  for (const field of ["characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "generationChecklist", "modelAgnosticNotes", "uncertainties"]) {
    if (!Array.isArray(value[field])) throw new OutputContractError(`animationFoundation.${field} 必须是数组`);
  }
  if (!value.characterReferencePrompts.length) throw new OutputContractError("animationFoundation 至少需要一个角色参考提示词");
  if (!value.sceneReferencePrompts.length) throw new OutputContractError("animationFoundation 至少需要一个场景参考提示词");
  ensureUniqueNonEmptyField(value.sceneReferencePrompts, "sceneId", "animationFoundation.sceneReferencePrompts");
  const mappedSourceScenes = new Map();
  value.sceneReferencePrompts.forEach((scene, index) => {
    if (!Array.isArray(scene?.relatedShotIds)) {
      throw new OutputContractError(`animationFoundation.sceneReferencePrompts[${index}].relatedShotIds 必须是数组`);
    }
    if (scene.relatedShotIds.length) {
      throw new OutputContractError(`animationFoundation.sceneReferencePrompts[${index}].relatedShotIds 在镜头生成前必须为空数组`);
    }
    if (!Array.isArray(scene?.sourceSceneIds) || !scene.sourceSceneIds.length) {
      throw new OutputContractError(`animationFoundation.sceneReferencePrompts[${index}].sourceSceneIds 至少需要一个剧情场次`);
    }
    scene.sourceSceneIds.forEach((sourceSceneId, sourceIndex) => {
      const normalized = String(sourceSceneId || "").trim();
      if (!normalized) {
        throw new OutputContractError(`animationFoundation.sceneReferencePrompts[${index}].sourceSceneIds[${sourceIndex}] 不能为空`);
      }
      if (mappedSourceScenes.has(normalized)) {
        throw new OutputContractError(`animationFoundation.sourceSceneIds 不能重复映射：${normalized}`);
      }
      mappedSourceScenes.set(normalized, scene.sceneId);
    });
  });
  const expectedSourceScenes = [...new Set(sourceSceneIds.map((item) => String(item || "").trim()).filter(Boolean))];
  if (expectedSourceScenes.length) {
    const unknown = [...mappedSourceScenes.keys()].filter((sceneId) => !expectedSourceScenes.includes(sceneId));
    if (unknown.length) throw new OutputContractError(`animationFoundation.sourceSceneIds 包含未知剧情场次：${unknown.join("、")}`);
    const missing = expectedSourceScenes.filter((sceneId) => !mappedSourceScenes.has(sceneId));
    if (missing.length) throw new OutputContractError(`animationFoundation.sourceSceneIds 未覆盖剧情场次：${missing.join("、")}`);
  }
  validateAnimationPlanNegativePromptContract({
    visualBible: value.visualBible,
    sceneReferencePrompts: value.sceneReferencePrompts,
    shotPlan: []
  });
  return value;
}

/** Validate one private shot-only response before it is merged. */
export function ensureAnimationShotBatchContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError("animationShotBatch 必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "shotPlan");
  if (unexpected.length) throw new OutputContractError(`animationShotBatch 只允许 shotPlan 顶层字段，收到：${unexpected.join("、")}`);
  if (!Array.isArray(value.shotPlan)) throw new OutputContractError("animationShotBatch.shotPlan 必须是数组");
  if (!value.shotPlan.length) throw new OutputContractError("animationShotBatch 至少需要一个镜头");
  const isV2 = value.shotPlan.some(hasStructuredAnimationShotFields);
  ensureUniqueNonEmptyField(value.shotPlan, "shotId", "animationShotBatch.shotPlan");
  value.shotPlan.forEach((shot, index) => {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}] 必须是对象`);
    }
    const requiredFields = isV2 ? animationV2ShotFields : animationShotFields;
    const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(shot, field));
    if (missing.length) throw new OutputContractError(`animationShotBatch.shotPlan[${index}] 缺少字段：${missing.join("、")}`);
    const requiredTextFields = isV2
      ? ["shotId", "sourceSceneId", "sceneId", "storyPurpose", "emotionalTarget"]
      : ["shotId", "sourceSceneId", "sceneId", "startFramePrompt", "endFramePrompt", "videoPrompt", "characterAction"];
    for (const field of requiredTextFields) {
      if (!String(shot[field] || "").trim()) throw new OutputContractError(`animationShotBatch.shotPlan[${index}].${field} 不能为空`);
    }
    const duration = Number(shot.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}].durationSeconds 必须是正数`);
    }
    if (!Array.isArray(shot.acceptanceCriteria)) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}].acceptanceCriteria 必须是数组`);
    }
  });
  if (isV2) ensureAnimationPlanV2Contract(value, { path: "animationShotBatch", allowVersionlessStructured: true });
  validateAnimationPlanNegativePromptContract({ visualBible: {}, sceneReferencePrompts: [], shotPlan: value.shotPlan });
  return value;
}

/**
 * Validate the structured animation prompt contract without importing the
 * compiler. Legacy containers (no version and no structured shots) pass
 * through unchanged. A compile hook may be supplied by workflow/compiler code
 * to additionally prove that all legacy UI aliases are deterministic.
 */
export function ensureAnimationPlanV2Contract(value, {
  compileShotPrompts,
  path = "animationPlan",
  allowVersionlessStructured = false
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError(`${path} 必须是对象`);
  }
  const isV2 = detectAnimationV2Container(value, path, { allowVersionlessStructured });
  if (!isV2) return value;
  if (!Array.isArray(value.shotPlan)) throw new OutputContractError(`${path}.shotPlan 必须是数组`);
  value.shotPlan.forEach((shot, index) => {
    const shotPath = `${path}.shotPlan[${index}]`;
    ensureAnimationShotV2Contract(shot, shotPath);
    if (compileShotPrompts !== undefined) {
      if (typeof compileShotPrompts !== "function") {
        throw new OutputContractError(`${path} 的 compileShotPrompts 必须是函数`);
      }
      const compiledAliases = compileShotPrompts(shot);
      if (compiledAliases && typeof compiledAliases.then === "function") {
        throw new OutputContractError(`${path} 的 compileShotPrompts 必须同步返回别名对象`);
      }
      ensureAnimationShotPromptAliases(shot, compiledAliases, shotPath);
    }
  });
  return value;
}

/** Validate one approved v2 structured shot. */
export function ensureAnimationShotV2Contract(shot, path = "animationPlan.shotPlan[0]") {
  if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
    throw new OutputContractError(`${path} 必须是对象`);
  }
  const missing = animationV2ShotFields.filter((field) => !Object.prototype.hasOwnProperty.call(shot, field));
  if (missing.length) throw new OutputContractError(`${path} 缺少 v2 字段：${missing.join("、")}`);
  for (const field of ["shotId", "sourceSceneId", "sceneId", "storyPurpose", "emotionalTarget"]) {
    requireNonEmptyContractString(shot[field], `${path}.${field}`);
  }
  const duration = Number(shot.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new OutputContractError(`${path}.durationSeconds 必须是正数`);

  validateAnimationFrameV2(shot.startFrame, `${path}.startFrame`, shot.sceneId);
  validateAnimationFrameV2(shot.endFrame, `${path}.endFrame`, shot.sceneId);
  validateAnimationMotionV2(shot.motion, `${path}.motion`, shot.startFrame, shot.endFrame);
  return shot;
}

/**
 * Compiler integration hook. The caller compiles a shot, merges the aliases,
 * then passes the compiler result here; validation itself stays dependency
 * free and therefore cannot introduce a compiler/validation import cycle.
 */
export function ensureAnimationShotPromptAliases(shot, compiledAliases, path = "animationPlan.shotPlan[0]") {
  if (!compiledAliases || typeof compiledAliases !== "object" || Array.isArray(compiledAliases)) {
    throw new OutputContractError(`${path} 的编译结果必须是对象`);
  }
  for (const field of animationAliasFields) {
    if (!Object.prototype.hasOwnProperty.call(compiledAliases, field)) {
      throw new OutputContractError(`${path} 的编译结果缺少别名 ${field}`);
    }
    if (!Object.prototype.hasOwnProperty.call(shot, field)) {
      throw new OutputContractError(`${path} 缺少已编译别名 ${field}`);
    }
    if (shot[field] !== compiledAliases[field]) {
      throw new OutputContractError(`${path}.${field} 与结构化 prompt 的编译结果不一致`);
    }
  }
  return shot;
}

function detectAnimationV2Container(value, path, { allowVersionlessStructured = false } = {}) {
  const hasVersion = Object.prototype.hasOwnProperty.call(value, "promptSchemaVersion");
  const shots = Array.isArray(value.shotPlan) ? value.shotPlan : [];
  const hasStructuredShots = shots.some(hasStructuredAnimationShotFields);
  if (hasVersion) ensureAnimationPromptSchemaVersion(value.promptSchemaVersion, `${path}.promptSchemaVersion`);
  if (hasStructuredShots && !hasVersion && !allowVersionlessStructured) {
    throw new OutputContractError(`${path}.promptSchemaVersion 缺失；结构化镜头必须声明 ${animationPromptSchemaVersion}`);
  }
  return hasVersion || hasStructuredShots;
}

function hasStructuredAnimationShotFields(shot) {
  return Boolean(shot && typeof shot === "object" && !Array.isArray(shot)
    && ["startFrame", "endFrame", "motion"].some((field) => Object.prototype.hasOwnProperty.call(shot, field)));
}

function ensureAnimationPromptSchemaVersion(value, path) {
  if (value !== animationPromptSchemaVersion) {
    throw new OutputContractError(`${path} 必须严格等于 "${animationPromptSchemaVersion}"`);
  }
}

function validateAnimationFrameV2(frame, path, shotSceneId) {
  requireExactContractObject(frame, path, animationFrameFields);
  requireNonEmptyContractString(frame.timeAndWeather, `${path}.timeAndWeather`);
  if (!Array.isArray(frame.characters)) throw new OutputContractError(`${path}.characters 必须是数组`);
  const characterNames = new Set();
  frame.characters.forEach((character, index) => {
    const characterPath = `${path}.characters[${index}]`;
    requireExactContractObject(character, characterPath, animationFrameCharacterFields);
    animationFrameCharacterFields.forEach((field) => requireNonEmptyContractString(character[field], `${characterPath}.${field}`));
    const normalizedName = character.name.trim();
    if (characterNames.has(normalizedName)) throw new OutputContractError(`${path}.characters 角色名不能重复：${normalizedName}`);
    characterNames.add(normalizedName);
  });

  requireExactContractObject(frame.environment, `${path}.environment`, animationFrameEnvironmentFields);
  animationFrameEnvironmentFields.forEach((field) => requireNonEmptyContractString(frame.environment[field], `${path}.environment.${field}`));
  if (frame.environment.sceneId !== shotSceneId) {
    throw new OutputContractError(`${path}.environment.sceneId 必须与镜头 sceneId ${shotSceneId} 完全一致`);
  }

  requireExactContractObject(frame.camera, `${path}.camera`, animationFrameCameraFields);
  animationFrameCameraFields.forEach((field) => requireNonEmptyContractString(frame.camera[field], `${path}.camera.${field}`));
  requireExactContractObject(frame.lighting, `${path}.lighting`, animationFrameLightingFields);
  animationFrameLightingFields.forEach((field) => requireNonEmptyContractString(frame.lighting[field], `${path}.lighting.${field}`));
  validateContractStringArray(frame.styleModifiers, `${path}.styleModifiers`);
  validateContractStringArray(frame.continuityLocks, `${path}.continuityLocks`);
  validateStaticAnimationFrame(frame, path);
}

function validateAnimationMotionV2(motion, path, startFrame, endFrame) {
  requireExactContractObject(motion, path, animationMotionFields);
  if (!animationMotionModes.has(motion.mode)) {
    throw new OutputContractError(`${path}.mode 只允许 continuous_action、camera_move、object_transform 或 loop`);
  }
  requireNonEmptyContractString(motion.primaryAction, `${path}.primaryAction`);

  requireExactContractObject(motion.cameraMove, `${path}.cameraMove`, ["mode", "technique", "path", "speed", "motivation"]);
  if (!animationCameraMoveModes.has(motion.cameraMove.mode)) {
    throw new OutputContractError(`${path}.cameraMove.mode 只允许 locked 或 continuous`);
  }
  if (!animationCameraMoveSpeeds.has(motion.cameraMove.speed)) {
    throw new OutputContractError(`${path}.cameraMove.speed 只允许 slow、medium 或 fast`);
  }
  for (const field of ["technique", "path", "motivation"]) {
    requireNonEmptyContractString(motion.cameraMove[field], `${path}.cameraMove.${field}`);
  }
  if (motion.cameraMove.mode === "locked") {
    assertCameraCoreEquality(startFrame.camera, endFrame.camera, path);
  }

  requireExactContractObject(motion.emotionArc, `${path}.emotionArc`, ["from", "visibleProgression", "to"]);
  for (const field of ["from", "visibleProgression", "to"]) {
    requireNonEmptyContractString(motion.emotionArc[field], `${path}.emotionArc.${field}`);
  }
  validateEmotionEndpoints(motion.emotionArc, startFrame, endFrame, path);

  requireNonEmptyContractString(motion.environmentChange, `${path}.environmentChange`);
  requireNonEmptyContractString(motion.lightingChange, `${path}.lightingChange`);
  validateAnimationTimingBeats(motion.timingBeats, `${path}.timingBeats`);
  validateAnimationAudio(motion.audio, `${path}.audio`);
  validateContractStringArray(motion.preserve, `${path}.preserve`);
  if (motion.endStateRef !== "endFrame") throw new OutputContractError(`${path}.endStateRef 必须严格等于 "endFrame"`);
  requireNonEmptyContractString(motion.stopCondition, `${path}.stopCondition`);

  requireExactContractObject(motion.postRetime, `${path}.postRetime`, ["recommended", "speedCurve", "reason"]);
  if (typeof motion.postRetime.recommended !== "boolean") {
    throw new OutputContractError(`${path}.postRetime.recommended 必须是布尔值`);
  }
  requireContractString(motion.postRetime.speedCurve, `${path}.postRetime.speedCurve`);
  requireContractString(motion.postRetime.reason, `${path}.postRetime.reason`);
  if (motion.postRetime.recommended) {
    requireNonEmptyContractString(motion.postRetime.speedCurve, `${path}.postRetime.speedCurve`);
    requireNonEmptyContractString(motion.postRetime.reason, `${path}.postRetime.reason`);
  }

  if (motion.mode === "loop") {
    validateLoopEndpointCompatibility(startFrame, endFrame, motion, path);
  } else {
    validateNormalShotHasNoCutOrLocationJump(motion, path);
  }
}

function validateAnimationTimingBeats(beats, path) {
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > 4) {
    throw new OutputContractError(`${path} 必须包含 1–4 个连续节拍`);
  }
  let expectedFrom = 0;
  beats.forEach((beat, index) => {
    const beatPath = `${path}[${index}]`;
    requireExactContractObject(beat, beatPath, ["fromPercent", "toPercent", "action", "camera", "emotion", "environment", "soundCue"]);
    const from = beat.fromPercent;
    const to = beat.toPercent;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new OutputContractError(`${beatPath}.fromPercent 和 toPercent 必须是数字`);
    }
    if (from < 0 || to > 100 || from >= to) {
      throw new OutputContractError(`${beatPath} 必须满足 0 <= fromPercent < toPercent <= 100`);
    }
    if (!percentEquals(from, expectedFrom)) {
      throw new OutputContractError(`${beatPath}.fromPercent 必须与上一节拍无缝相接于 ${expectedFrom}`);
    }
    for (const field of ["action", "camera", "emotion", "environment"]) {
      requireNonEmptyContractString(beat[field], `${beatPath}.${field}`);
    }
    requireContractString(beat.soundCue, `${beatPath}.soundCue`);
    expectedFrom = to;
  });
  if (!percentEquals(expectedFrom, 100)) throw new OutputContractError(`${path} 必须连续覆盖 0..100，末节拍必须结束于 100`);
}

function validateAnimationAudio(audio, path) {
  requireExactContractObject(audio, path, ["dialogue", "ambience", "soundEffects", "musicCue"]);
  if (!Array.isArray(audio.dialogue)) throw new OutputContractError(`${path}.dialogue 必须是数组`);
  audio.dialogue.forEach((line, index) => {
    const linePath = `${path}.dialogue[${index}]`;
    requireExactContractObject(line, linePath, ["speaker", "text", "delivery"]);
    for (const field of ["speaker", "text", "delivery"]) requireNonEmptyContractString(line[field], `${linePath}.${field}`);
  });
  requireContractString(audio.ambience, `${path}.ambience`);
  validateContractStringArray(audio.soundEffects, `${path}.soundEffects`);
  requireContractString(audio.musicCue, `${path}.musicCue`);
}

function validateEmotionEndpoints(emotionArc, startFrame, endFrame, path) {
  const primary = startFrame.characters[0];
  if (!primary) return;
  const endCharacter = endFrame.characters.find((character) => character.name === primary.name);
  if (!endCharacter) {
    throw new OutputContractError(`${path}.emotionArc 无法在 endFrame 找到主角色「${primary.name}」`);
  }
  if (emotionArc.from !== primary.emotionState) {
    throw new OutputContractError(`${path}.emotionArc.from 必须等于 startFrame 主角色 emotionState`);
  }
  if (emotionArc.to !== endCharacter.emotionState) {
    throw new OutputContractError(`${path}.emotionArc.to 必须等于 endFrame 主角色 emotionState`);
  }
}

function validateStaticAnimationFrame(frame, path) {
  const fields = [];
  collectStructuredFramePositiveFields(fields, path, frame);
  const processOrAudioTerms = ["逐渐", "随后", "然后", "镜头移动", "运镜", "对白", "音效"];
  for (const field of fields) {
    const hit = processOrAudioTerms.find((term) => hasStaticFrameLintOccurrence(field.value, term));
    if (hit) {
      throw new OutputContractError(`${field.path} 是静态帧字段，不得包含过程、运镜、对白或音效措辞：${hit}`);
    }
  }
}

function hasStaticFrameLintOccurrence(value, term) {
  const text = String(value || "");
  if (["随后", "然后"].includes(term)) {
    return new RegExp(`(?:^|[\\s，,。；;！!？?])${term}`, "u").test(text);
  }
  return hasForbiddenOccurrence(text, term, { allowNegativeContext: true });
}

function assertCameraCoreEquality(startCamera, endCamera, path) {
  const changed = animationFrameCameraFields.filter((field) => startCamera[field] !== endCamera[field]);
  if (changed.length) {
    throw new OutputContractError(`${path}.cameraMove.mode=locked 时首尾 camera 核心必须完全相等；变化字段：${changed.join("、")}`);
  }
}

function validateLoopEndpointCompatibility(startFrame, endFrame, motion, path) {
  if (!/(?:回到|回归|恢复|闭环|循环|首帧|起始|初始|start\s*frame)/iu.test(motion.stopCondition)) {
    throw new OutputContractError(`${path}.stopCondition 必须明确循环回到起始/首帧状态后停止`);
  }
  if (startFrame.environment.sceneId !== endFrame.environment.sceneId) {
    throw new OutputContractError(`${path} 循环镜头首尾 environment.sceneId 必须相同`);
  }
  assertCameraCoreEquality(startFrame.camera, endFrame.camera, path);

  const startNames = startFrame.characters.map((character) => character.name).sort();
  const endNames = endFrame.characters.map((character) => character.name).sort();
  if (JSON.stringify(startNames) !== JSON.stringify(endNames)) {
    throw new OutputContractError(`${path} 循环镜头首尾角色名单必须一致`);
  }
  startFrame.characters.forEach((startCharacter) => {
    const endCharacter = endFrame.characters.find((character) => character.name === startCharacter.name);
    const changed = animationFrameCharacterFields.filter((field) => startCharacter[field] !== endCharacter[field]);
    if (changed.length) {
      throw new OutputContractError(`${path} 循环镜头角色「${startCharacter.name}」首尾状态不兼容：${changed.join("、")}`);
    }
  });
}

function validateNormalShotHasNoCutOrLocationJump(motion, path) {
  const fields = collectMotionVisualContinuityFields(motion, path);
  const prohibitedTerms = [
    "切镜",
    "转场",
    "跳切",
    "硬切",
    "镜头切换",
    "画面切换",
    "场景切换",
    "地点切换",
    "镜头切到",
    "画面切到",
    "换景",
    "地点跳转",
    "场景跳转",
    "场景突变",
    "地点突变",
    "跳转到另一",
    "跳转到下一个",
    "瞬移到",
    "切到另一地点",
    "切到另一个地点",
    "切到下一地点",
    "切到另一场景",
    "切到另一个场景",
    "切到下一场景",
    "切至另一地点",
    "切至另一个地点",
    "切至另一场景",
    "切至另一个场景",
    "换到另一地点",
    "换到另一个地点",
    "换到另一场景",
    "换到另一个场景",
    "跳到另一地点",
    "跳到另一个地点",
    "跳到另一场景",
    "跳到另一个场景",
    "跳到下一场景",
    "转至另一地点",
    "转至另一个地点",
    "转至另一场景",
    "转至另一个场景"
  ];
  for (const field of fields) {
    const hit = prohibitedTerms.find((term) => hasPositiveContinuityTerm(field.value, term));
    const englishCut = /\b(?:cut\s+to|jump\s+cut|smash\s+cut)\b/iu.test(field.value);
    if (hit || englishCut) {
      throw new OutputContractError(`${field.path} 普通镜头不得写切镜、转场或地点跳转`);
    }
  }
}

function hasPositiveContinuityTerm(value, term) {
  const text = String(value || "");
  let index = text.indexOf(term);
  while (index !== -1) {
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
    ) + 1).trim();
    if (!/(?:不|无|禁止|避免|不得|不能|不可|勿|严禁|不应|不允许|切勿)$/u.test(segment)) return true;
    index = text.indexOf(term, index + term.length);
  }
  return false;
}

function collectMotionVisualContinuityFields(motion, path) {
  const fields = [];
  pushField(fields, `${path}.primaryAction`, motion.primaryAction);
  pushField(fields, `${path}.cameraMove.technique`, motion.cameraMove?.technique);
  pushField(fields, `${path}.cameraMove.path`, motion.cameraMove?.path);
  pushField(fields, `${path}.cameraMove.motivation`, motion.cameraMove?.motivation);
  pushField(fields, `${path}.environmentChange`, motion.environmentChange);
  pushField(fields, `${path}.lightingChange`, motion.lightingChange);
  (motion.timingBeats || []).forEach((beat, index) => {
    for (const field of ["action", "camera", "environment"]) {
      pushField(fields, `${path}.timingBeats[${index}].${field}`, beat?.[field]);
    }
  });
  return fields;
}

function requireExactContractObject(value, path, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${path} 必须是对象`);
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) throw new OutputContractError(`${path} 缺少字段：${missing.join("、")}`);
  const unexpected = Object.keys(value).filter((field) => !fields.includes(field));
  if (unexpected.length) throw new OutputContractError(`${path} 包含未知字段：${unexpected.join("、")}`);
}

function requireContractString(value, path) {
  if (typeof value !== "string") throw new OutputContractError(`${path} 必须是字符串`);
}

function requireNonEmptyContractString(value, path) {
  requireContractString(value, path);
  if (!value.trim()) throw new OutputContractError(`${path} 不能为空`);
}

function validateContractStringArray(value, path) {
  if (!Array.isArray(value)) throw new OutputContractError(`${path} 必须是数组`);
  value.forEach((item, index) => requireNonEmptyContractString(item, `${path}[${index}]`));
}

function percentEquals(left, right) {
  return Math.abs(left - right) < 1e-9;
}

function ensureUniqueNonEmptyField(items, field, path) {
  const seen = new Set();
  items.forEach((item, index) => {
    const value = String(item?.[field] || "").trim();
    if (!value) throw new OutputContractError(`${path}[${index}].${field} 不能为空`);
    if (seen.has(value)) throw new OutputContractError(`${path}.${field} 不能重复：${value}`);
    seen.add(value);
  });
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
  const identityAuthorizations = getFixedCharacterIdentityAuthorizations(fixedProfile);
  if (!String(value.roleAndOccupationMapping?.[0]?.newRole || "").includes(fixedName)) {
    throw new OutputContractError(
      `creativeBrief.roleAndOccupationMapping[0].newRole 必须保留固定角色姓名“${fixedName}”，不得更换或重命名主角`
    );
  }
  const protagonistMappings = (value.roleAndOccupationMapping || []).map((mapping, index) => ({ mapping, index })).filter(({ mapping, index }) => {
    const text = JSON.stringify(mapping || {});
    return index === 0 || text.includes(fixedName) || /主角|信使|任务执行|行动承担|固定角色/u.test(text);
  });
  for (const { mapping, index } of protagonistMappings) {
    const basePath = `creativeBrief.roleAndOccupationMapping[${index}]`;
    const terms = [...new Set([...protectedTerms, ...identityLeakTerms])];
    const strictIdentityHits = findCreativeBriefMappingTermHits([
      { path: `${basePath}.newRole`, value: String(mapping?.newRole || "") },
      { path: `${basePath}.newOccupationOrIdentity`, value: String(mapping?.newOccupationOrIdentity || "") }
    ], terms, identityAuthorizations);
    const mappingLogicHits = findCreativeBriefMappingTermHits([
      { path: `${basePath}.mappingLogic`, value: String(mapping?.mappingLogic || "") }
    ], terms, identityAuthorizations, { allowNegativeContext: true });
    const hits = dedupeFieldTermHits([...strictIdentityHits, ...mappingLogicHits]);
    if (hits.length) {
      throw new OutputContractError(
        `${basePath} 中固定角色「${fixedName}」的身份映射复用了禁止表面表达或非用户设定身份：${formatFieldTermHits(hits)}`
      );
    }
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

  const structuredShotMatch = sourcePath.match(
    /^animationPlan\.(?:shotPlan|shots)\[([^\]]+)\]\.((?:startFrame|endFrame|motion)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*)$/u
  );
  if (structuredShotMatch) {
    const token = normalizeEvidencePathToken(structuredShotMatch[1]);
    const nestedPath = structuredShotMatch[2];
    if (!evidenceShotTokenMatches(token, shot, shotIndex) || !isStructuredVisualEvidencePath(nestedPath)) return false;
    return evidenceMatchesSourceValue(resolveStructuredEvidenceValue(shot, nestedPath), evidence);
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

function isStructuredVisualEvidencePath(path) {
  if (/^motion\.audio(?:\.|\[|$)/u.test(path)) return false;
  if (/^motion\.timingBeats\[\d+\]\.soundCue$/u.test(path)) return false;
  return /^(?:startFrame|endFrame|motion)(?:\.|\[|$)/u.test(path);
}

function resolveStructuredEvidenceValue(root, path) {
  const tokens = String(path || "").split(/\.|\[|\]/u).filter(Boolean);
  let current = root;
  for (const token of tokens) {
    if (["__proto__", "prototype", "constructor"].includes(token)) return undefined;
    if (current === undefined || current === null) return undefined;
    current = current[token];
  }
  return current;
}

function collectShotVisualEvidenceText(shot = {}) {
  const values = [shot.startFramePrompt, shot.endFramePrompt, shot.videoPrompt, shot.characterAction];
  if (shot.startFrame) values.push(JSON.stringify(shot.startFrame));
  if (shot.endFrame) values.push(JSON.stringify(shot.endFrame));
  if (shot.motion) {
    values.push(JSON.stringify({
      mode: shot.motion.mode,
      primaryAction: shot.motion.primaryAction,
      cameraMove: shot.motion.cameraMove,
      emotionArc: shot.motion.emotionArc,
      environmentChange: shot.motion.environmentChange,
      lightingChange: shot.motion.lightingChange,
      timingBeats: (shot.motion.timingBeats || []).map((beat) => ({
        fromPercent: beat?.fromPercent,
        toPercent: beat?.toPercent,
        action: beat?.action,
        camera: beat?.camera,
        emotion: beat?.emotion,
        environment: beat?.environment
      })),
      preserve: shot.motion.preserve,
      endStateRef: shot.motion.endStateRef,
      stopCondition: shot.motion.stopCondition
    }));
  }
  return values.filter(Boolean).join("\n");
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
  const shotText = collectShotVisualEvidenceText(shot);
  const explicitlyShowsLimbs = /手|手指|指尖|脚|足/u.test(shotText);
  const requestsHumanLimbs = /正常.{0,4}(?:人类)?(?:手|手指|脚|足)|人类(?:手|手指|脚|足)|五指/u.test(shotText);
  const provenFailure = evidence.some((entry) => isProviderFailureEvidencePath(entry.sourcePath)) && hasProviderFailureRecords(context);
  const referencePollution = evidence.some((entry) => isActualReferenceEvidencePath(entry.sourcePath) || /reference|参考|sourceSimilarityRules/u.test(entry.sourcePath))
    && hasActualVisualReference(context, shot, media);
  return explicitlyShowsLimbs && requestsHumanLimbs && (provenFailure || referencePollution);
}

function shotContainsEvidenceSubject(shot, evidence) {
  const shotText = collectShotVisualEvidenceText(shot);
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
  "人偶", "人偶服", "兽装", "头套", "拟人动物", "拟人化动物", "动物角色", "动物形象少女",
  "兽类角色", "兽人", "快递员", "送货员"
];

const fixedCharacterIdentitySpecies = ["猫", "狼", "狐", "兔", "犬", "狗", "鹿", "熊", "虎", "豹", "羊", "龙"];
const fixedCharacterOccupationTerms = ["快递员", "送货员"];
const semanticCharacterIdentityTerms = fixedCharacterIdentitySpecies.flatMap((species) => [
  `${species}娘`, `${species}耳少女`, `${species}尾少女`, `${species}系少女`
]);

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
const protagonistSurfaceTerms = [...sourceSurfaceIdentityTerms, ...semanticCharacterIdentityTerms, ...bodySurfaceTerms];

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
    if (hasStructuredAnimationShotFields(shot)) {
      collectStructuredFramePositiveFields(fields, `shotPlan[${index}].startFrame`, shot?.startFrame);
      collectStructuredFramePositiveFields(fields, `shotPlan[${index}].endFrame`, shot?.endFrame);
      collectStructuredMotionPositiveFields(fields, `shotPlan[${index}].motion`, shot?.motion);
    } else {
      pushField(fields, `shotPlan[${index}].startFramePrompt`, shot?.startFramePrompt);
      pushField(fields, `shotPlan[${index}].endFramePrompt`, shot?.endFramePrompt);
      pushField(fields, `shotPlan[${index}].videoPrompt`, shot?.videoPrompt);
      pushField(fields, `shotPlan[${index}].cameraMotion`, shot?.cameraMotion);
      pushField(fields, `shotPlan[${index}].characterAction`, shot?.characterAction);
    }
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
    if (hasStructuredAnimationShotFields(shot)) {
      pushArrayFields(fields, `shotPlan[${index}].startFrame.continuityLocks`, shot?.startFrame?.continuityLocks);
      pushArrayFields(fields, `shotPlan[${index}].endFrame.continuityLocks`, shot?.endFrame?.continuityLocks);
      pushArrayFields(fields, `shotPlan[${index}].motion.preserve`, shot?.motion?.preserve);
      pushField(fields, `shotPlan[${index}].motion.stopCondition`, shot?.motion?.stopCondition);
    } else {
      pushField(fields, `shotPlan[${index}].continuityNotes`, shot?.continuityNotes);
    }
  });
  return fields;
}

function collectStructuredFramePositiveFields(fields, path, frame = {}) {
  pushField(fields, `${path}.timeAndWeather`, frame?.timeAndWeather);
  (frame?.characters || []).forEach((character, index) => {
    animationFrameCharacterFields.forEach((field) => pushField(fields, `${path}.characters[${index}].${field}`, character?.[field]));
  });
  animationFrameEnvironmentFields.forEach((field) => pushField(fields, `${path}.environment.${field}`, frame?.environment?.[field]));
  animationFrameCameraFields.forEach((field) => pushField(fields, `${path}.camera.${field}`, frame?.camera?.[field]));
  animationFrameLightingFields.forEach((field) => pushField(fields, `${path}.lighting.${field}`, frame?.lighting?.[field]));
  pushArrayFields(fields, `${path}.styleModifiers`, frame?.styleModifiers);
}

function collectStructuredMotionPositiveFields(fields, path, motion = {}) {
  pushField(fields, `${path}.primaryAction`, motion?.primaryAction);
  for (const field of ["technique", "path", "motivation"]) {
    pushField(fields, `${path}.cameraMove.${field}`, motion?.cameraMove?.[field]);
  }
  for (const field of ["from", "visibleProgression", "to"]) {
    pushField(fields, `${path}.emotionArc.${field}`, motion?.emotionArc?.[field]);
  }
  pushField(fields, `${path}.environmentChange`, motion?.environmentChange);
  pushField(fields, `${path}.lightingChange`, motion?.lightingChange);
  (motion?.timingBeats || []).forEach((beat, index) => {
    for (const field of ["action", "camera", "emotion", "environment"]) {
      pushField(fields, `${path}.timingBeats[${index}].${field}`, beat?.[field]);
    }
  });
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

function findCreativeBriefMappingTermHits(fields, terms, identityAuthorizations, { allowNegativeContext = false } = {}) {
  const hits = [];
  for (const field of fields || []) {
    for (const term of terms || []) {
      if (!term || !hasForbiddenCreativeBriefOccurrence(field.value, term, identityAuthorizations, { allowNegativeContext })) continue;
      hits.push({ term, path: field.path });
    }
  }
  return dedupeFieldTermHits(hits);
}

function hasForbiddenCreativeBriefOccurrence(value, term, identityAuthorizations, { allowNegativeContext = false } = {}) {
  const text = String(value || "");
  const needle = String(term || "");
  if (!needle) return false;
  let index = text.indexOf(needle);
  while (index !== -1) {
    const inNegativeContext = allowNegativeContext && isNegatedTermOccurrence(text, index);
    const authorizedIdentityTerm = [
      ...(identityAuthorizations.authorizedIdentityTerms || []),
      ...(identityAuthorizations.authorizedOccupationTerms || [])
    ].includes(needle);
    const literalFixedCharacterOccurrence = isInsideLiteralFixedCharacter(text, index, needle, identityAuthorizations.fixedCharacterText);
    if (!inNegativeContext && !authorizedIdentityTerm && !literalFixedCharacterOccurrence) return true;
    index = text.indexOf(needle, index + needle.length);
  }
  return false;
}

function isInsideLiteralFixedCharacter(value, termIndex, term, fixedCharacterText) {
  const fixedText = String(fixedCharacterText || "");
  if (!fixedText || !fixedText.includes(term)) return false;
  let profileIndex = value.indexOf(fixedText);
  while (profileIndex !== -1) {
    if (termIndex >= profileIndex && termIndex + term.length <= profileIndex + fixedText.length) return true;
    profileIndex = value.indexOf(fixedText, profileIndex + fixedText.length);
  }
  return false;
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
  const directives = [...segment.matchAll(/(不要|禁止|避免|不得|不能|不可|勿|严禁|不应|不可以|不允许|切勿|杜绝|无|没有|不带|未出现|不出现|不(?:再)?(?:使用|复用|继承|保留|沿用|采用|新增|添加|加入|呈现|包含|带有|拥有|变成|成为|写入))(?:出现|使用|写入|新增|自动新增|复用|继承|加入|添加|变成|带有|拥有|呈现|包含|有)?/gu)];
  const directive = directives.at(-1);
  if (!directive) return false;
  const trailing = segment.slice((directive.index || 0) + directive[0].length);
  if (trailing.length > 64) return false;
  if (/(?:但(?:是)?|然而|可是|却|而是|仍(?:然)?|继续|同时|随后|之后|然后|接着|继而|转而|并(?:让|由|使)|改为|改成|变成|成为|转为|新增|添加|采用|保留|继承|使用|拥有|实际(?:上)?|反而)/u.test(trailing)) return false;
  if (/(?:主角|角色|人物|新身份|新职业)[^。！？；;\n]{0,8}(?:是|作为|使用|继承|拥有|变成|保留)/u.test(trailing)) return false;
  return true;
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
  const authorizedIdentityTerms = new Set(getFixedCharacterIdentityAuthorizations(fixedProfile).authorizedIdentityTerms);
  return [
    ...sourceSurfaceIdentityTerms.filter((term) => term.length >= 2),
    ...semanticCharacterIdentityTerms.filter((term) => !authorizedIdentityTerms.has(term)),
    ...bodySurfaceTerms.filter((term) => term.length >= 2 && incompatibleBodyTerms.has(term))
  ];
}

export function getFixedCharacterIdentityAuthorizations(fixedCharacter = "") {
  const fixedProfile = String(fixedCharacter || "");
  const authorizedIdentityTerms = new Set();
  const originalIdentityExpressions = new Set();
  const authorizedSpecies = new Set();
  const authorizedOccupationTerms = new Set();
  const segments = fixedProfile.split(/[，,；;。\n\r]/u).map((item) => item.trim()).filter(Boolean);

  for (const species of fixedCharacterIdentitySpecies) {
    const identityTerms = [`${species}娘`, `${species}耳少女`, `${species}尾少女`, `${species}系少女`];
    const explicitIdentitySegments = segments.filter((segment) => identityTerms.some((term) => (
      segment.includes(term) && isIntrinsicFixedIdentityMention(segment, term)
    )));
    const explicitTerms = identityTerms.filter((term) => explicitIdentitySegments.some((segment) => segment.includes(term)));
    const intrinsicPair = new RegExp(
      `(?:有|拥有|长着|生有|天生|固定身体特征|身体设定)[^，,。；;\\n]{0,20}${species}耳[^，,。；;\\n]{0,20}${species}(?:尾|尾巴)|${species}耳[^，,。；;\\n]{0,20}${species}(?:尾|尾巴)[^，,。；;\\n]{0,20}(?:固定身体特征|身体设定)`,
      "u"
    );
    const intrinsicIdentitySegments = segments.filter((segment) => (
      intrinsicPair.test(segment) && !hasRemovableAnimalFeatureContext(segment)
    ));
    if (!explicitTerms.length && !intrinsicIdentitySegments.length) continue;
    authorizedSpecies.add(species);
    identityTerms.forEach((term) => authorizedIdentityTerms.add(term));
    [...explicitIdentitySegments, ...intrinsicIdentitySegments]
      .forEach((segment) => originalIdentityExpressions.add(segment));
  }

  for (const occupation of fixedCharacterOccupationTerms) {
    const matchingSegments = segments.filter((segment) => isIntrinsicFixedOccupationMention(segment, occupation));
    if (!matchingSegments.length) continue;
    authorizedOccupationTerms.add(occupation);
    matchingSegments.forEach((segment) => originalIdentityExpressions.add(segment));
  }

  return {
    fixedCharacterText: fixedProfile,
    authorizedSpecies: [...authorizedSpecies],
    authorizedIdentityTerms: [...authorizedIdentityTerms],
    authorizedOccupationTerms: [...authorizedOccupationTerms],
    originalIdentityExpressions: [...originalIdentityExpressions]
  };
}

function isIntrinsicFixedOccupationMention(segment, occupation) {
  const index = segment.indexOf(occupation);
  if (index < 0) return false;
  const before = segment.slice(0, index);
  if (/(?:不是|并非|不当|不做|喜欢|研究|采访|遇到|帮助|模仿)[^，,。；;\n]{0,12}$/u.test(before)) return false;
  if (!before) return true;
  return /(?:是|为|作为|职业(?:是|为)|身份(?:是|为)|担任|从事|里的|中的)[^，,。；;\n]{0,8}$/u.test(before);
}

function isIntrinsicFixedIdentityMention(segment, term) {
  const index = segment.indexOf(term);
  if (index < 0) return false;
  const before = segment.slice(Math.max(0, index - 16), index);
  const after = segment.slice(index + term.length, index + term.length + 16);
  if (/(?:不是|并非|非|不属于|不设定为|拒绝成为|喜欢|研究|讨论|创作|画过|画了|设计|收藏|关注|网名叫|昵称叫|称号为)[^，,。；;\n]{0,12}$/u.test(before)) return false;
  if (/(?:穿着|身穿|穿戴|戴着|套着|披着|换上|装扮成?|角色扮演|临时扮演|扮演|假扮|模仿|印有|画有|绘有|贴有|绣有)[^，,。；;\n]{0,12}$/u.test(before)) return false;
  if (/^(?:(?:风格|风|文化|题材|作品|图案|图像|印花|贴纸|徽章|配饰|头饰|发箍|面具|头套|服装|服饰|衣服|套装|装扮|造型|网名|昵称|称号|头像|周边))/u.test(after)) return false;
  if (!before) return true;
  return /(?:(?:是|为|作为|属于|设定为|固定为|身份(?:是|为)|本体(?:是|为)|形象类似|整体(?:是|为))(?:(?:一名|一个|一位)?(?:Q版|q版|可爱(?:的)?|活泼(?:的)?|年轻(?:的)?)*)|^(?:(?:Q版|q版|可爱(?:的)?|活泼(?:的)?|年轻(?:的)?)+))$/u.test(before);
}

function hasRemovableAnimalFeatureContext(segment) {
  return /(?:发箍|头饰|配饰|饰品|挂件|尾饰|假尾|服装|服饰|衣服|套装|装扮|造型|玩偶服|面具|头套|可拆卸|临时扮演|角色扮演|不是固定身体特征|喜欢|研究|讨论|创作|画过|设计|收藏|题材|文化|作品)/u.test(segment);
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
