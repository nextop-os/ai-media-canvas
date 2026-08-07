import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import {
  type ManagedFileAssetMetadata,
  type RunCreateRequest,
  type StreamEvent,
  applicationErrorResponseSchema,
  healthResponseSchema,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  viewerResponseSchema,
} from "@aimc/shared";

import {
  AgentTargetResolutionError,
  resolveAgentTarget,
} from "./agent/agent-targets.js";
import { createLocalToolGatewayService } from "./agent/local-agent-host/tool-gateway.js";
import {
  AgentRunModelResolutionError,
  createAgentRunOrchestrator,
  getLocalAgentModelProvider,
  resolveAgentRunModel,
} from "./agent/run-orchestrator.js";
import { createAgentRunService } from "./agent/runtime.js";
import type { RequestAuthenticator } from "./auth/request.js";
import { type ServerEnv, loadServerEnv } from "./config/env.js";
import type { ViewerService } from "./features/bootstrap/ensure-user-foundation.js";
import {
  type BrandKitService,
  BrandKitServiceError,
} from "./features/brand-kit/brand-kit-service.js";
import {
  type CanvasService,
  CanvasServiceError,
} from "./features/canvas/canvas-service.js";
import {
  type ChatService,
  ChatServiceError,
} from "./features/chat/chat-service.js";
import { createJobService } from "./features/jobs/job-service.js";
import {
  type ProjectService,
  ProjectServiceError,
} from "./features/projects/project-service.js";
import {
  LOCAL_WORKSPACE_ID,
  createSettingsService,
} from "./features/settings/settings-service.js";
import {
  type SkillService,
  SkillServiceError,
} from "./features/skills/skill-service.js";
import {
  type UploadService,
  UploadServiceError,
} from "./features/uploads/upload-service.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerBrandKitRoutes } from "./http/brand-kits.js";
import { createCanvasOperations } from "./http/canvas-operations.js";
import { registerCanvasRoutes } from "./http/canvases.js";
import { createChatOperations } from "./http/chat-operations.js";
import { registerChatRoutes } from "./http/chat.js";
import { registerGenerateRoutes } from "./http/generate.js";
import { registerHealthRoutes } from "./http/health.js";
import { registerImageModelRoutes } from "./http/image-models.js";
import { createJobOperations } from "./http/job-operations.js";
import { registerJobRoutes } from "./http/jobs.js";
import { registerModelRoutes } from "./http/models.js";
import { createProjectOperations } from "./http/project-operations.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerReferenceRoutes } from "./http/references.js";
import { registerSettingsRoutes } from "./http/settings.js";
import { createSkillOperations } from "./http/skill-operations.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerTuttiCliRoutes } from "./http/tutti-cli.js";
import { registerUploadRoutes } from "./http/uploads.js";
import { registerVideoModelRoutes } from "./http/video-models.js";
import { type LocalStore, createLocalStore } from "./local/store.js";
import { createLocalUserClient } from "./local/user-client.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { registerWsRoute } from "./ws/handler.js";
import { createPipelineLogger } from "./ws/logger.js";

export type BuildAppOptions = {
  env?: Partial<ServerEnv>;
};

const DEFAULT_WEB_DIST_DIR = fileURLToPath(
  new URL("../../web/out/", import.meta.url),
);
const DEFAULT_SKILLS_ROOT = fileURLToPath(
  new URL("../../../skills/", import.meta.url),
);
const DEFAULT_AGENT_FILES_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const LOCAL_AGENT_ACCESS_TOKEN = "standalone-local-access-token";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const LOCAL_FONT_LIBRARY = [
  {
    family: "Inter",
    category: "sans-serif",
    variants: ["regular", "500", "700"],
  },
  {
    family: "Noto Sans SC",
    category: "sans-serif",
    variants: ["regular", "500", "700"],
  },
  {
    family: "Source Han Serif SC",
    category: "serif",
    variants: ["regular", "600", "700"],
  },
  { family: "Merriweather", category: "serif", variants: ["regular", "700"] },
  {
    family: "Playfair Display",
    category: "display",
    variants: ["regular", "700"],
  },
  { family: "Bebas Neue", category: "display", variants: ["regular"] },
  { family: "Caveat", category: "handwriting", variants: ["regular", "700"] },
  {
    family: "JetBrains Mono",
    category: "monospace",
    variants: ["regular", "700"],
  },
];

function isLoopbackHttpOrigin(url: URL) {
  return (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    /^https?:$/.test(url.protocol)
  );
}

function resolveCorsAllowOrigin(
  origin: string | undefined,
  expectedOrigin: string,
) {
  try {
    const expected = new URL(expectedOrigin);
    if (!origin) return expected.origin;

    const request = new URL(origin);
    if (request.origin === expected.origin) return request.origin;

    if (isLoopbackHttpOrigin(expected) && isLoopbackHttpOrigin(request)) {
      return request.origin;
    }

    return expected.origin;
  } catch {
    return expectedOrigin;
  }
}

function buildViewerService(store: LocalStore): ViewerService {
  return {
    async ensureViewer() {
      return {
        ...store.getViewer(),
        workspace: { id: LOCAL_WORKSPACE_ID },
      } as Awaited<ReturnType<ViewerService["ensureViewer"]>>;
    },
  };
}

