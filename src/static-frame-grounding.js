import { randomUUID } from "node:crypto";

export const STATIC_FRAME_CANDIDATE_ERROR_CODES = Object.freeze([
  "NO_STATIC_EVIDENCE_IN_SOURCE",
  "NO_VALID_GROUNDED_COMBINATION",
  "EVIDENCE_RESELECTION_EXHAUSTED"
]);

export const STATIC_FRAME_META_DIMENSIONS = Object.freeze([
  "body",
  "limbs",
  "orientation",
  "bodyContact",
  "characterFeature",
  "handPropState"
]);

export const STATIC_FRAME_FIELD_CATEGORIES = Object.freeze([
  "pose_body",
  "pose_limbs",
  "pose_orientation",
  "pose_body_contact",
  "pose_character_feature",
  "hand_prop_state"
]);

const TARGET_FIELDS = Object.freeze(["pose", "handPropState"]);
const TARGET_FIELD_SET = new Set(TARGET_FIELDS);
const CATEGORY_SET = new Set(STATIC_FRAME_FIELD_CATEGORIES);
const POSE_CATEGORY_SET = new Set(STATIC_FRAME_FIELD_CATEGORIES.filter((category) => (
  category.startsWith("pose_")
)));
const MAX_SELECTIONS_PER_TARGET = 12;
const MAX_SPANS_PER_SELECTION = 32;
const CLAUSE_BOUNDARY_PATTERN = /[，,。；;：:！!？?\n]+/gu;
const STRUCTURAL_GAP_PATTERN = /^[\s\p{P}]*$/u;
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

