import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";

// 真实 HTTP（2026-10-10）：镜头视频与批量任务在建任务之前校验分辨率——不合法就 400、不建任务、不调供应商；
// 合法的值记进任务的模型快照。测试服务器把三家视频供应商的密钥都清空了，不会产生任何付费调用。

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

test("镜头视频与批量：分辨率不合法时在建任务之前就 400；合法值与已知默认值记进模型快照", async () => {
  const runtime = await createStoryboardRuntime({ env: { SEEDANCE_VIDEO_RESOLUTION: "", MINIMAX_VIDEO_RESOLUTION: "", KLING_VIDEO_RESOLUTION: "" } });
  try {
    const { api, wait, run, variant } = runtime;
    const shotInput = (overrides) => ({ ...run, kind: "shotVideo", input: { variantId: variant.id, shotId: "A01", generationMode: "all_reference", ...overrides } });

    const invalid = await post(runtime, shotInput({ modelOverrides: { shotVideo: SEEDANCE_FAST }, resolution: "1080p" }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "SHOT_VIDEO_RESOLUTION_INVALID");
    assert.match(invalid.json.error, /只支持 480p \/ 720p，本次请求为「1080p」/u);
    const wrongCase = await post(runtime, shotInput({ modelOverrides: { shotVideo: SEEDANCE }, resolution: "1080P" }));
    assert.equal(wrongCase.json.code, "SHOT_VIDEO_RESOLUTION_INVALID");
    const unsupported = await post(runtime, shotInput({ modelOverrides: { shotVideo: { provider: "Kling", model: "kling-v2-1" } }, resolution: "720p" }));
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.json.code, "SHOT_VIDEO_RESOLUTION_UNSUPPORTED");
    // 批量：分辨率在建任务时就查，先于「新版分镜不支持批量」那条拒绝。
    const batch = await post(runtime, { ...run, kind: "shotVideoBatch", input: { variantId: variant.id, modelOverrides: { shotVideo: SEEDANCE }, resolution: "4k" } });
    assert.equal(batch.status, 400);
    assert.equal(batch.json.code, "SHOT_VIDEO_RESOLUTION_INVALID");
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
    assert.deepEqual(providers.Kling.resolutionDefaults["kling-v2-1"], { value: "", source: "unsupported", error: "" });
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

// 批量任务的两处字段清单都是对象字面量，漏掉一处不会有任何运行时错误（分辨率会被悄悄丢掉、按默认值生成），
// 只能靠测试守着；server.js 不导出函数，这里与 test/story-duration.test.js 一样用源码断言锁住。
test("批量任务把分辨率冻结进任务输入，并原样交给每一镜", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(server, /includePreviousShotFrames,\n\s+\/\/ [^\n]*\n\s+\.\.\.\(Object\.hasOwn\(input, "resolution"\) \? \{ resolution: input\.resolution \} : \{\}\),\n\s+modelOverrides: plainObject\(input\.modelOverrides\)/u);
  assert.match(server, /productionContext: trusted\.productionContext,\n\s+\.\.\.\(Object\.hasOwn\(trusted, "resolution"\) \? \{ resolution: trusted\.resolution \} : \{\}\),\n\s+modelOverrides: trusted\.modelOverrides/u);
  assert.match(app, /count: 1,\n\s+\.\.\.shotVideoResolutionRequestFields\(resolution\),\n\s+productionContext\n/u);
  assert.match(app, /promptOverride: promptOverride \|\| "",\n\s+\.\.\.shotVideoResolutionRequestFields\(\),/u);
});
