"use client";

import type { AgentModelSource } from "@aimc/shared";
import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "aimc:agent-model";
const SOURCE_STORAGE_KEY = "aimc:agent-model-source";
const AGENT_TARGET_STORAGE_KEY = "aimc:agent-target-id";

type AgentModel = string | null; // null = let AI Canvas pick a sensible local default
type AgentModelSelection = {
  model: AgentModel;
  source: AgentModelSource | null;
  agentTargetId: string | null;
};

const EMPTY_SELECTION: AgentModelSelection = {
  model: null,
  source: null,
  agentTargetId: null,
};

// Listeners for cross-component reactivity
const listeners = new Set<() => void>();
function emitChange() {
  for (const listener of listeners) listener();
}

const AGENT_MODEL_STORAGE_KEYS = new Set([
  STORAGE_KEY,
  SOURCE_STORAGE_KEY,
  AGENT_TARGET_STORAGE_KEY,
]);

function handleStorageChange(event: StorageEvent) {
  if (event.key === null || AGENT_MODEL_STORAGE_KEYS.has(event.key)) {
    emitChange();
  }
}

// Cache parsed result -- useSyncExternalStore requires stable references
let cachedRaw: string | null | undefined;
let cachedSourceRaw: string | null | undefined;
let cachedAgentTargetRaw: string | null | undefined;
let cachedSelection: AgentModelSelection = EMPTY_SELECTION;

function normalizeSource(value: string | null): AgentModelSource | null {
  return value === "local-agent" ? value : null;
}

function getSnapshot(): AgentModelSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const sourceRaw = localStorage.getItem(SOURCE_STORAGE_KEY);
    const agentTargetRaw = localStorage.getItem(AGENT_TARGET_STORAGE_KEY);
    if (
      raw !== cachedRaw ||
      sourceRaw !== cachedSourceRaw ||
      agentTargetRaw !== cachedAgentTargetRaw
    ) {
      cachedRaw = raw;
      cachedSourceRaw = sourceRaw;
      cachedAgentTargetRaw = agentTargetRaw;
      cachedSelection = {
        model: raw || null,
        source: raw ? normalizeSource(sourceRaw) : null,
        agentTargetId:
          raw && normalizeSource(sourceRaw) === "local-agent"
            ? agentTargetRaw || null
            : null,
      };
    }
    return cachedSelection;
  } catch {
    return EMPTY_SELECTION;
  }
}

function getServerSnapshot(): AgentModelSelection {
  return EMPTY_SELECTION;
}

function subscribe(callback: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", handleStorageChange);
  }
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      window.removeEventListener("storage", handleStorageChange);
    }
  };
}

export function useAgentModel() {
  const selection = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setModel = useCallback(
    (next: AgentModel, source?: AgentModelSource, agentTargetId?: string) => {
      const exactAgentTargetId = agentTargetId?.trim();
      if (next && source === "local-agent" && !exactAgentTargetId) {
        throw new Error(
          "New local-agent model selections require an exact Agent Target ID.",
        );
      }
      if (next) {
        localStorage.setItem(STORAGE_KEY, next);
        if (source) {
          localStorage.setItem(SOURCE_STORAGE_KEY, source);
        } else {
          localStorage.removeItem(SOURCE_STORAGE_KEY);
        }
        if (source === "local-agent" && exactAgentTargetId) {
          localStorage.setItem(AGENT_TARGET_STORAGE_KEY, exactAgentTargetId);
        } else {
          localStorage.removeItem(AGENT_TARGET_STORAGE_KEY);
        }
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SOURCE_STORAGE_KEY);
        localStorage.removeItem(AGENT_TARGET_STORAGE_KEY);
      }
      emitChange();
    },
    [],
  );

  return {
    agentTargetId: selection.agentTargetId,
    model: selection.model,
    modelSource: selection.source,
    setModel,
  };
}
