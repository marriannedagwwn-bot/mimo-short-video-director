import { ModelResponseError } from "./mimo-client.js";
import {
  STATIC_FRAME_INVISIBLE_INTENT_TERMS,
  STATIC_FRAME_PROCESS_OR_AUDIO_TERMS
} from "./validation.js";

export const STATIC_FRAME_COMPILER_VERSION = "1.0";
export const STATIC_FRAME_COMPILER_REASON_CODES = Object.freeze([
  "narrative_cognition",
  "psychological_activity",
  "future_intent",
  "goal_stage",
  "ambiguous_nonvisual",
  "temporal_process"
]);

const REASON_CODE_SET = new Set(STATIC_FRAME_COMPILER_REASON_CODES);
const TARGET_FIELDS = new Set(["pose", "handPropState", "actionState"]);
const PATCH_KEYS = Object.freeze([
  "path",
  "value",
  "reasonCode",
  "triggerSpans",
  "visibleFacts"
]);
const PATH_PATTERN = /^animationShotBatch\.shotPlan\[(\d+)\]\.(startFrame|endFrame)\.characters\[(\d+)\]\.(pose|handPropState|actionState)$/u;

const REASON_TRIGGER_PATTERNS = Object.freeze({
  narrative_cognition: /发现|意识到|知道|明白|认出|想起|回忆|察觉|理解|确认|判断出/u,
  psychological_activity: /决定|希望|担心|害怕|期待|犹豫|想要|(?<![理思设幻])想(?![象法])|试图|打算|计划|愿意|内心|心里/u,
  future_intent: /准备|即将|将要|想要|试图|打算|计划|马上会|下一步/u,
  goal_stage: /为了|以便|目标|目的|准备|阶段|接下来|下一步|完成后|成功后/u,
  ambiguous_nonvisual: /似乎|仿佛|好像|意图|目的|念头|意识|认知|心理|情绪变化|做出反应|镜头移动|运镜|对白|音效/u,
  temporal_process: /逐渐|随后|然后|正在|开始|继续|慢慢|逐步|过程中|一边.+一边|先.+再/u
});

const POSE_DIMENSION_PATTERNS = Object.freeze({
  body: /坐|站|蹲|跪|躺|趴|俯身|前倾|后仰|弯腰|挺直|躯干|身体|重心/u,
  limbs: /手|掌|指|腕|臂|肘|肩|腿|膝|脚|足|前肢|后肢|翅膀|爪/u,
  gaze: /视线|目光|注视|看向|望向|凝视|头部|低头|抬头/u,
  orientation: /朝向|面向|背对|侧身|转向|正对|偏向/u,
  contact: /接触|贴在|放在|落在|停留|握住|扶住|托住|按在|悬停|距离|两侧|表面/u
});

const SYSTEM_PROMPT = `你是 Static Frame Compiler，只负责把不符合静态帧契约的叙事语言转换为单帧可直接观察的视觉状态。

你不做业务决策，不改剧情，不创作新动作，不优化文风，不润色，不扩写合格字段。
若所有允许字段均已合格，必须原样 no-op，只返回 {"patches":[]}。
只输出一个严格 JSON 对象，不要 Markdown，不要解释。`;

