import test from "node:test";
import assert from "node:assert/strict";

import { InputError, OutputContractError, deriveStoryCandidateProjections, ensureOutputContract, ensureStoryCandidateReviewCoversCandidates } from "../src/validation.js";
import { buildStoryCandidateReviewProjection, storyCandidateReviewPrompt, storyCandidateReviewRetryPrompt } from "../src/prompts.js";
import { mockStoryCandidateReview } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";
import {
  CANDIDATE_REVIEW_DIMENSION_LABELS as LABELS,
  CANDIDATE_REVIEW_DIMENSION_WEIGHTS as WEIGHTS,
  CANDIDATE_REVIEW_SPECIAL_DEFECT_TYPES as SPECIAL_DEFECTS,
  SOURCE_SCAFFOLD_COPY_SCORE
} from "../public/story-review-metrics.js";

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
  review.holisticPreferenceOrder.pop();
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

test("holisticPreferenceOrder 必须是全部候选 id 的一个排列", () => {
  const review = baseReview();
  review.holisticPreferenceOrder = ["V1", "V1"];
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

test("提示词写明只看动作、不许自报结论，并给出生活流不套戏剧结构的判据", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /候选投影里\*\*已经没有\*\*新颖性、保留价值、体验保真、相似风险这些字段/u);
  // 2026-09-12 起总分是**服务端按十一维加权派生**的，模型自报会被覆盖，
  // 所以提示词要明确告诉它别写——写了也没用，只是白烧 token。
  assert.match(prompt, /\*\*不要写 verdict、score、tier 或任何总分。\*\*/u);
  assert.match(prompt, /更换角色、道具、地点，不自动等于创意成立/u);
  assert.match(prompt, /增加失败、身体代价、误会、奖励，不自动等于质量提高/u);
  assert.match(prompt, /生活片段型（narrativeMode: slice_of_life）不强制有任务、牺牲或大反转/u);
  assert.match(prompt, /恰好 2 项/u);
  // 提示词里不得出现被屏蔽字段的内容，否则屏蔽就是假的。
  assert.doesNotMatch(prompt, /不追问就给出的陪伴/u);
  assert.doesNotMatch(prompt, /双向关怀/u);
});

// 2026-09-18（docs/story-review-dialogue-response-ab-2026-09-18.md）：creatorProfile 作为硬事实送进评审，
// 「小白子会说谢谢」被读成合规加分——喂完奶奶自己说「谢谢」那一拍，五次模型输出对白都打 9–9.5。
// 第一版只问方向，模型替它编了「回应了奶奶煮豆子的隐性付出」；第二版换成「观众能不能不靠猜说出他在谢什么」。
test("第 11 维先问台词在回应什么，合乎说话限制不是加分理由；contradiction 含台词方向相反的形状", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /\*\*它回应的是观众刚看见的哪个动作、刚听见的哪句话？\*\*/u);
  assert.match(prompt, /观众能不能不靠猜，就说出他在谢什么/u);
  assert.match(prompt, /没演出来的「隐性付出」「平时的照顾」不能拿来替它圆/u);
  assert.match(prompt, /\*\*合乎角色的说话限制只是底线，不是加分理由\*\*/u);
  assert.match(prompt, /\*\*台词与同一拍的动作方向相反也算\*\*：刚付出的一方紧接着向受惠的一方道谢/u);
  // 原来那一问只查「像不像这个角色会说的话」，正是它把合规读成了加分，不许回来。
  assert.doesNotMatch(prompt, /对白像不像这个角色会说的话/u);

  // §2.12b ⑤：举例一律是抽象形状，不含任何参考片或候选的具体名词——举例会被逐字照抄。
  const dimension = prompt.slice(prompt.indexOf("11. **dialogueAndNaturalness"), prompt.indexOf("### 四、physicalAssumptions"));
  const contradiction = prompt.slice(prompt.indexOf("  - contradiction："), prompt.indexOf("  - tool_misuse："));
  assert.ok(dimension.length > 50 && contradiction.length > 50, "没切到这两段，下面的断言会恒真");
  for (const text of [dimension, contradiction]) {
    for (const noun of ["谢谢", "毛豆", "奶奶", "小白子", "蒲扇"]) {
      assert.doesNotMatch(text, new RegExp(noun, "u"), `新增的判据里不许出现具体名词「${noun}」`);
    }
  }
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
// 2026-09-12：因果断裂与换皮**不再是 verdict 闸门，而是派生时的降级理由**。
// 模型根本不写 verdict 了，所以「报了断裂却判 pass」这类失败由构造消除。
// 关键纪律：降级只改 effectiveVerdict，**绝不回头改 overallScore 或 tier**——
// 用压低质量分实现降级，会把「这故事很好但有一处硬问题」压成「这故事不好」。
function scoreAll(review, score) {
  review.candidateChecks.forEach((check) => {
    check.dimensions.forEach((dim) => { dim.score = score; });
  });
  return review;
}

test("报出因果自洽问题的候选不许放行，但质量分与等级一个字不改", () => {
  const review = scoreAll(baseReview(), 9.5);
  review.candidateChecks[1].coherenceChecks = [
    { kind: "contradiction", beatIndexes: [1, 2], problem: "第 1 拍说没带伞，第 2 拍却已经撑着伞。" }
  ];
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  const broken = out.candidateChecks[1];
  assert.equal(broken.overallScore, 9.5, "质量分不因闸门改变");
  assert.equal(broken.tier, "ready", "等级不因闸门改变");
  assert.equal(broken.scoreBasedVerdict, "pass", "按分数本可直接展开");
  assert.equal(broken.effectiveVerdict, "revise", "但现在不许放行");
  assert.deepEqual(broken.verdictOverrideReasons, ["coherence_break"]);
  // 没有断裂的那个照常放行，证明降级只作用于命中的候选。
  assert.equal(out.candidateChecks[0].effectiveVerdict, "revise");
});

test("没有任何断裂时，高分候选直接放行", () => {
  const review = scoreAll(baseReview(), 9.2);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  for (const check of out.candidateChecks) {
    assert.equal(check.tier, "ready");
    assert.equal(check.effectiveVerdict, "pass");
    assert.deepEqual(check.verdictOverrideReasons, []);
  }
});

test("BLOCKER 级缺陷是第三条硬闸门——给模型一个不必压分的一票否决", () => {
  const review = scoreAll(baseReview(), 9.8);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  review.candidateChecks[0].dominantDefect = {
    type: "causalLogic",
    severity: "BLOCKER",
    description: "高潮完全靠巧合。"
  };
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.equal(out.candidateChecks[0].overallScore, 9.8);
  assert.equal(out.candidateChecks[0].effectiveVerdict, "revise");
  assert.deepEqual(out.candidateChecks[0].verdictOverrideReasons, ["blocker_defect"]);
  assert.equal(out.candidateChecks[1].effectiveVerdict, "pass");
});

test("低分候选本来就是 drop，硬闸门不会把它抬回来", () => {
  const review = scoreAll(baseReview(), 4);
  review.candidateChecks[0].coherenceChecks = [
    { kind: "other", beatIndexes: [1], problem: "占位。" }
  ];
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.equal(out.candidateChecks[0].tier, "reject_or_regenerate");
  assert.equal(out.candidateChecks[0].effectiveVerdict, "drop");
});

// ---------------------------------------------------------------------------
// 双证据（2026-09-12）。实测三条被判「已兑现」的证据全是这个形状：
// 「第 5 拍把书签别在她胸前」「第 5 拍摘下徽章别在搭档呆毛上」
// 「第 5 拍把书签夹进那本旧书里」——只有转移动作，一条都没指出前因：
// 那东西是不是先真正属于她、她在不在意、舍不舍得。按双证据重评，这三条
// 全部降级为 partially_depicted，整组兑现率从 70.8% 掉到 54.2%。
//
// **闸门刻意不一刀切**：判据是清单自报的 requiresCause，不是「所有机制都要两条证据」。

test("标了需要前因的机制，只有转移动作就不能判 depicted", () => {
  const review = baseReview();
  // mock 的第一条 mechanismCheck 引用 M1（requiresCause: true）。
  review.candidateChecks[0].mechanismChecks[0].causeEvidence = "";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_EVIDENCE_INCOMPLETE");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_EVIDENCE_INCOMPLETE");
      assert.equal(hit.path, "/candidateChecks/0/mechanismChecks/0/causeEvidence");
      assert.match(error.message, /最多只能判 partially_depicted/u);
      return true;
    }
  );
});

