import { tool } from "langchain";
import { z } from "zod";

import { validateVideoGenerationParams } from "../../generation/model-schemas.js";
import {
  type AvailableVideoModel,
  getAvailableVideoModels,
  resolveVideoProviderName,
} from "../../generation/providers/registry.js";
import { generateVideo } from "../../generation/video-generation.js";
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

const DEFAULT_MODEL = "google-official/veo-3.1-generate-preview";
const AGNES_VIDEO_MODEL_PREFIX = "agnes-video/";

function validateAgnesVideoInput(input: {
  model: string;
  aspectRatio?: string | undefined;
  frameRate?: number | undefined;
  numFrames?: number | undefined;
  resolution?: string | undefined;
}) {
  if (!input.model.startsWith(AGNES_VIDEO_MODEL_PREFIX)) {
    return;
  }

  if (
    input.aspectRatio &&
    input.aspectRatio !== "16:9" &&
    input.aspectRatio !== "9:16"
  ) {
    throw new Error(
      "Agnes video currently supports only 16:9 or 9:16 aspect ratios.",
    );
  }

  if (
    input.resolution &&
    input.resolution !== "480p" &&
    input.resolution !== "720p" &&
    input.resolution !== "1080p"
  ) {
    throw new Error(
      "Agnes video currently supports only 480p, 720p, or 1080p output.",
    );
  }

  if (
    input.frameRate !== undefined &&
    (!Number.isInteger(input.frameRate) ||
      input.frameRate < 1 ||
      input.frameRate > 60)
  ) {
    throw new Error(
      "Agnes video frameRate must be an integer between 1 and 60.",
    );
  }

  if (input.numFrames !== undefined) {
    if (!Number.isInteger(input.numFrames) || input.numFrames <= 0) {
      throw new Error("Agnes video numFrames must be a positive integer.");
    }
    if (input.numFrames > 441) {
      throw new Error("Agnes video numFrames cannot exceed 441.");
    }
    if ((input.numFrames - 1) % 8 !== 0) {
      throw new Error("Agnes video numFrames must follow the 8n + 1 rule.");
    }
  }
}

// ── Submit function type ───────────────────────────────────────────────────

export type SubmitVideoJobFn = (input: {
  title: string;
  prompt: string;
  model: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  videoMode?: "multivideo" | "keyframes" | "reference";
  seed?: number;
  negativePrompt?: string;
  frameRate?: number;
  numFrames?: number;
  enableAudio?: boolean;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
}) => Promise<{
  jobId: string;
  elementId?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  mimeType?: string;
  error?: string;
  status?: "generating";
}>;

export type ResolveVideoInputImageFn = (
  input: string,
) => Promise<string | undefined>;

// ── Dynamic schema builder ─────────────────────────────────────────────────

