---
title: "04 自定义 Provider 配置"
version: V1
feature_id: V1-FR-004
domain: 模型与任务
spec_status: Draft
risk: 高风险
track: 模型与商业化
updated: 2026-11-22
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

版本详情逐版统计绑定模型，含离线模型；进入版本历史才取名称，读取失败不解除删除保护。最多显示八个名字，有渠道的模型可键盘跳转，无渠道时显示文本。定价支持按次、按秒或 Token，按秒须有数字时长参数；非 Token 价格分统一和规格两个模式。规格成本只在管理侧可见，不影响对外报价。参见[分项行为与双尺寸对照](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

开启 Token 成本后须至少填一侧，显式 0 有效，保存时未填一侧按 0。输入、输出分别显示利润率，成本不改变创作端预估或冻结额。

内置 OpenAI 配置支持独立的「检测小灵连接」。检测使用已保存的端点、接口与模型，确认时显示目标和计费提示。用户可以先检测流式文本，再通过「允许小灵使用此模型」授权日常会话。

## 接口契约

IPC 草案：listProviderPlugins、draftProviderPlugin、validateProviderPlugin、approveProviderPlugin、enableProviderPlugin、bindProviderConfig、setProviderSecret、testProviderPlugin、deleteProviderPlugin；最终通道待统一。

`settings.agentTestConnection({ id, expectedRevision })` 在 Main 内验证一次短文本流。成功返回 `{ tested: true, durationMs }`。失败返回稳定错误码，区分凭证拒绝、限流、网络错误、超时、流无效和修订冲突。

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
| AC01 | Agent/人工插件草拟与校验 | 集成/E2E | `src/main/settings/registry.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |
| AC02 | 密钥泄漏面 | 集成/E2E | `src/main/settings/registry.ts`、`src/main/settings/stream.ts`、`tests/integration/settings.test.ts` | `pnpm exec vitest run --project integration tests/integration/settings.test.ts` | 本地通过 |
| AC03 | URL/host policy | 集成 | `src/main/settings/network.ts`、`tests/integration/settings.test.ts` | `pnpm exec vitest run --project integration tests/integration/settings.test.ts` | 本地通过 |
| AC04 | safeStorage failure | 集成/E2E | `src/main/settings/ipc.ts`、`tests/e2e/settings.spec.ts` | `pnpm check:package` | 本地通过 |
| AC05 | 沙箱权限 | 集成 | `packages/provider-runtime/src/runner.ts`、`tests/integration/provider-runtime.test.ts` | `pnpm test:provider` | 本地通过 |
| AC06 | 审批/hash 绑定 | 集成/E2E | `src/main/settings/registry.ts`、`packages/agent-runtime/src/settings-gateway.ts`、`tests/integration/settings.test.ts` | `pnpm check:package` | 本地通过 |

## 技术设计

详见 [04 自定义 Provider 配置技术设计](04-自定义-Provider-配置-技术设计.md)。

## 实现与验证

### 工程落点

已建 `packages/provider-runtime/src/{runner,plugin,host}.ts`、独立 Go runner 与 `resources/provider-plugins/` 固定样本；Main Registry、safeStorage、网络地址策略、受信 IPC 和设置 Agent 工具已接入。

### 当前差距

详见 [Provider 插件与 Agent 配置设计](../../../04-技术架构/Provider-插件与-Agent-配置设计.md#8-m0-02-实现范围与兼容缺口)。本地证据覆盖手工配置、回环试跑、插件 hash/端点重新授权、safeStorage、跨源/重定向拒绝和脱敏流；真实供应商、其他平台及发布签名仍待验证。

### 验证记录

2026-11-23 更新。渠道拉取导入按上游型号生成公开 key，重名加渠道前缀和序号，通知显示冲突数。中途失败后重试只写入剩余项。桌面项目使用内部模型 ID 定位历史绑定。文本／Agent 的窗口与最大输出优先取已授权渠道目录，仅两项均空时自动填。媒体建议由用户手动应用，视频建议限 Gemini。目录拒绝、缺 Key 或规格无效时回退内置库。回环测试覆盖 4 MiB／2000 条边界及普通插件响应限额，五种拉取状态和两种规格提示均有宽窄截图。见[逐项证据](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

2026-11-22：模型配置的语法、对象类型、草稿保存和可执行性分别判断。离线标准正文可保留顶层／嵌套未知键；历史顶层 `params` 不作错误。文本或 Agent 已填最大输出低于 256、或不小于上下文窗口，同样允许存为带问题的草稿。最大窗口 1000 万、最大输出 100 万。编辑中可返回表单，改动合并回原文。带问题的草稿不能上线、试跑或正式生成。格式错误、正文与现有模型标识不符、非法渠道或插件绑定仍不能写入；没有声称支持任意半成品。

主进程只依据通过校验的正文字段构造运行配置。原文及合并基线用系统密钥库加密，随模型修订在同一 SQLite 事务内写入；加密失败、修订冲突时不改变模型，删除模型级联清理。列表和 Agent 查询不回传原文；设置编辑器按标识与修订单独读取。批量修改按已存原文合并目标字段，不覆盖未知键。见[实测与复现命令](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

2026-11-22：试跑追踪可只读刷新；不重提任务、不发送供应商请求、不重新授权预览。请求描述失败时保留输入；运行器不可用时进入请求描述页，其他错误以通知反馈，不清除上次预览。模型编辑表单页脚与原版一致；桌面用户可点击标题下的模型标识（键盘 Tab 后回车）直接打开 JSON。保存时在当前模式定位协议设置及定价条件。见[原版与桌面的操作和像素证据](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

2026-11-22：模型试跑的请求描述仅格式化主进程允许展示的字段；不重取原始请求头、查询参数或 multipart 文件内容。默认展开，超出 12 行或 1500 字符时可用键盘收起及展开。普通鉴权的业务失败直接显示已清洗原因，自定义鉴权及旧结果仅给通用反馈。插件批量升级分别检查在线模型和离线渠道草稿；允许离线模型保存不兼容的版本引用，不等同于授予执行权，修复前不能上线或试跑。复现命令、两种尺寸及保留差异见[最新增量验收](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

2026-11-22：复验模型批处理五类操作的两个进度、JSON 错误定位与未命名草稿返回、重复版本重新上传和插件升级不兼容原因。自定义鉴权的请求预览和失败追踪不显示私有 URL 路径。双窗口截取范围、命令及与原版不一致处见[逐项证据](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

#### 2026-11-22 插件版本与本机草稿

模型编辑的厂商搜索在选中时保留、Esc 时清空。点击标签文字不移除，删除按钮和空框退格可移除。新建模型排序清空取 0。JSON 格式化和保存失败弹通知，不覆盖原文或写入有效旧配置；切回表单失败另保留行内提示，退出统一走未保存确认。桌面直接打开 JSON 与严格校验属于可见差异，不计作原版功能。

插件确认失败时，生成记录保留稳定错误码，普通鉴权的结果级错误另附清洗后的可读原因；自定义鉴权、不可安全展示的内容和旧记录均回退。明确失败或取消的任务不可按未知结果复查。渠道删除遇并发新增引用时须重新检查；迁移成功通知与单项错误分开显示。见[本机对照及回归记录](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

发行清单非空且全部条目校验 SHA-256、预检和登记成功后，启动时自动清理已撤包、全部版本均来自内置发行且没有模型或在途任务引用的插件。单组清理与系统审计原子提交。恢复档案只能供有原始绑定的既有任务使用，不向新任务提供已撤包的协议。详见[撤包与旧工程恢复证据](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

删除整组使用插件 key 而不是展示名或打开时的版本哈希；删除单个历史版本使用 key + 版本号。界面预检不授予删除权，主进程提交时重新检查所有相关模型（包括离线模型）和非终态任务。预检失败可重试；删除被并发引用阻断时保留错误并重查，引用链接可用键盘进入模型编辑。整组删除成功显示通知；单版本成功只刷新历史。行为与宽窄窗口对照见[逐项复验 P6](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

插件级停用确认显示全部固定模型和其中已上线的模型数；停用和重新启用以 key 为目标。升级入口点击时重新读取引用用于预览；确认与重试在主进程按同一 key 和当时的版本、绑定状态执行，不使用浏览器传入的目标版本或旧模型清单。已提交任务仍按旧绑定运行。部分失败留在确认框，逐项给出原因；成功通知显示本次实际升级数而非累计数。参见下方逐项复验的 P4、P5 证据。

模型设置 → 适配器管理 → 顶栏「插件草稿」可选择已上传版本、审阅和编辑源码、执行离线样例并保存。版本历史保留为只读版本号，显示模型引用与允许的版本操作。覆盖 AC01 的手动编辑路径、内置标识保护及升级部分失败后的原绑定保留；测试命令、对照图和仍未验收的行为见[逐项复验](../../../04-技术架构/Provider与插件复刻差异审查.md#最新增量验收)。

#### 2026-11-20 小灵流式连接

macOS arm64 使用普通 Electron 和开发版设置的加密快照，通过 `settings.agentTestConnection` 调用既有 `magpie` Responses 配置。一次无工具请求收到完整文本流，耗时 5533 ms。检测界面提供供应商计费提示，实际费用可在供应商控制台核对。

`pnpm exec vitest run --project integration tests/integration/settings.test.ts` 6/6 通过，覆盖认证拒绝、限流、非流式响应、断流、超时、跨帧凭证脱敏、并发检测和修订冲突。`pnpm exec playwright test tests/e2e/settings.spec.ts --reporter=line` 2/2 通过，覆盖两种协议的设置界面与 Responses 只读工具回合。真实供应商的工具回合、视觉和恢复另行验收。

#### 2026-11-19 M0-02 Runtime 切片

macOS arm64、Go 1.26.4；`pnpm test:provider`，18/18 本地通过。涵盖 AC01/02/03/05/06 的底层部分路径，未验证完整用户流程、系统凭证存储或生产网络。目录包内 runner 复跑相同测试通过，固定源/hash 与准确命令见 [M0-02 实测记录](../../../04-技术架构/实施基线与开发批次.md#9-m0-02-实测记录)。样本为本地合成 mock，不等于真实供应商验证。

#### 2026-11-19 规格基线核验

静态文档核验，无密钥安全测试证据。

#### 2026-11-20 S3 本地验收

macOS arm64/APFS：`pnpm check:package` 通过，含 90 项集成测试、源码版和未签名目录包各 9 项桌面 E2E；`tests/integration/settings.test.ts` 3/3 通过，覆盖安全存储失败保留旧值、陈旧 revision/hash、网络策略及两次 Worker 启动回执对账；`tests/e2e/settings.spec.ts` 覆盖真实 Electron safeStorage、手工保存、回环试跑、逐项审批、凭证专用卡、插话、停止和重启历史恢复。仅使用本机回环服务，不宣称真实供应商或 V1-E2E-02 通过。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-22 | 区分 JSON 语法、对象投影与修订保存，记录扩展字段及非对象双尺寸对照 | D002、D004 |
| 2026-11-22 | 回填请求描述、失败修复报告与离线不兼容版本的升级／执行边界 | D002、D004 |
| 2026-11-22 | 补录批处理、JSON 草稿、上传和升级逐项失败以及鉴权日志边界 | D002、D004 |
| 2026-11-22 | 补录模型编辑器厂商、标签交互及 JSON 格式化、保存和退出的错误反馈 | D002、D004 |
| 2026-11-22 | 明确历史引用名单的读取、删除保护与跳转边界；补充定价模式与时长条件 | D002、D004 |
| 2026-11-22 | 回写发行撤包、任务结果失败文案和渠道迁移复查的本机证据 | D002、D004 |
| 2026-11-20 | 增加独立的小灵连接检测和真实 Responses 流式证据 | D014 |
| 2026-11-19 | 回写 M0-02 插件兼容切片及待建业务验收路径 | D002、D004、D005 |
| 2026-11-19 | 初始 Draft | D002、D003、D004 |
