import { beforeEach, describe, expect, it, vi } from "vitest";

const { videoGenerateMock, videoGetMock, createAgnesClientMock } = vi.hoisted(
  () => {
    const videoGenerateMock = vi.fn();
    const videoGetMock = vi.fn();
    const createAgnesClientMock = vi.fn(() => ({
      video: {
        generate: videoGenerateMock,
        get: videoGetMock,
      },
    }));
    return {
      videoGenerateMock,
      videoGetMock,
      createAgnesClientMock,
    };
  },
);

vi.mock("agnes-ai-cli", () => ({
  createAgnesClient: createAgnesClientMock,
}));

import { DEFAULT_AGNES_TEMPORARY_MEDIA_PROVIDER_ORDER } from "./agnes-media.js";
import { AgnesVideoProvider } from "./agnes-video.js";

describe("AgnesVideoProvider", () => {
  beforeEach(() => {
    videoGenerateMock.mockReset();
    videoGetMock.mockReset();
    createAgnesClientMock.mockClear();
    videoGenerateMock.mockResolvedValue({
      ok: true,
      taskId: "task_123",
      videoId: "video_123",
      status: "queued",
      model: "agnes-video-v2.0",
      raw: {},
    });
    videoGetMock.mockResolvedValue({
      ok: true,
      taskId: "task_123",
      videoId: "video_123",
      status: "completed",
      model: "agnes-video-v2.0",
      videoUrl: "https://cdn.agnes.example/generated.mp4",
      seconds: 5,
      raw: {},
    });
  });

  it("maps prompt-only requests to Agnes text2video mode", async () => {
    const provider = new AgnesVideoProvider(
      "agnes-test-key",
      "https://agnes.example/v1",
    );

    const result = await provider.generate({
      prompt: "A dolly shot through a neon alley",
      model: "agnes-video/agnes-video-v2.0",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(createAgnesClientMock).toHaveBeenCalledWith({
      apiKey: "agnes-test-key",
      baseUrl: "https://agnes.example/v1",
      temporaryMediaProviderOrder: DEFAULT_AGNES_TEMPORARY_MEDIA_PROVIDER_ORDER,
    });
    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "text2video",
      prompt: "A dolly shot through a neon alley",
      width: 1280,
      height: 720,
      numFrames: 121,
      frameRate: 24,
    });
    expect(videoGetMock).toHaveBeenCalledWith("video_123", {
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      url: "https://cdn.agnes.example/generated.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5,
    });
  });

  it("forwards Agnes phase-2 video controls", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "A stylized camera move",
      model: "agnes-video/agnes-video-v2.0",
      aspectRatio: "16:9",
      resolution: "720p",
      seed: 7,
      negativePrompt: "flicker, blur",
      frameRate: 12,
      numFrames: 97,
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "text2video",
      prompt: "A stylized camera move",
      width: 1280,
      height: 720,
      numFrames: 97,
      frameRate: 12,
      seed: 7,
      negativePrompt: "flicker, blur",
    });
  });

  it("derives an Agnes-compatible frame count when only frameRate is provided", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "A stylized camera move",
      model: "agnes-video/agnes-video-v2.0",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      frameRate: 12,
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "text2video",
      prompt: "A stylized camera move",
      width: 1280,
      height: 720,
      numFrames: 65,
      frameRate: 12,
    });
  });

  it("rejects Agnes durations above the remote creation limit before calling the API", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await expect(
      provider.generate({
        prompt: "A long stylized camera move",
        model: "agnes-video/agnes-video-v2.0",
        duration: 18,
        aspectRatio: "16:9",
        resolution: "720p",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "Invalid Agnes duration: 18. Use one of 4, 5, 6, 8, 10, 15, 16 seconds.",
      provider: "agnes-video",
    });
    expect(videoGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects Agnes numFrames values that violate the 8n + 1 rule", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await expect(
      provider.generate({
        prompt: "A stylized camera move",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "16:9",
        resolution: "720p",
        frameRate: 12,
        numFrames: 96,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Invalid Agnes numFrames: 96. Agnes requires 8n + 1 frames.",
      provider: "agnes-video",
    });
    expect(videoGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported Agnes aspect ratios", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await expect(
      provider.generate({
        prompt: "A stylized camera move",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "1:1",
        resolution: "720p",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "Unsupported Agnes video aspect ratio: 1:1. Use 16:9 or 9:16.",
      provider: "agnes-video",
    });
    expect(videoGenerateMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported Agnes resolutions instead of silently downgrading", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await expect(
      provider.generate({
        prompt: "A stylized camera move",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "16:9",
        resolution: "4k" as "720p",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "Unsupported Agnes video resolution: 4k. Use 480p, 720p, or 1080p.",
      provider: "agnes-video",
    });
    expect(videoGenerateMock).not.toHaveBeenCalled();
  });

  it("maps one input image to Agnes img2video mode", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "Add wind and camera motion",
      model: "agnes-video/agnes-video-v2.0",
      duration: 4,
      aspectRatio: "9:16",
      resolution: "720p",
      inputImages: ["data:image/png;base64,AAAA"],
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "img2video",
      image: "data:image/png;base64,AAAA",
      prompt: "Add wind and camera motion",
      width: 720,
      height: 1280,
      numFrames: 97,
      frameRate: 24,
      ttl: "1h",
    });
  });

  it("caps image-conditioned Agnes videos to the supported 720p resolution", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "Make the first frame dance",
      model: "agnes-video/agnes-video-v2.0",
      duration: 16,
      aspectRatio: "16:9",
      resolution: "1080p",
      inputImages: ["data:image/png;base64,AAAA"],
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "img2video",
      image: "data:image/png;base64,AAAA",
      prompt: "Make the first frame dance",
      width: 1280,
      height: 720,
      numFrames: 385,
      frameRate: 24,
      ttl: "1h",
    });
  });

  it("keeps short image-conditioned Agnes videos at 1080p", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "Make the first frame dance",
      model: "agnes-video/agnes-video-v2.0",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "1080p",
      inputImages: ["data:image/png;base64,AAAA"],
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "img2video",
      image: "data:image/png;base64,AAAA",
      prompt: "Make the first frame dance",
      width: 1920,
      height: 1080,
      numFrames: 121,
      frameRate: 24,
      ttl: "1h",
    });
  });

  it("maps multiple input images to Agnes multivideo mode by default", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "Blend these two concepts",
      model: "agnes-video/agnes-video-v2.0",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1080p",
      inputImages: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "multivideo",
      images: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
      prompt: "Blend these two concepts",
      width: 1920,
      height: 1080,
      numFrames: 145,
      frameRate: 24,
      ttl: "1h",
    });
  });

  it("maps multiple input images with keyframes mode to Agnes keyframes", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");

    await provider.generate({
      prompt: "Morph between the two scenes",
      model: "agnes-video/agnes-video-v2.0",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "720p",
      inputImages: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
      videoMode: "keyframes",
    });

    expect(videoGenerateMock).toHaveBeenCalledWith({
      mode: "keyframes",
      images: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
      prompt: "Morph between the two scenes",
      width: 1280,
      height: 720,
      numFrames: 97,
      frameRate: 24,
      ttl: "1h",
    });
  });

  it("times out if Agnes video task creation never returns", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");
    videoGenerateMock.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();

    try {
      const resultPromise = provider.generate({
        prompt: "A stuck Agnes request",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "16:9",
        resolution: "720p",
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "timeout",
        message: "Agnes video task creation timed out after 60000ms.",
        provider: "agnes-video",
      });

      await vi.advanceTimersByTimeAsync(180_000);

      await rejection;
      expect(videoGenerateMock).toHaveBeenCalledTimes(3);
      expect(videoGetMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries Agnes video task creation after a one-minute no-response timeout", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");
    videoGenerateMock
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({
        ok: true,
        taskId: "task_123",
        status: "queued",
        model: "agnes-video-v2.0",
        raw: {},
      });
    vi.useFakeTimers();

    try {
      const resultPromise = provider.generate({
        prompt: "Retry a stuck Agnes create request",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "16:9",
        resolution: "720p",
      });

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(videoGenerateMock).toHaveBeenCalledTimes(2);
      expect(videoGetMock).toHaveBeenCalled();
      expect(result.url).toBe("https://cdn.agnes.example/generated.mp4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling queued Agnes tasks through the CLI status adapter", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");
    videoGenerateMock.mockResolvedValueOnce({
      ok: true,
      taskId: "task_123",
      status: "queued",
      model: "agnes-video-v2.0",
      raw: {},
    });
    videoGetMock
      .mockResolvedValueOnce({
        ok: true,
        taskId: "task_123",
        videoId: "video_123",
        status: "queued",
        model: "agnes-video-v2.0",
        raw: { progress: 0 },
      })
      .mockResolvedValueOnce({
        ok: true,
        taskId: "task_123",
        videoId: "video_123",
        status: "completed",
        model: "agnes-video-v2.0",
        videoUrl: "https://cdn.agnes.example/generated.mp4",
        seconds: 5,
        raw: {},
      });
    vi.useFakeTimers();

    const resultPromise = provider.generate({
      prompt: "A long-running queued video",
      model: "agnes-video/agnes-video-v2.0",
      aspectRatio: "16:9",
      resolution: "720p",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(videoGetMock).toHaveBeenNthCalledWith(1, "task_123", {
      timeoutMs: 30_000,
    });
    expect(videoGetMock).toHaveBeenNthCalledWith(2, "video_123", {
      timeoutMs: 30_000,
    });
    expect(result.url).toBe("https://cdn.agnes.example/generated.mp4");
    vi.useRealTimers();
  });

  it("keeps legacy task_id polling compatible when resuming old Agnes jobs", async () => {
    const provider = new AgnesVideoProvider(
      "agnes-test-key",
      "https://agnes.example/v1",
    );

    const result = await provider.resume("task_legacy_123", {
      prompt: "Resume an older queued Agnes video",
      model: "agnes-video/agnes-video-v2.0",
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(videoGetMock).toHaveBeenCalledWith("task_legacy_123", {
      timeoutMs: 30_000,
    });
    expect(result.url).toBe("https://cdn.agnes.example/generated.mp4");
  });

  it("reports video_id through Agnes task metadata for persisted recovery", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");
    const onRemoteTaskCreated = vi.fn();
    const onRemoteTaskStatus = vi.fn();

    await provider.generate({
      prompt: "Track the preferred Agnes video poll id",
      model: "agnes-video/agnes-video-v2.0",
      aspectRatio: "16:9",
      resolution: "720p",
      metadata: {
        onRemoteTaskCreated,
        onRemoteTaskStatus,
      },
    });

    expect(onRemoteTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "agnes-video",
        taskId: "task_123",
        videoId: "video_123",
        status: "queued",
      }),
    );
    expect(onRemoteTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "agnes-video",
        taskId: "video_123",
        videoId: "video_123",
        status: "completed",
      }),
    );
  });

  it("reports provider failures from Agnes task polling", async () => {
    const provider = new AgnesVideoProvider("agnes-test-key");
    videoGetMock.mockResolvedValueOnce({
      ok: true,
      taskId: "task_123",
      status: "failed",
      model: "agnes-video-v2.0",
      error: {
        message: "Remote generation failed.",
      },
      raw: {},
    });

    await expect(
      provider.generate({
        prompt: "A long-running queued video",
        model: "agnes-video/agnes-video-v2.0",
        aspectRatio: "16:9",
        resolution: "720p",
      }),
    ).rejects.toMatchObject({
      code: "api_error",
      message: "Remote generation failed.",
      provider: "agnes-video",
    });
  });
});
