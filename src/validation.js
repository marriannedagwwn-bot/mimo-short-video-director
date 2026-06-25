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
  themeVariants: ["variants"],
  fullStory: ["selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis", "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide", "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"],
  animationPlan: ["selectedVariantId", "title", "productionStrategy", "visualBible", "characterReferencePrompts", "assetPrompts", "shotPlan", "editPlan", "generationChecklist", "modelAgnosticNotes", "continuityAndSafetyCheck", "uncertainties"]
};

export function ensureOutputContract(value, contract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${contract} 必须是对象`);
  const missing = (outputContracts[contract] || []).filter((key) => !(key in value));
  if (missing.length) throw new OutputContractError(`${contract} 缺少必要字段：${missing.join("、")}`);
  const arrayFields = {
    referenceAnalysis: ["characters", "emotionCurve", "retentionDrivers", "uncertainties"],
    sourceScriptReconstruction: ["scenes", "coreEventSequence", "turningPoints", "uncertainties"],
    creativeBrief: ["emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents"],
    themeVariants: ["variants"],
    fullStory: ["beatSheet", "sceneScript", "keyProps", "shootingPlan", "retentionPlan", "uncertainties"],
    animationPlan: ["characterReferencePrompts", "assetPrompts", "shotPlan", "generationChecklist", "modelAgnosticNotes", "uncertainties"]
  }[contract] || [];
  const wrongArrays = arrayFields.filter((key) => !Array.isArray(value[key]));
  if (wrongArrays.length) throw new OutputContractError(`${contract} 字段类型无效：${wrongArrays.join("、")} 必须是数组`);
  if (contract === "sourceScriptReconstruction" && value.scenes.length < 1) throw new OutputContractError("sourceScriptReconstruction 至少需要一个分场");
  if (contract === "creativeBrief") {
    validateNarrativeComponents(value.allowedNarrativeComponents);
    validateProtectedExpressions(value.protectedExpressions);
  }
  if (contract === "themeVariants" && value.variants.length < 1) throw new OutputContractError("themeVariants 至少需要一个主题方案");
  if (contract === "fullStory") {
    if (value.beatSheet.length < 1) throw new OutputContractError("fullStory 至少需要一个剧情节拍");
    if (value.sceneScript.length < 1) throw new OutputContractError("fullStory 至少需要一个可拍摄分场");
  }
  if (contract === "animationPlan") {
    if (value.characterReferencePrompts.length < 1) throw new OutputContractError("animationPlan 至少需要一个角色参考提示词");
    if (value.shotPlan.length < 1) throw new OutputContractError("animationPlan 至少需要一个镜头生产任务");
  }
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

  const adaptiveDirections = JSON.stringify((value.controlledRewriteVariables || []).map((item) => item?.allowedDirections || []));
  assertNoTerms(adaptiveDirections, protectedTerms, "creativeBrief.controlledRewriteVariables.allowedDirections");
  return value;
}

export function ensureThemeVariantsMatchProfile(value, creatorProfile = {}, creativeBrief = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (!fixedName) return value;
  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const protectedTerms = collectProtectedTermsFromBrief(creativeBrief, fixedProfile);
  const protagonistLeakTerms = incompatibleProtagonistSurfaceTerms(fixedProfile);
  const visibleLeakTerms = [...protectedTerms, ...incompatibleBodySurfaceTerms(fixedProfile)];
  const mismatches = [];
  value.variants.forEach((variant, index) => {
    const label = variant?.id || `V${index + 1}`;
    const protagonist = variant?.characterSetup?.protagonist || "";
    const visibleStoryText = [
      variant?.oneLineHook,
      variant?.logline,
      ...(Array.isArray(variant?.storyOutline) ? variant.storyOutline.map((beat) => beat?.action) : []),
      variant?.endingRitual
    ].filter(Boolean).join("\n");
    if (!String(protagonist).includes(fixedName)) {
      mismatches.push(`${label} 的 protagonist 未包含「${fixedName}」`);
    } else if (!visibleStoryText.includes(fixedName)) {
      mismatches.push(`${label} 的可见故事文本未使用固定角色「${fixedName}」`);
    }
    const protagonistHits = findTerms(protagonist, [...protectedTerms, ...protagonistLeakTerms]);
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

export function ensureFullStoryMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`fullStory.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  if (!fixedName) return value;

  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const protectedTerms = collectProtectedTermsFromBrief(creativeBrief, fixedProfile);
  const protagonistLeakTerms = incompatibleProtagonistSurfaceTerms(fixedProfile);
  const visibleLeakTerms = [...protectedTerms, ...incompatibleBodySurfaceTerms(fixedProfile)];
  const protagonist = value.characterBible?.protagonist || {};
  const protagonistText = JSON.stringify(protagonist);
  const fullText = JSON.stringify(value);
  const sceneText = JSON.stringify({
    title: value.title,
    oneLinePremise: value.oneLinePremise,
    shootingSynopsis: value.shootingSynopsis,
    beatSheet: value.beatSheet,
    sceneScript: value.sceneScript,
    keyProps: value.keyProps
  });

  const mismatches = [];
  if (!protagonistText.includes(fixedName)) {
    mismatches.push(`characterBible.protagonist 未包含固定角色「${fixedName}」`);
  }
  if (!fullText.includes(fixedName)) {
    mismatches.push(`fullStory 未使用固定角色「${fixedName}」`);
  }
  const protagonistHits = findTerms(protagonistText, [...protectedTerms, ...protagonistLeakTerms]);
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

export function ensureAnimationPlanMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`animationPlan.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  if (!fixedName) return value;

  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const protectedTerms = collectProtectedTermsFromBrief(creativeBrief, fixedProfile);
  const protagonistLeakTerms = incompatibleProtagonistSurfaceTerms(fixedProfile);
  const visibleLeakTerms = [...protectedTerms, ...incompatibleBodySurfaceTerms(fixedProfile)];
  const referenceText = JSON.stringify((value.characterReferencePrompts || []).map((item) => ({
    characterName: item?.characterName,
    storyRole: item?.storyRole,
    identity: item?.identity,
    appearancePrompt: item?.appearancePrompt,
    consistencyTags: item?.consistencyTags
  })));
  const fullText = JSON.stringify(value);
  const positivePromptText = JSON.stringify({
    title: value.title,
    visualBible: {
      overallStyle: value.visualBible?.overallStyle,
      animationStyle: value.visualBible?.animationStyle,
      colorPalette: value.visualBible?.colorPalette,
      lighting: value.visualBible?.lighting,
      worldRules: value.visualBible?.worldRules,
      cameraLanguage: value.visualBible?.cameraLanguage,
      characterConsistencyRules: value.visualBible?.characterConsistencyRules
    },
    characterReferencePrompts: (value.characterReferencePrompts || []).map((item) => ({
      characterName: item?.characterName,
      storyRole: item?.storyRole,
      identity: item?.identity,
      appearancePrompt: item?.appearancePrompt,
      consistencyTags: item?.consistencyTags
    })),
    assetPrompts: (value.assetPrompts || []).map((item) => ({
      assetName: item?.assetName,
      storyFunction: item?.storyFunction,
      imagePrompt: item?.imagePrompt,
      consistencyTags: item?.consistencyTags
    })),
    shotPlan: (value.shotPlan || []).map((shot) => ({
      shotId: shot?.shotId,
      storyPurpose: shot?.storyPurpose,
      emotionalTarget: shot?.emotionalTarget,
      startFramePrompt: shot?.startFramePrompt,
      endFramePrompt: shot?.endFramePrompt,
      videoPrompt: shot?.videoPrompt,
      cameraMotion: shot?.cameraMotion,
      characterAction: shot?.characterAction,
      continuityNotes: shot?.continuityNotes
    }))
  });

  const mismatches = [];
  if (!referenceText.includes(fixedName)) {
    mismatches.push(`characterReferencePrompts 未包含固定角色「${fixedName}」`);
  }
  if (!fullText.includes(fixedName)) {
    mismatches.push(`animationPlan 未使用固定角色「${fixedName}」`);
  }
  const referenceHits = findTerms(referenceText, [...protectedTerms, ...protagonistLeakTerms]);
  if (referenceHits.length) {
    mismatches.push(`角色参考提示词混入原片表面身份或非用户设定身份：${referenceHits.join("、")}`);
  }
  const positiveHits = findTerms(positivePromptText, visibleLeakTerms);
  if (positiveHits.length) {
    mismatches.push(`正向画面提示词复用了禁止表面表达：${positiveHits.join("、")}`);
  }
  if (mismatches.length) throw new OutputContractError(`animationPlan 未锁定固定角色：${mismatches.join("；")}`);
  return value;
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

const protagonistSurfaceTerms = [
  "一只", "企鹅", "企鹅服", "企鹅形象", "动物", "动物形象", "动物服", "玩偶", "玩偶服",
  "人偶", "人偶服", "兽装", "头套", "尾巴", "翅膀", "爪子", "鸟喙", "羽毛", "脚蹼", "蹼", "鳍"
];

const bodySurfaceTerms = ["尾巴", "翅膀", "爪子", "鸟喙", "羽毛", "脚蹼", "蹼", "鳍"];

const protectedTermStopWords = new Set([
  "台词", "视觉元素", "特定动作", "禁止", "直接使用", "高度相似", "表述", "形象", "服装", "动作", "约定"
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

function collectProtectedTermsFromBrief(brief, fixedProfile = "") {
  if (!brief || typeof brief !== "object") return [];
  const terms = new Set();
  for (const item of brief.protectedExpressions || []) {
    const text = [item?.sourceExpression, item?.prohibition].filter(Boolean).join(" ");
    addProtectedTerm(terms, item?.sourceExpression, fixedProfile);
    for (const quoted of text.matchAll(/[“"「『']([^”"」』']{1,30})[”"」』']/gu)) {
      addProtectedTerm(terms, quoted[1], fixedProfile);
    }
    for (const surface of protagonistSurfaceTerms) {
      if (surface.length >= 2 && text.includes(surface)) addProtectedTerm(terms, surface, fixedProfile);
    }
  }
  return [...terms];
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
  return protagonistSurfaceTerms.filter((term) => term.length >= 2 && !fixedProfile.includes(term));
}

function incompatibleBodySurfaceTerms(fixedProfile) {
  return bodySurfaceTerms.filter((term) => !fixedProfile.includes(term));
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
