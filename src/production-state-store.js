import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadOrCreatePersistentKey, PersistentKeyError } from "./persistent-key.js";
import { ProductionRunCoordinator } from "./production-run-coordinator.js";
import {
  PRODUCTION_LINEAGE_SCHEMA_VERSION,
  PRODUCTION_PACKAGE_TYPE,
  PRODUCTION_PACKAGE_VERSION,
  PRODUCTION_STORY_PACKAGE_VERSION,
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
import {
  STORY_ENTRY_MODE,
  STORY_ENTRY_VARIANT_ID,
  STORY_MODE_CHARACTER_ONLY,
  STORY_MODE_FULL_TEXT,
  StoryEntryInputError,
  isStoryEntryMetadata,
  normalizeStoryEntryCreatorProfile,
  normalizeStorySource
} from "../public/story-entry.js";
import { STORYBOARD_PLAN_VERSION } from "../public/storyboard-plan.js";

const RUN_MANIFEST_TYPE = "mimo-production-run";
const RUN_MANIFEST_VERSION = "1.0";

export class ProductionStateStore {
  constructor({
    rootDir,
    gitCommit = "",
    buildId = "",
    now = () => new Date(),
    idFactory = () => randomUUID(),
    coordinator = new ProductionRunCoordinator(),
    artifactWriteGuard = null
  } = {}) {
    const configuredRoot = String(rootDir || "").trim();
    if (!configuredRoot) throw new TypeError("ProductionStateStore.rootDir 不能为空");
    this.rootDir = path.resolve(configuredRoot);
    this.gitCommit = safeBuildIdentity(gitCommit);
    this.buildId = safeBuildIdentity(buildId);
    this.now = typeof now === "function" ? now : () => new Date();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.coordinator = coordinator;
    this.artifactWriteGuard = typeof artifactWriteGuard === "function" ? artifactWriteGuard : null;
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
      gitCommit: this.gitCommit,
      buildId: this.buildId,
      createdAt,
      updatedAt: createdAt,
      metadata: plainObject(metadata),
      stages: {},
      checkpoint: { sequence: 0, updatedAt: createdAt },
      counters: {},
      latest: {},
      artifacts: [],
      events: [{
        type: "run.created",
        createdAt,
        gitCommit: this.gitCommit,
        buildId: this.buildId
      }]
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
      if (this.artifactWriteGuard) {
        await this.artifactWriteGuard({ manifest, input, projectId, runId });
      }
      return this.commitArtifactUnlocked(manifest, input);
    });
  }

  async loadRun({ projectId, runId, includeContent = true } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    // Manifest writes are atomic and Artifact content files are immutable and
    // published before the manifest. Reads therefore need no Run lock and see
    // either a complete old snapshot or a complete new snapshot.
    const manifest = await this.readManifest(safeProjectId, safeRunId);
    return this.loadRunUnlocked(manifest, { includeContent });
  }

  async loadRunUnlocked(manifest, { includeContent = true } = {}) {
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
  }

  async readCurrentLineageSnapshot({ projectId, runId, artifactIds = null } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const manifest = await this.readManifest(safeProjectId, safeRunId);
    const selectedIds = Array.isArray(artifactIds)
      ? new Set(artifactIds.map((artifactId) => normalizeArtifactId(artifactId)))
      : null;
    const artifacts = {};
    for (const [artifactId, revision] of Object.entries(manifest.latest || {})) {
      if (selectedIds && !selectedIds.has(artifactId)) continue;
      const artifact = findArtifact(manifest, artifactId, revision);
      if (artifact) artifacts[artifactId] = publicLineage(artifact);
    }
    return {
      projectId: safeProjectId,
      runId: safeRunId,
      checkpoint: structuredClone(manifest.checkpoint || {}),
      artifacts
    };
  }

  async recordStage(input = {}) {
    const projectId = safeIdentifier(input.projectId, "projectId");
    const runId = safeIdentifier(input.runId, "runId");
    return this.withRunLock(projectId, runId, async () => {
      const manifest = await this.readManifest(projectId, runId);
      return this.recordStageUnlocked(manifest, input);
    });
  }

  async recordStageUnlocked(manifest, input = {}) {
    const stageId = normalizeArtifactId(input.stageId);
    const status = String(input.status || "").trim();
    const allowedStatuses = ["running", "failed", "cancelled", "interrupted", "conflicted", "abandoned"];
    if (!allowedStatuses.includes(status)) {
      throw new ProductionStateError(`stage status 只能是 ${allowedStatuses.join("、")}`, {
        code: "PRODUCTION_STAGE_STATUS_INVALID"
      });
    }
    const requestId = safeIdentifier(input.requestId, "requestId");
    const currentStage = manifest.stages?.[stageId] || null;
    if (
      status !== "running"
      && input.expectedRequestId
      && currentStage?.requestId !== safeIdentifier(input.expectedRequestId, "expectedRequestId")
    ) {
      return {
        applied: false,
        stage: currentStage ? structuredClone(currentStage) : null,
        checkpoint: structuredClone(manifest.checkpoint || {})
      };
    }
    const updatedAt = this.timestamp();
    const gitCommit = this.gitCommit || safeBuildIdentity(manifest.gitCommit);
    const buildId = this.buildId || safeBuildIdentity(manifest.buildId) || gitCommit;
    const terminalReason = status === "running" ? null : sanitizeStageTerminalReason(input.error, status);
    manifest.stages ||= {};
    manifest.stages[stageId] = {
      stageId,
      status,
      requestId,
      updatedAt,
      gitCommit,
      buildId,
      ...(terminalReason ? {
        error: { stage: stageId, gitCommit, buildId, ...terminalReason }
      } : {})
    };
    advanceCheckpoint(manifest, updatedAt);
    manifest.events ||= [];
    manifest.events.push({
      type: `stage.${status}`,
      stageId,
      requestId,
      createdAt: updatedAt,
      gitCommit,
      buildId,
      ...(terminalReason ? {
        code: terminalReason.code,
        category: terminalReason.category,
        diagnostics: structuredClone(terminalReason.diagnostics)
      } : {})
    });
    manifest.events = manifest.events.slice(-2_000);
    await this.writeManifest(manifest);
    return {
      applied: true,
      stage: structuredClone(manifest.stages[stageId]),
      checkpoint: structuredClone(manifest.checkpoint)
    };
  }

  async sealPackage({ projectId, runId, payload } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const unsignedPackage = await this.withRunLock(safeProjectId, safeRunId, async () => {
      const manifest = await this.readManifest(safeProjectId, safeRunId);
      // 3.0 包只装参考视频那条链；「从剧情开始」的 Run 签 3.1 包（2026-10-10），内容由服务端从 Run
      // 本身读出，见 assembleStoryPackageUnlocked。下面参考视频那段逐字不动（金标准测试锁住字节）。
      if (isStoryEntryMetadata(manifest.metadata)) {
        return this.assembleStoryPackageUnlocked(manifest, payload, { projectId: safeProjectId, runId: safeRunId });
      }
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
    const supportedVersions = [PRODUCTION_PACKAGE_VERSION, PRODUCTION_STORY_PACKAGE_VERSION];
    if (payload.packageType !== PRODUCTION_PACKAGE_TYPE || !supportedVersions.includes(payload.packageVersion)) {
      throw new ProductionStateError(
        `只接受 ${PRODUCTION_PACKAGE_TYPE} v${PRODUCTION_PACKAGE_VERSION}（参考视频）或 v${PRODUCTION_STORY_PACKAGE_VERSION}（从剧情开始），旧测试包必须重新导出`,
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
    // 摘要与签名之后才解析内容：3.1（从剧情开始）交给与签发时同一个校验函数。
    if (payload.packageVersion === PRODUCTION_STORY_PACKAGE_VERSION) {
      return { payload: structuredClone(payload), story: validateStoryPackageBody(payload) };
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

  async importPackage(value, { browserWorkspaceId, onRunCreated } = {}) {
    if (onRunCreated !== undefined && typeof onRunCreated !== "function") {
      throw new TypeError("onRunCreated 必须是函数");
    }
    if (browserWorkspaceId !== undefined && (typeof browserWorkspaceId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(browserWorkspaceId))) {
      throw new ProductionStateError("页面工作区标识无效", {
        code: "BROWSER_WORKSPACE_ID_INVALID", httpStatus: 400
      });
    }
    const validated = await this.validatePackage(value);
    if (validated.story) return this.importStoryPackageValidated(validated, { browserWorkspaceId, onRunCreated });
    const source = validated.payload;
    const created = await this.createRun({
      metadata: {
        importedFromPackageDigest: source.packageDigest,
        sourceVideo: plainObject(source.sourceVideo),
        creatorProfile: plainObject(source.creatorProfile),
        ...(browserWorkspaceId ? { browserWorkspaceId } : {})
      }
    });
    if (onRunCreated) await onRunCreated(structuredClone(created));
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

  // 「从剧情开始」的 Run 签 3.1 包（2026-10-10），在 sealPackage 的 Run 锁内调用。
  // 包里的原文、角色边界、候选、选中记录与固定角色设定一律由服务端从 Run 本身读出，不用浏览器的副本——
  // 否则浏览器可以借「打包 → 导入」写进一份原文，绕过「原文只能由服务端写」（STORY_SOURCE_SERVER_ONLY）。
  // 浏览器只给导出时间、模式、模型信息，以及剧情与分镜两份副本；副本只用来核对页面上看到的就是当前版本。
  async assembleStoryPackageUnlocked(manifest, payload, { projectId, runId }) {
    const source = requirePackagePayload(payload);
    const unknown = Object.keys(source).filter((key) => !STORY_PACKAGE_BROWSER_KEYS.includes(key));
    if (unknown.length) {
      throw new ProductionStateError(
        `剧情 Run 的测试包只接受页面发来的 ${STORY_PACKAGE_BROWSER_KEYS.join("、")}，多出：${unknown.join("、")}`,
        { code: "PRODUCTION_PACKAGE_STORY_INPUT_INVALID", httpStatus: 400 }
      );
    }
    if ((source.exportedAt !== undefined && typeof source.exportedAt !== "string")
      || (source.mode !== undefined && typeof source.mode !== "string")
      || (source.modelInfo !== undefined && (!source.modelInfo || typeof source.modelInfo !== "object" || Array.isArray(source.modelInfo)))) {
      throw new ProductionStateError("剧情 Run 的测试包里 exportedAt、mode 必须是字符串，modelInfo 必须是对象", {
        code: "PRODUCTION_PACKAGE_STORY_INPUT_INVALID",
        httpStatus: 400
      });
    }
    const fullStoryCopy = requireObject(source.fullStory, "fullStory");
    const planCopy = source.animationPlan === undefined || source.animationPlan === null
      ? null
      : requireObject(source.animationPlan, "animationPlan");

    // 与 server.js trustedStoryEntryContext 同一口径：原文必须是当前版本，摘要与建 Run 时写定的一致。
    const metadata = manifest.metadata || {};
    const storyMode = metadata.storyMode;
    const graph = STORY_PACKAGE_GRAPH[storyMode];
    if (!graph) {
      throw new ProductionStateError("这个剧情 Run 的剧情模式无效，不能导出测试包", {
        code: "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED",
        httpStatus: 409
      });
    }
    const creatorProfile = storyEntryValue(() => normalizeStoryEntryCreatorProfile(metadata.creatorProfile),
      "这个剧情 Run 的固定角色设定无效", 409);
    const storySourceArtifact = currentArtifact(manifest, "storySource");
    if (!storySourceArtifact || storySourceArtifact.status !== "current") {
      throw new ProductionStateError("当前 Run 缺少有效 artifact：storySource", { code: "PACKAGE_ARTIFACT_NOT_CURRENT", httpStatus: 409 });
    }
    if (storySourceArtifact.contentDigest !== metadata.storySourceDigest) {
      throw new ProductionStateError("故事原文与这个剧情 Run 开始时记下的摘要不一致，不能导出", {
        code: "STORY_SOURCE_TAMPERED",
        httpStatus: 409
      });
    }
    // 页面上的副本必须就是当前版本。
    this.requireCurrentArtifact(manifest, `fullStory:${STORY_ENTRY_VARIANT_ID}`, fullStoryCopy);
    const plan = planCopy ? this.requireCurrentArtifact(manifest, `animationPlan:${STORY_ENTRY_VARIANT_ID}`, planCopy) : null;

    const nodes = graph.filter((node) => !node.optional || plan);
    const lineages = {};
    const contents = {};
    for (const node of nodes) {
      const artifact = currentArtifact(manifest, node.artifactId);
      if (!artifact || artifact.status !== "current") {
        throw new ProductionStateError(`当前 Run 缺少有效 artifact：${node.artifactId}`, { code: "PACKAGE_ARTIFACT_NOT_CURRENT", httpStatus: 409 });
      }
      // 依赖必须和依赖图逐项完全相等。第一期最早那版造出的「粘贴完整故事」Run 带候选与选中记录，
      // 在这里明确拒绝，不去改它的结构。
      const expectedDependencies = node.dependsOn.map((key) => lineageRef(lineages[key]));
      if (artifact.artifactType !== node.artifactType || !sameDependencies(artifact.dependencies || [], expectedDependencies)) {
        throw new ProductionStateError(
          `这个剧情 Run 的 ${node.artifactId} 与当前版本的依赖图不一致（可能是早期版本建的 Run），不能导出测试包；请重新开始拆镜头。`,
          { code: "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED", httpStatus: 409 }
        );
      }
      lineages[node.key] = artifact;
      contents[node.key] = await this.readArtifactContent(manifest, artifact);
    }
    const body = {
      packageType: PRODUCTION_PACKAGE_TYPE,
      packageVersion: PRODUCTION_STORY_PACKAGE_VERSION,
      entryMode: STORY_ENTRY_MODE,
      storyMode,
      ...(source.exportedAt !== undefined ? { exportedAt: source.exportedAt } : {}),
      ...(source.mode !== undefined ? { mode: source.mode } : {}),
      ...(source.modelInfo !== undefined ? { modelInfo: structuredClone(source.modelInfo) } : {}),
      storySource: contents.storySource,
      storySourceDigest: storySourceArtifact.contentDigest,
      creatorProfile,
      ...Object.fromEntries(nodes.filter((node) => node.key !== "storySource").map((node) => [node.key, contents[node.key]])),
      productionLineage: {
        schemaVersion: PRODUCTION_LINEAGE_SCHEMA_VERSION,
        projectId,
        runId,
        artifacts: Object.fromEntries(nodes.map((node) => [node.key, publicLineage(lineages[node.key])])),
        mediaNamespace: plan?.mediaNamespace || ""
      }
    };
    // 签发前跑与导入时同一个校验：签不出导入会拒的包。
    validateStoryPackageBody(body);
    return body;
  }

  // 导入 3.1 包：重建一个独立的剧情 Run。先写好元数据（入口、剧情模式、原文摘要、规整后的固定角色设定），
  // 再按依赖图的顺序由服务端提交原文与各份产物，依赖关系与原 Run 完全一样，分镜签发新的媒体命名空间。
  // 除了「开始拆镜头」（server.js startStoryEntryRun），这是唯一写原文的地方；包已经过本机签名校验。
  // 提交的是规整后的原文与设定：摘要不变，键的顺序与页面比较的一致，不会被误判成「原文改过」。
  async importStoryPackageValidated(validated, { browserWorkspaceId, onRunCreated } = {}) {
    const { payload, story } = validated;
    const created = await this.createRun({
      metadata: {
        entryMode: STORY_ENTRY_MODE,
        storyMode: story.storyMode,
        storySourceDigest: contentDigest(story.storySource),
        creatorProfile: story.creatorProfile,
        importedFromPackageDigest: payload.packageDigest,
        ...(browserWorkspaceId ? { browserWorkspaceId } : {}),
        startedBy: "package-import"
      }
    });
    if (onRunCreated) await onRunCreated(structuredClone(created));
    const lineages = {};
    for (const node of story.nodes) {
      const committed = await this.commitArtifact({
        projectId: created.projectId,
        runId: created.runId,
        artifactId: node.artifactId,
        artifactType: node.artifactType,
        content: node.key === "storySource" ? story.storySource : payload[node.key],
        dependencies: node.dependsOn.map((key) => lineageRef(lineages[key])),
        requestId: `import-${this.idFactory()}`,
        expectedCurrentRevision: null,
        ...(node.key === "animationPlan" ? { createMediaNamespace: true } : {})
      });
      lineages[node.key] = committed.lineage;
    }
    const importedRun = await this.loadRun({
      projectId: created.projectId,
      runId: created.runId,
      includeContent: false
    });
    return {
      payload: structuredClone(payload),
      production: {
        ...importedRun,
        latestArtifacts: undefined,
        artifacts: Object.fromEntries(story.nodes.map((node) => [node.artifactId, lineages[node.key]]))
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
    const digest = contentDigest(input.content);
    if (
      current
      && current.status === "current"
      && current.requestId === requestId
      && current.contentDigest === digest
      && sameDependencies(current.dependencies, dependencies)
    ) {
      return this.reuseArtifactUnlocked(manifest, { current, artifactId, artifactType, requestId });
    }
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

  async reuseArtifactUnlocked(manifest, { current, artifactId, artifactType, requestId }) {
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
    return this.coordinator.withRunLock(projectId, runId, operation);
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
    gitCommit: String(manifest.gitCommit || ""),
    buildId: String(manifest.buildId || ""),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    metadata: structuredClone(manifest.metadata || {}),
    stages: structuredClone(manifest.stages || {}),
    checkpoint: structuredClone(manifest.checkpoint || { sequence: 0, updatedAt: manifest.updatedAt })
  };
}

function sanitizeStageTerminalReason(value, status = "failed") {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const diagnostics = sanitizeStageDiagnostics(source.diagnostics || source.details);
  return {
    code: safeFailureCode(diagnostics[0]?.code || source.code || `STAGE_${String(status).toUpperCase()}`),
    category: safeFailureCode(source.category || "unknown"),
    message: redactSensitiveText(source.message || diagnostics[0]?.reason || `阶段已${status}`, 1_000),
    diagnostics
  };
}

function sanitizeStageDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const pointer = String(source.jsonPointer || (String(source.path || "").startsWith("/") ? source.path : ""));
    return {
      code: safeFailureCode(source.code || source.errorCode || "VALIDATION_ERROR"),
      jsonPointer: pointer.startsWith("/") ? pointer.slice(0, 1_000) : "",
      reason: redactSensitiveText(source.reason || source.message || source.code || "校验失败", 2_000)
    };
  });
}

function safeFailureCode(value) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9_.:/-]+/gu, "_");
  return (normalized || "UNKNOWN_ERROR").slice(0, 160);
}

function safeBuildIdentity(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/gu, "").slice(0, 128);
}

function redactSensitiveText(value, limit) {
  return String(value || "")
    .replace(/data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[data-url-redacted]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, "[base64-redacted]")
    .slice(0, limit);
}

function advanceCheckpoint(manifest, updatedAt) {
  const sequence = Math.max(0, Number(manifest.checkpoint?.sequence) || 0) + 1;
  manifest.checkpoint = { sequence, updatedAt };
  manifest.updatedAt = updatedAt;
}

// ---- 「从剧情开始」的 3.1 测试包（2026-10-10）----

// 页面发来的字段白名单：其余（原文、角色边界、候选、设定……）一律由服务端从 Run 读出。
const STORY_PACKAGE_BROWSER_KEYS = Object.freeze(["exportedAt", "mode", "modelInfo", "fullStory", "animationPlan"]);

// 剧情 Run 的依赖图，唯一一份：签发、校验、导入都按它。与流水线实际提交的依赖一致
// （server.js 的剧情入口阶段与 test/story-entry-server.test.js 断言同一张图）；动它要同步那几处。
// key 同时是包里存放该产物内容的顶层字段名；animationPlan 可以没有（还没生成分镜时）。
function storyPackageNode(key, artifactId, artifactType, dependsOn, optional = false) {
  return Object.freeze({ key, artifactId, artifactType, dependsOn: Object.freeze(dependsOn), optional });
}
export const STORY_PACKAGE_GRAPH = Object.freeze({
  [STORY_MODE_FULL_TEXT]: Object.freeze([
    storyPackageNode("storySource", "storySource", "storySource", []),
    storyPackageNode("visualGuardrails", "visualGuardrails", "visualGuardrails", ["storySource"]),
    storyPackageNode("fullStory", `fullStory:${STORY_ENTRY_VARIANT_ID}`, "fullStory", ["storySource", "visualGuardrails"]),
    storyPackageNode("animationPlan", `animationPlan:${STORY_ENTRY_VARIANT_ID}`, "animationPlan", ["storySource", "visualGuardrails", "fullStory"], true)
  ]),
  [STORY_MODE_CHARACTER_ONLY]: Object.freeze([
    storyPackageNode("storySource", "storySource", "storySource", []),
    storyPackageNode("visualGuardrails", "visualGuardrails", "visualGuardrails", ["storySource"]),
    storyPackageNode("themeVariants", "themeVariants", "themeVariants", ["storySource", "visualGuardrails"]),
    storyPackageNode("selectedVariant", `variant:${STORY_ENTRY_VARIANT_ID}`, "selectedVariant", ["themeVariants"]),
    storyPackageNode("fullStory", `fullStory:${STORY_ENTRY_VARIANT_ID}`, "fullStory", ["storySource", "visualGuardrails", "themeVariants", "selectedVariant"]),
    storyPackageNode("animationPlan", `animationPlan:${STORY_ENTRY_VARIANT_ID}`, "animationPlan", ["storySource", "visualGuardrails", "selectedVariant", "fullStory"], true)
  ])
});

const STORY_PACKAGE_REQUIRED_KEYS = Object.freeze([
  "packageType", "packageVersion", "entryMode", "storyMode", "storySource", "storySourceDigest",
  "creatorProfile", "visualGuardrails", "fullStory", "productionLineage"
]);
const STORY_PACKAGE_OPTIONAL_KEYS = Object.freeze([
  "exportedAt", "mode", "modelInfo", "animationPlan", "packageDigest", "packageSignature"
]);
const STORY_PACKAGE_MODE_KEYS = Object.freeze({
  [STORY_MODE_FULL_TEXT]: Object.freeze([]),
  [STORY_MODE_CHARACTER_ONLY]: Object.freeze(["themeVariants", "selectedVariant"])
});

function storyPackageError(message, code = "PRODUCTION_PACKAGE_STORY_INVALID") {
  return new ProductionStateError(message, { code, httpStatus: 400 });
}

// 剧情入口的规整函数抛 StoryEntryInputError（没有 httpStatus，会变成 500），这里转成生产状态错误。
function storyEntryValue(read, message, httpStatus = 400) {
  try {
    return read();
  } catch (error) {
    if (error instanceof StoryEntryInputError) {
      throw new ProductionStateError(`${message}：${error.message}`, { code: "PRODUCTION_PACKAGE_STORY_INVALID", httpStatus });
    }
    throw error;
  }
}

// 3.1 包的全部内容校验。签发前（assembleStoryPackageUnlocked）与导入时（validatePackage）用同一个函数。
// 不重跑业务 Schema：本机签名是信任根，任务使用这些内容时会照常再校验（与 3.0 同规格）。
export function validateStoryPackageBody(body) {
  const value = requireObject(body, "生产包");
  if (value.packageType !== PRODUCTION_PACKAGE_TYPE || value.packageVersion !== PRODUCTION_STORY_PACKAGE_VERSION) {
    throw storyPackageError(`剧情 Run 的测试包必须是 ${PRODUCTION_PACKAGE_TYPE} v${PRODUCTION_STORY_PACKAGE_VERSION}`, "PRODUCTION_PACKAGE_VERSION_UNSUPPORTED");
  }
  if (value.entryMode !== STORY_ENTRY_MODE) {
    throw storyPackageError(`v${PRODUCTION_STORY_PACKAGE_VERSION} 测试包必须带 entryMode: "${STORY_ENTRY_MODE}"`, "PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED");
  }
  const storyMode = value.storyMode;
  const graph = STORY_PACKAGE_GRAPH[storyMode];
  if (!graph) throw storyPackageError("剧情 Run 的测试包 storyMode 无效");

  const required = [...STORY_PACKAGE_REQUIRED_KEYS, ...STORY_PACKAGE_MODE_KEYS[storyMode]];
  const allowed = new Set([...required, ...STORY_PACKAGE_OPTIONAL_KEYS]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw storyPackageError(`剧情 Run 的测试包有未定义的字段：${unknown.join("、")}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw storyPackageError(`剧情 Run 的测试包缺少字段：${missing.join("、")}`);

  // 原文与固定角色设定：按建 Run 时同一套严格规则，且必须已经是规整后的样子。
  const storySource = storyEntryValue(() => normalizeStorySource(value.storySource), "剧情 Run 的测试包里故事原文无效");
  if (contentDigest(storySource) !== contentDigest(value.storySource) || storySource.storyMode !== storyMode) {
    throw storyPackageError("剧情 Run 的测试包里故事原文与剧情模式不一致，或没有按规则规整");
  }
  if (value.storySourceDigest !== contentDigest(storySource)) {
    throw storyPackageError("剧情 Run 的测试包里原文摘要与原文不一致", "STORY_SOURCE_TAMPERED");
  }
  const creatorProfile = storyEntryValue(() => normalizeStoryEntryCreatorProfile(value.creatorProfile),
    "剧情 Run 的测试包里固定角色设定无效");
  if (contentDigest(creatorProfile) !== contentDigest(value.creatorProfile)) {
    throw storyPackageError("剧情 Run 的测试包里固定角色设定没有按规则规整");
  }

  // 每份产物：内容摘要、当前版本，以及上游依赖与依赖图逐项完全相等。
  const lineage = requireObject(value.productionLineage, "productionLineage");
  if (lineage.schemaVersion !== PRODUCTION_LINEAGE_SCHEMA_VERSION) {
    throw storyPackageError("生产包 lineage schema 版本不受支持", "PRODUCTION_LINEAGE_VERSION_UNSUPPORTED");
  }
  const artifacts = requireObject(lineage.artifacts, "productionLineage.artifacts");
  const hasPlan = value.animationPlan !== undefined && value.animationPlan !== null;
  const nodes = graph.filter((node) => !node.optional || hasPlan);
  const expectedKeys = nodes.map((node) => node.key).sort();
  if (contentDigest(Object.keys(artifacts).sort()) !== contentDigest(expectedKeys)) {
    throw storyPackageError(`剧情 Run 的测试包产物清单与依赖图不一致：应为 ${expectedKeys.join("、")}`, "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED");
  }
  const normalized = {};
  for (const node of nodes) {
    const entry = validatePackagedArtifact(artifacts[node.key], value[node.key], node.key);
    const expectedDependencies = node.dependsOn.map((key) => lineageRef(normalized[key]));
    if (entry.artifactId !== node.artifactId || entry.artifactType !== node.artifactType
      || !sameDependencies(entry.dependencies, expectedDependencies)) {
      throw storyPackageError(`剧情 Run 的测试包里 ${node.artifactId} 与依赖图不一致`, "PRODUCTION_PACKAGE_LINEAGE_UNSUPPORTED");
    }
    normalized[node.key] = entry;
  }

  // 剧情与分镜都属于故事位 V1，分镜必须是 4.0。
  if (String(value.fullStory?.selectedVariantId || "") !== STORY_ENTRY_VARIANT_ID) {
    throw storyPackageError(`剧情 Run 的测试包里剧情必须属于故事位 ${STORY_ENTRY_VARIANT_ID}`, "PRODUCTION_PACKAGE_VARIANT_MISMATCH");
  }
  if (hasPlan && (String(value.animationPlan?.selectedVariantId || "") !== STORY_ENTRY_VARIANT_ID
    || value.animationPlan?.promptSchemaVersion !== STORYBOARD_PLAN_VERSION)) {
    throw storyPackageError(`剧情 Run 的测试包里分镜必须是故事位 ${STORY_ENTRY_VARIANT_ID} 的 ${STORYBOARD_PLAN_VERSION} 分镜`, "PRODUCTION_PACKAGE_PLAN_VARIANT_MISMATCH");
  }
  // 只给角色设定：恰好一个候选 V1，且与选中记录完全相同。否则导入后再跑剧情准备会重签选中记录，
  // 把剧情和分镜判成过期（server.js 剧情入口流水线的「内容与依赖都一致才跳过」）。
  if (storyMode === STORY_MODE_CHARACTER_ONLY) {
    const variants = value.themeVariants?.variants;
    if (!Array.isArray(variants) || variants.length !== 1 || String(variants[0]?.id || "") !== STORY_ENTRY_VARIANT_ID
      || String(value.selectedVariant?.id || "") !== STORY_ENTRY_VARIANT_ID
      || contentDigest(variants[0]) !== contentDigest(value.selectedVariant)) {
      throw storyPackageError(`剧情 Run 的测试包里必须恰好一个候选 ${STORY_ENTRY_VARIANT_ID}，且与选中记录相同`, "PRODUCTION_PACKAGE_VARIANT_MISMATCH");
    }
  }
  return { storyMode, storySource, creatorProfile, artifacts: normalized, nodes };
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
