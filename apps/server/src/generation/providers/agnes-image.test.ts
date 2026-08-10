import { beforeEach, describe, expect, it, vi } from "vitest";

const { imageGenerateMock, createAgnesClientMock } = vi.hoisted(() => {
  const imageGenerateMock = vi.fn();
  const createAgnesClientMock = vi.fn(() => ({
    image: {
      generate: imageGenerateMock,
    },
  }));
  return { imageGenerateMock, createAgnesClientMock };
});

vi.mock("agnes-ai-cli", () => ({
  createAgnesClient: createAgnesClientMock,
}));

import { AgnesImageProvider } from "./agnes-image.js";
import { DEFAULT_AGNES_TEMPORARY_MEDIA_PROVIDER_ORDER } from "./agnes-media.js";

describe("AgnesImageProvider", () => {
  beforeEach(() => {
    imageGenerateMock.mockReset();
    createAgnesClientMock.mockClear();
    imageGenerateMock.mockResolvedValue({
      ok: true,
      model: "agnes-image-2.1-flash",
      url: "https://cdn.agnes.example/generated.png",
      raw: {},
    });
  });

  it("maps prompt-only generation to Agnes text2img mode", async () => {
    const provider = new AgnesImageProvider(
      "agnes-test-key",
      "https://agnes.example/v1",
    );

    const result = await provider.generate({
      prompt: "A product hero shot",
      model: "agnes-image/agnes-image-2.1-flash",
      aspectRatio: "1:1",
    });

    expect(createAgnesClientMock).toHaveBeenCalledWith({
      apiKey: "agnes-test-key",
      baseUrl: "https://agnes.example/v1",
      temporaryMediaProviderOrder: DEFAULT_AGNES_TEMPORARY_MEDIA_PROVIDER_ORDER,
    });
    expect(imageGenerateMock).toHaveBeenCalledWith({
      mode: "text2img",
      model: "agnes-image-2.1-flash",
      prompt: "A product hero shot",
      size: "1024x1024",
    });
    expect(result).toMatchObject({
      url: "https://cdn.agnes.example/generated.png",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
  });

  it("lets callers override the Agnes temporary media provider order", () => {
    new AgnesImageProvider("agnes-test-key", undefined, {
      temporaryMediaProviderOrder: ["tmpfiles", "uguu"],
    });

    expect(createAgnesClientMock).toHaveBeenCalledWith({
      apiKey: "agnes-test-key",
      temporaryMediaProviderOrder: ["tmpfiles", "uguu"],
    });
  });

  it("forwards Agnes phase-2 image controls", async () => {
    const provider = new AgnesImageProvider("agnes-test-key");

    const result = await provider.generate({
      prompt: "Generate a poster variant",
      model: "agnes-image/agnes-image-2.1-flash",
      aspectRatio: "1:1",
      size: "1536x1024",
      seed: 42,
    });

    expect(imageGenerateMock).toHaveBeenCalledWith({
      mode: "text2img",
      model: "agnes-image-2.1-flash",
      prompt: "Generate a poster variant",
      size: "1536x1024",
      seed: 42,
    });
    expect(result).toMatchObject({
      width: 1536,
      height: 1024,
    });
  });

  it("maps one input image to Agnes img2img mode", async () => {
    const provider = new AgnesImageProvider("agnes-test-key");

    await provider.generate({
      prompt: "Turn this into a poster",
      model: "agnes-image/agnes-image-2.0-flash",
      aspectRatio: "4:3",
      inputImages: ["data:image/png;base64,AAAA"],
    });

    expect(imageGenerateMock).toHaveBeenCalledWith({
      mode: "img2img",
      model: "agnes-image-2.0-flash",
      image: "data:image/png;base64,AAAA",
      prompt: "Turn this into a poster",
      size: "1024x768",
      ttl: "1h",
    });
  });

  it("maps multiple input images to Agnes compose mode", async () => {
    const provider = new AgnesImageProvider("agnes-test-key");

    await provider.generate({
      prompt: "Compose a campaign visual",
      model: "agnes-image/agnes-image-2.1-flash",
      aspectRatio: "16:9",
      inputImages: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
    });

    expect(imageGenerateMock).toHaveBeenCalledWith({
      mode: "compose",
      model: "agnes-image-2.1-flash",
      images: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
      prompt: "Compose a campaign visual",
      size: "1024x576",
      ttl: "1h",
    });
  });

  it("times out if Agnes image task creation never returns", async () => {
    const provider = new AgnesImageProvider("agnes-test-key");
    imageGenerateMock.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();

    try {
      const resultPromise = provider.generate({
        prompt: "A stuck Agnes image request",
        model: "agnes-image/agnes-image-2.1-flash",
        aspectRatio: "1:1",
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "timeout",
        message: "Agnes image task creation timed out after 120000ms.",
        provider: "agnes-image",
      });

      await vi.advanceTimersByTimeAsync(120_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves Agnes validation details and does not retry request 400s", async () => {
    const provider = new AgnesImageProvider("agnes-test-key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(
      new Error("Agnes image request failed with HTTP 400."),
      {
        name: "AgnesCliError",
        code: "AGNES_REQUEST_FAILED",
        details: { error: { message: "extra_body.image must be an array" } },
      },
    );
    imageGenerateMock.mockRejectedValueOnce(error);

    try {
      await expect(
        provider.generate({
          prompt: "Edit this image",
          model: "agnes-image/agnes-image-2.1-flash",
          aspectRatio: "1:1",
          inputImages: ["data:image/png;base64,AAAA"],
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "Agnes image request failed with HTTP 400.",
        provider: "agnes-image",
      });
      expect(warn).toHaveBeenCalledWith(
        "[agnes-image] Agnes request failed",
        {
          code: "AGNES_REQUEST_FAILED",
          status: 400,
          details: {
            error: { message: "extra_body.image must be an array" },
          },
        },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
