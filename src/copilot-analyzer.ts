import fs from "fs";
import path from "path";
import type { writeFailureDigests } from "@andrii_kremlovskyi/playwright-traces-reader";
import {
  AnalysisClient,
  AuthenticationOptions,
  evidenceSessionConfig,
  usingClient,
} from "./copilot-client";
import {
  assertNotAborted,
  positiveInteger,
  resolveWithin,
  withCleanup,
  writeNewFile,
} from "./shared";
import {
  AI_ANALYSIS_FILENAME,
  EVIDENCE_FILENAME,
  EVIDENCE_SCHEMA_VERSION,
  FailureEvidenceAttempt,
  FailureEvidenceIssue,
  FailureEvidenceRecord,
  buildFallbackEvidenceIssues,
  renderEvidenceJson,
  renderEvidenceMarkdown,
  validateModelEvidenceIssues,
} from "./copilot-evidence";

export {
  AI_ANALYSIS_FILENAME,
  EVIDENCE_FILENAME,
  EVIDENCE_SCHEMA_VERSION,
} from "./copilot-evidence";

// Per-trace timeout for the assistant response (ms).
const PER_TRACE_TIMEOUT_MS = 180000;

// Number of failure folders analyzed concurrently. Each folder is fully isolated
// (own input files, own Copilot session, own evidence artifacts), so they never interfere.
const ANALYSIS_CONCURRENCY = 3;

// --- Types ---------------------------------------------------------------

type ReaderManifest = Awaited<ReturnType<typeof writeFailureDigests>>;
type ReaderEntry = ReaderManifest["failures"][number];
export type FailureManifestEntry = Pick<
  ReaderEntry,
  "folder" | "testTitle" | "title" | "retryIndex" | "status" | "outcome"
> &
  Partial<
    Omit<
      ReaderEntry,
      "folder" | "testTitle" | "title" | "retryIndex" | "status" | "outcome"
    >
  >;

export interface FailureManifest {
  count: number;
  runDir: string;
  failures: FailureManifestEntry[];
}

export type UnderstandingRecord = FailureEvidenceRecord;

export interface AnalyzeRunSummary {
  total: number;
  analyzed: number;
  failed: number;
  skipped: number;
  omitted: number;
  analysisFileName: string;
}

export interface AnalyzeRunResult extends AnalyzeRunSummary {
  records: FailureEvidenceRecord[];
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AnalyzeProgress {
  index: number;
  total: number;
  // Monotonic count of folders that have finished (done or error). Drives the
  // UI "Analyzing X/total" label so it advances steadily under concurrency.
  completed?: number;
  folder: string;
  testTitle: string | null;
  status: "start" | "done" | "error";
  message?: string;
}

export interface CopilotAccessResult {
  ok: boolean;
  authenticated: boolean;
  login?: string;
  authType?: string;
  host?: string;
  error?: string;
}

export interface CopilotModelsResult extends CopilotAccessResult {
  availableModels: string[];
}

export interface CopilotAnalysisModels {
  smallModel: string;
  bigModel: string;
}

export type CopilotAnalysisErrorCode =
  | "COPILOT_NOT_AUTHENTICATED"
  | "COPILOT_NO_MODELS"
  | "COPILOT_MODEL_UNAVAILABLE";

export class CopilotAnalysisError extends Error {
  constructor(
    readonly code: CopilotAnalysisErrorCode,
    message: string,
    readonly model: string,
    readonly modelRole?: "small" | "big",
  ) {
    super(message);
    this.name = "CopilotAnalysisError";
  }
}

// --- Filtering -----------------------------------------------------------

// Before Hooks / skipped attempts are not real failures and must be omitted.
export const isAnalyzableEntry = (entry: FailureManifestEntry): boolean =>
  entry.testTitle !== null &&
  entry.outcome !== "skipped" &&
  entry.title !== "Before Hooks";

export const renderAiAnalysisMarkdown = renderEvidenceMarkdown;

// --- Preflight -----------------------------------------------------------

const NOT_AUTHENTICATED_MESSAGE =
  "Copilot is not authenticated. Sign in locally or provide a Copilot-compatible token.";

export const withCopilotAnalysisClient = async <T>(
  models: CopilotAnalysisModels,
  token: string | undefined,
  callback: (client: AnalysisClient) => Promise<T>,
  options: { signal?: AbortSignal; allowStoredLogin?: boolean } = {},
): Promise<T> => {
  return usingClient(
    { token, allowStoredLogin: options.allowStoredLogin },
    async (client, sdk) => {
      const auth = await sdk.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new CopilotAnalysisError(
          "COPILOT_NOT_AUTHENTICATED",
          NOT_AUTHENTICATED_MESSAGE,
          "",
        );
      }

      const availableModels = (await sdk.listModels()).map((item) => item.id);
      if (!availableModels.length) {
        throw new CopilotAnalysisError(
          "COPILOT_NO_MODELS",
          "No Copilot models are available for this account.",
          "",
        );
      }

      const selections: Array<{
        role: "small" | "big";
        label: string;
        model: string;
      }> = [
        { role: "small", label: "Small model", model: models.smallModel },
        { role: "big", label: "Big model", model: models.bigModel },
      ];
      for (const selection of selections) {
        if (!selection.model || !availableModels.includes(selection.model)) {
          const message = selection.model
            ? `${selection.label} "${selection.model}" is not available. Select an available model.`
            : `${selection.label} is not selected.`;
          throw new CopilotAnalysisError(
            "COPILOT_MODEL_UNAVAILABLE",
            message,
            selection.model,
            selection.role,
          );
        }
      }

      return callback(client);
    },
    options.signal,
  );
};

