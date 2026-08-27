# Story Candidates 离线质量评测基线

## 边界

本入口只建立 Phase 1 的固定输入、记录格式和人工复核工作台，不调用外部模型，也不把主观故事质量变成 `npm test` 的硬断言。

脚本会执行两类确定性工作：

- 用当前 Story Candidates Schema、结构分化和固定主角校验器复验 fixture，并把真实失败写入 `validationFailure`；
- 对输入和每个 Candidate 计算 canonical JSON SHA-256，保证不同批次的人工记录能精确对应同一份内容。

脚本不会用人物、天气、道具或场景关键词判断质量，也不会自动判断选择是否有意义、情绪是否成立、故事是否陈旧。

## 固定输入

默认输入是：

```text
test/fixtures/story-quality/story-candidates-phase1-baseline.json
```

输入版本为 `story-quality-evaluation-input/1.0`，最小结构如下：

```json
{
  "schemaVersion": "story-quality-evaluation-input/1.0",
  "fixtureSetId": "story-candidates-phase1-baseline",
  "cases": [
    {
      "caseId": "case-id",
      "creatorProfile": {},
      "generation": {
        "provider": null,
        "model": null,
        "tokenUsage": null
      },
      "storyCandidates": {
        "variants": []
      }
    }
  ]
}
```

`storyCandidates` 保存待评候选的完整 wire 内容。`generation.tokenUsage` 只能记录供应商真实返回的数据；无法取得时必须是 `null`，不能用 `0` 冒充零消耗。fixture 不保存人工评分。

## 运行和保存

直接运行默认基线：

```bash
node scripts/story-quality-evaluation.mjs
```

默认结果写入已被 Git 忽略的：

```text
exports/story-quality-evaluations/story-candidates-phase1-baseline.json
```

为防止覆盖人工记录，目标已存在时脚本会失败。明确需要重建空白模板时使用：

```bash
node scripts/story-quality-evaluation.mjs --force
```

也可以指定其他固定输入与结果路径：

```bash
node scripts/story-quality-evaluation.mjs \
  --input path/to/input.json \
  --output exports/story-quality-evaluations/run-a.json
```

运行过程只读本地 JSON、调用本地 validator 并保存结果；`methodology.externalModelCalls` 固定为 `0`。

## 结果格式

结果版本为 `story-quality-evaluation-result/1.0`。每个 case 记录：

- `candidateSetDigest`：整组 Candidate 摘要；
- `caseDimensions.tokenUsage`：真实 token 数据或明确的 unavailable/null；
- `caseDimensions.validationFailure`：当前本地 validator 的实际结果；
- `candidateAssessments[].candidateDigest`：单个 Candidate 摘要；
- `candidateAssessments[].dimensions`：九项留给人工复核的主观维度。

九项主观维度是：

| 维度 | 人工复核问题 | 方向 |
| --- | --- | --- |
| `hook` | 是否提出具体观看问题且没有提前泄露兑现结果 | 越高越好 |
| `protagonistGoal` | 主角目标、阻力和未完成代价是否清楚 | 越高越好 |
| `protagonistAgency` | 关键推进是否来自主角决定与行动 | 越高越好 |
| `causality` | beat 之间是否存在可解释的因果触发 | 越高越好 |
| `escalation` | 压力、代价或选择难度是否升级 | 越高越好 |
| `beatNecessity` | 删除 beat 是否损失角色弧、关系、情绪或后续因果 | 越高越好 |
| `clicheRisk` | 是否依赖可互换套路或通用煽情 | 越低越好 |
| `dialogueRedundancy` | 对白是否重复画面、情绪或已知信息 | 越低越好 |
| `emotionalPayoff` | 高潮、关键选择和结尾是否兑现铺垫 | 越高越好 |

新生成的模板对每一项都只写：

```json
{
  "status": "unscored",
  "score": null,
  "notes": ""
}
```

人工阅读完整 Candidate 后，才可以把 `status` 改为 `scored`、填写 1–5 分和证据说明。不要让脚本、普通单元测试或关键词规则替人填写这些值。`tokenUsage` 与 `validationFailure` 不属于主观评分，分别来自生成回执和本地确定性校验。

## 测试职责

`test/story-quality-evaluation.test.js` 只锁定输入/输出格式、摘要稳定性、validator 失败记录和“默认不评分”行为。它不会断言某个故事的 hook、情绪或选择必须得到多少分。
