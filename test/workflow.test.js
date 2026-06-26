import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowService } from "../src/workflow.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { ensureOutputContract } from "../src/validation.js";
import { buildRequestBody, MimoClient, parseModelJson } from "../src/mimo-client.js";
import { animationPlanPrompt, briefPrompt, fullStoryPrompt, variantsPrompt } from "../src/prompts.js";
import { parseRunVideoArgs } from "../src/run-video-command.js";
import { mimeTypeFor, selectSampleTimestamps } from "../src/video-file.js";
import { extractFixedCharacterName } from "../src/validation.js";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { executeProductionWorkspace } from "../src/video-production-executor.js";
import { formatMakeVideoMarkdown, makeProductionVideo } from "../src/video-production-maker.js";
import { buildProductionReport, formatProductionReportMarkdown, loadProductionReport } from "../src/video-production-report.js";
import { formatProductionPreflightMarkdown, loadProductionPreflight } from "../src/video-production-preflight.js";
import { buildArtifactsFromExistingOutputs, buildProductionRun, buildProductionWorkspaceFiles, parseQueueJsonl } from "../src/video-production-run.js";
import { buildVideoGenerationQueue, formatQueueJsonl } from "../public/animation-queue.js";

const frames = Array.from({ length: 8 }, (_, index) => ({
  timestamp: index * 5,
  dataUrl: "data:image/jpeg;base64,AA=="
}));
const execFileAsync = promisify(execFile);
const input = {
  frames,
  metadata: { name: "reference.mp4", duration: 40, width: 1080, height: 1920 },
  transcript: "",
  creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "家电维修", constraints: "60 秒内" },
  count: 3
};

function buildQueueFixture() {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = mockFullStory({ ...input, creativeBrief, variant });
  const animationPlan = mockAnimationPlan({ ...input, creativeBrief, variant, fullStory });
  return buildVideoGenerationQueue({
    exportedAt: "2026-06-25T00:00:00.000Z",
    selectedVariant: variant,
    fullStory,
    animationPlan
  });
}

test("演示模式跑通完整四阶段工作流", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  assert.equal(workflow.mode, "demo");
  assert.ok(result.referenceAnalysis.whyWatchToEnd);
  assert.ok(result.sourceScriptReconstruction.scenes.length >= 4);
  assert.ok(result.creativeBrief.reusableHighValueBeats.length >= 4);
  assert.equal(result.creativeBrief.allowedNarrativeComponents.length, 7);
  assert.equal(result.themeVariants.variants.length, 3);
});

test("creativeBrief 将通用叙事构件列为允许复用而非禁止项", async () => {
  const workflow = new WorkflowService();
  const referenceAnalysis = await workflow.analyze(input);
  const sourceScriptReconstruction = await workflow.reconstruct({ ...input, referenceAnalysis });
  const creativeBrief = await workflow.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
  const allowed = creativeBrief.allowedNarrativeComponents.map((item) => item.component);
  const protectedText = JSON.stringify(creativeBrief.protectedExpressions);
  for (const component of ["送达任务", "旅途结构", "情感媒介", "获得帮助", "被关爱对象", "天气或空间推动情绪", "生活化或仪式化结尾"]) {
    assert.ok(allowed.includes(component));
    assert.equal(protectedText.includes(component), false);
  }
});

test("主题变体同时提供结构保真与表达变换证明", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.run(input);
  for (const variant of result.themeVariants.variants) {
    assert.deepEqual(Object.keys(variant.experienceFidelity), ["positioning", "audience", "emotion", "plotDriver", "highValueBeats"]);
    assert.deepEqual(Object.keys(variant.transformationProof), ["changedCharacters", "changedTask", "changedDetailsAndProps", "changedDialogue", "changedVisualExpression"]);
  }
});

test("选择主题变体后可用 mimo-v2.5-pro 生成完整剧情", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    oneLineHook: "阿岚必须在闭店前修好旧设备。",
    logline: "阿岚在暴雨停电中修复一段旧录音。",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  let captured;
  const workflow = new WorkflowService({
    storyModel: "mimo-v2.5-pro",
    storyMaxCompletionTokens: 12345,
    client: {
      async generateJson(args) {
        captured = args;
        return mockFullStory({ ...input, creativeBrief, variant });
      }
    }
  });
  const result = await workflow.createFullStory({ ...input, creativeBrief, variant });
  assert.equal(captured.model, "mimo-v2.5-pro");
  assert.equal(captured.maxCompletionTokens, 12345);
  assert.equal(result.selectedVariantId, "V1");
  assert.ok(result.sceneScript.length >= 6);
  assert.match(result.characterBible.protagonist.identity, /阿岚/);
});

test("完整剧情后可生成首尾帧动画生产包", async () => {
  const creativeBrief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = mockFullStory({ ...input, creativeBrief, variant });
  let captured;
  const workflow = new WorkflowService({
    animationModel: "mimo-v2.5-pro",
    animationMaxCompletionTokens: 13000,
    client: {
      async generateJson(args) {
        captured = args;
        return mockAnimationPlan({ ...input, creativeBrief, variant, fullStory });
      }
    }
  });
  const result = await workflow.createAnimationPlan({ ...input, creativeBrief, variant, fullStory });
  assert.equal(captured.model, "mimo-v2.5-pro");
  assert.equal(captured.maxCompletionTokens, 13000);
  assert.equal(result.productionStrategy.format, "first_last_frame_video");
  assert.ok(result.shotPlan.length >= 6);
  assert.ok(result.shotPlan[0].startFramePrompt);
  assert.ok(result.shotPlan[0].endFramePrompt);
  assert.ok(result.shotPlan[0].videoPrompt);
});

