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
    expectation: "current-accepts-deeply-incomplete-story",
    description: "顶层键存在时，title 和 beatSheet 深层内容没有递归校验"
  }
]);

export const recoveryDefectCases = Object.freeze([
  {
    id: "RC-01",
    expectation: "current-ignores-finish-reason-length"
  },
  {
    id: "RC-02",
    expectation: "current-removes-think-tags-inside-json-string"
  },
  {
    id: "RC-03",
    expectation: "current-extracts-json-object-from-surrounding-text"
  },
  {
    id: "RC-04",
    expectation: "current-does-not-retry-invalid-envelope"
  },
  {
    id: "RC-05",
    expectation: "current-does-not-retry-transient-http"
  }
]);

export const downstreamDefectCases = Object.freeze([
  {
    id: "DS-05",
    expectation: "current-accepts-same-id-changed-variant-context",
    description: "Full Story 没有绑定完整 variant/profile/brief/guardrails digest"
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
