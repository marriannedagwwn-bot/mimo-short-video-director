# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 启动

要求 Node.js 20 或更高版本，无第三方依赖。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，完整四阶段流程仍可运行，但结果不是对视频的真实判断。

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
QWEN_MEDIA_MODE=auto
QWEN_NATIVE_VIDEO_MAX_MB=7
QWEN_VIDEO_FPS=2
QWEN_ENABLE_THINKING=false
```

配置 `QWEN_API_KEY` 后，只要 Qwen 可用，参考片分析、脚本还原、创意简报、视觉规则、主题变体、完整剧情、动画生产包和人物参考修正默认都会调用 Qwen 对应阶段模型；未配置 Qwen 时自动回退为 MiMo。`qwen3.7-max` 是纯文本阶段的默认选择；会传入视频或图片的参考片分析、脚本还原、视觉规则和人物参考修正默认使用 `qwen3.7-plus`，也可以改成账号可用的 Qwen-VL / Qwen-Omni 模型。页面顶部“模型设置”按钮可以按阶段临时切换 provider 和模型名，覆盖值会随之后所有生成请求发送给后端，也会写入导出的生产包。LLM 阶段支持在 Qwen / MiMo 间切换；图片生成和首尾帧视频生成固定使用已配置的即梦 / HTTP 视频供应商，但可以在同一个面板里临时改模型名。

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

动画生产包生成后，剧情页提供两个执行出口：

- 导出当前生产包 JSON：保留完整剧情、主题变体、动画生产包和模型信息，适合进入后续自动化队列。
- 复制视频模型生产包：输出 Markdown 格式的角色参考、场景参考、资产提示词和逐镜首帧/尾帧/video prompt，适合手动粘贴到支持首尾帧或关键帧的视频生成工具。
- 导出视频任务队列 JSONL：把动画计划拆成逐行任务，包括角色参考图、场景参考图、资产图、首帧、尾帧、首尾帧视频、质检和最终剪辑任务，适合后续脚本或视频 API worker 消费。最终剪辑任务会依赖所有逐镜视频输出和质检结果，并携带剪辑节奏、字幕、音乐音效和整片验收标准。

如果只想在页面里快速试单个镜头，动画生产包的每个 shot 卡片都有“生成此镜头视频”按钮。点击后会打开视频生成弹窗：左侧锁定已经选中的首帧/尾帧参考图，右侧展示可编辑的视频 prompt，并可一次生成 1–4 条候选视频。生成时会把两张关键帧、编辑后的 `videoPrompt`、负面 prompt、模型设置里的首尾帧视频模型名和结构化参数发送给通用 HTTP 视频 worker，并把结果保存到 `public/generated-videos/` 后在页面内播放。使用前至少配置：

```dotenv
VIDEO_HTTP_IMAGE_ENDPOINT=https://provider.example.com/v1/images
VIDEO_HTTP_VIDEO_ENDPOINT=https://provider.example.com/v1/videos
VIDEO_HTTP_VIDEO_MODEL=供应商的视频模型名
VIDEO_HTTP_API_KEY=你的_key
```

如果供应商需要特殊字段，继续使用 `VIDEO_HTTP_CONFIG=./provider.json` 配置 `bodyTemplates.image_generation` 和 `bodyTemplates.first_last_frame_video_generation`。如果视频接口是“提交任务 → 返回 task id → 轮询结果”的异步模式，还需要配置 `pollEndpointTemplate` 或环境变量 `VIDEO_HTTP_POLL_ENDPOINT_TEMPLATE`。worker 现在不会再把 `ok`、`success` 这类纯文本确认当成 mp4；必须拿到 `videoUrl/mediaUrl`、base64 视频或可下载的二进制视频文件才算成功。

如果你的视频后端是火山方舟 ModelArk / 即梦（Dreamina）这类内容生成任务接口，可以直接使用内置 preset，而不必手写 `bodyTemplates`：

```dotenv
VIDEO_HTTP_VIDEO_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3
VIDEO_HTTP_VIDEO_MODEL=你的即梦/Seedance 视频模型 ID
VIDEO_HTTP_PRESET=modelark_content_generation
VIDEO_HTTP_API_KEY=你的 Ark API Key
VIDEO_HTTP_POLL_INTERVAL_MS=3000
VIDEO_HTTP_POLL_TIMEOUT_MS=600000
VIDEO_HTTP_VIDEO_RESOLUTION=720p
VIDEO_HTTP_GENERATE_AUDIO=0
```

该 preset 会把首帧/尾帧图片组装成 `content=[text, image_url(first_frame), image_url(last_frame)]`，提交到 `/contents/generations/tasks`，再用返回的任务 `id` 自动轮询，直到拿到 `content.video_url` 后保存为本地 mp4。

如果视频后端是 Kling，可使用内置 `kling_image_to_video` preset。`VIDEO_HTTP_VIDEO_ENDPOINT` 可以填根域名、`/v1`、`/v1/videos` 或完整 `/v1/videos/image2video`，worker 会自动归一到图生视频提交接口，并用返回的 `data.task_id` 轮询到 `data.task_result.videos[0].url`：

```dotenv
VIDEO_HTTP_VIDEO_ENDPOINT=https://api-beijing.klingai.com
VIDEO_HTTP_VIDEO_MODEL=kling-v2-1
VIDEO_HTTP_PRESET=kling_image_to_video
VIDEO_HTTP_API_KEY=你的 Kling API Key
VIDEO_HTTP_POLL_INTERVAL_MS=3000
VIDEO_HTTP_POLL_TIMEOUT_MS=600000
```

该 preset 会把首帧作为 `image`、尾帧作为 `image_tail`，并移除 `data:image/...;base64,` 前缀。使用首尾帧时默认 `mode=pro`，时长会按 Kling 支持的 5 或 10 秒归一；如果账号支持的模型名不同，只需要改 `VIDEO_HTTP_VIDEO_MODEL`。需要强制时长或模式时，可额外配置 `VIDEO_HTTP_VIDEO_DURATION` / `VIDEO_HTTP_VIDEO_MODE`。

导出生产包或 JSONL 队列后，可以先生成一份本地生产运行状态，用来确认哪些任务现在可执行、哪些被依赖阻塞、每个产物建议存放在哪里：

```bash
npm run plan:video -- ./视频任务队列.jsonl \
  --out ./production/V1/production-run.json \
  --root ./production/V1
