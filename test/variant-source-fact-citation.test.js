import test from "node:test";
import assert from "node:assert/strict";

import {
  VARIANT_SOURCE_ABSENT_SENTINEL,
  ensureThemeVariantsMatchProfile
} from "../src/validation.js";
import { mockAnalysis, mockBrief, mockReconstruction, mockVariants } from "../src/mock.js";

// 回放 2026-09-06 那一轮的真实上游。
//
// 当天四个候选**全部**把原片写成「企鹅快递员 / 快递送达」，而这两份上游文件里
// 「快递」出现 0 次——「穿着企鹅连体衣、背着绿色小包的小角色」是真的，快递员是补出来的职业。
// 同一份 creativeBrief 还明写着「原片中咕嘎只是偶遇并递出棒棒糖，没有明确的送达任务或目的地」。
// V1 更照着这个虚构把整条结构建成「主动承担送达任务」。
//
// 这里只保留判定需要的那几段原文，不整份拷进来：校验器读的是全部字符串值，
// 多余的上下文不改变判定，只会让这个文件难读。
const UPSTREAM = Object.freeze({
  referenceAnalysis: {
    observedFacts: [
      { observation: "一个穿着企鹅连体衣、背着绿色小包的小角色走近长椅" },
      { observation: "女孩低头看着手里的简历，肩膀垮下来" }
    ]
  },
  sourceScriptReconstruction: {
    scenes: [
      {
        sceneId: "S1",
        location: "公交站",
        visibleActions: ["女孩坐在公交站的长椅上，手里捏着一份简历"],
        dialogueGist: "没有台词，只有叹气"
      },
      {
        sceneId: "S2",
        location: "公交站",
        visibleActions: ["咕嘎从绿色挎包中拿出一颗红白相间的棒棒糖，递给女孩"],
        dialogueGist: "咕嘎只发出咕嘎的声音"
      }
    ]
  }
});

const pair = (source) => ({ source, replacement: "本片改法，本字段不参与溯源判定" });

function variantsWithProof(proof) {
  return {
    variants: [{
      id: "V1",
      title: "回放用候选",
      transformationProof: {
        changedCharacters: pair("企鹅连体衣"),
        changedTask: pair(VARIANT_SOURCE_ABSENT_SENTINEL),
        changedDetailsAndProps: pair("绿色挎包"),
        changedDialogue: pair(VARIANT_SOURCE_ABSENT_SENTINEL),
        changedVisualExpression: pair(VARIANT_SOURCE_ABSENT_SENTINEL),
        ...proof
      }
    }]
  };
}

const check = (proof) => ensureThemeVariantsMatchProfile(
  variantsWithProof(proof), {}, null, null, UPSTREAM
);

test("回放：当天写的「快递送达」被拦下，并报出覆盖率", () => {
  assert.throws(
    () => check({ changedTask: pair("快递送达") }),
    (error) => {
      assert.match(error.message, /声称原片有「快递送达」/u);
      assert.match(error.message, /覆盖率 0\.2/u);
      assert.equal(error.details[0].code, "STORY_CANDIDATE_SOURCE_FACT_UNVERIFIED");
      assert.equal(error.details[0].path, "/variants/0/transformationProof/changedTask/source");
      return true;
    }
  );
});

test("回放：当天写的「企鹅快递员」被拦下——企鹅装是真的，快递员是补的", () => {
  assert.throws(
    () => check({ changedCharacters: pair("企鹅快递员") }),
    /声称原片有「企鹅快递员」/u
  );
});

// 合法反例：这几条上游确实写着，必须放行。
// 一条闸门如果把真事实也拦下，代价是模型只能去编一个更含糊的说法，反而更糟。
test("合法反例：上游逐字写着的原片事实照常通过", () => {
  assert.doesNotThrow(() => check({ changedDetailsAndProps: pair("企鹅连体衣") }));
  assert.doesNotThrow(() => check({ changedDetailsAndProps: pair("绿色挎包") }));
});

test("合法反例：忠实转述通过——判据是字符覆盖率，不要求逐字", () => {
  // 上游原文是「咕嘎从绿色挎包中拿出一颗红白相间的棒棒糖，递给女孩」。
  assert.doesNotThrow(() => check({ changedTask: pair("咕嘎递出棒棒糖") }));
  assert.doesNotThrow(() => check({ changedVisualExpression: pair("女孩坐在公交站的长椅上") }));
});

test("原片确实没有对应物时，sentinel 是正确写法", () => {
  assert.doesNotThrow(() => check({ changedTask: pair(VARIANT_SOURCE_ABSENT_SENTINEL) }));
});

// 缺席声明按**前缀**判定。
//
// 第一版要求精确等于「原片没有」四个字，2026-09-06 21:10 那一轮实测 **20/20 全部失败**：
// 四个候选五个字段无一例外把它当成句子开头补完（「原片没有明确任务」
// 「原片没有人类角色对白」）。`原片没有` 天然读作一句话的开头，要求它戛然而止
// 是让措辞去对抗书写本能。
//
// 放宽的代价是「原片没有把糖递给女孩」这类带内容的否定句免检，但**否定句不制造改写基线**：
// 它没有声称原片有过任何可供承接的东西，最坏只是这一格信息量为零。
// 正向声称仍然逐条回上游核对，闸门的实际拦截能力没有变化。
test("缺席声明按前缀判定，后面可以照常说明", () => {
  assert.doesNotThrow(() => check({ changedTask: pair("原片没有明确的送达任务") }));
  assert.doesNotThrow(() => check({ changedDialogue: pair("原片没有人类角色对白") }));
  assert.doesNotThrow(() => check({ changedCharacters: pair("原片没有固定人类主角与猫形陪伴者的设定") }));
});

