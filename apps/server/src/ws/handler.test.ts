import { describe, expect, it, vi } from "vitest";

import { resolveRunAgentTargetIdentity } from "./handler.js";

describe("resolveRunAgentTargetIdentity", () => {
  it("always resolves an exact target instead of trusting the model provider", async () => {
    const resolver = vi.fn().mockResolvedValue({
      agentTargetId: "extension:kimi-code",
      providerId: "kimi",
    });

    await resolveRunAgentTargetIdentity(
      {
        agentTargetId: "extension:kimi-code",
        model: "kimi:moonshot-v1",
      },
      undefined,
      resolver,
    );

    expect(resolver).toHaveBeenCalledWith({
      agentTargetId: "extension:kimi-code",
    });
  });

  it("uses model provider inference only when no exact target was selected", async () => {
    const resolver = vi.fn().mockResolvedValue({
      agentTargetId: "local:kimi",
      providerId: "kimi",
    });

    await resolveRunAgentTargetIdentity(
      { model: "kimi:moonshot-v1" },
      undefined,
      resolver,
    );

    expect(resolver).toHaveBeenCalledWith({ providerId: "kimi" });
  });
});
