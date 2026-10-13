import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoRemovedVideoHttpConfig,
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  MINIMAX_H3_ENDPOINT,
  MINIMAX_VIDEO_MODELS,
  normalizeShotVideoGenerationMode,
  normalizeShotVideoProvider,
  SEEDANCE_VIDEO_MODELS,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "../src/shot-video-providers.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

// 2026-10-11 删除首尾帧模式后，Seedance 的方舟任务轮询、默认音画同生与终态处理由全能参考请求覆盖。
test("Seedance 2.0 全能参考走方舟任务轮询、默认音画同生和完整终态", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seedance-v2-interface-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/v3/contents/generations/tasks") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "seedance-task" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v3/contents/generations/tasks/seedance-task") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "seedance-task",
        status: "succeeded",
        content: {
          video_url: `http://127.0.0.1:${provider.address().port}/media/seedance.mp4`
        }
      }));
      return;
    }
    if (request.url === "/media/seedance.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("seedance video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const port = provider.address().port;
  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "character.png");
  const outputPath = path.join(root, "output.mp4");
  await Promise.all([
    fs.writeFile(imagePath, "character image bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${port}/api/v3/contents/generations/tasks`,
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      resolution: "720p"
    }))
  ]);

  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      durationSeconds: 6,
      artifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }]
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.model, "doubao-seedance-2-0-260128");
  assert.deepEqual(postedBody.content.map((item) => item.role || item.type), ["text", "reference_image"]);
  assert.equal(postedBody.content[0].text, "参考人物身份、动作节奏和声音氛围生成新镜头。");
  assert.equal(postedBody.content.some((item) => ["first_frame", "last_frame"].includes(item.role)), false);
  assert.equal(postedBody.generate_audio, true);
  assert.equal(postedBody.duration, 6);
  assert.equal(postedBody.resolution, "720p");
  assert.equal(postedBody.ratio, "9:16");
  assert.equal(Object.hasOwn(postedBody, "camera_fixed"), false);
  assert.equal(Object.hasOwn(postedBody, "frames"), false);
  assert.equal(Object.hasOwn(postedBody, "seed"), false);
  assert.equal(await fs.readFile(outputPath, "utf8"), "seedance video bytes");
  assert.equal(receipt.videoProvider, "Seedance");
  assert.equal(receipt.providerTaskId, "seedance-task");
  assert.equal(receipt.audioRequested, true);
});

test("Seedance 越界时长明确失败，不再静默 clamp 到 4 秒", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seedance-duration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/api/v3/contents/generations/tasks",
    apiKey: "seedance-key",
    providerPreset: "modelark_content_generation"
  }));
  const imagePath = path.join(root, "character.png");
  await fs.writeFile(imagePath, Buffer.from("image"));
  const artifacts = [{ path: imagePath, mediaType: "image", role: "reference_image" }];

  // 3 秒低于 Seedance 的 4 秒下限：旧行为悄悄补成 4 秒，现在必须明确失败。
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      durationSeconds: 3,
      artifacts
    }),
    output: path.join(root, "out.mp4"),
    root
  }), /Seedance duration 必须是 4–15 秒整数，不能静默改写时长。/u);

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      durationSeconds: 16,
      artifacts
    }),
    output: path.join(root, "out.mp4"),
    root
  }), /Seedance duration 必须是 4–15 秒整数，不能静默改写时长。/u);
});

