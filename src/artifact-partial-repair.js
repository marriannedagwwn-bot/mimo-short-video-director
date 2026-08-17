import { contentDigest } from "./production-lineage.js";
import { OutputContractError } from "./validation.js";

export const ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION = "artifact_partial_repair/1.0";

// A repair plan is meaningful only with the exact server-owned adapter that
// selected its targets and mutation policy. Keeping that binding private also
// prevents another adapter with the same public id from weakening the merge
// rules after the model response arrives.
const issuedPlanAdapters = new WeakMap();
const dangerousPointerTokens = new Set(["__proto__", "prototype", "constructor"]);
const adapterIdPattern = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u;
const artifactTypePattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u;
const defaultMaximumTargets = 12;
const absoluteMaximumTargets = 32;

/**
 * Create a transient, server-owned repair plan without retaining the complete
 * candidate. The adapter is the only component allowed to decide which
 * diagnostics are trustworthy and which paths may change.
 */
export function createArtifactPartialRepairPlan({
  artifactType,
  candidate,
  diagnostics,
  adapter,
  context = {}
} = {}) {
  const normalizedArtifactType = requireArtifactType(artifactType);
  assertAdapter(adapter);
  const adapterSnapshot = snapshotAdapter(adapter);
  assertPlainJson(candidate, "candidate");
  if (!isRecord(candidate) || !Array.isArray(diagnostics) || !diagnostics.length) return null;

  const selectionInput = Object.freeze({
    artifactType: normalizedArtifactType,
    candidate: readonlyClone(candidate),
    diagnostics: readonlyClone(diagnostics),
    context: readonlyClone(context),
    helpers: adapterHelpers
  });
  const drafts = adapterSnapshot.selectTargets(selectionInput);
  if (drafts === null || drafts === undefined || (Array.isArray(drafts) && !drafts.length)) return null;
  if (!Array.isArray(drafts)) {
    throw new TypeError("局部纠错 adapter.selectTargets 必须返回数组或 null");
  }
  const maximumTargets = normalizeMaximumTargets(adapterSnapshot.maxTargets);
  if (drafts.length > maximumTargets) {
    throw new OutputContractError(`局部纠错目标不能超过 ${maximumTargets} 个`);
  }

  const normalizedTargets = drafts
    .map((draft) => normalizeTargetDraft(candidate, draft))
    .sort((left, right) => comparePointers(left.path, right.path));
  assertTargetsDoNotOverlap(normalizedTargets);

  const targets = normalizedTargets.map((target, index) => ({
    repairId: `R${index + 1}`,
    ...target
  }));
  const authority = typeof adapterSnapshot.buildAuthority === "function"
    ? adapterSnapshot.buildAuthority(Object.freeze({
      artifactType: normalizedArtifactType,
      candidate: readonlyClone(candidate),
      diagnostics: readonlyClone(diagnostics),
      targets: readonlyClone(targets),
      context: readonlyClone(context),
      helpers: adapterHelpers
    }))
    : {};
  assertPlainJson(authority, "adapter authority");

  const plan = deepFreeze({
    schemaVersion: ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
    artifactType: normalizedArtifactType,
    adapterId: adapterSnapshot.id,
    baseDigest: contentDigest(candidate),
    authorityDigest: contentDigest(authority),
    authority: structuredClone(authority),
    targets
  });
  issuedPlanAdapters.set(plan, Object.freeze({
    identity: adapter,
    snapshot: adapterSnapshot
  }));
  return plan;
}

/**
 * Return the only data that should be embedded in a correction prompt. The
 * complete candidate and internal mutation policies are intentionally absent.
 */
export function artifactPartialRepairPromptPayload(plan) {
  assertIssuedPlan(plan);
  return {
    schemaVersion: plan.schemaVersion,
    artifactType: plan.artifactType,
    baseDigest: plan.baseDigest,
    authority: structuredClone(plan.authority),
    targets: plan.targets.map((target) => ({
      repairId: target.repairId,
      targetLabel: target.targetLabel,
      currentValue: structuredClone(target.currentValue),
      diagnostics: structuredClone(target.diagnostics),
      repairInstruction: target.repairInstruction,
      modelContext: structuredClone(target.modelContext)
    }))
  };
}

