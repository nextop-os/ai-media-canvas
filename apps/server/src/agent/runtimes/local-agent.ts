import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeProvider, StreamEvent } from "@aimc/shared";
import type {
  AgentEvent,
  LocalAgentProviderPlugin,
} from "@tutti-os/agent-acp-kit";

import {
  type ImageAttachmentMetadata,
  buildImageAttachmentMetadata,
} from "../image-attachment-metadata.js";
import { createAimcToolsMcpServerConfig } from "../local-agent-host/mcp-config.js";
import {
  mapWorkspaceSkillsToLocalAgentManifest,
  materializeWorkspaceSkillsForLocalAgent,
} from "../local-agent-host/skills.js";
import { buildAimcSystemPrompt } from "../prompts/aimc-main.js";
import {
  formatTuttiSkillGuidance,
  loadTuttiAgentSkillContextForRun,
  shouldUseTuttiSkillContext,
} from "../tutti-skill-context.js";
import { loadNormalizedSessionHistory } from "./history.js";
import {
  adaptLocalAgentEvent,
  toAimcRunErrorCode,
} from "./local-agent-events.js";
import type {
  LocalAgentRuntimeExecutionContext,
  LocalAgentRuntimeProviderDeps,
  RuntimeExecutionContext,
} from "./types.js";
import { assertLocalAgentRuntimeExecutionContext } from "./types.js";

type AimcLocalAgentProviderPlugin = LocalAgentProviderPlugin<
  "local-agent",
  AgentRuntimeProvider
>;

export async function createLocalAgentRunDirectory(input: {
  appDataDir?: string;
  runId: string;
  runtimeProvider: AgentRuntimeProvider;
  /** When set (TSH project dir), use it as cwd instead of an ephemeral tmp dir. */
  projectWorkspaceRoot?: string;
}): Promise<{ path: string; ephemeral: boolean }> {
  const projectRoot = input.projectWorkspaceRoot?.trim();
  if (projectRoot) {
    await mkdir(projectRoot, { recursive: true });
    return { path: projectRoot, ephemeral: false };
  }
  // Outside TSH, agent run state is disposable. Keeping it below
  // TUTTI_APP_DATA_DIR makes every mkdir/write/rm cross FabricFS/NFS and blocks
  // prompt startup. Use the VM-local temporary filesystem instead.
  const path = await mkdtemp(
    join(tmpdir(), `aimc-local-agent-${input.runtimeProvider}-run-`),
  );
  return { path, ephemeral: true };
}

function mapResumeContext(
  resumeContext: RuntimeExecutionContext["run"]["resumeContext"],
) {
  if (!resumeContext) return undefined;
  return {
    mode:
      resumeContext.mode === "provider-local"
        ? ("provider" as const)
        : ("fresh" as const),
    ...(resumeContext.providerSessionId
      ? { providerSessionId: resumeContext.providerSessionId }
      : {}),
    ...(resumeContext.resumeToken
      ? { resumeToken: resumeContext.resumeToken }
      : {}),
  };
}

function stripLocalAgentProviderPrefix(model: string, provider: string) {
  const prefix = `${provider}:`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function localAgentModelIdForAcp(model: string, provider: string) {
  const stripped = stripLocalAgentProviderPrefix(model, provider);
  if (provider === "cursor" && stripped === "default") return "default[]";
  return stripped;
}

function normalizeWorkspaceSkillPathsForLocalAgent(prompt: string) {
  return prompt.replaceAll("/workspace-skills/", "workspace-skills/");
}

function joinPromptParts(...parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function persistentLocalAssetRef(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, "http://localhost");
    if (!parsed.pathname.startsWith("/local-assets/")) return undefined;
    const assetId = parsed.pathname
      .slice("/local-assets/".length)
      .split("/")[0];
    return assetId ? `/local-assets/${assetId}` : undefined;
  } catch {
    return undefined;
  }
}

type AgentTimingDiagnostic = {
  kind: "timing";
  phase: "prepare" | "run";
  stage: string;
  elapsedMs: number;
  totalElapsedMs: number;
  outcome?: "completed" | "failed" | "canceled";
};

