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
      requestPath: defaultRequestPath(outputRoot, job),
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

export function buildProductionWorkspaceFiles(queue = {}, run = buildProductionRun(queue)) {
  const jobsByTaskId = new Map((run.jobs || []).map((job) => [job.taskId, job]));
  const jobsByOutputKey = new Map((run.jobs || []).map((job) => [job.outputKey, job]));
  const files = [
    {
      path: [run.outputRoot, "README.md"].join("/"),
      content: formatWorkspaceReadme(queue, run)
    },
    {
      path: [run.outputRoot, "production-run.json"].join("/"),
      content: `${JSON.stringify(run, null, 2)}\n`
    }
  ];

  for (const [index, queueJob] of (queue.jobs || []).entries()) {
    const taskId = queueJob.taskId || `JOB-${String(index + 1).padStart(3, "0")}`;
    const runJob = jobsByTaskId.get(taskId) || run.jobs?.[index];
    if (!runJob?.promptPath) continue;
    files.push({
      path: runJob.promptPath,
      content: formatJobPromptCard(queueJob, runJob, jobsByOutputKey)
    });
    files.push({
      path: runJob.requestPath,
      content: `${JSON.stringify(formatJobRequest(queueJob, runJob, jobsByOutputKey), null, 2)}\n`
    });
  }

  return files;
}

export function buildArtifactsFromExistingOutputs(queue = {}, options = {}) {
  const outputRoot = cleanPath(options.outputRoot || "production");
  const existing = new Set((options.existingOutputPaths || []).map(normalizeComparablePath));
  const artifacts = {};
  for (const job of queue.jobs || []) {
    const outputKey = job.outputKey || "";
    if (!outputKey) continue;
    const outputPath = defaultOutputPath(outputRoot, job);
    if (existing.has(normalizeComparablePath(outputPath))) {
      artifacts[outputKey] = { status: "done", path: outputPath };
    }
  }
  return artifacts;
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

function formatWorkspaceReadme(queue = {}, run = {}) {
  const typeCounts = countBy(run.jobs || [], "type");
  const nextTasks = run.nextTaskIds?.length ? run.nextTaskIds.join(" / ") : "暂无，等待依赖产物或检查失败任务";
  return [
    `# ${run.title || queue.title || "视频生产工作区"}`,
    "",
    "## 运行状态",
    "",
    `- Run ID：${run.runId || ""}`,
    `- 主题变体：${run.selectedVariantId || ""}`,
    `- 队列版本：${run.queueVersion || queue.version || ""}`,
    `- 供应商模式：${run.providerMode || queue.providerMode || "provider_agnostic"}`,
    `- 任务统计：total=${run.counts?.total || 0} ready=${run.counts?.ready || 0} blocked=${run.counts?.blocked || 0} done=${run.counts?.done || 0} failed=${run.counts?.failed || 0}`,
    `- 当前可执行任务：${nextTasks}`,
    "",
    "## 任务类型",
    "",
    ...Object.entries(typeCounts).map(([type, count]) => `- ${jobTypeLabel(type)}（${type}）：${count}`),
    "",
    "## 目录约定",
    "",
    "- `prompts/`：每个任务一张 Markdown prompt 卡，可直接复制给图像/视频模型或交给 API worker。",
    "- `requests/`：每个任务一份供应商无关 JSON 请求包，包含能力类型、依赖产物路径、输出路径、参数和验收标准。",
    "- `outputs/`：建议产物目录。参考图、资产图、首尾帧、视频片段、质检 JSON 和最终成片按任务类型分开存放。",
    "- `production-run.json`：机器可读运行状态，记录依赖、产物路径和下一批可执行任务。",
    "",
    "## 执行顺序",
    "",
    "1. 先生成 `reference_image` 和 `asset_image`。",
    "2. 参考图/资产图通过后，生成每个镜头的 `start_frame_image` 和 `end_frame_image`。",
    "3. 首尾帧通过后，用 `first_last_frame_video` 任务生成逐镜视频。",
    "4. 每个视频片段通过 `quality_check` 后，执行 `final_edit` 合成最终竖屏短片。",
    "5. 每完成一个产物，重新运行 `npm run plan:video -- --scan-existing` 自动扫描 `outputs/`，或用 `--done` / `--artifact` 手动标记完成项，释放下一批任务。",
    ""
  ].join("\n");
}

function formatJobPromptCard(queueJob = {}, runJob = {}, jobsByOutputKey = new Map()) {
  const dependencyLines = runJob.requiredInputs?.length
    ? runJob.requiredInputs.map((key) => {
      const dependency = jobsByOutputKey.get(key);
      return `- ${key}${dependency?.outputPath ? ` → ${dependency.outputPath}` : ""}${runJob.missingInputs?.includes(key) ? "（缺失）" : ""}`;
    })
    : ["- 无"];
  const detailLines = detailEntries(queueJob).map(([label, value]) => `- ${label}：${formatValue(value)}`);
  const acceptanceLines = runJob.acceptanceCriteria?.length ? runJob.acceptanceCriteria.map((item) => `- ${item}`) : ["- 按任务 prompt 和项目视觉规则验收"];
  return [
    `# ${runJob.taskId} · ${jobTypeLabel(runJob.type)}`,
    "",
    "## 执行信息",
    "",
    `- 状态：${runJob.status}`,
    `- 输入类型：${runJob.inputType}`,
    `- 输出 key：${runJob.outputKey}`,
    `- 建议输出路径：${runJob.outputPath}`,
    "",
    "## 依赖输入",
    "",
    ...dependencyLines,
    "",
    detailLines.length ? "## 镜头 / 制作参数" : "",
    detailLines.length ? "" : "",
    ...detailLines,
    detailLines.length ? "" : "",
    "## 正向 Prompt",
    "",
    queueJob.prompt || "无",
    "",
    "## 负向 Prompt",
    "",
    queueJob.negativePrompt || "无",
    "",
    "## 验收标准",
    "",
    ...acceptanceLines,
    "",
    "## 原始任务 JSON",
    "",
    "```json",
    JSON.stringify(queueJob, null, 2),
    "```",
    ""
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "" && lines[index + 1] === "")).join("\n");
}