/**
 * Build a generic prompt around the bounded payload. Artifact-specific rules
 * stay in each target's repairInstruction and modelContext.
 */
export function artifactPartialRepairPrompt(plan, { additionalRules = [] } = {}) {
  const payload = artifactPartialRepairPromptPayload(plan);
  if (!Array.isArray(additionalRules) || additionalRules.some((rule) => typeof rule !== "string")) {
    throw new TypeError("additionalRules 必须是字符串数组");
  }
  const rules = additionalRules.map((rule) => rule.trim()).filter(Boolean);
  return `你现在只执行 ${plan.artifactType} 的有界局部纠错。

ARTIFACT_PARTIAL_REPAIR_V1

服务端已经冻结原候选。你只能根据下方目标、诊断、修复说明和最小权威上下文返回每个目标的完整 replacement；不得重写完整 Artifact，不得新增诊断中没有要求的事实。

局部纠错输入：
${JSON.stringify(payload)}

只返回以下精确 JSON 协议：
{
  "schemaVersion":"${ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION}",
  "baseDigest":"${plan.baseDigest}",
  "repairs":[
    {"repairId":"R1","replacement":null}
  ]
}

要求：
- repairs 必须与 targets 数量和顺序完全一致，每个 repairId 恰好出现一次。
- replacement 是对应目标的完整替换值，不是 JSON Patch。
- 响应不得包含 path、op、reason、diagnostics 或任何额外字段；目标路径只能由服务端 repairId 决定。
- 只能修复明确授权的内容，其余合法事实必须保持不变。
- 只输出一个 JSON 对象，不要 Markdown，不要解释。${rules.length ? `\n- ${rules.join("\n- ")}` : ""}`;
}

/**
 * Atomically apply a model response to a clone, enforce target-local mutation
 * policies, then run the adapter's complete read-only validator. The original
 * candidate is never modified, including on failure.
 */
export function mergeArtifactPartialRepair({
  candidate,
  envelope,
  plan,
  adapter,
  context = {},
  validateMerged
} = {}) {
  assertIssuedPlan(plan);
  const issuedAdapter = issuedPlanAdapters.get(plan);
  if (adapter !== undefined && adapter !== issuedAdapter.identity) {
    throw new OutputContractError("局部纠错 adapter 与服务端签发计划不匹配");
  }
  adapter = issuedAdapter.snapshot;
  assertAdapter(adapter);
  if (validateMerged !== undefined && typeof validateMerged !== "function") {
    throw new TypeError("局部纠错 validateMerged 必须是函数");
  }
  assertPlainJson(candidate, "candidate");
  assertPlainJson(envelope, "artifactPartialRepair");
  assertExactKeys(envelope, ["schemaVersion", "baseDigest", "repairs"], "artifactPartialRepair");
  if (envelope.schemaVersion !== ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION) {
    throw new OutputContractError("局部纠错 schemaVersion 无效");
  }
  if (envelope.baseDigest !== plan.baseDigest || contentDigest(candidate) !== plan.baseDigest) {
    throw new OutputContractError("局部纠错 baseDigest 与冻结候选不一致");
  }
  if (!Array.isArray(envelope.repairs) || envelope.repairs.length !== plan.targets.length) {
    throw new OutputContractError(`局部纠错必须返回 ${plan.targets.length} 个 repairs`);
  }

  if (typeof adapter.validateAuthority === "function") {
    const verdict = adapter.validateAuthority(Object.freeze({
      artifactType: plan.artifactType,
      candidate: readonlyClone(candidate),
      authority: readonlyClone(plan.authority),
      authorityDigest: plan.authorityDigest,
      targets: readonlyClone(plan.targets),
      context: readonlyClone(context),
      helpers: adapterHelpers
    }));
    try {
      assertExplicitHookApproval(verdict, "adapter.validateAuthority");
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new OutputContractError("局部纠错权威上下文已经失效");
    }
  }

  const originalDigest = contentDigest(candidate);
  const merged = structuredClone(candidate);
  envelope.repairs.forEach((repair, index) => {
    assertExactKeys(repair, ["repairId", "replacement"], `artifactPartialRepair.repairs[${index}]`);
    const target = plan.targets[index];
    if (repair.repairId !== target.repairId) {
      throw new OutputContractError(
        `局部纠错 repairs[${index}].repairId 必须等于 ${target.repairId}`
      );
    }
    assertPlainJson(repair.replacement, `artifactPartialRepair.repairs[${index}].replacement`);
    const current = readPointer(merged, target.path);
    if (!current.found || contentDigest(current.value) !== target.currentDigest) {
      throw new OutputContractError(`局部纠错 ${target.repairId} 目标已变化或不存在`);
    }
    const replacement = structuredClone(repair.replacement);
    if (!target.allowedReplacementKinds.includes(jsonKind(replacement))) {
      throw new OutputContractError(
        `局部纠错 ${target.repairId} replacement 类型必须为 ${target.allowedReplacementKinds.join("、")}`
      );
    }
    assertMutationWithinPointers(
      current.value,
      replacement,
      target.path,
      target.mutablePointers,
      target.repairId
    );
    if (typeof adapter.authorizeReplacement === "function") {
      const verdict = adapter.authorizeReplacement(Object.freeze({
        artifactType: plan.artifactType,
        candidate: readonlyClone(candidate),
        target: readonlyClone(target),
        currentValue: readonlyClone(current.value),
        replacement: readonlyClone(replacement),
        authority: readonlyClone(plan.authority),
        context: readonlyClone(context),
        helpers: adapterHelpers
      }));
      try {
        assertExplicitHookApproval(verdict, "adapter.authorizeReplacement");
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new OutputContractError(`局部纠错 ${target.repairId} replacement 未通过专用授权`);
      }
    }
    replacePointer(merged, target.path, replacement);
  });

  assertOutsideTargetsUnchanged(candidate, merged, plan.targets);
  if (contentDigest(candidate) !== originalDigest) {
    throw new OutputContractError("局部纠错过程中原候选被意外修改");
  }
  runCompleteValidator(merged, adapter, plan, context, validateMerged);
  return merged;
}

