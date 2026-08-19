import test from "node:test";
import assert from "node:assert/strict";
import {
  animationShotPromptPartialRepairAdapter,
  planAnimationShotPromptPartialRepair
} from "../src/animation-shot-prompt-partial-repair.js";
import {
  assertMiniMaxH3BasePrompt,
  miniMaxH3DialogueEntries,
  miniMaxH3DialogueTexts,
  splitMiniMaxH3Sentences
} from "../src/minimax-h3-prompt.js";

// 实测依据：83 个带对白的镜头里 44 个漏写 <d>（53%）。已解析的候选按 AGENTS.md
// 不得整批重写（workflow.js:746 在 direct_shot 下直接抛出），而 adapter 原本要求
// integrated 段能独立冻结才肯修——缺 <d> 恰好落在该段内部，于是毫无恢复路径。
// 本组用例锁定"仅插入对白"这一有界授权：正文其余部分逐字冻结。
const INTEGRATED = "[Shot 1] In a 2D-animated style, a medium shot captures the wolf-eared girl on the riverside grass."
  + " A boy bursts out from the bushes and throws a stone into the river."
  + " The camera pans right at slow speed to follow him."
  + " Her cat ears droop as she lets out a helpless vocalization.";

const PROMPT = [
  `integrated_multimodal_description: ${INTEGRATED}`,
  "overall_soundscape: Bushes rustle, a stone splashes into the water, and light footsteps cross the grass.",
  "non_diegetic_music: A soft acoustic guitar figure at a slow tempo that softens at the end."
].join("\n");

function shot(overrides = {}) {
  return {
    shotId: "A03",
    sourceSceneId: "S2",
    sceneId: "LOC01",
    durationSeconds: 5,
    storyPurpose: "p",
    emotionalTarget: "e",
    cameraMotion: "c",
    characterAction: "a",
    dialogueOrSubtitle: "小白子：嗷呜...",
    soundDesign: "s",
    continuityNotes: "n",
    videoPrompt: PROMPT,
    ...overrides
  };
}

function candidate(shotOverrides = {}) {
  return {
    promptSchemaVersion: "3.0",
    selectedVariantId: "V1",
    productionStrategy: {
      format: "direct_shot_video",
      videoPromptProfile: {
        schemaVersion: "1.0",
        profileId: "minimax_h3",
        provider: "MiniMax",
        model: "MiniMax-H3",
        guideVersion: "80365054c7fbaace01ed417076fecd532c1ae0e0"
      }
    },
    shotPlan: [shot(shotOverrides)]
  };
}

const context = () => ({
  repairAttemptCount: 0,
  fullStory: {
    sceneScript: [{
      sceneId: "S2", location: "riverside", characters: ["小白子"],
      visibleAction: "x", shotAndSound: "y"
    }]
  },
  visualGuardrails: {
    fixedCharacterBoundary: {
      characterName: "小白子",
      sourceDigest: "sha256:a", boundaryDigest: "sha256:b", boundarySignature: "sig",
      requiredTraits: [], forbiddenTraits: []
    }
  }
});

function diagnosticsFor(value) {
  const target = value.shotPlan[0];
  try {
    assertMiniMaxH3BasePrompt(target.videoPrompt, {
      durationSeconds: target.durationSeconds,
      path: "/shotPlan/0/videoPrompt",
      dialogueTexts: miniMaxH3DialogueTexts(target.dialogueOrSubtitle)
    });
  } catch (error) {
    return error.details;
  }
  throw new Error("fixture should fail validation");
}

function planFor(value) {
  return planAnimationShotPromptPartialRepair(value, { details: diagnosticsFor(value) }, context());
}

const authorize = (target, replacement) =>
  animationShotPromptPartialRepairAdapter.authorizeReplacement({ target, replacement });

const REPAIRED = PROMPT.replace(
  "as she lets out a helpless vocalization",
  "as she (S1) says <d>[Chinese] 嗷呜...</d>"
);

test("仅缺 <d> 时签发修复计划，并把说话人 ID 作为服务端权威下发", () => {
  const plan = planFor(candidate());
  assert.ok(plan, "应签发修复计划");
  const insertion = plan.targets[0].modelContext.dialogueInsertion;
  assert.deepEqual(insertion.allowedSpeakerIds, ["(S1)"]);
  assert.deepEqual(insertion.utterances, [{ speakerId: "(S1)", text: "嗷呜..." }]);
  assert.equal(insertion.frozenSentences.length, 4);
});

