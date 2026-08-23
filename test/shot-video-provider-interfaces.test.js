import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  KLING_CN_V3_ENDPOINT,
  MINIMAX_H3_ENDPOINT,
  MINIMAX_VIDEO_MODELS,
  SEEDANCE_VIDEO_MODELS,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "../src/shot-video-providers.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

test("Kling 3.0 国内官方 API 使用新版首尾帧、Bearer API Key 和 tasks 轮询协议", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kling-v3-interface-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  let pollRequestUrl = "";
  let authorization = "";
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/image-to-video/kling-3.0") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      authorization = request.headers.authorization || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 0,
        data: { id: "kling-v3-task", status: "submitted" }
      }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/tasks?")) {
      pollRequestUrl = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        code: 0,
        data: [{
          id: "kling-v3-task",
          status: "succeeded",
          outputs: [{
            type: "video",
            url: `http://127.0.0.1:${provider.address().port}/media/kling-v3.mp4`
          }]
        }]
      }));
      return;
    }
    if (request.url === "/media/kling-v3.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("kling v3 video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const port = provider.address().port;
  const configPath = path.join(root, "provider.json");
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  const outputPath = path.join(root, "output.mp4");
  const startFrameBytes = Buffer.alloc(300, 1);
  await Promise.all([
    fs.writeFile(startPath, startFrameBytes),
    fs.writeFile(endPath, "end image bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${port}/image-to-video/kling-3.0`,
      providerPreset: "kling_3_0_image_to_video",
      videoModel: "kling-v3",
      apiKey: "test-key",
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
      resolution: "1080p",
      audio: "native",
      multiShot: false
    }))
  ]);

  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request: videoRequest({
      provider: "Kling",
      model: "kling-v3",
      startPath,
      endPath,
      durationSeconds: 12
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.contents[0].type, "prompt");
  assert.equal(postedBody.contents[1].type, "first_frame");
  assert.equal(postedBody.contents[2].type, "last_frame");
  assert.equal(postedBody.contents[1].url, startFrameBytes.toString("base64"));
  assert.deepEqual(postedBody.settings, {
    multi_shot: false,
    audio: "native",
    resolution: "1080p",
    duration: 12
  });
  assert.deepEqual(postedBody.options, { watermark_info: { enabled: false } });
  assert.equal(Object.hasOwn(postedBody, "model_name"), false);
  assert.equal(Object.hasOwn(postedBody, "negative_prompt"), false);
  assert.equal(Object.hasOwn(postedBody, "aspect_ratio"), false);
  assert.equal(authorization, "Bearer test-key");
  assert.equal(pollRequestUrl, "/tasks?task_ids=kling-v3-task");
  assert.equal(await fs.readFile(outputPath, "utf8"), "kling v3 video bytes");
  assert.equal(receipt.videoProvider, "Kling");
  assert.equal(receipt.providerTaskId, "kling-v3-task");
  assert.equal(receipt.audioRequested, true);
  assert.equal(receipt.negativePromptDelivery.appliedMode, "not_supported");
  assert.match(receipt.requestPreview.body.contents[1].url, /^\[REDACTED_BASE64 length=\d+\]$/u);
});

