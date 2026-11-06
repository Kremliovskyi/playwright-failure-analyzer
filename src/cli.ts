#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeFailures, FailureAnalysisError } from "./analysis";
import {
  validateAnalysisContext,
  type AnalysisContext,
} from "./analysis-context";
import { copilotAccessCheck, copilotModels } from "./copilot-analyzer";
import { AnalysisError, messageOf } from "./shared";

const help = `Usage:
  playwright-failure-analyzer analyze --report <root> --output <parent>
    --small-model <id> --big-model <id> [--workers <1-5>]
    [--concurrency <n>] [--timeout-ms <ms>] [--max-attempts <n>]
    [--context <json-file>] [--format json|text]
  playwright-failure-analyzer check-access [--format json|text]
  playwright-failure-analyzer models [--format json|text]
  playwright-failure-analyzer --help | --version

Credentials: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, then local login.
CI disables stored-login fallback. Evidence is not automatically redacted.
Exit: 0 complete (possibly with warnings)/no failures, 1 fatal error, 2 partial, 130/143 cancelled.
Optional grouping evidence failure alone is a warning; provisional grouping is retained.
`;

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  let format = "json";
  const controller = new AbortController();
  let signalCode: number | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    signalCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new AnalysisError("ABORTED", `Received ${signal}.`));
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  const redact = (text: string) => {
    for (const token of [
      process.env.COPILOT_GITHUB_TOKEN,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
    ]) {
      if (token) text = text.split(token).join("[REDACTED]");
    }
    return text;
  };
  const emit = (value: unknown) =>
    process.stdout.write(redact(JSON.stringify(value)) + "\n");
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        report: { type: "string" },
        output: { type: "string" },
        "small-model": { type: "string" },
        "big-model": { type: "string" },
        workers: { type: "string" },
        concurrency: { type: "string" },
        "timeout-ms": { type: "string" },
        "max-attempts": { type: "string" },
        context: { type: "string" },
        format: { type: "string", default: "json" },
      },
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name))
        throw new AnalysisError(
          "INVALID_OPTIONS",
          `Repeated option: --${token.name}`,
        );
      seen.add(token.name);
    }
    format = values.format!;
    if (!["json", "text"].includes(format))
      throw new AnalysisError(
        "INVALID_OPTIONS",
        "format must be json or text.",
      );
    if (values.help) {
      process.stdout.write(help);
      return 0;
    }
    if (values.version) {
      process.stdout.write(
        JSON.parse(
          fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
        ).version + "\n",
      );
      return 0;
    }
    if (
      positionals.length !== 1 ||
      !["analyze", "check-access", "models"].includes(positionals[0])
    )
      throw new AnalysisError(
        "INVALID_OPTIONS",
        "Expected analyze, check-access, or models. See --help.",
      );
    const command = positionals[0];
    if (command !== "analyze") {
      if (Object.keys(values).some((name) => !["format"].includes(name)))
        throw new AnalysisError(
          "INVALID_OPTIONS",
          `${command} accepts only --format.`,
        );
      const result =
        command === "models"
          ? await copilotModels(undefined, { signal: controller.signal })
          : await copilotAccessCheck(undefined, { signal: controller.signal });
      if (format === "json") emit({ command, ...result });
      else
        process.stdout.write(
          redact(
            result.ok
              ? "availableModels" in result &&
                Array.isArray(result.availableModels)
                ? result.availableModels.join("\n")
                : "Authenticated (inference not tested)."
              : (result.error ?? "Access check failed."),
          ) + "\n",
        );
      return signalCode ?? (result.ok ? 0 : 1);
    }
    const numeric = (
      name: "workers" | "concurrency" | "timeout-ms" | "max-attempts",
    ) => {
      const text = values[name];
      if (text === undefined) return undefined;
      if (!/^[1-9]\d*$/.test(text))
        throw new AnalysisError(
          "INVALID_OPTIONS",
          `${name} must be a positive integer.`,
        );
      return Number(text);
    };
    let context: AnalysisContext | undefined;
    if (values.context !== undefined) {
      const stat = fs.statSync(values.context);
      if (!stat.isFile() || stat.size > 16 * 1024)
        throw new AnalysisError(
          "INVALID_OPTIONS",
          "Context must be a JSON file no larger than 16 KiB.",
        );
      let input: unknown;
      try {
        input = JSON.parse(fs.readFileSync(values.context, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new AnalysisError(
            "INVALID_OPTIONS",
            "Context must contain valid JSON.",
            { cause: error },
          );
        throw error;
      }
      context = validateAnalysisContext(input);
    }
    const result = await analyzeFailures({
      reportPath: values.report ?? "",
      outputDir: values.output ?? "",
      smallModel: values["small-model"] ?? "",
      bigModel: values["big-model"] ?? "",
      context,
      workers: numeric("workers"),
      concurrency: numeric("concurrency"),
      timeoutMs: numeric("timeout-ms"),
      maxAttempts: numeric("max-attempts"),
      signal: controller.signal,
      onProgress: (event) =>
        process.stderr.write(
          event.phase === "analysis"
            ? `analysis ${event.progress.completed ?? 0}/${event.progress.total}\n`
            : `${event.phase}\n`,
        ),
    });
    if (format === "json") emit(result);
    else process.stdout.write(`${result.status}: ${result.runDir}\n`);
    return (
      signalCode ??
      (result.status === "partial" || result.status === "cancelled"
        ? 2
        : result.status === "failed"
          ? 1
          : 0)
    );
  } catch (error) {
    const body = {
      status: "failed",
      code: error instanceof AnalysisError ? error.code : "ANALYSIS_FAILED",
      message: messageOf(error),
      ...(error instanceof FailureAnalysisError
        ? { result: error.result }
        : {}),
    };
    if (format === "json") emit(body);
    else process.stderr.write(redact(`${body.code}: ${body.message}`) + "\n");
    return (
      signalCode ??
      (error instanceof AnalysisError && error.code === "DEADLINE_EXCEEDED"
        ? 2
        : 1)
    );
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

if (require.main === module) {
  void runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`CLI failed: ${messageOf(error)}\n`);
      process.exitCode = 1;
    },
  );
}
