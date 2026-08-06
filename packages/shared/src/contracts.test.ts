import { describe, expect, it } from "vitest";

import {
  applicationErrorResponseSchema,
  canvasGetResponseSchema,
  canvasSaveRequestSchema,
  codexImagegenDelegationSchema,
  modelListRequestSchema,
  modelListResponseSchema,
  runCreateRequestSchema,
  workspaceSettingsSchema,
} from "./index.js";

const baseRunCreateRequest = {
  conversationId: "canvas_1",
  prompt: "Generate an image",
  sessionId: "session_1",
};

describe("runCreateRequestSchema", () => {
  it("requires an exact target or compatibility provider for local-agent runtime", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      runtimeKind: "local-agent",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "runtimeKind=local-agent requires agentTargetId or deprecated runtimeProvider.",
          path: ["agentTargetId"],
        }),
      ]),
    );
  });

  it("accepts exact Agent Target IDs", () => {
    expect(
      runCreateRequestSchema.safeParse({
        sessionId: "s1",
        conversationId: "c1",
        prompt: "hello",
        runtimeKind: "local-agent",
        agentTargetId: "team:canvas-reviewer",
      }).success,
    ).toBe(true);
  });

  it("accepts explicit local provider ids", () => {
    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        runtimeKind: "local-agent",
        runtimeProvider: "codex",
      }).success,
    ).toBe(true);

    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        runtimeKind: "local-agent",
        runtimeProvider: "claude",
      }).success,
    ).toBe(true);
  });

  it("rejects the removed server-deepagent runtime", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      runtimeKind: "server-deepagent",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["runtimeKind"],
        }),
      ]),
    );
  });

  it("rejects contradictory exact-target and deprecated-provider selectors", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      runtimeKind: "local-agent",
      agentTargetId: "team:designer",
      runtimeProvider: "claude-code",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "Provide agentTargetId or deprecated runtimeProvider, not both.",
          path: ["runtimeProvider"],
        }),
      ]),
    );
  });

  it("does not expose managed agent invocation credentials in run bodies", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      managedAgentInvocationCredential: "  bearer-run-1  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty(
        "managedAgentInvocationCredential",
      );
    }
  });

  it("accepts one-time Codex image delegation consent", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      delegationConsent: {
        codexImagegen: "allow-once",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts supported app locales on run creation", () => {
    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        locale: "en",
      }).success,
    ).toBe(true);
    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        locale: "fr",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed local provider ids", () => {
    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        runtimeKind: "local-agent",
        runtimeProvider: "",
      }).success,
    ).toBe(false);

    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        runtimeKind: "local-agent",
        runtimeProvider: "../codex",
      }).success,
    ).toBe(false);
  });

  it("accepts explicit resume requests with a source run", () => {
    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        resumeFromRunId: "run_previous",
        resumeMode: "provider-local",
      }).success,
    ).toBe(true);

    expect(
      runCreateRequestSchema.safeParse({
        ...baseRunCreateRequest,
        resumeFromRunId: "run_previous",
        resumeMode: "handoff",
      }).success,
    ).toBe(true);
  });

  it("requires a source run for non-fresh resume modes", () => {
    const result = runCreateRequestSchema.safeParse({
      ...baseRunCreateRequest,
      resumeMode: "handoff",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "resumeMode requires resumeFromRunId unless resumeMode=fresh.",
          path: ["resumeFromRunId"],
        }),
      ]),
    );
  });
});

describe("modelListRequestSchema", () => {
  it("does not expose managed agent invocation credentials in model list bodies", () => {
    const result = modelListRequestSchema.safeParse({
      managedAgentInvocationCredential: "  bearer-model-1  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty(
        "managedAgentInvocationCredential",
      );
    }
  });
});

describe("modelListResponseSchema", () => {
  it("rejects malformed default Agent Target IDs", () => {
    expect(
      modelListResponseSchema.safeParse({
        models: [],
        localAgentProviders: [],
        localAgentTargets: [],
        defaultAgentTargetId: "../bad target",
      }).success,
    ).toBe(false);
  });
});

describe("applicationErrorResponseSchema", () => {
  it.each([
    "agent_target_unavailable",
    "invalid_model",
    "local_agent_disabled",
  ])("accepts actionable agent run error code %s", (code) => {
    expect(
      applicationErrorResponseSchema.safeParse({
        error: { code, message: "Actionable run error." },
      }).success,
    ).toBe(true);
  });
});

describe("workspaceSettingsSchema", () => {
  const baseWorkspaceSettings = {
    defaultModel: "",
    providerModels: {
      openai: [],
      anthropic: [],
      agnes: [],
      google: [],
      vertex: [],
    },
    openAIApiKey: "",
    openAIApiBase: "",
    anthropicApiKey: "",
    anthropicBaseUrl: "",
    agnesApiKey: "",
    agnesBaseUrl: "",
    agnesDefaultModel: "",
    googleApiKey: "",
    googleVertexProject: "",
    googleVertexLocation: "",
    googleVertexVideoLocation: "",
    replicateApiToken: "",
    volcesApiKey: "",
    volcesBaseUrl: "",
    kieApiKey: "",
    kieBaseUrl: "",
  };

  it("defaults Codex image delegation to ask", () => {
    const result = workspaceSettingsSchema.parse(baseWorkspaceSettings);

    expect(result.codexImagegenDelegation).toBe("ask");
  });

  it("accepts Codex image delegation choices", () => {
    expect(codexImagegenDelegationSchema.safeParse("ask").success).toBe(true);
    expect(codexImagegenDelegationSchema.safeParse("always").success).toBe(
      true,
    );
    expect(codexImagegenDelegationSchema.safeParse("never").success).toBe(true);
    expect(codexImagegenDelegationSchema.safeParse("sometimes").success).toBe(
      false,
    );
  });

  it("accepts Kie media provider settings", () => {
    const result = workspaceSettingsSchema.safeParse({
      ...baseWorkspaceSettings,
      kieApiKey: "local-kie-key",
      kieBaseUrl: "https://api.kie.ai",
    });

    expect(result.success).toBe(true);
  });
});

describe("canvas contracts", () => {
  it("carries canvas revisions through fetch and save requests", () => {
    expect(
      canvasGetResponseSchema.parse({
        canvas: {
          id: "canvas_1",
          name: "Main Canvas",
          projectId: "project_1",
          revision: 2,
          content: {
            elements: [],
            appState: {},
            files: {},
          },
        },
      }).canvas.revision,
    ).toBe(2);

    expect(
      canvasSaveRequestSchema.parse({
        baseRevision: 2,
        content: {
          elements: [],
          appState: {},
          files: {},
        },
      }).baseRevision,
    ).toBe(2);
  });
});
