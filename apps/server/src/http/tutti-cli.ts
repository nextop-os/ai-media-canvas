import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "@tutti-os/agent-acp-kit/tutti";

import {
  type RunCreateRequest,
  type RunCreateResponse,
  canvasContentSchema,
  chatMessageCreateRequestSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  projectCreateRequestSchema,
  runCreateRequestSchema,
} from "@aimc/shared";

import type { ServerEnv } from "../config/env.js";
import {
  insertImageGenerationNode,
  insertVideoGenerationNode,
} from "../features/canvas/canvas-element-writer.js";
import { CanvasServiceError } from "../features/canvas/canvas-service.js";
import { ChatServiceError } from "../features/chat/chat-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import {
  LOCAL_WORKSPACE_ID,
  type SettingsService,
} from "../features/settings/settings-service.js";
import { SkillServiceError } from "../features/skills/skill-service.js";
import type { CanvasOperations } from "./canvas-operations.js";
import type { ChatOperations } from "./chat-operations.js";
import { listImageModels } from "./image-models.js";
import type { JobOperations } from "./job-operations.js";
import { listAgentModelCatalog } from "./models.js";
import type { ProjectOperations } from "./project-operations.js";
import type { SkillOperations } from "./skill-operations.js";
import { isZodError, sendCliError, sendCliJson } from "./tutti-cli-output.js";
import { listVideoModels } from "./video-models.js";

const execFileAsync = promisify(execFile);

type AgentCliOperations = {
  cancelRun: (runId: string) => Promise<unknown>;
  listRunEvents: (runId: string, cursor: number) => Promise<unknown>;
  submitConsent?: (payload: {
    decision: "allow-once" | "always" | "deny";
    runId: string;
  }) => Promise<unknown>;
  startRun: (payload: RunCreateRequest) => Promise<RunCreateResponse>;
};

type AssetCliOperations = {
  listProjectAssets: (input: {
    projectId: string;
    filterText?: string;
    limit: number;
    cursor?: string | null;
  }) => Promise<unknown>;
};

type CanvasWriterClient = Parameters<typeof insertImageGenerationNode>[0];
type AppOpenRequester = (input: {
  appId: string;
  params?: Record<string, string>;
  route: string;
  tuttiCliPath?: string;
}) => Promise<void>;

const IMAGE_GENERATION_POLL_INTERVAL_MS = 5_000;
const VIDEO_GENERATION_POLL_INTERVAL_MS = 30_000;
const IMAGE_GENERATION_INITIAL_DELAY_MS = 15_000;
const VIDEO_GENERATION_INITIAL_DELAY_MS = 60_000;
const IMAGE_GENERATION_MAX_WAIT_MS = 10 * 60_000;
const VIDEO_GENERATION_MAX_WAIT_MS = 2 * 60 * 60_000;

