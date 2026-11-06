const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  analyzeFailures,
  FailureAnalysisError,
  renderSummary,
} = require("../dist/analysis");
const analyzer = require("../dist/copilot-analyzer");
const { measureCoverage, validateManifest } = require("../dist/reader");
const {
  fixture,
  fakeClient,
  attemptResponse,
  groupingResponse,
} = require("./fixture.cjs");

const provisionalGrouping = {
  ...groupingResponse,
  evidenceRequests: [
    {
      issueIds: ["I1", "I2"],
      sections: ["error-block"],
      reason: "Compare generated evidence.",
    },
  ],
};

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

test("optional evidence failures preserve complete analysis with a safe visible warning", async (t) => {
  const rawError = `private-token\n[private link](https://example.invalid)\n<script>private body</script>\n${"X".repeat(20000)}`;
  for (const { name, grouping, followup, code, requests } of [
    {
      name: "per-lookup issue limit",
      grouping: {
        ...provisionalGrouping,
        evidenceRequests: [
          {
            ...provisionalGrouping.evidenceRequests[0],
            issueIds: Array.from({ length: 11 }, (_, i) => `I${i + 1}`),
          },
        ],
      },
      code: "issue-limit",
      requests: 1,
    },
    {
      name: "unknown requested issue",
      grouping: {
        ...provisionalGrouping,
        evidenceRequests: [
          {
            ...provisionalGrouping.evidenceRequests[0],
            issueIds: ["I99"],
          },
        ],
      },
      code: "invalid-request",
      requests: 1,
    },
    ...[
      {
        name: "non-array evidence requests",
        evidenceRequests: provisionalGrouping.evidenceRequests[0],
      },
      {
        name: "null evidence request",
        evidenceRequests: [null],
      },
      {
        name: "unsupported evidence section",
        evidenceRequests: [
          {
            ...provisionalGrouping.evidenceRequests[0],
            sections: ["screenshot"],
          },
        ],
      },
      {
        name: "missing evidence reason",
        evidenceRequests: [
          { issueIds: ["I1", "I2"], sections: ["error-block"] },
        ],
      },
      {
        name: "empty evidence issue list",
        evidenceRequests: [
          { ...provisionalGrouping.evidenceRequests[0], issueIds: [] },
        ],
      },
      {
        name: "mixed valid and malformed requests",
        evidenceRequests: [...provisionalGrouping.evidenceRequests, null],
      },
    ].map(({ name, evidenceRequests }) => ({
      name,
      grouping: { ...groupingResponse, evidenceRequests },
      code: "invalid-request",
      requests: 1,
    })),
    {
      name: "failed evidence call",
      followup: new Error(rawError),
      code: "followup-failed",
      requests: 2,
    },
    {
      name: "empty evidence error message",
      followup: new Error(""),
      code: "followup-failed",
      requests: 2,
    },
    {
      name: "invalid evidence response",
      followup: "not JSON",
      code: "followup-failed",
      requests: 2,
    },
    {
      name: "malformed requests in evidence follow-up",
      followup: {
        ...groupingResponse,
        problems: [
          {
            ...groupingResponse.problems[0],
            title: "Discarded follow-up grouping",
          },
        ],
        evidenceRequests: [{}],
      },
      code: "followup-failed",
      requests: 2,
    },
    {
      name: "second evidence round",
      followup: provisionalGrouping,
      code: "followup-failed",
      requests: 2,
    },
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t, { tests: 2 });
      mockClient(
        t,
        fakeClient({
          responses: [
            attemptResponse,
            attemptResponse,
            grouping ?? provisionalGrouping,
            followup,
          ],
        }),
      );
      const result = await analyzeFailures(options(f));
      assert.equal(result.status, "complete");
      assert.equal(result.attempts.analyzed, 2);
      assert.equal(result.grouping.status, "partial");
      assert.equal(result.grouping.problemCount, 1);
      assert.equal(result.grouping.diagnostics.stage, "complete");
      assert.equal(result.grouping.diagnostics.evidenceErrorCode, code);
      assert.equal(result.grouping.diagnostics.requestCount, requests);
      assert.equal(result.grouping.diagnostics.repairAttempted, false);
      assert.equal(result.warnings.length, 1);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(result.runDir, "analysis-result.json")),
        ),
        JSON.parse(JSON.stringify(result)),
      );
      const grouped = fs.readFileSync(
        path.join(result.runDir, result.artifacts.groupedAnalysis),
        "utf8",
      );
      assert.match(grouped, /\*\*Total: 2 = 2 extracted issues\*\*/);
      assert.doesNotMatch(grouped, /Discarded follow-up grouping/);
      const summary = fs.readFileSync(
        path.join(result.runDir, "summary.md"),
        "utf8",
      );
      assert.match(summary, /Status: \*\*complete\*\* \(with warnings\)/);
      assert.match(summary, /## Warning/);
      assert.match(summary, /Optional grouping evidence refinement failed/);
      assert.match(summary, /saved grouping remains provisional/);
      assert.doesNotMatch(
        summary,
        /private-token|private link|<script>|Generated check|Received: 503/,
      );
      assert.ok(Buffer.byteLength(summary, "utf8") < 16384);
      if (followup instanceof Error) {
        assert.equal(
          result.grouping.diagnostics.evidenceErrorMessage,
          followup.message,
        );
        assert.doesNotMatch(result.warnings[0], /private-token|<script>/);
      }
      const untrustedSummary = renderSummary({
        ...result,
        warnings: [rawError],
        grouping: {
          ...result.grouping,
          diagnostics: {
            ...result.grouping.diagnostics,
            evidenceErrorCode: rawError,
            evidenceErrorMessage: rawError,
          },
        },
      });
      assert.doesNotMatch(untrustedSummary, /private-token|<script>|private link/);
      assert.ok(Buffer.byteLength(untrustedSummary, "utf8") < 16384);
      for (const diagnostics of [
        { evidenceErrorCode: code },
        { evidenceErrorMessage: "" },
      ]) {
        assert.match(
          renderSummary({
            ...result,
            grouping: { ...result.grouping, diagnostics },
          }),
          /## Warning/,
        );
      }
    });
  }
});

