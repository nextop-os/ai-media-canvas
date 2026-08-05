"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  listTuttiExternalUserProjects,
  selectTuttiExternalUserProjectDirectory,
} from "@/lib/host-files";
import { cn } from "@/lib/utils";

const LINK_EXISTING_VALUE = "__tsh_link_existing_project__";
const WORKSPACE_ROOT = "/workspace";

export function ParentPathPicker(props: {
  disabled?: boolean;
  linkExistingLabel: string;
  parentPath: string;
  placeholder: string;
  title?: string;
  workspaceRootLabel: string;
  className?: string;
  onParentPathChange: (value: string) => void;
}) {
  const [projects, setProjects] = useState<Array<{ path: string; name: string }>>(
    [],
  );
  const options = useMemo(() => {
    const byPath = new Map<string, string>();
    byPath.set(WORKSPACE_ROOT, props.workspaceRootLabel);
    for (const project of projects) {
      if (project.path !== WORKSPACE_ROOT) {
        byPath.set(project.path, project.name);
      }
    }
    const current = props.parentPath.trim() || WORKSPACE_ROOT;
    if (!byPath.has(current)) {
      byPath.set(current, formatParentPathLabel(current, props.placeholder));
    }
    return [...byPath.entries()].map(([path, name]) => ({ path, name }));
  }, [
    projects,
    props.parentPath,
    props.placeholder,
    props.workspaceRootLabel,
  ]);

  useEffect(() => {
    let cancelled = false;
    void listTuttiExternalUserProjects()
      .then((next) => {
        if (!cancelled) setProjects(next);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn("relative min-w-0 max-w-[11rem]", props.className)}>
      <select
        className="h-8 w-full appearance-none truncate rounded-full border border-border bg-background px-3 pr-8 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.disabled}
        value={props.parentPath.trim() || WORKSPACE_ROOT}
        aria-label={props.placeholder}
        title={props.title ?? props.placeholder}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === LINK_EXISTING_VALUE) {
            void selectTuttiExternalUserProjectDirectory({
              initialPath: props.parentPath.trim() || WORKSPACE_ROOT,
            })
              .then((path) => {
                if (!path) return;
                props.onParentPathChange(path);
                setProjects((current) => {
                  if (current.some((project) => project.path === path)) {
                    return current;
                  }
                  return [
                    ...current,
                    { path, name: formatParentPathLabel(path, path) },
                  ];
                });
              })
              .catch(() => undefined);
            return;
          }
          props.onParentPathChange(next);
        }}
      >
        {options.map((option) => (
          <option key={option.path} value={option.path}>
            {option.name}
          </option>
        ))}
        <option value={LINK_EXISTING_VALUE}>{props.linkExistingLabel}</option>
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        size={14}
      />
    </div>
  );
}

function formatParentPathLabel(path: string, fallback: string) {
  const trimmed = path.trim();
  if (!trimmed) return fallback;
  return trimmed.split("/").filter(Boolean).pop() || trimmed;
}
