import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mockBrief, mockFullStory, mockNarrativeFullStory, mockReconstruction, mockStoryQualityReview, mockVariants } from "../src/mock.js";
import { storyQualityEditorialPrompt, storyQualityPromisePrompt, storyQualityRepairPrompt } from "../src/prompts.js";
import { storyQualityRepairableItems } from "../public/story-review-metrics.js";
import { assembleStoryQualityReview, buildStoryQualityCandidateProjection } from "../src/story-quality-review.js";
import {
  StoryRepairPatchError,
  applyStoryRepairPatches,
  assertOnlyStoryRepairFieldsChanged,
  ensureStoryQualityRepairContract,
  mergeStoryQualityRepairs,
  selectStoryQualityRepairItems,
  storyQualityKeptPromises
} from "../src/story-quality-repair.js";
import { InputError, OutputContractError, ensureOutputContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";
import { groundingContextDigest, sealReconstruction } from "../src/reconstruction-grounding.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 必须用 full_story/1.1：按问题修改只接受新格式，legacy 那份另有 beatSheet 这第二份动作稿。
const context = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版狼耳少女", vertical: "治愈/温情/日常", constraints: "" },
  variant: { id: "V1", title: "测试变体" }
});
const story = () => mockNarrativeFullStory(context);
const themeVariants = () => mockVariants(context);

function reviewFor(value) {
  const candidate = buildStoryQualityCandidateProjection(
    themeVariants().variants.find((item) => item.id === value.selectedVariantId)
  );
  return assembleStoryQualityReview({ fullStory: value, candidate, ...mockStoryQualityReview(value, candidate) });
}

function upstreamFor(workflow) {
  const source = sealReconstruction(
    mockReconstruction({}),
    workflow.groundingKey,
    groundingContextDigest({ transcript: "", metadata: {}, frames: [], video: null })
  );
  return withGlobalCharacterBoundary(workflow, {
    creatorProfile: context.creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: source,
    creativeBrief: mockBrief(context)
  });
}

function repairCode(run) {
  try {
    run();
  } catch (error) {
    if (error instanceof StoryRepairPatchError) return error.code;
    throw error;
  }
  return "";
}

function contractCodes(run) {
  try {
    run();
    return [];
  } catch (error) {
    if (!(error instanceof OutputContractError)) throw error;
    return error.details.map((detail) => detail.code);
  }
}

const S1_FIND = "立刻把它收好";
const patch = (over = {}) => ({ sceneId: "S1", field: "visibleAction", find: S1_FIND, replace: "立刻把它仔细收好", ...over });

// ---- 逐字执行器：判定全是字符串比较 ----

test("原文恰好出现一次时逐字替换，别的一个字都不动", () => {
  const value = story();
  const next = applyStoryRepairPatches(value, [patch()]);
  assert.match(next.sceneScript[0].visibleAction, /立刻把它仔细收好/u);
  assert.notEqual(next, value, "必须返回新的一份，不改调用方的剧情");
  assert.doesNotMatch(value.sceneScript[0].visibleAction, /仔细/u);
  const restored = structuredClone(next);
  restored.sceneScript[0].visibleAction = value.sceneScript[0].visibleAction;
  assert.deepEqual(restored, value);
});

test("找不到原文、原文出现多次都不猜，直接拒这一条", () => {
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ find: "剧情里根本没有的一句话" })])),
    "STORY_REPAIR_FIND_NOT_FOUND");
  // S5 的动作里「看」出现两次：替换哪一处无法唯一确定。
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ sceneId: "S5", find: "看" })])),
    "STORY_REPAIR_FIND_NOT_UNIQUE");
});

test("字段白名单、场次、条数、空改动各自被拦", () => {
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ field: "characters" })])),
    "STORY_REPAIR_FIELD_NOT_ALLOWED");
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ field: "timeRange" })])),
    "STORY_REPAIR_FIELD_NOT_ALLOWED");
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ sceneId: "S404" })])),
    "STORY_REPAIR_SCENE_NOT_FOUND");
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch(), patch(), patch(), patch()])),
    "STORY_REPAIR_PATCH_TOO_MANY");
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ replace: S1_FIND })])),
    "STORY_REPAIR_NO_CHANGE");
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [patch({ find: "" })])),
    "STORY_REPAIR_FIND_EMPTY");
});

