import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");
const buildRoot = path.join(rootDir, "build", "tutti-app");
const packageRoot = path.join(buildRoot, "package");
const DEFAULT_PACKAGE_MTIME_EPOCH_SECONDS = 1_577_836_800;

const REQUIRED_PACKAGE_FILES = [
  "tutti.app.json",
  "tutti.cli.json",
  "COMMANDS.md",
  "AGENTS.md",
  "bootstrap.sh",
  "server/server.js",
  "server/worker.js",
  "server/tools-mcp.js",
];

const CLI_SCOPE = "aimc";
const CLI_COMMANDS = [
  {
    path: ["status"],
    summary: "Show app status",
    description:
      "Return AI Canvas server health, app version, and local runtime metadata.",
  },
  {
    path: ["open"],
    summary: "Open AI Canvas",
    description:
      "Open AI Canvas in Tutti Desktop. When project-id is provided, open that project's primary canvas; otherwise open the app home page.",
    properties: {
      "project-id": {
        type: "string",
        description: "Optional project id to open.",
      },
    },
  },
  {
    path: ["projects", "list"],
    summary: "List projects",
    description: "List local AI Canvas projects.",
  },
  {
    path: ["projects", "get"],
    summary: "Get a project",
    description: "Return one local AI Canvas project by project-id.",
    properties: {
      "project-id": { type: "string", description: "Project id to load." },
    },
    required: ["project-id"],
  },
  {
    path: ["projects", "create"],
    summary: "Create a project",
    description:
      "Create a local AI Canvas project. Use the returned primaryCanvas.id before saving canvas content.",
    properties: {
      name: { type: "string", description: "Project name." },
      description: {
        type: "string",
        description: "Optional project description.",
      },
      "parent-path": {
        type: "string",
        description:
          "Optional TSH parent directory under /workspace for the project folder.",
      },
    },
    required: ["name"],
  },
  {
    path: ["canvases", "get"],
    summary: "Get a canvas",
    description: "Return canvas content by canvas-id.",
    properties: {
      "canvas-id": { type: "string", description: "Canvas id to load." },
    },
    required: ["canvas-id"],
  },
  {
    path: ["canvases", "save"],
    summary: "Save a canvas",
    description:
      "Save small canvas content by canvas-id. Do not embed generated media data in content-json; use aimc canvases insert-image or aimc canvases insert-video for local media files.",
    properties: {
      "canvas-id": { type: "string", description: "Canvas id to save." },
      "content-json": {
        type: "string",
        description: "Canvas content JSON string without embedded media data.",
      },
    },
    required: ["canvas-id", "content-json"],
  },
  {
    path: ["canvases", "insert-image"],
    summary: "Insert a local image file into a canvas",
    description:
      "Import a local image file as a managed AI Media Canvas asset and insert it into the canvas. Prefer this after an agent generates a PNG/JPEG/WebP/GIF/SVG file locally instead of embedding image data in canvases save content-json.",
    properties: {
      "canvas-id": { type: "string", description: "Canvas id to update." },
      "file-path": {
        type: "string",
        description: "Absolute path to the local image file to import.",
      },
      "project-id": {
        type: "string",
        description: "Optional project id for asset ownership.",
      },
      title: {
        type: "string",
        description: "Optional image title stored in canvas metadata.",
      },
      "mime-type": {
        type: "string",
        description: "Optional image MIME type override.",
      },
      width: {
        type: "integer",
        description: "Optional source image width when it cannot be detected.",
      },
      height: {
        type: "integer",
        description: "Optional source image height when it cannot be detected.",
      },
      x: {
        type: "integer",
        description: "Optional canvas placement x coordinate.",
      },
      y: {
        type: "integer",
        description: "Optional canvas placement y coordinate.",
      },
      "placement-width": {
        type: "integer",
        description: "Optional display width on the canvas.",
      },
      "placement-height": {
        type: "integer",
        description: "Optional display height on the canvas.",
      },
    },
    required: ["canvas-id", "file-path"],
  },
  {
    path: ["canvases", "insert-video"],
    summary: "Insert a local video file into a canvas",
    description:
      "Import a local video file as a managed AI Media Canvas asset and insert it into the canvas. Prefer this after an agent generates an MP4/MOV/WebM file locally instead of embedding media data in canvases save content-json.",
    properties: {
      "canvas-id": { type: "string", description: "Canvas id to update." },
      "file-path": {
        type: "string",
        description: "Absolute path to the local video file to import.",
      },
      "project-id": {
        type: "string",
        description: "Optional project id for asset ownership.",
      },
      title: {
        type: "string",
        description: "Optional video title stored in canvas metadata.",
      },
      "mime-type": {
        type: "string",
        description: "Optional video MIME type override.",
      },
      width: {
        type: "integer",
        description: "Optional source video width, defaults to 1280.",
      },
      height: {
        type: "integer",
        description: "Optional source video height, defaults to 720.",
      },
      duration: {
        type: "integer",
        description: "Optional video duration in seconds.",
      },
      x: {
        type: "integer",
        description: "Optional canvas placement x coordinate.",
      },
      y: {
        type: "integer",
        description: "Optional canvas placement y coordinate.",
      },
      "placement-width": {
        type: "integer",
        description: "Optional display width on the canvas.",
      },
      "placement-height": {
        type: "integer",
        description: "Optional display height on the canvas.",
      },
    },
    required: ["canvas-id", "file-path"],
  },
  {
    path: ["assets", "list"],
    summary: "List project assets",
    description:
      "List reusable media assets referenced by a project. Use this instead of reading full canvas JSON when an agent only needs project images or videos.",
    properties: {
      "project-id": {
        type: "string",
        description: "Project id whose media assets should be listed.",
      },
      "filter-text": {
        type: "string",
        description: "Optional filename or asset id filter.",
      },
      limit: {
        type: "integer",
        description: "Optional page size from 1 to 50.",
      },
      cursor: {
        type: "string",
        description: "Optional cursor from a previous response.",
      },
    },
    required: ["project-id"],
  },
  {
    path: ["sessions", "list"],
    summary: "List chat sessions",
    description: "List chat sessions for a canvas-id.",
    properties: {
      "canvas-id": {
        type: "string",
        description: "Canvas id whose sessions should be listed.",
      },
    },
    required: ["canvas-id"],
  },
  {
    path: ["sessions", "create"],
    summary: "Create a chat session",
    description:
      "Create a chat session for a canvas-id. Use the returned session.id for messages and agent runs.",
    properties: {
      "canvas-id": {
        type: "string",
        description: "Canvas id for the new session.",
      },
      title: { type: "string", description: "Optional session title." },
    },
    required: ["canvas-id"],
  },
  {
    path: ["messages", "list"],
    summary: "List chat messages",
    description: "List messages in a chat session by session-id.",
    properties: {
      "session-id": { type: "string", description: "Chat session id." },
    },
    required: ["session-id"],
  },
  {
    path: ["messages", "create"],
    summary: "Create a chat message",
    description:
      "Append a text-only user or assistant message to a chat session.",
    properties: {
      "session-id": { type: "string", description: "Chat session id." },
      role: { type: "string", description: "Message role: user or assistant." },
      content: { type: "string", description: "Message text content." },
    },
    required: ["session-id", "role", "content"],
  },
  {
    path: ["agent", "run"],
    summary: "Start an agent run",
    description:
      "Start an AI Canvas agent run for a session and conversation. Poll events with aimc agent events --run-id <runId>. For local agents, inspect aimc models list and pass the exact --agent-id. Runtime provider is returned only as execution metadata. If a non-Codex local agent needs Codex image generation and the user selected only this time, pass --codex-imagegen-consent allow-once on the follow-up run.",
    properties: {
      "session-id": { type: "string", description: "Chat session id." },
      "conversation-id": {
        type: "string",
        description:
          "Conversation or canvas id used for streamed canvas events.",
      },
      prompt: { type: "string", description: "User prompt for the agent." },
      "canvas-id": {
        type: "string",
        description: "Optional canvas id for canvas event replay.",
      },
      model: {
        type: "string",
        description:
          "Optional agent model id advertised for the exact Agent Target by aimc models list.",
      },
      "agent-id": {
        type: "string",
        description:
          "Exact local Agent Target id from aimc models list. Required for local-agent runs.",
      },
      "runtime-provider": {
        type: "string",
        description:
          "Deprecated compatibility selector. Use agent-id. Accepted only when exactly one Agent Target uses the provider.",
      },
      "runtime-kind": {
        type: "string",
        description: "Optional runtime kind, for example local-agent.",
      },
      "codex-imagegen-consent": {
        type: "string",
        description:
          "Optional one-time consent for a follow-up run after the user allowed a non-Codex agent to use Codex image generation. Only allow-once is accepted.",
      },
    },
    required: ["session-id", "conversation-id", "prompt"],
    timeoutMs: 60000,
  },
  {
    path: ["agent", "events"],
    summary: "Poll agent events",
    description:
      "Poll persisted events for an agent run. Use cursor from the previous response nextCursor to continue.",
    properties: {
      "run-id": { type: "string", description: "Agent run id." },
      cursor: {
        type: "integer",
        description: "Optional event cursor, defaults to 0.",
      },
    },
    required: ["run-id"],
  },
  {
    path: ["agent", "cancel"],
    summary: "Cancel an agent run",
    description: "Cancel an active agent run by run-id.",
    properties: {
      "run-id": { type: "string", description: "Agent run id." },
    },
    required: ["run-id"],
  },
  {
    path: ["agent", "consent"],
    summary: "Record durable Codex image consent",
    description:
      "Record a structured Codex image generation consent decision for an agent run after the user explicitly responds. The always decision updates the durable workspace setting. For allow-once, pass --codex-imagegen-consent allow-once on the follow-up agent run or generation image command.",
    properties: {
      "run-id": { type: "string", description: "Agent run id." },
      decision: {
        type: "string",
        description: "Consent decision: allow-once, always, or deny.",
      },
    },
    required: ["run-id", "decision"],
  },
  {
    path: ["generation", "image"],
    summary: "Queue image generation",
    description:
      "Queue an image generation job under a project. Create or choose a project first, pass its id with --project-id; when --canvas-id is omitted, the app uses the project's primary canvas and auto-places the generation node in available space. Use aimc models image to inspect available model ids, pass one with --model, then poll aimc jobs get --job-id with the returned job.id until status is succeeded, failed, canceled, or dead_letter; queued and running are intermediate states, not final results or failures. On succeeded, report the generated asset from job.result and mention that the canvas node was updated. Direct user calls may use --direct-user true. Otherwise this command is treated as an external CLI/agent call; when a non-Codex agent calls Codex image generation on the user's behalf, ask for confirmation first unless settings get shows codexImagegenDelegation=always; pass --caller-provider and --codex-imagegen-consent allow-once after a one-time user approval.",
    properties: {
      prompt: { type: "string", description: "Image prompt." },
      model: {
        type: "string",
        description:
          "Required image model id from aimc models image, for example agnes-image/agnes-image-2.1-flash.",
      },
      "project-id": {
        type: "string",
        description:
          "Project id that owns the generated asset and whose primary canvas receives the generation node when --canvas-id is omitted. Create one first with aimc projects create when needed.",
      },
      "canvas-id": {
        type: "string",
        description:
          "Optional canvas id. Omit to use the project's primary canvas.",
      },
      "session-id": { type: "string", description: "Optional session id." },
      "aspect-ratio": { type: "string", description: "Optional aspect ratio." },
      quality: {
        type: "string",
        description: "Optional quality: standard, hd, or ultra.",
      },
      size: { type: "string", description: "Optional image size." },
      seed: { type: "integer", description: "Optional integer seed." },
      "input-images": {
        type: "string",
        description: "Optional comma-separated input image URLs.",
      },
      "caller-provider": {
        type: "string",
        description:
          "Optional agent provider id when an agent is proxying this direct image generation call, for example claude. Omit for direct user generation.",
      },
      "codex-imagegen-consent": {
        type: "string",
        description:
          "Optional one-time consent after the user allowed a non-Codex caller to use Codex image generation. Only allow-once is accepted.",
      },
      "direct-user": {
        type: "boolean",
        description:
          "Set true only when this is a direct user image generation command, not an agent proxy call.",
      },
    },
    required: ["prompt", "model", "project-id"],
    timeoutMs: 60000,
  },
  {
    path: ["generation", "video"],
    summary: "Queue video generation",
    description:
      "Queue a video generation job under a project. Create or choose a project first, pass its id with --project-id; when --canvas-id is omitted, the app uses the project's primary canvas and auto-places the generation node in available space. Use aimc models video to inspect available model ids first, pass one with --model, then poll aimc jobs get --job-id with the returned job.id until status is succeeded, failed, canceled, or dead_letter; queued and running are intermediate states, not final results or failures. On succeeded, report the generated asset from job.result and mention that the canvas node was updated.",
    properties: {
      prompt: { type: "string", description: "Video prompt." },
      model: {
        type: "string",
        description: "Required video model id from aimc models video.",
      },
      "project-id": {
        type: "string",
        description:
          "Project id that owns the generated asset and whose primary canvas receives the generation node when --canvas-id is omitted. Create one first with aimc projects create when needed.",
      },
      "canvas-id": {
        type: "string",
        description:
          "Optional canvas id. Omit to use the project's primary canvas.",
      },
      "session-id": { type: "string", description: "Optional session id." },
      duration: {
        type: "integer",
        description: "Optional duration in seconds.",
      },
      resolution: { type: "string", description: "Optional resolution." },
      "aspect-ratio": { type: "string", description: "Optional aspect ratio." },
      "input-images": {
        type: "string",
        description: "Optional comma-separated input image URLs.",
      },
      "input-video": {
        type: "string",
        description: "Optional input video URL.",
      },
      "negative-prompt": {
        type: "string",
        description: "Optional negative prompt.",
      },
      seed: { type: "integer", description: "Optional integer seed." },
      "enable-audio": {
        type: "boolean",
        description: "Optional audio generation flag.",
      },
    },
    required: ["prompt", "model", "project-id"],
    timeoutMs: 60000,
  },
  {
    path: ["jobs", "list"],
    summary: "List jobs",
    description:
      "List background generation jobs. Filter with status or job-type when needed.",
    properties: {
      status: { type: "string", description: "Optional job status filter." },
      "job-type": {
        type: "string",
        description: "Optional job type: image_generation or video_generation.",
      },
    },
  },
  {
    path: ["jobs", "get"],
    summary: "Get a job",
    description:
      "Return one background job by job-id. queued and running mean the job is still in progress; keep polling before giving the user a final answer. Treat only succeeded, failed, canceled, and dead_letter as terminal statuses.",
    properties: {
      "job-id": { type: "string", description: "Job id to load." },
    },
    required: ["job-id"],
  },
  {
    path: ["jobs", "cancel"],
    summary: "Cancel a job",
    description: "Cancel one queued or running background job by job-id.",
    properties: {
      "job-id": { type: "string", description: "Job id to cancel." },
    },
    required: ["job-id"],
  },
  {
    path: ["models", "list"],
    summary: "List agent models",
    description:
      "List configured assistant models plus discoverable local Agent Targets and their exact agentTargetId values.",
  },
  {
    path: ["models", "image"],
    summary: "List image models",
    description: "List image generation models available to generation image.",
  },
  {
    path: ["models", "video"],
    summary: "List video models",
    description: "List video generation models available to generation video.",
  },
  {
    path: ["settings", "get"],
    summary: "Get workspace settings",
    description:
      "Return workspace settings, including settings.codexImagegenDelegation. Values: ask means a non-Codex agent must ask before using Codex image generation; always means it may use Codex by default; never means it must not use Codex image generation.",
  },
  {
    path: ["settings", "update"],
    summary: "Update workspace settings",
    description:
      "Patch workspace settings. Use --codex-imagegen-delegation always after the user chooses 'always call', --codex-imagegen-delegation never only for a durable opt-out, and ask to restore prompting.",
    properties: {
      "codex-imagegen-delegation": {
        type: "string",
        description: "Codex image delegation setting: ask, always, or never.",
      },
    },
  },
  {
    path: ["skills", "list"],
    summary: "List skills",
    description: "List installed AI Canvas skills.",
  },
  {
    path: ["skills", "get"],
    summary: "Get a skill",
    description: "Return skill detail by skill-id.",
    properties: {
      "skill-id": { type: "string", description: "Skill id to load." },
    },
    required: ["skill-id"],
  },
  {
    path: ["skills", "enable"],
    summary: "Enable or disable a skill",
    description: "Enable or disable an installed skill by skill-id.",
    properties: {
      "skill-id": { type: "string", description: "Skill id to update." },
      enabled: {
        type: "boolean",
        description: "Whether the skill should be enabled.",
      },
    },
    required: ["skill-id", "enabled"],
  },
  {
    path: ["skills", "install"],
    summary: "Install a bundled skill",
    description: "Install a bundled catalog skill by skill-id.",
    properties: {
      "skill-id": {
        type: "string",
        description: "Catalog skill id to install.",
      },
    },
    required: ["skill-id"],
  },
];

