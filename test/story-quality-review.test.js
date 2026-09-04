import test from "node:test";
import assert from "node:assert/strict";
import { mockFullStory, mockStoryQualityReview } from "../src/mock.js";
import { storyQualityReviewPrompt } from "../src/prompts.js";
import { storyReviewHeadline, storyReviewMetrics } from "../public/story-review-metrics.js";
import { WorkflowService } from "../src/workflow.js";
import {
  ensureOutputContract,
  ensureStoryQualityReviewCoversStory,
  OutputContractError
} from "../src/validation.js";

const context = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版狼耳少女", vertical: "治愈/温情/日常", constraints: "" },
  variant: { id: "V1", title: "测试变体" }
});

const story = () => mockFullStory(context);

function reviewFor(value) {
  return mockStoryQualityReview(value);
}

function codes(run) {
  try {
    run();
    return [];
  } catch (error) {
    if (!(error instanceof OutputContractError)) throw error;
    return error.details.map((detail) => detail.code);
  }
}

// ---- schema ----

test("合法评审通过递归 strict schema", () => {
  assert.doesNotThrow(() => ensureOutputContract(reviewFor(story()), "storyQualityReview"));
});

test("多字段、缺字段、错枚举值都被递归拒绝", () => {
  const base = reviewFor(story());

  const extra = { ...base, extra: 1 };
  assert.ok(codes(() => ensureOutputContract(extra, "storyQualityReview"))
    .includes("STORY_QUALITY_REVIEW_SCHEMA_UNKNOWN_FIELD"));

  const missing = { ...base };
  delete missing.summary;
  assert.ok(codes(() => ensureOutputContract(missing, "storyQualityReview"))
    .includes("STORY_QUALITY_REVIEW_SCHEMA_REQUIRED"));

  const badVerdict = structuredClone(base);
  badVerdict.sceneFunctionChecks[0].verdict = "maybe";
  assert.throws(() => ensureOutputContract(badVerdict, "storyQualityReview"), OutputContractError);

  const badSeverity = structuredClone(base);
  badSeverity.issues = [{
    severity: "CRITICAL", type: "x", sceneIds: [], evidence: "e", problem: "p", recommendedFix: "f"
  }];
  assert.throws(() => ensureOutputContract(badSeverity, "storyQualityReview"), OutputContractError);
});

test("issues 为空数组合法——没有硬伤是正常结果", () => {
  const value = reviewFor(story());
  assert.deepEqual(value.issues, []);
  assert.doesNotThrow(() => ensureOutputContract(value, "storyQualityReview"));
});

// ---- 覆盖率核验：本方案的关键机制 ----
//
// 模型完全可以只报它碰巧注意到的两三条，交回一份看起来很专业、实际漏检大半的报告。
// 下面四条是纯计数与字符串比较，不含语义判断，专门堵这个。

test("完整覆盖时通过", () => {
  const value = story();
  assert.doesNotThrow(() => ensureStoryQualityReviewCoversStory(reviewFor(value), value));
});

test("漏掉任何一个场次都明确失败", () => {
  const value = story();
  const review = reviewFor(value);
  review.sceneFunctionChecks.pop();
  const detected = codes(() => ensureStoryQualityReviewCoversStory(review, value));
  assert.ok(detected.includes("STORY_REVIEW_SCENE_COVERAGE_INCOMPLETE"));
});

test("场次顺序错位被抓住——必须与 sceneScript 逐位同序", () => {
  const value = story();
  const review = reviewFor(value);
  [review.sceneFunctionChecks[0], review.sceneFunctionChecks[1]] =
    [review.sceneFunctionChecks[1], review.sceneFunctionChecks[0]];
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(review, value))
    .includes("STORY_REVIEW_SCENE_ID_MISMATCH"));
});

