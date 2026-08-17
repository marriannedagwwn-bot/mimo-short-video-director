import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_PROMPT_PROFILE_IDS,
  resolveVideoPromptProfile
} from "../public/video-prompt-profiles.js";
import {
  ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_MAX_ATTEMPTS,
  ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_SCHEMA_VERSION,
  animationShotPromptPartialRepairPrompt,
  mergeAnimationShotPromptPartialRepair,
  planAnimationShotPromptPartialRepair
} from "../src/animation-shot-prompt-partial-repair.js";
import {
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES,
  MiniMaxH3PromptError,
  assertMiniMaxH3BasePrompt,
  miniMaxH3PathToJsonPointer
} from "../src/minimax-h3-prompt.js";
import { contentDigest } from "../src/production-lineage.js";
import { OutputContractError } from "../src/validation.js";

const H3_PROFILE = resolveVideoPromptProfile({ provider: "MiniMax", model: "MiniMax-H3" });
const SEEDANCE_PROFILE = resolveVideoPromptProfile({
  provider: "Seedance",
  model: "doubao-seedance-2-0-260128"
});

function validH3Prompt({ dialogue = "", marker = "" } = {}) {
  return `integrated_multimodal_description: [Shot 1] Warm golden-hour light fills the locked rural courtyard. Xiaobaizi runs toward the bamboo mailbox, inserts the rolled notice completely, releases it, and holds the visible completed state. The camera follows in a restrained medium shot. ${dialogue} ${marker}`.trim()
    + `\noverall_soundscape: Light footsteps, paper friction, and a soft bamboo tap remain synchronized with the visible action.\nnon_diegetic_music: A restrained acoustic-guitar cue resolves after the notice is released.`;
}

function directShot({
  shotId = "A01",
  sourceSceneId = "S1",
  sceneId = "LOC01",
  durationSeconds = 5,
  videoPrompt = validH3Prompt(),
  dialogueOrSubtitle = ""
} = {}) {
  return {
    shotId,
    sourceSceneId,
    sceneId,
    durationSeconds,
    storyPurpose: "完成通知投递任务",
    emotionalTarget: "满足而放松",
    videoPrompt,
    cameraMotion: "中景跟随跑动，关键动作特写，结尾逆光中景",
    characterAction: "小白子跑到门口，把卷起的通知完全塞进竹筒信箱，松手后伸懒腰并停住",
    dialogueOrSubtitle,
    soundDesign: "脚步、纸张摩擦、竹筒轻响与乡村环境声",
    continuityNotes: "小白子的狼耳、服装、布袋、竹筒信箱和夕阳方向保持稳定",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: [
      "通知按顺序完全进入竹筒信箱并松手",
      "中景跟随、关键动作特写和结尾逆光中景按顺序出现"
    ]
  };
}

function candidatePlan({
  profile = H3_PROFILE,
  durationSeconds = 5,
  videoPrompt = validH3Prompt().split("\noverall_soundscape:")[0],
  dialogueOrSubtitle = ""
} = {}) {
  return {
    promptSchemaVersion: "3.0",
    productionStrategy: {
      format: "direct_shot_video",
      targetAspectRatio: "9:16",
      videoPromptProfile: structuredClone(profile)
    },
    visualBible: {
      animationStyle: "Japanese 2.5D animation",
      lighting: "physical warm golden-hour backlight"
    },
    characterReferencePrompts: [{
      characterName: "小白子",
      appearancePrompt: "Q-version wolf-eared girl, brown linen top, navy pinafore, light beige shoulder bag"
    }],
    sceneReferencePrompts: [{
      sceneId: "LOC01",
      environmentPrompt: "rural courtyard gate, bamboo mailbox, distant fields and hills"
    }],
    assetPrompts: [{ assetName: "竹筒信箱", imagePrompt: "natural bamboo tube mailbox" }],
    shotPlan: [
      directShot({ durationSeconds, videoPrompt, dialogueOrSubtitle }),
      directShot({
        shotId: "A02",
        sourceSceneId: "S2",
        sceneId: "LOC02",
        videoPrompt: validH3Prompt({ marker: "SECOND_SHOT_SENTINEL" })
      })
    ],
    unrelated: "UNRELATED_TOP_LEVEL_SENTINEL"
  };
}

