# {{name}}

Independent service created with `base-ai service new {{name}}`.

> This repository is self-contained: its architecture, infrastructure and CI/CD do not depend on the root repo.

## Layout

| Path | Purpose |
|------|---------|
| `.ai/` | Service-specific rules and skills (extend the root ones; local wins) |
| `docs/architecture/{adrs,rfcs}` | Service decisions |
| `docs/operations/{runbooks,postmortems}` | Operations |

## Getting started

1. Choose your stack and record it in `docs/architecture/adrs/ADR-0001-stack.md`.
2. Add your infrastructure, tests and CI/CD in whatever layout your stack requires.
3. Add service rules in `.ai/rules.md` and run `base-ai ai sync` from the root.