export function canonicalArtifactRepairPointer(value) {
  const pointer = String(value || "");
  if (!pointer.startsWith("/") || pointer === "/" || pointer.endsWith("/")) {
    throw new OutputContractError("局部纠错 JSON Pointer 必须指向非根目标");
  }
  const tokens = pointerTokens(pointer);
  if (!tokens.length || tokens.some((token) => token === "")) {
    throw new OutputContractError("局部纠错 JSON Pointer 包含空 token");
  }
  return pointerFromTokens(tokens);
}

export function readArtifactRepairPointer(root, pointer) {
  const result = readPointer(root, canonicalArtifactRepairPointer(pointer));
  return result.found
    ? { found: true, value: structuredClone(result.value) }
    : { found: false, value: undefined };
}

const adapterHelpers = Object.freeze({
  canonicalPointer: canonicalArtifactRepairPointer,
  readPointer: readArtifactRepairPointer,
  contentDigest
});

function normalizeTargetDraft(candidate, draft) {
  if (!isRecord(draft)) throw new TypeError("局部纠错 target 必须是对象");
  const path = canonicalArtifactRepairPointer(draft.path);
  const current = readPointer(candidate, path);
  if (!current.found) throw new OutputContractError(`局部纠错目标不存在：${path}`);
  if (!Array.isArray(draft.mutablePointers) || !draft.mutablePointers.length) {
    throw new OutputContractError(`局部纠错目标 ${path} 缺少 mutablePointers`);
  }
  const mutablePointers = uniqueSortedPointers(draft.mutablePointers.map((pointer) => {
    const canonical = canonicalArtifactRepairPointer(pointer);
    if (!pointerBelongsToRoot(canonical, path)) {
      throw new OutputContractError(`局部纠错可变路径 ${canonical} 不属于目标 ${path}`);
    }
    assertPointerParentReachable(candidate, canonical, path);
    return canonical;
  }));
  if (!Array.isArray(draft.diagnostics) || !draft.diagnostics.length) {
    throw new OutputContractError(`局部纠错目标 ${path} 缺少结构化 diagnostics`);
  }
  const repairInstruction = String(draft.repairInstruction || "").trim();
  if (!repairInstruction) {
    throw new OutputContractError(`局部纠错目标 ${path} 缺少 repairInstruction`);
  }
  const targetLabel = String(draft.targetLabel || "").trim() || path;
  const allowedReplacementKinds = normalizeAllowedKinds(
    draft.allowedReplacementKinds,
    jsonKind(current.value)
  );
  const modelContext = draft.modelContext === undefined ? {} : draft.modelContext;
  const adapterState = draft.adapterState === undefined ? {} : draft.adapterState;
  assertPlainJson(draft.diagnostics, `局部纠错目标 ${path} diagnostics`);
  assertPlainJson(modelContext, `局部纠错目标 ${path} modelContext`);
  assertPlainJson(adapterState, `局部纠错目标 ${path} adapterState`);
  return {
    path,
    targetLabel,
    currentValue: structuredClone(current.value),
    currentDigest: contentDigest(current.value),
    diagnostics: structuredClone(draft.diagnostics),
    mutablePointers,
    allowedReplacementKinds,
    repairInstruction,
    modelContext: structuredClone(modelContext),
    adapterState: structuredClone(adapterState)
  };
}

