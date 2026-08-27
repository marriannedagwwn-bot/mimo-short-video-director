import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildIdentity } from "../src/build-identity.js";

test("build identity 优先采用显式 git commit 与 build id", () => {
  const identity = resolveBuildIdentity({
    environment: {
      WORKFLOW_GIT_COMMIT: "abcdef1234567890",
      WORKFLOW_BUILD_ID: "deploy-2026.08.26"
    },
    execFileSyncImpl() {
      throw new Error("显式 commit 不应回退读取 git");
    }
  });
  assert.deepEqual(identity, {
    gitCommit: "abcdef1234567890",
    buildId: "deploy-2026.08.26"
  });
});

test("build identity 在环境缺失时读取当前 HEAD，失败则明确 unknown", () => {
  assert.deepEqual(resolveBuildIdentity({
    workspaceRoot: "/workspace",
    environment: {},
    execFileSyncImpl(command, args) {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", "/workspace", "rev-parse", "HEAD"]);
      return "0123456789abcdef0123456789abcdef01234567\n";
    }
  }), {
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    buildId: "0123456789abcdef0123456789abcdef01234567"
  });

  assert.deepEqual(resolveBuildIdentity({
    environment: { WORKFLOW_GIT_COMMIT: "not a sha", WORKFLOW_BUILD_ID: "bad id" },
    execFileSyncImpl() {
      throw new Error("not a git checkout");
    }
  }), { gitCommit: "unknown", buildId: "unknown" });
});
