"use client";

import { Check, Copy } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAppTranslation } from "@/i18n";
import { ChatImage } from "./image-lightbox";
import { isImageUrl } from "./utils";

/**
 * Pre-built markdown component overrides.
 *
 * Defined as a module-level constant so every MarkdownRenderer instance
 * shares the same reference — avoids re-creating the components map on
 * every render, which would force ReactMarkdown to remount its tree.
 */
const markdownComponents: Components = {
  a({ href, children }) {
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
  pre({ children }) {
    return <MarkdownPre>{children}</MarkdownPre>;
  },
};

function MarkdownPre({
  children,
}: { children: React.ReactNode }): React.ReactElement {
  const { t } = useAppTranslation("chat");
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent?.trim();
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const label = copied ? t("markdown.codeCopied") : t("markdown.copyCode");

  return (
    <div className="group/code relative my-2">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={handleCopy}
        className="absolute right-1.5 top-1.5 z-10 inline-flex h-5 w-5 items-center justify-center rounded text-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
        )}
      </button>
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs text-foreground"
      >
        {children}
      </pre>
    </div>
  );
}

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
