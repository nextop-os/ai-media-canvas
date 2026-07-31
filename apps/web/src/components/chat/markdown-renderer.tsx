"use client";

import React, { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChatImage } from "./image-lightbox";
import { isImageUrl } from "./utils";

/**
 * Pre-built markdown component overrides.
 *
 * Defined as a module-level constant so every MarkdownRenderer instance
 * shares the same reference — avoids re-creating the components map on
 * every render, which would force ReactMarkdown to remount its tree.
 */
const MENTION_HREF_PREFIX = /^mention:\/\//i;

const markdownComponents: Components = {
  a({ href, children }) {
    if (href && MENTION_HREF_PREFIX.test(href)) {
      return (
        <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[0.85em] font-medium text-foreground align-baseline">
          {children}
        </span>
      );
    }
    if (href && isImageUrl(href)) {
      return (
        <ChatImage
          src={href}
          alt={typeof children === "string" ? children : "Image"}
          className="my-2 max-w-[280px] rounded-lg border border-border"
        />
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground underline break-all"
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return (
      <ChatImage
        src={typeof src === "string" ? src : ""}
        alt={alt ?? "Image"}
        className="my-2 max-w-[280px] rounded-lg border border-border"
      />
    );
  },
};

/** Stable remarkPlugins array to prevent ReactMarkdown remount */
const remarkPlugins = [remarkGfm];

type MarkdownRendererProps = {
  /** Raw markdown text to render */
  text: string;
};

/**
 * Memoized markdown renderer for chat messages.
 *
 * Performance notes:
 * - remarkPlugins and components are module-level constants (no re-creation)
 * - React.memo prevents re-render when text hasn't changed
 * - During streaming, text changes every delta — the memo check is O(1) string comparison
 */
export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  text,
}: MarkdownRendererProps) {
  // Guard against empty/whitespace-only text producing empty markdown output
  const safeText = text || "";

  return (
    <div className="markdown-content text-sm leading-[1.6] text-foreground">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
      >
        {safeText}
      </ReactMarkdown>
    </div>
  );
});
