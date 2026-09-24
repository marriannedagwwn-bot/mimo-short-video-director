import { execFileSync } from "node:child_process";
import path from "node:path";

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;

export function resolveBuildIdentity({
  workspaceRoot = ".",
  environment = process.env,
  execFileSyncImpl = execFileSync
} = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const environmentCommit = firstValid(
    [env.WORKFLOW_GIT_COMMIT, env.GIT_COMMIT, env.SOURCE_VERSION],
    GIT_COMMIT_PATTERN
  );
  const gitCommit = environmentCommit || readGitCommit(workspaceRoot, execFileSyncImpl) || "unknown";
  const buildId = firstValid([env.WORKFLOW_BUILD_ID], BUILD_ID_PATTERN) || gitCommit;
  return Object.freeze({ gitCommit, buildId });
}

function readGitCommit(workspaceRoot, execFileSyncImpl) {
  if (typeof execFileSyncImpl !== "function") return "";
  try {
    const value = execFileSyncImpl(
      "git",
      ["-C", path.resolve(String(workspaceRoot || ".")), "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const commit = String(value || "").trim();
    return GIT_COMMIT_PATTERN.test(commit) ? commit : "";
  } catch {
    return "";
  }
}

function firstValid(values, pattern) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (pattern.test(normalized)) return normalized;
  }
  return "";
}
