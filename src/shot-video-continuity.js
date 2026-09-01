import fs from "node:fs/promises";
import path from "node:path";
import {
  mediaFilenameSegment,
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
} from "../public/shot-video-continuity.js";
import { lineageRef, ProductionStateError } from "./production-lineage.js";

export {
  mediaFilenameSegment,
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
};

export function normalizeShotVideoContinuityReferenceMode(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === SHOT_VIDEO_CONTINUITY_NONE) return SHOT_VIDEO_CONTINUITY_NONE;
  if (normalized === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES) {
    return SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES;
  }
  throw new ProductionStateError(`不支持的视频连续性参考模式“${value}”`, {
    code: "SHOT_VIDEO_CONTINUITY_MODE_INVALID"
  });
}

export function resolveAuthoritativeShotVideoInput({
  planArtifactId,
  planEntry,
  currentShotId,
  promptOverride,
  requestedSchemaVersion,
  selectedVariantId
} = {}) {
  const plan = planEntry?.content;
  const shots = Array.isArray(plan?.shotPlan) ? plan.shotPlan : [];
  const shotId = String(currentShotId || "").trim();
  const matches = shots.filter((shot) => String(shot?.shotId || "") === shotId);
  if (!shotId || matches.length !== 1) {
    throw new ProductionStateError("当前镜头不在已签发 Animation Plan 中，拒绝生成视频。", {
      code: "SHOT_VIDEO_CURRENT_SHOT_NOT_IN_PLAN",
      httpStatus: 409
    });
  }
  const authoritativeSchemaVersion = String(plan?.promptSchemaVersion || "").trim();
  const requestedSchema = String(requestedSchemaVersion || "").trim();
  if (requestedSchema && requestedSchema !== authoritativeSchemaVersion) {
    throw new ProductionStateError("视频请求声明的 Prompt Schema 与当前 Animation Plan 不一致。", {
      code: "SHOT_VIDEO_PLAN_SCHEMA_MISMATCH",
      httpStatus: 409
    });
  }
  const planVariantId = String(planArtifactId || "").startsWith("animationPlan:")
    ? String(planArtifactId).slice("animationPlan:".length)
    : "";
  if (String(selectedVariantId || "").trim() && String(selectedVariantId) !== planVariantId) {
    throw new ProductionStateError("视频请求的主题变体与当前 Animation Plan 不一致。", {
      code: "SHOT_VIDEO_PLAN_VARIANT_MISMATCH",
      httpStatus: 409
    });
  }
  const override = String(promptOverride || "").trim();
  const shot = structuredClone(matches[0]);
  if (override) shot.videoPrompt = override;
  return {
    shot,
    promptSource: override ? "runtime_override" : "animation_plan",
    promptSchemaVersion: authoritativeSchemaVersion,
    characterReferences: structuredClone(plan?.characterReferencePrompts || []),
    planVariantId
  };
}

export function resolveAuthoritativeShotVideoReferenceAssets(referenceAssets, plan = {}) {
  const assets = Array.isArray(referenceAssets) ? referenceAssets : [];
  const signedCharacterImages = (Array.isArray(plan.characterReferencePrompts)
    ? plan.characterReferencePrompts
    : [])
    .filter((reference) => String(reference?.referenceImageDataUrl || "").trim())
    .map((reference) => ({
      characterName: String(reference.characterName || "").trim(),
      dataUrl: String(reference.referenceImageDataUrl || "").trim()
    }));
  return assets.map((asset, index) => {
    const source = String(asset?.source || "upload").trim() || "upload";
    if (["previous_shot_frame", "previous_shot_frames"].includes(source)) {
      throw new ProductionStateError(
        `referenceAssets[${index}].source=${source} 是服务端保留来源；上一镜参考只能由当前 Plan lineage 解析。`,
        { code: "SHOT_VIDEO_REFERENCE_SOURCE_RESERVED", httpStatus: 409 }
      );
    }
    if (source !== "character_reference") return structuredClone(asset);
    const dataUrl = String(asset?.dataUrl || "").trim();
    const matches = signedCharacterImages.filter((reference) => reference.dataUrl === dataUrl);
    if (matches.length !== 1) {
      throw new ProductionStateError(
        `referenceAssets[${index}] 声明为 character_reference，但内容不属于当前签发 Animation Plan 的唯一角色参考图。`,
        { code: "SHOT_VIDEO_CHARACTER_REFERENCE_UNTRUSTED", httpStatus: 409 }
      );
    }
    return {
      ...structuredClone(asset),
      name: `${matches[0].characterName || "角色"}参考图`,
      source: "character_reference",
      sourceCharacterName: matches[0].characterName
    };
  });
}