```

如果要直接进入制作，可以加 `--workspace` 生成完整生产工作区：`README.md`、`production-run.json`、每个任务的 Markdown prompt 卡、供应商无关 request JSON，以及按任务类型分好的输出目录。

```bash
npm run plan:video -- ./视频任务队列.jsonl \
  --root ./production/V1 \
  --workspace
```

如果已经手动完成了某些产物，可以把它们标记为完成，运行状态会自动释放下一批任务：

```bash
npm run plan:video -- ./视频任务队列.jsonl \
  --root ./production/V1 \
  --workspace \
  --scan-existing
```

`--scan-existing` 会扫描 `outputs/` 下已经存在的非空产物文件，并按队列依赖自动把对应任务标记为 `done`。如果产物不在建议目录，也可以手动指定：

```bash
npm run plan:video -- ./视频任务队列.jsonl \
  --done references.阿岚 \
  --artifact assets.旧设备=./production/V1/outputs/asset_image/old_device.png
```

也可以用本地执行器跑 ready 任务。当前内置 `mock` provider，只用于验证工作区依赖链和文件流转，不会生成真实图片或视频：

```bash
npm run exec:video -- ./production/V1 --provider mock --all
```

`mock` 会为每个 ready request 写入占位产物和 `.mock.json` 回执。真实图像/视频模型接入时，会复用同一个 `requests/`、`outputs/` 和 `production-run.json` 约定。

如果准备切到真实图像/视频 API，先做一次预检。它会阻止常见错误：把 mock/占位产物当成真实素材、ready 任务吃到 mock 首尾帧、generic HTTP worker 缺 endpoint 或 key。

```bash
npm run preflight:video -- ./production/V1 --strict
```

预检通过后，可以用一条命令串起图像生成、首尾帧视频生成、本地质检和 ffmpeg 最终合成：

```bash
npm run make:video -- ./production/V1 --config ./provider.json
```

`provider.json` 可从 [workers/generic-http-worker.example.json](workers/generic-http-worker.example.json) 复制后改成真实供应商 endpoint 和字段映射。最终剪辑依赖本机 `ffmpeg`；如果不在 PATH 中，可加 `--ffmpeg /path/to/ffmpeg`。

如果你已经有自己的图像/视频 API 脚本，可以用 `command` provider 接入。执行器会为每个 ready 任务调用外部命令。

项目内置了一个通用 HTTP worker，可通过环境变量或 JSON 配置接入常见“提交任务 → 轮询 → 下载 mediaUrl/base64 产物”的图像/首尾帧视频 API：

```bash
VIDEO_HTTP_IMAGE_ENDPOINT=https://provider.example.com/v1/images \
VIDEO_HTTP_VIDEO_ENDPOINT=https://provider.example.com/v1/videos \
VIDEO_HTTP_API_KEY=你的_key \
npm run exec:video -- ./production/V1 \
  --provider command \
  --command node \
  --command-arg ./workers/generic-http-worker.mjs \
  --all \
  --capability image_generation \
  --capability first_last_frame_video_generation
