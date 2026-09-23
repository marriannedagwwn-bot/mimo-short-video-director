import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { WorkflowService } from "../src/workflow.js";
import { ensureOutputContract } from "../src/validation.js";
import { storyboardInput, singleShotPromptInput } from "../src/storyboard-workflow.js";
import { ensureStoryboardPlan, storyboardDesignFromPlan } from "../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mergeFullStoryCharacterRegistry, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import { applyEditorial } from "../src/storyboard-editorial.js";
import { catalog } from "../src/storyboard-editorial-utils.js";
import { validateStoryboardReview } from "../src/storyboard-review.js";
import { storyboardRetryPrompt } from "../src/storyboard-prompts.js";
import { renderStoryboard } from "../public/storyboard-render.js";
import { MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { storyboardPromptMatches, storyboardUsesPreviousFrames } from "../public/storyboard-plan.js";
import { resolveAuthoritativeShotVideoInput } from "../src/shot-video-continuity.js";
import { shotRelatedCharacterReferences } from "../public/shot-reference-images.js";
import { shotRelatedCharacterAudioClips } from "../public/character-reference-audio.js";

async function fixture() {
  const workflow = new WorkflowService();
  const source = {frames:Array.from({length:3},(_,timestamp)=>({timestamp,dataUrl:"data:image/jpeg;base64,AA=="})),
    metadata:{name:"fixture",duration:60,width:1080,height:1920},creatorProfile:{fixedCharacter:"阿岚，社区修理师",vertical:"动画",constraints:""},count:4};
  const upstream = await workflow.run(source), variant = upstream.themeVariants.variants[0];
  const fullStory = await workflow.createFullStory({...source,...upstream,variant});
  const input = {...source,...upstream,variant,fullStory,animationPlanVersion:"4.0",targetAspectRatio:"16:9",backgroundMusicEnabled:false};
  const plan = await workflow.createAnimationPlan(input);
  return {workflow,input,plan};
}

test("旧 Full Story 直接生成完整分镜，正文不变且不提前生成视频提示词", async () => {
  const {workflow,input,plan} = await fixture();
  const before = structuredClone(input.fullStory);
  workflow.createFullStory = () => {throw new Error("不得重新生成 Full Story");};
  const {projected} = await storyboardInput(workflow,input);
  assert.deepEqual(projected.fullStory,before);
  assert.deepEqual(input.fullStory,before);
  assert.ok(projected.characterRegistry.supportingCharacters.length);
  assert.equal(projected.creativeBrief,undefined);
  assert.equal(projected.variant,undefined);
  assert.equal(plan.promptSchemaVersion,"4.0");
  assert.equal(plan.shotPlan.some(shot => Object.hasOwn(shot,"videoPrompt")),false);
  assert.equal(ensureOutputContract(plan,"animationPlan"),plan);
});

test("新 Full Story 角色表只扩充角色事实，旧版默认保持 1.1", async () => {
  const {workflow,input} = await fixture();
  const story = await workflow.createFullStory({...input,fullStorySchemaVersion:"full_story/1.2"});
  assert.equal(input.fullStory.schemaVersion,"full_story/1.1");
  assert.equal(story.schemaVersion,"full_story/1.2");
  assert.deepEqual(story.sceneScript,input.fullStory.sceneScript);
  assert.deepEqual(story.characterBible.protagonist,input.fullStory.characterBible.protagonist);
  assert.ok(story.characterBible.supportingCharacters.every(row => row.appearanceFacts.length === 0));
  assert.equal(ensureOutputContract(story,"fullStory"),story);
});

test("角色事实覆盖单场与仅发声者，未知外观可空，捏造来源和漏登记拒绝", async () => {
  const {input} = await fixture();
  const story = structuredClone(input.fullStory);
  story.sceneScript[0].offscreenSoundSources = ["来电人"];
  const source = fullStoryCharacterRegistryInput(story,input.creatorProfile);
  const response = mockFullStoryCharacterRegistry(source);
  const merged = mergeFullStoryCharacterRegistry(story,response,source);
  assert.ok(merged.characterBible.supportingCharacters.some(row => row.name === "来电人"));
  assert.deepEqual(merged.sceneScript,story.sceneScript);
  const invalid = structuredClone(response); invalid.supportingCharacters[0].appearanceFacts = ["红头发"];
  assert.throws(()=>mergeFullStoryCharacterRegistry(story,invalid,source),/来源/);
  invalid.supportingCharacters[0].sourceEvidence = [{field:"appearanceFacts",sourceId:"E001",quote:"不存在的原文"}];
  assert.throws(()=>mergeFullStoryCharacterRegistry(story,invalid,source),/摘句/);
  response.supportingCharacters.pop();
  assert.throws(()=>mergeFullStoryCharacterRegistry(story,response,source),/覆盖/);
});

test("分镜结构拒绝超长、断裂时间、无来源、未知角色、额外 videoPrompt", async () => {
  const {plan} = await fixture();
  for(const mutate of [
    p=>p.shotPlan[0].durationSeconds=16,
    p=>p.shotPlan[0].beats[0].startSeconds=1,
    p=>p.shotPlan[0].sourceSceneIds=["not-a-scene"],
    p=>p.shotPlan[0].beats[0].characters.push("陌生人"),
    p=>p.shotPlan[0].videoPrompt="提前生成",
    p=>p.characterRegistry.supportingCharacters.pop(),
    p=>p.shotPlan[0]=null
  ]) {const invalid=structuredClone(plan);mutate(invalid);assert.throws(()=>ensureStoryboardPlan(invalid));}
  const advisory=structuredClone(plan);advisory.blockedIssues=["模型仍有意见"];
  assert.equal(ensureStoryboardPlan(advisory),advisory);
});

test("AI 审查与保守修订只作提示，无修订时不调用终审或视频提示词", async () => {
  const {workflow,input,plan} = await fixture();
  const design = storyboardDesignFromPlan(plan);
  const evidence = catalog(design,"P").find(row=>row.path.at(-1)==="visibleAction");
  const report = {strengths:["保留已有动作"],guidance:[],items:[{ref:"I1",reportedProblem:"需要留意动作",originalEvidence:[{id:evidence.id,quote:evidence.value}],guidance:"计入前文"}]};
  const responses = [mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(input.fullStory,input.creatorProfile)),design,report,
    {repairs:[{ref:"I1",disposition:"guidance_only",patches:[],note:"已有合理解释，保留原文"}]}];
  const requests=[];
  workflow.clients.MiMo={generateJson:async req=>{requests.push(req);return responses.shift();}};
  workflow.stageDefaults.animationPlan={provider:"MiMo",model:"test"};
  const result=await workflow.createAnimationPlan(input);
  assert.equal(requests.length,4);
  assert.deepEqual(storyboardDesignFromPlan(result),design);
  assert.ok(result.editorial.guidance.includes("已有合理解释，保留原文"));
  assert.ok(result.editorial.guidance.includes("需要留意动作"));
  assert.equal(result.editorial.finalReview,null);
});

