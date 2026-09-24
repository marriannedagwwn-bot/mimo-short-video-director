import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { loadAppUi } from "./helpers/app-ui-harness.js";

import {
  InputError,
  OutputContractError,
  derivePromiseVerdict,
  deriveStoryCandidateProjections,
  ensureFullStoryPromiseCheckCoversCandidate,
  ensureFullStoryPromiseFindingsContract,
  ensureFullStoryPromiseListContract,
  ensureOutputContract
} from "../src/validation.js";
import {
  FULL_STORY_PRECHECK_ROUTES,
  PROMISE_UNREALIZED_REASON,
  assembleFullStoryPromiseCheck,
  buildFullStoryPromiseFindingsProjection,
  buildFullStoryPromiseListProjection,
  deriveFullStoryPrecheckRoute,
  promiseCheckGaps,
  singleCandidateThemeVariants
} from "../src/full-story-precheck.js";
import {
  fullStoryPromiseCheckRetryPrompt,
  fullStoryPromiseFindingsPrompt,
  fullStoryPromiseListPrompt
} from "../src/prompts.js";
import { mockFullStoryPromiseCheck } from "../src/mock.js";
import { CANDIDATE_REVIEW_DIMENSION_WEIGHTS } from "../public/story-review-metrics.js";
import { WorkflowService } from "../src/workflow.js";

const SERVER_JS = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

function candidate(id, title, actions, hook = `${title}，她能做到吗？`) {
  return {
    id,
    title,
    oneLineHook: hook,
    logline: `${title}的一句话`,
    verticalFit: "治愈日常",
    characterSetup: { protagonist: "主角甲" },
    newTask: `${title}的任务`,
    environmentPressure: "天色渐暗",
    narrativeMode: "slice_of_life",
    keyChoiceBeat: 2,
    climaxBeat: 3,
    storyOutline: actions.map((action, index) => ({
      beat: index + 1,
      phase: `阶段${index + 1}`,
      action,
      emotion: "平静",
      dramaticFunction: `${id}的第${index + 1}拍功能`,
      estimatedSeconds: 10
    })),
    keyDialogueDirections: [`${title}：一句对白`],
    highValueBeatMapping: [
      { briefBeat: "低压力陪伴", newExpression: "陪着做完", retainedValue: "陪伴", failureSignal: "只靠台词宣布温暖" }
    ],
    novelty: `${title}的新颖性`,
    visualPotential: "举手的轮廓",
    experienceFidelity: { positioning: "生活流", audience: "治愈", emotion: "平静", plotDriver: "一件小事", highValueBeats: "陪伴" },
    transformationProof: {
      changedCharacters: { source: "帮助者", replacement: "改为主角甲" },
      changedTask: { source: "原片没有", replacement: "陪着做完" },
      changedDetailsAndProps: { source: "任务物", replacement: "小物件" },
      changedDialogue: { source: "原片没有", replacement: "一句话" },
      changedVisualExpression: { source: "原片没有", replacement: "河边" }
    },
    originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "无", mitigation: "无" }
  };
}

const ACTIONS = ["第一拍里她把东西分成小份", "第二拍她走了一趟又折返", "第三拍地上的东西越来越少"];

function batch() {
  return deriveStoryCandidateProjections({
    variants: [
      candidate("V1", "一趟一趟慢慢挪", ACTIONS, "天黑之前，她能做到吗？"),
      candidate("V2", "另一个选题", ["V2 第一拍", "V2 第二拍", "V2 第三拍"])
    ]
  });
}

const target = () => batch().variants[0];

// 第一步：盲写的承诺清单（模型在这一步看不到动作链）。
function goodList(overrides = {}) {
  return {
    schemaVersion: "full-story-promise-list/1.0",
    candidateId: "V1",
    promises: [
      {
        source: "title",
        quote: "一趟一趟",
        kind: "promise",
        promise: "观众期待看到分多次完成",
        mustSee: ["每次只拿一点", "来回走了不止一次"]
      },
      {
        source: "oneLineHook",
        quote: "她能做到吗",
        kind: "promise",
        promise: "观众期待知道她做没做到",
        mustSee: ["最后有没有做完的明确结果"]
      }
    ],
    ...overrides
  };
}

// 第二步：逐条定位。证据必须逐字取自它引用的那一拍。
function goodFindings(overrides = {}) {
  return {
    schemaVersion: "full-story-promise-findings/1.0",
    candidateId: "V1",
    findings: [
      { promiseIndex: 0, mustSeeIndex: 0, found: true, beat: 1, evidence: "分成小份", why: "" },
      { promiseIndex: 0, mustSeeIndex: 1, found: true, beat: 2, evidence: "走了一趟又折返", why: "" },
      { promiseIndex: 1, mustSeeIndex: 0, found: false, beat: 0, evidence: "", why: "第三拍只写了越来越少，没写做完" }
    ],
    ...overrides
  };
}

const assembled = () => assembleFullStoryPromiseCheck(goodList(), goodFindings());

function codes(fn) {
  try {
    fn();
  } catch (error) {
    return (error.details || []).map((detail) => detail.code);
  }
  return [];
}

// ---------------------------------------------------------------------------
// 第一步：盲写清单的闸门

test("合法的承诺清单原样通过", () => {
  const list = goodList();
  assert.equal(ensureFullStoryPromiseListContract(list, target()), list);
});

