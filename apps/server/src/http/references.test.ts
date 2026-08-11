import { mkdtemp, rm } from "node:fs/promises";
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

vi.mock("../agent/runtime.js", () => ({
  createAgentRunService: createAgentRunServiceMock,
}));

import { buildApp } from "../app.js";
import { createLocalStore } from "../local/store.js";

type ListResponse = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

async function listReferences(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
): Promise<ListResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/tutti/references/list",
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ListResponse;
}

async function searchReferences(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
): Promise<ListResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/tutti/references/search",
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ListResponse;
}

function displayNames(result: ListResponse): string[] {
  return result.items.map(
    (item) => (item.reference as { displayName: string }).displayName,
  );
}

function findGroup(result: ListResponse, projectId: string) {
  return result.items.find((item) => item.id === `project:${projectId}`);
}

function findUnassignedGroup(result: ListResponse) {
  return result.items.find((item) => item.id === "unassigned");
}

function createGeneratedOutput(
  store: ReturnType<typeof createLocalStore>,
  input: {
    fileName: string;
    jobType: "image_generation" | "video_generation";
    mimeType: string;
    projectId?: string;
  },
) {
  const uploaded = store.uploadFile({
    bucket: "project-assets",
    fileName: input.fileName,
    fileBuffer: Buffer.from(input.fileName),
    mimeType: input.mimeType,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  const job = store.createBackgroundJob({
    jobType: input.jobType,
    queueName: input.jobType,
    payload: { prompt: `generate ${input.fileName}` },
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  store.markBackgroundJobSucceeded(job.id, {
    asset_id: uploaded.asset.id,
    mime_type: input.mimeType,
  });
  return uploaded;
}

describe("POST /tutti/references/list", () => {
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

  async function seedStore() {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-test-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Campaign A" });
    const image = createGeneratedOutput(store, {
      fileName: "hero.png",
      jobType: "image_generation",
      mimeType: "image/png",
      projectId: project.id,
    });
    const video = createGeneratedOutput(store, {
      fileName: "promo.mp4",
      jobType: "video_generation",
      mimeType: "video/mp4",
      projectId: project.id,
    });
    // Non-media asset under the project: must be excluded.
    store.uploadFile({
      bucket: "project-assets",
      fileName: "plan.json",
      fileBuffer: Buffer.from("{}"),
      mimeType: "application/json",
      projectId: project.id,
    });
    createGeneratedOutput(store, {
      fileName: "stray.png",
      jobType: "image_generation",
      mimeType: "image/png",
    });
    return {
      dataRoot,
      project,
      assetIds: [image.asset.id, video.asset.id],
    };
  }

  it("lists projects as root groups with exact media reference counts", async () => {
    const { dataRoot, project } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({
      type: "group",
      id: `project:${project.id}`,
      displayName: "Campaign A",
      referenceCount: 2, // image + video; json excluded
    });
    expect(findUnassignedGroup(root)).toBeUndefined();
  });

  it("keeps root project groups in the same updated order as the app", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-project-order-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const older = store.createProject({ name: "Chronology Alpha Older" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = store.createProject({ name: "Chronology Zed Newer" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.saveCanvas(older.primaryCanvas.id, {
      elements: [],
      appState: {},
      files: {},
    });
    const expectedIds = store
      .listProjects()
      .filter((project) => project.name.toLowerCase().includes("chronology"))
      .map((project) => `project:${project.id}`);
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, { filterText: "chronology" });
    const firstPage = await listReferences(app, {
      filterText: "chronology",
      limit: 1,
    });
    const secondPage = await listReferences(app, {
      filterText: "chronology",
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    await app.close();

    expect(expectedIds).toEqual([`project:${older.id}`, `project:${newer.id}`]);
    expect(root.items.map((item) => item.id)).toEqual(expectedIds);
    expect([
      ...firstPage.items.map((item) => item.id),
      ...secondPage.items.map((item) => item.id),
    ]).toEqual(expectedIds);
  });

  it("filters root project groups by project id and display name", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-project-filter-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Searchable Campaign" });
    const app = buildApp({ env: { dataRoot } });

    const byId = await listReferences(app, {
      filterText: project.id.slice(0, 8),
    });
    const byDisplayName = await listReferences(app, {
      filterText: "searchable",
    });
    await app.close();

    expect(byId.items.map((item) => item.id)).toEqual([
      `project:${project.id}`,
    ]);
    expect(byDisplayName.items.map((item) => item.id)).toEqual([
      `project:${project.id}`,
    ]);
  });

  it("does not expose ordinary media uploads as app references", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-ordinary-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Manual Uploads" });
    store.uploadFile({
      bucket: "project-assets",
      fileName: "uploaded.png",
      fileBuffer: Buffer.from("image"),
      mimeType: "image/png",
      projectId: project.id,
    });
    store.uploadFile({
      bucket: "project-assets",
      fileName: "loose.mp4",
      fileBuffer: Buffer.from("video"),
      mimeType: "video/mp4",
    });
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const projectFiles = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    const unassignedFiles = await listReferences(app, {
      parentGroupId: "unassigned",
    });
    const search = await searchReferences(app, {});
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({
      type: "group",
      id: `project:${project.id}`,
      displayName: "Manual Uploads",
      referenceCount: 0,
    });
    expect(findUnassignedGroup(root)).toBeUndefined();
    expect(projectFiles.items).toEqual([]);
    expect(unassignedFiles.items).toEqual([]);
    expect(search.items).toEqual([]);
  });

  it("does not expose project-less generated assets as a synthetic project", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const files = await listReferences(app, { parentGroupId: "unassigned" });
    const search = await searchReferences(app, {});
    await app.close();

    expect(findUnassignedGroup(root)).toBeUndefined();
    expect(files.items).toEqual([]);
    expect(search.items).toHaveLength(2);
  });

  it("lists projects without reusable media as empty root groups", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-empty-project-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Fresh Project" });
    store.saveProjectThumbnail(project.id, Buffer.from("thumb"), "image/webp");
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const files = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({
      type: "group",
      id: `project:${project.id}`,
      displayName: "Fresh Project",
      referenceCount: 0,
    });
    expect(files.items).toEqual([]);
    expect(files.nextCursor).toBeNull();
  });

  it("lists a project's media assets as absolute workspace-path file references", async () => {
    const { dataRoot, project, assetIds } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const files = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    await app.close();

    expect(files.items).toHaveLength(2);
    for (const item of files.items) {
      expect(item.type).toBe("reference");
      const reference = item.reference as {
        kind: string;
        displayName: string;
        location: { type: string; path: string };
      };
      expect(reference.kind).toBe("file");
      expect(reference.location.type).toBe("workspace-path");
      expect(reference.location.path).toMatch(/^\//);
      // displayName is the file name, which embeds the asset id.
      const assetId = assetIds.find((id) =>
        reference.displayName.startsWith(id),
      );
      expect(assetId).toBeTruthy();
    }
  });

  it("lists generated canvas assets under the owning project", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-canvas-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Canvas Outputs" });
    const generated = store.uploadFile({
      bucket: "project-assets",
      fileName: "agent-output.png",
      fileBuffer: Buffer.from("generated"),
      mimeType: "image/png",
    });
    createGeneratedOutput(store, {
      fileName: "stray.png",
      jobType: "image_generation",
      mimeType: "image/png",
    });
    store.saveCanvas(project.primaryCanvas.id, {
      elements: [
        {
          id: "generated-element",
          type: "image",
          fileId: "generated-file",
          isDeleted: false,
          customData: {
            source: "generated",
            assetId: generated.asset.id,
          },
        } as never,
      ],
      appState: {},
      files: {
        "generated-file": {
          id: "generated-file",
          assetId: generated.asset.id,
          mimeType: "image/png",
        },
      },
    });
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const projectFiles = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    const unassignedFiles = await listReferences(app, {
      parentGroupId: "unassigned",
    });
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({
      type: "group",
      id: `project:${project.id}`,
      referenceCount: 1,
    });
    expect(findUnassignedGroup(root)).toBeUndefined();
    expect(displayNames(projectFiles)).toEqual([`${generated.asset.id}.png`]);
    expect(unassignedFiles.items).toEqual([]);
  });

  it("excludes internal .bin media while retaining recognized MPEG recordings", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-bin-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Binary Guard" });
    const binary = createGeneratedOutput(store, {
      fileName: "opaque-recording",
      jobType: "video_generation",
      mimeType: "video/x-private",
      projectId: project.id,
    });
    const recording = createGeneratedOutput(store, {
      fileName: "mpeg-recording",
      jobType: "video_generation",
      mimeType: "video/mpeg",
      projectId: project.id,
    });
    expect(binary.asset.objectPath).toMatch(/\.bin$/);
    expect(recording.asset.objectPath).toMatch(/\.mpeg$/);
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const files = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    const search = await searchReferences(app, { filters: ["video"] });
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({ referenceCount: 1 });
    expect(displayNames(files)).toEqual([`${recording.asset.id}.mpeg`]);
    expect(displayNames(search)).toEqual([`${recording.asset.id}.mpeg`]);
  });

  it("does not duplicate a project-owned asset into another canvas project", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-owner-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const owner = store.createProject({ name: "Reference Owner" });
    const other = store.createProject({ name: "Reference Other" });
    const generated = createGeneratedOutput(store, {
      fileName: "owned.png",
      jobType: "image_generation",
      mimeType: "image/png",
      projectId: owner.id,
    });
    store.saveCanvas(other.primaryCanvas.id, {
      elements: [
        {
          id: "copied-element",
          type: "image",
          fileId: "copied-file",
          isDeleted: false,
          customData: {
            source: "generated",
            assetId: generated.asset.id,
          },
        } as never,
      ],
      appState: {},
      files: {
        "copied-file": {
          id: "copied-file",
          assetId: generated.asset.id,
          mimeType: "image/png",
        },
      },
    });
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, { filterText: "reference" });
    const ownerFiles = await listReferences(app, {
      parentGroupId: `project:${owner.id}`,
    });
    const otherFiles = await listReferences(app, {
      parentGroupId: `project:${other.id}`,
    });
    const otherSearch = await searchReferences(app, {
      query: "Reference Other",
    });
    await app.close();

    expect(findGroup(root, owner.id)).toMatchObject({ referenceCount: 1 });
    expect(findGroup(root, other.id)).toMatchObject({ referenceCount: 0 });
    expect(displayNames(ownerFiles)).toEqual([`${generated.asset.id}.png`]);
    expect(otherFiles.items).toEqual([]);
    expect(otherSearch.items).toEqual([]);
  });

  it("does not expose project thumbnail snapshots as app references", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-thumb-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Thumbnail Guard" });
    const image = createGeneratedOutput(store, {
      fileName: "usable.png",
      jobType: "image_generation",
      mimeType: "image/png",
      projectId: project.id,
    });
    store.saveProjectThumbnail(project.id, Buffer.from("blank"), "image/webp");
    store.saveProjectThumbnail(
      project.id,
      Buffer.from("current"),
      "image/webp",
    );
    const app = buildApp({ env: { dataRoot } });

    const root = await listReferences(app, {});
    const files = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
    });
    const search = await searchReferences(app, {});
    await app.close();

    expect(findGroup(root, project.id)).toMatchObject({
      type: "group",
      id: `project:${project.id}`,
      referenceCount: 1,
    });
    expect(displayNames(files)).toEqual([`${image.asset.id}.png`]);
    expect(displayNames(search)).toEqual([`${image.asset.id}.png`]);
  });

  it("returns an empty result for an unknown group id", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const result = await listReferences(app, { parentGroupId: "bogus:123" });
    await app.close();

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates project file references via opaque cursor", async () => {
    const { dataRoot, project } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const firstPage = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await listReferences(app, {
      parentGroupId: `project:${project.id}`,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    await app.close();

    expect(secondPage.items).toHaveLength(1);
    const firstId = (firstPage.items[0]?.reference as { displayName: string })
      .displayName;
    const secondId = (secondPage.items[0]?.reference as { displayName: string })
      .displayName;
    expect(firstId).not.toBe(secondId);
  });
});

