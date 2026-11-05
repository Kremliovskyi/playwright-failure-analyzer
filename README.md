# Playwright Failure Analyzer

Explain Playwright test failures with GitHub Copilot, using the same evidence
engine from a local application or CI. Includes a TypeScript library and CLI.

```text
HTML report + trace attachments
  -> playwright-traces-reader
  -> per-attempt evidence and small-model explanations
  -> big-model grouping
  -> JSON evidence and Markdown reports
```

This package does not run tests, start a dashboard, edit test code, publish
artifacts, or create defects. It is not affiliated with Microsoft or the
Playwright team.

## Requirements

- Node.js `^20.19.0 || >=22.12.0 <27`.
- A complete Playwright Test HTML report with traces for the attempts to analyze.
- GitHub Copilot access and available small/big model IDs.
- Normal npm installation, including optional dependencies for the native SDK
  runtime. A global Copilot CLI installation is not needed.

The trace reader owns trace-version compatibility. Missing traces or incomplete
metadata are reported as incomplete coverage, not as a clean test run. Failed
retry attempts remain independent even when the test eventually passes.

## Installation

After the package has been published:

```sh
npm install --save-dev @andrii_kremlovskyi/playwright-failure-analyzer
```

Applications importing the library at runtime should use a production dependency
instead of `--save-dev`.

## CLI

```sh
npx playwright-failure-analyzer analyze \
  --report ./playwright-report \
  --output ./failure-analysis \
  --small-model "<available-model-id>" \
  --big-model "<available-model-id>" \
  --timeout-ms 900000
```

For PowerShell, put the command on one line or use PowerShell continuation syntax.
Quote paths containing spaces.

| Option                          | Behavior                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `--report`                      | HTML report root, containing `index.html`                                |
| `--output`                      | Parent directory for a fresh `run-*` output; must not overlap the report |
| `--small-model` / `--big-model` | Required exact model IDs; never silently substituted                     |
| `--workers`                     | Reader preparation workers, 1-5; default 4                               |
| `--concurrency`                 | Concurrent attempt analyses; default 3                                   |
| `--timeout-ms`                  | Optional overall deadline, including preparation and AI stages           |
| `--max-attempts`                | Optional cap in manifest order; omissions make the result partial        |
| `--format`                      | `json` (default) or `text`                                               |

No overall deadline or attempt cap is imposed unless configured. Always set a
deadline shorter than the workflow job timeout in CI. Each attempt request has a
three-minute timeout; grouping/evidence/repair requests each have a ten-minute
timeout. Correction and repair requests can incur additional usage.

Other commands:

```sh
npx playwright-failure-analyzer check-access
npx playwright-failure-analyzer models
npx playwright-failure-analyzer --help
npx playwright-failure-analyzer --version
```

Access/model discovery is not proof that a billable inference request succeeds.
Help/version and verified no-failure runs do not start Copilot.

JSON mode emits one final object to stdout. Count/phase progress is written to
stderr. Tokens are not accepted on the command line. Technical errors and
diagnostics are explicit; inspect the generated result even if the command exits
nonzero.

| Exit code | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| 0         | Complete analysis or verified no failures                                     |
| 1         | Invalid arguments, authentication failure, fatal preparation/output error     |
| 2         | Partial analysis, missing/unknown coverage, source-only fallback, or deadline |
| 130 / 143 | SIGINT / SIGTERM cancellation                                                 |

The CLI's exit code describes analysis, not the original Playwright test result.
Do not use it to turn a failing regression run green.

## Authentication

Resolution order:

1. Explicit library token.
2. `COPILOT_GITHUB_TOKEN`.
3. `GH_TOKEN`.
4. `GITHUB_TOKEN`.
5. Stored local Copilot/GitHub CLI credentials.

CI disables stored-login fallback by default. Local usage supports existing CLI
login; the package never starts an interactive login or stores a supplied token.
Explicit `allowStoredLogin: false` is available for headless library consumers.

The SDK reads local CLI credentials independently of VS Code's sign-in.
On Windows, the isolated runtime preserves both `PATH` and `PATHEXT` so it can
discover `gh.exe` and reuse GitHub CLI authentication.

