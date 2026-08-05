// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TuttiReferenceAddControl } from "../src/components/tutti-reference-add-control";

describe("TuttiReferenceAddControl", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "tuttiExternal");
  });

  it("appends selected files and application outputs to the prompt", async () => {
    Object.defineProperty(window, "tuttiExternal", {
      configurable: true,
      value: {
        references: {
          select: vi.fn().mockResolvedValue([
            {
              selectionKind: "path",
              reference: {
                displayName: "brief.md",
                kind: "file",
                path: "/workspace/brief.md",
              },
            },
            {
              selectionKind: "workspace-reference",
              displayName: "AI Doc outputs",
              fileCount: 2,
              id: "ai-doc",
              source: "app",
              workspaceId: "workspace-1",
            },
          ]),
        },
      },
    });
    const onChange = vi.fn();

    render(
      <TuttiReferenceAddControl
        labels={{
          addContent: "Add content",
          browseReferences: "Browse references",
          uploadFile: "Upload file",
        }}
        value="Use these"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add content" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        "Use these [brief.md](/workspace/brief.md) [@AI Doc outputs](mention://workspace-reference/ai-doc?count=2&source=app&workspaceId=workspace-1)",
      );
    });
  });
});