function completeIntegratedOnlyPrompt(integratedPrompt, marker = "") {
  return `${integratedPrompt}\noverall_soundscape: ${marker} Light footsteps and paper friction remain synchronized with the visible action.\nnon_diegetic_music: A restrained acoustic-guitar cue resolves after the action.`;
}

function captureBasePromptError(plan, shotIndex = 0) {
  const shot = plan.shotPlan[shotIndex];
  try {
    assertMiniMaxH3BasePrompt(shot.videoPrompt, {
      durationSeconds: shot.durationSeconds,
      path: `animationPlan.shotPlan[${shotIndex}].videoPrompt`,
      dialogueTexts: dialogueOrSubtitleTexts(shot.dialogueOrSubtitle)
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected an H3 Base prompt error");
}

function dialogueOrSubtitleTexts(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/[；;\n]+/u)
    .map((item) => item.replace(/^\s*[^：:]{1,40}[：:]\s*/u, "").trim())
    .filter(Boolean);
}

function partialRepairContext(candidate, repairAttemptCount = 0) {
  return {
    repairAttemptCount,
    fullStory: {
      sceneScript: candidate.shotPlan.map((shot) => ({
        sceneId: shot.sourceSceneId,
        location: `${shot.sourceSceneId} 的权威地点`,
        characters: ["小白子"],
        visibleAction: shot.characterAction,
        dialogue: shot.dialogueOrSubtitle,
        shotAndSound: shot.soundDesign,
        shootingNotes: shot.cameraMotion
      }))
    },
    visualGuardrails: {
      fixedCharacterBoundary: {
        characterName: "小白子",
        canonicalDescription: "Q版狼耳少女",
        bodyForm: "保持人形少女结构与狼耳",
        requiredTraits: [],
        forbiddenTraits: [],
        sourceDigest: "source-digest",
        boundaryDigest: "boundary-digest",
        boundarySignature: "boundary-signature"
      }
    }
  };
}

function planRepair(candidate, error, repairAttemptCount = 0) {
  return planAnimationShotPromptPartialRepair(
    candidate,
    error,
    partialRepairContext(candidate, repairAttemptCount)
  );
}

function mergeRepair(candidate, repairEnvelope, plan) {
  return mergeAnimationShotPromptPartialRepair(
    candidate,
    repairEnvelope,
    plan,
    partialRepairContext(candidate)
  );
}

function envelope(plan, replacement) {
  return {
    schemaVersion: ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: plan.baseDigest,
    repairs: [{ repairId: "R1", replacement }]
  };
}

test("仅 integrated 段错误产生稳定 RFC6901 diagnostic 并只修 A01.videoPrompt", () => {
  const candidate = candidatePlan();
  const error = captureBasePromptError(candidate);
  assert.ok(error instanceof MiniMaxH3PromptError);
  assert.deepEqual(error.details, [{
    code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID,
    jsonPointer: "/animationPlan/shotPlan/0/videoPrompt",
    path: "/animationPlan/shotPlan/0/videoPrompt",
    reason: "H3 Base sections must each occur exactly once in the required order.",
    expected: [
      "integrated_multimodal_description",
      "overall_soundscape",
      "non_diegetic_music"
    ],
    actual: ["integrated_multimodal_description"]
  }]);
  assert.equal(
    miniMaxH3PathToJsonPointer("animationPlan.shotPlan[0].videoPrompt"),
    "/animationPlan/shotPlan/0/videoPrompt"
  );

  const plan = planRepair(candidate, error);
  assert.ok(plan);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].path, "/shotPlan/0/videoPrompt");
  assert.equal(plan.authority.profileLock.profileId, VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3);
  assert.equal(plan.authority.maximumRepairAttempts, 1);

  const prompt = animationShotPromptPartialRepairPrompt(plan);
  assert.match(prompt, /Current|currentValue|当前/u);
  assert.match(prompt, /integrated_multimodal_description/u);
  assert.match(prompt, /beginning of its own new line/u);
  assert.match(prompt, /\\n.*overall_soundscape/u);
  assert.match(prompt, /characterAction/u);
  assert.match(prompt, /characterReferencePrompts/u);
  assert.doesNotMatch(prompt, /SECOND_SHOT_SENTINEL/u);
  assert.doesNotMatch(prompt, /UNRELATED_TOP_LEVEL_SENTINEL/u);

  const beforeDigest = contentDigest(candidate);
  const repairedPrompt = validH3Prompt();
  const merged = mergeRepair(candidate, envelope(plan, repairedPrompt), plan);
  assert.equal(contentDigest(candidate), beforeDigest);
  assert.equal(merged.shotPlan[0].videoPrompt, repairedPrompt);
  assert.deepEqual(merged.shotPlan[0], { ...candidate.shotPlan[0], videoPrompt: repairedPrompt });
  assert.deepEqual(merged.shotPlan[1], candidate.shotPlan[1]);
  assert.equal(merged.unrelated, candidate.unrelated);

  const unrelatedStory = validH3Prompt().replace(
    /integrated_multimodal_description:[^\n]+/u,
    "integrated_multimodal_description: [Shot 1] A giant dragon destroys a neon city."
  );
  assert.throws(
    () => mergeRepair(candidate, envelope(plan, unrelatedStory), plan),
    /不得改写已合法的 integrated_multimodal_description 正文/u
  );

  const staleAuthority = partialRepairContext(candidate);
  staleAuthority.fullStory.sceneScript[0].visibleAction = "权威剧情已经改变";
  assert.throws(() => mergeAnimationShotPromptPartialRepair(
    candidate,
    envelope(plan, repairedPrompt),
    plan,
    staleAuthority
  ), /权威上下文已经失效/u);
});

