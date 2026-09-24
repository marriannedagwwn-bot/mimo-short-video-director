import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkflowService } from "../src/workflow.js";
import { mockAnimationPlanRevision, mockAnimationPlanReview } from "../src/mock.js";
import { animationPlanRevisionPrompt, animationPlanRevisionRepairPrompt } from "../src/prompts.js";
import { InputError } from "../src/validation.js";
import { ensureRevisionContract, revisionShotLoad, revisionTargetShotIds } from "../src/animation-plan-review-validation.js";

// 合成 direct_shot Plan。用合成夹具而不是真实生产包，是为了让「受约束镜头净增被拦」
// 这类断言在任何机器上都能跑；真实包的回放另有一条测试守着。
function directShotPlan(shotCount = 3) {
  const shotPlan = Array.from({ length: shotCount }, (_, index) => ({
    shotId: `A${String(index + 1).padStart(2, "0")}`,
    sourceSceneId: `S${index + 1}`,
    sceneId: index < 2 ? "LOC01" : "LOC02",
    durationSeconds: 10,
    storyPurpose: `第 ${index + 1} 镜的目的`,
    emotionalTarget: "平静",
    videoPrompt: `第 ${index + 1} 镜的完整中文提示词，画面里她走进院子。`,
    cameraMotion: "中景固定",
    characterAction: "她走进院子。她蹲下。",
    dialogueOrSubtitle: "无",
    soundDesign: "环境音",
    continuityNotes: "承接上一镜",
    // 负面提示词条目要求完整的证据绑定结构，本组测试用不到，留空数组即可
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["画面完整"]
  }));
  return {
    promptSchemaVersion: "3.0",
    selectedVariantId: "V1",
    title: "测试片",
    productionStrategy: {
      format: "direct_shot_video",
      targetAspectRatio: "16:9",
      targetRuntimeSeconds: shotCount * 10
    },
    visualBible: { overallStyle: "日系", colorPalette: "暖色", lighting: "柔光" },
    characterReferencePrompts: [{ characterName: "小白子", appearancePrompt: "短发女孩" }],
    sceneReferencePrompts: [
      { sceneId: "LOC01", locationName: "屋内" },
      { sceneId: "LOC02", locationName: "院子" }
    ],
    assetPrompts: [],
    shotPlan,
    editPlan: { sequenceRhythm: "平稳" },
    generationChecklist: [{ check: "画面", passCriteria: "完整" }],
    modelAgnosticNotes: ["无"],
    continuityAndSafetyCheck: { note: "已检查" },
    uncertainties: []
  };
}

// 报告必须能通过 ensureReviewReportContract（三张覆盖表逐位同序），所以从 mock 起手，
// 再把要用的 issue / upgrade 填进去。
function reportFor(plan, { issues = [], upgrades = [], priorityIssueIds, priorityUpgradeIds } = {}) {
  const report = mockAnimationPlanReview(plan);
  report.issues = issues;
  report.upgradePath = upgrades;
  report.revisionBrief.priorityIssueIds = priorityIssueIds ?? issues.map((item) => item.issueId);
  report.revisionBrief.priorityUpgradeIds = priorityUpgradeIds ?? upgrades.map((item) => item.upgradeId);
  return report;
}

function pacingIssue(shotId, issueId = "ISSUE-001") {
  return {
    issueId,
    severity: "MAJOR",
    category: "pacing",
    evidencePaths: [`shotPlan[${shotId}].videoPrompt`],
    affectedPaths: [`shotPlan[${shotId}]`],
    problem: `${shotId} 动作过密`,
    revisionIntent: "减负"
  };
}

function upgradeFor(shotId, upgradeId = "UPG-001") {
  return {
    upgradeId,
    principle: "配角主动",
    currentState: "只是看着",
    concreteChange: "长辈替主角别碎发",
    netActionBudget: "只准替换",
    affectedPaths: [`shotPlan[${shotId}]`]
  };
}

