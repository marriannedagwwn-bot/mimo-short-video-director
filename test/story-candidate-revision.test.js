import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  InputError,
  deriveStoryCandidateProjections,
  ensureOutputContract,
  ensureStoryCandidateReviewCoversCandidates
} from "../src/validation.js";
import {
  assertOnlyCandidateRevisionFieldsChanged,
  candidateBlockerDefect,
  candidateCoherenceBreaks,
  candidateScaffoldCopy,
  candidateUnmigratedMechanisms,
  ensureStoryCandidateRevisionContract,
  mergeStoryCandidateRevision
} from "../src/story-candidate-revision.js";
import { storyCandidateRevisionPrompt, storyCandidateRevisionRetryPrompt } from "../src/prompts.js";
import { CANDIDATE_REVIEW_DIMENSION_WEIGHTS as REVIEW_WEIGHTS, SOURCE_SCAFFOLD_COPY_SCORE } from "../public/story-review-metrics.js";
import { PROMISE_UNREALIZED_REASON, deriveFullStoryPrecheckRoute, promiseCheckGaps } from "../src/full-story-precheck.js";
import { mockStoryCandidateRevision } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";

function candidate(id, title, actions) {
  return {
    id,
    title,
    oneLineHook: `${title}的钩子`,
    logline: `${title}的一句话`,
    verticalFit: "治愈日常",
    characterSetup: { protagonist: "小白子" },
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
      changedCharacters: { source: "帮助者", replacement: "改为小白子" },
      changedTask: { source: "原片没有", replacement: "陪着做完" },
      changedDetailsAndProps: { source: "任务物", replacement: "灯笼" },
      changedDialogue: { source: "原片没有", replacement: "一句话" },
      changedVisualExpression: { source: "原片没有", replacement: "河边" }
    },
    originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "无", mitigation: "无" }
  };
}

function themeVariants() {
  return deriveStoryCandidateProjections({
    variants: [
      candidate("V1", "第一个", ["V1 第一拍原文", "V1 第二拍原文", "V1 第三拍原文"]),
      candidate("V2", "第二个", ["V2 第一拍原文", "V2 第二拍原文", "V2 第三拍原文"])
    ]
  });
}

// 骨架对照：修订这条路径不消费它，但评审报告要能通过自己的契约，所以夹具得带全。
// 分数刻意远低于换皮线——这里测的是修订，不该顺带触发评审的换皮闸门。
const scaffold = () => ({
  eventChain: [
    { sourceEvent: "原片第一件事", candidateEvent: "本命题另做一件事", beatIndexes: [1], linkage: "different" },
    { sourceEvent: "原片第二件事", candidateEvent: "候选里没有对应事件", beatIndexes: [], linkage: "absent" }
  ],
  taskType: "different",
  midSection: "different",
  rewardSource: "not_applicable",
  rewardHandling: "not_applicable",
  endingShape: "different",
  score: 10,
  why: "两条链的接法不同"
});

// 选题终审的评分块（2026-09-12）。修订这条路径不消费它，但它会按严格 schema
// 校验传入的报告，所以夹具得带全。分数刻意给 8.2：落在「需定向修订」那一档，
// 正是会走到修订的形状。
const dimensions = () => Object.keys(REVIEW_WEIGHTS).map((id) => ({
  id,
  score: 8.2,
  evidence: "夹具占位。",
  evidenceRefs: []
}));

const REVIEW = {
  schemaVersion: "story-candidate-review/1.0",
  sourceMechanisms: [
    { id: "M1", mechanism: "机制一", whereInSource: "S1", requiresCause: true },
    { id: "M2", mechanism: "机制二", whereInSource: "S2", requiresCause: false }
  ],
  candidateChecks: [
    {
      candidateId: "V1",
      title: "第一个",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [{
        sourceMechanismId: "M1",
        causeEvidence: "第 1 拍写了它怎么成为她在意的",
        actionEvidence: "第 1 拍",
        beatIndexes: [1],
        verdict: "depicted"
      }],
      coherenceChecks: [{ kind: "purpose_nullified", beatIndexes: [2, 3], problem: "任务目的在第 3 拍被抵消" }],
      sourceScaffoldOverlap: scaffold(),
      dimensions: dimensions(),
      physicalAssumptions: [{ mechanism: "用旧木箱垫脚够到高处", confidence: "conditional", literalDependency: "required", necessaryAssumptions: ["木箱承重足够"], failureRisk: "木箱塌了就够不到。", beatIndexes: [2] }],
      strongestReason: "夹具占位。",
      dominantDefect: { type: "causalLogic", severity: "MAJOR", description: "任务目的被抵消。" },
      briefAlignment: { status: "PASS", conflict: "", suggestBriefChange: "" },
      top3RevisionSuggestions: [{ kind: "replace", suggestion: "换掉第 3 拍的解法。", replacesOrStrengthens: "第 3 拍", whyOnlyHere: "它依赖第 1 拍就带在身上的那件道具。" }],
      why: "因果不自洽",
      keepThis: "陪伴的调子"
    },
    {
      candidateId: "V2",
      title: "第二个",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [{
        sourceMechanismId: "M2",
        causeEvidence: "",
        actionEvidence: "第 2 拍",
        beatIndexes: [2],
        verdict: "depicted"
      }],
      coherenceChecks: [],
      sourceScaffoldOverlap: scaffold(),
      dimensions: dimensions(),
      physicalAssumptions: [],
      strongestReason: "夹具占位。",
      dominantDefect: { type: "none", severity: "NONE", description: "" },
      briefAlignment: { status: "PASS", conflict: "", suggestBriefChange: "" },
      top3RevisionSuggestions: [],
      why: "没问题",
      keepThis: "结尾"
    }
  ],
  holisticPreferenceOrder: ["V2", "V1"],
  batchTemplateConvergence: { converged: false, sharedMechanism: "", affectedCandidateIds: [], evidence: "" },
  briefProblemsDetected: [],
  summary: "先做 V2"
};

