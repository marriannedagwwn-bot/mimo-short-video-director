// 导演助手（2026-10-09）的对话状态：消息、卡片、每步做完的总结、发给模型的内容。不碰 DOM。
//
// 对话只放在页面内存里：不进 Task Store、Artifact、localStorage 或 sessionStorage，刷新即清空
// （对话不是事实来源，docs/GitHub-Benchmark-后续改造待办.md:283）。刷新后它按当前进度重新打招呼。
//
// 「这一步做完了」不看任务状态从「运行」变「完成」：任务显示完成时，新结果还要再等一次
// /run/load 才进页面。这里改看两样东西——定义各步骤的 Artifact 与计数有没有变化，
// 以及哪些任务的结果已经是当前版本（taskForUi 只在结果进了页面之后才返回完成的任务）。
import {
  DIRECTOR_AGENT_LIMITS,
  DIRECTOR_AGENT_NO_ACTION,
  directorAgentEditTarget
} from "./director-agent-actions.js";
import { directorAgentProjection } from "./director-agent-progress.js";
import {
  candidatesChangedText,
  directorAgentCostLines,
  directorAgentGreeting,
  directorAgentWhereText,
  failureText,
  oneSentenceEditEventText,
  pipelineDoneText,
  planDoneText,
  precheckAwaitingText,
  precheckFailureText,
  roleImageText,
  shotVideoDoneText,
  storyDoneText
} from "./director-agent-messages.js";
import { formatStageUsageSuffix } from "./token-usage-format.js";

const PENDING = "pending";
// 卡片上引用用户原话的长度上限：原话本身最多 500 字，卡片只摘前面一段，执行时用的是完整原话。
const INSTRUCTION_PREVIEW_CHARS = 120;

