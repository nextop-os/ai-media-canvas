<p align="center">
  <img src="./apps/web/public/brand/aimc-logo-cloud-spark.png" alt="AI Canvas logo" width="88" />
</p>

<h1 align="center">AI Canvas</h1>

<p align="center">
  <strong>Local-first AI canvas for image and video creation.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="./README.zh-CN.md">简体中文</a>
  ·
  <a href="./CONTRIBUTING.md">Contributing</a>
  ·
  <a href="./CODE_OF_CONDUCT.md">Code of Conduct</a>
  ·
  <a href="./SECURITY.md">Security</a>
  ·
  <a href="./LICENSE">License</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" /></a>
  <img alt="Local-first SQLite" src="https://img.shields.io/badge/local--first-SQLite-111827" />
  <img alt="Local agent routes" src="https://img.shields.io/badge/local--agent-Tutti%20Agent%20Targets-7c3aed" />
  <img alt="BYOK providers" src="https://img.shields.io/badge/BYOK-OpenAI--compatible%20%7C%20Anthropic-0f766e" />
  <img alt="i18n zh-CN and en" src="https://img.shields.io/badge/i18n-zh--CN%20%7C%20en-16a34a" />
  <img alt="Next.js" src="https://img.shields.io/badge/web-Next.js-000000" />
</p>

![AI Canvas home screen](./docs/assets/readme-home.jpg)

AI Canvas is a local-first AI workspace for creating, organizing, and iterating on image and video ideas with a visual canvas.

It combines an Excalidraw-powered canvas, an AI design assistant, local project storage, a skills workspace, and provider-backed media generation in one single-user web app. Project data is stored in SQLite, and generated assets live on disk.

## Features

- Visual canvas workflow: compose, inspect, and refine creative work on an Excalidraw-based canvas.
- AI design assistant: chat inside a project and let the assistant inspect or update canvas content.
- Flexible agent routes: select any Agent Target exposed by the connected Tutti workspace, or bring your own API keys.
- Image and video generation: connect providers such as OpenAI, Google, Replicate, Volces, and Agnes.
- Local-first storage: persist projects, chats, settings, skills, and generated assets locally with SQLite and disk files.
- Skills workspace: import, create, enable, and reuse local AI skills for more specialized creative workflows.
- Bilingual UI: built with `i18next` and currently supports `zh-CN` and `en`.

## Quick Start

Requirements:

- Node.js 22 or newer
- pnpm 10.26.2, preferably through Corepack

```bash
corepack enable
pnpm install
cp .env.example .env.local
./scripts/start-aimc-dev.sh
```

Then open the web URL printed by the script. By default:

- web: `http://localhost:3000`
- server: `http://localhost:3001`

The helper script starts both the Next.js web app and the local Fastify server. If a port is busy, it automatically selects the next available port.

## Single-Service Mode

For a production-like local run, build the static web app and let the server host it:

```bash
pnpm --filter @aimc/web build
AIMC_WEB_DIST=apps/web/out pnpm --filter @aimc/server dev:server
```

Open `http://127.0.0.1:3001/`.

The server serves `apps/web/out`, `/api/*`, and `/local-assets/*` from one process.

## Configure AI Providers

You can configure providers from the in-app Settings page, or through `.env.local`. Stored local settings take priority over environment fallback values at runtime.

AI Canvas supports two agent execution paths:

- Local Agent routes: AI Canvas discovers the current Tutti Agent Target catalog, so multiple agents backed by the same runtime provider remain separate selectable identities.
- BYOK API routes: bring your own API key and base URL for OpenAI-compatible gateways, Anthropic-compatible Claude routes, Google Gemini, Vertex AI, Agnes, and other configured providers.

Common variables:

```env
AIMC_AGENT_MODEL=openai:gpt-5-mini
AIMC_OPENAI_API_KEY=
AIMC_OPENAI_API_BASE=
AIMC_ANTHROPIC_API_KEY=
AIMC_ANTHROPIC_BASE_URL=
AIMC_AGNES_API_KEY=
AIMC_AGNES_BASE_URL=
AIMC_AGNES_MODEL=
AIMC_GOOGLE_API_KEY=
AIMC_GOOGLE_APPLICATION_CREDENTIALS=
AIMC_GOOGLE_VERTEX_PROJECT=
AIMC_GOOGLE_VERTEX_LOCATION=
AIMC_GOOGLE_VERTEX_VIDEO_LOCATION=
AIMC_REPLICATE_API_TOKEN=
AIMC_VOLCES_API_KEY=
AIMC_VOLCES_BASE_URL=
```

Server and storage variables:

```env
AIMC_SERVER_PORT=3001
AIMC_WEB_ORIGIN=http://localhost:3000
AIMC_SERVER_BASE_URL=http://localhost:3001
AIMC_WEB_DIST=
AIMC_DATA_ROOT=
AIMC_DATABASE_ROOT=
AIMC_AGENT_BACKEND_MODE=state
AIMC_AGENT_FILES_ROOT=
AIMC_SKILLS_ROOT=
```

## Local Data

By default, local runtime data is written under `local-data/`:

- SQLite database: `local-data/ai-media-canvas.db`
- generated and uploaded assets: `local-data/assets/`

Set `AIMC_DATA_ROOT` to move app-owned assets elsewhere. Set
`AIMC_DATABASE_ROOT` when SQLite files must use a separate database directory.

## Workspace Layout

```text
apps/
  web/       Next.js static-export frontend
  server/    Fastify API, local store, generation providers, agent runtime
packages/
  shared/    Shared contracts and schemas
  config/    Shared TypeScript configuration
scripts/     Development, i18n, and packaging helpers
docs/        Design notes, plans, and project documentation
```

## Acknowledgements

AI Canvas is inspired in part by [Loomic](https://github.com/fancyboi999/Loomic), an open-source AI canvas creative workspace. Loomic helped validate the canvas-first, chat-driven media creation direction; AI Canvas keeps its own local-first architecture and implementation.

## Development

Useful commands:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm check:i18n
pnpm --filter @aimc/web test
pnpm --filter @aimc/server test
```

When changing user-visible web copy, update both supported locales in `apps/web/src/i18n/locales` and run:

```bash
pnpm check:i18n
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

For security issues, please follow [SECURITY.md](./SECURITY.md).

## License

AI Canvas is licensed under the [Apache License 2.0](./LICENSE).
