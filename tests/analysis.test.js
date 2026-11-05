const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { analyzeFailures, FailureAnalysisError } = require("../dist/analysis");
const analyzer = require("../dist/copilot-analyzer");
const { measureCoverage, validateManifest } = require("../dist/reader");
const { fixture, fakeClient } = require("./fixture.cjs");

const options = (f) => ({
  reportPath: f.reportPath,
  outputDir: f.outputDir,
  smallModel: "small",
  bigModel: "big",
  workers: 1,
});
function mockClient(t, client = fakeClient()) {
  return t.mock.method(
    analyzer,
    "withCopilotAnalysisClient",
    async (_models, _token, callback) => callback(client),
  );
}

test("full report pipeline prepares, analyzes and writes portable evidence without changing the report", async (t) => {
  const f = fixture(t, { tests: 2 });
  const initial = fs.readFileSync(path.join(f.reportPath, "index.html"));
  const configs = [];
  mockClient(t, fakeClient({ onCreate: (config) => configs.push(config) }));
  const result = await analyzeFailures(options(f));
  assert.equal(result.status, "complete");
  assert.equal(result.attempts.analyzed, 2);
  assert.equal(result.coverage.failedAttempts, 2);
  assert.equal(result.coverage.traceBackedAttempts, 2);
  assert.equal(result.grouping.problemCount, 1);
  assert.equal(configs.length, 3);
  for (const config of configs) {
    assert.deepEqual(config.availableTools, []);
    assert.equal(config.skipCustomInstructions, true);
    assert.equal(config.enableSkills, false);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(f.reportPath, "index.html")),
    initial,
  );
  const saved = JSON.parse(
    fs.readFileSync(path.join(result.runDir, "analysis-result.json")),
  );
  assert.deepEqual(saved, result);
  assert.equal(saved.artifacts.manifest, "index.json");
  assert.equal(saved.versions.sdk, "1.0.14");
  assert.ok(
    fs.existsSync(path.join(result.runDir, result.artifacts.groupedAnalysis)),
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(result.runDir, "summary.md"), "utf8"),
    /Generated check|Received: 503/,
  );
});

test("single attempt produces a summary without a grouping request", async (t) => {
  const f = fixture(t);
  let sessions = 0;
  mockClient(t, fakeClient({ onCreate: () => sessions++ }));
  const result = await analyzeFailures(options(f));
  assert.equal(result.status, "complete");
  assert.equal(result.grouping.status, "not-needed");
  assert.equal(sessions, 1);
  assert.ok(fs.existsSync(path.join(result.runDir, "summary.md")));
});

test("verified green report requires neither traces nor authentication", async (t) => {
  const f = fixture(t, { statuses: ["passed"], traces: false });
  const auth = t.mock.method(analyzer, "withCopilotAnalysisClient", () =>
    assert.fail("Unexpected authentication"),
  );
  const result = await analyzeFailures(options(f));
  assert.equal(result.status, "no-failures");
  assert.equal(auth.mock.callCount(), 0);
});

test("missing traces and unknown metadata are partial, not clean reports", async (t) => {
  for (const mode of [{ traces: false }, { traces: false, metadata: false }]) {
    const f = fixture(t, mode);
    const result = await analyzeFailures(options(f));
    assert.equal(result.status, "partial");
    assert.ok(result.warnings.length);
  }
});

test("flaky retries retain failed attempts independently of final outcome", async (t) => {
  const f = fixture(t, { statuses: ["failed", "passed"], outcome: "flaky" });
  mockClient(t);
  const result = await analyzeFailures(options(f));
  assert.equal(result.status, "complete");
  assert.equal(result.coverage.failedAttempts, 1);
  assert.equal(result.attempts.analyzed, 1);
});

test("workload cap retains explicit omissions and source-only fallback is partial", async (t) => {
  const f = fixture(t, { tests: 2 });
  mockClient(t, fakeClient({ responses: ["not JSON"] }));
  const result = await analyzeFailures({ ...options(f), maxAttempts: 1 });
  assert.equal(result.status, "partial");
  assert.equal(result.attempts.omitted, 1);
  assert.equal(result.attempts.fallbacks, 1);
});