const MANIFEST_LOCALIZATIONS = {
  "zh-CN": {
    file: "locales/zh-CN/manifest.json",
    metadata: {
      name: "AI Canvas",
      description: "在画布上生成和整理 AI 图片、视频。",
      tags: ["生成式 AI", "本地优先", "媒体画布"],
    },
  },
};

export function createManifest({ version }) {
  return {
    schemaVersion: "tutti.app.manifest.v1",
    appId: "ai-media-canvas",
    version,
    name: "AI Canvas",
    description: "Generate and organize AI images and videos on a canvas.",
    icon: {
      type: "asset",
      src: "icon.png",
    },
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/api/health",
    },
    cli: {
      manifest: "tutti.cli.json",
    },
    hostCompatibility: {
      requiredTuttiCapabilities: ["managed-model-cli-v1"],
    },
    references: {
      listEndpoint: "/tutti/references/list",
      searchEndpoint: "/tutti/references/search",
    },
    localizationInfo: {
      defaultLocale: "en",
      additionalLocales: Object.entries(MANIFEST_LOCALIZATIONS).map(
        ([locale, { file }]) => ({
          locale,
          file,
        }),
      ),
    },
    launch: {
      mode: "workspace-open",
    },
    author: {
      name: "Tutti",
    },
    tags: ["generated", "local-first", "media-canvas"],
  };
}

