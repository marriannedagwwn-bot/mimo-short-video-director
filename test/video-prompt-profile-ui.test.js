import test from "node:test";
import assert from "node:assert/strict";
import { runtimePromptOverride } from "../public/video-prompt-profile-ui.js";

// 视频提示词 Profile / 方言（videoPromptProfile、minimax_h3、Seedance 无字幕后缀）已于 2026-10-11
// 随 3.0 分镜一并删除；这个模块只剩 runtimePromptOverride。

test("预览文本非空即作为本次运行时提示词覆盖提交", () => {
  const signed = "温暖治愈的手绘动画质感。小白子走过院子并挥手。";
  // 4.0 单镜提示词由服务端按当前模型编写，预览框里就是本次要发的提示词，非空即是本次运行的实际提示词。
  assert.equal(runtimePromptOverride(`${signed}\n禁止新增字幕。`), `${signed}\n禁止新增字幕。`);
  assert.equal(runtimePromptOverride(`  ${signed}  `), signed);
  assert.equal(runtimePromptOverride(""), "");
  assert.equal(runtimePromptOverride(null), "");
});
