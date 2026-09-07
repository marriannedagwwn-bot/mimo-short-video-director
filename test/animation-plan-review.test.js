import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FullModelOutputLogWriter, MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { WorkflowService } from "../src/workflow.js";
import { mockAnimationPlanReview } from "../src/mock.js";
import { animationPlanReviewPrompt } from "../src/prompts.js";
import { ensureOutputContract, OutputContractError } from "../src/validation.js";
import { ensureReviewReportContract, ensureRevisionContract, revisionShotLoad } from "../src/animation-plan-review-validation.js";

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

// 2026-09-07 线上故障：模型把镜头级 issues 按顶层 issues 的对象结构填了，
// 报错逐字为 /shotEvaluations/{0,2,4,5}/issues/0 类型必须为 string。
// 根因是提示词的输出模板里 issues 出现两次、形状不同，而镜头级只给了 []，
// 元素类型全文没有任何示例——模型有问题要写时只能去抄最近的同名字段。
// 失败模式印证这是一贯误读：判定有问题的镜头全部在 issues/0 失败，写 [] 的全过。
test("镜头级 issues 只收字符串，写成顶层 issue 的对象结构必须被拒", () => {
  const plan = samplePlan(6);
  const base = mockAnimationPlanReview(plan);

  const bad = structuredClone(base);
  for (const index of [0, 2, 4, 5]) {
    bad.shotEvaluations[index].issues = [{
      issueId: "I1",
      severity: "MAJOR",
      category: "unrealized_declaration",
      evidencePaths: [],
      problem: "声明未兑现",
      revisionIntent: "补画面",
      affectedPaths: [],
      mustPreserve: []
    }];
  }
  let error = null;
  try {
    ensureOutputContract(bad, "animationPlanReview");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof OutputContractError, "对象形状必须被 schema 拒绝");
  // 与线上那条报错逐字相同，连镜头下标都一样。
  assert.equal(
    error.details.map((detail) => `${detail.path} ${detail.reason}`).join("；"),
    "/shotEvaluations/0/issues/0 类型必须为 string；/shotEvaluations/2/issues/0 类型必须为 string；"
    + "/shotEvaluations/4/issues/0 类型必须为 string；/shotEvaluations/5/issues/0 类型必须为 string"
  );

  // 正确形状：一句话字符串。
  const good = structuredClone(base);
  for (const index of [0, 2, 4, 5]) {
    good.shotEvaluations[index].issues = ["台词没有逐字写进 videoPrompt"];
  }
  assert.equal(ensureOutputContract(good, "animationPlanReview"), good);
});

// 2026-09-07 实测：模型给两条「猫从蹲姿到后腿站立缺少中间态」的硬伤写了
// category=continuity，被枚举拒。它不是瞎编——continuity 同时是评分维度（9% 权重）
// 和 dominantDefect 的合法类型，提示词里明写了两次，唯独不在 issues 的可选项里。
// 报告能给连续性打分、能把它定为主要缺陷，却不能就它立一条硬伤，是契约本身的洞：
// 那两条既不是道具（prop_state_break）也不是场景归属（scene_mismatch），无处可去。
test("continuity 是合法的 issue category，跨镜连续性问题有归属", () => {
  const plan = samplePlan(3);
  const report = mockAnimationPlanReview(plan);
  report.issues = [{
    issueId: "C1",
    severity: "MAJOR",
    category: "continuity",
    evidencePaths: ["shotPlan[A02].videoPrompt"],
    problem: "A02 中角色从蹲姿到站立缺少中间状态",
    revisionIntent: "补一个可见的过渡动作",
    affectedPaths: ["shotPlan[A02]"]
  }];
  assert.equal(ensureOutputContract(report, "animationPlanReview"), report);

  // dominantDefect 专属的取值仍然不是合法 category——三张表没有被合并。
  const borrowed = structuredClone(report);
  borrowed.issues[0].category = "visual_readability";
  assert.throws(() => ensureOutputContract(borrowed, "animationPlanReview"), OutputContractError);
});

