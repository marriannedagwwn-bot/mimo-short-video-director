import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowService } from "../src/workflow.js";
import { NO_BACKGROUND_MUSIC_SENTENCE } from "../src/validation.js";
import { shotPrompt, shotPromptRetryPrompt, storyboardRetryPrompt } from "../src/storyboard-prompts.js";
import { shotVideoPromptViolations, singleShotPromptInput } from "../src/storyboard-workflow.js";
import { storyboardShotCharacterNames } from "../public/storyboard-plan.js";
import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";

// 4.0 单镜视频提示词按 ai-video-prompt 的写法组织（2026-10-12）。写法本身是提示词约束，
// 这里锁的是能确定性判定的部分：两条新判据（出镜角色名、素材编号）、单镜专用的重试、
// 演示稿与真实判据一致，以及「出镜角色名」与生成视频时挑参考图是同一个口径。

const TARGET = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };

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
  return { workflow, plan };
}

function beat(fields = {}) {
  return { startSeconds: 0, endSeconds: 3, sourceSceneIds: ["S1"], location: "院子", characters: [], framing: "中景",
    camera: "固定机位", visibleAction: "", dialogue: [], soundDesign: "", ...fields };
}

function line(speaker, text, source = "onscreen") {
  return { speaker, text, source, timing: "" };
}

const codesOf = (videoPrompt, projected) => shotVideoPromptViolations({ videoPrompt }, projected).map((issue) => issue.code);

function scriptedClient(workflow, responses) {
  const requests = [];
  workflow.clients.MiMo = { async requestCompletion(request) {
    requests.push(request);
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error(`第 ${requests.length} 次调用没有预置响应——预算被超用了`);
    if (next === "__TRUNCATED__") return { parsed: undefined, content: "{\"videoPrompt\":", finishReason: "length", requestId: "", usage: null, raw: "" };
    return { parsed: next, content: JSON.stringify(next), finishReason: "stop", requestId: "", usage: null, raw: JSON.stringify(next) };
  } };
  workflow.stageDefaults.animationPlan = { provider: "MiMo", model: "test" };
  return requests;
}

// 找一镜同时有出镜角色和台词，才能同时检验两条判据。
function shotWithDialogueAndCharacters(plan) {
  const shot = plan.shotPlan.find((entry) => entry.beats.some((row) => row.dialogue.length) && entry.beats.some((row) => row.characters.length));
  assert.ok(shot, "演示分镜里应有一镜同时有出镜角色和台词");
  return shot;
}

// ---- 判据 ----

test("出镜角色名：按全部 beat 的并集逐个要求、缺几个报几条；画外说话者不要求", () => {
  const projected = { backgroundMusicMode: "none", shot: { beats: [
    beat({ characters: ["小白子", "大白鹅"], dialogue: [line("大白鹅", "嘎")] }),
    beat({ startSeconds: 3, endSeconds: 6, characters: ["小鲸鱼", "小白子"], dialogue: [line("奶奶", "吃饭咯", "offscreen")] })
  ] } };
  assert.deepEqual(storyboardShotCharacterNames(projected.shot), ["小白子", "大白鹅", "小鲸鱼"]);
  const full = `小白子站在画面左边，大白鹅在右边叫：“嘎”。小鲸鱼从左边跑进来。画面外传来声音：“吃饭咯”。${NO_BACKGROUND_MUSIC_SENTENCE}`;
  assert.deepEqual(codesOf(full, projected), [], "奶奶只在画外发声，不要求写出名字");
  const issues = shotVideoPromptViolations({ videoPrompt: full.replaceAll("小白子", "她").replaceAll("小鲸鱼", "她") }, projected);
  assert.deepEqual(issues.map((issue) => issue.code), ["SHOT_PROMPT_CHARACTER_NAME_MISSING", "SHOT_PROMPT_CHARACTER_NAME_MISSING"]);
  assert.match(issues[0].reason, /「小白子」/u);
  assert.match(issues[1].reason, /「小鲸鱼」/u);
  assert.ok(issues.every((issue) => issue.path === "/videoPrompt"));
});

test("素材编号：@图片、参考图N、图片N、<Subject N> 一律拒，普通的「图片」「视频」不拒", () => {
  const projected = { backgroundMusicMode: "allowed", shot: { beats: [beat({ characters: ["阿岚"] })] } };
  for (const token of ["@图片1", "@ 视频", "@音频2", "参考图2", "参考视频1", "图片3", "<Subject 1>", "<Picture 2>"]) {
    assert.deepEqual(codesOf(`阿岚站在门口，${token}。`, projected), ["SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN"], token);
  }
  for (const plain of ["墙上贴着一张图片", "电视里在放视频", "参考上一镜的位置", "阿岚看了一眼图片"]) {
    assert.deepEqual(codesOf(`阿岚站在门口，${plain}。`, projected), [], plain);
  }
  const [issue] = shotVideoPromptViolations({ videoPrompt: "阿岚看向@图片1，又看向@图片1和参考图2。" }, projected);
  assert.match(issue.reason, /@图片1、参考图2/u, "同一个编号只列一次");
});

