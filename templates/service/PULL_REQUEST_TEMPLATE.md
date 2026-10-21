## Ticket (Story / Epic / Task)

- **Tracker ID:** `PROJ-XXX` <!-- Jira, ClickUp (CU-...), Trello, GitHub Issue (#...) -->
- **Related ADR / RFC:** <!-- Optional: link to docs/architecture/{adrs,rfcs}/ -->

## Summary of Changes

- What problem does this PR solve and why?

## Quality, Security & SDLC Checklist

- [ ] Branch name (`feat/<ID>-...`) and commit messages include the Ticket ID.
- [ ] PR targets **`development`** (`staging`) for working branches, or **`main`** (`production`) only for release promotion from `development`.
- [ ] Domain logic is isolated from infrastructure/transport (`architecture` skill).
- [ ] No cross-service filesystem imports; API/event contracts remain backward-compatible or versioned.
- [ ] Automated tests added/updated (coverage >= 80%, happy path, edge cases, failure modes) and passing (`testing` skill).
- [ ] Security checked: zero hardcoded secrets/PII, external inputs validated, authn/authz enforced (`security` skill).
- [ ] Sonar & CodeRabbit dual gates verified: all **High** and **Medium** findings resolved and re-verified.
- [ ] Any **Low** findings accepted without changes logged as project issues / technical debt (list Issue # below).
- [ ] All review conversations and comments explicitly addressed and marked resolved (Zero Unresolved Conversations rule).
- [ ] Mandatory **human approval** obtained before merge.
- [ ] Observability & operations updated: structured logs, metrics/alerts and `docs/operations/runbooks/` if needed (`observability` & `runbook` skills).

## Rollout, Infrastructure & Rollback Plan

- **Cloud / IaC changes (`infrastructure` skill):** None / `plan` output attached (OIDC auth, remote state, no hardcoded keys)
- **Cloud monitoring (`observability` skill):** Alarms & dashboards updated as code (compute, DB, DLQ, budget thresholds)
- **Database migrations:** None / Expand-and-Contract (backward-compatible)
- **Rollback steps:** `git revert` / feature flag toggle / previous image tag or IaC state
