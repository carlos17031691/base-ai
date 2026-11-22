# Task State Machine

Every task tracked through the base-ai multi-agent pipeline follows a strict state lifecycle.
The state lives in `.ai/tasks/<ticket-id>/status.json`.

## States

| State | Meaning | Who sets it |
|---|---|---|
| `pending` | Plan written, awaiting human approval | planner |
| `in_progress` | Implementation underway | implementer (on start) |
| `completed` | Implementation done, checklist populated by the implementer (`false` where no runner exists; QA measures); the supervisor does not gate on these values | implementer (on finish); human, only to withdraw a validation |
| `validated` | All supervisor gates met on evidence: review approved and QA passed for the same latest completion, reports consistent, post-lock decisions recorded, tech debt registered. Not PR approval | supervisor |
| `blocked` | Escalated to human — no agent may proceed unilaterally | planner or implementer (the reviewer, QA and supervisor halt instead); the human resets it to the previous state |

## Transition rules

```
pending ──(human approves plan)──► pending       [planner sets plan_locked=true on approval given to it; otherwise the coordinator records the human's lock entry]
pending ──(implementer claims)──► in_progress    [implementer sets assignee=implementer; asserts plan_locked, never writes it]
in_progress ──(checklist complete)──► completed  [implementer sets checklist fields]
completed ──(all supervisor gates met)──► validated [supervisor only]
validated ──(finding after validation)──► completed [human only: withdraws the validation, recorded in decisions.md; an explicit send-back follows]
completed ──(reviewer or qa fails)──► in_progress  [supervisor names the gate; implementer records the re-entry on an explicit human or supervisor send-back]
any ──(unresolvable blocker)──► blocked            [planner or implementer only; reviewer, QA and supervisor halt instead]
blocked ──(human resolves)──► <previous state>     [human resets manually, or the implementer re-enters blocked → in_progress on an explicit human instruction]
```

## File layout

```
.ai/tasks/
└── <ticket-id>/
    ├── status.json           ← state machine (see templates/task/status.json)
    ├── plan.md               ← planner output; LOCKED after human approval
    ├── review-report.md      ← reviewer output; existing content never edited; owners append rounds
    ├── qa-report.md          ← qa output; existing content never edited; owners append rounds
    ├── decisions.md          ← post-lock human decisions; written by the human/coordinator only
    └── improvement-report.md ← improvement agent output; human reviews before applying
```

`decisions.md` format — one block per decision; each `Covers:` timestamp is a `transitions[]` entry the decision explains:

```markdown
# Post-lock decisions: <ticket-id>

## D1
- Decided: <UTC timestamp>
- Decided by: human
- Recorded by: <human | coordinator>
- Covers: <timestamp of each transitions[] entry this decision explains, comma-separated>
- Decision: <what was decided>
- Affects: <files, sections, criteria>
```

## status.json schema

```jsonc
{
  "ticket_id": "string",           // e.g. "46", "BASE-046", "CU-86a1b2"
  "state": "pending | in_progress | completed | validated | blocked",
  "plan_locked": "boolean",        // true = plan.md is immutable
  "assignee": "string | null",     // current responsible agent role
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "transitions": [                 // append-only audit log
    {
      "from": "string",
      "to": "string",
      "agent": "string",           // role name, e.g. "implementer"
      "timestamp": "ISO-8601",
      "note": "string"             // brief reason
    }
  ],
  "checklist": {
    "tests_pass": "boolean",
    "lint_pass": "boolean",
    "types_pass": "boolean",
    "review_verdict": "approved | changes_requested | null",
    "qa_verdict": "pass | fail | null"
  },
  "blocker": "string | null"       // description when state=blocked
}
```

## Invariants (all agents must enforce)

