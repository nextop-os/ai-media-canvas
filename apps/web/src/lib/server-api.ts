import type {
  AssetSignedUrlResponse,
  CanvasDetail,
  ChatMessageCreateRequest,
  GenerationModelSchema,
  JobResponse,
  ManagedFileAssetMetadata,
  MessageCreateResponse,
  MessageListResponse,
  ModelListResponse,
  ProfileUpdateResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectDetailResponse,
  ProjectListResponse,
  ProjectUpdateRequest,
  SessionCreateResponse,
  SessionListResponse,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillImportRequest,
  SkillListResponse,
  SkillToggleRequest,
  StreamEvent,
  UploadResponse,
  ViewerResponse,
  WorkspaceSettingsResponse,
  WorkspaceSettingsUpdateRequest,
} from "@aimc/shared";

import { ApiApplicationError } from "./api-errors";
import { dedupeRequest } from "./dedupe-request";
import { getServerBaseUrl } from "./env";
import { generationJobService } from "./generation-job-service";
import {
  type UploadAppAssetOptions,
  hasTuttiFileUploadBridge,
  uploadTuttiAppAsset,
} from "./tutti-file-upload";

export { ApiApplicationError } from "./api-errors";

// --- Local app API ---

async function handleErrorResponse(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const message = body?.error?.message ?? "Request failed";
  throw new ApiApplicationError(code, message);
}

export async function fetchViewer(): Promise<ViewerResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ViewerResponse;
}

export async function fetchProjects(): Promise<ProjectListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectListResponse;
}

export async function createProject(
  data: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectCreateResponse;
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchProject(
  projectId: string,
): Promise<ProjectDetailResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectDetailResponse;
}

export async function updateProject(
  projectId: string,
  data: ProjectUpdateRequest,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas API ---

export async function fetchCanvas(
  canvasId: string,
): Promise<{ canvas: CanvasDetail }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { canvas: CanvasDetail };
}

export async function saveCanvas(
  canvasId: string,
  content: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  },
  options: { baseRevision?: number } = {},
): Promise<{ revision: number }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        ...(options.baseRevision === undefined
          ? {}
          : { baseRevision: options.baseRevision }),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { revision: number };
}

export async function uploadThumbnail(
  projectId: string,
  blob: Blob,
): Promise<void> {
  const formData = new FormData();
  formData.append("file", blob, "thumbnail.webp");
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}/thumbnail`,
    {
      method: "PUT",
      body: formData,
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Settings API ---

export async function updateProfile(data: {
  displayName: string;
}): Promise<ProfileUpdateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProfileUpdateResponse;
}

export async function fetchWorkspaceSettings(): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export async function updateWorkspaceSettings(
  data: WorkspaceSettingsUpdateRequest,
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export type FetchModelsOptions = {
  refresh?: boolean;
};

type ModelFlight = {
  generation: number;
  promise: Promise<ModelListResponse>;
};

const modelFlights = new Map<"normal" | "refresh", ModelFlight>();
const activeModelGenerations = new Set<number>();
let modelRequestGeneration = 0;
let latestModelFlight: ModelFlight | undefined;

export async function fetchModels(
  options: FetchModelsOptions = {},
): Promise<ModelListResponse> {
  const mode = options.refresh ? "refresh" : "normal";
  const existing =
    mode === "normal"
      ? (modelFlights.get("refresh") ?? modelFlights.get(mode))
      : modelFlights.get(mode);
  if (existing) return existing.promise;
  const generation = ++modelRequestGeneration;
  activeModelGenerations.add(generation);
  const url = `${getServerBaseUrl()}/api/models${
    options.refresh ? "?refresh=1" : ""
  }`;
  const promise = (async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }
    const result = (await response.json()) as ModelListResponse;
    const newer = latestModelFlight;
    if (newer && generation < newer.generation) {
      return await newer.promise.catch(() => result);
    }
    return result;
  })();
  const flight = { generation, promise };
  latestModelFlight = flight;
  modelFlights.set(mode, flight);
  void promise
    .finally(() => {
      if (modelFlights.get(mode) === flight) modelFlights.delete(mode);
      activeModelGenerations.delete(generation);
      if (activeModelGenerations.size === 0) {
        latestModelFlight = undefined;
      }
    })
    .catch(() => {});
  return promise;
}

// --- Chat Session API ---

export function fetchSessions(canvasId: string): Promise<SessionListResponse> {
  return dedupeRequest(`sessions:${canvasId}`, async () => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
    );
    if (!response.ok) return handleErrorResponse(response);
    return (await response.json()) as SessionListResponse;
  });
}

export async function createSession(
  canvasId: string,
  title?: string,
): Promise<SessionCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SessionCreateResponse;
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchMessages(
  sessionId: string,
): Promise<MessageListResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageListResponse;
}

export async function saveMessage(
  sessionId: string,
  data: ChatMessageCreateRequest,
): Promise<MessageCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageCreateResponse;
}

export type RunEventsResponse = {
  done: boolean;
  events: Array<{
    event: StreamEvent;
    eventId: string;
    seq: number;
  }>;
  nextCursor: number;
};

export async function fetchRunEvents(
  runId: string,
  cursor = 0,
): Promise<RunEventsResponse> {
  const params = new URLSearchParams();
  if (cursor > 0) {
    params.set("cursor", String(cursor));
  }
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/runs/${runId}/events${params.size > 0 ? `?${params.toString()}` : ""}`,
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as RunEventsResponse;
}