export function createCliManifest() {
  return {
    schemaVersion: "tutti.app.cli.v1",
    scope: CLI_SCOPE,
    description:
      "Control AI Canvas projects, canvases, generation jobs, agent runs, and skills.",
    documentation: {
      file: "COMMANDS.md",
    },
    commands: CLI_COMMANDS.map((command) => createCliCommand(command)),
  };
}

function createCliCommand(command) {
  return {
    path: command.path,
    summary: command.summary,
    description: command.description,
    inputSchema: {
      type: "object",
      properties: command.properties ?? {},
      ...(command.required?.length ? { required: command.required } : {}),
    },
    output: {
      defaultMode: "json",
      json: true,
    },
    handler: {
      kind: "http",
      method: "POST",
      path: `/tutti/cli/${command.path.join("/")}`,
      timeoutMs: command.timeoutMs ?? 30000,
    },
  };
}

export function renderCommandsGuide() {
  const manifest = createCliManifest();
  const rows = manifest.commands
    .map((command) => {
      const required = command.inputSchema.required ?? [];
      const flags = Object.keys(command.inputSchema.properties)
        .map((key) => `--${key}${required.includes(key) ? " <required>" : ""}`)
        .join(" ");
      const usage = [manifest.scope, ...command.path, flags]
        .filter(Boolean)
        .join(" ");
      return `### \`${usage}\`\n\n${command.description}\n\nHandler: \`${command.handler.path}\`\n`;
    })
    .join("\n");

  return `# AI Canvas CLI Commands\n\nScope: \`${manifest.scope}\`\n\nThese commands expose AI Canvas to the Tutti app CLI. Command outputs are JSON \`CliCommandOutput\` envelopes.\n\n${rows}`;
}

