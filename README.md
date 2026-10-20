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
- **Full isolation:** a service never depends on the root repo to build, test or deploy. `src/` is git-ignored.
- **Stack- and platform-agnostic:** each service chooses its language, architecture, cloud and CI provider.
- **Single AI source of truth:** rules and skills are written once in `.ai/` and exported to every agent.
- **Built-in engineering standards:** SDLC gates, Clean Code (SOLID, KISS, YAGNI), decoupled architecture (Dependency Inversion, explicit contracts, resilience) and Security by Design (OWASP, STRIDE, zero secrets).

---

## 🧩 Core skills

| Skill | Purpose |
|-------|---------|
| `sdlc` | End-to-end engineering workflow & quality gates (requirements → design → code → test → review → operate) |
| `architecture` | Stack-agnostic service design (domain isolation, dependency inversion, contracts, resilience) |
| `security` | Threat modeling (STRIDE) and OWASP security audit |
| `review` | Code/PR review across correctness, clean code, architecture, security and SDLC |
| `adr` | Immutable Architecture Decision Records |
| `rfc` | Request for Comments for high-impact or cross-service changes |
| `runbook` | On-call operational runbooks |

---

## 📁 Layout

```
base-ai/
├── AGENTS.md              # Global rules for AI agents (generated)
├── .ai/                   # Single AI source of truth (rules, config, skills)
├── .agents/skills/        # Exported skills (adr, rfc, runbook, review, architecture, security, sdlc)
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
npx create-base-ai my-project [--ci none|github|gitlab]   # initialise the root (or: base-ai init my-project)
base-ai service new api [--template service] [--repo url] # scaffold templates/service → src/api (git init)
base-ai service add web <repo> [--branch main]            # register in services.yaml and clone
base-ai service remove web [--purge]                      # remove from manifest (and optionally delete src/web)
base-ai sync                                              # clone/fast-forward all services
base-ai ai sync                                           # export .ai/ to every agent (root and services)
base-ai doctor                                            # fail if AI artefacts are out of date (for CI)
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
- [ ] Publish to npm (`base-ai` and `create-base-ai`)

## 📄 License

TBD.
