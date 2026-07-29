import { randomUUID } from "node:crypto";
import {
  STATIC_FRAME_INVISIBLE_INTENT_TERMS,
  STATIC_FRAME_PROCESS_OR_AUDIO_TERMS
} from "./validation.js";

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
  "characterFeature"
]);

const TARGET_FIELDS = Object.freeze(["pose", "handPropState", "actionState"]);
const TARGET_FIELD_SET = new Set(TARGET_FIELDS);
const MAX_SELECTIONS_PER_TARGET = 12;
const MAX_SPANS_PER_SELECTION = 4;
const CLAUSE_BOUNDARY_PATTERN = /[，,。；;：:！!？?\n]+/gu;
const LEADING_PROCESS_PATTERN = /^(?:随后|然后|接着|最后|最终|正在|开始|继续|逐渐|慢慢|逐步|过程中|准备|即将|将要|接下来|下一步)+/u;
const DYNAMIC_ACTION_PATTERN = /摆动|摇摆|挥动|移动|行走|奔跑|跑动|转动|旋转|打开|拿起|拾起|按下|推开|拉开|走向|跑向|跳起|落下|伸向|抓向|抬起|放下/u;
const FEATURE_STATE_PATTERN = /垂|竖|弯|曲|卷|收|展|张|闭|翘|夹|贴|停|悬|位于|朝|向|保持|落在|放在|在.+(?:侧|后|前|上|下|旁)/u;
const GENERAL_STATE_PATTERN = /坐|站|蹲|跪|躺|趴|俯|倾|仰|弯|挺|垂|竖|抬|举|伸|曲|放|停|贴|按|撑|靠|扶|朝|面向|背对|侧身|位于|保持|悬|展开|收拢|闭合|张开|触地|着地|落在|握住|握着|持有|拿着|托住|托着|捧着|抱着|夹住|夹着|抓住|抓着|未接触|相距|距离/u;
const ORIENTATION_PATTERN = /朝向|面向|背对|侧身|转向|正对|偏向|看向|望向|凝视|注视|(?:身体|躯干|头部|脸部|视线|目光).{0,6}(?:朝着|朝)/u;
const BODY_CONTACT_PATTERN = /(?:身体|躯干|背部|肩|肘|手|掌|膝|腿|脚|足|前肢|后肢).{0,8}(?:接触|贴在|按在|撑在|靠在|倚在|扶在|触地|着地|跪在|坐在|躺在)|(?:接触|贴在|按在|撑在|靠在|倚在|扶在|触地|着地|跪在|坐在|躺在).{0,8}(?:地面|墙面|墙|座椅|椅子|桌面|台面|栏杆|地板)/u;
const ENVIRONMENT_SUPPORT_PATTERN = /地面|墙面|墙|座椅|椅子|桌面|台面|栏杆|地板|床面|岩壁|树干/u;
const PROP_RELATION_PATTERN = /道具|盒|按钮|杯|手机|书|门把|武器|剑|枪|球|绳|工具|玩具|餐具|乐器|包|瓶|伞|相机/u;
const HAND_SUBJECT_PATTERN = /双手|左手|右手|手掌|手指|手腕|手臂|双臂/u;
const LIMBS_PATTERN = /双手|左手|右手|手掌|手指|手腕|手臂|双臂|肘|肩|双腿|左腿|右腿|腿|膝|双脚|左脚|右脚|脚|足|前肢|后肢/u;
const BODY_SUBJECT_PATTERN = /坐|站|蹲|跪|躺|趴|俯身|前倾|后仰|弯腰|挺直|(?:躯干|身体|重心).{0,8}(?:保持|呈|处于|坐|站|蹲|跪|躺|趴|俯|倾|仰|弯|挺|直|移动|偏移)/u;
const LEXICAL_ANCHOR_PATTERN = /双手|左手|右手|手掌|手指|手腕|手臂|双臂|肘|肩|双腿|左腿|右腿|膝|双脚|左脚|右脚|前肢|后肢|躯干|身体|重心/gu;
const STATE_SUFFIX_ANCHOR_PATTERN = /双手|左手|右手|手掌|手指|手腕|手臂|双臂|肘|肩|双腿|左腿|右腿|膝|双脚|左脚|右脚|前肢|后肢|躯干|身体|重心|朝向|面向|背对|侧身|转向|正对|偏向|俯身|前倾|后仰|弯腰|挺直|蹲|跪|躺|趴/gu;
const POST_TRIGGER_CONNECTOR_PATTERN = /^(?:\s|地|着|后|之后|以后|时|的时候|并|而|再|就|将|会|去|要|来)+/u;
const DELETION_GAP_CONNECTOR_PATTERN = /(?:之后|以后|的时候|并且|而且|于是|所以|以及|同时|接着|然后|随后|最终|最后|逐渐|慢慢|地|着|后|时|并|而|再|就|将|会|去|要|来|[\s，,。；;：:！!？?、])+/gu;
const MUTUALLY_EXCLUSIVE_PAIRS = Object.freeze([
  ["站", "坐"],
  ["站", "躺"],
  ["蹲", "站"],
  ["面向", "背对"],
  ["张开", "闭合"],
  ["抬起", "垂下"]
]);