const goodRevision = () => ({
  schemaVersion: "story-candidate-revision/1.0",
  candidateId: "V1",
  revisedBeats: [{ beat: 3, action: "V1 第三拍改过之后的动作" }],
  changeSummary: "把第 3 拍改成不再抵消任务目的"
});

// ---------------------------------------------------------------------------
// 越权检查

test("派生字段出现在修订结果里即拒绝", () => {
  for (const field of ["keyChoice", "climax", "emotionalPayoff", "transformationProof"]) {
    assert.throws(
      () => ensureStoryCandidateRevisionContract({ ...goodRevision(), [field]: "x" }, themeVariants(), "V1"),
      (error) => {
        assert.equal(error.details[0].code, "CANDIDATE_REVISION_SEALED_FIELD_PRESENT");
        return true;
      },
      `${field} 应当被拒`
    );
  }
});

// dramaticFunction 是结构分化签名的输入。让模型改它等于让它动一个现有闸门。
test("冻结字段出现即拒绝，每拍的 dramaticFunction 也一样", () => {
  assert.throws(
    () => ensureStoryCandidateRevisionContract({ ...goodRevision(), title: "换个名字" }, themeVariants(), "V1"),
    /CANDIDATE_REVISION_FROZEN_FIELD_PRESENT|title 在修订中冻结/u
  );
  assert.throws(
    () => ensureStoryCandidateRevisionContract(
      { ...goodRevision(), revisedBeats: [{ beat: 3, action: "新动作", dramaticFunction: "换个功能" }] },
      themeVariants(), "V1"
    ),
    /dramaticFunction 在修订中冻结/u
  );
});

test("改了别的命题即越权", () => {
  assert.throws(
    () => ensureStoryCandidateRevisionContract({ ...goodRevision(), candidateId: "V2" }, themeVariants(), "V1"),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVISION_OUT_OF_SCOPE");
      return true;
    }
  );
});

// 拍号不可写，所以拍集合必须保持不变：删一拍会让 keyChoiceBeat 指向错的动作。
test("引用不存在的拍号或重复引用同一拍都被拒", () => {
  assert.throws(
    () => ensureStoryCandidateRevisionContract(
      { ...goodRevision(), revisedBeats: [{ beat: 9, action: "x" }] }, themeVariants(), "V1"
    ),
    /CANDIDATE_REVISION_UNKNOWN_BEAT|它只有 3 拍/u
  );
  assert.throws(
    () => ensureStoryCandidateRevisionContract(
      { ...goodRevision(), revisedBeats: [{ beat: 2, action: "a" }, { beat: 2, action: "b" }] }, themeVariants(), "V1"
    ),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVISION_DUPLICATE_BEAT");
      return true;
    }
  );
});

test("列了一拍却一个可写字段都没写，说明模型在抄原文", () => {
  assert.throws(
    () => ensureStoryCandidateRevisionContract(
      { ...goodRevision(), revisedBeats: [{ beat: 2 }] }, themeVariants(), "V1"
    ),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVISION_BEAT_EMPTY");
      return true;
    }
  );
});

// 模型可以合规地交回一份与原文逐字相同的修订。那不是格式错误，是没干活。
test("一个字都没改即拒绝", () => {
  const batch = themeVariants();
  const original = batch.variants[0];
  assert.throws(
    () => ensureStoryCandidateRevisionContract({
      schemaVersion: "story-candidate-revision/1.0",
      candidateId: "V1",
      revisedBeats: [{ beat: 3, action: original.storyOutline[2].action }],
      changeSummary: "什么都没改"
    }, batch, "V1"),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVISION_NO_CHANGE");
      return true;
    }
  );
});

