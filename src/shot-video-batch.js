import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";
import {
  CHARACTER_REFERENCE_AUDIO_MAX_CLIPS,
  CHARACTER_REFERENCE_AUDIO_MAX_SECONDS,
  CHARACTER_REFERENCE_AUDIO_MAX_TOTAL_SECONDS,
  CHARACTER_REFERENCE_AUDIO_MIN_SECONDS,
  characterReferenceAudioClips
} from "../public/character-reference-audio.js";
import { ProductionStateError } from "./production-lineage.js";
import { requireAnimationPlanAspectRatio } from "./validation.js";

export const SHOT_VIDEO_BATCH_CONTROL_RUNNING = "running";
export const SHOT_VIDEO_BATCH_CONTROL_PAUSED = "paused";

export function requireShotVideoBatchAspectRatio(plan = {}) {
  return requireAnimationPlanAspectRatio(
    plan?.productionStrategy?.targetAspectRatio,
    "productionStrategy.targetAspectRatio"
  );
}

export function buildShotVideoBatchReferenceAssets(shot = {}, characterReferences = []) {
  const references = shotRelatedCharacterReferences(shot, characterReferences);
  const assets = [];
  for (const reference of references) {
    const characterName = String(reference?.characterName || "").trim();
    const imageDataUrl = String(reference?.referenceImageDataUrl || "").trim();
    if (imageDataUrl) {
      assets.push({
        mediaType: "image",
        name: `${characterName || "角色"}参考图`,
        dataUrl: imageDataUrl,
        sizeBytes: 0,
        durationSeconds: 0,
        source: "character_reference",
        sourceCharacterName: characterName
      });
    }
    for (const clip of characterReferenceAudioClips(reference)) {
      assets.push({
        mediaType: "audio",
        name: `${characterName || "角色"}参考声音`,
        dataUrl: clip.dataUrl,
        sizeBytes: clip.sizeBytes,
        durationSeconds: clip.durationSeconds,
        source: "character_audio_reference",
        sourceCharacterName: characterName
      });
    }
  }
  const imageCount = assets.filter((asset) => asset.mediaType === "image").length;
  const audioAssets = assets.filter((asset) => asset.mediaType === "audio");
  if (imageCount > 9) {
    throw new ProductionStateError(
      `镜头 ${shot?.shotId || "未知"} 关联 ${imageCount} 张角色参考图，超过全能参考上限 9 张。`,
      { code: "SHOT_VIDEO_BATCH_REFERENCE_LIMIT" }
    );
  }
  if (audioAssets.length > CHARACTER_REFERENCE_AUDIO_MAX_CLIPS) {
    throw new ProductionStateError(
      `镜头 ${shot?.shotId || "未知"} 关联 ${audioAssets.length} 段角色参考声音，超过全能参考上限 ${CHARACTER_REFERENCE_AUDIO_MAX_CLIPS} 段。`,
      { code: "SHOT_VIDEO_BATCH_REFERENCE_LIMIT" }
    );
  }
  const invalidDuration = audioAssets.find((asset) => (
    asset.durationSeconds < CHARACTER_REFERENCE_AUDIO_MIN_SECONDS
    || asset.durationSeconds > CHARACTER_REFERENCE_AUDIO_MAX_SECONDS
  ));
  if (invalidDuration) {
    throw new ProductionStateError(
      `镜头 ${shot?.shotId || "未知"} 的角色参考声音时长必须在 ${CHARACTER_REFERENCE_AUDIO_MIN_SECONDS}-${CHARACTER_REFERENCE_AUDIO_MAX_SECONDS} 秒之间。`,
      { code: "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID" }
    );
  }
  const totalAudioDuration = audioAssets.reduce((sum, asset) => sum + asset.durationSeconds, 0);
  if (totalAudioDuration > CHARACTER_REFERENCE_AUDIO_MAX_TOTAL_SECONDS) {
    throw new ProductionStateError(
      `镜头 ${shot?.shotId || "未知"} 的角色参考声音总时长不能超过 15 秒，当前 ${totalAudioDuration.toFixed(2)} 秒。`,
      { code: "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID" }
    );
  }
  return assets;
}

export function createShotVideoBatchItems(shots = [], isReady = () => false) {
  return shots.map((shot) => ({
    shotId: String(shot?.shotId || ""),
    status: isReady(shot) ? "completed" : "pending",
    message: isReady(shot) ? "已存在当前视频结果" : "等待提交"
  }));
}

export function updateShotVideoBatchItem(items = [], shotId, patch = {}) {
  return items.map((item) => String(item.shotId) === String(shotId)
    ? { ...item, ...patch, shotId: item.shotId }
    : item);
}

export async function waitForShotVideoBatchControl(context, {
  pollIntervalMs = 750,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  while (true) {
    const task = await context.getTask();
    if (task.status === "cancelled") {
      throw new ProductionStateError("镜头视频批量任务已终止", {
        code: "SHOT_VIDEO_BATCH_TERMINATED",
        category: "control-plane"
      });
    }
    const controlState = String(task.progress?.controlState || SHOT_VIDEO_BATCH_CONTROL_RUNNING);
    if (controlState !== SHOT_VIDEO_BATCH_CONTROL_PAUSED) return task;
    await context.heartbeat({ controlState: SHOT_VIDEO_BATCH_CONTROL_PAUSED });
    await sleep(pollIntervalMs);
  }
}
