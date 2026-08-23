import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadOrCreatePersistentKey, PersistentKeyError } from "./persistent-key.js";
import {
  PRODUCTION_LINEAGE_SCHEMA_VERSION,
  PRODUCTION_PACKAGE_TYPE,
  PRODUCTION_PACKAGE_VERSION,
  ProductionStateError,
  contentDigest,
  createMediaNamespace,
  lineageRef,
  normalizeArtifactId,
  normalizeArtifactType,
  normalizeDependencies,
  packageDigest,
  safeIdentifier,
  sameDependencies,
  signPackageDigest,
  verifyPackageSignature
} from "./production-lineage.js";

const RUN_MANIFEST_TYPE = "mimo-production-run";
const RUN_MANIFEST_VERSION = "1.0";

export class ProductionStateStore {
  constructor({
    rootDir,
    now = () => new Date(),
    idFactory = () => randomUUID()
  } = {}) {
    const configuredRoot = String(rootDir || "").trim();
    if (!configuredRoot) throw new TypeError("ProductionStateStore.rootDir 不能为空");
    this.rootDir = path.resolve(configuredRoot);
    this.now = typeof now === "function" ? now : () => new Date();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.runLocks = new Map();
  }

  async createRun({ projectId = "", metadata = {} } = {}) {
    await this.ensureRoot();
    const resolvedProjectId = projectId
      ? safeIdentifier(projectId, "projectId")
      : `project-${safeIdentifier(this.idFactory(), "project UUID")}`;
    const runId = `run-${safeIdentifier(this.idFactory(), "run UUID")}`;
    const createdAt = this.timestamp();
    const manifest = {
      manifestType: RUN_MANIFEST_TYPE,
      schemaVersion: RUN_MANIFEST_VERSION,
      lineageSchemaVersion: PRODUCTION_LINEAGE_SCHEMA_VERSION,
      projectId: resolvedProjectId,
      runId,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      metadata: plainObject(metadata),
      stages: {},
      checkpoint: { sequence: 0, updatedAt: createdAt },
      counters: {},
      latest: {},
      artifacts: [],
      events: [{ type: "run.created", createdAt }]
    };
    await fs.mkdir(this.runDirectory(resolvedProjectId, runId), { recursive: true, mode: 0o700 });
    await this.writeManifest(manifest);
    return runSummary(manifest);
  }

  async commitArtifact(input = {}) {
    const projectId = safeIdentifier(input.projectId, "projectId");
    const runId = safeIdentifier(input.runId, "runId");
    return this.withRunLock(projectId, runId, async () => {
      const manifest = await this.readManifest(projectId, runId);
      return this.commitArtifactUnlocked(manifest, input);
    });
  }

  async loadRun({ projectId, runId, includeContent = true } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    return this.withRunLock(safeProjectId, safeRunId, async () => {
      const manifest = await this.readManifest(safeProjectId, safeRunId);
      const latestArtifacts = {};
      for (const [artifactId, revision] of Object.entries(manifest.latest || {})) {
        const artifact = findArtifact(manifest, artifactId, revision);
        if (!artifact) continue;
        latestArtifacts[artifactId] = {
          lineage: publicLineage(artifact),
          ...(includeContent ? { content: await this.readArtifactContent(manifest, artifact) } : {})
        };
      }
      return {
        ...runSummary(manifest),
        latestArtifacts,
        events: structuredClone(manifest.events || [])
      };
    });
  }

