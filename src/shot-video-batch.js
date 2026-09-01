import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";
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
  const references = shotRelatedCharacterReferences(shot, characterReferences)
    .filter((reference) => String(reference?.referenceImageDataUrl || "").trim());
  if (references.length > 9) {
    throw new ProductionStateError(
      `镜头 ${shot?.shotId || "未知"} 关联 ${references.length} 张角色参考图，超过全能参考上限 9 张。`,
      { code: "SHOT_VIDEO_BATCH_REFERENCE_LIMIT" }
    );
  }
  return references.map((reference, index) => ({
    mediaType: "image",
    name: `${String(reference.characterName || `角色 ${index + 1}`).trim()}参考图`,
    dataUrl: String(reference.referenceImageDataUrl || "").trim(),
    sizeBytes: 0,
    durationSeconds: 0,
    source: "character_reference",
    sourceCharacterName: String(reference.characterName || "").trim()
  }));
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
