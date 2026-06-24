import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mapping = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo"
  };
  return mapping[extension] || "application/octet-stream";
}

export function selectSampleTimestamps(duration, count) {
  const safeCount = clampInteger(count, 8, 3, 16);
  if (!Number.isFinite(duration) || duration <= 0) {
    return Array.from({ length: safeCount }, (_, index) => Number((index * 3).toFixed(3)));
  }
  return Array.from({ length: safeCount }, (_, index) => {
    const midpoint = ((index + 0.5) / safeCount) * duration;
    return Number(Math.min(Math.max(midpoint, 0), Math.max(duration - 0.05, 0)).toFixed(3));
  });
}

export async function probeVideo(filePath) {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.stat(absolutePath);
  const { stdout } = await runProcess("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absolutePath
  ], "ffprobe");
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe 返回了无法解析的视频元数据");
  }
  const videoStream = Array.isArray(body.streams)
    ? body.streams.find((stream) => stream.codec_type === "video")
    : null;
  if (!videoStream) throw new Error("文件中没有可识别的视频流");
  const duration = Number(videoStream.duration || body.format?.duration || 0);
  return {
    name: path.basename(absolutePath),
    path: absolutePath,
    size: stat.size,
    mimeType: mimeTypeFor(absolutePath),
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0)
  };
}

export async function readNativeVideoDataUrl(filePath, { maxBytes }) {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.stat(absolutePath);
  if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
    return {
      included: false,
      reason: `视频文件 ${formatBytes(stat.size)} 超过原生视频上限 ${formatBytes(maxBytes)}，将只发送关键帧`,
      size: stat.size
    };
  }
  const buffer = await fs.readFile(absolutePath);
  return {
    included: true,
    reason: "已携带原生视频 data URL",
    size: stat.size,
    dataUrl: `data:${mimeTypeFor(absolutePath)};base64,${buffer.toString("base64")}`
  };
}

export async function sampleVideoFrames(filePath, { count = 8, maxLongSide = 720 } = {}) {
  const metadata = await probeVideo(filePath);
  const timestamps = selectSampleTimestamps(metadata.duration, count);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-short-video-"));
  try {
    const frames = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = timestamps[index];
      const outputPath = path.join(tempDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      await runProcess("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-ss", String(timestamp),
        "-i", metadata.path,
        "-frames:v", "1",
        "-an",
        "-vf", scaleFilter(maxLongSide),
        "-q:v", "4",
        outputPath
      ], "ffmpeg");
      const buffer = await fs.readFile(outputPath);
      frames.push({
        timestamp,
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`
      });
    }
    return { metadata, frames };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function prepareVideoInput(filePath, { frameCount = 8, nativeVideoMaxBytes, includeNativeVideo = true } = {}) {
  const { metadata, frames } = await sampleVideoFrames(filePath, { count: frameCount });
  const nativeVideo = includeNativeVideo
    ? await readNativeVideoDataUrl(filePath, { maxBytes: nativeVideoMaxBytes })
    : { included: false, reason: "当前模式不发送原生视频，只发送关键帧", size: metadata.size };
  return {
    metadata,
    frames,
    video: nativeVideo.included ? { dataUrl: nativeVideo.dataUrl } : null,
    nativeVideo
  };
}

function scaleFilter(maxLongSide) {
  const side = clampInteger(maxLongSide, 720, 128, 1920);
  return `scale=w='if(gt(iw,ih),min(${side},iw),-2)':h='if(gt(iw,ih),-2,min(${side},ih))'`;
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知大小";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function runProcess(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`无法调用 ${label}。请先安装 ffmpeg，并确保 ffmpeg/ffprobe 在 PATH 中。`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${label} 执行失败：${err || `退出码 ${code}`}`.trim()));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}
