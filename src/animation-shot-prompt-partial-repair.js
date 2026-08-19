import {
  VIDEO_PROMPT_PROFILE_IDS,
  assertVideoPromptProfile
} from "../public/video-prompt-profiles.js";
import {
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
  artifactPartialRepairPrompt,
  createArtifactPartialRepairPlan,
  mergeArtifactPartialRepair
} from "./artifact-partial-repair.js";
import {
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES,
  MiniMaxH3PromptError,
  assertMiniMaxH3BasePrompt,
  miniMaxH3DialogueEntries,
  miniMaxH3DialogueTexts,
  splitMiniMaxH3Sentences
} from "./minimax-h3-prompt.js";
import {
  OutputContractError,
  ensureAnimationPlanDirectShotContract
} from "./validation.js";

export const ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_SCHEMA_VERSION =
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION;
export const ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_MAX_ATTEMPTS = 1;

const repairableCodes = new Set([
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PROMPT_REQUIRED,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PREFIX_FORBIDDEN,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTION_EMPTY,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.LANGUAGE_INVALID,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_START_REQUIRED,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_FIRST_TIMESTAMP_FORBIDDEN,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_SEQUENCE_INVALID,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_REQUIRED,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_OUT_OF_RANGE,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.REFERENCE_LABEL_FORBIDDEN,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_TAG_INVALID,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_UNAUTHORIZED,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_COUNT_MISMATCH,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_MISSING,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_ORDER_MISMATCH,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SPEAKER_ID_MISSING,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.MUSIC_ABSTRACT_MOOD
]);

// 只有"签发对白存在、但 <d> 块数量不足"这一种情形，才允许在 integrated 正文内插入对白。
// 其余对白类诊断（改写、越权、顺序错）都可能牵动既有正文，仍旧 fail closed。
const dialogueInsertionCodes = new Set([
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_COUNT_MISMATCH,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_MISSING,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SPEAKER_ID_MISSING,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_ORDER_MISMATCH
]);

