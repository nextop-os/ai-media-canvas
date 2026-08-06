import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import {
  allocateTshProjectRoot,
  assertAllowedTshParentPath,
  formatTshArtifactDateSlug,
  formatTshArtifactDatedStem,
  isTshWorkspaceAppHost,
  resolveTshParentPath,
  safeTshFileStem,
  tshProjectDisplayTitle,
} from "./tsh-workspace.js";

describe("tsh-workspace", () => {
  it("detects TSH_WORKSPACE_APP", () => {
    expect(isTshWorkspaceAppHost({ TSH_WORKSPACE_APP: "1" })).toBe(true);
    expect(isTshWorkspaceAppHost({ TSH_WORKSPACE_APP: "0" })).toBe(false);
    expect(isTshWorkspaceAppHost({})).toBe(false);
  });

  it("resolves parent paths only on TSH hosts", () => {
    const workspaceRoot = resolve("/workspace");
    expect(resolveTshParentPath(undefined, {})).toBeNull();
    expect(
      resolveTshParentPath(undefined, { TSH_WORKSPACE_APP: "1" }),
    ).toBe(workspaceRoot);
    expect(
      resolveTshParentPath("/workspace/docs", { TSH_WORKSPACE_APP: "1" }),
    ).toBe(join(workspaceRoot, "docs"));
  });

  it("keeps Unicode stems for Chinese titles", () => {
    expect(safeTshFileStem("春季画布")).toBe("春季画布");
  });

  it("allocates canvas-YYYY-MM-DD-n under /workspace", () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const stem = formatTshArtifactDatedStem("canvas", now);
    expect(stem).toBe(`canvas-${formatTshArtifactDateSlug(now)}`);
    expect(allocateTshProjectRoot("/workspace", { now })).toBe(
      join(resolve("/workspace"), `${stem}-1`),
    );
  });

  it("allocates preferred stems with conflict suffix", () => {
    expect(
      allocateTshProjectRoot("/workspace", { preferredStem: "春季画布" }),
    ).toBe(join(resolve("/workspace"), "春季画布"));
  });

  it("display title is the directory basename", () => {
    expect(tshProjectDisplayTitle("/workspace/canvas-2026-08-06-1")).toBe(
      "canvas-2026-08-06-1",
    );
  });

  it("rejects paths outside /workspace", () => {
    expect(() => assertAllowedTshParentPath("/tmp/evil")).toThrow(
      "inside /workspace",
    );
    expect(() => assertAllowedTshParentPath("/workspace/.tsh/x")).toThrow(
      /\.tsh/,
    );
  });
});
