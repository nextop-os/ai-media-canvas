"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import type { StreamEvent, ToolArtifact } from "@aimc/shared";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import { CanvasBottomBar } from "../../components/canvas-bottom-bar";
import { CanvasEditor } from "../../components/canvas-editor";
import type { CanvasSelectedElement } from "../../components/canvas-editor";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasFilesPanel } from "../../components/canvas-files-panel";
import { CanvasLayersPanel } from "../../components/canvas-layers-panel";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { ChatSidebar } from "../../components/chat-sidebar";
import type { CanvasImageItem } from "../../components/chat-sidebar";
import { EditableProjectName } from "../../components/editable-project-name";
import { LoadingScreen } from "../../components/loading-screen";
import { useToast } from "../../components/toast";
import { Button } from "../../components/ui/button";
import { useCanvasGenerationJobRecovery } from "../../hooks/use-canvas-generation-job-recovery";
import { useWebSocket } from "../../hooks/use-websocket";
import { useAppTranslation } from "../../i18n";
import {
  fetchAsDataURL,
  insertImageOnCanvas,
  insertVideoOnCanvas,
} from "../../lib/canvas-elements";
import { resolveCanvasImageFiles } from "../../lib/canvas-file-serialization";
import { cancelGeneratingCanvasElementsForRun } from "../../lib/canvas-generation-cancel";
import { SHOW_BRAND_KIT_ENTRY_POINTS } from "../../lib/feature-flags";
import {
  type GenerationJobSubscription,
  generationJobService,
} from "../../lib/generation-job-service";
import { fetchCanvas, fetchProject } from "../../lib/server-api";

type CanvasFileRecord = Record<string, unknown>;

type CanvasSceneElement = Record<string, unknown> & {
  customData?: Record<string, unknown>;
  fileId?: string | null;
  id?: string;
  isDeleted?: boolean;
  type?: string;
};

type CanvasImageElement = CanvasSceneElement & {
  fileId: string;
  id: string;
  type: "image";
};

