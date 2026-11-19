---
title: "09 画布 Agent 与创作任务闭环"
version: V1
feature_id: V1-FR-009
domain: 内置Agent
spec_status: Draft
risk: 高风险
track: 内置Agent
updated: 2026-11-19
---
# 09 画布 Agent 与创作任务闭环

## 功能卡

| 项目 | 内容 |
| --- | --- |
| 编号 | V1-FR-009 |
| 领域 | 内置Agent |
| 规格状态 | Draft |
| 风险等级 | 高风险（画布写入、生成消费、撤销冲突、任务唤醒） |
| 上游依赖 | V1-FR-001、V1-FR-002、V1-FR-003、V1-FR-004、V1-FR-005、V1-FR-007 |
| 下游影响 | V1-FR-006、V2 专业域 |
| 规格负责人 | 视频领域/桌面/Agent 工程 |
| 实现状态 | 见 [V1 实现状态](../../../02-产品与版本/当前版本/V1-实现状态.md) |

## 目标

创作者在画布中让助手理解当前内容、组织/修改节点、选择模型申请生成，并在生成结束后回到同一会话继续工作。

## 功能边界

包含：选择与 @ 引用、组/视口上下文、目录/详情按需读取、四类核心节点和分组操作、布局、删除审批、媒体生成审批、任务查询/等待、图片/视频理解和基础提帧、技能/联网、计划卡片、插话/恢复、冲突感知本轮撤销。

不包含：V2 完整角色/分镜/短剧/营销域操作；这些必须随对应域迁入，而不是永久排除。导演台 Agent 全功能编辑不属于上游已核验事实。

## 来源与追踪

- 需求来源：[V1 产品需求](../../../02-产品与版本/当前版本/V1-产品需求.md)。
- 相关决策：D001、D005、D007、D009、D011。
- 跨功能验收：V1-E2E-01、V1-E2E-02、V1-NFR-001、V1-NFR-003。
- 工具与机制依据：[完整迁移设计](../../../04-技术架构/内置Agent完整迁移设计.md)。

## 需求说明

### 用户故事

作为创作者，我希望助手能围绕我选中的素材真正修改画布并完成生成任务，过程可见、可控制、可恢复。

### 业务规则

1. 显示发送时选择/@/组/viewport；标签可移除，旧引用缺失可见。先给目录摘要，按需读详情。
2. 修改已有节点须先读取当前详情，写入通过结构化命令与 coordinator；模型不能直接改 Renderer store/磁盘文件。
3. mode/模型能力/工具权限由宿主限制；首批支持 script/image/video/audio 与组，不支持域拒绝并保留原数据。
4. 普通编辑/布局在授权范围可执行；删除与生成先给可理解提案。生成显示目标/模型/数量/输入/已知费用；自定义供应商费用未知时明示，不能假称免费。
5. 批准后创建持久任务，Agent wait/watch 与模型会话解耦；通知丢失用原任务查询兜底，不重发 submit。
6. 完成结果追加资产/输出历史，当前人工输入不被覆盖；节点已删除时结果保留到任务/资产，不复活节点。
7. 本轮撤销记录结构变更，不撤销费用/外部生成，不回滚整项目；后来人工编辑存在时冲突项跳过/报告。
8. 图片/视频理解按模型能力，提帧形成派生资产并记录来源；资料/技能/附件不提供扩权指令。

### 主流程

选择素材/节点 → 打开画布助手并说明任务 → 助手按需读图和计划 → 修改/布局 → 提出生成或删除 → 用户决定 → 执行持久任务 → 收起/插话/继续编辑 → 任务结束唤醒同一会话 → 显示结果定位/后续建议与可撤销结构变化。

### 异常与边界

项目关闭/owner 失效停止写；输入变化需重校验，不执行旧预估动作；受理未知显示 unknown；watch 不强行唤醒被用户停止的写运行；模型看不了视频给受支持替代说明，不伪造看过；撤销冲突保留新编辑。

### 页面与交互

复用上游浮窗/侧栏、快捷键、选择标签、会话、活动/计划/卡片、审批、后台等待区与定位节点反馈。controller 常驻但面板不牵动画布高频重渲染；“停止助手”和“取消生成”分开显示。

## 接口契约

复用 agent API，canvas 工具经 `canvas.read/applyOperations/arrange/proposeDelete/undoRun`；生成经 `jobs.propose/submit/get`，watch 经 engine。请求包含 scope/session/run、durableToolTaskId、资源基线、节点/资产 ID；审批引用存储中的规范 payload。

