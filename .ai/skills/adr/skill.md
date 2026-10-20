---
id: adr
description: >-
  Create an immutable Architecture Decision Record (ADR) documenting the what,
  why and how of a technical decision. Use when asked to record an architecture
  decision or create an ADR.
targets: all
---

# ADR (Architecture Decision Record)

1. Determine scope: **cross-cutting** decisions go in the root; **service-specific** ones in `src/<name>/`.
2. Find the next free number in `docs/architecture/adrs/` and create `ADR-XXXX-short-title.md`.
3. Use this structure:
   - **Title and metadata:** date, status (`Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-YYYY`), authors.
   - **Context and problem:** the technical, business or regulatory forces behind the decision.
   - **Decision:** what is adopted and how, concrete and verifiable.
   - **Impact:** effects on security, resilience, performance, cost and operations.
   - **Consequences:** positive and negative trade-offs, risks and mitigations.
   - **Alternatives considered:** options evaluated and why they were rejected.
4. Accepted ADRs are immutable: to change a decision, write a new ADR and mark the old one `Superseded by`.
