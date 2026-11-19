---
title: "04 自定义 Provider 配置"
version: V1
feature_id: V1-FR-004
domain: 模型与任务
spec_status: Draft
risk: 高风险
track: 模型与商业化
updated: 2026-11-19
---
# 04 自定义 Provider 配置

## 功能卡

| 项目 | 内容 |
| --- | --- |
| 编号 | V1-FR-004 |
| 领域 | 模型与任务 |
| 规格状态 | Draft |
| 风险等级 | 高风险（密钥、任意端点、数据外发） |
| 上游依赖 | 无 |
| 下游影响 | V1-FR-005 |
| 规格负责人 | 产品/桌面工程/安全 |
| 实现状态 | 见 [V1 实现状态](../../../02-产品与版本/当前版本/V1-实现状态.md) |

## 目标

用户无需登录即可在桌面端配置自有 Provider 和模型，使创作任务可以经本地配置执行，同时保护密钥并清楚展示数据发送目标。

## 功能边界

包含：Provider 插件导入/创建/编辑/校验/启停、连接测试、模型能力声明、密钥更新/删除和安全引用；支持人工编辑及 Agent 辅助生成/修改插件草稿。

不包含：官方模型目录、官方积分、任意服务器端插件和工作室模型层。

## 来源与追踪

- 需求来源：[V1 产品需求](../../../02-产品与版本/当前版本/V1-产品需求.md#v1-首阶段需求)
- 相关决策：D002、D003、D004、D005
- 跨功能验收：V1-E2E-01、V1-NFR-001

## 需求说明

### 用户故事

作为创作者，我希望在本机配置自己的模型服务，以便不登录 Link Studio 也能生成内容。

### 业务规则

1. 插件遵循版本化、可校验的 Provider Plugin API；吸收 video-canvas 的纯转换钩子和宿主网络执行模式（D005）。
2. Provider 非秘密元数据与 Secret 分开保存；Secret 经系统安全存储或等效安全设计保护。
3. 插件不能直接访问网络、文件系统、进程、任意环境变量或 Secret；宿主按受限 Request Descriptor 执行网络请求。
4. 人工输入框短暂持有密钥，经受限 IPC 写入 Main 后清空；后续读取不回显明文，Renderer 不持久化密钥。
5. 配置必须声明支持的能力和模型；不能仅因 API 测试成功就推断其支持图像/视频生成。
6. 本地端点请求可能发送提示词、参考媒体和生成参数；发起连接测试/任务前展示目标端点。
7. Agent 只能创建/修改草稿并执行静态校验、mock 测试；启用插件前用户必须审阅差异并批准。
8. localhost/private LAN 端点按显式用户授权允许；云 metadata 和未经授权的重定向禁止。

### 主流程

1. 用户手工创建/导入插件，或让内置 Agent 根据 API 文档生成插件草稿。
2. Main 对 manifest、API 版本、钩子、静态限制和请求策略进行校验。
3. 用户查看插件代码/Agent 修改差异并启用指定版本；同版本后续任务不重复审批。
4. 用户绑定 Provider endpoint/model 和凭证，Secret 写入安全存储。
5. 用户运行沙箱化连接测试，结果只返回脱敏状态。

### 异常与边界

- safeStorage 不可用时不得静默明文落盘；降级/拒绝策略待定。
- 插件语法/API 版本/能力声明不合法时拒绝启用。
- 插件超时、无限循环、输出超限或返回非 JSON 数据时终止执行并隔离该运行。
- Agent 提议的插件在用户批准前不得执行真实网络请求或访问 Secret。
- URL 包含 userinfo、危险 scheme、云 metadata 或未经授权的 LAN 主机时拒绝/警告。
- 密钥更新失败时旧密钥按原子语义保留或明确失效，策略待定。
- Provider 删除时已有任务引用保留可读历史，但不能再次发起。

### 页面与交互

Provider 设置提供插件列表、API 版本、来源（内置/用户/Agent 草拟）、校验状态、差异审阅、人工代码编辑、模型/端点/能力、密钥输入、连接测试、启用和删除。密钥仅显示已配置/未配置状态。

## 接口契约

IPC 草案：listProviderPlugins、draftProviderPlugin、validateProviderPlugin、approveProviderPlugin、enableProviderPlugin、bindProviderConfig、setProviderSecret、testProviderPlugin、deleteProviderPlugin；最终通道待统一。

| 字段 | 位置 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- | --- |
| providerId | IPC | string | 更新时是 | Main 生成 ID |
| endpoint | IPC | string | 是 | 仅允许协议白名单，具体 host 策略待定 |
| pluginRef | IPC | object | 是 | pluginId、version、sourceHash 指向通过校验的插件版本 |
| secretInput | IPC 请求 | string | 按 Provider | 只用于写入，不返回、不写 settings/project/log |
| models | IPC | array | 是 | modelId 与 capabilities 显式声明 |
| pluginSource | IPC | enum | 是 | builtin / imported / agent_draft |
| approvalToken | IPC | opaque string | 启用时是 | 绑定经用户确认的插件草稿版本和 hash |

### 错误矩阵

| 错误键 | 场景 | 用户提示 |
| --- | --- | --- |
| PROVIDER_CONFIG_INVALID | URL/模型配置不合法 | 检查 Provider 地址和模型设置 |
| PROVIDER_ENDPOINT_BLOCKED | 目标主机不允许访问 | 该地址不符合本地网络安全规则 |
| PROVIDER_SECRET_STORE_UNAVAILABLE | 安全存储不可用 | 无法安全保存密钥，请检查系统安全设置 |
| PROVIDER_TEST_FAILED | 连通/鉴权失败 | 连接测试失败，请检查配置 |

错误码和安全策略待专门冻结。

## 数据与事务

| 数据 | 操作 | 字段 |
| --- | --- | --- |
| Provider Profile | R/W | id、label、endpoint、networkPolicy、models、capabilities、secretRef、revision、createdAt |
| Secret Store | R/W | opaque secretRef -> encrypted credential |
| Plugin Version | R/W | pluginId、apiVersion、version、sourceHash、manifest、source、origin；版本不可变 |
| Plugin Activation | R/W | pluginId、sourceHash、enabled、acceptedAt；绑定启用版本 |
| Model Binding | R/W | bindingId、providerId、modelId、capability、pluginRef、settings |

保存非秘密配置和 secret 引用时需避免出现指向不存在 secret 的半配置；密钥轮换失败不能泄漏旧值。

### 状态与生命周期

插件：`draft -> validating -> review_required -> approved -> enabled/disabled`；校验失败进入 `invalid`。Secret：`unset -> stored -> replaced/deleted`；人工输入提交后 Renderer 只读取已配置状态，不读取明文。

## 验收标准

#### AC01 人工/Agent 创建插件草稿

Given 用户可手工创建或导入插件，或向内置 Agent 提供目标 Provider API 文档。

When 插件代码或草稿生成完成并运行静态校验。

Then 插件被保存为未启用草稿，显示 API 版本、能力、校验结果和来源；未登录也可管理本地插件。

#### AC02 密钥不泄漏

Given Provider 已配置密钥。

When Renderer 请求列表、保存配置或触发测试。

Then API 响应、项目文件、设置 JSON 和应用日志均不包含明文密钥。

#### AC03 不安全端点被处理

Given 用户配置不允许的 scheme、敏感 metadata 地址或不符合策略的主机。

When 保存或测试。

Then 请求在发出前被拒绝并返回可理解错误。

#### AC04 安全存储不可用不降级明文

Given 系统安全存储不可用。

When 用户保存含密钥的 Provider。

Then 明文不落盘，并按冻结策略拒绝保存或提供明确受控替代。

#### AC05 插件无直接网络/文件/密钥权限

Given 一个自定义 Provider 插件正在运行。

When 插件尝试直接访问网络、文件、进程、环境变量或 Secret。

Then 沙箱阻止该操作；仅宿主可执行经策略校验的请求描述，插件不能读到凭证。

#### AC06 未经用户批准的 Agent 草稿不能启用

Given Agent 创建或修改了 Provider 插件草稿。

When 草稿尚未通过用户审阅和批准时请求启用或真实连接测试。

Then 操作被拒绝；用户批准必须绑定所审阅的插件版本/hash，内容变化后批准失效。

#### AC 逐项测试设计

| AC | 验收重点 | 测试层级 | 目标资产 | 目标命令 | 证据状态 |
| --- | --- | --- | --- | --- | --- |
| AC01 | Agent/人工插件草拟与校验 | 集成 | `src/main/services/linkStudio/providerPluginDraft.test.ts` | 待工程结构建立 | 未创建 |
| AC02 | 密钥泄漏面 | 单元/集成 | `src/main/services/linkStudio/providerSecrets.test.ts` | 待工程结构建立 | 未创建 |
| AC03 | URL/host policy | 单元 | `src/main/services/linkStudio/providerAddressPolicy.test.ts` | 待工程结构建立 | 未创建 |
| AC04 | safeStorage failure | 集成 | `src/main/services/linkStudio/providerSecrets.test.ts` | 待工程结构建立 | 未创建 |
| AC05 | 沙箱权限 | 单元/集成 | `packages/link-studio-core/src/providers/pluginSandbox.test.ts` | 待工程结构建立 | 未创建 |
| AC06 | 审批/hash 绑定 | 集成 | `src/main/services/linkStudio/providerPluginApproval.test.ts` | 待工程结构建立 | 未创建 |

## 技术设计

详见 [04 自定义 Provider 配置技术设计](04-自定义-Provider-配置-技术设计.md)。

## 实现与验证

### 工程落点

已建 `packages/provider-runtime/src/{runner,plugin,host}.ts`、独立 Go runner 与 `resources/provider-plugins/` 固定样本；Main Registry、SecretStore、IPC 和设置/Agent 工具尚待接入。

### 当前差距

详见 [Provider 插件与 Agent 配置设计](../../../04-技术架构/Provider-插件与-Agent-配置设计.md#8-m0-02-实现范围与兼容缺口)。M0-02 仅覆盖本机 mock、部分清单/钩子、隔离与 hash 检查；尚未覆盖任何完整配置用户 AC，表中正式资产保留未创建。人工/Agent 草拟、启用审批持久化、localhost/LAN 授权和 safeStorage 仍须后续验证，规格保持 Draft。

### 验证记录

#### 2026-11-19 M0-02 Runtime 切片

macOS arm64、Go 1.26.4；`pnpm test:provider`，18/18 本地通过。涵盖 AC01/02/03/05/06 的底层部分路径，未验证完整用户流程、系统凭证存储或生产网络。目录包内 runner 复跑相同测试通过，固定源/hash 与准确命令见 [M0-02 实测记录](../../../04-技术架构/实施基线与开发批次.md#9-m0-02-实测记录)。样本为本地合成 mock，不等于真实供应商验证。

#### 2026-11-19 规格基线核验

静态文档核验，无密钥安全测试证据。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 回写 M0-02 插件兼容切片及待建业务验收路径 | D002、D004、D005 |
| 2026-11-19 | 初始 Draft | D002、D003、D004 |
