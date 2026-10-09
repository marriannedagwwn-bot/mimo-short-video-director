import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CHARACTER_BOUNDARY_SOURCE_STORY,
  CharacterBoundaryError,
  computeCharacterBoundarySourceDigest,
  sealGlobalCharacterBoundary,
  verifyGlobalCharacterBoundary
} from "../src/character-boundary.js";
import {
  STORY_ENTRY_REMOVED_CANDIDATE_FIELDS,
  storyCandidatesStrictSchema,
  storyEntryCandidatesStrictSchema,
  validateStoryCandidatesStrict,
  validateStoryEntryCandidatesStrict
} from "../src/contracts/contract-validator.js";
import {
  STORY_ENTRY_CANDIDATE_MODEL_FIELD_ORDER,
  storyEntryCandidatesModelSchema
} from "../src/contracts/story-candidates-model-schema.js";
import { deriveStoryCandidateProjections, ensureStoryEntryCandidatesContract, ensureThemeVariantsMatchProfile } from "../src/validation.js";
import { mockStoryEntryCandidates, mockVariants, mockVisualGuardrails } from "../src/mock.js";
import {
  STORY_ENTRY_PROFILE_FIELD_MAX_CHARS,
  STORY_SOURCE_SCHEMA_VERSION,
  STORY_SOURCE_TEXT_MAX_CHARS,
  StoryEntryInputError,
  normalizeStoryEntryCreatorProfile,
  normalizeStorySource
} from "../public/story-entry.js";
import {
  CHARACTER_BOUNDARY_SHARED_RULES,
  STORY_ENTRY_SYSTEM_PROMPT,
  STORY_SCENE_SCRIPT_CARE_RECIPIENT_SHAPE,
  STORY_SCENE_SCRIPT_MARKER,
  storyEntryCandidatePrompt,
  storyEntryFullStoryPrompt,
  storySceneScriptPrompt,
  storyEntryVisualGuardrailsPrompt
} from "../src/story-entry-prompts.js";
import { JSON_ONLY, SYSTEM_PROMPT, fullStoryPrompt, visualGuardrailsPrompt } from "../src/prompts.js";
import {
  PromptAnchorError,
  extractLineContainingExactlyOnce,
  extractSectionExactlyOnce,
  replaceExactlyOnce,
  replaceLineContainingExactlyOnce,
  replaceSectionExactlyOnce
} from "../src/prompt-anchors.js";
import { mockNarrativeFullStory } from "../src/mock.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import legacyFullStorySchema from "../src/contracts/schemas/legacy-full-story-strict.schema.json" with { type: "json" };
import { storyboardPrompt, storyboardPromptWithLockedDialogue } from "../src/storyboard-prompts.js";
import { storyEntryDialogueFaithfulness } from "../src/story-entry-dialogue-check.js";
import { WorkflowService } from "../src/workflow.js";

const KEY = Buffer.alloc(32, 7);
const profile = { fixedCharacter: "小满：八岁女孩，短发，黄色雨衣", vertical: "治愈日常", constraints: "60 秒内" };
const fullTextSource = { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode: "fullStoryText", storyText: "雨天，小满在路边捡到一只小猫。小满说：“别怕，我带你回家。”" };
const characterOnlySource = { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode: "characterOnly" };

// ---- 角色边界摘要：参考视频那一版逐字节不变，剧情入口用带版本号的另一版 ----

test("参考视频 Run 的角色边界摘要与改动前逐字节相同（golden）", () => {
  // 两个值由改动前的 src/character-boundary.js（HEAD e57f2c1 / 7265af9）对同一份输入算出。
  const fixture = {
    creatorProfile: { fixedCharacter: " 小满：短发女孩，黄色雨衣 ", vertical: "治愈日常", constraints: "60 秒内" },
    referenceAnalysis: { format: "短片", groundingSeal: { signature: "x" } },
    sourceScriptReconstruction: { scenes: [{ sceneId: "S1", timeRange: "00:00-00:05" }], groundingSeal: { signature: "y" } },
    creativeBrief: { storyEngine: { want: "回家" } }
  };
  assert.equal(computeCharacterBoundarySourceDigest(fixture), "sha256:151acf806831771ab5417bf3245c2efc1eac056faa4622fb18c3f290de47b0e7");
  assert.equal(computeCharacterBoundarySourceDigest({}), "sha256:055660a2a2e4a713115a449fc690bf035de44c5f044e8b7155a21b3202656409");
});

