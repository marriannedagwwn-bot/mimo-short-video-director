import {
  validateLegacyFullStoryStrict,
  validateNarrativeFullStoryStrict,
  validateStoryCandidateStrict,
  validateStoryCandidatesStrict,
  validateStoryEntryCandidateStrict,
  validateStoryEntryCandidatesStrict,
  validateStoryCandidateReviewStrict,
  validateStoryQualityReviewStrict,
  validateFullStoryPromiseCheckStrict
} from "./contracts/contract-validator.js";
import { DIRECT_SHOT_MIN_DURATION_SECONDS, DIRECT_SHOT_MAX_DURATION_SECONDS } from "./shot-duration-limits.js";
import { hasFullStoryCharacterRegistry, isNarrativeFullStory, NARRATIVE_FULL_STORY_FIELDS } from "./full-story-contract.js";
import {
  ANIMATION_PLAN_VERSION_UNSUPPORTED,
  isStoryboardPlan,
  legacyAnimationPlanMessage,
  legacyAnimationPlanVersion
} from "../public/storyboard-plan.js";
import { ensureStoryboardPlan } from "./storyboard-contract.js";
import { GLOBAL_CHARACTER_BOUNDARY_VERSION } from "./character-boundary.js";
// 换皮线、维度权重与五档阈值只有一份，与提示词、浏览器摘要共用：
// 各写一份迟早漂成「页面显示的权重与实际算分不一样」。
// 同规格先例见 public/all-reference-limits.js。
import {
  CANDIDATE_REVIEW_DIMENSION_WEIGHTS,
  SOURCE_SCAFFOLD_COPY_SCORE,
  candidateEffectiveVerdict,
  candidateOverallScore,
  candidateTier,
  PROMISE_CHECK_STATUSES,
  PROMISE_SOURCE_FIELDS,
  STORY_QUALITY_ISSUE_TYPES
} from "../public/story-review-metrics.js";

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

// creative_brief/2.0（2026-09-23）：简报只保留原片分析与脚本还原都不提供的两项——
// storyEngine（含观众对关系理解的 before/after）与 recastTest（换角反事实测试）。
// 定位、受众、情绪曲线由下游直接从 referenceAnalysis 按白名单投影；原片表面表达由角色边界的
// sourceSimilarityRules 承担。依据见 docs/creative-brief-slim-2026-09-23.md：旧简报里下发给候选的
// 定位字段是逐字抄原片分析，七项构件表零消费者却是 12/13 次契约失败的来源。
// schemaVersion 由服务端在校验通过后盖上，模型不输出；这里只列模型必须写、也只能写的键。
export const CREATIVE_BRIEF_SCHEMA_VERSION = "creative_brief/2.0";
export const CREATIVE_BRIEF_MODEL_FIELDS = Object.freeze(["storyEngine", "recastTest"]);

// 参考片分析的顶层键与必须是数组的字段。参考片分析发给 MiMo 的约束解码 Schema
// （src/contracts/reference-analysis-model-schema.js）引用这两份常量，不另写一份。
export const REFERENCE_ANALYSIS_FIELDS = Object.freeze(["contentPositioning", "targetAudience", "storySynopsis", "characters", "protagonistIdentity", "careRecipient", "dialogueStyle", "shotRhythm", "emotionCurve", "retentionDrivers", "whyWatchToEnd", "analysisConfidence", "observedFacts", "uncertainties"]);
export const REFERENCE_ANALYSIS_ARRAY_FIELDS = Object.freeze(["characters", "emotionCurve", "retentionDrivers", "observedFacts", "uncertainties"]);

