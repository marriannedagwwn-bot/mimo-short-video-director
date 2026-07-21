# 逐镜负面提示词重构验收样例

本文记录 2026-07-20 重构后的数据形态。示例中的 provider 地址、模型名、图片数据和鉴权信息均已脱敏；请求快照用于证明字段传递，不代表真实账号调用。

## 1. 小白子 visualGuardrails 前后对比

固定角色输入：`小白子，Q 版猫耳少女人形，猫耳和蓬松猫尾巴，活泼可爱；只用“嗷”或“嗷呜”表达。`

旧结构会把“未声明”误当作负面词成立理由，典型失败如下：

```json
{
  "allowedPositiveTraits": [
    { "term": "猫耳", "scope": "bodyFeature" },
    { "term": "蓬松猫尾巴", "scope": "bodyFeature" }
  ],
  "forbiddenPositiveTraits": [
    { "term": "爪子", "reason": "用户未声明", "severity": "block" },
    { "term": "肉垫", "reason": "用户未声明", "severity": "block" },
    { "term": "鸟喙、脚蹼、鳍、羽毛、狼尾、狐尾、兔尾、龙尾", "reason": "用户未声明", "severity": "block" }
  ],
  "sourceSurfaceExpressions": [
    { "term": "企鹅服", "mustAvoid": true }
  ],
  "commonNegativePrompt": [
    "不要爪子、肉垫、鸟喙、脚蹼、鳍、羽毛、狼尾、狐尾、兔尾、龙尾、企鹅、企鹅服、咕嘎"
  ]
}
```

新结构不生成 `commonNegativePrompt`，也不枚举理论身体部件：

```json
{
  "fixedCharacterBoundary": {
    "characterName": "小白子",
    "identityLock": "小白子始终保持 Q 版猫耳少女人形",
    "allowedIdentity": "Q 版猫耳少女人形",
    "allowedAppearance": "猫耳和蓬松猫尾巴",
    "allowedBodyFeatures": ["猫耳", "蓬松猫尾巴"],
    "styleNotes": "猫娘仅按用户明确写出的风格与外观特征呈现。",
    "explicitUserPresets": ["Q 版猫耳少女人形", "猫耳", "蓬松猫尾巴"],
    "doNotInfer": "后续正向提示词不得擅自添加用户没有授权的角色特征；未声明不等于渲染负面词。"
  },
  "allowedPositiveTraits": [
    { "term": "小白子", "scope": "identity", "reason": "用户固定角色" },
    { "term": "猫耳", "scope": "bodyFeature", "reason": "用户明确设定" },
    { "term": "蓬松猫尾巴", "scope": "bodyFeature", "reason": "用户明确设定" }
  ],
  "positivePromptBoundary": [
    {
      "rule": "小白子保持 Q 版猫耳少女人形，仅使用用户明确设定的猫耳和蓬松猫尾巴，不擅自添加其他生物结构。",
      "triggerEvidence": [
        { "sourcePath": "creatorProfile.fixedCharacter", "evidence": "小白子，Q 版猫耳少女人形，猫耳和蓬松猫尾巴" }
      ],
      "severity": "block"
    }
  ],
  "sourceSimilarityRules": [
    {
      "text": "主题、故事与分镜不得复用原片企鹅服。",
      "sourceExpression": "企鹅服",
      "triggerEvidence": [
        { "sourcePath": "creativeBrief.protectedExpressions[0].sourceExpression", "evidence": "企鹅服" }
      ],
      "appliesWhenReferenceUsed": true
    }
  ],
  "dialogueRules": [
    {
      "text": "小白子只能使用“嗷”或“嗷呜”，不得说完整人类句子。",
      "triggerEvidence": [
        { "sourcePath": "creatorProfile.constraints", "evidence": "只用嗷或嗷呜表达" }
      ]
    }
  ],
  "stageInstructions": {
    "themeVariants": "执行正向边界和原片表达规避。",
    "fullStory": "分别执行正向边界、原片规避与台词规则。",
    "animationPlan": "按当前镜头和明确证据逐镜生成可为空的图片/视频负面词。"
  },
  "rationale": "本阶段不生成最终渲染负面提示词。",
  "uncertainties": []
}
```

`企鹅服` 仍可作为故事与分镜的来源相似规则；由于当前生成请求没有传入原片画面，它不会进入任一 shot 的 render negative。`咕嘎` 只属于 `dialogueRules`。

