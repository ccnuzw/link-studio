# 桌面 API 与任务契约

API version 1；通道以 `link-studio:<domain>:<method>` 注册，Renderer 仅使用 `window.linkStudio.<domain>.<method>`。本文区分 S1 的确定接口与后续批次必须细化的域接口；运行时 schema 与类型从 core 同一来源生成/导出。

## 1. 公共请求与响应

每次变更携带 `requestId`、`operationId`；项目变更另带 `projectHandle` 与 `expectedRevision`。请求 ID 用于一次 IPC 关联，operationId 用于逻辑幂等；重试逻辑操作不换 operationId。所有参数先做大小与 schema 校验，再检查 sender/webContents 与资源授权。

```typescript
type Result<Value> =
  | { ok: true; requestId: string; value: Value }
  | { ok: false; requestId: string; error: {
      code: string; retryable: boolean; messageKey: string;
      details?: Record<string, string | number | boolean>;
    } };

type MutationContext = {
  requestId: string;
  operationId: string;
  projectHandle: string;
  expectedRevision: number;
};
```

Result 不返回 stack、明文密钥、任意文件系统路径或供应商原始响应。字段 schema 拒绝多余控制字段、非有限数、原型注入和超过限制的数组/字符串。mutation 由 Main 推断 owner，Renderer 不提交可信 owner 或权限值。

系统对话框返回随机 opaque token（文件/目录/输出目标）；token 绑定窗口、动作、选定资源和 10 分钟有效期。主进程不能接受 Renderer 任意绝对路径。外部引用在提交前将 token 解析成设备 locator；系统“取消选择”返回成功结果 `{ cancelled: true }`，不是业务错误。

## 2. S1 项目 API

| 方法 | 请求业务字段（公共字段省略） | 成功结果/行为 |
| --- | --- | --- |
| `dialogs.selectProjectParent` | 无 | `{ cancelled }` 或 `{ directoryToken, displayPath }` |
| `dialogs.selectProject` | 无 | 选定项目的 directoryToken |
| `projects.create` | operationId、directoryToken、name | ProjectSession；独占创建，不覆盖已有目录 |
| `projects.open` | directoryToken | `{ disposition: opened, session }` 或 `{ disposition: focusedExisting }`；别实例占用返回错误 |
| `projects.listRecent` | 无 | displayName、displayPath、recentEntryId、lastOpenedAt；无目录读写权限 |
| `projects.openRecent` | recentEntryId | 由 Main 已知目录重新校验后 open；路径丢失提示重新选择 |
| `projects.getState` | projectHandle | 当前安全快照/恢复摘要；不含 locator、task handle 和凭证 |
| `projects.rename` | MutationContext、name | 新 revision 与 name；只改显示名，不移动目录 |
| `projects.flush` | projectHandle | 当前已提交 revision；失败不关闭/不标 clean |
| `projects.close` | projectHandle | flush 后释放 owner；活动任务先进入退出策略，失败保留窗口 |
| `projects.removeRecent` | recentEntryId | 删除最近入口，不触碰项目目录 |

ProjectSession：`projectHandle/projectId/name/schemaVersion/revision/recoveredFromPrevious`，以及必要的显示信息；不暴露锁 token 或磁盘可写能力。S1 创建返回空 canvas/assets 的 ProjectState DTO。

## 3. S1 资产 API

| 方法 | 请求业务字段 | 成功结果/行为 |
| --- | --- | --- |
| `dialogs.selectMedia` | projectHandle、multiSelect | `{ cancelled }` 或 fileToken 列表与安全展示名 |
| `assets.import` | MutationContext、fileToken、importMode? | `{ importSessionId }`；创建长任务，不代表资产已提交 |
| `assets.getImport` | projectHandle、importSessionId | 当前阶段、进度；终态为 imported/reused/cancelled/failed，或等待用户的 duplicate/conflict |
| `assets.resolveDuplicate` | MutationContext、importSessionId、choice: reuse/independent | 完成导入；reuse 必须匹配候选 hash；新变更 revision 不一致先刷新重试 |
| `assets.commitImport` | MutationContext、importSessionId | 对已复制且等待提交的会话重新校验/提交，返回 asset 与 revision；不得绕过去重选择 |
| `assets.cancelImport` | projectHandle、importSessionId | 最终取消状态；若已经提交返回已完成，不能伪称取消 |
| `assets.list` | projectHandle、mediaType?、cursor?、limit? | 可分页资产 DTO，limit 默认 100、最大 500 |
| `assets.getPreview` | projectHandle、assetId | 窗口绑定、仅本会话可用的本地媒体 URL 和类型；支持视频 range 请求，不接收磁盘路径 |
| `assets.relocate` | MutationContext、assetId、fileToken | hash 一致后更新设备 locator，返回可用状态；不一致返回错误 |
| `assets.remove` | MutationContext、assetId | 无引用时 tombstone + revision；有引用返回 ASSET_IN_USE |

