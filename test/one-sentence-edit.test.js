import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowService } from "../src/workflow.js";
import { InputError, OutputContractError, NO_BACKGROUND_MUSIC_SENTENCE } from "../src/validation.js";
import { contentDigest } from "../src/production-lineage.js";
import { STORY_SOURCE_SCHEMA_VERSION } from "../public/story-entry.js";
import {
  ONE_SENTENCE_EDIT_MAX_PATCHES,
  applyOneSentenceEdit,
  chosenRoleImageCount,
  ensureOneSentenceEditContract,
  oneSentenceEditDependents,
  oneSentenceEditInvalidation,
  oneSentenceStoryboardEditablePaths,
  storyboardChangeLabel
} from "../src/one-sentence-edit.js";
import {
  ONE_SENTENCE_EDIT_PROMPT_MARKER,
  ONE_SENTENCE_EDIT_SYSTEM_PROMPT
} from "../src/one-sentence-edit-prompts.js";
import { STORY_REPAIR_MAX_PATCHES, applyStoryRepairPatches } from "../src/story-quality-repair.js";

// 一句话修改（2026-10-11，导演 Agent 第三期）：模型只写「在某个字段里找到唯一一段原文 → 换成什么」，
// 原文由服务端逐字替换；剧情、4.0 分镜、单镜提示词各自过签发时的同一套校验，做不到的写 decline。
// 夹具全部来自演示模式，没有任何真实模型结果。

const FIXTURE_TEXT = "雨夜，阿岚在社区修理铺里听见门外有小猫在叫。阿岚撑伞出门，在台阶下找到一只湿透的小猫。阿岚说：“别怕，我带你进屋。”她用旧毛巾把小猫擦干，又把一盏坏了的暖灯修好放在纸箱旁。天亮时，小猫在暖灯下睡着了。";

const fixturePromise = (async () => {
  const workflow = new WorkflowService();
  const creatorProfile = { fixedCharacter: "阿岚，社区修理师", vertical: "动画", constraints: "" };
  const storySource = { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode: "fullStoryText", storyText: FIXTURE_TEXT };
  const storyEntry = { storyMode: "fullStoryText", storySource };
  const visualGuardrails = await workflow.createStoryEntryVisualGuardrails({ creatorProfile }, { storyEntry });
  const fullStory = await workflow.createFullStory({ creatorProfile, visualGuardrails, fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 60 }, { storyEntry });
  const plan = (await workflow.createAnimationPlanWithMetadata({
    creatorProfile, visualGuardrails, fullStory, animationPlanVersion: "4.0", animationPlanMode: "direct_shot",
    targetAspectRatio: "16:9", backgroundMusicEnabled: false, artStyle: "二维日系动画"
  }, { storyEntry })).animationPlan;
  const shotPrompt = await workflow.createShotVideoPrompt({
    plan, shotId: "A01", planDigest: contentDigest(plan), target: { provider: "Seedance", model: "doubao-seedance-2-0-260128" }
  });
  return { workflow, creatorProfile, storyEntry, visualGuardrails, fullStory, plan, shotPrompt };
})();

async function contexts() {
  const fixture = await fixturePromise;
  const { workflow, creatorProfile, visualGuardrails, storyEntry } = fixture;
  const fullStory = structuredClone(fixture.fullStory);
  const plan = structuredClone(fixture.plan);
  return {
    fixture,
    story: () => workflow.oneSentenceEditContext({ target: "story", creatorProfile, visualGuardrails, fullStory }, { storyEntry }),
    storyboard: (value = plan) => workflow.oneSentenceEditContext({ target: "storyboard", creatorProfile, visualGuardrails, fullStory, animationPlan: value }, { storyEntry }),
    shotPrompt: (value = fixture.shotPrompt) => workflow.oneSentenceEditContext({ target: "shotPrompt", animationPlan: plan, shotPrompt: value, shotId: "A01" })
  };
}

function rejectsWith(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OutputContractError, `应为 OutputContractError，实际 ${error?.name}: ${error?.message}`);
    assert.ok(error.details.some((detail) => detail.code === code), `诊断里没有 ${code}：${JSON.stringify(error.details)}`);
    return true;
  });
}

