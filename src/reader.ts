import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import {
  getReportMetadata,
  type ReportMetadata,
} from "@andrii_kremlovskyi/playwright-traces-reader";
import {
  type FailureManifest,
  type FailureManifestEntry,
  isAnalyzableEntry,
} from "./copilot-analyzer";
import {
  AnalysisError,
  assertNotAborted,
  isInside,
  messageOf,
  objectValue,
  resolveWithin,
} from "./shared";

export interface Coverage {
  known: boolean;
  failedAttempts: number | null;
  traceBackedAttempts: number;
  missingAttempts: Array<{
    testId: string;
    project: string;
    attemptIndex: number;
  }>;
  warnings: string[];
}

export function validateManifest(
  value: unknown,
  runDir: string,
): FailureManifest {
  const data = objectValue(value, "Manifest");
  if (!Array.isArray(data.failures) || data.count !== data.failures.length)
    throw new AnalysisError(
      "INVALID_MANIFEST",
      "Manifest count must equal its failures array length.",
    );
  const folders = new Set<string>();
  const failures = data.failures.map((value, index): FailureManifestEntry => {
    const entry = objectValue(value, `Manifest entry ${index}`);
    if (
      typeof entry.folder !== "string" ||
      !entry.folder ||
      typeof entry.title !== "string" ||
      !(typeof entry.testTitle === "string" || entry.testTitle === null) ||
      !Number.isSafeInteger(entry.retryIndex) ||
      Number(entry.retryIndex) < 0 ||
      !["passed", "failed"].includes(String(entry.status)) ||
      !["expected", "unexpected", "flaky", "skipped", null].includes(
        entry.outcome as string | null,
      ) ||
      (entry.traceSha1 !== undefined && typeof entry.traceSha1 !== "string")
    )
      throw new AnalysisError(
        "INVALID_MANIFEST",
        `Invalid manifest entry ${index}.`,
      );
    const folder = resolveWithin(runDir, entry.folder, "Failure folder");
    const identity =
      process.platform === "win32" ? folder.toLowerCase() : folder;
    if (folders.has(identity))
      throw new AnalysisError("INVALID_MANIFEST", "Duplicate manifest folder.");
    if (!fs.statSync(folder).isDirectory())
      throw new AnalysisError(
        "INVALID_MANIFEST",
        `Manifest entry ${index} is not a directory.`,
      );
    folders.add(identity);
    return {
      folder: entry.folder,
      testTitle: entry.testTitle,
      title: entry.title,
      retryIndex: Number(entry.retryIndex),
      status: entry.status as FailureManifestEntry["status"],
      outcome: entry.outcome as FailureManifestEntry["outcome"],
      traceSha1: entry.traceSha1,
    };
  });
  // Never trust the absolute runDir embedded on a different machine.
  return { count: failures.length, runDir, failures };
}

export function measureCoverage(
  metadata: ReportMetadata | null,
  manifest: FailureManifest,
): Coverage {
  const result: Coverage = {
    known: metadata !== null,
    failedAttempts: metadata ? 0 : null,
    traceBackedAttempts: 0,
    missingAttempts: [],
    warnings: [],
  };
  if (!metadata) {
    result.warnings.push(
      "Report metadata is unavailable; failure coverage is unknown.",
    );
    return result;
  }
  const analyzedTraces = new Map(
    manifest.failures
      .filter(isAnalyzableEntry)
      .map((entry) => [entry.traceSha1, entry.retryIndex]),
  );
  let tests = 0;
  for (const file of metadata.files) {
    for (const test of file.tests) {
      tests++;
      const hasFailedResult = test.results.some((attempt) =>
        ["failed", "timedOut", "interrupted"].includes(attempt.status ?? ""),
      );
      if (
        (test.outcome === "unexpected" || test.outcome === "flaky") &&
        !hasFailedResult
      )
        result.known = false;
      if (!test.results.length && test.outcome !== "skipped") {
        result.known = false;
        result.warnings.push("A non-skipped test has no attempt metadata.");
      }
      for (const [attemptIndex, attempt] of test.results.entries()) {
        if (
          !["passed", "skipped", "failed", "timedOut", "interrupted"].includes(
            attempt.status ?? "",
          )
        ) {
          result.known = false;
          continue;
        }
        if (attempt.status === "passed" || attempt.status === "skipped")
          continue;
        result.failedAttempts!++;
        const traces = attempt.attachments
          .filter((item) => item.name === "trace" && item.path)
          .map((item) => path.basename(item.path!.replace(/\\/g, "/"), ".zip"));
        if (
          traces.length &&
          traces.every((trace) => analyzedTraces.get(trace) === attemptIndex)
        )
          result.traceBackedAttempts++;
        else
          result.missingAttempts.push({
            testId: test.testId,
            project: test.projectName,
            attemptIndex,
          });
      }
    }
  }
  if (tests !== metadata.stats.total) result.known = false;
  if (metadata.stats.ok === false && result.failedAttempts === 0)
    result.known = false;
  if (!result.known)
    result.warnings.push(
      "Some report attempt metadata is missing or inconsistent; coverage is unknown.",
    );
  if (result.missingAttempts.length)
    result.warnings.push(
      `${result.missingAttempts.length} failed attempt(s) lack analyzable trace evidence.`,
    );
  return result;
}

