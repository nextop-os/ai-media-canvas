import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProcessInvocation } from "@tutti-os/agent-acp-kit/process-adapter";

import {
  type AgentDiscoveryRuntime,
  resolveCodexAgentTarget,
} from "../../agent/agent-targets.js";

export const MIN_CODEX_IMAGEGEN_VERSION = "0.124.0";
const DEFAULT_CACHE_TTL_MS = 30_000;

export type CodexImagegenUnavailableReason =
  | "disabled"
  | "agent_target_unavailable"
  | "codex_not_found"
  | "codex_version_too_old"
  | "codex_not_logged_in"
  | "full_auto_unavailable"
  | "image_generation_unavailable"
  | "fast_mode_unavailable"
  | "probe_failed";

export interface CodexImagegenCapability {
  ready: boolean;
  reasons: CodexImagegenUnavailableReason[];
  detail?: string;
  codexPath?: string;
  codexVersion?: string;
  codexHome?: string;
  checkedAt: string;
}

export type CodexImagegenCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => string;

export type CodexImagegenFileExists = (path: string) => boolean;
export type CodexImagegenFileReader = (path: string) => string;

export interface CodexImagegenCapabilityOptions {
  enabled: boolean;
  codexPath?: string;
  codexHome?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runCommand?: CodexImagegenCommandRunner;
  fileExists?: CodexImagegenFileExists;
  readFile?: CodexImagegenFileReader;
}

type CacheEntry = {
  key: string;
  expiresAt: number;
  capability: CodexImagegenCapability;
};

let cachedCapability: CacheEntry | undefined;

export function clearCodexImagegenCapabilityCache() {
  cachedCapability = undefined;
}

export function detectCodexImagegenCapability(
  options: CodexImagegenCapabilityOptions,
): CodexImagegenCapability {
  const now = options.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const codexPath = options.codexPath ?? "codex";
  const codexHome =
    options.codexHome ?? options.env?.CODEX_HOME ?? join(homedir(), ".codex");
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheKey = JSON.stringify({
    enabled: options.enabled,
    codexPath,
    codexHome,
    timeoutMs,
  });

  if (
    cachedCapability &&
    cachedCapability.key === cacheKey &&
    cachedCapability.expiresAt > now.getTime()
  ) {
    return cachedCapability.capability;
  }

  const capability = options.enabled
    ? probeCodexImagegenCapability({
        checkedAt,
        codexPath,
        codexHome,
        timeoutMs,
        env: { ...process.env, ...options.env, CODEX_HOME: codexHome },
        runCommand: options.runCommand ?? defaultRunCommand,
        fileExists: options.fileExists ?? existsSync,
        readFile: options.readFile ?? defaultReadFile,
      })
    : {
        ready: false,
        reasons: ["disabled" as const],
        codexPath,
        codexHome,
        checkedAt,
      };

  cachedCapability = {
    key: cacheKey,
    expiresAt: now.getTime() + cacheTtlMs,
    capability,
  };
  return capability;
}

export async function detectConfiguredCodexImagegenCapability(options: {
  enabled: boolean;
  codexHome?: string;
  tuttiCliPath?: string;
  timeoutMs?: number;
  runtime?: AgentDiscoveryRuntime;
}): Promise<CodexImagegenCapability> {
  if (!options.enabled) {
    return detectCodexImagegenCapability({ enabled: false });
  }
  try {
    const codexPath = await resolveConfiguredCodexImagegenCommand(options);
    return detectCodexImagegenCapability({
      enabled: true,
      codexPath,
      ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    return {
      ready: false,
      reasons: ["agent_target_unavailable"],
      detail:
        error instanceof Error
          ? error.message
          : "Configured Codex Agent Target is unavailable.",
      ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function resolveConfiguredCodexImagegenCommand(options: {
  tuttiCliPath?: string;
  runtime?: AgentDiscoveryRuntime;
}): Promise<string> {
  const target = await resolveCodexAgentTarget({
    ...(options.tuttiCliPath
      ? { detectContext: { env: { TUTTI_CLI: options.tuttiCliPath } } }
      : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  return target.executablePath ?? "codex";
}

function probeCodexImagegenCapability(options: {
  checkedAt: string;
  codexPath: string;
  codexHome: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  runCommand: CodexImagegenCommandRunner;
  fileExists: CodexImagegenFileExists;
  readFile: CodexImagegenFileReader;
}): CodexImagegenCapability {
  const reasons: CodexImagegenUnavailableReason[] = [];
  let codexVersion: string | undefined;

  try {
    const versionOutput = options.runCommand(options.codexPath, ["--version"], {
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
    codexVersion = parseCodexVersion(versionOutput);
    if (
      !codexVersion ||
      compareSemver(codexVersion, MIN_CODEX_IMAGEGEN_VERSION) < 0
    ) {
      reasons.push("codex_version_too_old");
    }
  } catch {
    reasons.push("codex_not_found");
  }

  if (!reasons.includes("codex_not_found")) {
    const authPath = join(options.codexHome, "auth.json");
    if (
      !hasUsableCodexAuth(
        authPath,
        options.env,
        options.fileExists,
        options.readFile,
      )
    ) {
      reasons.push("codex_not_logged_in");
    }

    try {
      options.runCommand(
        options.codexPath,
        [
          "exec",
          "--ignore-user-config",
          "--sandbox",
          "workspace-write",
          "--help",
        ],
        {
          timeoutMs: options.timeoutMs,
          env: options.env,
        },
      );
    } catch {
      reasons.push("full_auto_unavailable");
    }

    try {
      const features = options.runCommand(
        options.codexPath,
        ["features", "list"],
        {
          timeoutMs: options.timeoutMs,
          env: options.env,
        },
      );
      if (!hasCodexFeature(features, "image_generation")) {
        reasons.push("image_generation_unavailable");
      }
      if (!hasCodexFeature(features, "fast_mode")) {
        reasons.push("fast_mode_unavailable");
      }
    } catch {
      reasons.push("image_generation_unavailable", "fast_mode_unavailable");
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    codexPath: options.codexPath,
    ...(codexVersion ? { codexVersion } : {}),
    codexHome: options.codexHome,
    checkedAt: options.checkedAt,
  };
}

function hasCodexFeature(output: string, feature: string) {
  return output
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === feature);
}

function hasUsableCodexAuth(
  authPath: string,
  env: NodeJS.ProcessEnv,
  fileExists: CodexImagegenFileExists,
  readFile: CodexImagegenFileReader,
) {
  if (hasNonEmptyString(env.OPENAI_API_KEY)) return true;
  if (!fileExists(authPath)) return false;

  try {
    const parsed = JSON.parse(readFile(authPath)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const auth = parsed as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown; refresh_token?: unknown };
    };
    return (
      hasNonEmptyString(auth.OPENAI_API_KEY) ||
      hasNonEmptyString(auth.tokens?.access_token) ||
      hasNonEmptyString(auth.tokens?.refresh_token)
    );
  } catch {
    return false;
  }
}

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultReadFile(path: string) {
  return readFileSync(path, "utf8");
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) {
  const invocation = resolveProcessInvocation({
    command,
    args,
    env: options.env,
  });
  return execFileSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
}

export function parseCodexVersion(output: string): string | undefined {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1];
}

export function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));

  for (let i = 0; i < 3; i += 1) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
