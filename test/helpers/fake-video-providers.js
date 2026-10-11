import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { executeGenericHttpWorker } from "../../workers/generic-http-worker.mjs";

// 两家镜头视频供应商（Seedance、MiniMax）的假服务：记下 worker 实际 POST 的原始请求体，按各家协议让 worker 走完。
// 供应商配置文件里固定住会受 .env 影响的字段；分辨率由调用方通过环境变量或 config 决定。

const RESOLUTION_ENV = ["SEEDANCE_VIDEO_RESOLUTION", "MINIMAX_VIDEO_RESOLUTION"];

export function pinResolutionEnv(t, values) {
  const saved = Object.fromEntries(RESOLUTION_ENV.map((name) => [name, process.env[name]]));
  for (const name of RESOLUTION_ENV) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  t.after(() => {
    for (const name of RESOLUTION_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}

const closeServer = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

// 起一个假供应商：记下第一次 POST 的原始请求体，按各家协议让 worker 走完。
async function fakeProvider(t, respond) {
  const posted = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      posted.push(Buffer.concat(chunks).toString("utf8"));
    }
    respond(request, response, `http://127.0.0.1:${server.address().port}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  return { posted, base: () => `http://127.0.0.1:${server.address().port}` };
}

const json = (response, value) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const media = (response, text) => {
  response.writeHead(200, { "content-type": "video/mp4" });
  response.end(text);
};
export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function workspace(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `shot-video-resolution-golden-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export async function seedancePostedBody(t, { config = {}, parameters = {} } = {}) {
  const provider = await fakeProvider(t, (request, response, base) => {
    if (request.url === "/media/r2v.mp4") return media(response, "seedance golden video");
    return json(response, { mediaUrl: `${base}/media/r2v.mp4` });
  });
  const root = await workspace(t, "seedance");
  const imagePath = path.join(root, "character.png");
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(imagePath, "golden image bytes");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `${provider.base()}/api/v3/contents/generations/tasks`,
    providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-260128",
    apiKey: "test-key",
    watermark: false,
    generateAudio: true,
    returnLastFrame: false,
    serviceTier: "",
    executionExpiresAfter: "",
    ...config
  }));
  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "Seedance-golden",
      capability: "all_reference_video_generation",
      outputKey: "preview.golden",
      provider: "Seedance",
      model: config.videoModel || "doubao-seedance-2-0-260128",
      prompt: "阿岚在雨夜的修理铺门口蹲下，把湿透的小猫抱进怀里。",
      inputArtifacts: [{ outputKey: "references.1", status: "done", path: imagePath, mediaType: "image", role: "reference_image" }],
      parameters: { aspectRatio: "16:9", durationSeconds: 5, generationMode: "all_reference", ...parameters }
    },
    output: path.join(root, "output.mp4"),
    root
  });
  return { raw: provider.posted[0], receipt };
}

export async function miniMaxPostedBody(t, { config = {}, parameters = {} } = {}) {
  const provider = await fakeProvider(t, (request, response, base) => {
    if (request.method === "POST" && request.url === "/v2/video_generation") return json(response, { task_id: "golden-task" });
    if (request.url === "/v2/query/video_generation/golden-task") {
      return json(response, { task: { id: "golden-task", model: "MiniMax-H3", status: "succeeded", content: { url: `${base}/media/h3.mp4` } } });
    }
    if (request.url === "/media/h3.mp4") return media(response, "minimax golden video");
    response.writeHead(404);
    response.end("not found");
  });
  const root = await workspace(t, "minimax");
  const imagePath = path.join(root, "character.png");
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(imagePath, "golden image bytes");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `${provider.base()}/v2/video_generation`,
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    pollIntervalMs: 1,
    pollTimeoutMs: 1000,
    watermark: false,
    ...config
  }));
  const receipt = await executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "MiniMax-golden",
      capability: "all_reference_video_generation",
      outputKey: "preview.golden",
      provider: "MiniMax",
      model: "MiniMax-H3",
      prompt: "阿岚在雨夜的修理铺门口蹲下，把湿透的小猫抱进怀里。",
      inputArtifacts: [{ outputKey: "references.1", status: "done", path: imagePath, mediaType: "image", role: "reference_image" }],
      parameters: { aspectRatio: "16:9", durationSeconds: 5, generationMode: "all_reference", ...parameters }
    },
    output: path.join(root, "output.mp4"),
    root
  });
  return { raw: provider.posted[0], receipt };
}
