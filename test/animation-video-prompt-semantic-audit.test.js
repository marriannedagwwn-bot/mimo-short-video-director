import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
  animationVideoPromptSemanticAuditCatalogPayload,
  assertValidatedAnimationVideoPromptSemanticAudit,
  createAnimationVideoPromptSemanticAuditCatalog,
  deriveAnimationVideoPromptSemanticAuditOverall,
  validateAnimationVideoPromptSemanticAuditResponse
} from "../src/animation-video-prompt-semantic-audit.js";
import { OutputContractError } from "../src/validation.js";

function catalogInput() {
  return {
    shots: [
      {
        shotId: "A01",
        authorityFacts: [
          {
            authorityFactId: "A01.story.visibleAction",
            tier: "full_story",
            field: "scene.visibleAction",
            value: "小白子靠近女孩，温柔地摸了摸她的头。"
          },
          {
            authorityFactId: "A01.foundation.character",
            tier: "foundation",
            field: "characterReferencePrompts",
            value: "小白子是一只戴手编草帽的拟人化白狼。"
          },
          {
            authorityFactId: "A01.shot.cameraMotion",
            tier: "exact_shot",
            field: "cameraMotion",
            value: "中景跟随，结尾切至摸头动作特写。"
          },
          {
            authorityFactId: "A01.story.dialogue",
            tier: "full_story",
            field: "scene.dialogue",
            value: "爷爷：做得好。"
          }
        ],
        candidateFields: [
          {
            candidateFieldId: "A01.candidate.characterAction",
            layer: "shot_facts",
            field: "characterAction",
            value: "小白子走近女孩，轻轻摸她的头。"
          },
          {
            candidateFieldId: "A01.candidate.cameraMotion",
            layer: "shot_facts",
            field: "cameraMotion",
            value: "中景跟随，最后切至互动特写。"
          },
          {
            candidateFieldId: "A01.candidate.dialogueOrSubtitle",
            layer: "shot_facts",
            field: "dialogueOrSubtitle",
            value: ""
          },
          {
            candidateFieldId: "A01.candidate.videoPrompt",
            layer: "video_prompt",
            field: "videoPrompt",
            value: "[Shot 1] The white wolf approaches the girl and gently pats her head."
          }
        ]
      },
      {
        shotId: "A06",
        authorityFacts: [
          {
            authorityFactId: "A06.story.characters",
            tier: "full_story",
            field: "scene.characters",
            value: ["小白子"]
          },
          {
            authorityFactId: "A06.story.visibleAction",
            tier: "full_story",
            field: "scene.visibleAction",
            value: "小白子独自站在雨后的麦田里，望向放晴的天空。"
          },
          {
            authorityFactId: "A06.shot.characterAction",
            tier: "exact_shot",
            field: "characterAction",
            value: "小白子独自站立并望向天空。"
          },
          {
            authorityFactId: "A06.adjacent.previousShot",
            tier: "adjacent_shot",
            field: "adjacent.previousShot",
            value: "A05 结尾草帽仍盖在小白子脸上。"
          }
        ],
        candidateFields: [
          {
            candidateFieldId: "A06.candidate.characterAction",
            layer: "shot_facts",
            field: "characterAction",
            value: "小白子站在麦田里，三位村民仍举着芭蕉叶站在她身后。"
          },
          {
            candidateFieldId: "A06.candidate.continuityNotes",
            layer: "shot_facts",
            field: "continuityNotes",
            value: "雨停后承接上一镜。"
          },
          {
            candidateFieldId: "A06.candidate.videoPrompt",
            layer: "video_prompt",
            field: "videoPrompt",
            value: "[Shot 1] The white wolf looks at the clearing sky while the three villagers remain behind her."
          }
        ]
      }
    ]
  };
}

function passShot(shotId) {
  return {
    shotId,
    shotFactsVerdict: "pass",
    videoPromptVerdict: "pass",
    issues: []
  };
}

function passResponse() {
  return {
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
    shots: [passShot("A01"), passShot("A06")]
  };
}

function issue(overrides = {}) {
  return {
    layer: "shot_facts",
    field: "characterAction",
    category: "cast",
    relation: "extra_visible_cast_added",
    authorityFactId: "A06.story.characters",
    candidateFieldId: "A06.candidate.characterAction",
    authorityExcerpt: "小白子",
    candidateExcerpt: "三位村民",
    productionImpact: "会让本场增加 Full Story 未签发的实际出镜角色。",
    ...overrides
  };
}

