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
| `projects.create` | operationId、directoryToken、name | ProjectSession；独占创建，不覆盖已有目录。原会话关闭后重放返回 `PROJECT_NOT_OPEN`，用打开项目入口恢复 |
| `projects.open` | directoryToken | 同窗新开或恢复已有会话返回 `{ disposition: opened, session }`；同实例跨窗激活持有窗口并定位项目，调用方收到 `{ disposition: focusedExisting }`，不视为错误；跨实例写锁冲突返回 `PROJECT_IN_USE` |
| `projects.listRecent` | 无 | displayName、displayPath、recentEntryId、lastOpenedAt；无目录读写权限 |
| `projects.openRecent` | recentEntryId | 由 Main 已知目录重新校验后 open；路径丢失提示重新选择 |
| `projects.getState` | projectHandle | 当前安全快照/恢复摘要；不含 locator、task handle 和凭证 |
| `projects.rename` | MutationContext、name | 新 revision 与 name；只改显示名，不移动目录 |
| `projects.flush` | projectHandle | 当前已提交 revision；失败不关闭/不标 clean |
| `projects.close` | projectHandle | flush 后释放 owner；活动任务先进入退出策略，失败保留窗口 |
| `projects.removeRecent` | recentEntryId | 删除最近入口，不触碰项目目录 |

ProjectSession：`projectHandle/projectId/name/schemaVersion/revision/recoveredFromPrevious`，以及必要的显示信息；不暴露锁 token 或磁盘可写能力。S1 创建返回空 canvas/assets 的 ProjectState DTO。

## 3. S1 资产 API

S1-02 的工作区使用后台导入会话，通过 `window.desktop.projects` 调用项目与资产方法。旧 `importAsset` 保留原 copy 请求与回执语义。

| 方法 | 请求业务字段 | 成功结果/行为 |
| --- | --- | --- |
| `dialogs.selectMedia` | projectHandle、multiSelect | `{ cancelled }` 或 fileToken 列表与安全展示名 |
| `assets.startImport` | MutationContext、fileToken、importMode? | `{ importSessionId }`，启动校验和暂存 |
| `assets.getImport` | projectHandle、importSessionId | 阶段及 `copiedBytes/totalBytes`。终态为 `imported/cancelled/failed`，`duplicate/conflict` 等待提交 |
| `assets.commitImport` | MutationContext、importSessionId、choice? | 重新校验修订与候选后提交同一暂存文件。存在重复时需显式选择 `reuse/independent` |
| `assets.cancelImport` | projectHandle、importSessionId | 最终取消状态；若已经提交返回已完成，不能伪称取消 |
| `assets.list` | projectHandle | 未移除资产与当前设备上的可用状态 |
| `assets.getPreview` | projectHandle、assetId | 窗口绑定、仅本会话可用的本地媒体 URL 和类型；支持视频 range 请求，不接收磁盘路径 |
| `assets.relocate` | projectHandle、assetId、fileToken | hash 一致后原子更新设备 locator。项目修订号和资产 ID 保持原值 |
| `assets.remove` | MutationContext、assetId | 无引用时 tombstone + revision；有引用返回 ASSET_IN_USE |

Renderer 轮询运行时会话。`imported` 返回资产和修订号，`duplicate` 返回候选，`failed` 返回错误码。首次导入可自动提交。遇到冲突或重复项时，用新的提交操作 ID 调用 `commitImport`。已提交回执可重放，取消请求在提交点之后返回 `imported`。`discardMedia` 用于释放尚未进入导入会话的文件授权。

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

