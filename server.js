import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "./src/config.js";
import { MimoClient, ModelResponseError } from "./src/mimo-client.js";
import { WorkflowService } from "./src/workflow.js";
import { InputError, OutputContractError } from "./src/validation.js";

loadEnv();
const config = getConfig();
const mimoClient = config.mimo.enabled ? new MimoClient(config.mimo) : null;
const workflow = new WorkflowService({
  client: mimoClient,
  storyModel: config.mimo.storyModel,
  storyMaxCompletionTokens: config.mimo.storyMaxCompletionTokens,
  animationModel: config.mimo.animationModel,
  animationMaxCompletionTokens: config.mimo.animationMaxCompletionTokens
});
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

const routes = {
  "/api/analyze": (body) => workflow.analyze(body),
  "/api/reconstruct": (body) => workflow.reconstruct(body),
  "/api/brief": (body) => workflow.createBrief(body),
  "/api/variants": (body) => workflow.createVariants(body),
  "/api/full-story": (body) => workflow.createFullStory(body),
  "/api/animation-plan": (body) => workflow.createAnimationPlan(body),
  "/api/run": (body) => workflow.run(body)
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const [provider, storyProvider, animationProvider] = mimoClient
        ? await Promise.all([
          mimoClient.checkHealth(config.mimo.model),
          mimoClient.checkHealth(config.mimo.storyModel),
          mimoClient.checkHealth(config.mimo.animationModel)
        ])
        : [
          { reachable: false, modelAvailable: false, status: 0 },
          { reachable: false, modelAvailable: false, status: 0 },
          { reachable: false, modelAvailable: false, status: 0 }
        ];
      return json(response, 200, {
        ok: true,
        mode: workflow.mode,
        model: config.mimo.model,
        storyModel: config.mimo.storyModel,
        animationModel: config.mimo.animationModel,
        providerConfigured: config.mimo.enabled,
        providerReachable: provider.reachable,
        modelAvailable: provider.modelAvailable,
        storyModelAvailable: storyProvider.modelAvailable,
        animationModelAvailable: animationProvider.modelAvailable,
        mediaMode: config.mimo.mediaMode,
        nativeVideoMaxBytes: config.mimo.nativeVideoMaxBytes
      });
    }
    if (request.method === "POST" && routes[url.pathname]) {
      const body = await readJson(request);
      const result = await routes[url.pathname](body);
      return json(response, 200, { ok: true, mode: workflow.mode, result });
    }
    if (request.method === "GET" || request.method === "HEAD") return serveStatic(url.pathname, response, request.method === "HEAD");
    return json(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    if (error instanceof InputError) return json(response, 400, { ok: false, error: error.message, details: error.details });
    if (error instanceof OutputContractError) return json(response, 502, { ok: false, error: `模型输出不完整：${error.message}` });
    if (error instanceof ModelResponseError) return json(response, 502, { ok: false, error: error.message, detail: error.raw });
    if (error.name === "AbortError" || error.name === "TimeoutError") return json(response, 504, { ok: false, error: "MiMo 响应超时" });
    console.error(error);
    return json(response, 500, { ok: false, error: "服务器内部错误" });
  }
});

server.listen(config.port, () => {
  console.log(`AI 短视频导演：http://localhost:${config.port}`);
  console.log(`运行模式：${workflow.mode === "mimo" ? `MiMo (${config.mimo.model} / 剧情 ${config.mimo.storyModel} / 动画 ${config.mimo.animationModel})` : "演示数据（配置 .env 后接入 MiMo）"}`);
});

async function readJson(request) {
  const chunks = [];
  let size = 0;
  const limit = 32 * 1024 * 1024;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new InputError("请求过大，请减少采样画面数量或尺寸");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InputError("请求 JSON 格式无效");
  }
}

async function serveStatic(pathname, response, headOnly) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, "index.html")) return json(response, 403, { ok: false, error: "禁止访问" });
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, { "content-type": mime(path.extname(file)), "cache-control": "no-cache" });
    response.end(headOnly ? undefined : body);
  } catch {
    try {
      const body = await fs.readFile(path.join(publicDir, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(headOnly ? undefined : body);
    } catch {
      json(response, 404, { ok: false, error: "页面不存在" });
    }
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function mime(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[extension] || "application/octet-stream";
}
