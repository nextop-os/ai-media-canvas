import type { FastifyInstance } from "fastify";

import { healthResponseSchema } from "@aimc/shared";

import type { ServerEnv } from "../config/env.js";
import {
  TSH_DEFAULT_PARENT_PATH,
  isTshWorkspaceAppHost,
} from "../local/tsh-workspace.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  env: ServerEnv,
) {
  app.get("/api/health", async (_request, reply) => {
    const tshWorkspaceApp = isTshWorkspaceAppHost();
    const payload = healthResponseSchema.parse({
      ok: true,
      service: "ai-media-canvas-server",
      version: env.version,
      ...(tshWorkspaceApp
        ? {
            tshWorkspaceApp: true,
            defaultParentPath: TSH_DEFAULT_PARENT_PATH,
          }
        : { tshWorkspaceApp: false }),
    });

    return reply.code(200).send(payload);
  });
}
