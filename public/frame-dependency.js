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