export class StaticFrameCompilerError extends Error {
  constructor(message, { category = "compiler", metadata = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "StaticFrameCompilerError";
    this.category = category;
    this.metadata = metadata;
    this.details = { category, metadata };
  }
}

export class StaticFrameCompilerProtocolError extends StaticFrameCompilerError {
  constructor(message, options = {}) {
    super(message, { ...options, category: "protocol" });
    this.name = "StaticFrameCompilerProtocolError";
  }
}

export class StaticFrameCompilerTransportError extends StaticFrameCompilerError {
  constructor(message, { classification = "transport", ...options } = {}) {
    super(message, { ...options, category: classification });
    this.name = "StaticFrameCompilerTransportError";
    this.classification = classification;
  }
}

export class StaticFrameCompilerConfigError extends StaticFrameCompilerError {
  constructor(message, options = {}) {
    super(message, { ...options, category: "config" });
    this.name = "StaticFrameCompilerConfigError";
  }
}

/**
 * Compile narrative character endpoint fields into directly observable static facts.
 *
 * The supplied client must expose generateJson(). Client-level JSON retries are
 * explicitly disabled. This function owns exactly two protocol attempts, and
 * each protocol attempt owns at most one transient transport retry.
 */
export async function compileStaticFrames({
  candidate,
  client,
  provider = null,
  model,
  maxCompletionTokens = 4096,
  timeoutMs = 300_000,
  batchIndex = 0,
  phase = "post-generate"
} = {}) {
  validateCompilerConfiguration({ candidate, client, model, maxCompletionTokens, timeoutMs });

  const sourceCandidate = structuredClone(candidate);
  const targets = collectStaticFrameTargets(sourceCandidate);
  const basePrompt = buildStaticFrameCompilerPrompt(sourceCandidate, targets);
  const metadata = createRunMetadata({
    provider: provider || inferProvider(client),
    model,
    batchIndex,
    phase
  });
  let protocolDiagnostic = "";

  for (let protocolAttempt = 1; protocolAttempt <= 2; protocolAttempt += 1) {
    const protocolLog = {
      protocolAttempt,
      transportAttempts: [],
      errorClassification: null,
      retryDecision: "none",
      finalResult: "pending"
    };
    metadata.protocolAttempts.push(protocolLog);
    const prompt = protocolAttempt === 1
      ? basePrompt
      : buildProtocolRetryPrompt(basePrompt, protocolDiagnostic);

    let response;
    try {
      response = await requestWithTransportRetry({
        client,
        prompt,
        model,
        maxCompletionTokens,
        timeoutMs,
        protocolLog
      });
    } catch (error) {
      if (error instanceof StaticFrameCompilerProtocolError) {
        protocolDiagnostic = error.message;
        protocolLog.errorClassification = "protocol";
        protocolLog.retryDecision = protocolAttempt < 2 ? "retry" : "fail";
        protocolLog.finalResult = "protocol-error";
        protocolLog.protocolError = protocolDiagnostic;
        if (protocolAttempt < 2) continue;
        metadata.requestCount = countTransportAttempts(metadata);
        metadata.finalResult = "failed";
        throw new StaticFrameCompilerProtocolError(
          `Static Frame Compiler 两次 protocol attempt 均失败：${protocolDiagnostic}`,
          { metadata, cause: error }
        );
      }
      metadata.requestCount = countTransportAttempts(metadata);
      metadata.finalResult = "failed";
      if (error instanceof StaticFrameCompilerTransportError) {
        error.metadata = metadata;
        error.details = { category: error.category, metadata };
      }
      throw error;
    }

    try {
      const validatedPatches = validateStaticFrameCompilerResponse(response, {
        candidate: sourceCandidate,
        targets
      });
      const compiledCandidate = applyStaticFrameCompilerPatches(sourceCandidate, validatedPatches, targets);
      metadata.noOp = validatedPatches.length === 0;
      metadata.modifications.push(...validatedPatches.map((patch) => ({
        protocolAttempt,
        path: patch.path,
        before: targets.get(patch.path).before,
        after: patch.value,
        reasonCode: patch.reasonCode,
        triggerSpans: [...patch.triggerSpans],
        visibleFacts: [...patch.visibleFacts],
        applied: true,
        finalAccepted: false
      })));
      metadata.requestCount = countTransportAttempts(metadata);
      metadata.finalResult = "accepted";
      protocolLog.finalResult = "accepted";
      return { compiledCandidate, metadata };
    } catch (error) {
      const protocolError = asProtocolError(error);
      protocolDiagnostic = protocolError.message;
      protocolLog.errorClassification = "protocol";
      protocolLog.retryDecision = protocolAttempt < 2 ? "retry" : "fail";
      protocolLog.finalResult = "protocol-error";
      protocolLog.protocolError = protocolDiagnostic;
      metadata.modifications.push(...rejectedPatchMetadata(response, targets, protocolAttempt));
      if (protocolAttempt < 2) continue;
      metadata.requestCount = countTransportAttempts(metadata);
      metadata.finalResult = "failed";
      throw new StaticFrameCompilerProtocolError(
        `Static Frame Compiler 两次 protocol attempt 均失败：${protocolDiagnostic}`,
        { metadata, cause: protocolError }
      );
    }
  }

  metadata.requestCount = countTransportAttempts(metadata);
  metadata.finalResult = "failed";
  throw new StaticFrameCompilerProtocolError("Static Frame Compiler 超过 protocol attempt 预算", { metadata });
}

export function buildStaticFrameCompilerPrompt(candidate, suppliedTargets = null) {
  const targets = suppliedTargets instanceof Map
    ? suppliedTargets
    : collectStaticFrameTargets(candidate);
  const allowedPaths = [...targets.values()].map(({ path, field, before }) => ({
    path,
    field,
    before,
    patchEligibility: containsStaticFrameViolation(before)
      ? "compiler-review"
      : "must-no-op",
    requiredTriggerEvidence: firstStaticFrameViolation(before) || null
  }));
  const projectedCandidate = projectCompilerContext(candidate);

  return `STATIC_FRAME_COMPILER_V1

目标：
- 只把叙事、心理、未来意图、时间推进或无法直接观察的语言，转换为当前单帧已经存在的可见状态。
- 合格字段必须保持逐字不变，并从 patches 省略。若全部合格，返回 {"patches":[]}。
- 禁止风格优化、文学润色、同义改写、丰富细节或重新创作。
- 不得新增输入中不存在的角色、道具、接触关系或环境事实。

字段职责：
- pose：身体、四肢、朝向、重心、头部和视线姿态。修改 pose 时 visibleFacts 至少给出两个不同可观察维度。
- handPropState：手与道具的接触、握持、距离和道具当前可见状态。
- actionState：只描述当前画面已经发生且可观察的动作结果。允许“右手停留在按钮表面”；禁止“正在按下按钮”“即将按下按钮”“准备按按钮”。
- 字段是否允许空值沿用输入契约；不得为了填空而虚构事实。

输出协议：
{
  "patches": [
    {
      "path": "必须逐字取自允许路径",
      "value": "转换后的完整字段字符串",
      "reasonCode": "六种允许代码之一",
      "triggerSpans": ["从 before 逐字复制的连续问题片段"],
      "visibleFacts": ["从 value 逐字复制的连续可见事实片段"]
    }
  ]
}

reasonCode 仅允许：
${JSON.stringify(STATIC_FRAME_COMPILER_REASON_CODES)}

reasonCode 与 triggerSpans 的对应关系：
- narrative_cognition：发现、意识到、知道、明白、认出、想起、回忆、察觉、理解、确认、判断出。
- psychological_activity：决定、希望、担心、害怕、期待、犹豫、想要、试图、打算、计划、内心、心里。
- future_intent：准备、即将、将要、想要、试图、打算、计划、马上会、下一步。
- goal_stage：为了、以便、目标、目的、准备、阶段、接下来、下一步、完成后、成功后。
- ambiguous_nonvisual：似乎、仿佛、好像、意图、目的、念头、意识、认知、心理、情绪变化、做出反应。
- temporal_process：逐渐、随后、然后、正在、开始、继续、慢慢、逐步、过程中、“一边…一边…”、“先…再…”。

强约束：
- 顶层只能有 patches；每个 patch 只能有 path、value、reasonCode、triggerSpans、visibleFacts。
- path 不得重复，不得修改允许路径以外的字段。
- patchEligibility 为 "must-no-op" 的字段已明确满足静态帧契约，必须逐字保留并从 patches 省略；不得用其他 reasonCode 改写。
- patchEligibility 为 "compiler-review" 时，requiredTriggerEvidence 给出 before 中一个可逐字复制的明确违规证据；至少一个 triggerSpan 必须包含该证据或 before 中另一处明确的非静态意图/过程证据。
- 每条 patch 只选择一个可由 triggerSpans 直接证明的 reasonCode。
- triggerSpans 必须指出真实问题；无法给出 triggerSpans 就不得修改。每组相邻 span 必须共同构成包含对应 reasonCode 的连续问题表达；不含问题词的片段只有在与问题片段直接相邻、共同组成该表达时才可保留。
- 禁止把与问题表达不连续的角色名、道具名、正常动作或其他上下文单独列为 span。
- triggerSpans 应使用能证明问题的最小连续片段，通常只需要一个。只有 before 中存在多个彼此独立、且都匹配同一 reasonCode 的问题片段时才可给多个。
- visibleFacts 与 triggerSpans 都必须逐字连续、去重、互不重叠，禁止用包含片段凑数量。
- 禁止只删除“准备、即将、正在”等词后保留动作短语；必须改成单帧可观察状态。
- 输出会被原子应用；任一 patch 不合法会使整次输出失败。

协议示例：
- before 为“女孩准备打开八音盒”时，可使用 reasonCode "future_intent"、triggerSpans ["准备打开"]，value 可为“女孩坐在桌前，身体微微前倾，双手放在八音盒盖子两侧，视线落在八音盒上”，visibleFacts 可为 ["身体微微前倾","双手放在八音盒盖子两侧","视线落在八音盒上"]。
- 不得把“女孩”“八音盒”或“打开”各自作为额外 triggerSpan；它们本身不能证明 future_intent。
- 已满足静态帧契约的字段不得 patch；全部合格时只返回 {"patches":[]}。

允许路径与原值：
${JSON.stringify(allowedPaths)}

去除 alias 后的结构化 batch 上下文：
${JSON.stringify(projectedCandidate)}`;
}

export function validateStaticFrameCompilerResponse(
  response,
  { candidate, targets: suppliedTargets = null } = {}
) {
  if (!isRecord(response)) {
    throw new StaticFrameCompilerProtocolError("Compiler 输出必须是 JSON 对象");
  }
  requireExactKeys(response, ["patches"], "Compiler 输出顶层");
  if (!Array.isArray(response.patches)) {
    throw new StaticFrameCompilerProtocolError("Compiler 输出 patches 必须是数组");
  }
  if (!isRecord(candidate)) {
    throw new StaticFrameCompilerProtocolError("缺少用于校验 patch 的 animationShotBatch");
  }

  const targets = suppliedTargets instanceof Map
    ? suppliedTargets
    : collectStaticFrameTargets(candidate);
  const seenPaths = new Set();
  const patches = response.patches.map((patch, index) => {
    const patchPath = `patches[${index}]`;
    if (!isRecord(patch)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath} 必须是对象`);
    }
    requireExactKeys(patch, PATCH_KEYS, patchPath);
    if (typeof patch.path !== "string" || !targets.has(patch.path)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.path 不在允许路径白名单中：${String(patch.path || "空")}`);
    }
    if (!PATH_PATTERN.test(patch.path)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.path 不是受支持的静态字段路径`);
    }
    if (seenPaths.has(patch.path)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.path 重复：${patch.path}`);
    }
    seenPaths.add(patch.path);

