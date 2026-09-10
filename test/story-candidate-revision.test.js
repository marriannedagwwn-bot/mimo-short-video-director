import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { deriveStoryCandidateProjections } from "../src/validation.js";
import {
  assertOnlyCandidateRevisionFieldsChanged,
  candidateCoherenceBreaks,
  ensureStoryCandidateRevisionContract,
  mergeStoryCandidateRevision
} from "../src/story-candidate-revision.js";
import { storyCandidateRevisionPrompt, storyCandidateRevisionRetryPrompt } from "../src/prompts.js";
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

const REVIEW = {
  schemaVersion: "story-candidate-review/1.0",
  sourceMechanisms: [
    { id: "M1", mechanism: "机制一", whereInSource: "S1" },
    { id: "M2", mechanism: "机制二", whereInSource: "S2" }
  ],
  candidateChecks: [
    {
      candidateId: "V1",
      title: "第一个",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [{ sourceMechanismId: "M1", whereInCandidate: "第 1 拍", beatIndexes: [1], verdict: "depicted" }],
      coherenceChecks: [{ kind: "purpose_nullified", beatIndexes: [2, 3], problem: "任务目的在第 3 拍被抵消" }],
      verdict: "revise",
      why: "因果不自洽",
      keepThis: "陪伴的调子"
    },
    {
      candidateId: "V2",
      title: "第二个",
      coreInteraction: { setback: "a", intervention: "b", response: "c", visibleChange: "d" },
      mechanismChecks: [{ sourceMechanismId: "M2", whereInCandidate: "第 2 拍", beatIndexes: [2], verdict: "depicted" }],
      coherenceChecks: [],
      verdict: "pass",
      why: "没问题",
      keepThis: "结尾"
    }
  ],
  recommendedOrder: ["V2", "V1"],
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
