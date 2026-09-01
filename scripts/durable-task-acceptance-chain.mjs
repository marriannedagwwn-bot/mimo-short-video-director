#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { syncShotCharacterReference } from "../public/character-reference-sync.js";

const options = parseArgs(process.argv.slice(2));
const baseUrl = String(options.baseUrl || "http://127.0.0.1:4173").replace(/\/$/u, "");
const mode = options.mode === "durable" ? "durable" : "legacy";
const resultFile = options.result ? path.resolve(options.result) : "";
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const creatorProfile = Object.freeze({
  fixedCharacter: "验收猫，Q版猫耳少女，白色短发，蓝色眼睛，深蓝学生外套",
  vertical: "治愈日常短故事",
  constraints: "对白克制；禁止字幕水印；固定角色外观不可变化。"
});
const frames = [0, 12, 24, 36].map((timestamp) => ({ timestamp, dataUrl: tinyPng }));
const metadata = Object.freeze({
  name: "durable-task-acceptance.mp4",
  size: 4096,
  type: "video/mp4",
  duration: 44,
  width: 1280,
  height: 720
});
const transcript = "00:00-00:44 验收固定输入；只用于验证 Durable Task，不作为质量样本。";
const sourceVideoDigest = createHash("sha256").update("durable-task-acceptance-source-v1").digest("hex");

const run = await postResult("/api/production/run/start", {
  metadata: { sourceVideo: metadata, sourceVideoDigest, creatorProfile, transcript }
});
const coordinates = { projectId: run.projectId, runId: run.runId };
const shared = { frames, metadata, transcript, creatorProfile, sourceVideoDigest };
const artifacts = {};

if (mode === "durable") {
  const pipeline = await createAndWaitTask("directorPipeline", { ...shared, count: 3 });
  assertCompleted(pipeline, "directorPipeline");
  Object.assign(artifacts, await currentContents());
} else {
  artifacts.referenceAnalysis = await legacyRouteArtifact({
    endpoint: "/api/analyze",
    artifactId: "referenceAnalysis",
    artifactType: "referenceAnalysis",
    input: shared
  });
  artifacts.sourceScriptReconstruction = await legacyRouteArtifact({
    endpoint: "/api/reconstruct",
    artifactId: "sourceScriptReconstruction",
    artifactType: "sourceScriptReconstruction",
    dependencyIds: ["referenceAnalysis"],
    input: { ...shared, referenceAnalysis: artifacts.referenceAnalysis }
  });
  artifacts.creativeBrief = await legacyRouteArtifact({
    endpoint: "/api/brief",
    artifactId: "creativeBrief",
    artifactType: "creativeBrief",
    dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction"],
    input: {
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creatorProfile
    }
  });
  artifacts.visualGuardrails = await legacyRouteArtifact({
    endpoint: "/api/visual-guardrails",
    artifactId: "visualGuardrails",
    artifactType: "visualGuardrails",
    dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"],
    input: {
      ...shared,
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief
    }
  });
  artifacts.themeVariants = await legacyRouteArtifact({
    endpoint: "/api/variants",
    artifactId: "themeVariants",
    artifactType: "themeVariants",
    dependencyIds: ["creativeBrief", "visualGuardrails"],
    input: {
      referenceAnalysis: artifacts.referenceAnalysis,
      sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
      creativeBrief: artifacts.creativeBrief,
      visualGuardrails: artifacts.visualGuardrails,
      creatorProfile,
      count: 3
    }
  });
}

Object.assign(artifacts, await currentContents());
const variant = artifacts.themeVariants?.variants?.[0];
if (!variant?.id) throw new Error("themeVariants 没有可选候选");
const variantId = variant.id;
await directCommit({
  artifactId: `variant:${variantId}`,
  artifactType: "selectedVariant",
  content: variant,
  dependencyIds: ["themeVariants"]
});

const fullStoryInput = {
  referenceAnalysis: artifacts.referenceAnalysis,
  sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
  creativeBrief: artifacts.creativeBrief,
  visualGuardrails: artifacts.visualGuardrails,
  themeVariants: artifacts.themeVariants,
  variant,
  creatorProfile,
  targetDurationSeconds: 60,
  variantId
};
if (mode === "durable") {
  assertCompleted(await createAndWaitTask("fullStory", fullStoryInput), "fullStory");
} else {
  const selected = await currentArtifact(`variant:${variantId}`);
  fullStoryInput.candidateBinding = lineageRef(selected.lineage);
  await legacyRouteArtifact({
    endpoint: "/api/full-story",
    artifactId: `fullStory:${variantId}`,
    artifactType: "fullStory",
    dependencyIds: [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      "themeVariants",
      `variant:${variantId}`
    ],
    input: fullStoryInput
  });
}

