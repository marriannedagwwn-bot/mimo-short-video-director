import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDirectShotSkeleton,
  directShotSkeletonForScenes,
  directShotSkeletonRuntimeSeconds,
  formatDirectShotSkeleton
} from "../src/direct-shot-timeline.js";
import { parseSceneTimeRangeBounds, parseSceneTimeRangeSeconds } from "../src/validation.js";

function scenes(...timeRanges) {
  return {
    sceneScript: timeRanges.map((timeRange, index) => ({
      sceneId: `S${index + 1}`,
      timeRange,
      dramaticFunction: `功能${index + 1}`,
      emotionNode: `情绪${index + 1}`
    }))
  };
}

function durationsFor(...timeRanges) {
  return deriveDirectShotSkeleton(scenes(...timeRanges)).map((shot) => shot.durationSeconds);
}

function codeOf(error) {
  return error?.details?.[0]?.code || "";
}

test("timeRange 秒位放宽到 0-99，按 m*60+s 折算而不是猜测", () => {
  assert.deepEqual(parseSceneTimeRangeBounds("00:15-00:33"), { startSeconds: 15, endSeconds: 33 });
  // "00:60" 在 mm:ss 下只可能是 60 秒，与 "01:00" 完全等价：确定性算术，不是推断。
  assert.deepEqual(parseSceneTimeRangeBounds("00:45-00:60"), { startSeconds: 45, endSeconds: 60 });
  assert.deepEqual(parseSceneTimeRangeBounds("00:45-01:00"), { startSeconds: 45, endSeconds: 60 });
  assert.equal(parseSceneTimeRangeSeconds("00:45-00:60"), 15);
  assert.equal(parseSceneTimeRangeSeconds("00:45-01:00"), 15);
  // 分隔符仍然接受全角破折号与波浪线。
  assert.equal(parseSceneTimeRangeSeconds("00:00–00:08"), 8);
  assert.equal(parseSceneTimeRangeSeconds("00:00~00:08"), 8);
  // 真正畸形的值、零跨度和逆序跨度仍然解析失败。
  assert.equal(parseSceneTimeRangeBounds("00:1x-00:20"), null);
  assert.equal(parseSceneTimeRangeBounds("时长未知"), null);
  assert.equal(parseSceneTimeRangeBounds("00:100-00:120"), null);
  assert.equal(parseSceneTimeRangeSeconds("00:20-00:20"), null);
  assert.equal(parseSceneTimeRangeSeconds("00:20-00:10"), null);
});

test("≤15 秒的场次严格一对一映射，不再二次拆镜", () => {
  const story = scenes("00:00-00:08", "00:08-00:14", "00:14-00:29", "00:29-00:33");
  const skeleton = deriveDirectShotSkeleton(story);

  assert.equal(skeleton.length, story.sceneScript.length);
  assert.deepEqual(skeleton.map((shot) => shot.sourceSceneId), ["S1", "S2", "S3", "S4"]);
  assert.deepEqual(skeleton.map((shot) => shot.shotId), ["A01", "A02", "A03", "A04"]);
  assert.deepEqual(skeleton.map((shot) => shot.durationSeconds), [8, 6, 15, 4]);
  assert.deepEqual(skeleton.map((shot) => shot.partCount), [1, 1, 1, 1]);
  // storyPurpose / emotionalTarget 分别由 dramaticFunction / emotionNode 注入。
  assert.deepEqual(skeleton.map((shot) => shot.storyPurpose), ["功能1", "功能2", "功能3", "功能4"]);
  assert.deepEqual(skeleton.map((shot) => shot.emotionalTarget), ["情绪1", "情绪2", "情绪3", "情绪4"]);
  assert.equal(directShotSkeletonRuntimeSeconds(skeleton), 33);
});

test(">15 秒的场次按 ceil(跨度/15) 均分，余数逐秒给靠前的镜头", () => {
  // 16 → 两段；20 → 恰好两段各 10 秒（用户要求的"上下两段"）。
  assert.deepEqual(durationsFor("00:00-00:16"), [8, 8]);
  assert.deepEqual(durationsFor("00:00-00:20"), [10, 10]);
  // 17 秒无法整除：余数给第一段。
  assert.deepEqual(durationsFor("00:00-00:17"), [9, 8]);
  // 30 秒仍是两段；31 秒进入三段。
  assert.deepEqual(durationsFor("00:00-00:30"), [15, 15]);
  assert.deepEqual(durationsFor("00:00-00:31"), [11, 10, 10]);
  assert.deepEqual(durationsFor("00:00-00:34"), [12, 11, 11]);
  // 任何拆分结果都必须落在供应商能渲染的 4–15 秒区间内。
  for (let span = 4; span <= 300; span += 1) {
    const parts = durationsFor(`00:00-${String(Math.floor(span / 60)).padStart(2, "0")}:${String(span % 60).padStart(2, "0")}`);
    assert.equal(parts.reduce((total, value) => total + value, 0), span, `${span} 秒的各段合计必须等于原跨度`);
    parts.forEach((duration) => {
      assert.ok(Number.isInteger(duration) && duration >= 4 && duration <= 15, `${span} 秒拆出了不可渲染的 ${duration} 秒镜头`);
    });
  }
});

