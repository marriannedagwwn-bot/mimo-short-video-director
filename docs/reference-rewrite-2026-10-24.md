# 参考片仿写接进 AI 导演（2026-10-24）

> 状态：代码与自动化测试完成（全量 1774 个通过），第二版的真实整条运行见第 8 节；未提交。分支 `feat/reference-rewrite`。
> 第一版（84c0c16）把它做成参考视频入口的独立按钮：写四稿 → 选一稿填进「从剧情开始 · 粘贴完整故事」。用户看过后指出理解错了：去配乐与转写要放在参考片分析之前，仿写就是 AI 导演的「主题变体」这一步。本文按第二版写；第一版的回放与页面实测数据留在第 7 节，提示词只有「设定创作宇宙」那段不同。

## 1. 为什么要有这一步

10-23 用户让 Claude Code 看《总有人会给你撑伞》（咕嘎，51 秒）写「如果写一个类似的故事，你会怎么写剧本」。Claude Code 的做法：每秒 2 帧抽帧拼成接触表看画面；用本机 Bandit v2 Multi 把音轨分成人声、音乐、音效，再用 whisper 转写；写出「原片拆解（概要、台词表、好看在哪）＋四篇类似剧本」。用户认可这份稿子，要求在工作流里复现，模型用 Claude API。

对照实验（`reports/reference-rewrite-ab-2026-10-23/`，在 worktree `story-script-audio-processing-f1b013`，未提交；对照文档在外层 `总有人会给你撑伞-复现对照.md`）把同一份资料交给两家模型，各跑两层（只给原始资料 / 另给 Claude Code 的原片拆解），每组 1 次：

- **Claude Opus 5.5（effort xhigh）能复现**：原片读对了（还看出 Claude Code 漏掉的片尾水彩淡出），四篇写法同一个路数；约 $1、9 分钟一次。
- **MiMo v2.6 pro 只复现了格式**：第一层读错了「阿姨怎么放行」「伞在哪句话之后到」；第二层把拆解当模板，四篇都是原片事件链换皮。

所以主题变体默认 Claude Opus 5.5、effort xhigh，不跟随 `DEFAULT_LLM_PROVIDER`。

## 2. 用户看到的流程（10-24 用户定的四条）

1. **转写只作台词稿**：AI 导演第一步「去配乐与转写」在本机跑，转写稿交给分析、还原和主题变体；MiMo 照旧看原视频。
2. **变体就是完整剧本**：主题变体写 N 篇（方向、概要、分场剧本），篇数取「候选数量」。选中一篇点「拆成完整剧情 →」，完整剧情按这篇剧本拆场（与「粘贴完整故事」一样），之后照常出 4.0 分镜、角色参考图、镜头视频。候选评审、展开前体检、命题修订、剧情体检与按问题修改对剧本变体不适用。
3. **给 Claude 的是接触表、台词稿、角色边界**：不给 MiMo 写的分析、还原与简报正文。时间轴采样仍最多显示 10 张缩略图，鼠标移到最后一张上显示「+N」——主题变体这一步还会多看的帧数（跑过之后按实际切出的帧数，之前按时长估）。
4. **去掉独立的「参考片仿写」按钮**。

页面：步骤条六步（去配乐与转写、参考片分析、原片脚本还原、创意简报、角色与表达边界、主题变体）；转写结果卡（转写稿默认折起）；剧本卡上方是原片拆解，每篇「看剧本」展开，「下载剧本（Markdown）」由浏览器生成。完整剧情页有台词核对（剧本里找不到的台词逐句列出，只提示不拦截）。「AI 导演」在本机工具不齐时禁用并写明缺什么。模型设置里「主题变体」只列 Claude 与 MiMo；原来那一栏改叫「故事候选（从剧情开始）」。导演助手：AI 导演最少 5 次调用（转写不调模型），选剧本变体写「拆成完整剧情」、不带体检说明。

旧 Run 里已有的旧格式故事候选照常可用（体检、评审、修订、按候选展开都按原样走）。旧 Run 点「继续 AI 导演」会从转写开始重跑（第 3 节「复用规则」）。

## 3. 契约（五个面）