function readAgentTimingDiagnostic(
  event: AgentEvent,
): AgentTimingDiagnostic | undefined {
  if (event.type !== "status") return undefined;
  const diagnostic = (event as unknown as { diagnostic?: unknown }).diagnostic;
  if (!diagnostic || typeof diagnostic !== "object") return undefined;
  const candidate = diagnostic as Partial<AgentTimingDiagnostic>;
  if (
    candidate.kind !== "timing" ||
    (candidate.phase !== "prepare" && candidate.phase !== "run") ||
    typeof candidate.stage !== "string" ||
    typeof candidate.elapsedMs !== "number" ||
    typeof candidate.totalElapsedMs !== "number"
  ) {
    return undefined;
  }
  return candidate as AgentTimingDiagnostic;
}

async function awaitConcurrentPreparation<T, U>(
  first: Promise<T>,
  second: Promise<U>,
  abort: (reason: unknown) => void,
): Promise<[T, U]> {
  try {
    return await Promise.all([first, second]);
  } catch (error) {
    // Promise.all rejects as soon as one branch fails. The other branch may
    // still be reading or writing below runDir, so stop it and wait for both
    // branches before the caller's finally block removes the directory.
    abort(error);
    await Promise.allSettled([first, second]);
    throw error;
  }
}

const DEFAULT_LOCAL_AGENT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_LOCAL_AGENT_MCP_STARTUP_TIMEOUT_MS = 2 * 60_000;

function resolveLocalAgentTimeoutMs(runtimeEnv: {
  codexImagegenTimeoutMs?: number;
}) {
  return Math.max(
    runtimeEnv.codexImagegenTimeoutMs ?? 0,
    DEFAULT_LOCAL_AGENT_TIMEOUT_MS,
  );
}

