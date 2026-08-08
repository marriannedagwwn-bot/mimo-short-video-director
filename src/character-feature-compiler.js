import { createHash, randomUUID } from "node:crypto";
import { ModelResponseError } from "./mimo-client.js";
import { extractFixedCharacterName } from "./validation.js";

export const CHARACTER_FEATURE_COMPILER_VERSION = "1.0";
export const CHARACTER_FEATURE_PROFILE_VERSION = "1";
export const CHARACTER_FEATURE_DIMENSION_REGISTRY_VERSION = "1";

export const CHARACTER_FEATURE_KINDS = Object.freeze([
  "body_form",
  "limb_variant",
  "special_appendage",
  "face_part",
  "costume",
  "accessory",
  "other_anatomical"
]);

export const CHARACTER_FEATURE_EVIDENCE_LEVELS = Object.freeze([
  "explicit",
  "inferred",
  "unresolved"
]);

const FEATURE_KIND_SET = new Set(CHARACTER_FEATURE_KINDS);
const EVIDENCE_LEVEL_SET = new Set(CHARACTER_FEATURE_EVIDENCE_LEVELS);
const POSE_COMPATIBLE_KINDS = new Set(CHARACTER_FEATURE_KINDS);
const TOP_LEVEL_KEYS = Object.freeze(["characters"]);
const CHARACTER_KEYS = Object.freeze(["characterTargetId", "features"]);
const FEATURE_KEYS = Object.freeze([
  "suggestedFeatureKey",
  "canonicalName",
  "terms",
  "featureKind",
  "semanticSubtype",
  "evidenceLevel",
  "evidenceSpanIds",
  "inferenceSpanIds"
]);
const CACHED_PROFILE_KEYS = Object.freeze([
  "profileVersion",
  "compilerVersion",
  "dimensionRegistryVersion",
  "sourceHash",
  "provider",
  "model",
  "compiledAt",
  "characters",
  "conflicts",
  "profileDigest"
]);
const CACHED_CHARACTER_KEYS = Object.freeze(["characterId", "name", "features"]);
const CACHED_FEATURE_KEYS = Object.freeze([
  "featureId",
  "suggestedFeatureKey",
  "canonicalName",
  "terms",
  "matcherTerms",
  "disabledTerms",
  "featureKind",
  "semanticSubtype",
  "evidenceLevel",
  "poseCompatible",
  "evidenceCount",
  "inferenceEvidenceCount",
  "evidenceProofs",
  "inferenceEvidenceProofs"
]);
const PROFILE_CACHE_LIMIT = 32;
const SYSTEM_PROMPT = `你是 Character Feature Compiler。

你只根据服务端提供的已签发全局角色边界与配角设定，整理角色长期稳定的特殊身体特征词库。
固定主角的语义已经在 Visual Guardrails 阶段确定；你只能编译 requiredTraits 中已有的 appearance 事实，不得重新解析 fixedCharacter、重新推断或新增主角特征。
不得读取或假定 Animation Foundation，不得把服装配件升级为真实身体器官，不得描述当前镜头状态。
只能返回严格 JSON 对象，不要 Markdown、解释、原文、路径或 offset。`;
const PROFILE_PROMPT_VERSION = "character-feature-profile-v1";
const FEATURE_STATE_PATTERN = /正在|开始|继续|逐渐|随后|然后|准备|即将|将要|竖起|垂下|摆动|摇动|朝向|面向|转向|弯曲|张开|闭合|抬起|落下|停在|位于/u;
const profileCache = new Map();

export class CharacterFeatureCompilerError extends Error {
  constructor(message, {
    category = "compiler",
    errorCode = "CHARACTER_FEATURE_COMPILER_FAILED",
    metadata = null,
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CharacterFeatureCompilerError";
    this.stage = "characterFeatureCompiler";
    this.category = category;
    this.errorCode = errorCode;
    this.metadata = metadata;
    this.details = {
      stage: this.stage,
      category,
      errorCode,
      metadata
    };
  }
}

export class CharacterFeatureCompilerProtocolError extends CharacterFeatureCompilerError {
  constructor(message, {
    repairable = true,
    errorCode = "CHARACTER_FEATURE_PROTOCOL_FAILED",
    ...options
  } = {}) {
    super(message, { ...options, category: "protocol", errorCode });
    this.name = "CharacterFeatureCompilerProtocolError";
    this.repairable = repairable;
  }
}

export class CharacterFeatureCompilerTransportError extends CharacterFeatureCompilerError {
  constructor(message, {
    classification = "transport",
    errorCode = "CHARACTER_FEATURE_TRANSPORT_FAILED",
    ...options
  } = {}) {
    super(message, { ...options, category: classification, errorCode });
    this.name = "CharacterFeatureCompilerTransportError";
    this.classification = classification;
  }
}

export class CharacterFeatureCompilerConfigError extends CharacterFeatureCompilerError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      category: "config",
      errorCode: "CHARACTER_FEATURE_CONFIG_INVALID"
    });
    this.name = "CharacterFeatureCompilerConfigError";
  }
}

/**
 * Compile an authoritative character feature sidecar.
 *
 * Animation Foundation and characterReferencePrompts are deliberately absent
 * from this interface. Supplying either as extra object fields cannot affect
 * the prompt or source hash.
 */
