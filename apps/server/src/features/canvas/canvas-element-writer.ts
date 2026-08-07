import type { CanvasContent } from "@aimc/shared";

export type CanvasClient = {
  from(table: "canvases"): {
    select(columns: string): unknown;
  };
};

export type Placement = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type CanvasElement = Record<string, unknown>;

const AUTO_PLACEMENT_GAP = 40;
const GENERATOR_STROKE = "#D1D5DB";
const GENERATOR_BACKGROUND = "#F3F4F6";
const GENERATOR_RATIO_DIMENSIONS: Record<
  string,
  { height: number; width: number }
> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};
const DEFAULT_VIEWPORT = {
  height: 720,
  scrollX: 0,
  scrollY: 0,
  width: 1280,
  zoom: 1,
};

export async function insertImageElement(
  client: CanvasClient,
  input: {
    assetId?: string;
    canvasId: string;
    height: number;
    mimeType: string;
    objectPath: string;
    signedUrl?: string;
    title?: string;
    width: number;
  },
  placement?: Placement,
): Promise<{ elementId: string }> {
  const content = await readCanvasContent(client, input.canvasId);
  const elements = [...(content.elements ?? [])];
  const files = { ...(content.files ?? {}) };
  const display =
    placement ??
    autoPlacement(
      elements,
      scaleToFit(input.width, input.height, 600),
      content.appState,
    );
  const fileId = generateId();
  const elementId = generateId();
  const storageUrl = input.assetId
    ? `/local-assets/${input.assetId}`
    : (input.signedUrl ?? input.objectPath);

  files[fileId] = {
    id: fileId,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    mimeType: input.mimeType,
    created: Date.now(),
    storageUrl,
    objectPath: input.objectPath,
  };

  elements.push({
    ...createElementBase(elementId),
    type: "image",
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      source: "generated",
      ...(input.assetId ? { assetId: input.assetId } : {}),
      storageUrl,
      objectPath: input.objectPath,
      ...(input.title ? { title: input.title } : {}),
    },
  });

  await writeCanvasContent(client, input.canvasId, {
    ...content,
    elements,
    files,
  });

  return { elementId };
}

export async function completeImageGenerationNode(
  client: CanvasClient,
  input: {
    assetId?: string;
    canvasId: string;
    elementId?: string;
    height: number;
    jobId: string;
    mimeType: string;
    objectPath?: string;
    signedUrl: string;
    title?: string;
    width: number;
  },
): Promise<{ elementId: string }> {
  const content = await readCanvasContent(client, input.canvasId);
  const elements = [...(content.elements ?? [])];
  const files = { ...(content.files ?? {}) };
  const storageUrl = input.assetId
    ? `/local-assets/${input.assetId}`
    : input.signedUrl;

  const existingImage = elements.find(
    (el) =>
      !el.isDeleted &&
      el.type === "image" &&
      input.assetId &&
      recordValue(el.customData)?.assetId === input.assetId,
  );
  if (existingImage?.id && typeof existingImage.id === "string") {
    return { elementId: existingImage.id };
  }

  const generatorIndex = elements.findIndex((el) => {
    const customData = recordValue(el.customData);
    if (!customData) return false;
    if (customData.type !== "image-generator") return false;
    if (customData.jobId !== input.jobId) return false;
    return input.elementId ? el.id === input.elementId : true;
  });

  const generator = generatorIndex >= 0 ? elements[generatorIndex] : undefined;
  const scaled = scaleToFit(input.width, input.height, 600);
  const display = generator
    ? {
        x: finiteNumber(generator.x) ?? 0,
        y: finiteNumber(generator.y) ?? 0,
        width: finiteNumber(generator.width) ?? scaled.width,
        height: finiteNumber(generator.height) ?? scaled.height,
      }
    : autoPlacement(elements, scaled, content.appState);
  const elementId =
    generator && typeof generator.id === "string" ? generator.id : generateId();
  const fileId = generateId();

  files[fileId] = {
    id: fileId,
    ...(input.assetId ? { assetId: input.assetId } : {}),
    mimeType: input.mimeType,
    created: Date.now(),
    storageUrl,
    objectPath: input.objectPath ?? storageUrl,
  };

  const imageElement = {
    ...createElementBase(elementId),
    type: "image",
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      source: "generated",
      jobId: input.jobId,
      ...(input.assetId ? { assetId: input.assetId } : {}),
      storageUrl,
      objectPath: input.objectPath ?? storageUrl,
      ...(input.title ? { title: input.title } : {}),
    },
  };

  if (generatorIndex >= 0) {
    elements[generatorIndex] = imageElement;
  } else {
    elements.push(imageElement);
  }

  await writeCanvasContent(client, input.canvasId, {
    ...content,
    elements,
    files,
  });

  return { elementId };
}

