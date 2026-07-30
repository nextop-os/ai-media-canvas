"use client";

import {
  Cloud,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  LocalAgentProviderInfo,
  LocalAgentTargetInfo,
  ModelInfo,
  TuttiManagedConnection,
  WorkspaceSettings,
} from "@aimc/shared";

import { useAppTranslation } from "@/i18n";
import {
  type AgentModelSourceTab,
  getAgentModelSourceTab,
  getModelSourceTab,
  isApiProvider,
  isLocalCliProvider,
  localAgentProvidersFromModelResponse,
} from "@/lib/agent-model-groups";
import {
  connectTuttiManagedModels,
  disconnectTuttiManagedModels,
  fetchModels,
  fetchTuttiManagedConnection,
} from "@/lib/server-api";
import { useTuttiAgentTargetIconUrls } from "@/lib/tutti-agent-target-presentations";
import {
  hasTuttiManagedCredentialBridge,
  openTuttiAgentManager,
  openTuttiManagedModelSettings,
  requestTuttiManagedGrant,
} from "@/lib/tutti-managed-credentials";
import { AgnesQuickstartHint } from "./agnes-quickstart-hint";
import { LocalCliProviderIcon } from "./local-cli-provider-icon";
import { SettingsSegmentTabs } from "./settings-segment-tabs";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface AgentSettingsSectionProps {
  initialSourceTab?: AgentModelSourceTab | undefined;
  onSaved?: (() => void) | undefined;
  settings: WorkspaceSettings;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  surface?: "page" | "dialog";
}

type AgentProtocolId = "agnes" | "openai" | "google" | "vertex" | "anthropic";

type ProviderModels = WorkspaceSettings["providerModels"];
type LocalCliProviderGroup = {
  available: boolean;
  defaultModelId?: string | undefined;
  iconUrl?: string | undefined;
  provider: string;
  label: string;
  models: ModelInfo[];
  reason?: string | undefined;
};
type ApiProviderPreset = {
  provider: AgentProtocolId;
  label: string;
  baseUrl: string;
  apiKeyUrl: string;
  model: string;
  models: string[];
};

const AGNES_API_KEYS_URL = "https://platform.agnes-ai.com/settings/apiKeys";
const ANTHROPIC_API_KEYS_URL = "https://console.anthropic.com/settings/keys";
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
const MINIMAX_API_KEYS_URL = "https://platform.minimax.io/console/access";
const MIMO_API_KEYS_URL = "https://platform.xiaomimimo.com/console/api-keys";
const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";
const DEFAULT_AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_AGNES_PROVIDER_MODELS = [
  "agnes:agnes-2.0-flash",
  "agnes:agnes-1.5-flash",
];
const CUSTOM_API_PROVIDER_PRESET_VALUE = "__custom_api_provider__";

const AGENT_PROTOCOLS: Array<{
  id: AgentProtocolId;
  label: string;
  description: string;
}> = [
  {
    id: "agnes",
    label: "Agnes",
    description: "Agnes OpenAI-compatible chat route",
  },
  {
    id: "openai",
    label: "OpenAI-compatible",
    description: "OpenAI and OpenAI-compatible gateways",
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Google API key route for Gemini models",
  },
  {
    id: "vertex",
    label: "Vertex AI",
    description:
      "Google Cloud hosted route for Gemini and Vertex-backed models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude API route for Anthropic-hosted models",
  },
];

const AGENT_CREDENTIAL_PROTOCOLS = AGENT_PROTOCOLS.filter(
  (protocol) => protocol.id !== "google" && protocol.id !== "vertex",
);

const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    apiKeyUrl: ANTHROPIC_API_KEYS_URL,
    model: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  },
  {
    provider: "anthropic",
    label: "DeepSeek - Anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    model: "deepseek-v4-flash",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    provider: "anthropic",
    label: "MiniMax - Anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    model: "MiniMax-M3",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2",
    ],
  },
  {
    provider: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyUrl: OPENAI_API_KEYS_URL,
    model: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    provider: "openai",
    label: "DeepSeek - OpenAI",
    baseUrl: "https://api.deepseek.com",
    apiKeyUrl: DEEPSEEK_API_KEYS_URL,
    model: "deepseek-v4-flash",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    provider: "openai",
    label: "MiniMax - OpenAI",
    baseUrl: "https://api.minimaxi.com/v1",
    apiKeyUrl: MINIMAX_API_KEYS_URL,
    model: "MiniMax-M3",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2",
    ],
  },
  {
    provider: "openai",
    label: "MiMo (Xiaomi) - OpenAI",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    apiKeyUrl: MIMO_API_KEYS_URL,
    model: "mimo-v2.5-pro",
    models: ["mimo-v2.5-pro"],
  },
  {
    provider: "anthropic",
    label: "MiMo (Xiaomi) - Anthropic",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    apiKeyUrl: MIMO_API_KEYS_URL,
    model: "mimo-v2.5-pro",
    models: ["mimo-v2.5-pro"],
  },
];

function getInitialProtocol(settings: WorkspaceSettings): AgentProtocolId {
  const provider = settings.defaultModel.split(":")[0];
  const credentialProtocol = AGENT_CREDENTIAL_PROTOCOLS.find(
    (protocol) => protocol.id === provider,
  );
  if (credentialProtocol) {
    return credentialProtocol.id;
  }
  return "agnes";
}

function buildModelId(provider: AgentProtocolId, value: string): string {
  return value.includes(":") ? value : `${provider}:${value}`;
}

