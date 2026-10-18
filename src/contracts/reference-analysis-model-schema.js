// 参考片分析发给 MiMo 做约束解码的 Schema（response_format: json_schema）。
//
// 起因（2026-10-18）：json_object 模式下 MiMo 开思考两次都在 retentionDrivers 最后一项后漏了 `]`，
// 之后 `"whyWatchToEnd":` 只能写成 `"whyWatchToEnd",`，模型再也回不到顶层，一路往这个数组里
// 写字符串直到 16384 token 上限。与候选、候选对照评审、分镜设计接 json_schema 之前同一类结构失败。
// 见 docs/analysis-mimo-json-schema-2026-10-18.md。
//
// 与另外三份不同，参考片分析**没有严格 JSON Schema 可以派生**。服务端判据分三处：顶层键与数组字段
// （src/validation.js 的 REFERENCE_ANALYSIS_FIELDS / REFERENCE_ANALYSIS_ARRAY_FIELDS）、observedFacts
// 与 evidence（src/reconstruction-grounding.js 的常量），这里直接引用；其余嵌套字段服务端不查，
// 唯一的定义是 analysisPrompt 的输出模板，这里按模板逐键写出，键集合与顺序由测试锁定与模板一致。
// 所以模型一侧比服务端严（2026-10-18 用户确认）：只收紧结构，不收紧内容——不加 minLength，
// 服务端判据与签发逐字不变，仍是唯一裁决方。
import {
  FRAME_EVIDENCE_KEYS,
  OBSERVATION_FACT_KINDS,
  OBSERVATION_IMPORTANCE,
  OBSERVED_FACT_KEYS,
  VIDEO_EVIDENCE_KEYS
} from "../reconstruction-grounding.js";
import { REFERENCE_ANALYSIS_ARRAY_FIELDS, REFERENCE_ANALYSIS_FIELDS } from "../validation.js";
import { analysisEvidenceShape } from "../prompts.js";

export const REFERENCE_ANALYSIS_MODEL_SCHEMA_NAME = "reference_analysis";

// 只发送已在 MiMo 上实测过的关键字（候选、评审、分镜设计三份 Schema 用过的那些）。
// 未知关键字一旦被 MiMo 拒绝（400），视频请求会被客户端静默退回抽帧，所以这里宁可当场报错。
const ALLOWED_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "minItems",
  "enum", "minimum", "maximum", "minLength"
]);

const text = () => ({ type: "string" });
const texts = () => ({ type: "array", items: text() });
const score = () => ({ type: "number", minimum: 0, maximum: 100 });

function object(properties) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

// evidence 写法跟随提示词：analysisEvidenceShape 是两边共用的一份。
function evidenceSchema(shape) {
  if (shape.source === "video") {
    const max = shape.maxEndSecond;
    // 服务端要求 0 <= startSecond < endSecond <= max。取不到时长时（max 为 0）不写上限：
    // 那时服务端本来就拒绝任何 video evidence，写一个不可满足的范围只会让请求被拒。
    const bounded = Number.isInteger(max) && max >= 1;
    return object(Object.fromEntries(VIDEO_EVIDENCE_KEYS.map((key) => [key, {
      source: { type: "string", enum: ["video"] },
      startSecond: { type: "integer", minimum: 0, ...(bounded ? { maximum: max - 1 } : {}) },
      endSecond: { type: "integer", minimum: 1, ...(bounded ? { maximum: max } : {}) }
    }[key]])));
  }
  const count = shape.frameCount;
  return object(Object.fromEntries(FRAME_EVIDENCE_KEYS.map((key) => [key, {
    source: { type: "string", enum: ["frame"] },
    frameNumber: { type: "integer", minimum: 1, ...(Number.isInteger(count) && count >= 1 ? { maximum: count } : {}) }
  }[key]])));
}

function topLevelProperties(evidence) {
  const evidenceList = () => ({ type: "array", items: evidence });
  return {
    contentPositioning: object({ format: text(), genre: text(), contentPromise: text(), platformFit: text() }),
    targetAudience: object({ primary: text(), psychologicalNeeds: texts(), watchingContext: text() }),
    storySynopsis: text(),
    characters: { type: "array", items: object({
      nameOrLabel: text(), role: text(), traits: texts(), relationshipToProtagonist: text(), evidence: evidenceList()
    }) },
    protagonistIdentity: object({ occupation: text(), socialRole: text(), currentSituation: text(), evidence: evidenceList() }),
    careRecipient: object({
      identity: text(), explicitNeed: text(), implicitNeed: text(), relationship: text(), evidence: evidenceList()
    }),
    dialogueStyle: object({ tone: text(), sentencePattern: text(), informationDensity: text(), subtext: text() }),
    shotRhythm: object({
      openingHookSeconds: { type: "number", minimum: 0 }, averagePerceivedPace: text(), rhythmDescription: text(), shotPatterns: texts()
    }),
    emotionCurve: { type: "array", items: object({
      phase: text(), timeRange: text(), emotion: text(), intensity: score(), trigger: text(), evidence: evidenceList()
    }) },
    retentionDrivers: { type: "array", items: object({
      driver: text(), viewerQuestion: text(), payoff: text(), evidence: evidenceList()
    }) },
    whyWatchToEnd: text(),
    analysisConfidence: score(),
    observedFacts: { type: "array", items: object(Object.fromEntries(OBSERVED_FACT_KEYS.map((key) => [key, {
      factType: { type: "string", enum: [...OBSERVATION_FACT_KINDS] },
      observation: { type: "string", minLength: 1 },
      importance: { type: "string", enum: [...OBSERVATION_IMPORTANCE] },
      evidenceRefs: { type: "array", minItems: 1, items: evidence }
    }[key]]))) },
    uncertainties: { type: "array", items: object({ field: text(), reason: text(), neededEvidence: text() }) }
  };
}

// input 与 analysisPrompt 收到的是同一份（含 workflow 在 VIDEO_EVIDENCE_TIME_INVALID 后改用抽帧的那份）。
export function referenceAnalysisModelSchema(input) {
  const evidence = evidenceSchema(analysisEvidenceShape(input));
  const definitions = topLevelProperties(evidence);
  const known = Object.keys(definitions);
  if (known.join() !== REFERENCE_ANALYSIS_FIELDS.join()) {
    fail(`顶层键与服务端契约不一致：模型 Schema ${known.join("、")}；服务端 ${REFERENCE_ANALYSIS_FIELDS.join("、")}`);
  }
  for (const field of REFERENCE_ANALYSIS_ARRAY_FIELDS) {
    if (definitions[field].type !== "array") fail(`${field} 在服务端契约里是数组`);
  }
  const schema = structuredClone(object(definitions));
  assertKnownKeywords(schema, "$");
  return schema;
}

function assertKnownKeywords(node, path) {
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) fail(`${path} 出现未在 MiMo 上实测过的关键字 ${keyword}`);
  }
  for (const [field, child] of Object.entries(node.properties || {})) assertKnownKeywords(child, `${path}.properties.${field}`);
  if (node.items) assertKnownKeywords(node.items, `${path}.items`);
}

function fail(message) {
  throw new Error(`参考片分析模型 Schema 构造失败：${message}`);
}
