import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";
import { lineageRef } from "../src/production-lineage.js";
import { ANIMATION_PLAN_VERSION_UNSUPPORTED, legacyAnimationPlanMessage } from "../public/storyboard-plan.js";

// 2026-10-11 起只支持 4.0 自主分镜（真实 HTTP，测试服务器没有任何视频密钥，不会产生付费调用）：
// - 旧 Run 里留下的 2.0 / 3.0 / 无版本 Plan 不能再被单镜提示词、镜头视频读取：一律 409 + ANIMATION_PLAN_VERSION_UNSUPPORTED，
//   提示语就是 legacyAnimationPlanMessage，且不建任务；
// - 镜头视频只剩全能参考：带了首尾帧模式的请求明确失败，不改写成全能参考；
// - 没有显式配置时镜头视频兜底 Seedance（原来兜底可灵）。

// 钉住会影响默认供应商与分辨率的环境变量（设成空串，服务端读 .env 时不会再填）。
const VIDEO_ENV = {
  SHOT_VIDEO_PROVIDER: "",
  SEEDANCE_VIDEO_ENDPOINT: "", SEEDANCE_BASE_URL: "", SEEDANCE_VIDEO_CONFIG: "", SEEDANCE_VIDEO_MODEL: "", SEEDANCE_VIDEO_RESOLUTION: "",
  MINIMAX_VIDEO_ENDPOINT: "", MINIMAX_BASE_URL: "", MINIMAX_VIDEO_CONFIG: "", MINIMAX_VIDEO_MODEL: "", MINIMAX_VIDEO_RESOLUTION: ""
};

