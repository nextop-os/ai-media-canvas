import { createAgnesClient } from "agnes-ai-cli";

import type {
  GeneratedVideo,
  VideoGenerateParams,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError, withTimeout } from "../utils.js";
import {
  type AgnesMediaOptions,
  resolveAgnesMediaOptions,
} from "./agnes-media.js";

const ICON_AGNES = "https://agnes-cdn.kiwiar.com/logo/agnes-icon-400x400.jpg";
const DEFAULT_FRAME_RATE = 24;
const DEFAULT_AGNES_MEDIA_TTL = "1h" as const;
const AGNES_VIDEO_CREATE_TIMEOUT_MS = 60_000;
const AGNES_VIDEO_CREATE_MAX_ATTEMPTS = 3;
const AGNES_VIDEO_STATUS_TIMEOUT_MS = 30_000;
const AGNES_VIDEO_POLL_INTERVAL_SECONDS = 10;
const AGNES_VIDEO_POLL_TIMEOUT_SECONDS = 7_200;
const AGNES_VIDEO_MODEL_IDS = ["agnes-video-v2.0"] as const;
const AGNES_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const AGNES_VIDEO_ALLOWED_DURATIONS = [4, 5, 6, 8, 10, 15, 16] as const;
const MAX_AGNES_DURATION_SECONDS = 16;
const MAX_AGNES_IMAGE_DURATION_SECONDS = 16;
const MAX_AGNES_1080P_IMAGE_NUM_FRAMES = 169;
const MAX_AGNES_NUM_FRAMES = 441;
type AgnesVideoModelId = (typeof AGNES_VIDEO_MODEL_IDS)[number];
type AgnesVideoAspectRatio = (typeof AGNES_VIDEO_ASPECT_RATIOS)[number];
type AgnesVideoResolution = "480p" | "720p" | "1080p";
type AgnesRemoteTaskMetadata = {
  onRemoteTaskCreated?: (task: {
    provider: string;
    taskId: string;
    videoId?: string;
    status?: string;
    raw?: unknown;
  }) => void | Promise<void>;
  onRemoteTaskStatus?: (task: {
    provider: string;
    taskId: string;
    videoId?: string;
    status?: string;
    raw?: unknown;
  }) => void | Promise<void>;
};
const AGNES_VIDEO_MODELS: readonly VideoModelInfo[] = [
  {
    id: "agnes-video/agnes-video-v2.0",
    displayName: "Agnes Video v2.0",
    description:
      "Agnes text, image, multi-image, and keyframe-guided video generation.",
    iconUrl: ICON_AGNES,
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: false,
    },
    limits: {
      allowedDurations: [...AGNES_VIDEO_ALLOWED_DURATIONS],
      maxDuration: MAX_AGNES_DURATION_SECONDS,
      maxResolution: "1080p",
      maxInputImages: 8,
    },
  },
];

function getVideoDimensions(
  resolution: AgnesVideoResolution | undefined,
  aspectRatio: AgnesVideoAspectRatio,
) {
  const landscapeBase =
    resolution === "1080p"
      ? { width: 1920, height: 1080 }
      : resolution === "480p"
        ? { width: 854, height: 480 }
        : { width: 1280, height: 720 };

  if (aspectRatio === "9:16") {
    return { width: landscapeBase.height, height: landscapeBase.width };
  }
  return landscapeBase;
}

function resolveAgnesResolution(
  resolution: VideoGenerateParams["resolution"] | "4k" | undefined,
  hasInputImages = false,
  numFrames = 0,
): AgnesVideoResolution | undefined {
  if (resolution === undefined) {
    return resolution;
  }
  if (resolution === "480p" || resolution === "720p") {
    return resolution;
  }
  if (resolution === "1080p") {
    return hasInputImages && numFrames > MAX_AGNES_1080P_IMAGE_NUM_FRAMES
      ? "720p"
      : resolution;
  }
  throw new GenerationError(
    "agnes-video",
    "invalid_input",
    `Unsupported Agnes video resolution: ${resolution}. Use 480p, 720p, or 1080p.`,
  );
}