export const animationShotPromptPartialRepairAdapter = Object.freeze({
  id: "animationPlan/minimax-h3-base-prompt/1.0",
  // One provider correction call may repair several independently diagnosed
  // prompt strings. Each target is still exactly one shot.videoPrompt.
  maxTargets: 12,

  selectTargets({ candidate, diagnostics, context }) {
    if (Number(context.repairAttemptCount || 0) !== 0) return null;
    if (candidate.promptSchemaVersion !== "3.0") return null;
    if (candidate.productionStrategy?.format !== "direct_shot_video") return null;

    const profile = trustedMiniMaxH3Profile(candidate);
    if (!profile) return null;
    if (!isSignedRepairBoundary(context.visualGuardrails?.fixedCharacterBoundary)) return null;
    if (!Array.isArray(diagnostics) || !diagnostics.length) return null;

    const located = diagnostics.map((detail) => ({
      detail,
      target: trustedPromptTarget(detail, candidate)
    }));
    if (located.some(({ target }) => !target)) return null;
    const byShotIndex = new Map();
    located.forEach(({ detail, target }) => {
      const group = byShotIndex.get(target.shotIndex) || [];
      group.push(detail);
      byShotIndex.set(target.shotIndex, group);
    });

    const drafts = [...byShotIndex.entries()].map(([shotIndex, targetDiagnostics]) => {
      const shot = candidate.shotPlan[shotIndex];
      if (!isRecord(shot)) return null;
      // Animation Plan's signed H3 production subset is 4–6 seconds. Prompt
      // repair must never turn an incompatible 3-second Plan into an H3 Plan.
      if (!Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 4 || shot.durationSeconds > 6) {
        return null;
      }
      const authoritativeSourceScene = findAuthoritativeSourceScene(
        context.fullStory,
        shot.sourceSceneId
      );
      if (!authoritativeSourceScene) return null;

      const path = `/shotPlan/${shotIndex}/videoPrompt`;
      const candidateShotFacts = omitKey(shot, "videoPrompt");
      const dialogueTexts = miniMaxH3DialogueTexts(shot.dialogueOrSubtitle);
      const preservedSections = preservableCurrentSections(
        shot.videoPrompt,
        targetDiagnostics,
        shot.durationSeconds,
        dialogueTexts
      );
      // A prompt-only repair may never receive authority to rewrite the
      // visual/action story body. If the existing integrated section cannot
      // independently pass the deterministic H3 checks, this diagnostic is
      // not safely repairable by the local adapter and must fail closed.
      //
      // 唯一例外：正文结构本身完好，只是漏写了签发对白的 <d> 块。实测这一种占
      // 全部带对白镜头的 53%，且已解析候选按契约不得整批重写，否则毫无恢复路径。
      // 此时不冻结整段，改为句级冻结 —— 只允许在原有句子内插入对白，其余逐字不变。
      let dialogueInsertion = null;
      if (!preservedSections.integrated_multimodal_description) {
        const currentBlocks = (String(shot.videoPrompt || "").match(/<d>/gu) || []).length;
        const insertionOnly = targetDiagnostics.every(
          (detail) => dialogueInsertionCodes.has(String(detail.code || ""))
        );
        // 两种可修形态各用一个探针确认"正文除对白/说话人外结构完好"：
        //   缺 <d>          → 把对白约束摘掉再验；
        //   <d> 齐全缺 ID   → 临时注入 (S1) 再验。
        // 探针只用于判定，冻结句子仍取自原文。
        // 顺序错时按 prompt 的实际顺序做探针，同时注入 (S1) 顺带覆盖缺 ID 的情形。
        // 但必须先确认两边是同一组对白（多重集相等），否则那是改写内容而不是换顺序。
        const promptBodies = h3DialogueBodies(shot.videoPrompt);
        const sameUtterances = promptBodies.length === dialogueTexts.length
          && [...promptBodies].sort().join("\u0000") === [...dialogueTexts].sort().join("\u0000");
        if (currentBlocks === dialogueTexts.length && !sameUtterances) return null;
        const probe = currentBlocks < dialogueTexts.length
          ? { prompt: shot.videoPrompt, texts: [] }
          : { prompt: String(shot.videoPrompt || "").replace(/<d>/gu, "(S1) <d>"), texts: promptBodies };
        const structural = preservableCurrentSections(
          probe.prompt,
          targetDiagnostics,
          shot.durationSeconds,
          probe.texts
        );
        if (!structural.integrated_multimodal_description
          || !insertionOnly
          || !dialogueTexts.length
          || currentBlocks > dialogueTexts.length) {
          return null;
        }
        const entries = miniMaxH3DialogueEntries(shot.dialogueOrSubtitle);
        dialogueInsertion = {
          frozenSentences: splitMiniMaxH3Sentences(h3IntegratedBody(shot.videoPrompt)),
          allowedSpeakerIds: [...new Set(entries.map((entry) => entry.speakerId))],
          utterances: entries.map((entry) => ({ speakerId: entry.speakerId, text: entry.text }))
        };
      }
      return {
        path,
        targetLabel: `${String(shot.shotId || `shotPlan[${shotIndex}]`)} videoPrompt`,
        diagnostics: targetDiagnostics.map((detail) => ({
          code: String(detail.code),
          path,
          reason: String(detail.reason),
          expected: structuredClone(detail.expected),
          actual: structuredClone(detail.actual)
        })),
        mutablePointers: [path],
        allowedReplacementKinds: ["string"],
        repairInstruction: [
          "Rewrite the complete MiniMax H3 Base/T2VA prompt string only.",
          "Use exactly integrated_multimodal_description, overall_soundscape, non_diegetic_music once each in that order.",
          "Start each of the three fixed section names at the beginning of its own new line; in the JSON replacement string use \\n between sections and never place two section names on one line.",
          "Treat authoritativeSourceScene and the signed locks as authoritative; preserve the candidate shot fields unless they conflict with that authority.",
          "Keep candidateShotFacts.dialogueOrSubtitle as plain signed story data; preserve each extracted original-language utterance verbatim in an integrated <d>[Chinese] ...</d> block without translation or transliteration.",
          ...(Object.keys(preservedSections).length
            ? ["Keep every modelContext.preservedSections body byte-for-byte after trimming; only add or repair the other required sections."]
            : []),
          ...(dialogueInsertion
            ? ["This target only needs its signed dialogue restored. For each modelContext.dialogueInsertion.utterances entry, write the official sentence form inside the sentence where that character vocalizes: <identity phrase> (S1) says: <d>[Chinese] text</d>. The speaker ID belongs OUTSIDE the tags — never write (S1) inside <d>...</d>. The content between <d>[Chinese] and </d> must equal utterances[].text verbatim with nothing added or removed. Every other sentence of integrated_multimodal_description must stay byte-for-byte identical, the sentence count must not change, and only IDs listed in modelContext.dialogueInsertion.allowedSpeakerIds may appear."]
            : []),
          "Do not change duration or add Plan-stage reference labels."
        ].join(" "),
        modelContext: {
          authoritativeSourceScene,
          candidateShotFacts,
          preservedSections,
          ...(dialogueInsertion ? { dialogueInsertion } : {}),
          foundationLocks: buildFoundationLocks(candidate, shot, candidateShotFacts)
        },
        adapterState: {
          shotIndex,
          shotId: String(shot.shotId || ""),
          durationSeconds: shot.durationSeconds,
          dialogueTexts,
          preservedSections,
          dialogueInsertion
        }
      };
    });
    return drafts.some((draft) => !draft) ? null : drafts;
  },

  buildAuthority({ candidate, targets, context }) {
    return buildH3RepairAuthority(candidate, targets, context);
  },

  validateAuthority({ candidate, authority, targets, context, helpers }) {
    const current = buildH3RepairAuthority(candidate, targets, context);
    return helpers.contentDigest(current) === helpers.contentDigest(authority);
  },

  authorizeReplacement({ target, replacement }) {
    try {
      const parsed = assertMiniMaxH3BasePrompt(replacement, {
        durationSeconds: target.adapterState.durationSeconds,
        path: target.path,
        dialogueTexts: target.adapterState.dialogueTexts
      });
      for (const [sectionName, expectedBody] of Object.entries(
        target.adapterState?.preservedSections || {}
      )) {
        if (parsed.sections?.[sectionName] !== expectedBody) {
          throw new OutputContractError(
            `H3 局部纠错不得改写已合法的 ${sectionName} 正文`
          );
        }
      }
      assertDialogueInsertionOnly(target, parsed);
    } catch (error) {
      if (error instanceof MiniMaxH3PromptError) {
        throw new OutputContractError(error.message, error.details);
      }
      throw error;
    }
    return true;
  },

  validateMerged({ candidate }) {
    ensureAnimationPlanDirectShotContract(candidate);
    return true;
  }
});