  async recordStage(input = {}) {
    const projectId = safeIdentifier(input.projectId, "projectId");
    const runId = safeIdentifier(input.runId, "runId");
    const stageId = normalizeArtifactId(input.stageId);
    const status = String(input.status || "").trim();
    if (!["running", "failed", "cancelled"].includes(status)) {
      throw new ProductionStateError("stage status 只能是 running、failed 或 cancelled", {
        code: "PRODUCTION_STAGE_STATUS_INVALID"
      });
    }
    const requestId = safeIdentifier(input.requestId, "requestId");
    return this.withRunLock(projectId, runId, async () => {
      const manifest = await this.readManifest(projectId, runId);
      const updatedAt = this.timestamp();
      manifest.stages ||= {};
      manifest.stages[stageId] = {
        stageId,
        status,
        requestId,
        updatedAt,
        ...(status === "failed" ? {
          error: {
            code: String(input.error?.code || "STAGE_FAILED").slice(0, 120),
            message: String(input.error?.message || "阶段执行失败").slice(0, 1_000)
          }
        } : {})
      };
      advanceCheckpoint(manifest, updatedAt);
      manifest.events ||= [];
      manifest.events.push({ type: `stage.${status}`, stageId, requestId, createdAt: updatedAt });
      manifest.events = manifest.events.slice(-2_000);
      await this.writeManifest(manifest);
      return {
        stage: structuredClone(manifest.stages[stageId]),
        checkpoint: structuredClone(manifest.checkpoint)
      };
    });
  }

  async sealPackage({ projectId, runId, payload } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const unsignedPackage = await this.withRunLock(safeProjectId, safeRunId, async () => {
      const manifest = await this.readManifest(safeProjectId, safeRunId);
      const source = requirePackagePayload(payload);
      const variant = requireObject(source.selectedVariant, "selectedVariant");
      const variantId = safeIdentifier(variant.id, "selectedVariant.id");
      const fullStory = requireObject(source.fullStory, "fullStory");
      const animationPlan = source.animationPlan && typeof source.animationPlan === "object"
        ? source.animationPlan
        : null;
      const selectedVariant = this.requireCurrentArtifact(manifest, `variant:${variantId}`, variant);
      const story = this.requireCurrentArtifact(manifest, `fullStory:${variantId}`, fullStory);
      assertDependsOn(story, selectedVariant, "Full Story 没有绑定当前 Variant revision");
      let plan = null;
      if (animationPlan) {
        plan = this.requireCurrentArtifact(manifest, `animationPlan:${variantId}`, animationPlan);
        assertDependsOn(plan, story, "Animation Plan 没有绑定当前 Story revision");
      }
      return {
        ...structuredClone(source),
        packageType: PRODUCTION_PACKAGE_TYPE,
        packageVersion: PRODUCTION_PACKAGE_VERSION,
        productionLineage: {
          schemaVersion: PRODUCTION_LINEAGE_SCHEMA_VERSION,
          projectId: safeProjectId,
          runId: safeRunId,
          artifacts: {
            selectedVariant: publicLineage(selectedVariant),
            fullStory: publicLineage(story),
            ...(plan ? { animationPlan: publicLineage(plan) } : {})
          },
          mediaNamespace: plan?.mediaNamespace || ""
        }
      };
    });
    const digest = packageDigest(unsignedPackage);
    const key = await this.signingKey();
    return {
      ...unsignedPackage,
      packageDigest: digest,
      packageSignature: signPackageDigest(digest, key)
    };
  }