function resolveAgnesAspectRatio(
  aspectRatio: string | undefined,
): AgnesVideoAspectRatio {
  const resolvedAspectRatio = aspectRatio ?? "16:9";
  if (
    AGNES_VIDEO_ASPECT_RATIOS.includes(
      resolvedAspectRatio as AgnesVideoAspectRatio,
    )
  ) {
    return resolvedAspectRatio as AgnesVideoAspectRatio;
  }
  throw new GenerationError(
    "agnes-video",
    "invalid_input",
    `Unsupported Agnes video aspect ratio: ${resolvedAspectRatio}. Use 16:9 or 9:16.`,
  );
}

function resolveAgnesFrameRate(frameRate: number | undefined) {
  const resolvedFrameRate = frameRate ?? DEFAULT_FRAME_RATE;
  if (
    !Number.isInteger(resolvedFrameRate) ||
    resolvedFrameRate < 1 ||
    resolvedFrameRate > 60
  ) {
    throw new GenerationError(
      "agnes-video",
      "invalid_input",
      `Invalid Agnes frameRate: ${resolvedFrameRate}. Use an integer between 1 and 60.`,
    );
  }
  return resolvedFrameRate;
}

function resolveAgnesDuration(duration: number | undefined) {
  const resolvedDuration = duration ?? 5;
  if (
    !Number.isInteger(resolvedDuration) ||
    !AGNES_VIDEO_ALLOWED_DURATIONS.includes(
      resolvedDuration as (typeof AGNES_VIDEO_ALLOWED_DURATIONS)[number],
    )
  ) {
    throw new GenerationError(
      "agnes-video",
      "invalid_input",
      `Invalid Agnes duration: ${resolvedDuration}. Use one of ${AGNES_VIDEO_ALLOWED_DURATIONS.join(", ")} seconds.`,
    );
  }
  return resolvedDuration;
}

function resolveAgnesImageDuration(durationSeconds: number) {
  return Math.min(durationSeconds, MAX_AGNES_IMAGE_DURATION_SECONDS);
}

function alignAgnesNumFrames(durationSeconds: number, frameRate: number) {
  const targetFrameCount = durationSeconds * frameRate;
  const alignedSteps = Math.max(1, Math.round(targetFrameCount / 8));
  return alignedSteps * 8 + 1;
}

function resolveAgnesNumFrames(
  durationSeconds: number,
  frameRate: number,
  numFrames: number | undefined,
) {
  if (numFrames !== undefined) {
    if (!Number.isInteger(numFrames) || numFrames <= 0) {
      throw new GenerationError(
        "agnes-video",
        "invalid_input",
        `Invalid Agnes numFrames: ${numFrames}. Use a positive integer.`,
      );
    }
    if (numFrames > MAX_AGNES_NUM_FRAMES) {
      throw new GenerationError(
        "agnes-video",
        "invalid_input",
        `Invalid Agnes numFrames: ${numFrames}. Maximum supported value is ${MAX_AGNES_NUM_FRAMES}.`,
      );
    }
    if ((numFrames - 1) % 8 !== 0) {
      throw new GenerationError(
        "agnes-video",
        "invalid_input",
        `Invalid Agnes numFrames: ${numFrames}. Agnes requires 8n + 1 frames.`,
      );
    }
    return numFrames;
  }

  const derivedNumFrames = alignAgnesNumFrames(durationSeconds, frameRate);
  if (derivedNumFrames > MAX_AGNES_NUM_FRAMES) {
    throw new GenerationError(
      "agnes-video",
      "invalid_input",
      `Requested duration (${durationSeconds}s) and frameRate (${frameRate}) exceed Agnes limits. Reduce frameRate or duration.`,
    );
  }
  return derivedNumFrames;
}

function resolveAgnesVideoModel(modelId: string): AgnesVideoModelId {
  const normalized = modelId.includes("/")
    ? (modelId.split("/").pop() ?? modelId)
    : modelId;
  if (AGNES_VIDEO_MODEL_IDS.includes(normalized as AgnesVideoModelId)) {
    return normalized as AgnesVideoModelId;
  }
  throw new GenerationError(
    "agnes-video",
    "model_not_found",
    `Unsupported Agnes video model: ${modelId}`,
  );
}

