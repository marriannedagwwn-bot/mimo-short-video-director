import { mockFullStory } from "../../src/mock.js";

export const characterizationContext = Object.freeze({
  creatorProfile: Object.freeze({
    fixedCharacter: "阿岚，社区修理师",
    vertical: "社区维修",
    constraints: "60 秒内"
  }),
  variant: Object.freeze({
    id: "V1",
    title: "最后一格电",
    characterSetup: Object.freeze({
      protagonist: "阿岚，社区修理师",
      careRecipient: "铃木奶奶",
      helper: "夜班便利店员"
    }),
    newTask: "修好旧收音机",
    emotionalMedium: "一台旧收音机",
    environmentPressure: "暴雨停电",
    endingRitual: "铃木奶奶按下播放键"
  })
});

export const fullStoryDefectCases = Object.freeze([
  {
    id: "FS-01",
    expectation: "current-rejects-non-live-name-mention",
    description: "招牌中的标准角色名字面提及当前会被当作真人出镜要求"
  },
  {
    id: "FS-03",
    expectation: "current-accepts-unknown-visible-character",
    description: "未进入 candidate characterBible 的可见临时角色当前不会被识别"
  },
  {
    id: "FS-04",
    expectation: "current-accepts-care-recipient-drift",
    description: "被关爱对象由 candidate 自证，改名后仍可保持内部自洽"
  },
  {
    id: "FS-08",
    expectation: "phase-1-rejects-deeply-incomplete-story",
    description: "Phase 1 内部 strict schema 递归拒绝 title=null 和无效 beatSheet 项"
  }
]);

export const recoveryDefectCases = Object.freeze([
  {
    id: "RC-01",
    expectation: "phase-1-handles-finish-reason-length-before-parse"
  },
  {
    id: "RC-02",
    expectation: "phase-1-preserves-think-tags-inside-json-string"
  },
  {
    id: "RC-03",
    expectation: "phase-1-rejects-json-object-surrounded-by-text"
  },
  {
    id: "RC-04",
    expectation: "phase-1-coordinator-retries-invalid-envelope-once"
  },
  {
    id: "RC-05",
    expectation: "phase-1-coordinator-retries-transient-http-once"
  }
]);

export const downstreamDefectCases = Object.freeze([
  {
    id: "DS-05",
    expectation: "profile-validator-remains-id-scoped-server-binding-owns-candidate-digest",
    description: "ensureFullStoryMatchesProfile 只守输出字段；Full Story 入口的完整 Candidate 由服务端 revision/digest binding 另行锁定"
  }
]);

export function validFullStoryFixture() {
  return mockFullStory(characterizationContext);
}

export function fs01NonLiveNameMentionFixture() {
  const story = validFullStoryFixture();
  Object.assign(story.sceneScript[0], {
    characters: ["铃木奶奶"],
    visibleAction: "镜头掠过阿岚维修铺的招牌，铃木奶奶站在门边。",
    dialogue: [],
    shotAndSound: "固定远景记录店外环境。"
  });
  return story;
}

export function fs03UnknownVisibleCharacterFixture() {
  const story = validFullStoryFixture();
  Object.assign(story.sceneScript[0], {
    characters: ["阿岚"],
    visibleAction: "快递员把包裹递给阿岚后离开。",
    dialogue: [],
    shotAndSound: "中景完整拍到快递员递出包裹。"
  });
  return story;
}

export function fs04CareRecipientDriftFixture() {
  const story = validFullStoryFixture();
  story.characterBible.careRecipient.nameOrLabel = "王奶奶";
  story.sceneScript.forEach((scene) => {
    scene.characters = scene.characters.map((name) => name === "铃木奶奶" ? "王奶奶" : name);
    scene.visibleAction = scene.visibleAction.replaceAll("铃木奶奶", "王奶奶");
    scene.dialogue = scene.dialogue.map((line) => ({
      ...line,
      speaker: line.speaker === "铃木奶奶" ? "王奶奶" : line.speaker,
      line: line.line.replaceAll("铃木奶奶", "王奶奶")
    }));
    scene.shotAndSound = scene.shotAndSound.replaceAll("铃木奶奶", "王奶奶");
  });
  return story;
}

export function fs08DeeplyIncompleteFixture() {
  const story = validFullStoryFixture();
  story.title = null;
  story.beatSheet = Array.from({ length: 6 }, () => null);
  return story;
}