| 契约 | 生产者 | 消费者 | 校验器 | 提示词 | 测试 |
| --- | --- | --- | --- | --- | --- |
| Artifact `sourceTranscript`（`source_transcript/1.0`） | AI 导演第一个子任务 `sourceTranscript`（`server.js` `sourceTranscriptTaskDefinition` / `runSourceTranscript`）；`src/reference-rewrite-materials.js` `buildSourceTranscript`：副本复制进 Run 的 `media-work/` 并核对 SHA-256、≤180 秒、Bandit 三轨（`tools/reference-audio-stems.py`）、whisper 三组（原声、人声轨、原声减音乐，按词对时间）加有声区间 | 分析与还原（`sourceTranscriptText`）、主题变体（`transcriptText`）、页面转写卡 | 子进程超时＋SIGKILL；每步前复核页面工作区还活着；临时目录用完即删；建 AI 导演任务前查本机工具，缺了 409 `SOURCE_TRANSCRIPT_TOOLS_UNAVAILABLE` | 分析与还原各多一段「自动转写」，只在有转写时出现 | `test/reference-rewrite-materials.test.js`、`test/source-transcript-pipeline-http.test.js` |
| 转写进封印 | `evidenceContextDigest`（`src/reconstruction-grounding.js`）只在有转写时加 `sourceTranscriptHash` | 还原核对分析的封印 | 旧封印算出来不变；转写换了还原就拒绝 | — | `test/script-variants.test.js` |
| 依赖与复用 | `DIRECTOR_PIPELINE_STAGES`：分析 `[sourceTranscript]`、还原 `[referenceAnalysis, sourceTranscript]`、主题变体 `[referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails, sourceTranscript]` | 递归作废；`pipelineArtifactReusable` 要求 current 产物的依赖包含这一步现在的全部依赖 | — | — | `test/source-transcript-pipeline-http.test.js`、`test/director-run-control-http.test.js` |
| 主题变体 `theme_variants_script/1.0` | `runScriptVariants`：`buildContactSheets` 从副本现切接触表（每秒 2 帧、>120 秒 1 帧、6×4）→ `workflow.createScriptVariants`（先验签角色边界；coordinator 最多 2 次、重试只发诊断）→ `sealScriptThemeVariants` 发 id 与 format | 剧本卡、`variant:<id>`、完整剧情、导演助手、「+N」 | `ensureReferenceRewriteContract`：恰好 N 篇、键齐全、非空、标题不重复、「标题＋剧本」≤5000 字、剧本里写出签发的角色名（`SCRIPT_VARIANT_PROTAGONIST_NAME_MISSING`）；`ensureScriptVariant` 在读路径上复核选中的那篇 | `src/reference-rewrite-prompts.js`（golden 锁定） | `test/reference-rewrite-contract.test.js`、`test/reference-rewrite-workflow.test.js` |
| 按剧本拆场 | `createFullStory` 见 `variant.format === "script"`：`variantScriptSceneScriptPrompt`、`SCRIPT_VARIANT_SYSTEM_PROMPT`，`selectedVariantId` 写成这篇的编号 | 4.0 分镜（锁台词）、台词核对、一句话修改 | 签发校验与视频版同一条（`validateFullStoryForSigning`），角色边界按参考视频那一版验签 | 在 `storySceneScriptPrompt` 输出上逐字锚点替换（golden 锁定），剧情入口那份不动 | `test/script-variants.test.js` |
| 旧格式才有的工具 | 展开前体检、候选评审、命题修订、剧情体检、按问题修改 | — | 遇到剧本格式 `SCRIPT_VARIANT_NOT_SUPPORTED`，不调模型 | — | `test/script-variants.test.js` |
| Claude 收图 | `src/claude-client.js` `buildClaudeRequestBody` 的 `frames` → `[image…, text]`；`overrides.effort` 优先于全局 | 只有主题变体传 `frames` | data URL 只收 jpeg/png/gif/webp 的 base64，否则 `MODEL_MEDIA_INVALID`；不传 frames 时请求体逐字不变 | — | `test/claude-client.test.js` |

`themeVariants`（剧本格式）的内容：`schemaVersion`、`original`（原片拆解：概要、台词表、好看在哪；只展示，不是事实来源）、`variants[{id, format, title, direction, summary, script}]`、`materials`（帧率、帧数、张数、时长、实际用的剧情时长目标）、`model`（provider、model、effort、调用次数、被拦次数）。接触表图片不入库；Task Store 照旧不存提示词与图片。3.0 测试包不校验 themeVariants 内容，剧本格式照原样带走；包里不带 `sourceTranscript`。