function buildVideoGenerateSchema(models: AvailableVideoModel[]) {
  const modelIds = models.map((m) => m.id);
  const maxInputImages = Math.max(
    1,
    ...models.map((model) => model.limits.maxInputImages),
  );
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Video model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.displayName} — ${m.description}. Limits: ${summarizeModelSchemaForTool(m)}`).join("\n")}`
    : "Model identifier (no video providers currently registered)";
  const aspectRatioValues = collectStringEnumValues(models, "aspectRatio");
  const resolutionValues = collectStringEnumValues(models, "resolution");

  const modelField = z
    .string()
    .default(defaultModel)
    .describe(modelDescription);

  return z.object({
    title: z
      .string()
      .min(1)
      .describe(
        "Short descriptive title for the generated video, used as metadata so the video content is understood without re-analysis (e.g. 'Autumn forest bus scene', 'Dinosaur chase shot')",
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Detailed video generation prompt. Be specific about motion, camera angles, lighting, mood, action, and scene transitions.",
      ),
    model: modelField,
    duration: z
      .number()
      .int()
      .min(3)
      .max(16)
      .optional()
      .describe(
        "Video duration in seconds. Valid range depends on model (see model descriptions). Google Veo supports 4/6/8, Replicate models support 3-16.",
      ),
    resolution:
      resolutionValues.length >= 1
        ? z
            .enum(resolutionValues as [string, ...string[]])
            .optional()
            .describe(
              "Output resolution. Must be one of the values listed for the selected model in the model field description.",
            )
        : z
            .enum(["480p", "720p", "1080p", "4k"])
            .optional()
            .describe(
              "Output resolution. Must match the selected model's schema limits.",
            ),
    aspectRatio:
      aspectRatioValues.length >= 1
        ? z
            .enum(aspectRatioValues as [string, ...string[]])
            .optional()
            .describe(
              "Video aspect ratio. Must be one of the values listed for the selected model in the model field description.",
            )
        : z
            .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
            .optional()
            .describe(
              "Video aspect ratio. Must match the selected model's schema limits.",
            ),
    inputImages: z
      .array(z.string())
      .max(maxInputImages)
      .optional()
      .describe(
        "Image inputs for image-to-video. For exactly one image, omit videoMode. A reference image does not imply videoMode=reference. AIMC canvas sessions also resolve /local-assets/:assetId inputs.",
      ),
    inputVideo: z
      .string()
      .optional()
      .describe(
        "Source video URL for video-to-video editing. Only for Kling O1.",
      ),
    videoMode: z
      .enum(["multivideo", "keyframes", "reference"])
      .optional()
      .describe(
        "Optional specialized multi-image mode. Omit for single-image image-to-video. multivideo and keyframes require at least 2 images; reference is only valid when the selected model explicitly lists reference input mode.",
      ),
    seed: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional deterministic seed for providers that support reproducible video generations.",
      ),
    negativePrompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional negative prompt for suppressing unwanted motion, objects, or styles.",
      ),
    frameRate: z
      .number()
      .int()
      .positive()
      .max(60)
      .optional()
      .describe(
        "Optional explicit frame rate for Agnes phase-2 style controls.",
      ),
    numFrames: z
      .number()
      .int()
      .positive()
      .max(441)
      .optional()
      .describe(
        "Optional explicit frame count for Agnes phase-2 style controls. Agnes expects 8n + 1.",
      ),
    enableAudio: z
      .boolean()
      .optional()
      .describe(
        "Generate synchronized audio (dialogue, sound effects, ambient). Only pass true for models whose limits list audio support.",
      ),
    placementX: z
      .number()
      .optional()
      .describe(
        "Canvas X coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Canvas Y coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementWidth: z
      .number()
      .optional()
      .describe("Width on canvas (default: 640)"),
    placementHeight: z
      .number()
      .optional()
      .describe("Height on canvas (default: 360)"),
  });
}

// ── Result type ────────────────────────────────────────────────────────────

// Infer input type from schema — includes the new `title` field
type VideoGenerateInput = z.infer<ReturnType<typeof buildVideoGenerateSchema>>;

type VideoGenerateResult = {
  summary: string;
  title?: string;
  prompt?: string;
  elementId?: string;
  videoUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  placement?: { x: number; y: number; width: number; height: number };
  error?: string;
  errorCode?: string;
  capabilityRequired?: MediaCapabilityRequired;
  jobId?: string;
  jobType?: "video_generation";
  status?: "generating";
};

type ToolInvokeConfig = {
  configurable?: {
    user_attachment_map?: Record<string, string>;
  };
};

// ── Run function ───────────────────────────────────────────────────────────

