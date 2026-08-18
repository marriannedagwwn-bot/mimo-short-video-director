import {
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
  artifactPartialRepairPrompt,
  createArtifactPartialRepairPlan,
  mergeArtifactPartialRepair
} from "./artifact-partial-repair.js";
import {
  OutputContractError,
  collectAnimationReferenceForbiddenTermSourcePaths
} from "./validation.js";

export const ANIMATION_FOUNDATION_PARTIAL_REPAIR_SCHEMA_VERSION =
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION;

export const ANIMATION_FOUNDATION_PARTIAL_REPAIR_ADAPTER_ID =
  "animation_foundation/fixed_character_reference/1.0";

const repairableCodes = new Set([
  "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING",
  "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM"
]);

const mutableReferenceFields = new Set([
  "storyRole",
  "identity",
  "appearancePrompt",
  "consistencyTags"
]);

const exactCharacterReferenceFields = [
  "appearancePrompt",
  "characterName",
  "consistencyTags",
  "forbiddenChanges",
  "identity",
  "storyRole"
];

const repairTextMaxBytes = 16 * 1024;
const repairTargetTextMaxBytes = 64 * 1024;
const serializedArtifactRootPattern = /(?:^|[,\{])\s*["']?(?:beatSheet|characterBible|characterReferencePrompts|promptSchemaVersion|productionStrategy|sceneReferencePrompts|sceneScript|selectedVariantId|shotPlan|visualBible)["']?\s*:/u;

/**
 * Plan one bounded repair for the unique signed fixed-character reference.
 * Returning null is a fail-closed result: callers must not fall back to
 * sending a complete Foundation, Animation Plan, or Full Story to the model.
 */
export function planAnimationFoundationPartialRepair(candidate, error, context = {}) {
  return createArtifactPartialRepairPlan({
    artifactType: "animationFoundation",
    candidate,
    diagnostics: Array.isArray(error?.details) ? error.details : [],
    adapter: createAnimationFoundationRepairAdapter(),
    context
  });
}

export function animationFoundationPartialRepairPrompt(plan) {
  return artifactPartialRepairPrompt(plan, {
    additionalRules: [
      "replacement 必须保持 currentValue 的字段集合；只能修改 modelContext.mutableFields。",
      "characterName 与其他未命中字段必须逐字保留。",
      "缺失 requiredTraits 只能通过在 consistencyTags 尾部依次追加 modelContext.missingRequiredTraitCanonicalNames 中的签发 canonicalName 修复；不得把同义词写入其他字段。",
      "没有禁止表达诊断时，appearancePrompt 必须逐字不变，consistencyTags 必须逐项等于 modelContext.expectedConsistencyTags。",
      "存在禁止表达诊断时，只能从 diagnostics 精确命中的 mutableFields 中删除命中表达；缺失 requiredTraits 仍只能追加到 consistencyTags。",
      "不得新增、删除或改名角色，不得改变剧情职责，不得把固定角色边界套到配角。",
      "不得返回完整 Animation Foundation、Animation Plan 或 Full Story。"
    ]
  });
}

/**
 * Merge through the generic engine. The workflow supplies its existing full
 * Foundation validator through validateMerged so this adapter does not create
 * a second Foundation contract or source of truth.
 */
export function mergeAnimationFoundationPartialRepair(
  candidate,
  envelope,
  plan,
  { context = {}, validateMerged } = {}
) {
  if (typeof validateMerged !== "function") {
    throw new TypeError("Animation Foundation 局部修复必须提供完整只读 validator");
  }
  return mergeArtifactPartialRepair({
    candidate,
    envelope,
    plan,
    context,
    validateMerged: ({ candidate: merged, context: currentContext }) => (
      validateMerged(merged, currentContext)
    )
  });
}

function createAnimationFoundationRepairAdapter({ validateMerged = () => true } = {}) {
  return {
    id: ANIMATION_FOUNDATION_PARTIAL_REPAIR_ADAPTER_ID,
    maxTargets: 1,

    selectTargets({ candidate, diagnostics, context, helpers }) {
      if (!Array.isArray(candidate.characterReferencePrompts)) return null;
      const boundary = context.visualGuardrails?.fixedCharacterBoundary;
      if (!isSignedFixedCharacterBoundary(boundary)) return null;
      const fixedName = normalizeText(boundary.characterName);
      const referenceIndexes = candidate.characterReferencePrompts
        .map((reference, index) => (
          normalizeText(reference?.characterName) === fixedName ? index : -1
        ))
        .filter((index) => index >= 0);
      if (referenceIndexes.length !== 1) return null;

      const referenceIndex = referenceIndexes[0];
      const targetPath = `/characterReferencePrompts/${referenceIndex}`;
      const located = helpers.readPointer(candidate, targetPath);
      if (!located.found || !isRepairableCharacterReference(located.value)) return null;
      const currentPositiveText = positiveReferenceText(located.value);
      const actualMissingRequiredTraits = new Set(
        (boundary.requiredTraits || [])
          .filter((trait) => !Array.isArray(trait?.terms)
            || !trait.terms.some((term) => (
              normalizeText(term) && currentPositiveText.includes(normalizeText(term))
            )))
          .map((trait) => normalizeText(trait?.canonicalName))
          .filter(Boolean)
      );

      const mutableFields = new Set();
      const missingTraitNames = new Set();
      const forbiddenTerms = new Set();
      const authoritySourcePaths = new Set();
      const trustedDiagnostics = [];
      for (const detail of diagnostics) {
        const code = normalizeText(detail?.code);
        if (!repairableCodes.has(code)) return null;
        if (!diagnosticUsesCurrentBoundary(detail, boundary)) return null;

        let pointer;
        try {
          pointer = helpers.canonicalPointer(detail?.jsonPointer);
        } catch {
          return null;
        }
        if (detail?.path && animationFoundationPathToPointer(detail.path) !== pointer) return null;
        if (normalizeText(detail?.authority?.characterName) !== fixedName) return null;
        const sourcePaths = Array.isArray(detail?.authority?.sourcePaths)
          ? detail.authority.sourcePaths.map(normalizeText).filter(Boolean)
          : [];
        if (!sourcePaths.length) return null;
        sourcePaths.forEach((sourcePath) => authoritySourcePaths.add(sourcePath));
        if (!pointerBelongsToRoot(pointer, targetPath)) return null;

        if (code === "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING") {
          if (pointer !== targetPath) return null;
          if (!sameStringSet(sourcePaths, [
            "visualGuardrails.fixedCharacterBoundary.requiredTraits"
          ])) return null;
          const names = Array.isArray(detail.missingRequiredTraits)
            ? detail.missingRequiredTraits.map(normalizeText).filter(Boolean)
            : [];
          if (!names.length || names.some((name) => !boundary.requiredTraits.some(
            (trait) => normalizeText(trait?.canonicalName) === name
          )) || !sameStringSet(names, [...actualMissingRequiredTraits])) return null;
          names.forEach((name) => missingTraitNames.add(name));
          if (!Object.prototype.hasOwnProperty.call(located.value, "consistencyTags")
            || !Array.isArray(located.value.consistencyTags)) return null;
          mutableFields.add("consistencyTags");
        } else {
          const targetTokens = pointerTokens(targetPath);
          const relativeTokens = pointerTokens(pointer).slice(targetTokens.length);
          const field = relativeTokens[0];
          const term = normalizeText(detail.matchedTerm);
          if (!field || !mutableReferenceFields.has(field) || !term) return null;
          const expectedSourcePaths = collectAnimationReferenceForbiddenTermSourcePaths(
            term,
            context.creativeBrief,
            context.creatorProfile?.fixedCharacter,
            context.visualGuardrails
          );
          if (!expectedSourcePaths.length
            || !sameStringSet(sourcePaths, expectedSourcePaths)) return null;
          const hit = helpers.readPointer(candidate, pointer);
          if (!hit.found || !JSON.stringify(hit.value).includes(term)) return null;
          mutableFields.add(field);
          forbiddenTerms.add(term);
        }

        trustedDiagnostics.push({
          code,
          jsonPointer: pointer,
          reason: String(detail.reason || ""),
          ...(detail.matchedTerm ? { matchedTerm: String(detail.matchedTerm) } : {}),
          ...(Array.isArray(detail.missingRequiredTraits)
            ? { missingRequiredTraits: detail.missingRequiredTraits.map(String) }
            : {}),
          authority: {
            characterName: fixedName,
            boundaryDigest: String(boundary.boundaryDigest),
            sourcePaths
          }
        });
      }
      if (!mutableFields.size) return null;
      for (const field of mutableFields) {
        if (field === "consistencyTags") continue;
        if (!referenceRepairSkeleton(located.value[field], [...forbiddenTerms])) return null;
      }
      const missingRequiredTraitCanonicalNames = (boundary.requiredTraits || [])
        .map((trait) => normalizeText(trait?.canonicalName))
        .filter((name) => name && missingTraitNames.has(name));
      const missingOnly = missingRequiredTraitCanonicalNames.length > 0
        && forbiddenTerms.size === 0;

      return [{
        path: targetPath,
        targetLabel: `固定角色「${fixedName}」的角色参考对象`,
        diagnostics: trustedDiagnostics,
        mutablePointers: [...mutableFields].map((field) => `${targetPath}/${field}`),
        allowedReplacementKinds: ["object"],
        repairInstruction: missingOnly
          ? "保持 appearancePrompt 与全部既有字段逐字不变；仅在 consistencyTags 原数组尾部按给定顺序追加缺失事实的签发 canonicalName。"
          : "只从精确命中的字段删除禁止表达；缺失事实仅在 consistencyTags 尾部追加签发 canonicalName；保持姓名、未命中事实、角色数量和剧情职责不变。",
        modelContext: {
          mutableFields: [...mutableFields].sort(),
          missingRequiredTraitCanonicalNames,
          ...(missingOnly ? {
            expectedConsistencyTags: [
              ...located.value.consistencyTags,
              ...missingRequiredTraitCanonicalNames
            ]
          } : {}),
          mutationPolicy: missingOnly
            ? "append_signed_canonical_names_to_consistency_tags_only"
            : "remove_exact_forbidden_hits_and_append_signed_canonical_names_to_consistency_tags"
        },
        adapterState: {
          missingRequiredTraits: missingRequiredTraitCanonicalNames,
          forbiddenTerms: [...forbiddenTerms],
          missingOnly,
          authoritySourcePaths: [...authoritySourcePaths]
        }
      }];
    },

    buildAuthority({ context, targets }) {
      return projectFoundationRepairAuthority(context, targets);
    },

    validateAuthority({ authority, context, targets, helpers }) {
      const current = projectFoundationRepairAuthority(context, targets);
      return helpers.contentDigest(current) === helpers.contentDigest(authority);
    },

    authorizeReplacement({ target, currentValue, replacement, authority }) {
      assertReferenceReplacementAuthorized(target, currentValue, replacement, authority);
      return true;
    },

    validateMerged({ candidate, context }) {
      return validateMerged(candidate, context);
    }
  };
}

function projectFoundationRepairAuthority(context, targets) {
  const sourcePaths = new Set(targets.flatMap((target) => (
    target.adapterState?.authoritySourcePaths || []
  )));
  const authority = {
    fixedCharacterBoundary: projectSignedFixedCharacterBoundary(
      context.visualGuardrails?.fixedCharacterBoundary
    ).fixedCharacterBoundary,
    fixedCharacterProfile: String(context.creatorProfile?.fixedCharacter || ""),
    sourcePaths: [...sourcePaths].sort()
  };
  if (sourcePaths.has("creativeBrief.protectedExpressions")) {
    authority.protectedExpressions = structuredClone(
      context.creativeBrief?.protectedExpressions || []
    );
  }
  if (sourcePaths.has("creativeBrief.controlledRewriteVariables")) {
    authority.controlledRewriteVariables = structuredClone(
      context.creativeBrief?.controlledRewriteVariables || []
    );
  }
  if (sourcePaths.has("visualGuardrails.sourceSimilarityRules")) {
    authority.sourceSimilarityRules = structuredClone(
      context.visualGuardrails?.sourceSimilarityRules || []
    );
  }
  return authority;
}

function animationFoundationPathToPointer(path) {
  const source = String(path || "");
  if (!source) return "";
  const tokens = [];
  const pattern = /(?:^|\.)([^.\[\]]+)|\[(0|[1-9]\d*)\]/gu;
  let consumed = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index !== consumed) return "";
    const token = match[1] ?? match[2];
    if (["__proto__", "prototype", "constructor"].includes(token)) return "";
    tokens.push(token);
    consumed = match.index + match[0].length;
  }
  if (!tokens.length || consumed !== source.length) return "";
  return `/${tokens.map((token) => (
    String(token).replaceAll("~", "~0").replaceAll("/", "~1")
  )).join("/")}`;
}