function rawGuardrails() {
  return { ...mockVisualGuardrails({ creatorProfile: profile }) };
}

test("剧情入口的角色边界按 v2 摘要签发与校验，两种版本互相验证都失败", () => {
  const storyInput = { creatorProfile: profile, storySource: fullTextSource };
  const sealed = sealGlobalCharacterBoundary(rawGuardrails(), storyInput, KEY, { source: CHARACTER_BOUNDARY_SOURCE_STORY });
  assert.ok(verifyGlobalCharacterBoundary(sealed, storyInput, KEY, { source: CHARACTER_BOUNDARY_SOURCE_STORY }));
  // 同一份签出的边界拿参考视频那一版去验：摘要对不上。
  assert.throws(() => verifyGlobalCharacterBoundary(sealed, { creatorProfile: profile }, KEY), CharacterBoundaryError);
  // 反过来：参考视频那一版签出的边界不能当剧情入口的用。
  const videoSealed = sealGlobalCharacterBoundary(rawGuardrails(), { creatorProfile: profile }, KEY);
  assert.throws(() => verifyGlobalCharacterBoundary(videoSealed, storyInput, KEY, { source: CHARACTER_BOUNDARY_SOURCE_STORY }), CharacterBoundaryError);
  // 改了故事原文或固定角色设定都要重签。
  assert.throws(() => verifyGlobalCharacterBoundary(sealed, { ...storyInput, storySource: { ...fullTextSource, storyText: `${fullTextSource.storyText}。` } }, KEY, { source: CHARACTER_BOUNDARY_SOURCE_STORY }), /故事原文/);
  assert.throws(() => verifyGlobalCharacterBoundary(sealed, { ...storyInput, creatorProfile: { ...profile, vertical: "科普" } }, KEY, { source: CHARACTER_BOUNDARY_SOURCE_STORY }), CharacterBoundaryError);
  // storySource 不合法时直接失败，不会退回成一个空摘要。
  assert.throws(() => computeCharacterBoundarySourceDigest({ creatorProfile: profile }, { source: CHARACTER_BOUNDARY_SOURCE_STORY }), CharacterBoundaryError);
  assert.throws(() => computeCharacterBoundarySourceDigest({}, { source: "unknown" }), /未知的角色边界来源/);
});

// ---- storySource 与 creatorProfile 的输入校验（浏览器与服务端共用） ----

test("storySource 只接受两种模式，粘贴原文必须有正文且不超过上限，只给角色不能带正文", () => {
  assert.deepEqual(normalizeStorySource({ storyMode: "fullStoryText", storyText: "  第一行\r\n第二行  " }), {
    schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode: "fullStoryText", storyText: "第一行\n第二行"
  });
  assert.deepEqual(normalizeStorySource({ storyMode: "characterOnly" }), { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode: "characterOnly" });
  assert.throws(() => normalizeStorySource({ storyMode: "fullStoryText", storyText: "   " }), StoryEntryInputError);
  assert.throws(() => normalizeStorySource({ storyMode: "characterOnly", storyText: "有正文" }), StoryEntryInputError);
  assert.throws(() => normalizeStorySource({ storyMode: "remix" }), StoryEntryInputError);
  assert.throws(() => normalizeStorySource({ storyMode: "characterOnly", extra: 1 }), /不认识的字段/);
  assert.throws(() => normalizeStorySource({ storyMode: "fullStoryText", storyText: "字".repeat(STORY_SOURCE_TEXT_MAX_CHARS + 1) }), /最多/);
  // 按码点计数：emoji 不被算成两个字。
  assert.ok(normalizeStorySource({ storyMode: "fullStoryText", storyText: "😀".repeat(STORY_SOURCE_TEXT_MAX_CHARS) }));
});