test("changeSummary 必填——不说清为什么这样能解掉断裂就等于没交代", () => {
  assert.throws(
    () => ensureStoryCandidateRevisionContract({ ...goodRevision(), changeSummary: "  " }, themeVariants(), "V1"),
    (error) => {
      assert.equal(error.details[0].code, "CANDIDATE_REVISION_SUMMARY_MISSING");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 合并

test("合并只动授权范围，其余命题与冻结字段逐字节不变", () => {
  const batch = themeVariants();
  const merged = mergeStoryCandidateRevision(batch, {
    ...goodRevision(),
    newTask: "换一个任务",
    keyDialogueDirections: ["新的一句"]
  });
  assert.doesNotThrow(() => assertOnlyCandidateRevisionFieldsChanged(batch, merged, "V1"));
  assert.equal(JSON.stringify(batch.variants[1]), JSON.stringify(merged.variants[1]), "V2 必须逐字节不变");
  const after = merged.variants[0];
  assert.equal(after.storyOutline[2].action, "V1 第三拍改过之后的动作");
  assert.equal(after.storyOutline[0].action, batch.variants[0].storyOutline[0].action, "没列的拍不许动");
  assert.equal(after.newTask, "换一个任务");
  assert.equal(after.title, batch.variants[0].title);
  assert.equal(after.storyOutline[2].dramaticFunction, batch.variants[0].storyOutline[2].dramaticFunction);
});

// 模型习惯把不改的可选字段写成 ""，硬当成改动会把一个非空字段清空。
test("空字符串当成没写，不会把原值清空", () => {
  const batch = themeVariants();
  const merged = mergeStoryCandidateRevision(batch, { ...goodRevision(), newTask: "", logline: "   " });
  assert.equal(merged.variants[0].newTask, batch.variants[0].newTask);
  assert.equal(merged.variants[0].logline, batch.variants[0].logline);
});

test("扩大可写范围而不同步这道检查，会被当场抓住", () => {
  const batch = themeVariants();
  const tampered = structuredClone(batch);
  tampered.variants[0].title = "偷偷改掉的标题";
  assert.throws(
    () => assertOnlyCandidateRevisionFieldsChanged(batch, tampered, "V1"),
    /冻结字段 title/u
  );
  const tampered2 = structuredClone(batch);
  tampered2.variants[1].newTask = "动了未授权的命题";
  assert.throws(
    () => assertOnlyCandidateRevisionFieldsChanged(batch, tampered2, "V1"),
    /未授权的命题 V2/u
  );
});

// ---------------------------------------------------------------------------
// 端到端

function liveRevisionWorkflow(responses) {
  const prompts = [];
  const client = {
    async generateJson({ prompt }) {
      prompts.push(prompt);
      const next = responses[prompts.length - 1];
      if (!next) throw new Error(`第 ${prompts.length} 次调用没有预置响应——预算被超用了`);
      return next;
    }
  };
  const workflow = new WorkflowService({
    clients: { Qwen: client },
    stageDefaults: {
      storyCandidateRevision: { provider: "Qwen", model: "test-model", maxCompletionTokens: 8192, requestTimeoutMs: null }
    }
  });
  return { workflow, prompts };
}

const INPUT = () => ({ themeVariants: themeVariants(), review: REVIEW, candidateId: "V1" });

// keyChoice / climax / emotionalPayoff 由服务端从 action 派生。改了 action 却不重新派生，
// 顶层与拍内就会出现两版剧情——那正是当初补这条派生的原因。
test("改了动作之后三个投影字段被重新派生，而不是回显旧值", async () => {
  const { workflow } = liveRevisionWorkflow([goodRevision()]);
  const out = await workflow.createStoryCandidateRevision(INPUT());
  const after = out.themeVariants.variants[0];
  assert.equal(after.emotionalPayoff, "V1 第三拍改过之后的动作", "末拍变了，emotionalPayoff 必须跟着变");
  assert.equal(after.climax, "V1 第三拍改过之后的动作", "climaxBeat 是 3");
  assert.equal(after.keyChoice, "V1 第二拍原文", "keyChoiceBeat 是 2，那一拍没改");
});

test("第一次被拦时带诊断重做一次，第二次通过就正常返回", async () => {
  const { workflow, prompts } = liveRevisionWorkflow([
    { ...goodRevision(), title: "越权改标题" },
    goodRevision()
  ]);
  const out = await workflow.createStoryCandidateRevision(INPUT());
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].startsWith(prompts[0]), "重试正文必须以原提示词开头");
  assert.match(prompts[1], /title 在修订中冻结/u);
  assert.equal(out.metadata.storyCandidateRevision.providerCalls, 2);
  assert.equal(out.metadata.storyCandidateRevision.rejections[0].attempt, 1);
});

test("两次都被拦即 fail closed，且两次的诊断都在", async () => {
  const bad = { ...goodRevision(), title: "越权改标题" };
  const { workflow, prompts } = liveRevisionWorkflow([bad, bad]);
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(INPUT()),
    (error) => {
      assert.equal(error.name, "ModelPipelineError");
      assert.deepEqual(error.diagnostics.map((d) => d.metadata?.attempt), [1, 2]);
      return true;
    }
  );
  assert.equal(prompts.length, 2, "预算封在 2 次，禁止第三次");
});

test("拿另一批命题的评审报告来修订会被当场拒绝，而且是 400", async () => {
  const { workflow } = liveRevisionWorkflow([goodRevision()]);
  const other = structuredClone(REVIEW);
  other.candidateChecks.pop();
  other.recommendedOrder = ["V1"];
  await assert.rejects(
    () => workflow.createStoryCandidateRevision({ ...INPUT(), review: other }),
    (error) => {
      assert.equal(error.name, "InputError");
      assert.match(error.message, /review 不是这一批命题的合法评审报告/u);
      return true;
    }
  );
});

test("demo 路径走完整条链，只留一处看得出是 demo 的占位改动", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const out = await workflow.createStoryCandidateRevision(INPUT());
  assert.equal(out.metadata.storyCandidateRevision.provider, "demo");
  assert.match(out.themeVariants.variants[0].storyOutline[0].action, /demo 模式未调用模型/u);
  assert.equal(JSON.stringify(out.themeVariants.variants[1]), JSON.stringify(themeVariants().variants[1]));
});

