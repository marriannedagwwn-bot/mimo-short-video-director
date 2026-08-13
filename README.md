# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 启动

要求 Node.js 24，`package.json` 明确限制为 `>=24 <25`。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，完整创意流程仍可运行，但结果不是对视频的真实判断。

## 全局角色边界

`Visual Guardrails` 是固定角色语义唯一生成阶段。视觉模型会结合用户角色描述、参考分析、脚本还原和创意简报，一次性输出 `requiredTraits`、`allowedTraits` 与 `forbiddenTraits`；可以使用模型常识理解“狼娘”等开放概念，但不依赖本地写死的物种关键词字典，且用户明确肯定或否定的设定优先。

服务端会将该边界与当前上游数据摘要绑定并签名。主题变体、Legacy Full Story、Animation Plan、人物参考精修、角色图、旧 v2 首尾帧和视频生成只消费同一份已签发边界，不会在每个阶段重新识别关键词或重新推断角色特征。修改固定角色、赛道、限制、字幕或参考视频会使旧边界失效，页面要求重新运行工作流。

## 接入 Xiaomi MiMo V2.5

项目默认使用小米官方 OpenAI 兼容接口和 `mimo-v2.5` 模型。先确认模型服务可访问：

```bash
curl https://api.xiaomimimo.com/v1/models \
  -H "Authorization: Bearer $MIMO_API_KEY"
```

然后在本项目中复制环境变量文件：

```bash
cp .env.example .env
```

至少配置：

```dotenv
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_API_KEY=你的 key
MIMO_MODEL=mimo-v2.5
MIMO_STORY_MODEL=mimo-v2.5-pro
MIMO_ANIMATION_MODEL=mimo-v2.5-pro
MIMO_REQUEST_TIMEOUT_MS=900000
MIMO_MEDIA_MODE=auto
```

连接成功后，页面右上角会显示当前解析、剧情和动画阶段使用的模型。

`MIMO_MEDIA_MODE=auto` 会优先通过 `video_url` 发送原生视频；请求中会按 MiMo V2.5 文档携带 `fps` 与 `media_resolution`，默认 `MIMO_VIDEO_FPS=2`、`MIMO_VIDEO_MEDIA_RESOLUTION=default`。若服务返回不支持媒体类型的 400/415/422，再自动回退为带时间戳关键帧。超过 `MIMO_NATIVE_VIDEO_MAX_MB` 的视频直接使用关键帧，避免 base64 请求占用过多内存。

MiMo 请求参数默认为 `temperature=0.3`、`top_p=0.95`、`max_completion_tokens=8192`、`thinking=disabled`、`stream=false`。如果没有配置 Qwen，参考片分析、脚本还原、creativeBrief、主题变体、完整剧情和动画生产包都会回退到 MiMo 的对应模型。

`MIMO_THINKING=disabled` 时，MiMo 用户消息末尾会追加 `/no_think`；改成 `MIMO_THINKING=enabled` 后，请求体会发送 `thinking={"type":"enabled"}`，并且不会再追加 `/no_think`。

如果希望参考视频解析和后续文本阶段默认改用千问，继续增加：

```dotenv
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=你的 DashScope 或 Model Studio key
QWEN_MODEL=qwen3.7-max
QWEN_VIDEO_MODEL=qwen3.7-plus
QWEN_ANALYSIS_MODEL=qwen3.7-plus
QWEN_RECONSTRUCTION_MODEL=qwen3.7-plus
QWEN_BRIEF_MODEL=qwen3.7-max
QWEN_VISUAL_MODEL=qwen3.7-plus
QWEN_VARIANTS_MODEL=qwen3.7-max
QWEN_STORY_MODEL=qwen3.7-max
QWEN_ANIMATION_MODEL=qwen3.7-max
QWEN_CHARACTER_REFERENCE_MODEL=qwen3.7-plus
QWEN_REQUEST_TIMEOUT_MS=900000
QWEN_MEDIA_MODE=auto
QWEN_NATIVE_VIDEO_MAX_MB=7
QWEN_VIDEO_FPS=2
QWEN_ENABLE_THINKING=false
```