    const target = targets.get(patch.path);
    if (!TARGET_FIELDS.has(target.field)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.path 试图修改非静态目标字段`);
    }
    if (typeof patch.value !== "string") {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.value 必须是字符串`);
    }
    if (patch.value === target.before) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.value 与 before 完全相同，无需 patch`);
    }
    if (target.field !== "actionState" && patch.value.trim() === "") {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.value 违反现有 ${target.field} 非空契约`);
    }
    if (!REASON_CODE_SET.has(patch.reasonCode)) {
      throw new StaticFrameCompilerProtocolError(`${patchPath}.reasonCode 无效`);
    }
    if (!containsStaticFrameViolation(target.before)) {
      throw new StaticFrameCompilerProtocolError(
        `${patchPath} path=${JSON.stringify(patch.path)} before=${JSON.stringify(target.before)} 已明确满足静态帧契约，必须从 patches 省略，禁止润色式 patch`
      );
    }
    validateEvidenceSpans(patch.triggerSpans, target.before, `${patchPath}.triggerSpans`, {
      requireAtLeastOne: true
    });
    if (!patch.triggerSpans.some((span) => containsStaticFrameViolation(span))) {
      throw new StaticFrameCompilerProtocolError(
        `${patchPath}.triggerSpans 必须至少有一个片段包含 before 中的明确静态帧违规表达，例如 ${JSON.stringify(firstStaticFrameViolation(target.before))}`
      );
    }
    validateEvidenceSpans(patch.visibleFacts, patch.value, `${patchPath}.visibleFacts`, {
      requireAtLeastOne: patch.value.trim() !== ""
    });
    validateCompiledValue(patch, target, patchPath);
    return {
      path: patch.path,
      value: patch.value,
      reasonCode: patch.reasonCode,
      triggerSpans: [...patch.triggerSpans],
      visibleFacts: [...patch.visibleFacts]
    };
  });

  const knownInvalidPaths = [...targets.values()]
    .filter((target) => containsStaticFrameViolation(target.before))
    .map((target) => target.path);
  const omittedInvalidPath = knownInvalidPaths.find((path) => !seenPaths.has(path));
  if (omittedInvalidPath) {
    throw new StaticFrameCompilerProtocolError(
      `Compiler 遗漏了含明确静态帧违规表达的字段：${omittedInvalidPath}`
    );
  }

  return patches;
}

