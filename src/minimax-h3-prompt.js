import { createHash } from "node:crypto";

export const MINIMAX_H3_BASE_SECTION_NAMES = Object.freeze([
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music"
]);

export const MINIMAX_H3_REF2VA_SECTION_NAMES = Object.freeze([
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music"
]);

export const MINIMAX_H3_BASE_DIAGNOSTIC_CODES = Object.freeze({
  PROMPT_REQUIRED: "MINIMAX_H3_BASE_PROMPT_REQUIRED",
  DURATION_INVALID: "MINIMAX_H3_DURATION_INVALID",
  SECTIONS_INVALID: "MINIMAX_H3_BASE_SECTIONS_INVALID",
  PREFIX_FORBIDDEN: "MINIMAX_H3_BASE_PREFIX_FORBIDDEN",
  SECTION_EMPTY: "MINIMAX_H3_BASE_SECTION_EMPTY",
  LANGUAGE_INVALID: "MINIMAX_H3_BASE_LANGUAGE_INVALID",
  TIMELINE_START_REQUIRED: "MINIMAX_H3_BASE_TIMELINE_START_REQUIRED",
  TIMELINE_FIRST_TIMESTAMP_FORBIDDEN: "MINIMAX_H3_BASE_TIMELINE_FIRST_TIMESTAMP_FORBIDDEN",
  TIMELINE_SEQUENCE_INVALID: "MINIMAX_H3_BASE_TIMELINE_SEQUENCE_INVALID",
  TIMELINE_TIMESTAMP_REQUIRED: "MINIMAX_H3_BASE_TIMELINE_TIMESTAMP_REQUIRED",
  TIMELINE_TIMESTAMP_OUT_OF_RANGE: "MINIMAX_H3_BASE_TIMELINE_TIMESTAMP_OUT_OF_RANGE",
  REFERENCE_LABEL_FORBIDDEN: "MINIMAX_H3_BASE_REFERENCE_LABEL_FORBIDDEN",
  DIALOGUE_TAG_INVALID: "MINIMAX_H3_BASE_DIALOGUE_TAG_INVALID",
  DIALOGUE_UNAUTHORIZED: "MINIMAX_H3_BASE_DIALOGUE_UNAUTHORIZED",
  DIALOGUE_COUNT_MISMATCH: "MINIMAX_H3_BASE_DIALOGUE_COUNT_MISMATCH",
  DIALOGUE_MISSING: "MINIMAX_H3_BASE_DIALOGUE_MISSING",
  DIALOGUE_ORDER_MISMATCH: "MINIMAX_H3_BASE_DIALOGUE_ORDER_MISMATCH",
  SPEAKER_ID_MISSING: "MINIMAX_H3_BASE_SPEAKER_ID_MISSING",
  MUSIC_ABSTRACT_MOOD: "MINIMAX_H3_BASE_MUSIC_ABSTRACT_MOOD"
});

export class MiniMaxH3PromptError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "MiniMaxH3PromptError";
    this.details = Array.isArray(details) ? details : [];
  }
}

export function assertMiniMaxH3Duration(value, path = "durationSeconds") {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throwMiniMaxH3PromptError(
      `${path} 使用 MiniMax H3 时必须是 4–15 秒整数，不能静默改写时长。`,
      {
        code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DURATION_INVALID,
        jsonPointer: miniMaxH3PathToJsonPointer(path),
        reason: "MiniMax H3 duration must be an integer from 4 through 15 seconds and must not be clamped.",
        expected: { type: "integer", minimum: 4, maximum: 15 },
        actual: diagnosticValue(value)
      }
    );
  }
  return duration;
}

export function assertMiniMaxH3BasePrompt(text, {
  durationSeconds,
  path = "videoPrompt",
  dialogueTexts = []
} = {}) {
  const promptPointer = miniMaxH3PathToJsonPointer(path);
  const prompt = requirePromptText(text, path, {
    code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PROMPT_REQUIRED,
    jsonPointer: promptPointer,
    reason: "MiniMax H3 Base prompt must be a non-empty string.",
    expected: "non-empty string",
    actual: describePromptValue(text)
  });
  const duration = assertMiniMaxH3Duration(
    durationSeconds,
    siblingJsonPointer(promptPointer, "durationSeconds")
  );
  const sections = parseExactSections(prompt, MINIMAX_H3_BASE_SECTION_NAMES, path, {
    jsonPointer: promptPointer,
    sequenceCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID,
    prefixCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PREFIX_FORBIDDEN,
    emptyCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTION_EMPTY
  });
  assertEnglishSections(prompt, path, {
    code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.LANGUAGE_INVALID,
    jsonPointer: promptPointer
  });
  assertShotTimeline(
    sections.integrated_multimodal_description,
    duration,
    `${path}.integrated_multimodal_description`,
    {
      jsonPointer: promptPointer,
      startCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_START_REQUIRED,
      firstTimestampCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_FIRST_TIMESTAMP_FORBIDDEN,
      sequenceCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_SEQUENCE_INVALID,
      timestampRequiredCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_REQUIRED,
      timestampRangeCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_OUT_OF_RANGE
    }
  );
  const referenceLabels = [...prompt.matchAll(/<(?:Subject|Picture|Video|Audio)\s+\d+>/gu)]
    .map((match) => match[0]);
  if (referenceLabels.length) {
    throwMiniMaxH3PromptError(
      `${path} 是 Plan 阶段的 H3 T2VA 基础提示词，不得提前生成尚未绑定的参考素材标签。`,
      {
        code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.REFERENCE_LABEL_FORBIDDEN,
        jsonPointer: promptPointer,
        reason: "Plan-stage Base prompt cannot contain reference labels before actual media is frozen and bound.",
        expected: [],
        actual: referenceLabels
      }
    );
  }
  assertDialoguePreserved(prompt, dialogueTexts, path, {
    jsonPointer: promptPointer,
    tagCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_TAG_INVALID,
    unauthorizedCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_UNAUTHORIZED,
    countCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_COUNT_MISMATCH,
    missingCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_MISSING,
    orderCode: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_ORDER_MISMATCH
  });
  assertSpeakerIdsBound(
    sections.integrated_multimodal_description,
    `${path}.integrated_multimodal_description`,
    promptPointer
  );
  assertNonDiegeticMusicIsSoundDesign(
    sections.non_diegetic_music,
    `${path}.non_diegetic_music`,
    promptPointer
  );
  return Object.freeze({
    prompt,
    sectionNames: MINIMAX_H3_BASE_SECTION_NAMES,
    sections: Object.freeze(sections)
  });
}