// ---- 输出结构 ----

test("输出结构：只认 decision / patches / note 三个键，修改形状按对象各自核对，诊断带 code 与指针", () => {
  const ok = ensureOneSentenceEditContract({ decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "a", replace: "b" }], note: "改了一处" }, "story");
  assert.equal(ok.decision, "edit");
  assert.deepEqual(ensureOneSentenceEditContract({ decision: "decline", patches: [], note: "要加一个新角色，做不到" }, "story").patches, []);
  const codes = (value, target) => {
    try {
      ensureOneSentenceEditContract(value, target);
    } catch (error) {
      assert.ok(error instanceof OutputContractError);
      return error.details.map((detail) => detail.code);
    }
    return [];
  };
  assert.deepEqual(codes("文字", "story"), ["ONE_SENTENCE_EDIT_OUTPUT_INVALID"]);
  assert.ok(codes({ decision: "edit", patches: [], note: "x", extra: 1 }, "story").includes("ONE_SENTENCE_EDIT_OUTPUT_INVALID"));
  assert.ok(codes({ decision: "maybe", patches: [], note: "x" }, "story").includes("ONE_SENTENCE_EDIT_DECISION_INVALID"));
  assert.ok(codes({ decision: "decline", patches: [], note: "  " }, "story").includes("ONE_SENTENCE_EDIT_NOTE_MISSING"));
  assert.ok(codes({ decision: "decline", patches: [], note: "字".repeat(301) }, "story").includes("ONE_SENTENCE_EDIT_NOTE_TOO_LONG"));
  assert.ok(codes({ decision: "edit", patches: [], note: "x" }, "story").includes("ONE_SENTENCE_EDIT_PATCH_COUNT"));
  assert.ok(codes({ decision: "decline", patches: [{ find: "a", replace: "b" }], note: "x" }, "shotPrompt").includes("ONE_SENTENCE_EDIT_PATCH_COUNT"));
  const many = Array.from({ length: ONE_SENTENCE_EDIT_MAX_PATCHES + 1 }, () => ({ find: "a", replace: "b" }));
  assert.ok(codes({ decision: "edit", patches: many, note: "x" }, "shotPrompt").includes("ONE_SENTENCE_EDIT_PATCH_COUNT"));
  // 每类修改的键各不相同：剧情要 sceneId + field，分镜要 path，提示词只有 find / replace。
  assert.ok(codes({ decision: "edit", patches: [{ find: "a", replace: "b" }], note: "x" }, "story").includes("ONE_SENTENCE_EDIT_PATCH_INVALID"));
  assert.ok(codes({ decision: "edit", patches: [{ path: ["a"], find: "a", replace: "b", sceneId: "S1" }], note: "x" }, "storyboard").includes("ONE_SENTENCE_EDIT_PATCH_INVALID"));
  assert.ok(codes({ decision: "edit", patches: [{ path: [0], find: "a", replace: "b" }], note: "x" }, "storyboard").includes("ONE_SENTENCE_EDIT_PATH_INVALID"));
  assert.ok(codes({ decision: "edit", patches: [{ find: "", replace: "b" }], note: "x" }, "shotPrompt").includes("ONE_SENTENCE_EDIT_FIND_EMPTY"));
  assert.ok(codes({ decision: "edit", patches: [{ find: "a", replace: null }], note: "x" }, "shotPrompt").includes("ONE_SENTENCE_EDIT_REPLACE_INVALID"));
  // 场次字段与全片字段分开：写了场次只能改场次字段，sceneId 为空只能改两份梗概；时间、地点、出镜名单一律不能改。
  for (const [patch, expected] of [
    [{ sceneId: "S1", field: "location", find: "a", replace: "b" }, true],
    [{ sceneId: "S1", field: "characters", find: "a", replace: "b" }, true],
    [{ sceneId: "S1", field: "oneLinePremise", find: "a", replace: "b" }, true],
    [{ sceneId: "", field: "visibleAction", find: "a", replace: "b" }, true],
    [{ sceneId: "", field: "shootingSynopsis", find: "a", replace: "b" }, false],
    [{ sceneId: "S1", field: "emotionNode", find: "a", replace: "b" }, false]
  ]) {
    assert.equal(codes({ decision: "edit", patches: [patch], note: "x" }, "story").includes("ONE_SENTENCE_EDIT_FIELD_NOT_ALLOWED"), expected, JSON.stringify(patch));
  }
});

