// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RichTextMentionServiceProvider,
  RichTextReadonlyContent,
} from "@tutti-os/ui-rich-text/editor";
import { TooltipProvider } from "@tutti-os/ui-system/components";
import {
  type TuttiExternalAtRichTextBridge,
  createTuttiExternalRichTextMentionService,
} from "@tutti-os/workspace-external-core/rich-text";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@tutti-os/ui-rich-text/editor");

vi.mock("../src/i18n", () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

import { TuttiRichTextInput } from "../src/components/tutti-rich-text-input";

const rootFolder = {
  providerId: "file" as const,
  itemId: "/workspace/reference-assets",
  label: "reference-assets",
  subtitle: "/workspace/reference-assets",
  directory: { path: "/workspace/reference-assets", childCount: 1 },
  insert: {
    kind: "markdown-link" as const,
    label: "reference-assets",
    href: "/workspace/reference-assets/",
  },
};

const childFile = {
  providerId: "file" as const,
  itemId: "/workspace/reference-assets/logo.svg",
  label: "logo.svg",
  subtitle: "/workspace/reference-assets/logo.svg",
  insert: {
    kind: "markdown-link" as const,
    label: "logo.svg",
    href: "/workspace/reference-assets/logo.svg",
  },
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollBy = vi.fn();
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1, 1);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tutti file mention integration", () => {
  it("uses the host directory bridge to enter and leave folders, then writes only the folder path into the prompt", async () => {
    const queryDirectory = vi.fn<
      NonNullable<TuttiExternalAtRichTextBridge["at"]>["queryDirectory"]
    >(async ({ directoryPath }) =>
      directoryPath === "/workspace/reference-assets"
        ? [childFile]
        : [rootFolder],
    );
    const service = createTuttiExternalRichTextMentionService({
      getBridge: () => ({
        at: {
          query: async () => [],
          queryDirectory,
        },
      }),
      providerIds: ["file"],
    });
    const onChange = vi.fn();

    const view = render(
      <TooltipProvider>
        <RichTextMentionServiceProvider service={service}>
          <TuttiRichTextInput
            ariaLabel="Prompt"
            editorClassName="editor"
            onChange={onChange}
            onSubmit={() => {}}
            placeholder="Ask"
            placeholderClassName="placeholder"
            value=""
          />
        </RichTextMentionServiceProvider>
      </TooltipProvider>,
    );

    const editor = await screen.findByRole("textbox", { name: "Prompt" });
    editor.focus();
    await userEvent.setup().keyboard("@");

    await waitFor(() =>
      expect(queryDirectory).toHaveBeenCalledWith({
        directoryPath: "",
        maxResults: 30,
        providerId: "file",
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "input.mentionPaletteEnterFolder",
      }),
    );
    await waitFor(() =>
      expect(queryDirectory).toHaveBeenCalledWith({
        directoryPath: "/workspace/reference-assets",
        maxResults: 30,
        providerId: "file",
      }),
    );
    expect(await screen.findByText("logo.svg")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "input.mentionPaletteBack" }),
    );
    await waitFor(() => expect(queryDirectory).toHaveBeenCalledTimes(3));

    fireEvent.click(await screen.findByText("reference-assets"));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[reference-assets](/workspace/reference-assets/)",
      ),
    );

    view.unmount();
    service.dispose();
  });

  it("keeps historical app and agent mentions readable without enabling their query providers", async () => {
    const service = createTuttiExternalRichTextMentionService({
      getBridge: () => ({ at: { query: async () => [] } }),
      providerIds: ["file"],
    });

    const view = render(
      <RichTextMentionServiceProvider service={service}>
        <RichTextReadonlyContent
          value={[
            "[@Canvas](mention://workspace-app/ai-media-canvas)",
            "[@Codex](mention://agent-target/local:codex)",
          ].join(" ")}
        />
      </RichTextMentionServiceProvider>,
    );

    expect(await screen.findByText("Canvas")).toBeTruthy();
    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(service.listProviders().map((provider) => provider.id)).toEqual([
      "file",
    ]);

    view.unmount();
    service.dispose();
  });
});