const outputContracts = {
  referenceAnalysis: REFERENCE_ANALYSIS_FIELDS,
  sourceScriptReconstruction: ["scenes", "coreEventSequence", "relationshipPattern", "endingAction", "turningPoints", "uncertainties"],
  creativeBrief: CREATIVE_BRIEF_MODEL_FIELDS,
  visualGuardrails: ["fixedCharacterBoundary", "allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "stageInstructions", "rationale", "uncertainties"],
  themeVariants: ["variants"],
  fullStory: ["selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis", "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide", "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"],
  storyQualityReview: ["schemaVersion", "selectedVariantId", "summary", "promisePreservation", "issues"],
  storyCandidateReview: ["schemaVersion", "sourceMechanisms", "candidateChecks", "holisticPreferenceOrder", "batchTemplateConvergence", "briefProblemsDetected", "summary"]
};

export const ANIMATION_PLAN_ASPECT_RATIOS = Object.freeze(["9:16", "16:9"]);
export function requireAnimationPlanAspectRatio(value, path = "targetAspectRatio") {
  const normalized = String(value || "").trim();
  if (!ANIMATION_PLAN_ASPECT_RATIOS.includes(normalized)) {
    throw new InputError(`${path} 只允许 ${ANIMATION_PLAN_ASPECT_RATIOS.join(" 或 ")}`);
  }
  return normalized;
}

// 背景音乐开关：用户在主题变体卡上选择，服务端签发进 productionStrategy。
// 模型不得输出、推断或修改这个字段。
const BACKGROUND_MUSIC_NONE = "none";
export const BACKGROUND_MUSIC_ALLOWED = "allowed";
export const BACKGROUND_MUSIC_MODES = Object.freeze([BACKGROUND_MUSIC_NONE, BACKGROUND_MUSIC_ALLOWED]);

// 关闭背景音乐时，Seedance videoPrompt 必须以这句逐字收尾。
// 它明确区分「背景音乐」与「现场声」，避免视频模型把动作声和对白一起静音。
export const NO_BACKGROUND_MUSIC_SENTENCE = "全片无背景音乐，只保留现场环境声与动作声。";

// 请求侧归一：开关缺省关闭，与变体卡上的默认状态一致。
export function normalizeBackgroundMusicMode(value) {
  if (value === true) return BACKGROUND_MUSIC_ALLOWED;
  if (value === false || value === undefined || value === null) return BACKGROUND_MUSIC_NONE;
  const normalized = String(value).trim();
  if (BACKGROUND_MUSIC_MODES.includes(normalized)) return normalized;
  throw new InputError(`backgroundMusicEnabled 只允许布尔值或 ${BACKGROUND_MUSIC_MODES.join(" / ")}`);
}

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
const explicitStandardNameSuffixSeparatorPattern = "[（(【\\[\\s,，:：—–\\-]";

function hasExplicitStandardNameSuffix(value, standardName) {
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
  if (contract === "animationPlan" && isStoryboardPlan(value)) return ensureStoryboardPlan(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${contract} 必须是对象`);
  if (contract === "animationPlan") throw legacyAnimationPlanContractError(value);
  if (contract === "themeVariants") {
    const schemaResult = validateStoryCandidatesStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `themeVariants Story Candidates 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
  if (contract === "storyQualityReview") {
    const schemaResult = validateStoryQualityReviewStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `storyQualityReview 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
  // 候选对照评审报告。schema 只管结构，逐候选覆盖与引用真实性由
  // ensureStoryCandidateReviewCoversCandidates 裁决——与上面的剧情体检报告同分工。
  if (contract === "storyCandidateReview") {
    const schemaResult = validateStoryCandidateReviewStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `storyCandidateReview 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
  // 展开前承诺核对。schema 只管结构；两个承诺来源是否都核对过、摘句是不是真从
  // 标题和钩子里摘的、拍号是否存在，由 ensureFullStoryPromiseCheckCoversCandidate 裁决。
  if (contract === "fullStoryPromiseCheck") {
    const schemaResult = validateFullStoryPromiseCheckStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `fullStoryPromiseCheck 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
  if (contract === "fullStory") {
    const schemaResult = isNarrativeFullStory(value)
      ? validateNarrativeFullStoryStrict(value)
      : validateLegacyFullStoryStrict(value);
    if (!schemaResult.ok) {
      throw new OutputContractError(
        `fullStory 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
        schemaResult.diagnostics
      );
    }
  }
  const requiredFields = contract === "fullStory" && isNarrativeFullStory(value)
    ? NARRATIVE_FULL_STORY_FIELDS
    : (outputContracts[contract] || []);
  const missing = requiredFields.filter((key) => !(key in value));
  if (missing.length) throw new OutputContractError(`${contract} 缺少必要字段：${missing.join("、")}`);
  const arrayFields = {
    referenceAnalysis: REFERENCE_ANALYSIS_ARRAY_FIELDS,
    sourceScriptReconstruction: ["scenes", "coreEventSequence", "turningPoints", "uncertainties"],
    visualGuardrails: ["allowedPositiveTraits", "positivePromptBoundary", "sourceSimilarityRules", "dialogueRules", "uncertainties"],
    themeVariants: ["variants"],
    fullStory: isNarrativeFullStory(value)
      ? ["sceneScript", "keyProps", "uncertainties"]
      : ["beatSheet", "sceneScript", "keyProps", "shootingPlan", "retentionPlan", "uncertainties"],
    storyQualityReview: ["issues"],
    storyCandidateReview: ["candidateChecks", "holisticPreferenceOrder", "briefProblemsDetected"]
  }[contract] || [];
  const wrongArrays = arrayFields.filter((key) => !Array.isArray(value[key]));
  if (wrongArrays.length) throw new OutputContractError(`${contract} 字段类型无效：${wrongArrays.join("、")} 必须是数组`);
  if (contract === "sourceScriptReconstruction") validateSourceScriptReconstructionContract(value);
  if (contract === "creativeBrief") {
    validateCreativeBriefTopLevel(value);
    validateStoryEngine(value.storyEngine);
    validateRecastTest(value.recastTest);
  }
  if (contract === "visualGuardrails") {
    validateVisualGuardrailsContract(value);
  }
  if (contract === "themeVariants") {
    if (value.variants.length < 1) throw new OutputContractError("themeVariants 至少需要一个主题方案");
    validateStoryCandidateSetStructure(value.variants);
  }
  if (contract === "fullStory") {
    if (!isNarrativeFullStory(value)) {
      if (value.beatSheet.length < 6) throw new OutputContractError("fullStory 至少需要 6 个剧情节拍");
      if (value.sceneScript.length < 6) throw new OutputContractError("fullStory 至少需要 6 个可拍摄分场");
    }
    validateFullStorySceneContract(value);
  }
  return value;
}

// 2026-10-11 起只支持 Animation Plan 4.0（自主分镜）。旧 2.0（首尾帧）/ 3.0（direct_shot）
// Plan 只会出现在旧 Run 或旧导出包里：照实报出版本并明确拒绝，不当成 4.0 读取、不静默放过。
// 版本判定与提示文字只有一份，在 public/storyboard-plan.js。
// 注意：ensureOutputContract(_, "animationPlan") 目前没有生产调用者（4.0 生成直接用 ensureStoryboardPlan），
// 这一层只是函数级契约；线上生效的拦截是生成 400、服务端消费 409 与通用提交口。
function legacyAnimationPlanContractError(value) {
  const version = legacyAnimationPlanVersion(value);
  const message = legacyAnimationPlanMessage(version);
  const error = new OutputContractError(message, [{
    code: ANIMATION_PLAN_VERSION_UNSUPPORTED,
    path: "/promptSchemaVersion",
    reason: message,
    version
  }]);
  error.code = ANIMATION_PLAN_VERSION_UNSUPPORTED;
  return error;
}

function validateFullStorySceneContract(value) {
  const details = [];
  const seenSceneIds = new Map();
  const standardNames = collectFullStoryStandardCharacterNames(value.characterBible);
  if (hasFullStoryCharacterRegistry(value)) {
    const names = [value.characterBible.protagonist.name, ...value.characterBible.supportingCharacters.map(row => row.name)];
    if (names.length !== new Set(names).size) throw new OutputContractError("完整角色表姓名不能重复");
    for (const scene of value.sceneScript) {
      for (const name of [...scene.characters, ...(scene.offscreenSoundSources || []), ...scene.dialogue.map(row => row.speaker)]) {
        if (!names.includes(name)) throw new OutputContractError(`角色「${name}」未登记到完整角色表；单场和仅发声角色也必须登记`);
      }
    }
  }
  validateFullStoryRecurringCharactersAreRegistered(value.sceneScript, standardNames, details);

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
    const offscreenSoundSourceNames = validateFullStorySceneOffscreenSoundSources(
      scene.offscreenSoundSources,
      `${scenePath}.offscreenSoundSources`,
      standardNames,
      characterNames,
      details,
      sceneId
    );
    validateFullStoryVisualCharacterReferences({
      scene,
      scenePath,
      sceneId,
      standardNames,
      characterNames,
      offscreenSoundSourceNames,
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

  validateFullStoryHasVisibleCharacterScene(value.sceneScript, details);

  if (details.length) {
    throw new OutputContractError(
      `fullStory Scene Contract 校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
}

/**
 * 单场无人出镜是合法空镜，但整片一个人都不出镜就不是短视频剧情了。
 *
 * 这条是放开空数组后唯一新增的兜底：实测 ensureFullStoryMatchesProfile 只检查
 * 整个 JSON 是否含固定角色名，characterBible 里有名字就能通过，所以在此之前
 * 防住「全片空镜」的其实只有那条已被移除的空数组禁令。判断完全确定性——
 * 只看有没有任何一场的 characters 非空，不涉及任何文本语义。
 */
function validateFullStoryHasVisibleCharacterScene(sceneScript, details) {
  if (!Array.isArray(sceneScript) || !sceneScript.length) return;
  const hasVisibleCharacter = sceneScript.some((scene) => (
    Array.isArray(scene?.characters) && scene.characters.some((name) => (
      typeof name === "string" && name.trim()
    ))
  ));
  if (hasVisibleCharacter) return;
  pushFullStorySceneViolation(details, {
    code: "FULL_STORY_NO_VISIBLE_CHARACTER_SCENE",
    path: "fullStory.sceneScript",
    reason: "全部场次的 characters 都为空；单场空镜合法，但整片至少要有一个场次有角色实际出镜"
  });
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

/**
 * characters 的语义是「本场实际出镜角色」，所以无人场次的正确值就是 `[]`：
 * 空院子里的雨水、桌面道具特写、城市建立镜头、人物离开后的空镜、纯转场环境镜头
 * 都属于合法空镜。禁止空数组只会逼模型硬塞一个没出镜的角色来通过校验，
 * 反而污染这个字段本身的事实性。
 *
 * 放开空数组不会打开缺口：真正出镜的标准角色仍会被
 * validateFullStoryVisualCharacterReferences 从 visibleAction 里抓出来，
 * 有对白的场次仍会被 validateFullStoryDialogueSpeakers 抓出来。两者都不猜
 * 「这句话里有没有人」——那需要语义判断，写死词表会误伤合法反例。
 */
function validateFullStorySceneCharacters(value, path, standardNames, details, sceneId) {
  if (!Array.isArray(value)) {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_CHARACTERS_REQUIRED",
      path,
      reason: "characters 必须是字符串数组",
      sceneId
    });
    return new Set();
  }

  return collectFullStorySceneNameList(value, path, standardNames, details, sceneId, {
    nameRequiredCode: "FULL_STORY_SCENE_CHARACTER_NAME_REQUIRED",
    duplicateCode: "FULL_STORY_SCENE_CHARACTER_DUPLICATE",
    duplicateReason: (name) => `同一场次角色名不能重复：${name}`
  });
}

/**
 * 逐名校验：非空字符串、场内不重复、标准角色必须用精确标准名。
 * characters 与 offscreenSoundSources 共用同一套规则——名称精确性只有一份判定，
 * 不允许两个字段各自维护一套词表。
 */
function collectFullStorySceneNameList(value, path, standardNames, details, sceneId, {
  nameRequiredCode,
  duplicateCode,
  duplicateReason
}) {
  const names = new Set();
  value.forEach((characterName, characterIndex) => {
    const characterPath = `${path}[${characterIndex}]`;
    if (typeof characterName !== "string" || !characterName.trim()) {
      pushFullStorySceneViolation(details, {
        code: nameRequiredCode,
        path: characterPath,
        reason: "角色名必须是非空字符串",
        sceneId
      });
      return;
    }
    const normalized = characterName.trim();
    if (names.has(normalized)) {
      pushFullStorySceneViolation(details, {
        code: duplicateCode,
        path: characterPath,
        reason: duplicateReason(normalized),
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

/**
 * 本场只以声音出现、明确不出镜的角色名。可选字段，缺省等价于空集。
 *
 * 它只登记「谁不出镜」，不产生任何视觉事实：唯一用途是在扫描 shotAndSound 时
 * 把这些名字剔除。`characters` 仍然是「本场实际出镜角色」的唯一事实来源。
 */
function validateFullStorySceneOffscreenSoundSources(value, path, standardNames, characterNames, details, sceneId) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_SOUND_SOURCE_TYPE_INVALID",
      path,
      reason: "offscreenSoundSources 必须是字符串数组",
      sceneId
    });
    return new Set();
  }
  const names = collectFullStorySceneNameList(value, path, standardNames, details, sceneId, {
    nameRequiredCode: "FULL_STORY_SCENE_SOUND_SOURCE_NAME_REQUIRED",
    duplicateCode: "FULL_STORY_SCENE_SOUND_SOURCE_DUPLICATE",
    duplicateReason: (name) => `同一场次画外声源不能重复：${name}`
  });
  names.forEach((name) => {
    if (!characterNames.has(name)) return;
    // 出镜与不出镜是互斥事实。两个字段冲突只能证明数据不一致，
    // 不能证明哪一方正确，因此明确失败而不是自动选边。
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_SOUND_SOURCE_ALSO_VISIBLE",
      path,
      reason: `「${name}」同时出现在 characters 与 offscreenSoundSources；出镜与只闻其声互斥，必须二选一`,
      sceneId
    });
  });
  return names;
}

/**
 * 两个字段承载的语义不同，扫描口径也必须不同：
 *
 * - `visibleAction` 是可见主体事实的唯一字段，只认 `characters`；
 * - `shotAndSound` 一条自由文本里同时有画面描述（可能出镜）和声音来源（不代表
 *   出镜），因此额外接受 `offscreenSoundSources` 的显式登记作为豁免。
 *
 * 关键不对称：登记**只**豁免 shotAndSound，绝不豁免 visibleAction。契约已经强制
 * 实际参与本场的人物必须写进 visibleAction，所以模型无法靠「把人登记成声源」
 * 藏起一个出镜角色——藏了会在 visibleAction 这一档被抓，不写进 visibleAction
 * 就等于承认没出镜。这条不对称是整个登记机制不沦为免检后门的唯一原因。
 */
function validateFullStoryVisualCharacterReferences({
  scene,
  scenePath,
  sceneId,
  standardNames,
  characterNames,
  offscreenSoundSourceNames = new Set(),
  details
}) {
  const shotAndSoundDeclaredNames = new Set([...characterNames, ...offscreenSoundSourceNames]);
  const scans = [
    { field: "visibleAction", declaredNames: characterNames, reason: "characters 未包含该精确名称" },
    {
      field: "shotAndSound",
      declaredNames: shotAndSoundDeclaredNames,
      reason: "characters 未包含该精确名称；若这里只是画外声音来源，请登记到 offscreenSoundSources"
    }
  ];
  for (const { field, declaredNames, reason } of scans) {
    const value = scene[field];
    if (typeof value !== "string" || !value) continue;
    standardNames.forEach((standardName) => {
      if (
        !fullStoryVisualTextMentionsStandardName(value, standardName, declaredNames)
        || declaredNames.has(standardName)
      ) return;
      pushFullStorySceneViolation(details, {
        code: "FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING",
        path: `${scenePath}.${field}`,
        reason: `视觉字段明确提到标准角色「${standardName}」，但 ${reason}`,
        sceneId
      });
    });
  }
}

function fullStoryVisualTextMentionsStandardName(text, standardName, declaredNames) {
  let remaining = text;
  declaredNames.forEach((characterName) => {
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

/**
 * 跨场复现的出镜角色必须登记进 characterBible
 * （protagonist.name / helpers[].nameOrLabel / careRecipient.nameOrLabel）。
 * 纯集合比较加计数，不含语义判断。
 *
 * 这不只是补一张登记表——**它是 visibleAction 扫描能工作的前提**。
 * collectFullStoryStandardCharacterNames() 的搜索名单只来自 characterBible，
 * 所以一个没登记的角色对 FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING 完全隐形：
 * 那道闸门会被它本该抓的那个错误解除武装。实测《午后的柿子树》helpers 是 []、
 * 无 careRecipient，standardNames 只剩「小白子」，于是 S1 的 visibleAction
 * 「奶奶正拿着长竹竿打柿子」配 characters:['小白子'] 顺利通过，而奶奶实际出镜 5 场。
 *
 * **门槛是「出镜 ≥ 2 场」，不是「凡出镜必登记」。** 后者会撞上一条既有的明确契约：
 * 一次性场次型配角（路过的张姨、放学孩童们）允许不登记——给「放学孩童们」填
 * helpingAction 是荒谬的。按 124 份历史 Full Story 标定，这个区分本来就存在于数据里：
 * 只出镜 1 场的角色 51% 没登记（正是路人群体），出镜 2 场以上未登记只占 4%–11%。
 * 分界线就在 1 与 2 之间——影片会回头再拍一次的角色属于选角，路过一次的不属于。
 * 阈值 ≥2 会拒绝 6.4% 的历史角色条目。
 *
 * **不挂自动纠错**：正解有两个——补进 characterBible，或者把人从后续场次的 characters
 * 移走并改写可见事实字段——推导不唯一，猜错就是凭空签发一条角色事实。明确失败。
 */
export const FULL_STORY_RECURRING_CHARACTER_MIN_SCENES = 2;

function validateFullStoryRecurringCharactersAreRegistered(sceneScript, standardNames, details) {
  const registered = new Set(standardNames);
  if (!registered.size || !Array.isArray(sceneScript)) return;

  const appearances = new Map();
  sceneScript.forEach((scene, sceneIndex) => {
    const characters = scene && typeof scene === "object" ? scene.characters : null;
    if (!Array.isArray(characters)) return;
    const seenInScene = new Set();
    characters.forEach((characterName, characterIndex) => {
      if (typeof characterName !== "string") return;
      const normalized = characterName.trim();
      if (!normalized || seenInScene.has(normalized) || registered.has(normalized)) return;
      // 带后缀的标准名已经由 FULL_STORY_SCENE_CHARACTER_NAME_INEXACT 报过，
      // 同一处不重复报第二条，否则真正要改的地方会被两条消息互相掩盖。
      if (standardNames.some((standardName) => hasExplicitStandardNameSuffix(normalized, standardName))) return;
      seenInScene.add(normalized);
      const record = appearances.get(normalized) || { scenes: 0, first: null, sceneIds: [] };
      record.scenes += 1;
      if (!record.first) record.first = `fullStory.sceneScript[${sceneIndex}].characters[${characterIndex}]`;
      record.sceneIds.push(scene?.sceneId || `#${sceneIndex + 1}`);
      appearances.set(normalized, record);
    });
  });

  appearances.forEach((record, name) => {
    if (record.scenes < FULL_STORY_RECURRING_CHARACTER_MIN_SCENES) return;
    pushFullStorySceneViolation(details, {
      code: "FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED",
      path: record.first,
      reason: `「${name}」在 ${record.scenes} 场里出镜（${record.sceneIds.join("、")}），`
        + `跨场复现的角色必须登记进 characterBible 的 protagonist、helpers[] 或 careRecipient，`
        + `否则这个名字对可见事实扫描完全隐形。只出镜一场的临时配角不受此约束。`
        + `若他本来就不该出现在这些画面里，则应从 characters 移除并改写 visibleAction。`
    });
  });
}
function collectFullStoryStandardCharacterNames(characterBible = {}) {
  const names = [
    characterBible?.protagonist?.name,
    characterBible?.careRecipient?.nameOrLabel,
    ...(characterBible.supportingCharacters || []).map(character => character.name),
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

// 剧情体检的 evidenceInCandidate 与剧情入口的台词核对都按这一口径比对，所以这两个必须导出共享，
// 不能在别处再写一份——判定只有一份。
export function normalizeDialogueChars(value) {
  return String(value || "").replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");
}

/** 最长连续公共子串长度。滚动一行，避免为长 videoPrompt 分配整张表。 */
export function longestCommonRun(a, b) {
  if (!a || !b) return 0;
  let previous = new Uint32Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Uint32Array(b.length + 1);
    const left = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      if (left === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
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
  // 冲突判定必须与下游扫描器同口径。全部扫描器用的都是子串（hasForbiddenOccurrence /
  // findMissingGlobalCharacterTraits 走 text.indexOf），这里此前用的是精确相等，
  // 于是「无头饰」required 与「头饰」forbidden 被判为不冲突，矛盾流过下游六个阶段，
  // 到 Full Story 才以一条指错方向的消息炸掉（2026-09-05 实测三次、约 7.6 万 token）。
  //
  // 方向必须是单向的：required 文本里必然出现 R，若 F 是 R 的子串，服从 required 就
  // 自动违反 forbidden，无解。反过来 R ⊂ F 完全合法——「猫耳少女」含 required「猫耳」
  // 而不含 forbidden「非猫耳动物器官」。回扫 95 份已签发边界，反方向碰撞 14 份且全部
  // 合法，做成双向会误杀 15%。
  const requiredTerms = [...new Set(boundary.requiredTraits.flatMap((trait) => trait.terms))];
  const forbiddenTerms = [...new Set(boundary.forbiddenTraits.flatMap((trait) => trait.terms))];
  const conflicts = [];
  for (const required of requiredTerms) {
    for (const forbidden of forbiddenTerms) {
      if (!required || !forbidden || !required.includes(forbidden)) continue;
      conflicts.push(`required「${required}」包含 forbidden「${forbidden}」`);
    }
  }
  if (conflicts.length) {
    // 两端都要点名：只列一个词时用户无法判断该改 required 还是 forbidden。
    throw new OutputContractError(`visualGuardrails.fixedCharacterBoundary 同时要求并禁止：${conflicts.join("；")}`);
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
    // 判定逐字不变；只把模型实际写的名字带出来。实测它最常见的写法是把创作限制里的搭档并进来
    // （「主角与搭档」），不写出来的话页面上只剩一句「未围绕固定角色生成外观规则」，看不出错在哪。
    mismatches.push(`未围绕固定角色「${fixedName}」生成外观规则（characterName 写的是「${boundary.characterName ?? ""}」）`);
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
//
// 上面说的是它最初为简报七项构件表写的来历；creative_brief/2.0（2026-09-23）删掉了那张表，
// 现在唯一的调用方是候选 transformationProof.source 的溯源核对（validateVariantSourceFactCitations）。
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

// 并列连接词只在**整串覆盖率不足时**才用来二次切分，且切片必须 ≥2 字。
//
// 起因：`citationCoverage` 对每个上游字符串**独立**算 LCS 再取最大值，
// 因此一条引用里并列两个真事实、而它们分散在不同上游句子里时，
// 任何单句都只能覆盖一半。实测「棒棒糖与绿色挎包」覆盖率 0.50 被拦，
// 而「棒棒糖」「绿色挎包」各自单独引用都通过——上游 keyProps 里两样都白纸黑字写着。
// 「原片这一维度有什么」天然是并列的（道具就是好几件），所以这不是个别写法问题。
//
// **不能简单地把「与和及」加进 citationClauses 的分隔符**：它们大量出现在词内
// （温和、参与、以及、涉及），无条件切分会产出「温」这种单字碎片，
// 而越短的片段 LCS 覆盖率越容易虚高，等于凭空放松判定。
//
// 因此设计成只降假阳性、不降拦截力的形状：
//   1. 整串够阈值就直接通过，行为与此前逐字一致；
//   2. 不够时才按连接词切分，且**每一片都必须 ≥2 字**，否则维持原判定；
//   3. 切开后**每一片都要独立够阈值**才放行，有一片不够就维持原判定。
// 于是「快递员与送达任务」两片都找不到 → 仍然拦下；
// 「棒棒糖与快递箱」真的那片过、编的那片不过 → 仍然拦下。
// 编造无法因为被切开而变成真的。
const CITATION_CONJUNCTION_SPLIT = /以及|[与和及]/u;
const CITATION_CONJUNCTION_MIN_LENGTH = 2;

function citationClauseCovered(clause, upstreamTexts, threshold) {
  if (citationCoverage(clause, upstreamTexts) >= threshold) return true;
  const parts = String(clause)
    .split(CITATION_CONJUNCTION_SPLIT)
    .map((part) => normalizeSourceExpressionExcerpt(part))
    .filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.some((part) => part.length < CITATION_CONJUNCTION_MIN_LENGTH)) return false;
  return parts.every((part) => citationCoverage(part, upstreamTexts) >= threshold);
}

export function ensureStoryCandidateContract(candidate, { path = "storyCandidate" } = {}) {
  return ensureCandidateAgainstSchema(candidate, String(path || "storyCandidate"), validateStoryCandidateStrict);
}

// 「从剧情开始」的单个原创候选。严格 Schema 换成派生的那份（没有对照原片的四个字段、
// 恰好一个候选），拍号连续、派生投影、关键选择拍早于高潮拍这些结构校验与视频入口
// 是同一份函数。只有已经确认是剧情 Run 的服务端路径调用它，候选本身不带来源标记。
export function ensureStoryEntryCandidateContract(candidate, { path = "storyEntryCandidate" } = {}) {
  return ensureCandidateAgainstSchema(candidate, String(path || "storyEntryCandidate"), validateStoryEntryCandidateStrict);
}

export function ensureStoryEntryCandidatesContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError("themeVariants 必须是对象");
  const schemaResult = validateStoryEntryCandidatesStrict(value);
  if (!schemaResult.ok) {
    throw new OutputContractError(
      `剧情入口故事候选结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      schemaResult.diagnostics
    );
  }
  validateStoryCandidateSetStructure(value.variants);
  return value;
}

function ensureCandidateAgainstSchema(candidate, label, validateSchema) {
  const schemaResult = validateSchema(candidate);
  if (!schemaResult.ok) {
    throw new OutputContractError(
      `${label} 结构校验失败：${schemaResult.diagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      schemaResult.diagnostics
    );
  }
  const sequenceDiagnostics = storyCandidateBeatSequenceDiagnostics(candidate);
  if (sequenceDiagnostics.length) {
    throw new OutputContractError(
      `${label} 的 storyOutline beat 必须按 1..N 连续编号且顺序一致`,
      sequenceDiagnostics
    );
  }
  const projectionDiagnostics = storyCandidateProjectionDiagnostics(candidate);
  if (projectionDiagnostics.length) {
    throw new OutputContractError(
      `${label} 的关键拍号或派生投影不成立：`
      + projectionDiagnostics.map((detail) => `${detail.path} ${detail.reason}`).join("；"),
      projectionDiagnostics
    );
  }
  return candidate;
}

function validateStoryCandidateSetStructure(variants) {
  const details = [];
  const seenIds = new Map();
  variants.forEach((candidate, candidateIndex) => {
    const id = String(candidate.id).trim();
    const firstIndex = seenIds.get(id);
    if (firstIndex !== undefined) {
      details.push({
        code: "STORY_CANDIDATE_ID_DUPLICATE",
        path: `/variants/${candidateIndex}/id`,
        reason: `候选 id「${id}」与 /variants/${firstIndex}/id 重复`
      });
    } else {
      seenIds.set(id, candidateIndex);
    }
    details.push(...storyCandidateBeatSequenceDiagnostics(candidate, `/variants/${candidateIndex}`));
    details.push(...storyCandidateProjectionDiagnostics(candidate, `/variants/${candidateIndex}`));
  });
  if (!details.length) return;
  throw new OutputContractError(
    `themeVariants Story Candidates 结构校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
    details
  );
}

// keyChoice / climax / emotionalPayoff 是可从 storyOutline 唯一推导的值：
// 给定拍号，它们就是那一拍的 action。因此服务端独占签发，模型只标拍号。
//
// 此前要求模型自己在一份两万字符的 JSON 的两个远距离位置逐字重复同一个长句，
// 实测不可靠：debug 侧车记录的真实调用里合规率两极分布（多次 0/12，也有 12/12），
// 加强措辞后仍出现 2/12 与 9/12 两次硬失败。失败模式是模型在**改写**而非复制——
// 砍掉前置准备再把主语补回句首，让顶层成为能独立成句的摘要。而"顶层不得含准备"
// 恰恰是 Prompt 自己的要求，两条规则互相冲突，调措辞救不了。
//
// 这与原 3.0 direct_shot 签发镜头字段的做法一致（已删除；4.0 分镜的 shotId 与 productionStrategy 同样由服务端签发，见 CLAUDE.md §2.1）：可唯一推导的字段由服务端签发，
// 模型回显不构成新事实。

export const STORY_CANDIDATE_BEAT_INDEX_FIELDS = Object.freeze([
  ["keyChoiceBeat", "keyChoice"],
  ["climaxBeat", "climax"]
]);

function storyCandidateBeatIndexDiagnostics(candidate, basePath = "") {
  const outline = Array.isArray(candidate?.storyOutline) ? candidate.storyOutline : [];
  const details = [];
  const indices = {};
  for (const [indexField] of STORY_CANDIDATE_BEAT_INDEX_FIELDS) {
    const raw = candidate?.[indexField];
    if (!Number.isInteger(raw)) {
      details.push({
        code: "STORY_CANDIDATE_BEAT_INDEX_INVALID",
        path: `${basePath}/${indexField}`,
        reason: `必须是整数拍号，当前为 ${JSON.stringify(raw)}`
      });
      continue;
    }
    if (raw < 1 || raw > outline.length) {
      details.push({
        code: "STORY_CANDIDATE_BEAT_INDEX_OUT_OF_RANGE",
        path: `${basePath}/${indexField}`,
        reason: `拍号 ${raw} 超出 storyOutline 范围（共 ${outline.length} 拍）`
      });
      continue;
    }
    indices[indexField] = raw;
  }
  return { details, indices, lastBeat: outline.length };
}

// 因果序只裁决「关键选择拍 < 高潮拍」这一条。
//
// 「高潮拍必须早于最后一拍」曾经也在这里硬裁，已移除：它规定的是故事形状而不是一致性。
// climaxBeat 等于最后一拍时 climax 与 emotionalPayoff 取到同一个字符串，那是冗余不是矛盾，
// 而本契约的立论是消除候选内部的两版剧情——两个字段相同恰恰是它的反面。
// 实测中模型两轮独立采样各产出 2 个「五拍、高潮收尾」的候选，那是成立的写法。
// 「最后一拍写高潮之后的兑现」与「两拍之间隔一拍写后果」同属剧作观点，都只留在 Prompt。
function storyCandidateBeatOrderDiagnostics({ indices, lastBeat }, basePath = "") {
  const { keyChoiceBeat, climaxBeat } = indices;
  if (keyChoiceBeat === undefined || climaxBeat === undefined) return [];
  const details = [];
  if (climaxBeat <= keyChoiceBeat) {
    details.push({
      code: "STORY_CANDIDATE_PROJECTION_OUT_OF_ORDER",
      path: `${basePath}/climaxBeat`,
      reason: `高潮拍（第 ${climaxBeat} 拍）必须晚于关键选择拍（第 ${keyChoiceBeat} 拍）`
    });
  }
  return details;
}

// 签发路径：按拍号覆写三个字符串。模型若回显了它们，一律无条件覆盖。
// 返回新对象，不原地修改输入。
export function deriveStoryCandidateProjections(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.variants)) return value;
  const details = [];
  const variants = value.variants.map((candidate, index) => {
    const basePath = `/variants/${index}`;
    if (!candidate || typeof candidate !== "object") return candidate;
    const probe = storyCandidateBeatIndexDiagnostics(candidate, basePath);
    details.push(...probe.details, ...storyCandidateBeatOrderDiagnostics(probe, basePath));
    if (probe.details.length) return candidate;
    const outline = candidate.storyOutline;
    return {
      ...candidate,
      keyChoice: String(outline[probe.indices.keyChoiceBeat - 1].action),
      climax: String(outline[probe.indices.climaxBeat - 1].action),
      emotionalPayoff: String(outline[probe.lastBeat - 1].action)
    };
  });
  if (details.length) {
    throw new OutputContractError(
      `themeVariants 的关键拍号无法定位：${details.map((d) => `${d.path} ${d.reason}`).join("；")}`,
      details
    );
  }
  return { ...value, variants };
}

// 入站复核：不重新派生（那会改变 content digest，破坏 variant:<id> 的 lineage 绑定），
// 只核对已签发的三个字符串仍与拍号指向的 action 一致。签发路径必然通过。
function storyCandidateProjectionDiagnostics(candidate, basePath = "") {
  const probe = storyCandidateBeatIndexDiagnostics(candidate, basePath);
  const details = [...probe.details, ...storyCandidateBeatOrderDiagnostics(probe, basePath)];
  if (probe.details.length) return details;
  const outline = candidate.storyOutline;
  const expected = {
    keyChoice: outline[probe.indices.keyChoiceBeat - 1].action,
    climax: outline[probe.indices.climaxBeat - 1].action,
    emotionalPayoff: outline[probe.lastBeat - 1].action
  };
  for (const [field, want] of Object.entries(expected)) {
    if (String(candidate[field]) === String(want)) continue;
    details.push({
      code: "STORY_CANDIDATE_PROJECTION_NOT_DERIVED",
      path: `${basePath}/${field}`,
      reason: `必须等于服务端按拍号派生的值（storyOutline 对应拍的 action），当前与之不符`
    });
  }
  return details;
}

function storyCandidateBeatSequenceDiagnostics(candidate, basePath = "") {
  return candidate.storyOutline.flatMap((beat, beatIndex) => {
    const expectedBeat = beatIndex + 1;
    if (beat.beat === expectedBeat) return [];
    return [{
      code: "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID",
      path: `${basePath}/storyOutline/${beatIndex}/beat`,
      reason: `beat 必须为 ${expectedBeat}，实际为 ${String(beat.beat)}`
    }];
  });
}

function storyCandidateStructureSignature(candidate) {
  return JSON.stringify({
    dramaticFunctions: candidate.storyOutline.map((beat) => String(beat.dramaticFunction).trim()),
    keyChoice: String(candidate.keyChoice).trim(),
    climax: String(candidate.climax).trim(),
    emotionalPayoff: String(candidate.emotionalPayoff).trim()
  });
}

// 两个候选共用同一条结构签名时，它们只是同一个故事的不同布景。
// 判定口径是两两比较：任意一对候选签名相同就失败。此前只裁决"全组完全雷同"，
// 那让"4 个候选里 3 个雷同"合法通过，等于 Prompt 里的分化要求没有任何执行力。
// 仍然只裁决可确定性的结构重复；选择是否有意义、情绪是否成立属于语义质量，
// 不在本地校验范围内。
function validateVariantStructuralDivergence(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return;
  const signatures = variants.map((variant, index) => {
    const outline = Array.isArray(variant?.storyOutline) ? variant.storyOutline : [];
    const functions = outline.map((beat) => String(beat?.dramaticFunction || "").trim());
    if (!outline.length || functions.some((entry) => !entry)) {
      throw new OutputContractError(
        `themeVariants.variants[${index}]（${variant?.id || `V${index + 1}`}）的 storyOutline `
        + "每个 beat 都必须填写非空 dramaticFunction，否则无法判定各方案的结构是否真的不同"
      );
    }
    return storyCandidateStructureSignature(variant);
  });
  const label = (index) => variants[index]?.id || `V${index + 1}`;
  const seen = new Map();
  const collisions = [];
  signatures.forEach((signature, index) => {
    if (seen.has(signature)) {
      collisions.push({ first: seen.get(signature), duplicate: index });
      return;
    }
    seen.set(signature, index);
  });
  if (!collisions.length) return;
  const pairs = collisions.map(({ first, duplicate }) => `${label(first)} 与 ${label(duplicate)}`);
  const details = collisions.map(({ first, duplicate }) => ({
    code: "STORY_CANDIDATE_STRUCTURE_NOT_DIVERGENT",
    path: `/variants/${duplicate}`,
    reason: `与 /variants/${first}（${label(first)}）共用同一条结构签名`
  }));
  throw new OutputContractError(
    `themeVariants 存在结构签名相同的候选：${pairs.join("；")}。`
    + "每两个方案都必须在危机位置、成败节奏、主角关键选择、高潮或情绪兑现上结构不同；"
    + "只更换季节、天气、交通工具、道具或帮助者称谓不构成不同主题。",
    details
  );
}

// 每批候选里必须有足够比例的「生活片段型」。
//
// 依据是对参考片的逐支拆解：它们基本没有戏剧结构——《好朋友为你遮风挡雨》的主角
// 从第 3 场起一直睡到片尾，《打枣》的转折是「戴锅防砸」这种解决眼前小麻烦，
// 《捐旧衣服》和《晨练》的转折都是别人给的。而候选契约此前把「主角有目标、
// 作出关键选择、亲自完成高潮」写成无条件硬要求，于是每个候选都在执行剧作功能，
// 观众感到的「刻意」正是这套约束在起作用。
//
// 这里只裁决**可数的分布**：数枚举值的个数是纯算术。
// **无法核实「它真的是生活片段」**——那需要语义判断，模型可以把四个都标成
// slice_of_life 蒙混过关。这是已知弱点，靠真实回放与人工评分观察，不加词表补救。
export const SLICE_OF_LIFE_MODE = "slice_of_life";

export function requiredSliceOfLifeCount(total) {
  return total >= 4 ? 2 : 1;
}

function validateVariantNarrativeModeMix(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return;
  const required = requiredSliceOfLifeCount(variants.length);
  const slice = variants.filter((variant) => variant?.narrativeMode === SLICE_OF_LIFE_MODE);
  if (slice.length >= required) return;
  throw new OutputContractError(
    `themeVariants 的 ${variants.length} 个候选里只有 ${slice.length} 个标记为生活片段型（slice_of_life），`
    + `至少需要 ${required} 个。参考片基本不靠戏剧结构留人，全批都写成任务型会让成片显得刻意。`,
    [{
      code: "STORY_CANDIDATE_NARRATIVE_MODE_MIX",
      path: "/variants",
      reason: `slice_of_life 候选 ${slice.length} 个，少于要求的 ${required} 个`
    }]
  );
}

/**
 * transformationProof.changed*.source 的合法出口：原片在这个维度上根本没有对应物。
 *
 * 留这个出口是闸门能成立的前提。schema 要求每个 source 非空，如果唯一合法写法是
 * 「一段能在上游找到的原片事实」，那么原片确实没有送达任务时，模型只有两条路：
 * 编一个，或者整批失败。**逼出来的编造正是这条闸门要拦的东西。**
 *
 * **判定是前缀，不是完全相等——第一版要求精确四个字，实测 20/20 全部失败。**
 * 模型无一例外地把它当成句子开头补完（「原片没有明确任务」「原片没有人类角色对白」），
 * 四个候选五个字段一个不落。这不是模型不听话：`原片没有` 天然读作一句话的开头，
 * 要求它在这里戛然而止，是让措辞去对抗书写本能，本仓库已有多次同类失败记录。
 *
 * 放宽到前缀会让「原片没有把糖递给女孩」这类带内容的否定句免检——第一版正是为此
 * 才要求完全相等。重新权衡后认为代价搞反了：**否定句不制造改写基线。**
 * 这条闸门要拦的是「原片快递送达」那种凭空补出的原片事实，它会让下游照着一个
 * 不存在的结构去改写；而「原片没有 X」无论后面写什么，都没有声称原片有过什么可供承接的东西，
 * 最坏情况只是这一格信息量为零。用整条流水线硬失败去换这点收益不划算。
 * 正向声称仍然逐条回上游核对，闸门的实际拦截能力没有变化。
 */
export const VARIANT_SOURCE_ABSENT_SENTINEL = "原片没有";

const VARIANT_SOURCE_FACT_FIELDS = Object.freeze([
  "changedCharacters",
  "changedTask",
  "changedDetailsAndProps",
  "changedDialogue",
  "changedVisualExpression"
]);

/**
 * 候选的 transformationProof 里「原片是什么」那一半，必须回上游核对。
 *
 * 依据是 2026-09-06 的实测：一轮四个候选**全部**把原片写成「企鹅快递员 / 快递送达」，
 * 而上游 referenceAnalysis 与 sourceScriptReconstruction 里「快递」出现 0 次
 * （「穿着企鹅连体衣」是真的，快递员是补出来的职业），同一份 creativeBrief 还明写着
 * 「送达任务【原片没有】」。V1 更照着这个虚构把整条结构建成「主动承担送达任务」——
 * 一个不存在的原片结构成了改写基线。
 *
 * 防这件事的提示词规则当时**已经存在**，反面例子还一模一样，但它写在 fullStoryPrompt 里，
 * 而 transformationProof 是候选阶段先产出的，变体阶段根本收不到那条规则；两个阶段
 * 也都没有任何校验器。规则、依据、测试都有，只是装错了阶段。
 *
 * 判定复用简报那套 citationCoverage（LCS 字符覆盖率，阈值 0.75），**不新建第二套词表**：
 * 允许转述（Brief 与候选阶段都在做归纳，逐字比对会把忠实转述判成编造），
 * 但复用真词汇拼出来的编造过不了阈值。实测同一份真实上游：
 * 「企鹅连体衣」「绿色挎包」「咕嘎递出棒棒糖」通过，「快递送达」0.25、「企鹅快递员」0.60 拦下。
 *
 * **核对基准只有 referenceAnalysis 与 sourceScriptReconstruction，绝不含 creativeBrief**——
 * 今天正是简报自己先错（它的 mappingLogic 抄了提示词举例里的「快递员身份」），
 * 拿它当基准等于给虚构盖章。
 */
function validateVariantSourceFactCitations(variants, upstream) {
  const upstreamTexts = collectUpstreamText(upstream)
    .map((entry) => normalizeSourceExpressionExcerpt(entry))
    .filter(Boolean);
  if (!upstreamTexts.length) return;
  const details = [];
  (Array.isArray(variants) ? variants : []).forEach((variant, index) => {
    const label = variant?.id || `V${index + 1}`;
    const proof = variant?.transformationProof;
    if (!proof || typeof proof !== "object") return;
    VARIANT_SOURCE_FACT_FIELDS.forEach((field) => {
      const entry = proof[field];
      if (!entry || typeof entry !== "object") return;
      const source = String(entry.source || "").trim();
      // 以「原片没有」开头即为缺席声明，后面的自由文本不再核对：它没有声称原片有过
      // 任何可供承接的东西，因此不制造改写基线。判定是纯字符串前缀，不含语义。
      if (!source || source.startsWith(VARIANT_SOURCE_ABSENT_SENTINEL)) return;
      const unverified = citationClauses(source)
        .filter((clause) => !citationClauseCovered(clause, upstreamTexts, CITATION_COVERAGE_THRESHOLD))
        .map((clause) => ({ clause, coverage: citationCoverage(clause, upstreamTexts) }));
      unverified.forEach((item) => {
        details.push({
          code: "STORY_CANDIDATE_SOURCE_FACT_UNVERIFIED",
          path: `/variants/${index}/transformationProof/${field}/source`,
          reason: `${label} 声称原片有「${item.clause}」，但上游找不到对应事实（覆盖率 ${item.coverage.toFixed(2)}）`
        });
      });
    });
  });
  if (!details.length) return;
  throw new OutputContractError(
    `themeVariants 的 transformationProof 声称了原片并不存在的事实：`
    + `${details.map((detail) => detail.reason).join("；")}。`
    + `source 只写 referenceAnalysis 或 sourceScriptReconstruction 里真的写着的内容（允许转述），`
    + `原片在这个维度上确实没有对应物时，source 以「${VARIANT_SOURCE_ABSENT_SENTINEL}」开头即可，不得为了填满字段编造一个改写基线。`,
    details
  );
}

export function ensureThemeVariantsMatchProfile(
  value,
  creatorProfile = {},
  creativeBrief = null,
  visualGuardrails = null,
  upstream = null
) {
  // 溯源核对排在最前：一个候选如果连原片是什么都写错了，后面几项判定的对象就是错的。
  // 没给上游就跳过，旧调用点行为逐字不变。
  if (upstream) validateVariantSourceFactCitations(value?.variants, upstream);
  validateVariantStructuralDivergence(value?.variants);
  validateVariantNarrativeModeMix(value?.variants);
  const signedBoundaryName = String(visualGuardrails?.fixedCharacterBoundary?.characterName || "").trim();
  const fixedName = signedBoundaryName || extractFixedCharacterName(creatorProfile.fixedCharacter);
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
      variant?.keyChoice,
      variant?.climax,
      variant?.emotionalPayoff,
      variant?.novelty,
      variant?.visualPotential,
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

// targetDurationSeconds 可从 sceneScript 的时间轴唯一推导：它就是各场 timeRange 跨度之和，
// 也正是下游 productionStrategy.targetRuntimeSeconds 的来源（4.0 分镜签发时直接取它，见 src/storyboard-workflow.js）。
// 因此它不该由模型独立编写——实测 65 份历史 Full Story 中 24 份（37%）自相矛盾，
// 最大偏差 +50 秒：声明 60 秒却写了 106 秒的场次，页面照着声明值显示「60 秒」，
// 而实际派生出 10 个镜头的 106 秒成片，按镜头计费。
//
// 与候选拍号同规格：可唯一推导的值由服务端签发，模型回显不构成新事实。
// 场次之间允许留白（只禁重叠与回退），所以取跨度之和而不是首尾之差——
// 留白不产生镜头，也就不进入成片时长。
/**
 * 剧情体检（`story-quality-review/2.0`）合成报告的入站核验。
 *
 * **这一档能确定性裁决的只有引用真实性。** 形状、枚举与来源合法性由 schema 负责
 * （`source` 限成候选字段枚举，剧情自己的 characterBible 结构上写不进来），
 * 承诺总判定由服务端派生，所以这里只剩两条：
 *
 *   1. `issues[].sceneIds` 引用的场次必须真实存在
 *   2. `selectedVariantId` 必须与剧情一致
 *
 * 两条都是纯集合与字符串比较，**零语义**。
 *
 * **2.0 刻意删掉了 1.0 的逐场覆盖（`sceneFunctionChecks`）与逐条留存（`retentionChecks`）**：
 * 前者已被实测为重言式——它查「声称的事画面里有没有」，而当声称本身很弱时这个检查恒为真
 * （实测六场全判 depicted，同时漏掉人工读出的四个真问题）；后者的对象 `retentionPlan`
 * 在 `full_story/1.1` 里根本已经不存在，校验器一直在核对一个空数组。
 *
 * **代价要说清楚：2.0 没有「模型逐场看过」这个确定性覆盖属性。** 它换来的是
 * 承诺核对（拿候选当外部参照，而不是场次自报的 dramaticFunction）与十类编辑诊断。
 * 「判得对不对」仍然没有兜底，这一点两个版本相同。
 */
export function ensureStoryQualityReviewCoversStory(review, fullStory) {
  requireObject(review, "storyQualityReview");
  requireObject(fullStory, "fullStory");
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  const scenes = Array.isArray(fullStory.sceneScript) ? fullStory.sceneScript : [];

  const variantId = String(fullStory.selectedVariantId || "").trim();
  if (String(review.selectedVariantId || "").trim() !== variantId) {
    push(
      "STORY_REVIEW_VARIANT_MISMATCH",
      "/selectedVariantId",
      `体检的是剧情「${variantId}」，报告写的是「${String(review.selectedVariantId || "")}」`
    );
  }

  const knownSceneIds = new Set(scenes.map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean));
  (Array.isArray(review.issues) ? review.issues : []).forEach((issue, index) => {
    if (!Array.isArray(issue?.sceneIds)) return;
    issue.sceneIds.forEach((sceneId, position) => {
      const normalized = String(sceneId || "").trim();
      if (!normalized || knownSceneIds.has(normalized)) return;
      push(
        "STORY_REVIEW_UNKNOWN_SCENE_ID",
        `/issues/${index}/sceneIds/${position}`,
        `引用了剧情里不存在的场次「${normalized}」`
      );
    });
  });

  if (details.length) {
    throw new OutputContractError(
      `storyQualityReview 覆盖率核验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
  return review;
}

/**
 * 第一次调用（编辑诊断）原始输出的形状核验。
 *
 * 必须在合成**之前**跑：合成时 `annotateStoryQualityIssues` 对非数组的 `issues` 会返回 `[]`，
 * 那就会把「模型把 issues 写成了字符串」悄悄变成「这份剧情没有问题」——
 * 静默丢数据比硬失败糟得多。
 *
 * 这一步的输入**不含候选**（实测依据见 src/story-quality-review.js 顶部），
 * 所以这里能核验的只有形状与场次引用，核不了「判得对不对」。
 */
export function ensureStoryQualityEditorialContract(editorial, fullStory) {
  requireObject(editorial, "storyQualityEditorial");
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  if (!String(editorial.summary || "").trim()) {
    push("STORY_REVIEW_EDITORIAL_SUMMARY_MISSING", "/summary", "summary 必须是非空字符串");
  }
  if (!Array.isArray(editorial.issues)) {
    push("STORY_REVIEW_EDITORIAL_ISSUES_INVALID", "/issues", "issues 必须是数组（没有问题时给空数组）");
  } else {
    const scenes = Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : [];
    const knownSceneIds = new Set(scenes.map((scene) => String(scene?.sceneId || "").trim()).filter(Boolean));
    editorial.issues.forEach((issue, index) => {
      if (!issue || typeof issue !== "object") {
        push("STORY_REVIEW_EDITORIAL_ISSUE_INVALID", `/issues/${index}`, "每一条 issue 必须是对象");
        return;
      }
      if (!STORY_QUALITY_ISSUE_TYPES.includes(String(issue.type || ""))) {
        push(
          "STORY_REVIEW_EDITORIAL_TYPE_UNKNOWN",
          `/issues/${index}/type`,
          `type 必须是这 ${STORY_QUALITY_ISSUE_TYPES.length} 个之一：${STORY_QUALITY_ISSUE_TYPES.join("、")}；实际写的是「${String(issue.type || "")}」`
        );
      }
      if (!Array.isArray(issue.sceneIds) || !issue.sceneIds.length) {
        push("STORY_REVIEW_EDITORIAL_SCENE_IDS_MISSING", `/issues/${index}/sceneIds`, "sceneIds 必须是非空数组");
        return;
      }
      issue.sceneIds.forEach((sceneId, position) => {
        const normalized = String(sceneId || "").trim();
        if (!normalized || knownSceneIds.has(normalized)) return;
        push(
          "STORY_REVIEW_UNKNOWN_SCENE_ID",
          `/issues/${index}/sceneIds/${position}`,
          `引用了剧情里不存在的场次「${normalized}」`
        );
      });
    });
  }
  if (details.length) {
    throw new OutputContractError(
      `storyQualityEditorial 结构校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
  return editorial;
}

/**
 * 第二次调用（承诺核对）原始输出的形状核验。同样必须在合成之前跑。
 *
 * **`source` 只能是候选字段或用户的固定角色设定。** 依据是实测：第三轮出现过
 * `source: "characterSetup / 完整剧情 characterBible"`——拿剧情自己当承诺来源，
 * 就成了自己声明、自己证明。候选与固定角色设定提供「应当保留什么」，
 * 剧情提供「实际写出了什么」，后者只能出现在 evidence 里。
 */
export function ensureStoryQualityPromiseContract(promise) {
  requireObject(promise, "storyQualityPromise");
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  const checks = Array.isArray(promise.checks) ? promise.checks : null;
  if (!checks) {
    push("STORY_REVIEW_PROMISE_CHECKS_INVALID", "/checks", "checks 必须是数组");
  } else if (!checks.length) {
    push("STORY_REVIEW_PROMISE_CHECKS_EMPTY", "/checks", "checks 至少要有一条——候选总有可核对的承诺");
  }
  (checks || []).forEach((check, index) => {
    if (!check || typeof check !== "object") {
      push("STORY_REVIEW_PROMISE_CHECK_INVALID", `/checks/${index}`, "每一条检查必须是对象");
      return;
    }
    if (!String(check.promise || "").trim()) {
      push("STORY_REVIEW_PROMISE_TEXT_MISSING", `/checks/${index}/promise`, "promise 必须是非空字符串");
    }
    if (!PROMISE_CHECK_STATUSES.includes(String(check.status || ""))) {
      push(
        "STORY_REVIEW_PROMISE_STATUS_UNKNOWN",
        `/checks/${index}/status`,
        `status 必须是这四个之一：${PROMISE_CHECK_STATUSES.join("、")}；实际写的是「${String(check.status || "")}」`
      );
    }
    const source = Array.isArray(check.source) ? check.source : null;
    if (!source || !source.length) {
      push("STORY_REVIEW_PROMISE_SOURCE_MISSING", `/checks/${index}/source`, "source 必须是非空数组");
      return;
    }
    source.forEach((field, position) => {
      const normalized = String(field || "").trim();
      if (PROMISE_SOURCE_FIELDS.includes(normalized)) return;
      push(
        "STORY_REVIEW_PROMISE_SOURCE_NOT_CANDIDATE",
        `/checks/${index}/source/${position}`,
        `source 只能是候选字段或 fixedCharacter，不能是剧情自己的字段；「${normalized}」不在允许清单里：${PROMISE_SOURCE_FIELDS.join("、")}`
      );
    });
  });
  if (details.length) {
    throw new OutputContractError(
      `storyQualityPromise 结构校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
  return promise;
}

/**
 * 候选对照评审的覆盖率核验。
 *
 * 与 ensureStoryQualityReviewCoversStory 同规格，理由也一样：模型完全可以只挑它
 * 碰巧注意到的一两个候选来点评，交回一份看起来很专业、实际漏检大半的报告。
 * 所以覆盖率不靠模型自觉，靠这四条纯计数与字符串比较（**不含语义判断**）：
 *
 *   1. candidateChecks 与候选**数量相等且 candidateId 逐位相同**
 *   2. 回显的 title 必须**包含**候选原文（复用 storyReviewEchoCoversSource，不写第二套）
 *   3. mechanismChecks / coherenceChecks / sourceScaffoldOverlap.eventChain 引用的拍号
 *      必须在该候选 storyOutline 范围内（三个数组**共用同一份** checkBeats）
 *   4. holisticPreferenceOrder（模型的整体偏好序）必须是全部候选 id 的一个排列；
 *      scoreOrder 由服务端按加权分派生，两者**刻意不强制一致**
 *
 * 另有三条 verdict 交叉闸门，同样只做计数、枚举与整数比较：
 *   5. 引用的机制 id 必须在顶层清单里，且清单内 id 不得重复
 *   6. 清单标了 requiresCause 的机制，判 depicted 时 causeEvidence 必须非空
 *      （CANDIDATE_REVIEW_EVIDENCE_INCOMPLETE；**不一刀切**，标记是机制自己的属性）
 *   7. coherenceChecks 非空、或 sourceScaffoldOverlap.score 到换皮线，都不得判 pass
 *
 * 形状本身（枚举合法、score 是 0–100 整数、事件链条数）**只由 schema 裁决**，
 * 这里不重写第二份——两份形状检查迟早漂移，与已删除的分镜终审（原 §2.14）「schema 是唯一且足够的闸门」同规格。
 *
 * 核验通过后服务端用原文无条件覆盖 title——它可从候选唯一推导，
 * **回显不构成新事实**，与 direct_shot 骨架、剧情体检同规格。
 *
 * 「判得对不对」本身是语义的，**没有兜底**：这几条只保证模型逐个候选看过、
 * 自报的标签之间不打架，不保证它看得对。这是本机制已知的边界。
 */
export function ensureStoryCandidateReviewCoversCandidates(review, candidates) {
  requireObject(review, "storyCandidateReview");
  const list = Array.isArray(candidates) ? candidates : [];
  const checks = Array.isArray(review.candidateChecks) ? review.candidateChecks : [];
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });

  // 原片机制清单是**全批共享的一份**，先于候选产出，候选只能按 id 引用它。
  //
  // 依据是 2026-09-09 跨四个包的真实回放：只有一个包的评审把原片机制收敛成 3 条，
  // 另外三个各提炼 8-9 条——**每条都是照着那个候选本身写的**，于是 6/8 判 depicted。
  // 从候选反推原片机制、再判定它已兑现，是循环论证；而当机制真正收敛时（那一个包），
  // 四个候选全部被判未迁移，与一份外部评审对同一批候选的结论一致。
  //
  // 招式与 variant-source-baseline 的证据目录同规格：共享权威清单 + 按 id 引用。
  // 判定是**纯集合成员比较，零语义**——4 个候选写不出 8 条机制在构造上就不可能了。
  const mechanisms = Array.isArray(review.sourceMechanisms) ? review.sourceMechanisms : [];
  const mechanismIds = new Set();
  // 「这条机制需不需要前因」是**机制自己的属性，不是候选的属性**，所以它声明在
  // 共享清单上、先于候选产出，全批候选对同一条机制吃同一个标准。
  //
  // 放在逐候选的 mechanismCheck 里会留一个显而易见的后门：模型想让哪个候选过，
  // 就对那个候选把标记写成 false。放在清单上，改标记就等于对四个候选同时放水。
  // 招式与 sourceMechanisms 本身、与 variant-source-baseline 的冻结目录同规格。
  const mechanismRequiresCause = new Map();
  mechanisms.forEach((entry, index) => {
    const id = String(entry?.id || "").trim();
    if (!id) return;
    if (mechanismIds.has(id)) {
      push(
        "CANDIDATE_REVIEW_DUPLICATE_MECHANISM",
        `/sourceMechanisms/${index}/id`,
        `机制 id「${id}」重复；每条机制必须有唯一 id 供候选引用`
      );
      return;
    }
    mechanismIds.add(id);
    mechanismRequiresCause.set(id, entry?.requiresCause === true);
  });

  if (checks.length !== list.length) {
    push(
      "CANDIDATE_REVIEW_COVERAGE_INCOMPLETE",
      "/candidateChecks",
      `本批有 ${list.length} 个候选，评审只覆盖了 ${checks.length} 个；每一个都必须逐条核对`
    );
  }
  list.forEach((candidate, index) => {
    const check = checks[index];
    if (!check || typeof check !== "object") return;
    const candidateId = String(candidate?.id || "").trim();
    if (String(check.candidateId || "").trim() !== candidateId) {
      push(
        "CANDIDATE_REVIEW_ID_MISMATCH",
        `/candidateChecks/${index}/candidateId`,
        `第 ${index + 1} 项应当核对候选「${candidateId}」，实际写的是「${String(check.candidateId || "")}」；必须与 variants 逐位同序`
      );
    }
    const title = String(candidate?.title || "");
    if (!storyReviewEchoCoversSource(check.title, title)) {
      push(
        "CANDIDATE_REVIEW_TITLE_NOT_VERBATIM",
        `/candidateChecks/${index}/title`,
        `title 必须完整包含候选「${candidateId}」的标题原文，不得复述、概括或截断`
      );
    }
    const beatCount = Array.isArray(candidate?.storyOutline) ? candidate.storyOutline.length : 0;
    // 拍号合法性判定只有一份，mechanismChecks 与 coherenceChecks 共用：
    // 两边各写一次必然漂移，而它们引用的是同一个候选的同一组拍。
    const checkBeats = (rows, arrayName) => {
      (Array.isArray(rows) ? rows : []).forEach((row, order) => {
        (Array.isArray(row?.beatIndexes) ? row.beatIndexes : []).forEach((beat, position) => {
          if (Number.isInteger(beat) && beat >= 1 && beat <= beatCount) return;
          push(
            "CANDIDATE_REVIEW_UNKNOWN_BEAT",
            `/candidateChecks/${index}/${arrayName}/${order}/beatIndexes/${position}`,
            `引用了候选「${candidateId}」里不存在的拍号 ${beat}；该候选只有 ${beatCount} 拍`
          );
        });
      });
    };
    (Array.isArray(check.mechanismChecks) ? check.mechanismChecks : []).forEach((mechanism, order) => {
      const id = String(mechanism?.sourceMechanismId || "").trim();
      if (!mechanismIds.has(id)) {
        push(
          "CANDIDATE_REVIEW_UNKNOWN_MECHANISM",
          `/candidateChecks/${index}/mechanismChecks/${order}/sourceMechanismId`,
          `引用了不存在的机制 id「${id || "（空）"}」；只能引用顶层 sourceMechanisms 里已列出的 ${mechanismIds.size} 条`
        );
        return;
      }
      // 双证据闸门：**只管清单自己标了 requiresCause 的那些机制，不一刀切**。
      //
      // 依据是三条实测的「已兑现」证据，全部只有转移动作、没有一条指出前因：
      // 「第 5 拍把书签别在她胸前」「第 5 拍摘下徽章别在搭档呆毛上」
      // 「第 5 拍把书签夹进那本旧书里」。这类机制（主动付出、转赠、承担成本）
      // 的全部分量都在前因上——那东西先真正属于她、她在意它、舍不得——
      // 只写转移动作就等于用一个空动作换一个 depicted。
      //
      // 但「会不会跑」「有没有陪着」这类机制根本不需要前因，对它们也要两条证据
      // 就是在逼模型编一段。所以判据来自清单的自报标记，闸门只做非空判定。
      //
      // 已知缺口：模型把 requiresCause 全写成 false 就能整体绕过，而
      // 「前因写得对不对」更是语义判断。**都没有确定性兜底**，与 narrativeMode
      // 那条「校验只能数自报标签」同型，只能靠真实回放与人工看。
      if (!mechanismRequiresCause.get(id)) return;
      if (String(mechanism?.verdict || "") !== "depicted") return;
      if (String(mechanism?.causeEvidence || "").trim()) return;
      push(
        "CANDIDATE_REVIEW_EVIDENCE_INCOMPLETE",
        `/candidateChecks/${index}/mechanismChecks/${order}/causeEvidence`,
        `机制「${id}」在清单里标了需要前因，判 depicted 就必须同时给出前因证据`
        + "（前面哪一拍写出了它怎么成为主角在意的东西、接收方此前做过什么）"
        + "；只有一个转移动作最多只能判 partially_depicted"
      );
    });
    checkBeats(check.mechanismChecks, "mechanismChecks");
    checkBeats(check.coherenceChecks, "coherenceChecks");
    // 事件链的拍号与另外两个数组走同一份判定，路径指向真正出错的那个数组。
    checkBeats(check.sourceScaffoldOverlap?.eventChain, "sourceScaffoldOverlap/eventChain");

    // 因果自洽、换皮与 BLOCKER 硬伤**不再是 verdict 闸门，而是派生时的降级理由**
    // （2026-09-12）。原来两条闸门写的是「报了因果断裂就不许判 pass」，
    // 拦的是模型自报的 verdict；现在模型根本不写 verdict——它由分数与这三条
    // 确定性派生，于是那类失败**由构造消除**，与已删除的分镜定向修订（原 §2.14）「签发字段由构造保证不可能
    // 被改动」同规格。概念一个没丢：它们变成 verdictOverrideReasons 的取值，
    // 在报告里照样写明「9.2 分、最高档，但因为因果断裂未清所以现在不放行」。
    //
    // 关键纪律：**降级只改 effectiveVerdict，绝不回头改 overallScore 或 tier**。
    // 用压低质量分来实现降级，会把「这故事其实很好，但有一处不能带进 FullStory 的
    // 问题」压成「这故事不好」，两件事从此再也分不开。
    validateCandidateReviewDimensions(check, index, push);
    validateCandidateReviewDefect(check, index, push);
    validateCandidateReviewAssumptions(check, index, push);
    validateCandidateReviewSuggestions(check, index, push);
  });

  validateCandidateReviewBatchConvergence(review, list, push);

  const ids = list.map((candidate) => String(candidate?.id || "").trim()).filter(Boolean);
  // 这条闸门管的是**模型给的那一份**（整体偏好序）。scoreOrder 由服务端从分数派生，
  // 按构造就是一个排列，不需要也不应该再校验一遍。
  const order = (Array.isArray(review.holisticPreferenceOrder) ? review.holisticPreferenceOrder : [])
    .map((entry) => String(entry || "").trim());
  const missing = ids.filter((id) => !order.includes(id));
  const unknown = order.filter((id) => !ids.includes(id));
  const duplicated = order.filter((id, position) => order.indexOf(id) !== position);
  if (missing.length || unknown.length || duplicated.length || order.length !== ids.length) {
    push(
      "CANDIDATE_REVIEW_ORDER_NOT_PERMUTATION",
      "/holisticPreferenceOrder",
      `holisticPreferenceOrder 必须是全部 ${ids.length} 个候选 id 的一个排列`
      + `${missing.length ? `；漏了 ${missing.join("、")}` : ""}`
      + `${unknown.length ? `；出现了不存在的 ${unknown.join("、")}` : ""}`
      + `${duplicated.length ? `；重复了 ${[...new Set(duplicated)].join("、")}` : ""}`
    );
  }

  if (details.length) {
    throw new OutputContractError(
      `storyCandidateReview 覆盖率核验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
  checks.forEach((check, index) => {
    check.title = String(list[index]?.title || "");
  });
  deriveCandidateReviewVerdicts(review);
  return review;
}

/**
 * 十一个维度的完整性判定。**纯集合与区间比较，零语义**——它不裁决分数打得对不对，
 * 只保证每个维度都被评过一次、id 没写错、分数在 0-10 内。
 *
 * 判定照搬原分镜终审校验（animation-plan-review-validation.js，已随旧分镜一并删除）里同名那段的写法，权重表同样是
 * Object.freeze 常量；差别只在这里的权重表与提示词、浏览器共用一份。
 */
function validateCandidateReviewDimensions(check, index, push) {
  const expected = Object.keys(CANDIDATE_REVIEW_DIMENSION_WEIGHTS);
  const rows = Array.isArray(check?.dimensions) ? check.dimensions : [];
  const seen = new Set();
  rows.forEach((row, order) => {
    const id = String(row?.id || "");
    if (!(id in CANDIDATE_REVIEW_DIMENSION_WEIGHTS)) {
      push(
        "CANDIDATE_REVIEW_DIMENSION_UNKNOWN",
        `/candidateChecks/${index}/dimensions/${order}/id`,
        `未知维度「${id || "（空）"}」；只能用这 ${expected.length} 个：${expected.join("、")}`
      );
      return;
    }
    if (seen.has(id)) {
      push(
        "CANDIDATE_REVIEW_DIMENSION_DUPLICATE",
        `/candidateChecks/${index}/dimensions/${order}/id`,
        `维度「${id}」重复；每个维度只评一次`
      );
      return;
    }
    seen.add(id);
  });
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length) {
    push(
      "CANDIDATE_REVIEW_DIMENSION_MISSING",
      `/candidateChecks/${index}/dimensions`,
      `缺少维度：${missing.join("、")}；总分按固定权重加权，少一个就算不出来`
    );
  }
}

/**
 * dominantDefect 的枚举一致性。
 *
 * 定死枚举是为了防漂移：同一个问题被写成 weak_hook / hook_problem / poor_hook
 * 三种拼法之后，跨批次统计就全废了。type 复用十一个维度 id 加三个特殊值，
 * 于是判定退化成一次集合成员比较（schema 已经管住取值，这里管两者一致）。
 *
 * `none` 出口是有意留的：候选确实没有主要缺陷时不该逼它硬找一个。
 */
function validateCandidateReviewDefect(check, index, push) {
  const defect = check?.dominantDefect;
  const type = String(defect?.type || "");
  const severity = String(defect?.severity || "");
  const isNone = type === "none";
  const isNoneSeverity = severity === "NONE";
  if (isNone !== isNoneSeverity) {
    push(
      "CANDIDATE_REVIEW_DEFECT_INCONSISTENT",
      `/candidateChecks/${index}/dominantDefect`,
      `type 与 severity 必须同时是「无缺陷」或同时不是；现在是 type=${type || "（空）"}、severity=${severity || "（空）"}`
    );
    return;
  }
  if (!isNone && !String(defect?.description || "").trim()) {
    push(
      "CANDIDATE_REVIEW_DEFECT_DESCRIPTION_EMPTY",
      `/candidateChecks/${index}/dominantDefect/description`,
      `判了 ${type}/${severity} 就必须写清楚缺陷是什么；只有 type=none 才允许留空`
    );
  }
  // 背景设定类缺陷**封顶 MAJOR，不许判 BLOCKER**（2026-09-12）。
  //
  // 它说的是「候选偷偷引入了一个上游从没建立过的背景事实」，例如固定搭档的猫
  // 为什么住在院子的纸箱里。这类问题值得报，但它**不是对已签发事实的违反**：
  // fixedCharacter 只写明它是固定搭档，从没规定它住哪儿。而 BLOCKER 在这里有
  // 机械后果（直接把放行决定降下来），拿它压一个推断出来的违和感，力度不对。
  //
  // 这是一条**政策上限，不是推导**：判定只有一次枚举比较，但「该不该封顶」
  // 是人定的。真遇到致命的背景设定问题，仍然可以在 description 里写清楚，
  // 并用 causalLogic 之类的类型判 BLOCKER。
  if (type === "setting_assumption" && severity === "BLOCKER") {
    push(
      "CANDIDATE_REVIEW_DEFECT_SEVERITY_CAP",
      `/candidateChecks/${index}/dominantDefect/severity`,
      "setting_assumption 最高只能判 MAJOR：它是候选偷偷引入的背景设定，"
      + "不是对已签发角色事实的违反；如果这个问题真的致命，"
      + "说明它其实属于别的类型（例如 causalLogic 或角色边界冲突），换成那个类型再判 BLOCKER"
    );
  }
}

/**
 * 物理机制的可信度必须写出它依赖什么（2026-09-12，来自首次真实回放）。
 *
 * 实测：模型把「下雨天用胶带把落叶贴在纸箱上做防水」直接判成「物理上可行，
 * 因果逻辑成立」并给 causalLogic 8 分——而正在下雨时落叶与纸箱都是湿的、
 * 普通胶带未必粘得牢。逼它改判「不可行」只是换一个方向的过度自信；
 * 真正缺的那一档是**「在某些条件下成立，而候选没有交代那些条件」**。
 *
 * 所以闸门只做一件事：**自称 conditional / unlikely 就必须把依赖的条件与失败风险写出来**。
 * 判定是纯非空检查——「这个机制到底成不成立」是语义判断，没有兜底。
 */
function validateCandidateReviewAssumptions(check, index, push) {
  (Array.isArray(check?.physicalAssumptions) ? check.physicalAssumptions : [])
    .forEach((row, order) => {
      const confidence = String(row?.confidence || "");
      if (confidence !== "conditional" && confidence !== "unlikely") return;
      const assumptions = (Array.isArray(row?.necessaryAssumptions) ? row.necessaryAssumptions : [])
        .filter((entry) => String(entry || "").trim());
      if (!assumptions.length) {
        push(
          "CANDIDATE_REVIEW_ASSUMPTION_INCOMPLETE",
          `/candidateChecks/${index}/physicalAssumptions/${order}/necessaryAssumptions`,
          `判了 ${confidence} 就必须列出它依赖哪些候选没有交代的条件`
          + "（材料干湿、摩擦力、承重、粘合强度、尺寸、位置之类）；否则这个判定没有任何可核对的内容"
        );
      }
      if (!String(row?.failureRisk || "").trim()) {
        push(
          "CANDIDATE_REVIEW_ASSUMPTION_INCOMPLETE",
          `/candidateChecks/${index}/physicalAssumptions/${order}/failureRisk`,
          `判了 ${confidence} 就必须写清楚那些条件不成立时画面上会出什么问题`
        );
      }
    });
}

/**
 * 修改建议的完整性。**除 remove 外的四种 kind 都必须写 whyOnlyHere。**
 *
 * 只对 add 强制是不够的：模板化不只发生在新增。「把结尾替换成奶奶摸摸头」是
 * replace，照样是模板。只要提出一个正向创作方案，就必须说明它为什么依赖
 * 这个故事已有的角色、道具、动作或伏笔；答不上来就是 generic 风险。
 *
 * 闸门只查非空，**答得对不对是语义判断，没有兜底**。
 */
function validateCandidateReviewSuggestions(check, index, push) {
  (Array.isArray(check?.top3RevisionSuggestions) ? check.top3RevisionSuggestions : [])
    .forEach((row, order) => {
      const kind = String(row?.kind || "");
      if (kind === "remove") return;
      if (String(row?.whyOnlyHere || "").trim()) return;
      push(
        "CANDIDATE_REVIEW_SUGGESTION_WHY_MISSING",
        `/candidateChecks/${index}/top3RevisionSuggestions/${order}/whyOnlyHere`,
        `${kind || "（空）"} 类建议必须回答「为什么这个动作只能发生在这个故事里」`
        + "；答不出来就说明它是一条谁都能用的模板建议（只有 remove 可以留空）"
      );
    });
}

/** 批次模板收敛的集合一致性。converged 与名单必须同真同假，纯集合比较。 */
function validateCandidateReviewBatchConvergence(review, list, push) {
  const convergence = review?.batchTemplateConvergence;
  if (!convergence || typeof convergence !== "object") return;
  const ids = new Set(list.map((candidate) => String(candidate?.id || "").trim()).filter(Boolean));
  const affected = Array.isArray(convergence.affectedCandidateIds) ? convergence.affectedCandidateIds : [];
  if (convergence.converged === true) {
    if (affected.length < 2) {
      push(
        "CANDIDATE_REVIEW_BATCH_CONVERGENCE_TOO_FEW",
        "/batchTemplateConvergence/affectedCandidateIds",
        "判定这一批共用同一套深层机制，就至少要点名两个候选——一个候选不构成收敛"
      );
    }
    affected.forEach((entry, order) => {
      const id = String(entry || "").trim();
      if (ids.has(id)) return;
      push(
        "CANDIDATE_REVIEW_BATCH_CONVERGENCE_UNKNOWN",
        `/batchTemplateConvergence/affectedCandidateIds/${order}`,
        `点名了不存在的候选「${id || "（空）"}」`
      );
    });
    if (!String(convergence.sharedMechanism || "").trim()) {
      push(
        "CANDIDATE_REVIEW_BATCH_CONVERGENCE_MECHANISM_EMPTY",
        "/batchTemplateConvergence/sharedMechanism",
        "判定收敛就必须写出它们共用的到底是哪一套机制，不能只给一个布尔值"
      );
    }
    return;
  }
  if (affected.length) {
    push(
      "CANDIDATE_REVIEW_BATCH_CONVERGENCE_NOT_CONVERGED",
      "/batchTemplateConvergence/affectedCandidateIds",
      "converged 是 false 就不该点名任何候选；要么改成 true，要么把名单清空"
    );
  }
}

/**
 * 分数 → 等级 → 放行决定的派生链。**四段全部确定性，模型回显一律覆盖。**
 *
 * ```
 * 11 维分数（模型）→ overallScore → tier → scoreBasedVerdict
 *                                        → 取最严 → effectiveVerdict + overrideReasons
 * ```
 *
 * 拆成四个字段而不是一个 verdict，是因为它们回答的是四个不同的问题：
 * 分数回答「它本身有多好」，等级回答「它属于哪一档」，硬闸门回答「有没有不能带进
 * FullStory 的问题」，最终决定回答「现在放不放行」。挤在一起就会出现
 * 「9.2 分必须判 pass」与「有因果断裂不许判 pass」互相打架，而这两件事同时成立。
 *
 * 顺带消掉「模型自己加权算错」整类失败：它根本不写这些字段。
 */
function deriveCandidateReviewVerdicts(review) {
  const checks = Array.isArray(review?.candidateChecks) ? review.candidateChecks : [];
  checks.forEach((check) => {
    const overallScore = candidateOverallScore(check.dimensions);
    const tier = candidateTier(overallScore);
    const reasons = [];
    if ((Array.isArray(check.coherenceChecks) ? check.coherenceChecks : []).length) {
      reasons.push("coherence_break");
    }
    const scaffoldScore = check.sourceScaffoldOverlap?.score;
    if (Number.isInteger(scaffoldScore) && scaffoldScore >= SOURCE_SCAFFOLD_COPY_SCORE) {
      reasons.push("scaffold_copy");
    }
    if (String(check.dominantDefect?.severity || "") === "BLOCKER") {
      reasons.push("blocker_defect");
    }
    check.overallScore = overallScore === null ? 0 : overallScore;
    check.tier = tier.id;
    check.scoreBasedVerdict = tier.verdict;
    check.verdictOverrideReasons = reasons;
    check.effectiveVerdict = candidateEffectiveVerdict(tier.verdict, reasons);
  });

  // **这里有两个「谁更好」的系统，刻意不合并、也不强制对齐**（2026-09-12）：
  //
  //   scoreOrder                —— 十一维加权分从高到低，服务端派生
  //   holisticPreferenceOrder   —— 模型看完之后凭整体判断给的顺序
  //
  // 实测它们会分歧：一次回放里模型推荐先做 V1（6.83），而 V4 分更高（6.89）。
  // 强制模型把两者写成一样只是把信息藏起来——那个分歧本身才是有价值的观察
  // （「为什么整体上更喜欢 V1，评分表却把 V4 算高」）。
  //
  // **生产用 scoreOrder**：winner / runnerUp 从它派生，口径唯一、可复算。
  // 依据是抖动数据：加权分能可靠分出最好与最差（最佳候选 3/3 排第一、sd 0.09），
  // 中段次序不可靠——而 winner 只取第一名，正好落在它可靠的那一段。
  const scoreOrder = checks
    .map((check, index) => ({ id: String(check.candidateId || ""), score: Number(check.overallScore), index }))
    // 分数相同时按原顺序，保证同一份报告每次算出来都一样。
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.id);
  const allDropped = checks.length > 0 && checks.every((check) => check.effectiveVerdict === "drop");
  const verdictById = new Map(checks.map((check) => [String(check.candidateId || ""), check.effectiveVerdict]));
  review.scoreOrder = scoreOrder;
  review.recommendedWinner = allDropped ? "" : (scoreOrder[0] || "");
  review.runnerUp = allDropped ? "" : (scoreOrder[1] || "");
  review.rejectOrRegenerate = scoreOrder.filter((id) => verdictById.get(id) === "drop");
  return review;
}

/** 展开前承诺核对里判为「没演出来」的两档。路由与修订信号共用这一份，不另写第二份。 */
export const FULL_STORY_PROMISE_UNREALIZED_VERDICTS = Object.freeze(["partially_realized", "not_realized"]);

const FULL_STORY_PROMISE_SOURCES = Object.freeze(["title", "oneLineHook"]);

function promiseSourceText(candidate) {
  return {
    title: String(candidate?.title || ""),
    oneLineHook: String(candidate?.oneLineHook || "")
  };
}

function throwPromiseContractError(label, details) {
  if (!details.length) return;
  throw new OutputContractError(
    `${label}：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
    details
  );
}

/**
 * 判定由逐条结果**确定性派生**，模型不写 verdict：
 * 全部找到 = realized，找到一部分 = partially_realized，一条都没找到 = not_realized。
 * 标题被判为不构成承诺时直接是 not_a_promise，不参与统计。
 */
export function derivePromiseVerdict(kind, mustSee, findings) {
  if (kind === "not_a_promise") return "not_a_promise";
  const total = Array.isArray(mustSee) ? mustSee.length : 0;
  if (!total) return "not_realized";
  const found = (Array.isArray(findings) ? findings : []).filter((entry) => entry?.found === true).length;
  if (found >= total) return "realized";
  return found > 0 ? "partially_realized" : "not_realized";
}

/**
 * 第一步：**盲写的**承诺清单。这一步的输入不含动作链，所以这里能核验的只有
 * 「摘句是不是真的来自标题或钩子」与「两个来源都核对过」。
 *
 * 分两步是实测结论（2026-09-16）：单次调用里动作链一直在上下文中，模型会照着
 * 动作链倒推期待——同一个标题在两个候选上写出相反的 mustSee，于是两边都判已兑现。
 */
export function ensureFullStoryPromiseListContract(list, candidate) {
  requireObject(list, "fullStoryPromiseList");
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  const candidateId = String(candidate?.id || "").trim();
  if (String(list.candidateId || "").trim() !== candidateId) {
    push(
      "PROMISE_CHECK_CANDIDATE_MISMATCH",
      "/candidateId",
      `本次核对的是候选「${candidateId}」，清单写的是「${String(list.candidateId || "")}」`
    );
  }
  const sourceText = promiseSourceText(candidate);
  const promises = Array.isArray(list.promises) ? list.promises : null;
  if (!promises) {
    push("PROMISE_CHECK_LIST_INVALID", "/promises", "promises 必须是数组");
  }
  const covered = new Set();
  (promises || []).forEach((entry, index) => {
    const source = String(entry?.source || "");
    const text = sourceText[source];
    if (text === undefined) {
      push("PROMISE_CHECK_LIST_INVALID", `/promises/${index}/source`, "source 只能是 title 或 oneLineHook");
      return;
    }
    covered.add(source);
    const quote = normalizeStoryReviewEcho(entry?.quote);
    if (!quote || !normalizeStoryReviewEcho(text).includes(quote)) {
      push(
        "PROMISE_CHECK_QUOTE_NOT_IN_SOURCE",
        `/promises/${index}/quote`,
        `quote 必须逐字摘自候选的 ${source}「${text}」，不得概括或改写`
      );
    }
    const kind = String(entry?.kind || "");
    // 判定不分 kind：promise 一律不能为空（浏览器体检面板会逐条显示它）。只有理由按 kind 写——
    // 这句会原样进重试提示词，对 not_a_promise 说「写清楚观众期待看到什么」自相矛盾，
    // 2026-09-24 MiMo 重试时照样写空串，同形失败第二次。
    if (!String(entry?.promise || "").trim()) {
      push(
        "PROMISE_CHECK_LIST_INVALID",
        `/promises/${index}/promise`,
        kind === "not_a_promise"
          ? "判 not_a_promise 时 promise 也不能留空：写一句话说明这个标题为什么没有许诺看得见的东西"
          : "promise 必须写清楚观众因此期待看到什么"
      );
    }
    if (kind !== "promise" && kind !== "not_a_promise") {
      push("PROMISE_CHECK_LIST_INVALID", `/promises/${index}/kind`, "kind 只能是 promise 或 not_a_promise");
      return;
    }
    if (kind === "not_a_promise" && source !== "title") {
      push(
        "PROMISE_CHECK_HOOK_NOT_A_PROMISE",
        `/promises/${index}/kind`,
        "oneLineHook 本身就是承诺，不能判 not_a_promise；只有标题可以用这个值"
      );
    }
    const mustSee = (Array.isArray(entry?.mustSee) ? entry.mustSee : [])
      .filter((item) => String(item || "").trim());
    if (kind === "promise" && !mustSee.length) {
      push(
        "PROMISE_CHECK_MUST_SEE_EMPTY",
        `/promises/${index}/mustSee`,
        "只要是承诺，就必须写出观众要亲眼看到的 1–3 件事，否则后面没有可核对的内容"
      );
    }
    if (mustSee.length > 3) {
      push("PROMISE_CHECK_LIST_INVALID", `/promises/${index}/mustSee`, "最多 3 条");
    }
  });
  for (const source of FULL_STORY_PROMISE_SOURCES) {
    if (!sourceText[source].trim() || covered.has(source)) continue;
    push(
      "PROMISE_CHECK_SOURCE_MISSING",
      "/promises",
      `候选的 ${source}「${sourceText[source]}」至少要核对一条，不能跳过`
    );
  }
  throwPromiseContractError("fullStoryPromiseList 核验失败", details);
  return list;
}

/**
 * 第二步：逐条定位。**覆盖率由构造保证**——每个 (promiseIndex, mustSeeIndex) 必须
 * 恰好回答一次，漏一条就拦下，模型无法只挑好找的那几条回答。
 *
 * 判 found 必须给出**那一拍原文的逐字引用**：这不能证明它理解对了，但能证明
 * 它确实指着某一句话说话，而不是凭印象宣布「演了」。判没找到必须写原因。
 */
export function ensureFullStoryPromiseFindingsContract(promiseFindings, promiseList, candidate) {
  requireObject(promiseFindings, "fullStoryPromiseFindings");
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  const candidateId = String(candidate?.id || "").trim();
  if (String(promiseFindings.candidateId || "").trim() !== candidateId) {
    push(
      "PROMISE_CHECK_CANDIDATE_MISMATCH",
      "/candidateId",
      `本次核对的是候选「${candidateId}」，定位结果写的是「${String(promiseFindings.candidateId || "")}」`
    );
  }
  const promises = Array.isArray(promiseList?.promises) ? promiseList.promises : [];
  const outline = Array.isArray(candidate?.storyOutline) ? candidate.storyOutline : [];
  const actionByBeat = new Map(outline.map((beat) => [Number(beat?.beat), String(beat?.action || "")]));
  const expected = new Set();
  promises.forEach((entry, promiseIndex) => {
    if (String(entry?.kind || "") === "not_a_promise") return;
    (Array.isArray(entry?.mustSee) ? entry.mustSee : []).forEach((item, mustSeeIndex) => {
      if (!String(item || "").trim()) return;
      expected.add(`${promiseIndex}:${mustSeeIndex}`);
    });
  });
  const seen = new Set();
  const rows = Array.isArray(promiseFindings.findings) ? promiseFindings.findings : null;
  if (!rows) push("PROMISE_CHECK_FINDINGS_INVALID", "/findings", "findings 必须是数组");
  (rows || []).forEach((row, index) => {
    const key = `${Number(row?.promiseIndex)}:${Number(row?.mustSeeIndex)}`;
    if (!expected.has(key)) {
      push(
        "PROMISE_CHECK_FINDING_UNKNOWN",
        `/findings/${index}`,
        `清单里没有第 ${row?.promiseIndex} 条承诺的第 ${row?.mustSeeIndex} 项，不能凭空回答`
      );
      return;
    }
    if (seen.has(key)) {
      push("PROMISE_CHECK_FINDING_DUPLICATE", `/findings/${index}`, "同一项只能回答一次");
      return;
    }
    seen.add(key);
    if (row?.found === true) {
      const action = actionByBeat.get(Number(row?.beat));
      if (action === undefined) {
        push(
          "PROMISE_CHECK_UNKNOWN_BEAT",
          `/findings/${index}/beat`,
          `引用了不存在的拍号 ${row?.beat}；该候选只有 ${outline.length} 拍`
        );
        return;
      }
      const evidence = normalizeStoryReviewEcho(row?.evidence);
      if (!evidence || !normalizeStoryReviewEcho(action).includes(evidence)) {
        push(
          "PROMISE_CHECK_EVIDENCE_NOT_IN_BEAT",
          `/findings/${index}/evidence`,
          `判「演出来了」就必须逐字引用第 ${row?.beat} 拍 action 里的原文，不能转述或另写一句`
        );
      }
      return;
    }
    if (!String(row?.why || "").trim()) {
      push(
        "PROMISE_CHECK_WHY_MISSING",
        `/findings/${index}/why`,
        "判「没找到」必须写清楚动作链里实际写的是什么"
      );
    }
  });
  for (const key of expected) {
    if (seen.has(key)) continue;
    const [promiseIndex, mustSeeIndex] = key.split(":");
    push(
      "PROMISE_CHECK_FINDING_MISSING",
      "/findings",
      `第 ${promiseIndex} 条承诺的第 ${mustSeeIndex} 项没有回答；每一项都必须逐条给出结论`
    );
  }
  throwPromiseContractError("fullStoryPromiseFindings 核验失败", details);
  return promiseFindings;
}

/**
 * 合成后的整份报告。它会跨 HTTP 回到服务端（定向修订拿它当输入），所以要重新核验：
 * 摘句仍然来自标题或钩子、证据仍然来自它引用的那一拍、**verdict 必须等于按逐条结果
 * 重新派生出来的值**——重新派生就把「改一个字段让它看起来没问题」这条路堵死了。
 */
export function ensureFullStoryPromiseCheckCoversCandidate(check, candidate) {
  requireObject(check, "fullStoryPromiseCheck");
  ensureFullStoryPromiseListContract(
    {
      candidateId: check.candidateId,
      promises: (Array.isArray(check.promises) ? check.promises : []).map((entry) => ({
        source: entry?.source,
        quote: entry?.quote,
        kind: entry?.kind,
        promise: entry?.promise,
        mustSee: entry?.mustSee
      }))
    },
    candidate
  );
  ensureFullStoryPromiseFindingsContract(
    {
      candidateId: check.candidateId,
      findings: (Array.isArray(check.promises) ? check.promises : []).flatMap((entry, promiseIndex) => (
        (Array.isArray(entry?.findings) ? entry.findings : []).map((finding) => ({ ...finding, promiseIndex }))
      ))
    },
    { promises: check.promises },
    candidate
  );
  const details = [];
  (Array.isArray(check.promises) ? check.promises : []).forEach((entry, index) => {
    const derived = derivePromiseVerdict(entry?.kind, entry?.mustSee, entry?.findings);
    if (String(entry?.verdict || "") === derived) return;
    details.push({
      code: "PROMISE_CHECK_VERDICT_NOT_DERIVED",
      path: `/promises/${index}/verdict`,
      reason: `verdict 由服务端从逐条结果派生，应当是「${derived}」，收到的是「${String(entry?.verdict || "")}」`
    });
  });
  throwPromiseContractError("fullStoryPromiseCheck 覆盖率核验失败", details);
  return check;
}

/**
 * 回显必须完整包含原文（忽略空白与标点差异）。截断、复述、读错条目都不满足。
 *
 * 归一化到标点这一层的理由：**覆盖率并不靠这条检查保证**——
 * 「有没有漏检」由数量相等保证，「有没有错位」由 sceneId / index 逐位比对保证。
 * 回显唯一多提供的是「你有没有真看这一条的内容」，比前两者弱得多。
 * 而实测它挡下的全是标点差异（「关键选择，打破…」被回显成「关键选择：打破…」），
 * 那不构成任何歧义。把标点也归一化之后，复述与截断仍然会被拒，
 * 覆盖率的两道真闸门一个字都没动。
 */
function storyReviewEchoCoversSource(echo, source) {
  const target = normalizeStoryReviewEcho(source);
  if (!target) return true;
  return normalizeStoryReviewEcho(echo).includes(target);
}

/** 去掉空白与中英文标点，只留下实词——身份判定不该被一个冒号推翻。 */
function normalizeStoryReviewEcho(value) {
  return String(value ?? "")
    .replace(/\s/gu, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

export function deriveFullStoryTargetDuration(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sceneScript)) return value;
  let total = 0;
  for (const scene of value.sceneScript) {
    const span = parseSceneTimeRangeSeconds(scene?.timeRange);
    // 时间轴本身不可解析时不在这里裁决：sceneScript 的 timeRange 校验
    // 由 direct_shot 骨架派生统一负责，这里静默让出，避免两处给出不同的失败。
    if (span === null) return value;
    total += span;
  }
  if (total <= 0) return value;
  return { ...value, targetDurationSeconds: total };
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
  if (isStoryboardPlan(value)) {
    ensureStoryboardPlan(value, context.fullStory ? { fullStory: context.fullStory, targetDurationSeconds: context.fullStory.targetDurationSeconds } : {});
    if (variant?.id && value.selectedVariantId !== variant.id) throw new OutputContractError("新版 Animation Plan 与当前候选不一致");
    for (const reference of value.characterReferencePrompts) ensureCharacterReferenceMatchesBoundary(reference, visualGuardrails);
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError("animationPlan 必须是对象");
  throw legacyAnimationPlanContractError(value);
}

// direct_shot 3.1 的单镜时长边界现在住在零依赖的 src/shot-duration-limits.js：
// 自主分镜的 ajv schema 在模块求值期就要读它，而本文件与 storyboard-contract.js
// 相互导入，从这里取会落进暂时性死区。原样 re-export，既有消费者一个都不用改。
export { DIRECT_SHOT_MIN_DURATION_SECONDS, DIRECT_SHOT_MAX_DURATION_SECONDS };

// timeRange 只有这一份解析规则，禁止在别处再写第二份。
// 秒位放宽到 0–99 是确定性算术而不是推断：mm:ss 下 "00:60" 只可能是 60 秒，
// 与 "01:00" 完全等价。模型把 00:59 的下一秒写成 00:60 是高频笔误，
// 按 m*60+s 折算既不删信息也不猜，真正畸形的值仍然解析失败。
const SCENE_TIME_RANGE_PATTERN = /^\s*(\d{1,3}):(\d{1,2})\s*[-–—~]\s*(\d{1,3}):(\d{1,2})\s*$/u;

// "00:15-00:33" → { startSeconds: 15, endSeconds: 33 }。格式不符返回 null。
// 这里不判断跨度正负：调用方各自决定非正跨度该失败还是该忽略。
export function parseSceneTimeRangeBounds(timeRange) {
  const match = SCENE_TIME_RANGE_PATTERN.exec(String(timeRange || ""));
  if (!match) return null;
  return {
    startSeconds: Number(match[1]) * 60 + Number(match[2]),
    endSeconds: Number(match[3]) * 60 + Number(match[4])
  };
}

// "00:15-00:33" → 18 秒。格式不符或非正跨度一律返回 null：
// timeRange 是模型产物，不得靠猜测补一个场次时长出来。
export function parseSceneTimeRangeSeconds(timeRange) {
  const bounds = parseSceneTimeRangeBounds(timeRange);
  if (!bounds) return null;
  const span = bounds.endSeconds - bounds.startSeconds;
  return span > 0 ? span : null;
}

// 返回空字符串表示合规；非空字符串就是唯一的偏差描述。
// 角色参考阶段只提醒不阻断，成片渲染阶段仍由 ensure* 包装器硬失败。
// 判定与补写必须共用同一份扫描口径：补写要补的，就是判定要查的那几个字段。
// 两边各写一份必然漂移，那正是「判定规则只有一份」要防的事。
function characterReferenceBoundaryScanFields(value = {}) {
  return [
    value.characterName,
    value.storyRole,
    value.identity,
    value.appearancePrompt,
    ...(Array.isArray(value.consistencyTags) ? value.consistencyTags : [])
  ].filter(Boolean).join("\n");
}

// 返回这条角色参考缺失的全局必需事实（exact canonicalName）。非固定角色恒为空数组，
// 与 characterReferenceBoundaryMismatch 的短路口径一致。
export function characterReferenceMissingRequiredTraits(value, visualGuardrails = null) {
  return missingRequiredTraitEntries(value, visualGuardrails).map((trait) => trait.canonicalName);
}

// 可由服务端确定性补回的缺失事实：**只包含非 appearance scope**。
// 外观必需事实缺失意味着模型真的把长相写错了（比如把狼耳少女写成短发儿童），
// 补一个标签不会让图里长出狼耳——那种情况必须继续提醒，并在成片渲染前硬失败。
// 身份、性格、职业、剧情功能这类事实天然不属于给图像模型的外观描述，判定又同时扫
// identity 与 consistencyTags，把它们补回标签是如实记账，不是掩盖。
export function characterReferenceRestorableMissingTraits(value, visualGuardrails = null) {
  return missingRequiredTraitEntries(value, visualGuardrails)
    .filter((trait) => trait.scope !== "appearance")
    .map((trait) => trait.canonicalName);
}

function missingRequiredTraitEntries(value, visualGuardrails = null) {
  const boundary = visualGuardrails?.fixedCharacterBoundary;
  if (!boundary || String(value?.characterName || "").trim() !== String(boundary.characterName || "").trim()) return [];
  const fields = characterReferenceBoundaryScanFields(value);
  const missing = new Set(findMissingGlobalCharacterTraits(fields, boundary.requiredTraits));
  return (boundary.requiredTraits || []).filter((trait) => missing.has(trait?.canonicalName));
}

export function characterReferenceBoundaryMismatch(value, visualGuardrails = null) {
  const boundary = visualGuardrails?.fixedCharacterBoundary;
  if (!boundary || String(value?.characterName || "").trim() !== String(boundary.characterName || "").trim()) return "";
  const fields = characterReferenceBoundaryScanFields(value);
  // 否定语境放行：「无企鹅服装、无动物拟态服装」是模型在**服从**边界，不是把禁止
  // 特征写了回来。缺了这个参数，模型照做反而被判违规——实测 appearancePrompt 结尾
  // 那句「无企鹅服装，无动物拟态服装」把整条角色参考在成片渲染前拦死。
  // 判定与 characterPromptBoundaryMismatch 共用同一份实现，不新建第二套词表。
  const forbiddenHits = findTerms(fields, collectGlobalCharacterForbiddenTerms(visualGuardrails), {
    allowNegativeContext: true
  });
  const missingRequiredTraits = characterReferenceMissingRequiredTraits(value, visualGuardrails);
  const mismatches = [];
  if (forbiddenHits.length) mismatches.push(`混入全局边界禁止特征：${forbiddenHits.join("、")}`);
  if (missingRequiredTraits.length) mismatches.push(`缺少全局必需角色事实：${missingRequiredTraits.join("、")}`);
  return mismatches.length ? `characterReference 未沿用全局角色边界：${mismatches.join("；")}` : "";
}

export function ensureCharacterReferenceMatchesBoundary(value, visualGuardrails = null) {
  const mismatch = characterReferenceBoundaryMismatch(value, visualGuardrails);
  if (mismatch) throw new OutputContractError(mismatch);
  return value;
}

export function characterPromptBoundaryMismatch(text, visualGuardrails = null, {
  characterName = "",
  requireRequiredTraits = true,
  promptScope = "fixed_character"
} = {}) {
  const boundary = visualGuardrails?.fixedCharacterBoundary;
  if (!boundary) return "";
  if (promptScope === "multi_character") return "";
  if (characterName && String(characterName).trim() !== String(boundary.characterName || "").trim()) return "";
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
  return mismatches.length ? `角色生成提示词未沿用全局角色边界：${mismatches.join("；")}` : "";
}

export function ensureCharacterPromptMatchesBoundary(text, visualGuardrails = null, options = {}) {
  const mismatch = characterPromptBoundaryMismatch(text, visualGuardrails, options);
  if (mismatch) throw new InputError(mismatch);
  return text;
}

export function extractFixedCharacterName(fixedCharacter) {
  if (typeof fixedCharacter !== "string") return "";
  const text = fixedCharacter.trim();
  if (!text) return "";
  // 冒号是「名字：描述」这种写法的分隔符，必须和逗号顿号同级——否则第一段会连描述一起被
  // 当成角色名（`小白子：q 版狼耳少女`），下游 includes/等值判定要么硬失败，要么靠模型
  // 原样回抄整段而以错误的方式通过。半角冒号一并处理，英文写法同理。
  const firstSegment = text.split(/[，,；;、。:：\n\r（(]/u)[0]?.trim() || "";
  // 取名标签只认起点落在第一段里的（「角色名：小白子」「她叫小白，…」「名叫小白子，…」）。
  // 描述后文里的「叫」「名字」只是描述：「…开心时会发出嗷呜的叫声」曾被取成「声」、
  // 「喜欢叫奶奶陪她玩」取成「奶奶陪她玩」、「大家都叫她小白」取成「她小白」。
  // 2026-09-19 起提示词让模型逐字照写这个名字，错名因此会通过校验并被签发（2026-10-05 修复）。
  // 标签词表不增不减；本机 5 份历史设定按新规则取名逐字不变。
  const explicit = text.match(/(?:角色名|姓名|名字|名叫|叫|昵称)[:：为是叫\s]*([一-龥A-Za-z0-9_-]{1,16})/u);
  if (explicit?.[1] && explicit.index < firstSegment.length) return stripNameWrapper(explicit[1]);
  const spaceMatch = firstSegment.match(/^([一-龥A-Za-z0-9_-]{1,16})(?:\s|$)/u);
  return stripNameWrapper(spaceMatch?.[1] || firstSegment);
}

/**
 * storyEngine 五个子字段的形状校验。
 *
 * 依据：briefPrompt 正文里 storyEngine 与它的五个子字段此前**各出现恰好 1 次**——就是输出
 * 模板那个空槽位，没有定义、没有规则、没有举例、零校验器。它是整份简报里唯一一个子字段
 * 全无定义的子对象（nonNegotiableExperience、reusableHighValueBeats、allowedNarrativeComponents 都有）。
 *
 * 实测后果：三个真实导出包里 turningMechanism 一份是真机制、一份可用、一份写成了剧情概括
 * （「主角主动采取防护措施继续参与活动，展现机灵与懂事」）。**那不是模型写错**——「转折机制」
 * 最自然的读法就是剧情转折点，而没人告诉过它这个字段要写的是关系/理解的改变。
 *
 * 因此 turningMechanism 改成 {before, after} 两个槽位：混在一个字符串里时程序无法知道哪一半
 * 描述哪一端，这与 transformationProof 的 {source, replacement} 是同一个招式。
 *
 * **闸门只抓退化，不保证判对。** before !== after 能抓住「两边写同一句话」这种同义重复，
 * 但**无法**判断写出来的转变是不是真的发生在关系上——那需要语义判断，没有确定性兜底。
 * 「恰好两个键」同样重要：它挡住模型顺手补第三个键把定义稀释掉。
 *
 * 只在生成路径生效：ensureOutputContract(_, "creativeBrief") 全项目只在 createBrief 里调用，
 * 下游 variants / visualGuardrails / fullStory 都是裸 requireObject。所以 turningMechanism
 * 仍是字符串的旧简报不会被它拒绝，照常加载——与已下线方言「所有调用点都是生成路径」同型。
 */
const STORY_ENGINE_TEXT_FIELDS = Object.freeze(["desire", "obstacle", "escalation", "payoff"]);
const STORY_ENGINE_TURNING_KEYS = Object.freeze(["before", "after"]);

/**
 * 「把主角换成一个性格完全不同的人，哪些部分会塌掉？」
 *
 * `storyEngine` 的五个键是一个**完整的事件结构模型**——问 desire 必然答「她想要什么」，
 * 在那个框架里加定义只会拿到更精确的事件描述。两轮真实回放（3.7-max 与 3.8-max-0902）
 * 写出的 turningMechanism 全部停在事件层与关系层，换模型也没变。
 *
 * 这个字段问的是另一件事：**只有这种性格的角色才会这么做的那部分是什么。**
 * 它刻意写成一个**操作**而不是一句定义——模型得真把主角换成另一种性格、逐拍试一遍，
 * 塌的进 collapses，不塌的进 survives。依据是这仓库的经验：结构性改动（拆槽位、
 * 清单收敛、拍号派生）都成功了，措辞性改动（三次加码「不许净增动作」）三次全被绕过。
 * 而 turningMechanism 加定义后实测 3/3 照抄提示词的措辞框架，正面定义救不了这个。
 *
 * **两个数组同时必填是全部要点。** 只要 collapses 的话模型可以把所有东西都塞进去；
 * 要求同时列出 survives，它就必须做区分——与 transformationProof 拆成
 * {source, replacement} 同一个招式：分开放，程序才知道哪边是哪边。
 *
 * 判定**全是类型、非空与集合比较，零语义**。归一化复用 normalizeStoryReviewEcho，
 * 不另写第二份。
 *
 * **闸门抓不到**：collapses 里写的是品质词（「她很活泼」）而不是具体动作。
 * 那需要语义判断，没有确定性兜底，只能靠提示词加人工看。
 */
function validateRecastTest(recastTest) {
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  // 与 validateStoryEngine 同一个口径：字符串且去空白后非空。
  const nonEmptyText = (value) => typeof value === "string" && Boolean(value.trim());
  if (!recastTest || typeof recastTest !== "object" || Array.isArray(recastTest)) {
    throw new OutputContractError(
      "creativeBrief.recastTest 必须是对象",
      [{ code: "CREATIVE_BRIEF_RECAST_TEST_INVALID", path: "/recastTest", reason: "必须是对象" }]
    );
  }
  const keys = Object.keys(recastTest).sort();
  const expected = ["collapses", "recastAs", "survives"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    push("CREATIVE_BRIEF_RECAST_TEST_INVALID", "/recastTest",
      `必须恰好含 recastAs、collapses、survives 三个键，收到：${keys.join("、") || "（空）"}`);
  }
  if (!nonEmptyText(recastTest.recastAs)) {
    push("CREATIVE_BRIEF_RECAST_TEST_FIELD_EMPTY", "/recastTest/recastAs",
      "必须写明换成什么样的角色，不能留空");
  }
  const sides = [["collapses", "换角之后不再成立的部分"], ["survives", "换角之后照样成立的部分"]];
  const normalized = {};
  for (const [key, label] of sides) {
    const list = Array.isArray(recastTest[key]) ? recastTest[key] : null;
    if (!list || !list.length || !list.every((item) => nonEmptyText(item))) {
      push("CREATIVE_BRIEF_RECAST_TEST_SIDE_EMPTY", `/recastTest/${key}`,
        `${label}至少要写 1 条非空字符串`);
      normalized[key] = [];
      continue;
    }
    normalized[key] = list.map((item) => normalizeStoryReviewEcho(item));
    const seen = new Set();
    normalized[key].forEach((item, index) => {
      if (seen.has(item)) {
        push("CREATIVE_BRIEF_RECAST_TEST_DUPLICATE", `/recastTest/${key}/${index}`,
          "同一侧内部不得重复同一条");
      }
      seen.add(item);
    });
  }
  // 核心闸门：同一件事不能既塌又不塌。它抓的是「模型没真做这个区分，两边都写了」。
  const survivesSet = new Set(normalized.survives || []);
  (normalized.collapses || []).forEach((item, index) => {
    if (survivesSet.has(item)) {
      push("CREATIVE_BRIEF_RECAST_TEST_OVERLAP", `/recastTest/collapses/${index}`,
        "同一条同时出现在 collapses 与 survives——换角之后它要么成立要么不成立，不能两边都算");
    }
  });
  if (details.length) {
    throw new OutputContractError(
      `creativeBrief.recastTest 不合规：${details.map((item) => item.reason).join("；")}`,
      details
    );
  }
}

function validateStoryEngine(storyEngine) {
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  if (!storyEngine || typeof storyEngine !== "object" || Array.isArray(storyEngine)) {
    throw new OutputContractError(
      "creativeBrief.storyEngine 必须是对象",
      [{ code: "CREATIVE_BRIEF_STORY_ENGINE_INVALID", path: "/storyEngine", reason: "必须是对象" }]
    );
  }
  for (const field of STORY_ENGINE_TEXT_FIELDS) {
    if (typeof storyEngine[field] === "string" && storyEngine[field].trim()) continue;
    push("CREATIVE_BRIEF_STORY_ENGINE_FIELD_EMPTY", `/storyEngine/${field}`, `${field} 必须是非空字符串`);
  }
  const turning = storyEngine.turningMechanism;
  if (!turning || typeof turning !== "object" || Array.isArray(turning)
    || Object.keys(turning).length !== STORY_ENGINE_TURNING_KEYS.length
    || !STORY_ENGINE_TURNING_KEYS.every((key) => Object.hasOwn(turning, key))) {
    push(
      "CREATIVE_BRIEF_STORY_ENGINE_TURNING_SHAPE_INVALID",
      "/storyEngine/turningMechanism",
      "必须是恰好含 before 与 after 两个键的对象；它写的是观众对人物关系的理解怎样改变，不是剧情转折点"
    );
  } else {
    for (const key of STORY_ENGINE_TURNING_KEYS) {
      if (typeof turning[key] === "string" && turning[key].trim()) continue;
      push("CREATIVE_BRIEF_STORY_ENGINE_TURNING_FIELD_EMPTY", `/storyEngine/turningMechanism/${key}`, `${key} 必须是非空字符串`);
    }
    const before = normalizeStoryReviewEcho(turning.before);
    const after = normalizeStoryReviewEcho(turning.after);
    if (before && after && before === after) {
      push(
        "CREATIVE_BRIEF_STORY_ENGINE_TURNING_NOT_SHIFTED",
        "/storyEngine/turningMechanism",
        "before 与 after 去掉空白与标点后完全相同；两端必须是对同一组人物关系的两种不同理解"
      );
    }
  }
  if (!details.length) return;
  throw new OutputContractError(
    `creativeBrief.storyEngine 不合契约：${details.map((d) => `${d.path} ${d.reason}`).join("；")}`,
    details
  );
}

/**
 * creative_brief/2.0 的顶层只允许 storyEngine 与 recastTest。与 recastTest「恰好三个键」同规格：
 * 模型在旧简报上训练出的习惯会把 contentType、allowedNarrativeComponents 之类写回来，
 * 多出来的键要么没人读、要么会被当成第二份原片解读，所以拒绝而不是静默删掉。
 * schemaVersion 由服务端盖章，模型写了同样算多余键。
 */
function validateCreativeBriefTopLevel(value) {
  const allowed = new Set(CREATIVE_BRIEF_MODEL_FIELDS);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (!unexpected.length) return;
  throw new OutputContractError(
    `creativeBrief 只允许 ${CREATIVE_BRIEF_MODEL_FIELDS.join("、")} 两个顶层键，多出：${unexpected.join("、")}`,
    unexpected.map((key) => ({
      code: "CREATIVE_BRIEF_UNEXPECTED_FIELD",
      path: `/${key}`,
      reason: "creative_brief/2.0 只保留 storyEngine 与 recastTest，其余原片信息由下游直接读原片分析与脚本还原"
    }))
  );
}

export function collectGlobalCharacterForbiddenTerms(visualGuardrails) {
  return uniqueBoundaryTerms(visualGuardrails?.fixedCharacterBoundary?.forbiddenTraits || []);
}

function uniqueBoundaryTerms(traits = []) {
  return [...new Set((traits || []).flatMap((trait) => Array.isArray(trait?.terms) ? trait.terms : []).map((term) => String(term || "").trim()).filter(Boolean))];
}

function findMissingGlobalCharacterTraits(text, traits = []) {
  const value = String(text || "");
  return (traits || []).filter((trait) => !(trait.terms || []).some((term) => term && value.includes(term)))
    .map((trait) => trait.canonicalName);
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
    pushArrayFields(fields, `sceneScript[${sceneIndex}].offscreenSoundSources`, scene?.offscreenSoundSources);
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

function findTerms(text, terms, { allowNegativeContext = false } = {}) {
  const value = String(text || "");
  return [...new Set((terms || []).filter((term) => (
    term && hasForbiddenOccurrence(value, term, { allowNegativeContext })
  )))];
}

function stripNameWrapper(value) {
  return String(value || "")
    .trim()
    .replace(/^[「『“”"'\s]+/u, "")
    .replace(/[」』“”"'\s]+$/u, "");
}
