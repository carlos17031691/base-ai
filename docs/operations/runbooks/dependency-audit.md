# Runbook: dependency audit in CI

Ticket BASE-124-A (issue #124, ticket A). The policy lives in `templates/service/.github/scripts/dependency-audit.cjs`; this repo runs that same file, so there is one script, one accepted-file format and one runbook.

## What the step does and where

The step is named `Dependency audit (High/Critical, production dependencies)`. It has no `if:`, no `continue-on-error` and no fallback, and it does four things in order:

1. Downloads the OSV-Scanner release binary (`osv-scanner_linux_amd64`) at the version in `OSV_SCANNER_VERSION`.
2. Checks it against `OSV_SCANNER_SHA256` with `sha256sum --check`. A mismatch stops the step before the binary runs.
3. Creates an empty file, `$RUNNER_TEMP/osv-scanner-empty.toml`, and runs the scan with `--config` pointing at it, with JSON output to a file under `$RUNNER_TEMP`, and keeps the scanner's exit status. With an explicit configuration the scanner does not look for an `osv-scanner.toml` beside the lockfiles, so such a file in the repository is never read and cannot hide an advisory.
4. Runs the policy script with the results file, the accepted file and that exit status. The script's exit status is the step's.

| Where | Workflow and job | What is scanned | Script | Accepted file |
|---|---|---|---|---|
| This repo | `.github/workflows/ci.yml`, job `cli` (a required check) | `cli/package-lock.json` only | `templates/service/.github/scripts/dependency-audit.cjs` | `.github/dependency-audit-accepted.json` |
| A generated service | `.github/workflows/ci.yml`, job `service` (from `templates/service/`) | every lockfile in the repository, recursively; no lockfile is a pass | `.github/scripts/dependency-audit.cjs` | `.github/dependency-audit-accepted.json` |

The policy:

- **Blocks:** an advisory with a CVSS base score of 7.0 or more (High or Critical), or with no score (`unscored`), in a production dependency.
- **Reports only:** an advisory below 7.0 (`below-high`), and any advisory in a package that is in the development group only (`dev-only`). These never fail the build.
- **Fails closed:** a scanner exit status other than 0 (nothing found) or 1 (vulnerabilities found), a missing or unreadable results file, exit status 1 with no finding the script can read, or an invalid accepted file fails the build.

The step runs on pull requests and on pushes to `main` and `development`. There is no scheduled run: an advisory published while no PR is open is seen at the next run, and it can then fail a PR that did not cause it. Handle it the same way (fix first), in that PR or in its own ticketed PR.

In this repo, when the step fails, the later steps of the `cli` job (token budget, SonarCloud scan, the Slack "ready" notification) do not run.

## How to read a failure

Open the failed step's log, or the job summary, which has the same content: the findings as a table (with the source lockfile, and the expiry and reason of an accepted one), then the stale entries, the errors and the fix hint. The script prints one line per finding, in up to three groups, then the errors, then one verdict line:

```
BLOCKING (1):
  GHSA-xxxx-xxxx-xxxx  some-package@1.2.3 (npm)  severity 8.1  high-or-critical  package-lock.json
REPORTED, not blocking (1):
  GHSA-yyyy-yyyy-yyyy  other-package@0.4.0 (npm)  severity 5.3  below-high  package-lock.json
To fix: upgrade or remove the package. Only when neither is possible, add a reviewed entry
(id, reason, accepted, expires; at most 90 days) to .github/dependency-audit-accepted.json by pull request.
dependency audit: FAIL (1 blocking, 0 error(s))
```

Each finding line is: advisory id, package and version, ecosystem, severity, the reason code, and the lockfile it came from. Values taken from the lockfile or the accepted file are printed on one line, cut at 200 characters, with `::` shown as `: :` and `##[` as `## [`, so that a value can never be read as a workflow command; search the lockfile for the original spelling.

| What the log shows | Meaning | What to do |
|---|---|---|
| `BLOCKING` with `high-or-critical` | A High or Critical advisory in a production dependency | "Fix first" below |
| `BLOCKING` with `unscored` | The advisory has no severity score (malicious-package records are among these) | Read the advisory; "Fix first" below |
| `BLOCKING` with `acceptance-expired` | An accepted entry for this advisory is past its `expires` date, and no unexpired entry names the same advisory | "What happens at expiry" below |
| `ACCEPTED` | Covered by a valid, unexpired entry; the line shows `until <date>` and the reason | Nothing, until the date |
| `REPORTED, not blocking` with `below-high` or `dev-only` | Low or Medium, or a development-only package | Nothing is required; upgrade when convenient |
| `stale accepted entry (matches no finding, can be removed)` | An entry matches no finding in any group, the reported ones (`below-high`, `dev-only`) included | Remove it in the next PR; it does not fail the build |
| `ERROR: accepted file: ...` | The accepted file is not valid JSON, is not an array, or an entry breaks a rule; the message names the entry and the rule | Correct the file ("How to accept an advisory") |
| `ERROR: scanner failed: exit status <n>` or `ERROR: scanner results are missing or are not the expected JSON` | The scanner did not complete | "Scanner or OSV outage" below |
| `ERROR: scanner reported vulnerabilities (exit status 1) but none could be read from its results` | The scanner found something and wrote it in a shape the script does not read; the build fails instead of passing | Read the scanner's own output above the script's lines; check the JSON fields in step 4 of "How to update the pin" |
| The step stops at the `sha256sum` line, or at `curl` | The download failed or the binary does not match the pin | "Scanner or OSV outage", then "How to update the pin" |
| `usage: dependency-audit.cjs ...` | The workflow step calls the script with wrong options | Restore the step's `run` block |

The verdict line is `dependency audit: PASS` or `dependency audit: FAIL (<n> blocking, <n> error(s))`.

To reproduce locally, download the same OSV-Scanner version for your platform from the `google/osv-scanner` release page, check its hash against the release's checksums file, and run the last commands of the step's `run` block (the empty configuration file, the scan with `--config`, the script) with a temp directory in place of `$RUNNER_TEMP`.

## Fix first (upgrade, remove)

In this order:

1. **Upgrade** the package to a version without the advisory. For a transitive dependency, upgrade the direct dependency that brings it in, or refresh the lockfile.
2. **Remove or replace** the package when no fixed version exists.
3. **Accept** the advisory only when neither is possible and the vulnerable code is not reachable. See the next section.

A change to a dependency manifest or lockfile is a normal ticketed change: working branch from `development`, PR, human approval.

## How to accept an advisory

Add an entry to `.github/dependency-audit-accepted.json`. The file is a JSON array; each entry is an object with exactly these four string keys:

```json
[
  {
    "id": "GHSA-xxxx-xxxx-xxxx",
    "reason": "Not reachable: the affected parser is never given untrusted input.",
    "accepted": "2026-01-15",
    "expires": "2026-03-15"
  }
]
```

The limits, all enforced by the script:

- `id`: 3 to 64 characters with no whitespace. It matches a finding when it equals, ignoring case, one of the advisory's ids or aliases, so a `GHSA-...` or a `CVE-...` id both work.
- `reason`: at least 20 characters after trimming. Say why the advisory does not apply or cannot be fixed yet.
- `accepted` and `expires`: real calendar dates as `YYYY-MM-DD`. `accepted` is not after today (UTC), `accepted` is not after `expires`, and `expires` is at most 90 days after `accepted`.
- No other key, no missing key, no non-string value, and no id twice (ignoring case).

One broken rule fails the build even when the scan finds nothing, and while the file is invalid none of its entries applies. A malformed acceptance therefore cannot be merged.

The accepted file is the only exception path. `osv-scanner.toml`, the scanner's own ignore file (`[[IgnoredVulns]]`, `[[PackageOverrides]]`), is not one: the step runs the scan with an explicit empty configuration (`--config "$RUNNER_TEMP/osv-scanner-empty.toml"`), so an `osv-scanner.toml` anywhere in the repository is never read and an advisory listed in it still blocks. Do not add one, and do not remove `--config` from the step.

The process:

- An acceptance is a ticketed Pull Request to `development`, like any change. In this repo, `.github/CODEOWNERS` asks the owner to review a change to the accepted file and to the gate's script; human approval is mandatory as for every PR.
- The PR says which package and advisory it is, why upgrade and removal are not possible, and what would allow the entry to be removed.
- An acceptance covers one advisory in one repository. This repo and each generated service have their own file.

## What happens at expiry

From the day after `expires`, the entry stops applying. If the advisory is still found, it is listed as `BLOCKING` with `acceptance-expired` and the build fails again, on every PR and push.

- Check first whether a fixed version now exists, and upgrade if so; then remove the entry.
- To keep the acceptance, open a new PR with new `accepted` and `expires` dates (at most 90 days again) and a reason that is still true. It gets a new review; there is no automatic renewal.
- An entry whose advisory is no longer found is reported as stale and can be removed.

## Scanner or OSV outage

The step fails closed. It fails, and never passes, when the binary cannot be downloaded, the checksum does not match, the scanner cannot reach the OSV database, the scanner exits with a status other than 0 or 1 (for example 127 for an unreadable lockfile path, 128 when no package source is found), or it exits with 1 and the script can read no finding in its results.

1. **Re-run the job.** A download or OSV outage is usually short.
2. If it still fails, read the scanner's own output above the script's lines to tell an outage from a real fault (a wrong path, a changed option, a checksum mismatch).
3. A checksum mismatch that survives a re-run is not an outage. Do not change `OSV_SCANNER_SHA256` to make it pass; compare with the release's published checksums file and follow "How to update the pin" only if the release itself is the one intended.
4. **Last resort:** the admin bypass described in `branch-rulesets.md` ("Bypass"), for an emergency hotfix only, justified in a comment on the PR. It is never used to skip a real blocking advisory.

## How to update the pin

`OSV_SCANNER_VERSION` and `OSV_SCANNER_SHA256` are `env` values of the step. They are identical in two files, and a test in `cli/src/test/dependency-audit.test.ts` fails when they differ:

- `.github/workflows/ci.yml` (job `cli`)
- `templates/service/.github/workflows/ci.yml` (job `service`)

To update:

1. Open a ticket and a working branch from `development`.
2. Pick a stable (not pre-release) `google/osv-scanner` release. Take the SHA-256 of `osv-scanner_linux_amd64` from that release's published checksums file, and confirm it equals the hash you compute on the downloaded asset.
3. Change both values, together, in both workflows. Never change one without the other, and never one file without the other.
4. Check that the new version still accepts the two command lines of the steps, that `--config` with the empty file still stops it from reading an `osv-scanner.toml` beside a lockfile (a High advisory ignored in such a file must still fail), and that it still writes the JSON fields the script reads (`results[].source.path`, `results[].packages[].package`, `dependency_groups`, `groups[].ids`, `aliases`, `max_severity`), and that the exit statuses are still 0 for nothing found and 1 for vulnerabilities found.
5. Open the PR. Its own `cli` run is the first real execution of the new pin: the log must show the checksum line `OK` and the script's verdict line. The reviewer compares both values with the release page.

A service generated before the update keeps its old pin until its own workflow is updated the same way, in that service's repository.

## What the audit covers in this repo

- The step scans `cli/package-lock.json` only. `cli/` has one production dependency, `yaml`, which parses `services.yaml`, `.ai/config.yaml` and eval files on the user's machine. The gate protects users of the published package against a known High or Critical advisory in `yaml` and in any production dependency added later.
- Development dependencies (`typescript`, `@types/node`) never reach users. Their findings are printed as `dev-only` and never fail the build.
- When the gate was added (2026-11-23, OSV-Scanner 2.7.1), the scan found no advisory in production or development dependencies and the accepted file was `[]`.
- Not covered: the release workflow has no audit step of its own (the release PR to `main` already needs the `cli` check); the GitHub Actions used by the workflows; a language or lockfile format OSV-Scanner does not read.
- In a generated service, "production only" depends on the lockfile recording a development group. Where it does not (for example a plain `requirements.txt`), every package in the file is audited as production. See the "Dependency audit" section of the service's `README.md`.
