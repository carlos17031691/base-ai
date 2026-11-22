# Reviewer reference: the halt message

Part of `.claude/agents/reviewer.md`. It binds exactly as that file does. Read it before you output any halt.

```
HALT — ticket <ticket-id>

Task state is "<state>", plan_locked is <value>.
Reason: <what is missing, unusable, not yet reached, inconsistent, already reviewed,
or wrong about the branch, the base or the change set>.
<who must act: for example "invoke the implementer first", "obtain human approval of the plan",
"restore <missing input>", "reconcile review-report.md and status.json: <the inconsistency>",
"this completion was already reviewed in round <N>", "check out the ticket branch",
"development (<commit>) and origin/development (<commit>) differ: invoke again naming one of
these two as the base, with its commit exactly as listed here, or instead update the refs so
that local development and origin/development point to the same commit and invoke again",
"there is nothing to review">
No file has been written.
```
