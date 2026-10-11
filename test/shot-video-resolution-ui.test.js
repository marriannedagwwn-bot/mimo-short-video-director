import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 镜头视频弹窗的「生成分辨率」（2026-10-10）：只列当前视频模型支持的值，默认值来自 /api/health；
// 每个模型各记一份上次的选择，只存这个标签页的 sessionStorage；选回默认值就不记、请求里不带；
// 不碰 4.0 分镜的单镜提示词。（批量生成与可灵已于 2026-10-11 删除，相应断言一并去掉。）

// 页面代码跑在沙箱里，建出来的对象原型不同；比较前先转成本测试里的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

const PROVIDERS = {
  Seedance: { resolutionDefaults: {
    "doubao-seedance-2-0-260128": { value: "720p", source: "env", error: "" },
    "doubao-seedance-2-0-fast-260128": { value: "720p", source: "env", error: "" },
    "doubao-seedance-2-0-mini-260615": { value: "720p", source: "env", error: "" }
  } },
  MiniMax: { resolutionDefaults: { "MiniMax-H3": { value: "768P", source: "env", error: "" } } }
};
const SEEDANCE = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };
const SEEDANCE_FAST = { provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" };

function recordingFetch() {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests };
}

async function resolutionApp(options = {}) {
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const app = await loadAppUi({ story: true, plan: true, sessionStorage, localStorage, ...options });
  app.state.providers = structuredClone(PROVIDERS);
  app.state.modelOverrides = { shotVideo: SEEDANCE };
  app.state.production.artifacts = {
    "animationPlan:V2": { artifactId: "animationPlan:V2", status: "current", revision: "animationPlan-V2-r1", contentDigest: "d".repeat(64), mediaNamespace: "project/run/animationPlan-V2-r1" }
  };
  return { app, sessionStorage, localStorage };
}

test("下拉框只列当前视频模型支持的分辨率，标出默认值", async () => {
  const { app } = await resolutionApp();
  app.renderShotVideoResolutionControl();
  assert.equal(app.elements.shotVideoResolution.innerHTML,
    '<option value="480p">480p</option><option value="720p" selected>720p（默认）</option><option value="1080p">1080p</option>');
  assert.equal(app.elements.shotVideoResolution.value, "720p");
  assert.equal(app.elements.shotVideoResolutionField.className.includes("hidden"), false);
  assert.match(app.elements.shotVideoResolutionHint.textContent, /分辨率越高，供应商收费越高、生成越慢/u);

  app.state.modelOverrides = { shotVideo: SEEDANCE_FAST };
  app.renderShotVideoResolutionControl();
  assert.doesNotMatch(app.elements.shotVideoResolution.innerHTML, /1080p/u, "fast 只到 720p");

  app.state.modelOverrides = { shotVideo: { provider: "MiniMax", model: "MiniMax-H3" } };
  app.renderShotVideoResolutionControl();
  assert.equal(app.elements.shotVideoResolution.innerHTML,
    '<option value="768P" selected>768P（默认）</option><option value="2K">2K</option>');
});

test("选择按模型分开、只记在 sessionStorage；切到 fast 不继承 1080p；选回默认值就不记、请求里也不带", async () => {
  const { app, sessionStorage, localStorage } = await resolutionApp();
  app.renderShotVideoResolutionControl();
  app.elements.shotVideoResolution.value = "1080p";
  app.handleShotVideoResolutionChange();
  assert.deepEqual(JSON.parse(sessionStorage.map.get("directorShotVideoResolutions")), { "Seedance:doubao-seedance-2-0-260128": "1080p" });
  assert.equal(localStorage.map.size, 0, "不长期保存");
  assert.deepEqual(plain(app.shotVideoResolutionRequestFields()), { resolution: "1080p" });

  app.state.modelOverrides = { shotVideo: SEEDANCE_FAST };
  assert.equal(app.shotVideoResolutionState().selected, "720p");
  assert.deepEqual(plain(app.shotVideoResolutionRequestFields()), {});
  app.state.modelOverrides = { shotVideo: SEEDANCE };
  assert.deepEqual(plain(app.shotVideoResolutionRequestFields()), { resolution: "1080p" }, "切回来还记得");

  app.renderShotVideoResolutionControl();
  app.elements.shotVideoResolution.value = "720p";
  app.handleShotVideoResolutionChange();
  assert.deepEqual(JSON.parse(sessionStorage.map.get("directorShotVideoResolutions")), {});
  assert.deepEqual(plain(app.shotVideoResolutionRequestFields()), {});
});

