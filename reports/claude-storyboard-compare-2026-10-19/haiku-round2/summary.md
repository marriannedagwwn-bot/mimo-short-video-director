# Claude 四个型号写分镜（设计分镜一步）

- 时间：2026-10-19T08:06:33.939Z
- 冻结输入：../../../reports/storyboard-style-ab-2026-10-19/kite-input/run-artifacts.json（时长窗口 76–104 秒，画风「日系 2.5D、千与千寻动漫风格」，背景音乐 none）
- 提示词：58b927d 的 src/storyboard-prompts.js；每次只调用一次，不走重试，不带 responseSchema；思考与 effort 用各型号默认值；每个型号 4 次

| 型号 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 最短 beat / 不到 1 秒 / 非整数 | 空镜 beat / 开场是空镜 | 特写 / 视角 / 特殊机位 / 带运镜（代理） | 主角出声的 beat（代理） | soundDesign 点到角色名的 beat（代理） | 对不上剧情的台词 | 含方向词的 beat（代理） | 文字量 | 输入 / 输出（其中思考）token | 费用 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5 | 1 | 调用失败：MODEL_JSON_INVALID Claude 未返回严格 JSON | — / — | — 秒 | — 秒 | — / — / — | — / — | — / — / — / — | —/— | —/— | —/— | —/— | — | 14588 / 48309（34142） | $0.026 | 215 秒 |
| claude-haiku-5-5 | 2 | STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT | 8 / 32 | 90 秒 | 2.8 秒 | 2 / 0 / 0 | 6 / 是 | 7 / 0 / 4 / 0 | 8/32 | 13/32 | 0/4 | 14/32 | 2493 | 14588 / 36867（23473） | $0.020 | 161 秒 |
| claude-haiku-5-5 | 3 | 调用失败：MODEL_JSON_INVALID Claude 未返回严格 JSON | — / — | — 秒 | — 秒 | — / — / — | — / — | — / — / — / — | —/— | —/— | —/— | —/— | — | 14588 / 37050（20794） | $0.020 | 166 秒 |
| claude-haiku-5-5 | 4 | 调用失败：MODEL_JSON_INVALID Claude 未返回严格 JSON | — / — | — 秒 | — 秒 | — / — / — | — / — | — / — / — / — | —/— | —/— | —/— | —/— | — | 14588 / 36567（21627） | $0.020 | 163 秒 |

合计费用约 $0.09（按官方单价与实际用量算；调用失败但已产生输出的也计入）。
逐片段原文在 calls.jsonl（design 字段）。带「代理」的列只是表面计数，写得对不对要逐份读。