test("剧情入口的 creatorProfile 恰好三个字段，多一个键就拒绝", () => {
  assert.deepEqual(normalizeStoryEntryCreatorProfile({ fixedCharacter: " 小满 ", vertical: "治愈", constraints: "" }), { fixedCharacter: "小满", vertical: "治愈", constraints: "" });
  assert.throws(() => normalizeStoryEntryCreatorProfile({ fixedCharacter: "小满", vertical: "治愈", storyText: "混进来的正文" }), /多出/);
  assert.throws(() => normalizeStoryEntryCreatorProfile({ fixedCharacter: "", vertical: "治愈" }), /固定角色/);
  assert.throws(() => normalizeStoryEntryCreatorProfile({ fixedCharacter: "小满", vertical: "" }), /垂直赛道/);
  assert.throws(() => normalizeStoryEntryCreatorProfile({ fixedCharacter: "小满", vertical: "治愈", constraints: "字".repeat(STORY_ENTRY_PROFILE_FIELD_MAX_CHARS + 1) }), /不能超过/);
});

// ---- 原创候选的严格 Schema ----

function signedStoryCandidate() {
  const [candidate] = mockStoryEntryCandidates({ creatorProfile: profile }).variants;
  return deriveStoryCandidateProjections({ variants: [{ id: "V1", ...candidate }] });
}

test("剧情入口候选 Schema 只比视频版少四个对照原片的字段，并且恰好一个候选", () => {
  const video = storyCandidatesStrictSchema().$defs.storyCandidate;
  const story = storyEntryCandidatesStrictSchema().$defs.storyCandidate;
  assert.deepEqual(
    Object.keys(video.properties).filter((key) => !Object.hasOwn(story.properties, key)).sort(),
    [...STORY_ENTRY_REMOVED_CANDIDATE_FIELDS].sort()
  );
  assert.deepEqual(video.required.filter((key) => !story.required.includes(key)).sort(), [...STORY_ENTRY_REMOVED_CANDIDATE_FIELDS].sort());
  assert.equal(video.required.length, 22, "视频入口的严格 Schema 不变");
  const schema = storyEntryCandidatesStrictSchema();
  assert.equal(schema.properties.variants.maxItems, 1);
  assert.equal(Object.hasOwn(schema.$defs, "sourceReplacementPair"), false);
});

test("两份候选 Schema 互相不接受对方的候选；剧情入口的单个候选能通过完整契约", () => {
  const story = signedStoryCandidate();
  assert.equal(validateStoryEntryCandidatesStrict(story).ok, true);
  assert.equal(validateStoryCandidatesStrict(story).ok, false, "视频入口必填的来源字段缺失");
  const video = deriveStoryCandidateProjections(mockVariants({ creatorProfile: profile, count: 1 }));
  const rejected = validateStoryEntryCandidatesStrict(video);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some((detail) => detail.code === "STORY_ENTRY_CANDIDATES_SCHEMA_UNKNOWN_FIELD"));
  assert.equal(validateStoryEntryCandidatesStrict({ variants: [story.variants[0], { ...story.variants[0], id: "V2" }] }).ok, false);
  assert.doesNotThrow(() => ensureStoryEntryCandidatesContract(story));
});

test("只有一个候选时，叙事路径配比与结构分化检查不会触发", () => {
  const story = signedStoryCandidate();
  for (const narrativeMode of ["dramatic", "slice_of_life"]) {
    const single = { variants: [{ ...story.variants[0], narrativeMode }] };
    assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(single, profile, null, null));
  }
});

test("剧情入口的约束解码 Schema 不含服务端签发的 id 与三个投影", () => {
  const schema = storyEntryCandidatesModelSchema();
  const fields = Object.keys(schema.$defs.storyCandidate.properties);
  assert.deepEqual(fields, [...STORY_ENTRY_CANDIDATE_MODEL_FIELD_ORDER]);
  for (const field of ["id", "keyChoice", "climax", "emotionalPayoff", ...STORY_ENTRY_REMOVED_CANDIDATE_FIELDS]) {
    assert.equal(fields.includes(field), false, field);
  }
  assert.equal(schema.properties.variants.minItems, 1);
  assert.equal(schema.properties.variants.maxItems, 1);
  assert.equal(JSON.stringify(schema).includes("pattern"), false, "MiMo 把 pattern 当成全串匹配");
});

// ---- 提示词 ----

