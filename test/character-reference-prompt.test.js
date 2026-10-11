import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCharacterReferenceImagePrompt } from "../public/character-reference-prompt.js";
import {
  buildCharacterReferenceImagePrompt as buildServerCharacterReferenceImagePrompt,
  buildJimengImageRequestBody
} from "../src/jimeng-client.js";

const characterReference = {
  characterName: "小白子",
  appearancePrompt: "小白子，q版狼耳少女，蓝色眼睛，浅蓝色连衣裙。"
};

// 旧 2.0/3.0 Plan 的 visualBible（光线、整体风格、色彩）已于 2026-10-11 随旧分镜删除；
// 4.0 分镜没有 visualBible，画风来自 productionStrategy.artStyle（见 character-art-style.test.js）。
const legacyVisualBible = {
  overallStyle: "日系治愈 2.5D",
  animationStyle: "手绘赛璐璐上色",
  colorPalette: ["奶油白", "薄荷绿", "暖黄"],
  lighting: "清晨侧逆光，暖调漫射",
  cameraLanguage: "以中景与特写为主",
  worldRules: []
};

test("旧 Plan 的 visualBible 不再进入角色参考图提示词：传不传都逐字相同，模板 1 其余字段顺序不变", () => {
  const prompt = buildCharacterReferenceImagePrompt({ characterReference, count: 1, visualBible: legacyVisualBible });
  assert.equal(prompt, buildCharacterReferenceImagePrompt({ characterReference, count: 1 }));
  assert.doesNotMatch(prompt, /光线：|整体风格：|动画风格：|色彩：|以中景与特写为主/u);

  // 模板 1 顺序：主体外观 → 姿态 → 场景 → 景别/取景/机位。
  const order = ["角色外观：", "人物站立", "干净浅色背景", "全身景别"];
  const positions = order.map((needle) => prompt.indexOf(needle));
  assert.equal(positions.every((position) => position >= 0), true, "模板 1 的字段应全部出现");
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "字段顺序应与模板 1 一致");
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
      buildCharacterReferenceImagePrompt({ characterReference, count }),
      buildServerCharacterReferenceImagePrompt(characterReference, count)
    );
  }

  // 共享模块对空外观返回空串，由调用方决定语义；服务端回退仍然明确失败。
  assert.equal(buildCharacterReferenceImagePrompt({ characterReference: {}, count: 1 }), "");
  assert.throws(
    () => buildServerCharacterReferenceImagePrompt({}, 1),
    /角色参考提示词为空/u
  );
});

// 金标准由删除旧分镜之前（HEAD ba4c500）的同两个模块对同样的 4.0 输入算出（4.0 分镜没有 visualBible，
// 服务端三处回退当时传的是 null）。删掉 visualBible 分支与参数之后，浏览器预览、服务端回退与
// 即梦请求体都必须与它逐字相同——有没有上传参考图、有没有画风、几张候选都覆盖到。
const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/character-reference-prompt-4.0-golden.json", import.meta.url), "utf8"));

test("4.0 角色参考图提示词与删除 visualBible 之前逐字相同（浏览器预览与服务端回退）", () => {
  assert.ok(golden.prompts.length >= 24);
  for (const row of golden.prompts) {
    const characterReference = golden.refs[row.refKey];
    const label = JSON.stringify({ refKey: row.refKey, count: row.count, options: row.options });
    assert.equal(buildCharacterReferenceImagePrompt({ characterReference, count: row.count, ...row.options }), row.expected, label);
    assert.equal(buildServerCharacterReferenceImagePrompt(characterReference, row.count, row.options), row.expected, label);
  }
});

// 两个角色参考图入口（Durable 任务与 SSE 端点）都只传单张 referenceImageDataUrl 或不传；
// imageField 两种写法（image / images）都覆盖到。
test("4.0 角色参考图的即梦请求体与删除 visualBible、负面词回执和多图分支之前逐字相同", () => {
  assert.ok(golden.bodies.length >= 12);
  assert.deepEqual([...new Set(golden.bodies.map((row) => row.configKey))].sort(), ["image", "images"]);
  for (const row of golden.bodies) {
    const input = { characterReference: golden.refs[row.refKey], count: row.input.count };
    if (row.input.image) input.referenceImageDataUrl = "data:image/png;base64,AA==";
    if (Object.hasOwn(row.input, "artStyle")) input.artStyle = row.input.artStyle;
    assert.equal(
      JSON.stringify(buildJimengImageRequestBody(golden.configs[row.configKey], input)),
      JSON.stringify(row.expected),
      JSON.stringify({ configKey: row.configKey, refKey: row.refKey, ...row.input })
    );
  }
});