test("同一条改判 partially_depicted 就通过——闸门管的是 depicted 的门槛", () => {
  const review = baseReview();
  review.candidateChecks[0].mechanismChecks[0].causeEvidence = "";
  review.candidateChecks[0].mechanismChecks[0].verdict = "partially_depicted";
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// 这条是「不一刀切」的正面用例：会不会跑、有没有陪着这类机制根本不需要前因，
// 对它们也要两条证据就是在逼模型编一段。
test("没标需要前因的机制，前因留空照样可以判 depicted", () => {
  const review = baseReview();
  const check = review.candidateChecks[0].mechanismChecks[1];
  assert.equal(check.sourceMechanismId, "M2");
  assert.equal(review.sourceMechanisms[1].requiresCause, false);
  check.causeEvidence = "";
  check.verdict = "depicted";
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// requiresCause 声明在**共享清单**上而不是逐候选的 check 里：放在 check 里，
// 模型想让哪个候选过就对那个候选写 false；放在清单上，改它等于对全批同时放水。
test("需不需要前因是机制自己的属性，全批候选共用一份", () => {
  const review = baseReview();
  review.sourceMechanisms[0].requiresCause = false;
  review.candidateChecks.forEach((check) => { check.mechanismChecks[0].causeEvidence = ""; });
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ), "标记挂在清单上，改一次对全批生效");
  assert.equal(
    review.candidateChecks[0].mechanismChecks[0].requiresCause,
    undefined,
    "requiresCause 不得出现在逐候选的 check 里"
  );
});

test("schema 要求清单每条都表态需不需要前因", () => {
  const review = baseReview();
  delete review.sourceMechanisms[0].requiresCause;
  assert.throws(() => ensureOutputContract(review, "storyCandidateReview"), /requiresCause/u);
});

test("actionEvidence 是必填非空——没有动作证据的兑现等于没核对", () => {
  const review = baseReview();
  review.candidateChecks[0].mechanismChecks[0].actionEvidence = "";
  assert.throws(() => ensureOutputContract(review, "storyCandidateReview"), /actionEvidence/u);
});

// ---------------------------------------------------------------------------
// 骨架对照与换皮闸门（2026-09-12）。
//
// 评审此前只比候选**之间**的差异，从来没比过候选与原片——四个候选彼此完全不同，
// 仍然可能各自都在复刻原片。实测：一组 12 个候选里 9 个的任务性质与原片同类，
// 而候选之间的重复检查一条都没报出来。

test("骨架重合分到线就不许放行，哪怕它是满分候选", () => {
  const review = scoreAll(baseReview(), 9.6);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  const check = review.candidateChecks[1];
  check.sourceScaffoldOverlap.score = SOURCE_SCAFFOLD_COPY_SCORE;
  // 机制全部判未迁移：旧方案的「兑现率 ≥ 2/3」前置条件会让这个候选从闸门底下走掉，
  // 而它恰恰是照搬了原片事件链、只是前因没写好的那一类。
  check.mechanismChecks.forEach((entry) => { entry.verdict = "not_depicted"; });
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.equal(out.candidateChecks[1].tier, "ready");
  assert.equal(out.candidateChecks[1].effectiveVerdict, "revise");
  assert.deepEqual(out.candidateChecks[1].verdictOverrideReasons, ["scaffold_copy"]);
});

test("差一分就不降级——判定是一次整数比较，不做区间推断", () => {
  const review = scoreAll(baseReview(), 9.6);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  review.candidateChecks[1].sourceScaffoldOverlap.score = SOURCE_SCAFFOLD_COPY_SCORE - 1;
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.deepEqual(out.candidateChecks[1].verdictOverrideReasons, []);
  assert.equal(out.candidateChecks[1].effectiveVerdict, "pass");
});

test("三条硬闸门同时命中时全部如实列出，不只报第一条", () => {
  const review = scoreAll(baseReview(), 9.9);
  const check = review.candidateChecks[1];
  check.coherenceChecks = [{ kind: "other", beatIndexes: [1], problem: "占位。" }];
  check.sourceScaffoldOverlap.score = 95;
  check.dominantDefect = { type: "originality", severity: "BLOCKER", description: "换皮。" };
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.deepEqual(
    out.candidateChecks[1].verdictOverrideReasons,
    ["coherence_break", "scaffold_copy", "blocker_defect"]
  );
});

// 换皮线只有一份：校验器与浏览器摘要从同一个常量取值。
// 两边各写一个 70，迟早漂成「页面说没越线、服务端说越线了」。
test("换皮线在校验器与浏览器摘要之间只有一份", async () => {
  const metrics = await import("../public/story-review-metrics.js");
  assert.equal(metrics.SOURCE_SCAFFOLD_COPY_SCORE, SOURCE_SCAFFOLD_COPY_SCORE);
  const validationSource = fs.readFileSync(new URL("../src/validation.js", import.meta.url), "utf8");
  assert.match(validationSource, /SOURCE_SCAFFOLD_COPY_SCORE[\s\S]{0,200}from "\.\.\/public\/story-review-metrics\.js"/u);
  assert.ok(
    !/scaffoldScore >= 70|score >= 70/u.test(validationSource),
    "闸门里不许再写一个字面量 70"
  );
});

test("生活片段型可以整档写 not_applicable，不必硬填任务与奖励", () => {
  const review = baseReview();
  Object.assign(review.candidateChecks[0].sourceScaffoldOverlap, {
    taskType: "not_applicable",
    midSection: "not_applicable",
    rewardSource: "not_applicable",
    rewardHandling: "not_applicable",
    endingShape: "not_applicable"
  });
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

test("五个辅助观察都认 not_applicable，schema 里一个都不能漏", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  const scaffold = schema.$defs.sourceScaffoldOverlap;
  const dims = ["taskType", "midSection", "rewardSource", "rewardHandling", "endingShape"];
  for (const dim of dims) {
    assert.equal(scaffold.properties[dim].$ref, "#/$defs/scaffoldDimension", `${dim} 必须用同一个枚举`);
  }
  assert.deepEqual(
    schema.$defs.scaffoldDimension.enum,
    ["same", "partial", "different", "not_applicable"]
  );
  // 事件链才是判据，所以它必填：不许只交五个辅助观察加一个分数。
  assert.ok(scaffold.required.includes("eventChain"));
  assert.equal(scaffold.properties.eventChain.maxItems, 6);
});

// 下界是 1，不是 2。**这条有真实回放的代价做依据。**
//
// 2026-09-12 用一份只有一个动作的原片打了两次真实调用：两次的第一次尝试都写了**一条**
// 事件链、被 minItems: 2 拒掉；重试时模型**编了一件原片没有的事**（「原片动作结束」），
// 并为了自洽把两条链接全改成 same、分数从 20 抬到 85。
//
// 这与 §2.12b 的 `原片没有` sentinel 是同一条道理：**schema 要求填满而没有出口，
// 就是在逼模型编造**，而编出来的原片事实会一路污染判定。原片有几件关键事件
// 不可从我们这边唯一推导，本来就不该由 schema 裁决；「写 3–5 条」留在提示词里。
test("事件链下界是 1——原片只有一件事时不许逼模型编第二件", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  assert.equal(schema.$defs.sourceScaffoldOverlap.properties.eventChain.minItems, 1);

  const review = baseReview();
  review.candidateChecks.forEach((check) => {
    check.sourceScaffoldOverlap.eventChain = [check.sourceScaffoldOverlap.eventChain[0]];
  });
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));

  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /绝不许为了凑数编一件原片没有的事/u);
});

test("事件链的拍号与另外两个数组走同一条判定", () => {
  const review = baseReview();
  review.candidateChecks[0].sourceScaffoldOverlap.eventChain[0].beatIndexes = [9];
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_UNKNOWN_BEAT");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_UNKNOWN_BEAT");
      assert.equal(hit.path, "/candidateChecks/0/sourceScaffoldOverlap/eventChain/0/beatIndexes/0");
      return true;
    }
  );
});

test("没有对应事件的那一环写空拍号，是合法形状", () => {
  const review = baseReview();
  const absent = review.candidateChecks[0].sourceScaffoldOverlap.eventChain
    .find((link) => link.linkage === "absent");
  assert.ok(absent, "mock 必须走到 absent 这个分支");
  assert.deepEqual(absent.beatIndexes, []);
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// mock 必须把有风险的形状都铺到，但**不得替模型下判断**：
// 给一个高分会让页面显示「疑似换皮」，那是伪造结论。
test("mock 的骨架对照铺了形状但不打高分", () => {
  const review = baseReview();
  for (const check of review.candidateChecks) {
    assert.equal(check.sourceScaffoldOverlap.score, 0);
    const linkages = check.sourceScaffoldOverlap.eventChain.map((link) => link.linkage);
    assert.ok(linkages.includes("absent"), "absent 分支要走到");
    const dims = ["taskType", "midSection", "rewardSource", "rewardHandling", "endingShape"]
      .map((key) => check.sourceScaffoldOverlap[key]);
    assert.ok(dims.includes("not_applicable"), "not_applicable 分支要走到");
  }
});

test("mock 的双证据两个分支都走到，且自己遵守闸门", () => {
  const review = baseReview();
  const requires = new Map(review.sourceMechanisms.map((entry) => [entry.id, entry.requiresCause]));
  assert.deepEqual([...new Set(requires.values())].sort(), [false, true], "两种 requiresCause 都要有");
  for (const check of review.candidateChecks) {
    const withCause = check.mechanismChecks.filter((entry) => entry.causeEvidence);
    const withoutCause = check.mechanismChecks.filter((entry) => !entry.causeEvidence);
    assert.ok(withCause.length, "要有带前因的一条");
    assert.ok(withoutCause.length, "也要有不带前因的一条");
    for (const entry of check.mechanismChecks) {
      if (requires.get(entry.sourceMechanismId) && entry.verdict === "depicted") {
        assert.ok(entry.causeEvidence, "mock 自己也要守双证据闸门");
      }
    }
  }
});

// 提示词侧的三条修正，都没有确定性兜底，只能用源码断言守住措辞不被顺手删掉。
test("提示词要求按前因判接收方，不许按角色身份名称直接判错", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /只看故事前面有没有写出相应的付出或贡献/u);
  assert.match(prompt, /搭档、同伴、宠物、同龄人\*\*一样可以是默默付出的那一方\*\*/u);
  assert.match(prompt, /不许因为角色的身份名称直接判不符合/u);
});

