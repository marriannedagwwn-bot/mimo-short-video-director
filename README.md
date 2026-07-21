# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 启动

要求 Node.js 20 或更高版本，无第三方依赖。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，完整创意流程仍可运行，但结果不是对视频的真实判断。

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

配置 `QWEN_API_KEY` 后，只要 Qwen 可用，参考片分析、脚本还原、创意简报、视觉规则、主题变体、完整剧情、动画生产包和人物参考修正默认都会调用 Qwen 对应阶段模型；未配置 Qwen 时自动回退为 MiMo。`qwen3.7-max` 是纯文本阶段的默认选择；会传入视频或图片的参考片分析、脚本还原、视觉规则和人物参考修正默认使用 `qwen3.7-plus`，也可以改成账号可用的 Qwen-VL / Qwen-Omni 模型。页面顶部“模型设置”按钮可以按阶段临时切换 provider 和模型名，覆盖值会随之后所有生成请求发送给后端，也会写入导出的生产包。角色和首尾帧图片仍由已配置的即梦图片服务生成；选中首尾帧后可在页面调用可灵 AI 生成单镜头候选视频。

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

- 导出当前生产包 JSON：保留完整剧情、主题变体、`animationPlan`、模型信息和已选首尾帧图片，供外部程序读取。
- 复制动画生产包 Markdown：输出 Markdown 格式的角色参考、场景参考、资产提示词和逐镜首帧／尾帧／`videoPrompt`，可直接粘贴到供应商程序。

## 单镜头首尾帧 → 可灵 AI

动画生产包的每个 shot 可以使用已选首帧和尾帧生成 1–4 个候选视频。服务端调用可灵 `image2video` 任务接口，自动轮询结果，将 mp4 保存到 `public/generated-videos/` 并在页面播放。

最小配置：

```dotenv
VIDEO_HTTP_VIDEO_ENDPOINT=https://api-beijing.klingai.com
VIDEO_HTTP_VIDEO_MODEL=kling-v2-1
VIDEO_HTTP_PRESET=kling_image_to_video
VIDEO_HTTP_API_KEY=你的可灵 API Key
VIDEO_HTTP_POLL_INTERVAL_MS=3000
VIDEO_HTTP_POLL_TIMEOUT_MS=600000
```

可灵 preset 会把首帧写入 `image`、尾帧写入 `image_tail`、动画镜头提示词写入 `prompt`，并将当前 shot 中已启用的 `negativePrompts.video` 编译到 `negative_prompt`。时长会按可灵支持的 5 或 10 秒归一，使用首尾帧时默认 `mode=pro`。服务端回执保留脱敏 `requestPreview` 和 `negativePromptDelivery`，用于证明负面词确实进入可灵请求。

该内置链路只服务于页面内的单镜头试片。仓库仍不提供 JSONL 任务队列、production workspace、批量执行器、本地质检或 ffmpeg 成片合成；整片批量生成和后期由外部供应商程序负责。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：各导演阶段的提示词和结构化输出契约。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/workflow.js`：完整创意工作流编排，以及“动画基础锁定 → 逐场次分批 shotPlan → 服务端合并”的动画生产包生成与验证。
- `src/shot-video-generator.js`：将当前 shot 的已选首尾帧、`videoPrompt` 和逐镜视频负面词交给可灵。
- `workers/generic-http-worker.mjs`：单镜头视频请求、可灵 preset、异步轮询、产物下载和脱敏回执。
- `src/mock.js`：未配置模型时的演示结果。
- `docs/workflow-spec.md`：产品原则、字段要求和验收标准。
- `test/`：工作流和核心叙事约束测试。

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
