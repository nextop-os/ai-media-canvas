// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const editorProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@tutti-os/ui-rich-text/editor", () => ({
  RichTextTriggerEditor: (props: Record<string, unknown>) => {
    editorProps.push(props);
    return <div contentEditable="true" role="textbox" tabIndex={0} />;
  },
}));

vi.mock("../src/i18n", () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

import { TuttiRichTextInput } from "../src/components/tutti-rich-text-input";

afterEach(() => {
  cleanup();
  editorProps.splice(0);
});

describe("TuttiRichTextInput mentions", () => {
  it("offers only workspace files with folder navigation", () => {
    render(
      <TuttiRichTextInput
        ariaLabel="Prompt"
        editorClassName="editor"
        onChange={() => {}}
        onSubmit={() => {}}
        placeholder="Ask"
        placeholderClassName="placeholder"
        value=""
      />,
    );

    expect(editorProps).toHaveLength(1);
    expect(editorProps[0]?.palette).toMatchObject({
      categories: [
        {
          id: "files",
          label: "input.mentionPaletteFiles",
          providerIds: ["file"],
        },
      ],
      defaultCategoryId: "files",
      directoryNavigation: {
        providerId: "file",
        labels: {
          back: "input.mentionPaletteBack",
          enter: "input.mentionPaletteEnterFolder",
          navigateHierarchy: "input.mentionPaletteNavigateHierarchy",
        },
      },
    });
  });
});
