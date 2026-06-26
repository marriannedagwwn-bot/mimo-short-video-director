import { executeProductionWorkspace } from "./video-production-executor.js";
import { loadProductionPreflight } from "./video-production-preflight.js";
import { loadProductionReport } from "./video-production-report.js";

export async function makeProductionVideo(options = {}) {
  const root = trimRoot(options.root || "production");
  const httpWorker = options.httpWorker || "./workers/generic-http-worker.mjs";
  const postprocessWorker = options.postprocessWorker || "./workers/local-postprocess-worker.mjs";
  const command = options.command || process.execPath;
  const continueOnError = Boolean(options.continueOnError);
  const configPath = options.configPath || "";
  const httpCommandArgs = [httpWorker, ...(configPath ? ["--config", configPath] : [])];
  const postprocessCommandArgs = [postprocessWorker];
  const previousFfmpeg = process.env.LOCAL_POSTPROCESS_FFMPEG;
  if (options.ffmpeg) process.env.LOCAL_POSTPROCESS_FFMPEG = options.ffmpeg;

  try {
    const preflight = await loadProductionPreflight(root, {
      provider: "command",
      command,
      commandArgs: httpCommandArgs,
      configPath
    });
    if (!options.skipPreflight && !preflight.passed) {
      const error = new Error("视频生产预检未通过；修复问题后再执行 make:video。");
      error.preflight = preflight;
      throw error;
    }

    const media = await executeProductionWorkspace({
      root,
      provider: "command",
      command,
      commandArgs: httpCommandArgs,
      all: true,
      continueOnError,
      retryFailed: Boolean(options.retryFailed),
      maxPasses: options.maxPasses || 12,
      capabilities: ["image_generation", "first_last_frame_video_generation"]
    });

    const postprocess = await executeProductionWorkspace({
      root,
      provider: "command",
      command,
      commandArgs: postprocessCommandArgs,
      all: true,
      continueOnError,
      retryFailed: Boolean(options.retryFailed),
      maxPasses: options.maxPasses || 12,
      capabilities: ["video_quality_review", "video_assembly"]
    });

    const report = await loadProductionReport(root);
    return {
      version: "1.0",
      root,
      preflight,
      stages: {
        media: summarizeExecution(media),
        postprocess: summarizeExecution(postprocess)
      },
      report
    };
  } finally {
    if (options.ffmpeg) {
      if (previousFfmpeg === undefined) delete process.env.LOCAL_POSTPROCESS_FFMPEG;
      else process.env.LOCAL_POSTPROCESS_FFMPEG = previousFfmpeg;
    }
  }
}

export function formatMakeVideoMarkdown(result = {}) {
  const report = result.report || {};
  const finalOutputs = report.finalOutputs || [];
  const lines = [
    `# ${report.title || "视频制作结果"}`,
    "",
    "## 总览",
    "",
    `- 工作区：${result.root || report.outputRoot || ""}`,
    `- 预检：${result.preflight?.passed ? "通过" : "未通过"}`,
    `- 媒体生成执行：${result.stages?.media?.executed || 0} 个任务，失败 ${result.stages?.media?.failed || 0} 个`,
    `- 本地后处理执行：${result.stages?.postprocess?.executed || 0} 个任务，失败 ${result.stages?.postprocess?.failed || 0} 个`,
    `- 总进度：${report.progress?.done || 0}/${report.progress?.total || 0}（${report.progress?.percent || 0}%）`,
    `- 当前状态：ready=${report.progress?.ready || 0} blocked=${report.progress?.blocked || 0} failed=${report.progress?.failed || 0}`,
    "",
    "## 最终成片",
    "",
    ...(finalOutputs.length
      ? finalOutputs.map((item) => `- ${item.taskId}：${item.status} → ${item.outputPath}`)
      : ["- 暂无 final_edit 输出"]),
    "",
    "## 后续建议",
    "",
    ...(report.recommendedCommands?.length ? report.recommendedCommands.map((command) => `- ${command}`) : ["- 当前无需操作"]),
    ""
  ];
  return lines.join("\n");
}

function summarizeExecution(result = {}) {
  return {
    provider: result.provider || "",
    executed: result.executed?.length || 0,
    failed: result.failed?.length || 0,
    skipped: result.skipped?.length || 0,
    retried: result.retried?.length || 0,
    done: result.run?.counts?.done || 0,
    ready: result.run?.counts?.ready || 0,
    blocked: result.run?.counts?.blocked || 0,
    failedCount: result.run?.counts?.failed || 0,
    executedTaskIds: (result.executed || []).map((item) => item.taskId)
  };
}

function trimRoot(root) {
  return String(root || "production").replace(/\/+$/u, "") || "production";
}
