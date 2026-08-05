/**
 * Centralized provider registration.
 *
 * Both the HTTP server (app.ts) and the background worker (worker.ts) need the
 * same set of image/video generation providers. This module is the single
 * source of truth so that adding a new provider only requires a change here.
 */
import type { ServerEnv } from "../../config/env.js";
import { AgnesImageProvider } from "./agnes-image.js";
import { AgnesVideoProvider } from "./agnes-video.js";
import {
  type CodexImagegenCapability,
  detectCodexImagegenCapability,
  detectConfiguredCodexImagegenCapability,
} from "./codex-imagegen-capability.js";
import { CodexImagegenProvider } from "./codex-imagegen.js";
import { GoogleImageProvider } from "./google-image.js";
import { GoogleVertexImageProvider } from "./google-vertex-image.js";
import { GoogleVertexVideoProvider } from "./google-vertex-video.js";
import { GoogleVideoProvider } from "./google-video.js";
import { KieImageProvider } from "./kie-image.js";
import { KieVideoProvider } from "./kie-video.js";
import {
  OpenAIImageProvider,
  isValidOpenAIImageBaseURL,
} from "./openai-image.js";
import { registerImageProvider, registerVideoProvider } from "./registry.js";
import { ReplicateImageProvider } from "./replicate-image.js";
import { ReplicateVideoProvider } from "./replicate-video.js";
import { VolcesImageProvider } from "./volces-image.js";

type GenerationProviderLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
};

let lastCodexImagegenCapabilityLogKey: string | undefined;

/**
 * Register all available generation providers based on the provided env config.
 *
 * Each provider is only registered when its required API key is present,
 * keeping the behaviour identical to the previous inline registration while
 * ensuring every process gets the full set.
 */
export function registerAllProviders(
  env: ServerEnv,
  options: {
    detectCodexImagegenCapability?: (env: ServerEnv) => CodexImagegenCapability;
    logger?: GenerationProviderLogger;
  } = {},
): void {
  if (!env.codexImagegenEnabled) {
    logCodexImagegenCapability(
      {
        ready: false,
        reasons: ["disabled"],
        checkedAt: new Date().toISOString(),
      },
      options.logger,
    );
  } else {
    if (env.tuttiCliPath) {
      registerImageProvider(
        new CodexImagegenProvider({
          ...(env.codexImagegenCodexHome
            ? { codexHome: env.codexImagegenCodexHome }
            : {}),
          ...(env.codexImagegenAgentModel
            ? { agentModel: env.codexImagegenAgentModel }
            : {}),
          ...(env.codexImagegenTimeoutMs
            ? { timeoutMs: env.codexImagegenTimeoutMs }
            : {}),
          resolveCapability: () =>
            detectConfiguredCodexImagegenCapability({
              enabled: true,
              ...(env.codexImagegenCodexHome
                ? { codexHome: env.codexImagegenCodexHome }
                : {}),
              ...(env.codexImagegenTimeoutMs
                ? { timeoutMs: env.codexImagegenTimeoutMs }
                : {}),
            }),
        }),
      );
    } else {
      const capability = options.detectCodexImagegenCapability
        ? options.detectCodexImagegenCapability(env)
        : detectCodexImagegenCapability({
            enabled: true,
            ...(env.codexImagegenCodexHome
              ? { codexHome: env.codexImagegenCodexHome }
              : {}),
            ...(env.codexImagegenTimeoutMs
              ? { timeoutMs: env.codexImagegenTimeoutMs }
              : {}),
          });
      logCodexImagegenCapability(capability, options.logger);
      if (capability.ready) {
        registerImageProvider(
          new CodexImagegenProvider({
            ...(env.codexImagegenCodexHome
              ? { codexHome: env.codexImagegenCodexHome }
              : {}),
            ...(env.codexImagegenAgentModel
              ? { agentModel: env.codexImagegenAgentModel }
              : {}),
            ...(env.codexImagegenTimeoutMs
              ? { timeoutMs: env.codexImagegenTimeoutMs }
              : {}),
          }),
        );
      }
    }
  }

  if (env.agnesApiKey) {
    registerImageProvider(
      new AgnesImageProvider(env.agnesApiKey, env.agnesBaseUrl),
    );
    registerVideoProvider(
      new AgnesVideoProvider(env.agnesApiKey, env.agnesBaseUrl),
    );
  }

  if (env.kieApiKey) {
    registerImageProvider(new KieImageProvider(env.kieApiKey, env.kieBaseUrl));
    registerVideoProvider(new KieVideoProvider(env.kieApiKey, env.kieBaseUrl));
  }

  // Replicate — image + video
  if (env.replicateApiToken) {
    registerImageProvider(new ReplicateImageProvider(env.replicateApiToken));
    registerVideoProvider(new ReplicateVideoProvider(env.replicateApiToken));
  }

  // Google Developer API — image + video
  if (env.googleApiKey) {
    registerImageProvider(new GoogleImageProvider(env.googleApiKey));
    registerVideoProvider(new GoogleVideoProvider(env.googleApiKey));
  }

  // Google Vertex AI — image + video (coexists with Developer API)
  // Image/LLM models use the default location (global), while video models
  // require a separate regional endpoint (us-central1).
  if (env.googleVertexProject && env.googleVertexLocation) {
    const vertexConfig = {
      project: env.googleVertexProject,
      location: env.googleVertexLocation,
    };
    registerImageProvider(new GoogleVertexImageProvider(vertexConfig));

    const videoLocation =
      env.googleVertexVideoLocation ?? env.googleVertexLocation;
    registerVideoProvider(
      new GoogleVertexVideoProvider({
        project: env.googleVertexProject,
        location: videoLocation,
      }),
    );
  }

  // OpenAI — image only
  if (env.openAIApiKey && isValidOpenAIImageBaseURL(env.openAIApiBase)) {
    registerImageProvider(
      new OpenAIImageProvider(env.openAIApiKey, env.openAIApiBase),
    );
  }

  // Volces — image only
  if (env.volcesApiKey) {
    registerImageProvider(
      new VolcesImageProvider(env.volcesApiKey, env.volcesBaseUrl),
    );
  }
}

function logCodexImagegenCapability(
  capability: CodexImagegenCapability,
  logger?: GenerationProviderLogger,
) {
  const context = {
    provider: "codex-imagegen",
    ready: capability.ready,
    reasons: capability.reasons,
    codexVersion: capability.codexVersion ?? null,
    codexHome: capability.codexHome ?? null,
  };
  const message = capability.ready
    ? "Codex Imagegen provider available."
    : "Codex Imagegen provider unavailable.";

  if (logger) {
    logger.info(context, message);
    return;
  }

  const logKey = JSON.stringify(context);
  if (logKey === lastCodexImagegenCapabilityLogKey) return;
  lastCodexImagegenCapabilityLogKey = logKey;
  console.info(`[generation] ${message}`, context);
}