export function assertMiniMaxH3Ref2VAPrompt(text, {
  durationSeconds,
  path = "effectiveVideoPrompt",
  dialogueTexts = [],
  ordinaryReferenceOnly = true
} = {}) {
  const prompt = requirePromptText(text, path);
  const duration = assertMiniMaxH3Duration(durationSeconds, `${path}.durationSeconds`);
  const sections = parseExactSections(prompt, MINIMAX_H3_REF2VA_SECTION_NAMES, path);
  assertEnglishSections(prompt, path);
  assertShotTimeline(sections.detailed_description, duration, `${path}.detailed_description`);
  assertReferenceLabelsClosed(sections, path);
  assertRetentionAnalysisContract(sections, path);
  assertDialoguePreserved(prompt, dialogueTexts, path);
  if (ordinaryReferenceOnly) {
    const summary = sections.summary.toLowerCase();
    for (const forbiddenTask of ["video editing", "video continuation", "keyframe completion", "audio reuse"]) {
      if (summary.includes(forbiddenTask)) {
        throw new MiniMaxH3PromptError(
          `${path}.summary 把普通参考素材升级成了 ${forbiddenTask}；当前 all_reference 请求没有该业务授权。`
        );
      }
    }
    if (!/^\[reference generation(?: \+ audio reference)?\]/iu.test(sections.summary.trim())) {
      throw new MiniMaxH3PromptError(
        `${path}.summary 必须以 [reference generation] 或 [reference generation + audio reference] 开头。`
      );
    }
  }
  return Object.freeze({
    prompt,
    sectionNames: MINIMAX_H3_REF2VA_SECTION_NAMES,
    sections: Object.freeze(sections)
  });
}

export function assertMiniMaxH3OrdinaryReferencePolicy(parsed, manifest, {
  path = "effectiveVideoPrompt"
} = {}) {
  const sections = parsed?.sections;
  if (!sections || typeof sections !== "object") {
    throw new MiniMaxH3PromptError(`${path} 缺少已验证的 Ref2VA sections。`);
  }
  const contentItems = Array.isArray(manifest?.contentItems) ? manifest.contentItems : [];
  const expectedSummaryPrefix = contentItems.some((item) => item.mediaType === "audio")
    ? "reference generation + audio reference"
    : "reference generation";
  const actualSummaryPrefix = String(sections.summary || "").trim().match(/^\[([^\]]+)\]/u)?.[1] || "";
  if (actualSummaryPrefix !== expectedSummaryPrefix) {
    throw new MiniMaxH3PromptError(
      `${path}.summary 必须与实际素材一致，以 [${expectedSummaryPrefix}] 开头；当前为 [${actualSummaryPrefix || "空"}]。`
    );
  }

  const definitions = parseDefinitionEntries(sections.subject_definitions, `${path}.subject_definitions`);
  const retention = parseRetentionEntries(sections.retention_analysis, `${path}.retention_analysis`);
  const itemByPhysicalLabel = new Map(contentItems.map((item) => [
    `<${item.mediaType === "image" ? "Picture" : item.mediaType === "video" ? "Video" : "Audio"} ${item.ordinalWithinMediaType}>`,
    item
  ]));
  const definitionLabels = new Set(definitions.map((definition) => definition.label));
  for (const [label, item] of itemByPhysicalLabel) {
    if (item.mediaType === "audio" && !definitionLabels.has(label)) {
      throw new MiniMaxH3PromptError(
        `${path}.subject_definitions 必须单独定义真实音频 ${label}，并在 retention_analysis 使用 reference 或 weak_reference。`
      );
    }
  }

  for (const definition of definitions) {
    const relationship = retention.get(definition.label)?.marker;
    const referencedItems = [...definition.text.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/gu)]
      .map((match) => itemByPhysicalLabel.get(match[0]))
      .filter(Boolean);
    assertNoUnauthorizedOrdinaryRole(definition, path);

    if (definition.kind === "Audio") {
      if (!["reference", "weak_reference"].includes(relationship)) {
        throw new MiniMaxH3PromptError(
          `${path}.retention_analysis 的 ${definition.label} 只允许 reference 或 weak_reference；普通音频未授权复制信号。`
        );
      }
      continue;
    }
    if (definition.kind === "Picture" || definition.kind === "Video") {
      if (definition.kind === "Picture") {
        throw new MiniMaxH3PromptError(
          `${path}.subject_definitions 的普通 ${definition.label} 不得单独定义；当前请求未授权首帧、尾帧、关键帧或 storyboard anchor，应只在对应的 <Subject N> 中引用来源。`
        );
      }
      if (relationship !== "weak_reference") {
        throw new MiniMaxH3PromptError(
          `${path}.retention_analysis 的普通 ${definition.label} 只允许 weak_reference，不能升级成具体关键帧、编辑源或完整保留。`
        );
      }
      continue;
    }
    if (definition.kind !== "Subject") continue;
    if (!referencedItems.length) {
      throw new MiniMaxH3PromptError(`${path}.subject_definitions 的 ${definition.label} 未绑定任何实际参考素材。`);
    }
    const sources = new Set(referencedItems.map((item) => item.source));
    for (const [label, item] of itemByPhysicalLabel) {
      if (item.mediaType === "image" && definition.text.includes(label)) {
        assertNoConcretePictureUse(sections.detailed_description, label, `${path}.detailed_description`);
      }
    }
    const hasSignedCharacterSource = sources.has("character_reference");
    const hasWeakReferenceSource = [...sources].some((source) => source !== "character_reference");
    if (hasSignedCharacterSource && hasWeakReferenceSource) {
      throw new MiniMaxH3PromptError(
        `${path}.subject_definitions 的 ${definition.label} 混绑了签发角色图与普通上传或上一镜弱参考；必须按素材职责拆成独立 Subject。`
      );
    }
    if (hasSignedCharacterSource) {
      if (relationship !== "fully_preserved") {
        throw new MiniMaxH3PromptError(
          `${path}.retention_analysis 的签发角色 ${definition.label} 必须 fully_preserved，不能弱化其固定身份与外观；当前为 ${relationship || "缺失"}。`
        );
      }
    } else if (relationship !== "weak_reference") {
      throw new MiniMaxH3PromptError(
        `${path}.retention_analysis 的 ${definition.label} 含普通上传或上一镜参考，只允许 weak_reference。`
      );
    }
  }
  for (const [label, item] of itemByPhysicalLabel) {
    if (
      item.mediaType === "image"
      && !definitions.some((definition) => (
        definition.kind === "Subject" && definition.text.includes(label)
      ))
    ) {
      throw new MiniMaxH3PromptError(
        `${path} 未在 subject_definitions 定义真实传入素材 ${label} 对应的 <Subject N>；普通图片只允许作为主体来源，当前请求未授权独立 Picture 锚点。`
      );
    }
  }
  return parsed;
}