结果为结构化 mutation 摘要、revision、asset/output/job 引用、冲突项或 watch batch ID；错误为 AGENT_CANVAS_READ_REQUIRED、AGENT_CANVAS_CONFLICT、AGENT_TOOL_UNSUPPORTED、AGENT_APPROVAL_STALE、AGENT_UNDO_CONFLICT、AGENT_SCOPE_DENIED，其他错误沿用任务/资产域。

## 数据与事务

AgentMutation 保存 run/tool/operationId、before/after、变更类型和目标 ID；已读集合绑定 run 和资源版本；watch 保存 batch/job 关联、交付状态与去重 ID。画布修改和 receipt 一次 ProjectState 提交；任务创建/输出沿用 JobRuntime 协议，SQLite 与项目间查询回执补偿。

生成 `proposal -> decision -> queued/running -> terminal -> watch delivery`，run 可先结束但 watch 继续。撤销是新的显式项目操作，以当前版本检查每项逆变更，不替换整快照。

## 验收标准

#### AC01 上下文与按需读取

Given 画布有文本、媒体、分组及一个缺失/延后类型节点。

When 用户选中、@ 引用并让助手理解内容。

Then 上下文范围可见可移除，助手按需取详情，不支持项明确，未经读取不能直接修改已有节点。

#### AC02 真实画布操作与并发保护

Given 助手已读当前节点，同时用户继续编辑。

When 助手建节点/连线/分组/布局或修改旧节点。

Then 结构操作原子提交，冲突重读/报告，不覆盖新编辑或未知节点，活动记录可定位效果。

#### AC03 生成审批到同会话结果闭环

Given 助手提出生成多项任务，用户批准有效提案。

When 提交后收起面板、丢通知并重启，原任务完成。

Then 不重复 submit，原会话显示结果与失败项，任务/资产/节点历史一致，watch 只交付一次。

#### AC04 删除和撤销不破坏后来修改

Given 助手产生本轮变更，部分节点随后被人工编辑。

When 用户批准删除或撤销本轮。

Then 删除按批准范围执行，撤销仅处理可安全逆转项并报告冲突；历史资产/外部费用不伪装撤回。

#### AC05 媒体理解与提帧能力真实

Given 有授权图片/视频和支持/不支持视觉能力的模型。

When 助手查看媒体或截帧。

Then 仅向支持模型发送受限内容，截帧记录派生资产来源，缺能力清楚提示，不泄漏本机任意路径或凭证。

#### AC06 项目退出和未知结果控制

Given run 有待批准或已受理任务。

When 用户插话、停止、关闭项目，或供应商提交结果未知。

Then 未批动作不执行，旧 owner 不写入，停止不等同取消供应商任务，unknown 不自动生成第二次。

#### AC 逐项测试设计

| AC | 验收重点 | 测试层级 | 目标资产 | 目标命令 | 证据状态 |
| --- | --- | --- | --- | --- | --- |
| AC01 | 选择/@/已读约束 | 集成 | `tests/integration/canvasAgentContext.test.ts` | `pnpm test:integration -- tests/integration/canvasAgentContext.test.ts` | 未创建 |
| AC02 | 操作/人工并发 | 集成 | `tests/integration/canvasAgentMutations.test.ts` | `pnpm test:integration -- tests/integration/canvasAgentMutations.test.ts` | 未创建 |
| AC03 | 审批/任务/watch | E2E | `tests/e2e/agent-assistance.spec.ts` | `pnpm test:e2e -- tests/e2e/agent-assistance.spec.ts` | 未创建 |
| AC04 | 删除/逆变更冲突 | 集成 | `tests/integration/canvasAgentUndo.test.ts` | `pnpm test:integration -- tests/integration/canvasAgentUndo.test.ts` | 未创建 |
| AC05 | 多模态/派生资产 | 集成 | `tests/integration/canvasAgentMedia.test.ts` | `pnpm test:integration -- tests/integration/canvasAgentMedia.test.ts` | 未创建 |
| AC06 | 插话/退出/unknown | 集成 | `tests/integration/canvasAgentRecovery.test.ts` | `pnpm test:integration -- tests/integration/canvasAgentRecovery.test.ts` | 未创建 |

## 技术设计

见 [技术设计](09-画布Agent与创作任务闭环-技术设计.md)。

## 实现与验证

工程落点：Renderer AgentHost/controller、Main Canvas Tool Gateway、core 操作/逆变更、JobRuntime 与 Agent engine watch。差距：原 canvasgraph 语义映射、read set/逆变更、生成审批与流模型 adapter 待实测；当前无运行证据。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 核心画布助手纳入 V1 主线，专业域工具随域迁入 | D011 |