test("Seedance 2.0 全能参考使用 reference_image/video/audio 且不混入首尾帧角色", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seedance-r2v-interface-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  const provider = http.createServer(async (request, response) => {
    if (request.url === "/media/r2v.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("seedance r2v video bytes");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ mediaUrl: `http://127.0.0.1:${provider.address().port}/media/r2v.mp4` }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "character.png");
  const videoPath = path.join(root, "motion.mp4");
  const audioPath = path.join(root, "rhythm.mp3");
  const tutorialStyleVideoPrompt = "温暖治愈的2.5D手绘动画质感，乡村小院被夕阳暖光照亮。狼耳少女跑到门口投入通知，随后拍一下布袋并转身伸懒腰。镜头先以中景跟随，投入通知时硬切信箱特写，最后切到逆光宽景。动作与摄影切换前后保持角色、服装、信箱和光线方向一致。";
  await Promise.all([
    fs.writeFile(imagePath, "image bytes"),
    fs.writeFile(videoPath, "video bytes"),
    fs.writeFile(audioPath, "audio bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${provider.address().port}/api/v3/contents/generations/tasks`,
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key"
    }))
  ]);

  await executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      aspectRatio: "16:9",
      prompt: tutorialStyleVideoPrompt,
      artifacts: [
        { path: imagePath, mediaType: "image", role: "reference_image" },
        { path: videoPath, mediaType: "video", role: "reference_video" },
        { path: audioPath, mediaType: "audio", role: "reference_audio" }
      ]
    }),
    output: path.join(root, "output.mp4"),
    root
  });

  assert.deepEqual(postedBody.content.map((item) => item.role || "text"), [
    "text",
    "reference_image",
    "reference_video",
    "reference_audio"
  ]);
  assert.equal(
    postedBody.content[0].text,
    tutorialStyleVideoPrompt,
    "镜头视频提示词必须作为一条完整提示词原样进入 Seedance"
  );
  assert.equal(postedBody.content.some((item) => ["first_frame", "last_frame"].includes(item.role)), false);
  assert.match(postedBody.content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.match(postedBody.content[2].video_url.url, /^data:video\/mp4;base64,/u);
  assert.match(postedBody.content[3].audio_url.url, /^data:audio\/mpeg;base64,/u);
  assert.equal(postedBody.ratio, "16:9");
});

test("Seedance expired/cancelled 都是终态，且当前官方三个 Model ID 均可选", async (t) => {
  assert.deepEqual(SEEDANCE_VIDEO_MODELS, [
    "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128",
    "doubao-seedance-2-0-mini-260615"
  ]);
  for (const model of SEEDANCE_VIDEO_MODELS) assert.equal(isShotVideoModelAllowed("Seedance", model), true);
  assert.equal(isShotVideoModelAllowed("Seedance", "doubao-seed-2-0-pro-260215"), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seedance-expired-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      for await (const _chunk of request) {
        // Drain the body before returning the task.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "expired-task" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "expired-task", status: "expired", error: { code: "Expired" } }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "character.png");
  await Promise.all([
    fs.writeFile(imagePath, "character image bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${provider.address().port}/api/v3/contents/generations/tasks`,
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000
    }))
  ]);

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      artifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }]
    }),
    output: path.join(root, "output.mp4"),
    root
  }), /供应商任务失败：expired/u);
});

