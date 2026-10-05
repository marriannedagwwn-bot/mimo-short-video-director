import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUniqueDirectory } from "../src/unique-directory.js";

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unique-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// 把 root 一层层加深到至少 minLength 字符，模拟浏览器 Run 内的日志目录深度。
async function deepDirectory(root, minLength) {
  let directory = root;
  let index = 0;
  while (directory.length < minLength) {
    directory = path.join(directory, `segment-${String(index).padStart(2, "0")}-abcdefghij`);
    index += 1;
  }
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

test("在已有目录下创建 <前缀><6 位随机> 目录并返回路径", async (t) => {
  const root = await tempRoot(t);
  const created = await createUniqueDirectory(path.join(root, "attempt-01-"));
  assert.match(path.basename(created), /^attempt-01-[A-Za-z0-9]{6}$/u);
  assert.equal(path.dirname(created), root);
  assert.equal((await fs.stat(created)).isDirectory(), true);
});

test("目标已存在时换后缀重试，绝不复用已有目录", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "a-taken1"));
  const suffixes = ["taken1", "fresh2"];
  const created = await createUniqueDirectory(path.join(root, "a-"), { randomSuffix: () => suffixes.shift() });
  assert.equal(created, path.join(root, "a-fresh2"));
});

test("后缀全部被占用时如实抛 EEXIST", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "a-same00"));
  await assert.rejects(
    createUniqueDirectory(path.join(root, "a-"), { randomSuffix: () => "same00" }),
    (error) => error.code === "EEXIST"
  );
});

test("父目录不存在时报 ENOENT，且不顺手重建父目录", async (t) => {
  const root = await tempRoot(t);
  const missingParent = path.join(root, "deleted-run");
  await assert.rejects(
    createUniqueDirectory(path.join(missingParent, "attempt-01-")),
    (error) => error.code === "ENOENT"
  );
  await assert.rejects(fs.stat(missingParent), (error) => error.code === "ENOENT");
});

test("结果路径超过 260 字符时仍能创建（Windows 上 fs.mkdtemp 在这里失败）", async (t) => {
  const root = await tempRoot(t);
  const parent = await deepDirectory(root, 280);
  const created = await createUniqueDirectory(path.join(parent, "attempt-01-"));
  assert.ok(created.length > 260, `测试路径应超过 260 字符，实际 ${created.length}`);
  assert.equal((await fs.stat(created)).isDirectory(), true);
});

test("空前缀直接拒绝", async () => {
  await assert.rejects(createUniqueDirectory(""), TypeError);
});
