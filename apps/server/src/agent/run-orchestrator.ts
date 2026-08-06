import type {
  AgentRuntimeProvider,
  ContentBlock,
  RunCreateRequest,
  RuntimeKind,
  StreamEvent,
  ToolBlock,
} from "@aimc/shared";
import { createDefaultLocalAgentProviderPlugins } from "@tutti-os/agent-acp-kit";
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeMode,
  AgentRuntimeStatus,
  AgentRuntimeRecord as PackageAgentRuntimeRecord,
  RuntimeKindSelector as PackageRuntimeKindSelector,
  RuntimeKindSelectorInput as PackageRuntimeKindSelectorInput,
  RuntimeLease as PackageRuntimeLease,
  RuntimeProvider as PackageRuntimeProvider,
  RuntimeTarget as PackageRuntimeTarget,
} from "@tutti-os/agent-acp-kit";
import {
  createRuntimeControlPlane as createPackageRuntimeControlPlane,
  inferRuntimeKind as inferPackageRuntimeKind,
} from "@tutti-os/agent-acp-kit/runtime-control-plane";

export type { AgentRuntimeCapabilities, AgentRuntimeMode, AgentRuntimeStatus };

export type AgentRuntimeRecord = PackageAgentRuntimeRecord<
  RuntimeKind,
  AgentRuntimeProvider
>;
export type RuntimeKindSelector = PackageRuntimeKindSelector<
  RuntimeKind,
  AgentRuntimeProvider
>;
export type RuntimeKindSelectorInput = PackageRuntimeKindSelectorInput<
  RuntimeKind,
  AgentRuntimeProvider
>;
export type RuntimeLease = PackageRuntimeLease<
  RuntimeKind,
  AgentRuntimeProvider
>;
export type RuntimeProvider<TContext> = PackageRuntimeProvider<
  TContext,
  StreamEvent,
  RuntimeKind,
  AgentRuntimeProvider
>;
export type RuntimeTarget = PackageRuntimeTarget<
  RuntimeKind,
  AgentRuntimeProvider
>;

export function createRuntimeControlPlane<TContext>(
  providers: RuntimeProvider<TContext>[],
  options?: {
    now?: () => string;
    selectRuntimeKind?: RuntimeKindSelector;
  },
) {
  return createPackageRuntimeControlPlane<
    TContext,
    StreamEvent,
    RuntimeKind,
    AgentRuntimeProvider
  >(providers, options);
}

export function inferRuntimeKind(
  input: RuntimeKindSelectorInput,
): RuntimeTarget {
  return inferPackageRuntimeKind<RuntimeKind, AgentRuntimeProvider>(input);
}

function getModelProvider(model: string) {
  return model.includes(":") ? (model.split(":", 1)[0] ?? "") : "";
}

const LOCAL_AGENT_MODEL_PROVIDER_IDS = new Set(
  createDefaultLocalAgentProviderPlugins().map((provider) => provider.id),
);

export function getLocalAgentModelProvider(
  model: string | undefined,
): AgentRuntimeProvider | undefined {
  if (!model) return undefined;
  const provider = getModelProvider(model);
  return LOCAL_AGENT_MODEL_PROVIDER_IDS.has(provider)
    ? (provider as AgentRuntimeProvider)
    : undefined;
}

export class AgentRunModelResolutionError extends Error {
  readonly code = "invalid_model";
  readonly statusCode = 400;
}

export function resolveAgentRunModel(input: {
  defaultModel?: string | undefined;
  requestedModel?: string | undefined;
  runtimeKind?: RuntimeKind | undefined;
  runtimeProvider?: AgentRuntimeProvider | undefined;
}) {
  const requestedModel = input.requestedModel?.trim();
  const defaultModel = input.defaultModel?.trim();

  if (!input.runtimeProvider) {
    const resolvedModel = requestedModel || defaultModel;
    const provider = resolvedModel ? getModelProvider(resolvedModel) : "";
    if (provider && !LOCAL_AGENT_MODEL_PROVIDER_IDS.has(provider)) {
      throw new AgentRunModelResolutionError(
        `Model ${resolvedModel} is not a local-agent model. Select a model from a configured local agent.`,
      );
    }
    return resolvedModel;
  }

  if (!requestedModel) {
    return `${input.runtimeProvider}:default`;
  }

  const modelProvider = getModelProvider(requestedModel);
  if (!modelProvider) {
    return `${input.runtimeProvider}:${requestedModel}`;
  }

  if (modelProvider === input.runtimeProvider) {
    return requestedModel;
  }

  throw new AgentRunModelResolutionError(
    `Model ${requestedModel} is not compatible with local agent provider ${input.runtimeProvider}. Use ${input.runtimeProvider}:default or list compatible models first.`,
  );
}

