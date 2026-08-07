import type {
  AimcInputMode,
  AimcUiField,
  GenerationModelSchema,
  JsonSchemaObject,
} from "@aimc/shared";

import type { ModelInfo, VideoModelInfo } from "./types.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;
const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const IMAGE_QUALITIES = ["standard", "hd", "ultra"] as const;
const OUTPUT_FORMATS = ["png", "jpg", "webp"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k", "2160p"] as const;
const AGNES_VIDEO_ALLOWED_DURATIONS = [4, 5, 6, 8, 10, 15, 16] as const;
const AGNES_REFERENCE_VIDEO_LIMITS = {
  allowedDurations: AGNES_VIDEO_ALLOWED_DURATIONS,
  maxDuration: 16,
  resolutions: ["480p", "720p", "1080p"],
} as const;

type ImageSchemaOptions = {
  maxInputImages: number;
  aspectRatios?: readonly string[];
  qualities?: readonly string[];
  outputFormats?: readonly string[];
  seed?: boolean;
  size?: boolean;
};

type VideoSchemaOptions = {
  description?: string;
  allowedDurations?: readonly number[];
  maxDuration: number;
  resolutions: readonly string[];
  aspectRatios?: readonly string[];
  maxInputImages: number;
  inputModes: AimcInputMode[];
  audio?: boolean;
  seed?: boolean;
  negativePrompt?: boolean;
  inputVideo?: boolean;
  frameControls?: boolean;
  allOf?: JsonSchemaObject[];
};

export function getImageGenerationModelSchema(
  model: ModelInfo,
): GenerationModelSchema {
  const explicit = getExplicitImageSchema(model.id);
  if (explicit) return explicit;

  return imageSchema({
    maxInputImages: inferImageMaxInputImages(model),
    seed: model.id.startsWith("agnes-image/"),
    size: model.id.startsWith("agnes-image/"),
  });
}

export function getVideoGenerationModelSchema(
  model: VideoModelInfo,
): GenerationModelSchema {
  const explicit = getExplicitVideoSchema(model.id);
  if (explicit) return explicit;

  const resolutions = resolutionsFromMax(model.limits.maxResolution);
  const inputModes: AimcInputMode[] = [
    { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
  ];
  if (model.capabilities.imageToVideo && model.limits.maxInputImages > 0) {
    inputModes.push({
      id: model.limits.maxInputImages > 1 ? "multivideo" : "image",
      labelKey:
        model.limits.maxInputImages > 1
          ? "tools.schema.inputModes.multivideo"
          : "tools.schema.inputModes.image",
      minImages: 1,
      maxImages: model.limits.maxInputImages,
      ...(model.limits.maxInputImages > 1 ? { videoMode: "multivideo" } : {}),
      slots: ["inputImages"],
    });
  }
  if (model.capabilities.videoToVideo) {
    inputModes.push({
      id: "video",
      labelKey: "tools.schema.inputModes.video",
      requiresInputVideo: true,
    });
  }

  return videoSchema({
    maxDuration: model.limits.maxDuration,
    ...(model.limits.allowedDurations
      ? { allowedDurations: model.limits.allowedDurations }
      : {}),
    resolutions,
    maxInputImages: model.limits.maxInputImages,
    inputModes,
    audio: model.capabilities.audio,
    inputVideo: model.capabilities.videoToVideo,
  });
}

function getExplicitImageSchema(modelId: string) {
  if (modelId === "kie/z-image") {
    return imageSchema({ maxInputImages: 0 });
  }
  if (modelId === "kie/qwen2") {
    return imageSchema({
      maxInputImages: 1,
      outputFormats: ["png", "jpg"],
      seed: true,
    });
  }
  if (modelId === "kie/seedream-5-lite") {
    return imageSchema({
      maxInputImages: 8,
      outputFormats: ["png", "jpg"],
    });
  }
  if (modelId === "kie/gpt-image-2") {
    return imageSchema({
      maxInputImages: 8,
      outputFormats: ["png", "jpg"],
    });
  }
  if (modelId === "kie/nano-banana") {
    return imageSchema({
      maxInputImages: 8,
      outputFormats: ["png", "jpg"],
    });
  }
  if (modelId === "kie/nano-banana-pro") {
    return imageSchema({
      maxInputImages: 14,
      outputFormats: ["png", "jpg"],
    });
  }
  if (modelId === "codex/gpt-image-2") {
    return imageSchema({
      maxInputImages: 16,
      outputFormats: ["png"],
      seed: false,
      size: false,
    });
  }
  return undefined;
}

function getExplicitVideoSchema(modelId: string) {
  if (modelId === "agnes-video/agnes-video-v2.0") {
    return videoSchema({
      description:
        "Agnes 1080p combinations: text-to-video supports at most 241 frames (10s at 24fps); image-conditioned modes support at most 169 frames (6s at 24fps). Longer requests are generated at 720p.",
      allowedDurations: AGNES_VIDEO_ALLOWED_DURATIONS,
      maxDuration: 16,
      resolutions: ["480p", "720p", "1080p"],
      maxInputImages: 8,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "image",
          labelKey: "tools.schema.inputModes.image",
          minImages: 1,
          maxImages: 1,
          limits: AGNES_REFERENCE_VIDEO_LIMITS,
          slots: ["firstFrame"],
        },
        {
          id: "multivideo",
          labelKey: "tools.schema.inputModes.multivideo",
          videoMode: "multivideo",
          minImages: 2,
          maxImages: 8,
          limits: AGNES_REFERENCE_VIDEO_LIMITS,
          slots: ["inputImages"],
        },
        {
          id: "keyframes",
          labelKey: "tools.schema.inputModes.keyframes",
          videoMode: "keyframes",
          minImages: 2,
          maxImages: 8,
          limits: AGNES_REFERENCE_VIDEO_LIMITS,
          slots: ["firstFrame", "lastFrame"],
        },
      ],
      seed: true,
      negativePrompt: true,
      frameControls: true,
    });
  }
  if (modelId === "kie/runway") {
    return videoSchema({
      allowedDurations: [5, 10],
      maxDuration: 10,
      resolutions: ["720p", "1080p"],
      maxInputImages: 1,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "image",
          labelKey: "tools.schema.inputModes.image",
          minImages: 1,
          maxImages: 1,
          slots: ["firstFrame"],
        },
      ],
      allOf: [
        {
          not: {
            properties: {
              duration: { const: 10 },
              resolution: { const: "1080p" },
            },
            required: ["duration", "resolution"],
          },
        },
      ],
    });
  }
  if (modelId === "kie/grok-imagine") {
    return videoSchema({
      allowedDurations: [6],
      maxDuration: 6,
      resolutions: ["480p"],
      maxInputImages: 1,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "image",
          labelKey: "tools.schema.inputModes.image",
          minImages: 1,
          maxImages: 1,
          slots: ["firstFrame"],
        },
      ],
    });
  }
  if (modelId === "kie/hailuo") {
    return videoSchema({
      maxDuration: 6,
      resolutions: ["720p", "1080p"],
      maxInputImages: 2,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "keyframes",
          labelKey: "tools.schema.inputModes.keyframes",
          videoMode: "keyframes",
          minImages: 1,
          maxImages: 2,
          slots: ["firstFrame", "lastFrame"],
        },
      ],
    });
  }
  if (modelId === "kie/veo-3.1") {
    return videoSchema({
      maxDuration: 8,
      resolutions: ["720p", "1080p"],
      maxInputImages: 2,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "keyframes",
          labelKey: "tools.schema.inputModes.keyframes",
          videoMode: "keyframes",
          minImages: 1,
          maxImages: 2,
          slots: ["firstFrame", "lastFrame"],
        },
        {
          id: "reference",
          labelKey: "tools.schema.inputModes.reference",
          videoMode: "reference",
          minImages: 1,
          maxImages: 1,
          slots: ["referenceImages"],
        },
      ],
      audio: true,
    });
  }
  if (modelId === "kie/kling-2.6") {
    return videoSchema({
      allowedDurations: [5, 10],
      maxDuration: 10,
      resolutions: ["720p", "1080p"],
      maxInputImages: 1,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "image",
          labelKey: "tools.schema.inputModes.image",
          minImages: 1,
          maxImages: 1,
          slots: ["firstFrame"],
        },
      ],
      audio: true,
    });
  }
  if (modelId === "kie/seedance-2") {
    return videoSchema({
      allowedDurations: [5, 10, 15],
      maxDuration: 15,
      resolutions: ["720p", "1080p"],
      maxInputImages: 8,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "keyframes",
          labelKey: "tools.schema.inputModes.keyframes",
          videoMode: "keyframes",
          minImages: 1,
          maxImages: 2,
          slots: ["firstFrame", "lastFrame"],
        },
        {
          id: "reference",
          labelKey: "tools.schema.inputModes.reference",
          videoMode: "reference",
          minImages: 1,
          maxImages: 8,
          slots: ["referenceImages"],
        },
      ],
      audio: true,
      seed: true,
    });
  }
  if (modelId === "kie/happyhorse-1") {
    return videoSchema({
      allowedDurations: [5],
      maxDuration: 5,
      resolutions: ["720p", "1080p"],
      maxInputImages: 4,
      inputModes: [
        { id: "text", labelKey: "tools.schema.inputModes.text", maxImages: 0 },
        {
          id: "image",
          labelKey: "tools.schema.inputModes.image",
          minImages: 1,
          maxImages: 1,
          slots: ["firstFrame"],
        },
        {
          id: "reference",
          labelKey: "tools.schema.inputModes.reference",
          videoMode: "reference",
          minImages: 1,
          maxImages: 4,
          slots: ["referenceImages"],
        },
      ],
      seed: true,
    });
  }
  return undefined;
}

