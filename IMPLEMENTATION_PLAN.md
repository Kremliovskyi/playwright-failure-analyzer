# Playwright Failure Analyzer: Implementation Plan

Date: 2026-11-02

Status: user published 0.1.0; consumer implementation and local validation complete.

Publication was performed and confirmed by the user on 2026-11-05. Both consumers
now pin the public npm release. No additional publication, commit, push, real
regression run, or billable inference was performed during integration.

### Implementation outcome

The package-only deliverable is version 0.1.0: the extracted schema-v4 engine,
prepared-run API, full-report runner, and CLI are implemented. Coverage, workload
limits, cancellation, tool-free sessions, and persistent partial/fatal results
are included. The dashboard's duplicate source and algorithm tests have now been
removed; its lifecycle and published-package integration tests remain.

Implementation decisions:

- Use SDK 1.0.14 and its bundled runtime 1.0.85. SDK 1.0.28 pins vulnerable Zod
  4.3.6; 1.0.14 permits a patched resolution without downstream-ineffective
  overrides. The package lock records the tested dependency tree.
- Reuse reader 4.2.8's public return types with TypeScript type derivation instead
  of changing or publishing the reader to expose additional aliases.
- Build CommonJS and declarations; verify ESM named imports from an independent
  packed consumer rather than introducing a second build.
- Keep live billable inference separate from synthetic tests. The earlier
  Actions CLI 1.0.105 check is not proof for the packaged SDK/runtime/models.

### Consumer validation (2026-11-05)

- All 18 original engine tests passed against the installed npm package before
  duplicate tests and source files were removed.
- Dashboard: build and 42 affected integration/lifecycle tests passed on a clean
  Linux installation; seven targeted browser workflows passed on Windows.
- The user approved repair of the pre-existing dashboard lockfile inconsistency.
  The SDK's compatible Zod dependency was also updated to a patched resolution.
  Unrelated dependency audit findings remain outside this migration.
- CI: clean Node 24 `npm ci --ignore-scripts` and the installed CLI passed.
  Actionlint passed with only its unsupported `copilot-requests` permission
  diagnostic excluded; that permission is documented by GitHub.
- An actual generated Playwright 1.63.0 failing test verified that the CLI trace
  override retains both failed retries despite project-level tracing being off.
  The published analyzer prepared that report with complete retry coverage and
  preserved a failed result for deliberately missing CI authentication.
- All 32 scheduling combinations, exact artifact handoff, 30-minute deadline,
  40-minute job timeout, absent attempt cap, and bounded count-only summaries
  were checked. No real application data or model request was used.
- The workflow still needs to be committed/pushed and dispatched. Live access
  through the packaged SDK to both selected models remains a CI pilot check.

### Local release verification (2026-11-05)

- Windows: Node 22.20.0, npm 10.9.3; all 46 tests pass.
- Clean Linux container: Node 24.20.0, npm 11.19.0; all 46 tests pass.
- Dependency audit: zero reported vulnerabilities.
- Independent tarball consumer: CommonJS, ESM named imports, TypeScript
  declarations, executable, and bundled runtime startup/shutdown pass.
- Generated report integration tests cover preparation, coverage, exact source
  evidence, grouping, caps, token usage, cancellation, and partial/fatal outputs.
- Public tarball contains compiled code/declarations, README, license, and npm
  metadata only. No consumer code, reports, credentials, or fixtures are included.
- No live inference or target-organization SDK/model smoke test was run; no
  publication or consumer integration was performed.

## 1. Confirmed scope

Create the public npm package
`@andrii_kremlovskyi/playwright-failure-analyzer`, then migrate the report
application and integrate the package into regression CI.

The first release will provide:

- A TypeScript library API and a Node.js CLI.
- The existing per-attempt explanation and run-level grouping engine.
- GitHub Copilot authentication through local credentials, explicit tokens, and
  the built-in GitHub Actions token.
- Structured evidence, human-readable output, progress, and explicit failures.
- Windows support for the dashboard and Linux support for GitHub Actions.

The first release will not add BYOK providers, a hosted service, automatic test
fixes, test reruns, ADO integration, historical comparisons, or screenshot-based
model analysis. It will not run the dashboard in CI or move trace parsing into
the new package.

Public package sources, documentation, and fixtures must contain no private test
code, production reports, credentials, or organization-specific configuration.

## 2. Existing implementation and ownership

