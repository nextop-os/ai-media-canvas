import { describe, expect, it } from "vitest";

import {
  AgentRunModelResolutionError,
  createAgentRunOrchestrator,
  createAssistantMessageProjection,
  createRuntimeControlPlane,
  getLocalAgentModelProvider,
  inferAimcRuntimeTarget,
  inferRuntimeKind,
  projectStreamEventToAssistantMessage,
  resolveAgentRunModel,
  resolveResumeMode,
} from "./run-orchestrator.js";

function createRuntimeProvider(runtime: {
  id: string;
  kind: "local-agent";
  provider?: "claude-code" | "codex";
  mode: "server" | "local";
  status?: "online" | "offline" | "degraded";
  maxConcurrentRuns?: number;
}) {
  return {
    runtime: {
      capabilities: {
        cancel: true,
        nativeResume: runtime.kind === "local-agent",
        streaming: true,
        toolGateway: runtime.kind === "local-agent",
        maxConcurrentRuns: runtime.maxConcurrentRuns ?? 1,
      },
      lastSeenAt: "2026-06-04T00:00:00.000Z",
      status: runtime.status ?? "online",
      ...runtime,
    },
    async *streamRun() {
      yield {
        type: "run.completed" as const,
        runId: "run-1",
        timestamp: "2026-06-04T00:00:00.000Z",
      };
    },
  };
}

