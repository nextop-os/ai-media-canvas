"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RunCreateRequest,
  StreamEvent,
  WsCommandAck,
  WsCommandError,
  WsRpcRequest,
} from "@aimc/shared";
import { wsRpcRequestSchema, wsServerMessageSchema } from "@aimc/shared";
import { getServerBaseUrl } from "../lib/env";

export type StreamEventEnvelope = {
  event: StreamEvent;
  eventId?: string;
  replayed?: boolean;
  seq?: number;
};

type EventCallback = (event: StreamEventEnvelope) => void;
type RPCHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const LOCAL_AGENT_ACCESS_TOKEN = "standalone-local-access-token";
const RECONNECT_DELAY_MS = 1_000;

export type WebSocketHandle = {
  connected: boolean;
  startRun: (
    payload: RunCreateRequest,
    onAck?: (ack: WsCommandAck) => void,
    onError?: (error: WsCommandError) => void,
  ) => () => void;
  cancelRun: (runId: string) => void;
  onEvent: (cb: EventCallback) => () => void;
  registerRPC: (method: string, handler: RPCHandler) => () => void;
  resumeCanvas: (
    canvasId: string,
    sessionId: string,
    onAck?: (ack: WsCommandAck) => void,
  ) => void;
};

function createConnectionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `standalone-connection-${Date.now()}`;
}