| Source                                                                                                                      | Reuse or migration                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [copilot-analyzer.ts](../playwright-reports/src/copilot-analyzer.ts)                                                        | Move authentication helpers, per-attempt prompts, validation flow, worker pool, and evidence writing                                             |
| [copilot-evidence.ts](../playwright-reports/src/copilot-evidence.ts)                                                        | Move schema-v4 types, validators, and deterministic renderers                                                                                    |
| [copilot-grouper.ts](../playwright-reports/src/copilot-grouper.ts)                                                          | Move grouping prompts, bounded evidence retrieval, reference repair, diagnostics, and rendering                                                  |
| [analysis-routes.ts](../playwright-reports/src/analysis-routes.ts)                                                          | Keep HTTP handling, configuration, report identity, preparation queue integration, database writes, replacement confirmation, and SSE adaptation |
| [vault-files.ts](../playwright-reports/src/vault-files.ts) and [vault-routes.ts](../playwright-reports/src/vault-routes.ts) | Update imports of the grouped-analysis filename; keep vault behavior in the dashboard                                                            |
| [Reader public API](../playwright-traces-reader/src/index.ts)                                                               | Continue owning report metadata, trace parsing, preparation, compatibility, and cache behavior                                                   |
| [Reader manifest types](../playwright-traces-reader/src/cli/json.ts)                                                        | Reuse the public preparation return type with derived aliases; no reader change required                                                         |
| [Regression workflow](../prod/sc-tests/.github/workflows/main.yml)                                                          | Add opt-in analysis and an isolated consumer job after the package is ready                                                                      |

The dashboard is currently CommonJS and already has synthetic analysis tests.
Preserve its [architecture invariants](../playwright-reports/ARCHITECTURE.md) and
[failure-analysis contracts](../playwright-reports/docs/failure-analysis.md).

### Dependency direction

```text
playwright-reports -----------+
                             +--> playwright-failure-analyzer
sc-tests / GitHub Actions ----+          |
                                        +--> playwright-traces-reader
                                        +--> @github/copilot-sdk
```

The dashboard can retain its direct reader dependency for discovery, trace
digestion, and queued preparation. The new package must not depend on either
consumer, Express, SQLite, PM2, or the browser-test runner.

## 3. Behavior to preserve

Extraction is not a prompt redesign. Preserve these baseline rules:

1. Each failed attempt/retry is independent, including failed attempts from
   eventually passing tests.
2. Existing Before Hooks and skipped-entry exclusions remain explicit.
3. Each fenced Error details block is one issue, in source order.
4. Application code attaches exact source blocks; models do not recreate them.
5. Evidence stays at schema version 4. Reader manifests retain their own schema
   version; package versions do not reset artifact schema versions.
6. One correction turn is allowed for invalid per-attempt responses. Source-backed
   fallbacks remain available and visibly marked.
7. Grouping is model-owned. Code validates references, not semantic similarity.
8. Preserve one bounded evidence round and one reference-repair turn.
9. Preserve all valid issues through structural grouping fallbacks.
10. Failure of one attempt does not discard the other attempts.
11. Grouping remains conditional on more than one analyzable attempt. A new
    deterministic run summary will also cover zero and one attempt.

Preserve the existing defaults and evidence limits:

| Limit                                 | Current value     |
| ------------------------------------- | ----------------- |
| Trace preparation workers             | 4                 |
| Concurrent attempt analyses           | 3                 |
| Each attempt request/correction       | 180,000 ms        |
| Each grouping/evidence/repair request | 600,000 ms        |
| Grouping explanation field            | 1,200 characters  |
| Evidence requests                     | 10                |
| Issues per evidence request           | 4                 |
| Total evidence issue references       | 30                |
| Evidence section                      | 6,000 characters  |
| Total retrieved evidence text         | 48,000 characters |
| Evidence source file read             | 4 MiB             |

Intentional hardening changes are separate from semantic extraction: disabling
agent tools, surfacing cleanup/write errors, validating external manifests, and
making incomplete coverage and partial results visible.

## 4. Package structure and compatibility

Start with a small TypeScript package:

```text
src/
  index.ts
  cli.ts
  analysis.ts
  reader.ts
  copilot-analyzer.ts
  copilot-evidence.ts
  copilot-grouper.ts
tests/
  copilot-analyzer.test.js
  copilot-grouper.test.js
  analysis.test.js
  cli.test.js
  package.test.js
README.md
LICENSE
package.json
package-lock.json
tsconfig.json
```

Keep the existing module names during extraction. Add shared type/helper modules
only when needed to avoid duplication or cycles.

