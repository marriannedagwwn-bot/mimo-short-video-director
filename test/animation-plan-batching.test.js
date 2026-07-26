import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { compileAnimationShotPrompts } from "../src/animation-prompt-compiler.js";
import { ModelResponseError } from "../src/mimo-client.js";
import { animationFoundationPrompt, animationShotBatchPrompt } from "../src/prompts.js";
import { ensureAnimationFoundationContract, ensureAnimationShotBatchContract } from "../src/validation.js";
import { WorkflowService, repairAnimationShotBatchCandidate } from "../src/workflow.js";

const TEST_STATIC_FRAME_COMPILER_MODEL = "static-frame-compiler-test";

function isStaticFrameCompilerRequest(args = {}) {
  return String(args.prompt || "").includes("STATIC_FRAME_COMPILER_V1");
}

function animationWorkflow(options = {}) {
  const useAnimationClient = Boolean(options.animationClient);
  const provider = useAnimationClient
    ? String(options.animationProvider || "MiMo")
    : "MiMo";
  const originalClient = useAnimationClient ? options.animationClient : options.client;
  if (!originalClient || typeof originalClient.generateJson !== "function") {
    throw new Error("animationWorkflow 测试辅助器需要 generateJson client");
  }
  const routedClient = {
    ...originalClient,
    async generateJson(args) {
      if (isStaticFrameCompilerRequest(args)) return { patches: [] };
      return originalClient.generateJson(args);
    }
  };
  return new WorkflowService({
    ...options,
    ...(useAnimationClient ? { animationClient: routedClient } : { client: routedClient }),
    staticFrameCompilerProvider: provider,
    staticFrameCompilerModel: TEST_STATIC_FRAME_COMPILER_MODEL
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function retryAppendix(prompt) {
  const marker = "\nANIMATION_SHOT_BATCH_RETRY_V1\n";
  const index = String(prompt).indexOf(marker);
  return index >= 0 ? String(prompt).slice(index + 1) : "";
}

function retryFailedCandidate(prompt) {
  const appendix = retryAppendix(prompt);
  const match = appendix.match(/当前失败 batch：\n([^\n]+)\n\n错误诊断：/u);
  if (!match) throw new Error("retry prompt 缺少当前失败 batch");
  return JSON.parse(match[1]);
}

function retryDiagnostics(prompt) {
  const appendix = retryAppendix(prompt);
  const match = appendix.match(/错误诊断：\n([^\n]+)\n\nsecond-pass retry 约束：/u);
  if (!match) throw new Error("retry prompt 缺少错误诊断");
  return JSON.parse(match[1]);
}

function patchFailedBatch(prompt) {
  const marker = "上一次失败的原始批次 JSON（只用于理解当前端点；除唯一字段外任何内容都不得改变）：\n";
  const remainder = String(prompt).split(marker)[1];
  if (!remainder) throw new Error("patch prompt 缺少失败 batch");
  return JSON.parse(remainder.split("\n")[0]);
}

function fixture() {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const base = { creatorProfile };
  const creativeBrief = mockBrief({ ...base, referenceAnalysis: {}, sourceScriptReconstruction: {} });
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: { protagonist: "阿岚，社区修理师", careRecipient: "独居老人", helper: "夜班便利店员" },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = mockFullStory({ ...base, creativeBrief, variant });
  const animationPlan = mockAnimationPlan({ ...base, creativeBrief, variant, fullStory });
  animationPlan.shotPlan.forEach((shot) => {
    for (const frameKind of ["startFrame", "endFrame"]) {
      (shot[frameKind]?.characters || []).forEach((character) => {
        character.actionState = "";
      });
    }
    Object.assign(shot, compileAnimationShotPrompts(shot));
  });
  return { creatorProfile, creativeBrief, variant, fullStory, animationPlan };
}

function foundationFrom(plan) {
  const copy = structuredClone(plan);
  const { shotPlan, ...foundation } = copy;
  foundation.sceneReferencePrompts.forEach((scene) => {
    scene.relatedShotIds = [];
    scene.sourceSceneIds = [...new Set(shotPlan.filter((shot) => shot.sceneId === scene.sceneId).map((shot) => shot.sourceSceneId))];
  });
  return foundation;
}

test("动画基础与镜头批次 prompt 职责分离", () => {
  const context = fixture();
  const foundationPrompt = animationFoundationPrompt(context);
  const batchPrompt = animationShotBatchPrompt({
    ...context,
    animationFoundation: foundationFrom(context.animationPlan),
    sourceScenes: context.fullStory.sceneScript.slice(0, 2),
    shotIdStartIndex: 1
  });

  assert.match(foundationPrompt, /动画基础锁定/);
  assert.match(foundationPrompt, /不生成、推测或占位任何 shotPlan/);
  assert.match(batchPrompt, /逐场景镜头批次/);
  assert.match(batchPrompt, /顶层.*只能输出 shotPlan/);
  assert.match(batchPrompt, /S1、S2/);
});

test("分阶段内部契约允许镜头负面词为空", () => {
  const { animationPlan } = fixture();
  const foundation = foundationFrom(animationPlan);
  assert.equal(ensureAnimationFoundationContract(foundation), foundation);
  assert.throws(
    () => ensureAnimationFoundationContract({ ...foundation, shotPlan: [] }),
    /未允许的顶层字段.*shotPlan/
  );

  const shot = structuredClone(animationPlan.shotPlan[0]);
  shot.negativePrompts = { image: [], video: [] };
  const batch = { shotPlan: [shot] };
  assert.equal(ensureAnimationShotBatchContract(batch), batch);
});

test("服务端先生成基础锁定，再按场次分批生成并合并原 animationPlan", async () => {
  const context = fixture();
  const calls = [];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        calls.push(args);
        if (calls.length === 1) return foundationFrom(context.animationPlan);
        const batchIndex = calls.length - 2;
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(batchIndex * 2, batchIndex * 2 + 2)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(calls.length, 4);
  assert.match(calls[0].prompt, /动画基础锁定/);
  calls.slice(1).forEach((call) => assert.match(call.prompt, /逐场景镜头批次/));
  assert.ok(calls.every((call) => !call.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")));
  assert.deepEqual(result.shotPlan.map((shot) => shot.shotId), ["A01", "A02", "A03", "A04", "A05", "A06"]);
  assert.deepEqual(result.shotPlan.map((shot) => shot.sourceSceneId), ["S1", "S2", "S3", "S4", "S5", "S6"]);
  assert.deepEqual(result.sceneReferencePrompts.map((scene) => scene.relatedShotIds), [["A01"], ["A02"], ["A03"], ["A04"], ["A05"], ["A06"]]);
  assert.ok(result.sceneReferencePrompts.every((scene) => !Object.hasOwn(scene, "sourceSceneIds")));
  assert.deepEqual(Object.keys(result).sort(), Object.keys(context.animationPlan).sort());
  result.shotPlan.forEach((shot) => {
    assert.ok(shot.startFrame);
    assert.ok(shot.endFrame);
    assert.ok(shot.motion);
    assert.deepEqual(
      Object.fromEntries(Object.keys(compileAnimationShotPrompts(shot)).map((field) => [field, shot[field]])),
      compileAnimationShotPrompts(shot)
    );
  });
});

test("下一批提示词继承上一镜完整尾帧与运动终态", async () => {
  const context = fixture();
  const prompts = [];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 1,
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        const sourceSceneId = args.prompt.match(/本批允许的 sourceSceneId：([^\n]+)/u)?.[1]?.trim();
        const shot = context.animationPlan.shotPlan.find((item) => item.sourceSceneId === sourceSceneId);
        return { shotPlan: [structuredClone(shot)] };
      }
    }
  });

  await workflow.createAnimationPlan(context);
  const secondBatchPrompt = prompts.find((prompt) => prompt.includes("本批允许的 sourceSceneId：S2"));
  const previous = context.animationPlan.shotPlan[0];
  assert.match(secondBatchPrompt, new RegExp(escapeRegExp(JSON.stringify(previous.endFrame)), "u"));
  assert.match(secondBatchPrompt, new RegExp(escapeRegExp(JSON.stringify(previous.motion.cameraMove)), "u"));
  assert.match(secondBatchPrompt, new RegExp(escapeRegExp(previous.motion.stopCondition), "u"));
});

test("v2 结构中的旧兼容字符串由 compiler 确定性覆盖且不重生完整批次", async () => {
  const context = fixture();
  let firstBatchAttempts = 0;
  const prompts = [];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("本批允许的 sourceSceneId：S1、S2")) {
          firstBatchAttempts += 1;
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          if (firstBatchAttempts === 1) shots[0].videoPrompt = "与结构化 motion 不一致的旧字符串";
          return { shotPlan: shots };
        }
        if (args.prompt.includes("本批允许的 sourceSceneId：S3、S4")) {
          return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(2, 4)) };
        }
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(4, 6)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(firstBatchAttempts, 1);
  assert.equal(
    result.shotPlan[0].videoPrompt,
    compileAnimationShotPrompts(result.shotPlan[0]).videoPrompt
  );
  assert.equal(prompts.filter((prompt) => prompt.includes("本阶段只生成可供所有镜头批次复用")).length, 1);
  assert.equal(prompts.length, 4);
});

