import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
export const DEFAULT_AGENT_MODEL = "openai:gpt-5.4-mini";
export const DEFAULT_GOOGLE_AGENT_MODEL = "gemini-2.5-flash";
export const DEFAULT_AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const DEFAULT_AGNES_AGENT_MODEL = "agnes:agnes-2.0-flash";

export type ServerEnv = {
  agentBackendMode: "state" | "filesystem";
  agentFilesRoot?: string;
  agentModelConfigured?: boolean;
  agentModel: string;
  agnesApiKey?: string;
  agnesBaseUrl?: string;
  agnesDefaultModel?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  codexImagegenCodexHome?: string;
  codexImagegenEnabled?: boolean;
  codexImagegenAgentModel?: string;
  codexImagegenAgentModelConfigured?: boolean;
  codexImagegenTimeoutMs?: number;
  appDataDir?: string;
  databaseRoot?: string;
  dataRoot?: string;
  googleApiKey?: string;
  googleApplicationCredentials?: string;
  googleVertexLocation?: string;
  googleVertexProject?: string;
  googleVertexVideoLocation?: string;
  kieApiKey?: string;
  kieBaseUrl?: string;
  kieUploadBaseUrl?: string;
  openAIApiBase?: string;
  openAIApiKey?: string;
  tuttiApiBaseUrl?: string;
  tuttiAppId?: string;
  tuttiAppInstallationId?: string;
  tuttiCliPath?: string;
  tuttiManagedFilesRoot?: string;
  tuttiAppServerToken?: string;
  tuttiWorkspaceId?: string;
  port: number;
  replicateApiToken?: string;
  skillsRoot?: string;
  trustedLocalAgentMode?: boolean;
  version: string;
  volcesApiKey?: string;
  volcesBaseUrl?: string;
  webDistDir?: string;
  webOrigin: string;
  workerId?: string;
  workerMaxBatchSize?: number;
  workerPollIntervalMs?: number;
};

