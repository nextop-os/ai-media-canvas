import type { BackgroundJob, ImageGenerationPayload } from "@aimc/shared";

import type { ServerEnv } from "../../../config/env.js";
import { evaluateCodexImagegenDelegation } from "../../../generation/codex-imagegen-delegation.js";
import { FALLBACK_IMAGE_MODEL } from "../../../generation/default-models.js";
import { loadGeneratedAsset } from "../../../generation/generated-asset.js";
import { generateImage } from "../../../generation/image-generation.js";
import { validateImageGenerationParams } from "../../../generation/model-schemas.js";
import { resolveImageProviderName } from "../../../generation/providers/registry.js";
import { GenerationError } from "../../../generation/utils.js";
import type { LocalStore } from "../../../local/store.js";
import { createLocalUserClient } from "../../../local/user-client.js";
import { completeImageGenerationNode } from "../../canvas/canvas-element-writer.js";
import { refreshGenerationProviders } from "../../settings/settings-service.js";

export async function executeImageGenerationJob(
  store: LocalStore,
  job: BackgroundJob,
  env?: ServerEnv,
) {
  const t0 = Date.now();
  let lastLapAt = t0;
  const lap = (label: string, extra?: Record<string, unknown>) => {
    const now = Date.now();
    console.info(
      `[image-generation-job] ${label} +${now - t0}ms step=${now - lastLapAt}ms`,
      JSON.stringify({
        jobId: job.id,
        status: job.status,
        attempt: job.attempt_count,
        ...queueTiming(job),
        ...(extra ?? {}),
      }),
    );
    lastLapAt = now;
  };

  if (env) {
    refreshGenerationProviders(env);
  }
  const payload = job.payload as ImageGenerationPayload;
  const model = payload.model ?? FALLBACK_IMAGE_MODEL;
  lap("start", {
    model,
    promptLength: payload.prompt.length,
    aspectRatio: payload.aspect_ratio ?? null,
    quality: payload.quality ?? null,
    inputImageCount: payload.input_images?.length ?? 0,
  });
  validateImageGenerationParams({
    prompt: payload.prompt,
    model,
    ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
    ...(payload.quality ? { quality: payload.quality } : {}),
    ...(payload.input_images ? { inputImages: payload.input_images } : {}),
    ...(payload.size ? { size: payload.size } : {}),
    ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
  });
  lap("validated", { model });
  const provider = resolveImageProviderName(model);
  lap("provider_resolved", { provider, model });
  const delegationDecision = evaluateCodexImagegenDelegation({
    imageProvider: provider,
    setting: "ask",
    consentBudget: payload.codex_imagegen_delegation_allowed ? 1 : 0,
    ...(payload.caller_provider
      ? { callerProvider: payload.caller_provider }
      : {}),
  });
  if (delegationDecision.status === "blocked") {
    throw new GenerationError(
      provider,
      delegationDecision.reason === "needs_confirmation"
        ? "codex_imagegen_confirmation_required"
        : "codex_imagegen_disabled_by_user",
      delegationDecision.reason === "needs_confirmation"
        ? "Codex image generation requires user confirmation before a non-Codex agent can use it."
        : "Codex image generation is disabled for non-Codex agents in workspace settings.",
    );
  }
  lap("provider_generate_start", { provider, model });
  const generated = await generateImage(provider, {
    prompt: payload.prompt,
    model,
    ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
    ...(payload.quality ? { quality: payload.quality } : {}),
    ...(payload.input_images ? { inputImages: payload.input_images } : {}),
    ...(payload.size ? { size: payload.size } : {}),
    ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
    metadata: {
      jobId: job.id,
      jobType: job.job_type,
      provider,
      attempt: job.attempt_count,
    },
  });
  lap("provider_generate_done", {
    provider,
    width: generated.width,
    height: generated.height,
    mimeType: generated.mimeType,
    urlKind: generated.url.startsWith("data:")
      ? "data"
      : /^https?:\/\//i.test(generated.url)
        ? "http"
        : "other",
  });

  lap("asset_load_start", { provider });
  const { buffer, mimeType } = await loadGeneratedAsset(
    generated.url,
    generated.mimeType || "image/png",
  );
  lap("asset_load_done", {
    provider,
    byteSize: buffer.length,
    mimeType,
  });
  const projectId =
    job.project_id ??
    (job.canvas_id ? store.getCanvas(job.canvas_id)?.projectId : null);
  const stored = store.uploadFile({
    bucket: "project-assets",
    fileName: `${provider}-${Date.now()}`,
    displayName: payload.title ?? payload.prompt,
    fileBuffer: buffer,
    mimeType,
    scope: "generated",
    ...(projectId ? { projectId } : {}),
  });
  lap("asset_uploaded", {
    assetId: stored.asset.id,
    objectPath: stored.asset.objectPath,
    mimeType: stored.asset.mimeType ?? mimeType,
  });
  if (job.canvas_id) {
    try {
      lap("canvas_insert_start", { canvasId: job.canvas_id });
      await completeImageGenerationNode(createLocalUserClient(store), {
        canvasId: job.canvas_id,
        jobId: job.id,
        assetId: stored.asset.id,
        signedUrl: stored.url,
        objectPath: stored.asset.objectPath,
        mimeType: stored.asset.mimeType ?? mimeType,
        width: generated.width,
        height: generated.height,
        title: payload.prompt.slice(0, 60),
      });
      lap("canvas_insert_done", { canvasId: job.canvas_id });
    } catch (error) {
      lap("canvas_insert_failed", {
        canvasId: job.canvas_id,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn("[image-generation] canvas image insert failed:", error);
    }
  }
  lap("done", { provider });
  return {
    asset_id: stored.asset.id,
    signed_url: stored.url,
    object_path: stored.asset.objectPath,
    file_path: stored.filePath,
    width: generated.width,
    height: generated.height,
    mime_type: stored.asset.mimeType ?? mimeType,
  };
}

function queueTiming(job: BackgroundJob) {
  const createdAt = Date.parse(job.created_at);
  const startedAt = job.started_at ? Date.parse(job.started_at) : Number.NaN;
  return {
    queueMs:
      Number.isFinite(createdAt) && Number.isFinite(startedAt)
        ? Math.max(0, startedAt - createdAt)
        : null,
    ageMs: Number.isFinite(createdAt)
      ? Math.max(0, Date.now() - createdAt)
      : null,
  };
}

export function isRetryableImageGenerationError(error: unknown) {
  return error instanceof GenerationError
    ? ![
        "provider_not_found",
        "model_not_found",
        "invalid_input",
        "input_fetch_error",
        "safety_filter",
      ].includes(error.code)
    : true;
}