test("同行 section 标签污染 integrated 时不得冻结正文或签发局部纠错", () => {
  const inlinePrompt = validH3Prompt()
    .replace("\noverall_soundscape:", " overall_soundscape:")
    .replace("\nnon_diegetic_music:", " non_diegetic_music:");
  const candidate = candidatePlan({ videoPrompt: inlinePrompt });
  const error = captureBasePromptError(candidate);

  assert.ok(error instanceof MiniMaxH3PromptError);
  assert.equal(error.details[0]?.code, MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID);
  assert.equal(planRepair(candidate, error), null);
});

test("所有 H3 Base 确定性失败族都携带稳定 code、Pointer、reason、expected 与 actual", async (t) => {
  const base = validH3Prompt();
  const timeline = base.replace(
    "Xiaobaizi runs toward",
    "[Shot 2] At 00:02.000, Xiaobaizi runs toward"
  );
  const cases = [
    {
      name: "prompt required",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PROMPT_REQUIRED,
      prompt: ""
    },
    {
      name: "sections invalid",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID,
      prompt: "integrated_multimodal_description: [Shot 1] The action completes."
    },
    {
      name: "prefix forbidden",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.PREFIX_FORBIDDEN,
      prompt: `Here is the prompt:\n${base}`
    },
    {
      name: "section empty",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTION_EMPTY,
      prompt: base.replace(/overall_soundscape:[^\n]*/u, "overall_soundscape:")
    },
    {
      name: "language invalid",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.LANGUAGE_INVALID,
      prompt: base.replace("Warm golden-hour", "温暖 golden-hour")
    },
    {
      name: "timeline start",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_START_REQUIRED,
      prompt: base.replace("[Shot 1]", "The shot begins:")
    },
    {
      name: "first timestamp",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_FIRST_TIMESTAMP_FORBIDDEN,
      prompt: base.replace("[Shot 1]", "[Shot 1] At 00:00.000,")
    },
    {
      name: "timeline sequence",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_SEQUENCE_INVALID,
      prompt: timeline.replace("[Shot 2]", "[Shot 3]")
    },
    {
      name: "timestamp required",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_REQUIRED,
      prompt: timeline.replace("[Shot 2] At 00:02.000,", "[Shot 2]")
    },
    {
      name: "timestamp range",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.TIMELINE_TIMESTAMP_OUT_OF_RANGE,
      prompt: timeline.replace("00:02.000", "00:05.000")
    },
    {
      name: "reference label forbidden",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.REFERENCE_LABEL_FORBIDDEN,
      prompt: base.replace("Xiaobaizi", "<Picture 1> guides Xiaobaizi")
    },
    {
      name: "dialogue tag invalid",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_TAG_INVALID,
      prompt: base.replace("The camera", "<d>[Chinese] Hello. The camera")
    },
    {
      name: "dialogue unauthorized",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_UNAUTHORIZED,
      prompt: base.replace("The camera", "<d>[Chinese] 新对白。</d> The camera")
    },
    {
      name: "dialogue count",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_COUNT_MISMATCH,
      prompt: base,
      dialogueTexts: ["你好。"]
    },
    {
      name: "dialogue missing",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_MISSING,
      prompt: base.replace(
        "The camera",
        "<d>[Chinese] 嗯。</d> <d>[Chinese] 嗯。</d> The camera"
      ),
      dialogueTexts: ["嗯。", "好。"]
    },
    {
      name: "dialogue order",
      code: MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_ORDER_MISMATCH,
      prompt: base.replace(
        "The camera",
        "<d>[Chinese] 第二句。</d> <d>[Chinese] 第一句。</d> The camera"
      ),
      dialogueTexts: ["第一句。", "第二句。"]
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.throws(
        () => assertMiniMaxH3BasePrompt(scenario.prompt, {
          durationSeconds: 5,
          path: "animationPlan.shotPlan[0].videoPrompt",
          dialogueTexts: scenario.dialogueTexts || []
        }),
        (error) => {
          const detail = error.details?.[0];
          return error instanceof MiniMaxH3PromptError
            && error.details.length === 1
            && detail.code === scenario.code
            && detail.jsonPointer === "/animationPlan/shotPlan/0/videoPrompt"
            && detail.path === detail.jsonPointer
            && typeof detail.reason === "string"
            && detail.reason.length > 0
            && Object.prototype.hasOwnProperty.call(detail, "expected")
            && Object.prototype.hasOwnProperty.call(detail, "actual");
        }
      );
    });
  }
});

