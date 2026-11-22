# Runbook: branch rulesets for `main` and `development`

Source of truth: `infra/github/rulesets/protected-branches.json` (ticket BASE-080-G1, issue #80).
**Only the human maintainer runs the `gh api` write commands below (POST, PUT, DELETE). Agents never do.**

## What is enforced and why

- **Applied once by the human (D1).** A reviewed JSON file plus one manual `gh api` call. There is no IaC, no apply workflow and no admin token in CI.
- **Rules on both branches (D2).** A PR is required, with 0 approvals, because the single maintainer cannot approve their own PR. Human approval stays mandatory by process (Gate 5). All conversations must be resolved. The required checks are `cli` (integration 15368) and `SonarCloud Code Analysis` (integration 12526). Force pushes and branch deletion are blocked. The only bypass actor is the admin role (`RepositoryRole` 5) in `pull_request` mode, so direct pushes stay blocked for everyone.
- **No bot push (D3).** `release.yml` only tags, publishes and creates the GitHub Release. It never commits or pushes to a protected branch.
- **`Contract Testing Gate` is not required.** It is path-filtered and only runs on OpenAPI/proto changes. A required check that never reports would block every other merge.

## Apply

Run once, from an up-to-date `development` checkout after the BASE-080-G1 PR is merged:

```
gh api -X POST repos/carlos17031691/base-ai/rulesets --input infra/github/rulesets/protected-branches.json
```

## Verify (read-only)

```
gh api repos/carlos17031691/base-ai/rulesets                  # id, name, enforcement
gh api repos/carlos17031691/base-ai/rulesets/<id>             # full body; compare with the file
gh api repos/carlos17031691/base-ai/rulesets/<id> --jq '.bypass_actors'
gh api repos/carlos17031691/base-ai/rules/branches/main
gh api repos/carlos17031691/base-ai/rules/branches/development
```

The `bypass_actors` query must print exactly one admin-role actor in `pull_request` mode:
`[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"pull_request"}]`. The API may add fields, but the id, type and mode must match. Post the ruleset id and the verify output on #80.

## Update

Change `infra/github/rulesets/protected-branches.json` in a ticketed PR to `development`. After merge, run:

```
gh api -X PUT repos/carlos17031691/base-ai/rulesets/<id> --input infra/github/rulesets/protected-branches.json
```

Then run Verify again.

## Bypass

The admin can merge a PR past a failing or missing required check, or past an unresolved thread, only through an explicit bypass, which GitHub records.

- **Justified only for:** an emergency hotfix; a renamed check, until the ruleset is updated; a fork PR that cannot get `SonarCloud Code Analysis` because it has no `SONAR_TOKEN`, after manual review.
- **Never for:** skipping a blocking High or Medium finding, failing tests, or an unresolved discussion about such a finding.
- **Always** justify the bypass in a comment on the PR.

## Rollback

```
gh api -X DELETE repos/carlos17031691/base-ai/rulesets/<id>
```

Fix the file through a ticketed PR, then re-apply it (Apply). Record the reason on the ticket.

## Release

The release PR to `main` must carry a `cli/package.json` and `cli/package-lock.json` version bump. Merge it into `development` first, through its own ticketed PR. If the version is not greater than the published npm version, the `release` job fails before `npm publish`, and nothing is pushed to `main`. To fix it, open a ticketed bump PR to `development`, then a new release PR.

## Contingency: 422 on Apply

If the POST answers 422 because `bypass_mode: "pull_request"` is not accepted for a repository role, nothing is applied.

- Do not fall back to `always`, because that would allow direct admin pushes.
- Open a small ticketed PR that sets `"bypass_actors": []`, merge it, then Apply.
- With no bypass, the emergency path is Rollback (delete, fix, re-apply), recorded on the ticket.