## 4. 提示词与输出

来源是对照实验的 `materials/prompt.md`，写稿要求 8 条逐字沿用，只改了这几处：

1. 接触表说明按实际张数与帧率生成，最后一张不满时写明「只有前 N 格有画面」；
2. 「设定创作宇宙」那段：固定角色换成已签发的角色事实 `fullStoryCharacterFacts(visualGuardrails)`（第一版是用户填的固定角色原文），赛道与创作限制取页面设定；第 4 条写明「名字写『X』……不写角色事实里禁止的特征」（「开场 3 秒内带着声音和大动作出场」保留）；
3. 篇数取页面「候选数量」（第一版写死 4 篇）；
4. 时长窗口取剧情时长目标（`storyDurationWindow`；没给时与原片对齐，按实测时长取整、夹在 20–180 秒）；
5. 输出从 Markdown 改成 JSON：Claude 用 `claudeResponseSchema` 结构化输出（不用 minLength / maxItems，条数由校验器管），MiMo 用约束解码 Schema（按篇数锁条数、非空）。

实验里手挑的两张关键帧放大图、手截复核的那组转写无法自动化，去掉了。转写时 whisper 的提示词不写角色名（第 10 节有实测：写了会让有对白的片子整段塌成角色名）。B 组的人声轨从 10-24 晚起是「Bandit 对白＋Mel-RoFormer 捞回的人声」，见第 10 节。

按剧本拆场的提示词在粘贴故事那份的输出上做逐字锚点替换：系统消息换成不说「本次没有参考视频」的版本，「用户故事原文」换成「剧本原文」，故事位 `V1` 换成这篇的编号。拆场只拿固定角色设定、角色事实、时长目标与这篇剧本，不拿原片分析、还原与简报。

## 5. 本机依赖

```bash
REFERENCE_REWRITE_BANDIT_DIR=/Volumes/MacOS/AI/Bandit-v2-Multi
REFERENCE_REWRITE_VOCAL_RECOVERY_DIR=/Volumes/MacOS/AI/SAM-Audio-Breath
REFERENCE_REWRITE_WHISPER_BIN=~/.local/bin/whisper
# 可选，写出来的是默认值
# REFERENCE_REWRITE_WHISPER_MODEL=small
# REFERENCE_REWRITE_WHISPER_MODEL_DIR=~/.cache/whisper
```

- 都不设，或外置盘没挂上、模型文件不在，`/api/health` 的 `sourceTranscript.reason` 逐项写明缺什么，「AI 导演」不能点、建任务 409。**不跳过转写这一步，不回退到不去配乐的转写，不让 whisper 自己下载模型**（`--model_dir` 指定目录、先查文件在不在）。已经转写过的 Run 继续跑后面几步时不再要求工具。
- ffmpeg / ffprobe 从 PATH 找。Bandit 用它自带的 `.venv/bin/python -I`，先核对 checkpoint 的 SHA-256；只读地 import 安装目录，不改它。有 MPS 用 MPS，没有用 CPU。
- 人声捞回用 `SAM-Audio-Breath` 自带的 `.venv/bin/python -I -B` 跑它的 `retain_vocalizations.py`（Mel-RoFormer Kim Vocal 2，MLX，Apple GPU），模型 SHA-256 由它自己核对；子进程只拿到 PATH/HOME/TMPDIR/LANG 与 `HF_HUB_OFFLINE=1`，不拿服务端的密钥。工具检查查 Python、脚本与 `models/mel-roformer-kim-vocal-2/model.safetensors` 在不在。捞回失败整步失败，不退回 Bandit 对白轨。捞回后的人声轨用 `tools/reference-audio-stems.py --activity-input … --activity-output …` 算有声区间（同一个阈值函数）。
- 演示模式（没配任何模型）不跑本机工具：占位转写、一张占位接触表、N 篇占位稿，能免费走完六步。
- 起真服务的测试用 `test/helpers/fake-reference-tools.js` 的替身程序（按真实程序的约定写出文件），不跑真的 ffmpeg / Bandit / Mel-RoFormer / whisper。

## 6. 运行顺序与花费

