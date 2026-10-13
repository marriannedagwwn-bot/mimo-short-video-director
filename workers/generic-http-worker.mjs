#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { assertWorkspaceMediaLifetime, requireWorkspaceMediaDirectory } from "../src/workspace-media-lifetime.js";
import {
  assertNoRemovedVideoHttpConfig,
  inferShotVideoProvider,
  normalizeShotVideoProvider,
  shotVideoRuntimeConfig
} from "../src/shot-video-providers.js";
import {
  canonicalShotVideoResolution,
  isShotVideoResolutionOption,
  shotVideoCodeDefaultResolution,
  shotVideoResolutionOptions
} from "../public/shot-video-resolutions.js";

// 这些常量必须声明在下面那句顶层 `if (isMainModule()) await main();` **之前**。
// worker 以子进程运行时，main() 在模块求值到第 55 行时就把整个请求跑完了，此时
// 文件后半部分的 const 还在暂时性死区里——函数声明会提升，const 不会。
// 实测代价：把数组字面量从函数内提成模块常量后，子进程路径每次都抛
// "Cannot access 'MINIMAX_RESOLUTIONS' before initialization"，而 import 调用
// （测试与实验用的路径）因为整个模块先求值完，完全正常，于是掩盖了整整两个提交。
// （分辨率清单 2026-10-10 起改从 public/shot-video-resolutions.js 导入：import 在模块体执行前
// 就已完成，不受这个限制。新增的模块级 const 仍然必须写在 await main() 之前。）

// MiniMax 有两个平级的 API 区域，端点路径与请求体完全一致，只是签发的 API Key
// 各自只在本区域有效：api.minimaxi.com（国内）与 api.minimax.io（国际）。
const MINIMAX_API_HOSTNAMES = Object.freeze(["api.minimaxi.com", "api.minimax.io"]);
const MINIMAX_RATIOS = Object.freeze(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"]);
// MiniMax 的参考音频白名单只有 WAV 和 MP3（官方 video-generation v2 文档，2026-09-02 核对），
// 而它是从 data URL 的 MIME **子类型**反推扩展名的：audio/mpeg 会被读成 ".mpeg" 当场拒绝——
// 实测 2013 `content[3].audio_url: invalid param: audio format ".mpeg" not allowed`，
// 而 audio/mpeg 恰恰是 MP3 的 IANA 标准写法，也是 worker 从 .mp3 文件推出来的那个。
//
// 用它的 withMiniMaxAudioMime() **只改格式标签，不动任何一个字节**，也只作用于 MiniMax
// 这一条传输路径：我们自己的 Artifact 仍然保留 IANA 正确的 audio/mpeg（浏览器里的 <audio>
// 试听依赖它），供应商的解析怪癖在边界上适配，不回头污染事实来源。Seedance 的音频规格
// 未经核对，不在这里一并改——那需要各自的官方依据。
const MINIMAX_AUDIO_MIME_ALIASES = Object.freeze({
  "audio/mpeg": "audio/mp3",
  "audio/mp3": "audio/mp3",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav"
});
// 只剩全能参考一种能力（2026-10-11 删除首尾帧、图片生成、质检与合成等能力）。别的能力名一律明确失败。
const ALL_REFERENCE_VIDEO_CAPABILITY = "all_reference_video_generation";

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.request || !options.output) {
    console.log(`用法：
  node workers/generic-http-worker.mjs --config provider.json --request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>

把镜头视频请求 JSON（全能参考 all_reference_video_generation）转发给 Seedance 2.0 或 MiniMax H3。
供应商配置可以写在 JSON config，或使用 SEEDANCE_* / MINIMAX_* 环境变量。`);
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  let systemProxy;
  try {
    systemProxy = await initializeSystemProxy();
    await executeGenericHttpWorker(options);
  } catch (error) {
    console.error(describeWorkerFailure(error));
    process.exitCode = 1;
  } finally {
    await systemProxy?.close();
  }
}

