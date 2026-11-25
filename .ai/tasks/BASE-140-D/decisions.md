# Post-lock decisions: BASE-140-D

## D1
- Decided: 2026-11-25T14:59:00Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-25T15:00:19Z
- Decision: Send-back before any review round. The coordinator's E1 run of `npm --prefix cli run check:package` failed: the D2 sentence appended to the **CI check** paragraph of `docs/task-state-machine.md` named `docs/operations/runbooks/branch-rulesets.md` in inline code, and `docs/task-state-machine.md` ships in the npm package (`SHIPPED_DOCS`, `cli/src/shipped.ts:7`) while the runbook does not. The plan's D5 note wrongly assumed all of `docs/` ships (a plan defect; the implementer wrote D2 verbatim). The human chose to reword the phrase to plain words ("applied by the human as this repository's branch-rulesets runbook describes") rather than ship the runbook (against H5) or drop the mention. The implementer re-entered and changed only that phrase; `check:package` then passed.
- Affects: docs/task-state-machine.md (plan D2 text and the D5 `check:package` note); no acceptance criterion

## D2
- Decided: 2026-11-25T15:04:00Z
- Decided by: human
- Recorded by: coordinator
- Covers: 2026-11-25T14:26:08Z, 2026-11-25T14:28:09Z, 2026-11-25T15:01:33Z
- Decision: Correction of three implementer transition timestamps that were written by hand instead of read from the clock, which made `pipeline check` K5 (`transitions.order`) fail. On the human's authorization the coordinator changed only the `timestamp` field of these entries, to times taken from evidence: claim 15:00:00Z → 14:26:08Z (the coordinator turn that invoked the implementer ended at 14:26:08Z per `usage.jsonl`, after the lock at 14:25:45Z); first completion 15:20:00Z → 14:28:09Z (the implementer's own `usage.jsonl` record at 14:28:09Z; commit 39d9787 at 14:28:21Z); second completion 15:03:00Z (later than the clock when written) → 15:01:33Z (the last modification time of `status.json` by that run). The re-entry at 15:00:19Z is unchanged. No other field of any entry changed. This is a one-off human correction, not a precedent for editing `transitions[]`.
- Affects: .ai/tasks/BASE-140-D/status.json (transitions[2], [3], [5] timestamp only); no acceptance criterion
