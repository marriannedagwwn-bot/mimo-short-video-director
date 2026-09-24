import test from "node:test";
import assert from "node:assert/strict";
import { mockBrief, mockFullStory, mockNarrativeFullStory, mockReconstruction } from "../src/mock.js";
import { ensureOutputContract } from "../src/validation.js";
import { fullStoryPrompt } from "../src/prompts.js";
import { FULL_STORY_SCHEMA_VERSION, fullStoryCandidateFacts, fullStoryCharacterFacts } from "../src/full-story-contract.js";
import { WorkflowService } from "../src/workflow.js";
import { groundingContextDigest, sealReconstruction } from "../src/reconstruction-grounding.js";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";

const profile = { fixedCharacter: "阿岚，社区修理师", vertical: "社区日常", constraints: "" };
const variant = {
  id: "V1", title: "修理收音机", narrativeMode: "slice_of_life",
  characterSetup: { protagonist: profile.fixedCharacter, careRecipient: "铃木奶奶", helper: "便利店员" },
  newTask: "修好收音机", environmentPressure: "夜晚", keyDialogueDirections: ["自然交谈"],
  storyOutline: [{ beat: 1, phase: "修理", action: "阿岚打开收音机，铃木奶奶递给她螺丝刀。", emotion: "期待", dramaticFunction: "一起修理", estimatedSeconds: 12 }],
  keyChoice: "决定修理", climax: "收音机重新响起", emotionalPayoff: "共同听歌"
};
const input = { creatorProfile: profile, variant, targetDurationSeconds: 60 };

function currentStory() { return mockNarrativeFullStory(input); }
function hasDiagnostic(code, path) {
  return error => error.details?.some(detail => detail.code === code && (!path || detail.path === path));
}

test("explicit narrative format accepts five scenes without requiring a second action manuscript", () => {
  const story = currentStory();
  story.sceneScript = story.sceneScript.slice(0, 5);
  const frozen = structuredClone(story);
  assert.equal(ensureOutputContract(story, "fullStory"), story);
  assert.deepEqual(story, frozen);
  assert.equal(story.schemaVersion, FULL_STORY_SCHEMA_VERSION);
  for (const key of ["beatSheet", "transformationProof", "experienceFidelity", "shootingPlan", "retentionPlan", "continuityAndSafetyCheck"]) {
    assert.equal(Object.hasOwn(story, key), false);
    const extra = structuredClone(story);
    extra[key] = [];
    assert.throws(() => ensureOutputContract(extra, "fullStory"), hasDiagnostic("FULL_STORY_SCHEMA_UNKNOWN_FIELD", `/${key}`));
  }
});

test("current format has no fixed scene quota but rejects an empty story and malformed scene data", () => {
  const one = currentStory();
  one.sceneScript = one.sceneScript.slice(0, 1);
  assert.doesNotThrow(() => ensureOutputContract(one, "fullStory"));
  const empty = structuredClone(one);
  empty.sceneScript = [];
  assert.throws(() => ensureOutputContract(empty, "fullStory"), hasDiagnostic("FULL_STORY_SCHEMA_MIN_ITEMS", "/sceneScript"));
  for (const [field, value] of [["visibleAction", ""], ["dialogue", {}], ["characters", null]]) {
    const bad = structuredClone(one);
    bad.sceneScript[0][field] = value;
    assert.throws(() => ensureOutputContract(bad, "fullStory"));
  }
});

test("version routing never upgrades old data or admits an unknown version", () => {
  const legacy = mockFullStory(input);
  const frozen = structuredClone(legacy);
  assert.equal(ensureOutputContract(legacy, "fullStory"), legacy);
  assert.deepEqual(legacy, frozen);
  legacy.sceneScript.pop();
  assert.throws(() => ensureOutputContract(legacy, "fullStory"), /至少需要 6 个可拍摄分场/u);
  for (const version of ["full_story/9.9", "full_story/1.0", null]) {
    const story = currentStory();
    story.schemaVersion = version;
    assert.throws(() => ensureOutputContract(story, "fullStory"));
  }
});

test("narrative notes may be empty without relaxing their type or required action fields", () => {
  const story = currentStory();
  story.sceneScript.forEach((scene) => { scene.shootingNotes = ""; });
  assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  const before = structuredClone(story);
  for (const value of [null, {}, []]) {
    const bad = structuredClone(story);
    bad.sceneScript[0].shootingNotes = value;
    assert.throws(() => ensureOutputContract(bad, "fullStory"), hasDiagnostic("FULL_STORY_SCHEMA_TYPE", "/sceneScript/0/shootingNotes"));
  }
  assert.deepEqual(story, before);
  const legacy = mockFullStory(input);
  legacy.sceneScript[0].shootingNotes = "";
  assert.throws(() => ensureOutputContract(legacy, "fullStory"), hasDiagnostic("FULL_STORY_SCHEMA_EMPTY_STRING", "/sceneScript/0/shootingNotes"));
});

