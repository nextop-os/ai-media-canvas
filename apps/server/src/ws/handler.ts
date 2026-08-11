import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import {
  type AgentRuntimeProvider,
  type RunCreateRequest,
  type RuntimeKind,
  type StreamEvent,
  type WorkspaceSettings,
  wsCommandSchema,
  wsRpcResponseSchema,
} from "@aimc/shared";
import {
  AgentTargetResolutionError,
  resolveAgentTarget,
} from "../agent/agent-targets.js";
import {
  AgentRunModelResolutionError,
  type AgentRunOrchestrator,
  createAgentRunOrchestrator,
  getLocalAgentModelProvider,
  resolveAgentRunModel,
} from "../agent/run-orchestrator.js";
import type { AgentRunService } from "../agent/runtime.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../auth/request.js";
import type { ServerEnv } from "../config/env.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import {
  LOCAL_WORKSPACE_ID,
  type SettingsService,
} from "../features/settings/settings-service.js";
import { summarizeImageAttachments } from "../logging/attachments.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type RegisterWsOptions = {
  agentRuns: AgentRunService;
  agentRunOrchestrator?: AgentRunOrchestrator;
  agentRunPersistence?: {
    appendEvent: (input: {
      canvasId?: string;
      event: StreamEvent;
      runId: string;
    }) => { canvasSeq?: number; eventId: string; seq: number };
    getLatestCanvasSeq?: (canvasId: string) => number;
    getActiveRun?: (
      canvasId: string,
      sessionId: string,
    ) => {
      assistantMessageId: string | null;
      runId: string;
      runtimeKind: RuntimeKind | null;
      runtimeProvider: AgentRuntimeProvider | null;
      agentTargetId: string | null;
      sessionId: string;
      status: "accepted" | "running" | "completed" | "failed" | "canceled";
    } | null;
    listCanvasEvents?: (
      canvasId: string,
      cursor?: number,
    ) => Array<{
      event: StreamEvent;
      eventId: string;
      canvasSeq: number;
    }>;
  };
  auth?: RequestAuthenticator;
  chatService?: ChatService;
  connectionManager: ConnectionManager;
  eventBuffer?: CanvasEventBuffer;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
};

export async function registerWsRoute(
  app: FastifyInstance,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;

  app.get(
    "/api/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !options.auth) {
        socket.close(4001, "Unauthorized");
        return;
      }

      void authenticateAndBind(
        socket,
        token,
        request,
        options,
        agentRuns,
        connectionManager,
      );
    },
  );
}