export function renderBootstrap({ version = "0.0.0" } = {}) {
  return `#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir="\${TUTTI_APP_PACKAGE_DIR:-$script_dir}"

export HOST="\${TUTTI_APP_HOST:-127.0.0.1}"
export AIMC_SERVER_PORT="\${TUTTI_APP_PORT:-3001}"
export AIMC_APP_VERSION="${version}"
export AIMC_WEB_DIST="$package_dir/dist"
export AIMC_DATA_ROOT="\${TUTTI_APP_DATA_DIR:-$package_dir/.data}"
export AIMC_DATABASE_ROOT="\${TUTTI_APP_DATABASE_DIR:-$AIMC_DATA_ROOT}"
export AIMC_SKILLS_ROOT="$package_dir/skills"
export AIMC_TOOLS_MCP_PATH="$package_dir/server/tools-mcp.js"
export AIMC_AGENT_FILES_ROOT="$AIMC_DATA_ROOT"

base_url="\${TUTTI_APP_BASE_URL:-http://$HOST:$AIMC_SERVER_PORT}"
export AIMC_WEB_ORIGIN="$base_url"
export AIMC_SERVER_BASE_URL="$base_url"

node_bin="\${TUTTI_APP_NODE:-node}"
runtime_dir="\${TUTTI_APP_RUNTIME_DIR:-$AIMC_DATA_ROOT/.runtime}"
mkdir -p "$AIMC_DATA_ROOT" "$AIMC_DATABASE_ROOT" "$runtime_dir"
legacy_db="$AIMC_DATA_ROOT/ai-media-canvas.db"
database_db="$AIMC_DATABASE_ROOT/ai-media-canvas.db"
if [ "$legacy_db" != "$database_db" ] && [ ! -e "$database_db" ] && [ -f "$legacy_db" ]; then
  database_tmp="$database_db.migrate-$$"
  wal_tmp="$database_db-wal.migrate-$$"
  rm -f "$database_tmp" "$wal_tmp"
  if [ -f "$legacy_db-wal" ]; then
    cp "$legacy_db-wal" "$wal_tmp"
    mv "$wal_tmp" "$database_db-wal"
  fi
  cp "$legacy_db" "$database_tmp"
  mv "$database_tmp" "$database_db"
fi
worker_status_file="$runtime_dir/worker.exit"
server_status_file="$runtime_dir/server.exit"
rm -f "$worker_status_file" "$server_status_file"

run_child() {
  target=$1
  status_file=$2
  "$node_bin" "$target" &
  child_pid=$!
  trap 'kill "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; exit 143' INT TERM
  wait "$child_pid"
  child_status=$?
  printf "%s\\n" "$child_status" > "$status_file"
  exit "$child_status"
}

monitor_children() {
  while :; do
    if [ -f "$worker_status_file" ]; then
      child_status=$(cat "$worker_status_file")
      return "$child_status"
    fi
    if [ -f "$server_status_file" ]; then
      child_status=$(cat "$server_status_file")
      return "$child_status"
    fi
    if ! kill -0 "$worker_pid" 2>/dev/null; then
      wait "$worker_pid" 2>/dev/null
      return $?
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      wait "$server_pid" 2>/dev/null
      return $?
    fi
    sleep 1
  done
}

run_child "$package_dir/server/worker.js" "$worker_status_file" &
worker_pid=$!
run_child "$package_dir/server/server.js" "$server_status_file" &
server_pid=$!

cleanup() {
  status=$?
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  kill "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  exit "$status"
}

trap cleanup INT TERM EXIT

monitor_children
`;
}

