export function buildShotFrameMultiImagePrompt(prompt, totalCount) {
  const basePrompt = String(prompt || "").trim();
  const count = Math.max(1, Math.floor(Number(totalCount) || 1));
  if (count <= 1) return basePrompt;
  return [
    basePrompt,
    `本次必须一次性输出 ${count} 张候选图，作为同一镜头的备选首尾帧。`,
    `这 ${count} 张图必须保持同一镜头目标、角色、道具、画风、画幅、景别、机位、主体位置和动作状态一致，只允许表情细节、手指细节或光影有极轻微差异。`,
    "不要把候选图画成不同分镜，不要改变角色站位、镜头距离、视角或动作阶段。",
    `不要只输出 1 张图。最终返回图片数量必须等于 ${count} 张。`
  ].join("\n\n");
}