function normalizeAllowedKinds(value, fallback) {
  const allowedKinds = ["null", "array", "object", "string", "number", "boolean"];
  if (value === undefined) return [fallback];
  if (!Array.isArray(value) || !value.length) {
    throw new OutputContractError("allowedReplacementKinds 必须是非空数组");
  }
  const normalized = [...new Set(value.map((item) => String(item || "")))];
  if (normalized.some((item) => !allowedKinds.includes(item))) {
    throw new OutputContractError("allowedReplacementKinds 包含无效 JSON 类型");
  }
  return normalized.sort();
}

function normalizeMaximumTargets(value) {
  if (value === undefined) return defaultMaximumTargets;
  if (!Number.isInteger(value) || value < 1 || value > absoluteMaximumTargets) {
    throw new TypeError(`adapter.maxTargets 必须是 1-${absoluteMaximumTargets} 的整数`);
  }
  return value;
}

function assertAdapter(adapter) {
  if (!isRecord(adapter) || !adapterIdPattern.test(String(adapter.id || ""))) {
    throw new TypeError("局部纠错 adapter.id 无效");
  }
  if (typeof adapter.selectTargets !== "function") {
    throw new TypeError("局部纠错 adapter.selectTargets 必须是函数");
  }
  if (typeof adapter.validateMerged !== "function") {
    throw new TypeError("局部纠错 adapter.validateMerged 必须是函数");
  }
}

function snapshotAdapter(adapter) {
  return Object.freeze({
    id: adapter.id,
    maxTargets: adapter.maxTargets,
    selectTargets: adapter.selectTargets,
    buildAuthority: adapter.buildAuthority,
    validateAuthority: adapter.validateAuthority,
    authorizeReplacement: adapter.authorizeReplacement,
    validateMerged: adapter.validateMerged
  });
}

function requireArtifactType(value) {
  const normalized = String(value || "").trim();
  if (!artifactTypePattern.test(normalized)) throw new TypeError("局部纠错 artifactType 无效");
  return normalized;
}

function assertIssuedPlan(plan) {
  if (!isRecord(plan) || !issuedPlanAdapters.has(plan)) {
    throw new OutputContractError("局部纠错计划不是当前服务端签发对象");
  }
}

function assertTargetsDoNotOverlap(targets) {
  for (let index = 0; index < targets.length; index += 1) {
    for (let other = index + 1; other < targets.length; other += 1) {
      if (pointerBelongsToRoot(targets[other].path, targets[index].path)) {
        throw new OutputContractError(
          `局部纠错目标不能重复或重叠：${targets[index].path} 与 ${targets[other].path}`
        );
      }
    }
  }
}

