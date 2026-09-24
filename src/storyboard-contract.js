import Ajv from "ajv/dist/2020.js";
// 单镜时长上下限只有一份，在零依赖的 shot-duration-limits.js（供应商能力交集，AGENTS.md §2.3）。
// 提示词的预算行与这里的硬闸门共用它：两边各写一次必然漂移，结果就是模型被要求做 A、
// 却按 B 被拒（§2.14 已为同型情况定过规矩）。
import { DIRECT_SHOT_MAX_DURATION_SECONDS, DIRECT_SHOT_MIN_DURATION_SECONDS } from "./shot-duration-limits.js";
import { OutputContractError } from "./validation.js";
import { storyDurationWindow } from "../public/story-duration.js";
import { STORYBOARD_PLAN_VERSION } from "../public/storyboard-plan.js";
import { storyCharacterNames } from "./full-story-character-registry.js";
import { validateFullStoryRegistryStrict } from "./contracts/contract-validator.js";

const text = {type:"string",pattern:"\\S"};
const string = {type:"string"};
const array = (items,minItems=0) => ({type:"array",items,minItems});
const object = properties => ({type:"object",additionalProperties:false,properties,required:Object.keys(properties)});
const sources = {...array(text,1), uniqueItems:true};
const dialogue = object({speaker:text,text,source:{enum:["onscreen","offscreen"]},timing:text});
const beat = object({startSeconds:{type:"number",minimum:0},endSeconds:{type:"number",exclusiveMinimum:0},sourceSceneIds:sources,location:text,characters:array(text),framing:text,camera:text,visibleAction:text,dialogue:array(dialogue),soundDesign:string});
const shot = object({sourceSceneIds:sources,durationSeconds:{type:"integer",minimum:DIRECT_SHOT_MIN_DURATION_SECONDS,maximum:DIRECT_SHOT_MAX_DURATION_SECONDS},storyPurpose:text,emotionalTarget:text,transitionIn:object({type:{enum:["start","continuous","cut","ellipsis"]},description:text}),beats:array(beat,1),continuityOut:text,acceptanceCriteria:array(text,1)});
export const storyboardDesignSchema = object({viewingIntent:text,visualDesign:object({
  characters:array(object({name:text,appearance:string,designedDetails:array(text)}),1),
  locations:array(object({name:text,sourceSceneIds:sources,layout:text,lighting:text}),1),
  props:array(object({name:text,appearanceAndSupport:text}))
}),adaptations:array(object({sourceSceneIds:sources,original:text,change:text,reason:text})),blockedIssues:array(text),shotPlan:array(shot,1)});
const ajv = new Ajv({allErrors:true,strict:true});
const checkDesign = ajv.compile(storyboardDesignSchema);
export const storyboardDesignKeys = Object.keys(storyboardDesignSchema.properties);

export function storyboardDesignFromPlan(plan) {
  return Object.fromEntries(storyboardDesignKeys.map(key => [key,key === "shotPlan"
    ? (Array.isArray(plan.shotPlan) ? plan.shotPlan : []).map(row => { if(!row || typeof row !== "object") return row; const {shotId,...value}=row; return value; }) : structuredClone(plan[key])]));
}

// 诊断是结构化的 {code, path, reason}：path 用 RFC 6901 指针，与 ajv 的 instancePath 同形。
// 带诊断重试时模型收到的位置，必须和校验器判定的位置是同一个——**判据逐字未改**，
// 改的只是诊断的形状，让 OutputContractError.details 有东西可以打回去。
export const STORYBOARD_DIAGNOSTIC_CODES = Object.freeze({
  SCHEMA: "STORYBOARD_SCHEMA_INVALID",
  CHARACTER_COVERAGE: "STORYBOARD_CHARACTER_COVERAGE",
  UNKNOWN_SOURCE_SCENE: "STORYBOARD_UNKNOWN_SOURCE_SCENE",
  START_TRANSITION: "STORYBOARD_START_TRANSITION",
  BEAT_TIME_DISCONTINUOUS: "STORYBOARD_BEAT_TIME_DISCONTINUOUS",
  BEAT_SOURCE_OUT_OF_SHOT: "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT",
  BEAT_CHARACTER_UNREGISTERED: "STORYBOARD_BEAT_CHARACTER_UNREGISTERED",
  DIALOGUE_SPEAKER_CONFLICT: "STORYBOARD_DIALOGUE_SPEAKER_CONFLICT",
  BEATS_NOT_COVERING_SHOT: "STORYBOARD_BEATS_NOT_COVERING_SHOT",
  SCENE_NOT_CARRIED: "STORYBOARD_SCENE_NOT_CARRIED",
  TOTAL_DURATION_OUT_OF_WINDOW: "STORYBOARD_TOTAL_DURATION_OUT_OF_WINDOW"
});
const C = STORYBOARD_DIAGNOSTIC_CODES;

