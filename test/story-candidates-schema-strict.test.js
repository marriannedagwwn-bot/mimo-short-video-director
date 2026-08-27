import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import {
  OutputContractError,
  ensureOutputContract,
  ensureStoryCandidateContract
} from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

function validCandidates(count = 2) {
  return mockVariants({ creatorProfile, count });
}

function hasDiagnostic(error, code, path) {
  return error instanceof OutputContractError
    && error.details.some((detail) => detail.code === code && detail.path === path);
}

test("strict Story Candidates schema accepts the canonical Mock contract", () => {
  const value = validCandidates(3);
  assert.equal(ensureOutputContract(value, "themeVariants"), value);
  for (const candidate of value.variants) {
    assert.equal(ensureStoryCandidateContract(candidate), candidate);
    for (const field of ["keyChoice", "climax", "emotionalPayoff", "novelty", "visualPotential"]) {
      assert.equal(typeof candidate[field], "string");
      assert.ok(candidate[field].trim());
    }
  }
});

test("strict Story Candidates schema rejects missing, null, wrong-type and unknown fields recursively", () => {
  const cases = [
    {
      mutate(value) { delete value.variants[0].keyChoice; },
      code: "STORY_CANDIDATES_SCHEMA_REQUIRED",
      path: "/variants/0/keyChoice"
    },
    {
      mutate(value) { value.variants[0].climax = null; },
      code: "STORY_CANDIDATES_SCHEMA_TYPE",
      path: "/variants/0/climax"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].estimatedSeconds = "4"; },
      code: "STORY_CANDIDATES_SCHEMA_TYPE",
      path: "/variants/0/storyOutline/0/estimatedSeconds"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].camera = "禁止进入候选契约"; },
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      path: "/variants/0/storyOutline/0/camera"
    },
    {
      mutate(value) { value.variants[0].characterBible = {}; },
      code: "STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD",
      path: "/variants/0/characterBible"
    }
  ];

  for (const fixture of cases) {
    const value = validCandidates();
    fixture.mutate(value);
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => hasDiagnostic(error, fixture.code, fixture.path)
    );
  }
});

test("strict Story Candidates schema rejects empty arrays and required narrative text", () => {
  const cases = [
    {
      mutate(value) { value.variants = []; },
      code: "STORY_CANDIDATES_SCHEMA_MIN_ITEMS",
      path: "/variants"
    },
    {
      mutate(value) { value.variants[0].storyOutline = []; },
      code: "STORY_CANDIDATES_SCHEMA_MIN_ITEMS",
      path: "/variants/0/storyOutline"
    },
    {
      mutate(value) { value.variants[0].storyOutline[0].action = "   "; },
      code: "STORY_CANDIDATES_SCHEMA_EMPTY_STRING",
      path: "/variants/0/storyOutline/0/action"
    },
    {
      mutate(value) { value.variants[0].emotionalPayoff = "\n\t"; },
      code: "STORY_CANDIDATES_SCHEMA_EMPTY_STRING",
      path: "/variants/0/emotionalPayoff"
    }
  ];

  for (const fixture of cases) {
    const value = validCandidates();
    fixture.mutate(value);
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => hasDiagnostic(error, fixture.code, fixture.path)
    );
  }
});

test("Story Candidates require unique ids and strictly ordered 1..N beats", () => {
  const duplicate = validCandidates();
  duplicate.variants[1].id = duplicate.variants[0].id;
  assert.throws(
    () => ensureOutputContract(duplicate, "themeVariants"),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_ID_DUPLICATE", "/variants/1/id")
  );

  for (const invalidBeat of [0, 2, 9]) {
    const value = validCandidates();
    value.variants[0].storyOutline[0].beat = invalidBeat;
    const expectedCode = invalidBeat === 0
      ? "STORY_CANDIDATES_SCHEMA_RANGE"
      : "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID";
    assert.throws(
      () => ensureOutputContract(value, "themeVariants"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => detail.code === expectedCode)
    );
  }

  const skipped = validCandidates();
  skipped.variants[0].storyOutline[1].beat = 3;
  assert.throws(
    () => ensureOutputContract(skipped, "themeVariants"),
    (error) => hasDiagnostic(
      error,
      "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID",
      "/variants/0/storyOutline/1/beat"
    )
  );
});

test("single-candidate helper validates strict shape and beat order without multi-candidate diversity", () => {
  const candidate = validCandidates(1).variants[0];
  assert.equal(ensureStoryCandidateContract(candidate, { path: "variant:V1" }), candidate);

  const unknownField = structuredClone(candidate);
  unknownField.shotPlan = [];
  assert.throws(
    () => ensureStoryCandidateContract(unknownField, { path: "variant:V1" }),
    (error) => hasDiagnostic(error, "STORY_CANDIDATE_SCHEMA_UNKNOWN_FIELD", "/shotPlan")
  );

  const invalidSequence = structuredClone(candidate);
  invalidSequence.storyOutline[2].beat = 9;
  assert.throws(
    () => ensureStoryCandidateContract(invalidSequence, { path: "variant:V1" }),
    (error) => hasDiagnostic(
      error,
      "STORY_CANDIDATE_BEAT_SEQUENCE_INVALID",
      "/storyOutline/2/beat"
    ) && /variant:V1/u.test(error.message)
  );
});