// ---- 剧情 ----

test("剧情：逐字替换一处，只改这一处；改动清单写明场次与字段，结果摘要就是签发内容的摘要", async () => {
  const { story } = await contexts();
  const context = story();
  const applied = applyOneSentenceEdit(context, [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }]);
  assert.equal(applied.content.sceneScript[1].visibleAction, context.base.sceneScript[1].visibleAction.replace("天气和路程", "大雨和路程"));
  const restored = structuredClone(applied.content);
  restored.sceneScript[1].visibleAction = context.base.sceneScript[1].visibleAction;
  assert.deepEqual(restored, context.base, "可写字段之外逐字节不变");
  assert.deepEqual(applied.changes.map((change) => change.label), ["S2 · 动作"]);
  assert.equal(applied.resultDigest, contentDigest(applied.content));
  // 同一组修改在同一份原稿上再应用一次，摘要相同——采纳时服务端靠它核对签发的就是预览里那一份。
  assert.equal(applyOneSentenceEdit(story(), [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }]).resultDigest, applied.resultDigest);
});

test("剧情：情绪节点、剧情功能与两份梗概可以跟着改；整句删掉一句台词；原文找不到或不唯一就拒", async () => {
  const { story } = await contexts();
  const emotion = applyOneSentenceEdit(story(), [{ sceneId: "S2", field: "emotionNode", find: "压力上升", replace: "压力骤增" }]);
  assert.equal(emotion.content.sceneScript[1].emotionNode, "压力骤增");
  assert.deepEqual(emotion.changes.map((change) => change.label), ["S2 · 情绪节点"]);
  const premise = story().base.oneLinePremise;
  const top = applyOneSentenceEdit(story(), [{ sceneId: "", field: "oneLinePremise", find: premise.slice(0, 6), replace: `${premise.slice(0, 6)}（雨夜）` }]);
  assert.deepEqual(top.changes.map((change) => change.label), ["全片 · 一句话梗概"]);
  const deleted = applyOneSentenceEdit(story(), [{ sceneId: "S3", field: "dialogue", find: "没事，东西没坏。", replace: "" }]);
  assert.deepEqual(deleted.content.sceneScript[2].dialogue, []);
  assert.deepEqual(deleted.changes.map((change) => [change.label, change.after]), [["S3 · 台词", ""]]);
  rejectsWith(() => applyOneSentenceEdit(story(), [{ sceneId: "S2", field: "visibleAction", find: "原文里没有的话", replace: "x" }]), "STORY_REPAIR_FIND_NOT_FOUND");
  rejectsWith(() => applyOneSentenceEdit(story(), [{ sceneId: "S5", field: "visibleAction", find: "看", replace: "望" }]), "STORY_REPAIR_FIND_NOT_UNIQUE");
  rejectsWith(() => applyOneSentenceEdit(story(), [{ sceneId: "S9", field: "visibleAction", find: "a", replace: "b" }]), "STORY_REPAIR_SCENE_NOT_FOUND");
});

test("剧情：不能让出镜角色从一场里消失，不能把不在画面里的人写进动作——都由签发时的同一套校验拦下", async () => {
  const { story } = await contexts();
  rejectsWith(() => applyOneSentenceEdit(story(), [
    { sceneId: "S4", field: "visibleAction", find: "路过的热心帮手没有问太多，只递出解决眼前问题的工具或线索。", replace: "" },
    { sceneId: "S4", field: "dialogue", find: "你要的是这个吧？拿去，来得及。", replace: "" }
  ]), "STORY_REPAIR_REMOVES_ON_SCREEN_CHARACTER");
  assert.throws(() => applyOneSentenceEdit(story(), [
    { sceneId: "S2", field: "visibleAction", find: "阿岚调整路线", replace: "阿岚和路过的热心帮手一起调整路线" }
  ]), (error) => error instanceof OutputContractError && /改完之后剧情没有通过签发校验/u.test(error.message) && error.details.length > 0);
});

