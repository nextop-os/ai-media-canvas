# Local Agent Runtime 执行计划

Date: 2026-06-04
Project: `ai-media-canvas`
Status: Draft

> 历史文档：2026-08-06 已移除 `server-deepagent`。本文中的双 runtime
> rollout 计划已失效；当前实现和验证边界见
> [server-deepagent 移除记录](./2026-08-06-server-deepagent-removal.zh-CN.md)。

> 本文是执行计划文档，负责回答“先做什么、按什么顺序做、每阶段交付什么、怎么验收”。
> 架构背景、方案权衡、长期设计与风险分析见：
> [2026-06-03-agent-runtime-local-agent-design.zh-CN.md](/Users/wwcome/work/demo/ai-media-canvas/docs/2026-06-03-agent-runtime-local-agent-design.zh-CN.md)

## 1. 文档目的

这次实施不是直接在 AIMC server 里补一条 local-agent 分支，而是按固定顺序落地完整推荐架构：

1. 先理解 `open-design` 与 `multica` 的现成实现。
2. 先完成 `@tutti-os/agent-acp-kit`。
3. 再完成 AIMC host integration。
4. host integration 的核心 owner 是 `Agent Run Orchestrator`。

因此，这份文档不是 package-only 计划，而是一个 package-first、orchestrator-led 的 rollout 文档。

## 2. 执行原则

### 2.1 先参考实现，再新写

local-agent 执行层不从零设计。CLI detection、adapter、ACP、parser、skill injection、MCP bridge 优先参考成熟实现，避免重复踩坑。

### 2.2 复制后修改优先于重写

对 `Claude` / `Codex` / `Hermes` / `Kimi` / `Kiro` 的 detect、buildArgs、stdio 协议、ACP session lifecycle、cancel、stderr 处理，优先走 copy-modify 路线，不优先 greenfield rewrite。

### 2.3 先 package，后接入

`@tutti-os/agent-acp-kit` 是外部 npm package 第一交付物。AIMC server、message/run persistence、Tool Gateway、UI compatibility 都在 package contract 稳定后再接入。

### 2.4 package 不拥有产品状态

package 只负责本地 agent 执行能力，不负责 AIMC 的 run/message/product semantics。产品状态由 `Agent Run Orchestrator` 负责。

### 2.5 P0 覆盖完整双 runtime 主链

P0 不只是让 local-agent 跑起来，还要覆盖原推荐架构的完整主链：

- `server-deepagent` 仍是默认 runtime。
- trusted `local-agent` 是新增 runtime。
- 两者由同一个 orchestrator 统一管理。

## 3. 参考实现与复用边界

### 3.1 `open-design` 负责参考的部分

优先参考：

- [open-design/docs/agent-adapters.md](/Users/wwcome/work/demo/open-design/docs/agent-adapters.md)
- [open-design/apps/daemon/src/agents.ts](/Users/wwcome/work/demo/open-design/apps/daemon/src/agents.ts)
- [open-design/apps/daemon/src/acp.ts](/Users/wwcome/work/demo/open-design/apps/daemon/src/acp.ts)

重点复用思路：

- adapter catalog 与 capability flags
- CLI detection 与 version/model probing
- `buildArgs` 与 stdin prompt delivery
- JSONL / plain / ACP stream parsing
- MCP server config passthrough
- tool token / MCP bridge / skill injection
- normalized event 流

### 3.2 `multica` 负责参考的部分

优先参考：

- [multica/server/pkg/agent/agent.go](/Users/wwcome/work/demo/multica/server/pkg/agent/agent.go)
- [multica/server/internal/daemon/daemon.go](/Users/wwcome/work/demo/multica/server/internal/daemon/daemon.go)
- [multica/server/internal/daemon/execenv/execenv.go](/Users/wwcome/work/demo/multica/server/internal/daemon/execenv/execenv.go)

重点复用思路：

- provider backend interface
- runtime health / recovery / concurrency shape
- isolated execenv / per-run sandbox
- per-provider execution contract
- stderr tail / cancel / session packaging

