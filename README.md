# 母题导演台

一个可运行的 AI 短视频受控改编 MVP：上传参考视频，先识别它为什么好看，再保留定位、受众、情绪内核、剧情驱动力和高价值桥段，为固定角色与垂直赛道生成新的具体故事。

## 启动

要求 Node.js 20 或更高版本，无第三方依赖。

```bash
npm start
```

打开 <http://localhost:4173>。未配置模型时会显示“演示模式”，完整四阶段流程仍可运行，但结果不是对视频的真实判断。

## 接入 MiMo-VL

MiMo-VL 是开源视觉语言模型，可通过 vLLM 等服务暴露 OpenAI 兼容接口。复制环境变量文件：

在具备可用 GPU 的模型服务器上，一种最小启动方式是：

```bash
vllm serve XiaomiMiMo/MiMo-VL-7B-RL-2508 --host 0.0.0.0 --port 8000
```

先确认模型服务可访问：

```bash
curl http://127.0.0.1:8000/v1/models
```

然后在本项目中复制环境变量文件：

```bash
cp .env.example .env
```

至少配置：

```dotenv
MIMO_BASE_URL=http://127.0.0.1:8000/v1
MIMO_MODEL=XiaomiMiMo/MiMo-VL-7B-RL-2508
MIMO_MEDIA_MODE=auto
```

如果推理服务要求鉴权，再设置 `MIMO_API_KEY`。连接成功后，页面右上角会显示“MiMo 已连接”。

`MIMO_MEDIA_MODE=auto` 会优先通过 `video_url` 发送原生视频；若服务返回不支持媒体类型的 400/415/422，再自动回退为带时间戳关键帧。超过 `MIMO_NATIVE_VIDEO_MAX_MB` 的视频直接使用关键帧，避免 base64 请求占用过多内存。

接口依据：[MiMo-VL 官方仓库](https://github.com/XiaomiMiMo/MiMo-VL)说明其与 `Qwen2_5_VLForConditionalGeneration` 架构兼容；[vLLM 多模态输入文档](https://docs.vllm.ai/en/latest/features/multimodal_inputs/)定义了 OpenAI 兼容接口的 `video_url` 与 base64 视频格式。

## 结构

- `public/`：上传、浏览器抽帧、角色配置、结果展示与 JSON 导出。
- `src/prompts.js`：四阶段导演提示词和结构化输出契约。
- `src/mimo-client.js`：MiMo OpenAI 兼容适配器。
- `src/workflow.js`：四阶段编排与输入验证。
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