const emptyBodySchema = z.object({}).passthrough().optional();
const openCliBodySchema = z.object({
  "project-id": z.string().min(1).optional(),
});
const projectCreateCliBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  "parent-path": z.string().min(1).optional(),
});
const canvasSaveCliBodySchema = z.object({
  "canvas-id": z.string().min(1),
  "base-revision": z.coerce.number().int().nonnegative().optional(),
  "content-json": z.string().min(1),
});
const canvasInsertImageCliBodySchema = z.object({
  "canvas-id": z.string().min(1),
  "file-path": z.string().min(1),
  "project-id": z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  "mime-type": z.string().min(1).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  "placement-width": z.number().positive().optional(),
  "placement-height": z.number().positive().optional(),
});
const canvasInsertVideoCliBodySchema = canvasInsertImageCliBodySchema.extend({
  duration: z.number().int().positive().optional(),
});
const assetListCliBodySchema = z.object({
  "project-id": z.string().min(1),
  "filter-text": z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
  cursor: z.string().min(1).optional(),
});
const sessionCreateCliBodySchema = z.object({
  "canvas-id": z.string().min(1),
  title: z.string().min(1).optional(),
});
const messageCreateCliBodySchema = z.object({
  "session-id": z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
const agentRunCliBodySchema = z.object({
  "session-id": z.string().min(1),
  "conversation-id": z.string().min(1),
  prompt: z.string(),
  "canvas-id": z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  "agent-id": z.string().min(1).optional(),
  "runtime-kind": z.literal("local-agent").optional(),
  "runtime-provider": z.string().min(1).optional(),
  "codex-imagegen-consent": z.enum(["allow-once"]).optional(),
});
const agentEventsCliBodySchema = z.object({
  "run-id": z.string().min(1),
  cursor: z.number().int().nonnegative().optional(),
});
const agentConsentCliBodySchema = z.object({
  "run-id": z.string().min(1),
  decision: z.enum(["allow-once", "always", "deny"]),
});
const jobListCliBodySchema = z.object({
  status: z.string().min(1).optional(),
  "job-type": z.string().min(1).optional(),
});
const generationImageCliBodySchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  model: z.string().min(1),
  "project-id": z.string().min(1),
  "canvas-id": z.string().min(1).optional(),
  "session-id": z.string().min(1).optional(),
  "aspect-ratio": z.string().min(1).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
  size: z.string().min(1).optional(),
  seed: z.number().int().optional(),
  "input-images": z.string().min(1).optional(),
  "caller-provider": z.string().min(1).optional(),
  "codex-imagegen-consent": z.enum(["allow-once"]).optional(),
  "direct-user": z.boolean().optional(),
});
const generationVideoCliBodySchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  model: z.string().min(1),
  "project-id": z.string().min(1),
  "canvas-id": z.string().min(1).optional(),
  "session-id": z.string().min(1).optional(),
  duration: z.number().int().positive().optional(),
  resolution: z.string().min(1).optional(),
  "aspect-ratio": z.string().min(1).optional(),
  "input-images": z.string().min(1).optional(),
  "input-video": z.string().min(1).optional(),
  "negative-prompt": z.string().min(1).optional(),
  seed: z.number().int().optional(),
  "enable-audio": z.boolean().optional(),
});
const settingsUpdateCliBodySchema = z.object({
  "codex-imagegen-delegation": z.enum(["ask", "always", "never"]).optional(),
});
const skillEnableCliBodySchema = z.object({
  "skill-id": z.string().min(1),
  enabled: z.boolean(),
});