export async function compileCharacterFeatures({
  creatorProfile,
  visualGuardrails,
  fullStory,
  temporaryCharacters = [],
  client = null,
  provider = null,
  model = "",
  maxCompletionTokens = 4096,
  timeoutMs = 300_000,
  cachedProfile = null
} = {}) {
  const authoritativeInput = projectAuthoritativeInput({
    creatorProfile,
    visualGuardrails,
    fullStory,
    temporaryCharacters
  });
  const sourceHash = computeCharacterFeatureSourceHash(authoritativeInput);
  const catalog = buildCharacterFeatureSourceCatalog(authoritativeInput);
  const metadata = createMetadata({
    provider: provider || inferProvider(client),
    model,
    sourceHash,
    catalog
  });

  const suppliedCache = validateCachedProfile(cachedProfile, {
    sourceHash,
    catalog
  });
  if (suppliedCache) {
    metadata.cacheHit = true;
    metadata.cacheSource = "provided";
    metadata.finalResult = "accepted";
    metadata.counts = featureCounts(suppliedCache);
    return { profile: freezeClone(suppliedCache), metadata: freezeClone(metadata) };
  }

  const memoryCache = validateCachedProfile(profileCache.get(sourceHash), {
    sourceHash,
    catalog
  });
  if (memoryCache) {
    touchCache(sourceHash, memoryCache);
    metadata.cacheHit = true;
    metadata.cacheSource = "memory";
    metadata.finalResult = "accepted";
    metadata.counts = featureCounts(memoryCache);
    return { profile: freezeClone(memoryCache), metadata: freezeClone(metadata) };
  }

  try {
    validateLiveConfiguration({ client, model, maxCompletionTokens, timeoutMs });
  } catch (error) {
    metadata.finalResult = "failed";
    metadata.errorCode = error.errorCode || "CHARACTER_FEATURE_CONFIG_INVALID";
    if (error instanceof CharacterFeatureCompilerError) {
      error.metadata = metadata;
      error.details = {
        stage: error.stage,
        category: error.category,
        errorCode: error.errorCode,
        metadata
      };
    }
    throw error;
  }
  const basePrompt = buildCharacterFeatureCompilerPrompt({
    authoritativeInput,
    catalog,
    sourceHash
  });
  let diagnostic = "";
  let failedResponse = null;
  let repairMode = null;

  for (let protocolAttempt = 1; protocolAttempt <= 2; protocolAttempt += 1) {
    const attemptLog = {
      protocolAttempt,
      repairMode,
      finalResult: "pending",
      errorCode: null
    };
    metadata.protocolAttempts.push(attemptLog);
    const prompt = protocolAttempt === 1
      ? basePrompt
      : buildCharacterFeatureRetryPrompt({
        basePrompt,
        diagnostic,
        repairMode,
        failedResponse
      });

    let response;
    try {
      metadata.requestCount += 1;
      response = await client.generateJson({
        prompt,
        model,
        maxCompletionTokens,
        systemPrompt: SYSTEM_PROMPT,
        requestTimeoutMs: timeoutMs,
        jsonRetryAttempts: 0,
        strictJson: true
      });
    } catch (error) {
      if (isModelJsonProtocolError(error)) {
        diagnostic = `模型返回 JSON envelope 无法解析：${String(error?.message || error)}`;
        attemptLog.finalResult = "protocol-error";
        attemptLog.errorCode = "CHARACTER_FEATURE_ENVELOPE_INVALID";
        if (protocolAttempt === 1) {
          repairMode = "envelope_repair";
          continue;
        }
        throw finalProtocolError(diagnostic, metadata, {
          errorCode: "CHARACTER_FEATURE_ENVELOPE_INVALID",
          cause: error
        });
      }
      metadata.finalResult = "failed";
      const classification = classifyTransportError(error);
      const transportError = new CharacterFeatureCompilerTransportError(
        `Character Feature Compiler ${classification} 失败：${String(error?.message || error)}`,
        { classification, metadata, cause: error }
      );
      throw transportError;
    }

    try {
      const draft = validateCharacterFeatureCompilerResponse(response, { catalog });
      const profile = compileCharacterFeatureProfile(draft, {
        catalog,
        sourceHash,
        provider: provider || inferProvider(client),
        model
      });
      metadata.finalResult = "accepted";
      attemptLog.finalResult = "accepted";
      metadata.counts = featureCounts(profile);
      metadata.conflicts = cloneJson(profile.conflicts);
      metadata.featureIdMappings = profile.characters.flatMap((character) =>
        character.features.map((feature) => ({
          characterId: character.characterId,
          suggestedFeatureKey: feature.suggestedFeatureKey,
          featureId: feature.featureId
        }))
      );
      putCache(sourceHash, profile);
      return { profile: freezeClone(profile), metadata: freezeClone(metadata) };
    } catch (error) {
      const protocolError = asProtocolError(error);
      diagnostic = protocolError.message;
      failedResponse = response;
      attemptLog.finalResult = "protocol-error";
      attemptLog.errorCode = protocolError.errorCode;
      if (protocolAttempt === 1 && protocolError.repairable) {
        repairMode = "profile_repair";
        continue;
      }
      throw finalProtocolError(diagnostic, metadata, {
        errorCode: protocolError.errorCode,
        cause: protocolError
      });
    }
  }

  throw finalProtocolError("超过 protocol attempt 预算", metadata);
}

export function buildCharacterFeatureSourceCatalog(input = {}) {
  const authoritativeInput = isProjectedAuthoritativeInput(input)
    ? input
    : projectAuthoritativeInput(input);
  const runToken = randomUUID().replace(/-/gu, "").slice(0, 12);
  const characterSeeds = collectCharacterSeeds(authoritativeInput);
  if (characterSeeds.length === 0) {
    throw new CharacterFeatureCompilerConfigError("Character Feature Compiler 未找到合法角色");
  }
  const characters = characterSeeds.map((seed, index) => ({
    characterTargetId: `character-target-${runToken}-${index}`,
    characterId: stableCharacterId(seed.name),
    name: seed.name,
    role: seed.role
  }));
  const targetByNormalizedName = new Map(
    characters.map((character) => [normalizeTerm(character.name), character])
  );
  const segments = [];
  const segmentById = new Map();
  const spanById = new Map();
  let segmentIndex = 0;
  let spanIndex = 0;

  const addSource = ({ sourceGroup, sourcePath, value, characterNames = [] }) => {
    if (typeof value !== "string" || !value.trim()) return;
    const boundCharacters = uniqueBoundCharacters({
      value,
      characterNames,
      characters,
      targetByNormalizedName
    });
    if (boundCharacters.length !== 1) return;

    const character = boundCharacters[0];
    const segmentId = `segment-${runToken}-${segmentIndex}`;
    segmentIndex += 1;
    const spans = splitSourceSpans(value).map(({ start, end, text }) => {
      const spanId = `span-${runToken}-${spanIndex}`;
      spanIndex += 1;
      const span = {
        spanId,
        segmentId,
        sourcePath,
        utf16Start: start,
        utf16End: end,
        rawText: text,
        characterTargetId: character.characterTargetId,
        characterId: character.characterId
      };
      spanById.set(spanId, span);
      return span;
    });
    if (spans.length === 0) return;
    const segment = {
      segmentId,
      sourceGroup,
      sourcePath,
      rawText: value,
      displayText: value,
      characterTargetId: character.characterTargetId,
      characterId: character.characterId,
      spanIds: spans.map((span) => span.spanId)
    };
    segmentById.set(segmentId, segment);
    segments.push(segment);
  };

  const primaryName = characters.find((character) => character.role === "protagonist")?.name
    || characters[0].name;
  const hasGlobalBoundary = authoritativeInput.visualGuardrails?.fixedCharacterBoundary?.schemaVersion === "2.0"
    && Array.isArray(authoritativeInput.visualGuardrails.fixedCharacterBoundary.requiredTraits);
  if (!hasGlobalBoundary) {
    addSource({
      sourceGroup: "fixedCharacter",
      sourcePath: "creatorProfile.fixedCharacter",
      value: authoritativeInput.creatorProfile.fixedCharacter,
      characterNames: [primaryName]
    });
  }

  collectStringLeaves(authoritativeInput.visualGuardrails, "visualGuardrails")
    .forEach(({ path, value }) => {
      addSource({
        sourceGroup: "visualGuardrails",
        sourcePath: path,
        value,
        characterNames: path.startsWith("visualGuardrails.fixedCharacterBoundary.requiredTraits")
          ? [primaryName]
          : literalCharacterNames(value, characters)
      });
    });

  collectCharacterBibleSources(authoritativeInput.fullStory.characterBible, { skipProtagonist: hasGlobalBoundary })
    .forEach((source) => addSource(source));

  authoritativeInput.temporaryCharacters.forEach((temporary, index) => {
    collectStringLeaves(temporary.setting, `temporaryCharacters[${index}].setting`)
      .forEach(({ path, value }) => addSource({
        sourceGroup: "temporaryCharacter",
        sourcePath: path,
        value,
        characterNames: [temporary.name]
      }));
  });

  return {
    runToken,
    characters,
    segments,
    segmentById,
    spanById,
    lockedAppearanceTraitsByTarget: new Map(characters.flatMap((character) => (
      character.role === "protagonist"
      && hasGlobalBoundary
        ? [[character.characterTargetId, authoritativeInput.visualGuardrails.fixedCharacterBoundary.requiredTraits.filter((trait) => trait?.scope === "appearance")]]
        : []
    )))
  };
}