export function applyStaticFrameCompilerPatches(candidate, patches, suppliedTargets = null) {
  const targets = suppliedTargets instanceof Map
    ? suppliedTargets
    : collectStaticFrameTargets(candidate);
  const compiled = structuredClone(candidate);

  // Validation above completes before this loop, so application is atomic.
  for (const patch of patches) {
    const target = targets.get(patch.path);
    if (!target) {
      throw new StaticFrameCompilerProtocolError(`patch path 不在允许路径白名单中：${patch.path}`);
    }
    const parsed = patch.path.match(PATH_PATTERN);
    if (!parsed) {
      throw new StaticFrameCompilerProtocolError(`patch path 格式无效：${patch.path}`);
    }
    const shotIndex = Number(parsed[1]);
    const frameKind = parsed[2];
    const characterIndex = Number(parsed[3]);
    const field = parsed[4];
    const character = compiled.shotPlan?.[shotIndex]?.[frameKind]?.characters?.[characterIndex];
    if (!isRecord(character) || !Object.hasOwn(character, field)) {
      throw new StaticFrameCompilerProtocolError(`patch path 在候选中不存在：${patch.path}`);
    }
    character[field] = patch.value;
  }
  return compiled;
}

export function collectStaticFrameTargets(candidate) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new StaticFrameCompilerConfigError("animationShotBatch 必须包含 shotPlan 数组");
  }
  const targets = new Map();
  candidate.shotPlan.forEach((shot, shotIndex) => {
    for (const frameKind of ["startFrame", "endFrame"]) {
      const characters = shot?.[frameKind]?.characters;
      if (!Array.isArray(characters)) continue;
      characters.forEach((character, characterIndex) => {
        if (!isRecord(character)) return;
        for (const field of TARGET_FIELDS) {
          if (!Object.hasOwn(character, field) || typeof character[field] !== "string") continue;
          const path = `animationShotBatch.shotPlan[${shotIndex}].${frameKind}.characters[${characterIndex}].${field}`;
          targets.set(path, {
            path,
            field,
            before: character[field],
            shotIndex,
            frameKind,
            characterIndex
          });
        }
      });
    }
  });
  return targets;
}

