import { tool } from "langchain";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { generateImage } from "../../generation/image-generation.js";
import { validateImageGenerationParams } from "../../generation/model-schemas.js";
import {
  type AvailableModel,
  getAvailableImageModels,
  resolveImageProviderName,
} from "../../generation/providers/registry.js";
import type { CanvasLayoutInspectionState } from "./inspect-canvas.js";
import {
  type MediaCapabilityRequired,
  buildMediaCapabilityRequired,
  isUnavailableMediaGenerationError,
} from "./media-capability.js";
import {
  collectStringEnumValues,
  summarizeModelSchemaForTool,
} from "./model-schema-summary.js";

const DEFAULT_MODEL = "codex/gpt-image-2";

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.displayName} — ${m.description}. Limits: ${summarizeModelSchemaForTool(m)}`).join("\n")}`
    : "Model identifier (no providers currently registered)";
  const aspectRatioValues = collectStringEnumValues(models, "aspectRatio");
  const defaultAspectRatio = aspectRatioValues.includes("1:1")
    ? "1:1"
    : (aspectRatioValues[0] ?? "1:1");

  const modelField = z
    .string()
    .default(defaultModel)
    .describe(modelDescription);

  return z.object({
    title: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
      ),
    prompt: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("Detailed image generation prompt"),
    model: modelField,
    aspectRatio:
      aspectRatioValues.length >= 1
        ? z
            .enum(aspectRatioValues as [string, ...string[]])
            .optional()
            .default(defaultAspectRatio)
            .describe(
              "Aspect ratio. Must be one of the values listed for the selected model in the model field description.",
            )
        : z
            .string()
            .optional()
            .default("1:1")
            .describe(
              "Aspect ratio. Must match the selected model's schema limits.",
            ),
    quality: z
      .enum(["standard", "hd", "ultra"])
      .optional()
      .default("hd")
      .describe(
        "Image quality/resolution level. standard: ~1K fast preview, hd: ~2K production quality (default), ultra: ~4K print quality (not all models support this, will use max available).",
      ),
    outputFormat: z
      .enum(["png", "jpg", "webp"])
      .optional()
      .describe(
        "Output image format. PNG for transparency, JPG for photos, WebP for web.",
      ),
    inputImages: z
      .array(z.string())
      .optional()
      .describe(
        "Reference images for editing/transformation. When reusing a generated image, pass its inputImageRef unchanged. Accepted values are /local-assets/{assetId}, http(s) URLs, or data URIs. Never pass elementId, fileId, or a bare assetId. Only use models whose schema supports inputImages; respect each selected model's limits.",
      ),
    size: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional()
      .describe(
        "Optional provider-specific pixel size override such as 1536x1024. Most useful for Agnes image generation.",
      ),
    seed: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional deterministic seed for providers that support reproducible generations.",
      ),
    placementX: z
      .number()
      .optional()
      .describe(
        "Optional left edge x coordinate on canvas. Leave unset for automatic non-overlapping placement. Only set when exact placement is required.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Optional top edge y coordinate on canvas. Leave unset for automatic non-overlapping placement. Only set when exact placement is required.",
      ),
    placementWidth: z
      .number()
      .optional()
      .default(512)
      .describe("Display width on canvas"),
    placementHeight: z
      .number()
      .optional()
      .default(512)
      .describe("Display height on canvas"),
  });
}

type ImageGenerateInput = {
  title?: string | null;
  prompt?: string | null;
  model: string;
  aspectRatio?: string;
  quality?: "standard" | "hd" | "ultra";
  outputFormat?: "png" | "jpg" | "webp";
  inputImages?: string[];
  size?: string;
  seed?: number;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
};

type NormalizedImageGenerateInput = Omit<
  ImageGenerateInput,
  "prompt" | "title"
> & {
  prompt: string;
  title: string;
};

