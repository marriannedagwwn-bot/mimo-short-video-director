import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient, ModelResponseError, parseModelJson } from "../src/mimo-client.js";
import {
  ensureFullStoryMatchesProfile,
  ensureOutputContract,
  OutputContractError
} from "../src/validation.js";
import {
  characterizationContext,
  downstreamDefectCases,
  fs01NonLiveNameMentionFixture,
  fs03UnknownVisibleCharacterFixture,
  fs04CareRecipientDriftFixture,
  fs08DeeplyIncompleteFixture,
  fullStoryDefectCases,
  recoveryDefectCases,
  validFullStoryFixture
} from "./fixtures/full-story-defect-cases.js";

test("characterization fixture catalog pins FS, RC and DS audit IDs", () => {
  assert.deepEqual(fullStoryDefectCases.map(({ id }) => id), ["FS-01", "FS-03", "FS-04", "FS-08"]);
  assert.deepEqual(recoveryDefectCases.map(({ id }) => id), ["RC-01", "RC-02", "RC-03", "RC-04", "RC-05"]);
  assert.deepEqual(downstreamDefectCases.map(({ id }) => id), ["DS-05"]);
});

test("FS-01 characterization: non-live standard-name mention is currently rejected", () => {
  assert.throws(
    () => ensureOutputContract(fs01NonLiveNameMentionFixture(), "fullStory"),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.code === "FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING")
  );
});

test("FS-03 characterization: unknown visible temporary role currently passes", () => {
  assert.doesNotThrow(() => ensureOutputContract(fs03UnknownVisibleCharacterFixture(), "fullStory"));
});

test("FS-04 characterization: care-recipient drift remains candidate-self-consistent", () => {
  const story = fs04CareRecipientDriftFixture();
  assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(
    story,
    characterizationContext.creatorProfile,
    null,
    characterizationContext.variant,
    null
  ));
});

test("FS-08 characterization: Phase 1 strict schema rejects deep null and invalid beat entries", () => {
  assert.throws(
    () => ensureOutputContract(fs08DeeplyIncompleteFixture(), "fullStory"),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.path === "/title")
      && error.details.some((detail) => detail.path === "/beatSheet/0")
  );
});

test("RC-01 characterization: finish_reason=length is currently ignored", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: "{\"ok\":true}" }
      }]
    }), { status: 200 });
  };
  try {
    const client = new MimoClient(mimoConfig());
    assert.deepEqual(await client.generateJson({ prompt: "return json", jsonRetryAttempts: 0 }), { ok: true });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RC-02 and RC-03 characterization: current parser mutates/extracts content", () => {
  assert.deepEqual(parseModelJson("{\"text\":\"A<think>keep</think>B\"}"), { text: "AB" });
  assert.deepEqual(parseModelJson("prefix {\"ok\":true} suffix"), { ok: true });
});

test("RC-04 characterization: invalid provider envelope does not consume JSON retry", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("not-json", { status: 200 })
      : jsonResponse({ ok: true });
  };
  try {
    const client = new MimoClient(mimoConfig());
    await assert.rejects(
      () => client.generateJson({ prompt: "return json", jsonRetryAttempts: 1 }),
      (error) => error instanceof ModelResponseError
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RC-05 characterization: transient HTTP failure does not consume JSON retry", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : jsonResponse({ ok: true });
  };
  try {
    const client = new MimoClient(mimoConfig());
    await assert.rejects(
      () => client.generateJson({ prompt: "return json", jsonRetryAttempts: 1 }),
      (error) => error instanceof ModelResponseError && error.status === 503
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS-05 characterization: same variant id does not bind the full variant context", () => {
  const story = validFullStoryFixture();
  const changedVariant = {
    ...characterizationContext.variant,
    title: "完全不同的选题",
    newTask: "与原 Story 无关的新任务"
  };
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(
    story,
    characterizationContext.creatorProfile,
    null,
    changedVariant,
    null
  ));
});

function mimoConfig() {
  return {
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
    model: "test-model",
    maxCompletionTokens: 1_000,
    requestTimeoutMs: 1_000,
    jsonRetryAttempts: 0,
    mediaMode: "frames"
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(value) }
    }]
  }), { status: 200 });
}