test("v2 foundation 收到 legacy 镜头时只完整重生当前批次一次", async () => {
  const context = fixture();
  let firstBatchAttempts = 0;
  const prompts = [];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("本批允许的 sourceSceneId：S1、S2")) {
          firstBatchAttempts += 1;
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          if (firstBatchAttempts === 1) {
            return { shotPlan: shots.map((shot) => {
              const legacy = { ...shot, ...compileAnimationShotPrompts(shot) };
              delete legacy.startFrame;
              delete legacy.endFrame;
              delete legacy.motion;
              return legacy;
            }) };
          }
          return { shotPlan: shots };
        }
        if (args.prompt.includes("本批允许的 sourceSceneId：S3、S4")) {
          return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(2, 4)) };
        }
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(4, 6)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(firstBatchAttempts, 2);
  assert.equal(prompts.filter((value) => value.includes("ANIMATION_SHOT_BATCH_RETRY_V1")).length, 1);
  assert.equal(prompts.length, 5);
});

test("真实回归：首次 batch 失败后只重试当前 batch，foundation 不重新生成", async () => {
  const context = fixture();
  const calls = [];
  let firstBatchAttempts = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        calls.push(args.prompt);
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("本批允许的 sourceSceneId：S1、S2")) {
          firstBatchAttempts += 1;
          if (firstBatchAttempts === 1) return { shotPlan: [] };
          return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(0, 2)) };
        }
        if (args.prompt.includes("本批允许的 sourceSceneId：S3、S4")) {
          return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(2, 4)) };
        }
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(4, 6)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(calls.filter((prompt) => prompt.includes("本阶段只生成可供所有镜头批次复用")).length, 1);
  assert.equal(firstBatchAttempts, 2);
  assert.equal(calls.filter((prompt) => prompt.includes("ANIMATION_SHOT_BATCH_RETRY_V1")).length, 1);
  assert.equal(calls.length, 5);
});

test("shotId 和 sceneId 由确定性 repair 修复且不触发整批重生", async (t) => {
  const scenarios = [
    ["shotId", (batch) => { batch.shotPlan[0].shotId = ""; }],
    ["sceneId", (batch) => {
      batch.shotPlan[0].sceneId = "";
      batch.shotPlan[0].startFrame.environment.sceneId = "";
      batch.shotPlan[0].endFrame.environment.sceneId = "";
    }]
  ];

  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const context = fixture();
      const rawBatch = modelBatchFrom(context);
      mutate(rawBatch);
      let batchCalls = 0;
      let auditCalls = 0;
      let patchCalls = 0;

      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
              return foundationFrom(context.animationPlan);
            }
            if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
              auditCalls += 1;
              return { results: [] };
            }
            if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
              patchCalls += 1;
              return {};
            }
            batchCalls += 1;
            return structuredClone(rawBatch);
          }
        }
      });

      const result = await workflow.createAnimationPlan(context);
      assert.equal(result.shotPlan[0].shotId, "A01");
      assert.equal(result.shotPlan[0].sceneId, "LOC01");
      assert.equal(result.shotPlan[0].startFrame.environment.sceneId, "LOC01");
      assert.equal(result.shotPlan[0].endFrame.environment.sceneId, "LOC01");
      assert.equal(batchCalls, 1);
      assert.equal(auditCalls, 0);
      assert.equal(patchCalls, 0);
    });
  }
});

test("sourceSceneId 不做 deterministic repair，保留原值并进入 second-pass", async () => {
  const context = fixture();
  const firstInvalid = modelBatchFrom(context);
  firstInvalid.shotPlan[0].sourceSceneId = " S1 ";
  const validRetry = modelBatchFrom(context);
  let batchCalls = 0;
  let retryPrompt = "";
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        batchCalls += 1;
        if (batchCalls === 1) return structuredClone(firstInvalid);
        retryPrompt = args.prompt;
        return structuredClone(validRetry);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(batchCalls, 2);
  assert.equal(retryFailedCandidate(retryPrompt).shotPlan[0].sourceSceneId, " S1 ");
  assert.equal(result.shotPlan[0].sourceSceneId, "S1");
});

test("duration、camera 和 motion 语义错误只完整重试当前 batch 一次", async (t) => {
  const scenarios = [
    ["duration", (batch) => { batch.shotPlan[0].durationSeconds = 0; }],
    ["camera", (batch) => { batch.shotPlan[0].startFrame.camera.composition = "准备改变构图"; }],
    ["motion", (batch) => { batch.shotPlan[0].motion.primaryAction = ""; }]
  ];

  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const context = fixture();
      const invalidBatch = modelBatchFrom(context);
      mutate(invalidBatch);
      let batchCalls = 0;
      let patchCalls = 0;

      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
              return foundationFrom(context.animationPlan);
            }
            if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
              patchCalls += 1;
              return {};
            }
            batchCalls += 1;
            return structuredClone(invalidBatch);
          }
        }
      });

      await assert.rejects(() => workflow.createAnimationPlan(context), /second-pass 失败/);
      assert.equal(batchCalls, 2);
      assert.equal(patchCalls, 0);
    });
  }
});

