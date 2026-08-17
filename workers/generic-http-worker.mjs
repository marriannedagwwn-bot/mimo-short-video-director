#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  inferShotVideoProvider,
  isNonDomesticKlingApiEndpoint,
  normalizeShotVideoProvider,
  shotVideoRuntimeConfig
} from "../src/shot-video-providers.js";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.request || !options.output) {
    console.log(`用法：
  node workers/generic-http-worker.mjs --config provider.json --request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>

这是一个通用 HTTP worker，用于把 command provider 的 request JSON 转发给图像/视频 API。
必要配置可以写在 JSON config，或使用 VIDEO_HTTP_* 环境变量。

最小环境变量示例：
  VIDEO_HTTP_ENDPOINT=https://provider.example.com/generate
  VIDEO_HTTP_API_KEY=你的_key

常用分能力 endpoint：
  VIDEO_HTTP_IMAGE_ENDPOINT=...
  VIDEO_HTTP_VIDEO_ENDPOINT=...
  VIDEO_HTTP_REVIEW_ENDPOINT=...
  VIDEO_HTTP_ASSEMBLY_ENDPOINT=...`);
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  try {
    await executeGenericHttpWorker(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export async function executeGenericHttpWorker(options = {}) {
  const request = typeof options.request === "string"
    ? JSON.parse(await fs.readFile(options.request, "utf8"))
    : options.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("worker request 必须是对象或 JSON 文件路径");
  if (!options.output) throw new Error("worker output 不能为空");
  const config = await loadConfig(options.config || process.env.VIDEO_HTTP_CONFIG || "");
  const result = await executeRequest(request, options, mergeEnvConfig(config, request));
  await writeReceipt(options.receipt, result);
  return result;
}

if (isMainModule()) await main();

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

async function executeRequest(request, options, config) {
  const endpoint = endpointFor(request.capability, config);
  if (!endpoint) throw new Error(`缺少 ${request.capability || "unknown"} 的 HTTP endpoint`);

  const context = {
    request: normalizeRequestNegativePrompt(request),
    model: request.model || modelFor(request.capability, config),
    inputArtifacts: await loadInputArtifacts(request.inputArtifacts || [], config),
    root: options.root || "",
    output: options.output
  };
  if (request.referenceManifest) {
    assertReferenceManifestMatchesArtifacts(request.referenceManifest, context.inputArtifacts);
  }
  const { body, negativePromptDelivery } = buildRequestBody(context, config);
  if (isMiniMaxH3Capability(context.request.capability, config)) {
    assertMiniMaxH3RequestBodySize(body, config);
  }
  const startedAt = Date.now();
  const first = await postJson(endpoint, body, config);
  const resolved = await resolveProviderResult(first, context.request, { ...config, resolvedEndpoint: endpoint });
  await writeOutput(resolved, options.output, config);
  const miniMaxH3Video = isMiniMaxH3VideoGeneration(context.request.capability, config);
  const promptReceipt = buildMiniMaxH3ProviderPromptReceipt(context.request, body, config);
  return {
    provider: "generic-http-worker",
    videoProvider: context.request.provider || config.videoProvider || "",
    taskId: context.request.taskId,
    capability: context.request.capability,
    outputKey: context.request.outputKey,
    outputPath: options.output,
    endpoint: redactUrl(endpoint),
    model: context.model,
    audioRequested: miniMaxH3Video
      || body.generate_audio === true
      || body.settings?.audio === "native"
      || body.sound === "on",
    audioOutputMode: miniMaxH3Video
      ? "native"
      : body.generate_audio === true || body.settings?.audio === "native" || body.sound === "on" ? "requested" : "none",
    negativePromptDelivery,
    ...(promptReceipt ? { promptReceipt } : {}),
    requestPreview: buildRequestPreview(endpoint, body, config),
    resultKind: resolved.kind,
    providerTaskId: resolved.providerTaskId || "",
    elapsedMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString()
  };
}

function endpointFor(capability, config) {
  const endpoints = config.endpoints || {};
  let endpoint = endpoints[capability] || "";
  if (capability === "h3_context_ir" && endpoint) return String(endpoint).trim();
  if (!endpoint && capability === "h3_context_ir") {
    const explicitContextIrEndpoint = config.h3ContextIrEndpoint || config.contextIrEndpoint;
    if (explicitContextIrEndpoint) return String(explicitContextIrEndpoint).trim();
    endpoint = deriveMiniMaxH3ContextIrEndpoint(config.videoEndpoint || config.endpoint);
  }
  if (!endpoint && capability === "image_generation") endpoint = config.imageEndpoint || config.endpoint;
  if (!endpoint && isVideoGenerationCapability(capability)) endpoint = config.videoEndpoint || config.endpoint;
  if (!endpoint && capability === "video_quality_review") endpoint = config.reviewEndpoint || config.endpoint;
  if (!endpoint && capability === "video_assembly") endpoint = config.assemblyEndpoint || config.endpoint;
  if (!endpoint) endpoint = config.endpoint;
  return normalizeEndpointForPreset(capability, endpoint, config);
}

function modelFor(capability, config) {
  const models = config.models || {};
  if (models[capability]) return models[capability];
  if (capability === "image_generation") return config.imageModel || config.model || "";
  if (isVideoGenerationCapability(capability) || capability === "h3_context_ir") return config.videoModel || config.model || "";
  if (capability === "video_quality_review") return config.reviewModel || config.model || "";
  if (capability === "video_assembly") return config.assemblyModel || config.model || "";
  return config.model || "";
}

function buildRequestBody(context, config) {
  if (isMiniMaxH3ContextIr(context.request.capability, config)) {
    return {
      body: buildMiniMaxH3ContextIrBody(context, config),
      negativePromptDelivery: unsupportedNegativePromptDelivery(
        context.request.compiledNegativePrompt,
        activeNegativePromptEntries(context.request.negativePromptEntries)
      )
    };
  }
  const template = config.bodyTemplates?.[context.request.capability] || config.bodyTemplate;
  const negativePromptDelivery = resolveNegativePromptDelivery(context, config, template);
  const providerContext = contextForNegativePromptDelivery(context, negativePromptDelivery);
  if (template) {
    const body = renderTemplate(template, providerContext);
    const configuredFields = negativePromptFieldsFor(context.request.capability, config);
    if (negativePromptDelivery.appliedMode === "native_negative" && negativePromptDelivery.appliedText) {
      for (const field of configuredFields) setPath(body, field, negativePromptDelivery.appliedText);
    } else if (!negativePromptDelivery.appliedText) {
      for (const field of uniquePaths([
        ...configuredFields,
        ...templateNegativePromptPaths(template)
      ])) deletePath(body, field);
    }
    return { body, negativePromptDelivery };
  }
  if (isMiniMaxH3VideoGeneration(context.request.capability, config)) {
    return {
      body: buildMiniMaxH3VideoBody(providerContext, config, negativePromptDelivery),
      negativePromptDelivery
    };
  }
  if (isModelArkContentGeneration(context.request.capability, config)) {
    return {
      body: buildModelArkContentGenerationBody(providerContext, config, negativePromptDelivery),
      negativePromptDelivery
    };
  }
  if (isKlingV3ImageToVideo(context.request.capability, config)) {
    return {
      body: buildKlingV3ImageToVideoBody(providerContext, config, negativePromptDelivery),
      negativePromptDelivery
    };
  }
  if (isKlingImageToVideo(context.request.capability, config)) {
    return {
      body: buildKlingImageToVideoBody(providerContext, config, negativePromptDelivery),
      negativePromptDelivery
    };
  }
  const body = {
    taskId: context.request.taskId,
    capability: context.request.capability,
    model: context.model || undefined,
    prompt: context.request.prompt || "",
    negativePrompt: negativePromptDelivery.appliedText || undefined,
    parameters: context.request.parameters || {},
    acceptanceCriteria: context.request.acceptanceCriteria || [],
    inputArtifacts: context.inputArtifacts,
    rawRequest: config.includeRawRequest === true ? providerContext.request : undefined
  };
  return { body, negativePromptDelivery };
}

function normalizeRequestNegativePrompt(request = {}) {
  const hasEntries = Object.hasOwn(request, "negativePromptEntries");
  const entries = normalizeNegativePromptEntries(request.negativePromptEntries);
  let compiledNegativePrompt = "";
  if (Object.hasOwn(request, "compiledNegativePrompt")) {
    compiledNegativePrompt = String(request.compiledNegativePrompt || "").trim();
    if (!compiledNegativePrompt && entries.length) compiledNegativePrompt = compileNegativePromptEntries(entries);
  } else if (hasEntries) {
    compiledNegativePrompt = compileNegativePromptEntries(entries);
  } else if (Object.hasOwn(request, "negativePrompt")) {
    compiledNegativePrompt = String(request.negativePrompt || "").trim();
  } else {
    compiledNegativePrompt = compileNegativePromptEntries(entries);
  }
  return {
    ...request,
    negativePromptEntries: entries,
    compiledNegativePrompt,
    negativePrompt: compiledNegativePrompt
  };
}

function normalizeNegativePromptEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { text: entry.trim(), enabled: true };
    if (!entry || typeof entry !== "object") return null;
    return {
      ...entry,
      text: String(entry.text || "").trim(),
      enabled: entry.enabled !== false
    };
  }).filter((entry) => entry?.text);
}