test("Seedance 2.0 使用方舟首尾帧角色、默认音画同生和完整终态", async (t) => {
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
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  const outputPath = path.join(root, "output.mp4");
  await Promise.all([
    fs.writeFile(startPath, "start image bytes"),
    fs.writeFile(endPath, "end image bytes"),
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
    request: videoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      startPath,
      endPath,
      durationSeconds: 6
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.model, "doubao-seedance-2-0-260128");
  assert.equal(postedBody.content[0].type, "text");
  assert.equal(postedBody.content[1].role, "first_frame");
  assert.equal(postedBody.content[2].role, "last_frame");
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
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  await Promise.all([
    fs.writeFile(startPath, Buffer.from("start")),
    fs.writeFile(endPath, Buffer.from("end"))
  ]);

  // 3 秒低于 Seedance 的 4 秒下限：旧行为悄悄补成 4 秒，现在必须明确失败。
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: videoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      startPath,
      endPath,
      durationSeconds: 3
    }),
    output: path.join(root, "out.mp4"),
    root
  }), /Seedance duration 必须是 4–15 秒整数，不能静默改写时长。/u);

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: videoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      startPath,
      endPath,
      durationSeconds: 16
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
    "direct_shot.videoPrompt 必须作为一条完整提示词原样进入 Seedance"
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
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  await Promise.all([
    fs.writeFile(startPath, "start image bytes"),
    fs.writeFile(endPath, "end image bytes"),
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
    request: videoRequest({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128",
      startPath,
      endPath
    }),
    output: path.join(root, "output.mp4"),
    root
  }), /供应商任务失败：expired/u);
});

test("MiniMax H3 使用 V2 多模态首尾帧、Bearer 鉴权和 task.content.url 轮询协议", async (t) => {
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
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  const outputPath = path.join(root, "output.mp4");
  await Promise.all([
    fs.writeFile(startPath, "start image bytes"),
    fs.writeFile(endPath, "end image bytes"),
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

  const request = videoRequest({
    provider: "MiniMax",
    model: "MiniMax-H3",
    startPath,
    endPath,
    durationSeconds: 4
  });
  request.negativePromptEntries = [
    {
      text: "猫耳",
      enabled: true,
      reasonCode: "explicit_identity_conflict",
      priority: "high"
    },
    {
      text: "不要出现额外人物",
      enabled: true,
      reasonCode: "identity_conflict",
      priority: "medium"
    }
  ];
  request.compiledNegativePrompt = "猫耳；不要出现额外人物";
  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request,
    output: outputPath,
    root
  });

  assert.equal(postedBody.model, "MiniMax-H3");
  assert.equal(postedBody.content[0].type, "text");
  assert.match(postedBody.content[0].text, /固定角色身份锁定/u);
  assert.doesNotMatch(postedBody.content[0].text, /猫耳|额外人物/u);
  assert.equal(postedBody.content[1].role, "first_frame");
  assert.equal(postedBody.content[2].role, "last_frame");
  assert.match(postedBody.content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.match(postedBody.content[2].image_url.url, /^data:image\/png;base64,/u);
  assert.equal(postedBody.duration, 4);
  assert.equal(postedBody.resolution, "2K");
  assert.equal(postedBody.ratio, "adaptive");
  assert.equal(postedBody.aigc_watermark, false);
  assert.equal(Object.hasOwn(postedBody, "negative_prompt"), false);
  assert.equal(authorization, "Bearer test-key");
  assert.equal(pollRequestUrl, "/v2/query/video_generation/minimax-h3-task");
  assert.equal(await fs.readFile(outputPath, "utf8"), "minimax h3 video bytes");
  assert.equal(receipt.videoProvider, "MiniMax");
  assert.equal(receipt.providerTaskId, "minimax-h3-task");
  assert.equal(receipt.audioRequested, true);
  assert.equal(receipt.audioOutputMode, "native");
  assert.equal(receipt.negativePromptDelivery.appliedMode, "positive_constraint");
  assert.deepEqual(receipt.negativePromptDelivery.ignored.map((item) => item.text), ["不要出现额外人物"]);
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

test("Kling 3.0 锁定国内官方 endpoint，不继承海外、Legacy endpoint、token 或 provider config", () => {
  const runtime = shotVideoRuntimeConfig("Kling", {
    KLING_V3_ENDPOINT: "https://api-singapore.klingai.com/image-to-video/kling-3.0",
    KLING_VIDEO_ENDPOINT: "https://api-singapore.klingai.com",
    KLING_API_KEY: "domestic-api-key",
    KLING_V3_API_KEY: "model-specific-key",
    VIDEO_HTTP_VIDEO_ENDPOINT: "https://legacy.example.com/v1",
    VIDEO_HTTP_API_KEY: "legacy-token",
    VIDEO_HTTP_CONFIG: "/legacy/provider.json",
    VIDEO_HTTP_VIDEO_MODEL: "kling-v2-1"
  }, "kling-v3");

  assert.equal(runtime.endpoint, KLING_CN_V3_ENDPOINT);
  assert.equal(runtime.apiKey, "domestic-api-key");
  assert.equal(runtime.configPath, "");
  assert.equal(runtime.providerPreset, "kling_3_0_image_to_video");
  assert.equal(runtime.audio, "native");
});

test("Kling 3.0 provider config 明确拒绝新加坡 endpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kling-v3-overseas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "https://api-singapore.klingai.com/image-to-video/kling-3.0",
    providerPreset: "kling_3_0_image_to_video",
    videoModel: "kling-v3",
    apiKey: "overseas-key"
  }));

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: videoRequest({
      provider: "Kling",
      model: "kling-v3",
      startPath: path.join(root, "start.png"),
      endPath: path.join(root, "end.png")
    }),
    output: path.join(root, "output.mp4"),
    root
  }), /仅支持国内官方 api-beijing\.klingai\.com/u);
});