test("服务端重编镜头 ID 时同步重写负面词证据路径", async () => {
  const context = fixture();
  const batches = [
    context.animationPlan.shotPlan.slice(0, 2),
    context.animationPlan.shotPlan.slice(2, 4),
    context.animationPlan.shotPlan.slice(4, 6)
  ].map((shots) => structuredClone(shots));
  batches[0][0].shotId = "LOCAL-1";
  batches[0][0].negativePrompts.image = [{
    text: "录音设备被错误生成手机屏幕",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "animationPlan.shotPlan[LOCAL-1].motion.primaryAction",
      evidence: batches[0][0].motion.primaryAction
    }],
    reasonCode: "shot_object_confusion",
    priority: "medium",
    enabled: true
  }];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("本批允许的 sourceSceneId：S1、S2")) return { shotPlan: batches[0] };
        if (args.prompt.includes("本批允许的 sourceSceneId：S3、S4")) return { shotPlan: batches[1] };
        return { shotPlan: batches[2] };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan[0].shotId, "A01");
  assert.equal(
    result.shotPlan[0].negativePrompts.image[0].triggerEvidence[0].sourcePath,
    "animationPlan.shotPlan[A01].motion.primaryAction"
  );
});

test("Qwen 高 token 上限在分阶段纠偏时不会被降到 32768", async () => {
  const context = fixture();
  const requests = [];
  let call = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    animationProvider: "Qwen",
    animationModel: "qwen-animation",
    animationMaxCompletionTokens: 50000,
    animationClient: {
      async generateJson(args) {
        requests.push(args);
        call += 1;
        if (call === 1) return {};
        if (call === 2) return foundationFrom(context.animationPlan);
        const batchIndex = call - 3;
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(batchIndex * 2, batchIndex * 2 + 2)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(requests[0].maxCompletionTokens, 50000);
  assert.equal(requests[1].maxCompletionTokens, 50000);
  assert.match(requests[1].prompt, /没有通过系统校验/);
});

test("基础阶段回传旧整包时会纠偏，不会静默丢弃 shotPlan", async () => {
  const context = fixture();
  let call = 0;
  const prompts = [];
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        prompts.push(args.prompt);
        call += 1;
        if (call === 1) return structuredClone(context.animationPlan);
        if (call === 2) return foundationFrom(context.animationPlan);
        const batchIndex = call - 3;
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(batchIndex * 2, batchIndex * 2 + 2)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(prompts.length, 5);
  assert.match(prompts[1], /未允许的顶层字段.*shotPlan/);
});

test("sceneId 映射错误由唯一 foundation 映射确定性修复", async () => {
  const context = fixture();
  let firstBatchAttempts = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("本批允许的 sourceSceneId：S1、S2")) {
          firstBatchAttempts += 1;
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          shots[1].sceneId = shots[0].sceneId;
          shots[1].startFrame.environment.sceneId = shots[0].sceneId;
          shots[1].endFrame.environment.sceneId = shots[0].sceneId;
          return { shotPlan: shots };
        }
        if (args.prompt.includes("本批允许的 sourceSceneId：S3、S4")) {
          return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(2, 4)) };
        }
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(4, 6)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(firstBatchAttempts, 1);
  assert.equal(result.shotPlan[1].sceneId, "LOC02");
  assert.equal(result.shotPlan[1].startFrame.environment.sceneId, "LOC02");
  assert.equal(result.shotPlan[1].endFrame.environment.sceneId, "LOC02");
});

test("跨批重复负面词只重试当前批次，前序批次保持不变", async () => {
  const context = fixture();
  const duplicateNegative = {
    text: "主角身份被生成成陌生成年人",
    appliesTo: "image",
    triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: context.creatorProfile.fixedCharacter }],
    reasonCode: "explicit_identity_conflict",
    priority: "high",
    enabled: true
  };
  let call = 0;
  let secondBatchAttempts = 0;
  let expectedFirstShots;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson() {
        call += 1;
        if (call === 1) return foundationFrom(context.animationPlan);
        if (call === 2) {
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          shots[0].negativePrompts.image = [structuredClone(duplicateNegative)];
          expectedFirstShots = structuredClone(shots);
          return { shotPlan: shots };
        }
        if (call === 3 || call === 4) {
          secondBatchAttempts += 1;
          const shots = structuredClone(context.animationPlan.shotPlan.slice(2, 4));
          if (secondBatchAttempts === 1) shots[0].negativePrompts.image = [structuredClone(duplicateNegative)];
          return { shotPlan: shots };
        }
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(4, 6)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(secondBatchAttempts, 2);
  assert.equal(call, 5);
  assert.deepEqual(result.shotPlan.slice(0, 2), expectedFirstShots);
  assert.equal(result.shotPlan[0].negativePrompts.image.length, 1);
  assert.deepEqual(result.shotPlan[2].negativePrompts.image, []);
});

function modelBatchFrom(context) {
  const batch = { shotPlan: structuredClone(context.animationPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    for (const alias of Object.keys(compileAnimationShotPrompts(shot))) delete shot[alias];
  });
  return batch;
}

function batchWithoutCompiledAliases(planOrBatch) {
  const batch = {
    shotPlan: structuredClone(planOrBatch.shotPlan || [])
  };
  batch.shotPlan.forEach((shot) => {
    for (const alias of Object.keys(compileAnimationShotPrompts(shot))) delete shot[alias];
  });
  return batch;
}

function auditItemsFromPrompt(prompt) {
  const marker = "待审核条目（每项严格只有 id、actionState、frameKind）：\n";
  const remainder = String(prompt).split(marker)[1];
  if (!remainder) throw new Error("缺少 actionState 审核输入");
  return JSON.parse(remainder.split("\n")[0]);
}

function actionStateAuditResponse(items, failingIds = new Map()) {
  return {
    results: items.map((item) => {
      const failure = failingIds.get(item.id);
      return failure
        ? {
            id: item.id,
            verdict: "fail",
            reasonCode: failure.reasonCode
          }
        : {
            id: item.id,
            verdict: "pass",
            reasonCode: "visible_state"
          };
    })
  };
}

test("actionState 审核只提交非空字段和三个最小属性", async () => {
  const context = fixture();
  context.creatorProfile.fixedCharacter = `${context.creatorProfile.fixedCharacter}，画面允许出现小鸟及其翅膀`;
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "小鸟停在女孩掌心，翅膀轻微展开";
  rawBatch.shotPlan[1].startFrame.characters[0].actionState = "   ";
  rawBatch.shotPlan[1].endFrame.characters[0].actionState = "角色脸上露出惊讶表情";
  const auditPayloads = [];

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          assert.equal(args.maxCompletionTokens, 2048);
          const items = auditItemsFromPrompt(args.prompt);
          auditPayloads.push(items);
          return actionStateAuditResponse(items);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          throw new Error("合法 actionState 不应触发 patch");
        }
        return structuredClone(rawBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(auditPayloads.length, 1);
  assert.deepEqual(auditPayloads[0].map((item) => item.actionState), [
    "小鸟停在女孩掌心，翅膀轻微展开",
    "角色脸上露出惊讶表情"
  ]);
  auditPayloads[0].forEach((item) => {
    assert.deepEqual(Object.keys(item).sort(), ["actionState", "frameKind", "id"]);
  });
  assert.deepEqual(auditPayloads[0].map((item) => item.frameKind), ["startFrame", "endFrame"]);
});