const REASON_TRIGGER_PATTERNS = Object.freeze({
  narrative_cognition: /发现|意识到|知道|明白|认出|想起|回忆|察觉|理解|确认|判断出/u,
  psychological_activity: /决定|希望|担心|害怕|期待|犹豫|想要|(?<![理思设幻])想(?![象法])|试图|打算|计划|愿意|内心|心里/u,
  future_intent: /准备|即将|将要|想要|试图|打算|计划|马上会|下一步/u,
  goal_stage: /为了|以便|目标(?!道具|物体|对象|位置|区域|点|方向)|目的(?!地)|准备|阶段|接下来|下一步|完成后|成功后/u,
  ambiguous_nonvisual: /似乎|仿佛|好像|意图|目的|念头|意识|认知|心理|情绪变化|做出反应|镜头移动|运镜|对白|音效/u,
  temporal_process: /逐渐|随后|然后|正在|开始|继续|慢慢|逐步|过程中|一边.+一边|先.+再|最后|最终|接着/u
});

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
          const emptyRequiredField = field !== "actionState" && !before.trim();
          if (!emptyRequiredField && !containsStaticFrameViolation(before)) continue;
          const path = `animationShotBatch.shotPlan[${shotIndex}].${frameKind}.characters[${characterIndex}].${field}`;
          const targetId = `compile-target-${runId}-${targetIndex}`;
          const characterLabel = normalizeLabel(character.name || character.characterName || `角色${characterIndex + 1}`);
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
            reasonCode: emptyRequiredField ? "static_frame_required" : inferReasonCode(before),
            trigger: emptyRequiredField
              ? "STATIC_FRAME_REQUIRED"
              : firstStaticFrameViolation(before)
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
  { runId = inferRunId(targets), characterFeatureProfile = null } = {}
) {
  const segments = new Map();
  const spans = new Map();
  let segmentIndex = 0;
  let spanIndex = 0;

  for (const target of targets.values()) {
    const frame = candidate.shotPlan?.[target.shotIndex]?.[target.frameKind];
    const character = frame?.characters?.[target.characterIndex];
    if (!isRecord(character)) continue;
    const authorizedFields = authorizedSourceFields(target.field);
    for (const field of authorizedFields) {
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
      const ranges = collectCandidateRanges(text, {
        characterFeatureProfile,
        target
      });
      for (const range of ranges) {
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

  return Object.freeze({
    runId,
    segments,
    spans
  });
}

export function auditStaticFrameSourceCatalog(catalog, targets, {
  characterFeatureProfile = null
} = {}) {
  const candidateSpanIdsByTarget = new Map();
  const rejectionBySpanId = new Map();
  for (const targetId of targets.keys()) candidateSpanIdsByTarget.set(targetId, new Set());

  for (const span of catalog.spans.values()) {
    const target = targets.get(span.targetId);
    const segment = catalog.segments.get(span.segmentId);
    const reason = auditCatalogSpan(span, segment, target, {
      catalog,
      characterFeatureProfile
    });
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
  const targetViews = [];
  for (const targetId of targetIds) {
    const target = targets.get(targetId);
    if (!target) continue;
    const segments = [];
    for (const segment of audit.catalog.segments.values()) {
      if (segment.targetId !== targetId || !allowedTargets.has(segment.targetId)) continue;
      const spanViews = segment.spanIds
        .filter((spanId) => audit.candidateSpanIdsByTarget.get(targetId)?.has(spanId))
        .map((spanId) => {
          const span = audit.catalog.spans.get(spanId);
          return { spanId, displayText: span.text };
        });
      if (spanViews.length > 0) {
        segments.push({
          segmentId: segment.segmentId,
          displayText: segment.displayText,
          spans: spanViews
        });
      }
    }
    targetViews.push({
      targetId,
      characterLabel: target.characterLabel,
      frameKind: target.frameKind,
      fieldLabel: target.fieldLabel,
      segments
    });
  }
  return targetViews;
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
  if (!isRecord(response)) throw protocolError("Evidence Selection 输出必须是 JSON 对象");
  const topKeys = requireRepairMode ? ["repairMode", "targets"] : ["targets"];
  requireExactKeys(response, topKeys, "Evidence Selection 顶层");
  if (requireRepairMode && response.repairMode !== repairMode) {
    throw protocolError(`repairMode 必须为 ${repairMode}`);
  }
  if (!Array.isArray(response.targets)) {
    throw protocolError("Evidence Selection targets 必须是数组");
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
    if (seenTargets.has(entry.targetId)) {
      throw protocolError(`${path}.targetId 重复`);
    }
    seenTargets.add(entry.targetId);
    if (!Array.isArray(entry.evidenceSelections)) {
      throw protocolError(`${path}.evidenceSelections 必须是数组`);
    }
    if (entry.evidenceSelections.length > MAX_SELECTIONS_PER_TARGET) {
      throw protocolError(`${path}.evidenceSelections 最多 ${MAX_SELECTIONS_PER_TARGET} 项`);
    }
    const selections = entry.evidenceSelections.map((selection, selectionIndex) => {
      const selectionPath = `${path}.evidenceSelections[${selectionIndex}]`;
      if (!isRecord(selection)) throw protocolError(`${selectionPath} 必须是对象`);
      requireExactKeys(selection, ["segmentId", "spanIds"], selectionPath);
      const segment = audit.catalog.segments.get(selection.segmentId);
      if (!segment || segment.targetId !== entry.targetId) {
        throw protocolError(`${selectionPath}.segmentId 非法、跨 target、过期或伪造`);
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
        spanIds: [...selection.spanIds]
      };
    });
    return { targetId: entry.targetId, evidenceSelections: selections };
  });

  if (seenTargets.size !== expected.size || [...expected].some((targetId) => !seenTargets.has(targetId))) {
    throw protocolError("Evidence Selection 必须恰好覆盖每个必需 targetId 一次");
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
        rejectedSelections.push({
          selectionIndex,
          reason: reviewed.reason
        });
        return;
      }
      const duplicateOrOverlap = occupiedFacts.some((fact) => (
        fact.sourcePath === reviewed.sourcePath
        && intervalsOverlap(fact.start, fact.end, reviewed.start, reviewed.end)
      ));
      if (duplicateOrOverlap) {
        rejectedSelections.push({
          selectionIndex,
          reason: "OVERLAPPING_OR_DUPLICATE_FACT"
        });
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
    if (!rejection) {
      return {
        patch,
        combination,
        search
      };
    }
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
  if (dimensions.size < requiredDimensionCount) {
    return "REQUIRED_DIMENSION_COUNT_NOT_MET";
  }
  const expectedPath = staticFrameTargetPath(target);
  if (target.path !== expectedPath) return "LOCKED_TARGET_PATH_MISMATCH";

  const trial = structuredClone(candidate);
  const character = trial.shotPlan?.[target.shotIndex]?.[target.frameKind]
    ?.characters?.[target.characterIndex];
  if (!isRecord(character) || !Object.hasOwn(character, target.field)) {
    return "LOCKED_TARGET_FIELD_MISSING";
  }
  const characterLabel = normalizeLabel(
    character.name || character.characterName || `角色${target.characterIndex + 1}`
  );
  if (characterLabel !== target.characterLabel) {
    return "LOCKED_TARGET_CHARACTER_MISMATCH";
  }
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
    fieldLabel: target.fieldLabel
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
      primaryDimensionKey: slot.primaryDimensionKey
    })),
    rejectedSelectionReasons: review.rejectedSelections.map((item) => item.reason)
  }));
}

