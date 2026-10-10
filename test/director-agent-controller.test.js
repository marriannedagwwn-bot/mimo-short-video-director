import test from "node:test";
import assert from "node:assert/strict";
import { createDirectorAgentController } from "../public/director-agent-controller.js";
import { deriveDirectorProgress } from "../public/director-agent-progress.js";
import { DIRECTOR_AGENT_LIMITS } from "../public/director-agent-actions.js";

// 导演助手的对话状态（2026-10-09）：只在页面内存里；「这一步做完了」看结果有没有进页面，
// 不看任务状态。第一次观察只记基线，不把已完成的步骤再报一遍。

function merge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
      ? merge(base[key], value)
      : value;
  }
  return result;
}

function facts(overrides = {}) {
  return merge({
    restored: true, epoch: 1, entryMode: "story", storyMode: "fullStoryText", runId: "run-1", route: "story",
    storySlot: true, storySlotId: "V1", selectedVariantId: "V1", candidates: [], candidatesRevision: "",
    storiesByVariant: { V1: true },
    pipeline: { done: true, busy: false, paused: false, failure: null },
    chosenVariantId: "V1", modalOpen: false, setup: { ready: true, reason: "" }, storyContinuing: false,
    labels: { pipelineStart: "开始拆镜头", pipelineContinue: "继续拆镜头" },
    candidatesBusy: false, hasDownstream: true,
    story: { exists: true, revision: "fullStory-V1-r1", sceneCount: 5, seconds: 60 },
    storyTaskId: "", storyBusy: false, storyFailure: null,
    precheck: { awaitingDecision: false, passStillValid: false, failure: null },
    plan: null, planTaskId: "", planBusy: false, planFailure: null, imagesBusy: false, videoBusy: false,
    busyText: "", failures: [],
    nextPlanSettings: { aspectRatio: "16:9", artStyle: "二维日系动画", musicOn: false },
    models: { pipeline: "MiMo m", candidates: "MiMo m", story: "MiMo m", plan: "MiMo m", image: "Jimeng s", video: "Seedance v", videoSupportsStoryboard: true },
    usage: { pipeline: null, variants: null, fullStory: null, plan: null }
  }, overrides);
}

function storyboard(overrides = {}) {
  return {
    revision: "animationPlan-V1-r1", isStoryboard: true, hasProductionContext: true,
    shots: [{ shotId: "A01", seconds: 13, hasVideo: false, promptCached: false }, { shotId: "A02", seconds: 8, hasVideo: false, promptCached: false }],
    roles: [{ index: 0, name: "阿岚", hasImage: false }, { index: 1, name: "老周", hasImage: true }],
    seconds: 21, aspectRatio: "16:9", artStyle: "二维日系动画",
    ...overrides
  };
}

function observe(controller, value) {
  const progress = deriveDirectorProgress(value);
  controller.observe(value, progress);
  return progress;
}

const texts = (controller) => controller.messages.map((message) => message.text);

test("页面还在恢复时什么都不做；第一次观察只打招呼并给出下一步，同样的状态再观察不出新消息", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ restored: false }));
  assert.equal(controller.messages.length, 0);
  observe(controller, facts());
  assert.match(controller.messages[0].text, /导演助手/u);
  assert.equal(controller.messages[1].card.key, "generateStoryboard:V1");
  assert.equal(controller.messages[1].card.state, "pending");
  observe(controller, facts());
  assert.equal(controller.messages.length, 2);
});

test("打招呼里已经说了在等什么：不再单独重复一遍，只在要挑候选时补上候选按钮", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ runId: "", pipeline: { done: false }, story: { exists: false }, storiesByVariant: { V1: false },
    setup: { ready: false, reason: "先在左边粘贴故事原文。" } }));
  assert.equal(controller.messages.length, 1);
  assert.match(controller.messages[0].text, /先在左边粘贴故事原文。/u);
  const choosing = createDirectorAgentController();
  observe(choosing, facts({ entryMode: "video", storySlot: false, selectedVariantId: "", chosenVariantId: "", candidates: [{ id: "V1", title: "甲" }],
    candidatesRevision: "r1", storiesByVariant: { V1: false }, story: { exists: false }, hasDownstream: false }));
  assert.equal(choosing.messages.length, 2);
  assert.equal(choosing.messages[1].text, "");
  assert.deepEqual(choosing.messages[1].chips.map((chip) => chip.key), ["chooseCandidate:V1"]);
});

test("第一次观察不把已经完成的步骤当成刚完成的再报一遍", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ plan: storyboard(), planTaskId: "task-plan" }));
  assert.equal(texts(controller).some((text) => /分镜好了/u.test(text)), false);
});

