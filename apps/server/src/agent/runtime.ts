// @credits-system — Agent tool runtime with credit checks before image/video generation
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AgentRuntimeProvider,
  ChatMessage,
  ImageAttachment,
  ImageGenerationPreference,
  RunCancelResponse,
  RunCreateRequest,
  RunCreateResponse,
  RuntimeKind,
  StreamEvent,
  VideoGenerationPreference,
  WorkspaceSettings,
} from "@aimc/shared";
import {
  type LocalAgentProviderPlugin,
  type LocalAgentRuntime,
  createDefaultLocalAgentProviderPlugins,
  createDefaultLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

import type { AuthenticatedUser, UserDataClient } from "../auth/request.js";
import type { ServerEnv } from "../config/env.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type Placement,
  completeImageGenerationNode,
  createCanvasAutoPlacementSequence,
  insertImageGenerationNode,
  insertVideoGenerationNode,
} from "../features/canvas/canvas-element-writer.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  type TierGuard,
  TierGuardError,
} from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { refreshGenerationProviders } from "../features/settings/settings-service.js";
import { evaluateCodexImagegenDelegation } from "../generation/codex-imagegen-delegation.js";
import {
  validateImageGenerationParams,
  validateVideoGenerationParams,
} from "../generation/model-schemas.js";
import {
  getAvailableImageModels,
  resolveImageProviderName,
} from "../generation/providers/registry.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createPipelineLogger } from "../ws/logger.js";
import { createAgentBackend } from "./backends/index.js";
import type { ImageAttachmentMetadata } from "./image-attachment-metadata.js";
import {
  buildAgentImageJobPayload,
  buildAgentVideoJobPayload,
} from "./job-payloads.js";
import { resolveAimcWorkspaceSkills } from "./local-agent-host/skills.js";
import type { createLocalToolGatewayService } from "./local-agent-host/tool-gateway.js";
import {
  type RuntimeTarget,
  createRuntimeControlPlane,
  resolveResumeMode,
} from "./run-orchestrator.js";
import { inferAimcRuntimeTarget } from "./run-orchestrator.js";
import { createLocalAgentRuntimeProvider } from "./runtimes/local-agent.js";
import type { RuntimeExecutionContext } from "./runtimes/types.js";
// execute 工具由 deepagents 内置提供（LocalShellBackend 作为 sandbox backend）
// 不需要自定义代码执行工具
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { buildCanvasSummaryForContext } from "./tools/inspect-canvas.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type {
  ApplyWorkspaceSettingsPatch,
  ReadWorkspaceSettings,
} from "./tools/workspace-settings.js";
import { buildWorkspaceSettingsSnapshot } from "./tools/workspace-settings.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";

type BillingErrorCode = string;
type ImageQualityLevel = "standard" | "hd" | "ultra";
const IMAGE_JOB_POLL_INTERVAL_MS = 3_000;
const IMAGE_JOB_MAX_WAIT_MS = 10 * 60_000;

function inferRunCallerProvider(run: RuntimeRunRecord): string {
  if (run.runtimeProvider) return run.runtimeProvider;
  if (typeof run.modelOverride === "string") {
    const provider = run.modelOverride.split(":", 1)[0]?.trim();
    if (provider) return provider;
  }
  return run.runtimeProvider ?? "local-agent";
}

type CanvasSummaryClient = {
  from(table: "canvases"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        single(): Promise<{
          data: {
            content?: {
              elements?: Array<Record<string, unknown>>;
            };
          } | null;
        }>;
      };
    };
  };
};
type BrandKitLookupClient = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: unknown | null;
        }>;
      };
    };
  };
};

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function resolveBrandKitIdForRun(input: {
  accessToken?: string;
  canvasId?: string;
  createUserClient?: (accessToken: string) => unknown;
}): Promise<string | null> {
  if (!input.canvasId || !input.accessToken || !input.createUserClient) {
    return null;
  }

  const { accessToken, canvasId, createUserClient } = input;
  let client: BrandKitLookupClient;
  try {
    const candidate = createUserClient(accessToken);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("from" in candidate) ||
      typeof candidate.from !== "function"
    ) {
      return null;
    }
    client = candidate as BrandKitLookupClient;
  } catch (error) {
    console.warn("Failed to create Brand Kit lookup client:", error);
    return null;
  }
  try {
    const { data: canvas } = await client
      .from("canvases")
      .select("project_id, projects!inner(brand_kit_id)")
      .eq("id", canvasId)
      .maybeSingle();
    const canvasRecord = recordOrNull(canvas);
    const projectRecord = recordOrNull(canvasRecord?.projects);
    return typeof projectRecord?.brand_kit_id === "string"
      ? projectRecord.brand_kit_id
      : null;
  } catch {
    // Some PostgREST deployments do not expose the FK relationship. Retain
    // the compatible two-query fallback without delaying unrelated runtime
    // preparation.
    try {
      const { data: canvas } = await client
        .from("canvases")
        .select("project_id")
        .eq("id", canvasId)
        .maybeSingle();
      const projectId = recordOrNull(canvas)?.project_id;
      if (typeof projectId !== "string") return null;
      const { data: project } = await client
        .from("projects")
        .select("brand_kit_id")
        .eq("id", projectId)
        .maybeSingle();
      const brandKitId = recordOrNull(project)?.brand_kit_id;
      return typeof brandKitId === "string" ? brandKitId : null;
    } catch (error) {
      console.warn("Failed to resolve brand kit ID:", error);
      return null;
    }
  }
}

/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
  attachmentMetadata?: Record<string, ImageAttachmentMetadata>,
): { text: string } {
  const xmlBlocks: string[] = [];

  // Canvas state context (auto-injected, not user-provided)
  if (canvasSummary) {
    xmlBlocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }

  const inputImagesXml = buildInputImagesXml(attachments, attachmentMetadata);
  if (inputImagesXml) xmlBlocks.push(inputImagesXml);

  const imageGenerationPreferenceXml = buildImageGenerationPreferenceXml(
    imageGenerationPreference,
  );
  if (imageGenerationPreferenceXml)
    xmlBlocks.push(imageGenerationPreferenceXml);

  const videoGenerationPreferenceXml = buildVideoGenerationPreferenceXml(
    videoGenerationPreference,
  );
  if (videoGenerationPreferenceXml)
    xmlBlocks.push(videoGenerationPreferenceXml);

  if (!xmlBlocks.length) return { text: prompt };
  return { text: `${prompt}\n\n${xmlBlocks.join("\n\n")}` };
}

