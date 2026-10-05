import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ALL_REFERENCE_MAX_AUDIOS,
  ALL_REFERENCE_MAX_IMAGES,
  ALL_REFERENCE_MAX_VIDEO_BYTES,
  ALL_REFERENCE_MAX_VIDEOS,
  ALL_REFERENCE_MEDIA_MAX_SECONDS,
  ALL_REFERENCE_MEDIA_MIN_SECONDS,
  ALL_REFERENCE_MEDIA_TOTAL_SECONDS,
  MINIMAX_H3_MAX_TOTAL_ASSETS
} from "../public/all-reference-limits.js";
import { assertMiniMaxH3Duration } from "./minimax-h3-prompt.js";
import { createUniqueDirectory } from "./unique-directory.js";
import {
  buildReferenceManifestText,
  mediaFilenameSegment,
  normalizeShotVideoContinuityReferenceMode,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
} from "./shot-video-continuity.js";
import {
  assertShotVideoDurationSupported,
  inferShotVideoProvider,
  isShotVideoModelAllowed,
  normalizeShotVideoGenerationMode,
  normalizeShotVideoProvider,
  resolveShotVideoRequestResolution,
  resolveShotVideoSetting,
  shotVideoRuntimeConfig
} from "./shot-video-providers.js";
import { ProductionStateError } from "./production-lineage.js";
import { afterDurableProviderCall, beforeDurableProviderCall } from "./durable-task-context.js";
import { assertWorkspaceMediaLifetime, requireWorkspaceMediaDirectory } from "./workspace-media-lifetime.js";

const execFileAsync = promisify(execFile);

export class ShotVideoConfigError extends Error {}
export class ShotVideoProviderError extends Error {}

const SHOT_VIDEO_ASPECT_RATIOS = Object.freeze(["9:16", "16:9"]);

export function normalizeShotVideoAspectRatio(value, { defaultValue = "9:16" } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) return defaultValue;
  if (!SHOT_VIDEO_ASPECT_RATIOS.includes(normalized)) {
    throw new ShotVideoConfigError(`aspectRatio 只允许 ${SHOT_VIDEO_ASPECT_RATIOS.join(" 或 ")}`);
  }
  return normalized;
}