// Verify that Copilot is accessible. The header status chip calls this without
// listing or selecting models, so checking access can never mutate config.
export const copilotAccessCheck = async (
  token?: string,
  options: Omit<AuthenticationOptions, "token"> & { signal?: AbortSignal } = {},
): Promise<CopilotAccessResult> => {
  try {
    return await usingClient(
      { token, allowStoredLogin: options.allowStoredLogin },
      async (_client, sdk) => {
        const auth = await sdk.getAuthStatus();
        return {
          ok: auth.isAuthenticated,
          authenticated: auth.isAuthenticated,
          login: auth.login,
          authType: auth.authType,
          host: auth.host,
          error: auth.isAuthenticated ? undefined : NOT_AUTHENTICATED_MESSAGE,
        };
      },
      options.signal,
    );
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// List models only when Preferences opens a model picker.
export const copilotModels = async (
  token?: string,
  options: Omit<AuthenticationOptions, "token"> & { signal?: AbortSignal } = {},
): Promise<CopilotModelsResult> => {
  try {
    return await usingClient(
      { token, allowStoredLogin: options.allowStoredLogin },
      async (_client, sdk) => {
        const auth = await sdk.getAuthStatus();
        if (!auth.isAuthenticated) {
          return {
            ok: false,
            authenticated: false,
            availableModels: [],
            error: NOT_AUTHENTICATED_MESSAGE,
          };
        }
        const availableModels = (await sdk.listModels()).map((item) => item.id);
        return {
          ok: availableModels.length > 0,
          authenticated: true,
          login: auth.login,
          authType: auth.authType,
          host: auth.host,
          availableModels,
          error: availableModels.length
            ? undefined
            : "No Copilot models are available for this account.",
        };
      },
      options.signal,
    );
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      availableModels: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// --- Prompt --------------------------------------------------------------

export const errorDetailBlocks = (errorMd: string): string[] => {
  const heading = errorMd.match(/^# Error details\s*$/m);
  if (!heading?.index && heading?.index !== 0) return [];
  const sectionStart = heading.index + heading[0].length;
  const remainder = errorMd.slice(sectionStart);
  const nextHeading = remainder.search(/^# (?:Page snapshot|Test source)\s*$/m);
  const section =
    nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
  return [...section.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)].map(
    (match) => match[1].trim(),
  );
};

const failureMetadata = (failureJsonText: string): string => {
  const failure = JSON.parse(failureJsonText) as Record<string, unknown>;
  const sanitizeStep = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const step = value as Record<string, unknown>;
    const { error, children, ...metadata } = step;
    return {
      ...metadata,
      result: error
        ? "failed"
        : typeof step.endTime === "number"
          ? "passed"
          : "incomplete",
      children: Array.isArray(children) ? children.map(sanitizeStep) : [],
    };
  };
  return JSON.stringify(
    {
      schemaVersion: failure.schemaVersion,
      testTitle: failure.testTitle,
      title: failure.title,
      status: failure.status,
      outcome: failure.outcome,
      durationMs: failure.durationMs,
      retryIndex: failure.retryIndex,
      traceSha1: failure.traceSha1,
      topLevelSteps: Array.isArray(failure.topLevelSteps)
        ? failure.topLevelSteps.map(sanitizeStep)
        : [],
      screenshots: failure.screenshots,
      files: failure.files,
    },
    null,
    2,
  );
};

const buildPrompt = (
  folderName: string,
  errorMd: string,
  failureJsonText: string,
  networkErrorsText: string | null,
): string => {
  const errorBlocks = errorDetailBlocks(errorMd);
  const expectedIssueCount = errorBlocks.length;
  const networkSection = networkErrorsText
    ? `\n## network-errors.json (failed/relevant requests)\n\`\`\`json\n${networkErrorsText}\n\`\`\`\n`
    : "\n## network-errors.json\n(none)\n";

  return `Explain the issues from ONE failed Playwright test attempt. Work only from the supplied evidence and do not invent facts.

The numbered error blocks are the exclusive issue list. Return exactly ${expectedIssueCount} issue entr${expectedIssueCount === 1 ? "y" : "ies"}, one per block and in the same order. Treat every block as an issue in its own right. Do not decide whether an issue is transient, terminal, primary, downstream, or related to another issue.

Failure metadata and network errors are supporting context only. They may help explain an issue, but they must not create additional issues. Keep each explanation specific to its numbered block.

For each issue:
- summary: briefly state what failed.
- operation: state the attempted action or assertion, or null.
- expected and observed: concise issue-local descriptions, or null when unsupported.
- likelyCause: include only a cause directly supported by the supplied evidence; otherwise null.
- relevantSignals: concise concrete facts useful for comparing this issue with issues from other tests. Do not create synthetic categories or keys.
- unknowns: important missing information that prevents a stronger explanation.

## Folder name
${folderName}

## error.md
The issue blocks are the fenced blocks under "# Error details", in source order.
\`\`\`md
${errorMd}
\`\`\`

## Failure metadata
\`\`\`json
${failureMetadata(failureJsonText)}
\`\`\`
${networkSection}
## Output
Return exactly this JSON object and nothing else:
{
  "schemaVersion": ${EVIDENCE_SCHEMA_VERSION},
  "issues": [
    {
      "blockIndex": 1,
      "analysis": {
        "summary": "<what failed>",
        "operation": "<attempted action or assertion, or null>",
        "expected": "<expected behavior or value, or null>",
        "observed": "<observed behavior or value, or null>",
        "likelyCause": "<directly supported cause, or null>",
        "relevantSignals": ["<concise concrete fact>"],
        "confidence": "<'high' | 'medium' | 'low'>",
        "unknowns": ["<missing information>"]
      }
    }
  ]
}

Rules:
- Keep exactly ${expectedIssueCount} issues in block order; blockIndex is 1-based.
- Do not return source blocks; the application attaches the exact originals.
- Do not classify issue relationships, lifecycle, workflow state, product, or failure family.
- Do not infer a cause from a later page merely because the test continued.
- Return ONLY the JSON object, with no surrounding text or code fences.`;
};

// --- JSON extraction / validation ---------------------------------------

const extractJson = (text: string): unknown => {
  let candidate = text.trim();

  // Strip a fenced ```json ... ``` or ``` ... ``` block if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Fall back to the first {...} span.
  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in response");
    }
    candidate = candidate.slice(start, end + 1);
  }

  return JSON.parse(candidate);
};

const buildCorrectionPrompt = (
  error: unknown,
  expectedIssueCount: number,
): string => `Your previous evidence JSON was rejected by deterministic validation:
${error instanceof Error ? error.message : String(error)}

Return the complete corrected schema ${EVIDENCE_SCHEMA_VERSION} JSON object, not a patch. Return JSON only.

Correction rules:
- Keep exactly ${expectedIssueCount} issues in source-block order.
- Each issue contains only blockIndex and analysis.
- analysis contains summary, operation, expected, observed, likelyCause, relevantSignals, confidence, and unknowns.
- Use null and empty arrays when evidence does not support a value.`;

// --- Per-folder analysis -------------------------------------------------

const readIfExists = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) return null;
  if (fs.statSync(filePath).size > 4 * 1024 * 1024)
    throw new Error("Attempt evidence file exceeds 4 MiB.");
  return fs.readFileSync(filePath, "utf8");
};