function buildProjectService(store: LocalStore): ProjectService {
  return {
    async archiveProject(_user, projectId) {
      if (!store.archiveProject(projectId)) {
        throw new ProjectServiceError(
          "project_not_found",
          "Project not found.",
          404,
        );
      }
    },
    async createProject(_user, input) {
      try {
        return store.createProject(input);
      } catch (error) {
        if (error instanceof Error && error.message === "project_slug_taken") {
          throw new ProjectServiceError(
            "project_slug_taken",
            "Project slug is already taken in this app.",
            409,
          );
        }
        throw new ProjectServiceError(
          "project_create_failed",
          "Unable to create project.",
          500,
        );
      }
    },
    async getProject(_user, projectId) {
      const project = store.getProject(projectId);
      if (!project) {
        throw new ProjectServiceError(
          "project_not_found",
          "Project not found.",
          404,
        );
      }
      return project;
    },
    async listProjects() {
      return store.listProjects();
    },
    async saveThumbnail(_user, projectId, buffer, mimeType) {
      const result = store.saveProjectThumbnail(projectId, buffer, mimeType);
      if (!result) {
        throw new ProjectServiceError(
          "project_not_found",
          "Project not found.",
          404,
        );
      }
      return result;
    },
    async updateProject(_user, projectId, input) {
      const result = store.updateProject(projectId, input);
      if (!result.ok) {
        if (result.reason === "brand_kit_not_found") {
          throw new ProjectServiceError(
            "brand_kit_not_found",
            "Brand kit not found.",
            404,
          );
        }
        throw new ProjectServiceError(
          "project_not_found",
          "Project not found.",
          404,
        );
      }
    },
  };
}

function buildCanvasService(store: LocalStore): CanvasService {
  return {
    async getCanvas(_user, canvasId) {
      const canvas = store.getCanvas(canvasId);
      if (!canvas) {
        throw new CanvasServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }
      return canvas;
    },
    async saveCanvasContent(_user, canvasId, content, options) {
      const result = store.saveCanvas(canvasId, content, options);
      if (!result.ok) {
        if (result.reason === "revision_conflict") {
          throw new CanvasServiceError(
            "canvas_conflict",
            "Canvas has changed. Fetch the latest canvas before saving again.",
            409,
          );
        }
        throw new CanvasServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }
      return { revision: result.revision };
    },
  };
}

function buildChatService(store: LocalStore): ChatService {
  return {
    async listSessions(_user, canvasId) {
      const sessions = store.listSessions(canvasId);
      if (!sessions) {
        throw new ChatServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }
      return sessions;
    },
    async createSession(_user, canvasId, title) {
      const session = store.createSession(canvasId, title);
      if (!session) {
        throw new ChatServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }
      return session;
    },
    async updateSessionTitle(_user, sessionId, title) {
      if (!store.updateSessionTitle(sessionId, title)) {
        throw new ChatServiceError(
          "session_not_found",
          "Chat session not found.",
          404,
        );
      }
    },
    async deleteSession(_user, sessionId) {
      if (!store.deleteSession(sessionId)) {
        throw new ChatServiceError(
          "session_not_found",
          "Chat session not found.",
          404,
        );
      }
    },
    async listMessages(_user, sessionId) {
      const messages = store.listMessages(sessionId);
      if (!messages) {
        throw new ChatServiceError(
          "session_not_found",
          "Chat session not found.",
          404,
        );
      }
      return messages;
    },
    async createMessage(_user, sessionId, input) {
      const message = store.createMessage(sessionId, input);
      if (!message) {
        throw new ChatServiceError(
          "session_not_found",
          "Chat session not found.",
          404,
        );
      }
      return message;
    },
    async updateMessage(_user, messageId, input) {
      const message = store.updateMessage(messageId, input);
      if (!message) {
        throw new ChatServiceError(
          "chat_error",
          "Chat message not found.",
          404,
        );
      }
      return message;
    },
  };
}

function buildBrandKitService(store: LocalStore): BrandKitService {
  return {
    async listKits() {
      return store.listBrandKits();
    },
    async getKit(_user, kitId) {
      const kit = store.getBrandKit(kitId);
      if (!kit) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
      return kit;
    },
    async createKit(_user, input) {
      return store.createBrandKit(input);
    },
    async updateKit(_user, kitId, input) {
      const kit = store.updateBrandKit(kitId, input);
      if (!kit) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
      return kit;
    },
    async deleteKit(_user, kitId) {
      if (!store.deleteBrandKit(kitId)) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
    },
    async createAsset(_user, kitId, input) {
      const asset = store.createBrandKitAsset(kitId, input);
      if (!asset) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
      return asset;
    },
    async updateAsset(_user, kitId, assetId, input) {
      const asset = store.updateBrandKitAsset(kitId, assetId, input);
      if (!asset) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          "Brand kit asset not found.",
          404,
        );
      }
      return asset;
    },
    async deleteAsset(_user, kitId, assetId) {
      if (!store.deleteBrandKitAsset(kitId, assetId)) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          "Brand kit asset not found.",
          404,
        );
      }
    },
    async uploadAsset(_user, kitId, assetType, fileName, fileBuffer, mimeType) {
      const asset = store.uploadBrandKitAsset(
        kitId,
        assetType,
        fileName,
        fileBuffer,
        mimeType,
      );
      if (!asset) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
      return asset;
    },
    async duplicateKit(_user, kitId) {
      const kit = store.duplicateBrandKit(kitId);
      if (!kit) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          "Brand kit not found.",
          404,
        );
      }
      return kit;
    },
  };
}