- Compile TypeScript to CommonJS plus declaration files, matching the existing
  dashboard and reader. Verify both `require()` and ESM named imports from the
  packed package before choosing a more complex dual build.
- Publish an explicit root API and a `playwright-failure-analyzer` executable.
- Use Node's built-in argument parser and `node:test`; no new test framework or
  provider abstraction is required.
- Keep imports side-effect free: importing types, constants, or renderers must
  not start Copilot, authenticate, prepare reports, or make requests.
- Preserve existing MIT attribution when moving code.
- Publish only the compiled runtime/declarations, README, and license.

### SDK/runtime compatibility gate

The dashboard currently uses SDK 1.0.3. The successful Actions authentication
check used Copilot CLI 1.0.105; it did not prove the dashboard's SDK runtime works
with an installation token.

SDK 1.0.28 was evaluated but not selected because it pins vulnerable Zod 4.3.6.
The implemented SDK 1.0.14 uses platform-specific optional runtime packages and
allows patched Zod resolutions. Do not assume its runtime layout is identical
to SDK 1.0.3, and do not omit optional dependencies.

Compatibility requirements:

- Verify its actual client/session, permissions, cancellation, and shutdown APIs.
- Test Windows and Linux installation without a global Copilot CLI.
- Preserve the dashboard's supported Node range where verified; do not silently
  raise the consumer's minimum Node version.
- Use Node 24 for the initial regression-CI integration, matching the working
  authentication check.
- Pin the validated SDK version initially and commit lockfiles. Record resolved
  package/runtime versions in diagnostics.

## 5. Library API

Use one implementation with two entry paths.

### Full report analysis

Expose `analyzeFailures(options)` for CLI and standalone consumers:

- Required: report root, output parent, small model, big model.
- Optional: explicit authentication, validated limits, `AbortSignal`, and a typed
  progress callback.
- Return a typed run result with counts, artifact paths, warnings, and diagnostics.
- Throw typed errors for invalid configuration, authentication/preflight failure,
  or preparation failure; retain completed artifacts whenever possible.

The function prepares a fresh digest and delegates to the extracted analysis and
grouping functions. It must not start the dashboard or evaluate test configuration.

### Prepared-evidence analysis

Retain the useful existing lower-level entry points:

- `withCopilotAnalysisClient`: validates selected models, owns the SDK client,
  invokes a callback, and reliably shuts down.
- `analyzeRun`: analyzes an already-prepared manifest/run directory.
- `groupRun`: groups the completed records.
- `copilotAccessCheck` and `copilotModels`: support the dashboard's separate access
  check and model picker without mutating consumer configuration.
- Artifact constants, evidence types, and required pure validation/render helpers.

This lets the dashboard keep its existing sequence:

```text
authenticate and validate models
  -> confirm/check ownership and replace existing analysis
  -> prepare through the dashboard's shared queue
  -> rename/register the run with the report UUID
  -> analyze and group through the package
  -> adapt progress/results to existing HTTP and SSE contracts
```

Do not make the dashboard use the full-report API if doing so bypasses its queue,
repeats preparation, changes its run directory, or authenticates only after
destructive replacement.

Keep SDK-facing test interfaces narrow and properly typed. Remove the need for
double casts when injecting fake clients. Reuse the reader's exported manifest
types, including nullable outcomes, and runtime-validate JSON at CLI boundaries.

## 6. CLI contract

Proposed commands:

```text
playwright-failure-analyzer analyze
  --report <report-root>
  --output <output-parent>
  --small-model <model-id>
  --big-model <model-id>
  [--workers <1-5>]
  [--concurrency <positive-integer>]
  [--timeout-ms <positive-integer>]
  [--max-attempts <positive-integer>]
  [--format json|text]

playwright-failure-analyzer check-access [--format json|text]
playwright-failure-analyzer models [--format json|text]
```

- Default to JSON output. Emit one final result on stdout; progress and diagnostic
  messages go to stderr.
- `--help` and `--version` must work without credentials or a model request.
- Reject unknown flags, invalid numbers, unsafe paths, conflicting inputs, and
  missing model selections with actionable errors.
- Do not accept tokens as command-line arguments.
- Do not hardcode or silently substitute model IDs.
- `check-access` checks authentication and `models` lists availability; neither
  claims to prove an inference request works. Live model smoke tests are separate.
- A zero-candidate run with verified zero failures must not start Copilot.

Consumers can define:

```json
{
  "scripts": {
    "analyze:failures": "playwright-failure-analyzer analyze"
  }
}
```