AI 导演六步：去配乐与转写（本机约 2 分钟）→ 分析 → 还原 → 简报 → 角色边界（MiMo，与原来相同）→ 主题变体（Claude Opus 5.5，切接触表几秒、写稿约 8–9 分钟，约 1 美元；结构不合格时带诊断重做一次，最多 2 美元）。转写与主题变体都在服务端读页面工作区里的参考视频副本；页面关闭、工作区清掉之后这两步会如实报缺视频，不自动重跑。暂停或终止不会打断正在跑的 Bandit 或 whisper，最多等 20 秒，到下一次心跳才生效。

## 7. 第一版的真实回放与页面实测（2026-10-24，独立按钮那一版）

提示词与第二版只差「设定创作宇宙」那段（第一版直接写用户填的固定角色原文）与篇数写死 4 篇，看片与写稿的数据仍有参考价值。

当时的回放脚本 `scripts/reference-rewrite-replay.mjs`（第二版已删：它调的是独立按钮那一版的函数；第二版改在真实服务上整条跑）直接用服务端的素材模块与模型方法（不经页面与任务管理器），Claude Opus 5.5、effort xhigh，固定角色用 10-23 实验里的咕嘎设定。输出在 `reports/reference-rewrite-replay-2026-10-24/`（未入库）。

| | 参考片 | 本机素材 | 全程 | 调用 | 输入 / 输出 token | 花费 |
| --- | --- | --- | --- | --- | --- | --- |
| umbrella-1 | 撑伞 51 秒 | 4.0 分钟* | 12.1 分钟 | 1 | 12.4k / 46.5k | $0.98 |
| umbrella-2 | 撑伞 51 秒 | 3.4 分钟* | 11.2 分钟 | 1 | 12.3k / 46.2k | $0.97 |
| jujube-1 | 打枣 44 秒 | 5.7 分钟* | 24.4 分钟 | 2 | 21.8k / 40.2k | $0.89 |

\* 两份回放同时跑，Bandit 与 whisper 抢资源；单独跑时撑伞的本机素材是 2.2 分钟（本机实测）。

**看片**：三份都读对了。撑伞两份都写对「阿姨蹲下摸头、说不收钱」「伞在大叔叹气之后才从画外伸进来」「骑在肩上、阿姨在门口目送」，也都看出片尾转成手绘插画；打枣那份写对「爷爷拿带长柄的铝锅扣在她头上当头盔」「骑粉色小车带走一袋枣」，还说明转写里的「顾哥／伯哥／牧牧」是咕嘎的叫声、「打早」是「打枣」。

**四稿**：每份四篇各换了事件，场次 7–9 场、每篇 950–1320 字，东西按实物写。三处值得留意：umbrella-1 四篇都用「画面定格，转成水彩速写」收尾（另两份 0/4；10-23 实验里 Claude 第一层也是 4/4）；同一个模型反复用到几个点子（雪坡推车、停电夜里打手电、冰棍、烤红薯）；jujube-1 第一篇换的是季节和道具，离原片最近。

**一次调用失败**：jujube-1 第一次调用没有被校验拦，是在调用途中失败、按传输错误重做了一次，原因没查到；第一次调用已产生的 token 照样计费。

**页面实测（第一版）**：在 4189 上走通了「上传撑伞 → 参考片仿写（11.8 分钟、约 $0.86）→ 选一稿 → 粘贴框 → 拆镜头」，台词核对 8/8 句在原文里找得到；原文卡片把稿子里的 `**` 与 `>` 标记原样显示。

## 8. 第二版的回放与页面实测

在真实服务上整条跑（临时 launch 配置，端口 4190，跑本 worktree 的代码；出图出视频的密钥清空；本机工具用外置盘的 Bandit 与 `~/.local/bin/whisper` small 模型）。视频经页面脚本装进上传框，固定角色是 10-23 实验的咕嘎设定，候选数量 4，剧情时长与原片对齐。

| | 参考片 | 去配乐与转写 | 分析→角色边界（MiMo） | 主题变体（Claude） | 结果 |
| --- | --- | --- | --- | --- | --- |
| 撑伞 | 51 秒，102 帧 / 5 张接触表 | 3.6 分钟 | 4 步各 1 次，一次过 | 5.6 分钟，1 次调用，输入 13.3k / 输出 31.8k token | 六步全过，共 13.7 分钟 |
| 打枣 | 44 秒，87 帧 / 4 张接触表 | 4.2 分钟 | 角色边界前两次被拦（见下），第三次过 | 6.2 分钟，1 次调用，输入 12.0k / 输出 36.7k token | 第三次继续后六步全过 |

