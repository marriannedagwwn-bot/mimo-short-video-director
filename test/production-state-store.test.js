import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";

async function withStore(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-production-state-test-"));
  let nextId = 0;
  const store = new ProductionStateStore({
    rootDir,
    idFactory: () => `id-${++nextId}`
  });
  try {
    await run({ store, rootDir });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function commit(store, run, input) {
  return store.commitArtifact({
    projectId: run.projectId,
    runId: run.runId,
    requestId: input.requestId || `request-${input.artifactId.replaceAll(":", "-")}`,
    expectedCurrentRevision: input.expectedCurrentRevision ?? null,
    dependencies: input.dependencies || [],
    ...input
  });
}

test("persistent run checkpoints artifacts and restores them after a new store instance", async () => {
  await withStore(async ({ store, rootDir }) => {
    const run = await store.createRun({
      projectId: "project-test",
      metadata: { creatorProfile: { fixedCharacter: "奶奶" } }
    });
    await store.recordStage({
      projectId: run.projectId,
      runId: run.runId,
      stageId: "referenceAnalysis",
      status: "running",
      requestId: "request-analysis"
    });
    const analysis = await commit(store, run, {
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis",
      content: { summary: "分析" },
      requestId: "request-analysis"
    });
    const reopened = new ProductionStateStore({ rootDir });
    const loaded = await reopened.loadRun(run);
    assert.deepEqual(loaded.latestArtifacts.referenceAnalysis.content, { summary: "分析" });
    assert.equal(loaded.latestArtifacts.referenceAnalysis.lineage.revision, analysis.lineage.revision);
    assert.equal(loaded.stages.referenceAnalysis.status, "completed");
    assert.ok(loaded.checkpoint.sequence >= 2);
  });
});

test("stage.failed manifest 写入稳定诊断与 build identity 并剥离敏感字段", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-production-failure-test-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = new ProductionStateStore({
    rootDir,
    gitCommit: "abcdef1234567890",
    buildId: "production-test-build",
    idFactory: () => "failure-run"
  });
  const run = await store.createRun({ projectId: "project-failure" });

  await store.recordStage({
    projectId: run.projectId,
    runId: run.runId,
    stageId: "animationPlan:V1",
    status: "failed",
    requestId: "request-animation-failure",
    error: {
      code: "OUTPUT_CONTRACT_INVALID",
      category: "output-contract",
      message: "模型失败 data:image/png;base64,QUJDREVGRw==",
      diagnostics: [{
        code: "DIRECT_SHOT_TEST_FAILURE",
        jsonPointer: "/shotPlan/0/videoPrompt",
        reason: "提示词与签发事实冲突",
        prompt: "MUST_NOT_BE_LOGGED_PROMPT",
        boundarySignature: "MUST_NOT_BE_LOGGED_SIGNATURE"
      }]
    }
  });

  const loaded = await store.loadRun(run);
  const stage = loaded.stages["animationPlan:V1"];
  assert.equal(loaded.gitCommit, "abcdef1234567890");
  assert.equal(loaded.buildId, "production-test-build");
  assert.equal(stage.error.code, "DIRECT_SHOT_TEST_FAILURE");
  assert.equal(stage.error.stage, "animationPlan:V1");
  assert.deepEqual(stage.error.diagnostics, [{
    code: "DIRECT_SHOT_TEST_FAILURE",
    jsonPointer: "/shotPlan/0/videoPrompt",
    reason: "提示词与签发事实冲突"
  }]);
  const failedEvent = loaded.events.find((event) => event.type === "stage.failed");
  assert.equal(failedEvent.code, "DIRECT_SHOT_TEST_FAILURE");
  assert.equal(failedEvent.gitCommit, "abcdef1234567890");
  assert.equal(failedEvent.buildId, "production-test-build");
  const manifestText = await fs.readFile(
    path.join(rootDir, run.projectId, run.runId, "manifest.json"),
    "utf8"
  );
  assert.doesNotMatch(
    manifestText,
    /MUST_NOT_BE_LOGGED|data:image|boundarySignature|QUJDREVGRw/u
  );
});
test("same-id upstream change stales Story, Plan and media, while key reordering is idempotent", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-stale" });
    const originalCandidate = {
      id: "V1",
      title: "旧主题",
      newTask: "送回修好的旧钟",
      keyChoice: "先救下受困邻居再绕路",
      climax: "闭馆前让旧钟重新报时",
      characterSetup: { protagonist: "奶奶" }
    };
    const variant = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: originalCandidate
    });
    const reordered = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      expectedCurrentRevision: variant.lineage.revision,
      content: {
        characterSetup: { protagonist: "奶奶" },
        climax: "闭馆前让旧钟重新报时",
        keyChoice: "先救下受困邻居再绕路",
        newTask: "送回修好的旧钟",
        title: "旧主题",
        id: "V1"
      }
    });
    assert.equal(reordered.reused, true);

    const story = await commit(store, run, {
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: { selectedVariantId: "V1", sceneScript: [{ sceneId: "SC01" }] },
      dependencies: [lineageRef(variant.lineage)]
    });
    const plan = await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [] },
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });
    await commit(store, run, {
      artifactId: "shotVideo:V1:S01",
      artifactType: "shotVideo",
      content: { status: "ready", result: { outputUrl: "/old.mp4" } },
      dependencies: [lineageRef(plan.lineage)]
    });

    const changed = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      expectedCurrentRevision: variant.lineage.revision,
      content: {
        ...originalCandidate,
        title: "新主题",
        newTask: "修好并送回停摆的怀表",
        keyChoice: "放弃近路，先把唯一电池留给求助者",
        climax: "列车开走前让怀表重新走动"
      }
    });
    assert.deepEqual(changed.staleArtifactIds, [
      "animationPlan:V1",
      "fullStory:V1",
      "shotVideo:V1:S01"
    ]);
    const loaded = await store.loadRun(run, { includeContent: false });
    assert.equal(loaded.latestArtifacts["fullStory:V1"].lineage.status, "stale");
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.status, "stale");
    assert.equal(loaded.latestArtifacts["shotVideo:V1:S01"].lineage.status, "stale");

    await assert.rejects(
      commit(store, run, {
        artifactId: "fullStory:V1",
        artifactType: "fullStory",
        expectedCurrentRevision: story.lineage.revision,
        content: { selectedVariantId: "V1", sceneScript: [{ sceneId: "OLD" }] },
        dependencies: [lineageRef(variant.lineage)]
      }),
      (error) => error.code === "ARTIFACT_DEPENDENCY_STALE"
    );

    await assert.rejects(
      commit(store, run, {
        artifactId: "variant:V1",
        artifactType: "selectedVariant",
        expectedCurrentRevision: variant.lineage.revision,
        content: { id: "V1", title: "更旧的异步结果" }
      }),
      (error) => error.code === "ARTIFACT_REVISION_CONFLICT"
    );
  });
});