export async function generateShotVideo(options = {}) {
  const shot = options.shot || {};
  // 只剩 Seedance 与 MiniMax。显式点名了别的供应商（例如已删除的可灵 / VideoHTTP）就明确失败，
  // 不悄悄改用默认供应商。
  const requestedProviderName = String(options.videoProvider || "").trim();
  if (requestedProviderName && !normalizeShotVideoProvider(requestedProviderName)) {
    throw new ShotVideoConfigError(`不支持镜头视频供应商“${requestedProviderName}”：只支持 Seedance 或 MiniMax。`);
  }
  const requestedSetting = resolveShotVideoSetting({
    provider: options.videoProvider,
    model: options.videoModel
  });
  const requestedRuntime = shotVideoRuntimeConfig(requestedSetting.provider, process.env, requestedSetting.model);
  const configPath = options.configPath || requestedRuntime.configPath || "";
  const config = await loadProviderConfig(configPath);
  const explicitProvider = normalizeShotVideoProvider(options.videoProvider);
  const configProvider = inferShotVideoProvider({
    model: options.videoModel || config.videoModel || config.model,
    preset: config.providerPreset || config.preset
  });
  // 原来「给了配置文件、认不出是哪家、也没指定供应商」会当成自定义 VideoHTTP；VideoHTTP 已删除，
  // 这里明确失败，不拿默认供应商去套一份认不出的配置文件。
  if (options.configPath && !explicitProvider && !configProvider) {
    throw new ShotVideoConfigError(`供应商配置文件 ${options.configPath} 认不出是 Seedance 还是 MiniMax（看 videoModel / providerPreset），请求也没有指定供应商。`);
  }
  const videoProvider = explicitProvider || configProvider || requestedSetting.provider;
  const providerDefaultModel = shotVideoRuntimeConfig(videoProvider).model;
  const videoModel = String(
    options.videoModel
    || config.videoModel
    || config.model
    || providerDefaultModel
    || requestedSetting.model
    || ""
  ).trim();
  const providerRuntime = shotVideoRuntimeConfig(videoProvider, process.env, videoModel);
  const generationMode = normalizeShotVideoGenerationMode(options.generationMode);
  const continuityReferenceMode = normalizeShotVideoContinuityReferenceMode(options.continuityReferenceMode);
  const aspectRatio = normalizeShotVideoAspectRatio(options.aspectRatio);
  const miniMaxH3Runtime = videoProvider === "MiniMax" && videoModel === "MiniMax-H3";
  // 镜头时长由 Plan 唯一决定；这里只复核当前供应商能不能原样渲染它。
  // H3 保留自己的诊断码，其余供应商走统一能力表，都不做任何钳制。
  if (miniMaxH3Runtime) {
    try {
      assertMiniMaxH3Duration(shot.durationSeconds, "shot.durationSeconds");
    } catch (error) {
      throw new ShotVideoConfigError(error.message);
    }
  } else {
    assertShotVideoDurationSupported(videoProvider, videoModel, shot.durationSeconds, {
      path: "shot.durationSeconds",
      ErrorType: ShotVideoConfigError
    });
  }
  // 只剩全能参考一种模式（2026-10-11 删除首尾帧 first_last_frame）。没带或带了别的模式都明确失败，
  // 不静默改写成全能参考。
  if (!generationMode) {
    throw new ShotVideoConfigError(
      `镜头视频只支持全能参考（all_reference）模式，本次请求的 generationMode 为“${String(options.generationMode ?? "")}”；首尾帧（first_last_frame）模式已删除，不会改用其他模式。`
    );
  }
  if (!isShotVideoModelAllowed(videoProvider, videoModel)) {
    throw new ShotVideoConfigError(`${videoProvider} 不支持视频模型“${videoModel}”。`);
  }
  if (
    continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
    && !options.trustedPreviousShotReference
  ) {
    throw new ShotVideoConfigError("上一镜抽帧缺少当前 Plan 签发的受信视频来源。");
  }
  if (!providerAuthConfigured(config, providerRuntime)) {
    throw new ShotVideoConfigError(`未配置 ${videoProvider} API Key。请设置对应 provider API Key，或在 provider config 中提供认证信息。`);
  }
  if (!videoEndpointConfigured(config, providerRuntime)) {
    throw new ShotVideoConfigError(`未配置 ${videoProvider} 全能参考视频生成服务。请设置对应 provider endpoint/API Key，或设置 provider config 指向有效 JSON。`);
  }
  assertAllReferenceRequestSize(options);
  // 分辨率（2026-10-10）：服务端建任务前已经校验过一次；这里在建工作目录、调用供应商之前，
  // 按实际读到的供应商配置文件再核对一次（直接调用本函数的路径、只有配置文件知道默认值的情况）。
  // 只有用户这次明确选了才写进发给 worker 的请求；没选时请求逐字不变，由 worker 按配置决定。
  const resolution = resolveShotVideoRequestResolution({
    provider: videoProvider,
    model: videoModel,
    input: options,
    fileConfig: configPath ? config : null,
    configPath,
    createError: (message, details) => new ProductionStateError(message, details)
  });

  const outputRoot = options.outputRoot || path.resolve("public/generated-videos");
  const publicBasePath = options.publicBasePath || "/generated-videos";
  const shotId = safeSegment(shot.shotId || "shot");
  const filenamePrefix = options.filenamePrefix ? `${safeSegment(options.filenamePrefix)}-` : "";
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const requestNonce = safeSegment(options.requestNonce || randomUUID());
  const workDir = await createShotVideoWorkDirectory(options);
  const count = clampVideoCount(options.count);
  // 供应商要跑几分钟，这期间用户可能重新生成 Plan 或切换上一镜候选。只靠事后
  // 关卡（浏览器 assertPlanProductionContextCurrent、commitProductionArtifact 的
  // expectedCurrentRevision）只能挡住旧结果成为 current Artifact，挡不住无效付费、
  // 孤儿文件和过期成功结果回到 UI，所以生成期间必须自己复验。
  const writtenOutputPaths = [];
  const assertCurrentOrDiscard = async () => {
    try {
      await assertWorkspaceMediaLifetime(options.lifetimeFile);
      if (typeof options.assertProductionContextCurrent === "function") await options.assertProductionContextCurrent();
    } catch (error) {
      await discardStaleShotVideoOutputs(writtenOutputPaths);
      // 原样上抛：ProductionStateError 一旦被包成 ShotVideoConfigError/
      // ShotVideoProviderError，serializeServerError 就判不出 409 和 stale code。
      throw error;
    }
  };

  try {
    // ① 任何供应商调用与文件写入之前。
    await assertCurrentOrDiscard();
    if (options.lifetimeFile) await requireWorkspaceMediaDirectory(outputRoot, options.lifetimeFile);
    else await fs.mkdir(outputRoot, { recursive: true });
    const uploadedArtifacts = await prepareAllReferenceArtifacts(options.referenceAssets, workDir);
    const continuityReference = continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
      ? await preparePreviousShotFrameArtifacts({
        reference: options.trustedPreviousShotReference,
        workDir,
        extractor: options.previousShotFrameExtractor
      })
      : null;
    const inputArtifacts = [
      ...uploadedArtifacts,
      ...(continuityReference?.artifacts || [])
    ];
    validateAllReferenceArtifacts(inputArtifacts, {
      maxTotal: miniMaxH3Runtime ? MINIMAX_H3_MAX_TOTAL_ASSETS : Number.POSITIVE_INFINITY
    });
    // 参考素材清单前置：服务端已经知道每张素材是什么，不写进正文模型就无从分辨。
    // 放在正文之前而不是之后，是为了让 backgroundMusicMode=none 的禁配乐句仍然是
    // 整条提示词的最后一句（CLAUDE.md 2.4 的逐字收尾语义）。
    const referenceManifest = buildReferenceManifestText(inputArtifacts);
    //
    // 清单的安全性来自构造而不是事后校验：文本只由受控来源枚举、Plan 权威的
    // sourceCharacterName 和 lineage 解析出的 sourceShotId 拼成，上传素材的原始
    // 文件名（唯一的注入面）永远不进入。这里**不**补 ensureCharacterPromptMatchesBoundary：
    // 视频提示词天然是多角色的，走的是 promptScope="multi_character"，而该分支在
    // validation.js 里无条件短路返回空串，加上去只是一个看起来像闸门的空操作。
    let effectiveVideoPrompt = [referenceManifest, String(shot.videoPrompt || "").trim()]
      .filter(Boolean)
      .join("\n");
    const videos = [];
    for (let index = 0; index < count; index += 1) {
      // ② 提交这一条候选给供应商之前：过期就不再产生新的付费调用。
      await assertCurrentOrDiscard();
      const suffix = count > 1 ? `-${index + 1}` : "";
      const outputPath = path.join(outputRoot, `${filenamePrefix}${shotId}-${stamp}-${requestNonce}${suffix}.mp4`);
      // 先登记再调用：worker 半途写了一半的文件也要进清理范围。
      writtenOutputPaths.push(outputPath);
      const request = buildShotVideoRequest(shot, {
        outputPath,
        inputArtifacts,
        candidateIndex: index,
        candidateCount: count,
        provider: videoProvider,
        model: videoModel,
        aspectRatio,
        prompt: effectiveVideoPrompt,
        resolution: resolution.explicit ? resolution.value : ""
      });
      const providerTimeoutMs = Number(providerRuntime.pollTimeoutMs || config.pollTimeoutMs || 900_000);
      await beforeDurableProviderCall(`video_provider_candidate_${index + 1}`, providerTimeoutMs);
      const receipt = await runGenericWorker({ request, outputPath, workDir, configPath, workerRunner: options.workerRunner, lifetimeFile: options.lifetimeFile });
      await afterDurableProviderCall(`video_provider_candidate_${index + 1}_returned`, {
        candidateIndex: index,
        candidateCount: count
      });
      const measured = await assertUsableVideoOutput(outputPath, {
        outputProbe: options.videoOutputProbe,
        skipFfprobeForInjectedWorker: Boolean(options.workerRunner) && !options.videoOutputProbe
      });
      // ③ 这一条已经落盘：过期就把本次写入的全部候选删掉，不留孤儿文件。
      await assertCurrentOrDiscard();
      videos.push({
        candidateIndex: index,
        // 供应商实际产出的时长，与 Plan 要求的时长并列记录。
        // 两者不等**不是失败**：实测 MiniMax H3 请求 5 秒稳定产出 5.167 秒
        // （9/9 完全一致），请求 4 秒得 4.458 秒——这是供应商的确定性行为，
        // 硬失败会让该供应商 100% 不可用，重生成也拿不到不同结果。
        // 这里只负责让偏差不再是静默的：数值如实上报，是否、如何对齐成片总长
        // 属于契约决定（容差多少、失败还是告警、以谁为准），不在这里替它选。
        plannedDurationSeconds: Number(shot.durationSeconds) || 0,
        measuredDurationSeconds: measured.durationSeconds,
        // 分辨率（2026-10-10）：实际发给供应商的值取自 worker 回执（就是请求体里那个），
        // 实测宽高来自 ffprobe，量不到记 0。两者对不上只并列记录、不判失败：
        // 「2K」这类叫法对应多少像素没有权威换算（与上面的时长同一态度）。
        resolution: typeof receipt?.resolution === "string" ? receipt.resolution : "",
        measuredWidth: measured.width,
        measuredHeight: measured.height,
        provider: videoProvider,
        model: videoModel,
        taskId: request.taskId,
        outputUrl: `${publicBasePath}/${path.basename(outputPath)}`,
        outputPath,
        receipt,
        generatedAt: new Date().toISOString()
      });
    }
    // ④ 组装返回值之前：过期的成功结果不许回到 UI。
    await assertCurrentOrDiscard();
    const firstVideo = videos[0] || {};
    return {
      taskId: firstVideo.taskId || `${shot.shotId || "SHOT"}-VIDEO-PREVIEW`,
      shotId: shot.shotId || "",
      provider: videoProvider,
      model: videoModel,
      generationMode,
      resolution: firstVideo.resolution || "",
      referenceSummary: summarizeReferenceArtifacts(inputArtifacts),
      referenceManifest,
      videoPromptSource: options.videoPromptSource === "runtime_override" ? "runtime_override" : "animation_plan",
      sourceVideoPrompt: String(shot.videoPrompt || ""),
      effectiveVideoPrompt,
      continuityReferenceReceipt: continuityReference
        ? {
          mode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
          continuityType: continuityReference.reference.continuityType || "intentional_next_shot",
          sourceShotId: continuityReference.reference.sourceShotId,
          sourceSceneId: continuityReference.reference.sourceSceneId || "",
          sceneId: continuityReference.reference.sceneId || "",
          selectedIndex: continuityReference.reference.selectedIndex,
          sourceOutputUrl: continuityReference.reference.sourceOutputUrl,
          sourceArtifact: continuityReference.reference.sourceArtifact,
          sourceVideoSha256: continuityReference.sourceVideoSha256,
          frameIntervalSeconds: 1,
          frameCount: continuityReference.artifacts.length,
          sourceDurationSeconds: continuityReference.durationSeconds,
          frames: continuityReference.artifacts.map((artifact) => ({
            timestampSeconds: artifact.timestampSeconds,
            sha256: artifact.sha256
          }))
        }
        : null,
      outputUrl: firstVideo.outputUrl || "",
      outputPath: firstVideo.outputPath || "",
      count,
      actualCount: videos.length,
      videos,
      receipt: firstVideo.receipt || {},
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    // A cancelled/deleted workspace can fail the durable post-provider check
    // before assertCurrentOrDiscard runs. Remove late worker outputs as well.
    if (options.lifetimeFile) await discardStaleShotVideoOutputs(writtenOutputPaths);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function createShotVideoWorkDirectory(options) {
  if (!options.workRoot) {
    if (options.lifetimeFile) throw new ShotVideoConfigError("页面工作区的视频生成必须指定私有 workRoot");
    return fs.mkdtemp(path.join(os.tmpdir(), "shot-video-"));
  }
  const workRoot = path.resolve(options.workRoot);
  await assertWorkspaceMediaLifetime(options.lifetimeFile);
  if (options.lifetimeFile && path.dirname(workRoot) !== path.dirname(path.resolve(options.lifetimeFile))) {
    throw new ShotVideoConfigError("页面工作区的 workRoot 必须位于当前 Run 目录内");
  }
  try {
    // Never recreate a deleted Run ancestor after its lifetime check.
    await fs.mkdir(workRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await requireWorkspaceMediaDirectory(workRoot, options.lifetimeFile);
  // Run 内路径较深；fs.mkdtemp 在 Windows 上 ~248 字符即失败，见 src/unique-directory.js。
  return createUniqueDirectory(path.join(workRoot, "shot-video-"));
}

// 发给视频模型的提示词正文（参考素材清单之外的部分）。只剩全能参考，原来首尾帧模式下
// 附加的 startFramePrompt / endFramePrompt 已随首尾帧删除。
export function shotVideoGenerationPromptText(options = {}) {
  const shot = options.shot || {};
  return [shot.videoPrompt].map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

// Plan 的 durationSeconds 是唯一权威。缺失或非法时必须明确失败，
// 不能像过去那样悄悄回落到 4 秒——那会把一个契约错误变成一段错时长的成片。
function requireShotDurationSeconds(shot) {
  const duration = Number(shot?.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ShotVideoConfigError(
      `镜头 ${shot?.shotId || "未知"} 缺少有效的 durationSeconds，无法提交视频生成；时长必须来自当前 Animation Plan。`
    );
  }
  return duration;
}

function buildShotVideoRequest(shot = {}, context = {}) {
  const candidateIndex = Number(context.candidateIndex) || 0;
  const candidateCount = Number(context.candidateCount) || 1;
  const candidateSuffix = candidateCount > 1 ? `-${candidateIndex + 1}` : "";
  return {
    version: "1.0",
    providerMode: "provider_agnostic",
    taskId: `${shot.shotId || "SHOT"}-VIDEO-PREVIEW${candidateSuffix}`,
    type: "all_reference_video",
    capability: "all_reference_video_generation",
    status: "ready",
    inputType: "multimodal_reference_to_video",
    outputKey: `preview.${safeSegment(shot.shotId || "shot")}`,
    outputPath: context.outputPath,
    provider: context.provider || "",
    model: context.model || "",
    prompt: Object.hasOwn(context, "prompt") ? String(context.prompt || "") : shot.videoPrompt || "",
    inputArtifacts: context.inputArtifacts || [],
    parameters: {
      aspectRatio: context.aspectRatio || "9:16",
      durationSeconds: requireShotDurationSeconds(shot),
      shotId: shot.shotId || "",
      sourceSceneId: shot.sourceSceneId || "",
      cameraMotion: shot.cameraMotion || "",
      characterAction: shot.characterAction || "",
      dialogueOrSubtitle: shot.dialogueOrSubtitle || "",
      soundDesign: shot.soundDesign || "",
      continuityNotes: shot.continuityNotes || "",
      candidateIndex,
      candidateCount,
      generationMode: "all_reference",
      // 只在用户这次明确选了分辨率时才有这个键（2026-10-10），没选时请求 JSON 与之前逐字相同。
      ...(context.resolution ? { resolution: context.resolution } : {})
    },
    acceptanceCriteria: shot.acceptanceCriteria || [],
    rawJob: shot
  };
}

/**
 * 删除本次调用**自己算出的**候选文件。只在生产上下文过期时调用。
 *
 * 这些路径都含 requestNonce，不可能撞上并发请求的产物；绝不扫描或 glob 目录。
 * 删除失败只吞掉：清理是尽力而为，不能改变 fail closed 的结论。
 */
async function discardStaleShotVideoOutputs(outputPaths = []) {
  for (const outputPath of outputPaths) {
    try {
      await fs.rm(outputPath, { force: true });
    } catch {
      // 忽略：文件不存在、权限问题都不应影响过期错误的上抛。
    }
  }
}

async function assertUsableVideoOutput(outputPath, { outputProbe, skipFfprobeForInjectedWorker = false } = {}) {
  let stat;
  try {
    stat = await fs.stat(outputPath);
  } catch {
    throw new ShotVideoProviderError("视频生成服务没有写入视频文件。");
  }
  if (!stat.isFile() || stat.size < 8) {
    throw new ShotVideoProviderError(`视频生成服务返回的文件过小，疑似不是可播放视频（${stat?.size || 0} bytes）。`);
  }
  const file = await fs.open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(256, stat.size));
    await file.read(buffer, 0, buffer.length, 0);
    const sample = buffer.toString("utf8").replace(/\0/gu, "").trim().toLowerCase();
    if (stat.size < 512 && /^(ok|success|done|accepted|created|queued|true)$/u.test(sample)) {
      throw new ShotVideoProviderError(`视频生成服务只返回了任务确认文本“${sample}”，没有返回视频文件。请配置轮询结果接口或正确的视频结果字段。`);
    }
    if (/^[{[]/u.test(sample)) {
      throw new ShotVideoProviderError("视频生成服务返回了 JSON 文本而不是视频文件。请配置 resultUrlPaths / resultBase64Paths / pollEndpointTemplate。");
    }
  } finally {
    await file.close();
  }
  // 返回实测时长与宽高供调用方如实记录。注入的 outputProbe 可以只给时长（数字），也可以给
  // { durationSeconds, width, height }；取不到的项视为「这条链路测不出」记 0——0 表示未测得，不表示为零。
  if (typeof outputProbe === "function") {
    const probed = await outputProbe(outputPath);
    if (probed && typeof probed === "object") {
      return {
        durationSeconds: positiveNumberOrZero(probed.durationSeconds),
        width: Math.round(positiveNumberOrZero(probed.width)),
        height: Math.round(positiveNumberOrZero(probed.height))
      };
    }
    return { durationSeconds: positiveNumberOrZero(probed), width: 0, height: 0 };
  }
  if (!skipFfprobeForInjectedWorker) return probePlayableVideoOutput(outputPath);
  return { durationSeconds: 0, width: 0, height: 0 };
}

function positiveNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// ffprobe 输出里取时长与画面宽高（2026-10-10 起多取宽高，用来如实记录实测分辨率）。
// 缺视频流、时长无效仍然失败；宽高取不到记 0，不判失败。宽高是编码尺寸，不按旋转元数据换算。
export function parseVideoProbeMetadata(metadata = {}) {
  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videoStreams = streams.filter((stream) => stream?.codec_type === "video");
  if (!videoStreams.length) throw new Error("缺少视频流");
  const durationSeconds = videoStreams
    .map((stream) => Number(stream.duration))
    .find((value) => Number.isFinite(value) && value > 0)
    || Number(metadata.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("视频时长无效");
  const sized = videoStreams.find((stream) => Number(stream.width) > 0 && Number(stream.height) > 0);
  return {
    durationSeconds,
    width: sized ? Math.round(Number(sized.width)) : 0,
    height: sized ? Math.round(Number(sized.height)) : 0
  };
}

async function probePlayableVideoOutput(outputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=codec_type,duration,width,height",
      "-of", "json",
      outputPath
    ], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL"
    });
    return parseVideoProbeMetadata(JSON.parse(String(stdout || "{}")));
  } catch (error) {
    throw new ShotVideoProviderError(`视频生成服务返回的文件无法通过 ffprobe 播放性校验：${error.message || "无有效视频流"}。`);
  }
}

async function runGenericWorker({ request, outputPath, workDir, configPath, workerRunner = null, lifetimeFile = "" }) {
  const requestPath = path.join(workDir, `${safeSegment(request.taskId)}.request.json`);
  const receiptPath = path.join(workDir, `${safeSegment(request.taskId)}.receipt.json`);
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const args = [
    path.resolve("workers/generic-http-worker.mjs"),
    ...(configPath ? ["--config", configPath] : []),
    "--request", requestPath,
    "--output", outputPath,
    "--receipt", receiptPath,
    "--root", process.cwd(),
    ...(lifetimeFile ? ["--lifetime-file", lifetimeFile] : [])
  ];
  try {
    if (typeof workerRunner === "function") {
      await workerRunner({
        config: configPath,
        request: requestPath,
        output: outputPath,
        receipt: receiptPath,
        root: process.cwd(),
        ...(lifetimeFile ? { lifetimeFile } : {})
      });
    } else {
      await execFileAsync(process.execPath, args, { maxBuffer: 10 * 1024 * 1024 });
    }
  } catch (error) {
    const message = String(error.stderr || error.message || "生成失败").trim();
    const providerError = new ShotVideoProviderError(message);
    // 供应商与模型带上，错误出口才能查对应厂商的官方错误码表。
    // 纯诊断信息，不参与任何控制流。
    providerError.provider = String(request.provider || "");
    providerError.model = String(request.model || "");
    throw providerError;
  }
  return readJsonIfExists(receiptPath);
}

async function loadProviderConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new ShotVideoConfigError(`${configPath} 无法读取或不是有效 JSON：${error.message}`);
  }
}

function clampVideoCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(4, Math.max(1, number));
}