test("提示词写明骨架对照逐个与原片比，且辅助观察可以不适用", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /逐个候选单独跟原片比，不要拿候选之间互相比/u);
  assert.match(prompt, /not_applicable/u);
  assert.match(prompt, /这些本身都不足以判换皮/u);
  assert.match(prompt, /换掉全部人名、道具、地点而保留同一条因果链，分数应该很高/u);
  // 举例一律抽象形状：不得出现任何参考片的具体名词（企鹅快递员那次事故）。
  assert.doesNotMatch(prompt, /企鹅|快递员|小红花|旧衣服/u);
});

test("提示词把换皮线写成与闸门同一个数，不另写一套口径", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, new RegExp(`分数打到 ${SOURCE_SCAFFOLD_COPY_SCORE} 或以上，服务端会据此拦下晋级`, "u"));
  // 两个方向的提醒都要在：压分放行与因为题材相似往高打，都是把这个分数当工具用。
  assert.match(prompt, /既不要为了让某个候选过关而压分，也不要因为题材相似就往高打/u);
});

// 拍号合法性判定只有一份，三个数组共用；路径必须指向真正出错的那个数组。
test("coherenceChecks 引用不存在的拍号，与 mechanismChecks 走同一条判定", () => {
  const review = baseReview();
  const check = review.candidateChecks[1];
  check.coherenceChecks = [{ kind: "space_or_time", beatIndexes: [9], problem: "越界拍号。" }];
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

// 原片机制清单改为**全批共享一份、候选按 id 引用**（2026-09-09）。
//
// 依据是跨四个包的真实回放：只有一个包的评审把原片机制收敛成 3 条，另外三个各提炼 8-9 条，
// 每条都是照着那个候选本身写的，于是 6/8 判 depicted——从候选反推原片机制再判它已兑现，
// 是循环论证。而机制真正收敛的那个包，四个候选全部被判未迁移，与一份外部评审结论一致。
//
// 招式与 variant-source-baseline 的证据目录同规格；判定是纯集合成员比较，零语义。
test("候选只能引用清单里已有的机制 id", () => {
  const review = baseReview();
  review.candidateChecks[0].mechanismChecks[0].sourceMechanismId = "M9";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_UNKNOWN_MECHANISM");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_UNKNOWN_MECHANISM");
      assert.equal(hit.path, "/candidateChecks/0/mechanismChecks/0/sourceMechanismId");
      return true;
    }
  );
});

test("机制 id 重复会被拒——重复的 id 让引用不再唯一", () => {
  const review = baseReview();
  review.sourceMechanisms[1].id = review.sourceMechanisms[0].id;
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_DUPLICATE_MECHANISM"));
      return true;
    }
  );
});

// 构造上的保证：清单最多 4 条，所以 4 个候选写不出 8 条互不相同的「原片机制」。
test("schema 把机制清单限制在 2-4 条", () => {
  const review = baseReview();
  review.sourceMechanisms = [review.sourceMechanisms[0]];
  assert.throws(() => ensureOutputContract(review, "storyCandidateReview"), /storyCandidateReview/u);

  const tooMany = baseReview();
  tooMany.sourceMechanisms = Array.from({ length: 5 }, (_, i) => ({
    id: `M${i + 1}`, mechanism: "机制", whereInSource: "位置"
  }));
  assert.throws(() => ensureOutputContract(tooMany, "storyCandidateReview"), /storyCandidateReview/u);
});

test("mock 的机制清单与它自己的引用是自洽的", () => {
  const review = baseReview();
  const ids = new Set(review.sourceMechanisms.map((entry) => entry.id));
  assert.ok(ids.size >= 2);
  for (const check of review.candidateChecks) {
    for (const mechanism of check.mechanismChecks) {
      assert.ok(ids.has(mechanism.sourceMechanismId), "mock 引用了清单外的 id");
    }
  }
});

// 提示词必须把「先读原片、再看候选」的顺序写死，否则循环论证会从措辞里回来。
test("评审提示词要求先产出机制清单，并给出自检方法", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /在看任何候选之前先做这一步/u);
  assert.match(prompt, /把全部候选删掉，你写的这几条应该一字不变/u);
  assert.match(prompt, /sourceMechanismId/u);
  // 旧口径「这个候选试图迁移的机制」正是循环论证的诱因，不得留在提示词里。
  assert.doesNotMatch(prompt, /这个候选试图迁移的机制/u);
});

// 旧 Artifact 走评审时的错误归属（2026-09-10）。
//
// 实测：拿一份 2026-09-06 之前导出的生产包来评审，返回 **HTTP 502**
// 「模型输出未通过校验：…/highValueBeatMapping/0/failureSignal 缺少必要字段」。
// 两处都不对——那份 themeVariants 是**请求输入**不是模型输出，而且客户端传错该是 4xx。
// failureSignal 与 transformationProof 的 {source, replacement} 都是那之后才加的必填字段，
// 所以在那之前导出的候选**一律评审不了**，而评审恰恰是最该能读历史数据的那个阶段。
//
// 校验本身不放宽：缺字段的旧候选仍然被拒，只是拒得诚实（400 + 逐条诊断）。
test("旧候选走评审报 InputError 而不是模型输出错误", async () => {
  const legacy = structuredClone(CANDIDATES).map((candidate) => ({
    ...candidate,
    highValueBeatMapping: candidate.highValueBeatMapping.map(({ failureSignal, ...rest }) => rest)
  }));
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  await assert.rejects(
    () => workflow.createStoryCandidateReview({
      themeVariants: { variants: legacy },
      sourceScriptReconstruction: RECONSTRUCTION
    }),
    (error) => {
      assert.ok(error instanceof InputError, `应是 InputError，实际 ${error.constructor.name}`);
      assert.ok(!(error instanceof OutputContractError), "不得再是 OutputContractError");
      assert.match(error.message, /themeVariants 不是一批合法候选/u);
      // 校验器数出来的逐条诊断必须带过去，否则用户看不出缺哪个字段。
      assert.match(error.message, /failureSignal/u);
      return true;
    }
  );
});

// 合法候选照常通过，不因为多了一层 try/catch 就改变成功路径。
//
// 本文件的 CANDIDATES 夹具**不是**完整合法候选（缺 verticalFit 与两个拍号）——其余测试都直接调
// 覆盖率校验器，从不过 strict schema。这里要走整个端点，所以先补齐必填键、再让服务端派生
// keyChoice / climax / emotionalPayoff（与 createVariants 同一条派生路径）。
test("合法候选不受错误归属改动影响", async () => {
  const complete = deriveStoryCandidateProjections({
    variants: CANDIDATES.map((candidate) => ({
      ...candidate,
      verticalFit: "治愈日常",
      keyChoiceBeat: 1,
      climaxBeat: candidate.storyOutline.length
    }))
  });
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const result = await workflow.createStoryCandidateReview({
    themeVariants: complete,
    sourceScriptReconstruction: RECONSTRUCTION
  });
  assert.equal(result.review.candidateChecks.length, complete.variants.length);
});

// ---------------------------------------------------------------------------
// 浏览器侧。契约改了五个面，前四个（生产者/校验器/Prompt/测试）当天就动了，
// **消费者是漏掉的那一个**：`sourceMechanism` / `whereInSource` 改名移位之后，
// 渲染函数还在读旧键，而 escape(undefined) 返回空串——页面上是**静默空白**，
// 不是报错。顶层 sourceMechanisms 与逐候选 coherenceChecks 更是从来没渲染过。
// 这几条断言就是为了让「删掉渲染」重新变成一次响亮的失败。
import fs from "node:fs";

const APP_JS = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("浏览器读的是 sourceMechanismId，旧的两个键名不能再出现", () => {
  assert.match(APP_JS, /entry\.sourceMechanismId/u);
  // 光秃秃的 entry.sourceMechanism 读到的一律是 undefined，escape 之后是空串——
  // 页面上是静默空白，不是报错。所以这个前缀后面必须永远紧跟 Id。
  const bareOldKey = APP_JS.split("entry.sourceMechanism").slice(1)
    .filter((rest) => !rest.startsWith("Id"));
  assert.deepEqual(bareOldKey, [], "entry.sourceMechanism 仍被当成字段读，那个键已经不存在了");
  // whereInSource 现在只挂在顶层清单上，逐条 mechanismCheck 里已经没有这个字段。
  const perCheck = APP_JS.slice(APP_JS.indexOf("const mechanisms ="), APP_JS.indexOf("const coherence ="));
  assert.ok(perCheck.length > 0);
  assert.ok(!perCheck.includes("whereInSource"), "逐条引用里不该再读 whereInSource");
});

test("顶层机制清单被渲染出来，否则每条引用只剩一个孤零零的 id", () => {
  assert.match(APP_JS, /review\.sourceMechanisms/u);
  assert.match(APP_JS, /candidate-review-mechanisms/u);
  // 清单里的三个字段都要显示，缺 whereInSource 就无从判断这条机制读得对不对。
  assert.match(APP_JS, /escape\(entry\.mechanism\)/u);
  assert.match(APP_JS, /escape\(entry\.whereInSource\)/u);
});

test("因果自洽问题被渲染出来——这一档的全部意义就是把断裂摆出来看", () => {
  assert.match(APP_JS, /check\.coherenceChecks/u);
  assert.match(APP_JS, /candidate-review-coherence/u);
  assert.match(APP_JS, /escape\(entry\.problem\)/u);
  // kind 是英文枚举，直接显示等于让人对着 purpose_nullified 猜。
  assert.match(APP_JS, /COHERENCE_KIND_LABEL/u);
});