function resolveAgnesVideoMode(params: VideoGenerateParams) {
  const inputImages = params.inputImages ?? [];
  if (inputImages.length === 0) return "text2video" as const;
  if (inputImages.length === 1) return "img2video" as const;
  if (params.videoMode === "keyframes") return "keyframes" as const;
  return "multivideo" as const;
}

function getFirstAgnesInputImage(inputImages: string[]) {
  const [image] = inputImages;
  if (image) return image;
  throw new GenerationError(
    "agnes-video",
    "invalid_input",
    "Agnes img2video requires exactly one image.",
  );
}

function getAgnesRemoteTaskMetadata(
  params: VideoGenerateParams,
): AgnesRemoteTaskMetadata {
  return params.metadata ?? {};
}

function resolveAgnesVideoRequest(params: VideoGenerateParams) {
  if (params.inputVideo) {
    throw new GenerationError(
      "agnes-video",
      "invalid_input",
      "Agnes video does not support inputVideo in AIMC yet.",
    );
  }

  const inputImages = params.inputImages ?? [];
  const hasInputImages = inputImages.length > 0;
  const aspectRatio = resolveAgnesAspectRatio(params.aspectRatio);
  const frameRate = resolveAgnesFrameRate(params.frameRate);
  const durationSeconds = hasInputImages
    ? resolveAgnesImageDuration(resolveAgnesDuration(params.duration))
    : resolveAgnesDuration(params.duration);
  const numFrames = resolveAgnesNumFrames(
    durationSeconds,
    frameRate,
    params.numFrames,
  );
  const resolution = resolveAgnesResolution(
    params.resolution as VideoGenerateParams["resolution"] | "4k" | undefined,
    hasInputImages,
    numFrames,
  );
  const { width, height } = getVideoDimensions(resolution, aspectRatio);
  const mode = resolveAgnesVideoMode(params);
  resolveAgnesVideoModel(params.model);

  return {
    durationSeconds,
    frameRate,
    height,
    inputImages,
    mode,
    numFrames,
    width,
  };
}

export class AgnesVideoProvider implements VideoProvider {
  readonly name = "agnes-video";
  readonly models = AGNES_VIDEO_MODELS;
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

  async generate(params: VideoGenerateParams): Promise<GeneratedVideo> {
    const request = resolveAgnesVideoRequest(params);
    const metadata = getAgnesRemoteTaskMetadata(params);

    try {
      const task = await this.createTaskWithRetry(() =>
        request.mode === "text2video"
          ? this.client.video.generate({
              mode: request.mode,
              prompt: params.prompt,
              width: request.width,
              height: request.height,
              numFrames: request.numFrames,
              frameRate: request.frameRate,
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
              ...(params.negativePrompt
                ? { negativePrompt: params.negativePrompt }
                : {}),
            })
          : request.mode === "img2video"
            ? this.client.video.generate({
                mode: request.mode,
                image: getFirstAgnesInputImage(request.inputImages),
                prompt: params.prompt,
                width: request.width,
                height: request.height,
                numFrames: request.numFrames,
                frameRate: request.frameRate,
                ttl: DEFAULT_AGNES_MEDIA_TTL,
                ...(params.seed !== undefined ? { seed: params.seed } : {}),
                ...(params.negativePrompt
                  ? { negativePrompt: params.negativePrompt }
                  : {}),
              })
            : this.client.video.generate({
                mode: request.mode,
                images: request.inputImages,
                prompt: params.prompt,
                width: request.width,
                height: request.height,
                numFrames: request.numFrames,
                frameRate: request.frameRate,
                ttl: DEFAULT_AGNES_MEDIA_TTL,
                ...(params.seed !== undefined ? { seed: params.seed } : {}),
                ...(params.negativePrompt
                  ? { negativePrompt: params.negativePrompt }
                  : {}),
              }),
      );

      const taskWithVideoId = task as typeof task & { videoId?: string };

      await metadata.onRemoteTaskCreated?.({
        provider: this.name,
        taskId: task.taskId,
        ...(taskWithVideoId.videoId
          ? { videoId: taskWithVideoId.videoId }
          : {}),
        ...(typeof task.status === "string" ? { status: task.status } : {}),
        raw: task.raw,
      });

      return await this.pollTask(
        taskWithVideoId.videoId ?? task.taskId,
        request,
        metadata,
      );
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      if (isAgnesPollTimeoutError(error)) {
        throw new GenerationError(
          this.name,
          "poll_timeout",
          "Agnes video polling timed out after the remote task was created.",
        );
      }
      throw new GenerationError(
        this.name,
        "api_error",
        error instanceof Error ? error.message : "Unknown Agnes video error",
      );
    }
  }

