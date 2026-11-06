const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const AdmZip = require("adm-zip");

const errorBlock =
  "Error: expect(received).toEqual(expected)\nExpected: 201\nReceived: 503";
const errorMd = `# Error details\n\n\`\`\`\n${errorBlock}\n\`\`\`\n\n# Test source\n\n\`\`\`ts\nexpect(503).toEqual(201);\n\`\`\`\n`;

function fixture(
  t,
  {
    statuses = ["failed"],
    traces = true,
    metadata = true,
    outcome,
    tests = 1,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwfa-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report with spaces");
  const outputDir = path.join(root, "output");
  fs.mkdirSync(path.join(reportPath, "data"), { recursive: true });
  const report = {
    stats: {
      total: tests,
      unexpected: statuses.includes("failed") ? tests : 0,
      expected: 0,
      flaky: 0,
      skipped: 0,
      ok: !statuses.includes("failed"),
    },
    files: [{ fileId: "synthetic", fileName: "synthetic.spec.ts", tests: [] }],
    projectNames: ["synthetic"],
    startTime: 1,
    duration: 100,
  };
  for (let i = 0; i < tests; i++) {
    const test = {
      testId: `synthetic-${i}`,
      title: `Generated check ${i}`,
      path: ["synthetic.spec.ts", `Generated check ${i}`],
      projectName: "synthetic",
      location: { file: "synthetic.spec.ts", line: i + 1, column: 1 },
      outcome:
        outcome ?? (statuses.includes("failed") ? "unexpected" : "expected"),
      duration: 100,
      ok: false,
      annotations: [],
      tags: [],
      results: [],
    };
    for (const [retry, status] of statuses.entries()) {
      const sha = randomUUID();
      const title = `synthetic.spec.ts:${i + 1} › Generated check ${i}`;
      const attachments = [];
      if (traces) {
        const zip = new AdmZip();
        zip.addFile(
          "0-trace.trace",
          Buffer.from(
            JSON.stringify({
              type: "context-options",
              version: 8,
              origin: "testRunner",
              browserName: "chromium",
              platform: "linux",
              playwrightVersion: "1.59.0",
              wallTime: 1,
              monotonicTime: 1,
              title,
              options: {},
            }) + "\n",
          ),
        );
        zip.addFile(
          "test.trace",
          Buffer.from(
            [
              {
                type: "before",
                callId: "test@1",
                startTime: 1,
                class: "Test",
                method: "step",
                title: "Check status",
                params: {},
                stack: [],
              },
              {
                type: "after",
                callId: "test@1",
                endTime: 100,
                ...(status === "passed"
                  ? {}
                  : { error: { name: "AssertionError", message: errorBlock } }),
              },
            ]
              .map((item) => JSON.stringify(item))
              .join("\n") + "\n",
          ),
        );
        zip.writeZip(path.join(reportPath, "data", `${sha}.zip`));
        fs.writeFileSync(path.join(reportPath, "data", `${sha}.md`), errorMd);
        attachments.push(
          {
            name: "trace",
            path: `data/${sha}.zip`,
            contentType: "application/zip",
          },
          {
            name: "error-context",
            path: `data/${sha}.md`,
            contentType: "text/markdown",
          },
        );
      }
      test.results.push({ status, retry, attachments });
    }
    report.files[0].tests.push(test);
  }
  function writeReport() {
    const zip = new AdmZip();
    zip.addFile("report.json", Buffer.from(JSON.stringify(report)));
    fs.writeFileSync(
      path.join(reportPath, "index.html"),
      metadata
        ? `<template id="playwrightReportBase64">data:application/zip;base64,${zip.toBuffer().toString("base64")}</template>`
        : "<html>No metadata</html>",
    );
  }
  writeReport();
  return { root, reportPath, outputDir, report, writeReport };
}

const explanation = {
  summary: "The generated status assertion failed.",
  operation: "Check status",
  expected: "201",
  observed: "503",
  likelyCause: null,
  relevantSignals: [],
  unknowns: [],
  confidence: "high",
};

const attemptResponse = {
  schemaVersion: 4,
  issues: [{ blockIndex: 1, analysis: explanation }],
};

const groupingResponse = {
  summary: "One generated problem.",
  problems: [
    {
      title: "Status mismatch",
      error: "Unexpected status",
      failureExplanation:
        "The observed status differs from the expected status.",
      issueIds: ["I1", "I2"],
    },
  ],
  evidenceRequests: [],
};

function fakeClient({ responses, delay = 0, onCreate = () => {} } = {}) {
  let next = 0;
  return {
    async createSession(config) {
      onCreate(config);
      return {
        on() {
          return () => {};
        },
        async disconnect() {},
        async sendAndWait() {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          const response = responses
            ? responses[Math.min(next++, responses.length - 1)]
            : config.model === "big"
              ? groupingResponse
              : attemptResponse;
          if (response instanceof Error) throw response;
          if (typeof response === "function") return response();
          return {
            data: {
              content:
                typeof response === "string"
                  ? response
                  : JSON.stringify(response),
            },
          };
        },
      };
    },
  };
}

module.exports = {
  fixture,
  fakeClient,
  errorBlock,
  errorMd,
  explanation,
  attemptResponse,
  groupingResponse,
};