Object.assign(artifacts, await currentContents());
const fullStory = artifacts[`fullStory:${variantId}`];
const animationInput = {
  referenceAnalysis: artifacts.referenceAnalysis,
  sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
  creativeBrief: artifacts.creativeBrief,
  visualGuardrails: artifacts.visualGuardrails,
  variant,
  variantId,
  fullStory,
  creatorProfile,
  characterExpressionRules: "验收猫：开心=耳朵朝前，眼睛弯起。",
  animationPlanMode: "direct_shot",
  targetAspectRatio: "16:9",
  backgroundMusicEnabled: false,
  videoPromptTarget: { provider: "Seedance", model: "doubao-seedance-2-0-260128" },
  includeCompilerMetadata: true
};
if (mode === "durable") {
  assertCompleted(await createAndWaitTask("animationPlan", animationInput), "animationPlan");
} else {
  await legacyRouteArtifact({
    endpoint: "/api/animation-plan",
    artifactId: `animationPlan:${variantId}`,
    artifactType: "animationPlan",
    dependencyIds: [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      `variant:${variantId}`,
      `fullStory:${variantId}`
    ],
    createMediaNamespace: true,
    input: animationInput,
    contentForArtifact: (value) => value?.animationPlan || value
  });
}

let planEntry = await currentArtifact(`animationPlan:${variantId}`);
let plan = planEntry.content;
const roleIndex = 0;
const characterReference = plan.characterReferencePrompts?.[roleIndex];
if (!characterReference) throw new Error("Animation Plan 缺少角色参考项");
const { referenceImageDataUrl: _oldReference, ...safeCharacterReference } = characterReference;
const refineInput = {
  imageName: "acceptance-character.png",
  imageDataUrl: tinyPng,
  characterReference: safeCharacterReference,
  creatorProfile,
  referenceAnalysis: artifacts.referenceAnalysis,
  sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
  creativeBrief: artifacts.creativeBrief,
  visualGuardrails: artifacts.visualGuardrails,
  selectedVariant: variant,
  selectedVariantId: variantId,
  variantId,
  roleIndex,
  fullStory,
  animationPlan: {
    title: plan.title,
    productionStrategy: plan.productionStrategy,
    visualBible: plan.visualBible
  }
};
if (mode === "durable") {
  assertCompleted(await createAndWaitTask("characterReferenceRefine", refineInput), "characterReferenceRefine");
} else {
  const refined = await postResult("/api/refine-character-reference", refineInput);
  const {
    boundaryWarning: _boundaryWarning,
    boundaryRestoreNotice: _boundaryRestoreNotice,
    referenceImageOverrideNotice: _referenceImageOverrideNotice,
    ...refinedFields
  } = refined || {};
  const updatedPlan = structuredClone(plan);
  const previous = updatedPlan.characterReferencePrompts[roleIndex];
  const updated = {
    ...previous,
    ...refinedFields,
    referenceImageAdded: true,
    referenceImageName: refineInput.imageName,
    referenceImageDataUrl: refineInput.imageDataUrl
  };
  updatedPlan.characterReferencePrompts[roleIndex] = updated;
  syncShotCharacterReference(updatedPlan, previous, updated);
  await directCommit({
    artifactId: `animationPlan:${variantId}`,
    artifactType: "animationPlan",
    content: updatedPlan,
    dependencyRefs: planEntry.lineage.dependencies,
    createMediaNamespace: true
  });
}

planEntry = await currentArtifact(`animationPlan:${variantId}`);
plan = planEntry.content;
const prompt = `${plan.characterReferencePrompts[roleIndex].appearancePrompt}\n验收编辑：只增加这一句。`;
const characterImagesInput = {
  count: 2,
  prompt,
  referenceImageDataUrl: tinyPng,
  referenceImageName: "acceptance-source.png",
  characterReference: stripReferenceImageData(plan.characterReferencePrompts[roleIndex]),
  creatorProfile,
  referenceAnalysis: artifacts.referenceAnalysis,
  sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
  creativeBrief: artifacts.creativeBrief,
  visualGuardrails: artifacts.visualGuardrails,
  selectedVariant: variant,
  selectedVariantId: variantId,
  variantId,
  roleIndex,
  productionContext: productionContext(coordinates, planEntry.lineage)
};
if (mode === "durable") {
  assertCompleted(await createAndWaitTask("characterReferenceImages", characterImagesInput), "characterReferenceImages");
} else {
  const events = await postJsonLines("/api/generate-character-reference-images", characterImagesInput);
  const ready = events.filter((event) => event.type === "image");
  if (!ready.length) {
    throw new Error(`角色图片 Stub 没有返回 ready 图片：${JSON.stringify(events).slice(0, 2000)}`);
  }
  await directCommit({
    artifactId: `characterImages:${variantId}:${roleIndex}`,
    artifactType: "characterImages",
    content: { characterName: characterReference.characterName || "", results: ready },
    dependencyRefs: [lineageRef(planEntry.lineage)]
  });
}

