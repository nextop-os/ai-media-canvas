import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { createAgentBackendMock } = vi.hoisted(() => ({
  createAgentBackendMock: vi.fn(() => ({ factory: { kind: "backend" } })),
}));

const { localAgentRuntimeRunMock } = vi.hoisted(() => ({
  localAgentRuntimeRunMock: vi.fn(async function* () {
    yield {
      type: "done" as const,
      reason: "completed" as const,
      exitCode: 0,
    };
  }),
}));

vi.mock("./backends/index.js", () => ({
  createAgentBackend: createAgentBackendMock,
}));

import {
  clearProviders,
  registerImageProvider,
} from "../generation/providers/registry.js";
import { createLocalStore } from "../local/store.js";
import { createLocalUserClient } from "../local/user-client.js";
import { buildAimcSystemPrompt } from "./prompts/aimc-main.js";
import {
  buildUserMessage,
  createAgentRunService,
  resolveBrandKitIdForRun,
} from "./runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  clearProviders();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createAgentRunService", () => {
  it("treats Brand Kit client construction failures as optional context", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      resolveBrandKitIdForRun({
        accessToken: "token",
        canvasId: "canvas-1",
        createUserClient: () => {
          throw new Error("client unavailable");
        },
      }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("drops unavailable image generation preference models from user context", () => {
    registerImageProvider({
      name: "codex-imagegen",
      models: [
        {
          id: "codex/gpt-image-2",
          displayName: "GPT Image 2",
          description: "Codex image generation",
        },
      ],
      async generate() {
        throw new Error("not used");
      },
    });

    const message = buildUserMessage("生成一张海报", [], {
      mode: "manual",
      models: ["black-forest-labs/flux-kontext-pro", "codex/gpt-image-2"],
    });

    expect(message.text).toContain("codex/gpt-image-2");
    expect(message.text).not.toContain("black-forest-labs/flux-kontext-pro");
    expect(message.text).toContain(
      '<human_image_generation_preference mode="manual" count="1">',
    );
  });

  it("adds image attachment dimensions to input image context when available", () => {
    const message = buildUserMessage(
      "根据图1生成另一张图",
      [
        {
          assetId: "asset-1",
          url: "http://127.0.0.1:3001/local-assets/asset-1",
          mimeType: "image/jpeg",
          name: "reference.jpg",
        },
      ],
      undefined,
      undefined,
      null,
      {
        "asset-1": {
          width: 1491,
          height: 1055,
          orientation: "landscape",
        },
      },
    );

    expect(message.text).toContain(
      '<image index="1" asset_id="asset-1" mime_type="image/jpeg" name="reference.jpg" width="1491" height="1055" orientation="landscape" />',
    );
  });

  it("rejects the removed server-deepagent runtime", () => {
    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "codex:gpt-5.4",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
    });

    expect(() =>
      runs.createRun(
        {
          canvasId: "canvas-1",
          conversationId: "canvas-1",
          prompt: "继续",
          sessionId: "session-1",
        },
        {
          model: "codex:gpt-5.4",
          runtimeKind: "server-deepagent" as never,
        },
      ),
    ).toThrow("No runtime provider registered for server-deepagent");
  });

  it("persists explicit local runtime kind when Codex is requested", async () => {
    localAgentRuntimeRunMock.mockClear();
    const updateRun = vi.fn();

    const runs = createAgentRunService({
      agentRunStore: {
        createRun: vi.fn(),
        updateRun,
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    expect(run).toMatchObject({
      agentTargetId: "local:codex",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
    });

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localAgentRuntimeRunMock).toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        status: "running",
      }),
    );
  });

  it("preserves the local CLI default model for the host adapter", async () => {
    vi.stubEnv("TUTTI_CLI", "");
    localAgentRuntimeRunMock.mockClear();
    const localAgentRuntimeDetectMock = vi.fn(async () => [
      {
        provider: "codex" as const,
        displayName: "Codex",
        supported: true as const,
        authState: "ok" as const,
        models: [
          { id: "default", label: "Default (CLI config)" },
          { id: "gpt-5.5", label: "gpt-5.5" },
        ],
      },
    ]);

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        detect: localAgentRuntimeDetectMock,
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "codex:default",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    // The App does not preflight discovery during execution. The real kit
    // runtime prepares composer options from agentTargetId inside run().
    expect(localAgentRuntimeDetectMock).not.toHaveBeenCalled();
    expect(localAgentRuntimeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "default",
        mcpServers: [
          expect.objectContaining({
            name: "aimc",
            startupTimeoutMs: 2 * 60_000,
            toolTimeoutMs: 30 * 60_000,
          }),
        ],
        provider: "codex",
        timeoutMs: 30 * 60_000,
      }),
    );
  });

  it("returns image jobs after inserting canvas generation nodes and polling", async () => {
    let capturedGatewaySession:
      | {
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<{
            error?: string;
            elementId?: string;
            imageUrl?: string;
            jobId: string;
            mimeType?: string;
            status?: "generating";
            width?: number;
            height?: number;
          }>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const getJobAdmin = vi.fn(async () => ({
      attempt_count: 0,
      max_attempts: 3,
      result: {
        asset_id: "asset-1",
        signed_url: "http://127.0.0.1:3001/local-assets/asset-1",
        object_path: "generated/asset-1.png",
        mime_type: "image/png",
        width: 1024,
        height: 1024,
      },
      status: "succeeded",
    }));
    const canvasState = {
      content: {
        elements: [] as Array<Record<string, unknown>>,
        appState: {},
        files: {},
      },
    };

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "canvases") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              async single() {
                return { data: { content: canvasState.content }, error: null };
              },
              async maybeSingle() {
                return { data: null, error: null };
              },
              update(payload: {
                content: {
                  elements: Array<Record<string, unknown>>;
                  appState: Record<string, unknown>;
                  files: Record<string, unknown>;
                };
              }) {
                canvasState.content = payload.content;
                return {
                  async eq() {
                    return { error: null };
                  },
                };
              },
            };
          }
          expect(table).toBe("workspaces");
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            limit() {
              return this;
            },
            async single() {
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        agnesApiKey: "agnes-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob: vi.fn(async () => ({ id: "job-1" })),
        getJobAdmin,
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一张图",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitImageJob = capturedGatewaySession?.submitImageJob;
    expect(submitImageJob).toBeTypeOf("function");
    if (!submitImageJob) {
      throw new Error("Expected local tool gateway to receive submitImageJob");
    }
    await expect(
      submitImageJob({
        aspectRatio: "1:1",
        model: "agnes-image/agnes-image-2.1-flash",
        prompt: "young playful logo",
        title: "logo",
      }),
    ).resolves.toMatchObject({
      elementId: expect.any(String),
      imageUrl: "http://127.0.0.1:3001/local-assets/asset-1",
      jobId: "job-1",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
    expect(canvasState.content.elements).toHaveLength(1);
    expect(canvasState.content.elements[0]).toMatchObject({
      type: "image",
      customData: {
        assetId: "asset-1",
        jobId: "job-1",
        source: "generated",
        storageUrl: "/local-assets/asset-1",
        title: "logo",
      },
    });
    const fileId = canvasState.content.elements[0]?.fileId as string;
    expect(canvasState.content.files[fileId]).toMatchObject({
      assetId: "asset-1",
      mimeType: "image/png",
      objectPath: "generated/asset-1.png",
      storageUrl: "/local-assets/asset-1",
    });
    expect(getJobAdmin).toHaveBeenCalledWith("job-1");
  });

  it("keeps image generation nodes visible while job polling is pending", async () => {
    let capturedGatewaySession:
      | {
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<{
            error?: string;
            elementId?: string;
            imageUrl?: string;
            jobId: string;
            mimeType?: string;
            status?: "generating";
            width?: number;
            height?: number;
          }>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const canvasState = {
      content: {
        elements: [] as Array<Record<string, unknown>>,
        appState: {},
        files: {},
      },
    };
    let releaseJob: (() => void) | undefined;
    const getJobAdmin = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseJob = () =>
            resolve({
              attempt_count: 0,
              max_attempts: 3,
              result: {
                asset_id: "asset-1",
                signed_url: "http://127.0.0.1:3001/local-assets/asset-1",
                mime_type: "image/png",
                width: 1024,
                height: 1024,
              },
              status: "succeeded",
            });
        }),
    );

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "canvases") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              async single() {
                return { data: { content: canvasState.content }, error: null };
              },
              async maybeSingle() {
                return { data: null, error: null };
              },
              update(payload: {
                content: {
                  elements: Array<Record<string, unknown>>;
                  appState: Record<string, unknown>;
                  files: Record<string, unknown>;
                };
              }) {
                canvasState.content = payload.content;
                return {
                  async eq() {
                    return { error: null };
                  },
                };
              },
            };
          }
          expect(table).toBe("workspaces");
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            limit() {
              return this;
            },
            async single() {
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        agnesApiKey: "agnes-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob: vi.fn(async () => ({ id: "job-1" })),
        getJobAdmin,
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一张图",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitImageJob = capturedGatewaySession?.submitImageJob;
    expect(submitImageJob).toBeTypeOf("function");
    if (!submitImageJob) {
      throw new Error("Expected local tool gateway to receive submitImageJob");
    }
    const promise = submitImageJob({
      aspectRatio: "1:1",
      model: "agnes-image/agnes-image-2.1-flash",
      prompt: "young playful logo",
      title: "logo",
    });
    await vi.waitFor(() => {
      expect(canvasState.content.elements).toHaveLength(1);
    });
    expect(canvasState.content.elements[0]).toMatchObject({
      type: "rectangle",
      customData: {
        type: "image-generator",
        status: "generating",
        jobId: "job-1",
        prompt: "young playful logo",
        runId: run.runId,
      },
    });
    releaseJob?.();
    await expect(promise).resolves.toMatchObject({
      elementId: expect.any(String),
      imageUrl: "http://127.0.0.1:3001/local-assets/asset-1",
      jobId: "job-1",
    });
  });

  it("cancels pending image generation jobs when the run is canceled", async () => {
    let capturedGatewaySession:
      | {
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const canvasState = {
      content: {
        elements: [] as Array<Record<string, unknown>>,
        appState: {},
        files: {},
      },
    };
    const cancelJob = vi.fn(async () => ({ id: "job-1", status: "canceled" }));

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "canvases") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              async single() {
                return { data: { content: canvasState.content }, error: null };
              },
              async maybeSingle() {
                return { data: null, error: null };
              },
              update(payload: {
                content: {
                  elements: Array<Record<string, unknown>>;
                  appState: Record<string, unknown>;
                  files: Record<string, unknown>;
                };
              }) {
                canvasState.content = payload.content;
                return {
                  async eq() {
                    return { error: null };
                  },
                };
              },
            };
          }
          expect(table).toBe("workspaces");
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            limit() {
              return this;
            },
            async single() {
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        agnesApiKey: "agnes-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        cancelJob,
        createJob: vi.fn(async () => ({ id: "job-1" })),
        getJobAdmin: vi.fn(async () => ({
          attempt_count: 0,
          max_attempts: 3,
          status: "processing",
        })),
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一张图",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitImageJob = capturedGatewaySession?.submitImageJob;
    expect(submitImageJob).toBeTypeOf("function");
    if (!submitImageJob) {
      throw new Error("Expected local tool gateway to receive submitImageJob");
    }
    const promise = submitImageJob({
      aspectRatio: "1:1",
      model: "agnes-image/agnes-image-2.1-flash",
      prompt: "young playful logo",
      title: "logo",
    });
    await vi.waitFor(() => {
      expect(canvasState.content.elements).toHaveLength(1);
    });

    runs.cancelRun(run.runId);

    await expect(promise).rejects.toThrow("Image generation was canceled.");
    expect(cancelJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      "job-1",
    );
  });

  it("rejects invalid image generation parameters before creating agent jobs", async () => {
    let capturedGatewaySession:
      | {
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const createJob = vi.fn(async () => ({ id: "job-1" }));

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "workspaces") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              limit() {
                return this;
              },
              async single() {
                return { data: { id: "workspace-1" }, error: null };
              },
            };
          }
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            async single() {
              return {
                data: { content: { elements: [], appState: {}, files: {} } },
                error: null,
              };
            },
            async maybeSingle() {
              return { data: null, error: null };
            },
            update() {
              return {
                async eq() {
                  return { error: null };
                },
              };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        agnesApiKey: "agnes-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob,
        getJobAdmin: vi.fn(),
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一张图",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitImageJob = capturedGatewaySession?.submitImageJob;
    expect(submitImageJob).toBeTypeOf("function");
    if (!submitImageJob) {
      throw new Error("Expected local tool gateway to receive submitImageJob");
    }
    await expect(
      submitImageJob({
        aspectRatio: "4:5",
        model: "agnes-image/agnes-image-2.1-flash",
        prompt: "magazine cover",
        title: "cover",
      }),
    ).rejects.toThrow(/aspectRatio/i);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("syncs one-time Codex imagegen consent from the local tool gateway into job submission", async () => {
    let capturedGatewaySession:
      | {
          codexImagegenConsentBudget?: number;
          onWorkspaceSettingsStateChange?: (state: {
            codexImagegenConsentBudget?: number;
          }) => void;
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const createJob = vi.fn(async () => ({ id: "job-1" }));

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          let isUpdate = false;
          return {
            table,
            select() {
              return this;
            },
            eq() {
              if (isUpdate) {
                return Promise.resolve({ error: null });
              }
              return this;
            },
            limit() {
              return this;
            },
            async maybeSingle() {
              if (table === "canvases") {
                return {
                  data: {
                    content: { elements: [], appState: {}, files: {} },
                    project_id: "project-1",
                  },
                  error: null,
                };
              }
              if (table === "projects") {
                return {
                  data: { brand_kit_id: null },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
            update() {
              isUpdate = true;
              return this;
            },
            async single() {
              if (table === "canvases") {
                return {
                  data: {
                    content: { elements: [], appState: {}, files: {} },
                    project_id: "project-1",
                  },
                  error: null,
                };
              }
              if (table === "projects") {
                return {
                  data: { brand_kit_id: null },
                  error: null,
                };
              }
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "claude:default",
        codexImagegenEnabled: true,
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob,
        getJobAdmin: vi.fn(async () => ({
          result: {
            asset_id: "asset-1",
            signed_url: "http://127.0.0.1:3001/local-assets/asset-1",
            mime_type: "image/png",
            width: 1024,
            height: 1024,
          },
          status: "succeeded",
        })),
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "Generate image",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        codexImagegenDelegation: "ask",
        model: "claude-code:default",
        agentTargetId: "local:claude-code",
        runtimeKind: "local-agent",
        runtimeProvider: "claude-code",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    expect(capturedGatewaySession?.codexImagegenConsentBudget).toBe(0);
    expect(capturedGatewaySession?.onWorkspaceSettingsStateChange).toBeTypeOf(
      "function",
    );
    capturedGatewaySession?.onWorkspaceSettingsStateChange?.({
      codexImagegenConsentBudget: 1,
    });

    await expect(
      capturedGatewaySession?.submitImageJob?.({
        aspectRatio: "1:1",
        model: "codex/gpt-image-2",
        prompt: "A red square",
        title: "red square",
      }),
    ).resolves.toMatchObject({
      jobId: "job-1",
      imageUrl: "http://127.0.0.1:3001/local-assets/asset-1",
    });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.objectContaining({
        payload: expect.objectContaining({
          caller_provider: "claude-code",
          codex_imagegen_consent: "allow-once",
          codex_imagegen_delegation_allowed: true,
          model: "codex/gpt-image-2",
        }),
      }),
    );
  });

  it("uses the run effective env when validating agent image job providers", async () => {
    let capturedGatewaySession:
      | {
          submitImageJob?: (input: {
            aspectRatio: string;
            model: string;
            prompt: string;
            title: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const createJob = vi.fn(async () => ({ id: "job-1" }));
    const getJobAdmin = vi.fn(async () => ({
      result: {
        height: 1024,
        mime_type: "image/png",
        signed_url: "http://127.0.0.1:3001/local-assets/kie-image",
        width: 1024,
      },
      status: "succeeded",
    }));

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          expect(table).toBe("workspaces");
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            limit() {
              return this;
            },
            async single() {
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob,
        getJobAdmin,
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        conversationId: "conversation-1",
        prompt: "生成一张图",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        env: {
          agentBackendMode: "state",
          agentModel: "agnes:agnes-2.0-flash",
          kieApiKey: "kie-key-from-settings",
          port: 3001,
          version: "0.0.0",
          webOrigin: "http://localhost:3000",
        },
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitImageJob = capturedGatewaySession?.submitImageJob;
    expect(submitImageJob).toBeTypeOf("function");
    if (!submitImageJob) {
      throw new Error("Expected local tool gateway to receive submitImageJob");
    }

    await expect(
      submitImageJob({
        aspectRatio: "1:1",
        model: "kie/nano-banana",
        prompt: "minimal product logo",
        title: "logo",
      }),
    ).resolves.toMatchObject({
      imageUrl: "http://127.0.0.1:3001/local-assets/kie-image",
      jobId: "job-1",
    });
    expect(createJob).toHaveBeenCalled();
  });

  it("returns video jobs with canvas generation nodes before polling", async () => {
    let capturedGatewaySession:
      | {
          submitVideoJob?: (input: {
            aspectRatio: string;
            duration: number;
            model: string;
            prompt: string;
            resolution: string;
            title: string;
          }) => Promise<{
            error?: string;
            elementId?: string;
            jobId: string;
          }>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const getJobAdmin = vi.fn(async () => ({
      attempt_count: 0,
      max_attempts: 3,
      status: "running",
    }));
    const canvasState = {
      content: {
        elements: [] as Array<Record<string, unknown>>,
        appState: {},
        files: {},
      },
    };

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "canvases") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              async single() {
                return { data: { content: canvasState.content }, error: null };
              },
              async maybeSingle() {
                return { data: null, error: null };
              },
              update(payload: {
                content: {
                  elements: Array<Record<string, unknown>>;
                  appState: Record<string, unknown>;
                  files: Record<string, unknown>;
                };
              }) {
                canvasState.content = payload.content;
                return {
                  async eq() {
                    return { error: null };
                  },
                };
              },
            };
          }
          expect(table).toBe("workspaces");
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            limit() {
              return this;
            },
            async single() {
              return { data: { id: "workspace-1" }, error: null };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        googleApiKey: "google-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob: vi.fn(async () => ({ id: "job-video-1" })),
        getJobAdmin,
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一段视频",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitVideoJob = capturedGatewaySession?.submitVideoJob;
    expect(submitVideoJob).toBeTypeOf("function");
    if (!submitVideoJob) {
      throw new Error("Expected local tool gateway to receive submitVideoJob");
    }
    await expect(
      submitVideoJob({
        aspectRatio: "16:9",
        duration: 4,
        model: "google-official/veo-3.1-generate-preview",
        prompt: "product reveal",
        resolution: "720p",
        title: "product reveal",
      }),
    ).resolves.toMatchObject({
      elementId: expect.any(String),
      jobId: "job-video-1",
      status: "generating",
    });
    expect(canvasState.content.elements).toHaveLength(1);
    expect(canvasState.content.elements[0]).toMatchObject({
      type: "rectangle",
      customData: {
        type: "video-generator",
        status: "generating",
        jobId: "job-video-1",
        prompt: "product reveal",
        runId: run.runId,
      },
    });
    expect(getJobAdmin).not.toHaveBeenCalled();
  });

  it("rejects invalid video generation parameters before creating agent jobs", async () => {
    let capturedGatewaySession:
      | {
          submitVideoJob?: (input: {
            aspectRatio: string;
            duration: number;
            model: string;
            prompt: string;
            resolution: string;
            title: string;
          }) => Promise<unknown>;
        }
      | undefined;
    const createSession = vi.fn((input) => {
      capturedGatewaySession = input;
      return { token: "tool-token" };
    });
    const createJob = vi.fn(async () => ({ id: "job-video-1" }));

    const runs = createAgentRunService({
      createUserClient: () => ({
        from(table: string) {
          if (table === "workspaces") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              limit() {
                return this;
              },
              async single() {
                return { data: { id: "workspace-1" }, error: null };
              },
            };
          }
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            async single() {
              return {
                data: { content: { elements: [], appState: {}, files: {} } },
                error: null,
              };
            },
            async maybeSingle() {
              return { data: null, error: null };
            },
            update() {
              return {
                async eq() {
                  return { error: null };
                },
              };
            },
          };
        },
      }),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        agnesApiKey: "agnes-key",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      jobService: {
        createJob,
        getJobAdmin: vi.fn(),
      } as never,
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession,
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "生成一段视频",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        userId: "user-1",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so the local tool gateway session is created.
    }

    const submitVideoJob = capturedGatewaySession?.submitVideoJob;
    expect(submitVideoJob).toBeTypeOf("function");
    if (!submitVideoJob) {
      throw new Error("Expected local tool gateway to receive submitVideoJob");
    }
    await expect(
      submitVideoJob({
        aspectRatio: "4:5",
        duration: 5,
        model: "agnes-video/agnes-video-v2.0",
        prompt: "product reveal",
        resolution: "720p",
        title: "product reveal",
      }),
    ).rejects.toThrow(/aspectRatio/i);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("passes non-Codex local-agent providers through the host adapter", async () => {
    const localRun = vi.fn(async function* (params) {
      yield {
        type: "text_delta" as const,
        text: `${params.provider}:${params.runtimeProvider}`,
      };
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      localAgentProviderPlugins: [
        {
          id: "claude-code",
          displayName: "Claude Code",
          kind: "local-agent",
          async detect() {
            return null;
          },
          capabilities() {
            return {
              cancel: true,
              nativeResume: false,
              streaming: true,
              toolGateway: true,
              maxConcurrentRuns: 1,
            };
          },
          async buildLaunchPlan() {
            throw new Error("not used");
          },
          async *run() {
            yield* [];
            throw new Error("not used");
          },
        },
      ],
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "sonnet",
        agentTargetId: "local:claude-code",
        runtimeKind: "local-agent",
        runtimeProvider: "claude-code",
      },
    );

    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-code",
        runtimeProvider: "claude-code",
        model: "sonnet",
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.delta",
          delta: "claude-code:claude-code",
        }),
      ]),
    );
  });

  it("strips the local provider prefix before invoking Tutti Agent", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      localAgentProviderPlugins: [
        {
          id: "tutti-agent",
          displayName: "Tutti Agent",
          kind: "local-agent",
          async detect() {
            return null;
          },
          capabilities() {
            return {
              cancel: true,
              nativeResume: false,
              streaming: true,
              toolGateway: false,
              maxConcurrentRuns: 1,
            };
          },
          async buildLaunchPlan() {
            throw new Error("not used");
          },
          async *run() {
            yield* [];
            throw new Error("not used");
          },
        },
      ],
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "tutti-agent:openai-codex:gpt-5.4",
        agentTargetId: "local:tutti-agent",
        runtimeKind: "local-agent",
        runtimeProvider: "tutti-agent",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "tutti-agent",
        runtimeProvider: "tutti-agent",
        model: "openai-codex:gpt-5.4",
      }),
    );
  });

  it("resolves resume mode and passes provider-local resume into the local runtime", async () => {
    const createRun = vi.fn();
    const updateRun = vi.fn();
    const localRun = vi.fn(async function* () {
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
        sessionId: "provider-session-next",
        resumeToken: "resume-token-next",
      };
    });

    const runs = createAgentRunService({
      agentRunStore: {
        createRun,
        getRun: vi.fn(() => ({
          id: "run-previous",
          agent_target_id: "local:codex",
          provider_session_id: "provider-session-prev",
          resume_token: "resume-token-prev",
          runtime_kind: "local-agent",
          runtime_provider: "codex",
          session_id: "session-1",
          status: "completed",
        })),
        updateRun,
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        resumeFromRunId: "run-previous",
        resumeMode: "auto",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    expect(run.resumeMode).toBe("provider-local");
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "run-previous",
        resumeMode: "provider-local",
      }),
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: {
          mode: "provider",
          providerSessionId: "provider-session-prev",
          resumeToken: "resume-token-prev",
        },
      }),
    );
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: "provider-session-next",
        resumeToken: "resume-token-next",
        runId: run.runId,
      }),
    );
  });

  it("turns an explicit provider-local resume into handoff when the exact target changes", () => {
    const createRun = vi.fn();
    const runs = createAgentRunService({
      agentRunStore: {
        createRun,
        getRun: vi.fn(() => ({
          id: "run-previous",
          agent_target_id: "team:designer",
          runtime_kind: "local-agent",
          runtime_provider: "codex",
          session_id: "session-1",
          status: "completed",
        })),
        updateRun: vi.fn(),
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: vi.fn(async function* () {}),
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    expect(() =>
      runs.createRun(
        {
          canvasId: "canvas-1",
          conversationId: "canvas-1",
          prompt: "继续",
          sessionId: "session-1",
        },
        {
          model: "codex:gpt-5.4",
          runtimeKind: "local-agent",
          runtimeProvider: "codex",
        },
      ),
    ).toThrow("must resolve an exact agentTargetId");

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        resumeFromRunId: "run-previous",
        resumeMode: "provider-local",
        sessionId: "session-1",
      },
      {
        agentTargetId: "team:reviewer",
        model: "codex:gpt-5.4",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    expect(run.resumeMode).toBe("handoff");
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ resumeMode: "handoff" }),
    );
  });

  it("turns cross-provider resume into a handoff without provider-native resume", async () => {
    const createRun = vi.fn();
    const localRun = vi.fn(async function* () {
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      agentRunStore: {
        createRun,
        getRun: vi.fn(() => ({
          id: "run-previous",
          runtime_kind: "local-agent",
          runtime_provider: "claude",
          session_id: "session-1",
          status: "completed",
        })),
        updateRun: vi.fn(),
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        resumeFromRunId: "run-previous",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    expect(run.resumeMode).toBe("handoff");
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "run-previous",
        resumeMode: "handoff",
      }),
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Resume handoff context:"),
        resume: {
          mode: "fresh",
        },
      }),
    );
  });

  it("passes the AIMC system prompt to local-agent providers", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        locale: "en",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: buildAimcSystemPrompt({ locale: "en" }),
      }),
    );
  });

  it("passes enabled local workspace skills to local-agent providers", async () => {
    createAgentBackendMock.mockClear();
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-runtime-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Runtime Skills" });
    let capturedPrompt = "";
    const localRun = vi.fn(async function* (input: {
      cwd: string;
      prompt: string;
    }) {
      capturedPrompt = input.prompt;
      expect(
        readFileSync(
          join(input.cwd, "workspace-skills", "canvas-director", "SKILL.md"),
          "utf8",
        ),
      ).toContain("Inspect the real element bounds");
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      createUserClient: () => createLocalUserClient(store),
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: project.primaryCanvas.id,
        conversationId: project.primaryCanvas.id,
        prompt: "有看到 Canvas Director 这一个 skill 吗",
        sessionId: "session-1",
      },
      {
        accessToken: "local-token",
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so runtime reaches the provider invocation.
    }

    expect(localRun).toHaveBeenCalledWith(
      expect.objectContaining({
        skillManifest: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("Inspect the real element bounds"),
            skillId: "canvas-director",
            slug: "canvas-director",
          }),
        ]),
      }),
    );
    expect(capturedPrompt).toContain(
      "use relative paths such as `workspace-skills/<slug>/SKILL.md`",
    );
    expect(capturedPrompt).not.toContain(
      "workspace-skills/canvas-director/SKILL.md",
    );
    expect(capturedPrompt).not.toContain(
      "/workspace-skills/canvas-director/SKILL.md",
    );
    expect(createAgentBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentBackendMode: "state" }),
      project.primaryCanvas.id,
      {
        sandboxRoot: tmpdir(),
        workspaceSkills: [],
      },
    );
  });

  it("maps local-agent tool results into stream events with media artifacts", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "tool_call" as const,
        id: "tool-1",
        name: "generate_image",
        input: { prompt: "poster" },
      };
      yield {
        type: "tool_result" as const,
        id: "tool-1",
        name: "generate_image",
        output: {
          imageUrl: "https://example.com/image.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          title: "poster",
        },
        summary: "generated",
        isError: false,
      };
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(localRun).toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.started",
          toolCallId: "tool-1",
          toolName: "generate_image",
        }),
        expect.objectContaining({
          type: "tool.completed",
          toolCallId: "tool-1",
          toolName: "generate_image",
          outputSummary: "generated",
          artifacts: [
            expect.objectContaining({
              type: "image",
              url: "https://example.com/image.png",
            }),
          ],
        }),
      ]),
    );
  });

  it("maps local-agent screenshot tool results into image artifacts", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "tool_result" as const,
        id: "tool-screenshot",
        name: "screenshot_canvas",
        output: {
          screenshotUrl: "https://example.com/screenshot.png",
          mimeType: "image/png",
          width: 800,
          height: 600,
        },
        summary: "screenshot captured",
        isError: false,
      };
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "截图",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.completed",
          toolCallId: "tool-screenshot",
          toolName: "screenshot_canvas",
          artifacts: [
            expect.objectContaining({
              type: "image",
              url: "https://example.com/screenshot.png",
            }),
          ],
        }),
      ]),
    );
  });

  it("maps local-agent persisted sandbox files into image artifacts", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "tool_result" as const,
        id: "tool-persist-file",
        name: "persist_sandbox_file",
        output: {
          summary: "File uploaded successfully: poster.png",
          url: "https://example.com/storage/poster.png",
          path: "workspace/generated/poster.png",
          mimeType: "image/png",
          size: 12345,
        },
        summary: "File uploaded successfully: poster.png",
        isError: false,
      };
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "保存文件",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.completed",
          toolCallId: "tool-persist-file",
          toolName: "persist_sandbox_file",
          outputSummary: "File uploaded successfully: poster.png",
          artifacts: [
            expect.objectContaining({
              type: "image",
              url: "https://example.com/storage/poster.png",
              mimeType: "image/png",
            }),
          ],
        }),
      ]),
    );
  });

  it("maps local-agent video tool results into stream events with video artifacts", async () => {
    const localRun = vi.fn(async function* () {
      yield {
        type: "tool_call" as const,
        id: "tool-video",
        name: "generate_video",
        input: { prompt: "motion poster" },
      };
      yield {
        type: "tool_result" as const,
        id: "tool-video",
        name: "generate_video",
        output: {
          videoUrl: "https://example.com/video.mp4",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 5,
          title: "motion poster",
        },
        summary: "video generated",
        isError: false,
      };
      yield {
        type: "done" as const,
        reason: "completed" as const,
        exitCode: 0,
      };
    });

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localRun,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "继续",
        sessionId: "session-1",
      },
      {
        model: "codex:gpt-5.4",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.completed",
          toolCallId: "tool-video",
          toolName: "generate_video",
          outputSummary: "video generated",
          artifacts: [
            expect.objectContaining({
              type: "video",
              url: "https://example.com/video.mp4",
              durationSeconds: 5,
            }),
          ],
        }),
      ]),
    );
  });

  it("fails fast when local Codex is explicitly requested without a registered gateway", async () => {
    localAgentRuntimeRunMock.mockClear();

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      loadSessionMessages: async () => [],
    });

    expect(() =>
      runs.createRun(
        {
          canvasId: "canvas-1",
          conversationId: "canvas-1",
          prompt: "继续",
          sessionId: "session-1",
        },
        {
          model: "codex:gpt-5.4",
          agentTargetId: "local:codex",
          runtimeKind: "local-agent",
          runtimeProvider: "codex",
        },
      ),
    ).toThrow("No runtime provider registered for local-agent (codex)");

    expect(localAgentRuntimeRunMock).not.toHaveBeenCalled();
  });

  it("does not register local Codex when trusted local mode is disabled", async () => {
    localAgentRuntimeRunMock.mockClear();

    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        port: 3001,
        trustedLocalAgentMode: false,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    expect(() =>
      runs.createRun(
        {
          canvasId: "canvas-1",
          conversationId: "canvas-1",
          prompt: "继续",
          sessionId: "session-1",
        },
        {
          model: "codex:gpt-5.4",
          agentTargetId: "local:codex",
          runtimeKind: "local-agent",
          runtimeProvider: "codex",
        },
      ),
    ).toThrow("No runtime provider registered for local-agent (codex)");

    expect(localAgentRuntimeRunMock).not.toHaveBeenCalled();
  });

  it("delegates exact-target validation to runtime.run without probing discovery", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    vi.stubEnv("AIMC_TOOLS_MCP_PATH", "/tmp/aimc-tools-mcp");
    localAgentRuntimeRunMock.mockClear();
    const pluginDetect = vi.fn(async () => {
      throw new Error("runtime gating must not probe provider plugins");
    });
    const runtimeDetect = vi.fn(async () => [
      {
        provider: "codex" as const,
        displayName: "Codex",
        supported: true,
        authState: "ok" as const,
        models: [{ id: "default", label: "Default" }],
        defaultModelId: "default",
      },
    ]);
    const runs = createAgentRunService({
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        appDataDir: "/tmp/aimc-app-data",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentDetectionRuntime: { detect: runtimeDetect },
      localAgentProviderPlugins: [
        {
          id: "codex",
          displayName: "Codex",
          kind: "local-agent",
          detect: pluginDetect,
          capabilities() {
            return {
              cancel: true,
              nativeResume: true,
              streaming: true,
              toolGateway: false,
              maxConcurrentRuns: 1,
            };
          },
          async buildLaunchPlan() {
            throw new Error("not used");
          },
          async *run() {
            yield* [];
            throw new Error("not used");
          },
        },
      ],
      localAgentRuntime: { run: localAgentRuntimeRunMock },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "hi",
        sessionId: "session-1",
      },
      {
        model: "codex:default",
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );
    for await (const _event of runs.streamRun(run.runId)) {
      // Exhaust the stream so provider gating and execution both run.
    }

    expect(runtimeDetect).not.toHaveBeenCalled();
    expect(pluginDetect).not.toHaveBeenCalled();
    expect(localAgentRuntimeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentTargetId: "local:codex" }),
    );
  });

  it("propagates an initial run-store update failure", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    const updateRun = vi.fn(() => {
      throw new Error("run store unavailable");
    });
    const runs = createAgentRunService({
      agentRunStore: {
        createRun: vi.fn(),
        updateRun,
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        appDataDir: "/tmp/aimc-app-data",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });

    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "hi",
        sessionId: "session-1",
      },
      {
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    const consume = async () => {
      for await (const _event of runs.streamRun(run.runId)) {
        // The store throws before any stream event can be produced.
      }
    };

    await expect(consume()).rejects.toThrow("run store unavailable");
  });

  it("does not start local provider work after an accepted run is canceled", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    localAgentRuntimeRunMock.mockClear();
    const updateRun = vi.fn();
    const runs = createAgentRunService({
      agentRunStore: {
        createRun: vi.fn(),
        updateRun,
      },
      env: {
        agentBackendMode: "state",
        agentModel: "agnes:agnes-2.0-flash",
        appDataDir: "/tmp/aimc-app-data",
        port: 3001,
        version: "0.0.0",
        webOrigin: "http://localhost:3000",
      },
      localAgentRuntime: {
        run: localAgentRuntimeRunMock,
      },
      loadSessionMessages: async () => [],
      toolGateway: {
        createSession: vi.fn(() => ({ token: "tool-token" })),
        revokeSession: vi.fn(),
      } as never,
      toolGatewayBaseUrl: "http://127.0.0.1:3001/api/local-tools",
    });
    const run = runs.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "canvas-1",
        prompt: "hi",
        sessionId: "session-1",
      },
      {
        agentTargetId: "local:codex",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      },
    );

    expect(runs.cancelRun(run.runId)).toEqual({
      runId: run.runId,
      status: "canceled",
    });
    const events = [];
    for await (const event of runs.streamRun(run.runId)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        runId: run.runId,
        timestamp: expect.any(String),
        type: "run.canceled",
      },
    ]);
    expect(localAgentRuntimeRunMock).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith({
      runId: run.runId,
      status: "canceled",
    });
    expect(updateRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
  });
});
