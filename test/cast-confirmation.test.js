import test from "node:test";
import assert from "node:assert/strict";
import {
  CAST_CONFIRMATION_API_PATH,
  CAST_PROPOSAL_API_PATH,
  handleCastApiRequest
} from "../src/cast-api.js";
import { CastConfirmationStore } from "../src/cast-confirmation.js";
import {
  CastOperationError,
  CastPipelineDisabledError
} from "../src/cast-errors.js";
import { CastOrchestrationService } from "../src/cast-orchestration.js";
import { CharacterRegistryStore } from "../src/character-registry.js";
import { serializeServerError } from "../src/server-error.js";

function role(overrides = {}) {
  return {
    proposalRef: "cast-proposal-1",
    entityClass: "persistent-character",
    identityMode: "named",
    proposedDisplayName: "铃木奶奶",
    proposedAliases: [],
    scopePolicy: "story-wide",
    maxSceneCount: null,
    narrativeImportance: "supporting",
    relationshipMode: "persistent",
    dialoguePolicy: "multiple-lines",
    shotEmphasis: "close-up",
    continuityRequired: true,
    requiresReferenceAsset: true,
    sceneHint: "贯穿故事的关系角色",
    ...overrides
  };
}

function automaticRole(overrides = {}) {
  return role({
    entityClass: "single-scene-functional",
    identityMode: "generic-label",
    proposedDisplayName: "快递员",
    scopePolicy: "scene-limited",
    maxSceneCount: 1,
    narrativeImportance: "functional",
    relationshipMode: "transient",
    dialoguePolicy: "one-functional-line",
    shotEmphasis: "normal",
    continuityRequired: false,
    requiresReferenceAsset: false,
    sceneHint: "送包裹",
    ...overrides
  });
}

function request(candidate = role()) {
  return {
    castProposal: { roles: [candidate] },
    declarations: [{
      systemSlot: "protagonist",
      declarationId: "creator-profile-protagonist",
      displayName: "阿岚",
      aliases: [],
      entityClass: "persistent-character"
    }],
    storyContext: {
      creatorProfileId: "profile-1",
      variantId: "V1"
    }
  };
}

function harness({
  nowValue = 10_000,
  signingKey = "test-signing-key",
  confirmationStore = null
} = {}) {
  let currentTime = nowValue;
  let operationCounter = 0;
  let registryCounter = 0;
  let storyProviderCalls = 0;
  const now = () => currentTime;
  const store = confirmationStore || new CastConfirmationStore({
    environment: "test",
    audience: "full-story-v2-test",
    signingKey,
    now,
    idFactory: () => `operation-${++operationCounter}`
  });
  const service = new CastOrchestrationService({
    confirmationStore: store,
    environment: "test",
    audience: "full-story-v2-test",
    registryStore: new CharacterRegistryStore({
      registryId: "registry:test",
      idFactory: () => `registry-${++registryCounter}`
    }),
    storyProvider: {
      async generateJson() {
        storyProviderCalls += 1;
      }
    }
  });
  return {
    service,
    store,
    signingKey,
    now,
    setNow(value) {
      currentTime = value;
    },
    storyProviderCalls() {
      return storyProviderCalls;
    }
  };
}

function assertOperationCode(code) {
  return (error) => error instanceof CastOperationError
    && error.code === code
    && error.httpStatus === 409;
}

test("等待确认返回 202、默认 30 分钟、且 Story provider 调用为 0", () => {
  const fixture = harness();
  const outcome = fixture.service.begin(request());

  assert.equal(outcome.httpStatus, 202);
  assert.equal(outcome.result.status, "awaiting-confirmation");
  assert.equal(
    Date.parse(outcome.result.expiresAt) - fixture.now(),
    30 * 60 * 1_000
  );
  assert.equal(fixture.storyProviderCalls(), 0);
  assert.equal(outcome.result.environment, "test");
  assert.equal(outcome.result.audience, "full-story-v2-test");
  assert.match(outcome.result.proposalDigest, /^cast-proposal:sha256:/u);
  assert.match(outcome.result.storyContextDigest, /^story-context:sha256:/u);
});

test("approve 签发 Registry，token 单次使用且不调用 Story provider", () => {
  const fixture = harness();
  const pending = fixture.service.begin(request());
  const approved = fixture.service.confirm({
    proposalToken: pending.result.proposalToken,
    decision: "approve",
    storyContext: request().storyContext
  });

  assert.equal(approved.httpStatus, 200);
  assert.equal(approved.result.status, "registry-ready");
  assert.equal(approved.result.registry.frozen, true);
  assert.equal(
    approved.result.registry.entries.find((entry) => entry.proposalRef)?.approvalMode,
    "user-confirmed"
  );
  assert.equal(fixture.storyProviderCalls(), 0);
  assert.throws(
    () => fixture.service.confirm({
      proposalToken: pending.result.proposalToken,
      decision: "approve",
      storyContext: request().storyContext
    }),
    assertOperationCode("OPERATION_REPLAYED")
  );
});

