# 移除 server-deepagent 链路

Date: 2026-08-06
Project: `ai-media-canvas`
Status: Implemented

## 结论

`ai-media-canvas` 的 Agent runtime 现在只支持 `local-agent`。`server-deepagent`
不再是可选 runtime、默认 fallback 或 HTTP/WebSocket/CLI 请求协议的一部分。

保留的是本地 Agent 的业务能力：canvas、workspace skills、工具网关、图片/视频
任务、run event 持久化和恢复语义仍由 server 负责；Agent loop 通过本地 Agent
provider 执行。

## 已移除的边界

- 删除 server deepagent factory、事件适配器和 server runtime adapter
- 删除 server runtime 的 LangGraph/deepagent provider 注册与远端模型解析
- `/api/models` 只返回本地 Agent provider、target 和 model
- run request 的 `runtimeKind`、`modelSource` 和 workspace default source 只接受
  `local-agent`
- HTTP、WebSocket、CLI 都固定走 local-agent target
- 删除 Tutti Managed 模型连接/授权 API、CLI bridge 和 Web UI 入口
- 删除对应的 LangChain provider 依赖；`deepagents` 仍保留，因为本地 Agent 的
  sandbox backend 和内置 filesystem 工具仍使用它

## 兼容策略

`agent_runs` 中已有的 `runtime_kind`、`runtime_provider` 数据列暂不迁移删除，
用于读取历史记录和避免破坏本地数据库；新写入的 run 一律使用
`runtime_kind=local-agent`。旧的 `server-deepagent` 请求会在 shared contract
校验阶段被拒绝。Tutti Managed 模型连接的 HTTP、CLI、runtime、shared contract
和本地 store 代码均已删除；历史数据库表不做迁移处理。

`managed-file` 上传仍保留，它表示文件资产存储，不代表 Tutti Managed Agent
或云端模型 runtime。

## 验证

- server runtime/orchestrator/app/store 定向测试通过
- local model catalog 和 Tutti skill context 定向测试通过
- shared/web typecheck 通过

此前的双 runtime 设计文档和 bugfix 记录保留为历史上下文；实现和后续开发以本
文档及当前代码为准。
