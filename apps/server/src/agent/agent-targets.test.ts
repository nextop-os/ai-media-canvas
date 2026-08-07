import type { LocalAgentTargetInfo } from "@aimc/shared";
import { describe, expect, it } from "vitest";

import {
  AgentTargetResolutionError,
  detectAgentTargets,
  resolveAgentTargetFromCatalog,
  resolveCodexAgentTarget,
} from "./agent-targets.js";

function target(
  agentTargetId: string,
  providerId: string,
  available = true,
): LocalAgentTargetInfo {
  return {
    agentTargetId,
    providerId,
    displayName: agentTargetId,
    available,
    runtimeSupported: true,
    isDefault: false,
    models: [],
  };
}

describe("resolveAgentTargetFromCatalog", () => {
  const targets = [
    target("team:designer", "codex"),
    target("team:reviewer", "codex"),
    target("team:writer", "claude-code"),
  ];

  it("selects exact targets even when identities share a provider", () => {
    expect(
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        agentTargetId: "team:reviewer",
      }),
    ).toEqual({ agentTargetId: "team:reviewer", providerId: "codex" });
  });

  it("fails closed for ambiguous deprecated provider input", () => {
    expect(() =>
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        providerId: "codex",
      }),
    ).toThrow("Multiple agents use provider codex");
  });

  it("maps deprecated provider input only when globally unique", () => {
    expect(
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        providerId: "claude-code",
      }),
    ).toEqual({ agentTargetId: "team:writer", providerId: "claude-code" });
  });

  it("rejects duplicate exact and deprecated selectors", () => {
    expect(() =>
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        agentTargetId: "team:designer",
        providerId: "codex",
      }),
    ).toThrow("not both");
  });

  it("rejects unknown exact targets and deprecated providers", () => {
    expect(() =>
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        agentTargetId: "team:missing",
      }),
    ).toThrow(AgentTargetResolutionError);
    expect(() =>
      resolveAgentTargetFromCatalog(targets, "team:designer", {
        providerId: "missing-runtime",
      }),
    ).toThrow("No agent target uses provider missing-runtime");
  });

  it("uses the available catalog default when no selector is supplied", () => {
    expect(resolveAgentTargetFromCatalog(targets, "team:writer", {})).toEqual({
      agentTargetId: "team:writer",
      providerId: "claude-code",
    });
  });

  it("does not run unavailable exact targets", () => {
    expect(() =>
      resolveAgentTargetFromCatalog(
        [target("team:offline", "other", false)],
        null,
        { agentTargetId: "team:offline" },
      ),
    ).toThrow("unavailable");
  });
});

describe("detectAgentTargets", () => {
  it("projects exact targets and their per-target models from one detect snapshot", async () => {
    const detections = [
      {
        agentTargetId: "team:designer",
        provider: "codex",
        displayName: "Designer",
        authState: "ok" as const,
        models: [{ id: "gpt-designer", label: "GPT Designer" }],
        supported: true,
        isDefault: true as const,
      },
      {
        agentTargetId: "team:reviewer",
        provider: "codex",
        displayName: "Reviewer",
        authState: "missing" as const,
        models: [],
        supported: false,
        reason: "Provider authentication is required.",
      },
    ];
    const runtime = {
      cancel: async () => undefined,
      detect: async () => detections,
      listProviders: () => [
        {
          id: "codex",
          displayName: "Codex",
          kind: "local-agent" as const,
        },
      ],
      run: async function* () {
        yield* [];
      },
    };

    const result = await detectAgentTargets({
      detections,
      runtime,
    });

    expect(result.defaultAgentTargetId).toBe("team:designer");
    expect(result.targets).toEqual([
      expect.objectContaining({
        agentTargetId: "team:designer",
        available: true,
        providerId: "codex",
        runtimeSupported: true,
        models: [
          expect.objectContaining({
            id: "codex:gpt-designer",
          }),
        ],
      }),
      expect.objectContaining({
        agentTargetId: "team:reviewer",
        available: false,
        reason: "Provider authentication is required.",
      }),
    ]);
  });
});

describe("resolveCodexAgentTarget", () => {
  const runtimeFor = (detections: Array<Record<string, unknown>>) => ({
    cancel: async () => undefined,
    detect: async () => detections,
    listProviders: () => [
      { id: "codex", displayName: "Codex", kind: "local-agent" as const },
    ],
    run: async function* () {
      yield* [];
    },
  });

  it("uses the configured default Codex target and its exact executable", async () => {
    const result = await resolveCodexAgentTarget({
      runtime: runtimeFor([
        {
          agentTargetId: "team:writer",
          executablePath: "C:\\Program Files\\Tutti Agents\\codex.exe",
          provider: "codex",
          displayName: "Writer",
          authState: "ok",
          models: [],
          supported: true,
          isDefault: true,
        },
        {
          agentTargetId: "team:reviewer",
          executablePath: "D:\\Agents\\codex.exe",
          provider: "codex",
          displayName: "Reviewer",
          authState: "ok",
          models: [],
          supported: true,
        },
      ]) as never,
    });

    expect(result).toEqual({
      agentTargetId: "team:writer",
      providerId: "codex",
      executablePath: "C:\\Program Files\\Tutti Agents\\codex.exe",
    });
  });

  it("keeps a unique available Codex target when its executable is omitted", async () => {
    const result = await resolveCodexAgentTarget({
      runtime: runtimeFor([
        {
          agentTargetId: "team:writer",
          provider: "codex",
          displayName: "Writer",
          authState: "ok",
          models: [],
          supported: true,
        },
      ]) as never,
    });

    expect(result).toEqual({
      agentTargetId: "team:writer",
      providerId: "codex",
    });
  });

  it("fails closed when multiple Codex targets have no configured default", async () => {
    await expect(
      resolveCodexAgentTarget({
        runtime: runtimeFor([
          {
            agentTargetId: "team:writer",
            executablePath: "C:\\Agents\\writer.exe",
            provider: "codex",
            displayName: "Writer",
            authState: "ok",
            models: [],
            supported: true,
          },
          {
            agentTargetId: "team:reviewer",
            executablePath: "C:\\Agents\\reviewer.exe",
            provider: "codex",
            displayName: "Reviewer",
            authState: "ok",
            models: [],
            supported: true,
          },
        ]) as never,
      }),
    ).rejects.toThrow("configure one as the default target");
  });
});
