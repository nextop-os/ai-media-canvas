"use client";

import { useAgentModel } from "@/hooks/use-agent-model";
import {
  type AgentModelSourceTab,
  formatLocalCliProviderLabel,
  getAgentModelSourceTab,
  getModelSourceTab,
  isLocalCliProvider,
  localAgentProvidersFromModelResponse,
} from "@/lib/agent-model-groups";
import { fetchModels, fetchWorkspaceSettings } from "@/lib/server-api";
import { useTuttiAgentTargetIconUrls } from "@/lib/tutti-agent-target-presentations";
import { WORKSPACE_SETTINGS_UPDATED_EVENT } from "@/lib/workspace-settings-events";
import type {
  LocalAgentProviderInfo,
  LocalAgentTargetInfo,
} from "@aimc/shared";
import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppTranslation } from "../i18n";
import { LocalCliProviderIcon } from "./local-cli-provider-icon";
import { SettingsDialog } from "./settings-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type ModelOption = {
  description?: string | undefined;
  id: string;
  name: string;
  provider: string;
  source?: AgentModelSourceTab | undefined;
};

type PopoverCollisionSide = "flip" | "none" | "shift";

// Sparkle icon SVG path from design spec
const SPARKLE_ICON_PATH =
  "M7.314 1.451a5.527 5.527 0 0 0 5.519 5.242v.614a5.527 5.527 0 0 0-5.519 5.242l-.007.284h-.614l-.007-.284a5.527 5.527 0 0 0-5.519-5.242v-.614a5.527 5.527 0 0 0 5.519-5.242l.007-.284h.614zm4.31 8.125c.042.835.733 1.5 1.58 1.5v.176c-.847 0-1.538.664-1.58 1.5l-.002.081h-.176l-.002-.081a1.58 1.58 0 0 0-1.579-1.5v-.176c.846 0 1.537-.665 1.58-1.5l.001-.08h.176zM7 4.204A6.6 6.6 0 0 1 4.205 7 6.6 6.6 0 0 1 7 9.795 6.6 6.6 0 0 1 9.794 7 6.6 6.6 0 0 1 7 4.204";

const CHECK_PATH =
  "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0";

const TRIGGER_PROVIDER_ACCENT_CLASSES: Record<string, string> = {
  agnes: "border-[#111827] text-[#111827]",
  anthropic: "border-[#D97757] text-[#C75F3B]",
  "claude-code": "border-[#D97757] text-[#C75F3B]",
  codex: "border-[#6F7CFF] text-[#4F5DFF]",
  google: "border-[#4285F4] text-[#2563EB]",
  openai: "border-[#111827] text-[#111827]",
  vertex: "border-[#4285F4] text-[#2563EB]",
};

function getTriggerAccentClasses(provider: string) {
  return (
    TRIGGER_PROVIDER_ACCENT_CLASSES[provider] ??
    "border-foreground text-foreground"
  );
}

function formatProviderLabel(provider: string) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "agnes":
      return "Agnes";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "vertex":
      return "Vertex";
    case "codex":
      return "Codex";
    case "local":
      return "Local";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function formatDefaultModelLabel(
  modelId: string | null,
  models: ModelOption[],
) {
  if (!modelId) return null;
  const provider = getModelProvider(modelId);
  if (
    provider &&
    isLocalCliProvider(provider) &&
    modelId === `${provider}:default`
  ) {
    return models.find((model) => model.id === modelId)?.name ?? "default";
  }
  const matchingModel = models.find((model) => model.id === modelId);
  if (matchingModel) return matchingModel.name;
  const [, scopedId = modelId] = modelId.split(":");
  return scopedId;
}

function resolveExecutableModelId(modelId: string) {
  return modelId;
}

function getModelProvider(modelId: string | null | undefined) {
  return modelId?.includes(":") ? (modelId.split(":", 1)[0] ?? "") : "";
}