test("台词：句内替换、整句删除；只删半句导致台词变空则拒绝", () => {
  const replaced = applyStoryRepairPatches(story(), [
    { sceneId: "S4", field: "dialogue", find: "拿去", replace: "拿好" }
  ]);
  assert.equal(replaced.sceneScript[3].dialogue[0].line, "你要的是这个吧？拿好，来得及。");

  const deleted = applyStoryRepairPatches(story(), [
    { sceneId: "S4", field: "dialogue", find: "谢谢。", replace: "" }
  ]);
  assert.equal(deleted.sceneScript[3].dialogue.length, 1, "整句原文 + 空替换 = 删掉这一句");
  assert.equal(deleted.sceneScript[3].dialogue[0].speaker, "路过的热心帮手");

  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [
    { sceneId: "S4", field: "dialogue", find: "谢谢。", replace: " " }
  ])), "STORY_REPAIR_DIALOGUE_LINE_EMPTY");
});

test("一条问题的几处修改原子执行：后一处失败，前一处也不生效", () => {
  const value = story();
  const before = structuredClone(value);
  assert.equal(repairCode(() => applyStoryRepairPatches(value, [patch(), patch({ find: "没有这句" })])),
    "STORY_REPAIR_FIND_NOT_FOUND");
  assert.deepEqual(value, before);
});

// 第六轮实测：删掉路人少女的动作、脚步声和台词之后，她还登记在 characters 里。
test("修改不得让出镜角色从本场的动作和对白里消失", () => {
  const helperAction = "路过的热心帮手没有问太多，只递出解决眼前问题的工具或线索。";
  const helperLine = "你要的是这个吧？拿去，来得及。";
  assert.equal(repairCode(() => applyStoryRepairPatches(story(), [
    { sceneId: "S4", field: "visibleAction", find: helperAction, replace: "" },
    { sceneId: "S4", field: "dialogue", find: helperLine, replace: "" }
  ])), "STORY_REPAIR_REMOVES_ON_SCREEN_CHARACTER");
  // 只删动作、台词还在：这个角色仍然在戏里，不拦。
  assert.doesNotThrow(() => applyStoryRepairPatches(story(), [
    { sceneId: "S4", field: "visibleAction", find: helperAction, replace: "" }
  ]));
});

// ---- 条目选择：引用号只有一份 ----

test("引用号按位置编，守住的承诺不列；选择顺序被规范成报告顺序", () => {
  const review = reviewFor(story());
  assert.deepEqual(storyQualityRepairableItems(review).map((item) => item.ref), ["I1", "P2"],
    "mock 的 P1 是 PRESERVED，不可修；P2 是 CONTRADICTED");
  assert.deepEqual(selectStoryQualityRepairItems(review, ["P2", "I1"]).map((item) => item.ref), ["I1", "P2"]);
  assert.deepEqual(storyQualityKeptPromises(review).map((entry) => entry.promise),
    [review.promisePreservation.checks[0].promise]);
});

test("选了不存在的、守住的、重复的或什么都没选，都是请求错误", () => {
  const review = reviewFor(story());
  for (const refs of [["P1"], ["I9"], ["I1", "I1"], [], undefined]) {
    assert.throws(() => selectStoryQualityRepairItems(review, refs), InputError, JSON.stringify(refs));
  }
});

// ---- 模型输出结构：错了整份用不上，带诊断重试 ----

test("结构校验：条数、引用号、note、字段、find 各自给出诊断码", () => {
  const items = [{ ref: "I1" }, { ref: "P2" }];
  const good = { repairs: [
    { ref: "I1", patches: [patch()], note: "改了一处" },
    { ref: "P2", patches: [], note: "要改就得破坏承诺，不改" }
  ] };
  assert.doesNotThrow(() => ensureStoryQualityRepairContract(good, items));

  assert.ok(contractCodes(() => ensureStoryQualityRepairContract({ repairs: good.repairs.slice(0, 1) }, items))
    .includes("STORY_REPAIR_COUNT_MISMATCH"));
  assert.ok(contractCodes(() => ensureStoryQualityRepairContract({ repairs: [...good.repairs].reverse() }, items))
    .includes("STORY_REPAIR_REF_MISMATCH"));
  const noNote = structuredClone(good);
  noNote.repairs[1].note = "";
  assert.ok(contractCodes(() => ensureStoryQualityRepairContract(noNote, items)).includes("STORY_REPAIR_NOTE_MISSING"),
    "不改也必须说明理由");
  const badField = structuredClone(good);
  badField.repairs[0].patches[0].field = "location";
  assert.ok(contractCodes(() => ensureStoryQualityRepairContract(badField, items)).includes("STORY_REPAIR_FIELD_NOT_ALLOWED"));
  const noFind = structuredClone(good);
  delete noFind.repairs[0].patches[0].find;
  assert.ok(contractCodes(() => ensureStoryQualityRepairContract(noFind, items)).includes("STORY_REPAIR_FIND_EMPTY"));
  const notArray = structuredClone(good);
  notArray.repairs[1].patches = null;
  assert.ok(contractCodes(() => ensureStoryQualityRepairContract(notArray, items)).includes("STORY_REPAIR_PATCHES_INVALID"));
});