test("动画生产包可转换为视频生成任务队列", () => {
  const queue = buildQueueFixture();
  assert.equal(queue.providerMode, "provider_agnostic");
  assert.equal(queue.selectedVariantId, "V1");
  assert.ok(queue.jobs.some((job) => job.type === "reference_image"));
  assert.ok(queue.jobs.some((job) => job.type === "start_frame_image"));
  assert.ok(queue.jobs.some((job) => job.type === "end_frame_image"));
  assert.ok(queue.jobs.some((job) => job.type === "first_last_frame_video"));
  assert.ok(queue.jobs.some((job) => job.type === "quality_check"));
  assert.ok(queue.jobs.some((job) => job.type === "final_edit"));
  const videoJob = queue.jobs.find((job) => job.type === "first_last_frame_video");
  assert.deepEqual(videoJob.requiredInputs, [`frames.${videoJob.shotId}.start`, `frames.${videoJob.shotId}.end`]);
  const videoOutputs = queue.jobs.filter((job) => job.type === "first_last_frame_video").map((job) => job.outputKey);
  const reviewOutputs = queue.jobs.filter((job) => job.type === "quality_check").map((job) => job.outputKey);
  const finalEditJob = queue.jobs.find((job) => job.type === "final_edit");
  assert.deepEqual(finalEditJob.requiredInputs, [...videoOutputs, ...reviewOutputs]);
  assert.match(finalEditJob.prompt, /竖屏短片|字幕|音乐音效/);
  const jsonl = formatQueueJsonl(queue);
  assert.equal(jsonl.split("\n").length, queue.jobs.length);
  assert.equal(JSON.parse(jsonl.split("\n")[0]).taskId, queue.jobs[0].taskId);
});

test("视频生产运行状态按任务依赖释放下一步", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { createdAt: "2026-06-25T00:00:00.000Z", outputRoot: "production/V1" });
  assert.equal(initialRun.counts.done, 0);
  assert.ok(initialRun.nextTaskIds.includes("REF-01"));
  assert.ok(initialRun.nextTaskIds.includes("ASSET-01"));
  assert.equal(initialRun.jobs.find((job) => job.type === "start_frame_image").status, "blocked");
  assert.equal(initialRun.jobs.find((job) => job.type === "final_edit").status, "blocked");

  const referenceOutputs = queue.jobs
    .filter((job) => job.type === "reference_image" || job.type === "asset_image")
    .map((job) => job.outputKey);
  const frameRun = buildProductionRun(queue, { completedOutputs: referenceOutputs });
  assert.ok(frameRun.jobs.filter((job) => job.type === "start_frame_image").every((job) => job.status === "ready"));
  assert.ok(frameRun.jobs.filter((job) => job.type === "end_frame_image").every((job) => job.status === "ready"));
  assert.ok(frameRun.jobs.filter((job) => job.type === "first_last_frame_video").every((job) => job.status === "blocked"));

  const videoReadyOutputs = queue.jobs
    .filter((job) => ["reference_image", "asset_image", "start_frame_image", "end_frame_image"].includes(job.type))
    .map((job) => job.outputKey);
  const videoRun = buildProductionRun(queue, { completedOutputs: videoReadyOutputs });
  assert.ok(videoRun.jobs.filter((job) => job.type === "first_last_frame_video").every((job) => job.status === "ready"));

  const videoAndReviewOutputs = queue.jobs
    .filter((job) => job.type === "first_last_frame_video" || job.type === "quality_check")
    .map((job) => job.outputKey);
  const finalRun = buildProductionRun(queue, { completedOutputs: [...videoReadyOutputs, ...videoAndReviewOutputs] });
  assert.equal(finalRun.jobs.find((job) => job.type === "final_edit").status, "ready");

  const parsed = parseQueueJsonl(formatQueueJsonl(queue));
  assert.equal(parsed.jobs.length, queue.jobs.length);
});

test("视频生产运行状态可从已存在输出路径自动识别完成产物", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: "production/V1" });
  const existingOutputPaths = initialRun.jobs
    .filter((job) => job.type === "reference_image" || job.type === "asset_image")
    .map((job) => job.outputPath);
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: "production/V1",
    existingOutputPaths
  });
  assert.equal(Object.keys(artifacts).length, existingOutputPaths.length);
  const scannedRun = buildProductionRun(queue, { outputRoot: "production/V1", artifacts });
  assert.ok(scannedRun.jobs.filter((job) => job.type === "reference_image" || job.type === "asset_image").every((job) => job.status === "done"));
  assert.ok(scannedRun.jobs.filter((job) => job.type === "start_frame_image").every((job) => job.status === "ready"));
});

test("视频生产运行状态可从失败回执识别 failed 任务", () => {
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: "production/V1" });
  const failedJob = initialRun.jobs.find((job) => job.type === "reference_image");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: "production/V1",
    existingFailurePaths: [failedJob.failurePath]
  });
  const scannedRun = buildProductionRun(queue, { outputRoot: "production/V1", artifacts });
  assert.equal(scannedRun.jobs.find((job) => job.taskId === failedJob.taskId).status, "failed");
  assert.ok(scannedRun.jobs.filter((job) => job.type === "start_frame_image").some((job) => job.status === "blocked"));
});