export function miniMaxH3DialogueTexts(dialogueOrSubtitle = "") {
  const text = String(dialogueOrSubtitle || "").trim();
  if (!text) return [];
  if (/<\/?d\b[^>]*>/iu.test(text)) {
    throw new MiniMaxH3PromptError(
      "dialogueOrSubtitle 必须保持跨供应商共享的纯剧情对白；<d>[Language] ...</d> 只允许出现在 MiniMax H3 videoPrompt 中。"
    );
  }
  const candidates = text
    .split(/[；;\n]+/u)
    .map((item) => item.replace(/^\s*[^：:]{1,40}[：:]\s*/u, "").trim())
    .filter(Boolean);
  // Repeated lines are still separate signed utterances. Preserve their count
  // and order so the H3 validator cannot collapse two identical dialogue beats
  // into one <d> block.
  return candidates;
}

export function buildMiniMaxH3ContextIrIntent({
  sourcePrompt,
  artifacts = [],
  characterReferences = [],
  shot = {}
} = {}) {
  const prompt = requirePromptText(sourcePrompt, "sourcePrompt");
  const policies = [];
  const imageBoundCharacterNames = new Set(
    (Array.isArray(artifacts) ? artifacts : [])
      .filter((artifact) => String(artifact?.source || "").trim() === "character_reference")
      .map((artifact) => String(artifact?.sourceCharacterName || "").trim())
      .filter(Boolean)
  );
  const mediaCounters = { image: 0, video: 0, audio: 0 };
  for (const artifact of artifacts) {
    const mediaType = String(artifact?.mediaType || "").trim().toLowerCase();
    if (!Object.hasOwn(mediaCounters, mediaType)) continue;
    mediaCounters[mediaType] += 1;
    const label = `${mediaType === "image" ? "Picture" : mediaType === "video" ? "Video" : "Audio"} ${mediaCounters[mediaType]}`;
    const source = String(artifact?.source || "upload").trim();
    const name = String(artifact?.logicalName || artifact?.filename || label).trim();
    if (source === "character_reference") {
      const characterName = String(artifact?.sourceCharacterName || "").trim();
      policies.push(`- ${label} (${name}) is an identity and appearance reference for the signed character${characterName ? ` ${characterName}` : ""} only. Embed ${label} inside that character's dedicated <Subject N> definition; do not create a standalone ${label} definition or retention entry. For this request, ${label} is the sole runtime source of that character's static appearance. Do not repeat static hair, eyes, clothing, body, or style prose from the Base prompt or legacy exact-shot anchors in subject_definitions or detailed_description. Do not spell out, infer, or translate those static details from the picture itself either; express the bound static appearance only through the dedicated <Subject N> and ${label}. Keep the signed character name, identity, species, and required traits. Keep the signed action, pose, expression, props, scene, camera, sound, and any dynamic appearance change required by the current shot. A <Subject N> defined exclusively by signed character-reference assets must use the exact retention marker fully_preserved. New actions, poses, expressions, camera changes, lighting changes, or backgrounds do not make the signed identity or appearance partially preserved. Do not combine this signed character source with ordinary uploads or previous-shot weak references in the same <Subject N>.`);
    } else if (source === "previous_shot_frame") {
      policies.push(`- ${label} (${name}) is a weak continuity reference sampled from the previous business shot. It is not a source-video edit, continuation, or keyframe. When this image is embedded in a visible <Subject N>, keep that Subject separate from every signed-character Subject and use the exact retention marker weak_reference. Do not copy its background, completed action, props, or framing when they conflict with the current shot.`);
    } else if (mediaType === "audio") {
      policies.push(`- ${label} (${name}) is an ordinary audio reference. It may guide audible characteristics, but its signal is not authorized for direct copy or audio reuse.`);
    } else {
      policies.push(`- ${label} (${name}) is an ordinary weak reference for broad visual guidance. It is not a concrete keyframe, an editing source, or a continuation source. When this source is embedded in a visible <Subject N>, keep that Subject separate from every signed-character Subject and use the exact retention marker weak_reference.`);
    }
  }
  const textAppearanceFallbacks = (Array.isArray(characterReferences) ? characterReferences : [])
    .map((reference) => ({
      characterName: String(reference?.characterName || "").trim(),
      storyRole: String(reference?.storyRole || "").trim(),
      identity: String(reference?.identity || "").trim(),
      appearancePrompt: String(reference?.appearancePrompt || "").trim(),
      consistencyTags: (Array.isArray(reference?.consistencyTags) ? reference.consistencyTags : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    }))
    .filter((reference) => (
      reference.characterName
      && !imageBoundCharacterNames.has(reference.characterName)
    ));
  const dialogue = String(shot.dialogueOrSubtitle || "").trim();
  return [
    "H3_CONTEXT_IR_GROUNDED_REF2VA_V1",
    "Rewrite the signed MiniMax H3 Base prompt below into the official six-section Ref2VA format.",
    "The Animation Plan is authoritative. Do not add, remove, reorder, or replace story actions, characters, locations, props, dialogue, shot duration, or the visible final state.",
    "This is an ordinary reference-generation task, not an editing, continuation, or keyframe-completion task. The only permitted summary task is [reference generation], optionally combined with [audio reference] when an audio input is actually referenced. Physical media are not concrete keyframes, editing sources, or continuation sources; retention markers must still follow the signed-character versus weak-reference policies below. Do not infer audio reuse or direct copying.",
    "Keep every signed-character identity or appearance Subject separate from ordinary-upload and previous-shot weak-reference Subjects. A signed-character-only Subject must be fully_preserved; an ordinary-upload or previous-shot Subject must be weak_reference.",
    "When no signed character-reference image is present for a character, use that character's current signed text appearance from the fallback list below. Only when no current signed character record exists may the signed Base text appearance remain the fallback. This rule is per character and does not authorize copying stale static appearance prose for a character that has a signed image in this request.",
    "Use fixed English section names in this exact order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.",
    `The target business shot lasts exactly ${shot.durationSeconds} seconds. Internal [Shot N] timestamps must be strictly increasing and stay inside that duration; they never create new business shots.`,
    dialogue ? `Preserve this dialogue verbatim in its original language inside <d>[Chinese] ...</d>: ${dialogue}` : "Do not invent dialogue or lyrics.",
    "Reference policies:",
    ...(policies.length ? policies : ["- No usable reference policy was supplied; fail instead of inventing unresolved labels."]),
    "Signed text appearance fallbacks for characters without an image in this request:",
    textAppearanceFallbacks.length
      ? JSON.stringify(textAppearanceFallbacks)
      : "[] (Do not create a character or static appearance from this empty list.)",
    "A fallback record only describes a character already required by the current shot. It never authorizes adding that character to the visible cast.",
    "Signed MiniMax H3 Base prompt:",
    prompt
  ].join("\n");
}

export function buildMiniMaxH3ReferenceManifest(artifacts = []) {
  const counters = { image: 0, video: 0, audio: 0 };
  const contentItems = artifacts.map((artifact, index) => {
    const mediaType = String(artifact?.mediaType || "").trim().toLowerCase();
    if (!Object.hasOwn(counters, mediaType)) {
      throw new MiniMaxH3PromptError(`referenceManifest 第 ${index + 1} 项媒体类型无效：${mediaType || "空"}`);
    }
    counters[mediaType] += 1;
    const sha256 = String(artifact?.sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new MiniMaxH3PromptError(`referenceManifest 第 ${index + 1} 项缺少有效 SHA-256。`);
    }
    return Object.freeze({
      assetId: `reference-${String(index + 1).padStart(2, "0")}`,
      providerContentIndex: index + 1,
      mediaType,
      transportRole: `reference_${mediaType}`,
      ordinalWithinMediaType: counters[mediaType],
      source: String(artifact?.source || "upload").trim() || "upload",
      logicalName: String(artifact?.logicalName || artifact?.filename || `reference-${index + 1}`).trim(),
      byteLength: Number(artifact?.sizeBytes) || 0,
      sha256,
      sourceShotId: String(artifact?.sourceShotId || "").trim(),
      sourceCharacterName: String(artifact?.sourceCharacterName || "").trim()
    });
  });
  const canonical = JSON.stringify(contentItems);
  return Object.freeze({
    schemaVersion: "minimax_h3_reference_manifest/1.0",
    digest: sha256Text(canonical),
    counts: Object.freeze({ ...counters }),
    contentItems: Object.freeze(contentItems)
  });
}

export function sha256Text(value = "") {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function parseExactSections(prompt, expectedNames, path, diagnostic = null) {
  const headingPattern = new RegExp(
    `^(${expectedNames.map(escapeRegExp).join("|")}):[ \\t]*`,
    "gmu"
  );
  const headings = [];
  let match;
  while ((match = headingPattern.exec(prompt))) {
    headings.push({ name: match[1], start: match.index, bodyStart: headingPattern.lastIndex });
  }
  const actualNames = headings.map((item) => item.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throwMiniMaxH3PromptError(
      `${path} 的 H3 段落必须严格按 ${expectedNames.join(" → ")} 各出现一次；当前为 ${actualNames.join(" → ") || "空"}。`,
      diagnostic ? {
        code: diagnostic.sequenceCode,
        jsonPointer: diagnostic.jsonPointer,
        reason: "H3 Base sections must each occur exactly once in the required order.",
        expected: [...expectedNames],
        actual: actualNames
      } : null
    );
  }
  const prefix = prompt.slice(0, headings[0]?.start || 0).trim();
  if (prefix) {
    throwMiniMaxH3PromptError(
      `${path} 在第一个 H3 段落前包含额外文本。`,
      diagnostic ? {
        code: diagnostic.prefixCode,
        jsonPointer: diagnostic.jsonPointer,
        reason: "No prose, Markdown, or wrapper text is allowed before the first H3 Base section.",
        expected: "no prefix before integrated_multimodal_description",
        actual: prefix
      } : null
    );
  }
  const sections = {};
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? prompt.length;
    const body = prompt.slice(heading.bodyStart, end).trim();
    if (!body) {
      throwMiniMaxH3PromptError(
        `${path}.${heading.name} 不能为空。`,
        diagnostic ? {
          code: diagnostic.emptyCode,
          jsonPointer: diagnostic.jsonPointer,
          reason: `H3 Base section ${heading.name} must have a non-empty body.`,
          expected: { section: heading.name, body: "non-empty string" },
          actual: { section: heading.name, body: "" }
        } : null
      );
    }
    sections[heading.name] = body;
  });
  return sections;
}

