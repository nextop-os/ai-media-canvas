import { randomUUID } from "node:crypto";

import {
  type StreamEvent,
  type ToolArtifact,
  type WorkspaceSettings,
  imageArtifactSchema,
  videoArtifactSchema,
} from "@aimc/shared";
import type { BackendFactory } from "deepagents";
import { z } from "zod";

import type { UserDataClient } from "../../auth/request.js";
import type { ServerEnv } from "../../config/env.js";
import { insertImageElement } from "../../features/canvas/canvas-element-writer.js";
import { refreshGenerationProviders } from "../../features/settings/settings-service.js";
import {
  type CodexImagegenDelegationSetting,
  evaluateCodexImagegenDelegation,
} from "../../generation/codex-imagegen-delegation.js";
import { resolveImageProviderName } from "../../generation/providers/registry.js";
import { createPipelineLogger } from "../../ws/logger.js";
import { createBrandKitTool } from "../tools/brand-kit.js";
import {
  type SubmitImageJobFn,
  createImageGenerateTool,
} from "../tools/image-generate.js";
import {
  type CanvasLayoutInspectionState,
  createInspectCanvasTool,
} from "../tools/inspect-canvas.js";
import { createManipulateCanvasTool } from "../tools/manipulate-canvas.js";
import { createPersistSandboxFileTool } from "../tools/persist-sandbox-file.js";
import { createProjectSearchTool } from "../tools/project-search.js";
import { createScreenshotCanvasTool } from "../tools/screenshot-canvas.js";
import {
  type SetProjectTitleFn,
  createSetProjectTitleTool,
} from "../tools/set-project-title.js";
import {
  type SubmitVideoJobFn,
  createVideoGenerateTool,
} from "../tools/video-generate.js";
import {
  type ApplyWorkspaceSettingsPatch,
  type ReadWorkspaceSettings,
  buildWorkspaceSettingsSnapshot,
  createGetWorkspaceSettingsTool,
  createUpdateWorkspaceSettingsTool,
} from "../tools/workspace-settings.js";

type StructuredToolLike = {
  description: string;
  invoke: (input: unknown, options?: unknown) => Promise<unknown>;
  name: string;
  schema: z.ZodTypeAny;
};

export type LocalToolManifestItem = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export type LocalToolGatewayCallResult = {
  artifacts?: ToolArtifact[];
  isError: boolean;
  output?: Record<string, unknown>;
  outputSummary?: string;
};

type LocalToolGatewaySession = {
  accessToken?: string;
  attachmentDataMap?: Record<string, string>;
  backendFactory?: BackendFactory;
  brandKitId?: string | null;
  canvasId?: string;
  connectionId?: string;
  runId: string;
  runtimeProvider?: string;
  sessionId?: string;
  runtimeEnv: ServerEnv;
  delegationConsent?: {
    codexImagegen?: "allow-once";
  };
  codexImagegenConsentBudget?: number;
  onWorkspaceSettingsStateChange?: (state: {
    codexImagegenConsentBudget?: number;
    codexImagegenDelegation?: CodexImagegenDelegationSetting;
  }) => void;
  sandboxDir?: string;
  workspaceSettings?: {
    codexImagegenDelegation?: CodexImagegenDelegationSetting;
  };
  layoutInspectionState?: CanvasLayoutInspectionState;
  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  userId?: string;
};

type CreateLocalToolGatewayOptions = {
  createUserClient: (accessToken: string) => unknown;
  readLocalAssetDataUrl?: (assetId: string) => Promise<string | undefined>;
  connectionPublisher?: {
    pushToCanvas: (canvasId: string, event: StreamEvent) => void;
  };
  patchWorkspaceSettings?: (input: {
    patch: Pick<WorkspaceSettings, "codexImagegenDelegation">;
    userId?: string;
  }) => Promise<{ codexImagegenDelegation: CodexImagegenDelegationSetting }>;
  setProjectTitle?: SetProjectTitleFn;
};

const TOOL_NAME_ALIASES = new Map<string, string>([
  ["image_generate", "generate_image"],
  ["video_generate", "generate_video"],
]);

function normalizeToolName(name: string) {
  return TOOL_NAME_ALIASES.get(name) ?? name;
}