test("清单不是这个候选的即拒绝", () => {
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseListContract(goodList({ candidateId: "V2" }), target())),
    ["PROMISE_CHECK_CANDIDATE_MISMATCH"]
  );
});

// 摘句是编出来的就拦下；只差标点不算编。
test("quote 必须真的摘自对应字段，标点差异不算", () => {
  const invented = goodList();
  invented.promises[0].quote = "蹦蹦跳跳地搬";
  assert.deepEqual(codes(() => ensureFullStoryPromiseListContract(invented, target())), ["PROMISE_CHECK_QUOTE_NOT_IN_SOURCE"]);

  const wrongField = goodList();
  wrongField.promises[1].quote = "一趟一趟";
  assert.deepEqual(codes(() => ensureFullStoryPromiseListContract(wrongField, target())), ["PROMISE_CHECK_QUOTE_NOT_IN_SOURCE"]);

  const punctuation = goodList();
  punctuation.promises[1].quote = "她能做到吗？";
  assert.doesNotThrow(() => ensureFullStoryPromiseListContract(punctuation, target()));
});

test("钩子不能判 not_a_promise，标题可以，而且标题这一档不必写 mustSee", () => {
  const hook = goodList();
  hook.promises[1] = { ...hook.promises[1], kind: "not_a_promise", mustSee: [] };
  assert.deepEqual(codes(() => ensureFullStoryPromiseListContract(hook, target())), ["PROMISE_CHECK_HOOK_NOT_A_PROMISE"]);

  const title = goodList();
  title.promises[0] = { ...title.promises[0], kind: "not_a_promise", mustSee: [] };
  assert.doesNotThrow(() => ensureFullStoryPromiseListContract(title, target()));
});

// 2026-09-24：MiMo 把标题判成 not_a_promise 后写 promise: ""，两次都被拒（千问 09-18 也有两次）。
// 提示词原来只说 mustSee 写空数组、没说 promise 写什么；拒绝理由又是「写清楚观众期待看到什么」，
// 对不构成承诺的一条自相矛盾，重试照样写空。判定不变，只补提示词、按 kind 给理由。
test("标题判 not_a_promise 时 promise 仍不能为空，理由按 kind 写、不再自相矛盾", () => {
  const title = goodList();
  title.promises[0] = { ...title.promises[0], kind: "not_a_promise", promise: "", mustSee: [] };
  assert.throws(
    () => ensureFullStoryPromiseListContract(title, target()),
    (error) => {
      assert.deepEqual(error.details.map((detail) => detail.code), ["PROMISE_CHECK_LIST_INVALID"]);
      assert.equal(error.details[0].path, "/promises/0/promise");
      assert.match(error.details[0].reason, /not_a_promise/u);
      assert.match(error.details[0].reason, /为什么没有许诺/u);
      assert.doesNotMatch(error.details[0].reason, /观众因此期待/u);
      return true;
    }
  );

  const promise = goodList();
  promise.promises[1] = { ...promise.promises[1], promise: "  " };
  assert.throws(
    () => ensureFullStoryPromiseListContract(promise, target()),
    (error) => {
      assert.equal(error.details[0].path, "/promises/1/promise");
      assert.match(error.details[0].reason, /观众因此期待看到什么/u);
      return true;
    }
  );

  const explained = goodList();
  explained.promises[0] = { ...explained.promises[0], kind: "not_a_promise", promise: "标题只是一个名字，没有许诺看得见的事", mustSee: [] };
  assert.doesNotThrow(() => ensureFullStoryPromiseListContract(explained, target()));
});

test("承诺清单提示词写明 not_a_promise 时 promise 该写什么", () => {
  const prompt = fullStoryPromiseListPrompt(target());
  assert.match(prompt, /not_a_promise，并把 mustSee 写成空数组；\s*这时 promise \*\*也不能留空\*\*，改写一句话说明这个标题为什么没有许诺看得见的东西/u);
});

test("标题与钩子各至少核对一条，承诺必须写 mustSee", () => {
  const onlyTitle = goodList({ promises: [goodList().promises[0], goodList().promises[0]] });
  assert.deepEqual(codes(() => ensureFullStoryPromiseListContract(onlyTitle, target())), ["PROMISE_CHECK_SOURCE_MISSING"]);

  const empty = goodList();
  empty.promises[1].mustSee = [];
  assert.deepEqual(codes(() => ensureFullStoryPromiseListContract(empty, target())), ["PROMISE_CHECK_MUST_SEE_EMPTY"]);
});

// ---------------------------------------------------------------------------
// 第二步：逐条定位的闸门

test("合法的逐条定位原样通过", () => {
  const findings = goodFindings();
  assert.equal(ensureFullStoryPromiseFindingsContract(findings, goodList(), target()), findings);
});

// 覆盖率由构造保证：漏一项、重复一项、答一项清单里没有的，都拦下。
test("每个 mustSee 必须恰好回答一次", () => {
  const missing = goodFindings();
  missing.findings.pop();
  assert.deepEqual(codes(() => ensureFullStoryPromiseFindingsContract(missing, goodList(), target())), ["PROMISE_CHECK_FINDING_MISSING"]);

  const duplicated = goodFindings();
  duplicated.findings.push({ ...duplicated.findings[0] });
  assert.deepEqual(codes(() => ensureFullStoryPromiseFindingsContract(duplicated, goodList(), target())), ["PROMISE_CHECK_FINDING_DUPLICATE"]);

  const unknown = goodFindings();
  unknown.findings.push({ promiseIndex: 1, mustSeeIndex: 7, found: false, beat: 0, evidence: "", why: "编的" });
  assert.deepEqual(codes(() => ensureFullStoryPromiseFindingsContract(unknown, goodList(), target())), ["PROMISE_CHECK_FINDING_UNKNOWN"]);
});