function validateCompilerConfiguration({ candidate, client, model, maxCompletionTokens, timeoutMs }) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new StaticFrameCompilerConfigError("Static Frame Compiler 缺少有效 animationShotBatch");
  }
  if (!client || typeof client.generateJson !== "function") {
    throw new StaticFrameCompilerConfigError("Static Frame Compiler client 必须实现 generateJson");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_MODEL 必须显式配置");
  }
  if (!Number.isFinite(Number(maxCompletionTokens)) || Number(maxCompletionTokens) <= 0) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS 必须为正数");
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    throw new StaticFrameCompilerConfigError("STATIC_FRAME_COMPILER_TIMEOUT_MS 必须为正数");
  }
}

async function requestWithTransportRetry({
  client,
  prompt,
  model,
  maxCompletionTokens,
  timeoutMs,
  protocolLog
}) {
  for (let transportAttempt = 1; transportAttempt <= 2; transportAttempt += 1) {
    const transportLog = {
      transportAttempt,
      errorClassification: null,
      retryDecision: "none",
      finalResult: "pending"
    };
    protocolLog.transportAttempts.push(transportLog);
    try {
      const response = await client.generateJson({
        prompt,
        model,
        maxCompletionTokens,
        systemPrompt: SYSTEM_PROMPT,
        requestTimeoutMs: timeoutMs,
        jsonRetryAttempts: 0,
        strictJson: true
      });
      transportLog.finalResult = "response";
      return response;
    } catch (error) {
      if (isModelJsonProtocolError(error)) {
        transportLog.errorClassification = "protocol";
        transportLog.retryDecision = "none";
        transportLog.finalResult = "error";
        throw new StaticFrameCompilerProtocolError(
          `模型返回 JSON 无法解析：${String(error?.message || error)}`,
          { cause: error }
        );
      }

      const classification = classifyTransportError(error);
      const transient = isTransientTransportError(error, classification);
      transportLog.errorClassification = classification;
      transportLog.retryDecision = transient && transportAttempt === 1 ? "retry" : "fail";
      transportLog.finalResult = "error";
      if (transient && transportAttempt === 1) continue;
      protocolLog.finalResult = "transport-error";
      protocolLog.errorClassification = classification;
      protocolLog.retryDecision = "fail";
      throw new StaticFrameCompilerTransportError(
        `Static Frame Compiler ${classification} 失败：${String(error?.message || error)}`,
        { classification, cause: error }
      );
    }
  }
  throw new StaticFrameCompilerTransportError(
    "Static Frame Compiler 超过单次 protocol attempt 的 transport retry 预算"
  );
}

