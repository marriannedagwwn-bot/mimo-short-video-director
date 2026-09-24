import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  STORYBOARD_DESIGN_MODEL_SCHEMA_NAME,
  storyboardDesignModelSchema
} from "../src/contracts/storyboard-design-model-schema.js";
import { storyboardDesignSchema, storyboardDesignFromPlan, storyboardValidationErrors } from "../src/storyboard-contract.js";
import { storyboardInput, createStoryboardPlan, createSingleShotPrompt } from "../src/storyboard-workflow.js";
import { storyboardPrompt, storyboardRetryPrompt, storyboardSystem } from "../src/storyboard-prompts.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import { catalog } from "../src/storyboard-editorial-utils.js";
import { NO_BACKGROUND_MUSIC_SENTENCE } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";

// 2026-09-24：MiMo 把 locations / props 放在顶层，耗掉了分镜设计的一次调用预算。
// 约束解码只减少这类结构失败；跨字段引用仍由服务端判定，预算留给带诊断重试。

function walkSchema(node, visit, path = []) {
  visit(node, path);
  for (const [field, child] of Object.entries(node.properties || {})) walkSchema(child, visit, [...path, "properties", field]);
  if (node.items) walkSchema(node.items, visit, [...path, "items"]);
  if (node.additionalProperties && typeof node.additionalProperties === "object") walkSchema(node.additionalProperties, visit, [...path, "additionalProperties"]);
}

function compile() {
  return new Ajv2020({ strict: false, allErrors: true }).compile(storyboardDesignModelSchema());
}

// 沿用 storyboard-workflow.test.js 的入口：先由演示流程提供合法上游，再接预置响应客户端。
async function fixture() {
  const workflow = new WorkflowService();
  const source = {
    frames: Array.from({ length: 3 }, (_, timestamp) => ({ timestamp, dataUrl: "data:image/jpeg;base64,AA==" })),
    metadata: { name: "fixture", duration: 60, width: 1080, height: 1920 },
    creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "动画", constraints: "" }, count: 4
  };
  const upstream = await workflow.run(source), variant = upstream.themeVariants.variants[0];
  const fullStory = await workflow.createFullStory({ ...source, ...upstream, variant });
  const input = { ...source, ...upstream, variant, fullStory, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false };
  const { animationPlan } = await createStoryboardPlan(workflow, input);
  const { projected } = await storyboardInput(workflow, input);
  return { workflow, input, projected, design: storyboardDesignFromPlan(animationPlan) };
}

test("给模型的 Schema 去掉 pattern、uniqueItems、exclusiveMinimum，严格 Schema 不受影响", () => {
  const before = structuredClone(storyboardDesignSchema);
  const schema = storyboardDesignModelSchema();
  walkSchema(schema, (node, path) => {
    for (const keyword of ["pattern", "uniqueItems", "exclusiveMinimum"]) {
      assert.equal(Object.hasOwn(node, keyword), false, `${path.join(".")} 还有 ${keyword}`);
    }
  });
  walkSchema(before, (node, path) => {
    if (node.pattern === "\\S") {
      assert.deepEqual(path.reduce((value, key) => value[key], schema), { type: "string", minLength: 1 }, path.join("."));
    }
  });
  assert.deepEqual(storyboardDesignSchema, before);
  assert.notEqual(schema, storyboardDesignSchema);
  assert.notEqual(schema.properties, storyboardDesignSchema.properties);
  assert.equal(STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, "storyboard_design");
});

test("派生 Schema 整棵树只使用已在 MiMo 上实测的关键字", () => {
  const allowed = new Set([
    "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
    "enum", "minimum", "maximum", "minLength"
  ]);
  walkSchema(storyboardDesignModelSchema(), (node, path) => {
    for (const keyword of Object.keys(node)) assert.ok(allowed.has(keyword), `${path.join(".")} 出现 ${keyword}`);
  });
});