// 回放 2026-09-06 21:10 那一轮的真实输出形状：整批 20 个 source 全是缺席声明。
// 它必须整批通过——这一轮之所以炸掉，是第一版的精确匹配把它全数拦下，
// 而这些写法一条也没有编造原片事实。
test("回放：整批缺席声明不再阻断流水线", () => {
  const fields = ["changedCharacters", "changedTask", "changedDetailsAndProps", "changedDialogue", "changedVisualExpression"];
  const realSources = [
    "原片没有固定人类主角与猫形陪伴者的设定",
    "原片没有明确任务",
    "原片没有美术教室与画具相关道具",
    "原片没有人类角色对白",
    "原片没有黑板涂鸦与并排坐地的画面"
  ];
  const proof = Object.fromEntries(fields.map((field, index) => [field, pair(realSources[index])]));
  assert.doesNotThrow(() => check(proof));
});

// 但缺席出口不是免检后门：只要不以「原片没有」开头，正向声称照旧核对。
test("缺席出口不影响正向声称的核对", () => {
  assert.throws(() => check({ changedTask: pair("原片的快递送达任务") }), /找不到对应事实/u);
});

test("不提供上游时逐字保持既有行为，不误伤旧调用点", () => {
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(
    variantsWithProof({ changedTask: pair("快递送达") }), {}, null, null, null
  ));
});

// 核对基准刻意不含 creativeBrief：当天正是简报自己先写错
// （它的 mappingLogic 抄了提示词举例里的「快递员身份」），
// 拿它当核对基准等于给虚构盖章。
test("简报里出现过的虚构不构成依据——核对基准只有分析与还原两份", () => {
  const brief = { roleAndOccupationMapping: [{ mappingLogic: "不继承原片企鹅连体衣、快递员身份和视觉外壳" }] };
  assert.throws(
    () => ensureThemeVariantsMatchProfile(
      variantsWithProof({ changedCharacters: pair("企鹅快递员") }), {}, brief, null, UPSTREAM
    ),
    /声称原片有「企鹅快递员」/u
  );
});

// mock 必须自己就能通过真实契约校验，否则会出现 mock 通过而 live 失败的偏差。
test("mock 候选的 source 真的能在 mock 上游里找到", () => {
  const input = {
    metadata: { duration: 45 },
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈日常" },
    count: 4
  };
  const referenceAnalysis = mockAnalysis(input);
  const sourceScriptReconstruction = mockReconstruction(input);
  const creativeBrief = mockBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
  const variants = mockVariants({ ...input, referenceAnalysis, sourceScriptReconstruction, creativeBrief });
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(
    variants, input.creatorProfile, creativeBrief, null,
    { referenceAnalysis, sourceScriptReconstruction }
  ));
});

// 并列写法的假阳性回放（2026-09-06 21:28 真实阻断）。
//
// citationCoverage 对**每个上游字符串独立**算 LCS 再取最大值，因此一条 source 里
// 并列两个真事实、而它们分散在不同上游句子里时，任何单句都只能覆盖一半。
// 实测「棒棒糖与绿色挎包」覆盖率 0.50 被拦，而两样东西在还原稿 S2 的 keyProps 里
// 白纸黑字都写着，各自单独引用也都通过。
//
// 更糟的是提示词里给的样例正是这种并列写法——一边教模型这么写，一边用校验器拒绝它。
test("回放：并列的真实原片事实不再被腰斩", () => {
  assert.doesNotThrow(() => check({ changedDetailsAndProps: pair("棒棒糖与绿色挎包") }));
  assert.doesNotThrow(() => check({ changedDetailsAndProps: pair("简历、棒棒糖与绿色挎包") }));
});

// 二次切分**只降假阳性、不降拦截力**：切开后每一片都必须独立够阈值。
test("并列里只要有一片是编造的，整条仍然拦下", () => {
  // 「棒棒糖」是真的，「快递箱」是编的——不能因为切开就放行。
  assert.throws(() => check({ changedDetailsAndProps: pair("棒棒糖与快递箱") }), /找不到对应事实/u);
  // 两片都是编的。
  assert.throws(() => check({ changedTask: pair("快递员与送达任务") }), /找不到对应事实/u);
});

// 连接词大量出现在词内（温和、参与、以及、涉及），无条件切分会产出单字碎片，
// 而越短的片段 LCS 覆盖率越容易虚高。因此切片必须 ≥2 字，否则维持原判定。
test("连接词切出单字碎片时维持原判定，不靠碎片蒙混通过", () => {
  assert.throws(() => check({ changedVisualExpression: pair("温和的快递站灯光") }), /找不到对应事实/u);
});
