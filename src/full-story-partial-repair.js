import { types as utilTypes } from "node:util";
import { contentDigest } from "./production-lineage.js";
import { OutputContractError } from "./validation.js";

export const FULL_STORY_PARTIAL_REPAIR_SCHEMA_VERSION = "full_story_partial_repair/1.0";

const repairableSchemaCodes = new Set([
  "FULL_STORY_SCHEMA_REQUIRED",
  "FULL_STORY_SCHEMA_TYPE",
  "FULL_STORY_SCHEMA_EMPTY_STRING"
]);

const trustedSchemaReasons = Object.freeze({
  FULL_STORY_SCHEMA_REQUIRED: "缺少必要字段",
  FULL_STORY_SCHEMA_TYPE: "类型必须为 string",
  FULL_STORY_SCHEMA_EMPTY_STRING: "必须是非空字符串"
});

const trustedSchemaKeywords = Object.freeze({
  FULL_STORY_SCHEMA_REQUIRED: "required",
  FULL_STORY_SCHEMA_TYPE: "type",
  FULL_STORY_SCHEMA_EMPTY_STRING: "pattern"
});

// Scene Contract errors are intentionally excluded from the first bounded
// repair profile. For example, a missing visible character can be "fixed" by
// adding the character or by erasing the action/dialogue that mentions them;
// the diagnostic alone cannot prove which side is authoritative.
const repairableSceneCodes = new Set();

const issuedFullStoryRepairPlans = new WeakSet();

const objectRootFields = new Set([
  "dialogueStyleGuide",
  "experienceFidelity",
  "transformationProof",
  "continuityAndSafetyCheck"
]);

const itemRootFields = new Set([
  "beatSheet",
  "sceneScript",
  "keyProps",
  "shootingPlan",
  "retentionPlan",
  "uncertainties"
]);

const rootInstructions = Object.freeze({
  "/characterBible/protagonist": "只允许 name、identity、traits、speechRules、signatureBehaviors。人物行为正文必须放入 signatureBehaviors 数组，绝不能作为 JSON 属性名；保留其余合法角色事实。",
  "/characterBible/careRecipient": "只允许 nameOrLabel、identity、explicitNeed、implicitNeed、relationshipToProtagonist；正文只能作为这些字段的值，不能作为属性名。",
  beatSheet: "只允许 beat、timeRange、storyAction、emotion、dramaticFunction、retainedValueFromBrief。剧情动作放 storyAction，情绪放 emotion，剧作作用放 dramaticFunction，保留的 Brief 价值放 retainedValueFromBrief；正文绝不能作为 JSON 属性名。",
  sceneScript: "只允许 sceneId、timeRange、location、characters、visibleAction、dialogue、shotAndSound、emotionNode、dramaticFunction、shootingNotes。画面动作放 visibleAction，声画建议放 shotAndSound，拍摄注意事项放 shootingNotes；正文绝不能作为 JSON 属性名。",
  keyProps: "只允许 prop、storyFunction、visualUse、avoidSimilarityNote；正文只能作为字段值。",
  shootingPlan: "只允许 unit、setup、mustCapture、practicalNote；正文只能作为字段值。",
  retentionPlan: "只允许 moment、viewerQuestion、payoff、approxTime；正文只能作为字段值。",
  uncertainties: "只允许 field、reason、safeFallback；正文只能作为字段值。",
  dialogueStyleGuide: "只允许 overallTone、protagonistSpeechRule、supportingCharactersSpeechRule、forbiddenDialoguePatterns。",
  experienceFidelity: "只允许 positioning、audience、emotion、plotDriver、highValueBeats。",
  transformationProof: "只允许 changedCharacters、changedTask、changedDetailsAndProps、changedDialogue、changedVisualExpression。",
  continuityAndSafetyCheck: "只允许 fixedCharacterLocked、verticalFit、sourceSurfaceAvoided、protectedExpressionsAvoided、shootableWithinConstraints。"
});

