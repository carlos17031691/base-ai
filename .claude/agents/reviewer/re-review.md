# Reviewer reference: re-review rounds

Part of `.claude/agents/reviewer.md`. It binds exactly as that file does. Read it when the Step 1 dispatch chose Round N+1 or the delta row.

**Round N+1 (re-review).** **Append** a section headed `## Round <N> re-review`, where `<N>` is the number of the new round (the second round is `## Round 2 re-review`). It contains:

- the real UTC timestamp, and the implementer `→ completed` transition reviewed in this round (its `timestamp`)
- the branch, base ref, merge-base commit and commits under review of this round's change set (Step 2)
- this round's base choice (Step 2), in the same words as in round 1: the two differing refs and the ref this run's invocation chose, or "none needed" — never a choice carried over from an earlier round
- the status of **every** High and Medium finding of earlier rounds: Fixed / Not fixed, with evidence (`file:line`) taken from the current change set — never from a statement that the finding was fixed, waived or accepted
- new findings, by severity, in the same form as round 1
- the scope-check result for the current change set
- the acceptance-criteria table
- the Security section, headed `### Security`, complete and for the current change set (Step 4, Step 7): boundary and method decided again, every category row present
- this round's verdict

Earlier rounds are never edited — not their findings, not their tables, and not the top `## Verdict` line, which keeps showing the round 1 verdict. The latest round's verdict is the authoritative one, and the report says so.

**Delta round (Step 1 delta row).** The base is the latest round's HEAD if it was a delta, else its newest commit under "commits under review", else its merge-base; if `git merge-base --is-ancestor <base> HEAD` fails, halt. The delta change set is `git diff --name-status <base>`, `git diff <base>` and `git ls-files --others --exclude-standard`; an empty delta is a halt. **Append** `## Round <N> re-review (delta)` with:

- the timestamp, and the same implementer completion as round <M> (the approved round before it), stated unchanged
- the base, HEAD and commits since the base
- the Low ids, "as given by the invocation"
- per named Low: Fixed / Not fixed, with `file:line`
- the scope check of the delta files against "Files to touch" (outside it: blocking)
- each hunk is explained by a named Low, or it is a **Medium**: a change outside the named Low fixes needs a new implementer completion. Pipeline artefacts in `.ai/tasks/<ticket-id>/` (owners' rounds, `status.json` entries in permitted fields, `usage.jsonl`) are exempt
- new findings of the delta (new Lows carry `To register`)
- the acceptance-criteria table: a row whose evidence the delta does not touch is "Met (round <M>; evidence not touched by the delta)"; a row it touches is traced again
- a complete `### Security` section for the delta, and the verdict

The Step 8 note keeps its form, with `delta of round <M> from <base>; ` before `reviewed implementer completion <timestamp>`.