function activeNegativePromptEntries(entries = []) {
  return entries.filter((entry) => entry?.enabled !== false && String(entry?.text || "").trim());
}

function compileNegativePromptEntries(entries = []) {
  return uniqueText(activeNegativePromptEntries(entries).map((entry) => entry.text)).join("；");
}

function resolveNegativePromptDelivery(context, config, template) {
  const capability = context.request.capability;
  const compiled = String(context.request.compiledNegativePrompt || "").trim();
  const entries = activeNegativePromptEntries(context.request.negativePromptEntries);

  if (template) {
    const templateFields = templateNegativePromptPaths(template);
    const configuredFields = negativePromptFieldsFor(capability, config);
    const providerFields = uniquePaths([...templateFields, ...configuredFields]);
    if (!providerFields.length) return unsupportedNegativePromptDelivery(compiled, entries);
    return nativeNegativePromptDelivery(compiled, providerFields.join(", "));
  }

  if (
    isMiniMaxH3VideoGeneration(capability, config)
    && context.request.promptDialect === "minimax_h3_ref2va_six_section"
  ) {
    return unsupportedNegativePromptDelivery(compiled, entries);
  }

  if (isModelArkContentGeneration(capability, config) || isMiniMaxH3VideoGeneration(capability, config)) {
    const eligible = entries.filter((entry) => entry.priority === "high" && entry.reasonCode === "explicit_identity_conflict");
    const ignored = entries.filter((entry) => !eligible.includes(entry));
    if (!eligible.length) return unsupportedNegativePromptDelivery(compiled, entries);
    return {
      supported: false,
      appliedMode: "positive_constraint",
      providerField: "content[0].text",
      compiledNegativePrompt: compiled,
      appliedText: "固定角色身份锁定：严格保持当前镜头中已明确角色的身份、物种、人形结构、外观与参考图一致，不改变角色身份。",
      providerIgnored: ignored.length > 0,
      ignored: ignoredNegativePromptEntries(ignored, compiled, entries)
    };
  }

  if (isKlingV3ImageToVideo(capability, config)) {
    return unsupportedNegativePromptDelivery(compiled, entries);
  }

  if (isKlingImageToVideo(capability, config)) {
    const maxChars = Number(config.negativePromptMaxChars || 2500);
    return nativeNegativePromptDelivery(truncateText(compiled, maxChars), "negative_prompt");
  }

  return nativeNegativePromptDelivery(compiled, "negativePrompt");
}

function nativeNegativePromptDelivery(compiled = "", providerField = "") {
  const text = String(compiled || "").trim();
  return {
    supported: true,
    appliedMode: text ? "native_negative" : "not_applied",
    providerField,
    compiledNegativePrompt: text,
    appliedText: text,
    providerIgnored: false,
    ignored: []
  };
}

function unsupportedNegativePromptDelivery(compiled = "", entries = []) {
  const text = String(compiled || "").trim();
  const ignored = ignoredNegativePromptEntries(entries, text, entries);
  return {
    supported: false,
    appliedMode: "not_supported",
    providerField: "",
    compiledNegativePrompt: text,
    appliedText: "",
    providerIgnored: Boolean(text || ignored.length),
    ignored
  };
}

function ignoredNegativePromptEntries(entries = [], compiled = "", allEntries = []) {
  const ignored = entries.map((entry) => ({
    text: entry.text,
    reasonCode: entry.reasonCode || "",
    priority: entry.priority || "",
    triggerEvidence: entry.triggerEvidence || ""
  }));
  if (!ignored.length && compiled && !allEntries.length) {
    ignored.push({
      text: compiled,
      reasonCode: "",
      priority: "",
      triggerEvidence: "",
      ignoredReason: "missing_structured_evidence"
    });
  }
  return ignored;
}