export async function inspectReport(
  reportPath: string,
  outputPath: string,
): Promise<{
  reportPath: string;
  outputPath: string;
  metadata: ReportMetadata | null;
}> {
  const report = fs.realpathSync(reportPath);
  if (!fs.statSync(report).isDirectory())
    throw new AnalysisError(
      "INVALID_REPORT",
      "Report root must be a directory.",
    );
  const index = resolveWithin(report, "index.html", "Report index");
  if (
    !fs.statSync(index).isFile() ||
    fs.statSync(index).size > 128 * 1024 * 1024
  )
    throw new AnalysisError(
      "INVALID_REPORT",
      "Report index must be a file no larger than 128 MiB.",
    );
  let output = path.resolve(outputPath);
  let ancestor = output;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  output = path.join(
    fs.realpathSync(ancestor),
    path.relative(ancestor, output),
  );
  if (output === report || isInside(report, output) || isInside(output, report))
    throw new AnalysisError(
      "UNSAFE_PATH",
      "Output and report directories must not overlap.",
    );
  const data = resolveWithin(report, "data", "Report data");
  if (fs.existsSync(data)) {
    const pending = [data];
    while (pending.length) {
      const dir = pending.pop()!;
      for (const entry of await fs.promises.readdir(dir, {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink())
          throw new AnalysisError(
            "UNSAFE_PATH",
            "Report data must not contain symbolic links.",
          );
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      }
    }
  }
  const metadata = await getReportMetadata(report);
  return { reportPath: report, outputPath: output, metadata };
}

export async function terminatePreparation(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } else {
    process.kill(-pid, "SIGKILL");
  }
}

export async function prepareReport(
  reportPath: string,
  outputPath: string,
  workers: number,
  signal?: AbortSignal,
): Promise<FailureManifest> {
  assertNotAborted(signal);
  fs.mkdirSync(outputPath, { recursive: true });
  const packageRoot = path.dirname(
    require.resolve("@andrii_kremlovskyi/playwright-traces-reader/package.json"),
  );
  const pkg = objectValue(
    JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")),
    "Reader package",
  );
  const bin = objectValue(pkg.bin, "Reader executable")[
    "playwright-traces-reader"
  ];
  if (typeof bin !== "string")
    throw new AnalysisError("PREPARATION_FAILED", "Reader CLI is missing.");
  const cli = resolveWithin(packageRoot, bin, "Reader executable");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "failures",
        reportPath,
        outputPath,
        "--format",
        "json",
        "--workers",
        String(workers),
      ],
      {
        cwd: outputPath,
        shell: false,
        // An attached pipe keeps this bounded process owned; POSIX group killing includes reader workers.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let stopped: Promise<void> | undefined;
    let failure: unknown;
    const stop = () => {
      if (child.pid && child.exitCode === null && !stopped) {
        stopped = terminatePreparation(child.pid);
        void stopped.catch(() => undefined);
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) {
        failure = new AnalysisError(
          "PREPARATION_FAILED",
          "Reader manifest exceeds 16 MiB.",
        );
        stop();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", async (code) => {
      signal?.removeEventListener("abort", stop);
      try {
        if (stopped) await stopped;
        assertNotAborted(signal);
        if (failure) throw failure;
        if (code !== 0)
          throw new AnalysisError(
            "PREPARATION_FAILED",
            `Trace preparation exited ${code}: ${stderr.trim()}`,
          );
        const raw = objectValue(JSON.parse(stdout), "Reader result");
        if (typeof raw.runDir !== "string")
          throw new Error("Reader did not return runDir.");
        const run = resolveWithin(
          outputPath,
          path.relative(outputPath, raw.runDir),
          "Prepared run",
        );
        const manifest = validateManifest(raw, run);
        if (
          !fs.existsSync(resolveWithin(run, "index.json", "Prepared manifest"))
        )
          throw new Error("Reader did not write index.json.");
        // Flatten only the newly generated reader run into the caller-owned run.
        for (const entry of fs.readdirSync(run)) {
          const source = resolveWithin(run, entry, "Prepared artifact");
          const destination = resolveWithin(
            outputPath,
            entry,
            "Prepared artifact",
          );
          if (fs.existsSync(destination))
            throw new Error(`Prepared artifact already exists: ${entry}`);
          fs.renameSync(source, destination);
        }
        fs.rmdirSync(run);
        fs.writeFileSync(
          path.join(outputPath, "index.json"),
          JSON.stringify(
            {
              ...raw,
              outputDir: path.dirname(outputPath),
              runDir: outputPath,
            },
            null,
            2,
          ) + "\n",
        );
        resolve({ ...manifest, runDir: outputPath });
      } catch (error) {
        reject(
          error instanceof AnalysisError
            ? error
            : new AnalysisError("PREPARATION_FAILED", messageOf(error), {
                cause: error,
              }),
        );
      }
    });
  });
}
