import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeGenericHttpWorker } from "../workers/generic-http-worker.mjs";
import { describeProviderError, providerErrorDisplayText } from "../src/provider-error-codes.js";

// MiniMax H3 仍是镜头视频供应商，只是不再有专属提示词方言。
// 这里覆盖的是供应商运行时限额：时长、Prompt 长度、混合参考数量。

test("MiniMax H3 worker 严格拒绝非法时长、超长 Prompt 和超过 12 项的混合参考", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-worker-limits-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  const imagePath = path.join(root, "image.png");
  const videoPath = path.join(root, "video.mp4");
  const audioPath = path.join(root, "audio.mp3");
  await Promise.all([
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key",
      duration: 5
    })),
    fs.writeFile(imagePath, "image"),
    fs.writeFile(videoPath, "video"),
    fs.writeFile(audioPath, "audio")
  ]);
  const baseRequest = {
    taskId: "limits",
    capability: "all_reference_video_generation",
    outputKey: "preview.limits",
    provider: "MiniMax",
    model: "MiniMax-H3",
    prompt: "valid prompt",
    inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
    parameters: { durationSeconds: 5, aspectRatio: "9:16" }
  };
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, parameters: { ...baseRequest.parameters, durationSeconds: 3 } },
    output: path.join(root, "duration.mp4")
  }), /4–15 秒整数|不能静默改写/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, parameters: { ...baseRequest.parameters, durationSeconds: 0 } },
    output: path.join(root, "zero-duration.mp4")
  }), /4–15 秒整数|不能静默改写/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: { ...baseRequest, prompt: "x".repeat(7001) },
    output: path.join(root, "prompt.mp4")
  }), /超过 7000 字符|拒绝截断/u);
  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: {
      ...baseRequest,
      inputArtifacts: [
        ...Array.from({ length: 9 }, () => ({ path: imagePath, mediaType: "image", role: "reference_image" })),
        ...Array.from({ length: 3 }, () => ({ path: videoPath, mediaType: "video", role: "reference_video" })),
        { path: audioPath, mediaType: "audio", role: "reference_audio" }
      ]
    },
    output: path.join(root, "mixed.mp4")
  }), /总数最多 12 项/u);

  const smallBodyConfigPath = path.join(root, "small-body-provider.json");
  await fs.writeFile(smallBodyConfigPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    maxRequestBodyBytes: 200
  }));
  await assert.rejects(() => executeGenericHttpWorker({
    config: smallBodyConfigPath,
    request: baseRequest,
    output: path.join(root, "request-body.mp4")
  }), /最终请求体不得超过|拒绝截断或丢弃/u);
});

// 静默回退是 CLAUDE.md 五、第 4 条禁止的「失败时返回默认值」：`.env` 里那个
// MINIMAX_VIDEO_RESOLUTION=1080K 曾被悄悄改写成 2K，计费与产出都和用户以为的不一样。
test("MiniMax H3 worker 对显式非法的 resolution / ratio 明确失败，不静默回退", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-worker-normalize-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  await fs.writeFile(imagePath, "image");

  const writeConfig = async (name, extra) => {
    const configPath = path.join(root, name);
    await fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key",
      ...extra
    }));
    return configPath;
  };
  const baseRequest = {
    taskId: "normalize",
    capability: "all_reference_video_generation",
    outputKey: "preview.normalize",
    provider: "MiniMax",
    model: "MiniMax-H3",
    prompt: "valid prompt",
    inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
    parameters: { durationSeconds: 5, aspectRatio: "9:16" }
  };

  const badResolutionConfig = await writeConfig("bad-resolution.json", { resolution: "1080K" });
  await assert.rejects(() => executeGenericHttpWorker({
    config: badResolutionConfig,
    request: baseRequest,
    output: path.join(root, "bad-resolution.mp4")
  }), /resolution 只支持 768P 或 2K.*1080K/su);

  const badRatioConfig = await writeConfig("bad-ratio.json", {});
  await assert.rejects(() => executeGenericHttpWorker({
    config: badRatioConfig,
    request: { ...baseRequest, parameters: { ...baseRequest.parameters, aspectRatio: "5:4" } },
    output: path.join(root, "bad-ratio.mp4")
  }), /ratio 只支持.*5:4/su);

  // 未配置仍走缺省（2K / adaptive）——缺省不是覆盖，这条路径必须保留。
  // 端点指向 127.0.0.1:1，所以只要走到网络就说明请求体已经构建成功。
  const defaultConfig = await writeConfig("default-resolution.json", {});
  await assert.rejects(() => executeGenericHttpWorker({
    config: defaultConfig,
    request: { ...baseRequest, parameters: { durationSeconds: 5 } },
    output: path.join(root, "default.mp4")
  }), (error) => !/只支持/u.test(error.message));
});

