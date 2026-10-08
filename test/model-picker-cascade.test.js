import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("MiMo models cascade into V2.5 and V2.6 series in catalog order", async () => {
  const app = await loadAppUi();
  // 选中项排在最前（renderModelOptions 的顺序），系列顺序仍按目录走，不跟着选中项跑。
  const groups = app.modelSeriesGroups("MiMo", "fullStory",
    ["mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]);
  assert.deepEqual(plain(groups), [
    { label: "MiMo V2.5", models: ["mimo-v2.5", "mimo-v2.5-pro"] },
    { label: "MiMo V2.6", models: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"] }
  ]);
  assert.equal(app.modelSeriesNeedsCascade(groups), true);
});

test("models discovered from the provider listing join their series or fall into 其他型号 last", async () => {
  const app = await loadAppUi();
  const groups = app.modelSeriesGroups("MiMo", "analysis",
    ["mimo-v2.5", "custom-finetune", "mimo-v2.7-flash", "mimo-v2.6-pro"]);
  assert.deepEqual(plain(groups).map((group) => group.label), ["MiMo V2.5", "MiMo V2.6", "MiMo V2.7", "其他型号"]);
  assert.deepEqual(plain(groups.at(-1).models), ["custom-finetune"]);
});

test("MiMo speech models from the live listing get their own series instead of joining the chat series", async () => {
  const app = await loadAppUi();
  // 2026-10-05 MiMo /models 实际返回的列表。
  const groups = app.modelSeriesGroups("MiMo", "fullStory", [
    "mimo-v2.5", "mimo-v2.5-asr", "mimo-v2.5-pro", "mimo-v2.5-tts", "mimo-v2.5-tts-voiceclone",
    "mimo-v2.5-tts-voicedesign", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"
  ]);
  assert.deepEqual(plain(groups), [
    { label: "MiMo V2.5", models: ["mimo-v2.5", "mimo-v2.5-pro"] },
    { label: "MiMo V2.6", models: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"] },
    { label: "MiMo V2.5 语音", models: ["mimo-v2.5-asr", "mimo-v2.5-tts", "mimo-v2.5-tts-voiceclone", "mimo-v2.5-tts-voicedesign"] }
  ]);
});

test("Qwen splits versioned, general, VL and Omni series", async () => {
  const app = await loadAppUi();
  const media = app.modelSeriesGroups("Qwen", "analysis",
    ["qwen3.7-plus", "qwen-vl-max-latest", "qwen-vl-plus-latest", "qwen-omni-turbo-latest"]);
  assert.deepEqual(plain(media).map((group) => group.label), ["Qwen 3.7", "Qwen VL", "Qwen Omni"]);
  const text = app.modelSeriesGroups("Qwen", "fullStory",
    ["qwen3.7-max", "qwen3.7-plus", "qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"]);
  assert.deepEqual(plain(text), [
    { label: "Qwen 3.7", models: ["qwen3.7-max", "qwen3.7-plus"] },
    { label: "Qwen 通用", models: ["qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"] }
  ]);
});

test("providers with a single series, or only one model per series, stay a flat list", async () => {
  const app = await loadAppUi();
  assert.equal(app.modelSeriesNeedsCascade(app.modelSeriesGroups("DeepSeek", "fullStory", ["deepseek-v4-flash", "deepseek-v4-pro"])), false);
  assert.equal(app.modelSeriesNeedsCascade(app.modelSeriesGroups("Seedance", "shotVideo", [
    "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615"
  ])), false);
  const kling = app.modelSeriesGroups("Kling", "shotVideo", ["kling-v3", "kling-v2-1"]);
  assert.deepEqual(plain(kling).map((group) => group.label), ["Kling V3", "Kling V2.1"]);
  assert.equal(app.modelSeriesNeedsCascade(kling), false);
});

test("every stage renders a picker trigger showing the selected model next to the hidden select", async () => {
  const app = await loadAppUi();
  app.state.providers = { MiMo: { configured: true, defaultModel: "mimo-v2.6-pro", modelIds: [] } };
  app.state.modelStages = { fullStory: { provider: "MiMo", model: "mimo-v2.6-pro" } };
  app.openModelSettings();
  const row = app.elements.modelStageList.innerHTML.match(/<div class="model-stage-row" data-model-stage="fullStory">([\s\S]*?)<\/button>/)[1];
  assert.match(row, /<select data-model-name="fullStory">/);
  assert.match(row, /<option value="mimo-v2\.6-pro" selected>/);
  assert.match(row, /data-model-picker-trigger aria-haspopup="menu" aria-expanded="false"/);
  assert.match(row, /<span class="model-picker-value" data-model-picker-label>mimo-v2\.6-pro<\/span>/);
});