export function createStaticFrameRunId() {
  return `run-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function buildStaticFrameCompileTargets(candidate, { runId = createStaticFrameRunId() } = {}) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new TypeError("animationShotBatch 必须包含 shotPlan 数组");
  }
  const targets = new Map();
  let targetIndex = 0;
  candidate.shotPlan.forEach((shot, shotIndex) => {
    for (const frameKind of ["startFrame", "endFrame"]) {
      const characters = shot?.[frameKind]?.characters;
      if (!Array.isArray(characters)) continue;
      const frameCharacterLabels = characters.map((character, characterIndex) => (
        normalizeLabel(character?.name || character?.characterName || `角色${characterIndex + 1}`)
      ));
      const labelCounts = new Map();
      frameCharacterLabels.forEach((label) => {
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      });
      characters.forEach((character, characterIndex) => {
        if (!isRecord(character)) return;
        for (const field of TARGET_FIELDS) {
          const before = character[field];
          if (typeof before !== "string") continue;
          const path = `animationShotBatch.shotPlan[${shotIndex}].${frameKind}.characters[${characterIndex}].${field}`;
          const targetId = `compile-target-${runId}-${targetIndex}`;
          const characterLabel = normalizeLabel(
            character.name || character.characterName || `角色${characterIndex + 1}`
          );
          const emptyRequiredField = !before.trim();
          targets.set(targetId, {
            targetId,
            runId,
            path,
            before,
            field,
            fieldLabel: field,
            shotIndex,
            frameKind,
            characterIndex,
            characterLabel,
            characterLabelUniqueInFrame: labelCounts.get(characterLabel) === 1,
            frameCharacterLabels: [...new Set(frameCharacterLabels)],
            characterId: character.characterId
              || character.id
              || `character-${slugify(characterLabel)}-${characterIndex}`,
            reasonCode: emptyRequiredField
              ? "static_frame_required"
              : "field_semantic_organization",
            trigger: emptyRequiredField
              ? "STATIC_FRAME_REQUIRED"
              : "AI_FIELD_ORGANIZER"
          });
          targetIndex += 1;
        }
      });
    }
  });
  return targets;
}

export function buildStaticFrameSourceCatalog(
  candidate,
  targets,
  { runId = inferRunId(targets) } = {}
) {
  const segments = new Map();
  const spans = new Map();
  let segmentIndex = 0;
  let spanIndex = 0;

  for (const target of targets.values()) {
    const frame = candidate.shotPlan?.[target.shotIndex]?.[target.frameKind];
    const character = frame?.characters?.[target.characterIndex];
    if (!isRecord(character)) continue;
    for (const field of authorizedSourceFields(target.field)) {
      const text = character[field];
      if (typeof text !== "string" || !text.trim()) continue;
      const sourcePath = `animationShotBatch.shotPlan[${target.shotIndex}].${target.frameKind}.characters[${target.characterIndex}].${field}`;
      const segmentId = `seg-${runId}-${segmentIndex}`;
      const segment = {
        segmentId,
        runId,
        targetId: target.targetId,
        sourcePath,
        characterId: target.characterId,
        frameKind: target.frameKind,
        field,
        displayText: text,
        spanIds: []
      };
      segmentIndex += 1;
      for (const range of collectLanguageNeutralRanges(text)) {
        const spanId = `span-${runId}-${spanIndex}`;
        const slice = text.slice(range.start, range.end);
        const span = {
          spanId,
          runId,
          segmentId,
          targetId: target.targetId,
          sourcePath,
          start: range.start,
          end: range.end,
          utf16Start: range.start,
          utf16End: range.end,
          text: slice,
          unit: range.unit,
          characterId: target.characterId,
          frameKind: target.frameKind,
          field
        };
        spanIndex += 1;
        spans.set(spanId, span);
        segment.spanIds.push(spanId);
      }
      if (segment.spanIds.length > 0) segments.set(segmentId, segment);
    }
  }

  return Object.freeze({ runId, segments, spans });
}

export function auditStaticFrameSourceCatalog(catalog, targets) {
  const candidateSpanIdsByTarget = new Map();
  const rejectionBySpanId = new Map();
  for (const targetId of targets.keys()) candidateSpanIdsByTarget.set(targetId, new Set());

  for (const span of catalog.spans.values()) {
    const target = targets.get(span.targetId);
    const segment = catalog.segments.get(span.segmentId);
    const reason = auditCatalogSpan(span, segment, target);
    if (reason) {
      rejectionBySpanId.set(span.spanId, reason);
      continue;
    }
    candidateSpanIdsByTarget.get(span.targetId)?.add(span.spanId);
  }

  return {
    catalog,
    candidateSpanIdsByTarget,
    rejectionBySpanId,
    countForTarget(targetId) {
      return candidateSpanIdsByTarget.get(targetId)?.size || 0;
    },
    totalCount: [...candidateSpanIdsByTarget.values()]
      .reduce((total, ids) => total + ids.size, 0)
  };
}

export function publicStaticFrameCatalogView(audit, targets, {
  targetIds = [...targets.keys()]
} = {}) {
  const allowedTargets = new Set(targetIds);
  return targetIds.flatMap((targetId) => {
    const target = targets.get(targetId);
    if (!target) return [];
    const segments = [];
    for (const segment of audit.catalog.segments.values()) {
      if (segment.targetId !== targetId || !allowedTargets.has(segment.targetId)) continue;
      const spanViews = segment.spanIds
        .filter((spanId) => audit.candidateSpanIdsByTarget.get(targetId)?.has(spanId))
        .map((spanId) => {
          const span = audit.catalog.spans.get(spanId);
          return {
            spanId,
            displayText: span.text,
            unit: span.unit
          };
        });
      if (spanViews.length > 0) {
        segments.push({
          segmentId: segment.segmentId,
          sourceField: segment.field,
          displayText: segment.displayText,
          spans: spanViews
        });
      }
    }
    return [{
      targetId,
      characterLabel: target.characterLabel,
      frameKind: target.frameKind,
      fieldLabel: target.fieldLabel,
      allowedCategories: allowedCategoriesForField(target.field),
      segments
    }];
  });
}

export function validateStaticFrameEvidenceEnvelope(
  response,
  {
    expectedTargetIds,
    audit,
    repairMode = null,
    requireRepairMode = false
  }
) {
  if (!isRecord(response)) throw protocolError("Field Organizer 输出必须是 JSON 对象");
  const topKeys = requireRepairMode ? ["repairMode", "targets"] : ["targets"];
  requireExactKeys(response, topKeys, "Field Organizer 顶层");
  if (requireRepairMode && response.repairMode !== repairMode) {
    throw protocolError(`repairMode 必须为 ${repairMode}`);
  }
  if (!Array.isArray(response.targets)) {
    throw protocolError("Field Organizer targets 必须是数组");
  }

  const expected = new Set(expectedTargetIds);
  const seenTargets = new Set();
  const normalizedTargets = response.targets.map((entry, targetIndex) => {
    const path = `targets[${targetIndex}]`;
    if (!isRecord(entry)) throw protocolError(`${path} 必须是对象`);
    requireExactKeys(entry, ["targetId", "evidenceSelections"], path);
    if (typeof entry.targetId !== "string" || !expected.has(entry.targetId)) {
      throw protocolError(`${path}.targetId 非法、过期或不在本次授权范围`);
    }
    if (seenTargets.has(entry.targetId)) throw protocolError(`${path}.targetId 重复`);
    seenTargets.add(entry.targetId);
    if (!Array.isArray(entry.evidenceSelections)) {
      throw protocolError(`${path}.evidenceSelections 必须是数组`);
    }
    if (entry.evidenceSelections.length > MAX_SELECTIONS_PER_TARGET) {
      throw protocolError(`${path}.evidenceSelections 最多 ${MAX_SELECTIONS_PER_TARGET} 项`);
    }
    const targetField = inferCatalogTargetField(audit, entry.targetId);
    const selections = entry.evidenceSelections.map((selection, selectionIndex) => {
      const selectionPath = `${path}.evidenceSelections[${selectionIndex}]`;
      if (!isRecord(selection)) throw protocolError(`${selectionPath} 必须是对象`);
      requireExactKeys(selection, ["segmentId", "spanIds", "category", "featureId"], selectionPath);
      const segment = audit.catalog.segments.get(selection.segmentId);
      if (!segment || segment.targetId !== entry.targetId) {
        throw protocolError(`${selectionPath}.segmentId 非法、跨 target、过期或伪造`);
      }
      if (!CATEGORY_SET.has(selection.category)) {
        throw protocolError(`${selectionPath}.category 不是允许的字段语义类别`);
      }
      if (!allowedCategoriesForField(targetField).includes(selection.category)) {
        throw protocolError(`${selectionPath}.category 与目标字段职责不兼容`);
      }
      if (selection.category === "pose_character_feature") {
        if (typeof selection.featureId !== "string" || !selection.featureId.trim()) {
          throw protocolError(`${selectionPath}.featureId 必须引用冻结 Character Feature`);
        }
      } else if (selection.featureId !== null) {
        throw protocolError(`${selectionPath}.featureId 在非 character feature 类别中必须为 null`);
      }
      if (!Array.isArray(selection.spanIds) || selection.spanIds.length === 0) {
        throw protocolError(`${selectionPath}.spanIds 必须是非空数组`);
      }
      if (selection.spanIds.length > MAX_SPANS_PER_SELECTION) {
        throw protocolError(`${selectionPath}.spanIds 最多 ${MAX_SPANS_PER_SELECTION} 项`);
      }
      const uniqueSpanIds = new Set(selection.spanIds);
      if (uniqueSpanIds.size !== selection.spanIds.length) {
        throw protocolError(`${selectionPath}.spanIds 不得重复`);
      }
      for (const spanId of selection.spanIds) {
        if (typeof spanId !== "string") {
          throw protocolError(`${selectionPath}.spanIds 只能包含服务端签发的字符串 ID`);
        }
        const span = audit.catalog.spans.get(spanId);
        if (
          !span
          || span.segmentId !== selection.segmentId
          || span.targetId !== entry.targetId
          || !audit.candidateSpanIdsByTarget.get(entry.targetId)?.has(spanId)
        ) {
          throw protocolError(`${selectionPath}.spanIds 包含非法、跨 segment、跨 target、过期或未经授权的 ID`);
        }
      }
      return {
        segmentId: selection.segmentId,
        spanIds: [...selection.spanIds],
        category: selection.category,
        featureId: selection.featureId
      };
    });
    return { targetId: entry.targetId, evidenceSelections: selections };
  });

  if (seenTargets.size !== expected.size || [...expected].some((targetId) => !seenTargets.has(targetId))) {
    throw protocolError("Field Organizer 必须恰好覆盖每个必需 targetId 一次");
  }
  return normalizedTargets;
}

export function reviewSelectedStaticFrameEvidence({
  normalizedTargets,
  targets,
  audit,
  characterFeatureProfile = null,
  attempt = 1
}) {
  const results = new Map();
  for (const entry of normalizedTargets) {
    const target = targets.get(entry.targetId);
    const selectedSpanIds = new Set(entry.evidenceSelections.flatMap((selection) => selection.spanIds));
    const allCandidateSpanIds = audit.candidateSpanIdsByTarget.get(entry.targetId) || new Set();
    const unselectedCandidateSpanIds = [...allCandidateSpanIds]
      .filter((spanId) => !selectedSpanIds.has(spanId));
    const slots = [];
    const rejectedSelections = [];
    const occupiedFacts = [];

    entry.evidenceSelections.forEach((selection, selectionIndex) => {
      const reviewed = reviewSelection(selection, {
        target,
        audit,
        characterFeatureProfile
      });
      if (!reviewed.accepted) {
        rejectedSelections.push({ selectionIndex, reason: reviewed.reason });
        return;
      }
      const duplicateOrOverlap = occupiedFacts.some((fact) => (
        fact.sourcePath === reviewed.sourcePath
        && intervalsOverlap(fact.start, fact.end, reviewed.start, reviewed.end)
      ));
      if (duplicateOrOverlap) {
        rejectedSelections.push({ selectionIndex, reason: "OVERLAPPING_OR_DUPLICATE_FACT" });
        return;
      }
      occupiedFacts.push({
        sourcePath: reviewed.sourcePath,
        start: reviewed.start,
        end: reviewed.end
      });
      const slotSeed = slots.length;
      slots.push({
        stateSlotId: `state-slot-a${attempt}-${target.targetId}-${slotSeed}`,
        targetId: target.targetId,
        characterId: target.characterId,
        frameKind: target.frameKind,
        field: target.field,
        sourceSegmentIds: [selection.segmentId],
        sourceSpanIds: [...selection.spanIds],
        primaryDimensionKey: reviewed.primaryDimensionKey,
        category: selection.category,
        featureId: selection.featureId,
        groundedText: reviewed.groundedText,
        sourceOrder: reviewed.sourceOrder
      });
    });

    const distinctDimensions = new Set(slots.map((slot) => slot.primaryDimensionKey));
    results.set(entry.targetId, {
      targetId: entry.targetId,
      attempt,
      selectedSpanIds: [...selectedSpanIds],
      selectedValidatedEvidence: slots.length,
      unselectedCandidateSpanIds,
      slots,
      rejectedSelections,
      requiredDimensionCount: Math.min(2, distinctDimensions.size)
    });
  }
  return results;
}

export function enumerateGroundedPatchCombinations(target, reviewResult, {
  candidate = null
} = {}) {
  const slots = [...reviewResult.slots].sort(compareSlots);
  const combinations = [];
  for (const slot of slots) combinations.push([slot]);
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const pair = [slots[left], slots[right]];
      if (!isLegalSlotPair(pair)) continue;
      combinations.push(pair);
    }
  }

  const search = [];
  for (const combination of combinations) {
    const dimensions = new Set(combination.map((slot) => slot.primaryDimensionKey));
    const patch = compileGroundedPatch(target, combination);
    let rejection = "";
    if (dimensions.size < reviewResult.requiredDimensionCount) {
      rejection = "REQUIRED_DIMENSION_COUNT_NOT_MET";
    } else {
      rejection = candidate
        ? validateGroundedStaticTarget(candidate, target, patch, combination, {
            requiredDimensionCount: reviewResult.requiredDimensionCount
          })
        : validateGroundedPatch(target, patch, combination);
    }
    search.push({
      stateSlotIds: combination.map((slot) => slot.stateSlotId),
      dimensionKeys: [...dimensions],
      validationScope: candidate ? "target-scoped-applied-candidate" : "grounded-patch",
      accepted: !rejection,
      rejection: rejection || null
    });
    if (!rejection) return { patch, combination, search };
  }
  return { patch: null, combination: null, search };
}

export function validateGroundedStaticTarget(
  candidate,
  target,
  patch,
  slots,
  { requiredDimensionCount = 0 } = {}
) {
  const patchRejection = validateGroundedPatch(target, patch, slots);
  if (patchRejection) return patchRejection;
  const dimensions = new Set(slots.map((slot) => slot.primaryDimensionKey));
  if (dimensions.size < requiredDimensionCount) return "REQUIRED_DIMENSION_COUNT_NOT_MET";
  if (target.path !== staticFrameTargetPath(target)) return "LOCKED_TARGET_PATH_MISMATCH";

  const trial = structuredClone(candidate);
  const character = trial.shotPlan?.[target.shotIndex]?.[target.frameKind]
    ?.characters?.[target.characterIndex];
  if (!isRecord(character) || !Object.hasOwn(character, target.field)) {
    return "LOCKED_TARGET_FIELD_MISSING";
  }
  const characterLabel = normalizeLabel(
    character.name || character.characterName || `角色${target.characterIndex + 1}`
  );
  if (characterLabel !== target.characterLabel) return "LOCKED_TARGET_CHARACTER_MISMATCH";
  character[target.field] = patch.value;
  return validateAppliedGroundedStaticTarget(trial, target, patch);
}

export function applyGroundedStaticFramePatches(candidate, patches, targets) {
  const compiled = structuredClone(candidate);
  for (const patch of patches) {
    const target = targets.get(patch.targetId);
    if (!target || target.path !== patch.path) {
      throw protocolError("服务端 canonical patch 的 target/path 锁定关系无效");
    }
    const character = compiled.shotPlan?.[target.shotIndex]?.[target.frameKind]
      ?.characters?.[target.characterIndex];
    if (!isRecord(character) || !Object.hasOwn(character, target.field)) {
      throw protocolError("服务端 canonical patch 目标字段不存在");
    }
    character[target.field] = patch.value;
  }
  for (const patch of patches) {
    const target = targets.get(patch.targetId);
    const rejection = validateAppliedGroundedStaticTarget(compiled, target, patch);
    if (rejection) {
      throw protocolError(`服务端 canonical patch 原子应用后复检失败：${rejection}`);
    }
  }
  return compiled;
}

export function staticFrameTargetPromptView(targets) {
  return [...targets.values()].map((target) => ({
    targetId: target.targetId,
    characterLabel: target.characterLabel,
    frameKind: target.frameKind,
    fieldLabel: target.fieldLabel,
    allowedCategories: allowedCategoriesForField(target.field)
  }));
}

export function summarizeReviewForMetadata(reviewResults) {
  return [...reviewResults.values()].map((review) => ({
    targetId: review.targetId,
    selectedValidatedEvidenceCount: review.selectedValidatedEvidence,
    unselectedCandidateEvidenceCount: review.unselectedCandidateSpanIds.length,
    unselectedCandidateCount: review.unselectedCandidateSpanIds.length,
    requiredDimensionCount: review.requiredDimensionCount,
    safeDimensions: [...new Set(review.slots.map((slot) => slot.primaryDimensionKey))],
    availableDimensions: [...new Set(review.slots.map((slot) => slot.primaryDimensionKey))],
    stateSlots: review.slots.map((slot) => ({
      stateSlotId: slot.stateSlotId,
      targetId: slot.targetId,
      sourceSegmentIds: [...slot.sourceSegmentIds],
      sourceSpanIds: [...slot.sourceSpanIds],
      primaryDimensionKey: slot.primaryDimensionKey,
      category: slot.category,
      featureId: slot.featureId
    })),
    rejectedSelectionReasons: review.rejectedSelections.map((item) => item.reason)
  }));
}

function collectLanguageNeutralRanges(text) {
  const ranges = [];
  addTrimmedRange(ranges, text, 0, text.length, "source");
  let clauseStart = 0;
  for (const match of text.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    addTrimmedRange(ranges, text, clauseStart, match.index, "clause");
    clauseStart = match.index + match[0].length;
  }
  addTrimmedRange(ranges, text, clauseStart, text.length, "clause");
  for (const part of WORD_SEGMENTER.segment(text)) {
    if (!part.isWordLike) continue;
    addTrimmedRange(
      ranges,
      text,
      part.index,
      part.index + part.segment.length,
      "word"
    );
  }
  return deduplicateRanges(ranges);
}

function addTrimmedRange(ranges, text, rawStart, rawEnd, unit) {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (end > start) ranges.push({ start, end, unit });
}

function deduplicateRanges(ranges) {
  const seen = new Set();
  return ranges
    .filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter(({ start, end, unit }) => {
      const key = `${start}:${end}:${unit}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function auditCatalogSpan(span, segment, target) {
  if (!span || !segment || !target) return "INVALID_HIERARCHY";
  if (
    span.runId !== segment.runId
    || span.targetId !== target.targetId
    || span.characterId !== target.characterId
    || span.frameKind !== target.frameKind
    || span.segmentId !== segment.segmentId
    || span.sourcePath !== segment.sourcePath
    || span.field !== segment.field
  ) {
    return "SCOPE_BINDING_MISMATCH";
  }
  if (!TARGET_FIELD_SET.has(target.field) || !authorizedSourceFields(target.field).includes(span.field)) {
    return "FIELD_NOT_AUTHORIZED";
  }
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) {
    return "INVALID_SOURCE_RANGE";
  }
  if (segment.displayText.slice(span.start, span.end) !== span.text || !span.text.trim()) {
    return "SOURCE_SLICE_MISMATCH";
  }
  const mentionedCharacters = (target.frameCharacterLabels || [target.characterLabel])
    .filter((label) => label && span.text.includes(label));
  if (
    mentionedCharacters.length > 1
    || (mentionedCharacters.length === 1 && mentionedCharacters[0] !== target.characterLabel)
  ) {
    return "AMBIGUOUS_OR_CROSS_CHARACTER_EVIDENCE";
  }
  return "";
}

