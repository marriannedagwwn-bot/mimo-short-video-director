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
  if (Array.isArray(task.childTaskIds) && totalStages > 0) {
    const executedStages = new Set(task.childTaskIds.filter(Boolean)).size;
    const reusedStages = Math.max(0, totalStages - executedStages);
    if (reusedStages > 0) parts.push(`复用 ${reusedStages} 个已有阶段`);
  }
  const calls = Number(task.usage?.calls);
  if (Number.isFinite(calls) && calls > 0) parts.push(`本次实际调用 ${Math.floor(calls)} 次模型`);
  return `${parts.join(" · ")}${String(usageSuffix || "")}`;
}
