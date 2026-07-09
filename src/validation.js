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
  visualGuardrails: ["fixedCharacterBoundary", "allowedPositiveTraits", "forbiddenPositiveTraits", "sourceSurfaceExpressions", "commonNegativePrompt", "stageInstructions", "rationale", "uncertainties"],
  themeVariants: ["variants"],
  fullStory: ["selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis", "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide", "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"],
  animationPlan: ["selectedVariantId", "title", "productionStrategy", "visualBible", "characterReferencePrompts", "sceneReferencePrompts", "assetPrompts", "shotPlan", "editPlan", "generationChecklist", "modelAgnosticNotes", "continuityAndSafetyCheck", "uncertainties"]
};

export function ensureOutputContract(value, contract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutputContractError(`${contract} 必须是对象`);
  const missing = (outputContracts[contract] || []).filter((key) => !(key in value));
  if (missing.length) throw new OutputContractError(`${contract} 缺少必要字段：${missing.join("、")}`);
  const arrayFields = {
    referenceAnalysis: ["characters", "emotionCurve", "retentionDrivers", "uncertainties"],
    sourceScriptReconstruction: ["scenes", "coreEventSequence", "turningPoints", "uncertainties"],
    creativeBrief: ["emotionStructure", "roleAndOccupationMapping", "reusableHighValueBeats", "controlledRewriteVariables", "protectedExpressions", "minimumTransformationRules", "allowedNarrativeComponents"],
    visualGuardrails: ["allowedPositiveTraits", "forbiddenPositiveTraits", "sourceSurfaceExpressions", "commonNegativePrompt", "uncertainties"],
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
    if (!value.stageInstructions || typeof value.stageInstructions !== "object" || Array.isArray(value.stageInstructions)) {
      throw new OutputContractError("visualGuardrails.stageInstructions 必须是对象");
    }
    if (!value.commonNegativePrompt.length) throw new OutputContractError("visualGuardrails 至少需要一条通用负面提示词");
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
  }
  return value;
}

export function ensureVisualGuardrailsMatchesProfile(value, creatorProfile = {}) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  if (!fixedName) return value;

  const boundaryText = JSON.stringify(value.fixedCharacterBoundary || {});
  const allText = JSON.stringify(value);
  const forbiddenTerms = collectVisualGuardrailForbiddenTerms(value, fixedProfile);
  const conflictTerms = collectVisualGuardrailRawForbiddenTerms(value)
    .filter((term) => isAllowedByFixedProfile(term, fixedProfile, value));

  const mismatches = [];
  if (!allText.includes(fixedName) && !boundaryText.includes(fixedName)) {
    mismatches.push(`未围绕固定角色「${fixedName}」生成外观规则`);
  }
  if (!forbiddenTerms.length) {
    mismatches.push("缺少可用于后续校验的 forbiddenPositiveTraits 或 sourceSurfaceExpressions");
  }
  if (conflictTerms.length) {
    mismatches.push(`把固定角色已明确允许的特征误列为禁止项：${[...new Set(conflictTerms)].join("、")}`);
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
  const protagonistLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const visibleLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
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
  const protagonistLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const visibleLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
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

export function ensureAnimationPlanMatchesProfile(value, creatorProfile = {}, creativeBrief = null, variant = null, visualGuardrails = null) {
  const fixedName = extractFixedCharacterName(creatorProfile.fixedCharacter);
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`animationPlan.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  if (!fixedName) return value;

  const fixedProfile = String(creatorProfile.fixedCharacter || "");
  const protagonistLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
  const visibleLeakTerms = collectForbiddenVisualTerms(creativeBrief, fixedProfile, visualGuardrails);
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
  const guardrailTerms = collectVisualGuardrailForbiddenTerms(visualGuardrails, fixedProfile);
  if (guardrailTerms.length) {
    for (const term of guardrailTerms) terms.add(term);
  } else {
    for (const term of incompatibleBodySurfaceTerms(fixedProfile)) terms.add(term);
    for (const term of incompatibleProtagonistSurfaceTerms(fixedProfile)) terms.add(term);
  }
  return [...terms].filter((term) => term && !isAllowedByFixedProfile(term, fixedProfile, visualGuardrails));
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
  for (const item of visualGuardrails?.forbiddenPositiveTraits || []) {
    for (const term of extractGuardrailTerms(item)) terms.add(term);
  }
  for (const item of visualGuardrails?.sourceSurfaceExpressions || []) {
    if (item?.mustAvoid === false) continue;
    for (const term of extractGuardrailTerms(item)) terms.add(term);
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
  (value.sceneReferencePrompts || []).forEach((item, index) => {
    pushArrayFields(fields, `sceneReferencePrompts[${index}].negativeSceneRules`, item?.negativeSceneRules);
  });
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
  const { allowedBodyTerms, forbiddenBodyTerms } = collectFixedCharacterVisualPolicy(fixedProfile);
  const hasEarOnlySignal = /[狼猫狐兔]耳|兽耳/u.test(fixedProfile);
  const allowedText = allowedBodyTerms.length ? allowedBodyTerms.join("、") : "无额外动物化身体特征";
  const forbiddenText = forbiddenBodyTerms.length ? forbiddenBodyTerms.join("、") : "无";
  const earNote = hasEarOnlySignal
    ? "耳朵类设定只代表用户写明的耳朵/发箍式耳朵；尾巴、爪子、肉垫、翅膀等必须另有明写才可使用。"
    : "任何动物化身体特征都必须由固定角色文本明写后才可使用。";
  return `允许正向使用的身体特征：${allowedText}。禁止自动新增未声明的身体特征：${forbiddenText}。${earNote}`;
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