export function buildCharacterFeatureCompilerPrompt({
  authoritativeInput,
  catalog,
  sourceHash = computeCharacterFeatureSourceHash(authoritativeInput)
} = {}) {
  if (!catalog || !(catalog.spanById instanceof Map)) {
    throw new CharacterFeatureCompilerConfigError("Character Feature Compiler prompt 缺少 Source Catalog");
  }
  const payload = {
    sourceHash,
    characterTargets: catalog.characters.map(({ characterTargetId, name }) => ({
      characterTargetId,
      name
    })),
    lockedCharacterBoundaries: catalog.characters.flatMap((character) => {
      const boundary = authoritativeInput.visualGuardrails?.fixedCharacterBoundary;
      if (character.role !== "protagonist" || boundary?.schemaVersion !== "2.0" || !Array.isArray(boundary.requiredTraits)) return [];
      return [{
        characterTargetId: character.characterTargetId,
        requiredAppearanceTraits: boundary.requiredTraits.filter((trait) => trait?.scope === "appearance")
      }];
    }),
    sourceCatalog: catalog.segments.map((segment) => ({
      segmentId: segment.segmentId,
      characterTargetId: segment.characterTargetId,
      displayText: segment.displayText,
      spans: segment.spanIds.map((spanId) => {
        const span = catalog.spanById.get(spanId);
        return { spanId, displayText: span.rawText };
      })
    }))
  };

  return `CHARACTER_FEATURE_COMPILER_V1

任务：
- 为每个签发角色整理长期稳定的特殊身体特征。
- 每个 characterTargetId 必须恰好返回一次；没有特殊特征时返回 features: []。
- 固定主角只允许编译 visualGuardrails.fixedCharacterBoundary.requiredTraits 中 scope=appearance 的既有事实；evidenceLevel 必须沿用边界，不得做新的语义推断。
- lockedCharacterBoundaries 中每个 requiredAppearanceTraits 必须恰好编译一次；canonicalName 和 terms 必须原样沿用，只允许为编译协议补充 suggestedFeatureKey、featureKind、semanticSubtype 和已签发 spanId。
- 配角仍按签发输入处理：explicit 只用于原文明确写出的特征；inferred 只用于能由明确物种/身份推导的特征；有歧义时使用 unresolved。
- inferred 只是词库授权：只有将来局部镜头原文字面出现冻结 term 时才能识别，绝不自动注入镜头。
- costume/accessory 不得写成真实器官；不要描述当前帧姿态、位置、方向或动作。

featureKind 仅允许：
${JSON.stringify(CHARACTER_FEATURE_KINDS)}

模型输出协议（所有对象禁止额外字段）：
{
  "characters": [{
    "characterTargetId": "服务端签发 ID",
    "features": [{
      "suggestedFeatureKey": "ASCII snake_case 建议键，不是最终 featureId",
      "canonicalName": "特征规范中文名",
      "terms": ["用于字面匹配的词"],
      "featureKind": "七种通用分类之一",
      "semanticSubtype": "简短开放说明，如 ear/tail/wing",
      "evidenceLevel": "explicit | inferred | unresolved",
      "evidenceSpanIds": ["explicit 证据的签发 spanId"],
      "inferenceSpanIds": ["inferred 推导依据的签发 spanId"]
    }]
  }]
}

证据约束：
- 只能返回下方签发的 characterTargetId 与 spanId。
- 不得返回 segmentId、sourcePath、start/end、offset、原文或改写后的证据文本。
- spanId 必须属于当前 characterTargetId。
- explicit 至少一个 evidenceSpanId；inferred 至少一个 inferenceSpanId。
- unresolved 不进入 matcher，但仍须给出至少一个证据或推导 spanId。
- suggestedFeatureKey、term 和 semanticSubtype 都不能充当证据。

服务端签发输入：
${JSON.stringify(payload)}`;
}

export function validateCharacterFeatureCompilerResponse(response, { catalog } = {}) {
  if (!isRecord(response)) {
    throw protocolError("Character Feature Compiler 响应必须是对象");
  }
  assertExactKeys(response, TOP_LEVEL_KEYS, "响应");
  if (!Array.isArray(response.characters)) {
    throw protocolError("响应.characters 必须是数组");
  }
  if (!catalog || !(catalog.spanById instanceof Map)) {
    throw new CharacterFeatureCompilerConfigError("校验响应时缺少 Source Catalog");
  }
  const expectedTargets = new Map(
    catalog.characters.map((character) => [character.characterTargetId, character])
  );
  if (response.characters.length !== expectedTargets.size) {
    throw protocolError("响应.characters 必须恰好覆盖全部签发角色");
  }
  const seenTargets = new Set();

  const characters = response.characters.map((entry, characterIndex) => {
    const path = `characters[${characterIndex}]`;
    if (!isRecord(entry)) throw protocolError(`${path} 必须是对象`);
    assertExactKeys(entry, CHARACTER_KEYS, path);
    const targetId = requireBoundedString(entry.characterTargetId, `${path}.characterTargetId`, 160);
    const character = expectedTargets.get(targetId);
    if (!character) {
      throw protocolError(`${path}.characterTargetId 不是本次签发 ID`, {
        errorCode: "CHARACTER_FEATURE_ILLEGAL_ID",
        repairable: false
      });
    }
    if (seenTargets.has(targetId)) {
      throw protocolError(`${path}.characterTargetId 重复`, {
        errorCode: "CHARACTER_FEATURE_ILLEGAL_ID",
        repairable: false
      });
    }
    seenTargets.add(targetId);
    if (!Array.isArray(entry.features) || entry.features.length > 32) {
      throw protocolError(`${path}.features 必须是最多 32 项的数组`);
    }
    const features = entry.features.map((feature, featureIndex) =>
      validateFeatureDraft(feature, {
        path: `${path}.features[${featureIndex}]`,
        character,
        catalog
      })
    );
    assertLockedBoundaryFeatureCoverage(features, catalog.lockedAppearanceTraitsByTarget?.get(targetId) || [], path);
    return { characterTargetId: targetId, features };
  });

  return { characters };
}