function assertPointerParentReachable(candidate, pointer, targetRoot) {
  if (pointer === targetRoot) return;
  const tokens = pointerTokens(pointer);
  let current = candidate;
  for (const token of tokens.slice(0, -1)) {
    if (!isContainer(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new OutputContractError(`局部纠错可变路径的父级不存在：${pointer}`);
    }
    if (Array.isArray(current) && !isArrayIndex(token)) {
      throw new OutputContractError(`局部纠错数组路径索引无效：${pointer}`);
    }
    current = current[token];
  }
}

function assertMutationWithinPointers(current, replacement, rootPath, mutablePointers, repairId) {
  const changes = collectChangedPointers(current, replacement, rootPath);
  const unauthorized = changes.find((change) => !mutablePointers.some((mutable) => (
    pointerBelongsToRoot(change, mutable)
  )));
  if (unauthorized) {
    throw new OutputContractError(`局部纠错 ${repairId} 越权改变未授权路径 ${unauthorized}`);
  }
}

function collectChangedPointers(previous, next, path) {
  if (contentDigest(previous) === contentDigest(next)) return [];
  if (jsonKind(previous) !== jsonKind(next) || !isContainer(previous) || !isContainer(next)) {
    return [path];
  }
  if (Array.isArray(previous) !== Array.isArray(next)) return [path];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changes = [];
  for (const key of [...keys].sort(comparePropertyKeys)) {
    const childPath = `${path}/${encodePointerToken(key)}`;
    const hadPrevious = Object.prototype.hasOwnProperty.call(previous, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);
    if (!hadPrevious || !hasNext) {
      changes.push(childPath);
      continue;
    }
    changes.push(...collectChangedPointers(previous[key], next[key], childPath));
  }
  return changes;
}

function assertOutsideTargetsUnchanged(original, merged, targets) {
  const originalMasked = structuredClone(original);
  const mergedMasked = structuredClone(merged);
  targets.forEach((target) => {
    replacePointer(originalMasked, target.path, `__ARTIFACT_REPAIR_TARGET_${target.repairId}__`);
    replacePointer(mergedMasked, target.path, `__ARTIFACT_REPAIR_TARGET_${target.repairId}__`);
  });
  if (contentDigest(originalMasked) !== contentDigest(mergedMasked)) {
    throw new OutputContractError("局部纠错改变了目标外数据");
  }
}

function runCompleteValidator(merged, adapter, plan, context, validateMerged) {
  runOneCompleteValidator(merged, adapter.validateMerged, adapter, plan, context);
  if (validateMerged && validateMerged !== adapter.validateMerged) {
    runOneCompleteValidator(merged, validateMerged, adapter, plan, context);
  }
}

function runOneCompleteValidator(merged, completeValidator, adapter, plan, context) {
  const validationCandidate = structuredClone(merged);
  const beforeDigest = contentDigest(validationCandidate);
  const result = completeValidator(Object.freeze({
    artifactType: plan.artifactType,
    candidate: validationCandidate,
    authority: readonlyClone(plan.authority),
    targets: readonlyClone(plan.targets),
    context: readonlyClone(context),
    helpers: adapterHelpers
  }));
  if (result && typeof result.then === "function") {
    throw new TypeError("adapter.validateMerged 必须是同步只读函数");
  }
  if (contentDigest(validationCandidate) !== beforeDigest) {
    throw new OutputContractError("局部纠错完整 validator 必须只读，不能修改候选");
  }
  if (result === true) return;
  if (isContainer(result)) {
    if (contentDigest(result) !== beforeDigest) {
      throw new OutputContractError("局部纠错完整 validator 不得返回改写后的候选");
    }
    return;
  }
  throw new OutputContractError("局部纠错完整 validator 必须显式返回 true 或等值候选");
}

function assertExplicitHookApproval(value, hookName) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${hookName} 必须是同步只读函数`);
  }
  if (value !== true) {
    throw new OutputContractError(`${hookName} 必须显式返回 true`);
  }
}

function readPointer(root, pointer) {
  let current = root;
  for (const token of pointerTokens(pointer)) {
    if (!isContainer(current)) return { found: false, value: undefined };
    if (Array.isArray(current) && !isArrayIndex(token)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false, value: undefined };
    current = current[token];
  }
  return { found: true, value: current };
}

function replacePointer(root, pointer, replacement) {
  const tokens = pointerTokens(pointer);
  const leaf = tokens.pop();
  let parent = root;
  for (const token of tokens) {
    if (!isContainer(parent) || !Object.prototype.hasOwnProperty.call(parent, token)) {
      throw new OutputContractError(`局部纠错路径不存在：${pointer}`);
    }
    if (Array.isArray(parent) && !isArrayIndex(token)) {
      throw new OutputContractError(`局部纠错数组路径索引无效：${pointer}`);
    }
    parent = parent[token];
  }
  if (!isContainer(parent) || !Object.prototype.hasOwnProperty.call(parent, leaf)) {
    throw new OutputContractError(`局部纠错目标不存在：${pointer}`);
  }
  if (Array.isArray(parent) && !isArrayIndex(leaf)) {
    throw new OutputContractError(`局部纠错数组路径索引无效：${pointer}`);
  }
  parent[leaf] = replacement;
}

function pointerTokens(pointer) {
  if (!String(pointer).startsWith("/")) throw new OutputContractError("非法 JSON Pointer");
  return String(pointer).slice(1).split("/").map((token) => {
    if (/~(?![01])/u.test(token)) throw new OutputContractError("非法 JSON Pointer 转义");
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (dangerousPointerTokens.has(decoded)) {
      throw new OutputContractError("JSON Pointer 包含危险 token");
    }
    return decoded;
  });
}

function pointerFromTokens(tokens) {
  return `/${tokens.map(encodePointerToken).join("/")}`;
}

function encodePointerToken(token) {
  return String(token).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerBelongsToRoot(pointer, root) {
  return pointer === root || pointer.startsWith(`${root}/`);
}

function uniqueSortedPointers(pointers) {
  return [...new Set(pointers)].sort(comparePointers);
}

function comparePointers(left, right) {
  const leftTokens = pointerTokens(left);
  const rightTokens = pointerTokens(right);
  const maximum = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < maximum; index += 1) {
    if (leftTokens[index] === undefined) return -1;
    if (rightTokens[index] === undefined) return 1;
    const comparison = comparePropertyKeys(leftTokens[index], rightTokens[index]);
    if (comparison) return comparison;
  }
  return 0;
}

function comparePropertyKeys(left, right) {
  if (isArrayIndex(left) && isArrayIndex(right)) return Number(left) - Number(right);
  return String(left).localeCompare(String(right), "en");
}

function isArrayIndex(value) {
  return /^(?:0|[1-9]\d*)$/u.test(String(value || ""));
}

function assertExactKeys(value, keys, path) {
  if (!isRecord(value)) throw new OutputContractError(`${path} 必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OutputContractError(`${path} 只允许字段 ${keys.join("、")}`);
  }
}

