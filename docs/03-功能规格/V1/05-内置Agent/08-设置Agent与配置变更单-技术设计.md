---
title: "08 设置 Agent 与配置变更单 - 技术设计"
version: V1
feature_id: V1-FR-008
updated: 2026-11-19
---
# 08 设置 Agent 与配置变更单 - 技术设计

来源：[功能规格](08-设置Agent与配置变更单.md)，上游 `admin_change/admin_diff/admin_approval/admin_action` 语义见完整 Agent 设计。

## 风险与对策

陈旧审批覆盖新配置：绑定基线并执行前 CAS；跨资源部分成功：逐项 receipt/结果与补偿；秘密泄漏：独立输入动作；工具权限扩大：本机 scope 白名单与执行端复查。

## 单元契约

`buildProposal(resourceRef, baseHash, changes)` 产生规范字段差异与校验；`applySelected(proposalId, selected, decisionId)` 只执行所选且基线匹配项；`submitSecret(requestId, input)` 不返回明文；`startTrial(approvalId)` 固定已批准输入。

## 伪代码

```text
FUNCTION applySelected(proposal, decision):
  IF scope/resource forbidden: RETURN SETTINGS_RESOURCE_DENIED       // B08-01
  load immutable proposal and selected item IDs from stored record   // B08-02
  IF decision invalid/expired: RETURN SETTINGS_CHANGE_INVALID        // B08-03
  FOR item IN selected:
    IF target receipt exists: reuse original result                 // B08-04
    IF current base hash mismatched: mark stale; do not apply        // B08-05
    validate and commit item with receipt; collect failure/compensation // B08-06
  persist item results and actual aggregate state                    // B08-07

FUNCTION executeSecretOrTrial(action):
  IF secret requested: use restricted input and secure store; return status // B08-08
  IF trial approval valid: execute once; unknown => retain unknown, no resubmit // B08-09
```

## 分支到测试追踪

| 分支 | 功能 AC | 跨功能验收 / NFR |
| --- | --- | --- |
| B08-01 | AC05 | V1-NFR-001 |
| B08-02 | AC01、AC02 | - |
| B08-03、B08-05 | AC02 | V1-E2E-02 |
| B08-04、B08-06～07 | AC02、AC05 | V1-E2E-02 |
| B08-08 | AC03 | V1-NFR-001 |
| B08-09 | AC04 | V1-E2E-02 |

## 并发控制

配置存储以资源 revision/hash CAS；新秘密引用先存后更新配置，失败清理新引用、保留旧值。已启用插件不可变版本，Agent 修改创建新草稿。

## 事务边界

单一配置快照里的多项可一起提交；不同存储使用显式逐项执行/补偿。禁止先在 engine 标成功再调用目标。设置会话不持有项目可写权限。

## 幂等与重试

decisionId 与 durable task ID 映射 operationId，scope/hash 纳入去重请求；重试只核对回执和未执行项。真实试跑走供应商受理未知规则。

## 外部调用与补偿

文档抓取、测试网络、模型调用各有资源/目标策略。失败显示实际效果，不能用“撤销配置”假装已取消外部请求或退回费用。

## 安全与日志

敏感输入不写 proposal/engine payload；查询禁止任意 SQL/路径；page_context 只是选择提示，不作为授权。trace 脱敏，授权页面对话不能修改官方后台。

## 发布与回滚

proposal/schema/插件 API 版本化；升级后不兼容的待批变更重新预览，不自动执行。保留已执行 receipt 用于对账。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 初始 Draft | D011 |
