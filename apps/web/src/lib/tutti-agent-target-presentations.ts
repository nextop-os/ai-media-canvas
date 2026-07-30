"use client";

import type {
  TuttiExternalAgentTargetCatalog,
  TuttiExternalBridge,
} from "@tutti-os/workspace-external-core/contracts";
import { useEffect, useState } from "react";

type AgentActivityBridge = {
  agentActivity?: {
    listTargets?: () => Promise<TuttiExternalAgentTargetCatalog>;
  };
};

export async function loadTuttiAgentTargetIconUrls(
  bridge: AgentActivityBridge | null = readTuttiExternalBridge(),
): Promise<ReadonlyMap<string, string>> {
  const listTargets = bridge?.agentActivity?.listTargets;
  if (typeof listTargets !== "function") return new Map();

  try {
    const catalog = await listTargets();
    return new Map(
      catalog.agents.flatMap((agent) => {
        const agentTargetId = agent.agentTargetId.trim();
        const iconUrl = agent.iconUrl.trim();
        return agentTargetId && iconUrl
          ? [[agentTargetId, iconUrl] as const]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

export function useTuttiAgentTargetIconUrls(): ReadonlyMap<string, string> {
  const [iconUrls, setIconUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  useEffect(() => {
    let active = true;
    void loadTuttiAgentTargetIconUrls().then((next) => {
      if (active) setIconUrls(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return iconUrls;
}

function readTuttiExternalBridge(): AgentActivityBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (window.tuttiExternal as Partial<TuttiExternalBridge> | undefined) ?? null
  );
}