// continuity 归到「要求加内容」那一侧：连续性问题要补过渡状态，不是减负。
// 减负只由 pacing / ai_risk 触发，这条不能因为新增枚举值而漂移。
test("continuity issue 计入加内容侧，不触发减负", () => {
  const plan = samplePlan(3);
  const report = mockAnimationPlanReview(plan);
  report.issues = [{
    issueId: "C1", severity: "MAJOR", category: "continuity",
    evidencePaths: ["shotPlan[A02].videoPrompt"],
    problem: "A02 缺少过渡", revisionIntent: "补过渡",
    affectedPaths: ["shotPlan[A02]"]
  }];
  const load = revisionShotLoad(report, plan.shotPlan.map((s) => s.shotId));
  assert.deepEqual(load.get("A02").increase, ["C1"]);
  assert.deepEqual(load.get("A02").decrease, []);
  assert.equal(load.get("A02").constrained, false);
});

// 提示词必须同时给出非空示例**和**点名那处同名碰撞。只给示例不够——
// 模型已经证明它会去抄最近的同名字段，所以要明说那是另一个字段。
// 两份正文的一致由下面「代码里的提示词正文与文档逐字一致」守住。
test("提示词写明镜头级 issues 是字符串数组，且不得套用第二块的对象结构", () => {
  const text = animationPlanReviewPrompt(
    { sceneScript: [] },
    { shotPlan: [{ shotId: "A01", videoPrompt: "占位" }], sceneReferencePrompts: [] }
  );
  assert.match(text, /"issues": \["每条一句话，纯字符串，不是对象；没有问题写 \[\]"\]/u);
  assert.match(text, /这里的 `issues` \*\*每一项都是一句话字符串，不是对象\*\*/u);
  assert.match(text, /\*\*不要套用下面第二块 `issues` 的对象结构，那是另一个字段\*\*/u);
  assert.match(text, /镜头级只收字符串，结构化的 `issueId` \/ `severity` \/ `category` 只属于第二块/u);
});