// --- Upload API ---

export type UploadFileOptions = Pick<
  UploadAppAssetOptions,
  "onProgress" | "signal"
>;

export async function uploadFile(
  file: File,
  projectId?: string,
  options: UploadFileOptions = {},
): Promise<UploadResponse> {
  if (hasTuttiFileUploadBridge()) {
    const uploaded = await uploadTuttiAppAsset(file, {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const response = await createManagedFileAsset(
      uploaded,
      projectId,
      options.signal,
    );
    return response;
  }

  const formData = new FormData();
  formData.append("file", file);
  if (projectId) {
    formData.append("projectId", projectId);
  }

  const response = await fetch(`${getServerBaseUrl()}/api/uploads`, {
    method: "POST",
    body: formData,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

async function createManagedFileAsset(
  file: ManagedFileAssetMetadata,
  projectId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<UploadResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/managed-file`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file,
        ...(projectId ? { projectId } : {}),
      }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

export async function getAssetUrl(
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/${assetId}/url`,
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AssetSignedUrlResponse;
}

export async function deleteAsset(assetId: string): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/uploads/${assetId}`, {
    method: "DELETE",
  });
  if (!response.ok) return handleErrorResponse(response);
}

// --- Skills API ---

export async function fetchInstalledSkills(): Promise<SkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillListResponse;
}

export async function fetchSkillCatalog(): Promise<SkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/catalog`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillListResponse;
}

export async function fetchSkillDetail(
  skillId: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${skillId}`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function createSkill(
  data: SkillCreateRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function importSkill(
  data: SkillImportRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function installSkill(
  skillId: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/catalog/${skillId}/install`,
    { method: "POST" },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function toggleSkill(
  skillId: string,
  data: SkillToggleRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${skillId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function uninstallSkill(skillId: string): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${skillId}`, {
    method: "DELETE",
  });
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas-Native Generation API ---

export type GenerateImageResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
};

export type ImageModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
  schema?: GenerationModelSchema;
};

export async function fetchImageModels(): Promise<{
  models: ImageModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/image-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch image models: ${response.status}`);
  }
  return (await response.json()) as { models: ImageModelInfo[] };
}

export type VideoModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  accessible?: boolean;
  capabilities?: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits?: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  schema?: GenerationModelSchema;
};

export async function fetchVideoModels(): Promise<{
  models: VideoModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/video-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch video models: ${response.status}`);
  }
  return (await response.json()) as { models: VideoModelInfo[] };
}

export async function generateImageDirect(
  prompt: string,
  options?: {
    model?: string;
    aspectRatio?: string;
    quality?: string;
    inputImages?: string[];
    size?: string;
    seed?: number;
    projectId?: string;
    canvasId?: string;
    onJobCreated?: (jobId: string) => void;
    signal?: AbortSignal;
  },
): Promise<GenerateImageResponse> {
  const { job } = await createGenerationJob(
    "/api/jobs/image-generation",
    {
      prompt,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
      ...(options?.quality ? { quality: options.quality } : {}),
      ...(options?.inputImages?.length
        ? { input_images: options.inputImages }
        : {}),
      ...(options?.size ? { size: options.size } : {}),
      ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      ...(options?.projectId ? { project_id: options.projectId } : {}),
      ...(options?.canvasId ? { canvas_id: options.canvasId } : {}),
    },
    options?.signal,
  );
  options?.onJobCreated?.(job.id);
  const result = await generationJobService.watch(job.id, {
    jobType: "image_generation",
    ...(options?.signal ? { signal: options.signal } : {}),
  }).promise;
  return {
    url: readStringResult(result, "signed_url"),
    assetId: readStringResult(result, "asset_id"),
    prompt,
    mimeType: readStringResult(result, "mime_type"),
    width: readNumberResult(result, "width"),
    height: readNumberResult(result, "height"),
  };
}

export type GenerateVideoResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
};

export async function generateVideoDirect(
  prompt: string,
  options?: {
    model?: string;
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    inputImages?: string[];
    videoMode?: "multivideo" | "keyframes" | "reference";
    enableAudio?: boolean;
    seed?: number;
    negativePrompt?: string;
    frameRate?: number;
    numFrames?: number;
    projectId?: string;
    canvasId?: string;
    onJobCreated?: (jobId: string) => void;
    signal?: AbortSignal;
  },
): Promise<GenerateVideoResponse> {
  const { job } = await createGenerationJob(
    "/api/jobs/video-generation",
    {
      prompt,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.resolution ? { resolution: options.resolution } : {}),
      ...(options?.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
      ...(options?.inputImages?.length
        ? { input_images: options.inputImages }
        : {}),
      ...(options?.videoMode ? { video_mode: options.videoMode } : {}),
      ...(options?.enableAudio !== undefined
        ? { enable_audio: options.enableAudio }
        : {}),
      ...(options?.seed !== undefined ? { seed: options.seed } : {}),
      ...(options?.negativePrompt
        ? { negative_prompt: options.negativePrompt }
        : {}),
      ...(options?.frameRate !== undefined
        ? { frame_rate: options.frameRate }
        : {}),
      ...(options?.numFrames !== undefined
        ? { num_frames: options.numFrames }
        : {}),
      ...(options?.projectId ? { project_id: options.projectId } : {}),
      ...(options?.canvasId ? { canvas_id: options.canvasId } : {}),
    },
    options?.signal,
  );
  options?.onJobCreated?.(job.id);
  const result = await generationJobService.watch(job.id, {
    jobType: "video_generation",
    ...(options?.signal ? { signal: options.signal } : {}),
  }).promise;
  const model =
    typeof result.model === "string" ? result.model : options?.model;
  const aspectRatio =
    typeof result.aspectRatio === "string"
      ? result.aspectRatio
      : typeof result.aspect_ratio === "string"
        ? result.aspect_ratio
        : options?.aspectRatio;
  const resolution =
    typeof result.resolution === "string"
      ? result.resolution
      : options?.resolution;
  return {
    url: readStringResult(result, "signed_url"),
    assetId: readStringResult(result, "asset_id"),
    prompt,
    mimeType: readStringResult(result, "mime_type"),
    width: readNumberResult(result, "width"),
    height: readNumberResult(result, "height"),
    durationSeconds: readNumberResult(result, "duration_seconds"),
    ...(model ? { model } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

export async function fetchGenerationJob(jobId: string): Promise<JobResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/${jobId}`);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

async function createGenerationJob(
  endpoint: "/api/jobs/image-generation" | "/api/jobs/video-generation",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JobResponse> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const response = await fetch(`${getServerBaseUrl()}${endpoint}`, init);
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

function readStringResult(
  result: Record<string, unknown>,
  key: string,
): string {
  const value = result[key];
  if (typeof value !== "string") {
    throw new ApiApplicationError(
      "generation_failed",
      `Generation result is missing ${key}.`,
    );
  }
  return value;
}

function readNumberResult(
  result: Record<string, unknown>,
  key: string,
): number {
  const value = result[key];
  if (typeof value !== "number") {
    throw new ApiApplicationError(
      "generation_failed",
      `Generation result is missing ${key}.`,
    );
  }
  return value;
}
