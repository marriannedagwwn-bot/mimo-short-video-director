import {
  DIRECT_SHOT_MAX_DURATION_SECONDS,
  DIRECT_SHOT_MIN_DURATION_SECONDS,
  OutputContractError,
  parseSceneTimeRangeBounds
} from "./validation.js";

// Full Story 时间轴检查：从 fullStory.sceneScript[] 的 timeRange 确定性派生镜头骨架，
// 签发完整剧情前用它确认每场可拍（timeRange 可解析、按顺序推进、每段不短于供应商 4 秒下限）。
// 旧 3.0 direct_shot 分镜生成曾用这份骨架拆镜填写，2026-10-11 已随旧分镜删除；
// 这里只保留派生与检查本身，规则逐字不变。

// 唯一的拆镜条件：单场跨度超过 DIRECT_SHOT_MAX_DURATION_SECONDS 时按 ceil 均分。
// 边界常量由 validation.js 统一签发，这里不另立第二份。

export const DIRECT_SHOT_TIME_RANGE_INVALID = "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID";
export const DIRECT_SHOT_TIME_RANGE_OUT_OF_ORDER = "DIRECT_SHOT_SCENE_TIME_RANGE_OUT_OF_ORDER";
export const DIRECT_SHOT_DURATION_BELOW_PROVIDER_MINIMUM = "DIRECT_SHOT_SCENE_DURATION_BELOW_PROVIDER_MINIMUM";

function fail(code, path, message) {
  throw new OutputContractError(message, [{ code, path, reason: message }]);
}

// 把一场的秒数切成 partCount 段：尽量均分，余数逐秒发给靠前的镜头。
// 20 → [10,10]；17 → [9,8]；34 → [12,11,11]。结果恒为整数且合计等于原跨度。
function splitSceneSeconds(span) {
  const partCount = Math.ceil(span / DIRECT_SHOT_MAX_DURATION_SECONDS);
  const base = Math.floor(span / partCount);
  const remainder = span % partCount;
  return Array.from({ length: partCount }, (unused, index) => base + (index < remainder ? 1 : 0));
}

export function formatDirectShotClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function directShotId(sequenceNumber) {
  return `A${String(sequenceNumber).padStart(2, "0")}`;
}

/**
 * 从 Full Story 派生完整镜头骨架。纯函数：不调用模型、不猜测、不钳制。
 * timeRange 不可解析、跨度非正、跨场次逆序或任一段低于供应商下限时明确失败。
 */
export function deriveDirectShotSkeleton(fullStory) {
  const scenes = Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : [];
  if (!scenes.length) {
    fail(
      DIRECT_SHOT_TIME_RANGE_INVALID,
      "fullStory.sceneScript",
      "fullStory.sceneScript 为空，无法派生 direct_shot 镜头骨架"
    );
  }

  const skeleton = [];
  let previousEndSeconds = null;
  let previousSceneId = "";

  scenes.forEach((scene, sceneIndex) => {
    const path = `fullStory.sceneScript[${sceneIndex}].timeRange`;
    const sourceSceneId = String(scene?.sceneId || "").trim();
    const timeRange = String(scene?.timeRange || "").trim();
    const bounds = parseSceneTimeRangeBounds(timeRange);
    if (!bounds) {
      fail(
        DIRECT_SHOT_TIME_RANGE_INVALID,
        path,
        `${sourceSceneId || `第 ${sceneIndex + 1} 场`} 的 timeRange “${timeRange}” 无法解析为 mm:ss-mm:ss；`
        + "镜头时长必须由 timeRange 确定性派生，不能猜测或退回默认值。"
      );
    }
    const span = bounds.endSeconds - bounds.startSeconds;
    if (span <= 0) {
      fail(
        DIRECT_SHOT_TIME_RANGE_INVALID,
        path,
        `${sourceSceneId || `第 ${sceneIndex + 1} 场`} 的 timeRange “${timeRange}” 跨度为 ${span} 秒；`
        + "场次时长必须为正数，不能钳制或补长。"
      );
    }
    if (previousEndSeconds !== null && bounds.startSeconds < previousEndSeconds) {
      fail(
        DIRECT_SHOT_TIME_RANGE_OUT_OF_ORDER,
        path,
        `${sourceSceneId || `第 ${sceneIndex + 1} 场`} 的 timeRange “${timeRange}” 起点早于上一场 `
        + `${previousSceneId} 的终点 ${formatDirectShotClock(previousEndSeconds)}；场次时间线必须按顺序推进。`
      );
    }

    const parts = splitSceneSeconds(span);
    parts.forEach((durationSeconds, partIndex) => {
      if (durationSeconds < DIRECT_SHOT_MIN_DURATION_SECONDS) {
        fail(
          DIRECT_SHOT_DURATION_BELOW_PROVIDER_MINIMUM,
          path,
          `${sourceSceneId || `第 ${sceneIndex + 1} 场`} 的 timeRange “${timeRange}” 只有 ${span} 秒，`
          + `低于视频供应商的 ${DIRECT_SHOT_MIN_DURATION_SECONDS} 秒单镜下限；`
          + "不得补长、缩短或合并场次，请修正 Full Story 的场次时长。"
        );
      }
      const startSeconds = bounds.startSeconds
        + parts.slice(0, partIndex).reduce((total, value) => total + value, 0);
      skeleton.push(Object.freeze({
        shotId: directShotId(skeleton.length + 1),
        sourceSceneId,
        sceneIndex,
        partIndex,
        partCount: parts.length,
        startSeconds,
        durationSeconds,
        sceneTimeRange: timeRange,
        sceneSpanSeconds: span,
        storyPurpose: String(scene?.dramaticFunction || ""),
        emotionalTarget: String(scene?.emotionNode || "")
      }));
    });

    previousEndSeconds = bounds.endSeconds;
    previousSceneId = sourceSceneId || `第 ${sceneIndex + 1} 场`;
  });

  return Object.freeze(skeleton);
}