function videoEndpointConfigured(config = {}, runtime = {}) {
  return Boolean(
    config.endpoints?.all_reference_video_generation
    || config.videoEndpoint
    || config.endpoint
    || runtime.endpoint
  );
}

async function prepareAllReferenceArtifacts(referenceAssets, workDir) {
  const assets = Array.isArray(referenceAssets) ? referenceAssets : [];
  const prepared = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index] || {};
    const decoded = decodeDataUrl(asset.dataUrl, `referenceAssets[${index}].dataUrl`);
    const mediaType = normalizeReferenceMediaType(asset.mediaType || decoded.mimeType.split("/", 1)[0]);
    if (!decoded.mimeType.startsWith(`${mediaType}/`)) {
      throw new ShotVideoConfigError(`referenceAssets[${index}] 的媒体类型与 data URL 不一致。`);
    }
    const filePath = path.join(workDir, `reference-${String(index + 1).padStart(2, "0")}${extensionForMime(decoded.mimeType)}`);
    await fs.writeFile(filePath, decoded.buffer);
    const artifact = {
      outputKey: `references.${index + 1}`,
      path: filePath,
      status: "done",
      missing: false,
      mediaType,
      role: `reference_${mediaType}`,
      mimeType: decoded.mimeType,
      filename: safeReferenceName(asset.name, index, decoded.mimeType),
      logicalName: safeReferenceName(asset.name, index, decoded.mimeType),
      sizeBytes: decoded.buffer.length,
      sha256: sha256Bytes(decoded.buffer),
      source: String(asset.source || "upload").trim() || "upload",
      sourceCharacterName: String(asset.sourceCharacterName || "").trim()
    };
    if (mediaType === "video" || mediaType === "audio") {
      artifact.durationSeconds = await probeMediaDuration(filePath, mediaType);
    }
    prepared.push(artifact);
  }
  return prepared;
}

