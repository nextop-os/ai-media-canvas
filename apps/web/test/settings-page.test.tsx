// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "../src/app/(workspace)/settings/page";
import { SettingsDialog } from "../src/components/settings-dialog";
import {
  AIMC_LOCALE_COOKIE_NAME,
  AIMC_LOCALE_STORAGE_KEY,
  i18n,
} from "../src/i18n";

const {
  fetchWorkspaceSettingsMock,
  fetchModelsMock,
  updateWorkspaceSettingsMock,
} = vi.hoisted(() => ({
  fetchWorkspaceSettingsMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  updateWorkspaceSettingsMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchModels: fetchModelsMock,
  fetchWorkspaceSettings: fetchWorkspaceSettingsMock,
  updateWorkspaceSettings: updateWorkspaceSettingsMock,
}));

const EMPTY_PROVIDER_MODELS = {
  openai: [],
  anthropic: [],
  agnes: [],
  google: [],
  vertex: [],
};

describe("SettingsPage", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    document.cookie = `${AIMC_LOCALE_COOKIE_NAME}=; Max-Age=0; path=/`;
    document.documentElement.lang = "";
    void i18n.changeLanguage("en");
    fetchWorkspaceSettingsMock.mockReset();
    fetchModelsMock.mockReset();
    updateWorkspaceSettingsMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [] });
  });

  afterEach(() => {
    cleanup();
    (
      window as Window & {
        tuttiExternal?: unknown;
      }
    ).tuttiExternal = undefined;
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("switches language from the General tab and persists the preference", async () => {
    void i18n.changeLanguage("zh-CN");
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /通用/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "语言" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "English" }),
    );

    expect(await screen.findByText("Language")).toBeInTheDocument();
    expect(window.localStorage.getItem(AIMC_LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.cookie).toContain(`${AIMC_LOCALE_COOKIE_NAME}=en`);
    expect(document.documentElement.lang).toBe("en");
  });

  it("shows a retry state instead of rendering blank when the initial load fails", async () => {
    fetchWorkspaceSettingsMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        settings: {
          defaultModel: "",
          providerModels: EMPTY_PROVIDER_MODELS,
          openAIApiKey: "",
          openAIApiBase: "",
          anthropicApiKey: "",
          anthropicBaseUrl: "",
          agnesApiKey: "",
          agnesBaseUrl: "",
          agnesDefaultModel: "",
          googleApiKey: "",
          googleVertexProject: "",
          googleVertexLocation: "",
          googleVertexVideoLocation: "",
          replicateApiToken: "",
          kieApiKey: "",
          kieBaseUrl: "",
          volcesApiKey: "",
          volcesBaseUrl: "",
        },
      });

    render(<SettingsPage />);

    await screen.findByText("Failed to load local settings. Please try again.");
    const retryButton = screen.getByRole("button", { name: "Retry" });
    await userEvent.click(retryButton);
    expect(await screen.findByText("Local agent")).toBeInTheDocument();
  });

  it("shows Media settings across image and video provider tabs", async () => {
    updateWorkspaceSettingsMock.mockImplementation(async (settings) => ({
      settings,
    }));
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "openai:gpt-4.1",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "sk-local-agnes",
        agnesBaseUrl: "https://agnes.example/v1",
        agnesDefaultModel: "agnes:agnes-2.0-flash",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "replicate-local-token",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "volces-local-key",
        volcesBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      },
    });

    render(<SettingsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /^Media\b/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Media Generation" }),
    ).toBeInTheDocument();
    const agnesHeading = await screen.findByRole("heading", { name: "Agnes" });
    expect(agnesHeading).toBeInTheDocument();
    expect(screen.getByText("Codex image permission")).toBeInTheDocument();
    const codexHeading = screen.getByRole("heading", {
      name: "Codex image permission",
    });
    const codexCard = codexHeading.closest(".rounded-xl");
    expect(codexCard).not.toBeNull();
    await userEvent.click(
      within(codexCard as HTMLElement).getByRole("button", {
        name: "Settings",
      }),
    );
    expect(
      within(codexCard as HTMLElement).getByRole("combobox", {
        name: "Codex image permission",
      }),
    ).toHaveTextContent("Ask each time");

    const agnesCard = agnesHeading.closest(".rounded-xl");
    expect(agnesCard).not.toBeNull();
    await userEvent.click(
      within(agnesCard as HTMLElement).getByRole("button", {
        name: "Settings",
      }),
    );
    expect(screen.getByDisplayValue("sk-local-agnes")).toBeInTheDocument();
    expect(
      within(agnesCard as HTMLElement).getByRole("link", {
        name: "Get Agnes API Key",
      }),
    ).toHaveAttribute("href", "https://platform.agnes-ai.com/settings/apiKeys");
    expect(
      within(agnesCard as HTMLElement).getByRole("link", {
        name: "Quick Start Docs",
      }),
    ).toHaveAttribute("href", "https://agnes-ai.com/doc/quick-start");

    await userEvent.clear(screen.getByDisplayValue("sk-local-agnes"));
    await userEvent.type(screen.getByLabelText("Agnes API Key"), "sk-updated");
    expect(
      within(codexCard as HTMLElement).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    expect(
      within(agnesCard as HTMLElement).getByRole("button", { name: "Save" }),
    ).toBeEnabled();

    await userEvent.click(
      within(codexCard as HTMLElement).getByRole("combobox", {
        name: "Codex image permission",
      }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Use by default" }),
    );
    await userEvent.click(
      within(codexCard as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() =>
      expect(updateWorkspaceSettingsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agnesApiKey: "sk-local-agnes",
          codexImagegenDelegation: "always",
        }),
      ),
    );
    expect(screen.getByLabelText("Agnes API Key")).toHaveValue("sk-updated");

    const openAIHeading = screen.getByRole("heading", { name: "OpenAI" });
    const openAICard = openAIHeading.closest(".rounded-lg");
    expect(openAICard).not.toBeNull();
    await userEvent.click(
      within(openAICard as HTMLElement).getByRole("button", {
        name: "Add",
      }),
    );
    expect(
      within(openAICard as HTMLElement).getByText("GPT Image 2"),
    ).toBeInTheDocument();
    expect(
      within(openAICard as HTMLElement).getByText("GPT Image 1.5"),
    ).toBeInTheDocument();
    expect(
      within(openAICard as HTMLElement).queryByText("GPT Image 1"),
    ).not.toBeInTheDocument();
    expect(
      within(openAICard as HTMLElement).queryByText("GPT Image 1 Mini"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Video" }));

    const replicateHeading = await screen.findByRole("heading", {
      name: "Replicate",
    });
    expect(replicateHeading).toBeInTheDocument();
    const replicateCard = replicateHeading.closest(".rounded-xl");
    expect(replicateCard).not.toBeNull();
    await userEvent.click(
      within(replicateCard as HTMLElement).getByRole("button", {
        name: "Settings",
      }),
    );
    expect(screen.getByText("Seedance 1.5 Pro")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("replicate-local-token"),
    ).toBeInTheDocument();
    expect(
      within(replicateCard as HTMLElement).getByRole("link", {
        name: "Get Replicate API Key",
      }),
    ).toHaveAttribute("href", "https://replicate.com/account/api-tokens");
  });

  it("localizes Media settings copy in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "openai:gpt-4.1",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });

    render(<SettingsPage />);

    await userEvent.click(await screen.findByText("媒体"));

    expect(await screen.findByText("媒体生成")).toBeInTheDocument();
    expect(
      screen.getByText("连接 AI 服务，用来生成图片和视频。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "图片" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "视频" })).toBeInTheDocument();
    expect(screen.getAllByText("未配置").length).toBeGreaterThan(0);
    expect(screen.getByText("手动添加")).toBeInTheDocument();
    expect(screen.getByText("Codex 生图权限")).toBeInTheDocument();
    const codexHeading = screen.getByRole("heading", {
      name: "Codex 生图权限",
    });
    const codexCard = codexHeading.closest(".rounded-xl");
    expect(codexCard).not.toBeNull();
    await userEvent.click(
      within(codexCard as HTMLElement).getByRole("button", {
        name: "设置",
      }),
    );
    expect(
      within(codexCard as HTMLElement).getByRole("combobox", {
        name: "Codex 生图权限",
      }),
    ).toHaveTextContent("每次询问");
    expect(screen.queryByText("Media Providers")).not.toBeInTheDocument();
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument();
  });

  it("uses the provider-declared default when a Local agent provider is selected", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
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
        { id: "codex:gpt-5.4", name: "gpt-5.4", provider: "codex" },
      ],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex",
          supported: true,
          authState: "ok",
          defaultModelId: "codex:gpt-5.4",
          models: [
            {
              id: "codex:default",
              name: "Default (CLI config)",
              provider: "codex",
            },
            { id: "codex:gpt-5.5", name: "gpt-5.5", provider: "codex" },
            { id: "codex:gpt-5.4", name: "gpt-5.4", provider: "codex" },
          ],
        },
      ],
    });
    updateWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:gpt-5.4",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });

    render(<SettingsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Codex/i }),
    );

    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateWorkspaceSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultModel: "codex:gpt-5.4",
        }),
      ),
    );
  });

  it("keeps unavailable Local agent providers actionable for setup", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "vendor-agent",
          displayName: "Vendor Agent",
          supported: true,
          authState: "ok",
          models: [],
        },
      ],
    });

    render(<SettingsPage />);

    expect(
      await screen.findByRole("button", { name: /Vendor Agent/i }),
    ).not.toBeDisabled();
  });

  it("keeps the Agent save action in a fixed bottom footer", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "codex:gpt-5.4",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "codex:gpt-5.4", name: "Codex", provider: "codex" }],
    });

    render(<SettingsPage />);

    await screen.findByRole("button", { name: "Save" });
    const saveFooter = screen.getByTestId("agent-settings-save-footer");
    expect(saveFooter).toHaveClass("sticky");
    expect(saveFooter).toContainElement(
      screen.getByRole("button", { name: "Save" }),
    );
  });

  it("closes the settings dialog after a successful media provider save", async () => {
    const onOpenChange = vi.fn();
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "sk-old-agnes",
        agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    updateWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "sk-agnes",
        agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });

    render(
      <SettingsDialog
        open
        onOpenChange={onOpenChange}
        initialTab="media"
        onSaved={() => onOpenChange(false)}
      />,
    );

    const agnesHeading = await screen.findByRole("heading", { name: "Agnes" });
    const agnesSection = agnesHeading.closest(".rounded-xl");
    expect(agnesSection).not.toBeNull();
    await userEvent.click(
      within(agnesSection as HTMLElement).getByRole("button", {
        name: "Settings",
      }),
    );
    await userEvent.clear(await screen.findByLabelText("Agnes API Key"));
    await userEvent.type(screen.getByLabelText("Agnes API Key"), "sk-agnes");
    await userEvent.click(
      within(agnesSection as HTMLElement).getByRole("button", {
        name: "Save",
      }),
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("opens the generic Tutti manager for unavailable local Agent runtimes without rescanning", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    const openFeature = vi.fn().mockResolvedValue(undefined);
    (
      window as Window & {
        tuttiExternal?: {
          workspace?: {
            openFeature?: typeof openFeature;
          };
        };
      }
    ).tuttiExternal = {
      workspace: { openFeature },
    };
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex",
          supported: false,
          authState: "missing",
          reason: "Sign in with Tutti Agent Manager.",
          models: [],
        },
        {
          provider: "future-runtime",
          displayName: "Future Runtime",
          supported: false,
          authState: "missing",
          reason: "Sign in with Tutti Agent Manager.",
          models: [],
        },
      ],
    });

    render(<SettingsPage />);

    const codexButton = await screen.findByRole("button", { name: /Codex/i });
    const futureButton = screen.getByRole("button", {
      name: /Future Runtime/i,
    });

    expect(codexButton).toBeEnabled();
    expect(futureButton).toBeEnabled();
    expect(
      screen.getAllByText("Sign in with Tutti Agent Manager."),
    ).toHaveLength(2);
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();

    await userEvent.click(codexButton);

    expect(openFeature).toHaveBeenCalledWith({
      feature: "agent-manage",
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/Tutti agent manager opened/i),
    ).toBeInTheDocument();

    await userEvent.click(futureButton);

    expect(openFeature).toHaveBeenLastCalledWith({
      feature: "agent-manage",
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));

    await waitFor(() => expect(fetchModelsMock).toHaveBeenCalledTimes(2));
    expect(fetchModelsMock).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("shows an error when the Tutti agent manager bridge is unavailable", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [],
      localAgentProviders: [
        {
          provider: "codex",
          displayName: "Codex",
          supported: false,
          authState: "missing",
          reason: "Sign in with Tutti Agent Manager.",
          models: [],
        },
      ],
    });

    render(<SettingsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Codex/i }),
    );

    expect(
      await screen.findByText(
        "Open AI Canvas inside Tutti to manage local agents.",
      ),
    ).toBeInTheDocument();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
  });

  it("does not preselect a Local agent provider when no local model is selected", async () => {
    fetchWorkspaceSettingsMock.mockResolvedValue({
      settings: {
        defaultModel: "",
        providerModels: EMPTY_PROVIDER_MODELS,
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "",
        agnesBaseUrl: "",
        agnesDefaultModel: "",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    });
    fetchModelsMock.mockResolvedValue({
      models: [
        {
          id: "claude-code:sonnet",
          name: "Sonnet",
          provider: "claude-code",
        },
        { id: "codex:gpt-5.4", name: "Codex", provider: "codex" },
      ],
      localAgentProviders: [
        {
          provider: "claude-code",
          displayName: "Claude Code",
          supported: true,
          authState: "ok",
          models: [
            {
              id: "claude-code:sonnet",
              name: "Sonnet",
              provider: "claude-code",
            },
          ],
        },
        {
          provider: "codex",
          displayName: "Codex",
          supported: true,
          authState: "ok",
          models: [{ id: "codex:gpt-5.4", name: "Codex", provider: "codex" }],
        },
      ],
    });

    render(<SettingsPage />);

    const claudeButton = await screen.findByRole("button", {
      name: /Claude Code/i,
    });
    const codexButton = screen.getByRole("button", { name: /Codex/i });

    expect(claudeButton).toHaveAttribute("aria-pressed", "false");
    expect(codexButton).toHaveAttribute("aria-pressed", "false");
    expect(
      claudeButton.compareDocumentPosition(codexButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });
});

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}