// 回显的作用是证明模型读的是这一条。判据是**包含**而不是相等——实测模型不复述，
// 但爱在原文后面追加注解（10 份里 3 份栽在严格相等上）。包含关系同样能唯一确定
// 读的是哪一条，却不会因为多说一句就判失败。
test("复述与截断都被抓住", () => {
  const value = story();

  const paraphrased = reviewFor(value);
  paraphrased.sceneFunctionChecks[0].declaredFunction = "大概是建立一点悬念的意思";
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(paraphrased, value))
    .includes("STORY_REVIEW_DECLARATION_NOT_VERBATIM"));

  const truncated = reviewFor(value);
  truncated.sceneFunctionChecks[0].declaredFunction =
    truncated.sceneFunctionChecks[0].declaredFunction.slice(0, 3);
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(truncated, value))
    .includes("STORY_REVIEW_DECLARATION_NOT_VERBATIM"));

  const wrongEntry = reviewFor(value);
  wrongEntry.retentionChecks[0].viewerQuestion = "观众大概会好奇后面怎么样";
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(wrongEntry, value))
    .includes("STORY_REVIEW_DECLARATION_NOT_VERBATIM"));
});

test("原文后追加注解仍通过，且服务端用原文覆盖掉那段注解", () => {
  const value = story();
  const review = reviewFor(value);
  const original = value.sceneScript[0].dramaticFunction;
  review.sceneFunctionChecks[0].declaredFunction = `${original}，从不爱管闲事到主动介入`;
  const originalQuestion = value.retentionPlan[0].viewerQuestion;
  review.retentionChecks[0].viewerQuestion = `${originalQuestion} 观众会一直想知道`;

  assert.doesNotThrow(() => ensureStoryQualityReviewCoversStory(review, value));
  // 回显不构成新事实：显示的必须是剧情真正写的那句
  assert.equal(review.sceneFunctionChecks[0].declaredFunction, original);
  assert.equal(review.retentionChecks[0].viewerQuestion, originalQuestion);
});

test("只改标点不算复述——覆盖率的两道真闸门是数量与逐位 id，不是这条", () => {
  const value = story();
  const review = reviewFor(value);
  const original = value.sceneScript[0].dramaticFunction;
  // 实测 MiMo 会把「关键选择，打破…」回显成「关键选择：打破…」，那不构成任何歧义
  review.sceneFunctionChecks[0].declaredFunction = `${original.replace(/，/gu, "：")}并主动帮忙`;
  assert.doesNotThrow(() => ensureStoryQualityReviewCoversStory(review, value));
  assert.equal(review.sceneFunctionChecks[0].declaredFunction, original);
});

test("漏掉留存设计、或 index 错位都明确失败", () => {
  const value = story();

  const short = reviewFor(value);
  short.retentionChecks = [];
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(short, value))
    .includes("STORY_REVIEW_RETENTION_COVERAGE_INCOMPLETE"));

  const misindexed = reviewFor(value);
  misindexed.retentionChecks[0].index = 5;
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(misindexed, value))
    .includes("STORY_REVIEW_RETENTION_INDEX_MISMATCH"));
});

test("引用剧情里不存在的场次被抓住", () => {
  const value = story();

  const badIssue = reviewFor(value);
  badIssue.issues = [{
    severity: "BLOCKER", type: "declarationGap", sceneIds: ["S99"],
    evidence: "e", problem: "p", recommendedFix: "f"
  }];
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(badIssue, value))
    .includes("STORY_REVIEW_UNKNOWN_SCENE_ID"));

  const badShown = reviewFor(value);
  badShown.retentionChecks[0].shownInScenes = ["S99"];
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(badShown, value))
    .includes("STORY_REVIEW_UNKNOWN_SCENE_ID"));
});

test("没有留存设计的剧情，空 retentionChecks 是正确值", () => {
  const value = story();
  value.retentionPlan = [];
  const review = reviewFor(value);
  assert.deepEqual(review.retentionChecks, []);
  assert.doesNotThrow(() => ensureStoryQualityReviewCoversStory(review, value));
});

