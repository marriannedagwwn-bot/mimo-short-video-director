import { randomUUID } from "node:crypto";
import { AttemptRecord } from "./model-errors.js";

export const DEFAULT_ATTEMPT_RAW_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_ATTEMPT_RAW_MAX_ENTRY_BYTES = 256 * 1_024;
export const DEFAULT_ATTEMPT_RAW_MAX_TOTAL_BYTES = 50 * 1_024 * 1_024;

export class AttemptStore {
  constructor({
    ttlMs = DEFAULT_ATTEMPT_RAW_TTL_MS,
    maxEntryBytes = DEFAULT_ATTEMPT_RAW_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_ATTEMPT_RAW_MAX_TOTAL_BYTES,
    now = () => Date.now(),
    idFactory = () => randomUUID()
  } = {}) {
    this.ttlMs = positiveInteger(ttlMs, "ttlMs");
    this.maxEntryBytes = positiveInteger(maxEntryBytes, "maxEntryBytes");
    this.maxTotalBytes = positiveInteger(maxTotalBytes, "maxTotalBytes");
    this.now = typeof now === "function" ? now : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.entries = new Map();
    this.totalBytes = 0;
    this.evictedExpired = 0;
    this.evictedCapacity = 0;
  }

  recordAttempt({
    rawOutput,
    attemptId = `attempt:${this.idFactory()}`,
    startedAt = "",
    finishedAt = "",
    ...metadata
  } = {}) {
    const stored = rawOutput === undefined || rawOutput === null || rawOutput === ""
      ? emptyStoredRaw()
      : this.storeRawOutput(rawOutput);
    return new AttemptRecord({
      ...metadata,
      attemptId,
      startedAt,
      finishedAt,
      ...stored
    });
  }

  storeRawOutput(rawOutput) {
    this.purgeExpired();
    const original = rawOutputBuffer(rawOutput);
    const stored = utf8SafePrefix(original, Math.min(this.maxEntryBytes, this.maxTotalBytes));
    const rawOutputRef = `raw:${this.idFactory()}`;
    const createdAtMs = this.now();
    const entry = {
      rawOutputRef,
      buffer: stored,
      bytes: stored.byteLength,
      originalBytes: original.byteLength,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs
    };
    this.entries.set(rawOutputRef, entry);
    this.totalBytes += entry.bytes;
    this.evictOldestUntilWithinLimit();
    return {
      rawOutputRef,
      rawOutputBytes: original.byteLength,
      storedRawOutputBytes: stored.byteLength,
      rawOutputTruncated: stored.byteLength < original.byteLength
    };
  }

  getRawOutput(rawOutputRef) {
    this.purgeExpired();
    const entry = this.entries.get(String(rawOutputRef || ""));
    return entry ? entry.buffer.toString("utf8") : null;
  }

  deleteRawOutput(rawOutputRef) {
    return this.deleteEntry(String(rawOutputRef || ""), "manual");
  }

  purgeExpired() {
    const currentTime = this.now();
    for (const [rawOutputRef, entry] of this.entries) {
      if (entry.expiresAtMs > currentTime) continue;
      this.deleteEntry(rawOutputRef, "expired");
    }
  }

  stats() {
    this.purgeExpired();
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      ttlMs: this.ttlMs,
      maxEntryBytes: this.maxEntryBytes,
      maxTotalBytes: this.maxTotalBytes,
      evictionPolicy: "expired-first-then-oldest-created",
      evictedExpired: this.evictedExpired,
      evictedCapacity: this.evictedCapacity
    };
  }

  evictOldestUntilWithinLimit() {
    while (this.totalBytes > this.maxTotalBytes && this.entries.size) {
      const oldestRef = this.entries.keys().next().value;
      this.deleteEntry(oldestRef, "capacity");
    }
  }

  deleteEntry(rawOutputRef, reason) {
    const entry = this.entries.get(rawOutputRef);
    if (!entry) return false;
    this.entries.delete(rawOutputRef);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    if (reason === "expired") this.evictedExpired += 1;
    if (reason === "capacity") this.evictedCapacity += 1;
    return true;
  }
}

function emptyStoredRaw() {
  return {
    rawOutputRef: "",
    rawOutputBytes: 0,
    storedRawOutputBytes: 0,
    rawOutputTruncated: false
  };
}

function rawOutputBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  try {
    return Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.from(String(value), "utf8");
  }
}

function utf8SafePrefix(buffer, maxBytes) {
  if (buffer.byteLength <= maxBytes) return buffer;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return Buffer.from(decoder.decode(buffer.subarray(0, end)), "utf8");
    } catch {
      // A UTF-8 code point is at most four bytes, so at most three retries are needed.
    }
  }
  return Buffer.alloc(0);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }
  return number;
}