test("切换计划级画幅签发新 Plan revision 并只使旧镜头媒体 stale", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-aspect-ratio" });
    const story = await commit(store, run, {
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: { selectedVariantId: "V1", sceneScript: [{ sceneId: "S1" }] }
    });
    const shotPlan = [{ shotId: "A01", durationSeconds: 4, videoPrompt: "原镜头" }];
    const plan = await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: {
        selectedVariantId: "V1",
        productionStrategy: { targetAspectRatio: "9:16" },
        shotPlan
      },
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });
    await commit(store, run, {
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      content: { status: "ready", result: { outputUrl: "/9x16.mp4" } },
      dependencies: [lineageRef(plan.lineage)]
    });

    const changed = await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      expectedCurrentRevision: plan.lineage.revision,
      content: {
        selectedVariantId: "V1",
        productionStrategy: { targetAspectRatio: "16:9" },
        shotPlan
      },
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });

    assert.notEqual(changed.lineage.revision, plan.lineage.revision);
    assert.notEqual(changed.lineage.mediaNamespace, plan.lineage.mediaNamespace);
    assert.deepEqual(changed.staleArtifactIds, ["shotVideo:V1:A01"]);
    const loaded = await store.loadRun(run);
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].content.productionStrategy.targetAspectRatio, "16:9");
    assert.deepEqual(loaded.latestArtifacts["animationPlan:V1"].content.shotPlan, shotPlan);
    assert.equal(loaded.latestArtifacts["shotVideo:V1:A01"].lineage.status, "stale");
  });
});