// ---- 逐条合并：单条执行不了只拒那一条 ----

const validate = (value) => ensureOutputContract(value, "fullStory");

test("逐条合并：改完不合法的只拒那一条，其余照常采用", () => {
  const items = [{ ref: "I1", kind: "issue" }, { ref: "P2", kind: "promise" }];
  const merged = mergeStoryQualityRepairs({
    fullStory: story(),
    items,
    validateStory: validate,
    repair: { repairs: [
      // 把一个没登记在 S1 的角色名写进可见动作：签发校验链会拦下它。
      { ref: "I1", patches: [patch({ replace: `${S1_FIND}，路过的热心帮手在门口等她` })], note: "加了一句" },
      { ref: "P2", patches: [{ sceneId: "S3", field: "visibleAction", find: "自己耽误了时间", replace: "自己耽误了一点时间" }], note: "改了一处" }
    ] }
  });
  assert.deepEqual(merged.results.map((row) => row.status), ["rejected", "applied"]);
  assert.equal(merged.results[0].code, "STORY_REPAIR_RESULT_INVALID");
  assert.match(merged.results[0].reason, /FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING|characters 未包含/u);
  assert.doesNotMatch(merged.fullStory.sceneScript[0].visibleAction, /路过的热心帮手/u);
  assert.match(merged.fullStory.sceneScript[2].visibleAction, /耽误了一点时间/u);
  assert.doesNotThrow(() => validate(structuredClone(merged.fullStory)), "留下的一定合法");
});

test("逐条合并：后一条的原文已被前一条改掉时如实标成冲突；不改的记为 declined", () => {
  const items = [{ ref: "I1", kind: "issue" }, { ref: "I2", kind: "issue" }, { ref: "P2", kind: "promise" }];
  const merged = mergeStoryQualityRepairs({
    fullStory: story(),
    items,
    validateStory: validate,
    repair: { repairs: [
      { ref: "I1", patches: [patch()], note: "第一条" },
      { ref: "I2", patches: [patch({ replace: "立刻把它藏好" })], note: "第二条改的是同一句" },
      { ref: "P2", patches: [], note: "候选原文就是这样写的，改了会破坏承诺" }
    ] }
  });
  assert.deepEqual(merged.results.map((row) => row.status), ["applied", "rejected", "declined"]);
  assert.equal(merged.results[1].code, "STORY_REPAIR_CONFLICTS_WITH_EARLIER");
  assert.match(merged.results[2].note, /破坏承诺/u);
});

test("自证只改了允许的字段：动了时间轴或出镜角色就是越界", () => {
  const before = story();
  const legit = applyStoryRepairPatches(before, [
    patch(),
    { sceneId: "S4", field: "dialogue", find: "谢谢。", replace: "" }
  ]);
  assert.doesNotThrow(() => assertOnlyStoryRepairFieldsChanged(before, legit));
  for (const mutate of [
    (value) => { value.sceneScript[0].timeRange = "00:00-00:09"; },
    (value) => { value.sceneScript[3].characters = ["小白子"]; },
    (value) => { value.title = "换了标题"; },
    (value) => { value.sceneScript[3].dialogue[0].speaker = "小白子"; }
  ]) {
    const bad = structuredClone(legit);
    mutate(bad);
    assert.ok(contractCodes(() => assertOnlyStoryRepairFieldsChanged(before, bad)).includes("STORY_REPAIR_OUT_OF_SCOPE"));
  }
});

// ---- 工作流：demo 与 live ----

