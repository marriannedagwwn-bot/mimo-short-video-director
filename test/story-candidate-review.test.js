import test from "node:test";
import assert from "node:assert/strict";

import { ensureOutputContract, ensureStoryCandidateReviewCoversCandidates } from "../src/validation.js";
import { buildStoryCandidateReviewProjection, storyCandidateReviewPrompt } from "../src/prompts.js";
import { mockStoryCandidateReview } from "../src/mock.js";

const CANDIDATES = [
  {
    id: "V1",
    title: "这张别扔",
    oneLineHook: "画坏的猫被人认真演了出来。",
    logline: "天台上，画不下去的女生遇到愿意当模特的小白子。",
    narrativeMode: "slice_of_life",
    characterSetup: { protagonist: "小白子" },
    newTask: "陪画画女生画完一张画",
    environmentPressure: "天台风大",
    storyOutline: [
      { beat: 1, phase: "日常", action: "女生把画坏的纸揉成一团扔出去", emotion: "沮丧", dramaticFunction: "建立困境", estimatedSeconds: 10 },
      { beat: 2, phase: "介入", action: "小白子捡起纸团展开，照着画摆姿势", emotion: "认真", dramaticFunction: "主角介入", estimatedSeconds: 12 },
      { beat: 3, phase: "回应", action: "女生笑出来，把纸压平继续画", emotion: "松动", dramaticFunction: "可见变化", estimatedSeconds: 10 }
    ],
    keyDialogueDirections: ["女生：别动，就这样"],
    highValueBeatMapping: [
      { briefBeat: "低压力陪伴", newExpression: "照着画摆姿势", retainedValue: "不追问就给出的陪伴", failureSignal: "结尾只靠拥抱或台词宣布温暖" }
    ],
    novelty: "把画里的错误当成值得认真对待的东西",
    visualPotential: "举手摆姿势的轮廓",
    experienceFidelity: { positioning: "生活流", audience: "治愈受众", emotion: "沮丧到松动", plotDriver: "一张画", highValueBeats: "陪伴" },
    transformationProof: {
      changedCharacters: { source: "帮助者", replacement: "改为小白子" },
      changedTask: { source: "原片没有", replacement: "陪画画" },
      changedDetailsAndProps: { source: "任务物", replacement: "画纸" },
      changedDialogue: { source: "原片没有", replacement: "一句别动" },
      changedVisualExpression: { source: "原片没有", replacement: "天台" }
    },
    originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "无", mitigation: "无" }
  },
  {
    id: "V2",
    title: "雨天的透明伞",
    oneLineHook: "一把没人认领的伞。",
    logline: "小白子冒雨把长椅上的伞送去。",
    narrativeMode: "dramatic",
    characterSetup: { protagonist: "小白子" },
    newTask: "送伞",
    environmentPressure: "暴雨",
    storyOutline: [
      { beat: 1, phase: "任务", action: "小白子看见长椅上的伞", emotion: "犹豫", dramaticFunction: "建立任务", estimatedSeconds: 8 },
      { beat: 2, phase: "高潮", action: "小白子冒雨穿过积水路段", emotion: "坚定", dramaticFunction: "高潮", estimatedSeconds: 12 }
    ],
    keyDialogueDirections: ["女生：谢谢你"],
    highValueBeatMapping: [
      { briefBeat: "低压力陪伴", newExpression: "冒雨穿过积水", retainedValue: "付出被看见", failureSignal: "只解决物质困难" }
    ],
    novelty: "双向关怀",
    visualPotential: "雨中奔跑",
    experienceFidelity: { positioning: "剧情型", audience: "治愈受众", emotion: "犹豫到坚定", plotDriver: "送达", highValueBeats: "送达" },
    transformationProof: {
      changedCharacters: { source: "帮助者", replacement: "改为小白子" },
      changedTask: { source: "完成送达或照料", replacement: "送伞" },
      changedDetailsAndProps: { source: "任务物", replacement: "透明伞" },
      changedDialogue: { source: "原片没有", replacement: "一句谢谢" },
      changedVisualExpression: { source: "原片没有", replacement: "雨中" }
    },
    originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "无", mitigation: "无" }
  }
];

const RECONSTRUCTION = { scenes: [{ sceneId: "S1", visibleActions: ["咕嘎递出棒棒糖"] }] };

