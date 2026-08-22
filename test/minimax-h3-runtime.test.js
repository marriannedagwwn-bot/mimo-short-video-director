import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";

// MiniMax H3 仍是镜头视频供应商，只是不再有专属提示词方言。
// 这里覆盖的是供应商运行时限额：时长、Prompt 长度、混合参考数量。

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
