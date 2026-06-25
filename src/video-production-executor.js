import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildArtifactsFromExistingOutputs, buildProductionRun, buildProductionWorkspaceFiles } from "./video-production-run.js";

const execFileAsync = promisify(execFile);

export async function executeProductionWorkspace(options = {}) {
  const root = trimRoot(options.root || "production");
  const provider = options.provider || "mock";
  const providerCommand = options.command || process.env.VIDEO_PROVIDER_COMMAND || "";
  const providerCommandArgs = options.commandArgs || [];
  const all = Boolean(options.all);
  const continueOnError = Boolean(options.continueOnError);
  const retryFailed = Boolean(options.retryFailed);
  const maxPasses = Math.max(1, Number(options.maxPasses) || 12);
  const limit = Math.max(1, Number(options.limit) || Number.POSITIVE_INFINITY);
  const taskIds = new Set(options.taskIds || []);
  if (provider !== "mock" && provider !== "command") throw new Error(`暂未接入 ${provider} provider；当前支持 mock 和 command。`);
  if (provider === "command" && !providerCommand) throw new Error("command provider 需要 --command 或 VIDEO_PROVIDER_COMMAND");

  let loaded = await loadWorkspace(root);
  let queue = loaded.queue;
  const retried = retryFailed ? await clearFailureReceipts(queue, root, taskIds) : [];
  let run = await refreshRun(queue, root);
  if (retryFailed) {
    await writeWorkspaceFiles(queue, run);
    loaded = await loadWorkspace(root);
  }
  const executed = [];
  const skipped = [];
  const failed = [];

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const readyJobs = run.jobs.filter((job) => {
      if (job.status !== "ready") return false;
      if (taskIds.size && !taskIds.has(job.taskId)) return false;
      return !executed.some((item) => item.taskId === job.taskId);
    }).slice(0, Math.max(0, limit - executed.length));

    if (!readyJobs.length) break;

    for (const job of readyJobs) {
      const request = loaded.requestsByTaskId.get(job.taskId);
      if (!request) {
        skipped.push({ taskId: job.taskId, reason: "request_missing" });
        continue;
      }
      try {
        const result = provider === "command"
          ? await executeCommandRequest(request, job, { root, command: providerCommand, commandArgs: providerCommandArgs })
          : await executeMockRequest(request, job);
        executed.push(result);
      } catch (error) {
        const failure = await writeFailureReceipt(request, job, provider, error);
        failed.push(failure);
        await writeWorkspaceFiles(queue, await refreshRun(queue, root));
        if (!continueOnError) {
          const message = `${job.taskId} 执行失败：${error.message}`;
          const wrapped = new Error(message);
          wrapped.cause = error;
          throw wrapped;
        }
      }
    }

    await writeWorkspaceFiles(queue, await refreshRun(queue, root));
    loaded = await loadWorkspace(root);
    run = await refreshRun(queue, root);
    if (!all || executed.length >= limit) break;
  }

  return {
    root,
    provider,
    mode: all ? "all_ready_until_blocked" : "single_pass",
    executed,
    skipped,
    failed,
    retried,
    run: await refreshRun(queue, root)
  };
}

export async function loadWorkspace(root) {
  const cleanRoot = trimRoot(root || "production");
  const run = JSON.parse(await fs.readFile(path.join(cleanRoot, "production-run.json"), "utf8"));
  const requests = [];
  for (const job of run.jobs || []) {
    if (!job.requestPath) continue;
    const request = JSON.parse(await fs.readFile(job.requestPath, "utf8"));
    requests.push(request);
  }
  const queue = {
    version: run.queueVersion || "workspace",
    providerMode: run.providerMode || "provider_agnostic",
    selectedVariantId: run.selectedVariantId || "",
    title: run.title || "视频生产工作区",
    jobs: requests.map((request) => request.rawJob).filter(Boolean)
  };
  return {
    run,
    queue,
    requests,
    requestsByTaskId: new Map(requests.map((request) => [request.taskId, request]))
  };
}

async function refreshRun(queue, root) {
  const expectedRun = buildProductionRun(queue, { outputRoot: root });
  const existingOutputPaths = [];
  const existingFailurePaths = [];
  for (const job of expectedRun.jobs || []) {
    if (await isNonEmptyFile(job.outputPath)) existingOutputPaths.push(job.outputPath);
    else if (await isNonEmptyFile(job.failurePath)) existingFailurePaths.push(job.failurePath);
  }
  const artifacts = buildArtifactsFromExistingOutputs(queue, { outputRoot: root, existingOutputPaths, existingFailurePaths });
  return buildProductionRun(queue, { outputRoot: root, artifacts });
}

