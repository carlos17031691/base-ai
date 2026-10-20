---
id: infrastructure
description: >-
  Design, deploy and monitor cloud infrastructure (AWS, GCP, Azure, Cloudflare,
  PaaS/K8s) using IaC, OIDC keyless auth, GitOps PR pipelines, Monitoring as
  Code and Cloud FinOps. Use when provisioning cloud resources, writing
  Terraform/OpenTofu/Pulumi/Dockerfiles or setting up CI/CD.
targets: all
---

# Cloud provider integration, Infrastructure as Code (IaC) & CI/CD

Help developers of any experience level choose, provision, secure and monitor cloud infrastructure inside each service repository (`src/<name>`):

## 1. Cloud provider & compute selection (right-sized for the team)
Guide the user to the simplest cloud architecture that meets their requirements (`adr` skill):
- **Managed Serverless / Container PaaS (recommended starting point):** Google Cloud Run, AWS App Runner / Fargate, Azure Container Apps, Cloudflare Workers or Fly.io — zero cluster maintenance, built-in TLS, autoscaling to/from zero and fast rollbacks.
- **Full Cloud IaC (AWS / GCP / Azure):** managed VPC, RDS/Cloud SQL, SQS/PubSub, S3/GCS and KMS when fine-grained network isolation, compliance or custom topologies are required.
- **Kubernetes (EKS / GKE / AKS):** use only when multi-service scheduling density, custom operators or strict portability justify the operational overhead.

## 2. Keyless Cloud authentication (OIDC — zero static cloud keys)
- **Never store long-lived cloud keys** (`AWS_SECRET_ACCESS_KEY`, GCP Service Account JSON keys, Azure Client Secrets) in Git or CI variables.
- Authenticate CI/CD pipelines to the cloud provider using **OpenID Connect (OIDC) federation**:
  - **AWS:** IAM OIDC Identity Provider + IAM Role scoped to the repository and branch/environment (`sts:AssumeRoleWithWebIdentity`).
  - **GCP:** Workload Identity Federation + Service Account with least-privilege IAM roles.
  - **Azure:** Workload Identity Federation (Federated Identity Credentials on Managed Identity / App Registration).
- Use separate IAM roles/identities for `staging` (triggered on `development`/`main`) and `production` (requiring protected environment approval).

## 3. Infrastructure as Code (IaC) & GitOps deployment workflow
- **Structure inside the service (`src/<name>/infrastructure/`):**
  - `modules/`: reusable, stateless resource definitions (compute, db, queue, monitoring).
  - `staging/` & `production/`: environment compositions with isolated remote state.
- **Remote state & locking:** store state in encrypted remote backends (S3 + DynamoDB/S3 lock, GCS, Azure Blob) — **never commit `*.tfstate` files to Git**.
- **Mandatory resource tags/labels:** apply `service = <name>`, `env = staging|production`, `managed_by = iac` and `cost_center` on every cloud resource.
- **PR-driven GitOps pipeline:**
  1. **On Pull Request:** run `fmt --check`, `validate`, IaC security scanning (`trivy config` / `checkov` / `tfsec`), generate the execution `plan` against `staging` and post the diff (plus cost delta) on the PR.
  2. **On merge:** automatically `apply` to `staging`, run smoke/health checks (`/healthz`, `/readyz`), and promote to `production` with approval gates and one-command rollback.
  3. **Drift detection:** schedule a daily read-only `plan -detailed-exitcode` job to alert if manual console changes occurred outside Git.

## 4. Cloud infrastructure monitoring (Monitoring as Code)
Provision cloud-native alarms, dashboards and log sinks **in the same IaC commit** as the infrastructure (`observability` skill):
- **Compute & containers:** alert on CPU/memory saturation (>80%), container restarts / `OOMKilled`, cold-start spikes and failed deployments.
- **Managed databases & caches (RDS / Cloud SQL / Redis):** alert on high connection utilization (>80% of max connections), storage capacity (<15% free), replication lag, high disk latency and failed automated backups.
- **Queues & event buses (SQS / PubSub / Kafka):** alert on `ApproximateAgeOfOldestMessage` (stalled consumers) and **any message > 0 in a Dead-Letter Queue (DLQ)**.
- **Edge, DNS & TLS:** monitor ALB/CDN/WAF `5xx` error rates, p95/p99 latency and TLS certificate expiration.
- **Cloud FinOps & budget alarms:** provision cloud billing budgets and anomaly detectors alerting at **50%, 80% and 100%** of the monthly spend threshold per service/environment.

## 5. Containers & 12-Factor runtime hardening
- Validate all environment variables at startup; provide a safe `.env.example`.
- Use multi-stage `Dockerfile`s with pinned image digests/versions, non-root `USER`, explicit `HEALTHCHECK` and graceful `SIGTERM` connection draining.
