import test from "node:test";
import assert from "node:assert/strict";
import {
  AttemptStore,
  DEFAULT_ATTEMPT_RAW_MAX_ENTRY_BYTES,
  DEFAULT_ATTEMPT_RAW_MAX_TOTAL_BYTES,
  DEFAULT_ATTEMPT_RAW_TTL_MS
} from "../src/attempt-store.js";

// 只给测试用的读取口（getRawOutput / deleteRawOutput / stats 与两个淘汰计数器）已于 2026-10-11 删除，
// 生产代码从没读过它们。下面的用例改为直接看存储里留下了什么（entries / totalBytes），
// 留存期限、单条截断与容量淘汰的断言本身不变。
function storedText(store, rawOutputRef) {
  store.purgeExpired();
  const entry = store.entries.get(rawOutputRef);
  return entry ? entry.buffer.toString("utf8") : null;
}

test("AttemptStore defaults match the Phase 0 retention limits", () => {
  const store = new AttemptStore();
  assert.equal(store.entries.size, 0);
  assert.equal(store.totalBytes, 0);
  assert.equal(store.ttlMs, 30 * 60 * 1_000);
  assert.equal(store.maxEntryBytes, 256 * 1_024);
  assert.equal(store.maxTotalBytes, 50 * 1_024 * 1_024);
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

  assert.equal(storedText(store, record.rawOutputRef), "private completion");
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
  assert.equal(storedText(store, stored.rawOutputRef), "expires");
  currentTime = 1_100;
  assert.equal(storedText(store, stored.rawOutputRef), null);
  assert.equal(store.entries.size, 0);
  assert.equal(store.totalBytes, 0);
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
  assert.equal(storedText(store, stored.rawOutputRef), "😀a");
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

  // 容量不够时淘汰最早写入的那条。
  assert.equal(storedText(store, first.rawOutputRef), null);
  assert.equal(storedText(store, second.rawOutputRef), "abcdefgh");
  assert.deepEqual([...store.entries.keys()], [second.rawOutputRef]);
  assert.equal(store.totalBytes, 8);

  // 写入新条目之前先清掉已过期的：second 是因过期被清，不是被 third 挤掉。
  currentTime = 110;
  const third = store.storeRawOutput("ijkl");
  assert.equal(storedText(store, second.rawOutputRef), null);
  assert.equal(storedText(store, third.rawOutputRef), "ijkl");
  assert.equal(store.totalBytes, 4);
});

test("AttemptStore rejects invalid limits", () => {
  assert.throws(() => new AttemptStore({ ttlMs: 0 }), /ttlMs 必须是正整数/u);
  assert.throws(() => new AttemptStore({ maxEntryBytes: -1 }), /maxEntryBytes 必须是正整数/u);
  assert.throws(() => new AttemptStore({ maxTotalBytes: NaN }), /maxTotalBytes 必须是正整数/u);
});
