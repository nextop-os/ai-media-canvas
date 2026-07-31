"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useAppTranslation } from "../i18n";
import {
  createExcalidrawImageElement,
  getViewportCenter,
  scaleToFit,
} from "../lib/canvas-elements";
import { withNormalizedCanvasElementIndices } from "../lib/canvas-normalize";
import {
  createPngDownloadFilename,
  downloadPngFile,
} from "../lib/image-download";
import { useToast } from "./toast";

type CanvasContextMenuExtensionsProps = {
  // biome-ignore lint/suspicious/noExplicitAny: Excalidraw API has no public type definition
  excalidrawApi: any;
};

type CanvasContextMenuApi = {
  addFiles?: (
    files: Array<{
      id: string;
      dataURL: string;
      mimeType: string;
      created: number;
    }>,
  ) => void;
  getAppState: () => {
    selectedElementIds?: Record<string, boolean>;
  } & Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  getSceneElements: () => readonly Record<string, unknown>[];
  updateScene?: (scene: {
    elements: Record<string, unknown>[];
    captureUpdate?: string;
  }) => void;
};

function getNativeContextMenu() {
  return document.querySelector<HTMLUListElement>(".excalidraw .context-menu");
}

const SECTION_START_LABELS = new Set(["Crop image", "Duplicate"]);
const HIDDEN_NATIVE_CONTEXT_MENU_TEST_IDS = new Set(["copyAsPng"]);
const IMAGE_CLIPBOARD_PASTE_WINDOW_MS = 2 * 60 * 1000;
const NATIVE_CONTEXT_MENU_LABEL_KEYS: Record<string, string> = {
  "Canvas & Shape properties":
    "canvas:contextMenu.native.canvasAndShapeProperties",
  Copy: "canvas:contextMenu.native.copyNode",
  "Copy image": "canvas:contextMenu.native.copyImage",
  "Copy to clipboard as PNG": "canvas:contextMenu.native.copyImage",
  "Copy link to object": "canvas:contextMenu.native.copyLinkToObject",
  "Crop image": "canvas:contextMenu.native.cropImage",
  Duplicate: "canvas:contextMenu.native.duplicate",
  Paste: "canvas:contextMenu.native.paste",
  "Select all": "canvas:contextMenu.native.selectAll",
  "Snap to objects": "canvas:contextMenu.native.snapToObjects",
  "Toggle grid": "canvas:contextMenu.native.toggleGrid",
  "View mode": "canvas:contextMenu.native.viewMode",
  "Wrap selection in frame": "canvas:contextMenu.native.wrapSelectionInFrame",
  "Zen mode": "canvas:contextMenu.native.zenMode",
  拷贝: "canvas:contextMenu.native.copyNode",
  "复制为 PNG 到剪贴板": "canvas:contextMenu.native.copyImage",
  复制: "canvas:contextMenu.native.duplicate",
};

let lastAimcImageClipboardWriteAt = 0;

function resetImageClipboardPasteMarker() {
  lastAimcImageClipboardWriteAt = 0;
}

function isCanvasContextMenuApi(
  excalidrawApi: CanvasContextMenuExtensionsProps["excalidrawApi"],
): excalidrawApi is CanvasContextMenuApi {
  return (
    typeof excalidrawApi?.getAppState === "function" &&
    typeof excalidrawApi?.getFiles === "function" &&
    typeof excalidrawApi?.getSceneElements === "function"
  );
}

function isImageCopyContextMenuItem(item: HTMLLIElement) {
  const originalLabel = getContextMenuItemOriginalLabel(item);
  return (
    NATIVE_CONTEXT_MENU_LABEL_KEYS[originalLabel] ===
    "canvas:contextMenu.native.copyImage"
  );
}

function hideNativeContextMenuItems(menuElement: HTMLUListElement) {
  for (const item of menuElement.querySelectorAll<HTMLLIElement>("li")) {
    if (
      item.dataset.testid &&
      HIDDEN_NATIVE_CONTEXT_MENU_TEST_IDS.has(item.dataset.testid)
    ) {
      item.hidden = true;
    }
  }
}

function getContextMenuItemOriginalLabel(item: HTMLLIElement) {
  return (
    item.querySelector<HTMLElement>(".context-menu-item__label")?.dataset
      .aimcOriginalLabel ??
    item
      .querySelector<HTMLElement>(".context-menu-item__label")
      ?.textContent?.trim() ??
    ""
  );
}

