import test from "node:test";
import assert from "node:assert/strict";
import { storyboardRevisionPrompt } from "../src/storyboard-revision-prompt.js";

const context = { input: {}, plan: {}, items: [{ ref: "R1" }], keptContent: [] };

// 2026-10-19：这里原来有一句 replace，想把「两份既有分镜中的当前一份」改成「一份既有分镜」，
// 但 storyboard-editorial.js 的原文从一开始就是「这次固定本轮完整分镜」，那句替换从没匹配上过，
// 静默什么都没做。4.0 修订只修一份分镜，原文已经是这个意思，所以删掉了那句替换。
test("修订提示词只说修一份分镜，不出现「两份既有分镜」", () => {
  const prompt = storyboardRevisionPrompt(context);
  assert.equal(prompt.includes("两份既有分镜"), false);
  assert.ok(prompt.includes("这次固定本轮完整分镜，修稿不重做全片。"));
  assert.ok(prompt.includes("## 先判断问题，再修改\n- 先区分用户明确的修订要求与外部编辑意见。"), "锚点后的补充规则仍然插进去了");
});

test("修订提示词不含审阅的开头一句，测试替身不会把它认成审阅", () => {
  const prompt = storyboardRevisionPrompt(context);
  assert.ok(prompt.startsWith("你是这部短片的分镜修稿编辑。"));
  assert.equal(prompt.includes("你是分镜修稿编辑"), false);
});
