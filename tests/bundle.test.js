const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  analyzeFailures,
  createAnalysisRunDirectory,
  FailureAnalysisError,
  renderSummary,
  validateAnalysisContext,
  validateManifest,
} = require("../dist");
const analyzer = require("../dist/copilot-analyzer");
const reader = require("../dist/reader");
const { runCli } = require("../dist/cli");
const { fixture, fakeClient } = require("./fixture.cjs");

const options = (f) => ({
  reportPath: f.reportPath,
  outputDir: f.outputDir,
  smallModel: "small",
  bigModel: "big",
  workers: 1,
});
const read = (run, file) =>
  JSON.parse(fs.readFileSync(path.join(run, file), "utf8"));

test("one UTC timestamp and exclusive suffix identify simultaneous runs", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-06T15:04:05.123Z"),
  });
  const identities = await Promise.all(
    Array.from({ length: 20 }, async () =>
      createAnalysisRunDirectory(f.outputDir),
    ),
  );
  assert.equal(new Set(identities.map((run) => run.runId)).size, 20);
  for (const run of identities) {
    assert.match(run.runId, /^run-2026-11-06T15-04-05-123Z-[A-Za-z0-9]{6}$/);
    assert.equal(run.createdAt, "2026-11-06T15:04:05.123Z");
    assert.equal(run.runId, path.basename(run.runDir));
    assert.equal(path.dirname(run.runDir), f.outputDir);
    assert.deepEqual(fs.readdirSync(run.runDir), []);
  }
});

test("the same engine persists equivalent CLI and dashboard bundles", async (t) => {
  const f = fixture(t, { tests: 2 });
  const auth = t.mock.method(
    analyzer,
    "withCopilotAnalysisClient",
    async (_models, _token, action) => action(fakeClient()),
  );
  const contextFile = path.join(f.root, "ci context.json");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({
      source: { kind: "github-actions", runId: "123", runAttempt: 1 },
      environment: "DEV",
      region: "NA",
    }),
  );
  let stdout = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const write = t.mock.method(process.stdout, "write", (chunk, ...args) => {
    if (typeof chunk !== "string") return originalWrite(chunk, ...args);
    stdout += chunk;
    return true;
  });
  const stderr = t.mock.method(process.stderr, "write", () => true);
  try {
    assert.equal(
      await runCli([
        "analyze",
        "--report",
        f.reportPath,
        "--output",
        f.outputDir,
        "--small-model",
        "small",
        "--big-model",
        "big",
        "--workers",
        "1",
        "--context",
        contextFile,
      ]),
      0,
    );
  } finally {
    write.mock.restore();
    stderr.mock.restore();
  }
  const cli = JSON.parse(stdout);
  const events = [];
  const dashboard = await analyzeFailures({
    ...options(f),
    outputDir: path.join(f.root, "tmp", "analysis-fixture-uuid"),
    client: fakeClient({ onCreate: () => events.push("analysis") }),
    context: {
      source: { kind: "playwright-reports", reportUuid: "fixture-uuid" },
      environment: "DEV",
      region: "NA",
    },
    async schedulePreparation(prepare) {
      events.push("queued");
      const manifest = await prepare();
      events.push("prepared");
      return manifest;
    },
    onPrepared(run) {
      events.push("registered");
      assert.equal(run.runId, path.basename(run.runDir));
      assert.equal(run.manifest.count, 2);
      assert.ok(fs.existsSync(path.join(run.runDir, "index.json")));
      assert.equal(
        fs.existsSync(path.join(run.runDir, "analysis-result.json")),
        false,
      );
      // The registration hook receives a snapshot, not mutable engine state.
      run.manifest.failures.length = 0;
    },
  });
  assert.equal(auth.mock.callCount(), 1);
  assert.deepEqual(events.slice(0, 3), ["queued", "prepared", "registered"]);
  assert.equal(
    events.slice(3).every((event) => event === "analysis"),
    true,
  );
  for (const result of [cli, dashboard]) {
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.status, "complete");
    assert.equal(result.attempts.analyzed, 2);
    assert.equal(result.grouping.status, "complete");
    assert.equal(result.environment, "DEV");
    assert.equal(result.region, "NA");
    assert.equal(
      result.runId.slice(4, -7),
      result.createdAt.replace(/[:.]/g, "-"),
    );
    assert.deepEqual(read(result.runDir, "analysis-result.json"), result);
    assert.deepEqual(
      fs
        .readdirSync(result.runDir)
        .filter((file) => fs.statSync(path.join(result.runDir, file)).isFile())
        .sort(),
      [
        "analysis-result.json",
        "grouped-analysis.md",
        "index.json",
        "summary.md",
      ],
    );
  }
  const cliManifest = read(cli.runDir, "index.json");
  const dashboardManifest = read(dashboard.runDir, "index.json");
  assert.equal(cliManifest.schemaVersion, 2);
  assert.deepEqual(dashboardManifest.failures, cliManifest.failures);
  assert.deepEqual(dashboard.attempts, cli.attempts);
  assert.deepEqual(dashboard.coverage, cli.coverage);
  for (const entry of cliManifest.failures) {
    const record = read(cli.runDir, path.join(entry.folder, "evidence.json"));
    assert.equal(record.schemaVersion, 4);
    assert.deepEqual(
      read(dashboard.runDir, path.join(entry.folder, "evidence.json")),
      record,
    );
  }
});

