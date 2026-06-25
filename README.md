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

连接成功后，页面右上角会显示“MiMo 已连接”。

`MIMO_MEDIA_MODE=auto` 会优先通过 `video_url` 发送原生视频；请求中会按 MiMo V2.5 文档携带 `fps` 与 `media_resolution`，默认 `MIMO_VIDEO_FPS=2`、`MIMO_VIDEO_MEDIA_RESOLUTION=default`。若服务返回不支持媒体类型的 400/415/422，再自动回退为带时间戳关键帧。超过 `MIMO_NATIVE_VIDEO_MAX_MB` 的视频直接使用关键帧，避免 base64 请求占用过多内存。

当前分析/拆解/简报/主题变体请求参数默认为 `temperature=0.3`、`top_p=0.95`、`max_completion_tokens=8192`、`thinking=disabled`、`stream=false`。用户选中某个主题变体后，完整剧情页会单独调用 `MIMO_STORY_MODEL`，默认 `mimo-v2.5-pro`，并使用 `MIMO_STORY_MAX_COMPLETION_TOKENS=12288` 给分场剧情留出更长输出空间。完整剧情生成后，可以继续调用 `MIMO_ANIMATION_MODEL`，默认同样为 `mimo-v2.5-pro`，生成首尾帧 AI 视频生产包：视觉圣经、角色参考、资产提示词、每个短镜头的首帧 prompt、尾帧 prompt、视频 prompt、负面 prompt 和验收标准。接口依据：[MiMo V2.5 模型说明](https://mimo.mi.com/docs/en-US/product/introduction/models#MiMo-V25)、[MiMo OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api) 和 [MiMo 视频理解文档](https://mimo.mi.com/docs/en-US/use-cases/video-understanding)。

动画生产包生成后，剧情页提供两个执行出口：

- 导出当前生产包 JSON：保留完整剧情、主题变体、动画生产包和模型信息，适合进入后续自动化队列。
- 复制视频模型生产包：输出 Markdown 格式的角色参考、资产提示词和逐镜首帧/尾帧/video prompt，适合手动粘贴到支持首尾帧或关键帧的视频生成工具。
- 导出视频任务队列 JSONL：把动画计划拆成逐行任务，包括参考图、资产图、首帧、尾帧、首尾帧视频、质检和最终剪辑任务，适合后续脚本或视频 API worker 消费。最终剪辑任务会依赖所有逐镜视频输出和质检结果，并携带剪辑节奏、字幕、音乐音效和整片验收标准。

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

当前尚未绑定具体视频生成供应商。下一步若要自动生成视频，需要确定视频模型 API、首尾帧图片生成方式、任务轮询、候选视频存储和质检/重试策略。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：四阶段导演提示词和结构化输出契约。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/workflow.js`：四阶段编排、选中主题后的完整剧情生成、动画生产包生成与输入验证。
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
