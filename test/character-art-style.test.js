import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  CHARACTER_ART_STYLE_MAX_CHARS,
  CHARACTER_ART_STYLE_PRESETS,
  DEFAULT_CHARACTER_ART_STYLE,
  isValidCharacterArtStyle,
  normalizeCharacterArtStyle
} from "../public/character-art-style.js";
import { buildCharacterReferenceImagePrompt } from "../public/character-reference-prompt.js";
import {
  buildCharacterReferenceImagePrompt as buildServerCharacterReferenceImagePrompt,
  buildJimengImageRequestBody
} from "../src/jimeng-client.js";
import { WorkflowService } from "../src/workflow.js";
import { singleShotPromptInput } from "../src/storyboard-workflow.js";
import { ensureStoryboardPlan } from "../src/storyboard-contract.js";
import { shotPrompt, storyboardPrompt } from "../src/storyboard-prompts.js";
import { NO_BACKGROUND_MUSIC_SENTENCE } from "../src/validation.js";

const characterReference = { characterName: "小满", appearancePrompt: "小满，八岁女孩，齐耳短发，黄色雨衣，红色雨靴。" };

// ---- 画风本身 ----

test("角色画风：默认二维日系动画；空串表示不指定；换行与连续空白压成一个空格；只拦类型与超长", () => {
  assert.equal(DEFAULT_CHARACTER_ART_STYLE, "二维日系动画");
  assert.ok(CHARACTER_ART_STYLE_PRESETS.includes(DEFAULT_CHARACTER_ART_STYLE));
  assert.equal(normalizeCharacterArtStyle("  水彩\n绘本   风格 "), "水彩 绘本 风格");
  assert.equal(normalizeCharacterArtStyle(""), "");
  assert.equal(normalizeCharacterArtStyle(undefined), "");
  assert.equal(isValidCharacterArtStyle(""), true);
  assert.equal(isValidCharacterArtStyle("字".repeat(CHARACTER_ART_STYLE_MAX_CHARS)), true);
  assert.equal(isValidCharacterArtStyle("字".repeat(CHARACTER_ART_STYLE_MAX_CHARS + 1)), false);
  assert.equal(isValidCharacterArtStyle(42), false);
});

// ---- 角色参考图提示词 ----

test("角色参考图提示词：不传新参数时与改动前逐字相同（默认按已上传参考图、无画风）", () => {
  const prompt = buildCharacterReferenceImagePrompt({ characterReference, count: 1 });
  assert.equal(prompt.split("\n")[0], "参考我上传的这张图片，生成一张角色参考图。");
  assert.equal(prompt.includes("画风："), false);
});

test("角色参考图提示词：没上传图片时第一行不提上传；画风写在「风格与色调」那一格", () => {
  const prompt = buildCharacterReferenceImagePrompt({ characterReference, count: 1, withReferenceImage: false, artStyle: " 二维日系动画 " });
  const lines = prompt.split("\n");
  assert.equal(lines[0], "生成一张角色参考图。");
  assert.equal(prompt.includes("上传"), false);
  assert.ok(lines.includes("画风：二维日系动画"));
  // 模板 1 顺序：外观 → 姿态 → 背景 → 风格色调（画风）→ 景别。
  const order = ["角色外观：", "人物站立", "干净浅色背景", "画风：二维日系动画", "全身景别"].map((needle) => prompt.indexOf(needle));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
  // 上传了参考图：第一行照旧。
  assert.equal(buildCharacterReferenceImagePrompt({ characterReference, withReferenceImage: true, artStyle: "二维日系动画" }).split("\n")[0], "参考我上传的这张图片，生成一张角色参考图。");
});

test("角色参考图提示词：服务端回退与浏览器预览同一份模板", () => {
  for (const options of [{}, { withReferenceImage: false }, { withReferenceImage: false, artStyle: "水彩绘本" }, { withReferenceImage: true, artStyle: "三维卡通动画" }]) {
    assert.equal(
      buildServerCharacterReferenceImagePrompt(characterReference, 2, options),
      buildCharacterReferenceImagePrompt({ characterReference, count: 2, ...options })
    );
  }
});

test("即梦请求：没有参考图就不带 image 字段，回退提示词按文字设定出图并带画风", () => {
  const config = { model: "doubao-seedream-5-0-260128", imageField: "image", maxImages: 6 };
  const textOnly = buildJimengImageRequestBody(config, { characterReference, count: 1, artStyle: "二维日系动画" });
  assert.equal(Object.hasOwn(textOnly, "image"), false);
  assert.equal(Object.hasOwn(textOnly, "images"), false);
  assert.equal(textOnly.prompt.split("\n")[0], "生成一张角色参考图。");
  assert.ok(textOnly.prompt.includes("画风：二维日系动画"));
  const withImage = buildJimengImageRequestBody(config, { characterReference, count: 1, referenceImageDataUrl: "data:image/png;base64,AA==" });
  assert.equal(withImage.image, "data:image/png;base64,AA==");
  assert.equal(withImage.prompt.split("\n")[0], "参考我上传的这张图片，生成一张角色参考图。");
});

// ---- 4.0 分镜 ----

async function storyboardFixture(extra = {}) {
  const workflow = new WorkflowService();
  const source = {
    frames: Array.from({ length: 3 }, (_, timestamp) => ({ timestamp, dataUrl: "data:image/jpeg;base64,AA==" })),
    metadata: { name: "fixture", duration: 60, width: 1080, height: 1920 },
    creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "动画", constraints: "" },
    count: 4
  };
  const upstream = await workflow.run(source);
  const variant = upstream.themeVariants.variants[0];
  const fullStory = await workflow.createFullStory({ ...source, ...upstream, variant });
  const input = { ...source, ...upstream, variant, fullStory, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false, ...extra };
  const plan = await workflow.createAnimationPlan(input);
  return { workflow, input, plan };
}