test("kind 的五个枚举值在浏览器侧都有中文标签，与 schema 逐字对齐", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  const kinds = schema.$defs.coherenceCheck.properties.kind.enum;
  assert.equal(kinds.length, 5);
  const start = APP_JS.indexOf("const COHERENCE_KIND_LABEL");
  assert.ok(start >= 0);
  const labels = APP_JS.slice(start, APP_JS.indexOf("};", start));
  for (const kind of kinds) {
    assert.ok(labels.includes(`${kind}:`), `kind ${kind} 缺中文标签`);
  }
  // 反过来也要成立：标签表里不许有 schema 没定义的取值，否则是照着想象写的。
  const declared = labels.split("\n").slice(1).map((line) => line.trim().split(":")[0]).filter(Boolean);
  assert.deepEqual(new Set(declared), new Set(kinds));
});

// 2026-09-12 的消费者面。上一次改这份契约漏掉的就是这一面，而且是静默漏
// （escape(undefined) 返回空串，页面上是空白不是报错）。同一个坑不踩第二次。
test("浏览器读的是拆开之后的两格证据，旧的单格键不能再出现", () => {
  assert.match(APP_JS, /escape\(entry\.actionEvidence\)/u);
  assert.match(APP_JS, /entry\.causeEvidence/u);
  assert.ok(!APP_JS.includes("entry.whereInCandidate"), "whereInCandidate 这个键已经不存在了");
});

test("需要前因的机制在清单上有标记，逐条引用旁才显示前因那一行", () => {
  assert.match(APP_JS, /entry\.requiresCause === true/u);
  assert.match(APP_JS, /需要前因/u);
  // 标了需要前因却没写，要显示成「没有写出前因」而不是一片空白。
  assert.match(APP_JS, /source\?\.requiresCause === true/u);
  assert.match(APP_JS, /这条机制标了需要前因，而评审没有写出前因/u);
});

test("骨架对照整块被渲染出来：事件链、五个维度、分数与换皮提示", () => {
  assert.match(APP_JS, /check\.sourceScaffoldOverlap/u);
  assert.match(APP_JS, /candidate-review-scaffold/u);
  assert.match(APP_JS, /escape\(link\.sourceEvent\)/u);
  assert.match(APP_JS, /escape\(link\.candidateEvent\)/u);
  assert.match(APP_JS, /SCAFFOLD_LINKAGE_LABEL/u);
  assert.match(APP_JS, /SCAFFOLD_DIMENSION_LABEL/u);
  assert.match(APP_JS, /SCAFFOLD_DIMENSION_TITLE/u);
  assert.match(APP_JS, /SOURCE_SCAFFOLD_COPY_SCORE/u, "换皮线从共用常量取，不在浏览器里再写一个 70");
  assert.match(APP_JS, /疑似换皮/u);
});

test("两个枚举在浏览器侧都有中文标签，与 schema 逐字对齐", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  const labelKeys = (name) => {
    const start = APP_JS.indexOf(`const ${name}`);
    assert.ok(start >= 0, `${name} 不存在`);
    const body = APP_JS.slice(start, APP_JS.indexOf("};", start));
    return new Set(body.split("\n").slice(1).map((line) => line.trim().split(":")[0]).filter(Boolean));
  };
  // 反过来也要成立：标签表里不许有 schema 没定义的取值，否则是照着想象写的。
  assert.deepEqual(labelKeys("SCAFFOLD_LINKAGE_LABEL"), new Set(schema.$defs.scaffoldLinkage.enum));
  assert.deepEqual(labelKeys("SCAFFOLD_DIMENSION_LABEL"), new Set(schema.$defs.scaffoldDimension.enum));
});

// 选题终审这一档的消费者面（2026-09-12）。同一个坑这是第三次防：
// 契约改了而渲染没跟上，页面是静默空白不是报错。
test("浏览器读派生出来的 effectiveVerdict，分数与放行决定分开显示", () => {
  assert.match(APP_JS, /check\.effectiveVerdict \|\| check\.verdict/u, "新字段优先、旧报告回退");
  assert.match(APP_JS, /candidate-review-score/u);
  assert.match(APP_JS, /check\.overallScore/u);
  assert.match(APP_JS, /CANDIDATE_TIER_LABEL/u);
  // 降级理由必须显示出来，并写明质量分不因此改变——这正是拆成四个概念的意义。
  assert.match(APP_JS, /verdictOverrideReasons/u);
  assert.match(APP_JS, /CANDIDATE_REVIEW_OVERRIDE_LABELS/u);
  assert.match(APP_JS, /质量分与等级不因此改变/u);
});

test("十一个维度、主要缺陷、简报合规与三条建议都被渲染出来", () => {
  assert.match(APP_JS, /CANDIDATE_REVIEW_DIMENSION_LABELS/u);
  assert.match(APP_JS, /check\.dimensions/u);
  assert.match(APP_JS, /check\.dominantDefect/u);
  assert.match(APP_JS, /DEFECT_SEVERITY_LABEL/u);
  assert.match(APP_JS, /check\.briefAlignment/u);
  assert.match(APP_JS, /BRIEF_ALIGNMENT_LABEL/u);
  assert.match(APP_JS, /check\.top3RevisionSuggestions/u);
  assert.match(APP_JS, /SUGGESTION_KIND_LABEL/u);
  assert.match(APP_JS, /whyOnlyHere/u);
});

test("批次收敛与简报问题置顶显示——它们是集合属性，不属于任何单个候选", () => {
  assert.match(APP_JS, /review\.batchTemplateConvergence/u);
  assert.match(APP_JS, /candidate-review-convergence/u);
  assert.match(APP_JS, /review\.briefProblemsDetected/u);
  assert.match(APP_JS, /review\.recommendedWinner/u);
});

test("浏览器把三份上游一起送上去，缺一份就少一节判断依据", () => {
  const body = APP_JS.slice(
    APP_JS.indexOf('api("/api/story-candidate-review"'),
    APP_JS.indexOf('api("/api/story-candidate-review"') + 900
  );
  assert.match(body, /creatorProfile: profile\(\)/u);
  assert.match(body, /creativeBrief: state\.output\.creativeBrief/u);
  assert.match(body, /referenceAnalysis: state\.output\.referenceAnalysis/u);
});

test("维度标签与权重表逐字对齐，两边都不许各写一份", () => {
  assert.deepEqual(
    new Set(Object.keys(WEIGHTS)),
    new Set(Object.keys(LABELS)),
    "标签表与权重表必须覆盖同一组维度"
  );
  assert.match(APP_JS, /CANDIDATE_REVIEW_TIERS/u, "五档标签从共用常量取，浏览器不另写一份");
});

test("摘要数出越线的候选数，旧报告整段不显示", async () => {
  const { candidateReviewMetrics, candidateReviewHeadline } =
    await import("../public/story-review-metrics.js");
  const review = {
    candidateChecks: [
      { verdict: "revise", mechanismChecks: [], coherenceChecks: [], sourceScaffoldOverlap: { score: 95 } },
      { verdict: "pass", mechanismChecks: [], coherenceChecks: [], sourceScaffoldOverlap: { score: 10 } }
    ]
  };
  const metrics = candidateReviewMetrics(review);
  assert.equal(metrics.scaffoldScored, 2);
  assert.equal(metrics.scaffoldCopies, 1);
  assert.match(candidateReviewHeadline(review), /疑似换皮 1\/2/u);

  // 旧报告没有这一档：数出来是 0，但那是「这一档还不存在」，不是「查过了没换皮」。
  const legacy = { candidateChecks: [{ verdict: "pass", mechanismChecks: [{ verdict: "depicted" }] }] };
  assert.equal(candidateReviewMetrics(legacy).scaffoldScored, 0);
  assert.doesNotMatch(candidateReviewHeadline(legacy), /疑似换皮/u);
});

// ---------------------------------------------------------------------------
// 选题终审：十一维评分、四条新闸门与派生链（2026-09-12）。

test("十一个维度必须齐全，缺一个就算不出总分", () => {
  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].dimensions.pop();
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_DIMENSION_MISSING");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_DIMENSION_MISSING");
      assert.equal(hit.path, "/candidateChecks/0/dimensions");
      return true;
    }
  );
});

test("未知维度与重复维度都被抓住", () => {
  const unknown = scoreAll(baseReview(), 8);
  unknown.candidateChecks[0].dimensions[0].id = "vibes";
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(unknown, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_DIMENSION_UNKNOWN"));
      return true;
    }
  );

  const duplicated = scoreAll(baseReview(), 8);
  duplicated.candidateChecks[0].dimensions[1].id = duplicated.candidateChecks[0].dimensions[0].id;
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(duplicated, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_DIMENSION_DUPLICATE"));
      return true;
    }
  );
});

// 加权总分由服务端算：模型自己算错、或干脆不算，都不影响结果。
test("总分是按权重表算出来的，与模型无关", async () => {
  const { CANDIDATE_REVIEW_DIMENSION_WEIGHTS, candidateOverallScore } =
    await import("../public/story-review-metrics.js");
  const weights = Object.values(CANDIDATE_REVIEW_DIMENSION_WEIGHTS);
  assert.equal(Math.round(weights.reduce((sum, w) => sum + w, 0) * 100) / 100, 1, "权重合计必须是 1.00");

  const review = scoreAll(baseReview(), 8);
  // 把权重最高的那一维（角色专属性 12%）单独拉到 10，总分应当只涨 0.24。
  const top = review.candidateChecks[0].dimensions.find((dim) => dim.id === "characterSpecificity");
  top.score = 10;
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.equal(out.candidateChecks[0].overallScore, 8.24);
  assert.equal(candidateOverallScore(review.candidateChecks[0].dimensions), 8.24);
});