// MiniMax 有两个平级区域，路径与请求体一致、API Key 各自只在本区域有效。
// 此前只特判了 api.minimaxi.com，国际端点既拿不到 V1 拦截也拿不到路径补全。
test("MiniMax H3 端点规范化对国内与国际两个区域一视同仁", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-region-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  await fs.writeFile(imagePath, "image");
  const request = {
    taskId: "region",
    capability: "all_reference_video_generation",
    outputKey: "preview.region",
    provider: "MiniMax",
    model: "MiniMax-H3",
    prompt: "valid prompt",
    inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
    parameters: { durationSeconds: 5, aspectRatio: "9:16" }
  };
  const writeConfig = async (name, videoEndpoint) => {
    const configPath = path.join(root, name);
    await fs.writeFile(configPath, JSON.stringify({ videoEndpoint, videoModel: "MiniMax-H3", apiKey: "test-key" }));
    return configPath;
  };

  for (const [index, host] of ["api.minimaxi.com", "api.minimax.io"].entries()) {
    // 旧版 V1 接口在两个区域都必须被拦截，而不是只在国内被拦截。
    const v1Config = await writeConfig(`v1-${index}.json`, `https://${host}/v1/video_generation`);
    await assert.rejects(() => executeGenericHttpWorker({
      config: v1Config,
      request,
      output: path.join(root, `v1-${index}.mp4`)
    }), /必须使用 V2 \/v2\/video_generation 接口/u);

    // 只给 origin 时两个区域都应补全出 /v2/video_generation；补全成功的证明是
    // 请求走到了网络层（该主机在测试环境不可达），而不是停在端点缺失。
    const originConfig = await writeConfig(`origin-${index}.json`, `https://${host}`);
    await assert.rejects(() => executeGenericHttpWorker({
      config: originConfig,
      request,
      output: path.join(root, `origin-${index}.mp4`)
    }), (error) => !/缺少 .* 的 HTTP endpoint/u.test(error.message));
  }
});

