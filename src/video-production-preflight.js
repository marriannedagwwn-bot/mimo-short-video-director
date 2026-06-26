import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkspace } from "./video-production-executor.js";

export async function loadProductionPreflight(root, options = {}) {
  const loaded = await loadWorkspace(root);
  const run = loaded.run;
  const requestsByOutputKey = new Map(loaded.requests.map((request) => [request.outputKey, request]));
  const artifacts = [];
  for (const job of run.jobs || []) {
    artifacts.push(await inspectArtifact(job, requestsByOutputKey.get(job.outputKey)));
  }
  const artifactsByOutputKey = new Map(artifacts.map((artifact) => [artifact.outputKey, artifact]));
  const commandArgs = options.commandArgs || [];
  const configPath = options.configPath || parseConfigPath(commandArgs) || process.env.VIDEO_HTTP_CONFIG || "";
  const config = await loadOptionalConfig(configPath);
  const command = {
    provider: options.provider || "command",
    worker: workerName(options.command, commandArgs),
    command: options.command || "",
    commandArgs,
    configPath,
    configLoaded: Boolean(config.loaded),
    configError: config.error || ""
  };
  const issues = [
    ...mockArtifactIssues(artifacts, artifactsByOutputKey, run),
    ...genericHttpConfigIssues(run, loaded.requestsByTaskId, command, config.data || {})
  ];
  const readyJobs = run.jobs || [];
  const readyTasks = readyJobs
    .filter((job) => job.status === "ready")
    .map((job) => summarizeJob(job, loaded.requestsByTaskId.get(job.taskId)));
  return {
    version: "1.0",
    root,
    runId: run.runId || "",
    title: run.title || "",
    selectedVariantId: run.selectedVariantId || "",
    progress: run.counts || {},
    command,
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    readyTasks,
    artifacts,
    recommendedCommands: recommendedCommands(root, issues, command, readyTasks)
  };
}

export function formatProductionPreflightMarkdown(report = {}) {
  const issues = report.issues || [];
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const lines = [
    `# ${report.title || "视频生产预检"}`,
    "",
    "## 结论",
    "",
    `- 状态：${report.passed ? "通过" : "未通过"}`,
    `- 错误：${errorCount}`,
    `- 警告：${warningCount}`,
    `- 工作区：${report.root || ""}`,
    `- Run ID：${report.runId || ""}`,
    `- 进度：ready=${report.progress?.ready || 0} blocked=${report.progress?.blocked || 0} done=${report.progress?.done || 0} failed=${report.progress?.failed || 0}`,
    "",
    "## Worker 配置",
    "",
    `- Worker：${report.command?.worker || "未知"}`,
    `- Config：${report.command?.configPath || "未指定"}`,
    `- Config 已读取：${report.command?.configLoaded ? "是" : "否"}`,
    ...(report.command?.configError ? [`- Config 错误：${report.command.configError}`] : []),
    "",
    "## 问题",
    "",
    ...(issues.length
      ? issues.map((issue) => `- [${issue.severity}] ${issue.code}${issue.taskId ? ` / ${issue.taskId}` : ""}：${issue.message}${issue.suggestion ? `；建议：${issue.suggestion}` : ""}`)
      : ["- 未发现阻塞真实执行的问题"]),
    "",
    "## Ready 任务",
    "",
    ...(report.readyTasks?.length
      ? report.readyTasks.map((job) => `- ${job.taskId}（${job.type} / ${job.capability || ""}）→ ${job.outputPath}`)
      : ["- 无"]),
    "",
    "## 建议命令",
    "",
    ...(report.recommendedCommands?.length ? report.recommendedCommands.map((command) => `- ${command}`) : ["- 当前无需操作"]),
    ""
  ].join("\n");
  return `${lines}\n`;
}