export async function insertVideoElement(
  client: CanvasClient,
  input: {
    assetId?: string;
    canvasId: string;
    durationSeconds?: number;
    height: number;
    mimeType: string;
    model?: string;
    prompt: string;
    aspectRatio?: string;
    resolution?: string;
    signedUrl: string;
    title?: string;
    width: number;
  },
  placement?: Placement,
): Promise<{ elementId: string }> {
  const content = await readCanvasContent(client, input.canvasId);
  const elements = [...(content.elements ?? [])];
  const display =
    placement ??
    autoPlacement(
      elements,
      scaleToFit(input.width, input.height, 640),
      content.appState,
    );
  const elementId = generateId();
  const videoUrl = input.assetId
    ? `/local-assets/${input.assetId}`
    : input.signedUrl;

  elements.push({
    ...createElementBase(elementId),
    type: "rectangle",
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    strokeColor: "#111827",
    backgroundColor: "#000000",
    fillStyle: "solid",
    roughness: 0,
    link: null,
    customData: {
      isVideo: true,
      ...(input.assetId ? { assetId: input.assetId } : {}),
      mimeType: input.mimeType,
      prompt: input.prompt,
      videoUrl,
      ...(input.model ? { model: input.model } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.durationSeconds != null
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
  });

  await writeCanvasContent(client, input.canvasId, {
    ...content,
    elements,
  });

  return { elementId };
}

export async function completeVideoGenerationNode(
  client: CanvasClient,
  input: {
    assetId?: string;
    aspectRatio?: string;
    canvasId: string;
    durationSeconds?: number;
    elementId?: string;
    height: number;
    jobId: string;
    mimeType: string;
    model?: string;
    prompt: string;
    resolution?: string;
    signedUrl: string;
    title?: string;
    width: number;
  },
): Promise<{ elementId: string }> {
  const content = await readCanvasContent(client, input.canvasId);
  const elements = [...(content.elements ?? [])];
  const videoUrl = input.assetId
    ? `/local-assets/${input.assetId}`
    : input.signedUrl;

  const existingVideo = elements.find(
    (el) =>
      !el.isDeleted &&
      el.type === "rectangle" &&
      input.assetId &&
      recordValue(el.customData)?.assetId === input.assetId,
  );
  if (existingVideo?.id && typeof existingVideo.id === "string") {
    return { elementId: existingVideo.id };
  }

  const generatorIndex = elements.findIndex((el) => {
    const customData = recordValue(el.customData);
    if (!customData || customData.type !== "video-generator") return false;
    if (customData.jobId !== input.jobId) return false;
    return input.elementId ? el.id === input.elementId : true;
  });
  const generator = generatorIndex >= 0 ? elements[generatorIndex] : undefined;
  const scaled = scaleToFit(input.width, input.height, 640);
  const display = generator
    ? {
        x: finiteNumber(generator.x) ?? 0,
        y: finiteNumber(generator.y) ?? 0,
        width: finiteNumber(generator.width) ?? scaled.width,
        height: finiteNumber(generator.height) ?? scaled.height,
      }
    : autoPlacement(elements, scaled, content.appState);
  const elementId =
    generator && typeof generator.id === "string" ? generator.id : generateId();
  const videoElement = {
    ...createElementBase(elementId),
    type: "rectangle",
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    strokeColor: "#111827",
    backgroundColor: "#000000",
    fillStyle: "solid",
    roughness: 0,
    link: null,
    customData: {
      isVideo: true,
      source: "generated",
      jobId: input.jobId,
      ...(input.assetId ? { assetId: input.assetId } : {}),
      mimeType: input.mimeType,
      prompt: input.prompt,
      videoUrl,
      ...(input.model ? { model: input.model } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.durationSeconds != null
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
  };

  if (generatorIndex >= 0) {
    elements[generatorIndex] = videoElement;
  } else {
    elements.push(videoElement);
  }
  await writeCanvasContent(client, input.canvasId, { ...content, elements });
  return { elementId };
}

export async function insertImageGenerationNode(
  client: CanvasClient,
  input: {
    aspectRatio: string;
    canvasId: string;
    inputImages?: string[];
    jobId: string;
    model: string;
    prompt: string;
    quality?: string;
    runId?: string;
    title?: string;
  },
  placement?: Placement,
): Promise<{ elementId: string }> {
  return insertGenerationNode(
    client,
    input.canvasId,
    {
      type: "image-generator",
      status: "generating",
      prompt: input.prompt,
      model: input.model,
      aspectRatio: input.aspectRatio,
      quality: input.quality ?? "hd",
      jobId: input.jobId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      ...(input.title ? { title: input.title } : {}),
    },
    input.aspectRatio,
    placement,
  );
}

export async function insertVideoGenerationNode(
  client: CanvasClient,
  input: {
    aspectRatio: string;
    canvasId: string;
    duration?: number;
    inputImages?: string[];
    jobId: string;
    model: string;
    prompt: string;
    resolution?: string;
    runId?: string;
    title?: string;
  },
  placement?: Placement,
): Promise<{ elementId: string }> {
  return insertGenerationNode(
    client,
    input.canvasId,
    {
      type: "video-generator",
      status: "generating",
      prompt: input.prompt,
      model: input.model,
      aspectRatio: input.aspectRatio,
      duration: input.duration ?? 5,
      resolution: input.resolution ?? "720p",
      jobId: input.jobId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      ...(input.title ? { title: input.title } : {}),
    },
    input.aspectRatio,
    placement,
  );
}

export async function createCanvasAutoPlacementSequence(
  client: CanvasClient,
  canvasId: string,
): Promise<{ reserve(size: Pick<Placement, "height" | "width">): Placement }> {
  const content = await readCanvasContent(client, canvasId);
  const sourceElements = [...(content.elements ?? [])];
  const reservedElements: CanvasElement[] = [];

  return {
    reserve(size) {
      const display = autoPlacement(
        [...sourceElements, ...reservedElements],
        { x: 0, y: 0, width: size.width, height: size.height },
        content.appState,
      );
      reservedElements.push({
        isDeleted: false,
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
      });
      return display;
    },
  };
}

async function insertGenerationNode(
  client: CanvasClient,
  canvasId: string,
  customData: Record<string, unknown>,
  aspectRatio: string,
  placement?: Placement,
): Promise<{ elementId: string }> {
  const content = await readCanvasContent(client, canvasId);
  const elements = [...(content.elements ?? [])];
  const display =
    placement ??
    autoPlacement(
      elements,
      getGeneratorDisplaySize(aspectRatio),
      content.appState,
    );
  const elementId = generateId();

  elements.push({
    ...createElementBase(elementId),
    type: "rectangle",
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    strokeColor: GENERATOR_STROKE,
    backgroundColor: GENERATOR_BACKGROUND,
    roundness: { type: 3 },
    roughness: 0,
    customData,
  });

  await writeCanvasContent(client, canvasId, {
    ...content,
    elements,
  });

  return { elementId };
}

async function readCanvasContent(
  client: CanvasClient,
  canvasId: string,
): Promise<CanvasContent> {
  const query = client.from("canvases").select("content") as {
    eq(
      column: string,
      value: string,
    ): {
      single(): Promise<{
        data: { content?: CanvasContent } | null;
        error: { message: string } | null;
      }>;
    };
  };
  const { data, error } = await query.eq("id", canvasId).single();
  if (error || !data?.content) {
    throw new Error(error?.message ?? "Canvas not found.");
  }
  return {
    elements: data.content.elements ?? [],
    appState: data.content.appState ?? {},
    files: data.content.files ?? {},
  };
}

async function writeCanvasContent(
  client: CanvasClient,
  canvasId: string,
  content: CanvasContent,
) {
  const query = client.from("canvases") as unknown as {
    update(payload: { content: CanvasContent }): {
      eq(
        column: string,
        value: string,
      ): Promise<{
        error: { message: string } | null;
      }>;
    };
  };
  const { error } = await query.update({ content }).eq("id", canvasId);
  if (error) {
    throw new Error(`Failed to save canvas: ${error.message}`);
  }
}

function createElementBase(id: string): CanvasElement {
  return {
    id,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: null,
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function scaleToFit(width: number, height: number, maxSize: number): Placement {
  if (width <= maxSize && height <= maxSize) {
    return { x: 0, y: 0, width, height };
  }
  const ratio = Math.min(maxSize / width, maxSize / height);
  return {
    x: 0,
    y: 0,
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

function getGeneratorDisplaySize(aspectRatio: string): Placement {
  const fallback = GENERATOR_RATIO_DIMENSIONS["1:1"];
  if (!fallback) {
    throw new Error("Missing default generator aspect ratio.");
  }
  const dimensions = GENERATOR_RATIO_DIMENSIONS[aspectRatio] ?? fallback;
  return scaleToFit(dimensions.width, dimensions.height, 400);
}

function autoPlacement(
  elements: CanvasElement[],
  size: Placement,
  appState?: Record<string, unknown>,
): Placement {
  const active = elements.filter((el) => !el.isDeleted);
  if (active.length === 0) {
    return centerInViewport(size, appState) ?? size;
  }

  let maxRight = Number.NEGATIVE_INFINITY;
  let centerY = 0;
  for (const el of active) {
    const right = numberOrZero(el.x) + numberOrZero(el.width);
    if (right > maxRight) {
      maxRight = right;
      centerY = numberOrZero(el.y) + numberOrZero(el.height) / 2;
    }
  }

  return {
    ...size,
    x: maxRight + AUTO_PLACEMENT_GAP,
    y: centerY - size.height / 2,
  };
}

function centerInViewport(
  size: Placement,
  appState?: Record<string, unknown>,
): Placement | null {
  const width = finiteNumber(appState?.width) ?? DEFAULT_VIEWPORT.width;
  const height = finiteNumber(appState?.height) ?? DEFAULT_VIEWPORT.height;

  const zoomRecord =
    appState?.zoom && typeof appState.zoom === "object"
      ? (appState.zoom as Record<string, unknown>)
      : undefined;
  const zoom = finiteNumber(zoomRecord?.value) ?? DEFAULT_VIEWPORT.zoom;
  const scrollX = finiteNumber(appState?.scrollX) ?? DEFAULT_VIEWPORT.scrollX;
  const scrollY = finiteNumber(appState?.scrollY) ?? DEFAULT_VIEWPORT.scrollY;

  return {
    ...size,
    x: -scrollX + width / (2 * zoom) - size.width / 2,
    y: -scrollY + height / (2 * zoom) - size.height / 2,
  };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}