```

外部命令会收到 `--request <request.json>`、`--output <target-file>`、`--receipt <receipt.json>`、`--root <production-root>`，也会收到 `VIDEO_TASK_*` 环境变量。只要脚本把产物写到 `--output`，执行器就会自动刷新状态并释放后续任务。

如果供应商字段和默认 JSON 不一致，可以复制 [workers/generic-http-worker.example.json](workers/generic-http-worker.example.json)，通过 `bodyTemplates` 映射字段：

```bash
npm run exec:video -- ./production/V1 \
  --provider command \
  --command node \
  --command-arg ./workers/generic-http-worker.mjs \
  --command-arg=--config \
  --command-arg=./workers/generic-http-worker.example.json \
  --all \
  --capability image_generation \
  --capability first_last_frame_video_generation
```

渲染负面提示词只来自当前 `shot.negativePrompts.image/video`；每个条目必须携带 `triggerEvidence`、`reasonCode`、`priority` 和媒介范围，数组可以为空。worker 回执通过 `negativePromptDelivery.appliedMode` 区分原生字段 `native_negative`、改写为正向身份锁定 `positive_constraint` 和不支持 `not_supported`，并附带脱敏 `requestPreview`。完整契约见 [docs/workflow-spec.md](docs/workflow-spec.md)，猫娘案例与供应商请求快照见 [docs/negative-prompt-refactor-examples.md](docs/negative-prompt-refactor-examples.md)。

视频片段生成完成后，推荐用本地后处理 worker 做基础质检和最终剪辑。最终剪辑依赖本机 `ffmpeg`：

```bash
npm run exec:video -- ./production/V1 \
  --provider command \
  --command node \
  --command-arg ./workers/local-postprocess-worker.mjs \
  --all \
  --capability video_quality_review \
  --capability video_assembly
```

如果 worker 失败，执行器会写入 `<output>.error.json` 失败回执，并在下一次刷新时把任务标记为 `failed`。需要不中断其它 ready 任务时可加：

```bash
npm run exec:video -- ./production/V1 --provider command --command node --command-arg ./workers/generic-http-worker.mjs --all --continue-on-error --capability image_generation --capability first_last_frame_video_generation
```

修复 worker 或供应商问题后，可以直接重试 failed 任务：

```bash
npm run exec:video -- ./production/V1 --provider command --command node --command-arg ./workers/generic-http-worker.mjs --all --retry-failed --capability image_generation --capability first_last_frame_video_generation
npm run exec:video -- ./production/V1 --provider command --command node --command-arg ./workers/local-postprocess-worker.mjs --all --retry-failed --capability video_quality_review --capability video_assembly
```

查看当前生产状态报告：

```bash
npm run report:video -- ./production/V1
```

报告会列出总进度、ready/blocked/failed 任务、失败原因、最终成片路径和下一步建议命令；加 `--json` 可输出机器可读报告。建议命令会优先提示先跑 `preflight:video`，再执行真实 worker。

通用 HTTP worker 见 [workers/generic-http-worker.mjs](workers/generic-http-worker.mjs)，本地后处理 worker 见 [workers/local-postprocess-worker.mjs](workers/local-postprocess-worker.mjs)，占位模板见 [workers/command-worker-template.mjs](workers/command-worker-template.mjs)，协议说明见 [docs/video-worker-protocol.md](docs/video-worker-protocol.md)。

当前尚未绑定某一家具体视频生成供应商。若供应商 API 是非标准字段，优先用通用 worker 的 `bodyTemplates` 适配；如果还需要上传文件、候选筛选或专用鉴权，再新增专用 worker。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：四阶段导演提示词和结构化输出契约。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/workflow.js`：四阶段编排、选中主题后的完整剧情生成，以及“动画基础锁定 → 逐场次分批 shotPlan → 服务端合并”的动画生产包生成与验证。
- `src/mock.js`：未配置模型时的演示结果。
- `docs/workflow-spec.md`：产品原则、字段要求和验收标准。
- `test/`：工作流和核心叙事约束测试。

## 验证

```bash
npm test
```

## 用本地视频跑完整链路

安装 `ffmpeg` 后，可以不经过浏览器上传，直接用本地参考视频跑四阶段工作流并导出 JSON：

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