test("「按问题修改」不受影响：默认仍是最多 3 处、只能改动作 / 镜头与声音 / 台词", async () => {
  const { story } = await contexts();
  const base = story().base;
  assert.equal(STORY_REPAIR_MAX_PATCHES, 3);
  assert.throws(() => applyStoryRepairPatches(base, Array.from({ length: 4 }, () => ({ sceneId: "S2", field: "visibleAction", find: "天气", replace: "大雨" }))),
    (error) => error.code === "STORY_REPAIR_PATCH_TOO_MANY");
  assert.throws(() => applyStoryRepairPatches(base, [{ sceneId: "S2", field: "emotionNode", find: "压力上升", replace: "压力骤增" }]),
    (error) => error.code === "STORY_REPAIR_FIELD_NOT_ALLOWED");
  assert.throws(() => applyStoryRepairPatches(base, [{ sceneId: "", field: "oneLinePremise", find: "阿岚", replace: "阿蓝" }]),
    (error) => error.code === "STORY_REPAIR_SCENE_NOT_FOUND", "不传全片字段时，空场次照旧按场次找");
});

// ---- 分镜 ----

test("分镜：改一拍的动作，标签写镜头号与拍号；已设为人物参考图的图与目标之外逐字节不变", async () => {
  const { fixture, storyboard } = await contexts();
  const plan = structuredClone(fixture.plan);
  plan.characterReferencePrompts[0] = { ...plan.characterReferencePrompts[0], referenceImageAdded: true, referenceImageDataUrl: "data:image/png;base64,AAAA" };
  const context = storyboard(plan);
  assert.equal(chosenRoleImageCount(context.base), 1);
  const text = context.base.shotPlan[1].beats[0].visibleAction;
  const applied = applyOneSentenceEdit(context, [{ path: ["shotPlan", "1", "beats", "0", "visibleAction"], find: "调整路线", replace: "绕开积水调整路线" }]);
  assert.equal(applied.content.shotPlan[1].beats[0].visibleAction, text.replace("调整路线", "绕开积水调整路线"));
  assert.deepEqual(applied.content.characterReferencePrompts, context.base.characterReferencePrompts);
  const restored = structuredClone(applied.content);
  restored.shotPlan[1].beats[0].visibleAction = text;
  assert.deepEqual(restored, context.base);
  assert.deepEqual(applied.changes.map((change) => change.label), ["A02 · 第 1 拍 · 动作"]);
  // 分镜里的台词正文可以改；说话人、画内画外、出镜名单、角色外观与人物参考不能改。
  const line = applyOneSentenceEdit(storyboard(), [{ path: ["shotPlan", "0", "beats", "0", "dialogue", "0", "text"], find: "我现在去。", replace: "我这就去。" }]);
  assert.deepEqual(line.changes.map((change) => change.label), ["A01 · 第 1 拍 · 台词"]);
  for (const path of [
    ["visualDesign", "characters", "0", "appearance"],
    ["shotPlan", "0", "beats", "0", "dialogue", "0", "speaker"],
    ["shotPlan", "0", "beats", "0", "dialogue", "0", "source"],
    ["shotPlan", "0", "beats", "0", "characters", "0"],
    ["shotPlan", "0", "sourceSceneIds", "0"],
    ["shotPlan", "0", "durationSeconds"],
    ["characterReferencePrompts", "0", "appearancePrompt"],
    ["productionStrategy", "artStyle"]
  ]) {
    rejectsWith(() => applyOneSentenceEdit(storyboard(), [{ path, find: "阿", replace: "啊" }]), "ONE_SENTENCE_EDIT_PATH_NOT_ALLOWED");
  }
  const editable = oneSentenceStoryboardEditablePaths(context.base).map((entry) => entry.path.join("/"));
  assert.equal(editable.some((path) => path.startsWith("visualDesign/characters")), false);
  assert.ok(editable.includes("shotPlan/1/beats/0/visibleAction"));
});