test("新判据排在原有四条之后：已经不合格的提示词，报出的第一条诊断不变", () => {
  const projected = { backgroundMusicMode: "none", artStyle: "二维日系动画",
    shot: { beats: [beat({ characters: ["阿岚"], dialogue: [line("阿岚", "我现在去。")] })] } };
  assert.deepEqual(codesOf("她说了句话，参考图1。", projected), [
    "SHOT_PROMPT_DIALOGUE_MISSING", "SHOT_PROMPT_BACKGROUND_MUSIC_SENTENCE", "SHOT_PROMPT_ART_STYLE_MISSING",
    "SHOT_PROMPT_CHARACTER_NAME_MISSING", "SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN"
  ]);
});

// ---- 写稿提示词与重试提示词 ----

test("写稿提示词：开头一句不变，写明切镜头与镜头不切换两种写法、素材清单由系统加；空分镜也能生成", () => {
  const text = shotPrompt({ shot: {}, visualDesign: {}, characterReferences: [], targetAspectRatio: "16:9", visualStyle: "动画",
    characterExpressionRules: "", backgroundMusicMode: "none", target: TARGET });
  assert.ok(text.startsWith("你是单镜视频提示词撰写者。"));
  for (const phrase of ["在第N秒的地方，切镜头，", "第N秒起，镜头不切换，", "素材清单", "不写 @图片/@视频/@音频、参考图N 之类的素材编号",
    "画面位置", "朝向", "不用他、她、它、其指代", "保持原位和姿势", "全片无背景音乐，只保留现场环境声与动作声。",
    "分镜没写位置的角色只写名字和在做什么，不补位置，也不补行进方向", "不是前景、后景", "从上一拍的构图直接开始的连续运镜",
    "不写“切镜头”或“镜头不切换”"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.equal(text.includes("画风："), false, "没有画风时不出现画风规则");
});

test("重试提示词：单镜写稿用自己的那份——列出全部诊断、只翻译不改分镜；截断另走一支；没有诊断退回原文", () => {
  const details = [
    { path: "/videoPrompt", code: "SHOT_PROMPT_DIALOGUE_MISSING", reason: "单镜提示词未逐字保留对白：嘎" },
    { path: "/videoPrompt", code: "SHOT_PROMPT_CHARACTER_NAME_MISSING", reason: "单镜提示词没有写出出镜角色的登记名「小白子」" }
  ];
  const body = shotPromptRetryPrompt({ originalPrompt: "原文", details });
  assert.ok(body.startsWith("原文"));
  assert.match(body, /- \/videoPrompt 单镜提示词未逐字保留对白：嘎（SHOT_PROMPT_DIALOGUE_MISSING）/u);
  assert.match(body, /- \/videoPrompt 单镜提示词没有写出出镜角色的登记名「小白子」（SHOT_PROMPT_CHARACTER_NAME_MISSING）/u);
  assert.ok(body.includes("这一步只是翻译分镜"));
  assert.equal(body.includes("片段怎么分"), false);
  const truncated = shotPromptRetryPrompt({ originalPrompt: "原文", truncated: true });
  assert.match(truncated, /因为太长被截断/u);
  assert.ok(truncated.includes("台词原话与角色名一个都不能少"));
  assert.equal(shotPromptRetryPrompt({ originalPrompt: "原文", details: [] }), "原文");
  // 诊断行格式只有一份：分镜各阶段的重试逐字照旧。
  assert.match(storyboardRetryPrompt({ originalPrompt: "原文", details }), /- \/videoPrompt 单镜提示词未逐字保留对白：嘎（SHOT_PROMPT_DIALOGUE_MISSING）/u);
});

// ---- 真实调用路径 ----

test("真实调用：同时漏写台词和角色名时，一次重试里两条都列出，第二次补齐就通过", async () => {
  const { workflow, plan } = await storyboardFixture({ artStyle: "二维日系动画" });
  const { shotId } = shotWithDialogueAndCharacters(plan);
  const projected = singleShotPromptInput(plan, shotId, TARGET);
  const names = storyboardShotCharacterNames(projected.shot);
  const lines = projected.shot.beats.flatMap((row) => row.dialogue.map((entry) => entry.text));
  const fixed = `画风：二维日系动画。${names.join("、")}。${lines.join("；")}${NO_BACKGROUND_MUSIC_SENTENCE}`;
  const requests = scriptedClient(workflow, [{ videoPrompt: `画风：二维日系动画。画面里一个人也没写。${NO_BACKGROUND_MUSIC_SENTENCE}` }, { videoPrompt: fixed }]);
  const result = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET });
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /SHOT_PROMPT_DIALOGUE_MISSING/u);
  assert.match(requests[1].prompt, /SHOT_PROMPT_CHARACTER_NAME_MISSING/u);
  assert.ok(requests[1].prompt.includes("这一步只是翻译分镜"));
  assert.equal(result.videoPrompt, fixed);
});

