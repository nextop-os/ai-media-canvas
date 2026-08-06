import type { FastifyInstance, FastifyReply } from "fastify";

import {
  type LocalAgentProviderInfo,
  type ModelInfo,
  modelListResponseSchema,
} from "@aimc/shared";
import {
  type AgentDiscoveryRuntime,
  detectAgentTargets,
} from "../agent/agent-targets.js";

import {
  type LocalAgentModelDetectContext,
  type LocalAgentModelDiscovery,
  buildLocalAgentModels,
  buildLocalAgentProviderInfo,
  createDefaultLocalAgentModelDiscovery,
} from "../agent/local-agent-models.js";
import {
  type ModelDiscoverySingleFlight,
  createModelDiscoverySingleFlight,
} from "../agent/model-discovery-single-flight.js";
import type { ServerEnv } from "../config/env.js";
import {
  LOCAL_WORKSPACE_ID,
  type SettingsService,
} from "../features/settings/settings-service.js";

function resolveLocalAgentModelDiscovery(options: {
  localAgentDiscoveryRuntime?: AgentDiscoveryRuntime;
  localAgentModelDiscovery?: LocalAgentModelDiscovery;
}): LocalAgentModelDiscovery {
  if (options.localAgentModelDiscovery) return options.localAgentModelDiscovery;
  const discoveryRuntime = options.localAgentDiscoveryRuntime;
  if (discoveryRuntime) {
    return {
      detect: (context?: LocalAgentModelDetectContext) =>
        discoveryRuntime.detect(context),
    };
  }
  return createDefaultLocalAgentModelDiscovery();
}

type ModelDiscoveryLogger = {
  warn: (payload: unknown, message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseRefreshFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(parseRefreshFlag);
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isModelRefreshRequested(input: unknown): boolean {
  return isRecord(input) && parseRefreshFlag(input.refresh);
}

export async function registerModelRoutes(
  app: FastifyInstance,
  env: ServerEnv,
  settingsService?: SettingsService,
  options?: {
    localAgentDiscoveryRuntime?: AgentDiscoveryRuntime;
    localAgentModelDiscovery?: LocalAgentModelDiscovery;
  },
) {
  const modelDiscoverySingleFlight = createModelDiscoverySingleFlight();
  // One route-scoped runtime owns Tutti-aware or standalone discovery.
  const localAgentModelDiscovery = resolveLocalAgentModelDiscovery({
    ...(options?.localAgentDiscoveryRuntime
      ? { localAgentDiscoveryRuntime: options.localAgentDiscoveryRuntime }
      : {}),
    ...(options?.localAgentModelDiscovery
      ? { localAgentModelDiscovery: options.localAgentModelDiscovery }
      : {}),
  });
  const sendModels = async (
    reply: FastifyReply,
    input: {
      refreshLocalAgentModels?: boolean;
    } = {},
  ) => {
    const result = await listAgentModelCatalog({
      env,
      logger: app.log,
      localAgentModelDiscovery,
      ...(options?.localAgentDiscoveryRuntime
        ? { localAgentDiscoveryRuntime: options.localAgentDiscoveryRuntime }
        : {}),
      ...(input.refreshLocalAgentModels
        ? { refreshLocalAgentModels: true }
        : {}),
      ...(settingsService ? { settingsService } : {}),
      modelDiscoverySingleFlight,
    });
    return reply.code(200).send(modelListResponseSchema.parse(result));
  };

  app.get("/api/models", async (request, reply) => {
    return sendModels(reply, {
      refreshLocalAgentModels: isModelRefreshRequested(request.query),
    });
  });

  app.post("/api/models", async (request, reply) => {
    return sendModels(reply, {
      refreshLocalAgentModels:
        isModelRefreshRequested(request.query) ||
        isModelRefreshRequested(request.body),
    });
  });
}

export type ListAgentModelsOptions = {
  env: ServerEnv;
  localAgentDiscoveryRuntime?: AgentDiscoveryRuntime;
  localAgentModelDiscovery?: LocalAgentModelDiscovery;
  logger?: ModelDiscoveryLogger;
  refreshLocalAgentModels?: boolean;
  modelDiscoverySingleFlight?: ModelDiscoverySingleFlight;
  settingsService?: SettingsService;
};

export async function listAgentModels(options: ListAgentModelsOptions) {
  return (await listAgentModelCatalog(options)).models;
}

export async function listAgentModelCatalog(options: ListAgentModelsOptions) {
  const effectiveEnv = options.settingsService
    ? await options.settingsService.getEffectiveServerEnv(LOCAL_WORKSPACE_ID)
    : options.env;
  const models: ModelInfo[] = [];
  const localAgentProviders: LocalAgentProviderInfo[] = [];
  let localAgentTargets: Awaited<
    ReturnType<typeof detectAgentTargets>
  >["targets"] = [];
  let defaultAgentTargetId: string | null = null;
  if (effectiveEnv.trustedLocalAgentMode !== false) {
    const localAgentDetectContext: LocalAgentModelDetectContext | undefined =
      options.refreshLocalAgentModels ? { refresh: true } : undefined;
    try {
      const runtime = resolveLocalAgentModelDiscovery(options);
      const detect = () => runtime.detect(localAgentDetectContext);
      const detectionsPromise = options.modelDiscoverySingleFlight
        ? options.modelDiscoverySingleFlight.run(
            {
              workspaceId:
                process.env.TSH_WORKSPACE_ID?.trim() || LOCAL_WORKSPACE_ID,
              refresh: options.refreshLocalAgentModels === true,
            },
            detect,
          )
        : detect();
      const detections = await detectionsPromise;
      const agentTargets = await detectAgentTargets({
        detections,
        ...(options.localAgentDiscoveryRuntime
          ? { runtime: options.localAgentDiscoveryRuntime }
          : {}),
      });
      const supportedDetections = detections.filter(
        (detection) =>
          detection.supported &&
          agentTargets.targets.some(
            (target) =>
              target.agentTargetId === detection.agentTargetId &&
              target.available,
          ),
      );
      models.push(...buildLocalAgentModels(supportedDetections));
      localAgentProviders.push(
        ...buildLocalAgentProviderInfo(supportedDetections),
      );
      localAgentTargets = agentTargets.targets;
      defaultAgentTargetId = agentTargets.defaultAgentTargetId;
    } catch (error) {
      options.logger?.warn(
        { err: error },
        "Failed to load local-agent models; omitting local providers.",
      );
    }
  }
  return {
    models,
    localAgentProviders,
    localAgentTargets,
    defaultAgentTargetId,
  };
}