test("分镜：原文找不到、不唯一、改成空的、改完过不了分镜校验，都拒并带诊断", async () => {
  const { storyboard } = await contexts();
  const path = ["shotPlan", "1", "beats", "0", "visibleAction"];
  rejectsWith(() => applyOneSentenceEdit(storyboard(), [{ path, find: "原文里没有的话", replace: "x" }]), "ONE_SENTENCE_EDIT_FIND_NOT_FOUND");
  rejectsWith(() => applyOneSentenceEdit(storyboard(), [{ path: ["shotPlan", "4", "beats", "0", "visibleAction"], find: "看", replace: "望" }]), "ONE_SENTENCE_EDIT_FIND_NOT_UNIQUE");
  const whole = (await contexts()).fixture.plan.shotPlan[1].beats[0].visibleAction;
  rejectsWith(() => applyOneSentenceEdit(storyboard(), [{ path, find: whole, replace: "" }]), "ONE_SENTENCE_EDIT_EMPTY_RESULT");
  // 只有首段能是 start：把第二段的衔接类型改成 start，分镜校验不通过。
  rejectsWith(() => applyOneSentenceEdit(storyboard(), [{ path: ["shotPlan", "1", "transitionIn", "type"], find: "cut", replace: "start" }]), "ONE_SENTENCE_EDIT_RESULT_INVALID");
});

test("分镜修改的标签：镜头、拍、视觉设定与改编说明各有中文名", async () => {
  const { fixture } = await contexts();
  const plan = fixture.plan;
  assert.equal(storyboardChangeLabel(plan, ["shotPlan", "2", "beats", "1", "camera"]), "A03 · 第 2 拍 · 运镜");
  assert.equal(storyboardChangeLabel(plan, ["shotPlan", "0", "continuityOut"]), "A01 · 衔接");
  assert.equal(storyboardChangeLabel(plan, ["shotPlan", "0", "transitionIn", "description"]), "A01 · 转场说明");
  assert.equal(storyboardChangeLabel(plan, ["shotPlan", "0", "acceptanceCriteria", "0"]), "A01 · 验收标准");
  assert.equal(storyboardChangeLabel(plan, ["visualDesign", "locations", "0", "lighting"]), `场景「${plan.visualDesign.locations[0].name}」 · 光线`);
  assert.equal(storyboardChangeLabel(plan, ["viewingIntent"]), "观看重点");
});

// ---- 单镜提示词 ----

test("单镜提示词：只换提示词正文，版本、镜头号、对应分镜、视频模型与写稿模型原样保留（弹窗缓存照常命中）", async () => {
  const { fixture, shotPrompt } = await contexts();
  const context = shotPrompt();
  const applied = applyOneSentenceEdit(context, [{ find: "固定机位", replace: "缓慢推近" }]);
  assert.deepEqual({ ...applied.content, videoPrompt: "" }, { ...fixture.shotPrompt, videoPrompt: "" });
  assert.equal(applied.content.videoPrompt, fixture.shotPrompt.videoPrompt.replace("固定机位", "缓慢推近"));
  assert.equal(applied.afterText, applied.content.videoPrompt);
  assert.deepEqual(applied.changes, [{ label: "A01 · 提示词第 1 处", before: "固定机位", after: "缓慢推近" }]);
});

test("单镜提示词：不能整段重写；台词、画风、无配乐收尾句少一个都拒", async () => {
  const { fixture, shotPrompt } = await contexts();
  const text = fixture.shotPrompt.videoPrompt;
  assert.ok(text.endsWith(NO_BACKGROUND_MUSIC_SENTENCE));
  rejectsWith(() => applyOneSentenceEdit(shotPrompt(), [{ find: text, replace: "重写的一整段" }]), "ONE_SENTENCE_EDIT_WHOLE_TEXT");
  rejectsWith(() => applyOneSentenceEdit(shotPrompt(), [{ find: "我现在去。", replace: "" }]), "SHOT_PROMPT_DIALOGUE_MISSING");
  rejectsWith(() => applyOneSentenceEdit(shotPrompt(), [{ find: "二维日系动画", replace: "水彩绘本" }]), "SHOT_PROMPT_ART_STYLE_MISSING");
  rejectsWith(() => applyOneSentenceEdit(shotPrompt(), [{ find: NO_BACKGROUND_MUSIC_SENTENCE, replace: "配一段轻快的钢琴。" }]), "SHOT_PROMPT_BACKGROUND_MUSIC_SENTENCE");
  rejectsWith(() => applyOneSentenceEdit(shotPrompt(), [{ find: "不存在的片段", replace: "x" }]), "ONE_SENTENCE_EDIT_FIND_NOT_FOUND");
});