const shot = plan.shotPlan?.[0];
if (!shot?.shotId) throw new Error("Animation Plan 缺少镜头");
const shotVideoInput = {
  creatorProfile,
  referenceAnalysis: artifacts.referenceAnalysis,
  sourceScriptReconstruction: artifacts.sourceScriptReconstruction,
  creativeBrief: artifacts.creativeBrief,
  visualGuardrails: artifacts.visualGuardrails,
  selectedVariantId: variantId,
  variantId,
  shotId: shot.shotId,
  count: 2,
  generationMode: "all_reference",
  continuityReferenceMode: "none",
  aspectRatio: plan.productionStrategy.targetAspectRatio,
  animationPromptSchemaVersion: plan.promptSchemaVersion,
  referenceAssets: [{
    mediaType: "image",
    name: "acceptance-upload.png",
    dataUrl: tinyPng,
    sizeBytes: 68,
    durationSeconds: 0,
    source: "upload"
  }],
  productionContext: productionContext(coordinates, planEntry.lineage),
  videoProvider: "Seedance",
  videoModel: "doubao-seedance-2-0-260128"
};
const shotArtifactId = `shotVideo:${variantId}:${shot.shotId}`;
if (mode === "durable") {
  assertCompleted(await createAndWaitTask("shotVideo", shotVideoInput), "shotVideo");
} else {
  const result = await postResult("/api/generate-shot-video", shotVideoInput);
  const videos = Array.isArray(result.videos) && result.videos.length ? result.videos : [result];
  const selectedIndex = 0;
  await directCommit({
    artifactId: shotArtifactId,
    artifactType: "shotVideo",
    content: {
      status: "ready",
      result: {
        ...result,
        videos,
        selectedIndex,
        outputUrl: videos[selectedIndex]?.outputUrl || result.outputUrl || ""
      },
      selectedIndex
    },
    dependencyRefs: [lineageRef(planEntry.lineage)]
  });
}

const initialVideo = await currentArtifact(shotArtifactId);
const switched = structuredClone(initialVideo.content);
if (!Array.isArray(switched.result?.videos) || switched.result.videos.length < 2) {
  throw new Error("镜头视频没有两个候选，无法执行候选切换基线");
}
switched.status = "ready";
switched.selectedIndex = 1;
switched.result.selectedIndex = 1;
switched.result.outputUrl = switched.result.videos[1].outputUrl || switched.result.videos[1].url || "";
switched.result.outputPath = switched.result.videos[1].outputPath || "";
await directCommit({
  artifactId: shotArtifactId,
  artifactType: "shotVideo",
  content: switched,
  dependencyRefs: initialVideo.lineage.dependencies
});

const finalRun = await loadRun();
const digestTable = (finalRun.artifactHistory || []).map((entry) => ({
  artifactId: entry.lineage.artifactId,
  revision: entry.lineage.revision,
  contentDigest: entry.lineage.contentDigest,
  status: entry.lineage.status,
  dependencies: entry.lineage.dependencies,
  requestId: entry.lineage.requestId || ""
}));
const result = {
  acceptanceFixtureVersion: "1.0",
  mode,
  baseUrl,
  projectId: coordinates.projectId,
  runId: coordinates.runId,
  variantId,
  shotId: shot.shotId,
  digestTable,
  currentDigests: Object.fromEntries(Object.entries(finalRun.latestArtifacts || {}).map(([artifactId, entry]) => [artifactId, {
    revision: entry.lineage.revision,
    contentDigest: entry.lineage.contentDigest,
    status: entry.lineage.status
  }]))
};
if (resultFile) {
  await fs.mkdir(path.dirname(resultFile), { recursive: true });
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(result, null, 2));

