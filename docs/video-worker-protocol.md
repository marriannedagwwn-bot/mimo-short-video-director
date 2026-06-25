# 视频生成 Worker 协议

`exec:video --provider command` 会把每个 ready 任务交给外部 worker。worker 不需要理解上游剧情，只需要处理一份标准 request JSON，并把产物写到指定路径。

## 调用方式

```bash
npm run exec:video -- ./production/V1 \
  --provider command \
  --command node \
  --command-arg ./workers/generic-http-worker.mjs \
  --all
```

执行器会自动追加：

```bash
--request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>
```

同时注入环境变量：

- `VIDEO_TASK_REQUEST`
- `VIDEO_TASK_OUTPUT`
- `VIDEO_TASK_RECEIPT`
- `VIDEO_TASK_ROOT`
- `VIDEO_TASK_ID`
- `VIDEO_TASK_CAPABILITY`

## Request 结构

核心字段：

- `taskId`：任务 ID。
- `capability`：能力类型。
- `prompt` / `negativePrompt`：正负向提示词。
- `inputArtifacts[]`：依赖产物路径。
- `outputPath`：建议输出路径。
- `parameters`：时长、画幅、镜头运动、字幕、声音等结构化参数。
- `acceptanceCriteria[]`：验收标准。

当前能力类型：

- `image_generation`：角色参考图、资产图、首帧、尾帧。
- `first_last_frame_video_generation`：用首帧和尾帧生成视频片段。
- `video_quality_review`：检查视频片段是否通过。
- `video_assembly`：把片段合成最终短片。

## Worker 必须做什么

1. 读取 `--request`。
2. 根据 `request.capability` 调用对应供应商 API 或本地工具。
3. 把最终产物写入 `--output`。
4. 可选：把供应商任务 ID、耗时、模型名、原始响应摘要写入 `--receipt`。

只要 `--output` 是非空文件，主执行器就会在下一轮自动把该任务标记为 `done`，并释放依赖它的后续任务。

## 失败处理

如果 worker 退出非 0，或没有生成非空 `--output`，主执行器会写入：

```text
<output>.error.json
```

该失败回执会让任务在后续状态刷新中显示为 `failed`，依赖它的后续任务保持 `blocked`。如果希望一个任务失败后继续执行其它互不依赖的 ready 任务，可以使用：

```bash
npm run exec:video -- ./production/V1 --provider command --command node --command-arg ./workers/generic-http-worker.mjs --all --continue-on-error
```

修复失败后，可以直接使用：

```bash
npm run exec:video -- ./production/V1 --provider command --command node --command-arg ./workers/generic-http-worker.mjs --all --retry-failed
```

`--retry-failed` 会先删除匹配任务的 `.error.json`，再重新计算 ready 任务并执行。也可以手动删除对应的 `.error.json`，或者把正确产物放到 `--output` 对应路径后再运行 `plan:video --scan-existing`。

## 接真实视频模型时的建议

- 默认可先使用 `workers/generic-http-worker.mjs`，它支持：
  - 按 `capability` 配置不同 endpoint；
  - 将依赖图片/视频小文件内联为 data URL；
  - 提交 JSON 请求；
  - 从响应里提取 `mediaUrl` / `video_url` / `b64_json` / `base64` 等常见产物字段；
  - 通过 `pollEndpointTemplate` 轮询异步任务；
  - 下载最终 URL 或解码 base64 到 `--output`。
  - 下载 `mediaUrl` 时默认不转发 API Key；如果供应商下载接口也要求鉴权，可在配置里设置 `authOnDownload: true`。
- 最小环境变量：

```bash
VIDEO_HTTP_IMAGE_ENDPOINT=https://provider.example.com/v1/images
VIDEO_HTTP_VIDEO_ENDPOINT=https://provider.example.com/v1/videos
VIDEO_HTTP_API_KEY=你的_key
```

- 如果供应商字段不同，复制 `workers/generic-http-worker.example.json`，用 `bodyTemplates` 做字段映射，然后执行：

```bash
npm run exec:video -- ./production/V1 \
  --provider command \
  --command node \
  --command-arg ./workers/generic-http-worker.mjs \
  --command-arg=--config \
  --command-arg=./workers/generic-http-worker.example.json \
  --all
```

- 图像生成任务优先保证角色、服装、道具一致，不要过度追求画面复杂度。
- 首尾帧视频任务必须使用 `inputArtifacts` 中的 start/end 两张图；不要让模型重新发明镜头起点和终点。
- 每个视频片段建议先生成多个候选，但 worker 最终只把被选中的候选写到 `--output`。
- 质检任务可以先人工确认，也可以接视觉模型；失败时不要写 `--output`，保留 blocked/ready 状态供人工处理或重试策略处理。
- 最终剪辑任务应按 request 中的依赖视频顺序合成，并保留字幕、音乐音效和结尾停顿要求。
