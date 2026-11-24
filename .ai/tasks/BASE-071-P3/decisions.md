# Post-lock decisions: BASE-071-P3

## D1
- Decided: 2026-11-24T18:41:44Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T18:11:16Z (planner `pending → blocked`), 2026-11-24T18:41:44Z (human `blocked → pending` reset)
- Decision: H0, option A. Before planning, the planner found that the scope the human had chosen (an append-only check of `transitions[]` against the PR base in git, and `pipeline check`/`pipeline debt` in CI) assumes task files are versioned, but `.gitignore`, `templates/service/.gitignore` and the `GITIGNORE` block in `cli/src/init.ts` keep everything except `usage.jsonl` local. The human chose to version `status.json`, `plan.md`, `review-report.md`, `qa-report.md`, `decisions.md` and `improvement-report.md` from BASE-071-P3 on; `evidence/` and scratch copies stay ignored; the three policy places, README and `docs/task-state-machine.md` change; existing task directories are not backfilled. The hash chain is dropped from #71.
- Affects: plan.md D1 (ignore policy), H8, AC5, AC8; .gitignore, templates/service/.gitignore, cli/src/init.ts, README.md, docs/task-state-machine.md

## D2
- Decided: 2026-11-24T19:22:07Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T19:22:25Z (implementer `completed → in_progress` re-entry and its `in_progress → completed` at 2026-11-24T19:22:26Z)
- Decision: Before review, the coordinator's E1 found `check:package` exiting 1: `missing from package: .ai/tasks (referenced as `.ai/tasks` in docs/task-state-machine.md)`, from line 117 written in step 3. The human chose that the implementer re-enters only to change that reference to `.ai/tasks/` (the trailing-slash form line 121 already uses, which the check accepts), within the existing Files to touch; then the coordinator re-runs E1.
- Affects: docs/task-state-machine.md:117; evidence/e1.txt; AC7

## D3
- Decided: 2026-11-24T19:33:53Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-24T19:34:20Z (implementer `completed → in_progress` re-entry and its `in_progress → completed` at 2026-11-24T19:34:40Z)
- Decision: After review round 1 (approved; Low L1, L2), the human chose to fix both small own-ticket Lows in this PR and register them as fixed. (L1) The coordinator, as owner of the skills row, changes `.ai/skills/sdlc/skill.md:35` to say "ready for human review" fires once the `cli` (tests, Sonar) and `task-dirs` jobs pass, then runs `ai sync`. (L2) The implementer re-enters to add one sentence each to `README.md` (the `pipeline ci` bullet) and `docs/task-state-machine.md:117`: a base `status.json` over 2 MiB fails A1 naming `base` (exit 1, not a G4 halt), and a directory id outside `^[A-Za-z0-9#._-]+$` fails `D0 dir.name` (JSON `name`). Then review round 2 and QA round 2. L1 is registered on #106 and L2 on #104, both as fixed.
- Affects: .ai/skills/sdlc/skill.md and its exports, README.md, docs/task-state-machine.md; AC7