test("流水线拆完、剧情重新拆好、分镜生成好：各发一段只报计数的总结，再给下一步卡片", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ pipeline: { done: false, busy: true }, story: { exists: false }, storiesByVariant: { V1: false }, busyText: "拆镜头中…" }));
  observe(controller, facts());
  assert.ok(texts(controller).includes("可翻拍镜头拆好了：5 场，共 60 秒。"));
  assert.equal(controller.messages.at(-1).card.key, "generateStoryboard:V1");

  observe(controller, facts({ storyTaskId: "task-split", story: { revision: "fullStory-V1-r2", sceneCount: 6, seconds: 62 } }));
  assert.ok(texts(controller).includes("重新拆好了：6 场，共 62 秒。"));

  observe(controller, facts({ plan: storyboard(), planTaskId: "task-plan" }));
  assert.ok(texts(controller).includes("分镜好了：2 镜，共 21 秒，16:9，画风 二维日系动画；1 个角色还没有参考图。"));
  assert.equal(controller.messages.at(-1).card.key, "openCharacterImages:V1:0");
});

test("同一份分镜里角色有了参考图、镜头有了视频：各报一句；新生成的分镜不算", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ plan: storyboard(), planTaskId: "task-plan" }));
  observe(controller, facts({ plan: storyboard({ revision: "animationPlan-V1-r2", roles: [{ index: 0, name: "阿岚", hasImage: true }, { index: 1, name: "老周", hasImage: true }] }), planTaskId: "task-plan" }));
  assert.ok(texts(controller).includes("「阿岚」有参考图了。"));
  observe(controller, facts({ plan: storyboard({ revision: "animationPlan-V1-r2", roles: [{ index: 0, name: "阿岚", hasImage: true }], shots: [{ shotId: "A01", seconds: 13, hasVideo: true }, { shotId: "A02", seconds: 8, hasVideo: false }] }), planTaskId: "task-plan" }));
  assert.ok(texts(controller).includes("镜头 A01 的视频好了。还有 1 镜没有视频。"));
  const before = controller.messages.length;
  // 重新生成了一份分镜（新的完成任务）：只报「分镜好了」，不把新分镜里的角色图再报一遍。
  observe(controller, facts({ plan: storyboard({ revision: "animationPlan-V1-r3", roles: [{ index: 0, name: "阿岚", hasImage: true }, { index: 1, name: "老周", hasImage: true }] }), planTaskId: "task-plan-2" }));
  const added = texts(controller).slice(before);
  assert.ok(added.some((text) => text.startsWith("分镜好了")));
  assert.equal(added.some((text) => /^「[^」]+」有参考图了/u.test(text)), false);
});

test("失败只报一次；被内容审核拦下时说明不会自动重试、要不要再跑由用户决定", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts());
  const failure = { id: "task-plan-failed", label: "分镜", text: "模型输出被内容审核拦截", contentFiltered: true };
  observe(controller, facts({ failures: [failure], planFailure: failure }));
  const failureMessages = texts(controller).filter((text) => text.startsWith("分镜没有成功"));
  assert.equal(failureMessages.length, 1);
  assert.match(failureMessages[0], /不会自动重试/u);
  observe(controller, facts({ failures: [failure], planFailure: failure }));
  assert.equal(texts(controller).filter((text) => text.startsWith("分镜没有成功")).length, 1);
});

test("体检建议修订、体检失败：各说一句，交给用户在页面上决定", () => {
  const controller = createDirectorAgentController();
  const base = { entryMode: "video", storySlot: false, selectedVariantId: "V1", chosenVariantId: "V1", candidates: [{ id: "V1", title: "t" }],
    candidatesRevision: "r1", storiesByVariant: { V1: false }, story: { exists: false }, hasDownstream: false };
  observe(controller, facts(base));
  observe(controller, facts({ ...base, precheck: { awaitingDecision: true } }));
  assert.ok(texts(controller).some((text) => /体检面板/u.test(text)));
  observe(controller, facts({ ...base, precheck: { failure: { id: "precheck:V1:1", text: "评审失败" } } }));
  assert.ok(texts(controller).some((text) => text.startsWith("展开前体检没有跑完：评审失败")));
});

test("同一时间只留一张待确认的卡：同一个动作不重复发，新建议取代旧卡；换了 Run 时作废旧卡", () => {
  const controller = createDirectorAgentController();
  const first = observe(controller, facts());
  controller.showNext(first);
  assert.equal(controller.messages.filter((message) => message.card).length, 1, "同一个动作、核对项没变时不重复发卡");
  const changed = deriveDirectorProgress(facts({ nextPlanSettings: { artStyle: "水彩绘本" } }));
  controller.showNext(changed);
  const cards = controller.messages.filter((message) => message.card);
  assert.deepEqual(cards.map((message) => message.card.state), ["superseded", "pending"]);
  observe(controller, facts({ runId: "run-2" }));
  assert.ok(texts(controller).includes("已经换成新的 Run。"));
  assert.equal(cards[1].card.state, "void");
});