test("demo 模式：体检之后按问题修改走通，第一条改、其余不改", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: {} });
  const value = story();
  const { review } = await workflow.createStoryQualityReview({
    fullStory: value, themeVariants: themeVariants(), candidateId: "V1", creatorProfile: context.creatorProfile
  });
  const result = await workflow.createStoryQualityRepair({
    ...upstreamFor(workflow), fullStory: value, review, themeVariants: themeVariants(), selectedRefs: ["P2", "I1"]
  });
  assert.equal(result.schemaVersion, "story-quality-repair/1.0");
  assert.equal(result.changed, true);
  assert.deepEqual(result.results.map((row) => [row.ref, row.status]), [["I1", "applied"], ["P2", "declined"]]);
  assert.ok(Object.hasOwn(result.metadata, "storyQualityRepair"));
  assert.doesNotThrow(() => ensureOutputContract(result.fullStory, "fullStory"));
});

function liveWorkflow(respond) {
  const prompts = [];
  const client = {
    async generateJson() { throw new Error("本阶段必须走 coordinator"); },
    async requestCompletion({ prompt }) {
      prompts.push(prompt);
      return { content: JSON.stringify(respond(prompts.length)) };
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    stageDefaults: { storyQualityRepair: { provider: "MiMo", model: "m", maxCompletionTokens: 4096 } }
  });
  return { workflow, prompts };
}

const GOOD = { repairs: [
  { ref: "I1", patches: [patch()], note: "改了一处" },
  { ref: "P2", patches: [], note: "候选原文就是这样写的，改了会破坏承诺" }
] };

test("live 路径：提示词带候选、守住的承诺与选中的问题，没选的不送", async () => {
  const value = story();
  const review = reviewFor(value);
  const { workflow, prompts } = liveWorkflow(() => ({ repairs: [GOOD.repairs[0]] }));
  const result = await workflow.createStoryQualityRepair({
    ...upstreamFor(workflow), fullStory: value, review, themeVariants: themeVariants(), selectedRefs: ["I1"]
  });
  assert.equal(prompts.length, 1);
  assert.deepEqual(result.results.map((row) => row.status), ["applied"]);
  assert.equal(result.metadata.storyQualityRepair.providerCalls, 1);
  const prompt = prompts[0];
  const candidate = themeVariants().variants.find((item) => item.id === "V1");
  assert.ok(prompt.includes(candidate.oneLineHook), "修改调用必须看得见候选——这是它与编辑诊断刻意相反的地方");
  assert.ok(prompt.includes(review.promisePreservation.checks[0].promise), "守住的承诺必须作为不许改坏的清单送进去");
  assert.ok(prompt.includes(review.issues[0].problem));
  assert.ok(!prompt.includes(review.promisePreservation.checks[1].evidence), "没选中的条目不送");
});

test("live 路径：结构错了带诊断重做一次，禁止第三次", async () => {
  const value = story();
  const { workflow, prompts } = liveWorkflow((call) => (call === 1
    ? { repairs: [...GOOD.repairs].reverse() }
    : GOOD));
  const result = await workflow.createStoryQualityRepair({
    ...upstreamFor(workflow), fullStory: value, review: reviewFor(value), themeVariants: themeVariants(),
    selectedRefs: ["I1", "P2"]
  });
  assert.equal(prompts.length, 2);
  assert.equal(result.metadata.storyQualityRepair.providerCalls, 2);
  assert.equal(result.metadata.storyQualityRepair.rejections.length, 1, "拦过一次必须如实上报");
  assert.match(prompts[1], /上一次的输出被确定性校验拦下了/u);
  assert.match(prompts[1], /STORY_REPAIR_REF_MISMATCH/u);

  const { workflow: stubborn, prompts: again } = liveWorkflow(() => ({ repairs: [...GOOD.repairs].reverse() }));
  await assert.rejects(() => stubborn.createStoryQualityRepair({
    ...upstreamFor(stubborn), fullStory: value, review: reviewFor(value), themeVariants: themeVariants(),
    selectedRefs: ["I1", "P2"]
  }), (error) => {
    const attempts = new Set((error.diagnostics || []).map((detail) => detail?.metadata?.attempt));
    assert.ok(attempts.has(1) && attempts.has(2), "两次都被拦时，两次的诊断都要在响应里");
    return true;
  });
  assert.equal(again.length, 2, "禁止第三次");
});

