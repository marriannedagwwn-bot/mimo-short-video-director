import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ModelResponseError } from "../src/mimo-client.js";
import {
  StaticFrameCompilerProtocolError,
  StaticFrameCompilerTransportError,
  buildStaticFrameCompilerPrompt,
  compileStaticFrames,
  validateStaticFrameCompilerResponse
} from "../src/static-frame-compiler.js";

const invalidFixture = JSON.parse(readFileSync(
  new URL("./fixtures/static-frame-compiler-invalid.json", import.meta.url),
  "utf8"
));
const validFixture = JSON.parse(readFileSync(
  new URL("./fixtures/static-frame-compiler-valid.json", import.meta.url),
  "utf8"
));

const posePath = "animationShotBatch.shotPlan[0].startFrame.characters[0].pose";
const handPropPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].handPropState";
const actionPath = "animationShotBatch.shotPlan[0].startFrame.characters[0].actionState";

function validCompilerResponse() {
  return {
    patches: [
      {
        path: posePath,
        value: "女孩坐在桌前，身体微微前倾，双手放在八音盒盖子两侧，视线落在八音盒上",
        reasonCode: "future_intent",
        triggerSpans: ["准备"],
        visibleFacts: ["身体微微前倾", "双手放在八音盒盖子两侧", "视线落在八音盒上"]
      },
      {
        path: handPropPath,
        value: "双手停在八音盒盖子两侧，八音盒盖保持闭合",
        reasonCode: "temporal_process",
        triggerSpans: ["随后"],
        visibleFacts: ["双手停在八音盒盖子两侧", "八音盒盖保持闭合"]
      },
      {
        path: actionPath,
        value: "右手停留在按钮表面",
        reasonCode: "temporal_process",
        triggerSpans: ["正在"],
        visibleFacts: ["右手停留在按钮表面"]
      }
    ]
  };
}

function compilerOptions(candidate, client, overrides = {}) {
  return {
    candidate,
    client,
    provider: "Qwen",
    model: "qwen-static-frame-compiler",
    maxCompletionTokens: 4096,
    timeoutMs: 300_000,
    batchIndex: 2,
    phase: "post-generate",
    ...overrides
  };
}

test("固定非法 batch 被语义合法化，原输入与 alias 均不被 Compiler 修改", async () => {
  const input = structuredClone(invalidFixture);
  const original = structuredClone(input);
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      return validCompilerResponse();
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(input, client)
  );

  assert.deepEqual(input, original);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "qwen-static-frame-compiler");
  assert.equal(requests[0].maxCompletionTokens, 4096);
  assert.equal(requests[0].requestTimeoutMs, 300_000);
  assert.equal(requests[0].jsonRetryAttempts, 0);
  assert.equal(requests[0].strictJson, true);
  assert.match(requests[0].systemPrompt, /合格字段[\s\S]*no-op/u);
  assert.doesNotMatch(requests[0].prompt, /STALE_ALIAS_SHOULD_NOT_ENTER_COMPILER_CONTEXT/u);
  assert.doesNotMatch(requests[0].prompt, /FUTURE_ALIAS_SHOULD_NOT_ENTER_COMPILER_CONTEXT/u);

  const character = compiledCandidate.shotPlan[0].startFrame.characters[0];
  assert.equal(
    character.pose,
    "女孩坐在桌前，身体微微前倾，双手放在八音盒盖子两侧，视线落在八音盒上"
  );
  assert.equal(character.handPropState, "双手停在八音盒盖子两侧，八音盒盖保持闭合");
  assert.equal(character.actionState, "右手停留在按钮表面");
  assert.equal(compiledCandidate.shotPlan[0].startFramePrompt, original.shotPlan[0].startFramePrompt);
  assert.equal(compiledCandidate.shotPlan[0].futureAlias, original.shotPlan[0].futureAlias);

  assert.equal(metadata.noOp, false);
  assert.equal(metadata.requestCount, 1);
  assert.equal(metadata.finalResult, "accepted");
  assert.equal(metadata.runAccepted, false);
  assert.equal(metadata.protocolAttempts.length, 1);
  assert.equal(metadata.protocolAttempts[0].transportAttempts.length, 1);
  assert.equal(metadata.modifications.length, 3);
  assert.ok(metadata.modifications.every((change) => change.applied === true));
  assert.ok(metadata.modifications.every((change) => change.finalAccepted === false));
});

