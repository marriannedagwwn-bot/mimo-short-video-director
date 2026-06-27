import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv, getConfig } from "./config.js";
import { MimoClient, ModelResponseError } from "./mimo-client.js";
import { QwenClient } from "./qwen-client.js";
import { WorkflowService } from "./workflow.js";
import { prepareVideoInput } from "./video-file.js";

export function parseRunVideoArgs(argv) {
  const options = {
    frameCount: 8,
    count: 3,
    constraints: "",
    transcript: "",
    output: "",
    requireMimo: false,
    help: false
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--require-mimo") {
      options.requireMimo = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [name, inlineValue] = token.includes("=") ? token.slice(2).split(/=(.*)/s, 2) : [token.slice(2), null];
      const value = inlineValue ?? argv[index + 1];
      if (inlineValue === null) index += 1;
      assignOption(options, name, value);
      continue;
    }
    positional.push(token);
  }
  options.videoPath = positional[0] || options.video || "";
  options.frameCount = clampInteger(options.frameCount, 8, 3, 16);
  options.count = clampInteger(options.count, 3, 1, 8);
  return options;
}

export function runVideoUsage() {
  return `用法：
  npm run run:video -- <reference-video> --character "固定角色" --vertical "垂直赛道" [选项]

必填：
  <reference-video>              本地参考视频路径
  --character <text>             固定角色，例如 "阿岚，社区修理师"
  --vertical <text>              垂直赛道，例如 "家电维修"

常用选项：
  --constraints <text>           额外创作约束，例如 "60 秒内，中文口播"
  --transcript-file <path>       可选字幕/对白文本文件
  --frames <3-16>                抽帧数量，默认 8
  --count <1-8>                  主题变体数量，默认 3
  --output <path>                输出 JSON 路径，默认 exports/run-<time>.json
  --require-mimo                 未连接 MiMo 或模型未加载时直接失败
`;
}

export async function runVideoCommand(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseRunVideoArgs(argv);
    if (options.help) {
      stdout.write(runVideoUsage());
      return 0;
    }
    await validateRunVideoOptions(options);

    loadEnv();
    const config = getConfig();
    const client = config.mimo.enabled ? new MimoClient(config.mimo) : null;
    const qwenClient = config.qwen.enabled ? new QwenClient(config.qwen) : null;
    await assertMimoState(client, config, options);

    stdout.write(`读取视频：${path.resolve(options.videoPath)}\n`);
    const videoInput = await prepareVideoInput(options.videoPath, {
      frameCount: options.frameCount,
      nativeVideoMaxBytes: config.mimo.nativeVideoMaxBytes,
      includeNativeVideo: Boolean(client) && config.mimo.mediaMode !== "frames"
    });
    stdout.write(`已抽取 ${videoInput.frames.length} 张关键帧；${videoInput.nativeVideo.reason}\n`);

    const workflow = new WorkflowService({
      client,
      storyClient: qwenClient || client,
      storyProvider: qwenClient ? "Qwen" : "MiMo",
      storyModel: qwenClient ? config.qwen.storyModel : config.mimo.storyModel,
      storyMaxCompletionTokens: qwenClient ? config.qwen.storyMaxCompletionTokens : config.mimo.storyMaxCompletionTokens,
      animationClient: qwenClient || client,
      animationProvider: qwenClient ? "Qwen" : "MiMo",
      animationModel: qwenClient ? config.qwen.animationModel : config.mimo.animationModel,
      animationMaxCompletionTokens: qwenClient ? config.qwen.animationMaxCompletionTokens : config.mimo.animationMaxCompletionTokens
    });
    stdout.write(`运行模式：${workflow.mode === "mimo" ? `MiMo 实分析；剧情 ${workflow.storyProvider} ${workflow.storyModel}；动画 ${workflow.animationProvider} ${workflow.animationModel}` : "演示模式"}\n`);
    const result = await workflow.run({
      frames: videoInput.frames,
      video: videoInput.video,
      metadata: videoInput.metadata,
      transcript: options.transcript,
      creatorProfile: {
        fixedCharacter: options.character,
        vertical: options.vertical,
        constraints: options.constraints
      },
      count: options.count
    });

    const outputPath = await writeResult(options.output || defaultOutputPath(), {
      generatedAt: new Date().toISOString(),
      mode: workflow.mode,
      sourceVideo: {
        name: videoInput.metadata.name,
        path: videoInput.metadata.path,
        size: videoInput.metadata.size,
        duration: videoInput.metadata.duration,
        width: videoInput.metadata.width,
        height: videoInput.metadata.height
      },
      creatorProfile: {
        fixedCharacter: options.character,
        vertical: options.vertical,
        constraints: options.constraints
      },
      modelInfo: {
        storyProvider: workflow.storyProvider,
        storyModel: workflow.storyModel,
        animationProvider: workflow.animationProvider,
        animationModel: workflow.animationModel
      },
      ...result
    });
    stdout.write(`已导出：${outputPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(formatError(error));
    return 1;
  }
}

function assignOption(options, name, value) {
  if (value === undefined || value === null || String(value).startsWith("--")) {
    throw new Error(`缺少 --${name} 的取值`);
  }
  const normalized = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const aliases = {
    video: "video",
    character: "character",
    vertical: "vertical",
    constraints: "constraints",
    frames: "frameCount",
    count: "count",
    output: "output",
    "transcript-file": "transcriptFile"
  };
  const key = aliases[normalized];
  if (!key) throw new Error(`不支持的参数：--${name}`);
  options[key] = value;
}

async function assertMimoState(client, config, options) {
  if (!client) {
    if (options.requireMimo) throw new Error("缺少 MIMO_BASE_URL，无法按 --require-mimo 运行真实 MiMo 分析");
    return;
  }
  const health = await client.checkHealth();
  if (!health.reachable) {
    throw new Error(`MiMo 服务不可达：${config.mimo.baseUrl}/models`);
  }
  if (!health.modelAvailable) {
    throw new Error(`MiMo 服务可达，但未加载模型 ${config.mimo.model}。当前模型：${(health.modelIds || []).join(", ") || "无"}`);
  }
}

async function validateRunVideoOptions(options) {
  if (!options.videoPath) throw new Error("缺少参考视频路径");
  if (!options.character || !String(options.character).trim()) throw new Error("缺少 --character 固定角色");
  if (!options.vertical || !String(options.vertical).trim()) throw new Error("缺少 --vertical 垂直赛道");
  if (options.transcriptFile) {
    options.transcript = await fs.readFile(path.resolve(options.transcriptFile), "utf8");
  }
}

async function writeResult(outputPath, value) {
  const absolutePath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return absolutePath;
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("exports", `run-${stamp}.json`);
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function formatError(error) {
  const lines = [`失败：${error.message || error}\n`];
  if (error instanceof ModelResponseError && error.raw) {
    lines.push(`MiMo 原始响应片段：\n${error.raw}\n`);
  }
  return lines.join("");
}
