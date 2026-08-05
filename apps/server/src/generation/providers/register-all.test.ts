import { afterEach, describe, expect, it, vi } from "vitest";

import { loadServerEnv } from "../../config/env.js";
import { registerAllProviders } from "./register-all.js";
import {
  clearProviders,
  getAvailableImageModels,
  getAvailableVideoModels,
} from "./registry.js";

describe("registerAllProviders", () => {
  afterEach(() => {
    clearProviders();
  });

  it("registers Kie image and video providers when configured", () => {
    registerAllProviders(loadServerEnv({ kieApiKey: "test-kie-key" }, {}));

    expect(getAvailableImageModels().map((model) => model.id)).toContain(
      "kie/nano-banana-pro",
    );
    expect(getAvailableVideoModels().map((model) => model.id)).toContain(
      "kie/veo-3.1",
    );
  });

  it("registers OpenAI image models when the default official endpoint is used", () => {
    registerAllProviders(loadServerEnv({ openAIApiKey: "sk-openai" }, {}));

    expect(getAvailableImageModels()).toContainEqual(
      expect.objectContaining({
        id: "gpt-image-2",
        provider: "openai",
      }),
    );
  });

  it("registers OpenAI image models for the explicit official endpoint", () => {
    registerAllProviders(
      loadServerEnv(
        {
          openAIApiKey: "sk-openai",
          openAIApiBase: "https://api.openai.com/v1",
        },
        {},
      ),
    );

    expect(getAvailableImageModels()).toContainEqual(
      expect.objectContaining({
        id: "gpt-image-2",
        provider: "openai",
      }),
    );
  });

  it("registers OpenAI image models for a custom compatible endpoint", () => {
    registerAllProviders(
      loadServerEnv(
        {
          openAIApiKey: "sk-compatible",
          openAIApiBase: "https://gateway.example/custom/openai/v1",
        },
        {},
      ),
    );

    expect(getAvailableImageModels()).toContainEqual(
      expect.objectContaining({
        id: "gpt-image-2",
        provider: "openai",
      }),
    );
  });

  it("does not register OpenAI image models for an invalid Base URL", () => {
    registerAllProviders(
      loadServerEnv(
        {
          openAIApiKey: "sk-compatible",
          openAIApiBase: "not-a-url",
        },
        {},
      ),
    );

    expect(getAvailableImageModels()).not.toContainEqual(
      expect.objectContaining({
        id: "gpt-image-2",
        provider: "openai",
      }),
    );
  });

  it("registers Codex Imagegen models when default-enabled and ready", () => {
    registerAllProviders(loadServerEnv({}, {}), {
      detectCodexImagegenCapability: () => ({
        ready: true,
        reasons: [],
        checkedAt: "2026-06-15T00:00:00.000Z",
      }),
    });

    expect(getAvailableImageModels()).toContainEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
        provider: "codex-imagegen",
      }),
    );
  });

  it("defers Codex capability resolution to the configured Tutti Agent Target", () => {
    const detectCodexImagegenCapability = vi.fn(() => {
      throw new Error("PATH-based detection must not run in a Tutti workspace");
    });

    registerAllProviders(
      loadServerEnv(
        { tuttiCliPath: "C:\\Program Files\\Tutti\\tutti.exe" },
        {},
      ),
      { detectCodexImagegenCapability },
    );

    expect(detectCodexImagegenCapability).not.toHaveBeenCalled();
    expect(getAvailableImageModels()).toContainEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
        provider: "codex-imagegen",
      }),
    );
  });

  it("orders Codex Imagegen before API-backed image models when ready", () => {
    registerAllProviders(loadServerEnv({ kieApiKey: "test-kie-key" }, {}), {
      detectCodexImagegenCapability: () => ({
        ready: true,
        reasons: [],
        checkedAt: "2026-06-15T00:00:00.000Z",
      }),
    });

    expect(getAvailableImageModels()[0]).toEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
        provider: "codex-imagegen",
      }),
    );
  });

  it("does not register Codex Imagegen when explicitly disabled", () => {
    registerAllProviders(
      loadServerEnv({}, { AIMC_CODEX_IMAGEGEN_ENABLED: "false" }),
      {
        detectCodexImagegenCapability: () => {
          throw new Error("capability detection should not run when disabled");
        },
      },
    );

    expect(getAvailableImageModels()).not.toContainEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
      }),
    );
  });

  it("does not register Codex Imagegen when capability detection fails", () => {
    registerAllProviders(loadServerEnv({}, {}), {
      detectCodexImagegenCapability: () => ({
        ready: false,
        reasons: ["codex_not_logged_in"],
        checkedAt: "2026-06-15T00:00:00.000Z",
      }),
    });

    expect(getAvailableImageModels()).not.toContainEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
      }),
    );
  });

  it("logs Codex Imagegen capability detection failures", () => {
    const logger = { info: vi.fn() };

    registerAllProviders(loadServerEnv({}, {}), {
      detectCodexImagegenCapability: () => ({
        ready: false,
        reasons: ["image_generation_unavailable"],
        codexVersion: "0.124.0",
        codexHome: "/tmp/codex-home",
        checkedAt: "2026-06-29T00:00:00.000Z",
      }),
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        provider: "codex-imagegen",
        ready: false,
        reasons: ["image_generation_unavailable"],
        codexVersion: "0.124.0",
        codexHome: "/tmp/codex-home",
      },
      "Codex Imagegen provider unavailable.",
    );
  });
});