配置 `QWEN_API_KEY` 后，只要 Qwen 可用，参考片分析、脚本还原、创意简报、视觉规则、主题变体、完整剧情、动画生产包和人物参考修正默认都会调用 Qwen 对应阶段模型；未配置 Qwen 时自动回退为 MiMo。`qwen3.7-max` 是纯文本阶段的默认选择；会传入视频或图片的参考片分析、脚本还原、视觉规则和人物参考修正默认使用 `qwen3.7-plus`，也可以改成账号可用的 Qwen-VL / Qwen-Omni 模型。页面顶部“模型设置”按钮可以按阶段临时切换 provider 和模型名，覆盖值会随之后所有生成请求发送给后端，也会写入导出的生产包。角色图片仍由已配置的即梦图片服务生成；当前 `direct_shot` 不生成首尾帧图片，旧 v2 兼容路径才保留首尾帧能力。

## 当前 Animation Plan 临时主流程

页面请求显式发送 `animationPlanMode: "direct_shot"`，服务端返回 `promptSchemaVersion: "3.0"` 与 `productionStrategy.format: "direct_shot_video"`。每个 shot 保留 `shotId`、`sourceSceneId`、`sceneId`、`durationSeconds`、`storyPurpose`、`emotionalTarget`、`videoPrompt`、`cameraMotion`、`characterAction`、`dialogueOrSubtitle`、`soundDesign`、`continuityNotes`、`negativePrompts` 和 `acceptanceCriteria`；`negativePrompts.image` 必须为 `[]`。

页面允许显式选择 `9:16` 或 `16:9`。首次生成时，该值会锁入 `productionStrategy.targetAspectRatio`、Foundation Prompt 和后续视频请求；模型返回其他比例或与用户选择不一致会明确失败。已有 Plan 切换画幅时不调用模型、不重写 shot，只更新计划级输出画幅并签发新 revision/media namespace，使旧画幅镜头媒体失效。若要让模型连镜头构图一起重新设计，再单独点击重新生成 Animation Plan。

Animation Plan 顶部的时长使用全部 `shotPlan[].durationSeconds` 的合计，并把 `productionStrategy.targetRuntimeSeconds` 保留为上游目标用于显示偏差；不会再把目标时长冒充为当前镜头计划总长。

当前场内拆镜只依据 Full Story 的地点和人物主要动作目标：地点或主要动作目标变化才拆镜；同一地点、围绕同一主要目标形成完整叙事动作的连续阶段保留为一条业务 shot。景别、机位、构图、焦段、运镜和转场建议只用于已划定业务 shot 的内部摄影/剪辑表达，不得单独增加 `shotPlan[]`；一条 `videoPrompt` 可以按顺序包含中景跟随、关键动作特写、硬切和结尾宽景。`shotAndSound` 与 `shootingNotes` 不是镜头数量的事实源。每个 source scene 至少一镜及 3–6 秒单镜时长约束保持不变，内部摄影变化只在时长可承载且不遗漏剧情动作时使用。

每条 `direct_shot.videoPrompt` 由 Animation Plan 模型直接写成一条自包含自然语言提示词，依次组织 Foundation 已锁定的风格与物理光线、地点环境、实际出镜主体及外观、`visibleAction` 顺序动作链、内部摄影/剪辑顺序、节奏与声音、稳定约束和停止条件。`cameraMotion` 同步记录同一业务 shot 内的完整摄影/剪辑顺序；若使用内部切换，验收标准同时检查动作链与关键切换。Animation Plan 阶段不会凭空生成 `@图片/@视频/@音频` 编号，因为运行时参考素材尚未绑定。

当前 shot 禁止 `startFrame`、`endFrame`、`motion`、`startFramePrompt`、`endFramePrompt` 五个端点字段，也不得用别名补回端点。Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除。旧 v2 代码保留兼容，但不参与当前 `direct_shot` 主流程。

