import test from "node:test";
import assert from "node:assert/strict";
import { mockAnalysis, mockBrief, mockReconstruction } from "../src/mock.js";
import { RECONSTRUCTION_SYSTEM_PROMPT, analysisPrompt, reconstructionPrompt } from "../src/prompts.js";
import {
  groundingContextDigest,
  sealReconstruction,
  sealReferenceAnalysis,
  verifyReconstructionSeal
} from "../src/reconstruction-grounding.js";
import { InputError, OutputContractError, ensureOutputContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";

const frames = [
  { timestamp: 0, dataUrl: "data:image/jpeg;base64,AA==" },
  { timestamp: 12, dataUrl: "data:image/jpeg;base64,AA==" },
  { timestamp: 24, dataUrl: "data:image/jpeg;base64,AA==" }
];
const metadata = { name: "reference.mp4", duration: 24, width: 1080, height: 1920 };
const transcript = "00:00-00:04 主角拿起桌上的纸袋。\n00:20-00:24 主角把纸袋交给门口的人。";
const creatorProfile = { fixedCharacter: "阿岚，社区修理师", vertical: "家电维修", constraints: "60 秒内" };

function context(overrides = {}) {
  return { frames, metadata, transcript, ...overrides };
}

function completeScript(overrides = {}) {
  return { ...mockReconstruction(context()), ...overrides };
}

test("analysis prompt 提供原生视频 evidence 的秒级容差上限", () => {
  const prompt = analysisPrompt(context({
    metadata: { ...metadata, duration: 96.269932 },
    video: {
      dataUrl: "data:video/mp4;base64,AAAA",
      mimeType: "video/mp4",
      size: 4
    }
  }));

  assert.match(prompt, /时长：01:36/u);
  assert.match(prompt, /最大整数结束秒为 97/u);
  assert.match(prompt, /"startSecond":0,"endSecond":3/u);
  assert.match(prompt, /不得输出毫秒字段/u);
});

test("原生视频 evidence 按秒接受不足一秒尾差并拒绝远端越界", () => {
  const workflow = new WorkflowService();
  const videoContext = context({
    metadata: { ...metadata, duration: 96.269932 },
    video: {
      dataUrl: "data:video/mp4;base64,AAAA",
      mimeType: "video/mp4",
      size: 4
    }
  });
  const invalid = mockAnalysis(videoContext);
  invalid.observedFacts[0].evidenceRefs = [{ source: "video", startSecond: 96, endSecond: 125 }];

  assert.throws(
    () => sealReferenceAnalysis(invalid, videoContext, workflow.groundingKey),
    /模型值 125s，允许的最大整数秒为 97s/u
  );

  const boundary = mockAnalysis(videoContext);
  boundary.observedFacts[0].evidenceRefs = [{ source: "video", startSecond: 96, endSecond: 97 }];
  assert.doesNotThrow(() => sealReferenceAnalysis(boundary, videoContext, workflow.groundingKey));

  const legacyMilliseconds = mockAnalysis(videoContext);
  legacyMilliseconds.observedFacts[0].evidenceRefs = [{ source: "video", startMs: 96000, endMs: 97000 }];
  assert.throws(
    () => sealReferenceAnalysis(legacyMilliseconds, videoContext, workflow.groundingKey),
    /缺少字段：startSecond、endSecond/u
  );
});

test("reconstruction prompt 恢复完整脚本字段并移除引用图契约", () => {
  const prompt = reconstructionPrompt({
    referenceAnalysis: { storySynopsis: "主角完成一次送达" },
    metadata,
    transcript
  });

  assert.match(prompt, /还原原片完整脚本/u);
  assert.match(prompt, /"timeRange"|"location"/u);
  assert.match(prompt, /"visibleActions"/u);
  assert.match(prompt, /"dialogueGist"/u);
  assert.match(prompt, /"shotDesign"/u);
  assert.match(prompt, /"relationshipPattern":""/u);
  assert.doesNotMatch(prompt, /occurrenceTimeline|globalFactRefs|只读事实目录/u);
});

test("完整脚本契约接受 B 的字段结构并拒绝引用图替代品", () => {
  const result = ensureOutputContract(completeScript(), "sourceScriptReconstruction");
  assert.equal(result.scenes[0].location, "出发点");
  assert.ok(result.scenes[0].visibleActions.length > 0);

  assert.throws(
    () => ensureOutputContract({
      schemaVersion: "2.0",
      sourceFacts: [],
      globalFactRefs: [],
      scenes: [{ sceneId: "S1", structureRole: "opening", factRefs: [] }],
      coreEventSequence: [],
      relationshipPattern: { factRefs: [] },
      endingAction: { sceneRef: null, factRefs: [] },
      turningPoints: [],
      uncertainties: []
    }, "sourceScriptReconstruction"),
    (error) => error instanceof OutputContractError && /relationshipPattern|endingAction/u.test(error.message)
  );
});

test("demo 工作流返回可读完整脚本并保留服务端签名", async () => {
  const workflow = new WorkflowService();
  const referenceAnalysis = await workflow.analyze(context());
  const result = await workflow.reconstruct({ ...context(), referenceAnalysis });

  assert.equal(result.scenes.length, 4);
  assert.equal(result.scenes[0].location, "出发点");
  assert.ok(Array.isArray(result.scenes[0].visibleActions));
  assert.equal(typeof result.relationshipPattern, "string");
  assert.equal(typeof result.endingAction.action, "string");
  assert.ok(result.groundingSeal?.signature);

  const trusted = verifyReconstructionSeal(result, workflow.groundingKey, {
    expectedContextDigest: groundingContextDigest(context())
  });
  assert.equal(trusted.scenes[3].sceneId, "S4");
  assert.equal("groundingSeal" in trusted, false);
});

test("live reconstruction 使用专用事实还原 system prompt 和完整 referenceAnalysis", async () => {
  const calls = [];
  const script = completeScript();
  const client = {
    async generateJsonWithMedia(request) {
      calls.push(request);
      return structuredClone(script);
    }
  };
  const workflow = new WorkflowService({ client });
  const referenceAnalysis = sealReferenceAnalysis(mockAnalysis(context()), context(), workflow.groundingKey);

  const result = await workflow.reconstruct({ ...context(), referenceAnalysis });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, RECONSTRUCTION_SYSTEM_PROMPT);
  assert.equal(calls[0].frames, frames);
  assert.match(calls[0].prompt, /storySynopsis/u);
  assert.match(calls[0].prompt, /visibleActions/u);
  assert.doesNotMatch(calls[0].prompt, /groundingSeal/u);
  assert.equal(result.scenes[0].location, script.scenes[0].location);
});