function contextForNegativePromptDelivery(context, delivery = {}) {
  const {
    negativePromptEntries: _entries,
    compiledNegativePrompt: _compiled,
    negativePrompt: _legacy,
    rawJob: _rawJob,
    ...request
  } = context.request || {};
  if (delivery.appliedMode === "native_negative" && delivery.appliedText) {
    request.compiledNegativePrompt = delivery.appliedText;
    request.negativePrompt = delivery.appliedText;
  }
  return { ...context, request };
}

function templateNegativePromptPaths(template, prefix = []) {
  if (Array.isArray(template)) {
    return template.flatMap((item, index) => templateNegativePromptPaths(item, [...prefix, String(index)]));
  }
  if (template && typeof template === "object") {
    return Object.entries(template).flatMap(([key, item]) => templateNegativePromptPaths(item, [...prefix, key]));
  }
  if (typeof template !== "string") return [];
  const mapped = /\{\{\s*request\.(?:compiledNegativePrompt|negativePrompt)\s*\}\}/u.test(template);
  return mapped && prefix.length ? [prefix.join(".")] : [];
}

function negativePromptFieldsFor(capability, config = {}) {
  const configured = config.negativePromptFields;
  let value = configured;
  if (configured && !Array.isArray(configured) && typeof configured === "object") {
    value = configured[capability] ?? configured.default ?? configured.field;
  }
  if (value === undefined || value === null || value === "") value = config.negativePromptField;
  if (Array.isArray(value)) return uniqueText(value.map(String));
  if (value && typeof value === "object") value = value.field || value.path || "";
  return value ? [String(value).trim()].filter(Boolean) : [];
}

function setPath(target, dottedPath, value) {
  const keys = String(dottedPath || "").split(".").filter(Boolean);
  if (!keys.length || !target || typeof target !== "object") return;
  let cursor = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = /^\d+$/u.test(keys[index + 1]) ? [] : {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
}

function deletePath(target, dottedPath) {
  const keys = String(dottedPath || "").split(".").filter(Boolean);
  if (!keys.length || !target || typeof target !== "object") return;
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") return;
    cursor = cursor[key];
  }
  if (Array.isArray(cursor) && /^\d+$/u.test(keys.at(-1))) cursor[Number(keys.at(-1))] = undefined;
  else delete cursor[keys.at(-1)];
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveProviderResult(first, request, config) {
  if (first.kind !== "json") {
    if (first.kind === "text" && !textArtifactAllowed(request, config)) {
      throw new Error(`供应商返回了纯文本响应“${String(first.text || "").trim().slice(0, 120)}”，但 ${request.capability || "当前"} 需要媒体产物。请配置正确的视频结果字段或轮询接口。`);
    }
    return { ...first, providerTaskId: "" };
  }

  let current = first.data;
  let providerTaskId = firstValue(current, taskIdPathsFor(request, config));
  let artifact = extractArtifact(current, request, config);
  if (artifact) return { ...artifact, providerTaskId };

  const pollTarget = pollTargetFor(current, providerTaskId, config);
  if (!pollTarget) {
    if (request.capability === "video_quality_review" || config.writeJsonWhenNoMedia === true) {
      return { kind: "json", data: current, providerTaskId };
    }
    throw new Error(`供应商响应中没有可写入的 mediaUrl/base64${textArtifactAllowed(request, config) ? "/text" : ""}，也没有可轮询任务`);
  }

  const deadline = Date.now() + Number(config.pollTimeoutMs || 600000);
  const intervalMs = Number(config.pollIntervalMs || 3000);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const polled = await getJson(pollTarget, config);
    current = polled.data;
    providerTaskId = providerTaskId || firstValue(current, taskIdPathsFor(request, config));
    const status = String(firstValue(current, statusPathsFor(request, config)) || "").toLowerCase();
    if (failureStatusesFor(request, config).map(String).map((item) => item.toLowerCase()).includes(status)) {
      throw new Error(`供应商任务失败：${status}`);
    }
    artifact = extractArtifact(current, request, config);
    if (artifact) return { ...artifact, providerTaskId };
    if (successStatusesFor(request, config).map(String).map((item) => item.toLowerCase()).includes(status)) {
      if (request.capability === "video_quality_review" || config.writeJsonWhenNoMedia === true) {
        return { kind: "json", data: current, providerTaskId };
      }
      throw new Error(`供应商任务已完成，但响应中没有可写入产物：${status}`);
    }
  }
  throw new Error(`供应商任务轮询超时：${providerTaskId || pollTarget}`);
}

function extractArtifact(data, request, config) {
  if (isKlingV3ImageToVideo(request.capability, config)) {
    const tasks = Array.isArray(data?.data) ? data.data : [];
    const video = tasks
      .flatMap((task) => Array.isArray(task?.outputs) ? task.outputs : [])
      .find((output) => output?.type === "video" && typeof output.url === "string" && output.url.trim());
    return video ? { kind: "url", url: video.url } : null;
  }
  const url = firstValue(data, resultUrlPathsFor(request, config));
  if (typeof url === "string" && url.trim()) {
    if (url.startsWith("data:")) return { kind: "data_url", dataUrl: url };
    return { kind: "url", url };
  }
  const base64 = firstValue(data, config.resultBase64Paths || defaultResultBase64Paths());
  if (typeof base64 === "string" && base64.trim()) return { kind: "base64", base64 };
  const text = firstValue(data, resultTextPathsFor(request, config));
  if (typeof text === "string" && text.trim() && textArtifactAllowed(request, config)) return { kind: "text", text };
  if (request.capability === "video_quality_review" && data) return { kind: "json", data };
  return null;
}

function taskIdPathsFor(request, config) {
  if (config.taskIdPaths) return config.taskIdPaths;
  if (isMiniMaxH3Capability(request.capability, config)) {
    return uniquePaths(["task_id", ...defaultTaskIdPaths()]);
  }
  if (isKlingV3ImageToVideo(request.capability, config)) {
    return uniquePaths(["data.id", "data.0.id", ...defaultTaskIdPaths()]);
  }
  if (isKlingImageToVideo(request.capability, config)) {
    return uniquePaths(["data.task_id", "data.taskId", "data.id", ...defaultTaskIdPaths()]);
  }
  return defaultTaskIdPaths();
}

