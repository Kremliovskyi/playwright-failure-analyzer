const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  usingClient,
  evidenceSessionConfig,
} = require("../dist/copilot-client");

test(
  "bundled runtime starts and shuts down without a global CLI or model call",
  { timeout: 60_000 },
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Runtime startup exceeded 30 seconds")),
      30_000,
    );
    try {
      await usingClient(
        { token: "synthetic-not-a-credential", allowStoredLogin: false },
        async (_client, sdk) => {
          const status = await sdk.getStatus();
          assert.equal(typeof status.version, "string");
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  },
);

for (const storedLogin of [false, true]) {
  test(
    `real session cleanup preserves results with ${storedLogin ? "separate login storage" : "explicit-token isolation"}`,
    { timeout: 60_000 },
    async (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "pwfa-test-home-"));
      const sentinel = path.join(home, "preserve.txt");
      fs.writeFileSync(sentinel, "Existing login configuration");
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        COPILOT_HOME: home,
        GH_CONFIG_DIR: path.join(home, "gh"),
        COPILOT_GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      };
      t.after(() => {
        process.env = originalEnv;
      });
      const roots = [];
      const mkdtemp = fs.mkdtempSync;
      t.mock.method(fs, "mkdtempSync", (prefix, options) => {
        const directory = mkdtemp(prefix, options);
        if (
          typeof prefix === "string" &&
          path.basename(prefix) === "playwright-failure-analyzer-"
        )
          roots.push(directory);
        return directory;
      });
      let requests = 0;
      const provider = http.createServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(500).end("No inference expected");
      });
      await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
      t.after(
        () =>
          new Promise((resolve, reject) =>
            provider.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const result = await usingClient(
          storedLogin
            ? { allowStoredLogin: true }
            : { token: "synthetic-not-a-credential", allowStoredLogin: false },
          async (client) => {
            assert.equal(roots.length, 1);
            fs.writeFileSync(
              path.join(roots[0], "synthetic-evidence.txt"),
              "Synthetic evidence",
            );
            await Promise.all(
              ["synthetic-small", "synthetic-big"].map(async (model) => {
                const session = await client.createSession({
                  ...evidenceSessionConfig(model),
                  provider: {
                    type: "openai",
                    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
                    apiKey: "synthetic",
                  },
                });
                const state = path.join(roots[0], "session-state");
                assert.ok(
                  fs
                    .readdirSync(state, { withFileTypes: true })
                    .some((entry) => entry.isDirectory()),
                  "Session state must be inside the owned temporary directory",
                );
                await session.disconnect();
              }),
            );
            return "analysis-result";
          },
          controller.signal,
        );
        assert.equal(result, "analysis-result");
        assert.equal(fs.existsSync(roots[0]), false);
        assert.equal(
          fs.readFileSync(sentinel, "utf8"),
          "Existing login configuration",
        );
        assert.equal(
          requests,
          0,
          "Session lifecycle must not make inference requests",
        );
        assert.equal(fs.existsSync(path.join(home, "session-state")), false);
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
