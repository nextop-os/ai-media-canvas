import type { BackgroundJob, VideoGenerationPayload } from "@aimc/shared";

import type { ServerEnv } from "../../../config/env.js";
import { loadGeneratedAsset } from "../../../generation/generated-asset.js";
import { validateVideoGenerationParams } from "../../../generation/model-schemas.js";
import {
  getVideoProvider,
  resolveVideoProviderName,
} from "../../../generation/providers/registry.js";
import type { VideoGenerateParams } from "../../../generation/types.js";
import { GenerationError } from "../../../generation/utils.js";
import type { LocalStore } from "../../../local/store.js";
import { createLocalUserClient } from "../../../local/user-client.js";
import { completeVideoGenerationNode } from "../../canvas/canvas-element-writer.js";
import { refreshGenerationProviders } from "../../settings/settings-service.js";

const DEFAULT_VIDEO_MODEL = "google-official/veo-3.1-generate-preview";

export async function executeVideoGenerationJob(
  store: LocalStore,
  job: BackgroundJob,
  env?: ServerEnv,
) {
  if (env) {
    refreshGenerationProviders(env);
  }
  const payload = job.payload as VideoGenerationPayload;
  const model = payload.model ?? DEFAULT_VIDEO_MODEL;
  const provider = resolveVideoProviderName(model);
  const videoProvider = getVideoProvider(provider);
  const videoParams: VideoGenerateParams = {
    prompt: payload.prompt,
    model,
    ...(payload.duration ? { duration: payload.duration } : {}),
    ...(payload.resolution
      ? {
          resolution: payload.resolution as
            | "480p"
            | "720p"
            | "1080p"
            | "4k"
            | "2160p",
        }
      : {}),
    ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
    ...(payload.input_images ? { inputImages: payload.input_images } : {}),
    ...(payload.input_video ? { inputVideo: payload.input_video } : {}),
    ...(payload.video_mode ? { videoMode: payload.video_mode } : {}),
    ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
    ...(payload.negative_prompt
      ? { negativePrompt: payload.negative_prompt }
      : {}),
    ...(payload.frame_rate !== undefined
      ? { frameRate: payload.frame_rate }
      : {}),
    ...(payload.num_frames !== undefined
      ? { numFrames: payload.num_frames }
      : {}),
    ...(payload.enable_audio !== undefined
      ? { enableAudio: payload.enable_audio }
      : {}),
    metadata: {
      async onRemoteTaskCreated(task: {
        provider?: string;
        taskId: string;
        videoId?: string;
        status?: string;
      }) {
        const remoteTaskId = task.videoId ?? task.taskId;
        console.info("[aimc-worker] video remote task created", {
          jobId: job.id,
          provider: task.provider ?? provider,
          status: task.status ?? null,
          taskId: remoteTaskId,
        });
        store.updateBackgroundJobRemote(job.id, {
          remoteProvider: task.provider ?? provider,
          remoteTaskId,
          remoteStatus: task.status ?? null,
        });
      },
      async onRemoteTaskStatus(task: {
        provider?: string;
        taskId?: string;
        videoId?: string;
        status?: string;
      }) {
        const remoteTaskId =
          task.videoId ?? task.taskId ?? job.remote_task_id ?? null;
        console.info("[aimc-worker] video remote task status", {
          jobId: job.id,
          provider: task.provider ?? provider,
          status: task.status ?? null,
          taskId: remoteTaskId,
        });
        store.updateBackgroundJobRemote(job.id, {
          remoteProvider: task.provider ?? provider,
          ...(remoteTaskId ? { remoteTaskId } : {}),
          remoteStatus: task.status ?? null,
        });
      },
    },
  };
  validateVideoGenerationParams(videoParams);
  const generated =
    job.remote_task_id && videoProvider.resume
      ? await videoProvider.resume(job.remote_task_id, videoParams)
      : await videoProvider.generate(videoParams);

  const { buffer, mimeType } = await loadGeneratedAsset(
    generated.url,
    generated.mimeType || "video/mp4",
  );
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
  if (job.canvas_id) {
    try {
      await completeVideoGenerationNode(createLocalUserClient(store), {
        assetId: stored.asset.id,
        canvasId: job.canvas_id,
        durationSeconds: generated.durationSeconds,
        height: generated.height,
        jobId: job.id,
        mimeType: stored.asset.mimeType ?? mimeType,
        model,
        prompt: payload.prompt,
        ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        signedUrl: stored.url,
        ...(payload.title ? { title: payload.title } : {}),
        width: generated.width,
      });
    } catch (error) {
      console.warn("[video-generation] canvas video insert failed:", error);
    }
  }
  return {
    asset_id: stored.asset.id,
    signed_url: stored.url,
    object_path: stored.asset.objectPath,
    file_path: stored.filePath,
    width: generated.width,
    height: generated.height,
    duration_seconds: generated.durationSeconds,
    mime_type: stored.asset.mimeType ?? mimeType,
    prompt: payload.prompt,
    model,
    ...(payload.aspect_ratio ? { aspect_ratio: payload.aspect_ratio } : {}),
    ...(payload.resolution ? { resolution: payload.resolution } : {}),
  };
}

export function isRetryableVideoGenerationError(error: unknown) {
  if (!(error instanceof GenerationError)) return true;
  if (error.provider === "agnes-video" && error.code === "timeout") {
    return false;
  }
  return ![
    "provider_not_found",
    "model_not_found",
    "invalid_input",
    "input_fetch_error",
    "safety_filter",
    "poll_timeout",
  ].includes(error.code);
}