export function createDirectorAgentController({ maxMessages = 150 } = {}) {
  const messages = [];
  let sequence = 0;
  let baseline = null;
  let pendingTurn = false;
  // 这一轮用户说的原话：模型对上「按你的话修改」时，卡片带上它，确认后就按这句话写修改稿。
  let turnMessage = "";

  function push(message) {
    const entry = { id: `agent-message-${++sequence}`, ...message };
    messages.push(entry);
    if (messages.length > maxMessages) messages.splice(0, messages.length - maxMessages);
    return entry;
  }

  function pendingCards() {
    return messages.filter((message) => message.card?.state === PENDING);
  }

  function voidPendingCards(stateText) {
    for (const message of pendingCards()) Object.assign(message.card, { state: "void", stateText });
  }

  // 同一时间只留一张待确认的卡：新卡出来，旧的待确认卡标成「已被新的建议取代」。
  // 同一个动作、核对项也没变时不重复发卡；但用户刚问过（打字或点「下一步」）而那张卡已经被
  // 后面的消息压在上面时，把它挪到最下面，免得用户往上翻才找得到「确认执行」。
  // 「按你的话修改」的卡带着用户的原话：原话不同就是另一件事，出新卡。
  function postCard(action, lead = "", { moveToEnd = false, instruction = "" } = {}) {
    const current = pendingCards().at(-1);
    if (current && current.card.key === action.key && current.card.guard === action.guard
      && (current.card.instruction || "") === instruction) {
      if (!moveToEnd || messages.at(-1) === current) return current;
      Object.assign(current.card, { state: "superseded", stateText: "已移到下面" });
    }
    for (const message of pendingCards()) Object.assign(message.card, { state: "superseded", stateText: "已被新的建议取代" });
    return push({
      role: "system",
      text: lead,
      card: {
        key: action.key,
        guard: action.guard,
        title: action.label,
        ...(instruction ? { instruction } : {}),
        lines: [
          ...(instruction ? [`你说的：「${truncate(instruction, INSTRUCTION_PREVIEW_CHARS)}」`] : []),
          ...(action.details || []),
          ...directorAgentCostLines(action)
        ],
        warning: action.warning || "",
        state: PENDING,
        stateText: ""
      }
    });
  }

  // 没有下一步时说清楚在等什么；需要用户挑候选时附上候选按钮（挑哪个由用户自己点）。
  // 刚打过招呼时招呼里已经说了在等什么，只补候选按钮，不再重复那句话。
  function postWaiting(progress, lead = "", { withText = true } = {}) {
    const chips = progress.actions
      .filter((action) => action.id === "chooseCandidate" || action.id === "openStoryPage")
      .map((action) => ({ key: action.key, label: action.label }));
    const text = withText ? [lead, progress.busy ? `正在进行：${progress.busy}` : progress.waitingFor].filter(Boolean).join("") : "";
    if (!text && !chips.length) return null;
    const last = messages.at(-1);
    if (last && last.role === "system" && last.text === text && JSON.stringify(last.chips || []) === JSON.stringify(chips)) return last;
    return push({ role: "system", text, chips });
  }

  function propose(progress, lead = "") {
    return progress.next ? postCard(progress.next, lead) : postWaiting(progress, lead);
  }

  return {
    get messages() { return messages; },
    get pendingTurn() { return pendingTurn; },

    // 每次页面状态可能变化后调用。第一次（以及换了 Run 或工作区之后）只记基线、打招呼，
    // 不把已经完成的步骤当成刚完成的再报一遍。
    observe(facts, progress) {
      if (!facts.restored) return false;
      const snapshot = milestones(facts);
      if (!baseline || baseline.scope !== snapshot.scope) {
        const first = !baseline;
        const hadRun = Boolean(baseline?.hasRun);
        baseline = snapshot;
        if (first) {
          push({ role: "system", text: directorAgentGreeting(progress) });
          if (progress.next) postCard(progress.next);
          else postWaiting(progress, "", { withText: false });
          return true;
        }
        if (hadRun) {
          voidPendingCards("已经换成新的 Run，这张卡作废了");
          push({ role: "system", text: "已经换成新的 Run。" });
          propose(progress);
          return true;
        }
        // 原来没有 Run、换上来的 Run 已经有结果：只有导入测试包会这样（2026-10-10）。说一声再按进度提议，
        // 不然页面已经换了内容、对话里还停在打招呼那句。刚开始跑的新 Run 还没有结果，照旧不说话，等那一步做完再报。
        if (snapshot.hasRun && snapshot.pipelineDone) {
          voidPendingCards("已经打开新的 Run，这张卡作废了");
          push({ role: "system", text: "已经打开新的 Run。" });
          propose(progress);
          return true;
        }
        return false;
      }
      const notes = diffMilestones(baseline, snapshot, facts);
      baseline = snapshot;
      if (!notes.length) return false;
      for (const text of notes) push({ role: "system", text });
      if (!progress.busy) propose(progress);
      return true;
    },

    // 「下一步」：不调模型，直接给卡片或说明在等什么。
    showNext(progress) {
      if (progress.next) return postCard(progress.next, "", { moveToEnd: true });
      return postWaiting(progress) || push({ role: "system", text: directorAgentWhereText(progress) });
    },

    // 「现在到哪了」：不调模型。
    showStatus(progress) {
      return push({ role: "system", text: directorAgentWhereText(progress) });
    },

    // 候选按钮：用户自己点了某个候选，才出这张卡。
    showChoice(key, progress) {
      const action = progress.actions.find((item) => item.key === key);
      if (!action) return push({ role: "system", text: "这个选项现在不能用了。" });
      return postCard(action, "", { moveToEnd: true });
    },

    // 发给模型之前：先记下用户的话，再按上限组装请求。历史只取用户的话和导演助手之前的回复，
    // 不含规则生成的总结（里面可能有候选标题或供应商报错原文）。
    beginTurn(text, progress) {
      if (pendingTurn) return null;
      const message = String(text || "").trim();
      if (!message) return null;
      const history = messages
        .filter((entry) => entry.role === "user" || entry.role === "agent")
        .slice(-DIRECTOR_AGENT_LIMITS.historyEntries)
        .map((entry) => ({ role: entry.role, text: truncate(entry.text, DIRECTOR_AGENT_LIMITS.historyChars) }));
      push({ role: "user", text: truncate(message, DIRECTOR_AGENT_LIMITS.messageChars) });
      pendingTurn = true;
      turnMessage = truncate(message, DIRECTOR_AGENT_LIMITS.messageChars);
      return {
        message: truncate(message, DIRECTOR_AGENT_LIMITS.messageChars),
        history,
        progress: directorAgentProjection(progress)
      };
    },

    // 模型的回复。它选的编号按回复到达时的进度重新找：找不到就不出卡片，说清楚原因。
    finishTurn({ turn, usage = null } = {}, progress) {
      pendingTurn = false;
      const instruction = turnMessage;
      turnMessage = "";
      push({ role: "agent", text: turn.reply, meta: usageText(usage, "这条回复") });
      if (!turn.actionKey || turn.actionKey === DIRECTOR_AGENT_NO_ACTION) return null;
      const action = progress.actions.find((item) => item.key === turn.actionKey);
      if (!action) return push({ role: "system", text: "它提的这一步现在不能做了（进度刚刚变了）。点「下一步」看看现在能做什么。" });
      return postCard(action, "", { moveToEnd: true, instruction: directorAgentEditTarget(action.id) ? instruction : "" });
    },

    failTurn(error, usage = null) {
      pendingTurn = false;
      turnMessage = "";
      const spent = usageText(usage, "失败前");
      return push({
        role: "error",
        text: `导演助手这次没有回答：${error?.message || "未知原因"}。可以换个说法再试，或者点「下一步」「现在到哪了」，它们不调用模型。`,
        meta: spent
      });
    },

    card(id) {
      const message = messages.find((entry) => entry.id === id);
      return message?.card ? message : null;
    },

    markCard(id, state, stateText = "") {
      const message = messages.find((entry) => entry.id === id);
      if (message?.card) Object.assign(message.card, { state, stateText });
      return message || null;
    }
  };
}