### 3.3 AIMC 只新写 host-specific binding

以下能力不进入 package，而是在 AIMC host 层实现：

- `Agent Run Orchestrator`
- `Message + Run Store`
- `Skill Resolver`
- `Tool Gateway`
- `Runtime Control Plane`
- `AgentEvent -> StreamEvent` 映射
- canvas / media / brand kit / project search 业务权限

## 4. 架构覆盖范围

新执行计划覆盖原推荐架构的全部主组件，但按阶段拆解：

| 原推荐架构组件 | 执行阶段 | 说明 |
|---|---|---|
| `Web UI / WS` | 阶段 3 | 只做最小兼容改造，不先行驱动 runtime 设计 |
| `Agent Run Orchestrator` | 阶段 3 | run/message/event/product semantics 的总 owner |
| `Message + Run Store` | 阶段 3 | assistant anchor、`agent_run_events`、snapshot/replay |
| `Skill Resolver` | 阶段 3 | 从 AIMC workspace skill DB 解析并准备 skill inputs |
| `Tool Gateway` | 阶段 3 | canonical tool manifest、tool token、MCP bridge、auth/recheck |
| `Runtime Control Plane` | 阶段 3 | runtime selection、health、concurrency、cancel dispatch、recovery |
| `server-deepagent runtime` | 阶段 3 | 把现有 deepagent 路径包装为 first-party runtime adapter |
| `local-agent runtime` | 阶段 1-2 | 由 `@tutti-os/agent-acp-kit` 提供执行能力 |
| `@tutti-os/agent-acp-kit package` | 阶段 1-2 | provider、transport、parser、ACP、skill helpers |
| `ACP / CLI transports` | 阶段 1-2 | `Claude`、`Codex`、`Hermes`、`Kimi`、`Kiro` |
| `Canvas / Media / Brand Kit / Search` | 阶段 3 | 通过 Tool Gateway 暴露，不进入 package |

## 5. P0 范围

### 5.1 P0 必须交付的能力

- `@tutti-os/agent-acp-kit`
- trusted `local-agent` mode
- `Claude`、`Codex`、`Hermes`、`Kimi`、`Kiro` 全部最小可运行
- unified `AgentEvent`
- AIMC assistant message anchor
- durable `agent_run_events`
- Tool Gateway + MCP binding
- `server-deepagent` 与 `local-agent` 双 runtime 统一接入
- cross-provider `handoff` resume

### 5.2 P0 明确不做的内容

- cross-provider native resume
- `detach` / `fork`
- 多包物理拆分
- 对外稳定 npm package
- 更多 provider 的扩展支持
- 完整 runtime dashboard 产品化

### 5.3 P0 写死的默认决策

- 默认 runtime 仍是 `server-deepagent`
- `local-agent` 只在 trusted local mode 可选
- package 优先参考 `open-design`
- runtime/execenv/recovery 形状优先参考 `multica`
- `agent_run_events` 是 P0 前置条件
- assistant message 在 `accepted` 时创建 anchor
- tool 最小集：
  - `inspect_canvas`
  - `manipulate_canvas`
  - `generate_image`
  - `generate_video`
  - `project_search`
- cross-provider 只支持 `handoff`
- package 只暴露 native/provider-local resume 能力，不决定 product-level resume mode

## 6. 阶段 0：参考实现拆解

### 6.1 目标

把 `open-design` 与 `multica` 中必须复用的 runtime 相关实现拆解清楚，避免 AIMC 在实现时一边写一边重新设计 contract。

### 6.2 交付物

- `open-design` 参考清单
- `multica` 参考清单
- `@tutti-os/agent-acp-kit` 最小公共 contract 草案
- provider / transport / ACP / execenv 的 copy-modify 边界

### 6.3 必须锁定的 contract

- `AgentRunInput`
- `AgentEvent`
- `ProviderAdapter`
- `Transport`
- `ProcessSupervisor`
- `SkillDelivery`
- ACP shared transport contract

