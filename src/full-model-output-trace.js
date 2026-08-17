import { PRODUCTION_REQUEST_HEADER_NAMES } from "../public/production-lineage-client.js";
import { normalizeArtifactId, safeIdentifier } from "./production-lineage.js";

export async function resolveFullStoryModelOutputTrace({
  headers = {},
  variantId = "",
  loadRun
} = {}) {
  return resolveModelOutputTrace({
    headers,
    variantId,
    loadRun,
    artifactType: "fullStory",
    logLabel: "Full Story"
  });
}

export async function resolveAnimationPlanModelOutputTrace({
  headers = {},
  variantId = "",
  loadRun
} = {}) {
  return resolveModelOutputTrace({
    headers,
    variantId,
    loadRun,
    artifactType: "animationPlan",
    logLabel: "Animation Plan"
  });
}

async function resolveModelOutputTrace({
  headers,
  variantId,
  loadRun,
  artifactType,
  logLabel
}) {
  const unbound = {
    verified: false,
    projectId: "",
    runId: "",
    artifactId: "",
    productionRequestId: "",
    variantId: String(variantId || "").trim().slice(0, 160)
  };
  const claimed = productionRequestContextFromHeaders(headers);
  if (!claimed) return { context: unbound, warning: "" };
  if (typeof loadRun !== "function") {
    return { context: unbound, warning: "缺少 Production Run 校验器，已按未绑定日志处理" };
  }

  try {
    const safeVariantId = safeIdentifier(variantId, "variantId");
    const projectId = safeIdentifier(claimed.projectId, "projectId");
    const runId = safeIdentifier(claimed.runId, "runId");
    const artifactId = normalizeArtifactId(claimed.artifactId);
    const productionRequestId = safeIdentifier(claimed.productionRequestId, "productionRequestId");
    const expectedArtifactId = normalizeArtifactId(`${artifactType}:${safeVariantId}`);
    if (artifactId !== expectedArtifactId) {
      throw new Error(`Production artifactId 与当前 ${logLabel} Variant 不一致`);
    }
    const run = await loadRun({ projectId, runId, includeContent: false });
    const stage = run?.stages?.[artifactId];
    if (!stage || stage.status !== "running" || stage.requestId !== productionRequestId) {
      throw new Error("Production stage 不是当前 running 请求");
    }
    const actualRevision = run?.latestArtifacts?.[artifactId]?.lineage?.revision || null;
    const expectedRevision = claimed.expectedCurrentRevision || null;
    if (actualRevision !== expectedRevision) {
      throw new Error("Production expectedCurrentRevision 与当前 revision 不一致");
    }
    return {
      context: {
        verified: true,
        projectId,
        runId,
        artifactId,
        productionRequestId,
        variantId: safeVariantId
      },
      warning: ""
    };
  } catch (error) {
    return {
      context: unbound,
      warning: `${logLabel} 模型输出日志未绑定 Production Run：${String(error?.message || "校验失败").slice(0, 300)}`
    };
  }
}

export function productionRequestContextFromHeaders(headers = {}) {
  const projectId = headerValue(headers, PRODUCTION_REQUEST_HEADER_NAMES.projectId);
  const runId = headerValue(headers, PRODUCTION_REQUEST_HEADER_NAMES.runId);
  const artifactId = headerValue(headers, PRODUCTION_REQUEST_HEADER_NAMES.artifactId);
  const productionRequestId = headerValue(headers, PRODUCTION_REQUEST_HEADER_NAMES.requestId);
  if (!projectId && !runId && !artifactId && !productionRequestId) return null;
  return {
    projectId,
    runId,
    artifactId,
    productionRequestId,
    expectedCurrentRevision: headerValue(
      headers,
      PRODUCTION_REQUEST_HEADER_NAMES.expectedCurrentRevision
    ) || null
  };
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}
