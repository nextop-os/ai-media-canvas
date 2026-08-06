import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createAgentRunServiceMock } = vi.hoisted(() => ({
  createAgentRunServiceMock: vi.fn(() => ({
    cancelRun: vi.fn(),
    createRun: vi.fn(),
    streamRun: vi.fn(async function* streamRun() {}),
  })),
}));

vi.mock("./agent/runtime.js", () => ({
  createAgentRunService: createAgentRunServiceMock,
}));

import { buildApp } from "./app.js";
import { createLocalStore } from "./local/store.js";

describe("buildApp", () => {
  const dataRoots: string[] = [];

  afterEach(async () => {
    createAgentRunServiceMock.mockClear();
    await Promise.all(
      dataRoots
        .splice(0)
        .map((dataRoot) =>
          rm(dataRoot, { force: true, recursive: true, maxRetries: 3 }),
        ),
    );
  });

  it("wires the local job service into agent runs", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);

    const app = buildApp({ env: { dataRoot } });
    await app.close();

    expect(createAgentRunServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobService: expect.objectContaining({
          createJob: expect.any(Function),
          getJob: expect.any(Function),
        }),
      }),
    );
  });

  it("returns the public policy error when the local agent runtime is disabled", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);
    const setupStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = setupStore.createProject({ name: "Disabled agent run" });
    const session = setupStore.createSession(project.primaryCanvas.id);
    if (!session) throw new Error("Expected chat session to be created.");

    const app = buildApp({
      env: {
        agentModel: "codex:gpt-5.4",
        dataRoot,
        trustedLocalAgentMode: false,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: {
        conversationId: project.primaryCanvas.id,
        prompt: "Continue",
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
        sessionId: session.id,
      },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "local_agent_disabled",
        message: "Local agent runtime is disabled for this server.",
      },
    });
  });

  it("serves local assets with byte-range support for media playback", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);
    const setupStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const uploaded = setupStore.uploadFile({
      bucket: "project-assets",
      fileName: "clip.mp4",
      fileBuffer: Buffer.from("0123456789"),
      mimeType: "video/mp4",
    });

    const app = buildApp({ env: { dataRoot } });
    const response = await app.inject({
      method: "GET",
      url: `/local-assets/${uploaded.asset.id}`,
      headers: {
        range: "bytes=0-3",
      },
    });
    await app.close();

    expect(response.statusCode).toBe(206);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe("bytes 0-3/10");
    expect(response.headers["content-type"]).toContain("video/mp4");
    expect(response.body).toBe("0123");
  });

  it("creates managed file asset records and serves them through local asset URLs", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);
    const managedRoot = await mkdtemp(join(tmpdir(), "aimc-managed-files-"));
    dataRoots.push(managedRoot);
    const managedFilePath = join(managedRoot, "managed-ref.png");
    const managedFileBytes = Buffer.from("fake");
    const managedFileSha256 = createHash("sha256")
      .update(managedFileBytes)
      .digest("hex");
    await writeFile(managedFilePath, managedFileBytes);
    const managedFileRealPath = await realpath(managedFilePath);

    const app = buildApp({
      env: {
        dataRoot,
        tuttiManagedFilesRoot: managedRoot,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads/managed-file",
      payload: {
        file: {
          path: managedFilePath,
          name: "ref.png",
          mimeType: "image/png",
          sizeBytes: managedFileBytes.byteLength,
          sha256: managedFileSha256,
        },
        projectId: "project-1",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      asset: {
        id: string;
        objectPath: string;
        source?: string;
        displayName?: string | null;
        sha256?: string | null;
      };
      url: string;
    };
    expect(body.asset).toMatchObject({
      objectPath: managedFileRealPath,
      source: "managed-file",
      displayName: "ref.png",
      sha256: managedFileSha256,
    });
    expect(body.url).toContain(`/local-assets/${body.asset.id}`);

    const assetUrl = await app.inject({
      method: "GET",
      url: `/api/uploads/${body.asset.id}/url`,
    });
    expect(assetUrl.statusCode).toBe(200);
    expect(JSON.parse(assetUrl.body)).toEqual({
      url: body.url,
    });

    const localAsset = await app.inject({
      method: "GET",
      url: `/local-assets/${body.asset.id}`,
    });
    await app.close();

    expect(localAsset.statusCode).toBe(200);
    expect(localAsset.body).toBe("fake");
  });

  it("defaults managed file asset records to files under the data root uploads directory", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);
    const uploadsRoot = join(dataRoot, "uploads");
    await mkdir(uploadsRoot);
    const managedFilePath = join(uploadsRoot, "managed-ref.png");
    const managedFileBytes = Buffer.from("fake");
    const managedFileSha256 = createHash("sha256")
      .update(managedFileBytes)
      .digest("hex");
    await writeFile(managedFilePath, managedFileBytes);
    const managedFileRealPath = await realpath(managedFilePath);

    const app = buildApp({
      env: {
        dataRoot,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads/managed-file",
      payload: {
        file: {
          path: managedFilePath,
          name: "ref.png",
          mimeType: "image/png",
          sizeBytes: managedFileBytes.byteLength,
          sha256: managedFileSha256,
        },
      },
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      asset: {
        objectPath: string;
        source?: string;
        displayName?: string | null;
        sha256?: string | null;
      };
    };
    expect(body.asset).toMatchObject({
      objectPath: managedFileRealPath,
      source: "managed-file",
      displayName: "ref.png",
      sha256: managedFileSha256,
    });
  });

  it("rejects managed file asset records outside the managed files root", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);
    const managedRoot = await mkdtemp(join(tmpdir(), "aimc-managed-files-"));
    dataRoots.push(managedRoot);
    const outsideRoot = await mkdtemp(join(tmpdir(), "aimc-outside-files-"));
    dataRoots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "secret.txt");
    const outsideBytes = Buffer.from("secret");
    const outsideSha256 = createHash("sha256")
      .update(outsideBytes)
      .digest("hex");
    await writeFile(outsidePath, outsideBytes);

    const app = buildApp({
      env: {
        dataRoot,
        tuttiManagedFilesRoot: managedRoot,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads/managed-file",
      payload: {
        file: {
          path: outsidePath,
          name: "secret.txt",
          mimeType: "text/plain",
          sizeBytes: outsideBytes.byteLength,
          sha256: outsideSha256,
        },
      },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: "upload_failed",
        message: "Managed file path is outside the configured upload root.",
      },
    });
  });

  it("allows local frontend origins even when the configured dev port differs", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);

    const app = buildApp({
      env: {
        dataRoot,
        webOrigin: "http://localhost:3002",
      },
    });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/workspace/settings",
      headers: {
        origin: "http://localhost:3000",
      },
    });
    await app.close();

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });

  it("serves routed web pages when launch URLs include query params", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    const webDistDir = await mkdtemp(join(tmpdir(), "aimc-web-dist-"));
    dataRoots.push(dataRoot, webDistDir);
    await writeFile(join(webDistDir, "canvas.html"), "<main>canvas</main>");
    await writeFile(join(webDistDir, "404.html"), "<main>missing</main>");

    const app = buildApp({
      env: {
        dataRoot,
        webDistDir,
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/canvas?id=1b69eb24-390e-4ea6-b737-b3741c3a53dc",
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toBe("<main>canvas</main>");
  });

  it("does not reflect non-local origins that differ from the configured web origin", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);

    const app = buildApp({
      env: {
        dataRoot,
        webOrigin: "https://app.example.com",
      },
    });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/workspace/settings",
      headers: {
        origin: "https://evil.example.com",
      },
    });
    await app.close();

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
  });

  it("rejects stale canvas saves over HTTP", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-app-test-"));
    dataRoots.push(dataRoot);

    const setupStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = setupStore.createProject({ name: "Canvas conflict" });
    const initialCanvas = setupStore.getCanvas(project.primaryCanvas.id);
    expect(initialCanvas).not.toBeNull();
    const initialRevision = initialCanvas?.revision ?? 0;

    const app = buildApp({ env: { dataRoot } });
    const firstSave = await app.inject({
      method: "PUT",
      url: `/api/canvases/${project.primaryCanvas.id}`,
      payload: {
        baseRevision: initialRevision,
        content: {
          elements: [
            {
              id: "server-image",
              type: "image",
              isDeleted: false,
            },
          ],
          appState: {},
          files: {},
        },
      },
    });
    expect(firstSave.statusCode).toBe(200);

    const response = await app.inject({
      method: "PUT",
      url: `/api/canvases/${project.primaryCanvas.id}`,
      payload: {
        baseRevision: initialRevision,
        content: {
          elements: [],
          appState: {},
          files: {},
        },
      },
    });
    const latest = await app.inject({
      method: "GET",
      url: `/api/canvases/${project.primaryCanvas.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(latest.body).canvas.content.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "server-image",
        }),
      ]),
    );
  });
});
