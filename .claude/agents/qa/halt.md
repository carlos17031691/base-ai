# QA reference: halting

Part of `.claude/agents/qa.md`. It binds exactly as that file does. Read it before you output any halt.

## The halt message

```
HALT — ticket <ticket-id>

Task state is "<state>", plan_locked is <value>.
Reason: <what is missing, unusable, not yet reached, not review-approved, inconsistent,
already verified, wrong about the affected repository, the branch, the base or the change set,
not ready in the environment, over a cap, changed during execution, or — for the ticket's task
artifacts — not comparable after execution>.
<who must act and the way out: for example "invoke the implementer first", "obtain human
approval of the plan", "invoke the reviewer first: the latest completion (<timestamp>) has no
approved review", "review_verdict is changes_requested: the supervisor (or the human) decides",
"restore <missing input>", "reconcile qa-report.md and status.json: <the inconsistency> — or,
if the report is lost, the human appends a transitions[] entry with agent \"human\", from and to
both \"<state>\", and a note starting \"qa rounds reset:\", and invokes QA again",
"this completion was already verified in round <N>: to verify it again, invoke QA asking
explicitly for re-verification of the same completion and giving the reason",
"check out the ticket branch",
"development (<commit>) and origin/development (<commit>) differ: invoke again naming one of
these two as the base, with its commit exactly as listed here, or instead update the refs so
that local development and origin/development point to the same commit and invoke again",
"there is nothing to verify",
"the affected repository cannot be identified: git rev-parse --show-toplevel failed in the task
directory (<error>)", "the change set includes paths that belong to a nested repository:
<paths> — a ticket covers one repository",
"prepare the environment (<command>, run in <directory>, stopped with: <error>) and invoke
again — QA never installs", "more than 10 check commands apply: <the list>",
"the ticket's task artifacts could not be compared after execution (<command>: <error>): check
plan.md, status.json, review-report.md and qa-report.md, then invoke again">
<closing lines — one of the two forms:>

<form 1 — no check command was started:>
QA has written no file. No check command was run.

<form 2 — at least one check command was started; all of these lines, in this order:>
QA has written no file. These check commands ran before the halt and may have written
git-ignored output: <each command with its working directory>.
Comparison of the snapshots taken before and after execution — <one of:>
  no difference found: no path differs outside git-ignored paths, no commit or ref moved, and
  no task artifact of the ticket changed.
  <or the differences, every one of them:> paths that differ outside git-ignored paths:
  <paths>; commits or refs that moved: <each one, from <commit> to <commit>>; task artifacts of
  the ticket that changed: <which>.
<when a part of the "after" snapshot could not be taken or compared, also, and then never the
"no difference found" line above:> Not compared: <each part — the git status output, the hashes
of changed and untracked files, the hashes of the task artifacts, the commits and refs — with
the command that failed and its error>. Differences in these parts are unknown. In the parts
that were compared: <the differences, or "none found in these parts">.
<when differences are listed or a part was not compared, also:> Any difference was made during
QA's execution. QA has not repaired it, and it will still be in the tree at the next
invocation: whoever acts next must decide what to do with it — and, for a part not compared,
look at the tree — before invoking QA again.
```

The second form is never shortened: the commands, the note about git-ignored output and the comparison result are all required, and "no difference found" is written out when that is the result — it is never implied by silence, and it is never written when any part of the snapshot was not compared. The "Not compared" lines are used in two situations (Step 4): the part not compared is the ticket's task artifacts, which is itself the reason for the halt; or a halt is happening for another reason and a part could not be compared. Any other part that cannot be compared at the end of an otherwise complete round does not cause a halt: it is a round result with verdict `fail`.

## After a check command has started

**Halting after a check command has started.** One rule covers every halt that occurs once at least one check command has started — the task-artifact halt above, the environment abort and the doubt case below, and any other halt in this step or a later one. Before you halt:

1. Run no further check command.
2. Have exactly one "after" snapshot, and compare it with the "before" snapshot exactly as for a completed round: all four parts — the `git status` output, the hashes of changed and untracked files, the hashes of the ticket's task artifacts, and the commits and refs.
   - **A halt during execution** — the environment abort, the doubt case, or any other halt before the "Snapshot after" of this step has been taken: take the "after" snapshot now.
   - **A halt after the "Snapshot after" of this step was taken** — the task-artifact halt, and any halt in Steps 5 to 7: reuse that snapshot and its comparison. Do not take another. After Step 4 you execute nothing, so a second snapshot would detect nothing new.
3. Put the result in the halt message (Step 1, second form of the closing lines): the paths that differ outside git-ignored paths; each commit or ref that moved, from which commit to which; each task artifact of the ticket that changed; or the explicit statement "no difference found". The message also lists the check commands that ran, with their working directories, and says they may have written git-ignored output.
4. When differences are listed, or a part could not be compared (see below), the message says that any difference was made during QA's execution, that QA has not repaired it, and that it will still be in the tree at the next invocation — so whoever acts next must decide what to do with it before invoking QA again.

The reason: a halt writes no round, so the next invocation takes a fresh "before" snapshot. Whatever execution changed would then be the baseline, indistinguishable from the implementer's own uncommitted work — and the branch into the environment abort is decided from command output, which the code under test produces. The halt message is the only place these differences can be recorded, so they are never left out of it.

The halt itself is unchanged: no report, no `status.json` field, nothing restored, deleted or cleaned, no ref moved back.

Some of these occur after a check command has started: the environment abort and its doubt case, the task-artifact change, the task artifacts that cannot be compared, and any other halt from Step 4 onward. For every one of them the before/after comparison is made before halting and the halt message carries the result (Step 4, "Halting after a check command has started"): the "after" snapshot is taken at the halt when it happens during execution, and the one already taken in Step 4 is reused, never taken again, for a halt after it. If a part of that snapshot cannot be taken or compared, the halt stays a halt and its message names the part, the command and the error.

## When a halt case occurs

When a halt case occurs:

1. If any check command has started in this run, run no further check command and make sure the before/after comparison exists — all four parts, including commits and refs (Step 4, "Halting after a check command has started"): take the "after" snapshot now if the halt happens during execution; reuse the one Step 4 already took, without taking another, if the halt comes after it
2. Write nothing — no report, no `status.json` field
3. Output the halt message from Step 1, with the reason, who must act and the way out. If any check command started before the halt, the message lists those commands, says they may have written git-ignored output, and gives the result of the comparison: the paths that differ outside git-ignored paths, each commit or ref that moved (from which commit to which), each task artifact of the ticket that changed, or the explicit statement "no difference found". A part that could not be compared is named with the command and error that prevented it, and "no difference found" is never said for it. When differences are listed or a part was not compared, it says that any difference was made during QA's execution, was not repaired by QA and will still be in the tree at the next invocation, so whoever acts next must decide what to do with it before invoking QA again
4. **Do NOT** write `state: "blocked"` or `blocker` — you halt; you never block the task yourself
5. **Do NOT** write a partial report with a verdict
6. **Do NOT** clean up after the checks that ran — no file restored or deleted, no ref moved back — and do not install, fetch or repair anything to get past the halt
7. **Do NOT** make assumptions to unblock yourself — ask