export function renderAgentsGuide() {
  return `# AI Canvas Tutti Package

This package runs AI Canvas as a Tutti workspace app.

## Package Layout

- \`tutti.app.json\`: Tutti manifest.
- \`bootstrap.sh\`: executable runtime entrypoint.
- \`dist/\`: static frontend files from \`apps/web/out\`.
- \`server/server.js\`: bundled Fastify server.
- \`server/worker.js\`: bundled background worker for queued generation jobs.
- \`skills/\`: packaged local skills used by the app runtime.
- \`icon.png\`: App Center icon with its own contrast-safe background.

## Runtime

Tutti executes \`bootstrap.sh\` with no arguments. The bootstrap script binds
the server to \`TUTTI_APP_HOST:TUTTI_APP_PORT\`, serves \`dist/\`, stores local
assets under \`TUTTI_APP_DATA_DIR\`, and stores active SQLite files under
\`TUTTI_APP_DATABASE_DIR\` when the runtime provides it.
When those variables are absent during local direct startup, it falls back to
\`127.0.0.1:3001\`, \`./.data\`, and the system \`node\` command.

Treat \`TUTTI_APP_PACKAGE_DIR\` as read-only. Use \`TUTTI_APP_DATA_DIR\` for
shared durable files, \`TUTTI_APP_DATABASE_DIR\` for VM-local SQLite files,
\`TUTTI_APP_RUNTIME_DIR\` for scratch files, and
\`TUTTI_APP_LOG_DIR\` for additional logs if future changes add them.

## Codex Image Generation Consent

When the current agent provider is not Codex, do not silently call
\`aimc generation image --model codex/gpt-image-2\` on the user's behalf unless
\`aimc settings get\` reports \`settings.codexImagegenDelegation\` as
\`always\`. If the setting is \`ask\`, ask the user for consent in the user's
language and convert the answer into a structured decision.

After one-time approval, call the image command with \`--caller-provider
<provider>\` and \`--codex-imagegen-consent allow-once\`. After durable
approval, first call
\`aimc settings update --codex-imagegen-delegation always\`, then continue.
If the user denies delegation, do not call Codex for that task.

Only pass \`--direct-user true\` when the user is directly invoking image
generation rather than asking an agent to proxy the request.
`;
}

