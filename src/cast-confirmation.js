import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { canonicalize } from "./frame-dependency.js";
import { CastOperationError } from "./cast-errors.js";

export const DEFAULT_CAST_CONFIRMATION_TTL_MS = 30 * 60 * 1_000;

export class CastConfirmationStore {
  constructor({
    ttlMs = DEFAULT_CAST_CONFIRMATION_TTL_MS,
    environment = "development",
    audience = "full-story-v2",
    signingKey = randomBytes(32),
    now = () => Date.now(),
    idFactory = () => randomUUID()
  } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs 必须是正整数");
    }
    this.ttlMs = ttlMs;
    this.environment = requiredString(environment, "environment");
    this.audience = requiredString(audience, "audience");
    this.signingKey = normalizeSigningKey(signingKey);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.operations = new Map();
  }

  create({
    proposalDigest,
    storyContextDigest,
    operationData
  } = {}) {
    const operationId = `cast-operation:${this.idFactory()}`;
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.ttlMs;
    const payload = {
      version: 1,
      operationId,
      proposalDigest: requiredString(proposalDigest, "proposalDigest"),
      storyContextDigest: requiredString(storyContextDigest, "storyContextDigest"),
      environment: this.environment,
      audience: this.audience,
      expiresAtMs,
      nonce: String(this.idFactory())
    };
    const proposalToken = signToken(payload, this.signingKey);
    this.operations.set(operationId, {
      ...payload,
      consumed: false,
      operationData: structuredClone(operationData)
    });
    return {
      operationId,
      proposalToken,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  consume({
    proposalToken,
    storyContextDigest,
    environment = this.environment,
    audience = this.audience
  } = {}) {
    const token = parseToken(proposalToken);
    const operation = this.operations.get(String(token.payload?.operationId || ""));
    if (!operation) {
      throw operationError(
        "Cast confirmation operation 已过期或进程状态已丢失",
        "OPERATION_EXPIRED"
      );
    }
    if (this.now() >= operation.expiresAtMs) {
      this.operations.delete(operation.operationId);
      throw operationError(
        "Cast confirmation operation 已过期",
        "OPERATION_EXPIRED"
      );
    }
    if (!verifyToken(token, this.signingKey)) {
      throw operationError(
        "proposalToken 签名无效",
        "OPERATION_TOKEN_INVALID"
      );
    }
    if (!sameBoundPayload(token.payload, operation)) {
      throw operationError(
        "proposalToken 绑定内容无效",
        "OPERATION_TOKEN_INVALID"
      );
    }
    if (operation.consumed) {
      throw operationError(
        "proposalToken 已被使用",
        "OPERATION_REPLAYED"
      );
    }
    if (requiredString(storyContextDigest, "storyContextDigest") !== operation.storyContextDigest) {
      throw operationError(
        "Story context 已变化，必须重新发起 Cast Proposal",
        "OPERATION_CONTEXT_MISMATCH"
      );
    }
    if (String(environment || "") !== operation.environment
      || String(audience || "") !== operation.audience) {
      throw operationError(
        "proposalToken 的 environment/audience 不匹配",
        "OPERATION_CONTEXT_MISMATCH"
      );
    }
    operation.consumed = true;
    return {
      operationId: operation.operationId,
      proposalDigest: operation.proposalDigest,
      storyContextDigest: operation.storyContextDigest,
      operationData: structuredClone(operation.operationData)
    };
  }
}

function signToken(payload, signingKey) {
  const payloadPart = Buffer.from(canonicalize(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(payloadPart)
    .digest("base64url");
  return `${payloadPart}.${signature}`;
}

function parseToken(value) {
  const token = String(value || "");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw operationError("proposalToken 格式无效", "OPERATION_TOKEN_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw operationError("proposalToken payload 无效", "OPERATION_TOKEN_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw operationError("proposalToken payload 无效", "OPERATION_TOKEN_INVALID");
  }
  return {
    payloadPart: parts[0],
    signature: parts[1],
    payload
  };
}

function verifyToken(token, signingKey) {
  const expected = createHmac("sha256", signingKey)
    .update(token.payloadPart)
    .digest();
  let actual;
  try {
    actual = Buffer.from(token.signature, "base64url");
  } catch {
    return false;
  }
  return expected.byteLength === actual.byteLength
    && timingSafeEqual(expected, actual);
}

function sameBoundPayload(payload, operation) {
  return payload.version === operation.version
    && payload.operationId === operation.operationId
    && payload.proposalDigest === operation.proposalDigest
    && payload.storyContextDigest === operation.storyContextDigest
    && payload.environment === operation.environment
    && payload.audience === operation.audience
    && payload.expiresAtMs === operation.expiresAtMs
    && payload.nonce === operation.nonce;
}

function normalizeSigningKey(value) {
  if (Buffer.isBuffer(value)) {
    if (!value.byteLength) throw new TypeError("signingKey 不能为空");
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    if (!value.byteLength) throw new TypeError("signingKey 不能为空");
    return Buffer.from(value);
  }
  const normalized = String(value || "");
  if (!normalized) throw new TypeError("signingKey 不能为空");
  return Buffer.from(normalized, "utf8");
}

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} 不能为空`);
  return normalized;
}

function operationError(message, code) {
  return new CastOperationError(message, code);
}