function imageSchema(options: ImageSchemaOptions): GenerationModelSchema {
  const properties: Record<string, JsonSchemaObject> = {
    prompt: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    aspectRatio: enumSchema(options.aspectRatios ?? IMAGE_ASPECT_RATIOS),
    quality: enumSchema(options.qualities ?? IMAGE_QUALITIES),
    outputFormat: enumSchema(options.outputFormats ?? OUTPUT_FORMATS),
    inputImages: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 0,
      maxItems: options.maxInputImages,
    },
  };
  if (options.seed) {
    properties.seed = { type: "integer" };
  } else {
    properties.seed = forbiddenTrueSchema();
  }
  if (options.size) {
    properties.size = { type: "string", pattern: "^\\d+x\\d+$" };
  }
  const fields: AimcUiField[] = [
    {
      path: "inputImages",
      control: "imageUpload",
      labelKey: "tools.schema.fields.referenceImages",
      order: 10,
      uploadSlot: "inputImages",
    },
    {
      path: "aspectRatio",
      control: "segmented",
      labelKey: "tools.schema.fields.aspectRatio",
      order: 20,
    },
    {
      path: "quality",
      control: "segmented",
      labelKey: "tools.schema.fields.quality",
      order: 30,
    },
  ];
  return {
    $schema: DRAFT_2020_12,
    type: "object",
    properties,
    required: ["prompt", "model"],
    additionalProperties: true,
    "x-aimc-ui": { mediaType: "image", fields },
  };
}

