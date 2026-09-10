import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { ensureOutputContract } from "../src/validation.js";
import { briefPrompt } from "../src/prompts.js";
import { mockBrief } from "../src/mock.js";

// storyEngine 五个子字段此前在 briefPrompt 里**各出现恰好 1 次**——就是输出模板那个空槽位，
// 没有定义、没有规则、没有举例、零校验器。它是整份简报里唯一一个子字段全无定义的子对象。
//
// 实测后果（2026-09-09，三个真实导出包）：turningMechanism 一份是真机制、一份可用、
// 一份写成剧情概括「主角主动采取防护措施继续参与活动」。那不是模型写错——「转折机制」
// 最自然的读法就是剧情转折点。
function brief(overrides = {}) {
  const base = mockBrief({
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" },
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  return { ...base, storyEngine: { ...base.storyEngine, ...overrides } };
}
const rejects = (value, code) => {
  assert.throws(
    () => ensureOutputContract(value, "creativeBrief"),
    (error) => {
      assert.ok(
        (error.details || []).some((d) => d.code === code),
        `应报 ${code}，实际 ${JSON.stringify((error.details || []).map((d) => d.code))}`
      );
      return true;
    }
  );
};

test("mock 简报通过与 live 完全相同的 storyEngine 校验", () => {
  assert.doesNotThrow(() => ensureOutputContract(brief(), "creativeBrief"));
});

test("四个文本键都必须非空", () => {
  for (const field of ["desire", "obstacle", "escalation", "payoff"]) {
    rejects(brief({ [field]: "" }), "CREATIVE_BRIEF_STORY_ENGINE_FIELD_EMPTY");
    rejects(brief({ [field]: "   " }), "CREATIVE_BRIEF_STORY_ENGINE_FIELD_EMPTY");
  }
});

// 旧形状：turningMechanism 是一句话。生成路径必须拒绝它，否则新定义等于没写。
test("旧的字符串形状在生成路径被拒绝", () => {
  rejects(
    brief({ turningMechanism: "帮助者通过观察行动而非听取解释介入" }),
    "CREATIVE_BRIEF_STORY_ENGINE_TURNING_SHAPE_INVALID"
  );
});

// 多一个键会把定义稀释掉——模型很容易顺手补一个 summary。
test("turningMechanism 必须恰好只有 before 与 after 两个键", () => {
  rejects(
    brief({ turningMechanism: { before: "甲", after: "乙", summary: "丙" } }),
    "CREATIVE_BRIEF_STORY_ENGINE_TURNING_SHAPE_INVALID"
  );
  rejects(
    brief({ turningMechanism: { before: "甲" } }),
    "CREATIVE_BRIEF_STORY_ENGINE_TURNING_SHAPE_INVALID"
  );
});

test("before 与 after 都必须非空", () => {
  rejects(
    brief({ turningMechanism: { before: "", after: "乙" } }),
    "CREATIVE_BRIEF_STORY_ENGINE_TURNING_FIELD_EMPTY"
  );
});

// 闸门只抓退化：两边写同一句话。它**判不出**「这个转变是不是真的发生在关系上」。
test("两端去掉空白与标点后相同即判失败", () => {
  rejects(
    brief({ turningMechanism: { before: "观众以为这是单向的照顾", after: "观众以为，这是单向的照顾。" } }),
    "CREATIVE_BRIEF_STORY_ENGINE_TURNING_NOT_SHIFTED"
  );
});

test("两端真的不同就通过", () => {
  assert.doesNotThrow(() => ensureOutputContract(
    brief({ turningMechanism: { before: "观众以为这是单向的照顾", after: "观众看出两个人一直在互相迁就" } }),
    "creativeBrief"
  ));
});

// 提示词必须点破那个最自然的误读，否则写再多正面定义也会被它盖过去。
test("简报提示词写明 turningMechanism 不是剧情转折点", () => {
  const prompt = briefPrompt({
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈", constraints: "" },
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  assert.match(prompt, /观众对人物关系的理解在片中怎样改变/u);
  assert.match(prompt, /它不是剧情转折点/u);
  assert.match(prompt, /"turningMechanism":\{"before":"", "after":""\}/u);
  // 只扫**本次新增的 storyEngine 定义块**：提示词别处原有的坏例行（写着具体奖励物）不在本次范围内。
  const blockStart = prompt.indexOf("storyEngine 描述的是");
  const blockEnd = prompt.indexOf("强保真字段必须停留在抽象剧作层");
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "未找到 storyEngine 定义块");
  const block = prompt.slice(blockStart, blockEnd);
  for (const noun of ["打枣", "铁锅", "小红花", "蒲公英", "萤火虫", "企鹅"]) {
    assert.doesNotMatch(block, new RegExp(noun, "u"), `storyEngine 定义块不得含具体名词 ${noun}`);
  }
});

// 浏览器要能显示两种形状：新校验只在生成路径跑，旧简报仍会被加载。
test("简报卡对新旧两种 turningMechanism 都有显示分支", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function storyEngineShift\(storyEngine\)/u);
  assert.match(app, /typeof turning === "string"/u);
  assert.match(app, /cell\("理解转变", storyEngineShift\(data\.storyEngine\)\)/u);
});
