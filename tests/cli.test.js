const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { version } = require("../package.json");
const { runCli } = require("../dist/cli");
const analyzer = require("../dist/copilot-analyzer");
const {
  fixture,
  fakeClient,
  attemptResponse,
  groupingResponse,
} = require("./fixture.cjs");

const cli = path.resolve(__dirname, "../dist/cli.js");
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      CI: "true",
      COPILOT_GITHUB_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  });
}

test("CLI help/version work without credentials", () => {
  const help = run(["--help"]).stdout;
  assert.match(help, /Usage:/);
  assert.match(help, /complete \(possibly with warnings\)/);
  assert.match(help, /Optional grouping evidence failure alone is a warning/);
  assert.equal(run(["--version"]).stdout.trim(), version);
});

test("CLI exits zero for evidence-only warnings but preserves incomplete coverage exits", async (t) => {
  const evidenceRequests = [
    {
      issueIds: ["I1", "I2"],
      sections: ["error-block"],
      reason: "Compare generated evidence",
    },
  ];
  const scenarios = [
    {
      name: "failed evidence call",
      evidenceRequests,
      followup: new Error("Generated optional evidence failure"),
      errorCode: "followup-failed",
    },
    {
      name: "empty evidence error message",
      evidenceRequests,
      followup: new Error(""),
      errorCode: "followup-failed",
    },
    {
      name: "malformed evidence request",
      evidenceRequests: [{ issueIds: ["I1", "I2"], sections: ["screenshot"] }],
      errorCode: "invalid-request",
    },
  ].flatMap((scenario) =>
    [false, true].map((missingCoverage) => ({ ...scenario, missingCoverage })),
  );
  for (const scenario of scenarios) {
    const { missingCoverage } = scenario;
    await t.test(
      `${scenario.name}: ${missingCoverage ? "incomplete coverage" : "warning only"}`,
      async (t) => {
        const f = fixture(t, { tests: 2 });
        if (missingCoverage) {
          f.report.files[0].tests[0].results.push({
            status: "failed",
            retry: 1,
            attachments: [],
          });
          f.writeReport();
        }
        const client = fakeClient({
          responses: [
            attemptResponse,
            attemptResponse,
            {
              ...groupingResponse,
              evidenceRequests: scenario.evidenceRequests,
            },
            scenario.followup,
          ],
        });
        t.mock.method(
          analyzer,
          "withCopilotAnalysisClient",
          async (_models, _token, callback) => callback(client),
        );
        let stdout = "";
        const writeStdout = process.stdout.write.bind(process.stdout);
        t.mock.method(process.stdout, "write", (chunk, ...args) => {
          if (typeof chunk !== "string") return writeStdout(chunk, ...args);
          stdout += chunk;
          return true;
        });
        t.mock.method(process.stderr, "write", () => true);
        const code = await runCli([
          "analyze",
          "--report",
          f.reportPath,
          "--output",
          f.outputDir,
          "--small-model",
          "small",
          "--big-model",
          "big",
        ]);
        assert.equal(code, missingCoverage ? 2 : 0);
        const result = JSON.parse(stdout);
        assert.equal(result.status, missingCoverage ? "partial" : "complete");
        assert.equal(result.grouping.status, "partial");
        assert.equal(
          result.grouping.diagnostics.evidenceErrorCode,
          scenario.errorCode,
        );
        assert.match(
          fs.readFileSync(path.join(result.runDir, "summary.md"), "utf8"),
          /Optional grouping evidence refinement failed/,
        );
      },
    );
  }
});

test("CLI rejects invalid arguments as machine-readable errors", () => {
  for (const args of [
    [],
    ["missing"],
    ["analyze", "--token", "secret"],
    ["analyze", "--workers", "0"],
    ["analyze", "--max-attempts", "1e3"],
    ["models", "--report", "ignored"],
    ["analyze", "--small-model", "first", "--small-model", "second"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, "failed");
  }
});

test("CLI uses distinct clean, partial and missing-auth exit codes", (t) => {
  for (const [statuses, expected] of [
    [["passed"], 0],
    [["failed"], 2],
  ]) {
    const f = fixture(t, { statuses, traces: false });
    const result = run([
      "analyze",
      "--report",
      f.reportPath,
      "--output",
      f.outputDir,
      "--small-model",
      "small",
      "--big-model",
      "big",
    ]);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.ok(JSON.parse(result.stdout).runDir);
    assert.match(result.stderr, /preparation/);
  }
  const result = run(["check-access"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).authenticated, false);
  assert.doesNotMatch(result.stdout, /github_pat_|ghs_/);
});

test("CLI persists only explicitly supplied, validated analysis context", (t) => {
  const f = fixture(t, { statuses: ["passed"], traces: false });
  const contextPath = path.join(f.root, "analysis context.json");
  const context = {
    source: {
      kind: "github-actions",
      repository: "example/tests",
      runId: "123",
      runAttempt: 2,
      commit: "abc123",
      reportArtifactId: "456",
    },
    environment: "DEV",
    region: "NA",
  };
  fs.writeFileSync(contextPath, JSON.stringify(context));
  const args = [
    "analyze",
    "--report",
    f.reportPath,
    "--output",
    f.outputDir,
    "--small-model",
    "small",
    "--big-model",
    "big",
    "--context",
    contextPath,
  ];
  const invocation = run(args);
  assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.runId, path.basename(result.runDir));
  assert.deepEqual(result.source, context.source);
  assert.equal(result.environment, "DEV");
  assert.equal(result.region, "NA");
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(result.runDir, "analysis-result.json"), "utf8"),
    ),
    result,
  );
  const previousRuns = fs.readdirSync(f.outputDir);
  for (const content of [
    "{",
    " ".repeat(16 * 1024 + 1),
    "null",
    JSON.stringify({ token: "generated-context-secret" }),
    JSON.stringify({ source: { kind: "unknown" } }),
  ]) {
    fs.writeFileSync(contextPath, content);
    const failure = run(args);
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stdout).code, "INVALID_OPTIONS");
    assert.doesNotMatch(failure.stdout, /generated-context-secret/);
    assert.deepEqual(fs.readdirSync(f.outputDir), previousRuns);
  }
});
