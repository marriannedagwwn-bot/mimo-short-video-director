import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import { validRewrite } from "./helpers/reference-rewrite-fixture.js";
import { referenceRewriteDraftStoryText } from "../public/reference-rewrite.js";
import {
  referenceRewriteDraftPickerHtml,
  referenceRewriteHint,
  referenceRewriteProgressText,
  referenceRewriteResultHtml,
  referenceRewriteTextIsDraft
} from "../public/reference-rewrite-ui.js";

// 参考片仿写（2026-10-24）的页面：按钮可用条件、结果面板、「用这一稿开拍」填粘贴框、
// 四稿只在页面内存里（不碰任何浏览器存储）。

const escape = (value) => String(value ?? "").replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
const content = () => ({ schemaVersion: "reference_rewrite/1.0", ...validRewrite(), transcript: "转写", materials: { fps: 2 }, model: { provider: "Claude", model: "claude-opus-5-5", effort: "xhigh", providerCalls: 2, rejectedAttempts: 1 } });
const current = (value) => ({ lineage: { artifactId: "referenceRewrite", status: "current", revision: "referenceRewrite-r1", contentDigest: "d".repeat(64), dependencies: [] }, content: value });

function storageSpy() {
  const writes = [];
  return { writes, storage: { getItem: () => null, setItem: (key) => writes.push(key), removeItem: () => {} } };
}

async function readyApp(options = {}) {
  const app = await loadAppUi(options);
  app.browserWorkspaceForTest.adopt({ id: "ws-test", generation: 1 });
  app.setSourceLoadingForTest(false);
  Object.assign(app.state, {
    mode: "live",
    referenceRewriteHealth: { available: true, reason: "", missing: [] },
    providers: { Claude: { configured: true }, MiMo: { configured: true } },
    modelStages: { ...app.state.modelStages, referenceRewrite: { provider: "Claude", model: "claude-opus-5-5", effort: "xhigh" } },
    file: { name: "撑伞.mp4", size: 1 },
    frames: [1, 2, 3],
    metadata: { name: "撑伞.mp4", duration: 51 }
  });
  app.elements.fixedCharacter.value = "咕嘎：企鹅连体衣小女孩";
  app.elements.vertical.value = "治愈";
  return app;
}

test("纯渲染：提示、进度、结果面板与四稿列表", () => {
  assert.match(referenceRewriteHint({ available: true, provider: "Claude", model: "claude-opus-5-5" }), /Claude · claude-opus-5-5.*约 12 分钟、约 1 美元/u);
  assert.equal(referenceRewriteHint({ available: false, reason: "外置盘没挂上" }), "外置盘没挂上");
  assert.match(referenceRewriteHint({ available: true, demo: true }), /演示模式/u);
  assert.equal(referenceRewriteProgressText({ status: "queued" }), "参考片仿写排队中…");
  assert.equal(referenceRewriteProgressText({ status: "running", progress: { step: "separate", stepIndex: 2, stepMax: 4 } }), "第 2/4 步 去配乐");
  assert.equal(referenceRewriteProgressText({ status: "running", progress: { step: "write", stepIndex: 4, stepMax: 4, reasoningChars: 1200 } }), "第 4/4 步 写四稿 · 推理中（已推理 1200 字）");

  const html = referenceRewriteResultHtml(content(), { escape });
  assert.equal(html.match(/data-reference-draft-use=/gu).length, 4);
  assert.match(html, /原片拆解/u);
  assert.match(html, /台词（2 句）/u);
  assert.match(html, /第 2 次调用的结果/u);
  assert.match(html, /data-reference-rewrite-download/u);
  assert.equal(referenceRewriteResultHtml(null, { escape }), "");
  const xss = content();
  xss.drafts[0].title = "<img src=x onerror=alert(1)>";
  assert.equal(referenceRewriteResultHtml(xss, { escape }).includes("<img"), false);

  const drafts = validRewrite().drafts;
  const picker = referenceRewriteDraftPickerHtml(drafts, { escape, currentText: referenceRewriteDraftStoryText(drafts[1]) });
  assert.equal(picker.match(/data-reference-draft-fill=/gu).length, 4);
  assert.match(picker, /aria-pressed="true">稿二 · 收被子/u);
  assert.equal(referenceRewriteTextIsDraft(drafts, ""), true);
  assert.equal(referenceRewriteTextIsDraft(drafts, referenceRewriteDraftStoryText(drafts[3])), true);
  assert.equal(referenceRewriteTextIsDraft(drafts, "我自己改过的字"), false);
});

