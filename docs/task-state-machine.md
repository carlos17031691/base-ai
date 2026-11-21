# Task State Machine

Every task tracked through the base-ai multi-agent pipeline follows a strict state lifecycle.
The state lives in `.ai/tasks/<ticket-id>/status.json`.

## States

| State | Meaning | Who sets it |
|---|---|---|
| `pending` | Plan written, awaiting human approval | planner |
| `in_progress` | Implementation underway | implementer (on start) |
| `completed` | Implementation done, checklist populated by the implementer (`false` where no runner exists; QA measures); the supervisor does not gate on these values | implementer (on finish) |
| `validated` | All supervisor gates met on evidence: review approved and QA passed for the same latest completion, reports consistent, post-lock decisions recorded, tech debt registered. Not PR approval | supervisor |
| `blocked` | Escalated to human — no agent may proceed unilaterally | planner or implementer (the reviewer, QA and supervisor halt instead) |

## Transition rules

```
pending ──(human approves plan)──► in_progress   [implementer sets plan_locked=true, assignee=implementer]
in_progress ──(checklist complete)──► completed  [implementer sets checklist fields]
completed ──(all supervisor gates met)──► validated [supervisor only]
completed ──(reviewer or qa fails)──► in_progress  [supervisor names the gate; implementer records the re-entry on an explicit human or supervisor send-back]
any ──(unresolvable blocker)──► blocked            [planner or implementer only; reviewer, QA and supervisor halt instead]
blocked ──(human resolves)──► <previous state>     [human resets manually]
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
2. **Only the implementer** may set `state: "in_progress"` or `state: "completed"`.
3. **`plan.md` is immutable** when `plan_locked: true` — no agent may overwrite it; escalate to human.
4. **The planner and the implementer** may set `state: "blocked"` with a `blocker` description; the reviewer, QA and supervisor halt instead.
5. `transitions[]` is **append-only** — no agent may remove or modify past entries.
6. `state: "validated"` requires `checklist.review_verdict === "approved"` AND `checklist.qa_verdict === "pass"`, both for the same latest implementer completion (the latest reviewer and QA entries name it). The full gate list is in `.claude/agents/supervisor.md`.

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

Or use the `pipeline` skill which includes the initialization steps.
