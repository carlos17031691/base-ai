---
id: infrastructure
description: >-
  Design and review cloud infrastructure (IaC), containers, environment
  configuration, CI/CD pipelines and safe deployment strategies. Use when
  containerizing a service, writing Terraform/Pulumi/Dockerfiles or setting up
  CI/CD.
targets: all
---

# Infrastructure, containers & CI/CD

Build reproducible, secure and scalable infrastructure inside each service repository:

1. **12-Factor configuration & secrets:**
   - Inject environment-specific configuration via environment variables validated at startup (fail fast if required config is missing).
   - Keep zero secrets in Git; fetch credentials from secret managers or encrypted CI/runtime stores. Provide a safe `.env.example` with dummy placeholders for local development.

2. **Containers & runtime hardening:**
   - Use multi-stage `Dockerfile`s with pinned base images, minimal runtime layers, non-root user (`USER`), explicit `HEALTHCHECK` and `.dockerignore`.
   - Handle `SIGTERM` for graceful shutdown (stop accepting traffic, drain in-flight requests, close DB/queue connections).

3. **Infrastructure as Code (IaC):**
   - Organize IaC into reusable modules (`infrastructure/modules/`) and isolated environments (`staging`, `production`) with remote state locking.
   - Enforce least-privilege IAM roles, network segmentation (private subnets for databases/caches), encryption in transit/at rest and resource tagging.

4. **CI/CD pipelines & safe delivery:**
   - Gate every Pull Request on: formatting/linting, type checking, unit/integration tests, dependency/secret scanning and build verification.
   - Deploy immutable build artifacts through progressive stages (`staging` → `production`) with automated smoke checks and one-command rollback.