function reviewSelection(selection, { target, audit, characterFeatureProfile }) {
  const segment = audit.catalog.segments.get(selection.segmentId);
  const spans = selection.spanIds
    .map((spanId) => audit.catalog.spans.get(spanId))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!segment || spans.some((span) => !span)) {
    return { accepted: false, reason: "INVALID_ID" };
  }
  for (let index = 1; index < spans.length; index += 1) {
    if (intervalsOverlap(
      spans[index - 1].start,
      spans[index - 1].end,
      spans[index].start,
      spans[index].end
    )) {
      return { accepted: false, reason: "OVERLAPPING_SPANS" };
    }
  }
  const groundedText = compileDeletionOnlyGroundedText(segment, spans);
  if (!groundedText.trim()) return { accepted: false, reason: "EMPTY_GROUNDED_TEXT" };
  if (!allowedCategoriesForField(target.field).includes(selection.category)) {
    return { accepted: false, reason: "FIELD_CATEGORY_MISMATCH" };
  }
  const dimension = dimensionForSelection(selection, groundedText, {
    characterFeatureProfile,
    target
  });
  if (!dimension) return { accepted: false, reason: "UNBOUND_CHARACTER_FEATURE" };
  return {
    accepted: true,
    groundedText,
    primaryDimensionKey: dimension,
    sourcePath: segment.sourcePath,
    start: spans[0].start,
    end: spans.at(-1).end,
    sourceOrder: [
      target.shotIndex,
      target.frameKind === "startFrame" ? 0 : 1,
      target.characterIndex,
      spans[0].start
    ]
  };
}

