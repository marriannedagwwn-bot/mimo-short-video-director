import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scopeBrowserWorkspaceDebugWriter, scopeBrowserWorkspacePromptCapture } from "../src/browser-workspace-debug.js";
import { FullModelOutputLogWriter, MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { PartialRepairDebugWriter } from "../src/partial-repair-debug.js";
import { AnimationPromptCapture } from "../src/animation-prompt-capture.js";
import { currentDurableTaskContext, runWithDurableTaskContext } from "../src/durable-task-context.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-workspace-debug-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contexts = ["run-a", "run-b"].map((id) => ({ id, root: path.join(root, id), closed: false }));
  const resolve = (kind) => async (fallback) => {
    const context = currentDurableTaskContext();
    if (!context) return fallback;
    return context.closed ? null : path.join(context.root, "debug", kind);
  };
  return { root, contexts, resolve };
}

async function filesUnder(root) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else files.push(target);
  }
  return files;
}

function repairPlan(marker) {
  return {
    schemaVersion: "artifact_partial_repair/1.0", artifactType: "fullStory", adapterId: "fullStory/subtree",
    baseDigest: `base-${marker}`, authorityDigest: "authority", authority: {},
    targets: [{ repairId: "R1", path: "/title", currentValue: marker, repairInstruction: "repair fixture" }]
  };
}

test("concurrent workspace full-output records and finalize stay in each dynamic Run root, with no global output", async (t) => {
  const f = await fixture(t);
  const globalRoot = path.join(f.root, "global-full");
  const writer = scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({ outputRoot: globalRoot }), f.resolve("full"));
  const records = await Promise.all(f.contexts.map((context) => runWithDurableTaskContext(context, async () => {
    const record = await writer.recordAttempt({ operationId: `operation-${context.id}`, content: `output-${context.id}` });
    await writer.finalizeAttempt(record, { validationStatus: "passed" });
    return { context, record };
  })));
  assert.deepEqual(await filesUnder(globalRoot), []);
  for (const { context, record } of records) {
    assert.ok(record.metadataPath.startsWith(`${context.root}${path.sep}`));
    assert.equal(await fs.readFile(record.outputPath, "utf8"), `output-${context.id}`);
    const metadata = JSON.parse(await fs.readFile(record.metadataPath, "utf8"));
    assert.equal(metadata.attempt.validationStatus, "passed");
    assert.equal(metadata.attempt.status, "succeeded");
  }
  // An unrelated, non-workspace operation retains the configured logger path.
  const legacy = await writer.recordAttempt({ content: "legacy output" });
  assert.ok(legacy.outputPath.startsWith(`${globalRoot}${path.sep}`));
});

test("partial-repair session tokens remain valid across separately scoped begin, response and result writer instances", async (t) => {
  const f = await fixture(t);
  const globalRoot = path.join(f.root, "global-partial");
  const writer = scopeBrowserWorkspaceDebugWriter(new PartialRepairDebugWriter({ outputRoot: globalRoot }), f.resolve("partial"));
  await Promise.all(f.contexts.map((context) => runWithDurableTaskContext(context, async () => {
    const session = await writer.begin({ stage: "fullStory", repairPlan: repairPlan(context.id), repairPrompt: `prompt-${context.id}` });
    await writer.recordResponse(session, { schemaVersion: "artifact_partial_repair/1.0", baseDigest: `base-${context.id}`, repairs: [{ repairId: "R1", replacement: `replacement-${context.id}` }] });
    await writer.recordResult(session, { status: "repaired" });
  })));
  assert.deepEqual(await filesUnder(globalRoot), []);
  for (const context of f.contexts) {
    const files = await filesUnder(context.root);
    assert.equal(files.length, 4);
    const prompt = files.find((file) => file.endsWith("02-repair-prompt.txt"));
    assert.equal(await fs.readFile(prompt, "utf8"), `prompt-${context.id}`);
    const result = JSON.parse(await fs.readFile(files.find((file) => file.endsWith("04-result.json")), "utf8"));
    assert.equal(result.status, "repaired");
    assert.equal(result.acceptedRepairs[0].replacement, `replacement-${context.id}`);
  }
});