export function planFullStoryPartialRepair(candidate, error, context = {}) {
  if (!isRecord(candidate)) return null;
  const details = trustedOutputContractDetails(error);
  if (!details) return null;
  const diagnostics = normalizeTrustedDiagnostics(details);
  if (!diagnostics) return null;
  const roots = [];
  for (const detail of diagnostics) {
    const pointer = detail.pointer;
    if (!pointer) return null;
    const root = repairRootForPointer(pointer, candidate);
    if (!root || !readPointer(candidate, root).found) return null;
    if (!roots.includes(root)) roots.push(root);
  }
  if (!roots.length || roots.length > 12) return null;
  roots.sort(compareRepairRoots);
  const targetDrafts = roots.map((path) => buildRepairTarget(candidate, diagnostics, path, context));
  if (targetDrafts.some((target) => !target)) return null;
  const authority = buildRepairAuthority(candidate, context, roots);
  const authorityContextDigest = contentDigest(projectRepairAuthorityContext(context));
  const plan = deepFreeze({
    schemaVersion: FULL_STORY_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: contentDigest(candidate),
    targets: targetDrafts.map((target, index) => ({
      repairId: `R${index + 1}`,
      ...target
    })),
    authority,
    authorityContextDigest,
    authorityDigest: contentDigest({ authority, authorityContextDigest })
  });
  issuedFullStoryRepairPlans.add(plan);
  return plan;
}

export function fullStoryPartialRepairPrompt(plan) {
  assertIssuedFullStoryRepairPlan(plan);
  if (!plan?.targets?.length) throw new TypeError("Full Story 局部修复计划不能为空");
  const targets = plan.targets.map((target) => ({
    repairId: target.repairId,
    path: target.path,
    currentValue: target.currentValue,
    diagnostics: target.diagnostics,
    mutableFields: target.mutableFields,
    expectedFields: target.expectedFields,
    relocationSources: target.relocationSources,
    repairInstruction: target.instruction
  }));
  return `你现在只执行 Legacy Full Story 的局部子树结构修复。

FULL_STORY_SUBTREE_REPAIR_V1

服务端已冻结原候选；你看不到也不得重写完整 Full Story。只修复下方列出的对象，保留各对象内仍然合法的剧情事实。

权威约束（只读）：
${JSON.stringify(plan.authority)}

待修子树：
${JSON.stringify(targets)}

只返回以下精确 JSON 协议：
{
  "schemaVersion":"${FULL_STORY_PARTIAL_REPAIR_SCHEMA_VERSION}",
  "baseDigest":"${plan.baseDigest}",
  "repairs":[
    {"repairId":"R1","replacement":{}}
  ]
}

要求：
- repairs 必须与待修子树数量和顺序完全一致，每个 repairId 恰好出现一次；不得返回 path、op、reason 或任何额外字段。
- replacement 必须是该 repairId 对应 path 的完整合法替换值，不是 patch，不得省略该对象的必要字段。
- 只能改正 mutableFields 指定的字段；expectedFields 的值必须逐字复制签发权威，replacement 内其余已有合法字段必须逐字保留。
- relocationSources 如非空，其中每段正文都必须逐字保留到唯一 mutableFields 字段；当前安全 Profile 不允许凭正文语义猜测目标字段。
- 不得新增剧情、角色、场次或节拍；不得改变权威角色名称、selectedVariantId 或未授权子树。
- 只输出一个 JSON 对象，不要 Markdown，不要解释。`;
}

export function mergeFullStoryPartialRepair(candidate, envelope, plan, context = null) {
  assertIssuedFullStoryRepairPlan(plan);
  assertExactKeys(envelope, ["schemaVersion", "baseDigest", "repairs"], "fullStoryPartialRepair");
  if (envelope.schemaVersion !== FULL_STORY_PARTIAL_REPAIR_SCHEMA_VERSION) {
    throw new OutputContractError("Full Story 局部修复 schemaVersion 无效");
  }
  if (envelope.baseDigest !== plan.baseDigest || contentDigest(candidate) !== plan.baseDigest) {
    throw new OutputContractError("Full Story 局部修复 baseDigest 与冻结候选不一致");
  }
  if (!isRecord(context)) {
    throw new OutputContractError("Full Story 局部修复缺少当前权威上下文");
  }
  const currentAuthority = buildRepairAuthority(
    candidate,
    context,
    plan.targets.map((target) => target.path)
  );
  const currentAuthorityContextDigest = contentDigest(projectRepairAuthorityContext(context));
  if (contentDigest({
    authority: plan.authority,
    authorityContextDigest: plan.authorityContextDigest
  }) !== plan.authorityDigest
    || contentDigest(currentAuthority) !== contentDigest(plan.authority)
    || currentAuthorityContextDigest !== plan.authorityContextDigest) {
    throw new OutputContractError("Full Story 局部修复权威上下文已经失效");
  }
  if (!Array.isArray(envelope.repairs) || envelope.repairs.length !== plan.targets.length) {
    throw new OutputContractError(`Full Story 局部修复必须返回 ${plan.targets.length} 个 repairs`);
  }
  const merged = structuredClone(candidate);
  envelope.repairs.forEach((repair, index) => {
    assertExactKeys(repair, ["repairId", "replacement"], `fullStoryPartialRepair.repairs[${index}]`);
    const target = plan.targets[index];
    if (repair.repairId !== target.repairId) {
      throw new OutputContractError(`Full Story 局部修复 repairs[${index}].repairId 必须等于 ${target.repairId}`);
    }
    assertTargetMutationAuthorized(target, repair.replacement);
    replacePointer(merged, target.path, structuredClone(repair.replacement));
  });
  assertOutsideTargetsUnchanged(candidate, merged, plan.targets.map((target) => target.path));
  return merged;
}

