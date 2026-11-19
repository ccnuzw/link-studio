---
title: "07 Agent 共享运行与交互 - 技术设计"
version: V1
feature_id: V1-FR-007
updated: 2026-11-19
---
# 07 Agent 共享运行与交互 - 技术设计

来源：[功能规格](07-Agent共享运行与交互.md)，架构与源码证据见 [完整迁移设计](../../../04-技术架构/内置Agent完整迁移设计.md)。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| engine/项目/配置跨存储副作用重复 | 目标原子回执，durable task ID 幂等，恢复先核对目标 |
| scope/模型/资料扩权 | 生成工具集和执行端双重校验，秘密留 Host |
| 收起/退出/重启误停或误续 | controller 与面板分离、目标先恢复、旧 owner 失效 |

## 单元契约

`startRun(scope, messageId)` 校验模型和 scope 后持久化；`executeTool(call)` 以稳定 task ID 对账；`recoverEngine()` 先检查目标存储与会话再恢复；`deliverWatch(batchId)` 按完成批次去重。

## 伪代码

```text
FUNCTION executeTool(call):
  IF scope/mode/owner/model disallows tool: RETURN AGENT_SCOPE_DENIED // B07-01
  IF target receipt exists: RETURN original result                   // B07-02
  IF approval required and not valid: create idempotent proposal; PAUSE // B07-03
  result = target.executeWithReceipt(call.durableId, payloadHash)     // B07-04
  persist engine tool result and event outbox                        // B07-05

FUNCTION recoverEngine():
  IF model/store/scope unavailable: mark interrupted; STOP           // B07-06
  restore pending steer/approval only within valid scope             // B07-07
  IF call replay policy unsafe or unknown: reconcile; do not replay  // B07-08
  restore watches; query originals; deliver by batch receipt         // B07-09
  emit replayable state and sanitized diagnostics                    // B07-10
```

## 分支到测试追踪

| 分支 | 功能 AC | 跨功能验收 / NFR |
| --- | --- | --- |
| B07-01 | AC01、AC04 | V1-NFR-001 |
| B07-02、B07-04～05 | AC02 | V1-E2E-02 |
| B07-03、B07-07 | AC03 | V1-E2E-02 |
| B07-06、B07-10 | AC06 | V1-NFR-003 |
| B07-08 | AC02、AC04 | - |
| B07-09 | AC05 | V1-E2E-02 |

## 并发控制

同 scope 的活跃 run CAS；不同 scope 仍按目标资源协调。SQLite 本身不保护项目文件或另一配置存储，不能省掉目标 CAS。插话/decision/watch 都有独立幂等 ID。

## 事务边界

目标业务效果与 receipt 同事务；engine receipt/event outbox 在 engine DB 内事务。跨两者失败用目标查询恢复，不宣称共同 ACID。模型 token 消耗不因工具回执存在而自动重跑内部请求。

## 幂等与重试

读取/事件投递可重试，已登记安全工具按目标回执重放；未知外部副作用暂停对账。Watch 提交通知去重与实际效果去重均需实现，不能以“事件看起来重复可忽略”代替业务幂等。

## M0-05 分支验证映射

| 分支 | 当前可执行证据 | 尚缺业务证据 |
| --- | --- | --- |
| B07-01 | agent-runtime 集成：scope/session/mode/canvas ID 校验与跨工具拒绝 | 窗口 owner、模型能力及真实上下文 |
| B07-02、B07-04～05 | agent-runtime 集成：效果+回执同事务、写后退出恢复、异 hash/陈旧 revision 拒绝 | ProjectCoordinator/配置/任务真实回执 |
| B07-03、B07-07 | 本地审批重启再批准、跨 scope 决策拒绝；原 approval/steer 回归 | 完整变更单/逐项批准/交互 UI |
| B07-06、B07-10 | SQLite seq 重启回放、Worker 退出、原模型/压缩失败回归 | 错误映射、事件分页补洞、脱敏诊断 |
| B07-08 | 原 durable-tools/recovery/code-mode 回归 | 真实任务提交未知与外部对账 |
| B07-09 | 原 engine-watch/recovery fixture 回归 | 本地 JobRuntime/taskStates 接入 |

命令统一为 `pnpm test:agent`，准确结果见 [实施基线](../../../04-技术架构/实施基线与开发批次.md#11-m0-05-实测记录)。Worker client 当前仅供受信内部 harness；单 owner、命令输入及通用验证入口不能直接作为正式 IPC。原 `canceled` 等状态保留在引擎中，面向产品的状态/错误 union 在 S3/S4 业务适配时冻结，不把 UI 词汇反向强改上游存储。

## 外部调用与补偿

模型调用走 Host，资料抓取独立受控；取消 engine 不等于供应商任务取消。SQLite 恢复先于工具调度，关闭先禁止新写并 flush；无法恢复的运行保留可诊断 interrupted 状态。

## 安全与日志

code-mode/插件运行时分别验证，不以 utility process 自带隔离为依据；明文凭证、绝对敏感路径和用户资料不进入默认 trace。skill 版本固定，资源访问授权随调用校验。

## 发布与回滚

备份 engine DB 并版本化迁移；旧应用不能加载新 schema 时明确阻止续跑，不自动另建空库丢会话。未完成运行不因更新变更工具版本后自动重放。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 初始 Draft，待迁移验证 | D011 |
