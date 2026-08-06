// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "../src/components/chat-sidebar";
import { ToastProvider } from "../src/components/toast";
import {
  INITIAL_ATTACHMENTS_KEY,
  INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
} from "../src/hooks/use-create-project";
import type { WebSocketHandle } from "../src/hooks/use-websocket";
import { i18n } from "../src/i18n";

const settingsDialogSpy = vi.fn();
const chatInputName = "输入消息";

function findChatInput() {
  return screen.findByRole("textbox", { name: chatInputName });
}

const {
  createSessionMock,
  deleteSessionMock,
  fetchMessagesMock,
  fetchRunEventsMock,
  fetchSessionsMock,
  saveMessageMock,
  updateSessionTitleMock,
  fetchImageModelsMock,
  fetchVideoModelsMock,
  fetchModelsMock,
  fetchWorkspaceSettingsMock,
  uploadFileMock,
  generationJobWatchMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchRunEventsMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchVideoModelsMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchWorkspaceSettingsMock: vi.fn(),
  uploadFileMock: vi.fn(),
  generationJobWatchMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchImageModels: fetchImageModelsMock,
  fetchVideoModels: fetchVideoModelsMock,
  fetchModels: fetchModelsMock,
  fetchRunEvents: fetchRunEventsMock,
  fetchWorkspaceSettings: fetchWorkspaceSettingsMock,
  uploadFile: uploadFileMock,
  fetchMessages: fetchMessagesMock,
  fetchSessions: fetchSessionsMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
}));

vi.mock("../src/lib/generation-job-service", () => ({
  generationJobService: {
    watch: generationJobWatchMock,
  },
}));

vi.mock("../src/components/settings-dialog", () => ({
  SettingsDialog: ({
    open,
    onOpenChange,
    initialTab,
    onSaved,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialTab?: "general" | "agent" | "media";
    onSaved?: () => void;
  }) => {
    settingsDialogSpy({ initialTab, onOpenChange, onSaved, open });
    return open ? (
      <div>
        Mock Settings Dialog
        <button type="button" onClick={() => onOpenChange(false)}>
          Mock Close Settings
        </button>
        <button type="button" onClick={onSaved}>
          Mock Save Settings
        </button>
      </div>
    ) : null;
  },
}));

function createMockWs(): WebSocketHandle {
  return {
    connected: true,
    startRun: vi.fn((payload, onAck) => {
      // Simulate server ack
      onAck?.({
        type: "command.ack",
        action: "agent.run",
        payload: {
          runId: "run_123",
          assistantMessageId: "assistant-server-id",
        },
      });
    }),
    cancelRun: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn((_canvasId, _sessionId, onAck) => {
      onAck?.({
        type: "command.ack",
        action: "canvas.resume",
        payload: {
          canvasId: "canvas-1",
          latestSeq: 0,
          activeRunId: null,
          replayed: 0,
        },
      });
    }),
  };
}

function createMockLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) =>
      values.set(key, String(value)),
    ),
  };
}

