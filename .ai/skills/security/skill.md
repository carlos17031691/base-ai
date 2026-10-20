---
id: security
description: >-
  Perform threat modeling (STRIDE) and security auditing (OWASP, secrets, input
  validation, authz, supply chain, safe logging). Use when designing features,
  auditing code or reviewing sensitive changes.
targets: all
---

# Security audit & threat modeling

Evaluate the design or code diff against defense-in-depth and OWASP principles:

1. **Threat modeling (STRIDE):**
   - Identify trust boundaries, entry points, privileged operations and sensitive assets (credentials, PII, financial or tenant data).
   - Assess Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service and Elevation of Privilege.

2. **Input validation & injection defense:**
   - All external inputs (HTTP, CLI, queues, webhooks, files) validated by strict schema (type, length, range, allowlist).
   - SQL/NoSQL queries parameterized; OS commands invoked without shell interpolation (`execFile` over `exec`); path traversal prevented via canonicalization + allowlist; SSRF, XSS and deserialization risks mitigated.

3. **Authentication, authorization & isolation:**
   - Strong authentication on all non-public entry points.
   - Explicit action- and resource/tenant-level authorization (prevent IDOR / BOLA).
   - Principle of least privilege for runtime roles, DB users and CI permissions.

4. **Secrets & data protection:**
   - No hardcoded secrets, keys, tokens or private URLs in code, config, tests or docs.
   - Encryption in transit (TLS) and at rest for sensitive data; PII/secrets redacted from logs, metrics and error responses.

5. **Resilience against abuse:**
   - Rate limiting, request size limits, timeouts and replay protection (idempotency / webhook signature + timestamp verification).

6. **Supply chain & dependencies:**
   - Minimal, well-maintained dependencies; lockfiles committed; no unpinned external scripts in CI.

Report findings ordered by severity (**Critical**, **High**, **Medium**, **Low**) with `file:line`, exploit scenario and concrete remediation.
