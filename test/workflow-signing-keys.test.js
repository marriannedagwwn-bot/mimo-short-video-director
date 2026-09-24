import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOrCreatePersistentKey, PersistentKeyError } from "../src/persistent-key.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import { mockAnalysis } from "../src/mock.js";
import { sealReferenceAnalysis, verifyReferenceAnalysis } from "../src/reconstruction-grounding.js";
import { WorkflowService } from "../src/workflow.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";

const GROUNDING_CONTEXT = {
  frames: [
    { timestamp: 0, dataUrl: "data:image/jpeg;base64,AA==" },
    { timestamp: 12, dataUrl: "data:image/jpeg;base64,AA==" },
    { timestamp: 24, dataUrl: "data:image/jpeg;base64,AA==" }
  ],
  metadata: { name: "reference.mp4", duration: 24, width: 1080, height: 1920 },
  transcript: "00:00-00:04 主角拿起桌上的纸袋。"
};

const BOUNDARY_INPUT = {
  creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "家电维修", constraints: "60 秒内" },
  referenceAnalysis: {},
  sourceScriptReconstruction: {},
  creativeBrief: {}
};

async function keyDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "signing-keys-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function loadKey(directory, fileName, options = {}) {
  return loadOrCreatePersistentKey({ directory, fileName, byteLength: 32, label: "测试密钥", ...options });
}

test("服务器重启后仍能验证重启前签发的角色边界与 grounding seal", async (t) => {
  const directory = await keyDirectory(t);
  const boot = async () => new WorkflowService({
    groundingKey: (await loadKey(directory, ".grounding-key")).key,
    characterBoundaryKey: (await loadKey(directory, ".character-boundary-key")).key
  });

  // 第一次启动签发，第二次启动（= 重启）校验。密钥随机生成时这里必然失败。
  const before = await boot();
  const sealedInput = withGlobalCharacterBoundary(before, BOUNDARY_INPUT);
  const sealedAnalysis = sealReferenceAnalysis(mockAnalysis(GROUNDING_CONTEXT), GROUNDING_CONTEXT, before.groundingKey);

  const after = await boot();
  assert.ok(before.characterBoundaryKey.equals(after.characterBoundaryKey));
  assert.ok(before.groundingKey.equals(after.groundingKey));
  assert.doesNotThrow(() => after.assertGlobalCharacterBoundary(sealedInput));
  assert.doesNotThrow(() => verifyReferenceAnalysis(sealedAnalysis, after.groundingKey));
});

test("首次加载以 0600 创建密钥文件，再次加载回读同一份而不是重新生成", async (t) => {
  const directory = await keyDirectory(t);
  const first = await loadKey(directory, ".grounding-key");
  const keyFile = path.join(directory, ".grounding-key");

  assert.equal(first.source, "文件");
  assert.equal(first.key.byteLength, 32);
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);

  const second = await loadKey(directory, ".grounding-key");
  assert.ok(first.key.equals(second.key));
  // 状态目录本身也必须是私有的。
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test("环境变量优先于已存在的密钥文件", async (t) => {
  const directory = await keyDirectory(t);
  const fromFile = await loadKey(directory, ".grounding-key");
  const configured = "ab".repeat(32);

  const fromEnv = await loadKey(directory, ".grounding-key", { envValue: configured });
  assert.equal(fromEnv.source, "环境变量");
  assert.ok(fromEnv.key.equals(Buffer.from(configured, "hex")));
  assert.ok(!fromEnv.key.equals(fromFile.key));
});

test("环境变量非法时硬失败，绝不回退到文件或随机密钥", async (t) => {
  const directory = await keyDirectory(t);

  // 目录里连文件都不该被创建：一个笔误必须当场暴露，而不是悄悄换一把钥匙。
  await assert.rejects(
    () => loadKey(directory, ".grounding-key", { envValue: "不是十六进制" }),
    (error) => error instanceof PersistentKeyError && /十六进制/u.test(error.message)
  );
  await assert.rejects(
    () => loadKey(directory, ".grounding-key", { envValue: "abcd" }),
    (error) => error instanceof PersistentKeyError && /太短/u.test(error.message)
  );
  await assert.rejects(
    () => loadKey(directory, ".grounding-key", { envValue: "abc" }),
    (error) => error instanceof PersistentKeyError
  );
  assert.deepEqual(await fs.readdir(directory).catch(() => []), []);
});

test("已有密钥文件损坏时硬失败，且不覆盖原文件", async (t) => {
  const directory = await keyDirectory(t);
  const keyFile = path.join(directory, ".grounding-key");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(keyFile, Buffer.alloc(8, 1));

  await assert.rejects(
    () => loadKey(directory, ".grounding-key"),
    (error) => error instanceof PersistentKeyError && /损坏/u.test(error.message)
  );
  // 截断的文件可能是正确密钥的残骸，重新生成会把「验不过」升级成「永久丢失」。
  assert.deepEqual(await fs.readFile(keyFile), Buffer.alloc(8, 1));
});

test("生产包签名密钥改为委托后行为不变，文件权限为 0600", async (t) => {
  const directory = await keyDirectory(t);
  const store = new ProductionStateStore({ rootDir: directory });

  const first = await store.signingKey();
  assert.equal(first.byteLength, 48);
  const keyFile = path.join(directory, ".package-signing-key");
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.ok(first.equals(await store.signingKey()));

  // 损坏时仍抛既有的 ProductionStateError / PACKAGE_SIGNING_KEY_INVALID。
  await fs.writeFile(keyFile, Buffer.alloc(8, 1));
  await assert.rejects(
    () => new ProductionStateStore({ rootDir: directory }).signingKey(),
    (error) => error.code === "PACKAGE_SIGNING_KEY_INVALID" && error.httpStatus === 500
  );
});