export async function resolvePreviousShotFrameReference({
  continuityReferenceMode,
  generationMode,
  currentShotId,
  planArtifactId,
  planEntry,
  latestArtifacts,
  videoOutputRoot,
  videoPublicBasePath,
  filenamePrefix
} = {}) {
  const mode = normalizeShotVideoContinuityReferenceMode(continuityReferenceMode);
  if (mode === SHOT_VIDEO_CONTINUITY_NONE) return null;
  if (String(generationMode || "").trim() !== "all_reference") {
    throw new ProductionStateError("上一镜抽帧只能用于显式 all_reference 模式。", {
      code: "SHOT_VIDEO_CONTINUITY_MODE_MISMATCH"
    });
  }

  const planLineage = planEntry?.lineage;
  const shots = Array.isArray(planEntry?.content?.shotPlan) ? planEntry.content.shotPlan : [];
  const matches = shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => String(shot?.shotId || "") === String(currentShotId || ""));
  if (matches.length !== 1) {
    throw new ProductionStateError("当前镜头不在已签发 Animation Plan 中，无法确定上一业务镜头。", {
      code: "SHOT_VIDEO_CURRENT_SHOT_NOT_IN_PLAN",
      httpStatus: 409
    });
  }
  const currentIndex = matches[0].index;
  if (currentIndex < 1) {
    throw new ProductionStateError("当前镜头是计划中的第一镜，没有可用的上一业务镜头。", {
      code: "SHOT_VIDEO_PREVIOUS_SHOT_MISSING",
      httpStatus: 409
    });
  }

  const previousShot = shots[currentIndex - 1];
  const variantId = String(planArtifactId || "").startsWith("animationPlan:")
    ? String(planArtifactId).slice("animationPlan:".length)
    : "";
  if (!variantId) {
    throw new ProductionStateError("Animation Plan artifactId 无法确定主题变体。", {
      code: "SHOT_VIDEO_PLAN_VARIANT_INVALID",
      httpStatus: 409
    });
  }
  const sourceArtifactId = `shotVideo:${variantId}:${previousShot.shotId}`;
  const sourceEntry = latestArtifacts?.[sourceArtifactId];
  const sourceLineage = sourceEntry?.lineage;
  if (
    !sourceLineage
    || sourceLineage.artifactType !== "shotVideo"
    || sourceLineage.status !== "current"
  ) {
    throw new ProductionStateError(`${previousShot.shotId} 没有当前可用的镜头视频。`, {
      code: "SHOT_VIDEO_PREVIOUS_ARTIFACT_UNAVAILABLE",
      httpStatus: 409
    });
  }
  const consumesCurrentPlan = (sourceLineage.dependencies || []).some((dependency) => (
    dependency.artifactId === planLineage?.artifactId
    && dependency.revision === planLineage?.revision
    && dependency.contentDigest === planLineage?.contentDigest
  ));
  if (!consumesCurrentPlan) {
    throw new ProductionStateError(`${previousShot.shotId} 的视频不属于当前 Animation Plan。`, {
      code: "SHOT_VIDEO_PREVIOUS_PLAN_MISMATCH",
      httpStatus: 409
    });
  }

  const sourceContent = sourceEntry.content || {};
  const candidate = selectedCandidate(sourceContent);
  if (!candidate) {
    throw new ProductionStateError(`${previousShot.shotId} 尚未选择可用的视频候选。`, {
      code: "SHOT_VIDEO_PREVIOUS_CANDIDATE_UNAVAILABLE",
      httpStatus: 409
    });
  }
  const sourcePath = await resolveTrustedGeneratedVideoPath({
    outputUrl: candidate.outputUrl,
    videoOutputRoot,
    videoPublicBasePath,
    expectedFilenamePrefix: `${mediaFilenameSegment(filenamePrefix)}-${mediaFilenameSegment(previousShot.shotId)}-`
  });

  return {
    mode,
    continuityType: "intentional_next_shot",
    sourceShotId: String(previousShot.shotId || ""),
    sourceSceneId: String(previousShot.sourceSceneId || ""),
    sceneId: String(previousShot.sceneId || ""),
    selectedIndex: candidate.selectedIndex,
    sourceOutputUrl: candidate.outputUrl,
    sourcePath,
    sourceArtifact: lineageRef(sourceLineage)
  };
}

