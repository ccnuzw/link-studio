# Link Studio 媒体二进制

M0 使用 FFmpeg 7.1.3 原始源码自行构建 macOS arm64 命令行程序，配置与源码 SHA-256 由 `resources/media/build.json` 固定。运行 `pnpm media:build`，需 macOS Command Line Tools、make、tar 和 Node.js。构建缓存保存在 `.cache/media/`，产物为 `out/media/darwin-arm64/`；应用通过 extraResources 复制，运行时无需安装 Homebrew。

构建关闭 GPL、nonfree、version3 和第三方自动发现，不链接 x264/x265 等额外库，H.264 由系统 VideoToolbox 编码，音频使用 FFmpeg 原生 AAC。仅启用白名单组件，禁止网络协议。源程序未修改，具体 flags、版本、二进制 hash 和系统动态库列表随 `build-info.json` 交付。

FFmpeg 此构建适用 LGPL-2.1-or-later；FFmpeg 版权、例外和组件说明以随附 `LICENSE.md`、`COPYING.LGPLv2.1` 和原始源码为准。原始源码压缩包随二进制复制；通过 `build-info.json` 的 configure 数组执行 `sh configure <flags>` 后 `make -j6` 可重建。Link Studio 通过子进程 argv 调用，不把 FFmpeg 库链接进 Electron。正式发布仍须完成许可审查、签名、公证、安全版本评估和目标平台验证。

已排除：`@ffmpeg-installer/darwin-arm64@4.1.5` 以及 eugeneware/ffmpeg-static b6.1.1 的 darwin-arm64 候选，二者实测配置均含 `--enable-nonfree`，不复制入应用，也不登记为已通过分发审查。临时下载的候选只用于核验。

首个实验 profile 为 H.264 VideoToolbox / yuv420p / AAC 48kHz stereo / MP4 faststart，未承诺跨平台编码器与全部输入编码矩阵。输入资产授权、预览 UI 与项目入库仍由后续批次接入。
