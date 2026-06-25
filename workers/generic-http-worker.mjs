#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.request || !options.output) {
  console.log(`用法：
  node workers/generic-http-worker.mjs --config provider.json --request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>

这是一个通用 HTTP worker，用于把 command provider 的 request JSON 转发给图像/首尾帧视频 API。
必要配置可以写在 JSON config，或使用 VIDEO_HTTP_* 环境变量。

最小环境变量示例：
  VIDEO_HTTP_ENDPOINT=https://provider.example.com/generate
  VIDEO_HTTP_API_KEY=你的_key

常用分能力 endpoint：
  VIDEO_HTTP_IMAGE_ENDPOINT=...
  VIDEO_HTTP_VIDEO_ENDPOINT=...
  VIDEO_HTTP_REVIEW_ENDPOINT=...
  VIDEO_HTTP_ASSEMBLY_ENDPOINT=...`);
  process.exit(options.help ? 0 : 1);
}

try {
  const request = JSON.parse(await fs.readFile(options.request, "utf8"));
  const config = await loadConfig(options.config || process.env.VIDEO_HTTP_CONFIG || "");
  const result = await executeRequest(request, options, mergeEnvConfig(config));
  await writeReceipt(options.receipt, result);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function executeRequest(request, options, config) {
  const endpoint = endpointFor(request.capability, config);
  if (!endpoint) throw new Error(`缺少 ${request.capability || "unknown"} 的 HTTP endpoint`);

  const context = {
    request,
    model: modelFor(request.capability, config),
    inputArtifacts: await loadInputArtifacts(request.inputArtifacts || [], config),
    root: options.root || "",
    output: options.output
  };
  const body = buildRequestBody(context, config);
  const startedAt = Date.now();
  const first = await postJson(endpoint, body, config);
  const resolved = await resolveProviderResult(first, request, config);
  await writeOutput(resolved, options.output, config);
  return {
    provider: "generic-http-worker",
    taskId: request.taskId,
    capability: request.capability,
    outputKey: request.outputKey,
    outputPath: options.output,
    endpoint,
    model: context.model,
    resultKind: resolved.kind,
    providerTaskId: resolved.providerTaskId || "",
    elapsedMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString()
  };
}

function endpointFor(capability, config) {
  const endpoints = config.endpoints || {};
  if (endpoints[capability]) return endpoints[capability];
  if (capability === "image_generation") return config.imageEndpoint || process.env.VIDEO_HTTP_IMAGE_ENDPOINT || config.endpoint;
  if (capability === "first_last_frame_video_generation") return config.videoEndpoint || process.env.VIDEO_HTTP_VIDEO_ENDPOINT || config.endpoint;
  if (capability === "video_quality_review") return config.reviewEndpoint || process.env.VIDEO_HTTP_REVIEW_ENDPOINT || config.endpoint;
  if (capability === "video_assembly") return config.assemblyEndpoint || process.env.VIDEO_HTTP_ASSEMBLY_ENDPOINT || config.endpoint;
  return config.endpoint;
}

function modelFor(capability, config) {
  const models = config.models || {};
  if (models[capability]) return models[capability];
  if (capability === "image_generation") return config.imageModel || process.env.VIDEO_HTTP_IMAGE_MODEL || config.model || "";
  if (capability === "first_last_frame_video_generation") return config.videoModel || process.env.VIDEO_HTTP_VIDEO_MODEL || config.model || "";
  if (capability === "video_quality_review") return config.reviewModel || process.env.VIDEO_HTTP_REVIEW_MODEL || config.model || "";
  if (capability === "video_assembly") return config.assemblyModel || process.env.VIDEO_HTTP_ASSEMBLY_MODEL || config.model || "";
  return config.model || "";
}

function buildRequestBody(context, config) {
  const template = config.bodyTemplates?.[context.request.capability] || config.bodyTemplate;
  if (template) return renderTemplate(template, context);
  return {
    taskId: context.request.taskId,
    capability: context.request.capability,
    model: context.model || undefined,
    prompt: context.request.prompt || "",
    negativePrompt: context.request.negativePrompt || "",
    parameters: context.request.parameters || {},
    acceptanceCriteria: context.request.acceptanceCriteria || [],
    inputArtifacts: context.inputArtifacts,
    rawRequest: config.includeRawRequest === false ? undefined : context.request
  };
}

async function resolveProviderResult(first, request, config) {
  if (first.kind !== "json") {
    return { ...first, providerTaskId: "" };
  }

  let current = first.data;
  let providerTaskId = firstValue(current, config.taskIdPaths || defaultTaskIdPaths());
  let artifact = extractArtifact(current, request, config);
  if (artifact) return { ...artifact, providerTaskId };

  const pollTarget = pollTargetFor(current, providerTaskId, config);
  if (!pollTarget) {
    if (request.capability === "video_quality_review" || config.writeJsonWhenNoMedia === true) {
      return { kind: "json", data: current, providerTaskId };
    }
    throw new Error("供应商响应中没有可写入的 mediaUrl/base64/text，也没有可轮询任务");
  }

  const deadline = Date.now() + Number(config.pollTimeoutMs || 600000);
  const intervalMs = Number(config.pollIntervalMs || 3000);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const polled = await getJson(pollTarget, config);
    current = polled.data;
    providerTaskId = providerTaskId || firstValue(current, config.taskIdPaths || defaultTaskIdPaths());
    const status = String(firstValue(current, config.statusPaths || defaultStatusPaths()) || "").toLowerCase();
    if ((config.failureStatuses || defaultFailureStatuses()).map(String).map((item) => item.toLowerCase()).includes(status)) {
      throw new Error(`供应商任务失败：${status}`);
    }
    artifact = extractArtifact(current, request, config);
    if (artifact) return { ...artifact, providerTaskId };
    if ((config.successStatuses || defaultSuccessStatuses()).map(String).map((item) => item.toLowerCase()).includes(status)) {
      if (request.capability === "video_quality_review" || config.writeJsonWhenNoMedia === true) {
        return { kind: "json", data: current, providerTaskId };
      }
      throw new Error(`供应商任务已完成，但响应中没有可写入产物：${status}`);
    }
  }
  throw new Error(`供应商任务轮询超时：${providerTaskId || pollTarget}`);
}

