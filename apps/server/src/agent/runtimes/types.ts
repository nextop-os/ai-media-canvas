import type {
  AgentRuntimeProvider,
  ChatMessage,
  ImageAttachment,
  ImageGenerationPreference,
  RunCreateRequest,
  RuntimeKind,
  VideoGenerationPreference,
  WorkspaceSettings,
} from "@aimc/shared";
import type {
  AgentEvent,
  LocalAgentProviderPlugin,
  LocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

import type { UserDataClient } from "../../auth/request.js";
import type { ServerEnv } from "../../config/env.js";
import type { createPipelineLogger } from "../../ws/logger.js";
import type { createAgentBackend } from "../backends/index.js";
import type { ImageAttachmentMetadata } from "../image-attachment-metadata.js";
import type { createLocalToolGatewayService } from "../local-agent-host/tool-gateway.js";
import type { SubmitImageJobFn } from "../tools/image-generate.js";
import type { SubmitVideoJobFn } from "../tools/video-generate.js";
import type {
  ApplyWorkspaceSettingsPatch,
  ReadWorkspaceSettings,
} from "../tools/workspace-settings.js";
import type { WorkspaceSkillEntry } from "../workspace-skills.js";

export type RuntimeRunRecord = {
  agentTargetId?: string | undefined;
  accessToken?: string | undefined;
  assistantMessageId?: string | undefined;
  attachments?: ImageAttachment[] | undefined;
  canvasId?: string | undefined;
  connectionId?: string | undefined;
  consumed: boolean;
  controller: AbortController;
  conversationId: string;
  delegationConsent?: RunCreateRequest["delegationConsent"];
  envOverride?: ServerEnv | undefined;
  imageGenerationPreference?: ImageGenerationPreference | undefined;
  locale?: RunCreateRequest["locale"];
  modelOverride?: string | undefined;
  prompt: string;
  resumeContext?:
    | {
        mode: "provider-local" | "handoff" | "fresh";
        previousRunId?: string;
        previousRuntimeKind?: RuntimeKind | null;
        previousRuntimeProvider?: AgentRuntimeProvider | null;
        previousAgentTargetId?: string | null;
        providerSessionId?: string;
        resumeToken?: string;
      }
    | undefined;
  runId: string;
  runtimeKind?: RuntimeKind | undefined;
  runtimeProvider?: AgentRuntimeProvider | undefined;
  codexImagegenDelegation?: WorkspaceSettings["codexImagegenDelegation"];
  codexImagegenConsentBudget?: number;
  sessionId: string;
  status: "accepted" | "running" | "completed" | "failed" | "canceled";
  threadId?: string | undefined;
  userId?: string | undefined;
  videoGenerationPreference?: VideoGenerationPreference | undefined;
};

export type RuntimeExecutionContext = {
  backendResult: Awaited<ReturnType<typeof createAgentBackend>>;
  brandKitId: string | null;
  resolvedModel: string | undefined;
  rlog: ReturnType<typeof createPipelineLogger>;
  run: RuntimeRunRecord;
  runtimeEnv: ServerEnv;
  getWorkspaceSettings?: ReadWorkspaceSettings;
  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  updateWorkspaceSettings?: ApplyWorkspaceSettingsPatch;
  workspaceSkills: WorkspaceSkillEntry[];
};

export type LocalAgentRuntimeExecutionContext = Omit<
  RuntimeExecutionContext,
  "resolvedModel"
> & {
  resolvedModel: string;
};

export type BuildUserMessage = (
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
  attachmentMetadata?: Record<string, ImageAttachmentMetadata>,
) => { text: string };

export type BuildAttachmentDataMap = (
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
) => Record<string, string>;

export type LoadCanvasSummaryForRuntime = (
  context: RuntimeExecutionContext,
) => Promise<string | null>;

export type LocalAgentRuntimeProviderDeps = {
  buildAttachmentDataMap: BuildAttachmentDataMap;
  buildUserMessage: BuildUserMessage;
  createRunDirectory?: (input: {
    runId: string;
    runtimeProvider: AgentRuntimeProvider;
  }) => Promise<string>;
  /**
   * TSH: return the durable user project directory used as local-agent cwd.
   * When set, the runtime must not delete it after the run.
   */
  resolveProjectWorkspaceRoot?: (input: {
    canvasId?: string;
  }) => Promise<string | null> | string | null;
  loadCanvasSummaryForRuntime: LoadCanvasSummaryForRuntime;
  loadSessionMessages?: (sessionId: string) => Promise<ChatMessage[]>;
  localAgentRuntime: Pick<
    LocalAgentRuntime<"local-agent", AgentRuntimeProvider>,
    "run"
  > &
    Partial<
      Pick<LocalAgentRuntime<"local-agent", AgentRuntimeProvider>, "detect">
    >;
  now: () => string;
  recordProviderResumeMetadata?: (input: {
    providerSessionId?: string;
    resumeToken?: string;
    runId: string;
  }) => void;
  toolGateway: ReturnType<typeof createLocalToolGatewayService>;
  toolGatewayBaseUrl: string;
};

export type LocalAgentToolRunner = (
  params: Parameters<
    LocalAgentProviderPlugin<"local-agent", AgentRuntimeProvider>["run"]
  >[0],
) => AsyncGenerator<AgentEvent>;

export type PersistImageClientFactory = (accessToken: string) => UserDataClient;

export function assertLocalAgentRuntimeExecutionContext(
  context: RuntimeExecutionContext,
): asserts context is LocalAgentRuntimeExecutionContext {
  if (typeof context.resolvedModel !== "string") {
    throw new Error("Local agent runtime requires a string model.");
  }
}
