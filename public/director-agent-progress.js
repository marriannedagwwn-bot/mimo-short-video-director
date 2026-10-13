// 导演助手（2026-10-09）：「现在做到哪了、下一步能做什么」的唯一规则。纯函数，不碰 DOM。
//
// 输入是 app.js 的 directorAgentFacts() 从页面状态取出的事实（只有状态、计数、版本号和固定标签，
// 不含故事原文、提示词或图片数据）；输出是步骤列表、正在进行的事、在等用户做什么、
// 下一步建议和全部可执行动作。模型（/api/director-agent/turn）只能从这里给出的动作里选，
// 页面执行前还会用同一份规则再算一遍并核对 guard。设计见 docs/director-agent-chat-2026-10-09.md。
import { DIRECTOR_AGENT_LIMITS, directorAgentActionKey, isModelSelectableDirectorAgentAction } from "./director-agent-actions.js";
import { oneSentenceEditInvalidationLines } from "./one-sentence-edit-ui.js";
import { legacyAnimationPlanMessage } from "./storyboard-plan.js";

// 各步骤最少调用几次文本模型。数字来自代码结构（这一步至少要发几次请求），是下限：
// 带诊断的重试、审阅后的修订和终审都会多花；跑完后页面会显示实际用量。
export const DIRECTOR_AGENT_MIN_TEXT_CALLS = Object.freeze({
  // 分析、还原、简报、角色边界各 1 次，故事候选 2 次（先选原片证据，再写候选）。已完成的步骤不重跑。
  directorPipeline: 6,
  // 角色边界 1 次 + 按原文拆分 2 次（拆场 + 完整角色表）。
  storyPipelineFullText: 3,
  // 角色边界 1 次 + 写一个故事候选 1 次。
  storyPipelineCharacterOnly: 2,
  // 先选原片证据，再写候选。
  variants: 2,
  // 展开前体检 3 次（评审 + 承诺清单 + 承诺核对）+ 完整剧情 2 次（剧情 + 角色表）。
  fullStoryWithPrecheck: 5,
  // 剧情入口不体检；参考视频入口上一次体检已判「直接展开」且候选没变时也不再体检。
  fullStory: 2,
  // 4.0 分镜：设计 + 审阅；审阅报出问题时再修订、终审。
  animationPlan: 2,
  // 打开 4.0 镜头弹窗时还没写过这一镜的提示词。
  shotVideoPrompt: 1,
  // 一句话修改：按原话写一份修改稿；结构不对或执行不了时带诊断重试一次。
  oneSentenceEdit: 1
});

export const DIRECTOR_AGENT_ENTRY = Object.freeze({
  video: "参考视频",
  storyText: "粘贴完整故事",
  characterOnly: "只给角色设定"
});

export function directorAgentEntryLabel(facts) {
  if (facts.entryMode !== "story") return DIRECTOR_AGENT_ENTRY.video;
  return facts.storyMode === "fullStoryText" ? DIRECTOR_AGENT_ENTRY.storyText : DIRECTOR_AGENT_ENTRY.characterOnly;
}

export function deriveDirectorProgress(facts) {
  const base = {
    entry: directorAgentEntryLabel(facts),
    steps: buildSteps(facts),
    busy: facts.busyText || "",
    waitingFor: "",
    // 补充说明：某一步为什么不在清单里、清单里的顺序是不是硬性要求。由规则写出，发给模型，
    // 让它回答「为什么不能做 X」时说对原因（实测没有它时，模型会自己编一个原因）。
    notes: [],
    next: null,
    actions: []
  };
  if (!facts.restored) return { ...base, waitingFor: "页面还在恢复上一次的进度。" };
  // 有步骤在跑、或有弹窗开着时不提任何可执行动作：避免并行发起付费任务，或在弹窗里改乱状态。
  if (base.busy) return base;
  // 一句话修改的修改稿等用户决定时也不提别的：先采纳或放弃，免得在它下面又生成新东西。
  if (facts.edit?.pending) return { ...base, ...pendingEditActions(facts) };
  if (facts.modalOpen) return { ...base, waitingFor: "有弹窗开着：先在弹窗里操作，或者把它关掉。" };
  return { ...base, ...buildActions(facts) };
}