test("reject 明确终止且不做静默匿名降级", () => {
  const fixture = harness();
  const pending = fixture.service.begin(request());
  const rejected = fixture.service.confirm({
    proposalToken: pending.result.proposalToken,
    decision: "reject",
    storyContext: request().storyContext
  });

  assert.deepEqual(rejected, {
    httpStatus: 200,
    result: {
      status: "rejected",
      operationId: pending.result.operationId,
      storyContextDigest: pending.result.storyContextDigest
    }
  });
  assert.equal(Object.hasOwn(rejected.result, "registry"), false);
  assert.equal(JSON.stringify(rejected).includes("anonymous"), false);
});

test("modify 后重新执行服务端 policy，而不是沿用原决定", () => {
  const fixture = harness();
  const pending = fixture.service.begin(request());
  const modified = fixture.service.confirm({
    proposalToken: pending.result.proposalToken,
    decision: "modify",
    storyContext: request().storyContext,
    modifiedCastProposal: { roles: [automaticRole()] }
  });

  assert.equal(modified.httpStatus, 200);
  assert.equal(modified.result.status, "registry-ready");
  assert.equal(modified.result.modifiedFromOperationId, pending.result.operationId);
  const entry = modified.result.registry.entries.find(
    (candidate) => candidate.proposalRef === "cast-proposal-1"
  );
  assert.equal(entry.approvalMode, "automatic");

  const second = fixture.service.begin(request());
  const stillPending = fixture.service.confirm({
    proposalToken: second.result.proposalToken,
    decision: "modify",
    storyContext: request().storyContext,
    modifiedCastProposal: {
      roles: [role({ proposedDisplayName: "需要确认的新名字" })]
    }
  });
  assert.equal(stillPending.httpStatus, 202);
  assert.notEqual(stillPending.result.proposalToken, second.result.proposalToken);
});

test("过期、重放、context mismatch、签名错误和进程重启均返回明确 409", () => {
  {
    const fixture = harness();
    const pending = fixture.service.begin(request());
    fixture.setNow(Date.parse(pending.result.expiresAt));
    assert.throws(
      () => fixture.service.confirm({
        proposalToken: pending.result.proposalToken,
        decision: "approve",
        storyContext: request().storyContext
      }),
      assertOperationCode("OPERATION_EXPIRED")
    );
  }
  {
    const fixture = harness();
    const pending = fixture.service.begin(request());
    assert.throws(
      () => fixture.service.confirm({
        proposalToken: pending.result.proposalToken,
        decision: "approve",
        storyContext: { ...request().storyContext, variantId: "V2" }
      }),
      assertOperationCode("OPERATION_CONTEXT_MISMATCH")
    );
  }
  {
    const fixture = harness();
    const pending = fixture.service.begin(request());
    const [payload, signature] = pending.result.proposalToken.split(".");
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.throws(
      () => fixture.service.confirm({
        proposalToken: `${payload}.${tamperedSignature}`,
        decision: "approve",
        storyContext: request().storyContext
      }),
      assertOperationCode("OPERATION_TOKEN_INVALID")
    );
  }
  {
    const original = harness();
    const pending = original.service.begin(request());
    const restarted = harness({ signingKey: original.signingKey });
    assert.throws(
      () => restarted.service.confirm({
        proposalToken: pending.result.proposalToken,
        decision: "approve",
        storyContext: request().storyContext
      }),
      assertOperationCode("OPERATION_EXPIRED")
    );
  }
});

test("token 绑定 environment 和 audience；不匹配时返回 409", () => {
  const fixture = harness();
  const pending = fixture.service.begin(request());
  assert.throws(
    () => fixture.service.confirm({
      proposalToken: pending.result.proposalToken,
      decision: "approve",
      storyContext: request().storyContext,
      environment: "production",
      audience: "another-audience"
    }),
    assertOperationCode("OPERATION_CONTEXT_MISMATCH")
  );
});

test("Cast API 默认关闭；启用时保留 202，错误序列化保留 error:string", () => {
  const fixture = harness();
  assert.throws(
    () => handleCastApiRequest({
      enabled: false,
      path: CAST_PROPOSAL_API_PATH,
      body: request(),
      service: fixture.service
    }),
    CastPipelineDisabledError
  );
  const disabled = serializeServerError(new CastPipelineDisabledError());
  assert.equal(disabled.status, 404);
  assert.equal(typeof disabled.body.error, "string");

  const pending = handleCastApiRequest({
    enabled: true,
    path: CAST_PROPOSAL_API_PATH,
    body: request(),
    service: fixture.service
  });
  assert.equal(pending.httpStatus, 202);

  const rejected = handleCastApiRequest({
    enabled: true,
    path: CAST_CONFIRMATION_API_PATH,
    body: {
      proposalToken: pending.result.proposalToken,
      decision: "reject",
      storyContext: request().storyContext
    },
    service: fixture.service
  });
  assert.equal(rejected.httpStatus, 200);

  const conflict = serializeServerError(new CastOperationError(
    "expired",
    "OPERATION_EXPIRED"
  ));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "OPERATION_EXPIRED");
  assert.equal(typeof conflict.body.error, "string");
});