export async function runVideoGenerate(
  input: VideoGenerateInput,
  submitVideoJob?: SubmitVideoJobFn,
  attachmentMap?: Record<string, string>,
  resolveInputImage?: ResolveVideoInputImageFn,
): Promise<VideoGenerateResult> {
  let effectiveInput = input;
  const requestedInputImageCount = input.inputImages?.length ?? 0;
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_video] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // Resolve assetId references in inputImages to URLs/data URIs provided by
  // the current user message attachments.
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
          "Video generation failed: One or more requested image inputs could not be resolved.",
        error: "One or more requested image inputs could not be resolved.",
      };
    }
  }

  // Reject unresolved references instead of silently changing the requested
  // input count or downgrading an image-to-video call to text-to-video.
  if (requestedInputImageCount > 0) {
    const resolvedImages = effectiveInput.inputImages ?? [];
    const validImages = resolvedImages.filter(
      (image) =>
        image.startsWith("http://") ||
        image.startsWith("https://") ||
        image.startsWith("data:"),
    );
    if (validImages.length !== requestedInputImageCount) {
      lap("filtered_invalid_refs", {
        before: requestedInputImageCount,
        after: validImages.length,
        dropped: resolvedImages.filter(
          (image) =>
            !image.startsWith("http://") &&
            !image.startsWith("https://") &&
            !image.startsWith("data:"),
        ),
      });
      return {
        summary:
          "Video generation failed: One or more requested image inputs could not be resolved.",
        error: "One or more requested image inputs could not be resolved.",
      };
    }
    effectiveInput = {
      ...effectiveInput,
      inputImages: validImages,
    };
  }

  if (
    effectiveInput.model.startsWith(AGNES_VIDEO_MODEL_PREFIX) &&
    effectiveInput.inputImages?.length === 1 &&
    effectiveInput.videoMode
  ) {
    lap("normalized_single_image_mode", {
      from: effectiveInput.videoMode,
      to: "image",
    });
    const { videoMode: _videoMode, ...singleImageInput } = effectiveInput;
    effectiveInput = singleImageInput;
  }

  validateAgnesVideoInput(effectiveInput);

  // Job mode: submit to PGMQ. The runtime may return immediately with a
  // canvas generation node while the frontend polls for completion.
  if (submitVideoJob) {
    try {
      lap("job_submit", { model: effectiveInput.model });
      validateVideoGenerationParams({
        prompt: effectiveInput.prompt,
        model: effectiveInput.model,
        ...(effectiveInput.duration != null
          ? { duration: effectiveInput.duration }
          : {}),
        ...(effectiveInput.resolution
          ? {
              resolution: effectiveInput.resolution as
                | "480p"
                | "720p"
                | "1080p"
                | "4k"
                | "2160p",
            }
          : {}),
        ...(effectiveInput.aspectRatio
          ? { aspectRatio: effectiveInput.aspectRatio }
          : {}),
        ...(effectiveInput.inputImages
          ? { inputImages: effectiveInput.inputImages }
          : {}),
        ...(effectiveInput.inputVideo
          ? { inputVideo: effectiveInput.inputVideo }
          : {}),
        ...(effectiveInput.videoMode
          ? { videoMode: effectiveInput.videoMode }
          : {}),
        ...(effectiveInput.seed !== undefined
          ? { seed: effectiveInput.seed }
          : {}),
        ...(effectiveInput.negativePrompt
          ? { negativePrompt: effectiveInput.negativePrompt }
          : {}),
        ...(effectiveInput.frameRate !== undefined
          ? { frameRate: effectiveInput.frameRate }
          : {}),
        ...(effectiveInput.numFrames !== undefined
          ? { numFrames: effectiveInput.numFrames }
          : {}),
        ...(effectiveInput.enableAudio != null
          ? { enableAudio: effectiveInput.enableAudio }
          : {}),
      });
      const jobResult = await submitVideoJob({
        title: effectiveInput.title,
        prompt: effectiveInput.prompt,
        model: effectiveInput.model,
        ...(effectiveInput.duration != null
          ? { duration: effectiveInput.duration }
          : {}),
        ...(effectiveInput.resolution
          ? { resolution: effectiveInput.resolution }
          : {}),
        ...(effectiveInput.aspectRatio
          ? { aspectRatio: effectiveInput.aspectRatio }
          : {}),
        ...(effectiveInput.inputImages
          ? { inputImages: effectiveInput.inputImages }
          : {}),
        ...(effectiveInput.inputVideo
          ? { inputVideo: effectiveInput.inputVideo }
          : {}),
        ...(effectiveInput.videoMode
          ? { videoMode: effectiveInput.videoMode }
          : {}),
        ...(effectiveInput.seed !== undefined
          ? { seed: effectiveInput.seed }
          : {}),
        ...(effectiveInput.negativePrompt
          ? { negativePrompt: effectiveInput.negativePrompt }
          : {}),
        ...(effectiveInput.frameRate !== undefined
          ? { frameRate: effectiveInput.frameRate }
          : {}),
        ...(effectiveInput.numFrames !== undefined
          ? { numFrames: effectiveInput.numFrames }
          : {}),
        ...(effectiveInput.enableAudio != null
          ? { enableAudio: effectiveInput.enableAudio }
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
          summary: `Video generation failed with model ${effectiveInput.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          jobId: jobResult.jobId,
          ...(jobResult.elementId != null
            ? { elementId: jobResult.elementId }
            : {}),
          jobType: "video_generation" as const,
        };
      }
      if (jobResult.status === "generating") {
        lap("job_generating", { jobId: jobResult.jobId });
        return {
          summary:
            "Video generation has started. It will automatically appear on the canvas once ready.",
          title: effectiveInput.title,
          prompt: effectiveInput.prompt,
          jobId: jobResult.jobId,
          ...(jobResult.elementId != null
            ? { elementId: jobResult.elementId }
            : {}),
          jobType: "video_generation" as const,
          status: "generating",
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: VideoGenerateResult = {
        summary: `Generated ${jobResult.durationSeconds ?? effectiveInput.duration}s video (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${effectiveInput.model}`,
        title: effectiveInput.title,
        prompt: effectiveInput.prompt,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        mimeType: jobResult.mimeType ?? "video/mp4",
        ...(jobResult.videoUrl != null ? { videoUrl: jobResult.videoUrl } : {}),
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
        ...(jobResult.durationSeconds != null
          ? { durationSeconds: jobResult.durationSeconds }
          : {}),
      };
      if (
        effectiveInput.placementX != null &&
        effectiveInput.placementY != null
      ) {
        result.placement = {
          x: effectiveInput.placementX,
          y: effectiveInput.placementY,
          width: effectiveInput.placementWidth ?? 640,
          height: effectiveInput.placementHeight ?? 360,
        };
      }
      return result;
    } catch (error) {
      if (isUnavailableMediaGenerationError(error)) {
        const capabilityRequired =
          buildMediaCapabilityRequired("video_generation");
        return {
          summary: "media_provider_configuration_required",
          error: "media_provider_configuration_required",
          errorCode: "media_provider_configuration_required",
          capabilityRequired,
        };
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Video generation failed with model ${effectiveInput.model}: ${message}`,
        error: message,
      };
    }
  }

  // Direct mode: call provider directly
  try {
    lap("direct_generate_start", { model: effectiveInput.model });
    const providerName = resolveVideoProviderName(effectiveInput.model);
    validateVideoGenerationParams({
      prompt: effectiveInput.prompt,
      model: effectiveInput.model,
      ...(effectiveInput.duration != null
        ? { duration: effectiveInput.duration }
        : {}),
      ...(effectiveInput.resolution
        ? {
            resolution: effectiveInput.resolution as
              | "480p"
              | "720p"
              | "1080p"
              | "4k"
              | "2160p",
          }
        : {}),
      ...(effectiveInput.aspectRatio
        ? { aspectRatio: effectiveInput.aspectRatio }
        : {}),
      ...(effectiveInput.inputImages
        ? { inputImages: effectiveInput.inputImages }
        : {}),
      ...(effectiveInput.inputVideo
        ? { inputVideo: effectiveInput.inputVideo }
        : {}),
      ...(effectiveInput.videoMode
        ? { videoMode: effectiveInput.videoMode }
        : {}),
      ...(effectiveInput.seed !== undefined
        ? { seed: effectiveInput.seed }
        : {}),
      ...(effectiveInput.negativePrompt
        ? { negativePrompt: effectiveInput.negativePrompt }
        : {}),
      ...(effectiveInput.frameRate !== undefined
        ? { frameRate: effectiveInput.frameRate }
        : {}),
      ...(effectiveInput.numFrames !== undefined
        ? { numFrames: effectiveInput.numFrames }
        : {}),
      ...(effectiveInput.enableAudio != null
        ? { enableAudio: effectiveInput.enableAudio }
        : {}),
    });
    const result = await generateVideo(providerName, {
      prompt: effectiveInput.prompt,
      model: effectiveInput.model,
      ...(effectiveInput.duration != null
        ? { duration: effectiveInput.duration }
        : {}),
      ...(effectiveInput.aspectRatio
        ? { aspectRatio: effectiveInput.aspectRatio }
        : {}),
      ...(effectiveInput.resolution
        ? {
            resolution: effectiveInput.resolution as
              | "480p"
              | "720p"
              | "1080p"
              | "4k"
              | "2160p",
          }
        : {}),
      ...(effectiveInput.inputImages
        ? { inputImages: effectiveInput.inputImages }
        : {}),
      ...(effectiveInput.inputVideo
        ? { inputVideo: effectiveInput.inputVideo }
        : {}),
      ...(effectiveInput.videoMode
        ? { videoMode: effectiveInput.videoMode }
        : {}),
      ...(effectiveInput.seed !== undefined
        ? { seed: effectiveInput.seed }
        : {}),
      ...(effectiveInput.negativePrompt
        ? { negativePrompt: effectiveInput.negativePrompt }
        : {}),
      ...(effectiveInput.frameRate !== undefined
        ? { frameRate: effectiveInput.frameRate }
        : {}),
      ...(effectiveInput.numFrames !== undefined
        ? { numFrames: effectiveInput.numFrames }
        : {}),
      ...(effectiveInput.enableAudio != null
        ? { enableAudio: effectiveInput.enableAudio }
        : {}),
    });
    lap("direct_generate_done");

    const directResult: VideoGenerateResult = {
      summary: `Generated ${result.durationSeconds}s video (${result.width}x${result.height}) via ${effectiveInput.model}`,
      title: effectiveInput.title,
      prompt: effectiveInput.prompt,
      videoUrl: result.url,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      durationSeconds: result.durationSeconds,
    };
    if (
      effectiveInput.placementX != null &&
      effectiveInput.placementY != null
    ) {
      directResult.placement = {
        x: effectiveInput.placementX,
        y: effectiveInput.placementY,
        width: effectiveInput.placementWidth ?? 640,
        height: effectiveInput.placementHeight ?? 360,
      };
    }
    return directResult;
  } catch (error) {
    if (isUnavailableMediaGenerationError(error)) {
      const capabilityRequired =
        buildMediaCapabilityRequired("video_generation");
      return {
        summary: "media_provider_configuration_required",
        error: "media_provider_configuration_required",
        errorCode: "media_provider_configuration_required",
        capabilityRequired,
      };
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Video generation failed: ${message}`,
      error: message,
    };
  }
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createVideoGenerateTool(deps?: {
  submitVideoJob?: SubmitVideoJobFn;
  resolveInputImage?: ResolveVideoInputImageFn;
  layoutInspectionState?: CanvasLayoutInspectionState;
  availableModels?: AvailableVideoModel[];
}) {
  const models = deps?.availableModels ?? getAvailableVideoModels();

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No video models available";

  return tool(
    async (input: VideoGenerateInput, config) => {
      const attachmentMap = (config as ToolInvokeConfig | undefined)
        ?.configurable?.user_attachment_map;
      const result = await runVideoGenerate(
        input,
        deps?.submitVideoJob,
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
      name: "generate_video",
      description: `Generate a video using AI. Available models: ${modelSummary}. Supports text-to-video, image-to-video, and video editing. Returns the generated video URL.`,
      schema: buildVideoGenerateSchema(models),
    },
  );
}