test("严格 Schema 出现新关键字或其他 pattern 时直接报错，带上路径和关键字", () => {
  const paths = [[], ["properties", "visualDesign"], ["properties", "shotPlan", "items", "properties", "beats", "items", "properties", "visibleAction"]];
  for (const path of paths) {
    for (const [keyword, value] of [["format", "uri"], ["pattern", "^.+$"]]) {
      // 严格 Schema 多处共用同一个字符串对象；打散引用才能只向目标路径注入错误。
      const strict = JSON.parse(JSON.stringify(storyboardDesignSchema));
      path.reduce((node, key) => node[key], strict)[keyword] = value;
      const before = structuredClone(strict);
      assert.throws(() => storyboardDesignModelSchema(strict), error => {
        assert.ok(error.message.includes(["$", ...path].join(".")), error.message);
        assert.ok(error.message.includes(keyword), error.message);
        return true;
      });
      assert.deepEqual(strict, before);
    }
  }
  const additionalSchema = structuredClone(storyboardDesignSchema);
  additionalSchema.properties.visualDesign.additionalProperties = { type: "string", format: "uri" };
  assert.throws(() => storyboardDesignModelSchema(additionalSchema), /\$\.properties\.visualDesign\.additionalProperties.*format/u);
});

test("字段顺序保留严格 Schema 顺序，且与提示词输出模板各层一致", async () => {
  const schema = storyboardDesignModelSchema();
  walkSchema(storyboardDesignSchema, (node, path) => {
    if (node.properties) assert.deepEqual(Object.keys(path.reduce((value, key) => value[key], schema).properties), Object.keys(node.properties));
  });
  const { projected } = await fixture();
  const prompt = storyboardPrompt(projected);
  const template = prompt.slice(prompt.indexOf("输出协议"), prompt.indexOf("每条片段的 beats"));
  const shot = schema.properties.shotPlan.items;
  const scopes = [
    [schema, template],
    [schema.properties.visualDesign, template.slice(template.indexOf('"visualDesign":'))],
    [shot, template.slice(template.indexOf('"shotPlan":'))],
    [shot.properties.beats.items, template.slice(template.indexOf('"beats":'))]
  ];
  // 从本层开始逐个向后找：characters / sourceSceneIds 等字段会在不同层重复出现。
  for (const [node, text] of scopes) {
    let cursor = 0;
    for (const field of Object.keys(node.properties)) {
      const token = `"${field}":`;
      const position = text.indexOf(token, cursor);
      assert.ok(position >= cursor, `模板里 ${field} 不在前一个字段之后`);
      cursor = position + token.length;
    }
  }
});