test("authentication failure retains prepared evidence and a failure result", async (t) => {
  const f = fixture(t);
  t.mock.method(analyzer, "withCopilotAnalysisClient", async () => {
    throw new Error("Generated authentication denial");
  });
  await assert.rejects(analyzeFailures(options(f)), (error) => {
    assert.ok(error instanceof FailureAnalysisError);
    assert.equal(error.result.status, "failed");
    assert.equal(error.result.attempts.omitted, 1);
    assert.ok(fs.existsSync(path.join(error.result.runDir, "index.json")));
    assert.ok(fs.existsSync(path.join(error.result.runDir, "summary.md")));
    return true;
  });
});

test("fatal preparation preserves a diagnosable result", async (t) => {
  const f = fixture(t);
  const zip = fs
    .readdirSync(path.join(f.reportPath, "data"))
    .find((name) => name.endsWith(".zip"));
  fs.writeFileSync(path.join(f.reportPath, "data", zip), "invalid archive");
  await assert.rejects(analyzeFailures(options(f)), (error) => {
    assert.equal(error.result.status, "failed");
    assert.equal(error.result.errors[0].stage, "preparation");
    assert.ok(
      fs.existsSync(path.join(error.result.runDir, "analysis-result.json")),
    );
    return true;
  });
});

test("cancellation stops scheduling attempts and persists partial results", async (t) => {
  const f = fixture(t, { tests: 3 });
  const controller = new AbortController();
  let sessions = 0;
  mockClient(
    t,
    fakeClient({
      onCreate: () => {
        sessions++;
        controller.abort(new Error("Generated cancel"));
      },
    }),
  );
  const result = await analyzeFailures({
    ...options(f),
    signal: controller.signal,
    concurrency: 1,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(sessions, 1);
  assert.equal(result.attempts.omitted, 2);
});

test("invalid options, overlaps, duplicate manifests and traversal reject before model use", async (t) => {
  const f = fixture(t);
  for (const extra of [
    { workers: 6 },
    { concurrency: 0 },
    { maxAttempts: -1 },
    { timeoutMs: 2 ** 32 },
    { smallModel: "" },
  ])
    await assert.rejects(
      analyzeFailures({ ...options(f), ...extra }),
      /required|integer/,
    );
  await assert.rejects(
    analyzeFailures({
      ...options(f),
      outputDir: path.join(f.reportPath, "output"),
    }),
    /overlap/,
  );
  assert.throws(
    () => validateManifest({ count: 2, failures: [] }, f.root),
    /count/,
  );
  assert.throws(
    () =>
      validateManifest(
        {
          count: 1,
          failures: [
            {
              folder: "../escape",
              title: "",
              testTitle: null,
              retryIndex: 0,
              status: "failed",
              outcome: null,
            },
          ],
        },
        f.root,
      ),
    /outside/,
  );
});

test("coverage does not silently accept unknown statuses", (t) => {
  const f = fixture(t, { statuses: [undefined], traces: false });
  const coverage = measureCoverage(f.report, {
    count: 0,
    runDir: f.root,
    failures: [],
  });
  assert.equal(coverage.known, false);
  assert.ok(coverage.warnings.length);
});

test("overall deadline during preparation persists a partial status", async (t) => {
  const f = fixture(t);
  const reader = require("../dist/reader");
  t.mock.method(
    reader,
    "prepareReport",
    (_report, _output, _workers, signal) =>
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  );
  const result = await analyzeFailures({ ...options(f), timeoutMs: 100 });
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].code, "DEADLINE_EXCEEDED");
  assert.ok(fs.existsSync(path.join(result.runDir, "summary.md")));
});

test("timed-out and interrupted attempts remain trace-backed failures", async (t) => {
  mockClient(t);
  for (const status of ["timedOut", "interrupted"]) {
    const f = fixture(t, { statuses: [status] });
    const result = await analyzeFailures(options(f));
    assert.equal(result.status, "complete");
    assert.equal(result.coverage.failedAttempts, 1);
    assert.equal(result.attempts.analyzed, 1);
  }
});