type ImageGenerateResult = {
  summary: string;
  title?: string;
  elementId?: string;
  assetId?: string;
  /** Stable value to pass unchanged to a later generation tool's inputImages. */
  inputImageRef?: string;
  imageUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  errorCode?: string;
  capabilityRequired?: MediaCapabilityRequired;
  jobId?: string;
  jobType?: "image_generation";
  placement?: { x: number; y: number; width: number; height: number };
  status?: "generating";
};

type ToolInvokeConfig = {
  configurable?: {
    user_attachment_map?: Record<string, string>;
  };
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

export type ResolveImageInputFn = (
  input: string,
) => Promise<string | undefined>;

/**
 * Submit an image generation job and wait for the final image result.
 * The canvas may still receive a generation node before the job completes.
 */
export type SubmitImageJobFn = (input: {
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  size?: string;
  seed?: number;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
}) => Promise<{
  jobId: string;
  elementId?: string;
  assetId?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
  status?: "generating";
}>;

export async function runImageGenerate(
  input: ImageGenerateInput,
  persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
  resolveInputImage?: ResolveImageInputFn,
): Promise<ImageGenerateResult> {
  const promptText =
    typeof input.prompt === "string" && input.prompt.trim().length > 0
      ? input.prompt.trim()
      : typeof input.title === "string" && input.title.trim().length > 0
        ? input.title.trim()
        : "";
  if (!promptText) {
    const message =
      "missing_prompt: prompt is required. Retry with a detailed prompt describing the desired image.";
    return {
      summary: `Image generation skipped: ${message}`,
      error: message,
    };
  }

  const titleText =
    typeof input.title === "string" && input.title.trim().length > 0
      ? input.title.trim()
      : promptText.slice(0, 60);
  let effectiveInput: NormalizedImageGenerateInput = {
    ...input,
    prompt: promptText,
    title: titleText,
  };
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_image] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // Resolve assetId references in inputImages to base64 data URIs
  if (effectiveInput.inputImages?.length && attachmentMap) {
    effectiveInput = {
      ...effectiveInput,
      inputImages: effectiveInput.inputImages.map(
        (ref) => attachmentMap[ref] ?? ref,
      ),
    };
  }

  if (effectiveInput.inputImages?.length && resolveInputImage) {
    try {
      const resolvedImages = await Promise.all(
        effectiveInput.inputImages.map((image) => resolveInputImage(image)),
      );
      effectiveInput = {
        ...effectiveInput,
        inputImages: resolvedImages.filter(
          (image): image is string => typeof image === "string",
        ),
      };
    } catch {
      return {
        summary:
          "Image generation failed: One or more requested image inputs could not be resolved.",
        error: "One or more requested image inputs could not be resolved.",
      };
    }
  }

  // Filter out invalid image references — only keep valid URLs.
  // Agent may pass canvas element IDs or unresolved assetIds that aren't
  // in the attachmentMap. These would cause Replicate 422 errors.
  if (effectiveInput.inputImages?.length) {
    const validImages = effectiveInput.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    if (validImages.length !== effectiveInput.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: effectiveInput.inputImages.length,
        after: validImages.length,
        dropped: effectiveInput.inputImages.filter(
          (img) =>
            !img.startsWith("http://") &&
            !img.startsWith("https://") &&
            !img.startsWith("data:"),
        ),
      });
    }
    effectiveInput =
      validImages.length > 0
        ? { ...effectiveInput, inputImages: validImages }
        : { ...effectiveInput, inputImages: [] };
  }

  // Job mode: submit to PGMQ. The runtime may return immediately with a
  // canvas generation node while the frontend polls for completion.
  if (submitImageJob) {
    try {
      lap("job_submit", { model: effectiveInput.model });
      validateImageGenerationParams({
        prompt: effectiveInput.prompt,
        model: effectiveInput.model,
        ...(effectiveInput.aspectRatio
          ? { aspectRatio: effectiveInput.aspectRatio }
          : {}),
        ...(effectiveInput.inputImages?.length
          ? { inputImages: effectiveInput.inputImages }
          : {}),
        ...(effectiveInput.quality ? { quality: effectiveInput.quality } : {}),
        ...(effectiveInput.size ? { size: effectiveInput.size } : {}),
        ...(effectiveInput.seed !== undefined
          ? { seed: effectiveInput.seed }
          : {}),
      });
      const jobResult = await submitImageJob({
        prompt: effectiveInput.prompt,
        title: effectiveInput.title,
        model: effectiveInput.model,
        aspectRatio: effectiveInput.aspectRatio ?? "1:1",
        ...(effectiveInput.inputImages
          ? { inputImages: effectiveInput.inputImages }
          : {}),
        ...(effectiveInput.quality ? { quality: effectiveInput.quality } : {}),
        ...(effectiveInput.size ? { size: effectiveInput.size } : {}),
        ...(effectiveInput.seed !== undefined
          ? { seed: effectiveInput.seed }
          : {}),
        ...(effectiveInput.placementX !== undefined
          ? { placementX: effectiveInput.placementX }
          : {}),
        ...(effectiveInput.placementY !== undefined
          ? { placementY: effectiveInput.placementY }
          : {}),
        ...(effectiveInput.placementWidth !== undefined
          ? { placementWidth: effectiveInput.placementWidth }
          : {}),
        ...(effectiveInput.placementHeight !== undefined
          ? { placementHeight: effectiveInput.placementHeight }
          : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        return {
          summary: `Image generation failed with model ${effectiveInput.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          jobId: jobResult.jobId,
          ...(jobResult.elementId != null
            ? { elementId: jobResult.elementId }
            : {}),
          jobType: "image_generation" as const,
        };
      }
      if (jobResult.status === "generating") {
        lap("job_generating", { jobId: jobResult.jobId });
        return {
          summary:
            "Image generation has started. It will automatically appear on the canvas once ready.",
          title: effectiveInput.title,
          jobId: jobResult.jobId,
          ...(jobResult.elementId != null
            ? { elementId: jobResult.elementId }
            : {}),
          jobType: "image_generation" as const,
          status: "generating",
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: ImageGenerateResult = {
        summary: `Generated image (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${effectiveInput.model}`,
        title: effectiveInput.title,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        ...(jobResult.assetId != null ? { assetId: jobResult.assetId } : {}),
        ...(jobResult.assetId != null
          ? { inputImageRef: `/local-assets/${jobResult.assetId}` }
          : {}),
        imageUrl: jobResult.imageUrl ?? "",
        mimeType: jobResult.mimeType ?? "image/png",
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
      };
      if (
        effectiveInput.placementX != null &&
        effectiveInput.placementY != null
      ) {
        result.placement = {
          x: effectiveInput.placementX,
          y: effectiveInput.placementY,
          width: effectiveInput.placementWidth ?? 512,
          height: effectiveInput.placementHeight ?? 512,
        };
      }
      return result;
    } catch (error) {
      if (isUnavailableMediaGenerationError(error)) {
        const capabilityRequired =
          buildMediaCapabilityRequired("image_generation");
        return {
          summary: "media_provider_configuration_required",
          error: "media_provider_configuration_required",
          errorCode: "media_provider_configuration_required",
          capabilityRequired,
        };
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Image generation failed with model ${effectiveInput.model}: ${message}. Consider trying a different model or simplifying the prompt.`,
        error: message,
      };
    }
  }

  // Direct generation: resolve provider from model ID via registry
  try {
    lap("direct_generate_start", { model: effectiveInput.model });
    const providerName = resolveImageProviderName(effectiveInput.model);
    validateImageGenerationParams({
      prompt: effectiveInput.prompt,
      model: effectiveInput.model,
      ...(effectiveInput.aspectRatio
        ? { aspectRatio: effectiveInput.aspectRatio }
        : {}),
      ...(effectiveInput.inputImages?.length
        ? { inputImages: effectiveInput.inputImages }
        : {}),
      ...(effectiveInput.quality ? { quality: effectiveInput.quality } : {}),
      ...(effectiveInput.outputFormat
        ? { outputFormat: effectiveInput.outputFormat }
        : {}),
      ...(effectiveInput.size ? { size: effectiveInput.size } : {}),
      ...(effectiveInput.seed !== undefined
        ? { seed: effectiveInput.seed }
        : {}),
    });
    const result = await generateImage(providerName, {
      prompt: effectiveInput.prompt,
      model: effectiveInput.model,
      ...(effectiveInput.aspectRatio
        ? { aspectRatio: effectiveInput.aspectRatio }
        : {}),
      ...(effectiveInput.quality ? { quality: effectiveInput.quality } : {}),
      ...(effectiveInput.outputFormat
        ? { outputFormat: effectiveInput.outputFormat }
        : {}),
      ...(effectiveInput.inputImages?.length
        ? { inputImages: effectiveInput.inputImages }
        : {}),
      ...(effectiveInput.size ? { size: effectiveInput.size } : {}),
      ...(effectiveInput.seed !== undefined
        ? { seed: effectiveInput.seed }
        : {}),
    });
    lap("direct_generate_done", { width: result.width, height: result.height });

    let imageUrl = result.url;
    if (persistImage) {
      try {
        imageUrl = await persistImage(
          result.url,
          result.mimeType,
          effectiveInput.prompt,
        );
        lap("persist_image_done");
      } catch {
        // Fall back to ephemeral URL if upload fails
      }
    }

    const directResult: ImageGenerateResult = {
      summary: `Generated image (${result.width}x${result.height}) via ${effectiveInput.model}`,
      title: effectiveInput.title,
      imageUrl,
      inputImageRef: imageUrl,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
    };
    if (
      effectiveInput.placementX != null &&
      effectiveInput.placementY != null
    ) {
      directResult.placement = {
        x: effectiveInput.placementX,
        y: effectiveInput.placementY,
        width: effectiveInput.placementWidth ?? 512,
        height: effectiveInput.placementHeight ?? 512,
      };
    }
    return directResult;
  } catch (error) {
    if (isUnavailableMediaGenerationError(error)) {
      const capabilityRequired =
        buildMediaCapabilityRequired("image_generation");
      return {
        summary: "media_provider_configuration_required",
        error: "media_provider_configuration_required",
        errorCode: "media_provider_configuration_required",
        capabilityRequired,
      };
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Image generation failed: ${message}`,
      error: message,
    };
  }
}

export function createImageGenerateTool(deps?: {
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  resolveInputImage?: ResolveImageInputFn;
  layoutInspectionState?: CanvasLayoutInspectionState;
  /** Override for testing — defaults to querying the provider registry. */
  availableModels?: AvailableModel[];
  codexImagegenConfirmationRequired?: boolean;
}) {
  const models = deps?.availableModels ?? getAvailableImageModels();

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  const confirmationNotice = deps?.codexImagegenConfirmationRequired
    ? " Before calling this tool with model codex/gpt-image-2, non-Codex agents must call get_workspace_settings. If codexImagegen.confirmationRequired is true, ask the user whether to delegate image generation to Codex, then call update_workspace_settings with patch.codexImagegenDelegation=allow-once for one current-task call, patch.codexImagegenDelegation=always for a durable allow, or patch.codexImagegenDelegation=deny before retrying or stopping. Do not call generate_image with codex/gpt-image-2 until that consent state has been written."
    : "";

  return tool(
    async (input: ImageGenerateInput, config) => {
      const attachmentMap = (config as ToolInvokeConfig | undefined)
        ?.configurable?.user_attachment_map;
      const result = await runImageGenerate(
        input,
        deps?.persistImage,
        deps?.submitImageJob,
        attachmentMap,
        deps?.resolveInputImage,
      );
      if (!result.error && deps?.layoutInspectionState) {
        deps.layoutInspectionState.canvasId = undefined;
        deps.layoutInspectionState.inspectedAt = undefined;
      }
      return result;
    },
    {
      name: "generate_image",
      description: `Generate an image using AI. Available models: ${modelSummary}. Returns the generated image URL. When creating multiple exploration images, leave placementX and placementY unset unless exact positioning is necessary so the canvas can auto-place results without overlap.${confirmationNotice}`,
      schema: buildImageGenerateSchema(models),
    },
  );
}
