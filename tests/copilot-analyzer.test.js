const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { analyzeRun } = require("../dist/copilot-analyzer");

const firstBlock = `Error: expect(locator).toBeVisible() failed
Locator: getByRole("heading", { name: "Generated result" })
Expected: visible
Received: hidden`;

const secondBlock = `Error: expect(received).toEqual(expected)
Expected HTTP status: 201
Received HTTP status: 503`;

const errorMarkdown = (blocks = [firstBlock]) => `# Test info

- Name: tests/generated.spec.ts >> generated case

# Error details

${blocks.map((block) => `\`\`\`\n${block}\n\`\`\``).join("\n\n")}

# Page snapshot

\`\`\`yaml
- heading "Generated completion page"
\`\`\`

# Test source

\`\`\`ts
await runGeneratedCase();
\`\`\`
`;

const modelIssue = (blockIndex, overrides = {}) => ({
  blockIndex,
  analysis: {
    summary: `Generated issue ${blockIndex} failed.`,
    operation: blockIndex === 1 ? "Check generated result" : "Check API status",
    expected: blockIndex === 1 ? "The result is visible" : "HTTP 201",
    observed: blockIndex === 1 ? "The result is hidden" : "HTTP 503",
    likelyCause: null,
    relevantSignals: [`generated-signal-${blockIndex}`],
    confidence: "high",
    unknowns: [],
    ...overrides,
  },
});

const modelRecord = (issues) => ({ schemaVersion: 4, issues });