test("五档等级按分数派生，边界值属于上面那一档", async () => {
  const { candidateTier } = await import("../public/story-review-metrics.js");
  assert.equal(candidateTier(9.0).id, "ready");
  assert.equal(candidateTier(8.99).id, "minor_fix");
  assert.equal(candidateTier(8.5).id, "minor_fix");
  assert.equal(candidateTier(8.49).id, "needs_revision");
  assert.equal(candidateTier(8.0).id, "needs_revision");
  assert.equal(candidateTier(7.99).id, "major_rework");
  assert.equal(candidateTier(7.0).id, "major_rework");
  assert.equal(candidateTier(6.99).id, "reject_or_regenerate");
});

test("模型自报的派生字段一律被覆盖，不构成新事实", () => {
  const review = scoreAll(baseReview(), 9.4);
  review.candidateChecks.forEach((check) => {
    check.coherenceChecks = [];
    check.overallScore = 2;
    check.tier = "reject_or_regenerate";
    check.scoreBasedVerdict = "drop";
    check.effectiveVerdict = "drop";
    check.verdictOverrideReasons = ["blocker_defect"];
  });
  review.recommendedWinner = "V2";
  review.rejectOrRegenerate = ["V1", "V2"];
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.equal(out.candidateChecks[0].overallScore, 9.4);
  assert.equal(out.candidateChecks[0].tier, "ready");
  assert.equal(out.candidateChecks[0].effectiveVerdict, "pass");
  assert.deepEqual(out.candidateChecks[0].verdictOverrideReasons, []);
  // winner / 淘汰名单同样是派生的：模型写的那份被整体覆盖。
  assert.equal(out.recommendedWinner, out.holisticPreferenceOrder[0]);
  assert.deepEqual(out.rejectOrRegenerate, []);
});

// 这正是外部评审点出的漏洞：模型判了淘汰，名单却是空的，schema 照样能过。
test("淘汰名单与最终判定严格一致，全批被淘汰时首选为空", () => {
  const review = scoreAll(baseReview(), 5);
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.deepEqual(
    out.rejectOrRegenerate,
    out.candidateChecks.filter((check) => check.effectiveVerdict === "drop").map((check) => check.candidateId)
  );
  assert.equal(out.recommendedWinner, "", "全批都该淘汰时不硬推一个首选");
  assert.equal(out.runnerUp, "");
});

// 2026-09-12：现在有**两个**「谁更好」的系统，刻意不合并也不强制对齐——
// scoreOrder（十一维加权分派生）与 holisticPreferenceOrder（模型的整体判断）。
// 实测它们会分歧：一次回放里模型推荐先做 V1（6.83），而 V4 分更高（6.89）。
// **生产用 scoreOrder**：抖动数据显示加权分能可靠分出最好与最差（最佳候选 3/3 排第一、
// sd 0.09），中段不可靠——而 winner 只取第一名，正好落在可靠的那一段。
test("首选与次选跟着分数走，不跟模型的整体偏好走", () => {
  const review = scoreAll(baseReview(), 7.5);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  // 让 V2 的分明确更高，同时让模型的偏好序反过来把 V1 排在前面。
  review.candidateChecks[1].dimensions.forEach((dim) => { dim.score = 9; });
  review.holisticPreferenceOrder = ["V1", "V2"];
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.deepEqual(out.scoreOrder, ["V2", "V1"], "scoreOrder 按分数从高到低");
  assert.equal(out.recommendedWinner, "V2", "首选取分数最高的那个");
  assert.equal(out.runnerUp, "V1");
  // 模型那一份原样保留——分歧本身是有价值的观察，不许为了一致而抹掉。
  assert.deepEqual(out.holisticPreferenceOrder, ["V1", "V2"]);
});

test("分数相同时 scoreOrder 稳定按原顺序，不随机", () => {
  const review = scoreAll(baseReview(), 8.6);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  const first = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ).scoreOrder;
  const again = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(scoreAll(baseReview(), 8.6), "storyCandidateReview"), CANDIDATES
  ).scoreOrder;
  assert.deepEqual(first, ["V1", "V2"]);
  assert.deepEqual(first, again, "同一份报告重算多少次都一样");
});

test("dominantDefect 的 type 与 severity 必须同真同假", () => {
  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].dominantDefect = { type: "none", severity: "MAJOR", description: "" };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_DEFECT_INCONSISTENT"));
      return true;
    }
  );

  const empty = scoreAll(baseReview(), 8);
  empty.candidateChecks[0].dominantDefect = { type: "openingHook", severity: "MAJOR", description: "  " };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(empty, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_DEFECT_DESCRIPTION_EMPTY"));
      return true;
    }
  );
});

// 定死枚举是为了防漂移：weak_hook / hook_problem / poor_hook 混用会让统计全废。
// schema 是 JSON、没法 import 常量，所以两边只能靠这条测试对齐。
test("缺陷类型只认十一个维度 id 加特殊值，schema 与常量逐字一致", () => {
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  assert.deepEqual(schema.$defs.defectType.enum, [...Object.keys(WEIGHTS), ...SPECIAL_DEFECTS]);
  assert.deepEqual(schema.$defs.defectSeverity.enum, ["BLOCKER", "MAJOR", "MINOR", "NONE"]);
  // 2026-09-12 首次真实回放后补的两类，必须在枚举里。
  assert.ok(SPECIAL_DEFECTS.includes("ownership_or_authority"));
  assert.ok(SPECIAL_DEFECTS.includes("setting_assumption"));

  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].dominantDefect.type = "weak_hook";
  assert.throws(() => ensureOutputContract(review, "storyCandidateReview"), /dominantDefect/u);
});

// 所有权问题是**独立的世界规则问题**，不是物理错误：首次真实回放里
// 「图书馆的旧绘本被送给奶奶」整份报告零命中，而它是那个候选的首要问题。
test("所有权类缺陷可以判到 BLOCKER，并按 causalLogic 那条规则被要求检查", () => {
  const review = scoreAll(baseReview(), 9.5);
  review.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  review.candidateChecks[0].dominantDefect = {
    type: "ownership_or_authority",
    severity: "BLOCKER",
    description: "那本绘本是图书馆的，没有任何人许可她把它送人。"
  };
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  );
  assert.deepEqual(out.candidateChecks[0].verdictOverrideReasons, ["blocker_defect"]);
  assert.equal(out.candidateChecks[0].tier, "ready", "质量分与等级不因缺陷改变");
  assert.equal(out.candidateChecks[0].effectiveVerdict, "revise");

  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /角色修改、拿走、赠送、销毁或长期占有一件物品时/u);
  assert.match(prompt, /ownership_or_authority/u);
});

// 背景设定类**封顶 MAJOR**：它是候选自己加的设定，不是对已签发角色事实的违反。
// 固定角色只写了「芙芙猫是固定搭档」，从没规定它住哪儿。
test("setting_assumption 不许判 BLOCKER，判 MAJOR 照常通过", () => {
  const blocked = scoreAll(baseReview(), 8);
  blocked.candidateChecks[0].dominantDefect = {
    type: "setting_assumption",
    severity: "BLOCKER",
    description: "把固定搭档写成平时睡在院子的纸箱里。"
  };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(blocked, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_DEFECT_SEVERITY_CAP");
      assert.ok(hit, "应报 CANDIDATE_REVIEW_DEFECT_SEVERITY_CAP");
      assert.equal(hit.path, "/candidateChecks/0/dominantDefect/severity");
      return true;
    }
  );

  const ok = scoreAll(baseReview(), 8);
  ok.candidateChecks[0].dominantDefect = {
    type: "setting_assumption",
    severity: "MAJOR",
    description: "把固定搭档写成平时睡在院子的纸箱里。"
  };
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(ok, "storyCandidateReview"), CANDIDATES
  ));

  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /偷偷引入了一个上游从没建立过、但会明显改变/u);
  assert.match(prompt, /\*\*它最高只能判 MAJOR\*\*/u);
});

// 物理机制**不是二选一**：真正缺的那一档是「在某些条件下成立，而候选没交代那些条件」。
// 起因是回放里「下雨天用胶带把落叶贴在纸箱上做防水」被判成「物理上可行」并给了 8 分。
test("自称依赖条件就必须写出依赖什么、以及不成立时会怎样", () => {
  for (const confidence of ["conditional", "unlikely"]) {
    const review = scoreAll(baseReview(), 8);
    review.candidateChecks[0].physicalAssumptions = [
      { mechanism: "用胶带把落叶贴在纸箱上防水", confidence, literalDependency: "required", necessaryAssumptions: [], failureRisk: "" }
    ];
    assert.throws(
      () => ensureStoryCandidateReviewCoversCandidates(
        ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
      ),
      (error) => {
        const hits = error.details.filter((d) => d.code === "CANDIDATE_REVIEW_ASSUMPTION_INCOMPLETE");
        assert.equal(hits.length, 2, `${confidence} 应当同时要求条件与失败风险`);
        return true;
      }
    );
  }

  const complete = scoreAll(baseReview(), 8);
  complete.candidateChecks[0].physicalAssumptions = [{
    mechanism: "用胶带把落叶贴在纸箱上防水",
    confidence: "conditional",
    literalDependency: "required",
    necessaryAssumptions: ["叶片与纸箱表面是干的", "胶带适合潮湿表面"],
    failureRisk: "正在下雨时胶带粘不住，树叶会滑落，纸箱照样湿。",
    beatIndexes: [2]
  }];
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(complete, "storyCandidateReview"), CANDIDATES
  ));
});