function hideUnsupportedNativeImageCopyItem(
  menuElement: HTMLUListElement,
  excalidrawApi: CanvasContextMenuApi | null,
) {
  for (const item of menuElement.querySelectorAll<HTMLLIElement>(
    'li[data-testid="copy"]',
  )) {
    item.hidden =
      isImageCopyContextMenuItem(item) &&
      (!excalidrawApi || !canCopySelectionAsImage(excalidrawApi));
  }
}

function markContextMenuSections(menuElement: HTMLUListElement) {
  for (const item of menuElement.querySelectorAll<HTMLLIElement>(
    "li.aimc-context-menu-section-start",
  )) {
    if (item.dataset.testid !== "downloadImage") {
      item.classList.remove("aimc-context-menu-section-start");
    }
  }

  for (const item of menuElement.querySelectorAll<HTMLLIElement>("li")) {
    const label =
      item.querySelector<HTMLElement>(".context-menu-item__label")?.dataset
        .aimcOriginalLabel ??
      item
        .querySelector<HTMLElement>(".context-menu-item__label")
        ?.textContent?.trim();

    if (label && SECTION_START_LABELS.has(label)) {
      item.classList.add("aimc-context-menu-section-start");
    }
  }
}

function localizeNativeContextMenuLabels(
  menuElement: HTMLUListElement,
  t: (key: string) => string,
) {
  for (const labelElement of menuElement.querySelectorAll<HTMLElement>(
    ".context-menu-item__label",
  )) {
    const originalLabel =
      labelElement.dataset.aimcOriginalLabel ??
      labelElement.textContent?.trim();
    if (!originalLabel) continue;

    const translationKey = NATIVE_CONTEXT_MENU_LABEL_KEYS[originalLabel];
    if (!translationKey) continue;

    labelElement.dataset.aimcOriginalLabel = originalLabel;
    const localizedLabel = t(translationKey);
    if (labelElement.textContent !== localizedLabel) {
      labelElement.textContent = localizedLabel;
    }
  }
}

function getSelectedElements(excalidrawApi: CanvasContextMenuApi) {
  const appState = excalidrawApi.getAppState();
  const selectedIds = Object.entries(appState.selectedElementIds ?? {}).flatMap(
    ([id, selected]) => (selected ? [id] : []),
  );
  if (selectedIds.length === 0) return [];

  const selectedIdSet = new Set(selectedIds);
  return excalidrawApi
    .getSceneElements()
    .filter(
      (element: Record<string, unknown>) =>
        !element.isDeleted && selectedIdSet.has(element.id as string),
    );
}

function canCopySelectionAsImage(excalidrawApi: CanvasContextMenuApi) {
  const selectedElements = getSelectedElements(excalidrawApi);
  return (
    selectedElements.length > 0 &&
    selectedElements.every(
      (element: Record<string, unknown>) => element.type === "image",
    )
  );
}

function canPasteCopiedImageFromClipboard(excalidrawApi: CanvasContextMenuApi) {
  return (
    typeof excalidrawApi.addFiles === "function" &&
    typeof excalidrawApi.updateScene === "function" &&
    Date.now() - lastAimcImageClipboardWriteAt < IMAGE_CLIPBOARD_PASTE_WINDOW_MS
  );
}

function getLiveElements(excalidrawApi: CanvasContextMenuApi) {
  return excalidrawApi
    .getSceneElements()
    .filter((element: Record<string, unknown>) => !element.isDeleted);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getElementDownloadName(element: Record<string, unknown>) {
  const customData = asRecord(element.customData);
  const title = customData?.title;
  if (typeof title === "string" && title.trim()) return title;
  const label = customData?.label;
  return typeof label === "string" && label.trim() ? label : null;
}

function getElementDownloadId(element: Record<string, unknown>) {
  return typeof element.id === "string" && element.id.trim()
    ? element.id
    : "image";
}

function getImageDownloadFilename(
  elements: readonly Record<string, unknown>[],
) {
  if (elements.length === 1) {
    const element = elements[0];
    return createPngDownloadFilename({
      name: element ? getElementDownloadName(element) : null,
      fallbackBaseName: `ai-media-canvas-${element ? getElementDownloadId(element) : "image"}`,
    });
  }

  const selectionId = elements.map(getElementDownloadId).slice(0, 3).join("-");
  return createPngDownloadFilename({
    fallbackBaseName: selectionId
      ? `ai-media-canvas-selection-${selectionId}`
      : "ai-media-canvas-selection",
  });
}

async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("Unable to read image data.");
  }
  return await response.blob();
}

