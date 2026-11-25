# Task State Machine

Every task tracked through the base-ai multi-agent pipeline follows a strict state lifecycle.
The state lives in `.ai/tasks/<ticket-id>/status.json`.

## States

| State | Meaning | Who sets it |
|---|---|---|
| `pending` | Plan written, awaiting plan review and human approval | planner |
| `in_progress` | Implementation underway | implementer (on start) |
| `completed` | Implementation done, checklist populated by the implementer (`false` where no runner exists; QA measures); the supervisor does not gate on these values | implementer (on finish); human, only to withdraw a validation |
| `validated` | All supervisor gates met on evidence: review approved and QA passed for the same latest completion, reports consistent, the latest review round's Security section well-formed, post-lock decisions recorded, tech debt registered. Not PR approval | supervisor |
| `blocked` | Escalated to human — no agent may proceed unilaterally | planner or implementer (the reviewer, QA and supervisor halt instead); the human resets it to the previous state |

## Transition rules

```
pending ──(human approves plan)──► pending       [only after an approved plan review of the committed plan.md (see **Plan review** below); planner sets plan_locked=true on approval given to it; otherwise the coordinator records the human's lock entry]
pending ──(reviewer plan review)──► pending      [plan-review mode writes plan-review.md only: no status.json field, no transitions[] entry]
pending ──(implementer claims)──► in_progress    [implementer sets assignee=implementer; asserts plan_locked, never writes it]
in_progress ──(checklist complete)──► completed  [implementer sets checklist fields]
completed ──(all supervisor gates met)──► validated [supervisor only]
validated ──(finding after validation)──► completed [human only: withdraws the validation, recorded in decisions.md; an explicit send-back follows]
completed ──(reviewer or qa fails)──► in_progress  [supervisor names the gate; implementer records the re-entry on an explicit human or supervisor send-back]
completed ──(own-ticket Low fixes after an approved round)──► completed [delta re-review: reviewer entry naming the same completion; no implementer re-entry]
any ──(unresolvable blocker)──► blocked            [planner or implementer only; reviewer, QA and supervisor halt instead]
blocked ──(human resolves)──► <previous state>     [human resets manually, or the implementer re-enters blocked → in_progress on an explicit human instruction]
```

**Delta re-review.** After an approved review round, the coordinator may fix the ticket's own Low findings, on the human's instruction, in files listed in "Files to touch", and commit them; the reviewer then runs a delta round (`## Round <N> re-review (delta)`) of those fixes against the newest commit the approved round reviewed (`reviewer/re-review.md`). It names the same implementer completion as the approved round, so there is no implementer re-entry. QA runs after it: QA round 1 if none exists, else a same-completion re-verification whose invocation gives the delta as the reason (K14 fails a QA round recorded before the delta). The supervisor validates on the delta round (K10, K11) and on a QA round after it (K14, K15), unchanged. A `changes_requested` delta goes to the ordinary send-back and a full next round.

**Plan review.** Before the lock, the reviewer reads `plan.md` against the code it changes in plan-review mode (`.claude/agents/reviewer/plan-review.md`) and appends a round to `plan-review.md`. It answers where else each changed rule is stated and which existing guard or bypass the change touches, and runs the plan checks. The gate: the lock requires (a) the latest round `approved` and (b) `git log -1 --format=%H -- <plan>` printing that round's plan commit with a clean `git status --porcelain -- <plan>`; the lock note names the round and the commit. The coordinator commits `plan.md` before each round, after the human's answers are in the plan, and any later change to `plan.md` needs a new round. The mode writes no `status.json` field and no `transitions[]` entry (a reviewer entry would count as a code-review round in K8-K10). The gate is enforced by instruction only: `pipeline check` does not read `plan-review.md`. Task directories locked before it are not backfilled.

## File layout

```
.ai/tasks/
└── <ticket-id>/
    ├── status.json           ← state machine (see templates/task/status.json)
    ├── plan.md               ← planner output; LOCKED after human approval
    ├── plan-review.md        ← reviewer output (plan-review mode), before the lock; one round per reviewed plan commit, appended
    ├── review-report.md      ← reviewer output; existing content never edited; owners append rounds
    ├── qa-report.md          ← qa output; existing content never edited; owners append rounds
    ├── decisions.md          ← post-lock human decisions; written by the human/coordinator only
    ├── improvement-report.md ← improvement agent output; human reviews before applying
    ├── usage.jsonl           ← token usage; written by the usage hook or the coordinator, never by an agent role; versioned
    └── evidence/             ← command output kept by the coordinator and QA's check logs; git-ignored (local)
```