export function storyboardValidationErrors(value,input = {}) {
  const design = value?.promptSchemaVersion === STORYBOARD_PLAN_VERSION ? storyboardDesignFromPlan(value) : value;
  if (!checkDesign(design)) return checkDesign.errors.map(error => ({code:C.SCHEMA,path:error.instancePath || "/",reason:error.message}));
  const errors = [];
  const fail = (code,path,reason) => errors.push({code,path,reason});
  const names = input.fullStory ? storyCharacterNames(input.fullStory) : value?.productionStrategy?.characterNames || [];
  const sceneIds = input.fullStory ? input.fullStory.sceneScript.map(scene => scene.sceneId) : value?.productionStrategy?.sourceSceneIds || [];
  const designNames = design.visualDesign.characters.map(row => row.name);
  if (designNames.length !== new Set(designNames).size || designNames.length !== names.length || names.some(name => !designNames.includes(name))) fail(C.CHARACTER_COVERAGE,"/visualDesign/characters",`visualDesign 必须逐字覆盖全部出镜或发声角色：应为 ${names.join("、")}`);
  const knownSources = (ids,path) => {const unknown = ids.filter(id => !sceneIds.includes(id));if(unknown.length) fail(C.UNKNOWN_SOURCE_SCENE,path,`包含未知来源场次 ${unknown.join("、")}；只能引用 ${sceneIds.join("、")}`);};
  const covered = new Set(); let duration = 0;
  design.shotPlan.forEach((row,i) => {
    knownSources(row.sourceSceneIds,`/shotPlan/${i}/sourceSceneIds`);row.sourceSceneIds.forEach(id => covered.add(id));duration += row.durationSeconds;
    if ((i === 0) !== (row.transitionIn.type === "start")) fail(C.START_TRANSITION,`/shotPlan/${i}/transitionIn/type`,"start 只允许首段，其余片段用 continuous / cut / ellipsis");
    let end = 0;
    row.beats.forEach((entry,j) => {
      if(entry.startSeconds !== end || entry.endSeconds <= entry.startSeconds) fail(C.BEAT_TIME_DISCONTINUOUS,`/shotPlan/${i}/beats/${j}`,`时间不连续：本 beat 必须从 ${end} 秒开始且 endSeconds 大于 startSeconds，实际 ${entry.startSeconds}–${entry.endSeconds}`);
      end = entry.endSeconds;knownSources(entry.sourceSceneIds,`/shotPlan/${i}/beats/${j}/sourceSceneIds`);
      if(entry.sourceSceneIds.some(id => !row.sourceSceneIds.includes(id))) fail(C.BEAT_SOURCE_OUT_OF_SHOT,`/shotPlan/${i}/beats/${j}/sourceSceneIds`,`beat 引用了不在本片段中的场次 ${entry.sourceSceneIds.filter(id => !row.sourceSceneIds.includes(id)).join("、")}；本片段现有场次 ${row.sourceSceneIds.join("、")}；若 beat 确实演到了该场，就将其补进本片段的 sourceSceneIds；若没演到，就从 beat 的 sourceSceneIds 中去掉。`);
      if(new Set(entry.characters).size !== entry.characters.length || entry.characters.some(name => !names.includes(name))) fail(C.BEAT_CHARACTER_UNREGISTERED,`/shotPlan/${i}/beats/${j}/characters`,`角色未登记或重复；可用角色只有 ${names.join("、")}`);
      for(const line of entry.dialogue) if(!names.includes(line.speaker) || (line.source === "onscreen" && !entry.characters.includes(line.speaker))) fail(C.DIALOGUE_SPEAKER_CONFLICT,`/shotPlan/${i}/beats/${j}/dialogue`,`说话人或声音来源冲突：${line.speaker} 必须是已登记角色，且 source 为 onscreen 时必须同时出现在本 beat 的 characters 里`);
    });
    if(end !== row.durationSeconds) fail(C.BEATS_NOT_COVERING_SHOT,`/shotPlan/${i}/beats`,`beats 未覆盖完整片段：覆盖到 ${end} 秒，本片段 durationSeconds 是 ${row.durationSeconds} 秒`);
  });
  for(const [i,adaptation] of design.adaptations.entries()) {knownSources(adaptation.sourceSceneIds,`/adaptations/${i}/sourceSceneIds`);adaptation.sourceSceneIds.forEach(id => covered.add(id));}
  for(const [i,location] of design.visualDesign.locations.entries()) knownSources(location.sourceSceneIds,`/visualDesign/locations/${i}/sourceSceneIds`);
  const missing = sceneIds.filter(id => !covered.has(id));
  if(missing.length) fail(C.SCENE_NOT_CARRIED,"/shotPlan",`存在未承接也未说明省略的剧情场次 ${missing.join("、")}；承接就写进某个片段的 sourceSceneIds，省略就在 adaptations 里说明`);
  const window = input.durationWindow || storyDurationWindow(input.targetDurationSeconds || value?.productionStrategy?.targetRuntimeSeconds);
  if(!window || duration < window.min || duration > window.max) fail(C.TOTAL_DURATION_OUT_OF_WINDOW,"/shotPlan",`分镜总时长超出目标窗口：合计 ${duration} 秒，${window ? `窗口是 ${window.min}–${window.max} 秒` : "本次没有可用的时长窗口"}`);
  // blockedIssues are model editorial opinions, not a new product gate.
  return errors;
}

