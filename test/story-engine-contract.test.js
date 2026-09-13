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

// ---------------------------------------------------------------------------
// recastTest —— 「把主角换成一个性格完全不同的人，哪些部分会塌掉？」（2026-09-11）
//
// storyEngine 那五个键是一个**完整的事件结构模型**：问 desire 必然答「她想要什么」。
// 两轮真实回放（3.7-max 与 3.8-max-0902）写出的 turningMechanism 全部停在事件层与关系层，
// 换模型也没变——字段问什么，模型答什么。
//
// 所以这个字段不问「原片用了什么机制」，而是让模型**真做一遍操作**：换个性格的角色再试一遍。
// 塌掉的那部分就是「只有这个角色才给得了」的东西。

function recast(overrides = {}) {
  const base = mockBrief({
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" },
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  return { ...base, recastTest: { ...base.recastTest, ...overrides } };
}
const recastDetails = (value) => {
  try { ensureOutputContract(value, "creativeBrief"); return []; } catch (error) {
    return (error.details || []).map((item) => item.code);
  }
};

test("mock 简报通过与 live 完全相同的 recastTest 校验", () => {
  assert.doesNotThrow(() => ensureOutputContract(recast(), "creativeBrief"));
});

test("recastTest 必须恰好含 recastAs、collapses、survives 三个键", () => {
  assert.ok(recastDetails({ ...recast(), recastTest: { recastAs: "x", collapses: ["a"] } })
    .includes("CREATIVE_BRIEF_RECAST_TEST_INVALID"));
  assert.ok(recastDetails({ ...recast(), recastTest: { recastAs: "x", collapses: ["a"], survives: ["b"], extra: "y" } })
    .includes("CREATIVE_BRIEF_RECAST_TEST_INVALID"));
});

test("recastAs 不能留空——不写清换成什么样的角色，这个测试就没做", () => {
  assert.ok(recastDetails(recast({ recastAs: "   " })).includes("CREATIVE_BRIEF_RECAST_TEST_FIELD_EMPTY"));
});

// survives 空着是最可能的偷懒方式：只填 collapses 等于没做区分。
test("两侧都不许空", () => {
  assert.ok(recastDetails(recast({ collapses: [] })).includes("CREATIVE_BRIEF_RECAST_TEST_SIDE_EMPTY"));
  assert.ok(recastDetails(recast({ survives: [] })).includes("CREATIVE_BRIEF_RECAST_TEST_SIDE_EMPTY"));
  assert.ok(recastDetails(recast({ survives: ["  "] })).includes("CREATIVE_BRIEF_RECAST_TEST_SIDE_EMPTY"));
});

// 这条是核心闸门：换了角色它要么成立要么不成立，没有第三种。
// 同一条两边都写，说明模型根本没做这个区分。
test("同一条不能既塌又不塌，判定忽略空白与标点", () => {
  const codes = recastDetails(recast({ collapses: ["替长辈跑一趟"], survives: ["替长辈跑一趟。"] }));
  assert.ok(codes.includes("CREATIVE_BRIEF_RECAST_TEST_OVERLAP"));
});

test("同一侧内部重复也拒绝", () => {
  assert.ok(recastDetails(recast({ collapses: ["把锅扣头上", "把锅扣头上"] }))
    .includes("CREATIVE_BRIEF_RECAST_TEST_DUPLICATE"));
});

test("两侧真的分开就通过", () => {
  assert.doesNotThrow(() => ensureOutputContract(
    recast({ recastAs: "一个怕出洋相的孩子", collapses: ["把锅扣头上继续干活"], survives: ["替长辈跑一趟"] }),
    "creativeBrief"
  ));
});

// 与 storyEngine 同型：ensureOutputContract(_, "creativeBrief") 只在 createBrief 里调用，
// 下游 variants / visualGuardrails / fullStory 都是裸 requireObject。
test("旧简报没有这个键，只在生成路径被拒绝", () => {
  const legacy = recast();
  delete legacy.recastTest;
  assert.throws(() => ensureOutputContract(legacy, "creativeBrief"), /recastTest/u);
});

test("简报提示词把它写成一个操作，并且只给反例不给正例", () => {
  const prompt = briefPrompt({
    referenceAnalysis: {}, sourceScriptReconstruction: {},
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" }
  });
  assert.match(prompt, /你必须真做一遍的操作/u);
  assert.match(prompt, /为什么是这个角色做这件事才好看/u);
  assert.match(prompt, /这一侧不许空着/u);
  assert.match(prompt, /同一件事不能两边都写/u);
  // 三条反例：品质词、谁都能做、含糊其辞。
  assert.match(prompt, /那是品质不是动作/u);
  assert.match(prompt, /换谁都会干/u);
  assert.match(prompt, /没说是什么办法，等于没写/u);
  assert.ok(!prompt.includes("`"), "提示词正文不得含反引号——模板字面量会被当场截断");
});

// 送 collapses 是要它迁移同一性质的东西；survives 留在简报侧，它的作用是逼简报做区分，
// 送到候选阶段只会变成又一份可以照抄的事件清单。
test("候选阶段只拿到 collapses，拿不到 survives", async () => {
  const { variantsPrompt } = await import("../src/prompts.js");
  const base = mockBrief({ creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" }, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const prompt = variantsPrompt({
    creativeBrief: base,
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈" },
    count: 4
  });
  assert.ok(prompt.includes(base.recastTest.collapses[0]), "collapses 必须进候选提示词");
  assert.ok(!prompt.includes(base.recastTest.survives[0]), "survives 不得进候选提示词");
  assert.match(prompt, /不是要你复现这些动作/u);
});

test("简报卡把两侧并排显示，旧简报缺该键时整块不显示", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function recastTestBlock\(recastTest\)/u);
  assert.match(app, /if \(!collapses\.length && !survives\.length\) return "";/u);
  assert.match(app, /recastTestBlock\(data\.recastTest\)/u);
  assert.match(app, /只有这个角色才给得了/u);
});