test("copied bundles use their selected local root, including legacy envelopes", async (t) => {
  const f = fixture(t);
  const result = await analyzeFailures({ ...options(f), client: fakeClient() });
  const destination = path.join(
    f.root,
    "Downloads with spaces",
    "arbitrary wrapper",
    result.runId,
  );
  fs.cpSync(result.runDir, destination, { recursive: true });
  const manifest = read(destination, "index.json");
  manifest.runDir = "/home/runner/work/source/failure-analysis/run-old";
  manifest.outputDir = "/home/runner/work/source/failure-analysis";
  fs.writeFileSync(
    path.join(destination, "index.json"),
    JSON.stringify(manifest),
  );
  fs.rmSync(result.runDir, { recursive: true });
  fs.rmSync(f.reportPath, { recursive: true });
  const rebased = validateManifest(manifest, destination);
  assert.equal(rebased.runDir, destination);
  assert.equal(
    read(destination, path.join(rebased.failures[0].folder, "evidence.json"))
      .schemaVersion,
    4,
  );
  const { runId, createdAt, source, ...legacy } = result;
  legacy.schemaVersion = 1;
  assert.equal(renderSummary(legacy), renderSummary(result));
  assert.match(renderSummary(legacy), /Status: \*\*complete\*\*/);
});

test("zero and single attempts retain conditional grouping and default provenance", async (t) => {
  for (const green of [true, false]) {
    const f = fixture(t, green ? { statuses: ["passed"], traces: false } : {});
    let sessions = 0;
    const result = await analyzeFailures({
      ...options(f),
      client: fakeClient({ onCreate: () => sessions++ }),
    });
    assert.deepEqual(result.source, { kind: "cli" });
    assert.equal(result.status, green ? "no-failures" : "complete");
    assert.equal(result.grouping.status, "not-needed");
    assert.equal(sessions, green ? 0 : 1);
    assert.equal(
      fs.existsSync(path.join(result.runDir, "grouped-analysis.md")),
      false,
    );
    assert.ok(fs.existsSync(path.join(result.runDir, "summary.md")));
  }
});