function selectedCandidate(content = {}) {
  if (content.status !== "ready") return null;
  const result = content.result || {};
  const videos = Array.isArray(result.videos) && result.videos.length
    ? result.videos
    : result.outputUrl || result.url
      ? [result]
      : [];
  const selectedIndex = Number(content.selectedIndex ?? result.selectedIndex ?? 0);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !videos[selectedIndex]) return null;
  const selected = videos[selectedIndex];
  const outputUrl = String(selected.outputUrl || selected.url || "").trim();
  return outputUrl ? { outputUrl, selectedIndex } : null;
}

async function resolveTrustedGeneratedVideoPath({
  outputUrl,
  videoOutputRoot,
  videoPublicBasePath,
  expectedFilenamePrefix
}) {
  const normalizedUrl = String(outputUrl || "").trim();
  const publicPrefix = `${String(videoPublicBasePath || "").replace(/\/$/u, "")}/`;
  if (
    !normalizedUrl.startsWith(publicPrefix)
    || normalizedUrl.includes("?")
    || normalizedUrl.includes("#")
    || normalizedUrl.includes("\\")
  ) {
    throw unsafePreviousVideoError();
  }
  const encodedFilename = normalizedUrl.slice(publicPrefix.length);
  if (!encodedFilename || encodedFilename.includes("/")) throw unsafePreviousVideoError();
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw unsafePreviousVideoError();
  }
  if (
    !filename
    || filename === "."
    || filename === ".."
    || filename.includes("/")
    || filename.includes("\\")
    || path.extname(filename).toLowerCase() !== ".mp4"
    || !filename.startsWith(expectedFilenamePrefix)
  ) {
    throw unsafePreviousVideoError();
  }

  const rootPath = path.resolve(videoOutputRoot);
  const candidatePath = path.resolve(rootPath, filename);
  if (path.dirname(candidatePath) !== rootPath) throw unsafePreviousVideoError();
  let candidateStat;
  try {
    candidateStat = await fs.lstat(candidatePath);
  } catch {
    throw new ProductionStateError("上一镜当前视频文件不存在，请重新生成或重新选择上一镜候选。", {
      code: "SHOT_VIDEO_PREVIOUS_FILE_MISSING",
      httpStatus: 409
    });
  }
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.size < 8) {
    throw unsafePreviousVideoError();
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath)
  ]);
  if (path.dirname(realCandidate) !== realRoot) throw unsafePreviousVideoError();
  return realCandidate;
}

function unsafePreviousVideoError() {
  return new ProductionStateError("上一镜视频地址不属于当前 Plan 的受信媒体目录。", {
    code: "SHOT_VIDEO_PREVIOUS_URL_UNTRUSTED",
    httpStatus: 409
  });
}

// 运行时参考素材清单：把服务端已经验证过的素材身份写进提示词正文。
//
// 只允许使用受控来源枚举、Plan 权威的 sourceCharacterName 和 lineage 解析出的
// sourceShotId。**绝不能**写入 upload 素材的 name/logicalName——那是原始用户
// 文件名，是这条链路上唯一的注入面。上传素材一律只写「用户上传的参考素材」。
const REFERENCE_MEDIA_WORDS = Object.freeze({
  image: "参考图",
  video: "参考视频",
  audio: "参考音频"
});

// 抽帧 Artifact 的 source 是单数形态；运行时开关常量是复数形态，两个都认。
const PREVIOUS_SHOT_FRAME_SOURCE = "previous_shot_frame";
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/gu;

