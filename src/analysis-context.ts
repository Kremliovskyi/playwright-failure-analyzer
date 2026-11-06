import { AnalysisError } from "./shared";

export type AnalysisSource =
  | { kind: "cli" }
  | {
      kind: "github-actions";
      repository?: string;
      runId?: string;
      runAttempt?: number;
      commit?: string;
      reportArtifactId?: string;
    }
  | {
      kind: "playwright-reports";
      reportUuid: string;
      reportName?: string;
    };

export interface AnalysisContext {
  source?: AnalysisSource;
  environment?: string;
  region?: string;
}

function contextObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AnalysisError("INVALID_OPTIONS", `${label} must be an object.`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new AnalysisError(
      "INVALID_OPTIONS",
      `${label} contains unsupported fields.`,
    );
  return value as Record<string, unknown>;
}

function contextString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new AnalysisError(
      "INVALID_OPTIONS",
      `${label} must be a nonempty string of at most 1024 characters without control characters.`,
    );
  return value;
}

export function validateAnalysisContext(value: unknown): AnalysisContext & {
  source: AnalysisSource;
} {
  const data = contextObject(value, "Analysis context", [
    "source",
    "environment",
    "region",
  ]);
  let source: AnalysisSource = { kind: "cli" };
  if (data.source !== undefined) {
    const input = contextObject(data.source, "Analysis source", [
      "kind",
      "repository",
      "runId",
      "runAttempt",
      "commit",
      "reportArtifactId",
      "reportUuid",
      "reportName",
    ]);
    switch (input.kind) {
      case "cli":
        contextObject(input, "CLI source", ["kind"]);
        break;
      case "github-actions": {
        const strings = [
          "repository",
          "runId",
          "commit",
          "reportArtifactId",
        ] as const;
        contextObject(input, "GitHub Actions source", [
          "kind",
          ...strings,
          "runAttempt",
        ]);
        source = { kind: "github-actions" };
        for (const key of strings) {
          if (input[key] !== undefined)
            source[key] = contextString(input[key], `source.${key}`);
        }
        if (input.runAttempt !== undefined) {
          if (
            typeof input.runAttempt !== "number" ||
            !Number.isSafeInteger(input.runAttempt) ||
            input.runAttempt < 1
          )
            throw new AnalysisError(
              "INVALID_OPTIONS",
              "source.runAttempt must be a positive safe integer.",
            );
          source.runAttempt = input.runAttempt;
        }
        break;
      }
      case "playwright-reports":
        contextObject(input, "Playwright Reports source", [
          "kind",
          "reportUuid",
          "reportName",
        ]);
        source = {
          kind: "playwright-reports",
          reportUuid: contextString(input.reportUuid, "source.reportUuid"),
        };
        if (input.reportName !== undefined)
          source.reportName = contextString(
            input.reportName,
            "source.reportName",
          );
        break;
      default:
        throw new AnalysisError(
          "INVALID_OPTIONS",
          "source.kind must be cli, github-actions, or playwright-reports.",
        );
    }
  }
  const context: AnalysisContext & { source: AnalysisSource } = { source };
  for (const key of ["environment", "region"] as const) {
    if (data[key] !== undefined) context[key] = contextString(data[key], key);
  }
  return context;
}
