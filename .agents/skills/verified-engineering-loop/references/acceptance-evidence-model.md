# A/B/C/D Acceptance Evidence Model

Use this model twice: first to define acceptance before editing, and again to close the task after verification. Evidence must describe what was actually observed, not merely what a command was intended to check.

## Select evidence before editing

For each layer, write the intended command, entry, input, or inspection and the observable pass condition. Use `N/A` only when that evidence layer cannot materially prove the requested behavior, and state why.

### A — Static validation

Use A evidence for deterministic form and contract properties, including:

- syntax checks;
- type checks;
- schema validation;
- lint and formatting checks;
- builds;
- deterministic invariants and contract checks.

A can prove that code or data has an expected form. It cannot by itself prove runtime integration or user-visible quality.

### B — Automated behavior validation

Use B evidence for repeatable behavior checks, including:

- unit tests;
- integration and regression tests;
- positive and negative cases;
- boundary conditions;
- error-path behavior.

Prefer replaying the original failure and keeping it as regression coverage. Read assertions and output, not only the process exit code or total count.

### C — Real runtime validation

Use C evidence for the actual product or a protocol-equivalent controlled path, including:

- the product CLI;
- a spawned child process;
- the live service route;
- the browser entry;
- a real or controlled provider protocol;
- runtime logs, debug records, state changes, and final artifacts.

Confirm that the process loaded the current code. An import, mock-only unit test, or stale service process is not C evidence for a product entry.

### D — User-visible result validation

Use D evidence for the effect the user can observe, including:

- UI state and interaction;
- error wording and actionable detail;
- output JSON and contract-visible fields;
- workflow outcome;
- story quality or prompt effect;
- final rendered media;
- the user's explicit acceptance criterion or follow-up feedback.

Schema success, field presence, and prompt wording are proxy evidence. They do not prove that a story is engaging, a shot looks correct, or a workflow satisfies the user.

## Evidence discipline

- Do not use A as a substitute for D.
- Do not call a mock a real provider check.
- Do not infer stability or provider generalization from one sample.
- Do not treat a green characterization test as proof that the characterized defect is fixed.
- Record partial success and missing evidence separately.
- If the user reports a visible failure, treat that as D evidence and reopen the acceptance criteria and runtime path.

## Final response template

Use this structure verbatim; add concise detail beneath each item.

```markdown
## 验收证据

### A 静态验证

状态：通过 / 失败 / N/A

执行：

- ...

实际结果：

- ...

### B 自动化行为验证

状态：通过 / 失败 / N/A

执行：

- ...

实际结果：

- ...

### C 真实运行

状态：通过 / 失败 / 未验证 / N/A

入口：

- ...

实际结果：

- ...

### D 用户可见结果

状态：通过 / 部分通过 / 未验证 / N/A

验证内容：

- ...

实际结果：

- ...

### 修改范围

- 修改文件：
- 未修改范围：
- 当前分支：
- 当前 HEAD：

### 未覆盖路径

- ...

### 剩余风险

- ...

### 完成结论

只能根据以上证据描述完成边界，不得过度声称。
```
