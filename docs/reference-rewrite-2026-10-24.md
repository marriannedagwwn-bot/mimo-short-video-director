# 参考片仿写（2026-10-24）

> 状态：代码、自动化测试（新增 36 个，全量 1764 个通过）、真实回放（第 6 节）与页面实测（第 7 节）都已完成，未提交。分支 `feat/reference-rewrite`（基于 `feat/storyboard-full-series` 的 1b9a181）。

## 1. 为什么要有这一步

10-23 用户让 Claude Code 看《总有人会给你撑伞》（咕嘎，51 秒）写「如果写一个类似的故事，你会怎么写剧本」。Claude Code 的做法：每秒 2 帧抽帧拼成接触表看画面；用本机 Bandit v2 Multi 把音轨分成人声、音乐、音效，再用 whisper 转写；写出「原片拆解（概要、台词表、好看在哪）＋四篇类似剧本」。用户认可这份稿子，要求在工作流里复现，模型用 Claude API。

对照实验（`reports/reference-rewrite-ab-2026-10-23/`，在 worktree `story-script-audio-processing-f1b013`，未提交；对照文档在外层 `总有人会给你撑伞-复现对照.md`）把同一份资料交给两家模型，各跑两层（只给原始资料 / 另给 Claude Code 的原片拆解），每组 1 次：

- **Claude Opus 5.5（effort xhigh）能复现**：原片读对了（还看出 Claude Code 漏掉的片尾水彩淡出），四篇写法同一个路数；约 $1、9 分钟一次。
- **MiMo v2.6 pro 只复现了格式**：第一层读错了「阿姨怎么放行」「伞在哪句话之后到」；第二层把拆解当模板，四篇都是原片事件链换皮。

所以这一步默认 Claude Opus 5.5、effort xhigh，不跟随 `DEFAULT_LLM_PROVIDER`。

## 2. 用户看到的流程

1. 「从参考视频开始」上传参考视频、填好固定角色与赛道，点右侧的「参考片仿写：写四篇类似剧本」。确认框写明模型、约 12 分钟、约 1 美元。
2. 服务端后台任务分四步：抽帧 → 去配乐 → 转写台词 → 写四稿（写稿时显示「推理中（已推理 N 字）」）。没有 Run 时先照「启动 AI 导演」的写法建一个参考视频 Run；之后点 AI 导演会接着用同一个 Run。
3. 结果面板：原片拆解（概要、台词表、好看在哪）＋四张稿件卡（标题、方向、概要，展开看剧本）。刷新后从 Run 读回；任务还在跑时刷新会重新接管。面板上「下载四稿（Markdown）」是用户主动导出。
4. 某一稿点「用这一稿开拍」：确认框说明切过去会删掉当前 Run（含四稿）、参考视频副本会在开始拆镜头时删掉，要留着先下载。确认后切到「从剧情开始 · 粘贴完整故事」，把「标题＋剧本」填进输入框；输入框上方列出四稿，可以「换成这一稿」（改过字时先问）。四稿只在页面内存里，刷新即清。
5. 用户看过、改好字，点现有的「开始拆镜头」，之后的可翻拍镜头、4.0 分镜、角色参考图、镜头视频全部沿用现有流程。剧情原文由浏览器在开 Run 时送来，与用户自己粘贴完全相同，`storySource` 的写入点没有增加。

模型设置里多一栏「参考片仿写」，只列 Claude 与 MiMo；effort 页面不能改。导演助手不加这一步。

## 3. 契约（五个面）

| 契约 | 生产者 | 消费者 | 校验器 | 提示词 | 测试 |
| --- | --- | --- | --- | --- | --- |
| 任务 `referenceRewrite`（只在参考视频 Run 上） | `server.js` `referenceRewriteTaskDefinition`：创建前查视频 Run（否则 409 `TASK_ENTRY_MODE_MISMATCH`）、绑着页面工作区且副本在（`TASK_SOURCE_MEDIA_REQUIRED`）、固定角色与赛道、本机工具齐全（`REFERENCE_REWRITE_TOOLS_UNAVAILABLE`）、`targetDurationSeconds` 20–180 | 页面 `runReferenceRewrite` / `attachRestoredReferenceRewrite` | — | — | `test/reference-rewrite-http.test.js` |
| 本机素材 | `src/reference-rewrite-materials.js`：副本 O_NOFOLLOW 复制到 Run 的 `media-work/` 并核对 SHA-256；ffprobe（>180 秒拒绝）；每秒 2 帧（>120 秒改 1 帧）拼 6×4 接触表；Bandit 三轨（`tools/reference-audio-stems.py`）；whisper 三组转写（原声、人声轨、原声减音乐，按词对时间）加有声区间 | `workflow.createReferenceRewrite` | 每个子进程超时＋SIGKILL；每步前复核页面工作区还活着；临时目录用完即删 | — | `test/reference-rewrite-materials.test.js` |
| 模型输出 `reference_rewrite/1.0` | `workflow.createReferenceRewrite`（coordinator，最多 2 次调用，重试只发诊断） | Artifact `referenceRewrite`；页面结果面板 | `src/reference-rewrite.js` `ensureReferenceRewriteContract`：只查形状——键齐全、非空、恰好 4 篇、标题不重复、「标题＋剧本」≤5000 字（与剧情原文同一个上限，保证选中后一定能开 Run） | `src/reference-rewrite-prompts.js`（golden 锁定） | `test/reference-rewrite-contract.test.js`、`test/reference-rewrite-workflow.test.js` |
| Claude 收图 | `src/claude-client.js` `buildClaudeRequestBody` 的 `frames` → `[image…, text]`；`overrides.effort` 优先于全局 | 只有参考片仿写传 `frames` | data URL 只收 jpeg/png/gif/webp 的 base64，否则 `MODEL_MEDIA_INVALID`；不传 frames 时请求体逐字不变 | — | `test/claude-client.test.js` |
| 选中一稿 | 页面 `useReferenceRewriteDraft`：`referenceRewriteDraftStoryText` 填粘贴框 | 现有「开始拆镜头」 | 现有 `normalizeStorySource` 与主角名检查 | — | `test/reference-rewrite-ui.test.js` |