// 合法的一条修订行：逐字沿用原镜头，只调整台账。
function revisedRow(plan, shotId, overrides = {}) {
  const shot = plan.shotPlan.find((item) => item.shotId === shotId);
  return {
    shotId,
    videoPrompt: shot.videoPrompt,
    cameraMotion: shot.cameraMotion,
    characterAction: shot.characterAction,
    dialogueOrSubtitle: shot.dialogueOrSubtitle,
    soundDesign: shot.soundDesign,
    continuityNotes: shot.continuityNotes,
    acceptanceCriteria: [...shot.acceptanceCriteria],
    removedActions: [],
    addedActions: [],
    changeSummary: "占位",
    ...overrides
  };
}

function liveWorkflow(responses) {
  const prompts = [];
  const client = {
    async generateJson({ prompt, requestTimeoutMs }) {
      prompts.push({ prompt, requestTimeoutMs });
      const next = responses[prompts.length - 1];
      if (!next) throw new Error(`第 ${prompts.length} 次调用没有预置响应——预算被超用了`);
      if (typeof next === "function") return next(prompt);
      return next;
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: client },
    stageDefaults: {
      animationPlanRevision: {
        provider: "Qwen",
        model: "test-model",
        maxCompletionTokens: 8192,
        requestTimeoutMs: 1800000
      }
    }
  });
  return { workflow, prompts };
}

test("demo 修订逐字回显原镜头，合并结果与源 Plan 逐字节相同", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const outcome = await workflow.createAnimationPlanRevision({ animationPlan: plan, report });

  assert.deepEqual(outcome.revision.revisedShots.map((row) => row.shotId), ["A01"]);
  // demo 不调用模型，就不能伪造改动——合并结果必须与源 Plan 完全一致
  assert.equal(JSON.stringify(outcome.animationPlan), JSON.stringify(plan));
  assert.equal(outcome.metadata.animationPlanRevision.providerCalls, 1);
});

test("mock 修订能通过与 live 完全相同的校验链", () => {
  const plan = directShotPlan(4);
  const report = reportFor(plan, { issues: [pacingIssue("A02")] });
  const revision = mockAnimationPlanRevision(plan, report, ["A02"]);
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  assert.doesNotThrow(() => workflow.finalizeAnimationPlanRevision({
    revision, animationPlan: plan, report, targetShotIds: ["A02"]
  }));
});

test("旧 v2 首尾帧 Plan 不得走定向修订", async () => {
  const plan = directShotPlan(2);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  delete plan.promptSchemaVersion;
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    (error) => error instanceof InputError && /direct_shot/u.test(error.message)
  );
});

test("选中不存在的条目明确失败，不静默忽略", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({
      animationPlan: plan, report, selectedIssueIds: ["ISSUE-001", "ISSUE-404"]
    }),
    (error) => error instanceof InputError && /ISSUE-404/u.test(error.message)
  );
});

test("没有任何条目指向真实镜头时明确失败", async () => {
  const plan = directShotPlan(3);
  const orphan = { ...pacingIssue("A01"), evidencePaths: [], affectedPaths: [], problem: "说不清哪一镜" };
  const report = reportFor(plan, { issues: [orphan] });
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    (error) => error instanceof InputError && /没有指向任何存在的镜头/u.test(error.message)
  );
});

test("净预算判定：提示词与校验器共用同一份 revisionShotLoad", () => {
  const plan = directShotPlan(3);
  const shotIds = plan.shotPlan.map((shot) => shot.shotId);
  const report = reportFor(plan, { issues: [pacingIssue("A01")], upgrades: [upgradeFor("A01")] });
  const load = revisionShotLoad(report, shotIds);

  // A01 同时被要求减负与加内容——这就是那次事故的形状，必须被识别为冲突
  assert.deepEqual(load.get("A01").decrease, ["ISSUE-001"]);
  assert.deepEqual(load.get("A01").increase, ["UPG-001"]);
  assert.equal(load.get("A01").constrained, true);
  assert.equal(load.has("A02"), false);

  const prompt = animationPlanRevisionPrompt({
    animationPlan: plan, report, issues: report.issues, upgrades: report.upgradePath,
    load, targetShotIds: ["A01"]
  });
  assert.match(prompt, /只准替换，不准净增/u);
  assert.match(prompt, /ISSUE-001/u);
  assert.match(prompt, /UPG-001/u);
});