// ---- 提示词 ----

test("提示词写死本次的逐条数量与逐字回显纪律", () => {
  const value = story();
  const prompt = storyQualityReviewPrompt(value);
  assert.match(prompt, new RegExp(`恰好 ${value.sceneScript.length} 项`, "u"));
  assert.match(prompt, new RegExp(`共 ${value.retentionPlan.length} 条`, "u"));
  assert.match(prompt, /逐字照抄/u);
  assert.match(prompt, /也不要在后面追加你自己的注解/u);
  assert.match(prompt, /声明不等于呈现/u);
  // 只有可见事实字段算数：拍摄说明与叙事目标都不能当依据
  assert.match(prompt, /shotAndSound、shootingNotes、beatSheet 都不算/u);
});

test("没有留存设计时提示词给出空数组指引，不要求凭空编造", () => {
  const value = story();
  value.retentionPlan = [];
  assert.match(storyQualityReviewPrompt(value), /本片没有，给空数组/u);
});

// ---- 阶段 ----

test("demo 模式产出可用报告，但不伪造任何质量判断", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: {} });
  const value = story();
  const review = await workflow.createStoryQualityReview({ fullStory: value });

  assert.equal(review.sceneFunctionChecks.length, value.sceneScript.length);
  assert.equal(review.retentionChecks.length, value.retentionPlan.length);
  assert.deepEqual(review.issues, []);
  // mock 不得假装做过核对——与「demo mock 不得伪造语义审计结果」同规格
  assert.match(review.summary, /未调用模型/u);
});

test("体检对象必须先是一份合法剧情", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: {} });
  const broken = story();
  broken.sceneScript = [];
  await assert.rejects(() => workflow.createStoryQualityReview({ fullStory: broken }), OutputContractError);
});

// ---- 可比对数字 ----
//
// 不问模型要总分：实测 13 份的模型综合分挤在 7.8–8.3、中位 8.2，分辨率太低。
// 这几个数是从逐条判定里数出来的，跨故事直接可比，也不需要任何评分刻度。

test("未兑现计数与硬伤计数都从逐条判定里数出来", () => {
  const value = story();
  const review = reviewFor(value);
  review.sceneFunctionChecks[0].verdict = "not_depicted";
  review.sceneFunctionChecks[1].verdict = "partially_depicted";
  review.retentionChecks[0].verdict = "not_depicted";
  review.issues = [
    { severity: "BLOCKER", type: "a", sceneIds: [], evidence: "e", problem: "p", recommendedFix: "f" },
    { severity: "MINOR", type: "b", sceneIds: [], evidence: "e", problem: "p", recommendedFix: "f" }
  ];

  const metrics = storyReviewMetrics(review);
  assert.equal(metrics.sceneFunctions.notDepicted, 1);
  assert.equal(metrics.sceneFunctions.partial, 1);
  assert.equal(metrics.sceneFunctions.unmet, 2);
  assert.equal(metrics.retention.unmet, 1);
  assert.equal(metrics.declarationsUnmet, 3);
  assert.equal(metrics.declarationsChecked, value.sceneScript.length + value.retentionPlan.length);
  assert.equal(metrics.blocker, 1);
  assert.equal(metrics.major, 0);
  assert.equal(metrics.minor, 1);

  const headline = storyReviewHeadline(review);
  assert.match(headline, /声明未兑现 3\/9/u);
  assert.match(headline, /1 严重/u);
  assert.match(headline, /1 小问题/u);
});

test("全部兑现且无硬伤时摘要说得明确", () => {
  const review = reviewFor(story());
  const headline = storyReviewHeadline(review);
  assert.match(headline, /声明未兑现 0\//u);
  assert.match(headline, /未发现硬伤/u);
});

test("空评审不抛错，返回 null 摘要为空串", () => {
  assert.equal(storyReviewMetrics(null), null);
  assert.equal(storyReviewHeadline(null), "");
});