async function preparePreviousShotFrameArtifacts({ reference, workDir, extractor } = {}) {
  const frameExtractor = typeof extractor === "function" ? extractor : extractEvenlySpacedVideoFrames;
  const sourceSnapshot = await snapshotTrustedPreviousVideo(reference, workDir);
  const extracted = await frameExtractor({
    sourcePath: sourceSnapshot.path,
    outputDirectory: workDir,
    sourceShotId: reference.sourceShotId
  });
  const frames = Array.isArray(extracted?.frames) ? extracted.frames : [];
  if (!frames.length) {
    throw new ShotVideoConfigError(`${reference.sourceShotId} 没有抽取到可用视频帧。`);
  }
  if (frames.length > PREVIOUS_SHOT_REFERENCE_FRAME_COUNT) {
    throw new ShotVideoConfigError(
      `${reference.sourceShotId} 抽取到 ${frames.length} 张参考帧，超过上一镜参考帧上限 ${PREVIOUS_SHOT_REFERENCE_FRAME_COUNT} 张。`
    );
  }
  const artifacts = [];
  const trustedWorkDir = path.resolve(workDir);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] || {};
    const filePath = path.resolve(String(frame.path || ""));
    if (path.dirname(filePath) !== trustedWorkDir) {
      throw new ShotVideoConfigError(`${reference.sourceShotId} 的抽帧文件不在当前生成任务临时目录中。`);
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1) {
      throw new ShotVideoConfigError(`${reference.sourceShotId} 的第 ${index + 1} 张抽帧不可用。`);
    }
    const frameBytes = await fs.readFile(filePath);
    artifacts.push({
      outputKey: `references.previous-shot.${index + 1}`,
      path: filePath,
      status: "done",
      missing: false,
      mediaType: "image",
      role: "reference_image",
      mimeType: "image/jpeg",
      filename: `${safeSegment(reference.sourceShotId)}-${String(index + 1).padStart(2, "0")}.jpg`,
      sizeBytes: stat.size,
      source: "previous_shot_frame",
      sourceShotId: reference.sourceShotId,
      sha256: sha256Bytes(frameBytes),
      timestampSeconds: Number.isFinite(Number(frame.timestampSeconds))
        ? Number(frame.timestampSeconds)
        : index
    });
  }
  return {
    reference,
    sourceVideoSha256: sourceSnapshot.sha256,
    durationSeconds: Number(extracted.durationSeconds) || 0,
    artifacts
  };
}