test("条目没有可解析的结构化路径时才回退到正文里的镜头号", () => {
  const shotIds = ["A01", "A02"];
  // 有结构化路径：正文里顺带提到的 A02 不得被算成受影响镜头
  const withPaths = { ...pacingIssue("A01"), problem: "A01 太密，A02 相比之下正常" };
  assert.deepEqual(revisionTargetShotIds([withPaths], shotIds), ["A01"]);
  // 没有结构化路径：否则这条 issue 完全无法归属，模型收不到任何约束提示
  const withoutPaths = { ...withPaths, evidencePaths: [], affectedPaths: [] };
  assert.deepEqual(revisionTargetShotIds([withoutPaths], shotIds), ["A01", "A02"]);
});

test("受约束镜头第一次净增被拦，带诊断重试一次后通过", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, {
    issues: [pacingIssue("A01")],
    upgrades: [upgradeFor("A03", "UPG-003")]
  });
  const { workflow, prompts } = liveWorkflow([
    // 第一次：A01 净增（删 0 加 2）被拦；A03 已经符合删≥加，不该被要求重做
    {
      revisedShots: [
        revisedRow(plan, "A01", { removedActions: [], addedActions: ["新动作一", "新动作二"] }),
        revisedRow(plan, "A03", { removedActions: ["她蹲下。"], addedActions: ["新动作三"], changeSummary: "A03 一换一" })
      ]
    },
    // 第二次：只重做被拦的 A01
    { revisedShots: [revisedRow(plan, "A01", { removedActions: ["她蹲下。"], addedActions: ["新动作一"] })] }
  ]);

  const outcome = await workflow.createAnimationPlanRevision({ animationPlan: plan, report });

  assert.equal(prompts.length, 2, "预算恰好两次 provider 调用");
  // 重试提示词必须带上服务端数出来的算术诊断，这是模型无从辩解的那部分
  assert.match(prompts[1].prompt, /上一次的分镜修订被服务端的确定性校验拦下了/u);
  assert.match(prompts[1].prompt, /新增 2 个动作但只删除 0 个/u);
  assert.match(prompts[1].prompt, /removedActions 的条目数 >= addedActions 的条目数/u);
  // 只重做被点名的 A01，A03 沿用第一次的输出
  assert.match(prompts[1].prompt, /A01/u);
  assert.doesNotMatch(prompts[1].prompt, /UPG-003/u);

  const rows = new Map(outcome.revision.revisedShots.map((row) => [row.shotId, row]));
  assert.deepEqual([...rows.keys()].sort(), ["A01", "A03"]);
  assert.deepEqual(rows.get("A01").addedActions, ["新动作一"]);
  assert.deepEqual(rows.get("A03").addedActions, ["新动作三"], "未被拦的镜头沿用第一次输出");

  // 服务端拦过一次就必须说出来
  const meta = outcome.metadata.animationPlanRevision;
  assert.equal(meta.providerCalls, 2);
  assert.deepEqual(meta.firstAttemptRejection.redoneShotIds, ["A01"]);
  assert.match(meta.firstAttemptRejection.details[0].code, /REVISION_NET_ACTION_BUDGET_EXCEEDED/u);
});

test("两次都被拦时 fail closed，原 Plan 一个字节都没变", async () => {
  const plan = directShotPlan(3);
  const before = JSON.stringify(plan);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const netAdd = {
    revisedShots: [revisedRow(plan, "A01", { removedActions: [], addedActions: ["一", "二", "三"] })]
  };
  const { workflow, prompts } = liveWorkflow([netAdd, netAdd]);

  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    /净增|删除|不少于/u
  );
  assert.equal(prompts.length, 2, "不得有第三次调用");
  assert.equal(JSON.stringify(plan), before, "失败必须保持原 Plan 不变");
});

test("模型改到未授权的镜头即被拒", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const outOfScope = {
    revisedShots: [revisedRow(plan, "A01"), revisedRow(plan, "A02", { changeSummary: "顺手改的" })]
  };
  const { workflow } = liveWorkflow([outOfScope, outOfScope]);
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    /越界|A02/u
  );
});

