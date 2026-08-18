import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMiniMaxH3BasePrompt,
  MINIMAX_H3_BASE_DIAGNOSTIC_CODES,
  MiniMaxH3PromptError
} from "../src/minimax-h3-prompt.js";

// 实测依据：一次真实 H3 Plan 的七个镜头里，六个带对白，只有一个写了说话人 ID；
// non_diegetic_music 还剩一处 "emotional peak"。两条规则 Prompt 里都已写明，
// 措辞压不住，因此改为确定性校验。两者都无语义歧义，纯字符串判定。
function prompt({ description, music = "Sparse piano notes at a slow tempo, fading out." }) {
  return [
    `integrated_multimodal_description: ${description}`,
    "overall_soundscape: Soft footsteps cross the packed earth while a light breeze moves through the grass.",
    `non_diegetic_music: ${music}`
  ].join("\n");
}

const run = (text, dialogueTexts = []) => assertMiniMaxH3BasePrompt(text, {
  durationSeconds: 5,
  path: "shot.videoPrompt",
  dialogueTexts
});

test("<d> 块前有说话人 ID 时通过", () => {
  assert.doesNotThrow(() => run(
    prompt({ description: "[Shot 1] In a 2D-animated style, the girl (S1) says <d>[Chinese] 嗷呜</d> softly." }),
    ["嗷呜"]
  ));
});

test("<d> 块前缺说话人 ID 必须失败并指名镜号", () => {
  assert.throws(
    () => run(
      prompt({ description: "[Shot 1] In a 2D-animated style, she says <d>[Chinese] 嗷呜</d> with a helpless tone." }),
      ["嗷呜"]
    ),
    (error) => error instanceof MiniMaxH3PromptError
      && /缺少稳定说话人 ID/u.test(error.message)
      && error.details?.[0]?.code === MINIMAX_H3_BASE_DIAGNOSTIC_CODES.SPEAKER_ID_MISSING
  );
});

test("同时发声的复合 ID (S1,S2) 合法", () => {
  assert.doesNotThrow(() => run(
    prompt({ description: "[Shot 1] In a 2D-animated style, the two children (S1,S2) shout <d>[Chinese] 一起走</d> together." }),
    ["一起走"]
  ));
});

test("说话人 ID 只在前一个分镜段出现时，后一段仍必须自带", () => {
  assert.throws(
    () => run(
      prompt({
        description: "[Shot 1] In a 2D-animated style, the girl (S1) says <d>[Chinese] 嗷呜</d>."
          + " [Shot 2] At 00:03.000, the camera cuts to the boy, who says <d>[Chinese] 哇</d>."
      }),
      ["嗷呜", "哇"]
    ),
    (error) => error instanceof MiniMaxH3PromptError && /\[Shot 2\]/u.test(error.message)
  );
});

test("<d> 正文自带句号不会让判定按句切错", () => {
  assert.doesNotThrow(() => run(
    prompt({ description: "[Shot 1] In a 2D-animated style, the man (S1) says <d>[Chinese] 我在下一站下车。</d> and turns away." }),
    ["我在下一站下车。"]
  ));
});

test("无对白时不做说话人判定", () => {
  assert.doesNotThrow(() => run(
    prompt({ description: "[Shot 1] In a 2D-animated style, a wide shot reveals the river at golden hour." })
  ));
});

test("non_diegetic_music 出现抽象情绪词必须失败", () => {
  assert.throws(
    () => run(prompt({
      description: "[Shot 1] In a 2D-animated style, a wide shot reveals the river.",
      music: "The acoustic guitar reaches an emotional peak with bright chords at a moderate tempo."
    })),
    (error) => error instanceof MiniMaxH3PromptError
      && /抽象情绪词/u.test(error.message)
      && error.details?.[0]?.code === MINIMAX_H3_BASE_DIAGNOSTIC_CODES.MUSIC_ABSTRACT_MOOD
  );
});

test("合法音色词不被误伤，N/A 放行", () => {
  assert.doesNotThrow(() => run(prompt({
    description: "[Shot 1] In a 2D-animated style, a wide shot reveals the river.",
    music: "A warm analog synth pad at a slow tempo, joined by bright plucked strings that soften at the end."
  })));
  assert.doesNotThrow(() => run(prompt({
    description: "[Shot 1] In a 2D-animated style, a wide shot reveals the river.",
    music: "N/A"
  })));
});
