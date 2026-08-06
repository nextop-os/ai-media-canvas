import { tool } from "langchain";
import { z } from "zod";

export type SetProjectTitleResult = {
  projectId: string;
  success: true;
  title: string;
  workspaceRoot?: string | null;
};

export type SetProjectTitleFn = (input: {
  canvasId: string;
  title: string;
}) => Promise<SetProjectTitleResult>;

export function createSetProjectTitleTool(deps: {
  setProjectTitle: SetProjectTitleFn;
}) {
  return tool(
    async (
      input: { title: string },
      config?: {
        configurable?: {
          canvas_id?: string;
        };
      },
    ) => {
      const canvasId = config?.configurable?.canvas_id?.trim();
      if (!canvasId) {
        throw new Error(
          "No active canvas is bound to this tool session; cannot set project title.",
        );
      }
      const title = input.title.trim();
      if (!title) {
        throw new Error("title is required");
      }
      return deps.setProjectTitle({ canvasId, title });
    },
    {
      name: "set_project_title",
      description:
        "Set the current project's human-readable display title. The current project is inferred from the active canvas; do not pass a project id. This does not rename the project directory. Call this early when the title is still a placeholder such as Untitled.",
      schema: z.object({
        title: z
          .string()
          .describe(
            "Concise human project title. Prefer a short topic name over the raw user instruction.",
          ),
      }),
    },
  );
}