test("actionState 审核判定语义失败时只修复一个字段", async (t) => {
  const cases = [
    ["小鸟倒在掌心", "narrative_cognition"],
    ["角色站在鸟巢旁", "psychological_activity"],
    ["盒中露出小鸟的影子", "narrative_cognition"],
    ["老人独自坐在窗边", "psychological_activity"],
    ["角色停在门边", "goal_stage"]
  ];

  for (const [actionState, reasonCode] of cases) {
    await t.test(actionState, async () => {
      const context = fixture();
      const rawBatch = modelBatchFrom(context);
      rawBatch.shotPlan[0].startFrame.characters[0].actionState = actionState;
      let auditCalls = 0;
      let patchCalls = 0;

      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
            if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
              auditCalls += 1;
              const items = auditItemsFromPrompt(args.prompt);
              return actionStateAuditResponse(items, new Map([[
                items[0].id,
                { reasonCode }
              ]]));
            }
            if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
              patchCalls += 1;
              return {
                path: "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState",
                value: ""
              };
            }
            return structuredClone(rawBatch);
          }
        }
      });

      const result = await workflow.createAnimationPlan(context);
      assert.equal(result.shotPlan[0].startFrame.characters[0].actionState, "");
      assert.equal(auditCalls, 1);
      assert.equal(patchCalls, 1);
    });
  }
});

test("静态 pose 失败使用可信单字段 patch 且 motion 与其余批次完全不变", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].pose = "";
  const originalBatch = structuredClone(rawBatch);
  const trustedPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].pose";
  let patchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          assert.match(args.prompt, new RegExp(trustedPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
          return { path: trustedPath, value: "半蹲在木盒旁，右手停在盒盖边缘" };
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          throw new Error("全部 actionState 为空时不得审核");
        }
        return structuredClone(rawBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  const expected = structuredClone(originalBatch);
  expected.shotPlan[0].startFrame.characters[0].pose = "半蹲在木盒旁，右手停在盒盖边缘";
  assert.equal(patchCalls, 1);
  assert.deepEqual(batchWithoutCompiledAliases(result), expected);
  assert.deepEqual(result.shotPlan[0].motion, originalBatch.shotPlan[0].motion);
});

test("连续运镜缺少 camera 终点时只重建一次 EndState.camera 并保留严格校验", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  const shot = rawBatch.shotPlan[0];
  shot.motion.cameraMove = {
    mode: "continuous",
    technique: "平稳横移跟拍",
    path: "从左向右平行移动",
    speed: "medium",
    motivation: "跟随角色前行"
  };
  shot.endFrame.camera = structuredClone(shot.startFrame.camera);
  const originalBatch = structuredClone(rawBatch);
  const trustedPath = "animationShotBatch.shotPlan[0].endFrame.camera";
  const repairedCamera = {
    ...structuredClone(shot.endFrame.camera),
    composition: "角色位于右侧三分线，左侧保留行进空间"
  };
  let batchCalls = 0;
  let patchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          assert.match(args.prompt, /CONTINUOUS_CAMERA_ENDPOINT_MISSING|连续运镜/u);
          assert.match(args.prompt, /完整 EndState\.camera 对象/u);
          return { path: trustedPath, value: structuredClone(repairedCamera) };
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          throw new Error("全部 actionState 为空时不得审核");
        }
        batchCalls += 1;
        return structuredClone(rawBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  const expected = structuredClone(originalBatch);
  expected.shotPlan[0].endFrame.camera = repairedCamera;
  assert.equal(batchCalls, 1);
  assert.equal(patchCalls, 1);
  assert.deepEqual(batchWithoutCompiledAliases(result), expected);
  assert.deepEqual(result.shotPlan[0].startFrame.camera, originalBatch.shotPlan[0].startFrame.camera);
  assert.notDeepEqual(result.shotPlan[0].endFrame.camera, result.shotPlan[0].startFrame.camera);
  assert.deepEqual(
    Object.fromEntries(Object.keys(compileAnimationShotPrompts(result.shotPlan[0]))
      .map((field) => [field, result.shotPlan[0][field]])),
    compileAnimationShotPrompts(result.shotPlan[0])
  );
});

test("camera 终点 patch 协议错误进入唯一 second-pass，且 second-pass 禁止再次 patch", async () => {
  const context = fixture();
  const invalidBatch = modelBatchFrom(context);
  invalidBatch.shotPlan[0].motion.cameraMove = {
    mode: "continuous",
    technique: "缓慢推进",
    path: "沿镜头轴线接近角色",
    speed: "slow",
    motivation: "强化角色表情"
  };
  invalidBatch.shotPlan[0].endFrame.camera = structuredClone(invalidBatch.shotPlan[0].startFrame.camera);
  const validRetryBatch = modelBatchFrom(context);
  validRetryBatch.shotPlan[0].motion.cameraMove = structuredClone(invalidBatch.shotPlan[0].motion.cameraMove);
  validRetryBatch.shotPlan[0].endFrame.camera.shotSize = "近景";
  validRetryBatch.shotPlan[0].endFrame.camera.depthOfField = "角色面部清晰，背景明显虚化";
  let batchCalls = 0;
  let patchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: "animationShotBatch.shotPlan[0].endFrame.camera",
            value: "错误地返回字符串"
          };
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          throw new Error("全部 actionState 为空时不得审核");
        }
        batchCalls += 1;
        return structuredClone(batchCalls === 1 ? invalidBatch : validRetryBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(batchCalls, 2);
  assert.equal(patchCalls, 1);
  assert.equal(result.shotPlan[0].endFrame.camera.shotSize, "近景");
  assert.equal(result.shotPlan[0].endFrame.camera.depthOfField, "角色面部清晰，背景明显虚化");
});

test("handPropState 为空时只 patch 可信叶子且不重生整批", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].handPropState = "";
  const originalBatch = structuredClone(rawBatch);
  const trustedPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].handPropState";
  const repairedValue = "双手停在工具箱边缘，工具箱闭合";
  let batchGenerationCalls = 0;
  let patchCalls = 0;
  let auditCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          if (patchCalls > 1) throw new Error("同一批次不得执行第二次 patch");
          assert.match(args.prompt, new RegExp(trustedPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
          const patch = { path: trustedPath, value: repairedValue };
          assert.deepEqual(Object.keys(patch).sort(), ["path", "value"]);
          return patch;
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          throw new Error("全部 actionState 为空时不得审核");
        }
        batchGenerationCalls += 1;
        if (batchGenerationCalls > 1) throw new Error("结构失败不得触发整批重生");
        return structuredClone(rawBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  const expected = structuredClone(originalBatch);
  expected.shotPlan[0].startFrame.characters[0].handPropState = repairedValue;
  assert.equal(batchGenerationCalls, 1);
  assert.equal(patchCalls, 1);
  assert.equal(auditCalls, 0);
  assert.deepEqual(batchWithoutCompiledAliases(result), expected);
  assert.deepEqual(result.shotPlan[0].motion, originalBatch.shotPlan[0].motion);
});

