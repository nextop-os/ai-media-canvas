"use client";

import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentModelSource,
  ContentBlock,
  ImageGenerationPreference,
  StreamEvent,
  ToolArtifact,
  VideoGenerationPreference,
} from "@aimc/shared";
import { useAgentModelRequirement } from "../hooks/use-agent-model-requirement";
import { useBreakpoint } from "../hooks/use-breakpoint";
import { mapServerMessages, useChatSessions } from "../hooks/use-chat-sessions";
import {
  materializeAssistantBlocksFromEvents,
  useChatStream,
} from "../hooks/use-chat-stream";
import {
  INITIAL_AGENT_MODEL_KEY,
  INITIAL_AGENT_MODEL_SOURCE_KEY,
  INITIAL_ATTACHMENTS_KEY,
  INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
  INITIAL_VIDEO_GENERATION_PREFERENCE_KEY,
} from "../hooks/use-create-project";
import type { ReadyAttachment } from "../hooks/use-image-attachments";
import { useImageAttachments } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import type { WebSocketHandle } from "../hooks/use-websocket";
import { useAppTranslation } from "../i18n";
import {
  type GenerationJobSubscription,
  type GenerationJobType,
  generationJobService,
} from "../lib/generation-job-service";
import { toRuntimeAssetUrl } from "../lib/local-assets";
import {
  fetchImageModels,
  fetchRunEvents,
  saveMessage,
} from "../lib/server-api";
import { reportUserActive } from "../lib/tutti-activity";
import type { CanvasSelectedElement } from "./canvas-editor";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { ChatTemplates } from "./chat-templates";
import { ErrorBoundary } from "./error-boundary";
import { SessionSelector } from "./session-selector";
import { SettingsDialog } from "./settings-dialog";
import type { SettingsTab } from "./settings-panel";
import { useToast } from "./toast";

type ChatSidebarProps = {
  canvasId: string;
  projectId: string;
  open: boolean;
  onToggle: () => void;
  onImageGenerated?: (artifact: ToolArtifact) => void;
  onCanvasSync?: () => void;
  /** Called for every stream event for job fallback polling. */
  onStreamEvent?: (event: StreamEvent) => void;
  initialPrompt?: string | undefined;
  initialRequestId?: string | undefined;
  initialSessionId?: string | undefined;
  onSessionChange?: (sessionId: string) => void;
  onRequestCanvasImages?: () => CanvasImageItem[];
  ws: WebSocketHandle;
  selectedCanvasElements?: CanvasSelectedElement[];
};

type DeferredMediaJob = {
  jobId: string;
  jobType: GenerationJobType;
  output: Record<string, unknown>;
};

type SendFailureStage = "save_message" | "agent_run_ack" | "stream";

export type CanvasImageItem = {
  assetId: string;
  url: string;
};

function summarizeReadyAttachments(attachments: ReadyAttachment[]) {
  return attachments.map((attachment, index) => {
    const url = attachment.url;
    const dataUriMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
    const base = {
      assetId: attachment.assetId,
      index: index + 1,
      mimeType: attachment.mimeType,
      name: attachment.name,
      source: attachment.source,
      urlBytes: byteLength(url),
      urlKind: classifyAttachmentUrl(url),
    };

    if (dataUriMatch) {
      return {
        ...base,
        dataMimeType: dataUriMatch[1] ?? "unknown",
        estimatedDataBytes: estimateBase64Bytes(dataUriMatch[2] ?? ""),
      };
    }

    try {
      const parsed = new URL(url);
      return {
        ...base,
        urlHost: parsed.host,
        urlPath: parsed.pathname,
      };
    } catch {
      return base;
    }
  });
}

function classifyAttachmentUrl(url: string) {
  if (url.startsWith("data:")) return "data";
  if (url.startsWith("blob:")) return "blob";
  try {
    return new URL(url).protocol.replace(/:$/, "") || "unknown";
  } catch {
    return "invalid";
  }
}

function estimateBase64Bytes(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function isSchemaUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function resolveSelectedCanvasImageUrl(element: CanvasSelectedElement) {
  const storageUrl =
    typeof element.storageUrl === "string" && element.storageUrl
      ? toRuntimeAssetUrl(element.storageUrl)
      : undefined;
  if (storageUrl && isSchemaUrl(storageUrl)) return storageUrl;
  return element.dataUrl;
}

function runtimeCanvasImageUrl(item: CanvasImageItem) {
  return toRuntimeAssetUrl(item.url, item.assetId);
}

function runtimeArtifactUrl(artifact: ToolArtifact) {
  return toRuntimeAssetUrl(artifact.url, artifact.assetId);
}

function summarizeClientError(error: unknown) {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      message: error.message,
      name: error.name,
      ...(typeof errorWithCode.code === "string"
        ? { code: errorWithCode.code }
        : {}),
    };
  }
  return { message: String(error), name: typeof error };
}

function extractDeferredMediaJobFromOutput(
  output: Record<string, unknown> | undefined,
): DeferredMediaJob | null {
  const jobId = typeof output?.jobId === "string" ? output.jobId : null;
  const jobType =
    output?.jobType === "image_generation" ||
    output?.jobType === "video_generation"
      ? output.jobType
      : null;
  if (!jobId || !jobType || output?.status !== "generating") return null;
  if (
    typeof output.url === "string" ||
    typeof output.videoUrl === "string" ||
    typeof output.signed_url === "string"
  ) {
    return null;
  }
  return { jobId, jobType, output };
}

function extractDeferredMediaJob(event: StreamEvent): DeferredMediaJob | null {
  if (event.type !== "tool.completed") return null;
  return extractDeferredMediaJobFromOutput(
    event.output as Record<string, unknown> | undefined,
  );
}

