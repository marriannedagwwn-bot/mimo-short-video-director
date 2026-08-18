import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MINIMAX_H3_BASE_SECTION_NAMES,
  MINIMAX_H3_REF2VA_SECTION_NAMES,
  MiniMaxH3PromptError,
  assertMiniMaxH3BasePrompt,
  assertMiniMaxH3Duration,
  assertMiniMaxH3OrdinaryReferencePolicy,
  assertMiniMaxH3Ref2VAPrompt,
  buildMiniMaxH3ContextIrIntent,
  buildMiniMaxH3ReferenceManifest,
  miniMaxH3DialogueTexts
} from "../src/minimax-h3-prompt.js";
import { miniMaxH3ExpandedPromptSemanticAuditPrompt } from "../src/prompts.js";

const BASE_PROMPT = `integrated_multimodal_description: [Shot 1] 2D-animated, warm golden-hour light fills a rural courtyard as a medium tracking shot follows Xiaobaizi running toward a bamboo mailbox. [Shot 2] At 00:02.000, the camera cuts to a close-up as she pushes the rolled notice fully into the bamboo tube. [Shot 3] At 00:03.500, the shot cuts to a backlit medium-wide view as she stretches both arms overhead and holds the completed pose.
overall_soundscape: Light footsteps cross the packed earth, followed by fabric rustle and a soft hollow tap from the bamboo tube.
non_diegetic_music: A sparse acoustic-guitar pattern at a slow tempo fades after the final pose.`;

const REF2VA_PROMPT = `subject_definitions:
<Subject 1> is Xiaobaizi, whose signed identity, wolf ears, linen top, pinafore dress, and shoulder bag are guided by <Picture 1>.
<Subject 2> is a broad continuity cue sampled from <Picture 2> of the previous business shot.
<Audio 1> is an ordinary voice-timbre reference for <Subject 1> (S1), without copying its signal.
summary:
[reference generation + audio reference] The target video follows the signed Animation Plan action while using <Picture 1> for <Subject 1>'s identity, <Subject 2> only for weak continuity, and <Audio 1> only for voice-timbre guidance.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the signed identity, species, wardrobe, and visible traits remain unchanged.
<Subject 2> (appears in [Shot 1]): weak_reference - only compatible broad continuity cues are retained.
<Audio 1>: reference - only voice timbre is referenced and no source signal is copied.
detailed_description:
The target video uses a 2D-animated style with warm golden-hour light. [Shot 1] A medium tracking shot follows <Subject 1> toward the bamboo mailbox while <Picture 1> guides only her signed identity and appearance and <Subject 2> supplies only compatible broad continuity. <Subject 1> (S1) says, <d>[Chinese] 我把通知送到了。</d> [Shot 2] At 00:02.250, the camera cuts to a close-up as she pushes the notice fully into the bamboo tube, releases it, and holds the visible completed state.
overall_soundscape:
Footsteps, cloth movement, paper rustle, and a soft bamboo tap remain synchronized with the visible actions.
non_diegetic_music:
A sparse acoustic-guitar pattern at a slow tempo fades after the notice is released.`;

function replaceSection(prompt, name, body) {
  const sectionNames = [...MINIMAX_H3_REF2VA_SECTION_NAMES];
  const index = sectionNames.indexOf(name);
  const start = prompt.indexOf(`${name}:`);
  const next = index < sectionNames.length - 1
    ? prompt.indexOf(`${sectionNames[index + 1]}:`, start)
    : prompt.length;
  return `${prompt.slice(0, start)}${name}:\n${body.trim()}\n${prompt.slice(next)}`.trim();
}

