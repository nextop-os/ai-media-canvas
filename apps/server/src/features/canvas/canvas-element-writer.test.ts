import { describe, expect, it } from "vitest";

import {
  completeImageGenerationNode,
  completeVideoGenerationNode,
  createCanvasAutoPlacementSequence,
  insertImageElement,
  insertImageGenerationNode,
  insertVideoElement,
  insertVideoGenerationNode,
} from "./canvas-element-writer.js";

function createCanvasClient(initialContent: Record<string, unknown>) {
  const state = {
    content: structuredClone(initialContent),
  };

  return {
    state,
    from(table: string) {
      expect(table).toBe("canvases");
      return {
        select(_columns: string) {
          return this;
        },
        eq(_column: string, _value: string) {
          return this;
        },
        async single() {
          return { data: { content: state.content }, error: null };
        },
        update(payload: { content: Record<string, unknown> }) {
          state.content = payload.content;
          return {
            async eq(_column: string, _value: string) {
              return { error: null };
            },
          };
        },
      };
    },
  };
}

describe("canvas element writer", () => {
  it("inserts generated images into canvas content and file metadata", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    const result = await insertImageElement(client, {
      assetId: "image-asset-1",
      canvasId: "canvas-1",
      height: 768,
      mimeType: "image/png",
      objectPath: "generated/image-1.png",
      signedUrl: "http://127.0.0.1:3001/local-assets/image-1",
      title: "Dancing girl",
      width: 1024,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
      files: Record<string, Record<string, unknown>>;
    };
    expect(result.elementId).toBeTypeOf("string");
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: result.elementId,
      type: "image",
      width: 600,
      height: 450,
      customData: {
        assetId: "image-asset-1",
        source: "generated",
        storageUrl: "/local-assets/image-asset-1",
        title: "Dancing girl",
      },
    });
    const fileId = content.elements[0]?.fileId as string;
    expect(content.files[fileId]).toMatchObject({
      id: fileId,
      assetId: "image-asset-1",
      mimeType: "image/png",
      storageUrl: "/local-assets/image-asset-1",
    });
  });

  it("centers the first generated image in the persisted viewport", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {
        scrollX: 0,
        scrollY: 0,
        width: 1280,
        height: 720,
        zoom: { value: 1 },
      },
      files: {},
    });

    await insertImageElement(client, {
      canvasId: "canvas-1",
      height: 768,
      mimeType: "image/png",
      objectPath: "generated/image-1.png",
      width: 1024,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(content.elements[0]).toMatchObject({
      x: 340,
      y: 135,
      width: 600,
      height: 450,
    });
  });

  it("centers the first generated image in a default viewport when no viewport is persisted", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    await insertImageElement(client, {
      canvasId: "canvas-1",
      height: 768,
      mimeType: "image/png",
      objectPath: "generated/image-1.png",
      width: 1024,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(content.elements[0]).toMatchObject({
      x: 340,
      y: 135,
      width: 600,
      height: 450,
    });
  });

  it("reserves automatic placements in request order before images finish", async () => {
    const client = createCanvasClient({
      elements: [
        {
          id: "existing",
          type: "image",
          x: 100,
          y: 100,
          width: 200,
          height: 120,
          isDeleted: false,
        },
      ],
      appState: {},
      files: {},
    });
    const sequence = await createCanvasAutoPlacementSequence(
      client,
      "canvas-1",
    );

    const first = sequence.reserve({ width: 600, height: 338 });
    const second = sequence.reserve({ width: 600, height: 338 });

    expect(first).toMatchObject({
      x: 340,
      y: -9,
      width: 600,
      height: 338,
    });
    expect(second).toMatchObject({
      x: 980,
      y: -9,
      width: 600,
      height: 338,
    });
  });

  it("inserts image generation nodes with job metadata", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    const result = await insertImageGenerationNode(client, {
      aspectRatio: "16:9",
      canvasId: "canvas-1",
      jobId: "job-image-1",
      model: "agnes-image/agnes-image-2.1-flash",
      prompt: "A neon city logo",
      quality: "hd",
      runId: "run-image-1",
      title: "Neon logo",
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(result.elementId).toBeTypeOf("string");
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: result.elementId,
      type: "rectangle",
      width: 400,
      height: 225,
      customData: {
        type: "image-generator",
        status: "generating",
        jobId: "job-image-1",
        prompt: "A neon city logo",
        model: "agnes-image/agnes-image-2.1-flash",
        aspectRatio: "16:9",
        quality: "hd",
        runId: "run-image-1",
      },
    });
  });

  it("completes image generation nodes in place with generated image metadata", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    const pending = await insertImageGenerationNode(client, {
      aspectRatio: "4:3",
      canvasId: "canvas-1",
      jobId: "job-image-1",
      model: "agnes-image/agnes-image-2.1-flash",
      prompt: "A neon city logo",
      quality: "hd",
      title: "Neon logo",
    });

    const completed = await completeImageGenerationNode(client, {
      assetId: "image-asset-1",
      canvasId: "canvas-1",
      elementId: pending.elementId,
      height: 768,
      jobId: "job-image-1",
      mimeType: "image/png",
      objectPath: "generated/image-asset-1.png",
      signedUrl: "http://127.0.0.1:3001/local-assets/image-asset-1",
      title: "Neon logo",
      width: 1024,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
      files: Record<string, Record<string, unknown>>;
    };
    expect(completed.elementId).toBe(pending.elementId);
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: pending.elementId,
      type: "image",
      width: 400,
      height: 300,
      customData: {
        assetId: "image-asset-1",
        jobId: "job-image-1",
        source: "generated",
        storageUrl: "/local-assets/image-asset-1",
        title: "Neon logo",
      },
    });
    const fileId = content.elements[0]?.fileId as string;
    expect(content.files[fileId]).toMatchObject({
      id: fileId,
      assetId: "image-asset-1",
      mimeType: "image/png",
      objectPath: "generated/image-asset-1.png",
      storageUrl: "/local-assets/image-asset-1",
    });
  });

  it("inserts video generation nodes with job metadata", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    const result = await insertVideoGenerationNode(client, {
      aspectRatio: "16:9",
      canvasId: "canvas-1",
      duration: 5,
      jobId: "job-video-1",
      model: "google-official/veo-3.1-generate-preview",
      prompt: "A rotating product video",
      resolution: "720p",
      runId: "run-video-1",
      title: "Product video",
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(result.elementId).toBeTypeOf("string");
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: result.elementId,
      type: "rectangle",
      width: 400,
      height: 225,
      customData: {
        type: "video-generator",
        status: "generating",
        jobId: "job-video-1",
        prompt: "A rotating product video",
        model: "google-official/veo-3.1-generate-preview",
        aspectRatio: "16:9",
        duration: 5,
        resolution: "720p",
        runId: "run-video-1",
      },
    });
  });

  it("completes video generation nodes in place with generated video metadata", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });
    const pending = await insertVideoGenerationNode(client, {
      aspectRatio: "16:9",
      canvasId: "canvas-1",
      duration: 4,
      jobId: "job-video-1",
      model: "agnes-video/agnes-video-v2.0",
      prompt: "A paper boat drifting",
      resolution: "480p",
      title: "Paper boat",
    });

    const completed = await completeVideoGenerationNode(client, {
      assetId: "video-asset-1",
      canvasId: "canvas-1",
      durationSeconds: 4,
      height: 480,
      jobId: "job-video-1",
      mimeType: "video/mp4",
      model: "agnes-video/agnes-video-v2.0",
      prompt: "A paper boat drifting",
      resolution: "480p",
      aspectRatio: "16:9",
      signedUrl: "http://127.0.0.1:3001/local-assets/video-asset-1",
      title: "Paper boat",
      width: 854,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(completed.elementId).toBe(pending.elementId);
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: pending.elementId,
      type: "rectangle",
      width: 400,
      height: 225,
      customData: {
        isVideo: true,
        source: "generated",
        jobId: "job-video-1",
        assetId: "video-asset-1",
        mimeType: "video/mp4",
        videoUrl: "/local-assets/video-asset-1",
        durationSeconds: 4,
      },
    });
  });

  it("inserts generated videos without Excalidraw link chrome", async () => {
    const client = createCanvasClient({
      elements: [],
      appState: {},
      files: {},
    });

    const result = await insertVideoElement(client, {
      assetId: "video-asset-1",
      canvasId: "canvas-1",
      durationSeconds: 5,
      height: 720,
      mimeType: "video/mp4",
      model: "kie/runway",
      prompt: "A spinning product shot",
      aspectRatio: "16:9",
      resolution: "720p",
      signedUrl: "http://127.0.0.1:3001/local-assets/video-1",
      title: "Product video",
      width: 1280,
    });

    const content = client.state.content as {
      elements: Array<Record<string, unknown>>;
    };
    expect(result.elementId).toBeTypeOf("string");
    expect(content.elements).toHaveLength(1);
    expect(content.elements[0]).toMatchObject({
      id: result.elementId,
      type: "rectangle",
      link: null,
      strokeColor: "#111827",
      backgroundColor: "#000000",
      width: 640,
      height: 360,
      customData: {
        assetId: "video-asset-1",
        aspectRatio: "16:9",
        durationSeconds: 5,
        isVideo: true,
        mimeType: "video/mp4",
        model: "kie/runway",
        prompt: "A spinning product shot",
        resolution: "720p",
        title: "Product video",
        videoUrl: "/local-assets/video-asset-1",
      },
    });
  });
});
