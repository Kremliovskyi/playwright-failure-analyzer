const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { analyzeRun } = require("../dist/copilot-analyzer");
const { groupRun } = require("../dist/copilot-grouper");
const { errorMd, explanation } = require("./fixture.cjs");

function prepared(t, count) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwfa-limits-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const failures = Array.from({ length: count }, (_, index) => {
    const entry = {
      folder: `attempt-${index}`,
      title: "Check status",
      testTitle: `synthetic.spec.ts:1 › Test ${index}`,
      retryIndex: 0,
      status: "failed",
      outcome: "unexpected",
    };
    fs.mkdirSync(path.join(runDir, entry.folder));
    fs.writeFileSync(path.join(runDir, entry.folder, "error.md"), errorMd);
    fs.writeFileSync(
      path.join(runDir, entry.folder, "failure.json"),
      JSON.stringify({ testTitle: entry.testTitle, files: {} }),
    );
    return entry;
  });
  return { runDir, count, failures };
}

test("attempt pool respects exact concurrency and completes in manifest order", async (t) => {
  const manifest = prepared(t, 8);
  let active = 0;
  let max = 0;
  const client = {
    async createSession(config) {
      assert.deepEqual(config.availableTools, []);
      active++;
      max = Math.max(max, active);
      return {
        async sendAndWait(_options, timeout) {
          assert.equal(timeout, 180000);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            data: {
              content: JSON.stringify({
                schemaVersion: 4,
                issues: [{ blockIndex: 1, analysis: explanation }],
              }),
            },
          };
        },
        async disconnect() {
          active--;
        },
      };
    },
  };
  const result = await analyzeRun(client, manifest.runDir, manifest, "small");
  assert.equal(max, 3);
  assert.equal(active, 0);
  assert.deepEqual(
    result.records.map((record) => record.attempt.folder),
    manifest.failures.map((entry) => entry.folder),
  );
  await assert.rejects(
    analyzeRun(client, manifest.runDir, manifest, "small"),
    /already exists/,
  );
});

test("grouping evidence obeys 6000 section and 48000 aggregate character limits", async (t) => {
  const manifest = prepared(t, 30);
  const long = "X".repeat(9000);
  const records = manifest.failures.map((entry) => ({
    schemaVersion: 4,
    model: "small",
    attempt: { ...entry, spec: "" },
    issues: [
      {
        blockIndex: 1,
        source: { error: "Error", block: long },
        analysis: { ...explanation, summary: long },
      },
    ],
  }));
  for (const entry of manifest.failures) {
    fs.writeFileSync(
      path.join(manifest.runDir, entry.folder, "error.md"),
      `# Error details\n\n\`\`\`\nError\n\`\`\`\n\n# Page snapshot\n${long}\n# Test source\n${long}`,
    );
  }
  const ids = records.map((_, index) => `I${index + 1}`);
  const response = {
    summary: "Generated summary",
    problems: [
      {
        title: "Generated problem",
        error: "Error",
        failureExplanation: "Generated explanation",
        issueIds: ids,
      },
    ],
    evidenceRequests: [],
  };
  let calls = 0;
  let followup = "";
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async disconnect() {},
        async sendAndWait({ prompt }, timeout) {
          assert.equal(timeout, 600000);
          calls++;
          if (calls === 1) {
            assert.ok(!prompt.includes("X".repeat(1201)));
            return {
              data: {
                content: JSON.stringify({
                  ...response,
                  evidenceRequests: Array.from({ length: 10 }, (_, i) => ({
                    issueIds: ids.slice(i * 3, i * 3 + 3),
                    sections: ["error-block", "final-page", "test-source"],
                    reason: "Compare generated evidence",
                  })),
                }),
              },
            };
          }
          followup = prompt;
          return { data: { content: JSON.stringify(response) } };
        },
      };
    },
  };
  const result = await groupRun(
    client,
    manifest.runDir,
    manifest,
    records,
    "small",
    "big",
  );
  assert.equal(calls, 2);
  const evidence = JSON.parse(
    followup
      .split("<requested-source-evidence-json>\n")[1]
      .split("\n</requested-source-evidence-json>")[0],
  );
  const sections = evidence.evidenceRequests
    .flatMap((request) =>
      request.issues.flatMap((issue) => Object.values(issue.sections)),
    )
    .filter((x) => x !== null);
  assert.ok(sections.every((text) => text.length <= 6000));
  assert.equal(
    sections.reduce((sum, text) => sum + text.length, 0),
    48000,
  );
  assert.equal(result.diagnostics.evidenceIssueCount, 30);
});

test("oversized evidence file retains provisional grouping with a visible diagnostic", async (t) => {
  const manifest = prepared(t, 2);
  const records = manifest.failures.map((entry) => ({
    schemaVersion: 4,
    model: "small",
    attempt: { ...entry, spec: "" },
    issues: [
      {
        blockIndex: 1,
        source: { error: "Error", block: "Error" },
        analysis: explanation,
      },
    ],
  }));
  fs.writeFileSync(
    path.join(manifest.runDir, manifest.failures[0].folder, "error.md"),
    "X".repeat(4 * 1024 * 1024 + 1),
  );
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async disconnect() {},
        async sendAndWait() {
          return {
            data: {
              content: JSON.stringify({
                summary: "Generated",
                problems: [
                  {
                    title: "Generated",
                    error: "Error",
                    failureExplanation: "Generated explanation",
                    issueIds: ["I1", "I2"],
                  },
                ],
                evidenceRequests: [
                  {
                    issueIds: ["I1"],
                    sections: ["final-page"],
                    reason: "Inspect generated page",
                  },
                ],
              }),
            },
          };
        },
      };
    },
  };
  const result = await groupRun(
    client,
    manifest.runDir,
    manifest,
    records,
    "small",
    "big",
  );
  assert.match(
    result.diagnostics.evidenceErrorMessage,
    /exceeds 4194304 bytes/,
  );
  assert.equal(result.problemCount, 1);
});

test("attempt usage accumulates reported tokens without inventing missing measurements", async (t) => {
  const manifest = prepared(t, 2);
  const client = {
    async createSession() {
      let listener;
      return {
        on(handler) {
          listener = handler;
          return () => {
            listener = undefined;
          };
        },
        async disconnect() {},
        async sendAndWait() {
          listener({
            type: "assistant.usage",
            data: { inputTokens: 10, outputTokens: 2 },
          });
          return {
            data: {
              content: JSON.stringify({
                schemaVersion: 4,
                issues: [{ blockIndex: 1, analysis: explanation }],
              }),
            },
          };
        },
      };
    },
  };
  const result = await analyzeRun(client, manifest.runDir, manifest, "small");
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
});
