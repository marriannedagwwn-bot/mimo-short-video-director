import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION,
  animationShotDialogueRepairPrompt,
  mergeAnimationShotDialogueRepair,
  planAnimationShotDialogueRepair
} from "../src/animation-shot-dialogue-repair.js";
import {
  NO_BACKGROUND_MUSIC_SENTENCE,
  ensureAnimationShotBatchContract,
  shotDialogueMissingFromVideoPrompt
} from "../src/validation.js";

const LINE = "哎呀，你这孩子，怎么趴地上了，快起来让奶奶看看摔着没";

function shot(overrides = {}) {
  return {
    shotId: "A06",
    sourceSceneId: "S6",
    sceneId: "LOC02",
    durationSeconds: 6,
    storyPurpose: "收束祖孙关系",
    emotionalTarget: "温暖",
    videoPrompt: `奶奶推门走出来，看见小白子趴在地上，笑着走过去摸摸她的猫耳。${NO_BACKGROUND_MUSIC_SENTENCE}`,
    cameraMotion: "中景拍奶奶推门走出 → 摸猫耳的温馨特写",
    characterAction: "奶奶走出并摸小白子的猫耳",
    dialogueOrSubtitle: LINE,
    soundDesign: "院子里的环境声与脚步声",
    continuityNotes: "奶奶、小白子与被子位置连续",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["奶奶与小白子同框完整入画"],
    ...overrides
  };
}

const validate = (candidate) => ensureAnimationShotBatchContract(candidate, { promptSchemaVersion: "3.0" });

function planFor(candidate) {
  let error;
  try { validate(structuredClone(candidate)); } catch (caught) { error = caught; }
  assert.equal(error?.details?.[0]?.code, "DIRECT_SHOT_DIALOGUE_MISSING_FROM_VIDEO_PROMPT");
  return { plan: planAnimationShotDialogueRepair(candidate, error), error };
}

function envelope(plan, replacement, repairId = "D1") {
  return {
    schemaVersion: ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION,
    baseDigest: plan.baseDigest,
    repairs: [{ repairId, replacement }]
  };
}

function insertBeforeMusic(original, addition) {
  const head = original.slice(0, original.length - NO_BACKGROUND_MUSIC_SENTENCE.length);
  return `${head}${addition}${NO_BACKGROUND_MUSIC_SENTENCE}`;
}

test("补写把缺失台词插回 videoPrompt，并从头通过完整批次校验", () => {
  const candidate = { shotPlan: [shot()] };
  const { plan } = planFor(candidate);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].pointer, "/shotPlan/0/videoPrompt");
  assert.equal(plan.targets[0].missingLines, LINE);

  // 第二次请求只带目标当前值与缺失台词，不得夹带整份批次以外的上游数据。
  const prompt = animationShotDialogueRepairPrompt(plan);
  assert.match(prompt, /ANIMATION_SHOT_DIALOGUE_REPAIR_V1/u);
  assert.match(prompt, new RegExp(LINE, "u"));
  assert.doesNotMatch(prompt, /creatorProfile|visualGuardrails|fixedCharacterBoundary/u);
  // Qwen 的 response_format: json_object 要求 messages 里必须出现 "json" 这个词，
  // 否则整个请求被 400 拒掉（InternalError.Algo.InvalidParameter）。模板里的
  // JSON.stringify 求值后不会留下这个词，所以必须显式检查生成出来的文本。
  assert.match(prompt, /JSON/u);

  const merged = mergeAnimationShotDialogueRepair(
    candidate,
    envelope(plan, insertBeforeMusic(candidate.shotPlan[0].videoPrompt, `奶奶笑着说「${LINE}」。`)),
    plan
  );
  assert.equal(shotDialogueMissingFromVideoPrompt(merged.shotPlan[0]), "");
  assert.doesNotThrow(() => validate(structuredClone(merged)));
  // 原候选不被改动：合并发生在克隆上。
  assert.equal(shotDialogueMissingFromVideoPrompt(candidate.shotPlan[0]), LINE);
});

test("补写只能插入：删改原文、挤掉收尾句、没带台词原话都硬失败", () => {
  const candidate = { shotPlan: [shot()] };
  const { plan } = planFor(candidate);
  const original = candidate.shotPlan[0].videoPrompt;

  assert.throws(
    () => mergeAnimationShotDialogueRepair(candidate, envelope(plan, `换一条全新的提示词，奶奶说「${LINE}」。${NO_BACKGROUND_MUSIC_SENTENCE}`), plan),
    /改动了原文/u
  );
  assert.throws(
    () => mergeAnimationShotDialogueRepair(candidate, envelope(plan, `${original.slice(0, original.length - NO_BACKGROUND_MUSIC_SENTENCE.length)}奶奶说「${LINE}」。`), plan),
    /仍然是整条提示词的最后一句/u
  );
  assert.throws(
    () => mergeAnimationShotDialogueRepair(candidate, envelope(plan, insertBeforeMusic(original, "奶奶絮絮说了几句关心的话。")), plan),
    /缺少台词原话/u
  );
  assert.throws(
    () => mergeAnimationShotDialogueRepair(candidate, envelope(plan, original), plan),
    /没有插入任何内容/u
  );
});