test("视频入口的完整剧情、角色边界与 4.0 分镜提示词与改动前逐字相同（golden）", () => {
  // 四个值由改动前的提交 7265af9 对同一份输入算出，证明剧情入口没有碰视频版提示词。
  // 以后有意修改视频版提示词时，按同一份输入重算并更新这里。
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const vg = mockVisualGuardrails({ creatorProfile: profile });
  const variant = deriveStoryCandidateProjections(mockVariants({ creatorProfile: profile, count: 1 })).variants[0];
  assert.equal(sha(fullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant, targetDurationSeconds: 60 })), "664de9a52cc957abeda4497e0216132c799d7ba592723bd7613211d4fa42f056");
  assert.equal(sha(fullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant })), "1ca4695b91a3198a6125182a1e8c5ca544f44851472525f12e0090b929e7388f");
  assert.equal(sha(visualGuardrailsPrompt({ creatorProfile: profile, referenceAnalysis: {}, sourceScriptReconstruction: { scenes: [] } })), "c67aed18ee3699a3068f54946ffaf835920e70870ff1099b5658682d5389fb2c");
  assert.equal(sha(storyboardPrompt({ durationWindow: { min: 51, max: 69 }, targetDurationSeconds: 60, targetAspectRatio: "16:9", fullStory: {} })), "e7428f562be38b85e6f45758f657d2b775737b4393598bd411eba580d123ef8f");
});

test("角色边界的共用判断规则仍逐字出现在视频版提示词里（防漂移）", () => {
  const video = visualGuardrailsPrompt({ creatorProfile: profile, referenceAnalysis: {}, sourceScriptReconstruction: { scenes: [] } });
  const story = storyEntryVisualGuardrailsPrompt({ creatorProfile: profile });
  for (const [name, line] of Object.entries(CHARACTER_BOUNDARY_SHARED_RULES)) {
    assert.ok(video.includes(line), `视频版缺少共用规则 ${name}`);
    assert.ok(story.includes(line), `剧情版缺少共用规则 ${name}`);
  }
  assert.ok(story.includes('"sourceSimilarityRules":[]'));
  assert.ok(story.includes("characterName 必须逐字写「小满」"));
});

test("剧情入口的提示词不提原片，也不用「受控改编」的系统提示", () => {
  const vg = mockVisualGuardrails({ creatorProfile: profile });
  const variant = signedStoryCandidate().variants[0];
  const prompts = {
    guardrails: storyEntryVisualGuardrailsPrompt({ creatorProfile: profile }),
    candidateCharacter: storyEntryCandidatePrompt({ creatorProfile: profile, visualGuardrails: vg, storySource: characterOnlySource, targetDurationSeconds: 60 }),
    fullStoryCharacter: storyEntryFullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant, storySource: characterOnlySource, targetDurationSeconds: 60 }),
    sceneScript: storySceneScriptPrompt({ creatorProfile: profile, visualGuardrails: vg, storySource: fullTextSource, targetDurationSeconds: 60 })
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.equal(prompt.includes("原片"), false, `${name} 不应出现原片`);
    assert.equal(prompt.includes(SYSTEM_PROMPT), false, `${name} 不应带受控改编系统提示`);
    assert.ok(prompt.startsWith(STORY_ENTRY_SYSTEM_PROMPT), name);
  }
  // 粘贴完整故事没有候选：候选与「只给角色设定」的完整剧情提示词遇到它直接报错，拆场提示词也只认它。
  assert.throws(() => storyEntryCandidatePrompt({ creatorProfile: profile, visualGuardrails: vg, storySource: fullTextSource }), /不生成故事候选/);
  assert.throws(() => storyEntryFullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant, storySource: fullTextSource }), /按原文拆场/);
  assert.throws(() => storySceneScriptPrompt({ creatorProfile: profile, visualGuardrails: vg, storySource: characterOnlySource }), /粘贴完整故事/);
  // 视频版完整剧情提示词仍是原样：带受控改编系统提示和原片表述。
  const video = fullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant, targetDurationSeconds: 60 });
  assert.ok(video.startsWith(SYSTEM_PROMPT));
  assert.ok(video.includes("不重新改编原片"));
  // 只给角色设定时只去掉原片表述，其余与视频版逐字相同。
  const characterOnly = prompts.fullStoryCharacter;
  assert.equal(characterOnly.length, video.length
    - SYSTEM_PROMPT.length + STORY_ENTRY_SYSTEM_PROMPT.length
    - "不重新改编原片，".length
    - "候选的来源证明、自评分与原片具体场次不作为本片剧情依据；那些字段不需要在 FullStory 再写一遍。".length
    - "原片的片尾卡和署名也不是本片素材。".length);
});

