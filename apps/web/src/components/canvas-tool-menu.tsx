"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Circle,
  Hand,
  Image as ImageIcon,
  ImageUp,
  Minus,
  MousePointer2,
  Pencil,
  Sparkles,
  Square,
  Type,
  Video,
} from "lucide-react";
import {
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import { useAppTranslation } from "../i18n";
import {
  isVideoUrl,
  normalizeVideoCanvasElements,
} from "../lib/canvas-elements";
import {
  type ImageGeneratorData,
  createImageGeneratorElement,
  getImageGeneratorData,
  isImageGeneratorElement,
} from "../lib/canvas-image-generator";
import {
  type VideoGeneratorData,
  createVideoGeneratorElement,
  getVideoGeneratorData,
  isVideoGeneratorElement,
} from "../lib/canvas-video-generator";
import {
  isExcalidrawCanvasTarget,
  isExcalidrawContextMenuTarget,
} from "../lib/excalidraw-context-menu";
import { toRuntimeAssetUrl } from "../lib/local-assets";
import { ImageGeneratorPanel } from "./canvas/image-generator-panel";
import { VideoCanvasElement } from "./canvas/video-canvas-element";
import { VideoGeneratorPanel } from "./canvas/video-generator-panel";
import { formatModelDisplayName } from "./chat/utils";

type ToolType =
  | "hand"
  | "selection"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image";

const TOOL_GROUPS: Array<{ id: string; tool: ToolType | null }> = [
  { id: "hand", tool: "hand" },
  { id: "selection", tool: "selection" },
  { id: "image", tool: "image" },
  { id: "separator-primary", tool: null },
  { id: "rectangle", tool: "rectangle" },
  { id: "ellipse", tool: "ellipse" },
  { id: "arrow", tool: "arrow" },
  { id: "line", tool: "line" },
  { id: "freedraw", tool: "freedraw" },
  { id: "separator-text", tool: null },
  { id: "text", tool: "text" },
];

type GeneratorOverlayItem = {
  id: string;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  zoom: number;
  model?: string;
  errorMessage?: string;
};

type VideoOverlayItem = {
  id: string;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  zoom: number;
  src: string;
  assetId?: string;
  title?: string;
  prompt?: string;
  model?: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  mimeType?: string;
};

type VideoOverlayFrameProps = {
  excalidrawApi: CanvasToolExcalidrawApi;
  item: VideoOverlayItem;
};

type CanvasOverlayElement = {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  link?: unknown;
  customData?: Record<string, unknown>;
};

const TOOL_ICONS: Record<
  ToolType,
  React.ComponentType<{ className?: string }>
> = {
  hand: Hand,
  selection: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  line: Minus,
  freedraw: Pencil,
  text: Type,
  image: ImageUp,
};

const TOOL_LABEL_KEYS: Record<ToolType, string> = {
  hand: "tools.hand",
  selection: "tools.selection",
  rectangle: "tools.rectangle",
  ellipse: "tools.ellipse",
  arrow: "tools.arrow",
  line: "tools.line",
  freedraw: "tools.freedraw",
  text: "tools.text",
  image: "tools.image",
};

type CanvasToolMenuProps = {
  canvasId: string;
  excalidrawApi: CanvasToolExcalidrawApi | null;
  leftPanelOpen?: boolean;
  projectId: string;
};

type CanvasToolElement = Record<string, unknown> & {
  customData?: Record<string, unknown>;
  height?: number;
  id?: string;
  isDeleted?: boolean;
  link?: string | null;
  type?: string;
  width?: number;
  x?: number;
  y?: number;
};

type CanvasToolAppState = {
  activeTool?: { type?: string };
  isResizing?: boolean;
  scrollX?: number;
  scrollY?: number;
  selectedElementsAreBeingDragged?: boolean;
  selectedElementIds?: Record<string, boolean>;
  zoom?: { value?: number };
};

type CanvasToolExcalidrawApi = {
  addFiles(files: Record<string, unknown>[]): void;
  getAppState(): CanvasToolAppState;
  getSceneElements(): readonly CanvasToolElement[];
  onChange(
    handler: (
      elements: CanvasToolElement[],
      appState: CanvasToolAppState,
    ) => void,
  ): () => void;
  setActiveTool(tool: { type: string }): void;
  updateScene(scene: Record<string, unknown>): void;
};

function ToolbarTooltip({
  label,
  anchorRect,
}: {
  label: string;
  anchorRect: DOMRect | null;
}) {
  if (!anchorRect || typeof document === "undefined") return null;

  return createPortal(
    <span
      className="pointer-events-none fixed z-[260] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg"
      style={{
        left: anchorRect.left + anchorRect.width / 2,
        top: anchorRect.top - 8,
      }}
    >
      {label}
    </span>,
    document.body,
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  onMouseDown,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);

  const showTooltip = useCallback((target: HTMLButtonElement) => {
    setTooltipRect(target.getBoundingClientRect());
  }, []);

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      showTooltip(event.currentTarget);
    },
    [showTooltip],
  );

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLButtonElement>) => {
      showTooltip(event.currentTarget);
    },
    [showTooltip],
  );

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={() => setTooltipRect(null)}
      onFocus={handleFocus}
      onBlur={() => setTooltipRect(null)}
      className={`group relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
        active
          ? "bg-foreground/[0.08] text-foreground"
          : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
      }`}
    >
      {children}
      <ToolbarTooltip label={label} anchorRect={tooltipRect} />
    </button>
  );
}