function summarizeToolInput(args: Record<string, unknown>) {
  return {
    inputKeys: Object.keys(args).sort(),
    ...(typeof args.model === "string" ? { model: args.model } : {}),
    ...(typeof args.aspectRatio === "string"
      ? { aspectRatio: args.aspectRatio }
      : {}),
    ...(typeof args.title === "string" ? { title: args.title } : {}),
    ...(Array.isArray(args.inputImages)
      ? { inputImageCount: args.inputImages.length }
      : {}),
  };
}

const CODEX_IMAGEGEN_MODEL_ID = "codex/gpt-image-2";

function needsCodexImagegenNotice(session: LocalToolGatewaySession) {
  const setting = session.workspaceSettings?.codexImagegenDelegation ?? "ask";
  return (
    session.runtimeProvider !== undefined &&
    session.runtimeProvider !== "codex" &&
    setting === "ask" &&
    (session.codexImagegenConsentBudget ?? 0) <= 0
  );
}

function parseRequestedImageModel(args: Record<string, unknown>) {
  return typeof args.model === "string" && args.model.length > 0
    ? args.model
    : undefined;
}

function summarizeToolResult(result: LocalToolGatewayCallResult) {
  const output = result.output;
  return {
    isError: result.isError,
    outputKeys: output ? Object.keys(output).sort() : [],
    artifactCount: result.artifacts?.length ?? 0,
    ...(typeof output?.jobId === "string" ? { jobId: output.jobId } : {}),
    ...(typeof output?.status === "string" ? { status: output.status } : {}),
    ...(typeof output?.assetId === "string" ? { assetId: output.assetId } : {}),
    ...(typeof output?.elementId === "string"
      ? { elementId: output.elementId }
      : {}),
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractLocalAssetId(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, "http://localhost");
    const isRelative = value.startsWith("/");
    const isLoopback =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (!isRelative && !isLoopback) return undefined;
    if (!parsed.pathname.startsWith("/local-assets/")) return undefined;
    return (
      parsed.pathname.slice("/local-assets/".length).split("/")[0] || undefined
    );
  } catch {
    return undefined;
  }
}

function toPersistentLocalAssetUrl(
  assetId: string | undefined,
  fallback: string,
) {
  return assetId ? `/local-assets/${assetId}` : fallback;
}

function buildArtifacts(
  toolName: string,
  output: Record<string, unknown>,
): ToolArtifact[] | undefined {
  const imageUrl =
    typeof output.imageUrl === "string" && output.imageUrl.length > 0
      ? output.imageUrl
      : toolName === "persist_sandbox_file" &&
          typeof output.url === "string" &&
          output.url.length > 0
        ? output.url
        : toolName === "screenshot_canvas" &&
            typeof output.screenshotUrl === "string" &&
            output.screenshotUrl.length > 0
          ? output.screenshotUrl
          : undefined;
  if (
    (toolName === "generate_image" ||
      toolName === "screenshot_canvas" ||
      toolName === "persist_sandbox_file") &&
    imageUrl
  ) {
    const assetId =
      typeof output.assetId === "string"
        ? output.assetId
        : extractLocalAssetId(imageUrl);
    const parsed = imageArtifactSchema.safeParse({
      type: "image",
      ...(assetId ? { assetId } : {}),
      url: toPersistentLocalAssetUrl(assetId, imageUrl),
      mimeType:
        typeof output.mimeType === "string" && output.mimeType.length > 0
          ? output.mimeType
          : "image/png",
      width: typeof output.width === "number" ? output.width : 1024,
      height: typeof output.height === "number" ? output.height : 1024,
      ...(typeof output.title === "string" ? { title: output.title } : {}),
      ...(toRecord(output.placement) ? { placement: output.placement } : {}),
    });
    return parsed.success ? [parsed.data] : undefined;
  }

  if (
    toolName === "generate_video" &&
    typeof output.videoUrl === "string" &&
    output.videoUrl.length > 0
  ) {
    const assetId =
      typeof output.assetId === "string"
        ? output.assetId
        : extractLocalAssetId(output.videoUrl);
    const parsed = videoArtifactSchema.safeParse({
      type: "video",
      ...(assetId ? { assetId } : {}),
      url: toPersistentLocalAssetUrl(assetId, output.videoUrl),
      mimeType:
        typeof output.mimeType === "string" && output.mimeType.length > 0
          ? output.mimeType
          : "video/mp4",
      width: typeof output.width === "number" ? output.width : 1280,
      height: typeof output.height === "number" ? output.height : 720,
      ...(typeof output.durationSeconds === "number"
        ? { durationSeconds: output.durationSeconds }
        : {}),
      ...(typeof output.title === "string" ? { title: output.title } : {}),
      ...(toRecord(output.placement) ? { placement: output.placement } : {}),
    });
    return parsed.success ? [parsed.data] : undefined;
  }

  return undefined;
}

