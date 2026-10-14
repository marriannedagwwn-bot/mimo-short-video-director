import test from "node:test";
import assert from "node:assert/strict";
import { renderStoryboard } from "../public/storyboard-render.js";
import { dotList, factSheet } from "../public/fact-sheet.js";

// 页面渲染（2026-10-14 UI 精修）：分镜卡片按来源分块显示，这里只锁住「每条原文恰好显示一次」
// 与「模型写的文字一律转义」两件事；版式本身靠截图验收，不写镜像实现的测试。
const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const helpers = {
  escape, block: (label, body) => `<section data-label="${label}">${body}</section>`,
  resultHeader: () => "", renderCharacters: () => "", renderVideo: () => "", videoLabel: "测试模型"
};
const count = (html, text) => html.split(text).length - 1;

function plan({ editorial = { repairs: [], guidance: [] }, ...extra } = {}) {
  return {
    title: "被角不许跑", viewingIntent: "看小白子钻进被套帮忙。",
    productionStrategy: { targetAspectRatio: "16:9", visualStyle: "日系 2.5D", artStyle: "", backgroundMusicMode: "none" },
    visualDesign: {
      characters: [{ name: "小白子", appearance: "", designedDetails: ["深蓝色小皮鞋"] }],
      locations: [{ name: "奶奶家的卧室", sourceSceneIds: ["S1"], layout: "床尾朝画面左", lighting: "白天暖光" }],
      props: [{ name: "被套", appearanceAndSupport: "浅米色碎花" }]
    },
    characterRegistry: { protagonist: { name: "小白子", identity: "日系校园风女学生", traits: ["浅灰蓝色长发"] }, supportingCharacters: [] },
    shotPlan: [{
      shotId: "A01", sourceSceneIds: ["S1"], durationSeconds: 5, storyPurpose: "被角总往外跑", emotionalTarget: "好奇",
      transitionIn: { type: "start", description: "开场" },
      beats: [{
        startSeconds: 0, endSeconds: 5, sourceSceneIds: ["S1"], location: "床边", characters: ["小白子", "奶奶"],
        framing: "中景", camera: "固定", visibleAction: "小白子按了一下被子", soundDesign: "",
        dialogue: [{ speaker: "奶奶", text: "咕嘎？", source: "offscreen", timing: "开头" }]
      }],
      continuityOut: "被子又蓬起来", acceptanceCriteria: ["按下去的小坑可辨"]
    }],
    adaptations: [], blockedIssues: [], editorial, ...extra
  };
}

test("修订与引导说明：修订说明不再重复，终审仍指出的问题单独成组，每条原文恰好显示一次", () => {
  // 服务端的 guidance = 初审引导 + 修订说明 + 终审引导 + 最后一轮审阅的问题（src/storyboard-workflow.js）。
  const editorial = {
    initialReview: { strengths: [], guidance: ["初审引导"], items: [{ ref: "I1", reportedProblem: "初审问题" }] },
    repairs: [{ ref: "I1", status: "applied", note: "修订说明", changes: [{}, {}] }],
    finalReview: { strengths: [], guidance: ["终审引导"], items: [{ ref: "I1", reportedProblem: "终审仍有的问题" }] },
    guidance: ["初审引导", "修订说明", "终审引导", "终审仍有的问题"]
  };
  const html = renderStoryboard(plan({ editorial }), helpers);
  for (const text of editorial.guidance) assert.equal(count(html, text), 1, text);
  assert.match(html, /审阅后的修订[\s\S]*已修订[\s\S]*改了 2 处[\s\S]*修订说明/u);
  assert.match(html, /终审复查仍指出的问题（没有再修订）[\s\S]*终审仍有的问题/u);
  assert.match(html, /引导说明[\s\S]*初审引导[\s\S]*终审引导/u);
  // 页面原来只显示 guidance；不在 guidance 里的审阅问题不额外冒出来。
  assert.equal(count(html, "初审问题"), 0);
});

test("修订与引导说明：没有终审时写「没有改正文」，未采用的修订带上原因", () => {
  const editorial = {
    initialReview: { strengths: [], guidance: [], items: [{ ref: "I1", reportedProblem: "初审问题" }] },
    repairs: [{ ref: "I1", status: "rejected", reason: "找不到这段原文", note: "想改但没改成" }],
    finalReview: null,
    guidance: ["想改但没改成", "初审问题"]
  };
  const html = renderStoryboard(plan({ editorial }), helpers);
  assert.match(html, /本条未采用[\s\S]*想改但没改成[\s\S]*未采用的原因[\s\S]*找不到这段原文/u);
  assert.match(html, /审阅指出、没有改正文的问题[\s\S]*初审问题/u);
  assert.equal(count(html, "想改但没改成"), 1);
});

test("修订与引导说明：演示与旧 Plan 没有审阅结构时退回一个列表，空的照旧说明", () => {
  const demo = renderStoryboard(plan({ editorial: { initialReview: null, repairs: [], finalReview: null, guidance: ["演示模式：未进行真实 AI 分镜审查或修订。"] } }), helpers);
  assert.match(demo, /引导说明[\s\S]*演示模式：未进行真实 AI 分镜审查或修订。/u);
  assert.match(renderStoryboard(plan(), helpers), /本轮没有额外修订说明。/u);
  const blocked = renderStoryboard(plan({ blockedIssues: ["核心矛盾解决不了"] }), helpers);
  assert.match(blocked, /无法在授权范围内解决的问题[\s\S]*核心矛盾解决不了/u);
});

test("分镜里模型写的文字一律转义，镜头卡保留生成视频的入口", () => {
  const html = renderStoryboard(plan({
    editorial: { repairs: [], guidance: ["<b>引导</b>"] },
    adaptations: [{ sourceSceneIds: ["S1"], original: "<i>原文</i>", change: "改成", reason: "理由" }]
  }), helpers);
  assert.doesNotMatch(html, /<b>引导<\/b>|<i>原文<\/i>/u);
  assert.match(html, /&lt;i&gt;原文&lt;\/i&gt;/u);
  assert.match(html, /<button[^>]*data-generate-shot-video="A01"[^>]*>用 测试模型 生成此镜头视频<\/button>/u);
  assert.match(html, /data-shot-video-result="A01"/u);
  assert.match(html, /奶奶（画外）：/u, "画外台词照旧标出来");
  // 用户 2026-10-14 决定删掉：角色参考卡已经列了每个角色，这一块是重复的。
  assert.doesNotMatch(html, /角色事实与本片设计/u);
  assert.match(html, /场景与道具[\s\S]*奶奶家的卧室[\s\S]*床尾朝画面左[\s\S]*被套[\s\S]*浅米色碎花/u);
});

test("dotList / factSheet：空的不输出，内容转义，空属性行不留空标签", () => {
  assert.equal(dotList([], escape), "");
  assert.equal(dotList(["", "  "], escape), "");
  assert.equal(dotList("说温和的口语", escape), `<span class="dot-list"><span>说温和的口语</span></span>`, "单个字符串也当一条");
  assert.equal(dotList(["长发", "<x>"], escape), `<span class="dot-list"><span>长发</span><span>&lt;x&gt;</span></span>`);
  const sheet = factSheet([{ name: "<奶奶>", note: "配角", facts: [{ label: "性格", html: "慈爱" }, { label: "外观", html: "" }] }], escape);
  assert.match(sheet, /&lt;奶奶&gt;<small>配角<\/small>/u);
  assert.match(sheet, /<dt>性格<\/dt><dd>慈爱<\/dd>/u);
  assert.doesNotMatch(sheet, /外观/u);
});