test("修订丢掉台词原话时，合并后的 Plan 在采纳之前就被拦下", async () => {
  const plan = directShotPlan(3);
  plan.shotPlan[0].dialogueOrSubtitle = "小白子：今天的雨下得可真大呀。";
  plan.shotPlan[0].videoPrompt = "她站在屋檐下，说「今天的雨下得可真大呀」。";
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  // 模型把台词从 videoPrompt 里改没了——视频模型不会把它说出来
  const dropped = {
    revisedShots: [revisedRow(plan, "A01", {
      videoPrompt: "她站在屋檐下说话。",
      removedActions: ["她蹲下。"],
      addedActions: []
    })]
  };
  const { workflow } = liveWorkflow([dropped, dropped]);
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    /台词原话|DIALOGUE_MISSING/u
  );
});

test("关闭背景音乐时，修订后的提示词必须仍以那句禁配乐句收尾", async () => {
  const plan = directShotPlan(2);
  plan.productionStrategy.backgroundMusicMode = "none";
  const sentence = "全片无背景音乐，只保留现场环境声与动作声。";
  for (const shot of plan.shotPlan) shot.videoPrompt = `${shot.videoPrompt}${sentence}`;
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const stripped = {
    revisedShots: [revisedRow(plan, "A01", {
      videoPrompt: "改写后的提示词，但把禁配乐句丢了。",
      removedActions: ["她蹲下。"],
      addedActions: []
    })]
  };
  const { workflow } = liveWorkflow([stripped, stripped]);
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    /背景音乐|逐字收尾/u
  );
});

test("修订不得改动服务端签发字段，合并只覆盖七个可写字段", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const sealed = {
    revisedShots: [revisedRow(plan, "A01", { durationSeconds: 99, removedActions: [], addedActions: [] })]
  };
  const { workflow } = liveWorkflow([sealed, sealed]);
  await assert.rejects(
    () => workflow.createAnimationPlanRevision({ animationPlan: plan, report }),
    /durationSeconds|签发/u
  );

  // 合法路径：合并后除 videoPrompt 外逐字节不变
  const changed = {
    revisedShots: [revisedRow(plan, "A01", {
      videoPrompt: "改写后的完整中文提示词，她走进院子。",
      removedActions: ["她蹲下。"],
      addedActions: []
    })]
  };
  const ok = liveWorkflow([changed]);
  const outcome = await ok.workflow.createAnimationPlanRevision({ animationPlan: plan, report });
  const merged = outcome.animationPlan;
  assert.equal(merged.shotPlan[0].videoPrompt, "改写后的完整中文提示词，她走进院子。");
  assert.equal(merged.shotPlan[0].durationSeconds, 10);
  assert.equal(merged.shotPlan[0].sceneId, "LOC01");
  assert.equal(merged.shotPlan[0].sourceSceneId, "S1");
  assert.equal(JSON.stringify(merged.shotPlan.slice(1)), JSON.stringify(plan.shotPlan.slice(1)));
});

test("按阶段放宽的 timeout 真的送到了 client", async () => {
  const plan = directShotPlan(2);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const { workflow, prompts } = liveWorkflow([
    { revisedShots: [revisedRow(plan, "A01", { removedActions: ["她蹲下。"], addedActions: [] })] }
  ]);
  await workflow.createAnimationPlanRevision({ animationPlan: plan, report });
  // 配了 1800000 却没传下去的话，这个阶段仍按全局 900000 被掐——配置形同虚设
  assert.equal(prompts[0].requestTimeoutMs, 1800000);
});

test("修订提示词只发分镜，绝不夹带剧情", () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const load = revisionShotLoad(report, plan.shotPlan.map((shot) => shot.shotId));
  const prompt = animationPlanRevisionPrompt({
    animationPlan: plan, report, issues: report.issues, upgrades: [], load, targetShotIds: ["A01"]
  });
  // 只发被点名的镜头
  assert.match(prompt, /A01/u);
  assert.doesNotMatch(prompt, /第 2 镜的完整中文提示词/u);
  // 显式台账那一条是整个设计的支点，不能退回成文字描述
  assert.match(prompt, /removedActions/u);
  assert.match(prompt, /服务端只数这两个数组的长度/u);
  // 执行者约束没有确定性兜底，只能靠提示词，删掉就再没有第二道防线
  assert.match(prompt, /动作的执行者不得改变/u);
});