使用 `projects.getCanvas`（`link-studio:canvas:get`）及 `projects.applyCanvasOperations`（`link-studio:canvas:applyOperations`）。接口字段、限制和错误码见 [FR-003 接口契约](../03-功能规格/V1/02-画布创作/03-创作画布与节点保存.md#接口契约)。移除素材前先保存当前画布，以已提交引用为准执行删除保护。

操作包括 `putNode`、`removeNode`、`putEdge`、`removeEdge`、`setViewport`。分组通过组节点和成员 `parentId` 在同批操作内调整。撤销重做由 Renderer 生成逆向或正向操作并复用该入口。节点生成输出及选择当前输出的契约由 S4 定义。

核心节点为 `script`、`image`、`video`、`audio`，`group` 提供单层结构容器。UI 状态如 `selected`、`dragging`、`uploadProgress` 留在 Renderer。未知节点及其关联连线通过只读投影呈现，原始记录保留在项目快照。

<a id="provideragent-s3"></a>
### Provider/Agent（S3）

`desktop.settings` 使用 `link-studio:settings:<method>`，仅接受注册窗口的受信主框架；输入 schema 和输出 DTO 见 `packages/link-studio-core/src/settings-api.ts`。`list` 返回配置与插件版本；`draft` 静态校验并保存草稿；`save/disable` 携带 `expectedRevision`，`test` 仅对已启用的同步文本配置试跑。凭证只接受写入，读取返回 `hasSecret`。激活绑定源码 hash、端点和本地网络授权。

`agentList/agentCreate/agentState/agentSend/agentStop/agentContinue` 固定设置作用域，`agentState` 按 `after` 分页读取持久事件并返回待审批和内存流式文本；`agentSend` 用可选 `runId` 插话。`agentDecide` 仅提交审批 ID、所选索引或试跑确认，专用 `agentConfigureSecret` 在 Main 存凭证，Worker 只接收 `configured`。失败返回稳定错误码（如 `SETTINGS_REVISION_CONFLICT`、`AGENT_APPROVAL_STALE`、`PROVIDER_OUTCOME_UNKNOWN`）。项目作用域和真实生成 watch 在 S4 接入。

### 生成（S4）

`projects.listJobs/submitJob/cancelJob/recheckJob`。submit 保存 projectHandle、operationId、nodeId、Provider revision/plugin hash、输入资产和参数快照；网络请求前持久化 job 状态。客户端不得提交 plugin 代码/endpoint/密钥绕过已启用绑定。

| 状态 | 允许后继与依据 |
| --- | --- |
| queued | submitting / cancelled / failed；仅明确未发送可自动恢复提交 |
| submitting | running / downloading / succeeded（文本）/ failed / outcome_unknown；同步错误不等于未受理 |
| running | running / downloading / cancelled / failed / outcome_unknown。取消请求保存在 `cancelRequested`，供应商确认后才标记 `cancelled` |
| downloading | succeeded / failed；失败保留 handle/结果描述，只重试下载，不重发生成 |
| outcome_unknown | 经原任务查询后进入 running/downloading/succeeded/failed/cancelled；不自动生成新任务 |
| succeeded / failed / cancelled | 终态不原地重提交；用户重试建立新 jobId，保留关联 |

任务必须保存精确 pluginId/version/hash、Model Binding 快照、attemptId、是否尝试发送、handle/state、output commit 状态；请求秘密存设备侧 runtime，不写共享正文/日志。媒体输出先落 Blob，再一次提交 AssetRecord + NodeOutputRef + job 成功投影；文本输出作为受限文本结果存入节点历史，不伪造媒体资产。

若节点已删除或其内容已变更，输出仍保存到任务和资产库，跳过自动绑定。恢复使用原任务 ID 和固定插件版本查询；同节点有同类任务未结束时，`recheckJob` 返回 `JOB_CANNOT_RECHECK`，避免两条任务同时写回。

### 画布助手（S4）

`projects.canvasAgent` 通过项目句柄授权，支持 `list/create/state/send/decide/stop/continue/undo/exportDiagnostics`。编辑与生成依据当前画布修订及详情读集，审批提交选中项。生成使用审批 ID 和项索引派生本地任务 ID。项目重开时按任务回执补登记 watch，后台查询绑定原会话的项目。显式关闭项目中止该项目的活跃运行，已提交生成可随项目重开恢复。停止后原会话可补收结果，结果交付不会调用模型。

`send` 的可选 `referenceURL` 只适用于新消息，按 D016 在 Main 读取资料并返回稳定错误 `AGENT_REFERENCE_UNAVAILABLE`。`exportDiagnostics` 按会话 ID 和运行 ID 选择脱敏记录，通过系统对话框导出 JSON，返回 `{ exported: boolean }`。

### 导出（S5）

`projects.exportComposition` 接收 MutationContext、按序的 `videoAssetIds` 和可选 `bgmAssetId/sourceVolume/bgmVolume/profile`。Main 先校验资产，再打开保存对话框并处理覆盖确认，不接收 Renderer 提供的输出路径。指定的背景音乐不存在、已删除或不是音频时返回 `EXPORT_SOURCE_MISSING`，不会静默导出无配乐版本。

`projectEvents.onExportProgress` 订阅按 `operationId` 关联的进度，`projects.cancelMediaTool` 使用原操作 ID 请求取消。成功返回 `{ asset, revision, targetName, exportId }`，派生资产和 composition 配方同快照提交；导出进程不跨重启恢复。参数与验证边界见 [导出规格](../03-功能规格/V1/04-媒体输出/06-基础媒体预览与导出.md)。

## 7. 官方与未来同步边界

上述本地 API 不依赖登录，未来官方任务通过 executionSource/providerBinding 进入相同视图。官方上游凭证、积分结算和价格不由桌面可信声明。服务端代理/短期授权仍是候选方案，S7 前单独 ADR；不得按架构示意图直接实现某一路径。

项目正文只保存稳定领域引用，设备凭证、外部定位符、插件启用授权和任务秘密不进入普通同步清单。V3 再设计空间版本、权限和冲突协议，不在 S1 建假同步接口。
