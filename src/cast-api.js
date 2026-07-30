import { CastPipelineDisabledError } from "./cast-errors.js";

export const CAST_PROPOSAL_API_PATH = "/api/full-story/cast-proposals";
export const CAST_CONFIRMATION_API_PATH = "/api/full-story/cast-confirmations";

export function handleCastApiRequest({
  enabled = false,
  path,
  body,
  service
} = {}) {
  if (!enabled) throw new CastPipelineDisabledError();
  if (!service || typeof service !== "object") {
    throw new TypeError("Cast orchestration service 未配置");
  }
  if (path === CAST_PROPOSAL_API_PATH) return service.begin(body);
  if (path === CAST_CONFIRMATION_API_PATH) return service.confirm(body);
  return null;
}
