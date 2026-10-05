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
import { OutputContractError } from "../src/validation.js";
import { readSseCompletion } from "../src/sse-stream.js";
import { sseChunks } from "./helpers/sse-response.js";

test("Animation Plan SSE 日志不等待流结束才交给客户端，且保存正文与真实用量", async () => {
  const attempts = [];
  const finalized = [];
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: {
    enabled: true,
    async recordAttempt(value) { attempts.push(value); return { id: "attempt" }; },
    async finalizeAttempt(ref, value) { finalized.push(value); }
  } });
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), {
    headers: { "content-type": "text/event-stream", "x-request-id": "stream-id" }
  });
  const capturedFetch = capture.wrapFetch(async () => response);
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  await capture.run({ provider: "MiMo", variantId: "V1" }, async () => {
    const pending = capturedFetch("https://provider.example/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "mimo-v2.6-flash", stream: true, messages: [] })
    });
    let timer;
    const early = await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 100); })
    ]);
    clearTimeout(timer);
    // 无论断言结果如何，先释放流，防止旧实现留下挂起的 reader。
    controller.enqueue(new TextEncoder().encode(sseChunks({
      content: '{"ok":true}', reasoningContent: "推理不能混入正文", usage
    })));
    controller.close();
    const delivered = await pending;
    assert.equal(early, response, "fetch 必须在最后一个数据块到达之前返回");
    const completion = await readSseCompletion(delivered.body);
    assert.equal(completion.content, '{"ok":true}');
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].content, '{"ok":true}');
  assert.equal(attempts[0].providerRequestId, "stream-id");
  assert.deepEqual(attempts[0].usage, usage);
  assert.equal(finalized[0].validationStatus, "passed");
});

