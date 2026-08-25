import test from "node:test";
import assert from "node:assert/strict";
import { buildCharacterReferenceImagePrompt } from "../public/character-reference-prompt.js";
import { buildCharacterReferenceImagePrompt as buildServerCharacterReferenceImagePrompt } from "../src/jimeng-client.js";

const characterReference = {
  characterName: "小白子",
  appearancePrompt: "小白子，q版狼耳少女，蓝色眼睛，浅蓝色连衣裙。"
};

const visualBible = {
  overallStyle: "日系治愈 2.5D",
  animationStyle: "手绘赛璐璐上色",
  colorPalette: ["奶油白", "薄荷绿", "暖黄"],
  lighting: "清晨侧逆光，暖调漫射",
  cameraLanguage: "以中景与特写为主",
  worldRules: []
};

test("角色参考图提示词按模板 1 的字段顺序接入 visualBible", () => {
  const prompt = buildCharacterReferenceImagePrompt({ characterReference, count: 1, visualBible });

  // 全片视觉锁定必须进入角色图——此前它完全不知道全片是什么调子。
  assert.match(prompt, /光线：清晨侧逆光，暖调漫射/u);
  assert.match(prompt, /整体风格：日系治愈 2\.5D/u);
  assert.match(prompt, /动画风格：手绘赛璐璐上色/u);
  assert.match(prompt, /色彩：奶油白 \/ 薄荷绿 \/ 暖黄/u);

  // 模板 1 顺序：时间与光线 → 主体外观 → 姿态 → 场景 → 风格色调 → 景别/取景/机位。
  const order = ["光线：", "角色外观：", "人物站立", "干净浅色背景", "整体风格：", "全身景别"];
  const positions = order.map((needle) => prompt.indexOf(needle));
  assert.equal(positions.every((position) => position >= 0), true, "模板 1 的字段应全部出现");
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "字段顺序应与模板 1 一致");

  // cameraLanguage 是镜头语言，不属于角色参考图的取景说明，不应被搬进来。
  assert.doesNotMatch(prompt, /以中景与特写为主/u);
});

test("没有 visualBible 时省略风格与光线，不编造，也不再出现水果摊残留", () => {
  const prompt = buildCharacterReferenceImagePrompt({ characterReference, count: 1 });
  assert.doesNotMatch(prompt, /光线：/u);
  assert.doesNotMatch(prompt, /整体风格：/u);
  assert.doesNotMatch(prompt, /色彩：/u);
  assert.doesNotMatch(prompt, /水果|摊位|杂乱街景/u);

  // 参考图本身的固定要求仍然完整保留。
  assert.match(prompt, /角色外观：小白子，q版狼耳少女/u);
  assert.match(prompt, /人物站立，全身入镜/u);
  assert.match(prompt, /全身景别，头顶到脚完整入镜，正面平视/u);

  // 多张候选的说明只在 count > 1 时出现。
  assert.doesNotMatch(prompt, /本次需要输出/u);
  assert.match(
    buildCharacterReferenceImagePrompt({ characterReference, count: 3 }),
    /本次需要输出 3 张候选图/u
  );
});

test("浏览器预览与服务端回退共用一份模板，且空外观各自按调用方语义处理", () => {
  // 用户看到并可编辑的文本，必须逐字等于服务端回退会生成的文本——两份副本漂移
  // 会让预览与实际发送的提示词不一致。
  for (const count of [1, 3]) {
    assert.equal(
      buildCharacterReferenceImagePrompt({ characterReference, count, visualBible }),
      buildServerCharacterReferenceImagePrompt(characterReference, count, visualBible)
    );
  }

  // 共享模块对空外观返回空串，由调用方决定语义；服务端回退仍然明确失败。
  assert.equal(buildCharacterReferenceImagePrompt({ characterReference: {}, count: 1 }), "");
  assert.throws(
    () => buildServerCharacterReferenceImagePrompt({}, 1),
    /角色参考提示词为空/u
  );
});
