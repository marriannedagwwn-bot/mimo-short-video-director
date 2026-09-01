---
name: verified-engineering-loop
description: Apply an evidence-driven engineering loop to code changes, debugging, refactoring, test repair, schemas, prompts, workflows, providers, workers, services, and user-visible behavior. Use before editing and through final verification when a task may modify production behavior. Requires reproducible evidence, falsifiable hypotheses, targeted and regression tests, product-entry validation, and an A/B/C/D evidence closeout. Do not use for read-only questions or purely editorial changes.
---

# Verified Engineering Loop

Use this skill to carry a behavior-changing task from intent through evidence-backed acceptance. Optimize for a correct, observable result, not for a green command or a large patch.

## Activation boundary

Invoke this skill before editing when a task may:

- fix or debug a bug;
- modify production code or tests and their corresponding behavior;
- change a prompt, schema, data contract, workflow stage, provider, worker, service, frontend/backend interaction, or user-visible result;
- refactor code in a way that may affect runtime behavior;
- investigate or fix nondeterminism, stability, or model-generation quality;
- continue work after tests pass but the real result is wrong, or after the user says the result still misses the expectation.

Do not require this loop for read-only explanation, read-only browsing, simple file lookup, purely editorial wording, behavior-neutral document layout, or analysis that the user explicitly says must not modify code. If analysis and modification are combined, invoke the skill as soon as production behavior may change.

Repository `AGENTS.md` files remain authoritative. Read every applicable root and nested rule before acting; apply the stricter compatible requirement when this skill and repository rules overlap.

## Reference routing

- Read [references/acceptance-evidence-model.md](references/acceptance-evidence-model.md) before defining acceptance and again before the final response.
- Read [references/repository-lessons.md](references/repository-lessons.md) only when the task touches LLM structured generation or repair, validation gates, story/prompt/generation quality, providers, workers, services, or this repository's runtime entries.
- Treat `docs/claude-workflow-analysis.md` as the full historical authority. Consult it only when a conclusion, precedent, evidence strength, or completion boundary needs the complete case record. Do not rescan raw Claude sessions for routine use of this skill.

## 1. Run startup checks

Before editing, record:

```sh
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
```

Then:

- locate the root and applicable nested `AGENTS.md` files;
- inspect existing user changes before touching overlapping files;
- identify the tests, build commands, product start command, CLI, service, browser, provider, or worker entry relevant to the task;
- determine whether a running process must be restarted after the change.

Never assume the worktree is clean. Do not overwrite, stage, revert, or claim ownership of a change whose provenance is uncertain. Keep the task patch separate from pre-existing work.

## 2. Define acceptance evidence

Before changing code, write the expected evidence for every applicable layer in the A/B/C/D model:

- **A — Static validation:** syntax, types, schema, lint, build, or deterministic contract checks.
- **B — Automated behavior:** unit, integration, regression, positive, negative, boundary, and error-path tests.
- **C — Real runtime:** the actual CLI, spawned process, service, browser, or equivalent provider protocol; confirm the running code version and inspect logs, debug evidence, state, and final artifacts.
- **D — User-visible result:** UI, errors, JSON, workflow output, story quality, final video, or the exact observable effect the user requested.

For each layer, name the command or inspection and the expected result. Mark an inapplicable layer `N/A` only with a reason. Never substitute A for D. Use the detailed evidence-selection rules in the acceptance reference.

## 3. Investigate the complete path

Read the smallest complete production and consumption chain needed to explain the behavior. Depending on scope, inspect:

- data producer and authoritative upstream source;
- caller and orchestration path;
- downstream consumers;
- validators and deterministic contracts;
- prompt and schema;
- provider and worker;
- service or CLI entry;
- UI presentation;
- existing tests and fixtures.

Do not stop at the line that throws. For a data-contract change, explicitly list the producer, every relevant consumer, validator, prompt/schema boundary, and tests. State the authority source and conflict priority before implementing automatic derivation or repair.

## 4. Reproduce and diagnose

For a reproducible defect, first use the user's real failing input. If that is unavailable, build the smallest counterexample that faithfully represents the failure.

Record:

- current behavior;
- expected behavior;
- the layer where the failure first appears;
- a falsifiable root-cause hypothesis;
- the observation that would disprove that hypothesis.

One stable counterexample proves that a deterministic defect exists. It does not establish success rate, stability, generalization, cross-provider behavior, or end-to-end reliability. Use enough diverse paths and samples before making probabilistic claims.

## 5. Make hypothesis-bound changes

Every change must map to one stated hypothesis. Prefer the smallest change that explains the root cause and:

- derives authoritative values deterministically from the trusted upstream when possible;
- reduces the model's writable surface;
- preserves existing error semantics and field responsibilities;
- leaves unrelated paths unchanged.

When new evidence disproves the hypothesis, explicitly withdraw it and return to diagnosis. Do not stack patches on a rejected explanation. Do not refactor, rename, reformat, or optimize unrelated code opportunistically.

## 6. Validate in order

After the edit, validate in this order:

1. replay the same real failing input or counterexample;
2. run the smallest targeted test;
3. run positive, negative, boundary, and error-path checks for the changed contract;
4. run the necessary full regression suite;
5. exercise the actual product entry;
6. inspect the user-visible result;
7. run `git diff --check`;
8. review the complete `git diff`;
9. review `git status`.

When a test fails, read the exact assertion, error path, and output before changing code. Classify whether the failure is product behavior, environment, or a now-invalid test assumption.

Never manufacture success by:

- looking only at an exit code or test count;
- rerunning until a flaky path happens to pass;
- deleting a correct assertion or validation;
- loosening a correct contract;
- skipping a failing test;
- reporting only passing samples.

If an authoritative contract change invalidates an old assertion, explain why and add new-contract positive and negative coverage.

## 7. Exercise the product entry

An import test does not replace the product's CLI, spawned child process, service, browser, or provider entry.

After changing server, worker, provider, or runtime code:

- identify the exact entry used by the user's request;
- check the running process start time and whether it loaded the changed code;
- restart when required by repository rules;
- verify which route, provider, worker, and configuration the request actually used;
- inspect the real or protocol-equivalent output, logs, debug record, state transition, or artifact.

Do not diagnose new code from an old process.

## 8. Enforce the completion boundary

Do not claim “fully solved” when any required condition remains unverified, including:

- only static checks or unit tests passed;
- the actual product entry was not exercised;
- the required real provider path was not checked;
- the user-visible result was not inspected;
- a probabilistic claim has too few samples;
- a real success path lacks logs, debug evidence, state, or artifacts;
- the current branch does not contain the verified change;
- the user still reports that the outcome misses the expectation.

State narrower conclusions when supported, such as:

- code path fixed;
- targeted tests passed;
- regression suite passed;
- real runtime passed;
- user-visible effect not yet verified;
- cross-provider generalization not established.

## Required closeout

End every task governed by this skill with the exact section structure in [references/acceptance-evidence-model.md](references/acceptance-evidence-model.md). Include actual commands or entries, observed results, changed and untouched scope, branch and HEAD, uncovered paths, and residual risk. Derive the completion claim only from that evidence.