长导入用单独 importSessionId 与进度事件，不阻塞 Renderer。`assets.getImport` 在 imported/reused 时返回 `{ asset, revision }`，duplicate 时返回 candidateAssetIds，failed 时返回安全错误。会话进度存在于 runtime，只有入库提交才改变项目 revision。提交时 revision 已变化则进入 conflict，刷新后调用 `assets.commitImport`（MutationContext + importSessionId）重新校验并提交同一暂存文件；不重新复制。`resolveDuplicate` 按同一规则提交。开始复制的 operationId 和最终提交的 operationId 分开，成功结果持久化去重回执；取消若已越过快照提交点则返回 imported，不回滚既有提交。

## 4. 事件与一致性

事件信封为 `{ sessionId, sequence, projectId, revision?, type, payload }`；type 白名单包括 `project.committed`、`project.saveFailed`、`asset.importProgress`、`asset.availabilityChanged`、`job.changed`、`export.changed`。payload 不含明文凭证/任务秘密。

Preload `subscribe` 返回 unsubscribe 函数；销毁窗口、关闭项目或换 handle 时清理。仅向持有该项目会话的窗口发送。订阅后读取 getState，并按 revision 过滤旧提交；发现 sequence 缺口/进程重启时重新取状态和任务列表，不要求重放无限事件日志。序列只在同 session 内有意义，revision 决定持久状态。

保存失败保留 Renderer dirty buffer；成功事件不将用户未提交的更新误标已保存。项目所有修改进入同一协调器；API 不接受 Renderer 提交整个磁盘状态覆盖后台任务结果。

## 5. S1 错误键

以下 code 为首批统一来源，直接使用字符串，不再保留“待定数字编号”。用户提示由 messageKey 本地化。

| code | 条件 | 自动重试 |
| --- | --- | --- |
| VALIDATION_FAILED / PAYLOAD_TOO_LARGE | 请求 schema/大小不合法 | 否 |
| OPERATION_ID_REUSED | 同幂等 ID 请求内容不一致 | 否 |
| TOKEN_INVALID_OR_EXPIRED | 文件/目录句柄无效、跨窗口或过期 | 否，重新选择 |
| PROJECT_NAME_INVALID / PROJECT_TARGET_EXISTS | 显示名不合法/目标目录已存在 | 否 |
| PROJECT_PATH_DENIED / PROJECT_LOCATION_UNSUPPORTED | 未授权路径/不支持的文件系统 | 否 |
| PROJECT_NOT_OPEN / PROJECT_IN_USE | 无当前会话/另实例占用 | 否 |
| PROJECT_SCHEMA_UNSUPPORTED / PROJECT_CORRUPT | 不支持版本/无有效恢复状态 | 否 |
| PROJECT_SAVE_FAILED / PROJECT_CONFLICT | 持久化失败/expectedRevision 不一致 | 先检查磁盘或刷新 revision，不盲重放 |
| ASSET_PATH_DENIED / ASSET_TYPE_UNSUPPORTED / ASSET_SIZE_LIMIT | 文件权限/类型/工程资源限制 | 否 |
| ASSET_READ_FAILED / ASSET_STORAGE_FAILED | 读取、探测、复制或提交失败 | 用户修复后用原 operationId 核对/重试 |
| ASSET_NOT_FOUND / ASSET_MISSING / ASSET_REFERENCE_CHANGED | 无资产记录/外部文件缺失/内容变化 | 否，重新定位或另行导入 |
| ASSET_IN_USE | 当前快照或运行任务仍引用 | 否，显式解除引用 |
| IMPORT_SESSION_NOT_FOUND | 无此窗口可用导入会话或已过期 | 否，先核对已提交资产再重新选择 |

## 6. 后续域契约与状态机

### 画布（S2）

`canvas.read`、`canvas.applyOperations`、`canvas.undo`、`canvas.redo`；apply 带 MutationContext 和原子操作列表，首批操作是 add/update/removeNode、add/removeEdge、setGroup、setViewport。update 仅允许该节点 schema 字段，不能写任意 JSON 路径。节点输出引用由任务服务追加；用户选择当前输出是独立操作。

