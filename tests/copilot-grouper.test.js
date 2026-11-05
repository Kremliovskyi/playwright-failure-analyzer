const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  groupRun,
  GroupingRunError,
  parseGroupingResponse,
  renderGroupedAnalysis,
  validateGroupingResponse,
} = require("../dist/copilot-grouper");

const entry = (
  folder,
  retryIndex = 0,
  outcome = "unexpected",
  testName = "generatedFlowTC01",
) => ({
  folder,
  testTitle: `tests/generated.spec.ts:42 › generated flow › ${testName}`,
  title: "Run generated flow",
  retryIndex,
  status: "failed",
  outcome,
});

const issue = (name, overrides = {}) => ({
  blockIndex: 1,
  source: {
    error: `Error: generated ${name} failure`,
    block: `Error: generated ${name} failure\nraw-detail-${name}`,
  },
  analysis: {
    summary: `The generated ${name} check failed.`,
    operation: `Check generated ${name}`,
    expected: `Generated ${name} expected value`,
    observed: `Generated ${name} observed value`,
    likelyCause: null,
    relevantSignals: [`signal-${name}`],
    confidence: "high",
    unknowns: [],
  },
  ...overrides,
});

const record = (folder, issues, overrides = {}) => ({
  schemaVersion: 4,
  model: "small-model",
  attempt: {
    folder,
    testTitle:
      "tests/generated.spec.ts:42 › generated flow › generatedFlowTC01",
    spec: "tests/generated.spec.ts:42",
    retryIndex: 0,
    status: "failed",
    outcome: "unexpected",
  },
  issues: issues.map((value, index) => ({ ...value, blockIndex: index + 1 })),
  ...overrides,
});

const modelProblem = (issueIds, overrides = {}) => ({
  title: "Generated grouped problem",
  error: "Generated representative error",
  failureExplanation:
    "A generated operation does not produce the expected result.",
  issueIds,
  ...overrides,
});

const createClient = (responses, prompts = [], timeouts = []) => ({
  async createSession(config) {
    this.sessionConfig = config;
    let eventHandler = () => {};
    let callIndex = 0;
    return {
      on(handler) {
        eventHandler = handler;
        return () => {
          eventHandler = () => {};
        };
      },
      async sendAndWait(options, timeout) {
        prompts.push(options.prompt);
        timeouts.push(timeout);
        const response = responses[Math.min(callIndex++, responses.length - 1)];
        if (response instanceof Error) throw response;
        if (typeof response === "function")
          return response({ options, eventHandler });
        return { data: { content: JSON.stringify(response) } };
      },
      async disconnect() {},
    };
  },
});

test("renders direct issue and attempt counts without terminal ownership", () => {
  const manifest = {
    count: 2,
    runDir: "/tmp/generated-run",
    failures: [
      entry("generated-a__retry0", 0, "unexpected", "generatedFlowTC01"),
      entry("generated-b__retry0", 0, "flaky", "generatedFlowTC02"),
    ],
  };
  const records = [
    record("generated-a__retry0", [issue("alpha"), issue("beta")]),
    record("generated-b__retry0", [issue("beta")]),
  ];
  const response = validateGroupingResponse(
    {
      summary: "Three generated issues form two problems.",
      problems: [
        {
          ...modelProblem([]),
          title: "Generated alpha problem",
          issueRefs: [{ folder: "generated-a__retry0", issueIndex: 1 }],
        },
        {
          ...modelProblem([]),
          title: "Generated beta problem",
          issueRefs: [
            { folder: "generated-a__retry0", issueIndex: 2 },
            { folder: "generated-b__retry0", issueIndex: 1 },
          ],
        },
      ],
    },
    records,
  );

  const markdown = renderGroupedAnalysis(
    "/tmp/generated-run",
    manifest,
    records,
    response,
    "small-model",
    "big-model",
  );
  assert.match(markdown, /\*\*Extracted issues:\*\* 3/);
  assert.match(markdown, /\| 1 \| Generated alpha problem \| 1 \| 1 \| 1 \|/);
  assert.match(markdown, /\| 2 \| Generated beta problem \| 2 \| 2 \| 2 \|/);
  assert.match(markdown, /\*\*Failure explanation:\*\*/);
  assert.match(markdown, /\*\*Total: 3 = 3 extracted issues\*\*/);
  assert.doesNotMatch(
    markdown,
    /Root cause|What happens|terminal|counted under/,
  );
});