async function dataUrlFromBlob(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read clipboard image."));
      }
    };
    reader.onerror = () => reject(new Error("Unable to read clipboard image."));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load image data."));
    image.src = dataUrl;
  });
}

async function createCroppedImageBlob(
  dataUrl: string,
  crop: Record<string, unknown>,
) {
  const image = await loadImage(dataUrl);
  const sourceX = numberValue(crop.x) ?? 0;
  const sourceY = numberValue(crop.y) ?? 0;
  const sourceWidth = Math.max(
    1,
    numberValue(crop.width) ?? image.naturalWidth,
  );
  const sourceHeight = Math.max(
    1,
    numberValue(crop.height) ?? image.naturalHeight,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth);
  canvas.height = Math.round(sourceHeight);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create image canvas.");
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Unable to export cropped image."));
      }
    }, "image/png");
  });
}

async function exportSelectionToPngBlob(
  excalidrawApi: CanvasContextMenuApi,
  selectedElements: readonly Record<string, unknown>[],
) {
  const appState = excalidrawApi.getAppState();
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  return exportToBlob({
    elements: selectedElements as never,
    appState: { ...appState, exportBackground: true },
    files: excalidrawApi.getFiles() as never,
    mimeType: "image/png",
  });
}

async function exportSelectedImageToPngBlob(
  excalidrawApi: CanvasContextMenuApi,
  selectedElements: readonly Record<string, unknown>[],
) {
  if (selectedElements.length === 1) {
    const element = selectedElements[0];
    if (!element) {
      return exportSelectionToPngBlob(excalidrawApi, selectedElements);
    }
    const fileId = typeof element.fileId === "string" ? element.fileId : null;
    const file = fileId ? asRecord(excalidrawApi.getFiles()[fileId]) : null;
    const dataUrl = typeof file?.dataURL === "string" ? file.dataURL : null;
    if (dataUrl) {
      const crop = asRecord(element.crop);
      return crop
        ? createCroppedImageBlob(dataUrl, crop)
        : blobFromDataUrl(dataUrl);
    }
  }

  return exportSelectionToPngBlob(excalidrawApi, selectedElements);
}

function getSingleUncroppedImageDataUrl(
  excalidrawApi: CanvasContextMenuApi,
  selectedElements: readonly Record<string, unknown>[],
) {
  if (selectedElements.length !== 1) return null;

  const element = selectedElements[0];
  if (!element || element.type !== "image" || element.crop) return null;

  const fileId = typeof element.fileId === "string" ? element.fileId : null;
  const file = fileId ? asRecord(excalidrawApi.getFiles()[fileId]) : null;
  return typeof file?.dataURL === "string" ? file.dataURL : null;
}

async function copySelectedImagesToClipboard(
  excalidrawApi: CanvasContextMenuApi,
) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("PNG clipboard writes are not supported in this browser.");
  }

  const selectedElements = getSelectedElements(excalidrawApi);
  const pngBlob = await exportSelectedImageToPngBlob(
    excalidrawApi,
    selectedElements,
  );
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": pngBlob,
    }),
  ]);
  lastAimcImageClipboardWriteAt = Date.now();
}

async function readImageBlobFromClipboard(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) {
    throw new Error("Clipboard reads are not supported in this browser.");
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) {
      return await item.getType(imageType);
    }
  }
  return null;
}

function generateFileId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

