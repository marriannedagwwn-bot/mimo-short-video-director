export const ACTIVE_PRODUCTION_RUN_STORAGE_KEY = "mimoActiveProductionRunV1";
export const PRODUCTION_REQUEST_HEADER_NAMES = Object.freeze({
  projectId: "x-mimo-project-id",
  runId: "x-mimo-run-id",
  artifactId: "x-mimo-artifact-id",
  requestId: "x-mimo-production-request-id",
  expectedCurrentRevision: "x-mimo-expected-current-revision"
});

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

export function productionRequestHeaders(token = {}) {
  const projectId = String(token.projectId || "").trim();
  const runId = String(token.runId || "").trim();
  const artifactId = String(token.artifactId || "").trim();
  const requestId = String(token.requestId || "").trim();
  if (!projectId || !runId || !artifactId || !requestId) return {};
  return {
    [PRODUCTION_REQUEST_HEADER_NAMES.projectId]: projectId,
    [PRODUCTION_REQUEST_HEADER_NAMES.runId]: runId,
    [PRODUCTION_REQUEST_HEADER_NAMES.artifactId]: artifactId,
    [PRODUCTION_REQUEST_HEADER_NAMES.requestId]: requestId,
    ...(token.expectedCurrentRevision ? {
      [PRODUCTION_REQUEST_HEADER_NAMES.expectedCurrentRevision]: String(token.expectedCurrentRevision)
    } : {})
  };
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