test("修订以问题为单位原子应用，越界不修改分镜，伪造审查证据拒绝", async () => {
  const {input,plan}=await fixture();const design=storyboardDesignFromPlan(plan);
  const context={input:{fullStory:input.fullStory,targetDurationSeconds:input.fullStory.targetDurationSeconds},plan:design,items:[{ref:"I1"}]};
  const before=structuredClone(design);
  const result=applyEditorial({repairs:[{ref:"I1",disposition:"revise",note:"尝试越界",patches:[
    {path:["shotPlan","0","storyPurpose"],find:design.shotPlan[0].storyPurpose,replace:"修改"},
    {path:["shotPlan","0","beats","0","characters","0"],find:design.shotPlan[0].beats[0].characters[0],replace:"陌生人"}
  ]}]},context);
  assert.deepEqual(result.result,before);assert.deepEqual(design,before);
  assert.notEqual(result.rows[0].status,"applied");
  assert.throws(()=>validateStoryboardReview({strengths:[],guidance:[],items:[{ref:"I1",reportedProblem:"问题",guidance:"说明",originalEvidence:[{id:"P001",quote:"编造引文"}]}]},context));
});

test("单镜提示词单独调用、保留对白、不发送图片；缺提示词不得调用视频", async () => {
  const {workflow,plan}=await fixture();const shot=plan.shotPlan[0];
  const source=singleShotPromptInput(plan,shot.shotId,{provider:"Seedance",model:"doubao-seedance-2-0-260128"});
  assert.equal(source.fullStory,undefined);
  assert.equal(source.characterReferences.some(row=>Object.hasOwn(row,"referenceImageDataUrl")),false);
  const result=await workflow.createShotVideoPrompt({plan,shotId:shot.shotId,planDigest:"digest",target:{provider:"Seedance",model:"doubao-seedance-2-0-260128"}});
  assert.ok(result.videoPrompt.length);
  const args={planArtifactId:`animationPlan:${plan.selectedVariantId}`,planEntry:{content:plan},currentShotId:shot.shotId};
  assert.throws(()=>resolveAuthoritativeShotVideoInput(args),/提示词/);
  const authoritative=resolveAuthoritativeShotVideoInput({...args,promptOverride:result.videoPrompt});
  assert.equal(authoritative.shot.videoPrompt,result.videoPrompt);assert.equal(shot.videoPrompt,undefined);
  const match={planDigest:"digest",provider:result.target.provider,model:result.target.model,textProvider:result.writer.provider,textModel:result.writer.model};
  assert.ok(storyboardPromptMatches(result,match));
  assert.equal(storyboardPromptMatches(result,{...match,planDigest:"new"}),false);
  assert.equal(storyboardPromptMatches(result,{...match,model:"new"}),false);
  assert.equal(storyboardPromptMatches(result,{...match,textModel:"new"}),false);
});