test("明确成立那一档不必列条件，空数组也是合法结论", () => {
  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].physicalAssumptions = [
    { mechanism: "把面团捏成猫的形状", confidence: "established", literalDependency: "optional", necessaryAssumptions: [], failureRisk: "" }
  ];
  review.candidateChecks[1].physicalAssumptions = [];
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// literalDependency 与 confidence 是**两个正交的轴**（2026-09-12 第三轮回放后补）。
// 起因：《罐装阳光》把阳光装进玻璃罐在物理上当然 unlikely，但剧情从没要求它真的成立；
// 而实测该候选的 productionFeasibility 9→7、causalLogic 9→8，说明模型很可能把
// 「不是现实物理」本身当成了质量问题——那会把童真想象误杀。
test("想象类机制可以同时是物理立不住与剧情不依赖它", () => {
  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].physicalAssumptions = [{
    mechanism: "把阳光装进玻璃罐并盖上盖子",
    confidence: "unlikely",
    literalDependency: "make_believe",
    necessaryAssumptions: ["光是光学现象，盖上盖子内部只会变暗"],
    failureRisk: "如果镜头真把罐子内部拍成凭空发光，就破坏了物理常识。",
    beatIndexes: [2]
  }];
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ), "两个轴互相独立，这个组合完全合法");
});

test("三档 literalDependency 的中文标签与 schema 枚举逐字对齐", async () => {
  const { CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS } = await import("../public/story-review-metrics.js");
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  assert.deepEqual(
    new Set(Object.keys(CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS)),
    new Set(schema.$defs.physicalAssumption.properties.literalDependency.enum)
  );
});

test("提示词把两个轴分开，并禁止拿想象类机制扣制作分", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /confidence —— 现实里这事成不成立/u);
  assert.match(prompt, /literalDependency —— 故事需不需要它真的成立/u);
  assert.match(prompt, /\*\*这两个轴是分开的，不许混。\*\*/u);
  assert.match(prompt, /不得因为现实里做不到就扣 productionFeasibility 或 causalLogic/u);
  assert.match(prompt, /扣分只针对/u);
});

// briefAlignment 正式降级为编辑参考信息（2026-09-12）。依据是抖动数据：
// 同一份输入、同一个候选三次回放，PASS / WARN 互相翻转过；跨包时改简报的方向甚至相反。
test("简报判定不参与分数、等级与放行决定", () => {
  const base = scoreAll(baseReview(), 8.6);
  base.candidateChecks.forEach((check) => { check.coherenceChecks = []; });
  const pass = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(structuredClone(base), "storyCandidateReview"), CANDIDATES
  );

  const failed = structuredClone(base);
  failed.candidateChecks.forEach((check) => {
    check.briefAlignment = { status: "FAIL", conflict: "完全违反简报", suggestBriefChange: "" };
  });
  const out = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(failed, "storyCandidateReview"), CANDIDATES
  );

  for (let i = 0; i < out.candidateChecks.length; i += 1) {
    assert.equal(out.candidateChecks[i].overallScore, pass.candidateChecks[i].overallScore);
    assert.equal(out.candidateChecks[i].tier, pass.candidateChecks[i].tier);
    assert.equal(out.candidateChecks[i].effectiveVerdict, pass.candidateChecks[i].effectiveVerdict);
    assert.deepEqual(out.candidateChecks[i].verdictOverrideReasons, []);
  }
  assert.equal(out.recommendedWinner, pass.recommendedWinner);
});

test("提示词与页面都写明简报这一档只是线索", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /编辑参考信息，不参与任何判定/u);
  assert.match(prompt, /不进分数、不进等级、不进放行决定、不会自动去改简报/u);
  assert.match(APP_JS, /不参与分数、等级与放行决定/u);
});

test("浏览器并排显示两份排序，并在不一致时点出来", () => {
  assert.match(APP_JS, /review\.scoreOrder/u);
  assert.match(APP_JS, /review\.holisticPreferenceOrder/u);
  assert.match(APP_JS, /与评分排序不一致/u);
  assert.match(APP_JS, /CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS/u);
});

// 用到了就必须导入——**这条是 2026-09-12 一次真实事故补的**。
//
// `CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS` 在渲染函数里用了、却没加进 import：
// 页面加载不报错（模块求值期碰不到那一行），直到用户点「对照原片体检候选」、
// 模型跑完、开始渲染报告时才抛 ReferenceError——**两次真实调用的钱都花了，
// 报告拿到了，却只在屏幕上留下一句 "... is not defined"**。
//
// 而上面那条 `assert.match(APP_JS, /CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS/u)`
// **照样通过**：它只证明这个名字在文件里出现过，而出现的正是那处用法本身。
// 源码断言检查「渲染有没有写」是够的，检查「写的东西能不能跑」是不够的。
//
// 所以这里改成对着模块的**真实导出清单**核对：凡是 story-review-metrics.js
// 导出的名字，只要在 app.js 的代码位置被引用，就必须出现在那条 import 里。
test("app.js 引用的每一个共用常量都真的导入了，不能只是出现在文件里", async () => {
  const metrics = await import("../public/story-review-metrics.js");
  const importBlock = APP_JS.slice(
    APP_JS.indexOf("import {"),
    APP_JS.indexOf('} from "./story-review-metrics.js";')
  );
  // 去掉注释行再找引用：诊断码常出现在注释里（例如 CANDIDATE_REVIEW_UNKNOWN_MECHANISM），
  // 那不是标识符引用，不该被当成缺失导入。
  const codeOnly = APP_JS
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  const missing = Object.keys(metrics)
    .filter((name) => new RegExp(`\\b${name}\\b`, "u").test(codeOnly))
    .filter((name) => !new RegExp(`\\b${name}\\b`, "u").test(importBlock));
  assert.deepEqual(missing, [], `这些名字在 app.js 里用了却没导入：${missing.join("、")}`);
});

test("提示词把三档写清楚，并禁止因为温馨就无条件判成立", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /这一档刻意不是「可行 \/ 不可行」二选一/u);
  assert.match(prompt, /在某些条件下成立，而候选没有交代那些条件/u);
  assert.match(prompt, /不得因为某个机制看起来很温馨，就无条件判成 established/u);
  assert.match(prompt, /材料干湿、摩擦力、承重、粘合强度/u);
});

test("mock 的物理机制两个分支都走到，且自己守闸门", () => {
  const review = baseReview();
  const withAssumption = review.candidateChecks.filter((check) => check.physicalAssumptions.length);
  const without = review.candidateChecks.filter((check) => !check.physicalAssumptions.length);
  assert.ok(withAssumption.length, "至少一个候选要带非空 physicalAssumptions");
  assert.ok(without.length, "空数组分支也要走到");
  for (const check of withAssumption) {
    for (const row of check.physicalAssumptions) {
      if (row.confidence === "established") continue;
      assert.ok(row.necessaryAssumptions.length, "mock 自己也要守闸门");
      assert.ok(row.failureRisk);
    }
  }
});

test("浏览器渲染物理机制与缺陷类型的中文标签", () => {
  assert.match(APP_JS, /check\.physicalAssumptions/u);
  assert.match(APP_JS, /candidate-review-assumptions/u);
  assert.match(APP_JS, /CANDIDATE_REVIEW_CONFIDENCE_LABELS/u);
  assert.match(APP_JS, /necessaryAssumptions/u);
  assert.match(APP_JS, /failureRisk/u);
  // 让人对着 ownership_or_authority 猜，是这套报告最容易犯的可读性错误。
  assert.match(APP_JS, /CANDIDATE_REVIEW_SPECIAL_DEFECT_LABELS/u);
});

test("三档 confidence 的中文标签与 schema 枚举逐字对齐", async () => {
  const { CANDIDATE_REVIEW_CONFIDENCE_LABELS } = await import("../public/story-review-metrics.js");
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-candidate-review-strict.schema.json", import.meta.url), "utf8"
  ));
  assert.deepEqual(
    new Set(Object.keys(CANDIDATE_REVIEW_CONFIDENCE_LABELS)),
    new Set(schema.$defs.physicalAssumption.properties.confidence.enum)
  );
});

// 模板化不只发生在新增：「把结尾替换成奶奶摸摸头」是 replace，照样是模板。
test("除 remove 外的建议都必须回答为什么只能发生在这个故事里", () => {
  for (const kind of ["strengthen", "replace", "recycle", "add"]) {
    const review = scoreAll(baseReview(), 8);
    review.candidateChecks[0].top3RevisionSuggestions = [
      { kind, suggestion: "把结尾换成摸头。", replacesOrStrengthens: "原结尾", whyOnlyHere: "" }
    ];
    assert.throws(
      () => ensureStoryCandidateReviewCoversCandidates(
        ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
      ),
      (error) => {
        const hit = error.details.find((d) => d.code === "CANDIDATE_REVIEW_SUGGESTION_WHY_MISSING");
        assert.ok(hit, `${kind} 应该被要求写 whyOnlyHere`);
        return true;
      }
    );
  }

  const removal = scoreAll(baseReview(), 8);
  removal.candidateChecks[0].top3RevisionSuggestions = [
    { kind: "remove", suggestion: "删掉重复的第二次强调。", replacesOrStrengthens: "第 2 拍", whyOnlyHere: "" }
  ];
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(removal, "storyCandidateReview"), CANDIDATES
  ));
});

