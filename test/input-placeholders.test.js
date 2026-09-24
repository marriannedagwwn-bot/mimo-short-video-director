import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");

function placeholderFor(id) {
  const match = new RegExp(`<[^>]+id="${id}"[^>]+placeholder="([^"]*)"`, "u").exec(html);
  assert.ok(match, `missing placeholder for #${id}`);
  return match[1];
}

test("creator profile placeholders explain rules without prescribing example characters or niches", () => {
  const fixedCharacter = placeholderFor("fixedCharacter");
  const vertical = placeholderFor("vertical");
  const expressionRules = placeholderFor("characterExpressionRules");

  assert.match(fixedCharacter, /身份、外观、性格/u);
  assert.doesNotMatch(fixedCharacter, /阿岚|例：/u);
  assert.match(vertical, /内容领域、题材边界与目标受众/u);
  assert.doesNotMatch(vertical, /家电维修|宠物救助|乡村美食|例：/u);
  assert.match(expressionRules, /情绪 = 可见特征/u);
  assert.doesNotMatch(expressionRules, /芙芙猫|例：/u);
});

test("fixed-character and expression guidance is no longer duplicated as always-visible hint text", () => {
  assert.doesNotMatch(html, /<small class="field-hint">写性格、处事方式和习惯动作/u);
  assert.doesNotMatch(html, /<small class="field-hint">写「情绪 = 可见特征」/u);
});