function compileDeletionOnlyGroundedText(segment, spans) {
  let groundedText = spans[0]?.text || "";
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    const gap = segment.displayText.slice(previous.end, current.start);
    groundedText += `${compiledGap(gap, previous.text, current.text)}${current.text}`;
  }
  return groundedText;
}

function compiledGap(gap, previousText, nextText) {
  if (STRUCTURAL_GAP_PATTERN.test(gap)) return gap;
  if (
    /\s/u.test(gap)
    && /[\p{Letter}\p{Number}]$/u.test(previousText)
    && /^[\p{Letter}\p{Number}]/u.test(nextText)
  ) {
    return " ";
  }
  return "";
}

function dimensionForSelection(selection, groundedText, {
  characterFeatureProfile,
  target
}) {
  if (selection.category === "pose_character_feature") {
    const feature = resolveFeature(characterFeatureProfile, target, selection.featureId);
    if (!feature) return "";
    const terms = usableFeatureTerms(feature);
    if (!terms.some((term) => groundedText.includes(term))) return "";
    return `characterFeature:${selection.featureId}`;
  }
  return {
    pose_body: "body",
    pose_limbs: "limbs",
    pose_orientation: "orientation",
    pose_body_contact: "bodyContact",
    hand_prop_state: "handPropState"
  }[selection.category] || "";
}