function ImageGeneratorIcon() {
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      <ImageIcon className="size-[17px]" />
      <Sparkles className="absolute -right-1 -top-1 size-[9px] stroke-[2.4]" />
    </span>
  );
}

function getGeneratorOverlayRadius(width: number, height: number) {
  return Math.max(6, Math.min(32, Math.min(width, height) * 0.08));
}
const GENERATOR_OVERLAY_BLEED = 2;
const VIDEO_OVERLAY_DRAG_THRESHOLD = 4;
const GENERATOR_DEFAULT_STYLE = {
  backgroundColor: "#F3F4F6",
  strokeColor: "#D1D5DB",
};
const GENERATOR_ERROR_STYLE = {
  backgroundColor: "#FDECEE",
  strokeColor: "#FCA5A5",
};

function getGeneratorElementStyle(status: unknown) {
  return status === "error" ? GENERATOR_ERROR_STYLE : GENERATOR_DEFAULT_STYLE;
}

function normalizeGeneratorElementStyles(
  elements: readonly CanvasToolElement[],
) {
  let changed = false;
  const normalized = elements.map((element) => {
    if (
      element.isDeleted ||
      (!isImageGeneratorElement(element) && !isVideoGeneratorElement(element))
    ) {
      return element;
    }
    const style = getGeneratorElementStyle(element.customData?.status);
    if (
      element.strokeColor === style.strokeColor &&
      element.backgroundColor === style.backgroundColor
    ) {
      return element;
    }
    changed = true;
    return {
      ...element,
      ...style,
      version: ((element.version as number | undefined) ?? 1) + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
      updated: Date.now(),
    };
  });
  return changed ? normalized : null;
}

function normalizeCanvasToolElements(elements: readonly CanvasToolElement[]) {
  return (
    normalizeVideoCanvasElements(elements) ??
    normalizeGeneratorElementStyles(elements)
  );
}

function getElementBounds(element: CanvasToolElement) {
  return {
    x: element.x ?? 0,
    y: element.y ?? 0,
    width: element.width ?? 0,
    height: element.height ?? 0,
  };
}

function isSelectedElementTransforming(appState: CanvasToolAppState) {
  return Boolean(
    appState.selectedElementsAreBeingDragged || appState.isResizing,
  );
}

/** Memoized shimmer overlay for a single generating element */
const GeneratingOverlay = memo(function GeneratingOverlay({
  id,
  screenX,
  screenY,
  screenW,
  screenH,
  model,
  zoom,
  label,
}: {
  id: string;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  zoom: number;
  model?: string;
  label: string;
}) {
  const contentScale = Math.min(1, Math.max(0.25, zoom));
  const showIcon = screenH >= 56 && screenW >= 72;
  const borderRadius = getGeneratorOverlayRadius(screenW, screenH);
  return (
    <div
      key={id}
      className="pointer-events-none fixed overflow-hidden"
      style={{
        left: screenX - GENERATOR_OVERLAY_BLEED,
        top: screenY - GENERATOR_OVERLAY_BLEED,
        width: screenW + GENERATOR_OVERLAY_BLEED * 2,
        height: screenH + GENERATOR_OVERLAY_BLEED * 2,
        borderRadius: borderRadius + GENERATOR_OVERLAY_BLEED,
        // Keep generation shimmer above canvas content, but below app chrome
        // such as the chat sidebar, top bar, and floating shell UI.
        zIndex: 10,
      }}
    >
      <div
        className="absolute inset-0 flex flex-col items-center justify-center bg-muted"
        style={{ borderRadius: borderRadius + GENERATOR_OVERLAY_BLEED }}
      >
        <div
          className="flex flex-col items-center justify-center"
          style={{ transform: `scale(${contentScale})` }}
        >
          {showIcon && (
            <svg
              aria-hidden="true"
              className="h-12 w-12 text-muted-foreground/40"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          )}
          {showIcon && model && (
            <span className="mt-2 whitespace-nowrap rounded-full bg-foreground/5 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {formatModelDisplayName(model)}
            </span>
          )}
          <span
            className={`${showIcon ? "mt-1" : "mt-0"} whitespace-nowrap text-[11px] text-muted-foreground`}
          >
            {label}
          </span>
        </div>
      </div>
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
  );
});

