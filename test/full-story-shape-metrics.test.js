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

// 配置键看的是「地点 + 主角在不在场」，所以 fixture 要带上 characterBible
function story(scenes, protagonist = "小白子") {
  return { characterBible: { protagonist: { name: protagonist } }, sceneScript: scenes };
}

test("统计画面配置、地点与说话者分布", () => {
  const m = fullStoryShapeMetrics(story([
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "a" }]),
      scene("客厅", ["奶奶", "小白子"], [{ speaker: "奶奶", line: "b" }]),
      scene("房间", ["小白子"], []),
      scene("客厅", ["小白子", "奶奶"], [{ speaker: "小白子", line: "c" }])
  ]));
  // 客厅三场主角都在场，算同一种配置；房间那场地点不同
  assert.equal(m.repeatedConfigScenes, 3);
  assert.equal(m.distinctConfigs, 2);
  assert.equal(m.repeatedLocationScenes, 3);
  assert.equal(m.repeatedLocation, "客厅");
  assert.equal(m.dialogueLines, 3);
  assert.equal(m.topSpeaker, "奶奶");
  assert.equal(Number(m.topSpeakerShare.toFixed(2)), 0.67);
  assert.equal(m.silentScenes, 1);
});

// 旧实现用「地点 + 完整角色集合」，导致把配角移出画面就能刷掉提示：
// 同一份故事只要让配角在两场里不出镜，同配置就从 4/6 掉到 3/6，
// 而六场戏依然在同一张桌子前、同一个机位。
test("配角进出画面不改变画面配置，主角是否在场才算", () => {
  const m = fullStoryShapeMetrics(story([
    scene("客厅", ["小白子"]),
    scene("客厅", ["小白子", "奶奶"]),
    scene("客厅", ["小白子", "芙芙猫"])
  ]));
  assert.equal(m.repeatedConfigScenes, 3, "三场都是客厅且主角在场，是同一种画面");
  assert.equal(m.distinctConfigs, 1);

  const protagonistLeaves = fullStoryShapeMetrics(story([
    scene("客厅", ["小白子"]),
    scene("客厅", ["奶奶"]),
    scene("客厅", ["小白子"])
  ]));
  assert.equal(protagonistLeaves.distinctConfigs, 2, "主角离场才是真的换了画面");
});

test("超过阈值时给出提示，且不抛错", () => {
  const w = fullStoryShapeWarnings(story([
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "a" }]),
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "b" }]),
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "c" }]),
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "d" }]),
    scene("山顶", ["小白子"], [{ speaker: "小白子", line: "e" }])
  ]));
  assert.deepEqual(w.map((x) => x.code), ["REPEATED_SCENE_CONFIG"]);
  assert.match(w[0].label, /4\/5 场画面配置相同/u);
});

test("对白太少时不判定说话者集中——两句话里两句同一人不说明问题", () => {
  const s = story([
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "a" }]),
    scene("山顶", ["小白子"], [{ speaker: "奶奶", line: "b" }])
  ]);
  assert.equal(fullStoryShapeWarnings(s).some((x) => x.code === "DOMINANT_SPEAKER"), false);
  assert.ok(SHAPE_METRIC_THRESHOLDS.minDialogueLines >= 4);
});

test("形状正常时返回空数组，且这不代表故事好", () => {
  const s = story([
      scene("客厅", ["小白子"], [{ speaker: "小白子", line: "a" }]),
      scene("房间", ["小白子", "奶奶"], [{ speaker: "奶奶", line: "b" }]),
      scene("山顶", ["奶奶"], [{ speaker: "奶奶", line: "c" }]),
      scene("小路", ["小白子", "芙芙猫"], [{ speaker: "小白子", line: "d" }])
  ]);
  assert.deepEqual(fullStoryShapeWarnings(s), []);
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
// 同地点占比中位数就是 0.50——六十秒短片集中在一两个地点是常态，
// 按它单独提示会命中 60%，等于噪声。数字仍然计算并可展示。
test("同地点本身不触发提示，主角频繁离场时画面仍算有变化", () => {
  const s = story([
    scene("客厅", ["小白子"], [{ speaker: "小白子", line: "a" }]),
    scene("客厅", ["奶奶"], [{ speaker: "奶奶", line: "b" }]),
    scene("客厅", ["芙芙猫"], [{ speaker: "小白子", line: "c" }]),
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "d" }])
  ]);
  assert.equal(fullStoryShapeMetrics(s).repeatedLocationScenes, 4);
  assert.deepEqual(fullStoryShapeWarnings(s), [], "主角两场在两场不在，未达 0.8");
});

test("全片台词出自同一人时提示——这是实测中最病态的形态", () => {
  const w = fullStoryShapeWarnings(story([
    scene("客厅", ["小白子"], [{ speaker: "奶奶", line: "a" }, { speaker: "奶奶", line: "b" }]),
    scene("山顶", ["奶奶"], [{ speaker: "奶奶", line: "c" }]),
    scene("小路", ["芙芙猫"], [{ speaker: "奶奶", line: "d" }])
  ]));
  assert.ok(w.some((x) => x.code === "DOMINANT_SPEAKER"));
  assert.match(w.find((x) => x.code === "DOMINANT_SPEAKER").label, /100% 台词出自「奶奶」/u);
});

// 阈值曾写成小数 0.67，把「六场里四场同配置」正好三分之二的情况漏掉了
// （4/6 = 0.6667 < 0.67）——而那恰恰是要抓的形态。改用分数 2/3。
// 真实回放：《画不圆的太阳》两版都是六场里五场在同一张桌子前、主角始终在场。
// 旧配置键因为配角进出把两版算成 4/6 与 3/6（后者不提示），新键都是 5/6。
test("六场里五场同配置必须被标出", () => {
  const desk = (cast) => scene("教室窗边座位", cast);
  const w = fullStoryShapeWarnings(story([
    desk(["小白子"]), desk(["小白子", "芙芙猫"]), desk(["小白子", "芙芙猫"]),
    desk(["小白子"]), desk(["小白子"]),
    scene("教室门口", ["小白子", "芙芙猫"])
  ]));
  assert.deepEqual(w.map((x) => x.code), ["REPEATED_SCENE_CONFIG"]);
  assert.match(w[0].label, /5\/6 场画面配置相同/u);
});

test("地点真的分散时放行", () => {
  assert.deepEqual(fullStoryShapeWarnings(story([
    scene("教室", ["小白子"]), scene("教室", ["小白子"]), scene("门口", ["小白子"]),
    scene("操场", ["小白子"]), scene("走廊", ["小白子"]), scene("回家路上", ["小白子"])
  ])), [], "四个地点，最多 2/6 同配置");
});