// 2026-10-11 删除首尾帧模式后，MiniMax H3 的 V2 接口、Bearer 鉴权与 task.content.url 轮询由全能参考请求覆盖。
test("MiniMax H3 全能参考使用 V2 多模态接口、Bearer 鉴权和 task.content.url 轮询协议", async (t) => {
  assert.deepEqual(MINIMAX_VIDEO_MODELS, ["MiniMax-H3"]);
  assert.equal(isShotVideoModelAllowed("MiniMax", "MiniMax-H3"), true);
  assert.equal(isShotVideoModelAllowed("MiniMax", "MiniMax-Hailuo-2.3"), false);
  assert.deepEqual(shotVideoDefaultSetting({ MINIMAX_API_KEY: "minimax-key" }), {
    provider: "MiniMax",
    model: "MiniMax-H3"
  });
  const runtime = shotVideoRuntimeConfig("MiniMax", { MINIMAX_API_KEY: "minimax-key" });
  assert.equal(runtime.endpoint, MINIMAX_H3_ENDPOINT);
  assert.equal(runtime.providerPreset, "minimax_h3_video_generation");
  assert.equal(runtime.resolution, "2K");
  assert.equal(shotVideoProviderCatalog({ MINIMAX_API_KEY: "minimax-key" }).MiniMax.configured, true);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-interface-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  let pollRequestUrl = "";
  let authorization = "";
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v2/video_generation") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      authorization = request.headers.authorization || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "minimax-h3-task" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v2/query/video_generation/minimax-h3-task") {
      pollRequestUrl = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        task: {
          id: "minimax-h3-task",
          model: "MiniMax-H3",
          status: "succeeded",
          content: { url: `http://127.0.0.1:${provider.address().port}/media/minimax-h3.mp4` }
        }
      }));
      return;
    }
    if (request.url === "/media/minimax-h3.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("minimax h3 video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const port = provider.address().port;
  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "character.png");
  const outputPath = path.join(root, "output.mp4");
  await Promise.all([
    fs.writeFile(imagePath, "character image bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${port}/v2/video_generation`,
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      resolution: "2K",
      watermark: false
    }))
  ]);

  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "MiniMax",
      model: "MiniMax-H3",
      durationSeconds: 4,
      artifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }]
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.model, "MiniMax-H3");
  assert.deepEqual(postedBody.content.map((item) => item.role || item.type), ["text", "reference_image"]);
  assert.equal(postedBody.content[0].text, "参考人物身份、动作节奏和声音氛围生成新镜头。", "提示词原样发送，不追加任何约束句");
  assert.match(postedBody.content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.equal(postedBody.duration, 4);
  assert.equal(postedBody.resolution, "2K");
  assert.equal(postedBody.ratio, "9:16");
  assert.equal(postedBody.aigc_watermark, false);
  assert.equal(Object.hasOwn(postedBody, "negative_prompt"), false);
  assert.equal(authorization, "Bearer test-key");
  assert.equal(pollRequestUrl, "/v2/query/video_generation/minimax-h3-task");
  assert.equal(await fs.readFile(outputPath, "utf8"), "minimax h3 video bytes");
  assert.equal(receipt.videoProvider, "MiniMax");
  assert.equal(receipt.providerTaskId, "minimax-h3-task");
  assert.equal(receipt.audioRequested, true);
  assert.equal(receipt.audioOutputMode, "native");
  assert.equal(Object.hasOwn(receipt, "negativePromptDelivery"), false, "负面词体系已删除，回执不再带下发结果");
  assert.match(receipt.requestPreview.body.content[1].image_url.url, /^\[REDACTED_DATA_URL length=\d+\]$/u);
});

test("MiniMax H3 全能参考允许单张参考图并拒绝仅音频输入", async (t) => {
  assert.equal(isShotVideoGenerationModeSupported("Seedance", "all_reference"), true);
  assert.equal(isShotVideoGenerationModeSupported("MiniMax", "all_reference"), true);
  assert.equal(isShotVideoGenerationModeSupported("Kling", "all_reference"), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-r2v-interface-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  const provider = http.createServer(async (request, response) => {
    if (request.url === "/media/r2v.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("minimax r2v video bytes");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ mediaUrl: `http://127.0.0.1:${provider.address().port}/media/r2v.mp4` }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "character.png");
  const audioPath = path.join(root, "rhythm.mp3");
  await Promise.all([
    fs.writeFile(imagePath, "image bytes"),
    fs.writeFile(audioPath, "audio bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${provider.address().port}/v2/video_generation`,
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key"
    }))
  ]);

  await executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "MiniMax",
      model: "MiniMax-H3",
      aspectRatio: "16:9",
      artifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }]
    }),
    output: path.join(root, "output.mp4"),
    root
  });
  assert.deepEqual(postedBody.content.map((item) => item.role || "text"), ["text", "reference_image"]);
  assert.equal(postedBody.ratio, "16:9");

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: allReferenceVideoRequest({
      provider: "MiniMax",
      model: "MiniMax-H3",
      artifacts: [{ path: audioPath, mediaType: "audio", role: "reference_audio" }]
    }),
    output: path.join(root, "audio-only.mp4"),
    root
  }), /不能只输入音频/u);
});