export function ensureStoryboardDesign(value,input) {
  const errors = storyboardValidationErrors(value,input);
  // details 是第二参数：classifyAttemptError 把 OutputContractError 判为 retryable 并把
  // details 原样放进 issue.diagnostics，所以这条路不需要任何错误类型转换。
  if(errors.length) throw new OutputContractError(`自主分镜校验失败：${errors.map(entry => `${entry.path} ${entry.reason}`).join("；")}`,errors);
  return value;
}

export function ensureStoryboardPlan(value,input = {}) {
  const keys = [...storyboardDesignKeys,"promptSchemaVersion","selectedVariantId","title","productionStrategy","characterRegistry","characterReferencePrompts","editorial"];
  if(!value || Object.keys(value).sort().join(",") !== keys.sort().join(",") || value.promptSchemaVersion !== STORYBOARD_PLAN_VERSION) throw new OutputContractError("新版 Animation Plan 字段或版本无效");
  const strategy = value.productionStrategy;
  if(!strategy || !["16:9","9:16"].includes(strategy.targetAspectRatio) || !["none","allowed"].includes(strategy.backgroundMusicMode)
    || !Array.isArray(strategy.characterNames) || !Array.isArray(strategy.sourceSceneIds)
    || typeof strategy.visualStyle !== "string" || typeof strategy.characterExpressionRules !== "string") throw new OutputContractError("新版 Animation Plan 制作参数无效");
  for(const key of ["selectedVariantId","title"]) if(typeof value[key] !== "string" || !value[key].trim()) throw new OutputContractError(`Animation Plan ${key} 不能为空`);
  if(strategy.format !== "storyboard_video" || !Number.isInteger(strategy.targetRuntimeSeconds) || strategy.targetRuntimeSeconds <= 0
    || new Set(strategy.characterNames).size !== strategy.characterNames.length || new Set(strategy.sourceSceneIds).size !== strategy.sourceSceneIds.length
    || [...strategy.characterNames,...strategy.sourceSceneIds].some(v => typeof v !== "string" || !v.trim())) throw new OutputContractError("新版分镜来源与时长无效");
  const registry = value.characterRegistry;
  const registryCheck = validateFullStoryRegistryStrict(registry);
  if(!registryCheck.ok) throw new OutputContractError("角色事实表结构无效", registryCheck.diagnostics);
  if(!registry?.protagonist || !Array.isArray(registry.supportingCharacters) || Object.keys(registry).sort().join(",") !== "protagonist,supportingCharacters") throw new OutputContractError("完整角色事实表缺失");
  const registeredNames = [registry.protagonist.name, ...registry.supportingCharacters.map(row => row?.name)];
  if(new Set(registeredNames).size !== registeredNames.length || registeredNames.length !== strategy.characterNames.length || strategy.characterNames.some(name => !registeredNames.includes(name))) throw new OutputContractError("角色事实表与出镜名单不一致");
  if(!Array.isArray(value.shotPlan) || value.shotPlan.some((row,i) => row?.shotId !== `A${String(i+1).padStart(2,"0")}`)) throw new OutputContractError("分镜 shotId 必须由服务端连续编号");
  if(!Array.isArray(value.characterReferencePrompts) || value.characterReferencePrompts.length !== strategy.characterNames.length || new Set(value.characterReferencePrompts.map(row => row.characterName)).size !== strategy.characterNames.length || strategy.characterNames.some(name => !value.characterReferencePrompts.some(row => row.characterName === name))) throw new OutputContractError("角色参考必须与完整角色名单一致");
  for(const row of value.characterReferencePrompts) if(!["characterName","storyRole","identity","appearancePrompt"].every(key => typeof row[key] === "string") || !Array.isArray(row.consistencyTags) || !Array.isArray(row.forbiddenChanges)) throw new OutputContractError("角色参考结构无效");
  if(!value.editorial || !Array.isArray(value.editorial.repairs) || !Array.isArray(value.editorial.guidance)) throw new OutputContractError("分镜修订说明缺失");
  return ensureStoryboardDesign(value,input);
}