### 6.4 阶段验收

- 实现者可以明确区分哪些逻辑应复制、哪些逻辑只参考形状、哪些逻辑属于 AIMC host binding。
- 不再需要在 `apps/server` 中临时发明一版 runtime contract。

## 7. 阶段 1：`@tutti-os/agent-acp-kit`

### 7.1 目标

先把本地 agent 执行层做成一个独立可验证的 package，不依赖 AIMC product semantics。

### 7.2 package 内必须包含

- provider registry
- detection layer
- process supervisor
- cancel / timeout / stderr buffer
- `jsonl` transport
- `acp-json-rpc` transport
- `fake` provider
- `Claude` provider
- `Codex` provider
- `Hermes` / `Kimi` / `Kiro` provider skeleton
- skill materialization / prompt injection helpers
- MCP server config passthrough
- normalized `AgentEvent`

### 7.2.1 P0 目录结构

P0 先做一个独立 npm package，不做物理多包拆分。目录必须先按可拆边界组织，避免把 provider、transport、process、AIMC host binding 混到一起。

```text
@tutti-os/agent-acp-kit/
  package.json
  tsconfig.json
  src/
    index.ts

    core/
      events.ts
      run-input.ts
      capabilities.ts
      errors.ts
      mcp.ts
      provider-plugin.ts
      transport.ts
      launch-plan.ts
      detection.ts
      redaction.ts
      skills.ts

    runtime/
      create-runtime.ts
      provider-registry.ts
      detection-cache.ts

    process/
      supervisor.ts
      command-resolver.ts
      env.ts
      cancellation.ts
      stderr-buffer.ts

    transports/
      jsonl/
        jsonl-transport.ts
        jsonl-parser.ts
      plain/
        plain-transport.ts
      acp/
        acp-client.ts
        acp-jsonrpc.ts
        acp-session.ts
        acp-models.ts
        acp-permissions.ts
        acp-types.ts

    providers/
      claude/
        index.ts
        detect.ts
        launch-plan.ts
        parser.ts
        models.ts
      codex/
        index.ts
        detect.ts
        launch-plan.ts
        parser.ts
        models.ts
      hermes/
        index.ts
        provider.ts
      kimi/
        index.ts
        provider.ts
      kiro/
        index.ts
        provider.ts
      fake/
        index.ts
        provider.ts

    skills/
      materialize.ts
      prompt-injection.ts
      cleanup.ts

    testing/
      fake-acp-peer.ts
      fixtures.ts
      conformance.ts

  tests/
    core/
    process/
    transports/
    providers/
    integration/
```

依赖方向必须固定：

- `core/*` 不能依赖 `runtime/*`、`process/*`、`transports/*`、`providers/*`。
- `process/*` 只负责 spawn/cancel/stdout/stderr/exit，不解析 provider 语义。
- `transports/*` 只处理 wire protocol，不做 AIMC 业务映射。
- `providers/*` 负责 command、args、model/capability mapping、provider-specific event normalization。
- `runtime/*` 负责把 providers 和 transports 组装成 facade。
- `skills/*` 只处理文件 materialize / prompt injection / cleanup，不查 AIMC DB。
- package 内任何模块都不能 import `apps/server`、canvas、media、Supabase、workspace DB。

### 7.3 package 内明确不包含

- AIMC `StreamEvent`
- AIMC Tool Gateway
- AIMC DB 持久化
- AIMC workspace skill 查询
- AIMC canvas/media/business permission

### 7.4 阶段验收

- package 可以单独定义 provider/transport/event contracts。
- `Claude`、`Codex` 与 `fake` provider 能脱离 AIMC server 独立运行。
- `Hermes`、`Kimi`、`Kiro` provider 目录与 plugin skeleton 已落位，阶段 2 填实。
- ACP shared transport contract 已落位，可供后续 ACP providers 共用。

### 7.5 public exports

P0 的默认入口只从 `src/index.ts` 导出 facade、官方 providers 和核心类型。不要让 AIMC server 直接依赖 process supervisor 或 ACP JSON-RPC 内部实现。