test("registration failures and cancelled preparation persist honest terminal results", async (t) => {
  const f = fixture(t, { statuses: ["passed"], traces: false });
  await assert.rejects(
    analyzeFailures({
      ...options(f),
      onPrepared() {
        throw new Error("Generated registration failure");
      },
    }),
    (error) => {
      assert.ok(error instanceof FailureAnalysisError);
      assert.equal(error.result.status, "failed");
      assert.equal(error.result.errors[0].stage, "registration");
      assert.deepEqual(
        read(error.result.runDir, "analysis-result.json"),
        error.result,
      );
      return true;
    },
  );
  const controller = new AbortController();
  const result = await analyzeFailures({
    ...options(f),
    signal: controller.signal,
    async schedulePreparation(prepare) {
      controller.abort(new Error("Generated queued cancellation"));
      return prepare();
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(fs.existsSync(path.join(result.runDir, "index.json")), false);
  assert.deepEqual(read(result.runDir, "analysis-result.json"), result);
});

test("queue failures settle active preparation before persisting failure", async (t) => {
  const f = fixture(t);
  let stopped = false;
  t.mock.method(
    reader,
    "prepareReport",
    (_report, _output, _workers, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(
    analyzeFailures({
      ...options(f),
      async schedulePreparation(prepare) {
        void prepare();
        throw new Error("Generated queue failure");
      },
    }),
    (error) => {
      assert.ok(stopped);
      assert.equal(error.result.status, "failed");
      assert.equal(error.result.errors[0].stage, "preparation");
      return true;
    },
  );
});

test("a scheduler cannot skip preparation or run it twice", async (t) => {
  const f = fixture(t, { statuses: ["passed"], traces: false });
  for (const schedulePreparation of [
    async () => undefined,
    async (prepare) => {
      await prepare();
      await prepare();
    },
  ]) {
    await assert.rejects(
      analyzeFailures({ ...options(f), schedulePreparation }),
      (error) => {
        assert.equal(error.result.status, "failed");
        assert.equal(error.result.errors[0].code, "PREPARATION_FAILED");
        return true;
      },
    );
  }
});

test(
  "a deadline expires while queued and prevents late preparation",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t, { statuses: ["passed"], traces: false });
    let latePrepare;
    let release;
    const result = await analyzeFailures({
      ...options(f),
      timeoutMs: 50,
      schedulePreparation(prepare) {
        latePrepare = prepare;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    assert.equal(result.status, "partial");
    assert.equal(result.errors[0].code, "DEADLINE_EXCEEDED");
    const saved = fs.readFileSync(
      path.join(result.runDir, "analysis-result.json"),
      "utf8",
    );
    await assert.rejects(
      latePrepare(),
      (error) => error.code === "DEADLINE_EXCEEDED",
    );
    release();
    assert.equal(fs.existsSync(path.join(result.runDir, "index.json")), false);
    assert.equal(
      fs.readFileSync(path.join(result.runDir, "analysis-result.json"), "utf8"),
      saved,
    );
  },
);

test("context is bounded, explicit, copied and validated before allocation", async (t) => {
  const f = fixture(t);
  const context = {
    source: { kind: "github-actions", runId: "123", runAttempt: 2 },
    environment: "DEV",
    region: "NA",
  };
  const normalized = validateAnalysisContext(context);
  context.source.runId = "modified";
  assert.equal(normalized.source.runId, "123");
  assert.deepEqual(validateAnalysisContext({}), { source: { kind: "cli" } });
  for (const invalid of [
    null,
    [],
    { token: "not metadata" },
    { environment: "" },
    { region: "NA\ninjected" },
    { environment: "x".repeat(1025) },
    { source: null },
    { source: { kind: "other" } },
    { source: { kind: "cli", repository: "owner/repo" } },
    { source: { kind: "github-actions", reportUuid: "other" } },
    { source: { kind: "github-actions", runAttempt: 0 } },
    { source: { kind: "github-actions", runAttempt: "2" } },
    { source: { kind: "playwright-reports" } },
  ]) {
    await assert.rejects(
      analyzeFailures({ ...options(f), context: invalid }),
      (error) => error.code === "INVALID_OPTIONS",
    );
  }
  await assert.rejects(
    analyzeFailures({
      ...options(f),
      client: fakeClient(),
      authentication: {},
    }),
    /either client or authentication/,
  );
  assert.equal(fs.existsSync(f.outputDir), false);
});
