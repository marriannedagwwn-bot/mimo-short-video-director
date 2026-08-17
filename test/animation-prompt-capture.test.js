import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AnimationPromptCapture } from "../src/animation-prompt-capture.js";
import {
  FullModelOutputLogWriter,
  MODEL_OUTPUT_LOG_SCOPES
} from "../src/full-model-output-log.js";

test("animation prompt capture 保存 wire-effective prompt 且不记录请求头或媒体", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animation-prompt-capture-"));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const outboundBodies = [];
  const capture = new AnimationPromptCapture({ outputRoot });
  const capturedFetch = capture.wrapFetch(async (url, init) => {
    outboundBodies.push(JSON.parse(init.body));
    return { ok: true, url };
  });
  const systemPrompt = "系统提示\n逐字保留";
  const userPrompt = "直接视频镜头基础锁定\nUnicode：小白子\n/no_think";

  await capture.run({ variantId: "V2", animationPlanMode: "direct_shot" }, async () => {
    await capturedFetch("https://provider.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer api-key-must-not-be-written" },
      body: JSON.stringify({
        model: "model-under-test",
        max_completion_tokens: 8192,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,must-not-be-written" } },
              { type: "text", text: userPrompt }
            ]
          }
        ]
      })
    });
  });

  assert.equal(outboundBodies.length, 1);
  const [captureDirectory] = await fs.readdir(outputRoot);
  const directory = path.join(outputRoot, captureDirectory);
  const files = await fs.readdir(directory);
  const systemFile = files.find((file) => file.endsWith("-system.prompt.txt"));
  const userFile = files.find((file) => file.endsWith("-user.prompt.txt"));
  const requestFile = files.find((file) => file.endsWith("-request.json"));
  assert.equal(await fs.readFile(path.join(directory, systemFile), "utf8"), systemPrompt);
  assert.equal(await fs.readFile(path.join(directory, userFile), "utf8"), userPrompt);
  const request = JSON.parse(await fs.readFile(path.join(directory, requestFile), "utf8"));
  assert.equal(request.model, "model-under-test");
  assert.equal(request.omittedNonTextParts, 1);
  const capturedFilesText = await Promise.all(
    files.map((file) => fs.readFile(path.join(directory, file), "utf8"))
  );
  assert.doesNotMatch(capturedFilesText.join("\n"), /api-key-must-not-be-written|must-not-be-written/u);
  const complete = JSON.parse(await fs.readFile(path.join(directory, "session-complete.json"), "utf8"));
  assert.equal(complete.status, "fulfilled");
  assert.equal(complete.promptCount, 1);
});

test("animation prompt capture 在上下文外 no-op，并隔离并发 animation 请求", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animation-prompt-capture-isolation-"));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const capture = new AnimationPromptCapture({ outputRoot });
  const capturedFetch = capture.wrapFetch(async () => ({ ok: true }));
  const request = (prompt) => capturedFetch("https://provider.example/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "test-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: prompt }
      ]
    })
  });

  await request("outside-context");
  assert.deepEqual(await fs.readdir(outputRoot), []);

  await Promise.all([
    capture.run({ variantId: "V1" }, () => request("prompt-one")),
    capture.run({ variantId: "V2" }, () => request("prompt-two"))
  ]);

  const directories = await fs.readdir(outputRoot);
  assert.equal(directories.length, 2);
  const sessions = await Promise.all(directories.map(async (name) => {
    const directory = path.join(outputRoot, name);
    const files = await fs.readdir(directory);
    const start = JSON.parse(await fs.readFile(path.join(directory, "session-start.json"), "utf8"));
    const userFile = files.find((file) => file.endsWith("-user.prompt.txt"));
    return {
      variantId: start.variantId,
      prompt: await fs.readFile(path.join(directory, userFile), "utf8"),
      temporaryFiles: files.filter((file) => file.startsWith(".tmp-"))
    };
  }));
  assert.deepEqual(
    sessions.map(({ variantId, prompt }) => ({ variantId, prompt })).sort((left, right) => left.variantId.localeCompare(right.variantId)),
    [
      { variantId: "V1", prompt: "prompt-one" },
      { variantId: "V2", prompt: "prompt-two" }
    ]
  );
  assert.ok(sessions.every((session) => session.temporaryFiles.length === 0));
});

