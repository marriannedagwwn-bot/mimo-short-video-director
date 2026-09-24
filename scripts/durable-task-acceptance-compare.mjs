#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { contentDigest } from "../src/production-lineage.js";

const options = parseArgs(process.argv.slice(2));
const baselineManifestPath = path.resolve(required(options.baseline, "--baseline"));
const currentManifestPath = path.resolve(required(options.current, "--current"));
const outputPath = options.output ? path.resolve(options.output) : "";
const baselineOutputPath = options.baselineOutput ? path.resolve(options.baselineOutput) : "";
const [baselineManifest, currentManifest] = await Promise.all([
  readJson(baselineManifestPath),
  readJson(currentManifestPath)
]);

const baselineRows = baselineManifest.artifacts.map((artifact) => ({
  artifactId: artifact.artifactId,
  artifactType: artifact.artifactType,
  revision: artifact.revision,
  status: artifact.status,
  contentDigest: artifact.contentDigest,
  dependencies: artifact.dependencies
}));
const artifactIds = [...new Set(Object.keys(baselineManifest.latest || {}))];
const comparisons = [];
for (const artifactId of artifactIds) {
  const baseline = currentArtifact(baselineManifest, artifactId);
  const current = currentArtifact(currentManifest, artifactId);
  if (!baseline || !current) {
    comparisons.push({ artifactId, exact: false, missing: !baseline ? "baseline" : "current" });
    continue;
  }
  const [baselineContent, currentContent] = await Promise.all([
    readJson(path.resolve(path.dirname(baselineManifestPath), baseline.contentPath)),
    readJson(path.resolve(path.dirname(currentManifestPath), current.contentPath))
  ]);
  const diffPaths = jsonDiffPaths(baselineContent, currentContent);
  const normalizedBaseline = normalizeDynamicMedia(artifactId, baselineContent);
  const normalizedCurrent = normalizeDynamicMedia(artifactId, currentContent);
  comparisons.push({
    artifactId,
    artifactType: baseline.artifactType,
    baselineRevision: baseline.revision,
    currentRevision: current.revision,
    baselineDigest: baseline.contentDigest,
    currentDigest: current.contentDigest,
    exact: baseline.contentDigest === current.contentDigest,
    contentExact: diffPaths.length === 0,
    diffPaths,
    normalizedDigestBaseline: contentDigest(normalizedBaseline),
    normalizedDigestCurrent: contentDigest(normalizedCurrent),
    normalizedExact: contentDigest(normalizedBaseline) === contentDigest(normalizedCurrent)
  });
}

const result = {
  acceptanceComparisonVersion: "1.0",
  baseline: {
    projectId: baselineManifest.projectId,
    runId: baselineManifest.runId,
    gitCommit: baselineManifest.gitCommit,
    artifactRevisions: baselineRows.length
  },
  current: {
    projectId: currentManifest.projectId,
    runId: currentManifest.runId,
    gitCommit: currentManifest.gitCommit,
    artifactRevisions: currentManifest.artifacts.length
  },
  exactCount: comparisons.filter((item) => item.exact).length,
  normalizedExactCount: comparisons.filter((item) => item.normalizedExact).length,
  comparisons,
  baselineDigestTable: baselineRows
};
if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}
if (baselineOutputPath) {
  await fs.mkdir(path.dirname(baselineOutputPath), { recursive: true });
  await fs.writeFile(baselineOutputPath, `${JSON.stringify({
    gitCommit: baselineManifest.gitCommit,
    projectId: baselineManifest.projectId,
    runId: baselineManifest.runId,
    artifactRevisions: baselineRows
  }, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));

function currentArtifact(manifest, artifactId) {
  const revision = manifest.latest?.[artifactId];
  return (manifest.artifacts || []).find((artifact) => (
    artifact.artifactId === artifactId && artifact.revision === revision
  )) || null;
}

function normalizeDynamicMedia(artifactId, value) {
  if (!artifactId.startsWith("characterImages:") && !artifactId.startsWith("shotVideo:")) {
    return structuredClone(value);
  }
  const dynamicKeys = artifactId.startsWith("characterImages:")
    ? new Set(["url", "filename"])
    : new Set(["outputUrl", "outputPath", "generatedAt", "providerTaskId", "elapsedMs"]);
  return normalize(value, dynamicKeys);
}

function normalize(value, dynamicKeys) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, dynamicKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    dynamicKeys.has(key) ? `<dynamic:${key}>` : normalize(entry, dynamicKeys)
  ]));
}

function jsonDiffPaths(left, right, pointer = "") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [pointer || "/"];
    const paths = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      paths.push(...jsonDiffPaths(left[index], right[index], `${pointer}/${index}`));
    }
    return paths;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const paths = [];
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      paths.push(...jsonDiffPaths(left[key], right[key], `${pointer}/${escaped}`));
    }
    return paths;
  }
  return [pointer || "/"];
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    result[name] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}
