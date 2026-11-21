---
title: "07 Agent 共享运行与交互"
version: V1
feature_id: V1-FR-007
domain: 内置Agent
spec_status: Draft
risk: 高风险
track: 内置Agent
updated: 2026-11-19
---
# 07 Agent 共享运行与交互

## 功能卡

| 项目 | 内容 |
| --- | --- |
| 编号 | V1-FR-007 |
| 领域 | 内置Agent |
| 规格状态 | Draft |
| 风险等级 | 高风险（持久运行、工具副作用、跨会话授权和恢复） |
| 上游依赖 | V1-FR-004（可用模型绑定）；项目 scope 另依赖 V1-FR-001 |
| 下游影响 | V1-FR-008、V1-FR-009 |
| 规格负责人 | 桌面/Agent 工程 |
| 实现状态 | 见 [V1 实现状态](../../../02-产品与版本/当前版本/V1-实现状态.md) |

## 目标

用户在设置和画布中使用同一套可恢复 Agent 会话机制，保留上游的工具交互、上下文、审批和运行反馈，不依赖官方登录。

## 功能边界

包含：Pi Durable 会话/运行/历史、事件回放、模型与工具能力过滤、插话/停止/继续、计划/卡片/活动摘要、审批基础、上下文压缩、附件、技能渐进读取、受限 code-mode、watch 与观测基础。

不包含：具体设置/画布领域写入（V1-FR-008/009），官方积分账本，任意终端/脚本执行，未迁移专业域工具。

## 来源与追踪

- 需求来源：[V1 产品需求](../../../02-产品与版本/当前版本/V1-产品需求.md)。
- 相关决策：D002、D005、D007、D009、D011、D016。
- 跨功能验收：V1-E2E-02、V1-NFR-001、V1-NFR-003。
- 源码事实与平台工具映射：[完整设计](../../../04-技术架构/内置Agent完整迁移设计.md)。

## 需求说明

### 用户故事

作为创作者，我希望收起面板、插话或重启后仍能理解和继续助手的工作，且不会重复执行已完成动作。

### 业务规则

1. 一个共享 engine，各 session 显式 scope；同 scope 活跃写运行排他，工具不只靠提示词限制。
2. 设置与画布 UI 共用 controller/事件/审批组件，面板收起不停止 engine；关闭项目/退出按显式生命周期处理。
3. durable task ID 映射目标侧 operationId；目标效果和 receipt 先提交，Agent 收据后确认，重复调用返回原结果。
4. SQLite 保存助手状态，不取代项目权威源；目标快照与 engine 无共同事务，需恢复对账。
5. 插话稳定 ID 去重且可见读取状态；待审批消息不自动批准。停止不承诺取消外部生成。
6. 仅向模型公布当前 scope/mode/能力允许的工具，执行端复核。code-mode 仅调用 scriptable 工具，权限/审批不能在脚本中绕过。
7. 模型调用覆盖 main/summary/title/activity，用途与用量可观测；使用宿主凭证边界，流/tool-call/多模态要明确支持。
8. 附件/技能/网页内容作为不可信资料，资源有授权与上限；秘密不进入模型上下文/trace。

### 主流程

选择可用模型 → 以 scope 创建/恢复会话 → 显示上下文标签并发送 → engine 调工具/更新计划 → 必要时等待审批/回答 → 继续运行或等待外部任务 → 显示结果/摘要和历史。

### 异常与边界

无可用模型引导人工配置；模型缺 tool calling/视觉能力时明确提示；数据库不可用不得回退到丢失审批的无状态模式；事件缺口补快照/历史；旧 scope、已失效 owner、过期审批不自动恢复写入；未知 replay policy 默认不安全。

### 页面与交互

保留会话选择、模型选择、消息/活动分组、计划、结果卡、审批、插话、停止/继续、上下文/压缩状态和待生成区。输入失败保留原文，历史分页，窗口与项目切换正确清理订阅；无隐藏推理内容时不虚构思考显示。

两个入口都显示读取、运行、等待审批和操作处理状态。同作用域的其他会话正在运行时，可直接返回该会话。草稿保存在当前助手面板的内存中，按会话区分；画布切换侧栏时保留草稿。阅读旧消息时保持滚动位置，并提供「回到最新」。回车发送，Shift＋回车换行。输入法组字期间的回车用于确认选词。

## 接口契约