// ---- 2026-10-11：镜头视频只剩 Seedance 与 MiniMax 的全能参考 ----
// 可灵（Kling v3 / v2.1）与自定义 VideoHTTP 只支持首尾帧，随首尾帧模式一起删除。
// 这里锁住「删掉的东西不会被悄悄接住」：默认兜底 Seedance，点名已删除的供应商、首尾帧能力都明确失败。

test("没有显式配置时镜头视频兜底 Seedance；目录与供应商名里不再有可灵和 VideoHTTP", () => {
  const seedanceDefault = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };
  assert.deepEqual(shotVideoDefaultSetting({}), seedanceDefault);
  // 原来只配了可灵的旧环境变量时兜底是可灵；这些变量已不再读取，兜底改为 Seedance。
  // （VIDEO_HTTP_CONFIG 不在此列：它还会改变 Seedance / MiniMax 的请求体，见下一条，明确失败。）
  assert.deepEqual(shotVideoDefaultSetting({ KLING_API_KEY: "kling-key", KLING_VIDEO_MODEL: "kling-v3" }), seedanceDefault);
  assert.deepEqual(Object.keys(shotVideoProviderCatalog({})), ["Seedance", "MiniMax"]);
  for (const name of ["Kling", "kling", "可灵", "VideoHTTP", "videohttp"]) assert.equal(normalizeShotVideoProvider(name), "", name);
  assert.equal(isShotVideoModelAllowed("Kling", "kling-v3"), false);
  assert.equal(isShotVideoModelAllowed("VideoHTTP", "custom-video-model"), false);
});

const REMOVED_PROVIDER_HINT = "可灵（Kling）与自定义 VideoHTTP 已于 2026-10-11 删除，请把 .env 里的 SHOT_VIDEO_PROVIDER 改成 Seedance 或 MiniMax";

test("SHOT_VIDEO_PROVIDER 还写着已删除的 Kling / VideoHTTP 时明确失败，不悄悄改用 Seedance", () => {
  for (const name of ["Kling", "VideoHTTP"]) {
    assert.throws(
      () => shotVideoDefaultSetting({ SHOT_VIDEO_PROVIDER: name }),
      (error) => error.message === `SHOT_VIDEO_PROVIDER=${name} 不受支持：${REMOVED_PROVIDER_HINT}。`
    );
    assert.throws(
      () => shotVideoRuntimeConfig(name, {}),
      new RegExp(`不支持镜头视频供应商「${name}」：只支持 Seedance 或 MiniMax`, "u")
    );
  }
  assert.deepEqual(shotVideoDefaultSetting({ SHOT_VIDEO_PROVIDER: "MiniMax" }), { provider: "MiniMax", model: "MiniMax-H3" });
});

// 起服务时 server.js 在模块顶层就算默认模型阶段（buildModelStages → shotVideoDefaultSetting），
// 所以 .env 里还写着已删除的供应商会让启动直接失败，与 DEFAULT_LLM_PROVIDER 指定的那家没配置时同规格。
// 在空的临时目录里起子进程：不读任何 .env、不继承凭据，端口预留，失败前不会开始监听。
async function startServerExpectingFailure(t, env) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "removed-shot-video-provider-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const reserved = http.createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await closeServer(reserved);
  let output = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      NODE_ENV: "test",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(directory, "production"),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timer);
  return { code, output };
}

test("服务启动：SHOT_VIDEO_PROVIDER 写着已删除的可灵 / VideoHTTP 时启动失败，并说明要改成 Seedance 或 MiniMax", async (t) => {
  for (const name of ["Kling", "VideoHTTP"]) {
    const { code, output } = await startServerExpectingFailure(t, { SHOT_VIDEO_PROVIDER: name });
    assert.notEqual(code, 0, output);
    assert.ok(output.includes(`SHOT_VIDEO_PROVIDER=${name} 不受支持：${REMOVED_PROVIDER_HINT}。`), output);
    assert.equal(output.includes("http://localhost:"), false, "失败前不得开始监听");
  }
});