export async function registerTuttiCliRoutes(
  app: FastifyInstance,
  options: {
    agentOperations: AgentCliOperations;
    assetOperations: AssetCliOperations;
    canvasOperations: CanvasOperations;
    chatOperations: ChatOperations;
    env: ServerEnv;
    jobOperations: JobOperations;
    projectOperations: ProjectOperations;
    settingsService?: SettingsService;
    skillOperations: SkillOperations;
    localCanvasClient?: CanvasWriterClient;
    appOpenRequester?: AppOpenRequester;
  },
) {
  const route = (
    path: string,
    handler: (body: unknown, request: FastifyRequest) => Promise<unknown>,
    statusCode = 200,
  ) => {
    const register = (routePath: string) =>
      app.post(routePath, async (request, reply) => {
        try {
          const result = await handler(readCliInputBody(request.body), request);
          return sendCliJson(reply, result, statusCode);
        } catch (error) {
          return sendCliRouteError(error, reply);
        }
      });
    register(path);
  };

  route("/tutti/cli/status", async (body) => {
    emptyBodySchema.parse(body);
    return {
      ok: true,
      service: "ai-media-canvas-server",
      version: options.env.version,
      runtime: {
        webOrigin: options.env.webOrigin,
        trustedLocalAgentMode: options.env.trustedLocalAgentMode,
      },
    };
  });

  route("/tutti/cli/open", async (body) => {
    const payload = openCliBodySchema.parse(body ?? {});
    const target = payload["project-id"]
      ? await resolveProjectOpenTarget(
          options.projectOperations,
          payload["project-id"],
        )
      : {
          route: "/home",
        };
    await requestTuttiAppOpen(options.env, target, options.appOpenRequester);
    return {
      openRequested: true,
      ...target,
    };
  });

  route("/tutti/cli/projects/list", async () =>
    options.projectOperations.listProjects(),
  );
  route("/tutti/cli/projects/get", async (body) => {
    return options.projectOperations.getProject(
      parseRequiredString(body, "project-id"),
    );
  });
  route(
    "/tutti/cli/projects/create",
    async (body) => {
      const parsed = projectCreateCliBodySchema.parse(body);
      const payload = projectCreateRequestSchema.parse({
        name: parsed.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed["parent-path"]
          ? { parentPath: parsed["parent-path"] }
          : {}),
      });
      return options.projectOperations.createProject(payload);
    },
    201,
  );

  route("/tutti/cli/canvases/get", async (body) => {
    return stripCanvasResponseFilePayloads(
      await options.canvasOperations.getCanvas(
        parseRequiredString(body, "canvas-id"),
      ),
    );
  });
  route("/tutti/cli/canvases/save", async (body) => {
    const payload = canvasSaveCliBodySchema.parse(body);
    const content = canvasContentSchema.parse(
      JSON.parse(payload["content-json"]),
    );
    return options.canvasOperations.saveCanvas(
      payload["canvas-id"],
      content,
      payload["base-revision"] === undefined
        ? {}
        : { baseRevision: payload["base-revision"] },
    );
  });
  route("/tutti/cli/canvases/insert-image", async (body) => {
    const payload = canvasInsertImageCliBodySchema.parse(body);
    const placement = {
      ...(payload.x !== undefined ? { x: payload.x } : {}),
      ...(payload.y !== undefined ? { y: payload.y } : {}),
      ...(payload["placement-width"] !== undefined
        ? { width: payload["placement-width"] }
        : {}),
      ...(payload["placement-height"] !== undefined
        ? { height: payload["placement-height"] }
        : {}),
    };
    return options.canvasOperations.importImageFile({
      canvasId: payload["canvas-id"],
      filePath: payload["file-path"],
      ...(payload["project-id"] ? { projectId: payload["project-id"] } : {}),
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload["mime-type"] ? { mimeType: payload["mime-type"] } : {}),
      ...(payload.width !== undefined ? { width: payload.width } : {}),
      ...(payload.height !== undefined ? { height: payload.height } : {}),
      ...(Object.keys(placement).length > 0 ? { placement } : {}),
    });
  });
  route("/tutti/cli/canvases/insert-video", async (body) => {
    const payload = canvasInsertVideoCliBodySchema.parse(body);
    const placement = {
      ...(payload.x !== undefined ? { x: payload.x } : {}),
      ...(payload.y !== undefined ? { y: payload.y } : {}),
      ...(payload["placement-width"] !== undefined
        ? { width: payload["placement-width"] }
        : {}),
      ...(payload["placement-height"] !== undefined
        ? { height: payload["placement-height"] }
        : {}),
    };
    return options.canvasOperations.importVideoFile({
      canvasId: payload["canvas-id"],
      filePath: payload["file-path"],
      ...(payload["project-id"] ? { projectId: payload["project-id"] } : {}),
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload["mime-type"] ? { mimeType: payload["mime-type"] } : {}),
      ...(payload.width !== undefined ? { width: payload.width } : {}),
      ...(payload.height !== undefined ? { height: payload.height } : {}),
      ...(payload.duration !== undefined
        ? { durationSeconds: payload.duration }
        : {}),
      ...(Object.keys(placement).length > 0 ? { placement } : {}),
    });
  });
  route("/tutti/cli/assets/list", async (body) => {
    const payload = assetListCliBodySchema.parse(body);
    return options.assetOperations.listProjectAssets({
      projectId: payload["project-id"],
      ...(payload["filter-text"] ? { filterText: payload["filter-text"] } : {}),
      limit: payload.limit ?? 50,
      cursor: payload.cursor ?? null,
    });
  });

  route("/tutti/cli/sessions/list", async (body) => {
    return options.chatOperations.listSessions(
      parseRequiredString(body, "canvas-id"),
    );
  });
  route(
    "/tutti/cli/sessions/create",
    async (body) => {
      const payload = sessionCreateCliBodySchema.parse(body);
      return options.chatOperations.createSession(
        payload["canvas-id"],
        payload.title,
      );
    },
    201,
  );
  route("/tutti/cli/messages/list", async (body) => {
    return options.chatOperations.listMessages(
      parseRequiredString(body, "session-id"),
    );
  });
  route(
    "/tutti/cli/messages/create",
    async (body) => {
      const payload = messageCreateCliBodySchema.parse(body);
      return options.chatOperations.createMessage(
        payload["session-id"],
        chatMessageCreateRequestSchema.parse({
          role: payload.role,
          content: payload.content,
        }),
      );
    },
    201,
  );

  route(
    "/tutti/cli/agent/run",
    async (body, request) => {
      const payload = agentRunCliBodySchema.parse(body);
      const runInput = runCreateRequestSchema.parse({
        sessionId: payload["session-id"],
        conversationId: payload["conversation-id"],
        prompt: payload.prompt,
        ...(payload["canvas-id"] ? { canvasId: payload["canvas-id"] } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload["agent-id"] ? { agentTargetId: payload["agent-id"] } : {}),
        ...(payload["runtime-kind"]
          ? { runtimeKind: payload["runtime-kind"] }
          : {}),
        ...(payload["runtime-provider"]
          ? { runtimeProvider: payload["runtime-provider"] }
          : {}),
        ...(payload["codex-imagegen-consent"]
          ? {
              delegationConsent: {
                codexImagegen: payload["codex-imagegen-consent"],
              },
            }
          : {}),
      });
      try {
        return await options.agentOperations.startRun(runInput);
      } catch (error) {
        if (isPublicAgentRunCliError(error)) throw error;
        throw {
          code: "application_error",
          message: "Unable to start local agent run.",
          statusCode: 500,
        };
      }
    },
    202,
  );
  route("/tutti/cli/agent/events", async (body) => {
    const payload = agentEventsCliBodySchema.parse(body);
    return options.agentOperations.listRunEvents(
      payload["run-id"],
      payload.cursor ?? 0,
    );
  });
  route(
    "/tutti/cli/agent/cancel",
    async (body) => {
      return options.agentOperations.cancelRun(
        parseRequiredString(body, "run-id"),
      );
    },
    202,
  );
  route(
    "/tutti/cli/agent/consent",
    async (body) => {
      if (!options.agentOperations.submitConsent) {
        throw new Error("Agent consent is not supported by this server.");
      }
      const payload = agentConsentCliBodySchema.parse(body);
      return options.agentOperations.submitConsent({
        runId: payload["run-id"],
        decision: payload.decision,
      });
    },
    202,
  );

  route(
    "/tutti/cli/generation/image",
    async (body) => {
      const payload = generationImageCliBodySchema.parse(body);
      const callerProvider = payload["direct-user"]
        ? undefined
        : (payload["caller-provider"] ?? "external-cli");
      const projectId = payload["project-id"];
      const canvasId =
        payload["canvas-id"] ??
        (await resolvePrimaryCanvasId(options.projectOperations, projectId));
      const result = await options.jobOperations.createImageJob(
        createImageJobRequestSchema.parse({
          prompt: payload.prompt,
          ...(payload.title ? { title: payload.title } : {}),
          model: payload.model,
          project_id: projectId,
          canvas_id: canvasId,
          ...(payload["session-id"]
            ? { session_id: payload["session-id"] }
            : {}),
          ...(payload["aspect-ratio"]
            ? { aspect_ratio: payload["aspect-ratio"] }
            : {}),
          ...(payload.quality ? { quality: payload.quality } : {}),
          ...(payload.size ? { size: payload.size } : {}),
          ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
          ...(payload["input-images"]
            ? { input_images: splitCsv(payload["input-images"]) }
            : {}),
          ...(callerProvider ? { caller_provider: callerProvider } : {}),
          ...(payload["codex-imagegen-consent"]
            ? {
                codex_imagegen_consent: payload["codex-imagegen-consent"],
                codex_imagegen_delegation_allowed: true,
              }
            : {}),
        }),
      );
      await insertCliImageGenerationNode({
        canvasId,
        payload,
        result,
        ...(options.localCanvasClient
          ? { localCanvasClient: options.localCanvasClient }
          : {}),
      });
      return withGenerationJobNextAction(result, {
        initialDelayMs: IMAGE_GENERATION_INITIAL_DELAY_MS,
        jobType: "image_generation",
      });
    },
    201,
  );
  route(
    "/tutti/cli/generation/video",
    async (body) => {
      const payload = generationVideoCliBodySchema.parse(body);
      const projectId = payload["project-id"];
      const canvasId =
        payload["canvas-id"] ??
        (await resolvePrimaryCanvasId(options.projectOperations, projectId));
      const result = await options.jobOperations.createVideoJob(
        createVideoJobRequestSchema.parse({
          prompt: payload.prompt,
          ...(payload.title ? { title: payload.title } : {}),
          model: payload.model,
          project_id: projectId,
          canvas_id: canvasId,
          ...(payload["session-id"]
            ? { session_id: payload["session-id"] }
            : {}),
          ...(payload.duration ? { duration: payload.duration } : {}),
          ...(payload.resolution ? { resolution: payload.resolution } : {}),
          ...(payload["aspect-ratio"]
            ? { aspect_ratio: payload["aspect-ratio"] }
            : {}),
          ...(payload["input-images"]
            ? { input_images: splitCsv(payload["input-images"]) }
            : {}),
          ...(payload["input-video"]
            ? { input_video: payload["input-video"] }
            : {}),
          ...(payload["negative-prompt"]
            ? { negative_prompt: payload["negative-prompt"] }
            : {}),
          ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
          ...(payload["enable-audio"] !== undefined
            ? { enable_audio: payload["enable-audio"] }
            : {}),
        }),
      );
      await insertCliVideoGenerationNode({
        canvasId,
        payload,
        result,
        ...(options.localCanvasClient
          ? { localCanvasClient: options.localCanvasClient }
          : {}),
      });
      return withGenerationJobNextAction(result, {
        initialDelayMs: VIDEO_GENERATION_INITIAL_DELAY_MS,
        jobType: "video_generation",
      });
    },
    201,
  );

  route("/tutti/cli/jobs/list", async (body) => {
    const payload = jobListCliBodySchema.parse(body ?? {});
    return options.jobOperations.listJobs({
      ...(payload.status ? { status: payload.status as never } : {}),
      ...(payload["job-type"] ? { jobType: payload["job-type"] as never } : {}),
    });
  });
  route("/tutti/cli/jobs/get", async (body) => {
    return withGenerationJobNextAction(
      await options.jobOperations.getJob(parseRequiredString(body, "job-id")),
    );
  });
  route("/tutti/cli/jobs/cancel", async (body) => {
    return options.jobOperations.cancelJob(parseRequiredString(body, "job-id"));
  });

  route("/tutti/cli/models/list", async () =>
    listAgentModelCatalog({
      env: options.env,
      logger: app.log,
      ...(options.settingsService
        ? { settingsService: options.settingsService }
        : {}),
    }),
  );
  route("/tutti/cli/models/image", async () => ({
    models: await listImageModels(options.env, options.settingsService),
  }));
  route("/tutti/cli/models/video", async () => ({
    models: await listVideoModels(options.env, options.settingsService),
  }));

  route("/tutti/cli/settings/get", async () => {
    if (!options.settingsService) {
      throw new Error("Workspace settings are not supported by this server.");
    }
    return {
      settings: await options.settingsService.getWorkspaceSettings(
        null,
        LOCAL_WORKSPACE_ID,
      ),
    };
  });
  route("/tutti/cli/settings/update", async (body) => {
    if (!options.settingsService) {
      throw new Error("Workspace settings are not supported by this server.");
    }
    const payload = settingsUpdateCliBodySchema.parse(body ?? {});
    const current = await options.settingsService.getWorkspaceSettings(
      null,
      LOCAL_WORKSPACE_ID,
    );
    const settings = await options.settingsService.updateWorkspaceSettings(
      null,
      LOCAL_WORKSPACE_ID,
      {
        ...current,
        ...(payload["codex-imagegen-delegation"]
          ? {
              codexImagegenDelegation: payload["codex-imagegen-delegation"],
            }
          : {}),
      },
    );
    return { settings };
  });

  route("/tutti/cli/skills/list", async () =>
    options.skillOperations.listInstalledSkills(),
  );
  route("/tutti/cli/skills/get", async (body) => {
    return options.skillOperations.getSkill(
      parseRequiredString(body, "skill-id"),
    );
  });
  route("/tutti/cli/skills/enable", async (body) => {
    const payload = skillEnableCliBodySchema.parse(body);
    return options.skillOperations.toggleSkill(
      payload["skill-id"],
      payload.enabled,
    );
  });
  route("/tutti/cli/skills/install", async (body) => {
    return options.skillOperations.installCatalogSkill(
      parseRequiredString(body, "skill-id"),
    );
  });
}