test("MiniMax H3 Base prompt 严格使用官方三段及顺序", () => {
  assert.deepEqual(MINIMAX_H3_BASE_SECTION_NAMES, [
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music"
  ]);
  const parsed = assertMiniMaxH3BasePrompt(BASE_PROMPT, { durationSeconds: 5 });
  assert.deepEqual(parsed.sectionNames, MINIMAX_H3_BASE_SECTION_NAMES);
  assert.match(parsed.sections.integrated_multimodal_description, /^\[Shot 1\]/u);

  const wrongOrder = BASE_PROMPT.replace(
    /overall_soundscape:([^]*?)non_diegetic_music:([^]*)$/u,
    "non_diegetic_music:$2\noverall_soundscape:$1"
  );
  assert.throws(
    () => assertMiniMaxH3BasePrompt(wrongOrder, { durationSeconds: 5 }),
    (error) => error instanceof MiniMaxH3PromptError && /必须严格按/u.test(error.message)
  );
  assert.throws(
    () => assertMiniMaxH3BasePrompt(`${BASE_PROMPT}\noverall_soundscape: duplicate`, { durationSeconds: 5 }),
    /各出现一次/u
  );
  const productionLabelInsideBody = BASE_PROMPT.replace(
    " [Shot 2]",
    "\ncamera: A restrained tracking cue remains part of the same integrated description.\n[Shot 2]"
  );
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(
    productionLabelInsideBody,
    { durationSeconds: 5 }
  ));
});

test("MiniMax H3 Ref2VA prompt 严格使用官方六段及顺序", () => {
  assert.deepEqual(MINIMAX_H3_REF2VA_SECTION_NAMES, [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music"
  ]);
  const parsed = assertMiniMaxH3Ref2VAPrompt(REF2VA_PROMPT, {
    durationSeconds: 5,
    dialogueTexts: ["我把通知送到了。"]
  });
  assert.deepEqual(parsed.sectionNames, MINIMAX_H3_REF2VA_SECTION_NAMES);
  assert.match(parsed.sections.summary, /^\[reference generation \+ audio reference\]/u);

  const wrongOrder = REF2VA_PROMPT
    .replace("summary:\n", "__SUMMARY__\n")
    .replace("retention_analysis:\n", "summary:\n")
    .replace("__SUMMARY__\n", "retention_analysis:\n");
  assert.throws(
    () => assertMiniMaxH3Ref2VAPrompt(wrongOrder, { durationSeconds: 5 }),
    /必须严格按/u
  );
});

test("内部 [Shot N] 时间戳必须连续编号、严格递增并位于业务镜头时长内", () => {
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(BASE_PROMPT, { durationSeconds: 5 }));

  const firstShotTimestamped = BASE_PROMPT.replace("[Shot 1]", "[Shot 1] At 00:00.000,");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(firstShotTimestamped, { durationSeconds: 5 }),
    /\[Shot 1\] 不得带时间戳/u
  );

  const missingTimestamp = BASE_PROMPT.replace("[Shot 2] At 00:02.000,", "[Shot 2]");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(missingTimestamp, { durationSeconds: 5 }),
    /必须使用 At MM:SS\.mmm 切点/u
  );

  const nonIncreasing = BASE_PROMPT.replace("[Shot 3] At 00:03.500,", "[Shot 3] At 00:01.500,");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(nonIncreasing, { durationSeconds: 5 }),
    /必须严格递增/u
  );

  const atDuration = BASE_PROMPT.replace("[Shot 3] At 00:03.500,", "[Shot 3] At 00:05.000,");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(atDuration, { durationSeconds: 5 }),
    /小于 5 秒/u
  );

  const skippedNumber = BASE_PROMPT.replace("[Shot 2]", "[Shot 3]").replace("[Shot 3] At 00:03.500,", "[Shot 4] At 00:03.500,");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(skippedNumber, { durationSeconds: 5 }),
    /从 1 连续编号/u
  );
});

