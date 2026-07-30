import type {
  TuttiManagedGrantCreateRequest,
  TuttiManagedModel,
  TuttiManagedProviderId,
} from "@aimc/shared";
import type { TuttiExternalBridge } from "@tutti-os/workspace-external-core/contracts";

import { fetchTuttiManagedConnection } from "./server-api";

type TuttiManagedGrantResult = {
  code: string;
  contextToken?: string;
  expiresAt?: string;
  providers?: TuttiManagedProviderId[];
  models?: TuttiManagedModel[];
};

type TuttiAppContext = {
  appId?: string;
  contextToken?: string;
  installationId?: string;
  language?: unknown;
  locale?: unknown;
  workspaceId?: string;
};

type TuttiBridge = {
  agentActivity?: Partial<TuttiExternalBridge["agentActivity"]>;
  app?: {
    getContext?: () => Promise<TuttiAppContext | null> | TuttiAppContext | null;
  };
  permissions?: {
    request?: (input: {
      permission: "managed-ai-models";
      nonce: string;
      providers: TuttiManagedProviderId[];
      scopes: string[];
      state: string;
    }) => Promise<TuttiManagedGrantResult>;
  };
  settings?: {
    open?: (input: {
      tab: "models";
      provider?: TuttiManagedProviderId;
    }) => Promise<void>;
  };
  workspace?: {
    openFeature?: (input: {
      feature: "agent-manage";
    }) => Promise<void>;
  };
};

declare global {
  interface Window {
    tuttiExternal?: TuttiBridge;
  }
}

function getManagedCredentialBridge() {
  if (typeof window === "undefined") return undefined;
  return window.tuttiExternal;
}

export function hasTuttiManagedCredentialBridge() {
  const bridge = getManagedCredentialBridge();
  return (
    typeof bridge?.app?.getContext === "function" &&
    typeof bridge?.permissions?.request === "function"
  );
}

export function hasTuttiAgentManagerBridge() {
  const bridge = getManagedCredentialBridge();
  return typeof bridge?.workspace?.openFeature === "function";
}

export async function openTuttiAgentManager() {
  const openFeature = getManagedCredentialBridge()?.workspace?.openFeature;
  if (typeof openFeature !== "function") {
    throw new Error("Tutti agent manager bridge is unavailable.");
  }

  await openFeature({ feature: "agent-manage" });
}

export async function requestTuttiManagedGrant(): Promise<TuttiManagedGrantCreateRequest> {
  const bridge = getManagedCredentialBridge();
  const requestPermission = bridge?.permissions?.request;
  if (typeof requestPermission !== "function") {
    throw new Error("Tutti Managed bridge is unavailable.");
  }
  const context = await bridge?.app?.getContext?.();
  if (!context?.contextToken) {
    throw new Error("Tutti app context is unavailable.");
  }
  const connection = await fetchTuttiManagedConnection();
  if (!connection.connectChallenge) {
    throw new Error("Tutti Managed connect challenge is unavailable.");
  }
  const { nonce, state } = connection.connectChallenge;

  const result = await requestPermission({
    nonce,
    permission: "managed-ai-models",
    providers: ["agnes", "openai", "anthropic"],
    scopes: ["managed_models.models.read", "managed_models.credentials.use"],
    state,
  });

  return {
    contextToken: result.contextToken ?? context.contextToken,
    grantCode: result.code,
    nonce,
    state,
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    ...(result.providers ? { providers: result.providers } : {}),
    ...(result.models ? { models: result.models } : {}),
  };
}

export async function openTuttiManagedModelSettings(
  provider?: TuttiManagedProviderId,
) {
  const openSettings = getManagedCredentialBridge()?.settings?.open;
  if (typeof openSettings !== "function") {
    throw new Error("Tutti settings bridge is unavailable.");
  }
  await openSettings({
    tab: "models",
    ...(provider ? { provider } : {}),
  });
}