function assertShotTimeline(description, durationSeconds, path, diagnostic = null) {
  const tokenPattern = /\[Shot\s+(\d+)\](?:\s+At\s+(\d{2}):(\d{2})\.(\d{3}),)?/gu;
  const shots = [];
  let match;
  while ((match = tokenPattern.exec(description))) {
    const timestamp = match[2] === undefined
      ? null
      : Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    shots.push({ number: Number(match[1]), timestamp, token: match[0] });
  }
  if (!shots.length || shots[0].number !== 1) {
    throwMiniMaxH3PromptError(
      `${path} 必须从 [Shot 1] 开始。`,
      timelineDiagnostic(diagnostic, diagnostic?.startCode, "The internal H3 timeline must begin with [Shot 1].", {
        firstShotNumber: 1,
        firstShotTimestamp: null
      }, shots)
    );
  }
  if (shots[0].timestamp !== null) {
    throwMiniMaxH3PromptError(
      `${path} 的 [Shot 1] 不得带时间戳。`,
      timelineDiagnostic(diagnostic, diagnostic?.firstTimestampCode, "[Shot 1] must not include a timestamp.", null, shots[0].timestamp)
    );
  }
  let previousTimestamp = 0;
  shots.forEach((shot, index) => {
    if (shot.number !== index + 1) {
      throwMiniMaxH3PromptError(
        `${path} 的内部 [Shot N] 必须从 1 连续编号。`,
        timelineDiagnostic(
          diagnostic,
          diagnostic?.sequenceCode,
          "Internal [Shot N] markers must be consecutively numbered from 1.",
          shots.map((ignored, shotIndex) => shotIndex + 1),
          shots.map((item) => item.number)
        )
      );
    }
    if (index === 0) return;
    if (shot.timestamp === null) {
      throwMiniMaxH3PromptError(
        `${path} 的 ${shot.token} 必须使用 At MM:SS.mmm 切点。`,
        timelineDiagnostic(
          diagnostic,
          diagnostic?.timestampRequiredCode,
          "Every internal shot after [Shot 1] must include an At MM:SS.mmm cut timestamp.",
          "At MM:SS.mmm",
          shot.token
        )
      );
    }
    if (shot.timestamp <= previousTimestamp || shot.timestamp >= durationSeconds) {
      throwMiniMaxH3PromptError(
        `${path} 的 ${shot.token} 必须严格递增且小于 ${durationSeconds} 秒。`,
        timelineDiagnostic(
          diagnostic,
          diagnostic?.timestampRangeCode,
          "Internal cut timestamps must be strictly increasing and less than durationSeconds.",
          { greaterThan: previousTimestamp, lessThan: durationSeconds },
          { shotNumber: shot.number, timestamp: shot.timestamp }
        )
      );
    }
    previousTimestamp = shot.timestamp;
  });
}

