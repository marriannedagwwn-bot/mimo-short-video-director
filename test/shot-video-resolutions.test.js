import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalShotVideoResolution,
  isShotVideoResolutionOption,
  shotVideoCodeDefaultResolution,
  shotVideoResolutionOptions
} from "../public/shot-video-resolutions.js";
import {
  KLING_VIDEO_MODELS,
  MINIMAX_VIDEO_MODELS,
  SEEDANCE_VIDEO_MODELS,
  resolveShotVideoRequestResolution,
  shotVideoConfiguredResolution,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "../src/shot-video-providers.js";

// 镜头视频的生成分辨率（2026-10-10）：清单只有 public/shot-video-resolutions.js 一份，按用户的决定不放 4k。

test("每个已登记的视频模型都有确定的清单；代码默认值在清单里；不放 4k", () => {
  const expected = {
    "doubao-seedance-2-0-260128": ["480p", "720p", "1080p"],
    "doubao-seedance-2-0-fast-260128": ["480p", "720p"],
    "doubao-seedance-2-0-mini-260615": ["480p", "720p"],
    "MiniMax-H3": ["768P", "2K"],
    "kling-v3": ["720p", "1080p"],
    "kling-v2-1": []
  };
  const registered = [
    ...SEEDANCE_VIDEO_MODELS.map((model) => ["Seedance", model]),
    ...MINIMAX_VIDEO_MODELS.map((model) => ["MiniMax", model]),
    ...KLING_VIDEO_MODELS.map((model) => ["Kling", model])
  ];
  assert.deepEqual(registered.map(([, model]) => model).sort(), Object.keys(expected).sort(), "新登记的模型要在这里写清楚分辨率清单");
  for (const [provider, model] of registered) {
    const options = shotVideoResolutionOptions(provider, model);
    assert.deepEqual([...options], expected[model], model);
    assert.equal(options.some((value) => /4k/iu.test(value)), false, `${model} 不放 4k`);
    const fallback = shotVideoCodeDefaultResolution(provider, model);
    if (options.length) assert.ok(options.includes(fallback), `${model} 的代码默认值 ${fallback} 必须在清单里`);
    else assert.equal(fallback, "");
  }
  assert.deepEqual([...shotVideoResolutionOptions("VideoHTTP", "custom-model")], []);
});

test("请求里的值严格比较（大小写也要对）；配置里的值大小写不敏感、还原成清单里的写法", () => {
  assert.equal(isShotVideoResolutionOption("Seedance", "doubao-seedance-2-0-260128", "1080p"), true);
  assert.equal(isShotVideoResolutionOption("Seedance", "doubao-seedance-2-0-260128", "1080P"), false);
  assert.equal(isShotVideoResolutionOption("Seedance", "doubao-seedance-2-0-fast-260128", "1080p"), false);
  assert.equal(isShotVideoResolutionOption("MiniMax", "MiniMax-H3", "2k"), false);
  assert.equal(isShotVideoResolutionOption("MiniMax", "MiniMax-H3", "2K"), true);
  assert.equal(isShotVideoResolutionOption("Seedance", "doubao-seedance-2-0-260128", ""), false);
  assert.equal(isShotVideoResolutionOption("Seedance", "doubao-seedance-2-0-260128", null), false);
  assert.equal(canonicalShotVideoResolution("Seedance", "doubao-seedance-2-0-260128", " 720P "), "720p");
  assert.equal(canonicalShotVideoResolution("MiniMax", "MiniMax-H3", "768p"), "768P");
  assert.equal(canonicalShotVideoResolution("Seedance", "doubao-seedance-2-0-260128", "4k"), "", "4k 已不在清单里");
  assert.equal(canonicalShotVideoResolution("Kling", "kling-v2-1", "720p"), "", "没有分辨率参数的模型一律对不上");
});

test("没选分辨率时的默认值与来源：环境变量、代码默认、配置文件、不支持；配错时给出错误，不替换", () => {
  assert.deepEqual(shotVideoConfiguredResolution("Seedance", "doubao-seedance-2-0-260128", { env: {} }),
    { value: "720p", source: "code_default", error: "" });
  assert.deepEqual(shotVideoConfiguredResolution("MiniMax", "MiniMax-H3", { env: { MINIMAX_VIDEO_RESOLUTION: "768p" } }),
    { value: "768P", source: "env", error: "" });
  assert.deepEqual(shotVideoConfiguredResolution("Kling", "kling-v2-1", { env: { KLING_VIDEO_RESOLUTION: "1080p" } }),
    { value: "", source: "unsupported", error: "" });
  assert.deepEqual(shotVideoConfiguredResolution("Seedance", "doubao-seedance-2-0-260128", { env: {}, configPath: "/tmp/provider.json" }),
    { value: "", source: "config_file", error: "" }, "只知道配置文件路径时要等读到文件才知道");
  assert.deepEqual(shotVideoConfiguredResolution("Seedance", "doubao-seedance-2-0-260128", {
    env: { SEEDANCE_VIDEO_RESOLUTION: "480p" }, fileConfig: { resolution: "1080p" }, configPath: "/tmp/provider.json"
  }), { value: "1080p", source: "config_file", error: "" }, "配置文件优先于环境变量");
  const fast = shotVideoConfiguredResolution("Seedance", "doubao-seedance-2-0-fast-260128", { env: { SEEDANCE_VIDEO_RESOLUTION: "1080p" } });
  assert.equal(fast.value, "");
  assert.equal(fast.source, "env");
  assert.match(fast.error, /SEEDANCE_VIDEO_RESOLUTION=1080p 不适用于 doubao-seedance-2-0-fast-260128（只支持 480p \/ 720p）/u);
  // 运行时配置的默认值与清单一致（原来写死的字面量换成了共享模块）。
  assert.equal(shotVideoRuntimeConfig("Seedance", {}).resolution, "720p");
  assert.equal(shotVideoRuntimeConfig("MiniMax", {}).resolution, "2K");
  assert.equal(shotVideoRuntimeConfig("Kling", {}, "kling-v3").resolution, "720p");
});

test("/api/health 用的供应商目录给出每个模型的默认分辨率", () => {
  const catalog = shotVideoProviderCatalog({ SEEDANCE_VIDEO_RESOLUTION: "1080p", MINIMAX_VIDEO_RESOLUTION: "768P" });
  assert.deepEqual(catalog.Seedance.resolutionDefaults["doubao-seedance-2-0-260128"], { value: "1080p", source: "env", error: "" });
  assert.match(catalog.Seedance.resolutionDefaults["doubao-seedance-2-0-fast-260128"].error, /不适用于/u);
  assert.deepEqual(catalog.MiniMax.resolutionDefaults["MiniMax-H3"], { value: "768P", source: "env", error: "" });
  assert.deepEqual(catalog.Kling.resolutionDefaults["kling-v3"], { value: "720p", source: "code_default", error: "" });
  assert.deepEqual(catalog.Kling.resolutionDefaults["kling-v2-1"], { value: "", source: "unsupported", error: "" });
});

test("校验一次请求：合法就用；不在清单、模型没有这个参数、默认值配错，各自报错（400）", () => {
  const seedance = { provider: "Seedance", model: "doubao-seedance-2-0-260128", env: {} };
  assert.deepEqual(resolveShotVideoRequestResolution({ ...seedance, input: { resolution: "1080p" } }),
    { value: "1080p", explicit: true, source: "request" });
  assert.deepEqual(resolveShotVideoRequestResolution({ ...seedance, input: {} }),
    { value: "720p", explicit: false, source: "code_default" });
  const rejects = (options, code) => assert.throws(() => resolveShotVideoRequestResolution(options),
    (error) => error.code === code && error.httpStatus === 400, code);
  rejects({ ...seedance, input: { resolution: "1080P" } }, "SHOT_VIDEO_RESOLUTION_INVALID");
  rejects({ ...seedance, input: { resolution: "" } }, "SHOT_VIDEO_RESOLUTION_INVALID");
  rejects({ ...seedance, input: { resolution: null } }, "SHOT_VIDEO_RESOLUTION_INVALID");
  rejects({ ...seedance, input: { resolution: "4k" } }, "SHOT_VIDEO_RESOLUTION_INVALID");
  rejects({ provider: "Seedance", model: "doubao-seedance-2-0-fast-260128", env: {}, input: { resolution: "1080p" } }, "SHOT_VIDEO_RESOLUTION_INVALID");
  rejects({ provider: "Kling", model: "kling-v2-1", env: {}, input: { resolution: "720p" } }, "SHOT_VIDEO_RESOLUTION_UNSUPPORTED");
  rejects({ provider: "VideoHTTP", model: "", env: {}, input: { resolution: "720p" } }, "SHOT_VIDEO_RESOLUTION_UNSUPPORTED");
  rejects({ provider: "Seedance", model: "doubao-seedance-2-0-fast-260128", env: { SEEDANCE_VIDEO_RESOLUTION: "1080p" }, input: {} },
    "SHOT_VIDEO_RESOLUTION_DEFAULT_INVALID");
  // 默认值配错时，明确选一个合法值照样能生成。
  assert.deepEqual(resolveShotVideoRequestResolution({
    provider: "Seedance", model: "doubao-seedance-2-0-fast-260128", env: { SEEDANCE_VIDEO_RESOLUTION: "1080p" }, input: { resolution: "480p" }
  }), { value: "480p", explicit: true, source: "request" });
  // 没有分辨率参数的模型、没选：照常通过，值为空。
  assert.deepEqual(resolveShotVideoRequestResolution({ provider: "Kling", model: "kling-v2-1", env: {}, input: {} }),
    { value: "", explicit: false, source: "unsupported" });
});
