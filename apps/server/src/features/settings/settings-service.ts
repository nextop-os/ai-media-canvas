import type { WorkspaceSettings } from "@aimc/shared";

import {
  type LocalAgentModelDiscovery,
  createDefaultLocalAgentModelDiscovery,
  resolveLocalAgentDefaultModel,
} from "../../agent/local-agent-models.js";
import type { AuthenticatedUser } from "../../auth/types.js";
import {
  DEFAULT_AGNES_AGENT_MODEL,
  DEFAULT_AGNES_BASE_URL,
  type ServerEnv,
} from "../../config/env.js";
import { registerAllProviders } from "../../generation/providers/register-all.js";
import { clearProviders } from "../../generation/providers/registry.js";
import type { LocalStore } from "../../local/store.js";

export const LOCAL_WORKSPACE_ID = "local-workspace";

export const EMPTY_WORKSPACE_SETTINGS: WorkspaceSettings = {
  defaultModel: "",
  defaultModelSource: undefined,
  providerModels: {
    openai: [],
    anthropic: [],
    agnes: [],
    google: [],
    vertex: [],
  },
  openAIApiKey: "",
  openAIApiBase: "",
  anthropicApiKey: "",
  anthropicBaseUrl: "",
  agnesApiKey: "",
  agnesBaseUrl: "",
  agnesDefaultModel: "",
  googleApiKey: "",
  googleVertexProject: "",
  googleVertexLocation: "",
  googleVertexVideoLocation: "",
  replicateApiToken: "",
  kieApiKey: "",
  kieBaseUrl: "",
  volcesApiKey: "",
  volcesBaseUrl: "",
  codexImagegenDelegation: "ask",
};

export type SettingsServiceOptions = {
  localAgentModelDiscovery?: LocalAgentModelDiscovery;
};

function normalizeModelList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const nextValue = value.trim();
    if (!nextValue || seen.has(nextValue)) continue;
    seen.add(nextValue);
    normalized.push(nextValue);
  }

  return normalized;
}

function normalizeProviderModels(
  input: Partial<WorkspaceSettings>["providerModels"],
): WorkspaceSettings["providerModels"] {
  return {
    openai: normalizeModelList(input?.openai),
    anthropic: normalizeModelList(input?.anthropic),
    agnes: normalizeModelList(input?.agnes),
    google: normalizeModelList(input?.google),
    vertex: normalizeModelList(input?.vertex),
  };
}

export type SettingsService = {
  getWorkspaceSettings(
    user: AuthenticatedUser | null,
    workspaceId: string,
  ): Promise<WorkspaceSettings>;
  updateWorkspaceSettings(
    user: AuthenticatedUser | null,
    workspaceId: string,
    settings: WorkspaceSettings,
  ): Promise<WorkspaceSettings>;
  getEffectiveServerEnv(workspaceId?: string): Promise<ServerEnv>;
};

function normalizeLegacyLocalAgentModelId(modelId: string) {
  if (modelId.startsWith("claude:")) {
    return `claude-code:${modelId.slice("claude:".length)}`;
  }
  return modelId;
}

export function normalizeWorkspaceSettings(
  input: Partial<WorkspaceSettings>,
): WorkspaceSettings {
  const defaultModel = normalizeLegacyLocalAgentModelId(
    input.defaultModel?.trim() ?? "",
  );
  const defaultModelSource =
    defaultModel && input.defaultModelSource === "local-agent"
      ? input.defaultModelSource
      : undefined;
  return {
    defaultModel,
    defaultModelSource,
    providerModels: normalizeProviderModels(input.providerModels),
    openAIApiKey: input.openAIApiKey?.trim() ?? "",
    openAIApiBase: input.openAIApiBase?.trim() ?? "",
    anthropicApiKey: input.anthropicApiKey?.trim() ?? "",
    anthropicBaseUrl: input.anthropicBaseUrl?.trim() ?? "",
    agnesApiKey: input.agnesApiKey?.trim() ?? "",
    agnesBaseUrl: input.agnesBaseUrl?.trim() ?? "",
    agnesDefaultModel: input.agnesDefaultModel?.trim() ?? "",
    googleApiKey: input.googleApiKey?.trim() ?? "",
    googleVertexProject: input.googleVertexProject?.trim() ?? "",
    googleVertexLocation: input.googleVertexLocation?.trim() ?? "",
    googleVertexVideoLocation: input.googleVertexVideoLocation?.trim() ?? "",
    replicateApiToken: input.replicateApiToken?.trim() ?? "",
    kieApiKey: input.kieApiKey?.trim() ?? "",
    kieBaseUrl: input.kieBaseUrl?.trim() ?? "",
    volcesApiKey: input.volcesApiKey?.trim() ?? "",
    volcesBaseUrl: input.volcesBaseUrl?.trim() ?? "",
    codexImagegenDelegation:
      input.codexImagegenDelegation === "always" ||
      input.codexImagegenDelegation === "never"
        ? input.codexImagegenDelegation
        : "ask",
  };
}