  async validatePackage(value) {
    const payload = requirePackagePayload(value);
    if (payload.packageType !== PRODUCTION_PACKAGE_TYPE || payload.packageVersion !== PRODUCTION_PACKAGE_VERSION) {
      throw new ProductionStateError(
        `只接受 ${PRODUCTION_PACKAGE_TYPE} v${PRODUCTION_PACKAGE_VERSION}，旧测试包必须重新导出`,
        { code: "PRODUCTION_PACKAGE_VERSION_UNSUPPORTED" }
      );
    }
    const claimedDigest = String(payload.packageDigest || "").trim().toLowerCase();
    const actualDigest = packageDigest(payload);
    if (claimedDigest !== actualDigest) {
      throw new ProductionStateError("生产包内容摘要不匹配，文件可能已被修改", {
        code: "PRODUCTION_PACKAGE_DIGEST_MISMATCH"
      });
    }
    const key = await this.signingKey();
    if (!verifyPackageSignature(actualDigest, payload.packageSignature, key)) {
      throw new ProductionStateError("生产包签名无效，不能作为可信输入导入", {
        code: "PRODUCTION_PACKAGE_SIGNATURE_INVALID"
      });
    }
    const lineage = requireObject(payload.productionLineage, "productionLineage");
    if (lineage.schemaVersion !== PRODUCTION_LINEAGE_SCHEMA_VERSION) {
      throw new ProductionStateError("生产包 lineage schema 版本不受支持", {
        code: "PRODUCTION_LINEAGE_VERSION_UNSUPPORTED"
      });
    }
    const artifacts = requireObject(lineage.artifacts, "productionLineage.artifacts");
    const selectedVariant = validatePackagedArtifact(
      artifacts.selectedVariant,
      payload.selectedVariant,
      "selectedVariant"
    );
    const fullStory = validatePackagedArtifact(artifacts.fullStory, payload.fullStory, "fullStory");
    assertDependsOn(fullStory, selectedVariant, "生产包 Full Story 与 Variant lineage 不匹配");
    if (String(payload.fullStory?.selectedVariantId || "") !== String(payload.selectedVariant?.id || "")) {
      throw new ProductionStateError("生产包 Full Story 与 selectedVariant id 不匹配", {
        code: "PRODUCTION_PACKAGE_VARIANT_MISMATCH"
      });
    }
    let animationPlan = null;
    if (payload.animationPlan) {
      animationPlan = validatePackagedArtifact(
        artifacts.animationPlan,
        payload.animationPlan,
        "animationPlan"
      );
      assertDependsOn(animationPlan, fullStory, "生产包 Animation Plan 与 Full Story lineage 不匹配");
      if (String(payload.animationPlan.selectedVariantId || "") !== String(payload.selectedVariant.id || "")) {
        throw new ProductionStateError("生产包 Animation Plan 与 selectedVariant id 不匹配", {
          code: "PRODUCTION_PACKAGE_PLAN_VARIANT_MISMATCH"
        });
      }
    }
    return {
      payload: structuredClone(payload),
      lineage: { selectedVariant, fullStory, animationPlan }
    };
  }