From BASE-071-P3 on, `status.json`, `plan.md`, `plan-review.md`, `review-report.md`, `qa-report.md`, `decisions.md`, `improvement-report.md` and `usage.jsonl` are versioned and reach the PR with the branch; `evidence/`, scratch copies (`.ai/tasks/<name>.scratch/`) and `.ai/usage/` are git-ignored. Directories created before P3 are not backfilled; the root `.gitignore` keeps them local. Agents never commit: the coordinator commits the task files with each step's commit and once more after validation.

`usage.jsonl` holds one `UsageRecord` per line, appended by `base-ai usage record`, which runs as a Claude Code `SubagentStop`/`Stop` hook (set up by `ai sync`, below):
`{"schema":1,"ts","ticket","agent","model","effort"?,"session_id","first_message_id","last_message_id","messages","input_tokens","cache_creation_input_tokens","cache_read_input_tokens","output_tokens","source":"claude-code-hook","attribution"}`.
A record is written per model and reasoning effort; `effort` (`low`, `medium`, `high`, `xhigh` or `max`) is present only when the transcript gives it, and readers ignore it.
Only counters and ids are stored, never prompt or response text. The ticket is `BASE_AI_TICKET` if it names an existing task directory (`attribution: "env"`), else the longest `-`-prefix of the branch's last segment that does (`"branch"`), else the record goes to `.ai/usage/unattributed.jsonl` (git-ignored) with `ticket: null` and `"none"`. Each assistant `message.id` counts once; a record covers only the messages after the session's high-water mark (the latest recorded `last_message_id` in the transcript). `agent` is `coordinator` for `Stop`; for `SubagentStop` it is the subagent type, else the agent of the latest `status.json` transition, else `unknown`. The command always exits 0, prints nothing on stdout and writes one stderr line on failure, an uncaught exception included.

**Hook setup.** `usage.hook` in `.ai/config.yaml` is `claude-code` or `none`; absent means `none`, and any other value fails `ai sync`, `ai stats` and `doctor`, naming the key. With `claude-code`, `ai sync` writes one generated group into each of `hooks.SubagentStop` and `hooks.Stop` of the root's `.claude/settings.json`, replacing any earlier generated hook under any event, another event included; with `none` it removes the generated hooks and the groups, events, `hooks` object and file that removal left empty. A hook is generated when its command contains `generated by base-ai`. Every other key, group and hook keeps its order and value; the file is rewritten (two-space JSON) only when it changes, and never listed in the generated-artefact lock. With `claude-code`, or when the file's text contains `generated by base-ai` anywhere (in a command or not), a file that is not a JSON object with a `hooks` object of arrays makes `ai sync` fail, naming it, before it writes any artefact. With `none` (or `usage` absent), a file whose text does not contain `generated by base-ai` is left alone: it is neither parsed nor rewritten, and `doctor` does not report it. The command is:

```
node "$CLAUDE_PROJECT_DIR/<cli>" usage record --root "$CLAUDE_PROJECT_DIR" # generated by base-ai
```

`<cli>` is `cli/dist/index.js` when `cli/package.json` is base-ai's own, else `node_modules/@carlos17031691/base-ai/dist/index.js`, so every clone computes the same string. It needs `node` on PATH and a built CLI at that path, not `base-ai` on PATH. Only the root is configured, not services. `doctor` exits 1 with `root: usage hook missing in .claude/settings.json (run: base-ai ai sync)` when the hook is enabled and an event (or the file) has no generated hook, with `usage hook stale` when a generated hook differs from the expected command, appears twice, sits under another event or exists while the hook is `none` (`ai sync` removes or replaces it in each case), and with `root: .claude/settings.json is not valid JSON settings (fix it, then run: base-ai ai sync)` when the file does not parse as above and the hook is `claude-code` or the file's text contains `generated by base-ai`.

**Pricing and cost.** `usage.pricing` maps an exact model id (no aliases or prefixes) to `{ input, cache_write, cache_read, output }` in USD per million tokens; all four keys are required, each a number >= 0, and unknown keys are refused. There are no default prices. Cost is computed on read and never stored in `usage.jsonl`: `(input_tokens × input + cache_creation_input_tokens × cache_write + cache_read_input_tokens × cache_read + output_tokens × output) / 1e6`, rounded once to 4 decimals (half away from zero). A model with no price has cost `null`, shown as `no price`, never 0. A group's or the total's cost is the unrounded sum over its priced records, rounded once, with `unpriced_records` counted and shown as `(+1 record with no price)` for one record and `(+<n> records with no price)` otherwise.