function a06ExtraCastResponse() {
  return {
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
    shots: [
      passShot("A01"),
      {
        shotId: "A06",
        shotFactsVerdict: "fail",
        videoPromptVerdict: "not_evaluated",
        issues: [
          issue()
        ]
      }
    ]
  };
}

function candidateForCatalog(input) {
  return {
    shotPlan: input.shots.map((shot) => ({
      shotId: shot.shotId,
      ...Object.fromEntries(shot.candidateFields.map((field) => [
        field.field,
        structuredClone(field.value)
      ]))
    }))
  };
}

function issuedCatalog(input = catalogInput(), candidate = candidateForCatalog(input)) {
  return createAnimationVideoPromptSemanticAuditCatalog(input, { candidate });
}

test("catalog 由服务端签发并冻结，Prompt payload 是不可反向修改 catalog 的 clone", () => {
  const input = catalogInput();
  const catalog = issuedCatalog(input);
  const payload = animationVideoPromptSemanticAuditCatalogPayload(catalog);

  assert.equal(catalog.schemaVersion, ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.shots));
  assert.ok(Object.isFrozen(catalog.shots[0].authorityFacts[0]));
  assert.ok(Object.isFrozen(payload));
  assert.notEqual(payload, catalog);
  assert.deepEqual(payload, catalog);
  assert.throws(() => {
    payload.shots[0].authorityFacts[0].value = "伪造权威";
  }, TypeError);
  assert.equal(catalog.shots[0].authorityFacts[0].value, input.shots[0].authorityFacts[0].value);

  const forgedCatalog = structuredClone(catalog);
  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(passResponse(), forgedCatalog),
    OutputContractError
  );
});

test("合法同义表达和英文转译不会因字面不同被协议误杀", () => {
  const input = catalogInput();
  const candidate = candidateForCatalog(input);
  const catalog = issuedCatalog(input, candidate);
  // Full Story says “温柔地摸了摸她的头”; candidate says “gently pats her
  // head”. The evidence protocol deliberately does not implement a local
  // translation/keyword equality rule. A semantic pass remains a valid pass.
  const audit = validateAnimationVideoPromptSemanticAuditResponse(passResponse(), catalog);
  const overall = deriveAnimationVideoPromptSemanticAuditOverall(audit);

  assert.ok(Object.isFrozen(audit));
  assert.deepEqual(overall, {
    verdict: "pass",
    failedShotIds: [],
    shotFactsFailedShotIds: [],
    videoPromptFailedShotIds: [],
    repairableVideoPromptShotIds: []
  });
  assert.throws(
    () => deriveAnimationVideoPromptSemanticAuditOverall(passResponse()),
    OutputContractError
  );
  assert.equal(assertValidatedAnimationVideoPromptSemanticAudit(audit), audit);
  assert.equal(
    assertValidatedAnimationVideoPromptSemanticAudit(audit, { catalog, candidate }),
    audit
  );
  assert.throws(
    () => assertValidatedAnimationVideoPromptSemanticAudit(structuredClone(audit)),
    OutputContractError
  );
  const sameShotIdsDifferentCandidate = structuredClone(candidate);
  sameShotIdsDifferentCandidate.shotPlan[0].videoPrompt = "different candidate sentinel";
  assert.throws(
    () => assertValidatedAnimationVideoPromptSemanticAudit(audit, {
      candidate: sameShotIdsDifferentCandidate
    }),
    /candidate digest/u
  );
});

test("A06 额外村民必须用同镜高层权威与逐字 candidate evidence 报告", () => {
  const catalog = issuedCatalog();
  const audit = validateAnimationVideoPromptSemanticAuditResponse(
    a06ExtraCastResponse(),
    catalog
  );
  const overall = deriveAnimationVideoPromptSemanticAuditOverall(audit);

  assert.equal(audit.shots[1].issues[0].authorityFactId, "A06.story.characters");
  assert.equal(audit.shots[1].issues[0].candidateExcerpt, "三位村民");
  assert.deepEqual(overall, {
    verdict: "fail",
    failedShotIds: ["A06"],
    shotFactsFailedShotIds: ["A06"],
    videoPromptFailedShotIds: [],
    repairableVideoPromptShotIds: []
  });
});

test("只有 shot facts 通过且 videoPrompt 失败的镜头才派生为可局修", () => {
  const catalog = issuedCatalog();
  const response = a06ExtraCastResponse();
  response.shots[1].shotFactsVerdict = "pass";
  response.shots[1].videoPromptVerdict = "fail";
  response.shots[1].issues = [issue({
    layer: "video_prompt",
    field: "videoPrompt",
    candidateFieldId: "A06.candidate.videoPrompt",
    candidateExcerpt: "the three villagers",
    productionImpact: "最终视频提示词会继续要求生成未签发的三位村民。"
  })];
  const audit = validateAnimationVideoPromptSemanticAuditResponse(response, catalog);

  assert.deepEqual(
    deriveAnimationVideoPromptSemanticAuditOverall(audit).repairableVideoPromptShotIds,
    ["A06"]
  );
});

