import test from "node:test";
import assert from "node:assert/strict";
import {
  SHAPE_METRIC_THRESHOLDS,
  fullStoryShapeMetrics,
  fullStoryShapeWarnings
} from "../public/full-story-shape-metrics.js";

function scene(location, characters, dialogue = []) {
  return { sceneId: "S", location, characters, dialogue, visibleAction: "x" };
}

test("统计画面配置、地点与说话者分布", () => {
  const m = fullStoryShapeMetrics({
    sceneScript: [
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "a" }]),
      scene("客厅", ["奶奶", "小白子"], [{ speaker: "奶奶", line: "b" }]),
      scene("房间", ["小白子"], []),
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "小白子", line: "c" }])
    ]
  });
  // 出镜角色顺序不同不算两种配置
  assert.equal(m.repeatedConfigScenes, 3);
  assert.equal(m.distinctConfigs, 2);
  assert.equal(m.repeatedLocationScenes, 3);
  assert.equal(m.repeatedLocation, "客厅");
  assert.equal(m.dialogueLines, 3);
  assert.equal(m.topSpeaker, "奶奶");
  assert.equal(Number(m.topSpeakerShare.toFixed(2)), 0.67);
  assert.equal(m.silentScenes, 1);
});

test("地点相同但出镜角色不同不算同一种画面配置", () => {
  const m = fullStoryShapeMetrics({
    sceneScript: [
      scene("客厅", ["小白子"]),
      scene("客厅", ["奶奶"]),
      scene("客厅", ["小白子", "奶奶"])
    ]
  });
  assert.equal(m.repeatedLocationScenes, 3);
  assert.equal(m.repeatedConfigScenes, 1, "三种不同的人物组合应是三种配置");
});

test("超过阈值时给出提示，且不抛错", () => {
  const story = {
    sceneScript: [
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "a" }]),
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "b" }]),
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "c" }]),
      scene("山顶", ["小白子", "奶奶"], [{ speaker: "小白子", line: "d" }])
    ]
  };
  const w = fullStoryShapeWarnings(story);
  assert.deepEqual(w.map((x) => x.code), ["REPEATED_SCENE_CONFIG"]);
  assert.match(w[0].label, /3\/4 场画面配置相同/u);
});

test("对白太少时不判定说话者集中——两句话里两句同一人不说明问题", () => {
  const story = {
    sceneScript: [
      scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "a" }]),
      scene("山顶", ["小白子"], [{ speaker: "奶奶", line: "b" }])
    ]
  };
  assert.equal(fullStoryShapeWarnings(story).some((x) => x.code === "DOMINANT_SPEAKER"), false);
  assert.ok(SHAPE_METRIC_THRESHOLDS.minDialogueLines >= 4);
});

test("形状正常时返回空数组，且这不代表故事好", () => {
  const story = {
    sceneScript: [
      scene("客厅", ["小白子"], [{ speaker: "小白子", line: "a" }]),
      scene("房间", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "b" }]),
      scene("山顶", ["奶奶"], [{ speaker: "奶奶", line: "c" }]),
      scene("小路", ["小白子", "芙芙猫"], [{ speaker: "小白子", line: "d" }])
    ]
  };
  assert.deepEqual(fullStoryShapeWarnings(story), []);
});

test("缺失或残缺输入不抛错，只返回空", () => {
  for (const bad of [null, undefined, {}, { sceneScript: [] }, { sceneScript: "x" }]) {
    assert.equal(fullStoryShapeMetrics(bad), null);
    assert.deepEqual(fullStoryShapeWarnings(bad), []);
  }
  // 场次里缺字段也不能崩
  assert.ok(fullStoryShapeMetrics({ sceneScript: [{}, { characters: null, dialogue: null }] }));
});

// 同地点占比中位数就是 0.50——六十秒短片集中在一两个地点是常态。
// 按它提示会命中 60% 的历史 Full Story，等于噪声，会淹掉真正异常的那 10%。
test("同地点不触发提示，但数字仍然计算并可展示", () => {
  const story = {
    sceneScript: [
      scene("客厅", ["小白子"], [{ speaker: "小白子", line: "a" }]),
      scene("客厅", ["奶奶"], [{ speaker: "奶奶", line: "b" }]),
      scene("客厅", ["芙芙猫"], [{ speaker: "小白子", line: "c" }]),
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "d" }])
    ]
  };
  assert.equal(fullStoryShapeMetrics(story).repeatedLocationScenes, 4);
  assert.deepEqual(fullStoryShapeWarnings(story), [], "四场同地点但配置各不相同，不该提示");
});

test("全片台词出自同一人时提示——这是实测中最病态的形态", () => {
  const story = {
    sceneScript: [
      scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "a" }, { speaker: "奶奶", line: "b" }]),
      scene("山顶", ["奶奶"], [{ speaker: "奶奶", line: "c" }]),
      scene("小路", ["芙芙猫"], [{ speaker: "奶奶", line: "d" }])
    ]
  };
  const w = fullStoryShapeWarnings(story);
  assert.deepEqual(w.map((x) => x.code), ["DOMINANT_SPEAKER"]);
  assert.match(w[0].label, /100% 台词出自「奶奶」/u);
});

// 阈值曾写成小数 0.67，把「六场里四场同配置」正好三分之二的情况漏掉了
// （4/6 = 0.6667 < 0.67）——而那恰恰是要抓的形态。改用分数 2/3。
test("六场里四场同配置正好是三分之二，必须被标出", () => {
  const same = () => scene("教室窗边座位", ["小白子", "芙芙猫"]);
  const story = {
    sceneScript: [same(), same(), same(), same(),
      scene("教室窗边座位", ["小白子"]),
      scene("教室门口", ["小白子", "芙芙猫"])]
  };
  const w = fullStoryShapeWarnings(story);
  assert.deepEqual(w.map((x) => x.code), ["REPEATED_SCENE_CONFIG"]);
  assert.match(w[0].label, /4\/6 场画面配置相同/u);
});

test("不足三分之二时仍然放行", () => {
  const same = () => scene("教室", ["小白子", "芙芙猫"]);
  const story = {
    sceneScript: [same(), same(), same(),
      scene("门口", ["小白子"]), scene("操场", ["芙芙猫"]), scene("走廊", ["小白子", "奶奶"])]
  };
  assert.deepEqual(fullStoryShapeWarnings(story), [], "3/6 未达三分之二");
});
