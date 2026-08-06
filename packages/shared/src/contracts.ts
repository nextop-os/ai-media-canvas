import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";

export const identifierSchema = z.string().min(1);
export const timestampSchema = z.string().datetime({ offset: true });

export const sessionIdSchema = identifierSchema;
export const conversationIdSchema = identifierSchema;
export const runIdSchema = identifierSchema;
export const messageIdSchema = identifierSchema;
export const toolCallIdSchema = identifierSchema;
export const userIdSchema = identifierSchema;
export const projectIdSchema = identifierSchema;
export const canvasIdSchema = identifierSchema;

export const runStatusSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "failed",
  "canceled",
]);

export const imageAttachmentSchema = z.object({
  assetId: z.string().min(1),
  url: z.string().url(),
  mimeType: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const imageGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const videoGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const codexImagegenDelegationSchema = z.enum(["ask", "always", "never"]);

export const codexImagegenDelegationConsentSchema = z.object({
  codexImagegen: z.enum(["allow-once"]),
});

export const runtimeKindSchema = z.literal("local-agent");

export const agentRuntimeProviderSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, {
    message:
      "runtimeProvider must be a provider id using letters, numbers, '.', '_', ':', or '-'.",
  });

export const agentTargetIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, {
    message: "agentTargetId must use letters, numbers, '.', '_', ':', or '-'.",
  });

export const agentRunResumeModeSchema = z.enum([
  "auto",
  "provider-local",
  "handoff",
  "fresh",
]);

export const runCreateRequestSchema = z
  .object({
    clientRequestId: identifierSchema.optional(),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    prompt: z.string(),
    locale: z.enum(["zh-CN", "en"]).optional(),
    canvasId: canvasIdSchema.optional(),
    attachments: z.array(imageAttachmentSchema).optional(),
    imageGenerationPreference: imageGenerationPreferenceSchema.optional(),
    videoGenerationPreference: videoGenerationPreferenceSchema.optional(),
    model: z.string().optional(),
    modelSource: z.literal("local-agent").optional(),
    resumeFromRunId: runIdSchema.optional(),
    resumeMode: agentRunResumeModeSchema.optional(),
    runtimeKind: runtimeKindSchema.optional(),
    agentTargetId: agentTargetIdSchema.optional(),
    /** @deprecated Use agentTargetId. */
    runtimeProvider: agentRuntimeProviderSchema.optional(),
    delegationConsent: codexImagegenDelegationConsentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.agentTargetId &&
      value.runtimeKind &&
      value.runtimeKind !== "local-agent"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentTargetId requires runtimeKind=local-agent.",
        path: ["agentTargetId"],
      });
    }
    if (value.agentTargetId && value.runtimeProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide agentTargetId or deprecated runtimeProvider, not both.",
        path: ["runtimeProvider"],
      });
    }
    if (value.runtimeProvider && value.runtimeKind !== "local-agent") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtimeProvider requires runtimeKind=local-agent.",
        path: ["runtimeProvider"],
      });
    }
    if (
      value.runtimeKind === "local-agent" &&
      !value.agentTargetId &&
      !value.runtimeProvider
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "runtimeKind=local-agent requires agentTargetId or deprecated runtimeProvider.",
        path: ["agentTargetId"],
      });
    }
    if (
      value.resumeMode &&
      value.resumeMode !== "fresh" &&
      !value.resumeFromRunId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resumeMode requires resumeFromRunId unless resumeMode=fresh.",
        path: ["resumeFromRunId"],
      });
    }
  });

export const runCreateResponseSchema = z.object({
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  status: z.literal("accepted"),
  assistantMessageId: identifierSchema.optional(),
  runtimeKind: runtimeKindSchema.optional(),
  agentTargetId: agentTargetIdSchema.optional(),
  runtimeProvider: agentRuntimeProviderSchema.optional(),
  resumeMode: agentRunResumeModeSchema.exclude(["auto"]).optional(),
  reused: z.boolean().optional(),
});

export const viewerProfileSchema = z.object({
  id: userIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().url().nullable().optional(),
});

export const canvasSummarySchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  isPrimary: z.boolean(),
});

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  thumbnailUrl: z.string().nullable().optional(),
  primaryCanvas: canvasSummarySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const canvasContentSchema = z.object({
  elements: z.array(z.record(z.unknown())).default([]),
  appState: z.record(z.unknown()).default({}),
  files: z.record(z.record(z.unknown())).default({}),
});

export const canvasDetailSchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  projectId: projectIdSchema,
  revision: z.number().int().nonnegative(),
  content: canvasContentSchema,
});

export const profileUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