function assertLockedBoundaryFeatureCoverage(features, lockedTraits, path) {
  if (!lockedTraits.length) return;
  if (features.length !== lockedTraits.length) {
    throw protocolError(`${path}.features 必须逐项编译全局边界 requiredAppearanceTraits，不得遗漏或新增`);
  }
  lockedTraits.forEach((trait, index) => {
    const feature = features[index];
    const expectedTerms = uniqueTerms(trait.terms || []);
    if (
      feature.canonicalName !== trait.canonicalName
      || feature.evidenceLevel !== trait.evidenceLevel
      || JSON.stringify(uniqueTerms(feature.terms)) !== JSON.stringify(expectedTerms)
    ) {
      throw protocolError(`${path}.features[${index}] 必须原样沿用全局角色边界特征“${trait.canonicalName}”`);
    }
  });
}

export function compileCharacterFeatureProfile(draft, {
  catalog,
  sourceHash,
  provider = "unknown",
  model = ""
} = {}) {
  if (!draft || !Array.isArray(draft.characters)) {
    throw new CharacterFeatureCompilerConfigError("编译 Character Feature Profile 缺少合法 draft");
  }
  const draftByTarget = new Map(
    draft.characters.map((character) => [character.characterTargetId, character])
  );
  const conflicts = [];
  const characters = catalog.characters.map((character) => {
    const sourceFeatures = dedupeFeatureDrafts(
      draftByTarget.get(character.characterTargetId)?.features || []
    );
    const usedFeatureIds = new Set();
    const features = sourceFeatures.map((feature) => {
      const key = uniqueFeatureKey(feature, usedFeatureIds);
      const featureId = `${character.characterId}.${key}`;
      usedFeatureIds.add(featureId);
      return {
        featureId,
        suggestedFeatureKey: feature.suggestedFeatureKey,
        canonicalName: feature.canonicalName,
        terms: uniqueTerms(feature.terms),
        matcherTerms: feature.evidenceLevel === "unresolved"
          ? []
          : uniqueTerms(feature.terms),
        disabledTerms: [],
        featureKind: feature.featureKind,
        semanticSubtype: feature.semanticSubtype,
        evidenceLevel: feature.evidenceLevel,
        poseCompatible: POSE_COMPATIBLE_KINDS.has(feature.featureKind),
        evidenceCount: feature.evidenceSpanIds.length,
        inferenceEvidenceCount: feature.inferenceSpanIds.length,
        evidenceProofs: feature.evidenceSpanIds.map((spanId) =>
          signedSpanProof(catalog.spanById.get(spanId))
        ),
        inferenceEvidenceProofs: feature.inferenceSpanIds.map((spanId) =>
          signedSpanProof(catalog.spanById.get(spanId))
        )
      };
    });
    resolveTermConflicts(character.characterId, features, conflicts);
    return {
      characterId: character.characterId,
      name: character.name,
      features
    };
  });

  const profile = {
    profileVersion: CHARACTER_FEATURE_PROFILE_VERSION,
    compilerVersion: CHARACTER_FEATURE_COMPILER_VERSION,
    dimensionRegistryVersion: CHARACTER_FEATURE_DIMENSION_REGISTRY_VERSION,
    sourceHash,
    provider,
    model,
    compiledAt: new Date().toISOString(),
    characters,
    conflicts
  };
  return deepFreeze({
    ...profile,
    profileDigest: computeProfileDigest(profile)
  });
}

export function computeCharacterFeatureSourceHash(input = {}) {
  const authoritativeInput = isProjectedAuthoritativeInput(input)
    ? input
    : projectAuthoritativeInput(input);
  const hashPayload = {
    promptVersion: PROFILE_PROMPT_VERSION,
    profileVersion: CHARACTER_FEATURE_PROFILE_VERSION,
    compilerVersion: CHARACTER_FEATURE_COMPILER_VERSION,
    dimensionRegistryVersion: CHARACTER_FEATURE_DIMENSION_REGISTRY_VERSION,
    featureKinds: CHARACTER_FEATURE_KINDS,
    evidenceLevels: CHARACTER_FEATURE_EVIDENCE_LEVELS,
    authoritativeInput
  };
  return `sha256:${createHash("sha256").update(stableStringify(hashPayload)).digest("hex")}`;
}

export function clearCharacterFeatureCompilerCache() {
  profileCache.clear();
}

export function matchCharacterFeatures(profile, { characterId, text } = {}) {
  const character = Array.isArray(profile?.characters)
    ? profile.characters.find((entry) => entry?.characterId === characterId)
    : null;
  if (!character || typeof text !== "string" || !text) return Object.freeze([]);
  const normalizedText = normalizeTerm(text);
  const matches = [];
  character.features.forEach((feature) => {
    if (!feature.poseCompatible || feature.evidenceLevel === "unresolved") return;
    const matchedTerm = feature.matcherTerms.find((term) =>
      normalizedText.includes(normalizeTerm(term))
    );
    if (!matchedTerm) return;
    matches.push({
      characterId,
      featureId: feature.featureId,
      matchedTerm,
      dimensionKey: characterFeatureDimensionKey(feature)
    });
  });
  return freezeClone(matches);
}

export function characterFeatureDimensionKey(feature) {
  if (!isRecord(feature) || !feature.poseCompatible || typeof feature.featureId !== "string") {
    return null;
  }
  return `characterFeature:${feature.featureId}`;
}