async function pasteClipboardImageToCanvas(
  excalidrawApi: CanvasContextMenuApi,
) {
  if (
    typeof excalidrawApi.addFiles !== "function" ||
    typeof excalidrawApi.updateScene !== "function"
  ) {
    throw new Error("Canvas paste API is unavailable.");
  }

  const blob = await readImageBlobFromClipboard();
  if (!blob) {
    throw new Error("Clipboard does not contain an image.");
  }

  const dataURL = await dataUrlFromBlob(blob);
  const image = await loadImage(dataURL);
  const dimensions = scaleToFit(image.naturalWidth, image.naturalHeight, 600);
  const center = getViewportCenter(
    excalidrawApi.getAppState() as {
      scrollX: number;
      scrollY: number;
      width: number;
      height: number;
      zoom: { value: number };
    },
  );
  const fileId = generateFileId();

  excalidrawApi.addFiles([
    {
      id: fileId,
      dataURL,
      mimeType: blob.type || "image/png",
      created: Date.now(),
    },
  ]);

  const element = createExcalidrawImageElement({
    fileId,
    x: center.x - dimensions.width / 2,
    y: center.y - dimensions.height / 2,
    width: dimensions.width,
    height: dimensions.height,
    source: "uploaded",
  });

  excalidrawApi.updateScene({
    elements: withNormalizedCanvasElementIndices([
      ...excalidrawApi.getSceneElements(),
      element,
    ]),
    captureUpdate: "IMMEDIATELY",
  });
}

function closeNativeContextMenu(triggerElement?: HTMLElement | null) {
  const target =
    triggerElement ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body);
  target.blur();
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
    }),
  );
  getNativeContextMenu()?.remove();
}

function attachImageCopyHandler(
  imageCopyItem: HTMLLIElement,
  excalidrawApi: CanvasContextMenuApi,
  onImageCopied: () => void,
  onImageCopyFailed: () => void,
) {
  const copyButton = imageCopyItem.querySelector<HTMLButtonElement>("button");
  if (!copyButton) return false;

  copyButton.addEventListener("click", () => {
    const copyPromise = copySelectedImagesToClipboard(excalidrawApi);
    closeNativeContextMenu(copyButton);
    void copyPromise.then(onImageCopied).catch((error) => {
      console.warn("[canvas-context-menu] copy image failed:", error);
      onImageCopyFailed();
    });
  });
  return true;
}

function setImageCopyMenuItemLabel(
  imageCopyItem: HTMLLIElement,
  copyImageLabel: string,
) {
  const label = imageCopyItem.querySelector<HTMLElement>(
    ".context-menu-item__label",
  );
  if (!label) return;

  label.dataset.aimcOriginalLabel = "Copy image";
  label.textContent = copyImageLabel;
}

function syncImageCopyContextMenuItem(
  menuElement: HTMLUListElement,
  excalidrawApi: CanvasContextMenuApi,
  copyImageLabel: string,
  onImageCopied: () => void,
  onImageCopyFailed: () => void,
) {
  const existingCustomImageCopy = menuElement.querySelector<HTMLLIElement>(
    'li[data-testid="aimcCopyImage"]',
  );
  if (!canCopySelectionAsImage(excalidrawApi)) {
    existingCustomImageCopy?.remove();
    return;
  }
  if (existingCustomImageCopy) return;

  const copyItem = menuElement.querySelector<HTMLLIElement>(
    'li[data-testid="copy"]',
  );
  if (!copyItem || copyItem.dataset.aimcCopyImageItem === "true") return;

  const imageCopyItem = copyItem.cloneNode(true) as HTMLLIElement;
  imageCopyItem.dataset.testid = "aimcCopyImage";
  imageCopyItem.dataset.aimcCopyImageItem = "true";
  setImageCopyMenuItemLabel(imageCopyItem, copyImageLabel);
  if (
    !attachImageCopyHandler(
      imageCopyItem,
      excalidrawApi,
      onImageCopied,
      onImageCopyFailed,
    )
  ) {
    return;
  }

  if (isImageCopyContextMenuItem(copyItem)) {
    copyItem.replaceWith(imageCopyItem);
  } else {
    copyItem.after(imageCopyItem);
  }
}

function resetImageClipboardMarkerOnNativeClipboardActions(
  menuElement: HTMLUListElement,
) {
  const nativeClipboardButtons =
    menuElement.querySelectorAll<HTMLButtonElement>(
      'li[data-testid="copy"] button, li[data-testid="cut"] button',
    );

  for (const button of nativeClipboardButtons) {
    if (button.dataset.aimcNativeClipboardHandler === "true") continue;

    button.dataset.aimcNativeClipboardHandler = "true";
    button.addEventListener("click", resetImageClipboardPasteMarker, true);
  }
}

