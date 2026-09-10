import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveStoryCandidateProjections,
  ensureOutputContract,
  ensureStoryCandidateContract,
  ensureThemeVariantsMatchProfile,
  requiredClicheClauseCount,
  validateVariantClicheClauses
} from "../src/validation.js";
import { buildStoryCandidateReviewProjection } from "../src/prompts.js";
import { mockVariants } from "../src/mock.js";

// clicheToAvoid 写「这一拍最容易被写成的那个错误版本」，与 failureSignal 同族。
//
// 依据：十篇外部高分改写稿 61 拍里 26 拍（43%）带这种否定条款，而现有候选的 dramaticFunction
// 全是「建立场景，引入情境」这类通用剧作词汇，没有一条说这一拍不许写成什么——实测后果是
// 某候选最后一拍的红薯从口袋里凭空出现，没有任何东西禁止「再加一个温情道具」。
const PROFILE = { fixedCharacter: "小白子", vertical: "治愈" };
const UPSTREAM = { referenceAnalysis: {}, sourceScriptReconstruction: {} };

function batch(mutate = () => {}) {
  const derived = deriveStoryCandidateProjections(
    mockVariants({ creatorProfile: PROFILE, creativeBrief: {}, visualGuardrails: {}, count: 4 })
  );
  const copy = structuredClone(derived);
  mutate(copy.variants);
  return copy;
}
// createVariants 的 finalize 就是这个顺序：先 schema，再这条生成路径独有的闸门，最后共享校验。
const run = (value, upstream = UPSTREAM) => {
  const candidates = ensureOutputContract(value, "themeVariants");
  validateVariantClicheClauses(candidates.variants);
  return ensureThemeVariantsMatchProfile(candidates, PROFILE, {}, {}, upstream);
};
const rejects = (value, code) => assert.throws(
  () => run(value),
  (error) => {
    assert.ok(
      (error.details || []).some((d) => d.code === code),
      `应报 ${code}，实际 ${JSON.stringify((error.details || []).map((d) => d.code))}`
    );
    return true;
  }
);

test("mock 通过与 live 完全相同的校验链，并且两个分支都走到", () => {
  const value = batch();
  assert.doesNotThrow(() => run(value));
  const outline = value.variants[0].storyOutline;
  assert.ok(outline.some((beat) => beat.clicheToAvoid), "至少一拍要带该字段");
  assert.ok(outline.some((beat) => !beat.clicheToAvoid), "至少一拍要不带——不是每拍都写");
});

test("通篇不写即失败：等于没有任何东西挡住最顺手的陈词滥调", () => {
  rejects(batch((variants) => {
    for (const beat of variants[0].storyOutline) delete beat.clicheToAvoid;
  }), "STORY_CANDIDATE_CLICHE_COVERAGE");
});

test("跨拍复述同一句即失败——那是它退化的主要方式", () => {
  rejects(batch((variants) => {
    const outline = variants[0].storyOutline;
    const first = outline.find((beat) => beat.clicheToAvoid).clicheToAvoid;
    for (const beat of outline) beat.clicheToAvoid = first;
  }), "STORY_CANDIDATE_CLICHE_DUPLICATED");
});

test("把同拍 dramaticFunction 换个标点否定一遍即失败", () => {
  rejects(batch((variants) => {
    const beat = variants[0].storyOutline.find((row) => row.clicheToAvoid);
    beat.clicheToAvoid = `${beat.dramaticFunction}。`;
  }), "STORY_CANDIDATE_CLICHE_ECHOES_FUNCTION");
});

// 整个方案能成立的前提：这条闸门**只在 createVariants 的生成路径**跑，不在共享校验器里。
// ensureStoryCandidateContract 跑 strict schema，而它与 ensureThemeVariantsMatchProfile 都被
// validateBoundCandidate（server.js:301）调用——那是用户选中候选、生成 Full Story 时跑的。
// 把闸门放进共享校验器会让**所有已签发的旧候选在展开剧情时当场失败**。
//
// 第一版挂在 ensureThemeVariantsMatchProfile 的 if (upstream) 分支上，实测直接打挂 10 条既有测试：
// upstream 在那些用例里表示「要做溯源核对」，不表示「这是一次新生成」。
test("共享校验器不含这条闸门，旧候选走 validateBoundCandidate 照常通过", () => {
  const legacy = batch((variants) => {
    for (const variant of variants) {
      for (const beat of variant.storyOutline) delete beat.clicheToAvoid;
    }
  });
  // validateBoundCandidate 的两步：strict schema + 共享 profile 校验。两步都不得因为缺该字段失败。
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(ensureOutputContract(legacy, "themeVariants"), PROFILE, {}, {}),
    "共享校验器必须对缺该字段的旧候选逐字不变"
  );
  // 同一份旧候选也必须仍然通过 strict schema —— 该字段是可选的。
  for (const variant of legacy.variants) {
    assert.doesNotThrow(() => ensureStoryCandidateContract(variant, { path: "selectedCandidate" }));
  }
});

// 阈值 2，来自外部高分稿的 43%（26/61 拍）。中途曾降到 1 去迁就 qwen3.7-max 的指令跟随，
// 换 qwen3.8-max 实测后改回——空串那个失败在 3.8 上完全不出现（20 处该省略的键全部干净省略）。
test("阈值按拍数分档：5 拍及以上要 2 条，更短的要 1 条", () => {
  assert.equal(requiredClicheClauseCount(6), 2);
  assert.equal(requiredClicheClauseCount(5), 2);
  assert.equal(requiredClicheClauseCount(4), 1);
});

// 实测：模型会给不想写的拍输出 "" 而不是省略整个键。schema 因此不再要求非空——
// 空串等于没写，由覆盖率闸门数非空的那些。硬失败在这里买不到任何东西，只会让整批被拒。
test("空字符串按没写计，不硬失败", () => {
  // 本来没写条款的拍显式补上空串——那正是 qwen3.7-max 的实际行为（它不省略键，写 ""）。
  // 已有的两条非空保持不动，覆盖率照常满足。
  const value = batch((variants) => {
    for (const variant of variants) {
      for (const beat of variant.storyOutline) {
        if (!String(beat.clicheToAvoid || "").trim()) beat.clicheToAvoid = "";
      }
    }
  });
  assert.doesNotThrow(() => run(value), "空串不得让整批被拒");
});

test("全部写成空串仍然按覆盖不足拒绝", () => {
  rejects(batch((variants) => {
    for (const beat of variants[0].storyOutline) beat.clicheToAvoid = "   ";
  }), "STORY_CANDIDATE_CLICHE_COVERAGE");
});

// 与 failureSignal 同一条理由：把「陷阱」给评审看、把「答案」藏起来。
test("该字段进评审投影，而 dramaticFunction 仍然被剥掉", () => {
  const projection = buildStoryCandidateReviewProjection({
    id: "V1", title: "T",
    storyOutline: [
      { beat: 1, action: "a", dramaticFunction: "SENTINEL_FUNCTION", clicheToAvoid: "SENTINEL_CLICHE" },
      { beat: 2, action: "b", dramaticFunction: "SENTINEL_FUNCTION_2" }
    ],
    highValueBeatMapping: []
  });
  const serialized = JSON.stringify(projection);
  assert.match(serialized, /SENTINEL_CLICHE/u, "陷阱声明要送给评审");
  assert.doesNotMatch(serialized, /SENTINEL_FUNCTION/u, "dramaticFunction 仍然不得进入投影");
});