  async importPackage(value) {
    const validated = await this.validatePackage(value);
    const source = validated.payload;
    const created = await this.createRun({
      metadata: {
        importedFromPackageDigest: source.packageDigest,
        sourceVideo: plainObject(source.sourceVideo),
        creatorProfile: plainObject(source.creatorProfile)
      }
    });
    const common = {
      projectId: created.projectId,
      runId: created.runId,
      expectedCurrentRevision: null
    };
    const lineages = {};
    const commitImported = async (artifactId, artifactType, content, dependencies = [], options = {}) => {
      if (!content || typeof content !== "object" || Array.isArray(content)) return null;
      const committed = await this.commitArtifact({
        ...common,
        artifactId,
        artifactType,
        content,
        dependencies: dependencies.filter(Boolean).map((item) => lineageRef(item.lineage)),
        requestId: `import-${this.idFactory()}`,
        ...options
      });
      lineages[artifactId] = committed.lineage;
      return committed;
    };
    const referenceAnalysis = await commitImported(
      "referenceAnalysis", "referenceAnalysis", source.referenceAnalysis
    );
    const reconstruction = await commitImported(
      "sourceScriptReconstruction",
      "sourceScriptReconstruction",
      source.sourceScriptReconstruction,
      [referenceAnalysis]
    );
    const brief = await commitImported(
      "creativeBrief",
      "creativeBrief",
      source.creativeBrief,
      [referenceAnalysis, reconstruction]
    );
    const guardrails = await commitImported(
      "visualGuardrails",
      "visualGuardrails",
      source.visualGuardrails,
      [referenceAnalysis, reconstruction, brief]
    );
    const themeVariants = await commitImported(
      "themeVariants",
      "themeVariants",
      source.themeVariants,
      [brief, guardrails]
    );
    const variantId = safeIdentifier(source.selectedVariant.id, "selectedVariant.id");
    const selectedVariant = await this.commitArtifact({
      ...common,
      artifactId: `variant:${variantId}`,
      artifactType: "selectedVariant",
      content: source.selectedVariant,
      dependencies: themeVariants ? [lineageRef(themeVariants.lineage)] : [],
      requestId: `import-${this.idFactory()}`
    });
    lineages[`variant:${variantId}`] = selectedVariant.lineage;
    const storyDependencies = [
      referenceAnalysis,
      reconstruction,
      brief,
      guardrails,
      themeVariants,
      selectedVariant
    ].filter(Boolean).map((item) => lineageRef(item.lineage));
    const fullStory = await this.commitArtifact({
      ...common,
      artifactId: `fullStory:${variantId}`,
      artifactType: "fullStory",
      content: source.fullStory,
      dependencies: storyDependencies,
      requestId: `import-${this.idFactory()}`
    });
    lineages[`fullStory:${variantId}`] = fullStory.lineage;
    if (source.animationPlan) {
      const planDependencies = [
        referenceAnalysis,
        reconstruction,
        brief,
        guardrails,
        selectedVariant,
        fullStory
      ].filter(Boolean).map((item) => lineageRef(item.lineage));
      const animationPlan = await this.commitArtifact({
        ...common,
        artifactId: `animationPlan:${variantId}`,
        artifactType: "animationPlan",
        content: source.animationPlan,
        dependencies: planDependencies,
        requestId: `import-${this.idFactory()}`,
        createMediaNamespace: true
      });
      lineages[`animationPlan:${variantId}`] = animationPlan.lineage;
    }
    const sanitizedPayload = structuredClone(source);
    sanitizedPayload.shotFrameResults = {};
    sanitizedPayload.shotVideoResults = {};
    if (sanitizedPayload.output && typeof sanitizedPayload.output === "object") {
      sanitizedPayload.output.shotFrameResults = {};
      sanitizedPayload.output.shotVideoResults = {};
    }
    const importedRun = await this.loadRun({
      projectId: created.projectId,
      runId: created.runId,
      includeContent: false
    });
    return {
      payload: sanitizedPayload,
      production: {
        ...importedRun,
        latestArtifacts: undefined,
        artifacts: lineages
      },
      discardedMedia: true
    };
  }