function baseReview() {
  return mockStoryCandidateReview(CANDIDATES);
}

test("mock 报告能通过与 live 完全相同的契约与覆盖率核验", () => {
  const review = baseReview();
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// 覆盖率的真闸门是「数量相等 + id 逐位相同」。模型完全可以只点评它碰巧注意到的
// 一两个候选，交回一份看起来很专业、实际漏检大半的报告。
test("漏评一个候选直接失败，不做任何补齐", () => {
  const review = baseReview();
  review.candidateChecks.pop();
  review.recommendedOrder.pop();
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVIEW_COVERAGE_INCOMPLETE");
      assert.match(error.message, /本批有 2 个候选，评审只覆盖了 1 个/u);
      return true;
    }
  );
});

test("候选顺序错位被抓住——同长度也不等于逐位对齐", () => {
  const review = baseReview();
  review.candidateChecks.reverse();
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES),
    /CANDIDATE_REVIEW_ID_MISMATCH|应当核对候选「V1」/u
  );
});

test("标题回显必须包含原文，复述与截断都拒绝", () => {
  const review = baseReview();
  review.candidateChecks[0].title = "别扔";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES),
    /title 必须完整包含候选「V1」的标题原文/u
  );
});

// 与剧情体检同规格：回显只用来证明「你读的是这一条」，
// 允许在原文之外追加注解，核验通过后由服务端用原文无条件覆盖。
test("回显后追加注解允许通过，并被服务端用原文覆盖", () => {
  const review = baseReview();
  review.candidateChecks[0].title = "这张别扔（生活流）";
  const checked = ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES);
  assert.equal(checked.candidateChecks[0].title, "这张别扔");
});

test("引用了候选里不存在的拍号必须失败", () => {
  const review = baseReview();
  review.candidateChecks[0].mechanismChecks[0].beatIndexes = [7];
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVIEW_UNKNOWN_BEAT");
      assert.match(error.message, /该候选只有 3 拍/u);
      return true;
    }
  );
});

test("recommendedOrder 必须是全部候选 id 的一个排列", () => {
  const review = baseReview();
  review.recommendedOrder = ["V1", "V1"];
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(review, CANDIDATES),
    /CANDIDATE_REVIEW_ORDER_NOT_PERMUTATION|必须是全部 2 个候选 id 的一个排列/u
  );
});

// 送审投影是这套设计的核心：让故事自己证明自己，而不是让解释替它过关。
// 用**允许清单**构造，所以将来候选加了新字段，默认不进评审视野。
test("送审投影剥掉候选的全部自我评价字段", () => {
  const projection = buildStoryCandidateReviewProjection(CANDIDATES[0]);
  for (const masked of ["novelty", "visualPotential", "experienceFidelity", "transformationProof", "originalityRiskCheck", "highValueBeatMapping"]) {
    assert.equal(projection[masked], undefined, `${masked} 不得进入评审视野`);
  }
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /不追问就给出的陪伴/u, "retainedValue 不得泄露");
  assert.doesNotMatch(serialized, /把画里的错误当成值得认真对待的东西/u, "novelty 不得泄露");
  // dramaticFunction 是作者给这一拍贴的标签，同样不是证据。
  assert.doesNotMatch(serialized, /建立困境/u, "storyOutline 的 dramaticFunction 不得泄露");
});

// 刻意的不对称：把「陷阱」给评审看，把「答案」藏起来。
test("failureSignal 反而要送进评审——它是证伪条件，不是成功声明", () => {
  const projection = buildStoryCandidateReviewProjection(CANDIDATES[0]);
  assert.deepEqual(projection.failureSignals, ["结尾只靠拥抱或台词宣布温暖"]);
});

test("动作链与拍号照常送进评审，否则无从判断", () => {
  const projection = buildStoryCandidateReviewProjection(CANDIDATES[0]);
  assert.equal(projection.storyOutline.length, 3);
  assert.equal(projection.storyOutline[1].action, "小白子捡起纸团展开，照着画摆姿势");
  assert.equal(projection.storyOutline[1].beat, 2);
});