test("live 路径：单条执行不了只拒那一条，不为它整份重做", async () => {
  const value = story();
  const { workflow, prompts } = liveWorkflow(() => ({ repairs: [
    { ref: "I1", patches: [patch({ find: "剧情里没有的原文" })], note: "改了一处" },
    GOOD.repairs[1]
  ] }));
  const result = await workflow.createStoryQualityRepair({
    ...upstreamFor(workflow), fullStory: value, review: reviewFor(value), themeVariants: themeVariants(),
    selectedRefs: ["I1", "P2"]
  });
  assert.equal(prompts.length, 1);
  assert.equal(result.changed, false);
  assert.deepEqual(result.results.map((row) => [row.status, row.code || ""]),
    [["rejected", "STORY_REPAIR_FIND_NOT_FOUND"], ["declined", ""]]);
  assert.deepEqual(result.fullStory.sceneScript, value.sceneScript, "一条都没采用时剧情一个字不变");
});

test("请求错误：旧格式剧情、别的剧情的报告、没选条目都在调模型之前拒掉", async () => {
  const value = story();
  const { workflow, prompts } = liveWorkflow(() => GOOD);
  const base = { ...upstreamFor(workflow), themeVariants: themeVariants() };
  await assert.rejects(() => workflow.createStoryQualityRepair({
    ...base, fullStory: mockFullStory(context), review: reviewFor(value), selectedRefs: ["I1"]
  }), InputError);
  await assert.rejects(() => workflow.createStoryQualityRepair({
    ...base, fullStory: value, review: { ...reviewFor(value), selectedVariantId: "V2" }, selectedRefs: ["I1"]
  }), InputError);
  await assert.rejects(() => workflow.createStoryQualityRepair({
    ...base, fullStory: value, review: reviewFor(value), selectedRefs: []
  }), InputError);
  assert.equal(prompts.length, 0);
});

// ---- 提示词与接线 ----

test("修改提示词逐字含第七轮验证过的承重原句；体检的两段提示词不许混进修改规则", () => {
  const value = story();
  const review = reviewFor(value);
  const items = selectStoryQualityRepairItems(review, ["I1", "P2"]);
  const prompt = storyQualityRepairPrompt({
    fullStory: value,
    candidate: buildStoryQualityCandidateProjection(themeVariants().variants[0]),
    items,
    keptPromises: storyQualityKeptPromises(review)
  });
  assert.match(prompt, /不能把守住的候选承诺改坏/u);
  assert.match(prompt, /修一个问题而丢掉一条承诺，比不修更糟/u);
  assert.match(prompt, /find 必须从这一场这个字段里逐字复制/u);
  assert.match(prompt, /也不能把某个出镜角色从这一场里删掉/u);
  assert.match(prompt, /体检的判断不是命令/u);
  assert.match(prompt, /\[I1\]/u);
  assert.match(prompt, /\[P2\]/u);
  // 体检不动：编辑诊断刻意看不到候选、也不写修改——第六轮正是它顺手写的修改改坏了承诺。
  const editorial = storyQualityEditorialPrompt({ fullStory: value, fixedCharacter: "小白子" });
  const promise = storyQualityPromisePrompt({
    candidate: buildStoryQualityCandidateProjection(themeVariants().variants[0]), fullStory: value
  });
  for (const text of [editorial, promise]) assert.doesNotMatch(text, /patches/u);
});

