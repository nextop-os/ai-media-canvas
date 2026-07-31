// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasContextMenuExtensions } from "../src/components/canvas-context-menu-extensions";
import { ToastProvider } from "../src/components/toast";
import { i18n } from "../src/i18n";

const { exportToBlobMock } = vi.hoisted(() => ({
  exportToBlobMock: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: exportToBlobMock,
}));

describe("CanvasContextMenuExtensions", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    exportToBlobMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "showSaveFilePicker");
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds a localized download image item to the native Excalidraw context menu", async () => {
    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={{}} />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "下载图片" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: "下载图片" }).closest("li"),
    ).toHaveClass("aimc-context-menu-section-start");
  });

  it("renders the download image item in English when the locale changes", async () => {
    await i18n.changeLanguage("en");
    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={{}} />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Download image" }),
      ).toBeInTheDocument();
    });
  });

  it("closes the native menu immediately when downloading an image", async () => {
    const user = userEvent.setup();
    const keydownEvents: KeyboardEvent[] = [];
    const imageElement = {
      id: "image-1",
      type: "image",
      isDeleted: false,
      x: 0,
      y: 0,
      width: 320,
      height: 320,
    };
    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
        viewBackgroundColor: "#ffffff",
      }),
      getFiles: () => ({}),
      getSceneElements: () => [imageElement],
    };

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;
    document.addEventListener("keydown", (event) => {
      keydownEvents.push(event);
    });
    exportToBlobMock.mockReturnValue(new Promise<Blob>(() => {}));

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "下载图片" }));

    expect(keydownEvents).toEqual([
      expect.objectContaining({ key: "Escape", code: "Escape" }),
    ]);
    expect(exportToBlobMock).toHaveBeenCalledWith({
      elements: [imageElement],
      appState: expect.objectContaining({ exportBackground: true }),
      files: {},
      mimeType: "image/png",
    });
  });

  it("downloads a single uncropped image directly from the original file data", async () => {
    const user = userEvent.setup();
    const anchorClick = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    let downloadAnchor: HTMLAnchorElement | null = null;

    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName === "a") {
        downloadAnchor = element as HTMLAnchorElement;
        Object.defineProperty(element, "click", {
          configurable: true,
          value: anchorClick,
        });
      }
      return element;
    });

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;
    exportToBlobMock.mockReturnValue(new Promise<Blob>(() => {}));

    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,b3JpZ2luYWw=" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 120,
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "下载图片" }));

    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(downloadAnchor?.href).toBe("data:image/png;base64,b3JpZ2luYWw=");
    expect(downloadAnchor?.download).toBe("ai-media-canvas-image-1.png");
    expect(exportToBlobMock).not.toHaveBeenCalled();
    expect(screen.queryByText("下载成功")).not.toBeInTheDocument();
    expect(await screen.findByText("已开始下载")).toBeInTheDocument();
  });

  it("uses the image title as the downloaded filename when available", async () => {
    const user = userEvent.setup();
    const anchorClick = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    let downloadAnchor: HTMLAnchorElement | null = null;

    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName === "a") {
        downloadAnchor = element as HTMLAnchorElement;
        Object.defineProperty(element, "click", {
          configurable: true,
          value: anchorClick,
        });
      }
      return element;
    });

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;

    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,b3JpZ2luYWw=" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          customData: { title: "参考/图: 01.png" },
          x: 0,
          y: 0,
          width: 120,
          height: 120,
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "下载图片" }));

    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(downloadAnchor?.download).toBe("参考-图- 01.png");
  });

  it("uses the save picker and shows success after writing a downloaded image", async () => {
    const user = userEvent.setup();
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["original"], { type: "image/png" }),
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    vi.stubGlobal("fetch", fetchMock);

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu"></ul>
      </div>
    `;
    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,b3JpZ2luYWw=" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 120,
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "下载图片" }));

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "ai-media-canvas-image-1.png",
      types: [
        {
          accept: { "image/png": [".png"] },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "data:image/png;base64,b3JpZ2luYWw=",
    );
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("下载成功")).toBeInTheDocument();
    expect(exportToBlobMock).not.toHaveBeenCalled();
  });

  it("localizes retained native menu labels and marks group dividers", async () => {
    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li>
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">拷贝</div>
            </button>
          </li>
          <li>
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Wrap selection in frame</div>
            </button>
          </li>
          <li>
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Crop image</div>
            </button>
          </li>
          <li data-testid="copyAsPng">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy to clipboard as PNG</div>
            </button>
          </li>
          <li>
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy link to object</div>
            </button>
          </li>
          <li data-testid="duplicateSelection">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Duplicate</div>
            </button>
          </li>
        </ul>
      </div>
    `;

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={{}} />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("裁剪图片").closest("li")).toHaveClass(
        "aimc-context-menu-section-start",
      );
    });

    const copyNodeLabels = screen.getAllByText("复制节点");
    expect(screen.getByText("用画框包裹选区")).toBeInTheDocument();
    expect(copyNodeLabels).toHaveLength(2);
    expect(screen.getByText("复制图片").closest("li")).not.toBeVisible();
    expect(screen.getByText("复制对象链接")).toBeInTheDocument();
    expect(copyNodeLabels[1].closest("li")).toHaveClass(
      "aimc-context-menu-section-start",
    );
    expect(copyNodeLabels[0].closest("li")).not.toHaveClass(
      "aimc-context-menu-section-start",
    );
  });

  it("hides native copy image when there is no image-only selection", async () => {
    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: {},
        viewBackgroundColor: "#ffffff",
      }),
      getFiles: () => ({}),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 320,
          height: 320,
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("复制图片").closest("li")).not.toBeVisible();
    });
  });

  it("keeps native Copy while adding a separate image copy action", async () => {
    const user = userEvent.setup();
    const nativeCopyClick = vi.fn();
    const copyAsPngClick = vi.fn();
    const keydownEvents: KeyboardEvent[] = [];
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const pngBlob = new Blob(["png"], { type: "image/png" });
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy</div>
            </button>
          </li>
          <li data-testid="copyAsPng">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">复制为 PNG 到剪贴板</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    document
      .querySelector('[data-testid="copy"] button')
      ?.addEventListener("click", nativeCopyClick);
    document
      .querySelector('[data-testid="copyAsPng"] button')
      ?.addEventListener("click", copyAsPngClick);
    document.addEventListener("keydown", (event) => {
      keydownEvents.push(event);
    });
    exportToBlobMock.mockResolvedValue(pngBlob);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    const imageElement = {
      id: "image-1",
      type: "image",
      isDeleted: false,
      x: 0,
      y: 0,
      width: 320,
      height: 320,
    };
    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
        viewBackgroundColor: "#ffffff",
      }),
      getFiles: () => ({}),
      getSceneElements: () => [imageElement],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "复制节点" }));

    expect(nativeCopyClick).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(copyAsPngClick).not.toHaveBeenCalled();
    expect(keydownEvents).toEqual([]);

    await user.click(await screen.findByRole("button", { name: "复制图片" }));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    expect(nativeCopyClick).toHaveBeenCalledTimes(1);
    expect(copyAsPngClick).not.toHaveBeenCalled();
    expect(keydownEvents).toEqual([
      expect.objectContaining({ key: "Escape", code: "Escape" }),
    ]);
    expect(exportToBlobMock).toHaveBeenCalledWith({
      elements: [imageElement],
      appState: expect.objectContaining({ exportBackground: true }),
      files: {},
      mimeType: "image/png",
    });
    const clipboardItems = clipboardWrite.mock
      .calls[0][0] as TestClipboardItem[];
    expect(clipboardItems[0].items["image/png"]).toBe(pngBlob);
    expect(screen.getByText("图片已复制")).toBeInTheDocument();
  });

  it("copies a single uncropped image from the original file data without resampling the canvas selection", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const originalBlob = new Blob(["original"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => originalBlob,
    });
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    vi.stubGlobal("fetch", fetchMock);

    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,b3JpZ2luYWw=" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 120,
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByText("复制图片"));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "data:image/png;base64,b3JpZ2luYWw=",
    );
    expect(exportToBlobMock).not.toHaveBeenCalled();
    const clipboardItems = clipboardWrite.mock
      .calls[0][0] as TestClipboardItem[];
    expect(clipboardItems[0].items["image/png"]).toBe(originalBlob);
  });

  it("copies a cropped image by rendering only the crop rectangle on a transparent canvas", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const croppedBlob = new Blob(["cropped"], { type: "image/png" });
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback) => callback(croppedBlob));
    const originalCreateElement = document.createElement.bind(document);
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: TestImage,
    });
    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (tagName === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ clearRect, drawImage }),
          toBlob,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });

    const excalidrawApi = {
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,Y3JvcA==" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 120,
          crop: { x: 20, y: 30, width: 200, height: 150 },
        },
      ],
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByText("复制图片"));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    expect(clearRect).toHaveBeenCalledWith(0, 0, 200, 150);
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(TestImage),
      20,
      30,
      200,
      150,
      0,
      0,
      200,
      150,
    );
    expect(exportToBlobMock).not.toHaveBeenCalled();
    const clipboardItems = clipboardWrite.mock
      .calls[0][0] as TestClipboardItem[];
    expect(clipboardItems[0].items["image/png"]).toBe(croppedBlob);
  });

  it("pastes the copied image blob from the system clipboard when using the context menu Paste item", async () => {
    const user = userEvent.setup();
    const copiedBlob = new Blob(["copied"], { type: "image/png" });
    const pastedBlob = new Blob(["pasted"], { type: "image/png" });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const clipboardRead = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(pastedBlob),
      },
    ]);
    const nativePasteClick = vi.fn();
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => copiedBlob,
    });
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    class TestFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(_blob: Blob) {
        this.result = "data:image/png;base64,cGFzdGVk";
        this.onload?.();
      }
    }
    class TestImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: clipboardRead, write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: TestFileReader,
    });
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: TestImage,
    });
    vi.stubGlobal("fetch", fetchMock);

    const excalidrawApi = {
      addFiles,
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
        scrollX: 0,
        scrollY: 0,
        width: 800,
        height: 600,
        zoom: { value: 1 },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,Y29waWVk" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 80,
        },
      ],
      updateScene,
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByText("复制图片"));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });

    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div class="excalidraw">
          <ul class="context-menu">
            <li data-testid="paste">
              <button type="button" class="context-menu-item">
                <div class="context-menu-item__label">Paste</div>
              </button>
            </li>
          </ul>
        </div>
      `,
    );
    document
      .querySelector('[data-testid="paste"] button')
      ?.addEventListener("click", nativePasteClick);

    await user.click(await screen.findByText("粘贴"));

    await waitFor(() => {
      expect(addFiles).toHaveBeenCalledTimes(1);
    });
    expect(nativePasteClick).not.toHaveBeenCalled();
    expect(clipboardRead).toHaveBeenCalledTimes(1);
    expect(addFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        dataURL: "data:image/png;base64,cGFzdGVk",
        mimeType: "image/png",
      }),
    ]);
    expect(updateScene).toHaveBeenCalledWith({
      elements: [
        expect.objectContaining({ id: "image-1" }),
        expect.objectContaining({
          type: "image",
          x: 300,
          y: 250,
          width: 200,
          height: 100,
        }),
      ],
      captureUpdate: "IMMEDIATELY",
    });
  });

  it("lets the native Paste run after a keyboard Copy replaces the custom image copy", async () => {
    const user = userEvent.setup();
    const copiedBlob = new Blob(["copied"], { type: "image/png" });
    const pastedBlob = new Blob(["pasted"], { type: "image/png" });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const clipboardRead = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(pastedBlob),
      },
    ]);
    const nativePasteClick = vi.fn();
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => copiedBlob,
    });
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: clipboardRead, write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    vi.stubGlobal("fetch", fetchMock);

    const excalidrawApi = {
      addFiles,
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
        scrollX: 0,
        scrollY: 0,
        width: 800,
        height: 600,
        zoom: { value: 1 },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,Y29waWVk" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 80,
        },
      ],
      updateScene,
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByText("复制图片"));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "c",
        code: "KeyC",
        metaKey: true,
        bubbles: true,
      }),
    );

    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div class="excalidraw">
          <ul class="context-menu">
            <li data-testid="paste">
              <button type="button" class="context-menu-item">
                <div class="context-menu-item__label">Paste</div>
              </button>
            </li>
          </ul>
        </div>
      `,
    );
    document
      .querySelector('[data-testid="paste"] button')
      ?.addEventListener("click", nativePasteClick);

    await user.click(await screen.findByText("粘贴"));

    expect(nativePasteClick).toHaveBeenCalledTimes(1);
    expect(clipboardRead).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
  });

  it("lets the native Paste run after a native context menu Cut replaces the custom image copy", async () => {
    const user = userEvent.setup();
    const copiedBlob = new Blob(["copied"], { type: "image/png" });
    const pastedBlob = new Blob(["pasted"], { type: "image/png" });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const clipboardRead = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(pastedBlob),
      },
    ]);
    const nativeCutClick = vi.fn();
    const nativePasteClick = vi.fn();
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => copiedBlob,
    });
    class TestClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    document.body.innerHTML = `
      <div class="excalidraw">
        <ul class="context-menu">
          <li data-testid="copy">
            <button type="button" class="context-menu-item">
              <div class="context-menu-item__label">Copy image</div>
            </button>
          </li>
        </ul>
      </div>
    `;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: clipboardRead, write: clipboardWrite },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    vi.stubGlobal("fetch", fetchMock);

    const excalidrawApi = {
      addFiles,
      getAppState: () => ({
        selectedElementIds: { "image-1": true },
        scrollX: 0,
        scrollY: 0,
        width: 800,
        height: 600,
        zoom: { value: 1 },
      }),
      getFiles: () => ({
        "file-1": { dataURL: "data:image/png;base64,Y29waWVk" },
      }),
      getSceneElements: () => [
        {
          id: "image-1",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          x: 0,
          y: 0,
          width: 120,
          height: 80,
        },
      ],
      updateScene,
    };

    render(
      <ToastProvider>
        <CanvasContextMenuExtensions excalidrawApi={excalidrawApi} />
      </ToastProvider>,
    );

    await user.click(await screen.findByText("复制图片"));
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });

    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div class="excalidraw">
          <ul class="context-menu">
            <li data-testid="cut">
              <button type="button" class="context-menu-item">
                <div class="context-menu-item__label">Cut</div>
              </button>
            </li>
          </ul>
        </div>
      `,
    );
    document
      .querySelector('[data-testid="cut"] button')
      ?.addEventListener("click", nativeCutClick);

    await user.click(await screen.findByText("Cut"));

    expect(nativeCutClick).toHaveBeenCalledTimes(1);
    document
      .querySelector('[data-testid="cut"]')
      ?.closest(".excalidraw")
      ?.remove();

    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div class="excalidraw">
          <ul class="context-menu">
            <li data-testid="paste">
              <button type="button" class="context-menu-item">
                <div class="context-menu-item__label">Paste</div>
              </button>
            </li>
          </ul>
        </div>
      `,
    );
    document
      .querySelector('[data-testid="paste"] button')
      ?.addEventListener("click", nativePasteClick);

    await user.click(await screen.findByText("粘贴"));

    expect(nativePasteClick).toHaveBeenCalledTimes(1);
    expect(clipboardRead).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
  });
});