视频请求仍必须显式选择 `generationMode`，不能根据端点字段缺失、provider、模型名或素材存在性推断。无端点的 `direct_shot` 不能使用 `first_last_frame`；选择 `all_reference` 时仍需提供合法图片或视频，不能只提供音频。

## 接入 DeepSeek-V4 纯文本模型

DeepSeek 只作为显式可选的纯文本 provider，不会因为配置了 API Key 就自动接管 Qwen/MiMo 的默认阶段路由。页面“模型设置”只会在创意简报、主题变体、Legacy Full Story、Animation Plan 和旧 v2 兼容路径的 Static Frame Compiler 中提供 DeepSeek；参考片分析、脚本还原、视觉规则和人物图修正仍必须使用支持图片或视频输入的 Qwen/MiMo。前端隐藏不兼容选项，服务端也会在调用 provider 前明确拒绝媒体阶段绕过请求。

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MAX_COMPLETION_TOKENS=16384
DEEPSEEK_REQUEST_TIMEOUT_MS=900000
DEEPSEEK_JSON_RETRY_ATTEMPTS=2
DEEPSEEK_THINKING=disabled
DEEPSEEK_TEMPERATURE=1
DEEPSEEK_TOP_P=1
DEEPSEEK_JSON_MODE=true
```

可选模型为 `deepseek-v4-flash` 和 `deepseek-v4-pro`，页面默认把 Flash 放在首位，Pro 保留为显式对照选择，不做静默回退。客户端使用官方 OpenAI 兼容 `/chat/completions` 与 JSON Output；空内容、非法 JSON、鉴权失败和媒体输入都会明确失败或按既有受控次数重试，不会返回默认值掩盖错误。接口依据：[DeepSeek V4 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。模型设置中的阶段标题会显示“视觉模型”或“文本模型”标签，图片和视频生成阶段保留独立标签。

以下 Static Frame Compiler 配置仅供旧 v2 首尾帧兼容路径。当前 `direct_shot` 中 Character Feature Compiler、Static Frame Compiler、本地 Prompt Compiler：暂时弃置，后续优化或删除；旧实现与配置保留，供兼容路径把剧情叙事语言转换为可直接观察的单帧状态。旧 v2 的 Static Frame Compiler 复用已配置的 Qwen、MiMo 或 DeepSeek 客户端与凭据，但 provider/model 不继承动画规划阶段，也不会静默回退：

```dotenv
STATIC_FRAME_COMPILER_PROVIDER=Qwen
STATIC_FRAME_COMPILER_MODEL=qwen3.7-max
STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS=4096
STATIC_FRAME_COMPILER_TIMEOUT_MS=300000
```

`STATIC_FRAME_COMPILER_PROVIDER` 仅支持 `Qwen`、`MiMo` 或 `DeepSeek`，对应 provider 必须已经配置可用。配置缺失或模型不可用时，显式运行旧 v2 兼容路径会明确报告 Static Frame Compiler 不可用；当前 `direct_shot` 不以该配置作为运行前提。

Qwen、MiMo 和 DeepSeek 的单次生成请求默认都允许等待 15 分钟，分别由 `QWEN_REQUEST_TIMEOUT_MS=900000`、`MIMO_REQUEST_TIMEOUT_MS=900000` 和 `DEEPSEEK_REQUEST_TIMEOUT_MS=900000` 控制。`SERVER_REQUEST_TIMEOUT_MS=900000` 同步限制服务端接收请求体的时间；它不替代模型请求超时设置。

Qwen 视频解析遵循阿里云百炼 OpenAI 兼容 Chat Completions 的多模态格式：小视频优先以 `video_url` 发送 Base64 Data URL，大于 `QWEN_NATIVE_VIDEO_MAX_MB` 或 `QWEN_MEDIA_MODE=frames` 时改用关键帧图片列表 `video`。阿里云文档说明 `video_url` 支持公网 URL 或 Base64 Data URL，`fps` 可控制抽帧频率；同时 Base64 视频编码后需小于 10MB，所以默认把原始视频上限设为 7MB。Qwen-VL 只能理解视频视觉信息；如果需要理解视频里的音频，需要选择支持音频的 Qwen-Omni 模型。接口依据：[MiMo V2.5 模型说明](https://mimo.mi.com/docs/en-US/product/introduction/models#MiMo-V25)、[MiMo OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[MiMo 视频理解文档](https://mimo.mi.com/docs/en-US/use-cases/video-understanding)、[阿里云百炼 OpenAI Chat 兼容文档](https://www.alibabacloud.com/help/zh/model-studio/qwen-api-via-openai-chat-completions) 和 [阿里云图像与视频理解文档](https://help.aliyun.com/zh/model-studio/vision)。

## 接入即梦 5.0 Lite 角色参考图生成

动画生产包生成后，“角色参考提示词”标题右侧会出现 `+` 号。点击后可上传一张参考图片，选择角色和生成数量，系统会用即梦 5.0 Lite 流式生成站立全身角色参考图，并把生成图保存到 `public/generated-images/`。选择某张图“设为人物参考图”后，会写回当前角色参考提示词并同步镜头提示词。

至少配置：

```dotenv
JIMENG_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
JIMENG_API_KEY=你的火山方舟 Ark key
JIMENG_IMAGE_MODEL=doubao-seedream-5-0-260128
JIMENG_IMAGE_SIZE=1728x2304
JIMENG_IMAGE_OUTPUT_FORMAT=png
JIMENG_IMAGE_FIELD=image
JIMENG_WATERMARK=false
JIMENG_MAX_IMAGES=6
```

如果使用 BytePlus 国际站 key，则把 `JIMENG_BASE_URL` 改成 `https://ark.ap-southeast.bytepluses.com/api/v3`，把模型名改成国际站返回的 `seedream-5-0-lite-260128` 或账号实际可用的模型 ID。参考图字段保持 `JIMENG_IMAGE_FIELD=image`，多张参考图会作为数组放进同一个 `image` 字段。国内火山 key 和国际 BytePlus key 不能混用，否则会返回 401。