const runAnalysis = async ({ responses, markdown, failureOverrides = {} }) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-analyzer-v4-"));
  const folder = "generated-attempt__retry0";
  fs.mkdirSync(path.join(runDir, folder));
  fs.writeFileSync(path.join(runDir, folder, "error.md"), markdown);
  fs.writeFileSync(
    path.join(runDir, folder, "failure.json"),
    JSON.stringify({
      testTitle: "tests/generated.spec.ts:10 › generated case",
      title: "Run generated case",
      status: "failed",
      outcome: "unexpected",
      retryIndex: 0,
      topLevelSteps: [
        {
          callId: "test.step@1",
          title: "Run generated case",
          method: "test.step",
          startTime: 1,
          endTime: 2,
          error: { message: "metadata error must not reach the model" },
          children: [],
        },
      ],
      files: { errorMarkdown: "error.md" },
      ...failureOverrides,
    }),
  );

  const queue = Array.isArray(responses) ? responses : [responses];
  const prompts = [];
  let sessionCount = 0;
  const client = {
    async createSession() {
      sessionCount++;
      return {
        async sendAndWait(options) {
          prompts.push(options.prompt);
          const index = Math.min(prompts.length - 1, queue.length - 1);
          return { data: { content: JSON.stringify(queue[index]) } };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await analyzeRun(
      client,
      runDir,
      {
        count: 1,
        runDir,
        failures: [
          {
            folder,
            testTitle: "tests/generated.spec.ts:10 › generated case",
            title: "Run generated case",
            retryIndex: 0,
            status: "failed",
            outcome: "unexpected",
          },
        ],
      },
      "small-model",
    );
    return {
      result,
      prompts,
      sessionCount,
      evidence: JSON.parse(
        fs.readFileSync(path.join(runDir, folder, "evidence.json"), "utf8"),
      ),
      markdown: fs.readFileSync(
        path.join(runDir, folder, "ai-analysis.md"),
        "utf8",
      ),
    };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
};

test("preserves error.md blocks and stores only minimal analysis", async () => {
  const result = await runAnalysis({
    responses: modelRecord([modelIssue(1)]),
    markdown: errorMarkdown(),
  });

  assert.equal(result.result.analyzed, 1);
  assert.equal(result.evidence.schemaVersion, 4);
  assert.equal(
    result.evidence.issues[0].source.error,
    firstBlock.split("\n")[0],
  );
  assert.equal(result.evidence.issues[0].source.block, firstBlock);
  assert.deepEqual(result.evidence.issues[0].analysis, modelIssue(1).analysis);
  assert.equal(result.evidence.issues[0].terminal, undefined);
  assert.equal(result.evidence.issues[0].normalization, undefined);
  assert.equal(result.evidence.issues[0].interpretation, undefined);
  assert.match(
    result.prompts[0],
    /contains exactly 1 issue entry|exactly 1 issue entry/,
  );
  assert.match(result.prompts[0], /# Page snapshot/);
  assert.doesNotMatch(
    result.prompts[0],
    /metadata error must not reach the model/,
  );
  assert.doesNotMatch(
    result.prompts[0],
    /resolution|causedByBlockIndex|failureFamily/,
  );
  assert.match(result.markdown, /### Issue 1/);
  assert.match(result.markdown, /Generated issue 1 failed/);
});

test("keeps multiple UI and API error blocks as separate issues", async () => {
  const result = await runAnalysis({
    responses: modelRecord([modelIssue(1), modelIssue(2)]),
    markdown: errorMarkdown([firstBlock, secondBlock]),
  });

  assert.equal(result.result.records[0].issues.length, 2);
  assert.equal(result.evidence.issues[0].source.block, firstBlock);
  assert.equal(result.evidence.issues[1].source.block, secondBlock);
  assert.equal(result.evidence.issues[1].analysis.observed, "HTTP 503");
});

test("repairs an incorrect issue count in the same session", async () => {
  const result = await runAnalysis({
    responses: [
      modelRecord([modelIssue(1), modelIssue(2)]),
      modelRecord([modelIssue(1)]),
    ],
    markdown: errorMarkdown(),
  });

  assert.equal(result.result.analyzed, 1);
  assert.equal(result.prompts.length, 2);
  assert.match(result.prompts[1], /2 issues for 1 error\.md blocks/);
  assert.match(
    result.prompts[1],
    /Each issue contains only blockIndex and analysis/,
  );
});

test("repairs an invalid analysis field without changing source", async () => {
  const invalid = modelIssue(1, { observed: { text: "hidden" } });
  const result = await runAnalysis({
    responses: [modelRecord([invalid]), modelRecord([modelIssue(1)])],
    markdown: errorMarkdown(),
  });

  assert.equal(result.prompts.length, 2);
  assert.match(
    result.prompts[1],
    /analysis\.observed must be a string or null; received object/,
  );
  assert.equal(result.evidence.issues[0].source.block, firstBlock);
});

test("retains every exact source block after two invalid responses", async () => {
  const result = await runAnalysis({
    responses: [modelRecord([]), modelRecord([])],
    markdown: errorMarkdown([firstBlock, secondBlock]),
  });

  assert.equal(result.result.analyzed, 1);
  assert.equal(result.result.records[0].issues.length, 2);
  assert.equal(result.evidence.issues[0].source.block, firstBlock);
  assert.equal(result.evidence.issues[1].source.block, secondBlock);
  assert.equal(result.evidence.issues[0].analysis.confidence, "low");
  assert.match(result.evidence.warning, /source blocks retained/);
});

test("rejects error.md without issue blocks before model invocation", async () => {
  const result = await runAnalysis({
    responses: modelRecord([]),
    markdown: "# Error details\n\n# Page snapshot\n",
  });

  assert.equal(result.sessionCount, 0);
  assert.equal(result.result.failed, 1);
  assert.match(result.result.records[0].error, /no fenced error blocks/);
  assert.match(result.markdown, /## Error/);
});

test("does not write analysis artifacts outside the run directory", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-analyzer-run-"),
  );
  const escapedFolder = `escaped-${path.basename(runDir)}`;
  const escapedPath = path.join(path.dirname(runDir), escapedFolder);
  fs.mkdirSync(escapedPath);
  let sessionCount = 0;
  const client = {
    async createSession() {
      sessionCount++;
      throw new Error("session must not be created");
    },
  };

  try {
    await assert.rejects(
      () =>
        analyzeRun(
          client,
          runDir,
          {
            count: 1,
            runDir,
            failures: [
              {
                folder: `../${escapedFolder}`,
                testTitle: "tests/generated.spec.ts:10 › generated case",
                title: "Run generated case",
                retryIndex: 0,
                status: "failed",
                outcome: "unexpected",
              },
            ],
          },
          "small-model",
        ),
      /outside its allowed directory/,
    );
    assert.equal(sessionCount, 0);
    assert.equal(fs.existsSync(path.join(escapedPath, "evidence.json")), false);
    assert.equal(
      fs.existsSync(path.join(escapedPath, "ai-analysis.md")),
      false,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(escapedPath, { recursive: true, force: true });
  }
});
