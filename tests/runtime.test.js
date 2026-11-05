const assert = require("node:assert/strict");
const test = require("node:test");
const { usingClient } = require("../dist/copilot-client");

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