test("接线源码锁：路由、侧车 scope、阶段默认值、签发校验链只有一份", () => {
  const serverJs = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const routeLine = serverJs.split(/\r?\n/).find((row) => row.includes('"/api/story-quality-repair"'));
  assert.equal(routeLine.trim(), '"/api/story-quality-repair": (body) => workflow.createStoryQualityRepair(body),',
    "修改接口只出修订稿，不许碰 production lineage");
  assert.match(serverJs, /MODEL_OUTPUT_LOG_SCOPES\.STORY_QUALITY_REPAIR/u);
  assert.match(serverJs, /storyQualityRepair: stageSetting\(/u);

  const workflowJs = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
  assert.match(workflowJs, /storyQualityRepair: \{\s*\n\s*provider: fallback\.storyProvider/u);
  // 生成与修改共用同一条签发校验链，两边各写一遍迟早漂移。
  assert.equal((workflowJs.match(/validateFullStoryForSigning\(/gu) || []).length, 3,
    "一处定义 + createFullStory + createStoryQualityRepair");

  const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appJs, /key: "storyQualityRepair"/u, "模型设置面板的 override 白名单必须登记新阶段");
});

test("浏览器源码锁：生成修改绝不签发，采纳才签发且与生成剧情共用依赖清单", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const bodyOf = (name) => {
    const start = app.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `没有找到 ${name}`);
    const ends = [app.indexOf("\nasync function ", start + 1), app.indexOf("\nfunction ", start + 1),
      app.indexOf("\nconst ", start + 1)].filter((index) => index > 0);
    return app.slice(start, Math.min(...ends));
  };
  const request = bodyOf("requestStoryQualityRepair");
  for (const forbidden of ["commitProductionArtifact", "requestProductionArtifact"]) {
    assert.ok(!request.includes(forbidden), `requestStoryQualityRepair 不得调用 ${forbidden}`);
  }
  const adopt = bodyOf("adoptStoryQualityRepair");
  assert.match(adopt, /commitProductionArtifact/u);
  assert.match(adopt, /fullStoryDependencyIds\(variantId\)/u);
  assert.match(adopt, /entry\.sourceFullStory/u, "修订稿针对的剧情变了必须作废");
  assert.match(bodyOf("generateFullStory"), /dependencyIds: fullStoryDependencyIds\(variant\.id\)/u);
});

// ---- 浏览器：真的跑一遍 ----

const uiResponse = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });

async function repairApp({ plan = false, confirm = () => true, repairResult } = {}) {
  const calls = [];
  const routes = {};
  const app = await loadAppUi({
    story: true,
    plan,
    confirm,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (!routes[url]) throw new Error(`unexpected ${url}`);
      return uiResponse(routes[url](body));
    }
  });
  // 验签用的上游：JSON.stringify 会丢掉值为 undefined 的键，不放就测不到「请求体带上了它们」。
  Object.assign(app.state.output, {
    referenceAnalysis: { marker: "referenceAnalysis" },
    sourceScriptReconstruction: { marker: "sourceScriptReconstruction" },
    creativeBrief: { marker: "creativeBrief" },
    visualGuardrails: { marker: "visualGuardrails" }
  });
  for (const artifactId of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief",
    "visualGuardrails", "themeVariants", "variant:V2", "fullStory:V2"]) {
    app.state.production.artifacts[artifactId] = { artifactId, status: "current", revision: "r1",
      contentDigest: `${artifactId}-digest` };
  }
  const value = app.state.fullStories.V2;
  const review = reviewFor(value);
  const repaired = structuredClone(value);
  repaired.sceneScript[0].visibleAction = `${repaired.sceneScript[0].visibleAction}（改过）`;
  routes["/api/story-quality-review"] = () => ({ review, metadata: {} });
  routes["/api/story-quality-repair"] = () => repairResult || {
    schemaVersion: "story-quality-repair/1.0",
    selectedVariantId: "V2",
    changed: true,
    results: [
      { ref: "I1", kind: "issue", status: "applied", patches: [], note: "在第一场补了一句" },
      { ref: "P2", kind: "promise", status: "declined", patches: [], note: "候选原文就是这样写的，改了会破坏承诺" }
    ],
    fullStory: repaired,
    metadata: { storyQualityRepair: { provider: "Qwen", model: "m", providerCalls: 1, rejections: [] } }
  };
  routes["/api/production/artifact/commit"] = (body) => ({
    lineage: { artifactId: body.artifactId, status: "current", revision: "r2", contentDigest: "fullStory-digest-2" },
    staleArtifactIds: plan ? ["animationPlan:V2"] : []
  });
  await app.runStoryQualityReview(value, { disabled: false, textContent: "检查剧情硬伤" });
  const body = app.elements.fullStory.querySelector("[data-story-review-body]");
  return { app, calls, value, review, repaired, body };
}

