import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { klingV3PostedBody, miniMaxPostedBody, pinResolutionEnv, seedancePostedBody } from "./helpers/fake-video-providers.js";

// worker 怎么决定请求体里的分辨率（2026-10-10）：这次请求选了就严格按请求，优先于供应商配置文件
// 和环境变量；没选就按配置（大小写不敏感）。对不上一律报错——原来 Seedance、可灵会悄悄改成 720p。

test("请求里选的分辨率优先于配置文件和环境变量，原样写进请求体，回执记下实际发出的值", async (t) => {
  pinResolutionEnv(t, { SEEDANCE_VIDEO_RESOLUTION: "720p", MINIMAX_VIDEO_RESOLUTION: "2K", KLING_VIDEO_RESOLUTION: "720p" });
  const seedance = await seedancePostedBody(t, { config: { resolution: "480p" }, parameters: { resolution: "1080p" } });
  assert.equal(JSON.parse(seedance.raw).resolution, "1080p");
  assert.equal(seedance.receipt.resolution, "1080p");
  const minimax = await miniMaxPostedBody(t, { parameters: { resolution: "768P" } });
  assert.equal(JSON.parse(minimax.raw).resolution, "768P");
  assert.equal(minimax.receipt.resolution, "768P");
  const kling = await klingV3PostedBody(t, { parameters: { resolution: "1080p" } });
  assert.equal(JSON.parse(kling.raw).settings.resolution, "1080p");
  assert.equal(kling.receipt.resolution, "1080p");
});

test("没选时按配置：大小写不敏感地还原成清单写法，回执同样记下实际发出的值", async (t) => {
  pinResolutionEnv(t, { MINIMAX_VIDEO_RESOLUTION: "768p" });
  const minimax = await miniMaxPostedBody(t);
  assert.equal(JSON.parse(minimax.raw).resolution, "768P");
  assert.equal(minimax.receipt.resolution, "768P");
  const seedance = await seedancePostedBody(t, { config: { resolution: "1080P" } });
  assert.equal(JSON.parse(seedance.raw).resolution, "1080p");
});

test("请求里的值不在这个模型的清单里（含大小写不对、4k）：明确报错，不发请求", async (t) => {
  pinResolutionEnv(t, {});
  await assert.rejects(
    seedancePostedBody(t, { config: { videoModel: "doubao-seedance-2-0-fast-260128" }, parameters: { resolution: "1080p" } }),
    /Seedance resolution 只支持 480p 或 720p，本次请求为“1080p”；不会静默改写分辨率/u
  );
  await assert.rejects(miniMaxPostedBody(t, { parameters: { resolution: "2k" } }), /MiniMax H3 resolution 只支持 768P 或 2K，本次请求为“2k”/u);
  await assert.rejects(seedancePostedBody(t, { parameters: { resolution: "4k" } }), /本次请求为“4k”/u);
});

test("配置值不合法：原来悄悄改成 720p 的 Seedance、可灵，现在和 MiniMax 一样明确报错", async (t) => {
  pinResolutionEnv(t, {});
  await assert.rejects(
    seedancePostedBody(t, { config: { videoModel: "doubao-seedance-2-0-fast-260128", resolution: "1080p" } }),
    /Seedance resolution 只支持 480p 或 720p，当前配置为“1080p”；请修正 SEEDANCE_VIDEO_RESOLUTION，不会静默改写分辨率/u
  );
  await assert.rejects(seedancePostedBody(t, { config: { resolution: "4k" } }), /当前配置为“4k”/u, "4k 已从清单里去掉");
  await assert.rejects(klingV3PostedBody(t, { config: { resolution: "1080" } }),
    /Kling 3\.0 resolution 只支持 720p 或 1080p，当前配置为“1080”；请修正 KLING_VIDEO_RESOLUTION/u);
});

test("可灵 v2.1 没有分辨率参数：请求里带了就报错，不忽略它照常生成", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kling-v21-resolution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const startPath = path.join(root, "start.png");
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(startPath, Buffer.alloc(300, 1));
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/v1/videos/image2video",
    providerPreset: "kling_image_to_video",
    videoModel: "kling-v2-1",
    apiKey: "test-key"
  }));
  await assert.rejects(executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "Kling-v21",
      capability: "first_last_frame_video_generation",
      outputKey: "preview.v21",
      provider: "Kling",
      model: "kling-v2-1",
      prompt: "测试",
      inputArtifacts: [{ path: startPath, outputKey: "frames.v21.start", status: "done" }],
      parameters: { aspectRatio: "9:16", durationSeconds: 5, resolution: "720p" }
    },
    output: path.join(root, "output.mp4"),
    root
  }), /Kling v2\.1 图生视频没有分辨率参数/u);
});

// 子进程路径：main() 在模块求值到 await main() 时就把请求跑完了，后面的模块常量还在暂时性死区里。
// 分辨率清单改成从 public/ 导入后，这条路径照样要走一遍。
test("worker 以子进程运行时，请求里的分辨率照样生效、照样校验", async (t) => {
  const execFileAsync = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resolution-subprocess-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "ref.png");
  await fs.writeFile(imagePath, "image");
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/api/v3/contents/generations/tasks",
    providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-fast-260128",
    apiKey: "test-key"
  }));
  const runWorker = async (resolution, output) => {
    const requestPath = path.join(root, `${output}.request.json`);
    await fs.writeFile(requestPath, JSON.stringify({
      taskId: "subprocess",
      capability: "all_reference_video_generation",
      outputKey: "preview.subprocess",
      provider: "Seedance",
      model: "doubao-seedance-2-0-fast-260128",
      prompt: "有效提示词",
      inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
      parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution }
    }));
    try {
      await execFileAsync(process.execPath, [
        path.resolve("workers/generic-http-worker.mjs"),
        "--config", configPath,
        "--request", requestPath,
        "--output", path.join(root, output),
        "--receipt", path.join(root, `${output}.receipt.json`)
      ], { env: { ...process.env, SEEDANCE_VIDEO_RESOLUTION: "" } });
      return "";
    } catch (error) {
      return String(error.stderr || error.message || "");
    }
  };
  // 合法：一直走到网络层才失败（端口 1 连不上），而不是死在模块初始化或校验上。
  const ok = await runWorker("480p", "good.mp4");
  assert.doesNotMatch(ok, /before initialization|resolution 只支持/u);
  assert.match(ok, /fetch failed|ECONNREFUSED|ECONNRESET/u);
  const bad = await runWorker("1080p", "bad.mp4");
  assert.match(bad, /Seedance resolution 只支持 480p 或 720p，本次请求为“1080p”/u);
  assert.doesNotMatch(bad, /before initialization/u);
});
