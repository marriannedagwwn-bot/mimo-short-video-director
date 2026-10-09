// 在一份既有提示词上做逐字锚点替换，派生出另一份提示词（例如「从剧情开始」的完整剧情、
// 锁定台词的分镜设计）。原提示词函数一个字不改，派生版本跟着原文走，不另抄一份。
//
// 锚点必须恰好出现一次：原提示词改了措辞、锚点找不到或变成多处时直接抛错，而不是
// 静默发出一份半新半旧的提示词。这类失败只会出现在开发期，由测试覆盖。

export class PromptAnchorError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromptAnchorError";
  }
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function replaceExactlyOnce(text, anchor, replacement, label = "提示词") {
  const source = String(text);
  const needle = String(anchor);
  if (!needle) throw new PromptAnchorError(`${label}：锚点不能为空`);
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new PromptAnchorError(`${label}：锚点应恰好出现 1 次，实际 ${count} 次：${needle.slice(0, 40)}`);
  }
  const index = source.indexOf(needle);
  return source.slice(0, index) + String(replacement) + source.slice(index + needle.length);
}

// 整行替换：找到唯一包含 needle 的那一行，把整行换成 replacementLine。
// 用于行内有动态插值（例如目标时长）、无法逐字写出完整锚点的情况。
export function replaceLineContainingExactlyOnce(text, needle, replacementLine, label = "提示词") {
  const lines = String(text).split("\n");
  const hits = lines.flatMap((line, index) => (line.includes(needle) ? [index] : []));
  if (hits.length !== 1) {
    throw new PromptAnchorError(`${label}：包含锚点的行应恰好 1 行，实际 ${hits.length} 行：${String(needle).slice(0, 40)}`);
  }
  lines[hits[0]] = String(replacementLine);
  return lines.join("\n");
}

// 把 startAnchor（含）到 endAnchor（不含）之间的整段换掉。两个锚点都必须恰好出现一次，
// 且 start 在 end 之前。
export function replaceSectionExactlyOnce(text, startAnchor, endAnchor, replacement, label = "提示词") {
  const source = String(text);
  for (const anchor of [startAnchor, endAnchor]) {
    const count = countOccurrences(source, anchor);
    if (count !== 1) {
      throw new PromptAnchorError(`${label}：段落锚点应恰好出现 1 次，实际 ${count} 次：${String(anchor).slice(0, 40)}`);
    }
  }
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor);
  if (end <= start) throw new PromptAnchorError(`${label}：段落结束锚点必须在开始锚点之后`);
  return source.slice(0, start) + String(replacement) + source.slice(end);
}