// ---------------------------------------------------------------------------
// 提示词

test("修订提示词只带目标命题，不带同批其余命题、不带原片", () => {
  const batch = themeVariants();
  const body = storyCandidateRevisionPrompt({
    candidate: batch.variants[0],
    coherenceBreaks: candidateCoherenceBreaks(REVIEW, "V1"),
    targetDurationSeconds: 60
  });
  assert.doesNotMatch(body, /V2 第一拍原文/u, "不得泄露其余命题");
  assert.doesNotMatch(body, /第二个的任务/u);
  // 自我评价字段送进去等于请模型来证明自己本来就是对的。
  assert.doesNotMatch(body, /第一个的新颖性/u);
  assert.doesNotMatch(body, /举手的轮廓/u);
  // dramaticFunction 反而要送：不能改它，但必须看得到，否则无从判断改完还成不成立。
  assert.match(body, /V1的第1拍功能/u);
  assert.match(body, /任务目的在第 3 拍被抵消/u);
  assert.match(body, /51-69 秒/u);
});

test("修订提示词正文不含反引号——模板字面量会被当场截断", () => {
  const batch = themeVariants();
  const body = storyCandidateRevisionPrompt({ candidate: batch.variants[0], coherenceBreaks: [] });
  assert.ok(!body.includes("`"));
  const retry = storyCandidateRevisionRetryPrompt({
    originalPrompt: "原文", details: [{ code: "X", path: "/title", reason: "冻结" }]
  });
  assert.ok(!retry.includes("`"));
  assert.match(retry, /冻结/u);
  assert.equal(storyCandidateRevisionRetryPrompt({ originalPrompt: "原文", details: [] }), "原文");
});

test("提示词写明拍数固定、执行者不许反转、不要靠加戏解决问题", () => {
  const batch = themeVariants();
  const body = storyCandidateRevisionPrompt({ candidate: batch.variants[0], coherenceBreaks: [] });
  assert.match(body, /拍数固定 3 拍，不许增删/u);
  assert.match(body, /执行者不许反转/u);
  assert.match(body, /不要靠加戏解决问题/u);
  assert.match(body, /只列你真正改了的拍/u);
});

// ---------------------------------------------------------------------------
// 浏览器

const APP_JS = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("修订入口由 coherenceChecks 驱动，不看 verdict", () => {
  assert.match(APP_JS, /function reviseAction\(check\)/u);
  assert.match(APP_JS, /check\?\.coherenceChecks/u);
  assert.ok(!/data-revise-candidate[\s\S]{0,200}check\.verdict/u.test(APP_JS), "入口不得由 verdict 决定");
});

// 采纳会递归 stale 整批命题的下游，即使别的命题一个字没改——themeVariants 是一份 Artifact。
test("采纳前复核这一批命题有没有换过，并把整批失效的代价说清楚", () => {
  assert.match(APP_JS, /entry\.sourceThemeVariants/u);
  assert.match(APP_JS, /包括没有被修订的那些命题/u);
  assert.match(APP_JS, /artifactId: "themeVariants"/u);
});

test("mock 的修订确实是一处真实改动，否则 demo 走不到合并与复验", () => {
  const batch = themeVariants();
  const revision = mockStoryCandidateRevision(batch.variants[0], [{ kind: "other", beatIndexes: [1], problem: "x" }]);
  assert.doesNotThrow(() => ensureStoryCandidateRevisionContract(revision, batch, "V1"));
});

// ---------------------------------------------------------------------------
// 第二个驱动信号：原片有、这个命题没接住的机制（2026-09-11）
//
// 起因是实测：V4 被判 drop 的主因是三条机制全部 not_depicted，而修订当时只收到
// 那条最轻的空间断裂，于是只把「小木箱」换成了「高脚木凳」——评审自己的 summary
// 写着「最该先改的是补充转赠长辈的动作」，那条根本没送到修订模型面前。

function reviewWithMechanisms() {
  return {
    schemaVersion: "story-candidate-review/1.0",
    sourceMechanisms: [
      { id: "M1", mechanism: "靠共同劳动建立亲密感", whereInSource: "S1 两人一起压平衣物" },
      { id: "M2", mechanism: "外部认可被转手送给在乎的人", whereInSource: "S6 把小红花别到长辈身上" },
      { id: "M3", mechanism: "等待时用童趣游戏填时间", whereInSource: "S4 蹲在地上玩石子" }
    ],
    candidateChecks: [{
      candidateId: "V1",
      title: "命题一",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [
        {
          sourceMechanismId: "M1",
          causeEvidence: "第 1 拍写了两人此前一起做过的事",
          actionEvidence: "第 1 拍一起搬东西",
          beatIndexes: [1],
          verdict: "depicted"
        },
        {
          sourceMechanismId: "M2",
          causeEvidence: "",
          actionEvidence: "没有任何转赠动作",
          beatIndexes: [],
          verdict: "not_depicted"
        },
        {
          // 前因写了、动作只沾边：这一条正是修订最需要看到两格证据的形状。
          sourceMechanismId: "M3",
          causeEvidence: "第 2 拍写了她为什么在意那段等待",
          actionEvidence: "只是站着等",
          beatIndexes: [3],
          verdict: "partially_depicted"
        }
      ],
      coherenceChecks: [],
      verdict: "revise",
      why: "因为",
      keepThis: "保留这个"
    }],
    recommendedOrder: ["V1"],
    summary: "总结"
  };
}

