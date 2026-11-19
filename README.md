# 灵可 · Link Studio

本地优先的视频创作生产工具，内置创作助手 **小灵**。

以 [video-canvas](https://github.com/zaylora/video-canvas) 的创作业务为迁移基础，选择性吸收 [Fynvra](https://github.com/LAIJiangFeng/fynvra) 的桌面基础设施与工程规范。目标覆盖原项目的主线及主要功能，并按桌面端边界分阶段实现。

## 产品方向

- 项目默认保存在本机，本地项目和自定义模型无需登录即可使用。
- 支持用户自定义 Provider 插件与模型；官方账号、官方模型和积分消费后续独立接入。
- 小灵在设置与创作画布中辅助配置、编辑与生成任务，两入口共享持久运行引擎。
- 分阶段迁移画布、资产、生成任务、媒体输出、角色、分镜、短剧、营销及 3D 导演台。
- 后续支持用户主动创建共享空间及跨设备继续创作，组织能力由官方服务提供。

产品命名以 [D012](docs/06-决策记录/冻结决策.md#d012-产品与内置-agent-命名) 为准：中文名“灵可”，英文名“Link Studio”，仓库及工程目录名 `link-studio`，内置 Agent 名“小灵”。

## 当前阶段

当前处于 **M0 工程搭建与技术验证**，M0-01～05 已完成 macOS arm64 本机范围验证，包含桌面工程、项目存储、Provider mock、媒体导出与小灵共享引擎。上述服务尚未接入完整用户流程；当前界面关闭后不会保存节点。素材导入、真实模型生成和小灵双入口界面仍待实现。

技术栈为 Electron + React + TypeScript、typed IPC；小灵保留原 Pi Durable engine/store，以独立 Worker、SQLite 和 QuickJS 运行，后续接入真实业务服务。版本和验证范围见实施基线。

## 本地运行

使用 Node.js 22（最低 22.19.0）、pnpm 10.26.2；构建和集成测试另需 Go 1.26 或更高版本，用于编译独立 Goja 插件 runner：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

检查命令为 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:integration` 和 `pnpm test:e2e`。构建集成测试读取 `out/`，需先构建。

`pnpm test:provider` 编译 runner 并运行 Provider mock 测试；`pnpm provider:build` 仅编译 runner。当前隔离执行仅开放 macOS，其他平台返回 `SANDBOX_UNAVAILABLE`。测试网络仅允许明确列出的 `127.0.0.1` origin，不代表正式公网/LAN 模型适配已经接通；运行已打包应用不要求用户安装 Go。

`pnpm media:build` 从 SHA-256 固定的 FFmpeg 7.1.3 源码构建无 GPL/nonfree 的最小 LGPL 媒体程序，首次构建需要网络与 macOS Command Line Tools（clang/make/tar），后续使用 `.cache/media/` 缓存；`pnpm test:media` 运行真实合成测试。当前构建仅验证 macOS arm64，使用系统 H.264 VideoToolbox 和原生 AAC；二进制、源码、许可与构建清单随应用复制，运行不依赖 Homebrew。

`pnpm package:mac` 生成 `release/mac-arm64/灵可.app`（当前 Apple Silicon 主机）；这是未签名的本地目录包，已验证启动，不是正式分发安装包。Windows 与 macOS Intel 尚未验证。

`pnpm test:agent` 验证小灵共享引擎：9 项本地集成与 144 项迁入上游回归；`pnpm agent:build` 构建包内 Worker/QuickJS。使用回环 mock 模型与合成目标，不要求云服务或真实凭证；审批、插话、watch 和恢复的证据边界见 [Agent runtime 说明](packages/agent-runtime/README.md)。

## 开发入口

- [文档中心](docs/README.md)
- [实施基线与开发批次](docs/04-技术架构/实施基线与开发批次.md)
- [上游能力迁移台账](docs/04-技术架构/上游能力迁移台账.md)
- [子能力补充与渐进落盘计划](docs/04-技术架构/子能力补充与渐进落盘计划.md)
- [版本进入开发门禁](docs/02-产品与版本/版本进入开发门禁.md)
- [V1 实现状态](docs/02-产品与版本/当前版本/V1-实现状态.md)

复用上游代码、媒体、字体及 3D 资源时，逐项记录来源并保留适用的许可声明。