const GeneratorErrorOverlay = memo(function GeneratorErrorOverlay({
  id,
  screenX,
  screenY,
  screenW,
  screenH,
  zoom,
  errorMessage,
}: GeneratorOverlayItem) {
  const { t } = useAppTranslation("canvas");
  const contentScale = Math.min(1, Math.max(0.25, zoom));
  const showIcon = screenH >= 48 && screenW >= 72;
  const borderRadius = getGeneratorOverlayRadius(screenW, screenH);
  return (
    <div
      key={id}
      className="pointer-events-none fixed overflow-hidden"
      style={{
        left: screenX - GENERATOR_OVERLAY_BLEED,
        top: screenY - GENERATOR_OVERLAY_BLEED,
        width: screenW + GENERATOR_OVERLAY_BLEED * 2,
        height: screenH + GENERATOR_OVERLAY_BLEED * 2,
        borderRadius: borderRadius + GENERATOR_OVERLAY_BLEED,
        zIndex: 10,
      }}
    >
      <div
        className="absolute flex items-center justify-center px-2 text-center"
        style={{
          inset: 0,
          borderRadius: borderRadius + GENERATOR_OVERLAY_BLEED,
          backgroundColor: GENERATOR_ERROR_STYLE.backgroundColor,
        }}
      >
        <div
          className="flex flex-col items-center justify-center"
          style={{ transform: `scale(${contentScale})` }}
        >
          {showIcon && (
            <AlertTriangle className="h-7 w-7 text-destructive/80" />
          )}
          <span
            className={`${showIcon ? "mt-2" : "mt-0"} whitespace-nowrap rounded-full bg-background/85 px-2.5 py-1 text-[11px] font-medium text-destructive shadow-sm`}
          >
            {errorMessage || t("tools.generateFailed")}
          </span>
        </div>
      </div>
    </div>
  );
});

function getVideoOverlayKey(
  elements: readonly CanvasOverlayElement[],
  scrollX: number,
  scrollY: number,
  zoom: number,
) {
  return `${elements
    .map((el) => {
      const customData = el.customData ?? {};
      return [
        el.id,
        el.type,
        el.x,
        el.y,
        el.width,
        el.height,
        customData.videoUrl,
        el.link,
        customData.assetId,
        customData.title,
        customData.prompt,
        customData.model,
        customData.durationSeconds,
        customData.resolution,
        customData.aspectRatio,
        customData.mimeType,
      ].join(":");
    })
    .join("|")}@${scrollX}:${scrollY}:${zoom}`;
}