### Preparation and cancellation

For the high-level path, reuse the existing trace-reader CLI preparation pattern.
Resolve the reader's declared executable, launch it through `process.execPath`
with an argument array and no shell, and request JSON output. This supplies an
isolated process boundary for a real preparation timeout/cancellation without
inventing a new parser or pretending the existing in-process reader supports
`AbortSignal`.

Keep the dashboard's existing preparation adapter initially. Only the high-level
runner owns and terminates the preparation process it starts.

`--timeout-ms` is an overall deadline for preparation plus AI stages. Stop starting
new work at the deadline, cancel active SDK work using the validated SDK API, and
shut down only owned processes. A `Promise.race` that leaves background work alive
is not sufficient. Cleanup failures must be reported without hiding the original
error.

Existing per-request limits remain in force. Limit the number of attempted model
analyses only when `--max-attempts` is supplied, using deterministic manifest
order. Report every omitted attempt and mark the result partial.

## 7. Authentication and execution safety

Authentication precedence:

1. Explicit library token.
2. `COPILOT_GITHUB_TOKEN`.
3. `GH_TOKEN`.
4. `GITHUB_TOKEN`.
5. Stored CLI/GitHub CLI credentials, allowed for local usage only by default.

For CI, resolve and validate an explicit/environment token and pass it through
the SDK's token option with logged-in-user fallback disabled. Do not trigger an
interactive login or persist credentials.

For local use, preserve the dashboard's optional configured token and normal
stored-login behavior. Keep generic error codes in the package; map dashboard
Preferences instructions and CLI environment-variable guidance in the respective
adapters.

Both attempt and grouping sessions must use an empty SDK tool allowlist and
defensive permission denial where required by the selected SDK. Do not carry
over `approveAll`, expose browser/MCP tools, or enable repository editing.
Explicitly suppress unintended repository instructions, skills, plugins, and MCP
configuration using supported SDK/runtime controls and isolated working context.

Additional rules:

- Never print tokens, raw prompts, response bodies, or complete SDK sessions into
  workflow logs by default.
- Treat report content as untrusted evidence, not executable instructions.
- Validate paths with real-path/symlink containment, not string-prefix checks.
- Keep evidence retrieval confined to the assigned attempt folder and preserve
  existing byte/character/reference limits.
- Do not overwrite prior analysis implicitly or delete unrelated output.
- Keep the original report read-only. Writes belong to a fresh generated run,
  or to an explicitly supplied prepared run that has no conflicting AI artifacts.

### Sensitive evidence is a rollout gate

The current implementation sends error Markdown and selected network evidence to
the model. Metadata cleanup is not general secret/PII redaction.

The extraction must not silently modify exact source blocks or claim that data is
sanitized. Initially use synthetic fixtures and explicitly approved reports only.
Before enabling real regression analysis, approve the allowed evidence classes,
artifact access, retention, and summary content. If automatic redaction is
required, define and implement that additional scope before enabling those inputs.

Authentication and tool denial do not remove this data-handling requirement.

## 8. Artifacts, coverage, and exit status

Keep the reader's run directory and existing artifact filenames:

```text
output/
  run-<unique-id>/
    index.json
    analysis-result.json
    summary.md
    grouped-analysis.md          # when grouping produces a valid result
    <attempt-folder>/
      failure.json
      error.md
      evidence.json
      ai-analysis.md
      ...reader-provided evidence
```

`analysis-result.json` is a new versioned run envelope, separate from evidence
schema 4 and the reader manifest. It should include:

- Completion status and per-stage errors/warnings.
- Reported failed-attempt counts, trace-backed coverage, exclusions, analyzed
  attempts, unavailable attempts, fallback warnings, and budget omissions.
- Grouping status, reconciliation counts, and existing grouping diagnostics.
- Selected models, package/runtime versions, timings, and usage when available.
- Relative artifact paths within the run for portability.

Do not invent zero usage when the SDK does not report usage. Never use an embedded
absolute runner path as authority after artifacts are downloaded elsewhere.

`summary.md` is deterministic and exists for complete, partial, and no-failure
runs, including the single-attempt case. Keep public Actions summaries
count/status-based by default; raw evidence remains in restricted artifacts.

### Coverage rules

Use the reader's report metadata to compare failed attempts with trace-backed
attempts. Reuse its metadata parsing and identity mapping; do not implement a
second HTML report parser.

