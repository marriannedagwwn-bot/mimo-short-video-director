// 供应商错误码 → 可执行的中文提示。
//
// 这是一个**纯展示层**：它不改变任何控制流——不影响是否抛错、抛什么错、
// 重试预算、HTTP 状态码，也不参与任何业务校验。它只做一件事：把供应商
// 返回的原始错误体翻译成用户看得懂、知道下一步该做什么的一句话。
//
// 三条硬规则：
// 1. **只增不减**：供应商原文逐字保留在既有的 detail 字段里，这里产出的
//    解释是额外信息。绝不用友好文案顶替原文——那是隐藏错误。
// 2. **匹配不到就不猜**：查不到的码一律返回 null，让调用方回退到原文。
//    编一句"可能是网络问题"比不解释更糟。
// 3. **码表只抄官方文档**：每张表都标注了出处 URL 与抓取日期。供应商改了
//    码表就更新这里，不要靠猜测补条目。
//
// 码表出处（2026-08-23 核对）：
// - MiniMax：https://platform.minimaxi.com/docs/api-reference/errorcode
//            https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create
// - 火山方舟 Ark（Seedance / 即梦共用）：https://www.volcengine.com/docs/82379/1359411
// - 可灵 Kling：https://www.klingai.com/document-api/api/get-started/error-codes
// - 阿里云百炼 DashScope（Qwen）：https://help.aliyun.com/zh/model-studio/error-code
// - DeepSeek：https://api-docs.deepseek.com/quick_start/error_codes
// - 小米 MiMo：OpenAI 兼容协议，官方未公开独立码表，走通用 HTTP 兜底。

export const PROVIDER_ERROR_DOC_URLS = Object.freeze({
  MiniMax: "https://platform.minimaxi.com/docs/api-reference/errorcode",
  Seedance: "https://www.volcengine.com/docs/82379/1359411",
  Jimeng: "https://www.volcengine.com/docs/82379/1359411",
  Kling: "https://www.klingai.com/document-api/api/get-started/error-codes",
  Qwen: "https://help.aliyun.com/zh/model-studio/error-code",
  DeepSeek: "https://api-docs.deepseek.com/quick_start/error_codes",
  MiMo: "https://mimo.mi.com/docs/zh-CN/quick-start/error-codes"
});

const entry = (title, guidance, retryable = false) => Object.freeze({ title, guidance, retryable });

// MiniMax：v2 接口用 error.type 字符串，消息里带括号数字码（如 "(1008)"）；
// 旧接口用 base_resp.status_code 数字码。两套都收。
const MINIMAX_CODES = Object.freeze({
  bad_request_error: entry("请求参数不合法", "检查提交的提示词与参数是否符合 MiniMax 接口要求。"),
  authorized_error: entry("鉴权失败", "检查 MINIMAX_API_KEY 是否正确、是否过期。"),
  insufficient_balance_error: entry("账户余额不足", "前往 MiniMax 控制台充值后重试；也可以在镜头视频弹窗改选 Seedance 2.0。"),
  unprocessable_entity_error: entry("输入内容被安全策略拦截", "调整提示词中可能触发内容安全的表述后重试。"),
  rate_limit_error: entry("请求频率超限", "稍等片刻再重试，或降低并发数。", true),
  server_error: entry("MiniMax 服务内部错误", "稍后重试；持续失败请联系 MiniMax 支持并提供 request_id。", true),

  1000: entry("MiniMax 未知错误", "稍后重试；持续失败请带 request_id 联系 MiniMax 支持。", true),
  1001: entry("MiniMax 请求超时", "稍后重试。", true),
  1002: entry("请求频率超限", "稍等片刻再重试，或降低并发数。", true),
  1004: entry("鉴权失败：Token 不匹配", "检查 MINIMAX_API_KEY 是否正确、是否过期。"),
  1008: entry("账户余额不足", "前往 MiniMax 控制台充值后重试；也可以在镜头视频弹窗改选 Seedance 2.0。"),
  1024: entry("MiniMax 内部错误", "稍后重试。", true),
  1026: entry("输入内容涉敏被拦截", "调整提示词中可能触发内容安全的表述后重试。"),
  1027: entry("输出内容涉敏被拦截", "换一个表述重新生成；该镜头的提示词可能触发了内容安全。"),
  1033: entry("MiniMax 下游服务错误", "稍后重试。", true),
  1039: entry("Token 数量超限", "缩短提示词或降低单次请求的内容长度。"),
  1041: entry("连接数超限", "降低并发数后重试。", true),
  1042: entry("非法字符比例超限", "检查提示词里是否混入了不可见字符或乱码。"),
  2013: entry("请求参数错误", "对照 MiniMax 接口文档检查参数取值。"),
  2049: entry("API Key 无效", "检查 MINIMAX_API_KEY 是否填写正确。"),
  2056: entry("超出 Token Plan 资源限制", "资源包已用尽，前往 MiniMax 控制台续费或改用其他供应商。")
});

