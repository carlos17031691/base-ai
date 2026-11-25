# Post-lock decisions: BASE-140-B

## D1
- Decided: 2026-11-25T01:39:00Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-25T01:41:31Z
- Decision: Send-back after review round 1 (changes_requested, M1 and L1–L4). The human chose to fix every finding in this PR ("fix all in this PR", 2026-11-25) instead of registering the Lows on #106. The implementer re-entered to fix M1, L2, L3 and L4 in its files (docs/task-state-machine.md, README.md, .claude/agents/planner.md). The coordinator fixed L1 in the coordinator-owned cli/src/pipeline-plan.ts: with a NAME=value prefix and an unknown lenient head, the head is re-read from the tokenized words, and a prefix that does not tokenize fails with its tokenizer reason. A new R2 test in cli/src/test/pipeline-plan.test.ts covers it. No Low from round 1 is registered as debt.
- Affects: docs/task-state-machine.md, README.md, .claude/agents/planner.md, cli/src/pipeline-plan.ts, cli/src/test/pipeline-plan.test.ts, AC1, AC7, AC8, AC10