test("信封协议本身受约束：字段、数量、repairId、baseDigest 都不可偏离", () => {
  const candidate = { shotPlan: [shot()] };
  const { plan } = planFor(candidate);
  const good = insertBeforeMusic(candidate.shotPlan[0].videoPrompt, `奶奶说「${LINE}」。`);

  assert.throws(() => mergeAnimationShotDialogueRepair(candidate, {
    ...envelope(plan, good), path: "/shotPlan/0/videoPrompt"
  }, plan), /只允许字段/u);
  assert.throws(() => mergeAnimationShotDialogueRepair(candidate, envelope(plan, good, "D2"), plan), /repairId 必须等于 D1/u);
  assert.throws(() => mergeAnimationShotDialogueRepair(candidate, {
    ...envelope(plan, good), baseDigest: "0".repeat(64)
  }, plan), /baseDigest 与冻结候选不一致/u);
  assert.throws(() => mergeAnimationShotDialogueRepair(candidate, {
    ...envelope(plan, good), repairs: []
  }, plan), /必须返回 1 个 repairs/u);

  // 计划身份由服务端私有签发：模型手里的序列化副本不能当作可合并计划。
  assert.throws(
    () => mergeAnimationShotDialogueRepair(candidate, envelope(plan, good), JSON.parse(JSON.stringify(plan))),
    /不是服务端签发的实例/u
  );
});

test("不属于台词缺失的失败一律不进入补写通道", () => {
  // 时长非法：诊断码不同，必须 fail closed 而不是借道补写。
  const candidate = { shotPlan: [shot({ durationSeconds: 99 })] };
  let error;
  try { validate(structuredClone(candidate)); } catch (caught) { error = caught; }
  assert.ok(error);
  assert.equal(planAnimationShotDialogueRepair(candidate, error), null);

  // 对白本身为空时没有任何可补的原话。
  const noDialogue = { shotPlan: [shot({ dialogueOrSubtitle: "" })] };
  assert.doesNotThrow(() => validate(structuredClone(noDialogue)));
});

// 上面测的是协议本身。这条测接线：走 WorkflowService 的批次评估路径，
// 确认补写真的被触发、预算只有一次、失败一律 fail closed。
test("批次评估在台词缺失时触发一次补写，成功后返回校验通过的批次", async () => {
  const { WorkflowService } = await import("../src/workflow.js");
  const original = shot().videoPrompt;
  let repairCalls = 0;
  const client = {
    async generateJson({ prompt }) {
      repairCalls += 1;
      assert.match(prompt, /ANIMATION_SHOT_DIALOGUE_REPAIR_V1/u);
      return {
        schemaVersion: ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION,
        baseDigest: JSON.parse(prompt.match(/"baseDigest":("[a-f0-9]{64}")/u)[1]),
        repairs: [{ repairId: "D1", replacement: insertBeforeMusic(original, `奶奶笑着说「${LINE}」。`) }]
      };
    }
  };
  const workflow = new WorkflowService();
  const outcome = await workflow.evaluateAnimationShotBatchCandidate({
    client,
    model: "test-model",
    maxCompletionTokens: 8192,
    candidate: { shotPlan: [shot()] },
    validate,
    policy: { allowBatchRetry: false, allowPatch: false }
  });

  assert.equal(repairCalls, 1, "补写预算严格一次模型调用");
  assert.equal(outcome.status, "success");
  assert.equal(shotDialogueMissingFromVideoPrompt(outcome.batch.shotPlan[0]), "");
});

test("补写结果仍然不合规时 fail closed，不做第二次尝试", async () => {
  const { WorkflowService } = await import("../src/workflow.js");
  let repairCalls = 0;
  const client = {
    async generateJson({ prompt }) {
      repairCalls += 1;
      // 模型没把台词插进去：必须被 merge 拦下，且不再重试。
      return {
        schemaVersion: ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION,
        baseDigest: JSON.parse(prompt.match(/"baseDigest":("[a-f0-9]{64}")/u)[1]),
        repairs: [{ repairId: "D1", replacement: insertBeforeMusic(shot().videoPrompt, "奶奶说了句关心的话。") }]
      };
    }
  };
  const workflow = new WorkflowService();
  const outcome = await workflow.evaluateAnimationShotBatchCandidate({
    client,
    model: "test-model",
    maxCompletionTokens: 8192,
    candidate: { shotPlan: [shot()] },
    validate,
    policy: { allowBatchRetry: false, allowPatch: false }
  });

  assert.equal(repairCalls, 1, "失败后不得再次调用模型");
  assert.equal(outcome.status, "recoverable_failure");
  assert.match(outcome.error.message, /没有写入 dialogueOrSubtitle 的台词原话/u);
});