function assertReferenceReplacementAuthorized(target, currentValue, replacement, authority) {
  if (!isRecord(replacement) || !isRecord(currentValue)) {
    throw new OutputContractError("Animation Foundation 局部修复 replacement 必须是完整角色参考对象");
  }
  const expectedKeys = Object.keys(currentValue).sort();
  const actualKeys = Object.keys(replacement).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new OutputContractError("Animation Foundation 局部修复 replacement 字段集合必须保持不变");
  }

  assertExistingReferenceFactsPreserved(target, currentValue, replacement, authority);

  // Match the authoritative validator's positive-reference scope. A legal
  // immutable negative instruction such as forbiddenChanges: ["禁止特定发色"]
  // must not be mistaken for a positive appearance leak.
  const replacementText = positiveReferenceText(replacement);
  for (const term of target.adapterState?.forbiddenTerms || []) {
    if (term && replacementText.includes(term)) {
      throw new OutputContractError(`Animation Foundation 局部修复仍包含禁止表达：${term}`);
    }
  }
  for (const trait of authority?.fixedCharacterBoundary?.requiredTraits || []) {
    const terms = Array.isArray(trait?.terms) ? trait.terms.map(normalizeText).filter(Boolean) : [];
    if (!terms.length || !terms.some((term) => replacementText.includes(term))) {
      throw new OutputContractError(
        `Animation Foundation 局部修复仍缺少固定角色必需事实：${trait?.canonicalName || "未命名事实"}`
      );
    }
  }
}