function assertReferenceLabelsClosed(sections, path) {
  const labelPattern = /<(Subject|Picture|Video|Audio)\s+(\d+)>/gu;
  const definitions = new Set([...sections.subject_definitions.matchAll(labelPattern)].map((match) => match[0]));
  if (!definitions.size) throw new MiniMaxH3PromptError(`${path}.subject_definitions 至少需要一个已绑定参考标签。`);
  const all = new Set(Object.values(sections).flatMap((body) => [...body.matchAll(labelPattern)].map((match) => match[0])));
  const unresolved = [...all].filter((label) => !definitions.has(label));
  if (unresolved.length) {
    throw new MiniMaxH3PromptError(`${path} 含未在 subject_definitions 中绑定的标签：${unresolved.join("、")}。`);
  }
  for (const kind of ["Subject", "Picture", "Video", "Audio"]) {
    const numbers = [...definitions]
      .map((label) => label.match(new RegExp(`^<${kind}\\s+(\\d+)>$`, "u")))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    if (numbers.some((number, index) => number !== index + 1)) {
      throw new MiniMaxH3PromptError(`${path} 的 <${kind} N> 必须从 1 连续编号。`);
    }
  }
}

function assertRetentionAnalysisContract(sections, path) {
  const definitions = parseDefinitionEntries(sections.subject_definitions, `${path}.subject_definitions`);
  const retention = parseRetentionEntries(sections.retention_analysis, `${path}.retention_analysis`);
  const standaloneLabels = new Set(definitions.map((entry) => entry.label));
  for (const [label] of retention) {
    if (!standaloneLabels.has(label)) {
      throw new MiniMaxH3PromptError(
        `${path}.retention_analysis 的 ${label} 没有独立 definition；仅作为来源内嵌的标签不得单独分析。`
      );
    }
  }
  for (const definition of definitions) {
    if (!retention.has(definition.label)) {
      throw new MiniMaxH3PromptError(
        `${path}.retention_analysis 缺少 ${definition.label} 的关系标记。`
      );
    }
  }
}