test("原对白必须逐字保存在 <d>[Chinese] ...</d>，对白提取保持内容", () => {
  assert.deepEqual(
    miniMaxH3DialogueTexts("小白子：我把通知送到了。；奶奶：辛苦你了！\n小白子：我把通知送到了。"),
    ["我把通知送到了。", "辛苦你了！", "我把通知送到了。"]
  );
  assert.throws(
    () => miniMaxH3DialogueTexts("<d>[Chinese]嗷！</d>"),
    /dialogueOrSubtitle 必须保持.*纯剧情对白/u
  );
  assert.doesNotThrow(() => assertMiniMaxH3Ref2VAPrompt(REF2VA_PROMPT, {
    durationSeconds: 5,
    dialogueTexts: ["我把通知送到了。"]
  }));

  const rewrittenDialogue = REF2VA_PROMPT.replace("我把通知送到了。", "通知已经送达。");
  assert.throws(
    () => assertMiniMaxH3Ref2VAPrompt(rewrittenDialogue, {
      durationSeconds: 5,
      dialogueTexts: ["我把通知送到了。"]
    }),
    /未把原对白|新增或改写了未签发对白/u
  );
  assert.throws(
    () => assertMiniMaxH3BasePrompt(
      BASE_PROMPT.replace(" [Shot 2]", " Xiaobaizi (S1) says <d>[Chinese] 我是新增对白。</d> [Shot 2]"),
      { durationSeconds: 5, dialogueTexts: [] }
    ),
    /新增或改写了未签发对白/u
  );
  const repeatedDialoguePrompt = BASE_PROMPT.replace(
    " [Shot 2]",
    " Xiaobaizi (S1) says <d>[Chinese] 嗯。</d> <d>[Chinese] 嗯。</d> [Shot 2]"
  );
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(repeatedDialoguePrompt, {
    durationSeconds: 5,
    dialogueTexts: ["嗯。", "嗯。"]
  }));
  assert.throws(
    () => assertMiniMaxH3BasePrompt(
      repeatedDialoguePrompt.replace(" <d>[Chinese] 嗯。</d> [Shot 2]", " [Shot 2]"),
      { durationSeconds: 5, dialogueTexts: ["嗯。", "嗯。"] }
    ),
    /数量必须与签发对白一一对应/u
  );
  const orderedDialoguePrompt = BASE_PROMPT.replace(
    " [Shot 2]",
    " <d>[Chinese] 第一句。</d> <d>[Chinese] 第二句。</d> [Shot 2]"
  );
  assert.throws(
    () => assertMiniMaxH3BasePrompt(
      orderedDialoguePrompt.replace(
        "<d>[Chinese] 第一句。</d> <d>[Chinese] 第二句。</d>",
        "<d>[Chinese] 第二句。</d> <d>[Chinese] 第一句。</d>"
      ),
      { durationSeconds: 5, dialogueTexts: ["第一句。", "第二句。"] }
    ),
    /对白顺序必须与签发对白逐条一致/u
  );
});

test("Ref2VA 拒绝未在 subject_definitions 绑定的参考标签", () => {
  const unresolved = REF2VA_PROMPT.replace(
    "while <Picture 1> guides only",
    "while <Video 1> guides only"
  );
  assert.throws(
    () => assertMiniMaxH3Ref2VAPrompt(unresolved, { durationSeconds: 5 }),
    (error) => error instanceof MiniMaxH3PromptError
      && /未在 subject_definitions 中绑定/u.test(error.message)
      && /<Video 1>/u.test(error.message)
  );
});

test("Ref2VA retention_analysis 只接受官方 marker，并且只分析独立定义的标签", () => {
  assert.throws(
    () => assertMiniMaxH3Ref2VAPrompt(
      REF2VA_PROMPT.replace("<Subject 2> (appears in [Shot 1]): weak_reference", "<Subject 2> (appears in [Shot 1]): exact_copy"),
      { durationSeconds: 5 }
    ),
    /非官方关系标记 exact_copy/u
  );
  assert.throws(
    () => assertMiniMaxH3Ref2VAPrompt(
      REF2VA_PROMPT.replace(
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved -",
        "<Picture 1> (identity source): weak_reference - source only.\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved -"
      ),
      { durationSeconds: 5 }
    ),
    /<Picture 1> 没有独立 definition/u
  );
});

