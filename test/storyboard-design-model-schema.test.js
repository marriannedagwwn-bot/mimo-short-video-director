import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  STORYBOARD_DESIGN_MODEL_SCHEMA_NAME,
  storyboardDesignModelSchema
} from "../src/contracts/storyboard-design-model-schema.js";
import { storyboardDesignSchema, storyboardDesignFromPlan, storyboardValidationErrors } from "../src/storyboard-contract.js";
import { storyboardInput, createStoryboardPlan, createSingleShotPrompt } from "../src/storyboard-workflow.js";
import { storyboardPrompt, storyboardPromptWithLockedDialogue, storyboardRetryPrompt, storyboardSystem } from "../src/storyboard-prompts.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import { catalog } from "../src/storyboard-editorial-utils.js";
import { storyboardReviewPrompt } from "../src/storyboard-review.js";
import { storyboardReviewClaudeResponseSchema } from "../src/contracts/storyboard-review-claude-schema.js";
import { NO_BACKGROUND_MUSIC_SENTENCE } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";
import { storyboardShotCharacterNames } from "../public/storyboard-plan.js";

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

test("设计提示词第 9 条要求 beat 来源包含在片段里，演到下一场时补进片段", async () => {
  const { projected } = await fixture();
  const rule = storyboardPrompt(projected).split("\n").find(line => /^9\.\s/u.test(line));
  assert.ok(rule, "设计提示词必须有第 9 条");
  assert.match(rule, /(?:每个|各个|所有)\s*beat[^。；]*sourceSceneIds[^。；]*(?:必须|须)[^。；]*片段[^。；]*sourceSceneIds/u);
  assert.match(rule, /beat[^。；]*演到下一场[^。；]*(?:补|写|加入)[^。；]*片段[^。；]*sourceSceneIds/u);
  assert.match(rule, /(?:不要|不得|不能)[^。；]*只[^。；]*beat/u);
});

// 2026-10-13：成片里人物进场方向乱、相邻片段方向接反，根因是分镜从不写进出画面的方向。
test("设计提示词第 6 条要求写清进出画面与移动方向、压缩反复走位；第 8 条要求相邻片段方向接得上", async () => {
  const { projected } = await fixture();
  const lines = storyboardPrompt(projected).split("\n");
  const rule6 = lines.find(line => /^6\.\s/u.test(line));
  const rule8 = lines.find(line => /^8\.\s/u.test(line));
  assert.ok(rule6 && rule8, "设计提示词必须有第 6、8 条");
  for (const phrase of ["角色进出画面或在画面里移动时，写清从画面哪一侧进来、朝哪一侧或哪个位置去、停在哪里", "谁在前、谁在后、朝画面哪一侧跑", "压缩成观众一眼看得清的一段路线"]) {
    assert.ok(rule6.includes(phrase), phrase);
  }
  for (const phrase of ["片段结束时还在移动的人，写明他在画面哪一侧、正朝哪个方向移动", "上一片段的人朝画面右侧跑出，下一片段就从画面左侧进来、继续朝右", "朝画面左侧跑出，下一片段就从画面右侧进来、继续朝左",
    "追赶的一方跟在他们后面、从同一侧出现，不会出现在他们前方", "下一片段的 transitionIn 写明他们从画面哪一侧进来", "换到对面机位让方向反过来时，在 camera 里写明"]) {
    assert.ok(rule8.includes(phrase), phrase);
  }
  // 锁台词版只换第 2 条那一句，方向要求原样保留。
  const locked = storyboardPromptWithLockedDialogue(projected);
  assert.ok(locked.includes(rule6) && locked.includes(rule8));
});