test("按原文拆场：提示词只有原文没有候选，主角改名与台词逐字，共用规则逐字取自视频版", () => {
  const vg = mockVisualGuardrails({ creatorProfile: profile });
  const prompt = storySceneScriptPrompt({ creatorProfile: profile, visualGuardrails: vg, storySource: fullTextSource, targetDurationSeconds: 75 });
  assert.ok(prompt.includes(STORY_SCENE_SCRIPT_MARKER));
  assert.ok(prompt.includes(`用户故事原文（本片唯一的剧情依据）：${JSON.stringify(fullTextSource.storyText)}`));
  assert.equal(prompt.includes("候选"), false);
  assert.equal(prompt.replaceAll("selectedVariantId", "").includes("Variant"), false);
  assert.ok(prompt.includes("一律改用「小满」——这是全片唯一允许改动的字"));
  assert.ok(prompt.includes("**台词只能逐字取自用户故事原文。**"));
  assert.ok(prompt.includes("本片目标约 75 秒，但时长服从原文"));
  assert.ok(prompt.includes('selectedVariantId 固定写 "V1"'));
  // 共用规则不另抄一份：场次合同、时间轴写法、字段职责与输出结构逐字来自视频版完整剧情提示词。
  const video = fullStoryPrompt({ creatorProfile: profile, visualGuardrails: vg, variant: {}, targetDurationSeconds: 75 });
  assert.ok(prompt.includes(extractSectionExactlyOnce(video, "场次合同：\n", "\n\n输出 fullStory，")));
  assert.ok(prompt.includes(extractLineContainingExactlyOnce(video, "- timeRange 使用 mm:ss-mm:ss")));
  assert.ok(prompt.includes(extractLineContainingExactlyOnce(video, "- sceneScript 写事情怎样发生；shotAndSound 只补环境声音")));
  assert.ok(prompt.includes(extractSectionExactlyOnce(video, "输出 fullStory，严格使用以下结构", "keyProps 只写")));
  assert.ok(prompt.endsWith(JSON_ONLY));
  // 被照料角色的形状与严格 Schema 是同一组字段。
  const shape = JSON.parse(`{${STORY_SCENE_SCRIPT_CARE_RECIPIENT_SHAPE}}`).careRecipient;
  assert.deepEqual(Object.keys(shape).sort(), [...legacyFullStorySchema.properties.characterBible.properties.careRecipient.required].sort());
});

test("锚点替换：锚点缺失或出现多次都直接报错，不发出半新半旧的提示词", () => {
  assert.equal(replaceExactlyOnce("甲乙丙", "乙", "丁"), "甲丁丙");
  assert.throws(() => replaceExactlyOnce("甲乙丙", "戊", "丁"), PromptAnchorError);
  assert.throws(() => replaceExactlyOnce("乙乙", "乙", "丁"), PromptAnchorError);
  assert.equal(replaceLineContainingExactlyOnce("a\nb 锚\nc", "锚", "x"), "a\nx\nc");
  assert.throws(() => replaceLineContainingExactlyOnce("锚\n锚", "锚", "x"), PromptAnchorError);
  assert.equal(replaceSectionExactlyOnce("头[开]中间[尾]后", "[开]", "[尾]", "新"), "头新[尾]后");
  assert.throws(() => replaceSectionExactlyOnce("[尾][开]", "[开]", "[尾]", "新"), PromptAnchorError);
  // 逐字截取同样只认唯一的锚点。
  assert.equal(extractLineContainingExactlyOnce("a\nb 锚\nc", "锚"), "b 锚");
  assert.throws(() => extractLineContainingExactlyOnce("锚\n锚", "锚"), PromptAnchorError);
  assert.throws(() => extractLineContainingExactlyOnce("a", "锚"), PromptAnchorError);
  assert.equal(extractSectionExactlyOnce("头[开]中间[尾]后", "[开]", "[尾]"), "[开]中间");
  assert.throws(() => extractSectionExactlyOnce("[开]中间", "[开]", "[尾]"), PromptAnchorError);
});

