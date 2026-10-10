import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore, STORY_PACKAGE_GRAPH } from "../src/production-state-store.js";
import { contentDigest, lineageRef, packageDigest, signPackageDigest } from "../src/production-lineage.js";
import { normalizeStoryEntryCreatorProfile, normalizeStorySource } from "../public/story-entry.js";

// 「从剧情开始」的 Run 的 3.1 测试包（2026-10-10）。内容由服务端从 Run 读出；签发前与导入时同一套校验；
// 导入重建一个独立的剧情 Run，依赖图与原 Run 完全一样。

const creatorProfile = normalizeStoryEntryCreatorProfile({ fixedCharacter: "阿岚，社区修理师", vertical: "治愈系日常", constraints: "" });
const fullTextSource = normalizeStorySource({ storyMode: "fullStoryText", storyText: "阿岚在雨里捡到一只小猫，把它带回修理铺。" });
const characterOnlySource = normalizeStorySource({ storyMode: "characterOnly" });
const guardrails = { fixedCharacterBoundary: { characterName: "阿岚" }, sourceSimilarityRules: [] };
const fullStory = { selectedVariantId: "V1", title: "雨天的纸箱", sceneScript: [{ sceneId: "S1", timeRange: "00:00-00:10" }] };
const plan = { selectedVariantId: "V1", promptSchemaVersion: "4.0", productionStrategy: { artStyle: "二维日系动画" }, shotPlan: [{ shotId: "A01" }] };
const candidate = { id: "V1", title: "雨天的纸箱", characterSetup: { protagonist: "阿岚" } };