function buildInputImagesXml(
  attachments: ImageAttachment[],
  attachmentMetadata?: Record<string, ImageAttachmentMetadata>,
): string | null {
  if (attachments.length === 0) return null;

  const imageXml = attachments
    .map((attachment, i) => {
      const nameAttr = attachment.name
        ? ` name="${escapeXmlAttribute(attachment.name)}"`
        : "";
      const metadata = attachmentMetadata?.[attachment.assetId];
      const metadataAttrs = metadata
        ? ` width="${metadata.width}" height="${metadata.height}" orientation="${metadata.orientation}"`
        : "";
      return `<image index="${i + 1}" asset_id="${escapeXmlAttribute(attachment.assetId)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}"${nameAttr}${metadataAttrs} />`;
    })
    .join("\n  ");

  return `<input_images count="${attachments.length}">\n  ${imageXml}\n</input_images>`;
}

function buildImageGenerationPreferenceXml(
  imageGenerationPreference?: ImageGenerationPreference,
): string | null {
  if (
    imageGenerationPreference?.mode !== "manual" ||
    imageGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const availableModelIds = new Set(getAvailableImageModels().map((m) => m.id));
  const models = imageGenerationPreference.models.filter((model) =>
    availableModelIds.has(model),
  );
  if (models.length === 0) return null;

  const modelXml = models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_image_generation_preference mode="manual" count="${models.length}">\n  ${modelXml}\n</human_image_generation_preference>`;
}

function buildVideoGenerationPreferenceXml(
  videoGenerationPreference?: VideoGenerationPreference,
): string | null {
  if (
    videoGenerationPreference?.mode !== "manual" ||
    videoGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = videoGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_video_generation_preference mode="manual" count="${videoGenerationPreference.models.length}">\n  ${modelXml}\n</human_video_generation_preference>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a lookup map from assetId to base64 data URI.
 * Stored in configurable so tools can resolve assetId references.
 */
export function buildAttachmentDataMap(
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of downloaded) {
    map[d.assetId] = `data:${d.mimeType};base64,${d.base64}`;
  }
  return map;
}

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

type RuntimeRunCreateInput = RunCreateRequest;

type RuntimeRunRecord = RuntimeRunCreateInput & {
  accessToken?: string;
  assistantMessageId?: string;
  connectionId?: string;
  consumed: boolean;
  controller: AbortController;
  codexImagegenDelegation?: "ask" | "always" | "never";
  codexImagegenConsentBudget?: number;
  envOverride?: ServerEnv;
  modelOverride?: string;
  resumeContext?: {
    mode: "provider-local" | "handoff" | "fresh";
    previousRunId?: string;
    previousRuntimeKind?: RuntimeKind | null;
    previousRuntimeProvider?: AgentRuntimeProvider | null;
    providerSessionId?: string;
    resumeToken?: string;
  };
  runId: string;
  status: RuntimeRunStatus;
  threadId?: string;
  userId?: string;
};

type PatchWorkspaceSettings = (input: {
  patch: Pick<WorkspaceSettings, "codexImagegenDelegation">;
  userId?: string;
}) => Promise<WorkspaceSettings>;

type CreateAgentRuntimeOptions = {
  agentRunStore?: {
    createRun(input: {
      agentTargetId?: string;
      assistantMessageId?: string;
      canvasId?: string;
      model?: string;
      previousRunId?: string;
      resumeMode?: "provider-local" | "handoff" | "fresh";
      runtimeKind?: RuntimeKind;
      runtimeProvider?: AgentRuntimeProvider;
      runId: string;
      sessionId: string;
      threadId?: string;
    }): void;
    updateRun(input: {
      agentTargetId?: string;
      assistantMessageId?: string;
      errorCode?: string;
      errorMessage?: string;
      providerSessionId?: string;
      runId: string;
      resumeToken?: string;
      runtimeKind?: RuntimeKind;
      runtimeProvider?: AgentRuntimeProvider;
      status: RuntimeRunStatus;
    }): void;
    getRun?(runId: string):
      | {
          agent_target_id?: string | null;
          assistant_message_id?: string | null;
          id: string;
          previous_run_id?: string | null;
          provider_session_id?: string | null;
          resume_mode?: "provider-local" | "handoff" | "fresh" | null;
          resume_token?: string | null;
          runtime_kind?: RuntimeKind | null;
          runtime_provider?: AgentRuntimeProvider | null;
          session_id?: string | null;
          status?: RuntimeRunStatus;
        }
      | undefined;
  };
  connectionManager?: ConnectionManager;
  publishCanvasSyncEvent?: (input: {
    canvasId: string;
    event: Extract<StreamEvent, { type: "canvas.sync" }>;
    runId: string;
  }) => { eventId?: string; seq?: number } | undefined;
  createUserClient?: (accessToken: string) => unknown;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  localAgentProviderPlugins?: LocalAgentProviderPlugin<
    "local-agent",
    AgentRuntimeProvider
  >[];
  localAgentDetectionRuntime?: Pick<
    LocalAgentRuntime<"local-agent", AgentRuntimeProvider>,
    "detect"
  >;
  localAgentRuntime?: Pick<
    LocalAgentRuntime<"local-agent", AgentRuntimeProvider>,
    "run"
  > &
    Partial<
      Pick<LocalAgentRuntime<"local-agent", AgentRuntimeProvider>, "detect">
    >;
  loadSessionMessages?: (sessionId: string) => Promise<ChatMessage[]>;
  model?: string;
  now?: () => string;
  patchWorkspaceSettings?: PatchWorkspaceSettings;
  resolveProjectWorkspaceRoot?: (input: {
    canvasId?: string;
  }) => Promise<string | null> | string | null;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  toolGateway?: ReturnType<typeof createLocalToolGatewayService>;
  toolGatewayBaseUrl?: string;
  viewerService?: ViewerService;
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());
  // ── Billing error helper: push WS event + abort run ──────────
  function pushBillingErrorAndAbort(
    run: { runId: string; conversationId: string; controller: AbortController },
    canvasId: string | undefined,
    opts: { connectionManager?: ConnectionManager },
    code: BillingErrorCode,
    message: string,
    extra?: {
      currentBalance?: number;
      requiredAmount?: number;
      plan?: string;
      dailyClaimed?: boolean;
    },
  ): void {
    const canvasTarget = canvasId ?? run.conversationId;
    if (!opts.connectionManager || !canvasTarget) {
      console.warn(
        `[billing] pushBillingErrorAndAbort: no connectionManager or canvasTarget, billing.error (${code}) not sent to client`,
      );
    } else {
      opts.connectionManager.pushToCanvas(canvasTarget, {
        type: "billing.error",
        runId: run.runId,
        timestamp: new Date().toISOString(),
        code,
        message,
        ...extra,
      });
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
  }

  function createBillingBalanceExtra(input: {
    currentBalance: number;
    dailyClaimed?: boolean;
    plan?: string;
    requiredAmount: number;
  }) {
    return {
      currentBalance: input.currentBalance,
      requiredAmount: input.requiredAmount,
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      ...(input.dailyClaimed !== undefined
        ? { dailyClaimed: input.dailyClaimed }
        : {}),
    };
  }

  async function loadCanvasSummaryForRuntime(context: RuntimeExecutionContext) {
    const { run } = context;
    if (!run.canvasId || !run.accessToken || !options.createUserClient) {
      return null;
    }

    try {
      const canvasClient = options.createUserClient(
        run.accessToken,
      ) as CanvasSummaryClient;
      const { data: canvasData } = await canvasClient
        .from("canvases")
        .select("content")
        .eq("id", run.canvasId)
        .single();
      if (!canvasData?.content?.elements) {
        return null;
      }
      return buildCanvasSummaryForContext(
        canvasData.content.elements as Array<Record<string, unknown>>,
      );
    } catch {
      return null;
    }
  }

  const localAgentTrusted = options.env.trustedLocalAgentMode !== false;
  const localAgentProviderPlugins =
    options.localAgentProviderPlugins ??
    (createDefaultLocalAgentProviderPlugins() as LocalAgentProviderPlugin<
      "local-agent",
      AgentRuntimeProvider
    >[]);
  const defaultLocalAgentRuntime = createDefaultLocalAgentRuntime({
    providers: localAgentProviderPlugins,
  }) as LocalAgentRuntime<"local-agent", AgentRuntimeProvider>;
  const localAgentDetectionRuntime =
    options.localAgentDetectionRuntime ??
    (options.localAgentRuntime?.detect
      ? { detect: options.localAgentRuntime.detect }
      : defaultLocalAgentRuntime);
  const localAgentRuntime =
    localAgentTrusted && options.toolGateway && options.toolGatewayBaseUrl
      ? (options.localAgentRuntime ?? defaultLocalAgentRuntime)
      : null;
  const localAgentGatewayDeps =
    localAgentRuntime && options.toolGateway && options.toolGatewayBaseUrl
      ? {
          toolGateway: options.toolGateway,
          toolGatewayBaseUrl: options.toolGatewayBaseUrl,
        }
      : null;
  const runtimeProviders = [
    ...(localAgentRuntime && localAgentGatewayDeps
      ? localAgentProviderPlugins.map((providerPlugin) =>
          createLocalAgentRuntimeProvider(
            {
              buildAttachmentDataMap,
              buildUserMessage,
              loadCanvasSummaryForRuntime,
              ...(options.loadSessionMessages
                ? { loadSessionMessages: options.loadSessionMessages }
                : {}),
              ...(options.resolveProjectWorkspaceRoot
                ? {
                    resolveProjectWorkspaceRoot:
                      options.resolveProjectWorkspaceRoot,
                  }
                : {}),
              localAgentRuntime,
              now,
              recordProviderResumeMetadata(metadata) {
                options.agentRunStore?.updateRun({
                  ...(metadata.providerSessionId
                    ? { providerSessionId: metadata.providerSessionId }
                    : {}),
                  runId: metadata.runId,
                  ...(metadata.resumeToken
                    ? { resumeToken: metadata.resumeToken }
                    : {}),
                  status: runs.get(metadata.runId)?.status ?? "running",
                });
              },
              toolGateway: localAgentGatewayDeps.toolGateway,
              toolGatewayBaseUrl: localAgentGatewayDeps.toolGatewayBaseUrl,
            },
            providerPlugin,
          ),
        )
      : []),
  ];

  const runtimeControlPlane =
    createRuntimeControlPlane<RuntimeExecutionContext>(runtimeProviders, {
      now,
      selectRuntimeKind: inferAimcRuntimeTarget,
    });

  return {
    cancelRun(runId: string): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }

      run.status = "canceled";
      options.agentRunStore?.updateRun({
        runId,
        status: "canceled",
      });
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RuntimeRunCreateInput,
      runOptions?: {
        agentTargetId?: string;
        accessToken?: string;
        assistantMessageId?: string;
        connectionId?: string;
        env?: ServerEnv;
        model?: string;
        runtimeKind?: RuntimeKind;
        runtimeProvider?: AgentRuntimeProvider;
        codexImagegenDelegation?: "ask" | "always" | "never";
        threadId?: string;
        userId?: string;
      },
    ): RunCreateResponse {
      const runId = input.clientRequestId ?? runIdFactory();
      const runInput = input;
      const existingMemoryRun = input.clientRequestId
        ? runs.get(runId)
        : undefined;
      const existingPersistedRun =
        existingMemoryRun || !input.clientRequestId
          ? undefined
          : options.agentRunStore?.getRun?.(runId);
      const existingRun = existingMemoryRun ?? existingPersistedRun;
      if (existingRun) {
        const existingSessionId = existingMemoryRun
          ? existingMemoryRun.sessionId
          : existingPersistedRun?.session_id;
        const existingAgentTargetId = existingMemoryRun
          ? existingMemoryRun.agentTargetId
          : existingPersistedRun?.agent_target_id;
        const existingAssistantMessageId = existingMemoryRun
          ? existingMemoryRun.assistantMessageId
          : existingPersistedRun?.assistant_message_id;
        const existingRuntimeKind = existingMemoryRun
          ? existingMemoryRun.runtimeKind
          : existingPersistedRun?.runtime_kind;
        const existingRuntimeProvider = existingMemoryRun
          ? existingMemoryRun.runtimeProvider
          : existingPersistedRun?.runtime_provider;
        if (existingSessionId !== input.sessionId) {
          throw new Error(
            `clientRequestId is already bound to another session: ${runId}`,
          );
        }
        return {
          ...(existingAgentTargetId
            ? { agentTargetId: existingAgentTargetId }
            : {}),
          ...(existingAssistantMessageId
            ? { assistantMessageId: existingAssistantMessageId }
            : {}),
          conversationId: input.conversationId,
          reused: true,
          runId,
          ...(existingRuntimeKind ? { runtimeKind: existingRuntimeKind } : {}),
          ...(existingRuntimeProvider
            ? { runtimeProvider: existingRuntimeProvider }
            : {}),
          sessionId: input.sessionId,
          status: "accepted",
        };
      }
      const requestedRuntimeKind =
        runOptions?.runtimeKind ?? runInput.runtimeKind;
      const requestedRuntimeProvider =
        runOptions?.runtimeProvider ?? runInput.runtimeProvider;
      const resolvedModel =
        runOptions?.model ??
        runInput.model ??
        (typeof options.model === "string" ? options.model : undefined);

      let initialRuntimeTarget: RuntimeTarget | null = null;
      try {
        initialRuntimeTarget = runtimeControlPlane.resolveRuntimeTarget({
          model: resolvedModel,
          requestedRuntimeKind,
          ...(requestedRuntimeProvider ? { requestedRuntimeProvider } : {}),
        });
      } catch (error) {
        if (requestedRuntimeKind) {
          throw error;
        }
        initialRuntimeTarget = null;
      }
      const persistedRuntimeKind =
        initialRuntimeTarget?.kind ?? requestedRuntimeKind;
      const persistedRuntimeProvider =
        initialRuntimeTarget?.provider ?? requestedRuntimeProvider;
      const persistedAgentTargetId =
        runOptions?.agentTargetId ?? runInput.agentTargetId;
      if (persistedRuntimeKind === "local-agent" && !persistedAgentTargetId) {
        throw new Error(
          "Local agent runs must resolve an exact agentTargetId before createRun.",
        );
      }
      const previousRun = runInput.resumeFromRunId
        ? options.agentRunStore?.getRun?.(runInput.resumeFromRunId)
        : undefined;

      if (runInput.resumeFromRunId && !previousRun) {
        throw new Error(
          `Resume source run not found: ${runInput.resumeFromRunId}`,
        );
      }

      const identityResolvedResumeMode = runInput.resumeFromRunId
        ? resolveResumeMode({
            ...(persistedAgentTargetId
              ? { nextAgentTargetId: persistedAgentTargetId }
              : {}),
            ...(persistedRuntimeKind
              ? { nextRuntimeKind: persistedRuntimeKind }
              : {}),
            ...(persistedRuntimeProvider
              ? { nextRuntimeProvider: persistedRuntimeProvider }
              : {}),
            previousRuntimeKind: previousRun?.runtime_kind ?? null,
            previousRuntimeProvider: previousRun?.runtime_provider ?? null,
            previousAgentTargetId: previousRun?.agent_target_id ?? null,
          })
        : undefined;
      const rawResumeMode =
        runInput.resumeMode && runInput.resumeMode !== "auto"
          ? runInput.resumeMode
          : runInput.resumeFromRunId
            ? identityResolvedResumeMode
            : undefined;
      const requestedResumeMode =
        rawResumeMode === "native" ? "provider-local" : rawResumeMode;
      const resolvedResumeMode =
        requestedResumeMode === "provider-local" &&
        identityResolvedResumeMode !== "provider-local"
          ? "handoff"
          : requestedResumeMode;
      const resumeContext = resolvedResumeMode
        ? {
            mode: resolvedResumeMode,
            ...(runInput.resumeFromRunId
              ? { previousRunId: runInput.resumeFromRunId }
              : {}),
            ...(previousRun?.runtime_kind != null
              ? { previousRuntimeKind: previousRun.runtime_kind }
              : {}),
            ...(previousRun?.runtime_provider != null
              ? { previousRuntimeProvider: previousRun.runtime_provider }
              : {}),
            ...(previousRun?.agent_target_id != null
              ? { previousAgentTargetId: previousRun.agent_target_id }
              : {}),
            ...(previousRun?.provider_session_id
              ? { providerSessionId: previousRun.provider_session_id }
              : {}),
            ...(previousRun?.resume_token
              ? { resumeToken: previousRun.resume_token }
              : {}),
          }
        : undefined;

      const run: RuntimeRunRecord = {
        ...runInput,
        ...(persistedAgentTargetId
          ? { agentTargetId: persistedAgentTargetId }
          : {}),
        ...(runOptions?.accessToken
          ? { accessToken: runOptions.accessToken }
          : {}),
        ...(runOptions?.assistantMessageId
          ? { assistantMessageId: runOptions.assistantMessageId }
          : {}),
        ...(runOptions?.connectionId
          ? { connectionId: runOptions.connectionId }
          : {}),
        consumed: false,
        controller: new AbortController(),
        ...(runOptions?.env ? { envOverride: runOptions.env } : {}),
        ...(runOptions?.codexImagegenDelegation
          ? { codexImagegenDelegation: runOptions.codexImagegenDelegation }
          : {}),
        codexImagegenConsentBudget:
          runInput.delegationConsent?.codexImagegen === "allow-once" ? 1 : 0,
        ...(resolvedModel ? { modelOverride: resolvedModel } : {}),
        ...(resumeContext ? { resumeContext } : {}),
        ...(persistedRuntimeKind ? { runtimeKind: persistedRuntimeKind } : {}),
        ...(persistedRuntimeProvider
          ? { runtimeProvider: persistedRuntimeProvider }
          : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.userId ? { userId: runOptions.userId } : {}),
        runId,
        status: "accepted",
      };
      runs.set(runId, run);

      options.agentRunStore?.createRun({
        ...(persistedAgentTargetId
          ? { agentTargetId: persistedAgentTargetId }
          : {}),
        ...(runOptions?.assistantMessageId
          ? { assistantMessageId: runOptions.assistantMessageId }
          : {}),
        ...(runInput.canvasId ? { canvasId: runInput.canvasId } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(runInput.resumeFromRunId
          ? { previousRunId: runInput.resumeFromRunId }
          : {}),
        ...(resolvedResumeMode ? { resumeMode: resolvedResumeMode } : {}),
        ...(persistedRuntimeKind ? { runtimeKind: persistedRuntimeKind } : {}),
        ...(persistedRuntimeProvider
          ? { runtimeProvider: persistedRuntimeProvider }
          : {}),
        runId,
        sessionId: runInput.sessionId,
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
      });

      return {
        ...(persistedAgentTargetId
          ? { agentTargetId: persistedAgentTargetId }
          : {}),
        ...(runOptions?.assistantMessageId
          ? { assistantMessageId: runOptions.assistantMessageId }
          : {}),
        conversationId: input.conversationId,
        runId,
        ...(persistedRuntimeKind ? { runtimeKind: persistedRuntimeKind } : {}),
        ...(persistedRuntimeProvider
          ? { runtimeProvider: persistedRuntimeProvider }
          : {}),
        ...(resolvedResumeMode ? { resumeMode: resolvedResumeMode } : {}),
        sessionId: input.sessionId,
        status: "accepted",
      };
    },

    hasRun(runId: string) {
      return runs.has(runId);
    },

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.consumed) {
        return;
      }

      run.consumed = true;
      if (run.controller.signal.aborted) {
        run.status = "canceled";
        yield {
          runId,
          timestamp: now(),
          type: "run.canceled",
        };
        return;
      }
      run.status = "running";
      options.agentRunStore?.updateRun({
        runId,
        status: "running",
      });

      const rlog = createPipelineLogger("runtime", { runId });

      rlog.lap("local_history_mode");

      const getWorkspaceSettings: ReadWorkspaceSettings = async () => {
        const setting = run.codexImagegenDelegation ?? "ask";
        const consentBudget = run.codexImagegenConsentBudget ?? 0;
        const callerProvider = inferRunCallerProvider(run);
        return buildWorkspaceSettingsSnapshot({
          callerProvider,
          codexImagegenDelegation: setting,
          consentBudget,
        });
      };

      const updateWorkspaceSettings: ApplyWorkspaceSettingsPatch = async ({
        patch,
      }) => {
        let summary: string | undefined;

        if (patch.codexImagegenDelegation === "allow-once") {
          run.codexImagegenConsentBudget = Math.max(
            1,
            run.codexImagegenConsentBudget ?? 0,
          );
        } else if (patch.codexImagegenDelegation === "deny") {
          run.codexImagegenConsentBudget = 0;
          summary =
            "Codex image generation delegation was denied for the current task. Do not call Codex image generation for this task.";
        } else if (patch.codexImagegenDelegation !== undefined) {
          if (!options.patchWorkspaceSettings) {
            throw new Error(
              "Workspace settings are not available in this runtime.",
            );
          }
          const updated = await options.patchWorkspaceSettings({
            patch: {
              codexImagegenDelegation: patch.codexImagegenDelegation,
            },
            ...(run.userId ? { userId: run.userId } : {}),
          });
          run.codexImagegenDelegation = updated.codexImagegenDelegation;
        }

        return buildWorkspaceSettingsSnapshot({
          callerProvider: inferRunCallerProvider(run),
          codexImagegenDelegation: run.codexImagegenDelegation ?? "ask",
          consentBudget: run.codexImagegenConsentBudget ?? 0,
          ...(summary ? { summary } : {}),
        });
      };

      // Build submitImageJob / submitVideoJob closures for async jobs via PGMQ
      let submitImageJob: SubmitImageJobFn | undefined;
      let submitVideoJob: SubmitVideoJobFn | undefined;
      if (
        options.jobService &&
        options.createUserClient &&
        run.accessToken &&
        run.userId
      ) {
        const jobSvc = options.jobService;
        const createClient = options.createUserClient;
        const accessToken = run.accessToken;
        const userId = run.userId;
        const canvasId = run.canvasId;
        const sessionId = run.sessionId;
        const runId = run.runId;
        let imagePlacementSequencePromise: Promise<{
          reserve(size: Pick<Placement, "height" | "width">): Placement;
        }> | null = null;

        const publishCanvasSync = () => {
          if (!canvasId) return;
          const event = {
            type: "canvas.sync" as const,
            runId,
            timestamp: new Date().toISOString(),
          } satisfies StreamEvent;
          const replayEnvelope = options.publishCanvasSyncEvent?.({
            canvasId,
            event,
            runId,
          });
          options.connectionManager?.pushToCanvas(
            canvasId,
            event,
            replayEnvelope,
          );
        };

        const reserveImagePlacement = async (
          input: Parameters<SubmitImageJobFn>[0],
        ): Promise<Placement | undefined> => {
          if (input.placementX != null && input.placementY != null) {
            return {
              x: input.placementX,
              y: input.placementY,
              width: input.placementWidth ?? 512,
              height: input.placementHeight ?? 512,
            };
          }
          if (!canvasId) return undefined;

          imagePlacementSequencePromise ??= createCanvasAutoPlacementSequence(
            createClient(accessToken) as UserDataClient,
            canvasId,
          );

          try {
            const sequence = await imagePlacementSequencePromise;
            return sequence.reserve(estimateImageDisplaySize(input));
          } catch (error) {
            console.warn(
              "[submitImageJob] auto placement reservation failed:",
              error,
            );
            return undefined;
          }
        };

        submitImageJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitImageJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };
          refreshGenerationProviders(run.envOverride ?? options.env);
          validateImageGenerationParams({
            prompt: input.prompt,
            model: input.model,
            ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
            ...(input.inputImages ? { inputImages: input.inputImages } : {}),
            ...(input.quality
              ? { quality: input.quality as ImageQualityLevel }
              : {}),
            ...(input.size ? { size: input.size } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          });
          const imageProvider = resolveImageProviderName(input.model);
          const callerProvider = inferRunCallerProvider(run);
          const delegationDecision = evaluateCodexImagegenDelegation({
            callerProvider,
            imageProvider,
            setting: run.codexImagegenDelegation ?? "ask",
            consentBudget: run.codexImagegenConsentBudget ?? 0,
          });
          if (delegationDecision.status === "blocked") {
            throw new Error(
              delegationDecision.reason === "needs_confirmation"
                ? "codex_imagegen_confirmation_required: Codex image generation requires user confirmation before a non-Codex agent can use it."
                : "codex_imagegen_disabled_by_user: Codex image generation is disabled for non-Codex agents in workspace settings.",
            );
          }
          const reservedPlacement = await reserveImagePlacement(input);

          // Look up personal workspace directly — the viewer is already
          // bootstrapped from the normal auth flow, so we skip ensureViewer
          // to avoid its strict email validation on the profile schema.
          const client = createClient(accessToken) as UserDataClient;
          const { data: ws } = await client
            .from("workspaces")
            .select("id")
            .eq("type", "personal")
            .limit(1)
            .single();
          if (!ws?.id) throw new Error("No personal workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // ── Tier guard + credit checks (same as HTTP route) ──
          const workspaceId = ws.id;
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            const quality = (input.quality as ImageQualityLevel) ?? "hd";
            try {
              options.tierGuard.checkModelAccess(sub.plan, input.model);
              options.tierGuard.checkResolution(sub.plan, quality);
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              input.model,
              "image_generation",
              { quality },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  ...createBillingBalanceExtra({
                    currentBalance: balanceInfo.balance,
                    requiredAmount: creditsCost,
                    ...(balanceInfo.plan !== undefined
                      ? { plan: balanceInfo.plan }
                      : {}),
                    ...(balanceInfo.dailyClaimed !== undefined
                      ? { dailyClaimed: balanceInfo.dailyClaimed }
                      : {}),
                  }),
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          let projectId: string | undefined;
          if (canvasId) {
            try {
              const { data: canvas } = await client
                .from("canvases")
                .select("project_id")
                .eq("id", canvasId)
                .maybeSingle();
              const resolved = recordOrNull(canvas)?.project_id;
              if (typeof resolved === "string" && resolved) {
                projectId = resolved;
              }
            } catch (error) {
              console.warn(
                "[submitImageJob] failed to resolve projectId from canvas:",
                error,
              );
            }
          }

          const job = await jobSvc.createJob(user, {
            workspaceId,
            ...(projectId ? { projectId } : {}),
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "image_generation",
            payload: {
              ...buildAgentImageJobPayload(input),
              caller_provider: callerProvider,
              ...(imageProvider === "codex-imagegen" &&
              callerProvider !== "codex"
                ? { codex_imagegen_delegation_allowed: true }
                : {}),
              ...(delegationDecision.consumesConsent
                ? { codex_imagegen_consent: "allow-once" as const }
                : {}),
            },
          });
          if (delegationDecision.consumesConsent) {
            run.codexImagegenConsentBudget = Math.max(
              0,
              (run.codexImagegenConsentBudget ?? 0) - 1,
            );
          }

          // Deduct credits after job creation
          if (options.creditService && creditsCost > 0) {
            try {
              const txId = await options.creditService.deductCredits(
                workspaceId,
                userId,
                creditsCost,
                job.id,
                `Image generation: ${input.model}`,
              );
              await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
            } catch (deductError) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              throw deductError;
            }
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
            sessionId,
            runId,
          });

          let elementId: string | undefined;
          if (canvasId) {
            try {
              const insertResult = await insertImageGenerationNode(
                client,
                {
                  canvasId,
                  jobId: job.id,
                  prompt: input.prompt,
                  title: input.title,
                  model: input.model,
                  aspectRatio: input.aspectRatio,
                  runId,
                  ...(input.quality ? { quality: input.quality } : {}),
                  ...(input.inputImages
                    ? { inputImages: input.inputImages }
                    : {}),
                },
                reservedPlacement,
              );
              elementId = insertResult.elementId;
              publishCanvasSync();
              jobLap("canvas_generation_node_inserted", {
                elementId,
              });
            } catch (insertErr) {
              console.error(
                "[submitImageJob] canvas generation node insert failed:",
                insertErr,
              );
            }
          }
          const finalResult = await waitForImageJobResult(
            jobSvc,
            user,
            job.id,
            jobLap,
            run.controller.signal,
          );
          if (canvasId) {
            try {
              const completed = await completeImageGenerationNode(client, {
                canvasId,
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                ...(finalResult.assetId != null
                  ? { assetId: finalResult.assetId }
                  : {}),
                signedUrl: finalResult.imageUrl,
                ...(finalResult.objectPath != null
                  ? { objectPath: finalResult.objectPath }
                  : {}),
                mimeType: finalResult.mimeType,
                width: finalResult.width,
                height: finalResult.height,
                title: input.title,
              });
              elementId = completed.elementId;
              publishCanvasSync();
              jobLap("canvas_generation_node_completed", {
                elementId,
              });
            } catch (completeErr) {
              console.error(
                "[submitImageJob] canvas generation node complete failed:",
                completeErr,
              );
            }
          }
          return {
            jobId: job.id,
            ...(elementId != null ? { elementId } : {}),
            ...finalResult,
          };
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitVideoJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };
          refreshGenerationProviders(run.envOverride ?? options.env);
          validateVideoGenerationParams({
            prompt: input.prompt,
            model: input.model,
            ...(input.duration != null ? { duration: input.duration } : {}),
            ...(input.resolution
              ? {
                  resolution: input.resolution as
                    | "480p"
                    | "720p"
                    | "1080p"
                    | "4k"
                    | "2160p",
                }
              : {}),
            ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
            ...(input.inputImages ? { inputImages: input.inputImages } : {}),
            ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
            ...(input.videoMode ? { videoMode: input.videoMode } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.negativePrompt
              ? { negativePrompt: input.negativePrompt }
              : {}),
            ...(input.frameRate !== undefined
              ? { frameRate: input.frameRate }
              : {}),
            ...(input.numFrames !== undefined
              ? { numFrames: input.numFrames }
              : {}),
            ...(input.enableAudio != null
              ? { enableAudio: input.enableAudio }
              : {}),
          });

          const client = createClient(accessToken) as UserDataClient;
          const { data: ws } = await client
            .from("workspaces")
            .select("id")
            .eq("type", "personal")
            .limit(1)
            .single();
          if (!ws?.id) throw new Error("No personal workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // ── Tier guard + credit checks (same as HTTP route) ──
          const workspaceId = ws.id;
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            try {
              options.tierGuard.checkModelAccess(sub.plan, input.model);
              if (input.resolution) {
                options.tierGuard.checkResolution(sub.plan, input.resolution);
              }
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              input.model,
              "video_generation",
              {
                ...(input.duration != null ? { duration: input.duration } : {}),
                ...(input.resolution ? { resolution: input.resolution } : {}),
              },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  ...createBillingBalanceExtra({
                    currentBalance: balanceInfo.balance,
                    requiredAmount: creditsCost,
                    ...(balanceInfo.plan !== undefined
                      ? { plan: balanceInfo.plan }
                      : {}),
                    ...(balanceInfo.dailyClaimed !== undefined
                      ? { dailyClaimed: balanceInfo.dailyClaimed }
                      : {}),
                  }),
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          let projectId: string | undefined;
          if (canvasId) {
            try {
              const { data: canvas } = await client
                .from("canvases")
                .select("project_id")
                .eq("id", canvasId)
                .maybeSingle();
              const resolved = recordOrNull(canvas)?.project_id;
              if (typeof resolved === "string" && resolved) {
                projectId = resolved;
              }
            } catch (error) {
              console.warn(
                "[submitVideoJob] failed to resolve projectId from canvas:",
                error,
              );
            }
          }

          const job = await jobSvc.createJob(user, {
            workspaceId,
            ...(projectId ? { projectId } : {}),
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "video_generation",
            payload: buildAgentVideoJobPayload(input),
          });

          // Deduct credits after job creation
          if (options.creditService && creditsCost > 0) {
            try {
              const txId = await options.creditService.deductCredits(
                workspaceId,
                userId,
                creditsCost,
                job.id,
                `Video generation: ${input.model}`,
              );
              await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
            } catch (deductError) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              throw deductError;
            }
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
            sessionId,
            runId,
          });

          let elementId: string | undefined;
          if (canvasId) {
            try {
              const explicitPlacement =
                input.placementX != null && input.placementY != null
                  ? {
                      x: input.placementX,
                      y: input.placementY,
                      width: input.placementWidth ?? 640,
                      height: input.placementHeight ?? 360,
                    }
                  : undefined;

              const insertResult = await insertVideoGenerationNode(
                client,
                {
                  canvasId,
                  jobId: job.id,
                  prompt: input.prompt,
                  title: input.title,
                  model: input.model,
                  aspectRatio: input.aspectRatio ?? "16:9",
                  runId,
                  ...(input.duration != null
                    ? { duration: input.duration }
                    : {}),
                  ...(input.resolution ? { resolution: input.resolution } : {}),
                  ...(input.inputImages
                    ? { inputImages: input.inputImages }
                    : {}),
                },
                explicitPlacement,
              );
              elementId = insertResult.elementId;
              publishCanvasSync();
              jobLap("canvas_generation_node_inserted", {
                elementId,
              });
            } catch (insertErr) {
              console.error(
                "[submitVideoJob] canvas generation node insert failed:",
                insertErr,
              );
            }
          }
          jobLap("job_poll_done", { pollCount: 0, status: "deferred" });
          return {
            jobId: job.id,
            ...(elementId != null ? { elementId } : {}),
            status: "generating",
          };
        };
      }

      const runtimeEnv = run.envOverride ?? options.env;
      let backendResult: Awaited<ReturnType<typeof createAgentBackend>> | null =
        null;
      let activeRuntimeTarget: RuntimeTarget | null = null;
      let runtimeLease: { release(): void } | null = null;

      try {
        // Runtime selection is pure and must happen before filesystem/backend
        // preparation. The local-agent backend always stays VM-local.
        const resolvedModel = run.modelOverride ?? options.model;
        const resolvedRuntimeTarget = runtimeControlPlane.resolveRuntimeTarget({
          model: resolvedModel,
          requestedRuntimeKind: run.runtimeKind,
          ...(run.runtimeProvider
            ? { requestedRuntimeProvider: run.runtimeProvider }
            : {}),
        });
        activeRuntimeTarget = resolvedRuntimeTarget;
        run.runtimeKind = resolvedRuntimeTarget.kind;
        run.runtimeProvider = resolvedRuntimeTarget.provider;
        runtimeLease = runtimeControlPlane.acquireRuntimeLease(
          resolvedRuntimeTarget,
          run.runId,
        );

        const workspaceSkillsStartedAt = Date.now();
        const workspaceSkillsPromise = resolveAimcWorkspaceSkills({
          ...(run.accessToken ? { accessToken: run.accessToken } : {}),
          ...(run.canvasId ? { canvasId: run.canvasId } : {}),
          ...(options.createUserClient
            ? { createUserClient: options.createUserClient }
            : {}),
        })
          .catch((error) => {
            // Non-fatal: the agent remains usable without optional workspace
            // skills.
            console.warn("[runtime] Failed to load workspace skills:", error);
            return [] as WorkspaceSkillEntry[];
          })
          .then((skills) => {
            rlog.info("workspace_skills_prepare_done", {
              count: skills.length,
              elapsed_ms: Date.now() - workspaceSkillsStartedAt,
            });
            return skills;
          });

        const brandKitStartedAt = Date.now();
        const brandKitPromise = resolveBrandKitIdForRun({
          ...(run.accessToken ? { accessToken: run.accessToken } : {}),
          ...(run.canvasId ? { canvasId: run.canvasId } : {}),
          ...(options.createUserClient
            ? { createUserClient: options.createUserClient }
            : {}),
        }).then((brandKitId) => {
          rlog.info("brand_query_done", {
            elapsed_ms: Date.now() - brandKitStartedAt,
            found: brandKitId != null,
          });
          return brandKitId;
        });

        const backendStartedAt = Date.now();
        const backendPromise = createAgentBackend(runtimeEnv, run.canvasId, {
          // Keep the local tool gateway sandbox VM-local. The provider runDir
          // owns the materialized workspace skill copy.
          sandboxRoot: tmpdir(),
          workspaceSkills: [],
        });
        const measuredBackendPromise = Promise.resolve(backendPromise).then(
          (result) => {
            rlog.info("backend_prepare_done", {
              elapsed_ms: Date.now() - backendStartedAt,
              runtime_kind: resolvedRuntimeTarget.kind,
              sandbox_scope: "runtime-local",
            });
            return result;
          },
        );

        const [workspaceSkills, brandKitId, preparedBackendResult] =
          await Promise.all([
            workspaceSkillsPromise,
            brandKitPromise,
            measuredBackendPromise,
          ]);
        backendResult = preparedBackendResult;
        rlog.lap("runtime_preparation_done");

        options.agentRunStore?.updateRun({
          runId,
          runtimeKind: resolvedRuntimeTarget.kind,
          ...(resolvedRuntimeTarget.provider
            ? { runtimeProvider: resolvedRuntimeTarget.provider }
            : {}),
          status: run.status,
        });

        for await (const event of runtimeControlPlane.streamRun(
          resolvedRuntimeTarget,
          {
            backendResult: preparedBackendResult,
            brandKitId,
            resolvedModel,
            rlog,
            run,
            runtimeEnv,
            getWorkspaceSettings,
            ...(submitImageJob ? { submitImageJob } : {}),
            ...(submitVideoJob ? { submitVideoJob } : {}),
            updateWorkspaceSettings,
            workspaceSkills,
          },
        )) {
          run.status = mapEventToStatus(event);
          yield event;

          if (!isTerminalEvent(event) && options.eventDelayMs) {
            try {
              await delay(options.eventDelayMs, undefined, {
                signal: run.controller.signal,
              });
            } catch {
              run.status = "canceled";
              yield {
                runId,
                timestamp: now(),
                type: "run.canceled",
              };
              return;
            }
          }
        }
      } catch (streamError) {
        if (run.controller.signal.aborted) {
          run.status = "canceled";
          yield {
            runId,
            timestamp: now(),
            type: "run.canceled",
          };
          return;
        }
        console.error("[agent-runtime] Stream iteration failed:", streamError);
        if (activeRuntimeTarget) {
          runtimeControlPlane.updateRuntimeStatus(
            activeRuntimeTarget,
            "degraded",
          );
        }
        const failedEvent = toFailedEvent(runId, now, streamError);
        run.status = "failed";
        yield failedEvent;
        return;
      } finally {
        runtimeLease?.release();
        if (backendResult?.sandboxDir) {
          rm(backendResult.sandboxDir, {
            recursive: true,
            force: true,
          }).catch((err) =>
            console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
      }
    },
  };
}

function isTerminalEvent(event: StreamEvent) {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}

function estimateImageDisplaySize(
  input: Parameters<SubmitImageJobFn>[0],
): Pick<Placement, "height" | "width"> {
  const ratio =
    parseImageSizeRatio(input.size) ?? parseAspectRatio(input.aspectRatio) ?? 1;
  const maxSize = 600;

  if (ratio >= 1) {
    return {
      width: maxSize,
      height: Math.round(maxSize / ratio),
    };
  }

  return {
    width: Math.round(maxSize * ratio),
    height: maxSize,
  };
}

function parseImageSizeRatio(size: string | undefined) {
  const match = size?.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return width / height;
}

function parseAspectRatio(aspectRatio: string | undefined) {
  const match = aspectRatio?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return width / height;
}

async function waitForImageJobResult(
  jobSvc: JobService,
  user: AuthenticatedUser,
  jobId: string,
  jobLap: (label: string, extra?: Record<string, unknown>) => void,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  let pollCount = 0;
  let cancelRequested = false;

  const cancelJobForAbort = async () => {
    if (cancelRequested) return;
    cancelRequested = true;
    jobLap("job_cancel_requested", { jobId });
    await jobSvc.cancelJob(user, jobId).catch((err) => {
      console.warn("[submitImageJob] cancel job after run abort failed:", err);
    });
  };

  for (;;) {
    if (signal.aborted) {
      await cancelJobForAbort();
      throw new Error("Image generation was canceled.");
    }

    const job = await jobSvc.getJobAdmin(jobId);
    pollCount += 1;
    if (job.status === "succeeded") {
      const result = recordOrNull(job.result) ?? {};
      const imageUrl = result.signed_url;
      const assetId = result.asset_id;
      const mimeType = result.mime_type;
      const width = result.width;
      const height = result.height;
      const objectPath = result.object_path;
      if (
        typeof imageUrl !== "string" ||
        typeof mimeType !== "string" ||
        typeof width !== "number" ||
        typeof height !== "number"
      ) {
        throw new Error("Image generation completed without a usable result.");
      }
      jobLap("job_poll_done", {
        pollCount,
        status: job.status,
      });
      return {
        imageUrl,
        ...(typeof assetId === "string" ? { assetId } : {}),
        ...(typeof objectPath === "string" ? { objectPath } : {}),
        mimeType,
        width,
        height,
      };
    }

    if (job.status === "dead_letter" || job.status === "failed") {
      throw new Error(job.error_message ?? "Image generation failed.");
    }

    if (job.status === "canceled") {
      throw new Error("Image generation was canceled.");
    }

    if (Date.now() - startedAt >= IMAGE_JOB_MAX_WAIT_MS) {
      throw new Error(`Image generation job ${jobId} timed out.`);
    }

    try {
      await delay(IMAGE_JOB_POLL_INTERVAL_MS, undefined, { signal });
    } catch (err) {
      if (signal.aborted) {
        await cancelJobForAbort();
        throw new Error("Image generation was canceled.");
      }
      throw err;
    }
  }
}

function mapEventToStatus(event: StreamEvent): RuntimeRunStatus {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return "running";
  }
}

function toFailedEvent(
  runId: string,
  now: () => string,
  error: unknown,
): Extract<StreamEvent, { type: "run.failed" }> {
  // Log full error detail server-side
  console.error(`[runtime] Agent run failed for run ${runId}:`, error);

  return {
    error: {
      code: "run_failed",
      message: sanitizeErrorForClient(error),
    },
    runId,
    timestamp: now(),
    type: "run.failed",
  };
}