function manifestSafeTerm(value, maxLength) {
  // Plan 权威值仍然过一遍消毒：控制字符和超长内容不该进提示词。
  return String(value || "").replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, maxLength);
}

function manifestGroupKey(artifact = {}) {
  return [
    String(artifact.mediaType || ""),
    String(artifact.source || ""),
    manifestSafeTerm(artifact.sourceCharacterName, 40),
    manifestSafeTerm(artifact.sourceShotId, 16)
  ].join(" ");
}

function manifestClause(artifact, label, { hasCharacterReference = false } = {}) {
  const source = String(artifact.source || "");
  if ([PREVIOUS_SHOT_FRAME_SOURCE, SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES].includes(source)) {
    const shotId = manifestSafeTerm(artifact.sourceShotId, 16) || "上一镜";
    // 抽帧**不承接角色外观与服装**。它承接的是场景侧的状态。
    //
    // 原措辞让它「承接角色外观、服装、道具与场景状态」，而角色参考图那句同时写着
    // 「锁定该角色的长相与服装」——两句都声称管服装，清单自己把冲突制度化了。
    // 实测代价：A01 把校服画成了米色无袖（本身就违背角色参考图），抽帧把这个错误
    // 当成事实传给 A02，于是 A02 在 8 秒内两次换装（3.4 秒黑色校服、7.9 秒米色）。
    // 上一镜是**待核实的产出**，角色参考图才是签发权威，两者冲突时没有理由让前者赢。
    const appearanceRule = hasCharacterReference
      ? "；角色的长相与服装一律以角色参考图为准，不要沿用抽帧里的角色外观"
      : "";
    return `${label} 是上一镜 ${shotId} 的均匀抽帧，只用于承接场景、道具、光线与位置关系${appearanceRule}，不要复制它的构图与动作`;
  }
  if (source === "character_reference") {
    const name = manifestSafeTerm(artifact.sourceCharacterName, 40);
    return name
      ? `${label} 是「${name}」的角色参考图，是该角色长相与服装的唯一依据`
      : `${label} 是角色参考图，是角色长相与服装的唯一依据`;
  }
  if (source === "workflow_start_frame") return `${label} 是本镜已选的首帧画面，只作普通参考`;
  if (source === "workflow_end_frame") return `${label} 是本镜已选的尾帧画面，只作普通参考`;
  return `${label} 是用户上传的参考素材`;
}

/**
 * Builds the deterministic reference manifest prepended to the runtime video prompt.
 * Input is the already-assembled, already-validated artifact list; ordering and
 * numbering come from that array so the text always matches what the provider receives.
 */
export function buildReferenceManifestText(inputArtifacts = []) {
  const artifacts = Array.isArray(inputArtifacts) ? inputArtifacts : [];
  const perTypeCount = { image: 0, video: 0, audio: 0 };
  const numbered = [];
  for (const artifact of artifacts) {
    const mediaType = String(artifact?.mediaType || "");
    if (!Object.hasOwn(REFERENCE_MEDIA_WORDS, mediaType)) continue;
    perTypeCount[mediaType] += 1;
    numbered.push({ artifact, mediaType, index: perTypeCount[mediaType] });
  }
  if (!numbered.length) return "";

  // 只有本次确实带了角色参考图，才让抽帧把外观权威让给它——否则等于指向一个
  // 不存在的素材，反而让模型无所适从。
  const hasCharacterReference = numbered.some(
    (entry) => String(entry.artifact?.source || "") === "character_reference"
  );

  const clauses = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const word = REFERENCE_MEDIA_WORDS[run.mediaType];
    const label = run.first === run.last ? `${word}${run.first}` : `${word}${run.first}-${run.last}`;
    clauses.push(manifestClause(run.artifact, label, { hasCharacterReference }));
    run = null;
  };
  for (const entry of numbered) {
    const key = manifestGroupKey(entry.artifact);
    if (run && run.key === key && entry.index === run.last + 1) {
      run.last = entry.index;
      continue;
    }
    flush();
    run = { key, mediaType: entry.mediaType, artifact: entry.artifact, first: entry.index, last: entry.index };
  }
  flush();
  return `本次提供的参考素材：${clauses.join("；")}。`;
}
