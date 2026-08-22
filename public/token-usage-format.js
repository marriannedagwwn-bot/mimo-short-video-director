/**
 * 阶段 token 消耗的展示格式化。
 *
 * 服务端把每个请求的 usage 挂在响应信封上，浏览器按「用户点一次按钮」的阶段累加
 * （启动 AI 导演是 5 个请求，剧情和镜头各 1 个），结束时把这里的后缀追加到该阶段
 * 已有的状态文案后面。纯展示，不参与任何业务判断。
 */

/** 把同一阶段内多个请求的 usage 合并成一个。任一请求缺单价，整段就算不出金额。 */
export function mergeStageUsage(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (item) => item && typeof item === "object"
  );
  if (!list.length) return null;
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let costCny = 0;
  let costKnown = true;
  for (const item of list) {
    calls += Number(item.calls) || 0;
    promptTokens += Number(item.promptTokens) || 0;
    completionTokens += Number(item.completionTokens) || 0;
    totalTokens += Number(item.totalTokens) || 0;
    if (item.costKnown && Number.isFinite(Number(item.costCny))) {
      costCny += Number(item.costCny);
    } else {
      costKnown = false;
    }
  }
  return {
    calls,
    promptTokens,
    completionTokens,
    totalTokens,
    costCny: costKnown ? Math.round(costCny * 100) / 100 : null,
    costKnown
  };
}

function formatTokens(value) {
  return Number(value).toLocaleString("en-US");
}

/** 金额不足一分时显示 `< ¥0.01`，避免把真实花费显示成 ¥0.00。 */
export function formatCostCny(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "";
  if (amount === 0) return "¥0.00";
  if (amount < 0.01) return "< ¥0.01";
  return `¥${amount.toFixed(2)}`;
}

/**
 * 返回追加到状态行的后缀，例如 ` · 本次消耗 12,345 tokens · 约 ¥0.12`。
 * 没有 usage、或本阶段一次模型调用都没发生时返回空串——演示模式文案保持原样。
 */
export function formatStageUsageSuffix(usage) {
  if (!usage || typeof usage !== "object") return "";
  const totalTokens = Number(usage.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return "";
  const parts = [`本次消耗 ${formatTokens(totalTokens)} tokens`];
  if (usage.costKnown) {
    const cost = formatCostCny(usage.costCny);
    if (cost) parts.push(`约 ${cost}`);
  }
  return ` · ${parts.join(" · ")}`;
}
