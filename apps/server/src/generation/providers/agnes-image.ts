import { createAgnesClient } from "agnes-ai-cli";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import {
  GenerationError,
  aspectRatioToDimensions,
  withTimeout,
} from "../utils.js";
import {
  type AgnesMediaOptions,
  resolveAgnesMediaOptions,
} from "./agnes-media.js";

const ICON_AGNES = "https://agnes-cdn.kiwiar.com/logo/agnes-icon-400x400.jpg";
const DEFAULT_AGNES_MEDIA_TTL = "1h" as const;
const AGNES_IMAGE_CREATE_TIMEOUT_MS = 120_000;
const AGNES_IMAGE_MODEL_IDS = [
  "agnes-image-2.1-flash",
  "agnes-image-2.0-flash",
] as const;
type AgnesImageModelId = (typeof AGNES_IMAGE_MODEL_IDS)[number];

const AGNES_IMAGE_MODELS: readonly ModelInfo[] = [
  {
    id: "agnes-image/agnes-image-2.1-flash",
    displayName: "Agnes Image 2.1 Flash",
    description: "Agnes high-fidelity image generation and editing route.",
    iconUrl: ICON_AGNES,
  },
  {
    id: "agnes-image/agnes-image-2.0-flash",
    displayName: "Agnes Image 2.0 Flash",
    description: "Agnes image route with compose and edit support.",
    iconUrl: ICON_AGNES,
  },
];

function resolveAgnesImageModel(modelId: string): AgnesImageModelId {
  const normalized = modelId.includes("/")
    ? (modelId.split("/").pop() ?? modelId)
    : modelId;
  if (AGNES_IMAGE_MODEL_IDS.includes(normalized as AgnesImageModelId)) {
    return normalized as AgnesImageModelId;
  }
  throw new GenerationError(
    "agnes-image",
    "model_not_found",
    `Unsupported Agnes image model: ${modelId}`,
  );
}

function resolveImageDimensions(size: string, fallbackAspectRatio: string) {
  const match = size.match(/^(\d+)x(\d+)$/);
  const [, widthValue, heightValue] = match ?? [];
  if (widthValue && heightValue) {
    return {
      width: Number.parseInt(widthValue, 10),
      height: Number.parseInt(heightValue, 10),
    };
  }
  return aspectRatioToDimensions(fallbackAspectRatio);
}

function getSingleAgnesInputImage(inputImages: string[]) {
  const [image] = inputImages;
  if (image) return image;
  throw new GenerationError(
    "agnes-image",
    "invalid_input",
    "Agnes img2img requires exactly one image.",
  );
}

type AgnesRequestError = Error & {
  code?: unknown;
  details?: unknown;
};

function getAgnesRequestStatus(error: AgnesRequestError) {
  const match = error.message.match(/\bHTTP\s+(\d{3})\b/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

export class AgnesImageProvider implements ImageProvider {
  readonly name = "agnes-image";
  readonly models = AGNES_IMAGE_MODELS;
  private client: ReturnType<typeof createAgnesClient>;

  constructor(
    apiKey: string,
    baseUrl?: string,
    options: AgnesMediaOptions = {},
  ) {
    const mediaOptions = resolveAgnesMediaOptions(options);
    this.client = createAgnesClient({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...mediaOptions,
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const aspectRatio = params.aspectRatio ?? "1:1";
    const { width, height } = aspectRatioToDimensions(aspectRatio);
    const size = params.size ?? `${width}x${height}`;
    const outputDimensions = resolveImageDimensions(size, aspectRatio);
    const model = resolveAgnesImageModel(params.model);

    try {
      const inputImages = params.inputImages ?? [];
      const result = await withTimeout(
        inputImages.length === 0
          ? this.client.image.generate({
              mode: "text2img",
              model,
              prompt: params.prompt,
              size,
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
            })
          : inputImages.length === 1
            ? this.client.image.generate({
                mode: "img2img",
                model,
                image: getSingleAgnesInputImage(inputImages),
                prompt: params.prompt,
                size,
                ttl: DEFAULT_AGNES_MEDIA_TTL,
                ...(params.seed !== undefined ? { seed: params.seed } : {}),
              })
            : this.client.image.generate({
                mode: "compose",
                model,
                images: inputImages,
                prompt: params.prompt,
                size,
                ttl: DEFAULT_AGNES_MEDIA_TTL,
                ...(params.seed !== undefined ? { seed: params.seed } : {}),
              }),
        AGNES_IMAGE_CREATE_TIMEOUT_MS,
        () =>
          new GenerationError(
            this.name,
            "timeout",
            `Agnes image task creation timed out after ${AGNES_IMAGE_CREATE_TIMEOUT_MS}ms.`,
          ),
      );

      return {
        url: result.url,
        mimeType: "image/png",
        width: outputDimensions.width,
        height: outputDimensions.height,
      };
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      if (error instanceof Error && error.name === "AgnesCliError") {
        const agnesError = error as AgnesRequestError;
        const status = getAgnesRequestStatus(agnesError);
        console.warn("[agnes-image] Agnes request failed", {
          code: agnesError.code,
          status,
          details: agnesError.details,
        });
        if (status === 400 || status === 413 || status === 422) {
          throw new GenerationError(
            this.name,
            "invalid_input",
            agnesError.message,
          );
        }
      }
      throw new GenerationError(
        this.name,
        "api_error",
        error instanceof Error ? error.message : "Unknown Agnes image error",
      );
    }
  }
}
