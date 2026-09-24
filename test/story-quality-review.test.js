import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// **必须用 mockNarrativeFullStory，不能用 legacy mockFullStory。**
// 1.0 的测试喂的是 legacy 形状（还带 retentionPlan），所以全绿的同时，
// 这个阶段在生产里真正会收到的 full_story/1.1 从没被测过——契约都换了两版了。
import { mockNarrativeFullStory, mockStoryQualityReview, mockVariants } from "../src/mock.js";
import { storyQualityEditorialPrompt, storyQualityPromisePrompt } from "../src/prompts.js";
import {
  PROMISE_CHECK_STATUSES,
  PROMISE_SOURCE_FIELDS,
  STORY_QUALITY_ISSUE_TYPES,
  STORY_QUALITY_ISSUE_TYPE_LABELS,
  storyReviewHeadline,
  storyReviewMetrics
} from "../public/story-review-metrics.js";
import { WorkflowService } from "../src/workflow.js";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import {
  assembleStoryQualityReview,
  buildStoryQualityCandidateProjection,
  deriveStoryQualityPromiseStatus
} from "../src/story-quality-review.js";
import {
  ensureOutputContract,
  ensureStoryQualityEditorialContract,
  ensureStoryQualityPromiseContract,
  ensureStoryQualityReviewCoversStory,
  OutputContractError
} from "../src/validation.js";

const context = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版狼耳少女", vertical: "治愈/温情/日常", constraints: "" },
  variant: { id: "V1", title: "测试变体" }
});

const story = () => mockNarrativeFullStory(context);
const candidateOf = (value) => buildStoryQualityCandidateProjection(
  mockVariants(context).variants.find((item) => item.id === value.selectedVariantId)
  || mockVariants(context).variants[0]
);

