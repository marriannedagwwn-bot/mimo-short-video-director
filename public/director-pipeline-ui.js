import { formatStageUsageSuffix } from "./token-usage-format.js";

function completedStages(task) {
  const value = Number(task?.progress?.completedStages);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function nextDirectorArtifactSync(checkpoint = {}, task = {}) {
  const taskId = String(task?.taskId || "").trim();
  if (!taskId) return null;
  const completed = completedStages(task);
  const previous = checkpoint.taskId === taskId
    ? Math.max(0, Math.floor(Number(checkpoint.completedStages) || 0))
    : 0;
  if (completed <= previous) return null;
  return {
    taskId,
    previousCompletedStages: previous,
    completedStages: completed
  };
}

export function createDirectorArtifactSynchronizer({ reloadRun, renderCompletedStages, onReloadError } = {}) {
  if (typeof reloadRun !== "function" || typeof renderCompletedStages !== "function") {
    throw new TypeError("director artifact synchronizer requires reloadRun and renderCompletedStages");
  }
  let checkpoint = { taskId: "", completedStages: 0 };
  let inFlight = null;
  let generation = 0;

  const sync = async (task) => {
    const target = nextDirectorArtifactSync(checkpoint, task);
    if (!target) return false;
    if (inFlight) {
      const coveredByCurrentReload = inFlight.taskId === target.taskId
        && inFlight.completedStages >= target.completedStages;
      await inFlight.promise;
      if (coveredByCurrentReload) return false;
      return sync(task);
    }

    const syncGeneration = generation;
    const promise = (async () => {
      try {
        const run = await reloadRun(task, target);
        if (syncGeneration !== generation) return false;
        await renderCompletedStages(target, run, task);
        if (syncGeneration !== generation) return false;
        checkpoint = { taskId: target.taskId, completedStages: target.completedStages };
        return true;
      } catch (error) {
        if (typeof onReloadError === "function") onReloadError(error, task, target);
        return false;
      }
    })();
    inFlight = { taskId: target.taskId, completedStages: target.completedStages, promise };
    try {
      return await promise;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  };

  return Object.freeze({
    sync,
    reset() {
      generation += 1;
      checkpoint = { taskId: "", completedStages: 0 };
    },
    markRendered(task, renderedCompletedStages = completedStages(task)) {
      const taskId = String(task?.taskId || "").trim();
      if (!taskId) return;
      checkpoint = {
        taskId,
        completedStages: Math.max(0, Math.floor(Number(renderedCompletedStages) || 0))
      };
    },
    snapshot() {
      return { ...checkpoint };
    }
  });
}

export function formatDirectorCompletionStatus(task = {}, usageSuffix = "") {
  const parts = ["AI 导演阶段完成"];
  const totalStages = Math.max(
    0,
    Math.floor(Number(task.progress?.totalStages) || 0),
    Array.isArray(task.targetArtifactIds) ? task.targetArtifactIds.length : 0
  );
  if (Number.isInteger(task.progress?.reusedStages) && task.progress.reusedStages >= 0) {
    if (task.progress.reusedStages > 0) parts.push(`复用 ${task.progress.reusedStages} 个已有阶段`);
  } else if (Array.isArray(task.childTaskIds) && totalStages > 0) {
    const executedStages = new Set(task.childTaskIds.filter(Boolean)).size;
    const reusedStages = Math.max(0, totalStages - executedStages);
    if (reusedStages > 0) parts.push(`复用 ${reusedStages} 个已有阶段`);
  }
  const calls = Number(task.usage?.calls);
  if (Number.isFinite(calls) && calls > 0) parts.push(`本次实际调用 ${Math.floor(calls)} 次模型`);
  return `${parts.join(" · ")}${String(usageSuffix || "")}`;
}

export function directorControlView(task, { starting = false, pendingAction = "" } = {}) {
  const active = ["queued", "running"].includes(task?.status);
  const controlState = task?.progress?.controlState || "running";
  const paused = active && controlState === "paused";
  const settling = ["pausing", "terminating"].includes(controlState);
  const labels = { pausing: "正在暂停当前阶段…", paused: "AI 导演已暂停", terminating: "正在终止 AI 导演…" };
  return {
    visible: active || starting,
    label: active ? labels[controlState] || (task.status === "queued" ? "AI 导演排队中…" : "AI 导演工作中…")
      : starting ? "正在启动 AI 导演…" : "启动 AI 导演",
    pauseLabel: paused ? "继续当前阶段" : "暂停当前阶段",
    pauseAction: paused ? "resume" : "pause",
    paused,
    stopDisabled: !active || Boolean(pendingAction) || controlState === "terminating",
    pauseDisabled: !active || Boolean(pendingAction) || settling
  };
}

export function directorTaskView(task = {}, { modelLabel = "" } = {}) {
  const active = ["queued", "running"].includes(task.status);
  const controlState = task.progress?.controlState || "running";
  const model = modelLabel ? ` · ${modelLabel}` : "";
  const labels = {
    pausing: "AI 导演正在暂停，等待当前请求断开",
    paused: "AI 导演已暂停，继续会重新执行当前阶段",
    terminating: "AI 导演正在终止，等待当前请求断开"
  };
  const terminal = {
    failed: "AI 导演阶段失败", interrupted: "AI 导演已中断",
    conflicted: "AI 导演因依赖变化停止", abandoned: "AI 导演已放弃",
    cancelled: "AI 导演已终止，已完成阶段已保留"
  };
  const usage = formatStageUsageSuffix(task.usage, {
    label: active ? "已确认消耗" : task.status === "completed" ? "本次消耗" : "结束前已消耗"
  });
  const message = task.status === "completed" ? formatDirectorCompletionStatus(task, usage)
    : active ? `${labels[controlState] || (task.status === "queued" ? "AI 导演任务排队中"
      : `AI 导演执行中 ${completedStages(task)}/5`)}${model}${usage}`
      : `${terminal[task.status] || "AI 导演任务状态未知"}${task.error?.message && task.status !== "cancelled" ? `：${task.error.message}` : ""}${usage}`;
  return {
    active, controlState, message,
    tone: task.status === "completed" ? "ready" : active ? controlState === "paused" ? "warn" : "active"
      : task.status === "failed" ? "error" : "warn",
    stageStatus: active ? controlState === "paused" ? "paused" : "active"
      : task.status === "completed" ? "done" : task.status === "failed" ? "error" : "stopped"
  };
}