test("只在发声那一句插入对白时接受", () => {
  const plan = planFor(candidate());
  assert.doesNotThrow(() => authorize(plan.targets[0], REPAIRED));
});

test("顺带改写与对白无关的句子必须拒绝", () => {
  const plan = planFor(candidate());
  assert.throws(
    () => authorize(plan.targets[0], REPAIRED.replace("A boy bursts out from the bushes", "A tall teenager strides out")),
    /最多允许 1 个句子发生变化/u
  );
});

test("使用未指派的说话人 ID 必须拒绝", () => {
  const plan = planFor(candidate());
  assert.throws(() => authorize(plan.targets[0], REPAIRED.replace("(S1)", "(S2)")), /未指派的说话人 ID/u);
});

test("增删句子必须拒绝", () => {
  const plan = planFor(candidate());
  assert.throws(
    () => authorize(plan.targets[0], REPAIRED.replace(" The camera pans right at slow speed to follow him.", "")),
    /不得增删/u
  );
});

test("多说话人镜头按首次发声顺序指派 ID", () => {
  const entries = miniMaxH3DialogueEntries("小白子：嗷呜！\n小男孩：哇！\n小白子：嗷~");
  assert.deepEqual(entries.map((entry) => entry.speakerId), ["(S1)", "(S2)", "(S1)"]);
});

test("对白正文里的句号不会切错句", () => {
  const sentences = splitMiniMaxH3Sentences(
    "[Shot 1] In a 2.5D style, she says <d>[Chinese] 嗷呜...</d> softly. [Shot 2] At 00:03.000, the camera cuts to him."
  );
  assert.equal(sentences.length, 2);
  assert.ok(sentences[0].includes("<d>"));
});

test("正文自身不合法时不签发计划，仍旧 fail closed", () => {
  const broken = candidate({
    videoPrompt: PROMPT.replace("[Shot 1] In a 2D-animated style,", "[Shot 1] At 00:01.000, in a 2D-animated style,")
  });
  assert.equal(planFor(broken), null);
});

// 第二种可修形态：<d> 已写全，只是缺说话人 ID。加了 SPEAKER_ID_MISSING 校验却没把它
// 接入修复码表时，这会变成一个全新的硬失败——真实运行中立刻撞上了。
const WITH_DIALOGUE_NO_ID = PROMPT.replace(
  "as she lets out a helpless vocalization",
  "as she opens her mouth and says <d>[Chinese] 嗷呜...</d>"
);

test("<d> 齐全但缺说话人 ID 时同样签发修复计划", () => {
  const plan = planFor(candidate({ videoPrompt: WITH_DIALOGUE_NO_ID }));
  assert.ok(plan, "缺说话人 ID 必须可修，否则新增校验会造成无解阻断");
  assert.deepEqual(plan.targets[0].modelContext.dialogueInsertion.allowedSpeakerIds, ["(S1)"]);
});

test("补上服务端指派的 ID 后接受，发明新 ID 仍拒绝", () => {
  const plan = planFor(candidate({ videoPrompt: WITH_DIALOGUE_NO_ID }));
  const repaired = WITH_DIALOGUE_NO_ID.replace(
    "as she opens her mouth and says",
    "as she (S1) opens her mouth and says"
  );
  assert.doesNotThrow(() => authorize(plan.targets[0], repaired));
  assert.throws(() => authorize(plan.targets[0], repaired.replace("(S1)", "(S2)")), /未指派的说话人 ID/u);
});

// 第三种形态：<d> 齐全、内容也对，只是顺序与签发对白相反。
// 权威在上游——Full Story 的 sceneScript[].dialogue[] 给出了说话顺序，
// dialogueOrSubtitle 与之一致，只有 videoPrompt 写反了，因此可唯一推导。
const TWO_LINE_SHOT = {
  dialogueOrSubtitle: "小白子：嗷呜！\n小男孩：哇！这是我吗？",
  videoPrompt: [
    "integrated_multimodal_description: [Shot 1] In a 2D-animated style, a medium shot frames the pair on the grass."
      + " The boy (S2) leans in and says <d>[Chinese] 哇！这是我吗？</d> with bright eyes."
      + " She (S1) lifts the sketchbook and says <d>[Chinese] 嗷呜！</d> happily.",
    "overall_soundscape: Paper rustles and light footsteps cross the grass.",
    "non_diegetic_music: A soft acoustic figure at a slow tempo that softens at the end."
  ].join("\n")
};