// ---- 步骤 ----

function buildSteps(facts) {
  const steps = [];
  const sourceReady = Boolean(facts.runId || facts.setup?.ready);
  if (facts.entryMode !== "story") {
    steps.push(step("source", "参考视频", sourceReady ? "done" : "todo"));
    steps.push(pipelineStep(facts, "AI 导演", facts.candidates.length ? `${facts.candidates.length} 个故事候选` : ""));
    steps.push(step("choose", "选故事", directorAgentChosenVariant(facts) ? "done" : facts.pipeline.done ? "waiting" : "todo"));
    steps.push(storyStep(facts, "完整剧情"));
  } else if (facts.storyMode === "fullStoryText") {
    steps.push(step("source", "故事原文", sourceReady ? "done" : "todo"));
    steps.push(pipelineStep(facts, "拆镜头", storyDetail(facts.story)));
  } else {
    steps.push(step("source", "角色设定", sourceReady ? "done" : "todo"));
    steps.push(pipelineStep(facts, "写故事", facts.candidates.length ? `${facts.candidates.length} 个故事候选` : ""));
    steps.push(storyStep(facts, "完整剧情"));
  }
  steps.push(planStep(facts));
  steps.push(rolesStep(facts));
  steps.push(shotsStep(facts));
  return steps;
}

function step(key, label, status, detail = "") {
  return { key, label, status, detail };
}

function pipelineStep(facts, label, doneDetail) {
  const pipeline = facts.pipeline;
  if (pipeline.done) return step("pipeline", label, "done", doneDetail);
  if (pipeline.busy) return step("pipeline", label, pipeline.paused ? "paused" : "running");
  if (pipeline.failure) return step("pipeline", label, "failed", pipeline.failure.contentFiltered ? "被内容审核拦下" : "没有跑完");
  return step("pipeline", label, "todo");
}

function storyStep(facts, label) {
  if (facts.story?.exists) return step("story", label, "done", storyDetail(facts.story));
  if (facts.storyBusy) return step("story", label, "running");
  if (facts.precheck?.awaitingDecision) return step("story", label, "waiting", "体检建议先修订候选");
  if (facts.precheck?.failure || facts.storyFailure) return step("story", label, "failed", "没有生成出来");
  return step("story", label, "todo");
}

function planStep(facts) {
  const plan = facts.plan;
  if (plan) return step("plan", "分镜", "done", `${plan.shots.length} 镜${plan.seconds ? ` · ${plan.seconds} 秒` : ""}${plan.aspectRatio ? ` · ${plan.aspectRatio}` : ""}`);
  if (facts.planBusy) return step("plan", "分镜", "running");
  if (facts.planFailure) return step("plan", "分镜", "failed", facts.planFailure.contentFiltered ? "被内容审核拦下" : "没有生成出来");
  return step("plan", "分镜", "todo");
}

function rolesStep(facts) {
  const roles = facts.plan?.roles || [];
  if (!facts.plan || !roles.length) return step("roles", "角色参考图", facts.imagesBusy ? "running" : "todo");
  const ready = roles.filter((role) => role.hasImage).length;
  const status = facts.imagesBusy ? "running" : ready === roles.length ? "done" : "todo";
  return step("roles", "角色参考图", status, `有参考图 ${ready}/${roles.length}`);
}

function shotsStep(facts) {
  const shots = facts.plan?.shots || [];
  if (!facts.plan || !shots.length) return step("shots", "镜头视频", facts.videoBusy ? "running" : "todo");
  const ready = shots.filter((shot) => shot.hasVideo).length;
  const status = facts.videoBusy ? "running" : ready === shots.length ? "done" : "todo";
  return step("shots", "镜头视频", status, `有视频 ${ready}/${shots.length}`);
}