  async resume(
    remoteTaskId: string,
    params: VideoGenerateParams,
  ): Promise<GeneratedVideo> {
    const request = resolveAgnesVideoRequest(params);
    const metadata = getAgnesRemoteTaskMetadata(params);
    try {
      return await this.pollTask(remoteTaskId, request, metadata);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      if (isAgnesPollTimeoutError(error)) {
        throw new GenerationError(
          this.name,
          "poll_timeout",
          "Agnes video polling timed out after the remote task was created.",
        );
      }
      throw new GenerationError(
        this.name,
        "api_error",
        error instanceof Error ? error.message : "Unknown Agnes video error",
      );
    }
  }

  private async createTaskWithRetry(
    createTask: () => ReturnType<typeof this.client.video.generate>,
  ) {
    for (
      let attempt = 1;
      attempt <= AGNES_VIDEO_CREATE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await withTimeout(
          createTask(),
          AGNES_VIDEO_CREATE_TIMEOUT_MS,
          () =>
            new GenerationError(
              this.name,
              "timeout",
              `Agnes video task creation timed out after ${AGNES_VIDEO_CREATE_TIMEOUT_MS}ms.`,
            ),
        );
      } catch (error) {
        if (
          !(
            error instanceof GenerationError &&
            error.code === "timeout" &&
            attempt < AGNES_VIDEO_CREATE_MAX_ATTEMPTS
          )
        ) {
          throw error;
        }
      }
    }
    throw new GenerationError(
      this.name,
      "timeout",
      `Agnes video task creation timed out after ${AGNES_VIDEO_CREATE_TIMEOUT_MS}ms.`,
    );
  }

  private async pollTask(
    initialPollId: string,
    request: ReturnType<typeof resolveAgnesVideoRequest>,
    metadata: AgnesRemoteTaskMetadata,
  ): Promise<GeneratedVideo> {
    const startedAt = Date.now();
    let pollId = initialPollId;

    for (;;) {
      const task = await this.client.video.get(pollId, {
        timeoutMs: AGNES_VIDEO_STATUS_TIMEOUT_MS,
      });
      const status = task.status;
      const videoId = task.videoId;
      const remoteTaskId = videoId ?? task.taskId ?? pollId;
      await metadata.onRemoteTaskStatus?.({
        provider: this.name,
        taskId: remoteTaskId,
        ...(videoId ? { videoId } : {}),
        status,
        raw: task.raw,
      });

      if (status === "failed" || status === "canceled") {
        throw new GenerationError(
          this.name,
          status === "canceled" ? "canceled" : "api_error",
          getAgnesTaskErrorMessage(task.error, status),
        );
      }

      if (status === "completed") {
        if (!task.videoUrl) {
          throw new GenerationError(
            this.name,
            "api_error",
            "Agnes video task completed without a video URL.",
          );
        }
        return {
          url: task.videoUrl,
          mimeType: "video/mp4",
          width: request.width,
          height: request.height,
          durationSeconds:
            task.seconds ??
            request.durationSeconds ??
            Math.round((request.numFrames - 1) / request.frameRate),
        };
      }

      if (videoId) {
        pollId = videoId;
      }

      if (Date.now() - startedAt >= AGNES_VIDEO_POLL_TIMEOUT_SECONDS * 1_000) {
        throw new GenerationError(
          this.name,
          "poll_timeout",
          `Agnes video task ${pollId} did not finish within ${AGNES_VIDEO_POLL_TIMEOUT_SECONDS} seconds.`,
        );
      }

      await delay(AGNES_VIDEO_POLL_INTERVAL_SECONDS * 1_000);
    }
  }
}

function getAgnesTaskErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return `Agnes video task ${fallback}.`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgnesPollTimeoutError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "POLL_TIMEOUT"
  );
}
