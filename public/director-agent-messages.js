// 导演助手（2026-10-09）里所有由规则生成的文字：打招呼、进度、卡片上的花费、每步做完的总结。
// 只报状态和计数，不评价好坏（签发成功不等于合格，AGENTS.md「不能因签发成功称为合格产品」）。
// 模型写的回复另外标成「AI 回复」，不经过这里。
import { formatStageUsageSuffix } from "./token-usage-format.js";
import { oneSentenceEditInvalidatedParts, oneSentenceEditTargetLabel } from "./one-sentence-edit-ui.js";

const STATUS_TEXT = Object.freeze({
  done: "完成", running: "进行中", paused: "已暂停", failed: "没有成功", waiting: "等你决定", todo: "没开始"
});

export function directorAgentStatusText(status) {
  return STATUS_TEXT[status] || "";
}

export function directorAgentGreeting(progress) {
  return `我是导演助手：按你现在的进度提议下一步，你点「确认执行」才会执行，花费写在卡片上。${directorAgentWhereText(progress)}`;
}

// 「现在到哪了」：第一个没完成的步骤，加上正在进行的事、在等什么或下一步建议。
export function directorAgentWhereText(progress) {
  const current = progress.steps.find((step) => step.status !== "done");
  const where = current
    ? `现在做到「${current.label}」（${STATUS_TEXT[current.status]}${current.detail ? `，${current.detail}` : ""}）。`
    : "全部步骤都完成了。";
  if (progress.busy) return `${where}正在进行：${progress.busy}`;
  if (progress.waitingFor) return `${where}${progress.waitingFor}`;
  if (progress.next) return `${where}下一步建议：${progress.next.label}。`;
  return where;
}

// 卡片上的花费。文本步骤写「至少调用几次」（下限）和这个 Run 上次同类步骤的实际用量；
// 出图和视频只写数量与计费方式，不估价（单价未知）。
export function directorAgentCostLines(action) {
  const cost = action?.cost || {};
  if (cost.kind === "free") return ["不花钱"];
  if (cost.kind === "text") {
    const lines = [`文本模型 ${cost.model || "（未知模型）"} · 至少调用 ${cost.minCalls} 次，重试和修订会更多`];
    const last = lastUsageText(cost.lastUsage);
    if (last) lines.push(last);
    if (cost.note) lines.push(cost.note);
    return lines;
  }
  if (cost.kind === "image") return [`出图 ${cost.model || "（未知模型）"} · ${cost.note}`];
  if (cost.kind === "video") {
    return [
      `视频 ${cost.model || "（未知模型）"} · ${cost.note}`,
      cost.textCalls
        ? `打开弹窗时会先调用 ${cost.textCalls} 次文本模型（${cost.textModel || "未知模型"}）写这一镜的提示词`
        : "这一镜的提示词已经写好，打开弹窗不花钱"
    ];
  }
  return [];
}

function lastUsageText(usage) {
  if (!usage || typeof usage !== "object") return "";
  const calls = Math.max(0, Math.floor(Number(usage.calls) || 0));
  const suffix = formatStageUsageSuffix(usage, { label: "用了" });
  if (!calls && !suffix) return "";
  return `这个 Run 上次同类步骤：${[calls ? `${calls} 次调用` : "", suffix.replace(/^ · /u, "")].filter(Boolean).join(" · ")}`;
}

// ---- 每步做完的总结（只报计数）----

export function pipelineDoneText(facts) {
  if (facts.entryMode !== "story") {
    return `AI 导演跑完了，出了 ${facts.candidates.length} 个故事候选。挑一个你喜欢的，点下面的候选按钮。`;
  }
  if (facts.storyMode === "fullStoryText") return `可翻拍镜头拆好了：${storyCounts(facts.story) || "已生成"}。`;
  return "故事候选写好了。看看满不满意，满意就点下面的按钮展开成完整剧情。";
}

export function candidatesChangedText(facts) {
  return `换好了一批：${facts.candidates.length} 个新的故事候选。`;
}