function getVideoOverlayItems(
  elements: readonly CanvasOverlayElement[],
  scrollX: number,
  scrollY: number,
  zoom: number,
): VideoOverlayItem[] {
  return elements
    .filter((el) => {
      if (el.isDeleted || el.type === "embeddable") return false;
      const customData = el.customData ?? {};
      const videoUrl =
        typeof customData.videoUrl === "string"
          ? customData.videoUrl
          : typeof el.link === "string"
            ? el.link
            : null;
      return (
        typeof el.id === "string" &&
        typeof videoUrl === "string" &&
        (customData.isVideo === true || isVideoUrl(videoUrl))
      );
    })
    .map((el) => {
      const customData = el.customData ?? {};
      const id = typeof el.id === "string" ? el.id : "";
      const videoUrl =
        typeof customData.videoUrl === "string"
          ? customData.videoUrl
          : (el.link as string);
      return {
        id,
        screenX: ((el.x ?? 0) + scrollX) * zoom,
        screenY: ((el.y ?? 0) + scrollY) * zoom,
        screenW: (el.width ?? 0) * zoom,
        screenH: (el.height ?? 0) * zoom,
        zoom,
        src: videoUrl,
        ...(typeof customData.assetId === "string"
          ? { assetId: customData.assetId }
          : {}),
        ...(typeof customData.title === "string"
          ? { title: customData.title }
          : {}),
        ...(typeof customData.prompt === "string"
          ? { prompt: customData.prompt }
          : {}),
        ...(typeof customData.model === "string"
          ? { model: customData.model }
          : {}),
        ...(typeof customData.durationSeconds === "number"
          ? { durationSeconds: customData.durationSeconds }
          : {}),
        ...(typeof customData.resolution === "string"
          ? { resolution: customData.resolution }
          : {}),
        ...(typeof customData.aspectRatio === "string"
          ? { aspectRatio: customData.aspectRatio }
          : {}),
        ...(typeof customData.mimeType === "string"
          ? { mimeType: customData.mimeType }
          : {}),
      };
    });
}

function VideoOverlayFrame({ excalidrawApi, item }: VideoOverlayFrameProps) {
  const [dragging, setDragging] = useState(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button != null && event.button !== 0) return;
      cleanupDragRef.current?.();
      const startElement = excalidrawApi
        .getSceneElements()
        .find((el) => el.id === item.id && !el.isDeleted);
      if (!startElement) return;

      excalidrawApi.updateScene({
        appState: { selectedElementIds: { [item.id]: true } },
      });

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startX = startElement.x ?? 0;
      const startY = startElement.y ?? 0;
      const zoom = excalidrawApi.getAppState().zoom?.value ?? 1;
      let didDrag = false;
      const previousCursor = document.body.style.cursor;

      const updateElementPosition = (clientX: number, clientY: number) => {
        const nextX = startX + (clientX - startClientX) / zoom;
        const nextY = startY + (clientY - startClientY) / zoom;
        const elements = excalidrawApi.getSceneElements().map((el) => {
          if (el.id !== item.id) return el;
          return {
            ...el,
            x: nextX,
            y: nextY,
            version: ((el.version as number | undefined) ?? 1) + 1,
            versionNonce: Math.floor(Math.random() * 2_000_000_000),
            updated: Date.now(),
          };
        });
        excalidrawApi.updateScene({
          elements,
          appState: { selectedElementIds: { [item.id]: true } },
          captureUpdate: "IMMEDIATELY",
        });
      };

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const deltaX = pointerEvent.clientX - startClientX;
        const deltaY = pointerEvent.clientY - startClientY;
        if (!didDrag) {
          if (Math.hypot(deltaX, deltaY) < VIDEO_OVERLAY_DRAG_THRESHOLD) {
            return;
          }
          didDrag = true;
          setDragging(true);
          document.body.style.cursor = "grabbing";
        }
        pointerEvent.preventDefault();
        updateElementPosition(pointerEvent.clientX, pointerEvent.clientY);
      };

      const removeListeners = () => {
        document.removeEventListener("pointermove", handlePointerMove, true);
        document.removeEventListener("pointerup", handlePointerUp, true);
        document.removeEventListener("pointercancel", handlePointerUp, true);
        document.body.style.cursor = previousCursor;
        setDragging(false);
        cleanupDragRef.current = null;
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (didDrag) {
          pointerEvent.preventDefault();
          updateElementPosition(pointerEvent.clientX, pointerEvent.clientY);
        }
        removeListeners();
      };

      document.addEventListener("pointermove", handlePointerMove, true);
      document.addEventListener("pointerup", handlePointerUp, true);
      document.addEventListener("pointercancel", handlePointerUp, true);
      cleanupDragRef.current = removeListeners;
    },
    [excalidrawApi, item.id],
  );

  useEffect(() => {
    return () => cleanupDragRef.current?.();
  }, []);

  return (
    <div
      className="pointer-events-none fixed z-20"
      style={{
        left: item.screenX,
        top: item.screenY,
        width: item.screenW,
        height: item.screenH,
      }}
      onPointerDown={handlePointerDown}
    >
      <VideoCanvasElement
        src={toRuntimeAssetUrl(item.src, item.assetId)}
        width={item.screenW}
        height={item.screenH}
        title={item.title}
        prompt={item.prompt}
        model={item.model}
        durationSeconds={item.durationSeconds}
        resolution={item.resolution}
        aspectRatio={item.aspectRatio}
        mimeType={item.mimeType}
        zoom={item.zoom}
        dragEnabled
        dragging={dragging}
      />
    </div>
  );
}

