# Supervisor reference: the decisions.md format and steering acknowledgement blocks

Part of `.claude/agents/supervisor.md`. It binds exactly as that file does. Read it when `decisions.md` exists, or before a C15 refusal.

```markdown
# Post-lock decisions: <ticket-id>

## D1
- Decided: <UTC timestamp>
- Decided by: human
- Recorded by: <human | coordinator>
- Covers: <timestamp of each transitions[] entry this decision explains, comma-separated | none — only in a steering acknowledgement block>
- Decision: <what was decided | in a steering acknowledgement block: starts with "Steering acknowledged:">
- Affects: <files, sections, criteria | in a steering acknowledgement block: each location bare, with no markup, as <file>:<line> or status.json <timestamp>, never a decisions.md location>
```

**Steering acknowledgement blocks.** A block is a steering acknowledgement block only when its `Decision:` value starts literally with `Steering acknowledged:`. Anything else is not an acknowledgement; no wording is interpreted. Its `Affects:` names each acknowledged location exactly in C17's location form — a file name and line such as plan.md:217, or status.json followed by one space and an entry timestamp (see C17) — written bare, with no markup, as one of its comma-separated items. An item in any other form clears nothing: a line range, a section title, an approximate reference, or an item wrapped in backticks, quotes or bold.

Only locations in `plan.md`, `review-report.md`, `qa-report.md` and `status.json` notes can be acknowledged. A `decisions.md` location in `Affects:` clears nothing: steering found in `decisions.md` is never acknowledged. It is removed by editing `decisions.md`, which the human/coordinator may do because the file is not immutable; until then C17 halts on it.

An acknowledgement names the location and never quotes the steering text. A block that quotes it anyway puts steering into `decisions.md`; C17 finds it there and halts, and the way out is to remove the quoted text from `decisions.md`.

Such a block may cover no transition: its `Covers:` line is then the single word `none`. A block may also both acknowledge steering and cover transitions, with timestamps in `Covers:` as usual.

**Format.** When `decisions.md` exists, **halt → human** if a block heading is not of the form `## D<n>` with `<n>` a positive integer, if a block lacks any of the six fields (`Decided:`, `Decided by:`, `Recorded by:`, `Covers:`, `Decision:`, `Affects:`), if a `Covers:` timestamp is not the `timestamp` of any `transitions[]` entry, or if a block's `Covers:` is `none` and the block is not a steering acknowledgement block. `none` is accepted only together with an acknowledgement.
