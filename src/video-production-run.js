export function parseQueueJsonl(text = "") {
  const jobs = String(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`JSONL 第 ${index + 1} 行解析失败：${error.message}`);
      }
    });
  return { version: "jsonl", providerMode: "provider_agnostic", jobs };
}

export function buildProductionRun(queue = {}, options = {}) {
  const artifacts = normalizeArtifacts(options.artifacts, options.completedOutputs);
  const outputRoot = cleanPath(options.outputRoot || "production");
  const jobs = (queue.jobs || []).map((job, index) => {
    const artifact = artifacts[job.outputKey] || {};
    const requiredInputs = Array.isArray(job.requiredInputs) ? job.requiredInputs : [];
    const missingInputs = requiredInputs.filter((key) => !isDone(artifacts[key]));
    const status = resolveJobStatus(artifact, missingInputs);
    const outputPath = artifact.path || defaultOutputPath(outputRoot, job);
    return {
      order: index + 1,
      taskId: job.taskId || `JOB-${String(index + 1).padStart(3, "0")}`,
      type: job.type || "unknown",
      inputType: job.inputType || "",
      outputKey: job.outputKey || "",
      status,
      requiredInputs,
      missingInputs,
      outputPath,
      promptPath: defaultPromptPath(outputRoot, job),
      acceptanceCriteria: job.acceptanceCriteria || []
    };
  });

  return {
    version: "1.0",
    runId: options.runId || createRunId(queue),
    createdAt: options.createdAt || new Date().toISOString(),
    queueVersion: queue.version || "",
    title: queue.title || "视频生产运行状态",
    selectedVariantId: queue.selectedVariantId || "",
    providerMode: queue.providerMode || "provider_agnostic",
    outputRoot,
    counts: countStatuses(jobs),
    nextTaskIds: jobs.filter((job) => job.status === "ready").map((job) => job.taskId),
    jobs
  };
}

function normalizeArtifacts(artifacts = {}, completedOutputs = []) {
  const normalized = {};
  if (Array.isArray(artifacts)) {
    for (const item of artifacts) {
      if (item?.outputKey) normalized[item.outputKey] = normalizeArtifactValue(item);
    }
  } else {
    for (const [outputKey, value] of Object.entries(artifacts || {})) {
      normalized[outputKey] = normalizeArtifactValue(value);
    }
  }
  for (const outputKey of completedOutputs || []) {
    normalized[outputKey] = { ...(normalized[outputKey] || {}), status: "done" };
  }
  return normalized;
}

function normalizeArtifactValue(value) {
  if (typeof value === "string") return { status: "done", path: value };
  return {
    status: ["done", "failed", "ready", "blocked"].includes(value?.status) ? value.status : "done",
    path: value?.path || ""
  };
}

function resolveJobStatus(artifact, missingInputs) {
  if (artifact.status === "done") return "done";
  if (artifact.status === "failed") return "failed";
  if (missingInputs.length) return "blocked";
  return "ready";
}

function isDone(artifact) {
  return artifact?.status === "done";
}

function countStatuses(jobs = []) {
  const counts = { total: jobs.length, ready: 0, blocked: 0, done: 0, failed: 0 };
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  return counts;
}

function defaultOutputPath(root, job = {}) {
  const extension = extensionFor(job.type);
  return [root, "outputs", safeSegment(job.type || "unknown"), `${safeSegment(job.taskId || job.outputKey || "job")}${extension}`].join("/");
}

function defaultPromptPath(root, job = {}) {
  return [root, "prompts", safeSegment(job.type || "unknown"), `${safeSegment(job.taskId || job.outputKey || "job")}.md`].join("/");
}

function extensionFor(type) {
  if (type === "quality_check") return ".json";
  if (type === "first_last_frame_video" || type === "final_edit") return ".mp4";
  return ".png";
}

function createRunId(queue = {}) {
  const variant = queue.selectedVariantId || "variant";
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `${safeSegment(variant)}-${stamp}`;
}

function cleanPath(value) {
  return String(value || "production").replace(/\/+$/u, "") || "production";
}

function safeSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "item";
}