export function createWebBuildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    AIMC_SERVER_BASE_URL: "",
    NEXT_PUBLIC_AIMC_SERVER_BASE_URL: "",
  };
}

export async function assertNoSymlinks(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Package contains symlink: ${path.relative(root, entryPath)}`,
      );
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

export async function validatePackageRoot(root) {
  for (const relativePath of REQUIRED_PACKAGE_FILES) {
    const absolutePath = path.join(root, relativePath);
    try {
      await access(absolutePath);
    } catch {
      throw new Error(`Missing required package file: ${relativePath}`);
    }
  }

  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  if (agents.trim().length === 0) {
    throw new Error("AGENTS.md must be non-empty.");
  }

  const bootstrapStat = await stat(path.join(root, "bootstrap.sh"));
  if ((bootstrapStat.mode & 0o111) === 0) {
    throw new Error("bootstrap.sh must be executable.");
  }

  const manifest = JSON.parse(
    await readFile(path.join(root, "tutti.app.json"), "utf8"),
  );
  if (manifest.runtime && "kind" in manifest.runtime) {
    throw new Error("tutti.app.json must not declare runtime.kind.");
  }
  if (manifest.cli?.manifest !== "tutti.cli.json") {
    throw new Error(
      "tutti.app.json must declare cli.manifest as tutti.cli.json.",
    );
  }

  const cliManifest = JSON.parse(
    await readFile(path.join(root, "tutti.cli.json"), "utf8"),
  );
  validateCliManifest(cliManifest);
  const docsFile = cliManifest.documentation?.file;
  if (typeof docsFile !== "string" || docsFile !== "COMMANDS.md") {
    throw new Error(
      "tutti.cli.json must declare documentation.file as COMMANDS.md.",
    );
  }
  const commandsGuide = await readFile(path.join(root, docsFile), "utf8");
  if (commandsGuide.trim().length === 0) {
    throw new Error("COMMANDS.md must be non-empty.");
  }

  for (const locale of manifest.localizationInfo?.additionalLocales ?? []) {
    const localeFile = locale?.file;
    if (typeof localeFile !== "string" || localeFile.length === 0) {
      throw new Error(
        "Manifest localization file must be a non-empty relative path.",
      );
    }
    try {
      await access(path.join(root, localeFile));
    } catch {
      throw new Error(`Missing manifest localization file: ${localeFile}`);
    }
  }

  await assertNoSymlinks(root);
}

function validateCliManifest(manifest) {
  if (manifest.schemaVersion !== "tutti.app.cli.v1") {
    throw new Error("tutti.cli.json must use schemaVersion tutti.app.cli.v1.");
  }
  if (!isCliPathSegment(manifest.scope)) {
    throw new Error(
      "tutti.cli.json scope must be lowercase letters, numbers, or hyphen.",
    );
  }
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new Error("tutti.cli.json must declare commands.");
  }

  const seenCommands = new Set();
  for (const command of manifest.commands) {
    if (!Array.isArray(command.path) || command.path.length === 0) {
      throw new Error("CLI command path must be a non-empty array.");
    }
    for (const segment of command.path) {
      if (!isCliPathSegment(segment)) {
        throw new Error(`Invalid CLI command path segment: ${segment}`);
      }
      if (segment === manifest.scope) {
        throw new Error("CLI command path must not repeat the scope.");
      }
    }

    const commandKey = command.path.join(" ");
    if (seenCommands.has(commandKey)) {
      throw new Error(`Duplicate CLI command: ${commandKey}`);
    }
    seenCommands.add(commandKey);

    if (!command.summary || !command.description) {
      throw new Error(
        `CLI command ${commandKey} must describe itself for agents.`,
      );
    }
    if (
      command.handler?.kind !== "http" ||
      command.handler?.method !== "POST"
    ) {
      throw new Error(
        `CLI command ${commandKey} must use an HTTP POST handler.`,
      );
    }
    const expectedHandlerPath = `/tutti/cli/${command.path.join("/")}`;
    if (command.handler?.path !== expectedHandlerPath) {
      throw new Error(
        `CLI command ${commandKey} handler.path must be ${expectedHandlerPath}.`,
      );
    }
    validateCliInputSchema(commandKey, command.inputSchema);
  }
}

function validateCliInputSchema(commandKey, schema) {
  if (schema?.type !== "object" || typeof schema.properties !== "object") {
    throw new Error(
      `CLI command ${commandKey} inputSchema must be an object schema.`,
    );
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    throw new Error(
      `CLI command ${commandKey} inputSchema.required must be an array.`,
    );
  }
  for (const [propertyName, property] of Object.entries(schema.properties)) {
    if (!isCliPathSegment(propertyName)) {
      throw new Error(
        `CLI command ${commandKey} has invalid input name: ${propertyName}`,
      );
    }
    if (!["string", "boolean", "integer"].includes(property?.type)) {
      throw new Error(
        `CLI command ${commandKey} input ${propertyName} must be string, boolean, or integer.`,
      );
    }
    if (required.includes(propertyName) && !property.description) {
      throw new Error(
        `CLI command ${commandKey} required input ${propertyName} must have a description.`,
      );
    }
  }
  for (const requiredName of required) {
    if (!(requiredName in schema.properties)) {
      throw new Error(
        `CLI command ${commandKey} requires unknown input ${requiredName}.`,
      );
    }
  }
}

function isCliPathSegment(value) {
  return typeof value === "string" && /^[a-z0-9-]+$/.test(value);
}

async function readSourceManifest() {
  return JSON.parse(
    await readFile(path.join(rootDir, "tutti.app.json"), "utf8"),
  );
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`),
      );
    });
  });
}

