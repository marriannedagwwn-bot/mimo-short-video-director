import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveVideoPromptProfile } from "../public/video-prompt-profiles.js";
import {
  generateShotVideo,
  shouldDeferH3CharacterAppearanceBoundaryCheck
} from "../src/shot-video-generator.js";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";

const BASE_PROMPT = `integrated_multimodal_description: [Shot 1] A warm medium tracking shot follows Xiaobaizi as she crosses a rural courtyard and places a rolled notice fully inside a bamboo mailbox. [Shot 2] At 00:03.000, the camera cuts to a backlit medium-wide view as she releases the notice and holds a relaxed completed pose.
overall_soundscape: Light footsteps, paper rustle, and a soft bamboo tap remain synchronized with the visible actions.
non_diegetic_music: A sparse acoustic-guitar pattern fades after the completed pose.`;

const REF2VA_PROMPT = `subject_definitions:
<Subject 1> is Xiaobaizi, whose signed identity and appearance are guided by <Picture 1>.
summary:
[reference generation] The target follows the signed Animation Plan and uses <Picture 1> only for <Subject 1>'s identity.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - signed identity and appearance remain unchanged.
detailed_description:
[Shot 1] A warm medium tracking shot follows <Subject 1> as she crosses a rural courtyard and places a rolled notice fully inside a bamboo mailbox. [Shot 2] At 00:03.000, the camera cuts to a backlit medium-wide view as she releases the notice and holds a relaxed completed pose.
overall_soundscape:
Light footsteps, paper rustle, and a soft bamboo tap remain synchronized with the visible actions.
non_diegetic_music:
A sparse acoustic-guitar pattern fades after the completed pose.`;

const H3_PROFILE = resolveVideoPromptProfile({ provider: "MiniMax", model: "MiniMax-H3" });

test("只有实际发送签发角色图的 MiniMax H3 all_reference 才延后旧 Base 外观边界检查", () => {
  const base = {
    generationMode: "all_reference",
    videoProvider: "MiniMax",
    videoModel: "MiniMax-H3",
    videoPromptProfile: H3_PROFILE,
    referenceAssets: [{
      source: "character_reference",
      sourceCharacterName: "小白子",
      dataUrl: "data:image/png;base64,AA=="
    }]
  };
  assert.equal(shouldDeferH3CharacterAppearanceBoundaryCheck(base), true);
  assert.equal(shouldDeferH3CharacterAppearanceBoundaryCheck({
    ...base,
    referenceAssets: [{ source: "upload", dataUrl: "data:image/png;base64,AA==" }]
  }), false);
  assert.equal(shouldDeferH3CharacterAppearanceBoundaryCheck({
    ...base,
    referenceAssets: []
  }), false);
  assert.equal(shouldDeferH3CharacterAppearanceBoundaryCheck({
    ...base,
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128"
  }), false);
  assert.equal(shouldDeferH3CharacterAppearanceBoundaryCheck({
    ...base,
    videoPromptProfile: resolveVideoPromptProfile({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128"
    })
  }), false);
});