function normalizeTrustedDiagnostic(detail) {
  if (!isPlainDataRecord(detail)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(detail);
  const allowedFields = new Set(["code", "path", "reason", "keyword", "jsonPointer"]);
  for (const field of Reflect.ownKeys(descriptors)) {
    if (typeof field !== "string" || !allowedFields.has(field)) return null;
    const descriptor = descriptors[field];
    if (!("value" in descriptor) || !descriptor.enumerable) return null;
  }
  const requiredValues = {};
  for (const field of ["code", "path", "reason", "keyword"]) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    requiredValues[field] = descriptor.value;
  }
  const jsonPointerDescriptor = descriptors.jsonPointer;
  if (jsonPointerDescriptor
    && (!("value" in jsonPointerDescriptor) || typeof jsonPointerDescriptor.value !== "string")) {
    return null;
  }
  const code = requiredValues.code;
  const reason = requiredValues.reason;
  if (!reason) return null;
  let pointer = "";
  if (repairableSchemaCodes.has(code)) {
    if (requiredValues.keyword !== trustedSchemaKeywords[code]
      || reason !== trustedSchemaReasons[code]) return null;
    const pathPointer = canonicalPointer(requiredValues.path);
    if (!pathPointer || pathPointer !== requiredValues.path) return null;
    if (jsonPointerDescriptor) {
      const jsonPointer = canonicalPointer(jsonPointerDescriptor.value);
      if (!jsonPointer
        || jsonPointer !== jsonPointerDescriptor.value
        || jsonPointer !== pathPointer) return null;
    }
    pointer = pathPointer;
  } else if (repairableSceneCodes.has(code)) {
    if (!jsonPointerDescriptor) return null;
    pointer = canonicalPointer(jsonPointerDescriptor.value);
  } else {
    return null;
  }
  if (!pointer) return null;
  return Object.freeze({ code, pointer, reason });
}

function normalizeTrustedDiagnostics(details) {
  if (!Array.isArray(details)
    || utilTypes.isProxy(details)
    || Object.getPrototypeOf(details) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(details);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 1) return null;
  const length = lengthDescriptor.value;
  if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const diagnostics = [];
  const seen = new Set();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    const diagnostic = normalizeTrustedDiagnostic(descriptor.value);
    if (!diagnostic) return null;
    const key = `${diagnostic.code}\u0000${diagnostic.pointer}\u0000${diagnostic.reason}`;
    if (seen.has(key)) return null;
    seen.add(key);
    diagnostics.push(diagnostic);
  }
  return Object.freeze(diagnostics);
}

function trustedOutputContractDetails(error) {
  if (!error || utilTypes.isProxy(error) || !(error instanceof OutputContractError)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "details");
  if (!descriptor || !("value" in descriptor)) return null;
  return descriptor.value;
}

function repairRootForPointer(pointer, candidate) {
  const tokens = pointerTokens(pointer);
  if (!tokens.length) return "";
  const [first, second] = tokens;
  if (first === "characterBible" && ["protagonist", "careRecipient"].includes(second)) {
    return pointerFromTokens(tokens.slice(0, 2));
  }
  if (first === "characterBible" && second === "helpers" && isArrayIndex(tokens[2])) {
    return pointerFromTokens(tokens.slice(0, 3));
  }
  if (itemRootFields.has(first) && isArrayIndex(second)) {
    return pointerFromTokens(tokens.slice(0, 2));
  }
  if (objectRootFields.has(first)) return pointerFromTokens([first]);
  return "";
}