export function containsStaticFrameViolation(value) {
  return Boolean(firstStaticFrameViolation(value));
}

export function firstStaticFrameViolation(value) {
  const text = String(value || "");
  const shared = [...STATIC_FRAME_PROCESS_OR_AUDIO_TERMS, ...STATIC_FRAME_INVISIBLE_INTENT_TERMS]
    .find((term) => text.includes(term));
  if (shared) return shared;
  for (const pattern of Object.values(REASON_TRIGGER_PATTERNS)) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

function collectCandidateRanges(text, { characterFeatureProfile, target }) {
  const ranges = [];
  let clauseStart = 0;
  for (const match of text.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    addTrimmedRange(ranges, text, clauseStart, match.index);
    clauseStart = match.index + match[0].length;
  }
  addTrimmedRange(ranges, text, clauseStart, text.length);
  const clauseRanges = [...ranges];

  for (const range of clauseRanges) {
    const clause = text.slice(range.start, range.end);
    const leading = clause.match(LEADING_PROCESS_PATTERN);
    if (leading?.[0] && leading[0].length < clause.length) {
      addTrimmedRange(ranges, text, range.start + leading[0].length, range.end);
    }
    addPostViolationSuffixRanges(ranges, text, range);
    for (const match of clause.matchAll(STATE_SUFFIX_ANCHOR_PATTERN)) {
      addTrimmedRange(ranges, text, range.start + match.index, range.end);
    }
  }

  const featureTerms = getCharacterFeatures(characterFeatureProfile, target)
    .flatMap((feature) => usableFeatureTerms(feature));
  for (const term of new Set(featureTerms)) {
    addEveryLiteralOccurrence(ranges, text, term);
    for (const range of clauseRanges) {
      const clause = text.slice(range.start, range.end);
      let offset = 0;
      while (offset <= clause.length - term.length) {
        const found = clause.indexOf(term, offset);
        if (found < 0) break;
        addTrimmedRange(ranges, text, range.start + found, range.end);
        offset = found + Math.max(1, term.length);
      }
    }
  }
  for (const match of text.matchAll(LEXICAL_ANCHOR_PATTERN)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return deduplicateRanges(ranges);
}

function addPostViolationSuffixRanges(ranges, text, clauseRange) {
  const clause = text.slice(clauseRange.start, clauseRange.end);
  const suffixStarts = new Set();
  const addMatchEnd = (matchIndex, matchedText) => {
    if (!Number.isInteger(matchIndex) || !matchedText) return;
    let localStart = matchIndex + matchedText.length;
    const connector = clause.slice(localStart).match(POST_TRIGGER_CONNECTOR_PATTERN);
    if (connector?.[0]) localStart += connector[0].length;
    if (localStart < clause.length) suffixStarts.add(localStart);
  };

  for (const pattern of Object.values(REASON_TRIGGER_PATTERNS)) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of clause.matchAll(new RegExp(pattern.source, flags))) {
      addMatchEnd(match.index, match[0]);
    }
  }
  for (const term of [
    ...STATIC_FRAME_PROCESS_OR_AUDIO_TERMS,
    ...STATIC_FRAME_INVISIBLE_INTENT_TERMS
  ]) {
    let offset = 0;
    while (offset <= clause.length - term.length) {
      const found = clause.indexOf(term, offset);
      if (found < 0) break;
      addMatchEnd(found, term);
      offset = found + Math.max(1, term.length);
    }
  }

  [...suffixStarts]
    .sort((left, right) => left - right)
    .forEach((localStart) => {
      addTrimmedRange(
        ranges,
        text,
        clauseRange.start + localStart,
        clauseRange.end
      );
    });
}

