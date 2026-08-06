import type { LocalAgentProviderInfo, ModelListResponse } from "@aimc/shared";

export type AgentModelSourceTab = "local-agent";

export function isLocalCliProvider(provider: string) {
  return true;
}

export function isSupportedLocalCliProvider(provider: string) {
  return isLocalCliProvider(provider);
}

export function getAgentModelSourceTab(modelId: string | null | undefined) {
  return "local-agent" as const;
}

export function getModelSourceTab(model: {
  provider: string;
  source?: AgentModelSourceTab | undefined;
}) {
  return model.source ?? "local-agent";
}

export function formatLocalCliProviderLabel(provider: string) {
  return provider
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getLocalCliProviderFallbackMark(provider: string) {
  return provider
    .split(/[-_.:]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function localAgentProvidersFromModelResponse(
  response: ModelListResponse,
): LocalAgentProviderInfo[] {
  const current = (response as Partial<ModelListResponse>).localAgentProviders;
  return Array.isArray(current) ? current : [];
}