async function authenticateAndBind(
  socket: WebSocket,
  token: string,
  request: FastifyRequest,
  options: RegisterWsOptions,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
) {
  const log = createPipelineLogger("ws");

  let authenticatedUser: AuthenticatedUser;
  try {
    if (!options.auth) {
      log.warn("auth_rejected", { reason: "missing_authenticator" });
      socket.close(4001, "Unauthorized");
      return;
    }
    const fakeRequest = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as FastifyRequest;
    const user = await options.auth.authenticate(fakeRequest);
    if (!user) {
      log.warn("auth_rejected", { reason: "invalid_token" });
      socket.close(4001, "Unauthorized");
      return;
    }
    authenticatedUser = user;
    log.info("connected", { userId: user.id });
  } catch (err) {
    log.warn("auth_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    socket.close(4001, "Unauthorized");
    return;
  }

  if (socket.readyState !== 1) return;

  // Use client-provided connectionId for reconnect identity; fallback to server UUID
  const urlForParams = new URL(request.url, `http://${request.headers.host}`);
  const connectionId =
    urlForParams.searchParams.get("connectionId") || randomUUID();
  connectionManager.register(connectionId, authenticatedUser.id, socket);

  // Heartbeat with pong timeout (spec §1.3: 60s no-pong → disconnect)
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });

  const pingInterval = setInterval(() => {
    if (Date.now() - lastPong > 60_000) {
      log.warn("pong_timeout", { userId: authenticatedUser.id });
      socket.terminate();
      return;
    }
    if (socket.readyState === 1) {
      socket.ping();
    }
  }, 30_000);

  socket.on("message", (raw: Buffer | string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf-8"),
      );
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.type === "rpc.response") {
      try {
        const rpcResponse = wsRpcResponseSchema.parse(parsed);
        connectionManager.handleRpcResponse(connectionId, {
          type: rpcResponse.type,
          id: rpcResponse.id,
          ...(rpcResponse.result !== undefined
            ? { result: rpcResponse.result }
            : {}),
          ...(rpcResponse.error !== undefined
            ? { error: rpcResponse.error }
            : {}),
        });
      } catch {
        // Ignore malformed RPC responses
      }
      return;
    }

    if (obj.type === "command") {
      let msg: ReturnType<typeof wsCommandSchema.parse>;
      try {
        msg = wsCommandSchema.parse(parsed);
      } catch {
        socket.send(
          JSON.stringify({ type: "error", message: "Invalid command format" }),
        );
        return;
      }

      if (msg.action === "agent.run") {
        const p = msg.payload;
        void handleRunCommand(
          {
            ...authenticatedUser,
            accessToken: token,
          },
          connectionId,
          p,
          agentRuns,
          connectionManager,
          options,
        ).catch((error) => {
          sendCommandError(connectionManager, connectionId, {
            action: "agent.run",
            requestId: p.clientRequestId,
            code: "internal_error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to start agent run.",
          });
        });
      } else if (msg.action === "agent.cancel") {
        log.info("run_cancel", {
          userId: authenticatedUser.id,
          runId: msg.payload.runId,
        });
        void handleCancelCommand(
          msg.payload.runId,
          agentRuns,
          connectionManager,
          options,
          socket,
        );
      } else if (msg.action === "canvas.resume") {
        const p = msg.payload;
        log.info("canvas_resume", {
          userId: authenticatedUser.id,
          canvasId: p.canvasId,
          lastSeq: p.lastSeq,
        });

        // Re-bind this connection to the canvas
        connectionManager.bindCanvas(connectionId, p.canvasId);

        const missed = p.skipReplay
          ? []
          : (options.agentRunPersistence?.listCanvasEvents?.(
              p.canvasId,
              p.lastSeq,
            ) ??
            options.eventBuffer?.getAfter(p.canvasId, p.lastSeq) ??
            []);
        const activeRun =
          connectionManager.getActiveRun(p.canvasId, p.sessionId) ??
          options.agentRunPersistence?.getActiveRun?.(
            p.canvasId,
            p.sessionId,
          ) ??
          null;
        const latestPersistedSeq =
          options.agentRunPersistence?.getLatestCanvasSeq?.(p.canvasId) ?? 0;
        const latestBufferedSeq =
          options.eventBuffer?.getLatestSeq(p.canvasId) ?? 0;

        // IMPORTANT: Send ACK FIRST so client registers event listener
        // BEFORE replay events arrive. Otherwise replayed events have no handler.
        connectionManager.sendTo(connectionId, {
          type: "command.ack",
          action: "canvas.resume",
          payload: {
            canvasId: p.canvasId,
            latestSeq: Math.max(latestPersistedSeq, latestBufferedSeq),
            activeRunId: activeRun?.runId ?? null,
            assistantMessageId: activeRun?.assistantMessageId ?? null,
            runtimeKind: activeRun?.runtimeKind ?? null,
            runtimeProvider: activeRun?.runtimeProvider ?? null,
            agentTargetId: activeRun?.agentTargetId ?? null,
            skipReplay: p.skipReplay ?? false,
            replayed: missed.length,
          },
        });

        // THEN replay missed events from buffer
        for (const entry of missed) {
          connectionManager.sendTo(connectionId, {
            type: "event",
            event: entry.event,
            ...("eventId" in entry && typeof entry.eventId === "string"
              ? { eventId: entry.eventId }
              : {}),
            replayed: true,
            ...("canvasSeq" in entry && typeof entry.canvasSeq === "number"
              ? { seq: entry.canvasSeq }
              : "seq" in entry && typeof entry.seq === "number"
                ? { seq: entry.seq }
                : {}),
          });
        }
      }
    }
  });

  socket.on("close", () => {
    log.info("disconnected", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId, socket);
  });

  socket.on("error", () => {
    log.error("socket_error", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId, socket);
  });
}