async function resolvePrimaryCanvasId(
  projectOperations: ProjectOperations,
  projectId: string,
) {
  const target = await resolveProjectOpenTarget(projectOperations, projectId);
  return target.canvasId;
}

async function resolveProjectOpenTarget(
  projectOperations: ProjectOperations,
  projectId: string,
) {
  const { projects } = await projectOperations.listProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project) {
    throw new ProjectServiceError(
      "project_not_found",
      "Project not found.",
      404,
    );
  }
  const canvasId = project.primaryCanvas.id;
  return {
    projectId,
    canvasId,
    route: "/canvas",
    params: {
      id: canvasId,
    },
  };
}

async function requestTuttiAppOpen(
  env: ServerEnv,
  target: {
    params?: Record<string, string>;
    route: string;
  },
  appOpenRequester: AppOpenRequester = invokeTuttiAppOpen,
) {
  const { route } = target;
  if (!route.startsWith("/") || route.startsWith("//")) {
    throw {
      code: "open_unavailable",
      message: "Open target route is invalid.",
      statusCode: 500,
    };
  }
  if (!env.tuttiAppId) {
    throw {
      code: "open_unavailable",
      message: "Tutti app id is not configured for this runtime.",
      statusCode: 503,
    };
  }
  await appOpenRequester({
    appId: env.tuttiAppId,
    route,
    ...(target.params ? { params: target.params } : {}),
    ...(env.tuttiCliPath ? { tuttiCliPath: env.tuttiCliPath } : {}),
  });
}