const TARGET = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };

test("4.0 分镜：请求带画风就由服务端写进 productionStrategy.artStyle；不带就是空串", async () => {
  const styled = await storyboardFixture({ artStyle: "  二维日系动画 " });
  assert.equal(styled.plan.productionStrategy.artStyle, "二维日系动画");
  const plain = await storyboardFixture();
  assert.equal(plain.plan.productionStrategy.artStyle, "");
  // 画风是制作参数，不改变「赛道」那一格的含义。
  assert.equal(styled.plan.productionStrategy.visualStyle, "动画");
});

test("4.0 分镜：画风之前签发的分镜没有 artStyle 键，照常通过校验，单镜提示词输入也不多出画风", async () => {
  const { plan } = await storyboardFixture({ artStyle: "二维日系动画" });
  const old = structuredClone(plan);
  delete old.productionStrategy.artStyle;
  assert.doesNotThrow(() => ensureStoryboardPlan(old));
  const shotId = old.shotPlan[0].shotId;
  assert.equal(Object.hasOwn(singleShotPromptInput(old, shotId, TARGET), "artStyle"), false);
  assert.equal(singleShotPromptInput(plan, shotId, TARGET).artStyle, "二维日系动画");
  const broken = structuredClone(plan);
  broken.productionStrategy.artStyle = 7;
  assert.throws(() => ensureStoryboardPlan(broken), /制作参数无效/);
});

test("分镜设计与单镜提示词：有画风才多一句画风规则，没有画风时逐字不变", () => {
  const base = { durationWindow: { min: 51, max: 69 }, targetDurationSeconds: 60, targetAspectRatio: "16:9", fullStory: {} };
  const plainDesign = storyboardPrompt(base);
  const styledDesign = storyboardPrompt({ ...base, artStyle: "二维日系动画" });
  assert.equal(plainDesign.includes("画风："), false);
  assert.ok(styledDesign.includes("画风：全片统一为「二维日系动画」。visualDesign 里角色外观、地点与道具的描述都按这个画风来写"));
  // 差别只有这一句规则和冻结输入里的 artStyle 键：去掉两者，与没有画风时逐字相同。
  assert.equal(styledDesign.replace(/画风：全片统一为[^\n]*\n\n/u, "").replace(',"artStyle":"二维日系动画"', ""), plainDesign);
  const shotBase = { shot: {}, visualDesign: {}, characterReferences: [], targetAspectRatio: "16:9", visualStyle: "动画", characterExpressionRules: "", backgroundMusicMode: "none", target: TARGET };
  assert.equal(shotPrompt(shotBase).includes("画风："), false);
  assert.ok(shotPrompt({ ...shotBase, artStyle: "二维日系动画" }).includes("提示词里必须逐字写出「二维日系动画」"));
});

test("单镜提示词：演示模式把画风写在开头；真实调用漏写画风会被拦下并带诊断重试一次", async () => {
  const { workflow, plan } = await storyboardFixture({ artStyle: "二维日系动画" });
  const shotId = plan.shotPlan[0].shotId;
  const demo = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET });
  assert.ok(demo.videoPrompt.startsWith("画风：二维日系动画。"));

  const projected = singleShotPromptInput(plan, shotId, TARGET);
  const lines = projected.shot.beats.flatMap((beat) => beat.dialogue.map((line) => line.text));
  const body = `${lines.join(" ")} 阿岚在修理铺里抬头。\n${NO_BACKGROUND_MUSIC_SENTENCE}`;
  const responses = [{ videoPrompt: body }, { videoPrompt: `画风：二维日系动画。${body}` }];
  const requests = [];
  workflow.clients.MiMo = { generateJson: async (request) => { requests.push(request); return responses.shift(); } };
  workflow.stageDefaults.animationPlan = { provider: "MiMo", model: "test" };
  const live = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].prompt.includes("提示词里必须逐字写出「二维日系动画」"));
  assert.match(requests[1].prompt, /SHOT_PROMPT_ART_STYLE_MISSING/u);
  // 单镜写稿用自己的重试（2026-10-12）：不再叫模型「调整片段怎么分、beat 怎么切」。
  assert.ok(requests[1].prompt.includes("## 上一次的输出被确定性校验拦下了"));
  assert.ok(requests[1].prompt.includes("这一步只是翻译分镜"));
  assert.equal(requests[1].prompt.includes("片段怎么分"), false);
  assert.ok(live.videoPrompt.includes("二维日系动画"));
});

// ---- 请求链路：两条分镜输入链都透传画风（显式白名单，漏一处不会有运行时错误） ----

test("服务端两条分镜输入链都透传 artStyle，两个分镜路由都校验它", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.equal(server.match(/^\s*artStyle: input\.artStyle,$/gmu)?.length, 2);
  assert.equal(server.match(/assertCharacterArtStyleInput\(body\);/gu)?.length, 2);
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("artStyle: characterArtStyle(),"));
  assert.equal(/characterExpressionRules: characterExpressionRules\(\)/u.test(app), false, "页面不再发角色表情规则");
  assert.equal(app.includes("根据上传参考图生成"), false, "设为人物参考图的说明不再假定上传过参考图");
});