function statusPathsFor(request, config) {
  if (config.statusPaths) return config.statusPaths;
  if (isMiniMaxH3Capability(request.capability, config)) {
    return uniquePaths(["task.status", ...defaultStatusPaths()]);
  }
  if (isKlingV3ImageToVideo(request.capability, config)) {
    return uniquePaths(["data.0.status", "data.status", ...defaultStatusPaths()]);
  }
  if (isKlingImageToVideo(request.capability, config)) {
    return uniquePaths(["data.task_status", "data.taskStatus", ...defaultStatusPaths()]);
  }
  return defaultStatusPaths();
}

function resultUrlPathsFor(request, config) {
  if (config.resultUrlPaths) return config.resultUrlPaths;
  if (isMiniMaxH3VideoGeneration(request.capability, config)) {
    return uniquePaths(["task.content.url", ...defaultResultUrlPaths()]);
  }
  if (isKlingV3ImageToVideo(request.capability, config)) {
    return uniquePaths([
      "data.0.outputs.0.url",
      ...defaultResultUrlPaths()
    ]);
  }
  if (isKlingImageToVideo(request.capability, config)) {
    return uniquePaths([
      "data.task_result.videos.0.url",
      "data.task_result.videos.0.video_url",
      "data.task_result.video.url",
      "data.task_result.video_url",
      ...defaultResultUrlPaths()
    ]);
  }
  return defaultResultUrlPaths();
}

function resultTextPathsFor(request, config) {
  if (config.resultTextPaths) return config.resultTextPaths;
  if (isMiniMaxH3ContextIr(request.capability, config)) {
    return uniquePaths(["task.content.prompt", ...defaultResultTextPaths()]);
  }
  return defaultResultTextPaths();
}

function successStatusesFor(request, config) {
  if (config.successStatuses) return config.successStatuses;
  if (isKlingV3ImageToVideo(request.capability, config)) return ["succeeded"];
  if (isKlingImageToVideo(request.capability, config)) return uniquePaths(["succeed", ...defaultSuccessStatuses()]);
  return defaultSuccessStatuses();
}

function failureStatusesFor(request, config) {
  if (config.failureStatuses) return config.failureStatuses;
  if (isKlingV3ImageToVideo(request.capability, config)) return ["failed"];
  if (isKlingImageToVideo(request.capability, config)) return uniquePaths(["failed", ...defaultFailureStatuses()]);
  return defaultFailureStatuses();
}

function textArtifactAllowed(request, config) {
  if (config.allowTextArtifact === true) return true;
  return request.capability === "video_quality_review"
    || isMiniMaxH3ContextIr(request.capability, config);
}

