// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentModelState,
  fetchModelsMock,
  fetchWorkspaceSettingsMock,
  setModelMock,
} = vi.hoisted(() => ({
  agentModelState: {
    agentTargetId: undefined as string | undefined,
    model: null as string | null,
    modelSource: undefined as "local-agent" | undefined,
  },
  fetchModelsMock: vi.fn(),
  fetchWorkspaceSettingsMock: vi.fn(),
  setModelMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchModels: async (...args: unknown[]) => {
    const response = await fetchModelsMock(...args);
    if (Array.isArray(response?.localAgentProviders)) return response;
    const localModels = Array.isArray(response?.models)
      ? response.models.filter(
          (model: { provider?: string }) =>
            model.provider === "codex" || model.provider === "claude-code",
        )
      : [];
    const providers = new Map<string, typeof localModels>();
    for (const model of localModels) {
      const models = providers.get(model.provider) ?? [];
      models.push(model);
      providers.set(model.provider, models);
    }
    return {
      ...response,
      localAgentProviders: Array.from(providers, ([provider, models]) => ({
        provider,
        displayName: provider === "claude-code" ? "Claude Code" : "Codex",
        supported: true,
        authState: "ok",
        models,
      })),
    };
  },
  fetchWorkspaceSettings: fetchWorkspaceSettingsMock,
}));

vi.mock("../src/hooks/use-agent-model", () => ({
  useAgentModel: () => ({
    agentTargetId: agentModelState.agentTargetId,
    model: agentModelState.model,
    modelSource: agentModelState.modelSource,
    setModel: setModelMock,
  }),
}));

vi.mock("../src/components/settings-dialog", () => ({
  SettingsDialog: ({
    initialAgentSourceTab,
    initialTab,
    open,
  }: {
    initialAgentSourceTab?: string;
    initialTab?: string;
    open: boolean;
  }) =>
    open ? (
      <div data-testid="settings-dialog">
        {initialTab ?? "agent"}
        {initialAgentSourceTab ? `:${initialAgentSourceTab}` : ""}
      </div>
    ) : null,
}));

import { AgentModelSelector } from "../src/components/agent-model-selector";
import { i18n } from "../src/i18n";
import { WORKSPACE_SETTINGS_UPDATED_EVENT } from "../src/lib/workspace-settings-events";