async function executeMockRequest(request, job) {
  await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
  await fs.writeFile(job.outputPath, mockArtifactBody(request, job));
  const receiptPath = `${job.outputPath}.mock.json`;
  const receipt = {
    provider: "mock",
    taskId: job.taskId,
    capability: request.capability,
    outputKey: job.outputKey,
    outputPath: job.outputPath,
    generatedAt: new Date().toISOString(),
    note: "Mock artifact for pipeline verification only. Replace with a real image/video provider for production output."
  };
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    taskId: job.taskId,
    type: job.type,
    capability: request.capability,
    outputPath: job.outputPath,
    receiptPath
  };
}

async function executeCommandRequest(request, job, options = {}) {
  await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
  const receiptPath = `${job.outputPath}.provider.json`;
  const args = [
    ...(options.commandArgs || []),
    "--request", job.requestPath,
    "--output", job.outputPath,
    "--receipt", receiptPath,
    "--root", options.root
  ];
  const env = {
    ...process.env,
    VIDEO_TASK_REQUEST: job.requestPath,
    VIDEO_TASK_OUTPUT: job.outputPath,
    VIDEO_TASK_RECEIPT: receiptPath,
    VIDEO_TASK_ROOT: options.root,
    VIDEO_TASK_ID: job.taskId,
    VIDEO_TASK_CAPABILITY: request.capability || ""
  };
  const { stdout, stderr } = await execFileAsync(options.command, args, { env, maxBuffer: 10 * 1024 * 1024 });
  if (!await isNonEmptyFile(job.outputPath)) {
    throw new Error(`command provider 没有生成预期产物：${job.outputPath}`);
  }
  if (!await isNonEmptyFile(receiptPath)) {
    await fs.writeFile(receiptPath, `${JSON.stringify({
      provider: "command",
      taskId: job.taskId,
      capability: request.capability,
      outputKey: job.outputKey,
      outputPath: job.outputPath,
      command: options.command,
      stdout: String(stdout || "").slice(0, 4000),
      stderr: String(stderr || "").slice(0, 4000),
      generatedAt: new Date().toISOString()
    }, null, 2)}\n`);
  }
  return {
    taskId: job.taskId,
    type: job.type,
    capability: request.capability,
    outputPath: job.outputPath,
    receiptPath,
    provider: "command"
  };
}

async function writeFailureReceipt(request, job, provider, error) {
  await fs.mkdir(path.dirname(job.failurePath), { recursive: true });
  const receipt = {
    provider,
    taskId: job.taskId,
    capability: request?.capability || "",
    outputKey: job.outputKey,
    outputPath: job.outputPath,
    failurePath: job.failurePath,
    failedAt: new Date().toISOString(),
    error: {
      name: error.name || "Error",
      message: error.message || String(error),
      code: error.code || "",
      stdout: String(error.stdout || "").slice(0, 4000),
      stderr: String(error.stderr || "").slice(0, 4000)
    }
  };
  await fs.writeFile(job.failurePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    taskId: job.taskId,
    type: job.type,
    capability: request?.capability || "",
    outputPath: job.outputPath,
    failurePath: job.failurePath,
    provider,
    error: receipt.error
  };
}

async function clearFailureReceipts(queue, root, taskIds = new Set()) {
  const expectedRun = buildProductionRun(queue, { outputRoot: root });
  const cleared = [];
  for (const job of expectedRun.jobs || []) {
    if (taskIds.size && !taskIds.has(job.taskId)) continue;
    if (!await isNonEmptyFile(job.failurePath)) continue;
    await fs.unlink(job.failurePath);
    cleared.push({ taskId: job.taskId, failurePath: job.failurePath });
  }
  return cleared;
}

function mockArtifactBody(request, job) {
  if (request.capability === "video_quality_review") {
    return `${JSON.stringify({
      taskId: job.taskId,
      passed: true,
      mock: true,
      checks: request.acceptanceCriteria || []
    }, null, 2)}\n`;
  }
  return [
    `MOCK ARTIFACT: ${job.taskId}`,
    `type=${job.type}`,
    `capability=${request.capability}`,
    `outputKey=${job.outputKey}`,
    "",
    "This is not a real media file. It exists only to test production dependency flow.",
    "",
    "PROMPT:",
    request.prompt || "",
    "",
    "NEGATIVE PROMPT:",
    request.negativePrompt || ""
  ].join("\n");
}

async function writeWorkspaceFiles(queue, run) {
  const files = buildProductionWorkspaceFiles(queue, run);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.resolve(file.path)), { recursive: true });
    await fs.writeFile(file.path, file.content);
  }
}

async function isNonEmptyFile(filePath) {
  try {
    const stat = await fs.stat(path.resolve(filePath));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function trimRoot(root) {
  return String(root || "production").replace(/\/+$/u, "") || "production";
}