test("判「演出来了」必须逐字引用那一拍的原文", () => {
  const paraphrased = goodFindings();
  paraphrased.findings[0].evidence = "她把东西一份一份地分开";
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseFindingsContract(paraphrased, goodList(), target())),
    ["PROMISE_CHECK_EVIDENCE_NOT_IN_BEAT"]
  );

  const wrongBeat = goodFindings();
  wrongBeat.findings[0].beat = 3;
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseFindingsContract(wrongBeat, goodList(), target())),
    ["PROMISE_CHECK_EVIDENCE_NOT_IN_BEAT"]
  );

  const unknownBeat = goodFindings();
  unknownBeat.findings[0].beat = 9;
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseFindingsContract(unknownBeat, goodList(), target())),
    ["PROMISE_CHECK_UNKNOWN_BEAT"]
  );
});

test("判「没找到」必须写清楚动作链里实际写的是什么", () => {
  const noWhy = goodFindings();
  noWhy.findings[2].why = "  ";
  assert.deepEqual(codes(() => ensureFullStoryPromiseFindingsContract(noWhy, goodList(), target())), ["PROMISE_CHECK_WHY_MISSING"]);
});

test("标题判 not_a_promise 时那一条不需要定位", () => {
  const list = goodList();
  list.promises[0] = { ...list.promises[0], kind: "not_a_promise", mustSee: [] };
  const findings = { ...goodFindings(), findings: [goodFindings().findings[2]] };
  assert.doesNotThrow(() => ensureFullStoryPromiseFindingsContract(findings, list, target()));
});

// ---------------------------------------------------------------------------
// 合成与派生

test("verdict 由找到几条确定性派生，模型不写", () => {
  assert.equal(derivePromiseVerdict("promise", ["a", "b"], [{ found: true }, { found: true }]), "realized");
  assert.equal(derivePromiseVerdict("promise", ["a", "b"], [{ found: true }, { found: false }]), "partially_realized");
  assert.equal(derivePromiseVerdict("promise", ["a", "b"], [{ found: false }, { found: false }]), "not_realized");
  assert.equal(derivePromiseVerdict("not_a_promise", [], []), "not_a_promise");

  const check = assembled();
  assert.deepEqual(check.promises.map((entry) => entry.verdict), ["realized", "not_realized"]);
  assert.equal(check.schemaVersion, "full-story-promise-check/2.0");
  assert.doesNotThrow(() => ensureFullStoryPromiseCheckCoversCandidate(
    ensureOutputContract(check, "fullStoryPromiseCheck"), target()
  ));
});

// 合成结果会跨 HTTP 回到服务端（定向修订拿它当输入），所以 verdict 要重新派生比对：
// 改一个字段让它看起来没问题这条路必须堵死。
test("回传的报告被重新派生核对，改 verdict 立刻被拦下", () => {
  const tampered = assembled();
  tampered.promises[1].verdict = "realized";
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseCheckCoversCandidate(tampered, target())),
    ["PROMISE_CHECK_VERDICT_NOT_DERIVED"]
  );

  const forgedEvidence = assembled();
  forgedEvidence.promises[0].findings[0].evidence = "凭空写的一句";
  assert.deepEqual(
    codes(() => ensureFullStoryPromiseCheckCoversCandidate(forgedEvidence, target())),
    ["PROMISE_CHECK_EVIDENCE_NOT_IN_BEAT"]
  );
});

test("schema 拒收多余字段与非法枚举", () => {
  assert.throws(() => ensureOutputContract({ ...assembled(), uncertainties: [] }, "fullStoryPromiseCheck"), OutputContractError);
  const badVerdict = assembled();
  badVerdict.promises[0].verdict = "maybe";
  assert.throws(() => ensureOutputContract(badVerdict, "fullStoryPromiseCheck"), /fullStoryPromiseCheck 结构校验失败/u);
});

// ---------------------------------------------------------------------------
// 路由

test("没有降级理由、承诺全部兑现 → 直接展开", () => {
  const allFound = goodFindings();
  allFound.findings[2] = { promiseIndex: 1, mustSeeIndex: 0, found: true, beat: 3, evidence: "越来越少", why: "" };
  const check = assembleFullStoryPromiseCheck(goodList(), allFound);
  assert.deepEqual(
    deriveFullStoryPrecheckRoute({ reviewCheck: { verdictOverrideReasons: [] }, promiseCheck: check }),
    { route: FULL_STORY_PRECHECK_ROUTES.EXPAND, reasons: [] }
  );
});

test("评审的降级理由与没兑现的承诺并集成路由理由，不重复", () => {
  assert.deepEqual(
    deriveFullStoryPrecheckRoute({
      reviewCheck: { verdictOverrideReasons: ["coherence_break", "scaffold_copy", "coherence_break"] },
      promiseCheck: assembled()
    }),
    { route: FULL_STORY_PRECHECK_ROUTES.REVISE, reasons: ["coherence_break", "scaffold_copy", PROMISE_UNREALIZED_REASON] }
  );
  assert.deepEqual(
    deriveFullStoryPrecheckRoute({ reviewCheck: { verdictOverrideReasons: [] }, promiseCheck: assembled() }).reasons,
    [PROMISE_UNREALIZED_REASON]
  );
});

