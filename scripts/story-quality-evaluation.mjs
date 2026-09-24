#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentDigest } from "../src/production-lineage.js";
import { normalizeModelUsage } from "../src/token-usage.js";
import {
  ensureOutputContract,
  ensureThemeVariantsMatchProfile
} from "../src/validation.js";

export const STORY_QUALITY_INPUT_SCHEMA_VERSION = "story-quality-evaluation-input/1.0";
export const STORY_QUALITY_RESULT_SCHEMA_VERSION = "story-quality-evaluation-result/1.1";

export const STORY_QUALITY_SUBJECTIVE_DIMENSIONS = Object.freeze([
  "hook",
  "protagonistGoal",
  "protagonistAgency",
  "causality",
  "escalation",
  "beatNecessity",
  "clicheRisk",
  "dialogueRedundancy",
  "emotionalPayoff",
  "characterNecessity"
]);

export const STORY_QUALITY_CASE_DIMENSIONS = Object.freeze([
  "tokenUsage",
  "validationFailure"
]);

const RUBRIC = Object.freeze({
  hook: rubric("candidate", "manual", "开场是否提出具体观看问题，且没有提前泄露兑现结果。", "higher_is_better",
    "预测测试：只看第 1 拍，能不能猜到结局怎么解决？猜得到记低分。结尾出现前文没有铺垫、但回头看成立的回响，记高分。"),
  protagonistGoal: rubric("candidate", "manual", "主角目标、阻力与未完成代价是否清楚。", "higher_is_better",
    "追问测试：主角想要什么？不做会失去什么？两个问题都要能从 storyOutline 直接答出来，答不出记低分。"),
  protagonistAgency: rubric("candidate", "manual", "关键推进是否来自主角的决定与行动。", "higher_is_better",
    "选择测试：keyChoice 的另一个选项，有人会真的选吗？没人会选（例如「眼看婴儿车滑下马路而不追」）就不是选择，只是正确反应，记低分。另一个选项也成立且有代价，记高分。"),
  causality: rubric("candidate", "manual", "各 beat 是否以前一行动的结果触发下一步。", "higher_is_better",
    "连接测试：逐拍问「这一拍是因为上一拍发生的吗」。答案是「只是接着发生」而非「因此发生」的拍越多，分越低。"),
  escalation: rubric("candidate", "manual", "压力、代价或选择难度是否逐步升级。", "higher_is_better",
    "加码测试：从第 2 拍起，每拍是否出现新限制、新信息、更高代价、更难选择或更紧时间压力中的至少一种？全程同一强度记低分。"),
  beatNecessity: rubric("candidate", "manual", "删除 beat 是否会损失角色弧、关系推进、情绪积累或后续因果。", "higher_is_better",
    "删除测试：逐拍遮住，故事还成立吗？成立的拍就是废拍（例如只补了辛苦感、没改变任何条件的那种）。废拍越多分越低。"),
  clicheRisk: rubric("candidate", "manual", "是否依赖可互换的套路、通用煽情或陈词滥调。", "lower_is_better",
    "换皮测试：把地点、道具、NPC、天气全换掉，故事还是同一个吗？还是同一个说明结构是模板。注意判定的是完整因果组合的重复，不是某个词出现与否。"),
  dialogueRedundancy: rubric("candidate", "manual", "对白是否重复画面、解释情绪或重复已知信息。", "lower_is_better",
    "遮挡测试：把台词全遮住只看 visibleAction，信息还够吗？够，说明台词没在解说画面，记低分（本维度越低越好）。反过来，遮住画面只看台词就能懂全部剧情，记高分。"),
  emotionalPayoff: rubric("candidate", "manual", "高潮、关键选择与结尾是否兑现此前的关系和情绪铺垫。", "higher_is_better",
    "来源测试：最后一拍的情绪，是由前面哪几拍挣来的？指不出具体来源，或兑现靠奖品、感谢、突然到场的角色，记低分。"),
  characterNecessity: rubric("candidate", "manual", "这个故事是否非该固定角色不可。", "higher_is_better",
    "替换测试：把主角换成任意一个路人，故事还一样吗？一样说明角色可替换，记低分。角色的已签发特征（外观、性格、身份、习惯）直接构成解决方案的一部分时记高分——例如狼耳少女用手影演一只狼。"),
  tokenUsage: Object.freeze({ scope: "case", mode: "observed", description: "生成该候选集合时供应商实际返回的 token usage；没有记录时保持 unavailable/null。" }),
  validationFailure: Object.freeze({ scope: "case", mode: "deterministic", description: "用当前 Story Candidates contract 与结构校验器实际复验得到的失败记录。" })
});

// test 是可机械执行的判据：不需要编剧训练也能得出一致结论，
// 避免主观维度退化成凭感觉打分。它只指导人工阅读，脚本不据此自动评分。
function rubric(scope, mode, description, direction, test = "") {
  return Object.freeze({ scope, mode, description, test, scale: Object.freeze({ min: 1, max: 5, direction }) });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} 必须是对象`);
  return value;
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} 不能为空`);
  return text;
}