/**
 * Plan one bounded provider call for one or more independently located MiniMax
 * H3 shot.videoPrompt strings. Every target remains an exact string leaf; an
 * untrusted message, duration mismatch, or non-H3 profile is not repairable.
 */
export function planAnimationShotPromptPartialRepair(candidate, error, {
  repairAttemptCount = 0,
  fullStory = null,
  visualGuardrails = null
} = {}) {
  return createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: Array.isArray(error?.details) ? error.details : [],
    adapter: animationShotPromptPartialRepairAdapter,
    context: { repairAttemptCount, fullStory, visualGuardrails }
  });
}

export function animationShotPromptPartialRepairPrompt(plan) {
  return artifactPartialRepairPrompt(plan, {
    additionalRules: [
      "replacement 必须是一个完整的英文 MiniMax H3 Base prompt 字符串，不能是对象、数组或 JSON Patch。",
      "三个 section 的固定名称必须各自从新行行首开始；replacement 作为 JSON 字符串时必须用 \\n 分隔 integrated_multimodal_description、overall_soundscape、non_diegetic_music，绝不能把两个段名写在同一行。",
      "三个 section 的正文使用英文；candidateShotFacts.dialogueOrSubtitle 保持纯剧情对白，只有 integrated 中 <d>[Chinese] ...</d> 包装的逐字签发对白和英文双引号内的可见文字可保留原语言。",
      "[Shot 1] 不带时间戳；后续内部 [Shot N] 的 At MM:SS.mmm 必须严格递增且小于 durationSeconds。",
      "以 authoritativeSourceScene、fixedCharacterBoundary 与 Foundation/Profile 锁为权威，并保留 candidateShotFacts 中不冲突的动作顺序、可见终点、摄影顺序、声音、连续性、验收条件和全部对白。",
      "不得生成 <Subject N>、<Picture N>、<Video N> 或 <Audio N>，不得改变任何 Foundation/Profile 锁。"
    ]
  });
}