test("the observed V4 proof-pair failure remains a failure in the legacy contract", () => {
  const story = mockFullStory(input);
  // Minimal reproduction of all five object-versus-string diagnostics from
  // the 2026-09-14 real V4 response; the complete original is in A evidence.
  for (const field of Object.keys(story.transformationProof)) {
    story.transformationProof[field] = { source: "原片事实", replacement: "本片事实" };
  }
  const frozen = structuredClone(story);
  assert.throws(() => ensureOutputContract(story, "fullStory"), (error) => {
    assert.equal(error.details.length, 5);
    assert.ok(error.details.every(detail => detail.code === "FULL_STORY_SCHEMA_TYPE" && detail.path.startsWith("/transformationProof/")));
    return true;
  });
  assert.deepEqual(story, frozen);
});

test("current scenes retain exact visible-character and dialogue-speaker protections", () => {
  const missingVisible = currentStory();
  missingVisible.sceneScript[0].visibleAction += "铃木奶奶走进来。";
  assert.throws(() => ensureOutputContract(missingVisible, "fullStory"), hasDiagnostic("FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING"));
  const missingSpeaker = currentStory();
  missingSpeaker.sceneScript[0].dialogue[0].speaker = "铃木奶奶";
  assert.throws(() => ensureOutputContract(missingSpeaker, "fullStory"), hasDiagnostic("FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING"));
  const duplicate = currentStory();
  duplicate.sceneScript[1].sceneId = duplicate.sceneScript[0].sceneId;
  assert.throws(() => ensureOutputContract(duplicate, "fullStory"));
});

test("candidate facts retain every selected action and omit source proof without mutating input", () => {
  const source = {
    ...variant,
    transformationProof: { changedTask: { source: "SOURCE_PROOF_SENTINEL", replacement: "PROOF_EVALUATION_SENTINEL" } },
    experienceFidelity: { plotDriver: "SOURCE_ENGINE_SENTINEL" },
    highValueBeatMapping: [{ briefBeat: "REFERENCE_BEAT_SENTINEL", newExpression: "EVALUATION_SENTINEL" }]
  };
  const frozen = structuredClone(source);
  const facts = fullStoryCandidateFacts(source);
  assert.deepEqual(facts.storyOutline, source.storyOutline);
  for (const field of ["id", "title", "characterSetup", "newTask", "environmentPressure", "keyChoice", "climax", "emotionalPayoff", "narrativeMode"]) assert.deepEqual(facts[field], source[field]);
  assert.equal(Object.hasOwn(facts, "keyDialogueDirections"), false);
  const prompt = fullStoryPrompt({ ...input, variant: source, creativeBrief: { note: "BRIEF_SENTINEL" }, referenceAnalysis: { note: "ANALYSIS_SENTINEL" }, sourceScriptReconstruction: { note: "RECONSTRUCTION_SENTINEL" } });
  const payload = JSON.parse(prompt.split("\n").find(line => line.startsWith("选中候选的故事事实：")).slice("选中候选的故事事实：".length));
  assert.deepEqual(payload, facts);
  assert.equal(prompt.includes(source.keyDialogueDirections[0]), false);
  const alternateDraft = { ...source, keyDialogueDirections: ["UNRELATED_DIALOGUE_DRAFT"] };
  assert.equal(fullStoryPrompt({ ...input, variant: alternateDraft }), fullStoryPrompt({ ...input, variant: source }));
  assert.doesNotMatch(prompt, /SOURCE_PROOF_SENTINEL|PROOF_EVALUATION_SENTINEL|SOURCE_ENGINE_SENTINEL|REFERENCE_BEAT_SENTINEL|EVALUATION_SENTINEL|BRIEF_SENTINEL|ANALYSIS_SENTINEL|RECONSTRUCTION_SENTINEL/u);
  facts.storyOutline[0].action = "changed projection";
  assert.deepEqual(source, frozen);
});