test("Animation Plan SSE 未结束不能记为日志成功，仍保留实际收到的 usage", async () => {
  const attempts = [];
  const finalized = [];
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: {
    enabled: true,
    async recordAttempt(value) { attempts.push(value); return { id: "attempt" }; },
    async finalizeAttempt(ref, value) { finalized.push(value); }
  } });
  const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }], usage })}\n\n`;
  const capturedFetch = capture.wrapFetch(async () => new Response(wire, {
    headers: { "content-type": "text/event-stream" }
  }));
  await assert.rejects(() => capture.run({ provider: "MiMo" }, async () => {
    const response = await capturedFetch("https://provider.example/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ stream: true, messages: [] })
    });
    await readSseCompletion(response.body);
  }), { name: "SseStreamIncompleteError" });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "failed");
  assert.deepEqual(attempts[0].usage, usage);
  assert.equal(finalized[0].code, "MODEL_STREAM_INCOMPLETE");
});

test("Animation Plan SSE 复读被叫停时日志记成 degeneration，不和断网混成 transport", async () => {
  // 2026-10-05 回归：副本读到复读叫停时曾被记成 MODEL_STREAM_ABORTED / transport。
  const attempts = [];
  const finalized = [];
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: {
    enabled: true,
    async recordAttempt(value) { attempts.push(value); return { id: "attempt" }; },
    async finalizeAttempt(ref, value) { finalized.push(value); }
  } });
  const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const wire = chunk('{"shots":[') + Array.from({ length: 600 }, () => chunk('":"",  ')).join("");
  const capturedFetch = capture.wrapFetch(async () => new Response(wire, {
    headers: { "content-type": "text/event-stream" }
  }));
  await assert.rejects(() => capture.run({ provider: "MiMo" }, async () => {
    const response = await capturedFetch("https://provider.example/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ stream: true, messages: [] })
    });
    await readSseCompletion(response.body);
  }), { name: "SseStreamDegenerateError" });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "failed");
  assert.equal(finalized[0].code, "MODEL_OUTPUT_DEGENERATE");
  assert.equal(finalized[0].category, "degeneration");
});

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
  const userPrompt = "任务：将完整 Full Story\nUnicode：小白子\n/no_think";

  await capture.run({ variantId: "V2" }, async () => {
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
    viewingIntent: "integrated_multimodal_description: First action only.",
    shotPlan: [
      { beats: [{ visibleAction: "First action only." }] },
      { beats: [{ visibleAction: "Second action only." }] }
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
    route: "/api/animation-plan",
    variantId: "V2",
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
        { role: "user", content: "任务：将完整 Full Story\nUSER_PROMPT_MUST_NOT_BE_LOGGED" }
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
  assert.equal(metadata.attempt.phase, "animation-model-call");
  assert.equal(metadata.attempt.sequence, 1);
  assert.equal(metadata.attempt.validationStatus, "passed");
  assert.equal(metadata.provider.name, "Qwen");
  assert.equal(metadata.provider.providerRequestId, "provider-request-id");
  assert.doesNotMatch(
    `${metadataText}\n${await fs.readFile(outputPath, "utf8")}`,
    /MUST_NOT_BE_LOGGED|SYSTEM_PROMPT_MUST_NOT_BE_LOGGED|USER_PROMPT_MUST_NOT_BE_LOGGED/u
  );
});

test("Animation Plan 失败 attempt 记录稳定诊断与 build identity 且 metadata 不落敏感负载", async (t) => {
  const modelOutputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animation-model-output-failed-"));
  t.after(() => fs.rm(modelOutputRoot, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({
    outputRoot: modelOutputRoot,
    scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN,
    gitCommit: "abcdef1234567890",
    buildId: "animation-test-build"
  });
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: writer });
  const capturedFetch = capture.wrapFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"shotPlan\":[]}" }, finish_reason: "stop" }]
  }), { status: 200 }));

  await assert.rejects(
    () => capture.run({ variantId: "V1" }, async () => {
      await capturedFetch("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "直接视频镜头批次" }]
        })
      });
      throw new OutputContractError("镜头校验失败", [{
        code: "DIRECT_SHOT_TEST_FAILURE",
        jsonPointer: "/shotPlan/0/videoPrompt",
        reason: "提示词与签发事实冲突",
        boundarySignature: "MUST_NOT_BE_LOGGED_SIGNATURE",
        referenceImageDataUrl: "data:image/png;base64,MUST_NOT_BE_LOGGED_DATA_URL"
      }]);
    }),
    /镜头校验失败/u
  );

  const files = await recursiveFiles(modelOutputRoot);
  const metadataPath = files.find((file) => file.endsWith("metadata.json"));
  const metadataText = await fs.readFile(metadataPath, "utf8");
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.gitCommit, "abcdef1234567890");
  assert.equal(metadata.buildId, "animation-test-build");
  assert.equal(metadata.attempt.validationStatus, "failed");
  assert.equal(metadata.attempt.errorName, "OutputContractError");
  assert.deepEqual(metadata.attempt.diagnostics, [{
    code: "DIRECT_SHOT_TEST_FAILURE",
    jsonPointer: "/shotPlan/0/videoPrompt",
    reason: "提示词与签发事实冲突"
  }]);
  assert.doesNotMatch(metadataText, /MUST_NOT_BE_LOGGED|data:image|base64|boundarySignature/u);
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

// 旧 3.0 的阶段标记（Foundation、批次、局部纠错、语义审计与修复、方言改写复审）已随 3.0 分镜删除（2026-10-11）。
// 4.0 自主分镜各步的提示词里没有这些标记：一律记为 animation-model-call，只有 JSON 重试单独标出。
test("Animation Plan 原始输出：4.0 各步统一标 animation-model-call，JSON 重试单独标出", async () => {
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
    "任务：将完整 Full Story 设计成分镜",
    "上一次模型输出不是完整合法 JSON，请重新输出",
    "你是分镜修稿编辑",
    "你是单镜视频提示词撰写者",
    // 旧 3.0 的标记即使出现也不再单独分类。
    "直接视频镜头批次"
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
    { phase: "animation-model-call", sequence: 1 },
    { phase: "provider-json-retry", sequence: 2 },
    { phase: "animation-model-call", sequence: 3 },
    { phase: "animation-model-call", sequence: 4 },
    { phase: "animation-model-call", sequence: 5 }
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