首批 script/image/video/audio，group 是结构容器，不冒充供应商能力。position、parentId、连线端口与兼容规则沿用上游后写明确 mapper；UI 状态如 selected/dragging/uploadProgress 不落盘。未知节点以不可编辑占位保留原始 data/关联；保存其他节点不能删除它。S2 进入 Ready 前补充各操作 union、端口规则、undo 合并和快照样例；这些不是 S1 的阻塞。

### Provider/Agent（S3）

`providers.list/bind/setSecret/test`、`plugins.list/draft/validate/activate/disable`、`providerAssistant.start/send/stop`。具体上下文、钩子兼容和权限见 [插件设计](Provider-插件与-Agent-配置设计.md)。setSecret 只接受一次输入，返回 hasSecret；本机安全存储不可用时拒绝密钥写入，不落明文。激活绑定精确 sourceHash；普通任务不重复审批。

设置 Agent 不限插件草拟：当前页上下文、模型/配置诊断、变更单、逐项决定、安全密钥和真实试跑均纳入 FR008；人工路径独立。共享 API 的 scope、流模型、durable receipt/审批/watch 以 [完整设计](内置Agent完整迁移设计.md)和 FR007～009 为准。S3 前落实工具 schema、费用提示和引擎/认证兼容。

### 生成（S4）

`jobs.submit/cancel/retry/get/list`。submit 保存 projectHandle、operationId、nodeId?、modelBindingId、输入资产和参数快照；网络请求前持久化 attempt 状态。客户端不得提交 plugin 代码/endpoint/密钥绕过已启用绑定。

| 状态 | 允许后继与依据 |
| --- | --- |
| queued | submitting / cancelled / failed；仅明确未发送可自动恢复提交 |
| submitting | running / downloading / succeeded（文本）/ failed / outcome_unknown；同步错误不等于未受理 |
| running | running / downloading / succeeded（文本）/ cancelling / failed / outcome_unknown |
| cancelling | cancelled（供应商确认）/ running / downloading / outcome_unknown；本地停止轮询不能宣布供应商已取消 |
| downloading | succeeded / failed；失败保留 handle/结果描述，只重试下载，不重发生成 |
| outcome_unknown | 经原任务查询后进入 running/downloading/succeeded/failed/cancelled；不自动生成新任务 |
| succeeded / failed / cancelled | 终态不原地重提交；用户重试建立新 jobId，保留关联 |

任务必须保存精确 pluginId/version/hash、Model Binding 快照、attemptId、是否尝试发送、handle/state、output commit 状态；请求秘密存设备侧 runtime，不写共享正文/日志。媒体输出先落 Blob，再一次提交 AssetRecord + NodeOutputRef + job 成功投影；文本输出作为受限文本结果存入节点历史，不伪造媒体资产。

若节点已删除，结果仍进入资产/任务历史，不自动复活节点；多个任务完成只追加结果，不覆盖当前 prompt 或后续编辑。恢复使用原版本查询；版本缺失/不兼容暂停并提示环境修复。取消/查询能力、超时、并发与重试参数随本批支持插件冻结；S4 前补转移测试和下载/入库补偿样例。

### 导出（S5）

`exports.start/cancel/get/list`；start 带 MutationContext、按序视频 assetIds、可选 bgmAssetId、受限 audioMix/profile 和 outputTargetToken。服务保存不可变配方并 pin 输入，调用受控 FFmpeg；schema 与音频基线见 [导出规格](../03-功能规格/V1/04-媒体输出/06-基础媒体预览与导出.md)。M0 已验证 macOS H.264 VideoToolbox/AAC 的 `hd-720p` 和测试用 `m0-360p`；完整参数及限制以 [媒体技术设计](../03-功能规格/V1/04-媒体输出/06-基础媒体预览与导出-技术设计.md#m0-04-实现基线与待接入边界)为准。内部路径接口不得直接暴露给 Renderer；持久任务、Asset ID 映射和覆盖确认仍待 S5 接入。

## 7. 官方与未来同步边界

上述本地 API 不依赖登录，未来官方任务通过 executionSource/providerBinding 进入相同视图。官方上游凭证、积分结算和价格不由桌面可信声明。服务端代理/短期授权仍是候选方案，S7 前单独 ADR；不得按架构示意图直接实现某一路径。

项目正文只保存稳定领域引用，设备凭证、外部定位符、插件启用授权和任务秘密不进入普通同步清单。V3 再设计空间版本、权限和冲突协议，不在 S1 建假同步接口。