function formatJobRequest(queueJob = {}, runJob = {}, jobsByOutputKey = new Map()) {
  return {
    version: "1.0",
    providerMode: "provider_agnostic",
    taskId: runJob.taskId,
    type: runJob.type,
    capability: capabilityFor(runJob.type, runJob.inputType),
    status: runJob.status,
    inputType: runJob.inputType,
    outputKey: runJob.outputKey,
    outputPath: runJob.outputPath,
    prompt: queueJob.prompt || "",
    negativePrompt: queueJob.negativePrompt || "",
    inputArtifacts: (runJob.requiredInputs || []).map((key) => {
      const dependency = jobsByOutputKey.get(key);
      return {
        outputKey: key,
        path: dependency?.outputPath || "",
        status: dependency?.status || "missing",
        missing: runJob.missingInputs?.includes(key) || false
      };
    }),
    parameters: requestParameters(queueJob, runJob),
    acceptanceCriteria: runJob.acceptanceCriteria || [],
    rawJob: queueJob
  };
}

function capabilityFor(type, inputType) {
  if (type === "reference_image" || type === "asset_image" || type === "start_frame_image" || type === "end_frame_image") return "image_generation";
  if (type === "first_last_frame_video") return "first_last_frame_video_generation";
  if (type === "quality_check") return "video_quality_review";
  if (type === "final_edit") return "video_assembly";
  return inputType || "unknown";
}

function requestParameters(queueJob = {}, runJob = {}) {
  return {
    aspectRatio: queueJob.aspectRatio || "",
    durationSeconds: queueJob.durationSeconds || "",
    shotId: queueJob.shotId || "",
    sourceSceneId: queueJob.sourceSceneId || "",
    cameraMotion: queueJob.cameraMotion || "",
    characterAction: queueJob.characterAction || "",
    dialogueOrSubtitle: queueJob.dialogueOrSubtitle || "",
    soundDesign: queueJob.soundDesign || "",
    continuityNotes: queueJob.continuityNotes || "",
    sequenceRhythm: queueJob.sequenceRhythm || "",
    transitions: queueJob.transitions || [],
    subtitlePlan: queueJob.subtitlePlan || "",
    musicAndSfx: queueJob.musicAndSfx || "",
    hookAndEndingNotes: queueJob.hookAndEndingNotes || "",
    requiredInputCount: runJob.requiredInputs?.length || 0,
    missingInputCount: runJob.missingInputs?.length || 0
  };
}

function detailEntries(job = {}) {
  return [
    ["镜头 ID", job.shotId],
    ["源场景", job.sourceSceneId],
    ["时长", job.durationSeconds ? `${job.durationSeconds} 秒` : ""],
    ["画幅", job.aspectRatio],
    ["剧情功能", job.storyPurpose],
    ["情绪目标", job.emotionalTarget],
    ["镜头运动", job.cameraMotion],
    ["角色动作", job.characterAction],
    ["对白/字幕", job.dialogueOrSubtitle],
    ["声音设计", job.soundDesign],
    ["连续性备注", job.continuityNotes],
    ["剪辑节奏", job.sequenceRhythm],
    ["转场", job.transitions],
    ["字幕方案", job.subtitlePlan],
    ["音乐音效", job.musicAndSfx],
    ["开头结尾", job.hookAndEndingNotes],
    ["一致性标签", job.consistencyTags]
  ].filter(([, value]) => hasValue(value));
}

function jobTypeLabel(type) {
  return ({
    reference_image: "角色参考图",
    asset_image: "关键资产图",
    start_frame_image: "首帧图",
    end_frame_image: "尾帧图",
    first_last_frame_video: "首尾帧视频",
    quality_check: "质检",
    final_edit: "最终剪辑"
  })[type] || type || "未知任务";
}

function countBy(items = [], key) {
  return items.reduce((acc, item) => {
    const value = item?.[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function hasValue(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function formatValue(value) {
  return Array.isArray(value) ? value.join("；") : String(value ?? "");
}

function defaultOutputPath(root, job = {}) {
  const extension = extensionFor(job.type);
  return [root, "outputs", safeSegment(job.type || "unknown"), `${safeSegment(job.taskId || job.outputKey || "job")}${extension}`].join("/");
}

function defaultPromptPath(root, job = {}) {
  return [root, "prompts", safeSegment(job.type || "unknown"), `${safeSegment(job.taskId || job.outputKey || "job")}.md`].join("/");
}

function defaultRequestPath(root, job = {}) {
  return [root, "requests", safeSegment(job.type || "unknown"), `${safeSegment(job.taskId || job.outputKey || "job")}.json`].join("/");
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

function normalizeComparablePath(value) {
  return cleanPath(String(value || "").replace(/\\/gu, "/"));
}

function safeSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "item";
}