function addTrimmedRange(ranges, text, rawStart, rawEnd) {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (end > start) ranges.push({ start, end });
}

function addEveryLiteralOccurrence(ranges, text, term) {
  if (typeof term !== "string" || !term) return;
  let offset = 0;
  while (offset <= text.length - term.length) {
    const found = text.indexOf(term, offset);
    if (found < 0) break;
    ranges.push({ start: found, end: found + term.length });
    offset = found + Math.max(1, term.length);
  }
}

function deduplicateRanges(ranges) {
  const seen = new Set();
  return ranges
    .filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter(({ start, end }) => {
      const key = `${start}:${end}`;
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
  ) {
    return "SCOPE_BINDING_MISMATCH";
  }
  if (!TARGET_FIELD_SET.has(target.field) || !authorizedSourceFields(target.field).includes(span.field)) {
    return "FIELD_NOT_AUTHORIZED";
  }
  if (!span.text.trim()) return "EMPTY_SPAN";
  const mentionedCharacters = (target.frameCharacterLabels || [target.characterLabel])
    .filter((label) => label && span.text.includes(label));
  if (
    mentionedCharacters.length > 1
    || (mentionedCharacters.length === 1 && mentionedCharacters[0] !== target.characterLabel)
  ) {
    return "AMBIGUOUS_OR_CROSS_CHARACTER_EVIDENCE";
  }
  if (
    target.field === "handPropState"
    && BODY_CONTACT_PATTERN.test(span.text)
    && ENVIRONMENT_SUPPORT_PATTERN.test(span.text)
    && !PROP_RELATION_PATTERN.test(span.text)
  ) {
    return "HAND_PROP_BODY_CONTACT_EXCLUDED";
  }
  if (containsStaticFrameViolation(span.text)) return "EXPLICIT_NON_STATIC_TERM";
  if (DYNAMIC_ACTION_PATTERN.test(span.text) && !GENERAL_STATE_PATTERN.test(span.text)) {
    return "EXPLICIT_DYNAMIC_ACTION";
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
    if (intervalsOverlap(spans[index - 1].start, spans[index - 1].end, spans[index].start, spans[index].end)) {
      return { accepted: false, reason: "OVERLAPPING_SPANS" };
    }
  }
  if (!isDeletionOnlySpanSequence(segment, spans)) {
    return { accepted: false, reason: "NON_DELETION_GAP_BETWEEN_SPANS" };
  }
  const groundedText = compileDeletionOnlyGroundedText(segment, spans);
  if (!groundedText.trim()) return { accepted: false, reason: "EMPTY_GROUNDED_TEXT" };
  if (containsStaticFrameViolation(groundedText)) {
    return { accepted: false, reason: "NON_STATIC_LANGUAGE_REMAINS" };
  }
  if (DYNAMIC_ACTION_PATTERN.test(groundedText) && !FEATURE_STATE_PATTERN.test(groundedText)) {
    return { accepted: false, reason: "DYNAMIC_PROCESS_NOT_STATIC_STATE" };
  }
  if (
    target.field === "handPropState"
    && (!HAND_SUBJECT_PATTERN.test(groundedText) || !PROP_RELATION_PATTERN.test(groundedText))
  ) {
    return { accepted: false, reason: "HAND_PROP_FIELD_DUTY_MISMATCH" };
  }
  const dimension = determinePrimaryDimension(groundedText, {
    sourceSpans: spans,
    target,
    characterFeatureProfile
  });
  if (!dimension) return { accepted: false, reason: "NO_SAFE_PRIMARY_DIMENSION" };
  if (!GENERAL_STATE_PATTERN.test(groundedText)) {
    return { accepted: false, reason: "NO_SINGLE_FRAME_STATE_PREDICATE" };
  }
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

function isDeletionOnlySpanSequence(segment, spans) {
  if (spans.length < 2) return true;
  for (let index = 1; index < spans.length; index += 1) {
    const gap = segment.displayText.slice(spans[index - 1].end, spans[index].start);
    if (!isDeletableNonStaticGap(gap)) return false;
  }
  return true;
}

function isDeletableNonStaticGap(gap) {
  let residue = String(gap || "");
  if (/^[\s，,。；;：:！!？?、]*$/u.test(residue)) return true;
  if (!containsStaticFrameViolation(residue)) return false;
  for (const pattern of Object.values(REASON_TRIGGER_PATTERNS)) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    residue = residue.replace(new RegExp(pattern.source, flags), "");
  }
  for (const term of [
    ...STATIC_FRAME_PROCESS_OR_AUDIO_TERMS,
    ...STATIC_FRAME_INVISIBLE_INTENT_TERMS
  ].sort((left, right) => right.length - left.length)) {
    residue = residue.split(term).join("");
  }
  residue = residue.replace(DELETION_GAP_CONNECTOR_PATTERN, "");
  return residue.length === 0;
}

function compileDeletionOnlyGroundedText(segment, spans) {
  let groundedText = spans[0]?.text || "";
  for (let index = 1; index < spans.length; index += 1) {
    const gap = segment.displayText.slice(spans[index - 1].end, spans[index].start);
    const separator = /[，,。；;：:！!？?、\n\r]/u.test(gap) ? "，" : "";
    groundedText += `${separator}${spans[index].text}`;
  }
  return groundedText;
}

function determinePrimaryDimension(text, {
  sourceSpans = [],
  target,
  characterFeatureProfile
}) {
  const feature = matchCharacterFeature(text, characterFeatureProfile, target);
  if (feature && FEATURE_STATE_PATTERN.test(text)) {
    if (hasConflictingFeatureSubject(sourceSpans, feature, characterFeatureProfile, target)) {
      return "";
    }
    return `characterFeature:${feature.featureId}`;
  }
  if (ORIENTATION_PATTERN.test(text)) return "orientation";
  if (
    target.field !== "handPropState"
    && BODY_CONTACT_PATTERN.test(text)
    && ENVIRONMENT_SUPPORT_PATTERN.test(text)
    && !PROP_RELATION_PATTERN.test(text)
  ) {
    return "bodyContact";
  }
  if (LIMBS_PATTERN.test(text)) return "limbs";
  if (BODY_SUBJECT_PATTERN.test(text)) return "body";
  return "";
}

function matchCharacterFeature(text, profile, target) {
  const matches = [];
  for (const feature of getCharacterFeatures(profile, target)) {
    const featureId = feature.featureId || feature.id;
    if (typeof featureId !== "string" || !featureId) continue;
    for (const term of usableFeatureTerms(feature)) {
      if (text.includes(term)) matches.push({ feature, featureId, term });
    }
  }
  matches.sort((left, right) => right.term.length - left.term.length || left.featureId.localeCompare(right.featureId));
  if (matches.length === 0) return null;
  const longest = matches[0].term.length;
  const winningFeatureIds = new Set(
    matches.filter((match) => match.term.length === longest).map((match) => match.featureId)
  );
  return winningFeatureIds.size === 1 ? matches[0] : null;
}

function hasConflictingFeatureSubject(sourceSpans, matchedFeature, profile, target) {
  const ownTerms = usableFeatureTerms(matchedFeature.feature);
  return sourceSpans.some((span) => {
    const spanText = String(span?.text || "");
    if (!spanText) return false;
    const withoutOwnTerms = removeLiteralTerms(spanText, ownTerms);
    const otherFeature = matchCharacterFeature(withoutOwnTerms, profile, target);
    if (otherFeature && otherFeature.featureId !== matchedFeature.featureId) return true;
    if (LIMBS_PATTERN.test(withoutOwnTerms)) return true;
    if (BODY_SUBJECT_PATTERN.test(withoutOwnTerms)) return true;
    return BODY_CONTACT_PATTERN.test(withoutOwnTerms)
      && ENVIRONMENT_SUPPORT_PATTERN.test(withoutOwnTerms)
      && !PROP_RELATION_PATTERN.test(withoutOwnTerms);
  });
}

function removeLiteralTerms(text, terms) {
  return [...terms]
    .sort((left, right) => right.length - left.length)
    .reduce((result, term) => result.split(term).join(""), String(text || ""));
}

function getCharacterFeatures(profile, target) {
  if (!profile || !Array.isArray(profile.characters)) return [];
  const idMatches = profile.characters.filter((character) => (
    character.characterId === target.characterId
  ));
  if (idMatches.length === 1) {
    return Array.isArray(idMatches[0].features) ? idMatches[0].features : [];
  }
  if (idMatches.length > 1) return [];
  if (target.characterLabelUniqueInFrame === false) return [];
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
  if (normalizeText(left.groundedText) === normalizeText(right.groundedText)) return false;
  const combined = `${left.groundedText}，${right.groundedText}`;
  return !MUTUALLY_EXCLUSIVE_PAIRS.some(([first, second]) => (
    combined.includes(first) && combined.includes(second)
  ));
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
    ))
  ) {
    return "STATE_SLOT_BINDING_MISMATCH";
  }
  if (patch.value !== patch.visibleFacts.join("，")) return "NON_DETERMINISTIC_FINAL_TEXT";
  if (!patch.value.trim() && target.field !== "actionState") return "EMPTY_REQUIRED_FIELD";
  if (containsStaticFrameViolation(patch.value)) return "NON_STATIC_LANGUAGE_REMAINS";
  if (target.field === "handPropState" && slots.some((slot) => slot.primaryDimensionKey === "bodyContact")) {
    return "HAND_PROP_CANNOT_COUNT_AS_BODY_CONTACT";
  }
  if (MUTUALLY_EXCLUSIVE_PAIRS.some(([first, second]) => (
    patch.value.includes(first) && patch.value.includes(second)
  ))) {
    return "MUTUALLY_EXCLUSIVE_STATE";
  }
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
  if (character[target.field] !== patch.value) {
    return "APPLIED_VALUE_MISMATCH";
  }
  if (!patch.value.trim() && target.field !== "actionState") {
    return "EMPTY_REQUIRED_FIELD";
  }
  if (containsStaticFrameViolation(patch.value)) {
    return "NON_STATIC_LANGUAGE_REMAINS";
  }
  if (
    target.field === "handPropState"
    && (!HAND_SUBJECT_PATTERN.test(patch.value) || !PROP_RELATION_PATTERN.test(patch.value))
  ) {
    return "HAND_PROP_FIELD_DUTY_MISMATCH";
  }
  if (MUTUALLY_EXCLUSIVE_PAIRS.some(([first, second]) => (
    patch.value.includes(first) && patch.value.includes(second)
  ))) {
    return "MUTUALLY_EXCLUSIVE_STATE";
  }
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

function inferReasonCode(text) {
  for (const [reasonCode, pattern] of Object.entries(REASON_TRIGGER_PATTERNS)) {
    if (pattern.test(String(text || ""))) return reasonCode;
  }
  return "temporal_process";
}

function authorizedSourceFields(targetField) {
  if (targetField === "pose") return ["pose", "bodyOrientation", "gaze"];
  if (targetField === "handPropState") return ["handPropState"];
  return ["actionState"];
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
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()[\]{}《》〈〉·—…-]/gu, "")
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
