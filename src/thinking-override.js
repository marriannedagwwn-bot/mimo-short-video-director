// 单次请求的思考开关（2026-10-09）。
//
// 三家文本客户端的思考开关原来都只有全局配置（MIMO_THINKING / QWEN_ENABLE_THINKING /
// DEEPSEEK_THINKING）。导演助手要在全局开着思考时让一条对话几秒出结果，所以给
// requestCompletion 加一个可选的 `thinking`，只有导演助手会传。
//
// 不传（undefined / null）返回 null，调用方照旧用全局配置，请求体逐字不变
// （test/text-client-thinking-override.test.js 用改动前算出的金标准锁住）。
// 只接受 "enabled" / "disabled"；别的值是调用方写错了，直接报错，不猜。
export function resolveThinkingOverride(value) {
  if (value === undefined || value === null) return null;
  if (value === "enabled" || value === "disabled") return value;
  throw new TypeError(`thinking 只能是 "enabled" 或 "disabled"，收到 ${JSON.stringify(value)}`);
}