function resolveFeature(profile, target, featureId) {
  return getCharacterFeatures(profile, target).find((feature) => (
    (feature?.featureId || feature?.id) === featureId
  )) || null;
}

function getCharacterFeatures(profile, target) {
  if (!profile || !Array.isArray(profile.characters)) return [];
  const idMatches = profile.characters.filter((character) => (
    character.characterId === target.characterId
  ));
  if (idMatches.length === 1) {
    return Array.isArray(idMatches[0].features) ? idMatches[0].features : [];
  }
  if (idMatches.length > 1 || target.characterLabelUniqueInFrame === false) return [];
  const nameMatches = profile.characters.filter((character) => (
    character.characterLabel === target.characterLabel
    || character.characterName === target.characterLabel
    || character.name === target.characterLabel
    || character.canonicalName === target.characterLabel
  ));
  if (nameMatches.length !== 1) return [];
  return Array.isArray(nameMatches[0].features) ? nameMatches[0].features : [];
}

function usableFeatureTerms(feature) {
  if (feature.poseCompatible === false || feature.evidenceLevel === "unresolved") return [];
  const disabled = new Set([
    ...(Array.isArray(feature.disabledTerms) ? feature.disabledTerms : []),
    ...(Array.isArray(feature.conflictedTerms) ? feature.conflictedTerms : [])
  ]);
  const source = Array.isArray(feature.matcherTerms)
    ? feature.matcherTerms
    : Array.isArray(feature.activeTerms)
      ? feature.activeTerms
      : Array.isArray(feature.terms) ? feature.terms : [];
  return source.filter((term) => typeof term === "string" && term && !disabled.has(term));
}