test("结构化出镜和发声独立选参考；只有 continuous 默认参考上一镜", () => {
  const shot={beats:[{characters:["听者"],dialogue:[{speaker:"说者",source:"offscreen",text:"你好"}]}]};
  const refs=["听者","说者"].map(characterName=>({characterName,referenceAudioClips:[{id:"voice",dataUrl:"data:audio/wav;base64,AA==",durationSeconds:2}]}));
  assert.deepEqual(shotRelatedCharacterReferences(shot,refs).map(r=>r.characterName),["听者"]);
  assert.deepEqual(shotRelatedCharacterAudioClips(shot,refs).map(r=>r.characterName),["说者"]);
  for(const type of ["start","cut","ellipsis"]) assert.equal(storyboardUsesPreviousFrames({transitionIn:{type}}),false);
  assert.ok(storyboardUsesPreviousFrames({transitionIn:{type:"continuous"}}));
});

// ---------------------------------------------------------------------------
// 允许第一次做错：带诊断重试一次，预算封在 2 次，禁止第三次。
// 依据是 2026-09-21 的真实回放：模型把末段写成 20 秒，只有一条算术级诊断
// （/shotPlan/5/durationSeconds must be <= 15），整份 79 秒分镜连同 ¥0.35 一起丢弃，
// 而模型自己不知道漏了什么。AGENTS.md §2.12b ⑦ 已为同类失败定过结论：
// 事前在提示词里定规矩没用，事后拿诊断打回去重做有用。
// ---------------------------------------------------------------------------

// 预置响应按顺序发；超用即抛，所以「禁止第三次」是被证明的而不是被声明的。
function scriptedWorkflow(workflow, responses) {
  const requests = [];
  workflow.clients.MiMo = {async generateJson(request) {
    requests.push(request);
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error(`第 ${requests.length} 次调用没有预置响应——预算被超用了`);
    return next;
  }};
  workflow.stageDefaults.animationPlan = {provider: "MiMo", model: "test"};
  return requests;
}

const emptyReview = {strengths: ["保留已有动作"], guidance: [], items: []};

async function retryFixture() {
  const {workflow, input, plan} = await fixture();
  const design = storyboardDesignFromPlan(plan);
  const registry = mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(input.fullStory, input.creatorProfile));
  // 与那次真实失败同形：单段超过供应商 15 秒上限。ajv 先失败并提前返回，
  // 所以浮出水面的就是那一条诊断，和 live 完全一致。
  const overLongDesign = structuredClone(design);
  overLongDesign.shotPlan[0].durationSeconds = 16;
  return {workflow, input, design, registry, overLongDesign};
}