test("actionState 单字段 patch 为非空可见状态后只复审一次并通过", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色站在鸟巢旁";
  const originalBatch = structuredClone(rawBatch);
  const trustedPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState";
  let auditCalls = 0;
  let patchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          const items = auditItemsFromPrompt(args.prompt);
          if (auditCalls === 1) {
            return actionStateAuditResponse(items, new Map([[
              items[0].id,
              { reasonCode: "psychological_activity" }
            ]]));
          }
          assert.deepEqual(items.map((item) => item.actionState), ["角色脸上露出惊讶表情"]);
          return actionStateAuditResponse(items);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: trustedPath,
            value: "角色脸上露出惊讶表情"
          };
        }
        return structuredClone(rawBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  const expected = structuredClone(originalBatch);
  expected.shotPlan[0].startFrame.characters[0].actionState = "角色脸上露出惊讶表情";
  assert.equal(auditCalls, 2);
  assert.equal(patchCalls, 1);
  assert.deepEqual(batchWithoutCompiledAliases(result), expected);
});

test("单字段 patch 后语义复审仍失败时进入 second-pass 且不执行第二次 patch", async () => {
  const context = fixture();
  const invalidBatch = modelBatchFrom(context);
  invalidBatch.shotPlan[0].startFrame.characters[0].actionState = "角色站在鸟巢旁";
  const validRetryBatch = modelBatchFrom(context);
  let auditCalls = 0;
  let patchCalls = 0;
  let batchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          const items = auditItemsFromPrompt(args.prompt);
          return actionStateAuditResponse(items, new Map([[
            items[0].id,
            { reasonCode: "psychological_activity" }
          ]]));
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState",
            value: "角色站在老人身旁"
          };
        }
        batchCalls += 1;
        return structuredClone(batchCalls === 1 ? invalidBatch : validRetryBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan[0].startFrame.characters[0].actionState, "");
  assert.equal(auditCalls, 2);
  assert.equal(patchCalls, 1);
  assert.equal(batchCalls, 2);
});

test("单字段 patch 后 actionState 审核协议失败时直接进入 second-pass", async () => {
  const context = fixture();
  const invalidBatch = modelBatchFrom(context);
  invalidBatch.shotPlan[0].startFrame.characters[0].actionState = "角色站在鸟巢旁";
  const validRetryBatch = modelBatchFrom(context);
  let auditCalls = 0;
  let patchCalls = 0;
  let batchCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          const items = auditItemsFromPrompt(args.prompt);
          if (auditCalls === 1) {
            return actionStateAuditResponse(items, new Map([[
              items[0].id,
              { reasonCode: "psychological_activity" }
            ]]));
          }
          return { results: [] };
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState",
            value: "角色脸上露出惊讶表情"
          };
        }
        batchCalls += 1;
        return structuredClone(batchCalls === 1 ? invalidBatch : validRetryBatch);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(auditCalls, 2);
  assert.equal(patchCalls, 1);
  assert.equal(batchCalls, 2);
});

test("second-pass 明确 actionState 语义失败时最终失败且禁止 patch", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "小鸟倒在掌心";
  rawBatch.shotPlan[0].endFrame.characters[0].actionState = "角色站在鸟巢旁";
  let patchCalls = 0;
  let batchCalls = 0;
  let auditCalls = 0;

  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          const items = auditItemsFromPrompt(args.prompt);
          return actionStateAuditResponse(items, new Map(items.map((item) => [
            item.id,
            { reasonCode: "narrative_cognition" }
          ])));
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {};
        }
        batchCalls += 1;
        return structuredClone(rawBatch);
      }
    }
  });

  await assert.rejects(() => workflow.createAnimationPlan(context), /second-pass 失败.*有 2 个 actionState/);
  assert.equal(batchCalls, 2);
  assert.equal(auditCalls, 2);
  assert.equal(patchCalls, 0);
});

test("actionState 审核协议错误首轮重试，second-pass 再异常时严格失败", async (t) => {
  const invalidResults = [
    {
      name: "unknown",
      build(items) {
        return actionStateAuditResponse([{ ...items[0], id: "AS-UNKNOWN" }]);
      }
    },
    {
      name: "duplicate",
      build(items) {
        const first = actionStateAuditResponse([items[0]]).results[0];
        return { results: [first, structuredClone(first)] };
      },
      twoItems: true
    },
    {
      name: "missing",
      build() {
        return { results: [] };
      }
    },
    {
      name: "invalid-verdict",
      build(items) {
        const response = actionStateAuditResponse(items);
        response.results[0].verdict = "unknown";
        return response;
      }
    },
    {
      name: "invalid-reason-code",
      build(items) {
        const response = actionStateAuditResponse(items);
        response.results[0].reasonCode = "keyword_match";
        return response;
      }
    },
    {
      name: "extra-reason-field",
      build(items) {
        const response = actionStateAuditResponse(items);
        response.results[0].reason = "模型不得返回自由文本原因";
        return response;
      }
    }
  ];

  for (const scenario of invalidResults) {
    await t.test(scenario.name, async () => {
      const context = fixture();
      const rawBatch = modelBatchFrom(context);
      rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色脸上露出惊讶表情";
      if (scenario.twoItems) rawBatch.shotPlan[0].endFrame.characters[0].actionState = "小鸟停在女孩掌心";
      let patchCalls = 0;
      let batchCalls = 0;
      let auditCalls = 0;
      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
            if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
              auditCalls += 1;
              return scenario.build(auditItemsFromPrompt(args.prompt));
            }
            if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
              patchCalls += 1;
              return {};
            }
            batchCalls += 1;
            return structuredClone(rawBatch);
          }
        }
      });

      await assert.rejects(
        () => workflow.createAnimationPlan(context),
        /second-pass 失败.*actionState 语义审核协议失败/
      );
      assert.equal(batchCalls, 2);
      assert.equal(auditCalls, 2);
      assert.equal(patchCalls, 0);
    });
  }
});

test("second-pass 审核同时含明确 fail 与协议错误时语义失败优先，禁止降级", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色站在鸟巢旁";
  let batchCalls = 0;
  let auditCalls = 0;
  let patchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          const items = auditItemsFromPrompt(args.prompt);
          const response = actionStateAuditResponse(
            items,
            auditCalls === 2
              ? new Map([[items[0].id, { reasonCode: "psychological_activity" }]])
              : new Map()
          );
          response.results[0].unexpected = "协议错误不能掩盖明确 fail";
          return response;
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {};
        }
        batchCalls += 1;
        return structuredClone(rawBatch);
      }
    }
  });

  await assert.rejects(
    () => workflow.createAnimationPlan(context),
    /second-pass 失败.*不属于单张静态画面/
  );
  assert.equal(batchCalls, 2);
  assert.equal(auditCalls, 2);
  assert.equal(patchCalls, 0);
});