test("拆分后的镜头相邻排列，shotId 全局连续，起点按段累加", () => {
  const skeleton = deriveDirectShotSkeleton(scenes("00:00-00:08", "00:08-00:28", "00:28-00:34"));

  assert.deepEqual(skeleton.map((shot) => shot.shotId), ["A01", "A02", "A03", "A04"]);
  assert.deepEqual(skeleton.map((shot) => shot.sourceSceneId), ["S1", "S2", "S2", "S3"]);
  assert.deepEqual(skeleton.map((shot) => [shot.partIndex, shot.partCount]), [[0, 1], [0, 2], [1, 2], [0, 1]]);
  assert.deepEqual(skeleton.map((shot) => shot.startSeconds), [0, 8, 18, 28]);
  // 每场各段合计等于该场 timeRange 跨度。
  assert.equal(
    skeleton.filter((shot) => shot.sourceSceneId === "S2")
      .reduce((total, shot) => total + shot.durationSeconds, 0),
    20
  );
});

test("timeRange 不可解析、非正跨度、跨场次逆序、低于供应商下限都明确失败", () => {
  assert.throws(
    () => deriveDirectShotSkeleton(scenes("乱写")),
    (error) => codeOf(error) === "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID"
      && /无法解析为 mm:ss-mm:ss/u.test(error.message)
  );
  assert.throws(
    () => deriveDirectShotSkeleton(scenes("00:20-00:20")),
    (error) => codeOf(error) === "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID"
  );
  assert.throws(
    () => deriveDirectShotSkeleton(scenes("00:20-00:10")),
    (error) => codeOf(error) === "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID"
  );
  // S2 的起点早于 S1 的终点：时间线逆序，不选边、不重排。
  assert.throws(
    () => deriveDirectShotSkeleton(scenes("00:00-00:20", "00:10-00:30")),
    (error) => codeOf(error) === "DIRECT_SHOT_SCENE_TIME_RANGE_OUT_OF_ORDER"
      && /fullStory\.sceneScript\[1\]\.timeRange/u.test(error.details[0].path)
  );
  // 3 秒场次低于两家供应商的共同下限：不补长、不合并，直接失败。
  assert.throws(
    () => deriveDirectShotSkeleton(scenes("00:00-00:03")),
    (error) => codeOf(error) === "DIRECT_SHOT_SCENE_DURATION_BELOW_PROVIDER_MINIMUM"
      && /不得补长、缩短或合并场次/u.test(error.message)
  );
  assert.throws(() => deriveDirectShotSkeleton({ sceneScript: [] }), /无法派生 direct_shot 镜头骨架/u);
});

test("场次之间允许留白，只禁止重叠与回退", () => {
  const skeleton = deriveDirectShotSkeleton(scenes("00:00-00:08", "00:12-00:20"));
  assert.deepEqual(skeleton.map((shot) => shot.durationSeconds), [8, 8]);
  // 留白不计入成片时长：总长是各镜时长之和，不是首尾时间差。
  assert.equal(directShotSkeletonRuntimeSeconds(skeleton), 16);
});

test("批次切片保持全局顺序，提示词投影逐场列出镜头", () => {
  const story = scenes("00:00-00:08", "00:08-00:28", "00:28-00:34");
  const skeleton = deriveDirectShotSkeleton(story);
  const slice = directShotSkeletonForScenes(skeleton, [story.sceneScript[1], story.sceneScript[2]]);

  assert.deepEqual(slice.map((shot) => shot.shotId), ["A02", "A03", "A04"]);
  assert.equal(
    formatDirectShotSkeleton(slice),
    "S2（00:08-00:28，20 秒）→ 2 个镜头：A02 10 秒（第 1/2 段）、A03 10 秒（第 2/2 段）"
    + "；S3（00:28-00:34，6 秒）→ 1 个镜头：A04 6 秒"
  );
  assert.equal(formatDirectShotSkeleton([]), "空");
  // 用 sceneId 字符串取切片与用场次对象取切片必须等价。
  assert.deepEqual(directShotSkeletonForScenes(skeleton, ["S1"]), [skeleton[0]]);
});