test("只挑没接住的机制，已兑现的不进修订", () => {
  const out = candidateUnmigratedMechanisms(reviewWithMechanisms(), "V1");
  assert.deepEqual(out.map((entry) => entry.id), ["M2", "M3"]);
  assert.deepEqual(out.map((entry) => entry.verdict), ["not_depicted", "partially_depicted"]);
});

// mechanismCheck 自己只有一个 id，光把 id 送过去修订模型什么也做不了。
test("机制正文从顶层清单按 id 查回来，一并送进修订", () => {
  const [first] = candidateUnmigratedMechanisms(reviewWithMechanisms(), "V1");
  assert.equal(first.mechanism, "外部认可被转手送给在乎的人");
  assert.equal(first.whereInSource, "S6 把小红花别到长辈身上");
  assert.equal(first.actionEvidence, "没有任何转赠动作");
});

// 证据拆成两格之后（2026-09-12），修订必须**两格都收到**：一条机制被判「只沾到一点边」
// 十有八九就是因为前因没写，只送动作证据等于把「差在哪」那一半藏起来。
test("前因证据一并送进修订，不是只送动作那一格", () => {
  const out = candidateUnmigratedMechanisms(reviewWithMechanisms(), "V1");
  const partial = out.find((entry) => entry.id === "M3");
  assert.equal(partial.causeEvidence, "第 2 拍写了她为什么在意那段等待");
  assert.equal(partial.actionEvidence, "只是站着等");
  assert.match(
    storyCandidateRevisionPrompt({
      candidate: themeVariants().variants[0],
      unmigratedMechanisms: out
    }),
    /评审找到的前因：第 2 拍写了她为什么在意那段等待/u
  );
});

// 评审报告不落盘、只活在页面上，而页面不会因为服务端重启而刷新：旧代码渲染出的报告
// 可以原样 POST 到新服务端。旧键读不到时是 String(undefined || "") → 空串，
// **页面与提示词上都是静默空白，不是报错**，所以这条回退要有测试守着。
test("旧报告的 whereInCandidate 仍能读出来，不会静默变成空白", () => {
  const legacy = reviewWithMechanisms();
  legacy.candidateChecks[0].mechanismChecks = legacy.candidateChecks[0].mechanismChecks.map(
    ({ causeEvidence, actionEvidence, ...rest }) => ({ ...rest, whereInCandidate: actionEvidence })
  );
  const [first] = candidateUnmigratedMechanisms(legacy, "V1");
  assert.equal(first.actionEvidence, "没有任何转赠动作");
  assert.equal(first.causeEvidence, "");
});

test("清单里查不到那个 id 就整条丢弃，不编一条机制出来", () => {
  const review = reviewWithMechanisms();
  review.sourceMechanisms = review.sourceMechanisms.filter((entry) => entry.id !== "M2");
  const out = candidateUnmigratedMechanisms(review, "V1");
  assert.deepEqual(out.map((entry) => entry.id), ["M3"]);
});

test("换了一批命题的 id 就什么都取不到", () => {
  assert.deepEqual(candidateUnmigratedMechanisms(reviewWithMechanisms(), "V9"), []);
});

// 两类问题的修法完全不同：因果断裂明确不许加戏，接机制通常就得加动作。
// 混在一个列表里模型分不清哪条允许加，所以提示词必须分块。
test("提示词把两类问题分块，各写各的修法", () => {
  const prompt = storyCandidateRevisionPrompt({
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"]),
    coherenceBreaks: [{ kind: "space_or_time", beatIndexes: [2], problem: "够不到" }],
    unmigratedMechanisms: candidateUnmigratedMechanisms(reviewWithMechanisms(), "V1")
  });
  assert.match(prompt, /第一类：因果说不通（必须修）/u);
  assert.match(prompt, /第二类：原片有、这个命题没接住的机制/u);
  assert.match(prompt, /第一类怎么修：把链接上，不要加戏/u);
  assert.match(prompt, /第二类怎么修：先判断该不该接，接就得腾位置/u);
  assert.match(prompt, /外部认可被转手送给在乎的人/u);
  assert.match(prompt, /S6 把小红花别到长辈身上/u);
});

// 评审只负责指出来，不负责替命题决定。硬塞一条与立意冲突的机制不是修订，是换了个故事。
test("接机制有明确的拒绝出口，而且拒绝必须说理由", () => {
  const prompt = storyCandidateRevisionPrompt({
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"]),
    unmigratedMechanisms: candidateUnmigratedMechanisms(reviewWithMechanisms(), "V1")
  });
  assert.match(prompt, /不等于这个命题必须去接它/u);
  assert.match(prompt, /和这个命题的立意冲突就别接/u);
  assert.match(prompt, /不要假装接了，也不要沉默地跳过/u);
  assert.match(prompt, /要接就必须腾位置/u);
  assert.match(prompt, /哪几条你决定不接、理由是什么/u);
});

