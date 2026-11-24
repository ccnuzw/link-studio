import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { runMediaProcess } from "../../packages/media-runtime/src/process";
import { desktopElectron as electron } from "./desktop-window";
import {
  addCanvasNode,
  chooseCanvasZoom,
  createCanvasProject,
  editTextNode,
  projectAction,
} from "./workspace-actions";

test("桌面启动、画布交互与受限 IPC", async () => {
  const userData = await mkdtemp(join(tmpdir(), "link-studio-e2e-"));
  const mediaPath = join(userData, "e2e.png");
  const audioPath = join(userData, "e2e.wav");
  const videoPath = join(userData, "e2e.mp4");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
    "base64",
  );
  const waveHeader = Buffer.from(
    "52494646a43e000057415645666d74201000000001000100401f0000803e00000200100064617461803e0000",
    "hex",
  );
  await writeFile(mediaPath, png);
  await writeFile(audioPath, Buffer.concat([waveHeader, Buffer.alloc(16_000)]));
  await runMediaProcess(join(process.cwd(), "out/media/darwin-arm64/ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=64x48:r=24:d=1",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LINK_STUDIO_TEST_USER_DATA: userData,
    LINK_STUDIO_TEST_PROJECT_PARENT: userData,
    LINK_STUDIO_TEST_MEDIA_FILES: `${mediaPath}\n${audioPath}\n${videoPath}`,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.LINK_STUDIO_MEDIA_BINARIES;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
    env: environment,
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const packaged = await application.evaluate(({ app }) => app.isPackaged);
    expect(packaged).toBe(Boolean(executablePath));
    await expect(page.locator(".home-brand img")).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".home-brand img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1024);
    await expect(page.getByRole("heading", { name: "创作工作台" })).toBeVisible();
    await createCanvasProject(page);
    await expect(page.getByRole("heading", { name: "从一个节点开始" })).toBeVisible();
    await page.getByRole("button", { name: "打开小灵" }).click();
    await expect(page.getByRole("button", { name: "历史会话，当前：新对话" })).toBeVisible();
    await page.screenshot({ path: "test-results/canvas-assistant.png" });
    await page.getByRole("button", { name: "关闭小灵" }).click();
    await expect(page.getByRole("button", { name: "历史会话，当前：新对话" })).toBeHidden();
    await page.getByRole("button", { name: /^文本 脚本、分镜描述/ }).click();
    await editTextNode(
      page.getByRole("region", { name: "文本内容", exact: true }),
      "一段等待被拍成电影的故事",
    );
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByText("e2e.png", { exact: true })).toBeVisible();
    await expect(page.getByText("image · 3×2")).toBeVisible();
    await expect(page.getByText("e2e.wav", { exact: true })).toBeVisible();
    await expect(page.getByText("audio · 1.0 秒")).toBeVisible();
    await expect(page.getByTitle("e2e.mp4")).toBeVisible();
    await page.getByRole("button", { name: "导入素材" }).click();
    await expect(page.getByText("e2e.png 已存在")).toBeVisible();
    await page.getByRole("button", { name: "跳过此文件" }).click();
    await expect(page.getByText("e2e.wav 已存在")).toBeVisible();
    await page.getByRole("button", { name: "复用现有素材" }).click();
    await expect(page.getByText("e2e.mp4 已存在")).toBeVisible();
    await page.getByRole("button", { name: "保留独立记录" }).click();
    await expect(page.getByRole("button", { name: "导入素材" })).toBeEnabled();
    await expect(page.locator(".asset-item")).toHaveCount(4);
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await addCanvasNode(page, "图片生成");
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await addCanvasNode(page, "视频生成");
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const videoNode = page
      .locator(".react-flow__node")
      .filter({ has: page.locator("header strong").filter({ hasText: /^视频$/ }) });
    await videoNode.locator("header strong").click();
    const composer = page.getByRole("region", { name: "生成确认" });
    const activePrompt = composer.getByRole("textbox", { name: "生成提示词" });
    await activePrompt.fill("镜头");
    await videoNode.getByRole("article", { name: "视频", exact: true }).press("Enter");
    await expect(activePrompt).toBeFocused();
    await page.keyboard.insertText("推进");
    await expect(activePrompt).toHaveText("镜头推进");
    await activePrompt.press("Escape");
    await expect(videoNode).toHaveClass(/selected/);
    await videoNode.locator("header strong").click();
    await page.keyboard.press("Escape");
    await expect(videoNode).not.toHaveClass(/selected/);
    await videoNode.locator("header strong").click();
    await expect(composer.getByRole("button", { name: "选择模型" })).toHaveText("暂无可用模型");
    await expect(composer.getByRole("button", { name: "开始生成" })).toBeDisabled();
    await expect(composer.getByRole("button", { name: "生成参数" })).toHaveCount(0);
    await composer.getByRole("button", { name: "运镜", exact: true }).click();
    const motion = page.getByRole("region", { name: "运镜", exact: true });
    const fixed = motion.getByRole("button", { name: "固定镜头", exact: true });
    await expect
      .poll(() => fixed.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await fixed.click();
    await expect(motion).toBeHidden();
    await composer.getByRole("button", { name: "运镜", exact: true }).click();
    await motion.getByRole("button", { name: "镜头上摇", exact: true }).click();
    await expect(motion).toBeHidden();
    const chips = composer.locator('[data-preset^="motion/"]');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: "固定镜头" }).click();
    await motion.getByRole("button", { name: "镜头上摇", exact: true }).click();
    await expect(motion).toBeVisible();
    await expect(chips).toHaveCount(2);
    await fixed.click();
    await expect(chips).toHaveCount(1);
    await composer.getByRole("textbox", { name: "生成提示词" }).fill("镜头缓慢推进");
    await expect(activePrompt).toHaveText("镜头缓慢推进");
    await videoNode.getByRole("button", { name: "从资产库选取素材" }).click();
    const library = page.getByRole("dialog", { name: "资产库" });
    await expect(library.getByRole("button", { name: "e2e.png", exact: true })).toHaveCount(0);
    const videos = library.getByRole("button", { name: "e2e.mp4", exact: true });
    await videos.first().click();
    await videos.last().click();
    await expect(videos.first()).toHaveAttribute("aria-pressed", "false");
    await expect(videos.last()).toHaveAttribute("aria-pressed", "true");
    await library.getByRole("tab", { name: "生成历史" }).click();
    await expect(library.getByRole("group", { name: "内容类型" })).toHaveCount(0);
    await library.getByRole("button", { name: "放进节点" }).click();
    await expect(videoNode.locator(".local-video-poster")).toHaveJSProperty("naturalWidth", 64);
    await expect(videoNode.locator(".creative-card")).toHaveCSS("width", "432px");
    await expect(videoNode.locator(".creative-card")).toHaveCSS("height", "324px");
    await expect(videoNode.locator("video")).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(composer).toBeHidden();
    await expect(videoNode.locator(".react-flow__handle.target")).toBeHidden();
    await videoNode.getByRole("button", { name: "播放视频" }).click();
    const inline = videoNode.locator("video");
    await expect(inline).toHaveAttribute("src", /^link-media:/);
    await videoNode.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(inline).toHaveJSProperty("paused", true);
    await videoNode.getByRole("button", { name: "静音", exact: true }).click();
    await expect(inline).toHaveJSProperty("muted", true);
    await videoNode.getByRole("slider", { name: "播放进度" }).fill("0.25");
    await expect(inline).toHaveJSProperty("currentTime", 0.25);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await addCanvasNode(page, "音频");
    await expect(inline).toHaveCount(0);
    await expect(videoNode.getByRole("button", { name: "播放视频" })).toBeEnabled();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await projectAction(page, "项目文件");
    await page.getByRole("button", { name: "将e2e.png加入画布" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await page.getByRole("button", { name: "移除e2e.png" }).click();
    await expect(page.getByRole("alert")).toContainText("请先解除引用");
    await page.getByRole("button", { name: "关闭项目文件" }).click();
    await chooseCanvasZoom(page, "适应画布");
    await page
      .locator('.node-media[data-kind="image"]')
      .filter({ has: page.getByAltText("e2e.png", { exact: true }) })
      .dblclick();
    const gallery = page.getByRole("dialog", { name: "媒体预览" });
    await expect(gallery.getByText(`3×2 · ${png.length} B`)).toBeVisible();
    const tabs = gallery.getByRole("navigation", { name: "节点缩略图" });
    await expect(tabs.getByRole("button")).toHaveCount(2);
    await expect(tabs.locator(".local-video-poster")).toHaveJSProperty("naturalWidth", 64);
    await expect(gallery.locator("video")).toHaveCount(0);
    await tabs.getByRole("button", { name: "视频", exact: true }).click();
    await expect(gallery.getByText(/^64×48 · /)).toBeVisible();
    await expect(gallery.locator("video")).toHaveCount(1);
    const player = gallery.locator(".lightbox-frame video");
    await page.keyboard.press("m");
    await expect(player).toHaveJSProperty("muted", true);
    await gallery.getByRole("button", { name: "倍速" }).click();
    await gallery.getByRole("menuitemradio", { name: "1.5x" }).click();
    await expect(player).toHaveJSProperty("playbackRate", 1.5);
    await page.keyboard.press("Escape");
    await expect(gallery.getByRole("menu")).toHaveCount(0);
    await gallery.getByRole("button", { name: "循环播放" }).click();
    await expect(player).toHaveJSProperty("loop", true);
    const atStart = await gallery.getByRole("button", { name: "上一个" }).isDisabled();
    await gallery.getByRole("slider").focus();
    await page.keyboard.press(atStart ? "ArrowLeft" : "ArrowRight");
    await expect(player).toBeVisible();
    await page.keyboard.press(atStart ? "ArrowRight" : "ArrowLeft");
    await expect(gallery.getByText(`3×2 · ${png.length} B`)).toBeVisible();
    await gallery.getByRole("button", { name: "定位到节点" }).click();
    await expect(page.locator(".react-flow__node.selected header strong")).toHaveText("e2e");
    await page
      .getByRole("toolbar", { name: /的功能区$/ })
      .getByRole("button", { name: "放大预览" })
      .click();
    await expect(gallery).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0);
    await projectAction(page, "运行环境");
    await expect(page.getByText("桌面连接正常")).toBeVisible();
    const boundary = await page.evaluate(() => ({
      hasNode: "require" in window || "process" in window,
      domains: Object.keys(window.desktop).sort(),
      methods: Object.keys(window.desktop.app),
    }));
    expect(boundary).toEqual({
      hasNode: false,
      domains: [
        "app",
        "canvasWindow",
        "dialogs",
        "projectEvents",
        "projects",
        "settings",
        "skills",
      ],
      methods: ["openSource", "getInfo"],
    });
    await page.evaluate(() => window.open("https://example.com"));
    expect(await page.evaluate(() => window.desktop.app.openSource("file:///tmp/private"))).toBe(
      false,
    );
    const windowCount = await application.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });
    expect(windowCount).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: executablePath ? "test-results/m0-packaged.png" : "test-results/m0-workspace.png",
    });
    await unlink(mediaPath);
    await unlink(audioPath);
    await unlink(videoPath);
    await application.close();
    const reopenedApplication = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env: environment,
    });
    try {
      const reopenedPage = await reopenedApplication.firstWindow();
      await reopenedPage.getByRole("button", { name: "e2e", exact: false }).click();
      await expect(
        reopenedPage
          .locator('.node-media[data-kind="image"]')
          .getByAltText("e2e.png", { exact: true }),
      ).toHaveAttribute("src", /^link-media:/);
      await projectAction(reopenedPage, "项目文件");
      await expect(reopenedPage.getByTitle("e2e.png", { exact: true })).toBeVisible();
      await expect(reopenedPage.getByText("e2e.wav", { exact: true })).toBeVisible();
      await expect(reopenedPage.getByRole("region", { name: "文本内容", exact: true })).toHaveText(
        "一段等待被拍成电影的故事",
      );
      const imageNode = reopenedPage
        .locator(".react-flow__node")
        .filter({ has: reopenedPage.locator("header strong").filter({ hasText: /^e2e$/ }) });
      await expect(imageNode.getByRole("button", { name: "解除素材引用" })).toBeVisible();
      await reopenedPage.getByRole("button", { name: "预览e2e.png" }).click();
      await expect
        .poll(() =>
          reopenedPage
            .getByRole("dialog")
            .locator("img")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(3);
      await reopenedPage.getByRole("button", { name: "关闭预览" }).click();
      await reopenedPage.getByRole("button", { name: "预览e2e.wav" }).click();
      await expect
        .poll(() =>
          reopenedPage
            .getByRole("dialog")
            .locator("audio")
            .evaluate((audio: HTMLAudioElement) => audio.duration),
        )
        .toBe(1);
      await reopenedPage.getByRole("button", { name: "关闭预览" }).click();
      await expect(reopenedPage.locator(".local-video-poster")).toHaveJSProperty(
        "naturalWidth",
        64,
      );
      await reopenedPage.getByRole("button", { name: "预览e2e.mp4", exact: true }).first().click();
      const video = reopenedPage.getByRole("dialog").locator("video");
      await expect.poll(() => video.evaluate((item: HTMLVideoElement) => item.videoWidth)).toBe(64);
      await video.evaluate(async (item: HTMLVideoElement) => {
        item.muted = true;
        await item.play();
      });
      await expect
        .poll(() => video.evaluate((item: HTMLVideoElement) => item.currentTime))
        .toBeGreaterThan(0);
      await reopenedPage.getByRole("button", { name: "关闭预览" }).click();
      await reopenedPage.getByRole("button", { name: "关闭项目文件" }).click();
      await imageNode.getByRole("button", { name: "解除素材引用" }).click();
      await projectAction(reopenedPage, "项目文件");
      await reopenedPage.getByRole("button", { name: "移除e2e.png" }).click();
      await expect(reopenedPage.getByRole("button", { name: "预览e2e.png" })).toHaveCount(0);
    } finally {
      await reopenedApplication.close();
    }
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("视频运镜标签跨重启保留并可原位替换", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-studio-preset-reopen-"));
  const env = {
    ...process.env,
    LINK_STUDIO_TEST_USER_DATA: root,
    LINK_STUDIO_TEST_PROJECT_PARENT: root,
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const launch = () =>
    electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ["."] }), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await createCanvasProject(page, "运镜恢复");
    await page.getByRole("button", { name: /^视频生成 文生、参考/ }).click();
    await page.locator(".react-flow__node header strong").click();
    const editor = page.getByRole("textbox", { name: "生成提示词" });
    await editor.fill("傍晚的码头");
    await editor.press("End");
    await page.getByRole("button", { name: "运镜", exact: true }).click();
    await page.getByRole("button", { name: "镜头上摇", exact: true }).click();
    await expect(editor.locator('[data-preset="motion/tilt_up"]')).toHaveText("镜头上摇");
    await projectAction(page, "保存项目");
    await expect(page.getByRole("status", { name: "已保存", exact: true })).toBeVisible();
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: /^运镜恢复/ }).click();
    await reopened.locator(".react-flow__node header strong").click();
    const recovered = reopened.getByRole("textbox", { name: "生成提示词" });
    const chip = recovered.locator('[data-preset="motion/tilt_up"]');
    await expect(chip).toHaveText("镜头上摇");
    await chip.click();
    await reopened.getByRole("button", { name: "固定镜头", exact: true }).click();
    await expect(recovered.locator('[data-preset="motion/static_shot"]')).toHaveText("固定镜头");
    await expect(recovered).toHaveText("傍晚的码头固定镜头");
    await expect(chip).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("外部素材重开后显示缺失，只接受相同内容重定位", async () => {
  const userData = await mkdtemp(join(tmpdir(), "link-studio-reference-"));
  const original = join(userData, "external.png");
  const moved = join(userData, "moved.png");
  const wrong = join(userData, "wrong.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
    "base64",
  );
  const different = Buffer.from(png);
  different[40] = different.readUInt8(40) ^ 1;
  await writeFile(original, png);
  await writeFile(wrong, different);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LINK_STUDIO_TEST_USER_DATA: userData,
    LINK_STUDIO_TEST_PROJECT_PARENT: userData,
    LINK_STUDIO_TEST_MEDIA_FILES: original,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  const args = executablePath ? { executablePath, args: [] } : { args: ["."] };
  try {
    const application = await electron.launch({ ...args, env });
    try {
      const page = await application.firstWindow();
      await createCanvasProject(page, "外部引用验收");
      await projectAction(page, "项目文件");
      await page.getByRole("combobox", { name: "导入方式" }).selectOption("reference");
      await page.getByRole("button", { name: "导入素材" }).click();
      await expect(page.getByText("外部引用 · 0.0 MB")).toBeVisible();
      await page.getByRole("button", { name: "预览external.png" }).click();
      await expect
        .poll(() =>
          page
            .getByRole("dialog")
            .locator("img")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(3);
    } finally {
      await application.close();
    }
    const project = (await readdir(userData)).find((entry) => entry.endsWith(".linkstudio"));
    if (!project) throw new Error("Project directory missing");
    expect(await readdir(join(userData, project, "assets"))).toEqual([]);
    const state = join(userData, project, "state");
    for (const snapshot of await readdir(state)) {
      const text = await readFile(join(state, snapshot), "utf8");
      expect(text).not.toContain(original);
    }
    await rename(original, moved);
    const reopened = await electron.launch({
      ...args,
      env: { ...env, LINK_STUDIO_TEST_MEDIA_FILES: wrong },
    });
    try {
      const page = await reopened.firstWindow();
      await page.getByRole("button", { name: /^外部引用验收/ }).click();
      await projectAction(page, "项目文件");
      await expect(page.getByText(/文件不可用/)).toBeVisible();
      await page.getByRole("button", { name: "重新定位external.png" }).click();
      await expect(page.getByRole("alert")).toContainText("文件内容与原素材不一致");
      await expect(page.getByText(/文件不可用/)).toBeVisible();
      await reopened.evaluate((_electron, selected) => {
        process.env.LINK_STUDIO_TEST_MEDIA_FILES = selected;
      }, moved);
      await page.getByRole("button", { name: "重新定位external.png" }).click();
      await page.getByRole("button", { name: "预览external.png" }).click();
      await expect
        .poll(() =>
          page
            .getByRole("dialog")
            .locator("img")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(3);
      await page.getByRole("button", { name: "关闭预览" }).click();
      await writeFile(moved, different);
      await page.getByRole("button", { name: "预览external.png" }).click();
      await expect(page.getByRole("alert")).toContainText("文件内容与原素材不一致");
      await expect(page.getByText(/文件不可用/)).toBeVisible();
      await page.getByRole("button", { name: "移除external.png" }).click();
      await expect(page.getByTitle("external.png")).toHaveCount(0);
      expect(await readFile(moved)).toEqual(different);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("导入会话报告复制字节并支持中途取消", async () => {
  const userData = await mkdtemp(join(tmpdir(), "link-studio-cancel-"));
  const mediaPath = join(userData, "large.png");
  const source = await open(mediaPath, "wx");
  const totalBytes = 256 * 1024 * 1024;
  try {
    await source.truncate(totalBytes);
  } finally {
    await source.close();
  }
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LINK_STUDIO_TEST_USER_DATA: userData,
    LINK_STUDIO_TEST_PROJECT_PARENT: userData,
    LINK_STUDIO_TEST_MEDIA_FILES: mediaPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
  try {
    const application = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env,
    });
    try {
      const page = await application.firstWindow();
      const result = await page.evaluate(async () => {
        const { dialogs, projects } = window.desktop;
        const selected = await dialogs.selectProjectParent();
        if (!selected.ok || selected.value.cancelled) throw new Error("No project directory");
        const created = await projects.create({
          directoryToken: selected.value.directoryToken,
          operationId: crypto.randomUUID(),
          name: "取消导入验收",
        });
        if (!created.ok) throw new Error("No project");
        const { projectHandle, revision } = created.value;
        const files = await dialogs.selectMedia({ projectHandle, multiSelect: false });
        const file = files.ok && !files.value.cancelled && files.value.files[0];
        if (!file) throw new Error("No file token");
        const started = await projects.startImport({
          projectHandle,
          operationId: crypto.randomUUID(),
          expectedRevision: revision,
          fileToken: file.fileToken,
        });
        if (!started.ok) throw new Error("Import did not start");
        const query = { projectHandle, importSessionId: started.value.importSessionId };
        let status = await projects.getImport(query);
        while (status.ok && status.value.phase === "copying" && status.value.copiedBytes === 0)
          status = await projects.getImport(query);
        const cancelled = await projects.cancelImport(query);
        const after = await projects.getState({ projectHandle });
        const assets = await projects.listAssets({ projectHandle });
        return { status, cancelled, after, assets };
      });
      expect(result.status).toMatchObject({ ok: true, value: { phase: "copying", totalBytes } });
      expect(result.status.ok && result.status.value.copiedBytes).toBeGreaterThan(0);
      expect(result.status.ok && result.status.value.copiedBytes).toBeLessThan(totalBytes);
      expect(result.cancelled).toMatchObject({ ok: true, value: { phase: "cancelled" } });
      expect(result.after).toMatchObject({ ok: true, value: { session: { revision: 1 } } });
      expect(result.assets).toMatchObject({ ok: true, value: { assets: [] } });
      expect((await stat(mediaPath)).size).toBe(totalBytes);
      const project = (await readdir(userData)).find((entry) => entry.endsWith(".linkstudio"));
      if (!project) throw new Error("Project directory missing");
      expect(await readdir(join(userData, project, "tmp"))).toEqual([]);
    } finally {
      await application.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("素材回执校验原始请求，文件授权仅提交一次", async () => {
  const userData = await mkdtemp(join(tmpdir(), "link-studio-asset-ipc-"));
  const mediaPath = join(userData, "receipt.png");
  await writeFile(
    mediaPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  try {
    const executablePath = process.env.LINK_STUDIO_E2E_EXECUTABLE;
    const application = await electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: ["."] }),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
          ),
        ),
        LINK_STUDIO_TEST_USER_DATA: userData,
        LINK_STUDIO_TEST_PROJECT_PARENT: userData,
        LINK_STUDIO_TEST_MEDIA_FILES: mediaPath,
      },
    });
    try {
      const page = await application.firstWindow();
      const result = await page.evaluate(async () => {
        const { dialogs, projects } = window.desktop;
        const parent = await dialogs.selectProjectParent();
        if (!parent.ok || parent.value.cancelled) throw new Error("选择项目目录失败");
        const created = await projects.create({
          directoryToken: parent.value.directoryToken,
          name: "回执项目",
          operationId: crypto.randomUUID(),
        });
        if (!created.ok) throw new Error("创建项目失败");
        const { projectHandle, revision } = created.value;
        const selected = await dialogs.selectMedia({ projectHandle, multiSelect: false });
        if (!selected.ok || selected.value.cancelled || !selected.value.files[0])
          throw new Error("选择素材失败");
        const input = {
          projectHandle,
          expectedRevision: revision,
          operationId: crypto.randomUUID(),
          fileToken: selected.value.files[0].fileToken,
        };
        const [first, replay] = await Promise.all([
          projects.importAsset(input),
          projects.importAsset(input),
        ]);
        const different = await projects.importAsset({ ...input, fileToken: crypto.randomUUID() });
        const changedRevision = await projects.importAsset({
          ...input,
          expectedRevision: revision + 1,
        });
        const changedChoice = await projects.importAsset({ ...input, choice: "independent" });
        const consumed = await projects.importAsset({
          ...input,
          expectedRevision: revision + 1,
          operationId: crypto.randomUUID(),
        });
        const assets = await projects.listAssets({ projectHandle });
        const selectedAgain = await dialogs.selectMedia({ projectHandle, multiSelect: false });
        const file =
          selectedAgain.ok && !selectedAgain.value.cancelled && selectedAgain.value.files[0];
        if (!file) throw new Error("无法重新选择素材");
        const started = await projects.startImport({
          ...input,
          fileToken: file.fileToken,
          operationId: crypto.randomUUID(),
        });
        if (!started.ok) throw new Error("无法启动导入会话");
        const query = { projectHandle, importSessionId: started.value.importSessionId };
        let conflict = await projects.getImport(query);
        while (conflict.ok && ["copying", "committing"].includes(conflict.value.phase)) {
          conflict = await projects.getImport(query);
        }
        const duplicate = await projects.commitImport({
          ...query,
          operationId: crypto.randomUUID(),
          expectedRevision: revision + 1,
        });
        const request = {
          ...query,
          operationId: crypto.randomUUID(),
          expectedRevision: revision + 1,
          choice: "reuse" as const,
        };
        const [committed, repeated] = await Promise.all([
          projects.commitImport(request),
          projects.commitImport(request),
        ]);
        const cancelledLate = await projects.cancelImport(query);
        return {
          first,
          replay,
          different,
          changedRevision,
          changedChoice,
          consumed,
          assets,
          conflict,
          duplicate,
          committed,
          repeated,
          cancelledLate,
        };
      });
      expect(result.first).toMatchObject({ ok: true, value: { revision: 2 } });
      expect(result.replay).toMatchObject({
        ok: true,
        value: result.first.ok ? result.first.value : {},
      });
      for (const mismatch of [result.different, result.changedRevision, result.changedChoice]) {
        expect(mismatch).toMatchObject({ ok: false, error: { code: "OPERATION_ID_REUSED" } });
      }
      expect(result.consumed).toMatchObject({
        ok: false,
        error: { code: "TOKEN_INVALID_OR_EXPIRED" },
      });
      expect(result.assets.ok && result.assets.value.assets).toHaveLength(1);
      expect(result.conflict).toMatchObject({ ok: true, value: { phase: "conflict" } });
      expect(result.duplicate).toMatchObject({ ok: true, value: { phase: "duplicate" } });
      for (const status of [result.committed, result.repeated, result.cancelledLate]) {
        expect(status).toMatchObject({ ok: true, value: { phase: "imported", revision: 3 } });
      }
    } finally {
      await application.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