function reviewFor(value) {
  const candidate = candidateOf(value);
  const mock = mockStoryQualityReview(value, candidate);
  return assembleStoryQualityReview({ fullStory: value, candidate, ...mock });
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

test("合法评审通过递归 strict schema 与覆盖核验", () => {
  const value = story();
  assert.doesNotThrow(() => ensureStoryQualityReviewCoversStory(
    ensureOutputContract(reviewFor(value), "storyQualityReview"),
    value
  ));
});

test("多字段、缺字段、错枚举值都被递归拒绝", () => {
  const base = reviewFor(story());

  assert.ok(codes(() => ensureOutputContract({ ...base, extra: 1 }, "storyQualityReview"))
    .includes("STORY_QUALITY_REVIEW_SCHEMA_UNKNOWN_FIELD"));

  const missing = { ...base };
  delete missing.promisePreservation;
  assert.ok(codes(() => ensureOutputContract(missing, "storyQualityReview")).length);

  const badType = structuredClone(base);
  badType.issues[0].type = "made_up_type";
  assert.ok(codes(() => ensureOutputContract(badType, "storyQualityReview")).length);

  const badSource = structuredClone(base);
  badSource.promisePreservation.checks[0].source = ["characterBible"];
  assert.ok(
    codes(() => ensureOutputContract(badSource, "storyQualityReview")).length,
    "剧情自己的 characterBible 必须被 schema 枚举挡住"
  );
});

test("schema 的三个枚举与共享常量逐项相等", () => {
  // 两边各写一份枚举，迟早漂成「提示词教一套、校验器认另一套」。
  const schema = JSON.parse(fs.readFileSync(
    new URL("../src/contracts/schemas/story-quality-review-strict.schema.json", import.meta.url),
    "utf8"
  ));
  assert.deepEqual(schema.$defs.promiseCheck.properties.source.items.enum, [...PROMISE_SOURCE_FIELDS]);
  assert.deepEqual(schema.$defs.promiseCheck.properties.status.enum, [...PROMISE_CHECK_STATUSES]);
  assert.deepEqual(schema.$defs.issue.properties.type.enum, [...STORY_QUALITY_ISSUE_TYPES]);
});

// ---- 中间输出的校验器：必须在合成之前拦住，否则会静默丢数据 ----

test("编辑诊断输出：issues 不是数组时硬失败，不能被悄悄当成空数组", () => {
  const value = story();
  const found = codes(() => ensureStoryQualityEditorialContract(
    { summary: "还行", issues: "oops" },
    value
  ));
  assert.ok(found.includes("STORY_REVIEW_EDITORIAL_ISSUES_INVALID"));
});

test("编辑诊断输出：未知 type、空 sceneIds、不存在的场次各自被拦", () => {
  const value = story();
  const sceneId = value.sceneScript[0].sceneId;
  const base = (over) => ({
    summary: "s",
    issues: [{ issueId: "FS-001", type: "causal_logic", severity: "MINOR", sceneIds: [sceneId], ...over }]
  });
  assert.ok(codes(() => ensureStoryQualityEditorialContract(base({ type: "nope" }), value))
    .includes("STORY_REVIEW_EDITORIAL_TYPE_UNKNOWN"));
  assert.ok(codes(() => ensureStoryQualityEditorialContract(base({ sceneIds: [] }), value))
    .includes("STORY_REVIEW_EDITORIAL_SCENE_IDS_MISSING"));
  assert.ok(codes(() => ensureStoryQualityEditorialContract(base({ sceneIds: ["S404"] }), value))
    .includes("STORY_REVIEW_UNKNOWN_SCENE_ID"));
});

test("承诺输出：source 只能是候选字段，剧情自己的字段被拦", () => {
  const ok = { checks: [{ promise: "p", source: ["emotionalPayoff"], status: "PRESERVED", evidence: "e" }] };
  assert.doesNotThrow(() => ensureStoryQualityPromiseContract(ok));

  const selfEvidencing = { checks: [{ promise: "p", source: ["characterBible"], status: "PRESERVED", evidence: "e" }] };
  assert.ok(codes(() => ensureStoryQualityPromiseContract(selfEvidencing))
    .includes("STORY_REVIEW_PROMISE_SOURCE_NOT_CANDIDATE"));

  assert.ok(codes(() => ensureStoryQualityPromiseContract({ checks: [] }))
    .includes("STORY_REVIEW_PROMISE_CHECKS_EMPTY"));
  assert.ok(codes(() => ensureStoryQualityPromiseContract({
    checks: [{ promise: "p", source: ["title"], status: "OK", evidence: "e" }]
  })).includes("STORY_REVIEW_PROMISE_STATUS_UNKNOWN"));
});

// ---- 服务端派生 ----

test("承诺总判定由服务端派生，模型给的值一律被覆盖", () => {
  assert.equal(deriveStoryQualityPromiseStatus([{ status: "PRESERVED" }]), "PASS");
  assert.equal(deriveStoryQualityPromiseStatus([{ status: "PRESERVED" }, { status: "WEAKENED" }]), "WARN");
  assert.equal(deriveStoryQualityPromiseStatus([{ status: "WEAKENED" }, { status: "MISSING" }]), "FAIL");
  assert.equal(deriveStoryQualityPromiseStatus([{ status: "CONTRADICTED" }]), "FAIL");

  const value = story();
  const candidate = candidateOf(value);
  const assembled = assembleStoryQualityReview({
    fullStory: value,
    candidate,
    editorial: { summary: "s", issues: [] },
    // 模型谎报 PASS，但有一条 MISSING——派生必须覆盖成 FAIL。
    promise: { status: "PASS", checks: [{ promise: "p", source: ["title"], status: "MISSING", evidence: "e" }] }
  });
  assert.equal(assembled.promisePreservation.status, "FAIL");
});

test("覆盖核验只裁决引用真实性与 selectedVariantId", () => {
  const value = story();
  const base = reviewFor(value);

  const wrongVariant = { ...base, selectedVariantId: "V99" };
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(wrongVariant, value))
    .includes("STORY_REVIEW_VARIANT_MISMATCH"));

  const ghost = structuredClone(base);
  ghost.issues[0].sceneIds = ["S404"];
  assert.ok(codes(() => ensureStoryQualityReviewCoversStory(ghost, value))
    .includes("STORY_REVIEW_UNKNOWN_SCENE_ID"));
});

// ---- 提示词 ----

test("编辑诊断提示词看不到候选——这是本次收益的来源，必须锁住", () => {
  const value = story();
  const candidate = candidateOf(value);
  const prompt = storyQualityEditorialPrompt({ fullStory: value, fixedCharacter: "小白子" });
  // 候选独有的字段名一个都不能出现在这段提示词里。
  for (const marker of ["oneLineHook", "keyDialogueDirections", "emotionalPayoff", "storyOutline"]) {
    assert.doesNotMatch(prompt, new RegExp(marker, "u"), `编辑诊断提示词不得含候选字段 ${marker}`);
  }
  assert.doesNotMatch(prompt, new RegExp(String(candidate.oneLineHook || "不可能出现的串"), "u"));
});

