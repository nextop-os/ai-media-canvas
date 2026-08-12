import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appDataRelativeAssetPath, createLocalStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local asset storage", () => {
  it("uses video MIME type when storing extensionless MP4 assets", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-assets-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const uploaded = store.uploadFile({
      bucket: "project-assets",
      fileName: "generated-video",
      fileBuffer: Buffer.from("video"),
      mimeType: "video/mp4",
    });

    expect(uploaded.asset.objectPath).toMatch(/\.mp4$/);
    expect(uploaded.filePath).toMatch(/\.mp4$/);
  });

  it("does not store extensionless MPEG recordings as .bin files", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-assets-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const uploaded = store.uploadFile({
      bucket: "project-assets",
      fileName: "generated-recording",
      fileBuffer: Buffer.from("video"),
      mimeType: "video/mpeg",
    });

    expect(uploaded.asset.objectPath).toMatch(/\.mpeg$/);
    expect(uploaded.filePath).toMatch(/\.mpeg$/);
  });

  it("writes generated assets into the bound project workspace", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-generated-"));
    tempDirs.push(dataRoot);
    const workspaceRoot = join(dataRoot, "user-project");

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Campaign" });
    expect(store.bindProjectWorkspaceRoot(project.id, workspaceRoot)).toBe(
      workspaceRoot,
    );

    const uploaded = store.uploadFile({
      bucket: "project-assets",
      fileName: "codex-image",
      displayName: "Seaside adventure",
      fileBuffer: Buffer.from("png-bytes"),
      mimeType: "image/png",
      scope: "generated",
      projectId: project.id,
    });

    expect(uploaded.filePath.startsWith(join(workspaceRoot, "generated"))).toBe(
      true,
    );
    expect(uploaded.filePath).toMatch(/Seaside_adventure-[a-f0-9]{8}\.png$/);
    expect(existsSync(uploaded.filePath)).toBe(true);
    expect(uploaded.filePath.includes(join(dataRoot, "assets"))).toBe(false);
  });

  it("writes project thumbnails under the database root, not dataRoot", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-data-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "aimc-store-db-"));
    tempDirs.push(dataRoot, databaseRoot);
    vi.stubEnv("TSH_WORKSPACE_APP", "1");

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
      databaseRoot,
    });
    vi.unstubAllEnvs();
    const project = store.createProject({ name: "Thumbnails" });
    const result = store.saveProjectThumbnail(
      project.id,
      Buffer.from("webp-bytes"),
      "image/webp",
    );

    expect(result?.thumbnailUrl).toMatch(/\/local-assets\//);
    const thumbDir = join(databaseRoot, "assets", "projects");
    expect(existsSync(thumbDir)).toBe(true);
    expect(readdirSync(thumbDir).some((name) => name.endsWith(".webp"))).toBe(
      true,
    );
    expect(existsSync(join(dataRoot, "assets"))).toBe(false);
  });

  it("encodes bound project outputs from the injected app-data root", () => {
    expect(
      appDataRelativeAssetPath(
        "/workspace/canvas-2026-08-12-1/generated/result.png",
        "/workspace/.tsh/apps/data/aimc",
        "/workspace/canvas-2026-08-12-1",
      ),
    ).toBe("../../../../canvas-2026-08-12-1/generated/result.png");
  });

  it("lists a bound generated asset with a locator that resolves to its real file", () => {
    const root = mkdtempSync(join(tmpdir(), "aimc-reference-adapter-"));
    tempDirs.push(root);
    const dataRoot = join(root, "private");
    const appDataRoot = join(root, "workspace", ".tsh", "apps", "data", "aimc");
    const workspaceRoot = join(root, "workspace", "canvas-project");
    mkdirSync(appDataRoot, { recursive: true });

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
      referenceAppDataRoot: appDataRoot,
    });
    const project = store.createProject({ name: "Campaign" });
    store.bindProjectWorkspaceRoot(project.id, workspaceRoot);
    const generated = store.uploadFile({
      bucket: "project-assets",
      fileName: "result.png",
      displayName: "Result",
      fileBuffer: Buffer.from("png-bytes"),
      mimeType: "image/png",
      scope: "generated",
      projectId: project.id,
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
    const references = store.listReferenceProjectAssets({
      projectId: project.id,
      limit: 20,
    });

    expect(references.files).toHaveLength(1);
    const reference = references.files[0];
    expect(reference).toBeDefined();
    expect(resolve(appDataRoot, reference?.relativePath ?? "")).toBe(
      resolve(generated.filePath),
    );
  });

  it("does not expose VM-local private assets as workspace references", () => {
    expect(() =>
      appDataRelativeAssetPath(
        "/var/lib/tsh/workspace-apps/aimc/assets/uploads/input.png",
        "/workspace/.tsh/apps/data/aimc",
        "/workspace/canvas-2026-08-12-1",
      ),
    ).toThrow("Asset path must be inside the bound project workspace");
  });
});
