// 输出 token 上限的唯一一份：配置默认值、客户端内的 JSON 重试、coordinator 的重试都从这里取。
//
// 2026-09-24 起流式的 Qwen / MiMo 不再用固定上限当「死循环刹车」——那道刹车换成了
// src/output-degeneration.js 的逐字重复检测——所以默认值放到各家实测接受的最大值：
// - MiMo 131072：页面提供的 5 个型号（v2.5、v2.5-pro、v2.6-flash、v2.6-pro、v2.6-pro-ultraspeed）
//   2026-09-24 用极小请求带 max_completion_tokens=131072 实测全部 200；v2.6-pro 不带该参数时默认也是它。
//   MiMo 的额度包含推理 token。
// - Qwen 65536：在用的 qwen3.7-max / qwen3.7-plus 2026-09-23 实测接受（千问的 max_tokens 看起来不含推理）。
// - DeepSeek 非流式、中途看不到内容，仍用 config 里的 32768，不在这里抬。
// - 三家都实测接受的最大值是 65536，给不知道供应商是谁的 coordinator 重试用。

export const MIMO_OUTPUT_TOKEN_CEILING = 131072;
export const QWEN_OUTPUT_TOKEN_CEILING = 65536;
export const SHARED_OUTPUT_TOKEN_CEILING = 65536;

/**
 * 重试时抬高输出上限：按倍数增长、不超过 ceiling，**绝不低于当前值**。
 * 此前三处重试函数都把结果夹在固定上限里（MiMo 与 coordinator 32768），默认值一抬到 131072，
 * 重试反而会把上限压回 32768。当前值不是正数（请求里没写）时原样返回，让客户端默认值生效。
 */
export function growOutputTokenLimit(value, { factor, ceiling }) {
  const current = Number(value);
  if (value === null || value === undefined || !Number.isFinite(current) || current <= 0) return value;
  return Math.max(current, Math.min(ceiling, Math.ceil(current * factor)));
}