test("第一次被确定性校验拦下时带诊断重做一次，第二次通过就正常返回", async () => {
  const {workflow, input, design, registry, overLongDesign} = await retryFixture();
  const requests = scriptedWorkflow(workflow, [registry, overLongDesign, design, emptyReview]);
  const result = await workflow.createAnimationPlan(input);

  assert.equal(requests.length, 4);
  assert.deepEqual(storyboardDesignFromPlan(result), design);
  // 原提示词逐字保留在前面，末尾追加校验器数出来的那一条。
  assert.ok(requests[2].prompt.startsWith(requests[1].prompt));
  assert.match(requests[2].prompt, /上一次的输出被确定性校验拦下了/u);
  assert.match(requests[2].prompt, /\/shotPlan\/0\/durationSeconds .*STORYBOARD_SCHEMA_INVALID/u);
});

test("拦过一次就必须说出来：metadata 如实记调用次数与被拦诊断", async () => {
  const {workflow, input, design, registry, overLongDesign} = await retryFixture();
  scriptedWorkflow(workflow, [registry, overLongDesign, design, emptyReview]);
  const {metadata} = await workflow.createAnimationPlanWithMetadata(input);

  const byStage = new Map(metadata.storyboard.calls.map(row => [row.stage, row]));
  assert.equal(byStage.get("storyboardDesign").providerCalls, 2);
  assert.equal(byStage.get("storyboardDesign").rejections[0].attempt, 1);
  assert.equal(byStage.get("storyboardDesign").rejections[0].details[0].code, "STORYBOARD_SCHEMA_INVALID");
  assert.equal(byStage.get("storyboardDesign").rejections[0].details[0].path, "/shotPlan/0/durationSeconds");
  // 一次就写对的阶段照实记 1 次，别的阶段不受影响。
  assert.equal(byStage.get("storyboardCharacterFacts").providerCalls, 1);
  assert.equal(byStage.get("storyboardReview").providerCalls, 1);
  // 实数调用次数由 observer 计数，不是从「有没有被拦」反推出来的。
  assert.equal(metadata.storyboard.providerCalls, 4);
});

test("两次都被拦即 fail closed，且两次诊断都在、带 attempt 序号", async () => {
  const {workflow, input, registry, overLongDesign} = await retryFixture();
  // 只预置到第 3 次：真发起第 4 次调用会撞上「预算被超用了」，所以禁止第三次是被证明的。
  const requests = scriptedWorkflow(workflow, [registry, overLongDesign, overLongDesign]);
  const error = await workflow.createAnimationPlan(input).then(() => null, err => err);

  assert.ok(error, "两次都被拦必须失败，不得静默返回上一次的候选");
  assert.equal(requests.length, 3);
  // ModelPipelineError 会把诊断归一化：自定义的 attempt 落到 metadata 下，reason 变成 message。
  const attempts = (error.diagnostics || []).map(detail => detail.metadata?.attempt);
  assert.deepEqual([...new Set(attempts)], [1, 2]);
  assert.ok((error.diagnostics || []).every(detail => detail.code === "STORYBOARD_SCHEMA_INVALID"));
});

test("截断走单独的重试分支：要求压缩措辞而不是原样重发", async () => {
  const {workflow, input, design, registry} = await retryFixture();
  const requests = [];
  const responses = [registry, "__TRUNCATED__", design, emptyReview];
  workflow.clients.MiMo = {async requestCompletion(request) {
    requests.push(request);
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error(`第 ${requests.length} 次调用没有预置响应——预算被超用了`);
    if (next === "__TRUNCATED__") return {parsed: undefined, content: "{\"viewingIntent\":", finishReason: "length", requestId: "", usage: null, raw: ""};
    return {parsed: next, content: JSON.stringify(next), finishReason: "stop", requestId: "", usage: null, raw: JSON.stringify(next)};
  }};
  workflow.stageDefaults.animationPlan = {provider: "MiMo", model: "test"};
  const result = await workflow.createAnimationPlan(input);

  assert.equal(requests.length, 4);
  assert.deepEqual(storyboardDesignFromPlan(result), design);
  // 截断那一刻没有任何校验诊断：只认「有没有诊断」的分支会原样重发，第二次照样写超。
  assert.match(requests[2].prompt, /因为太长被截断/u);
  assert.doesNotMatch(requests[2].prompt, /确定性校验拦下/u);
  assert.ok(requests[2].maxCompletionTokens > (requests[1].maxCompletionTokens || 0));
});