function getModelName(provider: AgentProtocolId, value: string): string {
  const prefix = `${provider}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function getProviderModelIds(
  settings: WorkspaceSettings,
  provider: AgentProtocolId,
): string[] {
  return settings.providerModels?.[provider] ?? [];
}

function updateProviderModelList(
  current: ProviderModels,
  provider: AgentProtocolId,
  nextValues: string[],
): ProviderModels {
  return {
    ...current,
    [provider]: nextValues,
  };
}

function getProviderLabel(provider: AgentProtocolId): string {
  return (
    AGENT_PROTOCOLS.find((protocol) => protocol.id === provider)?.label ??
    provider
  );
}

function getModelProvider(modelId: string) {
  return modelId.includes(":") ? (modelId.split(":", 1)[0] ?? "") : "";
}

function normalizeAgentSettings(
  initialSettings: WorkspaceSettings,
): WorkspaceSettings {
  const agnesModels = Array.from(
    new Set([
      ...DEFAULT_AGNES_PROVIDER_MODELS,
      ...(initialSettings.providerModels?.agnes ?? []),
    ]),
  );

  return {
    ...initialSettings,
    agnesBaseUrl: initialSettings.agnesBaseUrl || DEFAULT_AGNES_BASE_URL,
    agnesDefaultModel:
      initialSettings.agnesDefaultModel || agnesModels[0] || "",
    defaultModelSource: inferDefaultModelSource(initialSettings),
    providerModels: {
      openai: initialSettings.providerModels?.openai ?? [],
      anthropic: initialSettings.providerModels?.anthropic ?? [],
      agnes: agnesModels,
      google: initialSettings.providerModels?.google ?? [],
      vertex: initialSettings.providerModels?.vertex ?? [],
    },
  };
}

function groupLocalCliProviders(
  targets: LocalAgentTargetInfo[],
  providers: LocalAgentProviderInfo[],
  agentTargetIconUrls: ReadonlyMap<string, string>,
): LocalCliProviderGroup[] {
  return providers.map((provider) => {
    const matchingTargets = targets.filter(
      (target) => target.providerId === provider.provider,
    );
    return {
      available: provider.supported,
      ...(provider.defaultModelId
        ? { defaultModelId: provider.defaultModelId }
        : {}),
      ...(matchingTargets.length === 1
        ? {
            iconUrl: agentTargetIconUrls.get(
              matchingTargets[0]?.agentTargetId ?? "",
            ),
          }
        : {}),
      provider: provider.provider,
      label: provider.displayName,
      models: provider.models,
      ...(provider.reason ? { reason: provider.reason } : {}),
    };
  });
}

function getLocalCliProviderDefaultModel(group: LocalCliProviderGroup) {
  return (
    group.models.find((model) => model.id === group.defaultModelId) ??
    group.models.find((model) => model.id === `${group.provider}:default`) ??
    group.models.find((model) => model.id !== `${group.provider}:default`) ??
    group.models[0] ??
    null
  );
}

function getFirstConfiguredModel(providerModels: ProviderModels): string {
  for (const protocol of AGENT_PROTOCOLS) {
    const firstModel = providerModels[protocol.id]?.[0];
    if (firstModel) return firstModel;
  }
  return "";
}

function applyProviderModelUpdate(
  current: WorkspaceSettings,
  provider: AgentProtocolId,
  nextValues: string[],
): WorkspaceSettings {
  const normalizedValues = Array.from(
    new Set(
      nextValues
        .map((value) => buildModelId(provider, value.trim()))
        .filter(Boolean),
    ),
  );
  const providerModels = updateProviderModelList(
    current.providerModels,
    provider,
    normalizedValues,
  );
  const allConfiguredModels = AGENT_PROTOCOLS.flatMap(
    (protocol) => providerModels[protocol.id],
  );

  return {
    ...current,
    providerModels,
    defaultModel: allConfiguredModels.includes(current.defaultModel)
      ? current.defaultModel
      : getFirstConfiguredModel(providerModels),
    defaultModelSource: allConfiguredModels.includes(current.defaultModel)
      ? current.defaultModelSource
      : getFirstConfiguredModel(providerModels)
        ? "api-provider"
        : undefined,
  };
}

function autoImportDetectedProviderModels(
  current: WorkspaceSettings,
  availableModels: ModelInfo[],
): WorkspaceSettings {
  let nextSettings = current;

  for (const protocol of AGENT_PROTOCOLS) {
    if (nextSettings.providerModels[protocol.id].length > 0) continue;

    const detectedModels = availableModels
      .filter((model) => model.provider === protocol.id)
      .map((model) => model.id);
    if (detectedModels.length === 0) continue;

    nextSettings = applyProviderModelUpdate(
      nextSettings,
      protocol.id,
      detectedModels,
    );
  }

  return nextSettings;
}

function getApiProviderBaseUrl(
  settings: WorkspaceSettings,
  provider: AgentProtocolId,
) {
  if (provider === "openai") return settings.openAIApiBase;
  if (provider === "anthropic") return settings.anthropicBaseUrl;
  return "";
}

function getSelectedApiProviderPreset(
  settings: WorkspaceSettings,
  provider: AgentProtocolId,
) {
  const currentBaseUrl = getApiProviderBaseUrl(settings, provider);
  return API_PROVIDER_PRESETS.find(
    (preset) =>
      preset.provider === provider && preset.baseUrl === currentBaseUrl,
  );
}

function withApiProviderBaseUrl(
  settings: WorkspaceSettings,
  provider: AgentProtocolId,
  baseUrl: string,
): WorkspaceSettings {
  if (provider === "openai") return { ...settings, openAIApiBase: baseUrl };
  if (provider === "anthropic")
    return { ...settings, anthropicBaseUrl: baseUrl };
  return settings;
}

function inferDefaultModelSource(settings: WorkspaceSettings) {
  return settings.defaultModel
    ? (settings.defaultModelSource ??
        getAgentModelSourceTab(settings.defaultModel))
    : undefined;
}

function applyApiProviderPreset(
  current: WorkspaceSettings,
  provider: AgentProtocolId,
  preset: ApiProviderPreset | null,
): WorkspaceSettings {
  const modelIds = preset
    ? preset.models.map((model) => buildModelId(provider, model))
    : [];
  const providerModels = updateProviderModelList(
    current.providerModels,
    provider,
    modelIds,
  );
  const defaultModel = preset
    ? buildModelId(provider, preset.model)
    : getModelProvider(current.defaultModel) === provider
      ? getFirstConfiguredModel(providerModels)
      : current.defaultModel;

  return withApiProviderBaseUrl(
    {
      ...current,
      providerModels,
      defaultModel,
      defaultModelSource: defaultModel ? "api-provider" : undefined,
    },
    provider,
    preset?.baseUrl ?? "",
  );
}

function QuickFillProviderField({
  provider,
  settings,
  onChange,
}: {
  provider: AgentProtocolId;
  settings: WorkspaceSettings;
  onChange: (preset: ApiProviderPreset | null) => void;
}) {
  const { t } = useAppTranslation("settings");
  const presets = API_PROVIDER_PRESETS.filter(
    (preset) => preset.provider === provider,
  );
  if (presets.length === 0) return null;

  const selectedPreset = getSelectedApiProviderPreset(settings, provider);
  const selectedValue =
    selectedPreset?.baseUrl ?? CUSTOM_API_PROVIDER_PRESET_VALUE;
  const items = [
    {
      label: t("agentSettings.api.customProvider"),
      value: CUSTOM_API_PROVIDER_PRESET_VALUE,
    },
    ...presets.map((preset) => ({
      label: preset.label,
      value: preset.baseUrl,
    })),
  ];

  return (
    <div className="space-y-2">
      <Label htmlFor={`${provider}QuickFillProvider`}>
        {t("agentSettings.api.quickFillProvider")}
      </Label>
      <Select
        items={items}
        value={selectedValue}
        onValueChange={(value) => {
          if (value === CUSTOM_API_PROVIDER_PRESET_VALUE) {
            onChange(null);
            return;
          }
          const preset =
            presets.find((candidate) => candidate.baseUrl === value) ?? null;
          onChange(preset);
        }}
      >
        <SelectTrigger
          id={`${provider}QuickFillProvider`}
          aria-label={t("agentSettings.api.quickFillProvider")}
          className="h-11 w-full bg-background shadow-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            <SelectItem value={CUSTOM_API_PROVIDER_PRESET_VALUE}>
              {t("agentSettings.api.customProvider")}
            </SelectItem>
            {presets.map((preset) => (
              <SelectItem
                key={`${preset.provider}-${preset.baseUrl}`}
                value={preset.baseUrl}
              >
                {preset.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function ApiKeyLinkButton({
  href,
  providerLabel,
}: {
  href: string;
  providerLabel: string;
}) {
  const { t } = useAppTranslation("settings");

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto px-0 text-sm"
      onClick={() => window.open(href, "_blank", "noopener,noreferrer")}
    >
      {t("agentSettings.api.getApiKey", { provider: providerLabel })}
      <ExternalLink data-icon="inline-end" />
    </Button>
  );
}

function ProviderModelListEditor({
  provider,
  settings,
  availableModels,
  onChange,
}: {
  provider: AgentProtocolId;
  settings: WorkspaceSettings;
  availableModels: ModelInfo[];
  onChange: (nextValues: string[]) => void;
}) {
  const { t } = useAppTranslation("settings");
  const [draft, setDraft] = useState("");
  const configuredModels = settings.providerModels[provider];
  const detectedModels = availableModels
    .filter((model) => model.provider === provider)
    .map((model) => model.id);

  function addModel() {
    const nextValue = buildModelId(provider, draft.trim());
    if (!draft.trim() || configuredModels.includes(nextValue)) return;
    onChange([...configuredModels, nextValue]);
    setDraft("");
  }

  return (
    <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t("agentSettings.api.providerModels", {
              provider: getProviderLabel(provider),
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("agentSettings.api.providerModelsDescription")}
          </p>
        </div>
        {configuredModels.length === 0 && detectedModels.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange(detectedModels)}
          >
            {t("agentSettings.api.importDetected")}
          </Button>
        ) : null}
      </div>

      {configuredModels.length > 0 ? (
        <div className="space-y-2">
          {configuredModels.map((modelId, index) => (
            <div
              key={`${provider}-${modelId}`}
              className="flex items-center gap-2"
            >
              <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                <span className="border-r border-input px-2.5 text-sm text-muted-foreground">
                  {provider}:
                </span>
                <Input
                  aria-label={`${getProviderLabel(provider)} model ${index + 1}`}
                  value={getModelName(provider, modelId)}
                  onChange={(event) => {
                    const nextValues = [...configuredModels];
                    nextValues[index] = buildModelId(
                      provider,
                      event.target.value.trim(),
                    );
                    onChange(nextValues.filter(Boolean));
                  }}
                  placeholder="model-id"
                  className="border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange(
                    configuredModels.filter(
                      (_, currentIndex) => currentIndex !== index,
                    ),
                  )
                }
              >
                {t("agentSettings.api.removeModel")}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("agentSettings.api.noProviderModels", {
            provider: getProviderLabel(provider),
          })}
        </p>
      )}

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <span className="border-r border-input px-2.5 text-sm text-muted-foreground">
            {provider}:
          </span>
          <Input
            aria-label={t("agentSettings.api.addProviderModel", {
              provider: getProviderLabel(provider),
            })}
            value={getModelName(provider, draft)}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="model-id"
            className="border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
          />
        </div>
        <Button type="button" size="sm" onClick={addModel}>
          {t("agentSettings.api.addModel")}
        </Button>
      </div>
    </div>
  );
}

function LocalCliProviderModelPicker({
  providerGroups,
  activeProvider,
  onProviderChange,
  onSelect,
  onRescan,
  onManageProvider,
  openingManagerProvider,
}: {
  providerGroups: LocalCliProviderGroup[];
  activeProvider: string;
  onProviderChange: (provider: string) => void;
  onSelect: (modelId: string) => void;
  onRescan: () => void;
  onManageProvider: (provider: string) => void;
  openingManagerProvider: string | null;
}) {
  const { t } = useAppTranslation("settings");
  const activeGroup =
    providerGroups.find((group) => group.provider === activeProvider) ?? null;
  const displayGroups = providerGroups;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {t("agentSettings.source.localAgent")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("agentSettings.local.description")}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRescan}>
          <RefreshCw className="size-3.5" />
          {t("agentSettings.local.rescan")}
        </Button>
      </div>

      {displayGroups.length > 0 ? (
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("agentSettings.local.detectedCli")}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {displayGroups.map((group) => {
                const selected = activeGroup?.provider === group.provider;
                const openingManager =
                  openingManagerProvider === group.provider;
                const canManage = !group.available;

                return (
                  <button
                    key={group.provider}
                    type="button"
                    aria-pressed={selected}
                    aria-busy={openingManager}
                    disabled={
                      openingManager ||
                      (group.available ? group.models.length === 0 : !canManage)
                    }
                    onClick={() => {
                      if (!group.available) {
                        onManageProvider(group.provider);
                        return;
                      }
                      onProviderChange(group.provider);
                      const defaultModel =
                        getLocalCliProviderDefaultModel(group);
                      if (defaultModel) {
                        onSelect(defaultModel.id);
                      }
                    }}
                    className={`flex min-h-20 w-full items-center gap-3 rounded-xl border bg-background p-3 text-left transition-colors ${
                      !group.available
                        ? "border-border hover:border-accent/40 hover:bg-background/70"
                        : selected
                          ? "border-accent bg-accent/10 shadow-sm"
                          : "border-border hover:border-accent/40 hover:bg-background/70"
                    }`}
                  >
                    <LocalCliProviderIcon
                      provider={group.provider}
                      iconUrl={group.iconUrl}
                      label={group.label}
                      className="size-7 rounded-md"
                      iconSize={24}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">
                        {group.label}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {openingManager
                          ? t("agentSettings.local.openingManager")
                          : group.available
                            ? group.models.length === 1
                              ? t("agentSettings.local.modelCountOne", {
                                  modelCount: group.models.length,
                                })
                              : t("agentSettings.local.modelCountOther", {
                                  modelCount: group.models.length,
                                })
                            : (group.reason ??
                              t("agentSettings.local.manageInTutti"))}
                      </span>
                    </span>
                    {openingManager ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <span
                        className={`size-2.5 rounded-full ${
                          selected ? "bg-accent" : "bg-muted-foreground/20"
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">
          <p>{t("agentSettings.local.empty")}</p>
          <p className="mt-2 text-xs">{t("agentSettings.local.setupHint")}</p>
        </div>
      )}
    </section>
  );
}

