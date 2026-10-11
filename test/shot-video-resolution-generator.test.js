import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateShotVideo, parseVideoProbeMetadata, ShotVideoConfigError } from "../src/shot-video-generator.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { pinResolutionEnv } from "./helpers/fake-video-providers.js";

// 生成器（2026-10-10）：在建工作目录、调用供应商之前再核对一次分辨率；只有用户明确选了才写进发给 worker
// 的请求；每条候选记下实际发出的分辨率（取自 worker 回执）与 ffprobe 实测宽高。

const NO_MUSIC_SENTENCE = "全片无背景音乐，只保留现场环境声与动作声。";
const imageAsset = {
  mediaType: "image",
  name: "ref.png",
  dataUrl: `data:image/png;base64,${Buffer.from("ref").toString("base64")}`,
  source: "character_reference",
  sourceCharacterName: "阿岚"
};

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-resolution-generator-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// 假 Seedance：记下 worker 实际 POST 的请求体，直接返回视频地址。
async function fakeSeedance(t) {
  const posted = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/media/out.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(Buffer.alloc(600, 7));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ mediaUrl: `http://127.0.0.1:${server.address().port}/media/out.mp4` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { posted, endpoint: `http://127.0.0.1:${server.address().port}/api/v3/contents/generations/tasks` };
}

async function seedanceConfig(root, endpoint, extra = {}) {
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: endpoint,
    providerPreset: "modelark_content_generation",
    videoModel: extra.videoModel || "doubao-seedance-2-0-260128",
    apiKey: "test-key",
    ...extra
  }));
  return configPath;
}

// 真正跑一遍 worker（进程内），把它的回执写到生成器期待的位置；同时记下生成器写给 worker 的请求。
function realWorker(seen) {
  return async ({ config, request, output, receipt, root }) => {
    const parsed = JSON.parse(await fs.readFile(request, "utf8"));
    seen.push(parsed);
    const result = await executeGenericHttpWorker({ config, request: parsed, output, root });
    await fs.writeFile(receipt, JSON.stringify(result));
  };
}

const seedanceShot = { shotId: "A01", durationSeconds: 5, videoPrompt: `阿岚抱起小猫。${NO_MUSIC_SENTENCE}` };

test("明确选了分辨率：写进发给 worker 的请求，候选与结果记下实际发出的值和实测宽高", async (t) => {
  pinResolutionEnv(t, {});
  const root = await workspace(t);
  const provider = await fakeSeedance(t);
  const seen = [];
  const result = await generateShotVideo({
    outputRoot: path.join(root, "generated"),
    publicBasePath: "/generated-videos",
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    aspectRatio: "16:9",
    resolution: "1080p",
    configPath: await seedanceConfig(root, provider.endpoint),
    referenceAssets: [imageAsset],
    workerRunner: realWorker(seen),
    videoOutputProbe: async () => ({ durationSeconds: 5.04, width: 1920, height: 1080 }),
    shot: seedanceShot
  });
  assert.equal(seen[0].parameters.resolution, "1080p");
  assert.equal(provider.posted[0].resolution, "1080p");
  const video = result.videos[0];
  assert.equal(video.resolution, "1080p");
  assert.equal(video.resolution, video.receipt.requestPreview.body.resolution, "记录的就是实际请求体里的值");
  assert.equal(video.measuredWidth, 1920);
  assert.equal(video.measuredHeight, 1080);
  assert.equal(video.measuredDurationSeconds, 5.04);
  assert.equal(result.resolution, "1080p");
});

test("没选分辨率：发给 worker 的请求里没有这个键（与加选项之前逐字相同），由 worker 按配置决定并如实记录", async (t) => {
  pinResolutionEnv(t, {});
  const root = await workspace(t);
  const provider = await fakeSeedance(t);
  const seen = [];
  const result = await generateShotVideo({
    outputRoot: path.join(root, "generated"),
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    configPath: await seedanceConfig(root, provider.endpoint),
    referenceAssets: [imageAsset],
    workerRunner: realWorker(seen),
    videoOutputProbe: async () => 5,
    shot: seedanceShot
  });
  assert.equal(Object.hasOwn(seen[0].parameters, "resolution"), false);
  assert.equal(provider.posted[0].resolution, "720p");
  assert.equal(result.videos[0].resolution, "720p");
  assert.equal(result.videos[0].measuredWidth, 0, "探针只给了时长：宽高记 0，表示没测到");
  assert.equal(result.videos[0].measuredHeight, 0);
});