async function invokeTuttiAppOpen(input: {
  appId: string;
  params?: Record<string, string>;
  route: string;
  tuttiCliPath?: string;
}) {
  const tuttiCliPath = input.tuttiCliPath;
  if (!tuttiCliPath) {
    throw {
      code: "open_unavailable",
      message: "Tutti CLI is not configured for this runtime.",
      statusCode: 503,
    };
  }

  const child = projectTuttiCliChildProcess({
    baseEnv: process.env,
  });
  try {
    const args = [
      "app",
      "open",
      "--app-id",
      input.appId,
      "--route",
      input.route,
    ];
    for (const [key, value] of Object.entries(input.params ?? {})) {
      args.push("--param", `${key}=${value}`);
    }
    await execFileAsync(tuttiCliPath, args, {
      env: child.env,
      timeout: 30_000,
    });
  } catch (error) {
    throw {
      code: "open_failed",
      message: readProcessErrorMessage(error, child.redactionSecrets),
      statusCode: 502,
    };
  }
}

function readProcessErrorMessage(
  error: unknown,
  redactionSecrets: readonly string[],
) {
  let message = "Unable to request app open.";
  if (isRecord(error)) {
    const processOutput =
      readProcessOutput(error.stderr) ?? readProcessOutput(error.stdout);
    if (processOutput) {
      message = processOutput;
    } else if (typeof error.message === "string" && error.message.length > 0) {
      message = error.message;
    }
  }
  return redactTuttiCliChildProcessText(message, redactionSecrets);
}

