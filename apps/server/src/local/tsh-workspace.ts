import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const TSH_WORKSPACE_APP_ENV = "TSH_WORKSPACE_APP";
export const TSH_DEFAULT_PARENT_PATH = "/workspace";

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

/** Allocate `parent/<title-stem>-<id8>/` under /workspace (slide-aligned). */
export function allocateTshProjectRoot(
  parentPath: string,
  title: string,
  projectId: string,
): string {
  const parent = assertAllowedTshParentPath(parentPath);
  const slug = safeTshFileStem(title.trim() || "untitled").slice(0, 48);
  const shortId = projectId.replace(/-/g, "").slice(0, 8) || "project";
  return join(parent, `${slug}-${shortId}`);
}

/** Rename a TSH project root while preserving the trailing short id. */
export function allocateRenamedTshProjectRoot(
  currentRoot: string,
  title: string,
): string {
  const resolved = resolve(currentRoot.trim());
  const parent = dirname(resolved);
  assertAllowedTshParentPath(parent);
  const base = basename(resolved);
  const shortIdMatch = base.match(/-([a-f0-9]{8})$/i);
  const shortId = shortIdMatch?.[1] || "project";
  let stem = title.trim();
  stem = stem.replace(new RegExp(`-${shortId}$`, "i"), "");
  const slug = safeTshFileStem(stem);
  return join(parent, `${slug}-${shortId}`);
}

export function ensureTshProjectRoot(root: string): string {
  const resolved = assertAllowedTshParentPath(root);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}