test("最多三条建议，第四条由 schema 拒掉", () => {
  const review = scoreAll(baseReview(), 8);
  review.candidateChecks[0].top3RevisionSuggestions = Array.from({ length: 4 }, () => ({
    kind: "remove", suggestion: "占位", replacesOrStrengthens: "", whyOnlyHere: ""
  }));
  assert.throws(() => ensureOutputContract(review, "storyCandidateReview"), /top3RevisionSuggestions/u);
});

// 批次模板收敛是集合属性：逐个看四个都可以声称自己原创，只有横着看才发现是同一套机制。
test("判定批次收敛就必须点名至少两个真实候选并写出机制", () => {
  const tooFew = scoreAll(baseReview(), 8);
  tooFew.batchTemplateConvergence = {
    converged: true, sharedMechanism: "身体拟物化搞怪解决问题", affectedCandidateIds: ["V1"], evidence: ""
  };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(tooFew, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_BATCH_CONVERGENCE_TOO_FEW"));
      return true;
    }
  );

  const unknown = scoreAll(baseReview(), 8);
  unknown.batchTemplateConvergence = {
    converged: true, sharedMechanism: "同一套机制", affectedCandidateIds: ["V1", "V9"], evidence: ""
  };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(unknown, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_BATCH_CONVERGENCE_UNKNOWN"));
      return true;
    }
  );

  const noMechanism = scoreAll(baseReview(), 8);
  noMechanism.batchTemplateConvergence = {
    converged: true, sharedMechanism: "  ", affectedCandidateIds: ["V1", "V2"], evidence: ""
  };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(noMechanism, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_BATCH_CONVERGENCE_MECHANISM_EMPTY"));
      return true;
    }
  );
});

test("说不收敛就不许点名任何候选", () => {
  const review = scoreAll(baseReview(), 8);
  review.batchTemplateConvergence = {
    converged: false, sharedMechanism: "", affectedCandidateIds: ["V1", "V2"], evidence: ""
  };
  assert.throws(
    () => ensureStoryCandidateReviewCoversCandidates(
      ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
    ),
    (error) => {
      assert.ok(error.details.some((d) => d.code === "CANDIDATE_REVIEW_BATCH_CONVERGENCE_NOT_CONVERGED"));
      return true;
    }
  );
});

test("合法的收敛判定照常通过", () => {
  const review = scoreAll(baseReview(), 8);
  review.batchTemplateConvergence = {
    converged: true,
    sharedMechanism: "普通问题 → 角色身体变成工具 → 意外解决",
    affectedCandidateIds: ["V1", "V2"],
    evidence: "两条动作链在第 2 拍都靠身体拟物化解决问题。"
  };
  assert.doesNotThrow(() => ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(review, "storyCandidateReview"), CANDIDATES
  ));
});

// ---------------------------------------------------------------------------
// 上游投影与提示词。

test("上游按允许清单投影，简报只送四项", async () => {
  const { buildStoryCandidateReviewUpstream } = await import("../src/prompts.js");
  const upstream = buildStoryCandidateReviewUpstream({
    creatorProfile: { fixedCharacter: "小白子", vertical: "治愈", constraints: "无", 多余字段: "不该出现" },
    creativeBrief: {
      storyEngine: { desire: "想要" },
      recastTest: { recastAs: "换个角色", collapses: ["甲"], survives: ["乙"] },
      nonNegotiableExperience: { samePlotDriver: "一件小事" },
      reusableHighValueBeats: [{ beat: "拍", dramaticValue: "值", mustRetain: true, 多余: "x" }],
      protectedExpressions: [{ sourceExpression: "不该出现的原片表达" }]
    },
    referenceAnalysis: { retentionDrivers: ["驱动"], dialogueStyle: "低", observedFacts: ["不该出现"] }
  });
  const serialized = JSON.stringify(upstream);
  assert.doesNotMatch(serialized, /多余字段|多余|不该出现/u, "允许清单之外的字段一律不得泄漏");
  // recastTest 两侧都送：评审不生成故事，survives 恰恰告诉它哪些东西谁来演都一样。
  assert.deepEqual(upstream.creativeBrief.recastTest.survives, ["乙"]);
  assert.equal(upstream.referenceAnalysis.dialogueStyle, "低");
  assert.equal(upstream.creatorProfile.fixedCharacter, "小白子");
});

test("提示词写明四份材料各自的身份，且简报不是原片事实", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION, null, {
    creativeBrief: { storyEngine: { desire: "想要" } }
  });
  assert.match(prompt, /\*\*creativeBrief 不是原片事实。\*\*/u);
  assert.match(prompt, /\*\*绝不因为某个候选更像参考片就给它加分。\*\*/u);
  assert.match(prompt, /上游创作假设，可以质疑/u);
  // 判断顺序是这套设计的核心：先角色与创作者，最后才是简报。
  assert.match(prompt, /最后才看它符不符合上游简报/u);
});

test("三份上游都没有时整段不出现，评审照常可用", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.doesNotMatch(prompt, /上游材料（身份见下面第一节/u);
  assert.match(prompt, /dimensions/u);
});

// 2026-09-12 live 实测：第一次输出把 briefProblemsDetected[0] 写成了对象、被 schema 拦下，
// 带诊断重做一次才过（花了 ¥1.31）。根因是输出模板里它是**空数组、没有元素示例**——
// 与 §2.14 分镜终审 shotEvaluations[].issues 栽的是同一跤：同一份报告里到处是对象数组，
// 模型就按对象填。字符串数组必须给非空示例。
test("字符串数组在输出模板里要给非空示例，不能只给空数组", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.doesNotMatch(prompt, /"briefProblemsDetected":\[\]/u, "空数组会让模型猜错元素类型");
  assert.match(prompt, /"briefProblemsDetected":\["/u);
  assert.match(prompt, /每一条都是一句话（字符串），不是对象/u);
});

test("提示词按共用常量列出十一个维度与权重，不另写一份数字", () => {
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  for (const [id, weight] of Object.entries(WEIGHTS)) {
    assert.ok(prompt.includes(id), `提示词缺维度 ${id}`);
    assert.ok(prompt.includes(`${Math.round(weight * 100)}%`), `提示词缺 ${id} 的权重`);
  }
  // 派生字段不许出现在输出模板里——模型写了也会被覆盖。
  assert.doesNotMatch(prompt, /"overallScore"/u);
  assert.doesNotMatch(prompt, /"effectiveVerdict"/u);
});

test("keyChoice 三件套送进评审，但措辞不得把它说成可信的判断事实", () => {
  const projection = buildStoryCandidateReviewProjection({
    ...CANDIDATES[0], keyChoice: "关键选择原文", climax: "高潮原文", emotionalPayoff: "结尾原文"
  });
  assert.equal(projection.keyChoice, "关键选择原文");
  const prompt = storyCandidateReviewPrompt(CANDIDATES, RECONSTRUCTION);
  assert.match(prompt, /但那个拍号是作者选的/u);
});

// 截断与「被校验拦下」是两种失败，重试话术必须不同：
// 截断时没有任何诊断可打回，原样重发只会让它第二次照样写超。
test("截断走单独的重试分支，要求压缩而不是重复原样", () => {
  const body = storyCandidateReviewRetryPrompt({ originalPrompt: "原文", truncated: true });
  assert.ok(body.startsWith("原文"));
  assert.match(body, /因为太长被截断/u);
  assert.match(body, /字段一个都不要少/u);
  assert.doesNotMatch(body, /上一次的输出被确定性校验拦下了/u);
});

test("工作流按错误码分流两种重试，不混成一种", () => {
  const workflowSource = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
  assert.match(workflowSource, /MODEL_OUTPUT_TRUNCATED/u);
  assert.match(workflowSource, /storyCandidateReviewRetryPrompt\(\{ originalPrompt, truncated: true \}\)/u);
});

// 可比对数字与 §2.13 同规格：**从逐条判定里数出来，不问模型要总分。**
// 因果断裂条数是这次新增契约里唯一一个可以直接数的量，漏掉它等于新增的那一档
// 在顶部摘要里完全不存在。
test("摘要数出因果断裂的条数与涉及的候选数", async () => {
  const { candidateReviewMetrics, candidateReviewHeadline } =
    await import("../public/story-review-metrics.js");
  const review = {
    candidateChecks: [
      {
        verdict: "revise",
        mechanismChecks: [{ verdict: "not_depicted" }, { verdict: "depicted" }],
        coherenceChecks: [{ kind: "tool_misuse" }, { kind: "space_or_time" }]
      },
      { verdict: "pass", mechanismChecks: [{ verdict: "depicted" }], coherenceChecks: [] }
    ]
  };
  const metrics = candidateReviewMetrics(review);
  assert.equal(metrics.coherenceBreaks, 2);
  assert.equal(metrics.candidatesWithCoherenceBreak, 1);
  assert.match(candidateReviewHeadline(review), /因果断裂 2 处（1 个候选）/u);
});

// 旧报告根本没有这个键。数出来是 0，但那是「这一档还不存在」，不是「查过了没问题」——
// 所以摘要里那一段整段不显示，而不是显示一个会被读成体检结论的 0。
test("旧报告不带 coherenceChecks 时数出 0，且摘要里不出现这一段", async () => {
  const { candidateReviewMetrics, candidateReviewHeadline } =
    await import("../public/story-review-metrics.js");
  const legacy = { candidateChecks: [{ verdict: "pass", mechanismChecks: [{ verdict: "depicted" }] }] };
  assert.equal(candidateReviewMetrics(legacy).coherenceBreaks, 0);
  assert.doesNotMatch(candidateReviewHeadline(legacy), /因果断裂/u);
});

// ---------------------------------------------------------------------------
// 带诊断的重试。这一档此前走 generateValidatedJson——只发一次、fail closed。
// 2026-09-10 的真实回放量出了代价：同一个模型、两份合法候选，一份一次写全
// recommendedOrder，另一份只写了 1 个 id，被既有闸门判失败，整份两千字报告
// 连同 ¥0.27 一起丢弃，而模型自己不知道漏了什么。
//
// 以下用例全部用 mock client，不烧钱。

// CANDIDATES 夹具刻意不是完整合法候选（缺 verticalFit 与两个拍号），其余用例都直接调
// 覆盖率校验器。这里要走整个 createStoryCandidateReview，所以先补齐必填键、
// 再让服务端派生三个投影字段（与 createVariants 同一条派生路径）。
const COMPLETE = deriveStoryCandidateProjections({
  variants: CANDIDATES.map((candidate) => ({
    ...candidate,
    verticalFit: "治愈日常",
    keyChoiceBeat: 1,
    climaxBeat: candidate.storyOutline.length
  }))
});
const REVIEW_INPUT = { themeVariants: COMPLETE, sourceScriptReconstruction: RECONSTRUCTION };

function liveReviewWorkflow(responses, stageModelOutputLogWriters = null) {
  const prompts = [];
  const client = {
    async generateJson({ prompt, requestTimeoutMs, maxCompletionTokens }) {
      prompts.push({ prompt, requestTimeoutMs, maxCompletionTokens });
      const next = responses[prompts.length - 1];
      if (!next) throw new Error(`第 ${prompts.length} 次调用没有预置响应——预算被超用了`);
      if (typeof next === "function") return next(prompt);
      return next;
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: client },
    stageModelOutputLogWriters,
    stageDefaults: {
      storyCandidateReview: {
        provider: "Qwen",
        model: "test-model",
        maxCompletionTokens: 8192,
        requestTimeoutMs: null
      }
    }
  });
  return { workflow, prompts };
}