describe("agent run orchestrator", () => {
  it("records run state, persists stream events, and projects assistant state", () => {
    const persisted: Array<{ type: string; runId: string; canvasId?: string }> =
      [];
    const runStoreCalls: Array<Record<string, unknown>> = [];
    const orchestrator = createAgentRunOrchestrator({
      eventPersistence: {
        appendEvent(input) {
          persisted.push({
            type: input.event.type,
            runId: input.runId,
            ...(input.canvasId ? { canvasId: input.canvasId } : {}),
          });
          return {
            eventId: `${input.runId}:${persisted.length}`,
            seq: persisted.length,
            canvasSeq: 40 + persisted.length,
          };
        },
      },
      runStore: {
        createRun(input) {
          runStoreCalls.push({ action: "create", ...input });
        },
        updateRun(input) {
          runStoreCalls.push({ action: "update", ...input });
        },
      },
    });
    const projection = orchestrator.createAssistantProjection();
    const event = {
      type: "tool.completed" as const,
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "generate_image",
      output: { imageUrl: "https://example.com/a.png" },
      artifacts: [
        {
          type: "image" as const,
          url: "https://example.com/a.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
        },
      ],
      timestamp: "2026-06-04T00:00:00.000Z",
    };

    const envelope = orchestrator.persistAndEnvelope({
      canvasId: "canvas_1",
      event,
      runId: "run_1",
    });
    orchestrator.projectEvent(projection, event);
    orchestrator.recordAcceptedRun({
      assistantMessageId: "msg_1",
      canvasId: "canvas_1",
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
      runId: "run_1",
      sessionId: "session_1",
    });
    orchestrator.updateRunStatus({
      runId: "run_1",
      status: "completed",
    });

    expect(envelope).toEqual({ eventId: "run_1:1", seq: 41 });
    expect(persisted).toEqual([
      { canvasId: "canvas_1", runId: "run_1", type: "tool.completed" },
    ]);
    expect(projection.blocks).toEqual([
      {
        type: "tool",
        toolCallId: "tool_1",
        toolName: "generate_image",
        status: "completed",
        output: { imageUrl: "https://example.com/a.png" },
        artifacts: [
          {
            type: "image",
            url: "https://example.com/a.png",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    ]);
    expect(runStoreCalls).toEqual([
      {
        action: "create",
        assistantMessageId: "msg_1",
        canvasId: "canvas_1",
        model: "codex:gpt-5.4",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        runId: "run_1",
        sessionId: "session_1",
      },
      {
        action: "update",
        runId: "run_1",
        status: "completed",
      },
    ]);
  });

  it("owns stream event persistence, projection, publish, and assistant update", async () => {
    const persisted: Array<{ type: string; runId: string; canvasId?: string }> =
      [];
    const published: Array<{
      event: { type: string };
      envelope: { eventId?: string; seq?: number };
    }> = [];
    const assistantUpdates: Array<{ text: string; blocks: unknown[] }> = [];
    const orchestrator = createAgentRunOrchestrator({
      eventPersistence: {
        appendEvent(input) {
          persisted.push({
            type: input.event.type,
            runId: input.runId,
            ...(input.canvasId ? { canvasId: input.canvasId } : {}),
          });
          return {
            eventId: `${input.runId}:${persisted.length}`,
            seq: persisted.length,
            canvasSeq: 100 + persisted.length,
          };
        },
      },
    });
    const projection = orchestrator.createAssistantProjection();

    const envelope = await orchestrator.handleStreamEvent({
      canvasId: "canvas_1",
      event: {
        type: "message.delta",
        runId: "run_1",
        messageId: "msg_1",
        delta: "hello",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
      project: projection,
      publish(input) {
        published.push(input);
      },
      runId: "run_1",
      updateAssistant(state) {
        assistantUpdates.push({
          text: state.textParts.join(""),
          blocks: state.blocks,
        });
      },
    });

    expect(envelope).toEqual({ eventId: "run_1:1", seq: 101 });
    expect(persisted).toEqual([
      { canvasId: "canvas_1", runId: "run_1", type: "message.delta" },
    ]);
    expect(published).toEqual([
      {
        event: expect.objectContaining({ type: "message.delta" }),
        envelope: { eventId: "run_1:1", seq: 101 },
      },
    ]);
    expect(assistantUpdates).toEqual([
      {
        text: "hello",
        blocks: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("emits a durable terminal cancel event", async () => {
    const persisted: string[] = [];
    const runStoreCalls: Array<Record<string, unknown>> = [];
    const orchestrator = createAgentRunOrchestrator({
      eventPersistence: {
        appendEvent(input) {
          persisted.push(input.event.type);
          return {
            eventId: `${input.runId}:${persisted.length}`,
            seq: persisted.length,
          };
        },
      },
      runStore: {
        createRun() {},
        updateRun(input) {
          runStoreCalls.push(input);
        },
      },
    });

    const result = await orchestrator.emitTerminalCancel({
      now: () => "2026-06-04T00:00:00.000Z",
      runId: "run_1",
    });

    expect(result).toEqual({
      envelope: { eventId: "run_1:1" },
      event: {
        type: "run.canceled",
        runId: "run_1",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });
    expect(persisted).toEqual(["run.canceled"]);
    expect(runStoreCalls).toEqual([{ runId: "run_1", status: "canceled" }]);
  });

  it("does not publish or project duplicate events after a terminal event", async () => {
    const projection = createAssistantMessageProjection();
    const published: unknown[] = [];
    const assistantUpdates: unknown[] = [];
    const runStoreCalls: Array<Record<string, unknown>> = [];
    const orchestrator = createAgentRunOrchestrator({
      eventPersistence: {
        appendEvent() {
          return {
            duplicate: true,
            eventId: "run_1:3",
            seq: 3,
          };
        },
      },
      runStore: {
        createRun() {},
        updateRun(input) {
          runStoreCalls.push(input);
        },
      },
    });

    const envelope = await orchestrator.handleStreamEvent({
      event: {
        type: "run.completed",
        runId: "run_1",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
      project: projection,
      publish(input) {
        published.push(input);
      },
      runId: "run_1",
      updateAssistant(state) {
        assistantUpdates.push(state);
      },
    });

    expect(envelope).toEqual({ duplicate: true, eventId: "run_1:3" });
    expect(published).toEqual([]);
    expect(assistantUpdates).toEqual([]);
    expect(projection.textParts).toEqual([]);
    expect(runStoreCalls).toEqual([]);
  });

  it("projects text and media tool events into assistant message blocks", () => {
    const projection = createAssistantMessageProjection();

    projectStreamEventToAssistantMessage(projection, {
      type: "message.delta",
      runId: "run_1",
      messageId: "msg_1",
      delta: "hello",
      timestamp: "2026-06-04T00:00:00.000Z",
    });
    projectStreamEventToAssistantMessage(projection, {
      type: "tool.started",
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "generate_image",
      input: { prompt: "poster" },
      timestamp: "2026-06-04T00:00:01.000Z",
    });
    projectStreamEventToAssistantMessage(projection, {
      type: "tool.completed",
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "generate_image",
      output: { imageUrl: "https://example.com/a.png" },
      artifacts: [
        {
          type: "image",
          url: "https://example.com/a.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
        },
      ],
      timestamp: "2026-06-04T00:00:02.000Z",
    });

    expect(projection.textParts.join("")).toBe("hello");
    expect(projection.blocks).toEqual([
      { type: "text", text: "hello" },
      {
        type: "tool",
        toolCallId: "tool_1",
        toolName: "generate_image",
        status: "completed",
        input: { prompt: "poster" },
        output: { imageUrl: "https://example.com/a.png" },
        artifacts: [
          {
            type: "image",
            url: "https://example.com/a.png",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
      },
    ]);
  });

  it("projects run failures in the active locale", () => {
    const projection = createAssistantMessageProjection({ locale: "en" });

    projectStreamEventToAssistantMessage(projection, {
      type: "run.failed",
      runId: "run_1",
      error: { code: "run_failed", message: "model unavailable" },
      timestamp: "2026-06-04T00:00:03.000Z",
    });

    expect(projection.textParts).toEqual([
      "Sorry, something went wrong while processing: model unavailable",
    ]);
    expect(projection.blocks).toEqual([
      {
        type: "text",
        text: "Sorry, something went wrong while processing: model unavailable",
      },
    ]);
  });

  it("resolves provider-local and handoff resume modes", () => {
    expect(
      resolveResumeMode({
        previousRuntimeKind: "local-agent",
        previousRuntimeProvider: "codex",
        previousAgentTargetId: "team:designer",
        nextRuntimeKind: "local-agent",
        nextRuntimeProvider: "codex",
        nextAgentTargetId: "team:designer",
      }),
    ).toBe("provider-local");

    expect(
      resolveResumeMode({
        previousRuntimeKind: "local-agent",
        previousRuntimeProvider: "codex",
        nextRuntimeKind: "local-agent",
        nextRuntimeProvider: "claude-code",
      }),
    ).toBe("handoff");

    expect(
      resolveResumeMode({
        previousRuntimeKind: "local-agent",
        previousRuntimeProvider: "codex",
        previousAgentTargetId: "team:designer",
        nextRuntimeKind: "local-agent",
        nextRuntimeProvider: "codex",
        nextAgentTargetId: "team:reviewer",
      }),
    ).toBe("handoff");
  });

  it("extracts only registered local-agent model providers", () => {
    expect(getLocalAgentModelProvider("codex:gpt-5.4")).toBe("codex");
    expect(getLocalAgentModelProvider("openai:gpt-5.4")).toBeUndefined();
  });

  it("selects the first local runtime when no model provider is specified", () => {
    expect(
      inferAimcRuntimeTarget({
        availableRuntimeTargets: [{ kind: "local-agent", provider: "codex" }],
        model: "gpt-4.1",
        requestedRuntimeKind: undefined,
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("selects a local runtime when the model prefix matches a local provider", () => {
    expect(
      inferAimcRuntimeTarget({
        availableRuntimeTargets: [
          { kind: "local-agent", provider: "codex" },
          { kind: "local-agent", provider: "claude-code" },
        ],
        model: "codex:gpt-5.4",
        requestedRuntimeKind: undefined,
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("uses the local provider default model for local-agent runs without a requested model", () => {
    expect(
      resolveAgentRunModel({
        defaultModel: "agnes:agnes-2.0-flash",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      }),
    ).toBe("codex:default");
  });

  it("rejects a server model when a local provider is requested", () => {
    expect(() =>
      resolveAgentRunModel({
        requestedModel: "agnes:agnes-2.0-flash",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      }),
    ).toThrow(AgentRunModelResolutionError);
  });

  it("fills the only local provider when a legacy request omits it", () => {
    expect(
      inferAimcRuntimeTarget({
        availableRuntimeTargets: [{ kind: "local-agent", provider: "codex" }],
        model: "codex:gpt-5.4",
        requestedRuntimeKind: "local-agent",
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("defaults to the single registered runtime when no selector is provided", () => {
    const controlPlane = createRuntimeControlPlane([
      createRuntimeProvider({
        id: "local-agent:codex",
        kind: "local-agent",
        mode: "local",
        provider: "codex",
      }),
    ]);

    expect(
      controlPlane.resolveRuntimeTarget({
        model: "codex:gpt-5.4",
        requestedRuntimeKind: undefined,
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("throws when multiple runtimes are registered without a selector", () => {
    const controlPlane = createRuntimeControlPlane([
      createRuntimeProvider({
        id: "local-agent:codex",
        kind: "local-agent",
        mode: "local",
        provider: "codex",
      }),
      createRuntimeProvider({
        id: "local-agent:claude-code",
        kind: "local-agent",
        mode: "local",
        provider: "claude-code",
      }),
    ]);

    expect(() =>
      controlPlane.resolveRuntimeTarget({
        model: "codex:gpt-5.4",
        requestedRuntimeKind: undefined,
      }),
    ).toThrow("No runtime kind requested and no selector configured");
  });

  it("returns the requested runtime kind before applying fallback inference", () => {
    expect(
      inferRuntimeKind({
        availableRuntimeTargets: [{ kind: "local-agent", provider: "codex" }],
        model: "codex:gpt-5.4",
        requestedRuntimeKind: "local-agent",
        requestedRuntimeProvider: "codex",
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("does not schedule offline runtimes", () => {
    const controlPlane = createRuntimeControlPlane([
      createRuntimeProvider({
        id: "local-agent:codex",
        kind: "local-agent",
        mode: "local",
        provider: "codex",
        status: "offline",
      }),
    ]);

    expect(controlPlane.listRuntimeTargets()).toEqual([]);
    expect(() =>
      controlPlane.resolveRuntimeTarget({
        model: "codex:gpt-5.4",
        requestedRuntimeKind: "local-agent",
        requestedRuntimeProvider: "codex",
      }),
    ).toThrow("Runtime local-agent (codex) is offline");
  });

  it("enforces runtime concurrency through leases", () => {
    const controlPlane = createRuntimeControlPlane([
      createRuntimeProvider({
        id: "local-agent:codex",
        kind: "local-agent",
        mode: "local",
        provider: "codex",
        maxConcurrentRuns: 1,
      }),
    ]);

    const lease = controlPlane.acquireRuntimeLease(
      { kind: "local-agent", provider: "codex" },
      "run-1",
    );

    expect(() =>
      controlPlane.acquireRuntimeLease(
        { kind: "local-agent", provider: "codex" },
        "run-2",
      ),
    ).toThrow("Runtime local-agent (codex) is at capacity");

    lease.release();

    expect(() =>
      controlPlane.acquireRuntimeLease(
        { kind: "local-agent", provider: "codex" },
        "run-2",
      ),
    ).not.toThrow();
  });

  it("updates runtime health metadata", () => {
    const controlPlane = createRuntimeControlPlane(
      [
        createRuntimeProvider({
          id: "local-agent:codex",
          kind: "local-agent",
          mode: "local",
          provider: "codex",
        }),
      ],
      {
        now: () => "2026-06-04T12:34:56.000Z",
      },
    );

    const runtime = controlPlane.updateRuntimeStatus(
      { kind: "local-agent", provider: "codex" },
      "degraded",
    );

    expect(runtime.status).toBe("degraded");
    expect(runtime.lastSeenAt).toBe("2026-06-04T12:34:56.000Z");
  });
});