function extractArtifact(data, request, config) {
  const url = firstValue(data, config.resultUrlPaths || defaultResultUrlPaths());
  if (typeof url === "string" && url.trim()) {
    if (url.startsWith("data:")) return { kind: "data_url", dataUrl: url };
    return { kind: "url", url };
  }
  const base64 = firstValue(data, config.resultBase64Paths || defaultResultBase64Paths());
  if (typeof base64 === "string" && base64.trim()) return { kind: "base64", base64 };
  const text = firstValue(data, config.resultTextPaths || defaultResultTextPaths());
  if (typeof text === "string" && text.trim()) return { kind: "text", text };
  if (request.capability === "video_quality_review" && data) return { kind: "json", data };
  return null;
}

function pollTargetFor(data, providerTaskId, config) {
  const pollUrl = firstValue(data, config.pollUrlPaths || defaultPollUrlPaths());
  if (typeof pollUrl === "string" && pollUrl.trim()) return pollUrl;
  const template = config.pollEndpointTemplate || process.env.VIDEO_HTTP_POLL_ENDPOINT_TEMPLATE || "";
  if (template && providerTaskId) return template.replace(/\{taskId\}/gu, encodeURIComponent(providerTaskId));
  return "";
}

async function writeOutput(result, outputPath, config) {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  if (result.kind === "url") {
    await downloadToFile(result.url, outputPath, config);
  } else if (result.kind === "data_url") {
    const [, payload = ""] = result.dataUrl.split(",", 2);
    await fs.writeFile(outputPath, Buffer.from(payload, "base64"));
  } else if (result.kind === "base64") {
    await fs.writeFile(outputPath, Buffer.from(stripDataUrlPrefix(result.base64), "base64"));
  } else if (result.kind === "json") {
    await fs.writeFile(outputPath, `${JSON.stringify(result.data, null, 2)}\n`);
  } else if (result.kind === "binary") {
    await fs.writeFile(outputPath, result.buffer);
  } else {
    await fs.writeFile(outputPath, String(result.text || ""));
  }
}