type ExcalidrawApiLike = {
  addFiles(files: CanvasFileRecord[]): void;
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, CanvasFileRecord>;
  getSceneElements(): readonly CanvasSceneElement[];
  onChange(
    handler: (
      elements: CanvasSceneElement[],
      appState: Record<string, unknown>,
    ) => void,
  ): () => void;
  updateScene(scene: {
    captureUpdate?: string;
    elements: Record<string, unknown>[];
  }): void;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCanvasImageElement(
  element: CanvasSceneElement,
): element is CanvasImageElement {
  return (
    element.type === "image" &&
    typeof element.id === "string" &&
    element.isDeleted !== true &&
    typeof element.fileId === "string"
  );
}

function CanvasPageContent() {
  const { t } = useAppTranslation("errors");
  const { t: tCanvas } = useAppTranslation("canvas");
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const initialSessionId = searchParams.get("session") ?? undefined;
  // Capture prompt once — router.replace will strip it from URL, but the
  // value must survive for the auto-send effect in ChatSidebar.
  const [initialPrompt] = useState(
    () => searchParams.get("prompt") ?? undefined,
  );
  const [initialRequestId] = useState(
    () => searchParams.get("requestId") ?? undefined,
  );
  const router = useRouter();

  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    revision: number;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const shouldOpenChatFromUrl = Boolean(initialPrompt || initialSessionId);
  // Default chat open on desktop; keep chat-led entries visible on narrow screens.
  const [chatOpen, setChatOpen] = useState(() => {
    if (shouldOpenChatFromUrl) return true;
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1024;
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled");
  const [selectedCanvasElements, setSelectedCanvasElements] = useState<
    CanvasSelectedElement[]
  >([]);
  const { error: toastError } = useToast();

  const excalidrawApiRef = useRef<ExcalidrawApiLike | null>(null);
  const currentCanvasIdRef = useRef(canvasId);
  const fallbackSubscriptionsRef = useRef<GenerationJobSubscription[]>([]);
  const tRef = useRef(t);
  const toastErrorRef = useRef(toastError);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawApiLike | null>(
    null,
  );

  tRef.current = t;
  toastErrorRef.current = toastError;
  currentCanvasIdRef.current = canvasId;
  useCanvasGenerationJobRecovery(excalidrawApi);

  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable callbacks for panel toggles to prevent re-renders of child components
  const handleOpenChat = useCallback(() => setChatOpen(true), []);
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const handleToggleLayers = useCallback(() => {
    setLayersOpen((v) => !v);
    setFilesOpen(false);
  }, []);
  const handleToggleFiles = useCallback(() => {
    setFilesOpen((v) => !v);
    setLayersOpen(false);
  }, []);
  const handleCloseLayers = useCallback(() => setLayersOpen(false), []);
  const handleCloseFiles = useCallback(() => setFilesOpen(false), []);

  const ws = useWebSocket();

  const handleApiReady = useCallback((api: unknown) => {
    const canvasApi = api as ExcalidrawApiLike;
    excalidrawApiRef.current = canvasApi;
    setExcalidrawApi(canvasApi);
  }, []);

  const handleImageGenerated = useCallback((artifact: ToolArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const task =
      artifact.type === "video"
        ? insertVideoOnCanvas(api, artifact)
        : insertImageOnCanvas(api, artifact);
    task.catch((err) => {
      console.warn("Failed to insert generated media on canvas:", err);
    });
  }, []);

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      if (event.type === "run.canceled") {
        cancelGeneratingCanvasElementsForRun(
          excalidrawApiRef.current,
          event.runId,
          tCanvas("tools.generateCanceled"),
        );
        return;
      }
      if (event.type !== "tool.completed") return;
      const output = event.output as
        | {
            jobId?: unknown;
            jobType?: unknown;
            videoUrl?: unknown;
            url?: unknown;
            elementId?: unknown;
          }
        | undefined;
      const jobId = typeof output?.jobId === "string" ? output.jobId : null;
      const jobType =
        output?.jobType === "image_generation" ||
        output?.jobType === "video_generation"
          ? output.jobType
          : null;
      if (!jobId || !jobType) return;
      if (typeof output?.elementId === "string") return;
      if (
        typeof output?.videoUrl === "string" ||
        typeof output?.url === "string"
      ) {
        return;
      }
      const isVideo = jobType === "video_generation";
      const sourceCanvasId = currentCanvasIdRef.current;
      const subscription = generationJobService.watch(jobId, {
        jobType,
        onSucceeded: (result) => {
          if (currentCanvasIdRef.current !== sourceCanvasId) return;
          const url = result.signed_url;
          const assetId = result.asset_id;
          const mimeType = result.mime_type;
          const width = result.width;
          const height = result.height;
          if (
            typeof url !== "string" ||
            typeof mimeType !== "string" ||
            typeof width !== "number" ||
            typeof height !== "number"
          ) {
            return;
          }
          if (isVideo) {
            const durationSeconds = result.duration_seconds;
            const prompt = result.prompt;
            const model = result.model;
            const aspectRatio =
              typeof result.aspectRatio === "string"
                ? result.aspectRatio
                : result.aspect_ratio;
            const resolution = result.resolution;
            handleImageGenerated({
              type: "video",
              ...(typeof assetId === "string" ? { assetId } : {}),
              url,
              mimeType,
              width,
              height,
              ...(typeof durationSeconds === "number"
                ? { durationSeconds }
                : {}),
              ...(typeof prompt === "string" ? { prompt } : {}),
              ...(typeof model === "string" ? { model } : {}),
              ...(typeof aspectRatio === "string" ? { aspectRatio } : {}),
              ...(typeof resolution === "string" ? { resolution } : {}),
              jobId,
            });
          } else {
            handleImageGenerated({
              type: "image",
              ...(typeof assetId === "string" ? { assetId } : {}),
              url,
              mimeType,
              width,
              height,
              jobId,
            });
          }
        },
        onFailed: (err) => {
          console.warn("[canvas] fallback generation polling failed:", err);
        },
      });
      void subscription.promise.catch(() => {
        // Failure is surfaced through onFailed; no UI state lives in this page path.
      });
      fallbackSubscriptionsRef.current.push(subscription);
    },
    [handleImageGenerated, tCanvas],
  );

  useEffect(() => {
    return () => {
      for (const subscription of fallbackSubscriptionsRef.current) {
        subscription.unsubscribe();
      }
      fallbackSubscriptionsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!canvasId) return;
    for (const subscription of fallbackSubscriptionsRef.current) {
      subscription.unsubscribe();
    }
    fallbackSubscriptionsRef.current = [];
  }, [canvasId]);

  // Must be defined BEFORE useJobFallbackPolling which references it
  const handleCanvasSync = useCallback(async () => {
    const api = excalidrawApiRef.current;
    if (!api || !canvasData) return;
    try {
      const { canvas } = await fetchCanvas(canvasData.id);
      const resolved = await resolveCanvasImageFiles(
        {
          elements: canvas.content.elements ?? [],
          appState: canvas.content.appState ?? {},
          files:
            ((canvas.content as Record<string, unknown>).files as Record<
              string,
              Record<string, unknown>
            >) ?? {},
        },
        fetchAsDataURL,
      );

      // Sync files into Excalidraw after resolving storage URLs to data URLs.
      if (Object.keys(resolved.files).length > 0) {
        api.addFiles(Object.values(resolved.files));
      }

      window.dispatchEvent(
        new CustomEvent("aimc:canvas-remote-sync", {
          detail: { canvasId: canvasData.id },
        }),
      );
      api.updateScene({
        elements: resolved.elements,
        captureUpdate: "NONE",
      });
      setCanvasData((current) =>
        current && current.id === canvas.id
          ? {
              ...current,
              revision: canvas.revision,
              content: {
                elements: canvas.content.elements ?? [],
                appState: canvas.content.appState ?? {},
                files:
                  ((canvas.content as Record<string, unknown>).files as Record<
                    string,
                    Record<string, unknown>
                  >) ?? {},
              },
            }
          : current,
      );
    } catch (err) {
      console.warn("Failed to sync canvas:", err);
    }
  }, [canvasData]);

  const handleSessionChange = useCallback(
    (sessionId: string) => {
      if (!canvasId) return;
      // Update URL: set session param, remove prompt param to prevent re-send on refresh
      routerRef.current.replace(`/canvas?id=${canvasId}&session=${sessionId}`);
    },
    [canvasId],
  );

  const handleRequestCanvasImages = useCallback((): CanvasImageItem[] => {
    const api = excalidrawApiRef.current;
    if (!api) return [];
    const elements = api.getSceneElements() ?? [];
    const files = api.getFiles() ?? {};
    return elements.filter(isCanvasImageElement).map((el) => {
      const file = files[el.fileId];
      const dataURL = stringValue(file?.dataURL) ?? "";
      return {
        assetId: el.id,
        url: stringValue(el.customData?.storageUrl) ?? dataURL,
      };
    });
  }, []);

  const loadProjectShell = useCallback(async (projectId: string) => {
    try {
      const projectData = await fetchProject(projectId);
      setBrandKitId(projectData.project.brandKitId);
      setProjectName(projectData.project.name ?? "Untitled");
    } catch (err) {
      console.warn("Failed to fetch project for brand kit:", err);
      toastErrorRef.current(tRef.current("canvas.projectLoadFailed"));
    }
  }, []);

  useEffect(() => {
    if (!canvasId) return;

    setPageLoading(true);
    fetchCanvas(canvasId)
      .then((data) => {
        const c = data.canvas;
        setCanvasData({
          id: c.id,
          name: c.name,
          projectId: c.projectId,
          revision: c.revision,
          content: {
            elements: c.content.elements ?? [],
            appState: c.content.appState ?? {},
            files:
              ((c.content as Record<string, unknown>).files as Record<
                string,
                Record<string, unknown>
              >) ?? {},
          },
        });
        setPageLoading(false);
        void loadProjectShell(c.projectId);
      })
      .catch(() => {
        setError(tRef.current("canvas.loadFailed"));
        setPageLoading(false);
      });
  }, [canvasId, loadProjectShell]);

  if (!canvasId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("canvas.missingId")}</p>
      </div>
    );
  }

  if (pageLoading) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={() => router.refresh()}>
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!canvasData) return null;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Top-left navigation bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          excalidrawApi={excalidrawApi}
        />
        <EditableProjectName
          projectId={canvasData.projectId}
          initialName={projectName}
        />
        {SHOW_BRAND_KIT_ENTRY_POINTS && (
          <BrandKitSelector
            projectId={canvasData.projectId}
            currentBrandKitId={brandKitId}
            onBrandKitChange={(kitId) => setBrandKitId(kitId)}
          />
        )}
      </div>
      {/* Canvas always takes full width; on mobile/tablet, ChatSidebar overlays instead of side-by-side */}
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <CanvasEditor
          key={canvasData.id}
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          initialRevision={canvasData.revision}
          initialContent={canvasData.content}
          onApiReady={handleApiReady}
          ws={ws}
          leftPanelOpen={layersOpen || filesOpen}
          onSelectionChange={setSelectedCanvasElements}
          onSaveConflict={handleCanvasSync}
        />
        <CanvasEmptyHint
          excalidrawApi={excalidrawApi}
          onOpenChat={handleOpenChat}
        />
        <CanvasBottomBar
          excalidrawApi={excalidrawApi}
          layersOpen={layersOpen}
          onToggleLayers={handleToggleLayers}
          filesOpen={filesOpen}
          onToggleFiles={handleToggleFiles}
          leftPanelOpen={layersOpen || filesOpen}
        />
        <CanvasLayersPanel
          excalidrawApi={excalidrawApi}
          open={layersOpen}
          onClose={handleCloseLayers}
        />
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={filesOpen}
          onClose={handleCloseFiles}
        />
      </div>
      <ChatSidebar
        canvasId={canvasData.id}
        projectId={canvasData.projectId}
        open={chatOpen}
        onToggle={handleToggleChat}
        onImageGenerated={handleImageGenerated}
        onCanvasSync={handleCanvasSync}
        onStreamEvent={handleStreamEvent}
        initialPrompt={initialPrompt}
        initialRequestId={initialRequestId}
        initialSessionId={initialSessionId}
        onSessionChange={handleSessionChange}
        onRequestCanvasImages={handleRequestCanvasImages}
        ws={ws}
        selectedCanvasElements={selectedCanvasElements}
      />
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasPageContent />
    </Suspense>
  );
}