test("签发角色 Subject 必须 fully_preserved，不接受 partially_preserved", () => {
  const fullyPreservedPrompt = `subject_definitions:
<Subject 1> is the signed character Xiaobaizi, whose canonical identity and appearance are guided only by <Picture 1>.
summary:
[reference generation] The target follows the signed action while <Picture 1> guides only <Subject 1>'s canonical identity and appearance.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the signed identity, species, wardrobe, and visible traits remain unchanged.
detailed_description:
[Shot 1] <Subject 1> performs the newly signed action in a different pose and background while retaining the canonical identity and appearance from <Picture 1>.
overall_soundscape:
Natural ambience follows the signed action.
non_diegetic_music:
N/A`;
  const signedCharacterManifest = buildMiniMaxH3ReferenceManifest([{
    mediaType: "image",
    sha256: "a".repeat(64),
    source: "character_reference",
    sourceCharacterName: "小白子",
    logicalName: "小白子角色图",
    sizeBytes: 10
  }]);

  const fullyPreserved = assertMiniMaxH3Ref2VAPrompt(fullyPreservedPrompt, {
    durationSeconds: 5
  });
  assert.doesNotThrow(() => assertMiniMaxH3OrdinaryReferencePolicy(
    fullyPreserved,
    signedCharacterManifest
  ));

  const partiallyPreserved = assertMiniMaxH3Ref2VAPrompt(
    fullyPreservedPrompt.replace(
      ": fully_preserved - the signed identity",
      ": partially_preserved - the signed identity"
    ),
    { durationSeconds: 5 }
  );
  assert.throws(
    () => assertMiniMaxH3OrdinaryReferencePolicy(partiallyPreserved, signedCharacterManifest),
    /签发角色 <Subject 1> 必须 fully_preserved/u
  );
});

test("普通上传与上一镜参考使用独立 weak_reference Subject 时合法", () => {
  const weakReferencePrompt = `subject_definitions:
<Subject 1> is a broad visual continuity cue guided by <Picture 1>, without defining signed character identity or a concrete keyframe.
summary:
[reference generation] The target follows the signed action while <Subject 1> supplies only broad compatible visual guidance.
retention_analysis:
<Subject 1> (appears in [Shot 1]): weak_reference - only broad compatible visual guidance is retained.
detailed_description:
[Shot 1] The current signed action proceeds while <Subject 1> supplies only broad compatible guidance from <Picture 1> without fixing the frame or overriding current facts.
overall_soundscape:
Natural ambience follows the signed action.
non_diegetic_music:
N/A`;
  const parsed = assertMiniMaxH3Ref2VAPrompt(weakReferencePrompt, {
    durationSeconds: 5
  });

  for (const source of ["upload", "previous_shot_frame"]) {
    const manifest = buildMiniMaxH3ReferenceManifest([{
      mediaType: "image",
      sha256: (source === "upload" ? "b" : "c").repeat(64),
      source,
      logicalName: source === "upload" ? "ordinary.png" : "A01 frame",
      sourceShotId: source === "previous_shot_frame" ? "A01" : "",
      sizeBytes: 10
    }]);
    assert.doesNotThrow(
      () => assertMiniMaxH3OrdinaryReferencePolicy(parsed, manifest),
      `${source} 应作为独立 weak_reference Subject 通过`
    );
  }
});