const analyzeFolder = async (
  client: AnalysisClient,
  runDir: string,
  entry: FailureManifestEntry,
  model: string,
  signal?: AbortSignal,
  onUsage?: (usage: TokenUsage) => void,
): Promise<FailureEvidenceRecord> => {
  const folderPath = resolveWithin(runDir, entry.folder, "Failure folder");
  const failureJsonText = readIfExists(
    resolveWithin(folderPath, "failure.json", "Failure metadata file"),
  );
  if (!failureJsonText) throw new Error("failure.json is missing or empty.");
  const failureJson = JSON.parse(failureJsonText) as Record<string, unknown>;

  const files =
    (failureJson.files as Record<string, string | null> | undefined) || {};
  const errorMd =
    readIfExists(
      resolveWithin(folderPath, "error.md", "Error evidence file"),
    ) || "";
  const networkErrorsText = files.networkErrors
    ? readIfExists(
        resolveWithin(folderPath, files.networkErrors, "Network evidence file"),
      )
    : null;

  const errorBlocks = errorDetailBlocks(errorMd);
  const prompt = buildPrompt(
    entry.folder,
    errorMd,
    failureJsonText,
    networkErrorsText,
  );
  const failureTitle = failureJson.testTitle;
  const attempt: FailureEvidenceAttempt = {
    folder: entry.folder,
    testTitle: entry.testTitle,
    spec:
      typeof failureTitle === "string"
        ? failureTitle.match(/^(.+\.(?:spec|test)\.[cm]?[jt]sx?:\d+)/)?.[1] ||
          ""
        : "",
    retryIndex: entry.retryIndex,
    status: entry.status,
    outcome: entry.outcome,
  };
  if (!errorBlocks.length) {
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      model,
      attempt,
      issues: [],
      error: "error.md contains no fenced error blocks",
    };
  }

  assertNotAborted(signal);
  const session = await client.createSession(evidenceSessionConfig(model));
  const unsubscribe = session.on?.((event) => {
    if (event.type === "assistant.usage") onUsage?.(event.data);
  });
  return withCleanup(
    async () => {
      assertNotAborted(signal);
      let result = await session.sendAndWait({ prompt }, PER_TRACE_TIMEOUT_MS);
      let content = result?.data?.content ?? "";
      let issues: FailureEvidenceIssue[];
      try {
        issues = validateModelEvidenceIssues(extractJson(content), errorBlocks);
      } catch (initialError) {
        assertNotAborted(signal);
        result = await session.sendAndWait(
          { prompt: buildCorrectionPrompt(initialError, errorBlocks.length) },
          PER_TRACE_TIMEOUT_MS,
        );
        content = result?.data?.content ?? "";
        try {
          issues = validateModelEvidenceIssues(
            extractJson(content),
            errorBlocks,
          );
        } catch (correctionError) {
          return {
            schemaVersion: EVIDENCE_SCHEMA_VERSION,
            model,
            attempt,
            issues: buildFallbackEvidenceIssues(errorBlocks),
            warning: `Small-model explanation unavailable after correction; source blocks retained. ${correctionError instanceof Error ? correctionError.message : String(correctionError)}`,
            rawResponse: content.slice(0, 4000),
          };
        }
      }

      return {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        model,
        attempt,
        issues,
      };
    },
    async () => {
      unsubscribe?.();
      await session.disconnect();
    },
  );
};

