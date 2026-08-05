"use client";

import type {
  AgentModelSource,
  ImageGenerationPreference,
  VideoGenerationPreference,
} from "@aimc/shared";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { AgentModelSelector } from "@/components/agent-model-selector";
import { ImageAttachmentBar } from "@/components/image-attachment-bar";
import { ImageModelPreferencePopover } from "@/components/image-model-preference";
import { ParentPathPicker } from "@/components/parent-path-picker";
import { SettingsDialog } from "@/components/settings-dialog";
import { TuttiReferenceAddControl } from "@/components/tutti-reference-add-control";
import {
  TuttiRichTextInput,
  type TuttiRichTextInputHandle,
} from "@/components/tutti-rich-text-input";
import { useAgentModelRequirement } from "@/hooks/use-agent-model-requirement";
import type {
  ImageAttachmentState,
  ReadyAttachment,
} from "@/hooks/use-image-attachments";
import { useImageModelPreference } from "@/hooks/use-image-model-preference";
import { useMediaModelConfigurationStatus } from "@/hooks/use-media-model-configuration-status";
import { useVideoModelPreference } from "@/hooks/use-video-model-preference";
import { useAppTranslation } from "@/i18n";
import type { HomeExampleSelection } from "@/lib/home-example-seeds";

export type HomePromptHandle = {
  fill: (text: string) => void;
};