// 原来没给 Seedance / MiniMax 单独配置文件时，worker 会改读 VIDEO_HTTP_CONFIG 并把它合并进这两家的请求
// （例如 watermark、generateAudio），没写 SHOT_VIDEO_PROVIDER 时默认供应商也会变成 VideoHTTP。
// 不再读取它之后，悄悄忽略会让请求体与配置不符，所以启动、默认值与 worker 都明确失败。
test("VIDEO_HTTP_CONFIG 还配着时明确失败：启动、默认值与 worker 都不悄悄忽略它", async (t) => {
  const message = /VIDEO_HTTP_CONFIG 只用于已删除的自定义 VideoHTTP 供应商，已不再读取：可灵（Kling）与自定义 VideoHTTP 已于 2026-10-11 删除。请从 \.env 删掉 VIDEO_HTTP_CONFIG；Seedance \/ MiniMax 的配置文件请写在 SEEDANCE_VIDEO_CONFIG \/ MINIMAX_VIDEO_CONFIG。/u;
  assert.doesNotThrow(() => assertNoRemovedVideoHttpConfig({}));
  assert.doesNotThrow(() => assertNoRemovedVideoHttpConfig({ VIDEO_HTTP_CONFIG: "  " }));
  for (const env of [
    { VIDEO_HTTP_CONFIG: "/custom/provider.json" },
    { VIDEO_HTTP_CONFIG: "/custom/provider.json", SHOT_VIDEO_PROVIDER: "Seedance", SEEDANCE_API_KEY: "k" },
    { VIDEO_HTTP_CONFIG: "/custom/provider.json", MINIMAX_API_KEY: "k" }
  ]) {
    assert.throws(() => shotVideoDefaultSetting(env), message, JSON.stringify(env));
  }

  const startup = await startServerExpectingFailure(t, { VIDEO_HTTP_CONFIG: "/custom/provider.json" });
  assert.notEqual(startup.code, 0, startup.output);
  assert.match(startup.output, message);

  // worker：只用环境变量配了 Seedance、没传 --config 时，原来会读 VIDEO_HTTP_CONFIG。现在在任何供应商调用之前失败。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-http-config-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let providerCalls = 0;
  const provider = http.createServer((request, response) => {
    providerCalls += 1;
    response.writeHead(500);
    response.end();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const legacyConfigPath = path.join(root, "videohttp.json");
  await fs.writeFile(legacyConfigPath, JSON.stringify({ watermark: true, generateAudio: false }));
  const imagePath = path.join(root, "reference.png");
  await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
  const saved = Object.fromEntries(["VIDEO_HTTP_CONFIG", "SEEDANCE_API_KEY", "SEEDANCE_VIDEO_ENDPOINT"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.VIDEO_HTTP_CONFIG = legacyConfigPath;
  process.env.SEEDANCE_API_KEY = "seedance-key";
  process.env.SEEDANCE_VIDEO_ENDPOINT = `http://127.0.0.1:${provider.address().port}/api/v3/contents/generations/tasks`;
  await assert.rejects(() => executeGenericHttpWorker({
    request: allReferenceVideoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      artifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }]
    }),
    output: path.join(root, "out.mp4"),
    root
  }), message);
  assert.equal(providerCalls, 0);
});

test("generationMode 只认全能参考：first_last_frame、空值与未知值都不回落成任何默认模式", () => {
  for (const value of ["all_reference", "all-reference", "reference", "r2v", " ALL_REFERENCE "]) {
    assert.equal(normalizeShotVideoGenerationMode(value), "all_reference", value);
  }
  for (const value of ["first_last_frame", "", undefined, null, "image_to_video"]) {
    assert.equal(normalizeShotVideoGenerationMode(value), null, String(value));
  }
  assert.equal(isShotVideoGenerationModeSupported("Seedance", "first_last_frame"), false);
  assert.equal(isShotVideoGenerationModeSupported("MiniMax", ""), false);
});