**`base-ai usage report <task-dir> [--json] [--root <dir>]`** is read-only and offline. It reads `<task-dir>/usage.jsonl` (relative paths resolve against `--root`; a symlinked `usage.jsonl` or a file over 50 MiB is refused, while a symlinked task directory is followed), skips and counts lines that are not records, and prints one line per agent and model in order of first appearance, with the four counters, then `; calls <messages>, ctx/call <n>` (input, cache write and cache read tokens divided by calls, rounded; `n/a` with no calls), and `$<cost>` or `no price`, then a total. A missing or empty file prints `no usage data` and exits 0; a missing task directory or a bad config exits 1. `--json` prints `{ "schema": 1, "ticket", "records", "skipped_lines", "groups", "total" }`, with `cost_usd` a number or `null` and `unpriced_records`.

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
5. `transitions[]` is **append-only** — no agent may remove or modify past entries. Enforced in CI by `base-ai pipeline ci` (A1), which compares each changed `status.json` with the PR base.
6. `state: "validated"` requires `checklist.review_verdict === "approved"` AND `checklist.qa_verdict === "pass"`, both for the same latest implementer completion (the latest reviewer and QA entries name it). The full gate list is in `.claude/agents/supervisor.md`.

**Mechanical check.** `base-ai pipeline check <task-dir> [--json] [--root <dir>]` is read-only and exits 0 only when no check fails; a relative `<task-dir>` resolves against `--root`. It applies the supervisor rules at the commit named by the report's `rule` field (`supervisor.md@<commit>`) to every directory, older ones included, and runs all 19 checks without stopping at the first failure: K1 `status.parse`, K2 `status.ticket`, K3 `plan.steps`, K4 `state`, K5 `transitions.order`, K6 `lock`, K7 `completion`, K8 `review.present`, K9 `review.consistency`, K10 `review.binding`, K11 `review.verdict`, K12 `qa.present`, K13 `qa.consistency`, K14 `qa.binding`, K15 `qa.verdict`, K16 `register.keys`, K17 `decisions.format`, K18 `decisions.covers`, K19 `review.security`. A check whose dependency failed is skipped and names it. The round-1 header line may be `Round: 1`, `- Round: 1` or `- **Round:** 1`. An appended round's verdict line is "verdict", an optional short qualifier, a colon, then the word (for example `### Verdict (round 2 — authoritative): approved`). K16 counts a `To register` marker (a table cell that is exactly `To register`, or the literal `**To register**` / `**To register.**`) and prints its key and `file:line`; nothing inside an inline code span or a code fence counts. Markers are counted in every review round and in the latest QA round only; each gets the key `reg <ticket-id> <review|qa> r<N> i<k>`, where `<k>` is the ordinal of the marker among the counted markers of that round in document order, starting at 1, and registering means putting `[<key>]` in the body or in a comment of an issue in the repository's GitHub repo. K17 reads `decisions.md` (absent passes): every `## ` heading outside a fence is `## D<n>` (no leading zero); each block has each of `Decided`, `Decided by`, `Recorded by`, `Covers`, `Decision` and `Affects` exactly once with a non-empty value, as a column-0 line written `Label:` or `**Label:**`, optionally after `- ` or `* `; a `Covers:` value is `none`, allowed only when `Decision:` starts with `Steering acknowledged:`, or comma-separated items, each a `transitions[]` timestamp optionally followed by one `(note)` that may contain commas. K18 requires every event after the lock entry to be a `Covers:` timestamp: each `human` entry (resets included), each implementer `blocked → in_progress`, and each implementer `completed → in_progress` unless the latest reviewer or QA entry since the previous completion is `review round <N>: changes_requested` or `qa round <N>: fail` naming that completion; it lists each uncovered event as `<timestamp> (<kind>)`. K19 `review.security` applies only while `state` is `completed`: in any other state it is skipped with `state is <state>`, so directories validated before the rule keep passing, and in `completed` it depends on K8, K9 and K10, so it is skipped while the latest review round is not bound to the latest implementer completion (the next actor is then the reviewer). It reads the latest review round outside code fences, with HTML comments removed (so an unfilled template section fails), and requires: exactly one `## Security` or `### Security` heading; `Trust boundary touched`, `Method` and `Findings` each exactly once as a field line with a value; a boundary of `no`, or of `yes` naming at least one of `network`, `processes`, `external input`, `secrets`; the method `STRIDE` after `yes` and `OWASP checklist` after `no`; one category row per category of the method (six for STRIDE, five for the OWASP checklist) and no other row, each with a result and a basis; and `Findings` either `none` with no finding id in a Result cell, or the same set of finding ids (`H`, `M` or `L` and digits) as the Result cells. Its failure detail gives the round number and fixed words, labels and counts, never text from the report. Registration is checked by `base-ai pipeline debt <task-dir> [--issues <n,…>] [--json] [--root <dir>]`, opt-in network: it reads `owner/name` from the `origin` remote, views `--issues` first, then searches each unconfirmed key with `gh` (60-second timeout per call, at most 60 `gh` calls, one at a time), and counts a key only when `[<key>]` is literally in an issue body or comment. It exits 0 when every key is registered, 1 when one is missing or the keys were not computed, and 2 when it could not check, which is never treated as registered. **Next actor.** `pipeline check` also reports `facts.nextActor = { role, round?, reason }` (text line `next: <role>[ round <n>] — <reason>`; JSON stays `schema: 1`), a pure rule table that follows the "Who acts next" table of `.ai/skills/pipeline/skill.md`. `role` is `planner`, `implementer`, `reviewer`, `qa`, `supervisor`, `human` or `none`; `round` is present only for `reviewer` and `qa`; `reason` holds only check ids, keys, counts and state names. First, the first failing check in K1–K19 order that is not progress gives `human` with `check <id> <key> failed`; skips are ignored. Progress failures are K3 in unlocked `pending`, K4, K6 when unlocked in `pending`/`blocked`, K7 in `pending`/`in_progress`/`blocked`, K8 with no reviewer entry, K10, K11, K12 with no counted QA entry, K14 and K15. Then by state: unlocked `pending` gives `planner` until K3 passes, then `human` (orders the plan review, then approves); locked `pending` and `in_progress` give `implementer`; `blocked` gives `human`; in `completed`, `reviewer` (round = reviewer entries + 1) until review is bound, `human` for a `changes_requested` send-back, `qa` (round = counted QA entries + 1, or 1 after a reset) until QA is bound, `human` for a `fail` send-back, `human` on the supervisor's own ticket, else `supervisor` (the reason asks to register `To register` keys first); `validated` gives `none`. Neither command checks steering or the branch. The supervisor reads their output; no other agent does.