// ---- 采纳后会作废什么 ----

test("作废清单：沿依赖递归找当前版本的下游，与状态库 propagateStale 同一口径；不是当前版本的不算", () => {
  const ref = (artifactId) => ({ artifactId, revision: `${artifactId}-r1`, contentDigest: "d".repeat(64) });
  const entry = (dependencies, status = "current") => ({ lineage: { status, dependencies: dependencies.map(ref) } });
  const latest = {
    "fullStory:V1": entry(["storySource", "visualGuardrails"]),
    "animationPlan:V1": entry(["fullStory:V1", "storySource", "visualGuardrails"]),
    "shotVideoPrompt:V1:A01": entry(["animationPlan:V1"]),
    "shotVideo:V1:A01": entry(["animationPlan:V1"]),
    "shotVideo:V1:A02": entry(["animationPlan:V1", "shotVideo:V1:A01"]),
    "characterImages:V1:0": entry(["animationPlan:V1"]),
    "shotVideo:V1:A03": entry(["animationPlan:V1"], "stale"),
    "variant:V2": entry(["themeVariants"])
  };
  assert.deepEqual(oneSentenceEditDependents(latest, "fullStory:V1"),
    ["animationPlan:V1", "characterImages:V1:0", "shotVideo:V1:A01", "shotVideo:V1:A02", "shotVideoPrompt:V1:A01"]);
  assert.deepEqual(oneSentenceEditInvalidation(latest, "animationPlan:V1", { roleImagesKept: 2 }), {
    artifactIds: ["characterImages:V1:0", "shotVideo:V1:A01", "shotVideo:V1:A02", "shotVideoPrompt:V1:A01"],
    counts: { animationPlan: 0, shotVideoPrompt: 1, shotVideo: 2, characterImages: 1, other: 0 },
    roleImagesLost: 0,
    roleImagesKept: 2
  });
  assert.deepEqual(oneSentenceEditDependents(latest, "shotVideoPrompt:V1:A01"), [], "改提示词什么都不作废");
});

// ---- 模型调用 ----

function liveWorkflow(answers, fixture) {
  const requests = [];
  const client = {
    requestCompletion: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (typeof next === "function") return next(request);
      return { content: typeof next === "string" ? next : JSON.stringify(next), finishReason: "stop", usage: null };
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    stageDefaults: { oneSentenceEdit: { provider: "MiMo", model: "mimo-v2.6-pro", maxCompletionTokens: 32768 } },
    groundingKey: fixture.workflow.groundingKey,
    characterBoundaryKey: fixture.workflow.characterBoundaryKey
  });
  return { workflow, requests };
}

function storyInput(fixture, overrides = {}) {
  return {
    target: "story", instruction: "第二场改成雨越下越大", creatorProfile: fixture.creatorProfile,
    visualGuardrails: fixture.visualGuardrails, fullStory: structuredClone(fixture.fullStory), ...overrides
  };
}

test("演示模式：三类修改都不调用模型、调用次数写 0，修改稿的补丁在采纳时重新应用得到同一个摘要", async () => {
  const fixture = await fixturePromise;
  const { workflow, storyEntry } = fixture;
  const inputs = {
    story: storyInput(fixture),
    storyboard: { ...storyInput(fixture), target: "storyboard", instruction: "A02 别让她回头", animationPlan: structuredClone(fixture.plan) },
    shotPrompt: { target: "shotPrompt", instruction: "镜头慢一点", shotId: "A01", animationPlan: structuredClone(fixture.plan), shotPrompt: structuredClone(fixture.shotPrompt) }
  };
  for (const [target, input] of Object.entries(inputs)) {
    const draft = await workflow.createOneSentenceEdit(input, { storyEntry: target === "shotPrompt" ? null : storyEntry });
    assert.equal(draft.decision, "edit", target);
    assert.equal(draft.metadata.oneSentenceEdit.providerCalls, 0);
    const adopted = workflow.applyOneSentenceEditPatches({ ...input, patches: draft.patches }, { storyEntry: target === "shotPrompt" ? null : storyEntry });
    assert.equal(adopted.resultDigest, draft.resultDigest, target);
  }
  const declined = await workflow.createOneSentenceEdit(storyInput(fixture, { instruction: "加一只小狗" }), { storyEntry });
  assert.equal(declined.decision, "decline");
  assert.deepEqual(declined.changes, []);
});

