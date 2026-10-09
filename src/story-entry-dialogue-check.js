// 「从剧情开始 · 粘贴完整故事」的台词核对。
//
// 只回答一个确定性问题：Full Story 与 4.0 分镜里的每一句台词，去掉标点和空白之后，
// 能不能在用户原文里原样找到。归一化与 Animation Plan 台词核对是同一个函数
// （normalizeDialogueChars），不另写一套。
//
// 这是只读报告：不改任何 Artifact、不拦截流程、不落盘。现在还没有真实命中率数据，
// 在最贵的一次调用之后加硬闸门违反仓库的经验规则（见 docs/待解决项.md）。
// 反方向（原文的每句台词是否都被用上）要从自由文本里猜哪些字是台词，这里不做。
import { normalizeDialogueChars } from "./validation.js";
import { STORY_MODE_FULL_TEXT } from "../public/story-entry.js";

export function storyEntryDialogueFaithfulness({ storySource = null, fullStory = null, animationPlan = null } = {}) {
  if (storySource?.storyMode !== STORY_MODE_FULL_TEXT) return { applicable: false, checked: 0, missing: [] };
  const source = normalizeDialogueChars(storySource.storyText);
  const lines = [];
  for (const scene of Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : []) {
    for (const item of Array.isArray(scene?.dialogue) ? scene.dialogue : []) {
      lines.push({ artifact: "fullStory", location: String(scene?.sceneId || ""), speaker: item?.speaker, text: item?.line });
    }
  }
  for (const shot of Array.isArray(animationPlan?.shotPlan) ? animationPlan.shotPlan : []) {
    for (const beat of Array.isArray(shot?.beats) ? shot.beats : []) {
      for (const item of Array.isArray(beat?.dialogue) ? beat.dialogue : []) {
        lines.push({ artifact: "animationPlan", location: String(shot?.shotId || ""), speaker: item?.speaker, text: item?.text });
      }
    }
  }
  const missing = [];
  let checked = 0;
  for (const line of lines) {
    const normalized = normalizeDialogueChars(line.text);
    if (!normalized) continue;
    checked += 1;
    if (!source.includes(normalized)) {
      missing.push({
        artifact: line.artifact,
        location: line.location,
        speaker: String(line.speaker || ""),
        text: String(line.text || "")
      });
    }
  }
  return { applicable: true, checked, missing };
}
