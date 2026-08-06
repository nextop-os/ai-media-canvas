type TuttiBridge = {
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

function getTuttiBridge() {
  if (typeof window === "undefined") return undefined;
  return window.tuttiExternal;
}

export async function openTuttiAgentManager() {
  const openFeature = getTuttiBridge()?.workspace?.openFeature;
  if (typeof openFeature !== "function") {
    throw new Error("Tutti agent manager bridge is unavailable.");
  }

  await openFeature({ feature: "agent-manage" });
}
