export const STRUCTURED_ANIMATION_PROMPT_VERSION = "2.0";

export const COMPILED_ANIMATION_SHOT_ALIAS_FIELDS = Object.freeze([
  "startFramePrompt",
  "endFramePrompt",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes"
]);

export class AnimationPromptCompilerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AnimationPromptCompilerError";
    this.details = details;
  }
}

export function isStructuredAnimationShot(shot, versionOrPlan) {
  return promptSchemaVersionOf(versionOrPlan) === STRUCTURED_ANIMATION_PROMPT_VERSION && isRecord(shot);
}

export function compileAnimationShotPrompts(shot) {
  assertRecord(shot, "shot");
  assertRecord(shot.startFrame, "shot.startFrame");
  assertRecord(shot.endFrame, "shot.endFrame");
  assertRecord(shot.motion, "shot.motion");

  const motion = shot.motion;
  return {
    startFramePrompt: compileFramePrompt(shot.startFrame),
    endFramePrompt: compileFramePrompt(shot.endFrame),
    videoPrompt: compileVideoPrompt(motion),
    cameraMotion: compileCameraMove(motion.cameraMove),
    characterAction: cleanText(motion.primaryAction),
    dialogueOrSubtitle: compileDialogue(motion.audio?.dialogue),
    soundDesign: compileSoundDesign(motion),
    continuityNotes: compileContinuityNotes(shot.startFrame, shot.endFrame, motion)
  };
}

export function rebuildAnimationShotPrompts(shot) {
  assertRecord(shot, "shot");
  return { ...shot, ...compileAnimationShotPrompts(shot) };
}

export function normalizeAnimationShotPrompts(shot, versionOrPlan) {
  if (!isStructuredAnimationShot(shot, versionOrPlan)) return shot;

  const compiled = compileAnimationShotPrompts(shot);
  for (const field of COMPILED_ANIMATION_SHOT_ALIAS_FIELDS) {
    if (!Object.hasOwn(shot, field)) continue;
    if (shot[field] === compiled[field]) continue;
    throw new AnimationPromptCompilerError(
      `结构化镜头的已存在别名 ${field} 与编译结果不一致`,
      {
        field,
        existing: shot[field],
        compiled: compiled[field],
        shotId: cleanText(shot.shotId)
      }
    );
  }
  return { ...shot, ...compiled };
}

function compileFramePrompt(frame) {
  const sections = [];
  addSection(sections, "时间与天气", frame.timeAndWeather);

  const characters = (Array.isArray(frame.characters) ? frame.characters : [])
    .map(compileCharacter)
    .filter(Boolean);
  if (characters.length) sections.push(`角色：${characters.join("；")}`);

  const environment = compileNamedFields(frame.environment, [
    ["场景 ID", "sceneId"],
    ["前景", "foreground"],
    ["中景", "midground"],
    ["背景", "background"],
    ["氛围", "atmosphere"]
  ]);
  if (environment) sections.push(`环境：${environment}`);

  const camera = compileNamedFields(frame.camera, [
    ["景别", "shotSize"],
    ["机位高度", "height"],
    ["角度", "angle"],
    ["观察方向", "viewDirection"],
    ["镜头质感", "lensFeel"],
    ["景深", "depthOfField"],
    ["构图", "composition"]
  ]);
  if (camera) sections.push(`镜头：${camera}`);

  const lighting = compileNamedFields(frame.lighting, [
    ["光源", "source"],
    ["方向", "direction"],
    ["色彩与反差", "colorAndContrast"]
  ]);
  if (lighting) sections.push(`光线：${lighting}`);

  addListSection(sections, "风格修饰", frame.styleModifiers);
  addListSection(sections, "连续性锁定", frame.continuityLocks);
  return sentenceList(sections);
}

function compileCharacter(character) {
  if (!isRecord(character)) return "";
  const name = cleanText(character.name);
  const details = compileNamedFields(character, [
    ["画面位置", "screenPosition"],
    ["身体朝向", "bodyOrientation"],
    ["姿态", "pose"],
    ["动作状态", "actionState"],
    ["手部与道具状态", "handPropState"],
    ["视线", "gaze"],
    ["情绪状态", "emotionState"],
    ["表情", "expression"]
  ]);
  if (!name) return details;
  return details ? `${name}（${details}）` : name;
}

function compileVideoPrompt(motion) {
  const sections = ["首帧是准确起点，尾帧是最终视觉目标，只生成两帧之间的连续变化"];
  addSection(sections, "主动作", motion.primaryAction);

  const cameraMove = compileCameraMove(motion.cameraMove);
  if (cameraMove) sections.push(`镜头运动：${cameraMove}`);

  const emotionArc = compileNamedFields(motion.emotionArc, [
    ["起始", "from"],
    ["可见变化", "visibleProgression"],
    ["终点", "to"]
  ]);
  if (emotionArc) sections.push(`情绪弧线：${emotionArc}`);

  addSection(sections, "环境变化", motion.environmentChange);
  addSection(sections, "光线变化", motion.lightingChange);

  const timingBeats = compileTimingBeats(motion.timingBeats);
  if (timingBeats) sections.push(`时间节拍：${timingBeats}`);

  const dialogue = compileDialogue(motion.audio?.dialogue);
  if (dialogue) sections.push(`对白：${dialogue}`);
  const sound = compileAudioWithoutDialogue(motion.audio);
  if (sound) sections.push(`声音：${sound}`);

  addListSection(sections, "运动过程保持", motion.preserve);
  addSection(sections, "停止条件", motion.stopCondition);
  return sentenceList(sections);
}

