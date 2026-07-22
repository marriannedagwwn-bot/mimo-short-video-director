import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { compileAnimationShotPrompts } from "../src/animation-prompt-compiler.js";
import { animationFoundationPrompt, animationShotBatchPrompt } from "../src/prompts.js";
import { ensureAnimationFoundationContract, ensureAnimationShotBatchContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  const workflow = new WorkflowService({
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
  const workflow = new WorkflowService({
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

test("v2 结构与兼容字符串不一致时只纠偏当前镜头批次", async () => {
  const context = fixture();
  let firstBatchAttempts = 0;
  const prompts = [];
  const workflow = new WorkflowService({
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
  assert.equal(firstBatchAttempts, 2);
  assert.equal(prompts.filter((prompt) => prompt.includes("本阶段只生成可供所有镜头批次复用")).length, 1);
  assert.match(prompts[2], /已存在别名 videoPrompt 与编译结果不一致/u);
  assert.equal(result.shotPlan[0].videoPrompt, compileAnimationShotPrompts(result.shotPlan[0]).videoPrompt);
});

test("v2 foundation 收到 legacy 镜头时立即纠偏当前批次", async () => {
  const context = fixture();
  let firstBatchAttempts = 0;
  const prompts = [];
  const workflow = new WorkflowService({
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
  assert.equal(firstBatchAttempts, 2);
  assert.match(prompts[2], /必须输出 v2 结构化字段/u);
  assert.equal(result.shotPlan.length, 6);
  assert.ok(result.shotPlan.every((shot) => shot.startFrame && shot.endFrame && shot.motion));
});

test("镜头批次校验失败时只纠偏当前批次，不重生基础锁定", async () => {
  const context = fixture();
  const calls = [];
  let firstBatchAttempts = 0;
  const workflow = new WorkflowService({
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
  assert.equal(calls.filter((prompt) => prompt.includes("本阶段只生成可供所有镜头批次复用")).length, 1);
  assert.equal(firstBatchAttempts, 2);
  assert.equal(calls.length, 5);
  assert.equal(result.shotPlan.length, 6);
  assert.match(calls[2], /上一次输出已经是 JSON，但没有通过系统校验/);
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
  const workflow = new WorkflowService({
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
  const workflow = new WorkflowService({
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
  const workflow = new WorkflowService({
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

test("镜头必须使用 sourceSceneId 在基础阶段锁定的 sceneId", async () => {
  const context = fixture();
  let call = 0;
  let firstBatchAttempts = 0;
  const workflow = new WorkflowService({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson() {
        call += 1;
        if (call === 1) return foundationFrom(context.animationPlan);
        if (call <= 3) {
          firstBatchAttempts += 1;
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          if (firstBatchAttempts === 1) shots[1].sceneId = shots[0].sceneId;
          return { shotPlan: shots };
        }
        const batchIndex = call - 3;
        return { shotPlan: structuredClone(context.animationPlan.shotPlan.slice(batchIndex * 2, batchIndex * 2 + 2)) };
      }
    }
  });

  const result = await workflow.createAnimationPlan(context);
  assert.equal(firstBatchAttempts, 2);
  assert.equal(result.shotPlan[1].sceneId, "LOC02");
});

test("当前批会与已完成镜头一起校验，跨批重复负面词只重试当前批", async () => {
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
  const workflow = new WorkflowService({
    animationShotBatchSceneCount: 2,
    client: {
      async generateJson() {
        call += 1;
        if (call === 1) return foundationFrom(context.animationPlan);
        if (call === 2) {
          const shots = structuredClone(context.animationPlan.shotPlan.slice(0, 2));
          shots[0].negativePrompts.image = [structuredClone(duplicateNegative)];
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
  assert.equal(result.shotPlan[0].negativePrompts.image.length, 1);
  assert.deepEqual(result.shotPlan[2].negativePrompts.image, []);
  assert.equal(call, 5);
});