export function mergeAnimationShotPromptPartialRepair(
  candidate,
  envelope,
  plan,
  { fullStory = null, visualGuardrails = null } = {}
) {
  return mergeArtifactPartialRepair({
    candidate,
    envelope,
    plan,
    adapter: animationShotPromptPartialRepairAdapter,
    context: { repairAttemptCount: 0, fullStory, visualGuardrails }
  });
}

// 只缺对白时 integrated 整段没被冻结，改由句级冻结兜底：句数不得变化，
// 发生变化的句子数不得超过签发对白条数，且每条变化必须确实是为了插入对白
// （含 <d>，且只能使用服务端指派的说话人 ID）。其余句子逐字不变，
// 模型无法借"补对白"之名改写可见动作、道具或摄影描述。
function h3DialogueBodies(videoPrompt) {
  return [...String(videoPrompt || "").matchAll(/<d>\[[^\]]*\]\s*([\s\S]*?)<\/d>/gu)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function h3IntegratedBody(videoPrompt) {
  const match = String(videoPrompt || "").match(
    /^integrated_multimodal_description:[ \t]*([\s\S]*?)(?=\n(?:overall_soundscape|non_diegetic_music):|$)/mu
  );
  return match ? match[1].trim() : "";
}

function assertDialogueInsertionOnly(target, parsed) {
  const insertion = target.adapterState?.dialogueInsertion;
  if (!insertion) return;
  const before = insertion.frozenSentences || [];
  const after = splitMiniMaxH3Sentences(parsed.sections?.integrated_multimodal_description);
  if (after.length !== before.length) {
    throw new OutputContractError(
      `H3 对白补写不得增删 integrated_multimodal_description 的句子：原 ${before.length} 句，现 ${after.length} 句`
    );
  }
  const changed = [];
  after.forEach((sentence, index) => {
    if (sentence !== before[index]) changed.push(index);
  });
  if (!changed.length) {
    throw new OutputContractError("H3 对白补写未在任何句子中插入 <d> 对白块");
  }
  const allowedChanges = (insertion.utterances || []).length;
  if (changed.length > allowedChanges) {
    throw new OutputContractError(
      `H3 对白补写最多允许 ${allowedChanges} 个句子发生变化，当前 ${changed.length} 个`
    );
  }
  const allowed = new Set(insertion.allowedSpeakerIds || []);
  for (const index of changed) {
    const sentence = after[index];
    if (!sentence.includes("<d>")) {
      throw new OutputContractError(
        `H3 对白补写改写了与对白无关的句子：${before[index]}`
      );
    }
    for (const speakerId of sentence.match(/\(S\d+(?:\s*,\s*S\d+)*\)/gu) || []) {
      if (!allowed.has(speakerId)) {
        throw new OutputContractError(
          `H3 对白补写使用了未指派的说话人 ID ${speakerId}；服务端指派为 ${[...allowed].join("、")}`
        );
      }
    }
  }
}

function buildH3RepairAuthority(candidate, targets, context) {
  const sourceSceneLocks = targets.map((target) => {
    const shotIndex = Number(target.adapterState?.shotIndex);
    const shot = candidate?.shotPlan?.[shotIndex];
    const sourceScene = findAuthoritativeSourceScene(context.fullStory, shot?.sourceSceneId);
    return {
      shotId: String(shot?.shotId || ""),
      sourceScene
    };
  });
  return {
    profileLock: structuredClone(trustedMiniMaxH3Profile(candidate)),
    fixedCharacterBoundary: projectFixedCharacterBoundary(
      context.visualGuardrails?.fixedCharacterBoundary
    ),
    sourceSceneLocks,
    maximumRepairAttempts: ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_MAX_ATTEMPTS
  };
}

function findAuthoritativeSourceScene(fullStory, sourceSceneId) {
  const sourceId = String(sourceSceneId || "").trim();
  const matches = (Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : [])
    .filter((scene) => String(scene?.sceneId || "").trim() === sourceId);
  if (!sourceId || matches.length !== 1 || !isRecord(matches[0])) return null;
  const scene = matches[0];
  return {
    sceneId: String(scene.sceneId || ""),
    location: String(scene.location || ""),
    characters: Array.isArray(scene.characters) ? scene.characters.map(String) : [],
    visibleAction: String(scene.visibleAction || ""),
    dialogue: structuredClone(scene.dialogue ?? ""),
    shotAndSound: structuredClone(scene.shotAndSound ?? ""),
    shootingNotes: String(scene.shootingNotes || "")
  };
}

function projectFixedCharacterBoundary(boundary) {
  if (!isRecord(boundary)) return null;
  return {
    characterName: String(boundary.characterName || ""),
    canonicalDescription: String(boundary.canonicalDescription || ""),
    bodyForm: String(boundary.bodyForm || ""),
    requiredTraits: structuredClone(boundary.requiredTraits || []),
    forbiddenTraits: structuredClone(boundary.forbiddenTraits || []),
    sourceDigest: String(boundary.sourceDigest || ""),
    boundaryDigest: String(boundary.boundaryDigest || ""),
    boundarySignature: String(boundary.boundarySignature || "")
  };
}

function isSignedRepairBoundary(boundary) {
  return Boolean(
    isRecord(boundary)
    && String(boundary.characterName || "").trim()
    && String(boundary.sourceDigest || "").trim()
    && String(boundary.boundaryDigest || "").trim()
    && String(boundary.boundarySignature || "").trim()
    && Array.isArray(boundary.requiredTraits)
    && Array.isArray(boundary.forbiddenTraits)
  );
}

function preservableCurrentSections(prompt, diagnostics, durationSeconds, dialogueTexts) {
  if (!Array.isArray(diagnostics) || !diagnostics.length) return {};
  const source = String(prompt || "");
  const headingPattern = /^(integrated_multimodal_description|overall_soundscape|non_diegetic_music):[ \t]*/gmu;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(source))) {
    headings.push({ name: match[1], start: match.index, bodyStart: headingPattern.lastIndex });
  }
  const uniqueBodies = new Map();
  for (const sectionName of [
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music"
  ]) {
    const matches = headings.filter((heading) => heading.name === sectionName);
    if (matches.length !== 1) continue;
    const heading = matches[0];
    const headingIndex = headings.indexOf(heading);
    const end = headings[headingIndex + 1]?.start ?? source.length;
    const body = source.slice(heading.bodyStart, end).trim();
    const containsReservedHeadingToken = [
      "integrated_multimodal_description:",
      "overall_soundscape:",
      "non_diegetic_music:"
    ].some((token) => body.includes(token));
    if (body && !containsReservedHeadingToken) uniqueBodies.set(sectionName, body);
  }

  const preserved = {};
  for (const [sectionName, body] of uniqueBodies) {
    const synthetic = {
      integrated_multimodal_description: "[Shot 1] A neutral visible action holds steadily.",
      overall_soundscape: "N/A",
      non_diegetic_music: "N/A",
      [sectionName]: body
    };
    try {
      assertMiniMaxH3BasePrompt([
        `integrated_multimodal_description: ${synthetic.integrated_multimodal_description}`,
        `overall_soundscape: ${synthetic.overall_soundscape}`,
        `non_diegetic_music: ${synthetic.non_diegetic_music}`
      ].join("\n"), {
        durationSeconds,
        path: "videoPrompt",
        dialogueTexts: sectionName === "integrated_multimodal_description"
          ? dialogueTexts
          : []
      });
      preserved[sectionName] = body;
    } catch {
      // The section itself participates in the diagnosed error and therefore
      // cannot be frozen. Other independently valid sections remain locked.
    }
  }
  return preserved;
}

