import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";
import { shotRelatedCharacterAudioClips } from "../public/character-reference-audio.js";
import {
  ALL_REFERENCE_MAX_AUDIOS,
  ALL_REFERENCE_MAX_IMAGES,
  ALL_REFERENCE_MEDIA_MAX_SECONDS,
  ALL_REFERENCE_MEDIA_MIN_SECONDS,
  ALL_REFERENCE_MEDIA_TOTAL_SECONDS
} from "../public/all-reference-limits.js";
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

/**
 * 这一镜实际会带上的角色参考素材（图片 + 语音）。只做选取，不判定上限。
 * 图片按实际出镜角色选取；语音只按 dialogueOrSubtitle 的明确说话人选取。
 *
 * 注意 `shotRelatedCharacterReferences` 对 direct_shot 镜头有一条 fallback：
 * shot 没有 startFrame/endFrame/motion 时，一个角色都没匹配上就返回**全部**角色参考图
 * （public/shot-reference-images.js）。空镜、环境镜、纯道具特写正好落进这条，是本镜
 * 参考图数量最容易撞上限的地方。该 fallback 的去留是字段语义层面的决定，不在这里改；
 * 这里只保证它的后果会被 shotVideoBatchReferenceIssues 如实报出来。
 */
function shotCharacterReferenceAssets(shot = {}, characterReferences = []) {
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
  }
  for (const { characterName, clip } of shotRelatedCharacterAudioClips(shot, characterReferences)) {
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
  return assets;
}

/**
 * 这一镜提交给供应商时会不会超出全能参考上限。返回空数组表示可以提交。
 *
 * `continuityFrameCount` 是本镜预计额外携带的上一镜抽帧张数——它和角色参考图
 * **共用同一个 9 张上限**，分开数就会漏掉真正会失败的组合。首镜（或关闭抽帧时）传 0。
 *
 * 上限一律取自 public/all-reference-limits.js，与成片前那道权威闸门
 * （src/shot-video-generator.js 的 validateAllReferenceArtifacts）同一批数字。
 *
 * 这里**不再复用** CHARACTER_REFERENCE_AUDIO_MAX_CLIPS：那个常量约束的是「每个角色
 * 最多上传几段语音」，是上传期的规则；这里要判的是「每个镜头最多送几段语音」，是供应商
 * 规则。两者今天都等于 3，但它们是两条不同的约束——共用一个常量正是当初两个说话角色
 * 各传 3 段、同镜发声就必然渲染失败却无人察觉的原因。
 */
export function shotVideoBatchReferenceIssues(shot = {}, characterReferences = [], {
  continuityFrameCount = 0
} = {}) {
  return referenceIssuesForAssets(
    shotReferenceLabel(shot),
    shotCharacterReferenceAssets(shot, characterReferences),
    continuityFrameCount
  );
}

function shotReferenceLabel(shot = {}) {
  return `镜头 ${shot?.shotId || "未知"}`;
}

function referenceIssuesForAssets(shotLabel, assets, continuityFrameCount) {
  const characterImageCount = assets.filter((asset) => asset.mediaType === "image").length;
  const audioAssets = assets.filter((asset) => asset.mediaType === "audio");
  const continuityFrames = Math.max(0, Math.round(Number(continuityFrameCount) || 0));
  const imageCount = characterImageCount + continuityFrames;
  const issues = [];

  if (!imageCount) {
    issues.push({
      code: "SHOT_VIDEO_BATCH_REFERENCE_REQUIRED",
      message: `${shotLabel} 没有角色参考图，也没有可复用的上一镜视频；全能参考模式至少需要一项视觉参考。`
    });
  }
  if (imageCount > ALL_REFERENCE_MAX_IMAGES) {
    issues.push({
      code: "SHOT_VIDEO_BATCH_REFERENCE_LIMIT",
      message: continuityFrames
        ? `${shotLabel} 需要 ${imageCount} 张参考图（角色参考图 ${characterImageCount} 张 + 上一镜抽帧 ${continuityFrames} 张），超过全能参考上限 ${ALL_REFERENCE_MAX_IMAGES} 张。`
        : `${shotLabel} 关联 ${imageCount} 张角色参考图，超过全能参考上限 ${ALL_REFERENCE_MAX_IMAGES} 张。`
    });
  }
  if (audioAssets.length > ALL_REFERENCE_MAX_AUDIOS) {
    issues.push({
      code: "SHOT_VIDEO_BATCH_REFERENCE_LIMIT",
      message: `${shotLabel} 关联 ${audioAssets.length} 段角色参考声音，超过全能参考上限 ${ALL_REFERENCE_MAX_AUDIOS} 段。`
    });
  }
  const invalidDuration = audioAssets.find((asset) => (
    asset.durationSeconds < ALL_REFERENCE_MEDIA_MIN_SECONDS
    || asset.durationSeconds > ALL_REFERENCE_MEDIA_MAX_SECONDS
  ));
  if (invalidDuration) {
    issues.push({
      code: "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID",
      message: `${shotLabel} 的角色参考声音时长必须在 ${ALL_REFERENCE_MEDIA_MIN_SECONDS}-${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒之间。`
    });
  }
  const totalAudioDuration = audioAssets.reduce((sum, asset) => sum + asset.durationSeconds, 0);
  if (totalAudioDuration > ALL_REFERENCE_MEDIA_TOTAL_SECONDS) {
    issues.push({
      code: "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID",
      message: `${shotLabel} 的角色参考声音总时长不能超过 ${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒，当前 ${totalAudioDuration.toFixed(2)} 秒。`
    });
  }
  return issues;
}

export function buildShotVideoBatchReferenceAssets(shot = {}, characterReferences = []) {
  // 构建期还不知道本镜能不能拿到上一镜抽帧（那要等运行时的 previousReady），所以这里
  // 按 0 张抽帧判定，并跳过「至少要有一项视觉参考」——那一条由知道抽帧可用性的调用方裁决。
  // 判定规则本身与批前预检共用 shotVideoBatchReferenceIssues，不另立第二套。
  const assets = shotCharacterReferenceAssets(shot, characterReferences);
  const blocking = referenceIssuesForAssets(shotReferenceLabel(shot), assets, 0)
    .filter((issue) => issue.code !== "SHOT_VIDEO_BATCH_REFERENCE_REQUIRED");
  if (blocking.length) {
    throw new ProductionStateError(blocking[0].message, { code: blocking[0].code });
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
