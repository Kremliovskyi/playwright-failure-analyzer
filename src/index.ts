export {
  analyzeFailures,
  FailureAnalysisError,
  renderSummary,
  ANALYSIS_RESULT_FILENAME,
  ANALYSIS_RESULT_SCHEMA_VERSION,
  SUMMARY_FILENAME,
} from "./analysis";
export type {
  AnalysisOptions,
  AnalysisProgress,
  AnalysisResult,
} from "./analysis";
export {
  analyzeRun,
  withCopilotAnalysisClient,
  copilotAccessCheck,
  copilotModels,
  isAnalyzableEntry,
  CopilotAnalysisError,
} from "./copilot-analyzer";
export type {
  FailureManifest,
  FailureManifestEntry,
  AnalyzeRunOptions,
  AnalyzeRunResult,
  AnalyzeRunSummary,
  AnalyzeProgress,
  CopilotAnalysisModels,
  CopilotAccessResult,
  CopilotModelsResult,
  TokenUsage,
} from "./copilot-analyzer";
export {
  groupRun,
  GroupingRunError,
  GROUPED_ANALYSIS_FILENAME,
  renderGroupedAnalysis,
  parseGroupingResponse,
  validateGroupingResponse,
} from "./copilot-grouper";
export type {
  GroupRunResult,
  GroupingDiagnostics,
  GroupingResponse,
} from "./copilot-grouper";
export * from "./copilot-evidence";
export type {
  AnalysisClient,
  AnalysisSession,
  AuthenticationOptions,
} from "./copilot-client";
export { validateManifest, measureCoverage } from "./reader";
export type { Coverage } from "./reader";
export { AnalysisError } from "./shared";