**CI check.** `base-ai pipeline ci --base <ref> [--json] [--root <dir>]` is read-only and runs in the `task-dirs` job on every PR. It makes four fixed git calls through argv, never a shell: G1 `rev-parse --verify` of the base (40 hex characters), G2 `diff --name-only -z` from the merge base to `HEAD` under `.ai/tasks/`, G3 `ls-tree` (does the base have `status.json`) and G4 `show` of the base `status.json` (at most 2 MiB). Per changed directory: A1 `transitions.append_only` (every base entry must remain at the same index, deep-equal in any key order; entries may be appended; a new file passes as new; a removed file, a non-object or a shorter list fails); then `pipeline check` when `status.json`, `plan.md`, `review-report.md`, `qa-report.md` or `decisions.md` changed (a change only to `usage.jsonl`, `plan-review.md`, `improvement-report.md` or `evidence/` is skipped); then the debt registration check when K16 passes and there is at least one key. More than 20 changed directories halts. Exit codes: 0 all pass or no task directory changed; 1 a directory fails, or a missing or invalid `--base` (usage line, nothing run); 2 anything halted (G1–G4 failure, the 20-directory cap, a debt halt). A base `status.json` over 2 MiB fails A1 naming `base` (exit 1, not a G4 halt), and a directory id outside `^[A-Za-z0-9#._-]+$` fails `D0 dir.name` (JSON `name`). Output never shows file content, git stderr or issue text.