The reader currently enumerates trace sources, so absent traces can otherwise
look like zero failures. Missing metadata is unknown coverage, not proof of
success. Failed tests without traces, excluded hook failures, and unsupported or
unreadable traces must remain visible. Do not equate eventual test outcome with
each retry's status.

Report-only AI fallback and screenshot inference are outside this release.

### CLI exit codes

| Code      | Meaning                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Complete analysis, or verified no failures                                                                                                   |
| 1         | Invalid input/configuration, authentication/preflight failure, or fatal preparation failure                                                  |
| 2         | Partial analysis: missing/unknown coverage, unavailable attempts, source-only fallback, incomplete grouping, deadline, or workload omissions |
| 130 / 143 | Interrupted by SIGINT / SIGTERM                                                                                                              |

A repaired response that fully satisfies the contract is not automatically a
partial result. Model confidence alone is also not an execution error.

Publish completed artifacts before returning a partial result. If the filesystem
itself prevents saving results, report that explicitly; do not return a
success-shaped summary or silently swallow the write failure.

## 9. Consumer migrations

### Report application

1. Install the user-published release and change analysis imports to the package.
2. Update the grouped-analysis constant imports in both vault modules.
3. Preserve preflight-before-replacement, report UUID paths, shared preparation
   queue, active-analysis locks, and artifact ownership.
4. Preserve the access chip/model-picker distinction and saved model selections.
5. Adapt package diagnostics to existing HTTP/SSE/UI behavior; make new safety
   warnings visible without redesigning the UI.
6. Move algorithm tests to the package; retain dashboard-specific integration,
   artifact lifecycle, and progress tests.
7. Remove the old engine copies once parity is verified. Remove the dashboard's
   direct SDK dependency only after confirming no remaining direct use.
8. Update dashboard architecture, configuration, failure-analysis, and
   troubleshooting documentation.

Do not commit local tarball paths into the consumer's final dependency manifest.
Release a validated package version and lock both consumers to the tested release.

### Regression CI

Create the separate
[Falcons workflow](../prod/sc-tests/.github/workflows/falcons-with-analysis.yml)
with DEV/UAT/PROD and NA/EU dispatch choices and the `falcons` project.
Its `analyzeFailures` checkbox defaults to false. Leave the existing regression
workflow and Playwright configuration unchanged; do not add Pages deployment to
this pilot.

For opted-in runs:

1. Ensure trace retention for every relevant failed attempt. Prefer a verified
   command-line `--trace=retain-on-failure` override rather than relying solely
   on `ENABLE_TRACE`, which some projects override.
2. Expose the actual `run_tests` step outcome and the uploaded report artifact ID
   as test-job outputs.
3. Add a separate analysis job with `needs: tests` and an explicit condition that
   permits a failed prerequisite job, excludes cancellation, and requires an
   opted-in failed test step plus a report artifact.
4. Use the exact artifact ID from this run; do not rediscover the newest report
   or guess its environment/suite-dependent name.
5. Check out the same commit, set up Node, and install locked dependencies.
   Disable persisted checkout credentials. Do not install browsers or start tests.
6. Download the report to a known directory and invoke the package CLI.
7. Give only this job `contents: read` and `copilot-requests: write`; pass the
   built-in token only to the analysis step. Do not inherit test secrets or
   deployment permissions.
8. Upload results even after analysis failure when files exist. Publish a bounded
   count/status summary and artifact link; make skipped/missing-report cases
   explicit.

The user selected hardcoded model IDs `gpt-6-luna` and `gpt-6.1-sol`, a 30-minute
package deadline, a 40-minute analysis job timeout, and no attempt-count cap.
Evidence processing was explicitly approved. Both report and analysis artifacts
have one-day retention. Model IDs are never silently substituted.

The initial workflow policy is failed test runs only. The engine still analyzes
failed retries within those reports. Analysis of an otherwise green flaky run
is a separate future workflow choice, not an implicit change.

The package does not post issues, change workflow conclusions, deploy Pages, or
write directly to GitHub summaries. Those remain consumer responsibilities.
The original regression failure must remain authoritative.

## 10. Delivery sequence and acceptance gates

