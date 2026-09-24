// 自主分镜设计发给模型做约束解码的 Schema（response_format: json_schema）。
// 与候选、候选对照评审同一个做法：从服务端严格 Schema 派生，不另写一份；
// 严格 Schema 与跨字段校验仍是唯一裁决方，这里只减少模型的结构失败。
import { storyboardDesignSchema } from "../storyboard-contract.js";

export const STORYBOARD_DESIGN_MODEL_SCHEMA_NAME = "storyboard_design";

// 只发送已在 MiMo 上实测的关键字；严格 Schema 新增能力时必须明确决定如何派生，
// 不能让未知关键字静默进入请求。
const ALLOWED_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "enum", "minimum", "maximum", "minLength"
]);

// strictSchema 只供测试注入「结构变了的严格 Schema」，生产调用一律用默认值。
export function storyboardDesignModelSchema(strictSchema = storyboardDesignSchema) {
  const schema = structuredClone(strictSchema);
  transform(schema, "$");
  // 严格 Schema 的 properties 已与提示词同序，保留即可；片段数仍由模型自己决定。
  return schema;
}

function transform(node, path) {
  if (Object.hasOwn(node, "pattern")) {
    if (node.pattern !== "\\S") fail(`${path}.pattern 不是已知的非空字符串约束：${node.pattern}`);
    // MiMo 把 pattern 当全串匹配，会把字符串截成一个字符，开思考时还吐出过非法 JSON。
    // 改用 minLength；全空白字符串仍由服务端严格 Schema 拦下。
    delete node.pattern;
    node.minLength = 1;
  }
  // 这两个关键字未在 MiMo 上实测过；只放宽模型那一侧，服务端判据不变。
  delete node.uniqueItems;
  delete node.exclusiveMinimum;
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) fail(`${path} 出现未支持的关键字 ${keyword}`);
  }
  for (const [field, child] of Object.entries(node.properties || {})) {
    transform(child, `${path}.properties.${field}`);
  }
  if (node.items) transform(node.items, `${path}.items`);
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    transform(node.additionalProperties, `${path}.additionalProperties`);
  }
}

function fail(message) {
  throw new Error(`分镜设计模型 Schema 派生失败（严格 Schema 结构变了？）：${message}`);
}