// 火山方舟 Ark：Seedance 视频与即梦图片共用同一套公共错误码。
const ARK_CODES = Object.freeze({
  MissingParameter: entry("请求缺少必要参数", "对照火山方舟接口文档检查必填参数。"),
  InvalidParameter: entry("请求包含非法参数", "对照火山方舟接口文档检查参数取值范围。"),
  "InvalidEndpoint.ClosedEndpoint": entry("推理接入点已关闭或暂时不可用", "在火山方舟控制台确认接入点状态，或稍后重试。", true),
  AuthenticationError: entry("鉴权失败", "检查 SEEDANCE_API_KEY / JIMENG_API_KEY 是否正确、是否过期。"),
  AccountOverdueError: entry("火山引擎账号欠费", "前往火山引擎交易中心充值后重试。"),
  AccessDenied: entry("没有访问该资源的权限", "在火山方舟控制台确认该模型已开通、当前账号有调用权限。"),
  "InvalidEndpoint.NotFound": entry("推理接入点不存在", "检查配置里的模型 ID 是否正确。"),
  "RateLimitExceeded.EndpointRPMExceeded": entry("接入点 RPM 超限", "降低请求频率后重试。", true),
  "RateLimitExceeded.EndpointTPMExceeded": entry("接入点 TPM 超限", "降低请求频率或缩短提示词后重试。", true),
  ModelAccountRpmRateLimitExceeded: entry("账户模型 RPM 超限", "降低请求频率后重试。", true),
  ModelAccountTpmRateLimitExceeded: entry("账户模型 TPM 超限", "降低请求频率或缩短提示词后重试。", true),
  QuotaExceeded: entry("免费试用额度已用完", "在火山方舟控制台开通付费额度后重试。"),
  ModelLoadingError: entry("模型正在加载", "稍等片刻再重试。", true),
  ServerOverloaded: entry("火山方舟服务资源紧张", "稍后重试。", true),
  InternalServiceError: entry("火山方舟内部错误", "稍后重试；持续失败请联系火山引擎支持。", true)
});