function readProcessOutput(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Buffer.isBuffer(value) && value.length > 0) {
    return value.toString("utf8").trim();
  }
  return undefined;
}

async function insertCliImageGenerationNode(input: {
  canvasId: string;
  localCanvasClient?: CanvasWriterClient;
  payload: z.infer<typeof generationImageCliBodySchema>;
  result: unknown;
}) {
  if (!input.localCanvasClient) return;
  const jobId = readJobId(input.result);
  if (!jobId) return;
  await insertImageGenerationNode(input.localCanvasClient, {
    canvasId: input.canvasId,
    jobId,
    prompt: input.payload.prompt,
    model: input.payload.model,
    aspectRatio: input.payload["aspect-ratio"] ?? "1:1",
    ...(input.payload.quality ? { quality: input.payload.quality } : {}),
    ...(input.payload["input-images"]
      ? { inputImages: splitCsv(input.payload["input-images"]) }
      : {}),
  });
}

async function insertCliVideoGenerationNode(input: {
  canvasId: string;
  localCanvasClient?: CanvasWriterClient;
  payload: z.infer<typeof generationVideoCliBodySchema>;
  result: unknown;
}) {
  if (!input.localCanvasClient) return;
  const jobId = readJobId(input.result);
  if (!jobId) return;
  await insertVideoGenerationNode(input.localCanvasClient, {
    canvasId: input.canvasId,
    jobId,
    prompt: input.payload.prompt,
    model: input.payload.model,
    aspectRatio: input.payload["aspect-ratio"] ?? "16:9",
    ...(input.payload.duration ? { duration: input.payload.duration } : {}),
    ...(input.payload.resolution
      ? { resolution: input.payload.resolution }
      : {}),
    ...(input.payload["input-images"]
      ? { inputImages: splitCsv(input.payload["input-images"]) }
      : {}),
  });
}

