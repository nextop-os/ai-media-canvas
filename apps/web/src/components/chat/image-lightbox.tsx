"use client";

import { motion } from "framer-motion";
import { CopyIcon, DownloadIcon } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useToast } from "@/components/toast";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/i18n";

/* ------------------------------------------------------------------ */
/*  LightboxBtn — toolbar icon button                                  */
/* ------------------------------------------------------------------ */

function LightboxBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
    >
      <svg
        aria-hidden="true"
        className="h-[18px] w-[18px]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

function normalizeImageFilename(name: string) {
  const trimmed = name.trim() || "image";
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.png`;
}

async function fetchImageBlob(src: string) {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error("Unable to read image data.");
  }
  return await response.blob();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

async function convertBlobToPng(blob: Blob) {
  if (blob.type === "image/png") return blob;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Unable to prepare image data.");
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (pngBlob) {
        resolve(pngBlob);
      } else {
        reject(new Error("Unable to prepare image data."));
      }
    }, "image/png");
  });
}

async function copyImageToClipboard(src: string) {
  if (
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    throw new Error("Image clipboard writes are not supported.");
  }

  const blob = fetchImageBlob(src).then(convertBlobToPng);
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": blob,
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/*  ImageLightbox — fullscreen image viewer with zoom/rotate/pan       */
/* ------------------------------------------------------------------ */

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [flipX, setFlipX] = useState(1);
  const [flipY, setFlipY] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const { t } = useAppTranslation("chat");
  const toast = useToast();
  const menuActionRef = useRef({ copy: 0, download: 0 });
  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }>({
    dragging: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  const handleZoomIn = useCallback(
    () => setScale((s) => Math.min(s * 1.25, 8)),
    [],
  );
  const handleZoomOut = useCallback(
    () => setScale((s) => Math.max(s / 1.25, 0.25)),
    [],
  );
  const handleRotateCW = useCallback(() => setRotate((r) => r + 90), []);
  const handleRotateCCW = useCallback(() => setRotate((r) => r - 90), []);
  const handleFlipX = useCallback(() => setFlipX((f) => f * -1), []);
  const handleFlipY = useCallback(() => setFlipY((f) => f * -1), []);

  const handleDownload = useCallback(async () => {
    try {
      const blob = await fetchImageBlob(src);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = normalizeImageFilename(alt);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("lightbox.downloadFailed"));
      window.open(src, "_blank");
    }
  }, [src, alt, t, toast]);

  const handleCopyImage = useCallback(async () => {
    try {
      await copyImageToClipboard(src);
      toast.success(t("lightbox.copyImageSuccess"));
    } catch (error) {
      console.warn("[image-lightbox] copy image failed:", error);
      toast.error(t("lightbox.copyImageFailed"));
    }
  }, [src, t, toast]);

  const runMenuAction = useCallback(
    (action: "copy" | "download", handler: () => Promise<void>) => {
      const now = Date.now();
      if (now - menuActionRef.current[action] < 500) return;
      menuActionRef.current[action] = now;
      void handler();
    },
    [],
  );

  const overlayRef = useRef<HTMLDialogElement>(null);

  // Keyboard shortcuts — only fire when the user isn't typing in an input,
  // textarea, or contenteditable element. Otherwise typing "r" in the chat
  // input would rotate the image instead of inserting the letter.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.key === "+" || e.key === "=") handleZoomIn();
      if (e.key === "-") handleZoomOut();
      if (e.key === "r") handleRotateCW();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, handleZoomIn, handleZoomOut, handleRotateCW]);

  // Wheel zoom - bound to overlay element to avoid interception
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) setScale((s) => Math.min(s * 1.1, 8));
      else setScale((s) => Math.max(s / 1.1, 0.25));
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        origX: translate.x,
        origY: translate.y,
      };
    },
    [scale, translate],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    setTranslate({
      x: d.origX + e.clientX - d.startX,
      y: d.origY + e.clientY - d.startY,
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current.dragging = false;
  }, []);

  return createPortal(
    <motion.dialog
      ref={overlayRef}
      open
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[2000] m-0 flex h-auto max-h-none w-auto max-w-none flex-col items-center justify-center border-0 bg-black/70 p-0 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-modal="true"
      aria-label={t("lightbox.viewerLabel")}
    >
      {/* Image */}
      <ContextMenu>
        <ContextMenuTrigger className="flex w-full flex-1 items-center justify-center overflow-hidden">
          <img
            draggable
            src={src}
            alt={alt}
            className="max-h-[85vh] max-w-[90vw] object-contain select-none"
            style={{
              transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale3d(${scale * flipX}, ${scale * flipY}, 1) rotate(${rotate}deg)`,
              transition: dragRef.current.dragging
                ? "none"
                : "transform 0.2s ease",
              cursor: scale > 1 ? "grab" : "default",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          className="z-[2200] w-40"
          onClick={(event) => event.stopPropagation()}
        >
          <ContextMenuGroup>
            <ContextMenuItem
              onPointerDown={() => runMenuAction("copy", handleCopyImage)}
              onClick={() => runMenuAction("copy", handleCopyImage)}
            >
              <CopyIcon />
              {t("lightbox.copyImage")}
            </ContextMenuItem>
            <ContextMenuItem
              onPointerDown={() => runMenuAction("download", handleDownload)}
              onClick={() => runMenuAction("download", handleDownload)}
            >
              <DownloadIcon />
              {t("lightbox.downloadImage")}
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>

      {/* Close button */}
      <button
        type="button"
        title={t("lightbox.close")}
        aria-label={t("lightbox.close")}
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-md transition-colors hover:bg-black/60 hover:text-white"
      >
        <svg
          aria-hidden="true"
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Toolbar */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1.5 backdrop-blur-md">
        <LightboxBtn title={t("lightbox.zoomOut")} onClick={handleZoomOut}>
          <path d="M5 12h14" />
        </LightboxBtn>
        <span className="min-w-[42px] text-center text-xs text-white/80 select-none">
          {Math.round(scale * 100)}%
        </span>
        <LightboxBtn title={t("lightbox.zoomIn")} onClick={handleZoomIn}>
          <path d="M12 5v14M5 12h14" />
        </LightboxBtn>
        <div className="mx-1 h-4 w-px bg-white/20" />
        <LightboxBtn title={t("lightbox.flipHorizontal")} onClick={handleFlipX}>
          <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
          <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
          <path d="M12 20V4" />
        </LightboxBtn>
        <LightboxBtn title={t("lightbox.flipVertical")} onClick={handleFlipY}>
          <path d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
          <path d="M4 12h16" />
        </LightboxBtn>
        <div className="mx-1 h-4 w-px bg-white/20" />
        <LightboxBtn
          title={t("lightbox.rotateCounterClockwise")}
          onClick={handleRotateCCW}
        >
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8" />
          <path d="M3 3v5h5" />
        </LightboxBtn>
        <LightboxBtn
          title={t("lightbox.rotateClockwise")}
          onClick={handleRotateCW}
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </LightboxBtn>
        <LightboxBtn
          title={t("lightbox.downloadImage")}
          onClick={handleDownload}
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </LightboxBtn>
      </div>
    </motion.dialog>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/*  ChatImage — clickable thumbnail that opens lightbox                 */
/* ------------------------------------------------------------------ */

export const ChatImage = React.memo(function ChatImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const { t } = useAppTranslation("chat");

  if (loadError) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-muted text-muted-foreground text-xs`}
        title={t("lightbox.imageFailedToLoad")}
      >
        <svg
          aria-hidden="true"
          className="h-5 w-5 opacity-40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Z" />
        </svg>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`${className} block cursor-zoom-in overflow-hidden bg-transparent p-0 text-left`}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt}
          className="block max-w-full"
          loading="lazy"
          onError={() => setLoadError(true)}
        />
      </button>
      {open && (
        <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />
      )}
    </>
  );
});

/* ------------------------------------------------------------------ */
/*  ImagePill — inline pill for user-attached images                    */
/* ------------------------------------------------------------------ */

export const ImagePill = React.memo(function ImagePill({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  const [lightbox, setLightbox] = useState(false);
  const [preview, setPreview] = useState<{
    x: number;
    y: number;
    above: boolean;
  } | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (!pillRef.current) return;
    const rect = pillRef.current.getBoundingClientRect();
    const bubbleRect =
      pillRef.current.closest("[data-chat-bubble]")?.getBoundingClientRect() ??
      rect;
    const previewSize = 240;
    const margin = 12;
    const gap = 8;
    const spaceBelow = window.innerHeight - bubbleRect.bottom - margin;
    const spaceAbove = bubbleRect.top - margin;
    const above = spaceBelow < previewSize && spaceAbove > spaceBelow;
    const minX = margin + previewSize / 2;
    const maxX = window.innerWidth - margin - previewSize / 2;
    const centeredX = rect.left + rect.width / 2;
    const clampedX =
      maxX > minX
        ? Math.min(Math.max(centeredX, minX), maxX)
        : window.innerWidth / 2;

    setPreview({
      x: clampedX,
      y: above ? bubbleRect.top - gap : bubbleRect.bottom + gap,
      above,
    });
  }, []);

  const handleMouseLeave = useCallback(() => setPreview(null), []);

  return (
    <>
      <button
        type="button"
        ref={pillRef}
        onClick={() => setLightbox(true)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-flex h-[22px] items-center gap-1 rounded-md px-1 mx-0.5 border-[0.5px] border-muted-foreground bg-transparent text-foreground hover:bg-muted cursor-pointer align-middle"
      >
        <span className="inline-block relative h-3.5 w-3.5 shrink-0 overflow-hidden rounded-sm">
          <img
            src={src}
            alt={name}
            draggable={false}
            className="h-full w-full object-cover"
          />
        </span>
        <span className="max-w-[100px] truncate text-[11px] leading-none text-foreground">
          {name}
        </span>
      </button>

      {/* Hover preview portal */}
      {preview &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[1500]"
            style={{
              left: preview.x,
              top: preview.y,
              transform: preview.above
                ? "translate(-50%, -100%)"
                : "translate(-50%, 0)",
            }}
          >
            <img
              src={src}
              alt={name}
              className="max-h-[240px] max-w-[240px] rounded-lg border border-border object-contain bg-card shadow-xl"
            />
          </div>,
          document.body,
        )}

      {lightbox && (
        <ImageLightbox
          src={src}
          alt={name}
          onClose={() => setLightbox(false)}
        />
      )}
    </>
  );
});
