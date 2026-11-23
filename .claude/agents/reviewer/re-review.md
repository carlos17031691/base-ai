# Reviewer reference: re-review rounds

Part of `.claude/agents/reviewer.md`. It binds exactly as that file does. Read it when the Step 1 dispatch chose Round N+1.

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