function validateEvidenceSpans(spans, source, path, { requireAtLeastOne = false } = {}) {
  if (!Array.isArray(spans)) {
    throw new StaticFrameCompilerProtocolError(`${path} 必须是数组`);
  }
  if (requireAtLeastOne && spans.length === 0) {
    throw new StaticFrameCompilerProtocolError(`${path} 至少需要一个连续证据片段`);
  }
  const seen = new Set();
  spans.forEach((span, index) => {
    if (typeof span !== "string" || !span || span.trim() !== span) {
      throw new StaticFrameCompilerProtocolError(`${path}[${index}] 必须是非空且无首尾空白的字符串`);
    }
    if (seen.has(span)) {
      throw new StaticFrameCompilerProtocolError(`${path} 不得包含重复证据片段：${span}`);
    }
    seen.add(span);
  });
  for (let left = 0; left < spans.length; left += 1) {
    for (let right = left + 1; right < spans.length; right += 1) {
      if (spans[left].includes(spans[right]) || spans[right].includes(spans[left])) {
        throw new StaticFrameCompilerProtocolError(
          `${path} 不得使用存在包含关系的片段凑数量：${spans[left]} / ${spans[right]}`
        );
      }
    }
  }
  if (!canAssignNonOverlappingOccurrences(String(source), spans)) {
    throw new StaticFrameCompilerProtocolError(`${path} 必须逐字来自对应文本且可分配为互不重叠的连续区间`);
  }
}

function canAssignNonOverlappingOccurrences(source, spans) {
  if (spans.length === 0) return true;
  const occurrences = spans.map((span) => {
    const found = [];
    let offset = 0;
    while (offset <= source.length - span.length) {
      const index = source.indexOf(span, offset);
      if (index < 0) break;
      found.push([index, index + span.length]);
      offset = index + 1;
    }
    return found;
  });
  if (occurrences.some((items) => items.length === 0)) return false;

  const assigned = [];
  const visit = (spanIndex) => {
    if (spanIndex >= occurrences.length) return true;
    for (const interval of occurrences[spanIndex]) {
      const overlaps = assigned.some(([start, end]) => interval[0] < end && start < interval[1]);
      if (overlaps) continue;
      assigned.push(interval);
      if (visit(spanIndex + 1)) return true;
      assigned.pop();
    }
    return false;
  };
  return visit(0);
}

