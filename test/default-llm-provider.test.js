import test from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultLlmProvider } from "../src/config.js";

const both = { qwen: { enabled: true }, mimo: { enabled: true } };

test("without DEFAULT_LLM_PROVIDER the existing Qwen-first routing is unchanged", () => {
  assert.equal(resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "" }), "Qwen");
  assert.equal(resolveDefaultLlmProvider({ qwen: { enabled: false }, mimo: { enabled: true }, defaultLlmProvider: "" }), "MiMo");
  assert.equal(resolveDefaultLlmProvider({ qwen: { enabled: false }, mimo: { enabled: false } }), "MiMo");
});

test("DEFAULT_LLM_PROVIDER picks MiMo even when Qwen is configured, case-insensitively", () => {
  assert.equal(resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "MiMo" }), "MiMo");
  assert.equal(resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "mimo" }), "MiMo");
  assert.equal(resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "qwen" }), "Qwen");
});

test("an explicitly requested provider that is not configured fails instead of silently switching", () => {
  assert.throws(
    () => resolveDefaultLlmProvider({ qwen: { enabled: true }, mimo: { enabled: false }, defaultLlmProvider: "MiMo" }),
    /DEFAULT_LLM_PROVIDER=MiMo，但 MiMo 没有配置（缺少 MIMO_BASE_URL）/
  );
  assert.throws(
    () => resolveDefaultLlmProvider({ qwen: { enabled: false }, mimo: { enabled: true }, defaultLlmProvider: "Qwen" }),
    /缺少 QWEN_BASE_URL 或 QWEN_API_KEY/
  );
});

test("demo mode keeps working when .env carries a preference but every live provider is blanked", () => {
  assert.equal(resolveDefaultLlmProvider({ qwen: { enabled: false }, mimo: { enabled: false }, defaultLlmProvider: "MiMo" }), "MiMo");
  assert.equal(resolveDefaultLlmProvider({ qwen: { enabled: false }, mimo: { enabled: false }, defaultLlmProvider: "Qwen" }), "MiMo");
});

test("DeepSeek and unknown values are rejected as the default provider", () => {
  assert.throws(() => resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "DeepSeek" }), /只能是 Qwen 或 MiMo/);
  assert.throws(() => resolveDefaultLlmProvider({ ...both, defaultLlmProvider: "openai" }), /只能是 Qwen 或 MiMo，收到「openai」/);
});
