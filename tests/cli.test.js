const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { fixture } = require("./fixture.cjs");

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
  assert.match(run(["--help"]).stdout, /Usage:/);
  assert.equal(run(["--version"]).stdout.trim(), "0.1.0");
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