export const workspaceSettingsSchema = z.object({
  defaultModel: z.string(),
  defaultModelSource: z.literal("local-agent").optional(),
  providerModels: z.object({
    openai: z.array(z.string().min(1)),
    anthropic: z.array(z.string().min(1)),
    agnes: z.array(z.string().min(1)),
    google: z.array(z.string().min(1)),
    vertex: z.array(z.string().min(1)),
  }),
  openAIApiKey: z.string(),
  openAIApiBase: z.string(),
  anthropicApiKey: z.string(),
  anthropicBaseUrl: z.string(),
  agnesApiKey: z.string(),
  agnesBaseUrl: z.string(),
  agnesDefaultModel: z.string(),
  googleApiKey: z.string(),
  googleVertexProject: z.string(),
  googleVertexLocation: z.string(),
  googleVertexVideoLocation: z.string(),
  replicateApiToken: z.string(),
  kieApiKey: z.string(),
  kieBaseUrl: z.string(),
  volcesApiKey: z.string(),
  volcesBaseUrl: z.string(),
  codexImagegenDelegation: codexImagegenDelegationSchema.default("ask"),
});

export const agentModelSourceSchema = z.literal("local-agent");

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  provider: z.string().min(1),
  source: agentModelSourceSchema.optional(),
});

export const localAgentProviderInfoSchema = z.object({
  provider: agentRuntimeProviderSchema,
  displayName: z.string().trim().min(1),
  supported: z.boolean(),
  authState: z.enum(["ok", "missing", "expired", "unknown"]),
  reason: z.string().trim().min(1).optional(),
  defaultModelId: z.string().trim().min(1).optional(),
  models: z.array(modelInfoSchema),
});

export const localAgentTargetInfoSchema = z.object({
  agentTargetId: agentTargetIdSchema,
  providerId: agentRuntimeProviderSchema,
  displayName: z.string().trim().min(1),
  available: z.boolean(),
  runtimeSupported: z.boolean(),
  isDefault: z.boolean(),
  reason: z.string().trim().min(1).optional(),
  models: z.array(modelInfoSchema),
});

export const toolStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "canceled",
]);

export const chatSessionIdSchema = identifierSchema;

export const chatToolActivitySchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: toolStatusSchema,
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
});

export const chatSessionSummarySchema = z.object({
  id: chatSessionIdSchema,
  title: z.string(),
  updatedAt: timestampSchema,
});

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const toolBlockSchema = z.object({
  type: z.literal("tool"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: toolStatusSchema,
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  assetId: z.string().min(1),
  url: z.string().url(),
  mimeType: z.string().min(1),
  source: z.enum(["upload", "canvas-ref"]),
  name: z.string().min(1).optional(),
});

export const contentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolBlockSchema,
  imageBlockSchema,
]);

export const chatMessageSchema = z.object({
  id: identifierSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
  createdAt: timestampSchema,
});

export const chatMessageCreateRequestSchema = z.object({
  clientRequestId: identifierSchema.optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
});

export const assetBucketSchema = z.enum(["project-assets", "user-avatars"]);
export const assetSourceSchema = z.enum(["local", "managed-file"]);

export const assetObjectSchema = z.object({
  id: identifierSchema,
  bucket: assetBucketSchema,
  objectPath: z.string().min(1),
  mimeType: z.string().min(1).nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  projectId: projectIdSchema.nullable(),
  createdAt: timestampSchema,
  source: assetSourceSchema.optional(),
  displayName: z.string().min(1).nullable().optional(),
  sha256: z.string().min(1).nullable().optional(),
});

export type AssetBucket = z.infer<typeof assetBucketSchema>;
export type AssetSource = z.infer<typeof assetSourceSchema>;
export type AssetObject = z.infer<typeof assetObjectSchema>;

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type ToolBlock = z.infer<typeof toolBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export type ImageGenerationPreference = z.infer<
  typeof imageGenerationPreferenceSchema
>;
export type VideoGenerationPreference = z.infer<
  typeof videoGenerationPreferenceSchema
>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export type AgentRuntimeProvider = z.infer<typeof agentRuntimeProviderSchema>;
export type AgentTargetId = z.infer<typeof agentTargetIdSchema>;
export type AgentModelSource = z.infer<typeof agentModelSourceSchema>;
export type AgentRunResumeMode = z.infer<typeof agentRunResumeModeSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessageCreateRequest = z.infer<
  typeof chatMessageCreateRequestSchema
>;
export type ChatToolActivity = z.infer<typeof chatToolActivitySchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type LocalAgentProviderInfo = z.infer<
  typeof localAgentProviderInfoSchema
>;
export type LocalAgentTargetInfo = z.infer<typeof localAgentTargetInfoSchema>;
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;
export type RunCreateResponse = z.infer<typeof runCreateResponseSchema>;
export type ViewerProfile = z.infer<typeof viewerProfileSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type CanvasSummary = z.infer<typeof canvasSummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type CanvasContent = z.infer<typeof canvasContentSchema>;
export type CanvasDetail = z.infer<typeof canvasDetailSchema>;
