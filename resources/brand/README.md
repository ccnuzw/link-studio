# 灵可 · Link Studio 应用图标

图标概念为「连接成片」：冰蓝与薄荷青的折叠丝带连接为向右播放的轮廓，表达脚本、素材、镜头在画布中汇合成作品。深靛蓝底座呼应桌面工作台，中央留白保持小尺寸辨识度；图标中不放文字。

- `icon.svg`：可编辑的 1024 × 1024 矢量源稿，包含透明安全边距、圆角底座与柔和投影。
- `../icons/icon.png`：1024 × 1024 透明 PNG，供桌面窗口与开发态 Dock 使用。
- `../icons/icon-{size}.png`：16、32、48、64、128、256、512 像素版本。
- `../icons/icon.icns`：macOS 应用图标，包含标准与 Retina 尺寸。
- `../icons/icon.ico`：Windows 应用图标，包含 16 至 256 像素的六种尺寸。

主色：深靛蓝 `#171F38`、冰蓝 `#B5C4FF`、薄荷青 `#7EEBD8`。应用内品牌标识和页面 favicon 使用同一 SVG。

修改源稿后运行 `pnpm icons:generate`。脚本复用项目已有的 Electron / Playwright 渲染器，不需要额外的图片服务或依赖；macOS 上使用系统 `iconutil` 组装 ICNS，其余平台直接组装 PNG 格式的 ICNS。

生成物随仓库保存，日常开发、构建和打包不需要重新生成。`electron-builder.yml` 分别将 ICNS 和 ICO 用于对应平台的安装包，并将窗口图标复制到打包资源目录。