function buildRepairTarget(candidate, details, path, context) {
  const current = readPointer(candidate, path).value;
  const targetDetails = details.filter((detail) => (
    pointerBelongsToRoot(detail.pointer, path)
  ));
  const mutation = deriveTargetMutation(path, current, targetDetails, context);
  if (!mutation) return null;
  return {
    path,
    currentValue: structuredClone(current),
    diagnostics: Object.freeze(targetDetails.map((detail) => Object.freeze({
      code: detail.code,
      path: detail.pointer,
      reason: detail.reason
    }))),
    mutableFields: Object.freeze(mutation.mutableFields),
    removableFields: Object.freeze(mutation.removableFields),
    directFields: Object.freeze(mutation.directFields),
    expectedFields: deepFreeze(mutation.expectedFields),
    relocationSources: Object.freeze(mutation.relocationSources),
    instruction: repairInstruction(path)
  };
}

function deriveTargetMutation(path, current, details, context) {
  if (!details.length || !isRecord(current) || path !== "/characterBible/protagonist") return null;
  const fixedCharacterBoundary = context.visualGuardrails?.fixedCharacterBoundary;
  const fixedCharacterName = String(fixedCharacterBoundary?.characterName || "").trim();
  if (!fixedCharacterName || !String(fixedCharacterBoundary?.boundaryDigest || "").trim()) return null;
  const rootTokens = pointerTokens(path);
  for (const detail of details) {
    const pointer = detail.pointer;
    const relative = pointerTokens(pointer).slice(rootTokens.length);
    const code = detail.code;
    if (relative.length !== 1 || relative[0] !== "name") return null;
    const hasName = Object.prototype.hasOwnProperty.call(current, "name");
    if (code === "FULL_STORY_SCHEMA_REQUIRED" && hasName) return null;
    if (code === "FULL_STORY_SCHEMA_TYPE" && (!hasName || typeof current.name === "string")) return null;
    if (code === "FULL_STORY_SCHEMA_EMPTY_STRING"
      && (!hasName || typeof current.name !== "string" || current.name.trim())) return null;
  }
  return {
    mutableFields: ["name"],
    removableFields: [],
    directFields: ["name"],
    expectedFields: { name: fixedCharacterName },
    relocationSources: []
  };
}

function buildRepairAuthority(candidate, context, targetPaths) {
  const fixedCharacterName = String(
    context.visualGuardrails?.fixedCharacterBoundary?.characterName || ""
  ).trim();
  void targetPaths;
  const names = [
    fixedCharacterName,
    candidate.characterBible?.protagonist?.name,
    candidate.characterBible?.careRecipient?.nameOrLabel
  ];
  if (Array.isArray(candidate.characterBible?.helpers)) {
    candidate.characterBible.helpers.forEach((helper) => {
      names.push(helper?.nameOrLabel);
    });
  }
  return Object.freeze({
    selectedVariantId: String(context.variant?.id || candidate.selectedVariantId || ""),
    fixedCharacterName,
    standardCharacterNames: Object.freeze(uniqueStrings(names)),
    variantFacts: deepFreeze(projectVariantFacts(context.variant)),
    sceneIds: Object.freeze(Array.isArray(candidate.sceneScript)
      ? candidate.sceneScript.map((scene) => String(scene?.sceneId || ""))
      : [])
  });
}