export function loadServerEnv(
  overrides: Partial<ServerEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const webDistDir =
    overrides.webDistDir ?? normalizeOptionalString(source.AIMC_WEB_DIST);
  const tshWorkspaceApp = source.TSH_WORKSPACE_APP?.trim() === "1";
  const databaseRoot =
    overrides.databaseRoot ??
    normalizeOptionalString(
      source.AIMC_DATABASE_ROOT ?? source.TUTTI_APP_DATABASE_DIR,
    );
  const dataRoot =
    overrides.dataRoot ??
    (tshWorkspaceApp
      ? databaseRoot
      : (normalizeOptionalString(source.AIMC_DATA_ROOT) ??
        normalizeOptionalString(source.TUTTI_APP_DATA_DIR) ??
        databaseRoot));
  const resolvedDatabaseRoot = databaseRoot ?? dataRoot;
  const appDataDir =
    overrides.appDataDir ??
    (tshWorkspaceApp
      ? resolvedDatabaseRoot
      : (normalizeOptionalString(source.AIMC_DATA_ROOT) ??
        normalizeOptionalString(source.TUTTI_APP_DATA_DIR) ??
        dataRoot));
  const agentBackendMode =
    overrides.agentBackendMode ??
    parseAgentBackendMode(
      source.AIMC_AGENT_BACKEND_MODE ?? source.AGENT_BACKEND_MODE,
    );
  const agentFilesRoot =
    overrides.agentFilesRoot ??
    normalizeOptionalString(
      source.AIMC_AGENT_FILES_ROOT ?? source.AGENT_FILES_ROOT,
    );
  const configuredAgentModel =
    overrides.agentModel ??
    normalizeOptionalString(source.AIMC_AGENT_MODEL ?? source.AGENT_MODEL);
  const agnesApiKey =
    overrides.agnesApiKey ??
    normalizeOptionalString(source.AIMC_AGNES_API_KEY ?? source.AGNES_API_KEY);
  const agnesBaseUrlSource =
    overrides.agnesBaseUrl ??
    normalizeOptionalString(
      source.AIMC_AGNES_BASE_URL ?? source.AGNES_BASE_URL,
    );
  const agnesDefaultModelSource =
    overrides.agnesDefaultModel ??
    normalizeOptionalString(
      source.AIMC_AGNES_MODEL ?? source.AGNES_DEFAULT_MODEL,
    );
  const agnesBaseUrl =
    agnesBaseUrlSource ?? (agnesApiKey ? DEFAULT_AGNES_BASE_URL : undefined);
  const agnesDefaultModel =
    agnesDefaultModelSource ??
    (agnesApiKey ? DEFAULT_AGNES_AGENT_MODEL : undefined);
  const anthropicApiKey =
    overrides.anthropicApiKey ??
    normalizeOptionalString(
      source.AIMC_ANTHROPIC_API_KEY ?? source.ANTHROPIC_API_KEY,
    );
  const anthropicBaseUrl =
    overrides.anthropicBaseUrl ??
    normalizeOptionalString(
      source.AIMC_ANTHROPIC_BASE_URL ?? source.ANTHROPIC_BASE_URL,
    );
  const codexImagegenEnabled =
    overrides.codexImagegenEnabled ??
    parseOptionalBoolean(source.AIMC_CODEX_IMAGEGEN_ENABLED, true);
  const codexImagegenTimeoutMs =
    overrides.codexImagegenTimeoutMs ??
    parseOptionalInt(source.AIMC_CODEX_IMAGEGEN_TIMEOUT_MS);
  const codexImagegenCodexHome =
    overrides.codexImagegenCodexHome ??
    normalizeOptionalString(source.AIMC_CODEX_HOME ?? source.CODEX_HOME);
  const codexImagegenAgentModel =
    overrides.codexImagegenAgentModel ??
    normalizeOptionalString(source.AIMC_CODEX_IMAGEGEN_AGENT_MODEL);
  const agentModel =
    configuredAgentModel ?? agnesDefaultModel ?? DEFAULT_AGENT_MODEL;
  const openAIApiBase =
    overrides.openAIApiBase ??
    normalizeOptionalString(
      source.AIMC_OPENAI_API_BASE ?? source.OPENAI_API_BASE,
    );
  const openAIApiKey =
    overrides.openAIApiKey ??
    normalizeOptionalString(
      source.AIMC_OPENAI_API_KEY ?? source.OPENAI_API_KEY,
    );
  const tuttiApiBaseUrl =
    overrides.tuttiApiBaseUrl ??
    normalizeOptionalString(source.TUTTI_API_BASE_URL);
  const tuttiAppId =
    overrides.tuttiAppId ?? normalizeOptionalString(source.TUTTI_APP_ID);
  const tuttiAppInstallationId =
    overrides.tuttiAppInstallationId ??
    normalizeOptionalString(source.TUTTI_APP_INSTALLATION_ID);
  const tuttiCliPath =
    overrides.tuttiCliPath ?? normalizeOptionalString(source.TUTTI_CLI);
  const configuredTuttiManagedFilesRoot = normalizeOptionalString(
    source.AIMC_TUTTI_MANAGED_FILES_ROOT ??
      source.TUTTI_APP_MANAGED_FILES_ROOT ??
      source.TUTTI_MANAGED_FILES_ROOT ??
      source.TUTTI_APP_FILES_ROOT ??
      source.TUTTI_APP_FILES_DIR ??
      source.TUTTI_FILES_ROOT,
  );
  const tuttiManagedFilesRoot =
    overrides.tuttiManagedFilesRoot ??
    (tshWorkspaceApp && resolvedDatabaseRoot
      ? posix.join(resolvedDatabaseRoot, "uploads")
      : (normalizeOptionalString(source.AIMC_TUTTI_MANAGED_FILES_ROOT) ??
        configuredTuttiManagedFilesRoot ??
        (dataRoot ? join(dataRoot, "uploads") : undefined)));
  const tuttiAppServerToken =
    overrides.tuttiAppServerToken ??
    normalizeOptionalString(source.TUTTI_APP_SERVER_TOKEN);
  const tuttiWorkspaceId =
    overrides.tuttiWorkspaceId ??
    normalizeOptionalString(source.TUTTI_WORKSPACE_ID);
  const googleApiKey =
    overrides.googleApiKey ??
    normalizeOptionalString(
      source.AIMC_GOOGLE_API_KEY ?? source.GOOGLE_API_KEY,
    );
  const googleApplicationCredentials =
    overrides.googleApplicationCredentials ??
    normalizeOptionalString(
      source.AIMC_GOOGLE_APPLICATION_CREDENTIALS ??
        source.GOOGLE_APPLICATION_CREDENTIALS,
    );
  const googleVertexProject =
    overrides.googleVertexProject ??
    normalizeOptionalString(
      source.AIMC_GOOGLE_VERTEX_PROJECT ?? source.GOOGLE_VERTEX_PROJECT,
    );
  const googleVertexLocation =
    overrides.googleVertexLocation ??
    normalizeOptionalString(
      source.AIMC_GOOGLE_VERTEX_LOCATION ?? source.GOOGLE_VERTEX_LOCATION,
    );
  const googleVertexVideoLocation =
    overrides.googleVertexVideoLocation ??
    normalizeOptionalString(
      source.AIMC_GOOGLE_VERTEX_VIDEO_LOCATION ??
        source.GOOGLE_VERTEX_VIDEO_LOCATION,
    );
  const replicateApiToken =
    overrides.replicateApiToken ??
    normalizeOptionalString(
      source.AIMC_REPLICATE_API_TOKEN ?? source.REPLICATE_API_TOKEN,
    );
  const kieApiKey =
    overrides.kieApiKey ??
    normalizeOptionalString(source.AIMC_KIE_API_KEY ?? source.KIE_API_KEY);
  const kieBaseUrl =
    overrides.kieBaseUrl ??
    normalizeOptionalString(source.AIMC_KIE_BASE_URL ?? source.KIE_BASE_URL);
  const kieUploadBaseUrl =
    overrides.kieUploadBaseUrl ??
    normalizeOptionalString(
      source.AIMC_KIE_UPLOAD_BASE_URL ?? source.KIE_UPLOAD_BASE_URL,
    );
  const skillsRoot =
    overrides.skillsRoot ??
    normalizeOptionalString(source.AIMC_SKILLS_ROOT ?? source.SKILLS_ROOT);
  const trustedLocalAgentMode =
    overrides.trustedLocalAgentMode ??
    parseOptionalBoolean(source.AIMC_TRUSTED_LOCAL_AGENT_MODE, true);
  const volcesApiKey =
    overrides.volcesApiKey ??
    normalizeOptionalString(
      source.AIMC_VOLCES_API_KEY ?? source.VOLCES_API_KEY,
    );
  const volcesBaseUrl =
    overrides.volcesBaseUrl ??
    normalizeOptionalString(
      source.AIMC_VOLCES_BASE_URL ?? source.VOLCES_BASE_URL,
    );
  const workerId =
    overrides.workerId ??
    normalizeOptionalString(source.AIMC_WORKER_ID ?? source.WORKER_ID);
  const workerPollIntervalMs =
    overrides.workerPollIntervalMs ??
    parseOptionalInt(
      source.AIMC_WORKER_POLL_INTERVAL_MS ?? source.WORKER_POLL_INTERVAL_MS,
    );
  const workerMaxBatchSize =
    overrides.workerMaxBatchSize ??
    parseOptionalInt(
      source.AIMC_WORKER_MAX_BATCH_SIZE ?? source.WORKER_MAX_BATCH_SIZE,
    );

  return {
    agentBackendMode,
    agentModelConfigured: configuredAgentModel !== undefined,
    agentModel,
    port: overrides.port ?? parsePort(source.AIMC_SERVER_PORT ?? source.PORT),
    version:
      overrides.version ??
      normalizeOptionalString(source.AIMC_APP_VERSION) ??
      readServerVersion(),
    webOrigin:
      overrides.webOrigin ?? source.AIMC_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    ...(appDataDir ? { appDataDir } : {}),
    ...(agentFilesRoot ? { agentFilesRoot } : {}),
    ...(dataRoot ? { dataRoot } : {}),
    ...(resolvedDatabaseRoot ? { databaseRoot: resolvedDatabaseRoot } : {}),
    ...(webDistDir ? { webDistDir } : {}),
    ...(agnesApiKey ? { agnesApiKey } : {}),
    ...(agnesBaseUrl ? { agnesBaseUrl } : {}),
    ...(agnesDefaultModel ? { agnesDefaultModel } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
    codexImagegenEnabled,
    codexImagegenAgentModelConfigured: codexImagegenAgentModel !== undefined,
    ...(codexImagegenAgentModel ? { codexImagegenAgentModel } : {}),
    ...(codexImagegenTimeoutMs ? { codexImagegenTimeoutMs } : {}),
    ...(codexImagegenCodexHome ? { codexImagegenCodexHome } : {}),
    ...(openAIApiBase ? { openAIApiBase } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(tuttiApiBaseUrl ? { tuttiApiBaseUrl } : {}),
    ...(tuttiAppId ? { tuttiAppId } : {}),
    ...(tuttiAppInstallationId ? { tuttiAppInstallationId } : {}),
    ...(tuttiCliPath ? { tuttiCliPath } : {}),
    ...(tuttiManagedFilesRoot ? { tuttiManagedFilesRoot } : {}),
    ...(tuttiAppServerToken ? { tuttiAppServerToken } : {}),
    ...(tuttiWorkspaceId ? { tuttiWorkspaceId } : {}),
    ...(googleApiKey ? { googleApiKey } : {}),
    ...(googleApplicationCredentials ? { googleApplicationCredentials } : {}),
    ...(googleVertexProject ? { googleVertexProject } : {}),
    ...(googleVertexLocation ? { googleVertexLocation } : {}),
    ...(googleVertexVideoLocation ? { googleVertexVideoLocation } : {}),
    ...(replicateApiToken ? { replicateApiToken } : {}),
    ...(kieApiKey ? { kieApiKey } : {}),
    ...(kieBaseUrl ? { kieBaseUrl } : {}),
    ...(kieUploadBaseUrl ? { kieUploadBaseUrl } : {}),
    ...(skillsRoot ? { skillsRoot } : {}),
    trustedLocalAgentMode,
    ...(volcesApiKey ? { volcesApiKey } : {}),
    ...(volcesBaseUrl ? { volcesBaseUrl } : {}),
    ...(workerId ? { workerId } : {}),
    ...(workerPollIntervalMs ? { workerPollIntervalMs } : {}),
    ...(workerMaxBatchSize ? { workerMaxBatchSize } : {}),
  };
}

function normalizeOptionalString(value: string | undefined) {
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

function parseOptionalInt(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePort(rawPort: string | undefined) {
  if (!rawPort) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid AIMC_SERVER_PORT value: ${rawPort}`);
  }

  return port;
}

function parseAgentBackendMode(
  rawMode: string | undefined,
): "state" | "filesystem" {
  if (!rawMode) {
    return "state";
  }

  if (rawMode === "state" || rawMode === "filesystem") {
    return rawMode;
  }

  throw new Error(`Invalid AIMC_AGENT_BACKEND_MODE value: ${rawMode}`);
}

function readServerVersion() {
  const packageJson = readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8",
  );

  const parsed = JSON.parse(packageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}