async function snapshotTrustedPreviousVideo(reference = {}, workDir = "") {
  const sourcePath = String(reference.sourcePath || "");
  let sourceHandle;
  try {
    sourceHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size < 8 || before.size > 50 * 1024 * 1024) {
      throw new Error("文件类型或大小无效");
    }
    const bytes = await sourceHandle.readFile();
    const after = await sourceHandle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error("读取期间文件发生变化");
    }
    const snapshotPath = path.join(workDir, `previous-${safeSegment(reference.sourceShotId)}-source.mp4`);
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return { path: snapshotPath, sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof ShotVideoConfigError) throw error;
    throw new ShotVideoConfigError(`${reference.sourceShotId || "上一镜"} 的受信视频无法冻结到当前生成任务：${error.message || "文件不可用"}。`);
  } finally {
    await sourceHandle?.close().catch(() => {});
  }
}

// 上一镜参考帧固定取 5 张：首帧、末帧和中间三等分点。
//
// 旧实现按每秒一帧抽，3.1 把单镜时长放宽到 4–15 秒之后有两个后果：
// 超过 9 秒的镜头直接撞上 9 图上限报错（实测语料里 56% 的镜头），而且
// 9 张上限是和角色参考图共用的——每秒一帧会把锁角色长相的那几张挤出去。
// 固定 5 张同时解决两件事，并且正好落在 MiniMax 的 5 张免费额度内。
export const PREVIOUS_SHOT_REFERENCE_FRAME_COUNT = 5;