test("对白顺序写反时可修，且两个说话人 ID 都被指派", () => {
  const plan = planFor(candidate(TWO_LINE_SHOT));
  assert.ok(plan, "顺序错的权威在上游，应可修");
  assert.deepEqual(plan.targets[0].modelContext.dialogueInsertion.allowedSpeakerIds, ["(S1)", "(S2)"]);
});

test("对白内容被改写而不只是换序时必须拒绝签发", () => {
  const rewritten = {
    ...TWO_LINE_SHOT,
    videoPrompt: TWO_LINE_SHOT.videoPrompt.replace("这是我吗？", "这是谁呀？")
  };
  assert.equal(planFor(candidate(rewritten)), null, "改内容不是换序，必须 fail closed");
});

// 第四种形态：non_diegetic_music 出现抽象情绪词。这一段与正文无关且自成一体，
// 现有机制本就能冻结 integrated 与 soundscape、只重写音乐段——只差把诊断码接进
// 可修复集合。加了校验却不接修复，等于凭空造出一个无解阻断。
const MOOD_MUSIC_SHOT = {
  dialogueOrSubtitle: "小白子：嗷呜！",
  videoPrompt: [
    "integrated_multimodal_description: [Shot 1] In a 2D-animated style, a medium shot frames the girl (S1) on the grass as she says <d>[Chinese] 嗷呜！</d> happily.",
    "overall_soundscape: Paper rustles and light footsteps cross the grass.",
    "non_diegetic_music: The acoustic guitar reaches an emotional peak with bright chords at a moderate tempo."
  ].join("\n")
};

test("音乐段情绪词可修，且只解冻音乐段", () => {
  const plan = planFor(candidate(MOOD_MUSIC_SHOT));
  assert.ok(plan, "音乐段自成一体，必须可修");
  const frozen = Object.keys(plan.targets[0].modelContext.preservedSections);
  assert.deepEqual(frozen.sort(), ["integrated_multimodal_description", "overall_soundscape"]);
});

test("只重写音乐段接受，顺带改正文拒绝", () => {
  const plan = planFor(candidate(MOOD_MUSIC_SHOT));
  const fixed = MOOD_MUSIC_SHOT.videoPrompt.replace(
    /non_diegetic_music:.*/u,
    "non_diegetic_music: A single nylon-string guitar figure at a moderate tempo, thinning to one held note at the end."
  );
  assert.doesNotThrow(() => authorize(plan.targets[0], fixed));
  assert.throws(
    () => authorize(plan.targets[0], fixed.replace("on the grass", "on the riverbank")),
    /不得改写已合法的 integrated_multimodal_description/u
  );
});

// 修复指令本身曾写成 "prefixed by the exact assigned speakerId"，可被读成"给 <d> 内容加
// 前缀"，模型据此产出 <d>[Chinese] (S1) 嗷~</d>，ID 混进了对白正文。守卫确实拦住了，
// 但阶段随之硬失败。指令必须给出与主提示词一致的官方句式，并明写 ID 在标签外。
test("修复指令给出官方句式并明确 ID 在 <d> 外", () => {
  const plan = planFor(candidate());
  const instruction = plan.targets[0].repairInstruction;
  assert.ok(instruction.includes("<identity phrase> (S1) says: <d>[Chinese] text</d>"), "应给出可照抄的句式");
  assert.match(instruction, /never write \(S1\) inside <d>/u, "应明写 ID 不得进入标签内");
});

test("说话人 ID 混进 <d> 正文时守卫拒绝", () => {
  const plan = planFor(candidate());
  const wrong = PROMPT.replace(
    "as she lets out a helpless vocalization",
    "as she says <d>[Chinese] (S1) 嗷呜...</d>"
  );
  assert.throws(() => authorize(plan.targets[0], wrong), /新增或改写了未签发对白/u);
});
