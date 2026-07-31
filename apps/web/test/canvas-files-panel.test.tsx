// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasFilesPanel } from "../src/components/canvas-files-panel";
import { ToastProvider } from "../src/components/toast";
import { i18n } from "../src/i18n";

describe("CanvasFilesPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "showSaveFilePicker");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the save picker and shows success after the file is written", async () => {
    const user = userEvent.setup();
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["png"], { type: "image/png" }),
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    vi.stubGlobal("fetch", fetchMock);
    const excalidrawApi = {
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          isDeleted: false,
          fileId: "file-1",
          customData: {
            source: "generated",
            title: "Generated image",
          },
        },
      ],
      getFiles: () => ({
        "file-1": {
          dataURL: "data:image/png;base64,cG5n",
        },
      }),
      onChange: () => vi.fn(),
    };

    render(
      <ToastProvider>
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={true}
          onClose={vi.fn()}
        />
      </ToastProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Download Generated image" }),
    );

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "Generated image.png",
      types: [
        {
          accept: { "image/png": [".png"] },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith("data:image/png;base64,cG5n");
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Download successful")).toBeInTheDocument();
    expect(
      screen.queryByText("Downloaded Generated image"),
    ).not.toBeInTheDocument();
  });

  it("shows a download started toast when falling back to browser download", async () => {
    const user = userEvent.setup();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const excalidrawApi = {
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          isDeleted: false,
          fileId: "file-1",
          customData: {
            source: "generated",
            title: "Generated image",
          },
        },
      ],
      getFiles: () => ({
        "file-1": {
          dataURL: "data:image/png;base64,cG5n",
        },
      }),
      onChange: () => vi.fn(),
    };

    render(
      <ToastProvider>
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={true}
          onClose={vi.fn()}
        />
      </ToastProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Download Generated image" }),
    );

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Download successful")).not.toBeInTheDocument();
    expect(await screen.findByText("Download started")).toBeInTheDocument();
  });
});
