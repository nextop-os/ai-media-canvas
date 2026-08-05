import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  type CodexImagegenCommandRunner,
  clearCodexImagegenCapabilityCache,
  compareSemver,
  detectCodexImagegenCapability,
  detectConfiguredCodexImagegenCapability,
  parseCodexVersion,
} from "./codex-imagegen-capability.js";

const CODEX_IMAGEGEN_FEATURES = [
  "image_generation stable true",
  "fast_mode stable true",
].join("\n");

afterEach(() => {
  clearCodexImagegenCapabilityCache();
});

describe("detectCodexImagegenCapability", () => {
  it("reports disabled without probing Codex", () => {
    let calls = 0;
    const capability = detectCodexImagegenCapability({
      enabled: false,
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      runCommand: () => {
        calls += 1;
        return "";
      },
      fileExists: () => true,
    });

    expect(calls).toBe(0);
    expect(capability).toMatchObject({
      ready: false,
      reasons: ["disabled"],
      checkedAt: "2026-06-15T00:00:00.000Z",
    });
  });

  it("reports missing Codex CLI", () => {
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      runCommand: () => {
        throw new Error("not found");
      },
      fileExists: () => true,
    });

    expect(capability.ready).toBe(false);
    expect(capability.reasons).toContain("codex_not_found");
  });

  it("reports old Codex versions and auth failures", () => {
    const runCommand: CodexImagegenCommandRunner = (_command, args) => {
      if (args.join(" ") === "--version") return "codex 0.123.0";
      if (args.join(" ") === "features list") return CODEX_IMAGEGEN_FEATURES;
      return "ok";
    };

    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      runCommand,
      fileExists: () => false,
    });

    expect(capability).toMatchObject({
      ready: false,
      codexVersion: "0.123.0",
      reasons: ["codex_version_too_old", "codex_not_logged_in"],
    });
  });

  it("reports ready when all probes pass", () => {
    const codexHome = join("tmp", "codex-home");
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome,
      runCommand: createReadyRunner(),
      fileExists: (path) => path === join(codexHome, "auth.json"),
      readFile: () =>
        JSON.stringify({ tokens: { access_token: "access-token" } }),
    });

    expect(capability).toMatchObject({
      ready: true,
      reasons: [],
      codexVersion: "0.124.0",
      codexHome,
    });
  });

  it("accepts API key auth stored in Codex auth.json", () => {
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      runCommand: createReadyRunner(),
      fileExists: () => true,
      readFile: () => JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
    });

    expect(capability.ready).toBe(true);
    expect(capability.reasons).not.toContain("codex_not_logged_in");
  });

  it("accepts API key auth from process env", () => {
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      env: { OPENAI_API_KEY: "sk-env-test" },
      runCommand: createReadyRunner(),
      fileExists: () => false,
      readFile: () => {
        throw new Error("auth.json should not be required when env key exists");
      },
    });

    expect(capability.ready).toBe(true);
    expect(capability.reasons).not.toContain("codex_not_logged_in");
  });

  it("rejects empty or malformed auth files", () => {
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      runCommand: createReadyRunner(),
      fileExists: () => true,
      readFile: () => JSON.stringify({ tokens: {} }),
    });

    expect(capability.ready).toBe(false);
    expect(capability.reasons).toContain("codex_not_logged_in");
  });

  it("probes exec with user config ignored", () => {
    const calls: string[] = [];
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      runCommand: (_command, args) => {
        calls.push(args.join(" "));
        if (args.join(" ") === "--version") return "codex 0.124.0";
        if (args.join(" ") === "features list") {
          return CODEX_IMAGEGEN_FEATURES;
        }
        return "ok";
      },
      fileExists: () => true,
      readFile: () =>
        JSON.stringify({ tokens: { access_token: "access-token" } }),
    });

    expect(capability.ready).toBe(true);
    expect(calls).toContain(
      "exec --ignore-user-config --sandbox workspace-write --help",
    );
    expect(calls).not.toContain("login status");
  });

  it("reports unavailable built-in image generation features without requiring a skill", () => {
    const capability = detectCodexImagegenCapability({
      enabled: true,
      cacheTtlMs: 0,
      codexHome: "/tmp/codex-home",
      env: { OPENAI_API_KEY: "sk-env-test" },
      runCommand: (_command, args) => {
        if (args.join(" ") === "--version") return "codex 0.124.0";
        if (args.join(" ") === "features list") return "other stable true";
        return "ok";
      },
      fileExists: () => false,
    });

    expect(capability).toMatchObject({
      ready: false,
      reasons: ["image_generation_unavailable", "fast_mode_unavailable"],
    });
  });
});

describe("detectConfiguredCodexImagegenCapability", () => {
  it("preserves the target-selection error when Codex targets are ambiguous", async () => {
    const runtime = {
      cancel: async () => undefined,
      detect: async () => [
        {
          agentTargetId: "team:writer",
          executablePath: String.raw`C:\Agents\writer.exe`,
          provider: "codex",
          displayName: "Writer",
          authState: "ok",
          models: [],
          supported: true,
        },
        {
          agentTargetId: "team:reviewer",
          executablePath: String.raw`C:\Agents\reviewer.exe`,
          provider: "codex",
          displayName: "Reviewer",
          authState: "ok",
          models: [],
          supported: true,
        },
      ],
      listProviders: () => [
        { id: "codex", displayName: "Codex", kind: "local-agent" as const },
      ],
      run: async function* () {
        yield* [];
      },
    };

    const capability = await detectConfiguredCodexImagegenCapability({
      enabled: true,
      runtime: runtime as never,
    });

    expect(capability).toMatchObject({
      ready: false,
      reasons: ["agent_target_unavailable"],
    });
    expect(capability.detail).toContain("configure one as the default target");
  });
});

describe("Codex Imagegen capability utilities", () => {
  it("parses Codex semver output", () => {
    expect(parseCodexVersion("codex-cli 0.124.1")).toBe("0.124.1");
    expect(parseCodexVersion("no version")).toBeUndefined();
  });

  it("compares semantic versions", () => {
    expect(compareSemver("0.124.0", "0.124.0")).toBe(0);
    expect(compareSemver("0.124.1", "0.124.0")).toBe(1);
    expect(compareSemver("0.123.9", "0.124.0")).toBe(-1);
  });
});

function createReadyRunner(): CodexImagegenCommandRunner {
  return (_command, args) => {
    if (args.join(" ") === "--version") return "codex 0.124.0";
    if (args.join(" ") === "features list") return CODEX_IMAGEGEN_FEATURES;
    return "ok";
  };
}