// 可灵：HTTP 状态码 + 业务码共同定位，业务码是数字。
const KLING_CODES = Object.freeze({
  1000: entry("身份验证失败", "检查可灵 AccessKey / SecretKey 配置。"),
  1001: entry("Authorization 为空", "请求没有携带鉴权头，检查可灵密钥配置。"),
  1002: entry("Authorization 值非法", "检查可灵 JWT 的签发算法与密钥是否正确。"),
  1003: entry("Authorization 未到生效时间", "检查签发 JWT 时的 nbf 与本机时钟是否同步。"),
  1004: entry("Authorization 已过期", "重新签发可灵 JWT；令牌有效期很短，需要每次调用前生成。"),
  1100: entry("可灵账户异常", "前往可灵控制台确认账户状态。"),
  1101: entry("可灵账户欠费", "前往可灵控制台充值后重试。"),
  1102: entry("资源包已用完或已过期", "在可灵控制台续购资源包后重试。"),
  1103: entry("无权限访问该资源", "确认当前账号已开通所调用的模型或能力。"),
  1200: entry("请求参数非法", "对照可灵接口文档检查参数。"),
  1201: entry("参数取值错误", "检查参数名与取值是否符合可灵接口文档。"),
  1202: entry("请求方法无效", "检查调用的 HTTP method 是否正确。"),
  1203: entry("请求的资源不存在", "检查任务 ID 或接口路径是否正确。"),
  1300: entry("触发平台策略", "内容或调用方式触发了可灵平台策略，检查后重试。"),
  1301: entry("触发内容安全策略", "调整提示词中可能触发内容安全的表述后重试。"),
  1302: entry("API 请求过快", "降低请求频率后重试。", true),
  1303: entry("并发或 QPS 超限", "降低并发数后重试。", true),
  1304: entry("触发 IP 白名单策略", "在可灵控制台把当前出口 IP 加入白名单。"),
  5000: entry("可灵服务器内部错误", "稍后重试。", true),
  5001: entry("可灵服务暂时不可用", "稍后重试。", true),
  5002: entry("可灵服务内部超时", "稍后重试。", true)
});

// 阿里云百炼 DashScope（Qwen 走 compatible-mode，两种码都可能出现）。
const DASHSCOPE_CODES = Object.freeze({
  InvalidApiKey: entry("API Key 填写错误", "检查 QWEN_API_KEY；注意复制时不要混入空格或换行，也要确认密钥地域与 Base URL 匹配。"),
  invalid_api_key: entry("API Key 认证失败", "检查 QWEN_API_KEY 是否正确、是否已被撤销。"),
  Arrearage: entry("阿里云账户欠费", "前往阿里云控制台充值，等余额刷新后重试。"),
  AccessDenied: entry("无权访问或模型已下线", "在百炼控制台确认该模型仍可用且当前账号已开通。"),
  "Model.AccessDenied": entry("无权限调用该模型", "在百炼控制台为当前账号开通该模型。"),
  ModelNotFound: entry("模型不存在或不支持", "检查配置里的模型 ID 是否拼写正确。"),
  InvalidParameter: entry("请求参数不合法", "对照百炼接口文档检查参数取值范围。"),
  DataInspectionFailed: entry("输入或输出内容被安全策略拦截", "调整提示词中可能触发内容安全的表述后重试。"),
  Throttling: entry("触发接口调用限流", "稍等片刻再重试。", true),
  "Throttling.RateQuota": entry("调用频率超限（RPM/TPM）", "降低并发数或加指数退避重试；也可以在百炼控制台申请更高配额。", true),
  "Throttling.AllocationQuota": entry("Token 消耗量超限", "降低请求量或在百炼控制台申请更高配额。", true),
  insufficient_quota: entry("配额不足", "在百炼控制台确认额度或充值后重试。"),
  InternalError: entry("百炼服务内部错误", "稍后重试。", true),
  RequestTimeOut: entry("百炼请求超时", "稍后重试；也可以缩短提示词降低单次耗时。", true),
  ModelUnavailable: entry("模型暂时不可用", "稍后重试或改用其他模型。", true)
});

// DeepSeek 官方按 HTTP 状态码定义错误，没有独立的字符串码。
const DEEPSEEK_STATUS = Object.freeze({
  400: entry("请求体格式不合法", "按错误消息里的提示修正请求。"),
  401: entry("API Key 认证失败", "检查 DEEPSEEK_API_KEY 是否正确，或重新创建一个。"),
  402: entry("DeepSeek 账户余额不足", "前往 DeepSeek 控制台充值后重试。"),
  422: entry("请求参数不合法", "按错误消息里的提示调整参数。"),
  429: entry("请求频率超限", "降低请求频率后重试。", true),
  500: entry("DeepSeek 服务内部错误", "稍后重试；持续失败请联系 DeepSeek 支持。", true),
  503: entry("DeepSeek 服务过载", "稍后重试。", true)
});

