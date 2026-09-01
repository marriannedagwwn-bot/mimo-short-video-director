# Repository-Specific Lessons

These lessons apply only to the scopes named below. They are the compact operational subset of `docs/claude-workflow-analysis.md`; use the [full analysis](../../../../docs/claude-workflow-analysis.md) when case details or evidence confidence matter.

## LLM structured generation and bounded repair

Scope: LLM generation, structured output, and local repair only.

- Require the model to return only the minimum `replacement`, `addition`, or `insertion`.
- Keep authoritative source text, path, digest, authority, frozen fields, merge logic, and complete revalidation under deterministic code control.
- Do not require the model to reproduce a long source passage byte for byte.
- Re-run the complete stage validation after merging a local repair.
- Do not use whole-object or whole-section rewriting as the default repair mechanism.

## New hard validation gates

Scope: workflow and generation pipelines only.

Before adding a hard validator, inspect:

- historical or replayed hit rate;
- failure cost;
- whether the validator runs after an expensive model/provider call;
- whether one safe, bounded local repair exists;
- whether the repaired result will pass the complete validator again.

Allow one bounded repair only when the error can be localized safely, the merge is deterministic, and complete revalidation is available. Fail closed when the correct repair cannot be derived safely. Do not add a high-hit hard gate without first defining its recovery and cost boundary.

## Story, prompt, and generation quality

Scope: story generation, prompts, animation plans, images, video, and other model-generated user outcomes.

- Schema success does not prove that a story is engaging.
- Complete fields do not prove that the visual result meets the request.
- Literal prompt compliance does not prove effect compliance.
- Prove that a proxy metric measures the user's actual problem before using it as acceptance evidence.
- Treat user feedback on a real story or rendered result as D-layer evidence.
- Never use unit tests to dismiss a user-observed failure.

## Provider, worker, and service paths

Scope: provider adapters, workers, server routes, CLIs, and runtime integration.

- A local mock does not replace the real provider protocol.
- Verify provider-specific request/response requirements with the real protocol or a faithful controlled equivalent.
- An import test does not replace worker child-process execution.
- After a service change, confirm that the running process loaded the updated code.
- Do not generalize a result from one provider to another provider.

## This repository's verification entries

Use Node 24 as required by `.nvmrc` and `package.json` (`>=24 <25`). Current repository entries are:

- full test suite: `npm test` (`node --test`);
- targeted Node test: `node --test test/<relevant-file>.test.js`;
- production service: `npm start` (`node server.js`);
- watch service: `npm run dev` (`node --watch server.js`);
- product CLI: `npm run run:video` (`node bin/run-video.js`);
- generic provider worker: `src/shot-video-generator.js` executes `workers/generic-http-worker.mjs` in a separate Node process; worker changes require a child-process path check, not import-only coverage.

When server-side code changes, restart or otherwise prove that the active service loaded the new code before interpreting product behavior. When historical evidence names a commit, verify that the current branch contains it before claiming the behavior is present now.
