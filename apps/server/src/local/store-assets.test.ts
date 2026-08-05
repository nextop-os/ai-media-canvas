import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
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

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
      databaseRoot,
    });
    const project = store.createProject({ name: "Thumbnails" });
    const result = store.saveProjectThumbnail(
      project.id,
      Buffer.from("webp-bytes"),
      "image/webp",
    );

    expect(result?.thumbnailUrl).toMatch(/\/local-assets\//);
    const thumbDir = join(databaseRoot, "assets", "projects");
    expect(existsSync(thumbDir)).toBe(true);
    expect(
      readdirSync(thumbDir).some((name) => name.endsWith(".webp")),
    ).toBe(true);
    expect(existsSync(join(dataRoot, "assets"))).toBe(false);
  });
});
