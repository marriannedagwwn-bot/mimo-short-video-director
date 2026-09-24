import { PRODUCTION_REQUEST_HEADER_NAMES } from "../public/production-lineage-client.js";
import {
  ProductionStateError,
  contentDigest,
  normalizeArtifactId,
  normalizeDependency,
  safeIdentifier
} from "./production-lineage.js";

const CANDIDATE_ARTIFACT_TYPE = "selectedVariant";
const FULL_STORY_ARTIFACT_TYPE = "fullStory";

/**
 * Freeze one Full Story request to the exact server-side selected Candidate.
 *
 * The request headers identify the running Full Story operation. The request
 * body contributes only the exact Variant lineage reference and a copy of the
 * Candidate; neither is trusted until it matches the current persisted
 * `variant:<id>` Artifact. The returned input replaces that copy with the
 * persisted content and removes the sidecar binding before WorkflowService sees
 * it, so the binding can never enter the prompt or Legacy Full Story wire shape.
 */
export async function resolveFullStoryCandidateBinding({
  headers = {},
  body = {},
  loadRun,
  validateCandidate
} = {}) {
  assertResolverDependencies({ loadRun, validateCandidate });
  if (!isRecord(body)) {
    throw bindingError("Full Story 请求必须是对象", "FULL_STORY_CANDIDATE_BINDING_REQUIRED");
  }
  if (!isRecord(body.variant)) {
    throw bindingError("Full Story 请求缺少选中的 Story Candidate", "FULL_STORY_CANDIDATE_BINDING_REQUIRED");
  }
  if (!isRecord(body.candidateBinding)) {
    throw bindingError("Full Story 请求缺少 Candidate revision/digest 绑定", "FULL_STORY_CANDIDATE_BINDING_REQUIRED");
  }

  const variantId = safeBindingIdentifier(body.variant.id, "variant.id");
  const requestContext = strictProductionRequestContext(headers);
  const candidateBinding = strictCandidateDependency(body.candidateBinding);
  const targetArtifactId = normalizeArtifactId(`${FULL_STORY_ARTIFACT_TYPE}:${variantId}`);
  const candidateArtifactId = normalizeArtifactId(`variant:${variantId}`);

  if (requestContext.artifactId !== targetArtifactId) {
    throw bindingError(
      `Full Story 请求目标必须是 ${targetArtifactId}`,
      "FULL_STORY_REQUEST_TARGET_MISMATCH",
      [{ artifactId: requestContext.artifactId, expectedArtifactId: targetArtifactId }]
    );
  }
  if (candidateBinding.artifactId !== candidateArtifactId) {
    throw bindingError(
      `Candidate binding 必须引用 ${candidateArtifactId}`,
      "FULL_STORY_CANDIDATE_BINDING_MISMATCH",
      [{ artifactId: candidateBinding.artifactId, expectedArtifactId: candidateArtifactId }]
    );
  }

  const frozen = {
    ...requestContext,
    targetArtifactId,
    variantId,
    candidateBinding,
    requestCandidateDigest: contentDigest(body.variant)
  };
  const authoritativeCandidate = await assertBindingSnapshotCurrent(frozen, {
    loadRun,
    validateCandidate
  });
  const { candidateBinding: _candidateBinding, ...workflowBody } = body;
  return {
    context: Object.freeze(frozen),
    input: {
      ...workflowBody,
      variant: authoritativeCandidate
    }
  };
}

/**
 * Recheck the frozen request immediately before returning its model result.
 * This closes the interval between the first check and the provider calls. The
 * browser's exact dependency commit remains the final independent guard.
 */
export async function assertFullStoryCandidateBindingCurrent(
  resolved,
  { loadRun, validateCandidate } = {}
) {
  assertResolverDependencies({ loadRun, validateCandidate });
  const context = resolved?.context;
  if (!isRecord(context)) {
    throw bindingError("Full Story Candidate binding context 无效", "FULL_STORY_CANDIDATE_BINDING_INVALID");
  }
  return assertBindingSnapshotCurrent(context, { loadRun, validateCandidate });
}