1. **Only the supervisor** may set `state: "validated"`.
2. **Only the implementer** may set `state: "in_progress"` or `state: "completed"`, except two human acts, each recorded in `decisions.md`: resetting `blocked` to its previous state, and withdrawing a validation (`validated → completed`).
3. **`plan.md` is immutable** when `plan_locked: true` — no agent may overwrite it; escalate to human.
4. **The planner and the implementer** may set `state: "blocked"` with a `blocker` description; the reviewer, QA and supervisor halt instead.
5. `transitions[]` is **append-only** — no agent may remove or modify past entries.
6. `state: "validated"` requires `checklist.review_verdict === "approved"` AND `checklist.qa_verdict === "pass"`, both for the same latest implementer completion (the latest reviewer and QA entries name it). The full gate list is in `.claude/agents/supervisor.md`.

**Mechanical check.** `base-ai pipeline check <task-dir> [--json] [--root <dir>]` is read-only and exits 0 only when no check fails; a relative `<task-dir>` resolves against `--root`. It applies the rules of `supervisor.md@682c6e4` to every directory, older ones included, and runs all 18 checks without stopping at the first failure: K1 `status.parse`, K2 `status.ticket`, K3 `plan.steps`, K4 `state`, K5 `transitions.order`, K6 `lock`, K7 `completion`, K8 `review.present`, K9 `review.consistency`, K10 `review.binding`, K11 `review.verdict`, K12 `qa.present`, K13 `qa.consistency`, K14 `qa.binding`, K15 `qa.verdict`, K16 `register.keys`, K17 `decisions.format`, K18 `decisions.covers`. A check whose dependency failed is skipped and names it. The round-1 header line may be `Round: 1`, `- Round: 1` or `- **Round:** 1`. An appended round's verdict line is "verdict", an optional short qualifier, a colon, then the word (for example `### Verdict (round 2 — authoritative): approved`). K16 counts a `To register` marker (a table cell that is exactly `To register`, or the literal `**To register**` / `**To register.**`) and prints its key and `file:line`; nothing inside an inline code span or a code fence counts. K17 reads `decisions.md` (absent passes): every `## ` heading outside a fence is `## D<n>` (no leading zero); each block has each of `Decided`, `Decided by`, `Recorded by`, `Covers`, `Decision` and `Affects` exactly once with a non-empty value, as a column-0 line written `Label:` or `**Label:**`, optionally after `- ` or `* `; a `Covers:` value is `none`, allowed only when `Decision:` starts with `Steering acknowledged:`, or comma-separated items, each a `transitions[]` timestamp optionally followed by one `(note)` that may contain commas. K18 requires every event after the lock entry to be a `Covers:` timestamp: each `human` entry (resets included), each implementer `blocked → in_progress`, and each implementer `completed → in_progress` unless the latest reviewer or QA entry since the previous completion is `review round <N>: changes_requested` or `qa round <N>: fail` naming that completion; it lists each uncovered event as `<timestamp> (<kind>)`. Registration is checked by `base-ai pipeline debt <task-dir> [--issues <n,…>] [--json] [--root <dir>]`, opt-in network: it reads `owner/name` from the `origin` remote, views `--issues` first, then searches each unconfirmed key with `gh` (60-second timeout per call, at most 60 `gh` calls, one at a time), and counts a key only when `[<key>]` is literally in an issue body or comment. It exits 0 when every key is registered, 1 when one is missing or the keys were not computed, and 2 when it could not check, which is never treated as registered. Neither command checks steering or the branch, and no agent reads their output yet (P4).

## Initializing a task

```bash
# Copy the templates into a new task directory
TICKET=46
mkdir -p .ai/tasks/$TICKET
cp templates/task/status.json .ai/tasks/$TICKET/
cp templates/task/plan.md .ai/tasks/$TICKET/
cp templates/task/review-report.md .ai/tasks/$TICKET/
cp templates/task/qa-report.md .ai/tasks/$TICKET/
cp templates/task/improvement-report.md .ai/tasks/$TICKET/

# Edit status.json: set ticket_id and created_at
```

The planner does this in its Step 1 (`.claude/agents/planner.md`). The `pipeline` skill summarises the whole protocol and who acts next; it creates no files.