export function AgentSettingsSection({
  initialSourceTab,
  onSaved,
  settings: initialSettings,
  onSave,
  surface = "page",
}: AgentSettingsSectionProps) {
  const { t } = useAppTranslation("settings");
  const agentTargetIconUrls = useTuttiAgentTargetIconUrls();
  const [settings, setSettings] = useState<WorkspaceSettings>(() =>
    normalizeAgentSettings(initialSettings),
  );
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [localAgentTargets, setLocalAgentTargets] = useState<
    LocalAgentTargetInfo[]
  >([]);
  const [localAgentProviders, setLocalAgentProviders] = useState<
    LocalAgentProviderInfo[]
  >([]);
  const [tuttiManagedConnection, setTuttiManagedConnection] =
    useState<TuttiManagedConnection>({
      connected: false,
      providers: [],
      models: [],
    });
  const [connectingTuttiManaged, setConnectingTuttiManaged] = useState(false);
  const [tuttiBridgeAvailable, setTuttiBridgeAvailable] = useState(false);
  const [activeProtocol, setActiveProtocol] = useState<AgentProtocolId>(() =>
    getInitialProtocol(initialSettings),
  );
  const [activeLocalProvider, setActiveLocalProvider] = useState(() =>
    getModelProvider(initialSettings.defaultModel),
  );
  const [activeSourceTab, setActiveSourceTab] = useState<AgentModelSourceTab>(
    () =>
      initialSourceTab ??
      inferDefaultModelSource(initialSettings) ??
      getAgentModelSourceTab(initialSettings.defaultModel),
  );
  const [saving, setSaving] = useState(false);
  const [
    openingLocalAgentManagerProvider,
    setOpeningLocalAgentManagerProvider,
  ] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setSettings(normalizeAgentSettings(initialSettings));
  }, [initialSettings]);

  useEffect(() => {
    if (!initialSourceTab) return;
    setActiveSourceTab(initialSourceTab);
  }, [initialSourceTab]);

  const refreshAvailableModels = useCallback(
    async (options?: {
      refreshLocalAgents?: boolean;
    }) => {
      const modelRequest = options?.refreshLocalAgents
        ? fetchModels({ refresh: true })
        : fetchModels();
      await Promise.allSettled([
        modelRequest.then((response) => {
          setAvailableModels(response.models);
          const providers = localAgentProvidersFromModelResponse(response);
          setLocalAgentProviders(providers);
          setLocalAgentTargets(
            response.localAgentTargets ??
              providers.map((provider) => ({
                agentTargetId: `local:${provider.provider}`,
                providerId: provider.provider,
                displayName: provider.displayName,
                available: provider.supported,
                runtimeSupported: provider.supported,
                isDefault: false,
                ...(provider.reason ? { reason: provider.reason } : {}),
                models: provider.models,
              })),
          );
        }),
        fetchTuttiManagedConnection().then((connectionResponse) => {
          setTuttiManagedConnection(connectionResponse.connection);
        }),
      ]);
    },
    [],
  );

  useEffect(() => {
    void refreshAvailableModels();
  }, [refreshAvailableModels]);

  useEffect(() => {
    setTuttiBridgeAvailable(hasTuttiManagedCredentialBridge());
  }, []);

  useEffect(() => {
    if (availableModels.length === 0) return;
    setSettings((current) =>
      autoImportDetectedProviderModels(current, availableModels),
    );
  }, [availableModels]);

  const normalizedInitial = useMemo(
    () => JSON.stringify(initialSettings),
    [initialSettings],
  );
  const normalizedCurrent = JSON.stringify(settings);
  const hasChanges = normalizedInitial !== normalizedCurrent;
  const tuttiManagedModels = useMemo(
    () =>
      availableModels.filter(
        (model) => getModelSourceTab(model) === "tutti-managed",
      ),
    [availableModels],
  );
  const localCliProviderGroups = useMemo(
    () =>
      groupLocalCliProviders(
        localAgentTargets,
        localAgentProviders,
        agentTargetIconUrls,
      ),
    [agentTargetIconUrls, localAgentProviders, localAgentTargets],
  );
  const localCliProviderCount = localCliProviderGroups.length;
  const selectedLocalProvider = getModelProvider(settings.defaultModel);

  useEffect(() => {
    if (localCliProviderGroups.length === 0) {
      setActiveLocalProvider("");
      return;
    }

    if (!selectedLocalProvider) {
      setActiveLocalProvider("");
      return;
    }

    const hasActiveProvider = localCliProviderGroups.some(
      (group) => group.provider === activeLocalProvider,
    );
    if (hasActiveProvider) return;

    const selectedProviderGroup = localCliProviderGroups.find(
      (group) => group.provider === selectedLocalProvider,
    );
    setActiveLocalProvider(selectedProviderGroup?.provider ?? "");
  }, [activeLocalProvider, localCliProviderGroups, selectedLocalProvider]);

  const modelPickerGroups = useMemo(
    () =>
      AGENT_PROTOCOLS.map((protocol) => ({
        ...protocol,
        models: getProviderModelIds(settings, protocol.id).map((modelId) => ({
          id: modelId,
          name:
            availableModels.find((model) => model.id === modelId)?.name ??
            modelId.replace(`${protocol.id}:`, ""),
          provider: protocol.id,
        })),
      })).filter((protocol) => protocol.models.length > 0),
    [availableModels, settings],
  );
  const selectedModelName = useMemo(
    () =>
      isApiProvider(settings.defaultModel.split(":")[0] ?? "") &&
      inferDefaultModelSource(settings) === "api-provider"
        ? (availableModels.find((model) => model.id === settings.defaultModel)
            ?.name ?? settings.defaultModel)
        : "",
    [availableModels, settings],
  );
  const selectedTuttiManagedModelName = useMemo(
    () =>
      inferDefaultModelSource(settings) === "tutti-managed"
        ? (tuttiManagedModels.find(
            (model) => model.id === settings.defaultModel,
          )?.name ?? "")
        : "",
    [tuttiManagedModels, settings],
  );
  const selectedOpenAIPreset = getSelectedApiProviderPreset(settings, "openai");
  const selectedAnthropicPreset = getSelectedApiProviderPreset(
    settings,
    "anthropic",
  );

  function updateField<Key extends keyof WorkspaceSettings>(
    key: Key,
    value: WorkspaceSettings[Key],
  ) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function selectDefaultModel(
    modelId: string,
    source: NonNullable<WorkspaceSettings["defaultModelSource"]>,
  ) {
    setSettings((current) => ({
      ...current,
      defaultModel: modelId,
      defaultModelSource: modelId ? source : undefined,
    }));
  }

  async function handleOpenLocalAgentManager(provider: string) {
    setFeedback(null);
    setOpeningLocalAgentManagerProvider(provider);
    try {
      await openTuttiAgentManager();
      setFeedback({
        type: "success",
        message: t("agentSettings.local.feedback.managerOpened"),
      });
    } catch {
      setFeedback({
        type: "error",
        message: t("agentSettings.local.feedback.openManagerFailed"),
      });
    } finally {
      setOpeningLocalAgentManagerProvider(null);
    }
  }

  async function handleConnectTuttiManaged() {
    setFeedback(null);
    setConnectingTuttiManaged(true);
    try {
      const grant = await requestTuttiManagedGrant();
      const response = await connectTuttiManagedModels(grant);
      setTuttiManagedConnection(response.connection);
      await refreshAvailableModels();
      setActiveSourceTab("tutti-managed");
      setFeedback({
        type: "success",
        message: t("agentSettings.tuttiManaged.feedback.connected"),
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : t("agentSettings.tuttiManaged.feedback.connectFailed"),
      });
    } finally {
      setConnectingTuttiManaged(false);
    }
  }

  async function handleDisconnectTuttiManaged() {
    setFeedback(null);
    setConnectingTuttiManaged(true);
    try {
      const response = await disconnectTuttiManagedModels();
      setTuttiManagedConnection(response.connection);
      await refreshAvailableModels();
      if (
        tuttiManagedModels.some((model) => model.id === settings.defaultModel)
      ) {
        updateField("defaultModel", "");
        updateField("defaultModelSource", undefined);
      }
      setFeedback({
        type: "success",
        message: t("agentSettings.tuttiManaged.feedback.disconnected"),
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : t("agentSettings.tuttiManaged.feedback.disconnectFailed"),
      });
    } finally {
      setConnectingTuttiManaged(false);
    }
  }

  async function handleOpenTuttiManagedSettings() {
    try {
      await openTuttiManagedModelSettings();
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : t("agentSettings.tuttiManaged.feedback.openSettingsFailed"),
      });
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);

    try {
      await onSave({
        ...settings,
        agnesDefaultModel:
          settings.providerModels.agnes[0] || settings.agnesDefaultModel,
      });
      void refreshAvailableModels();
      setFeedback({
        type: "success",
        message: t("agentSettings.feedback.updated"),
      });
      onSaved?.();
    } catch {
      setFeedback({
        type: "error",
        message: t("agentSettings.feedback.updateFailed"),
      });
    } finally {
      setSaving(false);
    }
  }

  const isDialog = surface === "dialog";

  return (
    <div className={isDialog ? "flex min-h-0 flex-1 flex-col" : "space-y-6"}>
      <div className={isDialog ? "px-6 pt-6 md:px-8" : undefined}>
        <h2 className="text-lg font-semibold">{t("tabs.agent.label")}</h2>
      </div>

      <form
        onSubmit={handleSubmit}
        className={isDialog ? "flex min-h-0 flex-1 flex-col" : "space-y-5"}
      >
        <div
          className={
            isDialog
              ? "min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 pt-5 md:px-8"
              : "space-y-5 pb-24"
          }
        >
          <SettingsSegmentTabs
            columns={3}
            items={[
              {
                value: "local-agent" as const,
                label: t("agentSettings.source.localAgent"),
                description: t("agentSettings.source.detected", {
                  cliCount: localCliProviderCount,
                }),
                icon: Terminal,
              },
              {
                value: "tutti-managed" as const,
                label: t("agentSettings.source.tuttiManaged"),
                description: tuttiManagedConnection.connected
                  ? t("agentSettings.tuttiManaged.connected")
                  : t("agentSettings.tuttiManaged.notConnected"),
                icon: Cloud,
              },
              {
                value: "api-provider" as const,
                label: t("agentSettings.source.apiProvider"),
                description: "BYOK",
                icon: Cloud,
              },
            ]}
            onValueChange={setActiveSourceTab}
            value={activeSourceTab}
          />

          {activeSourceTab === "local-agent" ? (
            <div className="space-y-5">
              <LocalCliProviderModelPicker
                providerGroups={localCliProviderGroups}
                activeProvider={activeLocalProvider}
                onProviderChange={setActiveLocalProvider}
                onSelect={(modelId) =>
                  selectDefaultModel(modelId, "local-agent")
                }
                onRescan={() =>
                  refreshAvailableModels({ refreshLocalAgents: true })
                }
                onManageProvider={handleOpenLocalAgentManager}
                openingManagerProvider={openingLocalAgentManagerProvider}
              />
            </div>
          ) : null}

          {activeSourceTab === "tutti-managed" ? (
            <section className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">
                    {t("agentSettings.tuttiManaged.title")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("agentSettings.tuttiManaged.description")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleOpenTuttiManagedSettings}
                  >
                    {t("agentSettings.tuttiManaged.manageInTutti")}
                  </Button>
                  {tuttiManagedConnection.connected ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={connectingTuttiManaged}
                      onClick={handleDisconnectTuttiManaged}
                    >
                      {t("agentSettings.tuttiManaged.disconnect")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    disabled={connectingTuttiManaged || !tuttiBridgeAvailable}
                    onClick={handleConnectTuttiManaged}
                  >
                    {connectingTuttiManaged ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {tuttiManagedConnection.connected
                      ? t("agentSettings.tuttiManaged.reauthorize")
                      : t("agentSettings.tuttiManaged.connect")}
                  </Button>
                </div>
              </div>

              {!tuttiBridgeAvailable ? (
                <div className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
                  {t("agentSettings.tuttiManaged.bridgeUnavailable")}
                </div>
              ) : null}

              <div className="rounded-xl border bg-muted/20 p-4">
                <p className="text-sm font-medium text-foreground">
                  {t("agentSettings.tuttiManaged.defaultModel")}
                </p>
                <p className="mt-2 truncate text-sm text-foreground">
                  {selectedTuttiManagedModelName ||
                    t("agentSettings.tuttiManaged.noModelSelected")}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {selectedTuttiManagedModelName
                    ? settings.defaultModel
                    : t("agentSettings.tuttiManaged.chooseModel")}
                </p>
              </div>

              {tuttiManagedModels.length > 0 ? (
                <div className="space-y-2">
                  {tuttiManagedModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() =>
                        selectDefaultModel(model.id, "tutti-managed")
                      }
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                        settings.defaultModel === model.id
                          ? "border-accent bg-accent/10"
                          : "border-border hover:border-accent/40"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {model.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {model.id}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {model.provider}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">
                  {tuttiManagedConnection.connected
                    ? t("agentSettings.tuttiManaged.emptyModels")
                    : t("agentSettings.tuttiManaged.connectFirst")}
                </div>
              )}
            </section>
          ) : null}

          {activeSourceTab === "api-provider" ? (
            <>
              <section className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="mb-4">
                  <h3 className="text-base font-semibold">
                    {t("agentSettings.api.defaultModelTitle")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("agentSettings.api.defaultModelDescription")}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {t("agentSettings.api.defaultLlmModel")}
                    </p>
                    <p className="mt-2 truncate text-sm text-foreground">
                      {selectedModelName ||
                        t("agentSettings.api.noApiProviderModelSelected")}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {selectedModelName
                        ? settings.defaultModel
                        : t("agentSettings.api.chooseApiProviderModelBelow")}
                    </p>
                  </div>
                  {modelPickerGroups.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                          />
                        }
                        aria-label={t("agentSettings.api.browseModels")}
                      >
                        {t("agentSettings.api.chooseModel")}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="w-72"
                      >
                        <div className="px-2 py-1.5">
                          <p className="text-sm font-medium text-foreground">
                            {t("agentSettings.api.workspaceModels")}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("agentSettings.api.workspaceModelsDescription")}
                          </p>
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuRadioGroup
                            value={settings.defaultModel}
                            onValueChange={(value) =>
                              selectDefaultModel(
                                value as string,
                                "api-provider",
                              )
                            }
                          >
                            {modelPickerGroups.map((protocol, groupIndex) => (
                              <div key={protocol.id}>
                                <DropdownMenuLabel>
                                  {protocol.label}
                                </DropdownMenuLabel>
                                {protocol.models.map((model) => (
                                  <DropdownMenuRadioItem
                                    key={model.id}
                                    value={model.id}
                                    aria-label={t(
                                      "agentSettings.api.useModel",
                                      { model: model.name },
                                    )}
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate font-medium">
                                        {model.name}
                                      </div>
                                      <div className="truncate text-xs text-muted-foreground">
                                        {model.id}
                                      </div>
                                    </div>
                                  </DropdownMenuRadioItem>
                                ))}
                                {groupIndex < modelPickerGroups.length - 1 ? (
                                  <DropdownMenuSeparator />
                                ) : null}
                              </div>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <Button type="button" size="sm" variant="outline" disabled>
                      {t("agentSettings.api.noModelsYet")}
                    </Button>
                  )}
                </div>
              </section>

              <section className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="mb-4">
                  <h3 className="text-base font-semibold">
                    {t("agentSettings.api.protocolCredentials")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("agentSettings.api.protocolDescription")}
                  </p>
                </div>

                <div className="mb-5 flex flex-wrap gap-2">
                  {AGENT_CREDENTIAL_PROTOCOLS.map((protocol) => (
                    <button
                      key={protocol.id}
                      type="button"
                      onClick={() => setActiveProtocol(protocol.id)}
                      className={`rounded-full border px-3 py-2 text-sm transition-colors ${
                        activeProtocol === protocol.id
                          ? "border-accent/40 bg-accent/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {protocol.label}
                    </button>
                  ))}
                </div>

                {activeProtocol === "agnes" ? (
                  <div className="space-y-4">
                    <AgnesQuickstartHint />
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="agnesApiKey">Agnes API Key</Label>
                        <Input
                          id="agnesApiKey"
                          value={settings.agnesApiKey}
                          onChange={(event) =>
                            updateField("agnesApiKey", event.target.value)
                          }
                          placeholder="sk-..."
                        />
                        <ApiKeyLinkButton
                          href={AGNES_API_KEYS_URL}
                          providerLabel="Agnes"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="agnesBaseUrl">Agnes Base URL</Label>
                        <Input
                          id="agnesBaseUrl"
                          value={settings.agnesBaseUrl}
                          onChange={(event) =>
                            updateField("agnesBaseUrl", event.target.value)
                          }
                          placeholder="https://apihub.agnes-ai.com/v1"
                        />
                      </div>
                    </div>
                    <ProviderModelListEditor
                      provider="agnes"
                      settings={settings}
                      availableModels={availableModels}
                      onChange={(nextValues) =>
                        setSettings((current) =>
                          applyProviderModelUpdate(
                            current,
                            "agnes",
                            nextValues,
                          ),
                        )
                      }
                    />
                  </div>
                ) : null}

                {activeProtocol === "openai" ? (
                  <div className="space-y-4">
                    <QuickFillProviderField
                      provider="openai"
                      settings={settings}
                      onChange={(preset) =>
                        setSettings((current) =>
                          applyApiProviderPreset(current, "openai", preset),
                        )
                      }
                    />
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="openAIApiKey">OpenAI API Key</Label>
                        <Input
                          id="openAIApiKey"
                          value={settings.openAIApiKey}
                          onChange={(event) =>
                            updateField("openAIApiKey", event.target.value)
                          }
                          placeholder="sk-..."
                        />
                        {selectedOpenAIPreset ? (
                          <ApiKeyLinkButton
                            href={selectedOpenAIPreset.apiKeyUrl}
                            providerLabel={selectedOpenAIPreset.label}
                          />
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="openAIApiBase">OpenAI Base URL</Label>
                        <Input
                          id="openAIApiBase"
                          value={settings.openAIApiBase}
                          onChange={(event) =>
                            updateField("openAIApiBase", event.target.value)
                          }
                          placeholder="http://127.0.0.1:4000/v1"
                        />
                      </div>
                    </div>
                    <ProviderModelListEditor
                      provider="openai"
                      settings={settings}
                      availableModels={availableModels}
                      onChange={(nextValues) =>
                        setSettings((current) =>
                          applyProviderModelUpdate(
                            current,
                            "openai",
                            nextValues,
                          ),
                        )
                      }
                    />
                  </div>
                ) : null}

                {activeProtocol === "google" ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="googleApiKey">Google API Key</Label>
                      <Input
                        id="googleApiKey"
                        value={settings.googleApiKey}
                        onChange={(event) =>
                          updateField("googleApiKey", event.target.value)
                        }
                        placeholder="AIza..."
                      />
                    </div>
                    <ProviderModelListEditor
                      provider="google"
                      settings={settings}
                      availableModels={availableModels}
                      onChange={(nextValues) =>
                        setSettings((current) =>
                          applyProviderModelUpdate(
                            current,
                            "google",
                            nextValues,
                          ),
                        )
                      }
                    />
                  </div>
                ) : null}

                {activeProtocol === "vertex" ? (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <Label htmlFor="googleVertexProject">
                          Vertex Project
                        </Label>
                        <Input
                          id="googleVertexProject"
                          value={settings.googleVertexProject}
                          onChange={(event) =>
                            updateField(
                              "googleVertexProject",
                              event.target.value,
                            )
                          }
                          placeholder="my-gcp-project"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="googleVertexLocation">
                          Vertex Location
                        </Label>
                        <Input
                          id="googleVertexLocation"
                          value={settings.googleVertexLocation}
                          onChange={(event) =>
                            updateField(
                              "googleVertexLocation",
                              event.target.value,
                            )
                          }
                          placeholder="global"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="googleVertexVideoLocation">
                          Vertex Video Location
                        </Label>
                        <Input
                          id="googleVertexVideoLocation"
                          value={settings.googleVertexVideoLocation}
                          onChange={(event) =>
                            updateField(
                              "googleVertexVideoLocation",
                              event.target.value,
                            )
                          }
                          placeholder="us-central1"
                        />
                      </div>
                    </div>
                    <ProviderModelListEditor
                      provider="vertex"
                      settings={settings}
                      availableModels={availableModels}
                      onChange={(nextValues) =>
                        setSettings((current) =>
                          applyProviderModelUpdate(
                            current,
                            "vertex",
                            nextValues,
                          ),
                        )
                      }
                    />
                  </div>
                ) : null}

                {activeProtocol === "anthropic" ? (
                  <div className="space-y-4">
                    <QuickFillProviderField
                      provider="anthropic"
                      settings={settings}
                      onChange={(preset) =>
                        setSettings((current) =>
                          applyApiProviderPreset(current, "anthropic", preset),
                        )
                      }
                    />
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="anthropicApiKey">
                          Anthropic API Key
                        </Label>
                        <Input
                          id="anthropicApiKey"
                          value={settings.anthropicApiKey}
                          onChange={(event) =>
                            updateField("anthropicApiKey", event.target.value)
                          }
                          placeholder="sk-ant-..."
                        />
                        {selectedAnthropicPreset ? (
                          <ApiKeyLinkButton
                            href={selectedAnthropicPreset.apiKeyUrl}
                            providerLabel={selectedAnthropicPreset.label}
                          />
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="anthropicBaseUrl">
                          Anthropic Base URL
                        </Label>
                        <Input
                          id="anthropicBaseUrl"
                          value={settings.anthropicBaseUrl}
                          onChange={(event) =>
                            updateField("anthropicBaseUrl", event.target.value)
                          }
                          placeholder="https://api.anthropic.com"
                        />
                      </div>
                    </div>
                    <ProviderModelListEditor
                      provider="anthropic"
                      settings={settings}
                      availableModels={availableModels}
                      onChange={(nextValues) =>
                        setSettings((current) =>
                          applyProviderModelUpdate(
                            current,
                            "anthropic",
                            nextValues,
                          ),
                        )
                      }
                    />
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </div>

        <div
          data-testid="agent-settings-save-footer"
          className={
            isDialog
              ? "shrink-0 border-t bg-card px-6 py-4 md:px-8"
              : "sticky bottom-0 z-10 -mx-6 -mb-6 flex items-center justify-between gap-3 border-t bg-card/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-card/80 md:-mx-8 md:-mb-8 md:px-8"
          }
        >
          <div className="flex w-full items-center gap-3">
            {feedback ? (
              <p
                className={`min-w-0 flex-1 text-sm ${
                  feedback.type === "success"
                    ? "text-success"
                    : "text-destructive"
                }`}
              >
                {feedback.message}
              </p>
            ) : (
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                {hasChanges ? t("status.unsaved") : t("status.upToDate")}
              </span>
            )}

            <Button
              type="submit"
              disabled={saving || !hasChanges}
              className="ml-auto min-w-24"
            >
              {saving
                ? t("agentSettings.actions.saving")
                : t("common:actions.save")}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