function interceptImagePasteContextMenuItem(
  menuElement: HTMLUListElement,
  excalidrawApi: CanvasContextMenuApi,
  onImagePasteFailed: () => void,
) {
  const pasteButton = menuElement.querySelector<HTMLButtonElement>(
    'li[data-testid="paste"] button',
  );
  if (!pasteButton || pasteButton.dataset.aimcPasteImageHandler === "true") {
    return;
  }

  pasteButton.dataset.aimcPasteImageHandler = "true";
  pasteButton.addEventListener(
    "click",
    (event) => {
      if (!canPasteCopiedImageFromClipboard(excalidrawApi)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const pastePromise = pasteClipboardImageToCanvas(excalidrawApi);
      closeNativeContextMenu(pasteButton);
      void pastePromise.catch((error) => {
        console.warn("[canvas-context-menu] paste image failed:", error);
        onImagePasteFailed();
      });
    },
    true,
  );
}

export function CanvasContextMenuExtensions({
  excalidrawApi,
}: CanvasContextMenuExtensionsProps) {
  const { t } = useAppTranslation("canvas");
  const { success: toastSuccess, error: toastError } = useToast();
  const [menuElement, setMenuElement] = useState<HTMLUListElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        ["c", "x"].includes(event.key.toLowerCase())
      ) {
        resetImageClipboardPasteMarker();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  useEffect(() => {
    const syncMenuElement = () => {
      const nativeMenuElement = getNativeContextMenu();
      if (nativeMenuElement) {
        const canvasContextMenuApi = isCanvasContextMenuApi(excalidrawApi)
          ? excalidrawApi
          : null;
        hideNativeContextMenuItems(nativeMenuElement);
        hideUnsupportedNativeImageCopyItem(
          nativeMenuElement,
          canvasContextMenuApi,
        );
        markContextMenuSections(nativeMenuElement);
        localizeNativeContextMenuLabels(nativeMenuElement, t);
        if (canvasContextMenuApi) {
          resetImageClipboardMarkerOnNativeClipboardActions(nativeMenuElement);
          syncImageCopyContextMenuItem(
            nativeMenuElement,
            canvasContextMenuApi,
            t("contextMenu.native.copyImage"),
            () => {
              toastSuccess(t("contextMenu.copyImageSuccess"));
            },
            () => {
              toastError(t("contextMenu.copyImageFailed"));
            },
          );
          interceptImagePasteContextMenuItem(
            nativeMenuElement,
            canvasContextMenuApi,
            () => {
              toastError(t("contextMenu.copyImageFailed"));
            },
          );
        }
      }
      setMenuElement(nativeMenuElement);
    };
    syncMenuElement();

    const observer = new MutationObserver(syncMenuElement);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [excalidrawApi, t, toastError, toastSuccess]);

  const handleDownloadImage = useCallback(
    async (triggerElement: HTMLElement) => {
      closeNativeContextMenu(triggerElement);
      if (!isCanvasContextMenuApi(excalidrawApi)) return;

      const selectedElements = getSelectedElements(excalidrawApi);
      const elements =
        selectedElements.length > 0
          ? selectedElements
          : getLiveElements(excalidrawApi);
      if (elements.length === 0) return;

      const filename = getImageDownloadFilename(elements);

      try {
        const dataUrl = getSingleUncroppedImageDataUrl(excalidrawApi, elements);
        const result = await downloadPngFile({
          filename,
          source:
            dataUrl ??
            (await exportSelectedImageToPngBlob(excalidrawApi, elements)),
        });
        if (result === "saved") {
          toastSuccess(t("files.downloadSuccess"));
        } else if (result === "started") {
          toastSuccess(t("files.downloadStarted"));
        }
      } catch (error) {
        console.warn("[canvas-context-menu] download image failed:", error);
        toastError(t("files.downloadFailed"));
      }
    },
    [excalidrawApi, t, toastError, toastSuccess],
  );

  if (!menuElement) return null;

  return createPortal(
    <li className="aimc-context-menu-section-start" data-testid="downloadImage">
      <button
        type="button"
        className="context-menu-item"
        onClick={(event) => {
          void handleDownloadImage(event.currentTarget);
        }}
      >
        <div className="context-menu-item__label">
          {t("contextMenu.downloadImage")}
        </div>
        <kbd className="context-menu-item__shortcut" />
      </button>
    </li>,
    menuElement,
  );
}