function positiveReferenceText(reference) {
  return [
    reference?.characterName,
    reference?.storyRole,
    reference?.identity,
    reference?.appearancePrompt,
    ...(Array.isArray(reference?.consistencyTags) ? reference.consistencyTags : [])
  ].map((value) => String(value || "")).join("\n");
}

function assertExistingReferenceFactsPreserved(target, currentValue, replacement, authority) {
  const mutableFields = Array.isArray(target?.modelContext?.mutableFields)
    ? target.modelContext.mutableFields
    : [];
  const forbiddenTerms = Array.isArray(target?.adapterState?.forbiddenTerms)
    ? target.adapterState.forbiddenTerms.map(normalizeText).filter(Boolean)
    : [];
  const missingRequiredTraits = new Set(
    Array.isArray(target?.adapterState?.missingRequiredTraits)
      ? target.adapterState.missingRequiredTraits.map(normalizeText).filter(Boolean)
      : []
  );
  const allowedTagAdditions = (authority?.fixedCharacterBoundary?.requiredTraits || [])
    .filter((trait) => missingRequiredTraits.has(normalizeText(trait?.canonicalName)))
    .map((trait) => trait?.canonicalName)
    .map(normalizeText)
    .filter(Boolean);
  for (const field of mutableFields) {
    const before = currentValue[field];
    const after = replacement[field];
    if (typeof before === "string") {
      if (typeof after !== "string" || !after.trim()) {
        throw new OutputContractError(
          `Animation Foundation 局部修复必须保持 ${field} 为非空字符串`
        );
      }
      const afterText = after;
      for (const fragment of preservedTextFragments(before, forbiddenTerms)) {
        if (!afterText.includes(fragment)) {
          throw new OutputContractError(
            `Animation Foundation 局部修复不得改写 ${field} 中未命中的既有事实：${fragment}`
          );
        }
      }
      const beforeSkeleton = referenceRepairSkeleton(before, forbiddenTerms);
      const afterSkeleton = referenceRepairSkeleton(afterText, []);
      if (!beforeSkeleton || !afterSkeleton || afterSkeleton !== beforeSkeleton) {
        throw new OutputContractError(
          `Animation Foundation 局部修复不得向 ${field} 新增未授权角色事实`
        );
      }
      continue;
    }
    if (Array.isArray(before)) {
      if (!Array.isArray(after)
        || after.some((item) => typeof item !== "string" || !item.trim())) {
        throw new OutputContractError(
          `Animation Foundation 局部修复必须保持 ${field} 为字符串数组`
        );
      }
    } else {
      throw new OutputContractError(
        `Animation Foundation 局部修复不支持修改 ${field} 的当前字段类型`
      );
    }
    if (field === "consistencyTags"
      && target?.adapterState?.missingOnly === true) {
      const expected = [...before, ...allowedTagAdditions];
      if (!sameOrderedPrimitiveArray(after, expected)) {
        throw new OutputContractError(
          "Animation Foundation 仅缺必需事实时只能在 consistencyTags 尾部追加签发 canonicalName"
        );
      }
      continue;
    }
    if (field !== "consistencyTags") {
      throw new OutputContractError(
        `Animation Foundation 局部修复不支持修改数组字段：${field}`
      );
    }
    assertConsistencyTagsRepair(before, after, forbiddenTerms, allowedTagAdditions);
  }
}

function sameOrderedPrimitiveArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isRepairableCharacterReference(value) {
  if (!isRecord(value)) return false;
  const actualFields = Object.keys(value).sort();
  if (!sameOrderedPrimitiveArray(actualFields, exactCharacterReferenceFields)) return false;
  if (!["characterName", "storyRole", "identity", "appearancePrompt"].every(
    (field) => typeof value[field] === "string" && value[field].trim()
  )) return false;
  if (![value.consistencyTags, value.forbiddenChanges].every((items) => (
    Array.isArray(items)
    && items.every((item) => typeof item === "string" && item.trim())
  ))) return false;
  const textValues = [
    value.characterName,
    value.storyRole,
    value.identity,
    value.appearancePrompt,
    ...value.consistencyTags,
    ...value.forbiddenChanges
  ];
  return textValues.every(isSafeRepairText)
    && textValues.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0)
      <= repairTargetTextMaxBytes;
}

function isSafeRepairText(value) {
  if (Buffer.byteLength(value, "utf8") > repairTextMaxBytes) return false;
  let current = value.trim();
  for (let depth = 0; depth < 8; depth += 1) {
    const scanValue = current.replaceAll("\\", "");
    if (serializedArtifactRootPattern.test(scanValue)) return false;
    let parsed;
    try {
      parsed = JSON.parse(current);
    } catch {
      return true;
    }
    if (parsed && typeof parsed === "object") return false;
    if (typeof parsed !== "string") return true;
    current = parsed.trim();
  }
  return false;
}

