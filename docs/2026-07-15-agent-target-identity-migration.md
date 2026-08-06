# Agent Target Identity Migration

AI Canvas uses Tutti Agent Target IDs as the durable identity for local Agent
runs. The provider ID is retained only as runtime metadata for adapter dispatch,
logging, and media delegation policy.

- `/api/models` returns `localAgentTargets` and `defaultAgentTargetId` from the
  live Tutti agent catalog.
- Run requests use `agentTargetId`; the packaged CLI exposes this as
  `aimc agent run --agent-id <id>`.
- The selected target is persisted on `agent_runs`, returned in run responses,
  and included in reconnect metadata.
- Native/provider-local resume is allowed only when runtime kind, target ID,
  and runtime provider all match. Switching runtime kinds or switching between
  two targets backed by the same provider uses conversation handoff.
- Deprecated `runtimeProvider` input remains accepted during the compatibility
  window only when exactly one target in the complete catalog uses that
  provider. Ambiguous or stale provider-only state fails closed.
- Exact target selection and availability failures surface as
  `agent_target_unavailable`. Catalog discovery or transport failures remain
  internal and return generic errors across the HTTP, CLI, and WebSocket
  boundaries.
- Composer options and Tutti skill context are loaded for the exact target.
  Local-agent mention handling loads the skill context for the exact selected
  target and has no provider fallback.
- The settings action opens Tutti's generic Agent manager without a provider
  filter, so an unavailable target backed by a new runtime is still manageable.
- CLI model help points callers to the models advertised for the selected exact
  target instead of publishing provider-specific examples.

Image and video generation providers are a separate business concept. Names
such as `codex-imagegen` continue to identify media generation backends and are
not Agent Target IDs.
