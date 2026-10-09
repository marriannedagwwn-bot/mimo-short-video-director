// 角色画风（2026-10-09）：全片统一的画面风格，例如「二维日系动画」。
//
// 它接替「设定创作宇宙」里原来的「角色表情规则」那一栏。由用户在页面上填写，生成 4.0 分镜时
// 随请求发给服务端，服务端把它写进 productionStrategy.artStyle（模型写不到）；之后分镜设计、
// 单镜视频提示词和角色参考图提示词都按它来。已签发的分镜保持签发时的画风，改这一栏只影响
// 下一次生成的分镜。
//
// 为什么不放进 creatorProfile：creatorProfile 恰好三个字段，整体进角色边界的 sourceDigest，
// 改一个字就会作废全局角色边界并要求重跑整条工作流。画风是成片的呈现方式，不是角色身份事实，
// 不该承受那个代价（与原来的角色表情规则同一理由）。
//
// 起因：4.0 分镜此前没有任何画风，角色参考图提示词里也就没有，固定角色写「八岁女孩……」时
// 即梦出了写实照片，Seedance 2.0 把它当真人拒收（docs/待解决项.md 第 17 条）。

// 浏览器侧的存档 key。独立于 directorProfile（那是 creatorProfile 的存档）。
export const CHARACTER_ART_STYLE_STORAGE_KEY = "directorCharacterArtStyle";

// 首次使用、没有存档时页面填的默认值。服务端不补默认值：请求没带就是不指定。
export const DEFAULT_CHARACTER_ART_STYLE = "二维日系动画";

// 页面下拉里的预设；用户也可以自己写。
export const CHARACTER_ART_STYLE_PRESETS = Object.freeze(["二维日系动画", "三维卡通动画", "水彩绘本", "黏土定格动画"]);

// 一句画风描述足够；它会逐字出现在每条单镜提示词里，太长会挤占提示词。
export const CHARACTER_ART_STYLE_MAX_CHARS = 200;

// 请求侧校验：只拦类型错误与超长，不裁决画风写得好不好。空字符串合法，表示不指定。
export function isValidCharacterArtStyle(value) {
  return typeof value === "string" && value.trim().length <= CHARACTER_ART_STYLE_MAX_CHARS;
}

// 去掉首尾空白，并把中间的换行与连续空白压成一个空格：画风要逐字出现在提示词里，
// 换行会让「逐字包含」的校验和用户看到的预览对不上。空串表示不指定。
export function normalizeCharacterArtStyle(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}
