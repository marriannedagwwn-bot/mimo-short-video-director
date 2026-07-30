import { createHash } from "node:crypto";
import { canonicalize } from "./frame-dependency.js";
import {
  confirmedUsageConstraints,
  evaluateCastProposal,
  validateCastProposal
} from "./cast-proposal.js";
import { CastConfirmationStore } from "./cast-confirmation.js";
import { CastOperationError } from "./cast-errors.js";
import {
  CharacterRegistryStore,
  validateDeclarations
} from "./character-registry.js";

export class CastOrchestrationService {
  constructor({
    registryStore = new CharacterRegistryStore(),
    confirmationStore = null,
    environment = "development",
    audience = "full-story-v2",
    confirmationTtlMs,
    signingKey,
    now,
    idFactory,
    storyProvider = null
  } = {}) {
    this.environment = String(environment || "development");
    this.audience = String(audience || "full-story-v2");
    this.registryStore = registryStore;
    this.confirmationStore = confirmationStore || new CastConfirmationStore({
      environment: this.environment,
      audience: this.audience,
      ...(confirmationTtlMs === undefined ? {} : { ttlMs: confirmationTtlMs }),
      ...(signingKey === undefined ? {} : { signingKey }),
      ...(now === undefined ? {} : { now }),
      ...(idFactory === undefined ? {} : { idFactory })
    });
    // Reserved for Phase 3. Phase 2 never invokes the Story provider.
    this.storyProvider = storyProvider;
  }

  begin({
    castProposal,
    declarations = [],
    storyContext
  } = {}) {
    const validatedProposal = validateCastProposal(castProposal);
    const validatedDeclarations = validateDeclarations(declarations);
    const normalizedContext = validateStoryContext(storyContext);
    return this.beginValidated({
      castProposal: validatedProposal,
      declarations: validatedDeclarations,
      storyContext: normalizedContext
    });
  }

  confirm({
    proposalToken,
    decision,
    storyContext,
    environment = this.environment,
    audience = this.audience,
    modifiedCastProposal = null
  } = {}) {
    const normalizedDecision = String(decision || "");
    if (!["approve", "reject", "modify"].includes(normalizedDecision)) {
      throw new CastOperationError(
        "decision 只允许 approve、reject 或 modify",
        "CAST_CONFIRMATION_DECISION_INVALID"
      );
    }
    const normalizedContext = validateStoryContext(storyContext);
    const storyContextDigest = digest("story-context", normalizedContext);
    const validatedModification = normalizedDecision === "modify"
      ? validateCastProposal(modifiedCastProposal)
      : null;
    const consumed = this.confirmationStore.consume({
      proposalToken,
      storyContextDigest,
      environment,
      audience
    });

    if (normalizedDecision === "reject") {
      return outcome(200, {
        status: "rejected",
        operationId: consumed.operationId,
        storyContextDigest
      });
    }

    if (normalizedDecision === "modify") {
      return this.beginValidated({
        castProposal: validatedModification,
        declarations: consumed.operationData.declarations,
        storyContext: normalizedContext,
        modifiedFromOperationId: consumed.operationId
      });
    }

    const { castProposal, declarations, policyEvaluation } = consumed.operationData;
    return this.issueRegistry({
      castProposal,
      declarations,
      policyEvaluation,
      storyContextDigest,
      approvedOperationId: consumed.operationId
    });
  }

  beginValidated({
    castProposal,
    declarations,
    storyContext,
    modifiedFromOperationId = ""
  }) {
    const policyEvaluation = evaluateCastProposal(castProposal);
    const storyContextDigest = digest("story-context", storyContext);
    const proposalDigest = digest("cast-proposal", castProposal);
    const pending = policyEvaluation.roles.filter(
      (role) => role.decision === "confirmation-required"
    );

    if (pending.length) {
      const operation = this.confirmationStore.create({
        proposalDigest,
        storyContextDigest,
        operationData: {
          castProposal,
          declarations,
          policyEvaluation
        }
      });
      return outcome(202, {
        status: "awaiting-confirmation",
        operationId: operation.operationId,
        proposalToken: operation.proposalToken,
        proposalDigest,
        storyContextDigest,
        environment: this.environment,
        audience: this.audience,
        expiresAt: operation.expiresAt,
        castProposal: structuredClone(castProposal),
        policyDiagnostics: pending.map((item) => ({
          proposalRef: item.proposalRef,
          reasons: item.reasons
        })),
        ...(modifiedFromOperationId
          ? { modifiedFromOperationId }
          : {})
      });
    }

    return this.issueRegistry({
      castProposal,
      declarations,
      policyEvaluation,
      storyContextDigest,
      modifiedFromOperationId
    });
  }

  issueRegistry({
    castProposal,
    declarations,
    policyEvaluation,
    storyContextDigest,
    approvedOperationId = "",
    modifiedFromOperationId = ""
  }) {
    const decisions = new Map(
      policyEvaluation.roles.map((decision) => [decision.proposalRef, decision])
    );
    const approvedRoles = castProposal.roles.map((role) => {
      const decision = decisions.get(role.proposalRef);
      return {
        role,
        policy: decision?.decision === "automatic"
          ? decision.usageConstraints
          : confirmedUsageConstraints(role)
      };
    });
    const proposalDigest = digest("cast-proposal", castProposal);
    const registry = this.registryStore.reconcile({
      declarations,
      approvedRoles,
      proposalBindingNamespace: proposalDigest
    });
    return outcome(200, {
      status: "registry-ready",
      storyContextDigest,
      proposalDigest,
      registry,
      ...(approvedOperationId ? { approvedOperationId } : {}),
      ...(modifiedFromOperationId ? { modifiedFromOperationId } : {})
    });
  }
}

export function digest(namespace, value) {
  return `${namespace}:sha256:${createHash("sha256")
    .update(canonicalize(value))
    .digest("hex")}`;
}

function validateStoryContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CastOperationError(
      "storyContext 必须是对象",
      "STORY_CONTEXT_INVALID"
    );
  }
  return structuredClone(value);
}

function outcome(httpStatus, result) {
  return {
    httpStatus,
    result
  };
}
