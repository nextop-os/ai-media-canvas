import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { LocalStore } from "../local/store.js";

// Tutti workspace app reference protocol.
// Contract: app_factory_reference/references/manifest-contract.md
//   POST /tutti/references/list
// v1 exposes project-attributed media assets as a two-level tree:
//   root            -> one group per project (displayName = project name)
//   group "project:<id>" -> file references (displayName = file name)
// Only app projects are exposed at the root so ordering and membership match
// the in-app project list exactly.

const PROJECT_GROUP_PREFIX = "project:";

// Global Tutti file-type category ids -> file extensions (no leading dot).
// `other` is handled specially: it matches files with no recognized extension.
// Contract: app_factory_reference/references/manifest-contract.md (search).
// `document` includes spreadsheets; audio/code/archive extensions are not listed
// and therefore resolve to `other`.
const CATEGORY_EXTENSIONS: Record<string, readonly string[]> = {
  image: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
    "avif",
    "heic",
    "tiff",
    "ico",
  ],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpeg", "mpg"],
  document: [
    "pdf",
    "doc",
    "docx",
    "txt",
    "md",
    "markdown",
    "rtf",
    "odt",
    "pages",
    "key",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "csv",
    "tsv",
    "ods",
    "numbers",
  ],
  webpage: ["html", "htm", "mhtml", "url", "webloc"],
};
const KNOWN_EXTENSIONS = Array.from(
  new Set(Object.values(CATEGORY_EXTENSIONS).flat()),
);

// Resolve requested category ids into concrete extensions. Unknown ids are
// ignored; `other` requests files whose extension is not recognized.
function resolveFilters(filters: string[] | undefined): {
  extensions: string[];
  includeOther: boolean;
} {
  if (!filters || filters.length === 0) {
    return { extensions: [], includeOther: false };
  }
  const extensions = new Set<string>();
  let includeOther = false;
  for (const id of filters) {
    if (id === "other") {
      includeOther = true;
      continue;
    }
    const exts = CATEGORY_EXTENSIONS[id];
    if (exts) {
      for (const ext of exts) extensions.add(ext);
    }
  }
  return { extensions: Array.from(extensions), includeOther };
}

const timeRangeSchema = z
  .object({
    fromMs: z.number().finite().optional(),
    toMs: z.number().finite().optional(),
  })
  .optional();

const listRequestSchema = z
  .object({
    parentGroupId: z.string().min(1).nullish(),
    filterText: z.string().optional(),
    limit: z.number().int().optional(),
    cursor: z.string().nullish(),
    kinds: z.array(z.string()).optional(),
    timeRange: timeRangeSchema,
  })
  .passthrough();

const searchRequestSchema = z
  .object({
    query: z.string().optional(),
    limit: z.number().int().optional(),
    cursor: z.string().nullish(),
    kinds: z.array(z.string()).optional(),
    filters: z.array(z.string()).optional(),
    timeRange: timeRangeSchema,
  })
  .passthrough();

type FileReferenceItem = {
  type: "reference";
  reference: {
    kind: "file";
    displayName: string;
    location: {
      type: "workspace-path" | "app-data-relative";
      path: string;
    };
    sizeBytes?: number;
    mtimeMs?: number;
    mimeType?: string;
    parentGroupLabel?: string;
  };
};

type GroupItem = {
  type: "group";
  id: string;
  displayName: string;
  referenceCount: number;
};

export async function registerReferenceRoutes(
  app: FastifyInstance,
  options: { store: LocalStore },
) {
  const { store } = options;

  app.post("/tutti/references/list", async (request, reply) => {
    const parsed = listRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", detail: parsed.error.message });
    }

    const body = parsed.data;
    // Tutti clamps limit to 1..50; default to the max when omitted.
    const limit =
      typeof body.limit === "number"
        ? Math.max(1, Math.min(50, body.limit))
        : 50;
    const filterText = body.filterText?.trim() || undefined;
    const timeRange = body.timeRange;

    // Root level: list projects as navigational groups.
    if (!body.parentGroupId) {
      const { groups, nextCursor } = store.listReferenceProjectGroups({
        filterText,
        fromMs: timeRange?.fromMs,
        toMs: timeRange?.toMs,
        limit,
        cursor: body.cursor,
      });
      const items: GroupItem[] = groups.map((group) => ({
        type: "group",
        id: `${PROJECT_GROUP_PREFIX}${group.projectId}`,
        displayName: group.name,
        referenceCount: group.referenceCount,
      }));
      return reply.code(200).send({ items, nextCursor });
    }

    // Project level: list that project's media assets as file references.
    if (body.parentGroupId.startsWith(PROJECT_GROUP_PREFIX)) {
      const projectId = body.parentGroupId.slice(PROJECT_GROUP_PREFIX.length);
      if (!projectId) {
        return reply.code(200).send({ items: [], nextCursor: null });
      }
      const { files, nextCursor } = store.listReferenceProjectAssets({
        projectId,
        filterText,
        fromMs: timeRange?.fromMs,
        toMs: timeRange?.toMs,
        limit,
        cursor: body.cursor,
      });
      const items: FileReferenceItem[] = files.map((file) => ({
        type: "reference",
        reference: {
          kind: "file",
          displayName: file.displayName,
          location: file.location,
          ...(file.sizeBytes != null ? { sizeBytes: file.sizeBytes } : {}),
          ...(file.mtimeMs != null ? { mtimeMs: file.mtimeMs } : {}),
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        },
      }));
      return reply.code(200).send({ items, nextCursor });
    }

    // Unknown group id -> empty, navigable result.
    return reply.code(200).send({ items: [], nextCursor: null });
  });

  // Recursive search across the whole app. `query` and file-type `filters`
  // combine; either alone is valid ("filter-only" search returns recency order).
  app.post("/tutti/references/search", async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", detail: parsed.error.message });
    }

    const body = parsed.data;
    const limit =
      typeof body.limit === "number"
        ? Math.max(1, Math.min(50, body.limit))
        : 50;
    const query = body.query?.trim() || undefined;
    const timeRange = body.timeRange;
    const { extensions, includeOther } = resolveFilters(body.filters);

    const { files, nextCursor } = store.searchReferenceAssets({
      query,
      extensions,
      includeOther,
      knownExtensions: KNOWN_EXTENSIONS,
      fromMs: timeRange?.fromMs,
      toMs: timeRange?.toMs,
      limit,
      cursor: body.cursor,
    });
    const items: FileReferenceItem[] = files.map((file) => ({
      type: "reference",
      reference: {
        kind: "file",
        displayName: file.displayName,
        location: file.location,
        ...(file.sizeBytes != null ? { sizeBytes: file.sizeBytes } : {}),
        ...(file.mtimeMs != null ? { mtimeMs: file.mtimeMs } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.projectName != null
          ? { parentGroupLabel: file.projectName }
          : {}),
      },
    }));
    return reply.code(200).send({ items, nextCursor });
  });
}
