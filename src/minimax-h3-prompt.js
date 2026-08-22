/**
 * MiniMax H3 的运行时约束。
 *
 * H3 曾经有一套专属的三段式提示词方言（Base / Ref2VA 六段、受控词表、Context-IR）。
 * 现在 Plan 只产出一种 Seedance 中文自然语言提示词，同一条提示词直接交给
 * Seedance 2.0 与 MiniMax H3，所以那套方言连同它的校验与段落修复一并下线。
 *
 * 只剩这一条：H3 的时长是供应商硬约束，不是提示词写法问题。项目自己把单镜
 * 统一在 4–6 秒（两家的交集），这里仍按供应商公开的 4–15 秒整数校验，
 * 且绝不钳制、补长或缩短已签发的时长。
 */

export class MiniMaxH3PromptError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "MiniMaxH3PromptError";
    this.details = Array.isArray(details) ? details : [];
  }
}

export function assertMiniMaxH3Duration(value, path = "durationSeconds") {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new MiniMaxH3PromptError(
      `${path} 使用 MiniMax H3 时必须是 4–15 秒整数，不能静默改写时长。`,
      [{
        code: "MINIMAX_H3_DURATION_INVALID",
        path,
        reason: "MiniMax H3 duration must be an integer from 4 through 15 seconds and must not be clamped.",
        expected: { type: "integer", minimum: 4, maximum: 15 },
        actual: value
      }]
    );
  }
  return duration;
}