test("用户刚问过、而同一张待确认的卡已经被压在上面时：把它挪到最下面，旧位置标成「已移到下面」", () => {
  const controller = createDirectorAgentController();
  const progress = observe(controller, facts());
  const original = controller.messages.at(-1);
  controller.beginTurn("下一步做什么", progress);
  controller.finishTurn({ turn: { actionKey: "generateStoryboard:V1", reply: "可以生成分镜了。" } }, progress);
  assert.equal(original.card.state, "superseded");
  assert.equal(original.card.stateText, "已移到下面");
  const last = controller.messages.at(-1);
  assert.equal(last.card.key, "generateStoryboard:V1");
  assert.equal(last.card.state, "pending");
  assert.equal(controller.messages.filter((message) => message.card?.state === "pending").length, 1);
  // 卡片已经在最下面时，点「下一步」不重复发。
  controller.showNext(progress);
  assert.equal(controller.messages.at(-1), last);
});

test("从没有 Run 到刚建好 Run：静默重记基线，不打扰", () => {
  const controller = createDirectorAgentController();
  observe(controller, facts({ runId: "", pipeline: { done: false }, story: { exists: false }, storiesByVariant: { V1: false } }));
  const count = controller.messages.length;
  observe(controller, facts({ runId: "run-9", pipeline: { done: false, busy: true }, story: { exists: false }, storiesByVariant: { V1: false }, busyText: "拆镜头中…" }));
  assert.equal(controller.messages.length, count);
});

test("发给模型：历史只含用户的话和导演助手的回复、有条数和长度上限；回复没到之前不能再发", () => {
  const controller = createDirectorAgentController();
  const progress = observe(controller, facts());
  for (let index = 0; index < 5; index += 1) {
    const payload = controller.beginTurn(`第 ${index} 句${"很长".repeat(400)}`, progress);
    assert.ok(payload);
    assert.equal(controller.beginTurn("再说一句", progress), null, "上一句还在等回复");
    controller.finishTurn({ turn: { actionKey: "none", reply: `回复 ${index}` } }, progress);
  }
  const payload = controller.beginTurn("下一步做什么", progress);
  assert.equal(payload.message, "下一步做什么");
  assert.equal(payload.history.length, DIRECTOR_AGENT_LIMITS.historyEntries);
  assert.ok(payload.history.every((entry) => ["user", "agent"].includes(entry.role)));
  assert.ok(payload.history.every((entry) => entry.text.length <= DIRECTOR_AGENT_LIMITS.historyChars));
  assert.equal(payload.history.some((entry) => /导演助手：按你现在的进度/u.test(entry.text)), false, "规则生成的打招呼不进历史");
  assert.equal(payload.progress.nextKey, "generateStoryboard:V1");
});

test("模型的回复：编号在现在的清单里才出卡片；清单里没有就说明进度变了；none 只回答", () => {
  const controller = createDirectorAgentController();
  const progress = observe(controller, facts({ plan: storyboard(), planTaskId: "t" }));
  controller.beginTurn("先做第二镜", progress);
  controller.finishTurn({ turn: { actionKey: "openShotVideo:V1:A02", reply: "可以，先打开 A02。" }, usage: { totalTokens: 1234, calls: 1 } }, progress);
  const agent = controller.messages.find((message) => message.role === "agent");
  assert.equal(agent.text, "可以，先打开 A02。");
  assert.match(agent.meta, /1,234 tokens/u);
  assert.equal(controller.messages.at(-1).card.key, "openShotVideo:V1:A02");

  controller.beginTurn("做第九镜", progress);
  controller.finishTurn({ turn: { actionKey: "openShotVideo:V1:A09", reply: "好。" } }, progress);
  assert.match(controller.messages.at(-1).text, /现在不能做了/u);

  controller.beginTurn("到哪了", progress);
  const before = controller.messages.filter((message) => message.card).length;
  controller.finishTurn({ turn: { actionKey: "none", reply: "分镜好了。" } }, progress);
  assert.equal(controller.messages.filter((message) => message.card).length, before);

  controller.beginTurn("继续", progress);
  controller.failTurn(new Error("模型输出被内容审核拦截"), { totalTokens: 10, calls: 1 });
  assert.match(controller.messages.at(-1).text, /没有回答：模型输出被内容审核拦截/u);
  assert.equal(controller.pendingTurn, false);
});

test("候选按钮：用户自己点了才出卡片；不在清单里的按钮说明不能用了", () => {
  const controller = createDirectorAgentController();
  const value = facts({ entryMode: "video", storySlot: false, selectedVariantId: "", chosenVariantId: "", candidates: [{ id: "V1", title: "甲" }, { id: "V2", title: "乙" }],
    candidatesRevision: "r1", storiesByVariant: { V1: false, V2: false }, story: { exists: false }, hasDownstream: false });
  const progress = observe(controller, value);
  const waiting = controller.messages.at(-1);
  assert.deepEqual(waiting.chips.map((chip) => chip.key), ["chooseCandidate:V1", "chooseCandidate:V2"]);
  controller.showChoice("chooseCandidate:V2", progress);
  assert.equal(controller.messages.at(-1).card.key, "chooseCandidate:V2");
  controller.showChoice("chooseCandidate:V7", progress);
  assert.match(controller.messages.at(-1).text, /不能用了/u);
});