test("响应必须按 catalog 顺序逐镜恰好返回一次", async (t) => {
  const catalog = issuedCatalog();
  const cases = [
    ["缺少镜头", () => {
      const value = passResponse();
      value.shots.pop();
      return value;
    }],
    ["增加镜头", () => {
      const value = passResponse();
      value.shots.push(passShot("A07"));
      return value;
    }],
    ["重排镜头", () => {
      const value = passResponse();
      value.shots.reverse();
      return value;
    }],
    ["重复镜头", () => {
      const value = passResponse();
      value.shots[1].shotId = "A01";
      return value;
    }]
  ];
  for (const [name, makeValue] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateAnimationVideoPromptSemanticAuditResponse(makeValue(), catalog),
        OutputContractError
      );
    });
  }
});

test("verdict 必须与同 layer issues 严格一致", async (t) => {
  const catalog = issuedCatalog();
  const failWithoutIssue = passResponse();
  failWithoutIssue.shots[1].videoPromptVerdict = "fail";
  const passWithIssue = a06ExtraCastResponse();
  passWithIssue.shots[1].shotFactsVerdict = "pass";
  passWithIssue.shots[1].videoPromptVerdict = "pass";

  await t.test("fail 至少有一条同 layer issue", () => {
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(failWithoutIssue, catalog),
      OutputContractError
    );
  });
  await t.test("pass 不得带同 layer issue", () => {
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(passWithIssue, catalog),
      OutputContractError
    );
  });
});

test("shot facts 失败时必须停止低层 videoPrompt 审计", async (t) => {
  const catalog = issuedCatalog();

  await t.test("shot facts fail 强制 videoPrompt not_evaluated", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].videoPromptVerdict = "fail";
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
  await t.test("not_evaluated 不得同时携带 video_prompt issue", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].issues.push(issue({
      layer: "video_prompt",
      field: "videoPrompt",
      candidateFieldId: "A06.candidate.videoPrompt",
      candidateExcerpt: "the three villagers"
    }));
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
  await t.test("shot facts pass 时不得跳过 videoPrompt", () => {
    const response = passResponse();
    response.shots[1].videoPromptVerdict = "not_evaluated";
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
});

test("issue 的 layer、field、category、relation 和额外字段均为严格 allowlist", async (t) => {
  const catalog = issuedCatalog();
  const mutations = [
    ["layer", (target) => { target.layer = "animation_plan"; }],
    ["field", (target) => { target.field = "storyPurposeTypo"; }],
    ["category", (target) => { target.category = "wording_quality"; }],
    ["relation", (target) => { target.relation = "meaning_weakened"; }],
    ["extra", (target) => { target.reason = "模型自由文本"; }]
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const response = a06ExtraCastResponse();
      mutate(response.shots[1].issues[0]);
      assert.throws(
        () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
        OutputContractError
      );
    });
  }
});

test("issue id 必须属于同镜，且 candidate 签发 layer/field 必须匹配", async (t) => {
  const catalog = issuedCatalog();
  const cases = [
    ["跨镜 authority", (target) => {
      target.authorityFactId = "A01.story.visibleAction";
      target.authorityExcerpt = "摸了摸";
    }],
    ["跨镜 candidate", (target) => {
      target.candidateFieldId = "A01.candidate.characterAction";
      target.candidateExcerpt = "摸她的头";
    }],
    ["candidate layer 不匹配", (target) => {
      target.layer = "video_prompt";
      target.field = "videoPrompt";
    }],
    ["candidate field 不匹配", (target) => {
      target.field = "continuityNotes";
    }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const response = a06ExtraCastResponse();
      mutate(response.shots[1].issues[0]);
      assert.throws(
        () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
        OutputContractError
      );
    });
  }
});

test("authority tier 必须严格高于被审 candidate layer", () => {
  const input = catalogInput();
  input.shots[1].authorityFacts.push({
    authorityFactId: "A06.shot.peerAction",
    tier: "exact_shot",
    field: "characterAction",
    value: "三位村民不得出镜。"
  });
  const catalog = issuedCatalog(input);
  const response = a06ExtraCastResponse();
  response.shots[1].issues[0].authorityFactId = "A06.shot.peerAction";
  response.shots[1].issues[0].authorityExcerpt = "三位村民不得出镜";

  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
    OutputContractError
  );
});

