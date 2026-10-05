import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withProviderTokenCaps } from "../src/stage-token-caps.js";
import { WorkflowService } from "../src/workflow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 默认供应商千问；三家各自的阶段上限。数值照契约：千问 65536、MiMo 131072、DeepSeek 32768，
// 参考片分析两家都是 16384。
const qwenDefaults = {
  analysis: { provider: "Qwen", model: "qwen3.7-plus", maxCompletionTokens: 16384 },
  variants: { provider: "Qwen", model: "qwen3.7-max", maxCompletionTokens: 65536 }
};
const tables = {
  Qwen: qwenDefaults,
  MiMo: { analysis: { maxCompletionTokens: 16384 }, variants: { maxCompletionTokens: 131072 } },
  DeepSeek: { analysis: { maxCompletionTokens: 32768 }, variants: { maxCompletionTokens: 32768 } }
};

function workflowWith(stageDefaults) {
  return new WorkflowService({ clients: { Qwen: {}, MiMo: {}, DeepSeek: {} }, stageDefaults });
}

const override = (stage, provider, model, extra = {}) => ({ modelOverrides: { [stage]: { provider, model, ...extra } } });

test("withProviderTokenCaps 给每个阶段挂上各家自己的上限，跳过无效值且不改原对象", () => {
  const result = withProviderTokenCaps(qwenDefaults, { ...tables, Broken: { variants: { maxCompletionTokens: "abc" } } });
  assert.deepEqual(result.variants.maxCompletionTokensByProvider, { Qwen: 65536, MiMo: 131072, DeepSeek: 32768 });
  assert.deepEqual(result.analysis.maxCompletionTokensByProvider, { Qwen: 16384, MiMo: 16384, DeepSeek: 32768 });
  assert.equal(qwenDefaults.variants.maxCompletionTokensByProvider, undefined);
});

test("按阶段换供应商时取那一家自己的上限：DeepSeek 32768、MiMo 131072、分析 16384", () => {
  const workflow = workflowWith(withProviderTokenCaps(qwenDefaults, tables));
  assert.equal(workflow.resolveStage("variants", {}).maxCompletionTokens, 65536);
  assert.equal(workflow.resolveStage("variants", override("variants", "DeepSeek", "deepseek-v4-flash")).maxCompletionTokens, 32768);
  assert.equal(workflow.resolveStage("variants", override("variants", "MiMo", "mimo-v2.6-pro")).maxCompletionTokens, 131072);
  assert.equal(workflow.resolveStage("analysis", override("analysis", "MiMo", "mimo-v2.6-pro")).maxCompletionTokens, 16384);
});

test("显式给出的上限仍然优先", () => {
  const workflow = workflowWith(withProviderTokenCaps(qwenDefaults, tables));
  const settings = workflow.resolveStage("variants", override("variants", "DeepSeek", "deepseek-v4-flash", { maxCompletionTokens: 9000 }));
  assert.equal(settings.maxCompletionTokens, 9000);
});

test("合法反例：没有各家上限映射的旧调用方行为不变，阶段设置形状也不变", () => {
  const workflow = workflowWith(qwenDefaults);
  assert.equal(workflow.resolveStage("variants", override("variants", "DeepSeek", "deepseek-v4-flash")).maxCompletionTokens, 65536);
  assert.equal("maxCompletionTokensByProvider" in workflow.stageDefaults.variants, false);
});

// 服务端接线（server.js 的 buildStageDefaults → stageDefaultsFor）只能通过真实进程验证：server.js 一被 import 就监听端口。
// 状态目录、浏览器工作区、清理记录、签名密钥全部落在临时目录；没有任何供应商密钥，启动时不发外部请求。
test("真实服务的 /api/health 暴露的阶段设置带有各家自己的上限", { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stage-token-caps-server-"));
  const reserved = net.createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const env = { PATH: process.env.PATH, NODE_ENV: "test", PORT: String(port) };
  for (const key of ["SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
  env.WORKFLOW_PRODUCTION_STATE_DIR = path.join(directory, "production");
  env.PARTIAL_REPAIR_DEBUG_DIR = path.join(directory, "debug");
  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: directory, env });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  // 一个收尾函数里按顺序做：先结束服务并等它退出，再删临时目录。分成两个 t.after 时会按注册顺序先删目录，
  // 而 Windows 不能删除仍是某个进程工作目录的文件夹（EBUSY），后面结束服务那步就不会执行，测试随之挂住。
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let health;
  const deadline = Date.now() + 15000;
  while (!health) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      health = await response.json();
    } catch (error) {
      assert.ok(Date.now() < deadline, `server health never became available: ${error.message}\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const stages = health.modelStages;
  assert.deepEqual(stages.variants.maxCompletionTokensByProvider, { Qwen: 65536, MiMo: 131072, DeepSeek: 32768 });
  assert.deepEqual(stages.analysis.maxCompletionTokensByProvider, { Qwen: 16384, MiMo: 16384, DeepSeek: 32768 });
  assert.equal(stages.storyCandidateReview.maxCompletionTokensByProvider.DeepSeek, 32768);
});