test("first-pass 非法单字段 patch 响应直接进入合法 second-pass", async (t) => {
  const trustedPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState";
  const invalidPatches = [
    ["motion", { path: "animationShotBatch.shotPlan[0].motion.primaryAction", value: "修改动作" }],
    ["camera", { path: "animationShotBatch.shotPlan[0].startFrame.camera.composition", value: "修改构图" }],
    ["multiple", {
      patches: [
        { path: trustedPath, value: "" },
        { path: "animationShotBatch.shotPlan[0].endFrame.characters[0].actionState", value: "" }
      ]
    }],
    ["array", [{ path: trustedPath, value: "" }]],
    ["extra-key", { path: trustedPath, value: "", explanation: "额外字段" }],
    ["non-string-value", { path: trustedPath, value: { visible: true } }]
  ];

  for (const [name, invalidPatch] of invalidPatches) {
    await t.test(name, async () => {
      const context = fixture();
      const invalidBatch = modelBatchFrom(context);
      invalidBatch.shotPlan[0].startFrame.characters[0].actionState = "角色站在鸟巢旁";
      const validRetryBatch = modelBatchFrom(context);
      let patchCalls = 0;
      let batchCalls = 0;
      let auditCalls = 0;
      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) return foundationFrom(context.animationPlan);
            if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
              auditCalls += 1;
              const items = auditItemsFromPrompt(args.prompt);
              return actionStateAuditResponse(items, new Map([[
                items[0].id,
                { reasonCode: "psychological_activity" }
              ]]));
            }
            if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
              patchCalls += 1;
              return structuredClone(invalidPatch);
            }
            batchCalls += 1;
            return structuredClone(batchCalls === 1 ? invalidBatch : validRetryBatch);
          }
        }
      });

      const result = await workflow.createAnimationPlan(context);
      assert.equal(result.shotPlan.length, 6);
      assert.equal(batchCalls, 2);
      assert.equal(auditCalls, 1);
      assert.equal(patchCalls, 1);
    });
  }
});

test("second-pass 失败后不执行 patch、第三次 batch 或任何循环恢复", async () => {
  const context = fixture();
  let foundationCalls = 0;
  let batchCalls = 0;
  let patchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          foundationCalls += 1;
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {};
        }
        batchCalls += 1;
        if (batchCalls > 2) throw new Error("禁止第三次 batch 调用");
        return { shotPlan: [] };
      }
    }
  });

  let finalError;
  await assert.rejects(async () => {
    try {
      await workflow.createAnimationPlan(context);
    } catch (error) {
      finalError = error;
      throw error;
    }
  }, /second-pass 失败.*至少需要一个镜头/);
  assert.equal(foundationCalls, 1);
  assert.equal(batchCalls, 2);
  assert.equal(patchCalls, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(finalError, "rawModelOutput"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(finalError, "retryRawModelOutput"), false);
  assert.doesNotMatch(JSON.stringify(finalError), /rawModelOutput|retryRawModelOutput/);
});

test("batch ModelResponseError 仅 status=0 属于模型输出恢复路径", async (t) => {
  await t.test("非法 JSON 首轮进入唯一 second-pass", async () => {
    const context = fixture();
    let batchCalls = 0;
    const workflow = animationWorkflow({
      animationShotBatchSceneCount: 6,
      client: {
        async generateJson(args) {
          if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
            return foundationFrom(context.animationPlan);
          }
          batchCalls += 1;
          if (batchCalls === 1) throw new ModelResponseError("invalid JSON", "{", 0);
          return modelBatchFrom(context);
        }
      }
    });

    const result = await workflow.createAnimationPlan(context);
    assert.equal(batchCalls, 2);
    assert.equal(result.shotPlan.length, 6);
  });

  await t.test("鉴权或供应商 HTTP 错误立即失败", async () => {
    const context = fixture();
    let batchCalls = 0;
    const workflow = animationWorkflow({
      animationShotBatchSceneCount: 6,
      client: {
        async generateJson(args) {
          if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
            return foundationFrom(context.animationPlan);
          }
          batchCalls += 1;
          throw new ModelResponseError("unauthorized", "", 401);
        }
      }
    });

    await assert.rejects(() => workflow.createAnimationPlan(context), /unauthorized/);
    assert.equal(batchCalls, 1);
  });

  await t.test("second-pass 非法 JSON 最终失败且不产生第三次调用", async () => {
    const context = fixture();
    let batchCalls = 0;
    const workflow = animationWorkflow({
      animationShotBatchSceneCount: 6,
      client: {
        async generateJson(args) {
          if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
            return foundationFrom(context.animationPlan);
          }
          batchCalls += 1;
          if (batchCalls === 1) return { shotPlan: [] };
          if (batchCalls === 2) throw new ModelResponseError("retry invalid JSON", "{", 0);
          throw new Error("禁止第三次 batch 调用");
        }
      }
    });

    await assert.rejects(
      () => workflow.createAnimationPlan(context),
      /second-pass 失败.*retry invalid JSON/
    );
    assert.equal(batchCalls, 2);
  });
});

test("second-pass 遇到原本可 patch 的可信叶子时直接最终失败", async () => {
  const context = fixture();
  const firstInvalid = modelBatchFrom(context);
  firstInvalid.shotPlan[0].durationSeconds = 0;
  const retryInvalid = modelBatchFrom(context);
  retryInvalid.shotPlan[0].startFrame.characters[0].pose = "";
  let batchCalls = 0;
  let patchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: "animationShotBatch.shotPlan[0].startFrame.characters[0].pose",
            value: "半蹲在木盒旁"
          };
        }
        batchCalls += 1;
        return structuredClone(batchCalls === 1 ? firstInvalid : retryInvalid);
      }
    }
  });

  await assert.rejects(() => workflow.createAnimationPlan(context), /second-pass 失败.*pose/);
  assert.equal(batchCalls, 2);
  assert.equal(patchCalls, 0);
});

test("patch 修复原错误后出现新 validation 错误时直接进入 second-pass", async () => {
  const context = fixture();
  const firstInvalid = modelBatchFrom(context);
  firstInvalid.shotPlan[0].startFrame.characters[0].pose = "";
  firstInvalid.shotPlan[0].motion.primaryAction = "";
  const validRetry = modelBatchFrom(context);
  let batchCalls = 0;
  let patchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ANIMATION_SHOT_BATCH_SINGLE_FIELD_PATCH_V1")) {
          patchCalls += 1;
          return {
            path: "animationShotBatch.shotPlan[0].startFrame.characters[0].pose",
            value: "半蹲在木盒旁，右手停在盒盖边缘"
          };
        }
        batchCalls += 1;
        return structuredClone(batchCalls === 1 ? firstInvalid : validRetry);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(result.shotPlan.length, 6);
  assert.equal(batchCalls, 2);
  assert.equal(patchCalls, 1);
});

