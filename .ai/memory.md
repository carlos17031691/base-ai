# Project Memory

<!-- Persistent cross-session memory for AI agents (see `memory` skill).
     Add entries with `base-ai memory add "<note>" [--ticket ID] [--tag tag]` or edit this file directly, then run `base-ai ai sync`.
     Never store secrets, API keys or personal data (PII) here. -->
- **[2026-10-20]** `[BASE-002]` `#sdlc` init and service new must bootstrap initial commit on main + development branch BEFORE activating .githooks (ADR-0002)
- **[2026-10-20]** `[BASE-002]` `#sdlc` Working branches must branch from development, open PRs targeting development (staging), and publish review+security audit before merge (ADR-0002)