| Phase                          | Depends on                                                     | Deliverable and exit criterion                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Compatibility and contracts | None                                                           | Confirm SDK/runtime on Windows/Linux; freeze public API, artifacts, warning semantics, Node support, and tool-denial configuration                 |
| 1. Core extraction             | Phase 0                                                        | Buildable package with existing engine and synthetic tests; identical source evidence, issue order, grouping rules, and filenames                  |
| 2. Headless runner and CLI     | Phase 1                                                        | Preparation, auth, progress, cancellation, coverage, deterministic summary, and documented exit codes pass integration tests                       |
| 3. Package handoff             | Phase 2                                                        | Clean tarball installs on supported targets; package contents and public documentation checked; hand off without publishing or modifying consumers |
| 4. Dashboard migration         | Phase 3 and user-confirmed publication                         | Released package works without private source imports; dashboard behavior and lifecycle regression tests pass; duplicate engine removed            |
| 5. Regression CI pilot         | Phase 3, user-confirmed publication, and data/budget approvals | Approved report analyzed through the exact SDK/models in an isolated job; artifacts, partial failures, and original test status verified           |
| 6. Stable rollout              | Phase 5                                                        | Publish stable release, update consumer lockfiles, document operation and rollback, and leave analysis opt-in initially                            |

Use isolated local `npm pack` consumer checks before publication. Publication is
performed by the user, not this extraction task. Any additional prerelease or
stable publishing steps also require an explicit user request.

### Verification matrix

Start with the existing
[attempt tests](../playwright-reports/tests/copilot-analyzer.test.js) and
[grouping tests](../playwright-reports/tests/copilot-grouper.test.js).

| Area            | Required checks                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic parity | Exact source blocks; schema 4; multiple blocks; correction; fallback; grouping coverage; bounded retrieval; structural repair                                               |
| Report cases    | Zero failures; one attempt; multiple attempts; flaky retries; skipped/Before Hooks; timeouts/interruption; no trace; missing metadata                                       |
| Authentication  | Explicit token precedence; CI forbids stored-login fallback; local login remains supported; missing token; unavailable model; no model substitution                         |
| Isolation       | Both sessions tool-free; no unexpected tools or instructions loaded; source/output traversal and symlink escapes rejected                                                   |
| Reliability     | No new work after deadline/cancellation; owned runtime exits; partial output retained; cleanup/write errors visible; no hangs                                               |
| CLI             | Help/version without auth; bad arguments; stdout JSON separated from stderr; all exit codes; paths containing spaces                                                        |
| Packaging       | Declaration resolution; CommonJS and ESM consumers; packed CLI executable; no global CLI; no private files; Windows/Linux native runtime installation                       |
| Dashboard       | Preflight before deletion; queue and locks; unchanged report UUID paths; model preferences; vault imports; progress and partial-warning display                             |
| CI              | Failed test step does not skip analysis; successful test step does not trigger it due only to a later deployment failure; exact artifact handoff; no test secrets in AI job |

Assert the numeric evidence and concurrency limits at their boundaries, not merely
that an output file exists. Add generated report fixtures rather than publishing
real regression artifacts.

Normal unit/integration CI must use fake SDK clients and must not consume Copilot
credits. Live SDK checks are explicit, separately authorized smoke tests using
synthetic prompts and the intended small/big models.

Suggested validation commands once implemented:

```text
npm run build
npm test
npm pack --dry-run
npm pack
```

Run the smallest affected consumer suites first, then the required dashboard
integration/browser coverage. No regression tests need to run merely to analyze
an existing report.

## 11. Publication and remaining rollout decisions

Publishing requirements:

- Confirm package-name ownership and the intended source repository.
- Preserve license attribution and configure scoped public publication.
- Prefer npm trusted publishing/OIDC where available; npm publishing credentials
  are separate from the Copilot token.
- Keep publishing permissions in the release workflow, not the analysis job.
- Review the actual tarball; never bundle `.env` files, traces, logs, session
  state, test-project sources, or local configuration.
- Document supported runtimes, authentication, CLI/API examples, artifact
  schemas, errors, costs, privacy limits, and migration/rollback steps.

Before real-report CI rollout, explicitly settle:

1. The small and big model IDs, verified through the selected SDK.
2. The workload cap, overall deadline, and job timeout.
3. Approved evidence classes and whether redaction must be added first.
4. Artifact retention/access and which information may enter the Actions summary.
5. The publishing identity and release approval process.

Completion means both consumers use the same released engine, no duplicate
analysis implementation remains in the dashboard, CI needs no personal token or
dashboard service, and incomplete analysis cannot be mistaken for a clean run.

## References

- [GitHub Actions Copilot token setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions)
- [Organization-attributed authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/server-to-server-tokens.md)
- [SDK runtime setup](https://github.com/github/copilot-sdk/blob/v1.0.28/docs/setup/bundled-cli.md)
- [Trace compatibility contract](../playwright-traces-reader/docs/COMPATIBILITY.md)