function storyDetail(story) {
  if (!story?.exists) return "";
  return [story.sceneCount ? `${story.sceneCount} 场` : "", story.seconds ? `${story.seconds} 秒` : ""].filter(Boolean).join(" · ");
}

// ---- 动作 ----

// 「粘贴完整故事」只有故事位 V1；其余入口是用户选过的候选。刷新后没有选中项时，接着用已经有
// 完整剧情的那个候选——那是用户之前选过的，不是替用户挑一个（GitHub-Benchmark 待办 :477）。
// app.js 取数时也用它决定 story / plan 取哪个故事的，两边只有这一份判断。
// 只读 storySlot、storySlotId、pipeline.done、candidates、selectedVariantId、storiesByVariant。
export function directorAgentChosenVariant(facts) {
  if (facts.storySlot) return facts.pipeline.done ? { id: facts.storySlotId, title: "" } : null;
  const byId = new Map(facts.candidates.map((candidate) => [candidate.id, candidate]));
  if (facts.selectedVariantId && byId.has(facts.selectedVariantId)) return byId.get(facts.selectedVariantId);
  return facts.candidates.find((candidate) => facts.storiesByVariant[candidate.id]) || null;
}

function buildActions(facts) {
  const actions = [];
  const add = (action) => {
    actions.push(action);
    return action;
  };

  // 1. AI 导演 / 拆镜头 / 剧情准备。
  if (!facts.pipeline.done) {
    // 参考视频入口：已有候选时再点「AI 导演」会直接开新 Run、没有确认，所以只在还没有候选时提。
    // 剧情入口：只在「从头开始」或「接着同一份原文继续」时提；原文改过时页面会开新 Run 并清空结果。
    const startable = facts.setup.ready && (facts.entryMode === "story"
      ? !facts.runId || facts.storyContinuing
      : !facts.candidates.length);
    if (startable) return { actions, next: add(startPipelineAction(facts)), waitingFor: "" };
    return { actions, next: null, waitingFor: facts.setup.ready ? "原文或剧情模式改过了；要按新内容重新开始，请在页面上点开始按钮（会清空当前结果）。" : facts.setup.reason };
  }

  // 2. 选故事。挑哪个候选只做成按钮，由用户自己点；模型不能选。
  const variant = directorAgentChosenVariant(facts);
  const anyStory = Object.values(facts.storiesByVariant || {}).some(Boolean);
  if (facts.entryMode !== "story" && !facts.hasDownstream && !facts.candidatesBusy) add(regenerateCandidatesAction(facts));
  if (!facts.storySlot && !anyStory) {
    for (const candidate of facts.candidates) add(chooseCandidateAction(facts, candidate));
  }
  if (!variant) {
    return { actions, next: null, waitingFor: facts.candidates.length
      ? "挑一个故事候选：点下面的候选按钮，它就会展开成完整剧情。"
      : "这一轮没有可用的故事候选。" };
  }
  if (facts.route !== "story" && facts.storiesByVariant[variant.id]) add(openStoryPageAction(facts, variant));

  // 一句话修改：只在用户自己说要改什么时由模型对上，从不作为下一步、也不做成按钮。
  const addStoryEdit = () => {
    if (facts.edit?.storyEditable) add(editStoryAction(facts, variant));
  };

  // 3. 完整剧情。
  if (!facts.story?.exists) {
    // 体检建议修订、等用户决定时不提：再点生成会丢掉修订稿，还要再付一次体检的钱。
    if (facts.precheck?.awaitingDecision) {
      return { actions, next: null, waitingFor: "展开前体检建议先改一下这个候选。请在页面上的体检面板里决定：采纳修订并展开，或者按原候选展开。" };
    }
    if (facts.storySlot) return { actions, next: null, waitingFor: "还没有可翻拍镜头。" };
    return { actions, next: add(generateFullStoryAction(facts, variant)), waitingFor: "" };
  }

  // 4. 分镜。旧版（2.0/3.0）分镜已不再支持：app.js 不把它当成分镜（plan 为空），这里同样提议生成，
  // 按实际版本写的说明放进 notes（有 next 时 waitingFor 照常为空）。
  if (!facts.plan) {
    const next = add(generateStoryboardAction(facts, variant));
    addStoryEdit();
    return {
      actions,
      next,
      notes: facts.legacyPlanVersion ? [legacyAnimationPlanMessage(facts.legacyPlanVersion)] : [],
      waitingFor: ""
    };
  }
  if (!facts.plan.hasProductionContext) {
    return { actions, next: null, waitingFor: "分镜的版本信息对不上，请刷新页面后再继续。" };
  }

  // 5. 角色参考图先于镜头视频：「设为人物参考图」会签发新分镜版本，已生成的镜头视频会全部作废。
  for (const role of facts.plan.roles.filter((item) => !item.hasImage)) add(openCharacterImagesAction(facts, variant, role));

  // 6. 镜头视频。
  const notes = [];
  const pendingShots = facts.plan.shots.filter((shot) => !shot.hasVideo);
  const missingRoles = facts.plan.roles.some((role) => !role.hasImage);
  for (const shot of pendingShots) add(openShotVideoAction(facts, variant, shot));
  if (pendingShots.length && missingRoles) {
    notes.push("先出角色参考图再做镜头视频只是建议的顺序，不是硬性要求：把新图设为人物参考图会签发新的分镜版本，已经生成的镜头视频会全部作废。");
  }

  const next = actions.find((action) => action.id === "openCharacterImages")
    || actions.find((action) => action.id === "openShotVideo")
    || null;

  // 7. 一句话修改。点名某一镜时：已经有镜头视频，就只改这一镜的视频提示词（不让其他镜头的视频作废）；
  // 还没有视频就改分镜。所以只在有视频时，给每个已写好提示词的镜头各一个「只改提示词」；
  // 分镜在有视频时仍可改，卡片上写明会让几条视频作废。
  addStoryEdit();
  add(editStoryboardAction(facts, variant));
  if (facts.plan.shots.some((shot) => shot.hasVideo)) {
    for (const shot of facts.plan.shots.filter((item) => item.promptCached)) add(editShotPromptAction(facts, variant, shot));
  }
  return {
    actions,
    next,
    notes,
    waitingFor: next ? "" : "每一镜都有视频了。挑选视频候选、导出在页面上做。"
  };
}