typed IPC `agent.sessions.create/list/open`、`agent.runs.start/steer/stop/continue`、`agent.history.get`、`agent.events.subscribe`、`agent.approvals.decide`、`agent.watches.list`、`agent.diagnostics.export`。调用携带 requestId、scope/sessionId、messageId/decisionId 等幂等标识；不暴露通用工具任意执行 API。

返回 session/run 状态与可回放事件 seq；错误 code 为 AGENT_MODEL_UNAVAILABLE、AGENT_MODEL_CAPABILITY_UNSUPPORTED、AGENT_SCOPE_DENIED、AGENT_RUN_BUSY、AGENT_STORE_UNAVAILABLE、AGENT_APPROVAL_STALE、AGENT_INTERRUPTED。完整输入 union/原上游状态映射在 M0 adapter 实测后冻结。

## 数据与事务

AgentSession/Run/Event/Approval/Watch/ToolReceipt 保存本机 SQLite，带 scope、版本和稳定调用 ID。SkillVersion 不可变，运行固定版本。项目变更 receipt 在 ProjectState，配置变更 receipt 在配置存储；事件投递用可重试 outbox/seq，不假设 IPC 与 DB 原子。

运行可 paused/stopped/interrupted/failed/completed，watch 是独立持久状态；完成主 run 不代表外部生成结束。关闭先停止接写、flush、失效 owner；重启在目标恢复后校验 scope 再调度。

## 验收标准

#### AC01 两入口共用会话机制且 scope 隔离

Given 设置会话和两个项目会话存在。

When 切换入口、收起面板并重新展开。

Then 历史/运行/订阅恢复正确，不串上下文，收起不停止工作，未授权 scope 工具被拒绝。

#### AC02 工具重放不重复生效

Given 目标服务已提交一次工具效果但 Agent 尚未保存成功结果。

When 强制终止后重启并恢复同 durable 调用。

Then 读取目标 receipt 返回原效果，不重复改配置、画布或生成；不安全/未知调用标 interrupted。

#### AC03 插话、审批和停止语义明确

Given run 运行中或等待批准/提问。

When 用户发送插话、回答/拒绝，或停止后继续。

Then 消息去重且状态可见，不绕过未批准动作，不把停止等同远端已取消。

#### AC04 上下文与工具能力不越界

Given 包含附件/网页/技能的上下文，模型缺某能力，或脚本试图调用非 scriptable 工具。

When 构造请求与执行工具/code-mode。

Then 仅提供允许工具和受限资料，秘密不发送；违规脚本/能力调用拒绝，压缩后可追溯资料引用。

#### AC05 后台等待可恢复且只交付一次

Given 一批已批准任务存在 watch，通知丢失或 engine 重启。

When 原任务完成并补查询。

Then 结果回同一会话，不重发生成、不重复追加唤醒；失效 scope 不自动写入。

#### AC06 运行故障与观测不伪装成功

Given 模型/DB 不可用、事件断线或压缩/内部模型调用失败。

When 运行终止/恢复并查看诊断。

Then 显示真实状态，历史缺口可补，main/summary/title/activity 关联和用量可诊断，导出默认脱敏。

#### AC 逐项测试设计