// 供应商已经说清楚了原因，只报一个 "failed" 等于把它丢掉——CLAUDE.md 五、第 4 条。
// 实测 MiniMax 返回 task.error = {code:"2013", message:"...image size 64x64,
// expected each side in [256, 5760]"}，不带出来完全排查不动。
test("轮询到失败状态时逐字带出供应商给出的失败原因", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  await fs.writeFile(imagePath, "image");

  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") return res.end(JSON.stringify({ task_id: "fail-task" }));
    res.end(JSON.stringify({
      task: {
        id: "fail-task",
        status: "failed",
        error: {
          code: "2013",
          message: "content[1].image_url: invalid param: image size 64x64, expected each side in [256, 5760]"
        }
      }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${port}/v2/video_generation`,
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    pollIntervalMs: 5
  }));

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "failure",
      capability: "all_reference_video_generation",
      outputKey: "preview.failure",
      provider: "MiniMax",
      model: "MiniMax-H3",
      prompt: "valid prompt",
      inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
      parameters: { durationSeconds: 5, aspectRatio: "9:16" }
    },
    output: path.join(root, "failed.mp4")
  }), (error) => {
    assert.match(error.message, /供应商任务失败：failed/u);
    // 原文逐字保留，不改写、不翻译。
    assert.match(error.message, /expected each side in \[256, 5760\]/u);
    assert.match(error.message, /2013/u);
    // 结构化错误对象必须一并带上，否则官方码表查不到——worker 是独立进程，
    // 错误只能以 stderr 文本回来，码表解析依赖消息里的这段 JSON。
    const described = describeProviderError({ provider: "MiniMax", payload: error.message });
    assert.equal(described?.code, "2013");
    assert.equal(described?.matchedBy, "code");
    return true;
  });
});

// 内容审核 1027 是非确定性的输出侧拦截，用户必须拿到「换一个表述重新生成」这句
// 可执行提示，而不是只看到一串原文。此前轮询失败一律查不到码表。
test("输出内容审核拦截能查到官方码表并给出可执行提示", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-1027-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  await fs.writeFile(imagePath, "image");

  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") return res.end(JSON.stringify({ task_id: "sensitive-task" }));
    res.end(JSON.stringify({
      task: { id: "sensitive-task", status: "failed", error: { code: "1027", message: "output new_sensitive" } }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${port}/v2/video_generation`,
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    pollIntervalMs: 5
  }));

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "sensitive", capability: "all_reference_video_generation", outputKey: "preview.sensitive",
      provider: "MiniMax", model: "MiniMax-H3", prompt: "valid prompt",
      inputArtifacts: [{ path: imagePath, mediaType: "image", role: "reference_image" }],
      parameters: { durationSeconds: 5, aspectRatio: "9:16" }
    },
    output: path.join(root, "sensitive.mp4")
  }), (error) => {
    assert.match(error.message, /output new_sensitive/u);   // 原文保留
    const described = describeProviderError({ provider: "MiniMax", payload: error.message });
    assert.equal(described?.code, "1027");
    assert.match(providerErrorDisplayText(described), /输出内容涉敏被拦截/u);
    assert.match(providerErrorDisplayText(described), /换一个表述重新生成/u);
    return true;
  });
});

// worker 在生产里是 spawn 出来的子进程：模块求值到 `if (isMainModule()) await main();`
// 就把整个请求跑完，文件后半部分的模块级 const 还在暂时性死区里。而所有既有测试都用
// import 调用 executeGenericHttpWorker，那条路会先把整个模块求值完，于是完全测不到。
// 实测代价：把两个数组字面量提成模块常量后，子进程路径每次都抛
// "Cannot access 'MINIMAX_RESOLUTIONS' before initialization"，连过两个提交没被发现。
test("worker 以子进程运行时模块常量不在暂时性死区里", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-subprocess-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const imagePath = path.join(root, "ref.png");
  await fs.writeFile(imagePath, "image");
  // 音频素材必须一起带上：请求体里每多一条按模块常量分派的支路，就多一处可能落进
  // 暂时性死区。这个守卫原来只带图片，于是 MINIMAX_AUDIO_MIME_ALIASES 从没在子进程里
  // 被求值过——真实批量 6/6 镜头全挂在 "Cannot access ... before initialization" 上时，
  // 它一声不响地通过了。凡是走 buildMiniMaxH3VideoBody 的分支都要在这里被走到。
  const audioPath = path.join(root, "voice.mp3");
  await fs.writeFile(audioPath, "audio");
  const requestPath = path.join(root, "request.json");
  await fs.writeFile(requestPath, JSON.stringify({
    taskId: "subprocess",
    capability: "all_reference_video_generation",
    outputKey: "preview.subprocess",
    provider: "MiniMax",
    model: "MiniMax-H3",
    prompt: "有效提示词",
    inputArtifacts: [
      { path: imagePath, mediaType: "image", role: "reference_image" },
      { path: audioPath, mediaType: "audio", role: "reference_audio" }
    ],
    parameters: { durationSeconds: 5, aspectRatio: "16:9" }
  }));
  const writeConfig = async (name, resolution) => {
    const configPath = path.join(root, name);
    await fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
      providerPreset: "minimax_h3_video_generation",
      videoModel: "MiniMax-H3",
      apiKey: "test-key",
      resolution
    }));
    return configPath;
  };
  const runWorker = async (configPath, output) => {
    try {
      await execFileAsync(process.execPath, [
        path.resolve("workers/generic-http-worker.mjs"),
        "--config", configPath,
        "--request", requestPath,
        "--output", path.join(root, output),
        "--receipt", path.join(root, `${output}.receipt.json`)
      ]);
      return "";
    } catch (error) {
      return String(error.stderr || error.message || "");
    }
  };

  // 合法配置：必须走到网络层才失败，而不是死在模块初始化上。
  const ok = await runWorker(await writeConfig("good.json", "768P"), "good.mp4");
  assert.doesNotMatch(ok, /before initialization/u);
  assert.match(ok, /fetch failed|ECONNREFUSED|ECONNRESET/u);

  // 收严的校验在子进程里同样生效，而不是被 TDZ 顶掉。
  const bad = await runWorker(await writeConfig("bad.json", "1080K"), "bad.mp4");
  assert.match(bad, /resolution 只支持 768P 或 2K/u);
  assert.doesNotMatch(bad, /before initialization/u);
});