test("两段提示词逐字含已验证的承重原句", () => {
  const value = story();
  const editorial = storyQualityEditorialPrompt({ fullStory: value, fixedCharacter: "小白子" });
  // 三档严重度与三条红线：第四轮实测靠它把 MAJOR 从 7 降到 2、四条误报逐条消失。
  assert.match(editorial, /只有「明确矛盾」才判 MAJOR 或 BLOCKER/u);
  assert.match(editorial, /就不得判成「物理上不可能」/u);
  assert.match(editorial, /不得先补一个剧情没有给出的不利条件/u);
  assert.match(editorial, /不能把你的概括当成引用/u);
  assert.match(editorial, /普通的生活感受不必都有前置铺垫/u);

  const promise = storyQualityPromisePrompt({ candidate: candidateOf(value), fullStory: value });
  // 台词三档：第三轮实测靠它让同一条承诺在原稿判 PRESERVED、在 C 稿判 MISSING。
  assert.match(promise, /措辞不是承诺，台词里交代的\*\*事实\*\*是/u);
  assert.match(promise, /不能因少写台词丢失剧情前提/u);
  assert.match(promise, /一条检查只放一个能独立判定的命题/u);
  assert.match(promise, /拿剧情当承诺来源，就成了自己声明、自己证明/u);
  for (const field of PROMISE_SOURCE_FIELDS) {
    assert.match(promise, new RegExp(`\`${field}\``, "u"), `source 清单必须把 ${field} 写给模型`);
  }
});

test("编辑诊断提示词逐个定义全部问题类型，并逐字含 dialogue_logic 的承重句", () => {
  const editorial = storyQualityEditorialPrompt({ fullStory: story(), fixedCharacter: "小白子" });
  // 类型定义是手写的，枚举是共享常量——两边各写一份，漏写一类，模型就永远不会报它。
  for (const type of STORY_QUALITY_ISSUE_TYPES) {
    assert.match(editorial, new RegExp(`\`${type}\``, "u"), `编辑诊断提示词必须定义 ${type}`);
  }
  // 2026-09-18 两轮实测（docs/story-review-dialogue-response-ab-2026-09-18.md）：第一版只问方向，
  // 毛豆 0/2；换成「不靠猜说出他在谢什么」之后 2/2、新正例 8/8，12 次反例里方向正确的道谢 0 次被报。
  assert.match(editorial, /\*\*观众能不能不靠猜，就说出他在谢什么、为什么道歉、在夸什么？\*\*/u);
  assert.match(editorial, /没演出来的「隐性付出」「平时的照顾」不能拿来替它圆/u);
  // 剧情自己的角色表把「双手捧脸颊表达感谢」登记成招牌动作，评审就读成「严格符合设定」——这一句专堵它。
  assert.match(editorial, /角色表里登记的招牌动作，只说明他能这样说，不说明这里该说/u);

  // 举例一律是抽象形状，不含参考片或候选的具体名词（§2.12b ⑤）。
  const bullet = editorial.slice(editorial.indexOf("- `dialogue_logic`"), editorial.indexOf("## 报问题之前先分清三档"));
  assert.ok(bullet.length > 50, "没切到 dialogue_logic 那一段，下面的断言会恒真");
  for (const noun of ["谢谢", "毛豆", "奶奶", "小白子", "蒲扇"]) {
    assert.doesNotMatch(bullet, new RegExp(noun, "u"), `dialogue_logic 的判据里不许出现具体名词「${noun}」`);
  }
});

test("dialogue_logic 过得了严格 schema 与编辑诊断校验，每一类都有中文标签，浏览器渲染成「台词接不上」", async () => {
  const value = story();
  const review = reviewFor(value);
  review.issues[0].type = "dialogue_logic";
  assert.doesNotThrow(() => ensureOutputContract(structuredClone(review), "storyQualityReview"));
  assert.doesNotThrow(() => ensureStoryQualityEditorialContract(
    { summary: "s", issues: [structuredClone(review.issues[0])] },
    value
  ));

  for (const type of STORY_QUALITY_ISSUE_TYPES) {
    assert.ok(STORY_QUALITY_ISSUE_TYPE_LABELS[type], `${type} 缺中文标签，页面上会直接露出英文标识`);
  }
  const app = await loadAppUi({ story: true });
  assert.match(app.renderStoryQualityReview(review, {}), /台词接不上/u);
});

