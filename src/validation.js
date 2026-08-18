import { validateLegacyFullStoryStrict } from "./contracts/contract-validator.js";
import { GLOBAL_CHARACTER_BOUNDARY_VERSION } from "./character-boundary.js";
import {
  assertVideoPromptProfile,
  VIDEO_PROMPT_PROFILE_IDS
} from "../public/video-prompt-profiles.js";
import {
  assertMiniMaxH3BasePrompt,
  miniMaxH3DialogueTexts
} from "./minimax-h3-prompt.js";

export class InputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "InputError";
    this.details = details;
  }
}

export class OutputContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "OutputContractError";
    this.details = Array.isArray(details) ? details : [];
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
export const ANIMATION_DIRECT_SHOT_MODE = "direct_shot";
export const ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION = "3.0";
export const ANIMATION_PLAN_ASPECT_RATIOS = Object.freeze(["9:16", "16:9"]);
export const CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS = Object.freeze([
  "送达任务",
  "旅途结构",
  "情感媒介",
  "获得帮助",
  "被关爱对象",
  "天气或空间推动情绪",
  "生活化或仪式化结尾"
]);

// howToReuseSafely 必须先对"原片是否真的存在该构件"作出显式二选一判定，再谈怎么复用。
// 缺少这一步时模型会把"新片可以怎么用"直接写成复用授权，等于替原片补出它没有的叙事构件。
export const CREATIVE_BRIEF_COMPONENT_PRESENCE_MARKERS = Object.freeze(["【原片有】", "【原片没有】"]);

export function requireAnimationPlanAspectRatio(value, path = "targetAspectRatio") {
  const normalized = String(value || "").trim();
  if (!ANIMATION_PLAN_ASPECT_RATIOS.includes(normalized)) {
    throw new InputError(`${path} 只允许 ${ANIMATION_PLAN_ASPECT_RATIOS.join(" 或 ")}`);
  }
  return normalized;
}

export function ensureAnimationPlanAspectRatio(value, path = "productionStrategy.targetAspectRatio") {
  const normalized = String(value || "").trim();
  if (!ANIMATION_PLAN_ASPECT_RATIOS.includes(normalized)) {
    throw new OutputContractError(`${path} 只允许 ${ANIMATION_PLAN_ASPECT_RATIOS.join(" 或 ")}`);
  }
  return normalized;
}
const animationDirectShotFields = [
  "shotId",
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes",
  "negativePrompts",
  "acceptanceCriteria"
];
const animationEndpointShotFields = [
  "startFrame",
  "endFrame",
  "motion",
  "startFramePrompt",
  "endFramePrompt"
];
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
export const animationFrameCameraFields = Object.freeze([
  "shotSize",
  "height",
  "angle",
  "viewDirection",
  "lensFeel",
  "depthOfField",
  "composition"
]);
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
export const frameReferenceModes = Object.freeze(["inherit", "transition", "independent"]);
const frameReferenceModeSet = new Set(frameReferenceModes);
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
const characterBoundaryFields = new Set([
  "schemaVersion",
  "characterName",
  "canonicalDescription",
  "bodyForm",
  "requiredTraits",
  "allowedTraits",
  "forbiddenTraits",
  "unresolvedConflicts",
  "sourceDigest",
  "boundaryDigest",
  "boundarySignature"
]);
const characterBoundaryModelFields = new Set([
  "schemaVersion",
  "characterName",
  "canonicalDescription",
  "bodyForm",
  "requiredTraits",
  "allowedTraits",
  "forbiddenTraits",
  "unresolvedConflicts"
]);
const characterBoundarySealFields = ["sourceDigest", "boundaryDigest", "boundarySignature"];
const characterBoundaryTraitFields = new Set([
  "canonicalName",
  "terms",
  "scope",
  "evidenceLevel",
  "triggerEvidence",
  "reason"
]);
const characterBoundaryTraitScopes = new Set(["identity", "appearance", "personality", "occupation", "storyFunction"]);
const characterBoundaryEvidenceLevels = new Set(["explicit", "inferred"]);
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
const explicitStandardNameSuffixSeparatorPattern = "[（(【\\[\\s,，:：—–\\-]";

export function hasExplicitStandardNameSuffix(value, standardName) {
  if (typeof value !== "string" || typeof standardName !== "string") return false;
  const candidate = value.trim();
  const canonical = standardName.trim();
  if (!candidate || !canonical) return false;
  return new RegExp(
    `^${escapeContractRegExp(canonical)}${explicitStandardNameSuffixSeparatorPattern}`,
    "u"
  ).test(candidate);
}

export function ensureOutputContract(value, contract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${contract} 必须是对象`);
  if (contract === "fullStory") {
    const schemaResult = validateLegacyFullStoryStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `fullStory 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
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
    validateFullStorySceneContract(value);
  }
  if (contract === "animationPlan") {
    if (value.characterReferencePrompts.length < 1) throw new OutputContractError("animationPlan 至少需要一个角色参考提示词");
    if (value.sceneReferencePrompts.length < 1) throw new OutputContractError("animationPlan 至少需要一个场景参考提示词");
    if (value.shotPlan.length < 1) throw new OutputContractError("animationPlan 至少需要一个镜头生产任务");
    if (value.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
      ensureAnimationPlanDirectShotContract(value);
    } else {
      ensureAnimationPlanV2Contract(value);
    }
    validateAnimationPlanNegativePromptContract(value);
  }
  return value;
}

