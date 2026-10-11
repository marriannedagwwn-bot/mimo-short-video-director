export class ApiRequestError extends Error {
  constructor(payload = {}, responseStatus = 0, fallbackMessage = "请求失败") {
    const normalized = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const status = normalizeStatus(responseStatus) || normalizeStatus(normalized.status);
    const message = apiErrorMessage(normalized, status, fallbackMessage);
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.stage = normalized.stage || "";
    this.category = normalized.category || "";
    this.metadata = isRecord(normalized.metadata) ? normalized.metadata : null;
    this.code = normalized.code || normalized.errorCode || "";
    this.details = Array.isArray(normalized.details) ? normalized.details : [];
  }
}

export function createApiRequestError(payload, responseStatus, fallbackMessage) {
  return new ApiRequestError(payload, responseStatus, fallbackMessage);
}

function apiErrorMessage(payload, status, fallbackMessage) {
  const message = displayScalar(payload.error || fallbackMessage || (status ? `请求失败（${status}）` : "请求失败"));
  // 服务端认出了供应商官方错误码时，展示可执行的那句话，并把供应商原文一并带出。
  // 注意 ModelResponseError 分支（server-error.js）的响应体没有 detail 字段，
  // 原文只存在于 providerError.providerMessage；只渲染 title/guidance 会让唯一有用的
  // 那句话消失——实测 kimi-k3 的「Parameter 'temperature' is not supported」就是这样被吞掉的。
  const explained = providerErrorText(payload.providerError);
  if (explained) return `${message}：${explained}`;
  const detail = typeof payload.detail === "string" ? payload.detail.trim().slice(0, 240) : "";
  return detail ? `${message}：${detail}` : message;
}

// 浏览器侧不重新查表，只渲染服务端已识别出的 providerError。
export function providerErrorText(providerError) {
  if (!isRecord(providerError)) return "";
  const title = displayScalar(providerError.title);
  const guidance = displayScalar(providerError.guidance);
  if (!title) return "";
  const label = providerError.matchedBy === "code" && providerError.code
    ? `${displayScalar(providerError.provider)} ${displayScalar(providerError.code)}`
    : `${displayScalar(providerError.provider)}${providerError.httpStatus ? ` HTTP ${displayScalar(providerError.httpStatus)}` : ""}`;
  // 供应商原文放在最后，逐字不改，只截长度。按状态码兜底命中时（matchedBy === "httpStatus"）
  // guidance 只能给出通用建议，原文往往是唯一说明白问题的那一句，绝不能省。
  const raw = displayScalar(providerError.providerMessage).slice(0, 240);
  const explained = `${title}（${label}）。${guidance}`;
  return raw ? `${explained}供应商原文：${raw}` : explained;
}

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function displayScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value.slice(0, 500);
  return "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