Artifact `referenceRewrite` 的内容：`schemaVersion`、`original`、`drafts`、`transcript`（转写稿原文）、`materials`（时长、帧率、张数、分轨器、whisper 模型、有无音轨、时长目标）、`model`（provider、model、effort、调用次数、被拦次数）。接触表图片不入库；Task Store 照旧不存提示词与图片。没有 Artifact 依赖（参考视频不是 Artifact）。

## 4. 提示词与输出

来源是对照实验的 `materials/prompt.md`，写稿要求 8 条逐字沿用，只改四处：

1. 接触表说明按实际张数与帧率生成，最后一张不满时写明「只有前 N 格有画面」；
2. 第 4 条从写死「咕嘎」改成用「设定创作宇宙」的固定角色、赛道与创作限制（「开场 3 秒内带着声音和大动作出场」保留）；
3. 时长窗口取剧情时长目标（`storyDurationWindow`，默认与原片对齐）；
4. 输出从 Markdown 改成 JSON（用户 10-24 选定）：Claude 用 `claudeResponseSchema` 结构化输出（不用 minLength / maxItems，条数由校验器管），MiMo 用约束解码 Schema（锁 4 篇、非空）。

实验里手挑的两张关键帧放大图、手截复核的那组转写无法自动化，去掉了。转写时 whisper 的提示词不再写「咕嘎」（实验里写了），参考片的主角不一定是咕嘎。

## 5. 本机依赖

```bash
REFERENCE_REWRITE_BANDIT_DIR=/Volumes/MacOS/AI/Bandit-v2-Multi
REFERENCE_REWRITE_WHISPER_BIN=~/.local/bin/whisper
# 可选，写出来的是默认值
# REFERENCE_REWRITE_WHISPER_MODEL=small
# REFERENCE_REWRITE_WHISPER_MODEL_DIR=~/.cache/whisper
```

- 都不设，或外置盘没挂上、模型文件不在，`/api/health` 的 `referenceRewrite.reason` 逐项写明缺什么，按钮不能点、建任务 409。**不回退到不去配乐的转写**，也**不让 whisper 自己下载模型**（`--model_dir` 指定目录、先查文件在不在）。
- ffmpeg / ffprobe 从 PATH 找。Bandit 用它自带的 `.venv/bin/python -I`，先核对 checkpoint 的 SHA-256；只读地 import 安装目录，不改它。有 MPS 用 MPS，没有用 CPU。
- 演示模式（没配任何模型）不跑本机工具，用一张占位图和固定的四篇占位稿，能免费走完整个流程。

## 6. 真实回放（2026-10-24）

`scripts/reference-rewrite-replay.mjs` 直接用服务端的素材模块与 `workflow.createReferenceRewrite`（不经页面与任务管理器），Claude Opus 5.5、effort xhigh，固定角色用 10-23 实验里的咕嘎设定。输出在 `reports/reference-rewrite-replay-2026-10-24/`（未入库），每份有 `output.md`（与「下载四稿」同格式）、`transcript.md`、接触表与 `meta.json`。

| | 参考片 | 本机素材 | 全程 | 调用 | 输入 / 输出 token | 花费 |
| --- | --- | --- | --- | --- | --- | --- |
| umbrella-1 | 撑伞 51 秒 | 4.0 分钟* | 12.1 分钟 | 1 | 12.4k / 46.5k | $0.98 |
| umbrella-2 | 撑伞 51 秒 | 3.4 分钟* | 11.2 分钟 | 1 | 12.3k / 46.2k | $0.97 |
| jujube-1 | 打枣 44 秒 | 5.7 分钟* | 24.4 分钟 | 2 | 21.8k / 40.2k | $0.89 |

