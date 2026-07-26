import test from "node:test";
import assert from "node:assert/strict";
import { compileAnimationShotPrompts } from "../src/animation-prompt-compiler.js";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import {
  StaticFrameCompilerProtocolError,
  StaticFrameCompilerTransportError
} from "../src/static-frame-compiler.js";
import { OutputContractError, ensureAnimationShotBatchContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";

const STATIC_PATH = "animationShotBatch.shotPlan[0].startFrame.characters[0].pose";

function animationBatchFixture() {
  const creatorProfile = {
    fixedCharacter: "女孩",
    vertical: "治愈动画",
    constraints: "保持角色一致"
  };
  const creativeBrief = mockBrief({
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const variant = {
    id: "V1",
    title: "八音盒",
    characterSetup: {
      protagonist: "女孩",
      careRecipient: "老人",
      helper: "店员"
    },
    newTask: "修复八音盒",
    emotionalMedium: "旧八音盒",
    environmentPressure: "停电",
    endingRitual: "八音盒恢复播放"
  };
  const fullStory = mockFullStory({ creatorProfile, creativeBrief, variant });
  const plan = mockAnimationPlan({ creatorProfile, creativeBrief, variant, fullStory });
  const shot = structuredClone(plan.shotPlan[0]);
  for (const frameKind of ["startFrame", "endFrame"]) {
    for (const character of shot[frameKind].characters) character.actionState = "";
  }
  Object.assign(shot, compileAnimationShotPrompts(shot));
  return { shotPlan: [shot] };
}

function compilerSettings(client) {
  return {
    client,
    provider: "Qwen",
    model: "qwen-static-frame-compiler",
    maxCompletionTokens: 4096,
    requestTimeoutMs: 300000
  };
}

function trustedPoseError() {
  return new OutputContractError("pose 不满足静态帧契约", [{
    code: "STATIC_FRAME_REQUIRED",
    path: STATIC_PATH,
    reason: "pose 必须是单帧可观察状态"
  }]);
}

test("workflow 在 Compiler 后统一重建 alias，并标记最终接受的修改", async () => {
  const rawBatch = animationBatchFixture();
  rawBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒";
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "右手停留在按钮表面";
  rawBatch.shotPlan[0].startFrame.environment.foreground = "木桌边缘";
  rawBatch.shotPlan[0].startFramePrompt = "STALE_ALIAS";
  const animationRequests = [];
  const compilerRequests = [];
  const animationClient = {
    async generateJson(request) {
      animationRequests.push(request);
      if (String(request.prompt).includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
        const marker = "待审核条目（每项严格只有 id、actionState、frameKind）：\n";
        const items = JSON.parse(String(request.prompt).split(marker)[1].split("\n")[0]);
        return {
          results: items.map((item) => ({
            id: item.id,
            verdict: "pass",
            reasonCode: "visible_state"
          }))
        };
      }
      return structuredClone(rawBatch);
    }
  };
  const compilerClient = {
    async generateJson(request) {
      compilerRequests.push(request);
      return {
        patches: [{
          path: STATIC_PATH,
          value: "女孩坐在桌前，身体微微前倾，双手放在八音盒盖子两侧，视线落在八音盒上",
          reasonCode: "future_intent",
          triggerSpans: ["准备打开"],
          visibleFacts: ["身体微微前倾", "双手放在八音盒盖子两侧", "视线落在八音盒上"]
        }]
      };
    }
  };

  const result = await new WorkflowService().generateAnimationShotBatch({
    client: animationClient,
    prompt: "ORIGINAL_BATCH",
    model: "animation-model",
    maxCompletionTokens: 8192,
    compilerSettings: compilerSettings(compilerClient),
    batchIndex: 3,
    repairContext: {},
    validate(candidate) {
      const expected = compileAnimationShotPrompts(candidate.shotPlan[0]);
      assert.equal(candidate.shotPlan[0].startFramePrompt, expected.startFramePrompt);
      assert.notEqual(candidate.shotPlan[0].startFramePrompt, "STALE_ALIAS");
      return ensureAnimationShotBatchContract(candidate);
    }
  });

  assert.equal(animationRequests.length, 2);
  assert.equal(animationRequests.filter((request) => String(request.prompt).includes("ACTION_STATE_SEMANTIC_AUDIT_V1")).length, 1);
  assert.equal(compilerRequests.length, 1);
  assert.equal(result.compilerRuns.length, 1);
  assert.equal(result.compilerRuns[0].provider, "Qwen");
  assert.equal(result.compilerRuns[0].batchIndex, 3);
  assert.equal(result.compilerRuns[0].runAccepted, true);
  assert.equal(result.compilerRuns[0].noOp, false);
  assert.equal(result.compilerRuns[0].modifications[0].applied, true);
  assert.equal(result.compilerRuns[0].modifications[0].finalAccepted, true);
});

test("Compiler protocol 最终失败会终止 stage，不触发 animationShotBatch second-pass", async () => {
  const rawBatch = animationBatchFixture();
  let animationRequests = 0;
  let compilerRequests = 0;
  const animationClient = {
    async generateJson() {
      animationRequests += 1;
      return structuredClone(rawBatch);
    }
  };
  const compilerClient = {
    async generateJson() {
      compilerRequests += 1;
      return { wrong: [] };
    }
  };

  await assert.rejects(
    () => new WorkflowService().generateAnimationShotBatch({
      client: animationClient,
      prompt: "ORIGINAL_BATCH",
      compilerSettings: compilerSettings(compilerClient),
      repairContext: {},
      validate: (candidate) => candidate
    }),
    StaticFrameCompilerProtocolError
  );
  assert.equal(animationRequests, 1);
  assert.equal(compilerRequests, 2);
});

test("Compiler transient transport 用完一次 retry 后直接终止，不触发 batch retry", async () => {
  const rawBatch = animationBatchFixture();
  let animationRequests = 0;
  let compilerRequests = 0;
  const animationClient = {
    async generateJson() {
      animationRequests += 1;
      return structuredClone(rawBatch);
    }
  };
  const compilerClient = {
    async generateJson() {
      compilerRequests += 1;
      const error = new Error("network unavailable");
      error.code = "ENETUNREACH";
      throw error;
    }
  };

  await assert.rejects(
    () => new WorkflowService().generateAnimationShotBatch({
      client: animationClient,
      prompt: "ORIGINAL_BATCH",
      compilerSettings: compilerSettings(compilerClient),
      repairContext: {},
      validate: (candidate) => candidate
    }),
    StaticFrameCompilerTransportError
  );
  assert.equal(animationRequests, 1);
  assert.equal(compilerRequests, 2);
});

test("raw batch 缺少 shotPlan 属于候选结构失败，只重生 batch，不误报 Compiler config", async () => {
  const validBatch = animationBatchFixture();
  const animationPrompts = [];
  let compilerRequests = 0;
  const animationClient = {
    async generateJson(request) {
      animationPrompts.push(String(request.prompt || ""));
      return animationPrompts.length === 1 ? {} : structuredClone(validBatch);
    }
  };
  const compilerClient = {
    async generateJson() {
      compilerRequests += 1;
      return { patches: [] };
    }
  };

  const result = await new WorkflowService().generateAnimationShotBatch({
    client: animationClient,
    prompt: "ORIGINAL_BATCH",
    compilerSettings: compilerSettings(compilerClient),
    repairContext: {},
    validate: (candidate) => ensureAnimationShotBatchContract(candidate)
  });

  assert.equal(result.batch.shotPlan.length, 1);
  assert.equal(animationPrompts.length, 2);
  assert.match(animationPrompts[1], /ANIMATION_SHOT_BATCH_RETRY_V1/u);
  assert.equal(compilerRequests, 1);
});

test("合法 Compiler 后候选失败才允许一次 patch 和唯一 second-pass，second-pass 禁止 patch", async () => {
  const rawBatch = animationBatchFixture();
  const animationPrompts = [];
  let compilerRequests = 0;
  let validationCalls = 0;
  const animationClient = {
    async generateJson(request) {
      animationPrompts.push(String(request.prompt || ""));
      if (String(request.prompt).includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
        return {
          path: STATIC_PATH,
          value: "女孩站在桌前，双手垂在身体两侧，视线朝向桌面"
        };
      }
      return structuredClone(rawBatch);
    }
  };
  const compilerClient = {
    async generateJson() {
      compilerRequests += 1;
      return { patches: [] };
    }
  };

  await assert.rejects(
    () => new WorkflowService().generateAnimationShotBatch({
      client: animationClient,
      prompt: "ORIGINAL_BATCH",
      compilerSettings: compilerSettings(compilerClient),
      repairContext: {},
      validate() {
        validationCalls += 1;
        throw trustedPoseError();
      }
    }),
    /second-pass 失败.*pose/
  );

  assert.equal(validationCalls, 3);
  assert.equal(compilerRequests, 3);
  assert.equal(animationPrompts.filter((prompt) => prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")).length, 1);
  assert.equal(animationPrompts.filter((prompt) => prompt.includes("ANIMATION_SHOT_BATCH_RETRY_V1")).length, 1);
  assert.equal(animationPrompts.length, 3);
});

test("second-pass 成功时只接受 retry run，并区分 finalAccepted", async () => {
  const firstBatch = animationBatchFixture();
  const retryBatch = animationBatchFixture();
  firstBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒";
  retryBatch.shotPlan[0].startFrame.characters[0].pose = "女孩即将打开八音盒";
  let animationRequests = 0;
  let validationCalls = 0;
  const animationClient = {
    async generateJson() {
      animationRequests += 1;
      return structuredClone(animationRequests === 1 ? firstBatch : retryBatch);
    }
  };
  const compilerClient = {
    async generateJson(request) {
      const retry = String(request.prompt).includes("即将打开");
      return {
        patches: [{
          path: STATIC_PATH,
          value: retry
            ? "女孩站在桌前，身体微微前倾，双手停在八音盒盖子两侧，视线落在八音盒上"
            : "女孩坐在桌前，身体微微前倾，双手停在八音盒盖子两侧，视线落在八音盒上",
          reasonCode: "future_intent",
          triggerSpans: [retry ? "即将" : "准备"],
          visibleFacts: ["身体微微前倾", "双手停在八音盒盖子两侧", "视线落在八音盒上"]
        }]
      };
    }
  };

  const result = await new WorkflowService().generateAnimationShotBatch({
    client: animationClient,
    prompt: "ORIGINAL_BATCH",
    compilerSettings: compilerSettings(compilerClient),
    repairContext: {},
    validate(candidate) {
      validationCalls += 1;
      if (validationCalls === 1) throw new OutputContractError("强制进入 second-pass");
      return ensureAnimationShotBatchContract(candidate);
    }
  });

  assert.equal(animationRequests, 2);
  assert.equal(result.compilerRuns.length, 2);
  assert.equal(result.compilerRuns[0].phase, "post-generate");
  assert.equal(result.compilerRuns[0].runAccepted, false);
  assert.equal(result.compilerRuns[0].modifications[0].applied, true);
  assert.equal(result.compilerRuns[0].modifications[0].finalAccepted, false);
  assert.equal(result.compilerRuns[1].phase, "second-pass");
  assert.equal(result.compilerRuns[1].runAccepted, true);
  assert.equal(result.compilerRuns[1].modifications[0].applied, true);
  assert.equal(result.compilerRuns[1].modifications[0].finalAccepted, true);
});

test("alias 重建失败后 second-pass 成功时，已完成的 first Compiler run 不丢失", async () => {
  const malformedBatch = animationBatchFixture();
  const validBatch = animationBatchFixture();
  delete malformedBatch.shotPlan[0].motion.primaryAction;
  let animationRequests = 0;
  const animationClient = {
    async generateJson() {
      animationRequests += 1;
      return structuredClone(animationRequests === 1 ? malformedBatch : validBatch);
    }
  };
  const compilerClient = {
    async generateJson() {
      return { patches: [] };
    }
  };

  const result = await new WorkflowService().generateAnimationShotBatch({
    client: animationClient,
    prompt: "ORIGINAL_BATCH",
    compilerSettings: compilerSettings(compilerClient),
    repairContext: {},
    validate: (candidate) => ensureAnimationShotBatchContract(candidate)
  });

  assert.equal(animationRequests, 2);
  assert.equal(result.compilerRuns.length, 2);
  assert.equal(result.compilerRuns[0].phase, "post-generate");
  assert.equal(result.compilerRuns[0].noOp, true);
  assert.equal(result.compilerRuns[0].runAccepted, false);
  assert.equal(result.compilerRuns[1].phase, "second-pass");
  assert.equal(result.compilerRuns[1].noOp, true);
  assert.equal(result.compilerRuns[1].runAccepted, true);
});
