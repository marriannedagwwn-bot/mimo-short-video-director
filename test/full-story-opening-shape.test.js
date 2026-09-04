import test from "node:test";
import assert from "node:assert/strict";
import { fullStoryPrompt } from "../src/prompts.js";

// 参考片第一场是三个角色、活动已经在进行中，而且全片最大的萌点就在那里；
// 而生成的故事第一场几乎全是「主角背着书包走在放学路上」。回扫 124 份历史 Full Story：
// 40% 第一场只有 ≤1 个角色，35% 开头是移动或抵达措辞。
//
// 投影全部从 sourceScriptReconstruction 现算，不写死任何数值——换参考片自动跟着变。
// 这是 Prompt 生成约束，没有确定性校验兜底：判断一个开场算不算「已经在进行中」需要
// 语义判断，写死词表会误伤「她推门进屋，锅已经在灶上响」这类合法写法。
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

test("开场形状从参考片现算，角色数与动作都不写死", () => {
  const text = prompt({ sourceScriptReconstruction: reconstruction });
  assert.match(text, /原片开场（00:00-00:14）画面里就有 3 个角色：咕嘎、糯糯、奶奶/u);
  assert.match(text, /已经在进行中/u);
  assert.match(text, /糯糯从衣柜取出叠好的衣服递给咕嘎/u);
  assert.match(text, /不要写成「主角走在路上 \/ 放学路过 \/ 坐着等待」/u);
});

test("换一支参考片，投影随之改变且不含旧片内容", () => {
  const other = {
    scenes: [{
      sceneId: "S1", timeRange: "00:00-00:06",
      characters: ["阿海", "船老大"],
      visibleActions: ["阿海蹲在船头解开缠住的渔网"],
      location: "码头"
    }]
  };
  const text = prompt({ sourceScriptReconstruction: other });
  assert.match(text, /画面里就有 2 个角色：阿海、船老大/u);
  assert.match(text, /阿海蹲在船头解开缠住的渔网/u);
  assert.doesNotMatch(text, /咕嘎/u);
});

test("没有重构数据时整段省略，不猜一个开场出来", () => {
  assert.doesNotMatch(prompt(), /原片第一场是怎么开的/u);
  assert.doesNotMatch(prompt({ sourceScriptReconstruction: { scenes: [] } }), /原片第一场是怎么开的/u);
  assert.doesNotMatch(
    prompt({ sourceScriptReconstruction: { scenes: [{ sceneId: "S1" }] } }),
    /原片第一场是怎么开的/u
  );
});