test("片段数由模型自己决定，不锁 shotPlan 条数", async () => {
  const schema = storyboardDesignModelSchema();
  assert.equal(schema.properties.shotPlan.minItems, 1);
  assert.equal(Object.hasOwn(schema.properties.shotPlan, "maxItems"), false);
  const validate = compile();
  const { design } = await fixture();
  for (const count of [1, 2, 8]) {
    const value = structuredClone(design);
    value.shotPlan = Array.from({ length: count }, () => structuredClone(design.shotPlan[0]));
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
});

test("合法分镜通过，locations / props 错层等结构失败被派生 Schema 拒绝", async () => {
  const validate = compile();
  const { design, projected } = await fixture();
  assert.equal(validate(design), true, JSON.stringify(validate.errors));
  assert.deepEqual(storyboardValidationErrors(design, projected), []);
  const cases = {
    // 与 09-24 第一次真实失败同形。
    地点道具放到顶层: value => {
      for (const field of ["locations", "props"]) {
        value[field] = value.visualDesign[field];
        delete value.visualDesign[field];
      }
    },
    缺地点: value => { delete value.visualDesign.locations; },
    片段数组混入字符串: value => { value.shotPlan.push("locations"); },
    节拍数组混入字符串: value => { value.shotPlan[0].beats.push("sourceSceneIds"); },
    地点数组混入字符串: value => { value.visualDesign.locations.push("props"); },
    片段多出字段: value => { value.shotPlan[0].videoPrompt = "提前生成"; },
    时长小于下限: value => { value.shotPlan[0].durationSeconds = 3; },
    时长大于上限: value => { value.shotPlan[0].durationSeconds = 16; },
    时长不是整数: value => { value.shotPlan[0].durationSeconds = 8.5; },
    空字符串: value => { value.viewingIntent = ""; },
    深层空字符串: value => { value.shotPlan[0].beats[0].visibleAction = ""; }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const value = structuredClone(design);
    mutate(value);
    assert.equal(validate(value), false, label);
  }
  for (const durationSeconds of [4, 15]) {
    const value = structuredClone(design);
    value.shotPlan[0].durationSeconds = durationSeconds;
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
});

test("约束解码只是减少结构失败：全空白字符串能过模型 Schema，严格 Schema 仍拦下", async () => {
  const { design, projected } = await fixture();
  design.shotPlan[0].beats[0].visibleAction = " \t\n ";
  assert.equal(compile()(design), true);
  assert.ok(storyboardValidationErrors(design, projected).some(row => row.code === "STORYBOARD_SCHEMA_INVALID" && row.path === "/shotPlan/0/beats/0/visibleAction"));
});

test("模型 Schema 放宽的去重、正数与跨字段引用约束仍由服务端拦下", async () => {
  const { design, projected } = await fixture();
  const validate = compile();
  const cases = [
    [value => { value.shotPlan[0].sourceSceneIds.push(value.shotPlan[0].sourceSceneIds[0]); }, "STORYBOARD_SCHEMA_INVALID"],
    [value => { value.shotPlan[0].beats[0].endSeconds = 0; }, "STORYBOARD_SCHEMA_INVALID"],
    [value => { value.shotPlan[0].beats[0].sourceSceneIds = [projected.fullStory.sceneScript[1].sceneId]; }, "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT"]
  ];
  for (const [mutate, code] of cases) {
    const value = structuredClone(design);
    mutate(value);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.ok(storyboardValidationErrors(value, projected).some(row => row.code === code), code);
  }
});

test("只有分镜设计及其重试带 Schema，其他分镜阶段不带；提示词逐字不变", async () => {
  const { workflow, input, projected, design } = await fixture();
  const broken = structuredClone(design);
  for (const field of ["locations", "props"]) {
    broken[field] = broken.visualDesign[field];
    delete broken.visualDesign[field];
  }
  const evidence = catalog(design, "P").find(row => row.path.join("/") === "shotPlan/0/beats/0/visibleAction");
  const report = { strengths: ["保留已有动作"], guidance: [], items: [{ ref: "I1", reportedProblem: "动作终点需明确",
    originalEvidence: [{ id: evidence.id, quote: evidence.value }], guidance: "交代动作终点" }] };
  const replacement = `${evidence.value}动作结束后停稳。`;
  const responses = [
    mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(input.fullStory, input.creatorProfile)),
    broken, design, report,
    { repairs: [{ ref: "I1", disposition: "revise", patches: [{ path: evidence.path, find: evidence.value, replace: replacement }], note: "写清动作终点，保留原动作" }] },
    { strengths: ["保留已有动作"], guidance: [], items: [] },
    { videoPrompt: design.shotPlan[0].beats.flatMap(beat => beat.dialogue.map(line => line.text)).join("；") + NO_BACKGROUND_MUSIC_SENTENCE }
  ];
  const requests = [];
  workflow.clients.MiMo = { async generateJson(request) {
    requests.push(request);
    const response = responses[requests.length - 1];
    assert.ok(response, "不得超出预置的调用次数");
    return response;
  } };
  workflow.stageDefaults.animationPlan = { provider: "MiMo", model: "test-model" };
  const { animationPlan, metadata } = await createStoryboardPlan(workflow, input);
  assert.equal(animationPlan.editorial.repairs[0].status, "applied");
  assert.equal(animationPlan.shotPlan[0].beats[0].visibleAction, replacement);
  await createSingleShotPrompt(workflow, {
    plan: animationPlan, shotId: animationPlan.shotPlan[0].shotId, planDigest: "digest",
    target: { provider: "Seedance", model: "doubao-seedance-2-0-260128" }
  });
  const stages = [...metadata.storyboard.calls.flatMap(row => Array(row.providerCalls).fill(row.stage)), "shotVideoPrompt"];
  assert.deepEqual(stages, ["storyboardCharacterFacts", "storyboardDesign", "storyboardDesign", "storyboardReview", "storyboardRevision", "storyboardReviewFinal", "shotVideoPrompt"]);
  assert.equal(requests.length, stages.length);
  for (const [index, request] of requests.entries()) {
    if (stages[index] === "storyboardDesign") {
      assert.deepEqual(request.responseSchema, { name: STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, schema: storyboardDesignModelSchema() });
      assert.equal(request.systemPrompt, storyboardSystem);
    } else assert.equal(Object.hasOwn(request, "responseSchema"), false, stages[index]);
  }
  assert.equal(requests[1].prompt, storyboardPrompt(projected));
  assert.equal(requests[2].prompt, storyboardRetryPrompt({ originalPrompt: storyboardPrompt(projected), details: storyboardValidationErrors(broken, projected) }));
});
