import type { FastifyInstance } from "fastify";

import {
  applicationErrorResponseSchema,
  workspaceSettingsResponseSchema,
  workspaceSettingsUpdateRequestSchema,
} from "@aimc/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import {
  LOCAL_WORKSPACE_ID,
  type SettingsService,
} from "../features/settings/settings-service.js";
import {
  detectCodexImagegenCapability,
  detectConfiguredCodexImagegenCapability,
} from "../generation/providers/codex-imagegen-capability.js";

export async function registerSettingsRoutes(
  app: FastifyInstance,
  options: {
    localUser: AuthenticatedUser;
    settingsService: SettingsService;
  },
) {
  app.get("/api/workspace/settings", async (_request, reply) => {
    try {
      const settings = await options.settingsService.getWorkspaceSettings(
        options.localUser,
        LOCAL_WORKSPACE_ID,
      );
      return reply
        .code(200)
        .send(workspaceSettingsResponseSchema.parse({ settings }));
    } catch {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "application_error",
            message: "Unable to load local workspace settings.",
          },
        }),
      );
    }
  });

  app.get("/api/workspace/settings/codex-imagegen", async (_request, reply) => {
    try {
      const effectiveEnv =
        await options.settingsService.getEffectiveServerEnv(LOCAL_WORKSPACE_ID);
      const capability = effectiveEnv.tuttiCliPath
        ? await detectConfiguredCodexImagegenCapability({
            enabled: effectiveEnv.codexImagegenEnabled === true,
            tuttiCliPath: effectiveEnv.tuttiCliPath,
            ...(effectiveEnv.codexImagegenCodexHome
              ? { codexHome: effectiveEnv.codexImagegenCodexHome }
              : {}),
            ...(effectiveEnv.codexImagegenTimeoutMs
              ? { timeoutMs: effectiveEnv.codexImagegenTimeoutMs }
              : {}),
          })
        : detectCodexImagegenCapability({
            enabled: effectiveEnv.codexImagegenEnabled === true,
            ...(effectiveEnv.codexImagegenCodexHome
              ? { codexHome: effectiveEnv.codexImagegenCodexHome }
              : {}),
            ...(effectiveEnv.codexImagegenTimeoutMs
              ? { timeoutMs: effectiveEnv.codexImagegenTimeoutMs }
              : {}),
          });
      return reply.code(200).send({
        capability,
      });
    } catch {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "application_error",
            message: "Unable to inspect Codex Imagegen settings.",
          },
        }),
      );
    }
  });

  app.put("/api/workspace/settings", async (request, reply) => {
    try {
      const payload = workspaceSettingsUpdateRequestSchema.parse(request.body);
      const settings = await options.settingsService.updateWorkspaceSettings(
        options.localUser,
        LOCAL_WORKSPACE_ID,
        payload,
      );
      return reply
        .code(200)
        .send(workspaceSettingsResponseSchema.parse({ settings }));
    } catch {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "application_error",
            message: "Unable to update local workspace settings.",
          },
        }),
      );
    }
  });
}