export function createLocalAgentRuntimeProvider(
  deps: LocalAgentRuntimeProviderDeps,
  providerPlugin: AimcLocalAgentProviderPlugin,
) {
  const runtimeProvider = providerPlugin.id;

  return {
    ...(providerPlugin.aliases ? { aliases: providerPlugin.aliases } : {}),
    runtime: {
      id: `local-agent:${runtimeProvider}`,
      kind: "local-agent" as const,
      provider: runtimeProvider,
      mode: "local" as const,
      status: "online" as const,
      capabilities: providerPlugin.capabilities(),
    },
    async *streamRun(
      context: RuntimeExecutionContext,
    ): AsyncGenerator<StreamEvent> {
      assertLocalAgentRuntimeExecutionContext(context);
      const readyContext: LocalAgentRuntimeExecutionContext = context;

      const {
        resolvedModel,
        run,
        runtimeEnv,
        submitImageJob,
        submitVideoJob,
        workspaceSkills,
        rlog,
      } = readyContext;
      const effectiveAgentTargetId = run.agentTargetId;
      if (!effectiveAgentTargetId) {
        throw new Error(
          "Local agent runs require an exact Agent Target identity.",
        );
      }

      const appPrepareStartedAt = Date.now();
      rlog.info("agent_prepare_started", {
        provider: runtimeProvider,
        agent_target_id: effectiveAgentTargetId,
      });
      const canvasSummaryStartedAt = Date.now();
      const canvasSummary =
        await deps.loadCanvasSummaryForRuntime(readyContext);
      rlog.info("agent_prepare_stage_done", {
        stage: "canvas_summary",
        elapsed_ms: Date.now() - canvasSummaryStartedAt,
        found: canvasSummary != null,
      });

      let attachmentDataMap: Record<string, string> = {};
      const attachmentMetadata: Record<string, ImageAttachmentMetadata> = {};
      const attachmentPrepareStartedAt = Date.now();
      if (run.attachments?.length) {
        const downloaded: Array<{
          assetId: string;
          base64: string;
          mimeType: string;
        }> = [];
        const stableAttachmentRefs: Record<string, string> = {};

        await Promise.all(
          run.attachments.map(async (attachment) => {
            try {
              const stableRef =
                persistentLocalAssetRef(attachment.inputImageRef) ??
                persistentLocalAssetRef(attachment.url);
              if (stableRef) {
                // Local assets are already available to AIMC. Keep their
                // persistent reference instead of fetching a browser-facing
                // preview URL that may not be reachable from the VM runtime.
                stableAttachmentRefs[attachment.assetId] = stableRef;
                return;
              }

              const dataUriMatch = attachment.url.match(
                /^data:([^;]+);base64,(.+)$/,
              );
              if (dataUriMatch) {
                const buffer = Buffer.from(dataUriMatch[2] ?? "", "base64");
                const metadata = buildImageAttachmentMetadata(buffer);
                if (metadata) attachmentMetadata[attachment.assetId] = metadata;
                downloaded.push({
                  assetId: attachment.assetId,
                  mimeType: dataUriMatch[1] ?? attachment.mimeType,
                  base64: dataUriMatch[2] ?? "",
                });
                return;
              }

              const response = await fetch(attachment.url);
              const buffer = Buffer.from(await response.arrayBuffer());
              const metadata = buildImageAttachmentMetadata(buffer);
              if (metadata) attachmentMetadata[attachment.assetId] = metadata;
              downloaded.push({
                assetId: attachment.assetId,
                mimeType:
                  attachment.mimeType ||
                  response.headers.get("content-type") ||
                  "image/png",
                base64: buffer.toString("base64"),
              });
            } catch {
              // Leave unresolved references as-is; the tool can still use raw URLs.
            }
          }),
        );

        attachmentDataMap = {
          ...deps.buildAttachmentDataMap(downloaded),
          ...stableAttachmentRefs,
        };
      }
      rlog.info("agent_prepare_stage_done", {
        stage: "attachments",
        elapsed_ms: Date.now() - attachmentPrepareStartedAt,
        requested_count: run.attachments?.length ?? 0,
        resolved_count: Object.keys(attachmentDataMap).length,
      });

      const { text: enrichedPrompt } = deps.buildUserMessage(
        run.prompt,
        run.attachments ?? [],
        run.imageGenerationPreference,
        run.videoGenerationPreference,
        canvasSummary,
        attachmentMetadata,
      );
      const normalizedPrompt =
        normalizeWorkspaceSkillPathsForLocalAgent(enrichedPrompt);
      const handoffSection =
        run.resumeContext?.mode === "handoff" && run.resumeContext.previousRunId
          ? [
              "Resume handoff context:",
              `- Previous run: ${run.resumeContext.previousRunId}`,
              `- Previous runtime: ${run.resumeContext.previousRuntimeKind ?? "unknown"}${
                run.resumeContext.previousRuntimeProvider
                  ? ` (${run.resumeContext.previousRuntimeProvider})`
                  : ""
              }`,
              "- Treat the conversation history and current canvas state as the source of truth.",
              "- Continue the user's request without assuming provider-native session state is available.",
            ].join("\n")
          : undefined;
      const prompt = [
        "You are the local agent runtime for AI Canvas.",
        "If the user wants a finished visual asset, call generate_image or generate_video.",
        "Use inspect_canvas before precise canvas edits, and use manipulate_canvas for deterministic canvas updates.",
        "Do not claim an image or canvas update happened unless the tool actually succeeded.",
        "Ask clarifying questions or confirmation requests in normal assistant text. Do not use provider-native interactive question tools such as AskUserQuestion.",
        "When starting new work on a project whose title is still a placeholder such as Untitled, choose a concise human title and call set_project_title early; do not leave the raw instruction as the project title. This updates the display title only and does not rename the project directory.",
        "To rename the on-disk project directory, use filesystem tools. Display title and directory name are independent.",
        "Before a non-Codex agent calls generate_image with model codex/gpt-image-2, it must call get_workspace_settings. If codexImagegen.confirmationRequired is true, explain in normal assistant text that no image generation model is directly available for this agent and ask whether to delegate this image generation task to Codex. After the user answers, call update_workspace_settings with patch.codexImagegenDelegation=allow-once for a one-time allow, always for a durable allow, or deny before stopping.",
        "Workspace skill files are materialized under the current working directory; when reading them with shell or file tools, use relative paths such as `workspace-skills/<slug>/SKILL.md` and never `/workspace-skills/<slug>/SKILL.md`.",
        handoffSection,
        normalizedPrompt,
      ].join("\n\n");
      let runDir: string | undefined;
      let ephemeralRunDir = true;
      const runDirectoryStartedAt = Date.now();
      try {
        run.controller.signal.throwIfAborted();
        if (deps.createRunDirectory) {
          runDir = await deps.createRunDirectory({
            runId: run.runId,
            runtimeProvider,
          });
          ephemeralRunDir = true;
        } else {
          const projectWorkspaceRoot = deps.resolveProjectWorkspaceRoot
            ? await deps.resolveProjectWorkspaceRoot({
                ...(run.canvasId ? { canvasId: run.canvasId } : {}),
              })
            : null;
          const created = await createLocalAgentRunDirectory({
            ...(runtimeEnv.appDataDir
              ? { appDataDir: runtimeEnv.appDataDir }
              : {}),
            ...(projectWorkspaceRoot ? { projectWorkspaceRoot } : {}),
            runId: run.runId,
            runtimeProvider,
          });
          runDir = created.path;
          ephemeralRunDir = created.ephemeral;
        }
        if (!runDir) {
          throw new Error("Local agent run directory is required.");
        }
        run.controller.signal.throwIfAborted();
        rlog.info("agent_prepare_stage_done", {
          stage: "run_directory",
          elapsed_ms: Date.now() - runDirectoryStartedAt,
          ephemeral: ephemeralRunDir,
          cwd: runDir,
        });
      } catch (error) {
        if (runDir && ephemeralRunDir) {
          await rm(runDir, { recursive: true, force: true });
        }
        throw error;
      }
      let gatewaySessionToken: string | undefined;
      let executionStartedAt: number | undefined;
      let executionOutcome: "completed" | "failed" | "canceled" = "failed";
      let providerEventCount = 0;
      let toolCallCount = 0;
      let toolResultCount = 0;
      let firstProviderEventSeen = false;
      let firstTextSeen = false;
      let firstToolSeen = false;
      const toolStartedAt = new Map<string, number>();
      const suppressedToolCallIds = new Set<string>();
      try {
        const workspaceSkillMaterializationStartedAt = Date.now();
        await materializeWorkspaceSkillsForLocalAgent({
          runDir,
          workspaceSkills,
        });
        rlog.info("agent_prepare_stage_done", {
          stage: "workspace_skills_materialize",
          elapsed_ms: Date.now() - workspaceSkillMaterializationStartedAt,
          count: workspaceSkills.length,
        });
        const toolGatewayStartedAt = Date.now();
        const gatewaySession = deps.toolGateway.createSession({
          ...(run.accessToken ? { accessToken: run.accessToken } : {}),
          ...(Object.keys(attachmentDataMap).length > 0
            ? { attachmentDataMap }
            : {}),
          backendFactory: readyContext.backendResult.factory,
          ...(readyContext.brandKitId
            ? { brandKitId: readyContext.brandKitId }
            : {}),
          ...(run.canvasId ? { canvasId: run.canvasId } : {}),
          ...(run.connectionId ? { connectionId: run.connectionId } : {}),
          runId: run.runId,
          runtimeProvider,
          sessionId: run.sessionId,
          runtimeEnv,
          ...(run.delegationConsent
            ? { delegationConsent: run.delegationConsent }
            : {}),
          codexImagegenConsentBudget: run.codexImagegenConsentBudget ?? 0,
          onWorkspaceSettingsStateChange: (state) => {
            if (state.codexImagegenConsentBudget !== undefined) {
              run.codexImagegenConsentBudget = state.codexImagegenConsentBudget;
            }
            if (state.codexImagegenDelegation !== undefined) {
              run.codexImagegenDelegation = state.codexImagegenDelegation;
            }
          },
          ...(run.codexImagegenDelegation
            ? {
                workspaceSettings: {
                  codexImagegenDelegation: run.codexImagegenDelegation,
                },
              }
            : {}),
          sandboxDir: runDir,
          ...(submitImageJob ? { submitImageJob } : {}),
          ...(submitVideoJob ? { submitVideoJob } : {}),
          ...(run.userId ? { userId: run.userId } : {}),
        });
        gatewaySessionToken = gatewaySession.token;
        rlog.info("agent_prepare_stage_done", {
          stage: "tool_gateway",
          elapsed_ms: Date.now() - toolGatewayStartedAt,
          mcp_server_count: 1,
        });

        const messageId = run.assistantMessageId ?? `message_${run.runId}`;
        let terminalEmitted = false;
        let lastError: Extract<AgentEvent, { type: "error" }> | undefined;

        rlog.lap("local_agent_runtime_start", { provider: runtimeProvider });

        const skillPreparationController = new AbortController();
        const abortSkillPreparation = () => {
          skillPreparationController.abort(run.controller.signal.reason);
        };
        run.controller.signal.addEventListener("abort", abortSkillPreparation, {
          once: true,
        });
        if (run.controller.signal.aborted) {
          abortSkillPreparation();
        }
        const historyPreparationStartedAt = Date.now();
        const historyPreparation = loadNormalizedSessionHistory({
          currentPrompt: enrichedPrompt,
          ...(deps.loadSessionMessages
            ? { loadSessionMessages: deps.loadSessionMessages }
            : {}),
          sessionId: run.sessionId,
        }).then((history) => {
          rlog.info("agent_prepare_stage_done", {
            stage: "conversation_history",
            elapsed_ms: Date.now() - historyPreparationStartedAt,
            count: history.length,
          });
          return history;
        });
        const tuttiSkillPreparationStartedAt = Date.now();
        const skillPreparation = shouldUseTuttiSkillContext(enrichedPrompt)
          ? loadTuttiAgentSkillContextForRun({
              agentTargetId: effectiveAgentTargetId,
              cwd: runDir,
              runId: run.runId,
              signal: skillPreparationController.signal,
            })
          : Promise.resolve({
              source: "standalone" as const,
              recommendedSystemPrompt: undefined,
              skillManifest: [],
              skills: [],
            });
        const measuredSkillPreparation = skillPreparation.then((context) => {
          rlog.info("agent_prepare_stage_done", {
            stage: "tutti_skill_context",
            elapsed_ms: Date.now() - tuttiSkillPreparationStartedAt,
            source: context.source,
            skill_count: context.skillManifest.length,
          });
          return context;
        });
        let history: Awaited<typeof historyPreparation>;
        let tuttiSkillContext: Awaited<typeof skillPreparation>;
        try {
          [history, tuttiSkillContext] = await awaitConcurrentPreparation(
            historyPreparation,
            measuredSkillPreparation,
            (reason) => skillPreparationController.abort(reason),
          );
        } finally {
          run.controller.signal.removeEventListener(
            "abort",
            abortSkillPreparation,
          );
        }
        const skillManifest = [
          ...mapWorkspaceSkillsToLocalAgentManifest(workspaceSkills),
          ...tuttiSkillContext.skillManifest,
        ];
        const systemPrompt = joinPromptParts(
          buildAimcSystemPrompt({
            brandKitId: readyContext.brandKitId,
            locale: run.locale,
          }),
          formatTuttiSkillGuidance(
            tuttiSkillContext.recommendedSystemPrompt?.content,
          ),
        );
        const resume = mapResumeContext(run.resumeContext);
        const mcpServers = [
          createAimcToolsMcpServerConfig({
            gatewayBaseUrl: deps.toolGatewayBaseUrl,
            gatewayToken: gatewaySession.token,
            startupTimeoutMs: DEFAULT_LOCAL_AGENT_MCP_STARTUP_TIMEOUT_MS,
            toolTimeoutMs: resolveLocalAgentTimeoutMs(runtimeEnv),
          }),
        ];
        rlog.info("agent_prepare_done", {
          elapsed_ms: Date.now() - appPrepareStartedAt,
          history_count: history.length,
          skill_count: skillManifest.length,
          mcp_server_count: mcpServers.length,
        });

        yield {
          type: "run.started",
          runId: run.runId,
          sessionId: run.sessionId,
          conversationId: run.conversationId,
          timestamp: deps.now(),
        };

        executionStartedAt = Date.now();
        rlog.info("agent_execution_started", {
          provider: runtimeProvider,
          model: localAgentModelIdForAcp(resolvedModel, runtimeProvider),
        });
        for await (const event of deps.localAgentRuntime.run({
          agentTargetId: effectiveAgentTargetId,
          runId: run.runId,
          provider: runtimeProvider,
          cwd: runDir,
          prompt,
          systemPrompt,
          ...(history.length > 0 ? { history } : {}),
          model: localAgentModelIdForAcp(resolvedModel, runtimeProvider),
          ...(runtimeEnv.tuttiCliPath
            ? { env: { TUTTI_CLI: runtimeEnv.tuttiCliPath } }
            : {}),
          runtimeKind: "local-agent",
          runtimeProvider,
          mcpServers,
          ...(resume ? { resume } : {}),
          signal: run.controller.signal,
          skillManifest,
          timeoutMs: resolveLocalAgentTimeoutMs(runtimeEnv),
          // Never leave Codex root markers in user-visible /workspace trees.
          ...(!ephemeralRunDir ? { writeCodexProjectRootMarker: false } : {}),
          metadata: { timingDiagnostics: true },
        })) {
          const timingDiagnostic = readAgentTimingDiagnostic(event);
          if (timingDiagnostic) {
            rlog.info("agent_kit_timing", {
              phase: timingDiagnostic.phase,
              stage: timingDiagnostic.stage,
              elapsed_ms: timingDiagnostic.elapsedMs,
              total_elapsed_ms: timingDiagnostic.totalElapsedMs,
              ...(timingDiagnostic.outcome
                ? { outcome: timingDiagnostic.outcome }
                : {}),
            });
            continue;
          }
          providerEventCount += 1;
          if (!firstProviderEventSeen) {
            firstProviderEventSeen = true;
            rlog.info("agent_execution_first_event", {
              elapsed_ms: Date.now() - executionStartedAt,
              event_type: event.type,
            });
          }
          if (!firstTextSeen && event.type === "text_delta") {
            firstTextSeen = true;
            rlog.info("agent_execution_first_text", {
              elapsed_ms: Date.now() - executionStartedAt,
            });
          }
          if (event.type === "tool_call") {
            toolCallCount += 1;
            toolStartedAt.set(event.id, Date.now());
            if (!firstToolSeen) {
              firstToolSeen = true;
              rlog.info("agent_execution_first_tool", {
                elapsed_ms: Date.now() - executionStartedAt,
                tool_name: event.name,
              });
            }
          }
          if (event.type === "tool_result") {
            toolResultCount += 1;
            const startedAt = toolStartedAt.get(event.id);
            rlog.info("agent_tool_done", {
              tool_name: event.name ?? "unknown",
              status: event.status ?? (event.isError ? "failed" : "completed"),
              ...(startedAt ? { elapsed_ms: Date.now() - startedAt } : {}),
            });
            toolStartedAt.delete(event.id);
          }
          if (event.type === "error") {
            lastError = event;
          }
          if (event.type === "done") {
            executionOutcome =
              event.status === "failed"
                ? "failed"
                : event.status === "canceled"
                  ? "canceled"
                  : "completed";
          }
          if (event.type === "done" && (event.sessionId || event.resumeToken)) {
            deps.recordProviderResumeMetadata?.({
              ...(event.sessionId
                ? { providerSessionId: event.sessionId }
                : {}),
              runId: run.runId,
              ...(event.resumeToken ? { resumeToken: event.resumeToken } : {}),
            });
          }

          const adaptedEvents = adaptLocalAgentEvent({
            event,
            messageId,
            now: deps.now,
            runId: run.runId,
            suppressedToolCallIds,
          });

          for (const adaptedEvent of adaptedEvents) {
            if (
              adaptedEvent.type === "run.completed" ||
              adaptedEvent.type === "run.canceled" ||
              adaptedEvent.type === "run.failed"
            ) {
              if (terminalEmitted) {
                continue;
              }
              terminalEmitted = true;

              if (
                adaptedEvent.type === "run.failed" &&
                lastError &&
                adaptedEvent.error.message === "Local agent run failed."
              ) {
                adaptedEvent.error = {
                  code: toAimcRunErrorCode(lastError.code),
                  message: lastError.message,
                };
              }
            }
            yield adaptedEvent;
          }
        }
      } catch (error) {
        executionOutcome = run.controller.signal.aborted
          ? "canceled"
          : "failed";
        rlog.error("agent_execution_error", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      } finally {
        if (executionStartedAt !== undefined) {
          rlog.info("agent_execution_done", {
            outcome: executionOutcome,
            elapsed_ms: Date.now() - executionStartedAt,
            event_count: providerEventCount,
            tool_call_count: toolCallCount,
            tool_result_count: toolResultCount,
            unfinished_tool_count: toolStartedAt.size,
          });
        }
        const cleanupStartedAt = Date.now();
        if (gatewaySessionToken) {
          deps.toolGateway.revokeSession(gatewaySessionToken);
        }
        if (ephemeralRunDir) {
          await rm(runDir, { recursive: true, force: true });
        } else {
          // Remove leftover markers from older kit versions / prior runs.
          await unlink(join(runDir, ".agent-acp-kit-codex-root")).catch(
            () => undefined,
          );
        }
        rlog.info("agent_cleanup_done", {
          elapsed_ms: Date.now() - cleanupStartedAt,
          total_elapsed_ms: Date.now() - appPrepareStartedAt,
          ephemeral: ephemeralRunDir,
        });
      }
    },
  };
}