test("局部 replacement 必须逐字保留签发对白", () => {
  const signedDialoguePrompt = validH3Prompt({
    dialogue: "Xiaobaizi says, <d>[Chinese] 我把通知送到了。</d>."
  }).split("\noverall_soundscape:")[0];
  const candidate = candidatePlan({
    dialogueOrSubtitle: "小白子：我把通知送到了。",
    videoPrompt: signedDialoguePrompt
  });
  const error = captureBasePromptError(candidate);
  const plan = planRepair(candidate, error);
  const rewritten = validH3Prompt({ dialogue: "Xiaobaizi says, <d>[Chinese] 通知已经送达。</d>." });

  assert.throws(
    () => mergeRepair(candidate, envelope(plan, rewritten), plan),
    (caught) => caught instanceof OutputContractError
      && caught.details[0]?.code === MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DIALOGUE_UNAUTHORIZED
  );
  assert.doesNotThrow(() => mergeRepair(
    candidate,
    envelope(plan, validH3Prompt({
      dialogue: "Xiaobaizi says, <d>[Chinese] 我把通知送到了。</d>."
    })),
    plan
  ));
});

test("integrated 正文自身不合法时不授权整段重写", () => {
  const candidate = candidatePlan({
    videoPrompt: validH3Prompt().replace(
      "Warm golden-hour",
      "温暖 golden-hour"
    )
  });
  const error = captureBasePromptError(candidate);
  assert.equal(error.details[0].code, MINIMAX_H3_BASE_DIAGNOSTIC_CODES.LANGUAGE_INVALID);
  assert.equal(planRepair(candidate, error), null);
});