  async commitArtifactUnlocked(manifest, input) {
    const artifactId = normalizeArtifactId(input.artifactId);
    const artifactType = normalizeArtifactType(input.artifactType);
    const requestId = safeIdentifier(input.requestId, "requestId");
    if (input.content === undefined) {
      throw new ProductionStateError("artifact content 不能为空", {
        code: "ARTIFACT_CONTENT_MISSING"
      });
    }
    const dependencies = normalizeDependencies(input.dependencies || []);
    for (const dependency of dependencies) this.requireCurrentDependency(manifest, dependency);
    const current = currentArtifact(manifest, artifactId);
    if (Object.prototype.hasOwnProperty.call(input, "expectedCurrentRevision")) {
      const expected = input.expectedCurrentRevision
        ? safeIdentifier(input.expectedCurrentRevision, "expectedCurrentRevision")
        : null;
      const actual = current?.revision || null;
      if (expected !== actual) {
        throw new ProductionStateError(
          `artifact ${artifactId} 已从 ${expected || "空版本"} 更新为 ${actual || "空版本"}，拒绝旧请求回写`,
          {
            code: "ARTIFACT_REVISION_CONFLICT",
            httpStatus: 409,
            details: [{ artifactId, expectedRevision: expected, actualRevision: actual }]
          }
        );
      }
    }
    const digest = contentDigest(input.content);
    if (
      current
      && current.status === "current"
      && current.contentDigest === digest
      && sameDependencies(current.dependencies, dependencies)
    ) {
      const completedAt = this.timestamp();
      manifest.stages ||= {};
      manifest.stages[artifactId] = {
        stageId: artifactId,
        artifactType,
        status: "completed",
        requestId,
        revision: current.revision,
        contentDigest: current.contentDigest,
        updatedAt: completedAt,
        reused: true
      };
      advanceCheckpoint(manifest, completedAt);
      manifest.events ||= [];
      manifest.events.push({
        type: "artifact.reused",
        artifactId,
        revision: current.revision,
        requestId,
        createdAt: completedAt
      });
      manifest.events = manifest.events.slice(-2_000);
      await this.writeManifest(manifest);
      return {
        lineage: publicLineage(current),
        reused: true,
        staleArtifactIds: [],
        checkpoint: structuredClone(manifest.checkpoint)
      };
    }
    if (current) {
      current.status = "superseded";
      current.supersededAt = this.timestamp();
    }
    const nextNumber = Math.max(0, Number(manifest.counters?.[artifactId]) || 0) + 1;
    manifest.counters[artifactId] = nextNumber;
    const revision = `${fileSafeArtifactId(artifactId)}-r${nextNumber}`;
    const createdAt = this.timestamp();
    const contentPath = path.posix.join("artifacts", fileSafeArtifactId(artifactId), `${revision}.json`);
    const artifact = {
      artifactId,
      artifactType,
      revision,
      contentDigest: digest,
      dependencies,
      requestId,
      status: "current",
      createdAt,
      contentPath,
      ...(input.createMediaNamespace ? {
        mediaNamespace: createMediaNamespace({
          projectId: manifest.projectId,
          runId: manifest.runId,
          planRevision: revision,
          planDigest: digest
        })
      } : {})
    };
    await this.writeArtifactContent(manifest, artifact, input.content);
    manifest.artifacts.push(artifact);
    manifest.latest[artifactId] = revision;
    const staleArtifactIds = propagateStale(manifest, createdAt);
    manifest.stages ||= {};
    manifest.stages[artifactId] = {
      stageId: artifactId,
      artifactType,
      status: "completed",
      requestId,
      revision,
      contentDigest: digest,
      updatedAt: createdAt
    };
    for (const staleArtifactId of staleArtifactIds) {
      const staleStage = manifest.stages[staleArtifactId];
      if (staleStage) manifest.stages[staleArtifactId] = {
        ...staleStage,
        status: "stale",
        updatedAt: createdAt
      };
    }
    advanceCheckpoint(manifest, createdAt);
    manifest.updatedAt = createdAt;
    manifest.events ||= [];
    manifest.events.push({
      type: "artifact.committed",
      artifactId,
      revision,
      contentDigest: digest,
      requestId,
      staleArtifactIds,
      createdAt
    });
    manifest.events = manifest.events.slice(-2_000);
    await this.writeManifest(manifest);
    return {
      lineage: publicLineage(artifact),
      reused: false,
      staleArtifactIds,
      checkpoint: structuredClone(manifest.checkpoint)
    };
  }

  requireCurrentDependency(manifest, dependency) {
    const artifact = findArtifact(manifest, dependency.artifactId, dependency.revision);
    const latestRevision = manifest.latest?.[dependency.artifactId];
    if (
      !artifact
      || artifact.contentDigest !== dependency.contentDigest
      || artifact.status !== "current"
      || latestRevision !== dependency.revision
    ) {
      throw new ProductionStateError(
        `上游 artifact ${dependency.artifactId}@${dependency.revision} 已不是当前有效版本`,
        {
          code: "ARTIFACT_DEPENDENCY_STALE",
          httpStatus: 409,
          details: [{
            artifactId: dependency.artifactId,
            expectedRevision: dependency.revision,
            actualRevision: latestRevision || null
          }]
        }
      );
    }
    return artifact;
  }