test("完整脚本候选校验失败时 fail closed，不发送整份脚本纠偏", async () => {
  const calls = [];
  const client = {
    async generateJsonWithMedia(request) {
      calls.push(request);
      return { schemaVersion: "2.0", scenes: [], sourceFacts: [] };
    }
  };
  const workflow = new WorkflowService({ client });
  const referenceAnalysis = sealReferenceAnalysis(mockAnalysis(context()), context(), workflow.groundingKey);

  await assert.rejects(
    () => workflow.reconstruct({ ...context(), referenceAnalysis }),
    (error) => error instanceof OutputContractError
  );
  assert.equal(calls.length, 1);
});

test("篡改签名 analysis 后 reconstruction 在调用模型前拒绝", async () => {
  let called = false;
  const client = {
    async generateJsonWithMedia() {
      called = true;
      return completeScript();
    }
  };
  const workflow = new WorkflowService({ client });
  const referenceAnalysis = sealReferenceAnalysis(mockAnalysis(context()), context(), workflow.groundingKey);
  const tampered = structuredClone(referenceAnalysis);
  tampered.storySynopsis = "被客户端替换的剧情";

  await assert.rejects(
    () => workflow.reconstruct({ ...context(), referenceAnalysis: tampered }),
    (error) => error instanceof InputError && /签名|重新运行参考片分析/u.test(error.message)
  );
  assert.equal(called, false);
});

test("带 observedFacts 的未签名 analysis 不会越过 reconstruction 信任边界", async () => {
  let called = false;
  const workflow = new WorkflowService({
    client: {
      async generateJsonWithMedia() {
        called = true;
        return completeScript();
      }
    }
  });

  await assert.rejects(
    () => workflow.reconstruct({ ...context(), referenceAnalysis: mockAnalysis(context()) }),
    (error) => error instanceof InputError && /未经服务端签名/u.test(error.message)
  );
  assert.equal(called, false);
});

test("下游只消费验签后的完整脚本，篡改内容会被拒绝", async () => {
  const captured = [];
  const client = {
    async generateJson(request) {
      captured.push(request);
      return mockBrief({ referenceAnalysis: {}, sourceScriptReconstruction: {}, creatorProfile });
    }
  };
  const workflow = new WorkflowService({ client });
  const analysis = mockAnalysis(context());
  const referenceAnalysis = sealReferenceAnalysis(analysis, context(), workflow.groundingKey);
  const sourceScriptReconstruction = sealReconstruction(
    completeScript(),
    workflow.groundingKey,
    groundingContextDigest(context())
  );

  await workflow.createBrief({ referenceAnalysis, sourceScriptReconstruction, creatorProfile });
  assert.equal(captured.length, 1);
  assert.match(captured[0].prompt, /"location":"出发点"/u);
  assert.match(captured[0].prompt, /"visibleActions"/u);
  assert.doesNotMatch(captured[0].prompt, /groundingSeal/u);

  const tampered = structuredClone(sourceScriptReconstruction);
  tampered.scenes[0].location = "被篡改的地点";
  await assert.rejects(
    () => workflow.createBrief({ referenceAnalysis, sourceScriptReconstruction: tampered, creatorProfile }),
    (error) => error instanceof InputError && /签名|脚本还原/u.test(error.message)
  );
});

test("合法 analysis 与 reconstruction 不能跨素材上下文混配", async () => {
  const workflow = new WorkflowService();
  const contextA = context();
  const contextB = context({ transcript: "00:00-00:04 另一条素材。" });
  const analysisB = sealReferenceAnalysis(mockAnalysis(contextB), contextB, workflow.groundingKey);
  const reconstructionA = sealReconstruction(
    completeScript(),
    workflow.groundingKey,
    groundingContextDigest(contextA)
  );

  await assert.rejects(
    () => workflow.createBrief({
      referenceAnalysis: analysisB,
      sourceScriptReconstruction: reconstructionA,
      creatorProfile
    }),
    (error) => error instanceof InputError && /素材上下文|不一致/u.test(error.message)
  );
});
