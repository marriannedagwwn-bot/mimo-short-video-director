import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkflowService } from "../src/workflow.js";
import { mockAnimationPlanReview } from "../src/mock.js";
import { animationPlanReviewPrompt } from "../src/prompts.js";
import { ensureOutputContract, OutputContractError } from "../src/validation.js";
import { ensureReviewReportContract, ensureRevisionContract } from "../src/animation-plan-review-validation.js";

// 用真实生产包做夹具：mock 必须按传入 Plan 的实际 shotPlan 生成三张表，
// 拿一份合成的小 Plan 测不出「覆盖表与 shotPlan 逐位同序」这条。
function samplePlan(shotCount = 3) {
  const shotPlan = Array.from({ length: shotCount }, (_, index) => ({
    shotId: `A${String(index + 1).padStart(2, "0")}`,
    sourceSceneId: `S${index + 1}`,
    sceneId: index < 2 ? "LOC01" : "LOC02",
    durationSeconds: 10,
    storyPurpose: `第 ${index + 1} 镜的目的`,
    emotionalTarget: "平静",
    videoPrompt: `第 ${index + 1} 镜的画面`,
    cameraMotion: "中景固定",
    characterAction: "主角站着",
    dialogueOrSubtitle: "无",
    soundDesign: "环境音",
    continuityNotes: "承接上一镜",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["画面完整"]
  }));
  return {
    shotPlan,
    sceneReferencePrompts: [
      { sceneId: "LOC01", locationName: "屋内" },
      { sceneId: "LOC02", locationName: "院子" }
    ]
  };
}

test("demo mock 的终审报告能通过与 live 完全相同的校验链", () => {
  const plan = samplePlan(4);
  const report = mockAnimationPlanReview(plan);
  // 与 workflow 里 validate 的调用顺序逐字一致：先 schema，再语义
  const validated = ensureReviewReportContract(
    ensureOutputContract(report, "animationPlanReview"),
    plan
  );
  assert.equal(validated.shotEvaluations.length, 4);
  assert.equal(validated.sceneCheck.length, 4);
  assert.equal(validated.dimensions.length, 12);
  // mock 不得伪造质量判断
  assert.equal(validated.overallScore, 0);
});

test("mock 的三张覆盖表与传入 Plan 的 shotId 逐位相同", () => {
  const plan = samplePlan(6);
  const report = mockAnimationPlanReview(plan);
  const ids = plan.shotPlan.map((shot) => shot.shotId);
  assert.deepEqual(report.shotEvaluations.map((entry) => entry.shotId), ids);
  assert.deepEqual(report.sceneCheck.map((entry) => entry.shotId), ids);
});

test("缺少必要顶层字段被拒", () => {
  const plan = samplePlan();
  for (const field of ["dominantDefect", "shotEvaluations", "sceneCheck", "revisionBrief"]) {
    const broken = { ...mockAnimationPlanReview(plan) };
    delete broken[field];
    assert.throws(
      () => ensureOutputContract(broken, "animationPlanReview"),
      OutputContractError,
      `缺 ${field} 应当被拒`
    );
  }
});

test("dominantDefect.type 不在清单内被拒", () => {
  const plan = samplePlan();
  const broken = mockAnimationPlanReview(plan);
  broken.dominantDefect.type = "凭空编一个类型";
  assert.throws(() => ensureOutputContract(broken, "animationPlanReview"), OutputContractError);
});

test("覆盖表漏一镜或引用不存在的镜头号被拒", () => {
  const plan = samplePlan(4);

  const missing = mockAnimationPlanReview(plan);
  missing.shotEvaluations.pop();
  assert.throws(() => ensureReviewReportContract(missing, plan), /条数|不一致/u);

  const unknown = mockAnimationPlanReview(plan);
  unknown.shotEvaluations[0].shotId = "A99";
  assert.throws(() => ensureReviewReportContract(unknown, plan), /A99|不存在|不一致|同序/u);
});

test("道具的两个状态标记不得同时为真", () => {
  const plan = samplePlan();
  const report = mockAnimationPlanReview(plan);
  report.propTracking = [{
    prop: "一把伞",
    firstAppears: "A01",
    trace: [{ shotId: "A01", state: "拿在手里" }],
    disappeared: true,
    positionUnclear: true
  }];
  // 彻底消失就只标 disappeared，两个都为真是自相矛盾的判定
  assert.throws(() => ensureReviewReportContract(report, plan), /互斥|同时/u);
});

test("修订结果不得改动服务端签发字段", () => {
  const plan = samplePlan(3);
  const report = mockAnimationPlanReview(plan);
  const revision = {
    revisedShots: [{
      shotId: "A01",
      videoPrompt: "改过的画面",
      cameraMotion: "中景固定",
      characterAction: "主角坐下",
      dialogueOrSubtitle: "无",
      soundDesign: "环境音",
      continuityNotes: "承接",
      acceptanceCriteria: ["画面完整"],
      removedActions: ["主角站着"],
      addedActions: ["主角坐下"],
      changeSummary: "站改坐",
      durationSeconds: 99
    }]
  };
  assert.throws(() => ensureRevisionContract(revision, plan, report), /durationSeconds|签发/u);
});