// ---- 工作流：demo 与 live 两条路 ----

test("demo 模式走通两次调用的合成，并且会走到派生 FAIL 分支", async () => {
  const service = new WorkflowService({ clients: {}, stageDefaults: {} });
  const value = story();
  const result = await service.createStoryQualityReview({
    fullStory: value,
    themeVariants: mockVariants(context),
    candidateId: value.selectedVariantId,
    creatorProfile: context.creatorProfile
  });
  assert.equal(result.review.schemaVersion, "story-quality-review/2.0");
  // mock 刻意含一条 CONTRADICTED：全判 PRESERVED 会让 demo 永远走不到这个分支。
  assert.equal(result.review.promisePreservation.status, "FAIL");
  assert.ok(result.review.issues.length >= 1);
  assert.ok(Object.hasOwn(result.metadata, "storyQualityReview"));
});

test("live 路径：两次顺序调用、第一次被拦下时带诊断重做一次、禁止第三次", async () => {
  const value = story();
  const prompts = [];
  let editorialCalls = 0;
  const sceneId = value.sceneScript[0].sceneId;
  const goodEditorial = () => JSON.stringify({
    summary: "还行",
    issues: [{
      issueId: "FS-001", type: "causal_logic", severity: "MINOR", sceneIds: [sceneId],
      evidence: "e", problem: "p", viewerImpact: "v", confidence: "low", optionalSuggestion: ""
    }]
  });
  const client = {
    async generateJson() { throw new Error("本阶段必须走 coordinator"); },
    async requestCompletion({ prompt }) {
      prompts.push(prompt);
      if (prompt.includes("你是这部短视频的**终审编辑**")) {
        editorialCalls += 1;
        // 第一次故意写一个不存在的场次，逼出确定性诊断与重试。
        if (editorialCalls === 1) {
          return { content: JSON.stringify({ summary: "s", issues: [{ issueId: "FS-001", type: "causal_logic", severity: "MINOR", sceneIds: ["S404"], evidence: "e", problem: "p", viewerImpact: "v", confidence: "low", optionalSuggestion: "" }] }) };
        }
        return { content: goodEditorial() };
      }
      return { content: JSON.stringify({
        checks: [{ promise: "p", source: ["oneLineHook"], status: "PRESERVED", evidence: "e" }]
      }) };
    }
  };
  const service = new WorkflowService({
    clients: { MiMo: client },
    stageDefaults: { storyQualityReview: { provider: "MiMo", model: "m", maxCompletionTokens: 4096 } }
  });
  const result = await service.createStoryQualityReview({
    fullStory: value,
    themeVariants: mockVariants(context),
    candidateId: value.selectedVariantId,
    creatorProfile: context.creatorProfile
  });
  assert.equal(editorialCalls, 2, "第一次被拦下之后应当只重做一次");
  assert.equal(result.metadata.storyQualityReview.providerCalls, 3, "两次编辑诊断 + 一次承诺核对");
  assert.equal(result.metadata.storyQualityReview.rejections.length, 1, "被拦过一次就必须如实上报");
  // 重试正文必须把校验器数出来的诊断追加进去，只说「你错了」第二次只会重复第一次。
  assert.match(prompts[1], /上一次的输出被确定性校验拦下了/u);
  assert.match(prompts[1], /STORY_REVIEW_UNKNOWN_SCENE_ID/u);
  // 承诺核对必须发生在编辑诊断之后，且它才是拿到候选的那一次。
  assert.match(prompts[2], /这个选题承诺的东西/u);
});

test("live 路径：第二次仍被拦即 fail closed，两次诊断都带出来", async () => {
  const value = story();
  const client = {
    async requestCompletion() {
      return { content: JSON.stringify({ summary: "s", issues: [{ issueId: "FS-001", type: "causal_logic", severity: "MINOR", sceneIds: ["S404"], evidence: "e", problem: "p", viewerImpact: "v", confidence: "low", optionalSuggestion: "" }] }) };
    }
  };
  const service = new WorkflowService({
    clients: { MiMo: client },
    stageDefaults: { storyQualityReview: { provider: "MiMo", model: "m", maxCompletionTokens: 4096 } }
  });
  await assert.rejects(() => service.createStoryQualityReview({
    fullStory: value,
    themeVariants: mockVariants(context),
    candidateId: value.selectedVariantId,
    creatorProfile: context.creatorProfile
  }), (error) => {
    // 序号挂在 metadata.attempt 上——额外字段就是这么被 ValidationDiagnostic.toJSON 带出去的。
    const attempts = new Set((error.diagnostics || [])
      .map((detail) => detail?.metadata?.attempt)
      .filter((value) => Number.isFinite(value)));
    assert.ok(attempts.has(1) && attempts.has(2), "两次都被拦时，两次的诊断都要在响应里");
    return true;
  });
});