\* 两份回放同时跑，Bandit 与 whisper 抢资源；单独跑时撑伞的本机素材是 2.2 分钟（本机实测）。

**看片**：三份都读对了。撑伞两份都写对「阿姨蹲下摸头、说不收钱」「伞在大叔叹气之后才从画外伸进来」「骑在肩上、阿姨在门口目送」，也都看出片尾转成手绘插画；打枣那份写对「爷爷拿带长柄的铝锅扣在她头上当头盔」「骑粉色小车带走一袋枣」，还说明转写里的「顾哥／伯哥／牧牧」是咕嘎的叫声、「打早」是「打枣」。

**四稿**：每份四篇各换了事件，场次 7–9 场、每篇 950–1320 字，东西按实物写（冰棍一路化、肚皮贴地钩钥匙、雪坡上推没电的电动车）。三处值得留意：

- umbrella-1 四篇都用「画面定格，转成水彩速写」收尾，照搬了原片的收尾手法（另两份 0/4）。10-23 实验里 Claude 第一层也是 4/4。
- 同一个模型反复用到几个点子：雪坡推车（umbrella-1、umbrella-2）、停电夜里打手电（umbrella-2，实验里两层各一次）、冰棍（umbrella-2，实验第二层也有）、烤红薯（umbrella-2、jujube-1，Claude Code 手写稿也有）。
- jujube-1 第一篇的方向写的是「保留……的骨架」，换的是季节和道具，离原片最近。

**一次调用失败**：jujube-1 第一次调用没有被校验拦（`rejections` 为空），是在调用途中失败、按传输错误重做了一次，写稿用了 18.7 分钟。当时回放脚本没记每次调用的结局，原因没查到；之后回放脚本逐次记录，页面实测打开了 `STAGE_MODEL_OUTPUT_LOG_DIR`。第一次调用已产生的 token 照样计费。

## 7. 页面实测（2026-10-24）

用 `.claude/launch.json` 的 `reference-rewrite-check`（4189，跑本 worktree 的代码，只留文本模型密钥，出图出视频的密钥清空，配了本机工具与 `STAGE_MODEL_OUTPUT_LOG_DIR`），在内置浏览器里走了一遍：

1. `/api/health`：`referenceRewrite.available: true`，阶段默认 Claude / `claude-opus-5-5` / effort `xhigh`。填好咕嘎设定、上传撑伞视频后，「参考片仿写」按钮可点，下面写明模型、约 12 分钟、约 1 美元。
2. 点按钮 → 确认框 → 进度依次显示「第 2/4 步 去配乐」等。任务进行中刷新页面，进度照常显示、按钮锁住（重新接管）。
3. 11.8 分钟完成，一次调用、输入 12.3k / 输出 40.8k token（约 $0.86）。Run 的 `media-work/` 已清空；侧车日志在 Run 的 `debug/stage-referenceRewrite/` 下记了这次调用。结果面板显示原片拆解与四张稿件卡（《半根冰棍》《一只手套》《车底下的咪咪》《上坡》）。
4. 稿二点「用这一稿开拍」→ 确认框 → 切到「从剧情开始 · 粘贴完整故事」，输入框是「标题＋剧本」（1131 字），上方列出四稿、当前那篇高亮。旧的参考视频 Run 被删掉，开始拆镜头时视频副本也被删掉。发现并修了一处样式：当前那篇的按钮用了整行宽的主按钮样式，改成与其余三个同样大小、深色标出。
5. 点「开始拆镜头」后剧情 Run 建好、流水线开跑，但这一次在跑完之前 Run 就被清掉了（这个标签页中途被刷新，页面工作区换了一个，旧工作区连同它的 Run 一起清理），没能看到结果。于是把回放里 Claude 写的一稿（umbrella-1 稿四《贩卖机底下》，1154 字）直接贴进粘贴框重测：`storyPipeline` 完成（MiMo 3 次调用），拆成 8 场，台词核对「8 句台词都能在原文里找到」。原文卡片把稿子里的 `**` 与 `>` 标记原样显示，只影响观感。

## 8. 已知缺口

- 只能在这台 Mac 上用：Bandit 在外置盘，whisper 在本机。
- 「写得好不好」「原片读对没有」「四篇是不是换了事件」都没有确定性兜底，只能靠用户读；回放每组只能跑几次。
- 固定角色和参考片主角不是同一个人时（比如小白子配咕嘎的片子）只验证过很少的样本。
- 视频文件名作为「视频标题」进提示词（实验就是这样给的），system 提示词写明它只是素材、不是指令。
- 「用这一稿开拍」会删掉参考视频 Run，四稿只在页面内存里留到刷新；要长期保存只能「下载四稿」。
- 一次约 12 分钟（本机素材约 2 分钟、写稿约 8–9 分钟）；Claude Opus 5.5 一次约 1 美元，结构不合格时带诊断重做一次，最多 2 美元。