function buildUploadService(store: LocalStore, env: ServerEnv): UploadService {
  return {
    async uploadFile(_user, input) {
      return store.uploadFile({
        bucket: input.bucket,
        fileName: input.fileName,
        fileBuffer: input.fileBuffer,
        mimeType: input.mimeType,
        ...(input.projectId !== undefined
          ? { projectId: input.projectId }
          : {}),
      });
    },
    async createManagedFileAsset(_user, input) {
      const file = await validateManagedFileAsset(input.file, {
        managedFilesRoot: env.tuttiManagedFilesRoot,
      });
      return store.createManagedFileAsset({
        bucket: input.bucket,
        file,
        ...(input.projectId !== undefined
          ? { projectId: input.projectId }
          : {}),
      });
    },
    async getAssetUrl(_user, assetId) {
      const url = store.getAssetUrl(assetId);
      if (!url) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }
      return url;
    },
    async deleteAsset(_user, assetId) {
      const result = store.deleteAsset(assetId);
      if (!result.ok) {
        if (result.reason === "asset_in_use") {
          throw new UploadServiceError(
            "asset_in_use",
            "Asset is still referenced by local app data.",
            409,
          );
        }
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }
    },
  };
}

async function validateManagedFileAsset(
  file: ManagedFileAssetMetadata,
  options: { managedFilesRoot: string | undefined },
): Promise<ManagedFileAssetMetadata> {
  if (!options.managedFilesRoot) {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file upload root is not configured.",
      400,
    );
  }

  const managedRoot = await realpathOrUploadError(
    resolve(options.managedFilesRoot),
    "Managed file upload root is unavailable.",
  );
  const filePath = await realpathOrUploadError(
    resolve(file.path),
    "Managed file does not exist.",
  );

  if (!isPathInsideRoot(filePath, managedRoot)) {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file path is outside the configured upload root.",
      400,
    );
  }

  const fileStat = await statOrUploadError(filePath);
  if (!fileStat.isFile()) {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file path must point to a file.",
      400,
    );
  }

  if (fileStat.size !== file.sizeBytes) {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file metadata size does not match the uploaded file.",
      400,
    );
  }

  const sha256 = await calculateSha256OrUploadError(filePath);
  if (sha256 !== file.sha256.toLowerCase()) {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file metadata checksum does not match the uploaded file.",
      400,
    );
  }

  return {
    ...file,
    path: filePath,
    sha256,
    sizeBytes: fileStat.size,
  };
}

async function realpathOrUploadError(path: string, message: string) {
  try {
    return await realpath(path);
  } catch {
    throw new UploadServiceError("upload_failed", message, 400);
  }
}

async function statOrUploadError(path: string) {
  try {
    return await stat(path);
  } catch {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file is unavailable.",
      400,
    );
  }
}

function isPathInsideRoot(filePath: string, managedRoot: string) {
  const relativePath = relative(managedRoot, filePath);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

async function calculateSha256OrUploadError(filePath: string) {
  try {
    return await calculateSha256(filePath);
  } catch {
    throw new UploadServiceError(
      "upload_failed",
      "Managed file checksum could not be verified.",
      400,
    );
  }
}

function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function buildSkillService(store: LocalStore): SkillService {
  return {
    async listInstalledSkills() {
      return store.listInstalledSkills();
    },
    async listCatalogSkills() {
      return store.listCatalogSkills();
    },
    async listEnabledSkills() {
      return store.listEnabledSkills();
    },
    async getSkillDetail(_user, skillId) {
      const skill = store.getSkillDetail(skillId);
      if (!skill) {
        throw new SkillServiceError("skill_not_found", "Skill not found.", 404);
      }
      return skill;
    },
    async createSkill(_user, input) {
      try {
        return store.createSkill(input);
      } catch {
        throw new SkillServiceError(
          "skill_create_failed",
          "Unable to create local skill.",
          500,
        );
      }
    },
    async importSkill(_user, input) {
      try {
        const skill = store.importSkill(input);
        if (!skill) {
          throw new SkillServiceError(
            "skill_import_failed",
            "Imported files do not contain a usable SKILL.md payload.",
            400,
          );
        }
        return skill;
      } catch (error) {
        if (error instanceof SkillServiceError) throw error;
        throw new SkillServiceError(
          "skill_import_failed",
          "Unable to import local skill.",
          500,
        );
      }
    },
    async installCatalogSkill(_user, skillId) {
      const skill = store.installCatalogSkill(skillId);
      if (!skill) {
        throw new SkillServiceError("skill_not_found", "Skill not found.", 404);
      }
      return skill;
    },
    async toggleSkill(_user, skillId, input) {
      const skill = store.toggleSkill(skillId, input);
      if (!skill) {
        throw new SkillServiceError("skill_not_found", "Skill not found.", 404);
      }
      return skill;
    },
    async uninstallSkill(_user, skillId) {
      if (!store.uninstallSkill(skillId)) {
        throw new SkillServiceError("skill_not_found", "Skill not found.", 404);
      }
    },
  };
}

function getStaticContentType(filePath: string) {
  return (
    STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

function normalizeStaticCandidate(pathname: string) {
  const stripped = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (stripped === "/") {
    return "/index.html";
  }
  return stripped.endsWith("/") ? `${stripped}index.html` : stripped;
}

async function resolveStaticFile(webDistDir: string, requestPath: string) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = normalizeStaticCandidate(decodedPath);
  const candidates = new Set<string>([normalizedPath]);

  if (!extname(normalizedPath)) {
    candidates.add(`${normalizedPath}.html`);
    candidates.add(`${normalizedPath}/index.html`);
  }

  for (const candidate of candidates) {
    const safeCandidate = candidate.replace(/^\/+/, "");
    const absolutePath = resolve(webDistDir, safeCandidate);
    const relPath = relative(webDistDir, absolutePath);
    if (relPath.startsWith("..")) {
      continue;
    }
    try {
      const entry = await stat(absolutePath);
      if (entry.isFile()) {
        return absolutePath;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function sendApplicationError(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  code: string,
  message: string,
  statusCode = 500,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: {
        code,
        message,
      },
    }),
  );
}

function sendStandaloneFeatureUnavailable(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  feature: string,
  statusCode = 410,
) {
  return sendApplicationError(
    reply,
    "application_error",
    `${feature} is not available in the standalone AI Canvas build.`,
    statusCode,
  );
}

type LocalAgentRunState = {
  assistantMessageId: string | null;
  canvasId: string | null;
  controller: AbortController | null;
  done: boolean;
  lastUpdatedAt: number;
};

class LocalAgentRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
  }
}

function createLocalAgentRunState(
  assistantMessageId: string | null,
  canvasId: string | null,
): LocalAgentRunState {
  return {
    assistantMessageId,
    canvasId,
    controller: null,
    done: false,
    lastUpdatedAt: Date.now(),
  };
}

function appendLocalAgentEvent(state: LocalAgentRunState, event: StreamEvent) {
  state.lastUpdatedAt = Date.now();
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  ) {
    state.done = true;
  }
}