test("不合法的分辨率在调用 worker 之前就被拒：不在清单里、配置的默认值对不上", async (t) => {
  pinResolutionEnv(t, {});
  const root = await workspace(t);
  let workerCalls = 0;
  const workerRunner = async () => { workerCalls += 1; };
  const base = {
    outputRoot: path.join(root, "generated"),
    generationMode: "all_reference",
    referenceAssets: [imageAsset],
    workerRunner,
    videoOutputProbe: async () => 5,
    shot: seedanceShot
  };
  await assert.rejects(generateShotVideo({
    ...base,
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-fast-260128",
    resolution: "1080p",
    configPath: await seedanceConfig(root, "https://provider.invalid/api", { videoModel: "doubao-seedance-2-0-fast-260128" })
  }), (error) => error.code === "SHOT_VIDEO_RESOLUTION_INVALID");
  await assert.rejects(generateShotVideo({
    ...base,
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-fast-260128",
    configPath: await seedanceConfig(root, "https://provider.invalid/api", { videoModel: "doubao-seedance-2-0-fast-260128", resolution: "1080p" })
  }), (error) => error.code === "SHOT_VIDEO_RESOLUTION_DEFAULT_INVALID" && /供应商配置文件里的 resolution=1080p/u.test(error.message));
  assert.equal(workerCalls, 0, "两种都在调用供应商之前拒绝");
});

// 「模型没有分辨率参数」原来由可灵 v2.1 触发；可灵与自定义 VideoHTTP 已于 2026-10-11 删除，
// 现在点名它们在分辨率校验之前就明确失败，不悄悄改用 Seedance / MiniMax 去生成。
test("点名已删除的可灵或 VideoHTTP：在调用 worker 之前明确失败，不改用默认供应商", async (t) => {
  pinResolutionEnv(t, {});
  const root = await workspace(t);
  let workerCalls = 0;
  for (const videoProvider of ["Kling", "VideoHTTP"]) {
    await assert.rejects(generateShotVideo({
      outputRoot: path.join(root, "generated"),
      videoProvider,
      videoModel: "kling-v2-1",
      generationMode: "all_reference",
      resolution: "720p",
      configPath: await seedanceConfig(root, "https://provider.invalid/api"),
      referenceAssets: [imageAsset],
      workerRunner: async () => { workerCalls += 1; },
      videoOutputProbe: async () => 5,
      shot: seedanceShot
    }), (error) => error instanceof ShotVideoConfigError
      && error.message === `不支持镜头视频供应商“${videoProvider}”：只支持 Seedance 或 MiniMax。`);
  }
  assert.equal(workerCalls, 0);
});

test("ffprobe 输出解析：取时长与宽高；宽高缺了记 0 不判失败；没有视频流或时长无效仍然失败", () => {
  assert.deepEqual(parseVideoProbeMetadata({
    format: { duration: "5.20" },
    streams: [{ codec_type: "audio", duration: "5.2" }, { codec_type: "video", duration: "5.167", width: 1280, height: 720 }]
  }), { durationSeconds: 5.167, width: 1280, height: 720 });
  assert.deepEqual(parseVideoProbeMetadata({ format: { duration: "4.0" }, streams: [{ codec_type: "video" }] }),
    { durationSeconds: 4, width: 0, height: 0 });
  assert.throws(() => parseVideoProbeMetadata({ streams: [{ codec_type: "audio", duration: "5" }] }), /缺少视频流/u);
  assert.throws(() => parseVideoProbeMetadata({ streams: [{ codec_type: "video", width: 1280, height: 720 }] }), /视频时长无效/u);
});