async function withStore(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-story-package-test-"));
  let nextId = 0;
  const store = new ProductionStateStore({ rootDir, idFactory: () => `id-${++nextId}` });
  try {
    await run({ store, rootDir });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function commit(store, run, artifactId, artifactType, content, dependencies = [], extra = {}) {
  const committed = await store.commitArtifact({
    projectId: run.projectId,
    runId: run.runId,
    artifactId,
    artifactType,
    content,
    dependencies: dependencies.map((item) => lineageRef(item.lineage)),
    requestId: `request-${artifactId.replaceAll(":", "-")}`,
    expectedCurrentRevision: null,
    ...extra
  });
  return committed;
}

async function storyRun(store, { storyMode = "fullStoryText", withPlan = true, oldGraph = false } = {}) {
  const storySource = storyMode === "fullStoryText" ? fullTextSource : characterOnlySource;
  const run = await store.createRun({
    metadata: { entryMode: "story", storyMode, storySourceDigest: contentDigest(storySource), creatorProfile, startedBy: "browser-story-entry" }
  });
  const source = await commit(store, run, "storySource", "storySource", storySource);
  const boundary = await commit(store, run, "visualGuardrails", "visualGuardrails", guardrails, [source]);
  let story;
  if (storyMode === "characterOnly" || oldGraph) {
    const variants = await commit(store, run, "themeVariants", "themeVariants", { variants: [candidate] }, [source, boundary]);
    const selected = await commit(store, run, "variant:V1", "selectedVariant", candidate, [variants]);
    story = await commit(store, run, "fullStory:V1", "fullStory", fullStory, [source, boundary, variants, selected]);
    if (withPlan) await commit(store, run, "animationPlan:V1", "animationPlan", plan, [source, boundary, selected, story], { createMediaNamespace: true });
  } else {
    story = await commit(store, run, "fullStory:V1", "fullStory", fullStory, [source, boundary]);
    if (withPlan) await commit(store, run, "animationPlan:V1", "animationPlan", plan, [source, boundary, story], { createMediaNamespace: true });
  }
  return run;
}

const browserPayload = (extra = {}) => ({ exportedAt: "2026-10-10T00:00:00.000Z", mode: "live", modelInfo: { storyModel: "mimo-v2.6-pro" }, fullStory, animationPlan: plan, ...extra });

async function resign(rootDir, body) {
  const key = await fs.readFile(path.join(rootDir, ".package-signing-key"));
  const { packageDigest: _digest, packageSignature: _signature, ...unsigned } = body;
  const digest = packageDigest(unsigned);
  return { ...unsigned, packageDigest: digest, packageSignature: signPackageDigest(digest, key) };
}

const graphShape = (artifacts) => Object.fromEntries(Object.entries(artifacts).map(([artifactId, lineage]) => [
  artifactId, { type: lineage.artifactType, dependencies: lineage.dependencies.map((ref) => ref.artifactId).sort() }
]));

test("粘贴完整故事的 Run：签 3.1 包，原文、设定与各份产物都来自 Run；导入后依赖图与原 Run 完全一样", async () => {
  await withStore(async ({ store }) => {
    const run = await storyRun(store);
    const sealed = await store.sealPackage({ projectId: run.projectId, runId: run.runId, payload: browserPayload() });
    assert.equal(sealed.packageVersion, "3.1");
    assert.equal(sealed.entryMode, "story");
    assert.equal(sealed.storyMode, "fullStoryText");
    assert.deepEqual(sealed.storySource, fullTextSource);
    assert.equal(sealed.storySourceDigest, contentDigest(fullTextSource));
    assert.deepEqual(sealed.creatorProfile, creatorProfile);
    assert.deepEqual(Object.keys(sealed.productionLineage.artifacts).sort(), ["animationPlan", "fullStory", "storySource", "visualGuardrails"]);
    assert.equal(Object.hasOwn(sealed, "themeVariants"), false);
    assert.equal(Object.hasOwn(sealed, "selectedVariant"), false, "故事位不是候选，不装进包");
    await assert.doesNotReject(store.validatePackage(sealed));

    let createdSeen = null;
    const imported = await store.importPackage(sealed, {
      onRunCreated: async (created) => {
        // 元数据在第一次提交之前就写好了。
        const loaded = await store.loadRun({ projectId: created.projectId, runId: created.runId, includeContent: false });
        createdSeen = { metadata: loaded.metadata, artifacts: Object.keys(loaded.latestArtifacts || loaded.artifacts || {}) };
      }
    });
    assert.equal(createdSeen.metadata.entryMode, "story");
    assert.equal(createdSeen.metadata.storyMode, "fullStoryText");
    assert.equal(createdSeen.metadata.storySourceDigest, contentDigest(fullTextSource));
    assert.deepEqual(createdSeen.metadata.creatorProfile, creatorProfile);
    assert.equal(createdSeen.metadata.startedBy, "package-import");
    assert.equal(createdSeen.metadata.importedFromPackageDigest, sealed.packageDigest);
    assert.deepEqual(createdSeen.artifacts, []);
    assert.equal(JSON.stringify(createdSeen.metadata).includes("修理铺"), false, "原文不进 Run 元数据");

    assert.notEqual(imported.production.runId, run.runId);
    assert.equal(imported.production.metadata.entryMode, "story");
    const source = await store.loadRun({ projectId: run.projectId, runId: run.runId, includeContent: false });
    const sourceShape = graphShape(Object.fromEntries(Object.entries(source.latestArtifacts).map(([id, entry]) => [id, entry.lineage])));
    assert.deepEqual(graphShape(imported.production.artifacts), sourceShape);
    assert.match(imported.production.artifacts["animationPlan:V1"].mediaNamespace, new RegExp(`^${imported.production.projectId}/${imported.production.runId}/`, "u"));
    const reloaded = await store.loadRun({ projectId: imported.production.projectId, runId: imported.production.runId, includeContent: true });
    assert.deepEqual(reloaded.latestArtifacts.storySource.content, fullTextSource);
    assert.deepEqual(reloaded.latestArtifacts["fullStory:V1"].content, fullStory);
  });
});

test("还没有分镜的剧情 Run 也能导出：包里没有分镜，导入后也没有", async () => {
  await withStore(async ({ store }) => {
    const run = await storyRun(store, { withPlan: false });
    const sealed = await store.sealPackage({ projectId: run.projectId, runId: run.runId, payload: browserPayload({ animationPlan: null }) });
    assert.equal(Object.hasOwn(sealed, "animationPlan"), false);
    assert.equal(sealed.productionLineage.mediaNamespace, "");
    const imported = await store.importPackage(sealed);
    assert.deepEqual(Object.keys(imported.production.artifacts).sort(), ["fullStory:V1", "storySource", "visualGuardrails"]);
  });
});

test("只给角色设定的 Run：候选与选中记录一起装进包，导入后依赖图与原 Run 完全一样", async () => {
  await withStore(async ({ store }) => {
    const run = await storyRun(store, { storyMode: "characterOnly" });
    const sealed = await store.sealPackage({ projectId: run.projectId, runId: run.runId, payload: browserPayload() });
    assert.equal(sealed.storyMode, "characterOnly");
    assert.deepEqual(sealed.themeVariants, { variants: [candidate] });
    assert.deepEqual(sealed.selectedVariant, candidate);
    const imported = await store.importPackage(sealed);
    const source = await store.loadRun({ projectId: run.projectId, runId: run.runId, includeContent: false });
    const sourceShape = graphShape(Object.fromEntries(Object.entries(source.latestArtifacts).map(([id, entry]) => [id, entry.lineage])));
    assert.deepEqual(graphShape(imported.production.artifacts), sourceShape);
    assert.deepEqual(graphShape(imported.production.artifacts)["variant:V1"], { type: "selectedVariant", dependencies: ["themeVariants"] });
  });
});

test("打包只认页面发来的五个字段；副本不是当前版本、原文摘要对不上、早期版本的依赖图，一律拒绝", async () => {
  await withStore(async ({ store }) => {
    const run = await storyRun(store);
    const seal = (payload, target = run) => store.sealPackage({ projectId: target.projectId, runId: target.runId, payload });
    // 页面想自己塞一份原文或设定：拒绝。
    for (const extra of [{ storySource: fullTextSource }, { creatorProfile }, { selectedVariant: { id: "V1", storySourceSlot: true } }]) {
      await assert.rejects(seal(browserPayload(extra)), (error) => error.code === "PRODUCTION_PACKAGE_STORY_INPUT_INVALID" && error.httpStatus === 400);
    }
    await assert.rejects(seal(browserPayload({ fullStory: { ...fullStory, title: "页面上改过" } })), (error) => error.code === "PACKAGE_ARTIFACT_DIGEST_MISMATCH");
    await assert.rejects(seal(browserPayload({ modelInfo: "x" })), (error) => error.code === "PRODUCTION_PACKAGE_STORY_INPUT_INVALID");

    // 第一期最早那版造出的「粘贴完整故事」Run（带候选与选中记录）：明确拒绝，不改它的结构。
    const oldRun = await storyRun(store, { oldGraph: true });
    await assert.rejects(seal(browserPayload(), oldRun), (error) => error.code === "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED" && error.httpStatus === 409);

    // 原文摘要与建 Run 时记的不一致。
    const tampered = await store.createRun({ metadata: { entryMode: "story", storyMode: "fullStoryText", storySourceDigest: "f".repeat(64), creatorProfile } });
    const source = await commit(store, tampered, "storySource", "storySource", fullTextSource);
    const boundary = await commit(store, tampered, "visualGuardrails", "visualGuardrails", guardrails, [source]);
    await commit(store, tampered, "fullStory:V1", "fullStory", fullStory, [source, boundary]);
    await assert.rejects(seal({ fullStory }, tampered), (error) => error.code === "STORY_SOURCE_TAMPERED");
  });
});

test("内容改过再重新签名的包：语义校验仍然拦下（依赖图、入口、原文摘要、设定、多余字段、候选与选中记录）", async () => {
  await withStore(async ({ store, rootDir }) => {
    const run = await storyRun(store, { storyMode: "characterOnly" });
    const sealed = await store.sealPackage({ projectId: run.projectId, runId: run.runId, payload: browserPayload() });
    const rejectsWith = async (mutate, code) => {
      const body = structuredClone(sealed);
      mutate(body);
      await assert.rejects(store.validatePackage(await resign(rootDir, body)), (error) => error.code === code, code);
    };
    await rejectsWith((body) => { body.extra = 1; }, "PRODUCTION_PACKAGE_STORY_INVALID");
    await rejectsWith((body) => { body.entryMode = "video"; }, "PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED");
    await rejectsWith((body) => { body.storySourceDigest = "0".repeat(64); }, "STORY_SOURCE_TAMPERED");
    await rejectsWith((body) => { body.creatorProfile = { ...body.creatorProfile, extra: "x" }; }, "PRODUCTION_PACKAGE_STORY_INVALID");
    await rejectsWith((body) => { body.productionLineage.artifacts.fullStory.dependencies = body.productionLineage.artifacts.fullStory.dependencies.slice(0, 2); }, "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED");
    await rejectsWith((body) => { delete body.productionLineage.artifacts.visualGuardrails; }, "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED");
    // 候选与选中记录不同（lineage 摘要同步改好，只剩语义不一致）。
    await rejectsWith((body) => {
      body.selectedVariant = { ...body.selectedVariant, title: "改过的标题" };
      body.productionLineage.artifacts.selectedVariant.contentDigest = contentDigest(body.selectedVariant);
      for (const key of ["fullStory", "animationPlan"]) {
        for (const ref of body.productionLineage.artifacts[key].dependencies) {
          if (ref.artifactId === "variant:V1") ref.contentDigest = contentDigest(body.selectedVariant);
        }
      }
    }, "PRODUCTION_PACKAGE_VARIANT_MISMATCH");
    // 没有重新签名的篡改：摘要先拦。
    await assert.rejects(store.validatePackage({ ...sealed, extra: 1 }), (error) => error.code === "PRODUCTION_PACKAGE_DIGEST_MISMATCH");
  });
});

test("依赖图只有一份：两种剧情模式的节点与上游", () => {
  const shape = (mode) => STORY_PACKAGE_GRAPH[mode].map((node) => `${node.artifactId}<${node.dependsOn.join(",")}`);
  assert.deepEqual(shape("fullStoryText"), [
    "storySource<", "visualGuardrails<storySource", "fullStory:V1<storySource,visualGuardrails",
    "animationPlan:V1<storySource,visualGuardrails,fullStory"
  ]);
  assert.deepEqual(shape("characterOnly"), [
    "storySource<", "visualGuardrails<storySource", "themeVariants<storySource,visualGuardrails", "variant:V1<themeVariants",
    "fullStory:V1<storySource,visualGuardrails,themeVariants,selectedVariant",
    "animationPlan:V1<storySource,visualGuardrails,selectedVariant,fullStory"
  ]);
});
