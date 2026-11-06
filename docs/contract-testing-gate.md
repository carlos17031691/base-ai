# Contract Testing Gate (BASE-008)

Closes #25

## Purpose

Automated quality gate that performs semantic analysis on API contracts
(OpenAPI and Protobuf) and blocks merge when a breaking change is
introduced without a version bump.

## How it works

1. **Spec detection:** checks whether OpenAPI or Protobuf files exist
   before running analysis tools — avoids false positives on repos
   without specs yet.
2. **Semantic analysis:**
   - `oasdiff/oasdiff-action/breaking@v0.1.21` for OpenAPI (field
     rename, type change, nullable→required, enum removed)
   - `buf breaking` via `bufbuild/buf-setup-action@v1.50.0` for
     Protobuf (replaces archived `buf-breaking-action`)
3. **Compatibility report:** posts/updates a single sticky PR comment
   when breaking changes are detected, and always writes a job summary.
4. **Blocking:** fails CI with `core.setFailed` when breaking changes
   are found.

## Triggers

Runs on `pull_request` only when the PR touches:

- `**/openapi*.json`, `**/openapi*.yaml`
- `**/proto/**`, `**/*.proto`
- `.github/workflows/contract-gate.yml`

## Security hardening

- All GitHub Actions pinned to full SHA commits
- `persist-credentials: false` on checkouts — no token on disk for
  third-party actions
- `review: false` on oasdiff — specs never leave CI
- Step outcomes passed via `env:` (not expression interpolation)
- Fork PRs get read-only token; comment failure is caught gracefully
- `concurrency` group cancels redundant runs per PR
- `timeout-minutes: 10` prevents runner exhaustion

## Future-proof

If no specs exist yet, the gate reports "ready for future specs" and
passes. When the first spec is added, it starts diffing against the
base branch automatically.

## Related

- Issue #25
- BASE-008 roadmap
- PR #35 (original), PR #36 (hardened)
