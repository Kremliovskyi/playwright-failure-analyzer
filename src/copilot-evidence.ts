export const EVIDENCE_SCHEMA_VERSION = 4;
export const EVIDENCE_FILENAME = "evidence.json";
export const AI_ANALYSIS_FILENAME = "ai-analysis.md";

export type EvidenceConfidence = "high" | "medium" | "low";

export interface FailureEvidenceSource {
  error: string;
  block: string;
}

export interface FailureEvidenceAnalysis {
  summary: string;
  operation: string | null;
  expected: string | null;
  observed: string | null;
  likelyCause: string | null;
  relevantSignals: string[];
  confidence: EvidenceConfidence;
  unknowns: string[];
}

export interface FailureEvidenceIssue {
  blockIndex: number;
  source: FailureEvidenceSource;
  analysis: FailureEvidenceAnalysis;
}

export interface FailureEvidenceAttempt {
  folder: string;
  testTitle: string | null;
  spec: string;
  retryIndex: number;
  status: string;
  outcome: string | null;
}

export interface FailureEvidenceRecord {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  model: string;
  attempt: FailureEvidenceAttempt;
  issues: FailureEvidenceIssue[];
  error?: string;
  warning?: string;
  rawResponse?: string;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const valueType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const analysisSchemaError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return "must be an object";
  const analysis = value as Record<string, unknown>;
  const checks: Array<[string, unknown, boolean, string]> = [
    ["summary", analysis.summary, isString(analysis.summary), "a string"],
    [
      "operation",
      analysis.operation,
      isNullableString(analysis.operation),
      "a string or null",
    ],
    [
      "expected",
      analysis.expected,
      isNullableString(analysis.expected),
      "a string or null",
    ],
    [
      "observed",
      analysis.observed,
      isNullableString(analysis.observed),
      "a string or null",
    ],
    [
      "likelyCause",
      analysis.likelyCause,
      isNullableString(analysis.likelyCause),
      "a string or null",
    ],
    [
      "relevantSignals",
      analysis.relevantSignals,
      isStringArray(analysis.relevantSignals),
      "an array of strings",
    ],
    [
      "unknowns",
      analysis.unknowns,
      isStringArray(analysis.unknowns),
      "an array of strings",
    ],
  ];
  const invalid = checks.find(([, , valid]) => !valid);
  if (invalid)
    return `${invalid[0]} must be ${invalid[3]}; received ${valueType(invalid[1])}`;
  if (
    analysis.confidence !== "high" &&
    analysis.confidence !== "medium" &&
    analysis.confidence !== "low"
  ) {
    return "confidence must be high, medium, or low";
  }
  return null;
};

const firstErrorLine = (block: string): string =>
  block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:Error|TimeoutError|AssertionError):/.test(line)) ||
  block
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ||
  "Unknown error";

export const validateModelEvidenceIssues = (
  value: unknown,
  errorBlocks: string[],
): FailureEvidenceIssue[] => {
  if (!errorBlocks.length)
    throw new Error("error.md contains no fenced error blocks");
  if (typeof value !== "object" || value === null)
    throw new Error("Evidence response is not an object");
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    throw new Error(
      `Evidence response schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`,
    );
  if (!Array.isArray(response.issues))
    throw new Error("Evidence response issues must be an array");
  if (response.issues.length !== errorBlocks.length) {
    throw new Error(
      `Evidence response has ${response.issues.length} issues for ${errorBlocks.length} error.md blocks`,
    );
  }

  return response.issues.map((value, index) => {
    if (typeof value !== "object" || value === null)
      throw new Error(`Evidence issue ${index + 1} must be an object`);
    const issue = value as Record<string, unknown>;
    if (issue.blockIndex !== index + 1)
      throw new Error(`Evidence issue ${index + 1} has wrong blockIndex`);
    const schemaError = analysisSchemaError(issue.analysis);
    if (schemaError)
      throw new Error(`Evidence issue ${index + 1} analysis.${schemaError}`);
    const block = errorBlocks[index];
    return {
      blockIndex: index + 1,
      source: { error: firstErrorLine(block), block },
      analysis: issue.analysis as FailureEvidenceAnalysis,
    };
  });
};

export const buildFallbackEvidenceIssues = (
  errorBlocks: string[],
): FailureEvidenceIssue[] =>
  errorBlocks.map((block, index) => {
    const error = firstErrorLine(block);
    return {
      blockIndex: index + 1,
      source: { error, block },
      analysis: {
        summary: error,
        operation: null,
        expected: null,
        observed: null,
        likelyCause: null,
        relevantSignals: [],
        confidence: "low",
        unknowns: ["Small-model explanation was unavailable."],
      },
    };
  });

export const renderEvidenceJson = (record: FailureEvidenceRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const display = (value: string | null): string => value || "_unknown_";

const renderList = (values: string[]): string =>
  values.length ? values.map((value) => `- ${value}`).join("\n") : "_None_";

export const renderEvidenceMarkdown = (
  record: FailureEvidenceRecord,
): string => {
  const lines = [
    "# AI Analysis",
    "",
    `> Model: \`${record.model}\`; evidence schema: \`${record.schemaVersion}\``,
    "",
  ];

  if (record.error) {
    lines.push("## Error", "", "```", record.error, "```", "");
    if (record.rawResponse)
      lines.push(
        "## Raw response (truncated)",
        "",
        "```",
        record.rawResponse,
        "```",
        "",
      );
    return lines.join("\n");
  }

  if (record.warning) lines.push(`> ${record.warning}`, "");
  lines.push(
    "## Attempt",
    "",
    `- **Test:** ${record.attempt.testTitle || "_unknown_"}`,
    `- **Spec:** ${record.attempt.spec || "_unknown_"}`,
    `- **Retry:** ${record.attempt.retryIndex}`,
    `- **Outcome:** ${record.attempt.outcome}`,
    "",
    "## Issues",
    "",
  );

  for (const issue of record.issues) {
    lines.push(
      `### Issue ${issue.blockIndex}`,
      "",
      `- **Error:** ${issue.source.error}`,
      `- **Operation:** ${display(issue.analysis.operation)}`,
      `- **Expected:** ${display(issue.analysis.expected)}`,
      `- **Observed:** ${display(issue.analysis.observed)}`,
      `- **Confidence:** ${issue.analysis.confidence}`,
      "",
      "**Summary:**",
      "",
      issue.analysis.summary,
      "",
      "**Likely cause:**",
      "",
      display(issue.analysis.likelyCause),
      "",
      "**Relevant signals:**",
      "",
      renderList(issue.analysis.relevantSignals),
      "",
      "**Unknowns:**",
      "",
      renderList(issue.analysis.unknowns),
      "",
      "**Source block:**",
      "",
      "```",
      issue.source.block,
      "```",
      "",
    );
  }

  return lines.join("\n");
};