// ---- 里程碑：用来判断「这一步刚做完」 ----

export function milestones(facts) {
  const plan = facts.plan;
  return {
    scope: `${facts.runId || ""}|${facts.epoch ?? ""}|${facts.entryMode || ""}`,
    hasRun: Boolean(facts.runId),
    pipelineDone: Boolean(facts.pipeline?.done),
    candidatesKey: facts.pipeline?.done ? String(facts.candidatesRevision || "") : "",
    storyTaskId: facts.storyTaskId || "",
    planTaskId: facts.planTaskId || "",
    planVariant: plan ? String(facts.chosenVariantId || "") : "",
    rolesWithImage: plan ? plan.roles.filter((role) => role.hasImage).map((role) => role.index) : [],
    shotsWithVideo: plan ? plan.shots.filter((shot) => shot.hasVideo).map((shot) => shot.shotId) : [],
    failures: (facts.failures || []).map((failure) => failure.id),
    precheckAwaiting: Boolean(facts.precheck?.awaitingDecision),
    precheckFailure: facts.precheck?.failure?.id || "",
    editEvent: facts.edit?.event?.id || ""
  };
}

function diffMilestones(previous, next, facts) {
  const notes = [];
  if (!previous.pipelineDone && next.pipelineDone) notes.push(pipelineDoneText(facts));
  else if (previous.pipelineDone && next.pipelineDone && next.candidatesKey && next.candidatesKey !== previous.candidatesKey
    && facts.entryMode !== "story") notes.push(candidatesChangedText(facts));
  if (next.storyTaskId && next.storyTaskId !== previous.storyTaskId && facts.story?.exists) notes.push(storyDoneText(facts));
  const planGenerated = next.planTaskId && next.planTaskId !== previous.planTaskId && facts.plan;
  if (planGenerated) notes.push(planDoneText(facts));
  // 同一个故事的分镜里，角色多了参考图、镜头多了视频。新生成的分镜不算（那是新分镜自己的状态）。
  if (!planGenerated && next.planVariant && next.planVariant === previous.planVariant) {
    for (const role of facts.plan.roles) {
      if (role.hasImage && !previous.rolesWithImage.includes(role.index)) notes.push(roleImageText(role));
    }
    for (const shotId of next.shotsWithVideo) {
      if (!previous.shotsWithVideo.includes(shotId)) notes.push(shotVideoDoneText(shotId, facts));
    }
  }
  for (const failure of facts.failures || []) {
    if (!previous.failures.includes(failure.id)) notes.push(failureText(failure));
  }
  if (!previous.precheckAwaiting && next.precheckAwaiting) notes.push(precheckAwaitingText());
  if (next.precheckFailure && next.precheckFailure !== previous.precheckFailure) notes.push(precheckFailureText(facts.precheck.failure));
  // 一句话修改：修改稿写好、没改成、采纳、放弃、过期、失败，各报一句。
  if (next.editEvent && next.editEvent !== previous.editEvent) notes.push(oneSentenceEditEventText(facts.edit.event));
  return notes;
}

function usageText(usage, label) {
  if (!usage) return "";
  const suffix = formatStageUsageSuffix(usage, { label: `${label}用了` });
  return suffix.replace(/^ · /u, "");
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}