// 与 2026-09-10 那次真实 502 同形：模型漏抄了 recommendedOrder 的其余 id。
function reviewMissingOrder() {
  const review = baseReview();
  review.holisticPreferenceOrder = [review.holisticPreferenceOrder[0]];
  return review;
}

test("第一次被确定性闸门拦下时重做一次，第二次通过就正常返回", async () => {
  const { workflow, prompts } = liveReviewWorkflow([reviewMissingOrder(), baseReview()]);
  const result = await workflow.createStoryCandidateReview(REVIEW_INPUT);

  assert.equal(prompts.length, 2);
  assert.equal(result.review.candidateChecks.length, COMPLETE.variants.length);
  // 拦过一次就必须说出来，不能让用户以为模型一次就写对了。
  assert.equal(result.metadata.storyCandidateReview.providerCalls, 2);
  assert.equal(result.metadata.storyCandidateReview.rejections.length, 1);
  assert.equal(result.metadata.storyCandidateReview.rejections[0].attempt, 1);
  assert.equal(
    result.metadata.storyCandidateReview.rejections[0].details[0].code,
    "CANDIDATE_REVIEW_ORDER_NOT_PERMUTATION"
  );
});

test("重试提示词把校验器数出来的原话交回去，不另写一套翻译", async () => {
  const { workflow, prompts } = liveReviewWorkflow([reviewMissingOrder(), baseReview()]);
  await workflow.createStoryCandidateReview(REVIEW_INPUT);

  const retry = prompts[1].prompt;
  // 原提示词逐字保留在前面——规则一个字都没改，改的只是「错了之后怎么办」。
  assert.ok(retry.startsWith(prompts[0].prompt), "重试正文必须以原提示词开头");
  assert.match(retry, /上一次的输出被确定性校验拦下了/u);
  assert.match(retry, /CANDIDATE_REVIEW_ORDER_NOT_PERMUTATION/u);
  assert.match(retry, /排列/u);
  // 不把失败的那份报告发回去：提示词里已有全部候选投影与原片动作稿。
  assert.ok(!retry.includes(JSON.stringify(reviewMissingOrder())), "不得把上一次的报告整份发回去");
});

test("一次就成时不产生任何重试痕迹", async () => {
  const { workflow, prompts } = liveReviewWorkflow([baseReview()]);
  const result = await workflow.createStoryCandidateReview(REVIEW_INPUT);

  assert.equal(prompts.length, 1);
  assert.equal(result.metadata.storyCandidateReview.providerCalls, 1);
  assert.deepEqual(result.metadata.storyCandidateReview.rejections, []);
});

// 契约写着「两次诊断如实报出」而实现只报第二次，是定向修订那边已登记的一处不符。
// 评审这一档一开始就做对。
test("两次都被拦即 fail closed，且两次的诊断都在响应里", async () => {
  const { workflow, prompts } = liveReviewWorkflow([reviewMissingOrder(), reviewMissingOrder()]);
  await assert.rejects(
    () => workflow.createStoryCandidateReview(REVIEW_INPUT),
    (error) => {
      assert.equal(error.name, "ModelPipelineError");
      const attempts = error.diagnostics.map((detail) => detail.metadata?.attempt);
      assert.deepEqual(attempts, [1, 2], "每条诊断都要标明是第几次");
      return true;
    }
  );
  // 预算封在 2 次，禁止第三次。
  assert.equal(prompts.length, 2);
});

test("侧车观测挂在 coordinator 上，两次调用各留一条", async () => {
  const recorded = [];
  // 走 coordinator 就拿不到 generateValidatedJson 那条路自带的 recorder，
  // 漏接 attemptObserver 的后果是静默不写、两次原文全部丢失。
  const { workflow, prompts } = liveReviewWorkflow(
    [reviewMissingOrder(), baseReview()],
    new Map([["storyCandidateReview", {
      enabled: true,
      async recordAttempt(attempt) { recorded.push(attempt); }
    }]])
  );
  await workflow.createStoryCandidateReview(REVIEW_INPUT);

  assert.equal(recorded.length, prompts.length);
  assert.equal(recorded.filter((row) => row.status === "failed").length, 1);
  assert.equal(recorded.filter((row) => row.status === "succeeded").length, 1);
});

test("侧车写入失败不改变评审的成败", async () => {
  const { workflow } = liveReviewWorkflow(
    [baseReview()],
    new Map([["storyCandidateReview", {
      enabled: true,
      async recordAttempt() { throw new Error("磁盘满了"); }
    }]])
  );
  const result = await workflow.createStoryCandidateReview(REVIEW_INPUT);
  assert.equal(result.review.candidateChecks.length, COMPLETE.variants.length);
});

test("重试正文不含反引号——模板字面量会被当场截断", () => {
  const body = storyCandidateReviewRetryPrompt({
    originalPrompt: "原文",
    details: [{ code: "X", path: "/recommendedOrder", reason: "漏了 V2" }]
  });
  assert.ok(!body.includes("`"));
  assert.match(body, /漏了 V2/u);
});

test("没有结构化诊断时退回原提示词——只说你错了不说错在哪，第二次只会重复第一次", () => {
  assert.equal(storyCandidateReviewRetryPrompt({ originalPrompt: "原文", details: [] }), "原文");
  assert.equal(storyCandidateReviewRetryPrompt({ originalPrompt: "原文" }), "原文");
});

test("demo 路径也带 metadata，形状与 live 一致", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const result = await workflow.createStoryCandidateReview(REVIEW_INPUT);
  assert.equal(result.metadata.storyCandidateReview.provider, "demo");
  assert.deepEqual(result.metadata.storyCandidateReview.rejections, []);
});

test("浏览器把「拦过一次」显示出来，没有 metadata 时整段不显示", () => {
  assert.match(APP_JS, /metadata\?\.storyCandidateReview/u);
  assert.match(APP_JS, /call\.providerCalls > 1/u);
  // 诊断原文要显示出来，只说「重试过」而不说被什么拦下等于没说。
  assert.match(APP_JS, /rejectionReasons/u);
  assert.match(APP_JS, /detail\?\.reason/u);
});

// metadata 是外挂的一层，不在 review 对象里：review 的 schema 是
// additionalProperties: false，混进去这份报告就送不回服务端，而定向修订要拿它当输入。
test("评审响应把 review 与 metadata 分开，报告本身仍能通过自己的契约", async () => {
  const { workflow } = liveReviewWorkflow([baseReview()]);
  const result = await workflow.createStoryCandidateReview(REVIEW_INPUT);
  assert.ok(result.review && result.metadata);
  assert.equal(result.review.metadata, undefined, "metadata 不得混进 review 对象");
  assert.doesNotThrow(() => ensureOutputContract(result.review, "storyCandidateReview"));
  // 浏览器必须按两层读，不能再把整个响应当 review 传给渲染函数。
  assert.match(APP_JS, /renderStoryCandidateReview\(result\.review, themeVariants, result\.metadata\)/u);
});