test("真实调用：换掉系统提示词；用户原话放在尖括号里；只送剧情与固定角色事实", async () => {
  const fixture = await fixturePromise;
  const scene = fixture.fullStory.sceneScript[1];
  const { workflow, requests } = liveWorkflow([
    { decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }], note: "把天气改成大雨。" }
  ], fixture);
  const draft = await workflow.createOneSentenceEdit(storyInput(fixture), { storyEntry: fixture.storyEntry });
  assert.equal(draft.decision, "edit");
  assert.equal(draft.changes[0].after, scene.visibleAction.replace("天气和路程", "大雨和路程"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].systemPrompt, ONE_SENTENCE_EDIT_SYSTEM_PROMPT);
  assert.equal(requests[0].model, "mimo-v2.6-pro");
  assert.equal(requests[0].maxCompletionTokens, 32768);
  assert.equal(Object.hasOwn(requests[0], "thinking"), false, "不改思考设置");
  const prompt = requests[0].prompt;
  assert.ok(prompt.startsWith(`${ONE_SENTENCE_EDIT_PROMPT_MARKER}。`));
  assert.ok(prompt.includes("## 修改对象：完整剧情"));
  assert.ok(prompt.includes("<<<\n第二场改成雨越下越大\n>>>"));
  assert.ok(prompt.includes("## 固定角色事实（不能违背）"));
  assert.equal(prompt.includes(FIXTURE_TEXT), false, "原文不进修改提示词，只送已经拆好的剧情");
});

test("真实调用：结构错或执行不了带诊断重试一次；两次都不行如实报错、两次诊断都在，禁止第三次", async () => {
  const fixture = await fixturePromise;
  const valid = { decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }], note: "改了。" };
  const retried = liveWorkflow([{ ...valid, extra: 1 }, valid], fixture);
  const draft = await retried.workflow.createOneSentenceEdit(storyInput(fixture), { storyEntry: fixture.storyEntry });
  assert.equal(draft.metadata.oneSentenceEdit.providerCalls, 2);
  assert.equal(draft.metadata.oneSentenceEdit.rejections.length, 1);
  assert.match(retried.requests[1].prompt, /## 上一次的输出被程序拦下了/u);
  assert.match(retried.requests[1].prompt, /ONE_SENTENCE_EDIT_OUTPUT_INVALID/u);

  const notFound = { decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "原文里没有的话", replace: "x" }], note: "改了。" };
  const failing = liveWorkflow([notFound, notFound, valid], fixture);
  await assert.rejects(() => failing.workflow.createOneSentenceEdit(storyInput(fixture), { storyEntry: fixture.storyEntry }), (error) => {
    assert.equal(error.name, "ModelPipelineError");
    assert.deepEqual(error.diagnostics.map((detail) => detail?.metadata?.attempt), [1, 2]);
    return true;
  });
  assert.equal(failing.requests.length, 2);
  assert.match(failing.requests[1].prompt, /STORY_REPAIR_FIND_NOT_FOUND/u);
});