// worker 是独立进程，错误只能以 stderr 文本回到服务端，所以这里是**唯一**能把原因说清楚的地方。
// 原来只打 error.message：undici 的失败一律是 `TypeError: fetch failed`，真正的原因
// （ECONNRESET / ENOTFOUND / ETIMEDOUT / 证书错误）全在 error.cause 里，被整条丢掉。
// 实测代价：一次批量里 A01 挂在 113 秒、A02 挂在 5 秒——两种完全不同的失败，
// 回到页面上都只剩「fetch failed」四个字，谁也判断不了是提交、轮询还是下载出的问题。
// 纯诊断：不改抛不抛、不改重试预算、不改退出码。
function describeWorkerFailure(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const text = String(current.message || current).trim();
    // undici 会把同一句 "fetch failed" 叠好几层，只有最内层带真正的 code。
    // 外层消息本来就把内层原样包着，所以用子串判断跳过——相等判断抓不到。
    if (text && !parts.some((part) => part.includes(text))) {
      const code = current.code || current.errno || "";
      parts.push(depth === 0 ? text : `底层原因${code ? `（${code}）` : ""}：${text}`);
    }
    current = current.cause;
  }
  return parts.join(" ← ");
}

export async function executeGenericHttpWorker(options = {}) {
  await assertWorkspaceMediaLifetime(options.lifetimeFile);
  const request = typeof options.request === "string"
    ? JSON.parse(await fs.readFile(options.request, "utf8"))
    : options.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("worker request 必须是对象或 JSON 文件路径");
  if (!options.output) throw new Error("worker output 不能为空");
  // 原来没传 --config 时会改读 VIDEO_HTTP_CONFIG 并合并进 Seedance / MiniMax 的请求；还配着就明确失败。
  assertNoRemovedVideoHttpConfig(process.env);
  const config = await loadConfig(options.config || "");
  const result = await executeRequest(request, options, mergeEnvConfig(config, request));
  await writeReceipt(options.receipt, result, options.lifetimeFile);
  return result;
}

if (isMainModule()) await main();

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