test("4.0 分镜：粘贴原文的 Run 锁定台词，视频版提示词不变", () => {
  const input = { durationWindow: { min: 51, max: 69 }, targetDurationSeconds: 60, targetAspectRatio: "16:9", fullStory: {} };
  const normal = storyboardPrompt(input);
  const locked = storyboardPromptWithLockedDialogue(input);
  assert.ok(normal.includes("调整非核心对白"));
  assert.equal(locked.includes("调整非核心对白"), false);
  assert.ok(locked.includes("对白不可改：Full Story 的每句台词都来自用户故事原文"));
});

// ---- 台词核对（只出报告） ----

test("台词核对：去掉标点后在原文里逐字找得到才算，只给角色设定时不适用", () => {
  const fullStory = { sceneScript: [
    { sceneId: "S1", dialogue: [{ speaker: "小满", line: "别怕，我带你回家！" }] },
    { sceneId: "S2", dialogue: [{ speaker: "小满", line: "你饿不饿？" }] }
  ] };
  const plan = { shotPlan: [{ shotId: "A01", beats: [{ dialogue: [{ speaker: "小满", text: "别怕" }, { speaker: "猫", text: "喵" }] }] }] };
  const report = storyEntryDialogueFaithfulness({ storySource: fullTextSource, fullStory, animationPlan: plan });
  assert.equal(report.applicable, true);
  assert.equal(report.checked, 4);
  assert.deepEqual(report.missing.map((item) => `${item.artifact}:${item.location}:${item.text}`), [
    "fullStory:S2:你饿不饿？",
    "animationPlan:A01:喵"
  ]);
  assert.deepEqual(storyEntryDialogueFaithfulness({ storySource: characterOnlySource, fullStory }), { applicable: false, checked: 0, missing: [] });
});

// ---- workflow：剧情入口的阶段方法 ----

function storyEntryWorkflow(responses) {
  const calls = [];
  const client = {
    async generateJson(args) {
      calls.push(args);
      const next = responses.shift();
      return typeof next === "function" ? next(args) : structuredClone(next);
    }
  };
  return { workflow: new WorkflowService({ client, characterBoundaryKey: KEY }), calls };
}

test("剧情入口角色边界：只发文字、用剧情入口的系统提示；模型写了 sourceSimilarityRules 就拒收", async () => {
  const storyEntry = { storyMode: "fullStoryText", storySource: fullTextSource };
  const ok = storyEntryWorkflow([rawGuardrails()]);
  const sealed = await ok.workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry });
  assert.ok(sealed.fixedCharacterBoundary.boundarySignature);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].systemPrompt, STORY_ENTRY_SYSTEM_PROMPT);
  assert.equal(ok.calls[0].frames, undefined, "没有任何图片或视频输入");
  assert.ok(ok.workflow.assertGlobalCharacterBoundary({ creatorProfile: profile, visualGuardrails: sealed }, { storyEntry }));

  const withRules = rawGuardrails();
  withRules.sourceSimilarityRules = [{ text: "x", sourceExpression: "伞", triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: "伞" }], appliesWhenReferenceUsed: true }];
  const rejected = storyEntryWorkflow([withRules]);
  await assert.rejects(
    () => rejected.workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry }),
    (error) => error.details?.some((detail) => detail.code === "STORY_ENTRY_SOURCE_SIMILARITY_RULES_FORBIDDEN")
  );
  // storyEntry 只能由服务端给；没有它就不跑。
  await assert.rejects(() => ok.workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }), /storyEntry/);
});