function normalizeToolResult(
  toolName: string,
  rawResult: unknown,
): LocalToolGatewayCallResult {
  const parsed = parseMaybeJson(rawResult);
  const parsedRecord = toRecord(parsed);

  if (!parsedRecord) {
    return {
      isError: false,
      ...(typeof parsed === "string" && parsed.length > 0
        ? { outputSummary: parsed }
        : {}),
    };
  }

  const outputSummary =
    typeof parsedRecord.summary === "string"
      ? parsedRecord.summary
      : typeof parsedRecord.message === "string"
        ? parsedRecord.message
        : undefined;
  const errorMessage =
    typeof parsedRecord.error === "string" && parsedRecord.error.length > 0
      ? parsedRecord.error
      : parsedRecord.success === false &&
          typeof parsedRecord.message === "string"
        ? parsedRecord.message
        : undefined;
  const isActionableCapabilityRequired =
    parsedRecord.error === "media_provider_configuration_required" ||
    parsedRecord.errorCode === "media_provider_configuration_required";
  const artifacts = buildArtifacts(toolName, parsedRecord);

  const result: LocalToolGatewayCallResult = {
    isError: Boolean(errorMessage) && !isActionableCapabilityRequired,
    output: parsedRecord,
  };
  const summary = errorMessage ?? outputSummary;
  if (summary) {
    result.outputSummary = summary;
  }
  if (artifacts) {
    result.artifacts = artifacts;
  }
  return result;
}