export function storyDoneText(facts) {
  const counts = storyCounts(facts.story);
  return facts.storySlot ? `重新拆好了：${counts || "已生成"}。` : `完整剧情好了${counts ? `：${counts}` : ""}。`;
}

export function planDoneText(facts) {
  const plan = facts.plan;
  const missing = plan.roles.filter((role) => !role.hasImage).length;
  const parts = [`${plan.shots.length} 镜`, plan.seconds ? `共 ${plan.seconds} 秒` : "", plan.aspectRatio, `画风 ${plan.artStyle || "未指定"}`].filter(Boolean);
  const roles = plan.roles.length ? (missing ? `${missing} 个角色还没有参考图` : "角色都有参考图了") : "";
  return `分镜好了：${parts.join("，")}${roles ? `；${roles}` : ""}。`;
}

export function roleImageText(role) {
  return `「${role.name || `角色 ${role.index + 1}`}」有参考图了。`;
}

export function shotVideoDoneText(shotId, facts) {
  const shots = facts.plan?.shots || [];
  const remaining = shots.filter((shot) => !shot.hasVideo).length;
  return `镜头 ${shotId} 的视频好了。${remaining ? `还有 ${remaining} 镜没有视频。` : "每一镜都有视频了。"}`;
}

export function failureText(failure) {
  const filtered = failure.contentFiltered
    ? "这次是被内容审核拦下的。审核结果不稳定，同样的内容重试常能通过；要不要再跑由你决定，系统不会自动重试。"
    : "可以再试一次，会重新计费。";
  return `${failure.label}没有成功：${failure.text}。${filtered}`;
}

export function precheckAwaitingText() {
  return "展开前体检建议先改一下这个候选，修订稿已经放在页面上的体检面板里。采纳修订并展开，还是按原候选展开，由你在面板里决定。";
}

export function precheckFailureText(failure) {
  return `展开前体检没有跑完：${failure.text}。可以在页面上重试体检，或者按原候选展开。`;
}

// 一句话修改（2026-10-11）各个结果的总结。只报计数与位置；AI 写的说明只放在页面上的修改稿里。
export function oneSentenceEditEventText(event) {
  const label = oneSentenceEditTargetLabel(event.target, event.shotId, { storySlot: Boolean(event.storySlot) });
  switch (event.type) {
    case "ready": {
      // 「处」与 AI 说明里的口径一致（几处替换）；一个字段里改了几处时，预览按字段列，所以两数都报。
      const patches = Number(event.patches) || event.changes;
      return patches === event.changes
        ? `${label}的修改稿写好了：改了 ${event.changes} 处。`
        : `${label}的修改稿写好了：改了 ${event.changes} 段文字，共 ${patches} 处替换。`;
    }
    case "declined":
      return `这句话没有改成：AI 认为做不到或没说清楚，原因写在${event.where}。可以换个说法再说一次。`;
    case "adopted": {
      const parts = oneSentenceEditInvalidatedParts(event.target, event.invalidation);
      const tail = event.target === "shotPrompt"
        ? "这一镜已有的视频不会自动重做，要用新提示词就重新生成这一镜。"
        : parts.length ? `作废了：${parts.join("、")}。` : "";
      return `改好了：${label}签发了新版本。${tail}`;
    }
    case "discarded":
      return `放弃了这份修改稿，${label}没有变。`;
    case "expired":
      return `${label}已经变了，这份修改稿作废了。要改的话请再说一次。`;
    case "failed":
      return `${label}的修改稿没有写出来：${event.error}。${event.contentFiltered
        ? "这次是被内容审核拦下的。审核结果不稳定，同样的内容重试常能通过；要不要再说一次由你决定，系统不会自动重试。"
        : "可以再说一次，会重新计费。"}`;
    default:
      return "";
  }
}

function storyCounts(story) {
  if (!story?.exists) return "";
  return [story.sceneCount ? `${story.sceneCount} 场` : "", story.seconds ? `共 ${story.seconds} 秒` : ""].filter(Boolean).join("，");
}