test("剧情入口候选：模型写的 id 被覆盖成 V1，三个投影由拍号派生，多给一个候选直接失败", async () => {
  const storyEntry = { storyMode: "characterOnly", storySource: characterOnlySource };
  const boundary = storyEntryWorkflow([rawGuardrails()]);
  const visualGuardrails = await boundary.workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry });
  const [modelCandidate] = mockStoryEntryCandidates({ creatorProfile: profile }).variants;
  const ok = storyEntryWorkflow([{ variants: [{ ...modelCandidate, id: "V9", keyChoice: "模型自己写的" }] }]);
  const result = await ok.workflow.createStoryEntryCandidate({ creatorProfile: profile, visualGuardrails, targetDurationSeconds: 60 }, { storyEntry });
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].id, "V1");
  assert.equal(result.variants[0].keyChoice, result.variants[0].storyOutline[result.variants[0].keyChoiceBeat - 1].action);
  assert.equal(ok.calls[0].systemPrompt, STORY_ENTRY_SYSTEM_PROMPT);
  assert.equal(ok.calls[0].responseSchema.schema.properties.variants.maxItems, 1);
  const two = storyEntryWorkflow([{ variants: [modelCandidate, modelCandidate] }]);
  await assert.rejects(
    () => two.workflow.createStoryEntryCandidate({ creatorProfile: profile, visualGuardrails, targetDurationSeconds: 60 }, { storyEntry }),
    (error) => error.details?.some((detail) => detail.code === "STORY_ENTRY_CANDIDATE_COUNT")
  );
  // 参考视频那一版签出的边界不能用于剧情入口。
  const videoBoundary = sealGlobalCharacterBoundary(rawGuardrails(), { creatorProfile: profile }, KEY);
  await assert.rejects(() => ok.workflow.createStoryEntryCandidate({ creatorProfile: profile, visualGuardrails: videoBoundary }, { storyEntry }), /故事原文/);
});

test("剧情入口完整剧情：粘贴完整故事不要候选、V1 是故事位；只给角色设定照旧要候选；视频入口仍要创意简报", async () => {
  const workflow = new WorkflowService({ characterBoundaryKey: KEY });
  const storyEntry = { storyMode: "fullStoryText", storySource: fullTextSource };
  const visualGuardrails = await workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry });
  const input = { creatorProfile: profile, visualGuardrails, fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 60 };
  const story = await workflow.createFullStory(input, { storyEntry });
  assert.equal(story.selectedVariantId, "V1");
  await assert.rejects(() => workflow.createFullStory({ ...input, variant: { id: "V1" } }, { storyEntry }), /没有故事候选/);
  await assert.rejects(() => workflow.createStoryEntryCandidate({ creatorProfile: profile, visualGuardrails }, { storyEntry }), /不生成故事候选/);

  const characterEntry = { storyMode: "characterOnly", storySource: characterOnlySource };
  const characterGuardrails = await workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry: characterEntry });
  const themeVariants = await workflow.createStoryEntryCandidate({ creatorProfile: profile, visualGuardrails: characterGuardrails, targetDurationSeconds: 60 }, { storyEntry: characterEntry });
  const characterInput = { ...input, visualGuardrails: characterGuardrails };
  const characterStory = await workflow.createFullStory({ ...characterInput, themeVariants, variant: themeVariants.variants[0] }, { storyEntry: characterEntry });
  assert.equal(characterStory.selectedVariantId, "V1");
  await assert.rejects(() => workflow.createFullStory(characterInput, { storyEntry: characterEntry }), /variant/);
  await assert.rejects(() => workflow.createFullStory(input), /creativeBrief/);
});

test("按原文拆场的真实调用：用拆场提示词与剧情入口系统提示，模型回显的 selectedVariantId 不作数", async () => {
  const storyEntry = { storyMode: "fullStoryText", storySource: fullTextSource };
  const boundary = storyEntryWorkflow([rawGuardrails()]);
  const visualGuardrails = await boundary.workflow.createStoryEntryVisualGuardrails({ creatorProfile: profile }, { storyEntry });
  const raw = { ...mockNarrativeFullStory({ creatorProfile: profile, visualGuardrails, storySource: fullTextSource, targetDurationSeconds: 60 }), selectedVariantId: "V7" };
  const registry = mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(raw, profile));
  const live = storyEntryWorkflow([raw, registry]);
  const story = await live.workflow.createFullStory(
    { creatorProfile: profile, visualGuardrails, fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 60 },
    { storyEntry }
  );
  assert.equal(story.selectedVariantId, "V1");
  assert.equal(live.calls.length, 2);
  assert.ok(live.calls[0].prompt.includes(STORY_SCENE_SCRIPT_MARKER));
  assert.ok(live.calls[0].prompt.includes(JSON.stringify(fullTextSource.storyText)));
  assert.equal(live.calls[0].systemPrompt, STORY_ENTRY_SYSTEM_PROMPT);
});
