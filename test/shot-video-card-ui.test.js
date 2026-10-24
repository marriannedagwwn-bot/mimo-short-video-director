import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 分镜卡上的镜头视频（2026-10-24）：生成完直接在卡片里播放；同一次生成的多条候选可以在卡片上切换。
// 10-11 删旧版分镜时原来放播放器的那一格一起删了，4.0 卡片只剩连续性回执，视频只在弹窗里看得到。

function readyItem(selectedIndex = 1) {
  return {
    status: "ready",
    selectedIndex,
    result: {
      provider: "Seedance", model: "doubao-seedance-2-0-260128", generatedAt: "2026-10-24T15:39:16Z", selectedIndex,
      continuityReferenceReceipt: { mode: "previous_shot_frames", sourceShotId: "A01", frameCount: 5 },
      videos: [
        { outputUrl: "/generated-videos/a.mp4", resolution: "720p", measuredWidth: 1280, measuredHeight: 720, measuredDurationSeconds: 6.041667 },
        { outputUrl: "/generated-videos/b.mp4", resolution: "720p", measuredDurationSeconds: 8 },
        { outputUrl: "" }
      ]
    }
  };
}

test("生成完的视频放在分镜卡里：每条候选一个播放器，写明模型、分辨率、时长；当前那条标出来、按钮不可点", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  assert.equal(app.renderShotVideoResult("A01"), "<p>本镜视频尚未生成。</p>");
  app.setShotVideoStateItem("A01", readyItem(1), "V2");
  const html = app.renderShotVideoResult("A01");
  assert.equal((html.match(/<video /g) || []).length, 2, "没有地址的候选不出卡");
  assert.match(html, /<video src="\/generated-videos\/a\.mp4" controls playsinline preload="metadata">/);
  assert.match(html, /候选 1 · Seedance 2\.0 标准版 · 720p（实测 1280×720） · 6\.0 秒 · \d{2}-\d{2} \d{2}:\d{2}</);
  assert.match(html, /shot-video-candidate selected">\s*<video src="\/generated-videos\/b\.mp4"/, "当前那条高亮");
  assert.match(html, /data-candidate-index="1" disabled>已设为当前镜头视频/);
  assert.match(html, /data-candidate-index="0">设为当前镜头视频/);
  assert.match(html, /连续性参考：A01 均匀抽帧，共 5 张普通参考图/);
  assert.match(html, /--shot-video-aspect/, "播放器画幅跟随分镜画幅");
});

test("弹窗与分镜卡用同一份候选卡片", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.setShotVideoStateItem("A01", readyItem(0), "V2");
  app.state.shotVideoGeneration.open = true;
  app.state.shotVideoGeneration.shotId = "A01";
  app.renderShotVideoModalResults();
  const modal = app.elements.shotVideoResults.innerHTML;
  const card = app.renderShotVideoResult("A01");
  assert.ok(card.includes(modal), "卡片里的候选与弹窗里的逐字相同");
});

test("候选说明里的型号写短名，生成时间写本地时间", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  const item = readyItem(0);
  item.result.videos = [
    { outputUrl: "/a.mp4", provider: "Seedance", model: "doubao-seedance-2-0-fast-260128", generatedAt: "not-a-date" },
    { outputUrl: "/b.mp4", provider: "MiniMax", model: "MiniMax-H3" }
  ];
  app.setShotVideoStateItem("A01", item, "V2");
  const html = app.renderShotVideoResult("A01");
  assert.match(html, /候选 1 · Seedance 2\.0 fast · not-a-date</);
  assert.match(html, /候选 2 · MiniMax H3 · \d{2}-\d{2} \d{2}:\d{2}</);
});

