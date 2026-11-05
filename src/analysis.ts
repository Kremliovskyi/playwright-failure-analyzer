import fs from "node:fs";
import path from "node:path";
import {
  analyzeRun,
  withCopilotAnalysisClient,
  isAnalyzableEntry,
  type AnalyzeProgress,
  type FailureManifest,
  type UnderstandingRecord,
  type TokenUsage,
} from "./copilot-analyzer";
import {
  groupRun,
  GroupingRunError,
  type GroupRunResult,
} from "./copilot-grouper";
import type { AuthenticationOptions } from "./copilot-client";
import {
  inspectReport,
  measureCoverage,
  prepareReport,
  validateManifest,
  type Coverage,
} from "./reader";
import {
  AnalysisError,
  assertNotAborted,
  messageOf,
  positiveInteger,
  writeNewFile,
} from "./shared";

export const ANALYSIS_RESULT_FILENAME = "analysis-result.json";
export const SUMMARY_FILENAME = "summary.md";
export const ANALYSIS_RESULT_SCHEMA_VERSION = 1;

export interface AnalysisOptions {
  reportPath: string;
  outputDir: string;
  smallModel: string;
  bigModel: string;
  authentication?: AuthenticationOptions;
  workers?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (event: AnalysisProgress) => void;
}

export type AnalysisProgress =
  | { phase: "preparation" | "grouping" | "complete" }
  | { phase: "analysis"; progress: AnalyzeProgress };

export interface AnalysisResult {
  schemaVersion: typeof ANALYSIS_RESULT_SCHEMA_VERSION;
  status: "complete" | "no-failures" | "partial" | "failed" | "cancelled";
  runDir: string;
  coverage: Coverage;
  attempts: {
    total: number;
    analyzed: number;
    unavailable: number;
    excluded: number;
    omitted: number;
    fallbacks: number;
  };
  grouping: {
    status: "complete" | "partial" | "failed" | "not-needed";
    problemCount?: number;
    diagnostics?: GroupRunResult["diagnostics"];
  };
  models: { smallModel: string; bigModel: string };
  versions: {
    analyzer: string;
    reader: string;
    sdk: string;
    runtime: string;
    node: string;
  };
  durationMs: number;
  attemptUsage?: TokenUsage;
  warnings: string[];
  errors: Array<{ stage: string; code: string; message: string }>;
  artifacts: {
    manifest?: string;
    result: string;
    summary: string;
    groupedAnalysis?: string;
    attempts: string[];
  };
}

export class FailureAnalysisError extends AnalysisError {
  constructor(
    readonly result: AnalysisResult,
    cause: unknown,
  ) {
    super(
      cause instanceof AnalysisError ? cause.code : "ANALYSIS_FAILED",
      messageOf(cause),
      { cause },
    );
  }
}