test("character projection retains granted and forbidden abilities plus user dialogue rules", () => {
  const traits = [{ canonicalName: "外观配饰", terms: ["光环"], scope: "appearance", reason: "SOURCE_REASON_SENTINEL", triggerEvidence: [{ evidence: "SOURCE_TEXT_SENTINEL" }] }];
  const guardrails = { fixedCharacterBoundary: { characterName: "阿岚", canonicalDescription: "角色事实", bodyForm: "人类", requiredTraits: traits, allowedTraits: [{ canonicalName: "已声明能力", terms: ["能力"], scope: "ability" }], forbiddenTraits: [{ canonicalName: "未授权动作", terms: ["飞行"], scope: "ability" }], boundarySignature: "AUTH_SENTINEL" }, dialogueRules: [{ text: "只说用户允许的词", triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "只说用户允许的词" }] }] };
  const before = structuredClone(guardrails);
  const facts = fullStoryCharacterFacts(guardrails);
  assert.deepEqual(facts.requiredTraits, [{ canonicalName: "外观配饰", terms: ["光环"], scope: "appearance" }]);
  assert.deepEqual(facts.allowedTraits, guardrails.fixedCharacterBoundary.allowedTraits);
  assert.deepEqual(facts.forbiddenTraits, guardrails.fixedCharacterBoundary.forbiddenTraits);
  assert.deepEqual(facts.dialogueRules, guardrails.dialogueRules);
  assert.doesNotMatch(JSON.stringify(facts), /AUTH_SENTINEL|SOURCE_REASON_SENTINEL|SOURCE_TEXT_SENTINEL/u);
  assert.deepEqual(guardrails, before);
});

const observedSourceDialogueRules = [
  "台词风格应温暖、亲切、充满童趣",
  "台词应简短、口语化，多用语气词",
  "台词信息密度应低，侧重情感表达而非信息传递",
  "通过简单对话传递关爱、鼓励与家庭温情"
].map(text => ({ text, triggerEvidence: [{ sourcePath: "referenceAnalysis.dialogueStyle", evidence: text }] }));

test("the observed source dialogue style never becomes a Full Story user rule", () => {
  const guardrails = { dialogueRules: observedSourceDialogueRules };
  const before = structuredClone(guardrails);
  assert.deepEqual(fullStoryCharacterFacts(guardrails).dialogueRules, []);
  const withSource = fullStoryPrompt({ ...input, visualGuardrails: guardrails });
  assert.equal(withSource, fullStoryPrompt({ ...input, visualGuardrails: { dialogueRules: [] } }));
  assert.deepEqual(guardrails, before, "The issued upstream Artifact is not edited or re-signed.");
});

test("explicit user speech rules are preserved even when their wording resembles source style", () => {
  const rules = [
    { text: observedSourceDialogueRules[0].text, triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "台词风格应温暖、亲切、充满童趣" }] },
    { text: "阿岚只说谢谢和再见", triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: "阿岚只说谢谢和再见" }] }
  ];
  const guardrails = { dialogueRules: [...observedSourceDialogueRules, ...rules] };
  const before = structuredClone(guardrails);
  const retained = fullStoryCharacterFacts(guardrails).dialogueRules;
  assert.deepEqual(retained, rules, "Authority comes from the source field, not a vocabulary ban.");
  retained[0].text = "changed projection";
  retained[1].triggerEvidence[0].evidence = "changed evidence";
  assert.deepEqual(guardrails, before);
});

test("mixed, unknown and missing rule provenance is not promoted into a user command", () => {
  const userEvidence = { sourcePath: "creatorProfile.constraints", evidence: "只说谢谢" };
  const badRules = [
    { text: "只说谢谢并用温情台词点题", triggerEvidence: [userEvidence, { sourcePath: "referenceAnalysis.dialogueStyle", evidence: "温情" }] },
    { text: "UNKNOWN_SENTINEL", triggerEvidence: [{ sourcePath: "creatorProfile.constraints.extra", evidence: "未知字段" }] },
    { text: "BRIEF_RULE_SENTINEL", triggerEvidence: [{ sourcePath: "creativeBrief", evidence: "温暖" }] },
    { text: "MISSING_SENTINEL" },
    { text: "EMPTY_EVIDENCE_SENTINEL", triggerEvidence: [] },
    { text: "BLANK_EVIDENCE_SENTINEL", triggerEvidence: [{ ...userEvidence, evidence: " " }] },
    { text: "", triggerEvidence: [userEvidence] },
    null
  ];
  assert.deepEqual(fullStoryCharacterFacts({ dialogueRules: badRules }).dialogueRules, []);
  assert.deepEqual(fullStoryCharacterFacts({ dialogueRules: null }).dialogueRules, []);
  assert.deepEqual(fullStoryCharacterFacts().dialogueRules, []);
});

