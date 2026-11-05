const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test(
  "packed package installs independently with CJS, ESM, types and npm executable",
  { timeout: 120_000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwfa-package-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const npm = process.env.npm_execpath;
    assert.ok(
      npm,
      "Run package tests through npm test so the active npm CLI is known.",
    );
    function command(script, args, cwd) {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 90_000,
        windowsHide: true,
      });
      assert.equal(
        result.status,
        0,
        result.stdout + result.stderr + (result.error ?? ""),
      );
      return result.stdout;
    }
    const [packed] = JSON.parse(
      command(
        npm,
        ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
        path.resolve(__dirname, ".."),
      ),
    );
    for (const file of packed.files) {
      assert.ok(
        file.path.startsWith("dist/") ||
          ["package.json", "README.md", "LICENSE"].includes(file.path),
        file.path,
      );
    }
    assert.ok(packed.files.some((file) => file.path === "dist/index.d.ts"));
    const consumer = path.join(root, "consumer with spaces");
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "generated-package-consumer",
        private: true,
        scripts: { "check-cli": "playwright-failure-analyzer --version" },
      }),
    );
    command(
      npm,
      ["install", "--no-audit", "--no-fund", path.join(root, packed.filename)],
      consumer,
    );
    const name = "@andrii_kremlovskyi/playwright-failure-analyzer";
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const p = require('${name}'); if (typeof p.analyzeFailures !== 'function' || p.EVIDENCE_SCHEMA_VERSION !== 4) process.exit(1)`,
      ],
      { cwd: consumer, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const esm = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {analyzeFailures, EVIDENCE_SCHEMA_VERSION} from '${name}'; if (typeof analyzeFailures !== 'function' || EVIDENCE_SCHEMA_VERSION !== 4) process.exit(1);`,
      ],
      { cwd: consumer, encoding: "utf8" },
    );
    assert.equal(esm.status, 0, esm.stderr);
    assert.equal(
      command(npm, ["run", "--silent", "check-cli"], consumer).trim(),
      "0.1.0",
    );
    const ts = path.join(consumer, "consumer.ts");
    fs.writeFileSync(
      ts,
      `import { analyzeFailures, type AnalysisOptions, type FailureManifest } from '${name}';
const options: AnalysisOptions = { reportPath: 'report', outputDir: 'out', smallModel: 'small', bigModel: 'big' };
const manifest: FailureManifest = { count: 0, runDir: 'run', failures: [] };
void manifest; void analyzeFailures; void options;`,
    );
    command(
      require.resolve("typescript/bin/tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "Node16",
        "--target",
        "es2022",
        ts,
      ],
      consumer,
    );
  },
);