describe("ChatSidebar", () => {
  let mockWs: WebSocketHandle;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMockLocalStorage(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    mockWs = createMockWs();
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue({
      session: {
        id: "session-created",
        title: "New Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
    deleteSessionMock.mockReset();
    fetchImageModelsMock.mockReset();
    fetchImageModelsMock.mockResolvedValue({
      models: [
        {
          id: "local:placeholder-image",
          displayName: "Local Placeholder Image",
        },
      ],
    });
    fetchVideoModelsMock.mockReset();
    fetchVideoModelsMock.mockResolvedValue({
      models: [
        {
          id: "agnes-video",
          displayName: "Agnes Video",
        },
      ],
    });
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue({
      models: [
        { id: "local:assistant", name: "Local Assistant", provider: "local" },
      ],
      localAgentProviders: [
        {
          provider: "local",
          displayName: "Local Assistant",
          supported: true,
          authState: "ok",
          models: [
            {
              id: "local:assistant",
              name: "Local Assistant",
              provider: "local",
              source: "local-agent",
            },
          ],
        },
        {
          provider: "claude",
          displayName: "Claude",
          supported: true,
          authState: "ok",
          models: [
            {
              id: "claude:sonnet",
              name: "Sonnet",
              provider: "claude",
              source: "local-agent",
            },
          ],
        },
      ],
    });
    fetchRunEventsMock.mockReset();
    fetchRunEventsMock.mockResolvedValue({
      done: true,
      events: [],
      nextCursor: 0,
    });
    fetchWorkspaceSettingsMock.mockReset();
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "local:assistant",
        agnesApiKey: "sk-local-agnes",
        replicateApiToken: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        openAIApiKey: "",
        volcesApiKey: "",
      },
    });
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue({
      asset: { id: "asset-pasted-image" },
      url: "http://localhost:3000/uploads/pasted.png",
    });
    generationJobWatchMock.mockReset();
    generationJobWatchMock.mockImplementation(() => ({
      promise: new Promise(() => {}),
      unsubscribe: vi.fn(),
    }));
    fetchMessagesMock.mockReset();
    fetchMessagesMock.mockResolvedValue({ messages: [] });
    fetchSessionsMock.mockReset();
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        {
          id: "session-real",
          title: "Existing Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    updateSessionTitleMock.mockReset();
    updateSessionTitleMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    sessionStorage.clear();
    (window as Window & { tutti?: unknown }).tutti = undefined;
    settingsDialogSpy.mockClear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("starts runs via WebSocket with the active real session id", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "hello loom",
          locale: "zh-CN",
          canvasId: "canvas-1",
        }),
        expect.any(Function),
      ),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeKind: expect.any(String),
      }),
      expect.anything(),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("passes the active English locale when starting a run", async () => {
    await i18n.changeLanguage("en");

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await screen.findByRole("textbox", {
      name: "Message input",
    });
    await userEvent.type(input, "expand the tarot card{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          locale: "en",
          prompt: "expand the tarot card",
        }),
        expect.any(Function),
      ),
    );
  });

  it("does not save or consume input while the WebSocket is disconnected", async () => {
    mockWs = {
      ...mockWs,
      connected: false,
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    expect(
      await screen.findByText("连接已断开，正在重连..."),
    ).toBeInTheDocument();
    const input = await findChatInput();
    expect(input).toBeDisabled();
    await userEvent.type(input, "hello while disconnected{Enter}");

    expect(input).toHaveValue("");
    expect(saveMessageMock).not.toHaveBeenCalled();
    expect(mockWs.startRun).not.toHaveBeenCalled();
  });

  it("allows image clipboard paste to reach the canvas page composer", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          canvasId="canvas-1"
          projectId="project-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    const pastedImage = new File(["image-bytes"], "copied.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            type: "image/png",
            getAsFile: () => pastedImage,
          },
        ],
      },
    });

    await waitFor(() =>
      expect(uploadFileMock).toHaveBeenCalledWith(pastedImage, "project-1"),
    );
  });

  it("cancels the active run from the composer stop button", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "please stop later{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "取消生成" }));

    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123");
  });

  it("filters stored manual image model preferences to currently available models", async () => {
    fetchImageModelsMock.mockResolvedValueOnce({
      models: [
        {
          id: "codex/gpt-image-2",
          displayName: "GPT Image 2",
        },
      ],
    });
    localStorage.setItem(
      "aimc:image-model-preference",
      JSON.stringify({
        mode: "manual",
        models: ["black-forest-labs/flux-kontext-pro", "codex/gpt-image-2"],
      }),
    );

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(fetchImageModelsMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          imageGenerationPreference: {
            mode: "manual",
            models: ["codex/gpt-image-2"],
          },
        }),
        expect.any(Function),
      ),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        imageGenerationPreference: expect.objectContaining({
          models: expect.arrayContaining([
            "black-forest-labs/flux-kontext-pro",
          ]),
        }),
      }),
      expect.any(Function),
    );
  });

  it("preserves the explicit initial image model preference before models load", async () => {
    fetchImageModelsMock.mockImplementationOnce(() => new Promise(() => {}));
    sessionStorage.setItem(
      INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
      JSON.stringify({
        mode: "manual",
        models: ["gpt-image-2"],
      }),
    );

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          initialPrompt="generate with the selected OpenAI model"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          imageGenerationPreference: {
            mode: "manual",
            models: ["gpt-image-2"],
          },
        }),
        expect.any(Function),
      ),
    );
  });

  it("auto-starts image-only initial runs from stored home attachments", async () => {
    const attachments = [
      {
        assetId: "asset-upload-1",
        url: "https://example.com/ref.png",
        mimeType: "image/png",
        source: "upload" as const,
        name: "ref.png",
      },
    ];
    sessionStorage.setItem(
      INITIAL_ATTACHMENTS_KEY,
      JSON.stringify(attachments),
    );

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "",
          canvasId: "canvas-1",
          attachments,
        }),
        expect.any(Function),
      ),
    );
    await waitFor(() =>
      expect(updateSessionTitleMock).toHaveBeenCalledWith(
        "session-real",
        "ref.png",
      ),
    );
    expect(sessionStorage.getItem(INITIAL_ATTACHMENTS_KEY)).toBeNull();
  });

  it("waits for the user message to persist before starting the run", async () => {
    let resolveSave: (() => void) | undefined;
    saveMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "preserve order{Enter}");

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(1));
    expect(mockWs.startRun).not.toHaveBeenCalled();

    resolveSave?.();

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          prompt: "preserve order",
        }),
        expect.any(Function),
      ),
    );
  });

  it("preserves provider compatibility for legacy local-agent selections", async () => {
    localStorage.setItem("aimc:agent-model", "claude:sonnet");
    localStorage.setItem("aimc:agent-model-source", "local-agent");

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "use claude{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude:sonnet",
          prompt: "use claude",
          runtimeKind: "local-agent",
          runtimeProvider: "claude",
        }),
        expect.any(Function),
      ),
    );
  });

  it("opens agent settings instead of starting a run when no agent model is configured", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        agnesApiKey: "sk-local-agnes",
        replicateApiToken: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        openAIApiKey: "",
        volcesApiKey: "",
      },
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "hello without model{Enter}");

    await waitFor(() => expect(mockWs.startRun).not.toHaveBeenCalled());
    expect(await screen.findByText("Mock Settings Dialog")).toBeInTheDocument();
    expect(input).toHaveValue("hello without model");
    expect(
      screen.queryByText("请先配置或选择一个 Agent 模型。"),
    ).not.toBeInTheDocument();
  });

  it("does not overwrite a newer draft when model validation fails", async () => {
    let resolveSettings!: (value: {
      settings: { defaultModel: string };
    }) => void;
    fetchWorkspaceSettingsMock
      .mockResolvedValueOnce({
        settings: {
          defaultModel: "local:assistant",
        },
      })
      .mockResolvedValueOnce({
        settings: {
          defaultModel: "local:assistant",
        },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
      );

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await waitFor(() =>
      expect(fetchWorkspaceSettingsMock).toHaveBeenCalledTimes(2),
    );
    await userEvent.type(input, "submitted draft{Enter}");
    await userEvent.type(input, "newer draft");

    resolveSettings({ settings: { defaultModel: "" } });

    expect(await screen.findByText("Mock Settings Dialog")).toBeInTheDocument();
    expect(input).toHaveValue("newer draft");
    expect(mockWs.startRun).not.toHaveBeenCalled();
  });

  it("ignores a rapid duplicate Enter press while a send is already starting", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "double send");

    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      charCode: 13,
    });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      charCode: 13,
    });

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));
    expect(saveMessageMock).toHaveBeenCalledTimes(1);
  });

  it("drops a consumed resume cursor after the resumed run fails", async () => {
    let listener: ((entry: { event: Record<string, unknown> }) => void) | null =
      null;
    let nextRun = 0;
    mockWs = {
      ...mockWs,
      startRun: vi.fn((_payload, onAck) => {
        nextRun += 1;
        onAck?.({
          type: "command.ack",
          action: "agent.run",
          payload: {
            runId: `run-${nextRun}`,
            assistantMessageId: `assistant-${nextRun}`,
          },
        });
      }),
      onEvent: vi.fn((nextListener) => {
        listener = nextListener as typeof listener;
        return () => {
          listener = null;
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "first{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));
    act(() => {
      listener?.({
        event: {
          type: "run.completed",
          runId: "run-1",
          timestamp: "2026-07-17T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => expect(input).not.toBeDisabled());
    await userEvent.type(input, "second{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(2));
    expect(
      (mockWs.startRun as ReturnType<typeof vi.fn>).mock.calls[1]?.[0],
    ).toMatchObject({ resumeFromRunId: "run-1", resumeMode: "auto" });
    act(() => {
      listener?.({
        event: {
          type: "run.failed",
          runId: "run-2",
          error: { code: "PROVIDER_FAILED", message: "stale session" },
          timestamp: "2026-07-17T00:00:01.000Z",
        },
      });
    });

    await waitFor(() => expect(input).not.toBeDisabled());
    await userEvent.type(input, "third{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(3));
    expect(
      (mockWs.startRun as ReturnType<typeof vi.fn>).mock.calls[2]?.[0],
    ).not.toHaveProperty("resumeFromRunId");
  });

  it("allows a new session to send while another session is still running", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "first run{Enter}");

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));

    const nextInput = await findChatInput();
    await waitFor(() => expect(nextInput).not.toBeDisabled());
    await userEvent.type(nextInput, "second run{Enter}");

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(2));
    expect(mockWs.startRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-created",
        prompt: "second run",
      }),
      expect.any(Function),
    );
  });

  it("does not include managed agent invocation credentials in run payloads", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "first run{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));

    const nextInput = await findChatInput();
    await waitFor(() => expect(nextInput).not.toBeDisabled());
    await userEvent.type(nextInput, "second run{Enter}");

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(2));

    const startRunMock = mockWs.startRun as unknown as {
      mock: { calls: Array<[Record<string, unknown>, unknown]> };
    };
    expect(startRunMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "first run",
    });
    expect(startRunMock.mock.calls[1]?.[0]).toMatchObject({
      prompt: "second run",
    });
    expect(startRunMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "managedAgentInvocationCredential",
    );
    expect(startRunMock.mock.calls[1]?.[0]).not.toHaveProperty(
      "managedAgentInvocationCredential",
    );
  });

  it("starts a run even when no managed credential bridge is present", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    await userEvent.type(input, "header handles credentials{Enter}");

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));
    expect(mockWs.startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({
        managedAgentInvocationCredential: expect.any(String),
      }),
      expect.any(Function),
    );
  });

  it("does not attach selected canvas images when sending a local template", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
          selectedCanvasElements={[
            {
              id: "canvas-image-1",
              type: "image",
              x: 0,
              y: 0,
              width: 320,
              height: 240,
              fileId: "file-1",
              storageUrl: "https://example.test/brand.png",
            },
          ]}
        />
      </ToastProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "分镜故事板" }),
    );

    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));
    expect(mockWs.startRun).toHaveBeenCalledWith(
      expect.not.objectContaining({
        attachments: expect.any(Array),
      }),
      expect.any(Function),
    );
  });

  it("sends selected local canvas images with runtime asset urls", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
          selectedCanvasElements={[
            {
              id: "canvas-image-1",
              type: "image",
              x: 0,
              y: 0,
              width: 320,
              height: 240,
              fileId: "file-1",
              storageUrl: "/local-assets/asset-1",
            },
          ]}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "describe this{Enter}");

    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledTimes(1));
    expect(saveMessageMock).toHaveBeenCalledWith(
      "session-real",
      expect.objectContaining({
        contentBlocks: expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            url: "http://localhost:3000/local-assets/asset-1",
          }),
        ]),
      }),
    );
    expect(mockWs.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            url: "http://localhost:3000/local-assets/asset-1",
          }),
        ],
      }),
      expect.any(Function),
    );
  });

  it("ignores generated artifacts from a run after switching canvases", async () => {
    const imageGeneratedSpy = vi.fn();
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    const { rerender } = render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    rerender(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-2"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-old-canvas",
          toolName: "generate_image",
          artifacts: [
            {
              type: "image",
              title: "Old canvas image",
              url: "https://example.com/old-canvas.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "run.completed",
          runId: "run_123",
          timestamp: "2026-06-04T00:00:01.000Z",
        },
      });
    }

    expect(imageGeneratedSpy).not.toHaveBeenCalled();
  });

  it("keeps generated artifacts on the active canvas", async () => {
    const imageGeneratedSpy = vi.fn();
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-active-canvas",
          toolName: "generate_image",
          artifacts: [
            {
              type: "image",
              title: "Active canvas image",
              url: "https://example.com/active-canvas.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    expect(imageGeneratedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        url: "https://example.com/active-canvas.png",
      }),
    );
  });

  it("does not client-insert artifacts that the backend already inserted", async () => {
    const imageGeneratedSpy = vi.fn();
    const canvasSyncSpy = vi.fn();
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onCanvasSync={canvasSyncSpy}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-backend-image",
          toolName: "generate_image",
          output: {
            elementId: "canvas-image-1",
            imageUrl: "https://example.com/backend.png",
          },
          artifacts: [
            {
              type: "image",
              title: "Backend image",
              url: "https://example.com/backend.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(imageGeneratedSpy).not.toHaveBeenCalled();
    expect(canvasSyncSpy).toHaveBeenCalled();
  });

  it("shows a chat media loading card for deferred image jobs", async () => {
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-deferred-image",
          toolName: "generate_image",
          output: {
            status: "generating",
            jobId: "job-image-1",
            jobType: "image_generation",
            elementId: "generator-1",
            title: "Deferred image",
          },
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    expect(await screen.findByText("图片生成中...")).toBeInTheDocument();
    expect(generationJobWatchMock).toHaveBeenCalledWith(
      "job-image-1",
      expect.objectContaining({ jobType: "image_generation" }),
    );
  });

  it("turns a deferred image loading card into canceled when the run is canceled", async () => {
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-deferred-image",
          toolName: "generate_image",
          output: {
            status: "generating",
            jobId: "job-image-1",
            jobType: "image_generation",
            elementId: "generator-1",
            title: "Deferred image",
          },
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    expect(await screen.findByText("图片生成中...")).toBeInTheDocument();

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "run.canceled",
          runId: "run_123",
          timestamp: "2026-06-04T00:00:01.000Z",
        },
      });
    }

    expect(await screen.findByText("图片生成已取消")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("图片生成中...")).not.toBeInTheDocument(),
    );
  });

  it("updates deferred image jobs in chat when polling succeeds", async () => {
    let onSucceeded: ((result: Record<string, unknown>) => void) | undefined;
    generationJobWatchMock.mockImplementation((_jobId, options) => {
      onSucceeded = options.onSucceeded;
      return {
        promise: new Promise(() => {}),
        unsubscribe: vi.fn(),
      };
    });
    const listeners: Array<
      (entry: {
        event: Record<string, unknown>;
        replayed?: boolean;
        eventId?: string;
        seq?: number;
      }) => void
    > = [];
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((nextListener) => {
        const listener = nextListener as (typeof listeners)[number];
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const input = await findChatInput();
    await userEvent.type(input, "generate image{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledTimes(1));

    for (const listener of [...listeners]) {
      listener({
        event: {
          type: "tool.completed",
          runId: "run_123",
          toolCallId: "tool-deferred-image",
          toolName: "generate_image",
          output: {
            status: "generating",
            jobId: "job-image-1",
            jobType: "image_generation",
            elementId: "generator-1",
            title: "Deferred image",
          },
          timestamp: "2026-06-04T00:00:00.000Z",
        },
      });
    }

    await waitFor(() => expect(onSucceeded).toBeTypeOf("function"));
    act(() => {
      onSucceeded?.({
        signed_url: "https://example.com/deferred.png",
        asset_id: "asset-1",
        mime_type: "image/png",
        width: 1024,
        height: 1024,
      });
    });

    expect(
      await screen.findByRole("img", { name: "Deferred image" }),
    ).toHaveAttribute("src", "http://localhost:3000/local-assets/asset-1");
  });

  it("opens the settings dialog from the chat header action", async () => {
    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    const settingsButton = await screen.findByRole("button", {
      name: "打开设置",
    });
    await userEvent.click(settingsButton);

    expect(await screen.findByText("Mock Settings Dialog")).toBeInTheDocument();
    expect(settingsDialogSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true }),
    );
  });

  it("prompts the user to continue after saving media settings from a capability card", async () => {
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-media-required",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-media-required",
              toolName: "generate_image",
              status: "completed",
              output: {
                error: "media_provider_configuration_required",
                errorCode: "media_provider_configuration_required",
                capabilityRequired: {
                  kind: "media_provider_configuration_required",
                  capability: "image_generation",
                },
              },
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "去连接" }),
    );
    expect(settingsDialogSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialTab: "media", open: true }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Mock Save Settings" }),
    );

    expect(
      await screen.findByText("媒体模型已保存，发送“继续”即可重试刚才的生成。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue(
      "继续",
    );
  });

  it("does not prompt to continue after a later unrelated settings save", async () => {
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-media-required",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-media-required",
              toolName: "generate_image",
              status: "completed",
              output: {
                error: "media_provider_configuration_required",
                errorCode: "media_provider_configuration_required",
                capabilityRequired: {
                  kind: "media_provider_configuration_required",
                  capability: "image_generation",
                },
              },
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "去连接" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Mock Close Settings" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "打开设置" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Mock Save Settings" }),
    );

    expect(
      screen.queryByText("媒体模型已保存，发送“继续”即可重试刚才的生成。"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveValue("");
  });

  it("replays durable run events on reconnect to recover missed media insertions", async () => {
    const imageGeneratedSpy = vi.fn();
    let replayListener:
      | ((entry: {
          event: Record<string, unknown>;
          replayed?: boolean;
          eventId?: string;
          seq?: number;
        }) => void)
      | null = null;
    fetchRunEventsMock.mockResolvedValue({
      done: true,
      nextCursor: 8,
      events: [
        {
          eventId: "run-reconnect:7",
          seq: 7,
          event: {
            type: "message.delta",
            runId: "run-reconnect",
            messageId: "assistant-reconnect",
            delta: "Recovered transcript",
            timestamp: "2026-06-04T00:00:00.000Z",
          },
        },
        {
          eventId: "run-reconnect:8",
          seq: 8,
          event: {
            type: "tool.completed",
            runId: "run-reconnect",
            toolCallId: "tool-1",
            toolName: "generate_image",
            artifacts: [
              {
                type: "image",
                title: "Recovered image",
                url: "https://example.com/recovered.png",
                mimeType: "image/png",
                width: 1024,
                height: 1024,
              },
            ],
            timestamp: "2026-06-04T00:00:00.000Z",
          },
        },
      ],
    });
    mockWs = {
      ...mockWs,
      onEvent: vi.fn((listener) => {
        replayListener = listener as typeof replayListener;
        return () => {
          replayListener = null;
        };
      }),
      resumeCanvas: vi.fn((_canvasId, _sessionId, onAck) => {
        onAck?.({
          type: "command.ack",
          action: "canvas.resume",
          payload: {
            canvasId: "canvas-1",
            latestSeq: 0,
            activeRunId: "run-reconnect",
            assistantMessageId: "assistant-reconnect",
            replayed: 0,
          },
        });
      }),
    };

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    await waitFor(() =>
      expect(fetchRunEventsMock).toHaveBeenCalledWith("run-reconnect", 0),
    );
    expect(await screen.findByText("Recovered transcript")).toBeInTheDocument();
    await waitFor(() => expect(imageGeneratedSpy).toHaveBeenCalledTimes(1));
    replayListener?.({
      replayed: true,
      eventId: "run-reconnect:8",
      seq: 99,
      event: {
        type: "tool.completed",
        runId: "run-reconnect",
        toolCallId: "tool-1",
        toolName: "generate_image",
        artifacts: [
          {
            type: "image",
            title: "Recovered image",
            url: "https://example.com/recovered.png",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
          },
        ],
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });
    await waitFor(() => expect(imageGeneratedSpy).toHaveBeenCalledTimes(1));
    expect(imageGeneratedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        url: "https://example.com/recovered.png",
      }),
    );
  });

  it("recovers persisted media artifacts from the latest assistant snapshot after reconnect", async () => {
    const imageGeneratedSpy = vi.fn();
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-saved",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-saved",
              toolName: "generate_image",
              status: "completed",
              artifacts: [
                {
                  type: "image",
                  title: "Recovered from snapshot",
                  url: "https://example.com/from-snapshot.png",
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    await waitFor(() => expect(imageGeneratedSpy).toHaveBeenCalledTimes(1));
    expect(imageGeneratedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        url: "https://example.com/from-snapshot.png",
      }),
    );
  });

  it("recovers persisted deferred image jobs in chat after reconnect", async () => {
    let onSucceeded: ((result: Record<string, unknown>) => void) | undefined;
    generationJobWatchMock.mockImplementation((_jobId, options) => {
      onSucceeded = options.onSucceeded;
      return {
        promise: new Promise(() => {}),
        unsubscribe: vi.fn(),
      };
    });
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-deferred",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-deferred-saved",
              toolName: "generate_image",
              status: "completed",
              output: {
                status: "generating",
                jobId: "job-saved-image",
                jobType: "image_generation",
                elementId: "generator-saved",
                title: "Saved deferred image",
              },
            },
          ],
        },
        {
          id: "assistant-latest",
          role: "assistant",
          content: "Later assistant message",
          createdAt: "2026-03-24T00:01:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "text",
              text: "Later assistant message",
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(generationJobWatchMock).toHaveBeenCalledWith(
        "job-saved-image",
        expect.objectContaining({ jobType: "image_generation" }),
      ),
    );

    act(() => {
      onSucceeded?.({
        signed_url: "https://example.com/saved.png",
        asset_id: "asset-saved",
        mime_type: "image/png",
        width: 1024,
        height: 1024,
      });
    });

    expect(
      await screen.findByRole("img", { name: "Saved deferred image" }),
    ).toHaveAttribute("src", "http://localhost:3000/local-assets/asset-saved");
  });

  it("does not reinsert persisted media when backend already inserted the canvas element", async () => {
    const imageGeneratedSpy = vi.fn();
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-saved",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-backend-inserted",
              toolName: "generate_image",
              status: "completed",
              output: {
                elementId: "canvas-element-1",
                imageUrl: "https://example.com/backend-inserted.png",
              },
              artifacts: [
                {
                  type: "image",
                  title: "Backend inserted",
                  url: "https://example.com/backend-inserted.png",
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText("Backend inserted")).toBeInTheDocument(),
    );
    expect(imageGeneratedSpy).not.toHaveBeenCalled();
  });

  it("does not reinsert persisted media when canvas has the matching persistent local asset url", async () => {
    const imageGeneratedSpy = vi.fn();
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "assistant-saved",
          role: "assistant",
          content: "",
          createdAt: "2026-03-24T00:00:00.000Z",
          toolActivities: null,
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-local-asset",
              toolName: "generate_image",
              status: "completed",
              artifacts: [
                {
                  type: "image",
                  assetId: "asset-1",
                  title: "Already on canvas",
                  url: "http://localhost:3000/local-assets/asset-1",
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          ],
        },
      ],
    });

    render(
      <ToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          onImageGenerated={imageGeneratedSpy}
          onRequestCanvasImages={() => [
            {
              kind: "canvas-image",
              id: "canvas-image-1",
              name: "Already on canvas",
              thumbnailUrl: "data:image/png;base64,abc",
              assetId: "asset-1",
              url: "/local-assets/asset-1",
              mimeType: "image/png",
            },
          ]}
          ws={mockWs}
        />
      </ToastProvider>,
    );

    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText("Already on canvas")).toBeInTheDocument(),
    );
    expect(imageGeneratedSpy).not.toHaveBeenCalled();
  });
});
