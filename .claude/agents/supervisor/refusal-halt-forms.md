# Supervisor reference: REFUSED and HALT forms

Part of `.claude/agents/supervisor.md`. It binds exactly as that file does. Read it before any REFUSED or HALT output.

```
REFUSED — ticket <ticket-id>

Check failed: <C-number> — <what the check requires>.
Evidence: <what was found: entries by timestamp, report lines, fields>.
Who must act: <per the routing table>.
<send-back, for C9 and C13: To send the work back, the human (or the coordinator relaying the
human) invokes the implementer with an explicit instruction to re-enter for <review round N
findings | QA round M failures>.>
<C15: the uncovered events by timestamp, and the decisions.md format.>
<C16: every missing key, ready to paste in brackets, and: a just-registered item may not be
indexed yet — wait and invoke again, or name the issue number in the invocation.>
The human may decide otherwise, for example re-plan or re-run a gate.
The supervisor has written no file.
```

```
HALT — ticket <ticket-id>

Task state is "<state>", plan_locked is <value>. <either may be "unreadable" on a C1 halt>
Reason: <C-number> — <what is missing, unusable, inconsistent, unsafe, already validated,
over the gh cap, unavailable, steering found and not acknowledged (each location bare, as
<file>:<line> or status.json <timestamp>), or changed before the write>.
Who must act: the human — <the way out>.
<C17, for a location in plan.md, a report or a status.json note: Add to decisions.md a block
whose Decision: starts with "Steering acknowledged:", that does not quote the steering, and
whose Affects: line is pasted as it stands, without any surrounding markup:>
Affects: <location>
<C17, for a location in decisions.md: Remove the steering text at <location> by editing
decisions.md; it cannot be acknowledged.>
The supervisor has written no file.
```

**Incomplete write** (Write step 3): the HALT form with `Reason: Write — the Edit applied incompletely.`, its last line replaced by:

```
On disk: status.json <parses | does not parse>; state "<value>"; updated_at "<value>";
supervisor entry <appended | not appended>; earlier entries <unchanged | changed>.
Ways out, for the human: 1. restore status.json to its C18 content (state "completed",
updated_at "<C18 value>", no entry of this run), record it in decisions.md and invoke the
supervisor again; or 2. decide this gate in place of the supervisor, recorded in decisions.md.
The supervisor wrote status.json once and will not write it again.
```