function trustedMiniMaxH3Profile(candidate) {
  let profile;
  try {
    profile = assertVideoPromptProfile(candidate?.productionStrategy?.videoPromptProfile);
  } catch {
    return null;
  }
  return profile.profileId === VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3 ? profile : null;
}

function trustedPromptTarget(detail, candidate) {
  if (!isRecord(detail) || !repairableCodes.has(String(detail.code || ""))) return null;
  if (!Object.prototype.hasOwnProperty.call(detail, "expected")
    || !Object.prototype.hasOwnProperty.call(detail, "actual")
    || !String(detail.reason || "").trim()) {
    return null;
  }
  const jsonPointer = canonicalJsonPointer(detail.jsonPointer);
  if (!jsonPointer) return null;
  if (detail.path !== undefined && canonicalJsonPointer(detail.path) !== jsonPointer) return null;
  const tokens = pointerTokens(jsonPointer);
  if (tokens[0] === "animationPlan") tokens.shift();
  if (tokens.length !== 3
    || tokens[0] !== "shotPlan"
    || !isArrayIndex(tokens[1])
    || tokens[2] !== "videoPrompt") {
    return null;
  }
  const shotIndex = Number(tokens[1]);
  if (!isRecord(candidate?.shotPlan?.[shotIndex])) return null;
  return { shotIndex };
}

