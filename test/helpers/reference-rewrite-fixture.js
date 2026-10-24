// 主题变体（剧本格式，2026-10-24）测试共用的一份合格模型输出：四篇，每篇都写出固定角色名「咕嘎」。
export function validRewrite(overrides = {}) {
  return {
    original: {
      summary: " 大雨里，咕嘎在便利店屋檐下躲雨。 ",
      dialogue: [
        { time: "0:11", speaker: "阿姨", line: "小咕嘎，怎么在外面啊？快进来。", picture: "阿姨在店里理货" },
        { time: "0:31", speaker: "咕嘎", line: "咕嘎", picture: "" }
      ],
      strengths: ["咕嘎自己也在躲雨。"]
    },
    variants: ["热红薯", "收被子", "伞下面还有伞", "摔开的西瓜"].map((title, index) => ({
      title,
      direction: `第 ${index + 1} 个角度，约 55 秒。`,
      summary: "一段连贯的概要。",
      script: "**1　外　街口　傍晚　（0–6 秒）**\n\n咕嘎冲进画面。\n\n> 咕嘎：咕嘎嘎！"
    })),
    ...overrides
  };
}