function validateFeatureDraft(feature, { path, character, catalog }) {
  if (!isRecord(feature)) throw protocolError(`${path} 必须是对象`);
  assertExactKeys(feature, FEATURE_KEYS, path);
  const suggestedFeatureKey = requireBoundedString(
    feature.suggestedFeatureKey,
    `${path}.suggestedFeatureKey`,
    64
  );
  if (!/^[a-z][a-z0-9_]*$/u.test(suggestedFeatureKey)) {
    throw protocolError(`${path}.suggestedFeatureKey 必须是 ASCII snake_case`);
  }
  const canonicalName = requireBoundedString(feature.canonicalName, `${path}.canonicalName`, 80);
  const semanticSubtype = requireBoundedString(feature.semanticSubtype, `${path}.semanticSubtype`, 48);
  if (FEATURE_STATE_PATTERN.test(canonicalName) || FEATURE_STATE_PATTERN.test(semanticSubtype)) {
    throw protocolError(`${path} 只能描述稳定特征身份，不得包含当前姿态或过程状态`);
  }
  const featureKind = requireBoundedString(feature.featureKind, `${path}.featureKind`, 40);
  if (!FEATURE_KIND_SET.has(featureKind)) {
    throw protocolError(`${path}.featureKind 不在允许枚举中`);
  }
  const evidenceLevel = requireBoundedString(feature.evidenceLevel, `${path}.evidenceLevel`, 20);
  if (!EVIDENCE_LEVEL_SET.has(evidenceLevel)) {
    throw protocolError(`${path}.evidenceLevel 不在允许枚举中`);
  }
  const terms = validateTerms(feature.terms, `${path}.terms`);
  if (terms.some((term) => FEATURE_STATE_PATTERN.test(term))) {
    throw protocolError(`${path}.terms 不得包含当前姿态或过程状态`);
  }
  const evidenceSpanIds = validateSignedSpanIds(feature.evidenceSpanIds, {
    path: `${path}.evidenceSpanIds`,
    character,
    catalog
  });
  const inferenceSpanIds = validateSignedSpanIds(feature.inferenceSpanIds, {
    path: `${path}.inferenceSpanIds`,
    character,
    catalog
  });
  const combined = [...evidenceSpanIds, ...inferenceSpanIds];
  if (new Set(combined).size !== combined.length) {
    throw protocolError(`${path} 的 evidenceSpanIds 与 inferenceSpanIds 不得重复`);
  }
  if (evidenceLevel === "explicit" && evidenceSpanIds.length === 0) {
    throw protocolError(`${path} explicit 特征必须引用 evidenceSpanIds`, {
      errorCode: "CHARACTER_FEATURE_EVIDENCE_REQUIRED",
      repairable: false
    });
  }
  if (
    evidenceLevel === "explicit"
    && !hasLiteralExplicitEvidence({
      canonicalName,
      terms,
      evidenceSpanIds,
      catalog
    })
  ) {
    throw protocolError(`${path} explicit 证据未逐字包含 canonicalName 或任何 term`, {
      errorCode: "CHARACTER_FEATURE_EVIDENCE_UNGROUNDED",
      repairable: false
    });
  }
  if (evidenceLevel === "inferred" && inferenceSpanIds.length === 0) {
    throw protocolError(`${path} inferred 特征必须引用 inferenceSpanIds`, {
      errorCode: "CHARACTER_FEATURE_EVIDENCE_REQUIRED",
      repairable: false
    });
  }
  if (evidenceLevel === "unresolved" && combined.length === 0) {
    throw protocolError(`${path} unresolved 特征仍需至少一个签发证据 ID`, {
      errorCode: "CHARACTER_FEATURE_EVIDENCE_REQUIRED",
      repairable: false
    });
  }

  return {
    suggestedFeatureKey,
    canonicalName,
    terms,
    featureKind,
    semanticSubtype,
    evidenceLevel,
    evidenceSpanIds,
    inferenceSpanIds
  };
}

function validateSignedSpanIds(value, { path, character, catalog }) {
  if (!Array.isArray(value) || value.length > 16) {
    throw protocolError(`${path} 必须是最多 16 项的数组`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const spanId = requireBoundedString(entry, `${path}[${index}]`, 160);
    if (seen.has(spanId)) throw protocolError(`${path} 不得包含重复 spanId`);
    seen.add(spanId);
    const span = catalog.spanById.get(spanId);
    if (!span || span.characterTargetId !== character.characterTargetId) {
      throw protocolError(`${path}[${index}] 不是该角色获授权的签发 spanId`, {
        errorCode: "CHARACTER_FEATURE_ILLEGAL_ID",
        repairable: false
      });
    }
    return spanId;
  });
}

function hasLiteralExplicitEvidence({
  canonicalName,
  terms,
  evidenceSpanIds,
  catalog
}) {
  const needles = uniqueTerms([canonicalName, ...terms])
    .map(normalizeTerm)
    .filter(Boolean);
  return evidenceSpanIds.some((spanId) => {
    const source = normalizeTerm(catalog.spanById.get(spanId)?.rawText || "");
    return needles.some((needle) => source.includes(needle));
  });
}

function validateTerms(value, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw protocolError(`${path} 必须是 1-24 项数组`);
  }
  const seen = new Set();
  return value.map((term, index) => {
    const text = requireBoundedString(term, `${path}[${index}]`, 48);
    const normalized = normalizeTerm(text);
    if (!normalized || seen.has(normalized)) {
      throw protocolError(`${path} 不得包含空白或规范化后重复 term`);
    }
    seen.add(normalized);
    return text;
  });
}

function resolveTermConflicts(characterId, features, conflicts) {
  const ownersByTerm = new Map();
  features.forEach((feature) => {
    feature.matcherTerms.forEach((term) => {
      const normalized = normalizeTerm(term);
      const owners = ownersByTerm.get(normalized) || [];
      owners.push({ feature, term });
      ownersByTerm.set(normalized, owners);
    });
  });

  ownersByTerm.forEach((owners, normalizedTerm) => {
    const distinct = [...new Map(owners.map((owner) => [owner.feature.featureId, owner])).values()];
    if (distinct.length < 2) return;
    const explicit = distinct.filter((owner) => owner.feature.evidenceLevel === "explicit");
    const winners = explicit.length === 1 ? explicit : [];
    if (winners.length === 1) {
      distinct.forEach((owner) => {
        if (owner.feature.featureId === winners[0].feature.featureId) return;
        disableMatcherTerm(owner.feature, normalizedTerm);
      });
      conflicts.push({
        errorCode: "FEATURE_TERM_SHADOWED",
        characterId,
        normalizedTerm,
        winnerFeatureId: winners[0].feature.featureId,
        disabledFeatureIds: distinct
          .filter((owner) => owner.feature.featureId !== winners[0].feature.featureId)
          .map((owner) => owner.feature.featureId)
          .sort()
      });
      return;
    }

    distinct.forEach((owner) => disableMatcherTerm(owner.feature, normalizedTerm));
    conflicts.push({
      errorCode: "FEATURE_TERM_CONFLICT",
      characterId,
      normalizedTerm,
      disabledFeatureIds: distinct.map((owner) => owner.feature.featureId).sort()
    });
  });
}

function disableMatcherTerm(feature, normalizedTerm) {
  const removed = feature.matcherTerms.filter((term) => normalizeTerm(term) === normalizedTerm);
  feature.matcherTerms = feature.matcherTerms.filter((term) => normalizeTerm(term) !== normalizedTerm);
  feature.disabledTerms.push(...removed);
}