**看片**：两份都读对了。撑伞写对「阿姨摸头说好孩子快去吧、不收钱」「大叔蹲在车旁叹气『今天又卖不出去了』之后伞才从画外伸进来」「骑在肩上、阿姨门口目送」「转成手绘淡彩」；打枣写对「爷爷拿带柄的铝锅扣在她头上」「贴企鹅图案的粉色小车」「有空常来爷爷这儿玩啊」。转写稿去配乐后的人声轨把几句关键台词都转对了，叫声在原声与「原声减音乐」两组里（「嗑嗑」「小咕咕」），分析阶段把「顾哥」这类同音写法认成叫声。

**剧本**：撑伞四篇《半杯酸梅汤》《地下通道的掌声》《半个包子》《穿针》，打枣四篇《看柿子》《冬至的碗》《企鹅风筝》《抢在雨前》，每篇各换了事件，880–1220 字；这一次 8 篇都没有「水彩速写」收尾。两份都存进外层目录（`总有人会给你撑伞-AI导演主题变体-2026-10-24.md`、`打枣-AI导演主题变体-2026-10-24.md`），给用户读，不打分。

**页面**：时间轴最后一张悬停显示「+92」（撑伞）与「+77」（打枣）；跑完之后标题里的帧数换成实际切出的 102 帧。步骤条六步依次完成；转写卡、原片拆解、四张剧本卡、「看剧本」都正常；导演助手的选项写成「选 V1《半杯酸梅汤》，拆成完整剧情」。打枣那份在角色边界失败后，点「启动 AI 导演」在同一个 Run 上继续：前四步复用（`reusedStages: 4`），只重跑角色边界与主题变体。

**按剧本拆场**（撑伞 V1，MiMo）：点「拆成完整剧情」没有展开前体检，直接建任务。第一次被拦：MiMo 在 `keyProps[6]` 里多写了一个 `live` 字段，完整剧情的严格 Schema 拒收（这一步对 Schema 错误按设计不重试）；页面上重新生成一次就过了：8 场、60 秒、`selectedVariantId: V1`。刷新后台词核对显示「10 句台词都能在剧本里找到」，没有「检查剧情硬伤」按钮，分场页标题是「把选中的剧本拆成可拍完整剧情」（这处文案是实测时发现、当场改的）。

**4.0 分镜**（MiMo）：设计、审阅、修订、终审 4 次调用都做完，设计稿里的台词全部能在剧本里逐字找到（锁台词生效），但签发时被既有的角色边界检查拦下：「characterReference 未沿用全局角色边界：缺少全局必需角色事实：帽子上的黄色的嘴」。角色边界把用户写的「帽子上有黄色的嘴」改写成必需外观「帽子上的黄色的嘴」（另两种写法也都不是用户原话），而剧情和分镜都照用户原话写「帽子上有黄色的嘴」；外观类必需事实缺失按设计硬失败、不补写。这是 4.0 分镜签发的既有行为，与本次改动无关，换成旧格式候选同样会撞上；用这个固定角色设定出分镜之前要先解决，见第 9 节。

**MiMo 在角色边界一步的两次结构错误**（打枣）：第一次把 `allowedPositiveTraits` 等七个顶层字段写进了 `fixedCharacterBoundary` 里面；第二次把 `schemaVersion` 写成 `".0"`。这一步的提示词与代码本次没有改，也没有接 JSON Schema 约束解码；第三次照常通过。

## 9. 已知缺口