test("视频生产工作区导出 README、运行状态和逐任务 prompt 卡", () => {
  const queue = buildQueueFixture();
  const run = buildProductionRun(queue, {
    createdAt: "2026-06-25T00:00:00.000Z",
    outputRoot: "production/V1"
  });
  const files = buildProductionWorkspaceFiles(queue, run);
  assert.ok(files.some((file) => file.path === "production/V1/README.md" && file.content.includes("执行顺序")));
  assert.ok(files.some((file) => file.path === "production/V1/production-run.json" && file.content.includes('"nextTaskIds"')));
  const promptCards = files.filter((file) => file.path.includes("/prompts/") && file.path.endsWith(".md"));
  const requestFiles = files.filter((file) => file.path.includes("/requests/") && file.path.endsWith(".json"));
  assert.equal(promptCards.length, queue.jobs.length);
  assert.equal(requestFiles.length, queue.jobs.length);
  const videoCard = promptCards.find((file) => file.path.includes("first_last_frame_video"));
  assert.match(videoCard.content, /正向 Prompt/);
  assert.match(videoCard.content, /依赖输入/);
  assert.match(videoCard.content, /验收标准/);
  const videoRequest = JSON.parse(requestFiles.find((file) => file.path.includes("first_last_frame_video")).content);
  assert.equal(videoRequest.capability, "first_last_frame_video_generation");
  assert.equal(videoRequest.inputArtifacts.length, 2);
  assert.ok(videoRequest.inputArtifacts.every((item) => item.path.includes("/outputs/")));
  const finalCard = promptCards.find((file) => file.path.includes("final_edit"));
  assert.match(finalCard.content, /最终剪辑/);
  assert.match(finalCard.content, /quality_check|reviews\./);
  const finalRequest = JSON.parse(requestFiles.find((file) => file.path.includes("final_edit")).content);
  assert.equal(finalRequest.capability, "video_assembly");
  assert.ok(finalRequest.inputArtifacts.some((item) => item.outputKey.startsWith("reviews.")));
});

test("mock 视频生产执行器可按依赖链跑完整个工作区", async () => {
  const queue = buildQueueFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-exec-"));
  const run = buildProductionRun(queue, {
    createdAt: "2026-06-26T00:00:00.000Z",
    outputRoot: root
  });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({ root, provider: "mock", all: true });
  assert.equal(result.executed.length, queue.jobs.length);
  assert.equal(result.run.counts.done, queue.jobs.length);
  assert.equal(result.run.counts.ready, 0);
  assert.equal(result.run.counts.blocked, 0);
  const finalJob = result.run.jobs.find((job) => job.type === "final_edit");
  const finalBody = await fs.readFile(finalJob.outputPath, "utf8");
  assert.match(finalBody, /MOCK ARTIFACT/);
  const finalReceipt = JSON.parse(await fs.readFile(`${finalJob.outputPath}.mock.json`, "utf8"));
  assert.equal(finalReceipt.capability, "video_assembly");
});

test("command 视频生产执行器可调用外部 worker 生成产物", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-"));
  const workerPath = path.join(root, "worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(workerPath, `
import fs from "node:fs/promises";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const requestPath = value("--request");
const outputPath = value("--output");
const receiptPath = value("--receipt");
const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
await fs.writeFile(outputPath, "worker output:" + request.taskId + ":" + process.env.VIDEO_TASK_CAPABILITY);
await fs.writeFile(receiptPath, JSON.stringify({ provider: "command-test", taskId: request.taskId, capability: request.capability }) + "\\n");
`);

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [workerPath],
    all: true
  });
  assert.equal(result.executed.length, 2);
  assert.equal(result.run.counts.done, 2);
  const startJob = result.run.jobs.find((job) => job.taskId === "S01-START");
  assert.match(await fs.readFile(startJob.outputPath, "utf8"), /worker output:S01-START:image_generation/);
  const receipt = JSON.parse(await fs.readFile(`${startJob.outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "command-test");
});

test("内置 command worker 模板可作为 command provider 执行任务", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-template-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "template worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/command-worker-template.mjs"],
    all: true
  });
  assert.equal(result.run.counts.done, 1);
  const output = await fs.readFile(result.run.jobs[0].outputPath, "utf8");
  assert.match(output, /PLACEHOLDER ARTIFACT/);
  const receipt = JSON.parse(await fs.readFile(`${result.run.jobs[0].outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "command-worker-template");
});

test("通用 HTTP worker 可调用供应商接口生成图片产物", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-http-image-"));
  let receivedBody = null;
  let receivedAuth = "";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedAuth = request.headers.authorization || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { b64_json: Buffer.from("http image bytes").toString("base64") } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: { image_generation: `http://127.0.0.1:${address.port}/images` },
    apiKey: "test-key",
    model: "test-image-model"
  }));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "generic http image worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图", negativePrompt: "不要变形" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  assert.equal(result.run.counts.done, 1);
  assert.equal(receivedAuth, "Bearer test-key");
  assert.equal(receivedBody.prompt, "角色参考图");
  assert.equal(receivedBody.negativePrompt, "不要变形");
  assert.equal(receivedBody.model, "test-image-model");
  assert.match(await fs.readFile(result.run.jobs[0].outputPath, "utf8"), /http image bytes/);
  const receipt = JSON.parse(await fs.readFile(`${result.run.jobs[0].outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.provider, "generic-http-worker");
  assert.equal(receipt.resultKind, "base64");
});

test("通用 HTTP worker 支持首尾帧视频提交、轮询和下载", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-http-video-"));
  let postBody = null;
  let pollCount = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/videos") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "provider-task-1", status: "queued" }));
      return;
    }
    if (request.url === "/tasks/provider-task-1") {
      pollCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pollCount < 2
        ? { task_id: "provider-task-1", status: "processing" }
        : { task_id: "provider-task-1", status: "succeeded", video_url: `http://127.0.0.1:${server.address().port}/media/clip.mp4` }));
      return;
    }
    if (request.url === "/media/clip.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "generic http video worker test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], prompt: "让人物从首帧走到尾帧", durationSeconds: 4, aspectRatio: "9:16" }
    ]
  };
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const startJob = initialRun.jobs.find((job) => job.taskId === "S01-START");
  const endJob = initialRun.jobs.find((job) => job.taskId === "S01-END");
  await fs.mkdir(path.dirname(startJob.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(endJob.outputPath), { recursive: true });
  await fs.writeFile(startJob.outputPath, "start frame bytes");
  await fs.writeFile(endJob.outputPath, "end frame bytes");
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [startJob.outputPath, endJob.outputPath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: { first_last_frame_video_generation: `http://127.0.0.1:${address.port}/videos` },
    models: { first_last_frame_video_generation: "test-video-model" },
    pollEndpointTemplate: `http://127.0.0.1:${address.port}/tasks/{taskId}`,
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath],
    all: true
  });
  const videoJob = result.run.jobs.find((job) => job.taskId === "S01-VIDEO");
  assert.equal(result.executed.length, 1);
  assert.equal(videoJob.status, "done");
  assert.equal(postBody.model, "test-video-model");
  assert.equal(postBody.parameters.durationSeconds, 4);
  assert.equal(postBody.inputArtifacts.length, 2);
  assert.match(postBody.inputArtifacts[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(await fs.readFile(videoJob.outputPath, "utf8"), "video bytes");
  const receipt = JSON.parse(await fs.readFile(`${videoJob.outputPath}.provider.json`, "utf8"));
  assert.equal(receipt.providerTaskId, "provider-task-1");
  assert.equal(receipt.resultKind, "url");
});