const writeEvidenceArtifacts = (
  runDir: string,
  folder: string,
  record: FailureEvidenceRecord,
): void => {
  const folderPath = resolveWithin(runDir, folder, "Failure folder");
  writeNewFile(folderPath, EVIDENCE_FILENAME, renderEvidenceJson(record));
  writeNewFile(
    folderPath,
    AI_ANALYSIS_FILENAME,
    renderEvidenceMarkdown(record),
  );
};

// --- Run-level orchestration --------------------------------------------

export interface AnalyzeRunOptions {
  signal?: AbortSignal;
  concurrency?: number;
  maxAttempts?: number;
}

export const analyzeRun = async (
  client: AnalysisClient,
  runDir: string,
  manifest: FailureManifest,
  model: string,
  onProgress?: (p: AnalyzeProgress) => void,
  options: AnalyzeRunOptions = {},
): Promise<AnalyzeRunResult> => {
  const concurrency = positiveInteger(
    options.concurrency ?? ANALYSIS_CONCURRENCY,
    "concurrency",
  );
  const candidates = manifest.failures.filter(isAnalyzableEntry);
  const entries =
    options.maxAttempts === undefined
      ? candidates
      : candidates.slice(
          0,
          positiveInteger(options.maxAttempts, "maxAttempts"),
        );
  const skipped = manifest.failures.length - candidates.length;
  const total = entries.length;
  const seenFolders = new Set<string>();
  for (const entry of entries) {
    const folder = resolveWithin(runDir, entry.folder, "Failure folder");
    const identity =
      process.platform === "win32" ? folder.toLowerCase() : folder;
    if (seenFolders.has(identity)) throw new Error("Duplicate failure folder.");
    seenFolders.add(identity);
    for (const name of [EVIDENCE_FILENAME, AI_ANALYSIS_FILENAME]) {
      if (fs.existsSync(resolveWithin(folder, name, "Analysis output")))
        throw new Error(`Analysis already exists: ${entry.folder}/${name}`);
    }
  }

  let analyzed = 0;
  let failed = 0;
  const usage: TokenUsage = {};
  const records: FailureEvidenceRecord[] = new Array(total);

  // Monotonic count of folders that have finished (done or error). Incremented
  // synchronously when a task completes, so the UI label advances steadily even
  // though tasks finish out of order under concurrency.
  let completed = 0;

  // Process a single failure folder in full isolation: own input files, own
  // Copilot session and evidence files. Source/model errors become records;
  // output errors remain fatal rather than hiding a failed artifact write.
  const processEntry = async (
    entry: FailureManifestEntry,
    index: number,
  ): Promise<void> => {
    onProgress?.({
      index,
      total,
      folder: entry.folder,
      testTitle: entry.testTitle,
      status: "start",
    });
    try {
      const record = await analyzeFolder(
        client,
        runDir,
        entry,
        model,
        options.signal,
        (event) => {
          for (const key of ["inputTokens", "outputTokens"] as const) {
            if (typeof event[key] === "number")
              usage[key] = (usage[key] ?? 0) + event[key];
          }
        },
      );
      records[index - 1] = record;
      writeEvidenceArtifacts(runDir, entry.folder, record);
      if (record.error) {
        failed++;
        onProgress?.({
          index,
          total,
          completed: ++completed,
          folder: entry.folder,
          testTitle: entry.testTitle,
          status: "error",
          message: record.error,
        });
      } else {
        analyzed++;
        onProgress?.({
          index,
          total,
          completed: ++completed,
          folder: entry.folder,
          testTitle: entry.testTitle,
          status: "done",
        });
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const errorRecord: FailureEvidenceRecord = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        model,
        attempt: {
          folder: entry.folder,
          testTitle: entry.testTitle,
          spec: "",
          retryIndex: entry.retryIndex,
          status: entry.status,
          outcome: entry.outcome,
        },
        issues: [],
        error: message,
      };
      records[index - 1] = errorRecord;
      const folder = resolveWithin(runDir, entry.folder, "Failure folder");
      if (
        !fs.existsSync(
          resolveWithin(folder, EVIDENCE_FILENAME, "Evidence output"),
        )
      )
        writeEvidenceArtifacts(runDir, entry.folder, errorRecord);
      else throw err;
      onProgress?.({
        index,
        total,
        completed: ++completed,
        folder: entry.folder,
        testTitle: entry.testTitle,
        status: "error",
        message,
      });
    }
  };

  // Bounded worker pool: a shared cursor hands out the next entry to each of the
  // ANALYSIS_CONCURRENCY workers, which pull-and-process until the queue drains.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      if (options.signal?.aborted) break;
      const i = cursor++;
      await processEntry(entries[i], i + 1);
    }
  };
  const workerCount = Math.min(concurrency, entries.length);
  const workers = await Promise.allSettled(
    Array.from({ length: workerCount }, () => worker()),
  );
  const errors = workers.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (errors.length)
    throw new AggregateError(
      errors.map((item) => item.reason),
      "Could not persist attempt analysis.",
    );

  // Each analyzable failure folder now holds canonical evidence.json and its
  // deterministic ai-analysis.md view next to error.md. index.json is untouched.
  return {
    total,
    analyzed,
    failed,
    skipped,
    omitted: candidates.length - records.filter(Boolean).length,
    analysisFileName: AI_ANALYSIS_FILENAME,
    records: records.filter(Boolean),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
};
