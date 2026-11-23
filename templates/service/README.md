# {{name}}

Independent service created with `base-ai service new {{name}} <repo>`.

> This repository is self-contained: its architecture, infrastructure and CI/CD do not depend on the root repo.

## Layout

| Path | Purpose |
|------|---------|
| `.ai/` | Service-specific rules, memory and skills (extend the root ones; local wins) |
| `.githooks/` | Git hooks enforcing branch naming, ticket traceability and PR-only merges |
| `.github/workflows/ci.yml` | CI: dependency audit, tests with coverage, SonarCloud quality gate and Slack notifications |
| `.github/dependency-audit-accepted.json` | Reviewed, expiring exceptions to the dependency audit (empty by default) |
| `.env.example` | 12-Factor environment variable template (copy to `.env` locally; never commit `.env`) |
| `.gitignore` | Defensive ignore rules for secrets, `.env*`, keys and build artefacts |
| `PULL_REQUEST_TEMPLATE.md` | PR checklist covering Ticket ID, clean architecture, tests, security and rollback |
| `docs/architecture/{adrs,rfcs}` | Service decisions |
| `docs/operations/{runbooks,postmortems}` | Operations |

## Dependency audit

CI runs [OSV-Scanner](https://google.github.io/osv-scanner/) at a pinned version (its SHA-256 is checked before it runs) over every lockfile in the repository, then `.github/scripts/dependency-audit.cjs` applies the policy:

1. **What fails the build:** a High or Critical advisory (CVSS 7.0 or more), or an advisory with no score, in a production dependency. A scanner error or an invalid accepted file fails the build too.
2. **What is only reported:** Low and Medium advisories, and advisories in packages used for development only. They are printed in the job log and the job summary and do not fail the build.
3. **Limits:** an ecosystem whose lockfile records no development group is audited whole (every package counts as production). A language OSV-Scanner does not read is not audited. A repository with no lockfile passes.
4. **When it fails:** upgrade the package first; if no fixed version exists, remove or replace it; accept the advisory only when neither is possible and the vulnerable code is not reachable.
5. **How to accept an advisory:** add an entry to `.github/dependency-audit-accepted.json`. Each entry has exactly these four keys; `reason` needs at least 20 characters and `expires` is at most 90 days after `accepted`. After `expires` the entry stops applying and the build fails again.
   ```json
   [
     {
       "id": "GHSA-xxxx-xxxx-xxxx",
       "reason": "Not reachable: the affected parser is never given untrusted input.",
       "accepted": "2026-01-15",
       "expires": "2026-03-15"
     }
   ]
   ```
6. **Review:** an acceptance is merged by Pull Request like any other change, with the ticket ID and human approval.

## Git & SDLC workflow

1. Every change must be linked to a **Story, Epic or Task** (Jira, ClickUp, Trello, etc., e.g. `PROJ-123`, `CU-86a1b2`, `#45`).
2. Create a working branch before committing (`main`, `master` and `development` are protected):
   ```bash
   git checkout -b feat/PROJ-123-short-description
   ```
3. Reference the ticket ID in every commit message:
   ```bash
   git commit -m "feat(PROJ-123): implement domain use case"
   ```
4. Push the working branch and open a **Pull Request** (direct pushes to `main`, `master` or `development` are blocked):
   ```bash
   git push -u origin HEAD
   ```