// OpenAI 兼容协议的通用兜底：只在供应商没有可匹配的专属码时使用。
// 小米 MiMo 未公开独立码表，走的就是这一层。
const OPENAI_COMPATIBLE_STATUS = Object.freeze({
  400: entry("请求不合法", "检查请求参数是否符合该供应商的接口要求。"),
  401: entry("鉴权失败", "检查该供应商的 API Key 是否正确、是否过期。"),
  402: entry("账户余额不足", "前往该供应商控制台充值后重试。"),
  403: entry("没有调用权限", "确认当前账号已开通该模型。"),
  404: entry("接口或模型不存在", "检查配置里的接口地址与模型 ID。"),
  408: entry("请求超时", "稍后重试。", true),
  413: entry("请求体过大", "缩短提示词或减少参考素材。"),
  422: entry("请求参数无法处理", "按错误消息里的提示调整参数。"),
  429: entry("请求频率超限", "降低请求频率或并发数后重试。", true),
  500: entry("供应商服务内部错误", "稍后重试。", true),
  502: entry("供应商网关错误", "稍后重试。", true),
  503: entry("供应商服务暂时不可用", "稍后重试。", true),
  504: entry("供应商网关超时", "稍后重试。", true)
});

const PROVIDER_CODE_TABLES = Object.freeze({
  MiniMax: MINIMAX_CODES,
  Seedance: ARK_CODES,
  Jimeng: ARK_CODES,
  Kling: KLING_CODES,
  Qwen: DASHSCOPE_CODES,
  DeepSeek: Object.freeze({}),
  MiMo: Object.freeze({})
});

const PROVIDER_STATUS_TABLES = Object.freeze({
  DeepSeek: DEEPSEEK_STATUS
});

const PROVIDER_ALIASES = Object.freeze({
  minimax: "MiniMax",
  "minimax-h3": "MiniMax",
  seedance: "Seedance",
  ark: "Seedance",
  doubao: "Seedance",
  jimeng: "Jimeng",
  即梦: "Jimeng",
  kling: "Kling",
  可灵: "Kling",
  qwen: "Qwen",
  dashscope: "Qwen",
  deepseek: "DeepSeek",
  mimo: "MiMo"
});

export function normalizeProviderName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (Object.hasOwn(PROVIDER_CODE_TABLES, raw)) return raw;
  return PROVIDER_ALIASES[raw.toLowerCase()] || "";
}

/**
 * 从供应商响应体里提取错误码、消息与 request id。
 *
 * 输入可能是原始 JSON 字符串、已解析对象，也可能是 worker 拼出来的
 * `HTTP 402 Payment Required: {json}` 这种带前缀的字符串——三种都要认。
 * 认不出来时返回全空对象，绝不编造。
 */
export function extractProviderErrorSignal(payload) {
  const { body, httpStatus } = splitTransportPrefix(payload);
  const empty = { code: "", message: "", requestId: "", httpStatus };
  if (!body || typeof body !== "object") return empty;

  // MiniMax 旧接口：base_resp.status_code / status_msg
  const baseResp = body.base_resp;
  if (baseResp && typeof baseResp === "object" && Number(baseResp.status_code) > 0) {
    return {
      code: String(baseResp.status_code),
      message: String(baseResp.status_msg || ""),
      requestId: String(body.request_id || body.trace_id || ""),
      httpStatus
    };
  }

  const nested = body.error && typeof body.error === "object" ? body.error : null;
  const source = nested || body;
  // MiniMax v2 用 error.type；Ark / DashScope / OpenAI 兼容用 error.code。
  // 数字型 code（可灵、MiniMax base_resp）统一转成字符串再查表。
  const rawCode = firstNonEmpty([source.code, source.type, source.error_code, source.errorCode]);
  const message = firstNonEmpty([source.message, source.msg, source.status_msg, body.message]);
  const requestId = firstNonEmpty([
    body.request_id, body.requestId, body.trace_id, body.traceId,
    source.request_id, source.requestId
  ]);
  // MiniMax v2 把内部数字码塞在消息尾巴的括号里："insufficient balance (1008)"。
  const embedded = /\((\d{3,6})\)\s*$/u.exec(message);
  return {
    code: String(rawCode || ""),
    embeddedCode: embedded ? embedded[1] : "",
    message: String(message || ""),
    requestId: String(requestId || ""),
    httpStatus: httpStatus || normalizeStatus(source.http_code || source.httpCode || body.http_code)
  };
}