function getSocketUrl() {
  const serverBaseUrl = getServerBaseUrl();
  const url = new URL("/api/ws", serverBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export function useWebSocket(): WebSocketHandle {
  const [connected, setConnected] = useState(false);
  const connectionIdRef = useRef(createConnectionId());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const activeCanvasIdRef = useRef<string | null>(null);
  const lastSeqByCanvasRef = useRef<Map<string, number>>(new Map());
  const seenEventIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const eventListeners = useRef<Set<EventCallback>>(new Set());
  const rpcHandlers = useRef<Map<string, RPCHandler>>(new Map());
  const ackListeners = useRef<Map<string, Array<(ack: WsCommandAck) => void>>>(
    new Map(),
  );
  const pendingRunCommands = useRef<
    Map<
      string,
      {
        onAck?: (ack: WsCommandAck) => void;
        onError?: (error: WsCommandError) => void;
      }
    >
  >(new Map());

  const emitEvent = useCallback((event: StreamEventEnvelope) => {
    for (const listener of eventListeners.current) {
      listener(event);
    }
  }, []);

  const resolveAck = useCallback((ack: WsCommandAck) => {
    if (ack.action === "agent.run") {
      const payloadRunId = ack.payload.runId;
      const requestId =
        ack.requestId ??
        (typeof payloadRunId === "string" ? payloadRunId : undefined);
      if (!requestId) return;
      const pending = pendingRunCommands.current.get(requestId);
      if (!pending) return;
      pendingRunCommands.current.delete(requestId);
      pending.onAck?.(ack);
      return;
    }
    const listeners = ackListeners.current.get(ack.action);
    const handler = listeners?.shift();
    if (!handler) {
      return;
    }
    if (!listeners || listeners.length === 0) {
      ackListeners.current.delete(ack.action);
    }
    handler(ack);
  }, []);

  const resolveCommandError = useCallback((error: WsCommandError) => {
    if (error.action !== "agent.run" || !error.requestId) return;
    const pending = pendingRunCommands.current.get(error.requestId);
    if (!pending) return;
    pendingRunCommands.current.delete(error.requestId);
    pending.onError?.(error);
  }, []);

  const settlePendingRuns = useCallback((code: string, message: string) => {
    const pendingEntries = [...pendingRunCommands.current.entries()];
    pendingRunCommands.current.clear();
    for (const [requestId, pending] of pendingEntries) {
      pending.onError?.({
        type: "command.error",
        action: "agent.run",
        requestId,
        code,
        message,
      });
    }
  }, []);

  const sendJson = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const handleRpcRequest = useCallback(
    async (message: WsRpcRequest) => {
      const handler = rpcHandlers.current.get(message.method);
      if (!handler) {
        sendJson({
          type: "rpc.response",
          id: message.id,
          error: `No RPC handler registered for ${message.method}`,
        });
        return;
      }

      try {
        const result = await handler(message.params);
        sendJson({
          type: "rpc.response",
          id: message.id,
          result,
        });
      } catch (error) {
        sendJson({
          type: "rpc.response",
          id: message.id,
          error: error instanceof Error ? error.message : "RPC handler failed.",
        });
      }
    },
    [sendJson],
  );

  useEffect(() => {
    shouldReconnectRef.current = true;

    const connect = () => {
      const url = getSocketUrl();
      url.searchParams.set("token", LOCAL_AGENT_ACCESS_TOKEN);
      url.searchParams.set("connectionId", connectionIdRef.current);

      const socket = new WebSocket(url.toString());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) {
          socket.close();
          return;
        }
        setConnected(true);
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { type?: string }).type === "keep-alive"
        ) {
          return;
        }

        const rpcRequest = wsRpcRequestSchema.safeParse(parsed);
        if (rpcRequest.success) {
          void handleRpcRequest(rpcRequest.data);
          return;
        }

        const serverMessage = wsServerMessageSchema.safeParse(parsed);
        if (!serverMessage.success) {
          return;
        }

        if (serverMessage.data.type === "event") {
          const activeCanvasId = activeCanvasIdRef.current;
          if (
            activeCanvasId &&
            typeof serverMessage.data.eventId === "string"
          ) {
            const seenForCanvas =
              seenEventIdsRef.current.get(activeCanvasId) ?? new Set<string>();
            if (seenForCanvas.has(serverMessage.data.eventId)) {
              return;
            }
            seenForCanvas.add(serverMessage.data.eventId);
            seenEventIdsRef.current.set(activeCanvasId, seenForCanvas);
          }
          if (activeCanvasId) {
            const nextSeq =
              typeof serverMessage.data.seq === "number"
                ? Math.max(
                    serverMessage.data.seq,
                    lastSeqByCanvasRef.current.get(activeCanvasId) ?? 0,
                  )
                : (lastSeqByCanvasRef.current.get(activeCanvasId) ?? 0) + 1;
            lastSeqByCanvasRef.current.set(activeCanvasId, nextSeq);
          }
          emitEvent({
            event: serverMessage.data.event,
            ...(typeof serverMessage.data.eventId === "string"
              ? { eventId: serverMessage.data.eventId }
              : {}),
            ...((serverMessage.data as { replayed?: boolean }).replayed === true
              ? { replayed: true }
              : {}),
            ...(typeof serverMessage.data.seq === "number"
              ? { seq: serverMessage.data.seq }
              : {}),
          });
          return;
        }

        if (serverMessage.data.type === "command.ack") {
          if (serverMessage.data.action === "canvas.resume") {
            const payload = serverMessage.data.payload as Record<
              string,
              unknown
            >;
            const canvasId =
              typeof payload.canvasId === "string" ? payload.canvasId : null;
            if (canvasId) {
              activeCanvasIdRef.current = canvasId;
            }
          }
          resolveAck(serverMessage.data);
          return;
        }

        if (serverMessage.data.type === "command.error") {
          resolveCommandError(serverMessage.data);
        }
      });

      socket.addEventListener("close", () => {
        settlePendingRuns(
          "acceptance_status_unknown",
          "Connection closed before the server confirmed run acceptance.",
        );
        if (socketRef.current === socket) {
          socketRef.current = null;
          setConnected(false);
        }
        if (!shouldReconnectRef.current) {
          return;
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, RECONNECT_DELAY_MS);
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      settlePendingRuns(
        "client_disposed",
        "The client closed before the server confirmed run acceptance.",
      );
      socket?.close();
      setConnected(false);
    };
  }, [
    emitEvent,
    handleRpcRequest,
    resolveAck,
    resolveCommandError,
    settlePendingRuns,
  ]);

  const onEvent = useCallback((cb: EventCallback) => {
    eventListeners.current.add(cb);
    return () => {
      eventListeners.current.delete(cb);
    };
  }, []);

  const registerRPC = useCallback((method: string, handler: RPCHandler) => {
    rpcHandlers.current.set(method, handler);
    return () => {
      rpcHandlers.current.delete(method);
    };
  }, []);

  const enqueueAck = useCallback(
    (action: string, handler?: (ack: WsCommandAck) => void) => {
      if (!handler) {
        return () => {};
      }
      const queue = ackListeners.current.get(action) ?? [];
      queue.push(handler);
      ackListeners.current.set(action, queue);
      return () => {
        const listeners = ackListeners.current.get(action);
        if (!listeners) {
          return;
        }
        const index = listeners.lastIndexOf(handler);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
          ackListeners.current.delete(action);
        }
      };
    },
    [],
  );

  const startRun = useCallback(
    (
      payload: RunCreateRequest,
      onAck?: (ack: WsCommandAck) => void,
      onError?: (error: WsCommandError) => void,
    ) => {
      const requestId =
        payload.clientRequestId ??
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `run-request-${Date.now()}`);
      activeCanvasIdRef.current = payload.canvasId ?? payload.conversationId;
      pendingRunCommands.current.set(requestId, {
        ...(onAck ? { onAck } : {}),
        ...(onError ? { onError } : {}),
      });
      const removePending = () => {
        const pending = pendingRunCommands.current.get(requestId);
        if (!pending) return;
        pendingRunCommands.current.delete(requestId);
      };
      const sent = sendJson({
        type: "command",
        action: "agent.run",
        payload: { ...payload, clientRequestId: requestId },
      });
      if (!sent) {
        removePending();
        onError?.({
          type: "command.error",
          action: "agent.run",
          requestId,
          code: "connection_not_ready",
          message: "WebSocket connection is not ready.",
        });
        emitEvent({
          event: {
            type: "run.failed",
            runId: requestId,
            error: {
              code: "run_failed",
              message: "WebSocket connection is not ready.",
            },
            timestamp: new Date().toISOString(),
          },
        });
      }
      return removePending;
    },
    [emitEvent, sendJson],
  );

  const cancelRun = useCallback(
    (runId: string) => {
      sendJson({
        type: "command",
        action: "agent.cancel",
        payload: { runId },
      });
    },
    [sendJson],
  );

  const resumeCanvas = useCallback(
    (
      canvasId: string,
      sessionId: string,
      onAck?: (ack: WsCommandAck) => void,
    ) => {
      activeCanvasIdRef.current = canvasId;
      const removeAck = enqueueAck("canvas.resume", onAck);
      const sent = sendJson({
        type: "command",
        action: "canvas.resume",
        payload: {
          canvasId,
          sessionId,
          lastSeq: lastSeqByCanvasRef.current.get(canvasId) ?? 0,
          skipReplay: false,
        },
      });
      if (!sent) {
        removeAck();
      }
    },
    [enqueueAck, sendJson],
  );

  return {
    connected,
    startRun,
    cancelRun,
    onEvent,
    registerRPC,
    resumeCanvas,
  };
}