In GitHub Actions, pass `${{ github.token }}` through `COPILOT_GITHUB_TOKEN` and
grant the job `copilot-requests: write`. Organization-owned repositories require
the **Allow use of Copilot CLI billed to the organization** policy. This does not
require a personal access token. Organization policies, model access, and usage
budgets still apply.

[GitHub's authentication instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions)

## Library API

```ts
import { analyzeFailures } from "@andrii_kremlovskyi/playwright-failure-analyzer";

const result = await analyzeFailures({
  reportPath: "/reports/playwright-report",
  outputDir: "/reports/failure-analysis",
  smallModel: "your-small-model-id",
  bigModel: "your-big-model-id",
  authentication: {
    token: process.env.COPILOT_GITHUB_TOKEN,
    allowStoredLogin: false,
  },
  workers: 4,
  concurrency: 3,
  timeoutMs: 900_000,
  onProgress(event) {
    console.log(event.phase);
  },
});

console.log(result.status, result.runDir);
```

CommonJS is also supported:

```js
const {
  analyzeFailures,
} = require("@andrii_kremlovskyi/playwright-failure-analyzer");
```

`AnalysisResult` contains coverage, attempt counts, warnings/errors, grouping
diagnostics, versions, duration, and artifact paths. Complete, partial,
no-failure, and cancelled results are returned. Fatal failures after a run is
allocated throw `FailureAnalysisError`, whose `result` points to retained output.
Earlier input/preparation setup errors can occur before any run is allocated.
Output failures are never disguised as successful analysis.

An `AbortSignal` cancels the high-level runner, stops new work, and shuts down
its owned reader process tree and SDK runtime. Already completed evidence is
retained. Cancellation during preparation can leave incomplete raw evidence
inside that run; it is not a completed manifest.

### Reusing prepared evidence

Applications that own report preparation and artifact lifecycle can use:

```ts
import {
  withCopilotAnalysisClient,
  analyzeRun,
  groupRun,
  isAnalyzableEntry,
  validateManifest,
} from "@andrii_kremlovskyi/playwright-failure-analyzer";

await withCopilotAnalysisClient(
  { smallModel, bigModel },
  optionalToken,
  async (client) => {
    // The application prepares/registers a fresh run here, after preflight.
    const manifest = validateManifest(preparedJson, actualRunDirectory);
    const analysis = await analyzeRun(
      client,
      actualRunDirectory,
      manifest,
      smallModel,
      onAttemptProgress,
    );
    if (manifest.failures.filter(isAnalyzableEntry).length > 1) {
      await groupRun(
        client,
        actualRunDirectory,
        manifest,
        analysis.records,
        smallModel,
        bigModel,
      );
    }
  },
  { signal },
);
```

Prepared-run APIs write only their own evidence/grouping files and refuse
conflicting output. They do not replace/delete prior runs or manage report IDs.
The client wrapper owns runtime shutdown; when supplying another `AnalysisClient`,
the caller must arrange cancellation of active requests and client cleanup.

`copilotAccessCheck` and `copilotModels` support separate access checks and model
pickers. Pure evidence renderers, schema-v4 types, and artifact constants are also
exported. Importing the package does not start the runtime.

## Output

```text
failure-analysis/
  run-<unique-id>/
    index.json
    analysis-result.json
    summary.md
    grouped-analysis.md
    <attempt>/
      failure.json
      error.md
      evidence.json
      ai-analysis.md
      ...raw reader evidence
```

- Reader manifests keep schema version 2; canonical AI evidence keeps schema
  version 4. The new run envelope has schema version 1.
- `error.md` is ground truth. Each fenced Error details block remains an exact,
  ordered source issue in `evidence.json`.
- Invalid model output gets one correction; a second invalid response retains
  low-confidence source-only issues with a warning and partial run status.
- Grouping uses one bounded evidence round and one reference repair, preserving
  valid issues and explicitly recording provisional/unclassified results.
- `summary.md` is deterministic, including zero/single-attempt and failed runs.
  It includes counts/status only, not test names, source blocks, or network bodies.
- Grouped Markdown exists only when grouping produces a valid artifact.
- `attemptUsage` contains token counts only when the SDK reports them. Grouping
  usage is recorded in its diagnostics; neither is a currency/billing estimate.
- Artifact pointers are relative to the run directory. `runDir` and original
  reader trace paths describe the machine that produced them; do not trust them
  as filesystem authority after downloading an artifact.

## GitHub Actions consumption

After publication, add the package to your project's manifest/lockfile and an
npm script:

```json
{
  "scripts": {
    "analyze:failures": "playwright-failure-analyzer analyze"
  }
}
```

The analysis job installs dependencies, downloads the exact report artifact from
the test job, and then runs:

```yaml
- name: Analyze failures
  env:
    COPILOT_GITHUB_TOKEN: ${{ github.token }}
    SMALL_MODEL: ${{ vars.COPILOT_SMALL_MODEL }}
    BIG_MODEL: ${{ vars.COPILOT_BIG_MODEL }}
  run: |
    npm run analyze:failures -- \
      --report playwright-report \
      --output failure-analysis \
      --small-model "$SMALL_MODEL" \
      --big-model "$BIG_MODEL" \
      --timeout-ms 900000
```

This is a step fragment, not a complete workflow. Give the analysis job
`contents: read` and `copilot-requests: write`, an explicit failed-prerequisite
condition, and time for artifact upload after analysis fails. Keep application
secrets and deployment permissions out of the analysis job. Retain the original
test failure. Authentication/model access must be smoke-tested with the installed
SDK in the target organization; the unit suite does not make billable requests.

## Data handling and limitations

**Evidence is not automatically redacted.** Error Markdown, test source,
page content, and selected network data are sent to GitHub Copilot. Obtain
approval for the report content before using real regression reports. Restrict
artifact access/retention. Do not paste raw evidence into public workflow
summaries. The model can only infer causes supported by supplied evidence.

Sessions expose no tools, skip repository instructions/skills/hooks, disable
configuration discovery, and run in an isolated working directory. This limits
agent actions; it does not make sensitive evidence safe to disclose. BYOK/provider
environment overrides are not forwarded to the owned runtime.

Session state stays in an owned temporary configuration directory, which is
removed after the sessions disconnect and the runtime stops. Local login
configuration is kept separate and is not deleted during analysis cleanup.

Screenshots can be extracted for human inspection, but are not automatically
submitted for visual analysis. Global setup/infrastructure errors and failures
without trace evidence are not diagnosed by a report-only model fallback.

## Development and publishing

```sh
npm ci
npm test
npm pack --dry-run
npm pack
```

Tests use generated reports and fake model clients. Real-runtime checks cover
startup and concurrent session creation/disconnection with both explicit-token
and separate local-login storage. They use synthetic credentials and an inert
loopback provider, verify temporary-state cleanup, and make no model inference
requests. No real reports or credentials belong in fixtures.

Release checks cover Windows (Node 22) and Linux (Node 24), including independent
tarball installation, CommonJS/ESM imports, declarations, the executable, and
owned process-tree shutdown. The declared engine range follows dependency
requirements; every Node version and processor architecture has not been tested.
Live small/big-model inference through the packaged SDK still requires a separate
target-environment smoke test before production use.

The SDK is deliberately pinned to 1.0.14: its supported Zod range can resolve a
patched release, whereas SDK 1.0.28 pins vulnerable Zod 4.3.6. The lockfile records
the tested resolution. Recheck audit and runtime compatibility when upgrading;
do not use a library-local override as a supposed fix for downstream consumers.

Only `dist/`, this README, the MIT license, and npm's package manifest are
published. The planning document, tests, local caches, and tarballs are excluded.

Publication is manual:

```sh
npm publish --access public
```

Publishing permissions/credentials are separate from Copilot authentication.
This command is documentation for the package owner, not an automated release
step. Consumer migration should begin only after publication is confirmed.

## License

MIT. The extracted engine retains the copyright notice of the Playwright Report
Viewer Authors; see [LICENSE](LICENSE).