function validateCompiledValue(patch, target, patchPath) {
  const forbidden = firstStaticFrameViolation(patch.value);
  if (forbidden) {
    throw new StaticFrameCompilerProtocolError(
      `${patchPath}.value 仍包含静态帧不允许的表达：${forbidden}`
    );
  }
  if (isMechanicalDeletion(target.before, patch.value)) {
    throw new StaticFrameCompilerProtocolError(
      `${patchPath}.value 只是从 before 机械删除意图或过程词`
    );
  }
  if (target.field === "pose") {
    if (patch.visibleFacts.length < 2) {
      throw new StaticFrameCompilerProtocolError(
        `${patchPath}.visibleFacts 修改 pose 时至少需要两个不同的可见事实`
      );
    }
    const dimensions = new Set();
    patch.visibleFacts.forEach((fact) => {
      Object.entries(POSE_DIMENSION_PATTERNS).forEach(([dimension, pattern]) => {
        if (pattern.test(fact)) dimensions.add(dimension);
      });
    });
    if (dimensions.size < 2) {
      throw new StaticFrameCompilerProtocolError(
        `${patchPath}.visibleFacts 修改 pose 时必须覆盖至少两个不同可观察维度`
      );
    }
  }
}

function containsStaticFrameViolation(value) {
  return Boolean(firstStaticFrameViolation(value));
}

function firstStaticFrameViolation(value) {
  const text = String(value || "");
  const shared = [...STATIC_FRAME_PROCESS_OR_AUDIO_TERMS, ...STATIC_FRAME_INVISIBLE_INTENT_TERMS]
    .find((term) => text.includes(term));
  if (shared) return shared;
  for (const pattern of Object.values(REASON_TRIGGER_PATTERNS)) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

function isMechanicalDeletion(before, after) {
  const normalizedBefore = normalizeMechanicalComparisonText(before);
  const normalizedAfter = normalizeMechanicalComparisonText(after);
  if (!normalizedAfter) return false;
  const strippedBefore = normalizeMechanicalComparisonText(stripNarrativeMarkers(before));
  return strippedBefore === normalizedAfter && normalizedBefore !== normalizedAfter;
}

function stripNarrativeMarkers(value) {
  let text = String(value || "");
  const literalTerms = [
    ...STATIC_FRAME_PROCESS_OR_AUDIO_TERMS,
    ...STATIC_FRAME_INVISIBLE_INTENT_TERMS,
    "打算",
    "计划",
    "决定",
    "开始",
    "继续",
    "接下来",
    "下一步",
    "逐步",
    "慢慢"
  ].sort((left, right) => right.length - left.length);
  literalTerms.forEach((term) => {
    text = text.split(term).join("");
  });
  return text;
}

function normalizeComparisonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()[\]{}《》〈〉·—…-]/gu, "")
    .toLowerCase();
}

function normalizeMechanicalComparisonText(value) {
  return normalizeComparisonText(value).replace(/[了着过已]/gu, "");
}

function projectCompilerContext(candidate) {
  return {
    shotPlan: candidate.shotPlan.map((shot) => ({
      ...(Object.hasOwn(shot || {}, "shotId") ? { shotId: shot.shotId } : {}),
      ...(Object.hasOwn(shot || {}, "sceneId") ? { sceneId: shot.sceneId } : {}),
      startFrame: shot?.startFrame,
      endFrame: shot?.endFrame,
      motion: shot?.motion
    }))
  };
}

function buildProtocolRetryPrompt(basePrompt, diagnostic) {
  return `${basePrompt}

STATIC_FRAME_COMPILER_PROTOCOL_RETRY_V1

上一次输出未通过协议校验：
${JSON.stringify(String(diagnostic || "未知协议错误"))}

这是同一 animationShotBatch 的唯一一次 compiler 协议纠偏。
- 输入 batch、允许路径和字段原值完全不变。
- 只修复上述 JSON/schema/path/patch protocol 错误。
- 如果诊断指出某个 before 已明确满足静态帧契约、必须省略或禁止润色：从 patches 删除该精确 path，逐字保留原字段；不得换 reasonCode、triggerSpans 或 value 再次改写它。若删除后没有其他真实违规字段，返回 {"patches":[]}。
- 如果诊断指出 triggerSpans 不能证明 reasonCode：选择与问题词直接匹配的 reasonCode；删除与问题表达不连续的上下文 span，不要添加更多上下文来凑证据。
- triggerSpans 通常只保留一个最小问题片段；角色、道具和正常动作不得单独作为 triggerSpan。
- 不得重新生成 animationShotBatch，不得扩大 patch 范围。
- 仍只输出严格 JSON 对象。`;
}