test("relation 必须绑定能决定该事实的 authority 字段和匹配 category", () => {
  const catalog = issuedCatalog();
  const wrongAuthority = a06ExtraCastResponse();
  wrongAuthority.shots[1].issues[0] = issue({
    authorityFactId: "A01.foundation.character",
    candidateFieldId: "A01.candidate.videoPrompt",
    layer: "video_prompt",
    field: "videoPrompt",
    authorityExcerpt: "小白子",
    candidateExcerpt: "white wolf"
  });
  wrongAuthority.shots = [
    {
      shotId: "A01",
      shotFactsVerdict: "pass",
      videoPromptVerdict: "fail",
      issues: wrongAuthority.shots[1].issues
    },
    passShot("A06")
  ];
  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(wrongAuthority, catalog),
    /不能作为 extra_visible_cast_added 的事实来源/u
  );

  const wrongCategory = a06ExtraCastResponse();
  wrongCategory.shots[1].issues[0].category = "prop";
  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(wrongCategory, catalog),
    /category 与 relation/u
  );
});

test("character_appearance 只能引用外观权威，scene.characters 只能支持身份或 cast", () => {
  const catalog = issuedCatalog();
  const forgedAppearance = passResponse();
  forgedAppearance.shots[1] = {
    shotId: "A06",
    shotFactsVerdict: "pass",
    videoPromptVerdict: "fail",
    issues: [issue({
      layer: "video_prompt",
      field: "videoPrompt",
      category: "character_appearance",
      relation: "locked_identity_or_trait_changed",
      authorityFactId: "A06.story.characters",
      candidateFieldId: "A06.candidate.videoPrompt",
      authorityExcerpt: "小白子",
      candidateExcerpt: "white wolf"
    })]
  };
  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(forgedAppearance, catalog),
    /不能作为 locked_identity_or_trait_changed 的事实来源/u
  );

  const appearanceAuthority = passResponse();
  appearanceAuthority.shots[0] = {
    shotId: "A01",
    shotFactsVerdict: "pass",
    videoPromptVerdict: "fail",
    issues: [issue({
      layer: "video_prompt",
      field: "videoPrompt",
      category: "character_appearance",
      relation: "locked_identity_or_trait_changed",
      authorityFactId: "A01.foundation.character",
      candidateFieldId: "A01.candidate.videoPrompt",
      authorityExcerpt: "白狼",
      candidateExcerpt: "white wolf"
    })]
  };
  assert.doesNotThrow(
    () => validateAnimationVideoPromptSemanticAuditResponse(appearanceAuthority, catalog)
  );
});

test("相邻镜头只读证据只允许报告 continuity，不得授权角色或动作事实", () => {
  const catalog = issuedCatalog();
  const continuity = passResponse();
  continuity.shots[1] = {
    shotId: "A06",
    shotFactsVerdict: "fail",
    videoPromptVerdict: "not_evaluated",
    issues: [issue({
      field: "continuityNotes",
      category: "continuity",
      relation: "continuity_state_impossible",
      authorityFactId: "A06.adjacent.previousShot",
      candidateFieldId: "A06.candidate.continuityNotes",
      authorityExcerpt: "草帽仍盖在小白子脸上",
      candidateExcerpt: "雨停后承接上一镜"
    })]
  };
  assert.doesNotThrow(
    () => validateAnimationVideoPromptSemanticAuditResponse(continuity, catalog)
  );

  const cast = structuredClone(continuity);
  cast.shots[1].issues[0] = issue({
    authorityFactId: "A06.adjacent.previousShot",
    candidateFieldId: "A06.candidate.characterAction",
    authorityExcerpt: "小白子",
    candidateExcerpt: "三位村民"
  });
  assert.throws(
    () => validateAnimationVideoPromptSemanticAuditResponse(cast, catalog),
    /不能作为 extra_visible_cast_added 的事实来源/u
  );
});