async function legacyRouteArtifact({
  endpoint,
  artifactId,
  artifactType,
  dependencyIds = [],
  input,
  createMediaNamespace = false,
  contentForArtifact = (value) => value
}) {
  const current = await loadRun();
  const expected = current.latestArtifacts?.[artifactId]?.lineage?.revision || null;
  const requestId = `acceptance-${randomUUID()}`;
  const token = { ...coordinates, artifactId, requestId, expectedCurrentRevision: expected };
  await postResult("/api/production/stage/update", {
    ...token,
    stageId: artifactId,
    status: "running"
  });
  const content = contentForArtifact(await postResult(endpoint, input, productionHeaders(token)));
  const dependencies = dependencyIds.map((id) => lineageRef(current.latestArtifacts[id].lineage));
  await postResult("/api/production/artifact/commit", {
    ...token,
    artifactType,
    content,
    dependencies,
    createMediaNamespace
  });
  return content;
}

async function directCommit({
  artifactId,
  artifactType,
  content,
  dependencyIds = [],
  dependencyRefs = null,
  createMediaNamespace = false
}) {
  const current = await loadRun();
  const dependencies = dependencyRefs || dependencyIds.map((id) => lineageRef(current.latestArtifacts[id].lineage));
  return postResult("/api/production/artifact/commit", {
    ...coordinates,
    artifactId,
    artifactType,
    requestId: `acceptance-${randomUUID()}`,
    expectedCurrentRevision: current.latestArtifacts?.[artifactId]?.lineage?.revision || null,
    content,
    dependencies,
    createMediaNamespace
  });
}

async function createAndWaitTask(kind, input) {
  const created = await postResult("/api/tasks/create", { ...coordinates, kind, input }, {}, { expectedStatus: 202 });
  let task = created.task;
  const deadline = Date.now() + 120_000;
  while (["queued", "running"].includes(task.status)) {
    if (Date.now() > deadline) throw new Error(`${kind} Task 等待超时`);
    await delay(100);
    task = await getResult(`/api/tasks/${encodeURIComponent(task.taskId)}?projectId=${encodeURIComponent(coordinates.projectId)}&runId=${encodeURIComponent(coordinates.runId)}`);
  }
  return task;
}

async function currentArtifact(artifactId) {
  const current = await loadRun();
  const entry = current.latestArtifacts?.[artifactId];
  if (!entry?.lineage || entry.lineage.status !== "current") throw new Error(`缺少 current Artifact：${artifactId}`);
  return entry;
}

async function currentContents() {
  const current = await loadRun();
  return Object.fromEntries(Object.entries(current.latestArtifacts || {})
    .filter(([, entry]) => entry?.lineage?.status === "current")
    .map(([artifactId, entry]) => [artifactId, entry.content]));
}

function loadRun() {
  return postResult("/api/production/run/load", { ...coordinates, includeContent: true });
}

async function postResult(route, body, headers = {}, { expectedStatus = 200 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus || !payload.ok) {
    throw apiError(route, response.status, payload);
  }
  return payload.result;
}

async function getResult(route) {
  const response = await fetch(`${baseUrl}${route}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw apiError(route, response.status, payload);
  return payload.result;
}

async function postJsonLines(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw apiError(route, response.status, payload);
  }
  const text = await response.text();
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => line.startsWith("data:"))) {
    return lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));
  }
  return lines.map((line) => JSON.parse(line));
}

function productionHeaders(token) {
  return {
    "x-mimo-project-id": token.projectId,
    "x-mimo-run-id": token.runId,
    "x-mimo-artifact-id": token.artifactId,
    "x-mimo-production-request-id": token.requestId,
    ...(token.expectedCurrentRevision ? { "x-mimo-expected-current-revision": token.expectedCurrentRevision } : {})
  };
}

function productionContext(ids, lineage) {
  return {
    projectId: ids.projectId,
    runId: ids.runId,
    planArtifactId: lineage.artifactId,
    planRevision: lineage.revision,
    planDigest: lineage.contentDigest,
    mediaNamespace: lineage.mediaNamespace
  };
}

function lineageRef(lineage) {
  return {
    artifactId: lineage.artifactId,
    revision: lineage.revision,
    contentDigest: lineage.contentDigest
  };
}

function stripReferenceImageData(value = {}) {
  const copy = structuredClone(value);
  delete copy.referenceImageDataUrl;
  return copy;
}

function assertCompleted(task, label) {
  if (task.status !== "completed") {
    throw new Error(`${label} Task 以 ${task.status} 结束：${task.error?.code || ""} ${task.error?.message || ""}`);
  }
}

function apiError(route, status, payload) {
  const error = new Error(`${route} (${status}) ${payload.error || payload.message || "请求失败"}`);
  error.status = status;
  error.payload = payload;
  return error;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const camel = key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    result[camel] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