function assertConsistencyTagsRepair(before, after, forbiddenTerms, allowedTagAdditions) {
  const suffix = allowedTagAdditions.length
    ? after.slice(-allowedTagAdditions.length)
    : [];
  if (!sameOrderedPrimitiveArray(suffix, allowedTagAdditions)) {
    throw new OutputContractError(
      "Animation Foundation 缺失必需事实必须以签发 canonicalName 原样追加到 consistencyTags 尾部"
    );
  }
  const body = allowedTagAdditions.length
    ? after.slice(0, -allowedTagAdditions.length)
    : after;
  let cursor = 0;
  for (const original of before) {
    const containsForbidden = forbiddenTerms.some((term) => original.includes(term));
    if (!containsForbidden) {
      if (body[cursor] !== original) {
        throw new OutputContractError(
          `Animation Foundation 局部修复不得删除、复制或重排 consistencyTags 中未命中的既有条目：${original}`
        );
      }
      cursor += 1;
      continue;
    }
    const expectedSkeleton = referenceRepairSkeleton(original, forbiddenTerms);
    if (!expectedSkeleton) continue;
    const repaired = body[cursor];
    if (typeof repaired !== "string"
      || forbiddenTerms.some((term) => repaired.includes(term))
      || referenceRepairSkeleton(repaired, []) !== expectedSkeleton
      || preservedTextFragments(original, forbiddenTerms).some(
        (fragment) => !repaired.includes(fragment)
      )) {
      throw new OutputContractError(
        `Animation Foundation 局部修复不得改写 consistencyTags 中未命中的既有事实：${expectedSkeleton}`
      );
    }
    cursor += 1;
  }
  if (cursor !== body.length) {
    throw new OutputContractError(
      "Animation Foundation 局部修复不得向 consistencyTags 新增未授权条目"
    );
  }
}

