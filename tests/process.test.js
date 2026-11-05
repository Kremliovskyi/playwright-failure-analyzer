const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { terminatePreparation } = require("../dist/reader");

test(
  "preparation cancellation terminates its owned process tree",
  { timeout: 10_000 },
  async () => {
    const code = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
    const parent = spawn(process.execPath, ["-e", code], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = once(parent, "close");
    const [data] = await once(parent.stdout, "data");
    const childPid = Number(String(data).trim());
    try {
      await terminatePreparation(parent.pid);
      await closed;
      assert.ok(parent.exitCode !== null || parent.signalCode !== null);
      if (
        process.platform === "linux" &&
        fs.existsSync(`/proc/${childPid}/stat`)
      ) {
        // A killed orphan can briefly remain a zombie until the container init reaps it.
        assert.match(
          fs.readFileSync(`/proc/${childPid}/stat`, "utf8"),
          /\) Z /,
        );
      } else {
        assert.throws(() => process.kill(childPid, 0));
      }
    } finally {
      if (parent.exitCode === null && parent.signalCode === null)
        await terminatePreparation(parent.pid);
    }
  },
);
