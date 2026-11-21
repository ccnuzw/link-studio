---
title: "08 设置 Agent 与配置变更单"
version: V1
feature_id: V1-FR-008
domain: 内置Agent
spec_status: Draft
risk: 高风险
track: 内置Agent
updated: 2026-11-19
---
# 08 设置 Agent 与配置变更单

## 功能卡

| 项目 | 内容 |
| --- | --- |
| 编号 | V1-FR-008 |
| 领域 | 内置Agent |
| 规格状态 | Draft |
| 风险等级 | 高风险（配置写入、密钥、试跑消费与陈旧审批） |
| 上游依赖 | V1-FR-004、V1-FR-007 |
| 下游影响 | V1-FR-005、V1-FR-009 |
| 规格负责人 | 桌面/Agent/模型工程 |
| 实现状态 | 见 [V1 实现状态](../../../02-产品与版本/当前版本/V1-实现状态.md) |

## 目标

用户在设置页通过助手完成查配置、诊断、接入接口、调整模型参数和插件，查看明确变更单并决定执行范围。

## 功能边界

包含：页面上下文标签、检索/读取配置与错误、文档检索、模型能力参数、Provider/插件接入、字段差异变更单、逐项/整单决定、专用密钥卡、dry-run/真实试跑和安全 trace。

不包含：本机修改官方定价、全站用户/渠道授权；这些保留到官方后台。人工配置仍属于 V1-FR-004，Agent 不成为必经入口。

## 来源与追踪

- 需求来源：[V1 产品需求](../../../02-产品与版本/当前版本/V1-产品需求.md)。
- 相关决策：D005、D011。
- 跨功能验收：V1-E2E-02、V1-NFR-001。
- 参考：[完整迁移设计](../../../04-技术架构/内置Agent完整迁移设计.md) 的 admin 工具与变更单映射。

## 需求说明

### 用户故事

作为创作者，我希望助手理解当前设置页和选中模型，帮我完成接入与诊断，而不是让我从聊天答案里手工抄配置。

### 业务规则

1. route/providerId/modelBindingId/pluginId 由页面 hints 解耦提供，标签可移除；发送时快照，执行时再校验。
2. 读自动执行，写先 propose；变更单显示每项 before/after、理由、来源、校验和 base revision/hash。
3. 用户逐项/整单批准；失效项重新预览，不静默覆盖人工更新。部分执行逐项报告，不伪称全成。
4. 密钥通过专用卡直接写 SecretStore，模型只见已配置状态；不请求用户在聊天中粘贴密钥。
5. 静态/mock/dry-run 与真实试跑分离；真实试跑说明目标、素材与潜在费用，保存脱敏诊断。
6. 工具只能读写本机用户授权配置，官方资源只读目录或后台独立权限，不因工具 admin 前缀获得后台权力。

### 主流程

打开设置助手 → 带选中资源标签提出目标 → 助手读取现状/文档 → 建议变更单或插件草稿 → 用户选择条目批准 → 校验最新版本并执行 → 必要时安全填密钥/确认试跑 → 返回逐项结果及定位入口。

### 异常与边界

缺模型引导人工配置；文档信息不足显示缺口不编造验证成功；陈旧版本、插件无效、存储失败不落半配置；真实请求结果未知不自动再次消费。

### 页面与交互

全设置范围共享助手抽屉和会话，显示页面/资源标签；复用画布消息、活动/计划/卡片，增加字段差异与变更项选择、密钥输入及试跑 trace。界面不暴露内部数据库或任意 SQL。

## 接口契约

共用 agent API；设置工具的 typed Gateway 使用 `settings.read/query/proposeChanges/decideChanges`、插件校验、`requestSecret` 和 `testRun`。propose 保存 resourceRef、baseHash、changes、source、validation；decision 带 proposalId、selectedItemIds、decisionId，不接收用户端可信 after 状态覆盖数据库。