test("evidence warnings do not hide incomplete coverage, attempts or reference repair", async (t) => {
  for (const scenario of [
    {
      name: "missing coverage",
      prepare(f) {
        f.report.files[0].tests[0].results.push({
          status: "failed",
          retry: 1,
          attachments: [],
        });
        f.writeReport();
      },
      verify(result) {
        assert.equal(result.coverage.missingAttempts.length, 1);
      },
    },
    {
      name: "omitted attempt",
      tests: 3,
      extra: { maxAttempts: 2 },
      verify(result) {
        assert.equal(result.attempts.omitted, 1);
      },
    },
    {
      name: "source-only fallback",
      responses: [
        "not JSON",
        "not JSON",
        attemptResponse,
        provisionalGrouping,
        new Error("Generated evidence failure"),
      ],
      verify(result) {
        assert.equal(result.attempts.fallbacks, 1);
      },
    },
    {
      name: "unavailable attempt",
      tests: 3,
      failFirstSession: true,
      verify(result) {
        assert.equal(result.attempts.unavailable, 1);
        assert.equal(result.errors[0].code, "ATTEMPT_FAILED");
      },
    },
    ...[
      { name: "missing reference", ids: ["I1"] },
      { name: "duplicate reference", ids: ["I1", "I1", "I2"] },
      { name: "unknown reference", ids: ["I1", "I2", "I404"] },
    ].map(({ name, ids }) => ({
      name,
      responses: [
        attemptResponse,
        attemptResponse,
        {
          ...provisionalGrouping,
          problems: [{ ...groupingResponse.problems[0], issueIds: ids }],
        },
        new Error("Generated repair failure"),
      ],
      verify(result) {
        assert.match(
          result.grouping.diagnostics.repairErrorMessage,
          /Generated repair failure/,
        );
      },
    })),
    {
      name: "malformed evidence request with empty reference-repair error",
      responses: [
        attemptResponse,
        attemptResponse,
        {
          ...groupingResponse,
          problems: [
            {
              ...groupingResponse.problems[0],
              issueIds: ["I1", "I1", "I2"],
            },
          ],
          evidenceRequests: {},
        },
        new Error(""),
      ],
      verify(result) {
        assert.equal(
          result.grouping.diagnostics.evidenceErrorCode,
          "invalid-request",
        );
        assert.equal(result.grouping.diagnostics.repairAttempted, true);
        assert.equal(result.grouping.diagnostics.repairErrorMessage, "");
      },
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const f = fixture(t, { tests: scenario.tests ?? 2 });
      scenario.prepare?.(f);
      let sessions = 0;
      mockClient(
        t,
        fakeClient({
          responses: scenario.responses ?? [
            attemptResponse,
            attemptResponse,
            provisionalGrouping,
            new Error("Generated evidence failure"),
          ],
          onCreate() {
            if (scenario.failFirstSession && sessions++ === 0)
              throw new Error("Generated attempt failure");
          },
        }),
      );
      const result = await analyzeFailures({
        ...options(f),
        concurrency: 1,
        ...scenario.extra,
      });
      assert.equal(result.status, "partial");
      assert.equal(result.grouping.status, "partial");
      assert.ok(result.grouping.diagnostics.evidenceErrorMessage);
      scenario.verify(result);
    });
  }
});