test("Animation Plan output-only 模式保存 exact completion 且不落 Prompt、HTTP raw 或鉴权信息", async (t) => {
  const modelOutputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animation-model-output-"));
  t.after(() => fs.rm(modelOutputRoot, { recursive: true, force: true }));
  const rawContent = JSON.stringify({
    shotPlan: [
      { videoPrompt: "integrated_multimodal_description: [Shot 1] First action only." },
      { videoPrompt: "integrated_multimodal_description: [Shot 1] Second action only." }
    ]
  }, null, 2);
  const writer = new FullModelOutputLogWriter({
    outputRoot: modelOutputRoot,
    scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN
  });
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: writer });
  let outboundBody = "";
  const capturedFetch = capture.wrapFetch(async (_url, init) => {
    outboundBody = String(init?.body || "");
    return new Response(JSON.stringify({
      id: "envelope-request-id",
      privateEnvelopeField: "MUST_NOT_BE_LOGGED",
      choices: [{
        message: { content: rawContent },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, apiKey: "MUST_NOT_BE_LOGGED" }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-request-id"
      }
    });
  });

  const response = await capture.run({
    route: "/api/animation-plan/video-prompts/rewrite",
    variantId: "V2",
    animationPlanMode: "direct_shot",
    provider: "Qwen",
    traceContext: {
      verified: true,
      projectId: "project-a",
      runId: "run-a",
      artifactId: "animationPlan:V2",
      productionRequestId: "production-request-a",
      variantId: "V2"
    }
  }, () => capturedFetch("https://provider.example/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer MUST_NOT_BE_LOGGED" },
    body: JSON.stringify({
      model: "qwen3.7-max",
      messages: [
        { role: "system", content: "SYSTEM_PROMPT_MUST_NOT_BE_LOGGED" },
        { role: "user", content: "直接视频镜头批次\nUSER_PROMPT_MUST_NOT_BE_LOGGED" }
      ]
    })
  }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(outboundBody, /project-a|run-a|production-request-a/u);

  const files = await recursiveFiles(modelOutputRoot);
  const outputPath = files.find((file) => file.endsWith("model-output.txt"));
  const metadataPath = files.find((file) => file.endsWith("metadata.json"));
  assert.equal(await fs.readFile(outputPath, "utf8"), rawContent);
  const metadataText = await fs.readFile(metadataPath, "utf8");
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.scope, "animationPlan");
  assert.equal(metadata.production.verified, true);
  assert.equal(metadata.production.artifactId, "animationPlan:V2");
  assert.equal(metadata.production.productionRequestId, "production-request-a");
  assert.equal(metadata.attempt.phase, "animation-shot-batch");
  assert.equal(metadata.attempt.sequence, 1);
  assert.equal(metadata.provider.name, "Qwen");
  assert.equal(metadata.provider.providerRequestId, "provider-request-id");
  assert.doesNotMatch(
    `${metadataText}\n${await fs.readFile(outputPath, "utf8")}`,
    /MUST_NOT_BE_LOGGED|SYSTEM_PROMPT_MUST_NOT_BE_LOGGED|USER_PROMPT_MUST_NOT_BE_LOGGED/u
  );
});

test("Animation Plan 输出日志写入失败不改变模型 Response", async () => {
  const warnings = [];
  const capture = new AnimationPromptCapture({
    modelOutputLogWriter: {
      enabled: true,
      async recordAttempt() {
        throw new Error("PRIVATE_WRITE_FAILURE");
      }
    },
    onWarning: (message) => warnings.push(message)
  });
  const capturedFetch = capture.wrapFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }]
  }), { status: 200 }));
  const response = await capture.run({ variantId: "V2" }, () => capturedFetch(
    "https://provider.example/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "直接视频镜头批次" }]
      })
    }
  ));
  assert.equal(await response.text(), JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }]
  }));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /PRIVATE_WRITE_FAILURE/u);
});

test("Animation Plan 原始输出按 Foundation、batch、H3 repair、首审与复审分别标记", async () => {
  const observed = [];
  const capture = new AnimationPromptCapture({
    modelOutputLogWriter: {
      enabled: true,
      async recordAttempt(payload) {
        observed.push({ phase: payload.phase, sequence: payload.sequence });
      }
    }
  });
  const capturedFetch = capture.wrapFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }]
  }), { status: 200 }));
  const prompts = [
    "直接视频镜头基础锁定",
    "ARTIFACT_PARTIAL_REPAIR_V1\ncharacterReferencePrompts",
    "直接视频镜头批次",
    "ARTIFACT_PARTIAL_REPAIR_V1\nvideoPrompt",
    "ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2",
    "ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1",
    "ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2",
    "ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2",
    "ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1",
    "ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2"
  ];
  await capture.run({ variantId: "V2" }, async () => {
    for (const prompt of prompts) {
      await capturedFetch("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: prompt }]
        })
      });
    }
  });
  assert.deepEqual(observed, [
    { phase: "animation-foundation", sequence: 1 },
    { phase: "animation-foundation-partial-repair", sequence: 2 },
    { phase: "animation-shot-batch", sequence: 3 },
    { phase: "animation-shot-prompt-partial-repair", sequence: 4 },
    { phase: "animation-video-prompt-initial-semantic-audit", sequence: 5 },
    { phase: "animation-video-prompt-semantic-repair", sequence: 6 },
    { phase: "animation-video-prompt-initial-semantic-re-audit", sequence: 7 },
    { phase: "animation-video-prompt-rewrite-semantic-audit", sequence: 8 },
    { phase: "animation-video-prompt-semantic-repair", sequence: 9 },
    { phase: "animation-video-prompt-rewrite-semantic-re-audit", sequence: 10 }
  ]);
});

async function recursiveFiles(root) {
  const found = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else found.push(target);
    }
  }
  await visit(root);
  return found;
}