function buildFoundationLocks(candidate, shot, exactShotFacts) {
  const factText = JSON.stringify(exactShotFacts);
  const characterReferences = Array.isArray(candidate.characterReferencePrompts)
    ? candidate.characterReferencePrompts.filter((reference) => {
      const name = String(reference?.characterName || "").trim();
      return name && factText.includes(name);
    })
    : [];
  // Pronoun-only shot facts cannot identify a safe subset. In that legal case,
  // retain all Foundation character locks rather than guess the visible role.
  const safeCharacterReferences = characterReferences.length
    ? characterReferences
    : (Array.isArray(candidate.characterReferencePrompts) ? candidate.characterReferencePrompts : []);
  const sceneReference = Array.isArray(candidate.sceneReferencePrompts)
    ? candidate.sceneReferencePrompts.find((reference) => (
      String(reference?.sceneId || "") === String(shot.sceneId || "")
    )) || null
    : null;
  const assetReferences = Array.isArray(candidate.assetPrompts)
    ? candidate.assetPrompts.filter((asset) => {
      const name = String(asset?.assetName || "").trim();
      return name && factText.includes(name);
    })
    : [];
  return {
    targetAspectRatio: String(candidate.productionStrategy?.targetAspectRatio || ""),
    visualBible: structuredClone(candidate.visualBible || {}),
    characterReferencePrompts: structuredClone(safeCharacterReferences),
    sceneReferencePrompt: structuredClone(sceneReference),
    assetPrompts: structuredClone(assetReferences)
  };
}

function canonicalJsonPointer(value) {
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

function omitKey(value, keyToOmit) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToOmit));
}

function isArrayIndex(value) {
  return /^(?:0|[1-9]\d*)$/u.test(String(value || ""));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