async function inspectArtifact(job = {}, request = {}) {
  const outputStat = await fileStat(job.outputPath);
  const providerReceiptPath = `${job.outputPath}.provider.json`;
  const mockReceiptPath = `${job.outputPath}.mock.json`;
  const providerReceipt = await readJsonIfExists(providerReceiptPath);
  const mockReceipt = await readJsonIfExists(mockReceiptPath);
  const sample = outputStat.exists ? await readFilePrefix(job.outputPath) : "";
  const receiptProvider = providerReceipt.data?.provider || mockReceipt.data?.provider || "";
  const mockLike = receiptProvider === "mock"
    || receiptProvider === "command-worker-template"
    || /^\s*MOCK ARTIFACT:/u.test(sample)
    || /^\s*PLACEHOLDER ARTIFACT:/u.test(sample);
  return {
    taskId: job.taskId || "",
    type: job.type || "",
    capability: request.capability || "",
    status: job.status || "",
    outputKey: job.outputKey || "",
    outputPath: job.outputPath || "",
    outputExists: outputStat.exists,
    outputSize: outputStat.size,
    receiptPath: providerReceipt.exists ? providerReceiptPath : mockReceipt.exists ? mockReceiptPath : "",
    receiptProvider,
    mockLike,
    requiredInputs: job.requiredInputs || []
  };
}

function mockArtifactIssues(artifacts = [], artifactsByOutputKey = new Map(), run = {}) {
  const issues = [];
  for (const artifact of artifacts) {
    if (artifact.status === "done" && artifact.mockLike) {
      issues.push({
        severity: "error",
        code: "mock_artifact_marked_done",
        taskId: artifact.taskId,
        message: `${artifact.outputPath} 是 mock/占位产物，但当前状态已标记 done，真实执行会跳过该任务。`,
        suggestion: "删除该输出文件和对应 .mock/.provider 回执，或重新生成干净 production workspace。"
      });
    }
  }
  for (const job of run.jobs || []) {
    if (job.status !== "ready") continue;
    for (const outputKey of job.requiredInputs || []) {
      const dependency = artifactsByOutputKey.get(outputKey);
      if (!dependency?.mockLike) continue;
      issues.push({
        severity: "error",
        code: "ready_task_uses_mock_input",
        taskId: job.taskId,
        message: `ready 任务依赖 mock/占位输入 ${outputKey}（${dependency.outputPath}）。`,
        suggestion: "先用真实图像模型重做该依赖，再执行视频生成任务。"
      });
    }
  }
  return issues;
}

function genericHttpConfigIssues(run = {}, requestsByTaskId = new Map(), command = {}, config = {}) {
  const issues = [];
  if (command.configError) {
    issues.push({
      severity: "error",
      code: "config_unreadable",
      message: command.configError,
      suggestion: "检查 --command-arg=--config 后面的 JSON 文件路径和内容。"
    });
  }
  if (!command.worker.includes("generic-http-worker")) return issues;
  const ready = (run.jobs || []).filter((job) => job.status === "ready");
  const httpCapabilities = new Set(["image_generation", "first_last_frame_video_generation"]);
  const capabilities = [...new Set(ready.map((job) => requestsByTaskId.get(job.taskId)?.capability).filter((capability) => httpCapabilities.has(capability)))];
  for (const capability of capabilities) {
    if (!endpointFor(capability, config)) {
      issues.push({
        severity: "error",
        code: "missing_http_endpoint",
        message: `缺少 ${capability} 的 HTTP endpoint。`,
        suggestion: endpointSuggestion(capability)
      });
    }
  }
  if (capabilities.length && !hasApiKey(config)) {
    issues.push({
      severity: "warning",
      code: "missing_api_key",
      message: "未检测到 VIDEO_HTTP_API_KEY 或 config.apiKey。",
      suggestion: "如果供应商需要鉴权，请先配置 API key；如果使用内网免鉴权服务，可忽略。"
    });
  }
  return issues;
}

function endpointFor(capability, config = {}) {
  const endpoints = config.endpoints || {};
  if (endpoints[capability]) return endpoints[capability];
  if (capability === "image_generation") return config.imageEndpoint || process.env.VIDEO_HTTP_IMAGE_ENDPOINT || config.endpoint || process.env.VIDEO_HTTP_ENDPOINT || "";
  if (capability === "first_last_frame_video_generation") return config.videoEndpoint || process.env.VIDEO_HTTP_VIDEO_ENDPOINT || config.endpoint || process.env.VIDEO_HTTP_ENDPOINT || "";
  if (capability === "video_quality_review") return config.reviewEndpoint || process.env.VIDEO_HTTP_REVIEW_ENDPOINT || config.endpoint || process.env.VIDEO_HTTP_ENDPOINT || "";
  if (capability === "video_assembly") return config.assemblyEndpoint || process.env.VIDEO_HTTP_ASSEMBLY_ENDPOINT || config.endpoint || process.env.VIDEO_HTTP_ENDPOINT || "";
  return config.endpoint || process.env.VIDEO_HTTP_ENDPOINT || "";
}

