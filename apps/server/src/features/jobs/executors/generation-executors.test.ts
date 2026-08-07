import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearProviders,
  registerImageProvider,
  registerVideoProvider,
} from "../../../generation/providers/registry.js";
import type {
  ImageProvider,
  VideoProvider,
} from "../../../generation/types.js";
import { GenerationError } from "../../../generation/utils.js";
import { createLocalStore } from "../../../local/store.js";
import { createLocalUserClient } from "../../../local/user-client.js";
import { insertVideoGenerationNode } from "../../canvas/canvas-element-writer.js";
import { executeImageGenerationJob } from "./image-generation.js";
import {
  executeVideoGenerationJob,
  isRetryableVideoGenerationError,
} from "./video-generation.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearProviders();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generation executors", () => {
  it("persists generated image bytes locally and returns AIMC-compatible fields", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-image-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const imageBytes = Buffer.from("fake-image-binary");
    const imageProvider: ImageProvider = {
      name: "test-image",
      models: [
        {
          id: "test/image-model",
          displayName: "Test Image",
          description: "Test image provider",
        },
      ],
      async generate() {
        return {
          url: `data:image/png;base64,${imageBytes.toString("base64")}`,
          mimeType: "image/png",
          width: 1024,
          height: 768,
        };
      },
    };

    registerImageProvider(imageProvider);

    const project = store.createProject({ name: "Executor Image Project" });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A dramatic sky",
        model: "test/image-model",
        aspect_ratio: "4:3",
      },
    });

    const result = await executeImageGenerationJob(store, job);

    expect(result).toMatchObject({
      asset_id: expect.any(String),
      signed_url: expect.stringContaining("/local-assets/"),
      mime_type: "image/png",
      width: 1024,
      height: 768,
    });

    const asset = store.getAssetResponse(result.asset_id as string);
    if (!asset) throw new Error("Expected generated image asset to be stored.");
    expect(result.file_path).toBe(asset.filePath);
    expect(asset?.mimeType).toBe("image/png");
    expect(readFileSync(asset.filePath)).toEqual(imageBytes);
  });

  it("uses the image generation title as the exposed reference name", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-image-title-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const imageBytes = Buffer.from("named-image-binary");
    registerImageProvider({
      name: "test-image",
      models: [
        {
          id: "test/image-model",
          displayName: "Test Image",
          description: "Test image provider",
        },
      ],
      async generate() {
        return {
          url: `data:image/png;base64,${imageBytes.toString("base64")}`,
          mimeType: "image/png",
          width: 1024,
          height: 768,
        };
      },
    });

    const project = store.createProject({ name: "Named Image Project" });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A dramatic sky",
        title: "Dramatic sky over Tokyo",
        model: "test/image-model",
        aspect_ratio: "4:3",
      },
    });

    const result = await executeImageGenerationJob(store, job);
    store.markBackgroundJobSucceeded(job.id, result);

    const references = store.listReferenceProjectAssets({
      projectId: project.id,
      limit: 10,
    });

    expect(references.files[0]?.displayName).toBe(
      "Dramatic sky over Tokyo.png",
    );
  });

  it("inserts completed image jobs into their bound canvas", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-image-canvas-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const imageBytes = Buffer.from("fake-image-binary");
    registerImageProvider({
      name: "test-image",
      models: [
        {
          id: "test/image-model",
          displayName: "Test Image",
          description: "Test image provider",
        },
      ],
      async generate() {
        return {
          url: `data:image/png;base64,${imageBytes.toString("base64")}`,
          mimeType: "image/png",
          width: 1024,
          height: 768,
        };
      },
    });

    const project = store.createProject({ name: "Executor Canvas Project" });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      canvasId: project.primaryCanvas.id,
      payload: {
        prompt: "A dramatic sky",
        model: "test/image-model",
        aspect_ratio: "4:3",
      },
    });

    const result = await executeImageGenerationJob(store, job);
    const canvas = store.getCanvas(project.primaryCanvas.id);

    expect(canvas?.content.elements).toHaveLength(1);
    expect(canvas?.content.elements[0]).toMatchObject({
      type: "image",
      customData: {
        assetId: result.asset_id,
        jobId: job.id,
        source: "generated",
      },
    });
  });

  it("rejects proxied Codex image jobs without persisted delegation consent", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-image-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    registerImageProvider({
      name: "codex-imagegen",
      models: [
        {
          id: "codex/gpt-image-2",
          displayName: "GPT Image 2",
          description: "Codex image generation",
        },
      ],
      async generate() {
        throw new Error("not used");
      },
    });

    const project = store.createProject({ name: "Executor Image Project" });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A dramatic sky",
        model: "codex/gpt-image-2",
        caller_provider: "claude",
      },
    });

    await expect(executeImageGenerationJob(store, job)).rejects.toMatchObject({
      code: "codex_imagegen_confirmation_required",
    });
  });

  it("allows proxied Codex image jobs with server-approved delegation metadata", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-image-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const imageBytes = Buffer.from("approved-codex-image");
    registerImageProvider({
      name: "codex-imagegen",
      models: [
        {
          id: "codex/gpt-image-2",
          displayName: "GPT Image 2",
          description: "Codex image generation",
        },
      ],
      async generate() {
        return {
          url: `data:image/png;base64,${imageBytes.toString("base64")}`,
          mimeType: "image/png",
          width: 8,
          height: 8,
        };
      },
    });

    const project = store.createProject({ name: "Executor Image Project" });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A dramatic sky",
        model: "codex/gpt-image-2",
        caller_provider: "claude",
        codex_imagegen_delegation_allowed: true,
      },
    });

    await expect(executeImageGenerationJob(store, job)).resolves.toMatchObject({
      mime_type: "image/png",
      width: 8,
      height: 8,
    });
  });

  it("persists generated video bytes locally and returns AIMC-compatible fields", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-video-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const videoBytes = Buffer.from("fake-video-binary");
    const videoProvider: VideoProvider = {
      name: "test-video",
      models: [
        {
          id: "test/video-model",
          displayName: "Test Video",
          description: "Test video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 8,
            maxResolution: "1080p",
            maxInputImages: 2,
          },
        },
      ],
      async generate() {
        return {
          url: `data:video/mp4;base64,${videoBytes.toString("base64")}`,
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 6,
        };
      },
    };

    registerVideoProvider(videoProvider);

    const project = store.createProject({ name: "Executor Video Project" });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A cinematic flythrough",
        model: "test/video-model",
        duration: 6,
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    });

    const result = await executeVideoGenerationJob(store, job);

    expect(result).toMatchObject({
      asset_id: expect.any(String),
      signed_url: expect.stringContaining("/local-assets/"),
      mime_type: "video/mp4",
      width: 1280,
      height: 720,
      duration_seconds: 6,
      prompt: "A cinematic flythrough",
      model: "test/video-model",
      aspect_ratio: "16:9",
      resolution: "720p",
    });

    const asset = store.getAssetResponse(result.asset_id as string);
    if (!asset) throw new Error("Expected generated video asset to be stored.");
    expect(result.file_path).toBe(asset.filePath);
    expect(asset?.mimeType).toBe("video/mp4");
    expect(readFileSync(asset.filePath)).toEqual(videoBytes);
  });

  it("completes a bound video generation node on the canvas", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-video-canvas-"));
    tempDirs.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const videoBytes = Buffer.from("canvas-video-binary");
    registerVideoProvider({
      name: "test-video",
      models: [
        {
          id: "test/video-model",
          displayName: "Test Video",
          description: "Test video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: false,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 8,
            maxResolution: "1080p",
            maxInputImages: 0,
          },
        },
      ],
      async generate() {
        return {
          url: `data:video/mp4;base64,${videoBytes.toString("base64")}`,
          mimeType: "video/mp4",
          width: 854,
          height: 480,
          durationSeconds: 4,
        };
      },
    });
    const project = store.createProject({ name: "Video Canvas Project" });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      canvasId: project.primaryCanvas.id,
      payload: {
        prompt: "A paper boat drifting",
        model: "test/video-model",
        duration: 4,
        aspect_ratio: "16:9",
        resolution: "480p",
      },
    });
    const pending = await insertVideoGenerationNode(
      createLocalUserClient(store),
      {
        aspectRatio: "16:9",
        canvasId: project.primaryCanvas.id,
        duration: 4,
        jobId: job.id,
        model: "test/video-model",
        prompt: "A paper boat drifting",
        resolution: "480p",
      },
    );

    const result = await executeVideoGenerationJob(store, job);
    const canvas = store.getCanvas(project.primaryCanvas.id);

    expect(canvas?.content.elements).toHaveLength(1);
    expect(canvas?.content.elements[0]).toMatchObject({
      id: pending.elementId,
      type: "rectangle",
      customData: {
        isVideo: true,
        source: "generated",
        jobId: job.id,
        assetId: result.asset_id,
        videoUrl: `/local-assets/${result.asset_id}`,
      },
    });
  });

  it("uses the video generation title as the exposed reference name", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-video-title-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const videoBytes = Buffer.from("named-video-binary");
    registerVideoProvider({
      name: "test-video",
      models: [
        {
          id: "test/video-model",
          displayName: "Test Video",
          description: "Test video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 8,
            maxResolution: "1080p",
            maxInputImages: 2,
          },
        },
      ],
      async generate() {
        return {
          url: `data:video/mp4;base64,${videoBytes.toString("base64")}`,
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 6,
        };
      },
    });

    const project = store.createProject({ name: "Named Video Project" });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A cinematic flythrough",
        title: "Cinematic harbor flythrough",
        model: "test/video-model",
        duration: 6,
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    });

    const result = await executeVideoGenerationJob(store, job);
    store.markBackgroundJobSucceeded(job.id, result);

    const references = store.listReferenceProjectAssets({
      projectId: project.id,
      limit: 10,
    });

    expect(references.files[0]?.displayName).toBe(
      "Cinematic harbor flythrough.mp4",
    );
  });

  it("forwards Agnes phase-2 video controls through the video executor", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-agnes-video-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const captured: Array<Record<string, unknown>> = [];
    const videoProvider: VideoProvider = {
      name: "agnes-video",
      models: [
        {
          id: "agnes-video/agnes-video-v2.0",
          displayName: "Agnes Video",
          description: "Agnes video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 16,
            maxResolution: "1080p",
            maxInputImages: 8,
          },
        },
      ],
      async generate(params) {
        captured.push(params as unknown as Record<string, unknown>);
        return {
          url: "data:video/mp4;base64,ZmFrZS12aWRlbw==",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 4,
        };
      },
    };

    registerVideoProvider(videoProvider);

    const project = store.createProject({
      name: "Executor Agnes Video Project",
    });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "Morph between two scenes",
        model: "agnes-video/agnes-video-v2.0",
        duration: 4,
        aspect_ratio: "16:9",
        input_images: [
          "data:image/png;base64,AAAA",
          "data:image/png;base64,BBBB",
        ],
        video_mode: "keyframes",
        seed: 11,
        negative_prompt: "shake, blur",
        frame_rate: 12,
        num_frames: 97,
      },
    });

    await executeVideoGenerationJob(store, job);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      model: "agnes-video/agnes-video-v2.0",
      videoMode: "keyframes",
      seed: 11,
      negativePrompt: "shake, blur",
      frameRate: 12,
      numFrames: 97,
      inputImages: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
    });
  });

  it("does not retry Agnes poll timeout after the remote video task was created", () => {
    expect(
      isRetryableVideoGenerationError(
        new GenerationError(
          "agnes-video",
          "poll_timeout",
          "Agnes video polling timed out.",
        ),
      ),
    ).toBe(false);
  });

  it("does not retry Agnes video creation timeout to avoid duplicate submissions", () => {
    expect(
      isRetryableVideoGenerationError(
        new GenerationError(
          "agnes-video",
          "timeout",
          "Agnes video task creation timed out.",
        ),
      ),
    ).toBe(false);
  });

  it("persists Agnes video_id as the resumable remote video task id", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-video-id-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const videoBytes = Buffer.from("agnes-video-id-binary");
    const videoProvider: VideoProvider = {
      name: "agnes-video",
      models: [
        {
          id: "agnes-video/agnes-video-v2.0",
          displayName: "Agnes Video",
          description: "Agnes video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 16,
            maxResolution: "1080p",
            maxInputImages: 8,
          },
        },
      ],
      async generate(params) {
        const metadata = params.metadata as
          | {
              onRemoteTaskCreated?: (task: {
                provider: string;
                taskId: string;
                videoId?: string;
                status?: string;
              }) => Promise<void> | void;
              onRemoteTaskStatus?: (task: {
                provider: string;
                taskId: string;
                videoId?: string;
                status?: string;
              }) => Promise<void> | void;
            }
          | undefined;
        await metadata?.onRemoteTaskCreated?.({
          provider: "agnes-video",
          taskId: "task_123",
          videoId: "video_123",
          status: "queued",
        });
        await metadata?.onRemoteTaskStatus?.({
          provider: "agnes-video",
          taskId: "video_123",
          videoId: "video_123",
          status: "completed",
        });
        return {
          url: `data:video/mp4;base64,${videoBytes.toString("base64")}`,
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 5,
        };
      },
    };

    registerVideoProvider(videoProvider);

    const project = store.createProject({
      name: "Executor Agnes Video ID Project",
    });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "Persist the Agnes video id",
        model: "agnes-video/agnes-video-v2.0",
        duration: 5,
        aspect_ratio: "16:9",
      },
    });

    await executeVideoGenerationJob(store, job);

    expect(store.getBackgroundJob(job.id)).toMatchObject({
      remote_provider: "agnes-video",
      remote_task_id: "video_123",
      remote_status: "completed",
    });
  });

  it("continues polling a saved remote video task without creating a duplicate", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-job-video-resume-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const videoBytes = Buffer.from("resumed-video-binary");
    const generate = vi.fn();
    const resume = vi.fn(async () => ({
      url: `data:video/mp4;base64,${videoBytes.toString("base64")}`,
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5,
    }));
    const videoProvider: VideoProvider = {
      name: "agnes-video",
      models: [
        {
          id: "agnes-video/agnes-video-v2.0",
          displayName: "Agnes Video",
          description: "Agnes video provider",
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 16,
            maxResolution: "1080p",
            maxInputImages: 8,
          },
        },
      ],
      generate,
      resume,
    };

    registerVideoProvider(videoProvider);

    const project = store.createProject({
      name: "Executor Resume Video Project",
    });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "Resume this Agnes video",
        model: "agnes-video/agnes-video-v2.0",
        duration: 5,
        aspect_ratio: "16:9",
      },
    });
    store.updateBackgroundJobRemote(job.id, {
      remoteProvider: "agnes-video",
      remoteTaskId: "task_resume_123",
      remoteStatus: "queued",
    });
    const resumedJob = store.getBackgroundJob(job.id);
    if (!resumedJob) throw new Error("Expected resumed video job to exist.");

    const result = await executeVideoGenerationJob(store, resumedJob);

    expect(generate).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(
      "task_resume_123",
      expect.objectContaining({
        model: "agnes-video/agnes-video-v2.0",
        prompt: "Resume this Agnes video",
      }),
    );
    expect(result).toMatchObject({
      asset_id: expect.any(String),
      mime_type: "video/mp4",
      width: 1280,
      height: 720,
      duration_seconds: 5,
    });
  });
});