function validateFullStorySceneContract(value) {
  const details = [];
  const seenSceneIds = new Map();
  const standardNames = collectFullStoryStandardCharacterNames(value.characterBible);

  value.sceneScript.forEach((scene, sceneIndex) => {
    const scenePath = `fullStory.sceneScript[${sceneIndex}]`;
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_OBJECT_REQUIRED",
        path: scenePath,
        reason: "场次必须是对象"
      });
      return;
    }

    const sceneId = validateFullStorySceneRequiredString(
      scene.sceneId,
      `${scenePath}.sceneId`,
      "sceneId",
      details
    );
    if (sceneId) {
      const firstIndex = seenSceneIds.get(sceneId);
      if (firstIndex !== undefined) {
        pushFullStorySceneViolation(details, {
          code: "FULL_STORY_SCENE_ID_DUPLICATE",
          path: `${scenePath}.sceneId`,
          reason: `sceneId「${sceneId}」与 fullStory.sceneScript[${firstIndex}].sceneId 重复`,
          sceneId
        });
      } else {
        seenSceneIds.set(sceneId, sceneIndex);
      }
    }

    validateFullStorySceneRequiredString(
      scene.location,
      `${scenePath}.location`,
      "location",
      details,
      sceneId
    );
    validateFullStorySceneRequiredString(
      scene.visibleAction,
      `${scenePath}.visibleAction`,
      "visibleAction",
      details,
      sceneId
    );

    const characterNames = validateFullStorySceneCharacters(
      scene.characters,
      `${scenePath}.characters`,
      standardNames,
      details,
      sceneId
    );
    validateFullStoryVisualCharacterReferences({
      scene,
      scenePath,
      sceneId,
      standardNames,
      characterNames,
      details
    });
    validateFullStoryDialogueSpeakers({
      dialogue: scene.dialogue,
      scenePath,
      sceneId,
      characterNames,
      details
    });
  });

  if (details.length) {
    throw new OutputContractError(
      `fullStory Scene Contract 校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
}

function validateFullStorySceneRequiredString(value, path, field, details, sceneId = "") {
  if (typeof value !== "string") {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_STRING_REQUIRED",
      path,
      reason: `${field} 必须是非空字符串`,
      sceneId
    });
    return "";
  }
  const normalized = value.trim();
  if (!normalized) {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_STRING_REQUIRED",
      path,
      reason: `${field} 不能为空`,
      sceneId
    });
  }
  return normalized;
}

function validateFullStorySceneCharacters(value, path, standardNames, details, sceneId) {
  if (!Array.isArray(value)) {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_CHARACTERS_REQUIRED",
      path,
      reason: "characters 必须是非空字符串数组",
      sceneId
    });
    return new Set();
  }
  if (!value.length) {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_CHARACTERS_REQUIRED",
      path,
      reason: "characters 不能为空数组",
      sceneId
    });
  }

  const names = new Set();
  value.forEach((characterName, characterIndex) => {
    const characterPath = `${path}[${characterIndex}]`;
    if (typeof characterName !== "string" || !characterName.trim()) {
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_CHARACTER_NAME_REQUIRED",
        path: characterPath,
        reason: "角色名必须是非空字符串",
        sceneId
      });
      return;
    }
    const normalized = characterName.trim();
    if (names.has(normalized)) {
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_CHARACTER_DUPLICATE",
        path: characterPath,
        reason: `同一场次角色名不能重复：${normalized}`,
        sceneId
      });
      return;
    }
    names.add(normalized);
    const decoratedStandardName = standardNames.find((standardName) => (
      hasExplicitStandardNameSuffix(normalized, standardName)
    ));
    if (decoratedStandardName) {
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_CHARACTER_NAME_INEXACT",
        path: characterPath,
        reason: `角色名「${normalized}」不是标准名称「${decoratedStandardName}」；不得添加身份、外观或别名后缀`,
        sceneId
      });
    }
  });
  return names;
}

function validateFullStoryVisualCharacterReferences({
  scene,
  scenePath,
  sceneId,
  standardNames,
  characterNames,
  details
}) {
  for (const field of ["visibleAction", "shotAndSound"]) {
    const value = scene[field];
    if (typeof value !== "string" || !value) continue;
    standardNames.forEach((standardName) => {
      if (
        !fullStoryVisualTextMentionsStandardName(value, standardName, characterNames)
        || characterNames.has(standardName)
      ) return;
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING",
        path: `${scenePath}.${field}`,
        reason: `视觉字段明确提到标准角色「${standardName}」，但 characters 未包含该精确名称`,
        sceneId
      });
    });
  }
}

function fullStoryVisualTextMentionsStandardName(text, standardName, characterNames) {
  let remaining = text;
  characterNames.forEach((characterName) => {
    if (
      characterName === standardName
      || hasExplicitStandardNameSuffix(characterName, standardName)
      || !new RegExp(`^${escapeContractRegExp(standardName)}.`, "u").test(characterName)
    ) return;
    remaining = remaining.replace(
      new RegExp(escapeContractRegExp(characterName), "gu"),
      ""
    );
  });
  return literalContractTextIncludes(remaining, standardName);
}

function validateFullStoryDialogueSpeakers({
  dialogue,
  scenePath,
  sceneId,
  characterNames,
  details
}) {
  if (!Array.isArray(dialogue)) return;
  dialogue.forEach((line, dialogueIndex) => {
    const speaker = typeof line?.speaker === "string" ? line.speaker.trim() : "";
    if (!speaker || characterNames.has(speaker)) return;
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING",
      path: `${scenePath}.dialogue[${dialogueIndex}].speaker`,
      reason: `结构化说话人「${speaker}」必须精确存在于当前场次 characters`,
      sceneId
    });
  });
}

function collectFullStoryStandardCharacterNames(characterBible = {}) {
  const names = [
    characterBible?.protagonist?.name,
    characterBible?.careRecipient?.nameOrLabel,
    ...(Array.isArray(characterBible?.helpers)
      ? characterBible.helpers.map((helper) => helper?.nameOrLabel)
      : [])
  ];
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
}

function pushFullStorySceneViolation(details, detail) {
  details.push({
    code: detail.code,
    path: detail.path,
    jsonPointer: fullStorySceneContractJsonPointer(detail.path),
    reason: detail.reason,
    ...(detail.sceneId ? { sceneId: detail.sceneId } : {})
  });
}

function fullStorySceneContractJsonPointer(path) {
  const source = String(path || "");
  if (!source.startsWith("fullStory.")) return "";
  const tokens = [];
  const body = source.slice("fullStory.".length);
  const pattern = /(?:^|\.)([^.\[\]]+)|\[(\d+)\]/gu;
  let consumed = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index !== consumed) return "";
    const token = match[1] ?? match[2];
    if (["__proto__", "prototype", "constructor"].includes(token)) return "";
    tokens.push(token);
    consumed = match.index + match[0].length;
  }
  if (!tokens.length || consumed !== body.length) return "";
  return `/${tokens
    .map((token) => String(token).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

function literalContractTextIncludes(text, literal) {
  return new RegExp(escapeContractRegExp(literal), "u").test(text);
}

function escapeContractRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  ensureAnimationFoundationPromptSchemaVersion(value.promptSchemaVersion, "animationFoundation.promptSchemaVersion");
  ensureAnimationPlanAspectRatio(value.productionStrategy?.targetAspectRatio, "animationFoundation.productionStrategy.targetAspectRatio");

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
export function ensureAnimationShotBatchContract(value, { promptSchemaVersion = "" } = {}) {
  if (promptSchemaVersion && ![animationPromptSchemaVersion, ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION].includes(promptSchemaVersion)) {
    throw new OutputContractError(`animationShotBatch promptSchemaVersion 不受支持：${promptSchemaVersion}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError("animationShotBatch 必须是对象");
  }
  const unexpected = Object.keys(value).filter((key) => key !== "shotPlan");
  if (unexpected.length) throw new OutputContractError(`animationShotBatch 只允许 shotPlan 顶层字段，收到：${unexpected.join("、")}`);
  if (!Array.isArray(value.shotPlan)) throw new OutputContractError("animationShotBatch.shotPlan 必须是数组");
  if (!value.shotPlan.length) throw new OutputContractError("animationShotBatch 至少需要一个镜头");
  const isDirectShot = promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION;
  const isV2 = !isDirectShot && value.shotPlan.some(hasStructuredAnimationShotFields);
  ensureUniqueNonEmptyField(value.shotPlan, "shotId", "animationShotBatch.shotPlan");
  value.shotPlan.forEach((shot, index) => {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
      throw new OutputContractError(`animationShotBatch.shotPlan[${index}] 必须是对象`);
    }
    if (isDirectShot) {
      ensureAnimationDirectShotContract(shot, `animationShotBatch.shotPlan[${index}]`);
      return;
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
  if (isDirectShot) {
    validateAnimationPlanNegativePromptContract({ visualBible: {}, sceneReferencePrompts: [], shotPlan: value.shotPlan });
    return value;
  }
  if (isV2) ensureAnimationPlanV2Contract(value, { path: "animationShotBatch", allowVersionlessStructured: true });
  validateAnimationPlanNegativePromptContract({ visualBible: {}, sceneReferencePrompts: [], shotPlan: value.shotPlan });
  return value;
}

/**
 * Validate the temporarily active direct-shot contract. The v2 endpoint
 * contract remains below for compatibility and is intentionally not deleted.
 */
export function ensureAnimationPlanDirectShotContract(value, { path = "animationPlan" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError(`${path} 必须是对象`);
  }
  if (value.promptSchemaVersion !== ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) {
    throw new OutputContractError(
      `${path}.promptSchemaVersion 必须严格等于 "${ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION}"`
    );
  }
  if (value.productionStrategy?.format !== "direct_shot_video") {
    throw new OutputContractError(`${path}.productionStrategy.format 必须严格等于 "direct_shot_video"`);
  }
  ensureAnimationPlanAspectRatio(value.productionStrategy?.targetAspectRatio, `${path}.productionStrategy.targetAspectRatio`);
  if (!Array.isArray(value.shotPlan)) throw new OutputContractError(`${path}.shotPlan 必须是数组`);
  value.shotPlan.forEach((shot, index) => ensureAnimationDirectShotContract(shot, `${path}.shotPlan[${index}]`));
  const videoPromptProfile = ensureAnimationPlanVideoPromptProfile(value, { path, optional: true });
  if (videoPromptProfile?.profileId === VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3) {
    value.shotPlan.forEach((shot, index) => {
      try {
        assertMiniMaxH3BasePrompt(shot.videoPrompt, {
          durationSeconds: shot.durationSeconds,
          path: `${path}.shotPlan[${index}].videoPrompt`,
          dialogueTexts: miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
        });
      } catch (error) {
        throw new OutputContractError(error.message, error.details);
      }
    });
  }
  validateAnimationPlanNegativePromptContract(value);
  return value;
}

export function ensureAnimationPlanVideoPromptProfile(value, {
  path = "animationPlan",
  optional = false
} = {}) {
  const profile = value?.productionStrategy?.videoPromptProfile;
  if (profile === undefined || profile === null) {
    if (optional) return null;
    throw new OutputContractError(`${path}.productionStrategy.videoPromptProfile 缺失。`);
  }
  try {
    return assertVideoPromptProfile(profile);
  } catch (error) {
    throw new OutputContractError(`${path}.productionStrategy.videoPromptProfile 无效：${error.message}`);
  }
}

function ensureAnimationDirectShotContract(shot, path) {
  requireExactContractObject(shot, path, animationDirectShotFields);
  const forbidden = animationEndpointShotFields.filter((field) => Object.prototype.hasOwnProperty.call(shot, field));
  if (forbidden.length) {
    throw new OutputContractError(`${path} 不得包含暂时停用的首尾帧字段：${forbidden.join("、")}`);
  }
  for (const field of [
    "shotId",
    "sourceSceneId",
    "sceneId",
    "storyPurpose",
    "emotionalTarget",
    "videoPrompt",
    "cameraMotion",
    "characterAction",
    "soundDesign",
    "continuityNotes"
  ]) {
    requireNonEmptyContractString(shot[field], `${path}.${field}`);
  }
  if (typeof shot.dialogueOrSubtitle !== "string") {
    throw new OutputContractError(`${path}.dialogueOrSubtitle 必须是字符串`);
  }
  const duration = Number(shot.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new OutputContractError(`${path}.durationSeconds 必须是正数`);
  }
  if (!Array.isArray(shot.acceptanceCriteria) || shot.acceptanceCriteria.length < 1 || shot.acceptanceCriteria.length > 3) {
    throw new OutputContractError(`${path}.acceptanceCriteria 必须包含 1-3 条验收标准`);
  }
  shot.acceptanceCriteria.forEach((criterion, index) => {
    requireNonEmptyContractString(criterion, `${path}.acceptanceCriteria[${index}]`);
  });
  if (!shot.negativePrompts || !Array.isArray(shot.negativePrompts.image) || shot.negativePrompts.image.length) {
    throw new OutputContractError(`${path}.negativePrompts.image 在 direct_shot 模式必须为 []`);
  }
  return shot;
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
  validateAnimationEnvironmentChangeDeclaration(shot, path);
  return shot;
}

function validateAnimationEnvironmentChangeDeclaration(shot, path) {
  const changedFields = animationFrameEnvironmentFields.filter(
    (field) => shot.startFrame.environment[field] !== shot.endFrame.environment[field]
  );
  if (!changedFields.length || hasDeclaredFrameChange(shot.motion.environmentChange)) return;

  const details = changedFields.map((field) => ({
    code: "ANIMATION_ENVIRONMENT_CHANGE_UNDECLARED",
    path: `${path}.endFrame.environment.${field}`,
    reason: `StartState=${JSON.stringify(shot.startFrame.environment[field])}；EndState=${JSON.stringify(shot.endFrame.environment[field])}。若场景本身没有变化，应逐字复制首帧 environment，并把角色姿态、手部或道具持有变化移入 characters / motion`
  }));
  throw new OutputContractError(
    `${path} 首尾 environment 发生了未声明变化：${changedFields.join("、")}；motion.environmentChange 不得声明为无变化`,
    details
  );
}

/**
 * Validate the runtime strategy used to generate one shot's end-frame image.
 * `hasStartFrame` describes the selected start-frame image, not the structured
 * StartState, which remains part of every v2 shot.
 */
export function ensureFrameReferenceModeCompatibility(
  shot,
  frameReferenceMode,
  { hasStartFrame = true } = {}
) {
  if (!frameReferenceModeSet.has(frameReferenceMode)) {
    throw frameReferenceModeError(
      `frameReferenceMode 只允许 ${frameReferenceModes.join("、")}`,
      "FRAME_REFERENCE_MODE_INVALID"
    );
  }
  if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
    throw frameReferenceModeError("shot 必须是对象", "FRAME_REFERENCE_SHOT_INVALID");
  }
  const startFrame = shot.startFrame;
  const endFrame = shot.endFrame;
  if (!endFrame || typeof endFrame !== "object" || Array.isArray(endFrame)) {
    throw frameReferenceModeError("缺少有效 EndState，无法生成尾帧", "FRAME_END_STATE_REQUIRED");
  }
  if (!startFrame || typeof startFrame !== "object" || Array.isArray(startFrame)) {
    throw frameReferenceModeError("缺少结构化 StartState，无法验证同镜头场景边界", "FRAME_START_STATE_REQUIRED");
  }

  assertFrameReferenceSceneBoundary(shot, startFrame, endFrame);

  if (frameReferenceMode === "independent") return frameReferenceMode;
  if (!hasStartFrame) {
    throw frameReferenceModeError(
      `${frameReferenceMode} 模式生成尾帧前必须先选择首帧图片`,
      "FRAME_START_IMAGE_REQUIRED"
    );
  }

  const motion = shot.motion || {};
  const cameraChanged = animationFieldsChanged(startFrame.camera, endFrame.camera, animationFrameCameraFields);
  const lightingChanged = animationFieldsChanged(startFrame.lighting, endFrame.lighting, animationFrameLightingFields);
  const environmentChangedFields = changedAnimationFields(
    startFrame.environment,
    endFrame.environment,
    animationFrameEnvironmentFields
  );
  const environmentChanged = environmentChangedFields.length > 0;
  const charactersChanged = !sameCanonicalValue(startFrame.characters, endFrame.characters);
  const timeAndWeatherChanged = startFrame.timeAndWeather !== endFrame.timeAndWeather;
  const styleChanged = !sameCanonicalValue(startFrame.styleModifiers, endFrame.styleModifiers);

  if (frameReferenceMode === "inherit") {
    const incompatible = [
      cameraChanged ? "camera" : "",
      environmentChanged ? "environment" : "",
      lightingChanged ? "lighting" : "",
      timeAndWeatherChanged ? "timeAndWeather" : "",
      styleChanged ? "styleModifiers" : "",
      motion?.cameraMove?.mode === "continuous" && motion?.mode !== "loop" ? "cameraMove.mode" : "",
      motion?.mode === "object_transform" ? "motion.mode" : ""
    ].filter(Boolean);
    if (incompatible.length) {
      throw frameReferenceModeError(
        `inherit 模式要求首尾场景结构、摄影机、光线、时段天气和风格一致；不兼容字段：${incompatible.join("、")}`,
        "FRAME_INHERIT_INCOMPATIBLE"
      );
    }
    return frameReferenceMode;
  }

  if (styleChanged) {
    throw frameReferenceModeError(
      "transition 模式不得改变同一镜头的视觉风格",
      "FRAME_TRANSITION_STYLE_CHANGE"
    );
  }
  if (!(cameraChanged || lightingChanged || environmentChanged || charactersChanged || timeAndWeatherChanged)) {
    throw frameReferenceModeError(
      "transition 模式必须在 EndState 中声明至少一个可见终点变化",
      "FRAME_TRANSITION_END_STATE_CHANGE_REQUIRED"
    );
  }
  if (cameraChanged && motion?.cameraMove?.mode !== "continuous") {
    throw frameReferenceModeError(
      "transition 的摄影机变化必须同时由 motion.cameraMove.mode=continuous 声明",
      "FRAME_TRANSITION_CAMERA_CHANGE_UNDECLARED"
    );
  }
  if (motion?.cameraMove?.mode === "continuous" && !cameraChanged) {
    throw frameReferenceModeError(
      "transition 的连续运镜必须在 EndState.camera 中留下可见终点差异",
      "FRAME_TRANSITION_CAMERA_END_STATE_REQUIRED"
    );
  }
  if (lightingChanged && !hasDeclaredFrameChange(motion?.lightingChange)) {
    throw frameReferenceModeError(
      "transition 的光线变化必须同时写入 motion.lightingChange",
      "FRAME_TRANSITION_LIGHTING_CHANGE_UNDECLARED"
    );
  }
  if (environmentChanged && !hasDeclaredFrameChange(motion?.environmentChange)) {
    throw frameReferenceModeError(
      `transition 的环境变化必须同时写入 motion.environmentChange；变化字段：${environmentChangedFields.join("、")}`,
      "FRAME_TRANSITION_ENVIRONMENT_CHANGE_UNDECLARED"
    );
  }
  if (timeAndWeatherChanged
    && !hasDeclaredFrameChange(motion?.environmentChange)
    && !hasDeclaredFrameChange(motion?.lightingChange)) {
    throw frameReferenceModeError(
      "transition 的时段或天气变化必须同时写入 motion.environmentChange 或 motion.lightingChange",
      "FRAME_TRANSITION_TIME_CHANGE_UNDECLARED"
    );
  }
  if (charactersChanged && !String(motion?.primaryAction || "").trim()) {
    throw frameReferenceModeError(
      "transition 的角色终点变化必须同时由 motion.primaryAction 声明",
      "FRAME_TRANSITION_CHARACTER_CHANGE_UNDECLARED"
    );
  }
  if (motion?.mode === "object_transform" && !(environmentChanged || charactersChanged)) {
    throw frameReferenceModeError(
      "object_transform 必须在 EndState 中留下可见物体状态差异",
      "FRAME_TRANSITION_OBJECT_END_STATE_REQUIRED"
    );
  }
  return frameReferenceMode;
}

function frameReferenceModeError(message, code) {
  return new InputError(message, [{ code }]);
}

function assertFrameReferenceSceneBoundary(shot, startFrame, endFrame) {
  const shotSceneId = String(shot.sceneId || "").trim();
  const startSceneId = String(startFrame?.environment?.sceneId || "").trim();
  const endSceneId = String(endFrame?.environment?.sceneId || "").trim();
  if (!shotSceneId || !startSceneId || !endSceneId) {
    throw frameReferenceModeError(
      "shot.sceneId、StartState.environment.sceneId 和 EndState.environment.sceneId 均不能为空",
      "FRAME_SCENE_ID_REQUIRED"
    );
  }
  if (shotSceneId !== startSceneId || shotSceneId !== endSceneId) {
    throw frameReferenceModeError(
      "尾帧参考模式只允许同一 sceneId；跨 sceneId 不得使用 transition 或普通镜头首尾帧策略",
      "FRAME_CROSS_SCENE_NOT_ALLOWED"
    );
  }
}

function animationFieldsChanged(startValue, endValue, fields) {
  return changedAnimationFields(startValue, endValue, fields).length > 0;
}

function changedAnimationFields(startValue, endValue, fields) {
  if (!startValue || !endValue) return [...fields];
  return fields.filter((field) => startValue[field] !== endValue[field]);
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(sortContractValue(left)) === JSON.stringify(sortContractValue(right));
}

function sortContractValue(value) {
  if (Array.isArray(value)) return value.map(sortContractValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortContractValue(value[key]);
    return result;
  }, {});
}

function hasDeclaredFrameChange(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return !/^(?:无|不变|没有变化|保持(?:不变|一致|连续|原样)?|同首帧)/u.test(text);
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
  if (hasVersion && value.promptSchemaVersion === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION) return false;
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

function ensureAnimationFoundationPromptSchemaVersion(value, path) {
  if (![animationPromptSchemaVersion, ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION].includes(value)) {
    throw new OutputContractError(
      `${path} 只允许 "${animationPromptSchemaVersion}" 或 "${ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION}"`
    );
  }
}

function validateAnimationFrameV2(frame, path, shotSceneId) {
  requireExactContractObject(frame, path, animationFrameFields);
  requireNonEmptyAnimationStaticLeaf(frame.timeAndWeather, `${path}.timeAndWeather`);
  if (!Array.isArray(frame.characters)) throw new OutputContractError(`${path}.characters 必须是数组`);
  const characterNames = new Set();
  frame.characters.forEach((character, index) => {
    const characterPath = `${path}.characters[${index}]`;
    requireExactContractObject(character, characterPath, animationFrameCharacterFields);
    animationFrameCharacterFields.forEach((field) => {
      const fieldPath = `${characterPath}.${field}`;
      if (field === "actionState") requireContractString(character[field], fieldPath);
      else if (field === "name") requireNonEmptyContractString(character[field], fieldPath);
      else requireNonEmptyAnimationStaticLeaf(character[field], fieldPath);
    });
    const normalizedName = character.name.trim();
    if (characterNames.has(normalizedName)) throw new OutputContractError(`${path}.characters 角色名不能重复：${normalizedName}`);
    characterNames.add(normalizedName);
  });

  requireExactContractObject(frame.environment, `${path}.environment`, animationFrameEnvironmentFields);
  animationFrameEnvironmentFields.forEach((field) => {
    const fieldPath = `${path}.environment.${field}`;
    if (field === "sceneId") requireNonEmptyContractString(frame.environment[field], fieldPath);
    else requireNonEmptyAnimationStaticLeaf(frame.environment[field], fieldPath);
  });
  if (frame.environment.sceneId !== shotSceneId) {
    throw new OutputContractError(`${path}.environment.sceneId 必须与镜头 sceneId ${shotSceneId} 完全一致`);
  }

  requireExactContractObject(frame.camera, `${path}.camera`, animationFrameCameraFields);
  animationFrameCameraFields.forEach((field) => requireNonEmptyContractString(frame.camera[field], `${path}.camera.${field}`));
  requireExactContractObject(frame.lighting, `${path}.lighting`, animationFrameLightingFields);
  animationFrameLightingFields.forEach((field) => requireNonEmptyAnimationStaticLeaf(frame.lighting[field], `${path}.lighting.${field}`));
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
  } else if (motion.mode !== "loop") {
    assertContinuousCameraEndpointDifference(startFrame.camera, endFrame.camera, path);
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

export const STATIC_FRAME_PROCESS_OR_AUDIO_TERMS = Object.freeze([
  "逐渐",
  "随后",
  "然后",
  "正在",
  "镜头移动",
  "运镜",
  "对白",
  "音效"
]);

export const STATIC_FRAME_INVISIBLE_INTENT_TERMS = Object.freeze([
  "准备",
  "即将",
  "将要",
  "想要",
  "试图"
]);

const AI_REVIEWED_STATIC_CHARACTER_FIELDS = Object.freeze([
  "pose",
  "handPropState",
  "actionState"
]);

function validateStaticAnimationFrame(frame, path) {
  const fields = [];
  collectStructuredFramePositiveFields(fields, path, frame);
  for (const field of fields) {
    if (isAiReviewedStaticCharacterField(field.path)) continue;
    const hit = STATIC_FRAME_PROCESS_OR_AUDIO_TERMS.find((term) => hasStaticFrameLintOccurrence(field.value, term));
    if (hit) {
      throw new OutputContractError(
        `${field.path} 是静态帧字段，不得包含过程、运镜、对白或音效措辞：${hit}`,
        [{ code: "STATIC_FRAME_PROCESS_OR_AUDIO", path: field.path, reason: `命中静态帧不允许的过程、运镜、对白或音效措辞：${hit}` }]
      );
    }
    const intentHit = STATIC_FRAME_INVISIBLE_INTENT_TERMS.find((term) => String(field.value || "").includes(term));
    if (intentHit) {
      throw new OutputContractError(
        `${field.path} 是静态帧字段，不得包含无法直接画出的意图措辞：${intentHit}`,
        [{ code: "STATIC_FRAME_INVISIBLE_INTENT", path: field.path, reason: `命中单张画面无法直接观察的意图措辞：${intentHit}` }]
      );
    }
  }
}

function isAiReviewedStaticCharacterField(path) {
  const value = String(path || "");
  return AI_REVIEWED_STATIC_CHARACTER_FIELDS.some((field) => (
    value.endsWith(`.${field}`) && value.includes(".characters[")
  ));
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

function assertContinuousCameraEndpointDifference(startCamera, endCamera, path) {
  const changed = animationFrameCameraFields.filter((field) => startCamera[field] !== endCamera[field]);
  if (changed.length) return;
  const shotPath = String(path || "").replace(/\.motion$/u, "");
  const cameraPath = `${shotPath}.endFrame.camera`;
  throw new OutputContractError(
    `${path}.cameraMove.mode=continuous 时 EndState.camera 必须留下与运镜终点一致的可见差异`,
    [{
      code: "CONTINUOUS_CAMERA_ENDPOINT_MISSING",
      path: cameraPath,
      reason: "连续运镜已声明，但 EndState.camera 的景别、机位、角度、观察方向、镜头质感、景深和构图与 StartState.camera 完全相同；请只重建可见的终点 camera 状态"
    }]
  );
}

function validateLoopEndpointCompatibility(startFrame, endFrame, motion, path) {
  if (!/(?:回到|回归|恢复|闭环|循环|首帧|起始|初始|start\s*frame)/iu.test(motion.stopCondition)) {
    throw new OutputContractError(`${path}.stopCondition 必须明确循环回到起始/首帧状态后停止`);
  }
  if (startFrame.timeAndWeather !== endFrame.timeAndWeather) {
    throw new OutputContractError(`${path} 循环镜头首尾 timeAndWeather 必须完全相同`);
  }
  const environmentChanged = animationFrameEnvironmentFields.filter(
    (field) => startFrame.environment[field] !== endFrame.environment[field]
  );
  if (environmentChanged.length) {
    throw new OutputContractError(`${path} 循环镜头首尾 environment 必须完全相同；变化字段：${environmentChanged.join("、")}`);
  }
  assertCameraCoreEquality(startFrame.camera, endFrame.camera, path);
  const lightingChanged = animationFrameLightingFields.filter(
    (field) => startFrame.lighting[field] !== endFrame.lighting[field]
  );
  if (lightingChanged.length) {
    throw new OutputContractError(`${path} 循环镜头首尾 lighting 必须完全相同；变化字段：${lightingChanged.join("、")}`);
  }
  if (!sameCanonicalValue(startFrame.styleModifiers, endFrame.styleModifiers)) {
    throw new OutputContractError(`${path} 循环镜头首尾 styleModifiers 必须完全相同`);
  }
  if (!sameCanonicalValue(startFrame.continuityLocks, endFrame.continuityLocks)) {
    throw new OutputContractError(`${path} 循环镜头首尾 continuityLocks 必须完全相同`);
  }

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

function requireNonEmptyAnimationStaticLeaf(value, path) {
  requireContractString(value, path);
  if (!value.trim()) {
    throw new OutputContractError(
      `${path} 不能为空`,
      [{ code: "STATIC_FRAME_REQUIRED", path, reason: "静态端点字段不能为空，必须改写为单张画面可直接观察的状态" }]
    );
  }
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
  validateGlobalCharacterBoundary(value.fixedCharacterBoundary);
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
    validateSourceExpressionExcerptBinding(item, path);
  });
  value.dialogueRules.forEach((item, index) => {
    const path = `visualGuardrails.dialogueRules[${index}]`;
    requireRuleObject(item, path, ["text", "triggerEvidence"]);
    if (!String(item.text || "").trim()) throw new OutputContractError(`${path}.text 不能为空`);
    validateTriggerEvidenceShape(item.triggerEvidence, `${path}.triggerEvidence`, { requireNonEmpty: true });
  });
}

// 只归一化模型可以合法变动的排版：引号样式、空白和句末标点。
// 不做任何中文语法或词性推断——猜测被省略的中心名词正是本规则禁止的行为。
function normalizeSourceExpressionExcerpt(value) {
  return String(value)
    .replace(/[“”"'‘’「」『』（）()]/gu, "")
    .replace(/\s+/gu, "")
    .replace(/[。．.,，；;、]+$/gu, "");
}

function sourceExpressionEnumerationItems(value) {
  return String(value)
    .split(/[、,，;；]/u)
    .map((part) => normalizeSourceExpressionExcerpt(part))
    .filter(Boolean);
}

// sourceExpression 的每一项都必须逐字出现在本条规则自己引用的 evidence 中。
// 模型一旦补全上游省略的中心名词（例如把“投递信件至绿色邮箱、红色邮箱”展开成
// “投递信件至红色邮箱”），产出的字符串就不可能逐字存在于 evidence 里，于是在此 fail closed。
// 按 AGENTS.md：上游含歧义缩写时必须重新生成对应阶段，不得在下游原地推断或改写。
function validateSourceExpressionExcerptBinding(item, path) {
  const evidences = (Array.isArray(item.triggerEvidence) ? item.triggerEvidence : [])
    .map((entry) => normalizeSourceExpressionExcerpt(entry?.evidence));
  const missing = sourceExpressionEnumerationItems(item.sourceExpression)
    .filter((part) => !evidences.some((evidence) => evidence.includes(part)));
  if (!missing.length) return;
  throw new OutputContractError(
    `${path}.sourceExpression 含未出现在自身 triggerEvidence 中的表达：${missing.join("、")}。`
    + "来源表面表达只能逐字引用上游证据；上游若使用了共享中心名词的缩写，必须重新生成对应上游阶段，不得在此补全或改写。"
  );
}

function validateGlobalCharacterBoundary(boundary) {
  const unexpected = Object.keys(boundary).filter((key) => !characterBoundaryFields.has(key));
  const missing = [...characterBoundaryModelFields].filter((key) => !Object.prototype.hasOwnProperty.call(boundary, key));
  if (unexpected.length || missing.length) {
    throw new OutputContractError(
      "visualGuardrails.fixedCharacterBoundary 字段不符合全局边界契约"
      + `${unexpected.length ? `；额外字段：${unexpected.join("、")}` : ""}`
      + `${missing.length ? `；缺少字段：${missing.join("、")}` : ""}`
    );
  }
  if (boundary.schemaVersion !== GLOBAL_CHARACTER_BOUNDARY_VERSION) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.schemaVersion 必须为 ${GLOBAL_CHARACTER_BOUNDARY_VERSION}`);
  }
  const presentSealFields = characterBoundarySealFields.filter((field) => Object.prototype.hasOwnProperty.call(boundary, field));
  if (presentSealFields.length && presentSealFields.length !== characterBoundarySealFields.length) {
    throw new OutputContractError("visualGuardrails.fixedCharacterBoundary 签发字段必须同时存在");
  }
  for (const field of ["characterName", "canonicalDescription", "bodyForm", ...presentSealFields]) {
    if (typeof boundary[field] !== "string" || !boundary[field].trim()) {
      throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${field} 必须是非空字符串`);
    }
  }
  for (const field of ["requiredTraits", "allowedTraits", "forbiddenTraits", "unresolvedConflicts"]) {
    if (!Array.isArray(boundary[field])) {
      throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${field} 必须是数组`);
    }
  }
  for (const field of ["requiredTraits", "allowedTraits", "forbiddenTraits"]) {
    boundary[field].forEach((trait, index) => validateGlobalCharacterBoundaryTrait(trait, `${field}[${index}]`));
  }
  boundary.unresolvedConflicts.forEach((conflict, index) => {
    requireRuleObject(conflict, `visualGuardrails.fixedCharacterBoundary.unresolvedConflicts[${index}]`, ["topic", "evidence", "reason"]);
    if (![conflict.topic, conflict.evidence, conflict.reason].every((item) => typeof item === "string" && item.trim())) {
      throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.unresolvedConflicts[${index}] 字段不能为空`);
    }
  });
  const requiredTerms = new Set(boundary.requiredTraits.flatMap((trait) => trait.terms));
  const forbiddenTerms = new Set(boundary.forbiddenTraits.flatMap((trait) => trait.terms));
  const conflicts = [...requiredTerms].filter((term) => forbiddenTerms.has(term));
  if (conflicts.length) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary 同时要求并禁止：${conflicts.join("、")}`);
  }
}

function validateGlobalCharacterBoundaryTrait(trait, path) {
  requireRuleObject(trait, `visualGuardrails.fixedCharacterBoundary.${path}`, [...characterBoundaryTraitFields]);
  const unexpected = Object.keys(trait).filter((key) => !characterBoundaryTraitFields.has(key));
  if (unexpected.length) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path} 包含未知字段：${unexpected.join("、")}`);
  }
  if (typeof trait.canonicalName !== "string" || !trait.canonicalName.trim()) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.canonicalName 不能为空`);
  }
  if (!Array.isArray(trait.terms) || !trait.terms.length || trait.terms.some((term) => typeof term !== "string" || !term.trim())) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.terms 必须是非空字符串数组`);
  }
  if (!trait.terms.includes(trait.canonicalName)) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.terms 必须包含 canonicalName`);
  }
  if (!characterBoundaryTraitScopes.has(trait.scope)) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.scope 不受支持`);
  }
  if (!characterBoundaryEvidenceLevels.has(trait.evidenceLevel)) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.evidenceLevel 只允许 explicit 或 inferred`);
  }
  if (typeof trait.reason !== "string" || !trait.reason.trim()) {
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary.${path}.reason 不能为空`);
  }
  validateTriggerEvidenceShape(
    trait.triggerEvidence,
    `visualGuardrails.fixedCharacterBoundary.${path}.triggerEvidence`,
    { requireNonEmpty: true }
  );
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

export function materializeGlobalCharacterBoundaryViews(value, creatorProfile = {}) {
  const boundary = value?.fixedCharacterBoundary || {};
  const fixedCharacterName = String(
    boundary.characterName || extractFixedCharacterName(creatorProfile.fixedCharacter) || "固定主角"
  ).trim();
  const fixedEvidence = [{
    sourcePath: "creatorProfile.fixedCharacter",
    evidence: String(creatorProfile.fixedCharacter || "").trim()
  }];
  const allowedPositiveTraits = [...(boundary.requiredTraits || []), ...(boundary.allowedTraits || [])].map((trait) => ({
    term: trait.canonicalName,
    scope: trait.scope,
    reason: trait.reason
  }));
  const requiredNames = (boundary.requiredTraits || []).map((trait) => trait.canonicalName);
  const forbiddenNames = (boundary.forbiddenTraits || []).map((trait) => trait.canonicalName);
  const ruleParts = [
    requiredNames.length ? `固定角色「${fixedCharacterName}」必须沿用：${requiredNames.join("、")}` : "",
    forbiddenNames.length ? `固定角色「${fixedCharacterName}」不得具有：${forbiddenNames.join("、")}` : "",
    "该边界只约束固定角色，不套用到配角、道具、对白或声音；后续阶段不得重新推断、删除或替换固定角色事实"
  ].filter(Boolean);
  return {
    ...value,
    allowedPositiveTraits,
    positivePromptBoundary: [{
      rule: ruleParts.join("；"),
      triggerEvidence: fixedEvidence,
      severity: "block"
    }]
  };
}

export function normalizeGlobalCharacterBoundaryTerms(value) {
  const boundary = value?.fixedCharacterBoundary;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return value;
  const normalizedBoundary = { ...boundary };
  for (const field of ["requiredTraits", "allowedTraits", "forbiddenTraits"]) {
    if (!Array.isArray(boundary[field])) continue;
    normalizedBoundary[field] = boundary[field].map((trait) => {
      if (!trait || typeof trait !== "object" || Array.isArray(trait)
        || typeof trait.canonicalName !== "string" || !trait.canonicalName.trim()
        || !Array.isArray(trait.terms)) {
        return trait;
      }
      return {
        ...trait,
        terms: [...new Set([trait.canonicalName, ...trait.terms])]
      };
    });
  }
  return {
    ...value,
    fixedCharacterBoundary: normalizedBoundary
  };
}

export function ensureVisualGuardrailsMatchesProfile(value, creatorProfile = {}) {
  value = materializeGlobalCharacterBoundaryViews(value, creatorProfile);
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (!fixedName) return value;

  const boundary = value.fixedCharacterBoundary || {};
  const mismatches = [];
  if (boundary.characterName !== fixedName) {
    mismatches.push(`未围绕固定角色「${fixedName}」生成外观规则`);
  }
  if (boundary.unresolvedConflicts?.length) {
    mismatches.push(`存在未解决的用户设定冲突：${boundary.unresolvedConflicts.map((item) => item.topic).join("、")}`);
  }
  if (!boundary.requiredTraits?.length) {
    mismatches.push("缺少全局必需角色事实 requiredTraits");
  }
  if (!value.positivePromptBoundary.length) {
    mismatches.push("缺少用于后续正向提示词审查的 positivePromptBoundary");
  }
  if (mismatches.length) throw new OutputContractError(`visualGuardrails 未锁定固定角色：${mismatches.join("；")}`);
  return value;
}

// 递归收集上游对象里的全部字符串，用于逐字证据比对。
function collectUpstreamText(value, sink = []) {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectUpstreamText(item, sink));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectUpstreamText(item, sink));
  return sink;
}

// 【原片有】只证明模型给出了判定，不证明判定为真——校验器此前从未见过原片。
// 因此要求该分支用「」引出上游依据，再回到上游核对它确实发生过。
//
// 判据是字符覆盖率而不是逐字子串。Brief 阶段的模型正在做归纳，引用时必然转述：
// 上游写"为睡着的企鹅装女孩盖上白色毯子"，模型会写成"给睡着的角色盖上白毯子"。
// 逐字比对把这种忠实转述判成编造，实测每换一个参考视频都会阻断整个阶段。
// 覆盖率对转述稳健，同时把复用真词汇拼出的编造挡在阈值之外（实测 0.54 对 0.80）。
// 用最长公共子序列，字符级、语言无关，不做中文语法推断也不引入词典。
const CITATION_COVERAGE_THRESHOLD = 0.75;

function longestCommonSubsequenceLength(a, b) {
  let previous = new Array(b.length + 1).fill(0);
  let current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length];
}

function citationCoverage(clause, upstreamTexts) {
  if (!clause) return 1;
  let best = 0;
  for (const text of upstreamTexts) {
    if (text.includes(clause)) return 1;
    best = Math.max(best, longestCommonSubsequenceLength(clause, text) / clause.length);
    if (best >= 1) break;
  }
  return best;
}

function citationClauses(value) {
  return String(value)
    .split(/[、,，;；。．.!！?？:：]/u)
    .map((part) => normalizeSourceExpressionExcerpt(part))
    .filter(Boolean);
}

function validateNarrativeComponentCitations(components, upstream) {
  // 逐条归一化后各自保留：拼成一整串会让相邻字段在去空白后粘连，制造跨字段的假匹配。
  const upstreamTexts = collectUpstreamText(upstream)
    .map((entry) => normalizeSourceExpressionExcerpt(entry))
    .filter(Boolean);
  if (!upstreamTexts.length) return;
  (Array.isArray(components) ? components : []).forEach((item, index) => {
    const assessment = String(item?.howToReuseSafely || "").trim();
    if (!assessment.startsWith("【原片有】")) return;
    const path = `creativeBrief.allowedNarrativeComponents[${index}]（${item?.component}）.howToReuseSafely`;
    const citations = [...assessment.matchAll(/「([^」]+)」/gu)].map((match) => match[1].trim()).filter(Boolean);
    if (!citations.length) {
      throw new OutputContractError(
        `${path} 判定为【原片有】时必须用「」引出一段 sourceScriptReconstruction 或 referenceAnalysis 中的逐字原文作为依据。`
      );
    }
    const missing = citations.flatMap((citation) => citationClauses(citation)
      .map((clause) => ({ clause, coverage: citationCoverage(clause, upstreamTexts) }))
      .filter((entry) => entry.coverage < CITATION_COVERAGE_THRESHOLD));
    if (missing.length) {
      throw new OutputContractError(
        `${path} 引用的内容在上游找不到对应事实：`
        + `${missing.map((entry) => `「${entry.clause}」（覆盖率 ${entry.coverage.toFixed(2)}）`).join("、")}。`
        + "存在性判定只能引用原片确实发生过的内容，不得为原片补出它没有的叙事构件；"
        + "允许转述，但必须能在 referenceAnalysis 或 sourceScriptReconstruction 中找到对应原文。"
      );
    }
  });
}

export function ensureCreativeBriefMatchesProfile(value, creatorProfile = {}, upstream = null) {
  if (upstream) validateNarrativeComponentCitations(value?.allowedNarrativeComponents, upstream);
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (!fixedName) return value;

  const mappingText = JSON.stringify(value.roleAndOccupationMapping || []);
  if (!mappingText.includes(fixedName)) {
    throw new OutputContractError(`creativeBrief 未将固定角色「${fixedName}」写入角色映射`);
  }

  if (!String(value.roleAndOccupationMapping?.[0]?.newRole || "").includes(fixedName)) {
    throw new OutputContractError(
      `creativeBrief.roleAndOccupationMapping[0].newRole 必须保留固定角色姓名“${fixedName}”，不得更换或重命名主角`
    );
  }

  return value;
}

// 多个变体共用同一条 dramaticFunction 序列时，它们只是同一个故事的不同布景，
// 变体数量就失去意义。这里只裁决"全部雷同"这一个可确定性判定的下界：
// 无法判断"是否真的足够不同"，那属于语义，不在本地校验范围内。
function validateVariantStructuralDivergence(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return;
  const sequences = variants.map((variant, index) => {
    const outline = Array.isArray(variant?.storyOutline) ? variant.storyOutline : [];
    const functions = outline.map((beat) => String(beat?.dramaticFunction || "").trim());
    if (!outline.length || functions.some((entry) => !entry)) {
      throw new OutputContractError(
        `themeVariants.variants[${index}]（${variant?.id || `V${index + 1}`}）的 storyOutline `
        + "每个 beat 都必须填写非空 dramaticFunction，否则无法判定各方案的结构是否真的不同"
      );
    }
    return functions.join(" › ");
  });
  if (new Set(sequences).size > 1) return;
  throw new OutputContractError(
    `themeVariants 的 ${variants.length} 个方案共用同一条 dramaticFunction 序列（${sequences[0]}）。`
    + "至少要有两个方案在危机位置、成败节奏或结尾情绪上结构不同；"
    + "只更换季节、天气、交通工具、道具或帮助者称谓不构成不同主题。"
  );
}

export function ensureThemeVariantsMatchProfile(value, creatorProfile = {}, creativeBrief = null, visualGuardrails = null) {
  validateVariantStructuralDivergence(value?.variants);
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (!fixedName) return value;
  const protagonistLeakTerms = collectGlobalCharacterForbiddenTerms(visualGuardrails);
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
      mismatches.push(`${label} 的 protagonist 使用了固定角色边界签发的禁止特征：${protagonistHits.join("、")}`);
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

  const protagonistLeakTerms = collectGlobalCharacterForbiddenTerms(visualGuardrails);
  const protagonist = value.characterBible?.protagonist || {};
  const protagonistText = JSON.stringify(protagonist);
  const fullText = JSON.stringify(value);
  const strictPositiveFields = collectFullStoryStrictPositiveFields(value);
  const rulePositiveFields = collectFullStoryRuleFields(value);
  const protagonistPositiveFields = strictPositiveFields.filter((field) => (
    field.path.startsWith("characterBible.protagonist.")
  ));
  const protagonistRuleFields = rulePositiveFields.filter((field) => (
    field.path.startsWith("characterBible.protagonist.")
  ));

  const fixedCharacterMismatches = [];
  if (!protagonistText.includes(fixedName)) {
    fixedCharacterMismatches.push(`characterBible.protagonist 未包含固定角色「${fixedName}」`);
  }
  if (!fullText.includes(fixedName)) {
    fixedCharacterMismatches.push(`fullStory 未使用固定角色「${fixedName}」`);
  }
  const protagonistHits = dedupeFieldTermHits([
    ...findFieldTermHits(protagonistPositiveFields, protagonistLeakTerms),
    ...findFieldTermHits(protagonistRuleFields, protagonistLeakTerms, { allowNegativeContext: true })
  ]);
  if (protagonistHits.length) {
    fixedCharacterMismatches.push(
      `主角设定使用了固定角色边界签发的禁止特征：${formatFieldTermHits(protagonistHits)}`
    );
  }
  if (fixedCharacterMismatches.length) {
    throw new OutputContractError(`fullStory 未锁定固定角色：${fixedCharacterMismatches.join("；")}`);
  }

  return value;
}

export function ensureAnimationPlanMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null, visualGuardrails = null, context = {}) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`animationPlan.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  const semanticContext = { ...context, creatorProfile, creativeBrief, variant, visualGuardrails };
  if (!fixedName) return ensureAnimationPlanNegativePrompts(value, semanticContext);

  const referenceFields = collectAnimationReferenceFields(value);
  const fixedCharacterName = String(
    visualGuardrails?.fixedCharacterBoundary?.characterName || fixedName
  ).trim();
  const fixedReferenceIndexes = (value.characterReferencePrompts || [])
    .map((reference, index) => (
      String(reference?.characterName || "").trim() === fixedCharacterName ? index : -1
    ))
    .filter((index) => index >= 0);
  const fixedReferenceIndex = fixedReferenceIndexes.length === 1
    ? fixedReferenceIndexes[0]
    : null;
  const fixedReferencePath = fixedReferenceIndex === null
    ? "characterReferencePrompts"
    : `characterReferencePrompts[${fixedReferenceIndex}]`;
  const fixedReferenceFields = fixedReferenceIndex === null
    ? []
    : referenceFields.filter((field) => (
      field.path === fixedReferencePath || field.path.startsWith(`${fixedReferencePath}.`)
    ));
  const fixedReferenceText = fixedReferenceFields.map((field) => field.value).join("\n");
  const fullText = JSON.stringify(value);

  const mismatches = [];
  const details = [];
  if (fixedReferenceIndexes.length !== 1) {
    const reason = fixedReferenceIndexes.length
      ? `characterReferencePrompts 中固定角色「${fixedCharacterName}」必须恰好出现一次，当前 ${fixedReferenceIndexes.length} 次`
      : `characterReferencePrompts 未包含固定角色「${fixedCharacterName}」`;
    mismatches.push(reason);
    details.push(animationProfileDiagnostic({
      code: fixedReferenceIndexes.length
        ? "ANIMATION_FIXED_CHARACTER_REFERENCE_NOT_UNIQUE"
        : "ANIMATION_FIXED_CHARACTER_REFERENCE_MISSING",
      path: "characterReferencePrompts",
      reason,
      visualGuardrails,
      sourcePaths: ["visualGuardrails.fixedCharacterBoundary.characterName"]
    }));
  }
  if (!fullText.includes(fixedName)) {
    mismatches.push(`animationPlan 未使用固定角色「${fixedName}」`);
    details.push(animationProfileDiagnostic({
      code: "ANIMATION_FIXED_CHARACTER_USAGE_MISSING",
      path: "",
      reason: `animationPlan 未使用固定角色「${fixedName}」`,
      visualGuardrails,
      sourcePaths: ["visualGuardrails.fixedCharacterBoundary.characterName"]
    }));
  }
  const missingRequiredTraits = fixedReferenceIndex === null
    ? []
    : findMissingGlobalCharacterTraits(
      fixedReferenceText,
      visualGuardrails?.fixedCharacterBoundary?.requiredTraits
    );
  if (missingRequiredTraits.length) {
    mismatches.push(`角色参考提示词未沿用全局必需角色事实：${missingRequiredTraits.join("、")}`);
    details.push(animationProfileDiagnostic({
      code: "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING",
      path: fixedReferencePath,
      reason: `固定角色参考缺少全局必需角色事实：${missingRequiredTraits.join("、")}`,
      visualGuardrails,
      sourcePaths: ["visualGuardrails.fixedCharacterBoundary.requiredTraits"],
      extra: { missingRequiredTraits }
    }));
  }
  const boundaryForbiddenTerms = collectGlobalCharacterForbiddenTerms(visualGuardrails);
  // 角色参考提示词里"无翅膀、无鸟喙、无企鹅服装"是给图像模型的否定约束，是正确写法。
  // 与 protagonist 规则字段一致放行否定语境，否则模型写对了反而被判成使用了禁止特征。
  const referenceHits = fixedReferenceIndex === null
    ? []
    : findFieldTermHits(fixedReferenceFields, boundaryForbiddenTerms, { allowNegativeContext: true });
  if (referenceHits.length) {
    mismatches.push(`固定角色参考提示词使用了签发禁止特征：${formatFieldTermHits(referenceHits)}`);
    referenceHits.forEach((hit) => {
      details.push(animationProfileDiagnostic({
        code: "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM",
        path: hit.path,
        reason: `角色参考提示词包含禁止特征：${hit.term}`,
        visualGuardrails,
        sourcePaths: ["visualGuardrails.fixedCharacterBoundary.forbiddenTraits"],
        extra: { matchedTerm: hit.term }
      }));
    });
  }
  const structuredFixedCharacterHits = findFieldTermHits(
    collectAnimationStructuredFixedCharacterFields(value, fixedCharacterName),
    boundaryForbiddenTerms
  );
  if (structuredFixedCharacterHits.length) {
    mismatches.push(
      `固定角色镜头字段使用了签发禁止特征：${formatFieldTermHits(structuredFixedCharacterHits)}`
    );
    structuredFixedCharacterHits.forEach((hit) => {
      details.push(animationProfileDiagnostic({
        code: "ANIMATION_FIXED_CHARACTER_FORBIDDEN_TERM",
        path: hit.path,
        reason: `固定角色镜头字段包含禁止特征：${hit.term}`,
        visualGuardrails,
        sourcePaths: ["visualGuardrails.fixedCharacterBoundary.forbiddenTraits"],
        extra: { matchedTerm: hit.term }
      }));
    });
  }
  if (mismatches.length) {
    throw new OutputContractError(
      `animationPlan 未锁定固定角色：${mismatches.join("；")}`,
      details
    );
  }
  return ensureAnimationPlanNegativePrompts(value, semanticContext);
}

