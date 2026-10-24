import { providerErrorText } from "./compiler-observability.js";

const ACTIVE = new Set(["queued", "running"]);
const STORYBOARD_STEPS = Object.freeze({
  storyboardCharacterFacts: "整理角色事实", storyboardDesign: "设计分镜",
  storyboardReview: "审阅分镜", storyboardRevision: "按问题修订", storyboardReviewFinal: "终审复查"
});
const LABELS = Object.freeze({
  directorPipeline: "AI 导演", variants: "主题变体", fullStory: "完整剧情",
  animationPlan: "动画生产包",
  characterReferenceRefine: "人物参考精修", characterReferenceImages: "角色参考图",
  shotVideo: "镜头视频",
  // 参考片仿写（2026-10-24）自己的分步进度在 public/reference-rewrite-ui.js 的 referenceRewriteProgressText。
  referenceRewrite: "参考片仿写"
});
const TERMINAL_LABELS = Object.freeze({
  completed: "已完成", failed: "失败", conflicted: "因依赖变化停止",
  interrupted: "已中断", abandoned: "已放弃", cancelled: "已取消"
});

export function isActiveTask(task) { return ACTIVE.has(task?.status); }

export function taskErrorMessage(task, fallback = "") {
  const message = task?.error?.message || fallback;
  const explained = providerErrorText(task?.error?.providerError);
  return explained ? `${message}：${explained}` : message;
}

// UI snapshots only. They never commit Artifacts or refresh frozen dependencies.
export function rememberTaskSnapshot(snapshots, task) {
  if (!task?.taskId) return false;
  const previous = snapshots[task.taskId];
  if (previous) {
    if (!isActiveTask(previous) && isActiveTask(task)) return false;
    const previousTime = previous.updatedAt || previous.lastProgressAt || previous.createdAt || "";
    const nextTime = task.updatedAt || task.lastProgressAt || task.createdAt || "";
    if (nextTime < previousTime) return false;
  }
  snapshots[task.taskId] = task;
  return true;
}

export function latestTaskForTarget(snapshots, { kinds, artifactId, rootOnly = false } = {}) {
  return Object.values(snapshots || {})
    .filter((task) => (!kinds || kinds.includes(task.kind))
      && (!artifactId || task.targetArtifactIds?.includes(artifactId))
      && (!rootOnly || !task.parentTaskId))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0] || null;
}

// kindLabel 让页面按入口换叫法（剧情入口的 animationPlan 叫「分镜」等）；不传时沿用 LABELS。
export function taskStatusView(task, { modelLabel = "", kindLabel = "" } = {}) {
  if (!task) return null;
  const label = kindLabel || LABELS[task.kind] || "任务";
  const model = modelLabel ? ` · ${modelLabel}` : "";
  const busy = isActiveTask(task);
  let message;
  let buttonLabel;
  if (task.status === "queued") {
    message = `${label}任务正在排队${model}…`;
    buttonLabel = `${label}排队中…`;
  } else if (task.status === "running") {
    const chars = Number(task.progress?.streamedChars);
    const progress = Number.isFinite(chars) && chars > 0 ? ` · 已接收 ${Math.floor(chars)} 字` : "";
    message = `正在生成${label}${model}${progress}…`;
    if (task.kind === "animationPlan" && task.progress?.step) {
      const reasoning = Number(task.progress.reasoningChars);
      const activity = Number.isFinite(chars) && chars > 0 ? `已接收 ${Math.floor(chars)} 字`
        : `推理中${task.progress.reasoningChars != null && Number.isFinite(reasoning) && reasoning >= 0 ? `（已推理 ${Math.floor(reasoning)} 字）` : ""}`;
      message = `正在生成${label}${model} · 第 ${task.progress.stepIndex}/${task.progress.stepMax} 步 ${STORYBOARD_STEPS[task.progress.step] || task.progress.step} · ${activity}…`;
    }
    buttonLabel = `${label}生成中…`;
    if (task.kind === "characterReferenceRefine") {
      message = `正在进行${label}${model}${progress}…`;
      buttonLabel = `${label}进行中…`;
    }
    if (task.kind === "characterReferenceImages") {
      const count = Number(task.progress?.expectedCount) || 0;
      const ready = Number(task.progress?.readyCount) || 0;
      message = count ? `角色参考图已返回 ${ready}/${count} 张${model}…` : message;
    }
  } else {
    message = taskErrorMessage(task, `${label}任务${TERMINAL_LABELS[task.status] || "状态未知"}${model}`);
  }
  return {
    busy, buttonLabel, message,
    tone: busy ? "active" : task.status === "completed" ? "ready"
      : ["cancelled", "abandoned", "interrupted", "conflicted"].includes(task.status) ? "warn" : "error"
  };
}