test("真实调用：内容审核拦截不重试；做不到时写 decline，不出修改", async () => {
  const fixture = await fixturePromise;
  const filtered = liveWorkflow([
    () => ({ content: "The request was rejected because it was considered high risk", finishReason: "content_filter", usage: null }),
    { decision: "decline", patches: [], note: "不该被调用" }
  ], fixture);
  await assert.rejects(() => filtered.workflow.createOneSentenceEdit(storyInput(fixture), { storyEntry: fixture.storyEntry }), (error) => error.code === "MODEL_CONTENT_FILTERED");
  assert.equal(filtered.requests.length, 1);
  const declining = liveWorkflow([{ decision: "decline", patches: [], note: "加新角色要登记出镜名单，一句话修改做不到。" }], fixture);
  const draft = await declining.workflow.createOneSentenceEdit(storyInput(fixture, { instruction: "加一只小狗" }), { storyEntry: fixture.storyEntry });
  assert.deepEqual([draft.decision, draft.resultDigest, draft.changes.length], ["decline", "", 0]);
});

test("分镜与提示词的修改提示词：不送完整剧情和参考图数据；写明可写位置与必须逐字保留的几项", async () => {
  const fixture = await fixturePromise;
  const plan = structuredClone(fixture.plan);
  plan.characterReferencePrompts[0] = { ...plan.characterReferencePrompts[0], referenceImageAdded: true, referenceImageDataUrl: "data:image/png;base64,QUJD" };
  const board = liveWorkflow([{ decision: "decline", patches: [], note: "话没说清楚。" }], fixture);
  await board.workflow.createOneSentenceEdit({ ...storyInput(fixture), target: "storyboard", instruction: "改一下", animationPlan: plan }, { storyEntry: fixture.storyEntry });
  const boardPrompt = board.requests[0].prompt;
  assert.ok(boardPrompt.includes("## 修改对象：分镜"));
  assert.ok(boardPrompt.includes("## 可写位置（不在这里的位置一律不能改）"));
  assert.equal(boardPrompt.includes("data:image"), false, "人物参考图的数据不进提示词");
  assert.equal(boardPrompt.includes("sceneScript"), false, "不送完整剧情");
  assert.equal(boardPrompt.includes("[\"visualDesign\",\"characters\""), false, "角色外观不在可写位置里");

  const prompt = liveWorkflow([{ decision: "decline", patches: [], note: "话没说清楚。" }], fixture);
  await prompt.workflow.createOneSentenceEdit({ target: "shotPrompt", instruction: "改一下", shotId: "A01", animationPlan: structuredClone(fixture.plan), shotPrompt: structuredClone(fixture.shotPrompt) });
  const shotText = prompt.requests[0].prompt;
  assert.ok(shotText.includes("## 修改对象：A01 的视频提示词"));
  assert.ok(shotText.includes("- 台词原话：我现在去。"));
  assert.ok(shotText.includes("- 画风：二维日系动画"));
  assert.ok(shotText.includes(`- 最后一句必须仍是：${NO_BACKGROUND_MUSIC_SENTENCE}`));
  assert.ok(shotText.includes(`<<<\n${fixture.shotPrompt.videoPrompt}\n>>>`));
});

test("调用之前就拒：话为空或太长、当前版本自己过不了签发校验、旧格式剧情——一次都不调用模型", async () => {
  const fixture = await fixturePromise;
  const { workflow, requests } = liveWorkflow([], fixture);
  const reject = async (input, pattern, storyEntry = fixture.storyEntry) => assert.rejects(
    () => workflow.createOneSentenceEdit(input, { storyEntry }),
    (error) => error instanceof InputError && pattern.test(error.message)
  );
  await reject(storyInput(fixture, { instruction: "   " }), /instruction 不能为空/u);
  await reject(storyInput(fixture, { instruction: "字".repeat(501) }), /不能超过 500 字/u);
  await reject(storyInput(fixture, { target: "title" }), /对象只能是/u);
  const broken = structuredClone(fixture.shotPrompt);
  broken.videoPrompt = broken.videoPrompt.replace("二维日系动画", "水彩");
  await reject({ target: "shotPrompt", instruction: "镜头慢一点", shotId: "A01", animationPlan: structuredClone(fixture.plan), shotPrompt: broken },
    /A01 现在的提示词本身没有通过校验，一句话修改不能在它上面改/u, null);
  const legacy = structuredClone(fixture.fullStory);
  delete legacy.schemaVersion;
  await reject(storyInput(fixture, { fullStory: legacy }), /只支持 full_story\/1\.1/u);
  assert.equal(requests.length, 0);
});