function endpointSuggestion(capability) {
  if (capability === "image_generation") return "设置 VIDEO_HTTP_IMAGE_ENDPOINT，或在 config.endpoints.image_generation 中填写图像生成接口。";
  if (capability === "first_last_frame_video_generation") return "设置 VIDEO_HTTP_VIDEO_ENDPOINT，或在 config.endpoints.first_last_frame_video_generation 中填写首尾帧视频接口。";
  if (capability === "video_quality_review") return "设置 VIDEO_HTTP_REVIEW_ENDPOINT，或在 config.endpoints.video_quality_review 中填写质检接口。";
  if (capability === "video_assembly") return "设置 VIDEO_HTTP_ASSEMBLY_ENDPOINT，或在 config.endpoints.video_assembly 中填写剪辑接口。";
  return "设置 VIDEO_HTTP_ENDPOINT 或 config.endpoint。";
}

function hasApiKey(config = {}) {
  return Boolean(config.apiKey || process.env.VIDEO_HTTP_API_KEY);
}

function recommendedCommands(root, issues = [], command = {}, readyTasks = []) {
  const commands = [];
  if (issues.some((issue) => issue.code === "mock_artifact_marked_done" || issue.code === "ready_task_uses_mock_input")) {
    commands.push(`# 清理 mock/占位产物后重新扫描：npm run plan:video -- ./视频任务队列.jsonl --root ${root} --workspace --scan-existing`);
  }
  if (issues.some((issue) => issue.code === "missing_http_endpoint")) {
    commands.push("# 配置 VIDEO_HTTP_IMAGE_ENDPOINT / VIDEO_HTTP_VIDEO_ENDPOINT 或 provider config 后重新预检");
  }
  if (!issues.some((issue) => issue.severity === "error")) {
    const configArgs = command.configPath ? ` --command-arg=--config --command-arg=${command.configPath}` : "";
    const makeConfigArg = command.configPath ? ` --config ${command.configPath}` : " --config ./provider.json";
    if (readyTasks.length) {
      commands.push(`npm run make:video -- ${root}${makeConfigArg}`);
    }
    if (readyTasks.some((task) => ["image_generation", "first_last_frame_video_generation"].includes(task.capability))) {
      commands.push(`npm run exec:video -- ${root} --provider command --command node --command-arg ./workers/generic-http-worker.mjs${configArgs} --all --capability image_generation --capability first_last_frame_video_generation`);
    }
    if (readyTasks.some((task) => ["video_quality_review", "video_assembly"].includes(task.capability))) {
      commands.push(`npm run exec:video -- ${root} --provider command --command node --command-arg ./workers/local-postprocess-worker.mjs --all --capability video_quality_review --capability video_assembly`);
    }
  }
  return commands;
}

function summarizeJob(job = {}, request = {}) {
  return {
    taskId: job.taskId || "",
    type: job.type || "",
    capability: request.capability || "",
    outputKey: job.outputKey || "",
    outputPath: job.outputPath || ""
  };
}

function parseConfigPath(commandArgs = []) {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--config") return commandArgs[index + 1] || "";
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return "";
}

async function loadOptionalConfig(configPath) {
  if (!configPath) return { loaded: false, data: {} };
  try {
    return { loaded: true, data: JSON.parse(await fs.readFile(configPath, "utf8")) };
  } catch (error) {
    return { loaded: false, data: {}, error: `${configPath} 无法读取或不是有效 JSON：${error.message}` };
  }
}

function workerName(command = "", commandArgs = []) {
  const joined = [command, ...commandArgs].filter(Boolean).join(" ");
  if (joined.includes("generic-http-worker")) return "generic-http-worker";
  if (joined.includes("command-worker-template")) return "command-worker-template";
  return joined || "unknown";
}

async function readJsonIfExists(filePath) {
  try {
    return { exists: true, data: JSON.parse(await fs.readFile(filePath, "utf8")) };
  } catch {
    return { exists: false, data: null };
  }
}

async function fileStat(filePath) {
  try {
    const stat = await fs.stat(path.resolve(filePath));
    return { exists: stat.isFile(), size: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, size: 0 };
  }
}

async function readFilePrefix(filePath, maxBytes = 256) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}
