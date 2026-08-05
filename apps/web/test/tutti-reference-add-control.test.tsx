// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TuttiReferenceAddControl } from "../src/components/tutti-reference-add-control";

describe("TuttiReferenceAddControl", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "tuttiExternal");
  });

  it("keeps hydration stable before enabling host references", async () => {
    const hostWindow = window;
    const props = {
      labels: {
        addContent: "Add content",
        browseReferences: "Workspace resources",
        uploadFile: "Upload file",
      },
      value: "",
      onChange: vi.fn(),
      onUploadFile: vi.fn(),
    };

    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <TuttiReferenceAddControl {...props} />,
    );

    vi.stubGlobal("window", hostWindow);
    Object.defineProperty(window, "tuttiExternal", {
      configurable: true,
      value: {
        references: {
          select: vi.fn().mockResolvedValue([]),
        },
      },
    });
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const root = hydrateRoot(
      container,
      <TuttiReferenceAddControl {...props} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add content" }),
      ).toBeInTheDocument();
    });
    expect(consoleError).not.toHaveBeenCalled();

    await act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
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
    const onUploadFile = vi.fn();
    const user = userEvent.setup();

    render(
      <TuttiReferenceAddControl
        labels={{
          addContent: "Add content",
          browseReferences: "Workspace resources",
          uploadFile: "Upload file",
        }}
        value="Use these"
        onChange={onChange}
        onUploadFile={onUploadFile}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add content" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Workspace resources" }),
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        "Use these [brief.md](/workspace/brief.md) [@AI Doc outputs](mention://workspace-reference/ai-doc?count=2&source=app&workspaceId=workspace-1)",
      );
    });
  });
});