export function inferAimcRuntimeTarget(
  input: RuntimeKindSelectorInput,
): RuntimeTarget {
  if (input.requestedRuntimeKind) {
    if (
      input.requestedRuntimeKind === "local-agent" &&
      !input.requestedRuntimeProvider
    ) {
      const localTargets = input.availableRuntimeTargets.filter(
        (target) => target.kind === "local-agent" && target.provider,
      );
      const onlyLocalTarget = localTargets[0];
      if (localTargets.length === 1 && onlyLocalTarget) {
        return onlyLocalTarget;
      }
    }
    return {
      kind: input.requestedRuntimeKind,
      ...(input.requestedRuntimeProvider
        ? { provider: input.requestedRuntimeProvider }
        : {}),
    };
  }

  const modelProvider =
    typeof input.model === "string" && input.model.includes(":")
      ? input.model.split(":", 1)[0]
      : undefined;
  if (modelProvider) {
    const matchingLocalTarget = input.availableRuntimeTargets.find(
      (target) =>
        target.kind === "local-agent" && target.provider === modelProvider,
    );
    if (matchingLocalTarget) {
      return matchingLocalTarget;
    }
  }

  const localTargets = input.availableRuntimeTargets.filter(
    (target) => target.kind === "local-agent",
  );
  const fallbackTarget = localTargets[0];
  if (!fallbackTarget) {
    throw new Error("No local agent runtime targets are available");
  }
  return fallbackTarget;
}

export type AssistantMessageProjection = {
  blocks: ContentBlock[];
  locale?: RunCreateRequest["locale"];
  textParts: string[];
};

export function createAssistantMessageProjection(options?: {
  locale?: RunCreateRequest["locale"];
}): AssistantMessageProjection {
  return {
    blocks: [],
    ...(options?.locale ? { locale: options.locale } : {}),
    textParts: [],
  };
}

function formatRunFailureMessage(input: {
  errorMessage: string;
  locale?: RunCreateRequest["locale"];
}) {
  return input.locale === "en"
    ? `Sorry, something went wrong while processing: ${input.errorMessage}`
    : `抱歉，处理过程中遇到问题：${input.errorMessage}`;
}

export function projectStreamEventToAssistantMessage(
  state: AssistantMessageProjection,
  event: StreamEvent,
) {
  if (event.type === "message.delta") {
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock?.type === "text") {
      lastBlock.text += event.delta;
    } else {
      state.blocks.push({ type: "text", text: event.delta });
    }
    state.textParts.push(event.delta);
    return;
  }

  if (event.type === "tool.started") {
    const index = state.blocks.findIndex(
      (block) => block.type === "tool" && block.toolCallId === event.toolCallId,
    );
    const nextBlock = {
      type: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: "running",
      ...(event.input ? { input: event.input } : {}),
    } satisfies ToolBlock;
    if (index >= 0) {
      state.blocks[index] = nextBlock;
    } else {
      state.blocks.push(nextBlock);
    }
    return;
  }

  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const index = state.blocks.findIndex(
      (block) => block.type === "tool" && block.toolCallId === event.toolCallId,
    );
    const currentBlock =
      index >= 0
        ? (state.blocks[index] as ToolBlock)
        : {
            type: "tool" as const,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running" as const,
          };
    const nextBlock: ToolBlock = {
      ...currentBlock,
      status: event.type === "tool.completed" ? "completed" : "failed",
      ...(event.output ? { output: event.output } : {}),
      ...(event.outputSummary
        ? { outputSummary: event.outputSummary }
        : event.type === "tool.failed"
          ? { outputSummary: event.error.message }
          : {}),
      ...(event.artifacts ? { artifacts: event.artifacts } : {}),
    };
    if (index < 0) {
      state.blocks.push(nextBlock);
    } else {
      state.blocks[index] = nextBlock;
    }
    return;
  }

  if (event.type === "run.failed" && state.textParts.length === 0) {
    const message = formatRunFailureMessage({
      errorMessage: event.error.message,
      locale: state.locale,
    });
    state.blocks.push({ type: "text", text: message });
    state.textParts.push(message);
  }
}

