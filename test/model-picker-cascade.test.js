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
  assert.equal(app.modelSeriesNeedsCascade(app.modelSeriesGroups("MiniMax", "shotVideo", ["MiniMax-H3"])), false);
  // Claude（2026-10-19）：四个型号各自一个系列，仍是平铺列表。
  const claude = app.modelSeriesGroups("Claude", "fullStory", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
  // 系列按目录顺序排：Sonnet 5.5 是默认型号，排第一。
  assert.deepEqual(plain(claude).map((group) => group.label), ["Claude Sonnet 5.5", "Claude Opus 5.5", "Claude Haiku 5.5", "Claude Fable 5.1"]);
  assert.equal(app.modelSeriesNeedsCascade(claude), false);
  // 每个系列都只有一个型号。原来用可灵 V3 / V2.1 举例，可灵已于 2026-10-11 删除。
  const oneEach = app.modelSeriesGroups("Qwen", "analysis", ["qwen-vl-max-latest", "qwen-omni-turbo-latest"]);
  assert.deepEqual(plain(oneEach).map((group) => group.label), ["Qwen VL", "Qwen Omni"]);
  assert.equal(app.modelSeriesNeedsCascade(oneEach), false);
});

test("Claude 与 DeepSeek 一样只列在纯文本阶段；纯文本阶段只给登记的四个型号，第一个是默认", async () => {
  const app = await loadAppUi();
  app.state.providers = { Claude: { configured: true, defaultModel: "claude-sonnet-5-5", modelIds: [] } };
  assert.ok(app.availableModelProviders().includes("Claude"));
  assert.equal(app.availableModelProviders()[0], "Claude", "配置了的供应商排在前面");
  for (const stage of ["analysis", "reconstruction", "visualGuardrails", "characterReference"]) {
    assert.equal(app.providerAllowedForStage("Claude", stage), false, stage);
    assert.deepEqual(plain(app.modelOptionsForStage(stage, "Claude")), [], stage);
  }
  assert.equal(app.providerAllowedForStage("Claude", "fullStory"), true);
  assert.equal(app.providerAllowedForStage("DeepSeek", "analysis"), false);
  assert.deepEqual(plain(app.modelOptionsForStage("fullStory", "Claude")),
    ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
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
