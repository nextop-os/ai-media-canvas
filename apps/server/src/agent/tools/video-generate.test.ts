import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearProviders,
  registerVideoProvider,
} from "../../generation/providers/registry.js";
import type { VideoProvider } from "../../generation/types.js";
import { createVideoGenerateTool, runVideoGenerate } from "./video-generate.js";

const AGNES_VIDEO_MODEL = "agnes-video/agnes-video-v2.0";

function registerAgnesVideoProvider() {
  const videoProvider: VideoProvider = {
    name: "agnes-video",
    models: [
      {
        id: AGNES_VIDEO_MODEL,
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
    async generate() {
      throw new Error("not used");
    },
  };

  registerVideoProvider(videoProvider);
}

describe("runVideoGenerate", () => {
  afterEach(() => {
    clearProviders();
  });

  it("returns a capability card output when video generation has no provider", async () => {
    clearProviders();

    const result = await runVideoGenerate({
      title: "Storyboard motion",
      prompt: "Animate this scene",
      model: AGNES_VIDEO_MODEL,
    });

    expect(result.summary).toBe("media_provider_configuration_required");
    expect(result.error).toBe("media_provider_configuration_required");
    expect(result.capabilityRequired).toMatchObject({
      kind: "media_provider_configuration_required",
      capability: "video_generation",
      titleKey: "capabilityRequired.videoTitle",
      descriptionKey: "capabilityRequired.videoDescription",
      action: {
        type: "open_settings",
        tab: "media",
        labelKey: "capabilityRequired.configureMedia",
      },
    });
    expect(JSON.stringify(result.capabilityRequired)).not.toContain("连接");
  });

  it("resolves attachment asset ids before validating and submitting video jobs", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn(async () => ({
      jobId: "job-video-1",
      status: "generating" as const,
    }));

    const result = await runVideoGenerate(
      {
        title: "Dancing refs",
        prompt: "Make these two selected images dance together",
        model: AGNES_VIDEO_MODEL,
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        inputImages: ["asset-a", "asset-b"],
        videoMode: "multivideo",
      },
      submitVideoJob,
      {
        "asset-a": "data:image/png;base64,AAAA",
        "asset-b": "http://127.0.0.1:3001/local-assets/ref-b",
      },
    );

    expect(result).toMatchObject({
      jobId: "job-video-1",
      jobType: "video_generation",
      status: "generating",
    });
    expect(submitVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: [
          "data:image/png;base64,AAAA",
          "http://127.0.0.1:3001/local-assets/ref-b",
        ],
        videoMode: "multivideo",
      }),
    );
  });

  it("reads attachment maps from the tool invocation config", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn(async () => ({
      jobId: "job-video-2",
      status: "generating" as const,
    }));
    const tool = createVideoGenerateTool({
      submitVideoJob,
      availableModels: [
        {
          id: AGNES_VIDEO_MODEL,
          provider: "agnes-video",
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
    });

    await tool.invoke(
      {
        title: "Dancing refs",
        prompt: "Make these two selected images dance together",
        model: AGNES_VIDEO_MODEL,
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        inputImages: ["asset-a", "asset-b"],
        videoMode: "multivideo",
      },
      {
        configurable: {
          user_attachment_map: {
            "asset-a": "data:image/png;base64,AAAA",
            "asset-b": "https://example.com/ref-b.png",
          },
        },
      },
    );

    expect(submitVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: [
          "data:image/png;base64,AAAA",
          "https://example.com/ref-b.png",
        ],
      }),
    );
  });

  it("resolves AIMC canvas assets and normalizes Agnes single-image mode", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn(async () => ({
      jobId: "job-video-canvas-image",
      status: "generating" as const,
    }));

    const result = await runVideoGenerate(
      {
        title: "Canvas dancer",
        prompt: "Animate the selected dancer",
        model: AGNES_VIDEO_MODEL,
        inputImages: ["/local-assets/image-asset-1"],
        videoMode: "reference",
      },
      submitVideoJob,
      undefined,
      async (input) =>
        input === "/local-assets/image-asset-1"
          ? "data:image/png;base64,AAAA"
          : input,
    );

    expect(result).toMatchObject({
      jobId: "job-video-canvas-image",
      status: "generating",
    });
    expect(submitVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: ["data:image/png;base64,AAAA"],
      }),
    );
    expect(submitVideoJob.mock.calls[0]?.[0]).not.toHaveProperty("videoMode");
  });

  it("does not silently downgrade unresolved image inputs to text-to-video", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn();

    const result = await runVideoGenerate(
      {
        title: "Missing canvas image",
        prompt: "Animate the selected image",
        model: AGNES_VIDEO_MODEL,
        inputImages: ["missing-asset-id"],
      },
      submitVideoJob,
    );

    expect(result.error).toMatch(/could not be resolved/i);
    expect(submitVideoJob).not.toHaveBeenCalled();
  });

  it("rejects partially unresolved multi-image inputs without changing modes", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn();

    const result = await runVideoGenerate(
      {
        title: "Incomplete canvas images",
        prompt: "Blend the selected images",
        model: AGNES_VIDEO_MODEL,
        inputImages: ["https://example.com/valid.png", "missing-asset-id"],
        videoMode: "multivideo",
      },
      submitVideoJob,
    );

    expect(result.error).toMatch(/could not be resolved/i);
    expect(submitVideoJob).not.toHaveBeenCalled();
  });

  it("returns a structured error when canvas asset resolution throws", async () => {
    registerAgnesVideoProvider();
    const submitVideoJob = vi.fn();

    const result = await runVideoGenerate(
      {
        title: "Unreadable canvas image",
        prompt: "Animate the selected image",
        model: AGNES_VIDEO_MODEL,
        inputImages: ["/local-assets/image-asset-1"],
      },
      submitVideoJob,
      undefined,
      async () => {
        throw new Error("asset disappeared");
      },
    );

    expect(result.error).toMatch(/could not be resolved/i);
    expect(submitVideoJob).not.toHaveBeenCalled();
  });

  it("resolves canvas assets before direct Agnes generation", async () => {
    const captured: Array<Record<string, unknown>> = [];
    registerVideoProvider({
      name: "agnes-video",
      models: [
        {
          id: AGNES_VIDEO_MODEL,
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
          width: 720,
          height: 1280,
          durationSeconds: 4,
        };
      },
    });

    const result = await runVideoGenerate(
      {
        title: "Direct canvas image",
        prompt: "Animate the selected image",
        model: AGNES_VIDEO_MODEL,
        inputImages: ["/local-assets/image-asset-1"],
      },
      undefined,
      undefined,
      async () => "data:image/png;base64,AAAA",
    );

    expect(result.error).toBeUndefined();
    expect(captured[0]).toMatchObject({
      inputImages: ["data:image/png;base64,AAAA"],
    });
  });
});