test("resolving a closed workspace to null skips full output, partial continuations and capture without global fallback", async (t) => {
  const f = await fixture(t);
  const context = f.contexts[0];
  const globalRoot = path.join(f.root, "global");
  const full = scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({ outputRoot: globalRoot }), f.resolve("full"));
  const partial = scopeBrowserWorkspaceDebugWriter(new PartialRepairDebugWriter({ outputRoot: globalRoot }), f.resolve("partial"));
  const capture = scopeBrowserWorkspacePromptCapture(new AnimationPromptCapture({ outputRoot: globalRoot }), f.resolve("capture"));
  await runWithDurableTaskContext(context, async () => {
    const record = await full.recordAttempt({ content: "before close" });
    const session = await partial.begin({ stage: "fullStory", repairPlan: repairPlan("close"), repairPrompt: "before close" });
    context.closed = true;
    await fs.rm(context.root, { recursive: true });
    assert.equal(await full.recordAttempt({ content: "must not persist" }), null);
    assert.equal(await full.finalizeAttempt(record, { validationStatus: "passed" }), null);
    assert.equal(await partial.recordResponse(session, { repairs: [] }), null);
    assert.equal(await partial.recordResult(session, { status: "repaired" }), null);
    assert.equal(await partial.begin({ repairPlan: repairPlan("late"), repairPrompt: "must not persist" }), null);
    let invoked = 0;
    const wrappedFetch = capture.wrapFetch(async () => new Response("{}"));
    const result = await capture.run({}, async () => {
      invoked += 1;
      await wrappedFetch("https://fixture.invalid/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "must not persist" }] }) });
      return "callback completed";
    });
    assert.equal(result, "callback completed");
    assert.equal(invoked, 1);
  });
  assert.deepEqual(await filesUnder(context.root), []);
  assert.deepEqual(await filesUnder(globalRoot), []);
});

test("one wrapped fetch shares capture ALS across concurrent scoped runs without mixing prompts or exact output logs", async (t) => {
  const f = await fixture(t);
  const globalCaptures = path.join(f.root, "global-capture");
  const globalOutputs = path.join(f.root, "global-output");
  const outputWriter = scopeBrowserWorkspaceDebugWriter(new FullModelOutputLogWriter({ outputRoot: globalOutputs, scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN }), f.resolve("output"));
  const capture = scopeBrowserWorkspacePromptCapture(new AnimationPromptCapture({ outputRoot: globalCaptures, modelOutputLogWriter: outputWriter }), f.resolve("capture"));
  const wrappedFetch = capture.wrapFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const marker = body.messages.find((message) => message.role === "user").content;
    await new Promise((resolve) => setTimeout(resolve, marker.includes("run-a") ? 10 : 1));
    return new Response(JSON.stringify({ choices: [{ message: { content: `completion-${marker}` }, finish_reason: "stop" }] }), { status: 200 });
  });
  await Promise.all(f.contexts.map((context) => runWithDurableTaskContext(context, () => capture.run({ variantId: context.id, provider: "fixture" }, async () => {
    assert.ok(capture.storage.getStore()?.directory.startsWith(`${context.root}${path.sep}`));
    const result = await wrappedFetch("https://fixture.invalid/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "fixture", messages: [{ role: "system", content: "fixture system" }, { role: "user", content: `prompt-${context.id}` }] })
    });
    assert.equal(result.status, 200);
  }))));
  assert.deepEqual(await filesUnder(globalCaptures), []);
  assert.deepEqual(await filesUnder(globalOutputs), []);
  for (const context of f.contexts) {
    const files = await filesUnder(context.root);
    const userPrompt = files.find((file) => file.endsWith("-user.prompt.txt"));
    const output = files.find((file) => file.endsWith("model-output.txt"));
    const completion = files.find((file) => file.endsWith("session-complete.json"));
    const metadata = files.find((file) => file.endsWith("metadata.json"));
    assert.equal(await fs.readFile(userPrompt, "utf8"), `prompt-${context.id}`);
    assert.equal(await fs.readFile(output, "utf8"), `completion-prompt-${context.id}`);
    assert.equal(JSON.parse(await fs.readFile(completion, "utf8")).promptCount, 1);
    assert.equal(JSON.parse(await fs.readFile(metadata, "utf8")).attempt.validationStatus, "passed");
  }
  assert.equal(capture.storage.getStore(), undefined);
});
