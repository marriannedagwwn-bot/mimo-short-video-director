import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppUi } from "./helpers/app-ui-harness.js";

for (const override of [null, { provider: "MiMo", model: "mimo-v2.6-pro" }]) {
  test(`人物参考图分析状态来自 characterReference 有效设置，与发送的覆盖一致：override=${Boolean(override)}`, async () => {
    const app = await loadAppUi({ story: true, plan: true });
    const defaults = { provider: "Qwen", model: "qwen3-vl-plus" };
    app.state.modelStages.characterReference = defaults;
    if (override) app.state.modelOverrides.characterReference = override;
    const setting = app.effectiveStageSetting("characterReference");
    const sent = app.withModelOverrides({});
    assert.equal(setting.provider, (sent.modelOverrides?.characterReference || defaults).provider);
    assert.equal(setting.model, (sent.modelOverrides?.characterReference || defaults).model);
    // The handler renders before file reading. The harness has no FileReader or network.
    const pending = app.refineCharacterReferenceWithImage(0, { type: "image/png", size: 4, name: "fixture.png" });
    const running = Object.values(app.state.characterReferenceStatuses).find(row => row.status === "running");
    assert.equal(running?.message, `正在用 ${setting.provider} · ${setting.model} 分析人物参考图…`);
    assert.ok(app.elements.animationPlan.innerHTML.includes(running.message));
    await pending;
  });
}

test("人物参考图分析没有完整模型设置时显示通用状态，不猜模型", async () => {
  for (const setting of [{}, { provider: "Qwen" }, { model: "qwen3-vl-plus" }]) {
    const app = await loadAppUi({ story: true, plan: true });
    app.state.modelStages.characterReference = setting;
    const pending = app.refineCharacterReferenceWithImage(0, { type: "image/png", size: 4, name: "fixture.png" });
    assert.equal(Object.values(app.state.characterReferenceStatuses).find(row => row.status === "running")?.message,
      "正在分析人物参考图…");
    await pending;
  }
});

test("可配置阶段没有写死 MiMo 分析或可灵视频初始标签，即梦固定图片文案保留", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(app, /正在用 MiMo 分析人物参考图/);
  assert.doesNotMatch(html, /用可灵 AI 生成/);
  assert.doesNotMatch(html, />KLING AI</);
  assert.match(app, /effectiveStageSetting\("characterReference"\)/);
  assert.match(app, /正在用即梦生成/);
  assert.match(app, /shotVideoModalTitle\.textContent = `用 \$\{shotVideoProviderLabel\(\)\}/);
});