export function validateStoryQualityEvaluationInput(input) {
  requireRecord(input, "evaluation input");
  if (input.schemaVersion !== STORY_QUALITY_INPUT_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion 必须是 ${STORY_QUALITY_INPUT_SCHEMA_VERSION}`);
  }
  requireText(input.fixtureSetId, "fixtureSetId");
  if (!Array.isArray(input.cases) || !input.cases.length) {
    throw new TypeError("cases 必须是非空数组");
  }
  const caseIds = new Set();
  input.cases.forEach((item, caseIndex) => {
    const evaluationCase = requireRecord(item, `cases[${caseIndex}]`);
    const caseId = requireText(evaluationCase.caseId, `cases[${caseIndex}].caseId`);
    if (caseIds.has(caseId)) throw new TypeError(`caseId 重复：${caseId}`);
    caseIds.add(caseId);
    requireRecord(evaluationCase.creatorProfile, `cases[${caseIndex}].creatorProfile`);
    const storyCandidates = requireRecord(
      evaluationCase.storyCandidates,
      `cases[${caseIndex}].storyCandidates`
    );
    if (!Array.isArray(storyCandidates.variants)) {
      throw new TypeError(`cases[${caseIndex}].storyCandidates.variants 必须是数组`);
    }
    if (evaluationCase.generation !== undefined && !isRecord(evaluationCase.generation)) {
      throw new TypeError(`cases[${caseIndex}].generation 必须是对象`);
    }
  });
  return input;
}

export function buildStoryQualityEvaluation(input, {
  generatedAt = new Date().toISOString()
} = {}) {
  validateStoryQualityEvaluationInput(input);
  return {
    schemaVersion: STORY_QUALITY_RESULT_SCHEMA_VERSION,
    generatedAt: requireText(generatedAt, "generatedAt"),
    fixtureSetId: input.fixtureSetId,
    inputDigest: contentDigest(input),
    methodology: {
      externalModelCalls: 0,
      subjectiveScoring: "manual",
      contractValidation: "current_local_validator"
    },
    rubric: structuredClone(RUBRIC),
    cases: input.cases.map(evaluateCase)
  };
}

function evaluateCase(evaluationCase) {
  const candidates = evaluationCase.storyCandidates.variants;
  const validationFailure = runCandidateValidation(evaluationCase);
  return {
    caseId: evaluationCase.caseId,
    description: String(evaluationCase.description || ""),
    candidateSetDigest: contentDigest(evaluationCase.storyCandidates),
    generation: {
      provider: nullableText(evaluationCase.generation?.provider),
      model: nullableText(evaluationCase.generation?.model)
    },
    caseDimensions: {
      tokenUsage: evaluationTokenUsage(evaluationCase.generation?.tokenUsage),
      validationFailure
    },
    candidateAssessments: candidates.map((candidate) => ({
      candidateId: String(candidate?.id || ""),
      candidateDigest: contentDigest(candidate),
      dimensions: Object.fromEntries(
        STORY_QUALITY_SUBJECTIVE_DIMENSIONS.map((dimension) => [dimension, unscoredDimension()])
      )
    }))
  };
}

function runCandidateValidation(evaluationCase) {
  try {
    const candidates = structuredClone(evaluationCase.storyCandidates);
    ensureOutputContract(candidates, "themeVariants");
    ensureThemeVariantsMatchProfile(
      candidates,
      structuredClone(evaluationCase.creatorProfile),
      evaluationCase.creativeBrief ? structuredClone(evaluationCase.creativeBrief) : null,
      evaluationCase.visualGuardrails ? structuredClone(evaluationCase.visualGuardrails) : null
    );
    return {
      occurred: false,
      code: null,
      message: null,
      diagnostics: []
    };
  } catch (error) {
    const diagnostics = Array.isArray(error?.details)
      ? error.details.map(normalizeDiagnostic)
      : [];
    return {
      occurred: true,
      code: String(diagnostics[0]?.code || error?.code || error?.name || "VALIDATION_FAILED"),
      message: String(error?.message || error),
      diagnostics
    };
  }
}

function normalizeDiagnostic(detail = {}) {
  return {
    code: nullableText(detail.code),
    path: nullableText(detail.path || detail.jsonPointer),
    reason: nullableText(detail.reason || detail.message)
  };
}

function evaluationTokenUsage(value) {
  const normalized = normalizeModelUsage(value);
  if (!normalized) {
    return {
      available: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null
    };
  }
  return {
    available: true,
    ...normalized
  };
}

function unscoredDimension() {
  return {
    status: "unscored",
    score: null,
    notes: ""
  };
}

function nullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

export async function saveStoryQualityEvaluation(result, outputFile, {
  overwrite = false
} = {}) {
  requireRecord(result, "evaluation result");
  const target = path.resolve(requireText(outputFile, "outputFile"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    flag: overwrite ? "w" : "wx"
  });
  return target;
}

function parseCliArguments(argv) {
  const values = {
    input: "test/fixtures/story-quality/story-candidates-phase1-baseline.json",
    output: "exports/story-quality-evaluations/story-candidates-phase1-baseline.json",
    force: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      values.force = true;
      continue;
    }
    if (arg === "--input" || arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} 缺少路径`);
      values[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { ...values, help: true };
    throw new TypeError(`未知参数：${arg}`);
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCliArguments(argv);
  if (args.help) {
    process.stdout.write(
      "用法：node scripts/story-quality-evaluation.mjs [--input fixture.json] [--output result.json] [--force]\n"
    );
    return;
  }
  const inputPath = path.resolve(args.input);
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = buildStoryQualityEvaluation(input);
  const outputPath = await saveStoryQualityEvaluation(result, args.output, { overwrite: args.force });
  process.stdout.write(
    `故事质量评测基线已保存：${outputPath}\n`
    + `输入摘要：${result.inputDigest}\n`
    + `候选数：${result.cases.reduce((sum, item) => sum + item.candidateAssessments.length, 0)}；外部模型调用：0\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