function assertPlainJson(value, path, seen = new WeakSet()) {
  const kind = jsonKind(value);
  if (["string", "boolean", "null"].includes(kind)) return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new OutputContractError(`${path} 包含非有限数字`);
    return;
  }
  if (kind === "invalid") throw new OutputContractError(`${path} 不是合法 JSON 值`);
  if (seen.has(value)) throw new OutputContractError(`${path} 包含循环引用`);
  seen.add(value);
  if (kind === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OutputContractError(`${path} 必须是普通 JSON 对象`);
    }
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new OutputContractError(`${path} 包含 JSON 不支持的 Symbol 字段`);
  }
  if (kind === "array") {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
        throw new OutputContractError(`${path} 包含稀疏数组项`);
      }
    }
  }
  for (const key of ownKeys) {
    if (kind === "array" && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new OutputContractError(`${path} 包含非 JSON 数据属性 ${key}`);
    }
    if (kind === "array" && (!isArrayIndex(key) || Number(key) >= value.length)) {
      throw new OutputContractError(`${path} 数组包含非索引字段 ${key}`);
    }
    if (dangerousPointerTokens.has(key)) throw new OutputContractError(`${path} 包含危险字段 ${key}`);
    assertPlainJson(value[key], `${path}/${encodePointerToken(key)}`, seen);
  }
  seen.delete(value);
}

function jsonKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value;
  return "invalid";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isContainer(value) {
  return Boolean(value) && typeof value === "object";
}

function readonlyClone(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!isContainer(value) || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}