function ProviderLogo({
  iconUrl,
  provider,
}: {
  iconUrl?: string | undefined;
  provider: string;
}) {
  if (isLocalCliProvider(provider)) {
    return (
      <LocalCliProviderIcon
        provider={provider}
        iconUrl={iconUrl}
        label={formatLocalCliProviderLabel(provider)}
        className="size-4 rounded-sm"
        iconSize={15}
      />
    );
  }
  return null;
}

function ModelTriggerTooltip({
  label,
  placement,
}: {
  label: string;
  placement: "top" | "bottom";
}) {
  const placementClass =
    placement === "bottom" ? "top-full mt-2" : "bottom-full mb-2";
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute left-1/2 z-50 ${placementClass} -translate-x-1/2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100`}
    >
      {label}
    </span>
  );
}

export function AgentModelSelector({
  collisionSide = "none",
  compact,
  tooltipPlacement = "top",
}: {
  collisionSide?: PopoverCollisionSide;
  compact?: boolean;
  tooltipPlacement?: "top" | "bottom";
} = {}) {
  const { t } = useAppTranslation("chat");
  const { agentTargetId, model, modelSource, setModel } = useAgentModel();
  const agentTargetIconUrls = useTuttiAgentTargetIconUrls();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSourceTab, setSettingsInitialSourceTab] = useState<
    AgentModelSourceTab | undefined
  >();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelLoadState, setModelLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [localAgentProviders, setLocalAgentProviders] = useState<
    LocalAgentProviderInfo[]
  >([]);
  const [localAgentTargets, setLocalAgentTargets] = useState<
    LocalAgentTargetInfo[]
  >([]);
  const [workspaceDefaultModel, setWorkspaceDefaultModel] = useState<
    string | null
  >(null);
  const [workspaceDefaultModelSource, setWorkspaceDefaultModelSource] =
    useState<AgentModelSourceTab | null>(null);

  const loadModels = useCallback(() => {
    setModelLoadState("loading");
    fetchModels()
      .then((data) => {
        const providers = localAgentProvidersFromModelResponse(data);
        setModels(data.models);
        setLocalAgentProviders(providers);
        setLocalAgentTargets(
          data.localAgentTargets ??
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
        setModelLoadState("ready");
      })
      .catch(() => setModelLoadState("error"));

    fetchWorkspaceSettings()
      .then((data) => {
        setWorkspaceDefaultModel(data.settings.defaultModel || null);
        setWorkspaceDefaultModelSource(
          data.settings.defaultModelSource ?? null,
        );
      })
      .catch(() => {});
  }, []);

  // Fetch available models on mount and whenever the picker opens so the
  // homepage selector stays in sync with recent settings changes.
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    const handleSettingsUpdated = () => {
      loadModels();
    };
    window.addEventListener(
      WORKSPACE_SETTINGS_UPDATED_EVENT,
      handleSettingsUpdated,
    );
    return () => {
      window.removeEventListener(
        WORKSPACE_SETTINGS_UPDATED_EVENT,
        handleSettingsUpdated,
      );
    };
  }, [loadModels]);

  useEffect(() => {
    if (!open) return;
    loadModels();
  }, [loadModels, open]);

  const selectedModel = models.find((m) => m.id === model);
  const selectedModelSource =
    modelSource ??
    (selectedModel
      ? getModelSourceTab(selectedModel)
      : getAgentModelSourceTab(model));
  const selectedProvider = selectedModel?.provider || getModelProvider(model);
  const resolvedWorkspaceDefaultModelSource =
    workspaceDefaultModelSource ??
    getAgentModelSourceTab(workspaceDefaultModel);
  const workspaceDefaultProvider = getModelProvider(workspaceDefaultModel);
  const availableLocalProviderIds = new Set(
    localAgentProviders
      .filter((provider) => provider.supported)
      .map((provider) => provider.provider),
  );
  const selectedProviderIsSupportedLocal =
    selectedModelSource === "local-agent" &&
    selectedProvider &&
    isLocalCliProvider(selectedProvider) &&
    availableLocalProviderIds.has(selectedProvider);
  const selectedProviderIsUnsupportedLocal =
    selectedModelSource === "local-agent" &&
    selectedProvider &&
    isLocalCliProvider(selectedProvider) &&
    !availableLocalProviderIds.has(selectedProvider);
  const workspaceDefaultProviderIsSupportedLocal =
    resolvedWorkspaceDefaultModelSource === "local-agent" &&
    workspaceDefaultProvider &&
    isLocalCliProvider(workspaceDefaultProvider) &&
    availableLocalProviderIds.has(workspaceDefaultProvider);
  const workspaceDefaultProviderIsUnsupportedLocal =
    resolvedWorkspaceDefaultModelSource === "local-agent" &&
    workspaceDefaultProvider &&
    isLocalCliProvider(workspaceDefaultProvider) &&
    !availableLocalProviderIds.has(workspaceDefaultProvider);
  const triggerLocalProvider = selectedProviderIsSupportedLocal
    ? selectedProvider
    : !model && workspaceDefaultProviderIsSupportedLocal
      ? workspaceDefaultProvider
      : "";
  const triggerLocalProviderLabel = triggerLocalProvider
    ? (localAgentTargets.find(
        (target) => target.agentTargetId === agentTargetId,
      )?.displayName ??
      localAgentProviders.find(
        (provider) => provider.provider === triggerLocalProvider,
      )?.displayName ??
      null)
    : null;
  const triggerLocalTarget = localAgentTargets.find(
    (target) => target.agentTargetId === agentTargetId,
  );
  const triggerLocalIconUrl = triggerLocalTarget
    ? agentTargetIconUrls.get(triggerLocalTarget.agentTargetId)
    : undefined;
  const isActive = model !== null;
  const isTriggerActive = isActive || Boolean(triggerLocalProvider);
  const displayLabel =
    triggerLocalProviderLabel ??
    (selectedModel
      ? selectedModel.name
      : selectedProviderIsUnsupportedLocal
        ? null
        : formatDefaultModelLabel(model, models)) ??
    "Agent";
  const defaultModelLabel = workspaceDefaultProviderIsUnsupportedLocal
    ? null
    : formatDefaultModelLabel(workspaceDefaultModel, models);

  const visibleModels = models;
  const providers = localAgentTargets.map((target) => target.agentTargetId);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={`group relative flex items-center justify-center box-border rounded-full border-[0.5px] cursor-pointer bg-background font-inter transition-[border-color,background-color,color] duration-100 ease-in-out ${
                compact ? "h-8 px-2.5" : "h-8 px-3"
              } ${
                isTriggerActive
                  ? `${getTriggerAccentClasses(selectedProvider || triggerLocalProvider)} shadow-[0_1px_4px_rgba(0,0,0,0.06)]`
                  : "border-border text-foreground hover:bg-muted"
              }`}
            >
              <span className="flex items-center justify-center gap-1">
                {triggerLocalProvider ? (
                  <LocalCliProviderIcon
                    provider={triggerLocalProvider}
                    iconUrl={triggerLocalIconUrl}
                    label={triggerLocalProviderLabel ?? displayLabel}
                    className="size-4 rounded-sm"
                    iconSize={15}
                  />
                ) : (
                  <svg
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    fill="none"
                    viewBox="0 0 14 14"
                    className="[&_path]:fill-current"
                  >
                    <path fill="currentColor" d={SPARKLE_ICON_PATH} />
                  </svg>
                )}
                <span className={compact ? "text-[11px]" : "text-xs"}>
                  {displayLabel}
                </span>
              </span>
              <ModelTriggerTooltip
                label={t("agentModelSelector.tooltip")}
                placement={tooltipPlacement}
              />
            </button>
          }
        />
        <PopoverContent
          align="start"
          className="max-h-[min(28rem,calc(100vh-2rem))] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border-[0.5px] border-border bg-popover p-2 shadow-lg"
          collisionAvoidance={{
            align: "shift",
            fallbackAxisSide: "none",
            side: collisionSide,
          }}
          collisionPadding={8}
          side="bottom"
          sideOffset={8}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t("agentModelSelector.assistantMode")}
            </div>
            <button
              type="button"
              aria-label={t("agentModelSelector.openSettings")}
              onClick={() => {
                setOpen(false);
                setSettingsInitialSourceTab(undefined);
                setSettingsOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-full border-[0.5px] border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings2 className="h-3 w-3" />
              {t("agentModelSelector.settings")}
            </button>
          </div>
          {/* Auto option */}
          <button
            type="button"
            onClick={() => {
              setModel(null);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
              !isActive
                ? "bg-accent/10 text-accent-foreground"
                : "hover:bg-muted"
            }`}
          >
            <span className="flex-1 text-left">
              <span className="block">
                {t("agentModelSelector.localAssistant")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {defaultModelLabel
                  ? t("agentModelSelector.usesDefaultModel", {
                      model: defaultModelLabel,
                    })
                  : t("agentModelSelector.usesConfiguredDefaultRoute")}
              </span>
            </span>
            {!isActive && (
              <svg
                aria-hidden="true"
                className="h-3 w-3 text-accent-foreground"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d={CHECK_PATH} />
              </svg>
            )}
          </button>
          {/* Group by provider */}
          {providers.map((provider) => {
            const localTarget = localAgentTargets.find(
              (target) => target.agentTargetId === provider,
            );
            const runtimeProvider = localTarget?.providerId ?? provider;
            const providerModels = localTarget
              ? localTarget.models
              : visibleModels.filter((m) => m.provider === provider);
            const localProvider = localAgentProviders.find(
              (entry) => entry.provider === runtimeProvider,
            );
            if (providerModels.length === 0 && !localTarget && !localProvider)
              return null;
            return (
              <div key={provider} className="mt-2">
                <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  <ProviderLogo
                    provider={runtimeProvider}
                    iconUrl={
                      localTarget
                        ? agentTargetIconUrls.get(localTarget.agentTargetId)
                        : undefined
                    }
                  />
                  {localTarget
                    ? localTarget.displayName
                    : isLocalCliProvider(runtimeProvider)
                      ? (localProvider?.displayName ??
                        formatLocalCliProviderLabel(runtimeProvider))
                      : formatProviderLabel(provider)}
                </div>
                {localTarget &&
                (localTarget.reason || !localTarget.available) ? (
                  <div className="rounded-lg px-2 py-2 text-xs text-muted-foreground">
                    {localTarget.reason ??
                      t("agentModelSelector.providerUnavailable")}
                  </div>
                ) : null}
                {providerModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={Boolean(localTarget && !localTarget.available)}
                    onClick={() => {
                      if (localTarget && !localTarget.available) return;
                      setModel(
                        resolveExecutableModelId(m.id),
                        getModelSourceTab(m),
                        localTarget?.agentTargetId,
                      );
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      model === m.id &&
                      (
                        !localTarget ||
                          agentTargetId === localTarget.agentTargetId
                      )
                        ? "bg-accent/10 text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate">{m.name}</span>
                      {m.description && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {m.description}
                        </span>
                      )}
                    </span>
                    {model === m.id &&
                      (!localTarget ||
                        agentTargetId === localTarget.agentTargetId) && (
                        <svg
                          aria-hidden="true"
                          className="h-3 w-3 text-accent-foreground"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                        >
                          <path d={CHECK_PATH} />
                        </svg>
                      )}
                  </button>
                ))}
              </div>
            );
          })}
          {providers.length === 0 && modelLoadState === "loading" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              {t("agentModelSelector.loadingModels")}
            </div>
          ) : null}
          {modelLoadState === "error" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              {t("agentModelSelector.loadModelsError")}
            </div>
          ) : null}
          {providers.length === 0 && modelLoadState === "ready" ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              <p>{t("agentModelSelector.noLocalCliModels")}</p>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialAgentSourceTab={settingsInitialSourceTab}
        initialTab="agent"
      />
    </>
  );
}