async function executeRequest(request, options, config) {
  if (request.capability !== ALL_REFERENCE_VIDEO_CAPABILITY) {
    throw new Error(`worker 只支持 ${ALL_REFERENCE_VIDEO_CAPABILITY}（Seedance 2.0 / MiniMax H3 全能参考），本次请求为 ${request.capability || "空"}；首尾帧等其他能力已删除。`);
  }
  // 自定义请求体模板只服务已删除的自定义 VideoHTTP 供应商。配置里还写着它就明确失败，
  // 不悄悄改用内置的 Seedance / MiniMax 请求体。
  if (config.bodyTemplates?.[request.capability] || config.bodyTemplate) {
    throw new Error("供应商配置里的 bodyTemplate / bodyTemplates 只用于已删除的自定义 VideoHTTP 供应商，Seedance / MiniMax 不支持自定义请求体模板。");
  }
  const endpoint = endpointFor(request.capability, config);
  if (!endpoint) throw new Error(`缺少 ${request.capability || "unknown"} 的 HTTP endpoint`);

  const context = {
    request,
    model: request.model || modelFor(request.capability, config),
    inputArtifacts: await loadInputArtifacts(request.inputArtifacts || [], config),
    root: options.root || "",
    output: options.output
  };
  const body = buildRequestBody(context, config);
  if (isMiniMaxH3VideoGeneration(context.request.capability, config)) {
    assertMiniMaxH3RequestBodySize(body, config);
  }
  const startedAt = Date.now();
  await assertWorkspaceMediaLifetime(options.lifetimeFile);
  const first = await postJson(endpoint, body, config);
  const resolved = await resolveProviderResult(first, context.request, { ...config, resolvedEndpoint: endpoint });
  await writeOutput(resolved, options.output, config, options.lifetimeFile);
  const miniMaxH3Video = isMiniMaxH3VideoGeneration(context.request.capability, config);
  return {
    provider: "generic-http-worker",
    videoProvider: context.request.provider || config.videoProvider || "",
    taskId: context.request.taskId,
    capability: context.request.capability,
    outputKey: context.request.outputKey,
    outputPath: options.output,
    endpoint: redactUrl(endpoint),
    model: context.model,
    // 实际发给供应商的分辨率（2026-10-10）；请求体里没有这个参数时为空串。
    resolution: providerBodyResolution(body),
    audioRequested: miniMaxH3Video || body.generate_audio === true,
    audioOutputMode: miniMaxH3Video
      ? "native"
      : body.generate_audio === true ? "requested" : "none",
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
  if (!endpoint && isVideoGenerationCapability(capability)) endpoint = config.videoEndpoint || config.endpoint;
  if (!endpoint) endpoint = config.endpoint;
  return normalizeEndpointForPreset(capability, endpoint, config);
}

function modelFor(capability, config) {
  const models = config.models || {};
  if (models[capability]) return models[capability];
  if (isVideoGenerationCapability(capability)) return config.videoModel || config.model || "";
  return config.model || "";
}

// 负面词下发（原生字段 / 正向约束 / 模板路径）已随负面词体系删除：请求里那几个字段的唯一生产者是
// 已删除的 public/negative-prompts.js。4.0 镜头从来不带负面词，原来的下发结果对 4.0 恒为「不下发」，
// 所以 Seedance / MiniMax 的 4.0 请求体逐字节不变。
function buildRequestBody(context, config) {
  if (isMiniMaxH3VideoGeneration(context.request.capability, config)) {
    return buildMiniMaxH3VideoBody(context, config);
  }
  if (isModelArkContentGeneration(context.request.capability, config)) {
    return buildModelArkContentGenerationBody(context, config);
  }
  // 原来落到这里会拼一份通用请求体，只服务已删除的自定义 VideoHTTP 供应商。
  throw new Error("供应商配置认不出是 Seedance（ModelArk 内容生成）还是 MiniMax H3：请检查 providerPreset / videoModel / videoEndpoint。");
}

async function resolveProviderResult(first, request, config) {
  if (first.kind !== "json") {
    if (first.kind === "text") {
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
    throw new Error("供应商响应中没有可写入的 mediaUrl/base64，也没有可轮询任务");
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
      throw new Error(`供应商任务失败：${status}${describeProviderTaskFailure(current, request, config)}`);
    }
    artifact = extractArtifact(current, request, config);
    if (artifact) return { ...artifact, providerTaskId };
    if (successStatusesFor(request, config).map(String).map((item) => item.toLowerCase()).includes(status)) {
      throw new Error(`供应商任务已完成，但响应中没有可写入产物：${status}`);
    }
  }
  throw new Error(`供应商任务轮询超时：${providerTaskId || pollTarget}`);
}

function extractArtifact(data, request, config) {
  const url = firstValue(data, resultUrlPathsFor(request, config));
  if (typeof url === "string" && url.trim()) {
    if (url.startsWith("data:")) return { kind: "data_url", dataUrl: url };
    return { kind: "url", url };
  }
  const base64 = firstValue(data, config.resultBase64Paths || defaultResultBase64Paths());
  if (typeof base64 === "string" && base64.trim()) return { kind: "base64", base64 };
  return null;
}

function taskIdPathsFor(request, config) {
  if (config.taskIdPaths) return config.taskIdPaths;
  if (isMiniMaxH3VideoGeneration(request.capability, config)) {
    return uniquePaths(["task_id", ...defaultTaskIdPaths()]);
  }
  return defaultTaskIdPaths();
}

function statusPathsFor(request, config) {
  if (config.statusPaths) return config.statusPaths;
  if (isMiniMaxH3VideoGeneration(request.capability, config)) {
    return uniquePaths(["task.status", ...defaultStatusPaths()]);
  }
  return defaultStatusPaths();
}

function resultUrlPathsFor(request, config) {
  if (config.resultUrlPaths) return config.resultUrlPaths;
  if (isMiniMaxH3VideoGeneration(request.capability, config)) {
    return uniquePaths(["task.content.url", ...defaultResultUrlPaths()]);
  }
  return defaultResultUrlPaths();
}

function successStatusesFor(request, config) {
  if (config.successStatuses) return config.successStatuses;
  return defaultSuccessStatuses();
}

function failureStatusesFor(request, config) {
  if (config.failureStatuses) return config.failureStatuses;
  return defaultFailureStatuses();
}

function pollTargetFor(data, providerTaskId, config) {
  const pollUrl = firstValue(data, config.pollUrlPaths || defaultPollUrlPaths());
  if (typeof pollUrl === "string" && pollUrl.trim()) return pollUrl;
  const template = config.pollEndpointTemplate || "";
  if (template && providerTaskId) return template.replace(/\{taskId\}/gu, encodeURIComponent(providerTaskId));
  // 这里传的 "first_last_frame_video_generation" 是**能力名字面量**，不是视频模式：首尾帧模式
  // 已于 2026-10-11 删除，但这个字面量只用来过 isVideoGenerationCapability 的类型闸门；真正的判定
  // 来自 config 的 preset/model/endpoint，所以全能参考也命中同一条轮询地址。
  // pollTargetFor 拿不到 request，改成透传能力是另一件事，别在这里顺手做。
  if (isMiniMaxH3VideoGeneration("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
    const origin = new URL(String(config.resolvedEndpoint)).origin;
    return `${origin}/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`;
  }
  if (isModelArkContentGeneration("first_last_frame_video_generation", config) && providerTaskId && config.resolvedEndpoint) {
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

function isMiniMaxApiHostname(value) {
  return MINIMAX_API_HOSTNAMES.includes(hostnameFor(value));
}

function isMiniMaxH3VideoGeneration(capability, config) {
  if (!isVideoGenerationCapability(capability)) return false;
  const preset = presetFor(capability, config);
  const model = String(config.videoModel || config.model || "").trim();
  const endpoint = String(config.resolvedEndpoint || config.videoEndpoint || config.endpoint || "");
  return preset === "minimax_h3_video_generation"
    || model === "MiniMax-H3"
    || (isMiniMaxApiHostname(endpoint) && /\/v2\/video_generation\/?$/u.test(endpoint));
}

// "first_last_frame_video_generation" 留在这里只因为 pollTargetFor 用它当能力名字面量过类型闸门
// （见那里的注释）；executeRequest 入口只放行全能参考，首尾帧请求走不到这里。
function isVideoGenerationCapability(capability) {
  return ["first_last_frame_video_generation", "all_reference_video_generation"].includes(capability);
}

function normalizeEndpointForPreset(capability, endpoint, config) {
  if (!endpoint) return endpoint;
  if (isMiniMaxH3VideoGeneration(capability, { ...config, videoEndpoint: endpoint, endpoint })) {
    const clean = String(endpoint).replace(/\/$/u, "");
    try {
      const parsed = new URL(clean);
      if (MINIMAX_API_HOSTNAMES.includes(parsed.hostname)) {
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
  if (!isModelArkContentGeneration(capability, config)) return endpoint;
  const clean = String(endpoint).replace(/\/$/u, "");
  if (/\/contents\/generations\/tasks$/u.test(clean)) return clean;
  if (/\/api\/v3$/u.test(clean)) return `${clean}/contents/generations/tasks`;
  return endpoint;
}

function buildModelArkContentGenerationBody(context, config) {
  const artifacts = context.inputArtifacts || [];
  const prompt = String(context.request.prompt || "");
  const parameters = context.request.parameters || {};
  const content = buildAllReferenceContent(artifacts, prompt, "Seedance 2.0");
  const body = {
    model: context.model || config.model || undefined,
    content,
    ratio: normalizeSeedanceRatio(parameters.aspectRatio || config.ratio),
    duration: normalizeSeedanceDuration(
      Object.hasOwn(parameters, "durationSeconds") ? parameters.durationSeconds : config.duration
    ),
    watermark: config.watermark === true,
    generate_audio: config.generateAudio !== false,
    return_last_frame: config.returnLastFrame === true
  };
  body.resolution = resolveBodyResolution({
    provider: "Seedance", model: body.model, label: "Seedance", envName: "SEEDANCE_VIDEO_RESOLUTION", parameters, config
  });
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

// 白名单与依据见文件顶部的 MINIMAX_AUDIO_MIME_ALIASES（必须声明在 await main() 之前）。
function withMiniMaxAudioMime(artifacts) {
  return artifacts.map((artifact) => {
    if (String(artifact?.mediaType || "").trim().toLowerCase() !== "audio") return artifact;
    const dataUrl = firstArtifactDataUrl(artifact);
    const declared = String(dataUrl.match(/^data:([^;,]+)[;,]/u)?.[1] || artifact.mimeType || "").toLowerCase();
    const accepted = MINIMAX_AUDIO_MIME_ALIASES[declared];
    if (!accepted) {
      // 送出去只会换回一句不知所云的 2013，不如在这里说清楚它不收哪种格式。
      throw new Error(
        `MiniMax H3 参考音频只接受 WAV 与 MP3，${artifact.filename || "该音频"} 的格式是「${declared || "未知"}」，不能提交。`
      );
    }
    if (declared === accepted) return artifact;
    return { ...artifact, dataUrl: dataUrl.replace(/^data:[^;,]+/u, `data:${accepted}`) };
  });
}

function buildMiniMaxH3VideoBody(context, config) {
  const artifacts = withMiniMaxAudioMime(context.inputArtifacts || []);
  const prompt = requireTextWithinLimit(
    String(context.request.prompt || ""),
    miniMaxH3PromptMaxChars(config),
    "MiniMax H3 视频提示词"
  );
  const parameters = context.request.parameters || {};
  const duration = Object.hasOwn(parameters, "durationSeconds")
    ? parameters.durationSeconds
    : config.duration;
  const content = buildAllReferenceContent(artifacts, prompt, "MiniMax H3", { maxTotal: 12 });
  return {
    model: context.model || config.model || "MiniMax-H3",
    content,
    resolution: resolveBodyResolution({
      provider: "MiniMax", model: "MiniMax-H3", label: "MiniMax H3", envName: "MINIMAX_VIDEO_RESOLUTION", parameters, config
    }),
    duration: normalizeMiniMaxDuration(duration),
    ratio: normalizeMiniMaxRatio(parameters.aspectRatio || config.ratio),
    aigc_watermark: config.watermark === true
  };
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

// -1 是 Ark 的"由模型自行决定时长"，只有在请求没有给出镜头时长时才可能出现。
// 其余情况一律按供应商公开的 4–15 秒整数硬校验：Plan 的时长是权威事实，
// 静默 clamp 会让一个 3 秒的镜头变成 4 秒的成片，属于隐蔽改写。
function normalizeSeedanceDuration(value) {
  const seconds = Number(value);
  if (seconds === -1) return -1;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error("Seedance duration 必须是 4–15 秒整数，不能静默改写时长。");
  }
  return seconds;
}

function normalizeSeedanceRatio(value) {
  const ratio = String(value || "adaptive").trim().toLowerCase();
  return ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(ratio)
    ? ratio
    : "adaptive";
}

function normalizeMiniMaxDuration(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error("MiniMax H3 duration 必须是 4–15 秒整数，不能静默改写时长。");
  }
  return seconds;
}

/**
 * 分辨率（2026-10-10 起共用这一个函数，清单只在 public/shot-video-resolutions.js 一份）。
 *
 * 这次请求选了（parameters.resolution）就严格按请求：必须逐字是这个模型清单里的写法。
 * 没选就用配置值（供应商配置文件 > 环境变量，大小写不敏感），没配用代码默认值。
 * 未配置时用默认值是缺省；**已显式配置或选择却非法时必须明确失败**。
 *
 * 原来的写法一律静默回退：MiniMax 的 `.env` 里那个 `MINIMAX_VIDEO_RESOLUTION=1080K` 被悄悄改成了 2K，
 * Seedance 的任意错值被悄悄改成 720p——计费与产出都和用户以为的不是一回事。
 * CLAUDE.md 五、第 4 条：失败时返回默认值是错的，明确报错才是对的。
 */
function resolveBodyResolution({ provider, model, label, envName, parameters = {}, config = {} }) {
  const options = shotVideoResolutionOptions(provider, model);
  if (Object.hasOwn(parameters, "resolution")) {
    const requested = parameters.resolution;
    if (!isShotVideoResolutionOption(provider, model, requested)) {
      throw new Error(`${label} resolution 只支持 ${options.join(" 或 ")}，本次请求为“${String(requested)}”；不会静默改写分辨率。`);
    }
    return requested;
  }
  const configured = String(config.resolution ?? "").trim();
  if (!configured) return shotVideoCodeDefaultResolution(provider, model);
  const resolution = canonicalShotVideoResolution(provider, model, configured);
  if (!resolution) {
    throw new Error(
      `${label} resolution 只支持 ${options.join(" 或 ")}，当前配置为“${configured}”；请修正 ${envName}，不会静默改写分辨率。`
    );
  }
  return resolution;
}

function providerBodyResolution(body = {}) {
  const value = body?.resolution;
  return typeof value === "string" ? value : "";
}

/**
 * MiniMax H3 画幅：未配置时用默认值是缺省；**已显式配置却非法时必须明确失败**
 * （原来任意错值静默回退成 adaptive）。
 */
function normalizeMiniMaxRatio(value) {
  const configured = String(value ?? "").trim();
  if (!configured) return "adaptive";
  const ratio = configured.toLowerCase();
  if (!MINIMAX_RATIOS.includes(ratio)) {
    throw new Error(
      `MiniMax H3 ratio 只支持 ${MINIMAX_RATIOS.join(" / ")}，当前为“${configured}”；不会静默改写画幅。`
    );
  }
  return ratio;
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

async function writeOutput(result, outputPath, config, lifetimeFile) {
  if (lifetimeFile) await requireWorkspaceMediaDirectory(path.dirname(path.resolve(outputPath)), lifetimeFile);
  else await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  if (result.kind === "url") {
    await downloadToFile(result.url, outputPath, config, lifetimeFile);
  } else if (result.kind === "data_url") {
    const [, payload = ""] = result.dataUrl.split(",", 2);
    await fs.writeFile(outputPath, Buffer.from(payload, "base64"));
  } else if (result.kind === "base64") {
    await fs.writeFile(outputPath, Buffer.from(stripDataUrlPrefix(result.base64), "base64"));
  } else if (result.kind === "binary") {
    await fs.writeFile(outputPath, result.buffer);
  } else {
    // 原来还会把 JSON / 纯文本当产物写出（质检、合成等已删除能力用）；镜头视频只接受媒体。
    throw new Error(`供应商返回的产物类型 ${result.kind || "未知"} 不是视频媒体，不能写入。`);
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
    const response = await withRequestContext(
      `${init.method === "POST" ? "提交任务" : "轮询任务状态"}（${hostnameFor(url) || url}）`,
      () => fetch(url, { ...init, signal: controller.signal })
    );
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

// 失败时补一句「哪一步、打的哪个 host」。`fetch failed` 不说是提交、轮询还是下载，
// 而这三步的处理方式完全不同（提交失败可以直接重来，下载失败意味着供应商很可能已经出片并计费）。
// 只在抛错路径上拼字符串，成功路径零开销；原始错误挂在 cause 上，一个字都不丢。
async function withRequestContext(label, run) {
  try {
    return await run();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`${label}失败：${error?.message || error}`, { cause: error });
  }
}

async function downloadToFile(url, outputPath, config, lifetimeFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs || 120000));
  try {
    const response = await withRequestContext(
      `下载成片（${hostnameFor(url) || url}）`,
      () => fetch(url, { headers: downloadHeadersFor(config), signal: controller.signal })
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`下载产物失败 HTTP ${response.status}: ${buffer.toString("utf8").slice(0, 1000)}`);
    // The original Node parent may already be gone. Do not create directories:
    // cleanup can remove the Run while this independent worker downloads bytes.
    await assertWorkspaceMediaLifetime(lifetimeFile);
    await fs.writeFile(outputPath, buffer);
  } finally {
    clearTimeout(timer);
  }
}

function downloadHeadersFor(config) {
  if (config.authOnDownload === true) return headersFor(config);
  return { ...(config.downloadHeaders || {}) };
}

async function writeReceipt(receiptPath, result, lifetimeFile) {
  if (!receiptPath) return;
  if (lifetimeFile) await requireWorkspaceMediaDirectory(path.dirname(path.resolve(receiptPath)), lifetimeFile);
  else await fs.mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
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
  const requestedName = String(request.provider || "").trim();
  const requestedProvider = normalizeShotVideoProvider(requestedName);
  // 只剩 Seedance 与 MiniMax。点名了别的供应商，或请求与配置都认不出是哪家，一律明确失败——
  // 原来认不出时会回落成自定义 VideoHTTP，已于 2026-10-11 删除。
  if (requestedName && !requestedProvider) {
    throw new Error(`不支持镜头视频供应商「${requestedName}」：worker 只支持 Seedance 或 MiniMax。`);
  }
  const inferredProvider = inferShotVideoProvider({
    model: request.model || config.videoModel || config.model,
    preset: config.providerPreset || config.preset
  });
  const provider = requestedProvider || inferredProvider;
  if (!provider) {
    throw new Error("worker 请求没有指定供应商，配置里的 videoModel / providerPreset 也认不出是 Seedance 还是 MiniMax。");
  }
  const base = shotVideoRuntimeConfig(provider, process.env, request.model || config.videoModel || config.model);
  return {
    ...compactConfig(base),
    ...config,
    videoProvider: provider,
    videoModel: request.model || config.videoModel || base.videoModel || base.model || "",
    maxInputDataUrlBytes: process.env.VIDEO_HTTP_MAX_INPUT_DATA_URL_BYTES || config.maxInputDataUrlBytes,
    includeInputDataUrls: process.env.VIDEO_HTTP_INCLUDE_INPUT_DATA_URLS === "0" ? false : config.includeInputDataUrls
  };
}

function compactConfig(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
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

function stripDataUrlPrefix(value) {
  return String(value || "").includes(",") ? String(value).split(",", 2)[1] : String(value || "");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
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

function defaultSuccessStatuses() {
  return ["succeeded", "success", "completed", "complete", "done", "finished"];
}

function defaultFailureStatuses() {
  return ["failed", "failure", "error", "canceled", "cancelled", "expired"];
}

function defaultFailureReasonPaths() {
  return [
    // MiniMax v2：task.error.{code,message}
    "task.error.message", "task.error.code",
    // Ark / OpenAI 兼容：error.message
    "error.message", "error.code",
    "data.error.message", "data.message", "message",
    "result.error.message", "result.message"
  ];
}

/**
 * 轮询到失败状态时，把供应商给出的原因**逐字**附在错误后面。
 *
 * 只带状态字面量（"供应商任务失败：failed"）等于把供应商已经说清楚的原因丢掉，
 * 用户看不到任何可执行信息——这正是 CLAUDE.md 五、第 4 条说的隐藏错误。实测
 * MiniMax 会返回 `task.error = {code:"2013", message:"content[1].image_url:
 * invalid param: image size 64x64, expected each side in [256, 5760]"}`，
 * 不带出来就完全排查不动。
 *
 * 按 5.1 的规矩：原文逐字保留，不改写、不翻译、不猜测；取不到就什么都不加。
 */
function describeProviderTaskFailure(payload, request, config) {
  const paths = config.failureReasonPaths || defaultFailureReasonPaths();
  const seen = [];
  for (const path of paths) {
    const value = firstValue(payload, [path]);
    if (value === null || value === undefined) continue;
    const text = String(typeof value === "object" ? JSON.stringify(value) : value).trim();
    if (text && !seen.includes(text)) seen.push(text);
  }
  const summary = seen.length ? `（供应商原文：${seen.join(" / ")}）` : "";
  // 再把供应商的错误对象原样附在末尾。worker 是独立进程，错误只能以 stderr
  // 文本回到服务端，所以结构化信息必须搭在这条消息里：src/provider-error-codes.js
  // 的 splitTransportPrefix 从第一个 { 起解析，据此才查得到官方码表
  // （例如 1027 → 「输出内容涉敏被拦截」）。没有它，轮询失败一律查不到码，
  // 用户只能看到一串原文、拿不到下一步该做什么。
  const errorObject = firstValue(payload, ["task.error", "error", "data.error"]);
  const structured = errorObject && typeof errorObject === "object"
    ? ` ${JSON.stringify({ error: errorObject })}`
    : "";
  return `${summary}${structured}`;
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
    else if (arg === "--lifetime-file") parsed.lifetimeFile = requireValue(args, ++index, arg);
    else if (arg.startsWith("--lifetime-file=")) parsed.lifetimeFile = arg.slice("--lifetime-file=".length);
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
