import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import { loadServerEnv } from "./env.js";

describe("loadServerEnv", () => {
  it("loads Tutti package runtime data root and package version overrides", () => {
    const env = loadServerEnv(
      {},
      {
        AIMC_APP_VERSION: "1.2.3",
        AIMC_DATA_ROOT: "/tmp/aimc-tutti-data",
      },
    );

    const dataRoot = resolve("/tmp/aimc-tutti-data");
    expect(env.dataRoot).toBe(dataRoot);
    expect(env.appDataDir).toBe(dataRoot);
    expect(env.tuttiManagedFilesRoot).toBe(join(dataRoot, "uploads"));
    expect(env.version).toBe("1.2.3");
  });

  it("loads Tutti managed app env", () => {
    const env = loadServerEnv(
      {},
      {
        TUTTI_API_BASE_URL: "https://tutti.example/api",
        TUTTI_APP_DATA_DIR: "/data/tutti-app",
        TUTTI_APP_DATABASE_DIR: "/var/lib/tutti-app-database",
        TUTTI_APP_ID: "tutti-app",
        TUTTI_APP_INSTALLATION_ID: "tutti-installation",
        TUTTI_CLI: "/usr/local/bin/tutti",
        TUTTI_APP_MANAGED_FILES_ROOT: "/tmp/tutti-managed-files",
        TUTTI_APP_SERVER_TOKEN: "tutti-token",
        TUTTI_WORKSPACE_ID: "tutti-workspace",
      },
    );

    expect(env.tuttiApiBaseUrl).toBe("https://tutti.example/api");
    // Prefer VM database dir over FabricFS TUTTI_APP_DATA_DIR (.tsh).
    const databaseRoot = resolve("/var/lib/tutti-app-database");
    expect(env.appDataDir).toBe(databaseRoot);
    expect(env.dataRoot).toBe(databaseRoot);
    expect(env.databaseRoot).toBe(databaseRoot);
    expect(env.tuttiAppId).toBe("tutti-app");
    expect(env.tuttiAppInstallationId).toBe("tutti-installation");
    expect(env.tuttiCliPath).toBe("/usr/local/bin/tutti");
    // Ignore platform managed-files root under DATA_DIR when DATABASE_DIR exists.
    expect(env.tuttiManagedFilesRoot).toBe(
      join(databaseRoot, "uploads"),
    );
    expect(env.tuttiAppServerToken).toBe("tutti-token");
    expect(env.tuttiWorkspaceId).toBe("tutti-workspace");
  });

  it("loads Kie provider credentials and endpoint overrides", () => {
    const env = loadServerEnv(
      {},
      {
        AIMC_KIE_API_KEY: "env-kie-key",
        AIMC_KIE_BASE_URL: "https://kie-api.example",
        AIMC_KIE_UPLOAD_BASE_URL: "https://kie-upload.example",
      },
    );

    expect(env.kieApiKey).toBe("env-kie-key");
    expect(env.kieBaseUrl).toBe("https://kie-api.example");
    expect(env.kieUploadBaseUrl).toBe("https://kie-upload.example");
  });

  it("loads Codex Imagegen configuration", () => {
    const env = loadServerEnv(
      {},
      {
        AIMC_CODEX_IMAGEGEN_ENABLED: "true",
        AIMC_CODEX_IMAGEGEN_AGENT_MODEL: "gpt-5.4",
        AIMC_CODEX_IMAGEGEN_TIMEOUT_MS: "450000",
        AIMC_CODEX_HOME: "/tmp/codex-home",
      },
    );

    expect(env.codexImagegenEnabled).toBe(true);
    expect(env.codexImagegenAgentModel).toBe("gpt-5.4");
    expect(env.codexImagegenTimeoutMs).toBe(450000);
    expect(env.codexImagegenCodexHome).toBe("/tmp/codex-home");
  });

  it("enables Codex Imagegen by default and allows explicit disable", () => {
    expect(loadServerEnv({}, {}).codexImagegenEnabled).toBe(true);
    expect(loadServerEnv({}, {}).codexImagegenAgentModel).toBeUndefined();
    expect(loadServerEnv({}, {}).codexImagegenAgentModelConfigured).toBe(false);
    expect(
      loadServerEnv({}, { AIMC_CODEX_IMAGEGEN_ENABLED: "false" })
        .codexImagegenEnabled,
    ).toBe(false);
  });
});