const HISTORY = {
  A01: {
    currentRevision: "shotVideo-V2-A01-r2",
    dependents: ["A02"],
    versions: [
      { revision: "shotVideo-V2-A01-r1", createdAt: "2026-10-24T15:24:35Z", selectedIndex: 0, continuitySourceShotId: "",
        videos: [{ index: 0, outputUrl: "/old-a.mp4", provider: "MiniMax", model: "MiniMax-H3", resolution: "768P", measuredDurationSeconds: 6.1 }],
        restorable: true, reason: "" },
      { revision: "shotVideo-V2-A01-r0", createdAt: "2026-10-24T15:10:00Z", selectedIndex: 1, continuitySourceShotId: "A00",
        videos: [{ index: 1, outputUrl: "/old-b.mp4", provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" }],
        restorable: false, reason: "这一版用了 A00 当时那条视频的抽帧，A00 后来换过视频，接不上了，不能换回。" }
    ]
  }
};

test("之前生成的版本：折叠在卡片下面，每版能播放；能换回的给按钮，不能换回的写明原因", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.setShotVideoStateItem("A01", readyItem(0), "V2");
  assert.doesNotMatch(app.renderShotVideoResult("A01"), /shot-video-history/, "还没读回历史时不显示");
  app.state.shotVideoHistory = { runId: "run", variantId: "V2", shots: HISTORY };
  const html = app.renderShotVideoResult("A01");
  assert.match(html, /<details class="shot-video-history" data-shot-video-history="A01">\s*<summary>之前生成的版本（2）<\/summary>/);
  assert.match(html, /<video src="\/old-a\.mp4" controls playsinline preload="metadata">/);
  assert.match(html, /\d{2}-\d{2} \d{2}:\d{2} 生成 · MiniMax H3</);
  assert.match(html, /data-restore-shot-video="A01" data-revision="shotVideo-V2-A01-r1">换回这一版/);
  assert.match(html, /Seedance 2\.0 fast · 用了 A00 的抽帧/);
  assert.match(html, /shot-video-history-blocked">这一版用了 A00 当时那条视频的抽帧/);
  assert.equal((html.match(/data-restore-shot-video/g) || []).length, 1);
  app.state.shotVideoHistoryOpen.A01 = true;
  assert.match(app.renderShotVideoResult("A01"), /data-shot-video-history="A01" open>/, "重画后保持展开");
  app.state.shotVideoHistory = { runId: "another-run", variantId: "V2", shots: HISTORY };
  assert.doesNotMatch(app.renderShotVideoResult("A01"), /shot-video-history/, "别的 Run 的历史不显示");
});

test("换回：先说清会作废哪一镜；不同意就不发请求；同意后按服务端结果更新当前视频并作废下一镜", async () => {
  const requests = [];
  let confirmText = "";
  let confirmAnswer = false;
  const restoredContent = { status: "ready", selectedIndex: 0, result: { provider: "MiniMax", model: "MiniMax-H3", videos: [{ outputUrl: "/old-a.mp4" }] } };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url === "/api/production/shot-video/restore") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {
        lineage: { artifactId: "shotVideo:V2:A01", artifactType: "shotVideo", revision: "shotVideo-V2-A01-r3", contentDigest: "d".repeat(64), dependencies: [], status: "current", createdAt: "2026-10-24T16:00:00Z" },
        staleArtifactIds: ["shotVideo:V2:A02"], content: restoredContent, restoredFrom: "shotVideo-V2-A01-r1" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { variantId: "V2", shots: {} } }) };
  };
  const app = await loadAppUi({ story: true, plan: true, fetch, confirm: (text) => { confirmText = text; return confirmAnswer; } });
  app.state.production.artifacts["shotVideo:V2:A01"] = { artifactId: "shotVideo:V2:A01", revision: "shotVideo-V2-A01-r2", status: "current" };
  app.state.production.artifacts["shotVideo:V2:A02"] = { artifactId: "shotVideo:V2:A02", revision: "shotVideo-V2-A02-r1", status: "current" };
  app.setShotVideoStateItem("A01", readyItem(0), "V2");
  app.setShotVideoStateItem("A02", readyItem(0), "V2");
  app.state.shotVideoHistory = { runId: "run", variantId: "V2", shots: HISTORY };

  await app.restoreShotVideoVersion("A01", "shotVideo-V2-A01-r1");
  assert.match(confirmText, /换回这一版后，A02 用这一镜抽帧生成的视频会失效/);
  assert.equal(requests.filter((item) => item.url === "/api/production/shot-video/restore").length, 0, "不同意就不发请求");

  confirmAnswer = true;
  await app.restoreShotVideoVersion("A01", "shotVideo-V2-A01-r1");
  const restore = requests.find((item) => item.url === "/api/production/shot-video/restore");
  assert.equal(restore.body.revision, "shotVideo-V2-A01-r1");
  assert.equal(restore.body.expectedCurrentRevision, "shotVideo-V2-A01-r2", "带上期望的当前版本，防止覆盖别人刚换的");
  assert.equal(restore.body.artifactId, "shotVideo:V2:A01");
  assert.ok(restore.body.requestId);
  assert.equal("content" in restore.body, false, "不发旧内容，服务端自己从 Run 读");
  assert.equal(app.shotVideoStateItem("A01").result.videos[0].outputUrl, "/old-a.mp4");
  assert.equal(app.state.production.artifacts["shotVideo:V2:A01"].revision, "shotVideo-V2-A01-r3");
  assert.equal(app.state.production.artifacts["shotVideo:V2:A02"].status, "stale");
  assert.equal(app.shotVideoStateItem("A02"), null, "作废的下一镜结果从页面上去掉");
});