test("重试提示词带上被拦镜头的原始 characterAction，删除动作只能从中选", () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const load = revisionShotLoad(report, plan.shotPlan.map((shot) => shot.shotId));
  const prompt = animationPlanRevisionRepairPrompt({
    animationPlan: plan,
    previousRevision: { revisedShots: [revisedRow(plan, "A01")] },
    details: [{ code: "REVISION_NET_ACTION_BUDGET_EXCEEDED", path: "/revisedShots/0", reason: "新增 7 个动作但只删除 2 个" }],
    blockedShotIds: ["A01"],
    load
  });
  assert.match(prompt, /新增 7 个动作但只删除 2 个/u);
  assert.match(prompt, /她走进院子。她蹲下。/u);
  assert.match(prompt, /不能编造一个不存在的动作来凑数/u);
});

// 「先预览、确认后签发」是一条已定的范围决定，不是实现细节：它把「作废该变体全部
// 已生成媒体」这个重代价推迟到用户确认那一刻。实测修订第一次输出常常要被打回，
// 自动签发会造成大量无谓的 revision 与媒体作废。
//
// 这条不变量在服务端由构造保证（修订端点根本不碰 ProductionStateStore），在浏览器
// 则取决于「谁调用 commitProductionArtifact」。源码断言比手工点一次可靠——它会一直守着。
test("浏览器侧：只有采纳函数能签发，修订本身绝不写回 Plan", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const bodyOf = (name) => {
    const start = app.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `没有找到 ${name}`);
    const next = app.indexOf("\nasync function ", start + 1);
    const plain = app.indexOf("\nfunction ", start + 1);
    const end = Math.min(...[next, plain].filter((index) => index > 0));
    return app.slice(start, Number.isFinite(end) ? end : app.length);
  };
  const runBody = bodyOf("runAnimationPlanRevision");
  for (const forbidden of ["commitProductionArtifact", "requestProductionArtifact"]) {
    assert.ok(
      !runBody.includes(forbidden),
      `runAnimationPlanRevision 不得调用 ${forbidden}——修订返回后必须先预览，用户确认才签发`
    );
  }
  // 采纳才是唯一的签发点，且必须签发新的 media namespace 才能 stale 旧媒体
  const adoptBody = bodyOf("adoptAnimationPlanRevision");
  assert.match(adoptBody, /commitProductionArtifact/u);
  assert.match(adoptBody, /createMediaNamespace: true/u);
  // 修订是针对当时那份 Plan 算的，中途 Plan 变了必须作废而不是盖上去
  assert.match(adoptBody, /entry\.sourcePlan/u);
});

// 服务端侧的同一条不变量：修订端点只读，不提交任何 Artifact。
test("服务端：修订路由不触碰 production lineage", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const line = server.split(/\r?\n/).find((row) => row.includes('"/api/animation-plan-revision"'));
  assert.ok(line, "没有找到修订路由");
  // 与需要 lineage 的路由（如 /api/generate-shot-video）不同，这里不解析生产媒体上下文
  assert.doesNotMatch(line, /resolveProductionMediaContext|commitArtifact/u);
  assert.match(line, /workflow\.createAnimationPlanRevision\(body\)/u);
});

// 服务端花了几次调用必须如实说出来。
test("传输失败后重试成功时，如实报出两次 provider 调用", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const good = { revisedShots: [revisedRow(plan, "A01", { removedActions: ["她蹲下。"], addedActions: [] })] };
  const { workflow } = liveWorkflow([
    () => { throw new TypeError("fetch failed"); },
    good
  ]);
  const outcome = await workflow.createAnimationPlanRevision({ animationPlan: plan, report });
  // 用「第一次有没有被内容校验拦下」来推断次数会在这里少报一次——供应商确实被调用了两次
  assert.equal(outcome.metadata.animationPlanRevision.providerCalls, 2);
  assert.equal(outcome.metadata.animationPlanRevision.firstAttemptRejection, null,
    "传输失败不是内容被拦，不该记成内容诊断");
});