test("标题判 not_a_promise 不算没兑现", () => {
  const list = goodList();
  list.promises[0] = { ...list.promises[0], kind: "not_a_promise", mustSee: [] };
  const findings = { ...goodFindings(), findings: [{ promiseIndex: 1, mustSeeIndex: 0, found: true, beat: 3, evidence: "越来越少", why: "" }] };
  assert.deepEqual(promiseCheckGaps(assembleFullStoryPromiseCheck(list, findings)), []);
});

test("单候选批次只含目标命题，找不到就 400", () => {
  assert.deepEqual(singleCandidateThemeVariants(batch(), "V2").variants.map((v) => v.id), ["V2"]);
  assert.throws(() => singleCandidateThemeVariants(batch(), "V9"), InputError);
});

// ---------------------------------------------------------------------------
// 提示词

// 这条是整个两步设计的理由：第一次调用**看不到动作链**，模型就无从照着它倒推期待。
test("盲写清单的提示词里没有任何动作链原文", () => {
  const body = fullStoryPromiseListPrompt(target());
  for (const action of ACTIONS) {
    assert.ok(!body.includes(action), `盲写这一步不该看到动作原文：${action}`);
  }
  for (const leaked of ["storyOutline", "一趟一趟慢慢挪的一句话", "一趟一趟慢慢挪的任务"]) {
    assert.ok(!body.includes(leaked), `投影不该带出「${leaked}」`);
  }
  assert.deepEqual(
    Object.keys(buildFullStoryPromiseListProjection(target())).sort(),
    ["id", "narrativeMode", "oneLineHook", "protagonist", "title"]
  );
  assert.match(body, /看不到剧情内容——这是故意的/u);
});

test("逐条定位的提示词带着冻结清单与动作链，并写明要回答多少条", () => {
  const body = fullStoryPromiseFindingsPrompt(target(), goodList());
  assert.ok(body.includes(ACTIONS[1]), "这一步必须看到动作链");
  assert.ok(body.includes("来回走了不止一次"), "这一步必须带着第一步冻结的 mustSee");
  assert.match(body, /一共 3 条/u);
  assert.match(body, /这份清单是冻结的，你不能改/u);
  const projection = buildFullStoryPromiseFindingsProjection(target(), goodList());
  assert.deepEqual(Object.keys(projection).sort(), ["id", "promises", "storyOutline"]);
  assert.deepEqual(Object.keys(projection.storyOutline[0]).sort(), ["action", "beat"]);
});

// §2.12b 企鹅快递员的教训：举例会被逐字照抄成内容。两份提示词正文都不得出现样本名词。
test("两份提示词正文都不含任何参考片或样本的具体名词", () => {
  const bodies = [
    fullStoryPromiseListPrompt(target()).replace(JSON.stringify(buildFullStoryPromiseListProjection(target())), ""),
    fullStoryPromiseFindingsPrompt(target(), goodList())
      .replace(JSON.stringify(buildFullStoryPromiseFindingsProjection(target(), goodList())), "")
  ];
  for (const body of bodies) {
    for (const noun of ["蚂蚁", "书", "干花", "阳光", "罐", "奶奶", "村长", "小白子", "芙芙猫", "暴雨", "泥", "胸花", "竹席"]) {
      assert.ok(!body.includes(noun), `提示词正文出现了样本名词「${noun}」`);
    }
  }
});

test("重试只追加诊断，没有诊断就原样重发", () => {
  assert.equal(fullStoryPromiseCheckRetryPrompt({ originalPrompt: "原文", details: [] }), "原文");
  const retry = fullStoryPromiseCheckRetryPrompt({
    originalPrompt: "原文",
    details: [{ path: "/promises/0/quote", reason: "quote 必须逐字摘自候选的 title", code: "PROMISE_CHECK_QUOTE_NOT_IN_SOURCE" }]
  });
  assert.ok(retry.startsWith("原文"));
  assert.match(retry, /PROMISE_CHECK_QUOTE_NOT_IN_SOURCE/u);
});

test("demo 承诺核对两个分支都走到，并通过自己的契约", () => {
  const mock = mockFullStoryPromiseCheck(target());
  assert.doesNotThrow(() => ensureFullStoryPromiseCheckCoversCandidate(
    ensureOutputContract(mock, "fullStoryPromiseCheck"), target()
  ));
  assert.deepEqual(mock.promises.map((entry) => entry.verdict), ["realized", "not_realized"]);
});

// ---------------------------------------------------------------------------
// 端到端

const dimensions = () => Object.keys(CANDIDATE_REVIEW_DIMENSION_WEIGHTS).map((id) => ({
  id, score: 8.2, evidence: "夹具占位。", evidenceRefs: []
}));

