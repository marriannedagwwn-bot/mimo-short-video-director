import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AnimationPromptCapture } from "../src/animation-prompt-capture.js";

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
