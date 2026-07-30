import test from "node:test";
import assert from "node:assert/strict";
import {
  AttemptStore,
  DEFAULT_ATTEMPT_RAW_MAX_ENTRY_BYTES,
  DEFAULT_ATTEMPT_RAW_MAX_TOTAL_BYTES,
  DEFAULT_ATTEMPT_RAW_TTL_MS
} from "../src/attempt-store.js";

test("AttemptStore defaults match the Phase 0 retention limits", () => {
  const store = new AttemptStore();
  assert.deepEqual(store.stats(), {
    entries: 0,
    totalBytes: 0,
    ttlMs: 30 * 60 * 1_000,
    maxEntryBytes: 256 * 1_024,
    maxTotalBytes: 50 * 1_024 * 1_024,
    evictionPolicy: "expired-first-then-oldest-created",
    evictedExpired: 0,
    evictedCapacity: 0
  });
  assert.equal(DEFAULT_ATTEMPT_RAW_TTL_MS, 30 * 60 * 1_000);
  assert.equal(DEFAULT_ATTEMPT_RAW_MAX_ENTRY_BYTES, 256 * 1_024);
  assert.equal(DEFAULT_ATTEMPT_RAW_MAX_TOTAL_BYTES, 50 * 1_024 * 1_024);
});

test("AttemptStore stores raw output internally and returns only its reference in AttemptRecord", () => {
  let id = 0;
  const store = new AttemptStore({ idFactory: () => `id-${id += 1}` });
  const record = store.recordAttempt({
    rawOutput: "private completion",
    provider: "Qwen",
    model: "story-model",
    stage: "fullStory",
    reason: "primary",
    category: "json-syntax",
    code: "INVALID_JSON"
  });

  assert.equal(store.getRawOutput(record.rawOutputRef), "private completion");
  assert.equal(record.rawOutputBytes, Buffer.byteLength("private completion"));
  assert.equal(record.storedRawOutputBytes, record.rawOutputBytes);
  assert.equal(record.rawOutputTruncated, false);
  assert.doesNotMatch(JSON.stringify(record), /private completion/u);
});

test("AttemptStore expires entries at the configured TTL", () => {
  let currentTime = 1_000;
  const store = new AttemptStore({
    ttlMs: 100,
    now: () => currentTime,
    idFactory: () => "ttl-id"
  });
  const stored = store.storeRawOutput("expires");

  currentTime = 1_099;
  assert.equal(store.getRawOutput(stored.rawOutputRef), "expires");
  currentTime = 1_100;
  assert.equal(store.getRawOutput(stored.rawOutputRef), null);
  assert.equal(store.stats().evictedExpired, 1);
});

test("AttemptStore truncates one entry at a valid UTF-8 boundary", () => {
  const store = new AttemptStore({
    maxEntryBytes: 5,
    maxTotalBytes: 20,
    idFactory: () => "utf8-id"
  });
  const stored = store.storeRawOutput("😀ab");

  assert.equal(stored.rawOutputBytes, 6);
  assert.equal(stored.storedRawOutputBytes, 5);
  assert.equal(stored.rawOutputTruncated, true);
  assert.equal(store.getRawOutput(stored.rawOutputRef), "😀a");
});

test("AttemptStore evicts expired entries first and then oldest-created entries", () => {
  let id = 0;
  let currentTime = 0;
  const store = new AttemptStore({
    ttlMs: 100,
    maxEntryBytes: 8,
    maxTotalBytes: 12,
    now: () => currentTime,
    idFactory: () => `id-${id += 1}`
  });
  const first = store.storeRawOutput("12345678");
  currentTime = 10;
  const second = store.storeRawOutput("abcdefgh");

  assert.equal(store.getRawOutput(first.rawOutputRef), null);
  assert.equal(store.getRawOutput(second.rawOutputRef), "abcdefgh");
  assert.equal(store.stats().evictedCapacity, 1);

  currentTime = 110;
  const third = store.storeRawOutput("ijklmnop");
  assert.equal(store.getRawOutput(second.rawOutputRef), null);
  assert.equal(store.getRawOutput(third.rawOutputRef), "ijklmnop");
  assert.equal(store.stats().evictedExpired, 1);
});

test("AttemptStore rejects invalid limits", () => {
  assert.throws(() => new AttemptStore({ ttlMs: 0 }), /ttlMs 必须是正整数/u);
  assert.throws(() => new AttemptStore({ maxEntryBytes: -1 }), /maxEntryBytes 必须是正整数/u);
  assert.throws(() => new AttemptStore({ maxTotalBytes: NaN }), /maxTotalBytes 必须是正整数/u);
});