function createRunMetadata({ provider, model, batchIndex, phase }) {
  return {
    version: STATIC_FRAME_COMPILER_VERSION,
    provider,
    model,
    batchIndex,
    phase,
    noOp: false,
    runAccepted: false,
    requestCount: 0,
    finalResult: "pending",
    protocolAttempts: [],
    modifications: []
  };
}

function rejectedPatchMetadata(response, targets, protocolAttempt) {
  if (!isRecord(response) || !Array.isArray(response.patches)) return [];
  return response.patches.flatMap((patch) => {
    if (!isRecord(patch)) return [];
    const path = typeof patch.path === "string" ? patch.path : "";
    const target = targets.get(path);
    return [{
      protocolAttempt,
      path,
      before: target?.before ?? null,
      after: typeof patch.value === "string" ? patch.value : null,
      reasonCode: typeof patch.reasonCode === "string" ? patch.reasonCode : null,
      triggerSpans: Array.isArray(patch.triggerSpans)
        ? patch.triggerSpans.filter((span) => typeof span === "string")
        : [],
      visibleFacts: Array.isArray(patch.visibleFacts)
        ? patch.visibleFacts.filter((span) => typeof span === "string")
        : [],
      applied: false,
      finalAccepted: false
    }];
  });
}

function countTransportAttempts(metadata) {
  return metadata.protocolAttempts.reduce(
    (total, protocolAttempt) => total + protocolAttempt.transportAttempts.length,
    0
  );
}

function inferProvider(client) {
  const name = String(client?.constructor?.name || "").replace(/Client$/u, "");
  return name || "unknown";
}

function isModelJsonProtocolError(error) {
  if (error instanceof StaticFrameCompilerProtocolError || error instanceof SyntaxError) return true;
  if (!(error instanceof ModelResponseError) && error?.name !== "ModelResponseError") return false;
  const message = String(error?.message || "");
  return Number(error?.status || 0) === 0
    && /未返回合法 JSON|无法解析的响应包|响应缺少 .*content|JSON/u.test(message);
}

function classifyTransportError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  const upperMessage = message.toUpperCase();
  if (status === 401 || status === 403 || /API.?KEY|AUTH|鉴权|认证|未授权/u.test(upperMessage)) {
    return "auth";
  }
  if (
    ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"].includes(code)
    || /INVALID CONFIG|MISSING CONFIG|CONFIGURATION|配置错误|缺少配置/u.test(upperMessage)
  ) {
    return "config";
  }
  if (
    /INVALID MODEL|UNKNOWN MODEL|MODEL .*(?:NOT FOUND|UNAVAILABLE)|无效模型|未知模型|模型.*(?:不存在|不可用)/u.test(upperMessage)
    || /UNKNOWN PROVIDER|UNSUPPORTED PROVIDER|INVALID PROVIDER|未知.*(?:PROVIDER|供应商)|不支持.*(?:PROVIDER|供应商)/u.test(upperMessage)
  ) {
    return "provider";
  }
  if (
    status === 408
    || name === "AbortError"
    || name === "TimeoutError"
    || ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)
    || /TIMEOUT|TIMED OUT|超时/u.test(upperMessage)
  ) {
    return "timeout";
  }
  if (status > 0) return "provider";
  return "transport";
}

function isTransientTransportError(error, classification) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = String(error?.message || error?.cause?.message || "").toUpperCase();
  if (classification === "auth") return false;
  if (status === 408 || status === 429 || status >= 500) return true;
  if (classification === "timeout") return true;
  if (status >= 400) return false;
  if ([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)) {
    return true;
  }
  return classification === "transport"
    && /FETCH FAILED|NETWORK (?:UNAVAILABLE|ERROR)|SOCKET|CONNECTION (?:RESET|REFUSED)|DNS/u.test(message);
}

function asProtocolError(error) {
  if (error instanceof StaticFrameCompilerProtocolError) return error;
  return new StaticFrameCompilerProtocolError(
    String(error?.message || error || "未知 compiler protocol 错误"),
    { cause: error }
  );
}

function requireExactKeys(value, expectedKeys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new StaticFrameCompilerProtocolError(
      `${path} 只能包含 ${expectedKeys.join("、")}`
    );
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