// 越界诊断点名的恰恰是**不该改**的镜头。把它们当成「待重做镜头」发进重试提示词，
// 等于把它们的原文发过去、请模型接着改。
test("越界被拒后，重试提示词不得把越界镜头当成待重做镜头", async () => {
  const plan = directShotPlan(3);
  const report = reportFor(plan, { issues: [pacingIssue("A01")] });
  const outOfScope = {
    revisedShots: [
      revisedRow(plan, "A01", { removedActions: ["她蹲下。"], addedActions: [] }),
      revisedRow(plan, "A03", { changeSummary: "顺手改的" })
    ]
  };
  const { workflow, prompts } = liveWorkflow([outOfScope, outOfScope]);
  await assert.rejects(() => workflow.createAnimationPlanRevision({ animationPlan: plan, report }));
  assert.equal(prompts.length, 2);
  const retry = prompts[1].prompt;
  const blocked = retry.slice(retry.indexOf("# 被拦镜头的原始 characterAction")).split("# 你上一次的输出")[0];
  assert.match(blocked, /A01/u);
  assert.doesNotMatch(blocked, /A03/u, "A03 从来就不在授权范围内，不该出现在待重做清单里");
});

// 真实数据回放：这是 2026-09-06 手工跑修订时模型的**实际输出**，也是把净预算收紧为
// 全局默认的直接依据。旧规则（只约束被判过 pacing / ai_risk 的镜头）在这份数据上
// 一条都拦不住——A03 删 0 加 1、A07 删 3 加 4、A08 删 0 加 1 全部净增而畅通，
// 而这三镜的报告条目**恰恰全是「要求加内容」**，所以「只在没被要求加内容时才约束」
// 那种写法同样一个都拦不住，必须是无例外的全局默认。
//
// A07 就是外部评审指出的手部逻辑那一镜（单臂抱猫却双手递猫粮）。
// 夹具不在仓库里时跳过，不让本地缺文件变成红灯。
test("真实修订输出回放：三处净增全部被拦", (t) => {
  const paths = {
    pkg: "C:/Users/QinFeng/Downloads/雨天的流浪猫窝.json",
    report: "C:/Users/QinFeng/Downloads/雨天的流浪猫窝-评审报告-新提示词.json",
    revision: "C:/Users/QinFeng/Downloads/雨天的流浪猫窝-修订输出.json"
  };
  if (!Object.values(paths).every((path) => fs.existsSync(path))) {
    t.skip("真实修订夹具不存在，跳过");
    return;
  }
  const plan = JSON.parse(fs.readFileSync(paths.pkg, "utf8")).animationPlan;
  const report = JSON.parse(fs.readFileSync(paths.report, "utf8"));
  const revision = JSON.parse(fs.readFileSync(paths.revision, "utf8"));

  let error = null;
  try {
    ensureRevisionContract(revision, plan, report);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "这份真实修订输出必须被拦下");
  const blocked = error.details
    .filter((detail) => detail.code === "REVISION_NET_ACTION_BUDGET_EXCEEDED")
    .map((detail) => detail.reason.slice(0, 3).trim());
  assert.deepEqual(blocked, ["A03", "A07", "A08"]);

  // 这三镜没有一个被判过 pacing / ai_risk——旧规则正是因此放行的
  const load = revisionShotLoad(report, plan.shotPlan.map((shot) => shot.shotId));
  for (const id of ["A03", "A07", "A08"]) {
    assert.equal(load.get(id).constrained, false, `${id} 不在受判名单里，旧规则不会拦它`);
    assert.ok(load.get(id).increase.length > 0, `${id} 的条目全是「要求加内容」`);
  }

  // 已知仍然放行的一类：A02 删 1 加 1，长度相等而复杂度暴涨
  // （删的是「路人撑伞走过的第二次强调」，加的是「外套滑落→露头→发抖→压住→重新裹紧」）。
  // 数条目数管不了这个，本次没有改判据——见 CLAUDE.md 2.14 的已知局限。
  const a02 = revision.revisedShots.find((row) => row.shotId === "A02");
  assert.equal(a02.removedActions.length, a02.addedActions.length);
});
