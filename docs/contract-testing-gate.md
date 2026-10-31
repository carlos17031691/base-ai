# Contract Testing Gate (BASE-008)

Closes #25

## Why
ROADMAP #25 requires a Quality Gate that performs semantic analysis (oasdiff / buf) and blocks merge when breaking change is introduced without versioning.

## What it does
- **Semantic analysis:** 
    - `oasdiff/oasdiff-action@v1` for OpenAPI (field rename, type change number->string, nullable->required, enum removed)
    - `bufbuild/buf-breaking-action@v1` for Protobuf
- **Compatibility Report:** Posts detailed report as PR comment when breaking detected
- **Blocking:** Fails CI with message `BREAKING: field {field} type changed. Need v2 or deprecated flag`

## Triggers
Only when PR touches:
- `**/openapi*.json`, `**/openapi*.yaml`
- `**/proto/**`, `**/*.proto`

## Future-proof
If no specs exist yet (current state), gate reports "ready for future specs" and passes. When first spec is added, it will start diffing against base.

## Related
- Issue #25
- BASE-008 roadmap