# 小灵共享运行时：M0-05

保留 video-canvas 的 Pi Durable engine/store，以本地 Gateway 替代平台工具 HTTP。设置与项目会话共享同一个 Worker/SQLite，引擎不运行在 Renderer 或 Electron Main 的事件循环中。

- `src/client.ts`：受信宿主使用的 Worker client；不是 Renderer IPC API。
- `src/runtime.ts`：Pi engine、AgentStore 和 Pi SQLite storage 的生命周期。
- `src/gateway.ts`：scope 工具集、执行端校验、审批与目标回执适配。
- `src/targets.ts`：独立 SQLite 合成目标，事务内写入效果及回执，验证跨存储恢复边界。
- `src/worker.ts`：命令调度、事件传递、QuickJS 验证入口和故障注入。
- `upstream/`：固定原引擎及回归测试。`provenance.json` 记录原始 hash 与本地适配，构建时验证指纹。

`pnpm test:agent` 构建后运行本地 9 项与上游 144 项测试；模型端点由测试启动的 loopback SSE 服务提供。`pnpm agent:build` 输出独立 Worker、CommonJS client、Pi code-mode Worker 与 QuickJS WASM，以及依赖/许可清单；目录包从 `Resources/agent-runtime` 加载。

| 上游原测试                | 迁入位置                                | 证明范围                                  |
| ------------------------- | --------------------------------------- | ----------------------------------------- |
| engine.test.ts            | upstream/test/engine.test.ts            | 运行、工具、事件、并发与 code-mode        |
| engine-approval.test.ts   | upstream/test/engine-approval.test.ts   | 审批/回答/拒绝/继续/过期与重复决定        |
| engine-steer.test.ts      | upstream/test/engine-steer.test.ts      | 插话、去重与状态                          |
| engine-watch.test.ts      | upstream/test/engine-watch.test.ts      | 等待、通知、补查、取消与恢复              |
| engine-recovery.test.ts   | upstream/test/engine-recovery.test.ts   | 独立进程 SIGKILL、审批/工具/脚本/等待恢复 |
| engine-compaction.test.ts | upstream/test/engine-compaction.test.ts | 压缩成功/失败与用量事件                   |
| durable-tools.test.ts     | upstream/test/durable-tools.test.ts     | 工具包装、重放与幂等键                    |
| store.test.ts             | upstream/test/store.test.ts             | SQLite 会话/运行/事件/审批与迁移          |
| model-provider.test.ts    | upstream/test/model-provider.test.ts    | Pi 模型协议、流、工具调用与错误           |

上游模型和平台使用 fixtures，不调用真实供应商。本地集成测试额外验证 Gateway、scope、原子目标回执、写入后 Worker 退出恢复、审批重启、事件持久化、code-mode 子调用与 QuickJS 限制；Electron E2E 验证真实包内依赖及 UI/IPC 响应。

## 待接入边界

当前仅用于技术验证，宿主为单一离线 owner `1`。合成目标不是 ProjectCoordinator、配置 Registry 或 JobRuntime。附件、undo、taskStates 明确返回不支持；watch 尚无本地真实任务闭环。自动标题/活动摘要关闭，压缩和完整交互仅保留原引擎能力与对应回归证据。

正式接入前必须完成：宿主实例独占与退出协议、窗口/项目所有权及 IPC 输入 schema、完整错误/状态映射、事件分页与订阅补洞、真实 Provider 流式桥及凭证隔离、业务工具和回执、双入口 UI/controller、任务 watch。验证命令含 `sandbox`、`idle`、`crashAfterEffect` 等 harness 能力，不能直接发布为 Renderer API。QuickJS 隔离脚本能力，不把持有 SQLite/宿主权限的整个 Agent Worker 当作操作系统沙箱。

许可来源：video-canvas 固定 commit 见 provenance；Pi 1.4.0 对应 commit `4a080252f06caf63a525d7873c5d94d3c23887e0`；quickjs-wasi 3.6.2 对应 commit `5a7a0eeda87c99542f8cf3095b6d61ecfa755977`。原许可保留于 `upstream/UPSTREAM-LICENSE`、`resources/agent/`，构建收集实际 bundle 依赖及已有许可文本到 `dependencies.json` / `licenses/`。这是本机工程证据，正式发行仍需检查完整应用的依赖与分发门禁。