// 容器时长是最后一帧的结束时刻，`-ss 时长` 落在画面之外解不出帧。
// 回退 0.1 秒稳定落在最后一帧上（常见 24–30fps 下一帧是 0.033–0.042 秒），
// 仍然代表镜头结尾状态。
const LAST_FRAME_BACKOFF_SECONDS = 0.1;

const PREVIOUS_SHOT_FRAME_SCALE_FILTER =
  "scale=w='if(gt(iw,ih),min(720,iw),-2)':h='if(gt(iw,ih),-2,min(720,ih))'";

/**
 * 按 t = D×i/(N-1) 均匀布点，含首帧与末帧。纯函数，便于单测与复现。
 * 时间戳保留三位小数：它会写进抽帧产物的 provenance，必须确定可复算。
 */
export function previousShotFrameTimestamps(
  durationSeconds,
  frameCount = PREVIOUS_SHOT_REFERENCE_FRAME_COUNT
) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const count = Math.max(1, Math.round(Number(frameCount) || 0));
  const lastStamp = Math.max(0, duration - LAST_FRAME_BACKOFF_SECONDS);
  if (count === 1) return [roundSeconds(lastStamp)];
  const stamps = [];
  for (let index = 0; index < count; index += 1) {
    stamps.push(roundSeconds(Math.min(lastStamp, (duration * index) / (count - 1))));
  }
  // 极短视频上多个布点可能落到同一帧；去重后宁可少给几张，也不重复上传同一画面。
  return [...new Set(stamps)];
}

function roundSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

export async function extractEvenlySpacedVideoFrames({
  sourcePath,
  outputDirectory,
  sourceShotId = "previous-shot",
  frameCount = PREVIOUS_SHOT_REFERENCE_FRAME_COUNT,
  execFileRunner = execFileAsync,
  durationProbe = probeMediaDuration
} = {}) {
  const durationSeconds = await durationProbe(sourcePath, "video");
  const timestamps = previousShotFrameTimestamps(durationSeconds, frameCount);
  if (!timestamps.length) {
    throw new ShotVideoConfigError(`${sourceShotId} 的视频时长无效，无法抽取参考帧。`);
  }
  const basename = `previous-${safeSegment(sourceShotId)}-frame`;
  const frames = [];
  // 逐个时间戳精确截帧，而不是靠 fps 滤镜的副产品：布点必须显式可控，
  // 首帧与末帧才能保证取到，时间戳也才能如实记进产物。
  for (const [index, timestampSeconds] of timestamps.entries()) {
    const framePath = path.join(outputDirectory, `${basename}-${String(index + 1).padStart(2, "0")}.jpg`);
    await execFileRunner("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-ss", timestampSeconds.toFixed(3),
      "-i", sourcePath,
      "-map", "0:v:0",
      "-an",
      "-frames:v", "1",
      "-vf", PREVIOUS_SHOT_FRAME_SCALE_FILTER,
      "-q:v", "4",
      framePath
    ], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL"
    });
    const stat = await fs.stat(framePath).catch(() => null);
    if (!stat?.isFile() || stat.size < 1) {
      throw new ShotVideoConfigError(
        `${sourceShotId} 在第 ${timestampSeconds.toFixed(2)} 秒处没有可解码的视频帧。`
      );
    }
    frames.push({ path: framePath, timestampSeconds });
  }
  return { durationSeconds, frames };
}

