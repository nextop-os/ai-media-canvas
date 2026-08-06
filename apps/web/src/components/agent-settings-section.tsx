"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  LocalAgentProviderInfo,
  LocalAgentTargetInfo,
  ModelInfo,
  WorkspaceSettings,
} from "@aimc/shared";

import { useAppTranslation } from "@/i18n";
import type { AgentModelSourceTab } from "@/lib/agent-model-groups";
import { fetchModels } from "@/lib/server-api";
import { openTuttiAgentManager } from "@/lib/tutti-agent-manager";
import { useTuttiAgentTargetIconUrls } from "@/lib/tutti-agent-target-presentations";
import { LocalCliProviderIcon } from "./local-cli-provider-icon";
import { Button } from "./ui/button";

interface AgentSettingsSectionProps {
  initialSourceTab?: AgentModelSourceTab | undefined;
  onSaved?: (() => void) | undefined;
  settings: WorkspaceSettings;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  surface?: "page" | "dialog";
}

type LocalCliProviderGroup = {
  available: boolean;
  defaultModelId?: string | undefined;
  iconUrl?: string | undefined;
  provider: string;
  label: string;
  models: ModelInfo[];
  reason?: string | undefined;
};

function normalizeAgentSettings(
  settings: WorkspaceSettings,
): WorkspaceSettings {
  return {
    ...settings,
    defaultModelSource: settings.defaultModel ? "local-agent" : undefined,
  };
}

function groupLocalCliProviders(
  targets: LocalAgentTargetInfo[],
  providers: LocalAgentProviderInfo[],
  iconUrls: ReadonlyMap<string, string>,
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
            iconUrl: iconUrls.get(matchingTargets[0]?.agentTargetId ?? ""),
          }
        : {}),
      provider: provider.provider,
      label: provider.displayName,
      models: provider.models,
      ...(provider.reason ? { reason: provider.reason } : {}),
    };
  });
}

function getDefaultModel(group: LocalCliProviderGroup) {
  return (
    group.models.find((model) => model.id === group.defaultModelId) ??
    group.models.find((model) => model.id === `${group.provider}:default`) ??
    group.models.find((model) => model.id !== `${group.provider}:default`) ??
    group.models[0] ??
    null
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

      {providerGroups.length > 0 ? (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("agentSettings.local.detectedCli")}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {providerGroups.map((group) => {
              const selected = activeGroup?.provider === group.provider;
              const openingManager = openingManagerProvider === group.provider;
              return (
                <button
                  key={group.provider}
                  type="button"
                  aria-pressed={selected}
                  aria-busy={openingManager}
                  disabled={openingManager}
                  onClick={() => {
                    if (!group.available) {
                      onManageProvider(group.provider);
                      return;
                    }
                    onProviderChange(group.provider);
                    const defaultModel = getDefaultModel(group);
                    if (defaultModel) onSelect(defaultModel.id);
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
  initialSourceTab: _initialSourceTab,
  onSaved,
  settings: initialSettings,
  onSave,
  surface = "page",
}: AgentSettingsSectionProps) {
  const { t } = useAppTranslation("settings");
  const iconUrls = useTuttiAgentTargetIconUrls();
  const [settings, setSettings] = useState(() =>
    normalizeAgentSettings(initialSettings),
  );
  const [localAgentTargets, setLocalAgentTargets] = useState<
    LocalAgentTargetInfo[]
  >([]);
  const [localAgentProviders, setLocalAgentProviders] = useState<
    LocalAgentProviderInfo[]
  >([]);
  const [activeLocalProvider, setActiveLocalProvider] = useState("");
  const [saving, setSaving] = useState(false);
  const [openingManagerProvider, setOpeningManagerProvider] = useState<
    string | null
  >(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const refreshAvailableModels = useCallback(async () => {
    const response = await fetchModels({ refresh: true });
    setLocalAgentProviders(response.localAgentProviders ?? []);
    setLocalAgentTargets(response.localAgentTargets ?? []);
  }, []);

  useEffect(() => {
    setSettings(normalizeAgentSettings(initialSettings));
  }, [initialSettings]);

  useEffect(() => {
    void refreshAvailableModels().catch(() => undefined);
  }, [refreshAvailableModels]);

  const localProviderGroups = useMemo(
    () =>
      groupLocalCliProviders(localAgentTargets, localAgentProviders, iconUrls),
    [iconUrls, localAgentProviders, localAgentTargets],
  );
  const selectedProvider = settings.defaultModel.split(":", 1)[0] ?? "";
  const hasChanges =
    JSON.stringify(normalizeAgentSettings(initialSettings)) !==
    JSON.stringify(settings);
  const isDialog = surface === "dialog";

  useEffect(() => {
    if (!selectedProvider || localProviderGroups.length === 0) {
      setActiveLocalProvider("");
      return;
    }
    if (
      localProviderGroups.some((group) => group.provider === selectedProvider)
    ) {
      setActiveLocalProvider(selectedProvider);
      return;
    }
    setActiveLocalProvider(localProviderGroups[0]?.provider ?? "");
  }, [localProviderGroups, selectedProvider]);

  async function openAgentManager(provider: string) {
    setOpeningManagerProvider(provider);
    setFeedback(null);
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
      setOpeningManagerProvider(null);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await onSave(settings);
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
          <LocalCliProviderModelPicker
            providerGroups={localProviderGroups}
            activeProvider={activeLocalProvider}
            onProviderChange={setActiveLocalProvider}
            onSelect={(modelId) =>
              setSettings((current) => ({
                ...current,
                defaultModel: modelId,
                defaultModelSource: "local-agent",
              }))
            }
            onRescan={() =>
              void refreshAvailableModels().catch(() => undefined)
            }
            onManageProvider={(provider) => void openAgentManager(provider)}
            openingManagerProvider={openingManagerProvider}
          />
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