```ts
export { createLocalAgentRuntime } from "./runtime/create-runtime";

export { claudeProvider } from "./providers/claude";
export { codexProvider } from "./providers/codex";
export { hermesProvider } from "./providers/hermes";
export { kimiProvider } from "./providers/kimi";
export { kiroProvider } from "./providers/kiro";
export { fakeProvider } from "./providers/fake";

export type {
  AgentEvent,
  AgentRunInput,
  AgentRuntimeCapabilities,
  DetectionResult,
  LaunchPlan,
  LocalAgentProviderPlugin,
  McpServerConfig,
  ProviderAdapter,
  Transport,
  TransportKind,
} from "./core";
```

允许给测试暴露 subpath：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./testing": "./dist/testing/index.js"
  }
}
```

### 7.6 core contracts

P0 contract 要同时覆盖 CLI provider 和 ACP provider。如果这组 contract 不能自然支持 `Claude` / `Codex` / `Hermes` / `Kimi` / `Kiro`，先改 package contract，不要在 AIMC host 层补分支。

```ts
export type AgentRunInput = {
  runId: string;
  provider: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  mcpServers?: McpServerConfig[];
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  resume?: {
    mode: "native" | "provider" | "fresh";
    providerSessionId?: string;
    resumeToken?: string;
  };
};

export type AgentEvent =
  | { type: "status"; status: "initializing" | "detecting" | "spawning" | "running" | "warning"; message?: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; id: string; name?: string; status: "completed" | "failed"; output?: unknown; error?: string }
  | { type: "usage"; usage: unknown }
  | { type: "error"; code?: string; message: string }
  | { type: "done"; status: "completed" | "failed" | "canceled"; sessionId?: string; resumeToken?: string };

export type LocalAgentProviderPlugin = {
  id: string;
  displayName: string;
  supportedTransports: TransportKind[];
  detect(ctx: DetectContext): Promise<DetectionResult>;
  createAdapter(ctx: ProviderInitContext): ProviderAdapter;
};

export type ProviderAdapter = {
  buildLaunchPlan(input: AgentRunInput): Promise<LaunchPlan>;
  parseEvents(stream: RawAgentStream): AsyncIterable<AgentEvent>;
  capabilities(): AgentRuntimeCapabilities;
};