export type AgentRunEventEnvelope = {
  canvasSeq?: number;
  duplicate?: boolean;
  eventId: string;
  seq: number;
};

export type AgentRunEventPersistence = {
  appendEvent(input: {
    canvasId?: string;
    event: StreamEvent;
    runId: string;
  }): AgentRunEventEnvelope;
};

export function persistRunEvent(input: {
  canvasId?: string;
  event: StreamEvent;
  persistence?: AgentRunEventPersistence | undefined;
  runId: string;
}): AgentRunEventEnvelope | undefined {
  return input.persistence?.appendEvent({
    ...(input.canvasId ? { canvasId: input.canvasId } : {}),
    event: input.event,
    runId: input.runId,
  });
}

export function buildReplayEnvelope(
  persistedEvent: AgentRunEventEnvelope | undefined,
): { duplicate?: boolean; eventId?: string; seq?: number } {
  return {
    ...(persistedEvent?.duplicate ? { duplicate: true } : {}),
    ...(persistedEvent?.eventId ? { eventId: persistedEvent.eventId } : {}),
    ...(persistedEvent?.canvasSeq != null
      ? { seq: persistedEvent.canvasSeq }
      : {}),
  };
}

function isTerminalStreamEvent(event: StreamEvent) {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}

function statusForTerminalEvent(
  event: StreamEvent,
): AgentRunStatus | undefined {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return undefined;
  }
}

export type AgentRunResumeMode =
  | "native"
  | "provider-local"
  | "handoff"
  | "fresh";

export type AgentRunResumeContext = {
  mode: AgentRunResumeMode;
  previousRunId?: string;
  previousRuntimeKind?: RuntimeKind | null;
  previousRuntimeProvider?: AgentRuntimeProvider | null;
  previousAgentTargetId?: string | null;
  providerSessionId?: string;
  resumeToken?: string;
};

export function resolveResumeMode(input: {
  nextAgentTargetId?: string;
  nextRuntimeKind?: RuntimeKind;
  nextRuntimeProvider?: AgentRuntimeProvider;
  previousRuntimeKind?: RuntimeKind | null;
  previousRuntimeProvider?: AgentRuntimeProvider | null;
  previousAgentTargetId?: string | null;
}): AgentRunResumeMode {
  if (!input.previousRuntimeKind) {
    return "fresh";
  }
  if (
    input.previousRuntimeKind === input.nextRuntimeKind &&
    input.previousRuntimeProvider === input.nextRuntimeProvider &&
    Boolean(input.previousAgentTargetId) &&
    input.previousAgentTargetId === input.nextAgentTargetId
  ) {
    return "provider-local";
  }
  return "handoff";
}

type AgentRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

export type AgentRunRecordStore = {
  createRun(input: {
    agentTargetId?: string;
    assistantMessageId?: string;
    canvasId?: string;
    model?: string;
    previousRunId?: string;
    resumeMode?: Exclude<AgentRunResumeMode, "native">;
    runtimeKind?: RuntimeKind;
    runtimeProvider?: AgentRuntimeProvider;
    runId: string;
    sessionId: string;
    threadId?: string;
  }): void;
  updateRun(input: {
    agentTargetId?: string;
    assistantMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    providerSessionId?: string;
    runId: string;
    resumeToken?: string;
    runtimeKind?: RuntimeKind;
    runtimeProvider?: AgentRuntimeProvider;
    status: AgentRunStatus;
  }): void;
  getRun?(runId: string):
    | {
        agent_target_id?: string | null;
        assistant_message_id?: string | null;
        id: string;
        previous_run_id?: string | null;
        provider_session_id?: string | null;
        resume_mode?: Exclude<AgentRunResumeMode, "native"> | null;
        resume_token?: string | null;
        runtime_kind?: RuntimeKind | null;
        runtime_provider?: AgentRuntimeProvider | null;
        session_id?: string | null;
        status?: AgentRunStatus;
      }
    | undefined;
};