export function renderSummary(result: AnalysisResult): string {
  return [
    "# Playwright Failure Analysis",
    "",
    `Status: **${result.status}**`,
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Reported failed attempts | ${result.coverage.failedAttempts ?? "unknown"} |`,
    `| Trace-backed failed attempts | ${result.coverage.traceBackedAttempts} |`,
    `| Analyzable attempts | ${result.attempts.total} |`,
    `| Analyzed attempts | ${result.attempts.analyzed} |`,
    `| Unavailable attempts | ${result.attempts.unavailable} |`,
    `| Excluded entries | ${result.attempts.excluded} |`,
    `| Omitted attempts | ${result.attempts.omitted} |`,
    `| Source-only fallbacks | ${result.attempts.fallbacks} |`,
    `| Grouped problems | ${result.grouping.problemCount ?? "not available"} |`,
    "",
    `Coverage: ${result.coverage.known ? "known" : "unknown"}.`,
    `Grouping: ${result.grouping.status}.`,
    `Warnings: ${result.warnings.length}. Errors: ${result.errors.length}.`,
    "",
    "See analysis-result.json and the restricted evidence artifacts for details.",
    "This summary deliberately omits test names, source code, and network bodies.",
    "",
  ].join("\n");
}

function versions(): AnalysisResult["versions"] {
  const own = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const reader = JSON.parse(
    fs.readFileSync(
      require.resolve("@andrii_kremlovskyi/playwright-traces-reader/package.json"),
      "utf8",
    ),
  );
  const sdkRoot = path.resolve(
    path.dirname(require.resolve("@github/copilot-sdk")),
    "..",
    "..",
  );
  const sdk = JSON.parse(
    fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"),
  );
  return {
    analyzer: own.version,
    reader: reader.version,
    sdk: sdk.version,
    runtime: sdk.copilotCliVersion,
    node: process.version,
  };
}

export function validateOptions(options: AnalysisOptions): void {
  for (const field of [
    "reportPath",
    "outputDir",
    "smallModel",
    "bigModel",
  ] as const) {
    if (typeof options[field] !== "string" || !options[field].trim())
      throw new AnalysisError("INVALID_OPTIONS", `${field} is required.`);
  }
  positiveInteger(options.workers ?? 4, "workers", 5);
  positiveInteger(options.concurrency ?? 3, "concurrency");
  if (options.timeoutMs !== undefined)
    positiveInteger(options.timeoutMs, "timeoutMs");
  if (options.maxAttempts !== undefined)
    positiveInteger(options.maxAttempts, "maxAttempts");
}

export async function analyzeFailures(
  options: AnalysisOptions,
): Promise<AnalysisResult> {
  validateOptions(options);
  const startedAt = Date.now();
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      options.signal?.reason ??
        new AnalysisError("ABORTED", "Analysis cancelled."),
    );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new AnalysisError(
                "DEADLINE_EXCEEDED",
                "Overall analysis deadline exceeded.",
              ),
            ),
          options.timeoutMs,
        );
  const signal = controller.signal;
  let result: AnalysisResult | undefined;
  let stage = "preparation";
  const save = () => {
    if (!result) return;
    result.durationMs = Date.now() - startedAt;
    writeNewFile(
      result.runDir,
      ANALYSIS_RESULT_FILENAME,
      JSON.stringify(result, null, 2) + "\n",
    );
    writeNewFile(result.runDir, SUMMARY_FILENAME, renderSummary(result));
  };
  try {
    assertNotAborted(signal);
    options.onProgress?.({ phase: "preparation" });
    const input = await inspectReport(options.reportPath, options.outputDir);
    assertNotAborted(signal);
    const initialCoverage = measureCoverage(input.metadata, {
      count: 0,
      runDir: "",
      failures: [],
    });
    fs.mkdirSync(input.outputPath, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(input.outputPath, "run-"));
    result = {
      schemaVersion: ANALYSIS_RESULT_SCHEMA_VERSION,
      status: "complete",
      runDir,
      coverage: initialCoverage,
      attempts: {
        total: 0,
        analyzed: 0,
        unavailable: 0,
        excluded: 0,
        omitted: 0,
        fallbacks: 0,
      },
      grouping: { status: "not-needed" },
      models: { smallModel: options.smallModel, bigModel: options.bigModel },
      versions: versions(),
      durationMs: 0,
      warnings: [],
      errors: [],
      artifacts: {
        result: ANALYSIS_RESULT_FILENAME,
        summary: SUMMARY_FILENAME,
        attempts: [],
      },
    };
    let manifest: FailureManifest;
    if (
      (initialCoverage.known && initialCoverage.failedAttempts === 0) ||
      !fs.existsSync(path.join(input.reportPath, "data"))
    ) {
      manifest = { runDir, count: 0, failures: [] };
      writeNewFile(
        runDir,
        "index.json",
        JSON.stringify(
          {
            schemaVersion: 2,
            command: "failures",
            outputDir: input.outputPath,
            ...manifest,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      manifest = await prepareReport(
        input.reportPath,
        runDir,
        options.workers ?? 4,
        signal,
      );
    }
    manifest = validateManifest(manifest, manifest.runDir);
    const coverage = measureCoverage(input.metadata, manifest);
    const candidates = manifest.failures.filter(isAnalyzableEntry);
    result.coverage = coverage;
    result.attempts.total = candidates.length;
    result.attempts.omitted = candidates.length;
    result.attempts.excluded = manifest.count - candidates.length;
    result.warnings = [...coverage.warnings];
    result.artifacts.manifest = "index.json";
    if (candidates.length) {
      stage = "authentication";
      const current = result;
      await withCopilotAnalysisClient(
        current.models,
        options.authentication?.token,
        async (client) => {
          stage = "analysis";
          const analysis = await analyzeRun(
            client,
            manifest.runDir,
            manifest,
            options.smallModel,
            (progress) => options.onProgress?.({ phase: "analysis", progress }),
            {
              signal,
              concurrency: options.concurrency,
              maxAttempts: options.maxAttempts,
            },
          );
          current.attempts.analyzed = analysis.analyzed;
          current.attempts.unavailable = analysis.failed;
          current.attempts.omitted = analysis.omitted;
          current.attempts.fallbacks = analysis.records.filter(
            (record) => record.warning,
          ).length;
          if (analysis.usage) current.attemptUsage = analysis.usage;
          current.artifacts.attempts = analysis.records.map(
            (record) => record.attempt.folder,
          );
          for (const record of analysis.records) {
            if (record.error)
              current.errors.push({
                stage: "analysis",
                code: "ATTEMPT_FAILED",
                message: record.error,
              });
            if (record.warning) current.warnings.push(record.warning);
          }
          if (analysis.omitted)
            current.warnings.push(
              `${analysis.omitted} attempt(s) were not analyzed.`,
            );
          if (signal.aborted) return;
          if (
            candidates.length > 1 &&
            analysis.records.some((record) => record.issues.length)
          ) {
            stage = "grouping";
            options.onProgress?.({ phase: "grouping" });
            const folders = new Set(
              analysis.records.map((record) => record.attempt.folder),
            );
            const records: UnderstandingRecord[] = [
              ...analysis.records,
              ...candidates
                .filter((entry) => !folders.has(entry.folder))
                .map((entry) => ({
                  schemaVersion: 4 as const,
                  model: options.smallModel,
                  attempt: { ...entry, spec: "" },
                  issues: [],
                  error: "Attempt not analyzed within the configured budget.",
                })),
            ];
            try {
              const grouping = await groupRun(
                client,
                manifest.runDir,
                manifest,
                records,
                options.smallModel,
                options.bigModel,
                { signal },
              );
              const d = grouping.diagnostics;
              const partial = !!(
                d.evidenceErrorMessage ||
                d.repairErrorMessage ||
                d.omittedIssueCountAfterRepair ||
                analysis.failed ||
                analysis.omitted
              );
              current.grouping = {
                status: partial ? "partial" : "complete",
                problemCount: grouping.problemCount,
                diagnostics: d,
              };
              current.artifacts.groupedAnalysis = grouping.fileName;
              if (partial)
                current.warnings.push(
                  "Grouping retained partial or provisional evidence; inspect diagnostics.",
                );
            } catch (error) {
              current.grouping = {
                status: "failed",
                diagnostics:
                  error instanceof GroupingRunError
                    ? error.diagnostics
                    : undefined,
              };
              current.errors.push({
                stage,
                code: "GROUPING_FAILED",
                message: messageOf(error),
              });
            }
          }
        },
        { signal, allowStoredLogin: options.authentication?.allowStoredLogin },
      );
    }
    if (signal.aborted) {
      result.warnings.push(messageOf(signal.reason));
      result.status = options.signal?.aborted ? "cancelled" : "partial";
    } else if (result.warnings.length || result.errors.length) {
      result.status = "partial";
    } else if (
      coverage.known &&
      coverage.failedAttempts === 0 &&
      !candidates.length
    ) {
      result.status = "no-failures";
    }
    options.onProgress?.({ phase: "complete" });
    save();
    return result;
  } catch (error) {
    if (result) {
      result.status = signal.aborted
        ? options.signal?.aborted
          ? "cancelled"
          : "partial"
        : "failed";
      result.errors.push({
        stage,
        code: error instanceof AnalysisError ? error.code : "ANALYSIS_FAILED",
        message: signal.aborted
          ? `${messageOf(signal.reason)}; ${messageOf(error)}`
          : messageOf(error),
      });
      try {
        save();
      } catch (writeError) {
        throw new AnalysisError(
          "OUTPUT_FAILED",
          `${messageOf(error)}; could not persist result: ${messageOf(writeError)}`,
          { cause: error },
        );
      }
      if (signal.aborted) return result;
      throw new FailureAnalysisError(result, error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