export type Transport = {
  kind: TransportKind;
  run(plan: LaunchPlan, signal?: AbortSignal): AsyncIterable<RawAgentEvent>;
};
```

注意：`AgentRunInput.resume.mode` 不包含 `handoff`。handoff 是 AIMC orchestrator 的产品语义，package 只知道 provider 自己能不能 native/provider-local resume。

### 7.7 `createLocalAgentRuntime` 怎么写

runtime facade 是 package 的唯一默认入口。它只做 provider 选择、检测缓存、执行调度和 cancel 转发。

执行流必须是：

1. `detect()` 并行调用所有 provider 的 `detect(ctx)`，缓存 detection result。
2. `run(input)` 根据 `input.provider` 找 provider plugin。
3. provider adapter 通过 `buildLaunchPlan(input)` 生成 `LaunchPlan`。
4. transport 根据 `LaunchPlan.transport` 启动进程或协议会话。
5. provider adapter 通过 `parseEvents(rawStream)` 归一化为 `AgentEvent`。
6. runtime facade 只透传 `AgentEvent`，不映射成 AIMC `StreamEvent`。
7. `cancel(runId)` 找到 active run 的 process/session controller 并取消。

伪代码形态：

```ts
export function createLocalAgentRuntime(options: {
  providers: LocalAgentProviderPlugin[];
  transports?: Transport[];
  redactor?: Redactor;
}): LocalAgentRuntime {
  const registry = createProviderRegistry(options.providers);
  const activeRuns = new Map<string, RuntimeRunHandle>();

  return {
    async detect() {
      return registry.detectAll();
    },

    async *run(input) {
      const provider = registry.require(input.provider);
      const adapter = provider.createAdapter({ redactor: options.redactor });
      const plan = await adapter.buildLaunchPlan(input);
      const transport = resolveTransport(plan.transport);
      const rawStream = transport.run(plan, input.signal);
      activeRuns.set(input.runId, rawStream.handle);

      try {
        yield* adapter.parseEvents(rawStream);
      } finally {
        activeRuns.delete(input.runId);
      }
    },

    async cancel(runId) {
      await activeRuns.get(runId)?.cancel();
    },
  };
}
```

### 7.8 process supervisor 怎么写

`process/supervisor.ts` 是所有 CLI/ACP 子进程的统一入口。它不理解 provider 语义，只返回 raw stdout/stderr/exit events。

必须支持：

- command resolution
- env merge + redaction
- cwd
- stdin prompt delivery
- stdout line/chunk stream
- stderr tail buffer
- timeout
- abort signal
- graceful cancel then kill fallback
- exit code / signal reporting

必须从 `open-design` 复制并适配的坑：

- 大 prompt 优先 stdin，避免 Windows `ENAMETOOLONG` / Linux `E2BIG`。
- `.cmd` / `.bat` shim 与 direct exe 的 argv 规则要通过测试覆盖。
- stderr 只保留 tail，并在输出前做 redaction。

### 7.9 provider 怎么写

每个 provider 文件夹都实现同一套最小形状：

- `detect.ts`：找 binary、读 version、探测 capability/model list。
- `launch-plan.ts`：把 `AgentRunInput` 转成 command/args/env/stdin/transport。
- `parser.ts` 或 `provider.ts`：把 raw transport events 转成 `AgentEvent`。
- `models.ts`：fallback models 和 model normalization。
- `index.ts`：导出 provider plugin。

`Claude` / `Codex` 是 CLI provider：

- 参考 `open-design/apps/daemon/src/agents.ts` 的 buildArgs。
- prompt 优先 stdin。
- stdout 走 JSONL 或 line parser。
- tool events 必须归一化成 `tool_call` / `tool_result`。

`Hermes` / `Kimi` / `Kiro` 是 ACP provider：

- 共享 `transports/acp`。
- provider 只定义 command、args、model/capability mapping。
- ACP transport 统一处理 initialize、session/new、session/prompt、session/update、permission request、abort。

### 7.10 ACP transport 怎么写

ACP transport 属于 package，不属于 AIMC server。

必须实现：

- 启动 provider ACP process。
- 发送 `initialize`。
- 发送 `session/new`，并传入 `cwd` 与 `mcpServers`。
- 可选发送 `session/set_model`。
- 发送 `session/prompt`。
- 解析 `session/update`。
- 处理 `session/request_permission`，headless P0 默认按 provider policy approve/deny。
- 输出 raw ACP events 给 provider adapter normalize。
- fatal JSON-RPC error、stage timeout、child exit 都要变成可归一化 error。

ACP 到 `AgentEvent` 至少覆盖：

| ACP state | `AgentEvent` |
|---|---|
| text delta | `text_delta` |
| reasoning delta | `thinking_delta` |
| tool call start | `tool_call` |
| tool result success | `tool_result completed` |
| tool result failure | `tool_result failed` |
| permission pending/denied | `status` 或 `tool_result failed` |
| model/session metadata | `status` |
| usage | `usage` |
| terminal | `done` |

### 7.11 skill 与 MCP helpers 怎么写

package 内的 skill helper 只做文件层工作：

- sanitize slug/path
- materialize `SKILL.md` 和 files
- prompt injection summary
- cleanup

它不查 AIMC DB。AIMC `Skill Resolver` 把 workspace DB 中的 skills 转成 package input。

MCP helper 只做 config passthrough / provider config conversion：

- 对 ACP provider，转换成 ACP `mcpServers` shape。
- 对 CLI provider，转换成该 CLI 支持的 MCP config 或 argv/env。
- 不解析 AIMC tool schema。
- 不 mint / validate `AIMC_TOOL_TOKEN`。

## 8. 阶段 2：5 provider package 验证

### 8.1 目标

让 `Claude`、`Codex`、`Hermes`、`Kimi`、`Kiro` 五个 provider 在 package 层都达到最小可运行基线。

### 8.2 provider 覆盖要求

每个 provider 都必须支持：

- detect
- launch
- stream output
- cancel
- stderr / fatal error 透传
- 最小 MCP/tool path

### 8.3 ACP provider 要求

`Hermes`、`Kimi`、`Kiro` 共享 ACP transport，但各自需要完成：

- command mapping
- model / capability mapping
- provider-specific launch config
- session lifecycle smoke

### 8.4 阶段验收

- 五个 provider 都能通过 package 级 smoke 测试。
- fake ACP peer 能覆盖 ACP lifecycle 与 failure path。
- package contract 能自然容纳 CLI 与 ACP 两类 provider，不需要靠 AIMC host 层打补丁。

## 9. 阶段 3：AIMC host integration

### 9.1 `Agent Run Orchestrator`

这是阶段 3 的核心 owner，负责：

- 创建 run record
- 在 `accepted` 时创建 assistant message anchor
- 选择 runtime：`server-deepagent` 或 `local-agent`
- 调用 `Skill Resolver` / skill delivery
- 创建 tool grant
- 调用 `Runtime Control Plane`
- 消费 `AgentEvent`
- 落 durable `agent_run_events`
- 更新 message snapshot、`runStatus`、`lastRunEventId`
- 执行 cancel / replay / handoff resume
- 把统一事件映射成 AIMC `StreamEvent`

`Agent Run Orchestrator` 不拥有 provider/transport 实现；它只拥有产品状态与集成层语义。

### 9.2 `Message + Run Store`

需要落地：

- assistant message anchor
- `chat_messages.run_id`
- `chat_messages.run_status`
- `chat_messages.last_run_event_id`
- durable `agent_run_events`
- snapshot / replay 恢复路径

### 9.3 `Skill Resolver`

负责：

- 从 AIMC workspace skill DB 读取 skills
- 生成 run-scoped skill inputs
- 决定传给 package 的 materialized skill / prompt summary

skill source 仍然是 AIMC workspace DB，而不是 provider 自己的本地技能目录。

### 9.4 `Tool Gateway`

负责：

- canonical tool manifest
- tool token mint / revoke
- MCP bridge
- server-side schema / auth / permission recheck
- business tool execution

工具最小集为：

- `inspect_canvas`
- `manipulate_canvas`
- `generate_image`
- `generate_video`
- `project_search`

### 9.5 `Runtime Control Plane`

负责：

- runtime selection
- runtime health
- concurrency
- cancel dispatch
- recovery

它不写 message/run/event DB；产品状态仍归 orchestrator。

### 9.6 `server-deepagent / local-agent runtime binding`

这一层需要：

- 把现有 deepagent 路径包装成 `server-deepagent runtime adapter`
- 把 `@tutti-os/agent-acp-kit` 暴露为 `local-agent runtime adapter`
- 让 orchestrator 能统一消费两者输出

runtime binding 的目标接口应保持很薄：

```ts
type AgentRuntimeAdapter = {
  runtime: AgentRuntimeRecord;
  capabilities(): AgentRuntimeCapabilities;
  prepare?(context: AgentRunContext): Promise<PreparedAgentRun>;
  run(context: AgentRunContext): AsyncIterable<StreamEvent>;
  cancel(runId: string): Promise<void>;
};
```

`server-deepagent runtime adapter` 的写法：

- 复用现有 `apps/server/src/agent/runtime.ts` / `deep-agent.ts` / `stream-adapter.ts` 的核心逻辑。
- adapter 外层只负责把 orchestrator context 转成现有 deepagent input。
- deepagent 输出仍统一成 AIMC `StreamEvent`。
- 不把 local-agent package 引入 deepagent adapter。

`local-agent runtime adapter` 的写法：

- 从 orchestrator 接收 prepared prompt、cwd、model、provider、skills、mcpServers。
- 调用 `createLocalAgentRuntime().run(AgentRunInput)`。
- 把 package `AgentEvent` 映射成 AIMC `StreamEvent`。
- fatal provider/process error 映射为 `run.failed`。
- tool failure 映射为 `tool.failed`，不是 `run.failed`。
- terminal `done` 映射为 `run.completed` / `run.failed` / `run.canceled`。

### 9.6.1 `AgentEvent -> StreamEvent` 映射

映射必须集中在 AIMC host 层，不进入 package：

| `AgentEvent` | AIMC `StreamEvent` |
|---|---|
| `status` | `run.adapter.status` |
| `text_delta` | `message.delta` |
| `thinking_delta` | `thinking.delta` |
| `tool_call` | `tool.started` |
| `tool_result completed` | `tool.completed` |
| `tool_result failed` | `tool.failed` |
| `usage` | run metadata / observability event |
| `error` | `run.adapter.status` 或 `run.failed`，按 fatality 判断 |
| `done completed` | `run.completed` |
| `done failed` | `run.failed` |
| `done canceled` | `run.canceled` |

所有 `StreamEvent` 由 orchestrator 分配 durable `eventId` / `seq` 后再推给 UI。

### 9.6.2 AIMC host 目录建议

阶段 3 的 AIMC server 侧目录建议：

```text
apps/server/src/agent/runtime-orchestrator/
  orchestrator.ts
  runtime-control-plane.ts
  runtime-selection.ts
  run-event-store.ts
  run-event-projector.ts
  resume-context.ts

