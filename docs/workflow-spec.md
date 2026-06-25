# AI 短视频导演工作流规范

## 1. 产品判断

本工作流不以“和原片越不一样越好”为目标。质量标准由两组同时成立的约束构成：

- 体验保真：同定位、同受众、同核心情绪、同类剧情驱动力、同款高价值桥段。
- 表达原创：具体人物、任务、道具、对白、场面调度和镜头表达重新设计。

抽象母题与具体表达必须分开处理。送达任务、旅途结构、情感媒介、获得帮助、被关爱对象、天气或空间推动情绪、生活化或仪式化结尾属于通用叙事构件，可以继续使用；独特台词、专有名称、罕见动作组合、独特道具组合和逐镜对应才进入禁止复制项。

## 2. 处理流程

```mermaid
flowchart LR
    A[上传参考视频] --> B[浏览器抽取带时间戳关键帧]
    B --> C[referenceAnalysis]
    C --> D[sourceScriptReconstruction]
    D --> E[creativeBrief]
    E --> F[themeVariants]
    F --> H[选择主题变体]
    H --> I[fullStory]
    I --> J[animationPlan]
    G[固定角色与垂直赛道] --> E
    G --> F
    G --> I
    G --> J
```

### 阶段一：referenceAnalysis

必须回答：

- 内容定位、目标受众、故事梗概。
- 主角、配角、人物关系、主角职业或社会身份。
- 被关爱对象的身份、显性需求和隐性需求。
- 对白风格、镜头节奏、情绪曲线。
- 观众为什么愿意看完。

所有关键判断需要引用采样画面编号（F1、F2……）或用户补充文本。无法确认的内容进入 `uncertainties`，不得伪装为事实。

### 阶段二：sourceScriptReconstruction

按场输出时间、地点、人物、可见动作、对白大意、景别与镜头、情绪节点、剧作功能、转折点、关键道具和证据置信度；另行输出核心事件顺序、关系模式和结尾动作。

“完整还原”指在现有证据范围内覆盖开场、发展、转折和结尾，不等于填满采样间隙。未提供音频转写时，只能概括可确认的对白功能。

### 阶段三：creativeBrief

`creativeBrief` 是后续创作的唯一结构依据，必须包含：

- `storyEngine`：欲望、阻碍、升级、转折机制、回报。
- `emotionStructure`：每一阶段的剧作功能与目标情绪。
- `roleAndOccupationMapping`：原片角色功能如何映射到固定角色和赛道身份。
- `reusableHighValueBeats`：桥段价值、必须保留内容和可改变表面。
- `controlledRewriteVariables`：需要受控改写的变量。
- `protectedExpressions`：真正禁止直接复制的具体表达。
- `minimumTransformationRules`：最低变换规则及验收检查。
- `allowedNarrativeComponents`：七类通用构件的安全复用方式。
- `nonNegotiableExperience`：五项体验保真要求。

### 阶段四：themeVariants

每个主题变体必须可独立拍摄，并提供两组验收证据：

- `experienceFidelity`：逐项说明定位、受众、情绪、驱动力和高价值桥段如何保留。
- `transformationProof`：逐项说明人物、任务、细节/道具、对白和视听表达如何改变。

只替换姓名或职业不算主题变体。变体必须产生新的具体任务、环境压力、情感媒介、帮助方式和结尾仪式。

### 阶段五：fullStory

用户选择一个 `themeVariants.variants[]` 后，进入独立完整剧情页。该阶段不重新发散主题，只围绕被选中的主题变体扩写，输出：

- `characterBible`：锁定固定角色、被关爱对象、帮助者与对白规则。
- `beatSheet`：45–90 秒短视频的完整剧情节拍。
- `sceneScript`：可拍摄分场，包含地点、人物、可见动作、对白、镜头/声音、情绪节点和剧作功能。
- `keyProps`、`shootingPlan`、`retentionPlan`：进入拍摄筹备需要的道具、场景和完播设计。
- `experienceFidelity` 与 `transformationProof`：继续证明同定位、同受众、同情绪、同类驱动力、同款高价值桥段，同时重写具体表达。
- `continuityAndSafetyCheck`：确认固定角色没有被原片表面身份污染，也没有复用 protectedExpressions。

完整剧情阶段默认调用 `mimo-v2.5-pro`，通过 `MIMO_STORY_MODEL` 单独配置；其余四阶段默认仍用 `MIMO_MODEL=mimo-v2.5`。

### 阶段六：animationPlan

完整剧情生成后，可以继续生成用于 AI 视频制作的 `animationPlan`。该阶段不直接调用具体视频模型，而是输出模型无关的首尾帧生产包：

- `productionStrategy`：默认采用 `first_last_frame_video`，单镜头控制在 3–6 秒，竖屏 9:16。
- `visualBible`：动画风格、色彩、光线、世界规则、镜头语言、角色一致性规则和负面视觉规则。
- `characterReferencePrompts`：固定角色、被关爱对象和帮助者的参考图提示词，用于先锁定视觉一致性。
- `assetPrompts`：关键道具和场景资产提示词。
- `shotPlan`：逐镜头提供首帧 prompt、尾帧 prompt、video prompt、负面 prompt、镜头运动、角色动作、声音设计和验收标准。
- `editPlan`：剪辑节奏、转场、字幕、音乐音效、开头钩子和结尾停顿。
- `generationChecklist`：角色稳定、首尾帧因果、情绪曲线、可剪辑性和表达原创的质检标准。

动画阶段的核心原则是：先稳定视觉，再逐镜生成，不追求一次生成整条片。首尾帧用于锁定每个短镜头的起点和终点，视频模型只负责补中间运动。

## 3. 模型与媒体策略

- 浏览器从本地视频均匀采样 6–10 张关键帧，最长边压缩到 720px；在 MiMo `auto/video` 模式且文件大小允许时，同时用 base64 `video_url` 发送原生视频。应用不持久化视频。
- `auto` 模式下，推理服务不接受原生视频时自动回退关键帧；超出大小限制时直接走关键帧。
- MiMo 多模态视觉输入必须在文本指令之前；用户消息末尾保留 `/no_think`，请求体同时设置 `thinking={"type":"disabled"}`。
- 默认四阶段使用 `mimo-v2.5`，完整剧情阶段和动画生产包阶段使用 `mimo-v2.5-pro`。基础推理参数 `temperature=0.3`、`top_p=0.95`、`stream=false`；四阶段默认 `max_completion_tokens=8192`，完整剧情默认 `MIMO_STORY_MAX_COMPLETION_TOKENS=12288`，动画生产包默认 `MIMO_ANIMATION_MAX_COMPLETION_TOKENS=12288`。
- 当前实现通过小米 OpenAI 兼容 `/chat/completions` 接口连接 MiMo V2.5；原生视频使用 `video_url`，并携带 `fps=2`、`media_resolution=default`。未配置服务时使用明确标注的演示模式。

## 4. 当前边界

- 原生视频过大或推理服务不支持 `video_url` 时会回退浏览器抽帧；快速剪辑、声音设计和未出现在采样帧中的动作可能遗漏。
- 音频尚未自动转写。需要准确对白时，应粘贴字幕/转写，或后续增加 ASR 阶段。
- 模型输出经过 JSON 解析和输入约束，但还没有完整 JSON Schema 自动修复循环。