test("浏览器：每条可修的问题都有勾选框，请求带上选中项与验签用的上游", async () => {
  const { app, calls, value, review, body } = await repairApp();
  assert.match(body.innerHTML, /data-story-repair-ref="I1"/u);
  assert.match(body.innerHTML, /data-story-repair-ref="P2"/u);
  assert.doesNotMatch(body.innerHTML, /data-story-repair-ref="P1"/u, "守住的承诺没有可修的东西");
  assert.match(body.innerHTML, /按选中的问题生成修改/u);

  await app.requestStoryQualityRepair(body, { disabled: false, textContent: "按选中的问题生成修改" }, ["I1", "P2"]);
  const request = calls.find((call) => call.url === "/api/story-quality-repair");
  assert.ok(request);
  assert.deepEqual(request.body.selectedRefs, ["I1", "P2"]);
  assert.deepEqual(request.body.fullStory, value);
  assert.deepEqual(request.body.review, review);
  for (const key of ["themeVariants", "creatorProfile", "creativeBrief", "visualGuardrails",
    "referenceAnalysis", "sourceScriptReconstruction"]) {
    assert.ok(Object.hasOwn(request.body, key), `请求体必须带 ${key}`);
  }
  assert.ok(!calls.some((call) => call.url === "/api/production/artifact/commit"), "生成修改绝不签发");
  const slot = body.querySelector("[data-story-repair-slot]");
  assert.match(slot.innerHTML, /修订稿（还没有生效）/u);
  assert.match(slot.innerHTML, /（改过）/u);
  assert.match(slot.innerHTML, /没改/u);
  assert.match(slot.innerHTML, /改了会破坏承诺/u, "不改的理由必须显示出来");
  assert.match(slot.innerHTML, /采纳 1 条修改并签发新的剧情版本/u);
});

test("浏览器：采纳才签发新的 fullStory 版本，镜头计划随之失效", async () => {
  const { app, calls, body, repaired } = await repairApp({ plan: true });
  await app.requestStoryQualityRepair(body, { disabled: false, textContent: "x" }, ["I1"]);
  await app.adoptStoryQualityRepair({ disabled: false, textContent: "采纳" });
  const commit = calls.find((call) => call.url === "/api/production/artifact/commit");
  assert.ok(commit, "采纳必须签发");
  assert.equal(commit.body.artifactId, "fullStory:V2");
  assert.equal(commit.body.artifactType, "fullStory");
  assert.deepEqual(commit.body.content, repaired);
  assert.ok(commit.body.dependencies.some((dependency) => dependency.artifactId === "variant:V2"));
  assert.deepEqual(app.state.fullStories.V2, repaired);
  assert.equal(app.state.animationPlans.V2, undefined, "旧剧情的镜头计划必须被 stale 掉");
});

test("浏览器：修订稿针对的剧情变了就作废；有镜头计划时用户拒绝就什么都不签", async () => {
  const stale = await repairApp();
  await stale.app.requestStoryQualityRepair(stale.body, { disabled: false, textContent: "x" }, ["I1"]);
  stale.app.state.fullStories.V2 = { ...stale.app.state.fullStories.V2, title: "中途被重新生成了" };
  await stale.app.adoptStoryQualityRepair({ disabled: false, textContent: "采纳" });
  assert.ok(!stale.calls.some((call) => call.url === "/api/production/artifact/commit"));

  const declined = await repairApp({ plan: true, confirm: () => false });
  await declined.app.requestStoryQualityRepair(declined.body, { disabled: false, textContent: "x" }, ["I1"]);
  await declined.app.adoptStoryQualityRepair({ disabled: false, textContent: "采纳" });
  assert.ok(!declined.calls.some((call) => call.url === "/api/production/artifact/commit"));
  assert.ok(declined.app.state.animationPlans.V2, "拒绝采纳不得动镜头计划");
});

test("浏览器：一条都没改成时不给采纳按钮", async () => {
  const { app, body } = await repairApp({ repairResult: {
    schemaVersion: "story-quality-repair/1.0", selectedVariantId: "V2", changed: false,
    results: [{ ref: "I1", kind: "issue", status: "rejected", code: "STORY_REPAIR_FIND_NOT_FOUND",
      reason: "第 1 处修改：S1 的 visibleAction 里找不到这段原文", patches: [], note: "改了一处" }],
    fullStory: null, metadata: {}
  } });
  await app.requestStoryQualityRepair(body, { disabled: false, textContent: "x" }, ["I1"]);
  const slot = body.querySelector("[data-story-repair-slot]");
  assert.match(slot.innerHTML, /程序拒绝/u);
  assert.match(slot.innerHTML, /找不到这段原文/u);
  assert.match(slot.innerHTML, /这次没有可以采纳的修改/u);
  assert.doesNotMatch(slot.innerHTML, /data-story-repair-adopt/u);
});