// MP3 被 MiniMax 拒收过一次真实批量（6/6 镜头全失败，2013
// `content[3].audio_url: invalid param: audio format ".mpeg" not allowed`）。
// 根因不是文件有问题：worker 从 .mp3 推出 IANA 标准的 audio/mpeg，而 MiniMax 按 MIME
// 子类型反推扩展名，读成了 ".mpeg"。它的白名单是 WAV / MP3，所以标签必须写成 audio/mp3。
test("MP3 参考音频以 MiniMax 认得的 audio/mp3 提交，字节一个不改", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-audio-mime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  const audioPath = path.join(root, "meow.mp3");
  const audioBytes = Buffer.from("ID3-meow-reference-bytes", "utf8");
  await fs.writeFile(imagePath, "image");
  await fs.writeFile(audioPath, audioBytes);

  let postedBody = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return res.end(JSON.stringify({ task_id: "audio-task" }));
    }
    res.end(JSON.stringify({ task: { id: "audio-task", status: "failed", error: { code: "1", message: "stop" } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: `http://127.0.0.1:${port}/v2/video_generation`,
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key",
    pollIntervalMs: 5
  }));

  // 轮询结果不是本用例关心的，只看提交出去的请求体。
  await executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "audio-mime",
      capability: "all_reference_video_generation",
      outputKey: "preview.audio",
      provider: "MiniMax",
      model: "MiniMax-H3",
      prompt: "芙芙猫抬头喵喵叫。",
      inputArtifacts: [
        { path: imagePath, mediaType: "image", role: "reference_image" },
        { path: audioPath, mediaType: "audio", role: "reference_audio" }
      ],
      parameters: { durationSeconds: 5, aspectRatio: "9:16" }
    },
    output: path.join(root, "audio.mp4")
  }).catch(() => {});

  const audioItem = (postedBody?.content || []).find((item) => item.type === "audio_url");
  assert.ok(audioItem, "请求体里应该有 audio_url");
  assert.match(audioItem.audio_url.url, /^data:audio\/mp3;base64,/u);
  // 标签之外一个字节都没变。
  assert.deepEqual(Buffer.from(audioItem.audio_url.url.split(",")[1], "base64"), audioBytes);
});

test("MiniMax 不收的音频格式当场说清楚，而不是换回一句 2013", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minimax-h3-audio-reject-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "image.png");
  const audioPath = path.join(root, "voice.m4a");
  await fs.writeFile(imagePath, "image");
  await fs.writeFile(audioPath, "m4a-bytes");

  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "http://127.0.0.1:1/v2/video_generation",
    providerPreset: "minimax_h3_video_generation",
    videoModel: "MiniMax-H3",
    apiKey: "test-key"
  }));

  await assert.rejects(() => executeGenericHttpWorker({
    config: configPath,
    request: {
      taskId: "audio-reject",
      capability: "all_reference_video_generation",
      outputKey: "preview.reject",
      provider: "MiniMax",
      model: "MiniMax-H3",
      prompt: "valid prompt",
      inputArtifacts: [
        { path: imagePath, mediaType: "image", role: "reference_image" },
        { path: audioPath, mediaType: "audio", role: "reference_audio" }
      ],
      parameters: { durationSeconds: 5, aspectRatio: "9:16" }
    },
    output: path.join(root, "reject.mp4")
  }), /只接受 WAV 与 MP3[\s\S]*audio\/mp4/u);
});