/**
 * 把供应商错误翻译成可执行提示。匹配不到返回 null——调用方必须回退到原文。
 */
export function describeProviderError({ provider, httpStatus = 0, payload = null } = {}) {
  const providerName = normalizeProviderName(provider);
  if (!providerName) return null;

  const signal = extractProviderErrorSignal(payload);
  const status = normalizeStatus(httpStatus) || normalizeStatus(signal.httpStatus);
  const codeTable = PROVIDER_CODE_TABLES[providerName] || {};

  // 优先用供应商自己的码：它比 HTTP 状态码精确得多
  // （429 既可能是限流也可能是欠费，只有业务码分得清）。
  for (const candidate of [signal.code, signal.embeddedCode]) {
    const key = String(candidate || "").trim();
    if (key && Object.hasOwn(codeTable, key)) {
      return build(providerName, key, status, codeTable[key], signal, "code");
    }
  }

  const statusTable = PROVIDER_STATUS_TABLES[providerName] || OPENAI_COMPATIBLE_STATUS;
  if (status && Object.hasOwn(statusTable, status)) {
    // 按 HTTP 状态兜底命中时，标签必须用状态码：响应体里那个 code 不是
    // 我们查到的依据，把它显示成来源会误导人去查一张查不到的表。
    return build(providerName, "", status, statusTable[status], signal, "httpStatus");
  }
  return null;
}

/** 一句话展示文本：标题（供应商 + 命中依据）。处置建议。 */
export function providerErrorDisplayText(description) {
  if (!description) return "";
  const label = description.matchedBy === "code" && description.code
    ? `${description.provider} ${description.code}`
    : `${description.provider}${description.httpStatus ? ` HTTP ${description.httpStatus}` : ""}`;
  return `${description.title}（${label}）。${description.guidance}`;
}

function build(provider, code, httpStatus, description, signal, matchedBy) {
  return Object.freeze({
    provider,
    code,
    httpStatus,
    matchedBy,
    title: description.title,
    guidance: description.guidance,
    retryable: description.retryable,
    docUrl: PROVIDER_ERROR_DOC_URLS[provider] || "",
    // 供应商原文的一句话摘要，便于对照官方文档；完整原文仍在 detail 里。
    providerMessage: String(signal.message || "").slice(0, 300),
    requestId: String(signal.requestId || "").slice(0, 120)
  });
}

// worker 把 HTTP 失败拼成 `HTTP 402 Payment Required: {json}`，
// 文本客户端则直接给原始 body。两种都要能拿到里面的 JSON。
function splitTransportPrefix(payload) {
  if (payload && typeof payload === "object") return { body: payload, httpStatus: 0 };
  const text = String(payload || "");
  if (!text.trim()) return { body: null, httpStatus: 0 };
  const prefix = /^\s*(?:下载产物失败\s*)?HTTP\s+(\d{3})\b/u.exec(text);
  const httpStatus = prefix ? Number(prefix[1]) : 0;
  const start = text.indexOf("{");
  if (start < 0) return { body: null, httpStatus };
  try {
    return { body: JSON.parse(text.slice(start)), httpStatus };
  } catch {
    return { body: null, httpStatus };
  }
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}
