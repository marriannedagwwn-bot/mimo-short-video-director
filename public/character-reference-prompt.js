// 角色参考图提示词。浏览器预览框与服务端回退路径共用这一份，避免两处模板漂移
// ——用户看到的必须就是实际发送的。
//
// 字段顺序按 docs/video-prompt-guide.md 模板 1：
//   [时间与光线]，[主体身份与外观]，[主体姿态与表情]。[场景与前后景动态]。
//   [风格与色调]。[景别]，[取景范围]，[机位角度]。
//
// 画风来自 4.0 分镜里服务端签发的 productionStrategy.artStyle
// （public/character-art-style.js），在「风格与色调」那一格写成「画风：……」；为空就省略。
// 第一行随有没有上传参考图变化：没上传时不能说「参考我上传的这张图片」。

import { normalizeCharacterArtStyle } from "./character-art-style.js";

const REFERENCE_SHEET_POSE = "人物站立，全身入镜，姿态自然，表情中性平和。";
const REFERENCE_SHEET_BACKGROUND = "画面只保留人物主体，干净浅色背景；不要出现其他人物、道具、场景细节或任何与角色无关的背景杂物。";
const REFERENCE_SHEET_FRAMING = "全身景别，头顶到脚完整入镜，正面平视，人物居中，适合作为后续动画的角色参考图。";

/**
 * Builds the prompt sent to the image model for a character reference sheet.
 * Returns an empty string when the character has no usable appearance text —
 * callers decide whether that is an input error or just an empty preview.
 */
export function buildCharacterReferenceImagePrompt({
  characterReference = {},
  count = 1,
  // 不传时按「已上传参考图」处理，与改动前逐字相同；调用方都应显式传入。
  withReferenceImage = true,
  artStyle = ""
} = {}) {
  const appearance = String(
    characterReference?.appearancePrompt
    || characterReference?.identity
    || characterReference?.characterName
    || ""
  ).trim();
  if (!appearance) return "";

  const style = normalizeCharacterArtStyle(artStyle);
  const total = Number(count) || 1;

  return [
    withReferenceImage ? "参考我上传的这张图片，生成一张角色参考图。" : "生成一张角色参考图。",
    `角色外观：${appearance}`,
    REFERENCE_SHEET_POSE,
    REFERENCE_SHEET_BACKGROUND,
    style ? `画风：${style}` : "",
    REFERENCE_SHEET_FRAMING,
    total > 1
      ? `本次需要输出 ${total} 张候选图，每张都保持同一个角色设定，但姿态和细节可以轻微变化。`
      : ""
  ].filter(Boolean).join("\n");
}