function dedupeFeatureDrafts(features) {
  const seen = new Map();
  features.forEach((feature) => {
    const key = [
      normalizeTerm(feature.suggestedFeatureKey),
      normalizeTerm(feature.canonicalName),
      feature.featureKind,
      normalizeTerm(feature.semanticSubtype)
    ].join("|");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, {
        ...feature,
        terms: [...feature.terms],
        evidenceSpanIds: [...feature.evidenceSpanIds],
        inferenceSpanIds: [...feature.inferenceSpanIds]
      });
      return;
    }
    existing.terms = uniqueTerms([...existing.terms, ...feature.terms]);
    existing.evidenceSpanIds = [...new Set([
      ...existing.evidenceSpanIds,
      ...feature.evidenceSpanIds
    ])];
    existing.inferenceSpanIds = [...new Set([
      ...existing.inferenceSpanIds,
      ...feature.inferenceSpanIds
    ])];
    if (evidenceLevelRank(feature.evidenceLevel) > evidenceLevelRank(existing.evidenceLevel)) {
      existing.evidenceLevel = feature.evidenceLevel;
    }
  });
  return [...seen.values()];
}

function evidenceLevelRank(level) {
  if (level === "explicit") return 3;
  if (level === "inferred") return 2;
  return 1;
}

function uniqueFeatureKey(feature, usedFeatureIds) {
  const base = normalizeSuggestedKey(feature.suggestedFeatureKey);
  let key = base;
  let index = 2;
  while ([...usedFeatureIds].some((featureId) => featureId.endsWith(`.${key}`))) {
    key = `${base}_${index}`;
    index += 1;
  }
  return key;
}

function projectAuthoritativeInput({
  creatorProfile = {},
  visualGuardrails = {},
  fullStory = {},
  temporaryCharacters = []
} = {}) {
  const normalizedTemporary = Array.isArray(temporaryCharacters)
    ? temporaryCharacters.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = String(entry.name || entry.nameOrLabel || "").trim();
      if (!name) return [];
      const setting = cloneJson(
        entry.setting
        ?? entry.identity
        ?? entry.description
        ?? entry.explicitSetting
        ?? ""
      );
      return [{ name, setting }];
    })
    : [];
  return {
    __characterFeatureAuthoritativeInput: true,
    creatorProfile: {
      fixedCharacter: String(creatorProfile?.fixedCharacter || "").trim()
    },
    visualGuardrails: {
      fixedCharacterBoundary: sanitizeAuthoritativeValue({
        schemaVersion: visualGuardrails?.fixedCharacterBoundary?.schemaVersion || "",
        characterName: visualGuardrails?.fixedCharacterBoundary?.characterName || "",
        requiredTraits: Array.isArray(visualGuardrails?.fixedCharacterBoundary?.requiredTraits)
          ? visualGuardrails.fixedCharacterBoundary.requiredTraits
          : []
      })
    },
    fullStory: {
      characterBible: sanitizeAuthoritativeValue(fullStory?.characterBible || {})
    },
    temporaryCharacters: normalizedTemporary
  };
}

function isProjectedAuthoritativeInput(value) {
  return isRecord(value) && value.__characterFeatureAuthoritativeInput === true;
}

function collectCharacterSeeds(authoritativeInput) {
  const seeds = [];
  const add = (name, role) => {
    const clean = String(name || "").trim();
    if (!clean) return;
    const normalized = normalizeTerm(clean);
    if (seeds.some((seed) => normalizeTerm(seed.name) === normalized)) return;
    seeds.push({ name: clean, role });
  };
  const bible = authoritativeInput.fullStory.characterBible || {};
  add(bible?.protagonist?.name || extractFixedCharacterName(
    authoritativeInput.creatorProfile.fixedCharacter
  ), "protagonist");
  add(bible?.careRecipient?.nameOrLabel, "careRecipient");
  if (Array.isArray(bible?.helpers)) {
    bible.helpers.forEach((helper) => add(helper?.nameOrLabel, "helper"));
  }
  authoritativeInput.temporaryCharacters.forEach((temporary) => add(temporary.name, "temporary"));
  return seeds;
}

function collectCharacterBibleSources(characterBible = {}, { skipProtagonist = false } = {}) {
  const sources = [];
  const addObject = (value, rootPath, name) => {
    collectStringLeaves(value, rootPath).forEach(({ path, value: text }) => {
      sources.push({
        sourceGroup: "characterBible",
        sourcePath: path,
        value: text,
        characterNames: [name]
      });
    });
  };
  const protagonist = characterBible?.protagonist;
  if (!skipProtagonist && isRecord(protagonist)) {
    addObject(protagonist, "fullStory.characterBible.protagonist", protagonist.name);
  }
  const careRecipient = characterBible?.careRecipient;
  if (isRecord(careRecipient)) {
    addObject(
      careRecipient,
      "fullStory.characterBible.careRecipient",
      careRecipient.nameOrLabel
    );
  }
  if (Array.isArray(characterBible?.helpers)) {
    characterBible.helpers.forEach((helper, index) => {
      if (!isRecord(helper)) return;
      addObject(
        helper,
        `fullStory.characterBible.helpers[${index}]`,
        helper.nameOrLabel
      );
    });
  }
  return sources;
}

function collectStringLeaves(value, rootPath) {
  const leaves = [];
  const visit = (current, path) => {
    if (typeof current === "string") {
      if (current.trim()) leaves.push({ path, value: current });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(current)) return;
    Object.keys(current).sort().forEach((key) => visit(current[key], `${path}.${key}`));
  };
  visit(value, rootPath);
  return leaves;
}

function uniqueBoundCharacters({
  value,
  characterNames,
  characters,
  targetByNormalizedName
}) {
  const explicit = [...new Set(characterNames.map(normalizeTerm).filter(Boolean))]
    .map((name) => targetByNormalizedName.get(name))
    .filter(Boolean);
  if (explicit.length === 1) return explicit;
  if (explicit.length > 1) return [];
  const literal = literalCharacterNames(value, characters)
    .map((name) => targetByNormalizedName.get(normalizeTerm(name)))
    .filter(Boolean);
  if (literal.length === 1) return literal;
  return literal.length === 0 && characters.length === 1 ? [characters[0]] : [];
}

function literalCharacterNames(value, characters) {
  const text = String(value || "");
  return characters
    .filter((character) => character.name && text.includes(character.name))
    .map((character) => character.name);
}

function splitSourceSpans(value) {
  const text = String(value || "");
  const spans = [];
  const boundary = /[，,。；;：:！!？?\n\r、]/gu;
  let cursor = 0;
  let match;
  while ((match = boundary.exec(text))) {
    pushTrimmedSpan(spans, text, cursor, match.index);
    cursor = match.index + match[0].length;
  }
  pushTrimmedSpan(spans, text, cursor, text.length);
  if (spans.length === 0 && text.trim()) {
    const start = text.search(/\S/u);
    const end = text.length - (text.match(/\s*$/u)?.[0].length || 0);
    spans.push({ start, end, text: text.slice(start, end) });
  }
  return spans;
}