// 2026-10-19：导演方法换成分镜写法；原来关于剧情忠实、执行关系、对白前提与 visualDesign 的约束必须还在。
// 2026-10-20：分镜写法换成《天使降临》全集版，关键句跟着换；「不能丢的约束」与第 3、6、7 条那几句逐字不变。
test("设计提示词用全集分镜写法：节奏跟着内容走、开场按场景选、同构图重复、揭底无声、对话主镜头、真心话、人声位置，锁台词版同样生效", async () => {
  const { projected } = await fixture();
  const prompt = storyboardPrompt(projected);
  for (const phrase of ["这些写法是工具，不是配额", "一个镜头写成一个 beat", "每个 beat 至少 1 秒，起止都用整数秒", "不写 1 秒以下的快切",
    "从 A 一路加速推到 B", "表情连跳几次",
    // 节奏：全集平均约 4 秒，有台词 4–5 秒、反应 2–3 秒、空镜 2 秒，快慢跟着内容走。
    "节奏跟着「在干什么」走，平均约 3–4 秒一个镜头", "有台词的镜头 4–5 秒", "只有喘气、反应声的 2–3 秒", "一串快切之后接一个较长的固定全景", "不要把每个镜头都剪短", "安静、慢的段落，一个片段 2–3 个镜头就够",
    "一个片段是一次视频生成，切得越多，视频模型越容易把切点放错", "一个片段里一般 2–4 个镜头、最多 4 个，镜头多了就分成两个片段", "1 秒的镜头只留给冲击、揭底的那一下",
    "一个镜头只做一件事", "顺手的小动作（放下手里的东西、整理衣服）合进相邻的镜头", "镜头大多固定：换景别靠切，不靠推、拉、摇、跟",
    "关键接触给特写", "脚和门槛贴地拍", "按各自的视线一俯一仰", "视角镜头：人看东西时，先给看的人，再切到他看见的东西",
    // 开场与收尾：按场景选开法，晚上外观压声音，换天空镜同一组，场内跳时间用无声物件空镜。
    "按场景选开法，不是每一场都要空镜", "晚上的外观上一定压着声音", "全片的换天空镜用同一组、同样的顺序", "第二次来同一个地方，只复用第一个空镜",
    "可以只拍脚", "空镜 2–3 秒，这个 beat 的 characters 为空", "硬切一个 2–3 秒、没有人声的物件空镜",
    "先局部，后脸；先声音，后画面", "门外奔跑的脚部特写", "出画后让空画面再停 0.3–1 秒才切", "画里还有别人，就停在留下的人身上",
    "大动作拆成起、中、落三个镜头", "切点放在动作进行到一半的时候", "被撞的人先僵住，到下一个固定全景里才倒下",
    // 笑点：揭底前的声音在前一镜末尾、揭底镜本身无人声、同构图重复第二次更短、冷场接剧情里的下一句。
    "揭底前的那一声（吸气、「嗯？」「啊」）放在揭底前一个镜头的末尾", "揭底镜头本身不放人声", "用同一个构图、同一个机位再拍一次", "第二次更短，不再给反应",
    "再由最冷静的人接剧情里的下一句话", "背景换成这个角色自己的图案",
    "用一个固定的全景或中景撑住对话", "单人近景多数给说话的人", "心动的那一拍多数不出声", "真心话慢—快—慢", "关键的一拍给两只手的特写", "说完马上回到日常或一个小笑点，不改结局",
    "角色不说词的人声写进 soundDesign，点名是谁发出", "写明放在镜头开头还是末尾、跨不跨切点、是不是画外", "开口前先吸一口气或叹一口气，放在近景开头",
    "身体砸下去那一刻一声短促的闷哼", "物件镜头先静 1 秒，尖叫从画外进来", "这些 beat 的 soundDesign 写明「无人声」",
    "这些人声和叫声不是台词：写在 soundDesign，不写进 dialogue；对白不可改的时候也照样可以加", "这种提前只在同一个片段内部跨镜头，不跨片段",
    "主角的叫声：剧情台词或角色设定里，主角用过只有拟声、没有字义的叫声或口头禅（剧情台词里的也算）", "除了喘气，至少还有一声这样的叫声或哼声",
    "写法示范（只示范镜头怎么拆、声音怎么放，不照抄内容）", "再接剧情里的下一句台词",
    "外观设计不授予新能力", "不能构图里仍在远处却已操作道具", "对白保留说话动机、指代对象、所回答的问题和信息前提", "designedDetails 只列新增外观",
    "前面的分镜写法是工具，不是配额", "局部可以先于脸出现，但要让观众很快认出是谁的", "角色不说词的人声（点名谁发出）"]) {
    assert.ok(prompt.includes(phrase), phrase);
  }
  // 第 1 集版本里被全集推翻的几句不能留着。
  for (const phrase of ["没有镜头、运镜或大动作配额", "一般 3–4 秒", "一般 2–3 秒", "反应镜头多给听的人", "开场先给 1–3 个由远到近的空镜", "出画后让空画面再停约 1 秒才切", "撞上就切，下一个镜头人已经倒在地上"]) {
    assert.equal(prompt.includes(phrase), false, phrase);
  }
  const locked = storyboardPromptWithLockedDialogue(projected);
  assert.ok(locked.includes("对白不可改：Full Story 的每句台词都来自用户故事原文"));
  assert.ok(locked.includes("对白不可改的时候也照样可以加"));
});