function validateAllReferenceArtifacts(artifacts, { maxTotal = Number.POSITIVE_INFINITY } = {}) {
  const grouped = Object.groupBy(artifacts, (item) => item.mediaType);
  const images = grouped.image || [];
  const videos = grouped.video || [];
  const audios = grouped.audio || [];
  if (!images.length && !videos.length) throw new ShotVideoConfigError("全能参考模式不能只上传音频；至少需要一张图片或一段视频。");
  if (images.length > ALL_REFERENCE_MAX_IMAGES) throw new ShotVideoConfigError(`全能参考图片最多 ${ALL_REFERENCE_MAX_IMAGES} 张，当前 ${images.length} 张。`);
  if (videos.length > ALL_REFERENCE_MAX_VIDEOS) throw new ShotVideoConfigError(`全能参考视频最多 ${ALL_REFERENCE_MAX_VIDEOS} 段，当前 ${videos.length} 段。`);
  if (audios.length > ALL_REFERENCE_MAX_AUDIOS) throw new ShotVideoConfigError(`全能参考音频最多 ${ALL_REFERENCE_MAX_AUDIOS} 段，当前 ${audios.length} 段。`);
  if (artifacts.length > maxTotal) {
    throw new ShotVideoConfigError(`MiniMax H3 混合参考素材总数最多 ${maxTotal} 项，当前 ${artifacts.length} 项。`);
  }
  for (const item of [...videos, ...audios]) {
    if (
      item.durationSeconds < ALL_REFERENCE_MEDIA_MIN_SECONDS
      || item.durationSeconds > ALL_REFERENCE_MEDIA_MAX_SECONDS
    ) {
      throw new ShotVideoConfigError(`${item.filename} 时长必须在 ${ALL_REFERENCE_MEDIA_MIN_SECONDS}–${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒之间，当前 ${formatDuration(item.durationSeconds)} 秒。`);
    }
  }
  if (videos.some((item) => item.sizeBytes > ALL_REFERENCE_MAX_VIDEO_BYTES)) {
    throw new ShotVideoConfigError("单段参考视频不得超过 50MB。");
  }
  const videoDuration = videos.reduce((sum, item) => sum + item.durationSeconds, 0);
  const audioDuration = audios.reduce((sum, item) => sum + item.durationSeconds, 0);
  if (videoDuration > ALL_REFERENCE_MEDIA_TOTAL_SECONDS) throw new ShotVideoConfigError(`参考视频总时长不得超过 ${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒，当前 ${formatDuration(videoDuration)} 秒。`);
  if (audioDuration > ALL_REFERENCE_MEDIA_TOTAL_SECONDS) throw new ShotVideoConfigError(`参考音频总时长不得超过 ${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒，当前 ${formatDuration(audioDuration)} 秒。`);
}

function assertAllReferenceRequestSize(options) {
  const bytes = Buffer.byteLength(JSON.stringify(options), "utf8");
  if (bytes > 64 * 1024 * 1024) {
    throw new ShotVideoConfigError(`全能参考请求体不得超过 64MB，当前约 ${(bytes / 1024 / 1024).toFixed(1)}MB。`);
  }
}

function summarizeReferenceArtifacts(artifacts) {
  const counts = { image: 0, video: 0, audio: 0 };
  for (const artifact of artifacts) counts[artifact.mediaType] += 1;
  return counts;
}

function normalizeReferenceMediaType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["image", "video", "audio"].includes(normalized)) return normalized;
  throw new ShotVideoConfigError(`不支持的全能参考媒体类型“${value || "空"}”。`);
}

function decodeDataUrl(dataUrl, fieldName) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new ShotVideoConfigError(`${fieldName} 不是有效的 base64 data URL。`);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new ShotVideoConfigError(`${fieldName} 没有可用的媒体数据。`);
  return {
    mimeType: match[1].toLowerCase(),
    buffer
  };
}

async function probeMediaDuration(filePath, mediaType) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      filePath
    ], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL"
    });
    const metadata = JSON.parse(String(stdout || "{}"));
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    if (!streams.some((stream) => stream.codec_type === mediaType)) {
      throw new Error(`缺少 ${mediaType} 流`);
    }
    const streamDuration = streams
      .filter((stream) => stream.codec_type === mediaType)
      .map((stream) => Number(stream.duration))
      .find((duration) => Number.isFinite(duration) && duration > 0);
    const duration = streamDuration || Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("时长无效");
    return duration;
  } catch {
    throw new ShotVideoConfigError(`无法读取参考${mediaType === "video" ? "视频" : "音频"}时长，请确认文件可播放并已安装 ffprobe。`);
  }
}

function safeReferenceName(name, index, mimeType) {
  const cleaned = String(name || "").trim().replace(/[\\/]+/gu, "_").slice(0, 120);
  return cleaned || `reference-${index + 1}${extensionForMime(mimeType)}`;
}

function formatDuration(value) {
  return Number(value).toFixed(2).replace(/\.00$/u, "");
}

function providerAuthConfigured(config = {}, runtime = {}) {
  return Boolean(
    config.apiKey
    || runtime.apiKey
    || config.headers?.Authorization
    || config.headers?.authorization
  );
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function extensionForMime(mimeType) {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav"
  })[mimeType] || ".bin";
}

function safeSegment(value) {
  return mediaFilenameSegment(value);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