// mock 全部写 [] 正是这个缺陷能溜过去的原因：非空分支从来没被构造过，
// 于是 demo 通过、live 失败。改回全 [] 必须有测试报警。
test("mock 覆盖镜头级 issues 的非空分支，两个分支都走到", () => {
  const report = mockAnimationPlanReview(samplePlan(4));
  assert.deepEqual(
    report.shotEvaluations.map((entry) => entry.issues.length),
    [1, 0, 0, 0]
  );
  assert.equal(typeof report.shotEvaluations[0].issues[0], "string");
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

test("净增动作被拦，且不限于被判过 pacing 的镜头", () => {
  const plan = samplePlan(3);
  const report = mockAnimationPlanReview(plan);
  // A01 被判为节奏有风险；A03 没有被点名。删≥加对两者都成立。
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
  // 2026-09-06 收紧：净增对**每一个被修订的镜头**都拦。只约束受判镜头时，实测在真实
  // 数据上等于没有闸门——一份真实修订输出里 A03 删 0 加 1、A07 删 3 加 4、A08 删 0 加 1
  // 全部畅通，而这三镜的报告条目恰恰全是「要求加内容」，旧规则一个都拦不住。
  assert.throws(() => ensureRevisionContract(netAdd("A03"), plan, report), /先替换后新增/u);
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

// 2026-09-07：终审、剧情体检、定向修订都是 2026-09-04 之后新增的阶段，
// 三个都漏了注册 writer，于是这次终审失败时模型原文永久丢失、只能靠反推根因。
// 前两个走 generateStageJson，注册 scope 即生效；修订走 modelCallCoordinator，
// 由 workflow 自己接 attemptObserver，是唯一需要改代码的一个。
async function readStageRecords(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "metadata.json") {
        const metadata = JSON.parse(await fsp.readFile(full, "utf8"));
        out.push({
          metadata,
          content: metadata.output.present
            ? await fsp.readFile(path.join(path.dirname(full), "model-output.txt"), "utf8")
            : ""
        });
      }
    }
  };
  await walk(root);
  return out;
}

function stageWriters(scope, outputRoot) {
  return new Map([[scope, new FullModelOutputLogWriter({ scope, outputRoot })]]);
}

test("终审校验失败时把模型原文与错误码写进阶段侧车", async (t) => {
  const pkgPath = "C:/Users/QinFeng/Downloads/雨天的流浪猫窝.json";
  if (!fs.existsSync(pkgPath)) {
    t.skip("生产包夹具不存在，跳过");
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-sidecar-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // 复刻本次线上故障：镜头级 issues 写成顶层 issue 的对象结构。
  const invalid = mockAnimationPlanReview(pkg.animationPlan);
  invalid.shotEvaluations[0].issues = [{ issueId: "I1", severity: "MAJOR" }];
  const rawContent = JSON.stringify(invalid);

  const workflow = new WorkflowService({
    client: {
      async generateJson({ onCompletion }) {
        await onCompletion({
          content: rawContent, raw: rawContent, finishReason: "stop",
          requestId: "provider-req-review", usage: null
        });
        return invalid;
      }
    },
    // 这三个阶段在 normalizeStageDefaults 里没有内置项，产线由 server.js 显式传入
    // （buildStageDefaults 那三条），测试照做，否则 resolveStage 拿不到 provider。
    stageDefaults: { animationPlanReview: { provider: "MiMo", model: "test-model" } },
    stageModelOutputLogWriters: stageWriters(MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVIEW, root)
  });

  await assert.rejects(
    () => workflow.createAnimationPlanReview({
      animationPlan: pkg.animationPlan,
      fullStory: pkg.fullStory
    }),
    OutputContractError
  );

  const records = await readStageRecords(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.scope, "animationPlanReview");
  assert.equal(records[0].metadata.attempt.stage, "animationPlanReview");
  assert.equal(records[0].metadata.attempt.status, "failed");
  assert.equal(records[0].metadata.attempt.code, "OUTPUT_CONTRACT_INVALID");
  assert.equal(records[0].metadata.provider.providerRequestId, "provider-req-review");
  // 原文必须留下来——这正是本次查不到根因的那一样东西。
  assert.equal(records[0].content, rawContent);
});

test("定向修订的两次 provider 调用各留一条侧车记录", async (t) => {
  const pkgPath = "C:/Users/QinFeng/Downloads/雨天的流浪猫窝.json";
  if (!fs.existsSync(pkgPath)) {
    t.skip("生产包夹具不存在，跳过");
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "revision-sidecar-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const targetShotId = String(pkg.animationPlan.shotPlan[0].shotId);
  const report = mockAnimationPlanReview(pkg.animationPlan);
  report.issues = [{
    issueId: "P1", severity: "MAJOR", category: "pacing",
    evidencePaths: [`shotPlan[${targetShotId}].videoPrompt`],
    problem: `${targetShotId} 动作过密`, revisionIntent: "减负",
    affectedPaths: [`shotPlan[${targetShotId}]`]
  }];

  // 两次都净增，两次都被拦——第一次被拦是常规路径，正因如此两次原文都必须留下。
  const netAdd = {
    revisedShots: [{
      shotId: targetShotId,
      videoPrompt: "改过的画面", cameraMotion: "中景固定", characterAction: "主角坐下",
      dialogueOrSubtitle: "无", soundDesign: "环境音", continuityNotes: "承接",
      acceptanceCriteria: ["画面完整"],
      removedActions: [], addedActions: ["新动作一", "新动作二"],
      changeSummary: "净增两个"
    }]
  };
  let calls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        calls += 1;
        return netAdd;
      }
    },
    stageDefaults: { animationPlanRevision: { provider: "MiMo", model: "test-model" } },
    stageModelOutputLogWriters: stageWriters(MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVISION, root)
  });

  await assert.rejects(() => workflow.createAnimationPlanRevision({
    animationPlan: pkg.animationPlan,
    report
  }));
  assert.equal(calls, 2, "净增被拦后应重试一次，共两次 provider 调用");

  const records = (await readStageRecords(root))
    .sort((a, b) => a.metadata.attempt.callIndex - b.metadata.attempt.callIndex);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.metadata.attempt.callIndex), [0, 1]);
  assert.deepEqual(records.map((r) => r.metadata.attempt.reason), ["primary", "coordinator-retry"]);
  for (const record of records) {
    assert.equal(record.metadata.scope, "animationPlanRevision");
    assert.equal(record.content, JSON.stringify(netAdd));
  }
});

test("不配置 STAGE_MODEL_OUTPUT_LOG_DIR 时三个新阶段完全不写", () => {
  for (const scope of [
    MODEL_OUTPUT_LOG_SCOPES.STORY_QUALITY_REVIEW,
    MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVIEW,
    MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN_REVISION
  ]) {
    assert.equal(new FullModelOutputLogWriter({ scope, outputRoot: "" }).enabled, false);
  }
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
