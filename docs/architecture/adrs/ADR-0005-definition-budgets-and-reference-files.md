# ADR-0005: Budgets and reference files for the role definitions

- **Date:** 2026-11-21
- **Status:** Accepted
- **Authors:** base-ai team
- **Ticket:** BASE-079-T2 (issue #79; the budgets of `ai stats` come from BASE-079-T1)
- **Relation:** supersedes two statements of ADR-0004: §1 "`ai stats` does not count them" and §2.1 "direct children of `.claude/agents/` only". ADR-0004 stays in force for everything else.

---

## 1. Context and problem

Each pipeline agent loads its whole role definition (`.claude/agents/<role>.md`) at the start of a run, and the definition stays in context for every turn of that run. `qa.md` was the largest: 78,301 chars, about 19,576 estimated tokens, read on each of the 16 to 74 turns of a QA run.

Two kinds of text made it large:

1. **Conditional procedures.** The halt message, the rules for halting after a check command has started, the handling of an "after" snapshot that cannot be compared, the environment abort and the choice between two differing base refs. A normal run needs only the condition that triggers each one, not the procedure.
2. **Restatements.** Many rules were stated in a step and again as a list item of "Handling blockers" or "What you must never do".

The size had to come down without changing or weakening any rule, and in a way a reviewer can check without rereading 624 lines. A reduction also had to be locked in, so that a definition cannot grow back unnoticed or move text out of sight.

## 2. Decision

1. **`ai stats` counts the role definitions.** It reports each `.claude/agents/<role>.md` as a whole file, frontmatter included, and each of its reference files (chars, estimated tokens as `ceil(chars / 4)`), the definition total with its reference files, and the sums over all roles. This supersedes ADR-0004 §1, "`ai stats` does not count them".
2. **Budgets per definition, in `.ai/config.yaml`.**
   - `budgets.definitions.<role>`: the maximum estimated tokens of the definition file alone.
   - `budgets.definition_totals.<role>`: the maximum of the definition plus its reference files. A role that has reference files and no total is held to its `definitions` value. Text moved into a reference file therefore still counts.
   - `ai stats` (plain and `--ci`, with or without `--max-tokens`) exits 1, naming the role and both numbers, when a definition or a total is above its budget, or when a definition has no entry while `budgets.definitions` exists. A project with no `budgets` key gets the report and no violation. The existing CI step `ai stats --max-tokens 5000 --ci` enforces the budgets with no workflow change.
   - A budget is set from a measured size, rounded up to the next 250. It is raised only by a PR whose approved plan says so.
   - `qa`: 14,250 for `qa.md` (measured 14,106, down from a budget of 19,750) and 18,000 with its three reference files (measured 17,877).
3. **Reference files.** A definition may move passages that a run needs only in a given case into `.claude/agents/<role>/<name>.md`:
   - one level deep, Markdown, no frontmatter, so Claude Code does not load them as agents;
   - part of the definition, binding exactly as it does; each file opens with a line that says so;
   - named by the definition as `.claude/agents/<role>/<name>.md`, with the condition on which the agent must read it in full before acting. The condition itself, and every "never", stays in the definition. `ai stats` and `ai sync` fail, naming the path, on a reference file that its definition does not name and on a directory under `.claude/agents/` with no definition.
   - Shipped by the package and `init` with the definitions (`isShippedPath` accepts `.claude/agents/<role>/<name>.md`, nothing deeper), and checked by `npm run check:package` as sources. This supersedes ADR-0004 §2.1, "direct children of `.claude/agents/` only".
   - Exported by `ai sync` to every service with `ai: inherit` and Claude enabled, at `src/<name>/.claude/agents/<role>/<name>.md`, as the generated header, a blank line, the trimmed body and one final newline. The lock, the overwrite protection and the stale-file removal of ADR-0004 apply, so `doctor` reports an edited or deleted root reference file for every service.
   - `qa` has three: `.claude/agents/qa/halt.md` (the halt message and the halting rules), `.claude/agents/qa/execution-anomalies.md` (the "after" snapshot that cannot be compared, the environment abort) and `.claude/agents/qa/base-choice.md` (the four rules for two differing base refs). A subsection "Reference files" in `qa.md` lists them, and a pointer line stands where each moved block was.
4. **Proof that nothing was reworded: `npm run check:relocation`.** `cd cli && npm run check:relocation -- <base-commit> <role> [--map <file>]` compares the definition and its reference files with the definition at the base commit, line by line (exact after trailing whitespace; blank lines ignored; counts matter). It writes nothing and prints the counts kept, moved, deleted, added and carriers, and the added lines.
   - Without `--map`: every base line must be present in the core or in a reference file, and each file must keep the base order. This is a pure relocation.
   - With `--map`: a base line may also be missing when it is listed in the deletion map, a JSON array of `{ "deleted": "<exact base line>", "carriers": ["<exact substring of a carrier line>", ...], "where": "<section and step>" }`. The check fails unless the missing lines equal the deleted entries as a multiset, every deleted line is a list item (`- `) inside the role's allowed ranges of the base, and every carrier substring occurs in a line of the core definition outside those ranges, not in a reference file.
   - The script proves that the text is the base text, moved or deleted. Whether each carrier states the whole rule of its deleted line is the reviewer's judgment, entry by entry; when in doubt the line stays.
5. **`qa.md` in BASE-079-T2.** Seven blocks moved byte for byte into the three reference files, with 29 added lines (the subsection, seven pointers, the reference files' opening lines and headings). Then 58 list items of "Handling blockers" and "What you must never do" were deleted, each mapped in `.ai/tasks/BASE-079-T2/dedup-map.json` to the kept core lines that still state it. No kept line was edited. Result: 56,424 chars, about 14,106 estimated tokens, 28% less than 19,576.

## 3. Impact

- **Cost:** about 5,500 tokens fewer in every turn of a QA run that does not halt. A halting run also reads `halt.md` (about 2,300 tokens) and saves less.
- **Operations:** `ai stats` now loads the definitions, so it fails on an invalid definition (no frontmatter, unnamed reference file), as `ai sync` already did. `doctor` covers the exported reference files with no new check.
- **Security:** no new input surface beyond local Markdown files. Every condition of `qa.md` stays in the core, and each deleted "never" item is mapped to core lines that still state it, so a safeguard does not depend on a reference file being read.

## 4. Consequences

- **Positive:**
  - Every definition is measured and capped in CI; a reduction cannot be undone, or hidden in a reference file, without an approved plan.
  - The relocation check lets the reviewer and QA judge a slimming by its output and its map instead of rereading the definition. Later tickets reuse it for other definitions.
- **Negative / trade-offs:**
  - An agent can act on a moved case without reading its file. Mitigation: the pointers are wider than the cases (for example any halt), and the subsection forbids acting from memory.
  - A rule deleted from a list now exists once in the core instead of twice: less repetition, possibly less salience.
  - Projects that enlarge a definition see `ai stats` exit 1 until they raise their own budget. Projects created before the budgets have no `budgets` key and see no change.
  - The improvement agent reads definitions by name and may not follow the pointers when it measures a role.

## 5. Alternatives considered

- **Reference files in a sibling directory (`.claude/agent-refs/`) or in `.ai/skills/pipeline/` or `docs/`.** They would fall outside the read and forbidden lists that already cover `.claude/agents/**` in every definition; rejected.
- **Free rewording of the definition (an estimated 35–45 % less).** Not provable by a script and not reviewable at a reasonable cost; rejected in favour of whole-line deletion with a map.
- **Measure only, no slimming.** Leaves the largest per-turn cost in place; rejected.

## Addendum (BASE-079-T3): deletion maps carry their own base, role and ranges

A deletion map may be an object `{ "base": "<sha>", "role": "<role>", "ranges": [[first, last], ...], "entries": [...] }`. `check:relocation` fails unless `base` is a prefix of the commit it is given (resolved with `git rev-parse`) and `role` matches its role argument, so line ranges can no longer be applied to a different base without warning. Every entry needs a non-empty `where`. The bare array form of BASE-079-T2 still works with the ranges the script holds for it (`qa` at `47ead24`), so that check can still be reproduced; new maps use the object form.