function createStandaloneAgentEnv(baseEnv: ServerEnv): ServerEnv {
  return {
    ...baseEnv,
    ...(baseEnv.skillsRoot ? {} : { skillsRoot: DEFAULT_SKILLS_ROOT }),
    ...(baseEnv.agentBackendMode === "filesystem" || baseEnv.agentFilesRoot
      ? {}
      : { agentFilesRoot: DEFAULT_AGENT_FILES_ROOT }),
  };
}

function parseByteRange(
  rangeHeader: string | undefined,
  fileSize: number,
): { start: number; end: number } | null | false {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return false;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return false;

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return false;
    const start = Math.max(0, fileSize - suffixLength);
    return { start, end: fileSize - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : fileSize - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return false;
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);
  registerAllProviders(env);
  // Prefer the Tutti/public origin so thumbnail URLs work through the host
  // proxy. Fall back to loopback for local direct startup.
  const assetBaseUrl = (
    env.webOrigin?.trim() || `http://127.0.0.1:${env.port}`
  ).replace(/\/$/, "");
  const webDistDir = env.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  const store = createLocalStore({
    assetBaseUrl,
    ...(env.dataRoot ? { dataRoot: env.dataRoot } : {}),
    ...(env.databaseRoot ? { databaseRoot: env.databaseRoot } : {}),
  });
  store.recoverInterruptedAgentRuns();

  const app = Fastify({
    logger: { level: "info" },
  });
  const chatRequestLog = createPipelineLogger("chat.message");
  const connectionManager = new ConnectionManager();
  const eventBuffer = new CanvasEventBuffer();

  app.addHook("onError", async (request, _reply, error) => {
    if (
      request.method === "POST" &&
      request.url.startsWith("/api/sessions/") &&
      request.url.endsWith("/messages")
    ) {
      chatRequestLog.error("request_failed", {
        code:
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "unknown",
        contentLength: request.headers["content-length"] ?? "unknown",
        message: error.message,
        statusCode:
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : "unknown",
        url: request.url,
      });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const allowOrigin = resolveCorsAllowOrigin(
      request.headers.origin,
      env.webOrigin,
    );
    reply.header("Access-Control-Allow-Origin", allowOrigin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Range");
    reply.header(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Range, Content-Length",
    );
    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  const localUser = store.localUser;
  const viewerService = buildViewerService(store);
  const projectService = buildProjectService(store);
  const canvasService = buildCanvasService(store);
  const chatService = buildChatService(store);
  const brandKitService = buildBrandKitService(store);
  const uploadService = buildUploadService(store, env);
  const skillService = buildSkillService(store);
  const jobService = createJobService(store);
  const settingsService = createSettingsService(store, env);
  const projectOperations = createProjectOperations({
    localUser,
    projectService,
  });
  const assetOperations = {
    async listProjectAssets(input: {
      projectId: string;
      filterText?: string;
      limit: number;
      cursor?: string | null;
    }) {
      const { files, nextCursor } = store.listReferenceProjectAssets(input);
      return {
        assets: files.map((file) => {
          const asset = store.assetObjectFromId(file.id);
          const assetResponse = store.getAssetResponse(file.id);
          const storageUrl = store.getAssetUrl(file.id);
          return {
            ...file,
            ...(asset?.objectPath ? { objectPath: asset.objectPath } : {}),
            ...(assetResponse?.filePath
              ? { filePath: assetResponse.filePath }
              : {}),
            ...(storageUrl ? { storageUrl } : {}),
          };
        }),
        nextCursor,
      };
    },
  };
  const canvasOperations = createCanvasOperations({
    canvasClient: createLocalUserClient(store),
    canvasService,
    localUser,
    uploadService,
  });
  const chatOperations = createChatOperations({
    chatService,
    localUser,
  });
  const jobOperations = createJobOperations({
    env,
    jobService,
    localUser,
    settingsService,
  });
  const skillOperations = createSkillOperations({
    localUser,
    skillService,
  });
  const createUserClient = (_accessToken: string) =>
    createLocalUserClient(store);
  const localToolGateway = createLocalToolGatewayService({
    connectionPublisher: connectionManager,
    createUserClient,
    readLocalAssetDataUrl: async (assetId) => {
      const asset = store.getAssetResponse(assetId);
      if (!asset || !asset.mimeType.startsWith("image/")) return undefined;
      const bytes = await readFile(asset.filePath);
      return `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
    },
    patchWorkspaceSettings: async ({ patch }) => {
      const current = await settingsService.getWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
      );
      return settingsService.updateWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
        {
          ...current,
          ...patch,
        },
      );
    },
    setProjectTitle: async ({ canvasId, title }) => {
      const canvas = store.getCanvas(canvasId);
      if (!canvas) {
        throw new Error("Canvas not found for project title update.");
      }
      const result = store.updateProject(canvas.projectId, { name: title });
      if (!result.ok) {
        throw new Error("Project not found for project title update.");
      }
      const project = store.getProject(canvas.projectId);
      if (!project) {
        throw new Error("Project not found for project title update.");
      }
      return {
        projectId: canvas.projectId,
        success: true as const,
        title: project.name,
        workspaceRoot: result.workspaceRoot ?? null,
      };
    },
  });
  const localToolGatewayBaseUrl = `http://127.0.0.1:${env.port}/api/agent-tools`;
  const localAuth: RequestAuthenticator = {
    async authenticate(request) {
      const authorization = request.headers.authorization;
      const token = authorization?.replace(/^Bearer\s+/i, "").trim();
      if (token !== LOCAL_AGENT_ACCESS_TOKEN) {
        return null;
      }
      return {
        ...localUser,
        accessToken: LOCAL_AGENT_ACCESS_TOKEN,
      };
    },
  };
  const agentRuns = createAgentRunService({
    agentRunStore: {
      createRun: store.createAgentRun,
      getRun: store.getAgentRun,
      updateRun: store.updateAgentRun,
    },
    connectionManager,
    createUserClient,
    env: createStandaloneAgentEnv(env),
    jobService,
    loadSessionMessages: (sessionId) =>
      chatService.listMessages(localUser, sessionId),
    resolveProjectWorkspaceRoot: ({ canvasId }) => {
      if (!canvasId) return null;
      return store.ensureProjectWorkspaceRootForCanvas(canvasId);
    },
    publishCanvasSyncEvent: ({ canvasId, event, runId }) => {
      const persistedEvent = store.appendAgentRunEvent({
        canvasId,
        event,
        runId,
      });
      const eventMetadata = {
        eventId: persistedEvent.eventId,
        ...(persistedEvent.canvasSeq != null
          ? { seq: persistedEvent.canvasSeq }
          : {}),
      };
      eventBuffer.push(canvasId, event, eventMetadata);
      if (canvasId) {
        connectionManager.pushToCanvas(canvasId, event, eventMetadata);
      }
      return {
        eventId: persistedEvent.eventId,
        ...(persistedEvent.canvasSeq != null
          ? { seq: persistedEvent.canvasSeq }
          : {}),
      };
    },
    toolGateway: localToolGateway,
    toolGatewayBaseUrl: localToolGatewayBaseUrl,
    patchWorkspaceSettings: async ({ patch }) => {
      const current = await settingsService.getWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
      );
      return settingsService.updateWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
        {
          ...current,
          ...patch,
        },
      );
    },
  });
  const agentRunOrchestrator = createAgentRunOrchestrator({
    eventPersistence: {
      appendEvent: store.appendAgentRunEvent,
    },
    runStore: {
      createRun: store.createAgentRun,
      updateRun: store.updateAgentRun,
    },
  });
  const localAgentRuns = new Map<string, LocalAgentRunState>();

  void app.addHook("onClose", async () => {
    eventBuffer.dispose();
  });

  const launchLocalAgentRun = (options: {
    payload: RunCreateRequest;
    runId: string;
    runState: LocalAgentRunState;
  }) => {
    void (async () => {
      const replayCanvasId =
        options.payload.canvasId ?? options.payload.conversationId;
      const publishToCanvas = replayCanvasId
        ? ({
            envelope,
            event,
          }: {
            envelope: { eventId?: string; seq?: number };
            event: StreamEvent;
          }) => {
            connectionManager.pushToCanvas(replayCanvasId, event, envelope);
          }
        : undefined;
      const assistantMessageState =
        agentRunOrchestrator.createAssistantProjection({
          locale: options.payload.locale,
        });
      const updateAssistantMessage = async () => {
        if (!options.runState.assistantMessageId) return;
        await chatService.updateMessage(
          localUser,
          options.runState.assistantMessageId,
          {
            role: "assistant",
            content: assistantMessageState.textParts.join(""),
            contentBlocks: assistantMessageState.blocks,
          },
        );
      };

      try {
        for await (const event of agentRuns.streamRun(options.runId)) {
          await agentRunOrchestrator.handleStreamEvent({
            ...(replayCanvasId ? { canvasId: replayCanvasId } : {}),
            event,
            ...(publishToCanvas ? { publish: publishToCanvas } : {}),
            project: assistantMessageState,
            runId: options.runId,
            updateAssistant: updateAssistantMessage,
          });
          appendLocalAgentEvent(options.runState, event);
        }
      } catch (error) {
        if (options.runState.done) {
          return;
        }
        const failedEvent = {
          type: "run.failed",
          runId: options.runId,
          error: {
            code: "run_failed",
            message:
              error instanceof Error ? error.message : "Model request failed.",
          },
          timestamp: new Date().toISOString(),
        } satisfies StreamEvent;
        await agentRunOrchestrator.handleStreamEvent({
          ...(replayCanvasId ? { canvasId: replayCanvasId } : {}),
          event: failedEvent,
          ...(publishToCanvas ? { publish: publishToCanvas } : {}),
          project: assistantMessageState,
          runId: options.runId,
          updateAssistant: updateAssistantMessage,
        });
        appendLocalAgentEvent(options.runState, failedEvent);
      } finally {
        options.runState.controller = null;
        options.runState.done = true;
        options.runState.lastUpdatedAt = Date.now();
        setTimeout(
          () => {
            localAgentRuns.delete(options.runId);
          },
          10 * 60 * 1000,
        ).unref?.();
      }
    })();
  };

  const startLocalAgentRun = async (payload: RunCreateRequest) => {
    if (store.listMessages(payload.sessionId) === null) {
      throw new LocalAgentRunError(
        "session_not_found",
        "Chat session not found.",
        404,
      );
    }

    const [effectiveEnv, workspaceSettings] = await Promise.all([
      settingsService.getEffectiveServerEnv(LOCAL_WORKSPACE_ID),
      settingsService.getWorkspaceSettings(localUser, LOCAL_WORKSPACE_ID),
    ]);
    const baseRuntimeEnv = createStandaloneAgentEnv(effectiveEnv);
    if (baseRuntimeEnv.trustedLocalAgentMode === false) {
      throw new LocalAgentRunError(
        "local_agent_disabled",
        "Local agent runtime is disabled for this server.",
        403,
      );
    }
    const modelProvider = getLocalAgentModelProvider(
      payload.model ?? baseRuntimeEnv.agentModel,
    );
    let resolvedAgentTarget:
      | Awaited<ReturnType<typeof resolveAgentTarget>>
      | undefined;
    try {
      resolvedAgentTarget = await resolveAgentTarget({
        ...(payload.agentTargetId
          ? { agentTargetId: payload.agentTargetId }
          : {}),
        ...(payload.runtimeProvider
          ? { providerId: payload.runtimeProvider }
          : !payload.agentTargetId && modelProvider
            ? { providerId: modelProvider }
            : {}),
      });
    } catch (error) {
      if (!(error instanceof AgentTargetResolutionError)) throw error;
      throw new LocalAgentRunError(
        "agent_target_unavailable",
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
    if (!resolvedAgentTarget) {
      throw new LocalAgentRunError(
        "agent_target_unavailable",
        "A local agent target is required.",
        400,
      );
    }
    let resolvedModel: string | undefined;
    try {
      resolvedModel = resolveAgentRunModel({
        defaultModel: baseRuntimeEnv.agentModel,
        ...(payload.model ? { requestedModel: payload.model } : {}),
        runtimeKind: "local-agent",
        runtimeProvider: resolvedAgentTarget.providerId,
      });
    } catch (error) {
      if (error instanceof AgentRunModelResolutionError) {
        throw new LocalAgentRunError(
          error.code,
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
    const runtimeEnv = baseRuntimeEnv;
    const runtimeModel = resolvedModel;
    const assistantMessage = await chatService.createMessage(
      localUser,
      payload.sessionId,
      {
        ...(payload.clientRequestId
          ? { clientRequestId: payload.clientRequestId }
          : {}),
        role: "assistant",
        content: "",
        contentBlocks: [],
      },
    );
    const response = runCreateResponseSchema.parse(
      agentRuns.createRun(payload, {
        ...(resolvedAgentTarget
          ? { agentTargetId: resolvedAgentTarget.agentTargetId }
          : {}),
        accessToken: LOCAL_AGENT_ACCESS_TOKEN,
        assistantMessageId: assistantMessage.id,
        env: runtimeEnv,
        ...(runtimeModel ? { model: runtimeModel } : {}),
        runtimeKind: "local-agent" as const,
        runtimeProvider: resolvedAgentTarget.providerId,
        ...(workspaceSettings.codexImagegenDelegation
          ? {
              codexImagegenDelegation:
                workspaceSettings.codexImagegenDelegation,
            }
          : {}),
        userId: localUser.id,
      }),
    );
    if (response.reused) return response;
    const runState = createLocalAgentRunState(
      response.assistantMessageId ?? null,
      payload.canvasId ?? payload.conversationId,
    );
    localAgentRuns.set(response.runId, runState);
    launchLocalAgentRun({
      payload,
      runId: response.runId,
      runState,
    });
    return response;
  };

  const listLocalAgentRunEvents = async (runId: string, cursor: number) => {
    const run = store.getAgentRun(runId);
    if (!run) {
      throw new LocalAgentRunError("run_not_found", "Run not found.", 404);
    }

    const events = store.listAgentRunEvents(runId, cursor);
    const nextCursor = events.at(-1)?.seq ?? cursor;

    return {
      done:
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "canceled",
      events: events.map((entry) => ({
        event: entry.event,
        eventId: entry.eventId,
        seq: entry.seq,
      })),
      nextCursor,
    };
  };

  const cancelLocalAgentRun = async (runId: string) => {
    const state = localAgentRuns.get(runId);
    if (!state) {
      throw new LocalAgentRunError("run_not_found", "Run not found.", 404);
    }

    const canceledRun = agentRuns.cancelRun(runId);
    if (!canceledRun) {
      throw new LocalAgentRunError("run_not_found", "Run not found.", 404);
    }

    if (state.canvasId) {
      const cancelCanvasId = state.canvasId;
      await agentRunOrchestrator.emitTerminalCancel({
        canvasId: cancelCanvasId,
        publish: ({ envelope, event }) => {
          connectionManager.pushToCanvas(cancelCanvasId, event, envelope);
        },
        runId,
      });
    } else {
      await agentRunOrchestrator.emitTerminalCancel({
        runId,
      });
    }
    return canceledRun;
  };

  const submitLocalAgentConsent = async (payload: {
    decision: "allow-once" | "always" | "deny";
    runId: string;
  }) => {
    if (payload.decision === "always") {
      const current = await settingsService.getWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
      );
      await settingsService.updateWorkspaceSettings(
        localUser,
        LOCAL_WORKSPACE_ID,
        {
          ...current,
          codexImagegenDelegation: "always",
        },
      );
    }
    return {
      decision: payload.decision,
      runId: payload.runId,
      status: "accepted",
    };
  };

  void registerHealthRoutes(app, env);
  void registerReferenceRoutes(app, { store });
  void registerProjectRoutes(app, {
    localUser,
    projectOperations,
    projectService,
  });
  void registerCanvasRoutes(app, {
    canvasOperations,
    localUser,
    canvasService,
  });
  void registerChatRoutes(app, { chatOperations, localUser, chatService });
  void registerBrandKitRoutes(app, { localUser, brandKitService });
  void registerSkillRoutes(app, { localUser, skillOperations, skillService });
  void registerUploadRoutes(app, {
    localUser,
    uploadService,
  });
  void registerSettingsRoutes(app, { localUser, settingsService });
  void registerModelRoutes(app, env, settingsService);
  void registerImageModelRoutes(app, env, settingsService);
  void registerVideoModelRoutes(app, env, settingsService);
  void registerJobRoutes(app, { localUser, jobOperations, jobService });
  void registerGenerateRoutes(app, {
    env,
    localUser,
    jobService,
    settingsService,
    uploadService,
  });
  void registerTuttiCliRoutes(app, {
    agentOperations: {
      cancelRun: cancelLocalAgentRun,
      listRunEvents: listLocalAgentRunEvents,
      submitConsent: submitLocalAgentConsent,
      startRun: startLocalAgentRun,
    },
    assetOperations,
    canvasOperations,
    chatOperations,
    env,
    jobOperations,
    localCanvasClient: createLocalUserClient(store),
    projectOperations,
    settingsService,
    skillOperations,
  });
  void app.register(async (wsApp) => {
    await wsApp.register(websocket);
    await registerWsRoute(wsApp, {
      agentRuns,
      agentRunOrchestrator,
      agentRunPersistence: {
        appendEvent: store.appendAgentRunEvent,
        getActiveRun: (canvasId, sessionId) => {
          const run = store.getActiveAgentRun(canvasId, sessionId);
          if (!run) {
            return null;
          }
          return {
            assistantMessageId: run.assistant_message_id,
            runId: run.id,
            runtimeKind: run.runtime_kind,
            runtimeProvider: run.runtime_provider,
            agentTargetId: run.agent_target_id,
            sessionId: run.session_id,
            status: run.status,
          };
        },
        getLatestCanvasSeq: store.getLatestCanvasEventSeq,
        listCanvasEvents: store.listCanvasAgentEvents,
      },
      auth: localAuth,
      chatService,
      connectionManager,
      eventBuffer,
      settingsService,
      viewerService,
    });
  });

  app.get("/api/viewer", async (_request, reply) => {
    return reply.code(200).send(viewerResponseSchema.parse(store.getViewer()));
  });

  app.patch("/api/viewer/profile", async (request, reply) => {
    try {
      const payload = profileUpdateRequestSchema.parse(request.body);
      return reply.code(200).send(
        profileUpdateResponseSchema.parse({
          profile: store.updateProfile(payload.displayName),
        }),
      );
    } catch {
      return sendApplicationError(
        reply,
        "profile_update_failed",
        "Unable to update profile.",
      );
    }
  });

  app.get("/api/fonts", async (request, reply) => {
    const query = request.query as
      | { search?: string; category?: string }
      | undefined;
    const search = query?.search?.trim().toLowerCase() ?? "";
    const category = query?.category?.trim().toLowerCase() ?? "";
    const fonts = LOCAL_FONT_LIBRARY.filter((font) => {
      const categoryMatches = !category || font.category === category;
      const searchMatches =
        !search || font.family.toLowerCase().includes(search);
      return categoryMatches && searchMatches;
    });
    return reply.code(200).send({ fonts });
  });

  app.post("/api/agent/runs", async (request, reply) => {
    try {
      const parsedPayload = runCreateRequestSchema.parse(request.body);
      return reply.code(202).send(await startLocalAgentRun(parsedPayload));
    } catch (error) {
      if (error instanceof LocalAgentRunError) {
        return sendApplicationError(
          reply,
          error.code,
          error.message,
          error.statusCode,
        );
      }
      return sendApplicationError(
        reply,
        "application_error",
        "Unable to start local agent run.",
      );
    }
  });

  app.get("/api/agent/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { cursor?: string } | undefined;
    const parsedCursor = Number.parseInt(query?.cursor ?? "0", 10);
    const cursor =
      Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
    try {
      return reply.code(200).send(await listLocalAgentRunEvents(runId, cursor));
    } catch (error) {
      if (error instanceof LocalAgentRunError) {
        return sendApplicationError(
          reply,
          error.code,
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return reply.code(202).send(await cancelLocalAgentRun(runId));
    } catch (error) {
      if (error instanceof LocalAgentRunError) {
        return sendApplicationError(
          reply,
          error.code,
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
  });

  app.get("/api/agent-tools/manifest", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
    if (!token) {
      return sendApplicationError(
        reply,
        "application_error",
        "Missing tool token.",
        401,
      );
    }

    try {
      return reply.code(200).send({
        tools: localToolGateway.getManifest(token),
      });
    } catch (error) {
      return sendApplicationError(
        reply,
        "application_error",
        error instanceof Error
          ? error.message
          : "Unable to load tool manifest.",
        401,
      );
    }
  });

  app.get("/api/asset-proxy", async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url) {
      return sendApplicationError(
        reply,
        "application_error",
        "Missing asset url.",
        400,
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return sendApplicationError(
        reply,
        "application_error",
        "Invalid asset url.",
        400,
      );
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return sendApplicationError(
        reply,
        "application_error",
        "Unsupported asset protocol.",
        400,
      );
    }

    try {
      const upstream = await fetch(parsedUrl, {
        redirect: "follow",
      });
      if (!upstream.ok) {
        return sendApplicationError(
          reply,
          "application_error",
          `Asset proxy failed: ${upstream.status}`,
          upstream.status,
        );
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      const contentType =
        upstream.headers.get("content-type") ?? "application/octet-stream";
      reply.header("content-type", contentType);
      reply.header("cache-control", "public, max-age=3600");
      return reply.code(200).send(bytes);
    } catch (error) {
      return sendApplicationError(
        reply,
        "application_error",
        error instanceof Error ? error.message : "Unable to proxy asset.",
        502,
      );
    }
  });

  app.post("/api/agent-tools/:toolName", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
    const { toolName } = request.params as { toolName: string };
    const requestBody =
      request.body && typeof request.body === "object"
        ? (request.body as { arguments?: unknown })
        : {};
    const args =
      requestBody.arguments &&
      typeof requestBody.arguments === "object" &&
      !Array.isArray(requestBody.arguments)
        ? (requestBody.arguments as Record<string, unknown>)
        : {};

    if (!token) {
      return sendApplicationError(
        reply,
        "application_error",
        "Missing tool token.",
        401,
      );
    }

    try {
      const result = await localToolGateway.callTool(token, toolName, args);
      if (result.isError) {
        return reply.code(422).send({
          error: {
            code: "tool_failed",
            message: result.outputSummary ?? `Tool ${toolName} failed.`,
          },
          result,
        });
      }

      return reply.code(200).send({ result });
    } catch (error) {
      return sendApplicationError(
        reply,
        "application_error",
        error instanceof Error ? error.message : `Tool ${toolName} failed.`,
        401,
      );
    }
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/local-assets/:assetId",
    async handler(request, reply) {
      const asset = store.getAssetResponse(
        (request.params as { assetId: string }).assetId,
      );
      if (!asset) {
        return reply.code(404).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "asset_not_found",
              message: "Asset not found.",
            },
          }),
        );
      }

      const fileStat = await stat(asset.filePath);
      const fileSize = fileStat.size;
      const range = parseByteRange(request.headers.range, fileSize);
      if (range === false) {
        reply.header("content-range", `bytes */${fileSize}`);
        return reply.code(416).send();
      }

      reply.header("content-type", asset.mimeType);
      reply.header("accept-ranges", "bytes");

      if (range) {
        const payload = await readFile(asset.filePath);
        const chunk = payload.subarray(range.start, range.end + 1);
        reply.header(
          "content-range",
          `bytes ${range.start}-${range.end}/${fileSize}`,
        );
        reply.header("content-length", String(chunk.length));
        return reply
          .code(206)
          .send(request.method === "HEAD" ? undefined : chunk);
      }

      reply.header("content-length", String(fileSize));
      if (request.method === "HEAD") {
        return reply.code(200).send();
      }
      const payload = await readFile(asset.filePath);
      return reply.code(200).send(payload);
    },
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    async handler(request, reply) {
      const requestPath = request.url.split("?")[0] ?? "/";
      if (requestPath === "/api" || requestPath.startsWith("/api/")) {
        return reply.code(404).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "route_not_found",
              message: "API route not found.",
            },
          }),
        );
      }

      if (
        requestPath === "/local-assets" ||
        requestPath.startsWith("/local-assets/")
      ) {
        return reply.code(404).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "asset_not_found",
              message: "Asset not found.",
            },
          }),
        );
      }

      const filePath = await resolveStaticFile(webDistDir, requestPath);
      if (!filePath) {
        const notFoundFilePath = await resolveStaticFile(webDistDir, "/404");
        if (!notFoundFilePath) {
          return reply.code(404).send("Static asset not found.");
        }
        const notFoundPayload = await readFile(notFoundFilePath);
        reply.header("content-type", getStaticContentType(notFoundFilePath));
        reply.header("cache-control", "no-cache");
        return reply.code(404).send(notFoundPayload);
      }

      const payload = await readFile(filePath);
      reply.header("content-type", getStaticContentType(filePath));
      if (filePath.includes("/_next/")) {
        reply.header("cache-control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith(".html")) {
        reply.header("cache-control", "no-cache");
      }
      return reply.code(200).send(payload);
    },
  });

  return app;
}