function singleReview({ coherenceChecks = [], scaffoldScore = 10 } = {}) {
  return {
    schemaVersion: "story-candidate-review/1.0",
    sourceMechanisms: [
      { id: "M1", mechanism: "机制一", whereInSource: "S1", requiresCause: false },
      { id: "M2", mechanism: "机制二", whereInSource: "S2", requiresCause: false }
    ],
    candidateChecks: [{
      candidateId: "V1",
      title: "一趟一趟慢慢挪",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [{ sourceMechanismId: "M1", causeEvidence: "", actionEvidence: "第 1 拍", beatIndexes: [1], verdict: "depicted" }],
      coherenceChecks,
      sourceScaffoldOverlap: {
        eventChain: [{ sourceEvent: "原片第一件事", candidateEvent: "本命题另做一件事", beatIndexes: [1], linkage: "different" }],
        taskType: "different", midSection: "different", rewardSource: "not_applicable",
        rewardHandling: "not_applicable", endingShape: "different", score: scaffoldScore, why: "接法不同"
      },
      dimensions: dimensions(),
      physicalAssumptions: [],
      strongestReason: "夹具占位。",
      dominantDefect: { type: "none", severity: "NONE", description: "" },
      briefAlignment: { status: "PASS", conflict: "", suggestBriefChange: "" },
      top3RevisionSuggestions: [],
      why: "夹具", keepThis: "夹具"
    }],
    holisticPreferenceOrder: ["V1"],
    batchTemplateConvergence: { converged: false, sharedMechanism: "", affectedCandidateIds: [], evidence: "" },
    briefProblemsDetected: [],
    summary: "夹具"
  };
}

// 三路调用（评审、盲写清单、逐条定位）按提示词内容分发，不靠调用顺序。
function livePrecheckWorkflow({ review = [], list = [], findings = [] }) {
  const calls = { review: [], list: [], findings: [] };
  const client = {
    async generateJson({ prompt }) {
      const kind = prompt.includes("现在做第一步") ? "list"
        : prompt.includes("现在做第二步") ? "findings"
          : "review";
      calls[kind].push(prompt);
      const next = { review, list, findings }[kind][calls[kind].length - 1];
      if (!next) throw new Error(`${kind} 第 ${calls[kind].length} 次调用没有预置响应——预算被超用了`);
      if (next instanceof Error) throw next;
      return structuredClone(next);
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: client },
    stageDefaults: {
      storyCandidateReview: { provider: "Qwen", model: "review-model", maxCompletionTokens: 32768, requestTimeoutMs: null }
    }
  });
  return { workflow, calls };
}

const PRECHECK_INPUT = () => ({
  themeVariants: batch(),
  candidateId: "V1",
  sourceScriptReconstruction: { scenes: [] }
});

test("体检：评审只收到这一个候选，承诺核对两步顺序执行，路由确定性合成", async () => {
  const { workflow, calls } = livePrecheckWorkflow({
    review: [singleReview()], list: [goodList()], findings: [goodFindings()]
  });
  const out = await workflow.createFullStoryPrecheck(PRECHECK_INPUT());
  assert.equal(calls.review.length, 1);
  assert.equal(calls.list.length, 1);
  assert.equal(calls.findings.length, 1);
  assert.ok(calls.review[0].includes("一趟一趟慢慢挪"));
  assert.ok(!calls.review[0].includes("另一个选题"), "评审不该看到同批其余命题");
  assert.ok(!calls.list[0].includes(ACTIONS[0]), "盲写那一步不该看到动作链");
  assert.ok(calls.findings[0].includes(ACTIONS[0]), "定位那一步必须看到动作链");
  assert.equal(out.route, FULL_STORY_PRECHECK_ROUTES.REVISE);
  assert.deepEqual(out.reasons, [PROMISE_UNREALIZED_REASON]);
  assert.deepEqual(out.promiseCheck.promises.map((entry) => entry.verdict), ["realized", "not_realized"]);
  assert.equal(out.metadata.fullStoryPromiseCheck.providerCalls, 2);
  assert.equal(out.metadata.storyCandidateReview.model, "review-model");
});

test("体检：评审报出因果断裂、承诺全部兑现 → 仍然先修订", async () => {
  const allFound = goodFindings();
  allFound.findings[2] = { promiseIndex: 1, mustSeeIndex: 0, found: true, beat: 3, evidence: "越来越少", why: "" };
  const { workflow } = livePrecheckWorkflow({
    review: [singleReview({ coherenceChecks: [{ kind: "contradiction", beatIndexes: [2, 3], problem: "两拍互相否定" }] })],
    list: [goodList()], findings: [allFound]
  });
  const out = await workflow.createFullStoryPrecheck(PRECHECK_INPUT());
  assert.equal(out.route, FULL_STORY_PRECHECK_ROUTES.REVISE);
  assert.deepEqual(out.reasons, ["coherence_break"]);
});

test("体检：两边都没问题 → 直接展开", async () => {
  const allFound = goodFindings();
  allFound.findings[2] = { promiseIndex: 1, mustSeeIndex: 0, found: true, beat: 3, evidence: "越来越少", why: "" };
  const { workflow } = livePrecheckWorkflow({ review: [singleReview()], list: [goodList()], findings: [allFound] });
  const out = await workflow.createFullStoryPrecheck(PRECHECK_INPUT());
  assert.equal(out.route, FULL_STORY_PRECHECK_ROUTES.EXPAND);
  assert.deepEqual(out.reasons, []);
});

