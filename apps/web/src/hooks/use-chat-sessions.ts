"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatSessionSummary, ContentBlock } from "@aimc/shared";
import type { ChatMessage as ChatMessageData } from "@aimc/shared";
import {
  createSession,
  deleteSession as deleteSessionApi,
  fetchMessages,
  fetchSessions,
  updateSessionTitle,
} from "../lib/server-api";

// ── Types ────────────────────────────────────────────────────

/**
 * Strip markdown link syntax for use in session titles.
 * Converts `[@label](mention://...)` → `@label` and `[label](path)` → `label`.
 */
export function stripMarkdownForTitle(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .trim();
}

export type Message = {
  id: string;
  role: "user" | "assistant";
  contentBlocks: ContentBlock[];
};

// ── LRU message cache ────────────────────────────────────────
// Limits memory usage by evicting the least-recently-accessed
// session's messages when the cache exceeds MAX_CACHED_SESSIONS.

const MAX_CACHED_SESSIONS = 10;

type LRUMessageCache = {
  get(sessionId: string): Message[] | undefined;
  set(sessionId: string, messages: Message[]): void;
  delete(sessionId: string): void;
};

function createLRUMessageCache(): LRUMessageCache {
  // Map preserves insertion order; we move accessed keys to the end.
  const cache = new Map<string, Message[]>();

  return {
    get(sessionId) {
      const value = cache.get(sessionId);
      if (value !== undefined) {
        // Move to end (most recently used)
        cache.delete(sessionId);
        cache.set(sessionId, value);
      }
      return value;
    },

    set(sessionId, messages) {
      // Delete first so re-insert moves to end
      cache.delete(sessionId);
      cache.set(sessionId, messages);

      // Evict oldest if over capacity
      if (cache.size > MAX_CACHED_SESSIONS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
    },

    delete(sessionId) {
      cache.delete(sessionId);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

export function mapServerMessages(
  serverMessages: ChatMessageData[],
): Message[] {
  return serverMessages.map((m) => {
    let blocks: ContentBlock[];
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      blocks = m.contentBlocks;
    } else {
      blocks = [];
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.toolActivities) {
        for (const ta of m.toolActivities) {
          blocks.push({
            type: "tool",
            toolCallId: ta.toolCallId,
            toolName: ta.toolName,
            status: ta.status as "running" | "completed",
            ...(ta.input ? { input: ta.input } : {}),
            ...(ta.output ? { output: ta.output } : {}),
            ...(ta.outputSummary ? { outputSummary: ta.outputSummary } : {}),
            ...(ta.artifacts ? { artifacts: ta.artifacts } : {}),
          });
        }
      }
    }
    return { id: m.id, role: m.role, contentBlocks: blocks };
  });
}

// ── Hook ─────────────────────────────────────────────────────

type UseChatSessionsOptions = {
  canvasId: string;
  initialSessionId?: string | undefined;
  onSessionChange?: ((sessionId: string) => void) | undefined;
};

export function useChatSessions({
  canvasId,
  initialSessionId,
  onSessionChange,
}: UseChatSessionsOptions) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  // Refs to avoid stale closures in callbacks
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const messageLoadRequestRef = useRef(0);

  // LRU message cache (replaces unbounded Record)
  const msgCacheRef = useRef<LRUMessageCache>(createLRUMessageCache());

  // ── Update messages for a specific session ──
  // Always writes to cache; only syncs to React state if the session is visible.
  const updateSessionMessages = useCallback(
    (targetSessionId: string, updater: (prev: Message[]) => Message[]) => {
      const prev = msgCacheRef.current.get(targetSessionId) ?? [];
      const next = updater(prev);
      msgCacheRef.current.set(targetSessionId, next);
      if (activeSessionIdRef.current === targetSessionId) {
        setMessages(next);
      }
    },
    [],
  );

  const cancelPendingMessageLoad = useCallback(() => {
    messageLoadRequestRef.current += 1;
    setMessagesLoading(false);
  }, []);

  const loadSessionMessages = useCallback(
    async (
      sessionId: string,
      options?: {
        clearBeforeLoad?: boolean;
        fallbackToEmptyOnError?: boolean;
      },
    ) => {
      const requestId = ++messageLoadRequestRef.current;
      if (options?.clearBeforeLoad) {
        setMessages([]);
      }
      setMessagesLoading(true);
      try {
        const msgRes = await fetchMessages(sessionId);
        const mapped = mapServerMessages(msgRes.messages);
        msgCacheRef.current.set(sessionId, mapped);
        if (
          activeSessionIdRef.current === sessionId &&
          messageLoadRequestRef.current === requestId
        ) {
          setMessages(mapped);
        }
      } catch (err) {
        console.error("[chat] Failed to load session messages:", err);
        if (
          options?.fallbackToEmptyOnError &&
          activeSessionIdRef.current === sessionId &&
          messageLoadRequestRef.current === requestId
        ) {
          setMessages([]);
        }
      } finally {
        if (messageLoadRequestRef.current === requestId) {
          setMessagesLoading(false);
        }
      }
    },
    [],
  );

  // ── Load sessions on mount ──
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setSessionsLoading(true);
      try {
        const res = await fetchSessions(canvasId);
        if (cancelled) return;

        if (res.sessions.length > 0) {
          setSessions(res.sessions);
          const target = initialSessionId
            ? (res.sessions.find((s: ChatSessionSummary) => s.id === initialSessionId) ??
              res.sessions[0]!)
            : res.sessions[0]!;
          activeSessionIdRef.current = target.id;
          setActiveSessionId(target.id);
          onSessionChangeRef.current?.(target.id);
          await loadSessionMessages(target.id, {
            clearBeforeLoad: true,
            fallbackToEmptyOnError: true,
          });
          if (cancelled) return;
        } else {
          cancelPendingMessageLoad();
          const created = await createSession(canvasId);
          if (cancelled) return;
          setSessions([created.session]);
          activeSessionIdRef.current = created.session.id;
          setActiveSessionId(created.session.id);
          onSessionChangeRef.current?.(created.session.id);
          setMessages([]);
        }
      } catch {
        // Session loading failed — remain in empty state
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
    // Intentionally depends only on canvasId — onSessionChangeRef,
    // initialSessionId, and msgCacheRef are stable refs that never trigger re-runs.
    // This effect is a one-time init per canvas, not a token-refresh handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, cancelPendingMessageLoad, loadSessionMessages]);

  // ── Session switch ──
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionIdRef.current) return;
      if (streaming) setStreaming(false);
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      onSessionChangeRef.current?.(sessionId);

      const cached = msgCacheRef.current.get(sessionId);
      if (cached && cached.length > 0) {
        cancelPendingMessageLoad();
        setMessages(cached);
      } else {
        await loadSessionMessages(sessionId, {
          clearBeforeLoad: true,
          fallbackToEmptyOnError: true,
        });
      }
    },
    [cancelPendingMessageLoad, loadSessionMessages, streaming],
  );

  // ── New chat ──
  const handleNewChat = useCallback(async () => {
    if (streaming) setStreaming(false);
      try {
        cancelPendingMessageLoad();
        const res = await createSession(canvasId);
        setSessions((prev) => [res.session, ...prev]);
        activeSessionIdRef.current = res.session.id;
        setActiveSessionId(res.session.id);
        onSessionChangeRef.current?.(res.session.id);
        setMessages([]);
    } catch {
      // Silently fail
    }
  }, [canvasId, streaming]);

  // ── Delete session ──
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (streaming || !sessionId) return;
      const deletedWasActive = sessionId === activeSessionIdRef.current;

      try {
        await deleteSessionApi(sessionId);
        msgCacheRef.current.delete(sessionId);

        let nextSessions = sessionsRef.current.filter((s) => s.id !== sessionId);
        if (nextSessions.length === 0) {
          const refreshed = await fetchSessions(canvasId);
          nextSessions = refreshed.sessions;
        }
        if (nextSessions.length === 0) {
          const created = await createSession(canvasId);
          nextSessions = [created.session];
        }

        setSessions(nextSessions);

        if (!deletedWasActive) {
          return;
        }

        const nextActiveSession = nextSessions[0] ?? null;
        if (!nextActiveSession) {
          cancelPendingMessageLoad();
          activeSessionIdRef.current = null;
          setActiveSessionId(null);
          setMessages([]);
          return;
        }

        activeSessionIdRef.current = nextActiveSession.id;
        setActiveSessionId(nextActiveSession.id);
        onSessionChangeRef.current?.(nextActiveSession.id);
        const cached = msgCacheRef.current.get(nextActiveSession.id);
        if (cached && cached.length > 0) {
          cancelPendingMessageLoad();
          setMessages(cached);
        } else {
          await loadSessionMessages(nextActiveSession.id, {
            clearBeforeLoad: true,
            fallbackToEmptyOnError: true,
          });
        }
      } catch {
        // Keep the current local state intact if deletion fails.
      }
    },
    [cancelPendingMessageLoad, canvasId, loadSessionMessages, streaming],
  );

  // ── Auto-title first message ──
  const autoTitleSession = useCallback((text: string) => {
    const currentSessionId = activeSessionIdRef.current;
    if (!currentSessionId) return;
    const isFirstMessage = messagesRef.current.length === 0;
    if (!isFirstMessage) return;

    const normalized = stripMarkdownForTitle(text);
    if (!normalized) return;

    const title =
      normalized.length > 50 ? `${normalized.slice(0, 47)}...` : normalized;
    void updateSessionTitle(currentSessionId, title);
    setSessions((prev) =>
      prev.map((s) => (s.id === currentSessionId ? { ...s, title } : s)),
    );
  }, []);

  // ── Reload messages (for reconnection) ──
  const reloadMessages = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      console.warn("[chat] reloadMessages called with empty sessionId, skipping");
      return [] as Message[];
    }
    try {
      const msgRes = await fetchMessages(sessionId);
      if (msgRes.messages && msgRes.messages.length > 0) {
        const mapped = mapServerMessages(msgRes.messages);
        msgCacheRef.current.set(sessionId, mapped);
        // Only update React state if the session is still active
        // (user may have switched sessions during the async fetch)
        if (activeSessionIdRef.current === sessionId) {
          setMessages(mapped);
        }
        return mapped;
      }
    } catch (err) {
      console.warn("[chat] Failed to reload messages on reconnect:", err);
    }
    return [] as Message[];
  }, []);

  return {
    sessions,
    activeSessionId,
    activeSessionIdRef,
    messages,
    messagesRef,
    setMessages,
    sessionsLoading,
    messagesLoading,
    streaming,
    setStreaming,
    updateSessionMessages,
    handleSelectSession,
    handleNewChat,
    handleDeleteSession,
    autoTitleSession,
    reloadMessages,
  };
}