describe("AgentModelSelector", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    fetchModelsMock.mockReset();
    fetchWorkspaceSettingsMock.mockReset();
    setModelMock.mockReset();
    agentModelState.model = null;
    agentModelState.modelSource = undefined;
    agentModelState.agentTargetId = undefined;
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "openai:gpt-5.4",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.defineProperty(window, "tuttiExternal", {
      configurable: true,
      value: undefined,
    });
  });

  it("renders a tooltip label for the compact model trigger", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "codex:default", name: "Codex", provider: "codex" }],
    });
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });

    render(<AgentModelSelector compact />);

    expect(await screen.findByText("Select agent model")).toBeInTheDocument();
  });

  it("renders localized trigger copy in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "codex:default", name: "Codex", provider: "codex" }],
    });
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });

    render(<AgentModelSelector compact />);

    expect(await screen.findByText("选择 Agent 模型")).toBeInTheDocument();
  });

  it("can place the compact model trigger tooltip below the trigger", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "codex:default", name: "Codex", provider: "codex" }],
    });
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });

    render(<AgentModelSelector compact tooltipPlacement="bottom" />);

    expect(await screen.findByText("Select agent model")).toHaveClass(
      "top-full",
    );
  });

  it("shows local CLI provider icons in the model groups", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [
        { id: "codex:gpt-5.5", name: "GPT-5.5", provider: "codex" },
        {
          id: "claude-code:default",
          name: "Default (CLI config)",
          provider: "claude-code",
        },
      ],
    });

    render(<AgentModelSelector compact />);

    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));

    await screen.findByText("Claude Code");
    const codexHeading = screen
      .getAllByText("Codex")
      .find((element) => element.tagName === "DIV");
    const claudeHeading = await screen.findByText("Claude Code");

    if (!codexHeading) {
      throw new Error("Codex provider heading was not rendered.");
    }
    expect(codexHeading.firstElementChild?.tagName).toBe("SPAN");
    expect(claudeHeading.firstElementChild?.tagName).toBe("SPAN");
    expect(codexHeading.firstElementChild).toHaveClass("size-4");
    expect(claudeHeading.firstElementChild).toHaveClass("size-4");
  });

  it("keeps an enabled but unauthenticated Tutti Agent visible and disabled", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "tutti-agent",
          displayName: "Tutti Agent",
          supported: false,
          authState: "missing",
          reason: "Tutti Agent is not logged in.",
          models: [],
        },
      ],
    });

    render(<AgentModelSelector compact />);

    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));
    expect(await screen.findByText("Tutti Agent")).toBeInTheDocument();
    expect(
      screen.getByText("Tutti Agent is not logged in."),
    ).toBeInTheDocument();
    expect(setModelMock).not.toHaveBeenCalled();
  });

  it("disables model buttons for an unavailable exact Agent Target", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex Runtime",
          supported: true,
          authState: "ok",
          models: [{ id: "codex:default", name: "Default", provider: "codex" }],
        },
      ],
      localAgentTargets: [
        {
          agentTargetId: "team:offline",
          providerId: "codex",
          displayName: "Offline Reviewer",
          available: false,
          runtimeSupported: true,
          isDefault: false,
          reason: "This Agent Target is unavailable.",
          models: [{ id: "codex:default", name: "Default", provider: "codex" }],
        },
      ],
    });

    render(<AgentModelSelector compact />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Agent/i }),
    );

    const modelButton = await screen.findByRole("button", { name: "Default" });
    expect(modelButton).toBeDisabled();
    await userEvent.click(modelButton);
    expect(setModelMock).not.toHaveBeenCalled();
  });

  it("renders host icons by exact Agent Target id", async () => {
    Object.defineProperty(window, "tuttiExternal", {
      configurable: true,
      value: {
        agentActivity: {
          listTargets: async () => ({
            agents: [
              {
                agentTargetId: "team:alpha",
                availability: { status: "ready" },
                description: null,
                iconUrl: "data:image/webp;base64,alpha",
                name: "Alpha",
                provider: "codex",
              },
              {
                agentTargetId: "team:beta",
                availability: { status: "ready" },
                description: null,
                iconUrl: "data:image/webp;base64,beta",
                name: "Beta",
                provider: "codex",
              },
            ],
            capturedAtUnixMs: 123,
            error: null,
            status: "ready",
          }),
        },
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex",
          supported: true,
          authState: "ok",
          models: [],
        },
      ],
      localAgentTargets: [
        {
          agentTargetId: "team:alpha",
          providerId: "codex",
          displayName: "Alpha",
          available: true,
          runtimeSupported: true,
          isDefault: true,
          models: [{ id: "codex:default", name: "Default", provider: "codex" }],
        },
        {
          agentTargetId: "team:beta",
          providerId: "codex",
          displayName: "Beta",
          available: true,
          runtimeSupported: true,
          isDefault: false,
          models: [{ id: "codex:default", name: "Default", provider: "codex" }],
        },
      ],
    });

    render(<AgentModelSelector compact />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Agent/i }),
    );

    await waitFor(() => {
      expect(
        document.querySelector('img[src="data:image/webp;base64,alpha"]'),
      ).toBeInTheDocument();
      expect(
        document.querySelector('img[src="data:image/webp;base64,beta"]'),
      ).toBeInTheDocument();
    });

    const alphaIcon = document.querySelector(
      'img[src="data:image/webp;base64,alpha"]',
    );
    if (!(alphaIcon instanceof HTMLImageElement)) {
      throw new Error("Alpha Host icon was not rendered.");
    }
    fireEvent.error(alphaIcon);
    expect(
      document.querySelector('img[src="data:image/webp;base64,alpha"]'),
    ).not.toBeInTheDocument();
  });

  it("shows a degraded discovery reason for a supported local provider", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "codex:default", name: "Default", provider: "codex" }],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex",
          supported: true,
          authState: "ok",
          reason: "Model discovery timed out; using the configured default.",
          models: [{ id: "codex:default", name: "Default", provider: "codex" }],
        },
      ],
    });

    render(<AgentModelSelector compact />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Agent/i }),
    );
    expect(
      await screen.findByText(
        "Model discovery timed out; using the configured default.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps stale providers visible while reporting a refresh failure", async () => {
    fetchModelsMock
      .mockResolvedValueOnce({
        models: [{ id: "codex:default", name: "Default", provider: "codex" }],
      })
      .mockRejectedValueOnce(new Error("refresh failed"));

    render(<AgentModelSelector compact />);
    await waitFor(() => expect(fetchModelsMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));

    expect(await screen.findByText("Default")).toBeInTheDocument();
    expect(
      await screen.findByText(
        i18n.t("agentModelSelector.loadModelsError", { ns: "chat" }),
      ),
    ).toBeInTheDocument();
  });

  it("does not present an unavailable local provider as the active selection", async () => {
    agentModelState.model = "tutti-agent:default";
    agentModelState.modelSource = "local-agent";
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "tutti-agent:default",
        defaultModelSource: "local-agent",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "tutti-agent:default",
          name: "Default (CLI config)",
          provider: "tutti-agent",
        },
      ],
      localAgentProviders: [
        {
          provider: "tutti-agent",
          displayName: "Tutti Agent",
          supported: false,
          authState: "missing",
          reason: "Tutti Agent is not logged in.",
          models: [],
        },
      ],
    });

    render(<AgentModelSelector compact />);

    const trigger = await screen.findByRole("button", { name: /^Agent$/ });
    await userEvent.click(trigger);

    expect(
      await screen.findByText("Uses your configured default route"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tutti Agent is not logged in."),
    ).toBeInTheDocument();
  });

  it("shows the default local CLI provider in the trigger", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "codex:default",
          name: "Default (CLI config)",
          provider: "codex",
        },
        { id: "codex:gpt-5.5", name: "gpt-5.5", provider: "codex" },
      ],
    });

    render(<AgentModelSelector compact />);

    expect(
      await screen.findByRole("button", { name: /Codex/i }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Codex/i }));
    expect(
      await screen.findByText("Uses default model: Default (CLI config)"),
    ).toBeInTheDocument();
  });

  it("uses a static provider outline for the active local CLI trigger", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "codex:default",
          name: "Default (CLI config)",
          provider: "codex",
        },
      ],
    });

    render(<AgentModelSelector compact />);

    const trigger = await screen.findByRole("button", { name: /Codex/i });
    expect(trigger).not.toHaveClass("agent-model-trigger-wave");
    expect(trigger).toHaveClass("border-[#6F7CFF]");
    expect(trigger).toHaveClass("text-[#4F5DFF]");
    expect(trigger).toHaveClass("bg-background");
    expect(trigger).not.toHaveClass("border-accent");
    expect(
      trigger.querySelector(".agent-model-trigger-mask"),
    ).not.toBeInTheDocument();
  });

  it("preserves the local CLI default model when Default CLI config is clicked", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:default",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "codex:default",
          name: "Default (CLI config)",
          provider: "codex",
        },
        { id: "codex:gpt-5.5", name: "gpt-5.5", provider: "codex" },
      ],
    });

    render(<AgentModelSelector compact />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Codex/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Default (CLI config)" }),
    );

    expect(setModelMock).toHaveBeenCalledWith(
      "codex:default",
      "local-agent",
      "local:codex",
    );
  });

  it("refreshes the trigger when workspace settings are saved elsewhere", async () => {
    fetchWorkspaceSettingsMock
      .mockResolvedValueOnce({
        settings: {
          defaultModel: "codex:default",
        },
      })
      .mockResolvedValueOnce({
        settings: {
          defaultModel: "claude-code:default",
        },
      });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "codex:default",
          name: "Default (CLI config)",
          provider: "codex",
        },
        {
          id: "claude-code:default",
          name: "Default (CLI config)",
          provider: "claude-code",
        },
      ],
    });

    render(<AgentModelSelector compact />);

    expect(
      await screen.findByRole("button", { name: /Codex/i }),
    ).toBeInTheDocument();

    window.dispatchEvent(new Event(WORKSPACE_SETTINGS_UPDATED_EVENT));

    expect(
      await screen.findByRole("button", { name: /Claude Code/i }),
    ).toBeInTheDocument();
  });

  it("keeps the picker scrollable when the model list is taller than the viewport", async () => {
    fetchModelsMock.mockResolvedValue({
      models: Array.from({ length: 20 }, (_, index) => ({
        id: `openai:model-${index + 1}`,
        name: `model-${index + 1}`,
        provider: "openai",
      })),
    });

    const { container } = render(<AgentModelSelector compact />);

    await waitFor(() => expect(fetchModelsMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));

    const popover = container.ownerDocument.querySelector(".overflow-y-auto");
    expect(popover).toHaveClass("max-h-[min(28rem,calc(100vh-2rem))]");
    expect(popover).toHaveClass("overflow-y-auto");
  });
});