function isLegalSlotPair([left, right]) {
  if (
    left.targetId !== right.targetId
    || left.characterId !== right.characterId
    || left.frameKind !== right.frameKind
    || left.field !== right.field
    || left.primaryDimensionKey === right.primaryDimensionKey
  ) {
    return false;
  }
  if (sourceSpansOverlap(left, right)) return false;
  return normalizeText(left.groundedText) !== normalizeText(right.groundedText);
}

function compileGroundedPatch(target, slots) {
  const visibleFacts = slots.map((slot) => slot.groundedText);
  return {
    targetId: target.targetId,
    path: target.path,
    value: visibleFacts.join("，"),
    reasonCode: target.reasonCode,
    triggerSpans: [target.trigger],
    visibleFacts,
    stateSlotIds: slots.map((slot) => slot.stateSlotId)
  };
}

function validateGroundedPatch(target, patch, slots) {
  if (
    patch.targetId !== target.targetId
    || patch.path !== target.path
    || patch.reasonCode !== target.reasonCode
    || patch.triggerSpans.length !== 1
    || patch.triggerSpans[0] !== target.trigger
  ) {
    return "LOCKED_TARGET_METADATA_MISMATCH";
  }
  if (
    patch.visibleFacts.length !== slots.length
    || patch.stateSlotIds.length !== slots.length
    || slots.some((slot, index) => (
      slot.targetId !== target.targetId
      || slot.characterId !== target.characterId
      || slot.frameKind !== target.frameKind
      || slot.field !== target.field
      || patch.visibleFacts[index] !== slot.groundedText
      || patch.stateSlotIds[index] !== slot.stateSlotId
      || !allowedCategoriesForField(target.field).includes(slot.category)
    ))
  ) {
    return "STATE_SLOT_BINDING_MISMATCH";
  }
  if (patch.value !== patch.visibleFacts.join("，")) return "NON_DETERMINISTIC_FINAL_TEXT";
  if (!patch.value.trim()) return "EMPTY_REQUIRED_FIELD";
  return "";
}

