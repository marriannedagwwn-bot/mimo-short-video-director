export const ACTIVE_PRODUCTION_RUN_STORAGE_KEY = "mimoActiveProductionRunV1";

export function emptyProductionState() {
  return {
    schemaVersion: "1.0",
    projectId: "",
    runId: "",
    artifacts: {},
    stages: {},
    checkpoint: { sequence: 0, updatedAt: "" },
    activeRequests: {}
  };
}

export function productionStateFromRun(run = {}) {
  const artifacts = {};
  for (const [artifactId, entry] of Object.entries(run.latestArtifacts || {})) {
    if (entry?.lineage) artifacts[artifactId] = structuredClone(entry.lineage);
  }
  return {
    ...emptyProductionState(),
    schemaVersion: String(run.lineageSchemaVersion || "1.0"),
    projectId: String(run.projectId || ""),
    runId: String(run.runId || ""),
    artifacts,
    stages: structuredClone(run.stages || {}),
    checkpoint: structuredClone(run.checkpoint || { sequence: 0, updatedAt: "" })
  };
}

export function beginArtifactRequest(production, artifactId, requestId) {
  const id = String(artifactId || "");
  const token = {
    projectId: String(production?.projectId || ""),
    runId: String(production?.runId || ""),
    artifactId: id,
    requestId: String(requestId || ""),
    expectedCurrentRevision: production?.artifacts?.[id]?.revision || null
  };
  production.activeRequests[id] = token.requestId;
  return token;
}

export function isArtifactRequestCurrent(production, token = {}) {
  return Boolean(
    token.requestId
    && production?.projectId === token.projectId
    && production?.runId === token.runId
    && production?.activeRequests?.[token.artifactId] === token.requestId
  );
}

export function finishArtifactRequest(production, token = {}) {
  if (isArtifactRequestCurrent(production, token)) delete production.activeRequests[token.artifactId];
}

export function lineageDependency(lineage = {}) {
  return {
    artifactId: lineage.artifactId,
    revision: lineage.revision,
    contentDigest: lineage.contentDigest
  };
}

export function planProductionContext(production, planArtifactId) {
  const lineage = production?.artifacts?.[planArtifactId];
  if (!lineage || lineage.status !== "current" || !lineage.mediaNamespace) return null;
  return {
    projectId: production.projectId,
    runId: production.runId,
    planArtifactId,
    planRevision: lineage.revision,
    planDigest: lineage.contentDigest,
    mediaNamespace: lineage.mediaNamespace
  };
}
