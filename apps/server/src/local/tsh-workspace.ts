import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export const TSH_WORKSPACE_APP_ENV = "TSH_WORKSPACE_APP";
export const TSH_DEFAULT_PARENT_PATH = "/workspace";
export const TSH_PROJECT_NAME_PREFIX = "canvas";

export function isTshWorkspaceAppHost(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[TSH_WORKSPACE_APP_ENV]?.trim() === "1";
}

/** Resolve a TSH parent path; defaults to `/workspace` on TSH hosts. */
export function resolveTshParentPath(
  input?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isTshWorkspaceAppHost(env)) return null;
  return assertAllowedTshParentPath(input?.trim() || TSH_DEFAULT_PARENT_PATH);
}

/**
 * Stem for TSH directory names. Keeps Unicode letters/numbers so Chinese
 * titles do not collapse into underscores.
 */
export function safeTshFileStem(
  value: string,
  fallback = "untitled",
): string {
  const cleaned = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

export function assertAllowedTshParentPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) throw new Error("Parent path is required");
  if (trimmed.includes("\0")) throw new Error("Parent path is invalid");
  const resolved = resolve(trimmed);
  const root = resolve(TSH_DEFAULT_PARENT_PATH);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error("Parent path must be inside /workspace");
  }
  const blocked = join(root, ".tsh");
  if (resolved === blocked || resolved.startsWith(blocked + sep)) {
    throw new Error("Parent path cannot use /workspace/.tsh");
  }
  return resolved;
}

export function formatTshArtifactDateSlug(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `canvas-YYYY-MM-DD` stem before the conflict index. */
export function formatTshArtifactDatedStem(
  prefix: string = TSH_PROJECT_NAME_PREFIX,
  date: Date = new Date(),
): string {
  return `${prefix}-${formatTshArtifactDateSlug(date)}`;
}

/**
 * Allocate `parent/canvas-YYYY-MM-DD-<n>/`.
 * Import/named: `{preferredStem}/` with `-2`, `-3`, … on conflict.
 */
export function allocateTshProjectRoot(
  parentPath: string,
  options: { now?: Date; preferredStem?: string | null } = {},
): string {
  const parent = assertAllowedTshParentPath(parentPath);
  const preferred = options.preferredStem?.trim();
  if (preferred) {
    return allocateUniquePath(parent, safeTshFileStem(preferred));
  }
  return allocateDatedPath(parent, formatTshArtifactDatedStem(TSH_PROJECT_NAME_PREFIX, options.now));
}

export function tshProjectDisplayTitle(pathValue: string): string {
  return basename(resolve(pathValue.trim()));
}

export function ensureTshProjectRoot(root: string): string {
  const resolved = assertAllowedTshParentPath(root);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function allocateDatedPath(parent: string, datedStem: string): string {
  let index = 1;
  while (true) {
    const candidate = join(parent, `${datedStem}-${index}`);
    if (!existsSync(candidate)) return candidate;
    index += 1;
  }
}

function allocateUniquePath(parent: string, stem: string): string {
  let candidate = join(parent, stem);
  if (!existsSync(candidate)) return candidate;
  let index = 2;
  while (true) {
    candidate = join(parent, `${stem}-${index}`);
    if (!existsSync(candidate)) return candidate;
    index += 1;
  }
}
