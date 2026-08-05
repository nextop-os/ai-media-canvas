import { z } from "zod";

import {
  agentTargetIdSchema,
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  localAgentProviderInfoSchema,
  localAgentTargetInfoSchema,
  modelInfoSchema,
  projectIdSchema,
  projectSummarySchema,
  runIdSchema,
  tuttiManagedConnectChallengeSchema,
  tuttiManagedConnectionSchema,
  tuttiManagedGrantRequestSchema,
  tuttiManagedPublicConnectionSchema,
  viewerProfileSchema,
  workspaceSettingsSchema,
} from "./contracts.js";
import {
  skillCreateRequestSchema,
  skillDetailResponseSchema,
  skillImportRequestSchema,
  skillListResponseSchema,
  skillToggleRequestSchema,
} from "./skill-contracts.js";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("ai-media-canvas-server"),
  version: z.string().min(1),
  tshWorkspaceApp: z.boolean().optional(),
  defaultParentPath: z.string().min(1).optional(),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
});

export const viewerResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  /** TSH only: parent directory under /workspace for the project folder. */
  parentPath: z.string().trim().min(1).optional(),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});

export const projectDetailSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  thumbnailUrl: z.string().nullable().optional(),
  brandKitId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const projectDetailResponseSchema = z.object({
  project: projectDetailSchema,
});

export const applicationErrorCodeSchema = z.enum([
  "application_error",
  "bootstrap_failed",
  "brand_kit_not_found",
  "brand_kit_create_failed",
  "brand_kit_update_failed",
  "brand_kit_delete_failed",
  "brand_kit_query_failed",
  "brand_kit_asset_not_found",
  "brand_kit_asset_create_failed",
  "canvas_not_found",
  "canvas_conflict",
  "canvas_save_failed",
  "chat_error",
  "profile_update_failed",
  "project_query_failed",
  "project_create_failed",
  "project_delete_failed",
  "project_not_found",
  "project_slug_taken",
  "project_update_failed",
  "run_not_found",
  "session_not_found",
  "upload_failed",
  "asset_in_use",
  "asset_not_found",
  "variant_not_found",
  "generation_failed",
  "agent_target_unavailable",
  "invalid_input",
  "invalid_model",
  "local_agent_disabled",
  "job_not_found",
  "job_create_failed",
  "job_query_failed",
  "job_cancel_failed",
  "provider_not_configured",
  "route_not_found",
  "service_unavailable",
  "skill_create_failed",
  "skill_import_failed",
  "skill_install_failed",
  "skill_not_found",
  "skill_query_failed",
  "skill_toggle_failed",
  "skill_uninstall_failed",
]);

export const applicationErrorResponseSchema = z.object({
  error: z.object({
    code: applicationErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const canvasGetResponseSchema = z.object({
  canvas: canvasDetailSchema,
});

export const canvasSaveRequestSchema = z.object({
  baseRevision: z.number().int().nonnegative().optional(),
  content: canvasContentSchema,
});

export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
  revision: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;
export type ViewerResponse = z.infer<typeof viewerResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type ApplicationErrorResponse = z.infer<
  typeof applicationErrorResponseSchema
>;
export const profileUpdateResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const workspaceSettingsResponseSchema = z.object({
  settings: workspaceSettingsSchema,
});

export const workspaceSettingsUpdateRequestSchema = workspaceSettingsSchema;

export const modelListResponseSchema = z.object({
  models: z.array(modelInfoSchema),
  localAgentProviders: z.array(localAgentProviderInfoSchema),
  localAgentTargets: z.array(localAgentTargetInfoSchema),
  defaultAgentTargetId: agentTargetIdSchema.nullable(),
});

export const modelListRequestSchema = z.object({});

export const tuttiManagedConnectionResponseSchema = z.object({
  connectChallenge: tuttiManagedConnectChallengeSchema.optional(),
  connection: tuttiManagedPublicConnectionSchema,
});

export const tuttiManagedGrantResponseSchema =
  tuttiManagedConnectionResponseSchema;

export const tuttiManagedGrantCreateRequestSchema =
  tuttiManagedGrantRequestSchema;

export const sessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSummarySchema),
});

export const sessionCreateResponseSchema = z.object({
  session: chatSessionSummarySchema,
});

export const messageListResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export const messageCreateResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type CanvasGetResponse = z.infer<typeof canvasGetResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>;
export type WorkspaceSettingsResponse = z.infer<
  typeof workspaceSettingsResponseSchema
>;
export type WorkspaceSettingsUpdateRequest = z.infer<
  typeof workspaceSettingsUpdateRequestSchema
>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;
export type ModelListRequest = z.infer<typeof modelListRequestSchema>;
export type TuttiManagedConnectionResponse = z.infer<
  typeof tuttiManagedConnectionResponseSchema
>;
export type TuttiManagedGrantCreateRequest = z.infer<
  typeof tuttiManagedGrantCreateRequestSchema
>;
export type TuttiManagedGrantResponse = z.infer<
  typeof tuttiManagedGrantResponseSchema
>;

export const uploadResponseSchema = z.object({
  asset: assetObjectSchema,
  url: z.string().min(1),
});

export const managedFileAssetMetadataSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
});

export const managedFileAssetCreateRequestSchema = z.object({
  file: managedFileAssetMetadataSchema,
  projectId: projectIdSchema.optional(),
});

export const assetSignedUrlResponseSchema = z.object({
  url: z.string().min(1),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type ManagedFileAssetMetadata = z.infer<
  typeof managedFileAssetMetadataSchema
>;
export type ManagedFileAssetCreateRequest = z.infer<
  typeof managedFileAssetCreateRequestSchema
>;
export type AssetSignedUrlResponse = z.infer<
  typeof assetSignedUrlResponseSchema
>;

export const projectUpdateRequestSchema = z.object({
  brandKitId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;

export {
  skillCreateRequestSchema,
  skillDetailResponseSchema,
  skillImportRequestSchema,
  skillListResponseSchema,
  skillToggleRequestSchema,
};