function action(id, params, { label, modelLabel = label, cost, guard, needsStoryPage = false, variantId = "", details = [], warning = "" }) {
  return {
    key: directorAgentActionKey(id, params),
    id,
    params,
    label,
    // 发给模型的标签：只有固定文字、编号和短的角色名，不含候选标题等模型写的长文字。
    modelLabel: truncate(modelLabel, DIRECTOR_AGENT_LIMITS.actionLabelChars),
    cost,
    guard: JSON.stringify(guard),
    needsStoryPage,
    variantId,
    details,
    warning
  };
}

function commonGuard(facts) {
  return { runId: facts.runId, epoch: facts.epoch, entryMode: facts.entryMode, storyMode: facts.storyMode };
}

function startPipelineAction(facts) {
  const isStory = facts.entryMode === "story";
  const continuing = isStory ? facts.storyContinuing : Boolean(facts.pipeline.failure);
  const label = isStory
    ? (continuing ? facts.labels.pipelineContinue : facts.labels.pipelineStart)
    : (continuing ? "继续 AI 导演" : "开始 AI 导演");
  const minCalls = isStory
    ? (facts.storyMode === "fullStoryText" ? DIRECTOR_AGENT_MIN_TEXT_CALLS.storyPipelineFullText : DIRECTOR_AGENT_MIN_TEXT_CALLS.storyPipelineCharacterOnly)
    : DIRECTOR_AGENT_MIN_TEXT_CALLS.directorPipeline;
  return action("startPipeline", [], {
    label,
    cost: { kind: "text", minCalls, model: facts.models.pipeline, lastUsage: facts.usage.pipeline || null,
      note: continuing ? "已完成的步骤不重跑，没跑完的那一步会重新计费" : "" },
    guard: { ...commonGuard(facts), setupReady: facts.setup.ready, continuing, pipelineDone: facts.pipeline.done }
  });
}

