import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import { legacyAnimationPlanMessage } from "../public/storyboard-plan.js";

// 2026-10-11 起只支持 4.0 自主分镜（CLAUDE.md「已删除的功能」）。这里锁住页面这一侧的新行为：
// 旧 2.0/3.0 分镜显示「不再支持」卡片并能重新生成；镜头视频只剩全能参考、只剩 Seedance / MiniMax；
// 模型设置里没有已删除的阶段。

function recordingFetch() {
  const requests = [];
  const fetch = async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests };
}

const currentLineage = (artifactId, extra = {}) => ({
  artifactId, status: "current", revision: `${artifactId.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64), dependencies: [], ...extra
});

// 三种旧分镜：v2 首尾帧、3.0 direct_shot、没有版本号的。镜头里带一段只属于旧分镜的文字，用来证明它没被渲染出来。
const LEGACY_PLANS = {
  "2.0": { promptSchemaVersion: "2.0", selectedVariantId: "V2", productionStrategy: { format: "first_last_frame_video", targetAspectRatio: "16:9" },
    shotPlan: [{ shotId: "A01", startFrame: { prompt: "旧首帧提示词" }, endFrame: { prompt: "旧尾帧提示词" } }] },
  "3.0": { promptSchemaVersion: "3.0", selectedVariantId: "V2", productionStrategy: { format: "direct_shot_video", targetAspectRatio: "9:16" },
    shotPlan: [{ shotId: "A01", durationSeconds: 5, videoPrompt: "旧镜头视频提示词" }] },
  unversioned: { selectedVariantId: "V2", productionStrategy: {}, shotPlan: [{ shotId: "A01", videoPrompt: "旧镜头视频提示词" }] }
};

test("旧版分镜：分镜卡只显示按实际版本写的「不再支持」说明和「重新生成分镜」按钮，不按 4.0 渲染其中内容", async () => {
  for (const [version, plan] of Object.entries(LEGACY_PLANS)) {
    const app = await loadAppUi({ story: true });
    app.state.animationPlans.V2 = plan;
    app.renderAnimationPlan(plan);
    const html = app.elements.animationPlan.innerHTML;
    assert.ok(html.includes(legacyAnimationPlanMessage(version)), version);
    assert.match(html, /<button[^>]*data-regenerate-storyboard[^>]*>重新生成分镜<\/button>/u);
    assert.doesNotMatch(html, /旧首帧提示词|旧尾帧提示词|旧镜头视频提示词/u, "旧分镜内容不当成 4.0 读");
    assert.doesNotMatch(html, /data-open-character-image-generator|data-shot-video/u, "旧分镜上没有出图、镜头视频入口");
    assert.equal(app.elements.animationPlan.classList.contains("hidden"), false);
  }
  assert.equal(legacyAnimationPlanMessage("3.0"), "这是旧版 3.0 分镜，已不再支持（只支持 4.0 自主分镜）。请重新生成分镜。");
  assert.equal(legacyAnimationPlanMessage("unversioned"), "这是无版本号的旧版分镜，已不再支持（只支持 4.0 自主分镜）。请重新生成分镜。");
});

test("旧版分镜：生成中时「重新生成分镜」按钮禁用", async () => {
  const app = await loadAppUi({ story: true });
  app.state.animationPlans.V2 = LEGACY_PLANS["3.0"];
  app.state.animationRunning = true;
  app.renderAnimationPlan(LEGACY_PLANS["3.0"]);
  assert.match(app.elements.animationPlan.innerHTML, /<button[^>]*data-regenerate-storyboard disabled>重新生成分镜<\/button>/u);
});

test("分场页打开旧版分镜：状态栏按实际版本说明（warn），不说「已生成」", async () => {
  const app = await loadAppUi({ story: true });
  app.state.animationPlans.V2 = LEGACY_PLANS["2.0"];
  app.renderStoryPage();
  assert.equal(app.elements.animationStatus.textContent, legacyAnimationPlanMessage("2.0"));
  assert.match(app.elements.animationStatus.className, /warn/u);
  assert.match(app.elements.animationPlan.innerHTML, /data-regenerate-storyboard/u);
});

test("「重新生成分镜」按钮走生成 4.0 分镜的同一个入口，并且带 force", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /closest\("\[data-regenerate-storyboard\]"\)\) return generateAnimationPlan\(\{ force: true \}\);/u);
});

test("已有旧版分镜时不带 force 也真的重新生成：请求 4.0，不再带 animationPlanMode 与编译器字段", async () => {
  for (const plan of Object.values(LEGACY_PLANS)) {
    const { fetch, requests } = recordingFetch();
    const app = await loadAppUi({ fetch, story: true });
    app.state.entryMode = "story";
    app.state.storyMode = "characterOnly";
    app.state.production.artifacts["variant:V2"] = currentLineage("variant:V2");
    app.state.animationPlans.V2 = plan;
    await app.generateAnimationPlan();
    const created = requests.find((request) => request.path === "/api/tasks/create");
    assert.ok(created, "旧分镜上 !force 不能只重绘");
    assert.equal(created.body.kind, "animationPlan");
    assert.equal(created.body.input.animationPlanVersion, "4.0");
    for (const key of ["animationPlanMode", "includeCompilerMetadata", "privateSidecars", "videoPromptTarget"]) {
      assert.equal(Object.hasOwn(created.body.input, key), false, key);
    }
  }
});

test("已有 4.0 分镜时不带 force 只重绘、不发请求（这条捷径只对 4.0 生效）", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true, plan: true });
  app.state.entryMode = "story";
  app.state.storyMode = "characterOnly";
  app.state.production.artifacts["variant:V2"] = currentLineage("variant:V2");
  app.elements.animationPlan.innerHTML = "";
  await app.generateAnimationPlan();
  assert.equal(requests.length, 0);
  assert.doesNotMatch(app.elements.animationPlan.innerHTML, /data-regenerate-storyboard/u);
  assert.ok(app.elements.animationPlan.innerHTML.includes(app.fixture.animationPlan.shotPlan[0].shotId));
});

test("旧版分镜打不开镜头视频弹窗：明确说明要重新生成分镜，不写提示词、不发请求", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true });
  app.state.animationPlans.V2 = LEGACY_PLANS["3.0"];
  app.state.production.artifacts["animationPlan:V2"] = currentLineage("animationPlan:V2", { mediaNamespace: "project/run/animationPlan-V2-r1" });
  await app.openShotVideoGenerator("A01");
  assert.equal(app.state.shotVideoGeneration.open, false);
  assert.equal(app.elements.animationStatus.textContent, legacyAnimationPlanMessage("3.0"));
  assert.match(app.elements.animationStatus.className, /error/u);
  assert.equal(requests.length, 0);
});

test("恢复 Run 时不再读取旧的 shotFrame:* 产物，其余产物照常恢复", async () => {
  const app = await loadAppUi();
  const entry = (content, createdAt) => ({ content, lineage: { status: "current", createdAt } });
  app.restoreRunArtifacts({
    themeVariants: entry(app.fixture.themeVariants, "2026-10-01T00:00:00Z"),
    "fullStory:V2": entry(app.fixture.fullStory, "2026-10-01T00:01:00Z"),
    "animationPlan:V2": entry(app.fixture.animationPlan, "2026-10-01T00:02:00Z"),
    "shotFrame:V2:A01:start": entry({ status: "ready", outputUrl: "/generated/old-start.png" }, "2026-10-01T00:03:00Z")
  }, { selectedVariantId: "V2" });
  assert.equal(app.state.fullStories.V2, app.fixture.fullStory);
  assert.equal(app.state.animationPlans.V2, app.fixture.animationPlan);
  assert.equal(Object.hasOwn(app.state, "shotFrameResults"), false);
  assert.doesNotMatch(JSON.stringify(app.state.shotVideoResults), /old-start/u);
  assert.doesNotMatch(JSON.stringify(app.state.output), /old-start/u);
});

test("镜头视频只剩全能参考：请求固定 generationMode=all_reference；页面上没有首尾帧模式的下拉", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true, plan: true });
  app.state.production.artifacts["animationPlan:V2"] = currentLineage("animationPlan:V2", { mediaNamespace: "project/run/animationPlan-V2-r1" });
  Object.assign(app.state.shotVideoGeneration, {
    includePreviousShotFrames: false,
    includeCharacterReferences: false,
    referenceAssets: [{ id: "upload-1", mediaType: "image", name: "ref.png", dataUrl: "data:image/png;base64,AA==", sizeBytes: 3, durationSeconds: 0, source: "upload" }]
  });
  await app.generateShotVideo("A01", "固定主角确认工具柄内侧的交代。", { count: 1 });
  const created = requests.find((request) => request.path === "/api/tasks/create" && request.body.kind === "shotVideo");
  assert.ok(created, "镜头视频建任务的请求发出去了");
  assert.equal(created.body.input.generationMode, "all_reference");
  assert.equal(created.body.input.animationPromptSchemaVersion, "4.0");
  for (const key of ["includeEndpointFrames", "startFrame", "endFrame", "negativePrompt", "videoPromptProfile"]) {
    assert.equal(Object.hasOwn(created.body.input, key), false, key);
  }

  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="shotVideoGenerationMode"|first_last_frame|首尾帧模式|shotFrameImageModal|startShotVideoBatch/u);
  assert.match(html, /全能参考：图片、视频、音频只作参考，不锁定精确首尾帧。/u);
});

test("镜头视频供应商只有 Seedance / MiniMax，没选过时兜底 Seedance", async () => {
  const app = await loadAppUi();
  app.state.modelStages = {};
  app.state.modelOverrides = {};
  assert.equal(app.shotVideoSetting().provider, "Seedance");
  app.openModelSettings();
  const row = app.elements.modelStageList.innerHTML.match(/<div class="model-stage-row" data-model-stage="shotVideo">([\s\S]*?)<\/select>/u)?.[1];
  assert.ok(row, "模型设置里有镜头视频这一行");
  assert.deepEqual([...row.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]), ["Seedance", "MiniMax"]);
  assert.match(row, /<option value="Seedance" selected>/u);
  assert.doesNotMatch(app.elements.modelStageList.innerHTML, /Kling|VideoHTTP|可灵/u);
});

test("模型设置里没有静态帧编译器、分镜终审、定向修订阶段；这些阶段的旧覆盖不随请求发出", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.openModelSettings();
  const html = app.elements.modelStageList.innerHTML;
  for (const stage of ["staticFrameCompiler", "animationPlanReview", "animationPlanRevision"]) {
    assert.doesNotMatch(html, new RegExp(`data-model-stage="${stage}"`, "u"), stage);
  }
  // 原来的三行标签。「命题定向修订」是候选阶段，仍在。
  assert.doesNotMatch(html, /<strong>(?:静态帧编译器|分镜终审|定向修订)<\/strong>/u);
  assert.match(html, /<strong>命题定向修订<\/strong>/u);
  assert.match(html, /data-model-stage="animationPlan"/u);

  app.state.modelOverrides = {
    staticFrameCompiler: { provider: "MiMo", model: "mimo-v2.5" },
    animationPlanReview: { provider: "MiMo", model: "mimo-v2.5" },
    fullStory: { provider: "MiMo", model: "mimo-v2.6-pro" }
  };
  assert.deepEqual(Object.keys(app.withModelOverrides({}).modelOverrides), ["fullStory"]);
  const stages = Object.keys(app.selectedStoryPackage().modelInfo.stages);
  for (const stage of ["staticFrameCompiler", "animationPlanReview", "animationPlanRevision"]) assert.equal(stages.includes(stage), false, stage);
});