  requireCurrentArtifact(manifest, artifactId, content) {
    const artifact = currentArtifact(manifest, artifactId);
    if (!artifact || artifact.status !== "current") {
      throw new ProductionStateError(`当前 Run 缺少有效 artifact：${artifactId}`, {
        code: "PACKAGE_ARTIFACT_NOT_CURRENT",
        httpStatus: 409
      });
    }
    if (artifact.contentDigest !== contentDigest(content)) {
      throw new ProductionStateError(`导出内容与当前 artifact 不一致：${artifactId}`, {
        code: "PACKAGE_ARTIFACT_DIGEST_MISMATCH",
        httpStatus: 409
      });
    }
    return artifact;
  }

  async ensureRoot() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  runDirectory(projectId, runId) {
    return path.join(this.rootDir, safeIdentifier(projectId, "projectId"), safeIdentifier(runId, "runId"));
  }

  manifestPath(projectId, runId) {
    return path.join(this.runDirectory(projectId, runId), "manifest.json");
  }

  async readManifest(projectId, runId) {
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(this.manifestPath(projectId, runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ProductionStateError("生产 Run 不存在或已丢失", {
          code: "PRODUCTION_RUN_NOT_FOUND",
          httpStatus: 404
        });
      }
      throw error;
    }
    if (
      manifest.manifestType !== RUN_MANIFEST_TYPE
      || manifest.schemaVersion !== RUN_MANIFEST_VERSION
      || manifest.projectId !== projectId
      || manifest.runId !== runId
    ) {
      throw new ProductionStateError("生产 Run manifest 无效", {
        code: "PRODUCTION_RUN_MANIFEST_INVALID",
        httpStatus: 500
      });
    }
    return manifest;
  }

  async writeManifest(manifest) {
    await atomicWriteJson(this.manifestPath(manifest.projectId, manifest.runId), manifest);
  }

  async writeArtifactContent(manifest, artifact, content) {
    const file = path.join(this.runDirectory(manifest.projectId, manifest.runId), artifact.contentPath);
    await atomicWriteJson(file, content);
  }

  async readArtifactContent(manifest, artifact) {
    const file = path.join(this.runDirectory(manifest.projectId, manifest.runId), artifact.contentPath);
    return JSON.parse(await fs.readFile(file, "utf8"));
  }

  async signingKey() {
    try {
      // 与 grounding / 全局角色边界密钥共用同一套「读取或创建」，避免三份安全关键
      // 逻辑各自漂移。包签名密钥不接受环境变量覆盖，行为与既有实现逐字一致。
      const { key } = await loadOrCreatePersistentKey({
        directory: this.rootDir,
        fileName: ".package-signing-key",
        byteLength: 48,
        label: "生产包签名密钥",
        envValue: null
      });
      return key;
    } catch (error) {
      if (error instanceof PersistentKeyError) {
        throw new ProductionStateError("持久化生产包签名密钥损坏", {
          code: "PACKAGE_SIGNING_KEY_INVALID",
          httpStatus: 500
        });
      }
      throw error;
    }
  }

  timestamp() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async withRunLock(projectId, runId, operation) {
    const key = `${projectId}/${runId}`;
    const previous = this.runLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.runLocks.set(key, previous.then(() => gate));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function propagateStale(manifest, timestamp = new Date().toISOString()) {
  const stale = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [artifactId, revision] of Object.entries(manifest.latest || {})) {
      const artifact = findArtifact(manifest, artifactId, revision);
      if (!artifact || artifact.status !== "current") continue;
      const invalidDependency = (artifact.dependencies || []).find((dependency) => {
        const upstream = findArtifact(manifest, dependency.artifactId, dependency.revision);
        return manifest.latest?.[dependency.artifactId] !== dependency.revision
          || !upstream
          || upstream.status !== "current"
          || upstream.contentDigest !== dependency.contentDigest;
      });
      if (!invalidDependency) continue;
      artifact.status = "stale";
      artifact.staleReason = `upstream:${invalidDependency.artifactId}@${invalidDependency.revision}`;
      artifact.staleAt = timestamp;
      stale.add(artifactId);
      changed = true;
    }
  }
  return [...stale].sort();
}

