import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowService } from "../src/workflow.js";
import { getConfig } from "../src/config.js";
import { InputError, OutputContractError, ensureOutputContract } from "../src/validation.js";
import { ensureStoryboardPlan } from "../src/storyboard-contract.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import {
  PRODUCTION_LINEAGE_SCHEMA_VERSION,
  lineageRef,
  packageDigest,
  signPackageDigest
} from "../src/production-lineage.js";
import {
  ANIMATION_PLAN_VERSION_UNSUPPORTED,
  legacyAnimationPlanMessage
} from "../public/storyboard-plan.js";
import { minimalStoryboardPlan } from "./helpers/minimal-storyboard-plan.js";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";

// 2026-10-11 起不再支持旧 2.0（首尾帧）与 3.0（direct_shot）Animation Plan，只保留 4.0 自主分镜。
// 这里锁住各处遇到旧 Plan 时的明确失败（规格 §4）：生成 400、契约抛错、服务端消费 409、
// 提交口拒收、测试包封装与导入拒收，以及已删除的路由与任务类型。判定只有一份：
// public/storyboard-plan.js 的 legacyAnimationPlanVersion / legacyAnimationPlanMessage。

const legacyPlans = [
  ["3.0", { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [{ shotId: "A01" }] }],
  ["2.0", { selectedVariantId: "V1", promptSchemaVersion: "2.0", shotPlan: [{ shotId: "A01", startFrame: {}, endFrame: {} }] }],
  ["unversioned", { selectedVariantId: "V1", shotPlan: [{ shotId: "A01" }] }]
];

test("最小合法 4.0 分镜夹具能过 ensureStoryboardPlan 全量校验", () => {
  for (const plan of [
    minimalStoryboardPlan(),
    minimalStoryboardPlan({ selectedVariantId: "V2", title: "主题", sceneId: "SC01", characterName: "奶奶", durationSeconds: 6 })
  ]) {
    assert.equal(ensureStoryboardPlan(structuredClone(plan)).promptSchemaVersion, "4.0");
    assert.equal(ensureOutputContract(structuredClone(plan), "animationPlan").promptSchemaVersion, "4.0");
  }
});

test("生成只接受 4.0：缺省或旧版本在调用任何模型之前 InputError，code 为 ANIMATION_PLAN_VERSION_UNSUPPORTED", async () => {
  let modelCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() { modelCalls += 1; throw new Error("版本不对时不得调用任何模型"); },
      async requestCompletion() { modelCalls += 1; throw new Error("版本不对时不得调用任何模型"); }
    }
  });
  // animationPlanMode 不再读取：带着旧的 direct_shot 也一样按缺版本拒绝。
  for (const extra of [{}, { animationPlanMode: "direct_shot" }, { animationPlanVersion: "3.0" }, { animationPlanVersion: "2.0" }, { animationPlanVersion: 4 }]) {
    const error = await workflow.createAnimationPlanWithMetadata({ ...extra }).then(() => null, (caught) => caught);
    assert.ok(error instanceof InputError, JSON.stringify(extra));
    assert.equal(error.code, ANIMATION_PLAN_VERSION_UNSUPPORTED, JSON.stringify(extra));
    assert.equal(error.details[0].code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
    assert.match(error.message, /只支持生成 4\.0 自主分镜/u);
  }
  await assert.rejects(() => workflow.createAnimationPlan({}), (error) => error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED);
  assert.equal(modelCalls, 0);
});

test("契约层：ensureOutputContract(_, \"animationPlan\") 对旧 Plan 抛 OutputContractError，提示语与 code 统一", () => {
  for (const [version, plan] of legacyPlans) {
    assert.throws(
      () => ensureOutputContract(structuredClone(plan), "animationPlan"),
      (error) => error instanceof OutputContractError
        && error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED
        && error.message === legacyAnimationPlanMessage(version)
        && error.details[0].code === ANIMATION_PLAN_VERSION_UNSUPPORTED,
      version
    );
  }
  assert.match(legacyAnimationPlanMessage("3.0"), /^这是旧版 3\.0 分镜，已不再支持（只支持 4\.0 自主分镜）。请重新生成分镜。$/u);
  assert.throws(() => ensureOutputContract(null, "animationPlan"), /animationPlan 必须是对象/u);
  const plan = minimalStoryboardPlan();
  assert.equal(ensureOutputContract(plan, "animationPlan"), plan);
});

