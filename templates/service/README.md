# {{name}}

Independent service created with `base-ai service new {{name}} <repo>`.

> This repository is self-contained: its architecture, infrastructure and CI/CD do not depend on the root repo.

## Layout

| Path | Purpose |
|------|---------|
| `.ai/` | Service-specific rules, memory and skills (extend the root ones; local wins) |
| `.githooks/` | Git hooks enforcing branch naming, ticket traceability and PR-only merges |
| `.env.example` | 12-Factor environment variable template (copy to `.env` locally; never commit `.env`) |
| `.gitignore` | Defensive ignore rules for secrets, `.env*`, keys and build artefacts |
| `PULL_REQUEST_TEMPLATE.md` | PR checklist covering Ticket ID, clean architecture, tests, security and rollback |
| `docs/architecture/{adrs,rfcs}` | Service decisions |
| `docs/operations/{runbooks,postmortems}` | Operations |

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
