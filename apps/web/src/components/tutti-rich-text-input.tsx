"use client";

import type { MentionPaletteCategoryConfig } from "@tutti-os/ui-rich-text/at-panel";
import {
  RichTextTriggerEditor,
  type RichTextTriggerMenuAnchor,
  type RichTextTriggerMenuPlacement,
} from "@tutti-os/ui-rich-text/editor";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import { useAppTranslation } from "@/i18n";

export type TuttiRichTextInputHandle = {
  focus: () => void;
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
};

type TuttiRichTextInputProps = {
  ariaLabel: string;
  className?: string;
  disabled?: boolean | undefined;
  editorClassName: string;
  maxResults?: number;
  menuAnchor?: RichTextTriggerMenuAnchor;
  menuPlacement?: RichTextTriggerMenuPlacement;
  menuZIndex?: number;
  placeholder: string;
  placeholderClassName: string;
  rootClassName?: string;
  value: string;
  children?: ReactNode;
  onChange: (value: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onSubmit: () => void;
};

function focusEditableElement(root: HTMLElement | null) {
  const target = root?.querySelector<HTMLElement>(
    '[contenteditable="true"], textarea, [role="textbox"]',
  );
  target?.focus();
}

export const TuttiRichTextInput = forwardRef<
  TuttiRichTextInputHandle,
  TuttiRichTextInputProps
>(function TuttiRichTextInput(
  {
    ariaLabel,
    className,
    disabled,
    editorClassName,
    maxResults = 30,
    menuAnchor = "editor",
    menuPlacement = "top-start",
    menuZIndex = 2300,
    onChange,
    onPaste,
    onSubmit,
    placeholder,
    placeholderClassName,
    rootClassName,
    value,
    children,
  },
  ref,
) {
  const { t } = useAppTranslation("chat");
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const mentionPaletteCategories = useMemo<
    readonly MentionPaletteCategoryConfig[]
  >(
    () => [
      {
        id: "files",
        label: t("input.mentionPaletteFiles"),
        providerIds: ["file"],
      },
    ],
    [t],
  );

  useImperativeHandle(ref, () => ({
    focus() {
      focusEditableElement(fieldRef.current);
    },
    scrollIntoView(options) {
      fieldRef.current?.scrollIntoView(options);
    },
  }));

  useEffect(() => {
    const root = fieldRef.current;
    if (!root) return;

    const applyEditorLabel = () => {
      const editor = root.querySelector<HTMLElement>(
        '[contenteditable="true"], textarea, [role="textbox"]',
      );
      editor?.setAttribute("role", "textbox");
      editor?.setAttribute("aria-multiline", "true");
      editor?.setAttribute("aria-label", ariaLabel);
    };

    applyEditorLabel();
    const observer = new MutationObserver(applyEditorLabel);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ariaLabel]);

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    if (document.querySelector(".tutti-rich-text-at-menu")) return;

    event.preventDefault();
    onSubmit();
  };

  return (
    <div
      ref={fieldRef}
      aria-label={ariaLabel}
      className={className}
      data-chat-input
      onKeyDownCapture={handleKeyDownCapture}
      onPasteCapture={onPaste}
    >
      <RichTextTriggerEditor
        {...(rootClassName ? { className: rootClassName } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
        maxResults={maxResults}
        menuAnchor={menuAnchor}
        menuOffset={8}
        menuPlacement={menuPlacement}
        menuZIndex={menuZIndex}
        minQueryLength={0}
        palette={{
          categories: mentionPaletteCategories,
          defaultCategoryId: "files",
          directoryNavigation: {
            providerId: "file",
            labels: {
              back: t("input.mentionPaletteBack"),
              enter: t("input.mentionPaletteEnterFolder"),
              navigateHierarchy: t("input.mentionPaletteNavigateHierarchy"),
            },
          },
          labels: {
            tabHint: t("input.mentionPaletteTabHint"),
            cycleFilter: t("input.mentionPaletteCycleFilter"),
            moveSelection: t("input.mentionPaletteMoveSelection"),
            empty: t("input.mentionEmpty"),
            listbox: t("input.mentionPaletteListbox"),
          },
          maxHeightPx: 320,
        }}
        placeholder={value.trim() ? "" : placeholder}
        placeholderClassName={placeholderClassName}
        textareaClassName={editorClassName}
        textOverrides={{
          loadingLabel: t("input.mentionLoading"),
          noMatchesLabel: t("input.mentionEmpty"),
          removeReferenceActionLabel: t("input.mentionRemove"),
        }}
        value={value}
        onChange={onChange}
      />
      {children}
    </div>
  );
});