test("后镜引用上一镜精确视频 revision，重选上一镜候选会递归使下游视频 stale", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-shot-continuity" });
    const plan = await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: {
        selectedVariantId: "V1",
        productionStrategy: { targetAspectRatio: "16:9" },
        shotPlan: [{ shotId: "A01" }, { shotId: "A02" }, { shotId: "A03" }]
      },
      createMediaNamespace: true
    });
    const a01 = await commit(store, run, {
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      content: { status: "ready", selectedIndex: 0, result: { outputUrl: "/a01-1.mp4" } },
      dependencies: [lineageRef(plan.lineage)]
    });
    const a02 = await commit(store, run, {
      artifactId: "shotVideo:V1:A02",
      artifactType: "shotVideo",
      content: { status: "ready", selectedIndex: 0, result: { outputUrl: "/a02.mp4" } },
      dependencies: [lineageRef(plan.lineage), lineageRef(a01.lineage)]
    });
    await commit(store, run, {
      artifactId: "shotVideo:V1:A03",
      artifactType: "shotVideo",
      content: { status: "ready", selectedIndex: 0, result: { outputUrl: "/a03.mp4" } },
      dependencies: [lineageRef(plan.lineage), lineageRef(a02.lineage)]
    });

    const changed = await commit(store, run, {
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      expectedCurrentRevision: a01.lineage.revision,
      content: { status: "ready", selectedIndex: 1, result: { outputUrl: "/a01-2.mp4" } },
      dependencies: [lineageRef(plan.lineage)]
    });

    assert.deepEqual(changed.staleArtifactIds, ["shotVideo:V1:A02", "shotVideo:V1:A03"]);
    const loaded = await store.loadRun(run);
    assert.equal(loaded.latestArtifacts["shotVideo:V1:A01"].lineage.status, "current");
    assert.equal(loaded.latestArtifacts["shotVideo:V1:A02"].lineage.status, "stale");
    assert.equal(loaded.latestArtifacts["shotVideo:V1:A03"].lineage.status, "stale");
  });
});

test("signed v3 package validates lineage, rejects tampering and imports into an isolated run", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-package" });
    const variantContent = { id: "V1", title: "主题", characterSetup: { protagonist: "奶奶" } };
    const storyContent = { selectedVariantId: "V1", sceneScript: [{ sceneId: "SC01" }] };
    const planContent = { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [] };
    const variant = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: variantContent
    });
    const story = await commit(store, run, {
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: storyContent,
      dependencies: [lineageRef(variant.lineage)]
    });
    await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: planContent,
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });
    const sealed = await store.sealPackage({
      projectId: run.projectId,
      runId: run.runId,
      payload: {
        packageType: "story-production-test-package",
        packageVersion: "3.0",
        selectedVariant: variantContent,
        fullStory: storyContent,
        animationPlan: planContent,
        shotVideoResults: { S01: { status: "ready" } }
      }
    });
    await assert.doesNotReject(store.validatePackage(sealed));
    await assert.rejects(
      store.validatePackage({ ...sealed, fullStory: { ...storyContent, sceneScript: [] } }),
      (error) => error.code === "PRODUCTION_PACKAGE_DIGEST_MISMATCH"
    );

    const imported = await store.importPackage(sealed);
    assert.notEqual(imported.production.runId, run.runId);
    assert.deepEqual(imported.payload.shotVideoResults, {});
    assert.equal(imported.discardedMedia, true);
    assert.equal(imported.production.artifacts["animationPlan:V1"].status, "current");
    assert.match(imported.production.artifacts["animationPlan:V1"].mediaNamespace, new RegExp(`^${imported.production.projectId}/${imported.production.runId}/`, "u"));
  });
});
