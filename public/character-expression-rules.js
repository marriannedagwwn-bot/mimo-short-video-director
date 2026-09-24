// 角色表情规则：用户手写的「情绪 → 可见特征」映射。
//
// 与 story-duration.js 的 targetDurationSeconds 同规格：**只作为目标进入提示词**，
// 不写入任何 Artifact、不参与派生、不进 digest、不 stale 任何已签发内容。
//
// 为什么不放进 creatorProfile：creatorProfile 恰好三个字段，整体进
// src/character-boundary.js 的 sourceDigest，任何一字变动都会作废全局角色边界并
// 要求重跑整条工作流（public/app.js 的 handleProfileInput）。表情是表演表现，
// 不是角色身份事实，不该承受那个代价。发色那类身份事实则相反，就该写进
// creatorProfile.fixedCharacter 并承受重跑——两者刻意分开。
//
// 它只管表情与表演表现，**不能改变角色身份、外观或物种**：
// fixedCharacterBoundary 始终优先。若模型把它写成外观事实并命中禁止特征，
// ensureCharacterReferenceMatchesBoundary 仍会在成片渲染前硬失败。

// 浏览器侧的存档 key。**独立于 directorProfile**：那是 profile() 的存档，而
// profile() 整体进 character-boundary 的 sourceDigest，混进去会让「改一句表情」
// 作废全局角色边界并要求重跑整条工作流。
export const CHARACTER_EXPRESSION_RULES_STORAGE_KEY = "directorCharacterExpressionRules";

// 上限是有意保守的：它注入的两个提示词本身已超过 30k 字符。
export const CHARACTER_EXPRESSION_RULES_MAX_CHARS = 1000;

// 请求侧校验：只拦明显非法的值（类型错误、超长），不裁决"这条表情规则写得好不好"。
// 空字符串合法——等同于不设置。
export function isValidCharacterExpressionRules(value) {
  return typeof value === "string" && value.length <= CHARACTER_EXPRESSION_RULES_MAX_CHARS;
}

// 注入前的归一：去掉首尾空白。空串表示未设置，调用方据此整段省略提示词文案，
// 以保证不传时的提示词与历史逐字一致。
export function normalizeCharacterExpressionRules(value) {
  return typeof value === "string" ? value.trim() : "";
}