- 只能在这台 Mac 上用：Bandit 与人声捞回在外置盘，whisper 在本机。外置盘没挂上时 AI 导演开不了。
- whisper small 听不懂咕嘎这类尖细的叫声：纯叫声的片子换哪条轨都编出字来（「bgm」「字幕by…」「请点赞订阅」），每次编的不一样，whisper 自己的可信度分也分不出来。用户决定先维持现状，让分析与 Claude 自己判断；换更大的 whisper 模型要下载，没试。
- 配乐里有人唱歌时，Mel-RoFormer 会把歌声也捞进人声轨，歌词会出现在 B 组。用户自己那套流程的「歌声排除」要人工核对过的歌曲区间，这里没法自动做。
- 创意简报照跑，但主题变体不再读它；角色边界的签名摘要包含它，所以不能直接去掉。要不要去掉另行决定。
- 旧的视频写候选代码（`createVariants` 两次调用、来源基线、`/api/variants` 直调路由与 CLI `workflow.run`）不再被 AI 导演调用，但这次没删；剧情入口的候选 Schema 仍从它派生。
- 「写得好不好」「原片读对没有」「N 篇是不是换了事件」都没有确定性兜底，只能靠用户读；回放每组只能跑几次。Claude 有固定偏好的点子，比如收尾常用水彩速写。
- 固定角色和参考片主角不是同一个人时（比如小白子配咕嘎的片子）只验证过很少的样本。
- 视频文件名作为「视频标题」进提示词（实验就是这样给的），system 提示词写明它只是素材、不是指令。
- 「+N」在跑主题变体之前是按时长估的（`round(时长×帧率)`），与 ffmpeg 实际切出的帧数可能差一两帧。
- 角色边界会把固定角色设定里的外观写法改写成另一种措辞（实测「帽子上有黄色的嘴」→「帽子上的黄色的嘴」），而剧情与分镜照用户原话写，4.0 分镜签发时按字面比对就会硬失败。这是既有问题，本次没改；要不要让边界的写法里总带上用户原话，另行决定。
- 角色边界那一步 MiMo 偶尔写错结构（实测打枣连续两次），没有约束解码，失败了只能再点一次「启动 AI 导演」继续。

## 10. 人声轨改用捞回版（2026-10-24 晚）

起因：用户在 4173 跑《她好开心》（24 秒，只有咕嘎的叫声），转写稿 B 组（Bandit 对白轨）是空的，C 组（原声减音乐）转出「诗得浪玩吗」「诗得浪 bgm」，看上去像是配乐没去掉、台词也没认出来。

**查下来的情况：**

- **配乐是去掉了的。** 只有配乐的几秒，去配乐后的音轨比原声低 28–56 dB。「bgm」是 whisper 在叫声上编出来的字。
- **对白轨是空的，因为 Bandit 不把咕嘎的叫声当人声。** 咕嘎的音高中位数约 450 Hz、最高约 1000 Hz；Bandit 把这些叫声分进音效轨，《打枣》开头那声还进了音乐轨。用户外置盘上的 Mel-RoFormer（`SAM-Audio-Breath/retain_vocalizations.py`）从「原声减对白」里能把它们捞回来；同一段里不是人声的音效会低 39–47 dB。
- **四支有叫声的片子上对照了 whisper small**（同一次去配乐结果，提示词不变）：
  - 《打枣》换成捞回的人声轨后明显变好：咕嘎 0–4 秒、12–22 秒、26–30 秒的叫声认出来了（同音写成「估计」），原来的对白轨漏掉了 0–3 秒、26–30 秒和「吃枣喽」；爷爷的台词一句没丢。
  - 《特殊的留言》与原来持平。
  - 《她好开心》《活泼嘎》只有叫声，哪条轨都转不出对的字。
- **whisper 提示里写「主角叫咕嘎」不能用。** 它在《活泼嘎》上认出 4 声「咕嘎！」和 3 声「嘎！」，但在《打枣》上把 3.5–30 秒整段塌成「咕嘎，，，，」，爷爷的四句台词全丢了；它还会让转写跟着「固定角色」一栏变。
- **whisper 自己的可信度分不出编的字**：「请点赞订阅」那段（-0.57）比《打枣》「原声减音乐」前 30 秒的真台词（-1.09）还高，所以不靠分数过滤。

**用户的决定：** 人声轨换成「Bandit 对白＋Mel-RoFormer 捞回」，A、C 两组照旧，叫声认不出来的事先维持现状。

**改了什么：** 分轨之后多跑一次 `retain_vocalizations.py` 得到人声轨（约 30 秒，Apple GPU），B 组转写它，E 组的人声区间按它算（`reference-audio-stems.py` 新增只算区间的用法）。转写稿开头的处理方法写明捞回这一步，以及配乐里的歌声也会进人声轨。Artifact 多一个 `voiceRecovery: "mel-roformer-kim-vocal-2"`，转写卡的处理参数一行写「Mel-RoFormer 捞回叫声」；`schemaVersion` 不变，已有的转写稿照常读。新增配置 `REFERENCE_REWRITE_VOCAL_RECOVERY_DIR`，缺了 AI 导演开不了。

对照所用的逐句转写、试听文件与 Run 外的脚本都在仓库外（外层目录 `去配乐与转写-调试对照-2026-10-24.md`、`她好开心-音频分离/`），不入库。
