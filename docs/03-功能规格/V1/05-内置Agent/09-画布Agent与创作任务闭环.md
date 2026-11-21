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
- 相关决策：D001、D005、D007、D009、D011、D015、D016。
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

桌面使用 `projects.canvasAgent`，通过 `projectHandle` 限定项目。会话和运行操作包含会话 ID，审批提交审批 ID 和选中项。模型使用 `canvas_get_state`、`canvas_delete`、`generate_media` 及绑定素材读取工具。结构变更和生成提案均须批准。助手生成与手动生成共享任务记录，结果跟进由引擎 watch 负责。

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
| AC01 | 选择/@/已读约束 | 集成/E2E | `tests/integration/generation.test.ts`、`tests/e2e/generation.spec.ts` | `pnpm check:package` | 本地通过 |
| AC02 | 操作/人工并发 | 集成/E2E | `tests/integration/generation.test.ts`、`tests/integration/project-canvas.test.ts`、`tests/e2e/generation.spec.ts` | 同上 | 本地通过 |
| AC03 | 审批/任务/watch | 集成/E2E | `tests/integration/generation.test.ts`、`tests/e2e/generation.spec.ts` | 同上 | 本地通过 |
| AC04 | 删除/逆变更冲突 | 集成 | `tests/integration/generation.test.ts` | 同上 | 本地通过 |
| AC05 | 多模态/派生资产 | 集成/E2E | `tests/integration/generation.test.ts`、`tests/e2e/generation.spec.ts` | 同上 | 本地通过 |
| AC06 | 插话/退出/unknown | 集成/E2E | `tests/integration/generation.test.ts`、`tests/e2e/generation.spec.ts` | 同上 | 本地通过 |

## 技术设计

见 [技术设计](09-画布Agent与创作任务闭环-技术设计.md)。

## 实现与验证

工程落点：Renderer AgentHost/controller、Main Canvas Tool Gateway、core 操作/逆变更、ProjectState JobRuntime 与 Agent engine watch。媒体工具仅读取当前项目已绑定资产；图片按上限发送，视频由受限 FFmpeg 提帧并登记 derived 来源。

### 2026-11-21 模型问答

`pnpm exec playwright test tests/e2e/generation.spec.ts -g 'S4 设置与画布小灵'` 本地 1/1。`ask_user` 可带 `modelKind` 选择图片或视频模型。选项取已启用且可调用的本机模型，提交时按模型 ID 与类型重验，模型收到选择后继续对话。测试使用本机回环模型并验证记录展示模型名。

### 2026-11-21 联网检索

`pnpm exec vitest run --project integration tests/integration/agent-reference.test.ts tests/integration/agent-runtime.test.ts` 覆盖默认关闭、单轮授权、共用调用限额、受限目标、正文提取与诊断脱敏。Worker 用例通过回环模型验证工具调用结果进入后续模型请求。Main 侧真实公网冒烟通过中文维基百科检索“分镜”，并成功提取对应网页正文。开发版 `magpie` 的联网工具端到端验证仍待补。

`tests/e2e/generation.spec.ts` 补验首次默认关闭、发送后移除本轮联网标记、下一轮模型工具列表不含联网工具。模型响应来自本机回环服务。

`pnpm exec vitest run --project integration tests/integration/generation.test.ts -t '按需读取导演场景'` 本地 1/1。概览返回时长、画幅与数量，精读提供限量人物、道具、机位和关键帧，并脱敏名称。

### 2026-11-21 从剧本拆分镜

画布小灵在引用包含正文的剧本后提供拆镜草稿入口。通过现有读取、画布修订校验和审批流程创建分镜表，审批可展开镜头的画面、景别、运镜、对白、动作与时长。`tests/e2e/generation.spec.ts` 通过回环模型验证草稿、审批预览及批准前后画布状态。

### 2026-11-20 S4 本地验收

macOS arm64/APFS 的 `env -u ELECTRON_RUN_AS_NODE pnpm check:package` 中，生成集成 12/12，源码和目录包的画布助手 E2E 各 1/1。覆盖先读详情后写、缺失节点、修订冲突、部分审批、关闭项目使待审批失效、图像授权与视频派生素材。Worker 在任务落盘后中止，重开按审批回执恢复 watch，混合成败一并回到原会话一次。用户停止后补交结果但不启动后续模型调用。

双入口桌面用例覆盖结构审批、分组与结果定位、移除和重加引用、撤销后显示缺失、视口读取、待审批插话、退出重开和继续查询原供应商 ID。资料功能覆盖内置只读技能、用户提供的公开 HTTPS 文本附件及诊断。公网成功抓取和模型主动检索的门禁差距见 [V1-E2E-02](../../../05-测试与发布/V1-Agent端到端验收规范.md#v1-e2e-02-设置画布双入口-agent-辅助与恢复)。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 核心画布助手纳入 V1 主线，专业域工具随域迁入 | D011 |
| 2026-11-20 | 补录项目作用域、审批恢复及媒体读取边界 | D011、D015 |
| 2026-11-20 | 补录技能、联网附件与诊断导出边界 | D016 |
