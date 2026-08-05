type TuttiExternalUserProject = {
  path: string;
  name?: string;
  displayName?: string;
};

type TuttiExternalUserProjects = {
  list?: () => Promise<
    TuttiExternalUserProject[] | { projects?: TuttiExternalUserProject[] }
  >;
  selectDirectory?: (input?: {
    initialPath?: string;
  }) => Promise<{ path: string } | null>;
};

function readTuttiExternalUserProjects(): TuttiExternalUserProjects | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as unknown as {
      tuttiExternal?: { userProjects?: TuttiExternalUserProjects };
    }
  ).tuttiExternal?.userProjects;
}

export async function listTuttiExternalUserProjects(): Promise<
  Array<{ path: string; name: string }>
> {
  const list = readTuttiExternalUserProjects()?.list;
  if (typeof list !== "function") return [];
  const result = await list();
  const projects = Array.isArray(result) ? result : (result?.projects ?? []);
  return projects
    .map((project) => {
      const path = typeof project.path === "string" ? project.path.trim() : "";
      if (!path) return null;
      const name =
        (typeof project.displayName === "string" &&
          project.displayName.trim()) ||
        (typeof project.name === "string" && project.name.trim()) ||
        path.split("/").filter(Boolean).pop() ||
        path;
      return { path, name };
    })
    .filter((project): project is { path: string; name: string } =>
      Boolean(project),
    );
}

export async function selectTuttiExternalUserProjectDirectory(input?: {
  initialPath?: string;
}): Promise<string | null> {
  const selectDirectory = readTuttiExternalUserProjects()?.selectDirectory;
  if (typeof selectDirectory !== "function") return null;
  const initialPath =
    typeof input?.initialPath === "string" ? input.initialPath.trim() : "";
  const selected = await selectDirectory(
    initialPath ? { initialPath } : undefined,
  );
  const path = selected?.path?.trim() ?? "";
  return path || null;
}