test("静态帧编译器与分镜终审/定向修订的模型阶段已删除：配置与工作流阶段默认值里都没有", () => {
  assert.equal(Object.hasOwn(getConfig(), "staticFrameCompiler"), false);
  const workflow = new WorkflowService();
  for (const stage of ["staticFrameCompiler", "animationPlanReview", "animationPlanRevision"]) {
    assert.equal(Object.hasOwn(workflow.stageDefaults, stage), false, stage);
  }
  assert.ok(workflow.stageDefaults.animationPlan, "4.0 分镜阶段照常存在");
});

async function withStore(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-legacy-plan-guard-"));
  let nextId = 0;
  const store = new ProductionStateStore({ rootDir, idFactory: () => `guard-${++nextId}` });
  try {
    await run({ store, rootDir });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function commitChain(store, run, planContent) {
  const commit = (input) => store.commitArtifact({
    projectId: run.projectId, runId: run.runId, expectedCurrentRevision: null, dependencies: [],
    requestId: `request-${input.artifactId.replaceAll(":", "-")}`, ...input
  });
  const variantContent = { id: "V1", title: "主题", characterSetup: { protagonist: "阿岚" } };
  const storyContent = { selectedVariantId: "V1", sceneScript: [{ sceneId: "S1" }] };
  const variant = await commit({ artifactId: "variant:V1", artifactType: "selectedVariant", content: variantContent });
  const story = await commit({ artifactId: "fullStory:V1", artifactType: "fullStory", content: storyContent, dependencies: [lineageRef(variant.lineage)] });
  // 状态库本身不按 Plan 版本拒收：这里直接写进去，模拟删除之前就存在的旧 Run。
  const plan = await commit({ artifactId: "animationPlan:V1", artifactType: "animationPlan", content: planContent, dependencies: [lineageRef(story.lineage)], createMediaNamespace: true });
  return { variantContent, storyContent, variant, story, plan };
}

const publicLineage = (lineage) => ({
  artifactId: lineage.artifactId, artifactType: lineage.artifactType, revision: lineage.revision,
  contentDigest: lineage.contentDigest, dependencies: lineage.dependencies, status: lineage.status
});

async function runDirectoryCount(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries.filter((item) => item.isDirectory())) {
    count += (await fs.readdir(path.join(rootDir, entry.name))).length;
  }
  return count;
}

test("测试包：旧 Plan 拒绝封装，带旧 Plan 的历史包在建 Run 之前拒绝导入", async () => {
  await withStore(async ({ store, rootDir }) => {
    for (const [version, legacyPlan] of legacyPlans) {
      const run = await store.createRun({ projectId: `project-legacy-${version.replace(".", "-")}` });
      const chain = await commitChain(store, run, legacyPlan);
      await assert.rejects(
        store.sealPackage({ ...run, payload: { selectedVariant: chain.variantContent, fullStory: chain.storyContent, animationPlan: legacyPlan } }),
        (error) => error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED && error.httpStatus === 400
          && error.message === legacyAnimationPlanMessage(version),
        version
      );

      // 删除之前导出的历史包：签名合法、包版本 3.0（参考视频的包形状），里面是旧 Plan。
      const unsigned = {
        packageType: "story-production-test-package", packageVersion: "3.0",
        selectedVariant: chain.variantContent, fullStory: chain.storyContent, animationPlan: legacyPlan,
        productionLineage: {
          schemaVersion: PRODUCTION_LINEAGE_SCHEMA_VERSION, projectId: run.projectId, runId: run.runId,
          artifacts: {
            selectedVariant: publicLineage(chain.variant.lineage),
            fullStory: publicLineage(chain.story.lineage),
            animationPlan: publicLineage(chain.plan.lineage)
          },
          mediaNamespace: chain.plan.lineage.mediaNamespace
        }
      };
      const digest = packageDigest(unsigned);
      const historical = { ...unsigned, packageDigest: digest, packageSignature: signPackageDigest(digest, await store.signingKey()) };
      await assert.rejects(
        store.validatePackage(historical),
        (error) => error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED && error.httpStatus === 400,
        version
      );
      const before = await runDirectoryCount(rootDir);
      let created = 0;
      await assert.rejects(
        store.importPackage(historical, { onRunCreated: () => { created += 1; } }),
        (error) => error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED,
        version
      );
      assert.equal(created, 0, `${version}：拒绝导入时不得建出 Run`);
      assert.equal(await runDirectoryCount(rootDir), before, `${version}：拒绝导入时状态目录不得新增 Run`);
    }

    // 对照：同样的包结构换成 4.0 分镜照常封装、导入（包版本 3.0 与 Plan 版本无关）。
    const run = await store.createRun({ projectId: "project-storyboard-package" });
    const plan = minimalStoryboardPlan();
    const chain = await commitChain(store, run, plan);
    const sealed = await store.sealPackage({ ...run, payload: { selectedVariant: chain.variantContent, fullStory: chain.storyContent, animationPlan: plan } });
    assert.equal(sealed.packageVersion, "3.0");
    const imported = await store.importPackage(sealed);
    assert.notEqual(imported.production.runId, run.runId);
    assert.equal(imported.production.artifacts["animationPlan:V1"].status, "current");
  });
});

const post = async (base, route, body) => {
  const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};

test("HTTP：生成 400、提交口与消费端拒收旧 Plan，已删除的路由与任务类型按未知处理", async (t) => {
  const runtime = await createStoryboardRuntime();
  t.after(() => runtime.close());
  const { base, run, variant, store, requests } = runtime;
  const requestsBefore = requests.length;

  const health = await (await fetch(`${base}/api/health`)).json();
  for (const stage of ["staticFrameCompiler", "animationPlanReview", "animationPlanRevision"]) {
    assert.equal(health.modelStages?.[stage], undefined, stage);
  }
  assert.ok(health.modelStages?.animationPlan, "4.0 分镜阶段照常上报");

  // §4.1 生成：不带版本或带旧版本，在调用模型之前 400，顶层 code 就是版本码。
  for (const extra of [{}, { animationPlanVersion: "3.0" }, { animationPlanMode: "direct_shot" }]) {
    const { status, json } = await post(base, "/api/animation-plan", extra);
    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
  }
  // Durable 任务同一个守卫：任务失败并带同一个码，不回退到旧生成。
  const missing = await runtime.api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
    variantId: variant.id, creatorProfile: runtime.input.creatorProfile, targetAspectRatio: "16:9"
  } });
  const missingTask = await runtime.wait(missing.task);
  assert.equal(missingTask.status, "failed");
  assert.equal(missingTask.error.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
  assert.equal(requests.length, requestsBefore, "版本不对时不得调用任何模型");

  // 已删除的路由：得到既有的未知路由 404。
  for (const route of ["/api/animation-plan-review", "/api/animation-plan-revision", "/api/animation-plan/video-prompts/rewrite", "/api/generate-shot-frame-image"]) {
    const { status, json } = await post(base, route, {});
    assert.equal(status, 404, route);
    assert.equal(json.error, "接口不存在", route);
  }
  // 已删除的任务类型：建任务时 400 TASK_KIND_UNSUPPORTED。
  for (const kind of ["shotVideoBatch", "shotFrameImage", "animationPromptRewrite"]) {
    const { status, json } = await post(base, "/api/tasks/create", { ...run, kind, input: { variantId: variant.id } });
    assert.equal(status, 400, kind);
    assert.equal(json.code, "TASK_KIND_UNSUPPORTED", kind);
  }

  // §4.4 提交口：旧 Plan 409，非对象 400，新的 shotFrame 产物 400。
  const loaded = await store.loadRun({ ...run, includeContent: true });
  const storyRef = lineageRef(loaded.latestArtifacts[`fullStory:${variant.id}`].lineage);
  for (const [version, legacyPlan] of legacyPlans) {
    const { status, json } = await post(base, "/api/production/artifact/commit", {
      ...run, artifactId: `animationPlan:${variant.id}`, artifactType: "animationPlan",
      content: { ...legacyPlan, selectedVariantId: variant.id }, dependencies: [storyRef], requestId: `legacy-commit-${version.replace(".", "-")}`
    });
    assert.equal(status, 409, version);
    assert.equal(json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED, version);
    assert.equal(json.error, legacyAnimationPlanMessage(version), version);
  }
  const notObject = await post(base, "/api/production/artifact/commit", {
    ...run, artifactId: `animationPlan:${variant.id}`, artifactType: "animationPlan", content: "3.0", dependencies: [storyRef], requestId: "legacy-commit-string"
  });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
  const frame = await post(base, "/api/production/artifact/commit", {
    ...run, artifactId: `shotFrame:${variant.id}:A01:start`, artifactType: "shotFrame", content: {}, requestId: "frame-commit"
  });
  assert.equal(frame.status, 400);
  assert.equal(frame.json.code, "SHOT_FRAME_ARTIFACT_UNSUPPORTED");
  const after = await store.loadRun({ ...run, includeContent: true });
  assert.equal(after.latestArtifacts[`animationPlan:${variant.id}`], undefined, "被拒的提交不得留下 Plan");

  // §4.3 消费：旧 Run 里已有的旧 Plan（绕过提交口写进状态库，模拟历史数据），读它的任务与路由一律 409。
  const legacyPlan = { ...legacyPlans[0][1], selectedVariantId: variant.id, characterReferencePrompts: [{ characterName: "阿岚" }] };
  const committed = await store.commitArtifact({
    ...run, artifactId: `animationPlan:${variant.id}`, artifactType: "animationPlan", content: legacyPlan,
    dependencies: [storyRef], requestId: "legacy-direct", expectedCurrentRevision: null, createMediaNamespace: true
  });
  const productionContext = {
    projectId: run.projectId, runId: run.runId, planArtifactId: committed.lineage.artifactId,
    planRevision: committed.lineage.revision, planDigest: committed.lineage.contentDigest, mediaNamespace: committed.lineage.mediaNamespace
  };
  for (const [kind, input] of [
    ["shotVideoPrompt", { variantId: variant.id, shotId: "A01", productionContext, videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128" }],
    ["shotVideo", { variantId: variant.id, shotId: "A01", productionContext, generationMode: "all_reference", promptOverride: "测试" }],
    ["characterReferenceImages", { variantId: variant.id, roleIndex: 0, productionContext }],
    ["characterReferenceRefine", { variantId: variant.id, roleIndex: 0, imageDataUrl: "data:image/png;base64,AA==" }]
  ]) {
    const { status, json } = await post(base, "/api/tasks/create", { ...run, kind, input });
    assert.equal(status, 409, `${kind}: ${JSON.stringify(json)}`);
    assert.equal(json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED, kind);
  }
  const direct = await post(base, "/api/generate-shot-video", {
    productionContext, selectedVariantId: variant.id, shotId: "A01", generationMode: "all_reference", promptOverride: "测试"
  });
  assert.equal(direct.status, 409, JSON.stringify(direct.json));
  assert.equal(direct.json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
  // 角色参考图 SSE 端点（带 productionContext 时转成 Durable Task）：在读角色参考项与画风之前就拦旧 Plan。
  // 角色对得上、或对不上（不传 roleIndex、按名字找不到）都是 409 版本码，不先报 400 roleIndex。
  for (const extra of [{ roleIndex: 0 }, { characterReference: { characterName: "不存在的角色" } }, {}]) {
    const response = await fetch(`${base}/api/generate-character-reference-images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productionContext, selectedVariant: { id: variant.id }, ...extra })
    });
    const text = await response.text();
    const events = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    const error = events.find((event) => event.type === "error");
    assert.equal(error?.status, 409, `${JSON.stringify(extra)}: ${text}`);
    assert.equal(error.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);
    assert.equal(error.error, legacyAnimationPlanMessage("3.0"));
  }

  // §4.5 打包：旧 Plan 拒绝封装。
  const seal = await post(base, "/api/production/package/seal", { ...run, payload: { selectedVariant: variant, fullStory: runtime.fullStory, animationPlan: legacyPlan } });
  assert.equal(seal.status, 400, JSON.stringify(seal.json));
  assert.equal(seal.json.code, ANIMATION_PLAN_VERSION_UNSUPPORTED);

  // 旧 Plan 上照常可以重新生成 4.0 分镜（重新生成不读当前 Plan）。
  const regenerated = await runtime.api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
    variantId: variant.id, creatorProfile: runtime.input.creatorProfile, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false
  } });
  const done = await runtime.wait(regenerated.task);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  const final = await store.loadRun({ ...run, includeContent: true });
  assert.equal(final.latestArtifacts[`animationPlan:${variant.id}`].content.promptSchemaVersion, "4.0");
});