## 2. 三个 shot 的逐镜对比

```json
[
  {
    "shotId": "A01",
    "characterAction": "小白子打开木箱",
    "negativePrompts": { "image": [], "video": [] }
  },
  {
    "shotId": "A02",
    "characterAction": "小白子拿起透明玻璃幻灯片，对着夕阳观察",
    "negativePrompts": {
      "image": [
        {
          "text": "手指与透明玻璃片融合",
          "appliesTo": "image",
          "triggerEvidence": [
            {
              "sourcePath": "fullStory.sceneScript[S2].visibleAction",
              "evidence": "小白子拿起透明玻璃幻灯片，对着夕阳观察"
            }
          ],
          "reasonCode": "shot_interaction_failure",
          "priority": "high",
          "enabled": true
        },
        {
          "text": "玻璃幻灯片被错误生成成手机屏幕",
          "appliesTo": "image",
          "triggerEvidence": [
            {
              "sourcePath": "fullStory.sceneScript[S2].visibleAction",
              "evidence": "小白子拿起透明玻璃幻灯片，对着夕阳观察"
            }
          ],
          "reasonCode": "shot_object_confusion",
          "priority": "medium",
          "enabled": true
        }
      ],
      "video": [
        {
          "text": "拿起过程中手指与透明玻璃片融合",
          "appliesTo": "video",
          "triggerEvidence": [
            {
              "sourcePath": "fullStory.sceneScript[S2].visibleAction",
              "evidence": "小白子拿起透明玻璃幻灯片，对着夕阳观察"
            }
          ],
          "reasonCode": "shot_interaction_failure",
          "priority": "high",
          "enabled": true
        },
        {
          "text": "玻璃幻灯片在动作过程中变形",
          "appliesTo": "video",
          "triggerEvidence": [
            {
              "sourcePath": "fullStory.sceneScript[S2].visibleAction",
              "evidence": "小白子拿起透明玻璃幻灯片，对着夕阳观察"
            }
          ],
          "reasonCode": "temporal_consistency_failure",
          "priority": "medium",
          "enabled": true
        }
      ]
    }
  },
  {
    "shotId": "A03",
    "characterAction": "小白子看见玻璃片上的旧照片，安静地笑了一下",
    "negativePrompts": { "image": [], "video": [] }
  }
]
```

这里没有鸟喙、脚蹼、鳍、羽毛、其它尾巴、企鹅或台词词汇；A01/A03 没有明确生成风险，所以保持空数组。

## 3. 单镜头可灵请求快照

仓库保留页面内的单镜头首尾帧生成链路。对于 A02，服务端只编译当前 shot 中 `enabled !== false` 且 `appliesTo` 为 `video` 或 `both` 的条目，并通过 `kling_image_to_video` preset 把它们写入 `negative_prompt`。

脱敏后的实际可灵请求体示例：

```json
{
  "model_name": "[REDACTED_MODEL]",
  "image": "[REDACTED_BASE64]",
  "image_tail": "[REDACTED_BASE64]",
  "prompt": "小白子平稳拿起玻璃幻灯片并举到夕阳前",
  "negative_prompt": "拿起过程中手指与透明玻璃片融合；玻璃幻灯片在动作过程中变形",
  "mode": "pro",
  "duration": "5"
}
```

供应商回执中的传递证明：

```json
{
  "provider": "generic-http-worker",
  "capability": "first_last_frame_video_generation",
  "negativePromptDelivery": {
    "supported": true,
    "appliedMode": "native_negative",
    "providerField": "negative_prompt",
    "compiledNegativePrompt": "拿起过程中手指与透明玻璃片融合；玻璃幻灯片在动作过程中变形",
    "appliedText": "拿起过程中手指与透明玻璃片融合；玻璃幻灯片在动作过程中变形",
    "providerIgnored": false,
    "ignored": []
  },
  "requestPreview": {
    "body": {
      "image": "[REDACTED_BASE64]",
      "image_tail": "[REDACTED_BASE64]",
      "negative_prompt": "拿起过程中手指与透明玻璃片融合；玻璃幻灯片在动作过程中变形"
    }
  }
}
```

回归测试会同时检查可灵 POST 请求体、轮询返回的 mp4 和回执快照，因此这一结论不只依赖 LLM 输出。该能力仅用于页面单镜头试片；JSONL 任务队列、整片批处理、本地质检和成片合成仍不在仓库内。
