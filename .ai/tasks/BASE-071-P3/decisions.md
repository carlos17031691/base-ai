# Post-lock decisions: BASE-071-P3

## D1
- Decided: 2026-11-24T18:41:44Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T18:11:16Z (planner `pending → blocked`), 2026-11-24T18:41:44Z (human `blocked → pending` reset)
- Decision: H0, option A. Before planning, the planner found that the scope the human had chosen (an append-only check of `transitions[]` against the PR base in git, and `pipeline check`/`pipeline debt` in CI) assumes task files are versioned, but `.gitignore`, `templates/service/.gitignore` and the `GITIGNORE` block in `cli/src/init.ts` keep everything except `usage.jsonl` local. The human chose to version `status.json`, `plan.md`, `review-report.md`, `qa-report.md`, `decisions.md` and `improvement-report.md` from BASE-071-P3 on; `evidence/` and scratch copies stay ignored; the three policy places, README and `docs/task-state-machine.md` change; existing task directories are not backfilled. The hash chain is dropped from #71.
- Affects: plan.md D1 (ignore policy), H8, AC5, AC8; .gitignore, templates/service/.gitignore, cli/src/init.ts, README.md, docs/task-state-machine.md
