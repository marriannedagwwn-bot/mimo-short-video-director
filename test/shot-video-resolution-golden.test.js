import test from "node:test";
import assert from "node:assert/strict";
import { miniMaxPostedBody, pinResolutionEnv, seedancePostedBody, sha256 } from "./helpers/fake-video-providers.js";

// 2026-10-10：镜头视频加「生成分辨率」选项之前，用改动前的代码锁住各家供应商在「没选分辨率」时
// 实际收到的请求体（原始字节的摘要，键顺序也算在内）。改完必须照样通过：没选时请求逐字节不变。
// 2026-10-11 删除可灵后只剩 Seedance 与 MiniMax 两份，摘要值一个字都没改：删旧代码不得改变这两家的请求体。
// 分辨率由环境变量决定：Seedance 不设（走代码默认 720p），MiniMax 设成 768P（与本机 .env 相同）。
// 其余会受 .env 影响的字段都写进供应商配置文件里固定住。

const GOLDEN = {
  seedance: { resolution: "720p", sha256: "afecfccacdcbb303843e981b306959a00f991972e8d49617cfbcb1f1295a1249" },
  minimax: { resolution: "768P", sha256: "4b9f4a0e15e174a94a17d6499ecb20b825e3ec1e758d80c036dc377a97b3e7ed" }
};

test("没选分辨率时，Seedance 全能参考的请求体与加选项之前逐字节相同", async (t) => {
  pinResolutionEnv(t, { MINIMAX_VIDEO_RESOLUTION: "768P" });
  const { raw } = await seedancePostedBody(t);
  assert.equal(JSON.parse(raw).resolution, GOLDEN.seedance.resolution);
  assert.equal(sha256(raw), GOLDEN.seedance.sha256);
});

test("没选分辨率时，MiniMax H3 的请求体与加选项之前逐字节相同（分辨率取环境变量）", async (t) => {
  pinResolutionEnv(t, { MINIMAX_VIDEO_RESOLUTION: "768P" });
  const { raw } = await miniMaxPostedBody(t);
  assert.equal(JSON.parse(raw).resolution, GOLDEN.minimax.resolution);
  assert.equal(sha256(raw), GOLDEN.minimax.sha256);
});