async function runCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: false,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}: ${stderr}`,
        ),
      );
    });
  });
}

function parseEpochSeconds(value) {
  if (!value) {
    return null;
  }
  const epochSeconds = Number(value);
  if (!Number.isInteger(epochSeconds) || epochSeconds < 0) {
    return null;
  }
  return epochSeconds;
}

export async function resolvePackageMtime(baseEnv = process.env) {
  const sourceDateEpoch = parseEpochSeconds(baseEnv.SOURCE_DATE_EPOCH);
  if (sourceDateEpoch !== null) {
    return new Date(sourceDateEpoch * 1000);
  }

  try {
    const gitTimestamp = parseEpochSeconds(
      (await runCapture("git", ["log", "-1", "--format=%ct"])).trim(),
    );
    if (gitTimestamp !== null) {
      return new Date(gitTimestamp * 1000);
    }
  } catch {
    // Fall back below when the package is built from a source archive.
  }

  return new Date(DEFAULT_PACKAGE_MTIME_EPOCH_SECONDS * 1000);
}

export async function normalizePackageTimestamps(root, mtime) {
  async function visit(entryPath) {
    const entryStat = await lstat(entryPath);
    if (entryStat.isDirectory()) {
      const entries = await readdir(entryPath);
      for (const entry of entries) {
        await visit(path.join(entryPath, entry));
      }
    }
    await utimes(entryPath, mtime, mtime);
  }

  await visit(root);
}

async function writePackageFiles(manifest) {
  await rm(packageRoot, { force: true, recursive: true });
  await mkdir(path.join(packageRoot, "server"), { recursive: true });

  await writeFile(
    path.join(packageRoot, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "tutti.cli.json"),
    `${JSON.stringify(createCliManifest(), null, 2)}\n`,
  );
  for (const { file, metadata } of Object.values(MANIFEST_LOCALIZATIONS)) {
    const localePath = path.join(packageRoot, file);
    await mkdir(path.dirname(localePath), { recursive: true });
    await writeFile(localePath, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  await writeFile(path.join(packageRoot, "COMMANDS.md"), renderCommandsGuide());
  await writeFile(path.join(packageRoot, "AGENTS.md"), renderAgentsGuide());
  await writeFile(
    path.join(packageRoot, "bootstrap.sh"),
    renderBootstrap({ version: manifest.version }),
  );
  await chmod(path.join(packageRoot, "bootstrap.sh"), 0o755);

  await cp(
    path.join(
      rootDir,
      "apps",
      "web",
      "public",
      "brand",
      "aimc-tutti-app-icon.png",
    ),
    path.join(packageRoot, "icon.png"),
  );
  await cp(
    path.join(rootDir, "apps", "web", "out"),
    path.join(packageRoot, "dist"),
    {
      recursive: true,
    },
  );
  await cp(path.join(rootDir, "skills"), path.join(packageRoot, "skills"), {
    recursive: true,
  });
}

async function cleanWebBuildOutputs() {
  const webRoot = path.join(rootDir, "apps", "web");
  await rm(path.join(webRoot, ".next"), { force: true, recursive: true });
  await rm(path.join(webRoot, "out"), { force: true, recursive: true });
}

async function bundleServer() {
  await run("pnpm", [
    "exec",
    "esbuild",
    "apps/server/src/server.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--outfile=build/tutti-app/package/server/server.js",
    "--banner:js=import { createRequire as __aimcCreateRequire } from 'node:module'; const require = __aimcCreateRequire(import.meta.url);",
  ]);
}

async function bundleWorker() {
  await run("pnpm", [
    "exec",
    "esbuild",
    "apps/server/src/worker.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--outfile=build/tutti-app/package/server/worker.js",
    "--banner:js=import { createRequire as __aimcCreateRequire } from 'node:module'; const require = __aimcCreateRequire(import.meta.url);",
  ]);
}

async function bundleToolsMcpServer() {
  await run("pnpm", [
    "exec",
    "esbuild",
    "apps/server/src/agent/local-agent-host/tools-mcp.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--outfile=build/tutti-app/package/server/tools-mcp.js",
  ]);
}

async function createZip(version) {
  const zipPath = path.join(buildRoot, `ai-media-canvas-${version}.zip`);
  await rm(zipPath, { force: true });
  await run("zip", ["-qry", zipPath, "."], { cwd: packageRoot });
  return zipPath;
}

export async function packageTuttiApp() {
  const sourceManifest = await readSourceManifest();
  const version = sourceManifest.version ?? "0.0.0";

  await run("pnpm", ["--filter", "@aimc/shared", "build"]);
  await cleanWebBuildOutputs();
  await run("pnpm", ["--filter", "@aimc/web", "build"], {
    env: createWebBuildEnv(),
  });

  await mkdir(buildRoot, { recursive: true });
  await writePackageFiles(sourceManifest);
  await bundleServer();
  await bundleWorker();
  await bundleToolsMcpServer();
  await validatePackageRoot(packageRoot);
  await normalizePackageTimestamps(packageRoot, await resolvePackageMtime());
  const zipPath = await createZip(version);
  console.log(`Created ${zipPath}`);
  return zipPath;
}

if (process.argv[1] === scriptPath) {
  packageTuttiApp().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