// 剥离禁止词时必须连同紧邻的否定词一起剥掉。只删"企鹅服装"会把"无"留成孤儿，
// 于是 skeleton 要求正文保留"无、无、无"这种病句——合法的最小删除永远对不上，
// 模型无论怎么改都过不去。否定词表与 validation.js 的 isNegatedTermOccurrence 保持一致。
const REPAIR_NEGATION_PREFIX = "(?:不要|禁止|避免|不得|不能|不可|勿|严禁|不应|不允许|切勿|杜绝|无|没有|不含|不带|非)"
  + "(?:出现|使用|写入|新增|添加|加入|带有|拥有|包含|有)?";

function escapeRepairRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function referenceRepairSkeleton(value, removableTerms) {
  let normalized = String(value || "");
  // 长词优先，避免"企鹅服"先命中而在"企鹅服装"里留下残字。
  const ordered = [...removableTerms].sort((a, b) => String(b).length - String(a).length);
  for (const term of ordered) {
    if (!term) continue;
    normalized = normalized.replace(
      new RegExp(`(?:${REPAIR_NEGATION_PREFIX})?\\s*${escapeRepairRegExp(term)}`, "gu"),
      ""
    );
  }
  return normalized
    .replace(/[\s，,。；;、:：|/\\()[\]{}"“”'‘’+\-]/gu, "")
    .replace(/[且并及与和]/gu, "");
}

function preservedTextFragments(value, forbiddenTerms) {
  let fragments = [String(value || "")];
  for (const term of forbiddenTerms) {
    fragments = fragments.flatMap((fragment) => fragment.split(term));
  }
  return fragments
    .flatMap((fragment) => fragment.split(/[\s，,。；;、:：|/\\()[\]{}"“”'‘’+\-]+/gu))
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 2);
}

function projectSignedFixedCharacterBoundary(boundary) {
  if (!isRecord(boundary)) return {};
  const projectTraits = (traits) => (traits || []).map((trait) => ({
    canonicalName: String(trait?.canonicalName || ""),
    terms: Array.isArray(trait?.terms) ? trait.terms.map(String) : [],
    scope: String(trait?.scope || "")
  }));
  return {
    fixedCharacterBoundary: {
      schemaVersion: String(boundary.schemaVersion || ""),
      characterName: String(boundary.characterName || ""),
      canonicalDescription: String(boundary.canonicalDescription || ""),
      bodyForm: String(boundary.bodyForm || ""),
      requiredTraits: projectTraits(boundary.requiredTraits),
      forbiddenTraits: projectTraits(boundary.forbiddenTraits),
      sourceDigest: String(boundary.sourceDigest || ""),
      boundaryDigest: String(boundary.boundaryDigest || ""),
      boundarySignature: String(boundary.boundarySignature || "")
    }
  };
}

function isSignedFixedCharacterBoundary(boundary) {
  return Boolean(
    isRecord(boundary)
    && normalizeText(boundary.characterName)
    && Array.isArray(boundary.requiredTraits)
    && Array.isArray(boundary.forbiddenTraits)
    && ["sourceDigest", "boundaryDigest", "boundarySignature"].every(
      (field) => normalizeText(boundary[field])
    )
  );
}

function diagnosticUsesCurrentBoundary(detail, boundary) {
  const diagnosticDigest = normalizeText(detail?.authority?.boundaryDigest);
  return diagnosticDigest && diagnosticDigest === normalizeText(boundary.boundaryDigest);
}

function pointerBelongsToRoot(pointer, root) {
  return pointer === root || pointer.startsWith(`${root}/`);
}

function pointerTokens(pointer) {
  return String(pointer).slice(1).split("/").map((token) => (
    token.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
}

function normalizeText(value) {
  return String(value || "").trim();
}

function sameStringSet(left, right) {
  const leftSet = new Set((left || []).map(normalizeText).filter(Boolean));
  const rightSet = new Set((right || []).map(normalizeText).filter(Boolean));
  return leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
