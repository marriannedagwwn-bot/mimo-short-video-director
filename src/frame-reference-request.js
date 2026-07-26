import { InputError } from "./validation.js";

const frameReferenceModes = new Set(["inherit", "transition", "independent"]);

export function normalizeEndpointReferenceImages(value, {
  frameKind,
  frameReferenceMode,
  shotId
} = {}) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new InputError("referenceImages 必须是数组");
  }
  const references = Array.isArray(value) ? value : [];
  if (!frameReferenceMode) {
    if (references.length) throw new InputError("referenceImages 必须与 frameReferenceMode 一起发送");
    return [];
  }
  if (!frameReferenceModes.has(frameReferenceMode)) {
    throw new InputError("frameReferenceMode 只允许 inherit、transition 或 independent");
  }
  if (frameKind !== "end") throw new InputError("首帧生成不能携带尾帧端点参考");
  if (frameReferenceMode === "independent") {
    if (references.length) throw new InputError("independent 模式不接受 start_frame 供应商视觉参考");
    return [];
  }
  if (references.length !== 1) {
    throw new InputError(`${frameReferenceMode} 模式必须且只能提供一张 start_frame`);
  }
  const reference = references[0];
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new InputError("start_frame 参考图格式无效");
  }
  if (reference.role !== "start_frame") throw new InputError("尾帧端点参考 role 必须是 start_frame");
  if (!/^data:image\/[^;,]+(?:;[^,]*)?,/u.test(String(reference.dataUrl || ""))) {
    throw new InputError("start_frame 必须是有效的图片 Data URL");
  }
  if (!reference.sourceShotId || String(reference.sourceShotId) !== String(shotId || "")) {
    throw new InputError("start_frame.sourceShotId 必须匹配当前镜头");
  }
  return [{
    role: "start_frame",
    dataUrl: reference.dataUrl,
    sourceShotId: String(reference.sourceShotId)
  }];
}

export function assertFrameDependencyHash(receivedHash, authoritativeHash) {
  if (!receivedHash || receivedHash === authoritativeHash) return authoritativeHash;
  throw new InputError("FRAME_DEPENDENCY_MISMATCH", [{
    code: "FRAME_DEPENDENCY_MISMATCH",
    expected: authoritativeHash,
    received: String(receivedHash)
  }]);
}