test("本地后处理 worker 可完成质检并合成最终视频", async () => {
  const savedEnv = pickEnv(["LOCAL_POSTPROCESS_FFMPEG", "LOCAL_POSTPROCESS_REENCODE"]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-local-post-"));
  const fakeFfmpegPath = path.join(root, "fake-ffmpeg.mjs");
  await fs.writeFile(fakeFfmpegPath, `#!/usr/bin/env node
import fs from "node:fs/promises";
const output = process.argv.at(-1);
await fs.writeFile(output, "assembled video bytes");
`);
  await fs.chmod(fakeFfmpegPath, 0o755);
  process.env.LOCAL_POSTPROCESS_FFMPEG = fakeFfmpegPath;
  delete process.env.LOCAL_POSTPROCESS_REENCODE;
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "local postprocess test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", prompt: "视频片段" },
      { taskId: "S01-QA", type: "quality_check", inputType: "video_review", outputKey: "reviews.S01", requiredInputs: ["videos.S01"], prompt: "检查视频" },
      { taskId: "FINAL-EDIT", type: "final_edit", inputType: "video_assembly", outputKey: "exports.final_cut", requiredInputs: ["videos.S01", "reviews.S01"], prompt: "合成最终视频" }
    ]
  };
  try {
    const initialRun = buildProductionRun(queue, { outputRoot: root });
    const videoJob = initialRun.jobs.find((job) => job.taskId === "S01-VIDEO");
    await fs.mkdir(path.dirname(videoJob.outputPath), { recursive: true });
    await fs.writeFile(videoJob.outputPath, "real video bytes");
    const artifacts = buildArtifactsFromExistingOutputs(queue, {
      outputRoot: root,
      existingOutputPaths: [videoJob.outputPath]
    });
    const run = buildProductionRun(queue, { outputRoot: root, artifacts });
    await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

    const result = await executeProductionWorkspace({
      root,
      provider: "command",
      command: process.execPath,
      commandArgs: ["workers/local-postprocess-worker.mjs"],
      all: true,
      capabilities: ["video_quality_review", "video_assembly"]
    });
    assert.equal(result.executed.length, 2);
    assert.equal(result.run.jobs.find((job) => job.taskId === "REF-01").status, "ready");
    assert.equal(result.run.jobs.find((job) => job.taskId === "S01-QA").status, "done");
    const finalJob = result.run.jobs.find((job) => job.taskId === "FINAL-EDIT");
    assert.equal(finalJob.status, "done");
    assert.equal(await fs.readFile(finalJob.outputPath, "utf8"), "assembled video bytes");
    const finalReceipt = JSON.parse(await fs.readFile(`${finalJob.outputPath}.provider.json`, "utf8"));
    assert.equal(finalReceipt.provider, "local-postprocess-worker");
    assert.equal(finalReceipt.inputCount, 1);
  } finally {
    restoreEnv(savedEnv);
  }
});

