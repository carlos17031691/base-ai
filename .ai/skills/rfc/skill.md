---
id: rfc
description: >-
  Draft a Request for Comments (RFC) for high-impact changes before
  implementing them. Use for significant features, cross-service contract
  changes, migrations or infrastructure changes.
targets: all
---

# RFC (Request for Comments)

1. Determine scope (root if it affects several services, otherwise the service) and create `docs/architecture/rfcs/RFC-XXXX-short-title.md`.
2. Use this structure:
   - **Metadata:** date, status (`Draft`, `In review`, `Approved`, `Rejected`, `Implemented`), authors, reviewers.
   - **Summary:** one paragraph describing the change.
   - **Motivation:** the problem it solves and how success is measured.
   - **Proposed design:** components, contracts (APIs/events), data and diagrams.
   - **Affected services:** which repos change and the deployment order.
   - **Security and privacy:** threats, sensitive data and controls.
   - **Resilience:** failure modes, timeouts, retries and idempotency.
   - **Observability:** metrics, logs, traces and alerts.
   - **Rollout and rollback plan:** feature flags, migrations and how to revert.
   - **Alternatives and open questions.**
3. If the RFC is approved and sets a lasting decision, derive an ADR from it.