async function loadInputArtifacts(inputArtifacts, config) {
  const includeDataUrls = config.includeInputDataUrls ?? true;
  const maxBytes = Number(config.maxInputDataUrlBytes || 12 * 1024 * 1024);
  const result = [];
  for (const artifact of inputArtifacts) {
    const item = {
      outputKey: artifact.outputKey || "",
      path: artifact.path || "",
      status: artifact.status || "",
      missing: Boolean(artifact.missing)
    };
    if (includeDataUrls && artifact.path) {
      try {
        const stat = await fs.stat(artifact.path);
        if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) {
          const buffer = await fs.readFile(artifact.path);
          item.filename = path.basename(artifact.path);
          item.mimeType = mimeTypeForPath(artifact.path);
          item.dataUrl = `data:${item.mimeType};base64,${buffer.toString("base64")}`;
        }
      } catch {
        item.missing = true;
      }
    }
    result.push(item);
  }
  return result;
}

async function postJson(url, body, config) {
  return requestHttp(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headersFor(config) },
    body: JSON.stringify(removeUndefined(body))
  }, config);
}

async function getJson(url, config) {
  return requestHttp(url, {
    method: "GET",
    headers: headersFor(config)
  }, config);
}

async function requestHttp(url, init, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs || 120000));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${buffer.toString("utf8").slice(0, 1000)}`);
    }
    if (contentType.includes("application/json") || looksLikeJson(buffer)) {
      return { kind: "json", data: JSON.parse(buffer.toString("utf8") || "{}") };
    }
    if (contentType.startsWith("text/")) return { kind: "text", text: buffer.toString("utf8") };
    return { kind: "binary", buffer };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(url, outputPath, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs || 120000));
  try {
    const response = await fetch(url, { headers: downloadHeadersFor(config), signal: controller.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`下载产物失败 HTTP ${response.status}: ${buffer.toString("utf8").slice(0, 1000)}`);
    await fs.writeFile(outputPath, buffer);
  } finally {
    clearTimeout(timer);
  }
}

function downloadHeadersFor(config) {
  if (config.authOnDownload === true) return headersFor(config);
  return { ...(config.downloadHeaders || {}) };
}

async function writeReceipt(receiptPath, result) {
  if (!receiptPath) return;
  await fs.mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
  await fs.writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
}

function headersFor(config) {
  const headers = { ...(config.headers || {}) };
  const apiKey = config.apiKey || process.env.VIDEO_HTTP_API_KEY || "";
  if (apiKey) {
    const header = config.authHeader || process.env.VIDEO_HTTP_AUTH_HEADER || "Authorization";
    const scheme = config.authScheme ?? process.env.VIDEO_HTTP_AUTH_SCHEME ?? "Bearer";
    headers[header] = scheme ? `${scheme} ${apiKey}` : apiKey;
  }
  const extra = parseJsonEnv("VIDEO_HTTP_EXTRA_HEADERS", {});
  return { ...headers, ...extra };
}

async function loadConfig(configPath) {
  if (!configPath) return {};
  const text = await fs.readFile(configPath, "utf8");
  return JSON.parse(text);
}

function mergeEnvConfig(config) {
  return {
    ...config,
    endpoint: process.env.VIDEO_HTTP_ENDPOINT || config.endpoint || "",
    model: process.env.VIDEO_HTTP_MODEL || config.model || "",
    timeoutMs: process.env.VIDEO_HTTP_TIMEOUT_MS || config.timeoutMs,
    pollIntervalMs: process.env.VIDEO_HTTP_POLL_INTERVAL_MS || config.pollIntervalMs,
    pollTimeoutMs: process.env.VIDEO_HTTP_POLL_TIMEOUT_MS || config.pollTimeoutMs,
    maxInputDataUrlBytes: process.env.VIDEO_HTTP_MAX_INPUT_DATA_URL_BYTES || config.maxInputDataUrlBytes,
    includeInputDataUrls: process.env.VIDEO_HTTP_INCLUDE_INPUT_DATA_URLS === "0" ? false : config.includeInputDataUrls,
    writeJsonWhenNoMedia: process.env.VIDEO_HTTP_WRITE_JSON_WHEN_NO_MEDIA === "1" || config.writeJsonWhenNoMedia
  };
}

function renderTemplate(value, context) {
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{\s*json\s+([^}]+)\s*\}\}$/u);
  if (exact) return getPath(context, exact[1].trim());
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/gu, (_, expression) => {
    const resolved = getPath(context, expression.trim());
    if (resolved == null) return "";
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

function getPath(source, dottedPath) {
  return String(dottedPath || "").split(".").reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, source);
}

function firstValue(source, paths) {
  for (const itemPath of paths || []) {
    const value = getPath(source, itemPath);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]));
  }
  return value;
}

function parseJsonEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  try {
    return JSON.parse(process.env[name]);
  } catch {
    return fallback;
  }
}

function stripDataUrlPrefix(value) {
  return String(value || "").includes(",") ? String(value).split(",", 2)[1] : String(value || "");
}

function looksLikeJson(buffer) {
  const first = buffer.toString("utf8", 0, Math.min(buffer.length, 16)).trimStart()[0];
  return first === "{" || first === "[";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

function defaultTaskIdPaths() {
  return ["taskId", "task_id", "id", "data.taskId", "data.task_id", "data.id", "result.taskId", "result.task_id", "result.id"];
}

function defaultStatusPaths() {
  return ["status", "state", "data.status", "data.state", "result.status", "result.state", "task.status", "task.state"];
}

function defaultPollUrlPaths() {
  return ["pollUrl", "poll_url", "data.pollUrl", "data.poll_url", "result.pollUrl", "result.poll_url", "urls.get", "links.self"];
}

function defaultResultUrlPaths() {
  return [
    "mediaUrl", "media_url", "url", "outputUrl", "output_url", "imageUrl", "image_url", "videoUrl", "video_url", "resultUrl", "result_url",
    "data.mediaUrl", "data.media_url", "data.url", "data.outputUrl", "data.output_url", "data.imageUrl", "data.image_url", "data.videoUrl", "data.video_url",
    "result.mediaUrl", "result.media_url", "result.url", "result.outputUrl", "result.output_url", "result.imageUrl", "result.image_url", "result.videoUrl", "result.video_url",
    "output.url", "output.videoUrl", "output.video_url", "output.imageUrl", "output.image_url",
    "files.0.url", "videos.0.url", "images.0.url"
  ];
}

function defaultResultBase64Paths() {
  return [
    "base64", "b64_json", "imageBase64", "image_base64", "videoBase64", "video_base64",
    "data.base64", "data.b64_json", "data.imageBase64", "data.image_base64", "data.videoBase64", "data.video_base64",
    "result.base64", "result.b64_json", "result.imageBase64", "result.image_base64", "result.videoBase64", "result.video_base64",
    "images.0.b64_json", "images.0.base64", "videos.0.base64"
  ];
}

function defaultResultTextPaths() {
  return ["text", "content", "data.text", "data.content", "result.text", "result.content", "output.text"];
}

function defaultSuccessStatuses() {
  return ["succeeded", "success", "completed", "complete", "done", "finished"];
}

function defaultFailureStatuses() {
  return ["failed", "failure", "error", "canceled", "cancelled"];
}

function parseArgs(args) {
  const parsed = { request: "", output: "", receipt: "", root: "", config: "", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--request") parsed.request = requireValue(args, ++index, arg);
    else if (arg.startsWith("--request=")) parsed.request = arg.slice("--request=".length);
    else if (arg === "--output") parsed.output = requireValue(args, ++index, arg);
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--receipt") parsed.receipt = requireValue(args, ++index, arg);
    else if (arg.startsWith("--receipt=")) parsed.receipt = arg.slice("--receipt=".length);
    else if (arg === "--root") parsed.root = requireValue(args, ++index, arg);
    else if (arg.startsWith("--root=")) parsed.root = arg.slice("--root=".length);
    else if (arg === "--config") parsed.config = requireValue(args, ++index, arg);
    else if (arg.startsWith("--config=")) parsed.config = arg.slice("--config=".length);
    else throw new Error(`未知参数：${arg}`);
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}
