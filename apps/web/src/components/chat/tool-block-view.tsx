"use client";

import { motion } from "framer-motion";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageArtifact, ToolBlock, VideoArtifact } from "@aimc/shared";
import { useAppTranslation } from "../../i18n";
import { toRuntimeAssetUrl } from "../../lib/local-assets";
import { ChatImage } from "./image-lightbox";
import {
  formatModelDisplayName,
  formatOutputPreview,
  formatParamName,
  formatParamValue,
  getToolConfig,
  isHumanReadable,
  normalizeToolName,
} from "./utils";

/* ------------------------------------------------------------------ */
/*  ToolIcon                                                           */
/* ------------------------------------------------------------------ */

function ToolIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const cls = className ?? "h-3.5 w-3.5";
  switch (type) {
    case "eye":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
          <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      );
    case "image":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
        </svg>
      );
    case "video":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
      );
    case "palette":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 0 0 3.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.88 2.88M6.75 17.25h.008v.008H6.75v-.008Z" />
        </svg>
      );
    case "search":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
      );
    case "brush":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
        </svg>
      );
    default:
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437" />
        </svg>
      );
  }
}

/* ------------------------------------------------------------------ */
/*  findSidebarRect — locate the chatbar container for panel placement */
/* ------------------------------------------------------------------ */