test("提示词写明只看动作、不打总分，并给出生活流不套戏剧结构的判据", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /你收到的候选里\*\*已经没有\*\*它们的自我评价字段/u);
  assert.match(prompt, /\*\*不要打总分。\*\*/u);
  assert.match(prompt, /更换角色、道具、地点，不自动等于创意成立/u);
  assert.match(prompt, /增加失败、身体代价、误会、奖励，不自动等于质量提高/u);
  assert.match(prompt, /生活片段型（narrativeMode: slice_of_life）不强制有任务、牺牲或大反转/u);
  assert.match(prompt, /恰好 2 项/u);
  // 提示词里不得出现被屏蔽字段的内容，否则屏蔽就是假的。
  assert.doesNotMatch(prompt, /不追问就给出的陪伴/u);
  assert.doesNotMatch(prompt, /双向关怀/u);
});

test("提示词带上原片动作稿——没有对照物就发现不了迁移失败", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /咕嘎递出棒棒糖/u);
});

// 因果自洽检查（2026-09-09，来自阶段 0 的首次真实回放）。
//
// 那次回放里评审把一个候选判成 pass 并排在第 2，而它的动作链有三处已核实的矛盾：
// 对白说「顺路」而同一拍写「反方向」；角色怀里已经抱着能解决问题的道具，却另找一个
// 更差的替代物去保护它；任务目的在最后一拍被另一条线当场抵消。评审的 coreInteraction
// 甚至把其中一条原样抄下来当成功案例——它读对了动作，只是从没被要求检查动作之间合不合得上。
//
// 闸门只数数组长度、只比枚举值，不裁决那条自洽问题成不成立。
test("报出因果自洽问题的候选不能再判 pass", () => {
  const review = baseReview();
  const check = review.candidateChecks[1];
  check.coherenceChecks = [
    { kind: "contradiction", beatIndexes: [1, 2], problem: "第 1 拍说没带伞，第 2 拍却已经撑着伞。" }
  ];
  check.verdict = "pass";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "STORY_CANDIDATE_REVIEW_PASS_WITH_COHERENCE_BREAK"));
      assert.match(error.message, /不能判 pass/u);
      return true;
    }
  );
});

test("同样的自洽问题改判 revise 就通过——闸门管的是 verdict，不是要不要报", () => {
  const review = baseReview();
  const check = review.candidateChecks[1];
  check.coherenceChecks = [
    { kind: "purpose_nullified", beatIndexes: [2], problem: "任务目的在同一拍被另一条线抵消。" }
  ];
  check.verdict = "revise";
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

test("空的 coherenceChecks 是合法结论，不妨碍 pass", () => {
  const review = baseReview();
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; check.verdict = "pass"; });
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// 拍号合法性判定只有一份，两个数组共用；路径必须指向真正出错的那个数组。
test("coherenceChecks 引用不存在的拍号，与 mechanismChecks 走同一条判定", () => {
  const review = baseReview();
  const check = review.candidateChecks[1];
  check.coherenceChecks = [{ kind: "space_or_time", beatIndexes: [9], problem: "越界拍号。" }];
  check.verdict = "revise";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_UNKNOWN_BEAT");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_UNKNOWN_BEAT");
      assert.equal(hit.path, "/candidateChecks/1/coherenceChecks/0/beatIndexes/0");
      return true;
    }
  );
});

// mock 必须把非空与空两个分支都走到，否则会重演「mock 通过而 live 失败」。
test("mock 同时产出非空与空的 coherenceChecks，且自己遵守 pass 闸门", () => {
  const review = baseReview();
  const nonEmpty = review.candidateChecks.filter((check) => check.coherenceChecks.length);
  const empty = review.candidateChecks.filter((check) => !check.coherenceChecks.length);
  assert.ok(nonEmpty.length, "至少要有一个候选带非空 coherenceChecks");
  assert.ok(empty.length, "至少要有一个候选带空 coherenceChecks");
  for (const check of nonEmpty) assert.notEqual(check.verdict, "pass");
});

// 提示词是模板字面量，正文里出现反引号会当场把它截断（AGENTS.md 2.14 记过这个坑）。
test("评审提示词正文不含反引号，且给出非空的 coherenceChecks 示例", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.doesNotMatch(prompt, /`/u);
  assert.match(prompt, /coherenceChecks/u);
  // 只给空数组会让模型猜错元素类型——分镜终审正是这样栽过一次。
  assert.match(prompt, /"coherenceChecks":\[\{"kind":/u);
});