test("受约束镜头净增动作被拦，未受约束的不拦", () => {
  const plan = samplePlan(3);
  const report = mockAnimationPlanReview(plan);
  // 把 A01 判为节奏有风险，使它进入受约束名单
  report.issues = [{
    issueId: "P1",
    severity: "MAJOR",
    category: "pacing",
    evidencePaths: ["shotPlan[A01].videoPrompt"],
    problem: "A01 动作过密",
    revisionIntent: "减负",
    affectedPaths: ["shotPlan[A01]"]
  }];
  const netAdd = (shotId) => ({
    revisedShots: [{
      shotId,
      videoPrompt: "改过的画面",
      cameraMotion: "中景固定",
      characterAction: "主角坐下",
      dialogueOrSubtitle: "无",
      soundDesign: "环境音",
      continuityNotes: "承接",
      acceptanceCriteria: ["画面完整"],
      removedActions: [],
      addedActions: ["新动作一", "新动作二"],
      changeSummary: "净增两个"
    }]
  });
  // 判定权在服务端：只数数组长度，不听模型自述
  assert.throws(() => ensureRevisionContract(netAdd("A01"), plan, report), /删除|净增|不少于/u);
  assert.doesNotThrow(() => ensureRevisionContract(netAdd("A03"), plan, report));
});

test("真实报告回放：新 schema 不误伤实际模型输出", (t) => {
  // 这份是 v4 提示词在真实调用中产出的报告，带 dominantDefect 与新的道具双标记。
  // 夹具不在仓库里时跳过，不让本地缺文件变成红灯。
  const fixture = "C:/Users/QinFeng/Downloads/雨天的流浪猫窝-评审报告-新提示词.json";
  const pkgPath = "C:/Users/QinFeng/Downloads/雨天的流浪猫窝.json";
  if (!fs.existsSync(fixture) || !fs.existsSync(pkgPath)) {
    t.skip("真实报告夹具不存在，跳过");
    return;
  }
  const report = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const plan = JSON.parse(fs.readFileSync(pkgPath, "utf8")).animationPlan;
  assert.doesNotThrow(() => ensureReviewReportContract(
    ensureOutputContract(report, "animationPlanReview"),
    plan
  ));
  assert.equal(report.dominantDefect.type, "identity_logic");
});

test("demo 模式下 workflow 走 mock 且不调用任何 provider", async (t) => {
  const pkgPath = "C:/Users/QinFeng/Downloads/雨天的流浪猫窝.json";
  if (!fs.existsSync(pkgPath)) {
    t.skip("生产包夹具不存在，跳过");
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  // hasLiveClient 为 false 时必须返回 mock，绝不发起网络调用
  const report = await workflow.createAnimationPlanReview({
    animationPlan: pkg.animationPlan,
    fullStory: pkg.fullStory
  });
  assert.equal(report.schemaVersion, "animation-plan-review/4.0");
  assert.equal(report.shotEvaluations.length, pkg.animationPlan.shotPlan.length);
});

test("代码里的提示词正文与文档逐字一致", () => {
  // 提示词有两份：src/animation-plan-review-prompt.md 是运行时读取的事实源，
  // docs/animation-plan-review-prompt.md 供人类阅读与迭代。两份内容必须一致，
  // 否则会出现「文档上讨论过的规则其实没生效」这种最难查的偏差。
  const runtime = fs.readFileSync(new URL("../src/animation-plan-review-prompt.md", import.meta.url), "utf8")
    .replace(/^<!--[\s\S]*?-->\s*/u, "").trim();
  const doc = fs.readFileSync(new URL("../docs/animation-plan-review-prompt.md", import.meta.url), "utf8");
  const start = doc.indexOf("## 提示词正文（从这里开始复制）");
  const end = doc.indexOf("**提示词正文到此结束");
  assert.ok(start >= 0 && end > start, "文档里的提示词正文区段标记必须存在");
  const docBody = doc.slice(doc.indexOf("\n", start) + 1, end).trim();
  assert.equal(runtime, docBody, "运行时正文与文档正文出现漂移，改了一边必须同步另一边");
});

test("提示词把剧情与分镜都注入，且保留三条不可省的规则", () => {
  const plan = { shotPlan: [{ shotId: "A01", videoPrompt: "占位" }], sceneReferencePrompts: [] };
  const story = { title: "某个用于断言注入的标题", sceneScript: [] };
  const prompt = animationPlanReviewPrompt(story, plan);

  // 评审必须同时看到两份——只给分镜就发现不了「剧情写了、镜头没拍」
  assert.match(prompt, /某个用于断言注入的标题/u);
  assert.match(prompt, /A01/u);

  // 这三条是多轮实测换来的，删掉任何一条都会让评审退回到旧版的失效状态
  assert.match(prompt, /第零块/u, "dominantDefect 是防止修错问题类型的唯一机制");
  assert.match(prompt, /硬逻辑 > 因果 > 连续性/u, "修复优先级规则不能省");
  assert.match(prompt, /不要在报告里寻找或提及这些具体内容/u, "示例区隔离声明防止跨片污染");
});