function buildGeneratedMediaArtifact(
  job: DeferredMediaJob,
  result: Record<string, unknown>,
): ToolArtifact | null {
  const url = result.signed_url;
  const assetId = result.asset_id;
  const mimeType = result.mime_type;
  const width = result.width;
  const height = result.height;
  const title = job.output.title;
  if (
    typeof url !== "string" ||
    typeof mimeType !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }

  if (job.jobType === "video_generation") {
    const durationSeconds = result.duration_seconds;
    const prompt = job.output.prompt;
    const model = job.output.model;
    const aspectRatio =
      typeof job.output.aspectRatio === "string"
        ? job.output.aspectRatio
        : job.output.aspect_ratio;
    const resolution = job.output.resolution;
    return {
      type: "video",
      ...(typeof assetId === "string" ? { assetId } : {}),
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof prompt === "string" ? { prompt } : {}),
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof aspectRatio === "string" ? { aspectRatio } : {}),
      ...(typeof resolution === "string" ? { resolution } : {}),
      url,
      mimeType,
      width,
      height,
      ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
      jobId: job.jobId,
    };
  }

  return {
    type: "image",
    ...(typeof assetId === "string" ? { assetId } : {}),
    ...(typeof title === "string" ? { title } : {}),
    url,
    mimeType,
    width,
    height,
    jobId: job.jobId,
  };
}

function filterImageGenerationPreference(
  preference: ImageGenerationPreference | undefined,
  availableModelIds: Set<string>,
): ImageGenerationPreference | undefined {
  if (preference?.mode !== "manual" || preference.models.length === 0) {
    return undefined;
  }

  const models = preference.models.filter((model) =>
    availableModelIds.has(model),
  );
  return models.length > 0 ? { mode: "manual", models } : undefined;
}

function getGenerationJobErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatSidebar({
  canvasId,
  projectId,
  open,
  onToggle,
  onImageGenerated,
  onCanvasSync,
  onStreamEvent,
  initialPrompt,
  initialRequestId,
  initialSessionId,
  onSessionChange,
  onRequestCanvasImages,
  ws,
  selectedCanvasElements,
}: ChatSidebarProps) {
  const { i18n, t } = useAppTranslation("chat");
  const breakpoint = useBreakpoint();
  const isOverlay = breakpoint !== "desktop";

  // ── Session & message management (extracted hook with LRU cache) ──
  const {
    sessions,
    activeSessionId,
    activeSessionIdRef,
    messages,
    messagesRef,
    setMessages,
    sessionsLoading,
    messagesLoading,
    streaming,
    setStreaming,
    updateSessionMessages,
    handleSelectSession,
    handleNewChat,
    handleDeleteSession,
    autoTitleSession,
    reloadMessages,
  } = useChatSessions({
    canvasId,
    initialSessionId,
    onSessionChange,
  });

  // ── Stream event handler (extracted hook, shared between send & reconnect) ──
  const { applyStreamEvent, completeToolBlockWithArtifacts, failToolBlock } =
    useChatStream(updateSessionMessages);

  // ── Attachment state ──
  const chatInputRef = useRef<import("./chat-input").ChatInputHandle>(null);
  const [availableImageModelIds, setAvailableImageModelIds] = useState<
    Set<string>
  >(new Set());

  const initialPromptSent = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const inFlightSessionIdsRef = useRef<Set<string>>(new Set());
  const activeRunIdsRef = useRef<Map<string, string>>(new Map());
  const lastCompletedRunIdsRef = useRef<Map<string, string>>(new Map());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);
  const selectedCanvasElementsRef = useRef(selectedCanvasElements);
  selectedCanvasElementsRef.current = selectedCanvasElements;
  const prevConnectedRef = useRef(false);
  const replayedArtifactKeysRef = useRef<Set<string>>(new Set());
  const chatMediaJobSubscriptionsRef = useRef<
    Map<string, GenerationJobSubscription>
  >(new Map());
  const currentCanvasIdRef = useRef(canvasId);
  currentCanvasIdRef.current = canvasId;

  useEffect(() => {
    return () => {
      for (const subscription of chatMediaJobSubscriptionsRef.current.values()) {
        subscription.unsubscribe();
      }
      chatMediaJobSubscriptionsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setStreaming(
      Boolean(
        activeSessionId && inFlightSessionIdsRef.current.has(activeSessionId),
      ),
    );
    setActiveRunId(
      activeSessionId
        ? (activeRunIdsRef.current.get(activeSessionId) ?? null)
        : null,
    );
    setCancelingRunId(null);
  }, [activeSessionId, setStreaming]);

  const buildAutoTitleSource = useCallback(
    (text: string, attachments: ReadyAttachment[]) => {
      const normalized = text.trim();
      if (normalized) return normalized;

      return attachments
        .map((attachment) => attachment.name?.trim())
        .filter((name): name is string => Boolean(name))
        .join(", ");
    },
    [],
  );

  const artifactReplayKey = useCallback(
    (toolCallId: string, url: string) => `${toolCallId}:${url}`,
    [],
  );

  const hasBackendInsertedElement = useCallback((block: ContentBlock) => {
    if (block.type !== "tool" || !block.output) return false;
    return (
      typeof (block.output as Record<string, unknown>).elementId === "string"
    );
  }, []);

  const canvasArtifactUrls = useCallback(() => {
    return new Set(
      (onRequestCanvasImages ? onRequestCanvasImages() : [])
        .flatMap((item) => [item.url, runtimeCanvasImageUrl(item)])
        .filter(
          (url): url is string => typeof url === "string" && url.length > 0,
        ),
    );
  }, [onRequestCanvasImages]);

  const recoverMediaArtifactsFromBlocks = useCallback(
    (contentBlocks: ContentBlock[]) => {
      const canvasUrls = canvasArtifactUrls();

      for (const block of contentBlocks) {
        if (
          block.type !== "tool" ||
          block.status !== "completed" ||
          block.toolName === "screenshot_canvas" ||
          !block.artifacts
        ) {
          continue;
        }

        for (const artifact of block.artifacts) {
          const artifactUrl = runtimeArtifactUrl(artifact);
          const replayKey = artifactReplayKey(block.toolCallId, artifactUrl);
          if (replayedArtifactKeysRef.current.has(replayKey)) continue;
          if (hasBackendInsertedElement(block)) {
            replayedArtifactKeysRef.current.add(replayKey);
            onCanvasSync?.();
            continue;
          }
          if (canvasUrls.has(artifactUrl)) {
            replayedArtifactKeysRef.current.add(replayKey);
            continue;
          }
          replayedArtifactKeysRef.current.add(replayKey);
          onImageGenerated?.(artifact);
        }
      }
    },
    [
      artifactReplayKey,
      canvasArtifactUrls,
      hasBackendInsertedElement,
      onImageGenerated,
      onCanvasSync,
    ],
  );

  const watchDeferredMediaJobByToolCall = useCallback(
    (job: DeferredMediaJob, sessionId: string, toolCallId: string) => {
      const subscriptionKey = `${sessionId}:${toolCallId}:${job.jobId}`;
      if (chatMediaJobSubscriptionsRef.current.has(subscriptionKey)) return;

      const subscription = generationJobService.watch(job.jobId, {
        jobType: job.jobType,
        onSucceeded: (result) => {
          const artifact = buildGeneratedMediaArtifact(job, result);
          if (!artifact) return;
          const url =
            typeof result.signed_url === "string"
              ? result.signed_url
              : undefined;
          completeToolBlockWithArtifacts(sessionId, toolCallId, [artifact], {
            ...(url ? { url } : {}),
            ...(artifact.type === "video" && url ? { videoUrl: url } : {}),
            ...(artifact.assetId ? { assetId: artifact.assetId } : {}),
            mimeType: artifact.mimeType,
            width: artifact.width,
            height: artifact.height,
          });
        },
        onFailed: (error) => {
          failToolBlock(
            sessionId,
            toolCallId,
            getGenerationJobErrorMessage(error),
          );
        },
      });

      chatMediaJobSubscriptionsRef.current.set(subscriptionKey, subscription);
      void subscription.promise
        .catch(() => {
          // Failure is rendered through onFailed on the corresponding tool block.
        })
        .finally(() => {
          chatMediaJobSubscriptionsRef.current.delete(subscriptionKey);
        });
    },
    [completeToolBlockWithArtifacts, failToolBlock],
  );

  const watchDeferredMediaJob = useCallback(
    (event: StreamEvent, sessionId: string) => {
      const job = extractDeferredMediaJob(event);
      if (!job || event.type !== "tool.completed") return;
      watchDeferredMediaJobByToolCall(job, sessionId, event.toolCallId);
    },
    [watchDeferredMediaJobByToolCall],
  );

  const watchDeferredMediaJobsFromBlocks = useCallback(
    (contentBlocks: ContentBlock[], sessionId: string) => {
      for (const block of contentBlocks) {
        if (block.type !== "tool" || block.status !== "completed") continue;
        const job = extractDeferredMediaJobFromOutput(
          block.output as Record<string, unknown> | undefined,
        );
        if (!job) continue;
        watchDeferredMediaJobByToolCall(job, sessionId, block.toolCallId);
      }
    },
    [watchDeferredMediaJobByToolCall],
  );

  const recoverPersistedMediaArtifacts = useCallback(
    (
      sessionMessages: Array<{
        contentBlocks: ContentBlock[];
        role: "user" | "assistant";
      }>,
      sessionId: string,
    ) => {
      const latestAssistantMessage = [...sessionMessages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (latestAssistantMessage) {
        recoverMediaArtifactsFromBlocks(latestAssistantMessage.contentBlocks);
      }
      for (const message of sessionMessages) {
        if (message.role !== "assistant") continue;
        watchDeferredMediaJobsFromBlocks(message.contentBlocks, sessionId);
      }
    },
    [recoverMediaArtifactsFromBlocks, watchDeferredMediaJobsFromBlocks],
  );

  const {
    attachments: imageAttachments,
    addFiles,
    retryUpload,
    removeAttachment,
    clearAll: clearAttachments,
    isUploading,
    readyAttachments,
  } = useImageAttachments(projectId);

  const { activeImageGenerationPreference } = useImageModelPreference();
  const activeImageGenerationPreferenceRef = useRef(
    activeImageGenerationPreference,
  );
  activeImageGenerationPreferenceRef.current = activeImageGenerationPreference;
  const { activeVideoGenerationPreference } = useVideoModelPreference();
  const activeVideoGenerationPreferenceRef = useRef(
    activeVideoGenerationPreference,
  );
  activeVideoGenerationPreferenceRef.current = activeVideoGenerationPreference;

  const {
    agentTargetId,
    model: agentModel,
    modelSource: agentModelSource,
    ensureAgentModelConfigured,
  } = useAgentModelRequirement();
  const agentModelRef = useRef(agentModel);
  agentModelRef.current = agentModel;
  const agentTargetIdRef = useRef(agentTargetId);
  agentTargetIdRef.current = agentTargetId;
  const agentModelSourceRef = useRef(agentModelSource);
  agentModelSourceRef.current = agentModelSource;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTab>("agent");
  const mediaSettingsOpenedFromCapabilityRef = useRef(false);
  const panelRootRef = useRef<HTMLDivElement | null>(null);

  const { toast: showToast } = useToast();

  const openSettings = useCallback((tab: SettingsTab = "agent") => {
    if (tab !== "media") {
      mediaSettingsOpenedFromCapabilityRef.current = false;
    }
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  const openMediaSettings = useCallback(() => {
    mediaSettingsOpenedFromCapabilityRef.current = true;
    openSettings("media");
  }, [openSettings]);

  const handleSettingsSaved = useCallback(() => {
    if (!mediaSettingsOpenedFromCapabilityRef.current) return;
    mediaSettingsOpenedFromCapabilityRef.current = false;
    setSettingsOpen(false);
    chatInputRef.current?.setDraft(t("capabilityRequired.continueDraft"));
    chatInputRef.current?.focus();
    showToast(t("capabilityRequired.continueAfterSave"), "success");
  }, [showToast, t]);

  // ── Sidebar resize ──
  const SIDEBAR_MIN = 300;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_KEYBOARD_STEP = 20;
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isResizing = useRef(false);

  const clampWidth = useCallback(
    (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
    [],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = startX - moveEvent.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth, clampWidth],
  );

  // Touch support for resize handle (mobile / tablet)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      isResizing.current = true;
      const startX = touch.clientX;
      const startWidth = sidebarWidth;

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (!isResizing.current) return;
        const t = moveEvent.touches[0];
        if (!t) return;
        moveEvent.preventDefault(); // prevent scroll during resize
        const delta = startX - t.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleTouchEnd = () => {
        isResizing.current = false;
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.removeEventListener("touchcancel", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
      document.addEventListener("touchcancel", handleTouchEnd);
    },
    [sidebarWidth, clampWidth],
  );

  // Keyboard support for resize handle (ArrowLeft/ArrowRight)
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev + SIDEBAR_KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev - SIDEBAR_KEYBOARD_STEP));
      }
    },
    [clampWidth],
  );

  useEffect(() => {
    if (!open) return;

    const isNodeInsidePanel = (node: Node | null) =>
      node !== null &&
      panelRootRef.current !== null &&
      panelRootRef.current.contains(node);

    const hasSelectionInsidePanel = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return false;
      return (
        isNodeInsidePanel(selection.anchorNode) ||
        isNodeInsidePanel(selection.focusNode)
      );
    };

    const isInsidePanel = (target: EventTarget | null) =>
      (target instanceof Node && isNodeInsidePanel(target)) ||
      hasSelectionInsidePanel();

    const isolateEvent = (event: Event) => {
      if (!isInsidePanel(event.target)) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const isolateKeyEvent = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ["a", "c", "v", "x"].includes(key)
      ) {
        isolateEvent(event);
      }
    };

    window.addEventListener("keydown", isolateKeyEvent, true);
    window.addEventListener("copy", isolateEvent, true);
    window.addEventListener("cut", isolateEvent, true);
    return () => {
      window.removeEventListener("keydown", isolateKeyEvent, true);
      window.removeEventListener("copy", isolateEvent, true);
      window.removeEventListener("cut", isolateEvent, true);
    };
  }, [open]);

  // ── Auto-scroll to bottom ──
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    void messages.length;
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    let cancelled = false;

    fetchImageModels()
      .then((data) => {
        if (cancelled) return;
        setAvailableImageModelIds(
          new Set(data.models.map((model) => model.id)),
        );
      })
      .catch(() => {
        if (!cancelled) setAvailableImageModelIds(new Set());
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Send message ──
  const handleSend = useCallback(
    (
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imageGenerationPreferenceOverride?: ImageGenerationPreference,
      videoGenerationPreferenceOverride?: VideoGenerationPreference,
      clientRequestIdOverride?: string,
    ) => {
      const currentSessionId = activeSessionIdRef.current;
      if (
        !currentSessionId ||
        inFlightSessionIdsRef.current.has(currentSessionId)
      ) {
        return false;
      }
      if (!ws.connected) {
        return false;
      }

      void (async () => {
        inFlightSessionIdsRef.current.add(currentSessionId);
        if (activeSessionIdRef.current === currentSessionId) {
          setStreaming(true);
        }

        let agentModelConfigured = false;
        try {
          agentModelConfigured = await ensureAgentModelConfigured();
        } catch (error) {
          console.warn("[chat] Failed to validate the selected agent model", {
            error: summarizeClientError(error),
          });
        }

        if (!agentModelConfigured) {
          inFlightSessionIdsRef.current.delete(currentSessionId);
          if (activeSessionIdRef.current === currentSessionId) {
            setStreaming(false);
            chatInputRef.current?.restoreDraftIfEmpty(text);
          }
          openSettings("agent");
          return;
        }

        // Merge explicitly-attached images with auto-sensed canvas selection images
        let currentAttachments = attachmentsOverride ?? readyAttachments;
        const selectedEls = selectedCanvasElementsRef.current ?? [];
        const selectedImageEls = selectedEls.filter(
          (el) =>
            el.type === "image" && el.fileId && (el.storageUrl || el.dataUrl),
        );
        if (selectedImageEls.length > 0 && !attachmentsOverride) {
          const existingIds = new Set(currentAttachments.map((a) => a.assetId));
          const selectionAttachments: ReadyAttachment[] = selectedImageEls
            .filter((el) => !existingIds.has(el.id))
            .flatMap((el) => {
              const url = resolveSelectedCanvasImageUrl(el);
              if (!url) return [];
              return [
                {
                  assetId: el.id,
                  url,
                  mimeType: "image/png",
                  source: "canvas-ref" as const,
                  name: `Canvas selection ${el.id.slice(0, 6)}`,
                },
              ];
            });
          if (selectionAttachments.length > 0) {
            currentAttachments = [
              ...currentAttachments,
              ...selectionAttachments,
            ];
          }
        }
        // The initial preference is an explicit snapshot handed off by the
        // home page. Preserve it even when this newly-mounted canvas has not
        // finished loading its model catalog yet. The server validates the
        // preference against its current provider registry before adding it
        // to the agent prompt.
        const currentImageGenerationPreference =
          imageGenerationPreferenceOverride ??
          filterImageGenerationPreference(
            activeImageGenerationPreferenceRef.current,
            availableImageModelIds,
          );
        const currentVideoGenerationPreference =
          videoGenerationPreferenceOverride ??
          activeVideoGenerationPreferenceRef.current;
        const agentPromptText = text;

        // Add user message locally
        const imageBlocks: ContentBlock[] = currentAttachments.map((a) => ({
          type: "image" as const,
          assetId: a.assetId,
          url: a.url,
          mimeType: a.mimeType,
          source: a.source,
          ...(a.name ? { name: a.name } : {}),
        }));
        const userMsg = {
          id: `user-${Date.now()}`,
          role: "user" as const,
          contentBlocks: [{ type: "text" as const, text }, ...imageBlocks],
        };
        updateSessionMessages(currentSessionId, (prev) => [...prev, userMsg]);

        const userMessagePayload = {
          ...(clientRequestIdOverride
            ? { clientRequestId: clientRequestIdOverride }
            : {}),
          role: "user" as const,
          content: text,
          contentBlocks: [{ type: "text" as const, text }, ...imageBlocks],
        };
        const userMessageSave = saveMessage(
          currentSessionId,
          userMessagePayload,
        );
        const sendDiagnostics = {
          attachmentCount: currentAttachments.length,
          attachments: summarizeReadyAttachments(currentAttachments),
          canvasId,
          messageBodyBytes: byteLength(JSON.stringify(userMessagePayload)),
          promptChars: text.length,
          selectedCanvasImageCount: selectedImageEls.length,
          sessionId: currentSessionId,
        };

        // Auto-title from first user message, falling back to attachment names
        // for image-only initial runs from the home prompt.
        autoTitleSession(buildAutoTitleSource(text, currentAttachments));

        // Create assistant placeholder
        const assistantIdRef = { current: `assistant-${Date.now()}` };
        updateSessionMessages(currentSessionId, (prev) => [
          ...prev,
          {
            id: assistantIdRef.current,
            role: "assistant" as const,
            contentBlocks: [],
          },
        ]);
        if (activeSessionIdRef.current === currentSessionId) {
          setStreaming(true);
        }
        abortRef.current = false;

        let failureStage: SendFailureStage = "save_message";
        let cleanupStreamListener: (() => void) | undefined;
        const cleanupRegisteredStreamListener = () => {
          cleanupStreamListener?.();
          cleanupStreamListener = undefined;
        };
        try {
          await userMessageSave;
          failureStage = "agent_run_ack";

          const perf = {
            t0Send: performance.now(),
            tAck: 0,
            tFirstToken: 0,
            gotFirstToken: false,
          };

          let resolveStream: () => void;
          const streamDone = new Promise<void>((r) => {
            resolveStream = r;
          });
          const runIdRef = { current: "" };
          const runCanvasId = canvasId;

          cleanupStreamListener = ws.onEvent((entry) => {
            const event = entry.event;
            if (!runIdRef.current || event.runId !== runIdRef.current) return;
            if (event.type === "run.completed") {
              // The server validates runtime/target identity and downgrades an
              // incompatible native resume to a history handoff. Keeping this
              // cursor per chat session lets compatible local providers reuse
              // their native session without coupling the UI to provider IDs.
              lastCompletedRunIdsRef.current.set(currentSessionId, event.runId);
            } else if (
              event.type === "run.failed" ||
              event.type === "run.canceled"
            ) {
              // The cached cursor belongs to the previous successful run, not
              // to the current failed run. Drop it so a stale provider session
              // cannot be retried indefinitely on the next send.
              lastCompletedRunIdsRef.current.delete(currentSessionId);
            }
            if (abortRef.current) {
              resolveStream();
              return;
            }
            const isCurrentCanvas = currentCanvasIdRef.current === runCanvasId;
            if (!isCurrentCanvas) {
              if (
                event.type === "run.completed" ||
                event.type === "run.failed" ||
                event.type === "run.canceled"
              ) {
                resolveStream();
              }
              return;
            }

            // Track first token timing
            if (!perf.gotFirstToken && event.type === "message.delta") {
              perf.tFirstToken = performance.now();
              perf.gotFirstToken = true;
              console.log(
                `[perf] send → first token: ${(perf.tFirstToken - perf.t0Send).toFixed(0)}ms` +
                  ` (ack→token: ${(perf.tFirstToken - perf.tAck).toFixed(0)}ms)`,
              );
            }

            // Apply event to messages (single source of truth — shared with reconnect)
            applyStreamEvent(event, assistantIdRef.current, currentSessionId);
            watchDeferredMediaJob(event, currentSessionId);

            // Forward event to parent for fallback job polling.
            onStreamEvent?.(event);

            // Fire canvas insertion callbacks for image/video artifacts.
            // Backend-inserted artifacts should already arrive through canvas.sync.
            // Verify after sync has had a chance to land; if the canvas still does
            // not contain the artifact, fall back to client-side insertion.
            const backendInserted =
              event.type === "tool.completed" &&
              event.output &&
              typeof (event.output as Record<string, unknown>).elementId ===
                "string";
            if (
              event.type === "tool.completed" &&
              event.artifacts &&
              event.toolName !== "screenshot_canvas"
            ) {
              for (const artifact of event.artifacts) {
                if (backendInserted) {
                  onCanvasSync?.();
                } else if (onImageGenerated) {
                  onImageGenerated?.(artifact);
                }
              }
            }

            if (event.type === "canvas.sync" && onCanvasSync) {
              onCanvasSync();
            }

            // Preview model hint: suggest switching when run fails
            if (event.type === "run.failed") {
              const currentModel = agentModelRef.current ?? "";
              if (currentModel.includes("preview")) {
                showToast(t("previewModelUnstable"), "error");
              }
            }

            if (
              event.type === "run.completed" ||
              event.type === "run.failed" ||
              event.type === "run.canceled"
            ) {
              resolveStream();
            }
          });

          // Start run via WebSocket
          const legacyRuntimeProvider =
            agentModelRef.current &&
            agentModelSourceRef.current === "local-agent" &&
            !agentTargetIdRef.current
              ? agentModelRef.current.split(":")[0]?.trim()
              : undefined;
          const previousRunId =
            lastCompletedRunIdsRef.current.get(currentSessionId);
          const runPayload = {
            clientRequestId: clientRequestIdOverride ?? crypto.randomUUID(),
            sessionId: currentSessionId,
            conversationId: canvasId,
            prompt: agentPromptText,
            locale:
              i18n.resolvedLanguage === "en"
                ? ("en" as const)
                : ("zh-CN" as const),
            canvasId,
            ...(previousRunId
              ? {
                  resumeFromRunId: previousRunId,
                  resumeMode: "auto" as const,
                }
              : {}),
            ...(currentAttachments.length > 0
              ? { attachments: currentAttachments }
              : {}),
            ...(currentImageGenerationPreference
              ? {
                  imageGenerationPreference: currentImageGenerationPreference,
                }
              : {}),
            ...(currentVideoGenerationPreference
              ? {
                  videoGenerationPreference: currentVideoGenerationPreference,
                }
              : {}),
            ...(agentModelRef.current ? { model: agentModelRef.current } : {}),
            ...(agentTargetIdRef.current
              ? { agentTargetId: agentTargetIdRef.current }
              : {}),
            ...(agentModelRef.current && agentModelSourceRef.current
              ? { modelSource: agentModelSourceRef.current }
              : {}),
            ...(legacyRuntimeProvider
              ? {
                  runtimeKind: "local-agent" as const,
                  runtimeProvider: legacyRuntimeProvider,
                }
              : {}),
          };

          const runId = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              cleanupRegisteredStreamListener();
              reject(
                new Error("WebSocket ack timeout — connection may be down"),
              );
            }, 10_000);

            ws.startRun(runPayload, (ack) => {
              clearTimeout(timeout);
              perf.tAck = performance.now();
              console.log(
                `[perf] send → ack: ${(perf.tAck - perf.t0Send).toFixed(0)}ms`,
              );
              const payloadRecord = ack.payload as Record<string, unknown>;
              const id = payloadRecord.runId as string;
              const reused = payloadRecord.reused === true;
              const assistantMessageId =
                typeof payloadRecord.assistantMessageId === "string"
                  ? payloadRecord.assistantMessageId
                  : null;
              if (
                assistantMessageId &&
                assistantMessageId !== assistantIdRef.current
              ) {
                const previousAssistantId = assistantIdRef.current;
                assistantIdRef.current = assistantMessageId;
                updateSessionMessages(currentSessionId, (prev) =>
                  prev.map((message) =>
                    message.id === previousAssistantId
                      ? { ...message, id: assistantMessageId }
                      : message,
                  ),
                );
              }
              runIdRef.current = id;
              activeRunIdsRef.current.set(currentSessionId, id);
              if (activeSessionIdRef.current === currentSessionId) {
                setActiveRunId(id);
              }
              reportUserActive();
              if (reused) {
                void reloadMessages(currentSessionId).finally(resolveStream);
              }
              resolve(id);
            });
          });
          clearAttachments();

          failureStage = "stream";
          await streamDone;
          cleanupRegisteredStreamListener();
        } catch (error) {
          console.warn("[chat] Failed to send agent message", {
            ...sendDiagnostics,
            error: summarizeClientError(error),
            stage: failureStage,
          });
          updateSessionMessages(currentSessionId, (prev) =>
            prev.map((m) => {
              if (m.id !== assistantIdRef.current) return m;
              const hasText = m.contentBlocks.some((b) => b.type === "text");
              if (hasText) return m;
              return {
                ...m,
                contentBlocks: [
                  ...m.contentBlocks,
                  { type: "text" as const, text: "Failed to get response." },
                ],
              };
            }),
          );
        } finally {
          cleanupRegisteredStreamListener();
          inFlightSessionIdsRef.current.delete(currentSessionId);
          const runningId = activeRunIdsRef.current.get(currentSessionId);
          activeRunIdsRef.current.delete(currentSessionId);
          if (activeSessionIdRef.current === currentSessionId) {
            setStreaming(false);
            setActiveRunId(null);
          }
          if (runningId) {
            setCancelingRunId((current) =>
              current === runningId ? null : current,
            );
          }
        }
      })();
      return true;
    },
    [
      canvasId,
      applyStreamEvent,
      watchDeferredMediaJob,
      updateSessionMessages,
      onImageGenerated,
      onCanvasSync,
      onStreamEvent,
      readyAttachments,
      clearAttachments,
      ws,
      autoTitleSession,
      buildAutoTitleSource,
      activeSessionIdRef,
      ensureAgentModelConfigured,
      i18n.resolvedLanguage,
      openSettings,
      availableImageModelIds,
      setStreaming,
      showToast,
      t,
      reloadMessages,
    ],
  );

  const handleCancelRun = useCallback(() => {
    if (!activeRunId || cancelingRunId === activeRunId) return;
    setCancelingRunId(activeRunId);
    ws.cancelRun(activeRunId);
  }, [activeRunId, cancelingRunId, ws]);

  // ── Auto-send initial prompt ──
  useEffect(() => {
    if (sessionsLoading || !ws.connected || initialPromptSent.current) return;

    let storedAttachments: ReadyAttachment[] | undefined;
    let storedImageGenerationPreference: ImageGenerationPreference | undefined;
    let storedVideoGenerationPreference: VideoGenerationPreference | undefined;
    let storedAgentModel: string | undefined;
    let storedAgentModelSource: AgentModelSource | undefined;
    try {
      const raw = sessionStorage.getItem(INITIAL_ATTACHMENTS_KEY);
      if (raw) {
        storedAttachments = JSON.parse(raw) as ReadyAttachment[];
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      const preferenceRaw = sessionStorage.getItem(
        INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
      );
      if (preferenceRaw) {
        storedImageGenerationPreference = JSON.parse(
          preferenceRaw,
        ) as ImageGenerationPreference;
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      const videoPreferenceRaw = sessionStorage.getItem(
        INITIAL_VIDEO_GENERATION_PREFERENCE_KEY,
      );
      if (videoPreferenceRaw) {
        storedVideoGenerationPreference = JSON.parse(
          videoPreferenceRaw,
        ) as VideoGenerationPreference;
        sessionStorage.removeItem(INITIAL_VIDEO_GENERATION_PREFERENCE_KEY);
      }

      const modelRaw = sessionStorage.getItem(INITIAL_AGENT_MODEL_KEY);
      if (modelRaw) {
        storedAgentModel = modelRaw;
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }
      const modelSourceRaw = sessionStorage.getItem(
        INITIAL_AGENT_MODEL_SOURCE_KEY,
      );
      if (modelSourceRaw === "local-agent") {
        storedAgentModelSource = modelSourceRaw;
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_SOURCE_KEY);
      }
    } catch {
      // Malformed JSON or unavailable storage
    }

    const shouldSendInitial =
      Boolean(initialRequestId) &&
      (Boolean(initialPrompt) || Boolean(storedAttachments?.length));
    if (!shouldSendInitial) return;

    if (storedAgentModel) {
      agentModelRef.current = storedAgentModel;
      agentModelSourceRef.current = storedAgentModelSource ?? null;
    }

    const timer = setTimeout(() => {
      if (!activeSessionIdRef.current) return;
      initialPromptSent.current = true;
      void handleSend(
        initialPrompt ?? "",
        storedAttachments,
        storedImageGenerationPreference,
        storedVideoGenerationPreference,
        initialRequestId,
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [
    initialPrompt,
    initialRequestId,
    sessionsLoading,
    ws.connected,
    handleSend,
    activeSessionIdRef,
  ]);

  // ── Reconnection: resume canvas binding + reload messages ──
  // Uses the shared applyStreamEvent to handle live events — no duplicated logic.
  useEffect(() => {
    if (!ws.connected || sessionsLoading) {
      if (!ws.connected) prevConnectedRef.current = false;
      return;
    }
    if (prevConnectedRef.current) return;
    prevConnectedRef.current = true;

    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    // Skip if initialPrompt effect will handle binding
    if (initialPrompt && !initialPromptSent.current) return;

    let canceled = false;
    let resumeUnsub: (() => void) | null = null;

    void (async () => {
      // Reload messages from DB (server may have persisted while disconnected)
      const reloadedMessages = await reloadMessages(sessionId);
      if (canceled) return;
      recoverPersistedMediaArtifacts(reloadedMessages, sessionId);
      const latestReloadedAssistantId =
        [...reloadedMessages]
          .reverse()
          .find((message) => message.role === "assistant")?.id ?? null;

      let resumedRunId: string | null = null;
      let resumedAssistantId: string | null = null;
      let hydratingActiveRun = false;
      const hydratedRunEventIds = new Set<string>();
      const queuedResumeEvents: Array<{
        event: StreamEvent;
        eventId?: string;
        replayed?: boolean;
        seq?: number;
      }> = [];

      const processResumedEntry = (
        entry: {
          event: StreamEvent;
          eventId?: string;
          replayed?: boolean;
          seq?: number;
        },
        assistantId: string,
      ) => {
        const evt = entry.event;
        applyStreamEvent(evt, assistantId, sessionId);
        watchDeferredMediaJob(evt, sessionId);
        if (!entry.replayed) {
          onStreamEvent?.(evt);
        }

        const backendInserted =
          evt.type === "tool.completed" &&
          evt.output &&
          typeof (evt.output as Record<string, unknown>).elementId === "string";
        if (
          evt.type === "tool.completed" &&
          evt.artifacts &&
          evt.toolName !== "screenshot_canvas"
        ) {
          for (const artifact of evt.artifacts) {
            const replayKey = artifactReplayKey(
              evt.toolCallId,
              runtimeArtifactUrl(artifact),
            );
            if (replayedArtifactKeysRef.current.has(replayKey)) continue;
            replayedArtifactKeysRef.current.add(replayKey);
            if (backendInserted) {
              onCanvasSync?.();
            } else {
              onImageGenerated?.(artifact);
            }
          }
        }

        if (
          evt.type === "run.completed" ||
          evt.type === "run.failed" ||
          evt.type === "run.canceled"
        ) {
          inFlightSessionIdsRef.current.delete(sessionId);
          activeRunIdsRef.current.delete(sessionId);
          if (activeSessionIdRef.current === sessionId) {
            setStreaming(false);
            setActiveRunId(null);
          }
          setCancelingRunId((current) =>
            current === evt.runId ? null : current,
          );
        }
      };

      resumeUnsub = ws.onEvent((entry) => {
        const evt = entry.event;

        if (evt.type === "canvas.sync") {
          onCanvasSync?.();
        }

        if (
          !resumedRunId ||
          evt.runId !== resumedRunId ||
          !resumedAssistantId
        ) {
          return;
        }

        if (hydratingActiveRun) {
          queuedResumeEvents.push(entry);
          return;
        }

        if (entry.eventId && hydratedRunEventIds.has(entry.eventId)) {
          return;
        }

        processResumedEntry(entry, resumedAssistantId);
      });

      // Resume canvas binding (after DB messages are set)
      ws.resumeCanvas(canvasId, sessionId, (ack) => {
        const activeRunId = (ack.payload as Record<string, unknown>)
          .activeRunId;
        const assistantMessageId = (ack.payload as Record<string, unknown>)
          .assistantMessageId;
        if (activeRunId && typeof activeRunId === "string") {
          inFlightSessionIdsRef.current.add(sessionId);
          activeRunIdsRef.current.set(sessionId, activeRunId);
          if (activeSessionIdRef.current === sessionId) {
            setStreaming(true);
            setActiveRunId(activeRunId);
          }

          resumedRunId = activeRunId;
          resumedAssistantId =
            typeof assistantMessageId === "string" &&
            assistantMessageId.length > 0
              ? assistantMessageId
              : latestReloadedAssistantId;
          const assistantId = resumedAssistantId ?? `resumed_${activeRunId}`;
          resumedAssistantId = assistantId;

          hydratingActiveRun = true;
          queuedResumeEvents.length = 0;

          // Must use updateSessionMessages (not setMessages) so the placeholder
          // lands in msgCacheRef as well as React state. applyStreamEvent reads
          // from the cache — if the placeholder only lives in React state, stream
          // events can't find it and the first updateSessionMessages call
          // overwrites state back to the stale cache (losing the placeholder).
          updateSessionMessages(sessionId, (prev) => {
            if (prev.some((m) => m.id === assistantId)) return prev;
            return [
              ...prev,
              {
                id: assistantId,
                role: "assistant" as const,
                contentBlocks: [],
              },
            ];
          });

          void (async () => {
            try {
              let cursor = 0;
              const entries: Awaited<
                ReturnType<typeof fetchRunEvents>
              >["events"] = [];
              while (true) {
                const response = await fetchRunEvents(activeRunId, cursor);
                entries.push(...response.events);
                if (response.done || response.nextCursor <= cursor) break;
                cursor = response.nextCursor;
              }
              if (canceled || resumedRunId !== activeRunId) return;

              hydratedRunEventIds.clear();
              for (const entry of entries) {
                if (entry.eventId) {
                  hydratedRunEventIds.add(entry.eventId);
                }
              }
              const hydratedBlocks = materializeAssistantBlocksFromEvents(
                entries.map((item) => item.event),
              );
              updateSessionMessages(sessionId, (prev) =>
                prev.map((message) =>
                  message.id === assistantId
                    ? { ...message, contentBlocks: hydratedBlocks }
                    : message,
                ),
              );
              recoverMediaArtifactsFromBlocks(hydratedBlocks);
              for (const entry of entries) {
                watchDeferredMediaJob(entry.event, sessionId);
              }
            } catch (error) {
              console.warn(
                "[chat] Failed to hydrate active run from durable events:",
                error,
              );
            } finally {
              hydratingActiveRun = false;
              const pending = [...queuedResumeEvents].sort(
                (a, b) =>
                  (a.seq ?? Number.MAX_SAFE_INTEGER) -
                  (b.seq ?? Number.MAX_SAFE_INTEGER),
              );
              queuedResumeEvents.length = 0;
              for (const queuedEntry of pending) {
                if (
                  queuedEntry.eventId &&
                  hydratedRunEventIds.has(queuedEntry.eventId)
                ) {
                  continue;
                }
                processResumedEntry(queuedEntry, assistantId);
              }
            }
          })();
        }
      });
    })();

    return () => {
      canceled = true;
      resumeUnsub?.();
    };
  }, [
    ws.connected,
    ws,
    canvasId,
    sessionsLoading,
    applyStreamEvent,
    watchDeferredMediaJob,
    onStreamEvent,
    onImageGenerated,
    onCanvasSync,
    activeSessionIdRef,
    artifactReplayKey,
    recoverMediaArtifactsFromBlocks,
    recoverPersistedMediaArtifacts,
    reloadMessages,
    updateSessionMessages,
    setStreaming,
    initialPrompt,
  ]);

  // ── Collapsed state ──
  if (!open) {
    return (
      <div className="absolute right-3 top-3 z-20">
        <button
          onClick={onToggle}
          type="button"
          className="group inline-flex items-center gap-1 rounded-xl bg-card/80 backdrop-blur-sm border border-border px-2.5 py-1.5 text-xs text-foreground/60 shadow-sm hover:bg-card hover:text-foreground transition-colors cursor-pointer md:px-2.5 md:py-1.5 min-h-[36px] md:min-h-0"
        >
          <svg
            aria-hidden="true"
            className="size-4 md:size-3.5"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              fill="currentColor"
              fillOpacity={0.9}
              d="M18.25 3c2.071 0 3.946 2.16 3.946 4.23L22 15.75a3.75 3.75 0 0 1-3.75 3.75h-2.874a.25.25 0 0 0-.16.058l-2.098 1.738a1.75 1.75 0 0 1-2.24-.007l-2.065-1.73a.25.25 0 0 0-.162-.059H5.75A3.75 3.75 0 0 1 2 15.75v-9A3.75 3.75 0 0 1 5.75 3zM7.5 10q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 7.5 10m4.5 0q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 12 10m4.5 0q-.053 0-.105.005a1.25 1.25 0 0 0-1.138 1.117l-.007.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 16.5 10"
            />
          </svg>
          {t("conversation")}
        </button>
      </div>
    );
  }

  // Shared event isolation — prevent keyboard/clipboard events from bleeding
  // into Excalidraw canvas when the sidebar has focus.
  const eventIsolationProps = {
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onKeyUp: (e: React.KeyboardEvent) => e.stopPropagation(),
    onCopy: (e: React.ClipboardEvent) => e.stopPropagation(),
    onCut: (e: React.ClipboardEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  // The inner panel content is shared across all breakpoints.
  // Extracted as a variable to avoid duplicating the chat UI tree
  // between overlay (mobile/tablet) and inline (desktop) render paths.
  const panelContent = (
    <>
      {/* Header */}
      <div className="flex min-h-[48px] items-center justify-between pl-4 pr-2">
        <div className="flex items-center gap-1 min-w-0">
          <h2 className="sr-only">{t("assistant.title")}</h2>
          {!sessionsLoading && (
            <SessionSelector
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelectSession}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
            />
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => openSettings("agent")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("actions.openSettings")}
            title={t("actions.openSettings")}
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            title={t("actions.collapsePanel")}
            aria-label={t("actions.collapsePanel")}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <path
                d="M4 3.25a.75.75 0 0 1 .75.75v16a.75.75 0 0 1-1.5 0V4A.75.75 0 0 1 4 3.25m9.47 2.22a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06l4.72-4.72H8a.75.75 0 0 1 0-1.5h10.19l-4.72-4.72a.75.75 0 0 1 0-1.06"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Disconnected banner */}
      {!ws.connected && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted border-b border-border">
          <div className="h-2 w-2 rounded-full bg-red-500 animate-[pulse_1.2s_ease-in-out_infinite]" />
          <span className="text-[11px] text-muted-foreground">
            {t("connectionReconnecting")}
          </span>
        </div>
      )}

      {/* Messages */}
      <ErrorBoundary
        onError={(err) =>
          console.error("[chat-sidebar] message area render crashed:", err)
        }
      >
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-6 px-4 py-4"
          aria-live="polite"
          aria-relevant="additions"
        >
          {sessionsLoading || messagesLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <ChatTemplates
              onSend={(prompt) => handleSend(prompt, [], undefined, undefined)}
            />
          ) : (
            messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                role={msg.role}
                contentBlocks={msg.contentBlocks}
                onOpenMediaSettings={openMediaSettings}
                isStreaming={
                  streaming &&
                  msg.role === "assistant" &&
                  msg === messages[messages.length - 1]
                }
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </ErrorBoundary>

      {/* Input */}
      <div>
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          {...(activeRunId ? { onCancel: handleCancelRun } : {})}
          disabled={sessionsLoading || !ws.connected}
          isRunning={streaming}
          canceling={activeRunId ? cancelingRunId === activeRunId : false}
          attachments={imageAttachments}
          canSendAttachments={readyAttachments.length > 0}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          onRetryAttachment={retryUpload}
          isUploading={isUploading}
          {...(selectedCanvasElements ? { selectedCanvasElements } : {})}
        />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsInitialTab}
        onSaved={handleSettingsSaved}
      />
    </>
  );

  // ── Mobile / Tablet: full-screen overlay with backdrop ──
  if (isOverlay) {
    return (
      <>
        {/* Semi-transparent backdrop — click to close */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop is a non-interactive dismissal layer, keyboard close is handled via Escape */}
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onToggle();
          }}
          onClick={onToggle}
          role="button"
          tabIndex={0}
        />
        {/* Chat panel — full screen on mobile, fixed-width drawer on tablet */}
        <div
          ref={panelRootRef}
          className={
            breakpoint === "mobile"
              ? "fixed inset-0 z-50 flex flex-col bg-card animate-in slide-in-from-right duration-250"
              : "fixed inset-y-0 right-0 z-50 flex w-[400px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-250"
          }
          {...eventIsolationProps}
        >
          {panelContent}
        </div>
      </>
    );
  }

  // ── Desktop: inline side-by-side with resize handle ──
  return (
    <div
      ref={panelRootRef}
      className="relative z-[120] flex h-full shrink-0"
      style={{ width: sidebarWidth }}
      {...eventIsolationProps}
    >
      {/* Resize handle -- supports mouse, touch, and keyboard (ArrowLeft/ArrowRight) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("actions.resizePanel")}
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        className="w-2 shrink-0 cursor-col-resize bg-gradient-to-r from-transparent via-border to-transparent shadow-[1px_0_10px_rgba(15,23,42,0.06)] transition-all hover:via-muted-foreground/40 hover:shadow-[1px_0_14px_rgba(15,23,42,0.1)] active:via-muted-foreground/60 active:shadow-[1px_0_16px_rgba(15,23,42,0.14)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="flex flex-1 flex-col bg-card min-w-0">{panelContent}</div>
    </div>
  );
}