test("签发角色来源不得与普通上传或上一镜来源混入同一 weak_reference Subject", () => {
  const mixedSubjectPrompt = `subject_definitions:
<Subject 1> is the signed character identity from <Picture 1> combined with broad visual guidance from <Picture 2>.
summary:
[reference generation] The target follows the signed action while <Subject 1> combines both image sources.
retention_analysis:
<Subject 1> (appears in [Shot 1]): weak_reference - only broad similarity from both sources is retained.
detailed_description:
[Shot 1] <Subject 1> performs the current signed action while <Picture 1> and <Picture 2> jointly guide the same visible subject.
overall_soundscape:
Natural ambience follows the signed action.
non_diegetic_music:
N/A`;
  const parsed = assertMiniMaxH3Ref2VAPrompt(mixedSubjectPrompt, {
    durationSeconds: 5
  });

  for (const weakSource of ["upload", "previous_shot_frame"]) {
    const manifest = buildMiniMaxH3ReferenceManifest([{
      mediaType: "image",
      sha256: "d".repeat(64),
      source: "character_reference",
      sourceCharacterName: "小白子",
      logicalName: "小白子角色图",
      sizeBytes: 10
    }, {
      mediaType: "image",
      sha256: (weakSource === "upload" ? "e" : "f").repeat(64),
      source: weakSource,
      logicalName: weakSource === "upload" ? "ordinary.png" : "A01 frame",
      sourceShotId: weakSource === "previous_shot_frame" ? "A01" : "",
      sizeBytes: 10
    }]);
    assert.throws(
      () => assertMiniMaxH3OrdinaryReferencePolicy(parsed, manifest),
      `${weakSource} 不得与签发角色来源混入同一 Subject`
    );
  }
});

test("普通参考策略拒绝虚构 audio reference、上一镜 fully_preserved 和关键帧角色", () => {
  const previousPrompt = `subject_definitions:
<Subject 1> is a broad continuity cue guided by <Picture 1> from the previous business shot.
summary:
[reference generation] The target uses <Subject 1> only for continuity guidance.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the previous frame is preserved exactly.
detailed_description:
[Shot 1] The current signed action proceeds while <Subject 1> guides continuity.
overall_soundscape:
Natural ambience continues.
non_diegetic_music:
N/A`;
  const previousParsed = assertMiniMaxH3Ref2VAPrompt(previousPrompt, { durationSeconds: 5 });
  const previousManifest = buildMiniMaxH3ReferenceManifest([{
    mediaType: "image",
    sha256: "a".repeat(64),
    source: "previous_shot_frame",
    logicalName: "A01 frame",
    sizeBytes: 10
  }]);
  assert.throws(
    () => assertMiniMaxH3OrdinaryReferencePolicy(previousParsed, previousManifest),
    /含普通上传或上一镜参考，只允许 weak_reference/u
  );

  const keyframePrompt = previousPrompt
    .replace("<Subject 1> is a broad continuity cue guided by <Picture 1> from the previous business shot.", "<Picture 1> is the concrete first frame of [Shot 1].")
    .replace(/<Subject 1>/gu, "<Picture 1>")
    .replace("fully_preserved", "weak_reference");
  const keyframeParsed = assertMiniMaxH3Ref2VAPrompt(keyframePrompt, { durationSeconds: 5 });
  const uploadManifest = buildMiniMaxH3ReferenceManifest([{
    mediaType: "image",
    sha256: "b".repeat(64),
    source: "upload",
    logicalName: "ordinary.png",
    sizeBytes: 10
  }]);
  assert.throws(
    () => assertMiniMaxH3OrdinaryReferencePolicy(keyframeParsed, uploadManifest),
    /升级成了关键帧/u
  );

  const audioMismatch = assertMiniMaxH3Ref2VAPrompt(
    previousPrompt.replace("[reference generation]", "[reference generation + audio reference]").replace("fully_preserved", "weak_reference"),
    { durationSeconds: 5 }
  );
  assert.throws(
    () => assertMiniMaxH3OrdinaryReferencePolicy(audioMismatch, previousManifest),
    /必须与实际素材一致.*\[reference generation\]/u
  );
});