function groundedInput(workflow) {
  const source = sealReconstruction(mockReconstruction({}), workflow.groundingKey, groundingContextDigest({ transcript: "", metadata: {}, frames: [], video: null }));
  return withGlobalCharacterBoundary(workflow, { ...input, referenceAnalysis: {}, sourceScriptReconstruction: source, creativeBrief: mockBrief(input) });
}

test("the verified workflow isolates source rules while retaining explicit user rules and upstream data", async () => {
  const requests = [];
  const workflow = new WorkflowService({ client: { async generateJson(request) { requests.push(request); return currentStory(); } } });
  const grounded = groundedInput(workflow);
  grounded.creatorProfile = { ...grounded.creatorProfile, constraints: "对白风格温暖、亲切；允许自然提问。" };
  const userRule = { text: "允许自然提问", triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "允许自然提问" }] };
  const rawGuardrails = structuredClone(grounded.visualGuardrails);
  for (const field of ["sourceDigest", "boundaryDigest", "boundarySignature"]) delete rawGuardrails.fixedCharacterBoundary[field];
  rawGuardrails.dialogueRules = [...observedSourceDialogueRules, userRule];
  grounded.visualGuardrails = sealGlobalCharacterBoundary(rawGuardrails, grounded, workflow.characterBoundaryKey);
  const before = structuredClone(grounded);
  await workflow.createFullStory(grounded);
  assert.equal(requests.length, 1);
  const prompt = requests[0].prompt;
  const label = "已签发的固定角色事实与用户对白规则：";
  const facts = JSON.parse(prompt.split("\n").find(line => line.startsWith(label)).slice(label.length));
  assert.deepEqual(facts.dialogueRules, [userRule]);
  assert.ok(prompt.includes(grounded.creatorProfile.constraints));
  for (const rule of observedSourceDialogueRules) assert.equal(prompt.includes(rule.text), false);
  assert.deepEqual(grounded, before);
});

test("new runtime result has one generation call, immutable actions and no synthetic postpass verdict", async () => {
  const requests = [];
  const expected = currentStory();
  const before = structuredClone(expected);
  const workflow = new WorkflowService({ client: { async generateJson(request) { requests.push(request); return structuredClone(expected); } } });
  const result = await workflow.createFullStory(groundedInput(workflow));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].prompt.includes(FULL_STORY_SCHEMA_VERSION));
  assert.deepEqual(result, before);
  assert.deepEqual(expected, before);
});

test("draft dialogue is excluded through the workflow while selected actions and user rules stay frozen", async () => {
  const requests = [];
  const expected = currentStory();
  expected.sceneScript[0].dialogue = [{ speaker: expected.sceneScript[0].characters[0], line: "这个旋钮松了，能把螺丝刀递给我吗？", deliveryOrSubtext: "拧不动旋钮，抬头向身旁的人求助。" }];
  const workflow = new WorkflowService({ client: { async generateJson(request) { requests.push(request); return structuredClone(expected); } } });
  const grounded = groundedInput(workflow);
  grounded.variant.keyDialogueDirections = ["阿岚：「这里修好的不只是收音机，还有我们温暖的回忆。」"];
  const before = structuredClone(grounded.variant);
  const result = await workflow.createFullStory(grounded);
  assert.equal(requests.length, 1);
  const prompt = requests[0].prompt;
  const factsLabel = "选中候选的故事事实：";
  const facts = JSON.parse(prompt.split("\n").find(line => line.startsWith(factsLabel)).slice(factsLabel.length));
  assert.deepEqual(facts.storyOutline, before.storyOutline);
  assert.equal(Object.hasOwn(facts, "keyDialogueDirections"), false);
  assert.equal(prompt.includes(before.keyDialogueDirections[0]), false, "Exclude the draft field as a whole; do not ban individual words or rewrite selected actions.");
  assert.match(prompt, /这个角色此刻为什么对这个对象说这句话/u);
  assert.match(prompt, /这个角色凭什么已经知道话里的事/u);
  assert.match(prompt, /不能一概禁止/u);
  assert.deepEqual(result, expected, "The model's revised dialogue is issued as returned, with no local substitution or second rewrite.");
  assert.deepEqual(grounded.variant, before);
});

test("new runtime rejects an unusable downstream timeline without inventing time or retrying", async () => {
  const story = currentStory();
  story.sceneScript[0].timeRange = "00:00-00:03";
  let calls = 0;
  const workflow = new WorkflowService({ client: { async generateJson() { calls++; return structuredClone(story); } } });
  await assert.rejects(() => workflow.createFullStory(groundedInput(workflow)), /低于视频供应商/u);
  assert.equal(calls, 1);
  assert.equal(story.sceneScript[0].timeRange, "00:00-00:03");
});
