// 镜头视频的输出分辨率（2026-10-10）：每个视频模型能选哪些、代码默认值是什么，只在这里定义一份。
// 页面、服务端与 worker 共用，与 all-reference-limits.js 同一做法；本文件不 import 任何模块。
//
// 取值按各供应商接口的写法：Seedance、可灵是小写（720p），MiniMax 是 768P / 2K。
// 清单沿用此前 worker 里的值，按用户的决定去掉了 4k：4k 没有核对到官方文档（官方页面需要
// JavaScript，读不到；第三方说法不一），而且 4k 文件大，长镜头容易超过「用上一镜抽帧」对上一镜
// 视频 50MB 的上限，下一镜就接不上。可灵 v2.1 与自定义 VideoHTTP 没有分辨率参数，清单为空。

// 只存在这个标签页的 sessionStorage 里：{ "供应商:模型": "分辨率" }。与模型选择同一层，不长期保存。
export const SHOT_VIDEO_RESOLUTION_STORAGE_KEY = "directorShotVideoResolutions";

const SEEDANCE_STANDARD = Object.freeze(["480p", "720p", "1080p"]);
// fast、mini 型号只到 720p。
const SEEDANCE_LIGHT = Object.freeze(["480p", "720p"]);
const MINIMAX_H3 = Object.freeze(["768P", "2K"]);
const KLING_V3 = Object.freeze(["720p", "1080p"]);
const NO_RESOLUTION = Object.freeze([]);

// 没配环境变量、也没有供应商配置文件时用的值，与加选项之前 worker 的缺省值相同。
const CODE_DEFAULTS = Object.freeze({ Seedance: "720p", Kling: "720p", MiniMax: "2K" });

// provider 传规整后的供应商名（Seedance / Kling / MiniMax / VideoHTTP）。
export function shotVideoResolutionOptions(provider, model) {
  const name = String(model || "").trim();
  if (provider === "Seedance") return /-(?:fast|mini)-/iu.test(name) ? SEEDANCE_LIGHT : SEEDANCE_STANDARD;
  if (provider === "MiniMax") return MINIMAX_H3;
  if (provider === "Kling") return /^kling-v3$/iu.test(name) ? KLING_V3 : NO_RESOLUTION;
  return NO_RESOLUTION;
}

export function shotVideoCodeDefaultResolution(provider, model) {
  return shotVideoResolutionOptions(provider, model).length ? CODE_DEFAULTS[provider] : "";
}

// 请求里带来的值：必须逐字是清单里的写法（大小写也要对），不猜、不改写。
export function isShotVideoResolutionOption(provider, model, value) {
  return typeof value === "string" && shotVideoResolutionOptions(provider, model).includes(value);
}

// 环境变量与供应商配置文件里的值：大小写不敏感（保持此前对「720P」「768p」的容忍），
// 返回清单里的写法；对不上返回空串，由调用方明确报错。
export function canonicalShotVideoResolution(provider, model, raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  return shotVideoResolutionOptions(provider, model).find((option) => option.toLowerCase() === value) || "";
}