function animationProfileDiagnostic({
  code,
  path,
  reason,
  visualGuardrails,
  sourcePaths = [],
  extra = {}
}) {
  const boundary = visualGuardrails?.fixedCharacterBoundary || {};
  return {
    code,
    path,
    jsonPointer: animationProfileJsonPointer(path),
    reason,
    authority: {
      sourcePaths,
      characterName: String(boundary.characterName || ""),
      boundaryDigest: String(boundary.boundaryDigest || "")
    },
    ...extra
  };
}

function animationProfileJsonPointer(path) {
  const source = String(path || "");
  if (!source) return "";
  const tokens = [];
  const pattern = /(?:^|\.)([^.\[\]]+)|\[(\d+)\]/gu;
  let consumed = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index !== consumed) return "";
    const token = match[1] ?? match[2];
    if (["__proto__", "prototype", "constructor"].includes(token)) return "";
    tokens.push(token);
    consumed = match.index + match[0].length;
  }
  if (!tokens.length || consumed !== source.length) return "";
  return `/${tokens
    .map((token) => String(token).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

export function ensureCharacterReferenceMatchesBoundary(value, visualGuardrails = null) {
  const boundary = visualGuardrails?.fixedCharacterBoundary;
  if (!boundary || String(value?.characterName || "").trim() !== String(boundary.characterName || "").trim()) return value;
  const fields = [
    value.characterName,
    value.storyRole,
    value.identity,
    value.appearancePrompt,
    ...(Array.isArray(value.consistencyTags) ? value.consistencyTags : [])
  ].filter(Boolean).join("\n");
  const forbiddenHits = findTerms(fields, collectGlobalCharacterForbiddenTerms(visualGuardrails));
  const missingRequiredTraits = findMissingGlobalCharacterTraits(fields, boundary.requiredTraits);
  const mismatches = [];
  if (forbiddenHits.length) mismatches.push(`混入全局边界禁止特征：${forbiddenHits.join("、")}`);
  if (missingRequiredTraits.length) mismatches.push(`缺少全局必需角色事实：${missingRequiredTraits.join("、")}`);
  if (mismatches.length) throw new OutputContractError(`characterReference 未沿用全局角色边界：${mismatches.join("；")}`);
  return value;
}

export function ensureCharacterPromptMatchesBoundary(text, visualGuardrails = null, {
  characterName = "",
  requireRequiredTraits = true,
  promptScope = "fixed_character"
} = {}) {
  const boundary = visualGuardrails?.fixedCharacterBoundary;
  if (!boundary) return text;
  if (promptScope === "multi_character") return text;
  if (characterName && String(characterName).trim() !== String(boundary.characterName || "").trim()) return text;
  const value = String(text || "");
  const forbiddenHits = findTerms(value, collectGlobalCharacterForbiddenTerms(visualGuardrails), {
    allowNegativeContext: true
  });
  const missingRequiredTraits = requireRequiredTraits
    ? findMissingGlobalCharacterTraits(value, boundary.requiredTraits)
    : [];
  const mismatches = [];
  if (forbiddenHits.length) mismatches.push(`混入全局边界禁止特征：${forbiddenHits.join("、")}`);
  if (missingRequiredTraits.length) mismatches.push(`缺少全局必需角色事实：${missingRequiredTraits.join("、")}`);
  if (mismatches.length) throw new InputError(`角色生成提示词未沿用全局角色边界：${mismatches.join("；")}`);
  return value;
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

  const bodyHits = findTerms(item.text, collectGlobalCharacterAppearanceTerms(context.visualGuardrails));
  if (bodyHits.length && !bodyTermsHaveConcreteEvidence(bodyHits, evidence)) return false;
  if (bodyHits.some((term) => /爪|肉垫/u.test(term)) && !limbAnimalizationRiskIsProven(evidence, shot, context, media)) return false;

  return true;
}

function isUsableNegativePromptEvidence(entry, { context, plan, shot, shotIndex, media, reasonCode }) {
  const sourcePath = String(entry?.sourcePath || "").trim();
  const evidence = String(entry?.evidence || "").trim();
  if (!sourcePath || !evidence) return false;

  const shotMatch = sourcePath.match(/^animationPlan\.(?:shotPlan|shots)\[([^\]]+)\]\.(startFramePrompt|endFramePrompt|videoPrompt|cameraMotion|characterAction|dialogueOrSubtitle|soundDesign|continuityNotes)$/u);
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
  const values = [
    shot.startFramePrompt,
    shot.endFramePrompt,
    shot.videoPrompt,
    shot.cameraMotion,
    shot.characterAction,
    shot.dialogueOrSubtitle,
    shot.soundDesign,
    shot.continuityNotes
  ];
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
    if (entry.sourcePath === "creatorProfile.fixedCharacter") return false;
    const usesUnspecifiedWording = /未声明|未提及|没有声明|没有提及|未设定|没有设定/u.test(entry.evidence);
    if (!usesUnspecifiedWording) return true;
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

const protagonistSurfaceTerms = [...sourceSurfaceIdentityTerms];

const protectedTermStopWords = new Set([
  "台词", "视觉元素", "特定动作", "禁止", "直接使用", "高度相似", "表述", "形象", "服装", "动作", "约定", "一只", "动物"
]);

function validateNarrativeComponents(components) {
  const required = CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS;
  const names = components.map((item) => item?.component);
  const present = new Set(names);
  const missing = required.filter((name) => !present.has(name));
  if (missing.length) throw new OutputContractError(`creativeBrief 未逐项评估可复用叙事构件：${missing.join("、")}`);
  const unexpected = [...present].filter((name) => !required.includes(name));
  if (unexpected.length) {
    throw new OutputContractError(`creativeBrief.allowedNarrativeComponents 使用了非服务端签发分类：${unexpected.join("、")}`);
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) {
    throw new OutputContractError(`creativeBrief.allowedNarrativeComponents 重复分类：${[...new Set(duplicates)].join("、")}`);
  }
  components.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new OutputContractError(`creativeBrief.allowedNarrativeComponents[${index}] 必须是对象`);
    }
    if (typeof item.howToReuseSafely !== "string" || !item.howToReuseSafely.trim()) {
      throw new OutputContractError(
        `creativeBrief.allowedNarrativeComponents[${index}].howToReuseSafely 必须填写非空评估`
      );
    }
    const assessment = item.howToReuseSafely.trim();
    if (!CREATIVE_BRIEF_COMPONENT_PRESENCE_MARKERS.some((marker) => assessment.startsWith(marker))) {
      throw new OutputContractError(
        `creativeBrief.allowedNarrativeComponents[${index}]（${item.component}）.howToReuseSafely `
        + `必须以 ${CREATIVE_BRIEF_COMPONENT_PRESENCE_MARKERS.join(" 或 ")} 开头，`
        + "先判定原片是否真的存在该构件，再说明如何复用或为何不采用。"
      );
    }
  });
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
  const terms = new Set();
  for (const term of collectProtectedTermsFromBrief(brief, fixedProfile)) {
    if (!isCoveredByGlobalCharacterBoundaryPattern(term, visualGuardrails)) terms.add(term);
  }
  for (const term of collectVisualGuardrailForbiddenTerms(visualGuardrails, fixedProfile)) terms.add(term);
  for (const term of collectGlobalCharacterForbiddenTerms(visualGuardrails)) terms.add(term);
  return [...terms].filter(Boolean);
}

export function collectAnimationReferenceForbiddenTermSourcePaths(
  rawTerm,
  _brief,
  _fixedProfile = "",
  visualGuardrails = null
) {
  const term = String(rawTerm || "").trim();
  if (!term) return [];
  return collectGlobalCharacterForbiddenTerms(visualGuardrails).includes(term)
    ? ["visualGuardrails.fixedCharacterBoundary.forbiddenTraits"]
    : [];
}

export function collectVisualGuardrailForbiddenTerms(visualGuardrails, fixedProfile = "") {
  if (!visualGuardrails || typeof visualGuardrails !== "object") return [];
  const terms = new Set();
  for (const term of collectVisualGuardrailRawForbiddenTerms(visualGuardrails)) {
    if (!isCoveredByGlobalCharacterBoundaryPattern(term, visualGuardrails)) terms.add(term);
  }
  return [...terms];
}

export function collectVisualGuardrailAllowedTerms(visualGuardrails, fixedProfile = "") {
  const terms = new Set(collectGlobalCharacterAllowedTerms(visualGuardrails));
  return [...terms].filter(Boolean);
}

export function collectGlobalCharacterAllowedTerms(visualGuardrails) {
  const boundary = visualGuardrails?.fixedCharacterBoundary || {};
  return uniqueBoundaryTerms([...(boundary.requiredTraits || []), ...(boundary.allowedTraits || [])]);
}

export function collectGlobalCharacterForbiddenTerms(visualGuardrails) {
  return uniqueBoundaryTerms(visualGuardrails?.fixedCharacterBoundary?.forbiddenTraits || []);
}

function collectGlobalCharacterAppearanceTerms(visualGuardrails) {
  const boundary = visualGuardrails?.fixedCharacterBoundary || {};
  return uniqueBoundaryTerms([
    ...(boundary.requiredTraits || []),
    ...(boundary.allowedTraits || []),
    ...(boundary.forbiddenTraits || [])
  ].filter((trait) => trait?.scope === "appearance"));
}

function uniqueBoundaryTerms(traits = []) {
  return [...new Set((traits || []).flatMap((trait) => Array.isArray(trait?.terms) ? trait.terms : []).map((term) => String(term || "").trim()).filter(Boolean))];
}

function findMissingGlobalCharacterTraits(text, traits = []) {
  const value = String(text || "");
  return (traits || []).filter((trait) => !(trait.terms || []).some((term) => term && value.includes(term)))
    .map((trait) => trait.canonicalName);
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

function isAllowedByGlobalCharacterBoundary(term, visualGuardrails = null) {
  const value = String(term || "");
  if (!value) return false;
  const allowed = new Set(collectGlobalCharacterAllowedTerms(visualGuardrails));
  return allowed.has(value);
}

function isCoveredByGlobalCharacterBoundaryPattern(term, visualGuardrails = null) {
  const value = compactBoundaryMatchTerm(term);
  if (!value) return false;
  const allowedTerms = collectGlobalCharacterAllowedTerms(visualGuardrails).map(compactBoundaryMatchTerm);
  const characters = [...value];
  if (characters.length < 2) return false;
  if (allowedTerms.some((allowedTerm) => allowedTerm.includes(value))) return true;
  if (characters.length < 3) return false;
  const maximumAllowedLength = allowedTerms.reduce(
    (maximum, allowedTerm) => Math.max(maximum, [...allowedTerm].length),
    0
  );
  if (characters.length > maximumAllowedLength) return false;
  const orderedPatterns = characters.slice(1).map((ignored, index) => {
    const splitIndex = index + 1;
    const left = escapeRegExpLiteral(characters.slice(0, splitIndex).join(""));
    const right = escapeRegExpLiteral(characters.slice(splitIndex).join(""));
    return new RegExp(`${left}.*?${right}`, "u");
  });
  return allowedTerms.some((allowedTerm) => (
    characters.length <= [...allowedTerm].length
    && orderedPatterns.some((pattern) => pattern.test(allowedTerm))
  ));
}

function compactBoundaryMatchTerm(value) {
  return String(value || "").trim().replace(/\s+/gu, "");
}

function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectFullStoryStrictPositiveFields(value = {}) {
  const fields = [];
  pushField(fields, "title", value.title);
  pushField(fields, "oneLinePremise", value.oneLinePremise);
  pushField(fields, "shootingSynopsis", value.shootingSynopsis);

  const protagonist = value.characterBible?.protagonist || {};
  pushField(fields, "characterBible.protagonist.name", protagonist.name);
  pushField(fields, "characterBible.protagonist.identity", protagonist.identity);
  pushArrayFields(fields, "characterBible.protagonist.traits", protagonist.traits);
  pushArrayFields(fields, "characterBible.protagonist.signatureBehaviors", protagonist.signatureBehaviors);

  const careRecipient = value.characterBible?.careRecipient || {};
  for (const field of ["nameOrLabel", "identity", "explicitNeed", "implicitNeed", "relationshipToProtagonist"]) {
    pushField(fields, `characterBible.careRecipient.${field}`, careRecipient[field]);
  }
  (value.characterBible?.helpers || []).forEach((helper, helperIndex) => {
    for (const field of ["nameOrLabel", "functionInStory", "relationshipToProtagonist", "helpingAction"]) {
      pushField(fields, `characterBible.helpers[${helperIndex}].${field}`, helper?.[field]);
    }
  });

  (value.beatSheet || []).forEach((beat, beatIndex) => {
    pushField(fields, `beatSheet[${beatIndex}].storyAction`, beat?.storyAction);
  });
  (value.sceneScript || []).forEach((scene, sceneIndex) => {
    pushField(fields, `sceneScript[${sceneIndex}].location`, scene?.location);
    pushArrayFields(fields, `sceneScript[${sceneIndex}].characters`, scene?.characters);
    pushField(fields, `sceneScript[${sceneIndex}].visibleAction`, scene?.visibleAction);
    (scene?.dialogue || []).forEach((dialogue, dialogueIndex) => {
      for (const field of ["speaker", "line", "deliveryOrSubtext"]) {
        pushField(fields, `sceneScript[${sceneIndex}].dialogue[${dialogueIndex}].${field}`, dialogue?.[field]);
      }
    });
    pushField(fields, `sceneScript[${sceneIndex}].shotAndSound`, scene?.shotAndSound);
  });
  (value.keyProps || []).forEach((item, itemIndex) => {
    pushField(fields, `keyProps[${itemIndex}].prop`, item?.prop);
    pushField(fields, `keyProps[${itemIndex}].storyFunction`, item?.storyFunction);
    pushField(fields, `keyProps[${itemIndex}].visualUse`, item?.visualUse);
  });
  (value.shootingPlan || []).forEach((item, itemIndex) => {
    pushField(fields, `shootingPlan[${itemIndex}].unit`, item?.unit);
    pushField(fields, `shootingPlan[${itemIndex}].setup`, item?.setup);
    pushField(fields, `shootingPlan[${itemIndex}].mustCapture`, item?.mustCapture);
  });
  (value.retentionPlan || []).forEach((item, itemIndex) => {
    pushField(fields, `retentionPlan[${itemIndex}].moment`, item?.moment);
    pushField(fields, `retentionPlan[${itemIndex}].viewerQuestion`, item?.viewerQuestion);
    pushField(fields, `retentionPlan[${itemIndex}].payoff`, item?.payoff);
  });
  return fields;
}

function collectFullStoryRuleFields(value = {}) {
  const fields = [];
  pushField(fields, "characterBible.protagonist.speechRules", value.characterBible?.protagonist?.speechRules);
  (value.sceneScript || []).forEach((scene, sceneIndex) => {
    pushField(fields, `sceneScript[${sceneIndex}].shootingNotes`, scene?.shootingNotes);
  });
  (value.shootingPlan || []).forEach((item, itemIndex) => {
    pushField(fields, `shootingPlan[${itemIndex}].practicalNote`, item?.practicalNote);
  });
  pushField(fields, "dialogueStyleGuide.overallTone", value.dialogueStyleGuide?.overallTone);
  pushField(fields, "dialogueStyleGuide.protagonistSpeechRule", value.dialogueStyleGuide?.protagonistSpeechRule);
  pushField(fields, "dialogueStyleGuide.supportingCharactersSpeechRule", value.dialogueStyleGuide?.supportingCharactersSpeechRule);
  return fields;
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

function collectAnimationStructuredFixedCharacterFields(value = {}, fixedCharacterName = "") {
  const fields = [];
  const expectedName = String(fixedCharacterName || "").trim();
  if (!expectedName) return fields;
  (value.shotPlan || []).forEach((shot, shotIndex) => {
    if (!hasStructuredAnimationShotFields(shot)) return;
    for (const frameField of ["startFrame", "endFrame"]) {
      const frame = shot?.[frameField];
      (frame?.characters || []).forEach((character, characterIndex) => {
        if (String(character?.name || "").trim() !== expectedName) return;
        const path = `shotPlan[${shotIndex}].${frameField}.characters[${characterIndex}]`;
        animationFrameCharacterFields.forEach((field) => {
          pushField(fields, `${path}.${field}`, character?.[field]);
        });
      });
    }
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

function findTerms(text, terms, { allowNegativeContext = false } = {}) {
  const value = String(text || "");
  return [...new Set((terms || []).filter((term) => (
    term && hasForbiddenOccurrence(value, term, { allowNegativeContext })
  )))];
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