test("make:video 可编排预检、HTTP 生成、本地质检和最终剪辑", async (t) => {
  const savedEnv = pickEnv(["VIDEO_HTTP_API_KEY", "LOCAL_POSTPROCESS_FFMPEG", "LOCAL_POSTPROCESS_REENCODE"]);
  delete process.env.VIDEO_HTTP_API_KEY;
  delete process.env.LOCAL_POSTPROCESS_REENCODE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-make-"));
  const fakeFfmpegPath = path.join(root, "fake-ffmpeg.mjs");
  await fs.writeFile(fakeFfmpegPath, `#!/usr/bin/env node
import fs from "node:fs/promises";
const output = process.argv.at(-1);
await fs.writeFile(output, "final cut bytes");
`);
  await fs.chmod(fakeFfmpegPath, 0o755);
  process.env.LOCAL_POSTPROCESS_FFMPEG = fakeFfmpegPath;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/images") {
      response.end(JSON.stringify({ data: { b64_json: Buffer.from(`image:${body.taskId}`).toString("base64") } }));
      return;
    }
    if (request.url === "/videos") {
      response.end(JSON.stringify({ data: { videoBase64: Buffer.from(`video:${body.taskId}`).toString("base64") } }));
      return;
    }
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => restoreEnv(savedEnv));
  const address = server.address();
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "make video test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" },
      { taskId: "S01-END", type: "end_frame_image", inputType: "text_to_image", outputKey: "frames.S01.end", requiredInputs: ["references.hero"], prompt: "尾帧" },
      { taskId: "S01-VIDEO", type: "first_last_frame_video", inputType: "image_pair_to_video", outputKey: "videos.S01", requiredInputs: ["frames.S01.start", "frames.S01.end"], prompt: "视频片段" },
      { taskId: "S01-QA", type: "quality_check", inputType: "video_review", outputKey: "reviews.S01", requiredInputs: ["videos.S01"], prompt: "检查视频" },
      { taskId: "FINAL-EDIT", type: "final_edit", inputType: "video_assembly", outputKey: "exports.final_cut", requiredInputs: ["videos.S01", "reviews.S01"], prompt: "合成最终视频" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    endpoints: {
      image_generation: `http://127.0.0.1:${address.port}/images`,
      first_last_frame_video_generation: `http://127.0.0.1:${address.port}/videos`
    },
    apiKey: "test-key"
  }));

  const result = await makeProductionVideo({ root, configPath, command: process.execPath });
  assert.equal(result.preflight.passed, true);
  assert.equal(result.stages.media.executed, 4);
  assert.equal(result.stages.postprocess.executed, 2);
  assert.equal(result.report.progress.done, 6);
  assert.equal(result.report.progress.percent, 100);
  const finalJob = result.report.finalOutputs.find((item) => item.taskId === "FINAL-EDIT");
  assert.equal(finalJob.status, "done");
  assert.equal(await fs.readFile(finalJob.outputPath, "utf8"), "final cut bytes");
  assert.match(formatMakeVideoMarkdown(result), /最终成片/);
});

test("command 视频生产执行失败会写入失败回执并刷新 failed 状态", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-fail-"));
  const workerPath = path.join(root, "failing-worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker failure test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(workerPath, "console.error('provider down'); process.exit(7);");

  const result = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [workerPath],
    all: true,
    continueOnError: true
  });
  assert.equal(result.failed.length, 1);
  assert.equal(result.run.counts.failed, 1);
  assert.equal(result.run.jobs.find((job) => job.taskId === "REF-01").status, "failed");
  assert.equal(result.run.jobs.find((job) => job.taskId === "S01-START").status, "blocked");
  const failure = JSON.parse(await fs.readFile(result.failed[0].failurePath, "utf8"));
  assert.equal(failure.taskId, "REF-01");
  assert.match(failure.error.stderr, /provider down/);
});

test("command 视频生产执行器可重试 failed 任务并释放下游", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-command-retry-"));
  const failingWorkerPath = path.join(root, "failing-worker.mjs");
  const successWorkerPath = path.join(root, "success-worker.mjs");
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "command worker retry test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" },
      { taskId: "S01-START", type: "start_frame_image", inputType: "text_to_image", outputKey: "frames.S01.start", requiredInputs: ["references.hero"], prompt: "首帧" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await fs.writeFile(failingWorkerPath, "console.error('temporary outage'); process.exit(8);");
  await fs.writeFile(successWorkerPath, `
import fs from "node:fs/promises";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const request = JSON.parse(await fs.readFile(value("--request"), "utf8"));
await fs.writeFile(value("--output"), "retry ok:" + request.taskId);
await fs.writeFile(value("--receipt"), JSON.stringify({ provider: "retry-worker", taskId: request.taskId }) + "\\n");
`);

  const failedRun = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [failingWorkerPath],
    all: true,
    continueOnError: true
  });
  assert.equal(failedRun.run.counts.failed, 1);

  const retriedRun = await executeProductionWorkspace({
    root,
    provider: "command",
    command: process.execPath,
    commandArgs: [successWorkerPath],
    all: true,
    retryFailed: true
  });
  assert.equal(retriedRun.retried.length, 1);
  assert.equal(retriedRun.run.counts.done, 2);
  assert.equal(retriedRun.run.counts.failed, 0);
  const startJob = retriedRun.run.jobs.find((job) => job.taskId === "S01-START");
  assert.match(await fs.readFile(startJob.outputPath, "utf8"), /retry ok:S01-START/);
});

test("视频生产报告输出进度、失败、阻塞和建议命令", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-report-"));
  const queue = buildQueueFixture();
  const initialRun = buildProductionRun(queue, { outputRoot: root });
  const readyReference = initialRun.jobs.find((job) => job.type === "reference_image");
  const failedAsset = initialRun.jobs.find((job) => job.type === "asset_image");
  await fs.mkdir(path.dirname(readyReference.outputPath), { recursive: true });
  await fs.writeFile(readyReference.outputPath, "done reference");
  await fs.mkdir(path.dirname(failedAsset.failurePath), { recursive: true });
  await fs.writeFile(failedAsset.failurePath, JSON.stringify({
    taskId: failedAsset.taskId,
    error: { message: "asset provider failed" }
  }));
  const artifacts = buildArtifactsFromExistingOutputs(queue, {
    outputRoot: root,
    existingOutputPaths: [readyReference.outputPath],
    existingFailurePaths: [failedAsset.failurePath]
  });
  const run = buildProductionRun(queue, { outputRoot: root, artifacts });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  const report = await loadProductionReport(root);
  assert.equal(report.progress.done, 1);
  assert.equal(report.progress.failed, 1);
  assert.ok(report.failedTasks.some((task) => task.error.message === "asset provider failed"));
  assert.ok(report.blockedTasks.length > 0);
  assert.match(report.recommendedCommands[1], /--retry-failed/);
  const markdown = formatProductionReportMarkdown(report);
  assert.match(markdown, /失败任务/);
  assert.match(markdown, /asset provider failed/);

  const directReport = buildProductionReport(run);
  assert.equal(directReport.progress.total, run.jobs.length);
  assert.match(report.recommendedCommands[0], /preflight:video/);
});