export function CanvasToolMenu({
  canvasId,
  excalidrawApi,
  leftPanelOpen,
  projectId,
}: CanvasToolMenuProps) {
  const { t } = useAppTranslation("canvas");
  const { activeImageGenerationPreference } = useImageModelPreference();
  const { activeVideoGenerationPreference } = useVideoModelPreference();
  const [activeTool, setActiveTool] = useState<string>("selection");

  // Image generator state
  const [activeGeneratorId, setActiveGeneratorId] = useState<string | null>(
    null,
  );
  const [generatorData, setGeneratorData] = useState<ImageGeneratorData | null>(
    null,
  );
  const [generatorBounds, setGeneratorBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const [activeVideoGenId, setActiveVideoGenId] = useState<string | null>(null);
  const [videoGenData, setVideoGenData] = useState<VideoGeneratorData | null>(
    null,
  );
  const [videoGenBounds, setVideoGenBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [videoGenPanelHidden, setVideoGenPanelHidden] = useState(false);

  const [canvasScrollZoom, setCanvasScrollZoom] = useState({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });

  // Track generating elements for shimmer overlay
  const [generatingElements, setGeneratingElements] = useState<
    GeneratorOverlayItem[]
  >([]);
  const [errorElements, setErrorElements] = useState<GeneratorOverlayItem[]>(
    [],
  );
  const [videoElements, setVideoElements] = useState<VideoOverlayItem[]>([]);

  // Keep activeGeneratorId accessible inside onChange without causing re-subscription
  const activeGeneratorIdRef = useRef(activeGeneratorId);
  activeGeneratorIdRef.current = activeGeneratorId;
  const activeVideoGenIdRef = useRef(activeVideoGenId);
  activeVideoGenIdRef.current = activeVideoGenId;

  // Track previous generating element IDs to avoid re-renders when nothing changed
  const prevGeneratingKeyRef = useRef("");
  const prevErrorKeyRef = useRef("");
  const prevVideoKeyRef = useRef("");

  // Helper: close all generator panels
  const closeAllPanels = useCallback(() => {
    setActiveGeneratorId(null);
    setGeneratorData(null);
    setGeneratorBounds(null);
    setActiveVideoGenId(null);
    setVideoGenData(null);
    setVideoGenBounds(null);
    setVideoGenPanelHidden(false);
  }, []);

  useEffect(() => {
    if (!excalidrawApi) return;
    const normalized = normalizeCanvasToolElements(
      excalidrawApi.getSceneElements(),
    );
    if (normalized) {
      excalidrawApi.updateScene({
        elements: normalized,
        captureUpdate: "IMMEDIATELY",
      });
    }
    const appState = excalidrawApi.getAppState();
    const scrollX = appState.scrollX ?? 0;
    const scrollY = appState.scrollY ?? 0;
    const zoom = appState.zoom?.value ?? 1;
    const errorRaw = excalidrawApi
      .getSceneElements()
      .filter(
        (el) =>
          !el.isDeleted &&
          (isImageGeneratorElement(el) || isVideoGeneratorElement(el)) &&
          el.customData?.status === "error",
      );
    prevErrorKeyRef.current = `${errorRaw
      .map(
        (el) =>
          `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${el.customData?.errorMessage ?? ""}`,
      )
      .join("|")}@${scrollX}:${scrollY}:${zoom}`;
    setErrorElements(
      errorRaw.map((el) => ({
        id: el.id ?? "",
        screenX: ((el.x ?? 0) + scrollX) * zoom,
        screenY: ((el.y ?? 0) + scrollY) * zoom,
        screenW: (el.width ?? 0) * zoom,
        screenH: (el.height ?? 0) * zoom,
        zoom,
        ...(typeof el.customData?.errorMessage === "string"
          ? { errorMessage: el.customData.errorMessage }
          : {}),
      })),
    );
    const videoRaw = excalidrawApi.getSceneElements();
    prevVideoKeyRef.current = getVideoOverlayKey(
      videoRaw,
      scrollX,
      scrollY,
      zoom,
    );
    setVideoElements(getVideoOverlayItems(videoRaw, scrollX, scrollY, zoom));
  }, [excalidrawApi]);

  // Subscribe to Excalidraw changes.
  // This fires on every frame during drag / drawing, so we must be very
  // careful to avoid unnecessary state updates that trigger re-renders.
  useEffect(() => {
    if (!excalidrawApi) return;

    const unsubscribe = excalidrawApi.onChange((elements, appState) => {
      const normalized = normalizeCanvasToolElements(elements);
      if (normalized) {
        excalidrawApi.updateScene({
          elements: normalized,
          captureUpdate: "IMMEDIATELY",
        });
        return;
      }

      // --- Tool sync (cheap string comparison, skip if unchanged) ---
      const tool = appState?.activeTool?.type;
      if (tool) setActiveTool((prev: string) => (prev === tool ? prev : tool));

      const scrollX = appState?.scrollX ?? 0;
      const scrollY = appState?.scrollY ?? 0;
      const zoom = appState?.zoom?.value ?? 1;
      // Only update scroll/zoom state if values actually changed
      setCanvasScrollZoom((prev) => {
        if (
          prev.scrollX === scrollX &&
          prev.scrollY === scrollY &&
          prev.zoom === zoom
        )
          return prev;
        return { scrollX, scrollY, zoom };
      });

      // --- Selection-based panel management ---
      const selectedIds = appState?.selectedElementIds ?? {};
      const selectedElements = elements.filter(
        (el) =>
          typeof el.id === "string" && selectedIds[el.id] && !el.isDeleted,
      );

      const currentId = activeGeneratorIdRef.current;
      const currentVideoId = activeVideoGenIdRef.current;
      const selectedElementTransforming =
        isSelectedElementTransforming(appState);
      if (selectedElements.length === 1) {
        const sel = selectedElements[0];
        if (!sel) return;
        const selectedId = typeof sel.id === "string" ? sel.id : "";
        const selectedBounds = getElementBounds(sel);

        if (isImageGeneratorElement(sel)) {
          // Only update if the selected generator changed
          if (currentId !== selectedId) {
            const data = getImageGeneratorData(sel);
            setActiveGeneratorId(selectedId);
            setGeneratorData(data);
            if (currentVideoId) {
              setActiveVideoGenId(null);
              setVideoGenData(null);
              setVideoGenBounds(null);
            }
          }
          // Always update bounds (element may have been moved/resized)
          setGeneratorBounds(selectedBounds);
        } else if (isVideoGeneratorElement(sel)) {
          if (currentVideoId !== selectedId) {
            const data = getVideoGeneratorData(sel);
            setActiveVideoGenId(selectedId);
            setVideoGenData(data);
            if (currentId) {
              setActiveGeneratorId(null);
              setGeneratorData(null);
              setGeneratorBounds(null);
            }
          }
          setVideoGenBounds(selectedBounds);
          setVideoGenPanelHidden((prev) =>
            prev === selectedElementTransforming
              ? prev
              : selectedElementTransforming,
          );
        } else {
          if (currentId || currentVideoId) {
            closeAllPanels();
          }
          setVideoGenPanelHidden(false);
        }
      } else {
        if (currentId || currentVideoId) {
          closeAllPanels();
        }
        setVideoGenPanelHidden(false);
      }

      // --- Generator status overlays ---
      // Build stable keys so we skip setState when overlay sets are unchanged.
      const generatorRaw = elements.filter(
        (el) =>
          !el.isDeleted &&
          (isImageGeneratorElement(el) || isVideoGeneratorElement(el)),
      );
      const generatingRaw = generatorRaw.filter(
        (el) => el.customData?.status === "generating",
      );
      const errorRaw = generatorRaw.filter(
        (el) => el.customData?.status === "error",
      );

      // Include viewport state as well, because the shimmer overlay is
      // rendered in screen coordinates and must move when the canvas pans
      // or zooms even if the scene element itself did not change.
      const genKey = `${generatingRaw
        .map(
          (el) =>
            `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${el.customData?.model ?? ""}`,
        )
        .join("|")}@${scrollX}:${scrollY}:${zoom}`;

      if (genKey !== prevGeneratingKeyRef.current) {
        prevGeneratingKeyRef.current = genKey;
        const generating = generatingRaw.map((el) => ({
          id: el.id ?? "",
          screenX: ((el.x ?? 0) + scrollX) * zoom,
          screenY: ((el.y ?? 0) + scrollY) * zoom,
          screenW: (el.width ?? 0) * zoom,
          screenH: (el.height ?? 0) * zoom,
          zoom,
          ...(el.customData?.model
            ? { model: el.customData.model as string }
            : {}),
        }));
        setGeneratingElements(generating);
      }

      const errorKey = `${errorRaw
        .map(
          (el) =>
            `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${el.customData?.errorMessage ?? ""}`,
        )
        .join("|")}@${scrollX}:${scrollY}:${zoom}`;

      if (errorKey !== prevErrorKeyRef.current) {
        prevErrorKeyRef.current = errorKey;
        const errored = errorRaw.map((el) => ({
          id: el.id ?? "",
          screenX: ((el.x ?? 0) + scrollX) * zoom,
          screenY: ((el.y ?? 0) + scrollY) * zoom,
          screenW: (el.width ?? 0) * zoom,
          screenH: (el.height ?? 0) * zoom,
          zoom,
          ...(typeof el.customData?.errorMessage === "string"
            ? { errorMessage: el.customData.errorMessage }
            : {}),
        }));
        setErrorElements(errored);
      }

      const videoKey = getVideoOverlayKey(elements, scrollX, scrollY, zoom);

      if (videoKey !== prevVideoKeyRef.current) {
        prevVideoKeyRef.current = videoKey;
        setVideoElements(
          getVideoOverlayItems(elements, scrollX, scrollY, zoom),
        );
      }
    });

    return unsubscribe;
  }, [excalidrawApi, closeAllPanels]);

  const handleToolChange = useCallback(
    (tool: ToolType) => {
      excalidrawApi?.setActiveTool({ type: tool });
    },
    [excalidrawApi],
  );

  const handleCreateImageGenerator = useCallback(() => {
    if (!excalidrawApi) return;
    const preferredModel = activeImageGenerationPreference?.models[0];
    const elementId = createImageGeneratorElement(excalidrawApi, {
      ...(preferredModel ? { model: preferredModel } : {}),
    });
    // Select the newly created element so onChange recognises it
    excalidrawApi.updateScene({
      appState: { selectedElementIds: { [elementId]: true } },
    });
    setActiveGeneratorId(elementId);
    // Read back the created element to populate initial state
    const elements = excalidrawApi.getSceneElements();
    const el = elements.find((e) => e.id === elementId);
    if (el) {
      setGeneratorData(getImageGeneratorData(el));
      setGeneratorBounds({
        x: el.x as number,
        y: el.y as number,
        width: el.width as number,
        height: el.height as number,
      });
    }
  }, [activeImageGenerationPreference, excalidrawApi]);

  const clearSelectionForElement = useCallback(
    (elementId: string | null) => {
      if (!elementId || !excalidrawApi) return;
      const selectedElementIds =
        excalidrawApi.getAppState()?.selectedElementIds;
      if (!selectedElementIds?.[elementId]) return;
      excalidrawApi.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: "IMMEDIATELY",
      });
    },
    [excalidrawApi],
  );

  const handleCloseGenerator = useCallback(() => {
    clearSelectionForElement(activeGeneratorIdRef.current);
    setActiveGeneratorId(null);
    setGeneratorData(null);
    setGeneratorBounds(null);
  }, [clearSelectionForElement]);

  const handleCreateVideoGenerator = useCallback(() => {
    if (!excalidrawApi) return;
    const preferredModel = activeVideoGenerationPreference?.models[0];
    const elementId = createVideoGeneratorElement(excalidrawApi, {
      aspectRatio: "16:9",
      ...(preferredModel ? { model: preferredModel } : {}),
    });
    excalidrawApi.updateScene({
      appState: { selectedElementIds: { [elementId]: true } },
    });
    setActiveVideoGenId(elementId);
    setVideoGenPanelHidden(false);
    const elements = excalidrawApi.getSceneElements();
    const el = elements.find((item) => item.id === elementId);
    if (el) {
      setVideoGenData(getVideoGeneratorData(el));
      setVideoGenBounds({
        x: el.x as number,
        y: el.y as number,
        width: el.width as number,
        height: el.height as number,
      });
    }
  }, [activeVideoGenerationPreference, excalidrawApi]);

  const handleCloseVideoGenerator = useCallback(() => {
    clearSelectionForElement(activeVideoGenIdRef.current);
    setActiveVideoGenId(null);
    setVideoGenData(null);
    setVideoGenBounds(null);
    setVideoGenPanelHidden(false);
  }, [clearSelectionForElement]);

  useEffect(() => {
    if (!activeGeneratorId && !activeVideoGenId) return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isExcalidrawContextMenuTarget(target)) return;
      const panel = document.querySelector("[data-aimc-generator-panel]");
      if (panel?.contains(target)) return;
      if (isExcalidrawCanvasTarget(target)) return;

      if (activeGeneratorIdRef.current) handleCloseGenerator();
      if (activeVideoGenIdRef.current) handleCloseVideoGenerator();
    };

    document.addEventListener("pointerdown", handlePointerDownOutside, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutside,
        true,
      );
  }, [
    activeGeneratorId,
    activeVideoGenId,
    handleCloseGenerator,
    handleCloseVideoGenerator,
  ]);

  return (
    <>
      <div
        className="pointer-events-none absolute right-4 bottom-[72px] z-30 flex justify-center transition-[left,bottom] duration-200 @min-[900px]/canvas:bottom-5"
        style={{
          left: leftPanelOpen ? "280px" : "16px",
        }}
      >
        <div className="pointer-events-auto flex w-[min(max-content,100%)] shrink-0 items-center gap-0.5 overflow-x-auto rounded-xl border border-border bg-card/75 p-1 shadow-card [scrollbar-width:none] backdrop-blur-lg [&::-webkit-scrollbar]:hidden">
          {/* Standard Excalidraw tools */}
          {TOOL_GROUPS.map(({ id, tool }) => {
            if (tool === null) {
              return (
                <div key={id} className="mx-0.5 h-6 w-px shrink-0 bg-border" />
              );
            }

            const Icon = TOOL_ICONS[tool];
            const isActive = activeTool === tool;

            return (
              <ToolbarButton
                key={tool}
                label={t(TOOL_LABEL_KEYS[tool])}
                active={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleToolChange(tool);
                }}
              >
                <Icon className="size-[16px]" />
              </ToolbarButton>
            );
          })}

          {/* Separator before AI tools */}
          <div className="mx-0.5 h-6 w-px shrink-0 bg-border" />

          {/* AI Image -- creates a generator node on canvas */}
          <ToolbarButton
            label={t("tools.generateImage")}
            active={Boolean(activeGeneratorId)}
            onClick={handleCreateImageGenerator}
          >
            <ImageGeneratorIcon />
          </ToolbarButton>

          <ToolbarButton
            label={t("tools.generateVideo")}
            active={Boolean(activeVideoGenId)}
            onClick={handleCreateVideoGenerator}
          >
            <Video className="size-[16px]" />
          </ToolbarButton>
        </div>
      </div>

      {/* Image Generator Panel -- floats below the selected generator node */}
      {activeGeneratorId &&
        generatorData &&
        generatorBounds &&
        excalidrawApi && (
          <ImageGeneratorPanel
            elementId={activeGeneratorId}
            elementBounds={generatorBounds}
            data={generatorData}
            excalidrawApi={excalidrawApi}
            canvasScrollZoom={canvasScrollZoom}
            projectId={projectId}
            onClose={handleCloseGenerator}
          />
        )}

      {activeVideoGenId && videoGenData && videoGenBounds && excalidrawApi && (
        <VideoGeneratorPanel
          elementId={activeVideoGenId}
          elementBounds={videoGenBounds}
          canvasId={canvasId}
          data={videoGenData}
          excalidrawApi={excalidrawApi}
          projectId={projectId}
          canvasScrollZoom={canvasScrollZoom}
          hidden={videoGenPanelHidden}
          onClose={handleCloseVideoGenerator}
        />
      )}

      {/* Shimmer overlays for generating elements */}
      {generatingElements.length > 0 &&
        createPortal(
          generatingElements.map((el) => (
            <GeneratingOverlay
              key={el.id}
              {...el}
              label={t("tools.generating")}
            />
          )),
          document.body,
        )}

      {errorElements.length > 0 &&
        createPortal(
          errorElements.map((el) => (
            <GeneratorErrorOverlay
              key={el.id}
              {...el}
              errorMessage={el.errorMessage || t("tools.generateFailed")}
            />
          )),
          document.body,
        )}

      {videoElements.length > 0 &&
        excalidrawApi &&
        createPortal(
          videoElements.map((el) => (
            <VideoOverlayFrame
              key={el.id}
              item={el}
              excalidrawApi={excalidrawApi}
            />
          )),
          document.body,
        )}
    </>
  );
}
