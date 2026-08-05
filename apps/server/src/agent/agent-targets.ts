import type { AgentRuntimeProvider, LocalAgentTargetInfo } from "@aimc/shared";
import {
  type DetectContext,
  type LocalAgentRuntime,
  createDefaultLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

import { buildLocalAgentModels } from "./local-agent-models.js";

export type AgentDiscoveryRuntime = LocalAgentRuntime<
  "local-agent",
  AgentRuntimeProvider
>;

const defaultRuntime =
  createDefaultLocalAgentRuntime() as AgentDiscoveryRuntime;

export type ResolvedAgentTarget = {
  agentTargetId: string;
  providerId: AgentRuntimeProvider;
};

export type ResolvedCodexAgentTarget = ResolvedAgentTarget & {
  executablePath: string;
};

export class AgentTargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTargetResolutionError";
  }
}

/**
 * Projects the kit's single high-level discovery result into AIMC's API shape.
 * In a Tutti workspace runtime.detect() returns exact Agent Targets and their
 * composer models; outside Tutti it returns local:<provider> targets.
 */
export async function detectAgentTargets(
  input: {
    detectContext?: DetectContext;
    detections?: Awaited<ReturnType<AgentDiscoveryRuntime["detect"]>>;
    refresh?: boolean;
    runtime?: AgentDiscoveryRuntime;
  } = {},
): Promise<{
  defaultAgentTargetId: string | null;
  detections: Awaited<ReturnType<AgentDiscoveryRuntime["detect"]>>;
  targets: LocalAgentTargetInfo[];
}> {
  const detectContext = {
    ...(input.detectContext ?? {}),
    ...(input.refresh ? { refresh: true } : {}),
  };
  const runtime = input.runtime ?? defaultRuntime;
  const detections = input.detections ?? (await runtime.detect(detectContext));
  const registeredProviders = new Set(
    runtime.listProviders().map((provider) => String(provider.id)),
  );
  const targets = detections.flatMap((detection) => {
    const agentTargetId = detection.agentTargetId?.trim();
    if (!agentTargetId) return [];
    const providerId = String(detection.provider) as AgentRuntimeProvider;
    const runtimeSupported = registeredProviders.has(providerId);
    return [
      {
        agentTargetId,
        providerId,
        displayName: detection.displayName,
        available: detection.supported && runtimeSupported,
        runtimeSupported,
        isDefault: detection.isDefault === true,
        ...(detection.reason ? { reason: detection.reason } : {}),
        models: buildLocalAgentModels([detection]),
      } satisfies LocalAgentTargetInfo,
    ];
  });
  const preferred = targets.find(
    (target) => target.isDefault && target.available,
  );

  return {
    defaultAgentTargetId:
      preferred?.agentTargetId ??
      targets.find((target) => target.available)?.agentTargetId ??
      null,
    detections,
    targets,
  };
}

/**
 * Resolves the configured Codex target without silently choosing between
 * multiple candidates. The default target wins when it is Codex; otherwise a
 * single available Codex target is unambiguous.
 */
export async function resolveCodexAgentTarget(
  input: {
    detectContext?: DetectContext;
    runtime?: AgentDiscoveryRuntime;
  } = {},
): Promise<ResolvedCodexAgentTarget> {
  const { detections } = await detectAgentTargets({
    ...(input.detectContext ? { detectContext: input.detectContext } : {}),
    refresh: true,
    ...(input.runtime ? { runtime: input.runtime } : {}),
  });
  const candidates = detections.flatMap((detection) => {
    const agentTargetId = detection.agentTargetId?.trim();
    const executablePath = detection.executablePath?.trim();
    if (
      detection.provider !== "codex" ||
      !detection.supported ||
      !agentTargetId ||
      !executablePath
    ) {
      return [];
    }
    return [{ agentTargetId, executablePath, isDefault: detection.isDefault }];
  });
  const preferred = candidates.filter((candidate) => candidate.isDefault);
  const selected =
    preferred.length === 1
      ? preferred[0]
      : preferred.length === 0 && candidates.length === 1
        ? candidates[0]
        : undefined;
  if (!selected) {
    throw new AgentTargetResolutionError(
      candidates.length === 0
        ? "No available Codex Agent Target has a resolved executable."
        : "Multiple Codex Agent Targets are available; configure one as the default target.",
    );
  }
  return {
    agentTargetId: selected.agentTargetId,
    providerId: "codex",
    executablePath: selected.executablePath,
  };
}

export async function resolveAgentTarget(input: {
  agentTargetId?: string;
  /** @deprecated Compatibility input. */
  providerId?: string;
  detectContext?: DetectContext;
}): Promise<ResolvedAgentTarget> {
  const { defaultAgentTargetId, targets } = await detectAgentTargets({
    ...(input.detectContext ? { detectContext: input.detectContext } : {}),
  });
  return resolveAgentTargetFromCatalog(targets, defaultAgentTargetId, input);
}

export function resolveAgentTargetFromCatalog(
  targets: LocalAgentTargetInfo[],
  defaultAgentTargetId: string | null,
  input: { agentTargetId?: string; providerId?: string },
): ResolvedAgentTarget {
  const exactId = input.agentTargetId?.trim();
  const legacyProvider = input.providerId?.trim();
  if (exactId && legacyProvider) {
    throw new AgentTargetResolutionError(
      "Provide agentTargetId or deprecated runtimeProvider, not both.",
    );
  }
  let target = exactId
    ? targets.find((entry) => entry.agentTargetId === exactId)
    : undefined;
  if (!target && !exactId && legacyProvider) {
    const matches = targets.filter(
      (entry) => entry.providerId === legacyProvider,
    );
    if (matches.length !== 1) {
      throw new AgentTargetResolutionError(
        matches.length > 1
          ? `Multiple agents use provider ${legacyProvider}; select an exact agentTargetId.`
          : `No agent target uses provider ${legacyProvider}.`,
      );
    }
    target = matches[0];
  }
  if (!target && !exactId && !legacyProvider && defaultAgentTargetId) {
    target = targets.find(
      (entry) => entry.agentTargetId === defaultAgentTargetId,
    );
  }
  if (!target) {
    throw new AgentTargetResolutionError(
      exactId
        ? `Agent target is not exposed by Tutti: ${exactId}`
        : "No local agent target is available.",
    );
  }
  if (!target.available) {
    throw new AgentTargetResolutionError(
      target.reason || `Agent target ${target.agentTargetId} is unavailable.`,
    );
  }
  return {
    agentTargetId: target.agentTargetId,
    providerId: target.providerId,
  };
}
