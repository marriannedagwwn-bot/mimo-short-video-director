import fs from "node:fs/promises";
import path from "node:path";

export async function loadProductionReport(root) {
  const runPath = path.join(root, "production-run.json");
  const run = JSON.parse(await fs.readFile(runPath, "utf8"));
  const failureReceipts = {};
  for (const job of run.jobs || []) {
    if (job.status !== "failed" || !job.failurePath) continue;
    try {
      failureReceipts[job.taskId] = JSON.parse(await fs.readFile(job.failurePath, "utf8"));
    } catch {
      failureReceipts[job.taskId] = { taskId: job.taskId, error: { message: "失败回执无法读取或不是有效 JSON" } };
    }
  }
  return buildProductionReport(run, { failureReceipts });
}

export function buildProductionReport(run = {}, options = {}) {
  const jobs = run.jobs || [];
  const done = jobs.filter((job) => job.status === "done");
  const ready = jobs.filter((job) => job.status === "ready");
  const blocked = jobs.filter((job) => job.status === "blocked");
  const failed = jobs.filter((job) => job.status === "failed");
  const failureReceipts = options.failureReceipts || {};
  const finalOutputs = jobs
    .filter((job) => job.type === "final_edit")
    .map((job) => ({ taskId: job.taskId, status: job.status, outputPath: job.outputPath }));

  return {
    version: "1.0",
    title: run.title || "视频生产状态报告",
    runId: run.runId || "",
    selectedVariantId: run.selectedVariantId || "",
    outputRoot: run.outputRoot || "",
    progress: {
      total: jobs.length,
      done: done.length,
      ready: ready.length,
      blocked: blocked.length,
      failed: failed.length,
      percent: jobs.length ? Math.round((done.length / jobs.length) * 100) : 0
    },
    byType: summarizeByType(jobs),
    readyTasks: ready.map((job) => summarizeJob(job)),
    failedTasks: failed.map((job) => ({
      ...summarizeJob(job),
      failurePath: job.failurePath,
      error: failureReceipts[job.taskId]?.error || {}
    })),
    blockedTasks: blocked.map((job) => ({
      ...summarizeJob(job),
      missingInputs: job.missingInputs || []
    })),
    finalOutputs,
    recommendedCommands: recommendedCommands(run, { ready, failed, blocked, finalOutputs })
  };
}

export function formatProductionReportMarkdown(report = {}) {
  const lines = [
    `# ${report.title || "视频生产状态报告"}`,
    "",
    "## 总览",
    "",
    `- Run ID：${report.runId || ""}`,
    `- 主题变体：${report.selectedVariantId || ""}`,
    `- 工作区：${report.outputRoot || ""}`,
    `- 进度：${report.progress?.done || 0}/${report.progress?.total || 0}（${report.progress?.percent || 0}%）`,
    `- 状态：ready=${report.progress?.ready || 0} blocked=${report.progress?.blocked || 0} failed=${report.progress?.failed || 0}`,
    "",
    "## 按任务类型",
    "",
    ...Object.entries(report.byType || {}).map(([type, counts]) => `- ${type}：total=${counts.total} done=${counts.done || 0} ready=${counts.ready || 0} blocked=${counts.blocked || 0} failed=${counts.failed || 0}`),
    "",
    "## 下一批 ready 任务",
    "",
    ...(report.readyTasks?.length ? report.readyTasks.map((job) => `- ${job.taskId}（${job.type}）→ ${job.outputPath}`) : ["- 无"]),
    "",
    "## 失败任务",
    "",
    ...(report.failedTasks?.length
      ? report.failedTasks.map((job) => `- ${job.taskId}（${job.type}）：${job.error?.message || "未知错误"}；回执 ${job.failurePath}`)
      : ["- 无"]),
    "",
    "## 阻塞任务",
    "",
    ...(report.blockedTasks?.length
      ? report.blockedTasks.slice(0, 20).map((job) => `- ${job.taskId}（${job.type}）缺少：${(job.missingInputs || []).join(" / ") || "未知依赖"}`)
      : ["- 无"]),
    "",
    "## 最终成片",
    "",
    ...(report.finalOutputs?.length
      ? report.finalOutputs.map((item) => `- ${item.taskId}：${item.status} → ${item.outputPath}`)
      : ["- 暂无 final_edit 任务"]),
    "",
    "## 建议命令",
    "",
    ...(report.recommendedCommands?.length ? report.recommendedCommands.map((item) => `- ${item}`) : ["- 当前无需操作"]),
    ""
  ];
  return lines.join("\n");
}

function summarizeByType(jobs = []) {
  const result = {};
  for (const job of jobs) {
    const bucket = result[job.type] || { total: 0, done: 0, ready: 0, blocked: 0, failed: 0 };
    bucket.total += 1;
    bucket[job.status] = (bucket[job.status] || 0) + 1;
    result[job.type] = bucket;
  }
  return result;
}

function summarizeJob(job = {}) {
  return {
    taskId: job.taskId || "",
    type: job.type || "",
    status: job.status || "",
    outputKey: job.outputKey || "",
    outputPath: job.outputPath || "",
    requestPath: job.requestPath || "",
    promptPath: job.promptPath || ""
  };
}

function recommendedCommands(run = {}, state = {}) {
  const root = run.outputRoot || "./production/V1";
  if (state.failed?.length) {
    return [
      `npm run preflight:video -- ${root} --strict`,
      ...workerCommands(root, state.failed, "--all --retry-failed")
    ];
  }
  if (state.ready?.length) {
    return [
      `npm run preflight:video -- ${root} --strict`,
      ...workerCommands(root, state.ready, "--all")
    ];
  }
  if (state.blocked?.length) {
    return [`npm run plan:video -- ./视频任务队列.jsonl --root ${root} --workspace --scan-existing`];
  }
  return [];
}

function workerCommands(root, jobs = [], suffix = "--all") {
  const commands = [];
  if (jobs.some((job) => ["reference_image", "asset_image", "start_frame_image", "end_frame_image", "first_last_frame_video"].includes(job.type))) {
    commands.push(`npm run exec:video -- ${root} --provider command --command node --command-arg ./workers/generic-http-worker.mjs ${suffix} --capability image_generation --capability first_last_frame_video_generation`);
  }
  if (jobs.some((job) => ["quality_check", "final_edit"].includes(job.type))) {
    commands.push(`npm run exec:video -- ${root} --provider command --command node --command-arg ./workers/local-postprocess-worker.mjs ${suffix} --capability video_quality_review --capability video_assembly`);
  }
  return commands;
}