test("普通 all_reference 不能被升级为 video editing 或 video continuation", async (t) => {
  for (const forbiddenTask of ["video editing", "video continuation"]) {
    await t.test(forbiddenTask, () => {
      const prompt = replaceSection(
        REF2VA_PROMPT,
        "summary",
        `[${forbiddenTask} + reference generation] The target uses ordinary references.`
      );
      assert.throws(
        () => assertMiniMaxH3Ref2VAPrompt(prompt, { durationSeconds: 5, dialogueTexts: ["我把通知送到了。"] }),
        new RegExp(`升级成了 ${forbiddenTask}`, "u")
      );
    });
  }

  assert.doesNotThrow(() => assertMiniMaxH3Ref2VAPrompt(REF2VA_PROMPT, {
    durationSeconds: 5,
    dialogueTexts: ["我把通知送到了。"],
    ordinaryReferenceOnly: true
  }));
});

test("H3 sections 必须为英文，仅允许对白和双引号可见文字保留原语言", () => {
  const chineseBody = BASE_PROMPT.replace("warm golden-hour", "温暖的 golden-hour");
  assert.throws(
    () => assertMiniMaxH3BasePrompt(chineseBody, { durationSeconds: 5 }),
    /sections 必须使用英文/u
  );
  const visibleText = BASE_PROMPT.replace(
    "A warm medium tracking shot",
    "A medium tracking shot passes a sign reading \"通知已送达\" and"
  );
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(visibleText, { durationSeconds: 5 }));
  for (const nonEnglishBody of ["русский текст", "نص عربي"]) {
    assert.throws(
      () => assertMiniMaxH3BasePrompt(
        BASE_PROMPT.replace("warm golden-hour", nonEnglishBody),
        { durationSeconds: 5 }
      ),
      /sections 必须使用英文/u
    );
  }
});

test("MiniMax H3 时长只接受 4–15 秒整数且不静默钳制", () => {
  assert.equal(assertMiniMaxH3Duration(4), 4);
  assert.equal(assertMiniMaxH3Duration("15"), 15);
  for (const value of [3, 16, 4.5, "", Number.NaN]) {
    assert.throws(
      () => assertMiniMaxH3Duration(value, "shot.durationSeconds"),
      (error) => error instanceof MiniMaxH3PromptError
        && /4–15 秒整数/u.test(error.message)
        && /不能静默改写时长/u.test(error.message)
    );
  }
  assert.throws(
    () => assertMiniMaxH3BasePrompt(BASE_PROMPT, { durationSeconds: 3 }),
    /4–15 秒整数/u
  );
});

test("reference manifest 保留 provider content 顺序并对 canonical manifest 签发 digest", () => {
  const artifacts = [
    {
      mediaType: "image",
      sha256: "a".repeat(64),
      source: "character_reference",
      sourceCharacterName: "小白子",
      logicalName: "小白子角色图",
      sizeBytes: 101
    },
    {
      mediaType: "video",
      sha256: "b".repeat(64),
      source: "upload",
      filename: "camera.mp4",
      sizeBytes: 202
    },
    {
      mediaType: "image",
      sha256: "c".repeat(64),
      source: "previous_shot_frame",
      filename: "A01-02.jpg",
      sourceShotId: "A01",
      sizeBytes: 303
    },
    {
      mediaType: "audio",
      sha256: "d".repeat(64),
      source: "upload",
      filename: "voice.wav",
      sizeBytes: 404
    }
  ];
  const manifest = buildMiniMaxH3ReferenceManifest(artifacts);
  assert.equal(manifest.schemaVersion, "minimax_h3_reference_manifest/1.0");
  assert.deepEqual(manifest.counts, { image: 2, video: 1, audio: 1 });
  assert.deepEqual(
    manifest.contentItems.map((item) => ({
      assetId: item.assetId,
      providerContentIndex: item.providerContentIndex,
      mediaType: item.mediaType,
      transportRole: item.transportRole,
      ordinalWithinMediaType: item.ordinalWithinMediaType,
      sourceShotId: item.sourceShotId,
      sourceCharacterName: item.sourceCharacterName
    })),
    [
      { assetId: "reference-01", providerContentIndex: 1, mediaType: "image", transportRole: "reference_image", ordinalWithinMediaType: 1, sourceShotId: "", sourceCharacterName: "小白子" },
      { assetId: "reference-02", providerContentIndex: 2, mediaType: "video", transportRole: "reference_video", ordinalWithinMediaType: 1, sourceShotId: "", sourceCharacterName: "" },
      { assetId: "reference-03", providerContentIndex: 3, mediaType: "image", transportRole: "reference_image", ordinalWithinMediaType: 2, sourceShotId: "A01", sourceCharacterName: "" },
      { assetId: "reference-04", providerContentIndex: 4, mediaType: "audio", transportRole: "reference_audio", ordinalWithinMediaType: 1, sourceShotId: "", sourceCharacterName: "" }
    ]
  );
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(manifest.contentItems), "utf8")
    .digest("hex");
  assert.equal(manifest.digest, expectedDigest);
  assert.notEqual(buildMiniMaxH3ReferenceManifest([...artifacts].reverse()).digest, manifest.digest);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.contentItems));
});