export type AgentRunOrchestrator = {
  createAssistantProjection(options?: {
    locale?: RunCreateRequest["locale"];
  }): AssistantMessageProjection;
  emitTerminalCancel(input: {
    canvasId?: string;
    now?: () => string;
    project?: AssistantMessageProjection;
    publish?: (input: {
      envelope: { duplicate?: boolean; eventId?: string; seq?: number };
      event: StreamEvent;
    }) => void;
    runId: string;
    updateAssistant?: (
      projection: AssistantMessageProjection,
    ) => Promise<void> | void;
  }): Promise<{
    envelope: { duplicate?: boolean; eventId?: string; seq?: number };
    event: Extract<StreamEvent, { type: "run.canceled" }>;
  }>;
  handleStreamEvent(input: {
    canvasId?: string;
    event: StreamEvent;
    project?: AssistantMessageProjection;
    publish?: (input: {
      envelope: { duplicate?: boolean; eventId?: string; seq?: number };
      event: StreamEvent;
    }) => void;
    runId: string;
    updateAssistant?: (
      projection: AssistantMessageProjection,
    ) => Promise<void> | void;
  }): Promise<{ duplicate?: boolean; eventId?: string; seq?: number }>;
  persistAndEnvelope(input: {
    canvasId?: string;
    event: StreamEvent;
    runId: string;
  }): { duplicate?: boolean; eventId?: string; seq?: number };
  projectEvent(
    state: AssistantMessageProjection,
    event: StreamEvent,
  ): AssistantMessageProjection;
  recordAcceptedRun(input: {
    agentTargetId?: string;
    assistantMessageId?: string;
    canvasId?: string;
    model?: string;
    runtimeKind?: RuntimeKind;
    runtimeProvider?: AgentRuntimeProvider;
    runId: string;
    sessionId: string;
    threadId?: string;
  }): void;
  updateRunStatus(input: {
    agentTargetId?: string;
    assistantMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    runId: string;
    runtimeKind?: RuntimeKind;
    runtimeProvider?: AgentRuntimeProvider;
    status: AgentRunStatus;
  }): void;
};

export function createAgentRunOrchestrator(input: {
  eventPersistence?: AgentRunEventPersistence | undefined;
  runStore?: AgentRunRecordStore | undefined;
}): AgentRunOrchestrator {
  return {
    createAssistantProjection(options) {
      return createAssistantMessageProjection(options);
    },

    async emitTerminalCancel(cancelInput) {
      const event = {
        type: "run.canceled",
        runId: cancelInput.runId,
        timestamp: (cancelInput.now ?? (() => new Date().toISOString()))(),
      } satisfies Extract<StreamEvent, { type: "run.canceled" }>;
      const envelope = await this.handleStreamEvent({
        ...(cancelInput.canvasId ? { canvasId: cancelInput.canvasId } : {}),
        event,
        ...(cancelInput.project ? { project: cancelInput.project } : {}),
        ...(cancelInput.publish ? { publish: cancelInput.publish } : {}),
        runId: cancelInput.runId,
        ...(cancelInput.updateAssistant
          ? { updateAssistant: cancelInput.updateAssistant }
          : {}),
      });
      return { envelope, event };
    },

    async handleStreamEvent(streamInput) {
      const envelope = this.persistAndEnvelope({
        ...(streamInput.canvasId ? { canvasId: streamInput.canvasId } : {}),
        event: streamInput.event,
        runId: streamInput.runId,
      });

      if (envelope.duplicate) {
        return envelope;
      }

      if (isTerminalStreamEvent(streamInput.event)) {
        const status = statusForTerminalEvent(streamInput.event);
        if (status) {
          input.runStore?.updateRun({
            ...(streamInput.event.type === "run.failed"
              ? {
                  errorCode: streamInput.event.error.code,
                  errorMessage: streamInput.event.error.message,
                }
              : {}),
            runId: streamInput.runId,
            status,
          });
        }
      }

      if (streamInput.project) {
        this.projectEvent(streamInput.project, streamInput.event);
      }

      streamInput.publish?.({
        envelope,
        event: streamInput.event,
      });

      if (streamInput.project && streamInput.updateAssistant) {
        await streamInput.updateAssistant(streamInput.project);
      }

      return envelope;
    },

    persistAndEnvelope(eventInput) {
      return buildReplayEnvelope(
        persistRunEvent({
          ...eventInput,
          persistence: input.eventPersistence,
        }),
      );
    },

    projectEvent(state, event) {
      projectStreamEventToAssistantMessage(state, event);
      return state;
    },

    recordAcceptedRun(runInput) {
      input.runStore?.createRun(runInput);
    },

    updateRunStatus(statusInput) {
      input.runStore?.updateRun(statusInput);
    },
  };
}
