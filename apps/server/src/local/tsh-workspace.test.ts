import { describe, expect, it } from "vitest";

import {
  allocateRenamedTshProjectRoot,
  allocateTshProjectRoot,
  assertAllowedTshParentPath,
  isTshWorkspaceAppHost,
  resolveTshParentPath,
  safeTshFileStem,
} from "./tsh-workspace.js";

describe("tsh-workspace", () => {
  it("detects TSH_WORKSPACE_APP", () => {
    expect(isTshWorkspaceAppHost({ TSH_WORKSPACE_APP: "1" })).toBe(true);
    expect(isTshWorkspaceAppHost({ TSH_WORKSPACE_APP: "0" })).toBe(false);
    expect(isTshWorkspaceAppHost({})).toBe(false);
  });

  it("resolves parent paths only on TSH hosts", () => {
    expect(resolveTshParentPath(undefined, {})).toBeNull();
    expect(
      resolveTshParentPath(undefined, { TSH_WORKSPACE_APP: "1" }),
    ).toBe("/workspace");
    expect(
      resolveTshParentPath("/workspace/docs", { TSH_WORKSPACE_APP: "1" }),
    ).toBe("/workspace/docs");
  });

  it("keeps Unicode stems for Chinese titles", () => {
    expect(safeTshFileStem("春季画布")).toBe("春季画布");
  });

  it("allocates title-shortId under /workspace", () => {
    const projectId = "abcdef12-3456-7890-abcd-ef1234567890";
    expect(allocateTshProjectRoot("/workspace", "春季画布", projectId)).toBe(
      "/workspace/春季画布-abcdef12",
    );
  });

  it("renames while preserving the trailing short id", () => {
    expect(
      allocateRenamedTshProjectRoot(
        "/workspace/Untitled-abcdef12",
        "海边奇遇",
      ),
    ).toBe("/workspace/海边奇遇-abcdef12");
  });

  it("rejects paths outside /workspace", () => {
    expect(() => assertAllowedTshParentPath("/tmp/evil")).toThrow(
      /inside \/workspace/,
    );
    expect(() => assertAllowedTshParentPath("/workspace/.tsh/x")).toThrow(
      /\.tsh/,
    );
  });
});
