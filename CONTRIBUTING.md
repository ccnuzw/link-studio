# 参与 Link Studio 开发

## 工具链与安装

- Node.js：以 `.node-version` 为准，当前为 22.23.0；`package.json` 限定 Node 22。
- pnpm：以 `package.json` 的 `packageManager` 为准，当前为 10.26.2。
- Go：CI 使用 1.26.4，用于构建独立 Provider runner。
- 完整桌面验证：macOS arm64，安装 Xcode Command Line Tools。FFmpeg 首次构建需要网络，随后复用 `.cache/media/`。

```sh
pnpm install --frozen-lockfile
```

工具链升级应在专门的 PR 中修改版本声明、CI 与本文，并完成对应验证。依赖变更提交 `pnpm-lock.yaml`，CI 不自动修复锁文件。

## 本地检查

```sh
pnpm check
pnpm check:desktop
pnpm check:package
```

| 命令                 | 内容                                                                   | 平台                 |
| -------------------- | ---------------------------------------------------------------------- | -------------------- |
| `pnpm check`         | TypeScript、Biome 格式/lint/导入组织、Renderer/Core 模块边界、单元测试 | 通用；CI 使用 Ubuntu |
| `pnpm check:desktop` | 完整构建一次、全部集成测试、Agent 上游回归、Electron E2E               | macOS arm64          |
| `pnpm check:package` | 全部桌面检查，再生成未签名 `.app`，对包内应用运行 E2E                  | macOS arm64          |

集成测试依赖构建产物，因此统一脚本先构建，再复用 `out/`；不重复调用会触发构建的测试命令。桌面脚本检查 JSON 报告，关键 Provider、媒体、Agent、构建产物测试必须存在并通过，集成测试和 E2E 不允许跳过。失败日志在终端或 Actions 日志中，测试报告、截图与失败 trace 在 `test-results/`。

日常修复可先运行定向测试，再运行以上完整检查。涉及真实进程、媒体和崩溃恢复的集成测试及其生命周期钩子使用 30 秒上限，单元测试保留默认上限；不通过重试掩盖失败。行为变化应覆盖用户可观察结果、边界和失败路径；修复问题时添加能复现问题的回归测试。纯文档、格式等变更无需编造测试。

格式修复使用 `pnpm format`，会修改文件，提交前检查 diff。不要提交 `out/`、`release/`、缓存、测试输出、凭证或真实用户数据。

## 提交与 Pull Request

标题与提交信息使用 Conventional Commits，推荐中文描述：

```text
feat(canvas): 支持节点分组
fix(projects): 修复项目重命名后列表未刷新
ci: 增加桌面运行时检查
docs: 补充本地开发说明
```

支持 `feat`、`fix`、`perf`、`refactor`、`docs`、`test`、`build`、`ci`、`chore`、`style`、`revert`。scope 可选，使用小写字母、数字、连字符或斜杠；破坏性变更可使用 `!`，并在 PR 中说明升级方式。

一个 PR 聚焦一个目标。按模板说明为什么改、改了什么、怎么验证、风险与兼容性。界面变化附截图或录屏；项目数据格式、IPC、插件契约变化说明兼容与迁移。未完成的工作使用 Draft。

使用 Squash merge，以 PR 标题作为唯一合并提交标题。清单用于记录作者自检；不适用或未完成的验证如实说明。

## 自动检查与仓库设置

`CI` 在创建/更新 PR、推送 `main` 和手动触发时运行：

1. `PR Title` 工作流：检查 Conventional Commits 标题，标题修改时只重跑这项轻量检查。
2. `CI` 工作流的 `Quality`：Ubuntu 快速检查。
3. `CI` 工作流的 `Desktop macOS ARM64`：快速检查通过后，在 `macos-15` runner 上验证构建、集成、Agent 回归和桌面 E2E；先确认实际架构，云端沙箱、VideoToolbox 与 GUI 能力以首次 Actions 实测为准。

`PR Title` 在 PR 创建、标题编辑和更新提交时校验标题。标题只作为环境变量传入 shell，不会被当作命令执行；该任务无需检出仓库、安装项目依赖或额外配置 Node。

Actions 的 `CI` 页面可选择 **Run workflow → package_smoke**，额外验证未签名 macOS 应用包。它不会签名、公证、发布或上传安装包，正式分发另建发布流程。Windows 与 macOS Intel 仍未列入支持验证范围。

当前仅缓存 pnpm store、Go 缓存与 FFmpeg 编译缓存；FFmpeg 缓存按系统、架构、构建配置和工具链指纹隔离。不缓存 `out/` 或跳过测试。连续推送会取消同一分支的旧检查，报告保留 7 天。工作流不使用发布密钥，第三方 Actions 固定到提交 SHA。

**轻量合并门禁：** 当前仓库套餐不能强制执行私有仓库分支保护，因此 CI 是自动证据，不是假装生效的硬门禁。维护者合并前，在 PR 的 Checks 中确认最新提交对应的 `PR Title`、`CI / Quality`、`CI / Desktop macOS ARM64` 全部通过；有任何一项失败、尚在运行或被跳过，就先修复或说明适用边界，不合并。若又推送了提交，必须检查新提交的结果，不沿用旧绿灯。之后用 Squash merge。单人维护时按同样步骤自检，并可运行 `gh pr checks <PR号> --watch` 查看结果。月度查看 Actions 用量；只有实际超出预算再缩减频率或调整平台。

这些文件提交并推送到 GitHub 后工作流才会运行；PR 模板需要进入默认分支才会在之后的新 PR 中自动填入。首次引入工作流的 PR 可能尚未运行本次新增的检查，合入后由维护者手动运行 `CI` 工作流一次，确认云端环境后再依照上述步骤处理后续 PR。云端首次通过前，不将本机验证记为云端平台验证。
