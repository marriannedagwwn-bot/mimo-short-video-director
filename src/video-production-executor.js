import fs from "node:fs/promises";
import path from "node:path";
import { buildArtifactsFromExistingOutputs, buildProductionRun, buildProductionWorkspaceFiles } from "./video-production-run.js";

export async function executeProductionWorkspace(options = {}) {
  const root = trimRoot(options.root || "production");
  const provider = options.provider || "mock";
  const all = Boolean(options.all);
  const maxPasses = Math.max(1, Number(options.maxPasses) || 12);
  const limit = Math.max(1, Number(options.limit) || Number.POSITIVE_INFINITY);
  const taskIds = new Set(options.taskIds || []);
  if (provider !== "mock") throw new Error(`暂未接入 ${provider} provider；当前只支持 mock，用于验证生产依赖链。`);

  let loaded = await loadWorkspace(root);
  let queue = loaded.queue;
  let run = await refreshRun(queue, root);
  const executed = [];
  const skipped = [];

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
      const result = await executeMockRequest(request, job);
      executed.push(result);
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
  for (const job of expectedRun.jobs || []) {
    if (await isNonEmptyFile(job.outputPath)) existingOutputPaths.push(job.outputPath);
  }
  const artifacts = buildArtifactsFromExistingOutputs(queue, { outputRoot: root, existingOutputPaths });
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
