---
title: "09 画布 Agent 与创作任务闭环 - 技术设计"
version: V1
feature_id: V1-FR-009
updated: 2026-11-19
---
# 09 画布 Agent 与创作任务闭环 - 技术设计

来源：[功能规格](09-画布Agent与创作任务闭环.md)，依赖 ProjectCoordinator、JobRuntime 和 FR007 的共享恢复机制。

## 风险与对策

先读后改与版本检查防止盲改；普通编辑不逐次审批；删除/生成按明确效果提案。所有副作用有目标 receipt，watch 去重与提交幂等分别成立。撤销按逆变更检查，不覆盖新人工编辑。

## 单元契约

`readCanvas(scope, refs)` 返回受限摘要/详情并记录 read set；`applyAgentOps(call)` 校验已读和资源基线；`approveGeneration(id)` 按规范 payload 建原始任务；`undoRun(runId)` 返回已撤销/冲突/不可撤销项。

## 伪代码

```text
FUNCTION applyAgentOps(call):
  IF scope/owner/mode invalid: RETURN AGENT_SCOPE_DENIED           // B09-01
  IF updating unread existing resource: RETURN READ_REQUIRED     // B09-02
  IF unsupported op or capability: RETURN TOOL_UNSUPPORTED        // B09-03
  IF revision changed: reread and validate; report conflict       // B09-04
  commit ops, mutation record and receipt atomically              // B09-05

FUNCTION approveGenerationOrDelete(proposal):
  IF approval stale or target changed: return revised proposal   // B09-06
  execute stored selected payload through target receipt         // B09-07
  IF generation accepted: persist watch; resume only from original jobs // B09-08

FUNCTION undoRun(run):
  FOR mutation IN reverse order:
    IF current value differs from expected after: skip and report conflict // B09-09
    commit inverse with receipt; never undo external charge       // B09-10

FUNCTION inspectMedia(ref):
  IF unauthorized or model unsupported: deny with capability reason // B09-11
  inspect bounded input or create derived frame through AssetStore // B09-12
```

## 分支到测试追踪

| 分支 | 功能 AC | 跨功能验收 / NFR |
| --- | --- | --- |
| B09-01 | AC06 | V1-NFR-001 |
| B09-02 | AC01 | - |
| B09-03～05 | AC02 | V1-E2E-02 |
| B09-06～07 | AC03、AC04、AC06 | V1-E2E-02 |
| B09-08 | AC03、AC06 | V1-E2E-02 |
| B09-09～10 | AC04 | - |
| B09-11～12 | AC05 | V1-NFR-001、V1-NFR-003 |

## 并发控制

read set 绑定 run/节点版本；重读后重新判断，不复用旧批准。用户 dirty 编辑与远端 mutation 需要字段/操作合并和 revision 提示，不能接受整图覆盖。run 写在同一项目队列，与人工操作、任务输出串行提交。

## 事务边界

节点/边/组及 mutation/receipt 同一次 ProjectState 发布；生成提交在项目事务外，预写 job 后走供应商不确定性协议。watch 建立失败从原 job/批准回执补建，不重新提交生成。

## 幂等与重试

稳定 durableToolTaskId 作为 operationId 来源，结果投递 batch ID 作为 watch 去重。撤销动作本身也有 receipt；同 run 再次撤销返回原结果/已撤销，不反复逆转。

## 外部调用与补偿

多模态和提帧限制大小、帧数、时长与超时；派生资产先完整入库，再绑定节点。外部取消只在供应商确认后标 cancelled；unknown 以查询或人工对账处置。

## 安全与日志

主进程工具按当前项目授权读取资产，模型不持有文件路径或长期凭证。附件/网页/技能不改变 mode 或注册工具。收起 UI 继续运行，关闭 scope 则失效写授权。

## 发布与回滚

保存原未知节点和迁移映射；不兼容工具/提示版本的待执行审批需重新预览。上游画布 Agent 测试按行为迁入，不能以 UI 复制代替工具执行与恢复验证。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 初始 Draft | D011 |
