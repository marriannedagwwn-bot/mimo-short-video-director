import { directorControlView } from "./director-pipeline-ui.js";
import { taskStatusView } from "./task-status-ui.js";
import { formatStageUsageSuffix } from "./token-usage-format.js";

// noun 是这一步在页面上的叫法：默认「完整剧情」；「粘贴完整故事」的剧情 Run 叫「可翻拍镜头」。
export function fullStoryControlView(task, { starting = false, pendingAction = "", idleLabel = "生成完整剧情", noun = "完整剧情" } = {}) {
  const view = directorControlView(task, { starting, pendingAction });
  const active = ["queued", "running"].includes(task?.status);
  const labels = {
    pausing: `正在暂停${noun}…`,
    paused: `${noun}已暂停`,
    terminating: `正在终止${noun}…`
  };
  return {
    ...view,
    label: active ? labels[task.progress?.controlState] || (task.status === "queued" ? `${noun}排队中…` : `${noun}生成中…`)
      : starting ? `正在启动${noun}…` : idleLabel,
    pauseLabel: view.paused ? `继续生成${noun}` : `暂停生成${noun}`
  };
}

export function fullStoryTaskView(task, { modelLabel = "", noun = "完整剧情" } = {}) {
  const view = taskStatusView(task, { modelLabel, kindLabel: noun });
  if (!view) return null;
  const controlState = task.progress?.controlState || "running";
  const messages = {
    pausing: `${noun}正在暂停，等待当前请求断开`,
    paused: `${noun}已暂停，继续会重新生成，可能再次计费`,
    terminating: `${noun}正在终止，等待当前请求断开`
  };
  if (view.busy && messages[controlState]) {
    view.message = `${messages[controlState]}${modelLabel ? ` · ${modelLabel}` : ""}`;
    view.buttonLabel = fullStoryControlView(task, { noun }).label;
    if (controlState === "paused") view.tone = "warn";
  } else if (task.status === "cancelled") {
    view.message = `${noun}已终止，已有结果已保留`;
  }
  view.message += formatStageUsageSuffix(task.usage, {
    label: view.busy ? "已确认消耗" : task.status === "completed" ? "本次消耗" : "结束前已消耗"
  });
  return view;
}