test("两步各自允许第一次做错：只带诊断重做一次", async () => {
  const invented = goodList();
  invented.promises[0].quote = "凭空编的一句";
  const brokenFindings = goodFindings();
  brokenFindings.findings.pop();
  const { workflow, calls } = livePrecheckWorkflow({
    review: [singleReview()],
    list: [invented, goodList()],
    findings: [brokenFindings, goodFindings()]
  });
  const out = await workflow.createFullStoryPrecheck(PRECHECK_INPUT());
  assert.equal(calls.list.length, 2);
  assert.equal(calls.findings.length, 2);
  assert.match(calls.list[1], /PROMISE_CHECK_QUOTE_NOT_IN_SOURCE/u);
  assert.ok(!calls.list[1].includes("凭空编的一句"), "重试不把失败的输出发回去");
  assert.match(calls.findings[1], /PROMISE_CHECK_FINDING_MISSING/u);
  assert.equal(out.metadata.fullStoryPromiseCheck.providerCalls, 4);
  assert.equal(out.metadata.fullStoryPromiseCheck.rejections.length, 2);
});

test("任一路失败都整体报错；两路都失败时两个原因都要说出来", async () => {
  const invented = goodList();
  invented.promises[0].quote = "凭空编的一句";
  const oneFails = livePrecheckWorkflow({ review: [singleReview()], list: [invented, invented] });
  await assert.rejects(
    () => oneFails.workflow.createFullStoryPrecheck(PRECHECK_INPUT()),
    (error) => {
      assert.match(error.message, /核验失败/u);
      assert.deepEqual([...new Set((error.diagnostics || []).map((detail) => detail.metadata?.attempt ?? detail.attempt))], [1, 2]);
      return true;
    }
  );
  assert.equal(oneFails.calls.review.length, 1, "评审那一路照样跑完，用量不丢");

  const bothFail = livePrecheckWorkflow({
    review: [new Error("评审传输失败"), new Error("评审传输失败")],
    list: [invented, invented]
  });
  await assert.rejects(
    () => bothFail.workflow.createFullStoryPrecheck(PRECHECK_INPUT()),
    /另外承诺核对也失败了/u
  );
});

test("体检的输入错误归客户端：缺候选 id、候选不存在都是 400", async () => {
  const { workflow } = livePrecheckWorkflow({});
  await assert.rejects(() => workflow.createFullStoryPrecheck({ ...PRECHECK_INPUT(), candidateId: "" }), InputError);
  await assert.rejects(() => workflow.createFullStoryPrecheck({ ...PRECHECK_INPUT(), candidateId: "V9" }), InputError);
});

test("demo 模式下体检同样走完两路并给出路由", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const out = await workflow.createFullStoryPrecheck(PRECHECK_INPUT());
  assert.equal(out.route, FULL_STORY_PRECHECK_ROUTES.REVISE);
  assert.ok(out.reasons.includes(PROMISE_UNREALIZED_REASON));
  assert.equal(out.metadata.storyCandidateReview.provider, "demo");
  assert.equal(out.metadata.fullStoryPromiseCheck.provider, "demo");
});

// ---------------------------------------------------------------------------
// 接线

test("体检接口与原文侧车 scope 已注册", () => {
  assert.match(SERVER_JS, /"\/api\/full-story-precheck": \(body\) => workflow\.createFullStoryPrecheck\(body\)/u);
  assert.match(SERVER_JS, /MODEL_OUTPUT_LOG_SCOPES\.FULL_STORY_PROMISE_CHECK/u);
});

// ---------------------------------------------------------------------------
// 浏览器接入（2026-09-17）。这一段测的是**顺序与副作用**，不是渲染细节：
// 体检必须发生在签发 `variant:<id>` 之前，判出要修订时不许签发任何东西，
// 体检失败不许静默展开，采纳之后不许再体检第二次。

const APP_JS = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const uiResponse = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
const uiTickTwice = () => new Promise(setImmediate).then(() => new Promise(setImmediate));