// 换个更强的道具让链条表面通了、故事一点没变——这正是 09-10 那次修订的形状。
test("提示词点破「换个更好用的道具」只是绕过问题", () => {
  const prompt = storyCandidateRevisionPrompt({
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"]),
    coherenceBreaks: [{ kind: "space_or_time", beatIndexes: [2], problem: "够不到" }]
  });
  assert.match(prompt, /换一个更好用的道具往往只是绕过问题/u);
  assert.match(prompt, /这件事本来就不该这么办/u);
});

test("两类都没有时提示词明说不要修订", () => {
  const prompt = storyCandidateRevisionPrompt({
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"])
  });
  assert.match(prompt, /评审什么问题都没报出来/u);
  // 查的是标题小节。铁律 4 里顺带提到两类是有意的，那是通用约束的说明。
  assert.ok(!/## 第一类/u.test(prompt), "没有断裂时不该出现第一类的标题小节");
  assert.ok(!/## 第二类/u.test(prompt), "没有未接机制时不该出现第二类的标题小节");
});

test("修订入口同时认因果断裂和没接住的机制", () => {
  assert.match(APP_JS, /entry\?\.verdict === "not_depicted" \|\| entry\?\.verdict === "partially_depicted"/u);
  assert.match(APP_JS, /条没接住的原片机制/u);
  assert.ok(!/data-revise-candidate[\s\S]{0,200}check\.verdict/u.test(APP_JS), "入口仍不得由 verdict 决定");
});

test("mock 把两个驱动信号都写进 changeSummary，demo 才走得到两个分支", () => {
  const batch = themeVariants();
  const revision = mockStoryCandidateRevision(
    batch.variants[0],
    [{ kind: "other", beatIndexes: [1], problem: "x" }],
    [{ id: "M2", mechanism: "转赠", whereInSource: "S6", verdict: "not_depicted", causeEvidence: "", actionEvidence: "无", beatIndexes: [] }]
  );
  assert.match(revision.changeSummary, /1 条因果问题/u);
  assert.match(revision.changeSummary, /1 条没接住的原片机制/u);
  assert.doesNotThrow(() => ensureStoryCandidateRevisionContract(revision, batch, "V1"));
});

// ---------------------------------------------------------------------------
// 展开前体检触发的根问题修订（scope: "root"，2026-09-16）

const ROOT_PROMISE_CHECK = () => ({
  schemaVersion: "full-story-promise-check/2.0",
  candidateId: "V1",
  promises: [
    {
      source: "title",
      quote: "第一个",
      kind: "promise",
      promise: "观众期待看到排在第一位的那件事",
      mustSee: ["那件事的完整过程"],
      findings: [{ mustSeeIndex: 0, found: true, beat: 1, evidence: "第一拍原文", why: "" }],
      verdict: "realized"
    },
    {
      source: "oneLineHook",
      quote: "钩子",
      kind: "promise",
      promise: "观众期待钩子里的问题被回答",
      mustSee: ["问题的答案在画面里出现"],
      findings: [{ mustSeeIndex: 0, found: false, beat: 0, evidence: "", why: "第 3 拍直接宣布了结果，过程没有演出来" }],
      verdict: "not_realized"
    }
  ]
});

// 展开前体检的评审只送了一个候选：报告恰好一条。
function singleReviewFor(id, mutate = (check) => check) {
  const source = REVIEW.candidateChecks.find((check) => check.candidateId === id);
  return {
    ...structuredClone(REVIEW),
    candidateChecks: [mutate(structuredClone(source))],
    holisticPreferenceOrder: [id]
  };
}

const ROOT_INPUT = (overrides = {}) => ({
  themeVariants: themeVariants(),
  review: singleReviewFor("V1"),
  candidateId: "V1",
  scope: "root",
  promiseCheck: ROOT_PROMISE_CHECK(),
  ...overrides
});

test("手动修订提示词：不传新参数与显式传默认值逐字相同，且不含体检小节", () => {
  const args = {
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"]),
    coherenceBreaks: [{ kind: "other", beatIndexes: [1], problem: "x" }],
    unmigratedMechanisms: [{ id: "M1", mechanism: "机制", whereInSource: "S1", verdict: "not_depicted", actionEvidence: "无", causeEvidence: "", beatIndexes: [] }],
    targetDurationSeconds: 60
  };
  const manual = storyCandidateRevisionPrompt(args);
  assert.equal(manual, storyCandidateRevisionPrompt({
    ...args, promiseGaps: [], scaffoldCopy: null, blockerDefect: null, scope: ""
  }));
  // 手动路径下即使误传了体检信号也不生效：新小节只在 scope: root 时出现。
  assert.equal(manual, storyCandidateRevisionPrompt({
    ...args,
    promiseGaps: ROOT_PROMISE_CHECK().promises.slice(1),
    scaffoldCopy: { score: 90, why: "x", links: [{ sourceEvent: "a", candidateEvent: "b", beatIndexes: [1], linkage: "same" }] },
    blockerDefect: { type: "causalLogic", description: "x" }
  }));
  for (const marker of ["展开前体检", "标题或钩子许诺的东西没有被演出来", "与原片是同一条事件链", "评审判定的硬伤"]) {
    assert.ok(!manual.includes(marker), `手动修订提示词不该出现「${marker}」`);
  }
  assert.match(manual, /一份对照评审在下面这个命题里查出了两类问题/u);
  assert.match(manual, /第二类里\*\*哪几条你决定不接、理由是什么\*\*/u);
});

test("scope=root 不送未迁移机制，体检的三类小节按信号出现", () => {
  const base = {
    candidate: candidate("V1", "命题一", ["动作一", "动作二", "动作三"]),
    unmigratedMechanisms: [{ id: "M1", mechanism: "原片机制正文", whereInSource: "S1", verdict: "not_depicted", actionEvidence: "无", causeEvidence: "", beatIndexes: [] }],
    scope: "root"
  };
  const onlyPromise = storyCandidateRevisionPrompt({ ...base, promiseGaps: ROOT_PROMISE_CHECK().promises.slice(1) });
  assert.ok(!onlyPromise.includes("原片机制正文"), "体检修订不送未迁移机制");
  assert.ok(!/## 第二类/u.test(onlyPromise));
  assert.match(onlyPromise, /## 标题或钩子许诺的东西没有被演出来（必须修）/u);
  assert.match(onlyPromise, /【钩子】「钩子」/u);
  assert.match(onlyPromise, /第 3 拍直接宣布了结果/u);
  assert.match(onlyPromise, /承诺没演出来怎么修/u);
  assert.match(onlyPromise, /不要让同一只手同时做两件事/u);
  assert.ok(!onlyPromise.includes("与原片是同一条事件链"));
  assert.ok(!onlyPromise.includes("评审判定的硬伤"));
  assert.match(onlyPromise, /展开前体检在下面这个命题里查出了会被带进完整剧情的根问题/u);

  const withScaffold = storyCandidateRevisionPrompt({
    ...base,
    scaffoldCopy: {
      score: 80,
      why: "准备、运送、获奖、转赠的顺序一样",
      links: [{ sourceEvent: "获得外部奖励", candidateEvent: "被奖励一件东西", beatIndexes: [3], linkage: "same" }]
    },
    blockerDefect: { type: "causalLogic", description: "结果与前面的动作矛盾" }
  });
  assert.match(withScaffold, /## 与原片是同一条事件链（必须修）/u);
  assert.match(withScaffold, /原片「获得外部奖励」→ 本命题「被奖励一件东西」（第 3 拍，接法与原片相同）/u);
  assert.match(withScaffold, /## 评审判定的硬伤（必须修）/u);
  assert.match(withScaffold, /【因果逻辑[^】]*】结果与前面的动作矛盾/u);
  assert.ok(!withScaffold.includes("标题或钩子许诺的东西没有被演出来"));
});

test("换皮与硬伤提取器与评审的降级条件一致", () => {
  const below = singleReviewFor("V1");
  assert.equal(candidateScaffoldCopy(below, "V1"), null, "分数低于换皮线不送任何环节");

  const copied = singleReviewFor("V1", (check) => {
    check.sourceScaffoldOverlap.score = SOURCE_SCAFFOLD_COPY_SCORE;
    check.sourceScaffoldOverlap.eventChain = [
      { sourceEvent: "一", candidateEvent: "甲", beatIndexes: [1], linkage: "same" },
      { sourceEvent: "二", candidateEvent: "乙", beatIndexes: [2], linkage: "reordered" },
      { sourceEvent: "三", candidateEvent: "丙", beatIndexes: [3], linkage: "different" },
      { sourceEvent: "四", candidateEvent: "候选里没有对应事件", beatIndexes: [], linkage: "absent" }
    ];
    return check;
  });
  const scaffoldCopy = candidateScaffoldCopy(copied, "V1");
  assert.equal(scaffoldCopy.score, SOURCE_SCAFFOLD_COPY_SCORE);
  assert.deepEqual(scaffoldCopy.links.map((link) => link.linkage), ["same", "reordered"]);

  assert.equal(candidateBlockerDefect(below, "V1"), null, "MAJOR 不是硬伤信号");
  const blocker = singleReviewFor("V1", (check) => {
    check.dominantDefect = { type: "causalLogic", severity: "BLOCKER", description: "不能带进完整剧情" };
    return check;
  });
  assert.deepEqual(candidateBlockerDefect(blocker, "V1"), { type: "causalLogic", description: "不能带进完整剧情" });
});

// 路由说「有根问题」时，修订必须收得到对应信号，否则修订模型拿到的是一份空清单。
test("体检的每一条路由理由都对应一类修订信号", () => {
  const reviewed = singleReviewFor("V1", (check) => {
    check.sourceScaffoldOverlap.score = 90;
    check.sourceScaffoldOverlap.eventChain = [{ sourceEvent: "一", candidateEvent: "甲", beatIndexes: [1], linkage: "same" }];
    check.dominantDefect = { type: "causalLogic", severity: "BLOCKER", description: "硬伤" };
    return check;
  });
  const validated = ensureStoryCandidateReviewCoversCandidates(
    ensureOutputContract(structuredClone(reviewed), "storyCandidateReview"),
    themeVariants().variants.slice(0, 1)
  );
  const { reasons } = deriveFullStoryPrecheckRoute({
    reviewCheck: validated.candidateChecks[0],
    promiseCheck: ROOT_PROMISE_CHECK()
  });
  assert.deepEqual(reasons, ["coherence_break", "scaffold_copy", "blocker_defect", PROMISE_UNREALIZED_REASON]);
  const signals = {
    coherence_break: candidateCoherenceBreaks(validated, "V1").length > 0,
    scaffold_copy: candidateScaffoldCopy(validated, "V1") !== null,
    blocker_defect: candidateBlockerDefect(validated, "V1") !== null,
    [PROMISE_UNREALIZED_REASON]: promiseCheckGaps(ROOT_PROMISE_CHECK()).length > 0
  };
  for (const reason of reasons) assert.equal(signals[reason], true, `${reason} 没有对应的修订信号`);
});

test("单候选评审报告只在 scope=root 且就是目标命题时接受", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  const out = await workflow.createStoryCandidateRevision(ROOT_INPUT());
  assert.match(out.themeVariants.variants[0].storyOutline[0].action, /demo 模式未调用模型/u);
  // 合并与复验用整批：同批其余命题逐字节不变。
  assert.equal(JSON.stringify(out.themeVariants.variants[1]), JSON.stringify(themeVariants().variants[1]));

  // 手动路径仍要求整批报告。
  await assert.rejects(
    () => workflow.createStoryCandidateRevision({ themeVariants: themeVariants(), review: singleReviewFor("V1"), candidateId: "V1" }),
    (error) => error instanceof InputError && /review 不是这一批命题的合法评审报告/u.test(error.message)
  );
  // 单条报告写的是别的命题：不按候选 id 静默对齐。
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(ROOT_INPUT({ review: singleReviewFor("V2") })),
    InputError
  );
});

test("体检修订的输入错误一律 400", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: null });
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(ROOT_INPUT({ scope: "everything" })),
    /scope 只接受 root/u
  );
  await assert.rejects(
    () => workflow.createStoryCandidateRevision({ ...INPUT(), promiseCheck: ROOT_PROMISE_CHECK() }),
    /promiseCheck 只用于展开前体检触发的修订/u
  );
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(ROOT_INPUT({ promiseCheck: undefined })),
    (error) => error instanceof InputError && /promiseCheck/u.test(error.message)
  );
  const forged = ROOT_PROMISE_CHECK();
  forged.promises[0].quote = "编出来的标题";
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(ROOT_INPUT({ promiseCheck: forged })),
    (error) => error instanceof InputError && /promiseCheck 不是这个命题的合法承诺核对/u.test(error.message)
  );
  // V2 的评审没有任何降级理由、承诺全部兑现：没有根问题就不该走到修订。
  const v2AllRealized = {
    schemaVersion: "full-story-promise-check/2.0",
    candidateId: "V2",
    promises: [
      { source: "title", quote: "第二个", kind: "promise", promise: "p", mustSee: ["m"],
        findings: [{ mustSeeIndex: 0, found: true, beat: 1, evidence: "第一拍原文", why: "" }], verdict: "realized" },
      { source: "oneLineHook", quote: "钩子", kind: "promise", promise: "p", mustSee: ["m"],
        findings: [{ mustSeeIndex: 0, found: true, beat: 2, evidence: "第二拍原文", why: "" }], verdict: "realized" }
    ]
  };
  await assert.rejects(
    () => workflow.createStoryCandidateRevision(ROOT_INPUT({
      promiseCheck: v2AllRealized,
      review: singleReviewFor("V2"),
      candidateId: "V2"
    })),
    /没有报出任何根问题/u
  );
});

test("体检修订走真实调用路径：提示词带承诺小节、不带机制，结果合并复验", async () => {
  const { workflow, prompts } = liveRevisionWorkflow([goodRevision()]);
  const out = await workflow.createStoryCandidateRevision(ROOT_INPUT());
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /标题或钩子许诺的东西没有被演出来/u);
  assert.match(prompts[0], /因果说不通/u);
  assert.ok(!prompts[0].includes("机制一"), "体检修订不送未迁移机制");
  assert.equal(out.themeVariants.variants[0].storyOutline[2].action, "V1 第三拍改过之后的动作");
  assert.equal(out.metadata.storyCandidateRevision.providerCalls, 1);
});

test("demo 修订把体检信号写进 changeSummary", () => {
  const revision = mockStoryCandidateRevision(themeVariants().variants[0], [], [], {
    promiseGaps: ROOT_PROMISE_CHECK().promises.slice(1),
    scaffoldCopy: { score: 90, why: "", links: [] },
    blockerDefect: { type: "causalLogic", description: "" }
  });
  assert.match(revision.changeSummary, /1 条没演出来的承诺/u);
  assert.match(revision.changeSummary, /与原片同一条事件链/u);
  assert.match(revision.changeSummary, /评审判定的硬伤/u);
});