async function post(runtime, route, body) {
  const response = await fetch(`${runtime.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}

async function tasksOnDisk(runtime) {
  const file = path.join(runtime.root, "state", runtime.run.projectId, runtime.run.runId, "tasks/index.json");
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function productionContextFor(run, lineage) {
  return {
    projectId: run.projectId,
    runId: run.runId,
    planArtifactId: lineage.artifactId,
    planRevision: lineage.revision,
    planDigest: lineage.contentDigest,
    mediaNamespace: lineage.mediaNamespace
  };
}

test("旧版 Plan 留在 Run 里：单镜提示词、镜头视频任务与同步视频接口一律 409 + 版本错误码，不建任务", async (t) => {
  const runtime = await createStoryboardRuntime({ env: VIDEO_ENV });
  t.after(() => runtime.close());
  const { run, variant, store } = runtime;
  const loaded = await store.loadRun({ ...run, includeContent: true });
  const storyRef = lineageRef(loaded.latestArtifacts[`fullStory:${variant.id}`].lineage);
  const legacyPlans = [
    ["3.0", { selectedVariantId: variant.id, promptSchemaVersion: "3.0", productionStrategy: { targetAspectRatio: "16:9" },
      shotPlan: [{ shotId: "A01", durationSeconds: 5, videoPrompt: "旧 3.0 提示词" }], characterReferencePrompts: [{ characterName: "阿岚" }] }],
    ["2.0", { selectedVariantId: variant.id, promptSchemaVersion: "2.0", productionStrategy: { targetAspectRatio: "16:9" },
      shotPlan: [{ shotId: "A01", durationSeconds: 5, startFrame: {}, endFrame: {} }], characterReferencePrompts: [{ characterName: "阿岚" }] }],
    ["unversioned", { selectedVariantId: variant.id, productionStrategy: { targetAspectRatio: "16:9" },
      shotPlan: [{ shotId: "A01", durationSeconds: 5 }], characterReferencePrompts: [{ characterName: "阿岚" }] }]
  ];
  for (const [version, legacyPlan] of legacyPlans) {
    // 提交口本身拒收旧 Plan，这里绕过它直接写进状态库，模拟升级前留下的旧 Run。
    const committed = await store.commitArtifact({
      ...run, artifactId: `animationPlan:${variant.id}`, artifactType: "animationPlan", content: legacyPlan,
      dependencies: [storyRef], requestId: `legacy-plan-${version}`, createMediaNamespace: true
    });
    const productionContext = productionContextFor(run, committed.lineage);
    const expectLegacyConflict = ({ status, json }, label) => {
      assert.equal(status, 409, `${version} ${label}: ${JSON.stringify(json)}`);
      assert.equal(json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED, `${version} ${label}`);
      assert.equal(json.error, legacyAnimationPlanMessage(version), `${version} ${label}`);
    };
    expectLegacyConflict(await post(runtime, "/api/tasks/create", { ...run, kind: "shotVideoPrompt", input: {
      variantId: variant.id, shotId: "A01", productionContext, videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128"
    } }), "shotVideoPrompt");
    expectLegacyConflict(await post(runtime, "/api/tasks/create", { ...run, kind: "shotVideo", input: {
      variantId: variant.id, shotId: "A01", productionContext, generationMode: "all_reference", promptOverride: "已确认的提示词",
      animationPromptSchemaVersion: legacyPlan.promptSchemaVersion || ""
    } }), "shotVideo");
    // 不走 Durable 任务的同步接口同样拒绝（resolveProductionMediaContext）。
    expectLegacyConflict(await post(runtime, "/api/generate-shot-video", {
      productionContext, selectedVariantId: variant.id, shotId: "A01", generationMode: "all_reference", promptOverride: "已确认的提示词"
    }), "/api/generate-shot-video");
  }
  assert.equal((await tasksOnDisk(runtime)).includes("\"shotVideo"), false, "被拒的请求没有建任何镜头视频或单镜提示词任务");

  // 对照：同一个 Run 换成 4.0 分镜后，同样的单镜提示词请求就能建任务——拦下上面那些的确实是版本。
  const current = await store.commitArtifact({
    ...run, artifactId: `animationPlan:${variant.id}`, artifactType: "animationPlan", content: runtime.plan,
    dependencies: [storyRef], requestId: "storyboard-plan-4", createMediaNamespace: true
  });
  const accepted = await post(runtime, "/api/tasks/create", { ...run, kind: "shotVideoPrompt", input: {
    variantId: variant.id, shotId: runtime.plan.shotPlan[0].shotId, productionContext: productionContextFor(run, current.lineage),
    videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128"
  } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  assert.equal((await runtime.wait(accepted.json.result.task)).status, "completed");
});

test("4.0 分镜的镜头视频：默认兜底 Seedance；带首尾帧模式的任务明确失败，不改写成全能参考", async (t) => {
  const runtime = await createStoryboardRuntime({ env: VIDEO_ENV });
  t.after(() => runtime.close());
  const { api, wait, run, variant } = runtime;

  const health = await (await fetch(`${runtime.base}/api/health`)).json();
  const stages = health.modelStages || health.result?.modelStages;
  assert.equal(stages.shotVideo.provider, "Seedance", "没有任何视频配置时兜底 Seedance");

  const planTask = await wait((await api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
    variantId: variant.id, creatorProfile: runtime.input.creatorProfile, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false
  } })).task);
  assert.equal(planTask.status, "completed", JSON.stringify(planTask.error));
  const loaded = await runtime.store.loadRun({ ...run, includeContent: true });
  const entry = loaded.latestArtifacts[`animationPlan:${variant.id}`];
  // 与页面 globalCharacterBoundaryContext() 发的同一组上游副本：让请求先通过角色边界验签，走到生成器那一步。
  const boundaryContext = {
    creatorProfile: runtime.input.creatorProfile,
    ...Object.fromEntries(["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails"]
      .map((id) => [id, loaded.latestArtifacts[id].content]))
  };
  const shotInput = (overrides) => ({ ...run, kind: "shotVideo", input: {
    ...boundaryContext,
    variantId: variant.id, shotId: "A01", productionContext: productionContextFor(run, entry.lineage), aspectRatio: "16:9",
    animationPromptSchemaVersion: "4.0", promptOverride: "阿岚抱起小猫。",
    referenceAssets: [{ mediaType: "image", name: "ref.png", dataUrl: "data:image/png;base64,AA==", source: "upload" }],
    ...overrides
  } });

  const legacyMode = await api("/api/tasks/create", shotInput({ generationMode: "first_last_frame" }));
  assert.deepEqual(legacyMode.task.modelSnapshot.shotVideo, { provider: "Seedance", model: "doubao-seedance-2-0-260128", resolution: "720p" },
    "没指定供应商时任务快照记下兜底的 Seedance");
  const failed = await wait(legacyMode.task);
  assert.equal(failed.status, "failed");
  assert.match(JSON.stringify(failed.error), /镜头视频只支持全能参考（all_reference）模式/u);
  assert.match(JSON.stringify(failed.error), /不会改用其他模式/u);

  const missingMode = await wait((await api("/api/tasks/create", shotInput({}))).task);
  assert.equal(missingMode.status, "failed");
  assert.match(JSON.stringify(missingMode.error), /镜头视频只支持全能参考（all_reference）模式/u);

  // 对照：同样的请求只把模式换成全能参考，就越过模式检查、停在「没有视频密钥」——证明上面拦下它们的确实是模式。
  const allReference = await wait((await api("/api/tasks/create", shotInput({ generationMode: "all_reference" }))).task);
  assert.equal(allReference.status, "failed", "测试服务器没有视频密钥，不会真的生成");
  assert.doesNotMatch(JSON.stringify(allReference.error), /只支持全能参考/u);
  assert.match(JSON.stringify(allReference.error), /未配置 Seedance API Key/u);
});