function pushTrimmedSpan(spans, source, start, end) {
  while (start < end && /\s/u.test(source[start])) start += 1;
  while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  if (end <= start) return;
  const text = source.slice(start, end);
  if (!text || /^[\p{P}\p{S}\s]+$/u.test(text)) return;
  spans.push({ start, end, text });
}

function validateCachedProfile(profile, { sourceHash, catalog }) {
  if (!isRecord(profile)) return null;
  try {
    if (!hasExactKeys(profile, CACHED_PROFILE_KEYS)) return null;
    if (profile.profileVersion !== CHARACTER_FEATURE_PROFILE_VERSION) return null;
    if (profile.compilerVersion !== CHARACTER_FEATURE_COMPILER_VERSION) return null;
    if (profile.dimensionRegistryVersion !== CHARACTER_FEATURE_DIMENSION_REGISTRY_VERSION) return null;
    if (profile.sourceHash !== sourceHash) return null;
    if (typeof profile.profileDigest !== "string") return null;
    const { profileDigest, ...profileContent } = profile;
    if (profileDigest !== computeProfileDigest(profileContent)) return null;
    if (!Array.isArray(profile.characters) || !Array.isArray(profile.conflicts)) return null;
    const expected = new Map(
      catalog.characters.map((character) => [character.characterId, character.name])
    );
    const proofIndex = buildSignedSpanProofIndex(catalog);
    if (profile.characters.length !== expected.size) return null;
    for (const character of profile.characters) {
      if (
        !isRecord(character)
        || !hasExactKeys(character, CACHED_CHARACTER_KEYS)
        || expected.get(character.characterId) !== character.name
      ) return null;
      if (!Array.isArray(character.features)) return null;
      const usedFeatureIds = new Set();
      for (const feature of character.features) {
        if (!isValidCachedFeature(feature, {
          characterId: character.characterId,
          usedFeatureIds,
          proofIndex
        })) return null;
        usedFeatureIds.add(feature.featureId);
      }
      if (!cachedMatcherConflictStateIsValid(character.features, character.characterId)) return null;
    }
    return deepFreeze(cloneJson(profile));
  } catch {
    return null;
  }
}

function isValidCachedFeature(feature, {
  characterId,
  usedFeatureIds,
  proofIndex
}) {
  if (!isRecord(feature) || !hasExactKeys(feature, CACHED_FEATURE_KEYS)) return false;
  if (typeof feature.suggestedFeatureKey !== "string") return false;
  const expectedKey = uniqueFeatureKey(feature, usedFeatureIds);
  if (feature.featureId !== `${characterId}.${expectedKey}`) return false;
  if (typeof feature.canonicalName !== "string" || !feature.canonicalName.trim()) return false;
  if (typeof feature.semanticSubtype !== "string" || !feature.semanticSubtype.trim()) return false;
  if (FEATURE_STATE_PATTERN.test(feature.canonicalName)) return false;
  if (FEATURE_STATE_PATTERN.test(feature.semanticSubtype)) return false;
  if (!FEATURE_KIND_SET.has(feature.featureKind)) return false;
  if (!EVIDENCE_LEVEL_SET.has(feature.evidenceLevel)) return false;
  if (feature.poseCompatible !== POSE_COMPATIBLE_KINDS.has(feature.featureKind)) return false;
  if (
    !Array.isArray(feature.terms)
    || !Array.isArray(feature.matcherTerms)
    || !Array.isArray(feature.disabledTerms)
    || !Array.isArray(feature.evidenceProofs)
    || !Array.isArray(feature.inferenceEvidenceProofs)
  ) return false;
  if (
    !feature.terms.every((term) => typeof term === "string" && term.trim())
    || feature.terms.some((term) => FEATURE_STATE_PATTERN.test(term))
    || uniqueTerms(feature.terms).length !== feature.terms.length
  ) return false;
  if (!feature.matcherTerms.every((term) =>
    feature.terms.some((original) => normalizeTerm(original) === normalizeTerm(term)))) {
    return false;
  }
  if (feature.evidenceLevel === "unresolved" && feature.matcherTerms.length > 0) return false;
  if (
    feature.evidenceCount !== feature.evidenceProofs.length
    || feature.inferenceEvidenceCount !== feature.inferenceEvidenceProofs.length
  ) return false;
  const evidenceSpans = resolveCachedProofs(
    feature.evidenceProofs,
    characterId,
    proofIndex
  );
  const inferenceSpans = resolveCachedProofs(
    feature.inferenceEvidenceProofs,
    characterId,
    proofIndex
  );
  if (!evidenceSpans || !inferenceSpans) return false;
  if (feature.evidenceLevel === "explicit") {
    if (evidenceSpans.length === 0) return false;
    const needles = uniqueTerms([feature.canonicalName, ...feature.terms]).map(normalizeTerm);
    if (!evidenceSpans.some((span) => {
      const source = normalizeTerm(span.rawText);
      return needles.some((needle) => source.includes(needle));
    })) return false;
  }
  if (feature.evidenceLevel === "inferred" && inferenceSpans.length === 0) return false;
  if (
    feature.evidenceLevel === "unresolved"
    && evidenceSpans.length + inferenceSpans.length === 0
  ) return false;
  return true;
}

function cachedMatcherConflictStateIsValid(features, characterId) {
  const copies = features.map((feature) => ({
    ...feature,
    matcherTerms: feature.evidenceLevel === "unresolved"
      ? []
      : uniqueTerms(feature.terms),
    disabledTerms: []
  }));
  resolveTermConflicts(characterId, copies, []);
  return copies.every((copy, index) =>
    stableStringify(copy.matcherTerms) === stableStringify(features[index].matcherTerms)
    && stableStringify(copy.disabledTerms) === stableStringify(features[index].disabledTerms)
  );
}

function buildSignedSpanProofIndex(catalog) {
  const index = new Map();
  catalog.spanById.forEach((span) => {
    const proof = signedSpanProof(span);
    const existing = index.get(proof) || [];
    existing.push(span);
    index.set(proof, existing);
  });
  return index;
}

function resolveCachedProofs(proofs, characterId, proofIndex) {
  const seen = new Set();
  const spans = [];
  for (const proof of proofs) {
    if (typeof proof !== "string" || seen.has(proof)) return null;
    seen.add(proof);
    const candidates = (proofIndex.get(proof) || [])
      .filter((span) => span.characterId === characterId);
    if (candidates.length !== 1) return null;
    spans.push(candidates[0]);
  }
  return spans;
}