test("旧 provider.json-only 路由保持 generic，未校验配置文件不谎报 reachable", () => {
  assert.deepEqual(shotVideoDefaultSetting({
    VIDEO_HTTP_CONFIG: "/custom/provider.json"
  }), {
    provider: "VideoHTTP",
    model: ""
  });

  const kling = shotVideoProviderCatalog({
    KLING_V3_CONFIG: "/unverified/kling-v3.json",
    KLING_VIDEO_MODEL: "kling-v3"
  }).Kling;
  assert.equal(kling.configured, true);
  assert.equal(kling.reachable, false);
  assert.equal(kling.status, 0);
});

test("自定义 HTTP 的同名 v2 路径不会被误判为 MiniMax H3", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "custom-v2-video-generation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let postedBody = null;
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v2/video_generation") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        mediaUrl: `http://127.0.0.1:${provider.address().port}/media/custom.mp4`
      }));
      return;
    }
    if (request.url === "/media/custom.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end("custom video bytes");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(provider));

  const configPath = path.join(root, "provider.json");
  const startPath = path.join(root, "start.png");
  const endPath = path.join(root, "end.png");
  const outputPath = path.join(root, "output.mp4");
  await Promise.all([
    fs.writeFile(startPath, "start image bytes"),
    fs.writeFile(endPath, "end image bytes"),
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: `http://127.0.0.1:${provider.address().port}/v2/video_generation`,
      videoModel: "custom-video-model"
    }))
  ]);

  await executeGenericHttpWorker({
    config: configPath,
    request: videoRequest({
      provider: "VideoHTTP",
      model: "custom-video-model",
      startPath,
      endPath
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.taskId, "VideoHTTP-test");
  assert.equal(Object.hasOwn(postedBody, "content"), false);
  assert.equal(await fs.readFile(outputPath, "utf8"), "custom video bytes");
});

function videoRequest({
  provider,
  model,
  startPath,
  endPath,
  durationSeconds = 5
}) {
  return {
    taskId: `${provider}-test`,
    capability: "first_last_frame_video_generation",
    outputKey: "preview.test",
    provider,
    model,
    prompt: "女孩看向镜头并说：你好。",
    negativePromptEntries: [{
      text: "不要出现额外人物",
      enabled: true,
      reasonCode: "identity_conflict",
      priority: "medium"
    }],
    compiledNegativePrompt: "不要出现额外人物",
    inputArtifacts: [
      { path: startPath, outputKey: "frames.test.start", status: "done" },
      { path: endPath, outputKey: "frames.test.end", status: "done" }
    ],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds
    }
  };
}

function allReferenceVideoRequest({
  provider,
  model,
  artifacts,
  aspectRatio = "9:16",
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
      durationSeconds: 5,
      generationMode: "all_reference"
    }
  };
}