apps/server/src/agent/runtimes/
  server-deepagent-adapter.ts
  local-agent-adapter.ts
  event-mapper.ts

apps/server/src/agent/local-runtime/
  aimc-skill-resolver.ts
  aimc-skill-delivery.ts
  aimc-tool-definitions.ts
  aimc-tool-gateway.ts
  aimc-tools-mcp.ts
```

这些文件属于 AIMC host binding，可以 import `@tutti-os/agent-acp-kit`，但 package 不能反向 import 它们。

### 9.7 Resume 策略

resume 决策属于 orchestrator：

- `native`
- `provider-local`
- `handoff`
- `fresh`

P0 写死：

- 支持 cross-provider `handoff` resume
- 不支持 cross-provider native resume

package 只暴露 provider session id / resume token / native resume 能力，不决定跨 provider 语义。

## 10. 测试与验收

### 10.1 package 级验证

- `Claude` / `Codex` / `Hermes` / `Kimi` / `Kiro` detect tests
- `fake` provider tests
- fake ACP peer tests
- cancel / timeout / malformed output / stderr tests
- skill materialization tests
- MCP config passthrough tests

### 10.2 AIMC integration 验收

- `Agent Run Orchestrator` 章节中的职责都有落点
- assistant message anchor 在 `accepted` 时创建
- `agent_run_events` 支持 replay
- `server-deepagent` 与 `local-agent` 都能产出统一 `StreamEvent`
- `tool.failed`
- tool result upsert
- replay event 去重
- trusted local mode 开关不影响默认 deepagent 链路

### 10.3 覆盖判断

执行文档完成后，应满足：

- 读者能找到 `Agent Run Orchestrator` 的独立实现章节
- 读者能看到原推荐架构每个主组件在执行阶段中的落点
- 读者不会误以为只做 package 就算完成
- 读者不会误以为要先把整个 AIMC 上层一次性做完
- package 与 orchestrator 的职责边界明确：
  package 管执行层，orchestrator 管产品状态与集成层

## 11. 一句话执行策略

先按 `open-design` 与 `multica` 的成熟链路做出 `@tutti-os/agent-acp-kit`，让 `Claude`、`Codex`、`Hermes`、`Kimi`、`Kiro` 在 package 层先跑通，再由 `Agent Run Orchestrator` 统一接入 AIMC 的 run/message/tool/skill/product semantics。