async function handleRunCommand(
  authenticatedUser: AuthenticatedUser,
  connectionId: string,
  payload: Omit<RunCreateRequest, "accessToken">,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  const log = createPipelineLogger("agent.run", {
    userId: authenticatedUser.id,
    sessionId: payload.sessionId,
  });
  log.info("started", {
    attachments: summarizeImageAttachments(payload.attachments),
    attachmentCount: payload.attachments?.length ?? 0,
    prompt: payload.prompt.slice(0, 80),
  });

  // Resolve thread + model in parallel
  const [threadId, runtimeSettings] = await Promise.all([
    (async (): Promise<string | undefined> => {
      if (!services.threadService) return undefined;
      try {
        const sessionThread =
          await services.threadService.resolveOwnedSessionThread(
            authenticatedUser,
            payload.sessionId,
          );
        return sessionThread.threadId;
      } catch (error) {
        log.warn("thread_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
    (async (): Promise<
      { env: ServerEnv; settings: WorkspaceSettings } | undefined
    > => {
      if (!services.settingsService || !services.viewerService)
        return undefined;
      try {
        await services.viewerService.ensureViewer(authenticatedUser);
        const [env, settings] = await Promise.all([
          services.settingsService.getEffectiveServerEnv(LOCAL_WORKSPACE_ID),
          services.settingsService.getWorkspaceSettings(
            authenticatedUser,
            LOCAL_WORKSPACE_ID,
          ),
        ]);
        return {
          env,
          settings,
        };
      } catch (error) {
        log.warn("model_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
  ]);
  const effectiveEnv = runtimeSettings?.env;
  const model = effectiveEnv?.agentModel;
  let resolvedAgentTarget:
    | { agentTargetId: string; providerId: AgentRuntimeProvider }
    | undefined;
  try {
    resolvedAgentTarget = await resolveRunAgentTargetIdentity(payload, model);
  } catch (error) {
    const expected = error instanceof AgentTargetResolutionError;
    if (!expected) {
      log.error("agent_target_resolve_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    sendCommandError(connectionManager, connectionId, {
      action: "agent.run",
      requestId: payload.clientRequestId,
      code: expected ? "agent_target_unavailable" : "internal_error",
      message: expected
        ? error.message
        : "Local agent target discovery failed.",
    });
    return;
  }
  if (!resolvedAgentTarget) {
    sendCommandError(connectionManager, connectionId, {
      action: "agent.run",
      requestId: payload.clientRequestId,
      code: "agent_target_unavailable",
      message: "A local agent target is required.",
    });
    return;
  }
  let resolvedModel: string | undefined;
  try {
    resolvedModel = resolveAgentRunModel({
      defaultModel: model,
      ...(payload.model ? { requestedModel: payload.model } : {}),
      runtimeKind: "local-agent",
      runtimeProvider: resolvedAgentTarget.providerId,
    });
  } catch (error) {
    if (error instanceof AgentRunModelResolutionError) {
      sendCommandError(connectionManager, connectionId, {
        action: "agent.run",
        requestId: payload.clientRequestId,
        code: error.code,
        message: error.message,
      });
      return;
    }
    throw error;
  }
  const runtimeEnv = effectiveEnv;
  const runtimeModel = resolvedModel;
  log.lap("resolve", { threadId: !!threadId, model: runtimeModel });
  if (runtimeEnv?.trustedLocalAgentMode === false) {
    sendCommandError(connectionManager, connectionId, {
      action: "agent.run",
      requestId: payload.clientRequestId,
      code: "local_agent_disabled",
      message: "Local agent runtime is disabled for this server.",
    });
    return;
  }

  let assistantMessageId: string | undefined;
  if (services.chatService) {
    try {
      const assistantMessage = await services.chatService.createMessage(
        authenticatedUser,
        payload.sessionId,
        {
          ...(payload.clientRequestId
            ? { clientRequestId: payload.clientRequestId }
            : {}),
          role: "assistant",
          content: "",
          contentBlocks: [],
        },
      );
      assistantMessageId = assistantMessage.id;
    } catch (error) {
      log.warn("assistant_anchor_create_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const response = agentRuns.createRun(payload, {
    ...(resolvedAgentTarget
      ? { agentTargetId: resolvedAgentTarget.agentTargetId }
      : {}),
    accessToken: authenticatedUser.accessToken,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    connectionId,
    ...(runtimeEnv ? { env: runtimeEnv } : {}),
    userId: authenticatedUser.id,
    ...(runtimeModel ? { model: runtimeModel } : {}),
    runtimeKind: "local-agent" as const,
    runtimeProvider: resolvedAgentTarget.providerId,
    ...(runtimeSettings?.settings.codexImagegenDelegation
      ? {
          codexImagegenDelegation:
            runtimeSettings.settings.codexImagegenDelegation,
        }
      : {}),
    ...(threadId ? { threadId } : {}),
  });
  assistantMessageId = response.assistantMessageId;
  const runId = response.runId;
  log.lap("run_created", { runId });

  // Bind this connection to the canvas so events route correctly
  const canvasId = payload.canvasId ?? payload.conversationId;
  connectionManager.bindCanvas(connectionId, canvasId);

  // Send ACK to the specific connection that initiated the run.
  // Retry with short delays if the connection is temporarily unavailable
  // (e.g., brief disconnect/reconnect during page transitions).
  const ackMessage = {
    type: "command.ack",
    action: "agent.run",
    requestId: payload.clientRequestId ?? runId,
    payload: {
      ...response,
      ...(assistantMessageId ? { assistantMessageId } : {}),
    },
  };
  if (!response.reused) {
    connectionManager.setActiveRun(
      canvasId,
      runId,
      payload.sessionId,
      assistantMessageId,
      response.runtimeKind,
      response.runtimeProvider,
      response.agentTargetId,
    );
  }

  let ackSent = connectionManager.sendTo(connectionId, ackMessage);
  if (!ackSent) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ackSent = connectionManager.sendTo(connectionId, ackMessage);
      if (ackSent) break;
    }
  }
  log.lap("ack_sent", { runId, connectionId, delivered: ackSent });

  if (response.reused) {
    log.lap("run_reused", { runId, connectionId });
    return;
  }

  const keepAlive = setInterval(() => {
    connectionManager.sendTo(connectionId, { type: "keep-alive" });
  }, 15_000);

  // Accumulate assistant content blocks for server-side persistence
  const orchestrator =
    services.agentRunOrchestrator ??
    createAgentRunOrchestrator({
      eventPersistence: services.agentRunPersistence,
    });
  const assistantProjection = orchestrator.createAssistantProjection({
    locale: payload.locale,
  });
  const publishEvent = (input: {
    envelope: { eventId?: string; seq?: number };
    event: StreamEvent;
  }) => {
    services.eventBuffer?.push(canvasId, input.event, input.envelope);
    connectionManager.pushToCanvas(canvasId, input.event, input.envelope);
  };
  const chatService = services.chatService;
  const assistantId = assistantMessageId;
  const updateAssistant =
    chatService && assistantId
      ? async () => {
          try {
            await chatService.updateMessage(authenticatedUser, assistantId, {
              role: "assistant",
              content: assistantProjection.textParts.join(""),
              contentBlocks: assistantProjection.blocks,
            });
          } catch (error) {
            log.warn("assistant_message_update_failed", {
              error: error instanceof Error ? error.message : String(error),
              runId,
            });
          }
        }
      : undefined;

  try {
    let firstEvent = true;
    for await (const event of agentRuns.streamRun(runId)) {
      if (firstEvent) {
        log.lap("first_token", { runId });
        firstEvent = false;
      }

      await orchestrator.handleStreamEvent({
        canvasId,
        event,
        project: assistantProjection,
        publish: publishEvent,
        runId,
        ...(updateAssistant ? { updateAssistant } : {}),
      });
    }
    log.lap("stream_done", { runId });
  } catch (error) {
    log.error("stream_error", {
      runId,
      error: error instanceof Error ? error.message : "unknown",
    });
    const failedEvent = {
      type: "run.failed" as const,
      runId,
      error: {
        code: "run_failed" as const,
        message: error instanceof Error ? error.message : "Stream failed",
      },
      timestamp: new Date().toISOString(),
    };
    await orchestrator.handleStreamEvent({
      canvasId,
      event: failedEvent,
      project: assistantProjection,
      publish: publishEvent,
      runId,
      ...(updateAssistant ? { updateAssistant } : {}),
    });
  } finally {
    clearInterval(keepAlive);
    connectionManager.clearActiveRun(canvasId, runId);
  }
}

async function handleCancelCommand(
  runId: string,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
  socket: WebSocket,
) {
  const cancelResult = agentRuns.cancelRun(runId);
  if (!cancelResult) {
    socket.send(
      JSON.stringify({
        type: "command.error",
        action: "agent.cancel",
        requestId: runId,
        code: "run_not_found",
        message: `Run not found: ${runId}`,
      }),
    );
    return;
  }

  const activeRun = connectionManager.getActiveRunById(runId);
  if (!activeRun) {
    return;
  }

  const orchestrator =
    services.agentRunOrchestrator ??
    createAgentRunOrchestrator({
      eventPersistence: services.agentRunPersistence,
    });

  await orchestrator.emitTerminalCancel({
    canvasId: activeRun.canvasId,
    publish({ event, envelope }) {
      services.eventBuffer?.push(activeRun.canvasId, event, envelope);
      connectionManager.pushToCanvas(activeRun.canvasId, event, envelope);
    },
    runId,
  });
  connectionManager.clearActiveRun(activeRun.canvasId, runId);
}

export async function resolveRunAgentTargetIdentity(
  payload: Pick<
    RunCreateRequest,
    "agentTargetId" | "model" | "runtimeProvider"
  >,
  defaultModel?: string,
  resolver: typeof resolveAgentTarget = resolveAgentTarget,
) {
  const modelProvider = getLocalAgentModelProvider(
    payload.model ?? defaultModel,
  );
  return await resolver({
    ...(payload.agentTargetId ? { agentTargetId: payload.agentTargetId } : {}),
    ...(payload.runtimeProvider
      ? { providerId: payload.runtimeProvider }
      : !payload.agentTargetId && modelProvider
        ? { providerId: modelProvider }
        : {}),
  });
}

function sendCommandError(
  connectionManager: ConnectionManager,
  connectionId: string,
  error: {
    action: string;
    requestId: string | undefined;
    code: string;
    message: string;
  },
) {
  connectionManager.sendTo(connectionId, {
    type: "command.error",
    ...error,
  });
}