function parseDefinitionEntries(value, path) {
  const entries = [];
  const seen = new Set();
  const lines = String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^<(Subject|Picture|Video|Audio)\s+(\d+)>(?:\s+\(S\d+\))?\s+(.+)$/u);
    if (!match) {
      throw new MiniMaxH3PromptError(`${path} 第 ${index + 1} 行必须以一个 reference label 开始并完成定义。`);
    }
    const label = `<${match[1]} ${match[2]}>`;
    if (seen.has(label)) throw new MiniMaxH3PromptError(`${path} 重复定义 ${label}。`);
    seen.add(label);
    entries.push(Object.freeze({ label, kind: match[1], text: line }));
  }
  return entries;
}

function parseRetentionEntries(value, path) {
  const entries = new Map();
  const visibleMarkers = new Set(["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"]);
  const audioMarkers = new Set(["fully_copy", "partially_copy", "reference", "weak_reference"]);
  const lines = String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^<(Subject|Picture|Video|Audio)\s+(\d+)>(?:\s+\([^)]*\))?\s*:\s*([a-z_]+)\s*(?:-|–|—)\s*.+$/u);
    if (!match) {
      throw new MiniMaxH3PromptError(`${path} 第 ${index + 1} 行必须使用“<Label N>: marker - reason”格式。`);
    }
    const label = `<${match[1]} ${match[2]}>`;
    const marker = match[3];
    const allowed = match[1] === "Audio" ? audioMarkers : visibleMarkers;
    if (!allowed.has(marker)) {
      throw new MiniMaxH3PromptError(`${path} 的 ${label} 使用了非官方关系标记 ${marker}。`);
    }
    if (entries.has(label)) throw new MiniMaxH3PromptError(`${path} 重复分析 ${label}。`);
    entries.set(label, Object.freeze({ label, kind: match[1], marker, text: line }));
  }
  return entries;
}

function assertNoUnauthorizedOrdinaryRole(definition, path) {
  const text = definition.text.toLowerCase();
  const positiveRolePatterns = [
    /\b(?:is|serves as|acts as|becomes)\s+(?:the|a|an)\s+(?:concrete\s+)?(?:first[- ]frame|last[- ]frame|key[- ]frame|frame anchor|editing source|continuation starting point)\b/u,
    /\bsource video\s+(?:for|of)\s+(?:the\s+)?(?:target\s+)?(?:video\s+)?(?:edit|editing|continuation)\b/u
  ];
  if (positiveRolePatterns.some((pattern) => pattern.test(text))) {
    throw new MiniMaxH3PromptError(
      `${path}.subject_definitions 的 ${definition.label} 把普通参考升级成了关键帧、编辑源或续写起点。`
    );
  }
}

function assertNoConcretePictureUse(description, label, path) {
  const escaped = escapeRegExp(label);
  const patterns = [
    new RegExp(`(?:begins|starts)\\s+from\\s+${escaped}`, "iu"),
    new RegExp(`(?:key[- ]?frame|first[- ]?frame|last[- ]?frame|frame anchor)[^\\n.]{0,80}${escaped}|${escaped}[^\\n.]{0,80}(?:key[- ]?frame|first[- ]?frame|last[- ]?frame|frame anchor)`, "iu"),
    new RegExp(`(?:ends|finishes)\\s+on\\s+${escaped}`, "iu"),
    new RegExp(`(?:match|copy|replicate|preserve)[^\\n.]{0,80}${escaped}[^\\n.]{0,40}exactly|${escaped}[^\\n.]{0,80}(?:match|copy|replicate|preserve)[^\\n.]{0,40}exactly`, "iu")
  ];
  if (patterns.some((pattern) => pattern.test(description))) {
    throw new MiniMaxH3PromptError(
      `${path} 把普通图片 ${label} 当作具体关键帧、构图锚或逐帧复制来源。`
    );
  }
}

// 官方要求每个说话、唱歌或发出画外人声的主体使用稳定 ID (S1)/(S2)，同时发声用 (S1,S2)。
// 实测六个带对白的镜头只有一个照做，而 Prompt 里已经写过这条——纯措辞压不住。
// H3 靠这些 ID 分配音色：多角色镜头缺 ID 会让两个人说出同一个声音。
// 判据取"同一 [Shot N] 段内、该 <d> 块之前出现过说话人 ID"，不按句子边界切，
// 因为 <d> 正文里本身就含句号，按句切会误判。
const MINIMAX_H3_SPEAKER_ID_PATTERN = /\(S\d+(?:\s*,\s*S\d+)*\)/u;

