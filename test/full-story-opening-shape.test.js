import test from "node:test";
import assert from "node:assert/strict";
import { fullStoryPrompt } from "../src/prompts.js";

// full_story/1.1 不再把参考片开场直接注入已选候选的展开。
const reconstruction = Object.freeze({
  scenes: [
    {
      sceneId: "S1",
      timeRange: "00:00-00:14",
      characters: ["咕嘎", "糯糯", "奶奶"],
      visibleActions: ["糯糯从衣柜取出叠好的衣服递给咕嘎", "咕嘎趴在衣服上用身体压平"],
      location: "室内",
      dialogueGist: "咕嘎自称咕嘎牌熨斗"
    },
    { sceneId: "S2", timeRange: "00:15-00:18", characters: ["咕嘎"], visibleActions: ["搬箱子"], location: "门口" }
  ]
});

const prompt = (overrides = {}) => fullStoryPrompt({
  variant: { id: "V1" }, creativeBrief: {}, creatorProfile: {}, ...overrides
});

test("开场承接选中候选，不把原片第一场作为本片模板", () => {
  const variant = { id: "V1", storyOutline: [{ beat: 1, action: "女孩蹲在窗边等灯亮。" }] };
  const text = prompt({ variant, sourceScriptReconstruction: reconstruction });
  assert.match(text, /女孩蹲在窗边等灯亮/u);
  assert.doesNotMatch(text, /糯糯从衣柜取出叠好的衣服递给咕嘎|咕嘎牌熨斗/u);
  assert.match(text, /当前候选 storyOutline\[\]\.action 是已选剧情的权威/u);
});

test("更换原片开场不会改变同一候选的展开提示词", () => {
  const other = { scenes: [{ sceneId: "S1", characters: ["阿海"], visibleActions: ["解开渔网"] }] };
  assert.equal(prompt({ sourceScriptReconstruction: reconstruction }), prompt({ sourceScriptReconstruction: other }));
});

test("没有重构数据时整段省略，不猜一个开场出来", () => {
  assert.doesNotMatch(prompt(), /原片第一场是怎么开的/u);
  assert.doesNotMatch(prompt({ sourceScriptReconstruction: { scenes: [] } }), /原片第一场是怎么开的/u);
  assert.doesNotMatch(
    prompt({ sourceScriptReconstruction: { scenes: [{ sceneId: "S1" }] } }),
    /原片第一场是怎么开的/u
  );
});
