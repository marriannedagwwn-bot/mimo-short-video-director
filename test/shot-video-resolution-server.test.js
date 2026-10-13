import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";

// 真实 HTTP（2026-10-10）：镜头视频任务在建任务之前校验分辨率——不合法就 400、不建任务、不调供应商；
// 合法的值记进任务的模型快照。测试服务器把视频供应商的密钥都清空了，不会产生任何付费调用。
// （批量任务 shotVideoBatch 与可灵已于 2026-10-11 删除，相应用例改为断言它们被明确拒绝。）

const SEEDANCE = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };
const SEEDANCE_FAST = { provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" };

async function tasksOnDisk(runtime) {
  const file = path.join(runtime.root, "state", runtime.run.projectId, runtime.run.runId, "tasks/index.json");
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function post(runtime, body) {
  const response = await fetch(`${runtime.base}/api/tasks/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}

test("镜头视频：分辨率不合法时在建任务之前就 400；合法值与已知默认值记进模型快照", async () => {
  const runtime = await createStoryboardRuntime({ env: { SEEDANCE_VIDEO_RESOLUTION: "", MINIMAX_VIDEO_RESOLUTION: "" } });
  try {
    const { api, wait, run, variant } = runtime;
    const shotInput = (overrides) => ({ ...run, kind: "shotVideo", input: { variantId: variant.id, shotId: "A01", generationMode: "all_reference", ...overrides } });

    const invalid = await post(runtime, shotInput({ modelOverrides: { shotVideo: SEEDANCE_FAST }, resolution: "1080p" }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "SHOT_VIDEO_RESOLUTION_INVALID");
    assert.match(invalid.json.error, /只支持 480p \/ 720p，本次请求为「1080p」/u);
    const wrongCase = await post(runtime, shotInput({ modelOverrides: { shotVideo: SEEDANCE }, resolution: "1080P" }));
    assert.equal(wrongCase.json.code, "SHOT_VIDEO_RESOLUTION_INVALID");
    // 已删除的可灵：在分辨率校验之前就按不支持的供应商拒绝，不改用默认供应商。
    const removedProvider = await post(runtime, shotInput({ modelOverrides: { shotVideo: { provider: "Kling", model: "kling-v2-1" } }, resolution: "720p" }));
    assert.equal(removedProvider.status, 400);
    assert.equal(removedProvider.json.code, "SHOT_VIDEO_CONFIG_INVALID");
    assert.match(removedProvider.json.error, /不支持镜头视频供应商“Kling”：只支持 Seedance 或 MiniMax/u);
    // 批量任务已删除：建任务时就是未知任务类型。
    const batch = await post(runtime, { ...run, kind: "shotVideoBatch", input: { variantId: variant.id, modelOverrides: { shotVideo: SEEDANCE }, resolution: "4k" } });
    assert.equal(batch.status, 400);
    assert.equal(batch.json.code, "TASK_KIND_UNSUPPORTED");
    assert.equal((await tasksOnDisk(runtime)).includes("\"shotVideo"), false, "被拒的请求没有建任何镜头视频任务");

    // 生成一份 4.0 分镜，再建两个合法的镜头视频任务：选了的值、没选时的已知默认值都记进快照。
    const planTask = await wait((await api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
      variantId: variant.id, creatorProfile: runtime.input.creatorProfile, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false
    } })).task);
    assert.equal(planTask.status, "completed", JSON.stringify(planTask.error));
    const entry = (await api("/api/production/run/load", { ...run, includeContent: false })).latestArtifacts[`animationPlan:${variant.id}`];
    const productionContext = { projectId: run.projectId, runId: run.runId, planArtifactId: entry.lineage.artifactId,
      planRevision: entry.lineage.revision, planDigest: entry.lineage.contentDigest, mediaNamespace: entry.lineage.mediaNamespace };
    const explicit = await api("/api/tasks/create", shotInput({ modelOverrides: { shotVideo: SEEDANCE }, resolution: "1080p",
      productionContext, aspectRatio: "16:9", animationPromptSchemaVersion: "4.0", promptOverride: "阿岚抱起小猫。",
      referenceAssets: [{ mediaType: "image", name: "ref.png", dataUrl: "data:image/png;base64,AA==", source: "upload" }] }));
    assert.deepEqual(explicit.task.modelSnapshot.shotVideo, { ...SEEDANCE, resolution: "1080p" });
    const explicitDone = await wait(explicit.task);
    assert.notEqual(explicitDone.status, "completed", "测试服务器没有视频密钥，不会真的生成");
    const fallback = await api("/api/tasks/create", shotInput({ modelOverrides: { shotVideo: { provider: "MiniMax", model: "MiniMax-H3" } },
      productionContext, aspectRatio: "16:9", animationPromptSchemaVersion: "4.0", promptOverride: "阿岚抱起小猫。",
      referenceAssets: [{ mediaType: "image", name: "ref.png", dataUrl: "data:image/png;base64,AA==", source: "upload" }] }));
    assert.deepEqual(fallback.task.modelSnapshot.shotVideo, { provider: "MiniMax", model: "MiniMax-H3", resolution: "2K" }, "没选时记下代码默认值");
    await wait(fallback.task);

    // 页面用的默认值来自 /api/health。
    const health = await (await fetch(`${runtime.base}/api/health`)).json();
    const providers = health.providers || health.result?.providers;
    assert.deepEqual(providers.Seedance.resolutionDefaults["doubao-seedance-2-0-260128"], { value: "720p", source: "code_default", error: "" });
    assert.equal(providers.Kling, undefined, "可灵已删除");
    assert.equal(providers.VideoHTTP, undefined, "自定义 VideoHTTP 已删除");
  } finally {
    await runtime.close();
  }
});

// 明确选一个合法值能盖过配错的默认值，见 test/shot-video-resolutions.test.js 的请求校验用例。
test("服务端配的默认分辨率对不上所选模型：没选就 400，要求明确选择；/api/health 照实报出错误、不替换", async () => {
  const runtime = await createStoryboardRuntime({ env: { SEEDANCE_VIDEO_RESOLUTION: "1080p" } });
  try {
    const { run, variant } = runtime;
    const rejected = await post(runtime, { ...run, kind: "shotVideo", input: { variantId: variant.id, shotId: "A01", modelOverrides: { shotVideo: SEEDANCE_FAST } } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.code, "SHOT_VIDEO_RESOLUTION_DEFAULT_INVALID");
    assert.match(rejected.json.error, /SEEDANCE_VIDEO_RESOLUTION=1080p 不适用于 doubao-seedance-2-0-fast-260128/u);
    const health = await (await fetch(`${runtime.base}/api/health`)).json();
    const providers = health.providers || health.result?.providers;
    assert.match(providers.Seedance.resolutionDefaults["doubao-seedance-2-0-fast-260128"].error, /不适用于/u);
    assert.deepEqual(providers.Seedance.resolutionDefaults["doubao-seedance-2-0-260128"], { value: "1080p", source: "env", error: "" });
  } finally {
    await runtime.close();
  }
});

// 单镜视频请求的字段清单是对象字面量，漏掉分辨率不会有任何运行时错误（会被悄悄丢掉、按默认值生成），
// 只能靠测试守着；与 test/story-duration.test.js 一样用源码断言锁住。
// （原来还锁着批量任务 shotVideoBatch 的两处清单，批量任务已于 2026-10-11 删除。）
test("单镜视频请求把所选分辨率原样带给服务端", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /promptOverride: promptOverride \|\| "",\n\s+\.\.\.shotVideoResolutionRequestFields\(\),/u);
});
