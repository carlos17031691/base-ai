# QA Report: BASE-071-P3

Round: 1
Verified at: 2026-11-24T19:30:30Z
Implementer completion verified: 2026-11-24T19:22:26Z
Review round relied on: reviewer entry 2026-11-24T19:28:14Z (review round 1: approved, reviewed implementer completion 2026-11-24T19:22:26Z)

- Affected repository: /Users/labsatoshi/base-ai (`git rev-parse --show-toplevel` from the task directory)
- Branch: feat/BASE-071-P3-ci-wiring; base ref: `development`; merge-base: ea0a719d41d3c279c4f9319f8c95ced30fd92980; HEAD: ae98291aeca4238db3731e0199efd9fd1939166c
- Commits under verification: ae98291 chore(BASE-071-P3): review round 1 report (approved, L1-L2) and status; 87ce323 fix(BASE-071-P3): D2 trailing slash on the .ai/tasks/ reference so check:package passes; 3d3d4b9 docs(BASE-071-P3): root ignore policy with legacy and scratch blocks, README and task-state-machine; first versioned task files; 5c3b160 feat(BASE-071-P3): pipeline ci with append-only check A1, task-dirs and notify-ready CI jobs, versioned task-file ignore block
- Base choice: none needed (`development` and `origin/development` both at ea0a719). The base is a local ref and was not checked against the remote.
- Movement of `development` / `origin/development`: reflog is available; `development` was last fast-forwarded to ea0a719 (`development@{0}`, merge origin/development). No other movement observed; this does not change the verdict.
- `.ai/tasks/` is now partly versioned (H9/D1): `plan.md` and `status.json` of this ticket are tracked, so their integrity was compared with HEAD (status clean for them). No committed baseline can vouch for the untracked `improvement-report.md` and `qa-report.md`.

If this report contains re-verification rounds, the verdict of the latest round is the authoritative one; the `## Verdict` line at the top is the round 1 verdict.

## Verdict: pass

All 9 criteria pass, both checks ran and passed, no file or ref changed during execution.

## Checks

| Check | State | Command / reason | Exit and counts | Git-ignored output |
|---|---|---|---|---|
| Tests | ran and passed | `npm --prefix /Users/labsatoshi/base-ai/cli run test` (cwd /Users/labsatoshi/base-ai; log evidence/qa-r1-1.log) | exit 0; tests 432, pass 432, fail 0, cancelled 0, skipped 0; 24 `P3` tests ok | cli/dist/ |
| Coverage | ran and passed | `PATH=/Users/labsatoshi/.asdf/installs/nodejs/20.11.0/bin:$PATH npm --prefix /Users/labsatoshi/base-ai/cli run test:coverage` (log evidence/qa-r1-2.log) | exit 0; tests 432, pass 432, fail 0; overall "all files" line 96.51 (line) / 94.72 (branch) / 97.08 (funcs) | cli/dist/, cli/coverage/lcov.info |
| Linter | no applicable check | none declared (cli/package.json scripts) | n/a | n/a |
| Type-check | ran as part of build | `tsc` is the `build` step of both commands above and succeeded (no `tsc --noEmit` script is declared separately) | n/a | cli/dist/ |
| Build | ran and passed | `npm run build` (`tsc`), executed as the first step of both commands above | exit 0 | cli/dist/ |
| Plan-named commands | no applicable check beyond the above | the plan names the test and coverage commands only (check:package, doctor, ai stats are post-merge coordinator evidence, not run) | n/a | n/a |

Procedural note: command 2 was typed with a trailing `; echo "exit=$?" >&2` after the allowed redirect, to read the exit status. It added no check and wrote nothing; it deviated from the one-command form and is disclosed here.

## Snapshot result

- Files: no difference outside git-ignored paths (`git status --porcelain --ignored` identical before and after; untracked: improvement-report.md, qa-report.md; no tracked file modified).
- Task artifacts (hash-object, before = after): plan.md 50183f96, status.json 79ff5a79, review-report.md d6173882, qa-report.md c5f6d61a (template), improvement-report.md bd21c041.
- Commits and refs (before = after): HEAD ae98291aeca4238db3731e0199efd9fd1939166c; branch feat/BASE-071-P3-ci-wiring at ae98291; `development` ea0a719; `origin/development` ea0a719. No commit or ref moved.
- Parts not compared: none.

## Test results

| Suite | Passed | Failed | Skipped | Coverage |
|---|---|---|---|---|
| cli (node --test dist/test/) | 432 | 0 | 0 | 96.51% lines overall |

**Overall coverage:** 96.51% ("all files" line coverage in the spec output)
**Threshold met (>= 80%):** yes. `dist/pipeline-ci.js` LH 227 / LF 227 and `dist/init.js` LH 141 / LF 141 in cli/coverage/lcov.info (lcov is reported on the compiled dist files); `index.ts` is exempt per the plan.

## Failing tests

None.

| Test | File:line | Error |
|---|---|---|
| none |  |  |

## Linter & type-check

