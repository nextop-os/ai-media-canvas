import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearProviders,
  registerImageProvider,
} from "../../generation/providers/registry.js";
import { runImageGenerate } from "./image-generate.js";

describe("runImageGenerate", () => {
  afterEach(() => {
    clearProviders();
  });

  it("returns a capability card output when image generation has no provider", async () => {
    clearProviders();

    const result = await runImageGenerate({
      title: "Poster",
      prompt: "Generate a poster",
      model: "agnes-image/seedream-v4",
    });

    expect(result.summary).toBe("media_provider_configuration_required");
    expect(result.error).toBe("media_provider_configuration_required");
    expect(result.capabilityRequired).toMatchObject({
      kind: "media_provider_configuration_required",
      capability: "image_generation",
      titleKey: "capabilityRequired.imageTitle",
      descriptionKey: "capabilityRequired.imageDescription",
      action: {
        type: "open_settings",
        tab: "media",
        labelKey: "capabilityRequired.configureMedia",
      },
    });
    expect(JSON.stringify(result.capabilityRequired)).not.toContain("连接");
  });

  it("returns a stable inputImageRef for a completed local image asset", async () => {
    registerImageProvider({
      name: "agnes-image",
      models: [
        {
          id: "agnes-image/agnes-image-2.1-flash",
          displayName: "Agnes Image",
          description: "test image provider",
        },
      ],
      async generate() {
        throw new Error("not used");
      },
    });

    const result = await runImageGenerate(
      {
        title: "Dancer",
        prompt: "Generate a dancer",
        model: "agnes-image/agnes-image-2.1-flash",
      },
      undefined,
      async () => ({
        jobId: "job-1",
        elementId: "canvas-element-1",
        assetId: "asset-1",
        imageUrl: "http://127.0.0.1:3001/local-assets/asset-1",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
      }),
    );

    expect(result).toMatchObject({
      assetId: "asset-1",
      elementId: "canvas-element-1",
      inputImageRef: "/local-assets/asset-1",
    });
  });

  it("resolves a selected local inputImageRef before submitting", async () => {
    registerImageProvider({
      name: "agnes-image",
      models: [
        {
          id: "agnes-image/agnes-image-2.1-flash",
          displayName: "Agnes Image",
          description: "test image provider",
        },
      ],
      async generate() {
        throw new Error("not used");
      },
    });
    const submitImageJob = vi.fn(async () => ({
      jobId: "job-2",
      status: "generating" as const,
    }));

    await runImageGenerate(
      {
        title: "Edit dancer",
        prompt: "Edit the selected dancer",
        model: "agnes-image/agnes-image-2.1-flash",
        inputImages: ["selected-asset"],
      },
      undefined,
      submitImageJob,
      { "selected-asset": "/local-assets/asset-1" },
      async (input) =>
        input === "/local-assets/asset-1"
          ? "data:image/png;base64,AAAA"
          : input,
    );

    expect(submitImageJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: ["data:image/png;base64,AAAA"],
      }),
    );
  });
});