test("initial grouping failure is not downgraded to an optional evidence warning", async (t) => {
  for (const [name, grouping] of [
    ["request failure", new Error("Generated initial grouping failure")],
    ["invalid JSON", "not JSON"],
    [
      "missing summary",
      { problems: groupingResponse.problems, evidenceRequests: {} },
    ],
    [
      "invalid core and optional request",
      {
        ...groupingResponse,
        problems: [{ ...groupingResponse.problems[0], issueIds: [] }],
        evidenceRequests: {},
      },
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t, { tests: 2 });
      mockClient(
        t,
        fakeClient({
          responses: [attemptResponse, attemptResponse, grouping],
        }),
      );
      const result = await analyzeFailures(options(f));
      assert.equal(result.status, "partial");
      assert.equal(result.grouping.status, "failed");
      assert.equal(result.errors[0].code, "GROUPING_FAILED");
      assert.equal(result.artifacts.groupedAnalysis, undefined);
      assert.doesNotMatch(
        fs.readFileSync(path.join(result.runDir, "summary.md"), "utf8"),
        /saved grouping remains provisional/,
      );
    });
  }
});

test("cancellation during the optional evidence call remains cancellation", async (t) => {
  const f = fixture(t, { tests: 2 });
  const controller = new AbortController();
  mockClient(
    t,
    fakeClient({
      responses: [
        attemptResponse,
        attemptResponse,
        provisionalGrouping,
        () => {
          controller.abort(new Error("Generated evidence cancellation"));
          throw controller.signal.reason;
        },
      ],
    }),
  );
  const result = await analyzeFailures({
    ...options(f),
    signal: controller.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.grouping.diagnostics.evidenceRoundAttempted, true);
  assert.match(result.warnings.join("\n"), /Generated evidence cancellation/);
});

test("overall deadline during the optional evidence call remains partial", async (t) => {
  const f = fixture(t, { tests: 2 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(
    analyzer,
    "withCopilotAnalysisClient",
    async (_models, _token, callback, { signal }) =>
      callback(
        fakeClient({
          responses: [
            attemptResponse,
            attemptResponse,
            provisionalGrouping,
            () => {
              t.mock.timers.tick(1000);
              throw signal.reason;
            },
          ],
        }),
      ),
  );
  const result = await analyzeFailures({ ...options(f), timeoutMs: 1000 });
  assert.equal(result.status, "partial");
  assert.equal(result.grouping.diagnostics.evidenceRoundAttempted, true);
  assert.match(result.warnings.join("\n"), /Overall analysis deadline exceeded/);
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