test("合格 batch 支持 no-op：空 patches 不润色、不触发第二次 protocol attempt", async () => {
  const input = structuredClone(validFixture);
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      return { patches: [] };
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(input, client)
  );

  assert.deepEqual(compiledCandidate, input);
  assert.equal(requests.length, 1);
  assert.equal(metadata.noOp, true);
  assert.equal(metadata.requestCount, 1);
  assert.deepEqual(metadata.modifications, []);
  assert.equal(metadata.protocolAttempts.length, 1);
  assert.equal(metadata.protocolAttempts[0].finalResult, "accepted");
});

test("prompt 只投影结构化 frame/motion 上下文，不枚举或携带 alias", () => {
  const prompt = buildStaticFrameCompilerPrompt(invalidFixture);
  assert.match(prompt, /STATIC_FRAME_COMPILER_V1/u);
  assert.match(prompt, /"path":"animationShotBatch\.shotPlan\[0\]\.startFrame\.characters\[0\]\.pose"/u);
  assert.match(prompt, /"before":"女孩准备打开八音盒","patchEligibility":"compiler-review"/u);
  assert.match(prompt, /"before":"女孩坐在桌前，身体保持前倾，双肘弯曲","patchEligibility":"must-no-op"/u);
  assert.match(prompt, /"motion":/u);
  assert.doesNotMatch(prompt, /startFramePrompt|futureAlias|STALE_ALIAS/u);
});

test("润色式 patch 的唯一 protocol retry 会明确删除该 path 并接受 no-op", async () => {
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          patches: [{
            path: posePath,
            value: "女孩端坐于桌前，身体轻微前倾，双手平放，视线落在八音盒上",
            reasonCode: "ambiguous_nonvisual",
            triggerSpans: ["女孩坐在桌前"],
            visibleFacts: ["身体轻微前倾", "双手平放", "视线落在八音盒上"]
          }]
        };
      }
      return { patches: [] };
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(structuredClone(validFixture), client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /已明确满足静态帧契约/u);
  assert.match(requests[1].prompt, new RegExp(posePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(requests[1].prompt, /从 patches 删除该精确 path/u);
  assert.deepEqual(compiledCandidate, validFixture);
  assert.equal(metadata.noOp, true);
  assert.equal(metadata.protocolAttempts[0].retryDecision, "retry");
  assert.equal(metadata.protocolAttempts[1].finalResult, "accepted");
  assert.equal(metadata.modifications.length, 1);
  assert.equal(metadata.modifications[0].applied, false);
});

test("第一次 protocol 错误在同一 batch 上纠偏一次，第二次成功", async () => {
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) return { patches: "not-an-array" };
      return validCompilerResponse();
    }
  };

  const { metadata } = await compileStaticFrames(
    compilerOptions(structuredClone(invalidFixture), client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /STATIC_FRAME_COMPILER_PROTOCOL_RETRY_V1/u);
  assert.match(requests[1].prompt, /patches 必须是数组/u);
  assert.equal(
    requests[0].prompt.split("允许路径与原值：\n")[1].split("\n\n去除 alias")[0],
    requests[1].prompt.split("允许路径与原值：\n")[1].split("\n\n去除 alias")[0]
  );
  assert.equal(metadata.protocolAttempts.length, 2);
  assert.equal(metadata.protocolAttempts[0].finalResult, "protocol-error");
  assert.equal(metadata.protocolAttempts[0].errorClassification, "protocol");
  assert.equal(metadata.protocolAttempts[0].retryDecision, "retry");
  assert.equal(metadata.protocolAttempts[1].finalResult, "accepted");
  assert.equal(metadata.protocolAttempts[1].retryDecision, "none");
});

