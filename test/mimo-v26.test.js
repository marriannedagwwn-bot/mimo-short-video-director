import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import { MimoClient, buildRequestBody } from "../src/mimo-client.js";
import { WorkflowService } from "../src/workflow.js";

const models = ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"];
const stages = ["analysis", "reconstruction", "visualGuardrails", "characterReference", "brief", "variants",
  "storyCandidateReview", "storyCandidateRevision", "fullStory", "storyQualityReview", "storyQualityRepair",
  "animationPlan", "animationPlanReview", "animationPlanRevision", "staticFrameCompiler"];

test("MiMo V2.6 remains selectable in every LLM stage without a provider model listing", async () => {
  const app = await loadAppUi();
  app.state.providers = { MiMo: { configured: true, defaultModel: "mimo-v2.5", modelIds: [] } };
  app.state.modelStages = Object.fromEntries(stages.map(stage => [stage, { provider: "MiMo", model: "mimo-v2.5" }]));
  app.openModelSettings();
  for (const stage of stages) {
    const select = app.elements.modelStageList.innerHTML.match(new RegExp(`<select data-model-name="${stage}">([\\s\\S]*?)</select>`))?.[1];
    assert.ok(select, stage);
    for (const model of models) assert.ok(select.includes(`<option value="${model}">`), `${stage}: ${model}`);
    assert.match(select, /<option value="mimo-v2\.5" selected>/, "opening settings must preserve the configured model");
  }
  assert.deepEqual(Object.keys(app.state.modelOverrides), []);
});

test("MiMo V2.6 discovery merges with the catalog without duplicate options", async () => {
  const app = await loadAppUi();
  app.state.providers = { MiMo: { configured: true, defaultModel: "mimo-v2.5", modelIds: models } };
  app.state.modelStages = { fullStory: { provider: "MiMo", model: "mimo-v2.5-pro" } };
  app.state.modelOverrides = { fullStory: { provider: "MiMo", model: models[1] } };
  app.openModelSettings();
  const select = app.elements.modelStageList.innerHTML.match(/<select data-model-name="fullStory">([\s\S]*?)<\/select>/)[1];
  for (const model of models) assert.equal(select.split(`value="${model}"`).length - 1, 1);
  assert.ok(select.includes(`<option value="${models[1]}" selected>`));
});

test("MiMo V2.6 stage overrides reach the existing text, image and video protocol unchanged", () => {
  const client = new MimoClient({ model: "mimo-v2.5", thinking: "disabled", jsonMode: true });
  const workflow = new WorkflowService({ clients: { MiMo: client } });
  for (const model of models) {
    for (const stage of stages) {
      const settings = workflow.resolveStage(stage, { modelOverrides: { [stage]: { provider: "MiMo", model } } });
      assert.equal(settings.client, client);
      assert.equal(settings.model, model);
      for (const media of [{}, { frames: [{ dataUrl: "data:image/png;base64,fixture" }] },
        { video: { dataUrl: "data:video/mp4;base64,fixture" }, useVideo: true }]) {
        const body = buildRequestBody(client.config, { prompt: "Return JSON.", ...media }, settings);
        assert.equal(body.model, model);
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.equal(body.messages[1].content[0].type, media.useVideo ? "video_url" : media.frames ? "image_url" : "text");
      }
    }
  }
});