test("没有结构化诊断时退回原提示词，不说一句空洞的「你错了」", () => {
  assert.equal(storyboardRetryPrompt({originalPrompt: "原文", details: []}), "原文");
  assert.equal(storyboardRetryPrompt({originalPrompt: "原文"}), "原文");
  assert.equal(storyboardRetryPrompt({originalPrompt: "原文", details: [{path: "/a", code: "X"}]}), "原文");
  const body = storyboardRetryPrompt({originalPrompt: "原文", details: [{path: "/shotPlan/5/durationSeconds", reason: "must be <= 15", code: "STORYBOARD_SCHEMA_INVALID"}]});
  assert.ok(body.startsWith("原文"));
  assert.match(body, /- \/shotPlan\/5\/durationSeconds must be <= 15（STORYBOARD_SCHEMA_INVALID）/u);
});

test("观测是 fail-open 的：侧车写入抛异常不改变本次成败", async () => {
  const {workflow, input, design, registry} = await retryFixture();
  workflow.stageModelOutputLogWriters = new Map([["storyboardDesign", {
    enabled: true,
    recordAttempt() {throw new Error("磁盘满了");}
  }]]);
  scriptedWorkflow(workflow, [registry, design, emptyReview]);
  const result = await workflow.createAnimationPlan(input);
  assert.deepEqual(storyboardDesignFromPlan(result), design);
});

test("演示模式不产生任何 provider 调用，重试预算不改变 mock 路径", async () => {
  const {workflow, input} = await fixture();
  assert.equal(workflow.hasLiveClient, false);
  const {animationPlan, metadata} = await workflow.createAnimationPlanWithMetadata(input);
  assert.equal(animationPlan.promptSchemaVersion, "4.0");
  // 一次都没调用过模型，台账就该是空的——不能因为加了重试就凭空记出一次。
  assert.deepEqual(metadata.storyboard.calls, []);
  assert.equal(metadata.storyboard.providerCalls, 0);
  assert.ok(animationPlan.editorial.guidance.some(text => text.includes("演示模式")));
});

test("单镜时长上下限只有一份：schema 与提示词都不得再写字面量", async () => {
  const contract = await fs.readFile(new URL("../src/storyboard-contract.js", import.meta.url), "utf8");
  const prompts = await fs.readFile(new URL("../src/storyboard-prompts.js", import.meta.url), "utf8");
  for (const [name, source] of [["storyboard-contract.js", contract], ["storyboard-prompts.js", prompts]]) {
    assert.match(source, /from "\.\/shot-duration-limits\.js"/u, `${name} 必须从唯一那份常量取时长边界`);
  }
  assert.match(contract, /minimum:DIRECT_SHOT_MIN_DURATION_SECONDS,maximum:DIRECT_SHOT_MAX_DURATION_SECONDS/u);
  assert.doesNotMatch(contract, /minimum:4,maximum:15/u);
  assert.match(prompts, /\$\{DIRECT_SHOT_MIN_DURATION_SECONDS\}–\$\{DIRECT_SHOT_MAX_DURATION_SECONDS\} 秒整数/u);
  assert.doesNotMatch(prompts, /必须是 4–15 秒整数/u);
});

