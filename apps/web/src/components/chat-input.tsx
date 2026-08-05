"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAppTranslation } from "@/i18n";
import type { ImageAttachmentState } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { AgentModelSelector } from "./agent-model-selector";
import type { CanvasSelectedElement } from "./canvas-editor";
import { ImageAttachmentBar } from "./image-attachment-bar";
import { ImageModelPreferencePopover } from "./image-model-preference";
import { SettingsDialog } from "./settings-dialog";
import { TuttiReferenceAddControl } from "./tutti-reference-add-control";
import {
  TuttiRichTextInput,
  type TuttiRichTextInputHandle,
} from "./tutti-rich-text-input";

type ChatInputProps = {
  onSend: (message: string) => boolean | undefined;
  onCancel?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  canceling?: boolean;
  attachments?: ImageAttachmentState[];
  canSendAttachments?: boolean;
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  isUploading?: boolean;
  selectedCanvasElements?: CanvasSelectedElement[];
};

export type ChatInputHandle = {
  focus: () => void;
  setDraft: (value: string) => void;
  restoreDraftIfEmpty: (value: string) => void;
};

function PromptToolbarTooltip({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {label}
    </span>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      onSend,
      onCancel,
      disabled,
      isRunning,
      canceling,
      attachments,
      canSendAttachments,
      onAddFiles,
      onRemoveAttachment,
      onRetryAttachment,
      isUploading,
      selectedCanvasElements,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const inputRef = useRef<TuttiRichTextInputHandle>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { preference } = useImageModelPreference();
    const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsInitialTab, setSettingsInitialTab] = useState<
      "agent" | "media"
    >("agent");
    const { t } = useAppTranslation("chat");

    useImperativeHandle(ref, () => ({
      focus() {
        inputRef.current?.focus();
      },
      setDraft(nextValue) {
        setValue(nextValue);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      },
      restoreDraftIfEmpty(nextValue) {
        setValue((currentValue) =>
          currentValue.trim() ? currentValue : nextValue,
        );
      },
    }));

    const handleSubmit = useCallback(() => {
      const trimmed = value.trim();
      const hasReadyAttachments = canSendAttachments ?? !!attachments?.length;
      if (
        (!trimmed && !hasReadyAttachments) ||
        disabled ||
        isUploading ||
        isRunning
      ) {
        return;
      }

      const sent = onSend(trimmed);
      if (sent === false) return;
      setValue("");
    }, [
      attachments,
      canSendAttachments,
      disabled,
      isUploading,
      isRunning,
      onSend,
      value,
    ]);

    const handleOpenMediaSettings = useCallback(() => {
      setModelPopoverOpen(false);
      setSettingsInitialTab("media");
      setSettingsOpen(true);
    }, []);

    const handleFileChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0 && onAddFiles) {
          onAddFiles(Array.from(files));
        }
        e.target.value = "";
      },
      [onAddFiles],
    );

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        if (!onAddFiles) return;
        const files = Array.from(e.dataTransfer.files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length > 0) {
          onAddFiles(files);
        }
      },
      [onAddFiles],
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
    }, []);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        if (!onAddFiles) return;
        const files = Array.from(e.clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
        if (files.length > 0) {
          e.preventDefault();
          onAddFiles(files);
        }
      },
      [onAddFiles],
    );

    const hasContent =
      value.trim().length > 0 || (canSendAttachments ?? !!attachments?.length);

    // Memoize canvas selection summary -- selectedCanvasElements changes on every
    // canvas interaction, but the counts only change when the selection actually differs
    const selectionSummary = useMemo(() => {
      const imageCount =
        selectedCanvasElements?.filter((el) => el.type === "image").length ?? 0;
      const totalCount = selectedCanvasElements?.length ?? 0;
      return {
        selectionImageCount: imageCount,
        selectionShapeCount: totalCount - imageCount,
        hasSelection: totalCount > 0,
      };
    }, [selectedCanvasElements]);
    const { selectionImageCount, selectionShapeCount, hasSelection } =
      selectionSummary;

    return (
      <div className="px-2 pb-2">
        <div
          className="flex min-h-[120px] flex-col justify-between gap-2 rounded-xl border-[0.5px] border-border bg-card p-2 transition-[border] focus-within:border-border"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {hasSelection && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground bg-muted/50 rounded-lg">
              <div className="flex items-center gap-1.5 min-w-0">
                {selectionImageCount > 0 && (
                  <span className="flex items-center gap-1">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                    {selectionImageCount}{" "}
                    {selectionImageCount === 1
                      ? t("selection.image")
                      : t("selection.images")}
                  </span>
                )}
                {selectionImageCount > 0 && selectionShapeCount > 0 && (
                  <span className="text-muted-foreground/40">&middot;</span>
                )}
                {selectionShapeCount > 0 && (
                  <span className="flex items-center gap-1">
                    <svg
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                    </svg>
                    {selectionShapeCount}{" "}
                    {selectionShapeCount === 1
                      ? t("selection.shape")
                      : t("selection.shapes")}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/60">
                  {t("selection.selectedOnCanvas")}
                </span>
              </div>
            </div>
          )}
          {attachments && onRemoveAttachment && (
            <ImageAttachmentBar
              attachments={attachments}
              onRemove={onRemoveAttachment}
              {...(onRetryAttachment ? { onRetry: onRetryAttachment } : {})}
            />
          )}
          <TuttiRichTextInput
            ref={inputRef}
            ariaLabel={t("input.ariaLabel")}
            className="aimc-rich-text-field"
            disabled={disabled}
            editorClassName="aimc-rich-text-editor aimc-chat-rich-text-editor min-h-[48px] max-h-60 overflow-y-auto bg-transparent px-1 text-sm leading-[1.8] text-foreground focus:outline-none"
            menuAnchor="editor"
            menuPlacement="top-start"
            placeholderClassName="aimc-rich-text-placeholder aimc-chat-rich-text-placeholder min-h-[48px] px-1 text-sm leading-[1.8] text-muted-foreground"
            placeholder={t("input.placeholder")}
            rootClassName="aimc-rich-text-root"
            value={value}
            onChange={setValue}
            onPaste={handlePaste}
            onSubmit={handleSubmit}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {onAddFiles ? (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />
              ) : null}
              <TuttiReferenceAddControl
                className="group relative flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                disabled={Boolean(disabled || isUploading || isRunning)}
                labels={{
                  addContent: t("input.addContent"),
                  browseReferences: t("input.browseReferences"),
                  uploadFile: t("input.attachImages"),
                }}
                value={value}
                onChange={setValue}
                {...(onAddFiles
                  ? { onUploadFile: () => fileInputRef.current?.click() }
                  : {})}
              />
              {/* Agent model selector */}
              <AgentModelSelector compact collisionSide="flip" />
              {/* Model preference button */}
              <div className="relative">
                <ImageModelPreferencePopover
                  collisionSide="flip"
                  open={modelPopoverOpen}
                  onOpenChange={setModelPopoverOpen}
                  onOpenSettings={handleOpenMediaSettings}
                  trigger={
                    <button
                      type="button"
                      aria-label={t("input.modelPreference")}
                      className={`group relative flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] transition-colors ${
                        preference.mode === "manual"
                          ? "border-accent bg-accent/20 text-accent-foreground"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <svg
                        aria-hidden="true"
                        className="h-[14px] w-[14px]"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M10.8 1.307a2.33 2.33 0 0 1 2.4 0l7.67 4.602A2.33 2.33 0 0 1 22 7.907v8.361a2.33 2.33 0 0 1-1.13 1.998l-7.67 4.602-.141.078a2.33 2.33 0 0 1-2.258-.078l-7.67-4.602A2.33 2.33 0 0 1 2 16.268V7.907a2.33 2.33 0 0 1 1.003-1.915l.128-.083z" />
                      </svg>
                      <PromptToolbarTooltip
                        label={t("input.modelPreference")}
                      />
                    </button>
                  }
                />
              </div>
            </div>
            {isRunning && onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={t("input.cancel")}
                title={t("input.cancel")}
                disabled={canceling}
                className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80 active:bg-muted/70 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  aria-hidden="true"
                  className="h-[13px] w-[13px]"
                  viewBox="0 0 14 14"
                  fill="currentColor"
                >
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
                </svg>
              </button>
            ) : isRunning ? (
              <button
                type="button"
                aria-label={t("thinking")}
                aria-busy="true"
                disabled
                className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:cursor-wait"
              >
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/35 border-t-primary-foreground"
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                aria-label={t("input.send")}
                disabled={disabled || !hasContent || isUploading || isRunning}
                className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/80 active:bg-primary/90 disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <svg
                  aria-hidden="true"
                  className="h-[14px] w-[14px]"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                >
                  <path d="M7 11.5V2.5" />
                  <path d="M3 6.5L7 2.5L11 6.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialTab={settingsInitialTab}
        />
      </div>
    );
  },
);