test("MiniMax H3 all_reference 先用同序同字节素材完成 Context-IR，再提交严格六段 Prompt 和可核验回执", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const provider = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        task_id: request.url === "/v2/h3_context_ir" ? "context-ir-task" : "generation-task"
      }));
      return;
    }
    if (request.url === "/v2/query/video_generation/context-ir-task") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        task: {
          id: "context-ir-task",
          status: "succeeded",
          task_type: "h3_context_ir",
          content: { prompt: REF2VA_PROMPT }
        }
      }));
      return;
    }
    if (request.url === "/v2/query/video_generation/generation-task") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        task: {
          id: "generation-task",
          status: "succeeded",
          content: { url: `http://127.0.0.1:${provider.address().port}/media/generated.mp4` }
        }
      }));
      return;
    }
    if (request.url === "/media/generated.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(Buffer.alloc(700, 7));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())));

  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${provider.address().port}/v2/video_generation`,
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    pollIntervalMs: 1,
    pollTimeoutMs: 1000
  }));
  let currentChecks = 0;
  let semanticAudits = 0;
  const result = await generateShotVideo({
    configPath,
    outputRoot: path.join(root, "generated"),
    publicBasePath: "/generated",
    videoProvider: "MiniMax",
    videoModel: "MiniMax-H3",
    videoPromptProfile: H3_PROFILE,
    videoPromptSource: "animation_plan",
    generationMode: "all_reference",
    aspectRatio: "16:9",
    referenceAssets: [{
      mediaType: "image",
      name: "xiaobaizi.png",
      source: "character_reference",
      sourceCharacterName: "小白子",
      dataUrl: `data:image/png;base64,${Buffer.from("signed character bytes").toString("base64")}`
    }],
    characterReferences: [{
      characterName: "小白子",
      appearancePrompt: "BOUND_RUNTIME_APPEARANCE_MUST_NOT_BE_SENT"
    }],
    assertProductionContextCurrent: async () => { currentChecks += 1; },
    auditMiniMaxH3ExpandedPromptSemantics: async ({ sourcePrompt, expandedPrompt, referenceManifest }) => {
      semanticAudits += 1;
      assert.equal(sourcePrompt, BASE_PROMPT);
      assert.equal(expandedPrompt, REF2VA_PROMPT);
      assert.equal(referenceManifest.contentItems.length, 1);
      return { schemaVersion: "test/1.0", verdict: "pass", issues: [] };
    },
    videoOutputProbe: async () => {},
    shot: {
      shotId: "A01",
      sourceSceneId: "S1",
      durationSeconds: 5,
      videoPrompt: BASE_PROMPT,
      dialogueOrSubtitle: ""
    }
  });

  assert.equal(currentChecks, 2);
  assert.equal(semanticAudits, 1);
  assert.deepEqual(requests.map((item) => item.url), ["/v2/h3_context_ir", "/v2/video_generation"]);
  const contextBody = requests[0].body;
  const generationBody = requests[1].body;
  assert.deepEqual(contextBody.content.slice(1), generationBody.content.slice(1));
  assert.match(contextBody.content[0].text, /signed character 小白子 only/u);
  assert.doesNotMatch(contextBody.content[0].text, /BOUND_RUNTIME_APPEARANCE_MUST_NOT_BE_SENT/u);
  assert.equal(generationBody.content[0].text, REF2VA_PROMPT);
  assert.equal(generationBody.duration, 5);
  assert.equal(generationBody.ratio, "16:9");
  assert.equal(result.effectiveVideoPrompt, REF2VA_PROMPT);
  assert.equal(result.promptReceipt.compiler.providerTaskId, "context-ir-task");
  assert.equal(result.promptReceipt.referenceManifest.contentItems[0].sourceCharacterName, "小白子");
  assert.match(result.promptReceipt.referenceManifest.contentItems[0].sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.promptReceipt.referenceManifest.labelBindings.map((item) => item.label), [
    "<Picture 1>",
    "<Subject 1>"
  ]);
  assert.equal(result.promptReceipt.providerSubmissions[0].providerTaskId, "generation-task");
  assert.equal(
    result.promptReceipt.providerSubmissions[0].submittedPromptSha256,
    result.promptReceipt.effective.textSha256
  );
  assert.equal(result.receipt.audioRequested, true);
  assert.equal(result.receipt.audioOutputMode, "native");
});

test("Context-IR 完成后生产上下文若已失效，必须在最终视频请求前中止", async (t) => {
  const fixture = await injectedGeneratorFixture(t);
  const capabilities = [];
  let checks = 0;
  await assert.rejects(() => generateShotVideo({
    ...fixture.options,
    assertProductionContextCurrent: async () => {
      checks += 1;
      if (checks === 2) throw new Error("STALE_PLAN_AFTER_CONTEXT_IR");
    },
    workerRunner: async ({ request, output, receipt }) => {
      const task = JSON.parse(await fs.readFile(request, "utf8"));
      capabilities.push(task.capability);
      assert.equal(task.capability, "h3_context_ir");
      await fs.writeFile(output, REF2VA_PROMPT);
      await fs.writeFile(receipt, JSON.stringify({ providerTaskId: "context-ir-task" }));
    }
  }), /STALE_PLAN_AFTER_CONTEXT_IR/u);
  assert.equal(checks, 2);
  assert.deepEqual(capabilities, ["h3_context_ir"]);
});

test("Context-IR 付费调用前生产上下文已失效时不发送任何供应商请求", async (t) => {
  const fixture = await injectedGeneratorFixture(t);
  const capabilities = [];
  await assert.rejects(() => generateShotVideo({
    ...fixture.options,
    assertProductionContextCurrent: async () => {
      throw new Error("STALE_PLAN_BEFORE_CONTEXT_IR");
    },
    workerRunner: async ({ request }) => {
      const task = JSON.parse(await fs.readFile(request, "utf8"));
      capabilities.push(task.capability);
    }
  }), /STALE_PLAN_BEFORE_CONTEXT_IR/u);
  assert.deepEqual(capabilities, []);
});

test("Context-IR 把禁止特征赋给固定角色时由语义审计阻断，且不得提交最终视频", async (t) => {
  const fixture = await injectedGeneratorFixture(t);
  const capabilities = [];
  const conflictingPrompt = REF2VA_PROMPT.replace(
    "signed identity and appearance remain unchanged",
    "signed identity changes into cat ears and appearance remains otherwise unchanged"
  );
  await assert.rejects(() => generateShotVideo({
    ...fixture.options,
    visualGuardrails: {
      fixedCharacterBoundary: {
        characterName: "小白子",
        requiredTraits: [],
        allowedTraits: [],
        forbiddenTraits: [{ canonicalName: "cat ears", terms: ["cat ears"] }]
      }
    },
    auditMiniMaxH3ExpandedPromptSemantics: async ({ expandedPrompt }) => {
      assert.equal(expandedPrompt, conflictingPrompt);
      return {
        schemaVersion: "test/1.0",
        verdict: "fail",
        issues: [{
          category: "character_identity",
          reason: "expanded Prompt assigns the signed fixed character a forbidden cat-ears identity trait"
        }]
      };
    },
    workerRunner: async ({ request, output, receipt }) => {
      const task = JSON.parse(await fs.readFile(request, "utf8"));
      capabilities.push(task.capability);
      assert.equal(task.capability, "h3_context_ir");
      await fs.writeFile(output, conflictingPrompt);
      await fs.writeFile(receipt, JSON.stringify({ providerTaskId: "context-ir-task" }));
    }
  }), /语义一致性审计未返回 pass/u);
  assert.deepEqual(capabilities, ["h3_context_ir"]);
});

test("Context-IR 六段格式合法但语义漂移时，审计失败并阻断最终视频", async (t) => {
  const fixture = await injectedGeneratorFixture(t);
  const capabilities = [];
  await assert.rejects(() => generateShotVideo({
    ...fixture.options,
    auditMiniMaxH3ExpandedPromptSemantics: async ({ expandedPrompt }) => {
      assert.equal(expandedPrompt, REF2VA_PROMPT);
      throw new Error("SEMANTIC_DRIFT_ACTION_LOCATION_SOUND");
    },
    workerRunner: async ({ request, output, receipt }) => {
      const task = JSON.parse(await fs.readFile(request, "utf8"));
      capabilities.push(task.capability);
      assert.equal(task.capability, "h3_context_ir");
      await fs.writeFile(output, REF2VA_PROMPT);
      await fs.writeFile(receipt, JSON.stringify({ providerTaskId: "context-ir-task" }));
    }
  }), /SEMANTIC_DRIFT_ACTION_LOCATION_SOUND/u);
  assert.deepEqual(capabilities, ["h3_context_ir"]);
});

test("Context-IR 的每个物理标签必须覆盖且不能超出实际传入素材", async (t) => {
  const missingFixture = await injectedGeneratorFixture(t);
  const missingPicture = REF2VA_PROMPT
    .replace(/, whose signed identity and appearance are guided by <Picture 1>/u, "")
    .replace(/ and uses <Picture 1> only for <Subject 1>'s identity/u, "")
    .replace(/ while <Picture 1>[^.]+\./u, ".");
  await assert.rejects(() => generateShotVideo({
    ...missingFixture.options,
    workerRunner: contextIrOnlyRunner(missingPicture)
  }), /未在 subject_definitions 定义真实传入素材|未绑定任何(?:真实传入|实际参考)素材/u);

  const extraFixture = await injectedGeneratorFixture(t);
  const extraPicture = REF2VA_PROMPT.replace(
    "<Subject 1> is Xiaobaizi, whose signed identity and appearance are guided by <Picture 1>.",
    "<Subject 1> is Xiaobaizi, whose signed identity and appearance are guided by <Picture 1> and <Picture 2>."
  );
  await assert.rejects(() => generateShotVideo({
    ...extraFixture.options,
    workerRunner: contextIrOnlyRunner(extraPicture)
  }), /没有真实传入素材的标签.*<Picture 2>/u);
});

test("MiniMax H3 Profile 不匹配时明确阻断，不能跳过 Context-IR 直提旧 Prompt", async (t) => {
  const fixture = await injectedGeneratorFixture(t);
  const capabilities = [];
  await assert.rejects(() => generateShotVideo({
    ...fixture.options,
    videoPromptProfile: resolveVideoPromptProfile({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128"
    }),
    shot: { ...fixture.options.shot, videoPrompt: "普通未编译提示词" },
    workerRunner: async ({ request }) => {
      const task = JSON.parse(await fs.readFile(request, "utf8"));
      capabilities.push(task.capability);
    }
  }), /不是已签发的 MiniMax H3 提示词 Profile|确认重新生成/u);
  assert.deepEqual(capabilities, []);
});

test("MiniMax H3 worker 严格拒绝非法时长、超长 Prompt 和超过 12 项的混合参考", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-worker-limits-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "image.png");
  const videoPath = path.join(root, "video.mp4");
  const audioPath = path.join(root, "audio.mp3");
  await Promise.all([
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key",
      duration: 5
    })),
    fs.writeFile(imagePath, "image"),
    fs.writeFile(videoPath, "video"),
    fs.writeFile(audioPath, "audio")
  ]);
  const baseRequest = {
    taskId: "limits",
    capability: "all_reference_video_generation",
    outputKey: "preview.limits",
    provider: "MiniMax",
    model: "MiniMax-H3",
    prompt: "valid prompt",
    inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
    parameters: { durationSeconds: 5, aspectRatio: "9:16" }
  };
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, parameters: { ...baseRequest.parameters, durationSeconds: 3 } },
    output: path.join(root, "duration.mp4")
  }), /4–15 秒整数|不能静默改写/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, parameters: { ...baseRequest.parameters, durationSeconds: 0 } },
    output: path.join(root, "zero-duration.mp4")
  }), /4–15 秒整数|不能静默改写/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, prompt: "x".repeat(7001) },
    output: path.join(root, "prompt.mp4")
  }), /超过 7000 字符|拒绝截断/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: {
      ...baseRequest,
      inputArtifacts: [
        ...Array.from({ length: 9 }, () => ({ path: imagePath, mediaType: "image", role: "reference_image" })),
        ...Array.from({ length: 3 }, () => ({ path: videoPath, mediaType: "video", role: "reference_video" })),
        { path: audioPath, mediaType: "audio", role: "reference_audio" }
      ]
    },
    output: path.join(root, "mixed.mp4")
  }), /总数最多 12 项/u);

  const smallBodyConfigPath = path.join(root, "small-body-provider.json");
  await fs.writeFile(smallBodyConfigPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    maxRequestBodyBytes: 200
  }));
  await assert.rejects(() => executeGenericHttpWorker({
    config: smallBodyConfigPath,
    request: baseRequest,
    output: path.join(root, "request-body.mp4")
  }), /最终请求体不得超过|拒绝截断或丢弃/u);
});

async function injectedGeneratorFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-injected-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "https://provider.invalid/v2/video_generation",
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key"
  }));
  return {
    root,
    options: {
      configPath,
      outputRoot: path.join(root, "generated"),
      videoProvider: "MiniMax",
      videoModel: "MiniMax-H3",
      videoPromptProfile: H3_PROFILE,
      generationMode: "all_reference",
      referenceAssets: [{
        mediaType: "image",
        name: "xiaobaizi.png",
        source: "character_reference",
        sourceCharacterName: "小白子",
        dataUrl: `data:image/png;base64,${Buffer.from("signed character bytes").toString("base64")}`
      }],
      videoOutputProbe: async () => {},
      auditMiniMaxH3ExpandedPromptSemantics: async () => ({
        schemaVersion: "test/1.0",
        verdict: "pass",
        issues: []
      }),
      shot: {
        shotId: "A01",
        sourceSceneId: "S1",
        durationSeconds: 5,
        videoPrompt: BASE_PROMPT,
        dialogueOrSubtitle: ""
      }
    }
  };
}

function contextIrOnlyRunner(prompt) {
  return async ({ request, output, receipt }) => {
    const task = JSON.parse(await fs.readFile(request, "utf8"));
    assert.equal(task.capability, "h3_context_ir");
    await fs.writeFile(output, prompt);
    await fs.writeFile(receipt, JSON.stringify({ providerTaskId: "context-ir-task" }));
  };
}