test("六个分镜阶段逐字注册进 debug 侧车，scope 与 stage 名一一对应", async () => {
  const workflowSource = await fs.readFile(new URL("../src/storyboard-workflow.js", import.meta.url), "utf8");
  const serverSource = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const stages = ["storyboardCharacterFacts", "storyboardDesign", "storyboardReview", "storyboardRevision", "storyboardReviewFinal", "shotVideoPrompt"];
  for (const stage of stages) {
    // scope 取值必须逐字等于 stage 名：writer map 按 scope 建、按 stage 查，对不上就静默不写。
    assert.ok(Object.values(MODEL_OUTPUT_LOG_SCOPES).includes(stage), `${stage} 没有登记成 scope`);
    assert.ok(workflowSource.includes(`"${stage}"`), `${stage} 不再是 runJson 的 stage`);
    const key = Object.entries(MODEL_OUTPUT_LOG_SCOPES).find(([, value]) => value === stage)[0];
    assert.match(serverSource, new RegExp(`MODEL_OUTPUT_LOG_SCOPES\\.${key}\\b`, "u"), `${stage} 没有进 STAGE_MODEL_OUTPUT_LOG_SCOPES`);
  }
  // 走 coordinator 就拿不到 generateValidatedJson 自带的 recorder，必须自己接。
  assert.match(workflowSource, /attemptObserver/u);
});

test("消费者面：浏览器必须把「拦过一次」显示出来，旧 Plan 则整段不显示", async () => {
  const {workflow, input, design, registry, overLongDesign} = await retryFixture();
  scriptedWorkflow(workflow, [registry, overLongDesign, design, emptyReview]);
  const {animationPlan, metadata} = await workflow.createAnimationPlanWithMetadata(input);
  const helpers = {
    escape: value => String(value), block: (title, body) => `${title}${body}`, cell: (k, v) => `${k}${v}`,
    resultHeader: () => "", renderCharacters: () => "", renderVideo: () => "", videoLabel: "测试模型"
  };
  const withNote = renderStoryboard(animationPlan, {...helpers, metadata});
  assert.match(withNote, /分镜设计是第 2 次调用的结果/u);
  assert.match(withNote, /must be <= 15/u);
  assert.match(withNote, /story-review-status warn/u);
  // 旧 Plan 没有 calls 这个键时整段不显示——显示一个「1 次」会被读成「查过了没被拦」。
  assert.doesNotMatch(renderStoryboard(animationPlan, helpers), /story-review-status warn/u);
  assert.doesNotMatch(renderStoryboard(animationPlan, {...helpers, metadata: {storyboard: {version: "4.0"}}}), /story-review-status warn/u);
});

// ---------------------------------------------------------------------------
// 全局必需角色事实补写。依据是 2026-09-22 的真实回放：《迷路的蒲公英》5 次模型调用全部
// 一次通过，却在组装角色参考时缺了 identity 类的「学生或村民身份」而硬失败、¥1.37 作废。
// 剧情的 characterBible.protagonist.traits 从来没有「必须逐条镜像边界」的契约。
// 与 AGENTS.md §2.8 给精修那条路定的是同一条既有策略，不新建第二套规则。
// ---------------------------------------------------------------------------

// 演示夹具的边界只有一条 identity「阿岚」，而 characterName 本身就在扫描字段里、恒满足，
// 所以补写永远触发不了。按仓库既有写法重签一份带额外必需事实的边界。
function withRequiredTrait(workflow, input, trait) {
  const guardrails = structuredClone(input.visualGuardrails);
  const boundary = guardrails.fixedCharacterBoundary;
  delete boundary.sourceDigest; delete boundary.boundaryDigest; delete boundary.boundarySignature;
  boundary.requiredTraits = [...boundary.requiredTraits, trait];
  return {...input, visualGuardrails: sealGlobalCharacterBoundary(guardrails, input, workflow.characterBoundaryKey)};
}
const STORY_FUNCTION_TRAIT = {canonicalName: "村里的热心帮手", terms: ["村里的热心帮手"], scope: "storyFunction",
  evidenceLevel: "explicit", triggerEvidence: [{sourcePath: "creatorProfile.fixedCharacter", evidence: "社区修理师"}], reason: "测试用"};
const APPEARANCE_TRAIT = {...STORY_FUNCTION_TRAIT, canonicalName: "狼耳", terms: ["狼耳"], scope: "appearance"};

