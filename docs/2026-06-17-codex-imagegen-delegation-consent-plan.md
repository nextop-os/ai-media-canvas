# Codex Image Generation Delegation Consent

## Goal

When a non-Codex agent wants to use `codex-imagegen` / `codex/gpt-image-2`,
the app must obtain user consent first. Codex itself can use Codex image
generation directly. Direct user-initiated image generation is also allowed
without delegation consent.

The consent choices are:

- one-time approval: allow one Codex image generation call for the current task.
- durable approval: persistently allow the same delegation scenario.
- denial: do not call Codex for the current task.

## Final Architecture

Codex image generation is treated as a delegation boundary.

- Model lists express global capability only. They do not encode whether the
  current agent is authorized to use a model.
- `codex/gpt-image-2` stays visible in global image model lists when the
  Codex image provider is ready.
- Web manual generation and CLI calls marked as direct user actions can call
  Codex image generation directly.
- Non-Codex agents must pass the delegation guard before using Codex image
  generation.
- The backend is the security boundary. Tool descriptions only help the agent
  ask before calling.
- The visible confirmation question belongs to the agent/model response, not
  to a system-rendered fallback message.

## Provider Context

The caller provider is resolved per entry point.

| Entry point | Caller context | Consent required |
| --- | --- | --- |
| Global image model list | None | No |
| CLI image model list | None | No |
| Web manual image generation | Direct user | No |
| Web chat model preference | Preference only | No |
| Local-agent MCP manifest | Session `runtimeProvider` | Described to agent |
| Local-agent MCP tool call | Session `runtimeProvider` | Yes for non-Codex |
| Local-agent image job | Run runtime provider | Yes for non-Codex |
| CLI `/tutti/cli/generation/image` | `caller-provider`, or `external-cli` unless `direct-user: true` | Yes for non-Codex proxy calls |

## Workspace Setting

The setting lives under `settings.codexImagegenDelegation`.

Values:

- `ask`: default. A non-Codex agent must ask before delegating image generation
  to Codex.
- `always`: non-Codex agents may delegate Codex image generation without asking
  again.
- `never`: non-Codex agents cannot delegate Codex image generation.

The Web settings UI exposes this under Agent / Codex.

## Agent Interaction

The app does not inject a localized confirmation message into chat.

Instead:

1. The `generate_image` tool description tells non-Codex agents that Codex image
   delegation requires explicit user consent.
2. Agents can call `get_workspace_settings` before image generation to inspect
   `settings.codexImagegenDelegation`, the current one-time consent budget, and
   whether Codex image delegation currently requires confirmation.
3. If an agent still calls `codex/gpt-image-2` without consent, the tool gateway
   rejects the call with `codex_imagegen_confirmation_required`.
4. The local-agent event adapter preserves that error code in `tool.failed`.
5. The agent/model asks the user in natural language.
6. After the user responds, the agent converts the answer into a structured
   decision instead of relying on app-level text parsing.
7. In-app and local MCP agents call `update_workspace_settings` with a
   structured, allowlisted patch:
   - `patch.codexImagegenDelegation = "allow-once"` grants one Codex image
     generation call in the current tool session or run.
   - `patch.codexImagegenDelegation = "deny"` records that the current task
     should not call Codex.
   - `patch.codexImagegenDelegation = "always"` updates the durable workspace
     setting.
   - `patch.codexImagegenDelegation = "never"` records a durable opt-out.
8. External CLI/MCP callers use the equivalent structured CLI commands:
   `aimc agent consent`, `aimc settings update`, and
   `--codex-imagegen-consent allow-once`.

## Runtime Guard

The pure policy helper evaluates:

- image provider name,
- caller provider,
- workspace setting,
- one-time consent budget.

It returns:

- `allowed`,
- `blocked` with `needs_confirmation`,
- `blocked` with `disabled_by_user`.

The guard is used in:

- local-agent tool gateway,
- local-agent `submitImageJob`,
- HTTP job creation,
- worker-side image generation execution,
- CLI image generation.

The worker receives a precomputed `codex_imagegen_delegation_allowed` flag in
the job payload so background execution cannot bypass the creation-time policy.

## CLI Behavior

`/tutti/cli/agent/run` already carries runtime provider metadata.

`/tutti/cli/generation/image` now supports:

- `caller-provider`: identifies the agent delegating the image task.
- `codex-imagegen-consent`: currently supports `allow-once`.
- `direct-user`: marks the call as a direct user action.

When `direct-user` is not true and `caller-provider` is omitted, the server
treats the call as `external-cli` so proxy callers cannot omit provider metadata
to bypass the delegation guard.

The CLI settings route supports reading and updating
`codexImagegenDelegation`.

## Data Model

Shared contracts include:

- `workspaceSettings.codexImagegenDelegation`,
- `runCreateRequest.delegationConsent.codexImagegen`,
- image job payload fields:
  - `caller_provider`,
  - `codex_imagegen_consent`,
  - `codex_imagegen_delegation_allowed`.

The local settings store persists `codex_imagegen_delegation` with a default of
`ask` and normalizes invalid stored values back to `ask`.

## Verification

Covered scenarios:

- Codex agents can use `codex/gpt-image-2` directly.
- Non-Codex agents are blocked when the setting is `ask` and there is no
  one-time consent.
- One-time consent allows one Codex image generation call and is consumed after
  a successful guarded call.
- `always` allows future non-Codex delegation.
- `never` blocks non-Codex delegation.
- Direct user image generation stays allowed.
- CLI proxy image generation defaults to `external-cli` unless marked
  `direct-user`.
- Worker execution fails fast if a Codex image job was not authorized at
  creation time.
