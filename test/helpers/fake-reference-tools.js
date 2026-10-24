// AI 导演第一步「去配乐与转写」与主题变体切接触表要用本机的 ffmpeg / ffprobe / Bandit / whisper。
// 起真 server.js 的测试用这里的替身：几个小 Node 脚本按真实程序的约定写出文件
// （单帧、接触表、分轨、区间、whisper 的 JSON），服务端照真实路径读回，不跑真的模型。
// 用法：const env = await fakeReferenceToolsEnv(directory); spawn(..., { env: { ...env, ... } })。
import fs from "node:fs/promises";
import path from "node:path";

const JPEG_BYTES = "Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])";

function script(body) {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const after = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ""; };
${body}
`;
}

const FFPROBE = script(`
const duration = Number(process.env.FAKE_REFERENCE_VIDEO_SECONDS || 45);
if (args.includes("-version")) { console.log("ffprobe version fake"); process.exit(0); }
process.stdout.write(JSON.stringify({ format: { duration: String(duration) }, streams: [{ codec_type: "video" }, { codec_type: "audio" }] }));
`);

const FFMPEG = script(`
if (args.includes("-version")) { console.log("ffmpeg version fake"); process.exit(0); }
const output = args[args.length - 1];
const jpeg = ${JPEG_BYTES};
if (/f_%04d\\.jpg$/u.test(output)) {
  const duration = Number(process.env.FAKE_REFERENCE_VIDEO_SECONDS || 45);
  const fps = Number(String(after("-vf")).match(/fps=(\\d+)/u)?.[1] || 2);
  const count = Math.max(1, Math.round(duration * fps));
  for (let index = 1; index <= count; index += 1) fs.writeFileSync(output.replace("%04d", String(index).padStart(4, "0")), jpeg);
} else if (/s_%02d\\.jpg$/u.test(output)) {
  const framesDir = path.dirname(after("-i"));
  const frames = fs.readdirSync(framesDir).filter((name) => /^f_\\d{4}\\.jpg$/u.test(name)).length;
  for (let index = 1; index <= Math.ceil(frames / 24); index += 1) fs.writeFileSync(output.replace("%02d", String(index).padStart(2, "0")), jpeg);
} else {
  fs.writeFileSync(output, "RIFF fake wav");
}
`);

const BANDIT_PYTHON = script(`
const output = after("--output-dir");
fs.mkdirSync(output, { recursive: true });
for (const name of ["speech.wav", "music.wav", "sfx.wav", "no_bgm.wav"]) fs.writeFileSync(path.join(output, name), "RIFF fake stem");
fs.writeFileSync(path.join(output, "intervals.json"), JSON.stringify({ cellSeconds: 0.25, thresholdDb: -30, speech: [[1, 2.5]], sfx: [[3, 3.5]] }));
`);

const WHISPER = script(`
const audio = args[0];
const output = after("--output_dir");
const base = path.basename(audio, path.extname(audio));
const line = process.env.FAKE_REFERENCE_WHISPER_LINE || "快进来";
fs.writeFileSync(path.join(output, base + ".json"), JSON.stringify({ segments: [{ start: 1, end: 2.5, text: line + "（" + base + "）" }] }));
`);

export async function fakeReferenceToolsEnv(directory, { videoSeconds = 45 } = {}) {
  const root = path.join(directory, "fake-reference-tools");
  const bin = path.join(root, "bin");
  const bandit = path.join(root, "bandit");
  const models = path.join(root, "whisper-models");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(bandit, ".venv", "bin"), { recursive: true });
  await fs.mkdir(path.join(bandit, "models"), { recursive: true });
  await fs.mkdir(models, { recursive: true });
  const write = async (file, content) => {
    await fs.writeFile(file, content);
    await fs.chmod(file, 0o755);
  };
  await write(path.join(bin, "ffmpeg"), FFMPEG);
  await write(path.join(bin, "ffprobe"), FFPROBE);
  await write(path.join(bandit, ".venv", "bin", "python"), BANDIT_PYTHON);
  await write(path.join(bin, "whisper"), WHISPER);
  await fs.writeFile(path.join(bandit, "models", "checkpoint-multi.ckpt"), "fake checkpoint");
  await fs.writeFile(path.join(models, "small.pt"), "fake whisper model");
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    REFERENCE_REWRITE_BANDIT_DIR: bandit,
    REFERENCE_REWRITE_WHISPER_BIN: path.join(bin, "whisper"),
    REFERENCE_REWRITE_WHISPER_MODEL: "small",
    REFERENCE_REWRITE_WHISPER_MODEL_DIR: models,
    FAKE_REFERENCE_VIDEO_SECONDS: String(videoSeconds)
  };
}

/** 主题变体（剧本格式）的一份合格模型输出：每篇都写出固定角色名。 */
export function scriptVariantsOutput({ count = 3, characterName = "小白子" } = {}) {
  return {
    original: {
      summary: "大雨里，主角在便利店屋檐下躲雨，店员招呼她进来。",
      dialogue: [{ time: "0:11", speaker: "店员", line: "快进来。", picture: "店员在店里理货" }],
      strengths: ["主角自己也在躲雨。"]
    },
    variants: Array.from({ length: count }, (_, index) => ({
      title: `第${index + 1}个故事`,
      direction: `第 ${index + 1} 个角度，约 45 秒。`,
      summary: `${characterName}的第 ${index + 1} 个故事。`,
      script: `**1　外　街口　傍晚　（0–45 秒）**\n\n${characterName}冲进画面。\n\n> ${characterName}：嘿嘿！`
    }))
  };
}