test("Context-IR intent 把上一镜抽帧限定为 weak continuity 而非编辑、续写或关键帧", () => {
  const intent = buildMiniMaxH3ContextIrIntent({
    sourcePrompt: BASE_PROMPT,
    shot: {
      durationSeconds: 5,
      dialogueOrSubtitle: "小白子：我把通知送到了。"
    },
    characterReferences: [{
      characterName: "小白子",
      appearancePrompt: "BOUND_APPEARANCE_SHOULD_NOT_BE_SENT",
      consistencyTags: ["BOUND_TAG_SHOULD_NOT_BE_SENT"]
    }],
    artifacts: [
      { mediaType: "image", source: "character_reference", sourceCharacterName: "小白子", logicalName: "小白子角色图" },
      { mediaType: "image", source: "previous_shot_frame", logicalName: "A01 第 2 秒", sourceShotId: "A01" },
      { mediaType: "video", source: "upload", logicalName: "运镜参考" },
      { mediaType: "audio", source: "upload", logicalName: "音色参考" }
    ]
  });

  assert.match(intent, /^H3_CONTEXT_IR_GROUNDED_REF2VA_V1/u);
  assert.match(intent, /The Animation Plan is authoritative/u);
  assert.doesNotMatch(intent, /All supplied media are ordinary references/iu);
  assert.match(intent, /Picture 1 \(小白子角色图\) is an identity and appearance reference/u);
  assert.match(intent, /signed character 小白子 only/u);
  assert.match(
    intent,
    /sole runtime source of that character's static appearance/iu
  );
  assert.match(
    intent,
    /Do not repeat static hair, eyes, clothing, body, or style prose from the Base prompt/iu
  );
  assert.match(
    intent,
    /Keep the signed action, pose, expression, props, scene, camera, sound, and any dynamic appearance change required by the current shot/iu
  );
  assert.match(
    intent,
    /defined exclusively by signed character-reference assets must use the exact retention marker fully_preserved/iu
  );
  assert.match(
    intent,
    /New actions, poses, expressions, camera changes, lighting changes, or backgrounds do not make the signed identity or appearance partially preserved/iu
  );
  assert.match(
    intent,
    /Do not combine this signed character source with ordinary uploads or previous-shot weak references in the same <Subject N>/iu
  );
  assert.match(
    intent,
    /keep that Subject separate from every signed-character Subject and use the exact retention marker weak_reference/iu
  );
  assert.match(intent, /Picture 2 \(A01 第 2 秒\) is a weak continuity reference sampled from the previous business shot/u);
  assert.match(intent, /It is not a source-video edit, continuation, or keyframe/u);
  assert.match(intent, /Do not copy its background, completed action, props, or framing/u);
  assert.match(intent, /Video 1 \(运镜参考\) is an ordinary weak reference/u);
  assert.match(intent, /Audio 1 \(音色参考\) is an ordinary audio reference/u);
  assert.match(intent, /Preserve this dialogue verbatim[^\n]+我把通知送到了。/u);
  assert.match(intent, /The target business shot lasts exactly 5 seconds/u);
  assert.doesNotMatch(intent, /BOUND_APPEARANCE_SHOULD_NOT_BE_SENT|BOUND_TAG_SHOULD_NOT_BE_SENT/u);
  assert.ok(intent.endsWith(BASE_PROMPT));
});