export function resolveEffectiveServerEnv(
  baseEnv: ServerEnv,
  settings: WorkspaceSettings,
): ServerEnv {
  const openAIApiKey = settings.openAIApiKey || baseEnv.openAIApiKey;
  const openAIApiBase = settings.openAIApiBase || baseEnv.openAIApiBase;
  const anthropicApiKey = settings.anthropicApiKey || baseEnv.anthropicApiKey;
  const anthropicBaseUrl =
    settings.anthropicBaseUrl || baseEnv.anthropicBaseUrl;
  const agnesApiKey = settings.agnesApiKey || baseEnv.agnesApiKey;
  const agnesBaseUrl =
    settings.agnesBaseUrl ||
    baseEnv.agnesBaseUrl ||
    (agnesApiKey ? DEFAULT_AGNES_BASE_URL : undefined);
  const configuredAgnesDefaultModel = settings.providerModels.agnes[0];
  const agnesDefaultModel =
    configuredAgnesDefaultModel ||
    settings.agnesDefaultModel ||
    baseEnv.agnesDefaultModel ||
    (agnesApiKey ? DEFAULT_AGNES_AGENT_MODEL : undefined);
  const googleApiKey = settings.googleApiKey || baseEnv.googleApiKey;
  const googleVertexProject =
    settings.googleVertexProject || baseEnv.googleVertexProject;
  const googleVertexLocation =
    settings.googleVertexLocation || baseEnv.googleVertexLocation;
  const googleVertexVideoLocation =
    settings.googleVertexVideoLocation || baseEnv.googleVertexVideoLocation;
  const replicateApiToken =
    settings.replicateApiToken || baseEnv.replicateApiToken;
  const kieApiKey = settings.kieApiKey || baseEnv.kieApiKey;
  const kieBaseUrl = settings.kieBaseUrl || baseEnv.kieBaseUrl;
  const volcesApiKey = settings.volcesApiKey || baseEnv.volcesApiKey;
  const volcesBaseUrl = settings.volcesBaseUrl || baseEnv.volcesBaseUrl;

  return {
    ...baseEnv,
    agentModel:
      settings.defaultModel ||
      (baseEnv.agentModelConfigured ? undefined : agnesDefaultModel) ||
      baseEnv.agentModel,
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
    ...(agnesApiKey ? { agnesApiKey } : {}),
    ...(agnesBaseUrl ? { agnesBaseUrl } : {}),
    ...(agnesDefaultModel ? { agnesDefaultModel } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(openAIApiBase ? { openAIApiBase } : {}),
    ...(googleApiKey ? { googleApiKey } : {}),
    ...(googleVertexProject ? { googleVertexProject } : {}),
    ...(googleVertexLocation ? { googleVertexLocation } : {}),
    ...(googleVertexVideoLocation ? { googleVertexVideoLocation } : {}),
    ...(replicateApiToken ? { replicateApiToken } : {}),
    ...(kieApiKey ? { kieApiKey } : {}),
    ...(kieBaseUrl ? { kieBaseUrl } : {}),
    ...(volcesApiKey ? { volcesApiKey } : {}),
    ...(volcesBaseUrl ? { volcesBaseUrl } : {}),
  };
}

function assignEnvValue(
  target: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
) {
  if (value) {
    target[key] = value;
    return;
  }
  delete target[key];
}

export function applyEffectiveProviderEnv(
  env: Pick<
    ServerEnv,
    | "googleApiKey"
    | "googleVertexLocation"
    | "googleVertexProject"
    | "googleVertexVideoLocation"
    | "agnesApiKey"
    | "agnesBaseUrl"
    | "agnesDefaultModel"
    | "anthropicApiKey"
    | "anthropicBaseUrl"
    | "openAIApiBase"
    | "openAIApiKey"
    | "replicateApiToken"
    | "kieApiKey"
    | "kieBaseUrl"
    | "volcesApiKey"
    | "volcesBaseUrl"
  >,
  target: NodeJS.ProcessEnv = process.env,
) {
  assignEnvValue(target, "AIMC_ANTHROPIC_API_KEY", env.anthropicApiKey);
  assignEnvValue(target, "ANTHROPIC_API_KEY", env.anthropicApiKey);
  assignEnvValue(target, "AIMC_ANTHROPIC_BASE_URL", env.anthropicBaseUrl);
  assignEnvValue(target, "ANTHROPIC_BASE_URL", env.anthropicBaseUrl);

  assignEnvValue(target, "AIMC_AGNES_API_KEY", env.agnesApiKey);
  assignEnvValue(target, "AGNES_API_KEY", env.agnesApiKey);
  assignEnvValue(target, "AIMC_AGNES_BASE_URL", env.agnesBaseUrl);
  assignEnvValue(target, "AGNES_BASE_URL", env.agnesBaseUrl);
  assignEnvValue(target, "AIMC_AGNES_MODEL", env.agnesDefaultModel);
  assignEnvValue(target, "AGNES_DEFAULT_MODEL", env.agnesDefaultModel);

  assignEnvValue(target, "AIMC_OPENAI_API_KEY", env.openAIApiKey);
  assignEnvValue(target, "OPENAI_API_KEY", env.openAIApiKey);
  assignEnvValue(target, "AIMC_OPENAI_API_BASE", env.openAIApiBase);
  assignEnvValue(target, "OPENAI_BASE_URL", env.openAIApiBase);

  assignEnvValue(target, "AIMC_GOOGLE_API_KEY", env.googleApiKey);
  assignEnvValue(target, "GOOGLE_API_KEY", env.googleApiKey);
  assignEnvValue(target, "AIMC_GOOGLE_VERTEX_PROJECT", env.googleVertexProject);
  assignEnvValue(target, "GOOGLE_VERTEX_PROJECT", env.googleVertexProject);
  assignEnvValue(
    target,
    "AIMC_GOOGLE_VERTEX_LOCATION",
    env.googleVertexLocation,
  );
  assignEnvValue(target, "GOOGLE_VERTEX_LOCATION", env.googleVertexLocation);
  assignEnvValue(
    target,
    "AIMC_GOOGLE_VERTEX_VIDEO_LOCATION",
    env.googleVertexVideoLocation,
  );
  assignEnvValue(
    target,
    "GOOGLE_VERTEX_VIDEO_LOCATION",
    env.googleVertexVideoLocation,
  );

  assignEnvValue(target, "AIMC_REPLICATE_API_TOKEN", env.replicateApiToken);
  assignEnvValue(target, "REPLICATE_API_TOKEN", env.replicateApiToken);
  assignEnvValue(target, "AIMC_KIE_API_KEY", env.kieApiKey);
  assignEnvValue(target, "KIE_API_KEY", env.kieApiKey);
  assignEnvValue(target, "AIMC_KIE_BASE_URL", env.kieBaseUrl);
  assignEnvValue(target, "KIE_BASE_URL", env.kieBaseUrl);
  assignEnvValue(target, "AIMC_VOLCES_API_KEY", env.volcesApiKey);
  assignEnvValue(target, "VOLCES_API_KEY", env.volcesApiKey);
  assignEnvValue(target, "AIMC_VOLCES_BASE_URL", env.volcesBaseUrl);
  assignEnvValue(target, "VOLCES_BASE_URL", env.volcesBaseUrl);
}

export function refreshGenerationProviders(env: ServerEnv) {
  clearProviders();
  registerAllProviders(env);
}

export function createSettingsService(
  store: LocalStore,
  baseEnv: ServerEnv,
  options: SettingsServiceOptions = {},
): SettingsService {
  const localAgentModelDiscovery =
    options.localAgentModelDiscovery ?? createDefaultLocalAgentModelDiscovery();

  return {
    async getWorkspaceSettings(_user, _workspaceId) {
      return normalizeWorkspaceSettings(store.getWorkspaceSettings());
    },

    async updateWorkspaceSettings(_user, _workspaceId, settings) {
      return store.updateWorkspaceSettings(
        normalizeWorkspaceSettings(settings),
      );
    },

    async getEffectiveServerEnv(_workspaceId = LOCAL_WORKSPACE_ID) {
      const settings = normalizeWorkspaceSettings(store.getWorkspaceSettings());
      const effectiveEnv = resolveEffectiveServerEnv(baseEnv, settings);
      return {
        ...effectiveEnv,
        agentModel: await resolveLocalAgentDefaultModel(
          effectiveEnv.agentModel,
          localAgentModelDiscovery,
        ),
      };
    },
  };
}
