// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "@aimc/shared";

import { useWebSocket } from "../src/hooks/use-websocket";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  url: string;
  private listeners = new Map<string, Set<(event?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: unknown) {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  receive(message: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

describe("useWebSocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.clearAllMocks();
    vi.stubEnv("AIMC_SERVER_BASE_URL", "http://localhost:3001");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("run-fixed");
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  it("connects to /api/ws and streams server events from websocket messages", async () => {
    const { result } = renderHook(() => useWebSocket());
    const socket = MockWebSocket.instances[0];
    expect(socket?.url).toContain("ws://localhost:3001/api/ws");
    expect(socket?.url).toContain("token=standalone-local-access-token");
    expect(socket?.url).toContain("connectionId=run-fixed");

    act(() => {
      socket.open();
    });

    await waitFor(() => expect(result.current.connected).toBe(true));

    const seen: StreamEvent[] = [];
    result.current.onEvent((event) => {
      seen.push(event.event);
    });

    act(() => {
      result.current.startRun(
        {
          sessionId: "session-1",
          conversationId: "canvas-1",
          prompt: "hello",
        },
        () => {},
      );
    });

    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "command",
      action: "agent.run",
      payload: {
        clientRequestId: "run-fixed",
        sessionId: "session-1",
        conversationId: "canvas-1",
        prompt: "hello",
      },
    });

    act(() => {
      socket.receive({
        type: "command.ack",
        action: "agent.run",
        requestId: "run-fixed",
        payload: {
          conversationId: "canvas-1",
          runId: "run-fixed",
          sessionId: "session-1",
          status: "accepted",
        },
      });
      socket.receive({
        type: "event",
        seq: 7,
        event: {
          type: "message.delta",
          runId: "run-fixed",
          messageId: "assistant-message-run-fixed",
          delta: "Agnes says hi",
          timestamp: new Date().toISOString(),
        },
      });
      socket.receive({
        type: "event",
        event: {
          type: "run.completed",
          runId: "run-fixed",
          timestamp: new Date().toISOString(),
        },
      });
    });

    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.delta",
          delta: "Agnes says hi",
        }),
        expect.objectContaining({
          type: "run.completed",
          runId: "run-fixed",
        }),
      ]),
    );
  });

  it("correlates concurrent run acknowledgements and ignores late responses after cleanup", async () => {
    const { result } = renderHook(() => useWebSocket());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const acknowledgements: string[] = [];
    let cleanupFirst = () => {};
    act(() => {
      cleanupFirst = result.current.startRun(
        {
          clientRequestId: "request-a",
          sessionId: "session-1",
          conversationId: "canvas-1",
          prompt: "first",
        },
        () => acknowledgements.push("a"),
      );
      result.current.startRun(
        {
          clientRequestId: "request-b",
          sessionId: "session-1",
          conversationId: "canvas-1",
          prompt: "second",
        },
        () => acknowledgements.push("b"),
      );
    });

    act(() => {
      socket.receive({
        type: "command.ack",
        action: "agent.run",
        requestId: "request-b",
        payload: { runId: "request-b" },
      });
      cleanupFirst();
      socket.receive({
        type: "command.ack",
        action: "agent.run",
        requestId: "request-a",
        payload: { runId: "request-a" },
      });
    });

    expect(acknowledgements).toEqual(["b"]);
  });

  it("keeps the shared connection open while a run acknowledgement is pending", async () => {
    const { result } = renderHook(() => useWebSocket());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.connected).toBe(true));

    vi.useFakeTimers();
    try {
      const acknowledgements: string[] = [];
      const errors: string[] = [];
      act(() => {
        result.current.startRun(
          {
            clientRequestId: "request-slow",
            sessionId: "session-1",
            conversationId: "canvas-1",
            prompt: "slow preparation",
          },
          () => acknowledgements.push("slow"),
          (error) => errors.push(error.code),
        );
        vi.advanceTimersByTime(60_000);
      });

      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(errors).toEqual([]);

      act(() => {
        socket.receive({
          type: "command.ack",
          action: "agent.run",
          requestId: "request-slow",
          payload: { runId: "request-slow" },
        });
      });
      expect(acknowledgements).toEqual(["slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles pending run commands when the connection closes before acknowledgement", async () => {
    const { result } = renderHook(() => useWebSocket());
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const errors: Array<{ code: string; requestId?: string }> = [];
    act(() => {
      result.current.startRun(
        {
          clientRequestId: "request-disconnected",
          sessionId: "session-1",
          conversationId: "canvas-1",
          prompt: "hello",
        },
        undefined,
        (error) => errors.push(error),
      );
      socket.close();
    });

    expect(errors).toEqual([
      expect.objectContaining({
        code: "acceptance_status_unknown",
        requestId: "request-disconnected",
      }),
    ]);
  });

  it("resumes canvases from the latest consumed sequence instead of the ack watermark", async () => {
    const { result } = renderHook(() => useWebSocket());
    const socket = MockWebSocket.instances[0];

    act(() => {
      socket.open();
    });

    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      result.current.resumeCanvas("canvas-1", "session-1", () => {});
    });

    expect(socket.sent).toContain(
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: {
          canvasId: "canvas-1",
          sessionId: "session-1",
          lastSeq: 0,
          skipReplay: false,
        },
      }),
    );

    act(() => {
      socket.receive({
        type: "command.ack",
        action: "canvas.resume",
        payload: {
          canvasId: "canvas-1",
          latestSeq: 2,
          activeRunId: "run-fixed",
          replayed: 0,
          skipReplay: false,
        },
      });
    });

    act(() => {
      result.current.resumeCanvas("canvas-1", "session-1", () => {});
    });

    expect(socket.sent).toContain(
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: {
          canvasId: "canvas-1",
          sessionId: "session-1",
          lastSeq: 0,
          skipReplay: false,
        },
      }),
    );

    act(() => {
      socket.receive({
        type: "event",
        seq: 7,
        event: {
          type: "message.delta",
          runId: "run-fixed",
          messageId: "assistant-message-run-fixed",
          delta: "hello",
          timestamp: new Date().toISOString(),
        },
      });
    });

    act(() => {
      result.current.resumeCanvas("canvas-1", "session-1", () => {});
    });

    expect(socket.sent).toContain(
      JSON.stringify({
        type: "command",
        action: "canvas.resume",
        payload: {
          canvasId: "canvas-1",
          sessionId: "session-1",
          lastSeq: 7,
          skipReplay: false,
        },
      }),
    );
  });
});