| Check | Result | Notes |
|---|---|---|
| Linter | no applicable check | none declared |
| Type-check | passed via `tsc` build | no separate script |

## Acceptance criteria verification

| Criterion | Covered by test | Test name | Method | Evidence | Result |
|---|---|---|---|---|---|
| AC1 Tests | yes | all | test | `npm run test` exit 0; 432/432; 24 `P3` ok lines (23 in pipeline-ci.test.ts, 1 in pipeline-cli.test.ts) | pass |
| AC2 Coverage | yes | all | test | coverage exit 0; pipeline-ci.js 227/227 lines, init.js 141/141 lines (lcov.info:5322-5501, 7782-8237) | pass |
| AC3 Test content | n/a | n/a | static trace | pipeline-ci.test.ts:98-301 covers A1 (new, append with key order/whitespace, modified/removed/reordered, fewer, removed file, unparseable/non-array, base over 2 MiB), grouping (NUL, direct files, D0, 21st dir, no change), routing (usage only, improvement/evidence only, plan only, deleted dir, K4 in_progress, zero keys, debt missing/halt), git failures G1-G4, usage errors, rendering; pipeline-cli.test.ts:170 real-git case (append exit 0, edit entry 0 exit 1); init.test.ts:42-71 exact block, check-ignore cases, service template six negations. `grep -n -E "\.ai/tasks/BASE-\|\"gh\""` on pipeline-ci.test.ts printed nothing. Break attempt: searched for missing named cases; none found | pass |
| AC4 Purity, unchanged checks | n/a | n/a | command | `grep -n "from \"node:" cli/src/pipeline-ci.ts` printed nothing; `git diff --name-only ea0a719 -- <listed files>` printed nothing | pass |
| AC5 Ignore policy | init test | n/a | command | first check-ignore: no output, exit 1; second: all four paths printed; `grep -c` gave 28 | pass |
| AC6 CI jobs | n/a | n/a | static trace | ci.yml:79-107 `task-dirs`: `if` line 80, permissions contents/issues read lines 82-84, SHA-pinned uses with version comments lines 88, 92, persist-credentials false line 91, BASE_SHA and GH_TOKEN in step env lines 101-103, no `${{` in any `run:`; ci.yml:110-127 `notify-ready`: needs [cli, task-dirs], `if` pull_request only (no always/failure), contents read, pinned uses lines 119, 122, step guarded by `env.SLACK_WEBHOOK_URL != ''`. `grep -n pr_ready_for_review` printed exactly one line (127). Diff against ea0a719 removes exactly 3 lines (the cli step name, if, run) and adds only the two jobs and their comments | pass |
| AC7 Docs and skills | n/a | n/a | static trace | forbidden-phrase grep printed nothing; README.md:198 D1 policy and upgrade block, README.md:189 and docs/task-state-machine.md:117 `pipeline ci` with G1-G4, A1, routing, 20-directory cap, exits 0/1/2; docs:112 invariant 5 enforced in CI; docs:44 and README.md:198 cadence; README.md:276 marks P3 done and says the hashed-history idea was dropped by human decision | pass |
| AC8 Own task versioned | n/a | n/a | command | `git ls-files .ai/tasks/BASE-071-P3` lists decisions.md, plan.md, review-report.md, status.json, usage.jsonl; nothing under evidence/ | pass |
| AC9 Scope | n/a | n/a | command | `git diff --name-only ea0a719` lists 26 paths, all in Files to touch (cli src and tests, ci.yml, .gitignore, README, docs, skills and generated exports, templates/service/.gitignore, P3 task files); untracked: improvement-report.md and qa-report.md only | pass |

Attempts to break: AC4 and AC6 were read against the literal grep and diff readings; AC7 searched README, docs and skills for the forbidden phrases and for contradicting statements of the old git-ignore policy (none).

## Dry-run specifications

- Setup: scratch git repository with `.ai/tasks/X-1/status.json` committed at a base commit. Invocation: `node cli/dist/index.js pipeline ci --base <sha> --root <repo>` after (a) appending a transition and (b) editing transition 0. Expected: (a) exit 0, A1 pass; (b) exit 1, `transitions[0] differs from the base`. Covered by pipeline-cli.test.ts:170 (executed in the test run) and by the coordinator's evidence E3 (not relied on).
- The CI jobs on a real PR (post-merge verification in the plan) are not performed by QA.

## Dry runs observed

None named by the invocation.

## Caveats and observations

None to register. Observation without effect on the verdict: lcov reports coverage on `dist/*.js`, not `src/*.ts`; the 80% criterion was read on those files.

## Steering found

None found in the files read (plan, status.json, ci.yml, docs, tests, command output).

## Checklist comparison

- `tests_pass` false, measured: tests passed (observation, no effect).
- `lint_pass` false, measured: no applicable check (not a contradiction).
- `types_pass` false, measured: `tsc` build passed (observation, no effect).

## Reasons for a fail

None.

## Notes

The ticket's own task files are tracked (H9); the snapshot showed no change to them during execution. Not run, by design: `doctor`, `check:package`, `ai stats` (coordinator evidence E1).