function currentArtifact(manifest, artifactId) {
  const revision = manifest.latest?.[artifactId];
  return revision ? findArtifact(manifest, artifactId, revision) : null;
}

function findArtifact(manifest, artifactId, revision) {
  return (manifest.artifacts || []).find((artifact) => (
    artifact.artifactId === artifactId && artifact.revision === revision
  )) || null;
}

function publicLineage(artifact) {
  return {
    schemaVersion: PRODUCTION_LINEAGE_SCHEMA_VERSION,
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    revision: artifact.revision,
    contentDigest: artifact.contentDigest,
    dependencies: structuredClone(artifact.dependencies || []),
    status: artifact.status,
    createdAt: artifact.createdAt,
    ...(artifact.mediaNamespace ? { mediaNamespace: artifact.mediaNamespace } : {}),
    ...(artifact.staleReason ? { staleReason: artifact.staleReason } : {})
  };
}

function runSummary(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    lineageSchemaVersion: manifest.lineageSchemaVersion,
    projectId: manifest.projectId,
    runId: manifest.runId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    metadata: structuredClone(manifest.metadata || {}),
    stages: structuredClone(manifest.stages || {}),
    checkpoint: structuredClone(manifest.checkpoint || { sequence: 0, updatedAt: manifest.updatedAt })
  };
}

function advanceCheckpoint(manifest, updatedAt) {
  const sequence = Math.max(0, Number(manifest.checkpoint?.sequence) || 0) + 1;
  manifest.checkpoint = { sequence, updatedAt };
  manifest.updatedAt = updatedAt;
}

function validatePackagedArtifact(lineage, content, label) {
  const value = requireObject(lineage, `productionLineage.artifacts.${label}`);
  const normalized = {
    artifactId: normalizeArtifactId(value.artifactId),
    artifactType: normalizeArtifactType(value.artifactType),
    revision: safeIdentifier(value.revision, `${label}.revision`),
    contentDigest: String(value.contentDigest || "").trim().toLowerCase(),
    dependencies: normalizeDependencies(value.dependencies || []),
    status: String(value.status || "")
  };
  if (normalized.status !== "current") {
    throw new ProductionStateError(`生产包 ${label} 不是 current artifact`, {
      code: "PRODUCTION_PACKAGE_ARTIFACT_STALE"
    });
  }
  if (normalized.contentDigest !== contentDigest(content)) {
    throw new ProductionStateError(`生产包 ${label} 内容与 lineage 摘要不一致`, {
      code: "PRODUCTION_PACKAGE_ARTIFACT_DIGEST_MISMATCH"
    });
  }
  return normalized;
}

function assertDependsOn(artifact, upstream, message) {
  const expected = lineageRef(upstream);
  const found = (artifact.dependencies || []).some((dependency) => (
    dependency.artifactId === expected.artifactId
    && dependency.revision === expected.revision
    && dependency.contentDigest === expected.contentDigest
  ));
  if (!found) {
    throw new ProductionStateError(message, {
      code: "ARTIFACT_LINEAGE_MISMATCH"
    });
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionStateError(`${label} 必须是对象`, {
      code: "PRODUCTION_PACKAGE_INVALID"
    });
  }
  return value;
}

function requirePackagePayload(value) {
  return structuredClone(requireObject(value, "生产包"));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

function fileSafeArtifactId(artifactId) {
  return normalizeArtifactId(artifactId).replace(/[^A-Za-z0-9._-]+/gu, "-");
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}