function videoSchema(options: VideoSchemaOptions): GenerationModelSchema {
  const properties: Record<string, JsonSchemaObject> = {
    prompt: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    duration: options.allowedDurations?.length
      ? enumSchema(options.allowedDurations)
      : { type: "integer", minimum: 1, maximum: options.maxDuration },
    resolution: enumSchema(options.resolutions),
    aspectRatio: enumSchema(options.aspectRatios ?? VIDEO_ASPECT_RATIOS),
    inputImages: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 0,
      maxItems: options.maxInputImages,
    },
    videoMode: enumSchema(["multivideo", "keyframes", "reference"]),
  };
  if (options.inputVideo)
    properties.inputVideo = { type: "string", minLength: 1 };
  if (options.seed) properties.seed = { type: "integer" };
  if (options.negativePrompt)
    properties.negativePrompt = { type: "string", minLength: 1 };
  if (options.frameControls) {
    properties.frameRate = { type: "integer", minimum: 1, maximum: 60 };
    properties.numFrames = { type: "integer", minimum: 1, maximum: 441 };
  }
  properties.enableAudio = options.audio
    ? { type: "boolean" }
    : { type: "boolean", const: false };

  const fields: AimcUiField[] = [
    {
      path: "inputImages",
      control: "imageUpload",
      labelKey: "tools.schema.fields.inputImages",
      order: 10,
    },
    {
      path: "aspectRatio",
      control: "segmented",
      labelKey: "tools.schema.fields.aspectRatio",
      order: 20,
    },
    {
      path: "duration",
      control: "segmented",
      labelKey: "tools.schema.fields.duration",
      order: 30,
    },
    {
      path: "resolution",
      control: "segmented",
      labelKey: "tools.schema.fields.resolution",
      order: 40,
    },
  ];
  if (options.audio) {
    fields.push({
      path: "enableAudio",
      control: "toggle",
      labelKey: "tools.schema.fields.enableAudio",
      order: 50,
    });
  }

  return {
    $schema: DRAFT_2020_12,
    ...(options.description ? { description: options.description } : {}),
    type: "object",
    properties,
    required: ["prompt", "model"],
    additionalProperties: true,
    ...(options.allOf?.length ? { allOf: options.allOf } : {}),
    "x-aimc-ui": {
      mediaType: "video",
      fields,
      inputModes: options.inputModes,
    },
  };
}

function enumSchema(
  values: readonly (string | number | boolean)[],
): JsonSchemaObject {
  return { enum: [...values] };
}

function forbiddenTrueSchema(): JsonSchemaObject {
  return { not: { const: true } };
}

function inferImageMaxInputImages(model: ModelInfo) {
  if (
    model.id.includes("imagen") ||
    model.id.includes("recraft") ||
    model.id.startsWith("openai:") ||
    model.id === "doubao-seedream-5-0-260128"
  ) {
    return 0;
  }
  if (model.id.includes("flux") || model.id === "gpt-image-1-mini") return 1;
  if (model.id.includes("gpt-image")) return 8;
  if (model.id.includes("nano-banana") || model.id.includes("gemini"))
    return 14;
  if (model.id.includes("seedream")) return 8;
  return 4;
}

function resolutionsFromMax(
  maxResolution: VideoModelInfo["limits"]["maxResolution"],
) {
  const max =
    maxResolution === "2160p"
      ? "4k"
      : maxResolution === "1080p" ||
          maxResolution === "720p" ||
          maxResolution === "480p"
        ? maxResolution
        : "1080p";
  const index = VIDEO_RESOLUTIONS.indexOf(max);
  return VIDEO_RESOLUTIONS.slice(0, Math.max(index, 0) + 1);
}