function validateAppliedGroundedStaticTarget(candidate, target, patch) {
  if (!target || target.path !== staticFrameTargetPath(target)) {
    return "LOCKED_TARGET_PATH_MISMATCH";
  }
  const character = candidate?.shotPlan?.[target.shotIndex]?.[target.frameKind]
    ?.characters?.[target.characterIndex];
  if (!isRecord(character) || !Object.hasOwn(character, target.field)) {
    return "LOCKED_TARGET_FIELD_MISSING";
  }
  if (character[target.field] !== patch.value) return "APPLIED_VALUE_MISMATCH";
  if (!patch.value.trim()) return "EMPTY_REQUIRED_FIELD";
  return "";
}

function staticFrameTargetPath(target) {
  return `animationShotBatch.shotPlan[${target.shotIndex}].${target.frameKind}.characters[${target.characterIndex}].${target.field}`;
}

function compareSlots(left, right) {
  for (let index = 0; index < Math.max(left.sourceOrder.length, right.sourceOrder.length); index += 1) {
    const difference = Number(left.sourceOrder[index] || 0) - Number(right.sourceOrder[index] || 0);
    if (difference !== 0) return difference;
  }
  return left.stateSlotId.localeCompare(right.stateSlotId);
}

function sourceSpansOverlap(left, right) {
  const leftIds = new Set(left.sourceSpanIds);
  return right.sourceSpanIds.some((spanId) => leftIds.has(spanId));
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function allowedCategoriesForField(field) {
  if (field === "pose") return [...POSE_CATEGORY_SET];
  if (field === "handPropState") return ["hand_prop_state"];
  return [];
}

function inferCatalogTargetField(audit, targetId) {
  for (const segment of audit.catalog.segments.values()) {
    if (segment.targetId !== targetId) continue;
    if (segment.field === "handPropState") return "handPropState";
  }
  return "pose";
}

function authorizedSourceFields(targetField) {
  if (targetField === "pose") return ["pose", "bodyOrientation", "gaze"];
  if (targetField === "handPropState") return ["handPropState"];
  return [];
}

function inferRunId(targets) {
  return targets.values().next().value?.runId || createStaticFrameRunId();
}

function normalizeLabel(value) {
  return String(value || "").trim() || "未命名角色";
}

function slugify(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "unknown";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}]/gu, "")
    .toLowerCase();
}

function requireExactKeys(value, expectedKeys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw protocolError(`${path} 只能包含 ${expectedKeys.join("、")}`);
  }
}

function protocolError(message) {
  const error = new Error(message);
  error.name = "StaticFrameGroundingProtocolError";
  error.category = "protocol";
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