test("两侧 excerpt 都必须逐字存在；只有缺失类 relation 可省略 candidateExcerpt", async (t) => {
  const catalog = issuedCatalog();

  await t.test("伪造 authority excerpt", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].issues[0].authorityExcerpt = "村长";
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
  await t.test("伪造 candidate excerpt", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].issues[0].candidateExcerpt = "四位村民";
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
  await t.test("缺失类允许 null candidate excerpt", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].shotFactsVerdict = "pass";
    response.shots[1].videoPromptVerdict = "fail";
    response.shots[1].issues = [{
      ...issue({
        layer: "video_prompt",
        field: "videoPrompt",
        category: "action",
        relation: "required_story_action_missing",
        authorityFactId: "A06.story.visibleAction",
        candidateFieldId: "A06.candidate.videoPrompt",
        authorityExcerpt: "望向放晴的天空",
        candidateExcerpt: null,
        productionImpact: "成片会漏掉本场要求的望向天空动作。"
      })
    }];
    assert.doesNotThrow(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog)
    );
  });
  await t.test("新增类不允许 null candidate excerpt", () => {
    const response = a06ExtraCastResponse();
    response.shots[1].issues[0].relation = "extra_story_action_added";
    response.shots[1].issues[0].candidateExcerpt = null;
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      OutputContractError
    );
  });
  await t.test("required_dialogue_missing 明确允许 null", () => {
    const response = passResponse();
    response.shots[0] = {
      shotId: "A01",
      shotFactsVerdict: "pass",
      videoPromptVerdict: "fail",
      issues: [issue({
        layer: "video_prompt",
        field: "videoPrompt",
        category: "dialogue",
        relation: "required_dialogue_missing",
        authorityFactId: "A01.story.dialogue",
        candidateFieldId: "A01.candidate.videoPrompt",
        authorityExcerpt: "做得好",
        candidateExcerpt: null
      })]
    };
    assert.doesNotThrow(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog)
    );
  });
  await t.test("dialogue changed 不得用 null 冒充 missing", () => {
    const response = passResponse();
    response.shots[0] = {
      shotId: "A01",
      shotFactsVerdict: "pass",
      videoPromptVerdict: "fail",
      issues: [issue({
        layer: "video_prompt",
        field: "videoPrompt",
        category: "dialogue",
        relation: "dialogue_speaker_or_text_changed",
        authorityFactId: "A01.story.dialogue",
        candidateFieldId: "A01.candidate.videoPrompt",
        authorityExcerpt: "做得好",
        candidateExcerpt: null
      })]
    };
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, catalog),
      /明确缺失 relation/u
    );
  });
  await t.test("cast missing 可为 null，但 extra cast 必须提供新增角色证据", () => {
    const missing = passResponse();
    missing.shots[1] = {
      shotId: "A06",
      shotFactsVerdict: "pass",
      videoPromptVerdict: "fail",
      issues: [issue({
        layer: "video_prompt",
        field: "videoPrompt",
        category: "cast",
        relation: "required_visible_cast_missing",
        authorityFactId: "A06.story.characters",
        candidateFieldId: "A06.candidate.videoPrompt",
        authorityExcerpt: "小白子",
        candidateExcerpt: null
      })]
    };
    assert.doesNotThrow(
      () => validateAnimationVideoPromptSemanticAuditResponse(missing, catalog)
    );

    missing.shots[1].issues[0].relation = "extra_visible_cast_added";
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(missing, catalog),
      /明确缺失 relation/u
    );
  });
});

test("catalog 拒绝重复 ids、非法字段和非普通 JSON，且不会读取 accessor", async (t) => {
  await t.test("重复 authorityFactId", () => {
    const input = catalogInput();
    input.shots[1].authorityFacts[0].authorityFactId = "A01.story.visibleAction";
    assert.throws(() => issuedCatalog(input), OutputContractError);
  });
  await t.test("重复 candidateFieldId", () => {
    const input = catalogInput();
    input.shots[1].candidateFields[0].candidateFieldId = "A01.candidate.characterAction";
    assert.throws(() => issuedCatalog(input), OutputContractError);
  });
  await t.test("缺少 videoPrompt candidate", () => {
    const input = catalogInput();
    input.shots[0].candidateFields.pop();
    assert.throws(() => issuedCatalog(input), OutputContractError);
  });
  await t.test("非法 shot field", () => {
    const input = catalogInput();
    input.shots[0].candidateFields[0].field = "startFrame";
    assert.throws(() => issuedCatalog(input), OutputContractError);
  });
  await t.test("catalog candidateFields 必须来自私有绑定 candidate", () => {
    const input = catalogInput();
    const candidate = candidateForCatalog(input);
    candidate.shotPlan[0].videoPrompt = "different candidate sentinel";
    assert.throws(
      () => issuedCatalog(input, candidate),
      /与绑定 candidate 不一致/u
    );
  });
  await t.test("accessor 不会被读取", () => {
    let getterCalls = 0;
    const response = passResponse();
    Object.defineProperty(response, "shots", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      }
    });
    assert.throws(
      () => validateAnimationVideoPromptSemanticAuditResponse(response, issuedCatalog()),
      OutputContractError
    );
    assert.equal(getterCalls, 0);
  });
});