function regenerateCandidatesAction(facts) {
  return action("regenerateCandidates", [], {
    label: "换一批故事候选",
    cost: { kind: "text", minCalls: DIRECTOR_AGENT_MIN_TEXT_CALLS.variants, model: facts.models.candidates, lastUsage: facts.usage.variants || null,
      note: "现在这批候选会被替换" },
    guard: { ...commonGuard(facts), candidates: facts.candidates.map((candidate) => candidate.id), candidatesRevision: facts.candidatesRevision }
  });
}

function chooseCandidateAction(facts, candidate) {
  const precheck = facts.entryMode !== "story";
  return action("chooseCandidate", [candidate.id], {
    label: `选 ${candidate.id}${candidate.title ? `《${truncate(candidate.title, 24)}》` : ""}，展开成完整剧情`,
    modelLabel: `选 ${candidate.id}`,
    cost: { kind: "text", minCalls: precheck ? DIRECTOR_AGENT_MIN_TEXT_CALLS.fullStoryWithPrecheck : DIRECTOR_AGENT_MIN_TEXT_CALLS.fullStory,
      model: facts.models.story, lastUsage: facts.usage.fullStory || null,
      note: precheck ? "会先做展开前体检；体检建议修订时会停下来等你决定" : "" },
    guard: { ...commonGuard(facts), variantId: candidate.id, candidatesRevision: facts.candidatesRevision },
    variantId: candidate.id
  });
}

function openStoryPageAction(facts, variant) {
  return action("openStoryPage", [variant.id], {
    label: facts.storySlot ? "打开分场页" : `打开 ${variant.id} 的分场页`,
    cost: { kind: "free" },
    guard: { ...commonGuard(facts), variantId: variant.id },
    variantId: variant.id
  });
}

function generateFullStoryAction(facts, variant) {
  const precheck = facts.entryMode !== "story" && !facts.precheck?.passStillValid;
  return action("generateFullStory", [variant.id], {
    label: facts.storyFailure || facts.precheck?.failure ? "重新生成完整剧情" : "生成完整剧情",
    cost: { kind: "text", minCalls: precheck ? DIRECTOR_AGENT_MIN_TEXT_CALLS.fullStoryWithPrecheck : DIRECTOR_AGENT_MIN_TEXT_CALLS.fullStory,
      model: facts.models.story, lastUsage: facts.usage.fullStory || null,
      note: precheck ? "会先做展开前体检；体检建议修订时会停下来等你决定" : "" },
    guard: { ...commonGuard(facts), variantId: variant.id, storyExists: false, precheck: facts.precheck || null },
    needsStoryPage: true,
    variantId: variant.id
  });
}