function readJobId(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const job = (value as { job?: unknown }).job;
  if (!job || typeof job !== "object") return null;
  const id = (job as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function withGenerationJobNextAction<T>(
  value: T,
  options: {
    initialDelayMs?: number;
    jobType?: "image_generation" | "video_generation";
  } = {},
): T {
  if (!isRecord(value)) return value;
  const jobId = readJobId(value);
  const polling = getGenerationJobPollingConfig(value, options.jobType);
  const initialDelayMs = options.initialDelayMs ?? 0;
  return {
    ...value,
    nextAction: {
      command: `aimc jobs get --job-id ${jobId ?? "<job-id>"}`,
      intermediateStatuses: ["queued", "running"],
      terminalStatuses: ["succeeded", "failed", "canceled", "dead_letter"],
      ...(initialDelayMs > 0 ? { initialDelayMs } : {}),
      pollIntervalMs: polling.pollIntervalMs,
      maxWaitMs: polling.maxWaitMs,
      guidance:
        "After a generation command, wait initialDelayMs before the first poll when present. Then sleep pollIntervalMs between polls while status is queued or running. Do not tell the user the generation failed or finished until the job reaches a terminal status. On succeeded, report the generated asset from job.result and mention that the canvas node was updated.",
    },
  };
}

function getGenerationJobPollingConfig(
  value: unknown,
  fallbackJobType?: "image_generation" | "video_generation",
) {
  const jobType = readJobType(value) ?? fallbackJobType;
  return jobType === "video_generation"
    ? {
        pollIntervalMs: VIDEO_GENERATION_POLL_INTERVAL_MS,
        maxWaitMs: VIDEO_GENERATION_MAX_WAIT_MS,
      }
    : {
        pollIntervalMs: IMAGE_GENERATION_POLL_INTERVAL_MS,
        maxWaitMs: IMAGE_GENERATION_MAX_WAIT_MS,
      };
}

function readJobType(value: unknown) {
  if (!isRecord(value) || !isRecord(value.job)) return null;
  return value.job.job_type === "image_generation" ||
    value.job.job_type === "video_generation"
    ? value.job.job_type
    : null;
}

function parseRequiredString(body: unknown, key: string) {
  const payload = z.record(z.string(), z.unknown()).parse(body);
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required input: ${key}`);
  }
  return value;
}

function readCliInputBody(body: unknown) {
  if (!isRecord(body) || !isCliInvokeEnvelope(body)) {
    return body;
  }

  return body.input ?? {};
}

function isCliInvokeEnvelope(body: Record<string, unknown>) {
  const keys = Object.keys(body);
  if (!Object.hasOwn(body, "input")) {
    return false;
  }
  if (body.schemaVersion === "tutti.app.cli.invoke.v1") {
    return true;
  }
  if (
    Object.hasOwn(body, "commandId") &&
    Object.hasOwn(body, "appId") &&
    Object.hasOwn(body, "scope") &&
    Object.hasOwn(body, "path")
  ) {
    return true;
  }
  return (
    keys.length > 0 &&
    keys.every(
      (key) => key === "input" || key === "outputMode" || key === "context",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCanvasResponseFilePayloads(response: unknown) {
  if (!isRecord(response) || !isRecord(response.canvas)) return response;
  const canvas = response.canvas;
  if (!isRecord(canvas.content) || !isRecord(canvas.content.files)) {
    return response;
  }
  return {
    ...response,
    canvas: {
      ...canvas,
      content: {
        ...canvas.content,
        files: stripCanvasFilePayloads(canvas.content.files),
      },
    },
  };
}

function stripCanvasFilePayloads(files: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(files).map(([fileId, file]) => {
      if (!isRecord(file)) return [fileId, file];
      const metadata = Object.fromEntries(
        Object.entries(file).filter(
          ([key]) => key !== "dataURL" && key !== "dataUrl",
        ),
      );
      return [fileId, metadata];
    }),
  );
}

function splitCsv(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isCliStatusError(error: unknown): error is {
  code: string;
  message: string;
  statusCode: number;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "statusCode" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

const PUBLIC_AGENT_RUN_ERROR_CODES = new Set([
  "agent_target_unavailable",
  "invalid_model",
  "local_agent_disabled",
  "session_not_found",
]);

function isPublicAgentRunCliError(
  error: unknown,
): error is { code: string; message: string; statusCode: number } {
  return (
    isCliStatusError(error) &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    PUBLIC_AGENT_RUN_ERROR_CODES.has(error.code)
  );
}

function sendCliRouteError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof CanvasServiceError ||
    error instanceof ChatServiceError ||
    error instanceof JobServiceError ||
    error instanceof ProjectServiceError ||
    error instanceof SkillServiceError
  ) {
    return sendCliError(
      reply,
      { code: error.code, message: error.message },
      error.statusCode,
    );
  }

  if (
    isZodError(error) ||
    error instanceof SyntaxError ||
    (error instanceof Error &&
      error.message.startsWith("Missing required input:"))
  ) {
    return sendCliError(
      reply,
      {
        code: "application_error",
        message: "Invalid command input.",
      },
      400,
    );
  }

  if (isCliStatusError(error)) {
    return sendCliError(
      reply,
      { code: error.code, message: error.message },
      error.statusCode,
    );
  }

  return sendCliError(
    reply,
    {
      code: "application_error",
      message: error instanceof Error ? error.message : "Command failed.",
    },
    500,
  );
}
