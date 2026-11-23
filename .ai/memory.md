# Project Memory

<!-- Persistent cross-session memory for AI agents (see `memory` skill).
     Add entries with `base-ai memory add "<note>" [--ticket ID] [--tag tag]` or edit this file directly, then run `base-ai ai sync`.
     Never store secrets, API keys or personal data (PII) here. -->
- **[2026-10-20]** `[BASE-002]` `#sdlc` init and service new must bootstrap initial commit on main + development branch BEFORE activating .githooks (ADR-0002)
- **[2026-10-20]** `[BASE-003]` Every HTTP/gRPC service must include an executable runtime bootstrap (main) matched to Dockerfile CMD and an HTTP smoke test verifying real socket binding on PORT, /healthz, /readyz and SIGTERM graceful shutdown
- **[2026-10-21]** `[BASE-004]` Environment isolation must separate GCP projects and billing alerts by environment (staging vs production), and CI/CD OIDC deployers require exactly: roles/run.admin, roles/artifactregistry.writer, roles/iam.serviceAccountUser, roles/cloudbuild.builds.editor, roles/storage.admin, roles/serviceusage.serviceUsageConsumer, and roles/viewer
- **[2026-10-21]** `[BASE-005]` `#ai-ops,integrations,infrastructure` AI integrations using OpenRouter/LLM gateways should support a prioritized comma-separated model cascade (AI_MODELS) to automatically roll over on 429 quota exhaustion or timeouts, enforce explicit 'json' wording in prompts when json_object mode is requested, and sandbox projects must block production CD jobs with if: false.
- **[2026-10-21]** `[BASE-006]` `#infrastructure,gitops,security` Zero direct cloud mutations allowed via CLI or console. All infrastructure changes must flow through version-controlled OpenTofu/Terraform with remote state object versioning enabled in GCS/S3 to guarantee deterministic auditability and automated rollback.
- **[2026-10-22]** `[BASE-008]` `#sdlc,integrations` Slack CI notifications must invoke pr_ready_for_review event to generate rich Block Kit attachments with zero unresolved conversations reminder and must use .cjs extension for Node.js ES module compatibility.
- **[2026-10-22]** `[BASE-008]` `#testing,sdlc` SonarCloud analysis for services using root organization key requires explicit exclusion of .github automation scripts and cpd duplication check suppression to pass Quality Gate on new code.
- **[2026-10-22]** `[BASE-009]` `#agents,mcp` Native Model Context Protocol (MCP) server over stdio (`base-ai mcp`) exposes search_context, get_memory, add_memory, check_health, get_ai_stats, and list_services tools with zero external dependencies.