test("审阅不把新写法里的空镜、留空、先局部后脸、人声、无人声揭底、冷场与同构图重复当错误", () => {
  const prompt = storyboardReviewPrompt({ input: {}, plan: {} });
  for (const phrase of ["空镜头", "人物出画后的留空", "先给局部再给脸的镜头", "soundDesign 里的角色人声",
    "写明「无人声」的揭底镜头或空镜", "冷场里的静默", "与前面同一构图的重复镜头", "跳过时间的物件空镜", "背景换成角色图案的镜头"]) {
    assert.ok(prompt.includes(phrase), phrase);
  }
  assert.ok(prompt.startsWith("你是分镜修稿编辑。"), "测试替身靠开头一句认出审阅");
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

test("beat 越界诊断保留码与路径，列明场次并给出补进片段和移出 beat 两种改法", async () => {
  const { design, projected } = await fixture();
  assert.deepEqual(storyboardValidationErrors(design, projected), []);
  const shotIndex = design.shotPlan.findIndex(row => row.sourceSceneIds.length === 1 && row.sourceSceneIds[0] === "S2");
  assert.ok(shotIndex >= 0, "夹具必须有只承接 S2 的片段");
  design.shotPlan[shotIndex].beats[0].sourceSceneIds = ["S2", "S3"];
  const errors = storyboardValidationErrors(design, projected);
  assert.equal(errors.length, 1);
  const [{ code, path, reason }] = errors;
  assert.equal(code, "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT");
  assert.equal(path, `/shotPlan/${shotIndex}/beats/0/sourceSceneIds`);
  assert.match(reason, /beat[^；]*(?:不在|不属于)[^；]*片段[^；]*S3/u);
  assert.match(reason, /本片段[^；]*(?:现有|已有)[^；]*S2/u);
  assert.match(reason, /beat[^；]*确实演到[^；]*(?:补|加入)[^；]*片段[^；]*sourceSceneIds/u);
  assert.match(reason, /(?:没|未)演到[^；]*(?:从|移出)[^；]*beat[^；]*sourceSceneIds[^；]*(?:去掉|删除|移除)/u);

  const addedToShot = structuredClone(design);
  addedToShot.shotPlan[shotIndex].sourceSceneIds.push("S3");
  assert.deepEqual(storyboardValidationErrors(addedToShot, projected), []);
  const removedFromBeat = structuredClone(design);
  removedFromBeat.shotPlan[shotIndex].beats[0].sourceSceneIds = ["S2"];
  assert.deepEqual(storyboardValidationErrors(removedFromBeat, projected), []);
});

test("beat 越界诊断用顿号分别列出全部越界场次和片段现有场次", async () => {
  const { design, projected } = await fixture();
  design.shotPlan[0].sourceSceneIds = ["S1", "S2"];
  design.shotPlan[0].beats[0].sourceSceneIds = ["S1", "S3", "S4"];
  const errors = storyboardValidationErrors(design, projected);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT");
  assert.equal(errors[0].path, "/shotPlan/0/beats/0/sourceSceneIds");
  const [outside, current] = errors[0].reason.split("；");
  assert.match(outside, /S3、S4/u);
  assert.doesNotMatch(outside, /S1|S2/u);
  assert.match(current, /S1、S2/u);
  assert.doesNotMatch(current, /S3|S4/u);
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
    // 单镜提示词要写出出镜角色名（2026-10-12），否则会触发重试、超出这里预置的调用次数。
    { videoPrompt: `${storyboardShotCharacterNames(design.shotPlan[0]).join("、")}。`
      + design.shotPlan[0].beats.flatMap(beat => beat.dialogue.map(line => line.text)).join("；") + NO_BACKGROUND_MUSIC_SENTENCE }
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
    // 只有两道审阅带给 Claude 的结构化输出 Schema（2026-10-21）；MiMo 客户端不读这个参数。
    if (["storyboardReview", "storyboardReviewFinal"].includes(stages[index])) {
      assert.deepEqual(request.claudeResponseSchema, storyboardReviewClaudeResponseSchema(), stages[index]);
    } else assert.equal(Object.hasOwn(request, "claudeResponseSchema"), false, stages[index]);
  }
  assert.equal(requests[1].prompt, storyboardPrompt(projected));
  assert.equal(requests[2].prompt, storyboardRetryPrompt({ originalPrompt: storyboardPrompt(projected), details: storyboardValidationErrors(broken, projected) }));
});
