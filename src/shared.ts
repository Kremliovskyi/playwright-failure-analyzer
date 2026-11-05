import fs from "node:fs";
import path from "node:path";

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AnalysisError";
  }
}

export function positiveInteger(
  value: number,
  label: string,
  max = 2 ** 31 - 1,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new AnalysisError(
      "INVALID_OPTIONS",
      `${label} must be an integer from 1 to ${max}.`,
    );
  return value;
}

export function objectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AnalysisError("INVALID_INPUT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function resolveWithin(
  rootDir: string,
  relativePath: string,
  label: string,
): string {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath)
  )
    throw new AnalysisError("UNSAFE_PATH", `${label} must be a relative path.`);
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate))
    throw new AnalysisError(
      "UNSAFE_PATH",
      `${label} resolves outside its allowed directory`,
    );
  // Check every existing component, including dangling links and parent junctions.
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new AnalysisError(
          "UNSAFE_PATH",
          `${label} contains a symbolic link.`,
        );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  return candidate;
}

export function writeNewFile(
  root: string,
  name: string,
  content: string,
): void {
  fs.writeFileSync(resolveWithin(root, name, "Output file"), content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new AnalysisError("ABORTED", "Analysis was cancelled.");
}

export async function withCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let primary: unknown;
  try {
    return await action();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (primary !== undefined)
        throw new AggregateError(
          [primary, error],
          `${messageOf(primary)}; cleanup failed: ${messageOf(error)}`,
        );
      throw error;
    }
  }
}
