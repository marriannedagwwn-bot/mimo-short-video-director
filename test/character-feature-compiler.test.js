import test from "node:test";
import assert from "node:assert/strict";
import { ModelResponseError } from "../src/mimo-client.js";
import {
  CHARACTER_FEATURE_KINDS,
  CharacterFeatureCompilerProtocolError,
  CharacterFeatureCompilerTransportError,
  buildCharacterFeatureCompilerPrompt,
  buildCharacterFeatureSourceCatalog,
  characterFeatureDimensionKey,
  clearCharacterFeatureCompilerCache,
  compileCharacterFeatures,
  computeCharacterFeatureSourceHash,
  matchCharacterFeatures
} from "../src/character-feature-compiler.js";

function compilerInput(overrides = {}) {
  return {
    creatorProfile: {
      fixedCharacter: "小白子，Q版狼娘，长着一对狼耳",
      characterReferencePrompts: ["REFERENCE_PROMPT_MUST_NOT_ENTER"]
    },
    visualGuardrails: {
      fixedCharacterBoundary: {
        rule: "小白子的狼耳与物种身份保持一致"
      },
      characterReferencePrompts: ["NESTED_REFERENCE_MUST_NOT_ENTER"]
    },
    fullStory: {
      characterBible: {
        protagonist: {
          name: "小白子",
          identity: "小白子是Q版狼娘，长着一对狼耳",
          traits: ["可靠"]
        }
      },
      characterReferencePrompts: ["FOUNDATION_OUTPUT_MUST_NOT_ENTER"]
    },
    client: null,
    provider: "Qwen",
    model: "qwen-character-feature",
    maxCompletionTokens: 4096,
    timeoutMs: 300_000,
    ...overrides
  };
}

function signedPayload(prompt) {
  const marker = "服务端签发输入：\n";
  const start = prompt.indexOf(marker);
  assert.notEqual(start, -1);
  const tail = prompt.slice(start + marker.length);
  const retryMarker = "\n\nCHARACTER_FEATURE_COMPILER_PROTOCOL_RETRY_V1";
  const end = tail.indexOf(retryMarker);
  return JSON.parse(end >= 0 ? tail.slice(0, end) : tail);
}

function spanContaining(payload, text, characterTargetId = null) {
  for (const segment of payload.sourceCatalog) {
    if (characterTargetId && segment.characterTargetId !== characterTargetId) continue;
    for (const span of segment.spans) {
      if (span.displayText.includes(text)) return span.spanId;
    }
  }
  assert.fail(`未找到包含「${text}」的签发 span`);
}

function validResponseFromPrompt(prompt, { features = null } = {}) {
  const payload = signedPayload(prompt);
  return {
    characters: payload.characterTargets.map((character) => ({
      characterTargetId: character.characterTargetId,
      features: typeof features === "function"
        ? features(payload, character)
        : []
    }))
  };
}

test("权威输入不读取 Foundation 或 characterReferencePrompts，证据协议只暴露签发 ID", () => {
  const input = compilerInput();
  const catalog = buildCharacterFeatureSourceCatalog(input);
  const authoritativeHash = computeCharacterFeatureSourceHash(input);
  const changedIgnoredFieldsHash = computeCharacterFeatureSourceHash({
    ...input,
    animationFoundation: { forbidden: "FOUNDATION_HASH_MUST_NOT_CHANGE" },
    characterReferencePrompts: ["REFERENCE_HASH_MUST_NOT_CHANGE"],
    creatorProfile: {
      ...input.creatorProfile,
      characterReferencePrompts: ["CHANGED_REFERENCE"]
    },
    fullStory: {
      ...input.fullStory,
      characterReferencePrompts: ["CHANGED_FOUNDATION_OUTPUT"]
    }
  });
  const prompt = buildCharacterFeatureCompilerPrompt({
    authoritativeInput: {
      __characterFeatureAuthoritativeInput: true,
      creatorProfile: { fixedCharacter: input.creatorProfile.fixedCharacter },
      visualGuardrails: {
        fixedCharacterBoundary: input.visualGuardrails.fixedCharacterBoundary
      },
      fullStory: { characterBible: input.fullStory.characterBible },
      temporaryCharacters: []
    },
    catalog,
    sourceHash: authoritativeHash
  });

  assert.equal(authoritativeHash, changedIgnoredFieldsHash);
  assert.doesNotMatch(prompt, /REFERENCE_PROMPT_MUST_NOT_ENTER/u);
  assert.doesNotMatch(prompt, /NESTED_REFERENCE_MUST_NOT_ENTER/u);
  assert.doesNotMatch(prompt, /FOUNDATION_OUTPUT_MUST_NOT_ENTER/u);
  assert.doesNotMatch(prompt, /creatorProfile\.fixedCharacter/u);
  assert.doesNotMatch(prompt, /utf16Start|utf16End/u);
  assert.match(prompt, /character-target-[a-f0-9]+-0/u);
  assert.match(prompt, /span-[a-f0-9]+-\d+/u);
  assert.ok(
    [...catalog.spanById.values()].every((span) =>
      Number.isInteger(span.utf16Start)
      && Number.isInteger(span.utf16End)
      && span.rawText.length === span.utf16End - span.utf16Start
    )
  );
});