function pollTargetFor(data, providerTaskId, config) {
  const pollUrl = firstValue(data, config.pollUrlPaths || defaultPollUrlPaths());
  if (typeof pollUrl === "string" && pollUrl.trim()) return pollUrl;
  const template = config.pollEndpointTemplate || "";
  if (template && providerTaskId) return template.replace(/\{taskId\}/gu, encodeURIComponent(providerTaskId));
  if (isMiniMaxH3VideoGeneration("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
    const origin = new URL(String(config.resolvedEndpoint)).origin;
    return `${origin}/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`;
  }
  if (isKlingV3ImageToVideo("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
    const origin = new URL(String(config.resolvedEndpoint)).origin;
    return `${origin}/tasks?task_ids=${encodeURIComponent(providerTaskId)}`;
  }
  if (isModelArkContentGeneration("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
    return `${String(config.resolvedEndpoint).replace(/\/$/u, "")}/${encodeURIComponent(providerTaskId)}`;
  }
  if (isKlingImageToVideo("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
    return `${String(config.resolvedEndpoint).replace(/\/$/u, "")}/${encodeURIComponent(providerTaskId)}`;
  }
  return "";
}

function presetFor(capability, config) {
  const presets = config.presets || {};
  return String(presets[capability] || config.providerPreset || config.preset || "").trim().toLowerCase();
}

function isModelArkContentGeneration(capability, config) {
  if (!isVideoGenerationCapability(capability)) return false;
  return ["modelark", "modelark_content_generation", "dreamina", "jimeng"].includes(presetFor(capability, config));
}

function isMiniMaxH3VideoGeneration(capability, config) {
  if (!isVideoGenerationCapability(capability)) return false;
  const preset = presetFor(capability, config);
  const model = String(config.videoModel || config.model || "").trim();
  const endpoint = String(config.resolvedEndpoint || config.videoEndpoint || config.endpoint || "");
  return preset === "minimax_h3_video_generation"
    || model === "MiniMax-H3"
    || (hostnameFor(endpoint) === "api.minimaxi.com" && /\/v2\/video_generation\/?$/u.test(endpoint));
}

function isMiniMaxH3ContextIr(capability, config) {
  if (capability !== "h3_context_ir") return false;
  const preset = presetFor(capability, config);
  const model = String(config.videoModel || config.model || "").trim();
  const endpoint = String(config.resolvedEndpoint || config.h3ContextIrEndpoint || config.contextIrEndpoint || "");
  return preset === "minimax_h3_video_generation"
    || model === "MiniMax-H3"
    || /\/v2\/h3_context_ir\/?$/u.test(endpoint);
}

function isMiniMaxH3Capability(capability, config) {
  return isMiniMaxH3VideoGeneration(capability, config) || isMiniMaxH3ContextIr(capability, config);
}

function isKlingImageToVideo(capability, config) {
  if (capability !== "first_last_frame_video_generation") return false;
  const preset = presetFor(capability, config);
  if (["kling", "kling_image_to_video", "kling_image2video", "klingai", "kling_3_0_image_to_video"].includes(preset)) return true;
  const endpoint = String(config.resolvedEndpoint || config.videoEndpoint || config.endpoint || "");
  return /(^|\.)klingai\.com\b/u.test(hostnameFor(endpoint));
}

function isVideoGenerationCapability(capability) {
  return ["first_last_frame_video_generation", "all_reference_video_generation"].includes(capability);
}

function isKlingV3ImageToVideo(capability, config) {
  if (capability !== "first_last_frame_video_generation") return false;
  const preset = presetFor(capability, config);
  const model = String(config.videoModel || config.model || "").trim().toLowerCase();
  return preset === "kling_3_0_image_to_video"
    || model === "kling-v3"
    || /\/image-to-video\/kling-3\.0\/?$/u.test(String(config.resolvedEndpoint || config.videoEndpoint || config.endpoint || ""));
}

function normalizeEndpointForPreset(capability, endpoint, config) {
  if (!endpoint) return endpoint;
  if (capability === "h3_context_ir") return deriveMiniMaxH3ContextIrEndpoint(endpoint);
  if (isMiniMaxH3VideoGeneration(capability, { ...config, videoEndpoint: endpoint, endpoint })) {
    const clean = String(endpoint).replace(/\/$/u, "");
    try {
      const parsed = new URL(clean);
      if (parsed.hostname === "api.minimaxi.com") {
        if (/^\/v1(?:\/|$)/u.test(parsed.pathname)) {
          throw new Error("MiniMax H3 必须使用 V2 /v2/video_generation 接口，不能复用旧版 /v1/video_generation。");
        }
        if (!parsed.pathname || parsed.pathname === "/") return `${clean}/v2/video_generation`;
        if (parsed.pathname === "/v2") return `${clean}/video_generation`;
      }
    } catch (error) {
      if (error instanceof Error && /MiniMax H3 必须使用/u.test(error.message)) throw error;
    }
    return clean;
  }
  if (isKlingV3ImageToVideo(capability, { ...config, videoEndpoint: endpoint, endpoint })) {
    const clean = String(endpoint).replace(/\/$/u, "");
    if (/\/image-to-video\/kling-3\.0$/u.test(clean)) return clean;
    if (/\/image-to-video$/u.test(clean)) return `${clean}/kling-3.0`;
    try {
      const parsed = new URL(clean);
      if (!parsed.pathname || parsed.pathname === "/") return `${clean}/image-to-video/kling-3.0`;
    } catch {
      // Custom relative/mock endpoints are already fully qualified by their config.
    }
    return clean;
  }
  if (isKlingImageToVideo(capability, { ...config, videoEndpoint: endpoint, endpoint })) {
    const clean = String(endpoint).replace(/\/$/u, "");
    if (/\/v1\/videos\/image2video$/u.test(clean)) return clean;
    if (/\/v1\/videos$/u.test(clean)) return `${clean}/image2video`;
    if (/\/v1$/u.test(clean)) return `${clean}/videos/image2video`;
    return `${clean}/v1/videos/image2video`;
  }
  if (!isModelArkContentGeneration(capability, config)) return endpoint;
  const clean = String(endpoint).replace(/\/$/u, "");
  if (/\/contents\/generations\/tasks$/u.test(clean)) return clean;
  if (/\/api\/v3$/u.test(clean)) return `${clean}/contents/generations/tasks`;
  return endpoint;
}

function deriveMiniMaxH3ContextIrEndpoint(value = "") {
  const endpoint = String(value || "").trim();
  if (!endpoint) return "";
  try {
    const url = new URL(endpoint);
    url.pathname = "/v2/h3_context_ir";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    if (/\/v2\/h3_context_ir\/?$/u.test(endpoint)) return endpoint;
    if (/\/v2\/video_generation\/?$/u.test(endpoint)) {
      return endpoint.replace(/\/v2\/video_generation\/?$/u, "/v2/h3_context_ir");
    }
    return "";
  }
}

function buildModelArkContentGenerationBody(context, config, negativePromptDelivery = {}) {
  const artifacts = context.inputArtifacts || [];
  const prompt = [
    context.request.prompt || "",
    negativePromptDelivery.appliedMode === "positive_constraint" ? negativePromptDelivery.appliedText : ""
  ].filter(Boolean).join("\n");
  const parameters = context.request.parameters || {};
  const content = context.request.capability === "all_reference_video_generation"
    ? buildAllReferenceContent(artifacts, prompt, "Seedance 2.0")
    : buildFirstLastFrameContent(artifacts, prompt, "ModelArk/Dreamina");
  const body = {
    model: context.model || config.model || undefined,
    content,
    ratio: normalizeSeedanceRatio(parameters.aspectRatio || config.ratio),
    duration: normalizeSeedanceDuration(parameters.durationSeconds || config.duration),
    watermark: config.watermark === true,
    generate_audio: config.generateAudio !== false,
    return_last_frame: config.returnLastFrame === true
  };
  body.resolution = normalizeSeedanceResolution(config.resolution, body.model);
  if (config.serviceTier) {
    if (config.serviceTier !== "default") throw new Error("Seedance 2.0 仅支持 service_tier=default。");
    body.service_tier = config.serviceTier;
  }
  if (config.executionExpiresAfter) {
    const expiresAfter = Math.round(Number(config.executionExpiresAfter));
    if (!Number.isFinite(expiresAfter) || expiresAfter < 3600 || expiresAfter > 259200) {
      throw new Error("Seedance execution_expires_after 必须是 3600–259200 秒的整数。");
    }
    body.execution_expires_after = expiresAfter;
  }
  return body;
}

function buildMiniMaxH3VideoBody(context, config, negativePromptDelivery = {}) {
  const artifacts = context.inputArtifacts || [];
  const prompt = requireTextWithinLimit([
    context.request.prompt || "",
    negativePromptDelivery.appliedMode === "positive_constraint" ? negativePromptDelivery.appliedText : ""
  ].filter(Boolean).join("\n"), miniMaxH3PromptMaxChars(config), "MiniMax H3 视频提示词");
  const parameters = context.request.parameters || {};
  const duration = Object.hasOwn(parameters, "durationSeconds")
    ? parameters.durationSeconds
    : config.duration;
  const content = context.request.capability === "all_reference_video_generation"
    ? buildAllReferenceContent(artifacts, prompt, "MiniMax H3", { maxTotal: 12 })
    : buildFirstLastFrameContent(artifacts, prompt, "MiniMax H3");
  return {
    model: context.model || config.model || "MiniMax-H3",
    content,
    resolution: normalizeMiniMaxResolution(config.resolution),
    duration: normalizeMiniMaxDuration(duration),
    ratio: context.request.capability === "all_reference_video_generation"
      ? normalizeMiniMaxRatio(parameters.aspectRatio || config.ratio)
      : "adaptive",
    aigc_watermark: config.watermark === true
  };
}

function buildMiniMaxH3ContextIrBody(context, config) {
  const parameters = context.request.parameters || {};
  const duration = Object.hasOwn(parameters, "durationSeconds")
    ? parameters.durationSeconds
    : config.duration;
  const prompt = requireTextWithinLimit(
    context.request.prompt || "",
    miniMaxH3PromptMaxChars(config),
    "MiniMax H3 Context-IR 提示词"
  );
  return {
    model: context.model || config.model || "MiniMax-H3",
    content: buildAllReferenceContent(context.inputArtifacts || [], prompt, "MiniMax H3 Context-IR", { maxTotal: 12 }),
    duration: normalizeMiniMaxDuration(duration),
    ratio: normalizeMiniMaxRatio(parameters.aspectRatio || config.ratio)
  };
}

function buildFirstLastFrameContent(artifacts, prompt, providerLabel) {
  const startFrame = firstArtifactDataUrl(artifacts[0]);
  const endFrame = firstArtifactDataUrl(artifacts[1]);
  if (!startFrame || !endFrame) throw new Error(`${providerLabel} 首尾帧视频任务需要首帧和尾帧两张图片 dataUrl。`);
  return [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: startFrame }, role: "first_frame" },
    { type: "image_url", image_url: { url: endFrame }, role: "last_frame" }
  ];
}

function buildAllReferenceContent(artifacts, prompt, providerLabel, { maxTotal = Number.POSITIVE_INFINITY } = {}) {
  const counts = artifacts.reduce((result, artifact) => {
    const mediaType = String(artifact.mediaType || "").trim().toLowerCase();
    if (Object.hasOwn(result, mediaType)) result[mediaType] += 1;
    return result;
  }, { image: 0, video: 0, audio: 0 });
  if (counts.image > 9 || counts.video > 3 || counts.audio > 3) {
    throw new Error(`${providerLabel} 全能参考素材超过上限：${counts.image} 图、${counts.video} 视频、${counts.audio} 音频。`);
  }
  if (artifacts.length > maxTotal) {
    throw new Error(`${providerLabel} 混合参考素材总数最多 ${maxTotal} 项，当前 ${artifacts.length} 项。`);
  }
  const content = [{ type: "text", text: prompt }];
  for (const [index, artifact] of artifacts.entries()) {
    const mediaType = String(artifact.mediaType || "").trim().toLowerCase();
    const dataUrl = firstArtifactDataUrl(artifact);
    if (!["image", "video", "audio"].includes(mediaType) || !dataUrl) {
      throw new Error(`${providerLabel} 全能参考素材 ${index + 1} 缺少有效媒体类型或 dataUrl。`);
    }
    const type = `${mediaType}_url`;
    content.push({
      type,
      [type]: { url: dataUrl },
      role: `reference_${mediaType}`
    });
  }
  const hasVisualReference = content.some((item) => ["reference_image", "reference_video"].includes(item.role));
  if (!hasVisualReference) throw new Error(`${providerLabel} 全能参考模式至少需要一张图片或一段视频，不能只输入音频。`);
  if (content.some((item) => ["first_frame", "last_frame"].includes(item.role))) {
    throw new Error(`${providerLabel} 全能参考模式不得混用 first_frame 或 last_frame。`);
  }
  return content;
}

function buildKlingV3ImageToVideoBody(context, config) {
  const artifacts = context.inputArtifacts || [];
  const startFrame = firstArtifactImagePayload(artifacts[0]);
  const endFrame = firstArtifactImagePayload(artifacts[1]);
  if (!startFrame) throw new Error("Kling 3.0 图生视频任务必须提供首帧图片。");
  const parameters = context.request.parameters || {};
  const contents = [
    {
      type: "prompt",
      text: truncateText(context.request.prompt || "", Number(config.promptMaxChars || 2500))
    },
    { type: "first_frame", url: startFrame }
  ];
  if (endFrame) contents.push({ type: "last_frame", url: endFrame });
  return {
    contents,
    settings: {
      multi_shot: config.multiShot === true,
      audio: config.audio === "off" ? "off" : "native",
      resolution: normalizeKlingV3Resolution(config.resolution),
      duration: normalizeKlingV3Duration(parameters.durationSeconds || config.duration)
    },
    options: {
      watermark_info: {
        enabled: config.watermark === true
      }
    }
  };
}

function buildKlingImageToVideoBody(context, config, negativePromptDelivery = {}) {
  const artifacts = context.inputArtifacts || [];
  const startFrame = firstArtifactImagePayload(artifacts[0]);
  const endFrame = firstArtifactImagePayload(artifacts[1]);
  if (!startFrame && !endFrame) throw new Error("Kling 图生视频任务需要首帧或尾帧图片。");
  const parameters = context.request.parameters || {};
  const hasTail = Boolean(endFrame);
  const body = {
    model_name: context.model || config.model || "kling-v2-1",
    image: startFrame || undefined,
    image_tail: endFrame || undefined,
    prompt: truncateText(context.request.prompt || "", Number(config.promptMaxChars || 2500)),
    negative_prompt: negativePromptDelivery.appliedText || undefined,
    mode: config.mode || (hasTail ? "pro" : "std"),
    duration: String(config.duration || normalizeKlingDuration(parameters.durationSeconds))
  };
  const sound = config.sound;
  if (sound) body.sound = sound;
  const cfgScale = config.cfgScale;
  if (cfgScale !== undefined && cfgScale !== "" && !/^kling-v2(?:-|$)/iu.test(String(body.model_name))) {
    body.cfg_scale = Number(cfgScale);
  }
  return body;
}

function firstArtifactImagePayload(artifact = {}) {
  const dataUrl = firstArtifactDataUrl(artifact);
  if (dataUrl) return stripDataUrlPrefix(dataUrl);
  return artifact.url || artifact.mediaUrl || artifact.imageUrl || "";
}

function normalizeKlingDuration(value) {
  const seconds = Math.round(Number(value) || 5);
  return seconds <= 5 ? 5 : 10;
}

function normalizeKlingV3Duration(value) {
  const seconds = Math.round(Number(value) || 5);
  return Math.min(15, Math.max(3, seconds));
}

function normalizeKlingV3Resolution(value) {
  const resolution = String(value || "720p").trim().toLowerCase();
  return ["720p", "1080p", "4k"].includes(resolution) ? resolution : "720p";
}

function normalizeSeedanceDuration(value) {
  const number = Math.round(Number(value));
  if (number === -1) return -1;
  if (!Number.isFinite(number)) return 5;
  return Math.min(15, Math.max(4, number));
}

function normalizeSeedanceRatio(value) {
  const ratio = String(value || "adaptive").trim().toLowerCase();
  return ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(ratio)
    ? ratio
    : "adaptive";
}

function normalizeSeedanceResolution(value, model) {
  const resolution = String(value || "720p").trim().toLowerCase();
  const allowed = /-(?:fast|mini)-/iu.test(String(model || ""))
    ? ["480p", "720p"]
    : ["480p", "720p", "1080p", "4k"];
  return allowed.includes(resolution) ? resolution : "720p";
}

function normalizeMiniMaxDuration(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error("MiniMax H3 duration 必须是 4–15 秒整数，不能静默改写时长。");
  }
  return seconds;
}

function normalizeMiniMaxResolution(value) {
  const resolution = String(value || "2K").trim().toUpperCase();
  return ["768P", "2K"].includes(resolution) ? resolution : "2K";
}

function normalizeMiniMaxRatio(value) {
  const ratio = String(value || "adaptive").trim().toLowerCase();
  return ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"].includes(ratio)
    ? ratio
    : "adaptive";
}

function truncateText(value, maxChars) {
  const text = String(value || "").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function requireTextWithinLimit(value, maxChars, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}不能为空。`);
  if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
    throw new Error(`${label}超过 ${maxChars} 字符（当前 ${text.length}），拒绝截断。`);
  }
  return text;
}

function miniMaxH3PromptMaxChars(config = {}) {
  const configured = Number(config.promptMaxChars || 7000);
  if (!Number.isFinite(configured) || configured <= 0) return 7000;
  return Math.min(7000, Math.floor(configured));
}

function assertMiniMaxH3RequestBodySize(body, config = {}) {
  const officialMaxBytes = 64 * 1024 * 1024;
  const configuredMaxBytes = Object.hasOwn(config, "maxRequestBodyBytes")
    ? Number(config.maxRequestBodyBytes)
    : officialMaxBytes;
  const maxBytes = Math.min(officialMaxBytes, configuredMaxBytes);
  const bytes = Buffer.byteLength(JSON.stringify(removeUndefined(body)), "utf8");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("MiniMax H3 maxRequestBodyBytes 配置无效。");
  }
  if (bytes > maxBytes) {
    throw new Error(`MiniMax H3 最终请求体不得超过 ${(maxBytes / 1024 / 1024).toFixed(2)}MB，当前 ${(bytes / 1024 / 1024).toFixed(2)}MB；拒绝截断或丢弃参考素材。`);
  }
}

function hostnameFor(value) {
  try {
    return new URL(String(value || "")).hostname || "";
  } catch {
    return "";
  }
}

function firstArtifactDataUrl(artifact = {}) {
  return artifact.dataUrl || artifact.data_url || "";
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
      missing: Boolean(artifact.missing),
      mediaType: artifact.mediaType || "",
      role: artifact.role || "",
      filename: artifact.filename || "",
      mimeType: artifact.mimeType || "",
      durationSeconds: Number(artifact.durationSeconds) || 0,
      sizeBytes: Number(artifact.sizeBytes) || 0,
      source: artifact.source || "",
      logicalName: artifact.logicalName || artifact.filename || "",
      sourceShotId: artifact.sourceShotId || "",
      sourceCharacterName: artifact.sourceCharacterName || "",
      sha256: String(artifact.sha256 || "").trim().toLowerCase()
    };
    if (includeDataUrls && artifact.path) {
      try {
        const stat = await fs.stat(artifact.path);
        if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) {
          const buffer = await fs.readFile(artifact.path);
          item.filename = path.basename(artifact.path);
          item.mimeType = mimeTypeForPath(artifact.path);
          item.sizeBytes = buffer.length;
          item.sha256 = sha256Bytes(buffer);
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

function assertReferenceManifestMatchesArtifacts(manifest, artifacts) {
  if (manifest?.schemaVersion !== "minimax_h3_reference_manifest/1.0") {
    throw new Error("MiniMax H3 referenceManifest schemaVersion 无效。");
  }
  const items = Array.isArray(manifest.contentItems) ? manifest.contentItems : [];
  if (manifest.digest !== sha256Text(JSON.stringify(items))) {
    throw new Error("MiniMax H3 referenceManifest digest 与 contentItems 不一致。");
  }
  if (
    Array.isArray(manifest.labelBindings)
    && manifest.labelBindingsDigest !== sha256Text(JSON.stringify(manifest.labelBindings))
  ) {
    throw new Error("MiniMax H3 referenceManifest labelBindingsDigest 无效。");
  }
  if (items.length !== artifacts.length) {
    throw new Error(`MiniMax H3 referenceManifest 素材数与实际输入不一致：manifest=${items.length}，actual=${artifacts.length}。`);
  }
  for (let index = 0; index < items.length; index += 1) {
    const expected = items[index] || {};
    const actual = artifacts[index] || {};
    if (expected.providerContentIndex !== index + 1) {
      throw new Error(`MiniMax H3 referenceManifest 第 ${index + 1} 项 providerContentIndex 无效。`);
    }
    if (expected.mediaType !== actual.mediaType || expected.transportRole !== `reference_${actual.mediaType}`) {
      throw new Error(`MiniMax H3 referenceManifest 第 ${index + 1} 项媒体类型或 role 与实际输入不一致。`);
    }
    if (!actual.dataUrl || !/^[a-f0-9]{64}$/u.test(actual.sha256)) {
      throw new Error(`MiniMax H3 第 ${index + 1} 项实际输入缺少可验证的媒体字节。`);
    }
    if (expected.sha256 !== actual.sha256 || Number(expected.byteLength) !== actual.sizeBytes) {
      throw new Error(`MiniMax H3 referenceManifest 第 ${index + 1} 项字节摘要与实际输入不一致。`);
    }
  }
}

function buildMiniMaxH3ProviderPromptReceipt(request, body, config) {
  if (!isMiniMaxH3Capability(request.capability, config)) return null;
  const submittedPrompt = Array.isArray(body.content)
    ? String(body.content.find((item) => item?.type === "text")?.text || "")
    : "";
  if (!submittedPrompt) return null;
  return {
    schemaVersion: "minimax_h3_provider_prompt_receipt/1.0",
    dialect: String(request.promptDialect || "minimax_h3_unprofiled"),
    submittedPrompt,
    submittedPromptSha256: sha256Text(submittedPrompt),
    referenceManifestDigest: String(request.referenceManifest?.digest || ""),
    referenceManifest: request.referenceManifest || null
  };
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
  const apiKey = config.apiKey || "";
  if (apiKey) {
    const header = config.authHeader || "Authorization";
    const scheme = config.authScheme ?? "Bearer";
    headers[header] = scheme ? `${scheme} ${apiKey}` : apiKey;
  }
  return { ...headers, ...(config.extraHeaders || {}) };
}

function buildRequestPreview(endpoint, body, config) {
  return {
    method: "POST",
    endpoint: redactUrl(endpoint),
    headers: redactPreviewValue({ "content-type": "application/json", ...headersFor(config) }),
    body: redactPreviewValue(removeUndefined(body))
  };
}

function redactPreviewValue(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactPreviewValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      sensitivePreviewKey(childKey) ? "[REDACTED]" : redactPreviewValue(item, childKey)
    ]));
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (/^data:[^;,]+;base64,/iu.test(text)) return `[REDACTED_DATA_URL length=${value.length}]`;
  if (/^(?:bearer|basic)\s+\S+/iu.test(text)) return "[REDACTED]";
  if (looksLikeBase64Text(text) && (base64PreviewKey(key) || text.length >= 256)) {
    return `[REDACTED_BASE64 length=${value.length}]`;
  }
  if (/^https?:\/\//iu.test(text)) return redactUrl(text);
  return value;
}

function sensitivePreviewKey(key = "") {
  const compact = String(key || "").toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return /(apikey|accesskey|secret|token|authorization|auth|password|credential|signature)/u.test(compact);
}

function base64PreviewKey(key = "") {
  return /(?:base64|b64|image(?:_tail)?|image_data|video_data|file_data)/iu.test(String(key));
}

function looksLikeBase64Text(value = "") {
  const text = String(value || "").replace(/\s+/gu, "");
  return text.length >= 16 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(text);
}

function redactUrl(value = "") {
  const text = String(value || "");
  try {
    const url = new URL(text);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    if (url.search) url.search = "?REDACTED";
    return url.toString();
  } catch {
    return text.replace(/\?.*$/u, "?[REDACTED]");
  }
}

async function loadConfig(configPath) {
  if (!configPath) return {};
  const text = await fs.readFile(configPath, "utf8");
  return JSON.parse(text);
}

function mergeEnvConfig(config, request = {}) {
  const requestedProvider = normalizeShotVideoProvider(request.provider);
  const inferredProvider = inferShotVideoProvider({
    model: request.model || config.videoModel || config.model,
    preset: config.providerPreset || config.preset
  });
  const provider = requestedProvider || inferredProvider || "VideoHTTP";
  const runtime = shotVideoRuntimeConfig(provider, process.env, request.model || config.videoModel || config.model);
  assertWorkerProtocolCompatibility(provider, request.model || config.videoModel || config.model, config);
  const base = provider === "VideoHTTP"
    ? {
        endpoint: process.env.VIDEO_HTTP_ENDPOINT || "",
        videoEndpoint: process.env.VIDEO_HTTP_VIDEO_ENDPOINT || "",
        imageEndpoint: process.env.VIDEO_HTTP_IMAGE_ENDPOINT || "",
        videoModel: process.env.VIDEO_HTTP_VIDEO_MODEL || "",
        imageModel: process.env.VIDEO_HTTP_IMAGE_MODEL || "",
        model: process.env.VIDEO_HTTP_MODEL || "",
        apiKey: process.env.VIDEO_HTTP_API_KEY || "",
        authHeader: process.env.VIDEO_HTTP_AUTH_HEADER || "",
        authScheme: process.env.VIDEO_HTTP_AUTH_SCHEME,
        providerPreset: process.env.VIDEO_HTTP_PRESET || "",
        timeoutMs: process.env.VIDEO_HTTP_TIMEOUT_MS,
        pollIntervalMs: process.env.VIDEO_HTTP_POLL_INTERVAL_MS,
        pollTimeoutMs: process.env.VIDEO_HTTP_POLL_TIMEOUT_MS,
        pollEndpointTemplate: process.env.VIDEO_HTTP_POLL_ENDPOINT_TEMPLATE || "",
        negativePromptMaxChars: process.env.VIDEO_HTTP_NEGATIVE_PROMPT_MAX_CHARS,
        promptMaxChars: process.env.VIDEO_HTTP_PROMPT_MAX_CHARS,
        extraHeaders: parseJsonEnv("VIDEO_HTTP_EXTRA_HEADERS", {})
      }
    : runtime;
  return {
    ...compactConfig(base),
    ...config,
    videoProvider: provider,
    videoModel: request.model || config.videoModel || base.videoModel || base.model || "",
    maxInputDataUrlBytes: process.env.VIDEO_HTTP_MAX_INPUT_DATA_URL_BYTES || config.maxInputDataUrlBytes,
    includeInputDataUrls: process.env.VIDEO_HTTP_INCLUDE_INPUT_DATA_URLS === "0" ? false : config.includeInputDataUrls,
    writeJsonWhenNoMedia: process.env.VIDEO_HTTP_WRITE_JSON_WHEN_NO_MEDIA === "1" || config.writeJsonWhenNoMedia,
    allowTextArtifact: process.env.VIDEO_HTTP_ALLOW_TEXT_ARTIFACT === "1" || config.allowTextArtifact
  };
}

function compactConfig(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function assertWorkerProtocolCompatibility(provider, model, config = {}) {
  if (provider !== "Kling" || String(model || "").trim() !== "kling-v3") return;
  const preset = String(config.providerPreset || config.preset || "").trim().toLowerCase();
  const endpoint = String(config.videoEndpoint || config.endpoint || "").trim();
  if (isNonDomesticKlingApiEndpoint(endpoint)) {
    throw new Error("Kling 3.0 仅支持国内官方 api-beijing.klingai.com，不支持其他地区的 Kling API endpoint。");
  }
  if (["kling_image_to_video", "kling_image2video"].includes(preset) || /\/v1(?:\/|$)/u.test(endpoint)) {
    throw new Error("Kling 3.0 国内新版 contents 协议不能发送到 2.1/Legacy /v1 endpoint。");
  }
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

function uniquePaths(paths) {
  return [...new Set((paths || []).filter(Boolean))];
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

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value || ""), "utf8"));
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
  if (extension === ".webm") return "video/webm";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".wav") return "audio/wav";
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
    "content.videoUrl", "content.video_url", "content.0.videoUrl", "content.0.video_url",
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
  return ["failed", "failure", "error", "canceled", "cancelled", "expired"];
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