test("真实调用：两次都没过就失败，恰好 2 次调用，两次的诊断都在", async () => {
  const { workflow, plan } = await storyboardFixture({ artStyle: "二维日系动画" });
  const { shotId } = shotWithDialogueAndCharacters(plan);
  const bad = { videoPrompt: `画风：二维日系动画。@图片1 站着。${NO_BACKGROUND_MUSIC_SENTENCE}` };
  const requests = scriptedClient(workflow, [bad, bad]);
  const error = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET }).then(() => null, (err) => err);
  assert.ok(error, "两次都没过必须失败");
  assert.equal(requests.length, 2);
  const diagnostics = error.diagnostics || [];
  assert.deepEqual([...new Set(diagnostics.map((detail) => detail.metadata?.attempt))], [1, 2]);
  for (const code of ["SHOT_PROMPT_CHARACTER_NAME_MISSING", "SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN"]) {
    assert.deepEqual(diagnostics.filter((detail) => detail.code === code).map((detail) => detail.metadata?.attempt).filter((n, i, all) => all.indexOf(n) === i), [1, 2], code);
  }
});

test("真实调用：输出被截断时走单镜自己的截断分支", async () => {
  const { workflow, plan } = await storyboardFixture();
  const { shotId } = shotWithDialogueAndCharacters(plan);
  const projected = singleShotPromptInput(plan, shotId, TARGET);
  const fixed = `${storyboardShotCharacterNames(projected.shot).join("、")}。${projected.shot.beats.flatMap((row) => row.dialogue.map((entry) => entry.text)).join("；")}${NO_BACKGROUND_MUSIC_SENTENCE}`;
  const requests = scriptedClient(workflow, ["__TRUNCATED__", { videoPrompt: fixed }]);
  const result = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET });
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /因为太长被截断/u);
  assert.ok(requests[1].prompt.includes("台词原话与角色名一个都不能少"));
  assert.doesNotMatch(requests[1].prompt, /确定性校验拦下/u);
  assert.equal(result.videoPrompt, fixed);
});

// ---- 演示模式与一致性 ----

test("演示模式：每一镜都过同一份判据（有无画风、开关配乐四种组合）", async () => {
  for (const extra of [{}, { artStyle: "二维日系动画" }, { backgroundMusicEnabled: true }, { artStyle: "二维日系动画", backgroundMusicEnabled: true }]) {
    const { workflow, plan } = await storyboardFixture(extra);
    for (const { shotId } of plan.shotPlan) {
      const demo = await workflow.createShotVideoPrompt({ plan, shotId, planDigest: "digest", target: TARGET });
      assert.deepEqual(shotVideoPromptViolations({ videoPrompt: demo.videoPrompt }, singleShotPromptInput(plan, shotId, TARGET)), [], `${JSON.stringify(extra)} ${shotId}`);
    }
  }
  const { workflow, plan } = await storyboardFixture({ artStyle: "二维日系动画" });
  const first = await workflow.createShotVideoPrompt({ plan, shotId: plan.shotPlan[0].shotId, planDigest: "digest", target: TARGET });
  // 一句话修改按「找到唯一一段原文」改：演示稿里这两段各出现一次，测试夹具才找得到。
  assert.equal(first.videoPrompt.split("固定机位").length - 1, plan.shotPlan[0].beats.length);
  assert.equal(first.videoPrompt.split("二维日系动画").length - 1, 1);
  assert.ok(first.videoPrompt.startsWith("画风：二维日系动画。"));
});

test("出镜角色名与挑参考图是同一个口径：4.0 分镜按这组名字挑角色参考图", async () => {
  const shot = { beats: [beat({ characters: ["甲"] }), beat({ startSeconds: 3, endSeconds: 6, characters: ["乙", "甲"] })] };
  const references = ["甲", "乙", "丙"].map((characterName) => ({ characterName }));
  assert.deepEqual(storyboardShotCharacterNames(shot), ["甲", "乙"]);
  assert.deepEqual(shotRelatedCharacterReferences(shot, references).map((row) => row.characterName), ["甲", "乙"]);

  const { plan } = await storyboardFixture();
  const withImages = plan.characterReferencePrompts.map((row) => ({ ...row, referenceImageDataUrl: "data:image/png;base64,AA==" }));
  for (const entry of plan.shotPlan) {
    const picked = shotRelatedCharacterReferences(entry, withImages).map((row) => row.characterName);
    const named = storyboardShotCharacterNames(entry).filter((name) => withImages.some((row) => row.characterName === name));
    assert.deepEqual(new Set(picked), new Set(named), entry.shotId);
  }
});