function assertTargetMutationAuthorized(target, replacement) {
  if (!isRecord(replacement) || !isRecord(target.currentValue)) {
    throw new OutputContractError(`Full Story 局部修复 ${target.repairId} replacement 必须是完整对象`);
  }
  const mutable = new Set(target.mutableFields);
  const removable = new Set(target.removableFields);
  const direct = new Set(target.directFields);
  const expected = new Map(Object.entries(target.expectedFields || {}));
  const relocationContents = target.relocationSources.map((source) => source.content);
  for (const [key, value] of Object.entries(target.currentValue)) {
    if (mutable.has(key) || removable.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(replacement, key)
      || contentDigest(replacement[key]) !== contentDigest(value)) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 越权改变未命中字段 ${key}`
      );
    }
  }
  for (const key of removable) {
    if (Object.prototype.hasOwnProperty.call(replacement, key)) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 必须删除诊断命中的非法字段 ${key}`
      );
    }
  }
  for (const key of Object.keys(replacement)) {
    if (Object.prototype.hasOwnProperty.call(target.currentValue, key)) continue;
    if (!mutable.has(key)) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 越权新增未授权字段 ${key}`
      );
    }
  }
  for (const [field, expectedValue] of expected) {
    if (!Object.prototype.hasOwnProperty.call(replacement, field)
      || contentDigest(replacement[field]) !== contentDigest(expectedValue)) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 的 ${field} 必须逐字等于签发权威值`
      );
    }
  }
  const mutableText = target.mutableFields
    .filter((field) => Object.prototype.hasOwnProperty.call(replacement, field))
    .map((field) => JSON.stringify(replacement[field]))
    .join("\n");
  for (const content of relocationContents) {
    if (!mutableText.includes(content)) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 丢失非法字段承载的正文：${content}`
      );
    }
  }
  const relocationChangedFields = [];
  for (const field of target.mutableFields) {
    if (!Object.prototype.hasOwnProperty.call(replacement, field)) continue;
    if (expected.has(field)) continue;
    const existed = Object.prototype.hasOwnProperty.call(target.currentValue, field);
    if (existed && contentDigest(target.currentValue[field]) === contentDigest(replacement[field])) continue;
    if (existed && !preservesExistingContent(target.currentValue[field], replacement[field])) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 迁移正文时改写了 ${field} 的原有合法内容`
      );
    }
    const changedText = JSON.stringify(replacement[field]);
    if (!relocationContents.some((content) => changedText.includes(content))) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 越权改变与非法正文无关的字段 ${field}`
      );
    }
    relocationChangedFields.push({ field, text: changedText });
  }
  for (const field of direct) {
    if (expected.has(field)) continue;
    const destination = relocationChangedFields.find((entry) => entry.field === field);
    if (!destination) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 缺失字段 ${field} 必须由诊断命中的正文填充`
      );
    }
  }
  for (const content of relocationContents) {
    const changedDestinations = relocationChangedFields.filter(({ text }) => text.includes(content));
    if (changedDestinations.length !== 1) {
      throw new OutputContractError(
        `Full Story 局部修复 ${target.repairId} 必须把每段非法字段正文恰好迁入一个字段：${content}`
      );
    }
  }
}

function assertIssuedFullStoryRepairPlan(plan) {
  if (!isRecord(plan) || !issuedFullStoryRepairPlans.has(plan)) {
    throw new OutputContractError("Full Story 局部修复计划不是本进程签发的有效计划");
  }
}

function projectVariantFacts(variant) {
  if (!isRecord(variant)) return null;
  return {
    id: String(variant.id || ""),
    characterSetup: structuredClone(variant.characterSetup ?? null),
    newTask: structuredClone(variant.newTask ?? null),
    emotionalMedium: structuredClone(variant.emotionalMedium ?? null),
    environmentPressure: structuredClone(variant.environmentPressure ?? null),
    endingRitual: structuredClone(variant.endingRitual ?? null)
  };
}

