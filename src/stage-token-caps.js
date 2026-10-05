// 阶段输出上限按供应商分开记（2026-10-05）。
//
// 阶段默认值只按「默认供应商」（有千问就是千问，否则 MiMo）算一份。用户在页面上按阶段换成别家时，
// 浏览器只发 {provider, model}，resolveStage 于是沿用默认供应商那一档：换成 DeepSeek 实际发 65536/131072
// （契约是非流式 DeepSeek 仍 32768——它没有复读检测，上限是唯一的刹车），换成 MiMo 被压到 65536
// （契约是 131072）。修法是用同一份阶段规则给每家各算一次，只取上限，挂在阶段设置上，由
// resolveStage 按实际供应商取用。按用户 2026-10-05 的选择：全部按各家自己的上限。
export function withProviderTokenCaps(defaults = {}, tablesByProvider = {}) {
  return Object.fromEntries(Object.entries(defaults).map(([stage, setting]) => {
    const byProvider = {};
    for (const [provider, table] of Object.entries(tablesByProvider)) {
      const value = Number(table?.[stage]?.maxCompletionTokens);
      if (Number.isFinite(value) && value > 0) byProvider[provider] = Math.round(value);
    }
    return [stage, Object.keys(byProvider).length ? { ...setting, maxCompletionTokensByProvider: byProvider } : setting];
  }));
}
