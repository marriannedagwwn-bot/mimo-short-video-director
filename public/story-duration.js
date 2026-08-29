// Full Story 目标时长的解析。
//
// 这个值是**给模型的目标**，不是对派生结果的覆盖：Artifact 里的
// targetDurationSeconds 仍由服务端从 sceneScript 时间轴确定性派生
// （见 src/validation.js 的 deriveFullStoryTargetDuration）。
// 用户在这里选 45 秒而模型排出 62 秒时，Artifact 与页面显示的都是 62 秒。
// 守住这条边界，否则会重新打开「声明 60 秒却排出 106 秒」那个已修复的缺陷。

export const STORY_DURATION_SOURCE = "source";
export const STORY_DURATION_FALLBACK_SECONDS = 60;
export const STORY_DURATION_PRESETS = Object.freeze([45, 60, 75, 90]);

// 请求侧的合理区间。超出即拒绝——不是剧作判断，是防止把 0 或 99999 送进提示词。
export const STORY_DURATION_MIN_SECONDS = 20;
export const STORY_DURATION_MAX_SECONDS = 180;

// 与 src/validation.js 的 parseSceneTimeRangeBounds 同一口径：秒位接受 0–99，
// 00:60 在 mm:ss 下只可能是 60 秒，按 m*60+s 折算是确定性算术。
// 浏览器侧不能 import 服务端模块，这里只做同规格的只读解析，不新增第二套语义。
const TIME_RANGE = /^\s*(\d{1,3}):(\d{1,2})\s*[-–—]\s*(\d{1,3}):(\d{1,2})\s*$/u;

function timeRangeEndSeconds(timeRange) {
  const m = TIME_RANGE.exec(String(timeRange || ""));
  if (!m) return null;
  const end = Number(m[3]) * 60 + Number(m[4]);
  return Number.isFinite(end) ? end : null;
}

// 原片时长的两级回退：
//   1) 上传时浏览器从视频文件读出的真实时长，精确
//   2) sourceScriptReconstruction 末场时间轴终点——恢复旧 run 时文件已不在，
//      用这个持久化来源（实测与真实时长差 0–5 秒）
// 都取不到时返回 null，由调用方决定回退值。
export function resolveSourceDurationSeconds({ metadata = null, sourceScriptReconstruction = null } = {}) {
  const fromFile = Number(metadata?.duration);
  if (Number.isFinite(fromFile) && fromFile > 0) return Math.round(fromFile);

  const scenes = sourceScriptReconstruction?.scenes;
  if (!Array.isArray(scenes)) return null;
  let latest = 0;
  for (const scene of scenes) {
    const end = timeRangeEndSeconds(scene?.timeRange);
    if (end !== null && end > latest) latest = end;
  }
  return latest > 0 ? latest : null;
}

// 把控件选项解析成实际秒数。选「与原片对齐」但原片时长不可得时回退到 60。
export function resolveStoryDurationTarget(selection, context = {}) {
  if (selection !== STORY_DURATION_SOURCE) {
    const preset = Number(selection);
    if (Number.isInteger(preset) && STORY_DURATION_PRESETS.includes(preset)) return preset;
    return STORY_DURATION_FALLBACK_SECONDS;
  }
  return resolveSourceDurationSeconds(context) ?? STORY_DURATION_FALLBACK_SECONDS;
}

// 下拉选项。「与原片对齐」的标签带上实际秒数，让用户在生成前就知道会得到多长。
export function storyDurationOptions(context = {}) {
  const sourceSeconds = resolveSourceDurationSeconds(context);
  return [
    {
      value: STORY_DURATION_SOURCE,
      seconds: sourceSeconds ?? STORY_DURATION_FALLBACK_SECONDS,
      label: sourceSeconds ? `与原片对齐 · ${sourceSeconds} 秒` : "与原片对齐"
    },
    ...STORY_DURATION_PRESETS.map((seconds) => ({ value: String(seconds), seconds, label: `${seconds} 秒` }))
  ];
}

// 请求侧校验：只拦明显非法的值，不裁决"这个时长合不合适"。
export function isValidStoryDurationSeconds(value) {
  return Number.isInteger(value)
    && value >= STORY_DURATION_MIN_SECONDS
    && value <= STORY_DURATION_MAX_SECONDS;
}