function signedSpanProof(span) {
  if (!span) return "";
  const payload = [
    span.sourcePath,
    span.utf16Start,
    span.utf16End,
    span.rawText,
    span.characterId
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function computeProfileDigest(profile) {
  return `sha256:${createHash("sha256").update(stableStringify(profile)).digest("hex")}`;
}

function buildCharacterFeatureRetryPrompt({
  basePrompt,
  diagnostic,
  repairMode,
  failedResponse
}) {
  const prior = failedResponse === null
    ? "上一次响应没有可用的 JSON 对象。"
    : JSON.stringify(failedResponse);
  return `${basePrompt}

CHARACTER_FEATURE_COMPILER_PROTOCOL_RETRY_V1
repairMode: ${repairMode}

上一次输出未通过：
${JSON.stringify(String(diagnostic || "未知协议错误"))}

上一次完整 JSON 响应：
${prior}

这是本阶段唯一一次 ${repairMode}。只修复协议或 Profile 字段，不得更换签发角色或证据 ID，
不得新增路径、offset、原文、Foundation 信息或角色。仍返回完整的 {"characters":[...]} 对象。`;
}

function finalProtocolError(message, metadata, {
  errorCode = "CHARACTER_FEATURE_PROTOCOL_FAILED",
  cause = null
} = {}) {
  metadata.finalResult = "failed";
  metadata.errorCode = errorCode;
  return new CharacterFeatureCompilerProtocolError(
    `Character Feature Compiler protocol 失败：${message}`,
    { errorCode, repairable: false, metadata, cause }
  );
}

function asProtocolError(error) {
  if (error instanceof CharacterFeatureCompilerProtocolError) return error;
  return new CharacterFeatureCompilerProtocolError(String(error?.message || error), {
    cause: error
  });
}

function protocolError(message, options = {}) {
  return new CharacterFeatureCompilerProtocolError(message, options);
}

function assertExactKeys(value, expectedKeys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unexpected = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    throw protocolError(
      `${path} 字段不符合 Schema`
      + `${unexpected.length ? `；额外字段：${unexpected.join("、")}` : ""}`
      + `${missing.length ? `；缺少字段：${missing.join("、")}` : ""}`
    );
  }
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function requireBoundedString(value, path, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw protocolError(`${path} 必须是无首尾空白的非空字符串`);
  }
  if (value.length > maxLength) throw protocolError(`${path} 长度不得超过 ${maxLength}`);
  return value;
}

function validateLiveConfiguration({ client, model, maxCompletionTokens, timeoutMs }) {
  if (!client || typeof client.generateJson !== "function") {
    throw new CharacterFeatureCompilerConfigError(
      "Character Feature Compiler client 必须实现 generateJson"
    );
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new CharacterFeatureCompilerConfigError(
      "CHARACTER_FEATURE_COMPILER_MODEL 必须显式配置"
    );
  }
  if (!Number.isFinite(Number(maxCompletionTokens)) || Number(maxCompletionTokens) <= 0) {
    throw new CharacterFeatureCompilerConfigError(
      "CHARACTER_FEATURE_COMPILER_MAX_COMPLETION_TOKENS 必须为正数"
    );
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    throw new CharacterFeatureCompilerConfigError(
      "CHARACTER_FEATURE_COMPILER_TIMEOUT_MS 必须为正数"
    );
  }
}

function createMetadata({ provider, model, sourceHash, catalog }) {
  return {
    stage: "characterFeatureCompiler",
    version: CHARACTER_FEATURE_COMPILER_VERSION,
    profileVersion: CHARACTER_FEATURE_PROFILE_VERSION,
    sourceHash,
    provider,
    model,
    cacheHit: false,
    cacheSource: null,
    requestCount: 0,
    finalResult: "pending",
    errorCode: null,
    sourceCatalog: {
      characterCount: catalog.characters.length,
      segmentCount: catalog.segments.length,
      spanCount: catalog.spanById.size
    },
    protocolAttempts: [],
    counts: {
      characterCount: 0,
      featureCount: 0,
      explicit: 0,
      inferred: 0,
      unresolved: 0
    },
    conflicts: [],
    featureIdMappings: []
  };
}

function featureCounts(profile) {
  const features = profile.characters.flatMap((character) => character.features);
  return {
    characterCount: profile.characters.length,
    featureCount: features.length,
    explicit: features.filter((feature) => feature.evidenceLevel === "explicit").length,
    inferred: features.filter((feature) => feature.evidenceLevel === "inferred").length,
    unresolved: features.filter((feature) => feature.evidenceLevel === "unresolved").length
  };
}

function putCache(key, profile) {
  if (profileCache.has(key)) profileCache.delete(key);
  profileCache.set(key, deepFreeze(cloneJson(profile)));
  while (profileCache.size > PROFILE_CACHE_LIMIT) {
    profileCache.delete(profileCache.keys().next().value);
  }
}

function touchCache(key, profile) {
  profileCache.delete(key);
  profileCache.set(key, profile);
}

function stableCharacterId(name) {
  const digest = createHash("sha256").update(normalizeTerm(name)).digest("hex").slice(0, 12);
  return `character-${digest}`;
}

function normalizeSuggestedKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    || "feature";
}

function normalizeTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter((term) => {
    const normalized = normalizeTerm(term);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function sanitizeAuthoritativeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuthoritativeValue);
  if (!isRecord(value)) {
    if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
    return null;
  }
  const result = {};
  Object.keys(value).sort().forEach((key) => {
    if (key === "characterReferencePrompts" || key === "animationFoundation") return;
    result[key] = sanitizeAuthoritativeValue(value[key]);
  });
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function classifyTransportError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "");
  const message = String(error?.message || "").toUpperCase();
  if (status === 401 || status === 403 || /API.?KEY|AUTH|鉴权|认证|未授权/u.test(message)) {
    return "auth";
  }
  if (/INVALID MODEL|UNKNOWN MODEL|MODEL.*NOT FOUND|无效模型|未知模型/u.test(message)) {
    return "provider";
  }
  if (
    status === 408
    || name === "AbortError"
    || name === "TimeoutError"
    || ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)
    || /TIMEOUT|TIMED OUT|超时/u.test(message)
  ) {
    return "timeout";
  }
  return status > 0 ? "provider" : "transport";
}

function isModelJsonProtocolError(error) {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof ModelResponseError) && error?.name !== "ModelResponseError") return false;
  const message = String(error?.message || "");
  return Number(error?.status || 0) === 0
    && /未返回合法 JSON|无法解析的响应包|响应缺少 .*content|JSON/u.test(message);
}

function inferProvider(client) {
  const name = String(client?.constructor?.name || "").replace(/Client$/u, "");
  return name || "unknown";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function freezeClone(value) {
  return deepFreeze(cloneJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