function projectRepairAuthorityContext(context) {
  return {
    creatorProfile: structuredClone(context.creatorProfile ?? null),
    creativeBrief: structuredClone(context.creativeBrief ?? null),
    variant: structuredClone(context.variant ?? null),
    fixedCharacterBoundary: structuredClone(
      context.visualGuardrails?.fixedCharacterBoundary ?? null
    )
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function preservesExistingContent(previous, next) {
  if (typeof previous === "string") return !previous || (typeof next === "string" && next.includes(previous));
  if (Array.isArray(previous)) {
    if (!Array.isArray(next)) return false;
    let cursor = 0;
    for (const item of next) {
      if (cursor < previous.length && contentDigest(item) === contentDigest(previous[cursor])) cursor += 1;
    }
    return cursor === previous.length;
  }
  return contentDigest(previous) === contentDigest(next);
}

function repairInstruction(path) {
  if (path === "/characterBible/protagonist") {
    return "只补齐或纠正 name；name 必须逐字等于 expectedFields.name，identity、traits、speechRules 与 signatureBehaviors 必须保持不变。";
  }
  if (rootInstructions[path]) return rootInstructions[path];
  if (/^\/characterBible\/helpers\/\d+$/u.test(path)) {
    return "只允许 nameOrLabel、functionInStory、relationshipToProtagonist、helpingAction；正文只能作为字段值，不能作为属性名。";
  }
  const first = pointerTokens(path)[0];
  return rootInstructions[first] || "只返回当前路径要求的完整合法值；正文不得作为属性名。";
}

function compareRepairRoots(left, right) {
  const leftTokens = pointerTokens(left);
  const rightTokens = pointerTokens(right);
  const topOrder = [
    "selectedVariantId", "title", "oneLinePremise", "targetDurationSeconds", "shootingSynopsis",
    "characterBible", "beatSheet", "sceneScript", "keyProps", "shootingPlan", "dialogueStyleGuide",
    "retentionPlan", "experienceFidelity", "transformationProof", "continuityAndSafetyCheck", "uncertainties"
  ];
  const order = topOrder.indexOf(leftTokens[0]) - topOrder.indexOf(rightTokens[0]);
  if (order) return order;
  const maximum = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 1; index < maximum; index += 1) {
    const leftToken = leftTokens[index] ?? "";
    const rightToken = rightTokens[index] ?? "";
    if (isArrayIndex(leftToken) && isArrayIndex(rightToken)) {
      const numeric = Number(leftToken) - Number(rightToken);
      if (numeric) return numeric;
    } else {
      const lexical = leftToken.localeCompare(rightToken, "en");
      if (lexical) return lexical;
    }
  }
  return 0;
}

function pointerBelongsToRoot(pointer, root) {
  return pointer === root || pointer.startsWith(`${root}/`);
}

function canonicalPointer(value) {
  const pointer = String(value || "");
  if (!pointer.startsWith("/") || pointer === "/") return "";
  try {
    return pointerFromTokens(pointerTokens(pointer));
  } catch {
    return "";
  }
}

function pointerTokens(pointer) {
  if (!String(pointer).startsWith("/")) throw new TypeError("非法 JSON Pointer");
  return String(pointer).slice(1).split("/").map((token) => {
    if (/~(?![01])/u.test(token)) throw new TypeError("非法 JSON Pointer 转义");
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) {
      throw new TypeError("危险 JSON Pointer token");
    }
    return decoded;
  });
}

function pointerFromTokens(tokens) {
  return `/${tokens.map((token) => String(token).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function readPointer(root, pointer) {
  let current = root;
  for (const token of pointerTokens(pointer)) {
    if (!isRecord(current) && !Array.isArray(current)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false, value: undefined };
    current = current[token];
  }
  return { found: true, value: current };
}

function replacePointer(root, pointer, replacement) {
  const tokens = pointerTokens(pointer);
  const leaf = tokens.pop();
  let parent = root;
  for (const token of tokens) {
    if (!isRecord(parent) && !Array.isArray(parent)) throw new OutputContractError("Full Story 局部修复路径不存在");
    if (!Object.prototype.hasOwnProperty.call(parent, token)) throw new OutputContractError("Full Story 局部修复路径不存在");
    parent = parent[token];
  }
  if (!Object.prototype.hasOwnProperty.call(parent, leaf)) throw new OutputContractError("Full Story 局部修复目标不存在");
  parent[leaf] = replacement;
}

function assertOutsideTargetsUnchanged(original, merged, paths) {
  const originalMasked = structuredClone(original);
  const mergedMasked = structuredClone(merged);
  for (const path of paths) {
    replacePointer(originalMasked, path, "__FULL_STORY_REPAIR_TARGET__");
    replacePointer(mergedMasked, path, "__FULL_STORY_REPAIR_TARGET__");
  }
  if (contentDigest(originalMasked) !== contentDigest(mergedMasked)) {
    throw new OutputContractError("Full Story 局部修复改变了未授权子树");
  }
}

function assertExactKeys(value, keys, path) {
  if (!isRecord(value)) throw new OutputContractError(`${path} 必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OutputContractError(`${path} 只允许字段 ${keys.join("、")}`);
  }
}

function isArrayIndex(value) {
  return /^(?:0|[1-9]\d*)$/u.test(String(value || ""));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainDataRecord(value) {
  if (!isRecord(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