describe("POST /tutti/references/search", () => {
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

  // Two projects, each with generated media, plus excluded non-media and
  // project-less generated assets.
  async function seedStore() {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-search-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const projectA = store.createProject({ name: "Campaign A" });
    const projectB = store.createProject({ name: "Campaign B" });
    const upload = (
      projectId: string | undefined,
      fileName: string,
      mimeType: string,
    ) =>
      store.uploadFile({
        bucket: "project-assets",
        fileName,
        fileBuffer: Buffer.from(fileName),
        mimeType,
        ...(projectId ? { projectId } : {}),
      });
    createGeneratedOutput(store, {
      projectId: projectA.id,
      fileName: "a-hero.png",
      jobType: "image_generation",
      mimeType: "image/png",
    });
    createGeneratedOutput(store, {
      projectId: projectA.id,
      fileName: "a-promo.mp4",
      jobType: "video_generation",
      mimeType: "video/mp4",
    });
    createGeneratedOutput(store, {
      projectId: projectB.id,
      fileName: "b-hero.jpg",
      jobType: "image_generation",
      mimeType: "image/jpeg",
    });
    createGeneratedOutput(store, {
      projectId: projectB.id,
      fileName: "b-promo.mov",
      jobType: "video_generation",
      mimeType: "video/quicktime",
    });
    createGeneratedOutput(store, {
      projectId: projectA.id,
      fileName: "a-preview.svg",
      jobType: "image_generation",
      mimeType: "image/svg+xml",
    });
    upload(projectA.id, "plan.json", "application/json"); // non-media, excluded
    createGeneratedOutput(store, {
      fileName: "stray.png",
      jobType: "image_generation",
      mimeType: "image/png",
    });
    return { dataRoot, projectA, projectB };
  }

  it("searches media references recursively across all projects", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const result = await searchReferences(app, {});
    await app.close();

    // 3 project images (including svg) + 2 project videos; ordinary json and
    // project-less generated media are excluded.
    expect(result.items).toHaveLength(5);
    for (const item of result.items) {
      const reference = item.reference as {
        kind: string;
        location: { type: string; path: string };
        parentGroupLabel?: string;
      };
      expect(reference.kind).toBe("file");
      expect(reference.location.type).toBe("workspace-path");
      expect(reference.location.path).toMatch(/^\//);
      expect(reference.parentGroupLabel).toMatch(/^Campaign [AB]$/);
    }
  });

  it("matches search queries against project ids and project display names", async () => {
    const { dataRoot, projectA } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const byId = await searchReferences(app, {
      query: projectA.id.slice(0, 8),
    });
    const byDisplayName = await searchReferences(app, { query: "campaign a" });
    await app.close();

    expect(
      byId.items.map(
        (item) =>
          (item.reference as { parentGroupLabel?: string }).parentGroupLabel,
      ),
    ).toEqual(["Campaign A", "Campaign A", "Campaign A"]);
    expect(
      byDisplayName.items.map(
        (item) =>
          (item.reference as { parentGroupLabel?: string }).parentGroupLabel,
      ),
    ).toEqual(["Campaign A", "Campaign A", "Campaign A"]);
  });

  it("matches legacy canvas assets against their fallback project owner", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-search-owner-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Legacy Canvas Owner" });
    const generated = store.uploadFile({
      bucket: "project-assets",
      fileName: "legacy-output.png",
      fileBuffer: Buffer.from("generated"),
      mimeType: "image/png",
    });
    store.saveCanvas(project.primaryCanvas.id, {
      elements: [
        {
          id: "legacy-element",
          type: "image",
          fileId: "legacy-file",
          isDeleted: false,
          customData: {
            source: "generated",
            assetId: generated.asset.id,
          },
        } as never,
      ],
      appState: {},
      files: {
        "legacy-file": {
          id: "legacy-file",
          assetId: generated.asset.id,
          mimeType: "image/png",
        },
      },
    });
    const app = buildApp({ env: { dataRoot } });

    const byId = await searchReferences(app, {
      query: project.id.slice(0, 8),
    });
    const byName = await searchReferences(app, { query: "legacy canvas" });
    await app.close();

    expect(displayNames(byId)).toEqual([`${generated.asset.id}.png`]);
    expect(displayNames(byName)).toEqual([`${generated.asset.id}.png`]);
    for (const result of [byId, byName]) {
      expect(
        (result.items[0]?.reference as { parentGroupLabel?: string })
          .parentGroupLabel,
      ).toBe("Legacy Canvas Owner");
    }
  });

  it("preserves an empty resolved project label in search results", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "aimc-refs-empty-label-"));
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Temporary Name" });
    createGeneratedOutput(store, {
      projectId: project.id,
      fileName: "owned.png",
      jobType: "image_generation",
      mimeType: "image/png",
    });
    expect(store.updateProject(project.id, { name: "   " })).toEqual({
      ok: true,
      workspaceRoot: null,
    });
    const app = buildApp({ env: { dataRoot } });

    const result = await searchReferences(app, {
      query: project.id.slice(0, 8),
    });
    await app.close();

    expect(result.items).toHaveLength(1);
    expect(
      (result.items[0]?.reference as { parentGroupLabel?: string })
        .parentGroupLabel,
    ).toBe("");
  });

  it("keeps active owned assets discovered from archived canvases searchable", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "aimc-refs-archived-marker-"),
    );
    dataRoots.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const owner = store.createProject({ name: "Active Asset Owner" });
    const archived = store.createProject({ name: "Archived Marker" });
    const generated = store.uploadFile({
      bucket: "project-assets",
      fileName: "archived-marker.png",
      fileBuffer: Buffer.from("generated"),
      mimeType: "image/png",
      projectId: owner.id,
    });
    store.saveCanvas(archived.primaryCanvas.id, {
      elements: [
        {
          id: "archived-element",
          type: "image",
          fileId: "archived-file",
          isDeleted: false,
          customData: {
            source: "generated",
            assetId: generated.asset.id,
          },
        } as never,
      ],
      appState: {},
      files: {
        "archived-file": {
          id: "archived-file",
          assetId: generated.asset.id,
          mimeType: "image/png",
        },
      },
    });
    expect(store.archiveProject(archived.id)).toBe(true);
    const app = buildApp({ env: { dataRoot } });

    const result = await searchReferences(app, { query: "active asset" });
    await app.close();

    expect(displayNames(result)).toEqual([`${generated.asset.id}.png`]);
    expect(
      (result.items[0]?.reference as { parentGroupLabel?: string })
        .parentGroupLabel,
    ).toBe("Active Asset Owner");
  });

  it("filters to images only via the image category id (filter-only)", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const result = await searchReferences(app, { filters: ["image"] });
    await app.close();

    expect(result.items).toHaveLength(3);
    for (const name of displayNames(result)) {
      expect(name).toMatch(/\.(png|jpg|jpeg|svg)$/);
    }
  });

  it("returns the intersection of query and type filters", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    // object_path is "<scope>/<uuid>.<ext>"; uuids are hex, so they never
    // contain "png"/"mp4" and the query only matches via the extension token.
    // query "png" matches the image; narrowing by `image` keeps it.
    const pngAsImage = await searchReferences(app, {
      query: "png",
      filters: ["image"],
    });
    // Same query, incompatible type -> empty. If query/type were OR'd this
    // would return the png image plus every video.
    const pngAsVideo = await searchReferences(app, {
      query: "png",
      filters: ["video"],
    });
    await app.close();

    expect(pngAsImage.items).toHaveLength(1);
    expect(displayNames(pngAsImage)[0]).toMatch(/\.png$/);
    expect(pngAsVideo.items).toEqual([]);
  });

  it("combines categories with OR semantics", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const result = await searchReferences(app, {
      filters: ["image", "video"],
    });
    await app.close();

    expect(result.items).toHaveLength(5);
  });

  it("ignores unknown category ids", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    // Only an unknown id -> no effective filter -> all media returned.
    const unknownOnly = await searchReferences(app, { filters: ["bogus"] });
    // Known + unknown -> behaves as the known filter alone.
    const mixed = await searchReferences(app, {
      filters: ["image", "bogus"],
    });
    await app.close();

    expect(unknownOnly.items).toHaveLength(5);
    expect(mixed.items).toHaveLength(3);
  });

  it("returns nothing for a category that matches no exposed assets", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    // No documents exist; the app only exposes image/video media.
    const result = await searchReferences(app, { filters: ["document"] });
    await app.close();

    expect(result.items).toEqual([]);
  });

  it("paginates flat search results via opaque cursor", async () => {
    const { dataRoot } = await seedStore();
    const app = buildApp({ env: { dataRoot } });

    const firstPage = await searchReferences(app, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await searchReferences(app, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    await app.close();

    expect(secondPage.items).toHaveLength(1);
    expect(displayNames(firstPage)[0]).not.toBe(displayNames(secondPage)[0]);
  });
});
