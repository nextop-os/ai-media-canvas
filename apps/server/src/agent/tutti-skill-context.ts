import {
  type TuttiAgentSkillContext,
  loadTuttiAgentSkillContext,
} from "@tutti-os/agent-acp-kit/tutti";

export function formatTuttiSkillGuidance(systemPrompt: string | undefined) {
  const trimmed = systemPrompt?.trim();
  return trimmed
    ? `Additional Tutti CLI skill guidance:\n${trimmed}`
    : undefined;
}

export function shouldUseTuttiSkillContext(prompt: string) {
  return prompt.includes("mention://");
}

export async function loadTuttiAgentSkillContextForRun(input: {
  agentTargetId: string;
  cwd: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<TuttiAgentSkillContext> {
  input.signal?.throwIfAborted();
  try {
    return await loadTuttiAgentSkillContext({
      agentTargetId: input.agentTargetId,
      agentSessionId: input.runId,
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    warnTuttiSkillContextFailure(error);
    return emptyTuttiSkillContext();
  }
}

function emptyTuttiSkillContext(): TuttiAgentSkillContext {
  return { source: "standalone", skillManifest: [], skills: [] };
}

function warnTuttiSkillContextFailure(error: unknown) {
  console.warn(
    `[aimc] Unable to load Tutti agent skill bundle: ${errorMessage(error)}`,
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