async function assertBindingSnapshotCurrent(context, { loadRun, validateCandidate }) {
  const run = await loadRun({
    projectId: context.projectId,
    runId: context.runId,
    includeContent: true
  });
  if (String(run?.projectId || "") !== context.projectId || String(run?.runId || "") !== context.runId) {
    throw bindingError("Production Run 与 Full Story 请求不一致", "FULL_STORY_REQUEST_LINEAGE_MISMATCH");
  }

  assertRunningTarget(run, context);
  const entry = run?.latestArtifacts?.[context.candidateBinding.artifactId];
  const lineage = entry?.lineage;
  if (
    !lineage
    || lineage.artifactId !== context.candidateBinding.artifactId
    || lineage.artifactType !== CANDIDATE_ARTIFACT_TYPE
    || lineage.status !== "current"
    || lineage.revision !== context.candidateBinding.revision
    || lineage.contentDigest !== context.candidateBinding.contentDigest
  ) {
    throw bindingError(
      "选中的 Story Candidate 已更新，旧 Full Story 请求不能继续使用",
      "FULL_STORY_CANDIDATE_STALE",
      [{
        artifactId: context.candidateBinding.artifactId,
        expectedRevision: context.candidateBinding.revision,
        actualRevision: lineage?.revision || null
      }]
    );
  }
  if (!isRecord(entry.content)) {
    throw bindingError("当前 Story Candidate Artifact 缺少内容", "FULL_STORY_CANDIDATE_CONTENT_INVALID");
  }

  const authoritativeDigest = contentDigest(entry.content);
  if (authoritativeDigest !== lineage.contentDigest) {
    throw bindingError(
      "当前 Story Candidate 内容与服务端 Artifact digest 不一致",
      "FULL_STORY_CANDIDATE_ARTIFACT_DIGEST_MISMATCH"
    );
  }
  if (context.requestCandidateDigest !== lineage.contentDigest) {
    throw bindingError(
      "Full Story 请求中的 Candidate 内容与已绑定 revision 不一致",
      "FULL_STORY_CANDIDATE_CONTENT_MISMATCH",
      [{ artifactId: lineage.artifactId, expectedRevision: lineage.revision, actualRevision: lineage.revision }]
    );
  }

  const candidate = structuredClone(entry.content);
  try {
    const validated = await validateCandidate(candidate);
    if (
      contentDigest(candidate) !== lineage.contentDigest
      || (validated !== undefined && contentDigest(validated) !== lineage.contentDigest)
    ) {
      throw bindingError(
        "Story Candidate validator 不得改写已签发内容",
        "FULL_STORY_CANDIDATE_VALIDATOR_MUTATION"
      );
    }
  } catch (error) {
    if (error instanceof ProductionStateError) throw error;
    throw bindingError(
      `当前 Story Candidate 未通过严格契约：${String(error?.message || "校验失败")}`,
      "FULL_STORY_CANDIDATE_CONTRACT_INVALID",
      Array.isArray(error?.details)
        ? error.details
        : (Array.isArray(error?.diagnostics) ? error.diagnostics : [])
    );
  }
  return candidate;
}

function assertRunningTarget(run, context) {
  const stage = run?.stages?.[context.targetArtifactId];
  if (
    !stage
    || stage.status !== "running"
    || stage.requestId !== context.requestId
  ) {
    throw bindingError(
      "Full Story Production stage 已不再对应当前请求",
      "FULL_STORY_REQUEST_STALE",
      [{ artifactId: context.targetArtifactId }]
    );
  }

  const currentTargetRevision = run?.latestArtifacts?.[context.targetArtifactId]?.lineage?.revision || null;
  if (currentTargetRevision !== context.expectedCurrentRevision) {
    throw bindingError(
      "Full Story target revision 已更新，拒绝旧请求继续返回",
      "FULL_STORY_REQUEST_REVISION_CONFLICT",
      [{
        artifactId: context.targetArtifactId,
        expectedRevision: context.expectedCurrentRevision,
        actualRevision: currentTargetRevision
      }]
    );
  }
}

function strictProductionRequestContext(headers) {
  const projectId = requiredHeader(headers, PRODUCTION_REQUEST_HEADER_NAMES.projectId);
  const runId = requiredHeader(headers, PRODUCTION_REQUEST_HEADER_NAMES.runId);
  const artifactId = requiredHeader(headers, PRODUCTION_REQUEST_HEADER_NAMES.artifactId);
  const requestId = requiredHeader(headers, PRODUCTION_REQUEST_HEADER_NAMES.requestId);
  const expectedRevisionHeader = headerValue(headers, PRODUCTION_REQUEST_HEADER_NAMES.expectedCurrentRevision);
  return {
    projectId: safeBindingIdentifier(projectId, "projectId"),
    runId: safeBindingIdentifier(runId, "runId"),
    artifactId: safeBindingArtifactId(artifactId),
    requestId: safeBindingIdentifier(requestId, "productionRequestId"),
    expectedCurrentRevision: expectedRevisionHeader
      ? safeBindingIdentifier(expectedRevisionHeader, "expectedCurrentRevision")
      : null
  };
}

function strictCandidateDependency(value) {
  const keys = Object.keys(value).sort();
  const expectedKeys = ["artifactId", "contentDigest", "revision"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw bindingError(
      "candidateBinding 只能包含 artifactId、revision、contentDigest",
      "FULL_STORY_CANDIDATE_BINDING_INVALID"
    );
  }
  try {
    return normalizeDependency(value);
  } catch (error) {
    throw bindingError(
      `candidateBinding 格式无效：${String(error?.message || "校验失败")}`,
      "FULL_STORY_CANDIDATE_BINDING_INVALID"
    );
  }
}

function assertResolverDependencies({ loadRun, validateCandidate }) {
  if (typeof loadRun !== "function") {
    throw bindingError("缺少 Production Run 校验器", "FULL_STORY_CANDIDATE_RESOLVER_UNAVAILABLE", [], 500);
  }
  if (typeof validateCandidate !== "function") {
    throw bindingError("缺少 Story Candidate 严格契约校验器", "FULL_STORY_CANDIDATE_VALIDATOR_UNAVAILABLE", [], 500);
  }
}

function requiredHeader(headers, name) {
  const value = headerValue(headers, name);
  if (!value) {
    throw bindingError(
      `Full Story 请求缺少 Production header：${name}`,
      "FULL_STORY_CANDIDATE_BINDING_REQUIRED"
    );
  }
  return value;
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function safeBindingIdentifier(value, label) {
  try {
    return safeIdentifier(value, label);
  } catch (error) {
    throw bindingError(String(error?.message || `${label} 格式无效`), "FULL_STORY_CANDIDATE_BINDING_INVALID");
  }
}

function safeBindingArtifactId(value) {
  try {
    return normalizeArtifactId(value);
  } catch (error) {
    throw bindingError(String(error?.message || "artifactId 格式无效"), "FULL_STORY_CANDIDATE_BINDING_INVALID");
  }
}

function bindingError(message, code, details = [], httpStatus = 409) {
  return new ProductionStateError(message, { code, details, httpStatus });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
