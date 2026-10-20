---
id: runbook
description: >-
  Generate an on-call operational runbook for a service or component. Use when
  deploying something new, creating an alert, or when asked to document how to
  operate or mitigate an incident.
targets: all
---

# Operational runbook

Create `docs/operations/runbooks/<component>.md` in the service repo with:

- **Overview:** what the component does, its owner, and its upstream and downstream dependencies.
- **Access:** dashboards, logs, traces and consoles (links only, never credentials).
- **Alerts:** for each alert, what it means, its severity and its user impact.
- **Diagnosis:** ordered steps and concrete commands to confirm the cause.
- **Mitigation:** safe, idempotent actions (rollback, scale, disable a feature flag, drain traffic), each with how to verify it.
- **Escalation:** who to contact and when.
- **Postmortem:** link to the template in `docs/operations/postmortems/`.

Commands must be copy-pasteable and state whether they are read-only or mutate state.
