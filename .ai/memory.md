# Project Memory

<!-- Persistent cross-session memory for AI agents (see `memory` skill).
     Add entries with `base-ai memory add "<note>" [--ticket ID] [--tag tag]` or edit this file directly, then run `base-ai ai sync`.
     Never store secrets, API keys or personal data (PII) here. -->
- **[2026-10-20]** `[BASE-002]` `#sdlc` init and service new must bootstrap initial commit on main + development branch BEFORE activating .githooks (ADR-0002)
- **[2026-10-20]** `[BASE-002]` `#sdlc` Working branches must branch from development, open PRs targeting development (staging), and publish review+security audit before merge (ADR-0002)
- **[2026-10-20]** `[BASE-003]` Every HTTP/gRPC service must include an executable runtime bootstrap (main) matched to Dockerfile CMD and an HTTP smoke test verifying real socket binding on PORT, /healthz, /readyz and SIGTERM graceful shutdown
- **[2026-10-21]** `[BASE-004]` Environment isolation must separate GCP projects and billing alerts by environment (staging vs production), and CI/CD OIDC deployers require exactly: roles/run.admin, roles/artifactregistry.writer, roles/iam.serviceAccountUser, roles/cloudbuild.builds.editor, roles/storage.admin, roles/serviceusage.serviceUsageConsumer, and roles/viewer