test("缺非外观必需事实时按签发顺序补进一致性标签，Plan 正常签发", async () => {
  const {workflow, input} = await fixture();
  const before = await workflow.createAnimationPlan(input);
  const primary = before.characterReferencePrompts.find(row => row.characterName === "阿岚");
  assert.equal(primary.consistencyTags.includes("村里的热心帮手"), false, "夹具本来就不该带这条");

  const {animationPlan} = await workflow.createAnimationPlanWithMetadata(withRequiredTrait(workflow, input, STORY_FUNCTION_TRAIT));
  const restored = animationPlan.characterReferencePrompts.find(row => row.characterName === "阿岚");
  // 尾部追加 exact canonicalName，不用同义词、不重排。
  assert.equal(restored.consistencyTags.at(-1), "村里的热心帮手");
  assert.deepEqual(restored.consistencyTags.slice(0, -1), primary.consistencyTags);
  // 冻结 appearancePrompt：补标签不能顶替把长相写对。
  assert.equal(restored.appearancePrompt, primary.appearancePrompt);
});

test("缺外观必需事实时仍然硬失败——补标签不会让图里长出狼耳", async () => {
  const {workflow, input} = await fixture();
  await assert.rejects(
    () => workflow.createAnimationPlan(withRequiredTrait(workflow, input, APPEARANCE_TRAIT)),
    /未沿用全局角色边界|狼耳/u
  );
});

test("服务端改了模型输出就必须说出来：boundaryRestores 如实记账", async () => {
  const {workflow, input} = await fixture();
  const clean = await workflow.createAnimationPlanWithMetadata(input);
  assert.deepEqual(clean.metadata.storyboard.boundaryRestores, [], "没补写时是空数组");

  const {metadata} = await workflow.createAnimationPlanWithMetadata(withRequiredTrait(workflow, input, STORY_FUNCTION_TRAIT));
  assert.deepEqual(metadata.storyboard.boundaryRestores, [{characterName: "阿岚", restoredTraits: ["村里的热心帮手"]}]);
});

test("补写说明只进 metadata，绝不进签发的 Artifact", async () => {
  const {workflow, input} = await fixture();
  const clean = await workflow.createAnimationPlan(input);
  const {animationPlan} = await workflow.createAnimationPlanWithMetadata(withRequiredTrait(workflow, input, STORY_FUNCTION_TRAIT));
  // 顶层键集合逐字相同：ensureStoryboardPlan 本来就是严格集合比较，这里再证一次。
  assert.deepEqual(Object.keys(animationPlan).sort(), Object.keys(clean).sort());
  const serialized = JSON.stringify(animationPlan);
  assert.equal(serialized.includes("boundaryRestore"), false);
  assert.equal(serialized.includes("boundaryWarning"), false);
});

test("补写对配角是 no-op：非边界角色的一致性标签逐字不变", async () => {
  const {workflow, input} = await fixture();
  const clean = await workflow.createAnimationPlan(input);
  const {animationPlan} = await workflow.createAnimationPlanWithMetadata(withRequiredTrait(workflow, input, STORY_FUNCTION_TRAIT));
  for (const row of animationPlan.characterReferencePrompts) {
    if (row.characterName === "阿岚") continue;
    const original = clean.characterReferencePrompts.find(item => item.characterName === row.characterName);
    assert.deepEqual(row.consistencyTags, original.consistencyTags);
  }
});

test("消费者面：浏览器必须把补写说明显示出来，旧 Plan 则整段不显示", async () => {
  const {workflow, input} = await fixture();
  const {animationPlan, metadata} = await workflow.createAnimationPlanWithMetadata(withRequiredTrait(workflow, input, STORY_FUNCTION_TRAIT));
  const helpers = {
    escape: value => String(value), block: (title, body) => `${title}${body}`, cell: (k, v) => `${k}${v}`,
    resultHeader: () => "", renderCharacters: () => "", renderVideo: () => "", videoLabel: "测试模型"
  };
  const shown = renderStoryboard(animationPlan, {...helpers, metadata});
  assert.match(shown, /阿岚 的角色参考缺了全局必需角色事实/u);
  assert.match(shown, /村里的热心帮手/u);
  // 旧 Plan 没有这个键、以及补过但为空时，整段都不显示。
  assert.doesNotMatch(renderStoryboard(animationPlan, helpers), /缺了全局必需角色事实/u);
  assert.doesNotMatch(renderStoryboard(animationPlan, {...helpers, metadata: {storyboard: {boundaryRestores: []}}}), /缺了全局必需角色事实/u);
});