function assertSpeakerIdsBound(description, path, promptPointer) {
  const text = String(description || "");
  if (!text.includes("<d>")) return;
  const segments = text.split(/(?=\[Shot \d+\])/u);
  segments.forEach((segment) => {
    const shotLabel = (segment.match(/\[Shot \d+\]/u) || ["[Shot 1]"])[0];
    let cursor = 0;
    while (true) {
      const index = segment.indexOf("<d>", cursor);
      if (index < 0) break;
      if (!MINIMAX_H3_SPEAKER_ID_PATTERN.test(segment.slice(0, index))) {
        throwMiniMaxH3PromptError(
          `${path} 中 ${shotLabel} 的 <d> 对白块之前缺少稳定说话人 ID。`
          + "每个说话主体必须使用 (S1)、(S2) 这类稳定标识，同时发声用 (S1,S2)；"
          + "识别短语、ID、动作与递送方式写在 <d> 外，H3 依赖它分配音色。",
          {
            code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SPEAKER_ID_MISSING,
            jsonPointer: promptPointer,
            reason: `Dialogue block in ${shotLabel} is not preceded by a stable speaker ID.`,
            expected: "(S1) / (S2) / (S1,S2)",
            actual: segment.slice(Math.max(0, index - 60), index)
          }
        );
      }
      cursor = index + 3;
    }
  });
}

// 官方明写 non_diegetic_music 只描述乐器、速度、节奏与动态变化，
// "do not use abstract mood words or explain the emotional function of the score"。
// 词表只收无歧义的抽象情绪词，刻意不收 warm、bright、soft 这类合法音色描述。
const MINIMAX_H3_ABSTRACT_MOOD_PATTERN =
  /\b(?:atmosphere|atmospheric|mood|emotional|emotionally|emotion|emotions|feeling|feelings|healing|nostalgia|nostalgic|conveying|conveys|evoking|evokes)\b/giu;

function assertNonDiegeticMusicIsSoundDesign(music, path, promptPointer) {
  const text = String(music || "").trim();
  if (!text || text === "N/A") return;
  const hits = [...new Set((text.match(MINIMAX_H3_ABSTRACT_MOOD_PATTERN) || []).map((hit) => hit.toLowerCase()))];
  if (!hits.length) return;
  throwMiniMaxH3PromptError(
    `${path} 使用了抽象情绪词：${hits.join("、")}。`
    + "non_diegetic_music 只描述乐器、速度、节奏与动态变化，不得解释配乐的情绪功能。",
    {
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.MUSIC_ABSTRACT_MOOD,
      jsonPointer: promptPointer,
      reason: "non_diegetic_music must describe instrumentation, tempo, rhythm and dynamics only.",
      expected: [],
      actual: hits
    }
  );
}

function assertDialoguePreserved(prompt, dialogueTexts, path, diagnostic = null) {
  const expected = dialogueTexts.map((item) => String(item || "").trim()).filter(Boolean);
  const canonicalBlocks = [...prompt.matchAll(/<d>\[([^\]]+)\]\s*([^<]+)<\/d>/gu)];
  const dialogueTags = [...prompt.matchAll(/<\/?d\b[^>]*>/giu)];
  if (dialogueTags.length !== canonicalBlocks.length * 2) {
    throwMiniMaxH3PromptError(
      `${path} 含非官方或未闭合的 <d>[Language] ...</d> 对白标签。`,
      dialogueDiagnostic(
        diagnostic,
        diagnostic?.tagCode,
        "Dialogue must use fully closed canonical <d>[Language] ...</d> blocks.",
        canonicalBlocks.length * 2,
        dialogueTags.length
      )
    );
  }
  const actual = canonicalBlocks.map((match) => ({
    language: match[1].trim(),
    text: match[2].trim()
  }));
  const unexpected = actual.filter((item) => (
    item.language !== "Chinese" || !expected.includes(item.text)
  ));
  if (unexpected.length) {
    throwMiniMaxH3PromptError(
      `${path} 新增或改写了未签发对白：${unexpected.map((item) => `<d>[${item.language}] ${item.text}</d>`).join("、")}。`,
      dialogueDiagnostic(
        diagnostic,
        diagnostic?.unauthorizedCode,
        "Every H3 Base dialogue block must preserve one signed source line verbatim in its original language.",
        expected.map((text) => ({ language: "Chinese", text })),
        actual
      )
    );
  }
  if (actual.length !== expected.length) {
    throwMiniMaxH3PromptError(
      `${path} 的 <d> 对白数量必须与签发对白一一对应；预期 ${expected.length} 条，当前 ${actual.length} 条。`,
      dialogueDiagnostic(
        diagnostic,
        diagnostic?.countCode,
        "H3 Base dialogue blocks must correspond one-to-one with signed dialogue lines, including duplicates.",
        expected.length,
        actual.length
      )
    );
  }
  const remaining = [...expected];
  for (const item of actual) {
    const matchIndex = remaining.indexOf(item.text);
    if (matchIndex >= 0) remaining.splice(matchIndex, 1);
  }
  if (remaining.length) {
    throwMiniMaxH3PromptError(
      `${path} 未把原对白逐字保存在 <d>[Chinese] ...</d> 中：${remaining.join("、")}。`,
      dialogueDiagnostic(
        diagnostic,
        diagnostic?.missingCode,
        "All signed dialogue lines must be preserved verbatim in <d>[Chinese] ...</d> blocks.",
        expected,
        actual.map((item) => item.text)
      )
    );
  }
  const actualTexts = actual.map((item) => item.text);
  if (actualTexts.some((text, index) => text !== expected[index])) {
    throwMiniMaxH3PromptError(
      `${path} 的 <d> 对白顺序必须与签发对白逐条一致。`,
      dialogueDiagnostic(
        diagnostic,
        diagnostic?.orderCode || diagnostic?.countCode,
        "H3 Base dialogue blocks must preserve the signed dialogue order exactly.",
        expected,
        actualTexts
      )
    );
  }
}