test("两次 protocol 错误明确终止 Compiler stage", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      return { patches: "still-invalid" };
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(structuredClone(invalidFixture), client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerProtocolError);
      assert.equal(error.category, "protocol");
      assert.equal(error.metadata.requestCount, 2);
      assert.equal(error.metadata.protocolAttempts.length, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("每个 protocol attempt 各有一次 transport retry，总请求上限为四次", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("connection reset");
        error.code = "ECONNRESET";
        throw error;
      }
      if (calls === 2) return { patches: "protocol-invalid" };
      if (calls === 3) throw new ModelResponseError("provider overloaded", "", 503);
      return validCompilerResponse();
    }
  };

  const { metadata } = await compileStaticFrames(
    compilerOptions(structuredClone(invalidFixture), client)
  );

  assert.equal(calls, 4);
  assert.equal(metadata.requestCount, 4);
  assert.equal(metadata.protocolAttempts.length, 2);
  assert.deepEqual(
    metadata.protocolAttempts.map((attempt) => attempt.transportAttempts.length),
    [2, 2]
  );
  assert.equal(metadata.protocolAttempts[0].transportAttempts[0].retryDecision, "retry");
  assert.equal(metadata.protocolAttempts[1].transportAttempts[0].retryDecision, "retry");
});

test("单个 protocol attempt 两次 transport 均失败后立即终止，不转入 protocol attempt 2", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      const error = new Error("network unavailable");
      error.code = "ENETUNREACH";
      throw error;
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(structuredClone(invalidFixture), client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerTransportError);
      assert.equal(error.classification, "transport");
      assert.equal(error.metadata.requestCount, 2);
      assert.equal(error.metadata.protocolAttempts.length, 1);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("auth/provider 配置类错误不执行 transport retry", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      throw new ModelResponseError("invalid API key", "", 401);
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(structuredClone(validFixture), client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerTransportError);
      assert.equal(error.classification, "auth");
      assert.equal(error.metadata.requestCount, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("无 HTTP status 的 invalid model/provider/config 也不得误判为 transient transport", async (t) => {
  for (const scenario of [
    { message: "invalid model: compiler-x", classification: "provider" },
    { message: "unknown provider: custom", classification: "provider" },
    { message: "missing configuration for compiler", classification: "config" }
  ]) {
    await t.test(scenario.message, async () => {
      let calls = 0;
      const client = {
        async generateJson() {
          calls += 1;
          throw new Error(scenario.message);
        }
      };
      await assert.rejects(
        () => compileStaticFrames(compilerOptions(structuredClone(validFixture), client)),
        (error) => {
          assert.ok(error instanceof StaticFrameCompilerTransportError);
          assert.equal(error.classification, scenario.classification);
          assert.equal(error.metadata.requestCount, 1);
          return true;
        }
      );
      assert.equal(calls, 1);
    });
  }
});

test("客户端模型 JSON 解析错误属于 protocol 错误，不消耗 transport retry", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) throw new ModelResponseError("Qwen 未返回合法 JSON", "bad", 0);
      return { patches: [] };
    }
  };

  const { metadata } = await compileStaticFrames(
    compilerOptions(structuredClone(validFixture), client)
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    metadata.protocolAttempts.map((attempt) => attempt.transportAttempts.length),
    [1, 1]
  );
  assert.equal(metadata.protocolAttempts[0].transportAttempts[0].errorClassification, "protocol");
});

test("actionState 沿用现有空值契约，可合法转换为空且不虚构 visibleFacts", () => {
  const candidate = structuredClone(validFixture);
  candidate.shotPlan[0].startFrame.characters[0].actionState = "准备按下按钮";
  const patches = validateStaticFrameCompilerResponse({
    patches: [{
      path: actionPath,
      value: "",
      reasonCode: "future_intent",
      triggerSpans: ["准备"],
      visibleFacts: []
    }]
  }, { candidate });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].value, "");
});

