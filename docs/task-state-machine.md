# Task State Machine

Every task tracked through the base-ai multi-agent pipeline follows a strict state lifecycle.
The state lives in `.ai/tasks/<ticket-id>/status.json`.

## States

| State | Meaning | Who sets it |
|---|---|---|
| `pending` | Plan written, awaiting human approval | planner |
| `in_progress` | Implementation underway | implementer (on start) |
| `completed` | Implementation done, all checklist items true | implementer (on finish) |
| `validated` | Reviewer approved + QA passed + supervisor signed off | supervisor |
| `blocked` | Escalated to human — no agent may proceed unilaterally | any agent |

## Transition rules

```
pending ──(human approves plan)──► in_progress   [implementer sets plan_locked=true, assignee=implementer]
in_progress ──(checklist complete)──► completed  [implementer sets checklist fields]
completed ──(reviewer + qa both pass)──► validated [supervisor only]
completed ──(reviewer or qa fails)──► in_progress  [supervisor routes back]
any ──(unresolvable blocker)──► blocked            [any agent may escalate]
blocked ──(human resolves)──► <previous state>     [human resets manually]
```

## File layout

```
.ai/tasks/
└── <ticket-id>/
    ├── status.json           ← state machine (see templates/task/status.json)
    ├── plan.md               ← planner output; LOCKED after human approval
    ├── review-report.md      ← reviewer output; immutable after supervisor reads
    ├── qa-report.md          ← qa output; immutable after supervisor reads
    └── improvement-report.md ← improvement agent output; human reviews before applying
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
4. **Any agent** may set `state: "blocked"` with a `blocker` description.
5. `transitions[]` is **append-only** — no agent may remove or modify past entries.
6. `state: "validated"` requires `checklist.review_verdict === "approved"` AND `checklist.qa_verdict === "pass"`.

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
