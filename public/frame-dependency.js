const FRAME_REFERENCE_MODES = new Set(["inherit", "transition", "independent"]);

function canonicalValue(value, stack) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") throw new TypeError("canonical JSON does not support bigint");
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
    stack.add(value);
    const result = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return null;
      return canonicalValue(item, stack);
    });
    stack.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (stack.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
    stack.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      result[key] = canonicalValue(item, stack);
    }
    stack.delete(value);
    return result;
  }
  return undefined;
}

export function canonicalize(value) {
  const normalized = canonicalValue(value, new Set());
  if (normalized === undefined) throw new TypeError("canonical JSON requires a JSON-compatible root value");
  return JSON.stringify(normalized);
}

export function normalizePromptText(prompt) {
  if (typeof prompt !== "string") throw new TypeError("prompt must be a string");
  return prompt.replace(/\r\n?/gu, "\n").trim();
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  return hexFromBytes(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

function decodeBase64(payload) {
  const normalized = payload.replace(/\s+/gu, "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch {
    throw new TypeError("image data URL contains invalid base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new TypeError("image data must be a data URL");
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new TypeError("image data URL is missing its payload");
  const metadata = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/(?:^|;)base64(?:;|$)/iu.test(metadata)) return decodeBase64(payload);
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    throw new TypeError("image data URL contains invalid percent encoding");
  }
}

export async function hashDataUrl(dataUrl) {
  return sha256Hex(dataUrlBytes(dataUrl));
}

function validateFrameReferenceMode(frameReferenceMode) {
  if (!FRAME_REFERENCE_MODES.has(frameReferenceMode)) {
    throw new TypeError(`unsupported frameReferenceMode: ${String(frameReferenceMode)}`);
  }
}

function normalizedReferenceImages(referenceImages) {
  if (!Array.isArray(referenceImages)) return [];
  return referenceImages.map((item) => {
    if (!item || typeof item !== "object" || typeof item.role !== "string" || typeof item.contentHash !== "string") {
      throw new TypeError("referenceImages entries require role and contentHash");
    }
    return {
      role: item.role,
      contentHash: item.contentHash,
      characterName: typeof item.characterName === "string" ? item.characterName : ""
    };
  });
}

export async function buildDependencyPayload({
  startImageDataUrl,
  endState,
  referenceImages = [],
  frameReferenceMode
} = {}) {
  validateFrameReferenceMode(frameReferenceMode);
  let startImageHash = null;
  if (frameReferenceMode !== "independent") {
    if (!startImageDataUrl) {
      throw new TypeError(`${frameReferenceMode} dependency requires a start image`);
    }
    startImageHash = await hashDataUrl(startImageDataUrl);
  }
  return {
    startImageHash,
    endState: endState ?? null,
    referenceImages: normalizedReferenceImages(referenceImages),
    frameReferenceMode
  };
}

export async function computeDependencyHash(input) {
  const payload = await buildDependencyPayload(input);
  return `dep:v1:${await sha256Hex(canonicalize(payload))}`;
}

export async function computePromptHash(prompt) {
  return `prompt:v1:${await sha256Hex(normalizePromptText(prompt))}`;
}
