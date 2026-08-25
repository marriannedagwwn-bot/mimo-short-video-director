// 角色参考图提示词。浏览器预览框与服务端回退路径共用这一份，避免两处模板漂移
// ——用户看到的必须就是实际发送的（与 shot-frame-prompt.js 同一模式）。
//
// 字段顺序按 docs/video-prompt-guide.md 模板 1：
//   [时间与光线]，[主体身份与外观]，[主体姿态与表情]。[场景与前后景动态]。
//   [风格与色调]。[景别]，[取景范围]，[机位角度]。
//
// 之所以要把 visualBible 传进来：videoPrompt 197/197 都写了全片风格色调、
// 188/197 写了光线，而给它当视觉锚点的这张角色图此前完全不知道全片是什么调子。
// visualBible 缺失时对应行整体省略，不编造光线或风格。

const REFERENCE_SHEET_POSE = "人物站立，全身入镜，姿态自然，表情中性平和。";
const REFERENCE_SHEET_BACKGROUND = "画面只保留人物主体，干净浅色背景；不要出现其他人物、道具、场景细节或任何与角色无关的背景杂物。";
const REFERENCE_SHEET_FRAMING = "全身景别，头顶到脚完整入镜，正面平视，人物居中，适合作为后续动画的角色参考图。";

function visualBibleStyleLine(visualBible = {}) {
  const parts = [
    visualBible.overallStyle ? `整体风格：${visualBible.overallStyle}` : "",
    visualBible.animationStyle ? `动画风格：${visualBible.animationStyle}` : "",
    Array.isArray(visualBible.colorPalette) && visualBible.colorPalette.length
      ? `色彩：${visualBible.colorPalette.join(" / ")}`
      : ""
  ].filter(Boolean);
  return parts.join("；");
}

/**
 * Builds the prompt sent to the image model for a character reference sheet.
 * Returns an empty string when the character has no usable appearance text —
 * callers decide whether that is an input error or just an empty preview.
 */
export function buildCharacterReferenceImagePrompt({
  characterReference = {},
  count = 1,
  visualBible = null
} = {}) {
  const appearance = String(
    characterReference?.appearancePrompt
    || characterReference?.identity
    || characterReference?.characterName
    || ""
  ).trim();
  if (!appearance) return "";

  const bible = visualBible && typeof visualBible === "object" ? visualBible : {};
  const lighting = String(bible.lighting || "").trim();
  const styleLine = visualBibleStyleLine(bible);
  const total = Number(count) || 1;

  return [
    "参考我上传的这张图片，生成一张角色参考图。",
    lighting ? `光线：${lighting}` : "",
    `角色外观：${appearance}`,
    REFERENCE_SHEET_POSE,
    REFERENCE_SHEET_BACKGROUND,
    styleLine,
    REFERENCE_SHEET_FRAMING,
    total > 1
      ? `本次需要输出 ${total} 张候选图，每张都保持同一个角色设定，但姿态和细节可以轻微变化。`
      : ""
  ].filter(Boolean).join("\n");
}