type HomePromptProps = {
  onSubmit: (
    prompt: string,
    attachments?: ReadyAttachment[],
    imageGenerationPreference?: ImageGenerationPreference,
    videoGenerationPreference?: VideoGenerationPreference,
    model?: string,
    modelSource?: AgentModelSource,
  ) => void;
  disabled?: boolean;
  attachments?: ImageAttachmentState[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  isUploading?: boolean;
  readyAttachments?: ReadyAttachment[];
  selectedSeed?: HomeExampleSelection | null;
  onClearSelectedSeed?: () => void;
  /** TSH: show project parent-directory picker next to the agent selector. */
  showParentPath?: boolean;
  parentPath?: string;
  onParentPathChange?: (value: string) => void;
};

const toolbarButtons = [
  {
    name: "Agent",
    viewBox: "0 0 24 24",
    path: "M10.8 1.307a2.33 2.33 0 0 1 2.4 0l7.67 4.602A2.33 2.33 0 0 1 22 7.907v8.361a2.33 2.33 0 0 1-1.13 1.998l-7.67 4.602-.141.078a2.33 2.33 0 0 1-2.258-.078l-7.67-4.602A2.33 2.33 0 0 1 2 16.268V7.907a2.33 2.33 0 0 1 1.003-1.915l.128-.083z",
  },
] as const;

const submitIcon = {
  viewBox: "0 0 24 24",
  path: "M11.293 3.293a1 1 0 0 1 1.414 0l8 8a1 1 0 0 1-1.414 1.414L13 6.414V20a1 1 0 1 1-2 0V6.414l-6.293 6.293a1 1 0 0 1-1.414-1.414z",
};

function PromptToolbarTooltip({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {label}
    </span>
  );
}

function buildSeedImageAttachments(
  selectedSeed: HomeExampleSelection | null | undefined,
): ReadyAttachment[] {
  if (!selectedSeed) return [];

  return selectedSeed.inputItems
    .filter((item) => item.type === "image")
    .map((item, index) => ({
      assetId: `seed-${selectedSeed.categoryKey}-${index}-${item.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      url: new URL(item.imgSrc, window.location.origin).href,
      mimeType: inferImageMimeType(item.imgSrc),
      source: "upload" as const,
      name: item.name,
    }));
}

function inferImageMimeType(src: string): string {
  const path = src.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.startsWith("data:image/svg+xml")) return "image/svg+xml";
  return "image/png";
}

export const HomePrompt = forwardRef<HomePromptHandle, HomePromptProps>(
  function HomePrompt(
    {
      onSubmit,
      disabled,
      attachments,
      onAddFiles,
      onRemoveAttachment,
      isUploading,
      readyAttachments,
      selectedSeed,
      onClearSelectedSeed,
      showParentPath,
      parentPath,
      onParentPathChange,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const inputRef = useRef<TuttiRichTextInputHandle>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsInitialTab, setSettingsInitialTab] = useState<
      "agent" | "media"
    >("agent");
    const { t } = useAppTranslation("home");
    const { preference } = useImageModelPreference();
    const { preference: videoPreference } = useVideoModelPreference();
    const agentRequirement = useAgentModelRequirement();
    const {
      model: agentModel,
      modelSource: agentModelSource,
      ensureAgentModelConfigured,
    } = agentRequirement;
    const agentModelRef = useRef(agentModel);
    agentModelRef.current = agentModel;
    const agentModelSourceRef = useRef(agentModelSource);
    agentModelSourceRef.current = agentModelSource;
    const { missingImageModel, missingVideoModel } =
      useMediaModelConfigurationStatus();
    const seedImageItems =
      selectedSeed?.inputItems.filter((item) => item.type === "image") ?? [];

    useImperativeHandle(ref, () => ({
      fill(text: string) {
        setValue(text);
        requestAnimationFrame(() => {
          inputRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          window.setTimeout(() => {
            inputRef.current?.focus();
          }, 220);
        });
      },
    }));

    const hasContent =
      value.trim().length > 0 || (attachments && attachments.length > 0);

    const handleSubmit = useCallback(async () => {
      const trimmed = value.trim();
      if (
        (!trimmed &&
          (!attachments || attachments.length === 0) &&
          !selectedSeed) ||
        disabled ||
        isUploading ||
        submittingRef.current
      ) {
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        let agentModelConfigured = false;
        try {
          agentModelConfigured = await ensureAgentModelConfigured();
        } catch (error) {
          console.warn("[home] Failed to validate the selected agent model", {
            error,
          });
        }

        if (!agentModelConfigured) {
          setSettingsInitialTab("agent");
          setSettingsOpen(true);
          return;
        }

        const seedAttachments = buildSeedImageAttachments(selectedSeed);
        const mergedAttachments = [
          ...(readyAttachments ?? []),
          ...seedAttachments,
        ];

        const validatedAgentModel = agentModelRef.current;
        const validatedAgentModelSource = agentModelSourceRef.current;
        onSubmit(
          trimmed,
          mergedAttachments.length > 0 ? mergedAttachments : undefined,
          !missingImageModel &&
            preference.mode === "manual" &&
            preference.models.length > 0
            ? preference
            : undefined,
          !missingVideoModel &&
            videoPreference.mode === "manual" &&
            videoPreference.models.length > 0
            ? videoPreference
            : undefined,
          validatedAgentModel ?? undefined,
          validatedAgentModel
            ? (validatedAgentModelSource ?? undefined)
            : undefined,
        );
        setValue("");
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }, [
      attachments,
      disabled,
      ensureAgentModelConfigured,
      isUploading,
      onSubmit,
      preference,
      readyAttachments,
      selectedSeed,
      videoPreference,
      value,
      missingImageModel,
      missingVideoModel,
    ]);

    const handleOpenMediaSettings = useCallback(() => {
      setModelPopoverOpen(false);
      setSettingsInitialTab("media");
      setSettingsOpen(true);
    }, []);

    const handlePaste = useCallback(
      (event: React.ClipboardEvent) => {
        if (!onAddFiles) return;
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (files.length > 0) {
          event.preventDefault();
          onAddFiles(files);
        }
      },
      [onAddFiles],
    );

    return (
      <div className="space-y-2">
        <div className="overflow-visible rounded-xl border-[0.5px] border-border bg-muted shadow-[0_4px_8px_rgba(0,0,0,0.04)] sm:rounded-2xl">
          {attachments && onRemoveAttachment ? (
            <ImageAttachmentBar
              attachments={attachments}
              onRemove={onRemoveAttachment}
            />
          ) : null}

          {selectedSeed ? (
            <div className="flex flex-col gap-3 border-b border-border/80 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-left">
                  <div className="inline-flex w-fit items-center rounded-full border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {selectedSeed.categoryLabel}
                  </div>
                  <p className="mt-2 text-sm font-medium text-foreground">
                    {selectedSeed.title}
                  </p>
                </div>

                {onClearSelectedSeed ? (
                  <button
                    type="button"
                    onClick={onClearSelectedSeed}
                    className="shrink-0 rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t("prompt.clear")}
                  </button>
                ) : null}
              </div>

              {seedImageItems.length > 0 ? (
                <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
                  {seedImageItems.map((item) => (
                    <div
                      key={`${selectedSeed.title}-${item.imgSrc}`}
                      className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-background"
                    >
                      <img
                        src={item.imgSrc}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <TuttiRichTextInput
            ref={inputRef}
            ariaLabel={t("prompt.ariaLabel")}
            className="aimc-rich-text-field px-3 pt-3 pb-2 sm:px-4 sm:pt-4"
            disabled={disabled || submitting}
            editorClassName="aimc-rich-text-editor aimc-home-rich-text-editor min-h-[52px] bg-transparent text-sm leading-relaxed text-foreground focus:outline-none"
            menuAnchor="cursor"
            menuPlacement="bottom-start"
            placeholderClassName="aimc-rich-text-placeholder aimc-home-rich-text-placeholder min-h-[52px] text-sm leading-relaxed text-muted-foreground"
            placeholder={t("prompt.placeholder")}
            rootClassName="aimc-rich-text-root"
            value={value}
            onChange={setValue}
            onPaste={handlePaste}
            onSubmit={handleSubmit}
          />

          <div className="flex items-center justify-between px-2 pb-2 sm:px-3 sm:pb-3">
            <div className="flex items-center gap-0.5">
              {onAddFiles ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = event.target.files;
                      if (files && files.length > 0) {
                        onAddFiles(Array.from(files));
                        event.target.value = "";
                      }
                    }}
                  />
                </>
              ) : null}

              <TuttiReferenceAddControl
                className="group relative flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                disabled={Boolean(disabled || isUploading || submitting)}
                labels={{
                  addContent: t("prompt.addContent"),
                  browseReferences: t("prompt.browseReferences"),
                  uploadFile: t("prompt.attachImages"),
                }}
                tooltipPlacement="bottom"
                value={value}
                onChange={setValue}
                {...(onAddFiles
                  ? { onUploadFile: () => fileInputRef.current?.click() }
                  : {})}
              />

              <ImageModelPreferencePopover
                open={modelPopoverOpen}
                onOpenChange={setModelPopoverOpen}
                onOpenSettings={handleOpenMediaSettings}
                trigger={
                  <button
                    type="button"
                    aria-label={t("prompt.modelPreference")}
                    className="group relative flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox={toolbarButtons[0].viewBox}
                      className="h-4 w-4 fill-current"
                    >
                      <path d={toolbarButtons[0].path} />
                    </svg>
                    <PromptToolbarTooltip label={t("prompt.modelPreference")} />
                  </button>
                }
              />

              <div className="ml-1">
                <AgentModelSelector compact tooltipPlacement="bottom" />
              </div>

              {showParentPath ? (
                <div className="ml-1">
                  <ParentPathPicker
                    disabled={disabled || submitting}
                    linkExistingLabel={t("prompt.linkExistingProject")}
                    parentPath={parentPath ?? "/workspace"}
                    placeholder={t("prompt.parentPathLabel")}
                    title={t("prompt.parentPathHint")}
                    workspaceRootLabel={t("prompt.workspaceRoot")}
                    onParentPathChange={(value) =>
                      onParentPathChange?.(value)
                    }
                  />
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || isUploading || submitting || !hasContent}
              aria-label={t("prompt.submit")}
              aria-busy={submitting}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:bg-foreground/25"
            >
              {submitting ? (
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/35 border-t-background motion-reduce:animate-none"
                />
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox={submitIcon.viewBox}
                  className="h-4 w-4 fill-current"
                >
                  <path d={submitIcon.path} />
                </svg>
              )}
            </button>
          </div>

          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialTab={settingsInitialTab}
          />
        </div>
      </div>
    );
  },
);
