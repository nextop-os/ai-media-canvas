import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const globalsCss = fs.readFileSync(
  path.resolve(__dirname, "../src/app/globals.css"),
  "utf8",
);

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = globalsCss.match(new RegExp(`${escapedSelector}\\s*{[^}]+}`));
  return match?.[0] ?? "";
}

describe("rich text mention layout", () => {
  it("keeps mention atoms on the same inline baseline as editor text", () => {
    const mentionReferenceRule = cssRule(
      ".aimc-rich-text-editor [data-rich-text-mention-reference],\n.aimc-rich-text-editor [data-rich-text-workspace-reference]",
    );

    expect(mentionReferenceRule).toContain("display: inline-flex");
    expect(mentionReferenceRule).toContain("align-items: center");
    expect(mentionReferenceRule).toContain("vertical-align: baseline");
    expect(mentionReferenceRule).not.toContain("vertical-align: middle");
  });

  it("keeps mention pills visually neutral and text-height aligned", () => {
    const pillRule = cssRule(
      '.aimc-rich-text-editor [data-rich-text-mention-reference] > span,\n.aimc-rich-text-editor [data-slot="mention-pill"]',
    );

    expect(pillRule).toContain("position: relative");
    expect(pillRule).toContain("top: 3px");
    expect(pillRule).toContain("border-width: 0");
    expect(pillRule).toContain("background: transparent");
    expect(pillRule).toContain("padding: 2px 6px");
    expect(pillRule).toContain("font-size: 13px");
    expect(pillRule).toContain("line-height: 20px");
    expect(pillRule).toContain("vertical-align: baseline");
    expect(pillRule).not.toMatch(/(^|\n)\s*height:\s*20px;/);
    expect(pillRule).not.toContain("vertical-align: middle");
  });

  it("does not add an app-specific selected background to mention pills", () => {
    const selectedRule = cssRule(
      '.aimc-rich-text-editor [data-rich-text-mention-reference].is-selected > span,\n.aimc-rich-text-editor\n  [data-rich-text-workspace-reference].is-selected\n  [data-slot="mention-pill"]',
    );

    expect(selectedRule).toContain("background: transparent");
    expect(selectedRule).toContain("box-shadow: none");
  });

  it("maps the host theme directly onto the shared mention palette", () => {
    const menuRule = cssRule(
      ".tutti-rich-text-at-menu:has(.rich-text-at-mention-palette)",
    );
    const paletteRule = cssRule(
      ".tutti-rich-text-at-menu:has(.rich-text-at-mention-palette)\n  .rich-text-at-mention-palette",
    );

    expect(menuRule).not.toContain("--rich-text-at-mention-text-secondary");
    expect(paletteRule).toContain(
      "--rich-text-at-mention-text-secondary: var(--muted-foreground)",
    );
    expect(paletteRule).toContain(
      "--rich-text-at-mention-text-tertiary: color-mix(",
    );
    expect(paletteRule).toContain("--background-fronted: var(--popover)");
    expect(paletteRule).toContain("--text-secondary: var(--muted-foreground)");
    expect(paletteRule).toContain("--state-danger: var(--destructive)");
    expect(paletteRule).toContain("--state-success: var(--success)");
    expect(paletteRule).toContain("--state-warning: var(--warning)");
    expect(paletteRule).toContain("--status-running: var(--info)");
  });
});