function precheckApp({ story = false, routes = {}, confirm = () => true } = {}) {
  const calls = [];
  return loadAppUi({
    story,
    confirm,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected ${url}`);
      return uiResponse(typeof handler === "function" ? handler(JSON.parse(options.body), calls) : handler);
    }
  }).then((app) => {
    for (const artifactId of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief",
      "visualGuardrails", "themeVariants"]) {
      app.state.production.artifacts[artifactId] = { artifactId, status: "current",
        revision: "r1", contentDigest: `${artifactId}-digest` };
    }
    return { app, calls };
  });
}

function revisedBatch(app, action = "改过的动作链：她一趟一趟地搬，书堆越来越矮。") {
  const next = structuredClone(app.fixture.themeVariants);
  const target = next.variants.find((variant) => variant.id === "V2");
  target.storyOutline[0].action = action;
  return next;
}

const PASS_RESULT = { schemaVersion: "full-story-precheck/1.0", candidateId: "V2", route: "expand", reasons: [],
  review: { candidateChecks: [{ candidateId: "V2", coherenceChecks: [] }] },
  promiseCheck: { promises: [{ source: "title", quote: "标题片段", promise: "许诺", mustSee: ["看得见的事"],
    findings: [{ mustSeeIndex: 0, found: true, beat: 1, evidence: "原文", why: "" }], verdict: "realized" }] },
  metadata: {} };

function reviseResult() {
  return { schemaVersion: "full-story-precheck/1.0", candidateId: "V2", route: "revise",
    reasons: [PROMISE_UNREALIZED_REASON, "coherence_break"],
    review: { candidateChecks: [{ candidateId: "V2",
      coherenceChecks: [{ kind: "space_or_time", beatIndexes: [2, 3], problem: "前面说够不到，后面用更弱的办法却成了。" }] }] },
    promiseCheck: { promises: [{ source: "title", quote: "标题片段", promise: "许诺一件看得见的事",
      mustSee: ["一趟一趟地搬"],
      findings: [{ mustSeeIndex: 0, found: false, beat: 0, evidence: "", why: "动作链只搬了一趟就宣告全部搬完。" }],
      verdict: "not_realized" }] },
    metadata: {} };
}

test("点生成完整剧情：体检跑在签发 variant 之前，判直接展开才继续", async () => {
  const { app, calls } = await precheckApp({ routes: {
    "/api/full-story-precheck": PASS_RESULT,
    "/api/production/artifact/commit": { lineage: { artifactId: "variant:V2", status: "current",
      revision: "r1", contentDigest: "variant:V2-digest" }, staleArtifactIds: [] },
    "/api/tasks/create": { task: { taskId: "task-fullStory", projectId: "project", runId: "run",
      kind: "fullStory", status: "completed", targetArtifactIds: ["fullStory:V2"],
      createdAt: "2026-09-17T01:00:00Z", updatedAt: "2026-09-17T01:01:00Z",
      resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] } },
    "/api/production/run/load": (_body, _calls) => ({ projectId: "project", runId: "run", latestArtifacts: {} })
  } });
  await app.startFullStory({ force: true });
  const urls = calls.map((call) => call.url);
  assert.equal(urls[0], "/api/full-story-precheck");
  assert.ok(urls.indexOf("/api/production/artifact/commit") > 0, "体检必须早于签发 variant");
  assert.equal(calls[0].body.candidateId, "V2");
  // 只送选中的那一个命题由服务端投影，浏览器送整批——与既有评审逐字同一组上游。
  assert.ok(calls[0].body.themeVariants.variants.length > 1);
  assert.equal(app.state.storyPrecheckRunning, false);
});

// 2026-09-18：体检通过、展开却失败之后，用户每点一次生成就重新付一次体检。
// 命题没变时，上一次「直接展开」的结论继续有效；命题一变就必须重新体检。
function expandRoutes({ failFirstExpand = false } = {}) {
  let expandCalls = 0;
  return {
    "/api/full-story-precheck": PASS_RESULT,
    "/api/production/artifact/commit": { lineage: { artifactId: "variant:V2", status: "current",
      revision: "r1", contentDigest: "variant:V2-digest" }, staleArtifactIds: [] },
    "/api/tasks/create": () => {
      expandCalls += 1;
      if (failFirstExpand && expandCalls === 1) throw new Error("第一次展开失败");
      return { task: { taskId: `task-fullStory-${expandCalls}`, projectId: "project", runId: "run",
        kind: "fullStory", status: "completed", targetArtifactIds: ["fullStory:V2"],
        createdAt: "2026-09-18T01:00:00Z", updatedAt: "2026-09-18T01:01:00Z",
        resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] } };
    },
    "/api/production/run/load": () => ({ projectId: "project", runId: "run", latestArtifacts: {} })
  };
}

test("体检通过后展开失败：命题没变时再点生成，直接展开、不重复体检", async () => {
  const { app, calls } = await precheckApp({ routes: expandRoutes({ failFirstExpand: true }) });
  await app.startFullStory({ force: true });
  await app.startFullStory({ force: true });
  assert.equal(calls.filter((call) => call.url === "/api/full-story-precheck").length, 1,
    "命题没变，上一次「直接展开」的结论继续有效");
  assert.equal(calls.filter((call) => call.url === "/api/tasks/create").length, 2);
});

test("命题变了（采纳过修订或换过一批）就重新体检", async () => {
  // 第一次展开同样让它失败：成功的展开会从服务端重新载入 Run，而夹具的 Run 是空的，
  // 会把选中命题一并清掉，那样测到的就不是体检决策了。
  const { app, calls } = await precheckApp({ routes: expandRoutes({ failFirstExpand: true }) });
  await app.startFullStory({ force: true });
  app.state.output.themeVariants = revisedBatch(app);
  await app.startFullStory({ force: true });
  assert.equal(calls.filter((call) => call.url === "/api/full-story-precheck").length, 2);
});

test("判需修订：只出修订稿，一个 Artifact 都不签发", async () => {
  const { app, calls } = await precheckApp({ routes: {
    "/api/full-story-precheck": reviseResult(),
    "/api/story-candidate-revision": (body, _calls) => {
      assert.equal(body.scope, "root");
      assert.equal(body.candidateId, "V2");
      assert.ok(body.promiseCheck, "修订必须收到承诺核对结果");
      return { candidateId: "V2", themeVariants: revisedBatch(app),
        revision: { candidateId: "V2", revisedBeats: [], changeSummary: "把一趟改成多趟。" }, metadata: {} };
    }
  } });
  await app.startFullStory({ force: true });
  assert.deepEqual(calls.map((call) => call.url),
    ["/api/full-story-precheck", "/api/story-candidate-revision"]);
  assert.equal(app.state.output.themeVariants.variants[1].storyOutline[0].action,
    app.fixture.themeVariants.variants[1].storyOutline[0].action, "没点采纳就不许改动命题");
  assert.equal(app.elements.fullStoryPrecheck.classList.contains("hidden"), false);
  assert.match(app.elements.fullStoryPrecheck.innerHTML, /动作链只搬了一趟就宣告全部搬完/u);
  assert.match(app.elements.fullStoryPrecheck.innerHTML, /前面说够不到/u);
  assert.match(app.elements.storyStatus.textContent, /还没有生效/u);
  // 体检面板自己有「采纳修订并展开」，复用的差异视图不得再渲染一个采纳按钮——
  // 那个按钮在这里没有绑定事件，两个采纳并排还会让人不知道点哪个。
  // 真实浏览器验证时它确实一起渲染出来了，单元测试当时没抓到，所以补这一条。
  const panel = app.elements.fullStoryPrecheck.innerHTML;
  assert.equal((panel.match(/data-adopt-candidate-revision/gu) || []).length, 0);
  assert.equal((panel.match(/data-precheck-adopt/gu) || []).length, 1);
  assert.equal((panel.match(/data-precheck-expand/gu) || []).length, 1);
});

test("体检失败：不静默展开，如实报原因", async () => {
  const { app, calls } = await precheckApp({ routes: {
    "/api/full-story-precheck": () => { throw new Error("boom"); }
  } });
  await app.startFullStory({ force: true });
  assert.deepEqual(calls.map((call) => call.url), ["/api/full-story-precheck"]);
  assert.equal(app.elements.storyStatus.className, "story-status error");
  assert.match(app.elements.fullStoryPrecheck.innerHTML, /没有判定/u);
  assert.equal(app.state.storyPrecheckRunning, false);
});

test("采纳之后继续展开，且不会再体检第二次", async () => {
  const { app, calls } = await precheckApp({ routes: {
    "/api/full-story-precheck": reviseResult(),
    "/api/story-candidate-revision": () => ({ candidateId: "V2", themeVariants: revisedBatch(app),
      revision: { candidateId: "V2", revisedBeats: [], changeSummary: "把一趟改成多趟。" }, metadata: {} }),
    "/api/production/artifact/commit": { lineage: { artifactId: "themeVariants", status: "current",
      revision: "r2", contentDigest: "themeVariants-digest-2" }, staleArtifactIds: [] },
    "/api/tasks/create": { task: { taskId: "task-fullStory", projectId: "project", runId: "run",
      kind: "fullStory", status: "completed", targetArtifactIds: ["fullStory:V2"],
      createdAt: "2026-09-17T01:00:00Z", updatedAt: "2026-09-17T01:01:00Z",
      resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] } },
    "/api/production/run/load": { projectId: "project", runId: "run", latestArtifacts: {} }
  } });
  await app.startFullStory({ force: true });
  await app.adoptThemeVariantsRevision({ ...{ themeVariants: revisedBatch(app) },
    sourceThemeVariants: app.fixture.themeVariants }, app.browserWorkspace.epoch);
  assert.equal(app.state.output.themeVariants.variants[1].storyOutline[0].action,
    revisedBatch(app).variants[1].storyOutline[0].action);
  await app.generateFullStory({ force: true });
  assert.equal(calls.filter((call) => call.url === "/api/full-story-precheck").length, 1,
    "采纳之后的续跑不许再体检一次");
  assert.ok(calls.some((call) => call.url === "/api/tasks/create"));
});

test("体检只挂在入口上，展开路径本身不体检", () => {
  // 两个入口（按钮与选中命题后的自动生成）都走 startFullStory；
  // generateFullStory 保持纯展开，采纳后的续跑与 durable task 恢复都直接走它。
  assert.match(APP_JS, /elements\.storyGenerate\.addEventListener\("click", \(\) => startFullStory\(\{ force: true \}\)\)/u);
  assert.match(APP_JS, /if \(autoGenerate\) startFullStory\(\);/u);
  const expand = APP_JS.slice(APP_JS.indexOf("async function generateFullStory("),
    APP_JS.indexOf("function renderFullStory(data)"));
  assert.doesNotMatch(expand, /full-story-precheck/u);
  // 体检必须在签发命题之前调用：同一个函数体里，接口调用早于 ensureSelectedVariantArtifact。
  const entry = APP_JS.slice(APP_JS.indexOf("async function startFullStory("),
    APP_JS.indexOf("async function requestPrecheckRevision("));
  assert.ok(entry.includes("/api/full-story-precheck"));
  assert.doesNotMatch(entry, /ensureSelectedVariantArtifact/u);
});

test("采纳的语义只有一份：签发 themeVariants 只发生在共用的那个函数里", () => {
  const slice = (from, to) => APP_JS.slice(APP_JS.indexOf(from), APP_JS.indexOf(to));
  // 两个采纳入口都必须把签发交给共用函数，自己一行 commit 都不许写——
  // 过期复核、下游征求同意与递归 stale 的语义只能有一处定义。
  for (const [from, to] of [
    ["async function adoptStoryCandidateRevision(", "async function adoptThemeVariantsRevision("],
    ["async function adoptPrecheckRevisionAndExpand(", "function renderPrecheckPassed("]
  ]) {
    const body = slice(from, to);
    assert.match(body, /adoptThemeVariantsRevision\(/u);
    assert.doesNotMatch(body, /commitProductionArtifact/u);
  }
  assert.match(APP_JS, /async function adoptThemeVariantsRevision\(entry, workspaceEpoch\)/u);
  // 过期与用户拒绝必须分得开：过期要丢掉修订稿，拒绝不能丢。
  assert.match(APP_JS, /return "stale";/u);
  assert.match(APP_JS, /return "declined";/u);
});