test("视频生产预检会阻止 mock 产物进入真实执行", async () => {
  const queue = buildQueueFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-mock-"));
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));
  await executeProductionWorkspace({ root, provider: "mock", all: false, limit: 1 });

  const report = await loadProductionPreflight(root, {
    command: process.execPath,
    commandArgs: ["workers/generic-http-worker.mjs"]
  });
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.code === "mock_artifact_marked_done"));
  assert.match(formatProductionPreflightMarkdown(report), /mock\/占位产物/);
});

test("视频生产预检会检查 generic HTTP worker endpoint 配置", async () => {
  const savedEnv = pickEnv(["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_API_KEY"]);
  delete process.env.VIDEO_HTTP_ENDPOINT;
  delete process.env.VIDEO_HTTP_IMAGE_ENDPOINT;
  delete process.env.VIDEO_HTTP_API_KEY;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-config-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "preflight config test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  try {
    const missing = await loadProductionPreflight(root, {
      command: process.execPath,
      commandArgs: ["workers/generic-http-worker.mjs"]
    });
    assert.equal(missing.passed, false);
    assert.ok(missing.issues.some((issue) => issue.code === "missing_http_endpoint" && /image_generation/.test(issue.message)));

    const configPath = path.join(root, "provider.json");
    await fs.writeFile(configPath, JSON.stringify({
      endpoints: { image_generation: "http://127.0.0.1:9/images" },
      apiKey: "test-key"
    }));
    const configured = await loadProductionPreflight(root, {
      command: process.execPath,
      commandArgs: ["workers/generic-http-worker.mjs", "--config", configPath]
    });
    assert.equal(configured.passed, true);
    assert.equal(configured.command.configLoaded, true);
    assert.ok(configured.recommendedCommands.some((command) => command.includes("exec:video")));
  } finally {
    restoreEnv(savedEnv);
  }
});

test("preflight CLI strict 模式在错误时返回非零状态", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-prod-preflight-cli-"));
  const queue = {
    version: "test",
    providerMode: "provider_agnostic",
    title: "preflight cli test",
    selectedVariantId: "V1",
    jobs: [
      { taskId: "REF-01", type: "reference_image", inputType: "text_to_image", outputKey: "references.hero", prompt: "角色参考图" }
    ]
  };
  const run = buildProductionRun(queue, { outputRoot: root });
  await writeTestWorkspace(buildProductionWorkspaceFiles(queue, run));

  await assert.rejects(
    () => execFileAsync(process.execPath, ["bin/preflight-video-production.js", root, "--strict"], {
      cwd: process.cwd(),
      env: withoutEnv(process.env, ["VIDEO_HTTP_ENDPOINT", "VIDEO_HTTP_IMAGE_ENDPOINT", "VIDEO_HTTP_API_KEY"])
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /missing_http_endpoint/);
      return true;
    }
  );
});

test("少于三张画面时拒绝分析", async () => {
  const workflow = new WorkflowService();
  await assert.rejects(() => workflow.analyze({ ...input, frames: frames.slice(0, 2) }), InputError);
});

test("模型 JSON 解析兼容 think 标签和代码块", () => {
  assert.deepEqual(parseModelJson('<think>internal</think>\n```json\n{"ok":true}\n```'), { ok: true });
});

test("原生视频请求将视觉内容放在文本前并把 no_think 放在末尾", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, videoFps: 2, videoMediaResolution: "default", maxCompletionTokens: 8192, thinking: "disabled" },
    { prompt: "分析视频", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }, useVideo: true }
  );
  const content = body.messages[1].content;
  assert.equal(body.model, "mimo-v2.5");
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(content[0].type, "video_url");
  assert.equal(content[0].video_url.url, "data:video/mp4;base64,AAAA");
  assert.equal(content[0].fps, 2);
  assert.equal(content[0].media_resolution, "default");
  assert.equal(content.at(-1).type, "text");
  assert.match(content.at(-1).text, /\/no_think$/);
});

test("完整剧情请求可覆盖为 pro 模型和更长 token 上限", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: false, maxCompletionTokens: 8192, thinking: "disabled" },
    { prompt: "生成完整剧情", frames: [], useVideo: false },
    { model: "mimo-v2.5-pro", maxCompletionTokens: 12288 }
  );
  assert.equal(body.model, "mimo-v2.5-pro");
  assert.equal(body.max_completion_tokens, 12288);
  assert.equal(body.messages[1].content.at(-1).type, "text");
});

test("关键帧请求保持全部图像在文本之前", () => {
  const body = buildRequestBody(
    { model: "mimo-v2.5", jsonMode: true },
    { prompt: "分析画面", frames, useVideo: false }
  );
  const content = body.messages[1].content;
  assert.equal(content.filter((item) => item.type === "image_url").length, frames.length);
  assert.equal(content.at(-1).type, "text");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("auto 模式在服务拒绝 video_url 时回退关键帧", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const content = body.messages[1].content;
    if (content.some((item) => item.type === "video_url")) {
      response.writeHead(415, { "content-type": "application/json" });
      response.end('{"error":"unsupported video"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "mimo-v2.5", jsonMode: false, mediaMode: "auto", videoFps: 2, videoMediaResolution: "default", maxCompletionTokens: 8192, thinking: "disabled"
  });
  const result = await client.generateJsonWithMedia({
    prompt: "分析", frames, video: { dataUrl: "data:video/mp4;base64,AAAA" }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content[0].type, "video_url");
  assert.equal(requests[1].messages[1].content[0].type, "image_url");
});

test("MiMo 健康检查同时验证服务可达和指定模型已加载", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"mimo-v2.5"}]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = new MimoClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "mimo-v2.5"
  });
  assert.deepEqual(await client.checkHealth(), {
    reachable: true,
    modelAvailable: true,
    status: 200,
    modelIds: ["mimo-v2.5"]
  });
});

