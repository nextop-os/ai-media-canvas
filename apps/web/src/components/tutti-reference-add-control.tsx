"use client";

import type { TuttiExternalBridge } from "@tutti-os/workspace-external-core/contracts";
import { appendTuttiExternalReferenceSelections } from "@tutti-os/workspace-external-core/rich-text";
import { WorkspaceReferenceAddControl } from "@tutti-os/workspace-file-reference/ui";

export function TuttiReferenceAddControl(props: {
  className?: string;
  disabled?: boolean;
  labels: {
    addContent: string;
    browseReferences: string;
    uploadFile: string;
  };
  tooltipPlacement?: "top" | "bottom";
  value: string;
  onChange: (value: string) => void;
  onUploadFile?: () => void;
}) {
  const references = getTuttiBridge()?.references;
  const selectReferences = references?.select;

  if (!selectReferences && !props.onUploadFile) return null;

  const browseReferences = selectReferences
    ? () => {
        void selectReferences()
          .then((selections) => {
            if (selections.length === 0) return;
            props.onChange(
              appendTuttiExternalReferenceSelections(props.value, selections),
            );
          })
          .catch(() => undefined);
      }
    : () => props.onUploadFile?.();
  const triggerLabel = selectReferences
    ? props.labels.addContent
    : props.labels.uploadFile;

  return (
    <div className="group relative">
      <WorkspaceReferenceAddControl
        labels={{
          addContent: triggerLabel,
          browseReferences: props.labels.browseReferences,
          uploadFile: props.labels.uploadFile,
        }}
        onBrowseReferences={browseReferences}
        {...(props.className ? { className: props.className } : {})}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        {...(selectReferences && props.onUploadFile
          ? { onUploadFile: props.onUploadFile }
          : {})}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${
          props.tooltipPlacement === "bottom"
            ? "top-full mt-2"
            : "bottom-full mb-2"
        }`}
      >
        {triggerLabel}
      </span>
    </div>
  );
}

function getTuttiBridge(): Partial<TuttiExternalBridge> | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { tuttiExternal?: Partial<TuttiExternalBridge> })
    .tuttiExternal;
}
