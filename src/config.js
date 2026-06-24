import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function getConfig() {
  const baseUrl = process.env.MIMO_BASE_URL?.trim() || "";
  const requestedMediaMode = process.env.MIMO_MEDIA_MODE?.trim().toLowerCase() || "auto";
  const mediaMode = ["auto", "video", "frames"].includes(requestedMediaMode) ? requestedMediaMode : "auto";
  const nativeVideoMaxMb = clampNumber(process.env.MIMO_NATIVE_VIDEO_MAX_MB, 18, 1, 22);
  const videoFps = clampNumber(process.env.MIMO_VIDEO_FPS, 2, 0.1, 10);
  const requestedVideoResolution = process.env.MIMO_VIDEO_MEDIA_RESOLUTION?.trim().toLowerCase() || "default";
  const videoMediaResolution = ["default", "max"].includes(requestedVideoResolution) ? requestedVideoResolution : "default";
  const maxCompletionTokens = Math.round(clampNumber(process.env.MIMO_MAX_COMPLETION_TOKENS, 8192, 512, 32768));
  const requestedThinking = process.env.MIMO_THINKING?.trim().toLowerCase() || "disabled";
  const thinking = ["disabled", "enabled"].includes(requestedThinking) ? requestedThinking : "disabled";
  return {
    port: Number(process.env.PORT || 4173),
    mimo: {
      baseUrl,
      apiKey: process.env.MIMO_API_KEY?.trim() || "",
      model: process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      jsonMode: process.env.MIMO_JSON_MODE === "true",
      mediaMode,
      nativeVideoMaxBytes: Math.floor(nativeVideoMaxMb * 1024 * 1024),
      videoFps,
      videoMediaResolution,
      maxCompletionTokens,
      thinking,
      enabled: Boolean(baseUrl)
    }
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
