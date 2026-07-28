import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  isShotVideoModelAllowed,
  KLING_CN_V3_ENDPOINT,
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
      durationSeconds: 3
    }),
    output: outputPath,
    root
  });

  assert.equal(postedBody.model, "doubao-seedance-2-0-260128");
  assert.equal(postedBody.content[0].type, "text");
  assert.equal(postedBody.content[1].role, "first_frame");
  assert.equal(postedBody.content[2].role, "last_frame");
  assert.equal(postedBody.generate_audio, true);
  assert.equal(postedBody.duration, 4);
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
