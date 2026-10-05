import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RENAME_RETRY_DELAYS_MS, replaceFile } from "../src/atomic-file.js";

function fsError(code) {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

function fakeOps({ failures = [], platform = "win32" } = {}) {
  const calls = { rename: 0, unlink: [], sleeps: [] };
  const queue = [...failures];
  return {
    calls,
    options: {
      platform,
      rename: async () => {
        calls.rename += 1;
        const code = queue.shift();
        if (code) throw fsError(code);
      },
      unlink: async (file) => { calls.unlink.push(file); },
      sleep: async (ms) => { calls.sleeps.push(ms); }
    }
  };
}

test("Windows 上 rename 遇到 EPERM/EACCES/EBUSY 短暂退避重试，成功后不删临时文件", async () => {
  const { calls, options } = fakeOps({ failures: ["EPERM", "EBUSY", "EACCES"] });
  await replaceFile("index.json.tmp", "index.json", options);
  assert.equal(calls.rename, 4);
  assert.deepEqual(calls.sleeps, RENAME_RETRY_DELAYS_MS.slice(0, 3));
  assert.deepEqual(calls.unlink, []);
});

test("重试耗尽后删掉临时文件并原样抛出最后一次的 EPERM", async () => {
  const failures = Array(RENAME_RETRY_DELAYS_MS.length + 1).fill("EPERM");
  const { calls, options } = fakeOps({ failures });
  await assert.rejects(replaceFile("manifest.json.tmp", "manifest.json", options), (error) => error.code === "EPERM");
  assert.equal(calls.rename, RENAME_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(calls.sleeps, [...RENAME_RETRY_DELAYS_MS]);
  assert.deepEqual(calls.unlink, ["manifest.json.tmp"]);
});

test("不可重试的错误码立刻失败，同样清理临时文件", async () => {
  const { calls, options } = fakeOps({ failures: ["ENOENT"] });
  await assert.rejects(replaceFile("a.tmp", "a.json", options), (error) => error.code === "ENOENT");
  assert.equal(calls.rename, 1);
  assert.deepEqual(calls.sleeps, []);
  assert.deepEqual(calls.unlink, ["a.tmp"]);
});

test("非 Windows 平台的 EPERM 是真实权限问题，不重试", async () => {
  const { calls, options } = fakeOps({ failures: ["EPERM"], platform: "linux" });
  await assert.rejects(replaceFile("a.tmp", "a.json", options), (error) => error.code === "EPERM");
  assert.equal(calls.rename, 1);
  assert.deepEqual(calls.sleeps, []);
});

test("清理临时文件失败不掩盖原错误", async () => {
  const { options } = fakeOps({ failures: ["ENOENT"] });
  options.unlink = async () => { throw fsError("EBUSY"); };
  await assert.rejects(replaceFile("a.tmp", "a.json", options), (error) => error.code === "ENOENT");
});

test("真实文件系统：覆盖已有文件，不留临时文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "index.json");
  const temporary = `${target}.next.tmp`;
  await fs.writeFile(target, "old");
  await fs.writeFile(temporary, "new");
  await replaceFile(temporary, target);
  assert.equal(await fs.readFile(target, "utf8"), "new");
  assert.deepEqual(await fs.readdir(root), ["index.json"]);
});
