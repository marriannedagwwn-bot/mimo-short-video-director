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