test("服务端默认值对不上这个模型：要求先选一个；选了合法值就能生成", async () => {
  const { app } = await resolutionApp();
  app.state.providers.Seedance.resolutionDefaults["doubao-seedance-2-0-fast-260128"] = {
    value: "", source: "env", error: "SEEDANCE_VIDEO_RESOLUTION=1080p 不适用于 doubao-seedance-2-0-fast-260128（只支持 480p / 720p）"
  };
  app.state.modelOverrides = { shotVideo: SEEDANCE_FAST };
  const state = app.renderShotVideoResolutionControl();
  assert.equal(state.ready, false);
  assert.match(app.elements.shotVideoResolution.innerHTML, /^<option value="" disabled selected>请选择分辨率<\/option>/u);
  assert.match(app.elements.shotVideoResolutionHint.className, /warn/u);
  assert.match(app.elements.shotVideoResolutionHint.textContent, /不适用于 doubao-seedance-2-0-fast-260128/u);

  app.elements.shotVideoResolution.value = "480p";
  app.handleShotVideoResolutionChange();
  assert.equal(app.shotVideoResolutionState().ready, true);
  assert.deepEqual(plain(app.shotVideoResolutionRequestFields()), { resolution: "480p" });
});

test("单镜请求体带上选的分辨率；没选时不带这个键", async () => {
  const network = recordingFetch();
  const { app } = await resolutionApp({ fetch: network.fetch });
  app.renderShotVideoResolutionControl();
  app.elements.shotVideoResolution.value = "1080p";
  app.handleShotVideoResolutionChange();

  const shotId = app.fixture.animationPlan.shotPlan[0].shotId;
  Object.assign(app.state.shotVideoGeneration, {
    includePreviousShotFrames: false,
    includeCharacterReferences: false,
    referenceAssets: [{ id: "upload-1", mediaType: "image", name: "ref.png", dataUrl: "data:image/png;base64,AA==", sizeBytes: 3, durationSeconds: 0, source: "upload" }]
  });
  await app.generateShotVideo(shotId, "阿岚抱起小猫。", { count: 1 });
  const single = network.requests.find((request) => request.url === "/api/tasks/create" && request.body.kind === "shotVideo");
  assert.ok(single, "单镜建任务的请求发出去了");
  assert.equal(single.body.input.resolution, "1080p");
  assert.equal(single.body.input.generationMode, "all_reference", "镜头视频只剩全能参考一种模式");

  app.elements.shotVideoResolution.value = "720p";
  app.handleShotVideoResolutionChange();
  network.requests.length = 0;
  await app.generateShotVideo(shotId, "阿岚抱起小猫。", { count: 1 });
  const unchosen = network.requests.find((request) => request.url === "/api/tasks/create" && request.body.kind === "shotVideo");
  assert.equal(Object.hasOwn(unchosen.body.input, "resolution"), false);
});

test("生成中锁住下拉框；改分辨率不改变 4.0 单镜提示词用的视频模型设置", async () => {
  const { app } = await resolutionApp();
  const settingBefore = JSON.stringify(app.shotVideoSetting());
  app.renderShotVideoResolutionControl();
  app.elements.shotVideoResolution.value = "1080p";
  app.handleShotVideoResolutionChange();
  assert.equal(JSON.stringify(app.shotVideoSetting()), settingBefore, "提示词缓存键只看供应商和模型，分辨率不进去");
  app.setShotVideoGeneratorRunning(true);
  assert.equal(app.elements.shotVideoResolution.disabled, true);
  app.setShotVideoGeneratorRunning(false);
  assert.equal(app.elements.shotVideoResolution.disabled, false);
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const promptKey = source.slice(source.indexOf("function currentStoryboardPromptKey"), source.indexOf("function currentStoryboardPromptKey") + 400);
  assert.doesNotMatch(promptKey, /resolution/u);
  assert.doesNotMatch(source, /localStorage\.setItem\(SHOT_VIDEO_RESOLUTION_STORAGE_KEY/u);
});

test("候选与任务状态显示分辨率：请求的值与实测宽高并列", async () => {
  const { app } = await resolutionApp();
  assert.equal(app.shotVideoResolutionText({ resolution: "1080p", measuredWidth: 1920, measuredHeight: 1080 }), "1080p（实测 1920×1080）");
  assert.equal(app.shotVideoResolutionText({ resolution: "2K", measuredWidth: 0, measuredHeight: 0 }), "2K");
  assert.equal(app.shotVideoResolutionText({ measuredWidth: 1280, measuredHeight: 720 }), "实测 1280×720");
  assert.equal(app.shotVideoResolutionText({}), "");
  const view = app.taskUiView({ taskId: "t1", kind: "shotVideo", status: "running", targetArtifactIds: ["shotVideo:V2:A01"],
    modelSnapshot: { shotVideo: { ...SEEDANCE, resolution: "1080p" } }, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:01Z" });
  assert.match(view.message, /· 1080p/u);
});