| AC | 验收重点 | 测试层级 | 目标资产 | 目标命令 | 证据状态 |
| --- | --- | --- | --- | --- | --- |
| AC01 | scope/UI 生命周期 | 集成/E2E | `tests/integration/agent-runtime.test.ts`、`tests/e2e/agent-runtime.spec.ts`、`src/main/settings/agent.ts` | `pnpm check:package` | 本地通过 |
| AC02 | 目标 receipt 与恢复 | 集成 | `tests/integration/agent-runtime.test.ts`、`tests/integration/settings.test.ts` | `pnpm check:package` | 本地通过 |
| AC03 | 插话/审批/停止 | 集成/E2E | `packages/agent-runtime/upstream/test/engine-steer.test.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |
| AC04 | 资料/脚本/模型边界 | 集成 | `tests/integration/agent-runtime.test.ts`、`packages/agent-runtime/upstream/test/durable-tools.test.ts` | `pnpm test:agent` | 已创建 |
| AC05 | watch 补查去重 | 集成/E2E | `tests/integration/generation.test.ts`、`tests/e2e/generation.spec.ts` | `pnpm check:package` | 本地通过 |
| AC06 | 失败/观测/历史 | 集成/E2E | `tests/integration/agent-runtime.test.ts`、`packages/agent-runtime/upstream/test/engine-compaction.test.ts` | `pnpm check:package` | 已创建 |

## 技术设计

见 [技术设计](07-Agent共享运行与交互-技术设计.md)。

## 实现与验证

`packages/agent-runtime/` 保留原引擎、本地 Gateway、SQLite 和 QuickJS Worker。设置域和画布域已接入各自的 Main 工具、受限 preload API 及会话交互。画布 watch 使用原任务 ID 查询，恢复范围绑定项目和会话。

### 验证记录

#### 2026-11-20 双入口交互回归

macOS arm64 的 `pnpm exec playwright test tests/e2e/settings.spec.ts tests/e2e/generation.spec.ts --reporter=line` 通过 3/3。覆盖切换会话后草稿隔离、回到待审批会话、切换画布侧栏后草稿保留，以及 1024×700 窗口中的键盘发送、长消息阅读位置和回到最新。已有审批、插话、停止、重启恢复和画布撤销同步回归。发布前仍需验证长会话性能、辅助技术实际操作及真实 Provider 的工具和恢复链路。

#### 2026-11-20 Responses 流式模型

设置和画布共享的模型桥按已保存修订选择 Responses 或 Chat Completions。`pnpm exec playwright test tests/e2e/settings.spec.ts --reporter=line` 2/2 通过，Responses 回环服务验证设置小灵从流式工具调用到 `admin_query` 结果回送和文本回复。真实 `magpie` 的证据覆盖短文本流。真实服务的工具、视觉、审批后恢复与画布任务继续按 V1-E2E-02 验收。

#### 2026-11-20 S4 画布域补充验证

macOS arm64/APFS 的 `env -u ELECTRON_RUN_AS_NODE pnpm check:package` 验证了双入口隔离、审批任务落盘后 Worker 中止、混合结果回原会话和停止后仅补交结果。修复 SQLite 崩溃夹具后实际确认至少 300 条事件写入，再强杀子进程验证序号连续。

`tests/e2e/generation.spec.ts` 验证指定技能读取、回环资料地址拒绝，以及画布诊断导出保留模型用途、用量事件和工具活动元数据，并排除提示词、端点及凭证。`tests/integration/agent-reference.test.ts` 通过替身传输验证 HTTPS 文本成功响应、稳定引用、脱敏和响应限制。正式门禁尚缺桌面联网资料成功读取及压缩后溯源、桌面摘要/标题/活动模型调用关联验证。详见 [V1-E2E-02](../../../05-测试与发布/V1-Agent端到端验收规范.md#v1-e2e-02-设置画布双入口-agent-辅助与恢复)。

#### 2026-11-20 S3 设置域本地验收

`pnpm check:package` 的集成 90/90、上游 144/144、源码版与未签名目录包 E2E 各 9/9 通过。上游 store 崩溃测试报告中引用的 `test/fixtures/append-events.ts` 当前缺失，虽总报告为 144/144，不能把该子进程路径作为额外证据；设置回执恢复由 `tests/integration/settings.test.ts` 覆盖。FR-007 整体仍为开发中，等待 S4 接入画布工具、真实 watch 和完整双入口 E2E。

2026-11-19，macOS arm64/APFS：`pnpm agent:build` 后本地 9 项集成、`pnpm test:agent:upstream` 的 144 项迁入回归、源码/目录包各 3 项 Electron 测试通过。完整命令与版本见 [M0-05 实测记录](../../../04-技术架构/实施基线与开发批次.md#11-m0-05-实测记录)。覆盖双 scope 执行端校验、合成目标 receipt/恢复、审批重启、插话/取消、事件回放、code-mode 子工具与 QuickJS 限制；watch/压缩仅具迁入引擎 fixture 证据。上表保守标“已创建”，因为每条完整业务 AC 仍缺 UI、真实项目/任务或宿主模型桥证据，不将部分断言通过升级为整条 AC 通过。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-20 | 补充双入口会话状态、草稿隔离与滚动交互验证 | D011 |
| 2026-11-20 | 登记 Responses 流式协议和设置助手工具回环证据 | D014 |
| 2026-11-19 | 登记共享运行与交互主线，不以简化聊天循环替代 | D011 |
| 2026-11-19 | 回写 M0-05 原引擎迁入、本地测试与打包证据；保留业务 AC 缺口 | D011 |