function assertEnglishSections(prompt, path, diagnostic = null) {
  const withoutAllowedOriginalLanguage = String(prompt || "")
    .replace(/<d>\[[^\]]+\][^<]*<\/d>/gu, "")
    .replace(/"(?:\\.|[^"\\])*"/gu, "");
  const match = [...withoutAllowedOriginalLanguage].find((character) => (
    /\p{Letter}/u.test(character)
    && !/\p{Script_Extensions=Latin}/u.test(character)
  ));
  if (match) {
    throwMiniMaxH3PromptError(
      `${path} 的 H3 sections 必须使用英文；只有 <d> 对白/歌词和英文双引号中的画面可见原文可以保留原语言。`,
      diagnostic ? {
        code: diagnostic.code,
        jsonPointer: diagnostic.jsonPointer,
        reason: "H3 Base section prose must be English; only canonical dialogue blocks and double-quoted visible text may preserve another language.",
        expected: "English section prose",
        actual: { disallowedCharacter: match[0] }
      } : null
    );
  }
}

function requirePromptText(value, path, diagnostic = null) {
  if (typeof value !== "string" || !value.trim()) {
    throwMiniMaxH3PromptError(`${path} 不能为空。`, diagnostic);
  }
  return value.trim();
}

/**
 * Convert an internal dot/bracket path or an already-canonical RFC 6901
 * pointer into one canonical JSON Pointer. This function never inspects an
 * error message and rejects ambiguous path syntax.
 */
export function miniMaxH3PathToJsonPointer(value) {
  const path = String(value || "").trim();
  if (!path) throw new TypeError("MiniMax H3 diagnostic path 不能为空");
  if (path.startsWith("/")) return canonicalJsonPointer(path);

  const tokens = [];
  let cursor = 0;
  let expectProperty = true;
  while (cursor < path.length) {
    if (expectProperty) {
      const property = path.slice(cursor).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/u)?.[0];
      if (!property) throw new TypeError(`MiniMax H3 diagnostic path 无法确定性转换：${path}`);
      tokens.push(property);
      cursor += property.length;
      expectProperty = false;
      continue;
    }
    if (path[cursor] === ".") {
      cursor += 1;
      expectProperty = true;
      continue;
    }
    if (path[cursor] === "[") {
      const bracket = path.slice(cursor).match(/^\[(0|[1-9]\d*)\]/u)?.[0];
      if (!bracket) throw new TypeError(`MiniMax H3 diagnostic path 无法确定性转换：${path}`);
      tokens.push(bracket.slice(1, -1));
      cursor += bracket.length;
      continue;
    }
    throw new TypeError(`MiniMax H3 diagnostic path 无法确定性转换：${path}`);
  }
  if (expectProperty || !tokens.length) {
    throw new TypeError(`MiniMax H3 diagnostic path 无法确定性转换：${path}`);
  }
  return jsonPointerFromTokens(tokens);
}

function throwMiniMaxH3PromptError(message, diagnostic = null) {
  if (!diagnostic) throw new MiniMaxH3PromptError(message);
  const jsonPointer = canonicalJsonPointer(diagnostic.jsonPointer);
  const detail = Object.freeze({
    code: String(diagnostic.code || ""),
    jsonPointer,
    path: jsonPointer,
    reason: String(diagnostic.reason || ""),
    expected: diagnosticValue(diagnostic.expected),
    actual: diagnosticValue(diagnostic.actual)
  });
  if (!detail.code || !detail.reason) {
    throw new TypeError("MiniMax H3 structured diagnostic 缺少 code 或 reason");
  }
  throw new MiniMaxH3PromptError(message, [detail]);
}

function timelineDiagnostic(diagnostic, code, reason, expected, actual) {
  if (!diagnostic) return null;
  return {
    code,
    jsonPointer: diagnostic.jsonPointer,
    reason,
    expected,
    actual
  };
}

function dialogueDiagnostic(diagnostic, code, reason, expected, actual) {
  if (!diagnostic) return null;
  return {
    code,
    jsonPointer: diagnostic.jsonPointer,
    reason,
    expected,
    actual
  };
}

function canonicalJsonPointer(value) {
  const pointer = String(value || "");
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new TypeError(`MiniMax H3 diagnostic JSON Pointer 无效：${pointer || "空"}`);
  }
  const tokens = pointer.slice(1).split("/").map((token) => {
    if (/~(?![01])/u.test(token)) {
      throw new TypeError(`MiniMax H3 diagnostic JSON Pointer 转义无效：${pointer}`);
    }
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) {
      throw new TypeError("MiniMax H3 diagnostic JSON Pointer 包含危险 token");
    }
    return decoded;
  });
  return jsonPointerFromTokens(tokens);
}

function jsonPointerFromTokens(tokens) {
  return `/${tokens.map((token) => String(token).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function siblingJsonPointer(pointer, field) {
  const tokens = canonicalJsonPointer(pointer).slice(1).split("/").map((token) => (
    token.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
  tokens.pop();
  tokens.push(field);
  return jsonPointerFromTokens(tokens);
}

function describePromptValue(value) {
  if (value === null) return null;
  if (value === undefined) return "undefined";
  if (typeof value === "string") return { type: "string", length: value.length, trimmedLength: value.trim().length };
  return { type: typeof value };
}

function diagnosticValue(value) {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