test("worker 不接受已删除的供应商、首尾帧能力与自定义请求体模板，在发请求之前就明确失败", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-removed-routes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let providerRequests = 0;
  const provider = http.createServer((request, response) => {
    providerRequests += 1;
    response.writeHead(500);
    response.end("不应收到任何请求");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));
  const base = `http://127.0.0.1:${provider.address().port}`;
  const imagePath = path.join(root, "character.png");
  const seedanceConfig = path.join(root, "seedance.json");
  const templateConfig = path.join(root, "template.json");
  const customConfig = path.join(root, "custom.json");
  await Promise.all([
    fs.writeFile(imagePath, "character image bytes"),
    fs.writeFile(seedanceConfig, JSON.stringify({
      videoEndpoint: `${base}/api/v3/contents/generations/tasks`,
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key"
    })),
    fs.writeFile(templateConfig, JSON.stringify({
      videoEndpoint: `${base}/api/v3/contents/generations/tasks`,
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key",
      bodyTemplate: { prompt: "{{prompt}}" }
    })),
    // 原来会当成自定义 VideoHTTP 的配置：同名 /v2/video_generation 路径但不在 MiniMax 官方域名下。
    fs.writeFile(customConfig, JSON.stringify({
      videoEndpoint: `${base}/v2/video_generation`,
      videoModel: "custom-video-model"
    }))
  ]);
  const artifacts = [{ path: imagePath, mediaType: "image", role: "reference_image" }];
  const run = (config, request) => executeGenericHttpWorker({
    config,
    request,
    output: path.join(root, "output.mp4"),
    root
  });

  for (const name of ["Kling", "VideoHTTP"]) {
    await assert.rejects(
      () => run(seedanceConfig, allReferenceVideoRequest({ provider: name, model: "kling-v3", artifacts })),
      new RegExp(`不支持镜头视频供应商「${name}」：worker 只支持 Seedance 或 MiniMax`, "u")
    );
  }
  await assert.rejects(
    () => run(seedanceConfig, {
      ...allReferenceVideoRequest({ provider: "Seedance", model: "doubao-seedance-2-0-260128", artifacts }),
      capability: "first_last_frame_video_generation"
    }),
    /worker 只支持 all_reference_video_generation（Seedance 2\.0 \/ MiniMax H3 全能参考），本次请求为 first_last_frame_video_generation；首尾帧等其他能力已删除/u
  );
  await assert.rejects(
    () => run(templateConfig, allReferenceVideoRequest({ provider: "Seedance", model: "doubao-seedance-2-0-260128", artifacts })),
    /bodyTemplate \/ bodyTemplates 只用于已删除的自定义 VideoHTTP 供应商/u
  );
  await assert.rejects(
    () => run(customConfig, { ...allReferenceVideoRequest({ provider: "", model: "", artifacts }) }),
    /worker 请求没有指定供应商，配置里的 videoModel \/ providerPreset 也认不出是 Seedance 还是 MiniMax/u
  );
  assert.equal(providerRequests, 0, "被拒的请求一个都没有发到供应商");
});

function allReferenceVideoRequest({
  provider,
  model,
  artifacts,
  aspectRatio = "9:16",
  durationSeconds = 5,
  prompt = "参考人物身份、动作节奏和声音氛围生成新镜头。"
}) {
  return {
    taskId: `${provider}-r2v-test`,
    capability: "all_reference_video_generation",
    outputKey: "preview.r2v-test",
    provider,
    model,
    prompt,
    inputArtifacts: artifacts.map((artifact, index) => ({
      outputKey: `references.${index + 1}`,
      status: "done",
      ...artifact
    })),
    parameters: {
      aspectRatio,
      durationSeconds,
      generationMode: "all_reference"
    }
  };
}