test("严格 patch schema、白名单、原子性和证据协议", async (t) => {
  await t.test("额外键被拒绝", () => {
    const response = validCompilerResponse();
    response.patches[0].styleNote = "更生动";
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /只能包含 path、value、reasonCode、triggerSpans、visibleFacts/u
    );
  });

  await t.test("未知字段路径被拒绝", () => {
    const response = validCompilerResponse();
    response.patches[0].path = "animationShotBatch.shotPlan[0].startFrame.characters[0].gaze";
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /不在允许路径白名单/u
    );
  });

  await t.test("重复路径被拒绝", () => {
    const response = validCompilerResponse();
    response.patches.push(structuredClone(response.patches[0]));
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /path 重复/u
    );
  });

  await t.test("triggerSpans 必须逐字来自 before", () => {
    const response = validCompilerResponse();
    response.patches[0].triggerSpans = ["打算"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /逐字来自对应文本/u
    );
  });

  await t.test("相邻 triggerSpans 可共同证明一个连续问题表达", () => {
    const candidate = structuredClone(validFixture);
    candidate.shotPlan[0].startFrame.characters[0].actionState = "右手正在按下按钮";
    const response = {
      patches: [{
        path: actionPath,
        value: "右手停留在按钮表面",
        reasonCode: "temporal_process",
        triggerSpans: ["正在", "按下按钮"],
        visibleFacts: ["右手停留在按钮表面"]
      }]
    };

    assert.equal(
      validateStaticFrameCompilerResponse(response, { candidate })[0].value,
      "右手停留在按钮表面"
    );
  });

  await t.test("reasonCode 保持枚举约束，triggerSpans 独立证明静态帧问题", () => {
    const candidate = structuredClone(validFixture);
    candidate.shotPlan[0].startFrame.characters[0].actionState = "右手正在按下按钮";
    const response = {
      patches: [{
        path: actionPath,
        value: "右手停留在按钮表面",
        reasonCode: "narrative_cognition",
        triggerSpans: ["正在"],
        visibleFacts: ["右手停留在按钮表面"]
      }]
    };

    assert.equal(
      validateStaticFrameCompilerResponse(response, { candidate })[0].reasonCode,
      "narrative_cognition"
    );
    response.patches[0].reasonCode = "not_allowed";
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate }),
      /reasonCode 无效/u
    );
  });

  await t.test("证据片段不得重复、包含或重叠", () => {
    const response = validCompilerResponse();
    response.patches[0].visibleFacts = ["身体微微前倾", "微微前倾"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /包含关系/u
    );
  });

  await t.test("pose 必须覆盖至少两个不同可观察维度", () => {
    const response = validCompilerResponse();
    response.patches[0].value = "女孩身体微微前倾，身体保持直立";
    response.patches[0].visibleFacts = ["身体微微前倾", "身体保持直立"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /至少两个不同可观察维度/u
    );
  });

  await t.test("value 不得残留意图、时间推进或进行态", () => {
    const response = validCompilerResponse();
    response.patches[2].value = "右手正在按下按钮";
    response.patches[2].visibleFacts = ["右手正在按下按钮"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /仍包含静态帧不允许的表达：正在/u
    );
  });

  await t.test("机械删除关键词被拒绝", () => {
    const response = validCompilerResponse();
    response.patches[0].value = "女孩打开八音盒";
    response.patches[0].visibleFacts = ["女孩打开", "八音盒"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /机械删除意图或过程词/u
    );
  });

  await t.test("机械删词后只添加体貌助词仍被拒绝", () => {
    const candidate = structuredClone(invalidFixture);
    candidate.shotPlan[0].startFrame.characters[0].handPropState = "双手准备打开八音盒";
    const response = {
      patches: [{
        path: handPropPath,
        value: "双手打开了八音盒",
        reasonCode: "future_intent",
        triggerSpans: ["准备"],
        visibleFacts: ["双手打开了八音盒"]
      }]
    };
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate }),
      /机械删除意图或过程词/u
    );
  });

  await t.test("无问题 triggerSpan 的润色式 patch 被拒绝", () => {
    const responses = [{
      patches: [{
        path: posePath,
        value: "女孩端坐于桌前，身体轻微前倾，双手平放，视线落在八音盒上",
        reasonCode: "ambiguous_nonvisual",
        triggerSpans: ["女孩坐在桌前"],
        visibleFacts: ["身体轻微前倾", "双手平放", "视线落在八音盒上"]
      }]
    }, {
      patches: [{
        path: handPropPath,
        value: "双手扶稳八音盒，盒盖保持关闭",
        reasonCode: "ambiguous_nonvisual",
        triggerSpans: ["左手扶住盒身"],
        visibleFacts: ["双手扶稳八音盒", "盒盖保持关闭"]
      }]
    }, {
      patches: [{
        path: actionPath,
        value: "右手平贴按钮表面",
        reasonCode: "ambiguous_nonvisual",
        triggerSpans: ["右手停留在按钮表面"],
        visibleFacts: ["右手平贴按钮表面"]
      }]
    }];
    for (const response of responses) {
      assert.throws(
        () => validateStaticFrameCompilerResponse(response, { candidate: validFixture }),
        /禁止润色式 patch/u
      );
    }
  });

  await t.test("单一维度但合格的 pose 仍必须 no-op，禁止丰富细节", () => {
    const candidate = structuredClone(validFixture);
    candidate.shotPlan[0].startFrame.characters[0].pose = "女孩站在桌前";
    const response = {
      patches: [{
        path: posePath,
        value: "女孩站在桌前，身体微微前倾，双手放在桌边",
        reasonCode: "ambiguous_nonvisual",
        triggerSpans: ["女孩站在桌前"],
        visibleFacts: ["身体微微前倾", "双手放在桌边"]
      }]
    };
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate }),
      /必须从 patches 省略，禁止润色式 patch/u
    );
  });

  await t.test("明确心理意图不依赖 pose 维度启发式，允许 LLM 静态化", () => {
    const candidate = structuredClone(validFixture);
    candidate.shotPlan[0].startFrame.characters[0].pose = "女孩站在桌前，双手想打开八音盒";
    const response = {
      patches: [{
        path: posePath,
        value: "女孩站在桌前，身体微微前倾，双手停在八音盒盖子两侧，视线落在八音盒上",
        reasonCode: "psychological_activity",
        triggerSpans: ["想打开"],
        visibleFacts: ["身体微微前倾", "双手停在八音盒盖子两侧", "视线落在八音盒上"]
      }]
    };
    assert.equal(
      validateStaticFrameCompilerResponse(response, { candidate })[0].value,
      response.patches[0].value
    );
  });

  await t.test("triggerSpans 必须覆盖明确违规证据，不能复制无关上下文", () => {
    const response = validCompilerResponse();
    response.patches[0].triggerSpans = ["女孩"];
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /必须至少有一个片段包含 before 中的明确静态帧违规表达/u
    );
  });

  await t.test("含明确违规表达的字段不得从 patches 遗漏", () => {
    const response = validCompilerResponse();
    response.patches = response.patches.filter((patch) => patch.path !== actionPath);
    assert.throws(
      () => validateStaticFrameCompilerResponse(response, { candidate: invalidFixture }),
      /遗漏了含明确静态帧违规表达/u
    );
  });
});

test("非法 no-op 会执行唯一 protocol retry，仍 no-op 时明确失败", async () => {
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      return { patches: [] };
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(structuredClone(invalidFixture), client)),
    /遗漏了含明确静态帧违规表达/u
  );
  assert.equal(calls, 2);
});