function generateStoryboardAction(facts, variant) {
  const settings = facts.nextPlanSettings;
  const style = settings.artStyle || "未指定";
  const label = facts.legacyPlanVersion ? "重新生成分镜" : "生成分镜";
  return action("generateStoryboard", [variant.id], {
    label,
    modelLabel: `${label}（${settings.aspectRatio}，${settings.musicOn ? "有" : "无"}背景音乐）`,
    cost: { kind: "text", minCalls: DIRECTOR_AGENT_MIN_TEXT_CALLS.animationPlan, model: facts.models.plan, lastUsage: facts.usage.plan || null,
      note: "审阅报出问题时会再修订、终审" },
    details: [`画幅 ${settings.aspectRatio} · 画风 ${style} · ${settings.musicOn ? "有" : "无"}背景音乐`, "这些设置会写进分镜；要改的话先在页面上改好再确认。"],
    guard: { ...commonGuard(facts), variantId: variant.id, storyRevision: facts.story.revision, settings, model: facts.models.plan },
    needsStoryPage: true,
    variantId: variant.id
  });
}

function openCharacterImagesAction(facts, variant, role) {
  const videosExist = facts.plan.shots.some((shot) => shot.hasVideo);
  const name = truncate(role.name || `角色 ${role.index + 1}`, 12);
  return action("openCharacterImages", [variant.id, role.index], {
    label: `给「${name}」出角色参考图`,
    cost: { kind: "image", model: facts.models.image, note: "在弹窗里选张数后点生成，按供应商计费" },
    warning: videosExist ? "已经有镜头视频了：把新图「设为人物参考图」会签发新分镜版本，已生成的镜头视频会全部作废。" : "",
    guard: { ...commonGuard(facts), variantId: variant.id, planRevision: facts.plan.revision, roleIndex: role.index, hasImage: role.hasImage, model: facts.models.image },
    needsStoryPage: true,
    variantId: variant.id
  });
}

function openShotVideoAction(facts, variant, shot) {
  const textCalls = shot.promptCached ? 0 : DIRECTOR_AGENT_MIN_TEXT_CALLS.shotVideoPrompt;
  return action("openShotVideo", [variant.id, shot.shotId], {
    label: `生成镜头 ${shot.shotId} 的视频`,
    cost: { kind: "video", model: facts.models.video, textCalls, textModel: facts.models.plan,
      note: "在弹窗里确认后生成，按供应商计费" },
    guard: { ...commonGuard(facts), variantId: variant.id, planRevision: facts.plan.revision, shotId: shot.shotId, hasVideo: shot.hasVideo, model: facts.models.video },
    needsStoryPage: true,
    variantId: variant.id
  });
}

// ---- 一句话修改（2026-10-11）----

function editCost(facts) {
  return { kind: "text", minCalls: DIRECTOR_AGENT_MIN_TEXT_CALLS.oneSentenceEdit, model: facts.models.edit, lastUsage: facts.usage?.edit || null,
    note: "先出修改稿给你看，点「采纳」才生效；做不到时会说明原因，不硬改" };
}

function editStoryAction(facts, variant) {
  const invalidation = facts.edit.storyInvalidation || {};
  const counts = invalidation.counts || {};
  const noun = facts.storySlot ? "可翻拍镜头" : "完整剧情";
  return action("editStory", [variant.id], {
    label: facts.storySlot ? "按你的话修改可翻拍镜头" : "按你的话修改剧情",
    modelLabel: `按用户的话修改${noun}（情节、动作、台词）${counts.animationPlan ? "；采纳后分镜要重新生成" : ""}`,
    cost: editCost(facts),
    details: [
      `改的是：${noun}（${facts.story.sceneCount} 场）。场次、时间、地点和出镜角色不能改。`,
      ...(facts.entryMode === "story" && facts.storyMode === "fullStoryText"
        ? ["改过的台词会出现在台词核对的「在原文里找不到」里，这是预期的；你的原文本身不会变。"] : []),
      ...oneSentenceEditInvalidationLines("story", invalidation)
    ],
    warning: counts.animationPlan
      ? `采纳后分镜会作废，要重新生成分镜${counts.shotVideo ? `；已生成的 ${counts.shotVideo} 条镜头视频也一起作废` : ""}。`
      : "",
    guard: { ...commonGuard(facts), variantId: variant.id, storyRevision: facts.story.revision, model: facts.models.edit },
    needsStoryPage: true,
    variantId: variant.id
  });
}