test("integrated 正文中的 camera 标签行属于正文并被完整冻结", () => {
  const candidate = candidatePlan();
  candidate.shotPlan[0].videoPrompt = candidate.shotPlan[0].videoPrompt.replace(
    " The camera",
    "\ncamera: The camera"
  );
  const error = captureBasePromptError(candidate);
  const plan = planRepair(candidate, error);
  assert.ok(plan);
  assert.match(
    plan.targets[0].modelContext.preservedSections.integrated_multimodal_description,
    /^camera:/mu
  );
  const deletedCameraLine = completeIntegratedOnlyPrompt(
    candidate.shotPlan[0].videoPrompt.replace(/^camera:[^\n]*\n?/mu, "")
  );
  assert.throws(
    () => mergeRepair(candidate, envelope(plan, deletedCameraLine), plan),
    /不得改写已合法的 integrated_multimodal_description 正文/u
  );
});

test("唯一一次局部纠错仍返回坏 H3 Prompt 时明确失败且不签发第二次计划", () => {
  const candidate = candidatePlan();
  const error = captureBasePromptError(candidate);
  const plan = planRepair(candidate, error);
  assert.equal(ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_MAX_ATTEMPTS, 1);

  assert.throws(
    () => mergeRepair(
      candidate,
      envelope(plan, "integrated_multimodal_description: [Shot 1] The action ends."),
      plan
    ),
    (caught) => caught instanceof OutputContractError
      && caught.details[0]?.code === MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SECTIONS_INVALID
  );
  assert.equal(
    planRepair(candidate, error, 1),
    null
  );
});

test("多个可信 H3 Prompt diagnostics 在同一次调用中按 shot 分组且各自原子替换", () => {
  const candidate = candidatePlan();
  candidate.shotPlan[1].videoPrompt =
    "integrated_multimodal_description: [Shot 1] The second signed action completes.";
  const firstError = captureBasePromptError(candidate, 0);
  const secondError = captureBasePromptError(candidate, 1);
  const plan = planRepair(candidate, {
    details: [...firstError.details, ...secondError.details]
  });
  assert.deepEqual(plan.targets.map((target) => target.path), [
    "/shotPlan/0/videoPrompt",
    "/shotPlan/1/videoPrompt"
  ]);

  const firstReplacement = completeIntegratedOnlyPrompt(
    candidate.shotPlan[0].videoPrompt,
    "FIRST_REPAIRED_PROMPT"
  );
  const secondReplacement = completeIntegratedOnlyPrompt(
    candidate.shotPlan[1].videoPrompt,
    "SECOND_REPAIRED_PROMPT"
  );
  const merged = mergeRepair(candidate, {
    schemaVersion: ANIMATION_SHOT_PROMPT_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: plan.baseDigest,
    repairs: [
      { repairId: "R1", replacement: firstReplacement },
      { repairId: "R2", replacement: secondReplacement }
    ]
  }, plan);
  assert.equal(merged.shotPlan[0].videoPrompt, firstReplacement);
  assert.equal(merged.shotPlan[1].videoPrompt, secondReplacement);
});

test("非 H3 Profile 与 3 秒 H3 Plan 都不能借 Prompt 局部纠错降级或改时长", () => {
  const h3Candidate = candidatePlan();
  const error = captureBasePromptError(h3Candidate);
  const seedanceCandidate = candidatePlan({ profile: SEEDANCE_PROFILE });
  assert.equal(
    planRepair(seedanceCandidate, error),
    null
  );
  const shortCandidate = candidatePlan({ durationSeconds: 3 });
  assert.equal(
    planRepair(shortCandidate, error),
    null
  );

  let durationError;
  try {
    assertMiniMaxH3BasePrompt(validH3Prompt(), {
      durationSeconds: 3,
      path: "animationPlan.shotPlan[0].videoPrompt"
    });
  } catch (caught) {
    durationError = caught;
  }
  assert.equal(durationError.details[0].code, MINIMAX_H3_BASE_DIAGNOSTIC_CODES.DURATION_INVALID);
  assert.equal(durationError.details[0].jsonPointer, "/animationPlan/shotPlan/0/durationSeconds");
  assert.deepEqual(durationError.details[0].expected, { type: "integer", minimum: 4, maximum: 15 });
  assert.equal(durationError.details[0].actual, 3);
});