test("brief 提示词明确区分可复用结构与禁止表达", () => {
  const prompt = briefPrompt({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile: input.creatorProfile });
  assert.match(prompt, /不能因为原片使用过就一刀切禁止/);
  assert.match(prompt, /protectedExpressions 只允许放具体且可识别的表达/);
  assert.match(prompt, /送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾/);
  assert.match(prompt, /企鹅服女孩/);
  assert.match(prompt, /不能把“企鹅”“企鹅快递员”“翅膀\/尾巴动作”等表面元素写进固定角色映射或新故事/);
  assert.match(prompt, /roleAndOccupationMapping 的第一项必须映射原片主角的剧作功能/);
});

test("模型漏掉必要字段时拒绝把结果标记为成功", () => {
  assert.throws(() => ensureOutputContract({ storySynopsis: "只有一个字段" }, "referenceAnalysis"), /缺少必要字段/);
  assert.throws(() => ensureOutputContract({ variants: [] }, "themeVariants"), /至少需要一个主题方案/);
  assert.throws(() => ensureOutputContract({ selectedVariantId: "V1" }, "fullStory"), /缺少必要字段/);
  assert.throws(() => ensureOutputContract({ selectedVariantId: "V1" }, "animationPlan"), /缺少必要字段/);
});

test("creativeBrief 禁止把原片表面形象映射成固定角色身份", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const leakedBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  leakedBrief.roleAndOccupationMapping[0].newRole = "小白子";
  leakedBrief.roleAndOccupationMapping[0].newOccupationOrIdentity = "一只呆萌但尽责的“企鹅快递员”，是村里孩子们都喜欢的可爱帮手。";
  leakedBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });

  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedBrief; } }
  });

  await assert.rejects(
    () => workflow.createBrief({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile }),
    /企鹅/
  );
});

test("creativeBrief 拒绝 protectedExpressions 的错误字段名", () => {
  const brief = mockBrief({ ...input, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  brief.protectedExpressions = [{
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    "safeAlternative Principle": "错误 key，应该是 safeAlternativePrinciple。"
  }];
  assert.throws(() => ensureOutputContract(brief, "creativeBrief"), /safeAlternativePrinciple/);
});

test("主题变体必须锁定用户指定固定角色，不能另起主角名", async () => {
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        return { variants: [{
          id: "V1",
          title: "磁带里的歌声",
          oneLineHook: "小雨送音乐盒给退休老师。",
          logline: "小雨受父母委托，将音乐盒送给独居老人。",
          verticalFit: "温情日常",
          characterSetup: { protagonist: "小雨，小学生", careRecipient: "退休老师", helper: "邻居" },
          newTask: "送音乐盒",
          emotionalMedium: "磁带",
          environmentPressure: "黄昏",
          storyOutline: [{ beat: 1, phase: "任务", action: "小雨接过音乐盒出发", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 }],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "老师请小雨吃红薯",
          transformationProof: { changedCharacters: "", changedTask: "", changedDetailsAndProps: "", changedDialogue: "", changedVisualExpression: "" },
          experienceFidelity: { positioning: "", audience: "", emotion: "", plotDriver: "", highValueBeats: "" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "", mitigation: "" }
        }] };
      }
    }
  });
  await assert.rejects(
    () => workflow.createVariants({
      creativeBrief: {},
      creatorProfile: { fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事", vertical: "温情/日常" },
      count: 1
    }),
    OutputContractError
  );
});

test("主题变体禁止继承 creativeBrief 中已保护的表面形象", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        return { variants: [{
          id: "V1",
          title: "雾中画境",
          oneLineHook: "小白子冒雾送画。",
          logline: "企鹅快递员小白子被委托将画作送到山村女孩手中。",
          verticalFit: "治愈/温情/日常",
          characterSetup: { protagonist: "小白子，一只呆萌但尽责的企鹅快递员", careRecipient: "小月", helper: "老张" },
          newTask: "送画作",
          emotionalMedium: "儿童画",
          environmentPressure: "大雾",
          storyOutline: [{ beat: 1, phase: "任务", action: "小白子翅膀微拍，整理背包出发。", emotion: "期待", dramaticFunction: "建立任务", estimatedSeconds: 6 }],
          highValueBeatMapping: [],
          keyDialogueDirections: [],
          endingRitual: "小白子尾巴轻摇，与小月一起放风筝。",
          transformationProof: { changedCharacters: "", changedTask: "", changedDetailsAndProps: "", changedDialogue: "", changedVisualExpression: "" },
          experienceFidelity: { positioning: "", audience: "", emotion: "", plotDriver: "", highValueBeats: "" },
          originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "", mitigation: "" }
        }] };
      }
    }
  });

  await assert.rejects(
    () => workflow.createVariants({ creativeBrief, creatorProfile, count: 1 }),
    /企鹅|翅膀|尾巴/
  );
});

test("完整剧情禁止继承 creativeBrief 中已保护的表面形象", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const variant = {
    id: "V1",
    title: "雾中画境",
    characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "老张" },
    newTask: "送画作",
    emotionalMedium: "儿童画",
    environmentPressure: "大雾",
    endingRitual: "把儿童画摆正"
  };
  const leakedStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  leakedStory.characterBible.protagonist.identity = "小白子，一只呆萌但尽责的企鹅快递员";
  leakedStory.sceneScript[0].visibleAction = "小白子翅膀微拍，准备出发。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedStory; } },
    storyModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => workflow.createFullStory({ creativeBrief, creatorProfile, variant }),
    /企鹅|翅膀/
  );
});