当前请求使用 `POST /images/generations`，发送 `stream=true`、`response_format=b64_json`、`sequential_image_generation=auto/disabled`。提示词固定为“参考我上传的这张图片，不要水果摊，生成一张 + 角色提示词”，并强制补充“人物必须是站立姿态的全身图”。接口依据：[BytePlus ModelArk Image generation API](https://docs.byteplus.com/en/docs/ModelArk/1541523)、[Streaming Response](https://docs.byteplus.com/en/docs/ModelArk/1824137)、[Model list](https://docs.byteplus.com/en/docs/ModelArk/1330310)。

动画生产包生成后，剧情页保留两个供应商交付出口：

- 导出当前生产包 JSON：当前测试/规划包版本为 `3.0`。服务端校验当前 Variant → Full Story → Animation Plan revision 后写入 `productionLineage`、内容摘要和本机持久 HMAC 签名；被修改的文件、旧版文件或血缘不一致的文件不能导入。
- 复制动画生产包 Markdown：当前 `direct_shot` 输出角色/场景/资产参考和逐镜 `videoPrompt`、运镜、动作、声音、连续性、视频负面词及验收标准；旧 v2 才输出逐镜首帧／尾帧。

浏览器启动一次工作流时，服务端会在 `runtime/production-runs/` 建立轻量 Run，并在每个阶段成功后持久化 Artifact、revision、依赖摘要、Stage 状态和 Checkpoint。相同 JSON 仅键顺序变化不会制造新 revision；同一 Variant ID 的实际内容变化会确定性标记旧 Story、Plan 和媒体为 stale。刷新页面后可恢复最近 Run 的已完成 JSON 阶段，但不会持久化原始上传视频，也不会续接刷新前仍在供应商执行的请求。详见 [Production Lineage 与持久状态](docs/production-lineage-state.md)。

## 单镜头视频：首尾帧 / 全能参考

动画生产包的每个 shot 可以生成 1–4 个候选视频。页面“模型设置”中的“镜头视频”阶段可在 Kling、Seedance 和 MiniMax H3 之间切换；请求中的 `generationMode` 是模式权威字段，生成弹窗必须显式选择，不能根据缺失字段、provider、模型名或素材存在性自动推断或降级：

- `first_last_frame`：已选首帧和尾帧是精确端点，Kling、Seedance 与 MiniMax H3 均支持；无端点的 `direct_shot` 不可使用该模式，必须明确失败。
- `all_reference`：图片、视频和音频只是人物、场景、动作、运镜、节奏或声音参考，不被解释为精确首尾帧。Seedance 2.0 与 MiniMax H3 使用官方 R2V 角色 `reference_image`、`reference_video`、`reference_audio`；不得与 `first_frame` / `last_frame` 混用。

全能参考模式新增“把上个镜头内容作为普通参考图”开关，默认不勾选。勾选后，系统按当前 Animation Plan 的 `shotPlan[]` 顺序找到紧邻上一业务镜头，从当前 Run/Plan namespace 中读取它已选中的 current 视频候选，再由服务端 FFmpeg 每秒抽取一张 JPEG，作为 `reference_image` 与本镜头角色图、旧 v2 已选首尾帧和用户上传媒体一起发送。第一镜、上一镜未生成/已 stale、旧 Plan URL、非当前 namespace 文件都会明确失败；`S1` 是剧情场次而不是场地，`LOC01` 只是场景视觉参考组，即使两者相同也不承诺物理地点无缝连续。该开关只加强身份、画风和短时表演连续性，当前镜头的剧情动作、固定角色边界与目标场景仍优先；跨地点、跨时段或上一镜本身有漂移时应保持关闭。视频请求始终由服务端从当前 Plan 解析 exact shot；弹窗中的文本编辑只形成有回执的本次 `promptOverride`，不能伪造镜头动作、时长或场景。

全能参考必须至少包含合法图片或视频；共同限制为最多 9 张图片、3 段视频、3 段音频，单段视频或音频 2–15 秒，视频总时长与音频总时长分别不超过 15 秒，且不能只上传音频。上一镜实际抽帧也计入 9 图上限，超限不会静默丢图。服务端提交异步任务、轮询终态，并把 mp4 下载到 `public/generated-videos/<project>/<run>/<plan-revision>-<digest>/`。使用上一镜抽帧的后镜媒体还依赖上一镜 `shotVideo` 的精确 revision/digest；上一镜重生成或切换候选后，依赖它的后镜视频会递归 stale。文件名同时带 Plan revision/digest 前缀和随机请求 nonce；返回文件还会经过 ffprobe 可播放性验证。上一镜源视频与逐秒 JPEG 的 SHA-256 写入连续性回执，旧 Plan 的异步结果不会挂到新 Plan。

可灵 3.0 使用新版独立协议和 API Key：

```dotenv
KLING_V3_ENDPOINT=https://api-beijing.klingai.com/image-to-video/kling-3.0
KLING_V3_API_KEY=你的可灵新版 API Key
KLING_V3_AUDIO=native
KLING_VIDEO_RESOLUTION=720p
KLING_VIDEO_MULTI_SHOT=false
KLING_VIDEO_POLL_INTERVAL_MS=3000
KLING_VIDEO_POLL_TIMEOUT_MS=900000
```

应用把首帧和尾帧分别写入 `contents` 的 `first_frame` / `last_frame`，显式请求 `audio=native`，并通过 `GET /tasks?task_ids=...` 轮询 `submitted → processing → succeeded/failed`。3.0 的模型版本编码在 endpoint 中，请求不会发送 Legacy 的 `model_name`、`negative_prompt` 或 `aspect_ratio`。当前仓库只接入已验证的官方 image-to-video 协议；虽然 Kling VIDEO 3.0 Omni 产品支持多模态参考，但没有可验证的开发者 Omni endpoint/schema，因此页面会明确拒绝可灵的全能参考模式，不会静默退化为首尾帧。产品能力参考：[Kling VIDEO 3.0 Omni 用户指南](https://home.kling.ai/quickstart/klingai-video-3-omni-model-user-guide)。

Seedance 2.0 使用火山方舟内容生成任务：

```dotenv
SEEDANCE_VIDEO_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3
SEEDANCE_API_KEY=你的火山方舟 Ark API Key
SEEDANCE_VIDEO_MODEL=doubao-seedance-2-0-260128
SEEDANCE_VIDEO_RESOLUTION=720p
SEEDANCE_GENERATE_AUDIO=true
SEEDANCE_WATERMARK=false
SEEDANCE_VIDEO_POLL_INTERVAL_MS=3000
SEEDANCE_VIDEO_POLL_TIMEOUT_MS=900000
```

`SEEDANCE_API_KEY` 留空时会复用同一火山方舟账号的 `JIMENG_API_KEY`。可选模型包括 Standard `doubao-seedance-2-0-260128`、Fast `doubao-seedance-2-0-fast-260128` 和 Mini `doubao-seedance-2-0-mini-260615`。首尾帧模式使用 `first_frame` / `last_frame`；全能参考模式使用 `reference_image` / `reference_video` / `reference_audio`，二者不混用。默认 `generate_audio=true`；轮询把 `succeeded`、`failed`、`expired`、`cancelled` 全部视为终态，避免过期或取消后永久卡住。能力依据：[Seedance 2.0 官方发布](https://seed.bytedance.com/blog/seedance-2-0-official-launch)、[BytePlus ModelArk 视频生成 API](https://docs.byteplus.com/en/docs/modelark/1520757)。

MiniMax H3 使用官方 V2 多模态视频生成接口：

```dotenv
MINIMAX_VIDEO_ENDPOINT=https://api.minimaxi.com/v2/video_generation
MINIMAX_API_KEY=你的 MiniMax API Key
MINIMAX_VIDEO_MODEL=MiniMax-H3
MINIMAX_VIDEO_RESOLUTION=2K
MINIMAX_WATERMARK=false
MINIMAX_VIDEO_POLL_INTERVAL_MS=3000
MINIMAX_VIDEO_POLL_TIMEOUT_MS=900000
```

首尾帧模式把镜头提示词、首帧和尾帧分别写入 `content` 的 `text`、`first_frame`、`last_frame`；全能参考模式改用 `reference_image`、`reference_video`、`reference_audio`，并固定不混入端点角色。时长按官方允许的 4–15 秒归一；首尾帧保持 `ratio=adaptive`，全能参考模式按当前 Animation Plan 显式发送 `9:16` 或 `16:9`。服务端通过 `GET /v2/query/video_generation/{task_id}` 轮询 `queued/running → succeeded/failed/cancelled`，成功后下载 `task.content.url`。H3 不提供独立负面提示词字段；系统只会把高优先级角色身份冲突转换成正向身份锁定，其余负面条目在回执中明确标记为未下发。接口依据：[创建视频生成任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)、[查询任务](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-query)。

旧可灵 2.1 仍保持兼容：

```dotenv
VIDEO_HTTP_VIDEO_ENDPOINT=https://api-beijing.klingai.com
VIDEO_HTTP_VIDEO_MODEL=kling-v2-1
VIDEO_HTTP_PRESET=kling_image_to_video
VIDEO_HTTP_API_KEY=你的可灵 Legacy token
VIDEO_HTTP_POLL_INTERVAL_MS=3000
VIDEO_HTTP_POLL_TIMEOUT_MS=600000
```

旧 preset 会把首帧写入 `image`、尾帧写入 `image_tail`、动画镜头提示词写入 `prompt`，并将当前 shot 中已启用的 `negativePrompts.video` 编译到 `negative_prompt`。时长按 5 或 10 秒归一，使用首尾帧时默认 `mode=pro`。服务端回执为所有 provider 保留脱敏 `requestPreview`、实际 provider/model、是否请求音频和 `negativePromptDelivery`。

该内置链路只服务于页面内的单镜头试片。仓库已有本地轻量 Run/Artifact/Checkpoint 状态库，但仍不提供 JSONL 任务队列、批量执行器、本地视觉质检或 ffmpeg 成片合成；整片批量生成和后期由外部供应商程序负责。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：各导演阶段的提示词和结构化输出契约。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/qwen-client.js`：Qwen OpenAI 兼容多模态适配器。
- `src/deepseek-client.js`：DeepSeek-V4 OpenAI 兼容纯文本适配器。
- `src/character-boundary.js`：全局角色边界的上游摘要、签发和验签。
- `src/production-lineage.js`、`src/production-state-store.js`：确定性内容摘要、revision 依赖图、stale 传播、Run/Stage/Artifact/Checkpoint 持久化和 v3 测试包签发/导入。
- `src/character-feature-compiler.js`：把已签发的固定角色外观事实编译为动画静态帧侧车，不重新推断主角。
- `src/workflow.js`：完整创意工作流编排，以及“动画基础锁定 → 逐场次分批 shotPlan → 服务端合并”的动画生产包生成与验证。
- `src/shot-video-generator.js`：按显式模式将首尾帧或多模态参考、`videoPrompt` 和逐镜视频负面词路由到所选视频 provider；启用上一镜参考时，在临时目录用 FFmpeg 以 1 fps 抽图并作为普通 `reference_image` 合并校验。
- `src/shot-video-continuity.js`：从当前 Plan/Run/media namespace 安全解析紧邻上一镜的 current 视频候选，并签发后镜媒体所需的 source lineage 回执。
- `src/shot-video-providers.js`：Kling / Seedance / MiniMax 模型白名单、模式能力、默认选择及互相隔离的运行配置。
- `workers/generic-http-worker.mjs`：Kling、Seedance 与 MiniMax 的首尾帧/R2V 请求体、异步轮询、产物下载和脱敏回执。
- `src/mock.js`：未配置模型时的演示结果。
- `docs/workflow-spec.md`：产品原则、字段要求和验收标准。
- `docs/production-lineage-state.md`：生产状态的事实来源、依赖、媒体命名空间、恢复与导入边界。
- `test/`：工作流和核心叙事约束测试。

本地测试包回放可显式配置 `WORKFLOW_RUNTIME_ENVIRONMENT=test` 与 `WORKFLOW_SIGNATURE_POLICY=test_package_unverified`。该模式允许服务重启后继续使用原测试包中的角色边界，但仍严格校验 `sourceDigest` 和 `boundaryDigest`；生产及其他环境始终强制校验签名。

## 验证

```bash
npm test
```

## 用本地视频跑完整链路

安装 `ffmpeg` 后，可以不经过浏览器上传，直接用本地参考视频跑完整创意链路并导出 JSON：

```bash
npm run run:video -- ./reference.mp4 \
  --character "阿岚，社区修理师" \
  --vertical "家电维修" \
  --constraints "60 秒内，中文短剧节奏" \
  --count 3 \
  --require-mimo
```

`--require-mimo` 会强制确认 `MIMO_BASE_URL` 可达且指定模型已加载；不加该参数时，未配置 MiMo 会走演示模式。命令会优先按 `.env` 的 `MIMO_MEDIA_MODE` 携带原生视频，超过 `MIMO_NATIVE_VIDEO_MAX_MB` 或配置为 `frames` 时只发送关键帧。

产品约束和当前技术边界见 [工作流规范](docs/workflow-spec.md)。