function editStoryboardAction(facts, variant) {
  const invalidation = facts.edit?.storyboardInvalidation || {};
  const videos = invalidation.counts?.shotVideo || 0;
  return action("editStoryboard", [variant.id], {
    label: "按你的话修改分镜",
    modelLabel: `按用户的话修改分镜${videos ? `（已有 ${videos} 条镜头视频，采纳后全部作废）` : ""}`,
    cost: editCost(facts),
    details: [
      `改的是：分镜（${facts.plan.shots.length} 镜）。镜头数、时长、出镜角色和角色外观不能改；完整剧情不跟着改。`,
      ...oneSentenceEditInvalidationLines("storyboard", invalidation)
    ],
    warning: videos ? `已经有 ${videos} 条镜头视频：采纳后会全部作废。只想改某一镜的画面，说「只改 A0几 的提示词」更省。` : "",
    guard: { ...commonGuard(facts), variantId: variant.id, planRevision: facts.plan.revision, model: facts.models.edit },
    needsStoryPage: true,
    variantId: variant.id
  });
}

function editShotPromptAction(facts, variant, shot) {
  return action("editShotPrompt", [variant.id, shot.shotId], {
    label: `按你的话修改镜头 ${shot.shotId} 的视频提示词`,
    modelLabel: `按用户的话只改镜头 ${shot.shotId} 的视频提示词（不改分镜）`,
    cost: editCost(facts),
    details: [
      `改的是：镜头 ${shot.shotId} 的视频提示词，修改稿出在它的视频弹窗里。分镜不跟着改。`,
      ...oneSentenceEditInvalidationLines("shotPrompt")
    ],
    guard: { ...commonGuard(facts), variantId: variant.id, planRevision: facts.plan.revision, shotId: shot.shotId,
      promptRevision: shot.promptRevision || "", model: facts.models.edit, videoModel: facts.models.video },
    needsStoryPage: true,
    variantId: variant.id
  });
}

// 修改稿等用户决定：不提别的动作。修改稿在分场页上而用户不在分场页时，给一个回分场页的按钮。
function pendingEditActions(facts) {
  const pending = facts.edit.pending;
  const actions = pending.target !== "shotPrompt" && facts.route !== "story" && pending.variantId
    ? [openStoryPageAction(facts, { id: pending.variantId })]
    : [];
  return { actions, next: null, waitingFor: `${pending.label}的修改稿在${pending.where}，等你采纳或放弃。` };
}

// 发给 /api/director-agent/turn 的进度说明：只有状态、计数、固定标签和模型能选的动作。
// 挑候选不在里面（只做成按钮）；候选标题、模型写的文字、供应商报错原文一律不进，
// 免得这些文字里夹带指令影响模型。服务端按同一组上限再核一遍（src/director-agent.js）。
export function directorAgentProjection(progress) {
  const limits = DIRECTOR_AGENT_LIMITS;
  const actions = progress.actions
    .filter((item) => isModelSelectableDirectorAgentAction(item.key))
    .slice(0, limits.actions);
  const nextKey = progress.next && actions.some((item) => item.key === progress.next.key) ? progress.next.key : "";
  return {
    entry: progress.entry,
    steps: progress.steps.slice(0, limits.steps).map((item) => ({
      label: truncate(item.label, limits.stepLabelChars),
      status: item.status,
      ...(item.detail ? { detail: truncate(item.detail, limits.stepDetailChars) } : {})
    })),
    busy: truncate(progress.busy, limits.statusTextChars),
    waitingFor: truncate(progress.waitingFor, limits.statusTextChars),
    notes: (progress.notes || []).slice(0, limits.notes).map((note) => truncate(note, limits.statusTextChars)),
    nextKey,
    actions: actions.map((item) => ({ key: item.key, label: item.modelLabel, cost: item.cost.kind }))
  };
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}
