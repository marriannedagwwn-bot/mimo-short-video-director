import test from "node:test";
import assert from "node:assert/strict";

import { InputError, OutputContractError, deriveStoryCandidateProjections, ensureOutputContract, ensureStoryCandidateReviewCoversCandidates } from "../src/validation.js";
import { buildStoryCandidateReviewProjection, storyCandidateReviewPrompt } from "../src/prompts.js";
import { mockStoryCandidateReview } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";

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
  const review = await workflow.createStoryCandidateReview({
    themeVariants: complete,
    sourceScriptReconstruction: RECONSTRUCTION
  });
  assert.equal(review.candidateChecks.length, complete.variants.length);
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