function findSidebarRect(el: HTMLElement | null): DOMRect | null {
  let node = el;
  while (node) {
    if (node.style.width && node.classList.contains("shrink-0")) {
      return node.getBoundingClientRect();
    }
    node = node.parentElement;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  ToolBlockView — main card in chatbar + floating detail panel       */
/* ------------------------------------------------------------------ */

export const ToolBlockView = React.memo(function ToolBlockView({
  block,
  onOpenMediaSettings,
}: {
  block: ToolBlock;
  onOpenMediaSettings?: (() => void) | undefined;
}) {
  const { t } = useAppTranslation("chat");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelRight, setPanelRight] = useState(416);
  const containerRef = useRef<HTMLDivElement>(null);

  const config = getToolConfig(block.toolName);
  const isRunning = block.status === "running";
  const isCompleted = block.status === "completed";
  const isFailed = block.status === "failed";
  const isCanceled = block.status === "canceled";
  const hasOutput = block.output && Object.keys(block.output).length > 0;
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const hasDetails = hasOutput || hasInput;

  const cardTitle =
    block.outputSummary && isHumanReadable(block.outputSummary)
      ? block.outputSummary
      : config.label;

  // Extract image artifacts for inline preview
  const imageArtifact = block.artifacts?.find(
    (artifact): artifact is ImageArtifact => artifact.type === "image",
  );
  const videoArtifact = block.artifacts?.find(
    (artifact): artifact is VideoArtifact => artifact.type === "video",
  );
  const canonicalToolName = normalizeToolName(block.toolName);
  const isImageTool = canonicalToolName === "generate_image";
  const isVideoTool = canonicalToolName === "generate_video";
  const isMediaTool = isImageTool || isVideoTool;
  const outputData = block.output as Record<string, unknown> | undefined;
  const capabilityRequired = getMediaCapabilityRequired(outputData);
  const isDeferredMediaJob =
    isMediaTool &&
    isCompleted &&
    outputData?.status === "generating" &&
    typeof outputData.jobId === "string";
  const isVisuallyRunning = isRunning || isDeferredMediaJob;
  const previewLines = outputData ? formatOutputPreview(outputData) : [];
  const showCard =
    config.showCard &&
    isCompleted &&
    !isDeferredMediaJob &&
    !capabilityRequired &&
    (block.outputSummary || hasOutput);
  const shouldShowImageArtifactCard =
    isCompleted &&
    !!imageArtifact &&
    (isImageTool ||
      canonicalToolName === "persist_sandbox_file" ||
      canonicalToolName === "screenshot_canvas");
  const mediaError =
    isMediaTool &&
    !isDeferredMediaJob &&
    (isFailed || isCanceled || isCompleted) &&
    !imageArtifact &&
    !videoArtifact &&
    !capabilityRequired
      ? isCanceled
        ? t("media.generationCanceled")
        : ((outputData?.error as string | undefined) ?? block.outputSummary)
      : undefined;
  const mediaErrorTitle = mediaError
    ? isCanceled
      ? isVideoTool
        ? t("media.videoGenerationCanceled")
        : t("media.imageGenerationCanceled")
      : isVideoTool
        ? t("media.videoGenerationFailed")
        : t("media.imageGenerationFailed")
    : undefined;
  const inputData = block.input as Record<string, unknown> | undefined;
  const modelName = inputData?.model as string | undefined;
  const headerLabel =
    isMediaTool && modelName && !capabilityRequired
      ? formatModelDisplayName(modelName)
      : config.label;
  const aspectRatio =
    (inputData?.aspectRatio as string) ?? (isVideoTool ? "16:9" : "1:1");

  const handleOpenPanel = useCallback(() => {
    const rect = findSidebarRect(containerRef.current);
    if (rect) {
      setPanelRight(window.innerWidth - rect.left + 12);
    }
    setPanelOpen(true);
  }, []);

  const handleClosePanel = useCallback(() => setPanelOpen(false), []);

  return (
    <div ref={containerRef} className="space-y-1.5">
      {/* Layer 1: Status line */}
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {isVisuallyRunning ? (
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground" />
        ) : isFailed || isCanceled ? (
          <svg
            className={
              isFailed
                ? "h-3.5 w-3.5 text-destructive"
                : "h-3.5 w-3.5 text-muted-foreground"
            }
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5ZM8 11.75a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75Z" />
          </svg>
        ) : (
          <svg
            className="h-3.5 w-3.5 text-muted-foreground"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
          </svg>
        )}
        <span className="font-medium text-muted-foreground truncate">
          {headerLabel}
        </span>
      </div>

      {/* Layer 2a: Media generation shimmer placeholder */}
      {isMediaTool && isVisuallyRunning && !imageArtifact && !videoArtifact && (
        <MediaShimmer
          isVideoTool={isVideoTool}
          aspectRatio={aspectRatio}
          modelName={modelName}
          loadingLabel={
            isVideoTool
              ? t("media.videoGenerating")
              : t("media.imageGenerating")
          }
        />
      )}

      {/* Layer 2b-err: Media generation failed */}
      {isMediaTool && mediaError && mediaErrorTitle && (
        <MediaErrorCard
          title={mediaErrorTitle}
          error={mediaError}
          variant={isCanceled ? "canceled" : "error"}
        />
      )}

      {isMediaTool && capabilityRequired && (
        <MediaCapabilityRequiredCard
          capability={capabilityRequired.capability}
          title={
            capabilityRequired.capability === "video_generation"
              ? t("capabilityRequired.videoTitle")
              : t("capabilityRequired.imageTitle")
          }
          description={
            capabilityRequired.capability === "video_generation"
              ? t("capabilityRequired.videoDescription")
              : t("capabilityRequired.imageDescription")
          }
          actionLabel={t("capabilityRequired.configureMedia")}
          onAction={onOpenMediaSettings}
        />
      )}

      {/* Layer 2b: Image generation card with inline preview */}
      {shouldShowImageArtifactCard ? (
        <ImageArtifactCard
          artifact={imageArtifact}
          cardTitle={cardTitle}
          modelName={modelName}
          hasDetails={!!hasDetails}
          onOpenPanel={handleOpenPanel}
        />
      ) : isVideoTool && isCompleted && videoArtifact ? (
        <VideoArtifactCard artifact={videoArtifact} />
      ) : showCard ? (
        /* Layer 2: Generic output card (non-image tools) */
        <div className="rounded-xl border-[0.5px] border-border p-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 rounded-lg bg-muted p-1.5 text-muted-foreground">
              <ToolIcon type={config.icon} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground line-clamp-1">
                {cardTitle}
              </div>
              {previewLines.length > 0 && (
                <div className="mt-0.5 space-y-px">
                  {previewLines.map((line, i) => (
                    <div
                      key={i}
                      className="text-[11px] text-muted-foreground truncate"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {hasDetails && (
            <button
              type="button"
              onClick={handleOpenPanel}
              className="mt-2 flex items-center gap-0.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.78 11.78a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 0-1.06l3.5-3.5a.75.75 0 0 1 1.06 1.06L6.56 8l3.22 3.22a.75.75 0 0 1 0 1.06Z" />
              </svg>
              查看详情
            </button>
          )}
        </div>
      ) : null}

      {/* Floating detail panel */}
      {panelOpen &&
        hasDetails &&
        createPortal(
          <ToolDetailPanel
            block={block}
            rightOffset={panelRight}
            onClose={handleClosePanel}
          />,
          document.body,
        )}
    </div>
  );
});

type MediaCapabilityRequired = {
  capability: "image_generation" | "video_generation";
};

function getMediaCapabilityRequired(
  output: Record<string, unknown> | undefined,
): MediaCapabilityRequired | null {
  const raw = output?.capabilityRequired;
  if (!raw || typeof raw !== "object") return null;

  const capability = (raw as { capability?: unknown }).capability;
  if (
    capability !== "image_generation" &&
    capability !== "video_generation"
  ) {
    return null;
  }

  return { capability };
}

const MediaCapabilityRequiredCard = React.memo(
  function MediaCapabilityRequiredCard({
    capability,
    title,
    description,
    actionLabel,
    onAction,
  }: {
    capability: "image_generation" | "video_generation";
    title: string;
    description: string;
    actionLabel: string;
    onAction?: (() => void) | undefined;
  }) {
    return (
      <div className="w-full max-w-sm rounded-xl border-[0.5px] border-border bg-muted/30 p-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 shrink-0 rounded-lg bg-background p-1.5 text-muted-foreground">
            <ToolIcon
              type={capability === "video_generation" ? "video" : "image"}
              className="h-4 w-4"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">
              {title}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {description}
            </div>
            {onAction && (
              <button
                type="button"
                onClick={onAction}
                className="mt-2 inline-flex h-7 items-center rounded-md border-[0.5px] border-border bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                {actionLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

/* ------------------------------------------------------------------ */
/*  MediaShimmer — shimmer placeholder during media generation         */
/* ------------------------------------------------------------------ */

const MediaShimmer = React.memo(function MediaShimmer({
  isVideoTool,
  aspectRatio,
  modelName,
  loadingLabel,
}: {
  isVideoTool: boolean;
  aspectRatio: string;
  modelName: string | undefined;
  loadingLabel: string;
}) {
  return (
    <div className="rounded-xl border-[0.5px] border-border overflow-hidden">
      <div
        className="relative w-full max-h-[280px] overflow-hidden"
        style={{ aspectRatio: aspectRatio.replace(":", " / ") }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted">
          {isVideoTool ? (
            <svg
              className="h-10 w-10 text-muted-foreground/50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          ) : (
            <svg
              className="h-10 w-10 text-muted-foreground/50"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          )}
        </div>
        {/* Shimmer scan effect */}
        <div className="absolute inset-0 animate-shimmer-scan">
          <div
            className="h-full w-1/2"
            style={{
              background:
                "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)",
            }}
          />
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="text-[12px] font-medium text-muted-foreground/70">
          {loadingLabel}
        </div>
        {modelName && (
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
            {formatModelDisplayName(modelName)}
          </div>
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  MediaErrorCard                                                     */
/* ------------------------------------------------------------------ */

const MediaErrorCard = React.memo(function MediaErrorCard({
  title,
  error,
  variant,
}: {
  title: string;
  error: string;
  variant: "error" | "canceled";
}) {
  const isError = variant === "error";
  return (
    <div
      className={
        isError
          ? "rounded-xl border-[0.5px] border-destructive/30 bg-destructive/5 p-3"
          : "rounded-xl border-[0.5px] border-border bg-muted/30 p-3"
      }
    >
      <div className="flex items-start gap-2.5">
        <div
          className={
            isError
              ? "mt-0.5 shrink-0 rounded-lg bg-destructive/10 p-1.5 text-destructive"
              : "mt-0.5 shrink-0 rounded-lg bg-background p-1.5 text-muted-foreground"
          }
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground line-clamp-2">
            {error}
          </div>
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  ImageArtifactCard                                                  */
/* ------------------------------------------------------------------ */

const ImageArtifactCard = React.memo(function ImageArtifactCard({
  artifact,
  cardTitle,
  modelName,
  hasDetails,
  onOpenPanel,
}: {
  artifact: ImageArtifact;
  cardTitle: string;
  modelName: string | undefined;
  hasDetails: boolean;
  onOpenPanel: () => void;
}) {
  const url = toRuntimeAssetUrl(artifact.url, artifact.assetId);
  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      fetch(url)
        .then((res) => res.blob())
        .then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = artifact.title ?? "generated-image.png";
          a.click();
          URL.revokeObjectURL(a.href);
        })
        .catch(() => window.open(url, "_blank"));
    },
    [url, artifact.title],
  );

  return (
    <div
      className="group cursor-pointer rounded-xl border-[0.5px] border-border overflow-hidden transition-shadow hover:shadow-md"
      onClick={onOpenPanel}
    >
      {/* Image preview -- use artifact's aspect ratio to match canvas */}
      <div
        className="relative max-h-[280px] w-full overflow-hidden bg-muted"
        style={{ aspectRatio: `${artifact.width} / ${artifact.height}` }}
      >
        <img
          src={url}
          alt={artifact.title ?? "Generated image"}
          className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03]"
          loading="lazy"
        />
        {/* Gradient overlay with download button */}
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={handleDownload}
            className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-white/20 backdrop-blur-sm text-white hover:bg-white/30 transition-colors"
            title="\u4e0b\u8f7d\u56fe\u7247"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z" />
            </svg>
          </button>
        </div>
      </div>
      {/* Title + model info */}
      <div className="px-3 py-2.5">
        <div className="text-sm font-semibold text-foreground line-clamp-1">
          {artifact.title ?? cardTitle}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {modelName && (
            <span className="truncate">
              {formatModelDisplayName(modelName)}
            </span>
          )}
          {hasDetails && (
            <>
              <span>&middot;</span>
              <span className="hover:text-foreground transition-colors">
                查看详情
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

const VideoArtifactCard = React.memo(function VideoArtifactCard({
  artifact,
}: {
  artifact: VideoArtifact;
}) {
  const url = toRuntimeAssetUrl(artifact.url, artifact.assetId);
  return (
    <div className="overflow-hidden rounded-xl border-[0.5px] border-border">
      <div className="bg-black">
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          className="max-h-[280px] w-full object-contain"
        />
      </div>
      <div className="px-3 py-2.5">
        <div className="text-sm font-semibold text-foreground line-clamp-1">
          {artifact.title ?? "Generated video"}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {artifact.durationSeconds != null
            ? `${artifact.durationSeconds}s · ${artifact.mimeType}`
            : artifact.mimeType}
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  ToolDetailPanel — floating panel to the left of chatbar            */
/* ------------------------------------------------------------------ */

function ToolDetailPanel({
  block,
  rightOffset,
  onClose,
}: {
  block: ToolBlock;
  rightOffset: number;
  onClose: () => void;
}) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const config = getToolConfig(block.toolName);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[1000]"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, x: 24, scale: 0.97 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        transition={{
          duration: 0.25,
          ease: [0.25, 0.46, 0.45, 0.94],
        }}
        className="fixed top-1/2 -translate-y-1/2 w-[520px] max-h-[640px] min-h-[240px] rounded-2xl bg-card shadow-lg overflow-hidden flex flex-col"
        style={{ right: rightOffset }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <ToolIcon
              type={config.icon}
              className="h-4 w-4 text-muted-foreground"
            />
            <h3 className="text-sm font-semibold text-foreground">
              {config.label}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          {/* Input -- collapsible */}
          {hasInput && (
            <div>
              <button
                type="button"
                onClick={() => setInputExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={inputExpanded}
              >
                <svg
                  className={`h-3 w-3 transition-transform duration-200 ${inputExpanded ? "rotate-90" : ""}`}
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L9.44 8 6.22 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
                输入参数
              </button>
              {inputExpanded && (
                <div className="mt-2 space-y-1.5">
                  {Object.entries(block.input!).map(([key, value]) => (
                    <div key={key} className="rounded-lg bg-muted px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {formatParamName(key)}
                      </div>
                      <div className="mt-0.5 text-xs text-foreground break-all whitespace-pre-wrap">
                        {formatParamValue(value)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Output */}
          {block.output ? (
            <ToolOutputRenderer
              toolName={block.toolName}
              output={block.output}
            />
          ) : block.outputSummary ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                输出
              </div>
              <div className="rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {block.outputSummary}
              </div>
            </div>
          ) : null}

          {/* Image artifacts */}
          {block.artifacts && block.artifacts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                附件
              </div>
              <div className="flex flex-wrap gap-2">
                {block.artifacts.map((artifact) =>
                  artifact.type === "image" ? (
                    <ChatImage
                      key={artifact.url}
                      src={toRuntimeAssetUrl(artifact.url, artifact.assetId)}
                      alt={artifact.title ?? "Generated image"}
                      className="max-w-[200px] rounded-lg border border-border"
                    />
                  ) : artifact.type === "video" ? (
                    <video
                      key={artifact.url}
                      src={toRuntimeAssetUrl(artifact.url, artifact.assetId)}
                      muted
                      playsInline
                      preload="metadata"
                      className="max-w-[240px] rounded-lg border border-border bg-black"
                    />
                  ) : null,
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool-specific output renderers                                     */
/* ------------------------------------------------------------------ */

function ToolOutputRenderer({
  toolName,
  output,
}: {
  toolName: string;
  output: Record<string, unknown>;
}) {
  if (toolName === "get_brand_kit" && isBrandKitOutput(output)) {
    return <BrandKitOutput data={output} />;
  }

  const entries = Object.entries(output);
  const isSimple = entries.every(
    ([, v]) =>
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean",
  );

  if (isSimple && entries.length > 0) {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-2">
          输出
        </div>
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="rounded-lg bg-muted px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {formatParamName(key)}
              </div>
              <div className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">
                {value === null ? "\u2014" : String(value)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Complex objects / arrays -- formatted JSON
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2">输出</div>
      <div className="rounded-xl bg-muted px-4 py-3 overflow-x-auto max-h-[360px] overflow-y-auto">
        <pre className="text-[12px] leading-5 text-muted-foreground whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(output, null, 2)}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BrandKit output renderer                                           */
/* ------------------------------------------------------------------ */

type BrandKitData = {
  kit_name?: string;
  design_guidance?: string;
  colors?: { name?: string; hex?: string; role?: string | null }[];
  fonts?: {
    name?: string;
    family?: string;
    weight?: string;
    role?: string | null;
  }[];
  logos?: { name?: string; url?: string; role?: string | null }[];
  images?: { name?: string; url?: string; role?: string | null }[];
};

function isBrandKitOutput(
  output: Record<string, unknown>,
): output is BrandKitData {
  return (
    "colors" in output ||
    "fonts" in output ||
    "logos" in output ||
    "kit_name" in output
  );
}

function BrandKitOutput({ data }: { data: BrandKitData }) {
  const colors = data.colors?.filter((c) => c.hex) ?? [];
  const fonts = data.fonts?.filter((f) => f.name) ?? [];
  const logos = data.logos?.filter((l) => l.url) ?? [];
  const images = data.images?.filter((i) => i.url) ?? [];

  return (
    <div className="space-y-4">
      {data.kit_name && (
        <div>
          <div className="text-base font-semibold text-foreground">
            {data.kit_name}
          </div>
          {data.design_guidance && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {data.design_guidance}
            </div>
          )}
        </div>
      )}

      {/* Colors */}
      {colors.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Color
          </div>
          <div className="flex flex-wrap gap-3">
            {colors.map((color, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <div
                  className="h-16 w-16 rounded-xl border border-border shadow-sm"
                  style={{ backgroundColor: color.hex }}
                />
                <span className="text-[10px] font-medium text-muted-foreground">
                  {color.hex}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fonts */}
      {fonts.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Fonts
          </div>
          <div className="grid grid-cols-2 gap-2">
            {fonts.map((font, i) => (
              <div key={i} className="rounded-xl bg-muted px-3 py-3">
                <div className="text-[10px] text-muted-foreground mb-1">
                  {font.name}
                </div>
                <div
                  className="text-sm text-foreground"
                  style={{ fontFamily: font.family }}
                >
                  ABCDEFGHIJKLM
                </div>
                <div
                  className="text-xs text-foreground mt-0.5"
                  style={{ fontFamily: font.family }}
                >
                  abcdefghijklmnopqrstuvwxyz
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Logos & Images */}
      {(logos.length > 0 || images.length > 0) && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Photography
          </div>
          <div className="grid grid-cols-2 gap-2">
            {logos.map((logo, i) => (
              <div
                key={`logo-${i}`}
                className="overflow-hidden rounded-xl border border-border"
              >
                <img
                  src={logo.url}
                  alt={logo.name ?? "Logo"}
                  className="h-auto w-full object-cover"
                  loading="lazy"
                />
                {logo.name && (
                  <div className="px-2 py-1.5 text-[10px] text-muted-foreground truncate">
                    {logo.name}
                  </div>
                )}
              </div>
            ))}
            {images.map((img, i) => (
              <div
                key={`img-${i}`}
                className="overflow-hidden rounded-xl border border-border"
              >
                <img
                  src={img.url}
                  alt={img.name ?? "Image"}
                  className="h-auto w-full object-cover"
                  loading="lazy"
                />
                {img.name && (
                  <div className="px-2 py-1.5 text-[10px] text-muted-foreground truncate">
                    {img.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