test("动画生产包正向提示词禁止继承原片表面形象", async () => {
  const creatorProfile = {
    fixedCharacter: "小白子，小女孩，儿童，活泼可爱，懂事，学生/村民，村里的热心帮手",
    vertical: "治愈/温情/日常",
    constraints: "小白子用嗷或嗷呜表达情绪"
  };
  const creativeBrief = mockBrief({ ...input, creatorProfile, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  creativeBrief.protectedExpressions.push({
    expressionType: "视觉元素",
    sourceExpression: "企鹅服",
    prohibition: "禁止出现企鹅形象的服装或直接扮演企鹅。",
    safeAlternativePrinciple: "只保留任务执行者、信使、善意连接者和萌系情感载体的剧作功能。"
  });
  const variant = {
    id: "V1",
    title: "雾中画境",
    characterSetup: { protagonist: "小白子，小女孩", careRecipient: "小月", helper: "老张" },
    newTask: "送画作",
    emotionalMedium: "儿童画",
    environmentPressure: "大雾",
    endingRitual: "把儿童画摆正"
  };
  const fullStory = mockFullStory({ ...input, creatorProfile, creativeBrief, variant });
  const leakedPlan = mockAnimationPlan({ ...input, creatorProfile, creativeBrief, variant, fullStory });
  leakedPlan.shotPlan[0].startFramePrompt = "企鹅快递员小白子站在村口，翅膀微拍，准备送画。";
  leakedPlan.shotPlan[0].negativePrompt = "不要出现企鹅服、翅膀、尾巴。";
  const workflow = new WorkflowService({
    client: { async generateJson() { return leakedPlan; } },
    animationModel: "mimo-v2.5-pro"
  });
  await assert.rejects(
    () => workflow.createAnimationPlan({ creativeBrief, creatorProfile, variant, fullStory }),
    /企鹅|翅膀/
  );
});

test("固定角色名提取支持中文逗号设定，variants 提示词声明不可改名", () => {
  assert.equal(extractFixedCharacterName("小白子，小女孩，儿童，活泼可爱"), "小白子");
  assert.equal(extractFixedCharacterName("阿岚，28 岁社区修理师"), "阿岚");
  const prompt = variantsPrompt({
    creativeBrief: {},
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童，活泼可爱", vertical: "温情/日常", constraints: "可以出现儿童" },
    count: 3
  });
  assert.match(prompt, /固定角色硬约束/);
  assert.match(prompt, /不得改名、换昵称、另起主角名/);
  assert.match(prompt, /小白子/);
});

test("完整剧情提示词要求围绕选中变体并锁定固定角色", () => {
  const prompt = fullStoryPrompt({
    creativeBrief: {},
    referenceAnalysis: {},
    sourceScriptReconstruction: {},
    variant: { id: "V2", title: "雨停之前" },
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童", vertical: "治愈日常", constraints: "只用嗷呜表达" }
  });
  assert.match(prompt, /mimo-v2\.5-pro/);
  assert.match(prompt, /selectedVariantId 必须等于选中主题变体 id：V2/);
  assert.match(prompt, /不能改名/);
  assert.match(prompt, /不得继承原片表面形象/);
  assert.match(prompt, /sceneScript 至少 6 场/);
});

test("动画提示词要求输出首尾帧视频生产包", () => {
  const prompt = animationPlanPrompt({
    creativeBrief: {},
    variant: { id: "V2", title: "雨停之前" },
    fullStory: { selectedVariantId: "V2", title: "雨停之前", sceneScript: [] },
    creatorProfile: { fixedCharacter: "小白子，小女孩，儿童", vertical: "治愈日常", constraints: "只用嗷呜表达" }
  });
  assert.match(prompt, /首尾帧 AI 视频生产包/);
  assert.match(prompt, /startFramePrompt/);
  assert.match(prompt, /endFramePrompt/);
  assert.match(prompt, /videoPrompt/);
  assert.match(prompt, /默认 8–12 个镜头/);
  assert.match(prompt, /正向画面提示词/);
});

test("本地视频命令解析角色、赛道、抽帧和变体数量", () => {
  const options = parseRunVideoArgs([
    "reference.mp4",
    "--character", "阿岚，社区修理师",
    "--vertical=家电维修",
    "--frames", "12",
    "--count", "4",
    "--require-mimo"
  ]);
  assert.equal(options.videoPath, "reference.mp4");
  assert.equal(options.character, "阿岚，社区修理师");
  assert.equal(options.vertical, "家电维修");
  assert.equal(options.frameCount, 12);
  assert.equal(options.count, 4);
  assert.equal(options.requireMimo, true);
});

test("视频工具选择稳定采样时间点并识别常见 MIME 类型", () => {
  assert.deepEqual(selectSampleTimestamps(40, 4), [5, 15, 25, 35]);
  assert.deepEqual(selectSampleTimestamps(0, 3), [0, 3, 6]);
  assert.equal(mimeTypeFor("/tmp/a.mp4"), "video/mp4");
  assert.equal(mimeTypeFor("/tmp/a.mov"), "video/quicktime");
  assert.equal(mimeTypeFor("/tmp/a.unknown"), "application/octet-stream");
});

async function writeTestWorkspace(files) {
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content);
  }
}

function pickEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withoutEnv(env, keys) {
  const copy = { ...env };
  for (const key of keys) delete copy[key];
  return copy;
}
