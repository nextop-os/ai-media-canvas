import { describe, expect, it } from "vitest";

import { loadTuttiAgentTargetIconUrls } from "./tutti-agent-target-presentations";

describe("Tutti agent target presentations", () => {
  it("indexes host icons by exact agentTargetId", async () => {
    const icons = await loadTuttiAgentTargetIconUrls({
      agentActivity: {
        listTargets: async () => ({
          agents: [
            {
              agentTargetId: "local:tutti-agent",
              availability: { status: "ready" },
              description: null,
              iconUrl: "data:image/webp;base64,tutti",
              name: "Tutti Agent",
              provider: "tutti-agent",
            },
          ],
          capturedAtUnixMs: 123,
          error: null,
          status: "ready",
        }),
      },
    });

    expect(icons.get("local:tutti-agent")).toBe("data:image/webp;base64,tutti");
    expect(icons.has("team:tutti-agent")).toBe(false);
  });

  it("falls back to an empty presentation map when the bridge rejects", async () => {
    await expect(
      loadTuttiAgentTargetIconUrls({
        agentActivity: {
          listTargets: async () => {
            throw new Error("old host");
          },
        },
      }),
    ).resolves.toEqual(new Map());
  });
});