test("first/retry raw 输出保持不可变且不泄漏到生产包或 retry prompt", async () => {
  const context = fixture();
  const firstRaw = modelBatchFrom(context);
  firstRaw.shotPlan[0].shotId = "MODEL-LOCAL-ID";
  firstRaw.shotPlan[0].sceneId = "MODEL-LOCAL-SCENE";
  firstRaw.shotPlan[0].startFrame.environment.sceneId = "MODEL-LOCAL-SCENE";
  firstRaw.shotPlan[0].endFrame.environment.sceneId = "MODEL-LOCAL-SCENE";
  firstRaw.shotPlan[0].videoPrompt = "RAW_ALIAS_SENTINEL";
  firstRaw.shotPlan[0].durationSeconds = 0;
  const retryRaw = modelBatchFrom(context);
  const firstSnapshot = structuredClone(firstRaw);
  const retrySnapshot = structuredClone(retryRaw);
  deepFreeze(firstRaw);
  deepFreeze(retryRaw);

  let batchCalls = 0;
  let firstBatchPrompt = "";
  let retryBatchPrompt = "";
  let retryBatchRequest;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        batchCalls += 1;
        if (batchCalls === 1) {
          firstBatchPrompt = args.prompt;
          return firstRaw;
        }
        retryBatchPrompt = args.prompt;
        retryBatchRequest = structuredClone(args);
        return retryRaw;
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(batchCalls, 2);
  assert.deepEqual(firstRaw, firstSnapshot);
  assert.deepEqual(retryRaw, retrySnapshot);
  assert.ok(retryBatchPrompt.startsWith(firstBatchPrompt));
  assert.match(retryAppendix(retryBatchPrompt), /当前失败 batch：/);
  assert.match(retryAppendix(retryBatchPrompt), /错误诊断：/);
  assert.match(retryAppendix(retryBatchPrompt), /second-pass retry 约束：/);
  assert.equal(retryDiagnostics(retryBatchPrompt).length, 1);
  assert.match(retryDiagnostics(retryBatchPrompt)[0].message, /durationSeconds/);
  assert.equal(Object.prototype.hasOwnProperty.call(retryBatchRequest, "systemPrompt"), false);
  assert.doesNotMatch(retryBatchPrompt, /RAW_ALIAS_SENTINEL/);
  assert.doesNotMatch(retryBatchPrompt, /rawModelOutput|retryRawModelOutput/);
  assert.doesNotMatch(JSON.stringify(result), /rawModelOutput|retryRawModelOutput|RAW_ALIAS_SENTINEL/);
  assert.equal(result.shotPlan[0].shotId, "A01");
  assert.equal(result.shotPlan[0].sceneId, "LOC01");
});

test("deterministic repair 保留未知静态字段并交给 validation 触发 retry", async (t) => {
  const scenarios = [
    {
      name: "negativePrompts",
      mutate(batch) {
        batch.shotPlan[0].negativePrompts.unexpected = "不得被 repair 删除";
      },
      read(candidate) {
        return candidate.shotPlan[0].negativePrompts.unexpected;
      }
    },
    {
      name: "locked-camera",
      mutate(batch) {
        batch.shotPlan[0].endFrame.camera.unexpected = "不得被 repair 删除";
      },
      read(candidate) {
        return candidate.shotPlan[0].endFrame.camera.unexpected;
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const context = fixture();
      const firstRaw = modelBatchFrom(context);
      const validRetry = modelBatchFrom(context);
      scenario.mutate(firstRaw);
      let batchCalls = 0;
      let retryPrompt = "";
      const workflow = animationWorkflow({
        animationShotBatchSceneCount: 6,
        client: {
          async generateJson(args) {
            if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
              return foundationFrom(context.animationPlan);
            }
            batchCalls += 1;
            if (batchCalls === 1) return structuredClone(firstRaw);
            retryPrompt = args.prompt;
            return structuredClone(validRetry);
          }
        }
      });

      const result = await workflow.createAnimationPlan(context);
      assert.equal(batchCalls, 2);
      assert.equal(scenario.read(retryFailedCandidate(retryPrompt)), "不得被 repair 删除");
      assert.equal(result.shotPlan.length, 6);
    });
  }
});

test("deterministic repair 是纯函数且重复执行深度幂等", () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  const foundation = foundationFrom(context.animationPlan);
  const targetShot = rawBatch.shotPlan[2];
  targetShot.shotId = "LOCAL-3";
  targetShot.sceneId = "WRONG-SCENE";
  targetShot.startFrame.environment.sceneId = "WRONG-SCENE";
  targetShot.endFrame.environment.sceneId = "WRONG-SCENE";
  targetShot.endFrame.camera.composition = "不同构图";
  targetShot.endFrame.camera.unexpectedCameraField = "必须保留给静态校验";
  targetShot.motion.endStateRef = "wrong";
  targetShot.motion.emotionArc.from = "错误起点";
  targetShot.motion.emotionArc.to = "错误终点";
  targetShot.videoPrompt = "STALE";
  targetShot.negativePrompts.image = [{
    text: "禁止使用错误镜头证据路径",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "animationPlan.shots[LOCAL-3].startFrame.characters[0].pose",
      evidence: targetShot.startFrame.characters[0].pose
    }, {
      sourcePath: 42,
      evidence: "非法类型必须原样保留给 validation"
    }],
    reasonCode: "explicit_identity_conflict",
    priority: "high",
    enabled: true
  }];
  targetShot.negativePrompts.unexpectedNegativeField = "必须保留给静态校验";
  const immutableContext = Object.freeze({
    shotIdStartIndex: 1,
    sceneIdBySourceScene: Object.freeze(foundation.sceneReferencePrompts.flatMap((scene) => (
      scene.sourceSceneIds.map((sourceSceneId) => Object.freeze([sourceSceneId, scene.sceneId]))
    ))),
    primaryCharacterName: context.fullStory.characterBible.protagonist.name
  });
  const rawSnapshot = structuredClone(rawBatch);

  const repairedOnce = repairAnimationShotBatchCandidate(rawBatch, immutableContext);
  const repairedTwice = repairAnimationShotBatchCandidate(repairedOnce, immutableContext);
  const repairedShot = repairedOnce.shotPlan[2];

  assert.deepEqual(rawBatch, rawSnapshot);
  assert.notStrictEqual(repairedOnce, rawBatch);
  assert.deepEqual(repairedTwice, repairedOnce);
  assert.equal(repairedShot.shotId, "A03");
  assert.equal(repairedShot.sceneId, "LOC03");
  assert.equal(repairedShot.endFrame.camera.composition, repairedShot.startFrame.camera.composition);
  assert.equal(repairedShot.endFrame.camera.unexpectedCameraField, "必须保留给静态校验");
  assert.equal(repairedShot.motion.endStateRef, "endFrame");
  assert.equal(repairedShot.motion.emotionArc.from, repairedShot.startFrame.characters[0].emotionState);
  assert.equal(repairedShot.motion.emotionArc.to, repairedShot.endFrame.characters[0].emotionState);
  assert.equal(
    repairedShot.negativePrompts.image[0].triggerEvidence[0].sourcePath,
    "animationPlan.shotPlan[A03].startFrame.characters[0].pose"
  );
  assert.equal(repairedShot.negativePrompts.image[0].triggerEvidence[1].sourcePath, 42);
  assert.equal(repairedShot.negativePrompts.unexpectedNegativeField, "必须保留给静态校验");
  assert.deepEqual(
    Object.fromEntries(Object.keys(compileAnimationShotPrompts(repairedShot)).map((field) => [field, repairedShot[field]])),
    compileAnimationShotPrompts(repairedShot)
  );
});

