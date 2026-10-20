# base-ai

> Generic CLI scaffolding for **scalable, AI-driven software projects**.

`base-ai` is not a framework and contains no application code. It defines the **root** of a project: the AI layer (rules, skills), cross-cutting governance (ADRs/RFCs) and a service registry. Each service or module lives in `src/<name>` as a **fully independent repository**, with its own stack, architecture, infrastructure and CI/CD.

---

## 🧭 Model

```mermaid
flowchart TD
    root["base-ai (root repo)"] --> ai[".ai/ + AGENTS.md: AI layer"]
    root --> docs["docs/: cross-cutting decisions"]
    root --> manifest["services.yaml: registry"]
    root --> tpl["templates/service/"]
    manifest -->|clone| s1["src/service-a (own repo)"]
    manifest -->|clone| s2["src/service-b (own repo)"]
    tpl -->|scaffold| s3["src/new-service"]
```

| Level | Responsibility | Repository |
|-------|----------------|------------|
| **Root** (`base-ai`) | AI layer, conventions, cross-cutting decisions, service registry | Own |
| **Service** (`src/<name>`) | Code, architecture, infrastructure, tests, CI/CD | Own and independent |

**Principles:**
- **Full isolation & own repository:** every service in `src/<name>` has its own remote Git repository (`repo` in `services.yaml`) and never depends on the root repo to build, test or deploy. `src/` is git-ignored.
- **Mandatory ticket traceability & PR-only workflow:** every change inside `src/<name>` must be tied to a Story/Epic/Task (Jira, ClickUp, Trello, etc.), committed on a working branch (e.g. `feat/PROJ-123-slug`) with the ticket ID in the commit message, and merged via **Pull Request** — direct commits or pushes to `main`, `master` or `development` are blocked by `.githooks/`.
- **Stack- and platform-agnostic:** each service chooses its language, architecture, cloud and CI provider.
- **Single AI source of truth:** rules and skills are written once in `.ai/` and exported to every agent.
- **Built for any experience level:** AI agents proactively guide developers from idea and service breakdown to production deployment, explaining trade-offs clearly along the way.
- **End-to-end engineering standards:** SDLC gates, Clean Code (SOLID, KISS, YAGNI), decoupled architecture, resilient external API/AI integrations, safe database design & migrations, observability, cloud infrastructure/CI/CD, living documentation and Security by Design (OWASP, STRIDE, zero secrets).

---

## 🧩 Core skills

| Skill | Purpose |
|-------|---------|
| `discovery` | Turn raw ideas into MVP scope, service boundaries (`services.yaml`), Epics & Gherkin User Stories (Jira/ClickUp/Trello) |
| `sdlc` | End-to-end engineering workflow & quality gates (ticket → branch → design → code → test → PR → operate) |
| `architecture` | Stack-agnostic service design (domain isolation, dependency inversion, contracts, resilience) |
| `integrations` | External APIs, third-party providers, webhooks, AI gateways (e.g. OpenRouter, LiteLLM) & LLM models |
| `ai-ops` | Model tiering/routing, prompt prefix caching, input/output token optimization & LLM cost/token telemetry (AI FinOps) |
| `agents` | Tool-using AI agents & MCP servers with least-privilege tools, Human-in-the-Loop and step/cost guardrails |
| `workflows` | Workflow automation & orchestration engines (e.g. n8n, Temporal, queues) with GitOps, security & idempotency |
| `memory` | Persistent cross-session project memory (`.ai/memory.md`) & short/long-term AI application memory architecture |
| `rag` | Retrieval-Augmented Generation (chunking, embeddings, hybrid search, pre-retrieval ACLs, grounded citations & evaluation) |
| `database` | SQL/NoSQL/cache modeling, indexing, concurrency & zero-downtime migrations (Expand & Contract) |
| `testing` | Test pyramid (unit, integration, E2E), cross-service Contract Testing & deterministic AI/RAG Evals |
| `observability` | Structured logs, RED/USE metrics, SLIs/SLOs, distributed tracing, health probes, cloud alarms & alerting |
| `infrastructure` | Cloud providers (AWS/GCP/Azure/Cloudflare/PaaS), keyless OIDC auth, IaC GitOps (`plan`→`apply`), Monitoring as Code & Cloud FinOps |
| `security` | Threat modeling (STRIDE) and OWASP security audit |
| `review` | Code/PR review across traceability, clean code, architecture, security and SDLC |
| `docs` | Service READMEs, OpenAPI/AsyncAPI contracts, architecture diagrams & postmortems |
| `adr` | Immutable Architecture Decision Records |
| `rfc` | Request for Comments for high-impact or cross-service changes |
| `runbook` | On-call operational runbooks |

---

## 📁 Layout

```
base-ai/
├── AGENTS.md              # Global rules for AI agents (generated)
├── .ai/                   # Single AI source of truth (rules, config, skills)
├── .agents/skills/        # Exported skills (19 core skills across discovery, SDLC, AI/FinOps, architecture, data, ops & security)
├── docs/
│   ├── architecture/{adrs,rfcs}/        # Cross-cutting decisions
│   └── operations/{runbooks,postmortems}/
├── services.yaml          # Service registry (repo, optional branch)
├── templates/service/     # Minimal, stack-neutral service template
└── src/                   # Cloned services (git-ignored)
```

---

## 🚀 CLI

```bash
npx @carlos17031691/base-ai init my-project [--ci none|github|gitlab]     # initialise the root project (or: npm i -g @carlos17031691/base-ai)
base-ai service new api <repo> [--cloud aws|gcp|...] [--iac opentofu|terraform|pulumi|...] # scaffold service + optional IaC
base-ai service add web <repo> [--branch main]            # register in services.yaml, clone & install git hooks
base-ai service remove web [--purge]                      # remove from manifest (and optionally delete src/web)
base-ai sync                                              # clone/fast-forward all services, install hooks & ai sync
base-ai ai sync                                           # export .ai/ to every agent & refresh context index
base-ai ai stats                                          # inspect token footprint of always-on rules vs on-demand skills
base-ai memory add "<note>" [--ticket ID] [--tag tag]     # persist cross-session project memory & sync agents
base-ai memory list [--service <name>]                    # list persisted project memory notes
base-ai context search "<query>" [--scope root|service:x] # retrieve ranked ADRs, RFCs, runbooks, memory & contracts
base-ai doctor                                            # validate services.yaml & fail if AI artefacts drift (CI)
```

CLI development: `cd cli && npm install && npm test`.

---

## 🤖 Supported agents

| Agent | Generated file(s) |
|-------|-------------------|
| Antigravity / Gemini | `AGENTS.md`, `.agents/skills/` |
| Claude Code | `CLAUDE.md`, `.claude/commands/` |
| Cursor | `.cursor/rules/*.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/prompts/` |
| OpenAI Codex | `AGENTS.md` |

---

## 🗺️ Roadmap

- [x] Root layout + minimal service template
- [x] ADR-0001: CLI architecture, manifest and single AI source
- [x] English `.ai/rules.md` and generic skills (`adr`, `rfc`, `runbook`, `review`)
- [x] CLI: `init`, `service new|add|remove`, `sync`, `ai sync`, `doctor`
- [x] Publish to npm (`base-ai`)

## 📄 License

MIT.