test("Context-IR intent 在没有实际角色图时使用当前签发角色文字 fallback", () => {
  const intent = buildMiniMaxH3ContextIrIntent({
    sourcePrompt: BASE_PROMPT,
    shot: { durationSeconds: 5 },
    characterReferences: [{
      characterName: "小白子",
      identity: "狼耳少女",
      appearancePrompt: "当前签发的银灰长发与深色校服",
      consistencyTags: ["当前签发蓝色眼睛"]
    }],
    artifacts: [{ mediaType: "image", source: "upload", logicalName: "普通风格图" }]
  });

  assert.match(
    intent,
    /When no signed character-reference image is present for a character, use that character's current signed text appearance/iu
  );
  assert.match(intent, /当前签发的银灰长发与深色校服/u);
  assert.match(intent, /当前签发蓝色眼睛/u);
  assert.doesNotMatch(intent, /sole runtime source of that character's static appearance/iu);
});

test("H3 Context-IR 语义审计按冻结角色图区分静态外观与动态镜头事实", () => {
  const prompt = miniMaxH3ExpandedPromptSemanticAuditPrompt({
    animationPlan: {
      characterReferencePrompts: [{
        characterName: "小白子",
        appearancePrompt: "银灰长发、蓝色眼睛、深色校服。"
      }]
    },
    shot: {
      shotId: "A01",
      durationSeconds: 5,
      characterAction: "小白子穿上雨衣后抱紧画册。",
      videoPrompt: BASE_PROMPT
    },
    sourcePrompt: BASE_PROMPT,
    expandedPrompt: REF2VA_PROMPT,
    referenceManifest: {
      contentItems: [{
        source: "character_reference",
        sourceCharacterName: "小白子",
        mediaType: "image"
      }]
    }
  });

  assert.match(
    prompt,
    /frozen character_reference image is the sole runtime authority for that character's static appearance/iu
  );
  assert.match(
    prompt,
    /Omitting stale static hair, eyes, clothing, body, or style prose from the Base prompt is not semantic loss/iu
  );
  assert.match(
    prompt,
    /must retain dynamic wardrobe or appearance changes required by the current exact shot/iu
  );
  assert.match(
    prompt,
    /without a frozen character_reference image.*signed character text appearance remains required fallback/iu
  );
  assert.doesNotMatch(prompt, /银灰长发、蓝色眼睛、深色校服/u);
});

test("H3 Context-IR 语义审计在角色图未实际发送时保留当前签发文字外观", () => {
  const prompt = miniMaxH3ExpandedPromptSemanticAuditPrompt({
    animationPlan: {
      characterReferencePrompts: [{
        characterName: "小白子",
        appearancePrompt: "CURRENT_SIGNED_TEXT_APPEARANCE",
        consistencyTags: ["CURRENT_SIGNED_TEXT_TAG"]
      }]
    },
    shot: {
      shotId: "A01",
      durationSeconds: 5,
      videoPrompt: BASE_PROMPT
    },
    sourcePrompt: BASE_PROMPT,
    expandedPrompt: REF2VA_PROMPT,
    referenceManifest: {
      contentItems: [{ source: "upload", mediaType: "image" }]
    }
  });

  assert.match(prompt, /CURRENT_SIGNED_TEXT_APPEARANCE/u);
  assert.match(prompt, /CURRENT_SIGNED_TEXT_TAG/u);
  assert.match(prompt, /signed_character_text_fallback/u);
});