function placementFromOutput(output: Record<string, unknown>) {
  const placement = toRecord(output.placement);
  if (!placement) return undefined;
  const { x, y, width, height } = placement;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

async function insertDirectGeneratedImage(input: {
  createUserClient: (accessToken: string) => UserDataClient;
  output: Record<string, unknown>;
  session: LocalToolGatewaySession;
  pushToCanvas?: CreateLocalToolGatewayOptions["connectionPublisher"];
}) {
  if (
    typeof input.output.elementId === "string" ||
    typeof input.output.imageUrl !== "string" ||
    !input.output.imageUrl ||
    !input.session.accessToken ||
    !input.session.canvasId
  ) {
    return;
  }

  const width =
    typeof input.output.width === "number" ? input.output.width : 1024;
  const height =
    typeof input.output.height === "number" ? input.output.height : 1024;
  const mimeType =
    typeof input.output.mimeType === "string"
      ? input.output.mimeType
      : "image/png";
  const title =
    typeof input.output.title === "string" ? input.output.title : undefined;
  const imageUrl = input.output.imageUrl;
  const objectPath =
    typeof input.output.objectPath === "string"
      ? input.output.objectPath
      : imageUrl;
  const assetId =
    typeof input.output.assetId === "string"
      ? input.output.assetId
      : extractLocalAssetId(imageUrl);

  const { elementId } = await insertImageElement(
    input.createUserClient(input.session.accessToken),
    {
      canvasId: input.session.canvasId,
      objectPath,
      ...(assetId ? { assetId } : {}),
      signedUrl: imageUrl,
      width,
      height,
      mimeType,
      ...(title ? { title } : {}),
    },
    placementFromOutput(input.output),
  );
  input.output.elementId = elementId;

  input.pushToCanvas?.pushToCanvas(input.session.canvasId, {
    type: "canvas.sync",
    runId: input.session.runId,
    timestamp: new Date().toISOString(),
  });
}

function toolOptionsForSession(
  session: LocalToolGatewaySession,
): Record<string, unknown> {
  return {
    state: {},
    configurable: {
      ...(session.accessToken ? { access_token: session.accessToken } : {}),
      ...(session.attachmentDataMap &&
      Object.keys(session.attachmentDataMap).length > 0
        ? { user_attachment_map: session.attachmentDataMap }
        : {}),
      ...(session.canvasId ? { canvas_id: session.canvasId } : {}),
      ...(session.connectionId ? { connection_id: session.connectionId } : {}),
      ...(session.userId ? { user_id: session.userId } : {}),
    },
  };
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

async function readImageBytes(sourceUrl: string) {
  if (sourceUrl.startsWith("data:")) {
    const match = sourceUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error("Unsupported data URL image format.");
    }
    const mimeType = match[1];
    const base64 = match[2];
    if (!mimeType || !base64) {
      throw new Error("Unsupported data URL image format.");
    }
    return {
      buffer: Buffer.from(base64, "base64"),
      mimeType,
    };
  }

  const response = await fetch(sourceUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Unable to fetch generated image: ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? "image/png",
  };
}

export function createLocalToolGatewayService(
  options: CreateLocalToolGatewayOptions,
) {
  const sessions = new Map<string, LocalToolGatewaySession>();

  const buildTools = (
    session: LocalToolGatewaySession,
  ): Map<string, StructuredToolLike> => {
    refreshGenerationProviders(session.runtimeEnv);

    const createUserClient = options.createUserClient as (
      accessToken: string,
    ) => UserDataClient;
    const getWorkspaceSettings: ReadWorkspaceSettings = async () => {
      const setting =
        session.workspaceSettings?.codexImagegenDelegation ?? "ask";
      const consentBudget = session.codexImagegenConsentBudget ?? 0;
      const callerProvider = session.runtimeProvider;
      return buildWorkspaceSettingsSnapshot({
        ...(callerProvider ? { callerProvider } : {}),
        codexImagegenDelegation: setting,
        consentBudget,
      });
    };
    const applyWorkspaceSettingsPatch: ApplyWorkspaceSettingsPatch = async ({
      patch,
    }) => {
      let summary: string | undefined;

      if (patch.codexImagegenDelegation === "allow-once") {
        session.codexImagegenConsentBudget = Math.max(
          1,
          session.codexImagegenConsentBudget ?? 0,
        );
        session.onWorkspaceSettingsStateChange?.({
          codexImagegenConsentBudget: session.codexImagegenConsentBudget,
        });
      } else if (patch.codexImagegenDelegation === "deny") {
        session.codexImagegenConsentBudget = 0;
        session.onWorkspaceSettingsStateChange?.({
          codexImagegenConsentBudget: session.codexImagegenConsentBudget,
        });
        summary =
          "Codex image generation delegation was denied for the current task. Do not call Codex image generation for this task.";
      } else if (patch.codexImagegenDelegation !== undefined) {
        if (!options.patchWorkspaceSettings) {
          throw new Error(
            "Workspace settings are not available for this tool session.",
          );
        }
        const settings = await options.patchWorkspaceSettings({
          patch: {
            codexImagegenDelegation: patch.codexImagegenDelegation,
          },
          ...(session.userId ? { userId: session.userId } : {}),
        });
        session.workspaceSettings = {
          ...(session.workspaceSettings ?? {}),
          codexImagegenDelegation: settings.codexImagegenDelegation,
        };
        session.onWorkspaceSettingsStateChange?.({
          codexImagegenDelegation: settings.codexImagegenDelegation,
        });
      }

      return buildWorkspaceSettingsSnapshot({
        ...(session.runtimeProvider
          ? { callerProvider: session.runtimeProvider }
          : {}),
        codexImagegenDelegation:
          session.workspaceSettings?.codexImagegenDelegation ?? "ask",
        consentBudget: session.codexImagegenConsentBudget ?? 0,
        ...(summary ? { summary } : {}),
      });
    };
    const layoutInspectionState = session.layoutInspectionState ?? {};
    const sessionAccessToken = session.accessToken;
    const persistSessionImage = sessionAccessToken
      ? async (sourceUrl: string, mimeType?: string) => {
          const image = await readImageBytes(sourceUrl);
          const resolvedMimeType = mimeType || image.mimeType;
          const fileName = `generated-${randomUUID()}.${extensionForMimeType(resolvedMimeType)}`;
          const objectPath = `generated/${session.runId}/${fileName}`;
          const client = createUserClient(sessionAccessToken);
          const bucket = client.storage.from("project-assets");
          const { error } = await bucket.upload(objectPath, image.buffer, {
            contentType: resolvedMimeType,
          });
          if (error) {
            throw new Error(
              error.message ?? "Unable to persist generated image.",
            );
          }
          return bucket.getPublicUrl(objectPath).data.publicUrl;
        }
      : undefined;
    const resolveVideoInputImage = options.readLocalAssetDataUrl
      ? async (input: string) => {
          const assetId = extractLocalAssetId(input);
          return assetId ? options.readLocalAssetDataUrl?.(assetId) : input;
        }
      : undefined;
    const tools: StructuredToolLike[] = [
      createInspectCanvasTool({
        createUserClient,
        layoutInspectionState,
      }) as unknown as StructuredToolLike,
      createManipulateCanvasTool({
        createUserClient,
        layoutInspectionState,
      }) as unknown as StructuredToolLike,
      createImageGenerateTool({
        layoutInspectionState,
        codexImagegenConfirmationRequired: needsCodexImagegenNotice(session),
        ...(resolveVideoInputImage
          ? { resolveInputImage: resolveVideoInputImage }
          : {}),
        ...(persistSessionImage ? { persistImage: persistSessionImage } : {}),
        ...(session.submitImageJob
          ? { submitImageJob: session.submitImageJob }
          : {}),
      }) as unknown as StructuredToolLike,
      createVideoGenerateTool({
        layoutInspectionState,
        ...(resolveVideoInputImage
          ? { resolveInputImage: resolveVideoInputImage }
          : {}),
        ...(session.submitVideoJob
          ? { submitVideoJob: session.submitVideoJob }
          : {}),
      }) as unknown as StructuredToolLike,
      createGetWorkspaceSettingsTool({
        readSettings: getWorkspaceSettings,
      }) as unknown as StructuredToolLike,
      createUpdateWorkspaceSettingsTool({
        applyPatch: applyWorkspaceSettingsPatch,
      }) as unknown as StructuredToolLike,
    ];

    if (options.setProjectTitle) {
      tools.push(
        createSetProjectTitleTool({
          setProjectTitle: options.setProjectTitle,
        }) as unknown as StructuredToolLike,
      );
    }

    if (session.backendFactory) {
      tools.unshift(
        createProjectSearchTool(
          session.backendFactory,
        ) as unknown as StructuredToolLike,
      );
    }

    if (session.accessToken) {
      tools.push(
        createPersistSandboxFileTool({
          createUserClient,
          ...(session.sandboxDir ? { sandboxDir: session.sandboxDir } : {}),
        }) as unknown as StructuredToolLike,
      );
    }

    if (session.brandKitId) {
      tools.push(
        createBrandKitTool(
          { createUserClient },
          session.brandKitId,
        ) as unknown as StructuredToolLike,
      );
    }

    if (options.connectionPublisher) {
      tools.push(
        createScreenshotCanvasTool({
          connectionManager:
            options.connectionPublisher as unknown as Parameters<
              typeof createScreenshotCanvasTool
            >[0]["connectionManager"],
          ...(persistSessionImage ? { persistImage: persistSessionImage } : {}),
        }) as unknown as StructuredToolLike,
      );
    }

    return new Map(
      tools.map((toolInstance) => [toolInstance.name, toolInstance]),
    );
  };

  return {
    createSession(
      input: Omit<LocalToolGatewaySession, "runId"> & { runId: string },
    ) {
      const token = randomUUID();
      sessions.set(token, {
        ...input,
        codexImagegenConsentBudget:
          input.codexImagegenConsentBudget ??
          (input.delegationConsent?.codexImagegen === "allow-once" ? 1 : 0),
        layoutInspectionState: input.layoutInspectionState ?? {},
      });
      return { token };
    },

    getManifest(token: string): LocalToolManifestItem[] {
      const session = sessions.get(token);
      if (!session) {
        throw new Error("Invalid tool session token.");
      }
      const tools = buildTools(session);
      return [...tools.values()].map((toolInstance) => ({
        name: toolInstance.name,
        description: toolInstance.description,
        inputSchema: z.toJSONSchema(toolInstance.schema) as Record<
          string,
          unknown
        >,
      }));
    },

    async callTool(
      token: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<LocalToolGatewayCallResult> {
      const session = sessions.get(token);
      if (!session) {
        throw new Error("Invalid tool session token.");
      }
      const tools = buildTools(session);
      const canonicalName = normalizeToolName(name);
      const log = createPipelineLogger("tool.gateway", {
        runId: session.runId,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session.canvasId ? { canvasId: session.canvasId } : {}),
        requestedToolName: name,
        toolName: canonicalName,
      });
      log.info("call_start", summarizeToolInput(args));
      const toolInstance = tools.get(canonicalName);
      if (!toolInstance) {
        log.warn("tool_not_found", {
          availableToolNames: [...tools.keys()].sort(),
        });
        return {
          isError: true,
          output: {
            error: "tool_not_found",
            requestedTool: name,
          },
          outputSummary: `Tool ${name} is not available for this run.`,
        };
      }

      try {
        let consumeCodexImagegenConsentAfterSuccess = false;
        if (canonicalName === "generate_image") {
          const requestedModel = parseRequestedImageModel(args);
          if (requestedModel) {
            let imageProvider: string | undefined;
            try {
              imageProvider = resolveImageProviderName(requestedModel);
            } catch {
              imageProvider = undefined;
            }
            if (!imageProvider) {
              // Let the image tool surface its normal validation/provider error.
            } else {
              const decision = evaluateCodexImagegenDelegation({
                imageProvider,
                setting:
                  session.workspaceSettings?.codexImagegenDelegation ?? "ask",
                consentBudget: session.codexImagegenConsentBudget ?? 0,
                ...(session.runtimeProvider
                  ? { callerProvider: session.runtimeProvider }
                  : {}),
              });
              if (decision.status === "blocked") {
                const isConfirmationRequired =
                  decision.reason === "needs_confirmation";
                const summary = isConfirmationRequired
                  ? "Codex image generation needs explicit user confirmation before this non-Codex agent can use it."
                  : "Codex image generation delegation is disabled for this non-Codex agent in workspace settings.";
                return {
                  isError: false,
                  output: {
                    status: isConfirmationRequired
                      ? "requires_user_confirmation"
                      : "blocked_by_workspace_settings",
                    requiresUserConfirmation: isConfirmationRequired,
                    message: summary,
                    requestedProvider: session.runtimeProvider,
                    model: requestedModel,
                  },
                  outputSummary: summary,
                };
              }
              consumeCodexImagegenConsentAfterSuccess =
                decision.consumesConsent;
            }
          }
        }
        const createUserClient = options.createUserClient as (
          accessToken: string,
        ) => UserDataClient;
        const result = normalizeToolResult(
          canonicalName,
          await toolInstance.invoke(args, toolOptionsForSession(session)),
        );
        if (
          consumeCodexImagegenConsentAfterSuccess &&
          !result.isError &&
          result.output
        ) {
          session.codexImagegenConsentBudget = Math.max(
            0,
            (session.codexImagegenConsentBudget ?? 0) - 1,
          );
        }
        log.info("call_result", summarizeToolResult(result));
        if (
          canonicalName === "generate_image" &&
          !result.isError &&
          result.output
        ) {
          log.info("direct_image_insert_start", summarizeToolResult(result));
          await insertDirectGeneratedImage({
            createUserClient,
            output: result.output,
            session,
            pushToCanvas: options.connectionPublisher,
          });
          log.info("direct_image_insert_done", summarizeToolResult(result));
        }
        return result;
      } catch (error) {
        log.error("call_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          isError: true,
          output: {
            error: "tool_failed",
            message: error instanceof Error ? error.message : String(error),
          },
          outputSummary:
            error instanceof Error ? error.message : "Tool invocation failed.",
        };
      }
    },

    revokeSession(token: string) {
      sessions.delete(token);
    },
  };
}