test("rejects duplicate and unknown issue references", () => {
  const records = [record("generated__retry0", [issue("alpha")])];
  assert.throws(
    () =>
      validateGroupingResponse(
        {
          summary: "Duplicate",
          problems: [
            {
              ...modelProblem([]),
              issueRefs: [
                { folder: "generated__retry0", issueIndex: 1 },
                { folder: "generated__retry0", issueIndex: 1 },
              ],
            },
          ],
        },
        records,
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      validateGroupingResponse(
        {
          summary: "Unknown",
          problems: [
            {
              ...modelProblem([]),
              issueRefs: [{ folder: "generated__retry0", issueIndex: 2 }],
            },
          ],
        },
        records,
      ),
    /unknown issue/,
  );
});

test("preserves a partial response and appends omitted issues", () => {
  const records = [
    record("generated__retry0", [issue("alpha"), issue("beta")]),
  ];
  const response = validateGroupingResponse(
    {
      summary: "One generated issue was grouped.",
      problems: [
        {
          ...modelProblem([]),
          issueRefs: [{ folder: "generated__retry0", issueIndex: 1 }],
        },
      ],
    },
    records,
  );
  assert.equal(response.problems.length, 2);
  assert.equal(
    response.problems[1].title,
    "Unclassified - omitted by grouping model",
  );
  assert.deepEqual(response.problems[1].issueRefs, [
    { folder: "generated__retry0", issueIndex: 2 },
  ]);
});

test("keeps grouping semantics entirely model-owned", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-group-v4-"));
  const folders = ["generated-a__retry0", "generated-b__retry0"];
  const shared = issue("shared", {
    source: {
      error: "TimeoutError: generated shared timeout",
      block:
        "TimeoutError: generated shared timeout\nraw-detail-must-be-omitted",
    },
    analysis: {
      ...issue("shared").analysis,
      relevantSignals: ["same-looking-signal"],
    },
  });
  const records = folders.map((folder) => record(folder, [shared]));
  const manifest = {
    count: 2,
    runDir,
    failures: folders.map((folder, index) =>
      entry(folder, 0, "unexpected", `generatedFlowTC0${index + 1}`),
    ),
  };
  const prompts = [];
  const timeouts = [];
  const responses = [
    {
      summary: "The model keeps the generated issues separate.",
      problems: [
        modelProblem(["I1"], { title: "Generated problem A" }),
        modelProblem(["I2"], { title: "Generated problem B" }),
      ],
      evidenceRequests: [],
    },
  ];
  const client = createClient(responses, prompts, timeouts);

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.repairAttempted, false);
    assert.equal(result.diagnostics.requestCount, 1);
    assert.equal(timeouts[0], 600000);
    assert.match(
      prompts[0],
      /"sourceError":"TimeoutError: generated shared timeout"/,
    );
    assert.match(prompts[0], /"analysis":\{"summary":/);
    assert.match(prompts[0], /"failureExplanation":/);
    assert.doesNotMatch(prompts[0], /raw-detail-must-be-omitted/);
    assert.doesNotMatch(
      prompts[0],
      /rootCause|incidentHints|strongIncidentKey|causalAnchor|normalization|terminal|resolution/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("loads exact bounded evidence for one follow-up turn", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-evidence-v4-"));
  const folder = "generated__retry0";
  const folderPath = path.join(runDir, folder);
  fs.mkdirSync(folderPath);
  fs.writeFileSync(
    path.join(folderPath, "error.md"),
    `# Error details\n\n\`\`\`\nplaceholder\n\`\`\`\n\n# Page snapshot\n\n\`\`\`yaml\n- heading "Generated page evidence"\n\`\`\`\n`,
  );
  const records = [record(folder, [issue("alpha"), issue("beta")])];
  const manifest = { count: 1, runDir, failures: [entry(folder)] };
  const responses = [
    {
      summary: "More evidence is needed.",
      problems: [modelProblem(["I1", "I2"])],
      evidenceRequests: [
        {
          issueIds: ["I1", "I2"],
          sections: ["error-block", "final-page"],
          reason: "Compare exact generated evidence.",
        },
      ],
    },
    {
      summary: "The exact evidence supports separate groups.",
      problems: [
        modelProblem(["I1"], { title: "Generated alpha" }),
        modelProblem(["I2"], { title: "Generated beta" }),
      ],
      evidenceRequests: [],
    },
  ];
  const prompts = [];
  const client = createClient(responses, prompts);

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /raw-detail-alpha/);
    assert.match(prompts[1], /raw-detail-beta/);
    assert.match(prompts[1], /Generated page evidence/);
    assert.doesNotMatch(prompts[1], /not applicable to a non-terminal issue/);
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.evidenceRoundAttempted, true);
    assert.equal(result.diagnostics.evidenceIssueCount, 2);
    assert.ok(result.diagnostics.evidenceBytes > 0);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("repairs only missing issue references", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-repair-v4-"));
  const folder = "generated__retry0";
  const records = [record(folder, [issue("alpha"), issue("beta")])];
  const responses = [
    {
      summary: "One issue was omitted.",
      problems: [modelProblem(["I1"])],
    },
    {
      summary: "Both issues are assigned.",
      problems: [modelProblem(["I1"]), modelProblem(["I2"])],
      evidenceRequests: [],
    },
  ];
  const prompts = [];
  const client = createClient(responses, prompts);

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder)] },
      records,
      "small-model",
      "big-model",
    );
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /violated the exact issueId reference contract/);
    assert.match(prompts[1], /"missingIssueIds":\["I2"\]/);
    assert.match(prompts[1], /Repair only unknown, duplicate, or missing/);
    assert.doesNotMatch(prompts[1], /incident|causal|resolution|terminal/);
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.repairAttempted, true);
    assert.equal(result.diagnostics.omittedIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.omittedIssueCountAfterRepair, 0);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("sanitizes structural reference defects when repair fails", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fallback-v4-"));
  const folder = "generated__retry0";
  const records = [record(folder, [issue("alpha"), issue("beta")])];
  const responses = [
    {
      summary: "The initial response has structural defects.",
      problems: [
        modelProblem(["I1", "I404"], { title: "Valid first placement" }),
        modelProblem(["I1"], { title: "Duplicate placement" }),
      ],
    },
    () => ({ data: { content: '{"summary":"truncated"' } }),
  ];
  const client = createClient(responses);

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder)] },
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.omittedIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.unknownIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.duplicateIssueCountBeforeRepair, 1);
    assert.match(markdown, /Valid first placement/);
    assert.match(markdown, /Unclassified - invalid grouping references/);
    assert.doesNotMatch(markdown, /Duplicate placement|I404/);
    assert.match(markdown, /\*\*Total: 2 = 2 extracted issues\*\*/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("retains provisional grouping when an evidence request is invalid", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-invalid-evidence-v4-"),
  );
  const folder = "generated__retry0";
  const client = createClient([
    {
      summary: "The provisional grouping is complete.",
      problems: [modelProblem(["I1"], { title: "Provisional problem" })],
      evidenceRequests: [
        {
          issueIds: ["I99"],
          sections: ["error-block"],
          reason: "Inspect an unknown generated issue.",
        },
      ],
    },
  ]);

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder)] },
      [record(folder, [issue("alpha")])],
      "small-model",
      "big-model",
    );
    assert.equal(result.problemCount, 1);
    assert.equal(result.diagnostics.requestCount, 1);
    assert.match(result.diagnostics.evidenceErrorMessage, /unknown issue I99/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("does not read requested network evidence outside its folder", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-contained-v4-"),
  );
  const folder = "generated__retry0";
  const folderPath = path.join(runDir, folder);
  fs.mkdirSync(folderPath);
  fs.writeFileSync(
    path.join(folderPath, "failure.json"),
    JSON.stringify({ files: { networkErrors: "../secret.ndjson" } }),
  );
  fs.writeFileSync(path.join(runDir, "secret.ndjson"), "generated secret");
  const client = createClient([
    {
      summary: "Keep the provisional grouping.",
      problems: [modelProblem(["I1"])],
      evidenceRequests: [
        {
          issueIds: ["I1"],
          sections: ["network"],
          reason: "Inspect generated network evidence.",
        },
      ],
    },
  ]);

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder)] },
      [record(folder, [issue("alpha")])],
      "small-model",
      "big-model",
    );
    assert.match(
      result.diagnostics.evidenceErrorMessage,
      /outside its allowed directory/,
    );
    assert.equal(result.problemCount, 1);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("reports unavailable per-trace analysis without inventing issues", () => {
  const folder = "generated__retry0";
  const records = [record(folder, [], { error: "Generated model failure" })];
  const response = parseGroupingResponse(
    JSON.stringify({ summary: "No issues were available.", problems: [] }),
  );
  const markdown = renderGroupedAnalysis(
    "/tmp/generated-run",
    { count: 1, runDir: "/tmp/generated-run", failures: [entry(folder)] },
    records,
    response,
    "small-model",
    "big-model",
  );
  assert.match(markdown, /Unclassified - per-trace analysis unavailable/);
  assert.match(markdown, /\*\*Extracted issues:\*\* 0/);
  assert.match(markdown, /\*\*Total: 0 = 0 extracted issues\*\*/);
});

test("preserves diagnostics when the grouping response is invalid", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-error-v4-"));
  const folder = "generated__retry0";
  const client = createClient([
    ({ eventHandler }) => {
      eventHandler({
        type: "assistant.usage",
        data: {
          model: "big-model",
          inputTokens: 700,
          outputTokens: 900,
          finishReason: "length",
        },
      });
      return { data: { content: '{"summary":"truncated"' } };
    },
  ]);

  try {
    await assert.rejects(
      groupRun(
        client,
        runDir,
        { count: 1, runDir, failures: [entry(folder)] },
        [record(folder, [issue("alpha")])],
        "small-model",
        "big-model",
      ),
      (error) => {
        assert.equal(error instanceof GroupingRunError, true);
        assert.equal(error.diagnostics.stage, "parse");
        assert.equal(error.diagnostics.inputTokens, 700);
        assert.equal(error.diagnostics.outputTokens, 900);
        assert.equal(error.diagnostics.finishReason, "length");
        assert.match(error.diagnostics.errorMessage, /JSON/);
        return true;
      },
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