test("编译 explicit/inferred 特征并生成冻结的角色作用域 featureId", async () => {
  clearCharacterFeatureCompilerCache();
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      return validResponseFromPrompt(request.prompt, {
        features(payload, character) {
          const wolfSpan = spanContaining(payload, "狼娘", character.characterTargetId);
          const earsSpan = spanContaining(payload, "狼耳", character.characterTargetId);
          return [
            {
              suggestedFeatureKey: "wolf_ears",
              canonicalName: "狼耳",
              terms: ["狼耳", "耳朵"],
              featureKind: "special_appendage",
              semanticSubtype: "ear",
              evidenceLevel: "explicit",
              evidenceSpanIds: [earsSpan],
              inferenceSpanIds: []
            },
            {
              suggestedFeatureKey: "wolf_tail",
              canonicalName: "狼尾",
              terms: ["狼尾", "尾巴"],
              featureKind: "special_appendage",
              semanticSubtype: "tail",
              evidenceLevel: "inferred",
              evidenceSpanIds: [],
              inferenceSpanIds: [wolfSpan]
            }
          ];
        }
      });
    }
  };

  const { profile, metadata } = await compileCharacterFeatures(
    compilerInput({ client })
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].jsonRetryAttempts, 0);
  assert.equal(requests[0].strictJson, true);
  assert.equal(profile.characters.length, 1);
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.characters[0].features[0]));
  const [ears, tail] = profile.characters[0].features;
  assert.match(ears.featureId, /^character-[a-f0-9]{12}\.wolf_ears$/u);
  assert.match(tail.featureId, /^character-[a-f0-9]{12}\.wolf_tail$/u);
  assert.equal(ears.poseCompatible, true);
  assert.equal(tail.evidenceLevel, "inferred");
  assert.deepEqual(tail.matcherTerms, ["狼尾", "尾巴"]);
  assert.equal(metadata.counts.explicit, 1);
  assert.equal(metadata.counts.inferred, 1);
  assert.equal(metadata.finalResult, "accepted");
  assert.equal(metadata.stage, "characterFeatureCompiler");
  assert.deepEqual(
    matchCharacterFeatures(profile, {
      characterId: profile.characters[0].characterId,
      text: "尾巴停在身体后侧"
    }),
    [{
      characterId: profile.characters[0].characterId,
      featureId: tail.featureId,
      matchedTerm: "尾巴",
      dimensionKey: `characterFeature:${tail.featureId}`
    }]
  );
  assert.deepEqual(
    matchCharacterFeatures(profile, {
      characterId: "character-other",
      text: "尾巴停在身体后侧"
    }),
    []
  );
  assert.equal(characterFeatureDimensionKey(tail), `characterFeature:${tail.featureId}`);
});

test("空 features Profile 合法、冻结并可命中进程缓存", async () => {
  clearCharacterFeatureCompilerCache();
  let calls = 0;
  const client = {
    async generateJson(request) {
      calls += 1;
      return validResponseFromPrompt(request.prompt);
    }
  };

  const first = await compileCharacterFeatures(compilerInput({ client }));
  const second = await compileCharacterFeatures(compilerInput({
    client: {
      async generateJson() {
        assert.fail("缓存命中时不应调用模型");
      }
    }
  }));

  assert.equal(calls, 1);
  assert.deepEqual(first.profile.characters[0].features, []);
  assert.equal(first.metadata.counts.featureCount, 0);
  assert.equal(second.metadata.cacheHit, true);
  assert.equal(second.metadata.cacheSource, "memory");
  assert.ok(Object.isFrozen(second.profile));
});

