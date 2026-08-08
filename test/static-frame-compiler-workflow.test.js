import test from "node:test";
import assert from "node:assert/strict";
import { compileAnimationShotPrompts } from "../src/animation-prompt-compiler.js";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import {
  StaticFrameCompilerCandidateError,
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

function groundedEvidenceResponse(request) {
  const prompt = String(request?.prompt || "");
  const markers = [
    "不可变 Source Catalog（displayText 只读，不得回传）：\n",
    "首次调用前签发的不可变 Source Catalog：\n",
    "原始不可变 Source Catalog：\n"
  ];
  const marker = markers.find((item) => prompt.includes(item));
  if (!marker) throw new Error("Static Frame Compiler prompt 缺少签发 Catalog");
  const catalog = JSON.parse(prompt.split(marker)[1]);
  const response = {
    targets: catalog.map((target) => ({
      targetId: target.targetId,
      evidenceSelections: [groundedOrganizerSelection(target)]
    }))
  };
  if (prompt.includes("STATIC_FRAME_ORGANIZER_ENVELOPE_REPAIR_V3")) {
    response.repairMode = "envelope_repair";
  }
  if (prompt.includes("STATIC_FRAME_FIELD_REORGANIZATION_V3")) {
    response.repairMode = "evidence_reselection";
  }
  return response;
}

function groundedOrganizerSelection(target) {
  const preferredSourceField = target.fieldLabel === "pose"
    ? "bodyOrientation"
    : "handPropState";
  const segment = target.segments.find((item) => item.sourceField === preferredSourceField)
    || target.segments[0];
  if (!segment) throw new Error(`Field Organizer target ${target.targetId} 缺少证据 segment`);
  const longestClause = [...segment.spans]
    .filter((span) => span.unit === "clause")
    .sort((left, right) => right.displayText.length - left.displayText.length)[0];
  const span = longestClause || segment.spans[0];
  if (!span) throw new Error(`Field Organizer target ${target.targetId} 缺少证据 span`);
  return {
    segmentId: segment.segmentId,
    spanIds: [span.spanId],
    category: target.fieldLabel === "pose" ? "pose_orientation" : "hand_prop_state",
    featureId: null
  };
}

const RETRYABLE_CANDIDATE_CODES = [
  "NO_STATIC_EVIDENCE_IN_SOURCE",
  "NO_VALID_GROUNDED_COMBINATION",
  "EVIDENCE_RESELECTION_EXHAUSTED"
];

test("只有三个 candidate errorCode 可触发 first-pass 唯一 Batch Retry", async (t) => {
  for (const errorCode of RETRYABLE_CANDIDATE_CODES) {
    await t.test(errorCode, async () => {
      const rawBatch = animationBatchFixture();
      let animationRequests = 0;
      let compilerAttempts = 0;
      const workflow = new WorkflowService();
      workflow.prepareAnimationShotBatchCandidate = async () => {
        compilerAttempts += 1;
        throw new StaticFrameCompilerCandidateError(errorCode, {
          errorCode,
          metadata: { errorCode, modifications: [] }
        });
      };

      await assert.rejects(
        () => workflow.generateAnimationShotBatch({
          client: {
            async generateJson() {
              animationRequests += 1;
              return structuredClone(rawBatch);
            }
          },
          prompt: "ORIGINAL_BATCH",
          compilerSettings: compilerSettings({ async generateJson() {} }),
          repairContext: {},
          validate: (candidate) => candidate
        }),
        (error) => {
          assert.ok(error instanceof StaticFrameCompilerCandidateError);
          assert.equal(error.errorCode, errorCode);
          assert.equal(error.staticFrameCompilerRuns.length, 2);
          assert.equal(error.metadata.batchCompilerRuns.length, 2);
          assert.equal(error.metadata.batchCompilerRuns[0].candidateLevelBatchRetry.batchRetryPass, "first-pass");
          assert.equal(error.metadata.batchCompilerRuns[1].candidateLevelBatchRetry.batchRetryPass, "second-pass");
          return true;
        }
      );
      assert.equal(animationRequests, 2);
      assert.equal(compilerAttempts, 2);
    });
  }
});

test("非白名单 candidate code 直接终止，不进入 Batch Retry", async () => {
  const rawBatch = animationBatchFixture();
  let animationRequests = 0;
  let compilerAttempts = 0;
  const workflow = new WorkflowService();
  workflow.prepareAnimationShotBatchCandidate = async () => {
    compilerAttempts += 1;
    throw new StaticFrameCompilerCandidateError("ILLEGAL_SIGNED_ID", {
      errorCode: "ILLEGAL_SIGNED_ID",
      metadata: { errorCode: "ILLEGAL_SIGNED_ID", modifications: [] }
    });
  };

  await assert.rejects(
    () => workflow.generateAnimationShotBatch({
      client: {
        async generateJson() {
          animationRequests += 1;
          return structuredClone(rawBatch);
        }
      },
      prompt: "ORIGINAL_BATCH",
      compilerSettings: compilerSettings({ async generateJson() {} }),
      repairContext: {},
      validate: (candidate) => candidate
    }),
    (error) => error instanceof StaticFrameCompilerCandidateError
      && error.errorCode === "ILLEGAL_SIGNED_ID"
  );
  assert.equal(animationRequests, 1);
  assert.equal(compilerAttempts, 1);
});

test("candidate first-pass metadata 在 Batch Retry 成功后保留，second-pass run 才最终接受", async () => {
  const rawBatch = animationBatchFixture();
  let animationRequests = 0;
  let compilerAttempts = 0;
  const workflow = new WorkflowService();
  workflow.prepareAnimationShotBatchCandidate = async ({ rawModelOutput, phase }) => {
    compilerAttempts += 1;
    if (compilerAttempts === 1) {
      throw new StaticFrameCompilerCandidateError("NO_STATIC_EVIDENCE_IN_SOURCE", {
        errorCode: "NO_STATIC_EVIDENCE_IN_SOURCE",
        metadata: {
          phase,
          errorCode: "NO_STATIC_EVIDENCE_IN_SOURCE",
          modifications: []
        }
      });
    }
    return {
      candidate: structuredClone(rawModelOutput),
      compilerRuns: [{
        phase,
        finalResult: "accepted",
        modifications: []
      }]
    };
  };

  const result = await workflow.generateAnimationShotBatch({
    client: {
      async generateJson() {
        animationRequests += 1;
        return structuredClone(rawBatch);
      }
    },
    prompt: "ORIGINAL_BATCH",
    compilerSettings: compilerSettings({ async generateJson() {} }),
    repairContext: {},
    validate: (candidate) => ensureAnimationShotBatchContract(candidate)
  });

  assert.equal(animationRequests, 2);
  assert.equal(result.compilerRuns.length, 2);
  assert.equal(result.compilerRuns[0].errorCode, "NO_STATIC_EVIDENCE_IN_SOURCE");
  assert.equal(result.compilerRuns[0].runAccepted, false);
  assert.equal(result.compilerRuns[1].phase, "second-pass");
  assert.equal(result.compilerRuns[1].runAccepted, true);
});

test("workflow 在 Compiler 后统一重建 alias，并标记最终接受的修改", async () => {
  const rawBatch = animationBatchFixture();
  rawBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒，身体前倾，双手停在八音盒两侧";
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "右手停留在按钮表面";
  rawBatch.shotPlan[0].startFrame.environment.foreground = "木桌边缘";
  rawBatch.shotPlan[0].endFrame.environment.foreground = "木桌边缘";
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
      return groundedEvidenceResponse(request);
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
      assert.doesNotMatch(candidate.shotPlan[0].startFrame.characters[0].pose, /准备/u);
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
  rawBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒，身体前倾，双手停在八音盒两侧";
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
  rawBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒，身体前倾，双手停在八音盒两侧";
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
    async generateJson(request) {
      compilerRequests += 1;
      return groundedEvidenceResponse(request);
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
    async generateJson(request) {
      compilerRequests += 1;
      return groundedEvidenceResponse(request);
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
  firstBatch.shotPlan[0].startFrame.characters[0].pose = "女孩准备打开八音盒，身体前倾，双手停在八音盒两侧";
  retryBatch.shotPlan[0].startFrame.characters[0].pose = "女孩即将打开八音盒，身体前倾，双手停在八音盒两侧";
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
      return groundedEvidenceResponse(request);
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
    async generateJson(request) {
      return groundedEvidenceResponse(request);
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
  assert.equal(result.compilerRuns[0].noOp, false);
  assert.equal(result.compilerRuns[0].runAccepted, false);
  assert.equal(result.compilerRuns[1].phase, "second-pass");
  assert.equal(result.compilerRuns[1].noOp, false);
  assert.equal(result.compilerRuns[1].runAccepted, true);
});