test("emotionArc repair 在主角标识缺失或 frame 同名重复时保持原值", () => {
  const context = fixture();
  const foundation = foundationFrom(context.animationPlan);
  const baseContext = {
    shotIdStartIndex: 1,
    sceneIdBySourceScene: foundation.sceneReferencePrompts.flatMap((scene) => (
      scene.sourceSceneIds.map((sourceSceneId) => [sourceSceneId, scene.sceneId])
    ))
  };

  const missingPrimary = modelBatchFrom(context);
  missingPrimary.shotPlan[0].motion.emotionArc.from = "缺失标识时不得修复";
  const missingResult = repairAnimationShotBatchCandidate(missingPrimary, {
    ...baseContext,
    primaryCharacterName: ""
  });
  assert.equal(missingResult.shotPlan[0].motion.emotionArc.from, "缺失标识时不得修复");

  const duplicatePrimary = modelBatchFrom(context);
  const duplicateShot = duplicatePrimary.shotPlan[0];
  duplicateShot.motion.emotionArc.from = "重复匹配时不得修复";
  duplicateShot.startFrame.characters.push(structuredClone(duplicateShot.startFrame.characters[0]));
  const duplicateResult = repairAnimationShotBatchCandidate(duplicatePrimary, {
    ...baseContext,
    primaryCharacterName: context.fullStory.characterBible.protagonist.name
  });
  assert.equal(duplicateResult.shotPlan[0].motion.emotionArc.from, "重复匹配时不得修复");
});

test("emotionArc repair 按明确主角标识匹配并允许主角不在 characters[0]", async () => {
  const context = fixture();
  const firstRaw = modelBatchFrom(context);
  const shot = firstRaw.shotPlan[0];
  const startPrimary = shot.startFrame.characters[0];
  const endPrimary = shot.endFrame.characters[0];
  shot.startFrame.characters.unshift({
    ...structuredClone(startPrimary),
    name: "明确配角",
    emotionState: "配角紧张"
  });
  shot.endFrame.characters.unshift({
    ...structuredClone(endPrimary),
    name: "尾帧另一配角",
    emotionState: "配角放松"
  });
  shot.motion.emotionArc.from = "错误起点";
  shot.motion.emotionArc.to = "错误终点";
  let batchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        batchCalls += 1;
        return structuredClone(firstRaw);
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  const repairedShot = result.shotPlan[0];
  assert.equal(batchCalls, 1);
  assert.deepEqual(repairedShot.startFrame.characters.map((item) => item.name), ["明确配角", "阿岚"]);
  assert.deepEqual(repairedShot.endFrame.characters.map((item) => item.name), ["尾帧另一配角", "阿岚"]);
  assert.equal(repairedShot.motion.emotionArc.from, startPrimary.emotionState);
  assert.equal(repairedShot.motion.emotionArc.to, endPrimary.emotionState);
  assert.notEqual(repairedShot.motion.emotionArc.from, repairedShot.startFrame.characters[0].emotionState);
  assert.equal(result.shotPlan.length, 6);
});

test("显式主角 validation projection 不得补齐 loop 镜头真实角色名单", async () => {
  const context = fixture();
  const invalidLoopBatch = modelBatchFrom(context);
  const shot = invalidLoopBatch.shotPlan[0];
  const primary = structuredClone(shot.startFrame.characters[0]);
  shot.startFrame.characters = [{
    ...structuredClone(primary),
    name: "仅首帧出现的配角"
  }, primary];
  shot.endFrame = structuredClone(shot.startFrame);
  shot.endFrame.characters = [structuredClone(primary)];
  shot.motion.mode = "loop";
  shot.motion.stopCondition = "循环回到首帧状态后停止";
  shot.motion.emotionArc.from = primary.emotionState;
  shot.motion.emotionArc.to = primary.emotionState;
  let batchCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        batchCalls += 1;
        return structuredClone(invalidLoopBatch);
      }
    }
  });

  await assert.rejects(
    () => workflow.createAnimationPlan(context),
    /second-pass 失败.*(?:无法在 endFrame 找到主角色|循环镜头首尾角色名单必须一致)/
  );
  assert.equal(batchCalls, 2);
});

test("actionState 审核 ModelResponseError 只在 status=0 时按协议失败处理", async (t) => {
  await t.test("审核非法 JSON 首轮重试、second-pass 严格失败", async () => {
    const context = fixture();
    const rawBatch = modelBatchFrom(context);
    rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色脸上露出惊讶表情";
    let batchCalls = 0;
    let auditCalls = 0;
    const workflow = animationWorkflow({
      animationShotBatchSceneCount: 6,
      client: {
        async generateJson(args) {
          if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
            return foundationFrom(context.animationPlan);
          }
          if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
            auditCalls += 1;
            throw new ModelResponseError("audit invalid JSON", "{", 0);
          }
          batchCalls += 1;
          return structuredClone(rawBatch);
        }
      }
    });

    await assert.rejects(
      () => workflow.createAnimationPlan(context),
      /second-pass 失败.*actionState 语义审核协议失败.*audit invalid JSON/
    );
    assert.equal(batchCalls, 2);
    assert.equal(auditCalls, 2);
  });

  await t.test("审核 HTTP 错误立即失败且不重试 batch", async () => {
    const context = fixture();
    const rawBatch = modelBatchFrom(context);
    rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色脸上露出惊讶表情";
    let batchCalls = 0;
    let auditCalls = 0;
    const workflow = animationWorkflow({
      animationShotBatchSceneCount: 6,
      client: {
        async generateJson(args) {
          if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
            return foundationFrom(context.animationPlan);
          }
          if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
            auditCalls += 1;
            throw new ModelResponseError("audit unavailable", "", 503);
          }
          batchCalls += 1;
          return structuredClone(rawBatch);
        }
      }
    });

    await assert.rejects(() => workflow.createAnimationPlan(context), /audit unavailable/);
    assert.equal(batchCalls, 1);
    assert.equal(auditCalls, 1);
  });
});

test("actionState 审核网络错误属于系统失败且不触发 batch retry", async () => {
  const context = fixture();
  const rawBatch = modelBatchFrom(context);
  rawBatch.shotPlan[0].startFrame.characters[0].actionState = "角色脸上露出惊讶表情";
  let batchCalls = 0;
  let auditCalls = 0;
  const workflow = animationWorkflow({
    animationShotBatchSceneCount: 6,
    client: {
      async generateJson(args) {
        if (args.prompt.includes("本阶段只生成可供所有镜头批次复用")) {
          return foundationFrom(context.animationPlan);
        }
        if (args.prompt.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) {
          auditCalls += 1;
          throw new Error("network unavailable");
        }
        batchCalls += 1;
        return structuredClone(rawBatch);
      }
    }
  });

  await assert.rejects(() => workflow.createAnimationPlan(context), /network unavailable/);
  assert.equal(batchCalls, 1);
  assert.equal(auditCalls, 1);
});
