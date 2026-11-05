const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  resolveAuthentication,
  evidenceSessionConfig,
} = require("../dist/copilot-client");
const clientModule = require("../dist/copilot-client");
const { withCopilotAnalysisClient } = require("../dist/copilot-analyzer");
const { withCleanup, resolveWithin } = require("../dist/shared");

test("token precedence and local/CI defaults are explicit", () => {
  const env = {
    CI: "true",
    COPILOT_GITHUB_TOKEN: "copilot",
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "actions",
  };
  assert.deepEqual(resolveAuthentication({ token: "explicit" }, env), {
    gitHubToken: "explicit",
    useLoggedInUser: false,
  });
  assert.equal(resolveAuthentication({}, env).gitHubToken, "copilot");
  assert.equal(
    resolveAuthentication({}, { CI: "true", GITHUB_TOKEN: "actions" })
      .gitHubToken,
    "actions",
  );
  assert.equal(resolveAuthentication({}, {}).useLoggedInUser, true);
  assert.throws(
    () => resolveAuthentication({}, { CI: "true" }),
    /non-interactive/,
  );
  assert.throws(() => resolveAuthentication({ token: " " }, {}), /empty/);
});

test("both stages use tool-free isolated session configuration", () => {
  for (const model of ["small", "big"]) {
    const config = evidenceSessionConfig(model);
    assert.deepEqual(config.availableTools, []);
    assert.deepEqual(config.tools, []);
    assert.equal(config.enableConfigDiscovery, false);
    assert.equal(config.enableFileHooks, false);
    assert.equal(config.enableSkills, false);
    assert.equal(config.enableSessionStore, false);
    assert.equal(config.skipCustomInstructions, true);
    assert.match(config.onPermissionRequest().kind, /denied/);
  }
});

test("preflight rejects unavailable models without invoking analysis", async (t) => {
  t.mock.method(clientModule, "usingClient", (_auth, callback) =>
    callback(
      {},
      {
        async getAuthStatus() {
          return { isAuthenticated: true };
        },
        async listModels() {
          return [{ id: "small" }];
        },
      },
    ),
  );
  await assert.rejects(
    withCopilotAnalysisClient(
      { smallModel: "small", bigModel: "unavailable" },
      undefined,
      () => assert.fail("Must not run"),
    ),
    (error) => error.code === "COPILOT_MODEL_UNAVAILABLE",
  );
});

test("cleanup errors do not erase the primary error", async () => {
  await assert.rejects(
    withCleanup(
      async () => {
        throw new Error("primary");
      },
      async () => {
        throw new Error("cleanup");
      },
    ),
    /primary; cleanup failed: cleanup/,
  );
});

test("path validation rejects parent junctions and traversal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwfa-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  const inside = path.join(root, "inside");
  fs.mkdirSync(outside);
  fs.mkdirSync(inside);
  fs.symlinkSync(
    outside,
    path.join(inside, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => resolveWithin(inside, "link/new.json", "Output"),
    /symbolic/,
  );
  assert.throws(
    () => resolveWithin(inside, "../outside/data", "Output"),
    /outside/,
  );
});