// ---- 接线源码锁 ----

test("服务端接线与侧车 scope 由源码断言锁住", () => {
  const serverJs = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(serverJs, /"\/api\/story-quality-review": \(body\) => workflow\.createStoryQualityReview\(body\)/u);
  // scope 必须逐字等于 stage 名：Map 按 scope 建、按 stage 查，对不上就静默不写侧车。
  assert.match(serverJs, /MODEL_OUTPUT_LOG_SCOPES\.STORY_QUALITY_REVIEW/u);

  const workflowJs = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
  // normalizeStageDefaults 漏掉这个阶段会让任何非服务端调用在调模型之前就 InputError。
  assert.match(workflowJs, /storyQualityReview: \{\s*\n\s*provider: fallback\.storyProvider/u);
});

// 消费者面要真的跑一遍，不能只靠源码断言——⑤⑥ 那次就是渲染器漏改、页面两处空白而不报错。
test("浏览器：请求体带上候选，渲染出承诺块与诊断块", async () => {
  const value = story();
  const review = reviewFor(value);
  // 造一条没守住的承诺与一条带建议的 issue，保证两块与免责说明都会被渲染到。
  review.promisePreservation.checks[1].status = "CONTRADICTED";
  review.issues[0].optionalSuggestion = "把这个动作改成先放下再托腮";
  const calls = [];
  const app = await loadAppUi({
    story: true,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { review, metadata: {} } }) };
    }
  });
  const button = { disabled: false, textContent: "检查剧情硬伤" };
  const body = app.elements.fullStory.querySelector("[data-story-review-body]")
    || (() => { throw new Error("harness 里拿不到体检面板容器"); })();
  await app.runStoryQualityReview(value, button);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/story-quality-review");
  // 承诺核对要拿候选当外部参照，缺了它这一档就退回 1.0 的重言式。
  assert.ok(calls[0].body.themeVariants, "请求体必须带 themeVariants");
  assert.equal(calls[0].body.candidateId, value.selectedVariantId);
  assert.ok(Object.hasOwn(calls[0].body, "creatorProfile"));

  assert.match(body.innerHTML, /候选承诺没守住的地方/u);
  assert.match(body.innerHTML, /做了相反的事/u, "承诺状态要出中文标签");
  assert.match(body.innerHTML, /编辑诊断/u);
  assert.match(body.innerHTML, /动作密度过载/u, "issue 类型要出中文标签");
  assert.match(body.innerHTML, /仅供参考，系统不会自动执行/u);
  // 1.0 那两张表的对象已经不存在，不能再出现在页面上。
  assert.doesNotMatch(body.innerHTML, /声明与画面对不上/u);
  assert.equal(button.disabled, false, "跑完要把按钮放回去");
});

test("浏览器：拦过一次必须显示出来，花掉的钱不能藏起来", async () => {
  const value = story();
  const app = await loadAppUi({ story: true });
  const html = app.renderStoryQualityReview(reviewFor(value), {
    storyQualityReview: { provider: "Qwen", model: "m", providerCalls: 3, rejections: [{ message: "x", details: [] }] }
  });
  assert.match(html, /有一次调用被确定性校验拦下/u);
  assert.doesNotMatch(
    app.renderStoryQualityReview(reviewFor(value), { storyQualityReview: { providerCalls: 2 } }),
    /被确定性校验拦下/u
  );
});

// ---- 可比对数字 ----

test("metrics 与 headline 数的是候选承诺，不再数留存", () => {
  const value = story();
  const review = reviewFor(value);
  const metrics = storyReviewMetrics(review);
  assert.equal(metrics.promisesChecked, review.promisePreservation.checks.length);
  assert.equal(metrics.promisesBroken, 1);
  assert.equal(metrics.issueCount, review.issues.length);
  assert.ok(!Object.hasOwn(metrics, "retention"), "留存那一半的对象在 full_story/1.1 里已经不存在");
  assert.match(storyReviewHeadline(review), /候选承诺 2 条：1 条没守住/u);
  assert.equal(storyReviewHeadline(null), "");
});