错误为 SETTINGS_RESOURCE_DENIED、SETTINGS_CHANGE_STALE、SETTINGS_CHANGE_INVALID、SETTINGS_CHANGE_PARTIAL、PROVIDER_SECRET_STORE_UNAVAILABLE、PROVIDER_TEST_OUTCOME_UNKNOWN；每项成功/失败可查询。完整 union 在 S3 与配置存储同时冻结。

## 数据与事务

ChangeProposal/Item 包含 before/after、resource revision/hash、selected/decision/result；Approval 连接 durable tool ID。配置效果与 operation receipt 同存储提交，engine 收据后确认。跨配置与 SecretStore 用原子引用更新/补偿，不宣称全单跨存储事务。

`proposed -> waiting_decision -> applying -> applied/partial/failed/stale/rejected/expired`；成功项不因重试重复执行。

## 验收标准

#### AC01 当前页上下文准确可控

Given 设置页选中模型/插件。

When 用户移除标签、发消息并切换页面。

Then 仅发送保留的上下文，历史记录发送时快照，未选资源不被误改。

#### AC02 变更单按选择执行并拒绝陈旧基线

Given 助手提出多项字段变更，其中一项被人工更新。

When 用户选择部分条目批准。

Then 未选条目不执行，陈旧项返回 stale 并重新预览，其他项逐项显示真实结果。

#### AC03 密钥专用输入不进入聊天

Given 助手申请配置 Provider 凭证。

When 用户通过专用卡输入并提交。

Then 明文只经受限 IPC 到安全存储，模型/插件/项目/日志和历史只见状态；存储不可用拒绝明文降级。

#### AC04 接入与试跑完整闭环

Given 有可用文本模型和目标接口资料。

When 助手读取/生成插件与模型参数、校验，用户启用并确认真实测试。

Then 可定位本机配置与测试结果；mock/dry-run 不冒充真实成功，真实超时未知不自动再次调用。

#### AC05 本机权限与恢复不越界

Given 越权官方资源或已执行但收据未返回的本机变更。

When 助手访问资源或重启重放。

Then 官方写被拒绝，本机效果从回执恢复不重复，失败/部分结果可诊断。

#### AC 逐项测试设计

| AC | 验收重点 | 测试层级 | 目标资产 | 目标命令 | 证据状态 |
| --- | --- | --- | --- | --- | --- |
| AC01 | 当前页上下文与可移除标签 | E2E | `tests/e2e/settings.spec.ts`、`src/renderer/settings/settings-assistant.tsx` | `pnpm check:package` | 本地通过 |
| AC02 | 逐项决定/基线冲突 | 集成/E2E | `src/main/settings/registry.ts`、`tests/integration/settings.test.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |
| AC03 | 密钥路径/降级 | 集成/E2E | `src/main/settings/ipc.ts`、`src/renderer/settings/settings-assistant.tsx`、`tests/integration/settings.test.ts` | `pnpm check:package` | 本地通过 |
| AC04 | 插件接入/试跑 | E2E | `src/main/settings/agent.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |
| AC05 | 权限/回执恢复 | 集成/E2E | `packages/agent-runtime/src/runtime.ts`、`tests/integration/settings.test.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |

## 技术设计

见 [技术设计](08-设置Agent与配置变更单-技术设计.md)。

## 实现与验证

工程落点：设置 hints/controller、Main 配置工具 Gateway、SQLite 配置 receipt、受信 IPC、safeStorage 和 Worker 重启对账；复用上游 admin 工具意图，移除全站管理员权限。真实供应商、预发费用/计费确认、其他平台和双入口验收仍待后续批次。

### 验证记录

#### 2026-11-20 S3 本地验收

`tests/integration/settings.test.ts` 3/3 通过，`tests/e2e/settings.spec.ts` 在源码版和未签名 macOS arm64 目录包各 1/1 通过。覆盖变更单逐项应用、陈旧 revision、凭证卡不入模型/日志、试跑单次执行与 unknown 不重发、待审批重启对账、插话/停止/历史分页。回环 HTTP/SSE 仅证明本机桥接，不证明真实供应商接口或收费语义。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 设置助手扩展为完整配置工作流，不限插件生成 | D011 |