**Who reads the commands.** The supervisor reads both commands instead of re-deriving their checks (C0 and the gate table of `supervisor.md`); QA does not, and keeps its own prose. The supervisor resolves the CLI from committed files, never from `PATH` and never with `npx`: `cli/dist/index.js` when `cli/package.json` names `@carlos17031691/base-ai`, else `node_modules/@carlos17031691/base-ai/dist/index.js`. Its reference files are `decisions-format.md`, `steering.md` and `refusal-halt-forms.md`. It halts, writing nothing, when node or that file is missing, when the output is not one JSON object with `schema` 1 and K1–K19, or when `rule` is not exactly `supervisor.md@e2c6781`; it never falls back to deriving the checks in prose. P4 changes no mechanical rule, so `RULE` keeps that value, and a test (`cli/src/test/pipeline-rule.test.ts`) fails unless `supervisor.md` states `RULE` exactly once: a later change to a mechanical rule changes `RULE` and the definition in the same PR. A downstream project needs `@carlos17031691/base-ai` as a devDependency, in the version that ships these definitions; in base-ai, `cli/` must be built.

**Dashboard.** `base-ai dashboard [--port N] [--root <dir>]` serves `pipeline check` results and `usage report` totals, run in process, over `127.0.0.1` (default port 4747), and writes nothing; it reads only, except for the opt-in registration check below. `GET /api/tasks` lists every task directory (a real directory whose name matches `^[A-Za-z0-9#._-]+$`; other entries are counted in `skipped` and never read) with its `title` (from `plan.md`'s first line), state, `ok`, `nextActor`, review and QA rounds and verdicts, `updated_at` and token totals; `GET /api/tasks/<id>` adds the transitions, the 19 checks, `facts`, the `To register` keys, the usage records with cost and `files` (the five task files the checks read, with absolute path and `present`, never their text); `GET /api/meta` gives the editor link template; `POST /api/tasks/<id>/registration` runs the `pipeline debt` check (the same code, with no `--issues`) for that task, its only outbound call (`git` and `gh`), and `GET` on the same path gives the last result, kept in memory only. The POST must carry `X-Base-AI: 1`, a present `Origin` must be the dashboard's own and a present `Sec-Fetch-Site` must be `same-origin` (otherwise 403); keys not computed give 422, one check runs at a time (409 during a run), a run has a 5-minute deadline and stopping the dashboard aborts it. A halt is shown as typed text such as `gh: command not found`, and no path or stderr is returned; `GET /healthz` gives `{"status":"ok"}`. `GET /events` is a Server-Sent Events stream: `event: task` with the task id when anything in its directory changes and `event: list` when the set of tasks changes, never a path, seen by non-recursive `fs.watch` on `.ai/tasks/` and each task directory and coalesced in a 250 ms window per task; at most 10 streams are open (the 11th gets 503), and a `: ping` comment is sent every 25 s. `GET /` is the pipeline HUD, loaded from `/app.js` and `/app.css` served from memory on the same origin: a task queue, a stage ring with the next actor and up to six decorative satellites for the active tasks, the timeline, the rounds, the 19 check cells, the token flow at current prices with a token count on every role and in TOTAL (each row's tooltip ending with ` · calls <n> · ctx/call <n>`, `n/a` with no calls), a REGISTRATION panel with a CHECK REGISTRATION button and "open"/"copy path" links for the task files, updated live from `/events` (reloaded on each event and on every reconnect, with `● LIVE`, `● RECONNECTING` or `● OFFLINE` in the header for the connection) and with a manual REFRESH button kept as the fallback. Task text is shown only as text. The links follow `dashboard.editor_url` in `.ai/config.yaml` (default `vscode://file/{path}`; the scheme must be one of the allowed editor schemes, `EDITOR_SCHEMES` in `cli/src/source.ts`: `vscode`, `vscode-insiders`, `vscodium`, `cursor`, `windsurf`, `zed`, `subl`, `txmt`, `mvim`, `idea`, `pycharm`, `webstorm`, `phpstorm`, `goland`, `rubymine`, `clion`, `rider` and `jetbrains`; any other scheme is refused, and a bad value exits 1 at start). A foreign `Host` (anything but `127.0.0.1:<port>` or `localhost:<port>`, so `Host: [::1]:<port>` and reverse proxies too) gets 403, a method other than `GET`/`HEAD` gets 405, except `POST` on `/api/tasks/<id>/registration`, the one exception (where `Allow` is `GET, HEAD, POST` and no CORS preflight is granted), and an id that is not a listed task gets 400. Prices and the editor template are read at start, so a change needs a restart. It is a view for the human and the coordinator: no agent reads it, and it changes no rule above.

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

The planner does this in its Step 1 (`.claude/agents/planner.md`). The reviewer creates `plan-review.md` from `templates/task/plan-review.md` in plan-review mode. The `pipeline` skill summarises the whole protocol and who acts next; it creates no files.
