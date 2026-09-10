import { directorControlView } from "./director-pipeline-ui.js";
import { taskStatusView } from "./task-status-ui.js";
import { formatStageUsageSuffix } from "./token-usage-format.js";

export function fullStoryControlView(task, { starting = false, pendingAction = "", idleLabel = "生成完整剧情" } = {}) {
  const view = directorControlView(task, { starting, pendingAction });
  const active = ["queued", "running"].includes(task?.status);
  const labels = {
    pausing: "正在暂停完整剧情…",
    paused: "完整剧情已暂停",
    terminating: "正在终止完整剧情…"
  };
  return {
    ...view,
    label: active ? labels[task.progress?.controlState] || (task.status === "queued" ? "完整剧情排队中…" : "完整剧情生成中…")
      : starting ? "正在启动完整剧情…" : idleLabel,
    pauseLabel: view.paused ? "继续生成完整剧情" : "暂停生成完整剧情"
  };
}

export function fullStoryTaskView(task, { modelLabel = "" } = {}) {
  const view = taskStatusView(task, { modelLabel });
  if (!view) return null;
  const controlState = task.progress?.controlState || "running";
  const messages = {
    pausing: "完整剧情正在暂停，等待当前请求断开",
    paused: "完整剧情已暂停，继续会重新生成，可能再次计费",
    terminating: "完整剧情正在终止，等待当前请求断开"
  };
  if (view.busy && messages[controlState]) {
    view.message = `${messages[controlState]}${modelLabel ? ` · ${modelLabel}` : ""}`;
    view.buttonLabel = fullStoryControlView(task).label;
    if (controlState === "paused") view.tone = "warn";
  } else if (task.status === "cancelled") {
    view.message = "完整剧情已终止，已有结果已保留";
  }
  view.message += formatStageUsageSuffix(task.usage, {
    label: view.busy ? "已确认消耗" : task.status === "completed" ? "本次消耗" : "结束前已消耗"
  });
  return view;
}
