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
// Claude（2026-10-19）：官方模型表写四个型号（opus-5-5 / sonnet-5-5 / haiku-5-5 / fable-5-1）同步接口
// 最大输出都是「128K tokens」，官方流式示例写 max_tokens: 128000，取这个精确值。思考 token 计入这个上限。
// https://platform.claude.com/docs/en/about-claude/models/overview（2026-10-19 核对）
export const CLAUDE_OUTPUT_TOKEN_CEILING = 128000;

// 参考片分析单独默认 16384（2026-10-05），Qwen 与 MiMo 共用这一个数，仍可用
// QWEN_ANALYSIS_MAX_COMPLETION_TOKENS / MIMO_ANALYSIS_MAX_COMPLETION_TOKENS 覆盖。
// 依据是本机 Run 记录：09-01～09-07 的 20 次真实分析调用（qwen3.7-plus，另有 3 条 0 秒、无用量的 MiMo 记录不是真实调用，不计）completion 只有 2854–6929 token、
// 60–138 秒；而 10-05 一次 mimo-v2.6-pro 在 65536 上限下写了 18.3 万字、742 秒后才因截断失败——
// 那不是重复短句，复读检测抓不到，又没有总时长限制，能停下它的只剩上限。
// 正常产出距 16384 有两倍余量；MiMo 的额度含推理 token（那次推理约 5.7 千字），余量相应小一些。
// 分析走 generateValidatedJson（对客户端传 jsonRetryAttempts: 0），截断不重试、直接失败，所以这就是单次调用的硬上限。
export const ANALYSIS_OUTPUT_TOKEN_DEFAULT = 16384;

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
