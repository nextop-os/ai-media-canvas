// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generationJobService } from "../src/lib/generation-job-service";
import {
  createProject,
  fetchModels,
  fetchProjects,
  fetchViewer,
  fetchWorkspaceSettings,
  generateImageDirect,
  generateVideoDirect,
  updateWorkspaceSettings,
  uploadFile,
} from "../src/lib/server-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("local server API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generationJobService.clearForTest();
    vi.stubEnv("AIMC_SERVER_BASE_URL", "http://localhost:3001");
    (window as Window & { tutti?: unknown }).tutti = undefined;
  });

  afterEach(() => {
    generationJobService.clearForTest();
    vi.useRealTimers();
    (window as Window & { tuttiExternal?: unknown }).tuttiExternal = undefined;
    vi.unstubAllEnvs();
    (window as Window & { tutti?: unknown }).tutti = undefined;
  });

  it("fetchViewer calls the local viewer endpoint and returns the viewer", async () => {
    const viewer = {
      profile: {
        id: "u1",
        email: "a@b.com",
        displayName: "A",
        avatarUrl: null,
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => viewer,
    });

    const result = await fetchViewer();
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/api/viewer");
    expect(result.profile.id).toBe("u1");
  });

  it("createProject sends POST without auth headers and handles 201", async () => {
    const project = {
      project: {
        id: "p1",
        name: "Test",
        slug: "test",
        description: null,
        primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
        createdAt: "2026-03-23T00:00:00Z",
        updatedAt: "2026-03-23T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => project,
    });

    const result = await createProject({ name: "Test" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      },
    );
    expect(result.project.id).toBe("p1");
  });

  it("fetchProjects returns the local project list", async () => {
    const list = { projects: [{ id: "p1", name: "Test", slug: "test" }] };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => list,
    });

    const result = await fetchProjects();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects",
    );
    expect(result.projects).toHaveLength(1);
  });

  it("createProject throws ApiApplicationError with code on 409", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "project_slug_taken", message: "Slug taken." },
      }),
    });

    await expect(createProject({ name: "Dup" })).rejects.toThrow("Slug taken.");
    try {
      await createProject({ name: "Dup" });
    } catch (err) {
      expect((err as { code?: unknown }).code).toBe("project_slug_taken");
    }
  });

  it("fetchViewer surfaces server-side local API errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchViewer()).rejects.toThrow("Bad token.");
  });

  it("fetchProjects surfaces server-side local API errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchProjects()).rejects.toThrow("Bad token.");
  });

  it("fetchWorkspaceSettings reads local provider settings", async () => {
    const payload = {
      settings: {
        defaultModel: "openai:gpt-4.1",
        openAIApiKey: "sk-local-openai",
        openAIApiBase: "http://127.0.0.1:4000/v1",
        anthropicApiKey: "sk-local-anthropic",
        anthropicBaseUrl: "https://api.anthropic.com",
        agnesApiKey: "sk-local-agnes",
        agnesBaseUrl: "https://agnes.example/v1",
        agnesDefaultModel: "agnes:agnes-2.0-flash",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchWorkspaceSettings();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/workspace/settings",
    );
    expect(result.settings.defaultModel).toBe("openai:gpt-4.1");
  });

  it("updateWorkspaceSettings sends the full local settings payload", async () => {
    const payload = {
      settings: {
        defaultModel: "google:gemini-2.5-flash",
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "sk-local-anthropic",
        anthropicBaseUrl: "https://api.anthropic.com",
        agnesApiKey: "sk-local-agnes",
        agnesBaseUrl: "https://agnes.example/v1",
        agnesDefaultModel: "agnes:agnes-2.0-flash",
        googleApiKey: "google-local-key",
        googleVertexProject: "vertex-project",
        googleVertexLocation: "global",
        googleVertexVideoLocation: "us-central1",
        replicateApiToken: "replicate-local-token",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await updateWorkspaceSettings(payload.settings);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/workspace/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.settings),
      },
    );
    expect(result.settings.googleApiKey).toBe("google-local-key");
    expect(result.settings.anthropicApiKey).toBe("sk-local-anthropic");
    expect(result.settings.agnesApiKey).toBe("sk-local-agnes");
  });

  it("fetchModels uses the header-injected server route without JSB payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    });

    await fetchModels();

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/api/models", {
      cache: "no-store",
    });
  });

  it("fetchModels keeps the existing GET path when the managed bridge is unavailable", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    });

    await fetchModels();

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/api/models", {
      cache: "no-store",
    });
  });

  it("fetchModels sends a refresh hint when requested", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    });

    await fetchModels({ refresh: true });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/models?refresh=1",
      {
        cache: "no-store",
      },
    );
  });

  it("fetchModels coalesces concurrent requests within each mode", async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    };
    mockFetch.mockResolvedValue(response);

    await Promise.all([fetchModels(), fetchModels()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    await Promise.all([
      fetchModels({ refresh: true }),
      fetchModels({ refresh: true }),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("lets a normal load join an active authoritative refresh", async () => {
    const refreshResponse = deferred<Response>();
    mockFetch.mockReturnValue(refreshResponse.promise);

    const refresh = fetchModels({ refresh: true });
    const normal = fetchModels();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const payload = {
      models: [{ id: "codex:fresh", name: "Fresh", provider: "codex" }],
    };
    refreshResponse.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(Promise.all([refresh, normal])).resolves.toEqual([
      payload,
      payload,
    ]);
  });

  it("keeps refresh separate and prevents a late normal result from winning", async () => {
    const normalResponse = deferred<Response>();
    const refreshResponse = deferred<Response>();
    mockFetch.mockImplementation((url: string) =>
      url.includes("refresh=1")
        ? refreshResponse.promise
        : normalResponse.promise,
    );

    const normal = fetchModels();
    const refresh = fetchModels({ refresh: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const refreshPayload = {
      models: [{ id: "codex:new", name: "New", provider: "codex" }],
    };
    refreshResponse.resolve(
      new Response(JSON.stringify(refreshPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(refresh).resolves.toEqual(refreshPayload);

    normalResponse.resolve(
      new Response(
        JSON.stringify({
          models: [{ id: "codex:old", name: "Old", provider: "codex" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(normal).resolves.toEqual(refreshPayload);
  });

  it("preserves a successful normal result when a newer refresh fails", async () => {
    const normalResponse = deferred<Response>();
    const refreshResponse = deferred<Response>();
    mockFetch.mockImplementation((url: string) =>
      url.includes("refresh=1")
        ? refreshResponse.promise
        : normalResponse.promise,
    );

    const normal = fetchModels();
    const refresh = fetchModels({ refresh: true });
    const normalPayload = {
      models: [{ id: "codex:cached", name: "Cached", provider: "codex" }],
    };
    normalResponse.resolve(
      new Response(JSON.stringify(normalPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    refreshResponse.resolve(new Response("unavailable", { status: 503 }));

    await expect(refresh).rejects.toThrow("Failed to fetch models: 503");
    await expect(normal).resolves.toEqual(normalPayload);
  });

  it("uploadFile uses the local multipart endpoint outside Tutti", async () => {
    const payload = {
      asset: {
        id: "asset-local-1",
        bucket: "project-assets",
        objectPath: "upload/asset-local-1.png",
        mimeType: "image/png",
        byteSize: 4,
        projectId: "project-1",
        createdAt: "2026-06-24T00:00:00.000Z",
      },
      url: "http://localhost:3001/local-assets/asset-local-1",
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => payload,
    });

    const file = new File(["fake"], "ref.png", { type: "image/png" });
    const result = await uploadFile(file, "project-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/uploads",
    );
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
    expect((init?.body as FormData).get("projectId")).toBe("project-1");
    expect(result).toEqual(payload);
  });

  it("uploadFile uses the multipart endpoint when the Tutti bridge is available", async () => {
    const bridgeUpload = vi.fn(async (_file: Blob, options: unknown) => {
      throw new Error(`Unexpected bridge upload: ${JSON.stringify(options)}`);
    });
    (
      window as Window & {
        tuttiExternal?: {
          files?: { upload?: typeof bridgeUpload };
        };
      }
    ).tuttiExternal = { files: { upload: bridgeUpload } };

    const payload = {
      asset: {
        id: "asset-local-1",
        bucket: "project-assets",
        objectPath: "upload/asset-local-1.png",
        mimeType: "image/png",
        byteSize: 4,
        projectId: "project-1",
        createdAt: "2026-06-24T00:00:00.000Z",
      },
      url: "http://localhost:3001/local-assets/asset-local-1",
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => payload,
    });

    const file = new File(["fake"], "ref.png", { type: "image/png" });
    const result = await uploadFile(file, "project-1");

    expect(bridgeUpload).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/api/uploads",
    );
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
    expect((init?.body as FormData).get("projectId")).toBe("project-1");
    expect(result).toEqual(payload);
  });

  it("generateImageDirect creates an image job and polls for the stored result", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-image-1",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-image-1",
            status: "succeeded",
            result: {
              signed_url: "http://localhost:3001/assets/image.png",
              asset_id: "asset-image-1",
              mime_type: "image/png",
              width: 1024,
              height: 1024,
            },
          },
        }),
      });

    const result = await generateImageDirect("生成一张海报", {
      model: "agnes-image/agnes-image-2.1-flash",
      aspectRatio: "1:1",
      quality: "hd",
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3001/api/jobs/image-generation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "生成一张海报",
          model: "agnes-image/agnes-image-2.1-flash",
          aspect_ratio: "1:1",
          quality: "hd",
        }),
      },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/jobs/job-image-1",
    );
    expect(result).toEqual({
      url: "http://localhost:3001/assets/image.png",
      assetId: "asset-image-1",
      prompt: "生成一张海报",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
  });

  it("generateImageDirect waits the image poll interval before retrying queued jobs", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-image-queued",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-image-queued",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-image-queued",
            status: "succeeded",
            result: {
              signed_url: "http://localhost:3001/assets/image.png",
              asset_id: "asset-image-1",
              mime_type: "image/png",
              width: 1024,
              height: 1024,
            },
          },
        }),
      });

    const resultPromise = generateImageDirect("生成一张海报", {
      model: "agnes-image/agnes-image-2.1-flash",
    });

    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      url: "http://localhost:3001/assets/image.png",
      assetId: "asset-image-1",
      prompt: "生成一张海报",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("generateImageDirect exposes the created job id before waiting for image completion", async () => {
    vi.useFakeTimers();
    const onJobCreated = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-image-resume",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-image-resume",
            status: "queued",
            result: null,
          },
        }),
      });

    const resultPromise = generateImageDirect("生成一张可恢复的图片", {
      model: "agnes-image/agnes-image-2.1-flash",
      onJobCreated,
    });

    await flushPromises();

    expect(onJobCreated).toHaveBeenCalledWith("job-image-resume");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(
      Promise.race([
        resultPromise.then(() => "completed"),
        Promise.resolve("still-waiting"),
      ]),
    ).resolves.toBe("still-waiting");
  });

  it("generateVideoDirect creates a video job and polls for the stored result", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-video-1",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-video-1",
            status: "succeeded",
            result: {
              signed_url: "http://localhost:3001/assets/video.mp4",
              asset_id: "asset-video-1",
              mime_type: "video/mp4",
              width: 1280,
              height: 720,
              duration_seconds: 5,
            },
          },
        }),
      });

    const result = await generateVideoDirect("生成一段产品视频", {
      model: "agnes-video/agnes-video-v2.0",
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      projectId: "project-1",
      canvasId: "canvas-1",
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3001/api/jobs/video-generation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "生成一段产品视频",
          model: "agnes-video/agnes-video-v2.0",
          duration: 5,
          resolution: "720p",
          aspect_ratio: "16:9",
          project_id: "project-1",
          canvas_id: "canvas-1",
        }),
      },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/jobs/job-video-1",
    );
    expect(result).toEqual({
      url: "http://localhost:3001/assets/video.mp4",
      assetId: "asset-video-1",
      prompt: "生成一段产品视频",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5,
      model: "agnes-video/agnes-video-v2.0",
      aspectRatio: "16:9",
      resolution: "720p",
    });
  });

  it("generateVideoDirect waits the slower video poll interval before retrying queued jobs", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-video-queued",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-video-queued",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-video-queued",
            status: "succeeded",
            result: {
              signed_url: "http://localhost:3001/assets/video.mp4",
              asset_id: "asset-video-1",
              mime_type: "video/mp4",
              width: 1280,
              height: 720,
              duration_seconds: 5,
            },
          },
        }),
      });

    const resultPromise = generateVideoDirect("生成一段产品视频", {
      model: "agnes-video/agnes-video-v2.0",
    });

    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      url: "http://localhost:3001/assets/video.mp4",
      assetId: "asset-video-1",
      prompt: "生成一段产品视频",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5,
      model: "agnes-video/agnes-video-v2.0",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("generateVideoDirect exposes the created job id before waiting for video completion", async () => {
    vi.useFakeTimers();
    const onJobCreated = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          job: {
            id: "job-video-resume",
            status: "queued",
            result: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          job: {
            id: "job-video-resume",
            status: "queued",
            result: null,
          },
        }),
      });

    const resultPromise = generateVideoDirect("生成一段可恢复的视频", {
      model: "agnes-video/agnes-video-v2.0",
      onJobCreated,
    });

    await flushPromises();

    expect(onJobCreated).toHaveBeenCalledWith("job-video-resume");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await expect(
      Promise.race([
        resultPromise.then(() => "completed"),
        Promise.resolve("still-waiting"),
      ]),
    ).resolves.toBe("still-waiting");
  });

  it("generateVideoDirect keeps waiting beyond the initial Agnes queue window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            job: {
              id: "job-video-long-queue",
              status: "queued",
              result: null,
            },
          }),
        };
      }

      if (url === "http://localhost:3001/api/jobs/job-video-long-queue") {
        if (Date.now() < 660_000) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              job: {
                id: "job-video-long-queue",
                status: "queued",
                result: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            job: {
              id: "job-video-long-queue",
              status: "succeeded",
              result: {
                signed_url: "http://localhost:3001/assets/video.mp4",
                asset_id: "asset-video-1",
                mime_type: "video/mp4",
                width: 1280,
                height: 720,
                duration_seconds: 5,
              },
            },
          }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const resultPromise = generateVideoDirect("生成一段排队较久的视频", {
      model: "agnes-video/agnes-video-v2.0",
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(650_000);
    await flushPromises();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual({
      url: "http://localhost:3001/assets/video.mp4",
      assetId: "asset-video-1",
      prompt: "生成一段排队较久的视频",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 5,
      model: "agnes-video/agnes-video-v2.0",
    });
  });
});