test("按钮可用条件：本机工具、所选供应商、视频、固定角色缺一不可，缺什么写什么", async () => {
  const app = await readyApp();
  assert.deepEqual({ ...app.referenceRewriteReadiness() }, { ready: true, reason: "" });
  app.renderReferenceRewriteControls();
  assert.equal(app.elements.runReferenceRewrite.disabled, false);
  assert.match(app.elements.referenceRewriteHint.textContent, /Claude · claude-opus-5-5/u);

  app.state.referenceRewriteHealth = { available: false, reason: "参考片仿写用不了：Bandit 的 Python 不在" };
  app.renderReferenceRewriteControls();
  assert.equal(app.elements.runReferenceRewrite.disabled, true);
  assert.match(app.elements.referenceRewriteHint.textContent, /Bandit 的 Python 不在/u);
  app.state.referenceRewriteHealth = { available: true, reason: "" };

  app.state.providers = { Claude: { configured: false } };
  assert.match(app.referenceRewriteReadiness().reason, /用的是 Claude，但服务端没有配置它/u);
  app.state.providers = { Claude: { configured: true } };
  app.state.modelOverrides = { referenceRewrite: { provider: "DeepSeek", model: "deepseek-v4-flash" } };
  assert.match(app.referenceRewriteReadiness().reason, /只能用 Claude 或 MiMo/u);
  app.state.modelOverrides = {};
  app.state.frames = [];
  assert.match(app.referenceRewriteReadiness().reason, /重新上传同一个参考视频|先上传参考视频/u);
  app.state.frames = [1, 2, 3];
  app.elements.vertical.value = "";
  assert.match(app.referenceRewriteReadiness().reason, /固定角色和垂直赛道/u);
  app.elements.vertical.value = "治愈";
  app.state.entryMode = "story";
  assert.equal(app.referenceRewriteReadiness().ready, false);
});

test("模型设置：参考片仿写一栏只列 Claude 与 MiMo，别的阶段的规则不变", async () => {
  const app = await loadAppUi();
  assert.equal(app.providerAllowedForStage("Claude", "referenceRewrite"), true);
  assert.equal(app.providerAllowedForStage("MiMo", "referenceRewrite"), true);
  assert.equal(app.providerAllowedForStage("DeepSeek", "referenceRewrite"), false);
  assert.equal(app.providerAllowedForStage("Qwen", "referenceRewrite"), false);
  assert.equal(app.providerAllowedForStage("Claude", "analysis"), false, "原来四个看图阶段仍不能选 Claude");
  assert.equal(app.providerAllowedForStage("Claude", "fullStory"), true);
});

test("从 Run 读回四稿：面板显示原片拆解与四张稿件卡；换视频清空", async () => {
  const app = await readyApp();
  app.restoreRunArtifacts({ referenceRewrite: current(content()) });
  assert.equal(app.state.referenceRewrite.drafts.length, 4);
  assert.equal(app.elements.referenceRewriteSection.className.includes("hidden"), false);
  assert.equal(app.elements.referenceRewriteResult.innerHTML.match(/用这一稿开拍/gu).length, 4);
  app.resetDirectorClientState();
  assert.equal(app.state.referenceRewrite, null);
  assert.ok(app.elements.referenceRewriteSection.className.includes("hidden"));
});

test("用这一稿开拍：切到粘贴完整故事、填进标题加剧本、列出四稿可换；不写任何浏览器存储", async () => {
  const { writes, storage } = storageSpy();
  const confirms = [];
  const app = await readyApp({ storage, confirm: (message) => { confirms.push(message); return true; } });
  app.restoreRunArtifacts({ referenceRewrite: current(content()) });
  Object.assign(app.state.production, { projectId: "", runId: "" });
  writes.length = 0;
  await app.useReferenceRewriteDraft(2);
  assert.match(confirms[0], /用「伞下面还有伞」开拍/u);
  assert.match(confirms[0], /下载四稿/u);
  assert.equal(app.state.entryMode, "story");
  assert.equal(app.state.storyMode, "fullStoryText");
  const drafts = validRewrite().drafts;
  assert.equal(app.elements.storySourceText.value, referenceRewriteDraftStoryText(drafts[2]));
  assert.equal(app.state.referenceRewriteDrafts.drafts.length, 4);
  assert.equal(app.state.referenceRewrite, null);
  assert.equal(app.elements.referenceRewritePicker.className.includes("hidden"), false);
  assert.match(app.elements.referenceRewritePicker.innerHTML, /aria-pressed="true">稿三 · 伞下面还有伞/u);

  app.fillReferenceRewriteDraft(0);
  assert.equal(app.elements.storySourceText.value, referenceRewriteDraftStoryText(drafts[0]));
  // 用户改过字：换稿前先问，拒绝就不动。
  app.elements.storySourceText.value = "我自己改过的字";
  const before = confirms.length;
  const strict = await loadAppUi({ storage, confirm: () => false });
  strict.state.entryMode = "story";
  strict.state.referenceRewriteDrafts = app.state.referenceRewriteDrafts;
  Object.assign(strict.state.production, { projectId: "", runId: "" });
  strict.elements.storySourceText.value = "我自己改过的字";
  strict.fillReferenceRewriteDraft(1);
  assert.equal(strict.elements.storySourceText.value, "我自己改过的字");
  assert.equal(confirms.length, before);
  assert.deepEqual(writes.filter((key) => /reference|draft|story/iu.test(key)), [], "四稿只在页面内存里");
});

test("源码：参考片仿写的页面代码不碰 localStorage / sessionStorage / indexedDB", () => {
  const ui = fs.readFileSync(new URL("../public/reference-rewrite-ui.js", import.meta.url), "utf8");
  assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\s*\./u.test(ui), false);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("// 参考片仿写（2026-10-24）\n"), app.indexOf("// 「从剧情开始」（2026-10-09）"));
  assert.ok(block.length > 2000);
  assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\s*\./u.test(block), false);
});