test("导入 sidecar 会作为不可信缓存重新校验，合法缓存可复用、篡改 matcher 会失效", async () => {
  clearCharacterFeatureCompilerCache();
  const featureClient = {
    async generateJson(request) {
      return validResponseFromPrompt(request.prompt, {
        features(payload, character) {
          const earsSpan = spanContaining(payload, "狼耳", character.characterTargetId);
          return [{
            suggestedFeatureKey: "wolf_ears",
            canonicalName: "狼耳",
            terms: ["狼耳"],
            featureKind: "special_appendage",
            semanticSubtype: "ear",
            evidenceLevel: "explicit",
            evidenceSpanIds: [earsSpan],
            inferenceSpanIds: []
          }];
        }
      });
    }
  };
  const original = await compileCharacterFeatures(
    compilerInput({ client: featureClient })
  );

  clearCharacterFeatureCompilerCache();
  const cached = await compileCharacterFeatures(compilerInput({
    client: null,
    model: "",
    cachedProfile: structuredClone(original.profile)
  }));
  assert.equal(cached.metadata.cacheHit, true);
  assert.equal(cached.metadata.cacheSource, "provided");
  assert.equal(cached.metadata.requestCount, 0);

  clearCharacterFeatureCompilerCache();
  const tampered = structuredClone(original.profile);
  tampered.characters[0].features[0].terms.push("凭空新增的尾巴");
  tampered.characters[0].features[0].matcherTerms.push("凭空新增的尾巴");
  let calls = 0;
  const regenerated = await compileCharacterFeatures(compilerInput({
    cachedProfile: tampered,
    client: {
      async generateJson(request) {
        calls += 1;
        return validResponseFromPrompt(request.prompt);
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(regenerated.metadata.cacheHit, false);
  assert.equal(regenerated.profile.characters[0].features.length, 0);
});

test("同角色 term 冲突：explicit 覆盖 inferred，同级冲突双方禁用", async () => {
  clearCharacterFeatureCompilerCache();
  const client = {
    async generateJson(request) {
      return validResponseFromPrompt(request.prompt, {
        features(payload, character) {
          const wolfSpan = spanContaining(payload, "狼娘", character.characterTargetId);
          const earsSpan = spanContaining(payload, "狼耳", character.characterTargetId);
          return [
            {
              suggestedFeatureKey: "explicit_ears",
              canonicalName: "狼耳",
              terms: ["狼耳", "耳朵"],
              featureKind: "special_appendage",
              semanticSubtype: "ear",
              evidenceLevel: "explicit",
              evidenceSpanIds: [earsSpan],
              inferenceSpanIds: []
            },
            {
              suggestedFeatureKey: "inferred_ears",
              canonicalName: "推导狼耳",
              terms: ["耳朵"],
              featureKind: "special_appendage",
              semanticSubtype: "ear_variant",
              evidenceLevel: "inferred",
              evidenceSpanIds: [],
              inferenceSpanIds: [wolfSpan]
            },
            {
              suggestedFeatureKey: "wolf_tail",
              canonicalName: "狼尾",
              terms: ["特殊附肢"],
              featureKind: "special_appendage",
              semanticSubtype: "tail",
              evidenceLevel: "inferred",
              evidenceSpanIds: [],
              inferenceSpanIds: [wolfSpan]
            },
            {
              suggestedFeatureKey: "wolf_wing",
              canonicalName: "狼翼",
              terms: ["特殊附肢"],
              featureKind: "special_appendage",
              semanticSubtype: "wing",
              evidenceLevel: "inferred",
              evidenceSpanIds: [],
              inferenceSpanIds: [wolfSpan]
            }
          ];
        }
      });
    }
  };

  const { profile, metadata } = await compileCharacterFeatures(
    compilerInput({ client })
  );
  const byKey = new Map(
    profile.characters[0].features.map((feature) => [feature.suggestedFeatureKey, feature])
  );

  assert.deepEqual(byKey.get("explicit_ears").matcherTerms, ["狼耳", "耳朵"]);
  assert.deepEqual(byKey.get("inferred_ears").matcherTerms, []);
  assert.deepEqual(byKey.get("wolf_tail").matcherTerms, []);
  assert.deepEqual(byKey.get("wolf_wing").matcherTerms, []);
  assert.ok(metadata.conflicts.some((item) => item.errorCode === "FEATURE_TERM_SHADOWED"));
  assert.ok(metadata.conflicts.some((item) => item.errorCode === "FEATURE_TERM_CONFLICT"));
});

test("Schema 错误只进行一次 profile_repair，协议总调用数最多两次", async () => {
  clearCharacterFeatureCompilerCache();
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      const valid = validResponseFromPrompt(request.prompt);
      if (requests.length === 1) return { ...valid, extraText: "禁止" };
      return valid;
    }
  };

  const { metadata } = await compileCharacterFeatures(
    compilerInput({ client })
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /repairMode: profile_repair/u);
  assert.equal(metadata.protocolAttempts.length, 2);
  assert.equal(metadata.protocolAttempts[0].finalResult, "protocol-error");
  assert.equal(metadata.protocolAttempts[1].finalResult, "accepted");
});

test("JSON envelope 错误只使用 envelope_repair，第二次失败后终止", async () => {
  clearCharacterFeatureCompilerCache();
  let calls = 0;
  const prompts = [];
  const client = {
    async generateJson(request) {
      calls += 1;
      prompts.push(request.prompt);
      throw new ModelResponseError("模型未返回合法 JSON");
    }
  };

  await assert.rejects(
    () => compileCharacterFeatures(compilerInput({ client })),
    (error) => {
      assert.ok(error instanceof CharacterFeatureCompilerProtocolError);
      assert.equal(error.stage, "characterFeatureCompiler");
      assert.equal(error.metadata.requestCount, 2);
      assert.equal(error.metadata.protocolAttempts.length, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
  assert.match(prompts[1], /repairMode: envelope_repair/u);
  assert.doesNotMatch(prompts[1], /repairMode: profile_repair/u);
});

test("伪造或跨角色 spanId 直接拒绝且不消耗第二次调用", async () => {
  clearCharacterFeatureCompilerCache();
  let calls = 0;
  const client = {
    async generateJson(request) {
      calls += 1;
      return validResponseFromPrompt(request.prompt, {
        features() {
          return [{
            suggestedFeatureKey: "wolf_tail",
            canonicalName: "狼尾",
            terms: ["尾巴"],
            featureKind: "special_appendage",
            semanticSubtype: "tail",
            evidenceLevel: "inferred",
            evidenceSpanIds: [],
            inferenceSpanIds: ["span-forged-0"]
          }];
        }
      });
    }
  };

  await assert.rejects(
    () => compileCharacterFeatures(compilerInput({ client })),
    (error) => {
      assert.ok(error instanceof CharacterFeatureCompilerProtocolError);
      assert.equal(error.errorCode, "CHARACTER_FEATURE_ILLEGAL_ID");
      assert.equal(error.metadata.requestCount, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("额外状态文本字段被 additionalProperties=false 语义拒绝", async () => {
  clearCharacterFeatureCompilerCache();
  let calls = 0;
  const client = {
    async generateJson(request) {
      calls += 1;
      const response = validResponseFromPrompt(request.prompt, {
        features(payload, character) {
          const spanId = spanContaining(payload, "狼耳", character.characterTargetId);
          return [{
            suggestedFeatureKey: "wolf_ears",
            canonicalName: "狼耳",
            terms: ["狼耳"],
            featureKind: "special_appendage",
            semanticSubtype: "ear",
            evidenceLevel: "explicit",
            evidenceSpanIds: [spanId],
            inferenceSpanIds: [],
            currentPoseText: "狼耳竖起"
          }];
        }
      });
      return response;
    }
  };

  await assert.rejects(
    () => compileCharacterFeatures(compilerInput({ client })),
    CharacterFeatureCompilerProtocolError
  );
  assert.equal(calls, 2);
});

test("网络/provider 错误不进入 protocol repair", async () => {
  clearCharacterFeatureCompilerCache();
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      throw new ModelResponseError("请求失败", "", 503);
    }
  };

  await assert.rejects(
    () => compileCharacterFeatures(compilerInput({ client })),
    (error) => {
      assert.ok(error instanceof CharacterFeatureCompilerTransportError);
      assert.equal(error.stage, "characterFeatureCompiler");
      assert.equal(error.metadata.requestCount, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("featureKind 只接受七个通用分类", () => {
  assert.deepEqual(CHARACTER_FEATURE_KINDS, [
    "body_form",
    "limb_variant",
    "special_appendage",
    "face_part",
    "costume",
    "accessory",
    "other_anatomical"
  ]);
  assert.ok(!CHARACTER_FEATURE_KINDS.includes("ear"));
  assert.ok(!CHARACTER_FEATURE_KINDS.includes("tail"));
});
