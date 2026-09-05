import test from "node:test";
import assert from "node:assert/strict";
import {
  STORY_DURATION_FALLBACK_SECONDS,
  STORY_DURATION_MAX_SECONDS,
  STORY_DURATION_MIN_SECONDS,
  STORY_DURATION_SOURCE,
  isValidStoryDurationSeconds,
  resolveSourceDurationSeconds,
  resolveStoryDurationTarget,
  storyDurationOptions,
  storyDurationWindow,
  storyOutlineTotalSeconds
} from "../public/story-duration.js";

const RECON = {
  scenes: [
    { timeRange: "00:00-00:08" },
    { timeRange: "00:08-00:35" },
    { timeRange: "01:08-01:19" }
  ]
};

test("优先用上传文件读出的真实时长", () => {
  assert.equal(resolveSourceDurationSeconds({
    metadata: { duration: 79.4 },
    sourceScriptReconstruction: RECON
  }), 79);
});

test("没有上传文件时回退到原片还原的时间轴末端", () => {
  // 恢复旧 run 时视频文件已不在，只剩持久化的还原时间轴
  assert.equal(resolveSourceDurationSeconds({ sourceScriptReconstruction: RECON }), 79);
});

test("取时间轴的最大终点，不假设场次已按时间排序", () => {
  assert.equal(resolveSourceDurationSeconds({
    sourceScriptReconstruction: { scenes: [{ timeRange: "01:08-01:19" }, { timeRange: "00:00-00:08" }] }
  }), 79);
});

test("秒位接受 0-99，与服务端时间轴解析同口径", () => {
  assert.equal(resolveSourceDurationSeconds({ sourceScriptReconstruction: { scenes: [{ timeRange: "00:00-00:60" }] } }), 60);
});

test("两者都取不到或不可解析时返回 null，由调用方决定回退", () => {
  for (const bad of [
    {},
    { metadata: { duration: 0 } },
    { metadata: { duration: NaN } },
    { sourceScriptReconstruction: { scenes: [] } },
    { sourceScriptReconstruction: { scenes: [{ timeRange: "不是时间" }] } },
    { sourceScriptReconstruction: { scenes: "x" } }
  ]) {
    assert.equal(resolveSourceDurationSeconds(bad), null, JSON.stringify(bad));
  }
  assert.equal(resolveSourceDurationSeconds(), null);
});

test("选「与原片对齐」时解析成原片秒数，取不到则回退 60", () => {
  assert.equal(resolveStoryDurationTarget(STORY_DURATION_SOURCE, { metadata: { duration: 96 } }), 96);
  assert.equal(resolveStoryDurationTarget(STORY_DURATION_SOURCE, {}), STORY_DURATION_FALLBACK_SECONDS);
});

test("选固定档位时忽略原片时长", () => {
  assert.equal(resolveStoryDurationTarget("45", { metadata: { duration: 96 } }), 45);
  assert.equal(resolveStoryDurationTarget("90", {}), 90);
});

test("非法档位回退到 60，不把脏值送进提示词", () => {
  for (const bad of ["", "abc", "0", "999", null, undefined]) {
    assert.equal(resolveStoryDurationTarget(bad, {}), STORY_DURATION_FALLBACK_SECONDS);
  }
});

test("下拉标签在有原片时显示秒数，无原片时只显示「与原片对齐」", () => {
  const withSource = storyDurationOptions({ metadata: { duration: 79 } });
  assert.equal(withSource[0].label, "与原片对齐 · 79 秒");
  assert.equal(withSource[0].value, STORY_DURATION_SOURCE);
  assert.deepEqual(withSource.slice(1).map((o) => o.label), ["45 秒", "60 秒", "75 秒", "90 秒"]);

  assert.equal(storyDurationOptions({})[0].label, "与原片对齐");
});

test("请求侧只拦明显非法的值，不裁决时长合不合适", () => {
  assert.ok(isValidStoryDurationSeconds(STORY_DURATION_MIN_SECONDS));
  assert.ok(isValidStoryDurationSeconds(STORY_DURATION_MAX_SECONDS));
  assert.ok(isValidStoryDurationSeconds(96), "原片 96 秒必须允许，否则与「与原片对齐」矛盾");
  for (const bad of [0, -1, 19, 181, 60.5, "60", null, undefined, NaN]) {
    assert.equal(isValidStoryDurationSeconds(bad), false, String(bad));
  }
});

test("目标窗口只有一份比例，取整方向固定为下界 floor、上界 ceil", () => {
  // 65 秒是「与原片对齐」的实测值，55/75 必须与 fullStoryPrompt 历史行为逐字一致
  assert.deepEqual(storyDurationWindow(65), { min: 55, max: 75 });
  assert.deepEqual(storyDurationWindow(60), { min: 51, max: 69 });
  assert.deepEqual(storyDurationWindow(45), { min: 38, max: 52 });
  assert.deepEqual(storyDurationWindow(90), { min: 76, max: 104 });
  // 取整方向：0.85/1.15 的乘积几乎总是小数，下界不能进位、上界不能截断，
  // 否则提示词文案与卡片判色会算出不同的边界。
  assert.equal(storyDurationWindow(65).min, Math.floor(65 * 0.85));
  assert.equal(storyDurationWindow(65).max, Math.ceil(65 * 1.15));
});

test("目标缺失或非法时窗口返回 null，由调用方决定整段省略", () => {
  for (const bad of [0, -1, null, undefined, NaN, "abc"]) {
    assert.equal(storyDurationWindow(bad), null, String(bad));
  }
});

test("候选合计跳过非有限秒数而不是抛错", () => {
  // 实测那份 95 秒候选的六拍
  assert.equal(storyOutlineTotalSeconds([
    { estimatedSeconds: 12 }, { estimatedSeconds: 15 }, { estimatedSeconds: 18 },
    { estimatedSeconds: 15 }, { estimatedSeconds: 20 }, { estimatedSeconds: 15 }
  ]), 95);
  // estimatedSeconds 的 schema 只有 { type: "number" }，没有 minimum，
  // 所以这里是展示口径而不是校验器：坏值跳过，不阻断渲染。
  assert.equal(storyOutlineTotalSeconds([
    { estimatedSeconds: 10 }, { estimatedSeconds: "x" }, { estimatedSeconds: 0 },
    { estimatedSeconds: -5 }, {}, { estimatedSeconds: 8 }
  ]), 18);
  assert.equal(storyOutlineTotalSeconds(null), 0);
  assert.equal(storyOutlineTotalSeconds([]), 0);
});
