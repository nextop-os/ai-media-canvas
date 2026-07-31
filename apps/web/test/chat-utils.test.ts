import { describe, expect, it } from "vitest";

import { formatModelDisplayName, getToolConfig } from "../src/components/chat/utils";
import { stripMarkdownForTitle } from "../src/hooks/use-chat-sessions";

describe("chat utils", () => {
  it("keeps GPT uppercase when formatting GPT image model ids", () => {
    expect(formatModelDisplayName("codex/gpt-image-2")).toBe("GPT Image 2");
  });

  it("shows a card for the task tool so details are viewable", () => {
    expect(getToolConfig("task").showCard).toBe(true);
  });
});

describe("stripMarkdownForTitle", () => {
  it("strips mention:// links down to their label", () => {
    const input = "[@Task Management](mention://agent-session/test?foo=bar)";
    expect(stripMarkdownForTitle(input)).toBe("@Task Management");
  });

  it("strips workspace file links down to their label", () => {
    const input = "[README.md](README.md)";
    expect(stripMarkdownForTitle(input)).toBe("README.md");
  });

  it("leaves plain text unchanged", () => {
    expect(stripMarkdownForTitle("Hello world")).toBe("Hello world");
  });

  it("handles mixed content with links and plain text", () => {
    const input = "[@Task Management](mention://x/y) please help";
    expect(stripMarkdownForTitle(input)).toBe("@Task Management please help");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(stripMarkdownForTitle("   ")).toBe("");
  });
});