function compileCameraMove(cameraMove) {
  if (!isRecord(cameraMove)) return "";
  return [
    namedValue("模式", enumText(cameraMove.mode, { locked: "固定机位", continuous: "连续运镜" })),
    namedValue("技法", cameraMove.technique),
    namedValue("路径", cameraMove.path),
    namedValue("速度", enumText(cameraMove.speed, { slow: "慢速", medium: "中速", fast: "快速" })),
    namedValue("动机", cameraMove.motivation)
  ].filter(Boolean).join("；");
}

function compileDialogue(dialogue) {
  return (Array.isArray(dialogue) ? dialogue : [])
    .map((line) => {
      if (!isRecord(line)) return "";
      const speaker = cleanText(line.speaker);
      const text = cleanText(line.text);
      const delivery = cleanText(line.delivery);
      if (!speaker && !text && !delivery) return "";
      const spoken = speaker && text ? `${speaker}：“${text}”` : speaker || text;
      return delivery ? `${spoken}（${delivery}）` : spoken;
    })
    .filter(Boolean)
    .join("；");
}

function compileSoundDesign(motion) {
  const sections = [];
  const audio = compileAudioWithoutDialogue(motion.audio);
  if (audio) sections.push(audio);
  const timedCues = (Array.isArray(motion.timingBeats) ? motion.timingBeats : [])
    .map((beat) => {
      const cue = cleanText(beat?.soundCue);
      if (!cue) return "";
      const range = compilePercentRange(beat?.fromPercent, beat?.toPercent);
      return range ? `${range}：${cue}` : cue;
    })
    .filter(Boolean);
  if (timedCues.length) sections.push(`分段声音：${timedCues.join("；")}`);
  return sections.join("；");
}

function compileAudioWithoutDialogue(audio) {
  if (!isRecord(audio)) return "";
  const sections = [];
  addSection(sections, "环境声", audio.ambience);
  const effects = cleanList(audio.soundEffects);
  if (effects.length) sections.push(`音效：${effects.join("、")}`);
  addSection(sections, "音乐提示", audio.musicCue);
  return sections.join("；");
}

function compileTimingBeats(timingBeats) {
  return (Array.isArray(timingBeats) ? timingBeats : [])
    .map((beat) => {
      if (!isRecord(beat)) return "";
      const range = compilePercentRange(beat.fromPercent, beat.toPercent);
      const details = compileNamedFields(beat, [
        ["动作", "action"],
        ["镜头", "camera"],
        ["情绪", "emotion"],
        ["环境", "environment"],
        ["声音", "soundCue"]
      ]);
      if (range && details) return `${range}（${details}）`;
      return range || details;
    })
    .filter(Boolean)
    .join("；");
}

function compileContinuityNotes(startFrame, endFrame, motion) {
  const sections = [];
  addCleanListSection(sections, "首帧锁定", startFrame.continuityLocks);
  addCleanListSection(sections, "尾帧锁定", endFrame.continuityLocks);
  addCleanListSection(sections, "运动过程保持", motion.preserve);
  const endStateRef = cleanText(motion.endStateRef);
  if (endStateRef === "endFrame") sections.push("尾帧目标：严格达到结构化尾帧状态");
  else addSection(sections, "尾帧目标", endStateRef);
  addSection(sections, "停止条件", motion.stopCondition);
  return sentenceList(sections);
}

function compileNamedFields(value, fields) {
  if (!isRecord(value)) return "";
  return fields
    .map(([label, key]) => namedValue(label, value[key]))
    .filter(Boolean)
    .join("；");
}

function namedValue(label, value) {
  const text = cleanText(value);
  return text ? `${label}：${text}` : "";
}

function enumText(value, translations) {
  const text = cleanText(value);
  return translations[text] || text;
}

function compilePercentRange(fromPercent, toPercent) {
  const from = percentText(fromPercent);
  const to = percentText(toPercent);
  if (from && to) return `${from}–${to}`;
  return from || to;
}

function percentText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}%`;
  const text = cleanText(value);
  if (!text) return "";
  return text.endsWith("%") ? text : `${text}%`;
}

function addSection(sections, label, value) {
  const text = cleanText(value);
  if (text) sections.push(`${label}：${text}`);
}

function addListSection(sections, label, value) {
  addCleanListSection(sections, label, value);
}

function addCleanListSection(sections, label, value) {
  const list = cleanList(value);
  if (list.length) sections.push(`${label}：${list.join("、")}`);
}

function cleanList(value) {
  return (Array.isArray(value) ? value : []).map(cleanText).filter(Boolean);
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ");
}

function sentenceList(sections) {
  return sections.length ? `${sections.join("。")}。` : "";
}

function promptSchemaVersionOf(versionOrPlan) {
  if (typeof versionOrPlan === "string") return versionOrPlan.trim();
  if (isRecord(versionOrPlan)) return cleanText(versionOrPlan.promptSchemaVersion);
  return "";
}

function assertRecord(value, path) {
  if (isRecord(value)) return;
  throw new AnimationPromptCompilerError(`${path} 必须是对象`, { path });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
