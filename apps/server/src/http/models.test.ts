import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalAgentModelDetectContext } from "../agent/local-agent-models.js";
import { loadServerEnv } from "../config/env.js";
import {
  listAgentModelCatalog,
  listAgentModels,
  registerModelRoutes,
} from "./models.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("registerModelRoutes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  const fetchMock = vi.fn();
  const emptyLocalAgentModelDiscovery = {
    detect: vi.fn(async () => []),
  };

  beforeEach(() => {
    fetchMock.mockReset();
    emptyLocalAgentModelDiscovery.detect.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("loads trusted local agent mode from the environment", () => {
    expect(
      loadServerEnv({}, { AIMC_TRUSTED_LOCAL_AGENT_MODE: "false" })
        .trustedLocalAgentMode,
    ).toBe(false);
    expect(loadServerEnv({}, {}).trustedLocalAgentMode).toBe(true);
  });

  it("includes local-agent models from package discovery", async () => {
    const localAgentModelDiscovery = {
      detect: vi.fn(async (_context?: LocalAgentModelDetectContext) => [
        {
          agentTargetId: "local:codex",
          provider: "codex" as const,
          displayName: "Codex CLI",
          authState: "ok" as const,
          models: [
            { id: "default", label: "Default (CLI config)" },
            { id: "gpt-live", label: "gpt-live" },
          ],
          supported: true,
        },
        {
          agentTargetId: "local:claude-code",
          provider: "claude-code" as const,
          displayName: "Claude Code",
          authState: "ok" as const,
          models: [
            {
              id: "sonnet",
              label: "Sonnet (alias)",
              description: "Custom Sonnet model",
            },
            { id: "claude:opus", label: "Scoped Opus" },
          ],
          supported: true,
        },
        {
          agentTargetId: "local:hermes",
          provider: "hermes" as const,
          displayName: "Hermes",
          authState: "ok" as const,
          models: [{ id: "openai-codex:gpt-5.4", label: "Hermes GPT" }],
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      undefined,
      { localAgentModelDiscovery },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/models",
    });

    expect(response.statusCode).toBe(200);
    const models = response.json().models;
    expect(models).toEqual(
      expect.arrayContaining([
        {
          id: "codex:default",
          name: "Default (CLI config)",
          provider: "codex",
          source: "local-agent",
        },
        {
          id: "codex:gpt-live",
          name: "gpt-live",
          provider: "codex",
          source: "local-agent",
        },
        {
          id: "claude-code:sonnet",
          name: "Sonnet (alias)",
          description: "Custom Sonnet model",
          provider: "claude-code",
          source: "local-agent",
        },
        {
          id: "claude-code:claude:opus",
          name: "Scoped Opus",
          provider: "claude-code",
          source: "local-agent",
        },
      ]),
    );
    expect(models).not.toContainEqual(
      expect.objectContaining({ provider: "hermes" }),
    );
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledTimes(1);
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expect.any(String) }),
    );
  });

  it("coalesces normal and refresh model detection independently", async () => {
    const normal = deferred<[]>();
    const refresh = deferred<[]>();
    const localAgentModelDiscovery = {
      detect: vi.fn((context?: LocalAgentModelDetectContext) =>
        context?.refresh ? refresh.promise : normal.promise,
      ),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv({ agentModel: "openai:gpt-4.1" }, {}),
      undefined,
      { localAgentModelDiscovery },
    );

    const normalRequests = [
      app.inject({ method: "GET", url: "/api/models" }),
      app.inject({ method: "GET", url: "/api/models" }),
    ];
    await vi.waitFor(() =>
      expect(localAgentModelDiscovery.detect).toHaveBeenCalledTimes(1),
    );
    normal.resolve([]);
    await Promise.all(normalRequests);

    const refreshRequests = [
      app.inject({ method: "GET", url: "/api/models?refresh=1" }),
      app.inject({
        method: "POST",
        url: "/api/models",
        payload: { refresh: true },
      }),
    ];
    await vi.waitFor(() =>
      expect(localAgentModelDiscovery.detect).toHaveBeenCalledTimes(2),
    );
    refresh.resolve([]);
    await Promise.all(refreshRequests);
    expect(localAgentModelDiscovery.detect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ refresh: true }),
    );
  });

  it("does not join a refresh to an in-flight normal detection", async () => {
    const normal = deferred<[]>();
    const refresh = deferred<[]>();
    const localAgentModelDiscovery = {
      detect: vi.fn((context?: LocalAgentModelDetectContext) =>
        context?.refresh ? refresh.promise : normal.promise,
      ),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv({ agentModel: "openai:gpt-4.1" }, {}),
      undefined,
      { localAgentModelDiscovery },
    );

    const normalRequest = app.inject({ method: "GET", url: "/api/models" });
    const refreshRequest = app.inject({
      method: "GET",
      url: "/api/models?refresh=1",
    });
    await vi.waitFor(() =>
      expect(localAgentModelDiscovery.detect).toHaveBeenCalledTimes(2),
    );
    normal.resolve([]);
    refresh.resolve([]);
    await Promise.all([normalRequest, refreshRequest]);
  });

  it("bypasses cached local-agent detection when model refresh is requested", async () => {
    const localAgentModelDiscovery = {
      detect: vi.fn(async (_context?: LocalAgentModelDetectContext) => [
        {
          agentTargetId: "local:claude-code",
          provider: "claude-code" as const,
          displayName: "Claude Code",
          authState: "ok" as const,
          models: [{ id: "sonnet", label: "Sonnet" }],
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      undefined,
      { localAgentModelDiscovery },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/models?refresh=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().models).toContainEqual({
      id: "claude-code:sonnet",
      name: "Sonnet",
      provider: "claude-code",
      source: "local-agent",
    });
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledWith({
      refresh: true,
      cwd: "/tmp/aimc-app-data",
    });
  });

  it("omits unavailable providers and keeps a supported default fallback visible", async () => {
    const localAgentModelDiscovery = {
      detect: vi.fn(async () => [
        {
          agentTargetId: "local:tutti-agent",
          provider: "tutti-agent" as const,
          displayName: "Tutti Agent",
          authState: "missing" as const,
          models: [{ id: "default", label: "Default" }],
          supported: false,
        },
        {
          agentTargetId: "local:claude-code",
          provider: "claude-code" as const,
          displayName: "Claude Code",
          authState: "expired" as const,
          reason: "Provider session expired.",
          models: [],
          supported: false,
        },
        {
          agentTargetId: "local:codex",
          provider: "codex" as const,
          displayName: "Codex",
          authState: "ok" as const,
          reason: "Model discovery timed out; using the configured default.",
          models: [{ id: "default", label: "Default" }],
          defaultModelId: "default",
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv({ agentModel: "openai:gpt-4.1" }, {}),
      undefined,
      { localAgentModelDiscovery },
    );

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json().models).not.toContainEqual(
      expect.objectContaining({ provider: "tutti-agent" }),
    );
    expect(response.json().localAgentProviders).not.toContainEqual(
      expect.objectContaining({ provider: "tutti-agent" }),
    );
    expect(response.json().localAgentProviders).not.toContainEqual(
      expect.objectContaining({ provider: "claude-code" }),
    );
    expect(response.json().models).toContainEqual(
      expect.objectContaining({ id: "codex:default", provider: "codex" }),
    );
    expect(response.json().localAgentProviders).toContainEqual(
      expect.objectContaining({
        provider: "codex",
        supported: true,
        authState: "ok",
        defaultModelId: "codex:default",
      }),
    );
  });

  it("uses standalone local-agent model discovery for POST model requests", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "");
    vi.stubEnv("CODEX_HOME", "/tmp/user-codex-home");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/user-claude-config");
    const localAgentModelDiscovery = {
      detect: vi.fn(async (_context?: LocalAgentModelDetectContext) => [
        {
          agentTargetId: "local:tutti-agent",
          provider: "tutti-agent" as const,
          displayName: "Tutti Agent",
          authState: "ok" as const,
          models: [{ id: "default", label: "Default (Tutti Agent)" }],
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      undefined,
      {
        localAgentModelDiscovery,
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: {
        "x-tsh-managed-agent-credential": "obsolete-credential",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().models).toContainEqual({
      id: "tutti-agent:default",
      name: "Default (Tutti Agent)",
      provider: "tutti-agent",
      source: "local-agent",
    });
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledWith({
      cwd: "/tmp/aimc-app-data",
    });
  });

  it("uses one app-data-scoped discovery snapshot for models and exact targets", async () => {
    const localAgentModelDiscovery = {
      detect: vi.fn(async () => [
        {
          agentTargetId: "team:canvas",
          provider: "codex" as const,
          displayName: "Codex",
          authState: "ok" as const,
          models: [{ id: "gpt-snapshot", label: "GPT Snapshot" }],
          defaultModelId: "gpt-snapshot",
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "codex:gpt-snapshot",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      undefined,
      { localAgentModelDiscovery },
    );

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode, response.body).toBe(200);
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledTimes(1);
    expect(localAgentModelDiscovery.detect).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/aimc-app-data" }),
    );
    expect(response.json().models).toContainEqual(
      expect.objectContaining({ id: "codex:gpt-snapshot" }),
    );
    expect(response.json().localAgentTargets).toContainEqual(
      expect.objectContaining({
        agentTargetId: "team:canvas",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "codex:gpt-snapshot" }),
        ]),
      }),
    );
  });

  it("uses the matching catalog runtime for injected provider discovery", async () => {
    vi.stubEnv("TUTTI_CLI", "");
    const detections = [
      {
        agentTargetId: "local:future-runtime",
        provider: "future-runtime" as const,
        displayName: "Future Agent",
        authState: "ok" as const,
        models: [{ id: "future-model", label: "Future Model" }],
        defaultModelId: "future-model",
        supported: true,
      },
    ];
    const localAgentDiscoveryRuntime = {
      cancel: vi.fn(async () => undefined),
      detect: vi.fn(async () => detections),
      listProviders: () => [
        {
          id: "future-runtime",
          displayName: "Future Agent",
          kind: "local-agent" as const,
        },
      ],
      run: vi.fn(async function* () {
        yield* [];
      }),
    };

    const result = await listAgentModelCatalog({
      env: loadServerEnv({}, {}),
      localAgentDiscoveryRuntime,
    });

    expect(localAgentDiscoveryRuntime.detect).toHaveBeenCalled();
    expect(result.localAgentTargets).toContainEqual(
      expect.objectContaining({
        agentTargetId: "local:future-runtime",
        available: true,
        providerId: "future-runtime",
      }),
    );
    expect(result.models).toContainEqual(
      expect.objectContaining({
        id: "future-runtime:future-model",
        provider: "future-runtime",
      }),
    );
  });

  it("does not partition model discovery by obsolete credential headers", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    const localAgentModelDiscovery = {
      detect: vi.fn(async (_context?: LocalAgentModelDetectContext) => [
        {
          agentTargetId: "local:tutti-agent",
          provider: "tutti-agent" as const,
          displayName: "Tutti Agent",
          authState: "ok" as const,
          models: [{ id: "default", label: "Default" }],
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      undefined,
      {
        localAgentModelDiscovery,
      },
    );

    const responseA = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: {
        "x-tsh-managed-agent-credential": "obsolete-a",
      },
      payload: {},
    });
    const responseB = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: {
        "x-tsh-managed-agent-credential": "obsolete-b",
      },
      payload: {},
    });

    expect(responseA.statusCode, responseA.body).toBe(200);
    expect(responseB.statusCode, responseB.body).toBe(200);
    expect(responseA.json().models).toContainEqual(
      expect.objectContaining({ id: "tutti-agent:default" }),
    );
    expect(responseB.json().models).toContainEqual(
      expect.objectContaining({ id: "tutti-agent:default" }),
    );
    expect(localAgentModelDiscovery.detect).toHaveBeenNthCalledWith(1, {
      cwd: "/tmp/aimc-app-data",
    });
    expect(localAgentModelDiscovery.detect).toHaveBeenNthCalledWith(2, {
      cwd: "/tmp/aimc-app-data",
    });
  });

  it("uses standalone context for supplied reusable discovery", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    const localAgentModelDiscovery = { detect: vi.fn(async () => []) };

    await listAgentModels({
      env: loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      localAgentModelDiscovery,
    });

    expect(localAgentModelDiscovery.detect).toHaveBeenCalledWith({
      cwd: "/tmp/aimc-app-data",
    });
  });

  it("logs standalone model discovery failures", async () => {
    const logger = { warn: vi.fn() };
    await listAgentModels({
      env: loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
        },
        {},
      ),
      localAgentModelDiscovery: {
        detect: vi.fn(async () => {
          throw new Error("local discovery failed");
        }),
      },
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Failed to load local-agent models; omitting local providers.",
    );
  });

  it("omits local-agent models when trusted local mode is disabled", async () => {
    vi.stubEnv("TUTTI_APP_DATA_DIR", "/tmp/aimc-app-data");
    const localAgentModelDiscovery = {
      detect: vi.fn(async () => [
        {
          provider: "codex" as const,
          displayName: "Codex CLI",
          authState: "unknown" as const,
          models: [{ id: "gpt-live", label: "gpt-live" }],
          supported: true,
        },
      ]),
    };
    const app = Fastify();
    apps.push(app);
    await registerModelRoutes(
      app,
      loadServerEnv(
        {
          agentModel: "openai:gpt-4.1",
          appDataDir: "/tmp/aimc-app-data",
          trustedLocalAgentMode: false,
        },
        {},
      ),
      undefined,
      {
        localAgentModelDiscovery,
      },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/models",
      headers: {
        "x-tsh-managed-agent-credential": "obsolete-credential",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().models).not.toContainEqual(
      expect.objectContaining({ provider: "codex" }),
    );
    expect(localAgentModelDiscovery.detect).not.toHaveBeenCalled();
  });
});
